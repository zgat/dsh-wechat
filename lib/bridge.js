/**
 * The bridge: WeChat conversations in, DSH agent turns through, answers back.
 *
 * One WeChat conversation (`p2p:<userId>`) owns exactly one DSH session, created
 * on first contact and resumed afterwards. A turn is one `followup()`; the answer
 * is collected from the live `agent/assistant-stream` frames and delivered when
 * the session's `turn/end` arrives, so what the user reads in WeChat is the final
 * assistant message rather than every intermediate step.
 *
 * @module dsh-wechat/bridge
 */

import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'

import { checkAccess } from './config.js'
import { createCommands, parseCommand, runCommand } from './commands.js'
import { createTextUserMessage, describeAgentRoute, latestAssistantText, messageText, newSessionId, service } from './harness.js'
import { ITEM_TYPE, TYPING } from './ilink/api.js'
import { newClientId } from './ilink/crypto.js'
import { describeFilesForPrompt, downloadInboundItem, itemPayload, itemType, uploadLocalFile } from './ilink/media.js'
import { renderChoices, welcomeText } from './onboarding.js'
import { normalizeAnswer, splitText, toolProgressLine } from './render.js'

/** Conversational key for a one-to-one WeChat chat. */
export function conversationKeyOf(message) {
  if (message?.group_id) return `group:${message.group_id}`
  return `p2p:${message?.from_user_id ?? 'unknown'}`
}

/**
 * Resolve a path to its real location, tolerating a missing final component.
 * @param {string} target - path to resolve.
 * @returns {Promise<string>} the resolved absolute path.
 */
async function resolveReal(target) {
  const absolute = path.resolve(String(target))
  try {
    return await realpath(absolute)
  } catch {
    const directory = await realpath(path.dirname(absolute)).catch(() => path.dirname(absolute))
    return path.join(directory, path.basename(absolute))
  }
}

/**
 * Extract display text from whatever a DSH title API returned.
 *
 * `sessionTitle.get()`, `sessionQuery.readTitle()` and `readTitleSnapshots()` all
 * return a *title snapshot* — `{ title, messageSeqs, source, eventSeq, updatedAt }` —
 * not the string itself. Interpolating the snapshot produced `[object Object]` in the
 * chat, so every title now passes through here.
 * @param {unknown} value - snapshot, plain string, or nullish.
 * @returns {string|null} the title text, or null when there is none.
 */
export function titleText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (value === null || typeof value !== 'object') return null
  for (const key of ['title', 'text', 'label', 'name']) {
    const inner = Reflect.get(value, key)
    if (typeof inner === 'string' && inner.trim().length > 0) return inner.trim()
  }
  return null
}

/**
 * Whether two paths name the same directory, tolerating spelling differences
 * (`/a/b/` vs `/a/b`) and, on Windows, case.
 * @param {string} left - one path.
 * @param {string} right - the other path.
 * @param {string} [platform] - defaults to the running platform.
 * @returns {boolean} true when both resolve to the same location.
 */
export function samePath(left, right, platform = process.platform) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value ?? ''))
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

/**
 * Expand a leading `~` in a user-typed path.
 *
 * Windows users type `~\proj`, POSIX users `~/proj`, so both separators count.
 * @param {string} value - raw path from a command.
 * @returns {string} the path with `~` replaced by the home directory.
 */
export function expandHome(value) {
  return String(value ?? '')
    .trim()
    .replace(/^~(?=[\\/]|$)/, os.homedir())
}

/**
 * Strip one layer of surrounding quotes, so a path with spaces survives chat.
 * @param {string} value - raw argument.
 * @returns {string} the unquoted value.
 */
export function unquote(value) {
  const trimmed = String(value ?? '').trim()
  const match = /^"([^"]*)"$|^'([^']*)'$/.exec(trimmed)
  return match ? (match[1] ?? match[2] ?? '') : trimmed
}

/**
 * Whether one resolved path lives inside a directory.
 *
 * Windows filesystems are case-insensitive, so a case-sensitive comparison there
 * would let a path escape the guard by spelling alone.
 * @param {string} root - the containing directory.
 * @param {string} target - the candidate path.
 * @param {string} [platform] - defaults to the running platform.
 * @returns {boolean} true when `target` is `root` or below it.
 */
