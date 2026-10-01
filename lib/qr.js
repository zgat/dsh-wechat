/**
 * Minimal, dependency-free QR Code encoder (byte mode, EC level L, versions 1-10)
 * plus terminal (half-block) and SVG renderers.
 *
 * Scope is deliberately tiny: the only thing this plugin ever encodes is the
 * iLink login URL, which is well under 200 bytes. Versions 1-10 at level L cover
 * 271 bytes, so the whole Reed-Solomon/block table stays small enough to audit.
 *
 * Verified against the `qrcode` npm package in test/qr.test.mjs.
 *
 * @module dsh-wechat/qr
 */

/** Error-correction level indicator bits (level L = 0b01). */
const EC_BITS_L = 0b01

/**
 * Block layout per version at level L: [ [blockCount, dataCodewordsPerBlock, ecCodewordsPerBlock], ... ].
 * Source: ISO/IEC 18004 table 9 (level L).
 */
const BLOCKS_L = {
  1: [[1, 19, 7]],
  2: [[1, 34, 10]],
  3: [[1, 55, 15]],
  4: [[1, 80, 20]],
  5: [[1, 108, 26]],
  6: [[2, 68, 18]],
  7: [[2, 78, 20]],
  8: [[2, 97, 24]],
  9: [[2, 116, 30]],
  10: [[2, 68, 18], [2, 69, 18]],
}

/** Alignment pattern centre coordinates per version (ISO/IEC 18004 annex E). */
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

/** Remainder bits appended after the interleaved codewords. */
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 }

const MAX_VERSION = 10
const PAD_BYTES = [0xec, 0x11]

// ---------------------------------------------------------------------------
// GF(256) arithmetic and Reed-Solomon
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** Generator polynomial of the requested degree, highest power first. */
function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** Reed-Solomon error-correction codewords for one block. */
function rsEncode(data, ecLength) {
  const generator = rsGenerator(ecLength)
  const remainder = new Uint8Array(ecLength)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecLength - 1] = 0
    for (let i = 0; i < ecLength; i += 1) {
      remainder[i] ^= gfMul(generator[i + 1], factor)
    }
  }
  return remainder
}

// ---------------------------------------------------------------------------
// Bit buffer
// ---------------------------------------------------------------------------

class BitBuffer {
  constructor() {
    this.bits = []
  }

  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }

  get length() {
    return this.bits.length
  }

  toCodewords() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8))
    this.bits.forEach((bit, index) => {
      if (bit) out[index >> 3] |= 0x80 >> (index & 7)
    })
    return out
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function dataCapacityBytes(version) {
  const dataCodewords = BLOCKS_L[version].reduce((sum, [count, data]) => sum + count * data, 0)
  const countBits = version >= 10 ? 16 : 8
  return Math.floor((dataCodewords * 8 - 4 - countBits) / 8)
}

function pickVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteLength <= dataCapacityBytes(version)) return version
  }
  throw new RangeError(
    `qr: payload of ${byteLength} bytes exceeds the supported capacity (${dataCapacityBytes(MAX_VERSION)} bytes at version ${MAX_VERSION}-L)`,
  )
}

/** Interleave data and EC codewords exactly as the spec's block structure requires. */
function buildCodewords(bytes, version) {
  const groups = BLOCKS_L[version]
  const dataCodewords = groups.reduce((sum, [count, data]) => sum + count * data, 0)
  const buffer = new BitBuffer()
  buffer.put(0b0100, 4)
  buffer.put(bytes.length, version >= 10 ? 16 : 8)
  for (const byte of bytes) buffer.put(byte, 8)

  const capacityBits = dataCodewords * 8
  const terminator = Math.min(4, capacityBits - buffer.length)
  buffer.put(0, terminator)
  while (buffer.length % 8 !== 0) buffer.put(0, 1)
  const written = buffer.toCodewords()
  const stream = new Uint8Array(dataCodewords)
  stream.set(written)
  for (let i = written.length, pad = 0; i < dataCodewords; i += 1, pad += 1) {
    stream[i] = PAD_BYTES[pad % 2]
  }

  const blocks = []
  let offset = 0
  for (const [count, dataLength, ecLength] of groups) {
    for (let i = 0; i < count; i += 1) {
      const data = stream.subarray(offset, offset + dataLength)
      offset += dataLength
      blocks.push({ data, ec: rsEncode(data, ecLength) })
    }
  }

  const out = []
  const maxData = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  }
  const ecLength = blocks[0].ec.length
  for (let i = 0; i < ecLength; i += 1) {
    for (const block of blocks) out.push(block.ec[i])
  }
  return Uint8Array.from(out)
}

