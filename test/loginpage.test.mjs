import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { LoginPage } from '../lib/loginpage.js'
import { encodeQrMatrix, renderQrSvg } from '../lib/qr.js'
import { createLogger } from '../lib/log.js'
import { isLaunchableUrl, openInBrowser } from '../lib/channel.js'

const logger = createLogger('silent')
const PAYLOAD = 'https://weixin.qq.com/x/dsh-wechat-login'

/** Start a page on an OS-assigned port with a realistic status provider. */
async function startPage(overrides = {}) {
  const page = new LoginPage({ logger, port: 0 })
  page.status = () => ({
    loggedIn: false,
    botId: null,
    baseUrl: 'https://ilinkai.weixin.qq.com',
    conversations: 2,
    cursor: 'cursor-abcdefghijklmnop',
    stateDir: '/tmp/dsh-state',
    lastError: null,
    ...overrides.status,
  })
  await page.start()
  return page
}

test('the page URL is written to a file for operators without a log', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-urlfile-'))
  const urlFile = join(dir, 'login-page.url')
  const page = new LoginPage({ logger, port: 0, urlFile })
  try {
    await page.start()
    assert.equal((await readFile(urlFile, 'utf8')).trim(), page.url)
  } finally {
    await page.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the page requires the one-time token', async () => {
  const page = await startPage()
  try {
    const denied = await fetch(`http://127.0.0.1:${page.port}/`)
    assert.equal(denied.status, 403)
    assert.match(await denied.text(), /令牌/)

    const wrong = await fetch(`http://127.0.0.1:${page.port}/t/${'0'.repeat(page.token.length)}/`)
    assert.equal(wrong.status, 403)

    const allowed = await fetch(page.url)
    assert.equal(allowed.status, 200)
    assert.match(allowed.headers.get('content-type'), /text\/html/)
  } finally {
    await page.stop()
  }
})

test('the page renders the scan code and live status without leaking the token', async () => {
  const page = await startPage()
  try {
    page.publish({ phase: 'waiting', payload: PAYLOAD, qrcode: 'qrc_1' })
    const body = await (await fetch(page.url)).text()

    // The SVG is the same encoder output, module-for-module.
    const expected = renderQrSvg(encodeQrMatrix(PAYLOAD), { scale: 6, quietZone: 4 })
    assert.ok(body.includes(expected), 'page must embed the encoded QR')
    assert.match(body, /等待扫码/)
    assert.match(body, /https:\/\/ilinkai\.weixin\.qq\.com/)
    // The cursor is shown truncated, so only its head is on the page.
    assert.match(body, /cursor-abcdefghijk…/)
    assert.match(body, /已绑定会话/)
    // The bot token must never be rendered, and the page URL carries the token.
    assert.equal(body.includes(page.token), false)
  } finally {
    await page.stop()
  }
})

test('state.json reports the machine-readable phase and hides the QR once logged in', async () => {
  const page = await startPage()
  try {
    page.publish({ phase: 'waiting', payload: PAYLOAD, qrcode: 'qrc_1' })
    const waiting = await (await fetch(`${page.url}state.json`)).json()
    assert.equal(waiting.phase, 'waiting')
    assert.equal(waiting.hasQr, true)
    assert.equal(waiting.label, '等待扫码')

    // A stored credential flips the page to confirmed even before the channel notices.
    page.status = () => ({ loggedIn: true, botId: 'bot@im.bot', conversations: 3 })
    const confirmed = await (await fetch(`${page.url}state.json`)).json()
    assert.equal(confirmed.phase, 'confirmed')
    assert.equal(confirmed.hasQr, false)
    assert.equal(confirmed.botId, 'bot@im.bot')

    const html = await (await fetch(page.url)).text()
    assert.match(html, /登录成功/)
    assert.equal(html.includes('<svg'), false, 'no scan code once logged in')
  } finally {
    await page.stop()
  }
})

test('scan-state transitions are reflected on the page', async () => {
  const page = await startPage()
  try {
    for (const [phase, label] of [
      ['scaned', '已扫码，请在手机上确认'],
      ['expired', '二维码已过期，正在重新申请'],
      ['failed', '登录失败'],
    ]) {
      page.publish({ phase })
      const state = await (await fetch(`${page.url}state.json`)).json()
      assert.equal(state.label, label)
    }
  } finally {
    await page.stop()
  }
})

test('the restart button flips a flag the channel can consume', async () => {
  const page = await startPage()
  try {
    assert.equal(page.restartRequested, false)
    const response = await fetch(`${page.url}restart`, { method: 'POST' })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(page.restartRequested, true)
  } finally {
    await page.stop()
  }
})

test('a busy preferred port falls back to an OS-assigned one', async () => {
  const blocker = createServer(() => {})
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port
  const page = new LoginPage({ logger, port: busyPort })
  try {
    await page.start()
    assert.notEqual(page.port, busyPort)
    assert.ok(page.port > 0)
    assert.equal((await fetch(page.url)).status, 200)
  } finally {
    await page.stop()
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('stop() releases the port', async () => {
  const page = await startPage()
  const port = page.port
  await page.stop()
  assert.equal(page.port, null)
  const probe = createServer(() => {})
  await new Promise((resolve) => probe.listen(port, '127.0.0.1', resolve))
  await new Promise((resolve) => probe.close(resolve))
})

test('openInBrowser refuses an unusable URL without launching anything', () => {
  // Regression: `open ''` on macOS opens the *current directory* in Finder rather
  // than failing, so this test must assert that no launcher was started — asserting
  // a boolean return is what let a Finder window pop up on every test run.
  const launched = []
  const fakeSpawn = (...args) => {
    launched.push(args)
    return { on() {}, unref() {} }
  }
  for (const value of ['', '   ', undefined, null, 42, 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', '/tmp']) {
    const opened = openInBrowser(value, logger, { spawn: fakeSpawn })
    assert.equal(opened, false, `${JSON.stringify(value)} must be refused`)
  }
  assert.equal(launched.length, 0, 'no launcher may be spawned for an unusable URL')
  assert.equal(isLaunchableUrl(''), false)
  assert.equal(isLaunchableUrl('https://example.test/x'), true)
})

test('openInBrowser hands the platform launcher the http(s) URL', () => {
  const cases = [
    ['darwin', 'open', (url) => [url]],
    ['win32', 'cmd', (url) => ['/c', 'start', '', url]],
    ['linux', 'xdg-open', (url) => [url]],
  ]
  for (const [platform, executable, expectedArgs] of cases) {
    const launched = []
    const fakeSpawn = (...args) => {
      launched.push(args)
      return { on() {}, unref() {} }
    }
    const url = 'http://127.0.0.1:30989/t/abc/'
    assert.equal(openInBrowser(url, logger, { spawn: fakeSpawn, platform }), true)
    assert.equal(launched.length, 1)
    assert.equal(launched[0][0], executable)
    assert.deepEqual(launched[0][1], expectedArgs(url))
    // Detached and quiet, with no console flash on Windows.
    assert.deepEqual(launched[0][2], { stdio: 'ignore', detached: true, windowsHide: true })
  }
})

test('a launcher that fails to start is reported, not thrown', () => {
  const result = openInBrowser('https://example.test/x', logger, {
    spawn: () => {
      throw new Error('spawn EACCES')
    },
  })
  assert.equal(result, false)
})
