// The command line of the log tool: node src/cli.js <file> [options]

export const USAGE = `Usage: node src/cli.js <file> [options]

Prints the lines of a log file, each as <time> <LEVEL> <text>.

Options:
  --level <level>  only lines at this level or above: DEBUG, INFO, WARN or ERROR
  --help           print this text`

/** A mistake on the command line: the tool prints it and exits with code 2. */
export class UsageError extends Error {}

/**
 * Reads the arguments after `node src/cli.js`.
 * @param {string[]} argv
 * @returns {{ file: string|null, level: string|null, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { file: null, level: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help') {
      options.help = true
    } else if (arg === '--level') {
      const value = argv[++i]
      if (!value) throw new UsageError('--level expects a level')
      options.level = value.toUpperCase()
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
