// Adds three things to the composer's model menu: a search box that filters the rows, a
// bookmark star per row that pins favourites to the top, and a taller list that scrolls
// rather than running off the screen. That menu is the engine's own ModelSelect
// component (@deepseek-ai/dsh-client-ui-model-selection), and its slot
// `conversation.input.model` is single and already occupied, so no plugin of ours can
// reach it: editing the installed file is the only way in. Those files live in the npx
// cache, outside this repo and gitignored, so nothing here is committed.
//
// Runs on every start (Start-KzH.ps1) because npx reinstalls these packages on a version
// change, which is also what restores the original. The pre-patch file is kept beside it
// as client.js.kzh-backup, so copying that one file back reverts this without a reinstall
// (drop the line in Start-KzH.ps1 too, or the next launch patches it again).
//
// Two things this script will not do: apply twice, and guess. The engine version is
// pinned in Start-KzH.ps1 and checked here, and every anchor below must match the
// installed file exactly; one missing anchor names itself and nothing is written at all.
// A patch that quietly did nothing after an engine upgrade is the worst outcome, because
// the user would go on believing the feature is there. It still exits 0 like its
// siblings: a menu nicety must not stop the harness from starting.
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The version this patch was read against. Keep it equal to $DshVersion in Start-KzH.ps1.
const WRITTEN_FOR = '0.1.5-rc.2'
const PKG = 'dsh-client-ui-model-selection'
const REL = `${PKG}/lib/client.js`
// Present in the patched file and nowhere else: this is the already-applied check.
const MARKER = 'KZH_MODEL_MENU'

// The injected code is indented with tabs to match the file it lands in, so its lines are
// built rather than pasted: I(depth, text) is one line at that tab depth.
const I = (depth, text) => '\t'.repeat(depth) + text
const lines = (...rows) => rows.join('\n')

