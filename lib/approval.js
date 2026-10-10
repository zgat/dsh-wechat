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
  const reason = request?.displayReason ?? request?.reason
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
      ? '直接回复序号，或回复你自己的答案。'
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
export function parseQuestionsReply(questions, text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return null
  const list = Array.isArray(questions) ? questions : []
  if (list.length === 0) return null

  const parts = trimmed
    .split(/[，,、\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const answers = []

  if (list.length === 1) {
    const question = list[0]
    const options = question?.options ?? []
    if (question?.multi_select) {
      const selected = []
      for (const part of parts) {
        const index = Number.parseInt(part, 10)
        if (Number.isInteger(index) && index >= 1 && index <= options.length) selected.push(options[index - 1].label)
      }
      if (selected.length > 0) return { answers: [{ id: question.id, selected }] }
      return { answers: [{ id: question.id, selected: [], custom: trimmed }] }
    }
    const index = Number.parseInt(parts[0], 10)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return { answers: [{ id: question.id, selected: [options[index - 1].label] }] }
    }
    return { answers: [{ id: question.id, selected: [], custom: trimmed }] }
  }

  // Several questions: one reply per line, each answered with an option number
  // or an own answer, in the order the questions were asked.
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  // One line per question, or the reply is ambiguous: answering every question
  // with the same last line silently mis-reports what the user chose.
  if (lines.length < list.length) return null
  for (const [position, question] of list.entries()) {
    const line = lines[position] ?? ''
    const options = question?.options ?? []
    const index = Number.parseInt(line, 10)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      answers.push({ id: question.id, selected: [options[index - 1].label] })
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
   * @param {{ kind: 'approval'|'question', timeoutMs: number, onReply: (text: string) => boolean }} entry
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
    if (consumed) {
      queue.shift()
      if (queue.length === 0) this.pending.delete(conversationKey)
    }
    return consumed
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
    return record.kind === 'questions'
      ? '（提示：上面那个提问还在等你回答。回答后我再继续；要放弃就回「取消」。）'
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
    // Following (/listen): race instead of claiming, so the client that started the turn
    // keeps its own dialog and either side may answer.
    const racing = watched

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
          run()
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
          if (decision === 'allow') finish(() => resolve('allowed-once'))
          else if (decision === 'reject') finish(() => resolve('rejected'))
          else finish(() => resolve('cancelled'))
          // Settle first, *then* dismiss the other client: `finish` removes our own abort
          // listener, so this dispatch cannot be mistaken for the host cancelling us.
          if (racing) request?.signal?.dispatchEvent?.(new Event('abort'))
          return true
        },
      })
      // In racing mode the other client answers in parallel; its promise decides the
      // outcome when our card expires or when it replies first.
      const delegated = racing ? Promise.resolve().then(() => next()) : null
      if (delegated) {
        delegated.then(
          (value) => {
            if (settled) return
            finish(() => {
              this.send(conversationKey, '✅ 已在原来的客户端上回答，微信这边这张卡作废。').catch(() => {})
              return resolve(value)
            })
          },
          (error) => finish(() => reject(error)),
        )
      }
      const timer = setTimeout(() => {
        if (racing) {
          // Our card expired, but the other client may still answer: withdraw ours and
          // wait for it instead of resolving on its behalf.
          this.logger?.info?.(`approval for ${conversationKey} expired in WeChat; leaving the decision to the other client`)
          finish(() => {
            this.send(conversationKey, '⌛️ 微信这边的确认已超时，这一轮交给原来的客户端继续等你回答。').catch(() => {})
            return delegated
          })
          return
        }
        finish(() => {
          this.logger?.info?.(`approval for ${conversationKey} timed out; delegating to the next answerer`)
          next().then(resolve, reject)
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
          finish(() => (delegated ? delegated : next().then(resolve, reject)))
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
    const racing = watched
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
          run()
        } catch (error) {
          reject(error)
        }
      }
      // Following (/listen): the other client keeps its dialog and either side may answer.
      const delegated = racing ? Promise.resolve().then(() => next()) : null
      if (delegated) {
        delegated.then(
          (value) => {
            if (settled) return
            finish(() => {
              this.send(conversationKey, '✅ 已在原来的客户端上回答，微信这边这张卡作废。').catch(() => {})
              return resolve(value)
            })
          },
          (error) => finish(() => reject(error)),
        )
      }
      // Claimed before delivery, for the same reason as approvals.
      const drop = this.#push(conversationKey, {
        kind: 'question',
        timeoutMs,
        onReply: (text) => {
          const batch = parseQuestionsReply(questions, text)
          if (batch === null) return false
          finish(() => resolve(batch))
          // After settling, so our own abort listener is already detached.
          if (racing) request?.signal?.dispatchEvent?.(new Event('abort'))
          return true
        },
      })
      const timer = setTimeout(() => {
        if (racing) {
          this.logger?.info?.(`questions for ${conversationKey} expired in WeChat; leaving the answer to the other client`)
          finish(() => {
            this.send(conversationKey, '⌛️ 微信这边的回答已超时，这一轮交给原来的客户端继续等你回答。').catch(() => {})
            return delegated
          })
          return
        }
        finish(() => {
          this.logger?.info?.(`questions for ${conversationKey} timed out; delegating to the next answerer`)
          next().then(resolve, reject)
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
          finish(() => (delegated ? delegated : next().then(resolve, reject)))
        })
    })
  }
}
