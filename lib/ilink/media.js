/**
 * Media bridge: inbound iLink items become local files the agent can read, and
 * local files become outbound iLink items.
 *
 * iLink never hands over a URL you can just fetch-and-use: the CDN payload is
 * AES-128-ECB encrypted and the key travels beside the message. Everything in
 * here is therefore "download → decrypt → write" and its exact reverse.
 *
 * @module dsh-wechat/ilink/media
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ITEM_TYPE, MEDIA_TYPE, ILinkError } from './api.js'
import {
  decodeAesKey,
  decodeAesKeyHex,
  encodeAesKey,
  encryptAesEcb,
  decryptAesEcb,
  encryptedSize,
  md5Hex,
  randomAesKeyHex,
  randomFileKey,
} from './crypto.js'

/** Extension written when the inbound file name carries none. */
const FALLBACK_EXTENSION = {
  [ITEM_TYPE.IMAGE]: '.jpg',
  [ITEM_TYPE.VOICE]: '.silk',
  [ITEM_TYPE.FILE]: '.bin',
  [ITEM_TYPE.VIDEO]: '.mp4',
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic'])

/** @returns {number} the item kind of one inbound `MessageItem`. */
export function itemType(item) {
  return typeof item?.type === 'number' ? item.type : 0
}

/** Narrow one inbound item to its payload sub-structure. */
export function itemPayload(item) {
  switch (itemType(item)) {
    case ITEM_TYPE.TEXT:
      return item.text_item ?? {}
    case ITEM_TYPE.IMAGE:
      return item.image_item ?? {}
    case ITEM_TYPE.VOICE:
      return item.voice_item ?? {}
    case ITEM_TYPE.FILE:
      return item.file_item ?? {}
    case ITEM_TYPE.VIDEO:
      return item.video_item ?? {}
    default:
      return {}
  }
}

/**
 * Strip directory components and characters that would be awkward in a file name.
 * @param {string|undefined} name - candidate name.
 * @param {number} type - `MessageItem.type`, used for the fallback extension.
 * @returns {string} a safe base name.
 */
/** Device names Windows reserves: a file called `CON.jpg` cannot be created. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\..*)?$/i

export function safeFileName(name, type) {
  const base = path.basename(String(name ?? '').trim()) || `wechat-${Date.now()}`
  let cleaned = base
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, '_')
    .slice(0, 120)
    // Windows silently strips a trailing dot or space, which would make two
    // different attachments collide on the same name.
    .replace(/[. ]+$/, '')
  if (cleaned.length === 0) cleaned = `wechat-${Date.now()}`
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`
  // `path.extname('report.tmp.')` is '.', which is not an extension: treating it as one
  // let Windows strip the trailing dot and collide with `report.tmp`.
  const extension = path.extname(cleaned)
  if (extension && extension !== '.') return cleaned
  return `${cleaned}${FALLBACK_EXTENSION[type] ?? '.bin'}`
}

/**
 * The AES key for one inbound media item. `image_item.aeskey` (hex) wins over
 * `media.aes_key` (base64) when both are present, as the protocol notes.
 * @param {object} payload - an item payload sub-structure.
 * @returns {Buffer} the 16-byte key.
 */
function inboundKey(payload) {
  if (typeof payload?.aeskey === 'string' && payload.aeskey.length > 0) return decodeAesKeyHex(payload.aeskey)
  const key = payload?.media?.aes_key
  return decodeAesKey(key)
}

/**
 * Download and decrypt one inbound media item to disk.
 * @param {object} options - download options.
 * @param {import('./api.js').ILinkClient} options.client - transport.
 * @param {object} options.item - the inbound `MessageItem`.
 * @param {string} options.dir - directory to write into.
 * @param {number} [options.maxBytes] - refuse larger payloads.
 * @param {{ warn: Function, debug: Function }} [options.logger]
 * @returns {Promise<{ path: string, name: string, size: number, type: number } | null>} file info, or null when skipped.
 */
export async function downloadInboundItem(options) {
  const { client, item, dir, logger } = options
  const type = itemType(item)
  const payload = itemPayload(item)
  const encryptQueryParam = payload?.media?.encrypt_query_param
  if (!encryptQueryParam) {
    logger?.debug?.(`inbound item type ${type} carries no media reference; skipped`)
    return null
  }
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024
  const declaredSize = Number(payload?.len ?? payload?.mid_size ?? payload?.video_size ?? 0)
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new ILinkError(`ilink: inbound media of ${declaredSize} bytes exceeds the ${maxBytes}-byte limit`)
  }

  const ciphertext = await client.downloadCdn({ encryptQueryParam, maxBytes })
  if (ciphertext.length > maxBytes) {
    throw new ILinkError(`ilink: inbound media of ${ciphertext.length} bytes exceeds the ${maxBytes}-byte limit`)
  }

  let plaintext
  let decrypted = true
  try {
    plaintext = decryptAesEcb(ciphertext, inboundKey(payload))
  } catch (error) {
    // Some senders publish plaintext payloads with a placeholder key; keep the bytes —
    // but say so: the file is *not* readable content, and naming it `report.pdf` let the
    // model (and the user) treat ciphertext as a real document.
    logger?.warn?.('inbound media decryption failed; storing raw payload:', error?.message ?? error)
    plaintext = ciphertext
    decrypted = false
  }

  const baseName = safeFileName(payload?.file_name, type)
  const name = decrypted ? baseName : `${baseName}.enc`
  // Attachments arrive from a chat and can be personal: keep the directory and
  // the file owner-only instead of relying on the process umask.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, `${Date.now()}-${name}`)
  await writeFile(target, plaintext, { mode: 0o600 })
  return { path: target, name, size: plaintext.length, type }
}

