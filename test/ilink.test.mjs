import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_LONGPOLL_MS, ILinkError, ILinkClient, isSessionExpired } from '../lib/ilink/api.js'
import { decryptAesEcb, decodeAesKey, encodeAesKey, encryptedSize, encryptAesEcb, md5Hex, randomWechatUin } from '../lib/ilink/crypto.js'
import { downloadInboundItem, uploadLocalFile } from '../lib/ilink/media.js'
import { qrLogin } from '../lib/login.js'
import { createLogger } from '../lib/log.js'
import { createTempStore } from './helpers.mjs'

const logger = createLogger('silent')

/**
 * A fake iLink gateway: the real endpoints, the real envelopes, in-memory state.
 * Nothing here is mocked below HTTP, so the client's headers, cursor handling,
 * error mapping and AES media path are all exercised for real.
 */
async function startFakeIlink(options = {}) {
  const state = {
    qrPolls: 0,
    updates: options.updates ?? [
      {
        seq: 11,
        message_id: 5001,
        from_user_id: 'user@im.wechat',
        to_user_id: 'bot@im.bot',
        message_type: 1,
        message_state: 2,
        context_token: 'token-abc',
        item_list: [{ type: 1, text_item: { text: '你好，机器人' } }],
      },
    ],
    getUpdatesBody: [],
    sent: [],
    typing: [],
    uploaded: null,
    requests: [],
    media: options.media ?? Buffer.from('CDN 上的原始字节', 'utf8'),
    expiresAt: options.expiresAt ?? null,
  }

  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      const url = new URL(request.url, 'http://localhost')
      const isJson = String(request.headers['content-type'] ?? '').includes('json')
      state.requests.push({
        method: request.method,
        path: url.pathname,
        headers: request.headers,
        body: isJson && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null,
        raw,
      })
      const json = (payload, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(payload))
      }

      if (url.pathname === '/ilink/bot/get_bot_qrcode') {
        json({ qrcode: 'qrc_123', qrcode_img_content: 'https://weixin.qq.com/x/scan-me' })
        return
      }
      if (url.pathname === '/ilink/bot/get_qrcode_status') {
        state.qrPolls += 1
        if (state.qrPolls === 1) {
          json({ status: 'scaned' })
          return
        }
        json({
          status: 'confirmed',
          bot_token: 'ilinkbot_token_1',
          ilink_bot_id: 'bot-1@im.bot',
          ilink_user_id: 'owner@im.wechat',
          baseurl: `http://127.0.0.1:${port}`,
        })
        return
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        state.getUpdatesBody.push(JSON.parse(raw.toString('utf8')))
        if (state.expiresAt !== null && state.getUpdatesBody.length >= state.expiresAt) {
          // The gateway may report expiry through either field.
          json(
            options.expiryShape === 'errcode'
              ? { errcode: -14, errmsg: 'session timeout' }
              : { ret: -14, errcode: -14, errmsg: 'session timeout' },
          )
          return
        }
        const batch = state.updates
        state.updates = []
        json({ ret: 0, msgs: batch, get_updates_buf: `cursor-${state.getUpdatesBody.length}`, longpolling_timeout_ms: 30_000 })
        return
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        state.sent.push(JSON.parse(raw.toString('utf8')))
        json({})
        return
      }
      if (url.pathname === '/ilink/bot/getconfig') {
        json({ ret: 0, typing_ticket: 'ticket-xyz' })
        return
      }
      if (url.pathname === '/ilink/bot/sendtyping') {
        state.typing.push(JSON.parse(raw.toString('utf8')))
        json({ ret: 0 })
        return
      }
      if (url.pathname === '/ilink/bot/getuploadurl') {
        const body = JSON.parse(raw.toString('utf8'))
        state.uploaded = body
        json({ upload_param: 'upload-param-1', thumb_upload_param: '' })
        return
      }
      if (url.pathname === '/c2c/upload') {
        state.uploadedCiphertext = raw
        response.writeHead(200, { 'x-encrypted-param': 'encrypted-param-1' })
        response.end('')
        return
      }
      if (url.pathname === '/c2c/download') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        response.end(state.media)
        return
      }
      if (url.pathname === '/ilink/bot/msg/notifystart' || url.pathname === '/ilink/bot/msg/notifystop') {
        response.writeHead(404)
        response.end('nope')
        return
      }
      json({ ret: -1, errmsg: `unknown endpoint ${url.pathname}` }, 404)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`
  return {
    state,
    baseUrl,
    // The real media base is `<host>/c2c`, so the fake mirrors that shape.
    cdnBaseUrl: `${baseUrl}/c2c`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('qr login stores the credential and switches the client to the returned base url', async () => {
  const gateway = await startFakeIlink()
  const temp = await createTempStore()
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, cdnBaseUrl: gateway.cdnBaseUrl, logger })
    const credentials = await qrLogin({
      client,
      store: temp.store,
      logger,
      paths: temp.store.paths,
      maxQrCodes: 2,
    })
    assert.equal(credentials.botToken, 'ilinkbot_token_1')
    assert.equal(credentials.botId, 'bot-1@im.bot')
    assert.equal(client.baseUrl, gateway.baseUrl)
    assert.equal(temp.store.loggedIn, true)

    const onDisk = JSON.parse(await readFile(temp.store.paths.credentials, 'utf8'))
    assert.equal(onDisk.botToken, 'ilinkbot_token_1')

    // The QR artifact is written for the operator to scan.
    const artifact = await readFile(temp.store.paths.qrText, 'utf8')
    assert.match(artifact, /scan-me/)

    const { stat } = await import('node:fs/promises')
    const mode = (await stat(temp.store.paths.credentials)).mode & 0o777
    assert.equal(mode, 0o600, 'credential file must not be world readable')
  } finally {
    await temp.cleanup()
    await gateway.close()
  }
})

test('long polling sends the cursor, the auth envelope and receives messages', async () => {
  const gateway = await startFakeIlink()
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, token: 'tok-1', logger })
    const first = await client.getUpdates({ cursor: '' })
    assert.equal(first.msgs.length, 1)
    assert.equal(first.msgs[0].item_list[0].text_item.text, '你好，机器人')
    assert.equal(first.cursor, 'cursor-1')
    assert.equal(first.longpollingTimeoutMs, 30_000)

    const second = await client.getUpdates({ cursor: first.cursor })
    assert.equal(second.msgs.length, 0)
    assert.equal(gateway.state.getUpdatesBody[1].get_updates_buf, 'cursor-1')

    const headers = gateway.state.requests[0].headers
    assert.equal(headers.authorization, 'Bearer tok-1')
    assert.equal(headers.authorizationtype, 'ilink_bot_token')
    assert.equal(headers['ilink-app-id'], 'bot')
    assert.equal(headers['content-type'], 'application/json')
    // X-WECHAT-UIN is base64 over the decimal spelling of a uint32.
    const decoded = Buffer.from(headers['x-wechat-uin'], 'base64').toString('utf8')
    assert.match(decoded, /^\d+$/)
    assert.equal(gateway.state.getUpdatesBody[0].base_info.channel_version, '1.0.0')
  } finally {
    await gateway.close()
  }
})

test('a client-side long-poll timeout is an empty batch, not an error', async () => {
  const sockets = new Set()
  const server = createServer((_request, _response) => {
    // Never answer: the client must time out on its own.
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${port}`, token: 't', logger })
    // `graceMs: 0` keeps the assertion honest without waiting the 5s grace.
    const batch = await client.getUpdates({ cursor: 'keep-me', timeoutMs: 120, graceMs: 0 })
    assert.equal(batch.timedOut, true)
    assert.equal(batch.msgs.length, 0)
    assert.equal(batch.cursor, 'keep-me')
    assert.ok(DEFAULT_LONGPOLL_MS >= 30_000)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('sendmessage carries the WeChat reply envelope', async () => {
  const gateway = await startFakeIlink()
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, token: 'tok-1', logger })
    await client.sendText({ toUserId: 'user@im.wechat', text: '收到', contextToken: 'token-abc' })
    const sent = gateway.state.sent[0].msg
    assert.equal(sent.to_user_id, 'user@im.wechat')
    assert.equal(sent.from_user_id, '')
    assert.equal(sent.message_type, 2)
    assert.equal(sent.message_state, 2)
    assert.equal(sent.context_token, 'token-abc')
    assert.deepEqual(sent.item_list, [{ type: 1, text_item: { text: '收到' } }])
    assert.match(sent.client_id, /^dsh-wechat:/)
  } finally {
    await gateway.close()
  }
})

