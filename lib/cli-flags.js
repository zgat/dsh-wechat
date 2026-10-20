/**
 * Command-line flag parsing, kept out of the executable so it can be tested
 * without running the CLI.
 *
 * @module dsh-wechat/cli-flags
 */

/** Flags that take a value. */
const VALUE_FLAGS = {
  '--state-dir': 'stateDir',
  '--route-tag': 'routeTag',
  '--base-url': 'baseUrl',
  '--bot-type': 'botType',
}

/** Flags that are simple switches. */
const BOOLEAN_FLAGS = {
  '--help': 'help',
  '-h': 'help',
}

/**
 * Split a loose argument list into flags and positional arguments.
 * @param {string[]} argv - arguments after the command name.
 * @returns {{ flags: Record<string, string|number|boolean>, rest: string[], unknown: string[] }}
 */
export function parseFlags(argv) {
  const flags = {}
  const rest = []
  /** Flags nobody recognises: reported instead of silently ignored. */
  const unknown = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const valueFlag = VALUE_FLAGS[token]
    if (valueFlag !== undefined) {
      const value = argv[index + 1]
      // A missing value must not swallow the next flag: `--state-dir --base-url …`
      // means the person forgot the directory, not that it is called "--base-url".
      if (value === undefined || value.startsWith('--')) continue
      index += 1
      flags[valueFlag] = valueFlag === 'botType' ? Number(value) : value
      continue
    }
    const booleanFlag = BOOLEAN_FLAGS[token]
    if (booleanFlag !== undefined) {
      flags[booleanFlag] = true
      continue
    }
    if (token.startsWith('-')) {
      unknown.push(token)
      continue
    }
    rest.push(token)
  }
  return { flags, rest, unknown }
}
