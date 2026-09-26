// Merges config files into one: node src/index.js <out> <file> [file...]
import { mergeFiles } from './merge.js'
import { saveConfig } from './save.js'

/**
 * Merges the config files at `paths`, in order, and writes the result to `out`.
 * @param {string[]} paths
 * @param {string} out
 * @returns {Promise<object>} the merged config
 */
export async function main(paths, out) {
  const merged = await mergeFiles(paths)
  await saveConfig(out, merged)
  return merged
}
