/**
 * Plugin configuration: defaults, normalization and validation.
 *
 * The whole config arrives as the `config` value of the plugin's row in
 * `cordis.patch.yml`, so every field has to be defensively interpreted: a YAML
 * author can write `"true"`, `null`, or omit the row's config entirely.
 *
 * @module dsh-wechat/config
 */

/** Access policies for inbound senders. */
export const ACCESS_POLICIES = ['allowlist', 'open']

/** Progress verbosity while a turn is running. */
export const PROGRESS_MODES = ['off', 'brief', 'verbose']

/** @returns {object} the complete default configuration. */
export function defaultConfig() {
  return {
    enabled: true,
    stateDir: null,
    baseUrl: null,
    cdnBaseUrl: null,
    workspace: null,
    accessPolicy: 'allowlist',
    allowedUserIds: [],
    ownerUserId: null,
    autoLogin: true,
    loginPage: true,
    loginPagePort: 30989,
    openLoginPage: true,
    chunkChars: 1800,
    maxAnswerChars: 20000,
    chunkDelayMs: 350,
    sendRetryMs: [500, 2000, 5000],
    typing: true,
    progress: 'brief',
    showToolProgress: true,
    turnTimeoutSeconds: 900,
    progressHeartbeatSeconds: 300,
    approvalTimeoutSeconds: 300,
    questionsTimeoutSeconds: 600,
    idleDisposeMinutes: 0,
    model: null,
    agentPreset: null,
    media: {
      enabled: true,
      dir: null,
      maxInboundBytes: 20 * 1024 * 1024,
      maxOutboundBytes: 50 * 1024 * 1024,
    },
    notifyLifecycle: false,
    typingKeepaliveSeconds: 5,
    routeTag: null,
    channelVersion: '1.0.0',
    logLevel: 'info',
  }
}

class ConfigError extends Error {
  constructor(message) {
    super(`dsh-wechat config: ${message}`)
    this.name = 'ConfigError'
  }
}

function asBoolean(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ConfigError(`${field} must be a boolean`)
}

function asString(value, field, { allowEmpty = false } = {}) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') throw new ConfigError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0 && !allowEmpty) return undefined
  return trimmed
}

function asPositiveNumber(value, field, { integer = false, min = 0 } = {}) {
  if (value === undefined || value === null) return undefined
  // `Number([])` is 0, `Number(true)` is 1 and `Number([1800])` is 1800 — coercing those
  // would silently rewrite a typo into a different behaviour (a disabled cap, a 1-char
  // answer). Only real numbers and numeric strings are accepted.
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(number) || number < min) {
    throw new ConfigError(`${field} must be a number >= ${min}, got ${JSON.stringify(value)}`)
  }
  return integer ? Math.round(number) : number
}

