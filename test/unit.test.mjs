import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { checkAccess, defaultConfig, normalizeConfig } from '../lib/config.js'
import { parseCommand } from '../lib/commands.js'
import { helpText } from '../lib/onboarding.js'
import { briefValue, normalizeAnswer, redactText, splitText, toolProgressLine } from '../lib/render.js'
import { WechatStore, dshHome, messageKey, resolvePaths } from '../lib/store.js'
import { createTextUserMessage, latestAssistantText, newSessionId, service } from '../lib/harness.js'
import { expandHome, isInsideDirectory, unquote } from '../lib/bridge.js'
import { withRetries } from '../lib/retry.js'
import { sleep } from '../lib/waits.js'
import { describeVersion } from '../lib/commands.js'
import { messageText } from '../lib/harness.js'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from '../lib/log.js'
import { createTempStore } from './helpers.mjs'

const logger = createLogger('silent')

test('config defaults are complete and sane', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config, defaultConfig())
  assert.equal(config.accessPolicy, 'allowlist')
  assert.equal(config.chunkChars, 1800)
  assert.equal(config.media.enabled, true)
  assert.equal(config.enabled, true)
})

test('config accepts loose YAML spellings and rejects nonsense', () => {
  const config = normalizeConfig({
    enabled: 'false',
    accessPolicy: 'open',
    chunkChars: '900',
    typing: 'true',
    allowedUserIds: 'a@im.wechat, b@im.wechat',
    model: 'deepseek-account/deepseek-flash',
    media: { maxInboundBytes: '1024' },
    logLevel: 'debug',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.chunkChars, 900)
  assert.deepEqual(config.allowedUserIds, ['a@im.wechat', 'b@im.wechat'])
  assert.deepEqual(config.model, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(config.media.maxInboundBytes, 1024)

  assert.throws(() => normalizeConfig({ accessPolicy: 'everyone' }), /accessPolicy must be one of/)
  assert.throws(() => normalizeConfig({ chunkChars: 10 }), /chunkChars must be a number >= 200/)
  assert.throws(() => normalizeConfig({ model: 'just-a-model' }), /provider\/model/)
  assert.throws(() => normalizeConfig({ model: {} }), /model.provider and model.model are both required/)
  assert.throws(() => normalizeConfig({ typing: 'maybe' }), /typing must be a boolean/)
})

test('access policy allows the owner, listed senders, and everyone when open', () => {
  const base = normalizeConfig({})
  assert.equal(checkAccess({ ...base, ownerUserId: 'owner@im.wechat' }, 'owner@im.wechat').allowed, true)
  assert.equal(checkAccess({ ...base, allowedUserIds: ['a@im.wechat'] }, 'a@im.wechat').allowed, true)
  const denied = checkAccess(base, 'stranger@im.wechat')
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /白名单/)
  assert.equal(checkAccess({ ...base, accessPolicy: 'open' }, 'stranger@im.wechat').allowed, true)
})

test('state paths follow DSH_HOME and honour an explicit override', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home-test'
  try {
    assert.equal(dshHome(), '/tmp/dsh-home-test')
    const paths = resolvePaths(normalizeConfig({}))
    assert.equal(paths.root, '/tmp/dsh-home-test/integrations/dsh-wechat')
    assert.equal(paths.credentials, '/tmp/dsh-home-test/integrations/dsh-wechat/credentials.json')
    const custom = resolvePaths(normalizeConfig({ stateDir: '/tmp/custom-state' }))
    assert.equal(custom.root, '/tmp/custom-state')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the store persists sessions, cursors and context tokens', async () => {
  const temp = await createTempStore()
  try {
    await temp.store.setSession('p2p:a@im.wechat', 'session-1')
    await temp.store.setCursor('cursor-abc')
    temp.store.rememberContextToken('a@im.wechat', 'token-1')
    temp.store.persistTokens()
    temp.store.rememberOutbound({ toUserId: 'a@im.wechat', text: 'hi' })
    await temp.store.flush()

    const reloaded = new WechatStore({ config: temp.config, logger })
    await reloaded.load()
    assert.equal(reloaded.sessionFor('p2p:a@im.wechat'), 'session-1')
    assert.equal(reloaded.cursor, 'cursor-abc')
    assert.equal(reloaded.contextTokenFor('a@im.wechat'), 'token-1')
    assert.equal(reloaded.state.stats.outbound, 1)
  } finally {
    await temp.cleanup()
  }
})

test('the store deduplicates messages and bounds its memory', async () => {
  const temp = await createTempStore()
  try {
    assert.equal(temp.store.hasSeen({ message_id: 1 }), false)
    assert.equal(temp.store.hasSeen({ message_id: 1 }), true)
    assert.equal(temp.store.hasSeen({ seq: 7, from_user_id: 'u' }), false)
    assert.equal(temp.store.hasSeen({ seq: 7, from_user_id: 'u' }), true)

    for (let index = 0; index < 1_100; index += 1) temp.store.hasSeen({ message_id: 10_000 + index })
    assert.ok(temp.store.state.seenMessageIds.length <= 1_000)
    // The oldest keys are evicted; the newest survive.
    assert.equal(temp.store.hasSeen({ message_id: 10_000 }), false)
    assert.equal(temp.store.hasSeen({ message_id: 10_999 }), true)
  } finally {
    await temp.cleanup()
  }
})

test('credentials are written atomically with owner-only permissions', async () => {
  const temp = await createTempStore()
  try {
    await temp.store.saveCredentials({ botToken: 'tok', botId: 'bot@im.bot', baseUrl: 'https://x' })
    const mode = (await stat(temp.store.paths.credentials)).mode & 0o777
    assert.equal(mode, 0o600)
    const written = JSON.parse(await readFile(temp.store.paths.credentials, 'utf8'))
    assert.equal(written.botToken, 'tok')
    assert.equal(written.version, 1)

    await temp.store.clearCredentials()
    await assert.rejects(() => readFile(temp.store.paths.credentials, 'utf8'), /ENOENT/)
    assert.equal(temp.store.loggedIn, false)
    assert.equal(temp.store.cursor, '')
  } finally {
    await temp.cleanup()
  }
})

test('a corrupt state file is quarantined and the plugin still starts', async () => {
  const temp = await createTempStore()
  try {
    await temp.store.setSession('p2p:a@im.wechat', 'session-1')
    await temp.store.flush()
    await writeFile(temp.store.paths.state, '{ not json')

    const warnings = []
    const store = new WechatStore({ config: temp.config, logger: createLogger('silent', { sink: (...args) => warnings.push(args.join(' ')) }) })
    await store.load()

    // Loading succeeds with empty state, and the unreadable file is preserved.
    assert.deepEqual(store.state.sessions, {})
    assert.equal(store.cursor, '')
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(temp.dir)
    const quarantined = files.filter((entry) => entry.startsWith('state.json.corrupt-'))
    assert.equal(quarantined.length, 1)
    assert.match(await readFile(new URL(`file://${temp.dir}/${quarantined[0]}`), 'utf8'), /not json/)

    // And the store is usable afterwards.
    await store.setSession('p2p:a@im.wechat', 'session-2')
    await store.flush()
    assert.equal(JSON.parse(await readFile(temp.store.paths.state, 'utf8')).sessions['p2p:a@im.wechat'], 'session-2')
  } finally {
    await temp.cleanup()
  }
})

test('environment credentials win over the file and are never written', async () => {
  const temp = await createTempStore()
  process.env.DSH_WECHAT_BOT_TOKEN = 'env-token'
  process.env.DSH_WECHAT_BOT_ID = 'env-bot@im.bot'
  try {
    const store = new WechatStore({ config: temp.config, logger })
    await store.load()
    assert.equal(store.loggedIn, true)
    assert.equal(store.credentials.botToken, 'env-token')
    assert.equal(store.credentials.source, 'env')
    await store.saveCredentials({ botToken: 'env-token' })
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(temp.store.paths.credentials), false)
  } finally {
    delete process.env.DSH_WECHAT_BOT_TOKEN
    delete process.env.DSH_WECHAT_BOT_ID
    await temp.cleanup()
  }
})

