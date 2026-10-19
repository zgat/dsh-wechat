/**
 * Durable state: the bot credential file, the long-poll cursor, the
 * conversation→session map, seen-message ids and cached `context_token`s.
 *
 * Both files live under `$DSH_HOME/integrations/dsh-wechat` (override with
 * `stateDir`) and are written atomically with mode 0600, because the credential
 * file holds a bearer token that is enough to send messages as the bot.
 *
 * @module dsh-wechat/store
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { withRetries } from './retry.js'

/** Bounded list sizes; state files must not grow without limit. */
const LIMITS = { seenMessageIds: 1000, outbound: 200, contextTokens: 200 }

/** @returns {string} the DSH home directory (`$DSH_HOME` or `~/.dsh`). */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * Resolve every path this plugin writes to.
 * @param {object} config - normalized configuration.
 * @returns {{ root: string, credentials: string, state: string, media: string, qrText: string, qrSvg: string }}
 */
export function resolvePaths(config) {
  const root = config.stateDir ? path.resolve(config.stateDir) : path.join(dshHome(), 'integrations', 'dsh-wechat')
  return {
    root,
    credentials: path.join(root, 'credentials.json'),
    state: path.join(root, 'state.json'),
    media: config.media?.dir ? path.resolve(config.media.dir) : path.join(root, 'media'),
    qrText: path.join(root, 'login-qrcode.txt'),
    qrSvg: path.join(root, 'login-qrcode.svg'),
    loginUrl: path.join(root, 'login-page.url'),
  }
}

/** Write a JSON file atomically (temp file in the same directory, then rename). */
async function writeJsonAtomic(filePath, value, mode = 0o600) {
  // The directory holds credentials: 0700 keeps its listing private as well.
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await chmod(temporary, mode)
  try {
    // Windows refuses the replace while another process holds the target open.
    await withRetries(() => rename(temporary, filePath))
  } catch (error) {
    // A leftover `${file}.<pid>.<ts>.tmp` keeps a full copy of the content on disk — for
    // credentials.json that is a live token surviving `/logout`.
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await chmod(filePath, mode)
}

/**
 * Read one JSON state file.
 *
 * A missing file is normal (first boot). A *corrupt* file must not brick the
 * plugin — the channel would never start — so it is moved aside for diagnosis
 * and the caller continues from empty state.
 * @param {string} filePath - file to read.
 * @param {{ warn?: Function }} [logger] - diagnostics sink.
 * @returns {Promise<object|null>} parsed content, or null when absent or quarantined.
 */
async function readJson(filePath, logger) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    // The file is there but unreadable (mode 000, EIO, EMFILE, another owner…). Returning
    // null here would let the caller "continue from empty state" and then overwrite the
    // real file with that empty snapshot. Move it aside instead; if even that fails, throw
    // so nothing is clobbered.
    const quarantine = `${filePath}.unreadable-${Date.now()}`
    try {
      await rename(filePath, quarantine)
      logger?.warn?.(
        `could not read ${filePath} (${error?.message ?? error}); moved it to ${quarantine} and continuing from empty state`,
      )
      return null
    } catch (renameError) {
      throw new Error(
        `cannot read ${filePath} (${error?.message ?? error}) and cannot move it aside (${renameError?.message ?? renameError}); refusing to continue with empty state`,
      )
    }
  }
  if (text.trim().length === 0) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    const quarantine = `${filePath}.corrupt-${Date.now()}`
    try {
      await rename(filePath, quarantine)
      logger?.warn?.(`${filePath} is not valid JSON; moved it to ${quarantine} and continuing from empty state`)
    } catch (renameError) {
      logger?.warn?.(`${filePath} is not valid JSON (${error?.message ?? error}) and could not be moved aside: ${renameError?.message ?? renameError}`)
    }
    return null
  }
}

