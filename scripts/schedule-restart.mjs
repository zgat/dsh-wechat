#!/usr/bin/env node
/**
 * Schedule a one-shot DSH restart through launchd.
 *
 * Why launchd: a restart has to outlive the thing that requested it. A background
 * process started from a DSH turn gets reaped when the turn ends, and `launchctl
 * submit` keeps re-running its command (that produced a 30-second restart loop
 * once). A plain LaunchAgent with `RunAtLoad` and no `KeepAlive` runs exactly once
 * and survives the app it is about to replace.
 *
 * Why the script is copied first: launchd-spawned processes cannot read this
 * repository when it lives on an external volume (macOS privacy), so the restart
 * script is copied to an internal path before scheduling.
 *
 * Usage:
 *   node scripts/schedule-restart.mjs                  # restart 10s from now
 *   node scripts/schedule-restart.mjs --delay 30       # custom delay
 *   node scripts/schedule-restart.mjs --force          # ignore the re-entry guard
 *   node scripts/schedule-restart.mjs --cancel         # drop a pending restart
 *   node scripts/schedule-restart.mjs --dry-run        # print the plan only
 */

import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const LABEL = 'com.zgat.dsh-wechat-restart'

/** Escape a value for XML text content. */
export function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Build the LaunchAgent definition for one restart.
 *
 * `rm` runs before `bootout`: unloading the job kills its process tree, so cleanup
 * placed after it would never execute (that left a stale plist behind once).
 * @param {{ label?: string, scriptPath: string, delaySeconds: number, force?: boolean, logFile?: string }} options - job inputs.
 * @returns {string} plist XML.
 */
export function buildPlist(options) {
  const label = options.label ?? LABEL
  const logFile = options.logFile ?? '$HOME/dsh-wechat-restart.log'
  const command = [
    options.force ? 'DSH_RESTART_FORCE=1' : null,
    `"${options.scriptPath}" --delay ${options.delaySeconds}`,
    // Cleanup before bootout: unloading kills this job's process tree, so anything
    // after it would never run (that is how a stale plist survived once).
    `rm -f "$HOME/Library/LaunchAgents/${label}.plist"`,
    `launchctl bootout gui/$(id -u)/${label} 2>/dev/null`,
    `echo "$(date '+%H:%M:%S') job finished" >> "${logFile}"`,
  ]
    .filter(Boolean)
    .join('; ')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>${xmlEscape(command)}</string></array>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${xmlEscape(os.homedir())}</string><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`
}

/** Where the restart helper is copied so launchd can read it. */
export function internalScriptPath() {
  return path.join(os.homedir(), 'Library/Application Support/dsh-wechat/restart-dsh.sh')
}

/** Where the LaunchAgent lives. */
export function plistPath(label = LABEL) {
  return path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)
}

/** Remove any pending restart job. */
export async function cancelRestart(label = LABEL) {
  await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${label}`]).catch(() => {})
  await rm(plistPath(label), { force: true })
}

/**
 * Install the LaunchAgent that will restart DSH after `delaySeconds`.
 * @param {{ delaySeconds?: number, force?: boolean, dryRun?: boolean }} [options] - scheduling options.
 * @returns {Promise<{ scheduled: boolean, delaySeconds: number, plist: string, script: string, log: string }>}
 */
export async function scheduleRestart(options = {}) {
  const delaySeconds = Math.max(1, options.delaySeconds ?? 10)
  const scriptTarget = internalScriptPath()
  const plist = plistPath()
  const log = path.join(os.homedir(), 'dsh-wechat-restart.log')

  if (options.dryRun) return { scheduled: false, delaySeconds, plist, script: scriptTarget, log }

  // The helper must be readable from an internal path: a launchd job cannot read a
  // repository living on an external volume.
  await mkdir(path.dirname(scriptTarget), { recursive: true })
  await copyFile(path.join(root, 'scripts/restart-dsh.sh'), scriptTarget)
  await chmod(scriptTarget, 0o755)

  await cancelRestart()
  await writeFile(plist, buildPlist({ scriptPath: scriptTarget, delaySeconds, force: options.force, logFile: log }))
  await run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plist])
  return { scheduled: true, delaySeconds, plist, script: scriptTarget, log }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(name)
  const value = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : fallback
  }
  try {
    if (flag('--cancel')) {
      await cancelRestart()
      console.log('已取消待执行的重启')
    } else {
      const result = await scheduleRestart({
        delaySeconds: Number(value('--delay', 10)),
        force: flag('--force'),
        dryRun: flag('--dry-run'),
      })
      if (result.scheduled) {
        console.log(`已安排重启：${result.delaySeconds} 秒后（launchd 任务，只执行一次）`)
        console.log(`  日志：${result.log}`)
        console.log('  取消：node scripts/schedule-restart.mjs --cancel')
      } else {
        console.log(`演练：将在 ${result.delaySeconds} 秒后重启`)
        console.log(`  plist：${result.plist}`)
        console.log(`  脚本副本：${result.script}`)
      }
    }
  } catch (error) {
    console.error(`schedule-restart failed: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
