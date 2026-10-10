import test from 'node:test'
import assert from 'node:assert/strict'

import { InteractionRouter, parseApprovalReply, parseQuestionsReply } from '../lib/approval.js'
import { WechatBridge, conversationKeyOf, userIdOf } from '../lib/bridge.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogger } from '../lib/log.js'
import { createFakeClient, createFakeHarness, createTempStore, inboundMessage, waitFor } from './helpers.mjs'

const logger = createLogger('silent')

/** Wire a bridge over the fakes. */
async function setup(options = {}) {
  const temp = await createTempStore({ accessPolicy: 'open', typing: false, ...(options.config ?? {}) })
  const harness = createFakeHarness(options.harness)
  const client = createFakeClient()
  const interactions = new InteractionRouter({
    config: temp.config,
    logger,
    send: (key, text) => bridge.deliver(key, text),
    conversationOf: (sessionId) => bridge.conversationForSession(sessionId),
    ownsInteraction: (sessionId) => bridge.isDrivingTurn(sessionId),
    watchesInteraction: (sessionId) => bridge.watchesInteraction(sessionId),
  })
  const bridge = new WechatBridge({
    ctx: harness.ctx,
    config: temp.config,
    store: temp.store,
    client,
    interactions,
    logger,
  })
  // The plugin entry registers these two listeners; the test wires them by hand
  // so the bridge can be driven without booting a whole profile.
  harness.ctx.on('agent/assistant-stream', (payload) => bridge.onAgentStream(payload))
  harness.ctx.on('session/event', (session, event) => bridge.onSessionEvent(session, event))
  // Most cases are about turn mechanics rather than onboarding, so the greeting
  // counts as already delivered unless the case asks for it.
  if (!options.welcome) temp.store.state.welcomed = { 'p2p:user@im.wechat': 'seeded-by-test' }
  return {
    bridge,
    client,
    harness,
    interactions,
    ...temp,
    async cleanup() {
      await bridge.disposeAll()
      await temp.cleanup()
    },
  }
}

test('conversation keys and user ids round-trip', () => {
  assert.equal(conversationKeyOf(inboundMessage({ userId: 'a@im.wechat' })), 'p2p:a@im.wechat')
  assert.equal(conversationKeyOf(inboundMessage({ userId: 'a@im.wechat', groupId: 'g1' })), 'group:g1')
  assert.equal(userIdOf('p2p:a@im.wechat'), 'a@im.wechat')
  assert.equal(userIdOf('group:g1'), undefined)
})

test('an inbound message creates one session, runs a turn, and replies with the streamed text', async () => {
  const env = await setup({ harness: { reply: '这是最终回答。' } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '帮我看看仓库' }))

    await waitFor(() => env.client.sent.length > 0, { label: 'reply delivery' })
    assert.equal(env.client.sent.length, 1)
    assert.equal(env.client.sent[0].text, '这是最终回答。')
    assert.equal(env.client.sent[0].toUserId, 'user@im.wechat')
    assert.equal(env.client.sent[0].contextToken, 'ctx-token')

    // The prompt reached the agent as a user-role message.
    const agent = env.harness.agents[0]
    assert.equal(agent.followups.length, 1)
    assert.equal(agent.followups[0].role, 'user')
    assert.deepEqual(agent.followups[0].content, [{ type: 'text', text: '帮我看看仓库' }])
    assert.equal(Object.isFrozen(agent.followups[0]), true)

    // And the session binding is durable.
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), agent.session.id)
  } finally {
    await env.cleanup()
  }
})

test('a second message reuses the live session instead of creating another', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一条', id: 1 }))
    await waitFor(() => env.client.sent.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '第二条', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)

    assert.equal(env.harness.agents.length, 1)
    assert.equal(env.harness.agents[0].followups.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('duplicate deliveries are dropped', async () => {
  const env = await setup()
  try {
    const message = inboundMessage({ text: '只处理一次', id: 777 })
    await env.bridge.handleInbound(message)
    await waitFor(() => env.client.sent.length === 1)
    await env.bridge.handleInbound({ ...message })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(env.client.sent.length, 1)
    assert.equal(env.harness.agents[0].followups.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('bot echoes and unaddressed messages are ignored', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound({ ...inboundMessage({ text: 'echo' }), message_type: 2 })
    await env.bridge.handleInbound({ ...inboundMessage({ text: 'no sender' }), from_user_id: '' })
    assert.equal(env.client.sent.length, 0)
    assert.equal(env.harness.agents.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('allowlist rejects an unknown sender before any session exists', async () => {
  const env = await setup({ config: { accessPolicy: 'allowlist', allowedUserIds: ['friend@im.wechat'] } })
  try {
    await env.bridge.handleInbound(inboundMessage({ userId: 'stranger@im.wechat', text: 'hi' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.match(env.client.sent[0].text, /白名单/)
    assert.equal(env.harness.agents.length, 0)

    await env.bridge.handleInbound(inboundMessage({ userId: 'friend@im.wechat', text: 'hi', id: 2 }))
    await waitFor(() => env.harness.agents.length === 1)
  } finally {
    await env.cleanup()
  }
})

test('a resumed session is preferred over a new one', async () => {
  const env = await setup()
  try {
    await env.store.setSession('p2p:user@im.wechat', 'session-existing')
    await env.bridge.handleInbound(inboundMessage({ text: '继续上次' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.equal(env.harness.agents.length, 1)
    assert.equal(env.harness.agents[0].session.id, 'session-existing')
  } finally {
    await env.cleanup()
  }
})

test('long replies are chunked to the configured size', async () => {
  const long = 'A'.repeat(4_100)
  const env = await setup({ config: { chunkChars: 1_800 }, harness: { reply: long } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '写一篇长文' }))
    await waitFor(() => env.client.sent.length >= 3, { label: 'three chunks' })
    const chunks = env.client.sent.map((entry) => entry.text)
    assert.equal(chunks.length, 3)
    assert.equal(chunks.join(''), long)
    for (const chunk of chunks) assert.ok(chunk.length <= 1_800)
  } finally {
    await env.cleanup()
  }
})

test('an aborted turn reports the stop and keeps partial text', async () => {
  const env = await setup({
    harness: {
      reply: '一半的回答',
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.client.sent.length > 0)
    assert.equal(env.client.sent[0].text, '一半的回答\n\n（已停止）')
  } finally {
    await env.cleanup()
  }
})

test('a failed turn surfaces the error message', async () => {
  const env = await setup({
    harness: { reply: '', reason: { kind: 'error', error: { message: '模型调用失败', code: 'LLM' } } },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.client.sent.length > 0)
    assert.match(env.client.sent[0].text, /回合失败：模型调用失败/)
  } finally {
    await env.cleanup()
  }
})

test('tool calls produce progress lines when progress is on', async () => {
  const env = await setup({
    config: { progress: 'brief', showToolProgress: true },
    harness: {
      respond: ({ emit, agent }) => {
        const session = agent.session
        emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
        emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' } })
        emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
        emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '完成了。' } } })
        emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '看下目录' }))
    await waitFor(() => env.client.sent.length >= 2, { label: 'progress + answer' })
    assert.match(env.client.sent[0].text, /^🔧 bash /)
    assert.match(env.client.sent[0].text, /ls -la/)
    assert.equal(env.client.sent[1].text, '完成了。')
  } finally {
    await env.cleanup()
  }
})

test('slash commands answer without touching the agent', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/help' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.match(env.client.sent[0].text, /\/new/)
    assert.equal(env.harness.agents.length, 0)

    await env.bridge.handleInbound(inboundMessage({ text: '/ping', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /pong/)

    await env.bridge.handleInbound(inboundMessage({ text: '/不存在的指令', id: 3 }))
    await waitFor(() => env.client.sent.length === 3)
    assert.match(env.client.sent[2].text, /未知指令/)
  } finally {
    await env.cleanup()
  }
})

test('/new disposes the live agent and clears the binding', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const sessionId = env.harness.agents[0].session.id

    await env.bridge.handleInbound(inboundMessage({ text: '/new', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /已结束上一个会话/)
    assert.deepEqual(env.harness.disposed, [sessionId])
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), undefined)

    await env.bridge.handleInbound(inboundMessage({ text: '新会话', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.notEqual(env.harness.agents[0].session.id, sessionId)
  } finally {
    await env.cleanup()
  }
})

test('/stop cancels the running turn', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '/stop', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /已请求停止/.test(entry.text)))
    assert.deepEqual(env.harness.agents[0].cancels, [{ kind: 'user' }])
  } finally {
    await env.cleanup()
  }
})

test('/model persists per conversation and shows in the summary', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/workspace /tmp', id: 1 }))
    await waitFor(() => env.client.sent.length === 1)
    assert.match(env.client.sent[0].text, /已切换到项目目录：\/tmp/)

    await env.bridge.handleInbound(inboundMessage({ text: '/model deepseek-account/deepseek-flash', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /deepseek-account\/deepseek-flash/)

    const info = await env.bridge.describeConversation('p2p:user@im.wechat')
    assert.equal(info.model, 'deepseek-account/deepseek-flash')
    assert.equal(info.workspace, '/tmp')
  } finally {
    await env.cleanup()
  }
})

test('typing state starts, refreshes and stops around a turn', async () => {
  const env = await setup({ config: { typing: true, typingKeepaliveSeconds: 2 } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '在吗' }))
    await waitFor(() => env.client.sent.length === 1)
    await waitFor(() => env.client.typing.some((entry) => entry.status === 2), { label: 'typing stop' })
    assert.ok(env.client.typing.some((entry) => entry.status === 1))
    assert.equal(env.client.typing[0].ilinkUserId, 'user@im.wechat')
    assert.equal(env.client.typing[0].typingTicket, 'ticket-1')
  } finally {
    await env.cleanup()
  }
})

test('inbound media is decrypted into the state directory and referenced in the prompt', async () => {
  const env = await setup({ config: { media: { enabled: true } } })
  try {
    const { encryptAesEcb } = await import('../lib/ilink/crypto.js')
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const ciphertext = encryptAesEcb(Buffer.from('假装这是图片字节', 'utf8'), key)
    env.client.downloadCdn = async () => ciphertext

    await env.bridge.handleInbound(
      inboundMessage({
        text: '看这张图',
        items: [
          { type: 1, text_item: { text: '看这张图' } },
          {
            type: 2,
            image_item: { media: { encrypt_query_param: 'param', aes_key: Buffer.from(key).toString('base64'), encrypt_type: 1 }, mid_size: ciphertext.length },
          },
        ],
      }),
    )
    await waitFor(() => env.client.sent.length === 1)
    const prompt = env.harness.agents[0].followups[0].content[0].text
    assert.match(prompt, /看这张图/)
    assert.match(prompt, /\[微信附件\]/)
    assert.match(prompt, /图片「/)

    const { readFile } = await import('node:fs/promises')
    const filePath = /已保存到：(.+?)（/.exec(prompt)[1]
    assert.equal(await readFile(filePath, 'utf8'), '假装这是图片字节')
  } finally {
    await env.cleanup()
  }
})

test('a quote is carried into the prompt', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(
      inboundMessage({
        items: [
          {
            type: 1,
            text_item: { text: '这句要改吗' },
            ref_msg: { title: '引用了一条消息', message_item: { type: 1, text_item: { text: '原文内容' } } },
          },
        ],
      }),
    )
    await waitFor(() => env.harness.agents.length === 1)
    assert.match(env.harness.agents[0].followups[0].content[0].text, /\[引用消息\] 原文内容/)
  } finally {
    await env.cleanup()
  }
})

test('an approval request is answered from the chat', async () => {
  const env = await setup({
    config: { approvalTimeoutSeconds: 30 },
    // Hold the turn open: approvals and questions happen *inside* a running turn, and
    // the interaction router only claims what the WeChat turn started.
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '删掉临时文件' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]

    let outcome
    const pending = env.interactions
      .handleApproval({ agent, toolName: 'bash', reason: 'rm -rf /tmp/x', signal: new AbortController().signal }, async () => 'delegated')
      .then((value) => {
        outcome = value
      })

    await waitFor(() => env.client.sent.some((entry) => /需要你确认/.test(entry.text)), { label: 'approval prompt' })
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), true)

    await env.bridge.handleInbound(inboundMessage({ text: '允许', id: 99 }))
    await pending
    assert.equal(outcome, 'allowed-once')
    // The approval reply must not have started a new turn.
    assert.equal(agent.followups.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('an approval can be rejected, and unknown text keeps waiting', async () => {
  const env = await setup({
    config: { approvalTimeoutSeconds: 30 },
    // Hold the turn open: approvals and questions happen *inside* a running turn, and
    // the interaction router only claims what the WeChat turn started.
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]

    const pending = env.interactions.handleApproval({ agent, toolName: 'bash', signal: new AbortController().signal }, async () => 'delegated')
    await waitFor(() => env.interactions.isWaiting('p2p:user@im.wechat'))

    assert.equal(env.interactions.tryConsume('p2p:user@im.wechat', '这是什么'), false)
    assert.equal(env.interactions.tryConsume('p2p:user@im.wechat', '拒绝'), true)
    assert.equal(await pending, 'rejected')
  } finally {
    await env.cleanup()
  }
})

test('an approval for an unknown session delegates to the next answerer', async () => {
  const env = await setup()
  try {
    const result = await env.interactions.handleApproval(
      { agent: { session: { id: 'session-unrelated' } }, toolName: 'bash', signal: new AbortController().signal },
      async () => 'delegated',
    )
    assert.equal(result, 'delegated')
    assert.equal(env.client.sent.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('questions render options and accept a numbered reply', async () => {
  const env = await setup({
    config: { questionsTimeoutSeconds: 30 },
    // Hold the turn open: approvals and questions happen *inside* a running turn, and
    // the interaction router only claims what the WeChat turn started.
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]

    const pending = env.interactions.handleQuestions(
      {
        agent,
        signal: new AbortController().signal,
        questions: [
          {
            id: 'q1',
            question: '用哪个模型？',
            options: [
              { label: 'deepseek-flash', description: '更快' },
              { label: 'deepseek-pro', description: '更强' },
            ],
          },
        ],
      },
      async () => 'delegated',
    )

    await waitFor(() => env.client.sent.some((entry) => /Agent 需要你的回答/.test(entry.text)))
    assert.match(env.client.sent.at(-1).text, /1\) deepseek-flash — 更快/)

    await env.bridge.handleInbound(inboundMessage({ text: '2', id: 42 }))
    assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['deepseek-pro'] }] })
  } finally {
    await env.cleanup()
  }
})

test('question replies without options are passed through as custom answers', () => {
  const batch = parseQuestionsReply([{ id: 'q1', question: '项目叫什么？' }], '叫 dsh-wechat')
  assert.deepEqual(batch, { answers: [{ id: 'q1', selected: [], custom: '叫 dsh-wechat' }] })
})

test('approval replies are recognized in both languages', () => {
  assert.equal(parseApprovalReply('允许'), 'allow')
  assert.equal(parseApprovalReply(' YES '), 'allow')
  assert.equal(parseApprovalReply('/approve'), 'allow')
  assert.equal(parseApprovalReply('拒绝'), 'reject')
  assert.equal(parseApprovalReply('no'), 'reject')
  assert.equal(parseApprovalReply('取消'), 'cancel')
  assert.equal(parseApprovalReply('再想想'), null)
})

test('tools deliver through the same path as final answers', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)

    const count = await env.bridge.deliver('p2p:user@im.wechat', '主动推送一条')
    assert.equal(count, 1)
    assert.equal(env.client.sent.at(-1).text, '主动推送一条')

    await assert.rejects(() => env.bridge.deliver('group:g1', '群里发不了'), /cannot address conversation/)
  } finally {
    await env.cleanup()
  }
})

