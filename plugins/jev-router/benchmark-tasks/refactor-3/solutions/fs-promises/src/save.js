// Writing a config file.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes `config` to `path` as JSON with two-space indentation and a final newline, making its
 * folder first when it does not exist.
 * @param {string} path
 * @param {object} config
 * @returns {Promise<number>} how many bytes were written
 */
export async function saveConfig(path, config) {
  const text = `${JSON.stringify(config, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return Buffer.byteLength(text)
}
