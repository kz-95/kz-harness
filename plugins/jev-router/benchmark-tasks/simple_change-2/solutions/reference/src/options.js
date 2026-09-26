// The command line of linecount.

export const USAGE = `Usage: node src/cli.js [options] <file>

Counts the lines of a text file.

Options:
  --debug      print each step as it runs
  --blank      count blank lines too
  --help       print this text`

/**
 * Reads the arguments after `node src/cli.js`. `--verbose` is the old name of `--debug`, and
 * `deprecated` says it was used.
 * @param {string[]} argv
 * @returns {{ file: string|null, debug: boolean, blank: boolean, help: boolean, deprecated: boolean }}
 */
export function parseOptions(argv) {
  const options = { file: null, debug: false, blank: false, help: false, deprecated: false }
  for (const arg of argv) {
    if (arg === '--debug') options.debug = true
    else if (arg === '--verbose') { options.debug = true; options.deprecated = true }
    else if (arg === '--blank') options.blank = true
    else if (arg === '--help') options.help = true
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else if (options.file === null) options.file = arg
    else throw new Error(`unexpected argument ${arg}`)
  }
  return options
}