test('message keys prefer the platform id and fall back to seq', () => {
  assert.equal(messageKey({ message_id: 5 }), 'id:5')
  assert.equal(messageKey({ seq: 3, from_user_id: 'u' }), 'seq:u:3')
  assert.equal(messageKey({}), '')
})

test('splitText breaks on paragraphs, then lines, then hard cuts', () => {
  const paragraph = `${'a'.repeat(600)}\n\n${'b'.repeat(600)}`
  const chunks = splitText(paragraph, 700)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], 'a'.repeat(600))
  assert.equal(chunks[1], 'b'.repeat(600))

  const lines = `${'x'.repeat(300)}\n${'y'.repeat(300)}`
  assert.deepEqual(splitText(lines, 400), ['x'.repeat(300), 'y'.repeat(300)])

  const hard = 'z'.repeat(1_000)
  const hardChunks = splitText(hard, 400)
  assert.equal(hardChunks.length, 3)
  assert.equal(hardChunks.join(''), hard)

  assert.deepEqual(splitText('', 100), [])
  assert.deepEqual(splitText('short', 100), ['short'])
})

test('splitText never splits a surrogate pair', () => {
  const emoji = '😀'.repeat(50) // 100 UTF-16 units
  const chunks = splitText(emoji.repeat(3), 101)
  for (const chunk of chunks) {
    assert.equal(chunk.isWellFormed ? chunk.isWellFormed() : true, true, 'chunk must stay well formed')
  }
  assert.equal(chunks.join(''), emoji.repeat(3))
})

