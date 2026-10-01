/**
 * Leveled logger with one stable prefix, so every line this plugin writes into
 * the DSH host log is greppable as `[dsh-wechat]`.
 *
 * @module dsh-wechat/log
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

/**
 * @param {string} level - one of silent|error|warn|info|debug.
 * @param {{ scope?: string, sink?: (...args: unknown[]) => void }} [options]
 * @returns {{ error: Function, warn: Function, info: Function, debug: Function, child: Function, level: string }}
 */
export function createLogger(level = 'info', options = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info
  const scope = options.scope ?? ''
  const sink = options.sink

  const emit = (name, method, args) => {
    if (LEVELS[name] > threshold) return
    const tag = scope ? `[dsh-wechat:${scope}]` : '[dsh-wechat]'
    if (sink) {
      sink(tag, ...args)
      return
    }
    const console_ = globalThis.console
    if (!console_) return
    ;(console_[method] ?? console_.log)(tag, ...args)
  }

  return {
    level,
    error: (...args) => emit('error', 'error', args),
    warn: (...args) => emit('warn', 'warn', args),
    info: (...args) => emit('info', 'log', args),
    debug: (...args) => emit('debug', 'log', args),
    child: (childScope) =>
      createLogger(level, {
        scope: scope ? `${scope}:${childScope}` : childScope,
        ...(sink ? { sink } : {}),
      }),
  }
}

/** A logger that discards everything; handy in tests. */
export const silentLogger = createLogger('silent')
