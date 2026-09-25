// The docs writer's queue (docs/handoff.md, "Rules that were applied and must keep being applied").
// Agents working in parallel never edit the docs themselves: they queue what the docs must now say,
// and one writer, never two at once, checks each note against the code and writes it in.
//
//   node scripts/doc-queue.mjs add --doc <docs/x.md | README.md> --fact "<text>" [--section "<heading>"] [--evidence "<file:line or command>"] [--by "<who>"]
//   node scripts/doc-queue.mjs list [--json]
//   node scripts/doc-queue.mjs done <id> [<id> ...]
//   node scripts/doc-queue.mjs log --step "<step>" --summary "<one line>" [--commit <sha>] [--tests "<tests> <pass> <fail> <skipped>"] [--at <ISO time the step ended>]
//
// `add` only appends one line to .doc-queue.jsonl at the repository root (git-ignored, as every
// dotfile is), so notes from agents running at the same time never collide. `done` and `log`
// rewrite a file, so they take a lock first. `log` needs no model: it writes a dated line for a
// finished step at the top of the "Progress log" section of docs/handoff.md, so the handoff says
// how far a run got even when the run dies before its last step.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

export const QUEUE = '.doc-queue.jsonl'
const LOCK = '.doc-queue.lock'
const LOG_DOC = 'docs/handoff.md'
const LOG_HEADING = '## Progress log'
const LOG_INTRO = 'One line per finished workflow step, newest first, written by `scripts/doc-queue.mjs log` when the step ends.'
const DASHES = /[\u2013\u2014]/
const MAX_FACT = 2000
const MAX_FIELD = 500

/** The repository a path belongs to: its git top level. */
export function repoRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
}

function text(value, name, { max = MAX_FIELD, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${name} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`${name} must be text`)
  const t = value.trim()
  if (!t && required) throw new Error(`${name} is required`)
  if (t.length > max) throw new Error(`${name} is over ${max} characters`)
  if (DASHES.test(t)) throw new Error(`${name} holds an em dash or en dash; use a hyphen or rewrite it`)
  return t || undefined
}

/** A doc the writer may edit: README.md or a Markdown file under docs/, inside the repository. */
function docPath(root, doc) {
  const rel = normalize(text(doc, 'doc', { required: true })).replace(/\\/g, '/')
  const abs = resolve(root, rel)
  const inside = relative(root, abs).replace(/\\/g, '/')
  if (inside.startsWith('..') || !(inside === 'README.md' || (inside.startsWith('docs/') && inside.endsWith('.md')))) {
    throw new Error(`doc must be README.md or a Markdown file under docs/, not ${doc}`)
  }
  if (!existsSync(abs)) throw new Error(`doc ${inside} does not exist`)
  return inside
}

/** Queue one note. Returns it, with the id `done` takes. */
export function addNote(root, { doc, fact, section, evidence, by }, { now = () => new Date() } = {}) {
  const note = {
    id: `${now().getTime().toString(36)}-${randomBytes(3).toString('hex')}`,
    ts: now().toISOString(),
    doc: docPath(root, doc),
    ...(text(section, 'section') ? { section: text(section, 'section') } : {}),
    fact: text(fact, 'fact', { max: MAX_FACT, required: true }),
    ...(text(evidence, 'evidence') ? { evidence: text(evidence, 'evidence') } : {}),
    ...(text(by, 'by') ? { by: text(by, 'by') } : {}),
  }
  // One write of one line: appends from processes running at the same time stay whole lines.
  appendFileSync(join(root, QUEUE), `${JSON.stringify(note)}\n`)
  return note
}

/** Every pending note, oldest first. A line that is not a note is reported, never dropped silently. */
export function listNotes(root) {
  const file = join(root, QUEUE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) } catch { throw new Error(`${QUEUE} line ${i + 1} is not a note: ${line.slice(0, 80)}`) }
  })
}

/** Hold the queue's lock while `fn` runs; a lock left by a process that died is taken after staleMs. */
export function withLock(root, fn, { waitMs = 10_000, staleMs = 60_000, sleep = sleepSync } = {}) {
  const lock = join(root, LOCK)
  const until = Date.now() + waitMs
  for (;;) {
    try { mkdirSync(lock); break } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let age = 0
      try { age = Date.now() - statSync(lock).mtimeMs } catch { continue }
      if (age > staleMs) { rmSync(lock, { recursive: true, force: true }); continue }
      if (Date.now() > until) throw new Error(`the doc queue is locked by another writer (${LOCK}); try again`)
      sleep(50)
    }
  }
  try { return fn() } finally { rmSync(lock, { recursive: true, force: true }) }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

