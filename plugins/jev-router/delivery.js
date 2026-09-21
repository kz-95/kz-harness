// Posting a finished background result into its conversation.
//
// This is pulled out of the plugin body because it is the one path that must not go wrong, and
// inside a closure it could not be tested at all: it decides whether a person ever learns what
// happened to their task, and whether they are told twice.
//
// Two rules shape it:
//   1. The result is its own message, appended to the session - never text inside a model's
//      answer. The engine runs no model turn for an append, so it cannot interrupt one.
//   2. It is delivered at most once. `tasks.delivering()` is a claim: only the caller that moves
//      the record out of `pending` may append, and the claim is taken *after* waiting for the
//      agent to go idle, because that wait is exactly where a second attempt could start.
import { randomUUID } from 'node:crypto'
import { TASK_LABELS, resultSection } from './adapter.js'

/** How many times a delivery that never landed is retried before the result is left unread. */
const MAX_TRIES = 5
const RETRY_CEILING_MS = 30_000

/**
 * @param {object} p
 * @param {object} p.tasks  the task registry (delivering/undeliver are its delivery state machine)
 * @param {(m: string) => void} [p.log]
 * @param {(r: object, body: string) => Promise<string>} [p.format]  rewrites a result body before
 *   it is posted (message transfer). Injected lazily, because the local model it uses only exists
 *   once the plugin's llm block has run. Identity by default.
 * @param {() => void} [p.setTimer]  injectable so a test can drive retries without waiting
 */
export function createDelivery({ tasks, log = () => {}, format = async (_r, body) => body, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t } }) {
  /**
   * Append one finished result to its own conversation. Returns false when no message was
   * created, so the caller can retry it later; true when it is in the conversation (which is
   * not the same as a person having seen it - the browser acknowledges that separately).
   */
  async function deliver(r, owner) {
    const session = owner?.session
    if (!session?.append) return false
    // Never write into a streaming answer: wait for the agent to be idle first. A rejection here
    // must not lose the result - it stays unclaimed, and therefore still on offer.
    try { await owner.whenIdle?.() } catch {}
    // The report is rewritten before the claim, not after: a rewrite is a slow local model call and
    // can fail, and failing after the claim would strand the record in `delivering` with no
    // message and nothing to retry. Only the report goes through it; the structured head stays
    // exactly as written, and so does the terminal reason that resultSection puts in front of the
    // report when a task did not complete, so the task, id, agent, status and reason are never
    // touched. A formatter failure keeps the raw report.
    const full = resultSection(r)
    const cut = full.indexOf('\n\n')
    let text = full
    if (cut >= 0) {
      const head = full.slice(0, cut)
      // resultSection joins [terminalReason, report] with a blank line, so a reason is the exact
      // prefix of the body. Take it back out and keep it raw; when the body does not start with
      // it, there is no separate reason to split off.
      const reason = r.state === 'completed' ? null : r.terminalReason || null
      let body = full.slice(cut + 2)
      const kept = reason && body.startsWith(reason) ? reason : null
      if (kept) body = body.slice(kept.length).replace(/^\n\n/, '')
      if (body) {
        try {
          const rewritten = await format(r, body)
          if (typeof rewritten === 'string' && rewritten.trim()) body = rewritten
        } catch {}
      }
      text = `${head}\n\n${[kept, body].filter(Boolean).join('\n\n')}`
    }
    // Claimed only now. `delivering` returns true for exactly one caller per result, so two
    // attempts racing after the wait cannot both append the same report.
    if (!tasks.delivering(r.jobId)) return true
    const msg = {
      // A fresh id every time: the inbox rejects a duplicate id and the UI keys rows on it.
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      // form 'notice' reuses the engine's own collapsed context row, which is how a background
      // result is meant to look. The job id leads the summary so the browser half can match the
      // row it rendered back to this record.
      source: { kind: 'plugin', plugin: 'jev-router', form: 'notice', summary: `${r.jobId} · ${r.taskName} · ${TASK_LABELS[r.state] ?? r.state}` },
    }
    try {
      session.append('user/message', msg, { surfaceOp: 'append' })
    } catch (err) {
      // No message exists, so put it back on offer rather than marking it handled.
      tasks.undeliver(r.jobId)
      log(`result ${r.jobId} not delivered: ${err.message}`)
      return false
    }
    return true
  }

  /**
   * Deliver, and keep trying if nothing landed. The contract is that a result stays unread until
   * it is really in the conversation, so giving up silently would lose it; bounded, so a
   * permanently broken session cannot spin.
   */
  const tries = new Map()
  async function deliverWithRetry(r, owner) {
    if (await deliver(r, owner)) { tries.delete(r.jobId); return true }
    const n = (tries.get(r.jobId) ?? 0) + 1
    tries.set(r.jobId, n)
    if (n > MAX_TRIES) {
      log(`result ${r.jobId} could not be delivered after ${n} attempts; it stays unread in the task list`)
      return false
    }
    setTimer(() => { deliverWithRetry(r, owner).catch(() => {}) }, Math.min(RETRY_CEILING_MS, 1000 * 2 ** n))
    return false
  }

  return { deliver, deliverWithRetry }
}