export function isInsideDirectory(root, target, platform = process.platform) {
  // The separator must follow the modelled platform, not the host: the guard is
  // tested for Windows from a POSIX machine, where `path.sep` is not `\\`.
  const separator = platform === 'win32' ? '\\' : '/'
  const normalize = (value) => (platform === 'win32' ? String(value).toLowerCase().replace(/\//g, '\\') : String(value))
  const base = normalize(root)
  const candidate = normalize(target)
  return candidate === base || candidate.startsWith(`${base}${separator}`)
}

/**
 * Shorten a conversation key for a message shown to another human.
 * @param {string} conversationKey - `p2p:<id>` or `group:<id>`.
 * @returns {string} a recognisable but not fully disclosed label.
 */
export function maskConversation(conversationKey) {
  const [kind, id = ''] = String(conversationKey).split(':')
  const tail = id.slice(-6)
  return `${kind === 'group' ? '群' : '联系人'}…${tail}`
}

/** Cap on "still working" heartbeats per turn, so a long turn cannot flood the chat. */
const HEARTBEAT_CAP = 12

/** One queued turn waiting for its `turn/end`. */
function createPendingTurn(options) {
  return {
    id: `${options.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    sessionId: options.sessionId,
    conversationKey: options.conversationKey,
    userId: options.userId,
    startedAt: Date.now(),
    attempts: new Map(),
    lastAttemptId: null,
    /** Turn number once `turn/start` named it; null while still in the inbox. */
    turn: null,
    /** Text of this turn's durable `assistant/message`, when one was committed. */
    durableText: '',
    progressSent: 0,
    /** How many "still working" lines this turn sent, and the last tool it named. */
    heartbeats: 0,
    lastTool: null,
    abandoned: false,
    typingTimer: null,
    heartbeatTimer: null,
    timeoutTimer: null,
  }
}

export class WechatBridge {
  /**
   * @param {object} options - bridge options.
   * @param {object} options.ctx - the plugin's cordis context.
   * @param {object} options.config - normalized configuration.
   * @param {import('./store.js').WechatStore} options.store - durable state.
   * @param {import('./ilink/api.js').ILinkClient} options.client - transport.
   * @param {import('./approval.js').InteractionRouter} options.interactions - approval/question router.
   * @param {{ info: Function, warn: Function, debug: Function, error: Function }} options.logger
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.store = options.store
    this.client = options.client
    this.interactions = options.interactions
    this.installedVersion = options.installedVersion ?? null
    this.logger = options.logger
    this.commands = createCommands(this)

    this.connected = false
    this.botId = null
    /** Turns another client started in a followed session: sessionId → { turn, text }. */
    this.#followBuffers = new Map()
  }

  /** sessionId → AgentHandle for agents this bridge created. */
  #handles = new Map()
  /** sessionId → conversationKey, the reverse index approvals and tools need. */
  #chatOf = new Map()
  /** sessionId → pending turns (FIFO, one entry per queued follow-up). */
  #pending = new Map()
  /** conversationKey → serialization chain. */
  #followBuffers

  #chains = new Map()
  /** userId → { ticket, at } for the typing indicator. */
  #typingTickets = new Map()
  /** sessionId → last finished activity, for idle disposal. */
  #lastActivity = new Map()
  /** Periodic idle sweep, when the configuration asks for one. */
  #idleSweep = null

  /** Replace the transport after a fresh login. */
  updateClient(client) {
    this.client = client
  }

  /** Mark the connection state reported by `/status`. */
  setConnected(connected, botId = null) {
    this.connected = connected
    if (botId) this.botId = botId
  }

  /** @returns {string|undefined} the conversation that owns a session. */
  conversationForAgent(agent) {
    const sessionId = agent?.session?.id ?? agent?.id
    return sessionId ? this.#chatOf.get(sessionId) : undefined
  }

  /** @returns {string|undefined} the conversation bound to a session id. */
  conversationForSession(sessionId) {
    if (!sessionId) return undefined
    // The binding table is the source of truth: a chat that switched to this session
    // but has not sent a message yet is not in the runtime index either.
    const direct = this.#chatOf.get(sessionId) ?? this.store.conversationForSession(sessionId)
    if (direct) return direct
    // A delegated sub-agent runs in its own session; an approval it raises still
    // belongs to the chat whose turn spawned it, so walk up to the owning root.
    // Without this the request was neither shown in WeChat nor answerable from it.
    return this.#rootChatOf(sessionId)
  }

  /**
   * Walk up `parentSession` to the top-most session of this agent tree.
   * @param {string} sessionId - any session id, possibly a child session.
   * @returns {string} the root session id (the input when it has no parent).
   */
  #rootSessionIdOf(sessionId) {
    const sessions = service(this.ctx, 'sessions')
    let current = sessionId
    for (let hop = 0; hop < 16 && current; hop += 1) {
      const parent = sessions?.get?.(current)?.header?.parentSession
      if (!parent) return current
      current = parent
    }
    return current ?? sessionId
  }

  /**
   * Whether WeChat is currently driving a turn in this session (or in the root of its
   * sub-agent tree).
   *
   * This is the ownership test for approvals and questions: claiming an interaction
   * consumes the waterfall, so a request raised by a turn the user started in the GUI
   * must be left alone — otherwise the GUI never shows its dialog and the question
   * ends up in a chat that was not even talking to that session.
   * @param {string} sessionId - session that raised the interaction.
   * @returns {boolean} true when a WeChat message is queued or running there.
   */
  isDrivingTurn(sessionId) {
    if (!sessionId) return false
    const ids = new Set([sessionId, this.#rootSessionIdOf(sessionId)])
    for (const id of ids) {
      if ((this.#pending.get(id)?.length ?? 0) > 0) return true
    }
    return false
  }

  /**
   * Find the WeChat conversation that owns a session's root ancestor.
   * @param {string} sessionId - a session id, possibly a child session.
   * @returns {string|undefined} the conversation key, when one owns the tree.
   */
  #rootChatOf(sessionId) {
    const sessions = service(this.ctx, 'sessions')
    let current = sessionId
    for (let hop = 0; hop < 16 && current; hop += 1) {
      const parent = sessions?.get?.(current)?.header?.parentSession
      if (!parent) return undefined
      const owner = this.#chatOf.get(parent) ?? this.store.conversationForSession(parent)
      if (owner) return owner
      current = parent
    }
    return undefined
  }

  /** Serialize work per conversation. */
  #chain(key, task) {
    const previous = this.#chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.#chains.set(
      key,
      next.catch(() => {}),
    )
    return next
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * Handle one inbound iLink message. Safe to call for every long-poll batch:
   * duplicates, echoes of our own messages and disallowed senders are dropped here.
   * @param {object} message - an inbound `WeixinMessage`.
   * @returns {Promise<void>}
   */
  async handleInbound(message) {
    const userId = message?.from_user_id
    if (!userId) return
    if (message.message_type === 2) return // our own bot echo
    // iLink offers no reliable reply route for group conversations, so refusing
    // them here beats running a turn that could never be delivered.
    if (message.group_id) {
      this.logger.debug?.(`ignoring a group message (group_id=${message.group_id}); only direct chats are supported`)
      return
    }
    if (!Array.isArray(message.item_list) || message.item_list.length === 0) return
    if (this.store.hasSeen(message)) {
      this.logger.debug?.('duplicate inbound message ignored')
      return
    }
    this.store.noteInbound()
    const conversationKey = conversationKeyOf(message)
    const access = checkAccess(this.config, userId)
    if (!access.allowed) {
      this.logger.info?.(`rejected inbound message from ${userId}: ${access.reason}`)
      await this.deliver(conversationKey, `⛔ ${access.reason}`)
      await this.store.saveState()
      return
    }

    // Only an admitted sender's token is cached: the token is a reply capability,
    // and caching one before the policy check would let a rejected stranger be
    // messaged later through `toUserId`.
    if (typeof message.context_token === 'string' && message.context_token.length > 0) {
      this.store.rememberContextToken(userId, message.context_token)
      this.store.persistTokens()
    }

    const content = await this.#normalizeInbound(message)
    if (content.text.length === 0) {
      this.logger.debug?.('inbound message carried no usable text')
      return
    }

    if (this.interactions.tryConsume(conversationKey, content.text)) {
      this.logger.debug?.(`reply consumed by a pending interaction in ${conversationKey}`)
      return
    }
    // The reply was not recognised as an answer. It still goes to the agent, but the
    // user is told once that the pending question is unanswered — otherwise their
    // "answer" silently becomes an ordinary message and the turn waits forever.
    const hint = this.interactions.hintFor(conversationKey)
    if (hint) await this.deliver(conversationKey, hint)

    // Any non-numeric message while the recap question is open counts as "不发回执".
    if (this.store.pendingSwitchFor(conversationKey) && parseCommand(content.text) === null) {
      const pendingSwitch = this.store.pendingSwitchFor(conversationKey)
      const numericPending = /^\/?\d{1,2}$/.test(content.text.trim())
      if (!numericPending && pendingSwitch) await this.store.setPendingSwitch(conversationKey, null)
    }

    // A bare number right after `/session <n>` answers "回执多少段到微信？".
    const pending = this.store.pendingSwitchFor(conversationKey)
    // Both `2` and `/2` are accepted: a leading slash keeps the chat commands in
    // muscle memory while the answer itself is just a number.
    const numeric = /^\/?(\d{1,2})$/.exec(content.text.trim())
    const segments = numeric ? Number.parseInt(numeric[1], 10) : null
    if (pending && segments !== null && segments <= 99) {
      const applied = await this.applyContextChoice(conversationKey, segments)
      const label = applied.title ?? pending.sessionId
      await this.deliver(
        conversationKey,
        applied.segments === 0
          ? `好的，不发回执。直接发消息就接着「${label}」聊——它的历史一直都在。`
          : applied.delivered
            ? `以上是「${label}」的最近 ${applied.segments} 段回执；接着发消息就能继续这个对话。`
            : `读不到「${label}」的历史内容（可能还没落盘），直接发消息继续即可。`,
      )
      await this.store.saveState()
      return
    }

    const parsed = parseCommand(content.text)
    if (!parsed) await this.#maybeWelcome(conversationKey, userId)
    if (parsed) {
      const context = await this.#commandContext(conversationKey, userId)
      let reply
      try {
        reply = await runCommand(this.commands, parsed, context)
      } catch (error) {
        // A command that throws must still answer: silence looks like a dead bot.
        reply = `❌ ${parsed.name} 执行失败：${error?.message ?? error}`
        this.logger.warn?.(`command ${parsed.name} failed: ${error?.message ?? error}`)
      }
      if (reply) await this.deliver(conversationKey, reply)
      await this.store.saveState()
      return
    }

    await this.#chain(conversationKey, async () => {
      let opened
      try {
        opened = await this.ensureAgent(conversationKey, userId)
      } catch (error) {
        // Without this the user's message would vanish: no reply, no retry.
        const detail = error?.message ?? String(error)
        this.logger.error?.(`could not open a session for ${conversationKey}: ${detail}`)
        this.store.noteError(`无法创建会话：${detail}`)
        await this.deliver(
          conversationKey,
          `❌ 无法为这个微信会话打开 DSH 会话：${detail}\n请检查工作区路径是否存在（/workspace），或发送 /new 重试。`,
        ).catch((deliveryError) => this.logger.warn?.(`could not report the failure: ${deliveryError?.message ?? deliveryError}`))
        await this.store.saveState()
        return
      }
      const { agent, sessionId } = opened
      const pending = createPendingTurn({ sessionId, conversationKey, userId })
      const queue = this.#pending.get(sessionId) ?? []
      queue.push(pending)
      this.#pending.set(sessionId, queue)
      this.#startTyping(pending)
      // Only the head of the queue is a running turn, so only the head gets a
      // deadline: a message still waiting its turn has nothing to time out, and
      // a long predecessor must not make it look stuck.
      if (queue.length === 1) this.#armTurnTimeout(pending)
      agent.followup(createTextUserMessage(content.text))
      this.logger.info?.(
        `turn queued for ${conversationKey} on ${sessionId} (${content.text.length} chars, queue ${queue.length})`,
      )
    })
  }

  /**
   * Send the onboarding message exactly once per binding, before the first real
   * prompt. Commands are skipped: their own output already teaches the user.
   */
  async #maybeWelcome(conversationKey, userId) {
    const welcomed = this.store.state.welcomed ?? {}
    if (welcomed[conversationKey]) return
    const options = this.#agentOptions(conversationKey)
    try {
      await this.deliver(
        conversationKey,
        welcomeText({
          config: this.config,
          current: {
            workspace: await this.#workspaceFor(conversationKey),
            model: options?.provider && options?.model ? `${options.provider}/${options.model}` : null,
            reasoning: options?.reasoningEffort ?? null,
          },
          isOwner: !this.config.ownerUserId || this.config.ownerUserId === userId,
        }),
      )
      // Marked only after delivery: a failed greeting retries on the next message.
      this.store.state.welcomed = { ...welcomed, [conversationKey]: new Date().toISOString() }
    } catch (error) {
      this.logger.warn?.(`could not send the welcome message: ${error?.message ?? error}`)
    }
    await this.store.saveState()
  }

  /** Turn raw iLink items into one prompt string plus downloaded files. */
  async #normalizeInbound(message) {
    const items = Array.isArray(message.item_list) ? message.item_list : []
    const texts = []
    const files = []
    let quote = ''

    for (const item of items) {
      const type = itemType(item)
      const payload = itemPayload(item)
      if (type === ITEM_TYPE.TEXT && typeof payload.text === 'string') texts.push(payload.text)
      if (type === ITEM_TYPE.VOICE && typeof payload.text === 'string' && payload.text.length > 0) {
        texts.push(`（语音转写）${payload.text}`)
      }
      const refText = item.ref_msg?.message_item?.text_item?.text
      if (typeof refText === 'string' && refText.length > 0) quote = `[引用消息] ${refText}`
    }

    if (this.config.media.enabled) {
      for (const item of items) {
        const type = itemType(item)
        const payload = itemPayload(item)
        const isMedia = type === ITEM_TYPE.IMAGE || type === ITEM_TYPE.FILE || type === ITEM_TYPE.VIDEO
        const isVoiceWithoutTranscript = type === ITEM_TYPE.VOICE && !(typeof payload.text === 'string' && payload.text.length > 0)
        if (!isMedia && !isVoiceWithoutTranscript) continue
        try {
          const file = await downloadInboundItem({
            client: this.client,
            item,
            dir: path.join(this.store.paths.media, new Date().toISOString().slice(0, 10)),
            maxBytes: this.config.media.maxInboundBytes,
            logger: this.logger,
          })
          if (file) files.push(file)
        } catch (error) {
          this.logger.warn?.(`failed to fetch inbound media: ${error?.message ?? error}`)
          texts.push(`（收到一个附件，但下载失败：${error?.message ?? error}）`)
        }
      }
    }

    const parts = []
    if (quote) parts.push(quote)
    if (texts.length > 0) parts.push(texts.join('\n'))
    const fileNote = describeFilesForPrompt(files)
    if (fileNote) parts.push(fileNote)
    return { text: parts.join('\n\n').trim(), files }
  }

  // -------------------------------------------------------------------------
  // Agents and sessions
  // -------------------------------------------------------------------------

  /** @returns {object|undefined} the agent registry service. */
  get agents() {
    return service(this.ctx, 'agents')
  }

  /**
   * Resolve (or create) the agent serving one conversation.
   * @param {string} conversationKey - conversation key.
   * @param {string} userId - WeChat user id.
   * @returns {Promise<{ agent: object, sessionId: string, created: boolean }>}
   */
  async ensureAgent(conversationKey, userId) {
    const registry = this.agents
    if (!registry) throw new Error('dsh-wechat: the agents service is unavailable in this profile')

    // A session archived from the DSH GUI rejects every step, so the binding has
    // to move on before the user's next message is wasted on a blocked turn.
    const stale = this.store.sessionFor(conversationKey)
    if (stale && this.isArchived(stale)) {
      this.logger.info?.(`session ${stale} was archived in DSH; starting a fresh one for ${conversationKey}`)
      await this.#releaseSession(conversationKey, stale)
      await this.deliver(
        conversationKey,
        `⚠️ 上一个会话（${stale}）已在 DSH 里被归档，我为你开了一个新会话。历史仍保留在 DSH 的归档列表里。`,
      ).catch((error) => this.logger.warn?.(`could not announce the archived session: ${error?.message ?? error}`))
    }

    const boundSessionId = this.store.sessionFor(conversationKey)
    if (boundSessionId) {
      const handle = this.#handles.get(boundSessionId)
      if (handle) return { agent: handle.agent, sessionId: boundSessionId, created: false }
      const live = registry.get(boundSessionId)
      if (live) {
        this.#chatOf.set(boundSessionId, conversationKey)
        return { agent: live, sessionId: boundSessionId, created: false }
      }
      try {
        const presetId = await this.resolveAgentPreset()
        const handleResumed = await registry.resume({
          resumeSessionId: boundSessionId,
          ...(this.#agentOptions(conversationKey) ? { agentOptions: this.#agentOptions(conversationKey) } : {}),
          // A resumed conversation gets its tools back the same way a new one does.
          setup: async (agentCtx) => {
            await this.#mountPreset(agentCtx, presetId)
          },
        })
        this.#track(handleResumed, conversationKey)
        this.logger.info?.(`resumed session ${boundSessionId} for ${conversationKey}`)
        return { agent: handleResumed.agent, sessionId: boundSessionId, created: false }
      } catch (error) {
        this.logger.warn?.(`failed to resume session ${boundSessionId}, starting a new one: ${error?.message ?? error}`)
        await this.store.setSession(conversationKey, null)
      }
    }

    const sessionId = newSessionId()
    const cwd = await this.#workspaceFor(conversationKey)
    const presetId = await this.resolveAgentPreset()
    const handle = await registry.create({
      sessionId,
      // The header seeds the `agentPreset` projection, so the GUI shows which
      // preset the session runs even before the first selection event.
      meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(this.#agentOptions(conversationKey) ? { agentOptions: this.#agentOptions(conversationKey) } : {}),
      // Setup is the only place a preset can be composed onto an unpublished agent.
      setup: async (agentCtx) => {
        await this.#mountPreset(agentCtx, presetId)
      },
    })
    this.#track(handle, conversationKey)
    await this.store.setSession(conversationKey, sessionId)
    this.logger.info?.(`created session ${sessionId} for ${conversationKey} in ${cwd}`)
    return { agent: handle.agent, sessionId, created: true }
  }

  /**
   * Whether DSH has archived a session. Archived sessions reject every
   * `agent/pre-step`, which surfaces as a `blocked` turn end.
   * @param {string} sessionId - session to test.
   * @returns {boolean} true when the session is archived.
   */
  isArchived(sessionId) {
    try {
      const registry = service(this.ctx, 'workspaceRegistry')
      const archived = registry?.archivedSessionIds
      return Array.isArray(archived) && archived.includes(sessionId)
    } catch (error) {
      this.logger.debug?.(`archive probe failed: ${error?.message ?? error}`)
      return false
    }
  }

  /** Drop the live agent (if any) and the stored binding for one session. */
  async #releaseSession(conversationKey, sessionId) {
    const handle = this.#handles.get(sessionId)
    if (handle) {
      try {
        await handle.dispose()
      } catch (error) {
        this.logger.debug?.(`dispose of archived session failed: ${error?.message ?? error}`)
      }
      this.#handles.delete(sessionId)
    }
    this.#chatOf.delete(sessionId)
    this.#dropPendings(sessionId)
    await this.store.setSession(conversationKey, null)
  }

  /**
   * Drop queued turns for one session, clearing their timers and typing state.
   * Used wherever the turns behind them can no longer produce a `turn/end`
   * (cancellation, `/new`, an archived session, teardown).
   * @param {string} sessionId - session whose queue is dropped.
   * @param {{ keep?: number }} [options] - leading entries to keep (the running turn).
   * @returns {number} how many pending turns were dropped.
   */
  /**
   * (Re)arm one pending turn's deadline: when it becomes the queue head, when its
   * turn starts, and when the previous turn leaves the queue.
   * @param {object} pending - pending turn record.
   */
  #armTurnTimeout(pending) {
    if (pending.abandoned) return
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer)
    const timeoutMs = this.config.turnTimeoutSeconds * 1000
    pending.timeoutTimer = setTimeout(() => this.#onTurnTimeout(pending), timeoutMs)
    if (pending.timeoutTimer.unref) pending.timeoutTimer.unref()
  }

  #dropPendings(sessionId, options = {}) {
    const queue = this.#pending.get(sessionId)
    if (!queue || queue.length === 0) return 0
    const keep = Math.max(0, options.keep ?? 0)
    const dropped = queue.slice(keep)
    const kept = queue.slice(0, keep)
    for (const pending of dropped) {
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer)
      this.#disarmHeartbeat(pending)
      this.#stopTyping(pending)
    }
    if (kept.length > 0) this.#pending.set(sessionId, kept)
    else this.#pending.delete(sessionId)
    return dropped.length
  }

  #track(handle, conversationKey) {
    const sessionId = handle?.agent?.session?.id ?? handle?.agent?.id
    if (!sessionId) return
    this.#handles.set(sessionId, handle)
    this.#chatOf.set(sessionId, conversationKey)
    this.#lastActivity.set(sessionId, Date.now())
    this.#startIdleSweep()
  }

  /** Start the idle sweep once, when the configuration asks for one. */
  #startIdleSweep() {
    if (this.#idleSweep || !this.config.idleDisposeMinutes) return
    const intervalMs = Math.min(this.config.idleDisposeMinutes * 60_000, 60_000)
    this.#idleSweep = setInterval(() => {
      this.disposeIdleAgents().catch((error) => this.logger.debug?.(`idle sweep failed: ${error?.message ?? error}`))
    }, intervalMs)
    if (this.#idleSweep.unref) this.#idleSweep.unref()
  }

  /**
   * Release agents that have been idle for `idleDisposeMinutes`.
   *
   * Long-lived hosts otherwise keep one live agent (and its model context) per
   * WeChat conversation forever. Disposal is safe because the session binding is
   * durable: the next message resumes the same session from the log.
   * @returns {Promise<number>} how many agents were released.
   */
  async disposeIdleAgents() {
    const limitMs = this.config.idleDisposeMinutes * 60_000
    if (!limitMs) return 0
    const now = Date.now()
    let released = 0
    for (const [sessionId, handle] of [...this.#handles]) {
      if ((this.#pending.get(sessionId)?.length ?? 0) > 0) continue
      const last = this.#lastActivity.get(sessionId) ?? 0
      if (now - last < limitMs) continue
      try {
        await handle.dispose()
        released += 1
        this.logger.info?.(`released idle session ${sessionId}; the next message resumes it from its log`)
      } catch (error) {
        this.logger.warn?.(`failed to release idle session ${sessionId}: ${error?.message ?? error}`)
      }
      this.#handles.delete(sessionId)
      this.#lastActivity.delete(sessionId)
    }
    return released
  }

  /**
   * The agent preset to mount on a new or resumed agent.
   *
   * This is what gives a WeChat session its *tools*: the shipped `standard` preset
   * carries `tool-bash`, `tool-fs`, `tool-fs-search`, `plan-mode` and the rest, and
   * presets are mounted per agent — DSH's agent loop never mounts one by itself.
   * Without this the agent can only use globally registered tools (which is why a
   * WeChat session used to answer "I have no way to run commands").
   * @returns {Promise<string|null>} the preset id, or null when none is available.
   */
  async resolveAgentPreset() {
    const presets = service(this.ctx, 'agentPresets')
    if (!presets?.resolve) {
      this.logger.warn?.(
        'agentPresets is unavailable in this profile: WeChat sessions will have no preset tools (no bash/fs editing)',
      )
      return null
    }
    try {
      const resolved = await presets.resolve(this.config.agentPreset ?? undefined)
      if (resolved?.id && resolved.broken !== undefined) {
        this.logger.warn?.(`agent preset "${resolved.id}" is broken: ${JSON.stringify(resolved.broken)}`)
      }
      return resolved?.id ?? null
    } catch (error) {
      this.logger.warn?.(
        `could not resolve agent preset ${this.config.agentPreset ?? '(default)'}: ${error?.message ?? error}`,
      )
      return null
    }
  }

  /**
   * Bind a preset to an agent that is still being composed.
   *
   * `mount` is the documented setup-time path (the client-facing `select` refuses a
   * session whose first turn already opened, so a resumed conversation cannot use it).
   * @param {object} agentCtx - the scoped context handed to `setup`.
   * @param {string|null} presetId - preset to mount.
   * @returns {Promise<void>}
   */
  async #mountPreset(agentCtx, presetId) {
    if (!presetId) return
    const presets = service(this.ctx, 'agentPresets')
    if (!presets?.mount) return
    const mounted = await presets.mount(agentCtx, presetId)
    this.logger.debug?.(`mounted agent preset ${mounted?.id ?? presetId}`)
  }

  /**
   * Model route for a conversation: per-chat override, then plugin config, then
   * the deployment default.
   *
   * The deployment default is not optional decoration: the shipped Web profile
   * renders `You are a coding agent powered by the {{model}} model.` into every
   * system prompt, and that variable is read from the *agent's* options, so an
   * agent created without a route fails assembly before the model is ever called.
   */
  #agentOptions(conversationKey) {
    const reasoning = this.store.state.reasoning?.[conversationKey]
    const override = this.store.state.models?.[conversationKey]
    const configured = override ?? this.config.model
    if (configured?.provider && configured?.model) {
      return {
        provider: configured.provider,
        model: configured.model,
        ...(reasoning || configured.reasoningEffort
          ? { reasoningEffort: reasoning ?? configured.reasoningEffort }
          : {}),
        ...(configured.maxTokens ? { maxTokens: configured.maxTokens } : {}),
      }
    }
    if (configured && typeof configured === 'string') {
      const [provider, model] = configured.split('/')
      if (provider && model) return { provider, model, ...(reasoning ? { reasoningEffort: reasoning } : {}) }
    }

    const defaults = service(this.ctx, 'agentDefaultModel')
    try {
      const selection = defaults?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(reasoning || selection.reasoningEffort
            ? { reasoningEffort: reasoning ?? selection.reasoningEffort }
            : {}),
          ...(selection.maxTokens ? { maxTokens: selection.maxTokens } : {}),
        }
      }
    } catch (error) {
      this.logger.warn?.(`could not read the default model: ${error?.message ?? error}`)
    }
    this.logger.warn?.(
      'no model route available: set `model: provider/model` in the dsh-wechat config, or configure a default model in DSH, otherwise every turn fails during prompt assembly',
    )
    return undefined
  }

  /** Absolute working directory for a conversation's new sessions. */
  async #workspaceFor(conversationKey) {
    const override = this.store.state.workspaces?.[conversationKey]
    if (override) return path.resolve(override)
    if (this.config.workspace) return path.resolve(this.config.workspace)
    try {
      const registry = service(this.ctx, 'workspaceRegistry')
      const entities = registry?.list?.()
      const first = Array.isArray(entities) ? entities.find((entity) => typeof entity?.path === 'string') : undefined
      if (first) return first.path
    } catch (error) {
      this.logger.debug?.(`workspace registry lookup failed: ${error?.message ?? error}`)
    }
    const cwd = process.cwd()
    // A desktop launch can start at the filesystem root, which is never a useful
    // agent workspace; fall back to the home directory instead.
    if (cwd === '/' || cwd === '') return os.homedir()
    return cwd
  }

  // -------------------------------------------------------------------------
  // Streaming and turn completion
  // -------------------------------------------------------------------------

  /**
   * `agent/assistant-stream` listener: collect text per attempt.
   * @param {{ agent: object, frame: object }} payload - stream frame.
   */
  onAgentStream(payload) {
    const sessionId = payload?.agent?.session?.id
    const frame = payload?.frame
    if (!sessionId || !frame) return
    const queue = this.#pending.get(sessionId)
    if (!queue || queue.length === 0) return
    const pending = queue[0]

    if (frame.type === 'start') {
      // A new attempt means the previous step is done: in verbose mode its text
      // is the "process" the user asked to see.
      if (this.config.progress === 'verbose' && pending.pendingFlush && pending.pendingFlush.trim().length > 0) {
        const text = pending.pendingFlush
        pending.pendingFlush = null
        this.deliver(pending.conversationKey, `（过程）\n${normalizeAnswer(text)}`).catch((error) =>
          this.logger.debug?.(`process delivery failed: ${error?.message ?? error}`),
        )
      }
      pending.attempts.set(frame.attemptId, { text: '', turn: frame.turn, step: frame.step })
      pending.lastAttemptId = frame.attemptId
      return
    }
    if (frame.type === 'chunk') {
      if (frame.chunk?.type !== 'text-delta') return
      const attempt = pending.attempts.get(frame.attemptId) ?? { text: '', turn: frame.turn, step: frame.step }
      attempt.text += frame.chunk.text ?? ''
      pending.attempts.set(frame.attemptId, attempt)
      pending.lastAttemptId = frame.attemptId
      return
    }
    if (frame.type === 'end') {
      const attempt = pending.attempts.get(frame.attemptId)
      if (!attempt) return
      // `verbose` shows each intermediate step; the final step still becomes the
      // answer, so intermediate text is only flushed once another step starts.
      if (this.config.progress === 'verbose' && attempt.text.trim().length > 0) {
        pending.pendingFlush = attempt.text
      }
    }
  }

  /**
   * `session/event` listener: progress lines and turn completion.
   * @param {object} session - the session whose log grew.
   * @param {object} event - the appended session event.
   */
  onSessionEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId) return
    // Any traffic on the session — including a GUI turn the plugin did not start —
    // means the agent is not idle.
    if (this.#handles.has(sessionId)) this.#lastActivity.set(sessionId, Date.now())

    const queue = this.#pending.get(sessionId)
    if (!queue || queue.length === 0) {
      // A turn nobody from WeChat asked for: deliver it only if this chat follows
      // the session (/listen). Fire and forget — it must not block the event path.
      void this.#followTurn(sessionId, event)
      return
    }
    const pending = queue[0]

    if (event?.type === 'turn/start') {
      // Name the turn: every later `turn/end` is matched on this number, so an
      // unrelated turn on the same session (the GUI shares it) cannot consume a
      // WeChat message's place in the queue.
      if (pending.turn === null) pending.turn = event.data?.turn ?? null
      // The turn this pending message was waiting for has started: measure the
      // timeout from here, not from the moment the message was typed.
      this.#armTurnTimeout(pending)
      this.#armHeartbeat(pending)
      if (pending.pendingFlush && pending.pendingFlush.trim().length > 0) {
        const text = pending.pendingFlush
        pending.pendingFlush = null
        this.deliver(pending.conversationKey, `（过程）\n${normalizeAnswer(text)}`).catch((error) =>
          this.logger.debug?.(`progress delivery failed: ${error?.message ?? error}`),
        )
      }
      return
    }

    if (event?.type === 'tool/call' && this.config.progress !== 'off' && this.config.showToolProgress) {
      const PROGRESS_CAP = 12
      if (pending.progressSent >= PROGRESS_CAP) {
        if (pending.progressSent === PROGRESS_CAP) {
          pending.progressSent += 1
          this.deliver(pending.conversationKey, `（工具调用较多，后续进度不再逐条推送）`).catch(() => {})
        }
        return
      }
      let args = event.data?.arguments
      try {
        args = args ? JSON.parse(args) : undefined
      } catch {
        // Keep the raw string when the model emitted partial JSON.
      }
      const line = toolProgressLine(event.data?.name ?? 'tool', args)
      pending.progressSent += 1
      pending.lastTool = event.data?.name ?? 'tool'
      this.deliver(pending.conversationKey, line).catch((error) =>
        this.logger.debug?.(`tool progress delivery failed: ${error?.message ?? error}`),
      )
      return
    }

    if (event?.type === 'assistant/message') {
      // Remember this turn's committed text: it is the only correct fallback when
      // the live stream produced nothing, because it belongs to *this* turn.
      if (pending.turn === null || event.data?.turn === pending.turn) {
        const text = messageText(event.data?.message)
        if (text.length > 0) pending.durableText = text
      }
      return
    }

    if (event?.type === 'turn/end') {
      const endedTurn = event.data?.turn
      const owner = this.#pendingOwner(sessionId, endedTurn)
      if (!owner) {
        this.logger.debug?.(`turn/end for turn ${endedTurn} has no queued WeChat message; ignoring`)
        return
      }
      this.#finishTurn(sessionId, event, session, owner).catch((error) =>
        this.logger.error?.('failed to deliver turn result:', error?.message ?? error),
      )
    }
  }

  /**
   * Find the queued message a finished turn belongs to.
   *
   * Matching by turn number is what keeps answers with their question: a turn
   * started by another client on the same session, or a placeholder whose turn
   * never started, must not consume someone else's place in the queue.
   * @param {string} sessionId - session that emitted the event.
   * @param {number|undefined} turn - the ending turn's number.
   * @returns {object|undefined} the pending record to settle.
   */
  #pendingOwner(sessionId, turn) {
    const queue = this.#pending.get(sessionId)
    if (!queue || queue.length === 0) return undefined
    if (turn !== undefined) {
      const exact = queue.find((entry) => entry.turn === turn)
      if (exact) return exact
    }
    // No turn number matched: only a message whose turn never started can be the
    // owner, because any started turn would have been named by `turn/start`.
    const unstarted = queue.find((entry) => entry.turn === null)
    return unstarted
  }

  /** Deliver one finished turn and clean up its pending record. */
  async #finishTurn(sessionId, event, session, pending) {
    const queue = this.#pending.get(sessionId)
    const index = queue ? queue.indexOf(pending) : -1
    if (index >= 0) queue.splice(index, 1)
    if (queue && queue.length === 0) this.#pending.delete(sessionId)
    if (!pending) return
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer)
    this.#disarmHeartbeat(pending)
    // The next queued message is now the running turn: start its clock.
    if (queue && queue.length > 0) this.#armTurnTimeout(queue[0])
    if (pending.abandoned) {
      this.logger.debug?.(`late turn/end for an abandoned turn in ${pending.conversationKey}`)
      this.#stopTyping(pending)
      return
    }

    const lastAttempt = pending.lastAttemptId ? pending.attempts.get(pending.lastAttemptId) : undefined
    // This turn's own text only. Reading the session history here used to
    // re-deliver the *previous* answer whenever a turn streamed nothing.
    let text = normalizeAnswer(lastAttempt?.text ?? '')
    if (text.length === 0) text = normalizeAnswer(pending.durableText)

    const reason = event?.data?.reason
    const kind = reason?.kind ?? 'completed'
    const parts = []
    if (text.length > 0) parts.push(this.#truncateForChat(text))
    if (kind === 'completed') {
      if (text.length === 0) parts.push('（本轮没有文本输出）')
    } else if (kind === 'aborted') {
      parts.push('（已停止）')
    } else if (kind === 'error') {
      const failure = reason?.error
      parts.push(`❌ 回合失败：${failure?.message ?? failure?.code ?? '未知错误'}`)
    } else if (kind === 'max-tokens') {
      parts.push('（达到输出上限，已截断）')
    } else if (kind === 'blocked') {
      const archived = this.isArchived(pending.sessionId)
      parts.push(
        archived
          ? `（回合被拦截：会话 ${pending.sessionId} 已在 DSH 里被归档。发下一条消息我会自动开新会话。）`
          : '（回合被拦截：这一步被某个 agent/pre-step 监听器拒绝，例如钩子或归档策略。可发送 /new 开新会话再试。）',
      )
      if (archived) await this.#releaseSession(pending.conversationKey, pending.sessionId)
    } else if (kind !== 'completed') {
      parts.push(`（回合结束：${kind}）`)
    }

    this.#stopTyping(pending)
    this.#lastActivity.set(sessionId, Date.now())
    await this.deliver(pending.conversationKey, parts.join('\n\n'), { pending })
    await this.store.saveState()
    this.logger.info?.(`turn delivered to ${pending.conversationKey} (${kind}, ${text.length} chars)`)
  }

  /**
   * Turn timeout: tell the user, but KEEP the placeholder in the queue.
   *
   * Removing it would desynchronise the FIFO from the agent's turns: this turn's
   * late `turn/end` would be attributed to the next queued message, and that
   * message's own answer would then be dropped when its turn ends with an empty
   * queue. The placeholder is consumed by the real `turn/end` instead.
   */
  #onTurnTimeout(pending) {
    if (pending.abandoned) return
    pending.abandoned = true
    this.#stopTyping(pending)
    this.deliver(
      pending.conversationKey,
      `⏳ 这一轮超过 ${this.config.turnTimeoutSeconds} 秒仍未结束，先在微信里停止等待；你可以发送 /stop 停止它，或稍后发送 /status 查看状态。`,
    ).catch((error) => this.logger.warn?.('failed to deliver timeout notice:', error?.message ?? error))
  }

  /** Keep the answer within one WeChat-friendly size (chunking still applies). */
  #truncateForChat(text) {
    const limit = this.config.chunkChars * 4
    if (text.length <= limit) return text
    return `${text.slice(0, limit)}\n\n…（回答过长，已截断，完整内容见 DSH 会话记录）`
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Send text into a conversation, split to the configured chunk size.
   * @param {string} conversationKey - `p2p:<userId>` / `group:<id>`.
   * @param {string} text - message text.
   * @param {{ pending?: object }} [options] - pending turn, when its typing state must stay alive.
   * @returns {Promise<number>} how many WeChat messages were sent.
   */
  async deliver(conversationKey, text, options = {}) {
    const userId = userIdOf(conversationKey)
    if (!userId) throw new Error(`dsh-wechat: cannot address conversation ${conversationKey}`)
    const chunks = splitText(normalizeAnswer(text), this.config.chunkChars)
    if (chunks.length === 0) return 0
    const contextToken = this.store.contextTokenFor(userId)
    if (!contextToken) {
      this.logger.warn?.(
        `no context_token cached for ${userId}; WeChat requires one from a recent inbound message, so this send may fail`,
      )
    }
    let sent = 0
    let failed = 0
    for (const chunk of chunks) {
      try {
        // The id is minted once per chunk: a retry after an ambiguous failure must
        // be the *same* message to the gateway, not a second one.
        await this.#sendWithRetry({ toUserId: userId, text: chunk, contextToken, clientId: newClientId() })
        sent += 1
        this.store.rememberOutbound({ toUserId: userId, text: chunk.slice(0, 200) })
      } catch (error) {
        // Keep going: abandoning the loop here used to drop every later chunk,
        // leaving the user with a silently truncated answer and a healthy /status.
        failed += 1
        const detail = error?.message ?? String(error)
        this.logger.error?.(`failed to deliver chunk ${sent + failed}/${chunks.length}: ${detail}`)
        this.store.noteError(`回复发送失败（第 ${sent + failed} 段）：${detail}`)
      }
      if (options.pending) this.#bumpTyping(options.pending)
    }
    if (failed > 0) {
      try {
        await this.#sendWithRetry({
          toUserId: userId,
          text: `⚠️ 有 ${failed} 段回复未能发出，完整内容可在 DSH 会话记录里查看。`,
          contextToken,
          clientId: newClientId(),
        })
      } catch (error) {
        this.logger.warn?.(`could not report the delivery failure: ${error?.message ?? error}`)
      }
    }
    await this.store.saveState()
    return sent
  }

  /**
   * Send one text chunk, retrying once: a transient transport failure at the end
   * of a long turn would otherwise lose the answer the user waited for.
   * @param {{ toUserId: string, text: string, contextToken?: string }} request - send request.
   */
  async #sendWithRetry(request) {
    // `request.clientId` is generated by the caller and reused by the retry.
    try {
      await this.client.sendText(request)
    } catch (error) {
      this.logger.warn?.(`send failed, retrying once: ${error?.message ?? error}`)
      // Ref-ed on purpose: a delivery the user is waiting for must not be lost
      // because the process had nothing else queued.
      await new Promise((resolve) => setTimeout(resolve, 500))
      await this.client.sendText(request)
    }
  }

  /**
   * Whether one conversation may receive a message that the model addressed to it.
   * Only the current conversation, the owner, and allowlisted senders qualify;
   * anything else would turn the bot into an outbound relay.
   * @param {string} targetConversation - destination conversation key.
   * @param {string|undefined} originConversation - conversation the request came from.
   * @returns {boolean} whether the target is permitted.
   */
  maySendTo(targetConversation, originConversation) {
    if (!originConversation) return false
    if (targetConversation === originConversation) return true
    const target = userIdOf(targetConversation)
    if (!target) return false
    if (this.config.ownerUserId && this.config.ownerUserId === target) return true
    return this.config.allowedUserIds.includes(target)
  }

  /**
   * Upload and send one local file.
   * @param {string} conversationKey - destination conversation.
   * @param {string} filePath - local path.
   * @returns {Promise<{ name: string, size: number, mediaType: number }>}
   */
  async deliverFile(conversationKey, filePath) {
    const userId = userIdOf(conversationKey)
    if (!userId) throw new Error(`dsh-wechat: cannot address conversation ${conversationKey}`)
    // The state directory holds the bot credential; a prompt-injected agent must
    // not be able to post it into a chat.
    // Resolve through the *directory*: the file may not exist yet, and both sides
    // must live in one namespace (`/var` and `/private/var` are the same place on
    // macOS, so comparing a resolved root against an unresolved path is useless).
    const root = await resolveReal(this.store.paths.root)
    const resolved = await resolveReal(String(filePath))
    if (isInsideDirectory(root, resolved)) {
      throw new Error(`dsh-wechat: 拒绝发送状态目录内的文件（含机器人凭据）：${resolved}`)
    }
    const result = await uploadLocalFile({
      client: this.client,
      filePath,
      toUserId: userId,
      maxBytes: this.config.media.maxOutboundBytes,
    })
    await this.client.sendMessage({
      toUserId: userId,
      contextToken: this.store.contextTokenFor(userId),
      clientId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      item: result.item,
    })
    this.store.rememberOutbound({ toUserId: userId, text: `[file] ${result.name}` })
    await this.store.saveState()
    return { name: result.name, size: result.size, mediaType: result.mediaType }
  }

  // -------------------------------------------------------------------------
  // Typing indicator
  // -------------------------------------------------------------------------

  #startTyping(pending) {
    if (!this.config.typing) return
    this.#bumpTyping(pending)
    const interval = Math.max(2, this.config.typingKeepaliveSeconds) * 1000
    pending.typingTimer = setInterval(() => this.#bumpTyping(pending), interval)
    if (pending.typingTimer.unref) pending.typingTimer.unref()
  }

  /** Send (or refresh) the "对方正在输入" state for a pending turn. */
  #bumpTyping(pending) {
    if (!this.config.typing) return
    const userId = pending.userId
    const run = async () => {
      const ticket = await this.#typingTicket(userId)
      if (!ticket) return
      await this.client.sendTyping({ ilinkUserId: userId, typingTicket: ticket, status: TYPING.START })
    }
    run().catch((error) => this.logger.debug?.(`typing start failed: ${error?.message ?? error}`))
  }

  #stopTyping(pending) {
    if (pending.typingTimer) {
      clearInterval(pending.typingTimer)
      pending.typingTimer = null
    }
    if (!this.config.typing) return
    const userId = pending.userId
    this.#typingTicket(userId)
      .then((ticket) => {
        if (!ticket) return undefined
        return this.client.sendTyping({ ilinkUserId: userId, typingTicket: ticket, status: TYPING.STOP })
      })
      .catch((error) => this.logger.debug?.(`typing stop failed: ${error?.message ?? error}`))
  }

  /** Fetch and cache the conversation's typing ticket (valid ~a day). */
  async #typingTicket(userId) {
    const cached = this.#typingTickets.get(userId)
    if (cached && Date.now() - cached.at < 20 * 60 * 60 * 1000) return cached.ticket
    try {
      const ticket = await this.client.getConfig({
        ilinkUserId: userId,
        contextToken: this.store.contextTokenFor(userId),
      })
      if (typeof ticket === 'string' && ticket.length > 0) {
        this.#typingTickets.set(userId, { ticket, at: Date.now() })
        return ticket
      }
    } catch (error) {
      this.logger.debug?.(`getconfig failed: ${error?.message ?? error}`)
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Conversation control (commands, tools, lifecycle)
  // -------------------------------------------------------------------------

  /** @returns {object} the context handed to slash-command handlers. */
  async #commandContext(conversationKey, userId) {
    const sessionId = this.store.sessionFor(conversationKey) ?? null
    const isOwner = !this.config.ownerUserId || this.config.ownerUserId === userId
    return { conversationKey, userId, sessionId, config: this.config, bridge: this, isOwner }
  }

  /** @returns {Promise<object>} a status snapshot for `/status` and the info tool. */
  async describeConversation(conversationKey) {
    const sessionId = this.store.sessionFor(conversationKey) ?? null
    const agent = sessionId ? (this.#handles.get(sessionId)?.agent ?? this.agents?.get(sessionId)) : undefined
    return {
      conversationKey,
      userId: userIdOf(conversationKey),
      sessionId,
      workspace: await this.#workspaceFor(conversationKey),
      model: agent ? describeAgentRoute(agent) : (this.#agentOptions(conversationKey) ? `${this.#agentOptions(conversationKey).provider}/${this.#agentOptions(conversationKey).model}` : null),
      agentPreset: agent ? (service(this.ctx, 'agentPresets')?.composedPreset?.(agent.ctx) ?? this.config.agentPreset ?? null) : (this.config.agentPreset ?? null),
      permission: agent?.session
        ? (service(this.ctx, 'permissionPresets')?.current?.(agent.session) ?? null)
        : sessionId
          ? (service(this.ctx, 'permissionPresets')?.current?.(service(this.ctx, 'sessions')?.get?.(sessionId)) ?? null)
          : null,
      following: this.store.isFollowing(conversationKey),
      version: this.store.lastBoot?.version ?? null,
      startedAt: this.store.lastBoot?.at ?? null,
      installedVersion: this.installedVersion,
      runningTurns: sessionId ? (this.#pending.get(sessionId)?.length ?? 0) : 0,
      pendingInteractions: this.interactions.waitingCount(conversationKey),
      connected: this.connected,
      botId: this.botId,
      stats: this.store.state.stats,
    }
  }

  /** `/new`: end the live agent and clear the binding. */
  async resetConversation(conversationKey) {
    const sessionId = this.store.sessionFor(conversationKey)
    if (!sessionId) return null
    const handle = this.#handles.get(sessionId)
    if (handle) {
      try {
        await handle.dispose()
      } catch (error) {
        this.logger.warn?.(`failed to dispose session ${sessionId}: ${error?.message ?? error}`)
      }
      this.#handles.delete(sessionId)
    }
    this.#chatOf.delete(sessionId)
    this.#dropPendings(sessionId)
    await this.store.setSession(conversationKey, null)
    return sessionId
  }

  /**
   * `/stop`: cancel the running turn like the GUI stop button does.
   *
   * `cancel()` also discards the agent's inbox, so every turn queued behind the
   * running one is gone; their placeholders must go with it or the next answer
   * would be attributed to the wrong message.
   * @param {string} conversationKey - conversation to stop.
   * @returns {Promise<{ stopped: boolean, dropped: number }>}
   */
  async stopConversation(conversationKey) {
    const sessionId = this.store.sessionFor(conversationKey)
    if (!sessionId) return { stopped: false, dropped: 0 }
    const agent = this.#handles.get(sessionId)?.agent ?? this.agents?.get(sessionId)
    if (!agent) return { stopped: false, dropped: 0 }
    // `cancel()` clears the agent's inbox, so a message the driver never picked up
    // is gone with no `turn/end` to settle it. Only a turn that actually started
    // keeps its placeholder (its abort does emit an end).
    const queue = this.#pending.get(sessionId) ?? []
    const keep = queue[0]?.turn !== null && queue[0] !== undefined ? 1 : 0
    const dropped = this.#dropPendings(sessionId, { keep })
    try {
      agent.cancel({ kind: 'user' })
      this.logger.info?.(`stopped ${sessionId}; dropped ${dropped} queued message(s)`)
      return { stopped: true, dropped }
    } catch (error) {
      this.logger.warn?.(`failed to cancel session ${sessionId}: ${error?.message ?? error}`)
      return { stopped: false, dropped }
    }
  }

  /** `/workspace <path>`: remember a per-conversation working directory. */
  async setWorkspace(conversationKey, workspacePath) {
    const resolved = await this.resolveWorkspaceArgument(workspacePath)
    this.store.state.workspaces = { ...(this.store.state.workspaces ?? {}), [conversationKey]: resolved }
    await this.store.saveState()
    return resolved
  }

  /**
   * Switch projects in one step: point the conversation at a workspace and make
   * sure the *next* message opens a session there instead of continuing in the
   * old directory.
   * @param {string} conversationKey - conversation to move.
   * @param {string} argument - number, title, or path.
   * @returns {Promise<{ workspace: string, sessionId: string|null }>} the new workspace and any session that was closed.
   */
  async switchWorkspace(conversationKey, argument) {
    const workspace = await this.setWorkspace(conversationKey, argument)
    const previous = await this.resetConversation(conversationKey)
    return { workspace, sessionId: previous }
  }

  /** `/model <provider/model>`: remember a per-conversation model route. */
  async setModel(conversationKey, spec) {
    const [provider, model] = String(spec).split('/')
    if (!provider || !model) throw new Error('模型格式应为 provider/model，例如 deepseek-account/deepseek-flash')
    this.store.state.models = { ...(this.store.state.models ?? {}), [conversationKey]: { provider, model } }
    await this.store.saveState()
    return `${provider}/${model}`
  }

  /** `/reasoning <effort>`: remember a per-conversation reasoning depth. */
  async setReasoning(conversationKey, effort) {
    const value = String(effort ?? '').trim()
    if (value.length === 0) throw new Error('思考深度不能为空')
    this.store.state.reasoning = { ...(this.store.state.reasoning ?? {}), [conversationKey]: value }
    await this.store.saveState()
    return value
  }

  /**
   * Models this deployment can actually offer: every provider route the llm
   * service owns, with the models its adapter advertises. Catalog lookups are
   * advisory, so an empty answer is reported as "follow the default" rather
   * than as an error.
   * @returns {Promise<{ entries: Array<{ label: string, detail?: string }>, note: string|null }>}
   */
  async listModels() {
    const llm = service(this.ctx, 'llm')
    if (!llm?.listProviders) return { entries: [], note: '当前 profile 没有模型服务，可直接用 /model provider/model 指定' }
    try {
      const providers = await llm.listProviders()
      const entries = []
      for (const provider of providers ?? []) {
        const id = typeof provider === 'string' ? provider : (provider?.id ?? provider?.name)
        if (!id) continue
        let models = []
        try {
          models = (await llm.listModels?.(id)) ?? []
        } catch (error) {
          this.logger.debug?.(`listModels(${id}) failed: ${error?.message ?? error}`)
        }
        if (models.length === 0) entries.push({ label: id, detail: '未公布模型清单' })
        for (const model of models) {
          const modelId = typeof model === 'string' ? model : model?.id
          if (!modelId) continue
          entries.push({ label: `${id}/${modelId}`, detail: typeof model === 'object' ? model?.name : undefined })
        }
      }
      return { entries, note: entries.length === 0 ? '当前账号未公布可用模型，可直接用 /model provider/model 指定' : null }
    } catch (error) {
      return { entries: [], note: `读取模型目录失败：${error?.message ?? error}` }
    }
  }

  /**
   * Reasoning depths the current model advertises.
   * @param {string} conversationKey - conversation to resolve the model for.
   * @returns {Promise<{ entries: Array<{ label: string, detail?: string }>, current: string|null, note: string|null }>}
   */
  async listReasoningEfforts(conversationKey) {
    const options = this.#agentOptions(conversationKey)
    const current = options?.reasoningEffort ?? null
    const llm = service(this.ctx, 'llm')
    if (!llm?.resolveModel || !options?.provider || !options?.model) {
      return { entries: [], current, note: '无法读取该模型的思考深度档位；可直接用 /reasoning high 这样的值' }
    }
    try {
      const info = await llm.resolveModel(options.provider, options.model, AbortSignal.timeout(5_000))
      const efforts = info?.reasoning?.efforts ?? []
      return {
        entries: efforts.map((effort) => ({ label: effort.id, detail: effort.name })),
        current: current ?? info?.reasoning?.defaultEffort ?? null,
        note: efforts.length === 0 ? '该模型未声明思考深度档位' : null,
      }
    } catch (error) {
      return { entries: [], current, note: `读取思考深度失败：${error?.message ?? error}` }
    }
  }

  /**
   * Directories this deployment knows about.
   *
   * DSH has no separate "project" entity: a workspace *is* the project directory
   * the agent works in, and its `title` is the friendly name the GUI shows.
   * @returns {Promise<{ entries: Array<{ path: string, title?: string, label: string, detail?: string }>, note: string|null }>}
   */
  async listWorkspaces() {
    try {
      const registry = service(this.ctx, 'workspaceRegistry')
      const entities = registry?.list?.()
      const entries = (Array.isArray(entities) ? entities : [])
        .filter((entity) => typeof entity?.path === 'string')
        .map((entity) => ({
          path: entity.path,
          ...(typeof entity.title === 'string' ? { title: entity.title } : {}),
          label: entity.path,
          ...(typeof entity.title === 'string' ? { detail: entity.title } : {}),
        }))
      return {
        entries,
        note: entries.length === 0 ? 'DSH 里还没有登记工作区；可用 /workspace add /绝对路径 新建一个' : null,
      }
    } catch (error) {
      return { entries: [], note: `读取工作区列表失败：${error?.message ?? error}` }
    }
  }

  /**
   * Resolve a `/workspace` argument: a number picks from the registry, a title
   * picks by friendly name, anything else is treated as a path.
   * @param {string} argument - raw argument.
   * @returns {Promise<string>} the absolute directory to use.
   * @throws {Error} when the directory does not exist.
   */
  async resolveWorkspaceArgument(argument) {
    const { entries } = await this.listWorkspaces()
    const trimmed = String(argument ?? '').trim()
    const index = Number.parseInt(trimmed, 10)
    let candidate = trimmed
    if (Number.isInteger(index) && String(index) === trimmed && index >= 1 && index <= entries.length) {
      candidate = entries[index - 1].path
    } else {
      const byTitle = entries.find((entry) => entry.title && entry.title === trimmed)
      if (byTitle) candidate = byTitle.path
    }
    const absolute = path.resolve(expandHome(unquote(candidate)))
    const info = await stat(absolute).catch(() => null)
    if (!info?.isDirectory()) {
      throw new Error(`工作区路径不存在或不是目录：${absolute}（可用 /workspace add ${absolute} 新建登记）`)
    }
    return absolute
  }

  /**
   * The permission preset (sandbox mode + approval policy) a conversation runs under.
   *
   * DSH records this per session, so this is a durable, per-conversation setting —
   * a WeChat chat bound to a session can be narrowed to `read-only` or widened to
   * `danger-full-access` without touching other chats.
   * @param {string} conversationKey - conversation to inspect.
   * @returns {Promise<{ sessionId: string|null, current: string|null, presets: Array<{ name: string, description?: string }>, note: string|null }>}
   */
  async describePermission(conversationKey) {
    const service_ = service(this.ctx, 'permissionPresets')
    const sessionId = this.store.sessionFor(conversationKey) ?? null
    if (!service_?.names) {
      return { sessionId, current: null, presets: [], note: '当前 profile 没有权限预设服务（dsh-permission-presets）' }
    }
    const live = sessionId ? service(this.ctx, 'sessions')?.get?.(sessionId) : null
    const catalog = service_.catalog?.()
    const presets = (catalog?.options ?? service_.names.map((name) => ({ value: name })))
      .filter((option) => option?.value && option.value !== 'custom')
      .map((option) => ({ name: option.value, ...(option.description ? { description: option.description } : {}) }))
    return {
      sessionId,
      current: live ? (service_.current?.(live) ?? null) : null,
      presets,
      note: live ? null : '这个对话还没有跑起来（先发一条消息，我才能读到/切换它的权限）',
    }
  }

  /**
   * Switch one conversation's permission preset.
   * @param {string} conversationKey - conversation to change.
   * @param {string} name - preset name, e.g. `workspace-write`.
   * @returns {Promise<{ sessionId: string, current: string|null, changed: boolean }>}
   * @throws {Error} when the preset is unknown or unavailable in this profile.
   */
  async setPermission(conversationKey, name) {
    const service_ = service(this.ctx, 'permissionPresets')
    if (!service_?.set) throw new Error('当前 profile 没有权限预设服务，无法切换权限')
    if (!service_.names?.includes(name)) {
      throw new Error(`没有这个权限模式：${name}（可选：${(service_.names ?? []).join(' / ')}）`)
    }
    // A preset is a property of a live session, so make sure this chat has one.
    const { sessionId } = await this.ensureAgent(conversationKey, this.store.ownerUserId ?? conversationKey.replace(/^p2p:/, ''))
    const live = service(this.ctx, 'sessions')?.get?.(sessionId)
    if (!live) throw new Error(`读不到会话 ${sessionId}（可能刚被回收，再发一条消息后重试）`)
    const before = service_.current?.(live) ?? null
    service_.set(live, name)
    const after = service_.current?.(live) ?? null
    this.logger.info?.(`permission for ${conversationKey} on ${sessionId}: ${before} -> ${after}`)
    return { sessionId, current: after, changed: before !== after }
  }

  /**
   * Turn the "follow this conversation" feed on or off.
   *
   * With the feed on, answers produced in the bound session are pushed to WeChat even
   * when another client started the turn — the GUI, a tool, another WeChat chat that
   * released the binding. Turns this chat started are unaffected (they already flow
   * back through the pending queue), so nothing is delivered twice.
   * @param {string} conversationKey - conversation to toggle.
   * @param {boolean} on - desired state.
   * @returns {Promise<{ following: boolean, sessionId: string|null }>}
   */
  async setFollow(conversationKey, on) {
    if (on) {
      // Following needs something to follow: bind (or create) the session first.
      const { sessionId } = await this.ensureAgent(conversationKey, this.store.ownerUserId ?? conversationKey.replace(/^p2p:/, ''))
      await this.store.setFollow(conversationKey, true)
      return { following: true, sessionId }
    }
    await this.store.setFollow(conversationKey, false)
    return { following: false, sessionId: this.store.sessionFor(conversationKey) ?? null }
  }

  /**
   * Arm the "still working" heartbeat for one WeChat-initiated turn.
   *
   * Only turns this chat started get heartbeats: those are the ones a person is
   * waiting on, and a chat runs exactly one of them at a time (the queue is serial).
   * Followed turns from other clients never arm it — they arrive as a single `📥`
   * result, so no heartbeat can be mistaken for another session's traffic.
   * @param {object} pending - the queued turn that just started running.
   * @returns {void}
   */
  #armHeartbeat(pending) {
    const seconds = this.config.progressHeartbeatSeconds
    if (!seconds || seconds <= 0) return
    if (pending.heartbeatTimer) clearInterval(pending.heartbeatTimer)
    const timer = setInterval(() => {
      if (pending.abandoned || pending.heartbeats >= HEARTBEAT_CAP) {
        if (pending.heartbeats >= HEARTBEAT_CAP) this.#disarmHeartbeat(pending)
        return
      }
      pending.heartbeats += 1
      const elapsed = Math.max(0, Math.round((Date.now() - pending.startedAt) / 1000))
      const minutes = Math.floor(elapsed / 60)
      const spent = minutes > 0 ? `${minutes} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`
      const what = pending.lastTool ? `｜最后一步：${pending.lastTool}` : ''
      this.deliver(pending.conversationKey, `🔄 仍在处理中…（已 ${spent}${what}）`).catch((error) =>
        this.logger.debug?.(`heartbeat delivery failed: ${error?.message ?? error}`),
      )
    }, seconds * 1000)
    // A heartbeat must never hold the process open by itself.
    if (typeof timer.unref === 'function') timer.unref()
    pending.heartbeatTimer = timer
  }

  /**
   * Stop the heartbeat of a turn that ended, was dropped or was abandoned.
   * @param {object} pending - the turn to silence.
   * @returns {void}
   */
  #disarmHeartbeat(pending) {
    if (!pending?.heartbeatTimer) return
    clearInterval(pending.heartbeatTimer)
    pending.heartbeatTimer = null
  }

  /** @returns {boolean} whether this conversation follows its session's turns. */
  isFollowing(conversationKey) {
    return this.store.isFollowing(conversationKey)
  }

  /**
   * Push one followed turn to WeChat, if this chat asked to receive it.
   *
   * Only turns with no queued WeChat message are candidates: a WeChat-initiated turn
   * is delivered by the pending path, with its own progress and timeout handling.
   * @param {string} sessionId - session the turn ran in.
   * @param {object} event - the session event.
   * @returns {Promise<void>}
   */
  async #followTurn(sessionId, event) {
    if ((this.#pending.get(sessionId)?.length ?? 0) > 0) {
      this.#followBuffers.delete(sessionId)
      return
    }
    const conversationKey = this.conversationForSession(sessionId)
    if (!conversationKey || !this.store.isFollowing(conversationKey)) {
      this.#followBuffers.delete(sessionId)
      return
    }

    if (event?.type === 'assistant/message') {
      const text = messageText(event.data?.message)
      if (text.length > 0) {
        const buffer = this.#followBuffers.get(sessionId) ?? { turn: null, text: '' }
        buffer.text = text
        if (event.data?.turn !== undefined) buffer.turn = event.data.turn
        this.#followBuffers.set(sessionId, buffer)
      }
      return
    }

    if (event?.type !== 'turn/end') return
    const buffer = this.#followBuffers.get(sessionId)
    this.#followBuffers.delete(sessionId)
    const reason = event.data?.reason?.kind ?? 'completed'
    const text = buffer?.text?.trim() ?? ''
    if (text.length === 0 && reason === 'completed') {
      this.logger.debug?.(`followed turn ${event.data?.turn} in ${sessionId} produced no text; nothing to forward`)
      return
    }
    const label = sessionId.slice(-8)
    const body =
      text.length > 0
        ? `📥 其他客户端在会话 …${label} 里跑完了一轮：\n\n${normalizeAnswer(text)}`
        : `📥 其他客户端在会话 …${label} 里的一轮结束了（${reason}），没有文本输出。`
    await this.deliver(conversationKey, body).catch((error) =>
      this.logger.warn?.(`followed delivery failed: ${error?.message ?? error}`),
    )
  }

  /**
   * Conversations (DSH sessions) that live in one workspace.
   *
   * DSH has no separate "project" entity, but a workspace holds many sessions, and
   * this is how the plugin lets a chat pick one. The list comes from the same
   * `sessionQuery` corpus the GUI lists, so persisted conversations appear even
   * when no agent is running for them.
   * @param {string} conversationKey - conversation asking.
   * @returns {Promise<{ entries: Array<{ id: string, title?: string, createdAt?: number, live: boolean, current: boolean }>, workspace: string, note: string|null }>}
   */
  async listSessions(conversationKey) {
    const workspace = await this.#workspaceFor(conversationKey)
    const bound = this.store.sessionFor(conversationKey) ?? null
    const agentRegistry = this.agents
    const found = new Map()
    const notes = []
    /** Which source produced what — surfaced by `/session sources` for diagnosis. */
    const diagnostics = { live: 0, indexed: 0, registered: 0, titleBatch: 'not attempted', titleSingles: null, titles: 0 }

    /** @param {string} id - session id. @param {{ createdAt?: number, indexed: boolean, parent?: string, cwd?: string }} info */
    const remember = (id, info) => {
      if (typeof id !== 'string' || id.length === 0) return
      const existing = found.get(id)
      found.set(id, {
        id,
        ...(info.createdAt ?? existing?.createdAt ? { createdAt: info.createdAt ?? existing?.createdAt } : {}),
        ...(info.parent ?? existing?.parent ? { parent: info.parent ?? existing?.parent } : {}),
        ...(info.cwd ?? existing?.cwd ? { cwd: info.cwd ?? existing?.cwd } : {}),
        live: Boolean(this.#handles.get(id) ?? agentRegistry?.get(id)),
        current: id === bound,
        indexed: Boolean(info.indexed || existing?.indexed),
      })
    }

    // Source 1: live sessions. They are the most immediate truth and the only
    // source that works in a minimal profile without the query service.
    try {
      const store = service(this.ctx, 'sessions')
      for (const session of store?.list?.() ?? []) {
        const cwd = session?.header?.cwd
        if (cwd === undefined || !samePath(cwd, workspace)) continue
        remember(session.header.id, { createdAt: session.header.createdAt, indexed: true, cwd: session.header.cwd })
        diagnostics.live += 1
      }
    } catch (error) {
      notes.push(`活动会话读取失败：${error?.message ?? error}`)
    }

    // Source 2: the session query corpus — live sessions plus whatever its index
    // has observed. In the shipped Web profile that index is in-memory and lazy,
    // so it frequently knows less than the workspace registry does.
    const query = service(this.ctx, 'sessionQuery')
    if (query?.listSessions) {
      try {
        const records = await query.listSessions(AbortSignal.timeout(15_000))
        for (const record of records ?? []) {
          const header = record?.header
          if (header?.cwd === undefined || !samePath(header.cwd, workspace)) continue
          remember(header.id, { createdAt: header.createdAt, indexed: true, parent: header.parentSession, cwd: header.cwd })
          diagnostics.indexed += 1
        }
      } catch (error) {
        notes.push(`会话索引读取失败：${error?.message ?? error}`)
      }
    } else {
      notes.push('当前 profile 没有会话查询服务')
    }

    // Source 3: the workspace registry's durable membership. This is what makes
    // the conversations the GUI shows visible even when the index has not seen them.
    let workspaceEntity = null
    try {
      const registry = service(this.ctx, 'workspaceRegistry')
      const entities = registry?.list?.()
      workspaceEntity = (Array.isArray(entities) ? entities : []).find((entity) => samePath(entity?.path, workspace)) ?? null
      for (const id of workspaceEntity?.sessionIds ?? []) {
        remember(id, { indexed: false })
        diagnostics.registered += 1
      }
    } catch (error) {
      notes.push(`工作区登记读取失败：${error?.message ?? error}`)
    }

    const all = [...found.values()].map((entry) => ({ ...entry, title: undefined }))
    // The GUI's conversation list shows top-level sessions; child sessions (subagents)
    // and archived conversations are not switchable targets here either.
    const children = all.filter((entry) => entry.parent !== undefined && entry.id !== bound)
    const archived = all.filter((entry) => entry.parent === undefined && this.isArchived(entry.id))
    diagnostics.children = children.length
    diagnostics.archived = archived.length
    const entries = all
      .filter((entry) => (entry.parent === undefined || entry.id === bound) && !this.isArchived(entry.id))
      .sort((left, right) => {
        if (left.current !== right.current) return left.current ? -1 : 1
        return (right.createdAt ?? 0) - (left.createdAt ?? 0)
      })
      .slice(0, 20)

    // Titles: the same log-backed fold the GUI uses (`session/title` events). One
    // batch call first; if it fails or skips a row, retry that row individually so a
    // single unreadable session cannot strip the names off all the others.
    const missing = () => entries.filter((entry) => !entry.title)
    if (query?.readTitleSnapshots && entries.length > 0) {
      try {
        const snapshots = await query.readTitleSnapshots(entries.map((entry) => entry.id), AbortSignal.timeout(20_000))
        entries.forEach((entry, index) => {
          const result = snapshots?.[index]
          if (result?.status !== 'fulfilled') return
          const text = titleText(result.value?.title) ?? titleText(result.value)
          if (text) entry.title = text
        })
        diagnostics.titleBatch = 'ok'
      } catch (error) {
        diagnostics.titleBatch = `failed: ${error?.message ?? error}`
        this.logger.debug?.(`title fold failed: ${error?.message ?? error}`)
      }
    } else {
      diagnostics.titleBatch = query ? 'unavailable' : 'no sessionQuery service'
    }
    if (query?.readTitle && missing().length > 0) {
      const rows = missing()
      const settled = await Promise.allSettled(
        rows.map((entry) => query.readTitle(entry.id, AbortSignal.timeout(5_000))),
      )
      settled.forEach((result, index) => {
        if (result.status !== 'fulfilled') return
        const text = titleText(result.value)
        if (text) rows[index].title = text
      })
      diagnostics.titleSingles = `${settled.filter((row) => row.status === 'fulfilled' && row.value).length}/${rows.length}`
    }
    const titles = service(this.ctx, 'sessionTitle')
    for (const entry of entries) {
      if (entry.title) continue
      const live = entry.id === bound ? (this.#handles.get(entry.id)?.agent ?? agentRegistry?.get(entry.id)) : agentRegistry?.get(entry.id)
      if (!live) continue
      try {
        const title = titleText(titles?.get?.(live.session))
        if (title) entry.title = title
      } catch (error) {
        this.logger.debug?.(`live title read failed: ${error?.message ?? error}`)
      }
    }

    if (children.length > 0) notes.push(`已隐藏 ${children.length} 个子会话`)
    if (archived.length > 0) notes.push(`已隐藏 ${archived.length} 个已归档对话`)
    diagnostics.titles = entries.filter((entry) => entry.title).length
    diagnostics.workspace = workspace
    return { entries, workspace, note: notes.length > 0 ? notes.join('；') : null, diagnostics }
  }

  /**
   * Point a conversation at an existing DSH session, so the next message continues
   * that conversation instead of the current one.
   * @param {string} conversationKey - conversation to rebind.
   * @param {string} reference - session index from the listing, or a session id.
   * @returns {Promise<{ sessionId: string, previous: string|null }>}
   * @throws {Error} when the reference cannot be resolved to a session.
   */
  async bindSession(conversationKey, reference) {
    const { entries } = await this.listSessions(conversationKey)
    const trimmed = String(reference ?? '').trim()
    const labelOf = (id) => entries.find((entry) => entry.id === id)?.title ?? null
    const index = Number.parseInt(trimmed, 10)
    const byIndex =
      Number.isInteger(index) && String(index) === trimmed && index >= 1 && index <= entries.length
        ? entries[index - 1]
        : undefined
    const chosen = byIndex ?? entries.find((entry) => entry.id === trimmed)
    if (!chosen) {
      // Archived conversations are kept out of the list, so a direct hit needs to
      // explain itself instead of claiming the session does not exist.
      if (this.isArchived(trimmed)) {
        throw new Error(`对话 ${trimmed} 已在 DSH 里被归档，先在 GUI 取消归档再切换`)
      }
      throw new Error(`找不到这个对话：${trimmed}（发送 /session 查看编号）`)
    }
    if (this.isArchived(chosen.id)) {
      throw new Error(`对话 ${chosen.id} 已在 DSH 里被归档，先在 GUI 取消归档再切换`)
    }
    // One session belongs to one WeChat chat at a time: two chats driving the same
    // conversation would interleave their turns and each would receive the other's
    // answers. The holder releases it with `/session new` (or by switching away).
    const holder = this.conversationForSession(chosen.id)
    if (holder && holder !== conversationKey) {
      throw new Error(
        `对话「${chosen.title ?? chosen.id.slice(-8)}」正绑定在微信会话 ${maskConversation(holder)} 上；` +
          '让对方发 /session new 释放后再切，或改选别的对话',
      )
    }

    const previous = await this.resetConversation(conversationKey)
    // The switch itself is a plain rebind: the conversation keeps its history and the
    // next message resumes it. The pending question only decides how much of that
    // history is echoed back to WeChat as a recap.
    await this.store.setSession(conversationKey, chosen.id)
    await this.store.setPendingSwitch(conversationKey, {
      sessionId: chosen.id,
      ...(chosen.title ? { title: chosen.title } : {}),
      ...(chosen.cwd ? { cwd: chosen.cwd } : {}),
    })
    return {
      sessionId: chosen.id,
      title: chosen.title ?? null,
      previous,
      previousTitle: previous ? labelOf(previous) : null,
    }
  }

  /**
   * Read the last few exchanges of a conversation, for a recap sent to WeChat.
   *
   * `segments` counts user turns: one segment is the user message plus the answer
   * that followed it, which is what "N 段" means to a person reading the chat.
   * @param {string} sessionId - conversation to read.
   * @param {number} segments - how many recent exchanges to keep (1-99).
   * @returns {Promise<string|null>} formatted recap, or null when unavailable.
   */
  async #contextDigest(sessionId, segments) {
    const query = service(this.ctx, 'sessionQuery')
    if (!query?.readSession) return null
    const loaded = await query.readSession(sessionId)
    const events = (loaded?.events ?? []).filter(
      (event) => event?.type === 'user/message' || event?.type === 'assistant/message',
    )
    if (events.length === 0) return null
    const text = (event) => {
      const content = event.data?.message?.content ?? event.data?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join(' ')
      }
      return ''
    }
    // Walk backwards collecting user-anchored exchanges, then restore order.
    const chunks = []
    let taken = 0
    for (let index = events.length - 1; index >= 0 && taken < segments; index -= 1) {
      const event = events[index]
      const line = text(event).trim()
      if (line.length === 0) continue
      const role = event.type === 'user/message' ? '用户' : '助手'
      chunks.unshift(`${role}：${line.length > 800 ? `${line.slice(0, 800)}…` : line}`)
      if (event.type === 'user/message') taken += 1
    }
    if (chunks.length === 0) return null
    const joined = chunks.join('\n')
    return joined.length > 8_000 ? joined.slice(-8_000) : joined
  }

  /**
   * Apply the answer to "带多少段上下文？".
   * @param {string} conversationKey - conversation that switched.
   * @param {number} segments - 0-99; 0 means start clean.
   * @returns {Promise<{ title: string|null, segments: number, digest: string|null }>}
   */
  async applyContextChoice(conversationKey, segments) {
    const pending = this.store.pendingSwitchFor(conversationKey)
    if (!pending) throw new Error('当前没有待确认的对话切换，先发送 /session 查看列表')
    await this.store.setPendingSwitch(conversationKey, null)
    if (segments === 0) return { title: pending.title ?? null, segments, digest: null, delivered: false }
    const digest = await this.#contextDigest(pending.sessionId, segments)
    if (digest) {
      await this.deliver(
        conversationKey,
        `【「${pending.title ?? pending.sessionId}」的最近 ${segments} 段回执】\n${digest}`,
      )
    }
    return { title: pending.title ?? null, segments, digest, delivered: digest !== null }
  }

  /**
   * Register a directory as a DSH workspace, creating the record the GUI shows.
   * @param {string} workspacePath - absolute directory.
   * @param {string} [title] - friendly name.
   * @returns {Promise<string>} the registered path.
   */
  async addWorkspace(workspacePath, title) {
    const registry = service(this.ctx, 'workspaceRegistry')
    if (!registry?.create) throw new Error('当前 profile 没有工作区注册表，无法登记新工作区')
    const absolute = path.resolve(expandHome(unquote(workspacePath)))
    const created = await registry.create(absolute, title || path.basename(absolute))
    return created?.path ?? absolute
  }

  /** @returns {Promise<string>} the per-conversation settings summary. */
  async describeSettings(conversationKey) {
    const options = this.#agentOptions(conversationKey)
    const workspace = await this.#workspaceFor(conversationKey)
    return [
      '当前会话设置：',
      `· 工作区：${workspace}`,
      `· 模型：${options?.provider && options?.model ? `${options.provider}/${options.model}` : '（跟随 DSH 默认）'}`,
      `· 思考深度：${options?.reasoningEffort ?? '（跟随 DSH 默认）'}`,
      '',
      '改法：/workspace 1 · /model 2 · /reasoning 3（不带参数会先列出可选项）',
    ].join('\n')
  }

  /** `/login` help text. */
  loginHint() {
    const dir = this.store.paths.root
    const pageUrl = this.loginPageUrl
    return [
      '重新扫码登录：',
      ...(pageUrl ? [`1. 在同一台机器上用浏览器打开扫码页：${pageUrl}`] : []),
      `${pageUrl ? '2' : '1'}. 或执行：node <插件目录>/bin/dsh-wechat.mjs login --page`,
      `${pageUrl ? '3' : '2'}. 也可直接打开状态目录里的 login-qrcode.svg 扫码`,
      `凭据与状态目录：${dir}`,
    ].join('\n')
  }

  /** `/logout`: forget the bot credential. */
  async logout() {
    await this.store.clearCredentials()
    this.setConnected(false)
    return '已清除本机保存的微信机器人凭据。重新登录：node <插件目录>/bin/dsh-wechat.mjs login'
  }

  /** Dispose every agent this bridge created (plugin unload). */
  async disposeAll() {
    if (this.#idleSweep) {
      clearInterval(this.#idleSweep)
      this.#idleSweep = null
    }
    for (const pending of [...this.#pending.values()].flat()) {
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer)
      this.#disarmHeartbeat(pending)
      this.#stopTyping(pending)
    }
    this.#pending.clear()
    const handles = [...this.#handles.values()]
    this.#handles.clear()
    this.#chatOf.clear()
    await Promise.all(
      handles.map((handle) =>
        Promise.resolve()
          .then(() => handle.dispose())
          .catch((error) => this.logger.debug?.(`agent dispose failed: ${error?.message ?? error}`)),
      ),
    )
  }
}

/**
 * Extract the WeChat user id from a conversation key.
 * @param {string} conversationKey - `p2p:<userId>` or `group:<id>`.
 * @returns {string|undefined} the user id iLink expects as `to_user_id`.
 */
export function userIdOf(conversationKey) {
  if (typeof conversationKey !== 'string') return undefined
  if (conversationKey.startsWith('p2p:')) return conversationKey.slice(4)
  return undefined
}
