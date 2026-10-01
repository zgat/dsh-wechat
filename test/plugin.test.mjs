/**
 * End-to-end: the plugin booted by a REAL cordis context, talking to a REAL HTTP
 * fake iLink gateway, driving a stub agent registry.
 *
 * This is the closest thing to running inside DSH that can be automated without a
 * model: everything between the WeChat wire and the agent is the shipped code.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import plugin, { inject, name as pluginName } from '../lib/index.js'
import { createFakeHarness, startGateway, waitFor } from './helpers.mjs'

test('the plugin boots under cordis, receives a message and answers it', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-plugin-'))
  const gateway = await startGateway()
  const registeredTools = []
  let harness

  // Credentials via the environment: the store picks these up without a QR login.
  process.env.DSH_WECHAT_BOT_TOKEN = 'token-from-env'
  process.env.DSH_WECHAT_BASE_URL = gateway.baseUrl
  process.env.DSH_WECHAT_BOT_ID = 'bot-env@im.bot'

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  // The plugin subscribes to cordis events, so the stub agent loop publishes
  // there too, exactly like the real loop does.
  harness = createFakeHarness({ reply: '插件端到端回复', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('tools', {
    register(definition) {
      registeredTools.push(definition)
      return () => {
        const index = registeredTools.indexOf(definition)
        if (index >= 0) registeredTools.splice(index, 1)
      }
    },
  })

  let fiber
  try {
    assert.equal(pluginName, 'dsh-wechat')
    assert.deepEqual(inject, ['agents', 'sessions'])

    fiber = ctx.plugin(plugin, {
      stateDir,
      accessPolicy: 'open',
      typing: true,
      progress: 'off',
      logLevel: 'silent',
    })

    const bridge = await waitFor(
      () =>
        ctx.get('agents') && registeredTools.length === 0
          ? false
          : registeredTools.length === 3 && true,
      { timeoutMs: 5_000, label: 'tool registration' },
    )
    assert.equal(bridge, true)
    assert.deepEqual(
      registeredTools.map((tool) => tool.name).sort(),
      ['wechat_chat_info', 'wechat_send_file', 'wechat_send_text'],
    )
    // Tool definitions must carry a JSON-Schema parameter block the registry accepts.
    for (const tool of registeredTools) {
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')
    }

    // The long-poll loop is live, so one pushed message becomes an agent turn.
    gateway.push({
      seq: 1,
      message_id: 9001,
      from_user_id: 'user@im.wechat',
      to_user_id: 'bot-env@im.bot',
      message_type: 1,
      message_state: 2,
      context_token: 'ctx-token-1',
      item_list: [{ type: 1, text_item: { text: '端到端测试' } }],
    })

    // The first contact gets the onboarding guide, then the answer.
    await waitFor(() => gateway.state.sent.length > 1, { timeoutMs: 8_000, label: 'reply on the wire' })
    assert.match(gateway.state.sent[0].item_list[0].text_item.text, /微信机器人已就绪/)
    const reply = gateway.state.sent.at(-1)
    assert.equal(reply.to_user_id, 'user@im.wechat')
    assert.equal(reply.context_token, 'ctx-token-1')
    assert.equal(reply.message_state, 2)
    assert.equal(reply.item_list[0].text_item.text, '插件端到端回复')
    assert.ok(reply.client_id, 'every outbound message carries a client id')

    // The typing indicator came from the getconfig ticket.
    await waitFor(() => gateway.state.typing.length > 0, { timeoutMs: 4_000, label: 'typing' })
    assert.equal(gateway.state.typing[0].typing_ticket, 'ticket')

    // The credential came from the environment, not from disk.
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(path.join(stateDir, 'credentials.json')), false)

    await fiber.dispose()
    assert.equal(registeredTools.length, 0, 'tools are unregistered on unload')
    // The receive loop stops with the plugin.
    const pollsAfterDispose = gateway.state.polls
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(gateway.state.polls - pollsAfterDispose <= 1, 'long polling stops on unload')
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Teardown failures are asserted above, not here.
    }
    delete process.env.DSH_WECHAT_BOT_TOKEN
    delete process.env.DSH_WECHAT_BASE_URL
    delete process.env.DSH_WECHAT_BOT_ID
    await gateway.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('the account that scanned the QR becomes the allowlist owner', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-owner-'))
  const gateway = await startGateway()
  const harness = createFakeHarness({ reply: 'ok', emitTo: (eventName, ...args) => ctxEmitHolder.emit(eventName, ...args) })
  let ctxEmitHolder

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  ctxEmitHolder = ctx
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [] })

  // A credential file as written by a real scan, with no ownerUserId configured.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    path.join(stateDir, 'credentials.json'),
    JSON.stringify({
      version: 1,
      botToken: 'token-from-file',
      baseUrl: gateway.baseUrl,
      botId: 'bound@im.bot',
      ownerUserId: 'owner@im.wechat',
      source: 'file',
    }),
    { mode: 0o600 },
  )

  let fiber
  try {
    fiber = ctx.plugin(plugin, {
      stateDir,
      accessPolicy: 'allowlist',
      allowedUserIds: [],
      typing: false,
      progress: 'off',
      logLevel: 'silent',
    })
    await waitFor(() => gateway.state.polls > 0, { timeoutMs: 8_000, label: 'polling starts' })

    // The owner's message must be accepted even though allowedUserIds is empty.
    gateway.push({
      seq: 1,
      message_id: 1,
      from_user_id: 'owner@im.wechat',
      to_user_id: 'bound@im.bot',
      message_type: 1,
      message_state: 2,
      context_token: 'ctx-owner',
      item_list: [{ type: 1, text_item: { text: '我是绑定的人' } }],
    })
    await waitFor(() => harness.agents.length === 1, { timeoutMs: 8_000, label: 'owner turn starts' })

    // A stranger is still refused.
    gateway.push({
      seq: 2,
      message_id: 2,
      from_user_id: 'stranger@im.wechat',
      to_user_id: 'bound@im.bot',
      message_type: 1,
      message_state: 2,
      context_token: 'ctx-stranger',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })
    await waitFor(() => gateway.state.sent.some((msg) => /白名单/.test(msg.item_list[0].text_item.text)), {
      timeoutMs: 8_000,
      label: 'stranger refused',
    })
    assert.equal(harness.agents.length, 1)
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await gateway.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('a disabled row never starts the channel', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-off-'))
  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness()
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [] })
  const listeners = []
  const originalOn = ctx.on.bind(ctx)
  ctx.on = (eventName, handler, options) => {
    listeners.push(eventName)
    return originalOn(eventName, handler, options)
  }
  let fiber
  try {
    fiber = ctx.plugin(plugin, { stateDir, enabled: false, logLevel: 'silent' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(listeners.length, 0)
  } finally {
    try {
      await fiber?.dispose?.()
    } catch {
      // Nothing was mounted, so nothing should need unwinding.
    }
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('an unbound plugin serves the scan page and completes login from it', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-loginpage-'))
  const gateway = await startGateway()
  const registeredTools = []

  // No DSH_WECHAT_* variables: the plugin must start its own login flow.
  delete process.env.DSH_WECHAT_BOT_TOKEN
  delete process.env.DSH_WECHAT_BASE_URL
  delete process.env.DSH_WECHAT_BOT_ID

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness({ reply: 'ok', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('tools', {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  })

  // The operator-facing URL is printed through the plugin logger; capture it so
  // the test can act like the person who opens that link.
  const logged = []
  const realLog = console.log
  console.log = (...args) => {
    logged.push(args.map(String).join(' '))
  }

  let fiber
  try {
    fiber = ctx.plugin(plugin, {
      stateDir,
      baseUrl: gateway.baseUrl,
      cdnBaseUrl: gateway.baseUrl,
      autoLogin: true,
      loginPage: true,
      loginPagePort: 0,
      openLoginPage: false,
      logLevel: 'info',
    })

    const url = await waitFor(
      () => logged.map((line) => /http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+\//.exec(line)?.[0]).find(Boolean),
      { timeoutMs: 8_000, label: 'login page url in the log' },
    )
    // The page URL appears when the page starts, which is one round trip before the
    // gateway is asked for a code: wait for it instead of racing it.
    await waitFor(() => gateway.state.qrIssued >= 1, { timeoutMs: 8_000, label: 'qr issued by the gateway' })

    // The page shows the scan code and the waiting phase.
    const state = await waitFor(
      async () => {
        const response = await fetch(`${url}state.json`)
        return response.ok ? response.json() : false
      },
      { timeoutMs: 8_000, label: 'login page state' },
    )
    assert.equal(state.phase, 'waiting')
    assert.equal(state.hasQr, true)
    const html = await (await fetch(url)).text()
    assert.ok(html.includes('<svg'), 'the page must embed the scan code')

    // The person scans and confirms on the phone.
    gateway.state.qrPhase = 'confirmed'
    const credentialsFile = path.join(stateDir, 'credentials.json')
    await waitFor(() => existsSync(credentialsFile), { timeoutMs: 10_000, label: 'credential written by login' })

    // The channel then authenticates and keeps polling with the new token.
    await waitFor(
      async () => {
        const confirmed = await (await fetch(`${url}state.json`)).json()
        return confirmed.phase === 'confirmed' && confirmed.botId === 'bot-qr@im.bot'
      },
      { timeoutMs: 10_000, label: 'page reflects the login' },
    )
    const pollsBefore = gateway.state.polls
    gateway.push({
      seq: 1,
      message_id: 4242,
      from_user_id: 'user@im.wechat',
      to_user_id: 'bot-qr@im.bot',
      message_type: 1,
      message_state: 2,
      context_token: 'ctx-token-qr',
      item_list: [{ type: 1, text_item: { text: '登录后第一条' } }],
    })
    await waitFor(() => gateway.state.sent.length > 0 && gateway.state.polls > pollsBefore, {
      timeoutMs: 8_000,
      label: 'traffic after login',
    })
  } finally {
    console.log = realLog
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await gateway.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('the scan page is also served from the harness web server when one exists', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-webserver-'))
  const gateway = await startGateway()
  const routes = []

  delete process.env.DSH_WECHAT_BOT_TOKEN
  delete process.env.DSH_WECHAT_BASE_URL

  const root = new Context()
  const ctx = root.isolate?.() ?? root
  const harness = createFakeHarness({ reply: 'ok', emitTo: (eventName, ...args) => ctx.emit(eventName, ...args) })
  ctx.provide('agents', harness.registry)
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('webServer', {
    port: 19387,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  })

  const logged = []
  const realLog = console.log
  console.log = (...args) => {
    logged.push(args.map(String).join(' '))
  }

  let fiber
  try {
    fiber = ctx.plugin(plugin, {
      stateDir,
      baseUrl: gateway.baseUrl,
      cdnBaseUrl: gateway.baseUrl,
      loginPage: true,
      loginPagePort: 0,
      openLoginPage: false,
      logLevel: 'info',
    })

    await waitFor(() => routes.length === 1, { timeoutMs: 8_000, label: 'route registration' })
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/dsh-wechat')

    // The operator-facing URL points at the GUI origin, not the fallback port.
    const url = await waitFor(
      () => logged.map((line) => /http:\/\/127\.0\.0\.1:19387\/dsh-wechat\/\?t=[0-9a-f]+/.exec(line)?.[0]).find(Boolean),
      { timeoutMs: 8_000, label: 'gui-origin url in the log' },
    )
    const token = /t=([0-9a-f]+)/.exec(url)[1]

    // The route enforces the same one-time token as the standalone page.
    const call = async (target) =>
      new Promise((resolve) => {
        const response = {
          statusCode: null,
          headers: null,
          body: '',
          writeHead(status, headers) {
            this.statusCode = status
            this.headers = headers
          },
          end(body) {
            this.body = body ?? ''
            resolve(this)
          },
        }
        routes[0].handler({ url: target, method: 'GET' }, response)
      })

    const denied = await call('/dsh-wechat/')
    assert.equal(denied.statusCode, 403)

    const page = await call(`/dsh-wechat/?t=${token}`)
    assert.equal(page.statusCode, 200)
    assert.match(page.headers['Content-Type'], /text\/html/)
    assert.ok(page.body.includes('<svg'), 'the GUI route serves the scan code')

    const state = await call(`/dsh-wechat/state.json?t=${token}`)
    assert.equal(state.statusCode, 200)
    assert.equal(JSON.parse(state.body).hasQr, true)

    await fiber.dispose()
    fiber = null
    assert.equal(routes.length, 0, 'the route is removed with the plugin')
  } finally {
    console.log = realLog
    try {
      await fiber?.dispose?.()
    } catch {
      // Assertions above own the failures.
    }
    await gateway.close()
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('booting the plugin records which build is running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-boot-'))
  const gateway = await startGateway({})
  const ctx = new Context()
  // The plugin injects both services; without `agents` its apply never runs, which
  // is exactly the kind of wiring mistake this test exists to catch.
  ctx.provide('agents', { list: () => [], get: () => undefined, currentInitiator: () => undefined })
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  const fiber = ctx.plugin(plugin, {
    stateDir: root,
    baseUrl: gateway.baseUrl,
    accessPolicy: 'open',
    typing: false,
    loginPage: false,
    openLoginPage: false,
    autoLogin: false,
    logLevel: 'silent',
  })
  try {
    const stateFile = path.join(root, 'state.json')
    await waitFor(async () => {
      try {
        const state = JSON.parse(await readFile(stateFile, 'utf8'))
        return Array.isArray(state.boots) && state.boots.length > 0
      } catch {
        return false
      }
    }, { label: 'boot record written' })

    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const boot = state.boots.at(-1)
    // The record must name the code that is executing, which is what makes
    // "installed ≠ running" answerable after a hot config reload.
    assert.equal(boot.version, manifest.version)
    assert.equal(boot.pid, process.pid)
    assert.match(boot.at, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await fiber.dispose()
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  }
})
