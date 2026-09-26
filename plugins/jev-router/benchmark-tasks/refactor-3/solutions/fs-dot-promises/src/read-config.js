// Reading JSON config files.
import fs from 'node:fs'

/**
 * Reads one JSON config file.
 * Resolves to the config; rejects with the read error, or a SyntaxError naming the file when it is not JSON.
 * @param {string} path
 * @returns {Promise<object>}
 */
export async function readConfig(path) {
  const text = await fs.promises.readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (parseError) {
    throw new SyntaxError(`${path}: ${parseError.message}`)
  }
}

/**
 * Reads several config files, one after another, in the order given.
 * Resolves to every config in order; rejects with the first error.
 * @param {string[]} paths
 * @returns {Promise<object[]>}
 */
export async function readConfigs(paths) {
  const configs = []
  for (const path of paths) configs.push(await readConfig(path))
  return configs
}