// The helpers the patched component calls, injected just above ModelSelect so they see
// the module's own react and jsx bindings and the CSS class map.
const HELPERS = `\t\t//#region kzh: composer model menu extras (scripts/patch-dsh-model-menu.mjs)
\t\t/* ${MARKER}: this file is patched. */
\t\t/**
\t\t* Bookmarks live in the app origin's localStorage. The alternative, our own
\t\t* /jev-router endpoints, would make engine code depend on a plugin it knows nothing
\t\t* about and would lose the list with that plugin; the app is one local origin and one
\t\t* user, and localStorage outlives both this patch and an engine reinstall.
\t\t*/
\t\tconst KZH_MARKS_KEY = "kzh.modelBookmarks";
\t\tfunction kzhReadMarks() {
\t\t\ttry {
\t\t\t\tconst raw = JSON.parse(window.localStorage.getItem(KZH_MARKS_KEY) ?? "[]");
\t\t\t\treturn Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
\t\t\t} catch {
\t\t\t\treturn [];
\t\t\t}
\t\t}
\t\tfunction kzhWriteMarks(marks) {
\t\t\ttry {
\t\t\t\twindow.localStorage.setItem(KZH_MARKS_KEY, JSON.stringify(marks));
\t\t\t} catch {}
\t\t}
\t\tfunction kzhKey(groupId, modelId) {
\t\t\treturn \`\${groupId}/\${modelId}\`;
\t\t}
\t\t/**
\t\t* The rendered view of the catalog: rows the query matches, bookmarked rows first
\t\t* within their group, and groups holding a bookmark first. Rows stay inside their own
\t\t* group so \`group.id\` remains the provider the selection is sent with.
\t\t*/
\t\tfunction kzhArrange(groups, query, marks) {
\t\t\tconst q = query.trim().toLowerCase();
\t\t\tconst shown = [];
\t\t\tfor (const group of groups) {
\t\t\t\tconst rows = group.models.filter((model) => q === "" || \`\${model.name} \${group.name}\`.toLowerCase().includes(q));
\t\t\t\tif (rows.length === 0) continue;
\t\t\t\tconst marked = rows.filter((model) => marks.includes(kzhKey(group.id, model.id)));
\t\t\t\tshown.push({
\t\t\t\t\t...group,
\t\t\t\t\tmodels: [...marked, ...rows.filter((model) => !marked.includes(model))],
\t\t\t\t\tkzhPinned: marked.length > 0
\t\t\t\t});
\t\t\t}
\t\t\treturn [...shown.filter((group) => group.kzhPinned), ...shown.filter((group) => !group.kzhPinned)];
\t\t}
\t\t/** The filter box. Arrow keys fall through to the menu's own handler, so the list stays keyboard navigable. */
\t\tfunction kzhSearch(id, query, setQuery, empty) {
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: "kzh-search",
\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("label", {
\t\t\t\t\thtmlFor: \`\${id}-kzh-search\`,
\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: "kzh-hidden",
\t\t\t\t\t\tchildren: "Search models"
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("input", {
\t\t\t\t\t\tid: \`\${id}-kzh-search\`,
\t\t\t\t\t\tclassName: "kzh-search-input",
\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\tplaceholder: "Search models",
\t\t\t\t\t\tautoComplete: "off",
\t\t\t\t\t\tspellCheck: false,
\t\t\t\t\t\tautoFocus: true,
\t\t\t\t\t\tvalue: query,
\t\t\t\t\t\tonChange: (event) => {
\t\t\t\t\t\t\tsetQuery(event.target.value);
\t\t\t\t\t\t}
\t\t\t\t\t})]
\t\t\t\t}), empty && (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tclassName: "kzh-search-empty",
\t\t\t\t\tchildren: "No model matches."
\t\t\t\t})]
\t\t\t});
\t\t}
\t\t/** One row: the engine's own button, with the bookmark toggle beside it, because a button cannot nest a button. */
\t\tfunction kzhRow(group, model, marks, toggle, row) {
\t\t\tconst key = kzhKey(group.id, model.id);
\t\t\tconst marked = marks.includes(key);
\t\t\tconst label = marked ? \`Remove bookmark from \${model.name}\` : \`Bookmark \${model.name}\`;
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: "kzh-row",
\t\t\t\tchildren: [row, (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\ttype: "button",
\t\t\t\t\tclassName: "kzh-star",
\t\t\t\t\t"aria-pressed": marked,
\t\t\t\t\t"aria-label": label,
\t\t\t\t\ttitle: label,
\t\t\t\t\tonClick: () => {
\t\t\t\t\t\ttoggle(key);
\t\t\t\t\t},
\t\t\t\t\tchildren: marked ? "\\u2605" : "\\u2606"
\t\t\t\t})]
\t\t\t}, model.id);
\t\t}
\t\t/* Every colour is one of the app's own theme variables, so light and dark both follow.
\t\t   The menu cap goes from about 9 rows to about 15, still clamped to the viewport. */
\t\tif (typeof document !== "undefined" && document.querySelector("style[data-kzh-css=model-menu]") === null) {
\t\t\tconst kzhTag = document.createElement("style");
\t\t\tkzhTag.dataset.kzhCss = "model-menu";
\t\t\tkzhTag.textContent = \`
.\${ModelSelect_module_css_default.menu}{max-height:min(660px,100vh - 96px)}
.kzh-row{display:flex;align-items:center;gap:2px}
.kzh-row>:first-child{flex:1 1 auto;min-width:0}
.kzh-star{flex:none;width:26px;height:26px;padding:0;display:grid;place-items:center;background:0 0;border:none;border-radius:8px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}
.kzh-star:hover,.kzh-star:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);outline:none}
.kzh-star[aria-pressed=true]{color:var(--dsw-alias-label-primary)}
.kzh-search{padding:2px 4px 6px}
.kzh-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;clip:rect(0 0 0 0);white-space:nowrap;overflow:hidden}
.kzh-search-input{box-sizing:border-box;width:100%;height:30px;padding:0 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;outline:none}
.kzh-search-input:focus{border-color:var(--dsw-alias-border-l3)}
.kzh-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.kzh-search-empty{padding:8px 10px 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
\`;
\t\t\tdocument.head.appendChild(kzhTag);
\t\t}
\t\t//#endregion
`

