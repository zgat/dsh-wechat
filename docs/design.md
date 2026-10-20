# 设计与实现

本文件是 [README](../README.md) 的技术配套：README 讲**怎么用**，这里讲**怎么实现、为什么这么实现、边界在哪**。
读者面向维护者与审阅者；所有结论都对应仓库里的代码与测试。

目录：架构 · 生命周期 · 会话与队列 · 交互归属与竞速 · 投递 · 跟读 · 状态与持久化 · 安全实现 · iLink 协议要点 · 与 DSH 的契约 · 测试与证据 · 平台兼容性 · 已知限制

## 架构

```
微信 App
   │  扫码绑定 / 私聊消息
   ▼
腾讯 iLink Bot 网关  https://ilinkai.weixin.qq.com
   │  getupdates 长轮询（≈35s）     ▲ sendmessage / sendtyping / getuploadurl + AES-128-ECB CDN
   ▼                                │
┌──────────────────────────────────────────────────────────────┐
│ dsh-wechat 插件（运行在 DSH Host 进程内）                     │
│                                                              │
│ index.js     生命周期与装配：服务解析、扫码页、桥接、工具注册 │
│ channel.js   登录、长轮询、游标持久化、退避与重登             │
│ bridge.js    微信会话 ↔ DSH 会话、回合队列、投递、跟读        │
│ approval.js  approval/request、user-questions/request 应答    │
│ commands.js  斜杠命令；tools.js：wechat_* 模型工具            │
│ ilink/       协议客户端（api/crypto/media）                   │
│ store.js     状态与凭据持久化；config.js：配置归一化          │
└──────────────────────────────────────────────────────────────┘
   │  ctx.get('agents').create/resume → agent.followup(用户消息)
   │  ctx.on('agent/assistant-stream' | 'session/event' | 'approval/request')
   ▼
DSH Agent 循环（会话日志、工具、审批、模型路由都由 DSH 负责）
```

一次问答的完整过程：

1. 微信消息进入 `getupdates` 批次 → 去重、白名单校验、缓存 `context_token`；
2. 普通文本 → `agent.followup(createUserMessage(...))` 排入该会话的回合队列；
3. 回合运行期间监听 `agent/assistant-stream` 收集本轮文本，`session/event` 的 `tool/call` 推送进度；
4. 收到 `turn/end` → 取**最后一步**的助手文本（而不是中间过程）→ 按 `chunkChars` 分段 `sendmessage`；
5. 需要授权的工具调用由 `approval/request` 拦截 → 发微信 → 等回复 → 返回 `allowed-once` / `rejected` / `cancelled`；`ask_user_question` 同理；
6. 开启 `/listen` 时，没有微信消息在排队的回合（GUI 等客户端发起）也按 `turn/end` 推送到微信。

刻意的设计决定：

| 决定 | 原因 |
| --- | --- |
| **会话只有一处写入点**（用户原文 `followup`） | 回执、提示、欢迎语、失败通知、跟读全部单向出站，绝不污染模型上下文；有测试锁定 |
| **按回合号配对回复** | 同一个 session 可能被 GUI 一起喂，只有"微信发起的回合"走常规投递；跟读是显式 opt-in 的例外 |
| **零运行时依赖、无原生模块** | 安装不碰 node-gyp；peer 依赖会让 profile 安装卡范围校验，所以直接用 `ctx.get(key)` 取宿主服务 |
| **状态目录一切自理**（0600/0700 + 原子写 + 损坏留档） | 凭据与附件是敏感数据；Windows 上用重试兜住 `EPERM`/`EBUSY` |
| **副作用预算化** | 子进程只有一处且先校验、只绑回环、出站域名白名单、定时器必须 `unref`——`test/sideeffects.test.mjs` 让新增隐式副作用直接失败 |
| **能力随 preset 走** | DSH 的工具是**按 agent 挂载 preset** 得到的，插件在 `setup` 期 `mount`，创建与恢复都挂 |
| **不伪流式** | iLink 的机器人消息不能编辑（`GENERATING` 状态在普通会话不生效），所以用「正在输入 + 工具进度 + 最终分段」呈现 |

## 会话与队列语义

- **绑定**：`store.state.sessions[conversationKey] = sessionId`。`conversationKey` 形如 `p2p:<userId>`（群消息为 `group:<id>`，但当前直接忽略）。
- **独占**：一个 session 同时只属于一个会话键。`bindSession()` 在目标 session 已被别的会话占用时拒绝，并指出当前持有者。
- **回合队列**：每条微信消息入队 `createPendingTurn()`，串行等待自己的回合。队列头才有超时。
- **回合配对**：入队时记录 `blockedByTurn = 当时正在运行的回合号`（没有则 `null`）。`turn/start` 到达时：
  - `pending.turn === null` 且 `turn !== blockedByTurn` → 采纳为该消息的回合；
  - `turn === blockedByTurn` → 是别的客户端那一轮，不采纳（否则排队消息会"吃掉"别人的 `turn/end`，把别人的答案发到这里）。
