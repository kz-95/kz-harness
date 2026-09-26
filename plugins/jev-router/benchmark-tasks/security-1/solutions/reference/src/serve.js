// Serving the files of a public folder.
import { existsSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * The file to serve for a request: its path on disk, or null when the request names no file in
 * `root`.
 *
 * @param {string} root     the folder the public files are in
 * @param {string} urlPath  the path part of the request's URL, still percent-encoded, such as
 *                          /css/site.css or index.html
 * @returns {string|null}
 */
export function resolveRequest(root, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  // Both slashes are separators on every OS, and the path is always taken from the root down.
  const base = resolve(root)
  const file = resolve(base, `.${sep}${decoded.split(/[\\/]+/).join(sep)}`)
  const inside = relative(base, file)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || resolve(base, inside) !== file) return null
  return existsSync(file) && statSync(file).isFile() ? file : null
}
