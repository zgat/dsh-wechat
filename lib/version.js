/**
 * Which build is running, and which build is on disk.
 *
 * The distinction matters here: DSH hot-applies profile *config* but keeps the
 * plugin module it already imported, so "installed" and "running" can differ until
 * the next restart. `/status` reports both instead of leaving it to inference.
 *
 * @module dsh-wechat/version
 */

import { readFile } from 'node:fs/promises'

/** @type {string|null} */
let cached = null

/**
 * Read the version of the installed package (cached after the first read).
 * @returns {Promise<string|null>} the version, or null when unreadable.
 */
export async function installedVersion() {
  if (cached !== null) return cached
  try {
    const text = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    cached = JSON.parse(text).version ?? null
  } catch {
    cached = null
  }
  return cached
}

/**
 * Forget the cached version (used by tests that swap the file).
 * @returns {void}
 */
export function forgetInstalledVersion() {
  cached = null
}