test('normalizeAnswer trims trailing whitespace and collapses blank runs', () => {
  assert.equal(normalizeAnswer('a  \r\nb\r\n'), 'a\nb')
  assert.equal(normalizeAnswer('a\n\n\n\n\nb'), 'a\n\n\nb')
})

test('progress helpers stay on one line and bounded', () => {
  assert.equal(briefValue('a\n b'), 'a b')
  assert.equal(briefValue('x'.repeat(50), 10).length, 10)
  assert.equal(toolProgressLine('bash', { command: 'ls' }), '🔧 bash {"command":"ls"}')
  assert.equal(toolProgressLine('bash', undefined), '🔧 bash')
})

test('progress lines redact credentials without mangling the text', () => {
  assert.equal(
    toolProgressLine('bash', { command: 'curl -H "Authorization: Bearer sk-abc123456" https://x' }),
    '🔧 bash {"command":"curl -H \\"Authorization: Bearer [已隐藏]\\" https://x"}',
  )
  assert.equal(toolProgressLine('bash', { api_key: 'sk-live-123' }), '🔧 bash {"api_key":"[已隐藏]"}')
  assert.equal(
    toolProgressLine('bash', { command: 'git push https://ghp_ABCDEFGHIJKLMNOP@github.com/x/y' }),
    '🔧 bash {"command":"git push https://[已隐藏]@github.com/x/y"}',
  )
  assert.equal(toolProgressLine('bash', 'GITHUB_TOKEN=ghp_0123456789abcdef'), '🔧 bash GITHUB_TOKEN=[已隐藏]')
  // Ordinary prose that merely mentions the word "token" survives.
  assert.equal(toolProgressLine('bash', 'echo token 这个词'), '🔧 bash echo token 这个词')
  assert.equal(toolProgressLine('read', { file_path: '/tmp/a.txt' }), '🔧 read {"file_path":"/tmp/a.txt"}')
})

test('redactText leaves non-secret text alone', () => {
  assert.equal(redactText('普通日志：开始编译'), '普通日志：开始编译')
  assert.equal(redactText('commit abc1234 pushed'), 'commit abc1234 pushed')
  assert.match(redactText('AWS AKIAIOSFODNN7EXAMPLE'), /\[已隐藏\]/)
})

test('slash commands are parsed with chinese aliases', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '', raw: 'help' })
  assert.equal(parseCommand('/新会话')?.name, 'new')
  assert.equal(parseCommand('/model deepseek-account/deepseek-flash')?.args, 'deepseek-account/deepseek-flash')
  assert.equal(parseCommand('/nope')?.name, 'unknown')
  assert.equal(parseCommand('hello'), null)
  assert.equal(parseCommand('/stop now')?.args, 'now')
  // Surrounding whitespace in the chat message is not significant.
  assert.deepEqual(parseCommand('  /stop now '), { name: 'stop', args: 'now', raw: 'stop' })
  assert.match(helpText(normalizeConfig({})), /\/workspace/)
})

test('harness helpers build a message the agent loop accepts', () => {
  const message = createTextUserMessage('hi')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content[0]), true)

  assert.match(newSessionId(), /^session-[0-9a-f-]{36}$/)

  const session = {
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'older' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'newest' }] },
    ],
  }
  assert.equal(latestAssistantText(session), 'newest')
  assert.equal(latestAssistantText({ deriveMessages: () => [] }), '')
  assert.equal(latestAssistantText({ deriveMessages: () => { throw new Error('unloaded') } }), '')

  assert.equal(service({ get: (key) => (key === 'agents' ? 1 : undefined) }, 'agents'), 1)
  assert.equal(service({ get: () => { throw new Error('nope') } }, 'agents'), undefined)
})

