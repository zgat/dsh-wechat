/**
 * Slash commands handled inside the chat, before a message ever reaches the agent.
 *
 * @module dsh-wechat/commands
 */

import { helpText, renderChoices } from './onboarding.js'

/** Command aliases (Chinese and English) mapped to canonical names. */
const ALIASES = new Map(
  Object.entries({
    help: 'help',
    '?': 'help',
    帮助: 'help',
    菜单: 'help',
    new: 'new',
    reset: 'new',
    新会话: 'new',
    重开: 'new',
    stop: 'stop',
    停止: 'stop',
    中断: 'stop',
    status: 'status',
    状态: 'status',
    whoami: 'whoami',
    id: 'whoami',
    我是谁: 'whoami',
    workspace: 'workspace',
    ws: 'workspace',
    工作区: 'workspace',
    model: 'model',
    模型: 'model',
    reasoning: 'reasoning',
    effort: 'reasoning',
    think: 'reasoning',
    思考: 'reasoning',
    思考深度: 'reasoning',
    settings: 'settings',
    设置: 'settings',
    session: 'session',
    sessions: 'session',
    permission: 'permission',
    permissions: 'permission',
    listen: 'listen',
    follow: 'listen',
    接收: 'listen',
    订阅: 'listen',
    mute: 'mute',
    unfollow: 'mute',
    停止接收: 'mute',
    免打扰: 'mute',
    perm: 'permission',
    权限: 'permission',
    会话: 'session',
    对话: 'session',
    menu: 'help',
    login: 'login',
    登录: 'login',
    logout: 'logout',
    退出登录: 'logout',
    ping: 'ping',
  }),
)

/**
 * Parse one chat message as a command.
 * @param {string} text - raw message text.
 * @returns {{ name: string, args: string, raw: string } | null} the command, or null.
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(trimmed)
  if (!match) return null
  const name = ALIASES.get(match[1].toLowerCase())
  if (!name) return { name: 'unknown', args: match[2].trim(), raw: match[1] }
  return { name, args: match[2].trim(), raw: match[1] }
}

/**
 * The command table. Each handler receives the bridge-facing context and returns
 * the reply text (or an empty string to stay silent).
 * @param {object} bridge - the running {@link import('./bridge.js').WechatBridge}.
 * @returns {Record<string, (args: string, context: object) => Promise<string>|string>}
 */
/**
 * One line that answers "which build is actually running".
 * @param {{ version?: string|null, startedAt?: string|null, installedVersion?: string|null }} info - status facts.
 * @returns {string} the human-readable version line.
 */
export function describeVersion(info) {
  const running = info?.version ?? null
  const installed = info?.installedVersion ?? null
  if (!running) {
    return installed
      ? `${installed}（磁盘已装，但本进程没有启动记录：重启后即可确认）`
      : '未知（本进程启动时代码还没有启动记录）'
  }
  const when = info?.startedAt ? `，启动于 ${new Date(info.startedAt).toLocaleString('zh-CN')}` : ''
  if (installed && installed !== running) {
    return `${running}（磁盘已装 ${installed}，重启 DSH 后生效）`
  }
  return `${running}${when}`
}