/**
 * Pick the `getuploadurl` media type for a local file.
 * @param {string} filePath - local path.
 * @param {number} [requested] - explicit `MEDIA_TYPE`, when the caller knows better.
 * @returns {number} one of {@link MEDIA_TYPE}.
 */
export function mediaTypeFor(filePath, requested) {
  if (requested) return requested
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? MEDIA_TYPE.IMAGE : MEDIA_TYPE.FILE
}

/**
 * Encrypt and upload one local file, then return the `MessageItem` that delivers it.
 * @param {object} options - upload options.
 * @param {import('./api.js').ILinkClient} options.client - transport.
 * @param {string} options.filePath - local file to send.
 * @param {string} options.toUserId - destination conversation user id.
 * @param {number} [options.mediaType] - override the inferred media type.
 * @param {number} [options.maxBytes] - refuse larger files.
 * @returns {Promise<{ item: object, name: string, size: number, mediaType: number }>}
 */
export async function uploadLocalFile(options) {
  const { client, filePath, toUserId } = options
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024
  const info = await stat(filePath)
  if (!info.isFile()) throw new ILinkError(`ilink: ${filePath} is not a regular file`)
  if (info.size > maxBytes) {
    throw new ILinkError(`ilink: ${filePath} is ${info.size} bytes, over the ${maxBytes}-byte limit`)
  }
  const plaintext = await readFile(filePath)
  const mediaType = mediaTypeFor(filePath, options.mediaType)
  const aesKeyHex = randomAesKeyHex()
  const fileKey = randomFileKey()
  const ciphertext = encryptAesEcb(plaintext, Buffer.from(aesKeyHex, 'hex'))

  const { uploadParam } = await client.getUploadUrl({
    fileKey,
    mediaType,
    toUserId,
    rawSize: plaintext.length,
    rawMd5: md5Hex(plaintext),
    encryptedSize: encryptedSize(plaintext.length),
    aesKeyHex,
    noNeedThumb: true,
  })
  const encryptQueryParam = await client.uploadCdn({ uploadParam, fileKey, ciphertext })

  const media = {
    encrypt_query_param: encryptQueryParam,
    aes_key: encodeAesKey(aesKeyHex),
    encrypt_type: 1,
  }
  const name = path.basename(filePath)
  const item =
    mediaType === MEDIA_TYPE.IMAGE
      ? { type: ITEM_TYPE.IMAGE, image_item: { media, mid_size: ciphertext.length, aeskey: aesKeyHex } }
      : {
          type: ITEM_TYPE.FILE,
          file_item: {
            media,
            file_name: name,
            len: String(plaintext.length),
            md5: md5Hex(plaintext),
          },
        }
  return { item, name, size: plaintext.length, mediaType }
}

/**
 * Build the model-facing note that tells the agent where an inbound file landed.
 * @param {{ path: string, name: string, size: number, type: number }[]} files - downloaded files.
 * @returns {string} a prompt fragment (empty when there are no files).
 */
export function describeFilesForPrompt(files) {
  if (files.length === 0) return ''
  const lines = files.map((file) => {
    const kind =
      file.type === ITEM_TYPE.IMAGE ? '图片' : file.type === ITEM_TYPE.VOICE ? '语音' : file.type === ITEM_TYPE.VIDEO ? '视频' : '文件'
    const note = file.name.endsWith('.enc') ? '（注意：解密失败，内容是加密后的原始字节，不可直接读取）' : ''
    return `- ${kind}「${file.name}」已保存到：${file.path}（${file.size} 字节）${note}`
  })
  return ['[微信附件]', ...lines].join('\n')
}
