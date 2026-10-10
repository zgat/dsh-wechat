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

/**
 * Every shipped source file, with comments stripped so prose cannot satisfy a check.
 *
 * The walk is recursive on purpose: listing three directories by hand meant a new
 * subdirectory (or `scripts/`, which the package also ships) escaped every budget.
 * @param {string} [directory] - directory to walk, relative to the repo root.
 * @returns {Promise<{file: string, raw: string, code: string}[]>} the sources.
 */
/** Runtime code only: `lib/` and `bin/`, which the host process loads. */
async function runtimeSources() {
  return [...(await sources('lib')), ...(await sources('bin'))]
}

/** Tooling: the scripts a developer runs, which legitimately do more. */
async function toolingSources() {
  return sources('scripts')
}

async function sources(directory = '.') {
  const files = []
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  for (const entry of entries) {
    const relative = directory === '.' ? entry.name : path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'test', 'docs'].includes(entry.name)) continue
      files.push(...(await sources(relative)))
      continue
    }
    if (!/\.(mjs|js)$/.test(entry.name)) continue
    const raw = await readFile(path.join(root, relative), 'utf8')
    files.push({
      file: relative,
      raw,
      code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    })
  }
  return files
}

test('exactly one module may start a subprocess, and it guards the input', async () => {
  const files = await runtimeSources()
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
  // Runtime only: the *plugin* must never automate the OS. The developer tooling in
  // scripts/ legitimately schedules a LaunchAgent, which the tooling test below bounds.
  for (const entry of await runtimeSources()) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(entry.code), false, `${entry.file} matches ${pattern}`)
    }
  }
  const tooling = (await toolingSources()).map((entry) => entry.code).join('\n')
  assert.equal(/osascript|pbcopy|pbpaste|crontab|systemctl/i.test(tooling), false, 'tooling stays out of other OS automation')
})

test('the only listening socket is the loopback scan page', async () => {
  const files = await runtimeSources()
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
  // Runtime only: the tooling vendors a plist DOCTYPE (an XML namespace, not a request).
  for (const entry of await runtimeSources()) {
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
  // Counting unrefs per file let one un-unref-ed interval hide behind an unrelated
  // `setTimeout(...).unref()`. Each interval is checked on its own now.
  for (const entry of await runtimeSources()) {
    const lines = entry.code.split('\n')
    lines.forEach((line, index) => {
      if (!/setInterval\(/.test(line)) return
      const window = lines.slice(index, index + 20).join('\n')
      assert.match(
        window,
        /\.unref\?\.\(\)|\.unref\(\)/,
        `${entry.file}:${index + 1}: a setInterval without a nearby unref keeps the host alive`,
      )
    })
  }
})

test('the tooling touches only its documented outside paths', async () => {
  // scripts/ runs on a developer machine, so it may do more than the plugin — but only
  // the documented set: a LaunchAgent, one log file, $TMPDIR, and the repo/profile.
  const files = await toolingSources()
  assert.ok(files.length >= 4, 'scripts/ should still be discovered')
  const allowed = [
    /Applications\/DeepSeek Harness\.app\/Contents\/Resources\/runtime\/pnpm/,
    /Library\/LaunchAgents/,
    /dsh-wechat-restart\.log/,
    /dsh-restart\.(log|last|pid)/,
    /TMPDIR/,
    /\.dsh\/profiles/,
    /\.dsh\/integrations/,
    /Application Support\/dsh-wechat/,
  ]
  for (const entry of files) {
    for (const match of entry.code.matchAll(/['"`]([^'"`]*\/(?:Library|Applications)[^'"`]*)['"`]/g)) {
      const value = match[1]
      assert.ok(
        allowed.some((re) => re.test(value)),
        `${entry.file} mentions an undocumented system path: ${value}`,
      )
    }
  }
})

test('credentials and received media stay owner-only', async () => {
  const store = (await runtimeSources()).find((entry) => entry.file === path.join('lib', 'store.js')).code
  assert.match(store, /mode: 0o700/, 'the state directory must not be listable by others')
  assert.match(store, /mode = 0o600/, 'state files must stay 0600')

  const media = (await runtimeSources()).find((entry) => entry.file === path.join('lib', 'ilink', 'media.js')).code
  assert.match(media, /mkdir\(dir, \{ recursive: true, mode: 0o700 \}\)/)
  assert.match(media, /writeFile\(target, plaintext, \{ mode: 0o600 \}\)/)
})

test('the plugin writes only inside its own state directory', async () => {
  const files = await runtimeSources()
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