export function createCommands(bridge) {
  return {
    help: (_args, context) => helpText(context.config),

    settings: (_args, context) => bridge.describeSettings(context.conversationKey),

    async listen(_args, context) {
      const { following, sessionId } = await bridge.setFollow(context.conversationKey, true)
      return [
        `✅ 已开始接收这个会话的后续消息（会话 …${(sessionId ?? '').slice(-8)}）。`,
        '包括**不是从微信发起**的回合：GUI、其它工具在同一个会话里跑完的结果都会推到这里。',
        '只推最终回答与失败信息，不推工具进度；关闭用 /mute。',
      ].join('\n')
    },

    async mute(_args, context) {
      const was = bridge.isFollowing(context.conversationKey)
      await bridge.setFollow(context.conversationKey, false)
      return was
        ? '🔇 已停止接收后续消息：只有你从微信发起的回合才会回复到这里。'
        : '本来就是关闭状态：只有你从微信发起的回合才会回复到这里。'
    },

    async permission(args, context) {
      const trimmed = String(args ?? '').trim().toLowerCase()
      const { current, presets, note, sessionId } = await bridge.describePermission(context.conversationKey)
      const list = (presets ?? []).map(
        (preset) => `${preset.name === current ? '→' : ' '} ${preset.name}${preset.description ? ` — ${preset.description}` : ''}`,
      )

      if (trimmed.length === 0) {
        return [
          `本对话的权限模式：${current ?? '未知'}${sessionId ? `（会话 ${sessionId.slice(-8)}）` : ''}`,
          note,
          '',
          '可选（回复 /permission <名称> 切换）：',
          ...(list.length > 0 ? list : ['（这个 profile 没有权限预设）']),
          '',
          'read-only＝只读；workspace-write＝只能改工作区（默认）；danger-full-access＝不限制文件且不再询问审批。',
        ]
          .filter(Boolean)
          .join('\n')
      }

      // Widening to full access removes the last guardrail, so it takes the name plus
      // an explicit word: a stray message cannot do it.
      const wantsFullAccess = trimmed.startsWith('danger-full-access')
      if (wantsFullAccess) {
        if (!context.isOwner) return '只有所有者可以切换到完全权限模式。'
        if (trimmed !== 'danger-full-access confirm') {
          return [
            '⚠️ danger-full-access ＝ Agent 可以读写**任何**文件，并且**不再向你请求审批**。',
            '确认请回复：/permission danger-full-access confirm',
          ].join('\n')
        }
      } else if (!context.isOwner) {
        return '只有所有者可以切换权限模式。'
      }

      const applied = await bridge.setPermission(context.conversationKey, trimmed.replace(/\s+confirm$/, ''))
      return [
        `已切换本对话的权限模式：${applied.current ?? trimmed}`,
        applied.changed ? '（记录在该会话里，重启后依然有效）' : '（本来就是该模式，没有变化）',
      ].join('\n')
    },

    async session(args, context) {
      const trimmed = String(args ?? '').trim()
      if (/^new$/i.test(trimmed)) {
        await bridge.store?.setPendingSwitch?.(context.conversationKey, null)
        const previous = await bridge.resetConversation(context.conversationKey)
        return previous
          ? `已结束当前对话（${previous}），下一条消息开启新对话。`
          : '当前没有进行中的对话，下一条消息会开启新对话。'
      }

      const { entries, workspace, note, diagnostics } = await bridge.listSessions(context.conversationKey)

      if (/^sources$/i.test(trimmed) || /^来源$/i.test(trimmed)) {
        return [
          `来源诊断（工作区 ${workspace}）`,
          `· 实时会话：${diagnostics?.live ?? 0}`,
          `· 会话索引：${diagnostics?.indexed ?? 0}`,
          `· 工作区登记：${diagnostics?.registered ?? 0}`,
          `· 列出去重后：${entries.length}`,
          `· 拿到标题：${diagnostics?.titles ?? 0}`,
          `· 标题批量折叠：${diagnostics?.titleBatch ?? '未知'}`,
          `· 标题单条回退：${diagnostics?.titleSingles ?? '未触发'}`,
          note ? `· 提示：${note}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      }

      if (!trimmed) {
        if (entries.length === 0) {
          return [`${workspace} 下还没有对话记录。`, note, '发送任意消息即可开始一个对话。']
            .filter(Boolean)
            .join('\n')
        }
        const list = entries
          .map((entry, index) => {
            // Never show a bare id: fall back to a Chinese label with the time.
            const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
            const label = entry.title ?? `未命名对话 · ${entry.id.slice(-8)}`
            const marks = [entry.current ? '←当前' : null, entry.live ? '（运行中）' : null].filter(Boolean)
            const suffix = marks.length > 0 ? ` ${marks.join(' ')}` : ''
            return `${index + 1}. ${label}${when ? ` · ${when}` : ''}${suffix}`
          })
          .join('\n')
        const pendingSwitch = bridge.store?.pendingSwitchFor?.(context.conversationKey)
        return [
          `工作区 ${workspace} 下的对话：`,
          list,
          note ? `（${note}）` : null,
          pendingSwitch
            ? `⏳ 已切换到「${pendingSwitch.title ?? pendingSwitch.sessionId.slice(-8)}」，等你回复 0-99 决定回执几段到微信。`
            : null,
          '',
          '名字就是 DSH 界面里显示的那个标题（来自会话日志的 session/title 事件）。',
          '若某个显示「未命名对话」，说明该会话还没有标题事件；可用 /session sources 看来源诊断。',
          '回复 /session 序号 或 /session <会话 ID> 切换；/session new 开新对话。',
          '标「运行中」的对话正被某个客户端占用，切过去会共享它的上下文。',
        ]
          .filter(Boolean)
          .join('\n')
      }

      const bound = await bridge.bindSession(context.conversationKey, trimmed)
      const name = bound.title ?? `未命名对话 · ${bound.sessionId.slice(-8)}`
      const previousName = bound.previous
        ? (bound.previousTitle ?? `未命名对话 · ${bound.previous.slice(-8)}`)
        : null
      return [
        `已切换到对话：${name}`,
        previousName ? `上一个对话（${previousName}）已从微信侧解除绑定，内容仍保留在 DSH 里。` : null,
        '',
        `要把「${name}」最近的内容回执到微信吗？回复段数 0-99（一段 = 一问一答）。`,
        '不回复数字就直接发消息 ＝ 不发回执，直接接着这个对话聊（它的历史一直都在）。',
      ]
        .filter((line) => line !== null)
        .join('\n')
    },

    ping: () => `pong（${new Date().toLocaleString('zh-CN')}）`,

    async new(_args, context) {
      const previous = await bridge.resetConversation(context.conversationKey)
      return previous
        ? `已结束上一个会话（${previous}）。下次消息会开启新会话。`
        : '当前没有进行中的会话，下次消息会开启新会话。'
    },

    async stop(_args, context) {
      const { stopped, dropped } = await bridge.stopConversation(context.conversationKey)
      if (!stopped) return '当前没有正在运行的回合。'
      return dropped > 0
        ? `已请求停止当前回合；同时丢弃了排队中的 ${dropped} 条消息。`
        : '已请求停止当前回合。'
    },

    async status(_args, context) {
      const info = await bridge.describeConversation(context.conversationKey)
      return [
        '状态：',
        `· 连接：${info.connected ? '已连接' : '未连接'}${info.botId ? `（bot ${info.botId}）` : ''}`,
        `· 微信会话：${context.conversationKey}`,
        `· DSH 会话：${info.sessionId ?? '（尚未创建）'}`,
        `· 工作区：${info.workspace ?? '（默认）'}`,
        `· 模型：${info.model ?? '（跟随 DSH 默认）'}`,
        `· 预设：${info.agentPreset ?? '（未挂载 preset：可能缺少 bash/文件编辑等工具）'}`,
        `· 权限：${info.permission ?? '（未知，用 /permission 查看）'}`,
        `· 接收其它客户端的回合：${info.following ? '开（/mute 关闭）' : '关（/listen 打开）'}`,
        `· 插件版本：${describeVersion(info)}`,
        `· 运行中的回合：${info.runningTurns}`,
        `· 等待回答的交互：${info.pendingInteractions}`,
        `· 统计：收到 ${info.stats.inbound} 条 / 发出 ${info.stats.outbound} 条`,
        info.stats.lastError ? `· 最近错误：${info.stats.lastError.message}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    },

    whoami: (_args, context) =>
      [`微信 ID：${context.userId}`, `会话键：${context.conversationKey}`, `DSH 会话：${context.sessionId ?? '（尚未创建）'}`].join('\n'),

    async workspace(args, context) {
      const current = (await bridge.describeConversation(context.conversationKey)).workspace ?? null
      const { entries, note } = await bridge.listWorkspaces()

      // `/workspace add <路径> [名称]` registers a directory as a project.
      const addMatch = /^add\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.+))?$/i.exec(args ?? '')
      if (addMatch) {
        const added = await bridge.addWorkspace(addMatch[1] ?? addMatch[2] ?? addMatch[3], addMatch[4])
        const switched = await bridge.switchWorkspace(context.conversationKey, added)
        return [
          `已登记并切换到项目目录：${switched.workspace}`,
          switched.sessionId ? '（上一个会话已结束，下一条消息在新目录开新会话）' : null,
        ]
          .filter(Boolean)
          .join('\n')
      }

      if (!args) {
        const list =
          entries.length > 0
            ? entries
                .map((entry, index) => {
                  const name = entry.title ?? entry.path.split('/').filter(Boolean).pop()
                  const mark = entry.path === current ? ' ←当前' : ''
                  return `${index + 1}. ${name}（${entry.path}）${mark}`
                })
                .join('\n')
            : (note ?? '没有可选项目目录')
        return [
          '项目目录 = DSH 工作区（DSH 没有独立于目录的“项目”概念）：',
          list,
          '',
          `当前：${current ?? '（跟随 DSH 默认）'}`,
          '回复 /workspace 序号 或 /workspace 名称 或 /workspace /绝对路径 切换；',
          '用 /workspace add /绝对路径 [名称] 登记一个新目录。',
        ].join('\n')
      }

      const switched = await bridge.switchWorkspace(context.conversationKey, args)
      return [
        `已切换到项目目录：${switched.workspace}`,
        switched.sessionId
          ? `上一个会话（${switched.sessionId}）已结束并保留在 DSH 里；下一条消息会在新目录开新会话。`
          : '下一条消息会在该目录开新会话。',
      ].join('\n')
    },

    async model(args, context) {
      const options = await bridge.describeConversation(context.conversationKey)
      if (!args) {
        const { entries, note } = await bridge.listModels()
        return [
          '选择模型（回复 /model 序号 或 /model provider/model）：',
          entries.length > 0 ? renderChoices(entries, options.model ?? null) : (note ?? '没有可选模型'),
          '',
          `当前：${options.model ?? '（跟随 DSH 默认）'}`,
        ].join('\n')
      }
      const { entries } = await bridge.listModels()
      const index = Number.parseInt(args, 10)
      const picked =
        Number.isInteger(index) && index >= 1 && index <= entries.length ? entries[index - 1].label : args
      const applied = await bridge.setModel(context.conversationKey, picked)
      return `已记录本会话模型：${applied}\n（对下一个新会话生效，可先 /new 再对话）`
    },

    async reasoning(args, context) {
      const { entries, current, note } = await bridge.listReasoningEfforts(context.conversationKey)
      if (!args) {
        return [
          '选择思考深度（回复 /reasoning 序号 或 /reasoning 档位）：',
          entries.length > 0 ? renderChoices(entries, current) : (note ?? '没有可选档位'),
          '',
          `当前：${current ?? '（跟随 DSH 默认）'}`,
        ].join('\n')
      }
      const index = Number.parseInt(args, 10)
      const picked =
        Number.isInteger(index) && index >= 1 && index <= entries.length ? entries[index - 1].label : args
      const applied = await bridge.setReasoning(context.conversationKey, picked)
      return `已记录本会话思考深度：${applied}\n（对下一个新会话生效，可先 /new 再对话）`
    },

    login: () => bridge.loginHint(),

    async logout(_args, context) {
      // Unbinding the bot is destructive and account-wide, so it stays with the
      // owner even when other senders are allowlisted.
      if (!context.isOwner) return '只有机器人所有者可以清除绑定的凭据。'
      return bridge.logout()
    },
  }
}

/**
 * Run one parsed command.
 * @param {ReturnType<typeof createCommands>} commands - command table.
 * @param {{ name: string, args: string, raw: string }} parsed - parsed command.
 * @param {object} context - bridge-facing context.
 * @returns {Promise<string>} the reply text.
 */
export async function runCommand(commands, parsed, context) {
  if (parsed.name === 'unknown') {
    return `未知指令 /${parsed.raw}，发送 /help 查看可用指令。`
  }
  const handler = commands[parsed.name]
  if (!handler) return `未知指令 /${parsed.raw}，发送 /help 查看可用指令。`
  const result = await handler(parsed.args, context)
  return typeof result === 'string' ? result : ''
}
