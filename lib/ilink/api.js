/**
 * The iLink HTTP client: QR login, `getupdates` long polling, `sendmessage`,
 * typing state and the AES-encrypted media CDN.
 *
 * Every business POST repeats the same envelope (`base_info` plus the auth and
 * `X-WECHAT-UIN` headers), so that lives in one place here. All failures surface
 * as {@link ILinkError} with the server's `ret`/`errcode` intact, which is what
 * lets the channel distinguish "retry" from "session expired, log in again".
 *
 * @module dsh-wechat/ilink/api
 */

import { newClientId, randomWechatUin } from './crypto.js'

/** Default REST base for the iLink bot gateway. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Default media CDN base. */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** `media_type` values accepted by `getuploadurl`. */
export const MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }

/** `MessageItem.type` values. */
export const ITEM_TYPE = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }

/** `message_type` values. */
export const MESSAGE_TYPE = { USER: 1, BOT: 2 }

/** `message_state` values. */
export const MESSAGE_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 }

/** `sendtyping` status values. */
export const TYPING = { START: 1, STOP: 2 }

/** Long-poll window the server asks for, used until it tells us otherwise. */
export const DEFAULT_LONGPOLL_MS = 35_000

/** Loopback and private hosts, where plain http cannot leave the machine. */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|[^/]+\.local)$/i

/**
 * Validate the REST base URL, from configuration or from a login response.
 *
 * The login response is trusted input for the *host*, so an attacker who can
 * answer as the gateway (or a misconfigured deployment) must not be able to
 * downgrade the bearer-token traffic to plain http.
 * @param {string} value - candidate base URL.
 * @returns {string} the normalized base URL.
 * @throws {TypeError} when the URL is unparsable, not http(s), or http off-host.
 */
