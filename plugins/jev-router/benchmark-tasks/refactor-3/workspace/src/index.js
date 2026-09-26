// Merges config files into one: node src/index.js <out> <file> [file...]
import { mergeFiles } from './merge.js'
import { saveConfig } from './save.js'

/**
 * Merges the config files at `paths`, in order, and writes the result to `out`.
 * callback(err, merged)
 * @param {string[]} paths
 * @param {string} out
 * @param {(err: Error|null, merged?: object) => void} callback
 */
export function main(paths, out, callback) {
  mergeFiles(paths, (err, merged) => {
    if (err) return callback(err)
    saveConfig(out, merged, (saveError) => {
      if (saveError) return callback(saveError)
      callback(null, merged)
    })
  })
}
