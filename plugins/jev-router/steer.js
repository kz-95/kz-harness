// Steer on a running task (docs/live-agent-view.md Feature 5, slice 8): the person's words reach the
// agent at work where its provider can take them mid-run, and every prompt the router builds after
// carries them, so a retry, a plan or a review works to them too. This file decides and words, and
// keeps no files: which attempts can be steered (the registry), whether the agent at work takes words
// now and how (the delivery policy), what becomes of a piece of guidance (the outcome machine), and
// the words for each. index.js sends them, and tasks.js keeps each piece on its task (`steers`).
//
// A piece of guidance is `pending` until the agent it was sent to reads it (`delivered`), a prompt
// built later carries it to the next attempt (`carried`), or the work ends without it (`returned`); a
// provider that cannot say whether it read it leaves it `unknown`. Words added to a task before it
// started are `added`: they are part of its text from its first prompt on (tasks.js amend).
//
// Send now (slice 10) stops the agent's current step and gives it the words as what it does next,
// on the same agent: a spawn child's turn is cancelled and the words are its next turn, a patched
// Codex goes on with them on the same thread at the effort its run started with, and a Claude Code
// run started with its input channel (Settings, "Let Steer reach a running Claude Code") is
// interrupted and handed them. A piece sent so is kept with `how: 'now'`.

/** What a steer is sent with, so the agent can tell the person's words from its task. */
export const STEER_PREFIX = '(Added by the person while you work on this task.) '

/** The roles of an attempt that can be steered: the work. An opinion or a review cannot. */
export const STEERABLE_ROLES = Object.freeze(['primary', 'retry', 'plan'])

/** Whether an attempt in `role` can be steered. */
export const steerableRole = (role) => STEERABLE_ROLES.includes(role)

/** How long a Codex turn/steer may take to be accepted before the words are taken as sent anyway. */
export const STEER_ACCEPT_MS = 10_000

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const lower = (s) => (s ? `${s[0].toLowerCase()}${s.slice(1)}` : s)
const upper = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s)
/** A time of day as the person reads it on this PC: `14:02`. */
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

// ---- the registry ----------------------------------------------------------------------------------

/**
 * The attempts at work that can be steered now, one per run at most (index.js runAgent sets each as
 * its agent starts): `add` answers the function that lets it go, which lets go only that attempt, so
 * an attempt that ends never takes a later one of its run with it.
 */
export function createSteerers() {
  const byRun = new Map()
  return {
    add(runId, entry) {
      if (typeof runId !== 'string' || !runId || !entry) return () => {}
      byRun.set(runId, entry)
      return () => { if (byRun.get(runId) === entry) byRun.delete(runId) }
    },
    /** The attempt of the run at work that can be steered now, or null. */
    of: (runId) => byRun.get(runId) ?? null,
    get size() { return byRun.size },
  }
}

// ---- the delivery policy ---------------------------------------------------------------------------

/** Why the person's words wait for the next attempt while no agent that takes them is at work, which the Steer dialog still sends. */
export const IDLE_WHYS = Object.freeze(['checks', 'review', 'between', 'ending'])

const isTool = (entry) => entry.role === 'tool' || String(entry.agentId ?? '').startsWith('tool:')
const isClaude = (entry) => entry.provider === 'claude-code' || entry.provider === 'claude-code-readonly'

/**
 * Whether a Claude Code run takes words through its input channel by the engine patch's `hook`
 * (`steer` or `sendNow`): only with Settings' switch on now ('claude-off' with it off), through a
 * patched connector ('unpatched'), and for a run started with the channel, which the switch gives
 * the runs started while it is on ('claude' for one started before).
 */
function claudeWay(entry, claudeSteer, hook) {
  if (!claudeSteer) return { path: null, why: 'claude-off' }
  if (typeof entry.control?.[hook] !== 'function') return { path: null, why: 'unpatched' }
  if (entry.control.channel !== true) return { path: null, why: 'claude' }
  return { path: 'claude', why: null }
}

/**
 * How the agent at work in `entry` (the registry's) takes the person's words now: `path` 'spawn'
 * (DeepSeek, an API agent or a local model, through its in-process agent's inbox), 'codex' (through
 * the engine patch's turn/steer) or 'claude' (through the input channel of a Claude Code run, behind
 * Settings' switch, claudeWay), else null and `why` not. Without an entry no agent is at work
 * ('idle'); a Codex connector without the engine patch has no way in ('unpatched'), and neither has
 * a configured tool ('tool') or any other agent ('none').
 */