test('typing state uses the ticket from getconfig', async () => {
  const gateway = await startFakeIlink()
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, token: 'tok-1', logger })
    const ticket = await client.getConfig({ ilinkUserId: 'user@im.wechat', contextToken: 'token-abc' })
    assert.equal(ticket, 'ticket-xyz')
    await client.sendTyping({ ilinkUserId: 'user@im.wechat', typingTicket: ticket, status: 1 })
    assert.equal(gateway.state.typing[0].status, 1)
    assert.equal(gateway.state.typing[0].typing_ticket, 'ticket-xyz')
    const configRequest = gateway.state.requests.find((entry) => entry.path === '/ilink/bot/getconfig')
    assert.equal(configRequest.body.context_token, 'token-abc')
  } finally {
    await gateway.close()
  }
})

test('outbound media is AES encrypted, uploaded, and referenced by the message item', async () => {
  const gateway = await startFakeIlink()
  const temp = await createTempStore()
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, cdnBaseUrl: gateway.cdnBaseUrl, token: 'tok-1', logger })
    const filePath = join(temp.dir, 'photo.png')
    const bytes = Buffer.from('PNG-ish payload for the media test', 'utf8')
    await writeFile(filePath, bytes)

    const result = await uploadLocalFile({ client, filePath, toUserId: 'user@im.wechat' })
    assert.equal(result.mediaType, 1)
    assert.equal(result.item.type, 2)

    const upload = gateway.state.uploaded
    assert.equal(upload.rawsize, bytes.length)
    assert.equal(upload.rawfilemd5, md5Hex(bytes))
    assert.equal(upload.filesize, encryptedSize(bytes.length))
    assert.equal(upload.media_type, 1)
    assert.equal(upload.no_need_thumb, true)
    assert.match(upload.aeskey, /^[0-9a-f]{32}$/)

    // The CDN received ciphertext that decrypts back to the original bytes.
    const decrypted = decryptAesEcb(gateway.state.uploadedCiphertext, Buffer.from(upload.aeskey, 'hex'))
    assert.deepEqual(decrypted, bytes)

    // And the item references the CDN slot with the documented key encoding.
    const media = result.item.image_item.media
    assert.equal(media.encrypt_query_param, 'encrypted-param-1')
    assert.equal(media.aes_key, encodeAesKey(upload.aeskey))
    assert.equal(result.item.image_item.mid_size, encryptedSize(bytes.length))
  } finally {
    await temp.cleanup()
    await gateway.close()
  }
})

