// Replaces the upstream "DeepSeek Harness" / "DSH" wording with "Kz-harness" in
// the few installed files whose text a person or a model actually sees: the tab
// title and product title, the sandbox-policy line injected into every prompt,
// the system prompt, the Web GUI note, the local-build badge and the Settings
// blurb. Everything else keeps its own name, including package names, DSH_HOME
// and the dsh CLI, so nothing breaks.
//
// Runs on every start (Start-KzH.ps1) because npx reinstalls these packages on a
// version change. It is a no-op once applied, and it names any target file an upgrade
// took away rather than renaming twelve of thirteen in silence: the app would keep the
// upstream text and nothing would say why. Each file it rewrites is copied to
// <name>.kzh-backup first, so one copy back undoes this without a reinstall.
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Word boundaries keep DSH_HOME, dsh-* package names and the dsh CLI out of this.
// The dashes go too: these files supply prompt text and UI labels, and this harness
// writes plain punctuation everywhere. Built from char codes so no dash appears here.
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)
const RULES = [
  [/DeepSeek Harness/g, 'Kz-harness'],
  [/\bDSH\b/g, 'Kz-harness'],
  // " word - word " reads the same; a dash with no space around it becomes one.
  [new RegExp('\\s*' + EM + '\\s*', 'g'), ', '],
  [new RegExp('\\s*' + EN + '\\s*', 'g'), ', '],
]

// Only files whose wording reaches a person or a model. Comments stay as they are.
const FILES = [
  'dsh-system-prompt/lib/index.js',              // "You are an AI agent powered by …"
  'dsh-sandbox-policy/lib/index.js',             // "Current … file policy: workspace-write"
  'dsh-web-app/lib/index.js',                    // "… Web GUI at <url>"
  'dsh-tool-cordis/lib/index.js',                // plugin tool descriptions
  'dsh-client-ui-layout/lib/client.js',          // product title
  'dsh-client-locale/lib/client.js',             // "DSH Local Build" badge
  'dsh-client-ui-settings-models/lib/client.js', // Settings -> Models blurb
  'dsh-client-connection/lib/client.js',
  'dsh-app-boot/lib/index.js',                   // the source-checkout note put into the prompt
  'dsh/lib/bin.js',                              // dsh --help
  'dsh-web-app/lib/startup.js',                  // dsh --profile web --help
  'dsh-web-frontend/dist/index.html',            // browser tab title
  'dsh-web-frontend/dist/manifest.webmanifest',  // installed-app name
]

/** Every @deepseek-ai folder this harness may be running from: the npx cache, then the profiles. */
function roots() {
  const out = []
  const cache = process.env.npm_config_cache
    || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache') : join(homedir(), '.npm'))
  const npx = join(cache, '_npx')
  if (existsSync(npx)) for (const d of readdirSync(npx)) out.push(join(npx, d, 'node_modules', '@deepseek-ai'))
  const profiles = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles')
  if (existsSync(profiles)) for (const d of readdirSync(profiles)) out.push(join(profiles, d, 'node_modules', '@deepseek-ai'))
  return out.filter(existsSync)
}

let changed = 0
let seen = 0
const missing = []
for (const root of roots()) {
  const here = FILES.filter((rel) => existsSync(join(root, rel)))
  // A root holding none of them is not an engine install: the web profile carries only
  // the subagent connectors. A root holding some but not all has lost files to an
  // upgrade, and those keep the upstream wording with nothing to show for it.
  if (here.length > 0 && here.length < FILES.length) {
    for (const rel of FILES) if (!here.includes(rel)) missing.push(join(root, rel))
  }
  for (const rel of here) {
    const file = join(root, rel)
    seen++
    const src = readFileSync(file, 'utf8')
    const out = RULES.reduce((s, [from, to]) => s.replace(from, to), src)
    if (out === src) continue
    // Written once, from the untouched file, so reverting never needs a reinstall. These
    // rewrites reach the system prompt, which is worth a way back that costs one copy.
    const backup = `${file}.kzh-backup`
    if (!existsSync(backup)) copyFileSync(file, backup)
    writeFileSync(file, out)
    changed++
  }
}
if (!seen) console.warn('patch-dsh-branding: no installed harness packages found; the app keeps its upstream wording.')
else {
  if (changed) console.log(`patch-dsh-branding: renamed in ${changed} file(s)`)
  if (missing.length) {
    console.warn(`patch-dsh-branding: ${missing.length} of ${FILES.length} target file(s) are gone, so those keep their upstream wording.`)
    for (const f of missing) console.warn(`  missing: ${f}`)
    console.warn('  The engine moved or renamed them. Re-read the list in this script.')
  }
}
