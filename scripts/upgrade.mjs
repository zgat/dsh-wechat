#!/usr/bin/env node
/**
 * Upgrade dsh-wechat into a DSH profile and prove which build is live.
 *
 * Why this exists: the DSH host hot-applies *config* changes, but it keeps the
 * plugin module it already imported. Installing a new build therefore only takes
 * effect after a restart — unless the install goes through the host's own plugin
 * manager (the GUI), which drives the loader's reload path itself.
 *
 * Two channels, matching those mechanics:
 *   --via-gui   build the tarball and print the path to paste into the GUI plugin
 *               manager (the host performs its own reload; usually no restart)
 *   --via-cli   pack and install into the profile with `dsh plugin --profile <p> add`.
 *               It does **not** restart DSH by default: the new code takes effect on the
 *               next restart, and the caller decides when that happens. `--restart`
 *               schedules one (default 10s; `--restart-delay N` moves the deadline) and
 *               `--no-restart` states the default explicitly.
 *
 * Usage:
 *   node scripts/upgrade.mjs --via-gui
 *   node scripts/upgrade.mjs --via-cli [--profile desktop] [--state-dir <dir>]
 *   node scripts/upgrade.mjs --check [--state-dir <dir>]
 */

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import { parseArgs } from './upgrade-args.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')


/** Read the version this working tree builds. */
async function workspaceVersion() {
  return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
}

/** Read the version installed into a profile, if any. */
async function installedVersion(profileDir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(profileDir, 'node_modules/dsh-wechat/package.json'), 'utf8'))
    return manifest.version
  } catch {
    return null
  }
}

/** Read the newest boot record the plugin wrote, if it ever ran with boot logging. */
async function liveVersion(stateDir) {
  const file = path.join(stateDir ?? path.join(os.homedir(), '.dsh/integrations/dsh-wechat'), 'state.json')
  try {
    const state = JSON.parse(await readFile(file, 'utf8'))
    const boots = Array.isArray(state.boots) ? state.boots : []
    return { boot: boots.at(-1) ?? null, file }
  } catch (error) {
    return { boot: null, file, error: error?.message ?? String(error) }
  }
}

/** Report whether the running process matches what is installed. */
async function report(profileDir, stateDir) {
  const [built, installed, live] = await Promise.all([
    workspaceVersion(),
    installedVersion(profileDir),
    liveVersion(stateDir),
  ])
  console.log(`工作区构建版本 : ${built}`)
  console.log(`profile 已装版本 : ${installed ?? '（未安装）'}`)
  console.log(
    `运行中的版本     : ${live.boot ? `${live.boot.version}（启动于 ${live.boot.at}，pid ${live.boot.pid}）` : '未知：运行中的进程启动于"启动记录"接线之前（≤ 0.1.23），重启一次后本行即可自证'}`,
  )
  if (installed && live.boot && live.boot.version !== installed) {
    console.log('\n⚠️  已装版本与运行版本不一致 → DSH 需要重启才会加载新代码。')
    return false
  }
  if (installed && !live.boot) {
    console.log('\n⚠️  没有运行记录可对比（记录功能自 0.1.24 起才真正接线）：重启一次后，本命令即可直接回答"生效了吗"。')
    return false
  }
  console.log('\n✅ 运行中的代码与已装版本一致。')
  return true
}

