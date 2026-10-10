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
    config: { approvalTimeoutSeconds: 0.05, questionsTimeoutSeconds: 0.05, ...(options.config ?? {}) },
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
