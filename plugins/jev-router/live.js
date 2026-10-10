// The live view of each agent's work (docs/live-agent-view.md Feature 1): what a routed run is doing
// as it does it, kept in memory for the Live tab, the card under a start reply, the work board's
// second line and the Tasks tab, and saved per task once a run ends, so the transcript outlasts a
// restart. Nothing here is on the run's critical path: the router's milestones and each agent's own
// stream feed it, never `onEvent`, `tasks.applyEvent`, `tasks.jsonl` or a task's output, so a feed
// that fails or falls behind changes no run.
//
// Three feeds reach a run, each through its own door:
// - the router's milestones (`router(runId, e)`): routed, attempts, checks, review, limit, error,
//   final and access, which say where the run stands between agents;
// - a spawn child's own stream (DeepSeek, an API-key agent, a local model), through a handle per
//   attempt (`attempt(runId, index)`): the agent-scoped `agent/assistant-stream` frames as they
//   stream (`frame`), and the committed session events a pump reads beside them (`events`), so a
//   listener that fails still leaves per-step detail;
// - Claude Code and Codex, through the engine patch (scripts/patch-agent-live.mjs): the patched
//   connector calls the attempt's tap (`tapFor(handle)`) with each Agent SDK message or app-server
//   notification its run reads, which the handle projects into items as it does a spawn child's; an
//   attempt whose connector is not patched says its live detail is off, and why.
// Each attempt gets its own handle, so a read pass beside a writer and a parallel opinion never mix.
//
// The store is bounded: 1500 items and 768 KiB of text per run, 64 KiB of head and tail per item,
// 40 finished runs, the least recently used evicted first (of a task's, a few numbers each are kept,
// for its done line), and one `Older steps dropped` marker for a run that overflowed. Every change
// bumps one store-wide `v`, and a read returns only the items changed since the `v` it is given.
// Text is read and saved through redactSecrets (export.js), and a projector copies what it is given
// and never writes into it: the connectors read the same messages again after it. Input it cannot
// read raises `dropped` and never throws.
//
// A task's runs are saved to `<dir>/<key>.jsonl` as each ends, compacted and capped at 256 KiB, a
// run the store has let go of since kept as the file had it, and read back for the Live tab after a
// restart; a truncated last line is skipped. `drop(key)` deletes the file when the task leaves the
// task list. Once the store is disposed of, as the plugin closes, it saves and deletes nothing more,
// unless the plugin applied again on the same data folder reopens it to go on with it (handover.js):
// what it was asked to save or delete in between is done then.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { line } from './adapter.js'
import { redactSecrets } from './export.js'
import { TEACHER, providerName } from './providers.js'
import { pickedBy } from './router.js'

/** The bounds of the store; createLiveStore's `caps` may set any of them. */
export const LIVE_CAPS = Object.freeze({
  // Items, and characters of text, one run keeps.
  items: 1500,
  runChars: 768 * 1024,
  // Characters of an item's text kept at its head, and again at its tail.
  itemChars: 64 * 1024,
  // Characters of an item's text one read returns, from its end.
  readChars: 16 * 1024,
  // Characters of a tool's own output kept, where the row says what it did (a sub-agent's answer).
  toolChars: 8 * 1024,
  // Finished runs kept in memory; a live run is never evicted.
  finished: 40,
  // A task's passes the store has let go of whose time, tool calls and tokens are still kept, a few
  // numbers each, so its done line counts every pass (activityOfRuns); the oldest go first.
  spent: 1000,
  // Bytes of a task's saved transcript.
  savedBytes: 256 * 1024,
  // Characters of a Codex attempt's `Files changed`, each turn's whole diff, kept as they come.
  filesChars: 256 * 1024,
})

/**
 * When a run reads as stalled, and how it reads as alive (the Strata study's heartbeat): a command
 * open past `commandMs`, an agent silent past `silenceMs` with nothing open (no call of any tool
 * still running), `quiet for N s` once nothing has moved for `quietMs`, a newest change younger
 * than `freshMs`, and a token rate over the last `rateMs`.
 */
export const LIVE_TIMES = Object.freeze({ commandMs: 60_000, silenceMs: 90_000, quietMs: 10_000, freshMs: 5_000, rateMs: 2_000 })

// Roughly how many characters one token of streamed text is, for the rate of a stream that does not
// count its own tokens as it goes.
const CHARS_PER_TOKEN = 4
const KEY = /^[\w-]{1,80}$/

// ---- words --------------------------------------------------------------------------------------

/** A span of time as the live view says it: `45s`, `3m 05s`, `1h 02m`. */
export function spanWords(ms) {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000))
  if (s < 60) return `${s}s`
  const pad = (n) => String(n).padStart(2, '0')
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
}

/** What a run that ended came to, in the task list's words for it (adapter.js TASK_LABELS). */
const END_LABELS = Object.freeze({
  answered: 'Completed', needs_human: 'Needs input', paused_limit: 'Paused by limit', limit_reached: 'Failed', failed: 'Failed', stopped: 'Stopped',
  // A read pass that hands its task back to its folder's line ends without a status of its own.
  needs_write: 'Handed back to its folder\'s line',
})
/** A run's end in words, from its final status (router.js), or how it ended without one. */
export const endLabel = (status) => (String(status ?? '').startsWith('accepted') ? 'Completed' : END_LABELS[status] ?? 'Finished')

/** What the decider's review of an attempt came to, in a few words. */
const REVIEW_WORDS = Object.freeze({ accept: 'accepted', retry: 'changes requested', second_review: 'a second review asked for', human: 'needs a person' })

// What a tool does, by the names DSH's own tools have (dsh-client-ui-tool: read, write, edit,
// str_replace_editor, grep, glob, web_search, web_fetch) and the ones Claude Code's and others'
// have, matched without case: each kind has the phrase the activity line reads and the words of
// its row.
const TOOL_KINDS = [
  ['read', /^(read|read_file|read_image|ls|list|list_dir|list_directory|view|cat)$/],
  ['search', /^(grep|glob|search|find|search_files|codebase_search)$/],
  ['edit', /^(edit|multiedit|multi_edit|write|write_file|create_file|str_replace_editor|str_replace|apply_patch|notebookedit|notebook_edit)$/],
  ['command', /^(bash|shell|sh|run|run_shell|run_command|exec|execute|execute_command|terminal|powershell|cmd)$/],
  ['web', /^(web_search|websearch|web_fetch|webfetch|fetch|browse)$/],
  ['delegate', /^(task|agent|subagent|spawn_agent|dispatch_agent|delegate)$/],
  ['plan', /^(todo_write|todowrite|todo|update_plan|plan)$/],
]
/** What kind of tool a name is: read, search, edit, command, web, delegate, plan, or other. */
export const toolKindOf = (name) => TOOL_KINDS.find(([, re]) => re.test(String(name ?? '').trim().toLowerCase()))?.[0] ?? 'other'

// Text on one line, its first `n` characters, with an ellipsis when there was more.
const oneLine = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
// What an agent gave, quoted on one line: redacted before it is cut, so a cut never leaves part of a
// key too short for redactSecrets to know.
const quote = (s, n) => oneLine(redactSecrets(String(s ?? '')), n)
const argOf = (args, ...names) => { for (const n of names) if (typeof args?.[n] === 'string' && args[n].trim()) return args[n]; return '' }
const parseArgs = (raw) => { if (raw && typeof raw === 'object') return raw; try { const v = JSON.parse(String(raw ?? '')); return v && typeof v === 'object' ? v : null } catch { return null } }
const commandOf = (args) => argOf(args, 'command', 'cmd', 'script', 'commandLine') || (Array.isArray(args?.command) ? args.command.join(' ') : '')
const pathOf = (args) => argOf(args, 'file_path', 'path', 'filePath', 'notebook_path', 'target_file', 'file')

/**
 * A tool call's row as the timeline shows it, from its name and arguments: `Read src/app.ts`,
 * `Searched for useTasks`, `Ran npm test`, with `done` false while it still runs.
 */
export function toolTitle(name, args, done = true) {
  const kind = toolKindOf(name)
  const a = parseArgs(args) ?? {}
  const verb = (doing, did) => (done ? did : doing)
  if (kind === 'read') { const p = pathOf(a); return `${verb('Reading', 'Read')} ${p ? quote(p, 80) : 'the code'}` }
  if (kind === 'search') { const q = argOf(a, 'pattern', 'query', 'regex', 'glob'); return q ? `${verb('Searching', 'Searched')} for ${quote(q, 60)}` : `${verb('Searching', 'Searched')} the code` }
  if (kind === 'edit') { const p = pathOf(a); return `${verb('Editing', 'Edited')} ${p ? quote(p, 80) : 'a file'}` }
  if (kind === 'command') { const c = commandOf(a); return `${verb('Running', 'Ran')} ${c ? quote(c, 80) : 'a command'}` }
  if (kind === 'web') { const q = argOf(a, 'query', 'url', 'q'); return `${verb('Searching', 'Searched')} the web${q ? ` for ${quote(q, 60)}` : ''}` }
  if (kind === 'delegate') { const what = argOf(a, 'description', 'prompt'); return `${verb('Delegating', 'Delegated')} to a sub-agent${what ? `: ${quote(what, 60)}` : ''}` }
  if (kind === 'plan') return verb('Planning next steps', 'Updated the plan')
  const first = Object.values(a).find((v) => typeof v === 'string' && v.trim())
  return `${quote(name || 'tool', 40)}${first ? ` ${quote(first, 60)}` : ''}`
}

/** What an agent is doing while this item is its newest, as the activity line says it (the phrase table). */
export function phraseOf(item) {
  if (!item) return null
  if (item.kind === 'reasoning') return 'Thinking'
  if (item.kind === 'text') return item.meta?.final ? 'Writing its answer' : 'Writing'
  // A status that is still going says itself: `Retrying the model (attempt 2, in 5 s)`.
  if (item.kind === 'status' && item.state === 'running') return item.title || null
  // A call that has come back leaves the model to read what it gave: thinking, until it says more.
  if (item.state !== 'running') return item.kind === 'status' || item.kind === 'error' ? null : 'Thinking'
  if (item.kind === 'plan') return 'Planning next steps'
  if (item.kind === 'command') return `Running a command: ${oneLine(item.meta?.command ?? '', 60)}`
  if (item.kind === 'file') return `Editing ${item.meta?.path ?? 'a file'}`
  if (item.kind !== 'tool') return null
  // A call still streaming its arguments is named by its tool alone, which says what kind of call
  // it is, though not yet its file or its command: an edit's whole new text can take a while.
  const kind = toolKindOf(item.meta?.name)
  if (kind === 'read') return 'Reading the code'
  if (kind === 'search') return 'Searching the code'
  if (kind === 'edit') return 'Editing a file'
  if (kind === 'command') return 'Running a command'
  if (kind === 'web') return 'Searching the web'
  if (kind === 'delegate') return 'Delegating to a sub-agent'
  if (kind === 'plan') return 'Planning next steps'
  return `Using ${item.meta?.name ?? 'a tool'}`
}

/**
 * Why a live run reads as stalled, or null: a command open past a minute (`Waiting on a command for
 * 3m 05s: npm test`), or an agent with live detail that has said nothing for 90 s while nothing of
 * it is open (`No news from DeepSeek agent for 1m 30s. ...`). A call of any tool still running
 * (`busy`: a sub-agent it waits for, a slow fetch) counts as open: the agent waits on it, and is not
 * thinking. It never says stuck: a long command or a long think is not one. The browser says the
 * same from the same facts (client.js stallWords).
 */
export function stallOf({ open, lastAgentAt, agent, live, busy = false }, now, times = LIVE_TIMES) {
  if (open && now - open.since > times.commandMs) return { kind: 'command', ms: now - open.since, words: `Waiting on a command for ${spanWords(now - open.since)}: ${oneLine(open.command, 60)}` }
  if (live && !open && !busy && Number.isFinite(lastAgentAt) && now - lastAgentAt > times.silenceMs) return { kind: 'silence', ms: now - lastAgentAt, words: `No news from ${agent ?? 'the agent'} for ${spanWords(now - lastAgentAt)}. It may still be thinking; Stop is on this row.` }
  return null
}

