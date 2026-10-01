/**
 * The command line, exercised as a real child process against a fake iLink
 * gateway: this is the path a user follows when the desktop app's log is not
 * reachable, so it must work end to end.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFlags } from '../lib/cli-flags.js'
import { startGateway, waitFor } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, '..', 'bin', 'dsh-wechat.mjs')

test('flags are parsed for every documented option', () => {
  assert.deepEqual(parseFlags([]), { flags: {}, rest: [] })
  assert.deepEqual(parseFlags(['--page']), { flags: { page: true }, rest: [] })
  assert.deepEqual(parseFlags(['--page', '--no-open', '--port', '30989']), {
    flags: { page: true, noOpen: true, port: 30989 },
    rest: [],
  })
  assert.deepEqual(parseFlags(['--state-dir', '/tmp/x', '--base-url', 'http://127.0.0.1:1']), {
    flags: { stateDir: '/tmp/x', baseUrl: 'http://127.0.0.1:1' },
    rest: [],
  })
  // A value flag without a value must not swallow the next flag: the person
  // forgot the directory, and --page still has to work.
  assert.deepEqual(parseFlags(['--state-dir', '--page']), { flags: { page: true }, rest: [] })
  assert.deepEqual(parseFlags(['send', 'user@im.wechat', '你好', '世界']), {
    flags: {},
    rest: ['send', 'user@im.wechat', '你好', '世界'],
  })
})

test('`qr` renders without touching the network or the state directory', async () => {
  const child = spawn(process.execPath, [CLI, 'qr', 'https://example.test/x'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(code, 0)
  assert.ok(stdout.includes('\u2588'), 'the terminal QR uses half blocks')
  assert.match(stdout, /https:\/\/example\.test\/x/)
})

test('`status` reports an unbound state without creating credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-cli-status-'))
  try {
    const child = spawn(process.execPath, [CLI, 'status', '--state-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    const code = await new Promise((resolve) => child.on('close', resolve))
    assert.equal(code, 0)
    assert.match(stdout, /未绑定/)
    assert.match(stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(existsSync(path.join(dir, 'credentials.json')), false)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('`login --page` serves a scan page and stores the credential on confirmation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-cli-login-'))
  const gateway = await startGateway()
  let child
  try {
    child = spawn(
      process.execPath,
      [CLI, 'login', '--state-dir', dir, '--base-url', gateway.baseUrl, '--page', '--port', '0', '--no-open'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const exited = new Promise((resolve) => child.on('close', resolve))

    // The page announces itself on stdout and writes its URL for later.
    await waitFor(() => /扫码页：http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+\//.test(stdout), {
      timeoutMs: 10_000,
      label: 'page url on stdout',
    })
    const url = /扫码页：(http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+\/)/.exec(stdout)[1]
    // The banner is printed right after the page resolves, so wait for it rather
    // than racing the child's stdout.
    await waitFor(() => stdout.includes('已用 --no-open 跳过自动打开浏览器'), {
      timeoutMs: 5_000,
      label: 'no-open banner',
    })

    const urlFile = path.join(dir, 'login-page.url')
    await waitFor(() => existsSync(urlFile), { timeoutMs: 5_000, label: 'url file' })
    assert.equal((await readFile(urlFile, 'utf8')).trim(), url)

    const state = await waitFor(
      async () => {
        const response = await fetch(`${url}state.json`)
        if (!response.ok) return false
        const snapshot = await response.json()
        // The page starts before the first QR is issued, so wait for the code.
        return snapshot.hasQr ? snapshot : false
      },
      { timeoutMs: 8_000, label: 'page state with a scan code' },
    )
    assert.equal(state.phase, 'waiting')
    assert.equal(state.botId, null)
    const html = await (await fetch(url)).text()
    assert.ok(html.includes('<svg'))

    // The QR files also land in the state directory (this used to fail with
    // ENOENT because nothing had created the directory yet).
    await waitFor(() => existsSync(path.join(dir, 'login-qrcode.svg')), { timeoutMs: 5_000, label: 'qr svg file' })
    const svg = await readFile(path.join(dir, 'login-qrcode.svg'), 'utf8')
    assert.match(svg, /^<svg xmlns/)

    // Wording is only revealed after login, so it must not leak into the page.
    assert.ok(!html.includes('token-from-qr'))

    gateway.state.qrPhase = 'confirmed'
    const code = await exited
    assert.equal(code, 0, `login must exit 0 (stderr: ${stderr})`)
    assert.match(stdout, /登录成功/)

    const credentials = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'))
    assert.equal(credentials.botToken, 'token-from-qr')
    assert.equal(credentials.botId, 'bot-qr@im.bot')
  } finally {
    child?.kill('SIGKILL')
    await gateway.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
