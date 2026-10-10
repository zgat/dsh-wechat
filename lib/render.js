/**
 * Turning agent output into WeChat-safe text.
 *
 * WeChat renders one plain-text bubble per `sendmessage`, so the only real
 * rendering decision is where to cut: at a paragraph, then a line, then a space,
 * and never inside a surrogate pair.
 *
 * @module dsh-wechat/render
 */

/** WeChat's conservative per-message character budget. */
export const DEFAULT_CHUNK_CHARS = 1800

/**
 * Tidy an assistant answer before splitting: strip trailing spaces per line and
 * collapse the long blank runs models like to produce.
 * @param {string} text - raw answer.
 * @returns {string} normalized answer.
 */
export function normalizeAnswer(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

/**
 * Split text into chunks of at most `limit` characters, preferring semantic
 * boundaries and never splitting a surrogate pair.
 * @param {string} text - text to split.
 * @param {number} [limit] - maximum characters per chunk.
 * @returns {string[]} non-empty chunks.
 */
export function splitText(text, limit = DEFAULT_CHUNK_CHARS) {
  const normalized = String(text ?? '')
  if (normalized.length === 0) return []
  // A non-positive/NaN limit used to make the loop slice nothing and spin forever.
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_CHUNK_CHARS
  limit = Math.floor(limit)
  if (normalized.length <= limit) return [normalized]

  const chunks = []
  let rest = normalized
  while (rest.length > limit) {
    let cut = -1
    const window = rest.slice(0, limit + 1)
    for (const boundary of ['\n\n', '\n', '。', '；', ';', '. ', ' ']) {
      const index = window.lastIndexOf(boundary)
      // The boundary must fit *inside* the limit: a boundary landing on the last index of
      // the window would otherwise produce a chunk of limit+1 characters.
      if (index > limit * 0.4 && index + boundary.length <= limit) {
        cut = index + boundary.length
        break
      }
    }
    if (cut <= 0) cut = limit
    // Never cut between a high surrogate and its low surrogate.
    const previous = rest.charCodeAt(cut - 1)
    if (previous >= 0xd800 && previous <= 0xdbff) cut -= 1
    // The boundary character itself belongs to the chunk that ends here, minus
    // the blank space it would leave at the tail of a chat bubble.
    const chunk = rest.slice(0, cut).replace(/\s+$/, '')
    rest = rest.slice(cut).replace(/^\n+/, '')
    if (chunk.length > 0) chunks.push(chunk)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks.filter((chunk) => chunk.length > 0)
}

/**
 * Shorten long tool arguments/results for the progress line.
 * @param {unknown} value - value to shorten.
 * @param {number} [limit] - maximum characters.
 * @returns {string} a one-line rendering.
 */
export function briefValue(value, limit = 120) {
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = String(text ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Argument keys whose values are never echoed into a chat. */
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i

/**
 * Replace secret-looking values before a progress line is rendered.
 * @param {unknown} value - tool arguments.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} a copy with secrets masked.
 */
export function redactSecrets(value, depth = 0) {
  if (value === null) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return value
  // Deeply nested tool arguments are common (a JSON body inside a fetch call): a shallow
  // cap let any secret below the cut through untouched.
  if (depth > 12) return '[深层内容已省略]'
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactSecrets(entry, depth + 1))
  const out = {}
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    out[key] = SECRET_KEY.test(key) ? '[已隐藏]' : redactSecrets(entry, depth + 1)
  }
  return out
}

/**
 * Credential shapes that must be masked wherever they appear, key or not.
 *
 * Each entry keeps the leading `keep` capture groups and replaces the rest, so
 * redaction never eats the delimiter that made the match findable.
 */
const SECRET_NAMES =
  'api[_-]?key|access[_-]?key|auth[_-]?token|token|secret|password|passwd|passphrase|authorization|session[_-]?key|x-psk|psk|密码|口令|密钥|令牌'

/**
 * Masking rules, applied in order. Each one replaces only the credential itself and
 * keeps whatever surrounds it, so a progress line still shows the rest of the arguments.
 */
const REDACTIONS = [
  // Scheme-prefixed credentials first, so `Authorization: Bearer x` masks once.
  { re: /((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{6,})/gi, replace: '$1[已隐藏]' },
  // An assignment, including `GITHUB_TOKEN=…` inside a longer name. The value stops at
  // whitespace or at the JSON punctuation that usually follows it.
  {
    re: new RegExp(`((?:${SECRET_NAMES})\\s*[=:]\\s*)(?!\\[已隐藏\\]|Bearer\\b|Basic\\b)([^\\s,;}\\]"']+)`, 'gi'),
    replace: '$1[已隐藏]',
  },
  // JSON form: `"password": "hunter2"` — the quotes sit between name and colon, so the
  // assignment rule above never matches it.
  {
    re: new RegExp(`("[^"]*(?:${SECRET_NAMES})[^"]*"\\s*:\\s*")([^"]*)(")`, 'gi'),
    replace: '$1[已隐藏]$3',
  },
  // Well-known token shapes: OpenAI-style, GitHub PAT (classic and fine-grained), AWS,
  // Google API keys.
  {
    re: /(^|[^A-Za-z0-9])((?:sk|pk|ghp|gho|ghs|glpat|xox[baprs])[_-][A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/g,
    replace: '$1[已隐藏]',
  },
  // A JWT is three base64url segments; the header alone is signal enough.
  { re: /(^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g, replace: '$1[已隐藏]' },
  // The PEM *body* matters as much as the header: masking only the BEGIN line left the
  // key material on display.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[已隐藏的私钥]',
  },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replace: '[已隐藏的私钥]' },
]

/**
 * Mask credential-shaped substrings inside an already-rendered string.
 * @param {string} text - text about to be shown to the user.
 * @returns {string} the same text with secrets masked.
 */
export function redactText(text) {
  let out = String(text ?? '')
  for (const { re, replace } of REDACTIONS) out = out.replace(re, replace)
  return out
}

/**
 * Render a per-tool progress line for `progress: brief|verbose`.
 *
 * The line reaches the chat and the state file, so values that look like
 * credentials are masked first: model-authored command lines regularly carry
 * tokens that the user never asked to see echoed.
 * @param {string} toolName - tool being executed.
 * @param {unknown} args - tool arguments.
 * @returns {string} the line to send.
 */
export function toolProgressLine(toolName, args) {
  const detail = redactText(briefValue(redactSecrets(args)))
  return detail ? `🔧 ${toolName} ${detail}` : `🔧 ${toolName}`
}
