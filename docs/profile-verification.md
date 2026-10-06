# 一次性 Profile 验证证据

DSH STORE 在把插件标为可安装前要求「一次性 Profile 的安装、启动与卸载证据」。本文件记录一次**可复现**的验证：全过程在临时 `DSH_HOME` 中完成，不接触操作者真实的 profile、凭据或正在运行的 DSH。

## 复现方式

```sh
npm pack                                     # 产出 dsh-wechat-0.1.27.tgz
scripts/verify-profile-install.sh            # 或显式传入 tarball 路径
```

脚本做四件事，并在任一步失败时以非零码退出：

1. **基线**：在没有插件的全新 web profile 上 `dsh --profile web --dump-config`，断言其中**不含** `dsh-wechat`；
2. **安装**：`dsh plugin --profile web add --ignore-scripts --config.auto-install-peers=false <tgz>`，再次 dump 并断言插件行已进入组合；
3. **契约检查**：直接读 tarball 内的 `package.json`，断言**没有** `preinstall/install/postinstall/prepare` 生命周期脚本、**没有**运行时依赖，并打印 `dsh.bundle.patch`、`dshReleases`、`engines`、`os`；
4. **卸载**：`dsh plugin --profile web remove dsh-wechat`，dump 后断言回到基线形态。

## 本次结果（2026-10-06）

```json
{
  "status": "passed",
  "dsh": "0.2.0-rc.2",
  "tarball": "dsh-wechat-0.1.27.tgz",
  "install": true,
  "composition": true,
  "uninstall": true,
  "disposableProfile": true,
  "booted": false
}
```

| 项 | 值 |
| --- | --- |
| 包 | `dsh-wechat@0.1.27` |
| Bundle Patch | `./cordis.patch.yml` |
| DSH 兼容声明 | `{"0.2.0-rc.2": "compatible", "0.2.0-rc.1": "unknown", "0.2.1-alpha.1": "unknown"}` |
| 兼容范围 / profile | `>=0.2.0-rc.2 <0.3.0` / `desktop` |
| Node | `>=20` |
| 系统 | `darwin, linux, win32` |
| 运行时依赖 / peer | 0 / 0 |
| 生命周期脚本 | 无 |
| 隔离方式 | 临时 `DSH_HOME`，不绑定任何端口 |

## 覆盖边界（诚实标注）

- ✅ 安装、组合（entry ID 与 Bundle Patch）、卸载、manifest 契约；
- ❌ **未包含真实启动/运行验收**：脚本刻意不启动第二个 host（会占用端口、并可能与正在运行的 DSH 冲突）。运行验收的证据来自作者日常使用：桌面端 profile 上长期运行、微信收发闭环、`docs/side-effects.md` 记录的副作用面；
- ❌ 未包含独立安全审计；本插件按固定源码权限信号自评为 `high`（见 README「权限、外部依赖与失败边界」），因此**不可能**满足 DSH STORE 的自动低风险通道。

## 原始输出（节选）

```
── 1/4 baseline composition (no plugin)
OK: dsh-wechat is absent from the baseline profile
── 2/4 install into the disposable profile
OK: the plugin row is composed into the profile
── 3/4 declared entry and lifecycle
  package      : dsh-wechat@0.1.27
  bundle patch : ./cordis.patch.yml
  dshReleases  : {"0.2.0-rc.2": "compatible", "0.2.0-rc.1": "unknown", "0.2.1-alpha.1": "unknown"}
  engines/os   : {'node': '>=20'} / ['darwin', 'linux', 'win32']
  dependencies : 0 runtime, peers: 0
  lifecycle    : none
── 4/4 uninstall
OK: the row is gone and the profile is back to its baseline shape
result: {"status":"passed","dsh":"0.2.0-rc.2","tarball":"dsh-wechat-0.1.27.tgz","install":true,"composition":true,"uninstall":true,"disposableProfile":true,"booted":false}
```
