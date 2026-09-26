// The command line of linecount.

export const USAGE = `Usage: node src/cli.js [options] <file>

Counts the lines of a text file.

Options:
  --verbose    print each step as it runs
  --blank      count blank lines too
  --help       print this text`

/**
 * Reads the arguments after `node src/cli.js`.
 * @param {string[]} argv
 * @returns {{ file: string|null, verbose: boolean, blank: boolean, help: boolean }}
 */
export function parseOptions(argv) {
  const options = { file: null, verbose: false, blank: false, help: false }
  for (const arg of argv) {
    if (arg === '--verbose') options.verbose = true
    else if (arg === '--blank') options.blank = true
    else if (arg === '--help') options.help = true
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else if (options.file === null) options.file = arg
    else throw new Error(`unexpected argument ${arg}`)
  }
  return options
}
