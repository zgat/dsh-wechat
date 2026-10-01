/**
 * Test doubles: a fake harness context (agent registry + event bus), a fake iLink
 * client, and a temporary state directory.
 *
 * The fake harness reproduces exactly the surface the plugin is contractually
 * allowed to touch — `ctx.get(name)`, `ctx.on(name, handler, options)`,
 * `ctx.effect`, `ctx.inject`, and the documented `AgentRegistry` / `Agent` /
 * `Session` members — so a passing bridge test means the plugin only used the
 * documented API.
 */

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { decryptAesEcb, encryptAesEcb, encodeAesKey } from '../lib/ilink/crypto.js'
import { createLogger } from '../lib/log.js'
import { WechatStore } from '../lib/store.js'

/** A context + registry pair that behaves like the harness at the seams we use. */
export function createFakeHarness(options = {}) {
  const listeners = new Map()
  const agents = []
  const disposed = []
  const services = new Map()
  let initiator

  // `emitTo` lets a test route events through the real cordis bus instead of this
  // local one, which is what the plugin entry actually subscribes to.
  const emit = (name, ...args) => {
    if (options.emitTo) {
      options.emitTo(name, ...args)
      return
    }
    for (const handler of listeners.get(name) ?? []) handler(...args)
  }

  let emittedTurns = 0

  /**
   * Emit one whole turn: start, streamed text, committed end.
   * @param {object} agent_ - agent whose turn this is.
   * @param {string} [streamText] - text to stream.
   * @param {number} [turn] - an already-opened turn (a deferred one).
   */
  const completeTurn = (agent_, streamText, turn) => {
    const openTurn = turn ?? ++emittedTurns
    const attemptId = `attempt-${openTurn}`
    const text = streamText ?? options.reply ?? '好的，收到。'
    if (turn === undefined) emit('session/event', agent_.session, { type: 'turn/start', data: { turn: openTurn } })
    emit('agent/assistant-stream', { agent: agent_, frame: { type: 'start', attemptId, revision: 1, turn, step: 1 } })
    for (const piece of String(text).match(/.{1,7}/gs) ?? []) {
      emit('agent/assistant-stream', {
        agent: agent_,
        frame: { type: 'chunk', attemptId, revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: piece } },
      })
    }
    emit('agent/assistant-stream', {
      agent: agent_,
      frame: { type: 'end', attemptId, revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
    })
    emit('session/event', agent_.session, { type: 'turn/end', data: { turn: openTurn, reason: options.reason ?? { kind: 'completed' } } })
  }

  const defaultResponder = ({ agent: agent_ }) => completeTurn(agent_, options.reply)

  const makeAgent = (session, agentOptions) => {
    // The real loop runs one turn at a time per agent, and the stub keeps that
    // ordering: half the bridge's job is matching answers to the turns that asked
    // for them, which a concurrent stub could not exercise.
    const jobQueue = []
    let running = false
    let active = null

    const pump = () => {
      if (running || jobQueue.length === 0) return
      running = true
      const job = jobQueue.shift()
      let deferred = false
      active = {
        complete: (streamText) => {
          active = null
          running = false
          completeTurn(job.agent, streamText, activeTurn)
          pump()
        },
      }
      let activeTurn
      const responder = options.respond ?? defaultResponder
      try {
        responder({ emit, agent: job.agent, message: job.message, defer: () => {
          deferred = true
          // A deferred turn is one the loop has picked up: it opens before the
          // responder returns, exactly like the real driver.
          activeTurn = ++emittedTurns
          emit('session/event', job.agent.session, { type: 'turn/start', data: { turn: activeTurn } })
        } })
      } catch (error) {
        emit('session/event', job.agent.session, {
          type: 'turn/end',
          data: { turn: emittedTurns + 1, reason: { kind: 'error', error: { message: String(error?.message ?? error), code: 'TEST' } } },
        })
      }
      if (!deferred) {
        running = false
        active = null
        pump()
      }
    }

    const agent = {
      id: session.id,
      session,
      options: agentOptions ?? {},
      inbox: { append() {}, prepend() {}, replace() {}, remove() {}, clear() {}, splice() {} },
      status: 'idle',
      ctx: null,
      followups: [],
      prompts: [],
      cancels: [],
      /** Finish a turn the stub is holding open (a responder that called `defer`). */
      completeDeferredTurn(streamText) {
        if (!active) throw new Error('no deferred turn is open')
        active.complete(streamText)
      },
      followup(message) {
        agent.followups.push(message)
        // Convenience view: the plain text of every follow-up, for assertions.
        const content = message?.content ?? message?.message?.content
        agent.prompts.push(
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join(' ')
              : '',
        )
        jobQueue.push({ agent, message })
        queueMicrotask(pump)
      },
      steer() {},
      inject() {},
      send() {},
      cancel(cause) {
        agent.cancels.push(cause)
      },
      whenIdle: async () => {},
      runMaintenance: async (task) => task(new AbortController().signal),
    }
    return agent
  }

  const registry = {
    currentInitiator: () => initiator,
    requireInitiator: () => initiator,
    get: (id) => agents.find((agent) => agent.session.id === id),
    list: () => [...agents],
    roots: () => [...agents],
    isOwnedBy: () => false,
    setFactory: () => () => {},
    async create({ sessionId, meta, agentOptions, setup }) {
      if (agents.some((agent) => agent.session.id === sessionId)) {
        throw new Error(`session ${sessionId} already exists`)
      }
      const setups = []
      const agentCtx = {
        get: (key) => services.get(key),
        on: () => () => {},
        effect: (body) => {
          const disposer = body?.()
          return () => disposer?.()
        },
      }
      if (setup) setups.push(setup)
      const session = {
        id: sessionId,
        meta,
        // The real Session exposes an immutable header; workspace membership and
        // the `/session` listing both read `header.cwd`.
        // The real store fills the immutable header from `meta` (cwd, agentPreset, …).
        header: { id: sessionId, ...(meta ?? {}), createdAt: Date.now() },
        deriveMessages: () => options.derivedMessages ?? [],
      }
      const agent = makeAgent(session, agentOptions)
      // Setup runs before publication, exactly like the loop's creation transaction.
      for (const run of setups) await run(agentCtx, agent)
      agent.setupRan = setups.length > 0
      agents.push(agent)
      return {
        agent,
        dispose: async () => {
          disposed.push(sessionId)
          const index = agents.indexOf(agent)
          if (index >= 0) agents.splice(index, 1)
        },
      }
    },
    async resume({ resumeSessionId, agentOptions, setup }) {
      if (options.resumeFails) throw new Error('no persisted session')
      if (setup) {
        await setup(
          {
            get: (key) => services.get(key),
            on: () => () => {},
            effect: (body) => {
              const disposer = body?.()
              return () => disposer?.()
            },
          },
          { session: { id: resumeSessionId } },
        )
      }
      const session = {
        id: resumeSessionId,
        header: { id: resumeSessionId, cwd: options.resumeCwd ?? '/tmp', createdAt: Date.now() - 1_000 },
        deriveMessages: () => options.derivedMessages ?? [],
      }
      const agent = makeAgent(session, agentOptions)
      agents.push(agent)
      return {
        agent,
        dispose: async () => {
          disposed.push(resumeSessionId)
          const index = agents.indexOf(agent)
          if (index >= 0) agents.splice(index, 1)
        },
      }
    },
  }
  services.set('agents', registry)
  // The plugin also reads `ctx.sessions` (live sessions). Back it with the agents
  // this stub created, so the shape matches the host's SessionStore.
  // Sessions that exist without an agent (a child session the plugin only reads).
  const extraSessions = new Map()
  services.set('sessions', {
    list: () => [...agents.map((agent) => agent.session), ...extraSessions.values()],
    get: (id) => agents.find((agent) => agent.session.id === id)?.session ?? extraSessions.get(id),
  })
  if (options.agentDefaultModel !== undefined) {
    services.set('agentDefaultModel', options.agentDefaultModel)
  }
  for (const [key, value] of Object.entries(options.services ?? {})) services.set(key, value)

  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => services.set(key, value),
    on: (eventName, handler) => {
      const list = listeners.get(eventName) ?? []
      list.push(handler)
      listeners.set(eventName, list)
      return () => {
        const current = listeners.get(eventName) ?? []
        listeners.set(
          eventName,
          current.filter((entry) => entry !== handler),
        )
      }
    },
    emit,
    effect: (body) => {
      const disposer = body()
      return () => disposer?.()
    },
    inject: (deps, callback) => {
      callback()
      return { dispose() {} }
    },
    setInitiator: (agent) => {
      initiator = agent
    },
  }

  return {
    ctx,
    registry,
    agents,
    disposed,
    services,
    emit,
    /** Inject a session that has no agent, e.g. a delegated child session. */
    sessions: extraSessions,
    listenerCount: (eventName) => (listeners.get(eventName) ?? []).length,
  }
}

