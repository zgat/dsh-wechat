#!/usr/bin/env node
/**
 * `dsh-wechat` command line: bind, inspect and unbind the WeChat bot without
 * starting DSH.
 *
 *   dsh-wechat login    扫码绑定（在终端里显示二维码）
 *   dsh-wechat status   查看绑定状态、长轮询游标与会话映射
 *   dsh-wechat logout   清除本机保存的机器人凭据
 *   dsh-wechat send <userId> <text>   用最近一次会话令牌主动发一条消息
 *   dsh-wechat qr <text>              把任意文本渲染成二维码（调试用）
 *
 * @module dsh-wechat/bin
 */

import process from 'node:process'

import { parseFlags } from '../lib/cli-flags.js'
import { normalizeConfig } from '../lib/config.js'
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, ILinkClient } from '../lib/ilink/api.js'
import { qrLogin } from '../lib/login.js'
import { LoginPage } from '../lib/loginpage.js'
import { createLogger } from '../lib/log.js'
import { encodeQrMatrix, renderQrText } from '../lib/qr.js'
import { WechatStore, resolvePaths } from '../lib/store.js'
import { openInBrowser } from '../lib/channel.js'

const HELP = `dsh-wechat — 微信（腾讯 iLink / ClawBot）接入 DeepSeek Harness 的命令行工具

用法：
  dsh-wechat login [--state-dir <目录>] [--route-tag <标签>] [--base-url <地址>] [--page] [--port N] [--no-open]
      申请登录二维码；默认在终端渲染。加 --page 时改为启动本机扫码页并用浏览器打开。

  dsh-wechat status [--state-dir <目录>]
      查看绑定状态、长轮询游标、会话映射与收发统计。

  dsh-wechat logout [--state-dir <目录>]
      删除本机保存的机器人凭据（长轮询游标同时清空）。

  dsh-wechat send <userId> <文本> [--state-dir <目录>]
      用缓存的会话令牌主动发一条文本消息。

  dsh-wechat qr <文本>
      把文本渲染成终端二维码（校验二维码渲染是否正常）。

  dsh-wechat help
      显示本帮助。

状态目录默认 $DSH_HOME/integrations/dsh-wechat（未设置 DSH_HOME 时为 ~/.dsh/integrations/dsh-wechat）。
也可以用环境变量 DSH_WECHAT_BOT_TOKEN / DSH_WECHAT_BASE_URL 直接提供凭据，此时不会读写凭据文件。
`

/** Build the config + store the CLI works with. */
function openStore(flags) {
  const config = normalizeConfig({
    ...(flags.stateDir ? { stateDir: flags.stateDir } : {}),
    ...(flags.routeTag ? { routeTag: flags.routeTag } : {}),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
    logLevel: 'info',
  })
  const logger = createLogger('info')
  const store = new WechatStore({ config, logger })
  return { config, store, logger }
}

function createClient(config, store) {
  return new ILinkClient({
    token: store.credentials?.botToken ?? '',
    baseUrl: store.credentials?.baseUrl || config.baseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: DEFAULT_CDN_BASE_URL,
    channelVersion: config.channelVersion,
    routeTag: config.routeTag ?? undefined,
    logger: createLogger('warn'),
  })
}

async function commandLogin(flags) {
  const { config, store, logger } = openStore(flags)
  await store.load()
  if (store.loggedIn && store.credentials.source === 'env') {
    console.log('检测到环境变量提供的凭据，跳过扫码登录。如需重新绑定请先取消 DSH_WECHAT_BOT_TOKEN。')
    return 0
  }
  const client = createClient(config, store)
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  // `--page` serves the same scan page the plugin uses, and opens a browser.
  const page =
    flags.page === true
      ? new LoginPage({
          logger,
          port: flags.port ?? config.loginPagePort,
          urlFile: resolvePaths(config).loginUrl,
          onReady: (url) => console.log(`扫码页：${url}`),
        })
      : null
  try {
    if (page) {
      page.status = () => ({ loggedIn: store.loggedIn, botId: store.credentials?.botId ?? null, stateDir: resolvePaths(config).root })
      await page.start()
      if (!flags.noOpen) openInBrowser(page.url, logger)
      else console.log('（已用 --no-open 跳过自动打开浏览器）')
    }
    const credentials = await qrLogin({
      client,
      store,
      logger,
      paths: resolvePaths(config),
      signal: controller.signal,
      botType: flags.botType ?? 3,
      printTerminal: !page,
      onQr: (qr) => page?.publish({ payload: qr.payload, qrcode: qr.qrcode }),
      onStatus: (status) => page?.publish({ phase: status === 'wait' ? 'waiting' : status }),
      shouldRestart: () => {
        if (!page?.restartRequested) return false
        page.restartRequested = false
        return true
      },
    })
    if (!credentials) {
      console.error('登录未完成。')
      return 1
    }
    console.log(`\n登录成功：bot=${credentials.botId ?? 'unknown'} user=${credentials.ownerUserId ?? 'unknown'}`)
    console.log(`凭据已写入：${resolvePaths(config).credentials}`)
    return 0
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await page?.stop()
  }
}

