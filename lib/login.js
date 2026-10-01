/**
 * QR login: the only way to obtain an iLink `bot_token`.
 *
 * The flow is `get_bot_qrcode` → render the QR → long-poll `get_qrcode_status`
 * until the user confirms on their phone. Confirmation returns the credential
 * (token, bot id, owner user id and sometimes a new base URL), which is stored
 * and used for every later request.
 *
 * @module dsh-wechat/login
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { assertUsableBaseUrl } from './ilink/api.js'
import { sleep } from './waits.js'
import { encodeQrMatrix, renderQrSvg, renderQrText } from './qr.js'

/**
 * Render a login QR code into the host log, a text file and an SVG file.
 * @param {object} options - render options.
 * @param {string} options.payload - the string to encode (usually a URL).
 * @param {object} options.paths - paths from {@link import('./store.js').resolvePaths}.
 * @param {{ info: Function }} options.logger
 * @param {boolean} [options.printTerminal] - also print the character-art QR to the log.
 * @returns {Promise<void>}
 */
export async function presentQrCode({ payload, paths, logger, printTerminal = true }) {
  let matrix
  try {
    matrix = encodeQrMatrix(payload)
  } catch (error) {
    logger?.info?.(`二维码内容过长，无法渲染，请手动使用该链接：${payload} (${error?.message ?? error})`)
    return
  }
  if (printTerminal) logger?.info?.(`请用微信扫描二维码完成绑定：\n${renderQrText(matrix, { quietZone: 2, invert: true })}`)
  logger?.debug?.(`二维码内容：${payload}`)
  try {
    // The state directory is created lazily by the store, so a login that runs
    // before any state was saved must create it here.
    await mkdir(path.dirname(paths.qrSvg), { recursive: true, mode: 0o700 })
    await writeFile(paths.qrText, `${printTerminal ? `${renderQrText(matrix, { quietZone: 2, invert: true })}\n\n` : ''}${payload}\n`, {
      mode: 0o600,
    })
    await writeFile(paths.qrSvg, `${renderQrSvg(matrix, { scale: 8, quietZone: 4 })}\n`, { mode: 0o600 })
    logger?.info?.(`二维码文件：${paths.qrSvg}（可直接用浏览器或预览打开）`)
  } catch (error) {
    logger?.info?.(`二维码文件写入失败：${error?.message ?? error}`)
  }
}

/**
 * Run the QR login flow until it succeeds, expires too many times, or aborts.
 * @param {object} options - login options.
 * @param {import('./ilink/api.js').ILinkClient} options.client - transport (may be unauthenticated).
 * @param {import('./store.js').WechatStore} options.store - credential sink.
 * @param {{ info: Function, warn: Function, debug: Function }} options.logger
 * @param {object} options.paths - state paths, for QR artifacts.
 * @param {AbortSignal} [options.signal] - abort the flow.
 * @param {number} [options.botType] - iLink bot type (default 3).
 * @param {number} [options.maxQrCodes] - re-issue budget before giving up (default 10).
 * @param {boolean} [options.printTerminal] - print the character-art QR into the log.
 * @param {(qr: { payload: string, qrcode: string }) => void} [options.onQr] - called for every new QR.
 * @param {(status: string) => void} [options.onStatus] - called for every scan-state poll result.
 * @param {() => boolean} [options.shouldRestart] - polled so a UI can request a fresh QR.
 * @returns {Promise<object|null>} the stored credential, or null when aborted.
 */
export async function qrLogin(options) {
  const { client, store, logger, paths, signal } = options
  const maxQrCodes = options.maxQrCodes ?? 10
  const botType = options.botType ?? 3
  const printTerminal = options.printTerminal ?? true

  for (let attempt = 1; attempt <= maxQrCodes; attempt += 1) {
    if (signal?.aborted) return null
    if (attempt > 1 && options.shouldRestart?.()) {
      // An operator asked for a fresh code: reset the budget and re-issue now.
      attempt = 0
      if (signal?.aborted) return null
    }
    const { qrcode, qrcodeImgContent } = await client.getBotQrCode({ botType, signal })
    const payload = qrcodeImgContent || qrcode
    logger?.info?.(`已获取登录二维码（第 ${Math.max(attempt, 1)}/${maxQrCodes} 次），请用微信扫码`)
    options.onQr?.({ payload, qrcode })
    options.onStatus?.('wait')
    await presentQrCode({ payload, paths, logger, printTerminal })

    for (;;) {
      if (signal?.aborted) return null
      if (options.shouldRestart?.()) break
      let status
      try {
        status = await client.getQrCodeStatus({ qrcode, signal })
      } catch (error) {
        if (signal?.aborted) return null
        logger?.warn?.(`查询扫码状态失败，2 秒后重试：${error?.message ?? error}`)
        await sleep(2_000, signal)
        continue
      }
      options.onStatus?.(status.status)
      if (status.status === 'expired') {
        logger?.warn?.('二维码已过期，重新申请')
        options.onQr?.({ payload: null, qrcode: null })
        break
      }
      if (status.status === 'scaned') {
        logger?.info?.('已扫码，请在手机上确认登录')
      }
      if (status.status === 'confirmed') {
        // The response may name a different base URL; it is accepted only when it
        // is a usable one, so a downgrade to plain http cannot be smuggled in.
        let baseUrl = client.baseUrl
        if (status.baseUrl) {
          try {
            baseUrl = assertUsableBaseUrl(status.baseUrl)
          } catch (error) {
            logger?.warn?.(`拒绝登录响应里的 API 基座地址，沿用当前地址：${error?.message ?? error}`)
          }
        }
        const credentials = await store.saveCredentials({
          botToken: status.botToken,
          baseUrl,
          botId: status.ilinkBotId ?? null,
          ownerUserId: status.ilinkUserId ?? null,
          createdAt: new Date().toISOString(),
        })
        client.setCredential({ token: credentials.botToken, baseUrl: credentials.baseUrl })
        logger?.info?.(`微信登录成功：bot=${credentials.botId ?? 'unknown'}`)
        options.onStatus?.('confirmed')
        options.onQr?.({ payload: null, qrcode: null })
        return credentials
      }
    }
  }
  logger?.warn?.(`连续 ${maxQrCodes} 张二维码都未完成扫码，已停止自动登录；可运行 dsh-wechat login 手动登录`)
  return null
}