/** A recording iLink client that never touches the network. */
export function createFakeClient(options = {}) {
  const sent = []
  const typing = []
  const uploads = []
  const downloads = []
  return {
    sent,
    typing,
    uploads,
    downloads,
    baseUrl: 'https://ilink.example',
    token: options.token ?? 'test-token',
    setCredential({ token, baseUrl } = {}) {
      if (token) this.token = token
      if (baseUrl) this.baseUrl = baseUrl
    },
    async getBotQrCode() {
      return { qrcode: 'qrc_test', qrcodeImgContent: 'https://weixin.qq.com/x/test-qr' }
    },
    async getQrCodeStatus() {
      return { status: 'confirmed', botToken: 'token-from-qr', ilinkBotId: 'bot@im.bot', ilinkUserId: 'owner@im.wechat', baseUrl: 'https://ilink.example' }
    },
    async getUpdates() {
      return { ret: 0, msgs: [], cursor: 'cursor-1' }
    },
    async sendMessage(payload) {
      sent.push(payload)
      return {}
    },
    async sendText(payload) {
      sent.push({ kind: 'text', ...payload })
      return {}
    },
    async getConfig() {
      return 'ticket-1'
    },
    async sendTyping(payload) {
      typing.push(payload)
      return {}
    },
    async getUploadUrl(payload) {
      uploads.push(payload)
      return { uploadParam: 'upload-param', thumbUploadParam: '' }
    },
    async uploadCdn({ ciphertext }) {
      downloads.push(ciphertext)
      return 'encrypted-param'
    },
    async downloadCdn({ encryptQueryParam }) {
      const key = Buffer.from(options.mediaKeyHex ?? '00112233445566778899aabbccddeeff', 'hex')
      const plaintext = Buffer.from(options.mediaPayload ?? 'hello-media', 'utf8')
      const ciphertext = encryptAesEcb(plaintext, key)
      downloads.push({ encryptQueryParam, ciphertext })
      return ciphertext
    },
    async notifyLifecycle() {},
  }
}