/** Remove the notes the writer has written in. An id that is not queued is an error: nothing is removed. */
export function markDone(root, ids) {
  if (!ids.length) throw new Error('done needs at least one id')
  return withLock(root, () => {
    const notes = listNotes(root)
    const known = new Set(notes.map((n) => n.id))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length) throw new Error(`not queued: ${unknown.join(', ')}`)
    const drop = new Set(ids)
    const left = notes.filter((n) => !drop.has(n.id))
    writeAtomic(join(root, QUEUE), left.map((n) => `${JSON.stringify(n)}\n`).join(''))
    return { removed: ids.length, left: left.length }
  })
}

/** The dated line for one finished step. */
export function progressLine({ step, summary, commit, tests, at }, { now = () => new Date() } = {}) {
  const s = text(step, 'step', { required: true })
  const what = text(summary, 'summary', { max: MAX_FACT, required: true })
  if (/\n/.test(what)) throw new Error('summary must be one line')
  const c = text(commit, 'commit')
  if (c && !/^[0-9a-f]{7,40}$/.test(c)) throw new Error('commit must be a commit sha')
  let t = null
  const tt = text(tests, 'tests')
  if (tt) {
    const n = tt.split(/[\s/,]+/).map(Number)
    if (n.length !== 4 || n.some((x) => !Number.isInteger(x) || x < 0)) throw new Error('tests must be four whole numbers: tests pass fail skipped')
    t = `${n[0]} tests, ${n[1]} pass, ${n[2]} fail, ${n[3]} skipped`
  }
  // A step written in after the fact keeps the time it ended.
  const at_ = text(at, 'at')
  if (at_ && Number.isNaN(Date.parse(at_))) throw new Error('at must be an ISO time')
  const when = (at_ ? new Date(at_) : now()).toISOString().replace('T', ' ').slice(0, 16)
  const tail = [c && `commit ${c.slice(0, 7)}`, t].filter(Boolean).join('; ')
  return `- ${when} UTC, ${s}: ${what.replace(/\.$/, '')}${tail ? ` (${tail})` : ''}.`
}

/** Put a step's line at the top of the handoff's Progress log, making the section after State when it is missing. */
export function logProgress(root, entry, opts = {}) {
  const line = progressLine(entry, opts)
  return withLock(root, () => {
    const file = join(root, LOG_DOC)
    if (!existsSync(file)) throw new Error(`${LOG_DOC} does not exist`)
    const lines = readFileSync(file, 'utf8').split('\n')
    let at = lines.indexOf(LOG_HEADING)
    let end
    if (at < 0) {
      // After the State section, which is where a reader looks first; else at the end.
      const state = lines.indexOf('## State')
      at = state < 0 ? -1 : lines.findIndex((l, i) => i > state && l.startsWith('## '))
      if (at < 0) at = lines.length
      end = at
    } else {
      end = lines.findIndex((l, i) => i > at && l.startsWith('## '))
      if (end < 0) end = lines.length
    }
    // The section is rebuilt whole: heading, intro, the entries newest first, then anything else a
    // person wrote there, so its spacing never drifts however often it is written.
    const body = lines.slice(at + 1, end).filter((l) => l !== LOG_INTRO)
    const entries = body.filter((l) => l.startsWith('- '))
    const other = body.filter((l) => l.trim() && !l.startsWith('- '))
    const section = [LOG_HEADING, '', LOG_INTRO, '', line, ...entries, '', ...(other.length ? [...other, ''] : [])]
    lines.splice(at, end - at, ...section)
    writeAtomic(file, lines.join('\n'))
    return line
  })
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (key === 'json') { out.json = true; continue }
      if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`)
      out[key] = argv[++i]
    } else out._.push(a)
  }
  return out
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), print = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const [command, ...rest] = argv
  const a = parseArgs(rest)
  const root = repoRoot(cwd)
  switch (command) {
    case 'add': {
      const note = addNote(root, a)
      print(note.id)
      return 0
    }
    case 'list': {
      const notes = listNotes(root)
      if (a.json) { print(JSON.stringify(notes, null, 2)); return 0 }
      if (!notes.length) { print('The doc queue is empty.'); return 0 }
      for (const n of notes) print(`${n.id}  ${n.doc}${n.section ? ` > ${n.section}` : ''}: ${n.fact}${n.evidence ? ` [${n.evidence}]` : ''}${n.by ? ` (${n.by})` : ''}`)
      return 0
    }
    case 'done': {
      const r = markDone(root, a._)
      print(`removed ${r.removed}, ${r.left} left`)
      return 0
    }
    case 'log': {
      print(logProgress(root, a))
      return 0
    }
    default:
      throw new Error('usage: doc-queue.mjs add | list | done | log (see the top of scripts/doc-queue.mjs)')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (err) { process.stderr.write(`doc-queue: ${err.message}\n`); process.exitCode = 1 }
}