export function livePath(entry, { claudeSteer = false } = {}) {
  if (!entry) return { path: null, why: 'idle' }
  if (isTool(entry)) return { path: null, why: 'tool' }
  if (isClaude(entry)) return claudeWay(entry, claudeSteer, 'steer')
  if (entry.provider === 'codex') return typeof entry.control?.steer === 'function' ? { path: 'codex', why: null } : { path: null, why: 'unpatched' }
  if (typeof entry.sub?.localAgent?.steer === 'function') return { path: 'spawn', why: null }
  return { path: null, why: 'none' }
}

/**
 * How the agent at work in `entry` takes Send now, its current step stopped for the person's words:
 * `path` 'spawn' (its in-process agent's turn cancelled and the words queued as its next turn),
 * 'codex' (the engine patch interrupts the turn and goes on with the words on the same thread) or
 * 'claude' (the input channel: interrupted, then handed the words), else null and `why`, as
 * livePath says it.
 */
export function nowPath(entry, { claudeSteer = false } = {}) {
  if (!entry) return { path: null, why: 'idle' }
  if (isTool(entry)) return { path: null, why: 'tool' }
  if (isClaude(entry)) return claudeWay(entry, claudeSteer, 'sendNow')
  if (entry.provider === 'codex') return typeof entry.control?.sendNow === 'function' ? { path: 'codex', why: null } : { path: null, why: 'unpatched' }
  const agent = entry.sub?.localAgent
  if (typeof agent?.cancel === 'function' && typeof agent.followup === 'function') return { path: 'spawn', why: null }
  return { path: null, why: 'none' }
}

/**
 * Why words wait while no agent that takes them is at work, by where the run stands (live.js
 * `phase`) and the attempt it has at work, if any (live.js `atWorkOf`): a configured tool ('tool'),
 * which takes none, an agent's review, its checks after an attempt, its end, or between two attempts
 * (its first not started yet included).
 */
export function idleWhy(phase, atWork = null) {
  if (atWork && (atWork.detail === 'tool' || atWork.role === 'tool' || String(atWork.agent ?? '').startsWith('tool:'))) return 'tool'
  if (atWork?.role === 'review') return 'review'
  if (phase === 'checking' || phase === 'checks') return 'checks'
  if (phase === 'reviewing') return 'review'
  if (phase === 'ending' || phase === 'done') return 'ending'
  return 'between'
}

/** A connector hook's promise, or the end of `acceptMs`, whichever comes first: one not answered by then is taken as having taken the words. */
async function accepted(promise, acceptMs) {
  let timer
  const late = new Promise((r) => { timer = setTimeout(r, acceptMs) })
  try { await Promise.race([promise, late]) } finally { clearTimeout(timer) }
}

/** The person's words as an agent is handed them: the steer's prefix first. */
const userMessage = (id, texts) => ({ id, role: 'user', content: texts.map((t) => ({ type: 'text', text: `${STEER_PREFIX}${t}` })), source: { kind: 'user' } })

/**
 * Hand the person's words to the agent at work by `path`, prefixed (STEER_PREFIX), under the steer's
 * own `id`, which the agent reports back as it reads them. Answers `{ sent: true }`, or `{ sent:
 * false, why }` when the agent refused them (Codex with no turn running, or in a review or compaction
 * turn; Claude Code once its input channel has closed); a connector's hook not answered within
 * `acceptMs` is taken as sent. Never throws.
 */
export async function sendLive(entry, path, { id, text, acceptMs = STEER_ACCEPT_MS } = {}) {
  try {
    if (path === 'spawn') {
      entry.sub.localAgent.steer(userMessage(id, [text]))
      return { sent: true }
    }
    if (path === 'codex' || path === 'claude') {
      await accepted(Promise.resolve(entry.control.steer(`${STEER_PREFIX}${text}`, id)), acceptMs)
      return { sent: true }
    }
  } catch (err) { return { sent: false, why: String(err?.code ?? err?.message ?? err) } }
  return { sent: false, why: 'none' }
}

/**
 * Send now: the agent at work stops its current step and takes the person's words, prefixed, as what
 * it does next, under the piece's own `id`, by `path` (nowPath). A spawn child first gives back from
 * its inbox each of `unclaimed` (the steers sent to it that it has not taken in, `{ id, text }`), then
 * its turn is cancelled with the rest of its inbox kept, and the words go as its next turn, after
 * the words it gave back, so nothing it was told is lost and nothing it was told runs as a turn of
 * its own first. Codex and Claude Code are handed them through the engine patch's `sendNow`, which
 * interrupts the turn; one not answered within `acceptMs` is taken as sent. Answers `{ sent: true,
 * folded }`, `folded` the ids given back, or `{ sent: false, why }`. Never throws.
 */