test('inbound media is downloaded and decrypted, tolerating both key encodings', async () => {
  const keyHex = '00112233445566778899aabbccddeeff'
  const key = Buffer.from(keyHex, 'hex')
  const plaintext = Buffer.from('inbound file bytes', 'utf8')
  const gateway = await startFakeIlink({ media: encryptAesEcb(plaintext, key) })
  const temp = await createTempStore()
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, cdnBaseUrl: gateway.cdnBaseUrl, token: 'tok-1', logger })
    for (const aesKey of [encodeAesKey(keyHex), key.toString('base64')]) {
      const file = await downloadInboundItem({
        client,
        item: {
          type: 4,
          file_item: {
            media: { encrypt_query_param: 'param', aes_key: aesKey, encrypt_type: 1 },
            file_name: '报价单.pdf',
            len: String(plaintext.length),
          },
        },
        dir: join(temp.dir, 'media'),
        logger,
      })
      assert.equal(file.name, '报价单.pdf')
      assert.equal(file.size, plaintext.length)
      assert.deepEqual(await readFile(file.path), plaintext)
    }

    // `image_item.aeskey` (hex) wins over `media.aes_key` when both exist.
    const image = await downloadInboundItem({
      client,
      item: { type: 2, image_item: { media: { encrypt_query_param: 'p', aes_key: encodeAesKey('ff'.repeat(16)) }, aeskey: keyHex } },
      dir: join(temp.dir, 'media'),
      logger,
    })
    assert.deepEqual(await readFile(image.path), plaintext)
  } finally {
    await temp.cleanup()
    await gateway.close()
  }
})

