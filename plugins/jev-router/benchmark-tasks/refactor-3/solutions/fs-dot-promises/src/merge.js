// Merging configs: a later file overrides an earlier one.
import { readConfigs } from './read-config.js'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * `over` laid over `base`: objects are merged key by key, all the way down; anything else in
 * `over`, an array included, replaces what `base` had. Neither argument is changed.
 */
export function deepMerge(base, over) {
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

/**
 * Reads the files in order and merges each over the ones before it.
 * @param {string[]} paths
 * @returns {Promise<object>} the merged config
 */
export async function mergeFiles(paths) {
  const configs = await readConfigs(paths)
  return configs.reduce(deepMerge, {})
}
