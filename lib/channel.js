/**
 * Connection lifecycle: log in, long-poll `getupdates` forever, recover.
 *
 * The receive loop is intentionally boring: one request at a time, the server's
 * cursor persisted after every batch, a small backoff on failure, and a hard stop
 * with a re-login when iLink answers `ret: -14` (session expired) — because that
 * is the one error the binary cannot retry its way out of.
 *
 * @module dsh-wechat/channel
 */

import { ILinkError, isSessionExpired } from './ilink/api.js'
import { sleep } from './waits.js'

/** Backoff schedule: quick retries first, then a long pause. */
const RETRY_DELAY_MS = 2_000
const RETRY_DELAY_AFTER_FAILURES_MS = 30_000
const FAILURES_BEFORE_LONG_BACKOFF = 3

/**
 * The plugin never launches a program: no subprocess API is imported anywhere here.
 * The scan-page address is logged (and written to `login-page.url`) so the operator
 * can open it in whichever browser they prefer.
 */

export class WechatChannel {
  /**
   * @param {object} options - channel options.
   * @param {object} options.config - normalized configuration.
   * @param {import('./store.js').WechatStore} options.store - durable state.
   * @param {import('./bridge.js').WechatBridge} options.bridge - message bridge.
   * @param {{ info: Function, warn: Function, debug: Function, error: Function }} options.logger
   * @param {(credentials: object|null) => import('./ilink/api.js').ILinkClient} options.createClient
   *   builds a transport for the given credentials (or unauthenticated when null).
   */
  constructor(options) {
    this.config = options.config
    /** @type {string|null} the bot this loop receives for; one channel per bot. */
    this.botId = options.botId ?? null
    this.store = options.store
    this.bridge = options.bridge
    this.logger = options.logger
    this.createClient = options.createClient
    this.controller = new AbortController()
    this.done = null
    this.client = null
  }

  /** @returns {AbortSignal} the signal that stops the loop. */
  get signal() {
    return this.controller.signal
  }

  /** Start the receive loop. Resolves when the loop exits. */
  async start() {
    if (this.done) return this.done
    // Stopped before it ever started (the plugin was unloaded while the credential was
    // loading): an aborted controller must not open a poll loop, announce a lifecycle
    // start, or mark the channel connected.
    if (this.controller.signal.aborted) return undefined
    this.done = this.#run().catch((error) => {
      this.logger.error?.('receive loop stopped unexpectedly:', error?.message ?? error)
    })
    return this.done
  }

  /** Stop the loop and wait for it to unwind. */
  async stop() {
    this.controller.abort()
    try {
      await this.done
    } catch {
      // The loop already logged its own failure.
    }
  }

  async #run() {
    while (!this.signal.aborted) {
      let ready = false
      try {
        ready = await this.#ensureCredential()
      } catch (error) {
        // A gateway or network failure while logging in is a "not ready yet", not
        // a reason to stop receiving for the lifetime of the process.
        this.logger.warn?.(`登录流程失败：${error?.message ?? error}`)
        this.store.noteError(`登录失败：${error?.message ?? error}`)
      }
      if (!ready) {
        if (!this.config.autoLogin) {
          this.logger.warn?.('没有可用凭据且 autoLogin 已关闭；运行 dsh-wechat login 后重启 DSH')
          return
        }
        // A transient login failure (network, gateway hiccup) must not stop the
        // bot for the lifetime of the process: retry on a slow loop instead.
        this.logger.warn?.('登录未完成，60 秒后重试')
        await sleep(60_000, this.signal)
        continue
      }
      await this.#pollUntilFailure()
      if (this.signal.aborted) return
      this.logger.info?.('重新登录后继续接收消息…')
    }
  }

  /**
   * Attach the transport for this bot.
   *
   * Sign-in is orchestrated by the plugin (settings card, or the CLI), so a receive loop
   * without a credential has nothing to do: it reports that and stops instead of starting a
   * second login that would compete for the card's single code.
   * @returns {Promise<boolean>} whether a transport is ready.
   */
  async #ensureCredential() {
    const credentials = this.store.credentialsFor(this.botId)
    if (!credentials) {
      this.logger.warn?.(
        `bot ${this.botId} 还没有凭据，跳过接收（在 DSH 设置 → 微信 → 添加绑定，或运行 dsh-wechat login）`,
      )
      return false
    }
    this.client = this.createClient(credentials)
    this.bridge.updateClient(this.botId, this.client)
    this.bridge.setConnected(true, this.botId)
    return true
  }

  /** One login session's worth of polling, until it fails or is aborted. */
  async #pollUntilFailure() {
    let failures = 0
    let cursor = this.store.cursorFor(this.botId)
    if (this.config.notifyLifecycle) await this.client.notifyLifecycle('start')
    this.logger.info?.('微信消息接收已启动（长轮询 ilink/bot/getupdates）')

    try {
      while (!this.signal.aborted) {
        try {
          const startedAt = Date.now()
          const batch = await this.client.getUpdates({ cursor, signal: this.signal })
          failures = 0
          // The gateway normally holds the request ~35s. If it answers instantly
          // with nothing, pace the next poll instead of spinning on the socket.
          if (batch.msgs.length === 0 && Date.now() - startedAt < 1_000) await sleep(1_000, this.signal)
          // The cursor is persisted *after* the batch is handled: saving it first
          // would lose every message of the batch if the process died mid-loop.
          const nextCursor = batch.cursor && batch.cursor !== cursor ? batch.cursor : null
          for (const message of batch.msgs) {
            if (this.signal.aborted) return
            try {
              await this.bridge.handleInbound(message, this.botId)
            } catch (error) {
              this.logger.error?.('failed to handle an inbound message:', error?.message ?? error)
              this.store.noteError(error?.message ?? String(error))
            }
          }
          if (nextCursor) {
            cursor = nextCursor
            await this.store.setCursor(cursor, this.botId)
          }
        } catch (error) {
          if (this.signal.aborted) return
          if (isSessionExpired(error)) {
            this.logger.warn?.('微信会话已过期（ret=-14），清除凭据并重新登录')
            this.bridge.setConnected(false, this.botId)
            await this.store.clearCredentials(this.botId)
            this.store.noteError('会话已过期，需要重新扫码登录')
            return
          }
          failures += 1
          const detail = error instanceof ILinkError ? `${error.message}${error.status ? ` [HTTP ${error.status}]` : ''}` : String(error?.message ?? error)
          this.store.noteError(detail)
          const wait = failures >= FAILURES_BEFORE_LONG_BACKOFF ? RETRY_DELAY_AFTER_FAILURES_MS : RETRY_DELAY_MS
          this.logger.warn?.(`接收消息失败（第 ${failures} 次）：${detail}；${wait / 1000} 秒后重试`)
          await sleep(wait, this.signal)
        }
      }
    } finally {
      if (this.config.notifyLifecycle && this.client) {
        try {
          await this.client.notifyLifecycle('stop')
        } catch {
          // Lifecycle hints are best effort.
        }
      }
      this.bridge.setConnected(false)
    }
  }
}

/** Sleep that wakes early when the signal aborts. */
