# dsh-wechat

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接进微信：扫码绑定一次，之后在微信里派活、收结果、答审批。宿主侧 cordis 插件，零运行时依赖。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-blueviolet)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-1f6feb)](https://github.com/topics/dsh-plugin)

> **给 Agent 的摘要**：宿主侧 cordis 插件；`dsh plugin --profile <p> add <tgz>` 安装，`node bin/dsh-wechat.mjs login --page` 扫码绑定；绑定后微信即为一个 DSH 会话客户端（命令表见下）。改动前必读「行为契约」；排错看「故障排查」。实现细节在 [docs/design.md](docs/design.md)。

**文档地图**（本页 = 操作入口；实现细节在独立文档里）：

| 文档 | 内容 |
| --- | --- |
| **README.md**（本页） | 安装、命令、配置、行为契约、超时、排查——照做即可 |
| [docs/design.md](docs/design.md) | 架构、队列与竞速语义、投递实现、iLink 协议要点、与 DSH 的契约、平台兼容性 |
| [docs/side-effects.md](docs/side-effects.md) | 对系统的全部副作用（进程/端口/文件/定时器/网络出口）逐项清单 |
| [docs/profile-verification.md](docs/profile-verification.md) | 一次性 profile 的安装/组合/启动/卸载证据与结果 |
| [docs/login-page-preview.html](docs/login-page-preview.html) | 扫码页静态预览（二维码是占位内容） |

## 安装

```sh
# 1) 从 Releases 取 tarball：https://github.com/zgat/dsh-wechat/releases
dsh plugin --profile desktop add ./dsh-wechat-<版本>.tgz      # 例如 0.1.41
#    也可以走 GUI：设置 → 插件 → 安装，粘贴该 tgz 路径

# 2) 扫码绑定（生成二维码 + 本机回环扫码页）
node bin/dsh-wechat.mjs login --page

# 3) 在微信里给机器人发任意一句话，会收到上手引导（/help 看全部指令）
```

**前置条件**：DSH `0.2.0-rc.2`、Node ≥ 20、一个具备微信 ClawBot / iLink 机器人能力的微信号，且能访问 `https://ilinkai.weixin.qq.com` 与 `https://novac2c.cdn.weixin.qq.com`。

**桌面端注意**：`dsh plugin` 会转发给桌面端的 Electron 二进制，App 正忙时可能被中断（实测 `script execution has been terminated`，退出码 254）。稳妥做法是 `node scripts/upgrade.mjs --via-cli`（失败自动回退到内置 pnpm），或先完全退出桌面端。

**无人值守**（环境变量优先于凭据文件，不落盘）：

```sh
export DSH_WECHAT_BOT_TOKEN=ilinkbot_xxx
export DSH_WECHAT_BASE_URL=https://ilinkai.weixin.qq.com   # 可选
export DSH_WECHAT_BOT_ID=xxx@im.bot                        # 可选
export DSH_WECHAT_USER_ID=xxx@im.wechat                    # 可选：指定所有者
```

不给 `DSH_WECHAT_USER_ID` 时这条凭据没有所有者 → **所有被允许的联系人都视同所有者**；无人值守部署请显式指定或收紧白名单。

## 验证与升级

```sh
node scripts/upgrade.mjs --check      # 工作区构建版本 / profile 已装版本 / 运行中的版本
```

微信里发 `/status`：连接、bot、会话、工作区、模型、预设、权限、跟读、队列、统计、最近错误（含相对时间），以及**运行中的版本 vs 磁盘已装版本**。两者不一致 = 需要重启。

**配置改动热生效；升级已加载插件的代码需要重启**（原因见 [docs/design.md](docs/design.md#与-dsh-的契约)）：

```sh
node scripts/upgrade.mjs --via-cli --restart     # 装完自动重启（默认不重启）
./scripts/restart-dsh.sh --delay 10              # 手动重启（带护栏与验证）
node scripts/schedule-restart.mjs --cancel       # 取消已排程的重启
dsh --profile <profile> --dump-config | grep -A3 dsh-wechat   # 不启动时自检
```

## 能力速览

| 能力 | 说明 |
| --- | --- |
| 扫码绑定 | iLink/ClawBot 协议；凭据本机保存（`0600`），无需 appid/secret |
| 收发消息 | 长轮询收私聊；回复自动分段（默认 1800 字/段），失败退避重试 + 整轮后补发 |
| 会话映射 | 一个微信会话 ↔ 一个 DSH 会话，持久化绑定，重启后自动 `resume` |
| 斜杠命令 | 切会话/工作区/模型/权限、看状态、停止回合（见下方命令表） |
| 审批与提问 | `approval/request`、`user-questions/request` 转发到微信；回「允许/拒绝/取消」或选项序号 |
| 跟读 `/listen` | 其它客户端（GUI 等）在同一会话跑完的结果推到这里；该会话的审批/提问两端都能答 |
| 图片 / 文件 | 入站图片/文件/语音/视频解密落盘并把路径交给 Agent；Agent 可用工具把产物发回 |
| 模型工具 | `wechat_send_text`、`wechat_send_file`、`wechat_chat_info` |
| 访问控制 | 默认白名单 + 所有者模型；非所有者不能改权限、不能清凭据 |
| 长任务可见 | 「对方正在输入」+ 工具进度行（`progress: brief`）；**没有心跳**——微信同一窗口最多连发 10 条，心跳会跟真正的回复抢额度，长任务用 `/status` 查进度 |
| 渠道提示词 | 自动告诉模型「这个会话在微信里」：最终回答会自动送达、交付文件用 `wechat_send_file`、长内容先落盘再发——避免它把产物只写到磁盘上（只注入本插件创建的会话） |
| 断线自愈 | 长轮询退避重试且不丢游标；`ret=-14` 自动清凭据并重新扫码；登录失败 60 秒重试 |

## 微信里的命令

| 命令 | 作用 |
| --- | --- |
| `/help`（`/帮助`、`/?`） | 显示帮助 |
| `/new`（`/新会话`、`/reset`） | 结束当前会话，下一条消息开启新会话（工作区/模型设置保留） |
| 🔒 `/permission [模式]`（`/权限`、`/perm`） | 查看/切换**本对话**的权限模式：`read-only` / `workspace-write`（默认）/ `danger-full-access`（需 `/permission danger-full-access confirm` 二次确认）；仅所有者可切换 |
| `/session [序号\|会话 ID]`（`/会话`、`/对话`） | 列出当前工作区的对话（**标题与 DSH 界面一致**，附时间/「运行中」/「←当前」）并切换；切换后询问是否把最近 N 段回执到微信（回 0-99，不回＝不回执）；子会话与已归档对话不列出；`/session new` 等价 `/new`，`/session sources` 打印来源诊断 |
| `/stop`（`/停止`） | 停止正在运行的回合；连排队消息一起丢弃并告知条数 |
| `/status`（`/状态`） | **Markdown 表格**（微信直接渲染）：连接/bot、微信会话、DSH 会话、工作区、模型、预设、权限、跟读、回合与待答交互、收发统计、版本；放不进单元格的长内容（最近错误原文）在表格下方 |
| `/whoami`（`/我是谁`） | 你的微信 ID、会话键、DSH 会话 ID |
| `/workspace [序号\|名称\|路径]`（`/工作区`、`/项目`） | 列出项目目录（标题优先）并切换；**切换即结束当前会话** |
| `/workspace add <路径> [名称]` | 把目录登记为 DSH 工作区（GUI 里也会出现）并切过去 |
| `/model [序号\|provider/model]`（`/模型`） | 列出/选择模型（对下一个新会话生效） |
| `/reasoning [序号\|档位]`（`/思考`、`/effort`） | 列出/选择思考深度（对下一个新会话生效） |
| `/settings`（`/设置`） | 汇总当前会话的工作区、模型、思考深度 |
| `/login`（`/登录`） | 重新扫码登录的方法（**不含一次性令牌**；令牌见日志或状态目录的 `login-page.url`） |
| `/listen`（`/接收`、`/订阅`、`/follow`） | 开始跟读：其它客户端跑完的回合推到这里（**直接发正文，无前缀**），且该会话的审批/提问两端都能答；未绑定时先建好会话 |
| `/mute`（`/停止接收`、`/免打扰`、`/unfollow`） | 关闭跟读（不影响你自己回合的回复与审批/提问） |
| 🔒 `/logout`（`/退出登录`） | 清除本机凭据（会停止收发）；仅所有者可用 |
| `/ping` | 连通性检查 |

🔒 = 仅所有者可用。命令在进入 Agent 之前被处理，**不消耗模型额度**。

**回答提问/审批时**：选项可以用**序号**（`2`）或**选项文字**（`方案 B`、`B`）回答；单个问题时也可以直接回复自己的答案（"方案 A 太贵了"会被当作自由回答而不是选项）。
**一次问多个问题时**（一张卡片多题）有两种回答方式：
- **一次全答**：一条消息里按题目顺序写完全部答案，分隔符支持**换行、逗号、空格**三种——`1\n2\n2`、`1, 2, 2`、`1 2 2` 等价（也可用选项文字）；
- **逐条回答**：一条消息答一题，机器人回执「已记录第 N 个回答，还剩 M 个：<下一题>」，答完最后一题即提交。

**注意**：多问题卡片里，只答了其中一部分（例如三个问题只回两个）**不会被猜测**——会提示你还有题没答；逐条回答只接受**选项**（序号或选项文字），不相干的普通消息照常发给 Agent。
**序号必须带命令**（`/model 2`、`/workspace 2`）；裸数字是"回执段数"的回答。

### 谁能用：所有者与白名单

- **所有者 = 用微信扫码绑定的那个账号**（启动时从凭据采纳为 `ownerUserId`）；也可显式指定配置项 `ownerUserId`，或用环境变量凭据时给出 `DSH_WECHAT_USER_ID`。
- **白名单成员**（`allowedUserIds`）能正常对话和用绝大多数命令，但**不能**切权限、不能清凭据（表中标 🔒）。
- **既未扫码、也未指定所有者**时 `ownerUserId` 为空 → 所有被允许者都视同所有者（⚠️ 这种部署请自行收紧）。
- 设计理由：多人共用一个机器人时，任何一个被允许者都不该能把会话放宽到 `danger-full-access`（不限制文件 + 不再询问审批），也不该能清掉登录凭据。

## Agent 可用的工具

| 工具 | 用途 |
| --- | --- |
| `wechat_send_text` | 往当前微信会话发一条文本（阶段性进展、提醒） |
| `wechat_send_file` | 把本地文件作为微信图片/文件发回（按扩展名判断图片，AES 加密 + CDN 上传） |
| `wechat_chat_info` | 查询当前会话/DSH 会话/工作区/模型/运行状态 |

最终回答由插件自动回传，**模型不需要也不应该重复发送**。

## 配置项

写在 profile 的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（**patch 会整体替换 `config`，请写全要保留的键**）：

```yaml
- id: dsh-wechat
  name: 'dsh-wechat'
  config:
    enabled: true
    accessPolicy: allowlist
    allowedUserIds: ['oABC123example@im.wechat']
    workspace: /Users/me/projects/demo
    progress: brief
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时插件完全不动（不注册监听、不连网） |
| `stateDir` | `$DSH_HOME/integrations/dsh-wechat` | 凭据、状态、媒体、二维码的存放目录 |
| `workspace` | 第一个 DSH 工作区，否则 `process.cwd()` | 新会话的工作目录（绝对路径） |
| `accessPolicy` | `allowlist` | `allowlist` 只服务白名单；`open` 接受任何发送者 |
| `allowedUserIds` | `[]` | 允许的微信用户 ID（也接受逗号分隔字符串） |
| `ownerUserId` | `null` | 所有者，始终放行；留空时自动采用扫码绑定的微信号 |
| `autoLogin` | `true` | 无凭据时自动走扫码登录 |
| `loginPage` | `true` | 是否启动本机扫码页（关闭后二维码只进日志与文件） |
| `loginPagePort` | `30989` | 扫码页端口；被占用时自动改用系统分配的端口（`0` = 总是系统分配） |
| `openLoginPage` | `true` | 需要扫码时是否自动用默认浏览器打开扫码页 |
| `baseUrl` | `null` | 覆盖 iLink 网关地址（默认 `https://ilinkai.weixin.qq.com`） |
| `cdnBaseUrl` | `null` | 覆盖媒体 CDN 地址 |
| `chunkChars` | `1800` | 单条微信消息的最大字符数 |
| `maxAnswerChars` | `20000` | 一轮回答最多推送多少字（超出以「已省略 N 字」标注）；`0` = 不截断 |
| `chunkDelayMs` | `350` | 段与段之间的间隔，降低撞上发送限流的概率 |
| `sendRetryMs` | `[500, 2000, 5000, 10000]` | 单段失败的重试退避（仅瞬时错误；`ret=-14` 不重试）；整轮结束后仍失败的分段会**再补发一轮** |
| `typing` | `true` | 是否显示「对方正在输入」 |
| `typingKeepaliveSeconds` | `5` | 输入状态保活间隔 |
| `progress` | `brief` | `off` 只回最终答案；`brief` 加工具进度；`verbose` 再加中间说明 |
| `showToolProgress` | `true` | `progress != off` 时是否推送 `🔧 tool` 行（关掉只影响通知，不影响工具可用） |
| `turnTimeoutSeconds` | `900` | 单轮最长等待；超时后发提示（回合继续在后台跑），提示会请用户回一句话或发 `/listen`（见「超时与节奏」） |
| `approvalTimeoutSeconds` | `300` | 审批卡有效期；超时把决策交回另一端 |
| `questionsTimeoutSeconds` | `600` | 提问卡有效期；超时同上 |
| `idleDisposeMinutes` | `0` | 安静这么多分钟后释放常驻 Agent（绑定保留，下条消息自动 resume）；`0` = 常驻，可写小数 |
| `agentPreset` | `null` | 会话挂载的 agent preset；留空采用 DSH 默认（`standard`，含 `tool-bash`/`tool-fs`/`tool-fs-search`/`plan-mode` 等）。未挂载时微信里的 Agent 只有 `wechat_*` 工具 |
| `model` | `null` | `provider/model` 或 `{ provider, model, reasoningEffort?, maxTokens? }`；留空采用 DSH 默认模型（必须能解析出路由） |
| `media.enabled` | `true` | 是否收发图片/文件 |
| `media.dir` | `stateDir/media` | 入站附件落盘目录 |
| `media.maxInboundBytes` | `20971520` | 入站媒体上限，超出直接拒绝 |
| `media.maxOutboundBytes` | `52428800` | 出站文件上限。**注意**：微信侧还有自己的单文件上限，超限的上传会在 CDN 上挂住而不是立刻报错；大文件建议压缩或改用链接 |
| `media.uploadTimeoutMs` | `0` | 上传超时预算；`0` = 按体积自动（假设 ≥50KB/s，下限 120 秒、上限 15 分钟）。33MB 约 12.7 分钟；上行慢就调大 |
| `notifyLifecycle` | `false` | 是否发送 `msg/notifystart\|notifystop`（非公开协议，失败忽略） |
| `routeTag` | `null` | `SKRouteTag` 路由标签，仅部署方需要时填写 |
| `channelVersion` | `1.0.0` | `base_info.channel_version` |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |

配置非法时插件在日志里明确报错并回退默认值，不会让整个 profile 起不来。
想让 Agent 照常调用工具、但不把调用记录发到微信：`progress: brief` + `showToolProgress: false`。

## 行为契约（改动前必读）

1. **只回微信发起的回合**：按回合号配对，GUI 里跑的回合不会推到这个聊天（`/listen` 是显式例外）。
2. **绑定独占**：一个 DSH 会话同一时刻只属于一个微信会话，反之亦然；第二个会话要切进来会被明确拒绝（提示当前持有者，让它 `/session new` 释放）。
3. **回答提问与审批**：选项接受序号、选项文字或其前缀（`2` / `方案 B` / `B`）；单问题时含选项名的整句保持为**自由回答**。多问题卡片支持"一行一个 / 一行连写 / 逐条回答"三种方式，逐条回答时每条必须命中选项（避免把闲聊吞成答案），部分回答会回执"还剩 N 个"；`取消` = 不在微信答、交回原客户端。审批卡与提问卡的提示文案各自正确（不会互相串）。
4. **交互归属**：审批/提问只发给"此刻正在跑的那一轮"的发起方。微信发起的回合**两端都能答**（微信 + GUI，先答先算，另一端收到"已作废"并自动关框）；GUI/后台发起的回合默认不打扰微信，开 `/listen` 才双端；另一端**没有应答者**时不影响微信这张卡。
5. **上下文窗口约 15–30 分钟**：微信只能回复"最近说过话"的会话。超时提示后，用户回一句话（或 `/listen`）即可让那一轮**复活**，跑完的答案补发到微信；未再互动的回合按旧规则丢弃迟到的 `turn/end`。
6. **发送单向**：回执、切换确认、欢迎语、失败提示、跟读结果都只走"发往微信"的通道，**不进入模型上下文**；唯一进入会话的是用户消息原文（以及附件的落盘路径说明）。
7. **命令不消耗模型额度**：斜杠命令在进入 Agent 之前处理；`/session` 切换只重绑会话，不新建也不截断历史。
8. **群聊不支持**：iLink 的群消息没有可靠的回复路由，收到即忽略（debug 日志记一条）。
9. **多联系人相互独立**：每个微信联系人各自独立的会话与上下文。
10. **出站按会话串行**：同一会话的发送（回答分段、工具进度、`wechat_send_text`、`wechat_send_file` 及其说明文字）排成一条队列，**不会交错**；"说明 + 文件"作为一次排队发送，中间不会插进别的消息。
11. **渠道提示词**：本插件创建的会话会注入一段「微信渠道」说明（`dsh-wechat:channel`，order 10150），告诉模型回答会自动送达、交付文件用 `wechat_send_file`；GUI 自己开的会话不受影响。

## 超时与节奏（默认值速查）

| 项 | 默认 | 行为 |
| --- | --- | --- |
| 单轮等待 | 900s（15 分钟） | 超时发提示（回合继续跑）；用户回话即"复活"，答案随后补发 |
| 平台发送额度 | 同一窗口 10 条 | 超出被拒（`ret=-2`）；**用户在微信发任意一句话即可解锁**（`/status` 最划算：解锁 + 拿到状态，且不花模型额度） |
| 审批卡 | 300s（5 分钟） | 超时只撤微信卡，决策权交回另一端 |
| 提问卡 | 600s（10 分钟） | 同上 |
| 上下文窗口 | 约 15–30 分钟 | 到期后主动推送报 `ret=-2 (prepare failed)`；需该会话先有新消息 |
| 工具进度 | 每轮 12 条 | 之后提示"后续进度不再逐条推送" |

## 权限、外部依赖与失败边界

按 [DSH STORE 的上架契约](https://github.com/AI-Scarlett/DSH-Store/blob/main/registry/README.md) 披露。**本插件是宿主侧插件，以 DSH 进程权限运行**——安装前请据此评估。

| 能力 | 用在哪里 | 范围与限制 |
| --- | --- | --- |
| **文件** | 状态目录 `$DSH_HOME/integrations/dsh-wechat`（凭据/游标/绑定/启动记录，`0600`，目录 `0700`）、媒体目录（默认其下 `media/`，入站附件 `0600`）、扫码页的二维码与 URL 文件 | 不写工作区、不写系统目录（`LaunchAgents`/`crontab`/`systemd` 一律不碰）；写入原子化并带瞬时错误重试 |
| **网络** | 出站长轮询与发消息（默认 `https://ilinkai.weixin.qq.com`）、附件上传下载（默认 `https://novac2c.cdn.weixin.qq.com/c2c`）、回环扫码页（`127.0.0.1:30989`，可关） | 目标可用配置覆盖但强校验（公网强制 https）；所有请求 `redirect:'error'`；**无遥测、无第三方端点**（由 `test/sideeffects.test.mjs` 出站白名单强制） |
| **命令/子进程** | 仅一处：扫码登录时用系统启动器打开浏览器（macOS `open` / Linux `xdg-open` / Windows `cmd /c start`） | 非 http(s) 输入在 `spawn` 之前即被拒绝；可注入（测试不产生真实进程）；`openLoginPage: false` 可整体关闭 |
| **凭据** | 读取并保存机器人令牌（`credentials.json`，`0600`；也可由环境变量提供，此时不落盘）；日志与工具进度双重脱敏 | 不读取系统钥匙串、不读取无关环境变量；`/logout` 仅所有者可用，并清除读取失败留下的副本 |
| **原生制品** | 无 | 零运行时依赖、无原生模块，安装不触发编译 |
| **受保护的 DSH 行为** | 不修改、不遮蔽、不重复安装任何 `@deepseek-ai/*` 组件 | 只通过 `ctx.get(key)` 使用宿主服务，入口 ID 唯一 |

**外部服务**：微信 iLink 网关（必需）、媒体 CDN（仅收发附件时）。二者非本仓库所有，可用性取决于腾讯侧。

**权限等级自评：`high`**（触及凭据、任意网络、会话持久状态与子进程）→ 不满足 STORE 的自动低风险通道，预期 `user-reviewed` / `blocked`，由使用者逐次审阅安装。

**失败边界**：网络失败退避重试且不丢游标；`ret=-14` 自动清凭据重登；分段发送失败只丢那一段并明确告知（先退避重试，再整轮补发）；`state.json` 损坏或读不出时改名留档、从空状态启动；插件异常不阻断 DSH——停用或卸载即恢复原状（明细见 [docs/side-effects.md](docs/side-effects.md)）。

**一次性 Profile 证据**：安装 / 组合 / 启动 / 卸载的可复现验证记录见 [docs/profile-verification.md](docs/profile-verification.md)（临时 `DSH_HOME` + 系统分配端口，不碰真实 profile）。

**兼容性**：DSH `0.2.0-rc.2`（端到端实测；`0.2.0-rc.1`、`0.2.1-alpha.1` 未验证）、Node ≥ 20、profile `desktop` 实测（其它 profile 只要提供 `agents`/`sessions` 服务即可运行）、macOS 实测 / Linux 与 Windows 路径已审计。

**DSH STORE 状态**（2026-10-12 复检）：条目已同步到本仓库提交并确认 **DSH 兼容声明生效**（`0.2.0-rc.2: compatible`）；状态仍为 `blocked`，剩余原因**只有五类权限信号**（files / network / commands / credentials / nativeOrExecutableArtifacts）——即上表所述固有能力，因此请求按 `user-reviewed` 如实呈现（见 [DSH-Store#1321](https://github.com/AI-Scarlett/DSH-Store/issues/1321)）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 日志只有 `尚未绑定微信机器人` | 没有凭据：`node bin/dsh-wechat.mjs login --page` |
| 看不到二维码 | ① 日志里的扫码地址；② `cat ~/.dsh/integrations/dsh-wechat/login-page.url`；③ 打开状态目录的 `login-qrcode.svg` |
| 扫码页打不开 / 端口被占 | 配 `loginPagePort`，或设 `loginPagePort: 0` 让系统分配（日志打印实际地址） |
| 浏览器没自动弹出 | `openLoginPage: false` 或主机无图形界面；手动打开日志地址 |
| 反复 `接收消息失败（第 N 次）` | 网络到不了 `ilinkai.weixin.qq.com`：`curl -I https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` 验证 |
| `微信会话已过期（ret=-14）` | 插件会清凭据并重新扫码；也可先 `logout` 再 `login` |
| `no context_token cached` / 主动推送报 `ret=-2 (prepare failed)` | 距该会话最后发言超过约 15–30 分钟：让对方先发一条消息即可恢复 |
| 长回答丢段 / 「有 N 段未能发出」 | 微信平台限制：**同一窗口最多连发 10 条**，超出的会被拒（`ret=-2 prepare failed`），**在微信里回任意一句话即可解锁**（推荐 `/status`：顺带看状态、不花额度）；插件已退避重试 + 整轮补发，仍失败会告警。看 `/status` 最近错误原文 |
| 大文件发送失败（`CDN upload timed out`） | 客户端按体积给了预算（33MB ≈ 12.7 分钟），若仍超时说明上行太慢或**撞上微信单文件上限**（超限时 CDN 会挂住而不是报错）；压缩/分卷，或用 `media.uploadTimeoutMs` 调大预算 |
| 长任务很久没动静 | 微信发任意一句话（或 `/listen`）让那一轮复活；`/status` 看队列与运行状态 |
| 审批/提问在微信没出现 | 该轮不是微信发起的（默认不打扰）；开 `/listen`，或直接在 GUI 回答 |
| 审批框「允许」没生效（≤0.1.33） | 0.1.34+ 已修（请求挂起时不再 abort 宿主信号）；`/status` 确认运行版本 |
| `/session` 显示 `[object Object]` | 0.1.15 已修（标题快照对象经 `titleText()` 取文本）；版本过旧则升级 |
| `/session` 里显示"未命名对话" | 该会话还没有 `session/title` 事件；`/session sources` 看来源诊断 |
| 微信里的 Agent 说"没有跑命令的工具" | 会话未挂 agent preset（0.1.13 起自动挂载）；`/status` 看「预设」；**旧会话需 `/new`** |
| 收到的图片打不开 | 检查 `media.maxInboundBytes`；日志 `inbound media decryption failed` 表示发送端密钥编码非标准——原文会以 `<名称>.enc` 落盘并标注不可读 |
| 回复是「回合被拦截」 | 会话被 DSH 归档：0.1.6 起微信侧自动改开新会话；否则按提示 `/new` |
| 想继续某个旧对话 | `/session` 列出选择；被归档的对话会提示先取消归档 |
| 微信里出现 `⛔ 发送者 … 不在白名单内` | 把该 ID 加进 `allowedUserIds` 或设为 `ownerUserId` |
| 插件完全没加载 | `dsh --profile <name> --dump-config` 确认 patch 行存在；本插件不声明 `peerDependencies`，不会被版本闸门拦下 |
| 升级后行为没变 | 已加载的代码不会热替换：`node scripts/upgrade.mjs --check` 看版本差异，然后重启 |

`logLevel: debug` 可看到长轮询、去重、回合收集与竞速细节；日志都带 `[dsh-wechat]` / `[dsh-wechat:channel]` 等前缀。

## 安全默认

- 凭据/状态/附件 `0600`、目录 `0700`；写入「临时文件 + rename」原子替换，写失败清理临时文件，`/logout` 连读取失败留下的副本一并清除；
- 发送边界：只发往当前会话/所有者/白名单；**状态目录内的文件（含凭据）拒绝发送**；
- 日志与工具进度行脱敏：`Bearer …`、`sk-…`/`github_pat_…`/`AKIA…`/`AIza…`、JWT、PEM 私钥块、`token=…` 与中文字段名（`密码`/`令牌`…）；
- 网络：所有请求禁止跟随重定向；登录返回的 API 基座与 CDN 地址强校验（公网强制 https）；
- 扫码页只监听 `127.0.0.1` 且带一次性令牌；该令牌不会进入聊天与出站记录。

完整清单见 [docs/side-effects.md](docs/side-effects.md)。

## 平台支持

macOS 已实测（DSH 0.2.0-rc.2 桌面端，微信收发闭环）；Linux / Windows 代码路径已审计但**未实测**。零运行时依赖、无原生模块、无需编译。平台细节（打开浏览器的分支、权限位差异、Windows 保留设备名与结尾点、原子写的退避重试、终端二维码字形）见 [docs/design.md](docs/design.md#平台兼容性)。

## 合规提醒

通过腾讯 iLink / ClawBot 官方扫码绑定路径接入微信，但仍需遵守微信与腾讯的相关协议：不要用于群发营销、批量加好友等违规用途；账号能否使用该能力由平台决定。

## 许可

MIT
