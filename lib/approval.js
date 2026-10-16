/**
 * Approvals and questions, answered from the chat.
 *
 * Both arrive as cordis waterfalls (`approval/request`, `user-questions/request`).
 * This router claims only the requests whose session belongs to a WeChat
 * conversation, asks the user in that conversation, and returns the decision the
 * harness expects. Anything it cannot answer is delegated with `next()` so the
 * desktop UI keeps working exactly as before.
 *
 * @module dsh-wechat/approval
 */

/**
 * Turn an approval reason into text a person can read.
 *
 * The host may send a string or a structure (`{ code, message, … }`); the structure used
 * to be interpolated as-is, so every card said `原因：[object Object]`.
 * @param {unknown} reason - the request's reason value.
 * @returns {string} readable text, or an empty string when there is nothing to show.
 */
export function readableReason(reason) {
  if (reason === undefined || reason === null) return ''
  if (typeof reason === 'string') return reason.trim()
  if (typeof reason === 'number' || typeof reason === 'boolean') return String(reason)
  if (typeof reason === 'object') {
    const record = reason
    for (const key of ['message', 'description', 'text', 'summary']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    if (record.code !== undefined) {
      const extra = typeof record.detail === 'string' ? `（${record.detail}）` : ''
      return `${String(record.code)}${extra}`
    }
    try {
      const json = JSON.stringify(record)
      if (json && json !== '{}') return json
    } catch {
      // Circular or otherwise unprintable: fall through to "no reason".
    }
  }
  return ''
}

/** Outcomes the host itself accepts; anything else means "that side did not decide". */
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled'])

/** Host error code meaning "no answerer accepted the request" for user questions. */
const NO_ANSWERER = 'NO_PROVIDER'

/**
 * Whether a value from the other client is a real answer batch.
 * The host answers with `{ answers: [...] }`; anything else (undefined, a sentinel, a
 * different shape) means that side did not decide.
 * @param {unknown} value - the value the other answerer resolved with.
 * @returns {boolean} true when it is an answer batch.
 */
function isAnswerBatch(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.answers)
}

/** Words that approve a request. */
const APPROVE = ['允许', '同意', '批准', '确认', '可以', '好', '好的', 'y', 'yes', 'ok', 'allow', 'approve', '1']
/** Words that reject a request. */
const REJECT = ['拒绝', '不允许', '不同意', '否', '不要', 'no', 'n', 'reject', 'deny', '2']
/** Words that withdraw a request. */
const CANCEL = ['取消', '撤销', '算了', 'cancel', 'stop', '3']

/** @param {string} text - raw user reply. @returns {string} comparable form. */
function normalizeReply(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[。.!！?？\s]+$/g, '')
}

/**
 * Interpret one chat reply as an approval decision.
 * @param {string} text - the reply.
 * @returns {'allow'|'reject'|'cancel'|null} the decision, or null when unclear.
 */
export function parseApprovalReply(text) {
  const normalized = normalizeReply(text)
  if (normalized.length === 0) return null
  if (APPROVE.includes(normalized)) return 'allow'
  if (REJECT.includes(normalized)) return 'reject'
  if (CANCEL.includes(normalized)) return 'cancel'
  return null
}

/**
 * Render one approval request as chat text.
 * @param {object} request - the `approval/request` payload.
 * @returns {string} the message to send.
 */
export function formatApprovalPrompt(request) {
  const lines = ['🔐 需要你确认一个操作']
  if (request?.toolName) lines.push(`工具：${request.toolName}`)
  // The reason arrives as a structure (the host ships `{ code, message }` and friends), so
  // interpolating it printed `[object Object]` into the chat.
  const reason = readableReason(request?.displayReason ?? request?.reason)
  if (reason) lines.push(`原因：${reason}`)
  lines.push('')
  lines.push('回复「允许」或「拒绝」；回复「取消」可撤回本次请求。')
  return lines.join('\n')
}