/** One bot account's credential, as persisted. */
/**
 * Insert a bot id into a conversation key: `p2p:<user>` becomes `p2p:<bot>:<user>`.
 *
 * Two bots must be able to talk to the same person without sharing a session, follow
 * toggle or pending switch, so the bot is part of the key. Keys that already carry three
 * segments are returned unchanged (the function is idempotent).
 * @param {string} conversationKey - a `p2p:` or `group:` key.
 * @param {string} botId - bot to namespace it with.
 * @returns {string} the namespaced key.
 */
export function withBot(conversationKey, botId) {
  if (!botId || typeof conversationKey !== 'string') return conversationKey
  const parts = conversationKey.split(':')
  if (parts[0] !== 'p2p' && parts[0] !== 'group') return conversationKey
  if (parts.length >= 3) return conversationKey
  return `${parts[0]}:${botId}:${parts.slice(1).join(':')}`
}

/**
 * The bot id embedded in a conversation key.
 * @param {string} conversationKey - a namespaced or legacy key.
 * @returns {string|null} the bot id, or null for a legacy key without one.
 */
export function botOfConversation(conversationKey) {
  if (typeof conversationKey !== 'string') return null
  const parts = conversationKey.split(':')
  if (parts[0] !== 'p2p' && parts[0] !== 'group') return null
  return parts.length >= 3 ? parts[1] : null
}

function emptyState() {
  return {
    version: 2,
    // Per-bot runtime state: one long-poll cursor, dedupe window and reply-token cache each.
    // The top-level cursor/seenMessageIds/contextTokens are the v1 shape, still read while
    // migrating and emptied afterwards.
    bots: {},
    cursor: '',
    sessions: {},
    seenMessageIds: [],
    contextTokens: {},
    outbound: [],
    stats: { inbound: 0, outbound: 0, lastInboundAt: null, lastOutboundAt: null, lastError: null },
  }
}

/**
 * Credential + conversation state store for one bot account.
 */
export class WechatStore {
  /**
   * @param {object} options - store options.
   * @param {object} options.config - normalized configuration.
   * @param {{ info: Function, warn: Function, debug: Function, error: Function }} options.logger
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.paths = resolvePaths(options.config)
    this.state = emptyState()
  }

  /** @type {{ version: number, bots: Record<string, object> }} */
  #credentials = { version: 2, bots: {} }

  // botId → Set / Map: dedupe windows and reply tokens belong to one bot each.
  #seen = new Map()
  #tokens = new Map()
  /** Serializes file writes so concurrent saves cannot interleave temp files. */
  #writes = Promise.resolve()