// ---- text kept per item ----------------------------------------------------------------------------
// An item's text is its head, up to the item cap, then its tail as a list of chunks, joined on read,
// so a stream of small deltas costs no copy of the whole text each time. Past twice the cap the tail
// is cut to the cap, and what went is counted.

const newText = () => ({ head: '', chunks: [], len: 0, cut: 0 })
function appendText(t, s, cap) {
  let rest = String(s ?? '')
  if (!rest) return
  if (t.head.length < cap) { const take = rest.slice(0, cap - t.head.length); t.head += take; rest = rest.slice(take.length) }
  if (!rest) return
  t.chunks.push(rest)
  t.len += rest.length
  if (t.len > 2 * cap) {
    const tail = t.chunks.join('')
    t.cut += tail.length - cap
    t.chunks = [tail.slice(-cap)]
    t.len = cap
  }
}
const keptChars = (t, cap) => t.head.length + Math.min(t.len, cap)
/** The whole text kept, with what was cut between the head and the tail said where it was. */
function fullText(t, cap) {
  const all = t.chunks.join('')
  const tail = all.length > cap ? all.slice(-cap) : all
  const cut = t.cut + all.length - tail.length
  return { text: `${t.head}${cut ? `\n… ${cut} characters not kept …\n` : ''}${tail}`, total: t.head.length + cut + all.length }
}

// ---- a small line diff, for a file edit's +/- counts ---------------------------------------------

const linesOf = (s) => (s ? String(s).replace(/\r\n/g, '\n').split('\n') : [])
/**
 * A unified diff of one edit, from the text it replaced and the text it wrote (DSH's edit and write
 * results carry both, `meta.diffs`): the lines in common at either end are context, the rest is what
 * went and what came. Not a minimal diff, but the right counts for a replacement.
 */
export function editDiff(path, oldText, newText) {
  const a = linesOf(oldText)
  const b = linesOf(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const removed = a.slice(start, a.length - end)
  const added = b.slice(start, b.length - end)
  const before = a.slice(Math.max(0, start - 3), start)
  const after = a.slice(a.length - end, Math.min(a.length, a.length - end + 3))
  const at = start - before.length + 1
  const body = [...before.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), ...after.map((l) => ` ${l}`)]
  const head = [`--- ${oldText == null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`, `@@ -${at},${before.length + removed.length + after.length} +${at},${before.length + added.length + after.length} @@`]
  return { plus: added.length, minus: removed.length, diff: [...head, ...body].join('\n') }
}

/** A unified diff from the hunks Claude Code's edit tools report (`structuredPatch`), with its line counts. */
function hunksDiff(path, hunks) {
  const body = []
  let plus = 0
  let minus = 0
  for (const h of hunks) {
    if (!h || !Array.isArray(h.lines)) continue
    body.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) { const line = String(l); if (line.startsWith('+')) plus++; else if (line.startsWith('-')) minus++; body.push(line) }
  }
  return { plus, minus, diff: [`--- a/${path}`, `+++ b/${path}`, ...body].join('\n') }
}
/**
 * The lines a unified diff adds and takes away, and how many files it names. A hunk's lines are
 * counted as its header gives them, so a line of the file that starts with `--` or `++` counts as the
 * line it is; a file counts at its `diff --git` line, or at its `+++` header where it has none, and
 * once however often it is named, as in the diffs of two turns that both changed it.
 */