test('oversized inbound media is refused before it is written', async () => {
  const gateway = await startFakeIlink({ media: Buffer.alloc(2_048) })
  const temp = await createTempStore()
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, cdnBaseUrl: gateway.cdnBaseUrl, token: 'tok-1', logger })
    await assert.rejects(
      () =>
        downloadInboundItem({
          client,
          item: { type: 4, file_item: { media: { encrypt_query_param: 'p', aes_key: encodeAesKey('00'.repeat(16)) }, len: '999999' } },
          dir: join(temp.dir, 'media'),
          maxBytes: 1_024,
          logger,
        }),
      /exceeds the 1024-byte limit/,
    )
  } finally {
    await temp.cleanup()
    await gateway.close()
  }
})

test('ret -14 is recognized as an expired session', async () => {
  const gateway = await startFakeIlink({ updates: [], expiresAt: 1 })
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, token: 'tok-1', logger })
    const error = await client.getUpdates({ cursor: '' }).then(
      () => null,
      (thrown) => thrown,
    )
    assert.ok(error instanceof ILinkError)
    assert.equal(isSessionExpired(error), true)
    assert.match(error.message, /ret=-14/)
  } finally {
    await gateway.close()
  }
})

test('HTTP failures and business failures both surface as ILinkError', async () => {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/ilink/bot/sendmessage')) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ret: -2, errmsg: 'bad param' }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<html>not json</html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok', logger })
    const httpError = await client.sendText({ toUserId: 'u', text: 'x', clientId: 'c' }).catch((error) => error)
    assert.ok(httpError instanceof ILinkError)
    assert.equal(httpError.status, 500)
    assert.equal(httpError.ret, -2)
    assert.equal(isSessionExpired(httpError), false)

    const parseError = await client.getUpdates({ cursor: '' }).catch((error) => error)
    assert.ok(parseError instanceof ILinkError)
    assert.match(parseError.message, /non-JSON/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the UIN header helper matches the documented encoding', () => {
  const uin = randomWechatUin()
  const decoded = Buffer.from(uin, 'base64').toString('utf8')
  assert.match(decoded, /^\d+$/)
  const value = Number(decoded)
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
})

test('aes key decoding rejects nonsense instead of guessing', () => {
  assert.throws(() => decodeAesKey(''), /missing/)
  assert.throws(() => decodeAesKey(Buffer.alloc(8).toString('base64')), /unsupported aes_key encoding/)
  assert.equal(decodeAesKey(Buffer.from('00112233445566778899aabbccddeeff', 'utf8').toString('base64')).length, 16)
})

test('an errcode-only expiry is treated as an expired session, not an empty poll', async () => {
  const gateway = await startFakeIlink({ updates: [], expiresAt: 1, expiryShape: 'errcode' })
  try {
    const client = new ILinkClient({ baseUrl: gateway.baseUrl, token: 'tok-1', logger })
    const error = await client.getUpdates({ cursor: '' }).then(
      () => null,
      (thrown) => thrown,
    )
    assert.ok(error instanceof ILinkError, 'a shape without `ret` must still fail')
    assert.equal(isSessionExpired(error), true)
    assert.match(error.message, /errcode=-14/)
  } finally {
    await gateway.close()
  }
})

test('an unusable base url is refused', () => {
  assert.throws(() => new ILinkClient({ baseUrl: 'http://evil.example.com', logger }), /refusing plain http/)
  assert.throws(() => new ILinkClient({ baseUrl: 'file:///etc/passwd', logger }), /must be http\(s\)/)
  assert.throws(() => new ILinkClient({ baseUrl: 'nonsense', logger }), /not a URL/)
  assert.equal(new ILinkClient({ baseUrl: 'http://127.0.0.1:9/', logger }).baseUrl, 'http://127.0.0.1:9')
})

