// Message transfer: before a finished background result is posted into the chat, its body is
// rewritten into readable prose by the small local model. The structured head (task, id, agent,
// status) is left exactly as written; only the report body travels through the model.
//
// Two rules shape it:
//   1. A person's result is never lost to a rewrite. Every failure, timeout, empty answer or
//      missing local model returns the report unchanged, so the worst case is the text that
//      would have been posted anyway.
//   2. The model has a small context. A report too big for one call is cut on line boundaries,
//      each part is rewritten on its own, and the answers are stitched back in order. The parts
//      are written under <workspace>/.kz-harness/format so a bad rewrite can be read back.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCAL_PROVIDER } from './local.js'

/**
 * Characters per token for `estimateTokens`. Deliberately low: four characters per token
 * over-counts dense reports and code, so the budget errs toward splitting rather than
 * overflowing the model. The raw report is capped at 20000 characters, about 5000 tokens here.
 */
const CHARS_PER_TOKEN = 4

/** Context assumed when the model catalog cannot say how big the window is. */
const FALLBACK_CTX = 8192
/** Below this many tokens there is no room for a prompt and an answer, so do not split at all. */
const MIN_BUDGET = 512

/** The rewrite instruction. It keeps facts, forbids invention, and bans markdown symbols. */
const SYSTEM = [
  'You rewrite a finished background task report into clean, readable prose for a chat message.',
  'Keep every fact, number, name, path and identifier exactly as it appears in the report.',
  'Add nothing that is not in the report and do not draw conclusions it does not state.',
  'Write plain prose in short paragraphs, using no markdown symbols at all:',
  'no asterisks, hashes, backticks, underscores, brackets or bullet characters.',
  'Do not restate or change the task name, the task id, the agent or the status: those lines are added separately.',
  'If the report is already readable prose, return it almost unchanged.',
].join(' ')

// Link definitions a report carries for the client, not for a reader: router.js's agent chain
// (the chips under an answer) and index.js's run mark (the run a verdict is credited to). The
// markdown renderer drops them. The model is told to drop brackets, so they never go through it.
const MACHINE_LINE = /^\[(?:jev-agents|jev-run)\]:\s*\S+\s*$/

/** The report without its machine lines, and those lines, in order and exactly as written. */
export function machineLines(text) {
  const prose = []
  const marks = []
  for (const line of String(text ?? '').split('\n')) (MACHINE_LINE.test(line) ? marks : prose).push(line)
  return { prose: prose.join('\n').trimEnd(), marks }
}

/** Rough token count of `text`: length divided by CHARS_PER_TOKEN, rounded up. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN)
}

/**
 * Split `text` into parts of at most `budgetTokens` estimated tokens each, cutting on line
 * boundaries and hard-splitting any single line bigger than the budget. The parts are in order
 * and `parts.join('')` is exactly `text`: nothing is dropped, reordered or added.
 */
export function splitParts(text, budgetTokens) {
  const src = String(text ?? '')
  if (!src) return []
  const maxChars = Math.max(1, Math.floor(budgetTokens) * CHARS_PER_TOKEN)
  const parts = []
  let cur = ''
  // Split after each newline, so every line keeps its own terminator and the joins are exact.
  for (const line of src.split(/(?<=\n)/)) {
    if (line.length > maxChars) {
      if (cur) { parts.push(cur); cur = '' }
      for (let i = 0; i < line.length; i += maxChars) parts.push(line.slice(i, i + maxChars))
      continue
    }
    if (cur && cur.length + line.length > maxChars) { parts.push(cur); cur = '' }
    cur += line
  }
  if (cur) parts.push(cur)
  return parts
}

/** Join rewritten parts into one body: trimmed, one blank line between, empty answers dropped. */
export function stitchParts(parts) {
  return (parts ?? []).map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n')
}

/** The user turn for one rewrite: the task context, the instruction, then the text to rewrite. */
function reportPrompt(r, text, part) {
  return [
    `Task: ${r?.taskName ?? 'a background task'} (status: ${r?.state ?? 'unknown'}).`,
    ...(part ? [`This is part ${part.n} of ${part.of} of the report.`] : []),
    'Rewrite the report body below as plain readable prose. Keep every fact and number, add nothing, and do not restate the task name or status.',
    '',
    text,
  ].join('\n')
}

/**
 * Build the formatter used when a background result settles. Every dependency is injectable so
 * this can be tested without a model: `stream` is the engine's streaming call, `chatModel` the
 * installed local chat model id (null when none), `contextOf` its context window in tokens.
 *
 * The returned function always resolves to a string. It returns `rawText` unchanged when the
 * feature is off, when there is no local model, and on any error, timeout, failure or empty
 * answer, so a result is never posted empty.
 *
 * @param {object} p
 * @param {(opts: object) => AsyncIterable<object>} p.stream  ctx.llm.stream
 * @param {() => Promise<string|null>} p.chatModel
 * @param {(id: string) => number|null} [p.contextOf]
 * @param {(m: string) => void} [p.log]
 * @param {boolean} [p.enabled]
 * @param {number} [p.timeoutMs]  wall clock for one model call
 * @param {number} [p.reserveTokens]  context kept back for the prompt and the answer
 */
export function createFormatter({ stream, chatModel, contextOf = () => null, log = () => {}, enabled = true, timeoutMs = 60_000, reserveTokens = 2048 } = {}) {
  /** One completion, accumulated by hand: there is no non-streaming helper. Null on any failure. */
  async function ask(model, promptText) {
    const signal = AbortSignal.timeout(timeoutMs)
    let text = ''
    let failed = false
    for await (const chunk of stream({
      provider: LOCAL_PROVIDER,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
      system: SYSTEM,
      signal,
    })) {
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failed = true
    }
    return failed || !text.trim() ? null : text.trim()
  }

  /** Best effort: the part files are a record of what was sent, never required for the result. */
  async function writePart(r, n, text) {
    if (typeof r?.workspace !== 'string' || !r.workspace) return
    const dir = join(r.workspace, '.kz-harness', 'format')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${r.jobId}-part-${n}.md`), text)
  }

  /** Split, rewrite each part, stitch. Returns null when any part fails, so the raw text stands. */
  async function inParts(model, r, raw, budget) {
    const parts = splitParts(raw, budget)
    const answers = []
    for (let i = 0; i < parts.length; i++) {
      await writePart(r, i + 1, parts[i])
      const out = await ask(model, reportPrompt(r, parts[i], { n: i + 1, of: parts.length }))
      if (out == null) return null
      answers.push(out)
    }
    return stitchParts(answers)
  }

  return async function format(r, rawText) {
    const raw = String(rawText ?? '')
    if (!enabled || !raw.trim()) return raw
    try {
      const model = await chatModel()
      if (!model) return raw
      const window = Number(contextOf?.(model))
      const budget = Math.floor((Number.isFinite(window) && window > 0 ? window : FALLBACK_CTX) - reserveTokens)
      if (budget < MIN_BUDGET) return raw
      const { prose, marks } = machineLines(raw)
      if (!prose.trim()) return raw
      const out = estimateTokens(prose) <= budget
        ? await ask(model, reportPrompt(r, prose))
        : await inParts(model, r, prose, budget)
      return out == null ? raw : marks.length ? `${out}\n\n${marks.join('\n')}` : out
    } catch (err) {
      log(`format: ${r?.jobId ?? '?'} posted as written: ${err.message}`)
      return raw
    }
  }
}
