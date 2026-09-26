// The command line of the log tool: node src/cli.js <file> [options]

export const USAGE = `Usage: node src/cli.js <file> [options]

Prints the lines of a log file, each as <time> <LEVEL> <text>.

Options:
  --level <level>  only lines at this level or above: DEBUG, INFO, WARN or ERROR
  --since <when>   only lines at or after <when>: an ISO date-time such as 2026-09-20T12:00:00Z,
                   or an age such as 30m, 12h or 3d, counted back from LOG_NOW or the current time
  --help           print this text`

/** A mistake on the command line: the tool prints it and exits with code 2. */
export class UsageError extends Error {}

const SINCE_ERROR = '--since expects an ISO date-time or an age like 12h'
const AGE_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * The moment a --since value names, in milliseconds: an ISO date-time, or an age counted back
 * from `nowMs`. Throws a UsageError for anything else.
 */
export function sinceMoment(value, nowMs) {
  const age = /^(\d+)([mhd])$/.exec(value ?? '')
  if (age) return nowMs - Number(age[1]) * AGE_MS[age[2]]
  if (ISO.test(value ?? '')) {
    const at = Date.parse(value)
    if (!Number.isNaN(at)) return at
  }
  throw new UsageError(SINCE_ERROR)
}

/**
 * Reads the arguments after `node src/cli.js`.
 * @param {string[]} argv
 * @returns {{ file: string|null, level: string|null, since: string|null, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { file: null, level: null, since: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help') {
      options.help = true
    } else if (arg === '--level') {
      const value = argv[++i]
      if (!value) throw new UsageError('--level expects a level')
      options.level = value.toUpperCase()
    } else if (arg === '--since') {
      const value = argv[++i]
      if (!value) throw new UsageError(SINCE_ERROR)
      options.since = value
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option ${arg}`)
    } else if (options.file === null) {
      options.file = arg
    } else {
      throw new UsageError(`unexpected argument ${arg}`)
    }
  }
  return options
}
