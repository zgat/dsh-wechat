/**
 * Small retry helper for filesystem operations.
 *
 * Windows is the reason this exists: `rename` over an existing file and `rm` of an
 * open file both fail with transient `EPERM`/`EBUSY` while an indexer, antivirus,
 * or an editor holds the handle. A short bounded retry turns those into a
 * successful write instead of a warning the operator cannot act on.
 *
 * @module dsh-wechat/retry
 */

/** Error codes worth retrying: the handle is temporarily held elsewhere. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE'])

/**
 * Run one filesystem operation, retrying transient failures.
 * @template T
 * @param {() => Promise<T>} operation - the operation to attempt.
 * @param {{ attempts?: number, delayMs?: number, platform?: string }} [options] - retry policy.
 * @returns {Promise<T>} the operation's result.
 * @throws The last error when every attempt fails.
 */
export async function withRetries(operation, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 4)
  const delayMs = Math.max(0, options.delayMs ?? 40)
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!TRANSIENT.has(error?.code)) throw error
      if (attempt === attempts) break
      // Deliberately *not* unref-ed: the caller is awaiting this operation, so a
      // process whose only pending work is the retry must still finish it. An
      // unref-ed timer here silently dropped the retry when nothing else was queued.
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
    }
  }
  throw lastError
}