- **turn/end 归属**：先按 `pending.turn === turn` 精确匹配；没有匹配项时才回退到"尚未开始的 pending"，且**不允许**回退命中 `blockedByTurn` 那一轮。
- **超时**：队列头超过 `turnTimeoutSeconds` → 标记 `abandoned`、停输入状态、发提示（提示里说明"回一句话或 `/listen` 即可继续接收"）。
- **复活**：该会话**再次收到消息**时，仍在运行（`turn !== null`）的 abandoned 条目会被清掉标记并重新计时；它的 `turn/end` 到达时正常投递。未再互动的 abandoned 条目在其 `turn/end` 到达时**丢弃**——避免这条迟到的结束事件被算到下一条排队消息头上。
- **丢弃**：`/new`、`/session` 切换、`/stop`、归档、插件卸载都会清队列，并同时清掉两类定时器（超时、输入保活）与 `#runningTurn`/`#followBuffers` 里的残留。

## 交互归属与竞速

审批（`approval/request`）与提问（`user-questions/request`）都是 cordis waterfall；插件以 `{ global: true, prepend: true }` 注册。

**归属判定** `isDrivingTurn(sessionId)`：该会话（或其 subagent 树的根）上存在 pending，且**当前正在运行的回合号等于该 pending 的回合号**。

- 不满足且未开跟读 → 直接 `next()`，交回原客户端（GUI 自己的对话框照旧弹）；
- 满足或开着跟读 → 进入**竞速**：

| 事件 | 动作 |
| --- | --- |
| 微信侧作答 | 先 `finish()` 结算本次 waterfall，再（50ms 后）向 `request.signal` 派发一次 `abort`，请另一端关框 |
| 另一端先答 | 微信收到「✅ 已在原来的客户端上回答，微信这边这张卡作废。」并释放回复槽 |
| 另一端**没有应答者** | 忽略：审批的 waterfall 末端返回 `'unavailable'`、提问的末端抛 `NO_PROVIDER`——两者都**不算决定**，微信的卡片继续有效 |
| 微信卡超时 | 只撤微信卡，把决策交回另一端（`finish()` 转发其 promise） |

**为什么 abort 必须"晚一步"**：宿主 `ApprovalService.decide()` 把瀑布结果与 `request.signal` 的 abort 做竞速，`onAbort` 会**同步**把请求结算成 `cancelled`。所以请求挂起时 abort = 把微信的"允许"变成拒绝（0.1.33 曾如此）；而宿主的 abort 监听在其答案结算后就被移除，此时再派发才只起"关框"作用。配置项 `closeRemoteDialogAfterAnswer: false` 可关闭该行为。

**多问题的两种回答方式**：一张卡片可以带多个问题。`onReply` 的顺序是 ① `取消/算了/不答了` → 交回原客户端（与超时同一路径；必须最先判断，否则单问题卡片会把"取消"当成自由回答吞掉）；② 整批解析：一条消息按题目顺序写完全部答案，分隔符依次尝试**换行 → 逗号/顿号 → 空格**（`answerFragments()`），每段必须命中该题选项；③ 逐条回答：回复作为"下一个未回答的问题"的答案，必须命中该题选项（无选项的问题接受文本），命中后回执"已记录第 N 个回答，还剩 M 个：<下一题>"，未答完时 `onReply` 返回 `'pending'`（`tryConsume` 据此保留记录）。**只答一部分（三个问题回两个）不做猜测**：整批解析返回 null、逐条也接不上，于是照常提示用户。

**答案解析**（`parseQuestionsReply`）：选项按**位置序号**（`2`、`2.`）、**标签精确匹配**、**标签前缀**（回复 `方案 A` 对应标签 `方案 A：…`，要求边界是标点而非空格）、**反向前缀**（回复 `方案 B：就这个`）与**独立短标记**（`B` 恰好出现在某一个标签里）依次尝试；整条回复先按整体匹配，因此**标签里的空格不会被切碎**。没命中任何规则就作为自由回答（`custom`）交给宿主——"我选方案 B"这种含选项名的整句因此仍是自由回答。多选按逗号/顿号切分，多问题要求一行一个。

**承诺的边界**：另一端不理会该信号时，它的框会留着（再点不改变结果）。这一点写进了 README 的行为表，不粉饰。

## 投递实现

