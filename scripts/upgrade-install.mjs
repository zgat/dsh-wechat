/**
 * Install-side helpers for `upgrade.mjs`.
 *
 * They exist because of one specific trap: `pnpm` (and therefore `dsh plugin add`)
 * treats a `file:` dependency whose **version did not change** as already installed, so
 * rebuilding a tarball under the same version silently leaves the previous code in
 * place. The restart then loads stale code and the "upgrade" appears to do nothing.
 *
 * `verifyInstalled()` detects that state by comparing the installed files against the
 * tarball; `installFresh()` recovers from it by dropping the installed copy and forcing
 * pnpm to redo the link.
 *
 * @module scripts/upgrade-install
 */

import path from 'node:path'
import { rm } from 'node:fs/promises'

/** Files compared between the installed package and the tarball. */
const FINGERPRINT_FILES = ['package.json', 'lib/bridge.js', 'lib/approval.js', 'lib/index.js']

/** Where the bundled pnpm lives (the same one `dsh plugin` would use). */
export const BUNDLED_PNPM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs'

/**
 * Whether the installed copy differs from the tarball that was just built.
 * @param {object} options - inputs.
 * @param {string} options.profileDir - profile directory holding `node_modules`.
 * @param {string} options.tarball - the tarball that was just installed.
 * @param {(cmd: string, args: string[], options?: object) => Promise<{stdout: string}>} options.run - command runner.
 * @param {string} [options.packageName] - installed package name.
 * @returns {Promise<boolean>} true when the installed files are stale or missing.
 */
export async function verifyInstalled({ profileDir, tarball, run, packageName = 'dsh-wechat' }) {
  const installedDir = path.join(profileDir, 'node_modules', packageName)
  const { readFile } = await import('node:fs/promises')
  for (const relative of FINGERPRINT_FILES) {
    const installed = await readFile(path.join(installedDir, relative)).catch(() => null)
    if (!installed) return true
    const { stdout } = await run('tar', ['-xzOf', tarball, `package/${relative}`])
    if (stdout !== installed.toString()) return true
  }
  return false
}

/**
 * Force pnpm to relink the package from the tarball on disk.
 * @param {object} options - inputs.
 * @param {string} options.profileDir - profile directory to install into.
 * @param {string} options.tarball - tarball to install.
 * @param {(cmd: string, args: string[], options?: object) => Promise<unknown>} options.run - command runner.
 * @param {string} [options.packageName] - package name to replace.
 * @param {string} [options.pnpm] - path to the pnpm entry script.
 * @returns {Promise<void>} resolves once pnpm finished.
 */
export async function installFresh({ profileDir, tarball, run, packageName = 'dsh-wechat', pnpm = BUNDLED_PNPM }) {
  // Drop both the linked package and pnpm's virtual-store copy, so nothing can be reused.
  await rm(path.join(profileDir, 'node_modules', packageName), { recursive: true, force: true })
  const virtualStore = path.join(profileDir, 'node_modules/.pnpm')
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(virtualStore).catch(() => [])
  for (const entry of entries) {
    if (entry.includes(packageName)) {
      await rm(path.join(virtualStore, entry), { recursive: true, force: true })
    }
  }
  const { readFile, writeFile } = await import('node:fs/promises')
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[packageName] = `file:${tarball}`
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await run(process.execPath, [pnpm, 'install', '--force'], { cwd: profileDir })
}