test('outbound files are encrypted, uploaded and referenced', async () => {
  const env = await setup()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-wechat-outbox-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const filePath = join(outside, 'report.txt')
    await writeFile(filePath, 'hello file')

    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const result = await env.bridge.deliverFile('p2p:user@im.wechat', filePath)
    assert.equal(result.name, 'report.txt')
    assert.equal(result.size, 10)

    const upload = env.client.uploads.at(-1)
    assert.equal(upload.rawSize, 10)
    assert.equal(upload.mediaType, 3)
    assert.equal(upload.encryptedSize, 16)
    const item = env.client.sent.at(-1).item
    assert.equal(item.type, 4)
    assert.equal(item.file_item.file_name, 'report.txt')
    assert.equal(item.file_item.len, '10')
    assert.ok(item.file_item.media.encrypt_query_param)
  } finally {
    await rm(outside, { recursive: true, force: true })
    await env.cleanup()
  }
})

test('the state directory is never sent as a chat attachment', async () => {
  const env = await setup()
  try {
    // The credential lives there; a prompt-injected agent must not post it.
    await assert.rejects(
      () => env.bridge.deliverFile('p2p:user@im.wechat', join(env.dir, 'credentials.json')),
      /拒绝发送状态目录内的文件/,
    )
  } finally {
    await env.cleanup()
  }
})

test('a reply token from a rejected sender is not cached', async () => {
  const env = await setup({ config: { accessPolicy: 'allowlist', allowedUserIds: ['friend@im.wechat'] } })
  try {
    await env.bridge.handleInbound(inboundMessage({ userId: 'stranger@im.wechat', token: 'stranger-token' }))
    await waitFor(() => env.client.sent.length === 1)
    // The rejection is delivered, but the token is not usable afterwards.
    assert.equal(env.store.contextTokenFor('stranger@im.wechat'), undefined)
    assert.equal(env.bridge.maySendTo('p2p:stranger@im.wechat', 'p2p:friend@im.wechat'), false)
  } finally {
    await env.cleanup()
  }
})

test('disposeAll tears down live agents', async () => {
  const env = await setup()
  await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
  await waitFor(() => env.harness.agents.length === 1)
  const sessionId = env.harness.agents[0].session.id
  await env.bridge.disposeAll()
  assert.deepEqual(env.harness.disposed, [sessionId])
  await env.cleanup()
})

test('a created agent always carries a model route for prompt assembly', async () => {
  // Without a route the shipped persona text ("powered by the {{model}} model")
  // cannot render, so the deployment default must be adopted.
  const env = await setup({
    harness: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.deepEqual(env.harness.agents[0].options, {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
  } finally {
    await env.cleanup()
  }
})

test('an explicit plugin model wins over the deployment default', async () => {
  const env = await setup({
    config: { model: { provider: 'deepseek-account', model: 'deepseek-pro' } },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'other', model: 'other-model' }) },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.deepEqual(env.harness.agents[0].options, { provider: 'deepseek-account', model: 'deepseek-pro' })
  } finally {
    await env.cleanup()
  }
})

test('a per-chat /model override wins over both', async () => {
  const env = await setup({
    config: { model: { provider: 'deepseek-account', model: 'deepseek-pro' } },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'other', model: 'other-model' }) },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/model deepseek-account/deepseek-flash', id: 1 }))
    await waitFor(() => env.client.sent.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '开始', id: 2 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.deepEqual(env.harness.agents[0].options, { provider: 'deepseek-account', model: 'deepseek-flash' })
  } finally {
    await env.cleanup()
  }
})

test('a resumed session also keeps a model route', async () => {
  const env = await setup({
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    },
  })
  try {
    await env.store.setSession('p2p:user@im.wechat', 'session-existing')
    await env.bridge.handleInbound(inboundMessage({ text: '继续' }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].session.id, 'session-existing')
    assert.deepEqual(env.harness.agents[0].options, { provider: 'deepseek-account', model: 'deepseek-flash' })
  } finally {
    await env.cleanup()
  }
})

test('the first message is answered with an onboarding guide', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: {
        workspaceRegistry: {
          // Real directories: the command validates that the path exists.
          list: () => [
            { path: '/Volumes/Seagate ZP1000/Dev', title: 'Dev' },
            { path: '/tmp', title: 'scratch' },
          ],
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.client.sent.length >= 2, { label: 'welcome + answer' })

    const welcome = env.client.sent[0].text
    assert.match(welcome, /微信机器人已就绪/)
    assert.match(welcome, /\/workspace/)
    assert.match(welcome, /\/model/)
    assert.match(welcome, /\/reasoning/)
    assert.match(welcome, /当前：工作区 \/Volumes\/Seagate ZP1000\/Dev/)
    // The greeting goes out before the turn's answer.
    assert.notEqual(env.client.sent[1].text, welcome)

    // …and only once.
    await env.bridge.handleInbound(inboundMessage({ text: '再来一次', id: 2 }))
    await waitFor(() => env.client.sent.length >= 3)
    assert.equal(env.client.sent.filter((entry) => /微信机器人已就绪/.test(entry.text)).length, 1)
  } finally {
    await env.cleanup()
  }
})

test('a command as first contact skips the greeting', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/ping' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.match(env.client.sent[0].text, /pong/)
    assert.equal(env.client.sent.filter((entry) => /微信机器人已就绪/.test(entry.text)).length, 0)
  } finally {
    await env.cleanup()
  }
})