- **分段**：`splitText(text, chunkChars)` 优先在语义边界（`\n\n`、`\n`、`。`、`；`、`. `、空格）切分，且不切开代理对；分片长度不超过 `limit`。
- **截断**：`maxAnswerChars`（默认 20000，`0` 关闭）之外的内容不发送，但提示写明「已省略 N 字」；同样做代理对保护。
- **发送**：每段一个 `clientId`（重试复用同一个 → 网关看到的是同一条消息，不是两条）。
- **上传**：`getuploadurl` 若返回 `upload_full_url` 则优先使用（参考实现的做法；大文件更像走这条）。超时预算 `uploadTimeoutMs()` 按密文体积放大——假设 ≥50KB/s，下限 120 秒、上限 15 分钟（33MB ≈ 12.7 分钟），可用 `media.uploadTimeoutMs` 覆盖；此前的固定 120 秒在慢上行上会中途放弃并报 `CDN upload timed out`。
- **退避重试**：仅瞬时错误 —— `ret=-2`/`-3`、网络错误（HTTP 4xx 除 408/429 外不重试；`ret=-14` 不重试）。退避阶梯 `sendRetryMs`（默认 0.5s/2s/5s/10s）。
- **二次补发**：整轮结束后，首轮失败且属瞬时错误的分段等待 `max(1s, chunkDelayMs*3)` 再补发一轮；两轮都失败才提示「有 N 段未能发出」，并把原因与相对时间写进 `/status` 的最近错误。
- **段间间隔** `chunkDelayMs`（默认 350ms）：降低撞上发送限流的概率。
- **输入状态**：回合开始 `sendtyping(START)`，每 `typingKeepaliveSeconds` 保活；投递结束后补一次 `STOP`（否则最后一条永远是 START，"正在输入"常驻）。
- **失败落盘**：文本投递在 `deliver()` 末尾 `saveState()`；文件投递绕过该路径，因此 `deliverFile()` 的失败分支现在也显式保存——否则那条错误只存在内存里，重启后 `/status` 就看不到了。
- **出站串行**：`#enqueueSend()` 为每个会话维护一条发送队列（与入站用的 `#chain` 分开——入站链内部会 `await deliver()`，共用一条链会自锁）。所有出站都经过它：回答分段、工具进度、`wechat_send_text`、`wechat_send_file`。`deliverFile(..., { caption })` 把说明与文件放进**同一个**排队任务，保证成对且连续。没有这条队列时，两次并发的发送会互相穿插（第二条的说明可能落在第一条分段中间）。
- **上下文窗口（实测）**：主动推送依赖最近一次入站消息带来的 `context_token`。实测有效期约 15–30 分钟——+15 分 29 秒发送成功，+30 分 39 秒起返回 `ret=-2 (prepare failed)`，收到新消息刷新后 15 秒即恢复。因此超时策略是"提示用户冒泡 + 复活"，而不是无限期等待。

## 跟读（`/listen`）

- 打开后，该会话的**绑定目标**成为跟读对象；`/session` 换绑即改跟读对象（`/mute` 关闭）。
- 触发时机：`turn/end` 且该会话**没有**微信 pending 时（有 pending 说明这一轮是微信自己的，走常规投递，避免两份）。
- 只推最终文本（同一回合内多条 `assistant/message` 会按序拼接；回合切换时重置缓冲），失败/无文本时推一句说明；**不加前缀**（一次只跟读一个会话，没有归属歧义）。
- 跟读开启时，该会话的交互也参与双端竞速（见上一节）。

## 平台侧限制（微信 iLink）

> **为什么没有心跳**：早期版本每 5 分钟发一行 `🔄 仍在处理中…`。有了"同一窗口 10 条"这条限制后，它变成了负收益——4 次心跳就吃掉 40% 的发送额度，反而挤掉真正的回复。0.1.49 起删除心跳，长任务进度用 `/status` 查（`/status` 既是命令、又顺带解锁窗口，且不花模型额度）。


参考实现（pan17/dsh-wechat）在其界面里明确列出两条**微信平台策略**，与我们的实测互相印证：

| 限制 | 表现 | 我们的处置 |
| --- | --- | --- |
| **同一窗口最多连发 10 条** | 第 10 条之后 `ret=-2 (prepare failed)`，**用户在微信回任意一句话即可解锁** | 单段退避重试（4 档）+ 整轮补发一轮；仍失败则回执"有 N 段未能发出"并写进 `/status` |
| 互动窗口（主动推送需近期有入站消息） | 超时后主动推送被拒，需用户先说话 | 超时提示请用户回一句话或 `/listen`，收到后"复活"该轮（见"会话与队列语义"） |
| 媒体大小 | **实测没有硬上限**（见下表） | 上传预算按体积放大（`uploadTimeoutMs`），慢速链路不再被固定 120 秒砍断 |
| 图片内容 | CDN **校验图片负载**：畸形/伪造的"图片"一律 `HTTP 500`（哪怕只有 5 KB），而结构正常的大图可通过 | 出站按扩展名判定为图片；若用户把非图片改名成 `.png`，会在上传后收到 500 |

**实测的媒体传输上限（2026-10-16，DSH 0.2.0-rc.2 / macOS）**

| 类型 | 实测结果 |
| --- | --- |
| 文件 30 MiB | ✅ 端到端送达（约 5–8 秒） |
| 文件 33.4 MiB（= 失败过的 APK 尺寸） | ✅ 端到端送达；协议层 26.7 秒 |
| 文件 51 MiB（越过社区"文件 50MB"默认） | ✅ 上传通过（98.9 秒 ≈ 0.5 MB/s） |
| 图片 20.9 MiB（越过社区"图片 20MB"默认） | ✅ 上传通过（26.0 秒） |
| 图片 3.5 MiB | ✅（6.1 秒） |
| 畸形图片（垃圾字节、巨型 `tEXt`） | ❌ `HTTP 500` |

