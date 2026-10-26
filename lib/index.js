/**
 * `dsh-wechat` — a WeChat (Tencent iLink / ClawBot) channel for DeepSeek Harness.
 *
 * Cordis plugin entry. It wires four pieces together and nothing else:
 *
 *   WechatChannel  →  iLink long polling (transport)
 *   WechatBridge   →  conversation ↔ DSH session, turn collection (semantics)
 *   InteractionRouter → approvals/questions answered from the chat
 *   tools           → `wechat_send_text`, `wechat_send_file`, `wechat_chat_info`
 *
 * No `@deepseek-ai/*` module is imported: services are reached through
 * `ctx.get(name)`, so the plugin keeps working across harness versions as long
 * as the documented service keys and events exist.
 *
 * @module dsh-wechat
 */

import { InteractionRouter } from './approval.js'
import { WechatBridge } from './bridge.js'
import { WechatChannel } from './channel.js'
import { renderErrorLogPage } from './errorspage.js'
import { qrLogin } from './login.js'
import { defaultConfig, normalizeConfig } from './config.js'
import { service } from './harness.js'
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, ILinkClient } from './ilink/api.js'
import { mediaMime } from './ilink/media.js'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createLogger } from './log.js'
import { QrState } from './qrstate.js'
import { WechatStore } from './store.js'
import { installedVersion } from './version.js'
import { createWechatTools, registerTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'dsh-wechat'

/**
 * Required services. `agents` brings the agent registry (and, with it, the
 * driver that can create sessions); `sessions` is its durable counterpart.
 */
export const inject = ['agents', 'sessions']

/**
 * Plugin entry point.
 * @param {object} ctx - cordis context.
 * @param {unknown} rawConfig - the plugin row's `config` value.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    // A bad row must be loud but must not take the whole profile down with it.
    const fallback = createLogger('error')
    fallback.error?.(error?.message ?? error)
    fallback.error?.(`using defaults instead: ${JSON.stringify(defaultConfig())}`)
    config = defaultConfig()
  }
  if (config.enabled === false) return

  const logger = createLogger(config.logLevel)
  const store = new WechatStore({ config, logger })
  const cleanups = []
  let stopped = false

  /** @type {WechatBridge|undefined} */
  let bridge
  /** @type {Map<string, WechatChannel>} one receive loop per bot. */
  const channels = new Map()
  /** Controllers of in-flight sign-ins, aborted when the plugin unloads. */
  const loginControllers = new Set()
  /** The one login ("add a bot") task in flight, so two scans never run at once. */
  let loginTask = null

  const interactions = new InteractionRouter({
    config,
    logger: logger.child('interaction'),
    // Both closures tolerate a bridge that failed to boot: throwing here would
    // reject the approval waterfall and break approvals for the whole profile.
    send: (conversationKey, text) => {
      if (!bridge) throw new Error('dsh-wechat: bridge is not ready yet')
      return bridge.deliver(conversationKey, text)
    },
    conversationOf: (sessionId) => bridge?.conversationForSession(sessionId),
    // Only claim an interaction when WeChat is driving the turn that raised it; a turn
    // started in the GUI keeps its own dialog.
    ownsInteraction: (sessionId) => bridge?.isDrivingTurn(sessionId) ?? false,
    // Following (/listen) turns ownership into a race: the chat is watching, so both
    // surfaces may answer and the first reply wins.
    watchesInteraction: (sessionId) => bridge?.watchesInteraction(sessionId) ?? false,
  })

  // Listeners are registered synchronously so no event is missed while the
  // credential loads and the first long poll starts.
  ctx.on('agent/assistant-stream', (payload) => {
    bridge?.onAgentStream(payload)
  })
  ctx.on('session/event', (session, event) => {
    bridge?.onSessionEvent(session, event)
  })
  ctx.on('approval/request', (request, next) => interactions.handleApproval(request, next), {
    global: true,
    prepend: true,
  })
  ctx.on('user-questions/request', (request, next) => interactions.handleQuestions(request, next), {
    global: true,
    prepend: true,
  })

  const createClient = (credentials) =>
    new ILinkClient({
      token: credentials?.botToken ?? '',
      // A credential issued by login carries the authoritative base URL; the
      // configured one is what the *unauthenticated* login client talks to.
      baseUrl: credentials?.baseUrl || config.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: credentials?.cdnBaseUrl || config.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
      channelVersion: config.channelVersion,
      routeTag: config.routeTag ?? undefined,
      logger: logger.child('ilink'),
    })

  const boot = async () => {
    await store.load()
    // Read from *this module's* package.json: the boot record must describe the code
    // that is executing, not whatever happens to be installed on disk later.
    const version = (await installedVersion()) ?? 'unknown'
    await store.recordBoot({ version, pid: process.pid, node: process.version })
    logger.info?.(`dsh-wechat ${version} started (pid ${process.pid})`)
    if (stopped) return

    // Whoever scanned the QR owns the bot. Without this, the default allowlist
    // would reject the owner's own first message.
    if (!config.ownerUserId && store.credentials?.ownerUserId) {
      config.ownerUserId = store.credentials.ownerUserId
      logger.info?.(`allowlist owner taken from the bound account: ${config.ownerUserId}`)
    }

    // The code lives only in the GUI card (or the terminal in headless profiles): there is
    // no page of our own to serve, so all this object does is hold the current scan state.
    const qrState = config.qrInCard ? new QrState() : null
    if (qrState) {
      // The card is the only HTTP surface: `/api/*` for its polling, `/errors` for the log
      // page it links to. Everything is loopback-only; the old one-time token protected a
      // page that no longer exists, so it is gone rather than carried along.
      const webServer = service(ctx, 'webServer')
      if (webServer && typeof webServer.register === 'function') {
        try {
          const base = '/dsh-wechat'
          const json = (response, status, body) => {
            response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify(body))
          }
          // Inbound media can be served from the same loopback origin the card uses, so a
          // message that references a picture can render it instead of only printing a path.
          // Ids are opaque and only files this process downloaded are reachable, so the route
          // cannot be used to read arbitrary paths.
          const mediaIds = new Map()
          const mediaId = (filePath) => {
            const id = createHash('sha256').update(String(filePath)).digest('hex').slice(0, 24)
            mediaIds.set(id, filePath)
            return id
          }
          const mediaUrl = (file) => {
            const id = mediaId(file.path)
            return `${base}/media/${id}`
          }
          const disposeRoute = webServer.register({
            kind: 'prefix',
            path: base,
            handler: async (request, response) => {
              const url = new URL(request.url ?? '/', 'http://127.0.0.1')
              const method = request.method ?? 'GET'
              const pathname = url.pathname.replace(/\/+$/, '') || '/'
              const readOnly = () => {
                if (method === 'GET' || method === 'HEAD') return true
                response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
                response.end('dsh-wechat: 该地址只接受 GET')
                return false
              }
              if (pathname === `${base}/api/status`) {
                if (!readOnly()) return
                const snapshot = qrState.snapshot()
                const bots = store.botIds.map((id) => ({
                  botId: id,
                  label: store.labelFor(id),
                  connected: store.isConnected(id) || (id === bridge?.botId && Boolean(bridge?.connected)),
                  ownerUserId: store.credentialsFor(id)?.ownerUserId ?? null,
                }))
                json(response, 200, {
                  bots,
                  adding: Boolean(loginTask),
                  connected: Boolean(bridge?.connected),
                  botId: bridge?.botId ?? store.primaryBotId ?? null,
                  loggedIn: Boolean(snapshot.loggedIn),
                  phase: snapshot.phase,
                  label: snapshot.label,
                  hasQr: Boolean(snapshot.hasQr),
                  qrUrl: snapshot.hasQr && qrState.qrVersion
                    ? `${base}/api/qr.svg?v=${encodeURIComponent(qrState.qrVersion)}`
                    : null,
                  errorsUrl: `${base}/errors`,
                  errorCount: store.errorCount ?? 0,
                  version: store.lastBoot?.version ?? null,
                  lastError: snapshot.lastError ?? null,
                })
                return
              }
              if (pathname === `${base}/api/qr`) {
                if (!readOnly()) return
                const svg = qrState.qrSvg()
                if (!svg) {
                  json(response, 404, { ok: false, reason: 'no-qr' })
                  return
                }
                json(response, 200, { ok: true, version: qrState.qrVersion, svg })
                return
              }
              if (pathname === `${base}/api/qr.svg`) {
                if (!readOnly()) return
                const svg = qrState.qrSvg()
                if (!svg) {
                  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
                  response.end('dsh-wechat: 当前没有待扫描的二维码')
                  return
                }
                response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' })
                response.end(svg)
                return
              }
              if (pathname === `${base}/api/errors`) {
                if (!readOnly()) return
                const limit = Number(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('limit') ?? 100)
                json(response, 200, {
                  retentionDays: config.errorLogDays ?? 30,
                  count: store.errorCount ?? 0,
                  entries: store.errorsFor({ limit: Number.isFinite(limit) ? limit : 100 }),
                })
                return
              }
              if (pathname === `${base}/api/rename`) {
                if (method !== 'POST') {
                  response.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' })
                  response.end('dsh-wechat: 该地址只接受 POST')
                  return
                }
                const botId = url.searchParams.get('bot') ?? store.primaryBotId ?? null
                if (!botId || !store.botIds.includes(botId)) {
                  json(response, 404, { ok: false, reason: 'unknown-bot' })
                  return
                }
                try {
                  // The label is local only: iLink hands out ids, never a display name.
                  const label = await store.setBotLabel(botId, url.searchParams.get('label') ?? '')
                  json(response, 200, { ok: true, botId, label })
                } catch (error) {
                  json(response, 500, { ok: false, reason: error?.message ?? 'rename failed' })
                }
                return
              }
              if (pathname === `${base}/api/logout`) {
                if (method !== 'POST') {
                  response.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' })
                  response.end('dsh-wechat: 该地址只接受 POST')
                  return
                }
                const target = url.searchParams.get('bot') ?? store.primaryBotId ?? null
                if (!target || !store.botIds.includes(target)) {
                  json(response, 404, { ok: false, reason: 'unknown-bot' })
                  return
                }
                try {
                  // Stop this bot's receive loop before forgetting its credentials, so nothing
                  // keeps polling with a token that is about to be deleted. The other bots are
                  // untouched: this is how the settings page unbinds one account.
                  const running = channels.get(target)
                  if (running) {
                    channels.delete(target)
                    await running.stop().catch(() => {})
                  }
                  await store.clearCredentials(target)
                  bridge?.setConnected(false, target)
                  json(response, 200, { ok: true, botId: target, bots: store.botIds })
                } catch (error) {
                  json(response, 500, { ok: false, reason: error?.message ?? 'unbind failed' })
                }
                return
              }
              if (pathname === `${base}/api/add`) {
                if (method !== 'POST') {
                  response.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' })
                  response.end('dsh-wechat: 该地址只接受 POST')
                  return
                }
                if (loginTask) {
                  json(response, 409, { ok: false, reason: 'already-adding' })
                  return
                }
                // Existing bots keep polling: adding one never disturbs the others.
                void startLogin()
                json(response, 200, { ok: true })
                return
              }
              if (pathname === `${base}/api/refresh`) {
                if (method !== 'POST') {
                  response.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' })
                  response.end('dsh-wechat: 该地址只接受 POST')
                  return
                }
                // The login flow consumes this flag and asks the gateway for a fresh code.
                qrState.restartRequested = true
                json(response, 200, { ok: true, phase: qrState.snapshot().phase })
                return
              }
              if (pathname.startsWith(`${base}/media/`)) {
                if (!readOnly()) return
                const id = pathname.slice(`${base}/media/`.length)
                const filePath = mediaIds.get(id)
                if (!filePath) {
                  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
                  response.end('dsh-wechat: 没有这个附件')
                  return
                }
                try {
                  const bytes = await readFile(filePath)
                  response.writeHead(200, {
                    'Content-Type': mimeForMedia(filePath),
                    'Content-Length': bytes.length,
                    'Cache-Control': 'no-store',
                    'Content-Disposition': 'inline',
                  })
                  response.end(bytes)
                } catch (error) {
                  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
                  response.end(`dsh-wechat: 附件读取失败（${error?.message ?? error}）`)
                }
                return
              }
              if (pathname === `${base}/errors`) {
                if (!readOnly()) return
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
                response.end(renderErrorLogPage({ store, config }))
                return
              }
              response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
              response.end('dsh-wechat: 没有这个地址')
            },
          })
          if (typeof disposeRoute === 'function') cleanups.push(disposeRoute)
        } catch (error) {
          logger.warn?.('could not register the settings API:', error?.message ?? error)
        }
      }
      qrState.status = () => ({
        // While a scan is in flight the card must behave as "not logged in": the code of the
        // bot being added has to stay visible even though other bots are already bound.
        loggedIn: !loginTask && store.loggedIn,
        bots: store.botIds,
        botId: store.primaryBotId,
        baseUrl: store.credentials?.baseUrl ?? null,
        conversations: Object.keys(store.state.sessions ?? {}).length,
        cursor: store.cursor,
        adding: Boolean(loginTask),
        stateDir: store.paths.root,
        lastError: store.state.stats?.lastError?.message ?? null,
      })
    }

    if (stopped) return

    bridge = new WechatBridge({
      ctx,
      config,
      store,
      client: createClient(store.credentials),
      interactions,
      // Lets /status compare the running build with what is installed on disk.
      installedVersion: (await installedVersion()) ?? null,
      refreshInstalledVersion: installedVersion,
      logger: logger.child('bridge'),
    })
    // The settings route owns the media ids; the bridge only asks for a URL per file.
    bridge.mediaLinker = (file) => (cardMediaUrl ? cardMediaUrl(file) : null)

    /**
     * Start one bot's receive loop (idempotent per bot id).
     * @param {string} botId - bot to receive for.
     * @returns {WechatChannel} the channel.
     */
    const startBot = (botId) => {
      const existing = channels.get(botId)
      if (existing) return existing
      const next = new WechatChannel({
        config,
        botId,
        store,
        bridge,
        logger: logger.child(`channel:${botId}`),
        createClient,
        // Login is orchestrated here: one code at a time.
        allowLogin: false,
      })
      channels.set(botId, next)
      next.start().catch((error) => logger.error?.(`channel ${botId} stopped:`, error?.message ?? error))
      return next
    }

    /**
     * Scan a new bot into this instance. Existing bots keep polling throughout.
     * @returns {Promise<object|null>} the stored credential.
     */
    const startLogin = async () => {
      if (loginTask) return loginTask
      loginTask = (async () => {
        // One controller per attempt: a timeout must not poison the next "add" click, and an
        // unload still has to stop whatever is running.
        const controller = new AbortController()
        loginControllers.add(controller)
        const timeoutSeconds = Math.max(1, config.loginTimeoutSeconds ?? 300)
        // A code lives a few minutes; this cap covers one refresh, then gives the surface an
        // answer instead of leaving the card on "添加中…" forever.
        const deadline = setTimeout(() => controller.abort(new Error('login timeout')), timeoutSeconds * 1000)
        deadline.unref?.()
        try {
          const unauthenticated = createClient(null)
          qrState?.publish({ phase: 'waiting', detail: null })
          if (qrState) logger.info?.('二维码已生成：在 DSH 设置 → 微信 里扫码绑定（或看终端输出）')
          const credentials = await qrLogin({
            client: unauthenticated,
            store,
            logger: logger.child('login'),
            paths: store.paths,
            signal: controller.signal,
            // The page is the operator surface when it exists; the terminal otherwise.
            printTerminal: !qrState,
            onQr: (qr) => qrState?.publish({ payload: qr.payload, qrcode: qr.qrcode }),
            onStatus: (status) => qrState?.publish({ phase: status === 'wait' ? 'waiting' : status }),
            shouldRestart: () => {
              if (!qrState?.restartRequested) return false
              qrState.restartRequested = false
              logger.info?.('收到「重新申请二维码」请求')
              return true
            },
          })
          if (credentials?.botId) {
            // Re-scanning a bot that is already running must replace its channel: the old
            // one still holds the pre-login token and would keep polling with it. Channels
            // are single-shot (stop() aborts their controller), so a fresh one is the only
            // correct path.
            const existing = channels.get(credentials.botId)
            if (existing) {
              channels.delete(credentials.botId)
              await existing.stop().catch(() => {})
            }
            startBot(credentials.botId)
          }
          return credentials
        } catch (error) {
          // The card and the log page are the only places a person can see this: a silent
          // console warning left the surface stuck on "添加中…".
          const detail = error?.message ?? String(error)
          store.noteError(`添加 bot 失败：${detail}`)
          qrState?.publish({ phase: 'failed', detail: '扫码失败，请重新点「添加绑定」' })
          logger.warn?.('登录流程失败:', detail)
          return null
        } finally {
          clearTimeout(deadline)
          loginControllers.delete(controller)
          if (controller.signal.aborted) {
            // Either the deadline or the unload: say so once, and let the next click retry.
            store.noteError(`添加 bot 未完成：${Math.round(timeoutSeconds)} 秒内没有扫码（已取消）`)
            qrState?.publish({ phase: 'failed', detail: '扫码超时，请重新点「添加绑定」' })
          }
          loginTask = null
        }
      })()
      return loginTask
    }

    // Tools arrive only if this profile composed a tool registry; registering
    // late is fine, and it keeps minimal profiles loadable.
    const registerToolSet = () => {
      if (stopped) return
      const dispose = registerTools(
        service(ctx, 'tools'),
        createWechatTools({ ctx, bridge, logger: logger.child('tools') }),
        logger.child('tools'),
      )
      cleanups.push(dispose)
    }
    if (service(ctx, 'tools')) registerToolSet()
    else if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], () => registerToolSet())
      } catch (error) {
        logger.warn?.('could not wait for the tools service:', error?.message ?? error)
      }
    }

    const bound = store.botIds
    for (const botId of bound) startBot(botId)
    if (bound.length === 0 && config.autoLogin) void startLogin()
    logger.info?.(
      `ready: bots=${bound.length > 0 ? bound.join(', ') : '(未登录)'} stateDir=${store.paths.root} access=${config.accessPolicy} progress=${config.progress}`,
    )
  }

  ctx.effect(() => {
    boot().catch((error) => {
      logger.error?.('failed to start the WeChat channel:', error?.message ?? error)
    })
    return () => {
      stopped = true
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup()
        } catch (error) {
          logger.debug?.('cleanup failed:', error?.message ?? error)
        }
      }
      interactions.dispose()
      const stopping = (async () => {
        for (const controller of loginControllers) controller.abort(new Error('plugin unloaded'))
        for (const [botId, running] of channels) {
          try {
            await running.stop()
          } catch (error) {
            logger.debug?.(`channel stop failed for ${botId}:`, error?.message ?? error)
          }
        }
        channels.clear()
        try {
          await bridge?.disposeAll()
        } catch (error) {
          logger.debug?.('bridge teardown failed:', error?.message ?? error)
        }
        try {
          // Persist anything the message path queued, so an unload cannot race a write.
          await store.flush()
        } catch (error) {
          logger.debug?.('state flush failed:', error?.message ?? error)
        }
      })()
      // The disposer itself is synchronous; the shutdown continues in the background.
      void stopping
    }
  })
}

export default { name, inject, apply }