test('/workspace lists project directories by name and selects by number', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      services: {
        workspaceRegistry: {
          // Real directories: the command validates that the path exists.
          list: () => [
            { path: '/Volumes/Seagate ZP1000/Dev', title: 'Dev' },
            { path: '/tmp', title: 'scratch' },
          ],
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/workspace' }))
    await waitFor(() => env.client.sent.length === 1)
    const list = env.client.sent.map((entry) => entry.text).find((text) => /项目目录/.test(text))
    // The friendly name comes first: that is the "project" the user recognises.
    assert.match(list, /1\. Dev（\/Volumes\/Seagate ZP1000\/Dev）/)
    assert.match(list, /2\. scratch（\/tmp）/)

    await env.bridge.handleInbound(inboundMessage({ text: '/workspace 2', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    const switched = env.client.sent.map((entry) => entry.text).find((text) => /已切换到项目目录/.test(text))
    assert.match(switched, /\/tmp/)
    assert.equal(env.store.state.workspaces['p2p:user@im.wechat'], '/tmp')
  } finally {
    await env.cleanup()
  }
})

test('/workspace accepts a project name, and switching ends the old session', async () => {
  const env = await setup({
    harness: {
      reply: 'ok',
      services: {
        workspaceRegistry: {
          list: () => [
            { path: '/Volumes/Seagate ZP1000/Dev', title: 'Dev' },
            { path: '/tmp', title: 'scratch' },
          ],
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const previous = env.harness.agents[0].session.id

    await env.bridge.handleInbound(inboundMessage({ text: '/workspace scratch', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /已切换到项目目录/.test(entry.text)))
    const reply = env.client.sent.map((entry) => entry.text).find((text) => /已切换到项目目录/.test(text))
    assert.match(reply, new RegExp(previous))
    // The old agent is gone and the binding is clear, so the next message starts fresh.
    assert.deepEqual(env.harness.disposed, [previous])
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), undefined)

    await env.bridge.handleInbound(inboundMessage({ text: '新项目', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.notEqual(env.harness.agents[0].session.id, previous)
  } finally {
    await env.cleanup()
  }
})

test('/workspace add registers a new project directory', async () => {
  const created = []
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: {
          list: () => created.map((entry) => ({ path: entry.path, title: entry.title })),
          create: async (path, title) => {
            created.push({ path, title })
            return { path, title }
          },
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/workspace add /tmp myproj' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.deepEqual(created, [{ path: '/tmp', title: 'myproj' }])
    assert.match(env.client.sent[0].text, /已登记并切换到项目目录：\/tmp/)
    assert.equal(env.store.state.workspaces['p2p:user@im.wechat'], '/tmp')
  } finally {
    await env.cleanup()
  }
})

test('an unusable project directory produces an explanation, not silence', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/workspace /definitely/not/here' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.match(env.client.sent[0].text, /工作区路径不存在或不是目录/)
    assert.equal(env.store.state.workspaces?.['p2p:user@im.wechat'], undefined)
  } finally {
    await env.cleanup()
  }
})

test('/model lists the llm catalog and selects by number', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: {
        llm: {
          listProviders: async () => [{ id: 'deepseek-account' }],
          listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-pro', name: 'Pro' }],
          resolveModel: async () => ({ reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } }),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/model' }))
    await waitFor(() => env.client.sent.length === 1)
    const list = env.client.sent[0].text
    assert.match(list, /1\. deepseek-account\/deepseek-flash（Flash） ←当前/)
    assert.match(list, /2\. deepseek-account\/deepseek-pro（Pro）/)

    await env.bridge.handleInbound(inboundMessage({ text: '/model 2', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /deepseek-account\/deepseek-pro/)

    // The selection reaches the next agent that is created.
    await env.bridge.handleInbound(inboundMessage({ text: '开始', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].options.model, 'deepseek-pro')
  } finally {
    await env.cleanup()
  }
})

test('/reasoning lists the model efforts and applies the selection', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }),
      },
      services: {
        llm: {
          listProviders: async () => [{ id: 'deepseek-account' }],
          listModels: async () => [],
          resolveModel: async () => ({
            reasoning: {
              efforts: [
                { id: 'low', name: '低' },
                { id: 'high', name: '高' },
                { id: 'max', name: '最高' },
              ],
              defaultEffort: 'high',
            },
          }),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/reasoning' }))
    await waitFor(() => env.client.sent.length === 1)
    const list = env.client.sent[0].text
    assert.match(list, /1\. low（低）/)
    assert.match(list, /3\. max（最高） ←当前/)

    await env.bridge.handleInbound(inboundMessage({ text: '/reasoning 1', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /已记录本会话思考深度：low/)

    await env.bridge.handleInbound(inboundMessage({ text: '开始', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].options.reasoningEffort, 'low')
    assert.equal(env.harness.agents[0].options.model, 'deepseek-flash')
  } finally {
    await env.cleanup()
  }
})

test('/settings summarizes the per-conversation configuration', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { list: () => [{ path: '/tmp/ws' }] } },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/设置' }))
    await waitFor(() => env.client.sent.length === 1)
    const text = env.client.sent[0].text
    assert.match(text, /当前会话设置/)
    assert.match(text, /工作区：\/tmp\/ws/)
    assert.match(text, /模型：deepseek-account\/deepseek-flash/)
  } finally {
    await env.cleanup()
  }
})

test('/help documents every list command and its short form', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/帮助' }))
    await waitFor(() => env.client.sent.length === 1)
    const text = env.client.sent[0].text
    for (const command of ['/workspace', '/model', '/reasoning', '/settings', '/new', '/stop']) {
      assert.ok(text.includes(command), `/help must mention ${command}`)
    }
    assert.match(text, /\/workspace 2/)
  } finally {
    await env.cleanup()
  }
})

test('a session archived in the GUI is replaced instead of blocking forever', async () => {
  const archived = ['session-mine']
  const env = await setup({
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { archivedSessionIds: archived, list: () => [] } },
    },
  })
  try {
    await env.store.setSession('p2p:user@im.wechat', 'session-mine')

    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1, { label: 'fresh session created' })

    // The archived binding is dropped, a new session takes over, and the user is told.
    assert.equal(env.harness.agents[0].session.id !== 'session-mine', true)
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), env.harness.agents[0].session.id)
    assert.ok(env.client.sent.some((entry) => /已在 DSH 里被归档/.test(entry.text)))
    // The prompt still runs in the new session.
    assert.equal(env.harness.agents[0].followups.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('a blocked turn reports the archive and frees the binding', async () => {
  const archived = []
  const env = await setup({
    harness: {
      // The archive lands while the turn is running: that is the race the
      // blocked notice exists for, so the stub archives before closing the turn.
      respond: ({ emit, agent }) => {
        archived.push(agent.session.id)
        emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { archivedSessionIds: archived, list: () => [] } },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.client.sent.length > 0, { label: 'blocked notice' })
    const notice = env.client.sent.map((entry) => entry.text).find((text) => /回合被拦截/.test(text))
    assert.ok(notice, 'the user must be told why nothing happened')
    assert.match(notice, /被归档/)
    await waitFor(() => env.store.sessionFor('p2p:user@im.wechat') === undefined, { label: 'binding released' })
  } finally {
    await env.cleanup()
  }
})

test('a blocked turn without archiving points at /new', async () => {
  const env = await setup({
    harness: {
      reason: { kind: 'blocked' },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { archivedSessionIds: [], list: () => [] } },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.client.sent.length > 0)
    const notice = env.client.sent.map((entry) => entry.text).find((text) => /回合被拦截/.test(text))
    assert.match(notice, /pre-step/)
    assert.match(notice, /\/new/)
    assert.equal(env.store.sessionFor('p2p:user@im.wechat') !== undefined, true)
  } finally {
    await env.cleanup()
  }
})

test('a timed-out turn keeps its place so the next answer is not misattributed', async () => {
  const env = await setup({
    config: { turnTimeoutSeconds: 5 },
    harness: {
      // Defer every turn: the test decides when each one ends.
      respond: ({ defer }) => defer(),
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一个问题', id: 1 }))
    await waitFor(() => env.harness.agents.length === 1, { label: 'first turn starts' })
    await env.bridge.handleInbound(inboundMessage({ text: '第二个问题', id: 2 }))
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 2, {
      label: 'both turns queued',
    })

    // The first turn times out: the user is told, and the placeholder must stay
    // in the queue so the agent's turns and the pending records stay aligned.
    await waitFor(() => env.client.sent.some((entry) => /超过 5 秒/.test(entry.text)), {
      timeoutMs: 9_000,
      label: 'timeout notice',
    })
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 2)
    // The queued message keeps a fresh budget: its turn has not started yet, so
    // the first turn's timeout must not time it out as well.
    assert.equal(env.client.sent.filter((entry) => /超过 5 秒/.test(entry.text)).length, 1)

    // Finishing the timed-out turn must not deliver its text…
    env.harness.agents[0].completeDeferredTurn('第一个问题的答案')
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 1, {
      label: 'placeholder consumed',
    })
    assert.equal(env.client.sent.some((entry) => /第一个问题的答案/.test(entry.text)), false)

    // …and the second turn's own answer still reaches the user.
    env.harness.agents[0].completeDeferredTurn('第二个问题的答案')
    await waitFor(() => env.client.sent.some((entry) => /第二个问题的答案/.test(entry.text)), {
      label: 'second answer delivered',
    })
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 0)
  } finally {
    await env.cleanup()
  }
})

test('/stop also discards the queued turns and says how many', async () => {
  const env = await setup({ harness: { respond: ({ defer }) => defer() } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一个', id: 1 }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '第二个', id: 2 }))
    await env.bridge.handleInbound(inboundMessage({ text: '第三个', id: 3 }))
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 3, {
      label: 'three turns queued',
    })

    await env.bridge.handleInbound(inboundMessage({ text: '/stop', id: 4 }))
    await waitFor(() => env.client.sent.some((entry) => /已请求停止当前回合/.test(entry.text)), { label: 'stop reply' })
    const reply = env.client.sent.map((entry) => entry.text).find((text) => /已请求停止当前回合/.test(text))
    assert.match(reply, /丢弃了排队中的 2 条消息/)
    assert.deepEqual(env.harness.agents[0].cancels, [{ kind: 'user' }])
    // The running turn keeps its placeholder; the discarded ones are gone.
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 1)
  } finally {
    await env.cleanup()
  }
})

test('/new drops queued turns without leaving typing timers behind', async () => {
  const env = await setup({ config: { typing: true }, harness: { respond: ({ defer }) => defer() } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一个', id: 1 }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '第二个', id: 2 }))
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 2)

    await env.bridge.handleInbound(inboundMessage({ text: '/new', id: 3 }))
    await waitFor(() => env.client.sent.some((entry) => /已结束上一个会话/.test(entry.text)))
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 0)

    // Every typing indicator that started is eventually cancelled.
    await waitFor(() => env.client.typing.some((entry) => entry.status === 2), { label: 'typing stopped' })
    const started = env.client.typing.filter((entry) => entry.status === 1).length
    const stopped = env.client.typing.filter((entry) => entry.status === 2).length
    assert.ok(stopped >= 1 && started >= 1)
  } finally {
    await env.cleanup()
  }
})

test('group messages and empty message bodies are ignored', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '群里的消息', groupId: 'g1' }))
    await env.bridge.handleInbound(inboundMessage({ text: '没有内容', items: [] }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(env.harness.agents.length, 0)
    assert.equal(env.client.sent.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('a transient send failure is retried once', async () => {
  const env = await setup()
  try {
    const original = env.client.sendText.bind(env.client)
    let attempts = 0
    env.client.sendText = async (payload) => {
      attempts += 1
      if (attempts === 1) throw new Error('socket hang up')
      return original(payload)
    }
    const count = await env.bridge.deliver('p2p:user@im.wechat', '重试也要发出去')
    assert.equal(count, 1)
    assert.equal(attempts, 2)
    assert.equal(env.client.sent.at(-1).text, '重试也要发出去')
  } finally {
    await env.cleanup()
  }
})

test('a persistent send failure is contained, recorded and reported', async () => {
  const env = await setup()
  try {
    env.client.sendText = async () => {
      throw new Error('network down')
    }
    // Delivery no longer throws: one lost chunk must not abort the rest of an
    // answer. The failure is surfaced through /status and a best-effort notice.
    const sent = await env.bridge.deliver('p2p:user@im.wechat', '发不出去')
    assert.equal(sent, 0)
    assert.match(env.store.state.stats.lastError.message, /network down/)
    const info = await env.bridge.describeConversation('p2p:user@im.wechat')
    assert.match(info.stats.lastError.message, /回复发送失败/)
  } finally {
    await env.cleanup()
  }
})

test('a later chunk is still attempted after an earlier one fails', async () => {
  const env = await setup()
  try {
    const original = env.client.sendText.bind(env.client)
    let call = 0
    env.client.sendText = async (payload) => {
      call += 1
      if (call === 1) throw new Error('first chunk lost')
      return original(payload)
    }
    const sent = await env.bridge.deliver('p2p:user@im.wechat', '第一段\n\n第二段', { })
    void sent
    const texts = env.client.sent.map((entry) => entry.text)
    assert.ok(texts.some((text) => /第二段/.test(text)), 'the tail of the answer must still be sent')
  } finally {
    await env.cleanup()
  }
})

test('idle agents are released, and the conversation resumes on the next message', async () => {
  const env = await setup({ config: { idleDisposeMinutes: 0.03, typing: false }, harness: { reply: '回答' } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一句' }))
    await waitFor(() => env.client.sent.length === 1)
    const sessionId = env.harness.agents[0].session.id

    // Too early: the conversation is not idle yet.
    assert.equal(await env.bridge.disposeIdleAgents(), 0)

    // After the quiet period the background sweep releases the agent on its own.
    await waitFor(() => env.harness.disposed.length === 1, { timeoutMs: 8_000, label: 'idle release' })
    assert.deepEqual(env.harness.disposed, [sessionId])
    assert.equal(env.harness.agents.length, 0)
    // A second sweep has nothing left to do.
    assert.equal(await env.bridge.disposeIdleAgents(), 0)
    // The binding survives, so the next message resumes the same session.
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), sessionId)

    await env.bridge.handleInbound(inboundMessage({ text: '第二句', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.equal(env.harness.agents.length, 1)
    assert.equal(env.harness.agents[0].session.id, sessionId)
  } finally {
    await env.cleanup()
  }
})

test('a session with a turn in flight is never treated as idle', async () => {
  const env = await setup({ config: { idleDisposeMinutes: 0.01 }, harness: { respond: ({ defer }) => defer() } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '慢慢跑' }))
    await waitFor(() => env.harness.agents.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    // The turn never ended, so the agent must stay alive.
    assert.equal(await env.bridge.disposeIdleAgents(), 0)
    assert.equal(env.harness.disposed.length, 0)
  } finally {
    await env.cleanup()
  }
})

/** A sessionQuery corpus shaped like the one the GUI lists from. */
function fakeSessionQuery(records) {
  // `sessionQuery` hands back *title snapshots*, not strings — a fixture that used
  // bare strings let `[object Object]` reach the chat, so the shape is mirrored here.
  const snapshot = (title) => ({ title, messageSeqs: [1], source: { kind: 'provider' }, eventSeq: 7, updatedAt: 1 })
  return {
    listSessions: async () => records,
    readTitleSnapshots: async (ids) =>
      ids.map((id) => {
        const found = records.find((record) => record.header.id === id)
        return found?.title
          ? { status: 'fulfilled', value: { session: { id }, title: snapshot(found.title) } }
          : { status: 'rejected', reason: new Error('no title') }
      }),
    readTitle: async (id) => {
      const found = records.find((record) => record.header.id === id)
      return found?.title ? snapshot(found.title) : undefined
    },
  }
}

test('/session lists titles, then asks how many segments to echo back', async () => {
  const env = await setup({
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp', title: 'scratch' }] },
        sessionQuery: fakeSessionQuery([
          { header: { id: 'session-alpha', cwd: '/tmp', createdAt: 3_000 }, title: '整理测试' },
          { header: { id: 'session-beta', cwd: '/tmp', createdAt: 2_000 }, title: '重构桥接' },
          { header: { id: 'session-other', cwd: '/elsewhere', createdAt: 9_000 }, title: '别的项目' },
        ]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '当前对话' }))
    await waitFor(() => env.harness.agents.length === 1)
    const created = env.harness.agents[0].session.id

    await env.bridge.handleInbound(inboundMessage({ text: '/session', id: 2 }))
    await waitFor(() => env.client.sent.length >= 2)
    const list = env.client.sent.map((entry) => entry.text).find((text) => /下的对话/.test(text))
    assert.match(list, /1\..*←当前/)
    assert.match(list, /2\. 整理测试/)
    assert.match(list, /3\. 重构桥接/)
    assert.ok(!list.includes('别的项目'))

    await env.bridge.handleInbound(inboundMessage({ text: '/session 2', id: 3 }))
    await waitFor(() => env.client.sent.some((entry) => /已切换到对话/.test(entry.text)))
    const selected = env.client.sent.map((entry) => entry.text).find((text) => /已切换到对话/.test(text))
    // The conversation is bound right away — it is still that conversation.
    assert.match(selected, /已切换到对话：整理测试/)
    assert.ok(!/已切换到对话：session-alpha/.test(selected), 'the label must be the title, not the id')
    assert.match(selected, /0-99/)
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), 'session-alpha')
    assert.equal(env.store.pendingSwitchFor('p2p:user@im.wechat')?.sessionId, 'session-alpha')
    // The old agent is released so the next message opens the new conversation.
    assert.deepEqual(env.harness.disposed, [created])

    // The next message resumes that very session (history intact).
    await env.bridge.handleInbound(inboundMessage({ text: '继续之前的话题', id: 4 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].session.id, 'session-alpha')
    assert.equal(env.store.pendingSwitchFor('p2p:user@im.wechat'), null, 'a plain message closes the question')
  } finally {
    await env.cleanup()
  }
})

test('answering 0 only acknowledges: the conversation is untouched', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: fakeSessionQuery([{ header: { id: 'session-alpha', cwd: '/tmp', createdAt: 3_000 }, title: '整理测试' }]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-alpha' }))
    await waitFor(() => env.store.pendingSwitchFor('p2p:user@im.wechat') !== null)
    const before = env.client.sent.length
    await env.bridge.handleInbound(inboundMessage({ text: '0', id: 2 }))
    await waitFor(() => env.client.sent.length > before)
    const reply = env.client.sent.at(-1).text
    assert.match(reply, /不发回执/)
    assert.equal(env.client.sent.length, before + 1, '0 must not produce a recap')
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), 'session-alpha', 'the binding is unchanged')
    assert.equal(env.store.pendingSwitchFor('p2p:user@im.wechat'), null)
  } finally {
    await env.cleanup()
  }
})

