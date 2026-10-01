/**
 * iLink transport primitives: identifiers, AES-128-ECB media crypto and size math.
 *
 * Wire format reference: 微信 iLink Bot API (`https://ilinkai.weixin.qq.com`).
 * Media always travels AES-128-ECB/PKCS7 encrypted, and the `aes_key` field has
 * two historical encodings that both have to be accepted (see `decodeAesKey`).
 *
 * @module dsh-wechat/ilink/crypto
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * `X-WECHAT-UIN`: a random uint32 rendered as a decimal string, then base64.
 * Regenerated for every request, exactly as the official clients do.
 * @returns {string} header value.
 */
export function randomWechatUin() {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

/** @returns {string} a 16-byte AES key as 32 lowercase hex characters. */
export function randomAesKeyHex() {
  return randomBytes(16).toString('hex')
}

/** @returns {string} a 16-byte client file key as 32 lowercase hex characters. */
export function randomFileKey() {
  return randomBytes(16).toString('hex')
}

/**
 * The `aes_key` encoding the official outbound path writes: `base64(hexString)`.
 * @param {string} keyHex - 32 hex characters.
 * @returns {string} base64 of the 32 ASCII bytes.
 */
export function encodeAesKey(keyHex) {
  return Buffer.from(keyHex, 'utf8').toString('base64')
}

/**
 * Accept both `base64(raw 16 bytes)` and `base64(hex string)` encodings.
 * @param {string} value - `media.aes_key` from an inbound item.
 * @returns {Buffer} the 16-byte key.
 * @throws {TypeError} when the value decodes to neither 16 nor 32 bytes.
 */
export function decodeAesKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('ilink: media.aes_key is missing')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('utf8'))) {
    return Buffer.from(decoded.toString('utf8'), 'hex')
  }
  throw new TypeError(`ilink: unsupported aes_key encoding (${decoded.length} bytes decoded)`)
}

/**
 * Decode an `image_item.aeskey`-style field, which is already a hex string.
 * @param {string} hex - 32 hex characters.
 * @returns {Buffer} the 16-byte key.
 */
export function decodeAesKeyHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TypeError('ilink: expected a 32-character hex AES key')
  }
  return Buffer.from(hex, 'hex')
}

/**
 * @param {Buffer|Uint8Array} plaintext - media bytes.
 * @param {Buffer} key - 16-byte key.
 * @returns {Buffer} AES-128-ECB/PKCS7 ciphertext.
 */
export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * @param {Buffer|Uint8Array} ciphertext - media bytes.
 * @param {Buffer} key - 16-byte key.
 * @returns {Buffer} decrypted plaintext.
 */
export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * `filesize` in `getuploadurl`: the PKCS7-padded ciphertext length.
 * @param {number} rawSize - plaintext byte length.
 * @returns {number} ciphertext byte length.
 */
export function encryptedSize(rawSize) {
  return Math.ceil((rawSize + 1) / 16) * 16
}

/**
 * @param {Buffer|Uint8Array} buffer - bytes to hash.
 * @returns {string} lowercase hex MD5, the digest form `rawfilemd5` expects.
 */
export function md5Hex(buffer) {
  return createHash('md5').update(buffer).digest('hex')
}

/** @returns {string} a unique outbound message id. */
export function newClientId(prefix = 'dsh-wechat') {
  return `${prefix}:${Date.now()}-${randomUUID().slice(0, 8)}`
}

/** @returns {string} a short opaque identifier, used for hashing user ids in state. */
export function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}
