/**
 * Interaction-router tests that need millisecond timeouts.
 *
 * `test/bridge.test.mjs` drives the router through the bridge with the real config
 * validator, whose minimum timeouts are whole seconds. These cases cover the timing
 * paths directly: answering from the chat, the card expiring while another client can
 * still answer, and the prompt failing to send.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { InteractionRouter } from '../lib/approval.js'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * Build a router whose prompts are captured instead of sent.
 * @param {object} [options] - overrides.
 * @returns {{ router: InteractionRouter, sent: string[], calls: { other: number } }}
 */
function makeRouter(options = {}) {
  const sent = []
  const calls = { other: 0 }
  const router = new InteractionRouter({
    config: {
      approvalTimeoutSeconds: 0.05,
      questionsTimeoutSeconds: 0.05,
      // The dedicated dismissal tests opt in; the others must not race a 50ms timer.
      closeRemoteDialogAfterAnswer: false,
      ...(options.config ?? {}),
    },
    logger: silentLogger,
    send: async (_conversationKey, text) => {
      if (options.sendFails) throw new Error('dsh-wechat: bridge is not ready yet')
      sent.push(text)
    },
    conversationOf: () => 'p2p:user@im.wechat',
    ownsInteraction: options.owns ?? (() => true),
    watchesInteraction: options.watches ?? (() => false),
  })
  return { router, sent, calls }
}

test('answering from the chat resolves, and never aborts the request signal', async () => {
  // Dispatching `abort` on request.signal looks like a tidy way to dismiss the other
  // client's dialog, but the host's own decide() races the waterfall against that very
  // signal: a synthetic abort settles the request as "cancelled" before our answer
  // lands, so every WeChat approval became a denial.
  const { router, sent } = makeRouter()
  const controller = new AbortController()
  let aborted = false
  controller.signal.addEventListener('abort', () => {
    aborted = true
  })

  let otherCalls = 0
  const pending = router.handleApproval(
    { agent: { session: { id: 's1' } }, toolName: 'bash', signal: controller.signal },
    async () => {
      otherCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 400))
      return 'allowed-once'
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(otherCalls, 1, 'the other client was offered the request')
  assert.equal(sent.some((text) => /需要你确认/.test(text)), true, 'the chat got a card')

  assert.equal(router.tryConsume('p2p:user@im.wechat', '允许'), true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(aborted, false, 'the request signal was left alone')
})

test('an expired chat card hands the decision to the other client instead of hanging', async () => {
  // Regression: the timeout branch used to call finish() with a callback that *returned*
  // the delegated promise; finish() dropped it, so the request never settled and the turn
  // hung forever while the chat was told "the other client will answer".
  const { router, sent } = makeRouter()
  const pending = router.handleApproval(
    { agent: { session: { id: 's1' } }, toolName: 'bash', signal: new AbortController().signal },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return 'rejected'
    },
  )
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('TIMED-OUT'), 2_000)),
  ])
  assert.equal(outcome, 'rejected', 'the other client decided after our card expired')
  assert.equal(sent.some((text) => /已超时/.test(text)), true, 'the chat was told the card expired')
  assert.equal(router.isWaiting('p2p:user@im.wechat'), false, 'our reply slot was released')
})

test('a question whose card expired is answered by the other client', async () => {
  const { router } = makeRouter()
  const pending = router.handleQuestions(
    {
      agent: { session: { id: 's1' } },
      signal: new AbortController().signal,
      questions: [{ question: '选哪个？', options: ['A', 'B'] }],
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return { answers: [{ id: 'q1', custom: 'GUI 答的' }] }
    },
  )
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('TIMED-OUT'), 2_000)),
  ])
  assert.match(JSON.stringify(outcome), /GUI 答的/)
})

test('a prompt that cannot be sent delegates the decision and still settles', async () => {
  const { router } = makeRouter({ sendFails: true })
  let otherCalls = 0
  const pending = router.handleApproval(
    { agent: { session: { id: 's1' } }, toolName: 'bash', signal: new AbortController().signal },
    async () => {
      otherCalls += 1
      return 'allowed-once'
    },
  )
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('TIMED-OUT'), 2_000)),
  ])
  assert.equal(outcome, 'allowed-once', 'the other client answered instead')
  assert.equal(otherCalls, 1)
  assert.equal(router.isWaiting('p2p:user@im.wechat'), false)
})

test('only a request this chat is involved in is answered here', async () => {
  const { router, sent } = makeRouter({ owns: () => false, watches: () => false })
  const outcome = await router.handleApproval(
    { agent: { session: { id: 's1' } }, toolName: 'bash', signal: new AbortController().signal },
    async () => 'rejected',
  )
  assert.equal(outcome, 'rejected')
  assert.equal(sent.length, 0, 'nothing was pushed to the chat')
})

