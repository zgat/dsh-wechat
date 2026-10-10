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
function emptyState() {
  return {
    version: 1,
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
    this.credentials = null
    this.#seen = new Set()
    this.#tokens = new Map()
  }

  #seen
  #tokens
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
    this.credentials = this.#normalizeCredentials(credentials)
    this.state = { ...emptyState(), ...(state ?? {}) }
    // A hand-edited or foreign state file can carry the right keys with the wrong shapes
    // (`"stats": null`, `"sessions": []`). Left alone, `stats` throws on the next inbound
    // message — which kills the poll loop — and `sessions` silently drops every binding
    // because JSON.stringify ignores array properties. Normalize every field we touch.
    this.#sanitizeState()
    this.#seen = new Set(this.state.seenMessageIds)
    this.#tokens = new Map(Object.entries(this.state.contextTokens))
    this.logger?.debug?.(`state loaded from ${this.paths.root}`)
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
    const envToken = process.env.DSH_WECHAT_BOT_TOKEN
    const envBase = process.env.DSH_WECHAT_BASE_URL
    const fromEnv = envToken
      ? {
          version: 1,
          botToken: envToken,
          baseUrl: envBase || raw?.baseUrl || undefined,
          botId: process.env.DSH_WECHAT_BOT_ID ?? raw?.botId ?? null,
          ownerUserId: process.env.DSH_WECHAT_USER_ID ?? raw?.ownerUserId ?? null,
          source: 'env',
          savedAt: new Date().toISOString(),
        }
      : null
    if (fromEnv) return fromEnv
    if (!raw || typeof raw !== 'object' || typeof raw.botToken !== 'string' || raw.botToken.length === 0) return null
    return { version: 1, source: 'file', ...raw }
  }

  /** @returns {boolean} whether a usable credential is loaded. */
  get loggedIn() {
    return Boolean(this.credentials?.botToken)
  }

  /** Persist a fresh credential (QR login result or env override). */
  async saveCredentials(next) {
    // An env-provided credential is authoritative and must never be written to
    // disk, so the existing source is preserved unless the caller overrides it.
    const source = next?.source ?? this.credentials?.source ?? 'file'
    this.credentials = { version: 1, savedAt: new Date().toISOString(), ...next, source }
    if (source === 'env') return this.credentials
    await this.#enqueueWrite(() => writeJsonAtomic(this.paths.credentials, this.credentials))
    this.logger?.info?.(`credentials saved to ${this.paths.credentials}`)
    return this.credentials
  }

  /** Forget the credential and the long-poll cursor (session-expired path). */
  async clearCredentials({ keepCursor = false } = {}) {
    this.credentials = null
    // A fresh binding is a fresh introduction: greet the account again.
    this.state.welcomed = {}
    await this.#enqueueWrite(async () => {
      await withRetries(() => rm(this.paths.credentials, { force: true }))
      await this.#clearCredentialTemps()
    })
    if (!keepCursor) {
      this.state.cursor = ''
      await this.saveState()
    }
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

  /** @returns {string} the current long-poll cursor. */
  get cursor() {
    return this.state.cursor ?? ''
  }

  /** Record a new long-poll cursor and persist it. */
  async setCursor(cursor) {
    if (typeof cursor !== 'string' || cursor === this.state.cursor) return
    this.state.cursor = cursor
    await this.saveState()
  }

  /**
   * @param {object} message - inbound message envelope.
   * @returns {boolean} true when this delivery was already processed.
   */
  hasSeen(message) {
    const key = messageKey(message)
    if (!key) return false
    if (this.#seen.has(key)) return true
    this.#seen.add(key)
    this.state.seenMessageIds.push(key)
    while (this.state.seenMessageIds.length > LIMITS.seenMessageIds) {
      const dropped = this.state.seenMessageIds.shift()
      if (dropped) this.#seen.delete(dropped)
    }
    return false
  }

  /** @returns {string|undefined} the DSH session bound to a conversation key. */
  sessionFor(conversationKey) {
    return this.state.sessions[conversationKey]
  }

  /** Bind (or clear, with `null`) the DSH session of a conversation key. */
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
   */
  rememberContextToken(userId, token) {
    if (typeof token !== 'string' || token.length === 0) return
    this.#tokens.set(userId, { token, at: Date.now() })
    while (this.#tokens.size > LIMITS.contextTokens) {
      const oldest = [...this.#tokens.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!oldest) break
      this.#tokens.delete(oldest[0])
    }
  }

  /** @returns {string|undefined} the cached reply token for a conversation. */
  contextTokenFor(userId) {
    return this.#tokens.get(userId)?.token
  }

  /**
   * Flush cached `context_token`s into the durable state object and schedule a
   * write, so a token learned from one message survives a restart even when no
   * later call would have saved the file.
   */
  persistTokens() {
    this.state.contextTokens = Object.fromEntries(this.#tokens)
    void this.saveState()
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