function asStringList(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be a list of strings`)
  return value
    .map((entry) => asString(entry, `${field}[]`))
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
}

function asEnum(value, field, allowed) {
  if (value === undefined || value === null) return undefined
  const text = String(value)
  if (!allowed.includes(text)) throw new ConfigError(`${field} must be one of ${allowed.join(', ')}`)
  return text
}

/**
 * Merge user configuration over the defaults and validate it.
 * @param {unknown} raw - the row's `config` object, possibly absent.
 * @returns {object} a complete, validated configuration.
 * @throws {ConfigError} when a value cannot be interpreted.
 */
export function normalizeConfig(raw) {
  const config = defaultConfig()
  if (raw === undefined || raw === null) return config
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a mapping')

  const assign = (field, value) => {
    if (value !== undefined) config[field] = value
  }

  assign('enabled', asBoolean(raw.enabled, 'enabled'))
  assign('stateDir', asString(raw.stateDir, 'stateDir'))
  assign('baseUrl', asString(raw.baseUrl, 'baseUrl'))
  assign('cdnBaseUrl', asString(raw.cdnBaseUrl, 'cdnBaseUrl'))
  assign('workspace', asString(raw.workspace, 'workspace'))
  assign('accessPolicy', asEnum(raw.accessPolicy, 'accessPolicy', ACCESS_POLICIES))
  assign('allowedUserIds', asStringList(raw.allowedUserIds ?? raw.allowedSenders, 'allowedUserIds'))
  // Left null, the plugin adopts the account that completed the QR login.
  assign('ownerUserId', asString(raw.ownerUserId, 'ownerUserId'))
  assign('autoLogin', asBoolean(raw.autoLogin, 'autoLogin'))
  assign('loginPage', asBoolean(raw.loginPage, 'loginPage'))
  assign('loginPagePort', asPositiveNumber(raw.loginPagePort, 'loginPagePort', { integer: true, min: 0 }))
  assign('openLoginPage', asBoolean(raw.openLoginPage, 'openLoginPage'))
  assign('chunkChars', asPositiveNumber(raw.chunkChars, 'chunkChars', { integer: true, min: 200 }))
  // 0 disables the cap (the answer is still sent in chunks).
  assign('maxAnswerChars', asPositiveNumber(raw.maxAnswerChars, 'maxAnswerChars', { integer: true, min: 0 }))
  assign('chunkDelayMs', asPositiveNumber(raw.chunkDelayMs, 'chunkDelayMs', { integer: true, min: 0 }))
  if (raw.sendRetryMs !== undefined) {
    // NaN/Infinity would reach setTimeout and be clamped to 1ms — the burst the ladder
    // exists to avoid (Node prints TimeoutOverflowWarning and fires immediately).
    if (
      !Array.isArray(raw.sendRetryMs) ||
      raw.sendRetryMs.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      throw new ConfigError('sendRetryMs must be an array of finite non-negative numbers')
    }
    config.sendRetryMs = [...raw.sendRetryMs]
  }
  assign('typing', asBoolean(raw.typing, 'typing'))
  assign('progress', asEnum(raw.progress, 'progress', PROGRESS_MODES))
  assign('showToolProgress', asBoolean(raw.showToolProgress, 'showToolProgress'))
  assign('turnTimeoutSeconds', asPositiveNumber(raw.turnTimeoutSeconds, 'turnTimeoutSeconds', { integer: true, min: 5 }))
  assign('progressHeartbeatSeconds', asPositiveNumber(raw.progressHeartbeatSeconds, 'progressHeartbeatSeconds', { integer: true, min: 0 }))
  assign(
    'approvalTimeoutSeconds',
    asPositiveNumber(raw.approvalTimeoutSeconds, 'approvalTimeoutSeconds', { integer: true, min: 5 }),
  )
  assign(
    'questionsTimeoutSeconds',
    asPositiveNumber(raw.questionsTimeoutSeconds, 'questionsTimeoutSeconds', { integer: true, min: 5 }),
  )
  // Fractional minutes are allowed: a quiet period is a duration, not a count.
  assign('idleDisposeMinutes', asPositiveNumber(raw.idleDisposeMinutes, 'idleDisposeMinutes', { min: 0 }))
  assign('agentPreset', asString(raw.agentPreset, 'agentPreset'))
  assign('notifyLifecycle', asBoolean(raw.notifyLifecycle, 'notifyLifecycle'))
  assign('typingKeepaliveSeconds', asPositiveNumber(raw.typingKeepaliveSeconds, 'typingKeepaliveSeconds', { integer: true, min: 2 }))
  assign('routeTag', asString(raw.routeTag, 'routeTag'))
  assign('channelVersion', asString(raw.channelVersion, 'channelVersion'))
  assign('logLevel', asEnum(raw.logLevel, 'logLevel', ['silent', 'error', 'warn', 'info', 'debug']))

  if (raw.model !== undefined && raw.model !== null) {
    if (typeof raw.model === 'string') {
      const [provider, model] = raw.model.split('/')
      if (!provider || !model) throw new ConfigError('model must look like "provider/model" when given as a string')
      config.model = { provider, model }
    } else if (typeof raw.model === 'object') {
      const provider = asString(raw.model.provider, 'model.provider')
      const model = asString(raw.model.model, 'model.model')
      if (!provider || !model) throw new ConfigError('model.provider and model.model are both required')
      config.model = { provider, model }
      const effort = asString(raw.model.reasoningEffort, 'model.reasoningEffort')
      if (effort) config.model.reasoningEffort = effort
      const maxTokens = asPositiveNumber(raw.model.maxTokens, 'model.maxTokens', { integer: true, min: 1 })
      if (maxTokens) config.model.maxTokens = maxTokens
    } else {
      throw new ConfigError('model must be a mapping or a "provider/model" string')
    }
  }

  if (raw.media !== undefined && raw.media !== null) {
    if (typeof raw.media !== 'object' || Array.isArray(raw.media)) throw new ConfigError('media must be a mapping')
    assign('media', {
      ...config.media,
      ...(asBoolean(raw.media.enabled, 'media.enabled') !== undefined
        ? { enabled: asBoolean(raw.media.enabled, 'media.enabled') }
        : {}),
      ...(asString(raw.media.dir, 'media.dir') ? { dir: asString(raw.media.dir, 'media.dir') } : {}),
      ...(asPositiveNumber(raw.media.maxInboundBytes, 'media.maxInboundBytes', { integer: true, min: 1 })
        ? { maxInboundBytes: asPositiveNumber(raw.media.maxInboundBytes, 'media.maxInboundBytes', { integer: true, min: 1 }) }
        : {}),
      ...(asPositiveNumber(raw.media.maxOutboundBytes, 'media.maxOutboundBytes', { integer: true, min: 1 })
        ? { maxOutboundBytes: asPositiveNumber(raw.media.maxOutboundBytes, 'media.maxOutboundBytes', { integer: true, min: 1 }) }
        : {}),
    })
  }

  return config
}

/**
 * Decide whether an inbound sender may use the bot.
 * @param {object} config - normalized configuration.
 * @param {string} userId - sender id (`...@im.wechat`).
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkAccess(config, userId) {
  if (config.ownerUserId && config.ownerUserId === userId) return { allowed: true }
  if (config.accessPolicy === 'open') return { allowed: true }
  if (config.allowedUserIds.includes(userId)) return { allowed: true }
  return {
    allowed: false,
    reason: `发送者 ${userId} 不在白名单内（accessPolicy=allowlist，可用 allowedUserIds 或 ownerUserId 添加）`,
  }
}
