# 一次性 Profile 验证证据

DSH STORE 在把插件标为可安装前要求「一次性 Profile 的安装、启动与卸载证据」。本目录下的两个脚本在**临时 `DSH_HOME`** 中完成这些验证，不接触操作者真实的 profile、凭据或正在运行的 DSH，并输出机器可读的结果。

## 复现方式

```sh
npm pack                                     # 产出 dsh-wechat-0.1.28.tgz
scripts/verify-profile-install.sh            # 安装 / 组合 / 卸载
scripts/verify-profile-boot.sh               # 启动（真实 host，OS 分配端口）
```

| 脚本 | 覆盖 | 隔离手段 |
| --- | --- | --- |
| `verify-profile-install.sh` | 基线 `--dump-config` → `dsh plugin add` → 组合出现插件行 → 契约检查（无生命周期脚本、无运行时依赖）→ `dsh plugin remove` → 回到基线 | 临时 `DSH_HOME`；不绑定端口 |
| `verify-profile-boot.sh` | 同上安装后**真的启动 host**：`--port 0`（系统分配端口）+ `--no-open`，探活宿主自身 URL、验证插件路由（无令牌 403、带令牌 200 + HTML），然后停宿主、卸载、核对组合回基线 | 临时 `DSH_HOME`；`autoLogin: false` 的 quiet overlay（不登录、不联网）；端口由内核分配，不与正在运行的 DSH 冲突 |

## 本次结果（2026-10-07）

安装 / 组合 / 卸载：

```json
{"status":"passed","dsh":"0.2.0-rc.2","tarball":"dsh-wechat-0.1.28.tgz","install":true,"composition":true,"uninstall":true,"disposableProfile":true,"booted":false}
```

启动：

```json
{"status":"passed","dsh":"0.2.0-rc.2","install":true,"boot":true,"hostHttp":303,"pluginRouteNoToken":403,"pluginPageWithToken":200,"uninstall":true,"disposableProfile":true}
```

启动这一轮的含义逐项说明：

- `hostHttp: 303`：宿主对自己的 URL 给出 HTTP 应答（303 来自浏览器信任围栏），说明 HTTP 载体确实起来了；
- `pluginRouteNoToken: 403`：`/dsh-wechat/` 不带一次性令牌被拒——这个状态只可能由本插件的路由给出，等价于"插件已在该宿主内挂载"；
- `pluginPageWithToken: 200`：带令牌时同一条路由返回扫码页 HTML，证明插件在宿主里是**活着并且在服务**的。

## manifest 契约（同一次验证中读取）

| 项 | 值 |
| --- | --- |
| 包 | `dsh-wechat@0.1.28` |
| Bundle Patch | `./cordis.patch.yml` |
| DSH 兼容声明 | `{"0.2.0-rc.2": "compatible", "0.2.0-rc.1": "unknown", "0.2.1-alpha.1": "unknown"}` |
| 兼容范围 / profile | `>=0.2.0-rc.2 <0.3.0` / `desktop` |
| Node / 系统 | `>=20` / `darwin, linux, win32` |
| 运行时依赖 / peer | 0 / 0 |
| 生命周期脚本 | 无 |

## 覆盖边界（诚实标注）

- ✅ **安装、组合、启动、卸载**：真实 `dsh` CLI，真实 host 进程，真实 HTTP 探活；
- ❌ **不含微信端到端**：启动验证刻意 `autoLogin: false`，不扫码、不连 iLink 网关。微信收发闭环的证据是作者日常使用（本机桌面端长期运行）；
- ❌ **不含 `rollback`**：DSH 没有跨版本的插件回滚操作，商城的 `dshOperations.rollback` 我们无法提供证据，保持 `unknown`；
- ❌ **不是独立安全审计**：本插件按固定源码权限信号自评为 `high`（见 README「权限、外部依赖与失败边界」），因此**不可能**满足 DSH STORE 的自动低风险通道。