test('answering N echoes the last N exchanges back to WeChat', async () => {
  const events = []
  for (let index = 1; index <= 4; index += 1) {
    events.push({ type: 'user/message', data: { message: { content: `旧问题${index}` } } })
    events.push({ type: 'assistant/message', data: { message: { content: `旧回答${index}` } } })
  }
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: {
          listSessions: async () => [{ header: { id: 'session-history', cwd: '/tmp', createdAt: 1 } }],
          readTitleSnapshots: async () => [{ status: 'fulfilled', value: { title: { title: '重构桥接' } } }],
          readTitle: async () => ({ title: '重构桥接' }),
          readSession: async () => ({ events }),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-history' }))
    await waitFor(() => env.store.pendingSwitchFor('p2p:user@im.wechat') !== null)
    const before = env.client.sent.length
    await env.bridge.handleInbound(inboundMessage({ text: '2', id: 2 }))
    await waitFor(() => env.client.sent.length >= before + 2)
    const recap = env.client.sent.find((entry) => /段回执/.test(entry.text))
    assert.ok(recap, 'the recap must be delivered to the chat')
    assert.match(recap.text, /重构桥接/)
    assert.match(recap.text, /用户：旧问题3/)
    assert.match(recap.text, /助手：旧回答3/)
    assert.match(recap.text, /用户：旧问题4/)
    assert.ok(!recap.text.includes('旧问题1'), 'older exchanges stay out')
    // The session is still the target one, and no background is injected into the model.
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), 'session-history')
    await env.bridge.handleInbound(inboundMessage({ text: '接着刚才说', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].session.id, 'session-history')
    assert.match(env.harness.agents[0].prompts[0], /^接着刚才说$/, 'the model sees only the user message')
  } finally {
    await env.cleanup()
  }
})

test('a message without a number answers "no recap"', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: fakeSessionQuery([{ header: { id: 'session-target', cwd: '/tmp', createdAt: 1 }, title: '目标对话' }]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-target' }))
    await waitFor(() => env.store.pendingSwitchFor('p2p:user@im.wechat') !== null)
    await env.bridge.handleInbound(inboundMessage({ text: '直接开干', id: 2 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.store.pendingSwitchFor('p2p:user@im.wechat'), null, 'the question is cleared by the message')
    assert.equal(env.harness.agents[0].session.id, 'session-target', 'the message continues the selected conversation')
    assert.match(env.harness.agents[0].prompts[0], /^直接开干$/)
  } finally {
    await env.cleanup()
  }
})

test('/session refuses a conversation that was archived in the GUI', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }], archivedSessionIds: ['session-archived'] },
        sessionQuery: fakeSessionQuery([{ header: { id: 'session-archived', cwd: '/tmp', createdAt: 1 } }]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-archived' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.match(env.client.sent[0].text, /被归档/)
    assert.equal(env.store.pendingSwitchFor('p2p:user@im.wechat'), null)
  } finally {
    await env.cleanup()
  }
})

test('/session new clears a pending switch', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: fakeSessionQuery([{ header: { id: 'session-old', cwd: '/tmp', createdAt: 1 }, title: '旧对话' }]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-old' }))
    await waitFor(() => env.store.pendingSwitchFor('p2p:user@im.wechat') !== null)
    await env.bridge.handleInbound(inboundMessage({ text: '/session new', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /开启新对话|没有进行中的对话/.test(entry.text)))
    assert.equal(env.store.pendingSwitchFor('p2p:user@im.wechat'), null)
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), undefined)
  } finally {
    await env.cleanup()
  }
})

test('/model lists the llm catalog and selects by number', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: {
        llm: {
          listProviders: async () => [{ id: 'deepseek-account' }],
          listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-pro', name: 'Pro' }],
          resolveModel: async () => ({ reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } }),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/model' }))
    await waitFor(() => env.client.sent.length === 1)
    const list = env.client.sent[0].text
    assert.match(list, /1\. deepseek-account\/deepseek-flash（Flash） ←当前/)
    assert.match(list, /2\. deepseek-account\/deepseek-pro（Pro）/)

    await env.bridge.handleInbound(inboundMessage({ text: '/model 2', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /deepseek-account\/deepseek-pro/)

    // The selection reaches the next agent that is created.
    await env.bridge.handleInbound(inboundMessage({ text: '开始', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].options.model, 'deepseek-pro')
  } finally {
    await env.cleanup()
  }
})

test('/reasoning lists the model efforts and applies the selection', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }),
      },
      services: {
        llm: {
          listProviders: async () => [{ id: 'deepseek-account' }],
          listModels: async () => [],
          resolveModel: async () => ({
            reasoning: {
              efforts: [
                { id: 'low', name: '低' },
                { id: 'high', name: '高' },
                { id: 'max', name: '最高' },
              ],
              defaultEffort: 'high',
            },
          }),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/reasoning' }))
    await waitFor(() => env.client.sent.length === 1)
    const list = env.client.sent[0].text
    assert.match(list, /1\. low（低）/)
    assert.match(list, /3\. max（最高） ←当前/)

    await env.bridge.handleInbound(inboundMessage({ text: '/reasoning 1', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /已记录本会话思考深度：low/)

    await env.bridge.handleInbound(inboundMessage({ text: '开始', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].options.reasoningEffort, 'low')
    assert.equal(env.harness.agents[0].options.model, 'deepseek-flash')
  } finally {
    await env.cleanup()
  }
})

test('/settings summarizes the per-conversation configuration', async () => {
  const env = await setup({
    welcome: true,
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { list: () => [{ path: '/tmp/ws' }] } },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/设置' }))
    await waitFor(() => env.client.sent.length === 1)
    const text = env.client.sent[0].text
    assert.match(text, /当前会话设置/)
    assert.match(text, /工作区：\/tmp\/ws/)
    assert.match(text, /模型：deepseek-account\/deepseek-flash/)
  } finally {
    await env.cleanup()
  }
})

test('/help documents every list command and its short form', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/帮助' }))
    await waitFor(() => env.client.sent.length === 1)
    const text = env.client.sent[0].text
    for (const command of ['/workspace', '/model', '/reasoning', '/settings', '/new', '/stop']) {
      assert.ok(text.includes(command), `/help must mention ${command}`)
    }
    assert.match(text, /\/workspace 2/)
  } finally {
    await env.cleanup()
  }
})

test('a session archived in the GUI is replaced instead of blocking forever', async () => {
  const archived = ['session-mine']
  const env = await setup({
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { archivedSessionIds: archived, list: () => [] } },
    },
  })
  try {
    await env.store.setSession('p2p:user@im.wechat', 'session-mine')

    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1, { label: 'fresh session created' })

    // The archived binding is dropped, a new session takes over, and the user is told.
    assert.equal(env.harness.agents[0].session.id !== 'session-mine', true)
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), env.harness.agents[0].session.id)
    assert.ok(env.client.sent.some((entry) => /已在 DSH 里被归档/.test(entry.text)))
    // The prompt still runs in the new session.
    assert.equal(env.harness.agents[0].followups.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('a blocked turn reports the archive and frees the binding', async () => {
  const archived = []
  const env = await setup({
    harness: {
      // The archive lands while the turn is running: that is the race the
      // blocked notice exists for, so the stub archives before closing the turn.
      respond: ({ emit, agent }) => {
        archived.push(agent.session.id)
        emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { archivedSessionIds: archived, list: () => [] } },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.client.sent.length > 0, { label: 'blocked notice' })
    const notice = env.client.sent.map((entry) => entry.text).find((text) => /回合被拦截/.test(text))
    assert.ok(notice, 'the user must be told why nothing happened')
    assert.match(notice, /被归档/)
    await waitFor(() => env.store.sessionFor('p2p:user@im.wechat') === undefined, { label: 'binding released' })
  } finally {
    await env.cleanup()
  }
})

test('a blocked turn without archiving points at /new', async () => {
  const env = await setup({
    harness: {
      reason: { kind: 'blocked' },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: { workspaceRegistry: { archivedSessionIds: [], list: () => [] } },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.client.sent.length > 0)
    const notice = env.client.sent.map((entry) => entry.text).find((text) => /回合被拦截/.test(text))
    assert.match(notice, /pre-step/)
    assert.match(notice, /\/new/)
    assert.equal(env.store.sessionFor('p2p:user@im.wechat') !== undefined, true)
  } finally {
    await env.cleanup()
  }
})

test('a timed-out turn keeps its place so the next answer is not misattributed', async () => {
  const env = await setup({
    config: { turnTimeoutSeconds: 5 },
    harness: {
      // Defer every turn: the test decides when each one ends.
      respond: ({ defer }) => defer(),
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一个问题', id: 1 }))
    await waitFor(() => env.harness.agents.length === 1, { label: 'first turn starts' })
    await env.bridge.handleInbound(inboundMessage({ text: '第二个问题', id: 2 }))
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 2, {
      label: 'both turns queued',
    })

    // The first turn times out: the user is told, and the placeholder must stay
    // in the queue so the agent's turns and the pending records stay aligned.
    await waitFor(() => env.client.sent.some((entry) => /超过 5 秒/.test(entry.text)), {
      timeoutMs: 9_000,
      label: 'timeout notice',
    })
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 2)
    // The queued message keeps a fresh budget: its turn has not started yet, so
    // the first turn's timeout must not time it out as well.
    assert.equal(env.client.sent.filter((entry) => /超过 5 秒/.test(entry.text)).length, 1)

    // Finishing the timed-out turn must not deliver its text…
    env.harness.agents[0].completeDeferredTurn('第一个问题的答案')
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 1, {
      label: 'placeholder consumed',
    })
    assert.equal(env.client.sent.some((entry) => /第一个问题的答案/.test(entry.text)), false)

    // …and the second turn's own answer still reaches the user.
    env.harness.agents[0].completeDeferredTurn('第二个问题的答案')
    await waitFor(() => env.client.sent.some((entry) => /第二个问题的答案/.test(entry.text)), {
      label: 'second answer delivered',
    })
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 0)
  } finally {
    await env.cleanup()
  }
})

test('/stop also discards the queued turns and says how many', async () => {
  const env = await setup({ harness: { respond: ({ defer }) => defer() } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一个', id: 1 }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '第二个', id: 2 }))
    await env.bridge.handleInbound(inboundMessage({ text: '第三个', id: 3 }))
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 3, {
      label: 'three turns queued',
    })

    await env.bridge.handleInbound(inboundMessage({ text: '/stop', id: 4 }))
    await waitFor(() => env.client.sent.some((entry) => /已请求停止当前回合/.test(entry.text)), { label: 'stop reply' })
    const reply = env.client.sent.map((entry) => entry.text).find((text) => /已请求停止当前回合/.test(text))
    assert.match(reply, /丢弃了排队中的 2 条消息/)
    assert.deepEqual(env.harness.agents[0].cancels, [{ kind: 'user' }])
    // The running turn keeps its placeholder; the discarded ones are gone.
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 1)
  } finally {
    await env.cleanup()
  }
})

