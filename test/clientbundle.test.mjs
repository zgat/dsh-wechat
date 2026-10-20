/**
 * The client half: a hand-authored DSH client module, not a bundled React app.
 *
 * These cases pin the two things that can silently break the settings card without any
 * host-side failure: the module contract the browser kernel expects (`__ModuleLoader__`,
 * `apply`, `inject`) and the status→card mapping.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Load the bundle the way the kernel does: register it through `window.__ModuleLoader__`,
 * then execute the factory with a stubbed `react`.
 *
 * Cached because an ES module body runs once: a second dynamic import would return the
 * already-evaluated module without touching the loader again.
 * @returns {Promise<{ loaded: object, exports: object }>} the registration and its exports.
 */
let cachedModule = null
async function loadClientModule() {
  if (cachedModule) return cachedModule
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load(module) {
        loaded = module
      },
    },
  }
  await import('../lib/client.js')
  assert.ok(loaded, 'the bundle must register itself with the module loader')

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [value, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  }
  const factory = loaded.factory
  const exportsObject = factory((name) => {
    assert.equal(name, 'react', 'the client half must import nothing but react')
    return react
  })
  cachedModule = { loaded, exports: exportsObject }
  return cachedModule
}

test('the client half registers a settings section through the slots service', async () => {
  const { loaded, exports } = await loadClientModule()
  assert.equal(loaded.id, 'dsh-wechat')
  assert.deepEqual(exports.inject, ['slots'], 'the kernel resolves the slots service from this list')
  assert.equal(typeof exports.apply, 'function')

  const registered = []
  const ctx = {
    slots: {
      inject(name, factory) {
        assert.equal(name, 'settings.section')
        factory()
      },
      register(meta, component) {
        registered.push({ meta, component })
      },
    },
  }
  exports.apply(ctx)
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].meta, { name: 'settings.section', id: 'dsh-wechat', order: 45, label: '微信' })
  assert.equal(typeof registered[0].component, 'function', 'the section renders a component')
})

test('the card maps every host status onto a label and a tone', async () => {
  const { exports } = await loadClientModule()
  const describe = exports.describeStatus

  assert.equal(describe(null).tone, 'wait')
  assert.equal(describe(null).label, '读取中…')

  // One bot online.
  const connected = describe({ bots: [{ botId: 'a@im.bot', connected: true }], hasQr: false })
  assert.equal(connected.tone, 'ok')
  assert.equal(connected.label, '已连接')
  assert.equal(connected.bots.length, 1)

  // Two bots, one online: the label has to say how many are up.
  const partial = describe({
    bots: [{ botId: 'a@im.bot', connected: true }, { botId: 'b@im.bot', connected: false }],
  })
  assert.equal(partial.tone, 'ok')
  assert.equal(partial.label, '已连接 1/2')

  // Adding a second bot shows a code but never hides the existing ones.
  const adding = describe({
    bots: [{ botId: 'a@im.bot', connected: true }],
    adding: true,
    hasQr: true,
    qrUrl: '/dsh-wechat/api/qr.svg?v=abc',
  })
  assert.equal(adding.label, '已连接（添加中）', 'the badge says a scan is in flight')
  assert.equal(adding.qrUrl, '/dsh-wechat/api/qr.svg?v=abc')
  assert.equal(adding.canRefresh, true)
  assert.equal(adding.canAdd, false, 'one scan at a time')

  // Bound but disconnected: not green, and the user can still add or re-open the page.
  const stale = describe({ bots: [{ botId: 'a@im.bot', connected: false }] })
  assert.equal(stale.tone, 'wait')
  assert.equal(stale.label, '已绑定（连接中断）')
  assert.equal(stale.canAdd, true)

  // Failures are a pointer now: the message itself lives on the log page.
  const failed = describe({ phase: 'failed', errorsUrl: '/dsh-wechat/errors?t=tok', errorCount: 3 })
  assert.equal(failed.tone, 'err')
  assert.equal(failed.label, '登录失败')
  assert.equal(failed.errorsUrl, '/dsh-wechat/errors?t=tok')
  assert.equal(failed.errorCount, 3)
  assert.equal(failed.lastError, undefined, 'the card no longer carries the error text')

  assert.equal(describe({}).label, '未绑定')
  assert.equal(describe({ hasQr: false }).canRefresh, false, 'no refresh button without a code')
})

test('the rendered card lists every bot and offers «添加绑定»', async () => {
  const { exports } = await loadClientModule()

  // A stubbed react: the first useState holds the host status, the rest keep their
  // initial values (busy / notice). That is enough to render the card once, which is the
  // only part a browser adds over the mapping tests.
  let hooks = 0
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const react = {
    createElement,
    useState: (initial) => [hooks++ === 0 ? {
      bots: [
        { botId: 'a@im.bot', connected: true, ownerUserId: 'owner@im.wechat' },
        { botId: 'b@im.bot', connected: false },
      ],
      adding: false,
      hasQr: false,
      qrUrl: null,
      version: '0.2.2',
      errorsUrl: '/dsh-wechat/errors?t=tok',
      errorCount: 2,
    } : initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  }

  // The ES module body already ran in an earlier test: reuse its factory with this stub.
  const { loaded } = await loadClientModule()
  const instance = loaded.factory(() => react)

  let section = null
  instance.apply({ slots: { inject: (name, factory) => factory(), register: (meta, component) => { section = component } } })
  const tree = section()

  // Walk the element tree for strings and button labels.
  const texts = []
  const buttons = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node.type === 'button') {
      buttons.push(...node.children.filter((child) => typeof child === 'string'))
    }
    for (const child of node.children) walk(child)
  }
  walk(tree)

  assert.ok(texts.includes('a@im.bot'), 'bot A is listed')
  assert.ok(texts.includes('b@im.bot'), 'bot B is listed')
  assert.ok(texts.includes('在线'), 'online bots get a badge')
  assert.ok(texts.includes('离线'), 'offline bots get one too')
  assert.ok(texts.includes('已连接 1/2'), 'the header counts the online bots')
  assert.ok(buttons.includes('添加绑定'), 'the add action is offered')
  const links = []
  const walkLinks = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walkLinks)
    if (node.type === 'a' && node.props?.href) links.push({ href: node.props.href, text: node.children.join('') })
    for (const child of node.children ?? []) walkLinks(child)
  }
  walkLinks(tree)
  const logLink = links.find((link) => link.href.startsWith('/dsh-wechat/errors'))
  assert.ok(logLink, 'the card links to the error log')
  assert.match(logLink.text, /错误日志（2）/, 'the link carries the entry count')
  assert.ok(!buttons.includes('刷新二维码'), 'no refresh without a pending code')
})
