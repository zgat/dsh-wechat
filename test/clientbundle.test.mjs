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
  const stale = describe({ bots: [{ botId: 'a@im.bot', connected: false }], pageUrl: '/dsh-wechat/?t=tok' })
  assert.equal(stale.tone, 'wait')
  assert.equal(stale.label, '已绑定（连接中断）')
  assert.equal(stale.pageUrl, '/dsh-wechat/?t=tok')
  assert.equal(stale.canAdd, true)

  const failed = describe({ phase: 'failed', lastError: 'ret=-14' })
  assert.equal(failed.tone, 'err')
  assert.equal(failed.label, '登录失败')
  assert.equal(failed.lastError, 'ret=-14')

  assert.equal(describe({}).label, '未绑定')
  assert.equal(describe({ hasQr: false }).canRefresh, false, 'no refresh button without a code')
})