test('the other client is asked to close its dialog only after the decision is accepted', async () => {
  // The host's decide() races the waterfall against request.signal and resolves
  // "cancelled" on abort. Mimic that faithfully: the abort listener must be *removed* by
  // the time we dispatch, otherwise a WeChat "allow" becomes a denial.
  const sent = []
  const router = new InteractionRouter({
    config: { approvalTimeoutSeconds: 30, closeRemoteDialogAfterAnswer: true },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    send: async (_key, text) => sent.push(text),
    conversationOf: () => 'p2p:user@im.wechat',
    ownsInteraction: () => true,
    watchesInteraction: () => false,
  })
  const controller = new AbortController()
  const order = []
  // The host's side of the race.
  const decided = new Promise((resolve) => {
    const onAbort = () => {
      order.push('host-cancelled')
      resolve('cancelled')
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    setTimeout(() => {
      // Our answer arrives first, exactly like the plugin resolving its waterfall promise.
      order.push('our-answer')
      controller.signal.removeEventListener('abort', onAbort)
      resolve('allowed-once')
    }, 10)
    // …and the dismissal must reach the other client after that.
    const onDismiss = () => order.push('dismissed')
    controller.signal.addEventListener('abort', () => {
      if (order.includes('our-answer')) onDismiss()
    })
  })

  const pending = router.handleApproval(
    { agent: { session: { id: 's1' } }, toolName: 'bash', signal: controller.signal },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return 'rejected'
    },
  )
  // Wait for our own reply path: answering here is what the chat does.
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(router.tryConsume('p2p:user@im.wechat', '允许'), true)
  assert.equal(await pending, 'allowed-once', 'the chat answer wins and is not cancelled')
  const hostOutcome = await decided
  assert.equal(hostOutcome, 'allowed-once', 'the host saw the allow, not a cancellation')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(order.slice(0, 2), ['our-answer', 'dismissed'], `order was ${order.join(', ')}`)
  assert.ok(!order.includes('host-cancelled'), 'the host must not observe an abort')
})