function bitLength(value) {
  let length = 0
  while (value !== 0) {
    length += 1
    value >>>= 1
  }
  return length
}

function formatBits(mask) {
  const data = (EC_BITS_L << 3) | mask
  let remainder = data << 10
  while (bitLength(remainder) - 11 >= 0) remainder ^= 0x537 << (bitLength(remainder) - 11)
  return ((data << 10) | remainder) ^ 0x5412
}

function versionBits(version) {
  let remainder = version << 12
  while (bitLength(remainder) - 13 >= 0) remainder ^= 0x1f25 << (bitLength(remainder) - 13)
  return (version << 12) | remainder
}

function createMatrix(version) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  return { size, modules, reserved, version }
}

function setModule(matrix, row, col, dark, reserve = true) {
  if (row < 0 || col < 0 || row >= matrix.size || col >= matrix.size) return
  matrix.modules[row][col] = dark
  if (reserve) matrix.reserved[row][col] = true
}

function drawFunctionPatterns(matrix) {
  const { size } = matrix
  const drawFinder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const ring = r === 0 || r === 6 || c === 0 || c === 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        setModule(matrix, row + r, col + c, inside && (ring || core))
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0
    setModule(matrix, 6, i, dark)
    setModule(matrix, i, 6, dark)
  }

  const centres = ALIGNMENT[matrix.version]
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6)
      if (nearFinder) continue
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const ring = Math.max(Math.abs(r), Math.abs(c))
          setModule(matrix, row + r, col + c, ring !== 1)
        }
      }
    }
  }

  // Reserve format information areas and the fixed dark module. Row/column 6 is
  // the timing pattern, which crosses both strips and keeps its own value.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setModule(matrix, 8, i, false)
      setModule(matrix, i, 8, false)
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setModule(matrix, 8, size - 1 - i, false)
    setModule(matrix, size - 1 - i, 8, false)
  }
  setModule(matrix, size - 8, 8, true)

  if (matrix.version >= 7) {
    const bits = versionBits(matrix.version)
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >> i) & 1) === 1
      const row = Math.floor(i / 3)
      const col = i % 3
      setModule(matrix, size - 11 + col, row, dark)
      setModule(matrix, row, size - 11 + col, dark)
    }
  }
}

function drawFormatInfo(matrix, mask) {
  const { size } = matrix
  const bits = formatBits(mask)
  const bit = (index) => ((bits >> index) & 1) === 1

  // Copy 1: the vertical strip beside the top-left finder, then the L-shaped
  // strip that runs along row 8, the bottom-left finder and the top-right finder.
  for (let i = 0; i <= 5; i += 1) setModule(matrix, i, 8, bit(i))
  setModule(matrix, 7, 8, bit(6))
  setModule(matrix, 8, 8, bit(7))
  setModule(matrix, 8, 7, bit(8))
  for (let i = 9; i <= 14; i += 1) setModule(matrix, 8, 14 - i, bit(i))

  // Copy 2: the duplicate strip, read the other way round.
  for (let i = 0; i <= 7; i += 1) setModule(matrix, 8, size - 1 - i, bit(i))
  for (let i = 8; i <= 14; i += 1) setModule(matrix, size - 15 + i, 8, bit(i))
  setModule(matrix, size - 8, 8, true)
}

function placeData(matrix, codewords, remainderBits) {
  const { size } = matrix
  const bits = []
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((codeword >> i) & 1)
  }
  for (let i = 0; i < remainderBits; i += 1) bits.push(0)

  let index = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let column = 0; column < 2; column += 1) {
        const col = right - column
        if (matrix.reserved[row][col]) continue
        matrix.modules[row][col] = index < bits.length && bits[index] === 1
        index += 1
      }
    }
    upward = !upward
  }
  if (index !== bits.length) {
    throw new Error(`qr: internal placement mismatch (placed ${index} of ${bits.length} bits)`)
  }
}

const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

function applyMask(matrix, mask) {
  const { size, modules, reserved } = matrix
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (reserved[row][col]) continue
      if (MASKS[mask](row, col)) modules[row][col] = !modules[row][col]
    }
  }
}