/** An isolated state directory + store, cleaned up by the caller. */
export async function createTempStore(rawConfig = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-test-'))
  const config = normalizeConfig({ stateDir: dir, ...rawConfig })
  const logger = createLogger('silent')
  const store = new WechatStore({ config, logger })
  await store.load()
  return {
    dir,
    config,
    store,
    async cleanup() {
      await store.flush()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/**
 * Build one inbound iLink message.
 * @param {{ userId?: string, text?: string, id?: number, token?: string, items?: object[], groupId?: string }} [options]
 */
export function inboundMessage(options = {}) {
  const items = options.items ?? [{ type: 1, text_item: { text: options.text ?? '你好' } }]
  return {
    seq: options.seq ?? 1,
    message_id: options.id ?? 1001,
    from_user_id: options.userId ?? 'user@im.wechat',
    to_user_id: 'bot@im.bot',
    message_type: 1,
    message_state: 2,
    context_token: options.token ?? 'ctx-token',
    ...(options.groupId ? { group_id: options.groupId } : {}),
    item_list: items,
  }
}

/** Wait until `predicate()` is true, or fail after `timeoutMs`. */
export async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 5, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export { decryptAesEcb, encryptAesEcb, encodeAesKey }

/** A fake iLink gateway that hands out one message and records every reply. */
export async function startGateway() {
  const state = { updates: [], sent: [], polls: 0, typing: [], uploads: [], qrPhase: 'wait', qrIssued: 0 }
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url, 'http://localhost')
      const send = (payload, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (url.pathname === '/ilink/bot/get_bot_qrcode') {
        state.qrIssued += 1
        send({ qrcode: `qrc_${state.qrIssued}`, qrcode_img_content: 'https://weixin.qq.com/x/plugin-test-qr' })
        return
      }
      if (url.pathname === '/ilink/bot/get_qrcode_status') {
        if (state.qrPhase === 'confirmed') {
          send({ status: 'confirmed', bot_token: 'token-from-qr', ilink_bot_id: 'bot-qr@im.bot', ilink_user_id: 'owner@im.wechat', baseurl: state.baseUrl })
          return
        }
        send({ status: state.qrPhase })
        return
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        state.polls += 1
        const batch = state.updates
        state.updates = []
        send({ ret: 0, msgs: batch, get_updates_buf: `cursor-${state.polls}` })
        return
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        state.sent.push(body.msg)
        send({})
        return
      }
      if (url.pathname === '/ilink/bot/getconfig') {
        send({ ret: 0, typing_ticket: 'ticket' })
        return
      }
      if (url.pathname === '/ilink/bot/sendtyping') {
        state.typing.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        send({ ret: 0 })
        return
      }
      send({ ret: 0 })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  state.baseUrl = baseUrl
  return {
    state,
    baseUrl,
    push(message) {
      state.updates.push(message)
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