// Every edit, in file order. `from` is quoted exactly as the installed file has it, tabs
// and all, and is named so a mismatch can say which one went.
const EDITS = [
  {
    name: 'ModelSelect declaration (the helpers go above it)',
    from: I(2, 'function ModelSelect({ locked, available, directory, load, select, t }) {'),
    to: HELPERS + I(2, 'function ModelSelect({ locked, available, directory, load, select, t }) {')
  },
  {
    name: 'pane state (the query and the bookmarks join it)',
    from: I(3, 'const [pane, setPane] = (0, react.useState)("root");'),
    to: lines(
      I(3, 'const [pane, setPane] = (0, react.useState)("root");'),
      I(3, 'const [kzhQuery, setKzhQuery] = (0, react.useState)("");'),
      I(3, 'const [kzhMarks, setKzhMarks] = (0, react.useState)(kzhReadMarks);'),
      I(3, 'const kzhToggle = (key) => {'),
      I(4, 'setKzhMarks((marks) => {'),
      I(5, 'const next = marks.includes(key) ? marks.filter((id) => id !== key) : [...marks, key];'),
      I(5, 'kzhWriteMarks(next);'),
      I(5, 'return next;'),
      I(4, '});'),
      I(3, '};'),
      I(3, '// A filter left behind from the last time the menu was open would hide rows the user never ruled out.'),
      I(3, '(0, react.useEffect)(() => {'),
      I(4, 'if (!open) setKzhQuery("");'),
      I(3, '}, [open]);')
    )
  },
  {
    name: 'menu placement dependencies (the card follows the list as it shrinks)',
    from: lines(I(3, '}, ['), I(4, 'open,'), I(4, 'pane,'), I(4, 'state'), I(3, ']);')),
    to: lines(I(3, '}, ['), I(4, 'open,'), I(4, 'pane,'), I(4, 'state,'), I(4, 'kzhQuery,'), I(4, 'kzhMarks'), I(3, ']);'))
  },
  {
    name: 'model list container (search box above it, arranged rows inside)',
    from: lines(
      I(8, '(0, react_jsx_runtime.jsx)("div", {'),
      I(9, 'className: clsx(ModelSelect_module_css_default.groups, "scrollable"),'),
      I(9, 'children: state.groups.map((group) => {')
    ),
    to: lines(
      I(8, 'kzhSearch(id, kzhQuery, setKzhQuery, kzhQuery.trim() !== "" && kzhArrange(state.groups, kzhQuery, kzhMarks).length === 0),'),
      I(8, '(0, react_jsx_runtime.jsx)("div", {'),
      I(9, 'className: clsx(ModelSelect_module_css_default.groups, "scrollable"),'),
      I(9, 'children: kzhArrange(state.groups, kzhQuery, kzhMarks).map((group) => {')
    )
  },
  {
    name: 'model row opening (wrapped so the star can sit beside it)',
    from: lines(
      I(12, 'const selected = state.current?.provider === group.id && state.current.model === model.id;'),
      I(12, 'return (0, react_jsx_runtime.jsxs)("button", {')
    ),
    to: lines(
      I(12, 'const selected = state.current?.provider === group.id && state.current.model === model.id;'),
      I(12, 'return kzhRow(group, model, kzhMarks, kzhToggle, (0, react_jsx_runtime.jsxs)("button", {')
    )
  },
  {
    name: 'model row closing (the wrapper now carries the row key)',
    from: lines(I(13, '})]'), I(12, '}, model.id);')),
    to: lines(I(13, '})]'), I(12, '}));'))
  }
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

/**
 * Apply every edit to one installed copy, or refuse and say why.
 * @returns 'missing', 'applied' when the marker is already there, 'patched', or the reason it was not.
 */
function patch(root) {
  const file = join(root, REL)
  if (!existsSync(file)) return 'missing'
  const src = readFileSync(file, 'utf8')
  if (src.includes(MARKER)) return 'applied'

  let version
  try { version = JSON.parse(readFileSync(join(root, PKG, 'package.json'), 'utf8')).version } catch { version = undefined }
  // Another engine version is other code, and matching patterns blindly into it is how a
  // patch ends up half applied. Say so and leave the menu alone.
  if (version !== WRITTEN_FOR) return `${PKG} ${version ?? 'unknown'} is installed, this patch was written against ${WRITTEN_FOR}`

  const nl = src.includes('\r\n') ? '\r\n' : '\n'
  const eol = (text) => text.replace(/\r?\n/g, nl)
  let out = src
  for (const edit of EDITS) {
    const from = eol(edit.from)
    const at = out.indexOf(from)
    if (at === -1) return `anchor not found: ${edit.name}`
    // Two matches would make the edit a coin toss, so that fails here too.
    if (out.indexOf(from, at + 1) !== -1) return `anchor matched more than once: ${edit.name}`
    out = out.slice(0, at) + eol(edit.to) + out.slice(at + from.length)
  }
  // Written once, from the untouched file, so reverting never needs a reinstall.
  const backup = `${file}.kzh-backup`
  if (!existsSync(backup)) copyFileSync(file, backup)
  writeFileSync(file, out)
  return 'patched'
}

const found = roots().map((root) => ({ root, result: patch(root) })).filter((r) => r.result !== 'missing')
const failed = found.filter((r) => r.result !== 'patched' && r.result !== 'applied')
const patched = found.filter((r) => r.result === 'patched')
if (found.length === 0) console.warn('patch-dsh-model-menu: no installed harness packages found; the model menu stays as it ships.')
else if (failed.length > 0) {
  console.error('patch-dsh-model-menu: NOT APPLIED. Nothing was written.')
  for (const f of failed) console.error(`  ${f.result}`)
  for (const f of failed) console.error(`  file: ${join(f.root, REL)}`)
  console.error('  The model menu has no search box and no bookmarks. Re-read ModelSelect and update this script.')
} else if (patched.length > 0) console.log(`patch-dsh-model-menu: search, bookmarks and a taller list added in ${patched.length} file(s)`)