function penalty(modules, size) {
  let score = 0

  // Rule 1: runs of five or more same-coloured modules in a line.
  const runScore = (line) => {
    let total = 0
    let run = 1
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1
      } else {
        if (run >= 5) total += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) total += 3 + (run - 5)
    return total
  }
  for (let row = 0; row < size; row += 1) score += runScore(modules[row])
  for (let col = 0; col < size; col += 1) {
    score += runScore(modules.map((row) => row[col]))
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = modules[row][col]
      if (value === modules[row][col + 1] && value === modules[row + 1][col] && value === modules[row + 1][col + 1]) {
        score += 3
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on a side.
  const pattern = [true, false, true, true, true, false, true, false, false, false, false]
  const matches = (line) => {
    let total = 0
    for (let i = 0; i + pattern.length <= line.length; i += 1) {
      let forward = true
      let backward = true
      for (let j = 0; j < pattern.length; j += 1) {
        if (line[i + j] !== pattern[j]) forward = false
        if (line[i + j] !== pattern[pattern.length - 1 - j]) backward = false
        if (!forward && !backward) break
      }
      if (forward) total += 40
      if (backward) total += 40
    }
    return total
  }
  for (let row = 0; row < size; row += 1) score += matches(modules[row])
  for (let col = 0; col < size; col += 1) score += matches(modules.map((row) => row[col]))

  // Rule 4: deviation from a 50% dark ratio.
  let dark = 0
  for (const row of modules) for (const value of row) if (value) dark += 1
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/**
 * Encode text into a QR module matrix.
 * @param {string} text - payload (encoded as UTF-8 bytes).
 * @returns {{ version: number, size: number, modules: boolean[][], mask: number }}
 */
export function encodeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text))
  const version = pickVersion(bytes.length)
  const codewords = buildCodewords(bytes, version)

  const matrix = createMatrix(version)
  drawFunctionPatterns(matrix)
  placeData(matrix, codewords, REMAINDER_BITS[version])

  let best = { mask: -1, score: Infinity, modules: null }
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = {
      size: matrix.size,
      version,
      reserved: matrix.reserved,
      modules: matrix.modules.map((row) => row.slice()),
    }
    applyMask(candidate, mask)
    drawFormatInfo(candidate, mask)
    const score = penalty(candidate.modules, matrix.size)
    if (score < best.score) best = { mask, score, modules: candidate.modules }
  }

  return { version, size: matrix.size, modules: best.modules, mask: best.mask }
}

/**
 * Render a matrix as text using half-block characters (two modules per cell row,
 * two characters per module column so the result keeps a square aspect ratio).
 * @param {ReturnType<typeof encodeQrMatrix>} matrix - encoded QR code.
 * @param {{ quietZone?: number, invert?: boolean }} [options] - `invert: true`
 *   prints light modules as blocks, which is what a dark terminal background needs.
 * @returns {string} multi-line text, ready to print.
 */
export function renderQrText(matrix, options = {}) {
  const quietZone = options.quietZone ?? 2
  const invert = options.invert ?? true
  const dark = (row, col) => {
    if (row < 0 || col < 0 || row >= matrix.size || col >= matrix.size) return false
    return matrix.modules[row][col]
  }
  const cell = (value) => {
    const block = value !== invert
    return block ? '\u2588\u2588' : '  '
  }
  const lines = []
  const blank = '  '.repeat((matrix.size + quietZone * 2) * 1)
  for (let i = 0; i < quietZone; i += 1) lines.push(blank)
  for (let row = -quietZone; row < matrix.size + quietZone; row += 2) {
    let line = ''
    for (let i = 0; i < quietZone; i += 1) line += '  '
    for (let col = -quietZone; col < matrix.size + quietZone; col += 1) {
      const top = dark(row, col)
      const bottom = dark(row + 1, col)
      if (top === bottom) {
        line += cell(top)
      } else if (top) {
        line += invert ? '\u2584\u2584' : '\u2580\u2580'
      } else {
        line += invert ? '\u2580\u2580' : '\u2584\u2584'
      }
    }
    lines.push(line)
  }
  for (let i = 0; i < quietZone; i += 1) lines.push(blank)
  return lines.join('\n')
}

/**
 * Render a matrix as a standalone SVG document.
 * @param {ReturnType<typeof encodeQrMatrix>} matrix - encoded QR code.
 * @param {{ scale?: number, quietZone?: number, dark?: string, light?: string }} [options]
 * @returns {string} SVG source.
 */
export function renderQrSvg(matrix, options = {}) {
  const scale = options.scale ?? 8
  const quietZone = options.quietZone ?? 4
  const darkColor = options.dark ?? '#000000'
  const lightColor = options.light ?? '#ffffff'
  const side = (matrix.size + quietZone * 2) * scale
  const parts = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">`,
  )
  parts.push(`<rect width="${side}" height="${side}" fill="${lightColor}"/>`)
  parts.push(`<path fill="${darkColor}" d="`)
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (!matrix.modules[row][col]) continue
      const x = (col + quietZone) * scale
      const y = (row + quietZone) * scale
      parts.push(`M${x} ${y}h${scale}v${scale}h-${scale}z`)
    }
  }
  parts.push('"/></svg>')
  return parts.join('')
}
