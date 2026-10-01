import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeQrMatrix, renderQrText, renderQrSvg } from '../lib/qr.js'

// The `qrcode` package is a DEV-ONLY oracle: the shipped plugin has no runtime
// dependencies, so this test proves the local encoder agrees module-for-module
// with an independent implementation.
const oracle = (await import('qrcode')).default

/** Oracle matrix as boolean[][] using the same byte mode, EC level and masking. */
async function oracleMatrix(text) {
  const qr = oracle.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'L' })
  const size = qr.modules.size
  const data = qr.modules.data
  const matrix = []
  for (let row = 0; row < size; row += 1) {
    const line = []
    for (let col = 0; col < size; col += 1) line.push(data[row * size + col] === 1)
    matrix.push(line)
  }
  return { size, matrix, version: qr.version }
}

const payloads = [
  'https://weixin.qq.com/x/cAbCdEfGhIj',
  'A',
  'hello world',
  'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qrc_8f4b7b1d2cf74e98baf50a5d0cc4b4b7',
  'x'.repeat(60),
  'x'.repeat(120),
  'x'.repeat(200),
  'x'.repeat(270),
  '中文二维码内容测试',
  '混合 mixed 内容 with symbols !@#$%^&*()_+-=[]{}',
]

test('encoder matches the reference implementation module-for-module', async () => {
  for (const payload of payloads) {
    const mine = encodeQrMatrix(payload)
    const theirs = await oracleMatrix(payload)
    assert.equal(mine.version, theirs.version, `version mismatch for ${payload.slice(0, 24)}`)
    assert.equal(mine.size, theirs.size, `size mismatch for ${payload.slice(0, 24)}`)
    for (let row = 0; row < mine.size; row += 1) {
      for (let col = 0; col < mine.size; col += 1) {
        assert.equal(
          mine.modules[row][col],
          theirs.matrix[row][col],
          `module mismatch at ${row},${col} for ${payload.slice(0, 24)} (version ${mine.version})`,
        )
      }
    }
  }
})

test('version selection matches the reference implementation', async () => {
  for (let length = 1; length <= 271; length += 1) {
    const payload = 'a'.repeat(length)
    const mine = encodeQrMatrix(payload)
    const theirs = await oracleMatrix(payload)
    assert.equal(mine.version, theirs.version, `version mismatch at payload length ${length}`)
  }
})

test('payloads beyond the supported capacity fail loudly', () => {
  assert.throws(() => encodeQrMatrix('a'.repeat(272)), /exceeds the supported capacity/)
})

test('terminal rendering has the expected geometry', () => {
  const matrix = encodeQrMatrix('https://weixin.qq.com/x/cAbCdEfGhIj')
  const quietZone = 2
  const rendered = renderQrText(matrix, { quietZone })
  const lines = rendered.split('\n')
  // Two module rows per text line, plus quiet-zone padding lines top and bottom.
  assert.equal(lines.length, quietZone * 2 + Math.ceil((matrix.size + quietZone * 2) / 2))
  assert.equal(lines[0].length, (matrix.size + quietZone * 2) * 2)
  assert.ok(rendered.includes('\u2588'))
})

test('svg rendering is well-formed and sized', () => {
  const matrix = encodeQrMatrix('https://weixin.qq.com/x/cAbCdEfGhIj')
  const svg = renderQrSvg(matrix, { scale: 4, quietZone: 4 })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.ok(svg.endsWith('</svg>'))
  const side = (matrix.size + 8) * 4
  assert.ok(svg.includes(`width="${side}" height="${side}"`))
  const drawn = (svg.match(/M\d+ \d+h4v4h-4z/g) ?? []).length
  let dark = 0
  for (const row of matrix.modules) for (const value of row) if (value) dark += 1
  assert.equal(drawn, dark)
})