社区里流传的 **图片 20 MB / 文件 50 MB / 语音 20 MB / 视频 100 MB** 来自各实现的**客户端默认值**（CLI-WeChat-Bridge 可用环境变量覆盖；`@huo15/com` 把 50 MB 称作"OpenClaw 标准媒体上限"），**不是平台强制**：我们的实测已经越过其中两条。参考实现（pan17/dsh-wechat）则完全不设大小上限、也不设上传超时。

**没有查到的**：任何官方发布的单文件上限（企业微信社区有一条同问，但页面为 JS 渲染、取不到答复）；文件 >51 MiB、视频与语音的上限未测。

⚠️ 我们曾把 `ret=-2` 归因于"上下文约 15–30 分钟过期"（实测：+15 分 29 秒成功、+30 分 39 秒起失败、用户发言后 15 秒恢复）。**这个结论可能被"10 条/窗口"混淆**：那段时间我们连续发了 9~10 条（跟读推送 + 测试）。两者都以"用户再发一条"解除，需要用「少量发送 + 长间隔」和「同刻连发 12 条」两个实验区分，尚未定论。

## 多 bot 架构

单实例、多 bot。改的是插件内部，profile 配置不需要多条目：

| 层 | 做法 |
| --- | --- |
| 凭据 | `credentials.json` v2：`{ version: 2, bots: { <botId>: { botToken, baseUrl, ownerUserId, source } } }`；旧单 bot 文件在加载时包成一只 |
| 状态 | `state.json` v2：`bots[<botId>] = { cursor, seenMessageIds, contextTokens, connected }`；顶层 v1 字段保留为迁移来源，迁移后清空。迁移前把原文件各复制一份 `*.v1-backup-<时间>`（0600），迁移后立即落盘——重写线上状态不该是不可逆的 |
| 会话键 | `p2p:<bot>:<user>` / `group:<bot>:<group>`（`withBot` 幂等）；旧键在迁移时一次性重写，`sessions`/`follow`/`pendingSwitch`/`models`/`reasoning`/`welcomed` 全部跟着换键 |
| 长轮询 | `WechatChannel` 每 bot 一个实例（`botId` 构造参数），各自的 client、cursor、去重窗口 |
| 投递 | 会话键 → bot → `bridge.#clientFor(bot)`；`contextToken` 按 bot 取，回复不会串号 |
| 登录 | 由插件编排（`startLogin`），一次一个；`/api/add` 触发，成功后 `startBot(credentials.botId)`，已有通道不受影响。每次尝试有独立 `AbortController` 与 **300 秒**上限（`loginTimeoutSeconds`）：超时/失败都会写入错误日志、把页面置为 `failed`，并释放「添加绑定」（否则卡片永远停在「添加中…」且 `/api/add` 一直 409） |
| 所有者 | 权限判断用**该会话所属 bot** 的 `ownerUserId`（`checkAccess` 的 per-bot 覆盖、`/status` 与欢迎语的 `isOwner`、`maySendTo` 的允许名单），配置里的 `ownerUserId` 仅作兜底；否则第二只 bot 由别人扫码时会被默认的 allowlist 拒掉 |
| 兼容 | store 的 `credentials`/`cursor`/`hasSeen`/`contextTokenFor` 在不传 bot 时回落到主 bot；未绑定任何 bot 时回落到 v1 顶层字段（测试与首次登录前状态） |

**验证（进程内，两个真实 HTTP 假网关）**：

- `test/multibot-plugin.test.mjs` ①：两只 bot 各自轮询自己的网关；同一个人分别发给两只，回复**各自从自己的网关发出并携带各自的 context_token**；`state.json` 里两条会话键 `p2p:<bot>:<user>` 指向**不同**的 DSH 会话；同一个 message id 再发给另一只时**仍被处理**（去重按 bot 而非全局）。
- ②：`POST /dsh-wechat/api/add` → 网关发码 → 确认 → 新 bot 与已有 bot **并存入同一凭据文件**，且原 bot 在整个登录过程中**持续轮询**（无需重启）。
- ③ `test/multibot.test.mjs`：v1 状态迁移（会话键、游标、令牌、去重窗口)、两 bot 状态隔离、移除一只不影响另一只、重载持久化。

**已知边界**：解绑某只 bot 后它的长轮询要等重启才停（通道是一次性实例）；`stats` 与最近错误是全局统计，不按 bot 分开。真机上"两只同时在线"尚待用第二个微信号验收。

## 客户端半边（设置页卡片）

插件声明 `dsh.client = { platform: 'web', inject: ['…client-ui-settings', '…client-ui-slots'] }` 与 `exports["./client"]`，由宿主的 client-modules 服务把 `lib/client.js` 作为浏览器模块下发（文件形如 `window.__ModuleLoader__.load({ id, factory })`，导出 `apply(ctx)`/`inject`）。

