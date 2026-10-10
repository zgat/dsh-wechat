/**
 * Which build is running, and which build is on disk.
 *
 * The distinction matters here: DSH hot-applies profile *config* but keeps the
 * plugin module it already imported, so "installed" and "running" can differ until
 * the next restart. `/status` reports both instead of leaving it to inference.
 *
 * The on-disk version is read on **every** call: an upgrade replaces package.json under
 * a running process, and a cached value would make `/status` claim the old version is
 * still installed — exactly the comparison the command exists to make.
 *
 * @module dsh-wechat/version
 */

import { readFile } from 'node:fs/promises'

/**
 * Read the version recorded in a package.json.
 * @param {URL|string} file - package.json location.
 * @returns {Promise<string|null>} the version, or null when unreadable.
 */
export async function readVersionFrom(file) {
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Read the version of the installed package.
 * @returns {Promise<string|null>} the version, or null when unreadable.
 */
export async function installedVersion() {
  return readVersionFrom(new URL('../package.json', import.meta.url))
}

/**
 * Kept for callers that used to invalidate the cache (there is none any more).
 * @returns {void}
 */
export function forgetInstalledVersion() {}
