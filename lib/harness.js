/**
 * Thin helpers over the DSH host API that this plugin consumes.
 *
 * The plugin deliberately imports no `@deepseek-ai/*` module: a profile install
 * resolves the harness through the loader, not through this package's
 * `node_modules`, so services are reached by string key (`ctx.get('agents')`)
 * and the one value we need to construct — a user message — is built here with
 * exactly the shape `createUserMessage()` produces at runtime.
 *
 * @module dsh-wechat/harness
 */

import { randomUUID } from 'node:crypto'

/**
 * Freeze a value deeply, mirroring the harness's message immutability contract.
 * @template T
 * @param {T} value - value to freeze.
 * @returns {T} the frozen value.
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Build the user-role message an inbound WeChat message becomes.
 * @param {string} text - the prompt text.
 * @returns {object} an immutable identified `UserMessage`.
 */
export function createTextUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** @returns {string} a fresh session id in the harness's own format. */
export function newSessionId() {
  return `session-${randomUUID()}`
}

/**
 * Concatenate the text blocks of one message's content.
 * @param {{ content?: Array<{ type?: string, text?: string }> } | undefined} message - a conversation message.
 * @returns {string} its text, possibly empty.
 */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Read the newest assistant text out of a session's derived history. Used as a
 * fallback when the live stream published no final text (for example after a
 * reload), and never as the primary path.
 * @param {object} session - a live `Session`.
 * @returns {string} the newest assistant text, or an empty string.
 */
export function latestAssistantText(session) {
  try {
    const messages = session?.deriveMessages?.()
    if (!Array.isArray(messages)) return ''
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant') continue
      const text = messageText(message)
      if (text.length > 0) return text
    }
  } catch {
    // Derivations can refuse after a projection is unloaded; the caller falls back.
  }
  return ''
}

/**
 * Read the `provider/model` route recorded for an agent.
 * @param {object} agent - a live `Agent`.
 * @returns {string} a display string, or `unknown`.
 */
export function describeAgentRoute(agent) {
  const options = agent?.options
  if (!options?.provider || !options?.model) return 'unknown'
  return `${options.provider}/${options.model}`
}

/**
 * Resolve a service from the cordis context, tolerating its absence.
 * @param {object} ctx - plugin context.
 * @param {string} key - service key.
 * @returns {any} the service, or undefined.
 */
export function service(ctx, key) {
  try {
    return ctx?.get?.(key)
  } catch {
    return undefined
  }
}