- `apply(ctx)` → `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'dsh-wechat', order:45, label:'微信' }, WechatSection))`；
- 组件只用 `react.createElement`（不引入 `@deepseek-ai` 运行时包，无构建步骤），每 4 秒轮询宿主接口渲染状态；
- **二维码内联绘制**：`GET /dsh-wechat/api/qr` 返回 `{ version, svg }`（与扫码页同一渲染器），卡片把这段 SVG 直接插入 DOM —— 不依赖 `<img>` 加载、样式表或主题，这才算“直接显示在插件上”；`/api/qr.svg` 保留给浏览器直接访问；
- 宿主侧在 GUI web server 的前缀路由里加了 `/dsh-wechat/api/{status,qr.svg,refresh}`：`status` 返回连接/阶段/`qrUrl`/`pageUrl`/版本/最近错误，`qr.svg` 复用扫码页同一套矩阵渲染，`refresh` 置 `loginPage.restartRequested` 让登录流换一张码；
- **边界**：这三个 API 不带令牌（回环地址信任），与同类微信插件一致；完整扫码页与 `/state.json` 仍要求一次性令牌。本地进程因此可以读到二维码——等于可以抢绑，这一点写进已知限制。

## 错误日志

`store.noteError()` 既更新 `/status` 用的 `stats.lastError`，也追加到 `state.errors`：

- **裁剪**：写入时按 `errorLogDays`（默认 30）丢弃过期条目，再按 `errorLogEntries`（默认 300）截断为最新 N 条；
- **合并**：与上一条内容相同且 60 秒内的，只更新时间并把 `count` 加一（重试阶梯会让同一错误连刷数次）；
- **页面**：`GET /dsh-wechat/errors?t=<令牌>` 由 `lib/errorspage.js` 服务端渲染（无客户端脚本，所有文本 HTML 转义），令牌与扫码页同源；
- **接口**：`GET /dsh-wechat/api/errors`（回环、无令牌）返回 `{ retentionDays, count, entries }`；
- **卡片**：不再渲染错误正文，只在 `errorCount > 0` 时显示「错误日志（N）」链接（`errorsUrl` 带令牌）；
- **命令**：`/errors` 打印最近 10 条（仅所有者）。

## 渲染

- **表格**（`renderTable()`）：`/status` 输出 **Markdown 表格**——微信会渲染它，所以不需要自己画框线，也**不需要按中文双宽补空格**（对齐由渲染器负责）。单元格里的 `|` 转义成 `\|`、换行折成空格，避免破坏表格结构；放不进单元格的长内容（最近错误原文）写在表格下方。
- **回答分段**：`normalizeAnswer()` 去 ANSI/控制字符、合并多余空行；`splitText()` 按语义边界切段且不切开代理对。
- **错误提示**（`explainFailure()`）：把网关代码翻译成下一步动作——`HTTP 500` + 图片 → 「内容可能不是有效图片，改按文件发送」；`ret=-2` → 「同一窗口最多 10 条，回一句话解锁」；`ret=-14` → 重新扫码；`CDN upload timed out` → 上行带宽与预算提示；`fetch failed` → 网络连通性。提示只在展示层拼一次（状态文件里存原始错误，否则 `/status` 会打两条互相矛盾的提示）。它同时用于 `/status` 的「最近错误」（早于本次启动的会标注**上次运行**）、发送失败通知（`⚠️ 有 N 段未能发出` + 💡 提示）与 `wechat_send_file` 的报错（模型据此决定是否改按文件重试）。
- **脱敏**：见"安全实现"。

## 状态与持久化

```
$DSH_HOME/integrations/dsh-wechat/
├── credentials.json     0600，bot_token 等凭据
├── state.json           0600，游标 / 会话绑定 / 去重表 / context_token / 跟读 / 统计 / 启动记录
├── login-qrcode.txt     最近一次登录二维码（终端字符画）
├── login-qrcode.svg     同一二维码的矢量图
├── login-page.url       当前扫码页地址（含一次性令牌）
└── media/<日期>/…       入站附件解密后的落盘位置
```

- **原子写**：`<file>.<pid>.<ts>.tmp` → `chmod 0600` → `rename` → 再 `chmod`；失败时删除临时文件（否则 `credentials.json.*.tmp` 会留下活令牌）。写入队列在**单实例内**串行。
- **损坏与不可读**：非法 JSON → 改名 `*.corrupt-<ts>` 后从空状态启动；**读取失败**（非 ENOENT）→ 改名 `*.unreadable-<ts>`，若连改名都失败则拒绝继续（不覆盖原文件）。
- **形状净化**：加载时把 `stats`/`sessions`/`follow`/`contextTokens`/`welcomed`/`pendingSwitch` 与各数组强制成期望类型——手工编辑出的 `"stats": null` 曾在收消息时抛错并杀掉轮询。
- **容量上限**：去重表 1000、`contextTokens` 200、`outbound` 200、`boots` 20；超出按时间淘汰。
- **启动记录**：每次启动写 `{version, pid, at}`，`/status` 用它对比"运行中的版本 vs 磁盘已装版本"。

已知取舍：**没有跨进程文件锁**——插件与 CLI 同时写 `state.json` 会互相覆盖（实际影响面：运行中执行 `dsh-wechat logout` 可能被插件的下一次保存覆盖）。

## 安全实现

