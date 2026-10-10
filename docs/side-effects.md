# 系统副作用清单

本插件运行在 DSH Host 进程内、拥有你的用户权限，所以"它会对你机器做什么"是一份契约，而不是注释。本文件逐项列出副作用、约束它与验证它的方式；`test/sideeffects.test.mjs` 把其中的硬约束变成 7 条断言，新增隐式副作用会让测试直接失败。

审计基准：`dsh-wechat@0.1.10`（2026-09-30）。

## 1. 进程

| 项目 | 事实 | 约束 |
| --- | --- | --- |
| 子进程 | **仅一处**：`lib/channel.js` 的 `openInBrowser()` 用 `spawn` 打开浏览器 | 输入必须是绝对 http(s) URL（`isLaunchableUrl()` 在 `spawn` **之前**拒绝空串、`file:`、`javascript:`、裸路径等）；`spawn` 可注入（测试不产生真实进程）；`openLoginPage: false` 可整体关闭 |
| 其它进程 | 无 `exec`/`execFile`/`fork`/`osascript`/`defaults`/`plutil` | 断言：只有 `lib/channel.js` 允许导入 `node:child_process`，且只有一处启动调用 |
| 进程生命周期 | 不调用 `process.exit()`；不注册信号处理（CLI 除外，且在自己的 `finally` 里 `off`） | 断言：全仓禁止 `process.exit(` |

历史教训：`openInBrowser('')` 曾在 macOS 上让 `/usr/bin/open` 打开**当前目录**，于是每次跑测试都弹出访达窗口。现在不可用输入一次都不会到达启动器。

## 2. 端口与套接字

| 项目 | 事实 | 约束 |
| --- | --- | --- |
| 监听 | **一个** HTTP server：扫码页，`loginPagePort`（默认 30989） | 显式绑定 `127.0.0.1`，从不 0.0.0.0；端口被占用时回退到系统分配 |
| GUI 集成 | 复用宿主已有的 web server，注册 `prefix /dsh-wechat` 路由 | 不新开端口；一次性令牌校验（字节级常量时间比较），非 GET/HEAD 返回 405 |
| 出站长连接 | 长轮询 `getupdates` 常驻一条 TCP（约 35 秒一轮，服务端挂起） | 这是协议要求；socket 随 `stop()` 关闭 |
| 连接池 | 使用全局 `fetch`（undici），默认 keep-alive 复用连接 | 短时残留连接属正常行为，不产生额外监听 |

## 3. 文件与目录

写入范围**只有**状态目录（默认 `$DSH_HOME/integrations/dsh-wechat`，可用 `stateDir` 改）与媒体目录（默认其下 `media/`）：

```
credentials.json   0600   机器人 bearer 凭据
state.json         0600   游标 / 会话映射 / 已见消息 / context_token / 统计
login-page.url     0600   扫码页地址（含一次性令牌）
login-qrcode.svg   0600   登录二维码
login-qrcode.txt   0600   同上（字符画）
state.json.<pid>.<ts>.tmp  写入中间态，随写随改名
state.json.corrupt-<ts> / state.json.unreadable-<ts>   损坏或读不出的状态文件留档（/logout 会清掉凭据的同类副本）
media/<日期>/<时间>-<名>   0600，入站附件解密后的落盘位置
```

- 目录以 `0700` 创建、文件以 `0600` 写入并 `chmod`：入站附件可能是身份证照片、合同这类内容，不能依赖 umask。
- 不改动你的工作区/项目目录，不写 `~/.zshrc`、`LaunchAgents`、`crontab`、`systemd`，不注册开机项，不碰剪贴板，不弹系统通知。
- 被拒的操作：`wechat_send_file` 拒绝发送状态目录内的任何文件（含软链绕过，按 `realpath` 比较），避免被注入的 Agent 把凭据发进聊天。

## 4. 全局态与环境

- 环境变量**只读**：`DSH_HOME`、`DSH_WEB_URL`、`DSH_WECHAT_BOT_TOKEN`/`_BASE_URL`/`_BOT_ID`/`_USER_ID`。没有赋值（断言禁止 `process.env.X =`）。
- 不做全局猴子补丁，不改 `globalThis`，不注册 `unhandledRejection`。
- 插件自己的 cordis 服务、监听器、工具都随 fiber 卸载回收。

## 5. 定时器

| 定时器 | 生命周期 | unref |
| --- | --- | --- |
| 「正在输入」保活（`typingKeepaliveSeconds`） | 每个进行中的回合 | 是，回合结束清除 |
| 回合超时（`turnTimeoutSeconds`） | 队首回合 | 是 |
| 空闲回收（`idleDisposeMinutes`） | 插件加载期 | 是，卸载清除 |
| 审批 / 提问等待 | 单次交互 | 是，卸载时 `dispose()` 统一结算 |
| 长轮询退避 | 单次等待，可被 abort 提前唤醒 | 是（宿主进程内） |
| 扫码状态重试 | 同上；CLI 场景传 keepAlive 以免重试期间进程退出 | 否（CLI） |

断言：出现 `setInterval` 的文件必须有等量 `unref`。

## 6. 网络出口

只有两类目标，且都可用配置覆盖：

| 目标 | 默认 | 用途 |
| --- | --- | --- |
| REST 网关 | `https://ilinkai.weixin.qq.com`（`baseUrl`） | 登录、收消息、发消息、输入状态 |
| 媒体 CDN | `https://novac2c.cdn.weixin.qq.com/c2c`（`cdnBaseUrl`） | 附件上传/下载 |

- 两者都经过 `assertUsableBaseUrl()`：必须 http(s)；**公网主机强制 https**，只有回环/内网允许 http。
- 所有请求 `redirect: 'error'`：307 不能把请求体（含 bearer）转发到别处。
- 无遥测、无第三方分析、无更新检查。断言：源码里出现的绝对 URL 只允许上述两个腾讯域名 + SVG 命名空间 + 回环。

## 7. 固有但可控的副作用

这些无法消除，属于设计取舍，都可关闭：

| 副作用 | 关闭方式 |
| --- | --- |
| 首次无凭据时**自动打开浏览器**显示扫码页 | `openLoginPage: false`（日志与 `login-page.url` 仍在） |
| 扫描页监听一个回环端口 | `loginPage: false`（二维码只进日志与文件） |
| 每回合向微信发送「正在输入」与工具进度 | `typing: false`、`progress: off` |
| 长轮询持续占用一条出站连接 | 卸载插件或退出 DSH |

## 8. 平台差异

| 副作用 | macOS / Linux | Windows |
| --- | --- | --- |
| 文件权限 | `0600`/`0700` 真正生效 | `mode` 只映射只读位，实际保护来自用户目录 ACL |
| 状态文件替换 | `rename` 直接覆盖 | 可能被占用而 `EPERM`/`EBUSY` → `withRetries` 退避重试 4 次 |
| 打开浏览器 | `open` / `xdg-open` | `cmd /c start ""`，`windowsHide: true` 避免黑框闪现 |
| 附件文件名 | 原样 | 保留设备名加 `_`、去掉结尾点与空格（否则 Windows 会静默改名或拒绝创建） |
| 中断 | SIGINT/SIGTERM | 仅 SIGINT |

## 9. 如何验证

```sh
node --test test/sideeffects.test.mjs      # 7 条副作用预算断言
node -e "import('./lib/channel.js').then(m => console.log(m.openInBrowser('')))"   # false，且无弹窗
lsof -nP -iTCP -sTCP:LISTEN | grep -i node # 只应看到回环上的扫码页端口
```
