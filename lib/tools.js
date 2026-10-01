/**
 * Model-facing tools.
 *
 * The agent drives WeChat, not only the other way round: these tools let it push
 * a message, deliver a file it produced, or check which conversation it is
 * serving. They are plain tool definitions (name / JSON-Schema parameters /
 * output), registered through `ctx.tools.register`, so no harness package needs
 * to be imported.
 *
 * @module dsh-wechat/tools
 */

import { service } from './harness.js'
import { briefValue } from './render.js'

/** The `output.render` every text-returning tool shares. */
const textOutput = (value) => [{ type: 'text', text: String(value) }]

/**
 * Build the tools bound to one bridge instance.
 * @param {object} options - tool options.
 * @param {object} options.ctx - plugin context (for initiator lookup).
 * @param {import('./bridge.js').WechatBridge} options.bridge - the running bridge.
 * @param {{ info: Function, warn: Function, debug: Function }} options.logger
 * @returns {object[]} tool definitions ready for `ctx.tools.register`.
 */
export function createWechatTools(options) {
  const { ctx, bridge, logger } = options

  /** Resolve the conversation the calling agent belongs to. */
  const current = () => {
    const agent = service(ctx, 'agents')?.currentInitiator?.()
    if (!agent) return null
    const conversationKey = bridge.conversationForAgent(agent)
    if (!conversationKey) return null
    return { agent, conversationKey }
  }

  const requireCurrent = () => {
    const found = current()
    if (!found) {
      throw new Error('dsh-wechat: 当前 Agent 没有绑定微信会话，无法发送微信消息')
    }
    return found
  }

  /**
   * Resolve a tool's destination, refusing a conversation the caller may not
   * address: the bot must not become an outbound relay for model output.
   * @param {{ conversationKey: string }} current - conversation the agent serves.
   * @param {string|undefined} toUserId - explicit destination, when given.
   * @returns {string} the target conversation key.
   */
  const resolveTarget = (current, toUserId) => {
    if (!toUserId) return current.conversationKey
    const target = `p2p:${toUserId}`
    if (!bridge.maySendTo(target, current.conversationKey)) {
      throw new Error(`dsh-wechat: 不允许发往 ${toUserId}：只允许当前会话、机器人所有者与白名单用户`)
    }
    return target
  }

  const sendTextTool = {
    name: 'wechat_send_text',
    description:
      '往当前微信会话发送一条文本消息。适合发送阶段性进展、提醒，或与最终回答分开的补充说明；最终回答会由插件自动回传，不需要重复发送。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的消息内容（纯文本）。' },
        toUserId: {
          type: 'string',
          description: '可选：改发给另一个微信用户 ID（该用户此前必须给机器人发过消息，否则缺少会话令牌）。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOutput(value) },
    async execute(args) {
      const current = requireCurrent()
      const target = resolveTarget(current, args.toUserId)
      const count = await bridge.deliver(target, String(args.text ?? ''))
      return count > 0
        ? `已发送到微信会话 ${target}（${count} 条消息）`
        : `没有可发送的内容（目标会话 ${target}）`
    },
  }

  const sendFileTool = {
    name: 'wechat_send_file',
    description:
      '把本地文件作为微信图片或文件发送到当前会话。图片按扩展名识别（jpg/png/gif/webp 等），其余按文件发送；可选先发一条说明文字。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地文件的绝对路径。' },
        caption: { type: 'string', description: '可选：发送前先发一条说明文字。' },
        toUserId: { type: 'string', description: '可选：改发给另一个微信用户 ID。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOutput(value) },
    async execute(args) {
      const current = requireCurrent()
      const target = resolveTarget(current, args.toUserId)
      if (args.caption) await bridge.deliver(target, String(args.caption))
      const result = await bridge.deliverFile(target, String(args.path ?? ''))
      return `已发送文件「${result.name}」（${result.size} 字节，${result.mediaType === 1 ? '图片' : '文件'}）到 ${target}`
    },
  }

  const chatInfoTool = {
    name: 'wechat_chat_info',
    description: '查看当前微信会话与对应 DSH 会话的状态：用户 ID、会话 ID、工作区、模型、是否有回合在运行。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => textOutput(value) },
    async execute() {
      const found = current()
      if (!found) return '当前 Agent 没有绑定微信会话。'
      return JSON.stringify(await bridge.describeConversation(found.conversationKey), null, 2)
    },
  }

  logger?.debug?.(`wechat tools prepared: ${[sendTextTool, sendFileTool, chatInfoTool].map((tool) => tool.name).join(', ')}`)
  return [sendTextTool, sendFileTool, chatInfoTool]
}

/**
 * Register every tool, returning one disposer for the whole set.
 * @param {object} tools - the tool registry (`ctx.tools`).
 * @param {object[]} definitions - definitions from {@link createWechatTools}.
 * @param {{ warn: Function }} [logger]
 * @returns {() => void} a disposer that unregisters them all.
 */
export function registerTools(tools, definitions, logger) {
  if (!tools || typeof tools.register !== 'function') {
    logger?.warn?.('ctx.tools is unavailable; wechat_* tools will not be registered')
    return () => {}
  }
  const disposers = []
  for (const definition of definitions) {
    try {
      const dispose = tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logger?.warn?.(`failed to register tool ${definition.name}: ${briefValue(error?.message ?? error, 200)}`)
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Unloading is best effort: a failing disposer must not block teardown.
      }
    }
  }
}
