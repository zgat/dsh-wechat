/**
 * Argument parsing for `upgrade.mjs`, kept in its own module so the defaults are
 * testable without running the installer.
 *
 * The important default: **no restart**. Installing an update does not restart DSH by
 * itself; the new code takes effect on the next restart, and the person decides when
 * that happens (`--restart` asks for one, `--restart-delay N` implies it).
 *
 * @module scripts/upgrade-args
 */

/**
 * Parse `--flag value` pairs and the mode switch.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{ mode: 'gui'|'cli'|'check', profile: string, stateDir: string|null, open: boolean, restart: boolean, restartDelay: number }} parsed options.
 */
export function parseArgs(argv) {
  const options = { mode: null, profile: 'desktop', stateDir: null, open: false, restart: false, restartDelay: 10 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--via-gui') options.mode = 'gui'
    else if (token === '--via-cli') options.mode = 'cli'
    else if (token === '--check') options.mode = 'check'
    else if (token === '--open') options.open = true
    else if (token === '--restart') options.restart = true
    else if (token === '--no-restart') options.restart = false
    else if (token === '--restart-delay') {
      // Asking for a deadline implies wanting the restart.
      options.restart = true
      options.restartDelay = Number(argv[++index])
    } else if (token === '--profile') options.profile = argv[++index]
    else if (token === '--state-dir') options.stateDir = argv[++index]
    else throw new Error(`unknown argument: ${token}`)
  }
  if (options.mode === null) throw new Error('pass --via-gui, --via-cli or --check')
  return options
}
