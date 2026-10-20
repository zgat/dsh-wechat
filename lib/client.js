/**
 * dsh-wechat client half — Settings → 微信.
 *
 * Authored directly in the DSH client module format (`window.__ModuleLoader__`), the same
 * delivery shape other WeChat plugins on this store use: the host's client-modules service
 * serves this file under `/plugins/…/client.js` and the browser kernel materializes it. It
 * imports nothing but `react` and talks to the host half over `/dsh-wechat/api/*` on the
 * GUI origin, so there is no client-side build step and no `@deepseek-ai` runtime import.
 *
 * The card exists because the plugin no longer launches a browser: the QR code has to be
 * visible somewhere on the machine that runs DSH, and the settings page is the one surface
 * that is open before anything is bound.
 */

window.__ModuleLoader__.load({
  id: 'dsh-wechat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const h = react.createElement
    /** Client services this module needs before `apply` runs. */
    const inject = ['slots']
    const API = '/dsh-wechat/api'
    const STYLE_ID = 'dsh-wechat-settings-style'
    const POLL_MS = 4_000

    const CSS = `
.dw_section{display:flex;flex-direction:column;gap:16px;padding:0 24px 24px}
.dw_card{border:1px solid rgba(128,128,128,.3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.dw_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dw_title{font-weight:600;font-size:14px}
.dw_muted{color:rgba(128,128,128,.9);font-size:12px;line-height:18px}
.dw_badge{font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4)}
.dw_badge.ok{color:#2e7d32;border-color:#2e7d32}
.dw_badge.wait{color:#ed6c02;border-color:#ed6c02}
.dw_badge.err{color:#c62828;border-color:#c62828}
.dw_btn{cursor:pointer;font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;text-decoration:none}
.dw_btn:hover{background:rgba(128,128,128,.12)}
.dw_btn:disabled{opacity:.5;cursor:default}
.dw_qr{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.dw_qr img,.dw_qr_img svg{width:200px;height:200px;background:#fff;border-radius:8px;padding:8px}
.dw_err{color:#c62828;font-size:12px;line-height:18px;word-break:break-word}
.dw_bot{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dw_spin{width:200px;height:200px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:8px}
.dw_spinner{width:28px;height:28px;border:3px solid rgba(128,128,128,.35);border-top-color:#1976d2;border-radius:50%;animation:dwspin .9s linear infinite}
@keyframes dwspin{to{transform:rotate(360deg)}}
.dw_btn.ghost{padding:2px 8px;font-size:11px;border-color:rgba(198,40,40,.45);color:#c62828}
.dw_btn.ghost:hover{background:rgba(198,40,40,.08)}
`

    /**
     * Map the host's status JSON onto what the card shows.
     *
     * Pure on purpose: the panel's state machine is the part worth testing, and a component
     * that only renders props does not need a browser to prove.
     * @param {object|null} status - `/dsh-wechat/api/status` body.
     * @returns {{tone: string, label: string, qrUrl: string|null,
     *   botId: string|null, errorsUrl: string|null, errorCount: number, canRefresh: boolean}}
     */
    function describeStatus(status) {
      if (!status || typeof status !== 'object') {
        return {
          tone: 'wait', label: '读取中…', bots: [], adding: false,
          qrUrl: null, errorsUrl: null, errorCount: 0, canRefresh: false, canAdd: false,
        }
      }
      const bots = Array.isArray(status.bots)
        ? status.bots.filter((bot) => bot && typeof bot.botId === 'string').map((bot) => ({
            botId: bot.botId,
            connected: Boolean(bot.connected),
            ownerUserId: typeof bot.ownerUserId === 'string' ? bot.ownerUserId : null,
          }))
        : []
      const online = bots.filter((bot) => bot.connected).length
      const adding = Boolean(status.adding)
      const tone = online > 0 ? 'ok' : status.phase === 'failed' ? 'err' : 'wait'
      const label = online > 0
        ? (bots.length > 1
            ? `已连接 ${online}/${bots.length}${adding ? '（添加中）' : ''}`
            : `已连接${adding ? '（添加中）' : ''}`)
        : adding || status.hasQr
          ? '等待扫码'
          : status.phase === 'failed'
            ? '登录失败'
            : bots.length > 0 ? '已绑定（连接中断）' : '未绑定'
      return {
        tone,
        label,
        bots,
        adding,
        qrUrl: typeof status.qrUrl === 'string' && status.qrUrl ? status.qrUrl : null,
        // The card shows a pointer, not the text: failures are history and belong on the
        // log page (the host keeps 30 days of them).
        errorsUrl: typeof status.errorsUrl === 'string' && status.errorsUrl ? status.errorsUrl : null,
        errorCount: Number.isFinite(status.errorCount) ? status.errorCount : 0,
        canRefresh: Boolean(status.hasQr),
        // Adding is always available (the page and the button are how a second bot arrives)
        // except while a scan is already in flight.
        canAdd: !adding,
      }
    }

    /** Add the card stylesheet once per page. */
    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * One request against the host half.
     * @param {string} path - path below `/dsh-wechat/api`.
     * @param {object} [options] - fetch options.
     * @returns {Promise<{ok: boolean, body: object}>} the response, JSON when possible.
     */
    async function request(path, options) {
      const response = await fetch(API + path, options)
      const body = await response.json().catch(() => ({}))
      return { ok: Boolean(response.ok), body }
    }

    /** Settings → 微信: status, the QR code when one is pending, and a refresh action. */
    function WechatSection() {
      const [status, setStatus] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [notice, setNotice] = react.useState('')
      // The code is drawn inline: `/api/qr` returns the same SVG the scan page uses, so the
      // card needs no <img>, no stylesheet and no theme to show it.
      const [qrSvg, setQrSvg] = react.useState(null)

      const refresh = react.useCallback(() => {
        request('/status')
          .then((result) => {
            if (result.ok) setStatus(result.body)
          })
          .catch(() => {})
      }, [])

      react.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const view = describeStatus(status)
      const qrVersion = view.qrUrl ? view.qrUrl.split('v=')[1] ?? '' : ''

      react.useEffect(() => {
        if (!qrVersion) {
          setQrSvg(null)
          return undefined
        }
        let cancelled = false
        request('/qr')
          .then((result) => {
            if (!cancelled && result.ok && typeof result.body.svg === 'string') setQrSvg(result.body.svg)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [qrVersion])
      const onAdd = () => {
        setBusy(true)
        setNotice('')
        request('/add', { method: 'POST' })
          .then((result) => {
            setNotice(result.ok ? '已开始扫码：用微信扫下方二维码' : '已有一次扫码在进行中')
            refresh()
          })
          .catch(() => setNotice('添加失败'))
          .finally(() => setBusy(false))
      }

      const onUnbind = (botId) => {
        // Destructive and irreversible from this screen: ask first, then let the host stop
        // the loop and delete that bot's credential.
        const ok = typeof window === 'undefined' || !window.confirm
          ? true
          : window.confirm(`解绑 ${botId}？这会让它立刻停止接收消息，需要重新扫码才能再用。`)
        if (!ok) return
        setBusy(true)
        setNotice('')
        request(`/logout?bot=${encodeURIComponent(botId)}`, { method: 'POST' })
          .then((result) => {
            setNotice(result.ok ? `已解绑 ${botId}` : '解绑失败')
            refresh()
          })
          .catch(() => setNotice('解绑失败'))
          .finally(() => setBusy(false))
      }

      const onRefresh = () => {
        setBusy(true)
        setNotice('')
        request('/refresh', { method: 'POST' })
          .then((result) => {
            setNotice(result.ok ? '已请求新的二维码' : '刷新失败')
            refresh()
          })
          .catch(() => setNotice('刷新失败'))
          .finally(() => setBusy(false))
      }

      const rows = [
        h('div', { className: 'dw_row', key: 'head' },
          h('span', { className: 'dw_title', key: 'title' }, '微信'),
          h('span', { className: `dw_badge ${view.tone}`, key: 'badge' }, view.label),
          view.botId ? h('span', { className: 'dw_muted', key: 'bot' }, view.botId) : null),
      ]
      for (const bot of view.bots) {
        rows.push(h('div', { className: 'dw_row', key: `bot-${bot.botId}` },
          h('span', { className: 'dw_bot', key: 'id' }, bot.botId),
          h('span', { className: `dw_badge ${bot.connected ? 'ok' : 'wait'}`, key: 'state' }, bot.connected ? '在线' : '离线'),
          h('button', {
            className: 'dw_btn ghost',
            key: 'unbind',
            onClick: () => onUnbind(bot.botId),
            disabled: busy,
          }, '解绑')))
      }
      if (view.qrUrl) {
        rows.push(h('div', { className: 'dw_qr', key: 'qr' },
          qrSvg
            ? h('div', {
                className: 'dw_qr_img',
                key: 'svg',
                // The markup comes from this plugin's own loopback route, not from a chat.
                dangerouslySetInnerHTML: { __html: qrSvg },
              })
            : h('div', { className: 'dw_spin', key: 'loading' },
                h('div', { className: 'dw_spinner' })),
          qrSvg
            ? null
            : h('div', { className: 'dw_muted', key: 'spin-hint' }, '正在获取二维码…'),
          h('div', { className: 'dw_muted', key: 'hint' }, '用微信扫码完成绑定；二维码过期后点「刷新二维码」。')))
      }
      const actions = []
      // Refresh only makes sense while a code is pending; adding and the page link are
      // useful at all times.
      if (view.canRefresh) {
        actions.push(h('button', { className: 'dw_btn', key: 'refresh', onClick: onRefresh, disabled: busy },
          busy ? '请求中…' : '刷新二维码'))
      }
      if (view.canAdd) {
        actions.push(h('button', { className: 'dw_btn', key: 'add', onClick: onAdd, disabled: busy },
          view.adding ? '扫码中…' : '添加绑定'))
      }
      if (actions.length) rows.push(h('div', { className: 'dw_row', key: 'actions' }, ...actions))
      // With valid credentials there is no code to show, but the page (and with it the way
      // to re-bind) must stay reachable: that is the one action worth keeping at all times.
      if (view.tone === 'ok') {
        rows.push(h('div', { className: 'dw_muted', key: 'rebind' },
          '「添加绑定」会扫码新增一只 bot，已有的继续在线；要移除某只 bot，在它自己的聊天里发 /logout。'))
      }
      if (notice) rows.push(h('div', { className: 'dw_muted', key: 'notice' }, notice))
      if (view.errorsUrl && view.errorCount > 0) {
        rows.push(h('div', { className: 'dw_row', key: 'errors' },
          h('a', { className: 'dw_btn', href: view.errorsUrl, target: '_blank', rel: 'noreferrer', key: 'link' },
            `错误日志（${view.errorCount}）`)))
      }

      return h('div', { className: 'dw_section' }, h('div', { className: 'dw_card' }, ...rows))
    }

    /**
     * Register the section. The kernel calls this once per page with its plugin context.
     * @param {object} ctx - client plugin context (`ctx.slots`).
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-wechat',
        order: 45,
        label: '微信',
      }, WechatSection))
    }

    exports.apply = apply
    exports.inject = inject
    // Exposed for tests: the mapping is the only logic in this file worth asserting, and it
    // needs neither a browser nor a React renderer.
    exports.describeStatus = describeStatus
    return module.exports
  },
})
