/**
 * The error-log page: a plain server-rendered page, no client script.
 *
 * Errors used to live in the settings card, where a `ret=-2` line sat in the middle of the
 * connection status. They are history, not status: this page is where the operator reads
 * them, and the card only links here.
 */

/** Escape the five characters that would otherwise break out of text and attributes. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render one error entry as a table row.
 * @param {{ at: string, message: string, count?: number }} entry - one logged failure.
 * @returns {string} the row markup.
 */
function row(entry) {
  const at = new Date(entry.at)
  const when = Number.isNaN(at.getTime())
    ? escapeHtml(entry.at)
    : at.toLocaleString('zh-CN', { hour12: false })
  const repeat = (entry.count ?? 1) > 1 ? ` <span class="n">×${entry.count}</span>` : ''
  return `<tr><td class="t">${escapeHtml(when)}</td><td>${escapeHtml(entry.message)}${repeat}</td></tr>`
}

/**
 * @param {object} options - page inputs.
 * @param {import('./store.js').WechatStore} options.store - source of the log.
 * @param {object} options.config - normalized configuration (retention).
 * @returns {string} the complete HTML document.
 */
export function renderErrorLogPage({ store, config }) {
  const days = config.errorLogDays ?? 30
  const limit = Math.max(1, Math.min(300, config.errorLogEntries ?? 300))
  const entries = store.errorsFor({ limit })
  const body =
    entries.length === 0
      ? '<p class="empty">最近没有记录到错误。</p>'
      : `<table><thead><tr><th>时间</th><th>内容</th></tr></thead><tbody>${entries.map(row).join('')}</tbody></table>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-wechat · 错误日志</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:24px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#fafafa;color:#1f2328}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}}
h1{font-size:18px;margin:0 0 4px}
.muted{color:#6e7781;font-size:12px;margin:0 0 16px}
table{border-collapse:collapse;width:100%;background:transparent}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(128,128,128,.25);vertical-align:top}
th{font-weight:600;font-size:12px;color:#6e7781}
td.t{white-space:nowrap;color:#6e7781;font-variant-numeric:tabular-nums}
.n{color:#6e7781;font-size:12px}
.empty{color:#6e7781}
a{color:#0969da}
</style>
</head>
<body>
<h1>错误日志</h1>
<p class="muted">保留最近 ${escapeHtml(days)} 天（最多 ${escapeHtml(limit)} 条，重复的同类错误合并为一条并计数）。</p>
${body}
</body>
</html>`
}
