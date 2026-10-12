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
