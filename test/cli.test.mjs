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

test('flags are parsed for every documented option, and the rest are reported', () => {
  assert.deepEqual(parseFlags([]), { flags: {}, rest: [], unknown: [] })
  assert.deepEqual(parseFlags(['state-dir', '/tmp/x']), { flags: {}, rest: ['state-dir', '/tmp/x'], unknown: [] })
  assert.deepEqual(parseFlags(['--state-dir', '/tmp/x', '--base-url', 'http://127.0.0.1:1']), {
    flags: { stateDir: '/tmp/x', baseUrl: 'http://127.0.0.1:1' },
    rest: [],
    unknown: [],
  })
  // A value flag without a value must not swallow the next flag: the person forgot the
  // directory, and the next flag still has to be read as a flag.
  assert.deepEqual(parseFlags(['--state-dir', '--base-url', 'http://x']), {
    flags: { baseUrl: 'http://x' },
    rest: [],
    unknown: [],
  })
  assert.deepEqual(parseFlags(['send', 'user@im.wechat', '你好', '世界']), {
    flags: {},
    rest: ['send', 'user@im.wechat', '你好', '世界'],
    unknown: [],
  })
  // The removed scan-page flags are reported instead of silently doing nothing.
  assert.deepEqual(parseFlags(['--page', '--no-open']), { flags: {}, rest: [], unknown: ['--page', '--no-open'] })
  assert.deepEqual(parseFlags(['--port', '30989']), { flags: {}, rest: ['30989'], unknown: ['--port'] })
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

test('`login` renders the code in the terminal and stores the credential on confirmation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-cli-login-'))
  const gateway = await startGateway()
  let child
  try {
    child = spawn(process.execPath, [CLI, 'login', '--state-dir', dir, '--base-url', gateway.baseUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const exited = new Promise((resolve) => child.on('close', resolve))

    // The code is drawn where the command runs: there is no page to open any more.
    await waitFor(() => /扫码登录|微信扫码|二维码/.test(stdout), { timeoutMs: 10_000, label: 'terminal qr' })
    assert.equal(stdout.includes('扫码页'), false, 'the page banner is gone')
    assert.equal(existsSync(path.join(dir, 'login-page.url')), false, 'no page URL is written')

    // The QR files still land in the state directory (this used to fail with ENOENT
    // because nothing had created the directory yet).
    await waitFor(() => existsSync(path.join(dir, 'login-qrcode.svg')), { timeoutMs: 8_000, label: 'qr svg file' })
    const svg = await readFile(path.join(dir, 'login-qrcode.svg'), 'utf8')
    assert.match(svg, /^<svg xmlns/)

    gateway.state.qrPhase = 'confirmed'
    const code = await exited
    assert.equal(code, 0, `login must exit 0 (stderr: ${stderr})`)
    assert.match(stdout, /登录成功/)

    const stored = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'))
    assert.equal(stored.version, 2)
    assert.equal(stored.bots['bot-qr@im.bot'].botToken, 'token-from-qr')

    // The old flag is gone for good: it is rejected rather than silently ignored.
    const rejected = spawn(process.execPath, [CLI, 'login', '--state-dir', dir, '--page'], { stdio: 'ignore' })
    const rejectedCode = await new Promise((resolve) => rejected.on('close', resolve))
    assert.notEqual(rejectedCode, 0, '--page is no longer a flag')
  } finally {
    child?.kill('SIGKILL')
    await gateway.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