export async function sendNow(entry, path, { id, text, unclaimed = [], acceptMs = STEER_ACCEPT_MS } = {}) {
  try {
    if (path === 'spawn') {
      const agent = entry.sub.localAgent
      const folded = []
      for (const s of unclaimed) {
        try { if (agent.inbox?.remove?.(s.id) === true) folded.push(s) } catch { /* it stays where it is */ }
      }
      agent.cancel({ kind: 'parent' }, { keepInbox: true })
      agent.followup(userMessage(id, [...folded.map((s) => s.text), text]))
      return { sent: true, folded: folded.map((s) => s.id) }
    }
    if (path === 'codex' || path === 'claude') {
      await accepted(Promise.resolve(entry.control.sendNow(`${STEER_PREFIX}${text}`, id)), acceptMs)
      return { sent: true, folded: [] }
    }
  } catch (err) { return { sent: false, why: String(err?.code ?? err?.message ?? err) } }
  return { sent: false, why: 'none' }
}

/** The ids of the messages a spawn child's committed session events (`user/message`) show it took in. */
export const heardInEvents = (events) => (Array.isArray(events) ? events : [])
  .filter((e) => e?.type === 'user/message' && typeof e.data?.id === 'string' && e.data.id)
  .map((e) => e.data.id)

/** The id a patched Codex connector's tap says a turn took in (a finished `userMessage` item's `clientId`), or null. */
export function heardInTap(envelope) {
  if (envelope?.provider !== 'codex' || envelope.method !== 'item/completed') return null
  const item = envelope.params?.item
  return item?.type === 'userMessage' && typeof item.clientId === 'string' && item.clientId ? item.clientId : null
}

// ---- the outcome machine ---------------------------------------------------------------------------

/** The states of a piece of guidance sent to a task at work. */
export const GUIDANCE_STATES = Object.freeze(['pending', 'delivered', 'carried', 'returned', 'unknown'])

/**
 * What becomes of a piece of guidance in `state` on `event`: 'read' (the agent it was sent to took it
 * in), 'carried' (a prompt built after it carries it to the next attempt), 'unsure' (its provider let
 * it go without saying), 'ended' (the work ended first). Read, carried and returned are final; one
 * whose reading was unsure may still be read.
 */
export function nextState(state, event) {
  if (state === 'pending') return { read: 'delivered', carried: 'carried', unsure: 'unknown', ended: 'returned' }[event] ?? state
  if (state === 'unknown' && event === 'read') return 'delivered'
  return state
}

/** Whether a piece of guidance can have reached the work: read, carried, or sent with no word back. */
export const reachedWork = (s) => s?.how !== 'amend' && ['delivered', 'carried', 'unknown'].includes(s?.state)

/**
 * The pieces Send now gave attempt `attempt` of run `runId` that its agent never took in, as that
 * attempt ends (a Codex turn that ended before its interrupt landed, say): they were not used, and
 * no later attempt is given them, since they were to replace a step of this one. A piece the agent
 * refused (`refused`) was never handed over, and waits for the next attempt as a refused steer does.
 */
export const nowLeft = (steers, { runId, attempt }) => (Array.isArray(steers) ? steers : [])
  .filter((s) => s?.how === 'now' && s.state === 'pending' && !s.refused && s.runId === runId && s.attempt === attempt)

// ---- words -----------------------------------------------------------------------------------------

const ROLE_WORDS = Object.freeze({ primary: 'work', retry: 'retry', plan: 'plan', review: 'review', opinion: 'second opinion' })
/** Where carried guidance went: `Codex, review`. */
const carriedTo = (to) => [to?.name ?? to?.agent, ROLE_WORDS[to?.role] ?? to?.role].filter(Boolean).join(', ')

/**
 * What has become of a piece of guidance, as the Live tab, the Tasks row and the card under a start
 * reply say it: `Read by Codex at 14:02`. `name` is the agent it was sent to, and `to` where a prompt
 * built later carried it.
 */
export function steerStateWords(s) {
  const who = s?.name ?? 'the agent'
  switch (s?.state) {
    case 'pending': return 'Waiting for its next step'
    case 'delivered': return `Read by ${who}${Number.isFinite(s.readAt) ? ` at ${hhmm(s.readAt)}` : ''}`
    case 'carried': return `Goes to the next attempt (${carriedTo(s.to) || 'the next agent'})`
    case 'returned': return `Not used: ${s.name ?? 'the work'} finished first`
    case 'unknown': return `Sent; ${who} did not say whether it read it`
    case 'added': return 'Added to the task before it started'
    default: return ''
  }
}

/**
 * The line of a result's head for one piece of guidance: `Your guidance "<60 chars>": read by Codex.`
 * One still pending once its task has ended was not used either.
 */
