// Reading JSON config files.
import { readFile } from 'node:fs'

/**
 * Reads one JSON config file.
 * callback(err, config): err is the read error, or a SyntaxError naming the file when it is not JSON.
 * @param {string} path
 * @param {(err: Error|null, config?: object) => void} callback
 */
export function readConfig(path, callback) {
  readFile(path, 'utf8', (err, text) => {
    if (err) return callback(err)
    let config
    try {
      config = JSON.parse(text)
    } catch (parseError) {
      return callback(new SyntaxError(`${path}: ${parseError.message}`))
    }
    callback(null, config)
  })
}

/**
 * Reads several config files, one after another, in the order given.
 * callback(err, configs): the first error, or every config in order.
 * @param {string[]} paths
 * @param {(err: Error|null, configs?: object[]) => void} callback
 */
export function readConfigs(paths, callback) {
  const configs = []
  const next = (i) => {
    if (i === paths.length) return callback(null, configs)
    readConfig(paths[i], (err, config) => {
      if (err) return callback(err)
      configs.push(config)
      next(i + 1)
    })
  }
  next(0)
}