test('/new drops queued turns without leaving typing timers behind', async () => {
  const env = await setup({ config: { typing: true }, harness: { respond: ({ defer }) => defer() } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一个', id: 1 }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '第二个', id: 2 }))
    await waitFor(async () => (await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns === 2)

    await env.bridge.handleInbound(inboundMessage({ text: '/new', id: 3 }))
    await waitFor(() => env.client.sent.some((entry) => /已结束上一个会话/.test(entry.text)))
    assert.equal((await env.bridge.describeConversation('p2p:user@im.wechat')).runningTurns, 0)

    // Every typing indicator that started is eventually cancelled.
    await waitFor(() => env.client.typing.some((entry) => entry.status === 2), { label: 'typing stopped' })
    const started = env.client.typing.filter((entry) => entry.status === 1).length
    const stopped = env.client.typing.filter((entry) => entry.status === 2).length
    assert.ok(stopped >= 1 && started >= 1)
  } finally {
    await env.cleanup()
  }
})

test('group messages and empty message bodies are ignored', async () => {
  const env = await setup()
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '群里的消息', groupId: 'g1' }))
    await env.bridge.handleInbound(inboundMessage({ text: '没有内容', items: [] }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(env.harness.agents.length, 0)
    assert.equal(env.client.sent.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('a transient send failure is retried once', async () => {
  const env = await setup()
  try {
    const original = env.client.sendText.bind(env.client)
    let attempts = 0
    env.client.sendText = async (payload) => {
      attempts += 1
      if (attempts === 1) throw new Error('socket hang up')
      return original(payload)
    }
    const count = await env.bridge.deliver('p2p:user@im.wechat', '重试也要发出去')
    assert.equal(count, 1)
    assert.equal(attempts, 2)
    assert.equal(env.client.sent.at(-1).text, '重试也要发出去')
  } finally {
    await env.cleanup()
  }
})

test('a persistent send failure is contained, recorded and reported', async () => {
  const env = await setup()
  try {
    env.client.sendText = async () => {
      throw new Error('network down')
    }
    // Delivery no longer throws: one lost chunk must not abort the rest of an
    // answer. The failure is surfaced through /status and a best-effort notice.
    const sent = await env.bridge.deliver('p2p:user@im.wechat', '发不出去')
    assert.equal(sent, 0)
    assert.match(env.store.state.stats.lastError.message, /network down/)
    const info = await env.bridge.describeConversation('p2p:user@im.wechat')
    assert.match(info.stats.lastError.message, /回复发送失败/)
  } finally {
    await env.cleanup()
  }
})

test('a later chunk is still attempted after an earlier one fails', async () => {
  const env = await setup()
  try {
    const original = env.client.sendText.bind(env.client)
    let call = 0
    env.client.sendText = async (payload) => {
      call += 1
      if (call === 1) throw new Error('first chunk lost')
      return original(payload)
    }
    const sent = await env.bridge.deliver('p2p:user@im.wechat', '第一段\n\n第二段', { })
    void sent
    const texts = env.client.sent.map((entry) => entry.text)
    assert.ok(texts.some((text) => /第二段/.test(text)), 'the tail of the answer must still be sent')
  } finally {
    await env.cleanup()
  }
})

test('idle agents are released, and the conversation resumes on the next message', async () => {
  const env = await setup({ config: { idleDisposeMinutes: 0.03, typing: false }, harness: { reply: '回答' } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '第一句' }))
    await waitFor(() => env.client.sent.length === 1)
    const sessionId = env.harness.agents[0].session.id

    // Too early: the conversation is not idle yet.
    assert.equal(await env.bridge.disposeIdleAgents(), 0)

    // After the quiet period the background sweep releases the agent on its own.
    await waitFor(() => env.harness.disposed.length === 1, { timeoutMs: 8_000, label: 'idle release' })
    assert.deepEqual(env.harness.disposed, [sessionId])
    assert.equal(env.harness.agents.length, 0)
    // A second sweep has nothing left to do.
    assert.equal(await env.bridge.disposeIdleAgents(), 0)
    // The binding survives, so the next message resumes the same session.
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), sessionId)

    await env.bridge.handleInbound(inboundMessage({ text: '第二句', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.equal(env.harness.agents.length, 1)
    assert.equal(env.harness.agents[0].session.id, sessionId)
  } finally {
    await env.cleanup()
  }
})

test('a session with a turn in flight is never treated as idle', async () => {
  const env = await setup({ config: { idleDisposeMinutes: 0.01 }, harness: { respond: ({ defer }) => defer() } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '慢慢跑' }))
    await waitFor(() => env.harness.agents.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    // The turn never ended, so the agent must stay alive.
    assert.equal(await env.bridge.disposeIdleAgents(), 0)
    assert.equal(env.harness.disposed.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('a new session mounts the deployment agent preset, which is what carries the tools', async () => {
  const mounted = []
  const env = await setup({
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: {
        agentPresets: {
          resolve: async (id) => ({ id: id ?? 'standard' }),
          mount: async (agentCtx, id) => {
            mounted.push({ agentCtx, id })
            return { id }
          },
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(mounted.length, 1, 'the preset must be mounted during setup')
    assert.equal(mounted[0].id, 'standard')
    assert.equal(env.harness.agents[0].setupRan, true)
    // The header records it too, so the GUI shows the session's preset.
    assert.equal(env.harness.agents[0].session.header.agentPreset, 'standard')
  } finally {
    await env.cleanup()
  }
})

test('an explicit configured preset wins over the deployment default', async () => {
  const resolvedWith = []
  const env = await setup({
    config: { agentPreset: 'minimal' },
    harness: {
      services: {
        agentPresets: {
          resolve: async (id) => {
            resolvedWith.push(id)
            return { id: id ?? 'standard' }
          },
          mount: async () => ({ id: 'minimal' }),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.deepEqual(resolvedWith, ['minimal'])
    assert.equal(env.harness.agents[0].session.header.agentPreset, 'minimal')
  } finally {
    await env.cleanup()
  }
})

test('a resumed conversation is mounted with the preset too', async () => {
  const mounted = []
  const env = await setup({
    harness: {
      services: {
        agentPresets: {
          resolve: async () => ({ id: 'standard' }),
          mount: async (agentCtx, id) => {
            mounted.push(id)
            return { id }
          },
        },
      },
    },
  })
  try {
    await env.store.setSession('p2p:user@im.wechat', 'session-existing')
    await env.bridge.handleInbound(inboundMessage({ text: '继续' }))
    await waitFor(() => env.harness.agents.length === 1)
    assert.equal(env.harness.agents[0].session.id, 'session-existing')
    assert.deepEqual(mounted, ['standard'], 'resume must restore the tool-carrying preset')
  } finally {
    await env.cleanup()
  }
})

test('a profile without agentPresets degrades with a warning instead of failing', async () => {
  const env = await setup({ harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } } })
  try {
    // No agentPresets service at all.
    assert.equal(await env.bridge.resolveAgentPreset(), null)
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.client.sent.length > 0)
    assert.equal(env.harness.agents.length, 1)
    assert.equal(env.harness.agents[0].session.header.agentPreset, undefined)
  } finally {
    await env.cleanup()
  }
})

test('/status reports the preset a session runs', async () => {
  const env = await setup({
    harness: {
      services: {
        agentPresets: {
          resolve: async () => ({ id: 'standard' }),
          mount: async () => ({ id: 'standard' }),
          composedPreset: () => 'standard',
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '/status', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /状态：/.test(entry.text)))
    const status = env.client.sent.map((entry) => entry.text).find((text) => /状态：/.test(text))
    assert.match(status, /预设：standard/)
  } finally {
    await env.cleanup()
  }
})

test('/session hides child sessions and archived conversations, like the GUI list', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: {
          list: () => [{ path: '/tmp' }],
          archivedSessionIds: ['session-archived'],
        },
        sessionQuery: {
          listSessions: async () => [
            { header: { id: 'session-main', cwd: '/tmp', createdAt: 5_000 } },
            { header: { id: 'session-child', cwd: '/tmp', createdAt: 6_000, parentSession: 'session-main' } },
            { header: { id: 'session-archived', cwd: '/tmp', createdAt: 4_000 } },
          ],
          readTitleSnapshots: async (ids) => ids.map(() => ({ status: 'rejected', reason: new Error('no title') })),
          readTitle: async (id) => (id === 'session-main' ? '打开 finder 问题' : undefined),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session' }))
    await waitFor(() => env.client.sent.length === 1)
    const list = env.client.sent[0].text
    assert.match(list, /打开 finder 问题/, 'the GUI title must be shown')
    assert.ok(!list.includes('session-child'), 'subagent sessions must stay hidden')
    assert.ok(!list.includes('已归档对话\n'), 'archived conversations must not be offered')
    assert.match(list, /已隐藏 1 个子会话/)
    assert.match(list, /已隐藏 1 个已归档对话/)
  } finally {
    await env.cleanup()
  }
})

test('/session sources reports where each name came from', async () => {
  let single = 0
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }], archivedSessionIds: [] },
        sessionQuery: {
          listSessions: async () => [{ header: { id: 'session-one', cwd: '/tmp', createdAt: 1 } }],
          readTitleSnapshots: async () => {
            throw new Error('index closed')
          },
          readTitle: async () => {
            single += 1
            return '中文标题'
          },
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session sources' }))
    await waitFor(() => env.client.sent.length === 1)
    const report = env.client.sent[0].text
    assert.match(report, /标题批量折叠：failed: index closed/)
    assert.match(report, /标题单条回退：1\/1/)
    assert.match(report, /拿到标题：1/)
    assert.equal(single, 1)

    // …and the listing itself recovered the name through the fallback.
    await env.bridge.handleInbound(inboundMessage({ text: '/session', id: 2 }))
    await waitFor(() => env.client.sent.length === 2)
    assert.match(env.client.sent[1].text, /中文标题/)
  } finally {
    await env.cleanup()
  }
})

test('a title snapshot is rendered as text, never as [object Object]', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: fakeSessionQuery([
          {
            header: { id: 'session-titled', cwd: '/tmp', createdAt: 1_000 },
            title: 'Deepseek-harness 修改文件打开 finder 问题',
          },
        ]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session' }))
    await waitFor(() => env.client.sent.length === 1)
    const list = env.client.sent[0].text
    assert.ok(!list.includes('[object Object]'), 'a snapshot must never be interpolated raw')
    assert.match(list, /Deepseek-harness 修改文件打开 finder 问题/)
  } finally {
    await env.cleanup()
  }
})

test('the live title service returns snapshots too', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        // No query service at all: the title must come from `sessionTitle.get`.
        sessionTitle: { get: () => ({ title: '运行中对话的名字', source: { kind: 'user' } }) },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '/session', id: 2 }))
    await waitFor(() => env.client.sent.length >= 2)
    const list = env.client.sent.map((entry) => entry.text).find((text) => /下的对话/.test(text))
    assert.match(list, /运行中对话的名字/)
    assert.ok(!list.includes('[object Object]'))
  } finally {
    await env.cleanup()
  }
})

test('the recap and the depth answer never enter the DSH conversation', async () => {
  const events = [
    { type: 'user/message', data: { message: { content: '旧问题一' } } },
    { type: 'assistant/message', data: { message: { content: '旧回答一' } } },
    { type: 'user/message', data: { message: { content: '旧问题二' } } },
    { type: 'assistant/message', data: { message: { content: '旧回答二' } } },
  ]
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: {
          listSessions: async () => [{ header: { id: 'session-quiet', cwd: '/tmp', createdAt: 1 } }],
          readTitleSnapshots: async () => [{ status: 'fulfilled', value: { title: { title: '安静对话' } } }],
          readTitle: async () => ({ title: '安静对话' }),
          readSession: async () => ({ events }),
        },
      },
    },
  })
  try {
    // 1) Selecting the conversation opens no agent by itself.
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-quiet' }))
    await waitFor(() => env.store.pendingSwitchFor('p2p:user@im.wechat') !== null)
    assert.equal(env.harness.agents.length, 0, 'selecting a conversation must not open a session')

    // 2) The depth answer is consumed by the plugin: no turn, no session, recap outbound only.
    const before = env.client.sent.length
    await env.bridge.handleInbound(inboundMessage({ text: '2', id: 2 }))
    await waitFor(() => env.client.sent.length >= before + 2)
    assert.equal(env.harness.agents.length, 0, 'answering the depth must not open a session either')
    assert.equal(env.harness.agents.flatMap((agent) => agent.followups).length, 0, 'nothing may be sent to an agent yet')
    assert.ok(
      env.client.sent.some((entry) => /旧问题二/.test(entry.text)),
      'the recap still reaches WeChat',
    )

    // 3) The next real message carries only what the user typed — no recap preamble.
    await env.bridge.handleInbound(inboundMessage({ text: '只发这句话', id: 3 }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]
    assert.equal(agent.session.id, 'session-quiet', 'the message continues the selected conversation')
    assert.equal(agent.prompts.length, 1)
    assert.equal(agent.prompts[0], '只发这句话', 'the model must see the user text and nothing else')
    assert.ok(!agent.prompts[0].includes('旧回答'), 'the recap must not leak into the model context')
  } finally {
    await env.cleanup()
  }
})

