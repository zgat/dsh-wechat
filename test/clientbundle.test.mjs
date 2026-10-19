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

  const connected = describe({ connected: true, botId: 'bot@im.bot', hasQr: false })
  assert.equal(connected.tone, 'ok')
  assert.equal(connected.label, '已连接')
  assert.equal(connected.botId, 'bot@im.bot')

  // Logged in but the long poll is down: worth an amber badge, not a green one.
  const stale = describe({ loggedIn: true, connected: false })
  assert.equal(stale.tone, 'ok')
  assert.equal(stale.label, '已登录（连接中断）')

  const waiting = describe({ hasQr: true, phase: 'waiting', qrUrl: '/dsh-wechat/api/qr.svg?v=abc', pageUrl: '/dsh-wechat/?t=tok' })
  assert.equal(waiting.tone, 'wait')
  assert.equal(waiting.label, '等待扫码')
  assert.equal(waiting.qrUrl, '/dsh-wechat/api/qr.svg?v=abc', 'the image is served by the host route')
  assert.equal(waiting.canRefresh, true)

  const failed = describe({ phase: 'failed', lastError: 'ret=-14' })
  assert.equal(failed.tone, 'err')
  assert.equal(failed.label, '登录失败')
  assert.equal(failed.lastError, 'ret=-14')

  // Connected, no code pending: the page link must survive so re-binding stays reachable.
  const connectedWithPage = describe({ connected: true, pageUrl: '/dsh-wechat/?t=tok' })
  assert.equal(connectedWithPage.qrUrl, null)
  assert.equal(connectedWithPage.pageUrl, '/dsh-wechat/?t=tok')
  assert.equal(connectedWithPage.canRefresh, false)

  assert.equal(describe({}).label, '未绑定')
  assert.equal(describe({ hasQr: false }).canRefresh, false, 'no refresh button without a code')
})
