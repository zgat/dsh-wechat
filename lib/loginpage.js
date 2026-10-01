/**
 * The login page: a tiny loopback HTTP server that shows the WeChat scan code.
 *
 * Why a page of our own instead of a GUI plugin: the app's web server requires
 * `dsh web` authentication, and a host-only plugin has no supported way to
 * contribute renderer UI. A one-page loopback server needs neither, works in
 * every profile (desktop, web, headless), and is reachable from the same screen
 * the phone is pointed at.
 *
 * It binds 127.0.0.1 only and requires a random token in the path, so no other
 * local process can drive the login or read the code.
 *
 * @module dsh-wechat/loginpage
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { encodeQrMatrix, renderQrSvg } from './qr.js'

/** Rendered page states. */
const PHASES = {
  idle: '尚未开始登录',
  waiting: '等待扫码',
  scaned: '已扫码，请在手机上确认',
  confirmed: '登录成功',
  expired: '二维码已过期，正在重新申请',
  failed: '登录失败',
}

/**
 * Constant-time comparison of a supplied one-time token.
 * @param {unknown} supplied - token from the request (path segment or query).
 * @param {string} expected - the page's token.
 * @returns {boolean} whether they match.
 */
export function tokenMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (supplied.length === 0 || supplied.length > 512) return false
  const suppliedBytes = Buffer.from(supplied, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  // Compare byte lengths: a multibyte token would otherwise reach
  // timingSafeEqual with mismatched buffer sizes and throw.
  if (suppliedBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(suppliedBytes, expectedBytes)
}

/**
 * Escape text for HTML interpolation.
 * @param {unknown} value - raw text.
 * @returns {string} escaped text.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Serve the login QR and the bot's live status on loopback.
 */
export class LoginPage {
  /**
   * @param {object} options - page options.
   * @param {{ info: Function, warn: Function, debug: Function }} options.logger
   * @param {number} [options.port] - preferred port; 0 or a busy port falls back to an OS-assigned one.
   * @param {string} [options.urlFile] - file to write the page URL into, so it is findable without the log.
   * @param {(url: string) => void} [options.onReady] - called once the page is reachable.
   */
  constructor(options) {
    this.logger = options.logger
    this.preferredPort = options.port ?? 0
    this.urlFile = options.urlFile ?? null
    this.onReady = options.onReady
    this.token = randomBytes(16).toString('hex')
    this.server = null
    this.port = null
    /** Set when a second surface (the app's own web server) serves the page too. */
    this.publicUrl = null
    /** Latest login state pushed by the channel. */
    this.state = { phase: 'idle', payload: null, qrcode: null, detail: null }
    /** Extra context the page displays (bot id, cursor, conversation count). */
    this.status = () => ({})
    /** Set when the operator clicks "重新登录" so the channel can restart the flow. */
    this.restartRequested = false
  }

  /** @returns {string|null} the standalone page URL, once listening. */
  get url() {
    if (this.port === null) return null
    return `http://127.0.0.1:${this.port}/t/${this.token}/`
  }

  /** @returns {string|null} the URL an operator should open: the app's origin when available. */
  get preferredUrl() {
    return this.publicUrl ?? this.url
  }

  /** @returns {object} the machine-readable state (never includes the bot token). */
  snapshot() {
    return this.#snapshot()
  }

  /**
   * @param {string} [query] - query suffix the restart link must carry ('' or '?t=…').
   * @returns {string} the page HTML.
   */
  html(query = '') {
    return this.#renderHtml(query)
  }

  /**
   * Publish a new QR code (or clear it with `payload: null`).
   * @param {{ phase?: string, payload?: string|null, qrcode?: string|null, detail?: string|null }} next - login state.
   */
  publish(next) {
    this.state = {
      phase: next.phase ?? this.state.phase,
      payload: next.payload === undefined ? this.state.payload : next.payload,
      qrcode: next.qrcode === undefined ? this.state.qrcode : next.qrcode,
      detail: next.detail === undefined ? this.state.detail : next.detail,
    }
  }

  /** Start listening; resolves once the socket is bound (or the bind failed). */
  async start() {
    if (this.server) return this.url
    this.server = createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        this.logger?.warn?.('login page request failed:', error?.message ?? error)
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('internal error')
      })
    })
    const listen = (port) =>
      new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        this.server.once('error', onError)
        this.server.listen(port, '127.0.0.1', () => {
          this.server.removeListener('error', onError)
          resolve()
        })
      })

    try {
      await listen(this.preferredPort)
    } catch (error) {
      if (this.preferredPort === 0 || error?.code !== 'EADDRINUSE') {
        this.logger?.warn?.(`login page could not start: ${error?.message ?? error}`)
        this.server = null
        return null
      }
      this.logger?.warn?.(`login page port ${this.preferredPort} is busy; using an OS-assigned port instead`)
      await listen(0)
    }
    this.port = this.server.address().port
    this.logger?.info?.(`微信扫码页已就绪：${this.url}`)
    if (this.urlFile) {
      try {
        // The desktop app keeps no plain host log, so the URL also lands in a
        // file the operator can always find.
        await mkdir(path.dirname(this.urlFile), { recursive: true, mode: 0o700 })
        await writeFile(this.urlFile, `${this.url}\n`, { mode: 0o600 })
      } catch (error) {
        this.logger?.debug?.(`could not write ${this.urlFile}: ${error?.message ?? error}`)
      }
    }
    this.onReady?.(this.url)
    return this.url
  }

  /** Stop listening. */
  async stop() {
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }

  /**
   * @param {import('node:http').IncomingMessage} request - HTTP request.
   * @returns {boolean} whether the request carries the right token.
   */
  #authorized(request) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const supplied = url.pathname.startsWith('/t/') ? url.pathname.split('/')[2] : url.searchParams.get('t')
    return tokenMatches(supplied, this.token)
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    if (!this.#authorized(request)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('dsh-wechat: 缺少或错误的一次性令牌，请使用日志里打印的完整地址。')
      return
    }
    if ((request.method === 'POST' || request.method === 'GET') && url.pathname.endsWith('/restart')) {
      this.restartRequested = true
      response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname.endsWith('/state.json')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(this.#snapshot()))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    // The query form keeps its token so the restart link still authenticates;
    // the path form needs no suffix.
    const query = url.pathname.startsWith('/t/') ? '' : `?t=${this.token}`
    response.end(this.#renderHtml(query))
  }

  /** @returns {object} the machine-readable state, never including the bot token. */
  #snapshot() {
    const extra = typeof this.status === 'function' ? this.status() : {}
    const phase = extra.loggedIn ? 'confirmed' : this.state.phase
    return {
      phase,
      label: PHASES[phase] ?? phase,
      detail: this.state.detail ?? null,
      hasQr: Boolean(this.state.payload && !extra.loggedIn),
      ...extra,
    }
  }

  /** @returns {string} the full HTML page. */
  #renderHtml(query = '') {
    const snapshot = this.#snapshot()
    const qr =
      snapshot.hasQr && this.state.payload
        ? `<div class="qr">${renderQrSvg(encodeQrMatrix(this.state.payload), { scale: 6, quietZone: 4 })}</div>`
        : '<div class="qr empty">当前没有待扫描的二维码</div>'
    const rows = [
      ['状态', snapshot.label],
      ['机器人', snapshot.botId ?? '（未绑定）'],
      ['API 基座', snapshot.baseUrl ?? '-'],
      ['已绑定会话', snapshot.conversations === undefined ? '-' : String(snapshot.conversations)],
      ['长轮询游标', snapshot.cursor ? `${String(snapshot.cursor).slice(0, 18)}…` : '（空）'],
      ['状态目录', snapshot.stateDir ?? '-'],
      snapshot.lastError ? ['最近错误', snapshot.lastError] : null,
    ].filter(Boolean)

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>dsh-wechat 微信绑定</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px 48px; font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         background: #f6f7f9; color: #1c1e21; display: flex; flex-direction: column; align-items: center; }
  @media (prefers-color-scheme: dark) { body { background: #16181c; color: #e8eaed; } .card { background: #1f2226 !important; } }
  .card { background: #fff; border-radius: 14px; padding: 24px 28px; box-shadow: 0 2px 14px rgba(0,0,0,.08); max-width: 720px; width: 100%; box-sizing: border-box; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; opacity: .68; font-size: 13.5px; }
  .qr { display: flex; justify-content: center; padding: 12px 0 20px; }
  .qr svg { width: 264px; height: 264px; background: #fff; border-radius: 10px; }
  .qr.empty { opacity: .6; font-size: 14px; padding: 90px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  td { padding: 6px 0; border-top: 1px solid rgba(128,128,128,.22); vertical-align: top; }
  td.k { opacity: .62; width: 108px; white-space: nowrap; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
  .note { margin-top: 18px; font-size: 12.5px; opacity: .68; }
  button { margin-top: 16px; padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(128,128,128,.35);
           background: transparent; color: inherit; font-size: 13.5px; cursor: pointer; }
</style>
</head>
<body>
  <div class="card">
    <h1>微信扫码绑定 dsh-wechat</h1>
    <p class="sub">用微信扫描下方二维码，并在手机上确认。本页每 5 秒自动刷新，登录成功后状态会变为「登录成功」。</p>
    ${qr}
    <table>
      ${rows.map(([key, value]) => `<tr><td class="k">${escapeHtml(key)}</td><td><code>${escapeHtml(value)}</code></td></tr>`).join('\n      ')}
    </table>
    <form method="get" action="restart${escapeHtml(query)}"><button type="submit">重新申请二维码</button></form>
    <p class="note">此页面只监听 127.0.0.1，且地址里带一次性令牌；不要把地址发给别人。二维码等同于登录凭据，过期后会自动更换。</p>
  </div>
</body>
</html>`
  }
}