- **发送边界**：`wechat_send_text` / `wechat_send_file` 只发往当前会话、所有者或白名单；状态目录内的文件一律拒发。鉴权用 `realpath` 比较，且上传用的是**已校验的那个解析路径**（避免"检查一个路径、读取另一个路径"）。
- **脱敏**：`redactSecrets`（递归，深度 12）+ `redactText`（显式模板替换）覆盖 `Bearer/Basic`、`*_TOKEN=`/`password:` 等赋值、JSON 形态（`"password": "…"`）、已知令牌前缀（`sk-`、`ghp_`、`github_pat_`、`AKIA`、`AIza`、`xox[baprs]`）、JWT、PEM 私钥**主体**，以及中文字段名（`密码`/`令牌`/`密钥`/`口令`）；值匹配到 JSON 标点即止，避免吞掉行内其它参数。
- **一次性令牌**：扫码页地址里的 `?t=<hex>` 是回环页与 `/state.json` 的唯一凭证 → `/login` 回复不含令牌（指向日志/文件），出站记录与日志里的 `t=…`、`/t/…/` 也会被替换。
- **网络**：所有请求 `redirect: 'error'`；登录返回的 API 基座与 CDN 地址强校验（非 http(s)、对公网降级到 http 一律拒绝）；下载带字节上限（声明值预检 + 流式累计，边下边判）。
- **超时与 abort**：请求的守卫覆盖到**响应体读完**（`fetch()` 返回只代表响应头到达；此前清理守卫会让 body 停滞把接收循环挂死）；调用前已 abort 的 signal 不再发出请求。
- **回环页**：只监听 `127.0.0.1`，一次性令牌用 `timingSafeEqual` 比较，未授权一律 403；插件不启动浏览器，只在日志与 `login-page.url` 里公布地址。

## iLink 协议要点（实现相关）

| 项 | 事实 |
| --- | --- |
| 长轮询 | `POST /ilink/bot/getupdates`，服务端给的 `longpolling_timeout_ms`（≈35s）+ 5s 宽限；游标 `get_updates_buf` 在处理完一批消息后才落盘（至少一次语义） |
| 鉴权 | `AuthorizationType: ilink_bot_token` + `Bearer <token>`，随机 `X-WECHAT-UIN`、`iLink-App-Id: bot`、`iLink-App-ClientVersion` |
| 回复上下文 | 每条出站消息必须带 `context_token`（来自该会话最近的入站消息），有效窗口实测约 15–30 分钟 |
| 错误码 | `ret=-14`/`errcode=-14` = 会话失效（清凭据重登）；`ret=-2 (prepare failed)` = 投递上下文过期（等用户先说话）；`-3` 视作瞬时 |
| 媒体 | 入站 CDN 下载 → AES-128-ECB 解密（兼容 `aeskey`(hex) 与 `media.aes_key`(base64(hex)) 两种编码）→ 落盘 `0600`；出站先 `getuploadurl` → AES-128-ECB 加密 → 上传 → `x-encrypted-param` 随 `sendmessage` 发出 |
| 群消息 | 信封里有 `group_id`，但没有可靠的回复路由 → 收到即忽略 |
| 消息不可编辑 | 机器人消息无法原地更新，故不做伪流式 |

## 与 DSH 的契约

插件只使用下列**已核对**的 DSH 0.2.0-rc.2 接口，全部通过字符串 key 获取，不 import 任何 `@deepseek-ai/*`：

| 使用点 | 依据 |
| --- | --- |
| `ctx.get(…)`：`agents`、`sessions`、`tools`、`workspaceRegistry`、`llm`、`agentDefaultModel`、`agentPresets`、`permissionPresets`、`sessionQuery`、`sessionTitle`、`webServer` | cordis 服务按 key 解析；缺失的服务一律降级而不是崩 |
| `agents.create({ sessionId, meta:{ cwd, agentPreset }, agentOptions, setup })` / `agents.resume({ resumeSessionId, agentOptions, setup })` | `CreateAgentOptions` / `ResumeAgentOptions` |
| `setup(agentCtx)` 里 `agentPresets.mount(agentCtx, id)` | 工具随 preset 挂载；创建与恢复都必须挂（`dsh-agent-loop` 自己不挂） |
| `permissionPresets.current(session)` / `.catalog()` / `.set(session, name)` | 会话权限预设（`/permission`）；`set` 是持久路径 |
| `agent.followup(userMessage)` / `agent.cancel({ kind:'user' })` / `agent.session.id` | `Agent` 接口 |
| `agent/assistant-stream` 的 `start/chunk/end` | `AssistantStreamFrame` |
| `session/event` 的 `turn/start`、`turn/end{reason}`、`tool/call{name,arguments}` | `SessionEventMap` |
| `approval/request`、`user-questions/request`（waterfall） | 注册方式 `{global:true, prepend:true}`；返回值分别为 `allowed-once/rejected/cancelled` 与 `{answers:[{id,selected,custom?}]}` |
| `agentCtx.systemPrompt.section({ name, order, text })` | `dsh-system-prompt` 的有序提示词注册表；通过 `agentCtx` 注册只作用于该 agent（顺序表见该包 `SECTION_ORDERS`，Web 渠道说明在 10100，我们排在 10150） |
| `ctx.tools.register({ name, description, parameters, output, execute })` | `ToolRuntime.register` |
| `ctx.effect` / `ctx.on` / `ctx.inject` | cordis 4.x |

