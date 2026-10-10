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
import { defaultConfig, normalizeConfig } from './config.js'
import { service } from './harness.js'
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, ILinkClient } from './ilink/api.js'
import { createLogger } from './log.js'
import { LoginPage, tokenMatches } from './loginpage.js'
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
  /** @type {WechatChannel|undefined} */
  let channel

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

    // The scan page is started before the channel so the QR has somewhere to
    // appear the moment auto-login asks the gateway for one.
    const loginPage = config.loginPage
      ? new LoginPage({
          logger: logger.child('login'),
          port: config.loginPagePort,
          urlFile: store.paths.loginUrl,
          onReady: (url) => logger.info?.(`扫码绑定地址：${url}`),
        })
      : null
    if (loginPage) {
      // When the harness exposes a web server, serve the same page from the GUI's
      // own origin: connection's fence only covers `/api` and the index, so this
      // stays reachable at the URL the operator already has open.
      const webServer = service(ctx, 'webServer')
      if (webServer && typeof webServer.register === 'function') {
        try {
          const base = '/dsh-wechat'
          const hostPort = webServer.port ?? process.env.DSH_WEB_URL ?? null
          const origin =
            typeof hostPort === 'number'
              ? `http://127.0.0.1:${hostPort}`
              : typeof process.env.DSH_WEB_URL === 'string' && process.env.DSH_WEB_URL.length > 0
                ? process.env.DSH_WEB_URL.replace(/\/+$/, '')
                : null
          const disposeRoute = webServer.register({
            kind: 'prefix',
            path: base,
            handler: (request, response) => {
              const url = new URL(request.url ?? '/', 'http://127.0.0.1')
              if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
                response.end('dsh-wechat: 该地址只接受 GET')
                return
              }
              const supplied = url.searchParams.get('t')
              if (!tokenMatches(supplied, loginPage.token)) {
                response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
                response.end('dsh-wechat: 缺少或错误的一次性令牌，请使用日志里打印的完整地址。')
                return
              }
              if (url.pathname.endsWith('/state.json')) {
                response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
                response.end(JSON.stringify(loginPage.snapshot()))
                return
              }
              response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
              response.end(loginPage.html())
            },
          })
          if (typeof disposeRoute === 'function') cleanups.push(disposeRoute)
          if (origin) loginPage.publicUrl = `${origin}${base}/?t=${loginPage.token}`
        } catch (error) {
          logger.warn?.('could not serve the scan page from the web server:', error?.message ?? error)
        }
      }
      loginPage.status = () => ({
        loggedIn: store.loggedIn,
        botId: store.credentials?.botId ?? null,
        baseUrl: store.credentials?.baseUrl ?? null,
        conversations: Object.keys(store.state.sessions ?? {}).length,
        cursor: store.cursor,
        stateDir: store.paths.root,
        lastError: store.state.stats?.lastError?.message ?? null,
      })
      await loginPage.start()
      cleanups.push(() => void loginPage.stop())
      if (stopped) return
    }

    bridge = new WechatBridge({
      ctx,
      config,
      store,
      client: createClient(store.credentials),
      interactions,
      // Lets /status compare the running build with what is installed on disk.
      installedVersion: (await installedVersion()) ?? null,
      logger: logger.child('bridge'),
    })
    bridge.loginPageUrl = loginPage?.url ?? null
    channel = new WechatChannel({
      config,
      store,
      bridge,
      logger: logger.child('channel'),
      createClient,
      loginPage,
    })
    // The plugin may have been unloaded while the credential was loading: in
    // that case the channel must not start polling at all.
    if (stopped) {
      await channel.stop()
      return
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

    channel.start().catch((error) => logger.error?.('channel stopped:', error?.message ?? error))
    logger.info?.(
      `ready: bot=${store.credentials?.botId ?? '(未登录)'} stateDir=${store.paths.root} access=${config.accessPolicy} progress=${config.progress}`,
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
        try {
          await channel?.stop()
        } catch (error) {
          logger.debug?.('channel stop failed:', error?.message ?? error)
        }
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
