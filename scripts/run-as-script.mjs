// Whether node was asked to run a script, rather than a test importing it, for the scripts in
// this folder: `if (runAsScript(import.meta.url)) { ... }`.
//
// Node gives the main module its real path, links resolved, while process.argv[1] keeps the path
// it was asked for, so the two are compared by their real paths: a harness folder reached through
// a link (a junction on Windows, C:\Harness pointing at D:\Harness, say) is still the same script.
// Compared as they were, the script would do nothing at all and exit 0, which a scheduled task
// reads as success. Case does not count on Windows.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function runAsScript(metaUrl, { argv1 = process.argv[1], platform = process.platform } = {}) {
  if (!argv1) return false
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  const [a, b] = [real(argv1), real(fileURLToPath(metaUrl))]
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