async function commandStatus(flags) {
  const { config, store } = openStore(flags)
  await store.load()
  const paths = resolvePaths(config)
  const sessions = Object.entries(store.state.sessions ?? {})
  console.log('dsh-wechat 状态')
  console.log(`  状态目录      ${paths.root}`)
  console.log(`  凭据          ${store.loggedIn ? `已绑定（来源 ${store.credentials.source ?? 'file'}，bot ${store.credentials.botId ?? 'unknown'}）` : '未绑定'}`)
  if (store.loggedIn) {
    console.log(`  API 基座      ${store.credentials.baseUrl ?? DEFAULT_BASE_URL}`)
    console.log(`  绑定用户      ${store.credentials.ownerUserId ?? 'unknown'}`)
  }
  console.log(`  长轮询游标    ${store.cursor ? `${store.cursor.slice(0, 24)}…` : '(空)'}`)
  console.log(`  会话映射      ${sessions.length} 个`)
  for (const [key, sessionId] of sessions) console.log(`    ${key} → ${sessionId}`)
  console.log(`  收发统计      收到 ${store.state.stats.inbound} 条 / 发出 ${store.state.stats.outbound} 条`)
  if (store.state.stats.lastError) {
    console.log(`  最近错误      ${store.state.stats.lastError.message}（${store.state.stats.lastError.at}）`)
  }
  return 0
}

async function commandLogout(flags) {
  const { store } = openStore(flags)
  await store.load()
  await store.clearCredentials()
  console.log('已清除本机保存的微信机器人凭据。')
  return 0
}

async function commandSend(flags, rest) {
  const [userId, ...words] = rest
  const text = words.join(' ')
  if (!userId || !text) {
    console.error('用法：dsh-wechat send <userId> <文本>')
    return 2
  }
  const { config, store } = openStore(flags)
  await store.load()
  if (!store.loggedIn) {
    console.error('尚未绑定机器人，请先执行 dsh-wechat login。')
    return 1
  }
  const contextToken = store.contextTokenFor(userId)
  if (!contextToken) {
    console.error(
      `没有 ${userId} 的会话令牌：iLink 只允许回复最近给机器人发过消息的会话，请先让对方给机器人发一条消息。`,
    )
    return 1
  }
  const client = createClient(config, store)
  await client.sendText({ toUserId: userId, text, contextToken })
  console.log(`已发送给 ${userId}：${text}`)
  return 0
}

function commandQr(rest) {
  const text = rest.join(' ') || 'dsh-wechat: 请把要编码的文本作为参数传入'
  const matrix = encodeQrMatrix(text)
  console.log(renderQrText(matrix, { quietZone: 4, invert: true }))
  console.log(text)
  return 0
}

async function main(argv) {
  const [command, ...tail] = argv
  const { flags, rest } = parseFlags(tail)
  switch (command) {
    case 'login':
      return commandLogin(flags)
    case 'status':
      return commandStatus(flags)
    case 'logout':
      return commandLogout(flags)
    case 'send':
      return commandSend(flags, rest)
    case 'qr':
      return commandQr(rest)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return 0
    default:
      console.error(`未知命令：${command}\n`)
      console.log(HELP)
      return 2
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    console.error(`dsh-wechat: ${error?.message ?? error}`)
    if (process.env.DSH_WECHAT_DEBUG) console.error(error)
    process.exitCode = 1
  })