test('closeRemoteDialogAfterAnswer: false leaves the other dialog alone', async () => {
  const router = new InteractionRouter({
    config: { approvalTimeoutSeconds: 30, closeRemoteDialogAfterAnswer: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    send: async () => {},
    conversationOf: () => 'p2p:user@im.wechat',
    ownsInteraction: () => true,
    watchesInteraction: () => false,
  })
  const controller = new AbortController()
  let aborted = false
  controller.signal.addEventListener('abort', () => {
    aborted = true
  })
  const pending = router.handleApproval(
    { agent: { session: { id: 's1' } }, toolName: 'bash', signal: controller.signal },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return 'rejected'
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  router.tryConsume('p2p:user@im.wechat', '允许')
  assert.equal(await pending, 'allowed-once')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(aborted, false, 'nothing was dispatched')
})

test('a pending question is announced as a question, not as an approval', async () => {
  // The hint compared `record.kind === 'questions'` while #push() registers 'question',
  // so a person answering a two-question card was told to reply 允许/拒绝 — an approval
  // that did not exist.
  const { router, sent } = makeRouter({ config: { questionsTimeoutSeconds: 30 } })
  let otherCalls = 0
  const pending = router.handleQuestions(
    {
      agent: { session: { id: 's1' } },
      // Two questions: an incomplete reply is the case that must not be consumed.
      questions: [
        { id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
        { id: 'q2', question: '记录吗？', options: [{ label: '记' }, { label: '不记' }] },
      ],
    },
    async () => {
      otherCalls += 1
      // Never answers: the other client not replying must leave the WeChat card live.
      return new Promise(() => {})
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(router.tryConsume('p2p:user@im.wechat', '这是句普通的话'), false)
  const hint = router.hintFor('p2p:user@im.wechat')
  assert.match(hint, /提问还没回答/)
  assert.equal(/允许|拒绝/.test(hint), false, 'a question never talks about approvals')
  // The nudge is said once, and answering still works afterwards.
  assert.equal(router.hintFor('p2p:user@im.wechat'), null)
  assert.equal(router.tryConsume('p2p:user@im.wechat', '甲'), true)
  assert.equal(router.tryConsume('p2p:user@im.wechat', '记'), true)
  assert.deepEqual((await pending).answers, [
    { id: 'q1', selected: ['甲'] },
    { id: 'q2', selected: ['记'] },
  ])
  // The other client is offered the question too — that is how a two-surface race works —
  // it simply never answers here.
  assert.equal(otherCalls, 1)
  assert.ok(sent.some((text) => /需要你的回答|选哪个/.test(text)))
})

test('a two-question card can be answered one question at a time', async () => {
  // People answer chat questions in sequence: "1", then the next answer. Requiring both
  // answers in one message meant the first reply did nothing at all.
  const { router, sent } = makeRouter({ config: { questionsTimeoutSeconds: 30 } })
  const questions = [
    { id: 'a', question: '交付方式？', options: [{ label: '直接发到微信' }, { label: '只给本地路径' }] },
    { id: 'b', question: '记录吗？', options: [{ label: '记进 design.md' }, { label: '不用记' }] },
  ]
  const pending = router.handleQuestions({ agent: { session: { id: 's1' } }, questions }, async () => new Promise(() => {}))
  await new Promise((resolve) => setTimeout(resolve, 10))

  // First answer: acknowledged, not submitted, and it must not leak to the agent.
  assert.equal(router.tryConsume('p2p:user@im.wechat', '1'), true)
  assert.ok(sent.some((text) => /已记录第 1 个回答，还剩 1 个/.test(text)), 'the person is told what is left')
  assert.ok(sent.some((text) => /记录吗？/.test(text)), 'and what the next question is')

  // An unrelated message must not be swallowed as the second answer.
  assert.equal(router.tryConsume('p2p:user@im.wechat', '等一下，我先看看'), false)

  // Second answer completes the batch.
  assert.equal(router.tryConsume('p2p:user@im.wechat', '不用记'), true)
  assert.deepEqual((await pending).answers, [
    { id: 'a', selected: ['直接发到微信'] },
    { id: 'b', selected: ['不用记'] },
  ])
})

test('a two-question card also accepts every answer in one message', async () => {
  const { router } = makeRouter({ config: { questionsTimeoutSeconds: 30 } })
  const questions = [
    { id: 'a', question: '交付方式？', options: [{ label: '直接发到微信' }, { label: '只给本地路径' }] },
    { id: 'b', question: '记录吗？', options: [{ label: '记进 design.md' }, { label: '不用记' }] },
  ]
  for (const reply of ['1\n不用记', '1, 不用记', '直接发到微信 不用记']) {
    const pending = router.handleQuestions({ agent: { session: { id: 's1' } }, questions }, async () => new Promise(() => {}))
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(router.tryConsume('p2p:user@im.wechat', reply), true, `consumed: ${reply}`)
    assert.deepEqual((await pending).answers, [
      { id: 'a', selected: ['直接发到微信'] },
      { id: 'b', selected: ['不用记'] },
    ])
  }
})

test('取消 hands a WeChat question back to the other client', async () => {
  const { router, sent } = makeRouter({ config: { questionsTimeoutSeconds: 30 } })
  let otherCalls = 0
  const pending = router.handleQuestions(
    { agent: { session: { id: 's1' } }, questions: [{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }] },
    async () => {
      otherCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { answers: [{ id: 'q1', selected: ['乙'] }] }
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(router.tryConsume('p2p:user@im.wechat', '取消'), true)
  assert.deepEqual((await pending).answers, [{ id: 'q1', selected: ['乙'] }], 'the other client decides')
  assert.equal(otherCalls, 1)
  assert.ok(sent.some((text) => /交回原来的客户端/.test(text)))
})

test('several answers at once and the rest later both work on one card', async () => {
  // The two natural chat flows have to coexist: "answer all three", "answer one, then the
  // next", and the mixture "answer two, then the last one".
  const { router, sent } = makeRouter({ config: { questionsTimeoutSeconds: 30 } })
  const questions = [
    { id: 'a', question: '交付方式？', options: [{ label: '直接发到微信' }, { label: '只给本地路径' }] },
    { id: 'b', question: '长报告？', options: [{ label: '写成文件再发' }, { label: '直接在正文里发' }] },
    { id: 'c', question: '记文档吗？', options: [{ label: '记进 design.md' }, { label: '不用记' }] },
  ]
  const pending = router.handleQuestions({ agent: { session: { id: 's1' } }, questions }, async () => new Promise(() => {}))
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Two answers in one message: consumed, one question left, progress reported.
  assert.equal(router.tryConsume('p2p:user@im.wechat', '1, 写成文件再发'), true, 'consumed as two answers')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(
    sent.some((text) => /已记录第 2 个回答，还剩 1 个/.test(text)),
    `progress after two answers: ${sent.join(' | ').slice(0, 200)}`,
  )
  assert.ok(sent.some((text) => /记文档吗？/.test(text)), 'the remaining question is repeated')

  // The last one later completes the batch.
  assert.equal(router.tryConsume('p2p:user@im.wechat', '2'), true)
  assert.deepEqual((await pending).answers, [
    { id: 'a', selected: ['直接发到微信'] },
    { id: 'b', selected: ['写成文件再发'] },
    { id: 'c', selected: ['不用记'] },
  ])
})
