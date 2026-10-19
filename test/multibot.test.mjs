/**
 * Multi-bot behaviour: one plugin instance, several bot accounts.
 *
 * Two properties matter most and both fail silently when broken — a v1 state file must
 * migrate without losing session bindings, and two bots must never share a conversation,
 * a reply token or a transport.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WechatStore, botOfConversation, withBot } from '../lib/store.js'
import { checkAccess } from '../lib/config.js'
import { createLogger } from '../lib/log.js'
import { createTempStore } from './helpers.mjs'

const logger = createLogger('silent')

test('withBot namespaces a key once and leaves group keys intact', () => {
  assert.equal(withBot('p2p:u@im.wechat', 'bot@im.bot'), 'p2p:bot@im.bot:u@im.wechat')
  assert.equal(withBot('group:g1', 'bot@im.bot'), 'group:bot@im.bot:g1')
  // Idempotent: a key that already names a bot keeps that bot.
  assert.equal(withBot('p2p:bot@im.bot:u@im.wechat', 'other@im.bot'), 'p2p:bot@im.bot:u@im.wechat')
  assert.equal(botOfConversation('p2p:bot@im.bot:u@im.wechat'), 'bot@im.bot')
  assert.equal(botOfConversation('p2p:u@im.wechat'), null, 'legacy keys name no bot')
})

test('a v1 single-bot state migrates into per-bot buckets and keeps its bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-migrate-'))
  try {
    const dir = join(root, 'state')
    await mkdir(dir, { recursive: true })
    // The shape a 0.1.x install writes: one credential at the top level.
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({ version: 1, botToken: 'tok', botId: 'bot@im.bot', baseUrl: 'https://x', ownerUserId: 'u@im.wechat' }),
    )
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        cursor: 'cursor-1',
        sessions: { 'p2p:u@im.wechat': 'session-1' },
        seenMessageIds: ['id:m-1'],
        contextTokens: { 'u@im.wechat': { token: 'tok-1', at: 1 } },
        welcomed: { 'p2p:u@im.wechat': 'yes' },
        outbound: [],
        stats: { inbound: 0, outbound: 0 },
      }),
    )

    const store = new WechatStore({ config: { stateDir: dir }, logger })
    await store.load()

    assert.deepEqual(store.botIds, ['bot@im.bot'])
    assert.equal(store.cursorFor('bot@im.bot'), 'cursor-1')
    assert.equal(store.contextTokenFor('u@im.wechat', 'bot@im.bot'), 'tok-1')
    // Conversation keys gain the bot id, so the existing session binding survives.
    assert.equal(store.sessionFor('p2p:bot@im.bot:u@im.wechat'), 'session-1')
    assert.equal(store.sessionFor('p2p:u@im.wechat'), undefined)
    assert.equal(store.state.welcomed['p2p:bot@im.bot:u@im.wechat'], 'yes')
    assert.equal(store.state.version, 2)
    // The v1 fields are consumed, not duplicated.
    assert.equal(store.state.cursor, '')

    // Dedupe moved with the bot.
    assert.equal(store.hasSeen({ message_id: 'm-1' }, 'bot@im.bot'), true, 'the migrated dedupe window is per bot')
    assert.equal(store.hasSeen({ message_id: 'm-1' }, 'other@im.bot'), false)

    // The rewrite is durable and the original bytes were kept aside before it.
    await store.flush()
    const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(persisted.version, 2)
    assert.ok(persisted.bots['bot@im.bot'], 'the migrated buckets reached the disk')
    const backups = (await readdir(dir)).filter((name) => name.includes('.v1-backup-'))
    assert.ok(backups.length >= 1, 'a pre-migration copy was kept')
    const stateBackup = backups.find((name) => name.startsWith('state.json'))
    assert.ok(stateBackup, 'the state file has a backup')
    const backup = JSON.parse(await readFile(join(dir, stateBackup), 'utf8'))
    assert.equal(backup.cursor, 'cursor-1', 'the backup holds the original v1 bytes')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('two bots keep separate cursors, reply tokens and dedupe windows', async () => {
  const temp = await createTempStore()
  try {
    await temp.store.saveCredentials('a@im.bot', { botToken: 'tok-a', botId: 'a@im.bot' })
    await temp.store.saveCredentials('b@im.bot', { botToken: 'tok-b', botId: 'b@im.bot' })
    assert.deepEqual(temp.store.botIds.sort(), ['a@im.bot', 'b@im.bot'])

    await temp.store.setCursor('cursor-a', 'a@im.bot')
    await temp.store.setCursor('cursor-b', 'b@im.bot')
    assert.equal(temp.store.cursorFor('a@im.bot'), 'cursor-a')
    assert.equal(temp.store.cursorFor('b@im.bot'), 'cursor-b')

    temp.store.rememberContextToken('u@im.wechat', 'token-a', 'a@im.bot')
    temp.store.rememberContextToken('u@im.wechat', 'token-b', 'b@im.bot')
    assert.equal(temp.store.contextTokenFor('u@im.wechat', 'a@im.bot'), 'token-a')
    assert.equal(temp.store.contextTokenFor('u@im.wechat', 'b@im.bot'), 'token-b')

    // The same message id arriving at both bots must be deduped per bot, not globally.
    assert.equal(temp.store.hasSeen({ message_id: 'm-1' }, 'a@im.bot'), false)
    assert.equal(temp.store.hasSeen({ message_id: 'm-1' }, 'a@im.bot'), true)
    assert.equal(temp.store.hasSeen({ message_id: 'm-1' }, 'b@im.bot'), false)

    // Removing one bot leaves the other's state and file entry intact.
    await temp.store.clearCredentials('a@im.bot')
    assert.deepEqual(temp.store.botIds, ['b@im.bot'])
    assert.equal(temp.store.cursorFor('b@im.bot'), 'cursor-b')
    assert.equal(temp.store.contextTokenFor('u@im.wechat', 'b@im.bot'), 'token-b')
    const onDisk = JSON.parse(await readFile(temp.store.paths.credentials, 'utf8'))
    assert.deepEqual(Object.keys(onDisk.bots), ['b@im.bot'])
  } finally {
    await temp.cleanup()
  }
})

test('the per-bot state file survives a reload', async () => {
  const temp = await createTempStore()
  try {
    await temp.store.saveCredentials('a@im.bot', { botToken: 'tok-a', botId: 'a@im.bot' })
    await temp.store.saveCredentials('b@im.bot', { botToken: 'tok-b', botId: 'b@im.bot' })
    await temp.store.setCursor('cursor-b', 'b@im.bot')
    temp.store.rememberContextToken('u@im.wechat', 'token-b', 'b@im.bot')
    temp.store.persistTokens('b@im.bot')
    await temp.store.flush()

    const reloaded = new WechatStore({ config: temp.config, logger })
    await reloaded.load()
    assert.deepEqual(reloaded.botIds.sort(), ['a@im.bot', 'b@im.bot'])
    assert.equal(reloaded.cursorFor('b@im.bot'), 'cursor-b')
    assert.equal(reloaded.contextTokenFor('u@im.wechat', 'b@im.bot'), 'token-b')
  } finally {
    await temp.cleanup()
  }
})

test('a v1 credential file is rewritten as a v2 file on load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-cred-'))
  try {
    const dir = join(root, 'state')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({ version: 1, botToken: 'tok', botId: 'bot@im.bot', baseUrl: 'https://x', source: 'file' }),
    )
    const store = new WechatStore({ config: { stateDir: dir }, logger })
    await store.load()
    await store.flush()

    const rewritten = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'))
    assert.equal(rewritten.version, 2)
    assert.equal(rewritten.bots['bot@im.bot'].botToken, 'tok')
    assert.equal(rewritten.botToken, undefined, 'the v1 top-level token is gone')

    // A v2 file is left alone: the rewrite happens once.
    const again = new WechatStore({ config: { stateDir: dir }, logger })
    await again.load()
    await again.flush()
    const unchanged = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'))
    assert.deepEqual(unchanged, rewritten)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('the owner of a bot is the account that scanned it, not the first bot\'s owner', async () => {
  const temp = await createTempStore({ accessPolicy: 'allowlist' })
  try {
    await temp.store.saveCredentials('a@im.bot', { botToken: 'ta', botId: 'a@im.bot', ownerUserId: 'owner-a@im.wechat' })
    await temp.store.saveCredentials('b@im.bot', { botToken: 'tb', botId: 'b@im.bot', ownerUserId: 'owner-b@im.wechat' })

    // The per-bot override is what the bridge hands checkAccess.
    const ownerA = { ownerUserId: temp.store.credentialsFor('a@im.bot').ownerUserId }
    const ownerB = { ownerUserId: temp.store.credentialsFor('b@im.bot').ownerUserId }
    assert.equal(checkAccess(temp.config, 'owner-b@im.wechat', ownerB).allowed, true, 'bot B trusts its own owner')
    assert.equal(checkAccess(temp.config, 'owner-b@im.wechat', ownerA).allowed, false, 'and not through bot A')
    assert.equal(checkAccess(temp.config, 'stranger@im.wechat', ownerB).allowed, false)
    // With no per-bot information the configured owner still works (single-bot behaviour).
    assert.equal(checkAccess({ ...temp.config, ownerUserId: 'x@im.wechat' }, 'x@im.wechat').allowed, true)
  } finally {
    await temp.cleanup()
  }
})