test('a partially written state file is replaced, not merged', async () => {
  const temp = await createTempStore()
  try {
    await temp.store.setSession('p2p:a@im.wechat', 'session-1')
    await temp.store.flush()
    const first = JSON.parse(await readFile(temp.store.paths.state, 'utf8'))
    await temp.store.setSession('p2p:a@im.wechat', null)
    await temp.store.flush()
    const second = JSON.parse(await readFile(temp.store.paths.state, 'utf8'))
    assert.deepEqual(first.sessions, { 'p2p:a@im.wechat': 'session-1' })
    assert.deepEqual(second.sessions, {})
  } finally {
    await temp.cleanup()
  }
})

test('temp files never survive a state write', async () => {
  const temp = await createTempStore()
  try {
    await Promise.all([
      temp.store.setSession('p2p:a@im.wechat', 'session-a'),
      temp.store.setSession('p2p:b@im.wechat', 'session-b'),
      temp.store.setCursor('c1'),
    ])
    await temp.store.flush()
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(temp.dir)
    assert.deepEqual(entries.filter((entry) => entry.includes('.tmp')).length, 0)
    assert.ok(entries.includes('state.json'))
    void join
  } finally {
    await temp.cleanup()
  }
})

test('an aborted wait returns immediately, even when the signal is already aborted', async () => {
  // Regression: teardown used to wait out a whole 60-second login retry because a
  // listener added to an already-aborted signal never fires.
  const aborted = new AbortController()
  aborted.abort()
  const started = Date.now()
  await sleep(60_000, aborted.signal)
  assert.ok(Date.now() - started < 100, `aborted wait took ${Date.now() - started}ms`)

  // A signal that aborts mid-wait wakes it too.
  const controller = new AbortController()
  const midway = sleep(60_000, controller.signal)
  setTimeout(() => controller.abort(), 10)
  const tick = Date.now()
  await midway
  assert.ok(Date.now() - tick < 500)

  // And a plain wait still waits.
  const plain = Date.now()
  await sleep(30)
  assert.ok(Date.now() - plain >= 25)
})