  /** Queue one file write behind every earlier write. */
  #enqueueWrite(task) {
    const next = this.#writes.then(task, task)
    this.#writes = next.catch(() => {})
    return next
  }

  /** Wait for every queued write to settle (used by tests and shutdown). */
  async flush() {
    await this.#writes.catch(() => {})
  }

  /** Load both files from disk, tolerating a missing or corrupt one. */
  async load() {
    const [credentials, state] = await Promise.all([
      readJson(this.paths.credentials, this.logger),
      readJson(this.paths.state, this.logger),
    ])
    this.#credentials = this.#normalizeCredentials(credentials)
    this.state = { ...emptyState(), ...(state ?? {}) }
    // A hand-edited or foreign state file can carry the right keys with the wrong shapes
    // (`"stats": null`, `"sessions": []`). Left alone, `stats` throws on the next inbound
    // message — which kills the poll loop — and `sessions` silently drops every binding
    // because JSON.stringify ignores array properties. Normalize every field we touch.
    this.#sanitizeState()
    this.#migrateSingleBotState()
    for (const botId of this.botIds) {
      const bot = this.#botState(botId)
      this.#seen.set(botId, new Set(bot.seenMessageIds))
      this.#tokens.set(botId, new Map(Object.entries(bot.contextTokens)))
    }
    if (this.botIds.length === 0) {
      this.#seen.set('', new Set(this.state.seenMessageIds ?? []))
      this.#tokens.set('', new Map(Object.entries(this.state.contextTokens ?? {})))
    }
    this.logger?.debug?.(`state loaded from ${this.paths.root} (bots: ${this.botIds.join(', ') || 'none'})`)
  }

  /** Force every persisted field into the shape the rest of the code assumes. */
  #sanitizeState() {
    const state = this.state
    state.seenMessageIds = Array.isArray(state.seenMessageIds) ? state.seenMessageIds : []
    state.outbound = Array.isArray(state.outbound) ? state.outbound : []
    state.boots = Array.isArray(state.boots) ? state.boots : []
    state.cursor = typeof state.cursor === 'string' ? state.cursor : ''
    for (const key of ['sessions', 'follow', 'contextTokens', 'welcomed', 'pendingSwitch']) {
      const value = state[key]
      state[key] = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }
    const stats = state.stats && typeof state.stats === 'object' && !Array.isArray(state.stats) ? state.stats : {}
    state.stats = {
      inbound: Number.isFinite(stats.inbound) ? stats.inbound : 0,
      outbound: Number.isFinite(stats.outbound) ? stats.outbound : 0,
      ...(stats.lastInboundAt ? { lastInboundAt: stats.lastInboundAt } : {}),
      ...(stats.lastOutboundAt ? { lastOutboundAt: stats.lastOutboundAt } : {}),
      ...(stats.lastError ? { lastError: stats.lastError } : {}),
    }
    if (state.pendingSwitch && Object.keys(state.pendingSwitch).length === 0) state.pendingSwitch = null
  }

  #normalizeCredentials(raw) {
    const bots = {}
    const absorb = (id, record) => {
      if (!record || typeof record !== 'object') return
      if (typeof record.botToken !== 'string' || record.botToken.length === 0) return
      const botId = String(record.botId ?? id ?? 'default')
      bots[botId] = { version: 1, ...record, botId }
    }
    if (raw && typeof raw === 'object' && raw.bots && typeof raw.bots === 'object' && !Array.isArray(raw.bots)) {
      for (const [id, record] of Object.entries(raw.bots)) absorb(id, record)
    } else if (raw && typeof raw === 'object') {
      // v1: a single credential at the top level.
      absorb(raw.botId ?? 'default', raw)
    }
    const envToken = process.env.DSH_WECHAT_BOT_TOKEN
    if (envToken) {
      const botId = process.env.DSH_WECHAT_BOT_ID ?? Object.keys(bots)[0] ?? 'env'
      bots[botId] = {
        version: 1,
        botToken: envToken,
        baseUrl: process.env.DSH_WECHAT_BASE_URL || undefined,
        botId,
        ownerUserId: process.env.DSH_WECHAT_USER_ID ?? null,
        source: 'env',
        savedAt: new Date().toISOString(),
      }
    }
    return { version: 2, bots }
  }

  // -------------------------------------------------------------------------
  // Bots: one plugin instance may hold several bot accounts
  // -------------------------------------------------------------------------

  /** @returns {string[]} bot ids with a usable credential. */
  get botIds() {
    return Object.keys(this.#credentials?.bots ?? {})
  }

  /** @returns {string|null} the bot used when a call site does not name one. */
  get primaryBotId() {
    return this.botIds[0] ?? null
  }

  /**
   * @param {string} botId - bot id.
   * @returns {{ botToken: string, botId: string, baseUrl?: string, ownerUserId?: string, source?: string }|null}
   *   that bot's credential, or null.
   */
  credentialsFor(botId) {
    if (!botId) return null
    return this.#credentials?.bots?.[botId] ?? null
  }

  /** @returns {object|null} the primary bot's credential (compatibility accessor). */
  get credentials() {
    return this.credentialsFor(this.primaryBotId)
  }

  /** @returns {boolean} whether at least one bot has a usable credential. */
  get loggedIn() {
    return this.botIds.length > 0
  }

  /** @returns {string|null} the primary bot's id (compatibility accessor). */
  get botId() {
    return this.primaryBotId
  }

  /**
   * One bot's runtime bucket, created on demand.
   * @param {string} [botId] - bot id; defaults to the primary bot.
   * @returns {{cursor: string, seenMessageIds: string[], contextTokens: object, connected: boolean}|null}
   *   the bucket, or null when no bot is bound.
   */
  #botState(botId) {
    const id = botId || this.primaryBotId
    if (!id) return null
    const state = this.state
    state.bots = state.bots && typeof state.bots === 'object' && !Array.isArray(state.bots) ? state.bots : {}
    const existing = state.bots[id]
    const entry = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
    entry.cursor = typeof entry.cursor === 'string' ? entry.cursor : ''
    entry.seenMessageIds = Array.isArray(entry.seenMessageIds) ? entry.seenMessageIds : []
    entry.contextTokens = entry.contextTokens && typeof entry.contextTokens === 'object' && !Array.isArray(entry.contextTokens)
      ? entry.contextTokens
      : {}
    entry.connected = entry.connected === true
    state.bots[id] = entry
    return entry
  }

  /**
   * Move a v1 single-bot state file into per-bot buckets.
   *
   * Conversation keys gain the bot id as their second segment (`p2p:<user>` becomes
   * `p2p:<bot>:<user>`), so every map keyed by a conversation is rewritten once. Runs only
   * when a credential exists to name the bot; a fresh install simply starts at v2.
   * @returns {void}
   */
  #migrateSingleBotState() {
    const state = this.state
    const migrated = state.version === 2 && state.bots && Object.keys(state.bots).length > 0
    if (migrated) return
    const botId = this.primaryBotId
    if (!botId) {
      state.version = 2
      return
    }
    const hasLegacy = (state.cursor ?? '') !== ''
      || (Array.isArray(state.seenMessageIds) && state.seenMessageIds.length > 0)
      || (state.contextTokens && Object.keys(state.contextTokens).length > 0)
    if (hasLegacy) {
      const bot = this.#botState(botId)
      bot.cursor = state.cursor ?? ''
      bot.seenMessageIds = [...(state.seenMessageIds ?? [])]
      bot.contextTokens = { ...(state.contextTokens ?? {}) }
      for (const map of ['sessions', 'follow', 'pendingSwitch', 'models', 'reasoning', 'welcomed']) {
        const value = state[map]
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const rekeyed = {}
          for (const [key, entry] of Object.entries(value)) rekeyed[withBot(key, botId)] = entry
          state[map] = rekeyed
        }
      }
      state.cursor = ''
      state.seenMessageIds = []
      state.contextTokens = {}
      this.logger?.info?.(`migrated the v1 state of bot ${botId} into per-bot buckets`)
    }
    state.version = 2
  }

  /**
   * Persist one bot's credential (QR login result or env override).
   * @param {string|object} botIdOrCredentials - bot id, or the credential carrying `botId`.
   * @param {object} [maybeCredentials] - the credential when the first argument is an id.
   * @returns {Promise<object|null>} the stored credential.
   */
  async saveCredentials(botIdOrCredentials, maybeCredentials) {
    const credentials = maybeCredentials ?? botIdOrCredentials ?? {}
    const requested = maybeCredentials ? botIdOrCredentials : null
    const botId = String(
      requested ?? credentials.botId ?? this.primaryBotId ?? 'default',
    )
    const source = credentials.source ?? this.credentialsFor(botId)?.source ?? 'file'
    const next = { version: 2, bots: { ...(this.#credentials?.bots ?? {}) } }
    next.bots[botId] = { version: 1, savedAt: new Date().toISOString(), ...credentials, botId, source }
    this.#credentials = next
    this.#botState(botId)
    this.#seen.set(botId, new Set(this.#seen.get(botId) ?? []))
    if (!this.#tokens.has(botId)) this.#tokens.set(botId, new Map())
    // An env-provided credential is authoritative and must never be written to disk.
    if (source !== 'env') await this.#enqueueWrite(() => writeJsonAtomic(this.paths.credentials, next))
    this.logger?.info?.(`credentials for bot ${botId} saved${source === 'env' ? ' (env, not written)' : ` to ${this.paths.credentials}`}`)
    return this.credentialsFor(botId)
  }

  /**
   * Forget one bot (or every bot) and that bot's cursor/dedupe/reply-token state.
   * @param {string} [botId] - bot to forget; defaults to the primary bot.
   * @param {{ keepCursor?: boolean, all?: boolean }} [options] - retention switches.
   * @returns {Promise<void>}
   */
  async clearCredentials(botId, { keepCursor = false, all = false } = {}) {
    const ids = all ? this.botIds : [botId ?? this.primaryBotId].filter(Boolean)
    const bots = { ...(this.#credentials?.bots ?? {}) }
    for (const id of ids) {
      delete bots[id]
      const bot = this.#botState(id)
      if (bot) {
        bot.seenMessageIds = []
        bot.contextTokens = {}
        bot.connected = false
        if (!keepCursor) bot.cursor = ''
      }
      this.#seen.set(id, new Set())
      this.#tokens.set(id, new Map())
      // A fresh binding is a fresh introduction: greet that bot's chats again.
      const welcomed = this.state.welcomed
      if (welcomed && typeof welcomed === 'object') {
        for (const key of Object.keys(welcomed)) if (key.split(':')[1] === id) delete welcomed[key]
      }
    }
    this.#credentials = { version: 2, bots }
    await this.#enqueueWrite(async () => {
      if (this.botIds.length === 0) await withRetries(() => rm(this.paths.credentials, { force: true }))
      else await writeJsonAtomic(this.paths.credentials, this.#credentials)
      await this.#clearCredentialTemps()
    })
    await this.saveState()
  }

  /** Remove credential temp copies left behind by a failed atomic write. */
  async #clearCredentialTemps() {
    const dir = path.dirname(this.paths.credentials)
    const base = path.basename(this.paths.credentials)
    const entries = await readdir(dir).catch(() => [])
    await Promise.all(
      entries
        // Temp copies from a failed write *and* the `.unreadable-*` copy moved aside
        // when the file could not be read: both can hold a live bot token.
        .filter((name) => name.startsWith(`${base}.`) && (name.endsWith('.tmp') || name.includes('.unreadable-')))
        .map((name) => rm(path.join(dir, name), { force: true }).catch(() => {})),
    )
  }

  /** Persist conversation state (best effort; never throws into the message path). */
  async saveState() {
    const snapshot = this.state
    try {
      await this.#enqueueWrite(() => writeJsonAtomic(this.paths.state, snapshot))
    } catch (error) {
      this.logger?.warn?.('failed to persist state:', error?.message ?? error)
    }
  }

  /** @returns {string} the primary bot's long-poll cursor. */
  get cursor() {
    const bot = this.#botState(this.primaryBotId)
    return bot ? bot.cursor : (this.state.cursor ?? '')
  }

  /**
   * @param {string} botId - bot whose cursor to read.
   * @returns {string} that bot's long-poll cursor.
   */
  cursorFor(botId) {
    return this.#botState(botId)?.cursor ?? ''
  }

  /**
   * Record a bot's new long-poll cursor and persist it.
   * @param {string} cursor - the gateway cursor.
   * @param {string} [botId] - bot that produced it (defaults to the primary bot).
   * @returns {Promise<void>}
   */
  async setCursor(cursor, botId) {
    if (typeof cursor !== 'string') return
    const bot = this.#botState(botId)
    // No bot bound (a fresh install, or a test holding pre-login state): keep the v1
    // top-level field, which migration will move into the first bot's bucket later.
    const target = bot ?? this.state
    if (cursor === (bot ? bot.cursor : this.state.cursor)) return
    if (bot) bot.cursor = cursor
    else this.state.cursor = cursor
    await this.saveState()
  }

  /**
   * @param {object} message - inbound message envelope.
   * @param {string} [botId] - bot that received it (defaults to the primary bot).
   * @returns {boolean} true when this bot already processed this delivery.
   */
  hasSeen(message, botId) {
    const key = messageKey(message)
    if (!key) return false
    const id = botId ?? this.primaryBotId
    const bot = this.#botState(id)
    // Without a bound bot the v1 top-level window is the only place to keep this.
    const bucket = bot ?? { seenMessageIds: this.state.seenMessageIds, legacy: true }
    const seenKey = bot ? id : ''
    const seen = this.#seen.get(seenKey) ?? new Set(bucket.seenMessageIds)
    this.#seen.set(seenKey, seen)
    if (seen.has(key)) return true
    seen.add(key)
    bucket.seenMessageIds.push(key)
    while (bucket.seenMessageIds.length > LIMITS.seenMessageIds) {
      const dropped = bucket.seenMessageIds.shift()
      if (dropped) seen.delete(dropped)
    }
    if (!bot) this.state.seenMessageIds = bucket.seenMessageIds
    return false
  }

  /** @returns {string|undefined} the DSH session bound to a conversation key. */
  sessionFor(conversationKey) {
    return this.state.sessions[conversationKey]
  }

  /**
   * Which WeChat conversation currently holds a session.
   *
   * Read from the persisted binding table rather than an in-memory index: the guard
   * against two chats sharing one conversation must survive restarts and switches.
   * @param {string} sessionId - DSH session id.
   * @returns {string|null} the conversation key, if any.
   */
  conversationForSession(sessionId) {
    if (!sessionId) return null
    for (const [key, value] of Object.entries(this.state.sessions ?? {})) {
      if (value === sessionId) return key
    }
    return null
  }

  async setSession(conversationKey, sessionId) {
    if (sessionId) this.state.sessions[conversationKey] = sessionId
    else delete this.state.sessions[conversationKey]
    await this.saveState()
  }

  /**
   * Remember the newest `context_token` for a conversation; replies must echo it.
   * @param {string} userId - conversation user id.
   * @param {string} token - the token from the inbound message.
   * @param {string} [botId] - bot that delivered the message (defaults to the primary bot).
   */
  rememberContextToken(userId, token, botId) {
    if (typeof token !== 'string' || token.length === 0) return
    const bot = this.#botState(botId)
    const id = bot ? (botId ?? this.primaryBotId) : ''
    const tokens = this.#tokens.get(id) ?? new Map()
    this.#tokens.set(id, tokens)
    tokens.set(userId, { token, at: Date.now() })
    while (tokens.size > LIMITS.contextTokens) {
      const oldest = [...tokens.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!oldest) break
      tokens.delete(oldest[0])
    }
  }

  /**
   * @param {string} userId - conversation user id.
   * @param {string} [botId] - bot whose token to read (defaults to the primary bot).
   * @returns {string|undefined} the cached reply token.
   */
  contextTokenFor(userId, botId) {
    const bot = this.#botState(botId)
    const id = bot ? (botId ?? this.primaryBotId) : ''
    const cached = this.#tokens.get(id)?.get(userId)?.token
    if (cached) return cached
    return bot ? undefined : this.state.contextTokens?.[userId]?.token
  }

  /**
   * Flush one bot's cached `context_token`s into the durable state object and schedule a
   * write, so a token learned from one message survives a restart.
   * @param {string} [botId] - bot to flush (defaults to the primary bot).
   * @returns {void}
   */
  persistTokens(botId) {
    const bot = this.#botState(botId)
    const id = bot ? (botId ?? this.primaryBotId) : ''
    const tokens = Object.fromEntries(this.#tokens.get(id) ?? new Map())
    if (bot) bot.contextTokens = tokens
    else this.state.contextTokens = tokens
    void this.saveState()
  }

  /**
   * Record a bot's connection state for `/status` and the settings card.
   * @param {string} botId - bot id.
   * @param {boolean} connected - whether its long poll is running.
   * @returns {void}
   */
  setConnected(botId, connected) {
    const bot = this.#botState(botId)
    if (bot) bot.connected = connected === true
  }

  /**
   * @param {string} botId - bot id.
   * @returns {boolean} whether its long poll is believed to be running.
   */
  isConnected(botId) {
    return this.#botState(botId)?.connected === true
  }

  /** Remember one outbound message (bounded history for debugging and quotes). */
  rememberOutbound(entry) {
    this.state.outbound.push({ ...entry, at: Date.now() })
    while (this.state.outbound.length > LIMITS.outbound) this.state.outbound.shift()
    this.state.stats.outbound += 1
    this.state.stats.lastOutboundAt = new Date().toISOString()
  }

  /** Record inbound/outbound statistics. */
  noteInbound() {
    this.state.stats.inbound += 1
    this.state.stats.lastInboundAt = new Date().toISOString()
  }

  /**
   * Whether this WeChat conversation receives the bound session's turns even when
   * another client (the GUI, another tool) started them.
   * @param {string} conversationKey - conversation to toggle.
   * @param {boolean} on - enable or disable the feed.
   * @returns {Promise<void>}
   */
  async setFollow(conversationKey, on) {
    const map = { ...(this.state.follow ?? {}) }
    if (on) map[conversationKey] = { since: new Date().toISOString() }
    else delete map[conversationKey]
    this.state.follow = map
    await this.saveState()
  }

  /** @returns {boolean} whether the feed is on for this conversation. */
  isFollowing(conversationKey) {
    return Boolean(this.state.follow?.[conversationKey])
  }

  /**
   * A `/session` switch waiting for the context-depth answer.
   * @param {string} conversationKey - conversation that switched.
   * @param {{ sessionId: string, title?: string, cwd?: string }|null} pending - the target, or null to clear.
   * @returns {Promise<void>}
   */
  async setPendingSwitch(conversationKey, pending) {
    const map = { ...(this.state.pendingSwitch ?? {}) }
    if (pending === null) delete map[conversationKey]
    else map[conversationKey] = { ...pending, at: new Date().toISOString() }
    this.state.pendingSwitch = map
    await this.saveState()
  }

  /** @returns {{ sessionId: string, title?: string, cwd?: string }|null} the pending switch, if any. */
  pendingSwitchFor(conversationKey) {
    return this.state.pendingSwitch?.[conversationKey] ?? null
  }

  /**
   * Record that this build started.
   *
   * The host can hot-reload a profile without restarting the process, and an ESM
   * module cache can serve the *previous* build after such a reload. Keeping a boot
   * log turns "which version is actually running" into an observable fact instead of
   * a guess — /status prints the newest entry.
   * @param {{ version: string, pid?: number, node?: string }} info - build identity.
   * @returns {Promise<void>}
   */
  async recordBoot(info) {
    const boots = Array.isArray(this.state.boots) ? this.state.boots : []
    this.state.boots = [...boots, { ...info, at: new Date().toISOString() }].slice(-20)
    await this.saveState()
  }

  /** @returns {{ version: string, at: string, pid?: number }|null} the newest boot record. */
  get lastBoot() {
    const boots = Array.isArray(this.state.boots) ? this.state.boots : []
    return boots.length > 0 ? boots.at(-1) : null
  }


  /** Record the last transport error for diagnostics. */
  noteError(message) {
    this.state.stats.lastError = message ? { message, at: new Date().toISOString() } : null
  }
}

/**
 * A stable dedup key for one inbound message.
 * @param {object} message - iLink message.
 * @returns {string} the key, or an empty string when the message has no identity.
 */
export function messageKey(message) {
  const id = message?.message_id ?? message?.msg_id
  if (id !== undefined && id !== null && String(id).length > 0) return `id:${id}`
  const seq = message?.seq
  if (seq !== undefined && seq !== null) return `seq:${message?.from_user_id ?? ''}:${seq}`
  return ''
}
