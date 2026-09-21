// Like/Dislike on a finished answer, plus the reason the person gave.
//
// Append-only JSONL next to history.jsonl and tasks.jsonl. One row per verdict. Nothing here
// talks to Jev: it validates, stores and reads back, and router.js folds the read-back rows
// into the routing priors.
//
// Upsert without rewriting: a second verdict for the same message in the same session is a new
// row, and the reader keeps only the newest row per (sessionId, messageId). That is still
// append-safe - a crash can only truncate the row being written, so every earlier verdict
// survives, and the half-written line is skipped the same way tasks.jsonl skips its own.
//
// Clearing a verdict is the same discipline, not a delete: the client sends `verdict: 'clear'`,
// which appends a TOMBSTONE row, and list() drops a pair whose newest row is a tombstone. A
// crash mid-write can only truncate the new tombstone line, which the reader already skips. That
// leaves the earlier like or dislike row untouched and still parsing, so the only possible
// outcome is that the clear did not take effect: an earlier verdict is never lost by a clear.
//
// The optional `tag` rides along on the same row, so it obeys the same two rules: the newest row
// per (sessionId, messageId) is the one read back, tag included, and a tombstone drops the pair
// with its tag. A newer row without a tag therefore replaces an earlier tagged one, which is the
// same "newest wins" rule, and clearing carries no tag because there is no verdict to describe.
// A tag is only ever one of the fixed TAGS below: an unknown value is rejected before it is
// stored, because the reader decides what may move routing from the tag alone, and a typo must
// not fall through as a category nobody chose.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SESSION_ID } from './export.js'

export const VERDICTS = Object.freeze(['like', 'dislike'])
// The wire value that stores "no verdict". Not a verdict: a marker that the pair is cleared.
export const CLEAR = 'clear'
const ACCEPTED = Object.freeze([...VERDICTS, CLEAR])
// What a verdict was about. The first group is a statement about the ROUTING, and only these may
// move an agent's bias. The second is a statement about the ANSWER alone: router.js still carries
// its text and tag into the routing prompt as context, but it never votes, so it can neither
// demote nor promote a pick. Untagged means no category was chosen and keeps the old behaviour.
export const ROUTING_TAGS = Object.freeze(['wrong agent', 'misread my question', 'wrong scope', 'good pick'])
export const ANSWER_TAGS = Object.freeze(['not enough detail', 'too slow', 'good answer'])
export const TAGS = Object.freeze([...ROUTING_TAGS, ...ANSWER_TAGS])
const ANSWER_ONLY = new Set(ANSWER_TAGS)
/** True for a tag that must not demote or promote a pick. Untagged is routing affecting. */
export const tagIsAnswerOnly = (tag) => ANSWER_ONLY.has(tag)
// A row's own key, from the browser: the assistant message id the control sits under.
const MESSAGE_ID = /^[\w.:-]{1,200}$/
const AGENT_ID = /^[a-z][a-z0-9_-]{0,40}$/
const PROVIDER = /^[\w.-]{1,64}$/
const MODEL = /^[\w.:/+-]{1,128}$/
export const MAX_REASON = 2000

/**
 * A POSTed body turned into one stored record, or a thrown Error the route returns as a 400.
 * Same shape as validHotkeys: reject the whole body rather than store a half-valid row.
 * `sessionId` is the conversation, `messageId` the answer message, `verdict` like or dislike,
 * `reason` the one-line text (may be empty), `tag` what the verdict was about (optional, one of
 * TAGS), `suggestedAgent` the agent it should have been, and `provider` / `model` the answer's
 * model, which is how router.js attributes the verdict.
 * A `verdict` of `clear` is the tombstone: it needs only the two ids, and any reason, tag or
 * attribution in the body is ignored rather than stored on a row that has no verdict.
 */
export function validFeedback(body, { now = () => new Date().toISOString() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected an object')
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!SESSION_ID.test(sessionId)) throw new Error('sessionId: the conversation id')
  const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : ''
  if (!MESSAGE_ID.test(messageId)) throw new Error('messageId: the answer message id')
  if (!ACCEPTED.includes(body.verdict)) throw new Error(`verdict: ${VERDICTS.join(', ')}, or ${CLEAR}`)
  // The clear needs no more than its keys: it is the absence of a verdict, not one.
  if (body.verdict === CLEAR) return { ts: now(), sessionId, messageId, verdict: CLEAR }
  // Free text is collapsed to one line: the client shows a one-line box, and a pasted block
  // would otherwise ride the routing prompt intact. Empty stays empty, and is not an error.
  const reason = body.reason == null ? '' : String(body.reason).replace(/\s+/g, ' ').trim()
  if (reason.length > MAX_REASON) throw new Error(`reason: one line, at most ${MAX_REASON} characters`)
  // Optional category. Rejected rather than stored when unknown: router.js reads routing rights
  // off this value, so a typo must not be silently treated as a category nobody picked.
  const tag = body.tag == null ? '' : String(body.tag).trim()
  if (tag && !TAGS.includes(tag)) throw new Error(`tag: one of ${TAGS.join(', ')}`)
  const suggestedAgent = typeof body.suggestedAgent === 'string' ? body.suggestedAgent.trim() : ''
  if (suggestedAgent && (!AGENT_ID.test(suggestedAgent) || suggestedAgent === 'auto')) throw new Error('suggestedAgent: a specific agent id')
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  if (provider && !PROVIDER.test(provider)) throw new Error('provider: an agent or provider id')
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (model && !MODEL.test(model)) throw new Error('model: a model id')
  return {
    ts: now(),
    sessionId,
    messageId,
    verdict: body.verdict,
    reason,
    ...(tag ? { tag } : {}),
    ...(suggestedAgent ? { suggestedAgent } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  }
}

/**
 * @param {object} p
 * @param {string} p.file        feedback.jsonl
 * @param {() => string} [p.now] the clock, injectable so a test can order rows
 */
export function createFeedback({ file, now = () => new Date().toISOString() }) {
  // Same tolerant read as index.js's history reader and tasks.js: a line that does not parse is
  // dropped, which is exactly what a write cut off by a crash looks like. A missing file is
  // empty, never an error: nobody has given feedback yet is the normal state.
  const rows = async () => {
    const raw = await readFile(file, 'utf8').catch(() => '')
    const out = []
    for (const l of raw.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(l)) } catch { /* a truncated final line */ }
    }
    return out
  }

  return {
    /** Append one verdict. Never rewrites: nothing already stored can be lost by this write. */
    async append(record) {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(record)}\n`)
      return record
    },
    /**
     * Parsed records, newest last. One row per message: the newest verdict for a
     * (sessionId, messageId) replaces the earlier one, tag and all, so changing your mind or
     * changing the category works and no duplicate reaches the routing prior. A pair whose
     * newest row is a tombstone is dropped
     * here: the verdict was cleared, so it is not read back and not counted. With no `sessionId`,
     * every session is returned.
     */
    async list(sessionId) {
      const newest = new Map() // "sessionId\nmessageId" -> record, later file rows overwrite
      for (const r of await rows()) {
        if (!r || typeof r !== 'object' || !r.sessionId || !r.messageId) continue
        if (sessionId && r.sessionId !== sessionId) continue
        newest.set(`${r.sessionId}\n${r.messageId}`, r)
      }
      const kept = [...newest.values()].filter((r) => r.verdict !== CLEAR)
      // Stable order by timestamp; a record with no readable ts keeps its file position.
      const at = (r) => { const t = Date.parse(r.ts); return Number.isNaN(t) ? 0 : t }
      return kept.map((r, i) => [r, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([r]) => r)
    },
  }
}
