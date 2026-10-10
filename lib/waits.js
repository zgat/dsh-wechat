/**
 * One abortable wait, shared by the login flow and the receive loop.
 *
 * @module dsh-wechat/waits
 */

/**
 * Sleep for a while, waking immediately when the signal aborts.
 *
 * The already-aborted case is checked up front on purpose: `addEventListener` on a
 * signal that has *already* aborted never fires, so relying on the listener alone
 * made teardown wait out the whole delay (a 60-second login retry, for instance).
 *
 * A short CLI command (the terminal QR login) can have no other handle keeping the
 * process alive, and an unref-ed timer then lets Node exit mid-retry — the operator sees
 * the prompt return silently instead of a retry. Such callers pass `keepAlive: true`.
 *
 * @param {number} ms - milliseconds to wait.
 * @param {AbortSignal} [signal] - cancels the wait.
 * @param {{ keepAlive?: boolean }} [options] - `keepAlive` keeps the event loop alive.
 * @returns {Promise<void>} resolves on timeout or abort.
 */
export function sleep(ms, signal, options = {}) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    if (!options.keepAlive && timer.unref) timer.unref()
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}
