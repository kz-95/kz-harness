// linecount: node src/cli.js [options] <file>; --help lists the options.
import { USAGE, parseOptions } from './options.js'
import { countLines } from './run.js'

function main(argv) {
  const options = parseOptions(argv)
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.file === null) throw new Error('a file is required')
  console.log(countLines(options.file, { verbose: options.verbose, blank: options.blank }))
}

try {
  main(process.argv.slice(2))
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exitCode = 2
}
