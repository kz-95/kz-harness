// Writing a config file.
import { mkdir, writeFile } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Writes `config` to `path` as JSON with two-space indentation and a final newline, making its
 * folder first when it does not exist.
 * callback(err, bytes): the error, or how many bytes were written.
 * @param {string} path
 * @param {object} config
 * @param {(err: Error|null, bytes?: number) => void} callback
 */
export function saveConfig(path, config, callback) {
  const text = `${JSON.stringify(config, null, 2)}\n`
  mkdir(dirname(path), { recursive: true }, (err) => {
    if (err) return callback(err)
    writeFile(path, text, 'utf8', (writeError) => {
      if (writeError) return callback(writeError)
      callback(null, Buffer.byteLength(text))
    })
  })
}
