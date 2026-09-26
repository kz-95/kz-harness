// Counting the lines of a file.
import { readFileSync } from 'node:fs'

/**
 * How many lines `file` has, as a sentence. With `verbose`, each step is also written to `log`.
 * @param {string} file
 * @param {{ verbose?: boolean, blank?: boolean }} options
 * @param {(line: string) => void} [log]
 */
export function countLines(file, { verbose = false, blank = false }, log = console.log) {
  if (verbose) log(`debug: reading ${file}`)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const counted = blank ? lines : lines.filter((line) => line.trim() !== '')
  if (verbose) log(`debug: ${lines.length} lines, ${lines.length - counted.length} of them blank and not counted`)
  return `${counted.length} lines in ${file}`
}