try {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = path.join(os.homedir(), '.dsh/profiles', options.profile)
  await stat(profileDir)

  if (options.mode === 'check') {
    const ok = await report(profileDir, options.stateDir)
    process.exitCode = ok ? 0 : 1
  } else {
    const version = await workspaceVersion()
    const { stdout } = await run('npm', ['pack'], {
      cwd: root,
      env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? '/tmp/npmcache' },
    })
    const tarball = path.join(root, stdout.trim().split('\n').at(-1))
    console.log(`已打包 ${version} → ${tarball}`)

    if (options.mode === 'gui') {
      console.log('\n下一步（不需要重启，宿主自己会重载）：')
      console.log('  1. 打开 DSH 的 设置 → 插件')
      console.log('  2. 卸载 dsh-wechat（若已装），然后“安装插件”，粘贴这个路径：')
      console.log(`     ${tarball}`)
      console.log('  3. 回到微信发 /status，看「插件版本」一行是否为新版本')
      if (options.open) await run('open', ['-R', tarball]).catch(() => {})
    } else {
      // The supported path: the launcher runs pnpm inside the profile for us.
      // (`dsh plugin --profile <name> <pnpm args…>`)
      try {
        await run('dsh', ['plugin', '--profile', options.profile, 'add', tarball])
        console.log(`已通过 dsh plugin 安装到 ${profileDir}`)
      } catch (error) {
        // `dsh plugin` delegates to the desktop app's Electron binary, which the
        // running app can terminate (observed exit 254 while a turn was in flight).
        // The bundled pnpm does the same job and does not need the app.
        console.log(`dsh plugin 失败（${String(error?.message ?? error).split('\n')[0]}），改用内置 pnpm…`)
        const pnpm = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs'
        const manifestPath = path.join(profileDir, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.dependencies['dsh-wechat'] = `file:${tarball}`
        const { writeFile } = await import('node:fs/promises')
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        await run(process.execPath, [pnpm, 'install'], { cwd: profileDir })
        console.log(`已通过内置 pnpm 安装到 ${profileDir}`)
      }
      const { verifyInstalled, installFresh } = await import('./upgrade-install.mjs')
      const stale = await verifyInstalled({ profileDir, tarball, run })
      if (stale) {
        console.log('\n⚠️  已装内容与 tarball 不一致（pnpm 对同版本 file: 依赖会判定“已安装”而沿用旧副本）。')
        console.log('   正在强制重装…')
        await installFresh({ profileDir, tarball, run })
        const stillStale = await verifyInstalled({ profileDir, tarball, run })
        if (stillStale) {
          console.error('   ❌ 仍不一致：请把版本号 +1 后重试（同版本号 + 同名 tarball 是 pnpm 的固有行为）。')
          process.exitCode = 1
        } else {
          console.log('   ✅ 重装后一致')
        }
      }

      if (options.restart) {
        const { scheduleRestart, isRestartPending } = await import('./schedule-restart.mjs')
        if (await isRestartPending()) {
          const pending = await scheduleRestart({ delaySeconds: options.restartDelay, force: true })
          console.log(`\n已有排程：已替换为 ${pending.delaySeconds} 秒后（不会叠加成多次重启）`)
          console.log(`  日志：${pending.log}`)
        } else {
          const scheduled = await scheduleRestart({ delaySeconds: options.restartDelay, force: true })
          if (!scheduled.scheduled) {
            console.log(`\n⚠️  已跳过自动重启：${scheduled.recent} 次重启刚排过（熔断，避免“一直重启”的观感）。`)
            console.log('   需要现在重启就手动执行：./scripts/restart-dsh.sh --delay 10')
            console.log(`   日志：${scheduled.log}`)
          } else {
            console.log(`\n已安排重启：${scheduled.delaySeconds} 秒后（launchd 一次性任务，执行后自清理）`)
            console.log(`  日志：${scheduled.log}`)
            console.log('  取消：node scripts/schedule-restart.mjs --cancel')
          }
        }
      } else {
        console.log('\nℹ️  未重启：新代码要等 DSH 重启后才生效（自动重启已改为显式 opt-in）。')
        console.log('   现在重启：./scripts/restart-dsh.sh --delay 10')
        console.log('   下次让它自动重启：node scripts/upgrade.mjs --via-cli --restart [--restart-delay N]')
      }
    }
  }
} catch (error) {
  console.error(`upgrade failed: ${error?.message ?? error}`)
  process.exitCode = 1
}
