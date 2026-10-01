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
 *   --via-cli   pack, install into the profile with `dsh plugin --profile <p> add`,
 *               then say plainly that DSH must restart before the new code runs
 *
 * Usage:
 *   node scripts/upgrade.mjs --via-gui
 *   node scripts/upgrade.mjs --via-cli [--profile desktop] [--state-dir <dir>]
 *   node scripts/upgrade.mjs --check [--state-dir <dir>]
 */

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Parse `--flag value` pairs and the mode switch. */
function parseArgs(argv) {
  const options = { mode: null, profile: 'desktop', stateDir: null, open: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--via-gui') options.mode = 'gui'
    else if (token === '--via-cli') options.mode = 'cli'
    else if (token === '--check') options.mode = 'check'
    else if (token === '--open') options.open = true
    else if (token === '--profile') options.profile = argv[++index]
    else if (token === '--state-dir') options.stateDir = argv[++index]
    else throw new Error(`unknown argument: ${token}`)
  }
  if (options.mode === null) throw new Error('pass --via-gui, --via-cli or --check')
  return options
}

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
      console.log('\n⚠️  CLI 安装不会触发宿主的重载：DSH 需要重启才会运行新代码。')
      console.log('   想要不重启，请改用 --via-gui（宿主的插件管理器会自己重载）。')
      console.log('   重启后可用 --check 确认运行中的版本。')
    }
  }
} catch (error) {
  console.error(`upgrade failed: ${error?.message ?? error}`)
  process.exitCode = 1
}