test('the depth answer is accepted with and without a slash', async () => {
  const events = [
    { type: 'user/message', data: { message: { content: '旧问题' } } },
    { type: 'assistant/message', data: { message: { content: '旧回答' } } },
  ]
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: {
          listSessions: async () => [{ header: { id: 'session-slash', cwd: '/tmp', createdAt: 1 } }],
          readTitleSnapshots: async () => [{ status: 'fulfilled', value: { title: { title: '斜杠对话' } } }],
          readTitle: async () => ({ title: '斜杠对话' }),
          readSession: async () => ({ events }),
        },
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-slash' }))
    await waitFor(() => env.store.pendingSwitchFor('p2p:user@im.wechat') !== null)
    await env.bridge.handleInbound(inboundMessage({ text: '/1', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /段回执/.test(entry.text)))
    assert.equal(env.store.pendingSwitchFor('p2p:user@im.wechat'), null, '/1 answers the question')
    assert.equal(env.harness.agents.length, 0, '/1 must not become a turn')
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), 'session-slash')
  } finally {
    await env.cleanup()
  }
})

test('a conversation already bound to another WeChat chat cannot be taken over', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: fakeSessionQuery([{ header: { id: 'session-shared', cwd: '/tmp', createdAt: 1 }, title: '独占对话' }]),
      },
    },
  })
  try {
    // Another WeChat contact holds the conversation.
    await env.store.setSession('p2p:someone-else@im.wechat', 'session-shared')
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-shared' }))
    await waitFor(() => env.client.sent.length === 1)
    assert.match(env.client.sent[0].text, /正绑定在微信会话/)
    assert.match(env.client.sent[0].text, /联系人…wechat/)
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), undefined, 'the takeover must be refused')

    // Once the holder releases it, the conversation is free again.
    await env.store.setSession('p2p:someone-else@im.wechat', null)
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-shared', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /已切换到对话/.test(entry.text)))
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), 'session-shared')
  } finally {
    await env.cleanup()
  }
})

test('one WeChat chat holds exactly one session at a time', async () => {
  const env = await setup({
    harness: {
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: fakeSessionQuery([
          { header: { id: 'session-one', cwd: '/tmp', createdAt: 2 }, title: '对话一' },
          { header: { id: 'session-two', cwd: '/tmp', createdAt: 1 }, title: '对话二' },
        ]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-one' }))
    await waitFor(() => env.store.sessionFor('p2p:user@im.wechat') === 'session-one')
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-two', id: 2 }))
    await waitFor(() => env.store.sessionFor('p2p:user@im.wechat') === 'session-two')
    // The old binding is gone: only one session per chat.
    const bindings = Object.entries(env.store.state.sessions).filter(([, value]) => value === 'session-one')
    assert.deepEqual(bindings, [], 'the previous session must be released')
    assert.equal(env.bridge.conversationForSession('session-one'), undefined)
    assert.equal(env.bridge.conversationForSession('session-two'), 'p2p:user@im.wechat')
  } finally {
    await env.cleanup()
  }
})

test('a turn started outside WeChat is never answered into the chat', async () => {
  const env = await setup({
    harness: {
      reply: '这是微信回合的答案',
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      services: {
        workspaceRegistry: { list: () => [{ path: '/tmp' }] },
        sessionQuery: fakeSessionQuery([{ header: { id: 'session-gui', cwd: '/tmp', createdAt: 1 }, title: 'GUI 对话' }]),
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '/session session-gui' }))
    await waitFor(() => env.store.sessionFor('p2p:user@im.wechat') === 'session-gui')
    const before = env.client.sent.length

    // The GUI (or another client) runs a turn in that very session.
    const session = { id: 'session-gui', header: { id: 'session-gui', cwd: '/tmp' } }
    env.bridge.onSessionEvent(session, { type: 'turn/start', data: { turn: 7 } })
    env.bridge.onSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 7, message: { content: '这是 GUI 里跑出来的答案' } },
    })
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'done' } } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(env.client.sent.length, before, 'a GUI turn must not be pushed to WeChat')

    // A WeChat message in the same session is still answered normally.
    await env.bridge.handleInbound(inboundMessage({ text: '微信问的', id: 2 }))
    await waitFor(() => env.client.sent.length > before)
    assert.ok(
      env.client.sent.some((entry) => /这是微信回合的答案/.test(entry.text)),
      'a WeChat turn must still be answered',
    )
    assert.ok(
      !env.client.sent.some((entry) => /GUI 里跑出来的答案/.test(entry.text)),
      'the GUI turn must never reach WeChat',
    )
  } finally {
    await env.cleanup()
  }
})

test('tools keep running when the progress notifications are switched off', async () => {
  // `showToolProgress: false` gates exactly one thing: whether a `tool/call` event is
  // echoed to WeChat. The tools themselves come from the mounted agent preset.
  const calls = []
  const env = await setup({
    config: { showToolProgress: false },
    harness: {
      reply: '已经跑完了',
      respond: ({ agent, emit, defer }) => {
        defer()
        const session = agent.session
        emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
        emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } })
        calls.push('bash')
        emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"/tmp/a"}' } })
        calls.push('read')
        emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 3 } })
        for (const piece of ['已经', '跑完了']) {
          emit('agent/assistant-stream', {
            agent,
            frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: piece } },
          })
        }
        emit('agent/assistant-stream', {
          agent,
          frame: { type: 'end', attemptId: 'a1', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
        })
        emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '跑一下测试' }))
    await waitFor(() => env.client.sent.some((entry) => /已经跑完了/.test(entry.text)))
    // The tools ran…
    assert.deepEqual(calls, ['bash', 'read'])
    // …but nothing about them was pushed to the chat.
    assert.equal(env.client.sent.length, 1, `expected only the answer, got ${JSON.stringify(env.client.sent.map((e) => e.text))}`)
    assert.ok(!env.client.sent.some((entry) => entry.text.includes('🔧')))
    // And the answer itself is intact.
    assert.equal(env.client.sent[0].text, '已经跑完了')
  } finally {
    await env.cleanup()
  }
})

test('an approval raised by a delegated sub-agent is answerable from WeChat', async () => {
  const env = await setup({
    config: { approvalTimeoutSeconds: 30 },
    // Hold the turn open: approvals and questions happen *inside* a running turn, and
    // the interaction router only claims what the WeChat turn started.
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.harness.agents.length === 1)
    const rootId = env.harness.agents[0].session.id

    // The sub-agent runs in its own session whose parent is the bound conversation.
    const childId = 'session-child-approval'
    env.harness.sessions.set(childId, { id: childId, header: { id: childId, cwd: '/tmp', parentSession: rootId } })
    const childAgent = { id: childId, session: { id: childId, header: { id: childId, cwd: '/tmp', parentSession: rootId } } }

    // The mapping walks up to the chat that owns the tree.
    assert.equal(env.bridge.conversationForSession(childId), 'p2p:user@im.wechat')

    const pending = env.interactions.handleApproval(
      { agent: childAgent, toolName: 'bash', signal: new AbortController().signal },
      async () => 'delegated',
    )
    await waitFor(() => env.interactions.isWaiting('p2p:user@im.wechat'))
    // The prompt reaches WeChat…
    await waitFor(() => env.client.sent.some((entry) => /需要你确认/.test(entry.text)))
    // …and the WeChat reply answers it instead of becoming a new turn.
    assert.equal(env.interactions.tryConsume('p2p:user@im.wechat', '允许'), true)
    assert.equal(await pending, 'allowed-once')
  } finally {
    await env.cleanup()
  }
})

test('an unrecognised reply while an approval is pending gets one reminder', async () => {
  const env = await setup({
    config: { approvalTimeoutSeconds: 30 },
    // Hold the turn open: approvals and questions happen *inside* a running turn, and
    // the interaction router only claims what the WeChat turn started.
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]
    const pending = env.interactions.handleApproval(
      { agent, toolName: 'bash', signal: new AbortController().signal },
      async () => 'delegated',
    )
    await waitFor(() => env.interactions.isWaiting('p2p:user@im.wechat'))

    // A message that is not an answer still becomes a turn, but the user is reminded.
    await env.bridge.handleInbound(inboundMessage({ text: '顺手把日志也清一下', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /还在等你确认/.test(entry.text)))
    const reminders = env.client.sent.filter((entry) => /还在等你确认/.test(entry.text))
    assert.equal(reminders.length, 1)

    // Only once per interaction: a second unrecognised message adds no more noise.
    await env.bridge.handleInbound(inboundMessage({ text: '顺便看看磁盘', id: 3 }))
    await waitFor(() => env.harness.agents[0].prompts.length >= 2)
    assert.equal(env.client.sent.filter((entry) => /还在等你确认/.test(entry.text)).length, 1)

    assert.equal(env.interactions.tryConsume('p2p:user@im.wechat', '拒绝'), true)
    assert.equal(await pending, 'rejected')
  } finally {
    await env.cleanup()
  }
})

/** A permission-presets stub shaped like the host service. */
function fakePermissionPresets(initial = 'workspace-write') {
  const calls = []
  const state = new Map()
  return {
    calls,
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'Read only', description: 'Read files without writing them.' },
        { value: 'workspace-write', name: 'Workspace write', description: 'Write inside the workspace.' },
        { value: 'danger-full-access', name: 'Full access', description: 'Full file access without approval prompts.' },
      ],
      defaultPreset: initial,
    }),
    current: (session) => state.get(session?.id) ?? initial,
    set: (session, name) => {
      calls.push({ sessionId: session?.id, name })
      state.set(session?.id, name)
    },
  }
}

test('/permission reports the mode of the bound conversation', async () => {
  const presets = fakePermissionPresets('workspace-write')
  const env = await setup({
    harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }, services: { permissionPresets: presets } },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '/permission', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /权限模式/.test(entry.text)))
    const reply = env.client.sent.map((entry) => entry.text).find((text) => /权限模式/.test(text))
    assert.match(reply, /workspace-write/)
    assert.match(reply, /read-only/)
    assert.match(reply, /danger-full-access/)
    // The current mode is marked, and nothing was changed by reading it.
    assert.match(reply, /→ workspace-write/)
    assert.equal(presets.calls.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('/permission switches the mode and records it for the conversation', async () => {
  const presets = fakePermissionPresets('workspace-write')
  const env = await setup({
    harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }, services: { permissionPresets: presets } },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const sessionId = env.harness.agents[0].session.id

    await env.bridge.handleInbound(inboundMessage({ text: '/permission read-only', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /已切换本对话的权限模式/.test(entry.text)))
    assert.deepEqual(presets.calls, [{ sessionId, name: 'read-only' }])
    const reply = env.client.sent.map((entry) => entry.text).find((text) => /已切换本对话的权限模式/.test(text))
    assert.match(reply, /read-only/)

    // /status then reports the new mode.
    await env.bridge.handleInbound(inboundMessage({ text: '/status', id: 3 }))
    await waitFor(() => env.client.sent.some((entry) => /状态：/.test(entry.text)))
    const status = env.client.sent.map((entry) => entry.text).find((text) => /状态：/.test(text))
    assert.match(status, /权限：read-only/)
  } finally {
    await env.cleanup()
  }
})

test('/permission refuses an unknown preset and a non-owner switch', async () => {
  const presets = fakePermissionPresets()
  const env = await setup({
    harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }, services: { permissionPresets: presets } },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    await env.bridge.handleInbound(inboundMessage({ text: '/permission yolo', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /没有这个权限模式/.test(entry.text)))
    assert.equal(presets.calls.length, 0, 'an unknown preset must not reach the host')
    assert.ok(!env.client.sent.some((entry) => /yolo/.test(entry.text) && /已切换/.test(entry.text)))
  } finally {
    await env.cleanup()
  }
})

test('full access needs the explicit confirmation word', async () => {
  const presets = fakePermissionPresets()
  const env = await setup({
    harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }, services: { permissionPresets: presets } },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)

    await env.bridge.handleInbound(inboundMessage({ text: '/permission danger-full-access', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /不再向你请求审批/.test(entry.text)))
    assert.equal(presets.calls.length, 0, 'the bare name must only warn')

    await env.bridge.handleInbound(inboundMessage({ text: '/permission danger-full-access confirm', id: 3 }))
    await waitFor(() => env.client.sent.some((entry) => /已切换本对话的权限模式/.test(entry.text)))
    assert.deepEqual(presets.calls.map((call) => call.name), ['danger-full-access'])
  } finally {
    await env.cleanup()
  }
})

