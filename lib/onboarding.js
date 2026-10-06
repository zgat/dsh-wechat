/**
 * Onboarding copy: the welcome message pushed on first contact and the `/help`
 * text. One source, so the greeting and the command reference never drift.
 *
 * @module dsh-wechat/onboarding
 */

/** Grouped command reference, shared by `/help` and the welcome message. */
export const COMMAND_GROUPS = [
  {
    title: '会话',
    items: [
      ['/new', '结束当前会话，下一条消息开新会话'],
      ['/session', '列出本工作区的多个对话并切换；`/session 3` 续聊第 3 个，`/session new` 开新的'],
      ['/permission', '查看或切换本对话的权限模式（只读 / 工作区可写 / 完全权限需二次确认）'],
      ['/stop', '停止正在跑的一轮'],
      ['/status', '连接、会话、工作区、模型、队列与统计'],
      ['/whoami', '你的微信 ID 与 DSH 会话 ID'],
    ],
  },
  {
    title: '设置（对当前微信会话生效）',
    items: [
      ['/workspace', '列出 DSH 工作区；`/workspace 2` 或 `/workspace /路径` 切换'],
      ['/model', '列出可用模型；`/model 3` 或 `/model provider/model` 切换'],
      ['/reasoning', '列出思考深度；`/reasoning 2` 或 `/reasoning high` 切换'],
      ['/settings', '查看当前会话的工作区 / 模型 / 思考深度'],
    ],
  },
  {
    title: '连接',
    items: [
      ['/ping', '连通性检查'],
      ['/login', '重新扫码绑定的方法'],
      ['/logout', '清除本机机器人凭据'],
      ['/help', '显示这份说明'],
    ],
  },
]

/**
 * @param {object} config - normalized plugin configuration.
 * @returns {string} the full `/help` text.
 */
export function helpText(config) {
  const lines = ['可用指令：']
  for (const group of COMMAND_GROUPS) {
    lines.push('', `【${group.title}】`)
    for (const [command, description] of group.items) lines.push(`${command} — ${description}`)
  }
  lines.push('', '中文别名同样可用：/帮助 /新会话 /停止 /状态 /工作区 /模型 /思考 /设置 /会话。')
  lines.push('直接发消息就是给 DSH 派活，例如「帮我看下 ~/proj 的测试为什么失败」。')
  lines.push('发图片或文件我会直接读；需要我发文件回来说一声即可。')
  lines.push('', `进度模式 ${config.progress}，单条最长 ${config.chunkChars} 字。`)
  return lines.join('\n')
}

/**
 * @param {object} options - welcome options.
 * @param {object} options.config - normalized plugin configuration.
 * @param {{ workspace?: string|null, model?: string|null, reasoning?: string|null }} [options.current]
 *   what this conversation is currently configured to use.
 * @param {boolean} [options.isOwner] - whether the recipient owns the bot.
 * @returns {string} the welcome message sent on first contact.
 */
export function welcomeText({ config, current = {}, isOwner = true }) {
  const lines = [
    '✅ 微信机器人已就绪，我是 DeepSeek Harness 的微信入口。',
    '',
    '直接发消息就是给 DSH 派活，例如：',
    '· 帮我看下 ~/proj 的测试为什么失败',
    '· 把这份会议记录整理成待办',
    '· 总结我发给你的这个文件',
    '',
    '我支持这些操作：',
    '· 发图片 / 文件 → 我会读它的内容',
    '· 要产物 → 说「发我一份」，我把文件发回微信',
    '· 长任务 → 生成中会显示「正在输入」，可随时 /stop',
    '· 需要授权 → 我发「允许 / 拒绝」，你回一个词就行',
  ]

  lines.push(
    '',
    '常用指令：',
    '· /workspace 换项目目录（不带参数会列出可选工作区）',
    '· /model 换模型（不带参数会列出可用模型）',
    '· /reasoning 换思考深度（不带参数会列出可选档位）',
    '· /session 在同一工作区里切换/续聊多个对话',
    '· /permission 查看或切换本对话的权限（只读 / 工作区可写 / 完全权限）',
    '· /new 开新对话   /stop 停止   /status 看状态',
  )

  const described = [
    current.workspace ? `工作区 ${current.workspace}` : null,
    current.model ? `模型 ${current.model}` : null,
    current.reasoning ? `思考深度 ${current.reasoning}` : null,
  ].filter(Boolean)
  if (described.length > 0) lines.push('', `当前：${described.join(' · ')}`)
  if (!isOwner) {
    lines.push('', '提示：当前账号不在白名单里，只有机器人所有者与已授权用户可以使用。')
  }
  lines.push('', '完整指令表：/help')
  void config
  return lines.join('\n')
}

/**
 * Render a numbered choice list, marking the current entry.
 * @param {Array<{ label: string, detail?: string }>} entries - choices.
 * @param {string|null} [current] - label currently in effect.
 * @param {number} [limit] - maximum entries rendered.
 * @returns {string} the rendered list.
 */
export function renderChoices(entries, current = null, limit = 25) {
  const shown = entries.slice(0, limit)
  const lines = shown.map((entry, index) => {
    const mark = current !== null && entry.label === current ? ' ←当前' : ''
    const detail = entry.detail ? `（${entry.detail}）` : ''
    return `${index + 1}. ${entry.label}${detail}${mark}`
  })
  if (entries.length > shown.length) lines.push(`…另有 ${entries.length - shown.length} 项未列出`)
  return lines.join('\n')
}