**不声明 `peerDependencies` 是有意为之**：安装闸门只检查 `@deepseek-ai/dsh*` 的 peer 范围，而本插件不 import 它们，就不该被版本范围锁死。

**为什么有时要重启**：宿主对**配置**是热应用的（改 `cordis.patch.yml` 后插件被重新 `apply`，实测 `loginPage: false` 后扫码页端口约 1 秒关闭），但**已加载的模块不会被重新 import**——所以升级 tarball 后必须重启才能跑新代码。`hmr` 行默认 `root: []`（不监听源码），`dsh plugin add <tgz>` 是拷贝、`add <目录>`/`link:` 才指向源码目录（HMR 用 `realpathSync()` 匹配）。

## 渠道提示词

本插件创建的每个会话在 `setup` 期注册一段 agent 作用域的提示词（`dsh-wechat:channel`，order 10150，紧随宿主的 Web 渠道说明 10100）：

- 最终回答会被自动分段发送到微信 → 不要用 `wechat_send_text` 重复同样的内容；
- 交付文件/图片用 `wechat_send_file`（绝对路径）——只落盘用户在微信里看不到；
- 长内容先写成文件再发；微信界面窄，正文保持简短；
- 等待类进展可用 `wechat_send_text` 发一句；
- 用户可用 `/status`、`/stop`、`/session`，不必复述命令表。

设计要点：**通过 `agentCtx` 注册而非全局**，因此只影响本插件创建/恢复的会话；profile 未提供 `systemPrompt` 服务时静默跳过（不影响会话创建），注册失败只记一条警告。

## 测试与证据

```sh
npm test          # 251 个用例：单元 + 协议 + 桥接 + 交互时序 + 扫码页 + 真实 cordis 启动 + CLI + 副作用预算
```

| 测试文件 | 覆盖内容 |
| --- | --- |
| `test/qr.test.mjs` | 二维码编码器与 `qrcode`（devDependency，仅作校验基准）逐模块比对，含 1–271 字节全部长度；终端/SVG 渲染几何 |
| `test/ilink.test.mjs` | 对真实 HTTP 假网关跑完整协议：扫码登录、长轮询游标、请求头与信封、`sendmessage` 结构、输入状态、AES-128-ECB 上传/下载两种密钥编码、`ret=-14`、HTTP 与非 JSON 错误映射、响应体停滞超时、已 abort 的 signal 不发请求、解密失败落盘为 `<名称>.enc` |
| `test/bridge.test.mjs` | 消息 → 会话 → 回合 → 回复全链路、渠道提示词注册：会话复用/续聊、去重、回声丢弃、白名单、分段与截断、`aborted/error` 语义、工具进度、命令、`/new` `/stop`、输入状态、附件落盘、引用消息、审批与提问、主动发送、文件回传、限流二次补发、跟读（含去前缀）、超时与复活、回合归属 |
| `test/interactions.test.mjs` | 交互时序（毫秒级超时）：微信作答不触碰 `request.signal`、卡片过期后交给另一端而不挂起、发送失败仍能结算、自动关框的先后顺序、`closeRemoteDialogAfterAnswer: false` |
| `test/plugin.test.mjs` | 用真实 `@deepseek-ai/cordis` 启动插件，接真实 HTTP 假网关：监听到达、工具注册/注销、环境变量凭据、卸载后停止轮询；并跑通「无凭据 → 扫码页 → 二维码 → 确认 → 写凭据 → 收发」 |
| `test/sideeffects.test.mjs` | 副作用预算（**递归扫描、运行时与工具链分域**）：子进程只有一处且先校验、禁止 osascript/开机项/剪贴板/`process.exit`、唯一监听 Socket 绑回环、出站域名白名单、每个 `setInterval` 必须 `unref`、凭据与附件 0600/0700、写文件目标白名单、工具链只碰文档化的系统路径 |
| `test/loginpage.test.mjs` | 扫码页：一次性令牌鉴权（403）、二维码内嵌、状态机文案、登录后隐藏二维码、`state.json`、换码按钮、端口占用回退、`stop()` 释放端口 |
| `test/unit.test.mjs` | 配置归一化与校验（含 `[]`/`true`/NaN 拒绝）、访问策略、路径解析、状态持久化与去重上限、状态形状净化、脱敏用例、分段边界（含代理对）、命令解析、审批原因可读化、版本自证与重启任务形状 |
| `test/cli.test.mjs` | 真正 `spawn` CLI 进程：`login`（含 `--page`/`--no-open`/`--state-dir`）、`status`、`logout`、`send`、`qr` 的参数解析与退出码 |

开发依赖只有两个且都不参与运行时：`@deepseek-ai/cordis`（启动测试）、`qrcode`（二维码校验基准）。
**测试不产生真实副作用**：`openInBrowser` 接受注入的 `spawn`/`platform`，测试注入假实现并断言 argv；非 http(s) 输入在 `spawn` 之前即被拒绝（历史教训：`openInBrowser('')` 会打开当前目录，每个测试都弹访达窗口）。

