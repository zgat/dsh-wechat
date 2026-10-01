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
  '--port': 'port',
  '--bot-type': 'botType',
}

/** Flags that are simple switches. */
const BOOLEAN_FLAGS = {
  '--page': 'page',
  '--no-open': 'noOpen',
}

/**
 * Split a loose argument list into flags and positional arguments.
 * @param {string[]} argv - arguments after the command name.
 * @returns {{ flags: Record<string, string|number|boolean>, rest: string[] }}
 */
export function parseFlags(argv) {
  const flags = {}
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const valueFlag = VALUE_FLAGS[token]
    if (valueFlag !== undefined) {
      const value = argv[index + 1]
      // A missing value must not swallow the next flag: `--state-dir --page`
      // means the person forgot the directory, not that it is called "--page".
      if (value === undefined || value.startsWith('--')) continue
      index += 1
      flags[valueFlag] = valueFlag === 'port' || valueFlag === 'botType' ? Number(value) : value
      continue
    }
    const booleanFlag = BOOLEAN_FLAGS[token]
    if (booleanFlag !== undefined) {
      flags[booleanFlag] = true
      continue
    }
    rest.push(token)
  }
  return { flags, rest }
}
