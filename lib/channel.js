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

import { spawn } from 'node:child_process'

import { ILinkError, isSessionExpired } from './ilink/api.js'
import { sleep } from './waits.js'
import { qrLogin } from './login.js'

/** Backoff schedule: quick retries first, then a long pause. */
const RETRY_DELAY_MS = 2_000
const RETRY_DELAY_AFTER_FAILURES_MS = 30_000
const FAILURES_BEFORE_LONG_BACKOFF = 3

/**
 * Whether a string is something a browser launcher may be handed.
 *
 * `/usr/bin/open ''` does not fail: it opens the *current working directory* in
 * Finder, and `xdg-open ''` / `cmd /c start ''` are no safer. An unusable value
 * must therefore never reach the launcher at all.
 * @param {unknown} value - candidate URL.
 * @returns {boolean} true for an absolute http(s) URL.
 */
export function isLaunchableUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
}

/**
 * Open a URL in the operator's default browser, best effort.
 * @param {string} url - absolute http(s) URL; anything else is refused.
 * @param {{ debug?: Function }} [logger] - diagnostics sink.
 * @param {{ spawn?: Function, platform?: string }} [internals] - injection seam for tests.
 * @returns {boolean} whether a launcher was spawned.
 */
export function openInBrowser(url, logger, internals = {}) {
  if (!isLaunchableUrl(url)) {
    logger?.debug?.(`refusing to launch a browser for a non-http(s) URL: ${JSON.stringify(url)}`)
    return false
  }
  const target = String(url).trim()
  const platform = internals.platform ?? process.platform
  const command =
    platform === 'darwin' ? ['open', [target]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : ['xdg-open', [target]]
  const launch = internals.spawn ?? spawn
  try {
    // `windowsHide` keeps `cmd /c start` from flashing a console window.
    const child = launch(command[0], command[1], { stdio: 'ignore', detached: true, windowsHide: true })
    child.on?.('error', (error) => logger?.debug?.(`could not open a browser: ${error?.message ?? error}`))
    child.unref?.()
    return true
  } catch (error) {
    logger?.debug?.(`could not open a browser: ${error?.message ?? error}`)
    return false
  }
}

export class WechatChannel {
  /**
   * @param {object} options - channel options.
   * @param {object} options.config - normalized configuration.
   * @param {import('./store.js').WechatStore} options.store - durable state.
   * @param {import('./bridge.js').WechatBridge} options.bridge - message bridge.
   * @param {{ info: Function, warn: Function, debug: Function, error: Function }} options.logger
   * @param {(credentials: object|null) => import('./ilink/api.js').ILinkClient} options.createClient
   *   builds a transport for the given credentials (or unauthenticated when null).
   * @param {import('./loginpage.js').LoginPage} [options.loginPage] - page that shows the scan code.
   */
  constructor(options) {
    this.config = options.config
    this.store = options.store
    this.bridge = options.bridge
    this.logger = options.logger
    this.createClient = options.createClient
    this.loginPage = options.loginPage ?? null
    this.controller = new AbortController()
    this.done = null
    this.client = null
    this.openedLoginPage = false
  }

  /** @returns {AbortSignal} the signal that stops the loop. */
  get signal() {
    return this.controller.signal
  }

  /** Start the receive loop. Resolves when the loop exits. */
  async start() {
    if (this.done) return this.done
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

  /** Ensure a credential exists and the transport is authenticated. */
  async #ensureCredential() {
    if (!this.store.loggedIn) {
      if (!this.config.autoLogin) {
        this.logger.warn?.(
          '尚未绑定微信机器人。请在运行 DSH 的机器上执行 `node <插件目录>/bin/dsh-wechat.mjs login`，或在插件配置中开启 autoLogin 后重启 DSH。',
        )
        return false
      }
      this.logger.info?.('尚未绑定微信机器人，开始扫码登录流程')
      const unauthenticated = this.createClient(null)
      this.loginPage?.publish({ phase: 'waiting', detail: null })
      this.#openLoginPageOnce()
      const credentials = await qrLogin({
        client: unauthenticated,
        store: this.store,
        logger: this.logger,
        paths: this.store.paths,
        signal: this.signal,
        printTerminal: !this.loginPage,
        onQr: (qr) => this.loginPage?.publish({ payload: qr.payload, qrcode: qr.qrcode }),
        onStatus: (status) => this.loginPage?.publish({ phase: status === 'wait' ? 'waiting' : status }),
        shouldRestart: () => {
          if (!this.loginPage?.restartRequested) return false
          this.loginPage.restartRequested = false
          this.logger.info?.('收到「重新申请二维码」请求')
          return true
        },
      })
      if (!credentials) return false
    }
    this.client = this.createClient(this.store.credentials)
    this.bridge.updateClient(this.client)
    this.bridge.setConnected(true, this.store.credentials?.botId ?? null)
    return true
  }

  /** Open the scan page once per process, so the operator sees the code immediately. */
  #openLoginPageOnce() {
    if (this.openedLoginPage) return
    this.openedLoginPage = true
    const url = this.loginPage?.preferredUrl
    if (!url) {
      if (this.config.loginPage && this.config.openLoginPage && this.config.autoLogin) {
        this.logger.warn?.('扫码页尚未就绪，请查看日志中的地址，或运行 dsh-wechat login 手动绑定')
      }
      return
    }
    this.logger.info?.(`请在浏览器里打开以下地址扫码绑定：${url}`)
    if (this.config.openLoginPage) {
      openInBrowser(url, this.logger)
    }
  }

  /** One login session's worth of polling, until it fails or is aborted. */
  async #pollUntilFailure() {
    let failures = 0
    let cursor = this.store.cursor
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
              await this.bridge.handleInbound(message)
            } catch (error) {
              this.logger.error?.('failed to handle an inbound message:', error?.message ?? error)
              this.store.noteError(error?.message ?? String(error))
            }
          }
          if (nextCursor) {
            cursor = nextCursor
            await this.store.setCursor(cursor)
          }
        } catch (error) {
          if (this.signal.aborted) return
          if (isSessionExpired(error)) {
            this.logger.warn?.('微信会话已过期（ret=-14），清除凭据并重新登录')
            this.bridge.setConnected(false)
            await this.store.clearCredentials()
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