test('requests refuse redirects instead of re-posting the body elsewhere', async () => {
  const seen = []
  const server = createServer((request, response) => {
    seen.push(request.url)
    response.writeHead(307, { Location: 'https://elsewhere.example/collect' })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'tok', logger })
    await assert.rejects(() => client.sendText({ toUserId: 'u', text: 'secret', clientId: 'c1' }), /CDN|POST|failed/)
    // The body went to exactly one destination: the configured base.
    assert.equal(seen.length, 1)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a response body that stalls after the headers is still bounded by the timeout', async () => {
  // The guard used to be cleared as soon as fetch() resolved, i.e. when the *headers*
  // arrived: a peer that then went quiet hung the long poll, a send retry and
  // channel.stop() forever (undici's 300s body timeout was the only backstop).
  const { createServer } = await import('node:http')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.flushHeaders()
    // Deliberately never end the response.
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const client = new ILinkClient({ token: 'test-token', baseUrl, cdnBaseUrl: baseUrl, requestTimeoutMs: 300 })
    const started = Date.now()
    await assert.rejects(
      () => client.sendText({ toUserId: 'u', text: 'hi', contextToken: 'c', clientId: 'id-1' }),
      (error) => /timed out|stalled/i.test(String(error?.message)),
      'a stalled body must surface as a timeout, not a hang',
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `the timeout fired promptly (${elapsed}ms)`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('an already-aborted signal never sends the request', async () => {
  let hits = 0
  const { createServer } = await import('node:http')
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ret":0}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const client = new ILinkClient({ token: 't', baseUrl, cdnBaseUrl: baseUrl })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => client.sendText({ toUserId: 'u', text: 'hi', contextToken: 'c', clientId: 'id-2', signal: controller.signal }))
    assert.equal(hits, 0, 'the request must not reach the network once cancelled')
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('an undecryptable payload is stored with a marker instead of posing as the original', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { downloadInboundItem, describeFilesForPrompt } = await import('../lib/ilink/media.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-media-'))
  try {
    const ciphertext = Buffer.from('not-really-encrypted')
    const client = {
      downloadCdn: async () => ciphertext,
    }
    const file = await downloadInboundItem({
      client,
      item: {
        type: 4,
        file_item: {
          file_name: '报表.pdf',
          len: String(ciphertext.length),
          media: {
            encrypt_query_param: 'q',
            // Not a valid AES key: decryption must fail and be reported as such.
            aes_key: Buffer.from('short-key').toString('base64'),
          },
        },
      },
      dir,
      logger: { warn() {}, info() {}, debug() {} },
    })
    assert.match(file.name, /\.pdf\.enc$/, `the name must say the bytes are ciphertext: ${file.name}`)
    assert.equal((await readFile(file.path)).equals(ciphertext), true, 'the raw bytes are kept for recovery')
    const described = describeFilesForPrompt([file])
    assert.match(described, /解密失败/, 'the model is told the file is not readable content')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dead status endpoint makes the login fetch a fresh QR instead of polling forever', async () => {
  const { qrLogin } = await import('../lib/login.js')
  let statusCalls = 0
  const client = {
    getBotQrCode: async () => ({ qrcode: 'qr-1', qrcodeImgContent: '' }),
    getQrCodeStatus: async () => {
      statusCalls += 1
      throw new Error('gateway is down')
    },
  }
  const started = Date.now()
  const result = await qrLogin({
    client,
    paths: {},
    logger: { warn() {}, info() {}, debug() {} },
    maxQrCodes: 2,
    presentQrCode: async () => {},
    onStatus: () => {},
  })
  assert.equal(result, null, 'the login gives up instead of hanging')
  assert.ok(statusCalls <= 10, `it stopped after a bounded number of attempts (${statusCalls})`)
  assert.ok(Date.now() - started < 30_000, 'and it did not wait out a long retry loop')
})
