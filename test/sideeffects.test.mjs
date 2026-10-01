/**
 * The side-effect budget.
 *
 * This plugin runs inside the DSH host with the user's full permissions, so the
 * set of things it may do to the machine is a contract worth testing rather than
 * documenting. Each case below fails when a new implicit side effect appears:
 * a second subprocess call site, an OS-launcher invocation, a listening socket on
 * anything but loopback, an environment mutation, an unbounded timer, or an
 * outbound host that is not the WeChat gateway the operator configured.
 *
 * The Finder incident is the reason this file exists: a test that merely asserted
 * a boolean return value let `open ''` open the working directory on screen.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every runtime source file, with comments stripped so prose cannot satisfy a check. */
async function sources() {
  const files = []
  for (const directory of ['lib', 'lib/ilink', 'bin']) {
    for (const entry of await readdir(path.join(root, directory))) {
      if (!/\.(mjs|js)$/.test(entry)) continue
      const file = path.join(directory, entry)
      const raw = await readFile(path.join(root, file), 'utf8')
      files.push({
        file,
        raw,
        code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      })
    }
  }
  return files
}

test('exactly one module may start a subprocess, and it guards the input', async () => {
  const files = await sources()
  const importers = files.filter((entry) => /from 'node:child_process'/.test(entry.code)).map((entry) => entry.file)
  assert.deepEqual(importers, ['lib/channel.js'], 'only the browser launcher may spawn a process')

  // The single launch is `launch(command[0], …)`, where `launch` is the injected
  // seam defaulting to `spawn`; that indirection must stay the only one.
  const callSites = files.flatMap((entry) =>
    entry.code
      .split('\n')
      .map((line, index) => ({ file: entry.file, line: index + 1, text: line }))
      .filter((entry) => /\blaunch\s*\(/.test(entry.text) || /[^.]\bspawn\s*\(/.test(entry.text)),
  )
  assert.equal(callSites.length, 1, `expected one launch call site, found ${JSON.stringify(callSites)}`)
  assert.match(callSites[0].file, /lib\/channel\.js/)

  const channel = files.find((entry) => entry.file === 'lib/channel.js')
  const guardAt = channel.code.indexOf('isLaunchableUrl(url)')
  const spawnAt = channel.code.indexOf('launch(command[0]')
  assert.ok(guardAt > -1, 'the guard must exist')
  assert.ok(guardAt < spawnAt, 'the guard must run before the launcher is started')
  assert.match(channel.code, /internals\.spawn \?\? spawn/, 'the launcher must stay injectable')
})

test('no OS-automation, autostart, or clipboard integration exists', async () => {
  const forbidden = [
    /osascript/i,
    /LaunchAgents|LaunchDaemons/,
    /crontab/i,
    /systemctl|systemd/,
    /defaults\s+write/i,
    /plutil/i,
    /pbcopy|pbpaste|clipboard/i,
    /loginItem|SMAppService/i,
    /process\.exit\s*\(/,
    /process\.env\.[A-Z0-9_]+\s*=(?!=)/,
  ]
  for (const entry of await sources()) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(entry.code), false, `${entry.file} matches ${pattern}`)
    }
  }
})

test('the only listening socket is the loopback scan page', async () => {
  const files = await sources()
  const servers = files.filter((entry) => /createServer\(/.test(entry.code))
  assert.deepEqual(servers.map((entry) => entry.file), ['lib/loginpage.js'])
  const page = servers[0].code
  assert.match(page, /listen\(port, '127\.0\.0\.1'/, 'the page must bind loopback explicitly')
  for (const entry of files) {
    assert.equal(/0\.0\.0\.0/.test(entry.code), false, `${entry.file} exposes a wildcard address`)
  }
  // The GUI integration reuses the host server instead of opening another one.
  const index = files.find((entry) => entry.file === 'lib/index.js').code
  assert.match(index, /webServer\.register\(/, 'the GUI route must reuse the host web server')
})

test('outbound hosts are only the configured WeChat gateway and loopback', async () => {
  const allowed = new Set([
    'https://ilinkai.weixin.qq.com',
    'https://novac2c.cdn.weixin.qq.com/c2c',
    'http://www.w3.org/2000/svg',
  ])
  const found = new Set()
  for (const entry of await sources()) {
    for (const match of entry.code.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._/-]*)?/g)) {
      const value = match[0].replace(/[.,;)'"`]+$/, '')
      if (/^https?:\/\/(?:127\.0\.0\.1|localhost)/.test(value)) continue
      if (value.includes('${')) continue
      found.add(value)
    }
  }
  const unexpected = [...found].filter((value) => !allowed.has(value))
  assert.deepEqual(unexpected, [], `unexpected outbound hosts: ${unexpected.join(', ')}`)
})

test('every long-lived timer is unref-ed so the host can exit', async () => {
  for (const entry of await sources()) {
    const intervals = (entry.code.match(/setInterval\(/g) ?? []).length
    if (intervals === 0) continue
    const unrefs = (entry.code.match(/\.unref\?\.\(\)|\.unref\(\)/g) ?? []).length
    assert.ok(unrefs >= intervals, `${entry.file}: ${intervals} interval(s) but only ${unrefs} unref call(s)`)
  }
})

test('credentials and received media stay owner-only', async () => {
  const store = (await sources()).find((entry) => entry.file === 'lib/store.js').code
  assert.match(store, /mode: 0o700/, 'the state directory must not be listable by others')
  assert.match(store, /mode = 0o600/, 'state files must stay 0600')

  const media = (await sources()).find((entry) => entry.file === 'lib/ilink/media.js').code
  assert.match(media, /mkdir\(dir, \{ recursive: true, mode: 0o700 \}\)/)
  assert.match(media, /writeFile\(target, plaintext, \{ mode: 0o600 \}\)/)
})

test('the plugin writes only inside its own state directory', async () => {
  const files = await sources()
  const writePaths = []
  for (const entry of files) {
    for (const match of entry.code.matchAll(/writeFile\(\s*([A-Za-z0-9_.$[\]'"]+)/g)) {
      writePaths.push({ file: entry.file, target: match[1] })
    }
  }
  // Every target is either a `paths.*` member resolved from the state directory
  // or the media file resolved from the configured media directory.
  for (const { file, target } of writePaths) {
    const allowed = /^paths\.|^temporary$|^target$|^this\.urlFile$/.test(target)
    assert.ok(allowed, `${file} writes to an unexpected target: ${target}`)
  }
  assert.ok(writePaths.length >= 4, 'the write sites should still be discoverable by this test')
})
