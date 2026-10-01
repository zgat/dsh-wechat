# dsh-wechat

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接进微信：扫码绑定一次，之后直接在微信里给 Agent 派活、收结果、回审批。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-blueviolet)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-1f6feb)](https://github.com/topics/dsh-plugin)

**GitHub 话题**：[`dsh-plugin`](https://github.com/topics/dsh-plugin)（DSH 插件生态索引抓取的话题）、[`deepseek-harness`](https://github.com/topics/deepseek-harness)。

## 这是什么

一个**宿主侧（host）cordis 插件**：在 DSH 里挂上它，用微信扫码绑定机器人，就能把手机变成 DSH 的遥控器——派任务、看进度、答审批、收文件。它不是"微信客服机器人"，而是把微信当作 **DSH 会话的一个客户端**。

适用场景：离开电脑时让 Agent 继续干活并验收；在外面用一句话让它查日志、跑测试、改配置；需要确认危险操作时在微信里点"允许"。

## 功能特性

**会话与治理**
- 扫码绑定（iLink/ClawBot 协议）；机器人不能主动发起会话，因此**第一条消息即引导**，并自动把扫码者设成所有者
- 每个微信联系人绑定**独立** DSH 会话；一个 session 同时只属于一个微信会话，反之亦然（防止两个聊天互相串台）
- `/session` 列出当前工作区的对话：显示 **DSH 界面里的同一份标题**（会话日志的 `session/title`），标注「←当前 / 运行中」，子会话与已归档对话不列出；切换后可选**回执最近 N 段到微信**（0-99，单向，不注入模型）
- `/workspace` 把"项目"讲清楚：DSH 里工作区就是项目目录，可列举、按序号/标题/路径切换、`/workspace add` 登记新目录
- `/new` 开新对话、`/stop` 停止并丢弃排队、`/status` 查看连接/会话/工作区/模型/预设/队列/版本

**交互**
- 每条微信消息 = 一个 DSH 回合；回复自动分段（默认 1800 字/段）、失败只丢那一段、并提示有几段没发出
- 「正在输入」保活、引用消息、双向附件（图片/文件：解密下载落盘 → 路径交给 Agent；Agent 也能发文件回来）
- **审批与提问转发**：`🔐 需要你确认` / `❓ Agent 需要你的回答`，回复「允许/拒绝/取消」或选项序号、也可自由文本；**子会话（subagent）发起的也能回答**；无法识别时提示一次；超时自动交给下一个回答者（GUI）
- 指令含中文别名：`/帮助 /新会话 /会话 /工作区 /模型 /思考 /设置 /停止 /状态`

**Agent 能力**
- 自动挂载部署默认 **agent preset**（`standard`：`tool-bash`、`tool-fs`、`tool-fs-search`、`plan-mode`…）——这是"微信里的 Agent 有手"的关键；未挂载时它只能用插件自己的工具
- 插件自带工具：`wechat_send_text` / `wechat_send_file` / `wechat_chat_info`，Agent 可主动发消息、回传文件

**安全与可观测**
- 白名单 + 所有者模型；凭据/状态/附件 `0600`、目录 `0700`；日志与工具参数双重脱敏
- 发送边界：只允许发给当前会话/所有者/白名单，拒绝状态目录内文件（含软链绕过）
- 只监听回环（扫码页 `127.0.0.1:30989`，可选、一次性令牌）；所有请求 `redirect:'error'`；网关与 CDN 地址强校验
- `/status` 同时给出**运行中的版本**与**磁盘已装版本**（不一致会提示重启）；`/session sources` 打印会话来源诊断；每次启动写 `boots` 记录
- 命令行：`dsh-wechat login|status|logout|send|qr`；仓库脚本：`upgrade.mjs`（打包/安装/校验）、`restart-dsh.sh`（带护栏与验证的重启）

## 设计与实现

```
iLink 网关 ──HTTP──> channel.js ──> bridge.js ──> agents/sessions (DSH)
   ▲                    │              │
   └── 长轮询/游标 ──────┘              ├─ 会话绑定表、回合队列、超时、空闲回收
   ▲                                   ├─ 投递：分段、重试、进度、附件
   └── 出站消息 <── deliver() <────────┘
审批/提问瀑布 <── approval.js（认领回复槽 → 解析「允许/拒绝/序号」）
指令 ──────────> commands.js（/session /workspace /model …）
```

几条刻意的设计决定：

| 决定 | 原因 |
| --- | --- |
| **会话只有一处写入点**（用户原文 `followup`） | 回执、提示、欢迎语、失败通知全部单向出站，绝不污染模型上下文；有测试锁定 |
| **按回合号配对回复** | 同一个 session 可能被 GUI 一起喂，只有"微信发起的回合"才回微信 |
| **零运行时依赖、无原生模块** | 安装不会碰 node-gyp；peer 依赖会让 profile 安装卡范围校验，所以直接用 `ctx.get(key)` 取宿主服务 |
| **状态目录一切自理**（0600/0700 + 原子写 + 损坏留档） | 凭据与附件是敏感数据；Windows 上用重试兜住 `EPERM/EBUSY` |
| **副作用预算化** | 子进程只有一处且先校验、只绑回环、出站域名白名单、定时器必须 `unref`——`test/sideeffects.test.mjs` 让新增隐式副作用直接失败 |
| **能力随 preset 走** | DSH 的工具是**按 agent 挂载 preset** 得到的，插件在 `setup` 期 `mount`，创建与恢复都挂 |

## 快速开始

```sh
# 1) 安装（二选一）
#    a. GUI：设置 → 插件 → 安装，粘贴 tarball 路径（宿主自己热重载，通常无需重启）
#    b. 终端：
dsh plugin --profile desktop add ./dsh-wechat-0.1.25.tgz

# 2) 扫码绑定（生成二维码 + 回环扫码页）
node bin/dsh-wechat.mjs login --page

# 3) 微信里给机器人发任意一句话，会收到上手引导（/help 看全部指令）
```

升级、重启与版本自证的细节见 §4「安装」与 §4.4「升级：为什么有时要重启」。


## 1. 能力

| 能力 | 说明 |
| --- | --- |
| 扫码绑定 | 微信扫描二维码即可把机器人绑定到你的账号，凭据保存在本机（0600），无需 appid/secret |
| 收发消息 | 长轮询接收私聊消息；回复按 1800 字安全分段发送 |
| 正在输入 | 生成期间显示微信原生「对方正在输入」，回合结束自动取消 |
| 过程可见 | 工具调用进度以 `🔧 tool {...}` 形式推送，可切换 `off / brief / verbose` |
| 会话映射 | 一个微信会话 ↔ 一个 DSH 会话，持久化绑定，重启后自动 `resume` 续聊 |
| 斜杠命令 | `/new`、`/session`、`/stop`、`/status`、`/workspace`、`/model`、`/reasoning`、`/whoami`、`/login`、`/logout`、`/ping`、`/help`（含中文别名） |
| 审批转发 | Agent 需要授权时，把工具、原因和操作说明发到微信，回「允许 / 拒绝 / 取消」即可决定 |
| 提问转发 | `ask_user_question` 的选项会以编号发到微信，回序号或直接回文字答案 |
| 图片 / 文件 | 收到的图片、文件、视频、语音自动解密落盘并把路径交给 Agent；Agent 可用工具把产物作为图片或文件发回微信 |
| 模型工具 | `wechat_send_text`、`wechat_send_file`、`wechat_chat_info`，让 Agent 主动推送 |
| 访问控制 | 默认白名单：只有 `ownerUserId` 与 `allowedUserIds` 里的微信用户可以驱动 Agent |
| 断线自愈 | 长轮询失败指数退避重试；`ret=-14`（会话过期）自动清凭据并重新扫码登录 |

---

## 2. 工作原理

```
微信 App
   │  扫码绑定 / 私聊消息
   ▼
腾讯 iLink Bot 网关  https://ilinkai.weixin.qq.com
   │  getupdates 长轮询（≈35s）          ▲ sendmessage / sendtyping / getuploadurl + AES-128-ECB CDN
   ▼                                     │
┌──────────────────────────────────────────────────────────────┐
│ dsh-wechat 插件（运行在 DSH Host 进程内）                      │
│                                                              │
│ channel.js   登录、长轮询、游标持久化、退避与重登              │
│ bridge.js    微信会话 ↔ DSH 会话、回合收集、分段回复            │
│ approval.js  approval/request、user-questions/request 应答     │
│ tools.js     wechat_* 模型工具                                │
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
4. 收到 `turn/end` → 取**最后一步**的助手文本（而不是中间过程）→ 分段 `sendmessage`；
5. 若模型调用需要授权的工具，`approval/request` 拦截 → 发微信 → 等你的回复 → 返回 `allowed-once` / `rejected` / `cancelled`。

> 设计取舍：iLink 的机器人消息**不能编辑**（`GENERATING` 状态在普通会话里不生效），所以本插件不做"边生成边改同一条消息"的伪流式，而是用「正在输入 + 工具进度 + 最终分段」的方式呈现，避免刷屏。

---

## 3. 前置条件

- **DSH 0.2.0-rc.2**（`dsh --version` 或在桌面端「关于」里确认）。
- Node.js ≥ 20（DSH 桌面端自带的 Node 已满足）。
- 一个**具备微信 ClawBot / iLink 机器人能力**的微信号（腾讯侧能力，需要在微信内开通；能否扫码登录以 iLink 网关返回为准）。
- 运行 DSH 的机器可以访问 `https://ilinkai.weixin.qq.com` 与 `https://novac2c.cdn.weixin.qq.com`。

---

## 4. 安装

### 4.1 装进一个 profile

```sh
# 本地目录 / tarball / npm 包都可以；<profile> 例如 web、desktop
dsh plugin --profile web add /绝对路径/dsh-wechat
```

- 桌面端（Desktop）的 profile 由 App 托管：**先完全退出 DSH 桌面端**，再用桌面端安装的 `dsh` 命令执行同一条命令。
- 安装后该包会出现在 profile 的 `package.json` → `dsh.profile.bundles` 中，`cordis.patch.yml` 里的行由本插件自带的 `cordis.patch.yml` 提供：

```yaml
- insert:
    - id: dsh-wechat
      name: 'dsh-wechat'
      config:
        enabled: true
        accessPolicy: allowlist
        typing: true
        progress: brief
```

### 4.2 覆盖配置

在 profile 的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里重复该行 id 即可覆盖（**patch 会整体替换 `config`，请写全要保留的键**）：

```yaml
- id: dsh-wechat
  name: 'dsh-wechat'
  config:
    enabled: true
    accessPolicy: allowlist
    allowedUserIds:
      - o9cq800kum_4g8Py8Qw5G0a@im.wechat
    workspace: /Users/me/projects/demo
    typing: true
    progress: brief
    chunkChars: 1800
```

### 4.3 不启动时先自检

```sh
dsh --profile web --dump-config | grep -A3 dsh-wechat   # 确认这一层已生效
```

---


### 4.4 升级：为什么有时要重启

DSH 宿主对**配置**改动是热应用的，对**已加载插件的代码**不是。实测（0.2.0-rc.2 桌面端）：

| 变更 | 是否立即生效 | 依据 |
| --- | --- | --- |
| 改 profile 配置（`cordis.patch.yml`，例如给 `dsh-wechat` 覆盖一行 `config`） | ✅ 立即 | 写入 `loginPage: false` 后扫码页端口 ~1 秒内关闭，改回后重新监听；插件被重新 `apply`（端口 fd 变化） |
| 装**新**插件（首次导入） | ✅ 通常不用重启 | 宿主的插件管理器安装后自己 `reload()`；模块第一次导入就是新代码 |
| **升级**已加载的插件（替换 `node_modules/dsh-wechat`） | ❌ 需重启 | 加载器复用已导入的模块；配置重载只重新 `apply`、不重新 `import` |

HMR（`@deepseek-ai/dsh-hmr`）默认 `root: []`：只监听配置，不监听源码模块。想让改代码也即时生效，在 profile patch 里给它加监听目录（改这一行本身仍需重启一次来建立基线）：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["/绝对路径/到/插件目录"]
```

HMR 用 `realpathSync()` 匹配模块：`dsh plugin add <tgz>` 是拷贝（真实路径在 profile 内），`add <目录>`/`link:` 才指向你的源码目录。

**怎么确认"现在跑的是哪个版本"**：插件每次启动都会往 `state.json` 写一条 `boots` 记录（版本、pid、时间），`/status` 里的「插件版本」同时给出**运行中的版本**与**磁盘上已装的版本**——两者不一致时会明确写「重启 DSH 后生效」。注意 DSH 热应用的是**配置**，不是已加载的代码，所以这两个值确实可能不同。

**升级与校验**：

```sh
# 安装（终端环境）
dsh plugin --profile desktop add ./dsh-wechat-0.1.21.tgz

# 打包 + 走 GUI 插件管理器（宿主自己重载，通常无需重启）
node scripts/upgrade.mjs --via-gui

# 打包 + dsh plugin 安装（随后需要重启 DSH）
node scripts/upgrade.mjs --via-cli

# 任何时候确认「现在跑的是哪个版本」
node scripts/upgrade.mjs --check
```

`--check` 对比三个版本：工作区构建版本、profile 已装版本、**运行中的版本**（插件每次启动写一条 `state.json` 的 `boots` 记录，`/status` 里的「插件版本」也是它）。0.1.16 之前的构建没有启动记录，所以第一次跑会显示"未知"，重启一次后即可精确对比。

## 5. 扫码登录

两种方式，任选其一：

**A. 扫码页（GUI 里最顺手）**

插件启动时若发现没有凭据且 `autoLogin: true`（默认），会自动拉起一个**本机扫码页**并把地址打进日志、同时用默认浏览器打开。地址优先是 DSH 自己的端口（GUI 同一个源，非 `/api` 路由不受鉴权限制）：

```
http://127.0.0.1:19387/dsh-wechat/?t=<一次性令牌>      # 有 webServer 时
http://127.0.0.1:30989/t/<一次性令牌>/                 # 兜底，插件也自带一个页面服务
```

页面上就是二维码 + 实时状态（等待扫码 / 已扫码待确认 / 登录成功），二维码过期会自动换新，页面上的「重新申请二维码」按钮可手动换一张。地址只监听 `127.0.0.1` 且带一次性令牌，令牌不会出现在页面内容里。

页面长什么样可以先看静态预览：[docs/login-page-preview.html](docs/login-page-preview.html)（其中的二维码是占位内容，扫不了）。

命令行同样可以拉起这个页面：

```sh
node /绝对路径/dsh-wechat/bin/dsh-wechat.mjs login --page      # 起页面并打开浏览器
node /绝对路径/dsh-wechat/bin/dsh-wechat.mjs login            # 只在终端打印二维码
node /绝对路径/dsh-wechat/bin/dsh-wechat.mjs login --no-open  # 起页面但不自动开浏览器
node bin/dsh-wechat.mjs status   # 查看绑定状态、游标、会话映射、收发统计
node bin/dsh-wechat.mjs logout   # 清除本机凭据
```

地址同时写到 `$状态目录/login-page.url`，看不到日志时可以直接读它：

```sh
cat ~/.dsh/integrations/dsh-wechat/login-page.url
```

**B. 终端二维码**

```sh
node /绝对路径/dsh-wechat/bin/dsh-wechat.mjs login
```

终端直接用 Unicode 半块字符打印二维码，同时把二维码写入状态目录的 `login-qrcode.svg`（浏览器/预览可直接打开）与 `login-qrcode.txt`。

**C. 环境变量（无人值守）**

```sh
export DSH_WECHAT_BOT_TOKEN=ilinkbot_xxx
export DSH_WECHAT_BASE_URL=https://ilinkai.weixin.qq.com   # 可选
```

环境变量优先于凭据文件，且不会被写回磁盘。

---

## 6. 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时插件完全不动（不注册监听、不连网） |
| `stateDir` | `$DSH_HOME/integrations/dsh-wechat` | 凭据、状态、媒体、二维码的存放目录 |
| `workspace` | 第一个 DSH 工作区，否则 `process.cwd()` | 新会话的工作目录（绝对路径） |
| `accessPolicy` | `allowlist` | `allowlist` 只服务白名单；`open` 接受任何发送者 |
| `allowedUserIds` | `[]` | 允许的微信用户 ID 列表（也接受逗号分隔字符串） |
| `ownerUserId` | `null` | 机器人所有者，始终放行；留空时**自动采用扫码绑定的那个微信号**，避免默认白名单把自己的消息也拦掉 |
| `autoLogin` | `true` | 无凭据时自动走扫码登录 |
| `loginPage` | `true` | 是否启动本机扫码页（关闭后二维码只进日志与文件） |
| `loginPagePort` | `30989` | 扫码页端口；被占用时自动改用系统分配的端口 |
| `openLoginPage` | `true` | 需要扫码时是否自动用默认浏览器打开扫码页 |
| `baseUrl` | `null` | 覆盖 iLink 网关地址（默认官方 `https://ilinkai.weixin.qq.com`，私有部署/调试用） |
| `cdnBaseUrl` | `null` | 覆盖媒体 CDN 地址 |
| `chunkChars` | `1800` | 单条微信消息的最大字符数 |
| `typing` | `true` | 是否显示「对方正在输入」 |
| `typingKeepaliveSeconds` | `5` | 输入状态的保活间隔 |
| `progress` | `brief` | `off` 只回最终答案；`brief` 加工具进度；`verbose` 再加中间说明 |
| `showToolProgress` | `true` | `progress != off` 时是否推送 `🔧 tool` 行 || `showToolProgress` | `true` | `progress != off` 时是否推送 `🔧 tool` 行 |
| `progress: brief` + `showToolProgress: false` | — | **工具照常调用，只是不把调用记录发到微信**；本行只影响通知，不影响工具可用性 |
| `turnTimeoutSeconds` | `900` | 单轮最长等待，超时后在微信里提示（回合仍在后台继续） |
| `approvalTimeoutSeconds` | `300` | 审批等待时长，超时交给下一个应答者（例如桌面端弹窗） |
| `questionsTimeoutSeconds` | `600` | 提问等待时长，超时同上 |
| `idleDisposeMinutes` | `0` | 安静超过这么多分钟后释放常驻 Agent（会话绑定保留，下条消息自动 resume）；`0` 表示一直常驻，可写小数 |
| `agentPreset` | `null` | 会话挂载的 agent preset；**留空时自动采用 DSH 的默认 preset**（`standard`）。这决定 Agent 有没有工具：`standard` 带 `tool-bash`、`tool-fs`、`tool-fs-search`、`plan-mode` 等，未挂载时微信里的 Agent 只能使用插件自己注册的 `wechat_*` 工具 |
| `model` | `null` | 形如 `deepseek-account/deepseek-flash`，或 `{ provider, model, reasoningEffort?, maxTokens? }`；**留空时自动采用 DSH 的默认模型**（必须能解析出一个路由，否则系统提示词里的 `{{model}}` 无法渲染） |
| `media.enabled` | `true` | 是否收发图片/文件 |
| `media.dir` | `stateDir/media` | 入站附件落盘目录 |
| `media.maxInboundBytes` | `20971520` | 入站媒体上限，超出直接拒绝 |
| `media.maxOutboundBytes` | `52428800` | 出站文件上限 |
| `notifyLifecycle` | `false` | 是否发送 `msg/notifystart|notifystop`（非公开协议，失败自动忽略） |
| `routeTag` | `null` | `SKRouteTag` 路由标签，仅部署方需要时填写 |
| `channelVersion` | `1.0.0` | `base_info.channel_version` |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |

配置非法时插件会在日志里明确报错并回退到默认值，不会让整个 profile 起不来。

---

## 7. 在微信里怎么用

一句话：**你在微信里说的每句话就是给 DSH 的 prompt**，Agent 跑完把最终回答发回这个会话。

| 你想做的事 | 在微信里怎么发 |
| --- | --- |
| 派活 / 提问 | 直接说话：「帮我看下 ~/proj 的测试为什么失败」「把这个目录整理成三份文档」 |
| 让它看图片或文件 | 直接发图片/文件（可带一句说明）。插件会解密落盘并把本地路径交给 Agent |
| 要回一份产物 | 「生成一份 xxx 报告并发给我」——Agent 用 `wechat_send_file` 把文件作为图片或文件发回微信 |
| 在多个对话之间切换 | `/session` 列出本工作区的对话（标题 + 时间 + 是否运行中），回 `/session 3` 续聊第 3 个 |
| 开新对话 | `/new`（当前对话结束，下一条消息开新对话；工作区与模型设置保留） |
| 打断长任务 | `/stop` |
| 看状态 | `/status`（连接、bot、会话、工作区、模型、队列、收发统计、最近错误） |
| 换项目目录 | `/workspace`（先列目录）→ `/workspace 2`；或 `/workspace add /Users/you/repo 我的项目` |
| 换模型 | `/model deepseek-account/deepseek-pro`（下个新会话生效，先 `/new`） |
| 查自己的 ID | `/whoami` |
| 换思考深度 | `/reasoning`（先列出档位，回 `/reasoning 2` 选中） |
| 看当前设置 | `/settings` |
| 全部指令 | `/help`（中文别名同样可用，如 `/帮助`、`/新会话`、`/停止`、`/状态`） |

运行中的表现：

- **绑定后你发的第一条消息**（只要不是指令）会先收到一条使用说明：功能清单 + `/workspace`、`/model`、`/reasoning` 的用法与当前取值；换绑后会自动再发一次；
- `/workspace`、`/model`、`/reasoning` 不带参数时都会**列出可选项**（工作区来自 DSH 工作区注册表，模型来自 LLM 目录，思考深度来自当前模型的档位声明），回序号即可切换；
- 生成期间微信显示**「对方正在输入」**，回合结束自动取消；空闲超过 `idleDisposeMinutes` 的常驻 Agent 会被回收（会话绑定保留，下条消息自动 resume）；
- 超时只对**正在跑的那一轮**计时，排队中的消息不会被误报超时；`/stop` 会连同排队消息一起丢弃并告知条数；
- 一轮回复的某一段发送失败时，**剩余分段仍会继续发送**，并在微信里提示有几段没发出去（细节进 `/status` 的最近错误）；
- 回复与回合按**回合号**配对：GUI 在同一会话里跑的回合不会被误当成微信的回复，微信消息的答案也不会错位；
- 长轮询游标在处理完一批消息后才落盘（中途崩溃不会丢消息）；登录遇网络问题会 60 秒后重试，而不是永久停摆；
- 工具调用会推 `🔧 tool {...}` 进度（`progress: brief`；设成 `verbose` 还会推中间说明，设成 `off` 就只回最终答案）；
- 最终回答按 1800 字自动分段（`chunkChars` 可调）；
- 同一个会话的消息**排队串行**执行，不会并发互相干扰；
- Agent 要跑敏感命令时会问你：回「允许 / 拒绝 / 取消」（也认 `yes`/`no`/`1`/`2`）；不回则超时后转交桌面端弹窗；
- Agent 用 `ask_user_question` 提问时，选项会编号发来，回序号（多选回 `1,3`）或直接回文字；
- 微信里创建的会话就是普通 DSH 会话，在 GUI 的会话列表里能直接看到并接着聊。

关于「对话」：DSH 里一个工作区（项目目录）下可以有多个对话（session）。插件默认给每个微信会话绑定一个对话（首条消息时创建），`/session` 让你在**同一个工作区里切换到任意已有对话继续聊**——列表与 GUI 的会话列表同源（持久化语料 + 实时会话），切换只影响这一个微信会话。

**上下文来自哪里**：模型看到的上下文完全来自 **DSH 的 session**，与微信聊天记录无关——插件不会回放微信历史，插件的内部状态（游标、去重 id、`context_token`、绑定关系）也从不进入模型。微信侧唯一会进入会话的是**你这条消息的内容**：

| 进入会话 | 说明 |
| --- | --- |
| 你发的纯文本 | 逐字进入（`lib/bridge.js` 里唯一的会话写入点） |
| 引用消息、附件 | 由插件转成一段说明（被引用的原文、附件落盘路径与类型）后随消息进入——不这样模型就不知道你发了文件 |
| 你发的指令（`/session`、`/status`…）与回执段数（`0`-`99`，也可写 `/0`-`/99`） | **不进入**，由插件消费 |
| 回执、切换确认、欢迎语、失败/超时提示 | **不进入**，只发往微信 |
| Agent 调用 `wechat_send_text`/`wechat_send_file` | 工具调用与结果按 DSH 常规记录进入会话（它就记得自己发过什么） |

另外两点：同一个 session 若同时开在 GUI（列表里标「运行中」），GUI 里的对话也在同一份上下文里；每个微信会话（每个联系人）绑定各自独立的 session，上下文互不相通。

**回执是单向的**：`/session` 的回执、切换确认，以及插件的其它主动消息（欢迎语、失败提示）都只走"发往微信"的通道（`deliver`），**不经过 agent、也不写入会话日志**，因此不会出现在 DSH 的上下文里；同理，你回复的那个数字（0-99）由插件消费掉，不会变成一轮对话。会话里只有你真正发的消息和它的回答。（`test/bridge.test.mjs` 有断言锁定：答数字时不开会话、送给模型的文本与用户输入逐字相同、回执不出现在模型上下文里。）

**绑定是独占的**：一个 session 同一时刻只属于一个微信会话，一个微信会话也只绑一个 session——两个微信会话驱动同一个对话会互相穿插、彼此收到对方的回答，因此第二个会话切换时会被明确拒绝（提示当前持有者，让它发 `/session new` 释放后再切）。另外，**只有"从微信发起的回合"才会回微信**：同一个 session 若在 GUI 里被跑了一轮，答案不会推到微信（插件按回合号匹配，找不到对应的微信消息就忽略）。

切换**不会**新建或截断对话：目标对话就是目标对话，历史完整保留在 DSH 里，下一条消息 resume 它。切换后插件会问一次「要不要把最近 N 段回执到微信」：回 `0`（或不回数字直接发消息）＝不回执，回 `N`(1-99) ＝把该对话最近 N 段（一段 = 一问一答）作为一条消息发到微信，方便你在手机上先看上下文；**回执只是发给微信看的，不会注入模型**。

已知限制：

- **只支持私聊**：iLink 的群消息没有可靠的回复路由，群里的消息会被忽略并在日志里记一条；
- 主动推送依赖最近一次入站消息带来的 `context_token`：太久没互动、或清空了状态后，机器人无法先开口；让对方先发一条消息即可恢复；
- 一轮默认最多等 15 分钟（`turnTimeoutSeconds`），超时会在微信里提示，但回合仍在后台继续跑完，可用 `/status` 查看。

## 8. 微信里的命令

| 命令 | 作用 |
| --- | --- |
| `/help`（`/帮助`、`/?`） | 显示帮助 |
| `/new`（`/新会话`、`/reset`） | 结束当前会话，下一条消息开启新会话（工作区/模型设置保留） |
| `/session [序号\|会话 ID]`（`/会话`、`/对话`） | 列出当前工作区的对话并切换：**显示的名字就是 DSH 界面里的那个标题**（会话日志的 `session/title` 事件），附时间、「运行中」、「←当前」；切换后立即绑定该对话（历史留在 DSH，下一条消息接着它聊），并询问要不要把最近 N 段**回执到微信**（回复 0-99，不回复＝不回执）；子会话（subagent）与已归档对话不列出；`/session new` 等价 `/new`，`/session sources` 打印来源诊断 |
| `/stop`（`/停止`） | 停止正在运行的回合（等同界面上的停止按钮） |
| `/status`（`/状态`） | 连接状态、bot、会话、工作区、模型、队列、统计、最近错误 |
| `/whoami`（`/我是谁`） | 你的微信 ID、会话键、DSH 会话 ID |
| `/workspace [序号\|名称\|路径]`（`/工作区`、`/项目`） | 列出项目目录（标题优先）并切换；**切换即结束当前会话**，下一条消息在新目录开新会话 |
| `/workspace add <路径> [名称]` | 把目录登记为 DSH 工作区（GUI 里也会出现）并切过去 |
| `/model [序号\|provider/model]`（`/模型`） | 列出可用模型 / 按序号或全名选择（对下一个新会话生效） |
| `/reasoning [序号\|档位]`（`/思考`、`/effort`） | 列出当前模型的思考深度档位 / 选择（对下一个新会话生效） |
| `/settings`（`/设置`） | 汇总当前会话的工作区、模型、思考深度 |
| `/login`（`/登录`） | 重新扫码登录的方法 |
| `/logout`（`/退出登录`） | 清除本机凭据（会停止收发）；**仅机器人所有者可用** |
| `/ping` | 连通性检查 |

命令在进入 Agent 之前被处理，不会消耗模型额度。

---

## 9. Agent 可用的工具

| 工具 | 用途 |
| --- | --- |
| `wechat_send_text` | 往当前微信会话发一条文本（阶段性进展、提醒） |
| `wechat_send_file` | 把本地文件作为微信图片/文件发回（自动判断图片扩展名，走 AES 加密 + CDN 上传） |
| `wechat_chat_info` | 查询当前会话/DSH 会话/工作区/模型/运行状态 |

最终回答由插件自动回传，模型不需要也不应该重复发送。

---

## 10. 审批与提问

- **审批**：需要授权的工具调用会暂停，微信收到「🔐 需要你确认一个操作 / 工具 / 原因」。回 `允许`、`同意`、`批准`、`yes` 之一则本次放行（`allowed-once`）；回 `拒绝` 则拒绝；回 `取消` 撤回请求。超时（默认 5 分钟）会转交给下一个应答者——桌面端仍会正常弹窗，所以你两边都能回答。
- **提问**：`ask_user_question` 的选项会编号发出，回 `1`、`2` 选择；多选回 `1,3`；没有选项或你想自由作答时直接回文字。
- 正在等待回答时，你的下一条消息会被当作回复消费，不会误触发新回合；无法识别的文字会继续等待。

---

## 11. 状态、日志与安全

> 插件对系统的全部副作用（进程、端口、文件、定时器、网络出口）逐项列在 [docs/side-effects.md](docs/side-effects.md)，并由 `test/sideeffects.test.mjs` 的 7 条预算断言守住：新增隐式副作用会让测试失败。

```
$DSH_HOME/integrations/dsh-wechat/
├── credentials.json     0600，bot_token 等凭据
├── state.json           0600，长轮询游标 / 会话映射 / 已见消息 / context_token / 统计
├── login-qrcode.txt     最近一次登录二维码（终端字符画）
├── login-qrcode.svg     同一二维码的矢量图
├── login-page.url       当前扫码页地址（含一次性令牌）
└── media/<日期>/…       入站附件解密后的落盘位置
```

- 凭据文件权限固定 `0600`，写入采用「临时文件 + rename」原子替换，且所有写入串行化，断电不会写出半个文件。
- `context_token` 是 iLink 的会话回复令牌：**只有最近给机器人发过消息的会话才能被回复**，因此主动推送必须依赖缓存里的令牌；令牌按用户缓存并随状态文件持久化。
- 默认白名单策略：非白名单用户只会收到一条拒绝提示，不会创建会话、不会调用模型；**被拒绝的发送者连回复令牌都不会被缓存**，事后也无法被 `toUserId` 定向发送。
- **发送边界**：`wechat_send_text` / `wechat_send_file` 只能发往当前会话、机器人所有者或白名单用户；状态目录（含 `credentials.json`）内的文件一律拒绝发送，防止被注入的 Agent 把机器人凭据发出去。
- **日志与进度脱敏**：二维码内容只在 `debug` 级出现；工具进度行里的凭据形状（`Bearer …`、`sk-…`/`ghp_…`/`AKIA…`、`TOKEN=…`、私钥块）会被替换成 `[已隐藏]`，键名含 token/secret/password 的参数整值屏蔽。
- **网络边界**：登录响应里返回的 API 基座地址必须可用（非 http(s) 或对公网主机降级到 http 一律拒绝，沿用当前地址）；所有请求禁止跟随重定向，避免请求体被 307 转发到别处；媒体下载带字节上限，边下边判。
- **状态文件自愈**：`state.json` 损坏时会被改名成 `state.json.corrupt-<时间戳>` 留档，插件从空状态继续启动，而不是整个通道起不来。
- 日志全部带 `[dsh-wechat]` / `[dsh-wechat:channel]` 等前缀，把 `logLevel` 调成 `debug` 可以看到长轮询、去重、回合收集细节。

---

## 12. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 日志只有 `尚未绑定微信机器人` | 没有凭据：执行 `node bin/dsh-wechat.mjs login`，或把 `autoLogin` 打开后重启 DSH |
| 看不到二维码 | 三条路：① 日志里的 `扫码绑定地址：http://127.0.0.1:30989/t/…`；② `cat ~/.dsh/integrations/dsh-wechat/login-page.url` 再用浏览器打开；③ 直接打开状态目录里的 `login-qrcode.svg`；也可 `dsh-wechat login --page` |
| 扫码页打不开 / 端口被占 | 换端口：配置 `loginPagePort`，或设 `loginPagePort: 0` 让系统分配（日志里会打印实际地址） |
| 浏览器没自动弹出 | 说明 `openLoginPage: false` 或主机没有图形界面；手动打开日志里的地址即可 |
| 反复 `接收消息失败（第 N 次）` | 网络无法访问 `ilinkai.weixin.qq.com`，或代理未生效；先 `curl -I https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` 验证 |
| `微信会话已过期（ret=-14）` | iLink 侧会话失效：插件会清凭据并重新扫码；也可以先 `logout` 再 `login` |
| 回复报 `no context_token cached` | 该会话从未给机器人发过消息（或状态被清空）；让对方先发一条消息，回复能力随之恢复 |
| `/session` 里显示 `[object Object]` | 0.1.15 已修：DSH 的 `sessionTitle.get()` / `sessionQuery.readTitle*` 返回的是**标题快照对象**（`{title, messageSeqs, source, …}`）而不是字符串，插件现在统一经 `titleText()` 取文本 |
| `/session` 里有的对话显示"未命名对话" | 该会话还没有 `session/title` 事件（DSH 标题生成的时机由 DSH 决定，可在 GUI 里改名）。发 `/session sources` 看四个来源与标题折叠是否正常 |
| 微信里收到审批/提问，回复后没反应，且只多了一条普通消息 | 0.1.23 起：子会话（subagent）发起的审批也能找回所属微信会话；回复无法识别时会提示一次「还在等你确认」。若仍出现，先用 `/status` 确认插件版本，并在 GUI 里查看该会话的待答提示 |
| 微信里的 Agent 说"没有跑命令的工具" | 会话没挂上 agent preset（0.1.13 起自动挂载）。发 `/status` 看「预设」一行：应显示 `standard`；显示"未挂载"说明 profile 里没有 `agentPresets` 服务。注意**已存在的旧会话**需要 `/new` 才会带上预设 |
| 微信里没反应，但日志有 `turn queued` | 检查 `accessPolicy`/白名单；确认该会话的 Agent 是否被别的客户端占用；必要时 `/status` |
| 审批在微信里没出现 | `approvalTimeoutSeconds` 为 0 或该会话不是本插件创建的（例如你在桌面端手动开的会话）——只有本插件绑定的会话才会转发 |
| 收到的图片打不开 | 检查 `media.maxInboundBytes`；若日志出现 `inbound media decryption failed`，说明发送端用了非标准密钥编码，原文会原样落盘并给出路径 |
| 微信里出现 `⛔ 发送者 … 不在白名单内` | 把该 ID 加进 `allowedUserIds` 或设为 `ownerUserId` |
| 回复是「回合被拦截」 | 该会话被 DSH 归档了（GUI 里归档会话是常规操作）。0.1.6 起微信侧会自动改开新会话并告知；若仍出现，说明是 `agent/pre-step` 钩子拒绝，按提示发 `/new` |
| 想让微信继续某个旧对话 | `/session` 直接列出来选；被 GUI 归档的对话会提示先取消归档 |
| 插件完全没加载 | `dsh --profile <name> --dump-config` 确认 patch 行存在；本插件不声明 `peerDependencies`，因此不会被版本闸门拦下 |

---

## 13. 开发与测试

```sh
npm test          # 73 个用例：单元 + 协议 + 桥接 + 扫码页 + 真实 cordis 启动
```

| 测试文件 | 覆盖内容 |
| --- | --- |
| `test/qr.test.mjs` | 二维码编码器与 `qrcode`（devDependency，仅作校验基准）**逐模块比对**，含 1–271 字节全部长度；终端/SVG 渲染几何 |
| `test/ilink.test.mjs` | 对**真实 HTTP 假网关**跑完整协议：扫码登录、长轮询游标、请求头与信封、`sendmessage` 结构、输入状态、AES-128-ECB 上传/下载两种密钥编码、`ret=-14`、HTTP 与非 JSON 错误映射 |
| `test/bridge.test.mjs` | 消息 → 会话 → 回合 → 回复全链路：会话复用/续聊、去重、回声丢弃、白名单、分段、`aborted/error` 语义、工具进度、命令、`/new` `/stop`、输入状态、附件落盘、引用消息、审批与提问、主动发送、文件回传 |
| `test/plugin.test.mjs` | 用**真实 `@deepseek-ai/cordis` 4.0.4** 启动插件，接真实 HTTP 假网关：断言监听到达、工具注册/注销、凭据来自环境变量、卸载后长轮询停止；并完整跑通「无凭据 → 拉起扫码页 → 页面出现二维码 → 手机确认 → 写入凭据 → 开始收发」 |
| `test/sideeffects.test.mjs` | 副作用预算：子进程只有一处且先校验、禁止 osascript/开机项/剪贴板/`process.exit`、唯一监听 Socket 绑定回环、出站域名白名单、定时器必须 unref、凭据与附件 0600/0700、写文件目标白名单 |
| `test/loginpage.test.mjs` | 扫码页：一次性令牌鉴权（403）、二维码内嵌、状态机文案、登录后隐藏二维码、`state.json`、换码按钮、端口被占用的回退、`stop()` 释放端口 |
| `test/unit.test.mjs` | 配置归一化与校验、访问策略、路径解析、状态持久化与去重上限、凭据权限、分段边界（含代理对）、命令解析、消息构造 |

开发依赖只有两个，且都**不参与运行时**：`@deepseek-ai/cordis`（启动测试）与 `qrcode`（二维码校验基准）。

**测试不产生真实副作用**：会拉起系统程序的地方（`openInBrowser`）接受注入的 `spawn`/`platform`，测试注入假实现并断言 argv，而不是真的打开浏览器。历史教训：早期版本里 `openInBrowser('')` 在 macOS 上不会失败，而是让 `/usr/bin/open` 打开**当前目录**——于是每次跑测试都会弹出访达窗口；现在非 http(s) 输入在 `spawn` 之前就被拒绝（`isLaunchableUrl`），并且测试断言的是"一次都没启动"。

### 与 DSH 的契约

插件只使用下列**已核对**的 DSH 0.2.0-rc.2 接口，且全部通过字符串 key 获取，不 import 任何 `@deepseek-ai/*`：

| 使用点 | 依据 |
| --- | --- |
| `ctx.get('agents' / 'sessions' / 'tools' / 'workspaceRegistry')` | cordis 服务按 key 解析（`ctx.<key>` 等价形式） |
| `agents.create({ sessionId, meta:{ cwd, agentPreset }, agentOptions })` | `CreateAgentOptions` |
| `agents.resume({ resumeSessionId, agentOptions })` | `ResumeAgentOptions` |
| `agent.followup(userMessage)` / `agent.cancel({ kind:'user' })` / `agent.session.id` | `Agent` 接口 |
| `agent/assistant-stream` 的 `start/chunk/end`，`chunk.type === 'text-delta'` | `AssistantStreamFrame` |
| `session/event` 的 `turn/start`、`turn/end{reason}`、`tool/call{name,arguments}` | `SessionEventMap` |
| `approval/request`（waterfall，返回 `allowed-once`/`rejected`/`cancelled`） | `ApprovalService` 文档与 `dsh-im` 的真实注册方式 `{global:true, prepend:true}` |
| `user-questions/request`（waterfall，返回 `{answers:[{id,selected,custom?}]}`） | `UserQuestionService` 与 `ask_user_question` 的输出 schema |
| `ctx.tools.register({ name, description, parameters, output:{schema,render}, execute })` | `ToolRuntime.register` 与 `defineTool` 的归一化结果 |
| `ctx.effect` / `ctx.on` / `ctx.inject` | cordis 4.0.4 |

**不声明 `peerDependencies` 是有意为之**：0.2.0-rc.2 的插件安装闸门只检查 `@deepseek-ai/dsh*` 的 peer 范围，而本插件既然不 import 它们，就不该被版本范围锁死；这也让插件在 0.1.x 与 0.2.x 上都能加载（差异只在不存在的服务会被跳过）。

---

## 14. 平台兼容性

代码没有原生依赖、没有平台专有命令（除了"打开浏览器"这一处按平台分支），但**只在 macOS 上实跑过**。下表区分"已实测"与"已审计未实测"：

| 维度 | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 运行状态 | ✅ 已实测（DSH 0.2.0-rc.2 桌面端，微信收发闭环） | ⚠️ 未实测，代码路径已审计 | ⚠️ 未实测，代码路径已审计 |
| 打开扫码页 | `open <url>` | `xdg-open <url>` | `cmd /c start "" <url>`，带 `windowsHide` 不闪黑框 |
| 扫码页监听 | `127.0.0.1` | 同 | 同（回环绑定不触发防火墙弹窗） |
| 凭据/附件权限 | `0600`/`0700` 生效 | 生效 | `mode` 基本无效（Node 在 Windows 只映射只读位）；保护来自 `%USERPROFILE%` 的目录 ACL |
| 状态原子写 | `rename` 覆盖 | 同 | 覆盖时可能 `EPERM`/`EBUSY`（杀软/索引器占用）→ 内置 4 次退避重试 |
| 终端二维码 | ✅ | ✅ 需 UTF-8 终端 | 旧 conhost 可能缺字形 → 用 `login --page` 看网页版 |
| 中断信号 | SIGINT/SIGTERM | 同 | 只有 SIGINT（Ctrl+C）有效，CLI 已按此处理 |
| 路径输入 | `~/proj` | 同 | `~\proj` 也支持；含空格的路径可加引号：`/workspace "D:\My Projects\a"` |
| 附件文件名 | 原名 | 原名 | 保留设备名（`CON`/`NUL`/`COM1`…）自动加 `_`，结尾的点/空格去掉 |
| 依赖 | 零运行时依赖、无需编译 | 同 | 同（不会有 node-gyp 问题） |

跨平台相关的判断都抽成了可测纯函数（`expandHome` / `unquote` / `isInsideDirectory` / `withRetries`），并有三条测试在 macOS 上直接断言 Windows 语义（大小写不敏感、反斜杠分隔符、路径前缀逃逸）。

换平台时建议先自检：

```sh
node --test test/          # 125 条；其中 7 条副作用预算 + 3 条跨平台用例不依赖具体平台
node bin/dsh-wechat.mjs login --page    # 起扫码页，确认端口与浏览器分支正常
```

## 15. 合规提醒

本插件通过腾讯 iLink / ClawBot 的机器人能力接入微信，属于官方扫码绑定路径，但仍请遵守微信与腾讯云的相关协议：不要用于群发营销、批量加好友或其他违反平台规则的行为；账号能否使用该能力由平台决定。

## 16. 许可

MIT
