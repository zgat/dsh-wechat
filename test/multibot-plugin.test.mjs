/**
 * Two bots, one plugin instance, two real HTTP gateways.
 *
 * The unit tests prove the store keeps per-bot buckets; this one proves the wiring: both
 * receive loops run, the same person can talk to both, and each answer leaves through the
 * gateway — and with the reply token — of the bot that received it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import plugin from '../lib/index.js'
import { createFakeHarness, startGateway, waitFor } from './helpers.mjs'

/** One inbound text message, addressed to a specific bot. */
function inbound(id, text, botId) {
  return {
    message_id: id,
    from_user_id: 'user@im.wechat',
    to_user_id: botId,
    message_type: 1,
    message_state: 2,
    context_token: `token-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

test('two bots in one instance answer through their own gateway', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-multibot-'))
  const g1 = await startGateway()
  const g2 = await startGateway()
  await writeFile(
    path.join(stateDir, 'credentials.json'),
    JSON.stringify({
      version: 2,
      bots: {
        'bot-a@im.bot': { version: 1, botToken: 'token-a', botId: 'bot-a@im.bot', baseUrl: g1.baseUrl, source: 'file' },
        'bot-b@im.bot': { version: 1, botToken: 'token-b', botId: 'bot-b@im.bot', baseUrl: g2.baseUrl, source: 'file' },
      },
    }),
  )

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness({ reply: '多 bot 回复', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('tools', { register: () => () => {} })

  const fiber = ctx.plugin(plugin, {
    stateDir,
    accessPolicy: 'open',
    typing: false,
    progress: 'off',
    logLevel: 'silent',
    loginPage: false,
    autoLogin: false,
  })

  try {
    // Both bots poll their own gateway.
    await waitFor(() => g1.state.polls > 0 && g2.state.polls > 0, { timeoutMs: 8_000, label: 'both bots poll' })

    // The same person talks to both bots.
    g1.push(inbound('m-a-1', '你好 A', 'bot-a@im.bot'))
    g2.push(inbound('m-b-1', '你好 B', 'bot-b@im.bot'))
    await waitFor(() => g1.state.sent.length > 0 && g2.state.sent.length > 0, {
      timeoutMs: 8_000,
      label: 'both bots reply',
    })

    // Each reply left through the bot that received the message, echoing its own token.
    for (const reply of g1.state.sent) {
      assert.equal(reply.to_user_id, 'user@im.wechat')
      assert.match(reply.context_token, /^token-m-a-/, 'bot A answers with bot A\'s token')
    }
    for (const reply of g2.state.sent) {
      assert.equal(reply.to_user_id, 'user@im.wechat')
      assert.match(reply.context_token, /^token-m-b-/, 'bot B answers with bot B\'s token')
    }

    // One session per bot, even though the person is the same.
    const readState = async () => JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8'))
    const state = await waitFor(
      async () => {
        const next = await readState().catch(() => null)
        const keys = Object.keys(next?.sessions ?? {})
        return keys.length >= 2 ? next : null
      },
      { timeoutMs: 8_000, label: 'two sessions' },
    )
    const sessionA = state.sessions['p2p:bot-a@im.bot:user@im.wechat']
    const sessionB = state.sessions['p2p:bot-b@im.bot:user@im.wechat']
    assert.ok(sessionA, 'bot A bound a session under its own namespace')
    assert.ok(sessionB, 'bot B bound a session under its own namespace')
    assert.notEqual(sessionA, sessionB, 'the two bots never share a DSH session')

    // Let the first contact settle (the onboarding guide and the answer are two messages),
    // otherwise a straggler looks like cross-bot traffic below.
    await new Promise((resolve) => setTimeout(resolve, 400))

    // Dedupe is per bot: the *same* message id arriving at the other bot is still handled.
    const sentBefore = { a: g1.state.sent.length, b: g2.state.sent.length }
    g2.push(inbound('m-a-1', '同一条消息 ID', 'bot-b@im.bot'))
    await waitFor(() => g2.state.sent.length > sentBefore.b, { timeoutMs: 8_000, label: 'bot B handles a shared id' })
    assert.equal(g1.state.sent.length, sentBefore.a, 'bot A received nothing new')
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await g1.close()
    await g2.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('adding a bot at runtime leaves the running bot polling', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-addbot-'))
  const gA = await startGateway()
  // The login client talks to this gateway, and it becomes the new bot's base URL.
  const gLogin = await startGateway()
  await writeFile(
    path.join(stateDir, 'credentials.json'),
    JSON.stringify({
      version: 2,
      bots: { 'bot-a@im.bot': { version: 1, botToken: 'token-a', botId: 'bot-a@im.bot', baseUrl: gA.baseUrl, source: 'file' } },
    }),
  )

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness({ reply: 'ok', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('tools', { register: () => () => {} })
  const routes = []
  ctx.provide('webServer', {
    port: 0,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  })

  const fiber = ctx.plugin(plugin, {
    stateDir,
    accessPolicy: 'open',
    typing: false,
    progress: 'off',
    logLevel: 'silent',
    // `loginPage: true` is what registers the settings API; port 0 keeps tests isolated.
    loginPage: true,
    loginPagePort: 0,
    autoLogin: false,
    baseUrl: gLogin.baseUrl,
  })

  /** Drive the plugin's own HTTP route the way the settings card does. */
  const call = async (target, options = {}) =>
    new Promise((resolve) => {
      const response = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
          this.statusCode = status
          this.headers = headers
        },
        end(body) {
          this.body = body ?? ''
          resolve(this)
        },
      }
      routes[0].handler({ url: target, method: options.method ?? 'GET' }, response)
    })

  try {
    await waitFor(() => gA.state.polls > 0 && routes.length === 1, { timeoutMs: 8_000, label: 'bot A polling + route' })
    const pollsBefore = gA.state.polls

    const add = await call('/dsh-wechat/api/add', { method: 'POST' })
    assert.equal(add.statusCode, 200)
    assert.equal(JSON.parse(add.body).ok, true)

    // The scan flow starts: a code is issued, then the operator confirms it.
    await waitFor(() => gLogin.state.qrIssued > 0, { timeoutMs: 8_000, label: 'qr issued' })
    gLogin.state.qrPhase = 'confirmed'

    // The new bot starts polling its own gateway…
    await waitFor(() => gLogin.state.polls > 0, { timeoutMs: 8_000, label: 'new bot polls' })
    // …while the first bot never stopped (empty batches are paced, so this waits a beat).
    await waitFor(() => gA.state.polls > pollsBefore, { timeoutMs: 5_000, label: 'bot A kept polling' })

    const onDisk = JSON.parse(await readFile(path.join(stateDir, 'credentials.json'), 'utf8'))
    assert.ok(onDisk.bots['bot-a@im.bot'], 'the existing bot stayed bound')
    assert.ok(onDisk.bots['bot-qr@im.bot'], 'the scanned bot was added next to it')
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await gA.close()
    await gLogin.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('re-scanning an already running bot replaces its channel and token', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-rebind-'))
  const gA = await startGateway()
  // This gateway hands back the *same* bot id with a fresh token.
  const gLogin = await startGateway({ qrBotId: 'bot-a@im.bot', qrToken: 'token-rebound' })
  await writeFile(
    path.join(stateDir, 'credentials.json'),
    JSON.stringify({
      version: 2,
      bots: { 'bot-a@im.bot': { version: 1, botToken: 'token-old', botId: 'bot-a@im.bot', baseUrl: gA.baseUrl, source: 'file' } },
    }),
  )

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness({ reply: 'ok', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('tools', { register: () => () => {} })
  const routes = []
  ctx.provide('webServer', {
    port: 0,
    register(route) {
      routes.push(route)
      return () => {}
    },
  })

  const fiber = ctx.plugin(plugin, {
    stateDir,
    accessPolicy: 'open',
    typing: false,
    progress: 'off',
    logLevel: 'silent',
    loginPage: true,
    loginPagePort: 0,
    autoLogin: false,
    baseUrl: gLogin.baseUrl,
  })

  const call = async (target, options = {}) =>
    new Promise((resolve) => {
      const response = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
          this.statusCode = status
          this.headers = headers
        },
        end(body) {
          this.body = body ?? ''
          resolve(this)
        },
      }
      routes[0].handler({ url: target, method: options.method ?? 'GET' }, response)
    })

  try {
    await waitFor(() => gA.state.polls > 0 && routes.length === 1, { timeoutMs: 8_000, label: 'bot A polling' })

    const add = await call('/dsh-wechat/api/add', { method: 'POST' })
    assert.equal(add.statusCode, 200)
    await waitFor(() => gLogin.state.qrIssued > 0, { timeoutMs: 8_000, label: 'qr issued' })
    gLogin.state.qrPhase = 'confirmed'

    // The bound credential now carries the token from the scan…
    const onDisk = await waitFor(
      async () => {
        const raw = JSON.parse(await readFile(path.join(stateDir, 'credentials.json'), 'utf8'))
        return raw.bots?.['bot-a@im.bot']?.botToken === 'token-rebound' ? raw : null
      },
      { timeoutMs: 8_000, label: 'credential rebound' },
    )
    assert.ok(onDisk.bots['bot-a@im.bot'], 'the bot stayed bound')
    assert.equal(Object.keys(onDisk.bots).length, 1, 're-binding does not duplicate the bot')

    // …and the replacement channel polls the gateway that issued it.
    await waitFor(() => gLogin.state.polls > 0, { timeoutMs: 8_000, label: 'rebound channel polls' })
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await gA.close()
    await gLogin.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('a login nobody completes times out, says so, and frees the add button', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-logintimeout-'))
  const gLogin = await startGateway()
  await writeFile(path.join(stateDir, 'credentials.json'), JSON.stringify({ version: 2, bots: {} }))

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness({ reply: 'ok', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('tools', { register: () => () => {} })
  const routes = []
  ctx.provide('webServer', { port: 0, register(route) { routes.push(route); return () => {} } })

  const fiber = ctx.plugin(plugin, {
    stateDir,
    accessPolicy: 'open',
    typing: false,
    progress: 'off',
    logLevel: 'silent',
    loginPage: true,
    loginPagePort: 0,
    autoLogin: false,
    baseUrl: gLogin.baseUrl,
    // Short enough for a test, long enough for the QR request to land.
    loginTimeoutSeconds: 1,
  })

  const call = async (target, options = {}) =>
    new Promise((resolve) => {
      const response = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers },
        end(body) { this.body = body ?? ''; resolve(this) },
      }
      routes[0].handler({ url: target, method: options.method ?? 'GET' }, response)
    })

  try {
    await waitFor(() => routes.length === 1, { timeoutMs: 8_000, label: 'route' })
    const add = await call('/dsh-wechat/api/add', { method: 'POST' })
    assert.equal(add.statusCode, 200)

    // The gateway is left on "wait": nobody scans, so the deadline must end the attempt.
    const settled = await waitFor(
      async () => {
        const status = await call('/dsh-wechat/api/status')
        const body = JSON.parse(status.body)
        return body.adding === false && body.phase === 'failed' ? body : null
      },
      { timeoutMs: 10_000, label: 'login timed out' },
    )
    assert.ok(settled.errorCount >= 1, 'the failure reached the error log')
    const errors = JSON.parse((await call('/dsh-wechat/api/errors')).body)
    assert.ok(
      errors.entries.some((entry) => /添加 bot 未完成|添加 bot 失败/.test(entry.message)),
      'the log names the aborted sign-in',
    )
    // The button is usable again: a second attempt is accepted rather than answered 409.
    const again = await call('/dsh-wechat/api/add', { method: 'POST' })
    assert.equal(again.statusCode, 200)
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await gLogin.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('while adding a bot the QR stays visible even though another bot is connected', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-addqr-'))
  const gA = await startGateway()
  const gLogin = await startGateway()
  await writeFile(
    path.join(stateDir, 'credentials.json'),
    JSON.stringify({
      version: 2,
      bots: { 'bot-a@im.bot': { version: 1, botToken: 'token-a', botId: 'bot-a@im.bot', baseUrl: gA.baseUrl, source: 'file' } },
    }),
  )

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness({ reply: 'ok', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('tools', { register: () => () => {} })
  const routes = []
  ctx.provide('webServer', { port: 0, register(route) { routes.push(route); return () => {} } })

  const fiber = ctx.plugin(plugin, {
    stateDir,
    accessPolicy: 'open',
    typing: false,
    progress: 'off',
    logLevel: 'silent',
    loginPage: true,
    loginPagePort: 0,
    autoLogin: false,
    baseUrl: gLogin.baseUrl,
  })

  const call = async (target, options = {}) =>
    new Promise((resolve) => {
      const response = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers },
        end(body) { this.body = body ?? ''; resolve(this) },
      }
      routes[0].handler({ url: target, method: options.method ?? 'GET' }, response)
    })

  try {
    await waitFor(() => gA.state.polls > 0 && routes.length === 1, { timeoutMs: 8_000, label: 'bot A polling' })

    // Before the scan: bot A is connected and there is no code.
    const before = JSON.parse((await call('/dsh-wechat/api/status')).body)
    assert.equal(before.bots.length, 1)
    assert.equal(before.hasQr, false)

    await call('/dsh-wechat/api/add', { method: 'POST' })
    await waitFor(() => gLogin.state.qrIssued > 0, { timeoutMs: 8_000, label: 'qr issued' })

    const during = await waitFor(
      async () => {
        const body = JSON.parse((await call('/dsh-wechat/api/status')).body)
        return body.hasQr ? body : null
      },
      { timeoutMs: 8_000, label: 'qr visible while adding' },
    )
    assert.equal(during.adding, true)
    assert.match(during.qrUrl, /^\/dsh-wechat\/api\/qr\.svg\?v=/)
    assert.equal(during.bots.length, 1, 'the bound bot is still listed')

    const svg = await call(during.qrUrl)
    assert.equal(svg.statusCode, 200, 'the card can fetch the code while another bot is connected')
    assert.match(svg.headers['Content-Type'], /image\/svg\+xml/)
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await gA.close()
    await gLogin.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