export function guidanceLine(s) {
  const said = `Your guidance "${clip(oneLine(s?.text), 60)}"`
  switch (s?.state) {
    case 'delivered': return `${said}: read by ${s.name ?? 'the agent'}.`
    case 'carried': return `${said}: went to the next attempt (${carriedTo(s.to) || 'the next agent'}).`
    case 'unknown': return `${said}: sent; ${s.name ?? 'the agent'} did not say whether it read it.`
    case 'added': return `${said}: added to the task before it started.`
    default: return `${said}: not used (arrived after the work finished).`
  }
}

/** The result head's lines for a task's guidance, one per piece, in the order it was given. */
export const guidanceLines = (steers) => (Array.isArray(steers) ? steers : []).filter((s) => typeof s?.text === 'string' && s.text).map(guidanceLine)

/** The run log's line for a steer event (adapter.js line): `Your guidance "use tabs": read by Codex at 14:02`. */
export const steerLine = (e) => `Your guidance "${clip(oneLine(e?.guidance), 60)}": ${lower(steerStateWords({ ...e, text: e?.guidance })) || e?.state || 'sent'}`

/**
 * What the agent at work does with the words, said in the Steer dialog: `Codex takes this in at its
 * next step.` Claude Code, by `path` 'claude', folds them in between tool calls or not at all.
 */
export const liveWords = (name, path = null) => (path === 'claude'
  ? `${upper(name ?? 'Claude Code')} takes this in between tool calls; if it finishes first you'll be told it wasn't used.`
  : `${upper(name ?? 'the agent')} takes this in at its next step.`)

/** What Send now does to the agent at work, said by its button in the Steer dialog. */
export const nowWords = (name) => `Send now stops ${name ?? 'the agent'}'s current step and gives it your words at once.`

/**
 * Why Send now cannot stop the agent at work for the person's words, by `why` (nowPath, or idleWhy
 * while none is at work), said in the Steer dialog, whose Send now is off then; its other choices
 * still send them. `name` is the agent at work, if one is.
 */
export function nowHeldWords({ jobId, why, name = null }) {
  switch (why) {
    case 'checks': return `Send now has nothing to stop while ${jobId} runs its checks.`
    case 'review': return `Send now has nothing to stop while ${jobId}'s work is being reviewed.`
    case 'ending': return `Send now has nothing to stop: ${jobId} is finishing.`
    case 'claude-off': return `Send now can't stop ${name ?? 'Claude Code'} mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code").`
    case 'claude': return `Send now can't stop ${name ?? 'Claude Code'} mid-run: it started before "Let Steer reach a running Claude Code" was on.`
    case 'unpatched': return `Send now can't stop ${name ?? 'Codex'} mid-run while its live detail is off (Settings, Jev setup, Live agent view).`
    case 'tool':
    case 'none': return `Send now can't stop ${name ?? 'the agent at work'} mid-run.`
    default: return `Send now has nothing to stop: ${jobId} has no agent at work right now.`
  }
}

/**
 * Why the words wait for the task's next attempt rather than reach an agent now, by `why` (livePath,
 * idleWhy, or 'refused' by the agent at work), for the Steer dialog and as the answer to a steer.
 * `name` is the agent at work, if one is.
 */
export function heldWords({ jobId, why, name = null }) {
  const next = 'so this goes with its next attempt, if there is one.'
  const later = 'It goes to the next attempt if there is one.'
  const who = upper(name ?? 'the agent at work')
  switch (why) {
    case 'checks': return `${jobId} is running its checks right now, ${next}`
    case 'review': return `${jobId}'s work is being reviewed right now, ${next}`
    case 'ending': return `${jobId} is finishing, so this may come too late; its result says whether it was used.`
    case 'claude-off': return `${upper(name ?? 'Claude Code')} can't take messages mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code"). ${later}`
    case 'claude': return `${upper(name ?? 'Claude Code')} started before "Let Steer reach a running Claude Code" was on, so it can't take messages mid-run. ${later}`
    case 'unpatched': return `${upper(name ?? 'Codex')} can't take messages mid-run while its live detail is off (Settings, Jev setup, Live agent view). ${later}`
    case 'refused': return `${who} could not take it at this step. ${later}`
    case 'tool':
    case 'none': return `${who} can't take messages mid-run. ${later}`
    default: return `${jobId} has no agent at work right now, ${next}`
  }
}

/** Whether the Steer dialog can send words to a task at work now: an agent takes them, or none is at work and they wait for the next attempt. */
export const sendableWhy = (path, why) => !!path || IDLE_WHYS.includes(why)