test('user-typed paths survive both platforms', () => {
  // Windows users write `~\proj`; POSIX users `~/proj`.
  assert.equal(expandHome('~/x'), path.join(os.homedir(), 'x'))
  assert.match(expandHome('~\\x'), new RegExp(`^${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(expandHome('  ~  '), os.homedir())
  assert.equal(expandHome('/absolute'), '/absolute')

  // A path with spaces arrives quoted from the chat.
  assert.equal(unquote('"C:\\My Projects"'), 'C:\\My Projects')
  assert.equal(unquote("'/tmp/a b'"), '/tmp/a b')
  assert.equal(unquote('  plain  '), 'plain')
})

test('the state-directory guard follows the modelled platform', () => {
  // The guard protects the credential file, so Windows case-insensitivity and
  // separator spelling must not create a way around it.
  assert.equal(isInsideDirectory('C:\\Users\\Me\\.dsh', 'c:\\users\\me\\.dsh\\credentials.json', 'win32'), true)
  assert.equal(isInsideDirectory('C:\\Users\\Me\\.dsh', 'C:/Users/Me/.dsh/state.json', 'win32'), true)
  assert.equal(isInsideDirectory('C:\\a\\.dsh', 'c:\\A\\.dsh', 'win32'), true)
  assert.equal(isInsideDirectory('C:\\a\\.dsh', 'C:\\a\\.dsh-evil\\x', 'win32'), false)
  assert.equal(isInsideDirectory('/a/.dsh', '/a/.dsh/media/x.jpg', 'linux'), true)
  assert.equal(isInsideDirectory('/a/B', '/a/b/x', 'linux'), false)
})

test('transient filesystem failures are retried, real ones are not', async () => {
  let attempts = 0
  const ok = await withRetries(
    async () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('busy')
        error.code = 'EBUSY'
        throw error
      }
      return 'done'
    },
    { delayMs: 1 },
  )
  assert.equal(ok, 'done')
  assert.equal(attempts, 3)

  let fatal = 0
  await assert.rejects(
    () =>
      withRetries(async () => {
        fatal += 1
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }),
    /missing/,
  )
  assert.equal(fatal, 1, 'a non-transient error must not be retried')
})

test('the version line distinguishes running from installed', () => {
  // The confusion this prevents: the profile may hold a newer build while the
  // running process still executes the one it imported at boot.
  assert.match(describeVersion({ version: '0.1.24', installedVersion: '0.1.24' }), /^0\.1\.24/)
  assert.match(describeVersion({ version: '0.1.23', installedVersion: '0.1.24' }), /磁盘已装 0\.1\.24，重启/)
  assert.match(describeVersion({ version: '0.1.24', installedVersion: '0.1.24', startedAt: '2026-10-02T00:10:00.000Z' }), /启动于/)
  assert.match(describeVersion({ version: null, installedVersion: '0.1.24' }), /没有启动记录/)
  assert.match(describeVersion({ version: null, installedVersion: null }), /未知/)
})

test('the restart job is a one-shot LaunchAgent on internal paths only', async () => {
  const { buildPlist, internalScriptPath, plistPath, xmlEscape } = await import('../scripts/schedule-restart.mjs')

  const xml = buildPlist({ scriptPath: '/Users/x/Library/Application Support/dsh-wechat/restart-dsh.sh', delaySeconds: 10, force: true })
  // One-shot semantics: launchd must not relaunch it (that produced a restart loop).
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(xml, /<key>KeepAlive<\/key><false\/>/)
  assert.match(xml, /<string>com\.zgat\.dsh-wechat-restart<\/string>/)
  assert.match(xml, /--delay 10/)
  // The flag must be an assignment prefix, not a standalone statement, or it never
  // reaches the script and its guard skips the restart (this shipped once).
  assert.match(xml, /DSH_RESTART_FORCE=1 &quot;|DSH_RESTART_FORCE=1 "/)
  assert.ok(!/DSH_RESTART_FORCE=1;/.test(xml), 'a separate statement would not export the flag')
  // Shell metacharacters must be XML-escaped or launchd refuses the file.
  assert.equal(xmlEscape('a && b > c'), 'a &amp;&amp; b &gt; c')
  assert.match(xml, /2&gt;\/dev\/null/)
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(xml), 'no raw ampersands')
  // Cleanup has to precede bootout: unloading kills the job's process tree.
  assert.ok(xml.indexOf('rm -f') < xml.indexOf('bootout'), 'remove the plist before unloading')

  // The helper is copied off the repository: launchd cannot read an external volume.
  assert.ok(!internalScriptPath().startsWith('/Volumes/'), `helper must live on the internal disk: ${internalScriptPath()}`)
  assert.ok(internalScriptPath().startsWith(os.homedir()), 'helper lives under HOME')
  assert.match(plistPath(), /Library\/LaunchAgents\/com\.zgat\.dsh-wechat-restart\.plist$/)
})

test('messageText reads both committed shapes', () => {
  // Blocks are what the host commits; a bare string must not silently become "".
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(messageText({ content: 'plain' }), 'plain')
  assert.equal(messageText(undefined), '')
})

test('verifyInstalled spots a tarball rebuilt under the same version', async () => {
  // pnpm treats a file: dependency whose version is unchanged as already installed, so
  // an upgrade can silently keep the old files. The fingerprint is what catches it.
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { verifyInstalled } = await import('../scripts/upgrade-install.mjs')
  const exec = promisify(execFile)
  const run = async (cmd, args, options) => {
    const { stdout } = await exec(cmd, args, options)
    return { stdout }
  }
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-wechat-fingerprint-'))
  try {
    const pkg = path.join(root, 'pkg', 'package')
    await mkdir(path.join(pkg, 'lib'), { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), '{"name":"dsh-wechat","version":"1.0.0"}\n')
    await writeFile(path.join(pkg, 'lib/bridge.js'), 'export const value = 1\n')
    await writeFile(path.join(pkg, 'lib/approval.js'), 'export const value = 1\n')
    await writeFile(path.join(pkg, 'lib/index.js'), 'export const value = 1\n')
    const tarball = path.join(root, 'dsh-wechat-1.0.0.tgz')
    await exec('tar', ['-czf', tarball, '-C', path.join(root, 'pkg'), 'package'])

    const profileDir = path.join(root, 'profile')
    const installed = path.join(profileDir, 'node_modules/dsh-wechat')
    await mkdir(path.join(installed, 'lib'), { recursive: true })
    for (const relative of ['package.json', 'lib/bridge.js', 'lib/approval.js', 'lib/index.js']) {
      await writeFile(path.join(installed, relative), await (await import('node:fs/promises')).readFile(path.join(pkg, relative)))
    }
    assert.equal(await verifyInstalled({ profileDir, tarball, run }), false, 'identical copy is not stale')

    await writeFile(path.join(installed, 'lib/bridge.js'), 'export const value = 2\n')
    assert.equal(await verifyInstalled({ profileDir, tarball, run }), true, 'changed file is stale')

    await rm(installed, { recursive: true, force: true })
    assert.equal(await verifyInstalled({ profileDir, tarball, run }), true, 'missing install is stale')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the restart job writes one log and is scheduled through a single label', async () => {
  const { buildPlist, plistPath } = await import('../scripts/schedule-restart.mjs')
  const plist = buildPlist({ scriptPath: '/tmp/restart-dsh.sh', delaySeconds: 10, force: true })
  assert.match(plist, /StandardOutPath/, 'stdout goes to a file')
  assert.match(plist, /StandardErrorPath/, 'stderr goes to a file')
  assert.match(plist, /DSH_RESTART_LOG="\$HOME\/dsh-wechat-restart.log"/, 'the script logs where the job logs')
  assert.match(plist, /DSH_RESTART_FORCE=1 "\/tmp\/restart-dsh.sh" --delay 10/, 'force stays an assignment prefix')
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/, 'one-shot: never respawn')
  assert.ok(plistPath().endsWith('com.zgat.dsh-wechat-restart.plist'))
})

test('upgrading does not restart DSH unless asked', async () => {
  // The install used to schedule a restart by default; two installs in a row then meant
  // two restarts minutes apart. Restarting is now an explicit choice.
  const { parseArgs } = await import('../scripts/upgrade-args.mjs')
  const plain = parseArgs(['--via-cli'])
  assert.equal(plain.restart, false, 'installing alone never restarts')
  assert.equal(plain.restartDelay, 10)

  assert.equal(parseArgs(['--via-cli', '--restart']).restart, true, '--restart opts in')
  assert.equal(parseArgs(['--via-cli', '--no-restart']).restart, false, '--no-restart states the default')
  const delayed = parseArgs(['--via-cli', '--restart-delay', '30'])
  assert.equal(delayed.restart, true, 'a deadline implies the restart')
  assert.equal(delayed.restartDelay, 30)
  assert.equal(parseArgs(['--via-cli', '--restart', '--no-restart']).restart, false, 'the last flag wins')

  assert.equal(parseArgs(['--check']).mode, 'check')
  assert.equal(parseArgs(['--via-gui', '--open', '--profile', 'web']).profile, 'web')
  assert.throws(() => parseArgs(['--via-cli', '--nope']), /unknown argument/)
  assert.throws(() => parseArgs([]), /pass --via-gui/)
})

test('numeric config fields reject values that only look numeric', () => {
  // `Number([])` is 0 and `Number(true)` is 1: coercing those turned a typo into a
  // silently different behaviour (a disabled cap, a one-character answer).
  assert.throws(() => normalizeConfig({ maxAnswerChars: [] }), /must be a number/)
  assert.throws(() => normalizeConfig({ maxAnswerChars: true }), /must be a number/)
  assert.throws(() => normalizeConfig({ chunkChars: [1800] }), /must be a number/)
  assert.throws(() => normalizeConfig({ sendRetryMs: [Number.NaN] }), /finite/)
  assert.throws(() => normalizeConfig({ sendRetryMs: [Number.POSITIVE_INFINITY] }), /finite/)
  assert.equal(normalizeConfig({ maxAnswerChars: '0' }).maxAnswerChars, 0, 'numeric strings still work')
})

test('withRetries survives a nonsensical attempt count', async () => {
  const { withRetries } = await import('../lib/retry.js')
  let calls = 0
  const result = await withRetries(async () => {
    calls += 1
    return 'ok'
  }, { attempts: Number.NaN })
  assert.equal(result, 'ok')
  assert.equal(calls, 1, 'NaN attempts falls back to the default policy instead of skipping the loop')
})

test('/status shows how long ago the last error happened', async () => {
  const { createCommands } = await import('../lib/commands.js')
  const commands = createCommands({
    describeConversation: async () => ({
      connected: true,
      sessionId: 's1',
      workspace: '/tmp',
      model: 'm',
      agentPreset: 'standard',
      permission: 'workspace-write',
      following: false,
      version: '0.1.35',
      installedVersion: '0.1.35',
      runningTurns: 0,
      pendingInteractions: 0,
      stats: { inbound: 1, outbound: 2, lastError: { at: new Date(Date.now() - 3 * 3600_000).toISOString(), message: 'ret=-2' } },
    }),
  })
  const text = await commands.status([], { conversationKey: 'p2p:u', isOwner: true })
  assert.match(text, /最近错误（3 小时前）：ret=-2/)
})
