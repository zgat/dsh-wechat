/**
 * The error log: bounded history with a retention window, plus the page that renders it.
 *
 * The settings card used to print the newest failure inline, which put a `ret=-2` line in the
 * middle of the connection status. The log is the replacement, so its bounds are the contract:
 * 30 days by default, a hard entry cap, repeated identical failures folded into one row.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTempStore } from './helpers.mjs'
import { renderErrorLogPage } from '../lib/errorspage.js'

test('errors are kept newest-first and repeated ones are folded', async () => {
  const temp = await createTempStore({ errorLogDays: 30, errorLogEntries: 300 })
  try {
    temp.store.noteError('第一条')
    temp.store.noteError('第一条')
    temp.store.noteError('第二条')
    const entries = temp.store.errorsFor({ limit: 10 })
    assert.equal(entries.length, 2, 'a repeat inside a minute is one row')
    assert.equal(entries[0].message, '第二条', 'newest first')
    assert.equal(entries[0].count, 1)
    assert.equal(entries[1].message, '第一条')
    assert.equal(entries[1].count, 2)
    assert.equal(temp.store.errorCount, 2)
    // /status keeps the newest failure for the one-line summary.
    assert.equal(temp.store.state.stats.lastError.message, '第二条')

    await temp.store.clearErrors()
    assert.equal(temp.store.errorCount, 0)
    assert.equal(temp.store.state.stats.lastError, null)
  } finally {
    await temp.cleanup()
  }
})

test('entries older than the retention window are dropped on write', async () => {
  const temp = await createTempStore({ errorLogDays: 30 })
  try {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    temp.store.state.errors = [{ at: old, message: '很久以前', count: 1 }]
    temp.store.noteError('刚刚发生')
    const entries = temp.store.errorsFor({ limit: 10 })
    assert.deepEqual(entries.map((entry) => entry.message), ['刚刚发生'], 'the stale row is gone')
  } finally {
    await temp.cleanup()
  }
})

test('the entry cap keeps the newest failures', async () => {
  const temp = await createTempStore({ errorLogEntries: 10 })
  try {
    for (let index = 0; index < 15; index += 1) temp.store.noteError(`错误 ${index}`)
    const entries = temp.store.errorsFor({ limit: 100 })
    assert.equal(entries.length, 10)
    assert.equal(entries[0].message, '错误 14')
    assert.equal(entries.at(-1).message, '错误 5')
  } finally {
    await temp.cleanup()
  }
})

test('the log page lists entries and escapes what it renders', () => {
  const store = {
    errorsFor: () => [
      { at: '2026-10-19T08:00:00.000Z', message: '回复仍有 2 段未能发出 <script>alert(1)</script>', count: 3 },
    ],
  }
  const html = renderErrorLogPage({ store, loginPage: { preferredUrl: '/dsh-wechat/?t=tok' }, config: { errorLogDays: 30, errorLogEntries: 300 } })
  assert.match(html, /错误日志/)
  assert.match(html, /保留最近 30 天/)
  assert.ok(html.includes('&lt;script&gt;'), 'the message is escaped')
  assert.ok(!html.includes('<script>alert(1)</script>'), 'no markup from the message reaches the page')
  assert.ok(html.includes('×3'), 'the repeat count is shown')
  assert.match(html, /href="\/dsh-wechat\/\?t=tok"/, 'there is a way back to the scan page')
})

test('an empty log says so instead of rendering an empty table', () => {
  const html = renderErrorLogPage({
    store: { errorsFor: () => [] },
    loginPage: { preferredUrl: null },
    config: { errorLogDays: 7, errorLogEntries: 50 },
  })
  assert.match(html, /最近没有记录到错误/)
  assert.ok(!html.includes('<table>'))
})