export function assertUsableBaseUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new TypeError(`ilink: base URL is not a URL: ${String(value).slice(0, 120)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`ilink: base URL must be http(s), got ${url.protocol}`)
  }
  if (url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname)) {
    throw new TypeError(`ilink: refusing plain http for non-local host ${url.hostname}`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** `ret`/`errcode` meaning "this bot session is gone; log in again". */
export const SESSION_EXPIRED = -14

/** Transport failure carrying the server's error envelope. */
export class ILinkError extends Error {
  /**
   * @param {string} message - human-readable summary.
   * @param {{ ret?: number, errcode?: number, errmsg?: string, status?: number, body?: unknown, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined)
    this.name = 'ILinkError'
    this.ret = details.ret
    this.errcode = details.errcode
    this.errmsg = details.errmsg
    this.status = details.status
    this.body = details.body
  }
}

/** A request that exceeded its own client-side timeout. */
export class TimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * @param {unknown} error - any thrown value.
 * @returns {boolean} true when the bot session must be re-established by login.
 */
export function isSessionExpired(error) {
  return error instanceof ILinkError && (error.ret === SESSION_EXPIRED || error.errcode === SESSION_EXPIRED)
}

/**
 * Client for one iLink bot account.
 */
export class ILinkClient {
  /**
   * @param {object} options - connection settings.
   * @param {string} [options.baseUrl] - REST base; the login response may override it.
   * @param {string} [options.cdnBaseUrl] - media CDN base.
   * @param {string} [options.token] - `bot_token` bearer credential.
   * @param {string} [options.channelVersion] - reported as `base_info.channel_version`.
   * @param {string} [options.clientVersion] - reported as `iLink-App-ClientVersion`.
   * @param {string} [options.routeTag] - optional `SKRouteTag` routing label.
   * @param {number} [options.requestTimeoutMs] - non-long-poll request timeout.
   * @param {typeof fetch} [options.fetchImpl] - injectable fetch (tests).
   * @param {{ debug: Function, warn: Function, error: Function }} [options.logger]
   */
  constructor(options = {}) {
    this.baseUrl = assertUsableBaseUrl(options.baseUrl || DEFAULT_BASE_URL)
    // Media carries the same bearer credential, so it gets the same rule.
    this.cdnBaseUrl = assertUsableBaseUrl(options.cdnBaseUrl || DEFAULT_CDN_BASE_URL)
    this.token = options.token || ''
    this.channelVersion = options.channelVersion || '1.0.0'
    this.clientVersion = options.clientVersion || '1'
    this.routeTag = options.routeTag || ''
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.logger = options.logger
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('dsh-wechat: global fetch is unavailable; node >= 20 is required')
    }
  }

  /**
   * Replace the bearer credential after a successful login.
   * @param {{ token?: string, baseUrl?: string }} [credential] - login response fields.
   * @throws {TypeError} when the supplied base URL is unusable.
   */
  setCredential({ token, baseUrl } = {}) {
    if (token) this.token = token
    if (baseUrl) this.baseUrl = assertUsableBaseUrl(baseUrl)
  }

  /** @returns {object} the headers every business request carries. */
  #headers(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.token}`,
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': this.clientVersion,
      ...extra,
    }
    if (this.routeTag) headers.SKRouteTag = this.routeTag
    return headers
  }

  /** @returns {{ channel_version: string }} the envelope body fragment. */
  #baseInfo() {
    return { channel_version: this.channelVersion }
  }

  /**
   * Perform one request with a timeout that is fully owned here.
   *
   * `AbortSignal.timeout()` would keep a timer pending until it fires even after
   * the response arrived, which delays process exit (visible in the CLI); an
   * explicit, unref'd timer cleared in `finally` avoids that.
   *
   * @param {string} url - absolute URL.
   * @param {RequestInit} init - fetch options (its `signal` is ignored).
   * @param {{ timeoutMs: number, signal?: AbortSignal }} options - timeout and caller signal.
   * @returns {Promise<{ response?: Response, timedOut: boolean }>} the response, or a timeout marker.
   */
  async #request(url, init, options) {
    const controller = new AbortController()
    let timedOut = false
    // Already cancelled before we start: `addEventListener` never fires for a signal that
    // has aborted, so the request would be sent anyway.
    if (options.signal?.aborted) return { timedOut: false, aborted: true }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('ilink: client timeout'))
    }, options.timeoutMs)
    if (timer.unref) timer.unref()
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener?.('abort', onAbort, { once: true })
    // The guard must outlive `fetch()`, which resolves as soon as the *headers* arrive:
    // clearing it here left every body read unguarded (a stalled body then hung the
    // receive loop, a send retry and `channel.stop()` indefinitely).
    const release = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
    }
    try {
      const response = await this.fetchImpl(url, { redirect: 'error', ...init, signal: controller.signal })
      // `timedOut` must be read *after* the body is consumed, so it is exposed as a getter
      // rather than a snapshot taken when the headers arrived.
      return {
        response,
        release,
        controller,
        get timedOut() {
          return timedOut
        },
      }
    } catch (error) {
      release()
      if (timedOut) return { timedOut: true }
      throw error
    }
  }

  /**
   * Read a response body under the guard that `#request` set up.
   * @param {object} result - the value `#request` returned.
   * @param {(response: Response) => Promise<T>} read - body reader.
   * @template T
   * @returns {Promise<T>} the reader's value.
   */
  async #withBody(result, read) {
    if (result.aborted) throw new ILinkError('ilink: request was cancelled before it started')
    try {
      return await read(result.response)
    } catch (error) {
      if (result.timedOut) throw new TimeoutError('ilink: the response body stalled (client timeout)')
      throw error
    } finally {
      result.release?.()
    }
  }

  /**
   * POST a JSON body and validate the business envelope.
   * @param {string} path - path below the REST base, e.g. `/ilink/bot/sendmessage`.
   * @param {object} body - request body.
   * @param {{ timeoutMs?: number, signal?: AbortSignal, allowTimeout?: boolean }} [options]
   * @returns {Promise<object>} parsed response body.
   */
  async #post(path, body, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    let response
    let result
    try {
      result = await this.#request(
        `${this.baseUrl}${path}`,
        { method: 'POST', headers: this.#headers(), body: JSON.stringify(body) },
        { timeoutMs, signal: options.signal },
      )
      if (result.timedOut) {
        if (options.allowTimeout) {
          // A client-side long-poll timeout is an empty poll, not a protocol error.
          return { ret: 0, msgs: [], timedOut: true }
        }
        throw new TimeoutError(`ilink: POST ${path} timed out after ${timeoutMs}ms`)
      }
      response = result.response
    } catch (error) {
      if (error instanceof TimeoutError) throw error
      throw new ILinkError(`ilink: POST ${path} failed: ${error?.message ?? error}`, { cause: error })
    }
    let text
    try {
      text = await this.#withBody(result, (bodyResponse) => bodyResponse.text())
    } catch (error) {
      if (error instanceof TimeoutError) throw error
      throw new ILinkError(`ilink: POST ${path} failed while reading the response: ${error?.message ?? error}`, { cause: error })
    }
    let parsed
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      throw new ILinkError(`ilink: POST ${path} returned non-JSON (HTTP ${response.status})`, {
        status: response.status,
        body: text.slice(0, 400),
      })
    }
    if (!response.ok) {
      throw new ILinkError(`ilink: POST ${path} failed with HTTP ${response.status}`, {
        status: response.status,
        ret: parsed?.ret,
        errcode: parsed?.errcode,
        errmsg: parsed?.errmsg,
        body: parsed,
      })
    }
    if (parsed && typeof parsed === 'object') {
      // Either field may carry the failure: a `{"errcode": -14}` reply without
      // `ret` is still an expired session, and treating it as an empty poll would
      // silently drop every later message.
      const failure = parsed.ret !== undefined && parsed.ret !== 0 ? parsed.ret
        : parsed.errcode !== undefined && parsed.errcode !== 0 ? parsed.errcode
        : null
      if (failure !== null) {
        throw new ILinkError(
          `ilink: POST ${path} failed with ${failure === parsed.ret ? 'ret' : 'errcode'}=${failure}${parsed.errmsg ? ` (${parsed.errmsg})` : ''}`,
          {
            status: response.status,
            ret: parsed.ret,
            errcode: parsed.errcode,
            errmsg: parsed.errmsg,
            body: parsed,
          },
        )
      }
    }
    return parsed ?? {}
  }

  /**
   * `GET /ilink/bot/get_bot_qrcode` — ask for a login QR code.
   * @param {{ botType?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ qrcode: string, qrcodeImgContent: string }>}
   */
  async getBotQrCode(options = {}) {
    const botType = options.botType ?? 3
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`
    const headers = { 'iLink-App-ClientVersion': this.clientVersion }
    if (this.routeTag) headers.SKRouteTag = this.routeTag
    const result = await this.#request(url, { method: 'GET', headers }, {
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
      signal: options.signal,
    }).catch((error) => {
      throw new ILinkError(`ilink: get_bot_qrcode failed: ${error?.message ?? error}`, { cause: error })
    })
    if (result.timedOut) throw new TimeoutError('ilink: get_bot_qrcode timed out')
    const response = result.response
    if (!response.ok) {
      throw new ILinkError(`ilink: get_bot_qrcode failed with HTTP ${response.status}`, { status: response.status })
    }
    const body = await this.#withBody(result, (bodyResponse) => bodyResponse.json()).catch((error) => {
      throw new ILinkError(`ilink: get_bot_qrcode returned an unreadable body: ${error?.message ?? error}`, {
        status: response.status,
        cause: error,
      })
    })
    if (!body?.qrcode) throw new ILinkError('ilink: get_bot_qrcode returned no qrcode', { body })
    return { qrcode: body.qrcode, qrcodeImgContent: body.qrcode_img_content ?? '' }
  }

  /**
   * `GET /ilink/bot/get_qrcode_status` — long-poll the scan state.
   * @param {{ qrcode: string, timeoutMs?: number, signal?: AbortSignal }} options
   * @returns {Promise<{ status: string, botToken?: string, ilinkBotId?: string, ilinkUserId?: string, baseUrl?: string }>}
   */
  async getQrCodeStatus(options) {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(options.qrcode)}`
    const headers = { 'iLink-App-ClientVersion': this.clientVersion }
    if (this.routeTag) headers.SKRouteTag = this.routeTag
    const result = await this.#request(url, { method: 'GET', headers }, {
      timeoutMs: options.timeoutMs ?? DEFAULT_LONGPOLL_MS,
      signal: options.signal,
    }).catch((error) => {
      throw new ILinkError(`ilink: get_qrcode_status failed: ${error?.message ?? error}`, { cause: error })
    })
    // A local timeout simply means "still waiting for the scan".
    if (result.timedOut) return { status: 'wait' }
    const response = result.response
    if (!response.ok) {
      throw new ILinkError(`ilink: get_qrcode_status failed with HTTP ${response.status}`, { status: response.status })
    }
    const body = await this.#withBody(result, (bodyResponse) => bodyResponse.json()).catch((error) => {
      throw new ILinkError(`ilink: get_qrcode_status returned an unreadable body: ${error?.message ?? error}`, {
        status: response.status,
        cause: error,
      })
    })
    if (body?.status === 'confirmed') {
      return {
        status: 'confirmed',
        botToken: body.bot_token,
        ilinkBotId: body.ilink_bot_id,
        ilinkUserId: body.ilink_user_id,
        baseUrl: body.baseurl,
      }
    }
    return { status: body?.status ?? 'wait' }
  }

  /**
   * `POST /ilink/bot/getupdates` — receive messages. The server holds the request
   * until a message arrives or its own timeout elapses; a local timeout is treated
   * as an empty batch.
   * @param {{ cursor?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ ret: number, msgs: object[], cursor: string, longpollingTimeoutMs?: number, timedOut?: boolean }>}
   */
  async getUpdates(options = {}) {
    const body = await this.#post(
      '/ilink/bot/getupdates',
      { get_updates_buf: options.cursor ?? '', base_info: this.#baseInfo() },
      {
        // The grace lets the server's own timeout win the race; a caller that
        // knows the transport is synthetic may set it to zero.
        timeoutMs: (options.timeoutMs ?? DEFAULT_LONGPOLL_MS) + (options.graceMs ?? 5_000),
        signal: options.signal,
        allowTimeout: true,
      },
    )
    return {
      ret: body.ret ?? 0,
      msgs: Array.isArray(body.msgs) ? body.msgs : [],
      cursor: typeof body.get_updates_buf === 'string' ? body.get_updates_buf : (options.cursor ?? ''),
      longpollingTimeoutMs: body.longpolling_timeout_ms,
      timedOut: body.timedOut === true,
    }
  }

  /**
   * `POST /ilink/bot/sendmessage` — deliver one item to one conversation.
   * @param {{ toUserId: string, contextToken?: string, item: object, clientId: string, signal?: AbortSignal }} options
   * @returns {Promise<object>} the (usually empty) response body.
   */
  async sendMessage(options) {
    const msg = {
      from_user_id: '',
      to_user_id: options.toUserId,
      client_id: options.clientId || newClientId(),
      message_type: MESSAGE_TYPE.BOT,
      message_state: MESSAGE_STATE.FINISH,
      item_list: [options.item],
    }
    if (options.contextToken) msg.context_token = options.contextToken
    return this.#post('/ilink/bot/sendmessage', { msg, base_info: this.#baseInfo() }, { signal: options.signal })
  }

  /**
   * `POST /ilink/bot/sendmessage` with a TEXT item.
   * @param {{ toUserId: string, text: string, contextToken?: string, clientId: string, signal?: AbortSignal }} options
   */
  async sendText(options) {
    return this.sendMessage({
      toUserId: options.toUserId,
      contextToken: options.contextToken,
      clientId: options.clientId,
      item: { type: ITEM_TYPE.TEXT, text_item: { text: options.text } },
      signal: options.signal,
    })
  }

  /**
   * `POST /ilink/bot/getconfig` — fetch the typing ticket for one conversation.
   * @param {{ ilinkUserId: string, contextToken?: string, signal?: AbortSignal }} options
   * @returns {Promise<string|undefined>} the ticket, when the server issues one.
   */
  async getConfig(options) {
    const body = { ilink_user_id: options.ilinkUserId, base_info: this.#baseInfo() }
    if (options.contextToken) body.context_token = options.contextToken
    const response = await this.#post('/ilink/bot/getconfig', body, { signal: options.signal })
    return response.typing_ticket
  }

  /**
   * `POST /ilink/bot/sendtyping` — start or stop the "对方正在输入" indicator.
   * @param {{ ilinkUserId: string, typingTicket: string, status: number, signal?: AbortSignal }} options
   */
  async sendTyping(options) {
    return this.#post(
      '/ilink/bot/sendtyping',
      {
        ilink_user_id: options.ilinkUserId,
        typing_ticket: options.typingTicket,
        status: options.status,
        base_info: this.#baseInfo(),
      },
      { signal: options.signal },
    )
  }

  /**
   * `POST /ilink/bot/getuploadurl` — reserve an encrypted media slot.
   * @param {object} options - upload parameters (sizes and digests are of the plaintext).
   * @returns {Promise<{ uploadParam: string, thumbUploadParam: string }>}
   */
  async getUploadUrl(options) {
    const body = {
      filekey: options.fileKey,
      media_type: options.mediaType,
      to_user_id: options.toUserId,
      rawsize: options.rawSize,
      rawfilemd5: options.rawMd5,
      filesize: options.encryptedSize,
      no_need_thumb: options.noNeedThumb !== false,
      aeskey: options.aesKeyHex,
      base_info: this.#baseInfo(),
    }
    const response = await this.#post('/ilink/bot/getuploadurl', body, { signal: options.signal })
    if (!response.upload_param) throw new ILinkError('ilink: getuploadurl returned no upload_param', { body: response })
    return { uploadParam: response.upload_param, thumbUploadParam: response.thumb_upload_param ?? '' }
  }

  /**
   * Encrypted blob upload to the media CDN; the response header carries the
   * `encrypt_query_param` that goes back into `sendmessage`.
   * @param {{ uploadParam: string, fileKey: string, ciphertext: Buffer, signal?: AbortSignal }} options
   * @returns {Promise<string>} `x-encrypted-param`.
   */
  async uploadCdn(options) {
    const url = `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(options.uploadParam)}&filekey=${encodeURIComponent(options.fileKey)}`
    let response
    try {
      const result = await this.#request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: options.ciphertext,
        },
        { timeoutMs: this.requestTimeoutMs * 6, signal: options.signal },
      )
      if (result.timedOut) throw new TimeoutError('ilink: CDN upload timed out')
      response = result.response
    } catch (error) {
      throw new ILinkError(`ilink: CDN upload failed: ${error?.message ?? error}`, { cause: error })
    }
    const encryptedParam = response.headers?.get?.('x-encrypted-param')
    if (!response.ok || !encryptedParam) {
      const detail = response.headers?.get?.('x-error-message') ?? ''
      throw new ILinkError(
        `ilink: CDN upload failed with HTTP ${response.status}${detail ? ` (${detail})` : ''}`,
        { status: response.status },
      )
    }
    return encryptedParam
  }

  /**
   * Encrypted blob download from the media CDN.
   * @param {{ encryptQueryParam: string, signal?: AbortSignal }} options
   * @returns {Promise<Buffer>} ciphertext.
   */
  async downloadCdn(options) {
    const url = `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(options.encryptQueryParam)}`
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
    let response
    let result
    try {
      result = await this.#request(url, { method: 'GET' }, {
        timeoutMs: this.requestTimeoutMs * 6,
        signal: options.signal,
      })
      if (result.timedOut) throw new TimeoutError('ilink: CDN download timed out')
      response = result.response
    } catch (error) {
      throw new ILinkError(`ilink: CDN download failed: ${error?.message ?? error}`, { cause: error })
    }
    if (!response.ok) {
      throw new ILinkError(`ilink: CDN download failed with HTTP ${response.status}`, { status: response.status })
    }
    // Read with a running cap: buffering first and checking later would let a
    // hostile or misconfigured CDN response exhaust memory. The read stays under the
    // request guard, so a body that stalls cannot wedge the inbound path.
    const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ILinkError(`ilink: CDN payload of ${declared} bytes exceeds the ${maxBytes}-byte limit`)
    }
    const chunks = []
    let total = 0
    await this.#withBody(result, async (bodyResponse) => {
      for await (const chunk of bodyResponse.body ?? []) {
        total += chunk.length
        if (total > maxBytes) {
          throw new ILinkError(`ilink: CDN payload exceeded the ${maxBytes}-byte limit while downloading`)
        }
        chunks.push(Buffer.from(chunk))
      }
    })
    return Buffer.concat(chunks)
  }

  /**
   * Best-effort `msg/notifystart` / `msg/notifystop` lifecycle hints. Not part of
   * the published protocol, so failures are swallowed and only logged at debug.
   * @param {'start'|'stop'} phase - lifecycle phase.
   */
  async notifyLifecycle(phase) {
    try {
      await this.#post(`/ilink/bot/msg/notify${phase}`, { base_info: this.#baseInfo() })
    } catch (error) {
      this.logger?.debug?.(`notify${phase} ignored:`, error?.message ?? error)
    }
  }
}