/**
 * Render one user-questions request as chat text.
 * @param {Array<object>} questions - the request's question list.
 * @returns {string} the message to send.
 */
export function formatQuestionsPrompt(questions) {
  const lines = ['❓ Agent 需要你的回答']
  for (const [index, question] of (questions ?? []).entries()) {
    const heading = question?.header ? `${question.header} ` : ''
    lines.push('')
    lines.push(`${questions.length > 1 ? `${index + 1}. ` : ''}${heading}${question?.question ?? ''}`)
    for (const [optionIndex, option] of (question?.options ?? []).entries()) {
      const suffix = option?.description ? ` — ${option.description}` : ''
      lines.push(`  ${optionIndex + 1}) ${option?.label ?? ''}${suffix}`)
    }
    if (question?.multi_select) lines.push('  （可多选：回复多个序号，用逗号分隔）')
  }
  lines.push('')
  lines.push(
    (questions ?? []).some((question) => (question?.options ?? []).length > 0)
      ? '回复序号或选项文字（如「2」或「方案 B」）都行；也可以直接回复你自己的答案。'
      : '直接回复你的答案。',
  )
  return lines.join('\n')
}

/**
 * Turn one chat reply into the harness's answer batch.
 * @param {Array<object>} questions - the asked questions.
 * @param {string} text - the reply.
 * @returns {{ answers: Array<{ id: string, selected: string[], custom?: string }> } | null}
 *   the answer batch, or null when it cannot be interpreted.
 */
/**
 * Resolve one reply fragment to an option index.
 *
 * Numbers were the only accepted form, so a person who answered "方案 A" (or "B") produced
 * `{ selected: [], custom: '方案 A' }` — the harness saw "no option chosen, some free text"
 * even though the choice was unambiguous.
 *
 * Matching order, strictest first: a bare position number, the exact label, the reply as a
 * distinctive prefix of one label (ending on punctuation such as `：`), one label as a
 * prefix of the reply, and finally a standalone short token that appears in exactly one
 * label (`B` for `方案 B：…`). A genuinely free sentence matches none of them and stays free
 * text.
 * @param {Array<{label?: string}>} options - the question's options.
 * @param {string} part - one reply fragment.
 * @returns {number} zero-based option index, or -1 when nothing matches.
 */
