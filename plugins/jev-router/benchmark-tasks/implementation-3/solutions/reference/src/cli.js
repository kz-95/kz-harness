// The log tool: node src/cli.js <file> [options]; --help lists the options.
import { readFileSync } from 'node:fs'
import { USAGE, UsageError, parseArgs, sinceMoment } from './args.js'
import { LEVELS, filterEntries, parseLine } from './filter.js'
import { formatEntry } from './format.js'

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.file === null) throw new UsageError('a log file is required')
  if (options.level && !LEVELS.includes(options.level)) throw new UsageError(`--level expects one of ${LEVELS.join(', ')}`)
  const nowMs = process.env.LOG_NOW ? Date.parse(process.env.LOG_NOW) : Date.now()
  const sinceMs = options.since === null ? null : sinceMoment(options.since, nowMs)
  const entries = readFileSync(options.file, 'utf8').split(/\r?\n/).map(parseLine).filter(Boolean)
  for (const entry of filterEntries(entries, { level: options.level, sinceMs })) console.log(formatEntry(entry))
}

try {
  main(process.argv.slice(2))
} catch (err) {
  if (!(err instanceof UsageError)) throw err
  console.error(`error: ${err.message}`)
  process.exitCode = 2
}