test('/listen starts forwarding turns that other clients started', async () => {
  const env = await setup({
    harness: {
      reply: '微信自己的回答',
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const sessionId = env.harness.agents[0].session.id
    const before = env.client.sent.length

    // A GUI turn in the same session is ignored while the feed is off.
    const session = env.harness.agents[0].session
    env.bridge.onSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 42, message: { role: 'assistant', content: [{ type: 'text', text: 'GUI 的答案' }] } },
    })
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 42, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(env.client.sent.length, before, 'off by default')
    assert.equal(env.bridge.isFollowing('p2p:user@im.wechat'), false)

    await env.bridge.handleInbound(inboundMessage({ text: '/listen', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /已开始接收/.test(entry.text)))
    assert.equal(env.bridge.isFollowing('p2p:user@im.wechat'), true)

    // Now the same GUI turn is forwarded, labelled as coming from elsewhere.
    env.bridge.onSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 43, message: { role: 'assistant', content: [{ type: 'text', text: 'GUI 的答案二' }] } },
    })
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 43, reason: { kind: 'completed' } } })
    await waitFor(() => env.client.sent.some((entry) => /GUI 的答案二/.test(entry.text)))
    const forwarded = env.client.sent.map((entry) => entry.text).find((text) => /GUI 的答案二/.test(text))
    assert.match(forwarded, /📥 其他客户端/)
    assert.match(forwarded, new RegExp(sessionId.slice(-8)))

    // A failure with no text is still reported, so the chat is not left guessing.
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 44, reason: { kind: 'error' } } })
    await waitFor(() => env.client.sent.some((entry) => /没有文本输出/.test(entry.text)))
  } finally {
    await env.cleanup()
  }
})

test('/mute stops the feed again, and WeChat-initiated turns are never duplicated', async () => {
  const env = await setup({
    harness: { reply: '微信自己的回答', agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const session = env.harness.agents[0].session

    await env.bridge.handleInbound(inboundMessage({ text: '/listen', id: 2 }))
    await waitFor(() => env.bridge.isFollowing('p2p:user@im.wechat'))

    // A turn this chat asked for goes through the pending path exactly once: the feed
    // must not echo a second copy of it.
    const beforeOwn = env.client.sent.length
    await env.bridge.handleInbound(inboundMessage({ text: '再答一次', id: 3 }))
    await waitFor(() => env.harness.agents[0].prompts.length >= 2)
    await waitFor(() => env.client.sent.length > beforeOwn)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const answers = env.client.sent.filter((entry) => entry.text === '微信自己的回答')
    assert.equal(answers.length, 2, `expected two answers (one per turn), got ${JSON.stringify(env.client.sent.map((e) => e.text.slice(0, 30)))}`)
    assert.ok(!env.client.sent.some((entry) => /📥/.test(entry.text)), 'no follow-up copy of our own turn')

    await env.bridge.handleInbound(inboundMessage({ text: '/mute', id: 4 }))
    await waitFor(() => env.client.sent.some((entry) => /已停止接收/.test(entry.text)))
    assert.equal(env.bridge.isFollowing('p2p:user@im.wechat'), false)

    const before = env.client.sent.length
    env.bridge.onSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 77, message: { role: 'assistant', content: [{ type: 'text', text: '不该出现' }] } },
    })
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 77, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(env.client.sent.length, before, 'nothing is forwarded after /mute')
  } finally {
    await env.cleanup()
  }
})

test('/listen binds a session when the chat has none yet, and /status shows the feed', async () => {
  const env = await setup({
    harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } },
  })
  try {
    assert.equal(env.store.sessionFor('p2p:user@im.wechat'), undefined)
    await env.bridge.handleInbound(inboundMessage({ text: '/listen' }))
    await waitFor(() => env.bridge.isFollowing('p2p:user@im.wechat'))
    assert.ok(env.store.sessionFor('p2p:user@im.wechat'), 'following creates the binding it will follow')

    await env.bridge.handleInbound(inboundMessage({ text: '/status', id: 2 }))
    await waitFor(() => env.client.sent.some((entry) => /状态：/.test(entry.text)))
    const status = env.client.sent.map((entry) => entry.text).find((text) => /状态：/.test(text))
    assert.match(status, /接收其它客户端的回合：开/)
  } finally {
    await env.cleanup()
  }
})

test('a turn whose stream produced nothing still answers from the committed message', async () => {
  // Regression: the committed-message fallback never ran because `messageText` was not
  // imported, so the branch threw and the text was silently lost. This drives a turn
  // that emits NO stream frames — only the session's committed assistant message.
  const env = await setup({
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ agent, emit, defer }) => {
        defer()
        const turn = 1
        emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
        emit('session/event', agent.session, {
          type: 'assistant/message',
          // The host commits content as text blocks, not as a bare string.
          data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: '只有提交消息，没有流式输出' }] } },
        })
        emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '跑一轮' }))
    await waitFor(() => env.client.sent.some((entry) => /只有提交消息/.test(entry.text)), {
      label: 'committed-text fallback delivered',
    })
    assert.ok(env.client.sent.some((entry) => /只有提交消息，没有流式输出/.test(entry.text)))
  } finally {
    await env.cleanup()
  }
})

test('a long WeChat turn gets "still working" heartbeats, and they stop with the turn', async () => {
  const env = await setup({
    config: { progressHeartbeatSeconds: 1 },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ agent, emit, defer }) => {
        defer()
        emit('session/event', agent.session, { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"sleep 300"}' } })
        // Hold the turn open long enough for two heartbeats, then finish it the way
        // the real driver does (streamed text + the matching `turn/end`).
        setTimeout(() => agent.completeDeferredTurn('跑完了'), 2_400)
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '跑个长任务' }))
    await waitFor(() => env.client.sent.some((entry) => /仍在处理中/.test(entry.text)), { timeoutMs: 3_000, label: 'first heartbeat' })
    const beats = env.client.sent.filter((entry) => /仍在处理中/.test(entry.text))
    assert.ok(beats.length >= 1, 'at least one heartbeat')
    assert.match(beats[0].text, /🔄 仍在处理中…（已 \d+ 秒｜最后一步：bash）/)

    await waitFor(() => env.client.sent.some((entry) => /跑完了/.test(entry.text)), { timeoutMs: 5_000, label: 'the answer' })
    const before = env.client.sent.filter((entry) => /仍在处理中/.test(entry.text)).length
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const after = env.client.sent.filter((entry) => /仍在处理中/.test(entry.text)).length
    assert.equal(after, before, 'heartbeats stop once the turn ends')
  } finally {
    await env.cleanup()
  }
})

test('heartbeats are opt-out and never fire for turns from other clients', async () => {
  const off = await setup({
    config: { progressHeartbeatSeconds: 0 },
    harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } },
  })
  try {
    await off.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => off.client.sent.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    assert.ok(!off.client.sent.some((entry) => /仍在处理中/.test(entry.text)), '0 disables heartbeats')
  } finally {
    await off.cleanup()
  }

  // Tool-progress off means the heartbeat stays generic: the name comes from the same
  // switch, so a person who muted tool lines is not told tool names by the back door.
  const quiet = await setup({
    config: { progressHeartbeatSeconds: 1, showToolProgress: false },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ agent, emit, defer }) => {
        defer()
        emit('session/event', agent.session, { type: 'tool/call', data: { name: 'bash', arguments: '{}' } })
        setTimeout(() => agent.completeDeferredTurn('好了'), 2_000)
      },
    },
  })
  try {
    await quiet.bridge.handleInbound(inboundMessage({ text: '静默长任务' }))
    await waitFor(() => quiet.client.sent.some((entry) => /仍在处理中/.test(entry.text)), { timeoutMs: 3_000, label: 'quiet heartbeat' })
    const beat = quiet.client.sent.find((entry) => /仍在处理中/.test(entry.text))
    assert.ok(!/最后一步/.test(beat.text), `no tool name when tool progress is off: ${beat.text}`)
    assert.ok(!quiet.client.sent.some((entry) => /🔧/.test(entry.text)), 'no tool lines either')
  } finally {
    await quiet.cleanup()
  }

  const on = await setup({
    config: { progressHeartbeatSeconds: 1 },
    harness: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } },
  })
  try {
    await on.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => on.harness.agents.length === 1)
    const session = on.harness.agents[0].session
    await on.bridge.handleInbound(inboundMessage({ text: '/listen', id: 2 }))
    await waitFor(() => on.bridge.isFollowing('p2p:user@im.wechat'))
    const before = on.client.sent.length

    // A foreign turn in a followed session: /listen reports its result once, but it
    // must not produce heartbeats — the chat is not waiting on it.
    on.bridge.onSessionEvent(session, { type: 'turn/start', data: { turn: 91 } })
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    const beats = on.client.sent.slice(before).filter((entry) => /仍在处理中/.test(entry.text))
    assert.equal(beats.length, 0, 'no heartbeat for a turn nobody in WeChat started')
  } finally {
    await on.cleanup()
  }
})

test('interactions from a turn WeChat did not start stay with their own client', async () => {
  // Regression: the router used to claim every interaction in a *bound* session, so a
  // question raised by a GUI turn was swallowed — the GUI showed no dialog and the card
  // landed in a chat that was not even driving that turn.
  const env = await setup({ config: { approvalTimeoutSeconds: 30, questionsTimeoutSeconds: 30 } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]
    assert.equal(env.bridge.conversationForSession(agent.session.id), 'p2p:user@im.wechat', 'the session is bound')
    assert.equal(env.bridge.isDrivingTurn(agent.session.id), false, 'but WeChat is not driving it now')

    let delegated = 0
    const answer = await env.interactions.handleQuestions(
      { agent, signal: new AbortController().signal, questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      async () => {
        delegated += 1
        return 'gui-answer'
      },
    )
    assert.equal(answer, 'gui-answer', 'the GUI handler answered')
    assert.equal(delegated, 1, 'the request reached the next handler exactly once')
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), false, 'no reply slot claimed')

    const approval = await env.interactions.handleApproval(
      { agent, toolName: 'bash', reason: 'rm -rf /tmp/x', signal: new AbortController().signal },
      async () => {
        delegated += 1
        return 'gui-decision'
      },
    )
    assert.equal(approval, 'gui-decision')
    assert.equal(delegated, 2)

    // Nothing was pushed to the chat, and no reminder was armed for it.
    assert.ok(!env.client.sent.some((entry) => /需要你的回答|需要你确认/.test(entry.text)), 'no card in WeChat')
  } finally {
    await env.cleanup()
  }
})

test('a sub-agent question is claimed only while a WeChat turn owns the tree', async () => {
  const env = await setup({
    config: { questionsTimeoutSeconds: 30 },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.harness.agents.length === 1)
    const rootId = env.harness.agents[0].session.id

    const childId = 'session-child-questions'
    env.harness.sessions.set(childId, { id: childId, header: { id: childId, cwd: '/tmp', parentSession: rootId } })
    const childAgent = { id: childId, session: { id: childId, header: { id: childId, cwd: '/tmp', parentSession: rootId } } }

    assert.equal(env.bridge.isDrivingTurn(childId), true, 'a child counts as driven while the root turn runs')

    const pending = env.interactions.handleQuestions(
      { agent: childAgent, signal: new AbortController().signal, questions: [{ question: '继续吗？', options: ['继续', '停'] }] },
      async () => 'delegated',
    )
    await waitFor(() => env.client.sent.some((entry) => /需要你的回答/.test(entry.text)), { label: 'child question card' })
    await env.bridge.handleInbound(inboundMessage({ text: '继续', id: 98 }))
    const answers = await pending
    assert.equal(answers?.answers?.length, 1, 'the reply was consumed as the answer')
    assert.match(JSON.stringify(answers.answers[0]), /继续/)
  } finally {
    await env.cleanup()
  }
})