function matchOption(options, part) {
  const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const text = normalize(part)
  if (text.length === 0) return -1

  if (/^\d{1,2}[.、,)）]?$/.test(text)) {
    const index = Number.parseInt(text, 10)
    if (index >= 1 && index <= options.length) return index - 1
  }

  const labels = options.map((option) => normalize(option?.label))
  const exact = labels.indexOf(text)
  if (exact >= 0) return exact

  /** A boundary that makes a partial match a choice rather than prose. */
  const boundary = /^[：:、.，,)）\-—]/

  const prefixHits = []
  labels.forEach((label, index) => {
    if (label.startsWith(text) && boundary.test(label.slice(text.length))) prefixHits.push(index)
  })
  if (prefixHits.length === 1) return prefixHits[0]

  const labelHits = []
  labels.forEach((label, index) => {
    if (label.length > 0 && text.startsWith(label) && boundary.test(text.slice(label.length))) labelHits.push(index)
  })
  if (labelHits.length === 1) return labelHits[0]

  // A short standalone token ("B", "3") that occurs in exactly one label.
  if (/^[a-z0-9]{1,2}$/.test(text)) {
    const token = new RegExp(`(^|[^a-z0-9])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
    const tokenHits = labels.map((label, index) => (token.test(label) ? index : -1)).filter((index) => index >= 0)
    if (tokenHits.length === 1) return tokenHits[0]
  }
  return -1
}

export function parseQuestionsReply(questions, text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return null
  const list = Array.isArray(questions) ? questions : []
  if (list.length === 0) return null

  // Commas only: option labels routinely contain spaces ("方案 A：微信侧实现"), so splitting
  // on whitespace tore a single answer into fragments that matched nothing.
  const parts = trimmed
    .split(/[，,、]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const answers = []

  if (list.length === 1) {
    const question = list[0]
    const options = question?.options ?? []
    if (question?.multi_select) {
      const selected = []
      for (const part of parts) {
        const index = matchOption(options, part)
        if (index >= 0) selected.push(options[index]?.label)
      }
      if (selected.length > 0) return { answers: [{ id: question.id, selected }] }
      return { answers: [{ id: question.id, selected: [], custom: trimmed }] }
    }
    // The whole reply first, so a label that reads like a sentence still matches.
    const index = matchOption(options, trimmed)
    if (index >= 0) {
      return { answers: [{ id: question.id, selected: [options[index]?.label] }] }
    }
    return { answers: [{ id: question.id, selected: [], custom: trimmed }] }
  }

  // Several questions: one reply per line, each answered with an option number
  // or an own answer, in the order the questions were asked.
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  // A single line holding every answer, separated by commas or spaces ("1 2",
  // "直接发到微信, 不用记"): mapped in question order.
  if (lines.length < list.length && lines.length === 1) {
    const combined = lines[0].split(/[，,、]+/).map((part) => part.trim()).filter(Boolean)
    const fragments = combined.length > 1 ? combined : lines[0].split(/\s+/).filter(Boolean)
    if (fragments.length >= list.length) {
      const inline = []
      let usable = true
      for (const [position, question] of list.entries()) {
        const options = question?.options ?? []
        const fragment = fragments[position] ?? ''
        const index = matchOption(options, fragment)
        if (index >= 0) {
          inline.push({ id: question.id, selected: [options[index]?.label] })
          continue
        }
        // A question that offers options must be answered by one of them here; otherwise
        // an ordinary sentence with a comma ("等一下，我先看看") would be filed as the
        // answer to every question at once.
        if (options.length > 0) {
          usable = false
          break
        }
        inline.push({ id: question.id, selected: [], custom: fragment })
      }
      if (usable && inline.length === list.length) return { answers: inline }
    }
  }
  // One line per question, or the reply is ambiguous: answering every question
  // with the same last line silently mis-reports what the user chose.
  if (lines.length < list.length) return null
  for (const [position, question] of list.entries()) {
    const line = lines[position] ?? ''
    const options = question?.options ?? []
    const index = matchOption(options, line)
    if (index >= 0) {
      answers.push({ id: question.id, selected: [options[index]?.label] })
    } else {
      answers.push({ id: question.id, selected: [], custom: line })
    }
  }
  return { answers }
}

/**
 * Routes chat replies to the approval or question that is waiting for them.
 */
export class InteractionRouter {
  /**
   * @param {object} options - router options.
   * @param {object} options.config - normalized plugin configuration.
   * @param {{ info: Function, warn: Function, debug: Function }} options.logger
   * @param {(conversationKey: string, text: string) => Promise<void>} options.send
   *   sends one message into a conversation.
   * @param {(sessionId: string) => string|undefined} options.conversationOf
   * @param {(sessionId: string) => boolean} [options.ownsInteraction] - whether the
   *   WeChat chat is driving the turn that raised this interaction. Only then may the
   *   router claim it: claiming consumes the waterfall, so a question raised by a turn
   *   the user started in the GUI would otherwise never reach the GUI's own dialog.
   *   maps a session id to the conversation that owns it.
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.send = options.send
    this.conversationOf = options.conversationOf
    this.ownsInteraction = options.ownsInteraction ?? (() => true)
    /**
     * Whether this chat *follows* the session (`/listen`). Following means "I am
     * watching this conversation from my phone", so its interactions are offered to
     * both surfaces and answered by whichever replies first — instead of being claimed
     * exclusively by one of them.
     */
    this.watchesInteraction = options.watchesInteraction ?? (() => false)
    this.pending = new Map()
  }

  /**
   * Register one pending interaction.
   * @param {string} conversationKey - chat waiting for a reply.
   * @param {{ kind: 'approval'|'question', timeoutMs: number, onReply: (text: string) => boolean|'pending' }} entry
   * @returns {() => void} a cancel function that drops the pending entry.
   */
  #push(conversationKey, entry) {
    const queue = this.pending.get(conversationKey) ?? []
    const record = { ...entry, settled: false, abort: null }
    queue.push(record)
    this.pending.set(conversationKey, queue)
    return () => {
      record.settled = true
      const current = this.pending.get(conversationKey) ?? []
      const next = current.filter((item) => item !== record)
      if (next.length > 0) this.pending.set(conversationKey, next)
      else this.pending.delete(conversationKey)
    }
  }

  /**
   * Hand one chat reply to the oldest waiting interaction.
   *
   * `onReply` may report three outcomes: not consumed (`false`, the message goes on to the
   * agent), consumed and finished (`true`, the record leaves the queue), or consumed while
   * the interaction stays open (`'pending'` — a card holding several questions collects one
   * answer at a time).
   * @param {string} conversationKey - the conversation that received the text.
   * @param {string} text - the reply.
   * @returns {boolean} true when the reply was consumed and must not start a turn.
   */
  tryConsume(conversationKey, text) {
    const queue = this.pending.get(conversationKey)
    if (!queue || queue.length === 0) return false
    const record = queue[0]
    if (record.settled) {
      queue.shift()
      return this.tryConsume(conversationKey, text)
    }
    const consumed = record.onReply(text)
    if (consumed === true) {
      queue.shift()
      if (queue.length === 0) this.pending.delete(conversationKey)
    }
    return consumed !== false
  }

  /** @returns {boolean} whether a conversation is waiting for an answer. */
  isWaiting(conversationKey) {
    const queue = this.pending.get(conversationKey)
    return Boolean(queue && queue.length > 0)
  }

  /** @returns {number} how many interactions are waiting in one conversation. */
  waitingCount(conversationKey) {
    return this.pending.get(conversationKey)?.length ?? 0
  }

  /**
   * One reminder per interaction when a reply could not be understood.
   *
   * The message itself still goes to the agent (it may be a legitimate new
   * instruction), but the user must learn that the pending question is still open.
   * @param {string} conversationKey - conversation to inspect.
   * @returns {string|null} the reminder text, or null when nothing needs saying.
   */
  hintFor(conversationKey) {
    const queue = this.pending.get(conversationKey)
    if (!queue || queue.length === 0) return null
    const record = queue[0]
    if (record.hinted) return null
    record.hinted = true
    // The kind string must match what #push() registers ('question'), otherwise a pending
    // question nudged the person to answer an approval that did not exist.
    return record.kind === 'question'
      ? [
          '（提示：上面那个提问还没回答，微信这边先等你。）',
          '· 用序号或选项文字都行（例如「2」或「方案 B」）；',
          '· 多个问题可以一条消息里一行一个，也可以逐条回答；',
          '· 不想在微信答就回「取消」，这一轮交回原来的客户端。',
        ].join('\n')
      : '（提示：上面那个操作还在等你确认，回复「允许」或「拒绝」。）'
  }

  /**
   * Release every waiting interaction (plugin unload). Without this the plugin's
   * own timers would keep the process alive and a late reply would start a turn.
   * @param {string} [reason] - how the waiters are settled.
   */
  dispose(reason = '插件已卸载') {
    for (const [conversationKey, queue] of [...this.pending]) {
      for (const record of queue) {
        record.settled = true
        try {
          record.abort?.(reason)
        } catch (error) {
          this.logger?.debug?.(`aborting a pending interaction failed: ${error?.message ?? error}`)
        }
      }
      this.pending.delete(conversationKey)
    }
  }

  /**
   * Ask the client that is *also* showing this request to close its dialog.
   *
   * The only dismissal channel the remote UI honours is `request.signal` — the same
   * signal the host's `decide()` races against and resolves as "cancelled". Aborting
   * while the request is pending therefore turns a WeChat "allow" into a denial (that
   * bug shipped once). The host removes its own abort listener as soon as its answer
   * settles, so dispatching the abort *after* that point is — in principle — only a
   * dismissal. This waits for that window, and does nothing when the signal is absent.
   * @param {object} request - the interaction request.
   * @returns {void}
   */
  #dismissRemoteDialog(request) {
    if (this.config.closeRemoteDialogAfterAnswer === false) return
    const signal = request?.signal
    if (!signal || typeof signal.dispatchEvent !== 'function') return
    const timer = setTimeout(() => {
      try {
        signal.dispatchEvent(new Event('abort'))
        this.logger?.debug?.('asked the other client to close its dialog')
      } catch (error) {
        this.logger?.debug?.(`could not ask the other client to close: ${error?.message ?? error}`)
      }
    }, 50)
    if (timer.unref) timer.unref()
  }

  /**
   * The `approval/request` waterfall listener.
   * @param {object} request - approval request payload.
   * @param {() => Promise<unknown>} next - delegate to the next answerer.
   * @returns {Promise<string|unknown>} the outcome.
   */
  async handleApproval(request, next) {
    const sessionId = request?.agent?.session?.id
    const conversationKey = sessionId ? this.conversationOf(sessionId) : undefined
    if (!conversationKey) return next()
    if (!this.config.approvalTimeoutSeconds) return next()
    const owns = this.ownsInteraction(sessionId)
    const watched = this.watchesInteraction(sessionId)
    if (!owns && !watched) {
      // The turn belongs to another client (the GUI, a job) and this chat is not
      // following the session. Leave the request in the waterfall so that client shows
      // its own dialog.
      this.logger?.debug?.(`approval in ${sessionId} was not started from WeChat; leaving it to its own client`)
      return next()
    }
    // Offer the card to both surfaces whenever this chat is involved in the turn: the
    // person may be at the desk (answer in the GUI) or away (answer here). "Involved"
    // means WeChat started the turn, or the chat follows the session (/listen).

    const timeoutMs = this.config.approvalTimeoutSeconds * 1000
    this.logger?.debug?.(`approval requested for ${conversationKey}: ${request?.toolName ?? 'unknown tool'}`)

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (run) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        drop()
        request?.signal?.removeEventListener?.('abort', onAbort)
        try {
          // A branch may hand the decision to another answerer; that promise has to be
          // threaded through, otherwise the request never settles and the turn hangs.
          const result = run()
          if (result && typeof result.then === 'function') result.then(resolve, reject)
        } catch (error) {
          reject(error)
        }
      }
      // The reply slot is claimed before the prompt goes out: a user who answers
      // instantly must not race the registration.
      const drop = this.#push(conversationKey, {
        kind: 'approval',
        timeoutMs,
        onReply: (text) => {
          const decision = parseApprovalReply(text)
          if (decision === null) return false
          // Settle first — never abort while the request is pending, or the host's
          // decide() would resolve it as "cancelled" instead of our answer — then ask the
          // other client to close the dialog it is still showing.
          if (decision === 'allow') finish(() => resolve('allowed-once'))
          else if (decision === 'reject') finish(() => resolve('rejected'))
          else finish(() => resolve('cancelled'))
          this.#dismissRemoteDialog(request)
          return true
        },
      })
      // In racing mode the other client answers in parallel; its promise decides the
      // outcome when our card expires or when it replies first.
      const delegated = Promise.resolve().then(() => next())
      delegated.then(
        (value) => {
          if (settled) return
          if (!APPROVAL_OUTCOMES.has(value)) {
            // The other side has no answerer (the host's terminal resolves "unavailable")
            // or returned something the host would not accept: keep waiting here instead
            // of voiding the card the person is looking at.
            this.logger?.debug?.(
              `approval for ${conversationKey}: other side reported ${JSON.stringify(value)}; keeping the WeChat card`,
            )
            return
          }
          finish(() => {
            this.send(conversationKey, '✅ 已在原来的客户端上回答，微信这边这张卡作废。').catch(() => {})
            return resolve(value)
          })
        },
        (error) => {
          this.logger?.debug?.(
            `approval for ${conversationKey}: other side failed (${error?.message ?? error}); keeping the WeChat card`,
          )
        },
      )
      const timer = setTimeout(() => {
        // Our card expired, but the other client may still answer: withdraw ours and hand
        // the decision over (finish threads the promise, so this always settles).
        this.logger?.info?.(`approval for ${conversationKey} expired in WeChat; leaving the decision to the other client`)
        finish(() => {
          this.send(conversationKey, '⌛️ 微信这边的确认已超时，这一轮交给原来的客户端继续等你回答。').catch(() => {})
          return delegated
        })
      }, timeoutMs)
      if (timer.unref) timer.unref()
      const record = (this.pending.get(conversationKey) ?? []).at(-1)
      if (record) record.abort = () => finish(() => resolve('cancelled'))
      const onAbort = () => finish(() => resolve('cancelled'))
      request?.signal?.addEventListener?.('abort', onAbort, { once: true })
      if (request?.signal?.aborted) {
        onAbort()
        return
      }
      Promise.resolve()
        .then(() => this.send(conversationKey, formatApprovalPrompt(request)))
        .catch((error) => {
          this.logger?.warn?.('failed to deliver approval prompt:', error?.message ?? error)
          finish(() => delegated)
        })
    })
  }

  /**
   * The `user-questions/request` waterfall listener.
   * @param {object} request - question request payload.
   * @param {() => Promise<unknown>} next - delegate to the next answerer.
   * @returns {Promise<unknown>} the answer batch.
   */
  async handleQuestions(request, next) {
    const sessionId = request?.agent?.session?.id
    const conversationKey = sessionId ? this.conversationOf(sessionId) : undefined
    if (!conversationKey) return next()
    if (!this.config.questionsTimeoutSeconds) return next()
    const owns = this.ownsInteraction(sessionId)
    const watched = this.watchesInteraction(sessionId)
    if (!owns && !watched) {
      this.logger?.debug?.(`questions in ${sessionId} were not started from WeChat; leaving them to their own client`)
      return next()
    }
    const questions = request?.questions ?? []
    if (questions.length === 0) return next()

    const timeoutMs = this.config.questionsTimeoutSeconds * 1000
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (run) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        drop()
        request?.signal?.removeEventListener?.('abort', onAbort)
        try {
          // A branch may hand the decision to another answerer; that promise has to be
          // threaded through, otherwise the request never settles and the turn hangs.
          const result = run()
          if (result && typeof result.then === 'function') result.then(resolve, reject)
        } catch (error) {
          reject(error)
        }
      }
      // Following (/listen): the other client keeps its dialog and either side may answer.
      const delegated = Promise.resolve().then(() => next())
      delegated.then(
        (value) => {
          if (settled) return
          if (!isAnswerBatch(value)) {
            // Same reasoning as approvals: only a real answer batch counts as "the other
            // side answered". Anything else means nobody there could take it.
            this.logger?.debug?.(
              `questions for ${conversationKey}: other side returned ${JSON.stringify(value)}; keeping the WeChat card`,
            )
            return
          }
          finish(() => {
            this.send(conversationKey, '✅ 已在原来的客户端上回答，微信这边这张卡作废。').catch(() => {})
            return resolve(value)
          })
        },
        (error) => {
          if (settled) return
          // The host rejects with NO_PROVIDER when nobody else can answer: that is not a
          // decision, so the card here stays live.
          if (error?.code === NO_ANSWERER || /no user-questions answerer/i.test(String(error?.message ?? ''))) {
            this.logger?.debug?.(`questions for ${conversationKey}: no other answerer; keeping the WeChat card`)
            return
          }
          finish(() => reject(error))
        },
      )
      // Claimed before delivery, for the same reason as approvals.
      /**
       * Answers collected so far, in question order.
       *
       * A card can hold several questions, and the natural way to answer in a chat is one
       * message per question. Requiring both answers in a single message (one line each)
       * meant "1" did nothing at all — the report that started this fix.
       */
      const collected = []
      const drop = this.#push(conversationKey, {
        kind: 'question',
        timeoutMs,
        onReply: (text) => {
          // A) 取消 first: the card tells the person they may send it, and for a
          //    single-question card every other reply parses as a free-text answer — so
          //    checking the batch first swallowed "取消" as the answer itself.
          if (/^(取消|算了|不答了|cancel|skip)$/i.test(String(text ?? '').trim())) {
            finish(() => {
              this.send(conversationKey, '✅ 微信这边不回答了，这一轮交回原来的客户端。').catch(() => {})
              return delegated
            })
            return true
          }
          // B) The whole batch at once: one line per question, or all answers on one line.
          const batch = parseQuestionsReply(questions, text)
          if (batch !== null) {
            finish(() => resolve(batch))
            this.#dismissRemoteDialog(request)
            return true
          }
          // C) One question at a time: take the reply as the answer to the next unanswered
          //    question, but only when it actually picks an option — otherwise an unrelated
          //    message ("等一下") would be swallowed as an answer.
          const nextQuestion = questions[collected.length]
          if (!nextQuestion) return false
          const single = parseQuestionsReply([nextQuestion], text)
          const answer = single?.answers?.[0]
          if (!answer || (answer.selected?.length ?? 0) === 0) return false
          collected.push(answer)
          if (collected.length === questions.length) {
            finish(() => resolve({ answers: collected }))
            this.#dismissRemoteDialog(request)
            return true
          }
          const remaining = questions.length - collected.length
          const upcoming = questions[collected.length]
          this.send(
            conversationKey,
            [
              `✅ 已记录第 ${collected.length} 个回答，还剩 ${remaining} 个：`,
              `  ${upcoming?.question ?? ''}`,
              ...(upcoming?.options ?? []).map((option, index) => `  ${index + 1}) ${option?.label ?? ''}`),
            ].join('\n'),
          ).catch((error) => this.logger?.warn?.('failed to acknowledge a partial answer:', error?.message ?? error))
          // 'pending': the reply was consumed, but the card still waits for the rest.
          return 'pending'
        },
      })
      const timer = setTimeout(() => {
        this.logger?.info?.(`questions for ${conversationKey} expired in WeChat; leaving the answer to the other client`)
        finish(() => {
          this.send(conversationKey, '⌛️ 微信这边的回答已超时，这一轮交给原来的客户端继续等你回答。').catch(() => {})
          return delegated
        })
      }, timeoutMs)
      if (timer.unref) timer.unref()
      const record = (this.pending.get(conversationKey) ?? []).at(-1)
      if (record) record.abort = () => finish(() => reject(new Error('插件卸载，提问已取消')))
      const onAbort = () => finish(() => reject(new Error('user-questions request aborted')))
      request?.signal?.addEventListener?.('abort', onAbort, { once: true })
      if (request?.signal?.aborted) {
        onAbort()
        return
      }
      Promise.resolve()
        .then(() => this.send(conversationKey, formatQuestionsPrompt(questions)))
        .catch((error) => {
          this.logger?.warn?.('failed to deliver question prompt:', error?.message ?? error)
          finish(() => delegated)
        })
    })
  }
}