function diffCounts(diff) {
  let plus = 0
  let minus = 0
  // The files named, by their headers: a `diff --git` line, or a `---` and `+++` pair.
  const files = new Set()
  // Lines of the current hunk still to come, of the old file and of the new.
  let olds = 0
  let news = 0
  // In a hunk whose header gives no counts (`@@` alone), which the next file's headers end.
  let loose = false
  // The file whose headers come next was counted at its `diff --git` line.
  let git = false
  const lines = linesOf(diff)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (loose && (l.startsWith('diff --git ') || (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')))) loose = false
    if (loose || olds > 0 || news > 0) {
      if (l.startsWith('+')) { plus++; news-- }
      else if (l.startsWith('-')) { minus++; olds-- }
      // A line both files keep; `\\ No newline at end of file` is no line of either.
      else if (!l.startsWith('\\')) { olds--; news-- }
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l)
    if (hunk) { olds = hunk[1] === undefined ? 1 : Number(hunk[1]); news = hunk[2] === undefined ? 1 : Number(hunk[2]) }
    else if (l.startsWith('@@')) loose = true
    else if (l.startsWith('diff --git ')) { files.add(l); git = true }
    else if (l.startsWith('+++ ')) { if (!git) files.add(`${lines[i - 1]}\n${l}`); git = false }
  }
  return { plus, minus, files: files.size }
}
/**
 * One file of a Codex fileChange (`{ path, kind, diff }`) as a diff with its counts: a new file's text
 * as lines added and a deleted one's as lines taken away, whatever they hold, and an update's diff as
 * Codex gives it.
 */
function changeDiff({ path, kind, diff }) {
  const type = typeof kind === 'string' ? kind : kind?.type
  const text = typeof diff === 'string' ? diff : ''
  const head = [`--- ${type === 'add' ? '/dev/null' : `a/${path}`}`, `+++ ${type === 'delete' ? '/dev/null' : `b/${path}`}`]
  if (type === 'add' || type === 'delete') {
    const lines = linesOf(text.replace(/\n$/, '')).map((l) => `${type === 'add' ? '+' : '-'}${l}`)
    return { plus: type === 'add' ? lines.length : 0, minus: type === 'delete' ? lines.length : 0, diff: [...head, ...lines].join('\n') }
  }
  if (!text.includes('@@')) return { plus: 0, minus: 0, diff: text }
  const { plus, minus } = diffCounts(text)
  return { plus, minus, diff: text.startsWith('---') ? text : [...head, text].join('\n') }
}

// ---- token counts -----------------------------------------------------------------------------------

// The plugin's token counts, as dsh-llm's TokenUsage names them: input that was not read from a cache,
// output, input read from and written to a cache, the output's reasoning, and the total of them all.
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
const count = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0)

/**
 * A provider's own token counts in the plugin's TokenUsage names, or null for none: `claude-code`, the
 * Agent SDK result's `modelUsage`, summed over its models; `anthropic`, one Messages API usage (a model
 * call's, as it streams); `codex`, an app-server `tokenUsage` breakdown (its `total`). Anthropic's input
 * already leaves out what was read from or written to the cache. Codex's input counts its cached part,
 * which is taken out of it and counted as read from the cache.
 */
export function usageOf(provider, raw) {
  if (!raw || typeof raw !== 'object') return null
  if (provider === 'claude-code') {
    const models = Object.values(raw).filter((m) => m && typeof m === 'object')
    if (!models.length) return null
    const sum = (k) => models.reduce((t, m) => t + count(m[k]), 0)
    const u = { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadInputTokens'), cacheWriteTokens: sum('cacheCreationInputTokens') }
    return { ...u, ...(sum('thinkingTokens') ? { reasoningTokens: sum('thinkingTokens') } : {}), totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens }
  }
  if (provider === 'anthropic') {
    const u = { inputTokens: count(raw.input_tokens), outputTokens: count(raw.output_tokens), cacheReadTokens: count(raw.cache_read_input_tokens), cacheWriteTokens: count(raw.cache_creation_input_tokens) }
    return { ...u, totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens }
  }
  if (provider === 'codex') {
    const input = count(raw.inputTokens)
    const cached = Math.min(input, count(raw.cachedInputTokens))
    const output = count(raw.outputTokens)
    return { inputTokens: input - cached, outputTokens: output, cacheReadTokens: cached, reasoningTokens: count(raw.reasoningOutputTokens), totalTokens: count(raw.totalTokens) || input + output }
  }
  return null
}
/** Token counts summed field by field, each kept once it is above 0, input and output always. */
const sumUsage = (list) => Object.fromEntries(USAGE_FIELDS.map((k) => [k, list.reduce((t, u) => t + count(u?.[k]), 0)]).filter(([k, n]) => n > 0 || k === 'inputTokens' || k === 'outputTokens'))

// ---- the store --------------------------------------------------------------------------------------

/**
 * The live store. `now` is the clock, `caps` any of LIVE_CAPS to change, `times` any of LIVE_TIMES,
 * `dir` where tasks' transcripts are saved (none, nothing is saved), and `log` hears what could not
 * be saved or read.
 */
export function createLiveStore({ now = Date.now, caps: capsGiven = {}, times: timesGiven = {}, dir = null, log = () => {} } = {}) {
  const caps = { ...LIVE_CAPS, ...capsGiven }
  const times = { ...LIVE_TIMES, ...timesGiven }
  const runs = new Map() // runId -> run, least recently used first (a read or a change moves it last)
  let v = 0
  // Input a projector could not read, across every run: a frame or an event of a shape it does not know.
  let droppedTotal = 0
  // Each task's saves and deletes, one after another, so a later one never lands under an earlier one.
  const saving = new Map()
  // What each pass of a task took once the store has let it go (a read pass evicted while its task
  // waited in line): runId -> { taskKey, elapsedMs, tools, usage }, the oldest first, for the task's
  // done line, which counts every pass (activityOfRuns).
  const spent = new Map()
  // Set once the plugin closes (dispose): no transcript is saved or deleted after, since the plugin
  // that replaces this one keeps the task list, and its files, from then on.
  let disposed = false
  // What was asked of the store meanwhile, by task key: 'persist', or 'drop', which a later save never
  // undoes. A run that ends after the plugin closed, before the one applied again has taken its task
  // over, asks it; that plugin does it as it reopens the store, and as KzH quits nobody does.
  const owed = new Map()

  const touch = (run) => { runs.delete(run.runId); runs.set(run.runId, run) }
  const bump = (run) => { run.v = ++v; touch(run); return run.v }
  const drop1 = (run) => { run.dropped++; droppedTotal++ }
  const evict = () => {
    let finished = 0
    for (const r of runs.values()) if (r.endedAt != null) finished++
    for (const r of runs.values()) {
      if (finished <= caps.finished) break
      if (r.endedAt == null) continue
      if (r.taskKey) {
        const { elapsedMs, tools, usage } = activity(r)
        spent.set(r.runId, { taskKey: r.taskKey, elapsedMs, tools, usage })
        for (const id of spent.keys()) { if (spent.size <= caps.spent) break; spent.delete(id) }
      }
      runs.delete(r.runId)
      finished--
    }
  }

  // ---- items ----

  /** A new item of `run`, or the one it already has under `id`. */
  function itemOf(run, id, init) {
    let it = run.byId.get(id)
    if (it) return it
    it = { id, n: ++run.n, v: 0, at: now(), attempt: init.attempt ?? null, kind: init.kind, title: init.title ?? '', text: newText(), state: init.state ?? 'running', meta: { ...(init.meta ?? {}) }, args: null, size: 0, redacted: null }
    run.items.push(it)
    run.byId.set(id, it)
    changed(run, it)
    return it
  }
  /** The item changed: a new version, its size counted again, and the run kept within its caps. */
  function changed(run, it, { activity = true } = {}) {
    it.v = bump(run)
    const size = keptChars(it.text, caps.itemChars) + String(it.title).length
    run.chars += size - it.size
    it.size = size
    if (activity) run.lastActivityAt = now()
    if (run.items.length - (run.byId.has('dropped') ? 1 : 0) > caps.items || run.chars > caps.runChars) overflow(run)
  }
  /** Drop a run's oldest items until it is within its caps again, and say so once, at its top. */
  function overflow(run) {
    let gone = 0
    // The marker is no item of the run's own, so the cap counts the items besides it.
    const count = () => run.items.length - (run.byId.has('dropped') ? 1 : 0)
    while ((count() > caps.items || run.chars > caps.runChars) && count() > 1) {
      const i = run.items.findIndex((x) => x.id !== 'dropped')
      if (i < 0 || i === run.items.length - 1) break
      const [old] = run.items.splice(i, 1)
      run.byId.delete(old.id)
      run.chars -= old.size
      gone++
    }
    if (!gone) return
    let marker = run.byId.get('dropped')
    if (!marker) {
      marker = { id: 'dropped', n: 0, v: 0, at: now(), attempt: null, kind: 'status', title: '', text: newText(), state: 'done', meta: { dropped: 0 }, args: null, size: 0, redacted: null }
      run.items.unshift(marker)
      run.byId.set('dropped', marker)
    }
    marker.meta = { dropped: marker.meta.dropped + gone }
    marker.title = `Older steps dropped (${marker.meta.dropped})`
    run.keptFrom = run.items.find((x) => x.id !== 'dropped')?.n ?? run.n
    marker.v = bump(run)
  }
  const setText = (run, it, s) => { it.text = newText(); appendText(it.text, s, caps.itemChars); changed(run, it) }
  const addText = (run, it, s) => { appendText(it.text, s, caps.itemChars); changed(run, it) }

  // ---- runs ----

  const runOf = (runId) => runs.get(runId) ?? null

  /**
   * Open a run as route() starts it: the task it is a pass of, its chat and who decides it. A second
   * call changes nothing.
   */
  function open(runId, { taskKey = null, sessionId = null, decider = TEACHER } = {}) {
    if (typeof runId !== 'string' || !runId) return null
    if (runs.has(runId)) return runs.get(runId)
    const run = {
      runId, taskKey: typeof taskKey === 'string' && KEY.test(taskKey) ? taskKey : null, sessionId, decider: decider ?? TEACHER,
      openedAt: now(), endedAt: null, status: null, v: 0, lastActivityAt: now(),
      // Where the run stands between agents, from its router events: choosing, checks (before the
      // first attempt), starting, attempt, checking (after a work attempt), reviewing, between,
      // ending (its end is said, its return still to come) and done.
      phase: 'choosing', routed: false, called: false, firstAgent: null, checkNames: [], names: {}, reviewer: decider ?? TEACHER, checks: true, answerOnly: false,
      attempts: new Map(), current: null, items: [], byId: new Map(), n: 0, keptFrom: 1, chars: 0, dropped: 0, samples: [], milestones: 0,
    }
    runs.set(runId, run)
    spent.delete(runId)
    bump(run)
    evict()
    return run
  }

  /**
   * What route() learns of a run once it is under way: the agents' names by id (`names`), who reviews
   * its attempts (`reviewer`, a decider's id, or null when none does: offline the checks alone
   * decide), whether its checks are switched on (`checks`), and whether it is an answer or a read
   * pass, which runs no checks and no review (`answerOnly`).
   */
  function describe(runId, facts = {}) {
    const run = runOf(runId)
    if (!run) return
    if (facts.names && typeof facts.names === 'object') run.names = { ...run.names, ...facts.names }
    if ('reviewer' in facts) run.reviewer = facts.reviewer ?? null
    if ('checks' in facts) run.checks = !!facts.checks
    if ('answerOnly' in facts) run.answerOnly = !!facts.answerOnly
    bump(run)
  }

  const nameOf = (run, id) => (String(id ?? '').startsWith('tool:') ? `the ${String(id).slice(5)} tool` : run.names[id] ?? id ?? 'the agent')
  const milestone = (run, title, { attempt = run.current, kind = 'status', text = '' } = {}) => {
    const it = itemOf(run, `m${++run.milestones}`, { kind, title: oneLine(title, 400), attempt, state: 'done', meta: { router: true } })
    if (text) setText(run, it, String(text))
    return it
  }

  /**
   * One router event of a run (route()'s onEvent): a milestone line where it marks one, and where the
   * run stands now, for the activity line. Any other event is passed over; nothing here throws.
   */
  function router(runId, e) {
    const run = runOf(runId)
    if (!run || !e || typeof e !== 'object') return
    try {
      // Whether the decider was asked before the pick, for who the milestone says picked (router.js pickedBy).
      if (e.type === 'jev' || e.type === 'decider-error') { if (!run.routed) run.called = true; return }
      if (e.type === 'routed') {
        run.routed = true
        const r = e.routing ?? {}
        if (e.stopsForPerson) {
          milestone(run, `${providerName(r.decider ?? run.decider)} read this as needing a person: no agent runs`, { attempt: null })
          run.phase = 'ending'
          return
        }
        const by = pickedBy(r, run.called)
        const who = e.tool ? `the ${e.tool} tool` : nameOf(run, e.primary?.agent ?? r.primaryAgent)
        milestone(run, by === 'you' ? `You picked ${who}` : by === 'rules' ? `Picked by the routing rules: ${who}` : by === 'local' ? `Picked on this PC: ${who}` : `Picked by ${providerName(r.decider ?? run.decider)}: ${who}`, { attempt: null })
        run.firstAgent = e.tool ? `tool:${e.tool}` : e.primary?.agent ?? r.primaryAgent ?? null
        // The baseline checks run before the first attempt, unless the run is an answer or a tool's.
        run.phase = e.tool || run.answerOnly || !run.checks ? 'starting' : 'checks'
        bump(run)
        return
      }
      if (e.type === 'checks') {
        run.checkNames = (e.checks ?? []).map((c) => String(c.name))
        milestone(run, `Checks before start: ${(e.checks ?? []).map((c) => `${c.name} ${c.passed ? 'pass' : 'fail'}`).join(', ')}`, { attempt: null })
        run.phase = 'starting'
        bump(run)
        return
      }
      if (e.type === 'attempt_start' && Number.isInteger(e.index)) {
        const tool = e.role === 'tool' || String(e.agent ?? '').startsWith('tool:')
        run.attempts.set(e.index, {
          index: e.index, role: String(e.role ?? 'primary'), agent: String(e.agent ?? ''), effort: e.effort ?? null,
          provider: null, model: null, servedModel: null, startedAt: now(), endedAt: null, lastAgentAt: null, stopReason: null, durationMs: null, waitedMs: 0,
          // How this attempt's own work is seen: `live` for a spawn child's stream, `off` for an agent
          // whose stream this build cannot read, `tool` for a configured tool; null until its agent starts.
          detail: tool ? 'tool' : null, why: null, child: null,
          next: 0, streams: new Map(), committed: new Map(), aliases: new Map(), usage: new Map(), tools: 0, calls: new Set(), userIds: [], claimed: [],
          // The items of tool calls streamed in a model call that committed no message: none of them ran.
          unrun: new Set(),
          // The ids of the person's words Send now is stopping a step of this attempt for: the step it
          // ends reads as replaced by them, never as stopped or failed.
          replacing: new Set(),
          // A spawn child's calls not come back yet, by the turn that made each: a turn that ends
          // stopped ends them too.
          callTurns: new Map(),
        })
        // A parallel opinion runs beside the primary, which stays what the run is doing.
        if (e.role !== 'opinion' || run.current == null) run.current = e.index
        run.phase = 'attempt'
        bump(run)
        return
      }
      if (e.type === 'attempt_end' && Number.isInteger(e.index)) {
        const a = run.attempts.get(e.index)
        const rec = e.attempt ?? {}
        if (a) {
          // It ended when its agent's result came in (its handle's end), where the agent had one.
          Object.assign(a, { endedAt: a.endedAt ?? now(), stopReason: rec.stopReason ?? a.stopReason, durationMs: Number.isFinite(rec.durationMs) ? rec.durationMs : null, waitedMs: Number.isFinite(rec.waitedMs) ? rec.waitedMs : 0, model: a.model ?? rec.model ?? null, effort: rec.effort ?? a.effort })
          for (const it of run.items) if (it.attempt === e.index && it.state === 'running' && !it.meta.router) { it.state = 'done'; changed(run, it, { activity: false }) }
        }
        if (a?.role === 'opinion') { bump(run); return }
        // Where the run goes next: the review, since the checks over what the work changed have run by
        // now (router.js runs them before this event); a plan step goes straight on to the work, and an
        // answer or a read pass has neither.
        run.phase = run.answerOnly ? 'between' : a?.role === 'plan' ? 'starting' : 'reviewing'
        bump(run)
        return
      }
      if (e.type === 'review') {
        const x = e.assessment ?? {}
        milestone(run, `Review: ${REVIEW_WORDS[x.action] ?? String(x.action ?? 'done')}`, { text: x.why ? String(x.why) : '' })
        run.phase = 'between'
        bump(run)
        return
      }
      if (e.type === 'limit') { milestone(run, line({ ...e, agent: nameOf(run, e.agent) })); return }
      if (e.type === 'error') { milestone(run, `Error: ${e.message ?? 'no reason given'}`, { kind: 'error' }); return }
      if (e.type === 'access') {
        milestone(run, line(e), { attempt: null })
        if (e.mode === 'write') { run.status = 'needs_write'; run.phase = 'ending' }
        return
      }
      if (e.type === 'final') { run.status = e.status ?? run.status; run.phase = 'ending'; bump(run) }
      // What became of a piece of the person's guidance (Steer, docs/live-agent-view.md Feature 5): a
      // bubble in the attempt it was sent to, `You: <words>`, its state in words (`words`), changed in
      // place as it moves on. It is the person's, so it says nothing of what the agent does.
      if (e.type === 'steer') {
        if (typeof e.id !== 'string' || !e.id) { drop1(run); return }
        const id = `steer:${e.id}`
        const fresh = !run.byId.has(id)
        const it = itemOf(run, id, { kind: 'steer', attempt: Number.isInteger(e.attempt) ? e.attempt : run.current, title: `You: ${oneLine(String(e.guidance ?? ''), 300)}`, state: 'done', meta: { router: true } })
        if (fresh && e.guidance) setText(run, it, String(e.guidance))
        it.meta = { ...it.meta, steer: e.id, state: String(e.state ?? 'pending'), words: String(e.words ?? ''), ...(e.how === 'now' ? { now: true } : {}) }
        // Send now stopping a step of the attempt for these words (`replacing`), or not after all.
        const a = run.attempts.get(it.attempt)
        if (a && e.replacing === true) a.replacing.add(e.id)
        else if (a && e.replacing === false) a.replacing.delete(e.id)
        changed(run, it, { activity: false })
      }
    } catch { drop1(run) }
  }

  /**
   * Where a run stands once the agents of its current step are done, before the router says so: a
   * work attempt's checks over what it changed come first, before its `attempt_end` (router.js), when
   * the baseline checks named some (an attempt that changed nothing skips them, so their words show
   * only while git reads what changed), else the review; a plan step goes on to the work, and an
   * answer or a read pass, which has neither, to its end. A parallel opinion still at work keeps the
   * run at its attempt.
   */
  function agentsDone(run) {
    const a = run.attempts.get(run.current)
    if (run.phase !== 'attempt' || !a || a.endedAt == null) return
    for (const x of run.attempts.values()) if (x.role === 'opinion' && x.endedAt == null) return
    run.phase = run.answerOnly ? 'between' : a.role === 'plan' ? 'starting' : (a.role === 'primary' || a.role === 'retry') && run.checkNames.length ? 'checking' : 'reviewing'
  }

  /** The run has ended, as route() returns or throws: `status` is its final status, or how it ended without one. */
  function finish(runId, { status = null } = {}) {
    const run = runOf(runId)
    if (!run || run.endedAt != null) return
    run.endedAt = now()
    run.status = run.status ?? status ?? 'failed'
    run.phase = 'done'
    for (const a of run.attempts.values()) if (a.endedAt == null) a.endedAt = run.endedAt
    for (const it of run.items) if (it.state === 'running') { it.state = 'done'; changed(run, it, { activity: false }) }
    bump(run)
    evict()
  }

  // ---- an attempt's handle -------------------------------------------------------------------------

  const NO_HANDLE = Object.freeze({ started() {}, frame() {}, events() {}, tap() {}, claimed() {}, note() {}, end() {}, usage: () => null })

  /**
   * The handle one attempt's agent feeds, by the attempt's index in the run (attempt_start's); one
   * that changes nothing when the run or the attempt is not in the store (a benchmark run, an attempt
   * whose start the store never heard).
   */
  function attempt(runId, index) {
    const run = runOf(runId)
    const a = run ? run.attempts.get(index) : null
    if (!run || !a) return NO_HANDLE
    const guard = (fn) => (...args) => { try { fn(...args) } catch { drop1(run) } }
    const heard = () => { a.lastAgentAt = now(); run.lastActivityAt = now() }
    const itemId = (s) => `a${a.index}:${s}`
    /**
     * A step of this attempt ended stopped: the step Send now replaced, while it is stopping one for the
     * person's words (`replacing`), which then reads `Replaced by your message` once, never as stopped
     * or failed. `turn` names the turn it ended, when known, so a second word of the same end (a spawn
     * child's stopped model call and its turn's end) is not said again. False for a stop of another kind.
     */
    const replacedAt = (turn = null) => {
      if (turn != null && a.replacedTurns?.has(turn)) return true
      const id = a.replacing?.values().next().value
      if (id === undefined) return false
      a.replacing.delete(id)
      if (turn != null) (a.replacedTurns ??= new Set()).add(turn)
      itemOf(run, itemId(`replaced:${id}`), { kind: 'status', attempt: a.index, title: 'Replaced by your message', state: 'done' })
      return true
    }
    /**
     * A turn ended stopped, by Send now or a Stop: what it still had running will never come back, so
     * each such step ends there, a call failed and text, thinking or a plan as far as it got (the Strata
     * addendum: every live row ends in a final state). A spawn child's are the calls of that `turn`
     * (its next turn may stream already); a connector's turn is the attempt's only one at work.
     */
    const endStopped = (turn = null) => {
      const calls = new Set()
      if (turn != null) for (const [callId, t] of a.callTurns) if (t === turn) { a.callTurns.delete(callId); const key = itemId(`call:${callId}`); calls.add(a.aliases.get(key) ?? key) }
      for (const it of run.items) {
        if (it.attempt !== a.index || it.state !== 'running' || (turn != null && !calls.has(it.id))) continue
        if (it.kind === 'text' || it.kind === 'reasoning' || it.kind === 'plan') it.state = 'done'
        else {
          it.state = 'failed'
          if (it.kind === 'command') it.title = `Ran ${oneLine(it.meta.command ?? '', 80) || 'a command'} · stopped`
          else if (it.kind === 'file') it.title = `Did not edit ${oneLine(it.meta.path ?? 'a file', 80)}`
          else if (it.kind === 'tool') it.title = `${toolTitle(it.meta.name, it.args, true)} (stopped)`
        }
        changed(run, it, { activity: false })
      }
    }
    const tokensIn = (text) => { const t = String(text ?? '').length / CHARS_PER_TOKEN; if (t > 0) { run.samples.push({ at: now(), tokens: t }); trimSamples(run) } }
    // A tool call's item, by the call's id, whichever of the stream and the session told of it first.
    // A call under the id of one that never ran (endStream) is a call of its own, with an item of its own.
    const callItem = (callId, { name } = {}) => {
      const key = itemId(`call:${callId}`)
      const it = run.byId.get(a.aliases.get(key) ?? key)
      if (it && !a.unrun.has(it.id)) return it
      const id = it ? itemId(`call:${callId}:${run.n + 1}`) : key
      if (it) a.aliases.set(key, id)
      return itemOf(run, id, { kind: 'tool', attempt: a.index, title: toolTitle(name, null, false), meta: { name: name ?? null } })
    }
    /** A tool call's item named and given its arguments: a command, an edit or a plan where it is one. */
    const describeCall = (it, name, args) => {
      const parsed = parseArgs(args) ?? {}
      const kind = toolKindOf(name ?? it.meta.name)
      it.args = parsed
      it.meta = { ...it.meta, name: name ?? it.meta.name }
      // Redacted as it is kept, since the activity line, its stall words and what is open quote it.
      if (kind === 'command') { it.kind = 'command'; it.meta.command = quote(commandOf(parsed), 400) }
      else if (kind === 'edit') { it.kind = 'file'; it.meta.path = pathOf(parsed) || it.meta.path || null }
      else if (kind === 'plan' && Array.isArray(parsed.todos)) {
        it.kind = 'plan'
        appendText((it.text = newText()), parsed.todos.map((x) => `[${x?.status === 'completed' ? 'x' : x?.status === 'in_progress' ? '~' : ' '}] ${oneLine(x?.content ?? x?.title ?? '', 200)}`).join('\n'), caps.itemChars)
      }
      it.title = toolTitle(it.meta.name, parsed, it.state !== 'running')
    }

    /** A stream the agent ended: committed as the event at `outcome.seq`, or abandoned. */
    function endStream(id, s, outcome) {
      s.ended = true
      if (outcome?.kind === 'committed' && Number.isInteger(outcome.seq)) {
        s.seq = outcome.seq
        const made = a.committed.get(outcome.seq)
        // The pump read the committed message first and made its items from it: the stream's own are
        // the same steps again, so they are hidden rather than shown twice.
        if (made) { for (const x of s.items) { const it = run.byId.get(x); if (it && !made.includes(x)) { it.meta = { ...it.meta, hidden: true }; changed(run, it, { activity: false }) } } }
        else a.committed.set(outcome.seq, s.items.slice())
        // The stream's usage is the committed message's from now on, counted once.
        if (a.usage.has(`att:${id}`)) {
          if (!a.usage.has(`seq:${outcome.seq}`)) a.usage.set(`seq:${outcome.seq}`, a.usage.get(`att:${id}`))
          a.usage.delete(`att:${id}`)
        }
      }
      // A model call that committed no message (it failed, was retried or was stopped: an
      // `assistant/attempt`, or abandoned) dispatched none of the tool calls it streamed. They never
      // ran, so they leave the timeline, where the call's own failure says what came of it, rather
      // than read as running until the attempt ends.
      const noMessage = outcome?.kind === 'abandoned' || (outcome?.kind === 'committed' && outcome.eventType === 'assistant/attempt')
      for (const x of s.items) {
        const it = run.byId.get(x)
        if (!it || it.state !== 'running') continue
        if (it.kind === 'text' || it.kind === 'reasoning') { it.state = noMessage ? 'failed' : 'done'; changed(run, it, { activity: false }) }
        else if (noMessage) { it.state = 'failed'; it.meta = { ...it.meta, hidden: true }; a.unrun.add(it.id); changed(run, it, { activity: false }) }
      }
      bump(run)
    }

    /** One committed event of the child's session. */
    function event(e) {
      const d = e.data ?? {}
      heard()
      if (e.type === 'turn/end') {
        const r = d.reason ?? {}
        if (r.kind === 'aborted') { replacedAt(Number.isInteger(d.turn) ? d.turn : null); if (Number.isInteger(d.turn)) endStopped(d.turn); return }
        if (r.kind === 'error') itemOf(run, itemId(`turn:${e.seq}`), { kind: 'error', attempt: a.index, title: `The turn failed: ${oneLine(r.error?.message ?? r.error?.code ?? 'no reason given', 300)}`, state: 'failed' })
        else if (r.kind === 'max-tokens') itemOf(run, itemId(`turn:${e.seq}`), { kind: 'status', attempt: a.index, title: 'The model reached its output limit for one answer', state: 'done' })
        return
      }
      if (e.type === 'request/context') { if (typeof d.model === 'string' && d.model) { a.servedModel = d.model; bump(run) } return }
      if (e.type === 'user/message') { if (typeof d.id === 'string') a.userIds.push(d.id); return }
      if (e.type === 'assistant/message') {
        const msg = d.message ?? {}
        if (typeof msg.source?.model === 'string' && msg.source.model) a.servedModel = msg.source.model
        if (d.usage && typeof d.usage === 'object') {
          a.usage.set(`seq:${e.seq}`, { ...d.usage })
          // A stream whose usage was counted until it was committed here is counted here alone.
          for (const [id, s] of a.streams) if (s.seq === e.seq) a.usage.delete(`att:${id}`)
        }
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const final = !blocks.some((b) => b?.type === 'tool-call')
        // The stream that carried this message: by the seq its end named, else by its turn and step,
        // else the one stream still open whose start this follow never heard.
        let mine = a.committed.get(e.seq) ?? null
        if (!mine) {
          // A stream that ended with nothing committed (abandoned) is no longer open, and never this message's.
          const open = [...a.streams.entries()].filter(([, x]) => x.seq === null && !x.ended)
          const hit = open.find(([, x]) => x.turn === d.turn && x.step === d.step) ?? open.find(([, x]) => x.turn === null && x.items.length)
          if (hit) {
            const [id, s] = hit
            s.seq = e.seq
            mine = s.items.slice()
            a.committed.set(e.seq, mine)
            a.usage.delete(`att:${id}`)
          }
        }
        if (mine) {
          for (const x of mine) { const it = run.byId.get(x); if (it && it.kind === 'text' && final && !it.meta.final) { it.meta = { ...it.meta, final: true }; changed(run, it) } }
          bump(run)
          return
        }
        // Nothing streamed it here (the listener failed, or it was committed before the follow began):
        // its steps come from the message itself.
        const made = []
        blocks.forEach((b, i) => {
          if (!b || typeof b !== 'object') return
          if (b.type === 'text' || b.type === 'reasoning') {
            const it = itemOf(run, itemId(`m${e.seq}:${i}`), { kind: b.type, attempt: a.index, title: b.type === 'reasoning' ? 'Thinking' : '', state: 'done', meta: b.type === 'text' && final ? { final: true } : {} })
            setText(run, it, b.text)
            made.push(it.id)
          } else if (b.type === 'tool-call' && typeof b.id === 'string') {
            const it = callItem(b.id, { name: b.name })
            describeCall(it, b.name, b.arguments)
            changed(run, it)
            made.push(it.id)
          }
        })
        a.committed.set(e.seq, made)
        return
      }
      if (e.type === 'tool/call') {
        if (typeof d.callId !== 'string') return
        const it = callItem(d.callId, { name: d.name })
        if (!a.calls.has(d.callId)) { a.calls.add(d.callId); a.tools++ }
        if (Number.isInteger(d.turn)) a.callTurns.set(d.callId, d.turn)
        it.state = 'running'
        it.meta = { ...it.meta, startedAt: Number.isFinite(e.time) ? e.time : now() }
        describeCall(it, d.name, d.arguments)
        changed(run, it)
        return
      }
      if (e.type === 'tool/result') {
        const msg = d.message ?? {}
        const block = Array.isArray(msg.content) ? msg.content[0] : null
        const callId = msg.source?.callId ?? block?.toolCallId
        if (typeof callId !== 'string') return
        a.callTurns.delete(callId)
        const it = callItem(callId, {})
        if (!a.calls.has(callId)) { a.calls.add(callId); a.tools++ }
        const failed = !!block?.isError || !!d.error
        const out = (Array.isArray(block?.content) ? block.content : []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
        const took = Number.isFinite(it.meta.startedAt) && Number.isFinite(e.time) ? Math.max(0, e.time - it.meta.startedAt) : null
        const meta = d.meta && typeof d.meta === 'object' && !Array.isArray(d.meta) ? d.meta : {}
        const exit = [meta.exitCode, meta.exit_code, meta.code].find((x) => Number.isInteger(x))
        // An edit's result says what it changed (DSH's edit and write: `meta.diffs`, each with the
        // text it replaced and the text it wrote): the row counts the lines and carries the diff.
        const diffs = Array.isArray(meta.diffs) ? meta.diffs.filter((x) => x && typeof x.path === 'string' && typeof x.newText === 'string') : []
        const edits = diffs.map((x) => ({ path: x.path, ...editDiff(x.path, typeof x.oldText === 'string' ? x.oldText : null, x.newText) }))
        finishCall(it, { failed, out, took, exit, edits, total: meta.total })
      }
    }

    /**
     * A tool call of any agent has come back: its row says what it did, how long it took and how it
     * ended, a command's with its output and exit code, an edit's with its diff and line counts
     * (`edits`, each `{ path, plus, minus, diff }`), and a call of another tool with what it gave.
     */
    function finishCall(it, { failed = false, out = '', took = null, exit = null, edits = [], total = null } = {}) {
      it.state = failed ? 'failed' : 'done'
      if (took != null) it.meta = { ...it.meta, durationMs: took }
      if (Number.isInteger(exit)) it.meta = { ...it.meta, exitCode: exit }
      if (edits.length) {
        it.kind = 'file'
        it.meta = { ...it.meta, path: edits[0].path, plus: edits.reduce((t, x) => t + x.plus, 0), minus: edits.reduce((t, x) => t + x.minus, 0) }
        it.title = `${failed ? 'Did not edit' : 'Edited'} ${oneLine(edits[0].path, 80)}${edits.length > 1 ? ` and ${edits.length - 1} more` : ''} +${it.meta.plus} -${it.meta.minus}`
        setText(run, it, edits.map((x) => x.diff).join('\n'))
        return
      }
      const kind = toolKindOf(it.meta.name)
      if (it.kind === 'command') {
        it.title = [`Ran ${oneLine(it.meta.command ?? '', 80)}`, Number.isInteger(it.meta.exitCode) ? `exit ${it.meta.exitCode}` : failed ? 'failed' : '', took >= 1000 ? spanWords(took) : ''].filter(Boolean).join(' · ')
        setText(run, it, out)
        return
      }
      if (it.kind === 'file') { it.title = `${failed ? 'Did not edit' : 'Edited'} ${oneLine(it.meta.path ?? 'a file', 80)}`; changed(run, it); return }
      if (it.kind === 'plan') { it.title = 'Updated the plan'; changed(run, it); return }
      // What a read or a search gave is the code itself, which the row names; a count says how much.
      const found = Number.isInteger(total) ? ` (${total} found)` : ''
      it.title = `${toolTitle(it.meta.name, it.args, true)}${found}${failed ? ' (failed)' : ''}`
      if (kind === 'read' || kind === 'search' || kind === 'web') changed(run, it)
      else setText(run, it, out.length > caps.toolChars ? `${out.slice(0, caps.toolChars)}\n…` : out)
    }
    /** Count a call of the agent's once, by its id. */
    const counted = (callId) => { if (!a.calls.has(callId)) { a.calls.add(callId); a.tools++ } }
    /** The model line a provider's own report gives: the model that served the attempt. */
    function servedLine(model, meta = {}) {
      if (typeof model === 'string' && model) a.servedModel = model
      const it = itemOf(run, itemId('model'), { kind: 'status', attempt: a.index, state: 'done' })
      it.title = `Model: ${oneLine(a.servedModel ?? 'not said', 80)}`
      it.meta = { ...it.meta, model: a.servedModel ?? null, ...meta }
      changed(run, it)
    }

    // ---- Claude Code, through the engine patch: the Agent SDK's messages (SDKMessage) ----
    // A model call streams as `stream_event`s when the run is tapped (partial messages), and comes
    // whole as one `assistant` message per block, which replaces what streamed. Its items are found
    // by the call's message id: a block by its index as it streams, and the k-th text or thinking
    // block of the whole messages as the k-th of its kind that streamed.

    const claudeOf = () => (a.claude ??= { calls: 0, current: null, byId: new Map(), retries: 0 })
    /** The model call under message id `id`, or a new one (one with no id yet is the next to start). */
    function claudeCall(id) {
      const c = claudeOf()
      let call = id != null ? c.byId.get(id) : null
      if (!call) {
        call = { n: ++c.calls, id: id ?? null, blocks: new Map(), json: new Map(), text: [], reasoning: [], whole: { text: 0, reasoning: 0 }, usage: {}, stopped: false }
        if (id != null) c.byId.set(id, call)
      }
      return call
    }
    /** The k-th text or thinking item of a model call, made the first time either the stream or the whole message names it. */
    function callBlock(call, kind, k) {
      if (call[kind][k] === undefined) call[kind][k] = itemOf(run, itemId(`cc${call.n}:${kind}:${k}`), { kind, attempt: a.index, title: kind === 'reasoning' ? 'Thinking' : '' }).id
      return run.byId.get(call[kind][k])
    }
    const settle = (it) => { if (it && it.state === 'running') { it.state = 'done'; changed(run, it, { activity: false }) } }
    const markFinal = (call) => { for (const x of call.text) { const it = run.byId.get(x); if (it && !it.meta.final) { it.meta = { ...it.meta, final: true }; changed(run, it) } } }
    const callUsage = (call, raw) => {
      if (!raw || typeof raw !== 'object' || call.id == null) return
      call.usage = { ...call.usage, ...raw }
      a.usage.set(`msg:${call.id}`, usageOf('anthropic', call.usage))
      bump(run)
    }
    /** A retry the CLI said is over once a model call starts, or the run ends. */
    const retried = () => { for (const it of run.items) if (it.attempt === a.index && it.meta.retry) settle(it) }

    /** One stream event of a model call (the Messages API's raw stream events). */
    function claudeStream(ev) {
      const c = claudeOf()
      if (ev.type === 'message_start') {
        retried()
        const id = typeof ev.message?.id === 'string' ? ev.message.id : null
        // A call cut off before its blocks ended leaves their arguments to its whole message.
        c.current?.json.clear()
        // Thinking the CLI counted before the call was named is this call's.
        if (c.current && c.current.id === null && !c.current.stopped && id !== null) { c.current.id = id; c.byId.set(id, c.current) } else c.current = claudeCall(id)
        callUsage(c.current, ev.message?.usage)
        return
      }
      const call = c.current && !c.current.stopped ? c.current : (c.current = claudeCall(null))
      const it = Number.isInteger(ev.index) && call.blocks.has(ev.index) ? run.byId.get(call.blocks.get(ev.index)) : null
      if (ev.type === 'content_block_start') {
        const b = ev.content_block ?? {}
        if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
          const kind = b.type === 'text' ? 'text' : 'reasoning'
          const item = callBlock(call, kind, call[kind].length)
          call.blocks.set(ev.index, item.id)
          const first = b.type === 'text' ? b.text : b.thinking
          if (typeof first === 'string' && first) { addText(run, item, first); tokensIn(first) }
        } else if ((b.type === 'tool_use' || b.type === 'server_tool_use') && typeof b.id === 'string') {
          const item = callItem(b.id, { name: b.name })
          call.blocks.set(ev.index, item.id)
          changed(run, item)
        }
        return
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {}
        if (!it) return
        if (d.type === 'text_delta' || d.type === 'thinking_delta') {
          const text = d.type === 'text_delta' ? d.text : d.thinking
          if (typeof text === 'string') { addText(run, it, text); tokensIn(text) }
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          call.json.set(ev.index, (call.json.get(ev.index) ?? '') + d.partial_json)
          tokensIn(d.partial_json)
          changed(run, it)
        }
        return
      }
      if (ev.type === 'content_block_stop') {
        if (!it) return
        if (it.kind === 'text' || it.kind === 'reasoning') settle(it)
        // A tool call's arguments are whole now: its row names its file or its command, and keeps
        // them parsed only, so their streamed text is let go.
        else if (call.json.has(ev.index)) { describeCall(it, it.meta.name, call.json.get(ev.index)); call.json.delete(ev.index); changed(run, it) }
        return
      }
      if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason === 'end_turn') markFinal(call)
        callUsage(call, ev.usage)
        return
      }
      if (ev.type === 'message_stop') {
        call.stopped = true
        for (const x of [...call.text, ...call.reasoning]) settle(run.byId.get(x))
      }
    }

    /** A whole message of a model call: its text and thinking replace what streamed, and its tool calls are made. */
    function claudeAssistant(msg) {
      const call = claudeCall(typeof msg.id === 'string' ? msg.id : null)
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' || b.type === 'thinking') {
          const kind = b.type === 'text' ? 'text' : 'reasoning'
          const it = callBlock(call, kind, call.whole[kind]++)
          // Thinking the CLI does not share comes whole as an empty block, which leaves its count.
          const whole = b.type === 'text' ? b.text : b.thinking
          if (typeof whole === 'string' && whole) setText(run, it, whole)
          settle(it)
        } else if (b.type === 'tool_use' && typeof b.id === 'string') {
          const it = callItem(b.id, { name: b.name })
          counted(b.id)
          it.state = 'running'
          it.meta = { ...it.meta, startedAt: it.meta.startedAt ?? now() }
          describeCall(it, b.name, b.input && typeof b.input === 'object' ? { ...b.input } : b.input)
          changed(run, it)
        }
      }
      if (msg.stop_reason === 'end_turn') markFinal(call)
      callUsage(call, msg.usage)
    }

    /** A user message of the run: the results of its tool calls, each finishing its call's row. */
    function claudeResults(m) {
      const content = Array.isArray(m.message?.content) ? m.message.content : []
      const results = content.filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
      // What the tool gave as data beside its text (an edit's patch, a command's own output), read only
      // for a message of one result, whose it then is.
      const data = results.length === 1 && m.tool_use_result && typeof m.tool_use_result === 'object' ? m.tool_use_result : {}
      for (const b of results) {
        const it = callItem(b.tool_use_id, {})
        counted(b.tool_use_id)
        const failed = b.is_error === true
        const out = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content : []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
        const took = Number.isFinite(it.meta.startedAt) ? Math.max(0, now() - it.meta.startedAt) : null
        const hunks = Array.isArray(data.structuredPatch) ? data.structuredPatch : []
        const path = typeof data.filePath === 'string' ? data.filePath : it.meta.path ?? 'a file'
        // A file Write made has no hunks: its whole text is what it added.
        const edits = hunks.length ? [{ path, ...hunksDiff(path, hunks) }] : data.type === 'create' && typeof data.content === 'string' ? [{ path, ...changeDiff({ path, kind: 'add', diff: data.content }) }] : []
        const shell = [data.stdout, data.stderr].filter((x) => typeof x === 'string' && x)
        const exit = failed ? Number(/exit code (\d+)/i.exec(out)?.[1]) : null
        finishCall(it, { failed, out: shell.length ? shell.join('\n') : out, took, exit: Number.isInteger(exit) ? exit : null, edits })
      }
    }

    /** One Agent SDK message of a Claude Code run. A sub-agent's own steps are the Task call's that runs it. */
    function claude(m) {
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') { drop1(run); return }
      heard()
      if (m.type === 'system') {
        if (m.subtype === 'init') { if (typeof m.apiKeySource === 'string') a.apiKeySource = m.apiKeySource; servedLine(m.model, { apiKeySource: a.apiKeySource ?? null }); return }
        if (m.subtype === 'thinking_tokens') {
          // Thinking the CLI only counts: `Thinking... (about N tokens)` on the call's thinking.
          const c = claudeOf()
          const call = c.current && !c.current.stopped ? c.current : (c.current = claudeCall(null))
          const last = run.byId.get(call.reasoning.at(-1))
          const it = last?.state === 'running' ? last : callBlock(call, 'reasoning', call.reasoning.length)
          if (Number.isFinite(m.estimated_tokens)) { it.meta = { ...it.meta, tokens: Math.round(m.estimated_tokens) }; changed(run, it) }
          return
        }
        if (m.subtype === 'api_retry') {
          const secs = Math.max(0, Math.round((Number(m.retry_delay_ms) || 0) / 1000))
          itemOf(run, itemId(`retry:${++claudeOf().retries}`), { kind: 'status', attempt: a.index, title: `Retrying the model (attempt ${Number(m.attempt) || 1}, in ${secs} s)`, state: 'running', meta: { retry: true } })
        }
        return
      }
      if (m.parent_tool_use_id) return
      if (m.type === 'stream_event') { if (m.event && typeof m.event === 'object') claudeStream(m.event); return }
      if (m.type === 'assistant') { if (m.message && typeof m.message === 'object') claudeAssistant(m.message); return }
      if (m.type === 'user') { claudeResults(m); return }
      if (m.type === 'tool_progress') {
        // A call still at work: how long, and a heartbeat.
        const key = itemId(`call:${m.tool_use_id}`)
        const it = run.byId.get(a.aliases.get(key) ?? key)
        if (it && Number.isFinite(m.elapsed_time_seconds)) { it.meta = { ...it.meta, elapsedMs: Math.round(m.elapsed_time_seconds * 1000) }; changed(run, it) }
        return
      }
      if (m.type === 'result') {
        // The turn Send now interrupted ends with a result of its own, which reads as replaced.
        if ((m.subtype !== 'success' || m.is_error === true) && String(m.terminal_reason ?? '').startsWith('aborted_')) { replacedAt(); endStopped() }
        // The run's usage and cost so far, cumulative: the latest result's stand for every call before it.
        const u = usageOf('claude-code', m.modelUsage)
        if (u) { for (const k of [...a.usage.keys()]) if (k.startsWith('msg:')) a.usage.delete(k); a.usage.set('result', u) }
        if (Number.isFinite(m.total_cost_usd)) a.costUsd = m.total_cost_usd
        retried()
        bump(run)
      }
    }

    // ---- Codex, through the engine patch: its app-server notifications (app-server README, 0.153) ----
    // Each thread item has an item of the same id; its deltas add to it, and item/completed says how
    // it ended, which is the one to go by.

    const codexId = (id) => itemId(`cx:${id}`)
    /** One thread item as item/started or item/completed (`done`) gives it. */
    function codexThreadItem(x, done) {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string') { drop1(run); return }
      const id = codexId(x.id)
      const failed = done && (x.status === 'failed' || x.status === 'declined')
      if (x.type === 'agentMessage') {
        const it = itemOf(run, id, { kind: 'text', attempt: a.index })
        if (x.phase === 'final_answer' && !it.meta.final) it.meta = { ...it.meta, final: true }
        if (done) { if (typeof x.text === 'string' && x.text) setText(run, it, x.text); settle(it) } else changed(run, it)
        return
      }
      if (x.type === 'reasoning') {
        const it = itemOf(run, id, { kind: 'reasoning', attempt: a.index, title: 'Thinking' })
        if (!done) return
        const said = (list, sep) => (Array.isArray(list) ? list : []).filter((t) => typeof t === 'string' && t).join(sep)
        const whole = said(x.summary, '\n\n') || said(x.content, '\n')
        if (whole) setText(run, it, whole)
        settle(it)
        return
      }
      if (x.type === 'plan') {
        const it = itemOf(run, id, { kind: 'plan', attempt: a.index, title: 'Planning next steps' })
        if (!done) return
        if (typeof x.text === 'string' && x.text) setText(run, it, x.text)
        it.title = 'Updated the plan'
        settle(it)
        return
      }
      if (x.type === 'userMessage') { if (done && typeof x.clientId === 'string' && x.clientId) a.userIds.push(x.clientId); return }
      if (x.type === 'commandExecution') {
        const actions = Array.isArray(x.commandActions) ? x.commandActions : []
        // A command that only reads or lists files, or searches them, reads as a read or a search.
        const looks = actions.length > 0 && actions.every((c) => ['read', 'listFiles', 'search'].includes(c?.type))
        const searched = looks && actions.some((c) => c.type === 'search')
        const it = itemOf(run, id, { kind: looks ? 'tool' : 'command', attempt: a.index, meta: { name: looks ? (searched ? 'grep' : 'read') : 'shell' } })
        counted(x.id)
        if (!done) {
          it.state = 'running'
          it.meta = { ...it.meta, startedAt: it.meta.startedAt ?? now() }
          if (looks) it.args = searched ? { pattern: actions.find((c) => c.type === 'search')?.query ?? '' } : { path: actions[0]?.path ?? actions[0]?.name ?? '' }
          else it.meta.command = quote(typeof x.command === 'string' ? x.command : '', 400)
          it.title = looks ? toolTitle(it.meta.name, it.args, false) : `Running ${oneLine(it.meta.command, 80) || 'a command'}`
          changed(run, it)
          return
        }
        if (!looks && !it.meta.command && typeof x.command === 'string') it.meta.command = quote(x.command, 400)
        const out = typeof x.aggregatedOutput === 'string' ? x.aggregatedOutput : fullText(it.text, caps.itemChars).text
        finishCall(it, { failed, out, took: Number.isFinite(x.durationMs) ? x.durationMs : null, exit: Number.isInteger(x.exitCode) ? x.exitCode : null })
        if (x.status === 'declined') { it.title = `Did not run ${oneLine(it.meta.command ?? 'a command', 80)} (declined)`; changed(run, it) }
        return
      }
      if (x.type === 'fileChange') {
        const changes = (Array.isArray(x.changes) ? x.changes : []).filter((c) => c && typeof c.path === 'string')
        const it = itemOf(run, id, { kind: 'file', attempt: a.index, meta: { name: 'apply_patch' } })
        counted(x.id)
        const edits = changes.map((c) => ({ path: c.path, ...changeDiff(c) }))
        if (!done) {
          it.state = 'running'
          it.meta = { ...it.meta, path: edits[0]?.path ?? it.meta.path ?? null, startedAt: it.meta.startedAt ?? now() }
          it.title = `Editing ${oneLine(it.meta.path ?? 'a file', 80)}${edits.length > 1 ? ` and ${edits.length - 1} more` : ''}`
          if (edits.length) setText(run, it, edits.map((e) => e.diff).join('\n'))
          else changed(run, it)
          return
        }
        finishCall(it, { failed, edits })
        return
      }
      if (x.type === 'mcpToolCall' || x.type === 'webSearch') {
        const web = x.type === 'webSearch'
        const name = web ? 'web_search' : typeof x.tool === 'string' ? x.tool : 'tool'
        const it = itemOf(run, id, { kind: 'tool', attempt: a.index, meta: { name } })
        counted(x.id)
        it.args = web ? { query: typeof x.query === 'string' ? x.query : '' } : x.arguments && typeof x.arguments === 'object' ? { ...x.arguments } : parseArgs(x.arguments)
        if (!done) { it.state = 'running'; it.meta = { ...it.meta, startedAt: it.meta.startedAt ?? now() }; it.title = toolTitle(name, it.args, false); changed(run, it); return }
        const content = Array.isArray(x.result?.content) ? x.result.content : []
        const out = x.error ? String(x.error.message ?? x.error) : content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
        finishCall(it, { failed: failed || !!x.error, out, took: Number.isFinite(x.durationMs) ? x.durationMs : null })
      }
    }

    /** One app-server notification of a Codex run, or its thread/start response (`kzh/thread-start-response`). */
    function codex(method, params) {
      if (typeof method !== 'string') { drop1(run); return }
      const p = params && typeof params === 'object' ? params : {}
      heard()
      if (method === 'kzh/thread-start-response') { servedLine(p.model, { reasoningEffort: typeof p.reasoningEffort === 'string' ? p.reasoningEffort : null }); return }
      if (method === 'item/started' || method === 'item/completed') { codexThreadItem(p.item, method === 'item/completed'); return }
      if (method === 'item/fileChange/patchUpdated') { if (Array.isArray(p.changes)) codexThreadItem({ type: 'fileChange', id: p.itemId, changes: p.changes }, false); return }
      const kind = { 'item/agentMessage/delta': 'text', 'item/reasoning/summaryTextDelta': 'reasoning', 'item/reasoning/textDelta': 'reasoning', 'item/plan/delta': 'plan', 'item/commandExecution/outputDelta': 'command' }[method]
      if (kind) {
        if (typeof p.itemId !== 'string' || typeof p.delta !== 'string') { drop1(run); return }
        const it = itemOf(run, codexId(p.itemId), { kind, attempt: a.index, title: kind === 'reasoning' ? 'Thinking' : kind === 'plan' ? 'Planning next steps' : '' })
        // What a read or a search prints is the code itself, which its row names rather than keeps.
        if (kind === 'command' && it.kind === 'tool') return
        addText(run, it, p.delta)
        // A command's output is no model's: it adds nothing to the stream's rate.
        if (kind !== 'command') tokensIn(p.delta)
        return
      }
      if (method === 'item/reasoning/summaryPartAdded') {
        const it = typeof p.itemId === 'string' ? run.byId.get(codexId(p.itemId)) : null
        if (it && keptChars(it.text, caps.itemChars) > 0) addText(run, it, '\n\n')
        return
      }
      if (method === 'turn/diff/updated') {
        // What a turn has changed so far, every file in one diff, which its next update replaces. The
        // attempt's `Files changed` is every turn's in turn, so a turn Send now replaced keeps what it
        // changed; a diff that names no turn is one turn's.
        if (typeof p.diff !== 'string') { drop1(run); return }
        const turns = (a.turnDiffs ??= new Map())
        // One character past the cap, so a turn's diff cut here still reads as cut below.
        turns.set(typeof p.turnId === 'string' ? p.turnId : '', p.diff.slice(0, caps.filesChars + 1))
        const whole = [...turns.values()].reduce((t, d) => (t === '' || t.endsWith('\n') ? t + d : `${t}\n${d}`), '')
        const diff = whole.length > caps.filesChars ? `${whole.slice(0, caps.filesChars)}\n…` : whole
        const { plus, minus, files } = diffCounts(diff)
        const it = itemOf(run, itemId('files'), { kind: 'file', attempt: a.index, state: 'done', meta: { panel: 'files' } })
        it.title = `Files changed: ${files} ${files === 1 ? 'file' : 'files'} +${plus} -${minus}`
        it.meta = { ...it.meta, plus, minus, files }
        setText(run, it, diff)
        return
      }
      if (method === 'turn/plan/updated') {
        const steps = Array.isArray(p.plan) ? p.plan : []
        const it = itemOf(run, itemId('plan'), { kind: 'plan', attempt: a.index, title: 'Updated the plan', state: 'done' })
        setText(run, it, [...(typeof p.explanation === 'string' && p.explanation ? [oneLine(p.explanation, 300)] : []), ...steps.map((x) => `[${x?.status === 'completed' ? 'x' : x?.status === 'inProgress' ? '~' : ' '}] ${oneLine(x?.step ?? '', 200)}`)].join('\n'))
        return
      }
      if (method === 'thread/tokenUsage/updated') {
        // The thread's total so far, of every turn of it: the latest stands for the ones before.
        const u = usageOf('codex', p.tokenUsage?.total)
        if (u) { a.usage.set('codex', u); bump(run) }
        return
      }
      if (method === 'error') {
        const why = oneLine(p.error?.message ?? p.message ?? 'no reason given', 300)
        itemOf(run, itemId(`cxe:${run.n + 1}`), p.willRetry ? { kind: 'status', attempt: a.index, title: `Codex hit an error and tries again: ${why}`, state: 'done' } : { kind: 'error', attempt: a.index, title: `Codex reported an error: ${why}`, state: 'failed' })
        return
      }
      if (method === 'warning') { itemOf(run, itemId(`cxw:${run.n + 1}`), { kind: 'status', attempt: a.index, title: `Codex: ${oneLine(p.message ?? '', 300)}`, state: 'done' }); return }
      if (method === 'turn/completed' && p.turn?.status === 'interrupted') { replacedAt(p.turn.id ?? null); endStopped(); return }
      if (method === 'turn/completed' && p.turn?.status === 'failed') itemOf(run, itemId(`turn:${p.turn.id}`), { kind: 'error', attempt: a.index, title: `The turn failed: ${oneLine(p.turn.error?.message ?? 'no reason given', 300)}`, state: 'failed' })
    }

    return {
      /**
       * The attempt's agent has started: its provider, the model it was asked for, the spawn child's
       * session for Open full session, whether its work is seen live (`detail`, with `why` not), and
       * for a local model whether it thinks aloud (`thinking`, null for any other agent).
       */
      started: guard(({ provider = null, model = null, child = null, detail = null, why = null, see = null, thinking = null } = {}) => {
        Object.assign(a, { provider, model: model ?? a.model, child: child?.id ? { id: String(child.id), label: child.label ?? null } : null, detail: detail ?? a.detail, why, see, thinking: typeof thinking === 'boolean' ? thinking : null })
        bump(run)
      }),

      /**
       * One frame a patched connector tapped (scripts/patch-agent-live.mjs): a Claude Code run's Agent
       * SDK message (`{ provider: 'claude-code', message }`), or a Codex run's app-server notification or
       * thread/start response (`{ provider: 'codex', method, params }`). Read, never written to: the
       * connector reads the same objects after.
       */
      tap: guard((f) => {
        if (!f || typeof f !== 'object') { drop1(run); return }
        if (f.provider === 'claude-code') claude(f.message)
        else if (f.provider === 'codex') codex(f.method, f.params)
        else drop1(run)
      }),

      /**
       * What the attempt's run spent as its tap heard it, for a provider whose result says nothing of
       * it: its tokens, its cost (`apiEquivalentUsd` on a Claude subscription, which is no money paid,
       * else `costUsd`) and the model that served it. Null when the tap heard none of these.
       */
      usage: () => {
        try {
          if (!a.usage.size && a.costUsd == null && !a.servedModel) return null
          return {
            ...(a.usage.size ? { usage: sumUsage([...a.usage.values()]) } : {}),
            ...(a.costUsd != null ? (a.apiKeySource === 'none' ? { apiEquivalentUsd: a.costUsd } : { costUsd: a.costUsd }) : {}),
            ...(a.servedModel ? { servedModel: a.servedModel } : {}),
          }
        } catch { drop1(run); return null }
      },

      /** One `agent/assistant-stream` frame of a spawn child (dsh-agent AssistantStreamFrame). */
      frame: guard((f) => {
        if (!f || typeof f !== 'object' || typeof f.attemptId !== 'string') { drop1(run); return }
        heard()
        let s = a.streams.get(f.attemptId)
        if (!s) { s = { turn: null, step: null, blocks: new Map(), items: [], seq: null, ended: false }; a.streams.set(f.attemptId, s) }
        if (f.type === 'start') { s.turn = Number.isInteger(f.turn) ? f.turn : null; s.step = Number.isInteger(f.step) ? f.step : null; bump(run); return }
        if (f.type === 'end') { endStream(f.attemptId, s, f.outcome); return }
        if (f.type !== 'chunk' || !f.chunk || typeof f.chunk !== 'object') { drop1(run); return }
        const c = f.chunk
        const block = (index, kind) => {
          const id = s.blocks.get(index) ?? itemId(`${f.attemptId}:${index}`)
          let it = run.byId.get(id)
          if (!it) {
            it = itemOf(run, id, { kind, attempt: a.index, title: kind === 'reasoning' ? 'Thinking' : '' })
            s.blocks.set(index, id)
            s.items.push(id)
          }
          return it
        }
        if (c.type === 'block-start') { if (c.blockType === 'reasoning' || c.blockType === 'text') block(c.index, c.blockType); return }
        if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
          addText(run, block(c.index, c.type === 'text-delta' ? 'text' : 'reasoning'), c.text)
          tokensIn(c.text)
          return
        }
        if (c.type === 'tool-call-delta') {
          let it = s.blocks.has(c.index) ? run.byId.get(s.blocks.get(c.index)) : null
          if (!it) {
            it = c.id ? callItem(c.id, { name: c.name }) : itemOf(run, itemId(`${f.attemptId}:${c.index}`), { kind: 'tool', attempt: a.index, title: toolTitle(c.name, null, false), meta: { name: c.name ?? null } })
            s.blocks.set(c.index, it.id)
            s.items.push(it.id)
          }
          if (c.id && it.id !== itemId(`call:${c.id}`)) a.aliases.set(itemId(`call:${c.id}`), it.id)
          if (c.name) it.meta = { ...it.meta, name: c.name }
          it.title = toolTitle(it.meta.name, null, false)
          tokensIn(c.argumentsDelta)
          changed(run, it)
          return
        }
        if (c.type === 'block-end') {
          const b = c.block ?? {}
          if (b.type === 'text' || b.type === 'reasoning') { setText(run, block(c.index, b.type), b.text); return }
          if (b.type === 'tool-call') {
            let it = s.blocks.has(c.index) ? run.byId.get(s.blocks.get(c.index)) : null
            if (!it) { it = callItem(b.id, { name: b.name }); s.blocks.set(c.index, it.id); s.items.push(it.id) }
            if (typeof b.id === 'string' && it.id !== itemId(`call:${b.id}`)) a.aliases.set(itemId(`call:${b.id}`), it.id)
            describeCall(it, b.name, b.arguments)
            changed(run, it)
          }
          return
        }
        if (c.type === 'usage') { if (c.usage && typeof c.usage === 'object') { a.usage.set(`att:${f.attemptId}`, { ...c.usage }); bump(run) } return }
        if (c.type === 'finish') {
          const r = c.reason ?? {}
          if (r.kind === 'aborted' && replacedAt(s.turn)) return
          if (r.kind === 'error' || r.kind === 'aborted') {
            const why = oneLine(r.failure?.message ?? r.failure?.code ?? r.kind, 300)
            const title = r.failure?.code === 'ENDED_EARLY' ? `The model's answer ended early: ${why}` : r.kind === 'aborted' ? 'The model call was stopped' : `The model call failed: ${why}`
            itemOf(run, itemId(`${f.attemptId}:finish`), { kind: 'error', attempt: a.index, title, state: 'failed' })
          } else if (r.kind === 'max-tokens') itemOf(run, itemId(`${f.attemptId}:finish`), { kind: 'status', attempt: a.index, title: 'The model reached its output limit for one answer', state: 'done' })
          return
        }
        drop1(run)
      }),

      /**
       * Committed session events of the spawn child (dsh-session SessionEvent), as the pump reads them:
       * each is taken once, by its seq, so a backfill that overlaps what was read is no harm.
       */
      events: guard((list) => {
        if (!Array.isArray(list)) { drop1(run); return }
        for (const e of list) {
          if (!e || typeof e !== 'object' || !Number.isInteger(e.seq) || typeof e.type !== 'string') { drop1(run); continue }
          if (e.seq < a.next) continue
          a.next = e.seq + 1
          try { event(e) } catch { drop1(run) }
        }
      }),

      /** A message the child's inbox handed to a turn (`agent/inbox/claimed`), by its id: a steer of slice 8. */
      claimed: guard((id) => { if (typeof id === 'string') a.claimed.push(id) }),

      /** A line of the attempt's own, as a status or an error item. */
      note: guard(({ kind = 'status', title = '', text = '', state = 'done' } = {}) => {
        const it = itemOf(run, itemId(`note:${run.n + 1}`), { kind: kind === 'error' ? 'error' : 'status', attempt: a.index, title: oneLine(title, 300), state })
        if (text) setText(run, it, text)
      }),

      /**
       * The agent's result is in, or it failed: what it streamed is finished, whatever came of it, the
       * agent is heard from no more, so it is never said to be silent, and the run moves on to what
       * the router does next (agentsDone). runAgent calls it for every attempt, a child or none.
       */
      end: guard(({ stopReason = null } = {}) => {
        a.stopReason = stopReason ?? a.stopReason
        a.endedAt ??= now()
        for (const [id, s] of a.streams) if (!s.ended) endStream(id, s, null)
        for (const it of run.items) if (it.attempt === a.index && it.state === 'running' && !it.meta.router) { it.state = 'done'; changed(run, it, { activity: false }) }
        agentsDone(run)
        bump(run)
      }),
    }
  }

  // ---- reading -------------------------------------------------------------------------------------

  function trimSamples(run, at = now()) {
    while (run.samples.length && at - run.samples[0].at > times.rateMs) run.samples.shift()
  }
  /** Tokens as usage.jsonl names them, summed over the model calls an attempt made, each counted once. */
  function tokensOf(a) {
    const t = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 }
    for (const u of a.usage.values()) {
      const input = Number(u.inputTokens ?? u.input ?? 0) || 0
      const output = Number(u.outputTokens ?? u.output ?? 0) || 0
      t.input += input
      t.output += output
      t.cacheRead += Number(u.cacheReadTokens ?? u.cacheRead ?? 0) || 0
      t.reasoning += Number(u.reasoningTokens ?? u.reasoning ?? 0) || 0
      t.total += Number(u.totalTokens ?? 0) || input + output
    }
    return t
  }
  const sumTokens = (list) => list.reduce((t, x) => ({ input: t.input + x.input, output: t.output + x.output, cacheRead: t.cacheRead + x.cacheRead, reasoning: t.reasoning + x.reasoning, total: t.total + x.total }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 })

  /** An item's text, redacted, as one read or one save takes it, worked out once per version. */
  function textOf(it) {
    if (it.redacted?.v !== it.v) {
      const { text, total } = fullText(it.text, caps.itemChars)
      it.redacted = { v: it.v, text: redactSecrets(text), total }
    }
    return it.redacted
  }

  /** What the run is doing now, in the phrase table's words (docs/live-agent-view.md Feature 1). */
  function activity(run, at = now()) {
    const attempts = [...run.attempts.values()]
    const a = run.current != null ? run.attempts.get(run.current) : null
    const name = nameOf(run, a?.agent ?? run.firstAgent)
    const tools = attempts.reduce((t, x) => t + x.tools, 0)
    const usage = sumTokens(attempts.map(tokensOf))
    // What the timeline shows, the router's lines among it; the agent's own items say what it does.
    const shown = (it) => !it.meta.hidden && it.id !== 'dropped'
    const mine = (it) => a && it.attempt === a.index && shown(it) && !it.meta.router
    const newest = a ? run.items.findLast(mine) : null
    // Whether the agent has done anything yet: a model call that failed or stopped at its output limit
    // leaves a line of its own (a status or an error), which is no step of its work. Once it has done
    // something, such a line leaves it waiting on the model again, which reads as thinking; before, it
    // is still starting.
    const worked = a ? run.items.some((it) => mine(it) && it.kind !== 'status' && it.kind !== 'error') : false
    const open = a ? run.items.findLast((it) => it.attempt === a.index && it.kind === 'command' && it.state === 'running') : null
    // A call of any tool the agent made that has not come back (a sub-agent it waits for, a slow
    // fetch): its session commits nothing until the result, so the agent is waiting, not silent. Only
    // a call it made (tool/call, its start) counts, never one whose arguments still stream.
    const busy = !!a && run.items.some((it) => mine(it) && it.state === 'running' && Number.isFinite(it.meta.startedAt))
    const ended = run.endedAt != null
    const live = a?.detail === 'live' && a.endedAt == null && !ended
    const elapsedMs = Math.max(0, (run.endedAt ?? at) - run.openedAt - attempts.reduce((t, x) => t + (x.waitedMs ?? 0), 0))
    const phrase = ended ? `Done in ${spanWords(elapsedMs)}`
      : run.phase === 'choosing' ? `Choosing the agent (${providerName(run.decider)})`
        : run.phase === 'checks' ? 'Running your checks before it starts'
          : run.phase === 'checking' ? `Running your checks: ${run.checkNames.join(', ')}`
            : run.phase === 'reviewing' ? (run.reviewer ? `${providerName(run.reviewer)} is reviewing the changes` : 'Checking the changes')
              : run.phase === 'starting' ? `Starting ${nameOf(run, run.firstAgent ?? a?.agent)}...`
                : run.phase === 'between' ? (run.answerOnly ? 'Finishing' : 'Starting the next attempt')
                  : run.phase === 'ending' ? (run.status === 'needs_write' ? 'Handing the task back to its folder\'s line' : 'Finishing')
                    : a?.detail === 'tool' ? `Running ${name}`
                      : a?.detail === 'off' ? `Working (live detail is off for ${name}${a.see ? `: see ${a.see}` : ''})`
                        : a?.role === 'review' && !worked ? `${name} is reviewing the changes`
                          : phraseOf(newest) ?? (worked ? 'Thinking' : `Starting ${name}...`)
    // When the agent was last heard from, or when its attempt started if it has said nothing yet.
    const lastAgentAt = a?.lastAgentAt ?? a?.startedAt ?? null
    const stall = !ended && run.phase === 'attempt' ? stallOf({ open: open ? { since: open.meta.startedAt ?? open.at, command: open.meta.command ?? '' } : null, lastAgentAt, agent: name, live, busy }, at, times) : null
    trimSamples(run, at)
    // The windowed rate of what the agent streams (the Strata study's heartbeat): it falls to 0 while
    // nothing comes, which `quiet for N s` says beside it. Only a stream this build reads has one.
    const rate = live ? Math.round((run.samples.reduce((t, x) => t + x.tokens, 0) / (times.rateMs / 1000)) * 10) / 10 : null
    // Whether this build hears what the run does now: not while an attempt works whose agent's own
    // work it cannot read (live detail off, or a configured tool), so nothing then says how long the
    // run has been quiet, which would read as that agent's silence.
    const heard = !(run.phase === 'attempt' && a && (a.detail === 'off' || a.detail === 'tool') && a.endedAt == null)
    return {
      // Redacted once more as it goes out: a path or a tool's name in it is the agent's own words too.
      phrase: redactSecrets(stall?.words ?? phrase), stall, tools, tokens: usage.total, usage, rate,
      agent: name, role: a?.role ?? null, detail: a?.detail ?? null, why: a?.why ?? null,
      model: a?.servedModel ?? a?.model ?? null, effort: a?.effort ?? null,
      lastActivityAt: run.lastActivityAt, lastAgentAt, quietMs: Math.max(0, at - run.lastActivityAt), heard,
      fresh: !ended && at - run.lastActivityAt < times.freshMs,
      open: open ? { since: open.meta.startedAt ?? open.at, command: oneLine(open.meta.command ?? '', 200) } : null,
      // A call of the agent's still running, which the browser's stall words read as the store's do.
      busy,
      live, startedAt: run.openedAt, elapsedMs,
      done: ended ? { status: run.status, label: endLabel(run.status), ms: elapsedMs } : null,
      recent: run.items.filter(shown).slice(-6).map((it) => ({ kind: it.kind, title: redactSecrets(it.title) || oneLine(textOf(it).text.slice(-400), 120), state: it.state })),
    }
  }

  const redactMeta = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => k !== 'router').map(([k, x]) => [k, typeof x === 'string' ? redactSecrets(x) : x]))
  const publicAttempt = (run, a) => ({
    index: a.index, role: a.role, agent: a.agent, name: nameOf(run, a.agent), provider: a.provider, model: a.servedModel ?? a.model, effort: a.effort,
    startedAt: a.startedAt, endedAt: a.endedAt, stopReason: a.stopReason, durationMs: a.durationMs, waitedMs: a.waitedMs,
    detail: a.detail, why: a.why, thinking: a.thinking ?? null, child: a.child, tools: a.tools, tokens: tokensOf(a),
  })
  const publicItem = (it, cap = caps.readChars) => {
    const { text, total } = textOf(it)
    const shown = text.length > cap ? text.slice(-cap) : text
    return { id: it.id, n: it.n, v: it.v, at: it.at, attempt: it.attempt, kind: it.kind, router: !!it.meta.router, title: redactSecrets(it.title), text: shown, clippedBefore: Math.max(0, total - shown.length), state: it.state, meta: redactMeta(it.meta) }
  }

  /**
   * One run as the Live tab reads it: its attempts, its items changed since `after` (a store-wide
   * `v`), each with the last 16 KiB of its text and how much came before it, the oldest item it still
   * keeps (`keptFrom`), the spawn child its newest attempt ran in, and what it is doing now. Null for
   * a run the store does not hold.
   */
  function read(runId, after = 0) {
    const run = runOf(runId)
    if (!run) return null
    touch(run)
    const since = Number.isFinite(after) ? after : 0
    const attempts = [...run.attempts.values()]
    return {
      runId: run.runId, taskKey: run.taskKey, v: run.v, keptFrom: run.keptFrom,
      attempts: attempts.map((a) => publicAttempt(run, a)),
      items: run.items.filter((it) => it.v > since).map((it) => publicItem(it)),
      child: attempts.findLast((a) => a.child)?.child ?? null,
      summary: { ...activity(run), decider: run.decider, dropped: run.dropped },
    }
  }

  /** What a run is doing now (activity), or null for a run the store does not hold. */
  const activityOf = (runId, at = now()) => { const run = runOf(runId); return run ? activity(run, at) : null }

  /**
   * What a task's work is doing now, from its runs (a read pass and the pass that writes after it):
   * the newest one the store holds, with the tool calls, tokens and time of them all, a pass the store
   * has let go of since (a read pass evicted while its task waited in line) counted from what it kept
   * of it, so once it has ended it took the time of every pass, as the Live tab's end line counts it.
   * Null when it holds none.
   */
  function activityOfRuns(runIds, at = now()) {
    const ids = Array.isArray(runIds) ? runIds : []
    const each = new Map(ids.filter((id) => runs.has(id)).map((id) => [id, activity(runs.get(id), at)]))
    if (!each.size) return null
    const newest = each.get(ids.findLast((id) => each.has(id)))
    const all = ids.map((id) => each.get(id) ?? spent.get(id)).filter(Boolean)
    if (all.length === 1) return newest
    const usage = sumTokens(all.map((x) => x.usage))
    const elapsedMs = all.reduce((t, x) => t + x.elapsedMs, 0)
    const done = newest.done ? { ...newest.done, ms: elapsedMs } : null
    return { ...newest, tools: all.reduce((t, x) => t + x.tools, 0), tokens: usage.total, usage, elapsedMs, done, ...(done ? { phrase: `Done in ${spanWords(elapsedMs)}` } : {}) }
  }

  // ---- saving ----------------------------------------------------------------------------------------

  const fileOf = (key) => (dir && typeof key === 'string' && KEY.test(key) ? join(dir, `${key}.jsonl`) : null)
  /** One after another per task key; never rejects. */
  const queued = (key, fn) => {
    const next = (saving.get(key) ?? Promise.resolve()).then(fn).catch((err) => log(`live transcript of ${key}: ${err?.message ?? err}`))
    saving.set(key, next)
    next.finally(() => { if (saving.get(key) === next) saving.delete(key) })
    return next
  }

  /**
   * What a task's file holds: each run's line with its items as they were saved, in the file's order,
   * and how many items it says were left out in all; null when there is no file. A line cut short by
   * a crash is passed over, as is any line that cannot be read; a file that cannot be read throws.
   */
  async function readSaved(file) {
    let raw
    try { raw = await readFile(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err }
    const out = new Map()
    let dropped = 0
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue
      let row
      try { row = JSON.parse(l) } catch { continue }
      if (row?.t === 'run' && typeof row.runId === 'string') out.set(row.runId, { head: row, items: [] })
      else if (row?.t === 'item' && out.has(row.runId)) out.get(row.runId).items.push(row)
      else if (row?.t === 'dropped') dropped = Number(row.count) || 0
    }
    return { runs: [...out.values()], dropped }
  }

  /**
   * Save a task's runs to `<dir>/<key>.jsonl`: those the store holds, as they are now, and any it has
   * let go of since an earlier save (a read pass evicted while its task waited in line for the pass
   * that writes), as that save left them, in the order they ran. A line per run, then its items, each
   * with a redacted text of at most the read cap, the oldest items left out until the whole is within
   * the saved cap; each run's line says how many of its own were left out, and a line how many in all.
   * Resolves once it is on disk or has failed and been logged; a file there that cannot be read is left
   * as it is, rather than written over with only what the store holds. Once the store is disposed of
   * (the plugin closing), it saves nothing, and keeps the save for a plugin that reopens it.
   */
  function persist(key) {
    const file = fileOf(key)
    if (!file) return Promise.resolve()
    if (disposed) { if (owed.get(key) !== 'drop') owed.set(key, 'persist'); return Promise.resolve() }
    const held = [...runs.values()].filter((r) => r.taskKey === key)
    if (!held.length) return Promise.resolve()
    const fresh = held.map((r) => ({
      head: { t: 'run', runId: r.runId, taskKey: key, decider: r.decider, openedAt: r.openedAt, endedAt: r.endedAt, status: r.status, keptFrom: r.keptFrom, attempts: [...r.attempts.values()].map((a) => publicAttempt(r, a)), child: [...r.attempts.values()].findLast((a) => a.child)?.child ?? null, summary: activity(r) },
      items: r.items.filter((it) => !it.meta.hidden && it.id !== 'dropped').map((it) => ({ t: 'item', runId: r.runId, ...publicItem(it) })),
    }))
    // What the file holds is read as the save runs, so it is what the task's earlier save left there.
    return queued(key, async () => {
      let saved
      try { saved = await readSaved(file) } catch (err) { throw new Error(`not saved, since the one already there could not be read: ${err.message}`) }
      const ids = new Set(fresh.map((r) => r.head.runId))
      const all = [...(saved?.runs ?? []).filter((r) => !ids.has(r.head.runId)), ...fresh]
        .sort((x, y) => (x.head.openedAt ?? 0) - (y.head.openedAt ?? 0))
        .map((r) => ({ ...r, left: Number(r.head.left) || 0 }))
      const size = (l) => Buffer.byteLength(l) + 1
      const items = all.flatMap((r) => r.items.map((it) => ({ r, line: JSON.stringify(it) })))
      // Room for each run's count of what was left out of it, and for the line that adds them up.
      let total = all.reduce((t, r) => t + size(JSON.stringify(r.head)) + 16, 64) + items.reduce((t, x) => t + size(x.line), 0)
      let cut = 0
      while (cut < items.length && total > caps.savedBytes) { total -= size(items[cut].line); items[cut].r.left++; cut++ }
      const left = all.reduce((t, r) => t + r.left, 0)
      const lines = [...all.map((r) => JSON.stringify({ ...r.head, ...(r.left ? { left: r.left } : {}) })), ...(left ? [JSON.stringify({ t: 'dropped', count: left })] : []), ...items.slice(cut).map((x) => x.line)]
      await mkdir(dir, { recursive: true })
      await writeFile(`${file}.tmp`, `${lines.join('\n')}\n`)
      // A reader holding the file makes the rename fail on Windows for a moment (tasks.js found it).
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${file}.tmp`, file); break } catch (err) {
          if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err
          await new Promise((r) => setTimeout(r, 5 * (attempt + 1)))
        }
      }
    })
  }

  /**
   * A task's saved transcript, `{ runs, dropped }` with each run in the shape `read` gives, or null
   * when it has none. A last line cut short by a crash is passed over, as is any line that cannot be read.
   */
  async function load(key) {
    const file = fileOf(key)
    if (!file) return null
    let saved
    try { saved = await readSaved(file) } catch (err) { log(`live transcript of ${key} not read: ${err.message}`); return null }
    if (!saved?.runs.length) return null
    return {
      runs: saved.runs.map(({ head, items }) => ({
        runId: head.runId, taskKey: key, v: 0, keptFrom: head.keptFrom ?? 1, attempts: Array.isArray(head.attempts) ? head.attempts : [],
        items: items.map(({ t: _t, runId: _r, ...it }) => it), child: head.child ?? null, summary: { ...(head.summary ?? {}), decider: head.decider ?? TEACHER },
      })),
      dropped: saved.dropped,
    }
  }

  /**
   * Delete a task's saved transcript, as the task leaves the task list, and what is kept of its passes
   * the store has let go of. Never rejects; once the store is disposed of, it deletes no file, and
   * keeps the delete for a plugin that reopens it.
   */
  function drop(key) {
    for (const [id, x] of spent) if (x.taskKey === key) spent.delete(id)
    const file = fileOf(key)
    if (!file) return Promise.resolve()
    if (disposed) { owed.set(key, 'drop'); return Promise.resolve() }
    return queued(key, () => rm(file, { force: true }))
  }

  /** Resolves once every save and delete asked for so far has landed or failed and been logged. */
  const flushed = () => Promise.all([...saving.values()]).then(() => {})

  /**
   * The tap a patched connector is handed for one attempt's run (runAgent's `kzhTap`): each frame goes
   * to the attempt's handle, and nothing it does throws back into the connector.
   */
  const tapFor = (handle) => (frame) => { try { handle?.tap?.(frame) } catch { /* the handle counts what it cannot read */ } }

  return {
    open, describe, router, finish, attempt, tapFor, read, activityOf, activityOfRuns, persist, load, drop, flushed,
    has: (runId) => runs.has(runId),
    /** Where a run stands between its agents now (a run's `phase`: checking, reviewing, ending...), or null for a run the store does not hold. */
    phaseOf: (runId) => runOf(runId)?.phase ?? null,
    /**
     * The attempt a run has at work now, while its result is not in: `{ index, role, agent, name,
     * detail }`, `detail` 'tool' for a configured tool; null between attempts, or for a run the store
     * does not hold.
     */
    atWorkOf: (runId) => {
      const run = runOf(runId)
      const a = run?.phase === 'attempt' && run.current != null ? run.attempts.get(run.current) : null
      return a && a.endedAt == null ? { index: a.index, role: a.role, agent: a.agent, name: nameOf(run, a.agent), detail: a.detail } : null
    },
    /** The store-wide version: a read with it as `after` returns only what changes from now on. */
    get v() { return v },
    /** How many runs the store holds now, how many of them are live, and the input it could not read. */
    stats: () => ({ runs: runs.size, live: [...runs.values()].filter((r) => r.endedAt == null).length, dropped: droppedTotal }),
    /**
     * The plugin is closing or applied again: resolves once the saves and deletes asked for so far
     * have landed, and none is made after, but by a plugin that reopens the store. A run still going
     * keeps its steps in memory only: the plugin that replaces this one keeps the task list and the
     * transcripts beside it from now on, and a save from here could put back a file it has deleted,
     * for a task no longer in any list.
     */
    dispose() {
      disposed = true
      return flushed()
    },
    /**
     * The plugin applied again on the same data folder goes on with this store (index.js, handover.js):
     * it saves and deletes again, now for the task list of that plugin, which has taken over the tasks
     * whose runs still feed it from the plugin that closed, starting with what the store was asked
     * meanwhile, as a run of one ended before that plugin was applied.
     */
    reopen() {
      disposed = false
      const due = [...owed]
      owed.clear()
      for (const [key, what] of due) (what === 'drop' ? drop : persist)(key)
    },
  }
}