**真机验证过的交互（一次全答）**：三问题卡片在 0.1.47 上用**一条消息**全部回答（`1 1 2` 空格分隔）——出站记录里**没有任何"已记录第 N 个回答"回执**（说明走的是整批解析而非逐条路径），宿主收到三个答案**全部为 `selected`**。

**真机验证过的交互（逐条回答）**：三问题卡片**逐条回答**——卡片 09:14:06 发出，09:15:01 回执「已记录第 1 个回答，还剩 2 个：<第 2 题>」，09:15:25 回执「已记录第 2 个回答，还剩 1 个：<第 3 题>」，第三次回答后整批提交；宿主收到三个答案**全部为 `selected`**（无一为 `custom`）。修复前同一场景：回复「1」会收到「回复『允许』或『拒绝』」的审批口吻提示，且逐条回答完全无效。

**真机验证过的大文件传输**：30 MiB（`transfer-30mb.bin`，11:41:48 记录）与 **33.4 MiB**（`transfer-33.4mb-apk-size.bin`，11:43:21 记录）均端到端送到微信；协议层探测 31 MiB = 25.3 秒、33.4 MiB = 26.7 秒，`getuploadurl` 对两者都正常返回且**不带 `upload_full_url`**。结论：该量级**不存在平台大小上限**；此前 33.4MB APK 在固定 120 秒预算下失败，是当时链路更慢（<0.28 MB/s）所致。

**真机验证过的通道**：微信收发闭环（macOS + DSH 0.2.0-rc.2 桌面端）；**出站文件**——图片（`image_item`）与文件（`file_item`）各一次，AES 加密 → CDN 上传 → `sendmessage` 全链路成功；双端竞速（GUI 先答 → 微信收到作废提示并自动关框）；审批「允许」真实放行。

**一次性 profile 证据**：`bash scripts/verify-profile-install.sh`（安装/组合/卸载）与 `bash scripts/verify-profile-boot.sh`（真实 host 启动、探活插件路由、卸载回基线）在临时 `DSH_HOME` 上运行（这两个脚本属仓库工具，不在发布包内），结果记录在 [profile-verification.md](profile-verification.md)。

## 平台兼容性

只在 macOS 上实跑过；下表区分"已实测"与"已审计未实测"：

| 维度 | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 运行状态 | ✅ 已实测（DSH 0.2.0-rc.2 桌面端，微信收发闭环） | ⚠️ 未实测，代码路径已审计 | ⚠️ 未实测，代码路径已审计 |
| 扫码页监听 | `127.0.0.1` | 同 | 同（回环绑定不触发防火墙弹窗） |
| 凭据/附件权限 | `0600`/`0700` 生效 | 生效 | `mode` 基本无效（Node 只映射只读位）；保护来自 `%USERPROFILE%` 目录 ACL |
| 状态原子写 | `rename` 覆盖 | 同 | 覆盖可能 `EPERM`/`EBUSY`（杀软/索引器）→ 内置退避重试，失败清理临时文件 |
| 终端二维码 | ✅ | ✅ 需 UTF-8 终端 | 旧 conhost 可能缺字形 → 用 `login --page` |
| 中断信号 | SIGINT/SIGTERM | 同 | 只有 SIGINT（Ctrl+C）有效，CLI 已按此处理 |
| 路径输入 | `~/proj` | 同 | `~\proj` 也支持；含空格路径可加引号：`/workspace "D:\My Projects\a"` |
| 附件文件名 | 原名 | 原名 | 保留设备名（`CON`/`NUL`/`COM0`/`COM1`/`LPT0`/`CONIN$`/`CONOUT$`…）加 `_`；结尾的点/空格去掉，`report.tmp.` 这类不当作"已有扩展名" |
| 依赖 | 零运行时依赖、无需编译 | 同 | 同（无 node-gyp 问题） |

跨平台判断抽成了可测纯函数（`expandHome`/`unquote`/`isInsideDirectory`/`withRetries`），并有测试在 macOS 上直接断言 Windows 语义（大小写不敏感、反斜杠分隔符、路径前缀逃逸）。换平台时先 `npm test`，再 `node bin/dsh-wechat.mjs login --page` 确认回环端口与扫码页可用。

## 已知限制

1. **只支持私聊**：群消息没有可靠的回复路由，收到即忽略。
2. **主动推送窗口约 15–30 分钟**（实测）：超时后需要该会话先有新消息；插件为此提供"提示 + 复活"机制，而不是无限期挂起。
3. **另一端的对话框**：被要求关闭时若对方不理会该信号，框会留着（再点不改变结果）。
4. **多进程写状态**：插件与 CLI 同时写 `state.json` 会互相覆盖（无跨进程锁）。
5. **重试幂等性**：发送重试复用同一 `clientId`，但网关是否按 `client_id` 去重无法从本仓库证实。
6. **Windows 的 `\\?\` 路径前缀**未处理（本机无法实测）。
7. **一键回滚**：DSH 没有跨版本的插件回滚操作，`dshOperations.rollback` 无证据可提供。