test('with /listen on, a GUI turn\'s interaction is offered to both sides and the first answer wins', async () => {
  // Following means "I am watching this conversation from my phone": the chat gets the
  // card *and* the client that started the turn keeps its own dialog. Whichever answers
  // first decides; the other side is told the card is void.
  const env = await setup({ config: { approvalTimeoutSeconds: 30, questionsTimeoutSeconds: 30 } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]
    const session = agent.session

    await env.bridge.handleInbound(inboundMessage({ text: '/listen', id: 2 }))
    await waitFor(() => env.bridge.isFollowing('p2p:user@im.wechat'))
    assert.equal(env.bridge.watchesInteraction(session.id), true, 'the chat follows this session')

    // 1) WeChat answers first: the request resolves and the other client is dismissed.
    const controller = new AbortController()
    // The plugin must NOT touch request.signal: the host's own decide() races the
    // waterfall against that signal, so a synthetic abort settles the request as
    // "cancelled" before our answer lands (every WeChat approval would become a denial).
    // The other client's dialog therefore stays open until clicked.
    let dismissNotified = false
    controller.signal.addEventListener('abort', () => {
      dismissNotified = true
    })
    let guiCalls = 0
    let guiResolve
    const gui = new Promise((resolve) => {
      guiResolve = resolve
    })
    const pending = env.interactions.handleApproval(
      { agent, toolName: 'bash', signal: controller.signal },
      async () => {
        guiCalls += 1
        return gui
      },
    )
    await waitFor(() => env.client.sent.some((entry) => /需要你确认/.test(entry.text)), { label: 'approval card' })
    assert.equal(guiCalls, 1, 'the GUI dialog is still offered')
    await env.bridge.handleInbound(inboundMessage({ text: '允许', id: 3 }))
    assert.equal(await pending, 'allowed-once')
    assert.equal(dismissNotified, false, 'the request signal is left untouched')
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), false, 'our slot is released')
    guiResolve('cancelled')

    // 2) The other client answers first: WeChat's card is withdrawn with a notice.
    const before = env.client.sent.length
    const answeredElsewhere = env.interactions.handleQuestions(
      { agent, signal: new AbortController().signal, questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      async () => ({ answers: [{ id: 'q1', custom: 'GUI 已答' }] }),
    )
    const result = await answeredElsewhere
    assert.match(JSON.stringify(result), /GUI 已答/)
    await waitFor(() => env.client.sent.slice(before).some((entry) => /已在原来的客户端上回答/.test(entry.text)), {
      label: 'void notice',
    })
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), false)

    // 3) Following also delivers the finished turn's text, marked as another client's.
    env.bridge.onSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 5, message: { role: 'assistant', content: [{ type: 'text', text: 'GUI 的结果' }] } },
    })
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await waitFor(() => env.client.sent.some((entry) => /GUI 的结果/.test(entry.text)), { label: 'followed result' })
    assert.match(env.client.sent.find((entry) => /GUI 的结果/.test(entry.text)).text, /📥 其他客户端/)
  } finally {
    await env.cleanup()
  }
})

test('after the WeChat turn ends, later interactions in that session belong to their own client', async () => {
  // Ownership follows the *running* turn, not the binding: once our turn is over, a
  // question raised by a later turn (a GUI turn, a background job) stays with it.
  const env = await setup({ config: { questionsTimeoutSeconds: 30 } })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]
    assert.equal(env.bridge.isDrivingTurn(agent.session.id), false, 'our turn already finished')

    let delegated = 0
    const answered = await env.interactions.handleQuestions(
      { agent, signal: new AbortController().signal, questions: [{ question: '后来才问的', options: ['A'] }] },
      async () => {
        delegated += 1
        return 'gui'
      },
    )
    assert.equal(answered, 'gui')
    assert.equal(delegated, 1)
    assert.ok(!env.client.sent.some((entry) => /需要你的回答/.test(entry.text)), 'nothing pushed to WeChat')
  } finally {
    await env.cleanup()
  }
})

test('a long answer is chunked, and the truncation notice says how much was left out', async () => {
  const env = await setup({
    config: { chunkChars: 200, maxAnswerChars: 500, chunkDelayMs: 0 },
    harness: {
      reply: 'x'.repeat(1200),
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '写长一点' }))
    await waitFor(() => env.client.sent.some((entry) => /已省略/.test(entry.text)), { label: 'truncation notice' })
    const texts = env.client.sent.map((entry) => entry.text)
    const notice = texts.find((text) => /已省略/.test(text))
    // 1200 chars of body, 500 kept → 700 left out.
    assert.match(notice, /已省略 700 字/)
    assert.match(notice, /完整内容见 DSH 会话记录/)
    // Nothing was silently dropped: the kept part is all there, in chunks (the notice
    // itself rides in the last chunk, so count characters rather than chunks).
    const kept = texts.join('').split('x').length - 1
    assert.equal(kept, 500, 'the delivered body is exactly the cap')
  } finally {
    await env.cleanup()
  }
})

test('maxAnswerChars: 0 sends the whole answer', async () => {
  const env = await setup({
    config: { chunkChars: 400, maxAnswerChars: 0, chunkDelayMs: 0 },
    harness: {
      reply: 'y'.repeat(1000),
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '全文发给我' }))
    await waitFor(() => env.client.sent.map((entry) => entry.text).join('').split('y').length - 1 === 1000, {
      label: 'the whole answer',
    })
    assert.ok(!env.client.sent.some((entry) => /已省略/.test(entry.text)), 'no truncation notice')
  } finally {
    await env.cleanup()
  }
})

test('a rate-limited chunk (ret=-2) is retried instead of lost', async () => {
  // iLink answers `ret=-2 (prepare failed)` when sends come too fast; that refused chunk
  // used to be dropped from the answer with no second attempt.
  const env = await setup({ config: { chunkDelayMs: 0, sendRetryMs: [1, 1, 1] } })
  try {
    let attempts = 0
    const original = env.client.sendText.bind(env.client)
    env.client.sendText = async (request) => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('ilink: POST /ilink/bot/sendmessage failed with ret=-2 (prepare failed)')
        error.ret = -2
        throw error
      }
      return original(request)
    }
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    await waitFor(() => env.client.sent.length > 0, { label: 'the answer' })
    assert.ok(attempts >= 2, `the chunk was retried (attempts=${attempts})`)
    assert.ok(!env.client.sent.some((entry) => /未能发出/.test(entry.text)), 'no failure notice')
  } finally {
    await env.cleanup()
  }
})

test('a session-expired send failure is not retried', async () => {
  const env = await setup({ config: { chunkDelayMs: 0, sendRetryMs: [1, 1, 1] } })
  try {
    // Count attempts per message: the answer chunk and the failure notice are two
    // different messages, and neither may be retried when the session is gone.
    const attemptsById = new Map()
    env.client.sendText = async (request) => {
      attemptsById.set(request.clientId, (attemptsById.get(request.clientId) ?? 0) + 1)
      const error = new Error('ilink: POST /ilink/bot/sendmessage failed with ret=-14 (session expired)')
      error.ret = -14
      throw error
    }
    await env.bridge.handleInbound(inboundMessage({ text: '你好' }))
    // The failure notice cannot be delivered either (every send fails), so assert on what
    // the plugin recorded: exactly one attempt, and the reason kept for /status.
    await waitFor(() => /回复发送失败/.test(env.store.state.stats?.lastError?.message ?? ''), { label: 'recorded failure' })
    assert.deepEqual([...attemptsById.values()], [1, 1], 'each message was tried exactly once')
    assert.match(env.store.state.stats.lastError.message, /ret=-14/)
  } finally {
    await env.cleanup()
  }
})

test('a WeChat turn offers the approval to the other client too, and survives "no answerer there"', async () => {
  // The person may be at the desk or on the phone, so a turn started here is offered to
  // both. The host's terminal answerer resolves "unavailable" when nobody else can take
  // it — that is not a decision and must not void the card in the chat.
  const env = await setup({
    config: { approvalTimeoutSeconds: 30 },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '删掉临时文件' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]

    let otherCalls = 0
    const pending = env.interactions.handleApproval(
      { agent, toolName: 'bash', reason: 'rm -rf /tmp/x', signal: new AbortController().signal },
      async () => {
        otherCalls += 1
        return 'unavailable' // the host's terminal value: nobody else can answer
      },
    )
    await waitFor(() => env.client.sent.some((entry) => /需要你确认/.test(entry.text)), { label: 'approval card' })
    assert.equal(otherCalls, 1, 'the other client was offered the request as well')
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), true, 'the chat still owns the reply slot')

    await env.bridge.handleInbound(inboundMessage({ text: '允许', id: 21 }))
    assert.equal(await pending, 'allowed-once')
    assert.ok(!env.client.sent.some((entry) => /作废/.test(entry.text)), 'no void notice when nobody else answered')
  } finally {
    await env.cleanup()
  }
})

test('a WeChat question survives NO_PROVIDER from the other side, and yields when the other side answers', async () => {
  const env = await setup({
    config: { questionsTimeoutSeconds: 30 },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '开始' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]

    // 1) Nobody else can answer: the host rejects with NO_PROVIDER, the chat keeps the card.
    const pending = env.interactions.handleQuestions(
      { agent, signal: new AbortController().signal, questions: [{ question: '继续吗？', options: ['继续', '停'] }] },
      async () => {
        const error = new Error('no user-questions answerer accepted the request')
        error.code = 'NO_PROVIDER'
        throw error
      },
    )
    await waitFor(() => env.client.sent.some((entry) => /需要你的回答/.test(entry.text)), { label: 'question card' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), true, 'the card is still live')
    await env.bridge.handleInbound(inboundMessage({ text: '1', id: 22 }))
    const answered = await pending
    assert.equal(answered?.answers?.length, 1)

    // 2) The other client really answers first: the chat's card is voided with a notice.
    const before = env.client.sent.length
    const second = env.interactions.handleQuestions(
      { agent, signal: new AbortController().signal, questions: [{ question: '再来一次？', options: ['好'] }] },
      async () => ({ answers: [{ id: 'q2', custom: 'GUI 答的' }] }),
    )
    const result = await second
    assert.match(JSON.stringify(result), /GUI 答的/)
    await waitFor(() => env.client.sent.slice(before).some((entry) => /已在原来的客户端上回答/.test(entry.text)), {
      label: 'void notice',
    })
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), false)
  } finally {
    await env.cleanup()
  }
})

test('a real decision from the other client voids the WeChat approval card', async () => {
  const env = await setup({
    config: { approvalTimeoutSeconds: 30 },
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ defer }) => defer(),
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '删掉临时文件' }))
    await waitFor(() => env.harness.agents.length === 1)
    const agent = env.harness.agents[0]

    const before = env.client.sent.length
    const outcome = await env.interactions.handleApproval(
      { agent, toolName: 'bash', signal: new AbortController().signal },
      async () => 'rejected', // the desk answered first
    )
    assert.equal(outcome, 'rejected')
    await waitFor(() => env.client.sent.slice(before).some((entry) => /已在原来的客户端上回答/.test(entry.text)), {
      label: 'void notice',
    })
    assert.equal(env.interactions.isWaiting('p2p:user@im.wechat'), false, 'the chat slot was released')
  } finally {
    await env.cleanup()
  }
})

test('a queued message never adopts the turn another client was already running', async () => {
  // Regression: a queued message keeps a placeholder with turn=null, and `turn/end` fell
  // back to "any unstarted message" — so a turn that was *already running* when the
  // message arrived delivered its answer into the chat, and the message's own answer was
  // dropped when the placeholder got consumed.
  let jobs = 0
  const env = await setup({
    harness: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      respond: ({ agent, defer }) => {
        jobs += 1
        if (jobs === 1) {
          // First message binds the conversation and finishes its turn completely.
          defer()
          agent.completeDeferredTurn('绑定完成')
        }
        // Later messages stay queued: no turn/start is emitted for them.
      },
    },
  })
  try {
    await env.bridge.handleInbound(inboundMessage({ text: '先绑定' }))
    await waitFor(() => env.harness.agents.length === 1)
    const session = env.harness.agents[0].session
    await waitFor(() => env.client.sent.some((entry) => /绑定完成/.test(entry.text)))

    // Another client's turn is running *before* the WeChat message arrives.
    env.bridge.onSessionEvent(session, { type: 'turn/start', data: { turn: 7 } })
    await env.bridge.handleInbound(inboundMessage({ text: '排队等我', id: 2 }))
    const before = env.client.sent.length

    env.bridge.onSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 7, message: { role: 'assistant', content: [{ type: 'text', text: '别人那轮的答案' }] } },
    })
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(env.client.sent.length, before, 'the other client\'s turn was not delivered here')
    assert.ok(!env.client.sent.some((entry) => /别人那轮的答案/.test(entry.text)))

    // Our own turn — a different number — still lands.
    env.bridge.onSessionEvent(session, { type: 'turn/start', data: { turn: 8 } })
    env.bridge.onSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 8, message: { role: 'assistant', content: [{ type: 'text', text: '我的答案' }] } },
    })
    env.bridge.onSessionEvent(session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
    await waitFor(() => env.client.sent.some((entry) => /我的答案/.test(entry.text)), { label: 'my own answer' })
  } finally {
    await env.cleanup()
  }
})
