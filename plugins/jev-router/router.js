// Routing loop: context -> decision (Jev, or a local classifier once its domain has matured)
// -> the strategy's steps (an optional plan step, the work, a forced review) -> deterministic
// checks -> assessment -> accept / second review / retry / human, bounded by limits.
// Dependencies are injected so the loop runs the same in DSH and in tests. `deps.decide` is the
// decision engine (decision.js); without it the loop asks `deps.jev.route` directly, the way it
// always has, so a bare Jev client still routes.
//
// Whoever decides the run (`deps.decider`, the old `deps.jev`) answers its routing and review
// questions, and every cut-off here is read from that provider's record (`deps.provider`,
// providers.js): Jev in Jev Auto, Laya on this PC in Laya Auto (docs/laya-auto.md 3.2).
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createReview } from '../jev-review/index.js'
import { kindOf, marginalCostOf } from './accounts.js'
import { decidedBy, deviceName, timeoutSize } from './adapter.js'
import { CHARS_PER_TOKEN, eligible, rank } from './capabilities.js'
import { NO_CANDIDATES, contextEstimate } from './decision.js'
import { effortFamily, toAgentEffort } from './effort.js'
import { redactSecrets } from './export.js'
import { tagIsAnswerOnly } from './feedback.js'
import { offlinePick } from './local.js'
import { TEACHER, jevRecord, providerName } from './providers.js'
import { assertWorkspace, changedSince, compareChecks, ensureHandoffIgnored, gatherContext, runChecks, snapshot } from './workspace.js'

const pct = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a')
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5)
/** Earliest known reset among `{ until }` entries, or null. */
const earliest = (list) => list.map((x) => x.until).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
export const HANDOFF = '.kz-harness/handoff.md'
const OUT_STATES = ['stopped', 'exhausted']
const PEERS = { claude: 'codex', codex: 'claude' }
// Roles where a gated subscription is still the right spend: judging costs few tokens and
// benefits most from the strongest agent. Everything else is bulk work.
const JUDGMENT_ROLES = ['review']

function describeError(err) {
  // Class name + message only; SDK errors never include the API key. An executor's error can
  // quote what it was sent, and this becomes an attempt's diagnostic, which the review sends to
  // Jev, so it is scrubbed before it is cut: a key the cut split would go out as a plain word.
  return redactSecrets(`${err?.constructor?.name ?? 'Error'}: ${err?.message ?? String(err)}`).slice(0, 300)
}

/**
 * One agent's time limit in an attempt (config.agentTimeoutMs). `signal` fires when the run is
 * stopped or the agent has had `ms` of its own time, with the reason AbortSignal.timeout gives.
 * `untimed(promise)` is a wait that is not the agent's work: the clock stands still until the
 * promise settles, and `waitedMs` adds up how long it stood. It is how a local agent held back
 * before it starts, while a speed benchmark goes (docs/benchmark.md 2.6), is neither run out of time
 * by that wait nor charged for it; a stop of the run still ends the wait at once. `end()` clears the
 * timer once the attempt is over.
 */
export function attemptClock(signal, ms) {
  const limit = new AbortController()
  let left = ms
  let since = Date.now()
  let timer = null
  let waits = 0
  let waitedMs = 0
  const arm = () => {
    timer = setTimeout(() => limit.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), left)
    // As AbortSignal.timeout's own timer: a limit never keeps the process alive.
    timer.unref?.()
  }
  arm()
  return {
    signal: AbortSignal.any([signal, limit.signal]),
    get waitedMs() { return waitedMs },
    async untimed(promise) {
      if (waits++ === 0) {
        clearTimeout(timer)
        left = Math.max(0, left - (Date.now() - since))
        since = Date.now()
      }
      try { return await promise } finally {
        if (--waits === 0) {
          waitedMs += Date.now() - since
          since = Date.now()
          if (!limit.signal.aborted) arm()
        }
      }
    },
    end() { clearTimeout(timer) },
  }
}

// The model an executor says it actually served, when it says so. `model` on an attempt is what
// the config asked for; a provider may serve another version, and profiles key on the one that ran.
// Nothing is invented: an executor that reports neither leaves the attempt without the field.
const servedModel = (result) => {
  const v = result?.modelVersion ?? result?.model
  return typeof v === 'string' && v ? { modelVersion: v } : {}
}

const diagText = (d) => (d == null ? '' : typeof d === 'string' ? d : JSON.stringify(d))
const LIMIT_TEXT = /usage limit|rate[ _]limit|insufficient balance|quota/i
/** Fallback limit matcher when deps.isLimitError is absent. A completed run never counts: its answer may just talk about rate limits. */
export function builtinLimit(result) {
  if (result.category === 'limit' || result.diagnostic?.category === 'limit') return { hit: true }
  if (result.stopReason === 'completed') return { hit: false }
  return { hit: LIMIT_TEXT.test(`${result.stopReason} ${diagText(result.diagnostic)} ${result.answerText ?? ''}`) }
}

/** Highest-probability enabled agent other than `avoid`, falling back to registry order. */
export function pickOther(probabilities, avoid, agents) {
  const ranked = agents.map((a) => a.id).sort((x, y) => (probabilities?.[y] ?? 0) - (probabilities?.[x] ?? 0))
  return ranked.find((id) => id !== avoid) ?? ranked[0]
}

/**
 * The strongest candidate other than `producer`, from the decision's own candidate table (tier,
 * then fit). Null without a decision: the caller then falls back to Jev's review pick.
 */
const TIER_RANK = { weak: 0, unknown: 1, standard: 2, strong: 3, frontier: 4 }
function strongestOther(routing, producer, byId) {
  const list = (routing.decision?.candidates ?? []).filter((c) => c.id !== producer && byId.has(c.id))
  return list.sort((a, b) => (TIER_RANK[b.tier] ?? 1) - (TIER_RANK[a.tier] ?? 1) || (b.fit ?? 0) - (a.fit ?? 0))[0]?.id ?? null
}

// How many work attempts in a row may change nothing before the run stops. An agent that
// edits no files twice running is stuck, not slow, and a third try spends the same money for
// the same nothing.
const STALL_AFTER = 2

// Attempts needed before an accepted rate is reported at all. Below this the number is noise,
// and the routing prompt weighs accepted rate first, so noise wins picks.
const MIN_RATE_SAMPLES = 3

// Feedback priors: how many recent Like/Dislike verdicts the routing prior weighs (by weight, so
// a verdict on other work takes only its share of a place), and the most a run of them may move
// an agent's probability. A verdict is explicit, so it counts more than one quiet run, but a
// click is still one data point: the bias is ramped over three verdicts and capped, so one
// cannot swing a pick and ten cannot make an agent unoverridable.
const FEEDBACK_WINDOW = 20
const FEEDBACK_WEIGHT = 0.15
const FEEDBACK_RAMP = 3
// A verdict about another kind of work still says something about an agent, but far less than one
// about the kind of work being routed now, so it counts this share of a matching one. It is the
// share the capability evidence gives an unrelated task type by default (routing-policy.js
// evidence.similarity.other), copied rather than read: this does not tell a related type (which
// that evidence counts at a half) from an unrelated one, and an install that overrides the
// evidence similarity does not move it.
const FEEDBACK_OTHER_TYPE = 0.25

const TIER = { local: 'free-local', api: 'api', subscription: 'subscription' }
// The same tiers by what a job costs at the margin, for an operator's `resources.economics` override.
const TIER_OF_MARGINAL = { none: 'free-local', low: 'subscription', metered: 'api' }
// The billing tier shown in the track record Jev reads. Which tier an agent is in is an account
// fact, so it is asked of accounts.js rather than re-derived here from a provider name, unless the
// operator declared how a job on the agent is funded: that override reaches every cost reader, this
// one included. A free agent that is not local reads `free`, so the tier never says local wrongly.
const tierOf = (a, economics) => {
  const declared = TIER_OF_MARGINAL[economics?.[a.id]?.marginalCost]
  if (!declared) return TIER[a.kind] ?? TIER[kindOf(a)] ?? 'api'
  return declared === 'free-local' && kindOf(a) !== 'local' && a.kind !== 'local' ? 'free' : declared
}
const r2 = (x) => Math.round(x * 100) / 100

// The decision engine's refusal when every candidate was filtered out by a hard fact (disabled,
// not allowed, signed out, out of quota, or no context window big enough). It is the one routing
// failure that must not fall back: there is nothing left to fall back TO, and the fallback pick
// would be one of the resources just excluded. Matched on the code decision.js sets, never on the
// message, so rewording a message cannot silently turn this stop back into a fallback.
const noCandidatesLeft = (err) => err?.code === NO_CANDIDATES

// How close two independently produced answers are: a Dice coefficient over their content words.
// Deterministic and deliberately coarse - it measures wording, not meaning - so it is reported
// with its number and never used to pick a winner or discard an answer.
const AGREE_AT = 0.6
// Words in any script: an ASCII-only split turned Cyrillic, accented or CJK answers into an empty
// set and reported two real answers as "nothing came back". Short words are mostly glue and are
// dropped, but a short NUMBER is often the whole answer ('42' vs '42'), so numbers are kept.
const allWords = (s) => new Set(String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
const contentWords = (s) => new Set([...allWords(s)].filter((w) => w.length > 2 || /^\p{N}+$/u.test(w)))
/**
 * `empty` says why an uncompared pair was not compared: one side sent nothing back (true), or
 * both answered but neither had a word the other could be measured against (false).
 * @returns {{compared: boolean, similarity: number|null, agree: boolean|null, empty?: boolean}}
 */
export function compareAnswers(a, b) {
  const blank = (s) => !String(s ?? '').trim()
  if (blank(a) || blank(b)) return { compared: false, similarity: null, agree: null, empty: true }
  let x = contentWords(a)
  let y = contentWords(b)
  // A one-word answer ('ok', 'no', 'Да') has no content word, and two identical one-word answers
  // are the clearest agreement there is. So a short answer is measured on every word it has.
  if (!x.size || !y.size) { x = allWords(a); y = allWords(b) }
  if (!x.size || !y.size) return { compared: false, similarity: null, agree: null, empty: false }
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  const similarity = r2((2 * shared) / (x.size + y.size))
  return { compared: true, similarity, agree: similarity >= AGREE_AT }
}

/**
 * Is `at` inside the UTC window [from, to)? Both are "HH:MM"; a window whose end
 * is at or before its start wraps past midnight (DeepSeek's discount does).
 * @param {number|Date} at
 */
export function inUtcWindow(at, from, to) {
  const mins = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`time must be HH:MM in UTC, got "${hhmm}"`)
    return +m[1] * 60 + +m[2]
  }
  const d = at instanceof Date ? at : new Date(at)
  const now = d.getUTCHours() * 60 + d.getUTCMinutes()
  const a = mins(from)
  const b = mins(to)
  return a < b ? now >= a && now < b : now >= a || now < b
}

const WEEKDAYS_UTC = [1, 2, 3, 4, 5]

/**
 * What each provider is charging right now. Written as PEAK windows rather than off-peak ones
 * because that is the shape the billing actually has: DeepSeek charges its higher rate only
 * during weekday business hours, so peak is the exception and everything else, all evening and
 * all weekend, is already the cheap rate. Windows are UTC, and the day list is the UTC day.
 * @param {Record<string, {windowsUtc?: {fromUtc: string, toUtc: string}[], daysUtc?: number[], note?: string}>} peak
 */
export function pricingNow(peak = {}, at = Date.now()) {
  const out = {}
  const day = new Date(at).getUTCDay()
  for (const [id, p] of Object.entries(peak)) {
    try {
      const windows = p.windowsUtc ?? []
      if (!windows.length) continue
      // Validate every window, not just up to the first match: a typo must not read as
      // "not peak", which would quietly claim the cheap rate while the dear one is running.
      for (const w of windows) inUtcWindow(at, w.fromUtc, w.toUtc)
      const now = (p.daysUtc ?? WEEKDAYS_UTC).includes(day)
        ? windows.find((w) => inUtcWindow(at, w.fromUtc, w.toUtc))
        : undefined
      const note = p.note ? ` (${p.note})` : ''
      out[id] = now
        ? `peak rate until ${now.toUtc} UTC: twice its off-peak price${note}`
        : `off-peak rate right now: the cheapest it gets${note}`
    } catch { /* a window we cannot read tells Jev nothing */ }
  }
  return out
}

/**
 * Each agent's record from history.jsonl, for Jev's pick: work attempts (primary and retry),
 * accepted rate (its attempt was the last work in an accepted run), average seconds and limit hits,
 * by task type in this workspace and overall, over the last `n` runs of each; plus cost tier (the
 * operator's `economics` override first, then the billing kind), what it costs at this hour
 * (`pricing`) and availability. Only a run Jev decided is counted under its task type: in a run
 * another provider decided (Laya) the type is that provider's label, which must never decide which
 * row of an agent's record the routing call reads (docs/laya-auto.md 6.6, as verdictWeight). Those
 * runs still count overall, where no label is read.
 */
export function trackRecord(records, cwd, agents, { availability = {}, pricing = {}, economics, n = 50 } = {}) {
  const here = records.filter((r) => r.workspace === cwd).slice(-n)
  const all = records.slice(-n)
  const stats = (rows, id) => {
    let attempts = 0; let accepted = 0; let ms = 0; let limits = 0
    for (const r of rows) {
      const work = (r.attempts ?? []).filter((a) => a.role === 'primary' || a.role === 'retry')
      for (const a of work) {
        if (a.agent !== id) continue
        // A quota stop is not incompetence. Counting it as a failed attempt tells Jev the
        // agent cannot do the work, when it was only out of allowance, and the effect is
        // permanent: the run is in the denominator for the next 50 runs.
        if (a.limitHit) { limits++; continue }
        attempts++
        ms += a.durationMs ?? 0
        if (a === work.at(-1) && String(r.finalStatus).startsWith('accepted')) accepted++
      }
    }
    if (!attempts) return null
    // A rate over one or two attempts is noise, and Jev is told to prefer the best rate, so
    // a single lucky run reads as "always works" and wins every future pick. Withhold the
    // number until there is enough to mean anything; the count still goes out, so Jev can
    // see the agent has been tried.
    const enough = attempts >= MIN_RATE_SAMPLES
    return {
      attempts,
      ...(enough ? { accepted_rate: r2(accepted / attempts) } : { accepted_rate: null, note: 'too few attempts to judge' }),
      avg_seconds: Math.round(ms / attempts / 1000),
      limit_hits: limits,
    }
  }
  const typed = here.filter((r) => (r.routing?.decider ?? TEACHER) === TEACHER)
  return Object.fromEntries(agents.map((a) => {
    const byType = {}
    for (const t of new Set(typed.map((r) => r.routing?.taskType).filter(Boolean))) {
      const s = stats(typed.filter((r) => r.routing?.taskType === t), a.id)
      if (s) byType[t] = s
    }
    return [a.id, { cost_tier: tierOf(a, economics), ...(pricing[a.id] ? { price_now: pricing[a.id] } : {}), availability: availability[a.id] ?? 'ok', here_by_task_type: byType, overall: stats(all, a.id) ?? 'no runs yet' }]
  }))
}

/**
 * How much one verdict counts toward the feedback bias of the task being routed now, by how well
 * the work it judged matches this task. The work it judged is the run it is about (`runOf`, which
 * index.js answers with runOfVerdict: the runId the client sends, else the same fallback the
 * capability evidence is credited by), and that run's routing.taskType says what kind of work it
 * was. A verdict about the same kind of work counts fully, from any session; one about another
 * kind counts FEEDBACK_OTHER_TYPE of that, from this session too. A verdict whose kind of work
 * cannot be told - no run found, a run that never had a task type (a manual pick), or no task
 * type for the task at hand - counts exactly as every verdict did before there was a match: fully
 * when it is from this session and not at all when it is from another, since nothing then says
 * it was about similar work. A run another provider decided (Laya) is such a run too: its task
 * type is that provider's label, and Laya's label must never set how much a person's verdict
 * counts in Jev Auto (docs/laya-auto.md 6.6).
 * @param {object} p
 * @param {string} [p.taskType]  what routing said the task at hand is
 * @param {string} [p.sessionId] this run's session; without one every row reads as this session's,
 *   as feedback.js list() returns every session when it is asked for none
 * @param {(verdict: object) => object|null} [p.runOf] the run a verdict is about
 * @returns {(verdict: object) => number} the verdict's weight, 0..1
 */
export function verdictWeight({ taskType, sessionId, runOf } = {}) {
  const judged = (v) => {
    // A reader that fails has found no run, which is a verdict it cannot place and nothing worse.
    try {
      const run = runOf?.(v)
      return (run?.routing?.decider ?? TEACHER) === TEACHER ? run?.routing?.taskType : undefined
    } catch { return undefined }
  }
  return (v) => {
    const type = taskType ? judged(v) : undefined
    if (type) return type === taskType ? 1 : FEEDBACK_OTHER_TYPE
    return !sessionId || v?.sessionId === sessionId ? 1 : 0
  }
}

/**
 * The routing prior from recent feedback.jsonl rows: per agent, the Like/Dislike counts, the
 * reasons the person gave, and a bounded bias for Jev's probabilities. It extends the same
 * deps.history path trackRecord uses, one file over, so there is one priors mechanism, not two.
 *
 * `weightOf` says how much each row counts (verdictWeight); without it every row counts fully.
 * The window is `n` verdicts' worth of weight, newest first: at full weight that is the newest
 * `n` rows, as it always was, and a verdict on other work takes only its share of a place, so a
 * run of them cannot push out the verdicts that bear on this task. A row that weighs nothing is
 * left out before the window is counted, so it can neither crowd out one that bears on this task
 * nor be the newest verdict. The counts stay whole verdicts; the bias is taken over the weights,
 * and since the weighted likes less the weighted dislikes can never exceed their sum, it stays
 * inside FEEDBACK_WEIGHT however many rows there are and whatever they weigh, the same bound a
 * whole vote has always had.
 *
 * Which agent a verdict is about comes from `provider` (and `model`): the engine's message id
 * is never known on this side, so `messageId` is only the client's key and this file's upsert
 * key. A row that resolves to no enabled agent is dropped rather than guessed at. The newest
 * verdict, when it names a `suggestedAgent`, is returned separately: an explicit correction,
 * not a vote, and it is cleared by any later verdict.
 *
 * The tag splits the signal in two. A routing tag (wrong agent, misread my question, wrong
 * scope, good pick) is a statement about the pick, and counts as a vote like an untagged row
 * always has. An answer-only tag (not enough detail, too slow, good answer) is a statement
 * about the answer: its text and tag still ride `reasons` into the routing prompt as context,
 * but it never reaches `likes` / `dislikes`, so the bias it feeds is untouched, and it cannot
 * raise a `suggestion` either, because that would promote an agent through the answer door.
 */
export function feedbackPrior(records, agents, { n = FEEDBACK_WINDOW, modelOf, weightOf = () => 1 } = {}) {
  // Newest first until the window holds n verdicts' worth of weight, so a long log is only
  // weighed as far back as it counts. Filled by weight, not by rows: counted by rows, twenty
  // quarter-weight verdicts on other work from other sessions took every place and pushed out
  // this session's verdicts on this very work.
  const rows = records ?? []
  const recent = []
  const weight = new Map()
  let filled = 0
  for (let i = rows.length - 1; i >= 0 && filled < n; i--) {
    const w = weightOf(rows[i])
    if (!(w > 0)) continue
    recent.unshift(rows[i])
    weight.set(rows[i], w)
    filled += w
  }
  const modelOfAgent = (a) => a.llm?.model ?? modelOf?.(a) ?? ''
  const agentOf = (r) => {
    if (!r?.provider) return undefined
    // An agent id first (the client sends the chain chip's agent), then a real provider id,
    // optionally narrowed by the model the chip shows.
    const byId = agents.find((a) => a.id === r.provider)
    if (byId) return byId.id
    return agents.find((a) => (a.llm?.provider ?? a.provider) === r.provider && (!r.model || modelOfAgent(a) === r.model))?.id
  }
  const tally = new Map()
  const bump = (id, fn) => {
    if (!id || !agents.some((a) => a.id === id)) return
    const t = tally.get(id) ?? { likes: 0, dislikes: 0, suggested: 0, reasons: [], up: 0, down: 0 }
    fn(t)
    tally.set(id, t)
  }
  // The person's words with the chosen tag in front of them: this is what rides the agent's
  // track record into the routing prompt. An answer-only row gets no further than this.
  const note = (r) => {
    const tag = typeof r.tag === 'string' ? r.tag.trim() : ''
    if (!tag) return r.reason ?? ''
    return r.reason ? `${tag}: ${r.reason}` : tag
  }
  for (const r of recent) {
    if (r?.verdict !== 'like' && r?.verdict !== 'dislike') continue
    // The split, in one line: only a routing-affecting row is allowed to vote.
    const counts = !tagIsAnswerOnly(r.tag)
    bump(agentOf(r), (t) => {
      if (counts) {
        if (r.verdict === 'dislike') { t.dislikes++; t.down += weight.get(r) }
        else { t.likes++; t.up += weight.get(r) }
      }
      const text = note(r)
      if (text) t.reasons.push(text)
    })
    // A suggestion is a promotion, so an answer-only tag may not make one.
    if (counts) bump(r.suggestedAgent, (t) => { t.suggested++ })
  }
  const out = new Map()
  for (const [id, t] of tally) {
    const votes = t.likes + t.dislikes
    out.set(id, {
      likes: t.likes,
      dislikes: t.dislikes,
      suggested: t.suggested,
      reasons: t.reasons.slice(-3),
      bias: votes ? r2(FEEDBACK_WEIGHT * (t.up - t.down) / Math.max(FEEDBACK_RAMP, t.up + t.down)) : 0,
    })
  }
  const latest = recent.at(-1)
  const suggestible = latest?.verdict === 'dislike' && latest.suggestedAgent && !tagIsAnswerOnly(latest.tag)
  return { agents: out, suggestion: suggestible ? latest.suggestedAgent : undefined }
}

/**
 * The skill line for the worker, from the plan's `skill` (decision.js). Empty when the plan has
 * none - the router's own fallback plan never does - so nothing is invented for it.
 */
function skillLine(skill) {
  if (!skill?.primary) return ''
  const supporting = (skill.supporting ?? []).filter(Boolean)
  return `Approach this mainly as ${skill.primary} work${skill.description ? ` (${skill.description})` : ''}.${supporting.length ? ` It also draws on ${supporting.join(', ')}.` : ''}`
}

/**
 * The handoff note of a run in `cwd`, named by its full path in every prompt: an agent's working
 * directory need not be its workspace (a capability benchmark's agent works in the scratch root and
 * its task folder is named only in the prompt, docs/benchmark.md 3.7), and a path from the
 * workspace would land wherever the agent resolves it.
 */
const handoffIn = (cwd) => join(cwd, HANDOFF)

function basePrompt(task, cwd, { near, handoff, plan, skill } = {}) {
  return [
    task,
    '',
    `Workspace: ${cwd}. Work only inside this workspace.`,
    skillLine(skill),
    'Do not commit, push, deploy, publish packages, or touch databases.',
    `Keep ${handoffIn(cwd)} updated as you work, with sections Done / Next / Open problems / How to verify, so another agent can take over.`,
    near ? 'You are close to your usage limit: work in small steps and update the handoff after each step.' : '',
    'When done, summarize what you changed (or found) and how you verified it.',
    plan ? `\nA stronger model planned this work first. Follow the plan unless the code proves it wrong, and say where you departed from it:\n${plan.slice(0, 6000)}` : '',
    handoff ? `\nEarlier unfinished work on this task (handoff note from ${handoffIn(cwd)}); continue from it:\n${handoff.slice(0, 8000)}` : '',
  ].filter((l, i) => l !== '' || i === 1).join('\n')
}

/** The plan step of a plan-then-execute strategy: think, write nothing. */
function planPrompt(task, cwd, { skill } = {}) {
  return [
    `Plan, but do not carry out, the following task in ${cwd}:`,
    task,
    '',
    // The planner sets the approach the worker follows, so it is told the skill the work needs too.
    skillLine(skill),
    'Read whatever you need. Then write a concrete plan another engineer can follow: the files to change and why, the order of steps, the risks and how to verify each step.',
    `Do not modify any files (do not write ${handoffIn(cwd)} either). Your answer is the plan.`,
  ].filter((l, i) => l !== '' || i === 2).join('\n')
}

function retryPrompt(task, cwd, attempts, checks, opts) {
  const last = attempts.at(-1)
  const failing = checks.filter((c) => !c.passed).map((c) => `### ${c.name} (exit ${c.exitCode})\n${c.output}`)
  return [
    basePrompt(task, cwd, opts),
    '',
    'Earlier attempts did not finish this task. Their current changes are still in the working tree.',
    ...attempts.map((a, i) => `Attempt ${i + 1} by ${a.agent} (${a.role}): ${a.stopReason}${a.limitHit ? ' (usage limit hit)' : ''}. ${a.diagnostic ?? ''}\n${(a.answerText ?? '').slice(0, 1500)}`),
    failing.length ? `\nFailing checks:\n${failing.join('\n')}` : '',
    last?.role === 'review' ? '\nAddress the review findings above that are real defects.' : '',
  ].join('\n')
}

function reviewPrompt(task, cwd, diff) {
  return [
    `Independently review the work another agent did for this task in ${cwd}.`,
    `Task: ${task}`,
    '',
    `Uncommitted changes (git diff HEAD):\n${diff.stat || '(no file changes; review the earlier answer and the code it refers to)'}`,
    '',
    `Do not modify any files (do not write ${handoffIn(cwd)} either). Report concrete defects or regressions with file and line, or state that the work is correct and complete.`,
  ].join('\n')
}

/**
 * Handoff note written by the harness from evidence when the limited agent left none. The next
 * run's routing call carries it to Jev, so each excerpt is scrubbed before it is cut: a key the
 * cut split would stay in the note as a piece too short for any scrubber to know it for a key.
 */
function harnessHandoff({ task, attempts, diff, checks, previous }) {
  const failing = checks.filter((c) => !c.passed)
  const lastAnswer = redactSecrets(attempts.findLast((a) => a.answerText)?.answerText ?? '')
  return [
    '# Handoff (written by Kz-harness from evidence; the agent hit its usage limit before updating this note)',
    '',
    `Task: ${task}`,
    '',
    '## Done (attempts)',
    ...attempts.map((a, i) => `${i + 1}. ${a.agent} (${a.role}): ${a.stopReason}${a.limitHit ? ', usage limit hit' : ''}`),
    '',
    '## Changed files',
    diff.files === null ? '(unknown, not git)' : diff.files.length ? diff.files.map((f) => `- ${f}`).join('\n') : '(none)',
    diff.stat ? `\n${diff.stat}` : '',
    '',
    '## Open problems',
    failing.length ? failing.map((c) => `- check ${c.name} fails (exit ${c.exitCode})`).join('\n') : '- none known from checks',
    '',
    '## Next',
    'Continue the task from the current working tree; the last agent answer is below.',
    lastAnswer ? `\n${lastAnswer.slice(0, 2000)}` : '',
    '',
    '## How to verify',
    checks.length ? `Run the project checks: ${checks.map((c) => c.name).join(', ')}.` : 'No project checks configured; verify the task by hand.',
    previous ? `\n## Earlier note\n${redactSecrets(previous).slice(0, 2000)}` : '',
  ].join('\n')
}

/**
 * @param {object} p
 * @param {string} p.task
 * @param {string} p.cwd
 * @param {string} [p.forceAgent]  manual override; skips Jev routing only
 * @param {object} p.config        plugin config (agents, tools, limits, thresholds, checks)
 * @param {object} p.deps          { offline?: true when the internet is unreachable (local agents only, no Jev), localOnly?: true to use local agents only while Jev still routes, checkBalance?(agentId) -> {state, balance, until} re-read after each attempt, ready?: {[agentId]: {loggedIn, detail}}, quota?: {[agentId]: {state, until}}, isLimitError?, onLimit?, logAttempt?, jev | null, jevUnavailableReason, execute(agentDef, prompt, signal, { effort, speed, untimed }) where untimed(promise) is a wait before the work that the agent's time limit does not count (attemptClock), runTool?(tool, args, task, signal), review?, emit?, history }
 *   and, for whoever decides: decider?: the createJev() client that answers, or null for none (`jev`
 *   is its old name, read only when `decider` is not given),
 *   provider?: that client's record (providers.js; a Jev record from config.thresholds without one);
 *   a client whose own record is another provider's is refused before anything runs,
 *   runId?: the run's id, minted by the caller so every file of the run shares it,
 *   deciderDevice?(): where a provider on this PC ran its calls ('cuda' | 'cpu'), for the report
 * @param {AbortSignal} p.signal
 */
/** The routing record's field for each kind of move the router makes on its own. */
const MOVE_FIELD = Object.freeze({ capability: 'capabilityFrom', tiebreak: 'tiebrokeFrom', gate: 'gatedFrom', feedback: 'feedbackFrom' })

/**
 * The routing fields for one move of the work from `from` to `to`: the new primary, the move's
 * own `<kind>From` field (kept for the readers that look for it), and `moves`, every move in the
 * order it was made. The `<kind>From` fields alone could not say where an intermediate move went:
 * after a capability swap and then a gate swap, both read as moves to the final primary.
 */
function movedTo(kind, from, to, moves = []) {
  return { primaryAgent: to, [MOVE_FIELD[kind]]: from, moves: [...moves, { kind, from, to }] }
}

export async function runRouted({ task, cwd, sessionId, forceAgent, answerOnly = false, effort, config, deps, signal = new AbortController().signal }) {
  // Menu choice wins over the Settings default; 'auto' in the menu defers to that default.
  const level = effort && effort !== 'auto' ? effort : config.effort?.default ?? 'auto'
  const emit = (type, data = {}) => deps.emit?.({ type, at: Date.now(), ...data })
  await assertWorkspace(cwd)
  // One id for the whole run, the caller's when it minted one, so its usage rows, its live log,
  // its samples, its history row and the Laya shadow's rows can all be joined.
  const runId = deps.runId ?? randomUUID()
  const runStartedAt = Date.now()
  // Who decides, and the bars its answers are read against. A caller that names no provider gets
  // Jev with the configured thresholds, every key a caller leaves out filled from Jev's defaults.
  const P = deps.provider ?? jevRecord({ thresholds: config.thresholds })
  const T = P.thresholds
  // A Laya-decided run keeps, on its routing record, every call of Laya's that did not answer and
  // how long the routing calls that did took, so the report can say what the rules decided and
  // why. Watched here rather than wherever the client is made, because only the run knows which
  // of its decisions a failed call left to the rules. Jev's client is handed on as it is.
  const deciderErrors = []
  let deciderMs = 0
  // The Laya client's timeout names only its deadline in the message and carries the call's size
  // and device beside it (docs/laya-auto.md 3.5, 4.5); the report says all three, as 3.3 writes it.
  const reasonOf = (err) => redactSecrets(`${String(err?.message ?? err)}${timeoutSize(err)}`).slice(0, 300)
  const watch = (d) => ({
    ...d,
    route: async (...args) => {
      const t0 = Date.now()
      try { const r = await d.route(...args); deciderMs += Date.now() - t0; return r } catch (err) {
        if (!signal.aborted) deciderErrors.push({ phase: 'route', reason: reasonOf(err) })
        throw err
      }
    },
    assess: async (...args) => {
      try { return await d.assess(...args) } catch (err) {
        if (!signal.aborted) deciderErrors.push({ phase: 'review', reason: reasonOf(err) })
        throw err
      }
    },
  })
  // `jev` is the old name of `decider`, read only when `decider` is not given at all: a caller that
  // says there is none (null) means none, never a client it also passed under the old name.
  const given = deps.decider !== undefined ? deps.decider : deps.jev ?? null
  // A client is never run under another provider's record, as decision.js refuses too: a Jev client
  // beside Laya's record would route and review a run its record says Laya decided.
  if (given?.provider && given.provider.id !== P.id) throw new Error(`router: ${given.provider.name ?? given.provider.id}'s client was handed ${P.name}'s record; a run is decided only under the record of the provider that answers it`)
  const decider = given && !P.teacher ? watch(given) : given
  const quota = deps.quota ?? {}
  // Admin-set hard facts, from the routing policy block (config.routing - not config.policy,
  // which is the cost block). A resource the operator disabled, or left out of an allow-list, is
  // not a candidate for anything. These used to be applied inside decision.js only, so every
  // router-side reassignment - the tie-break, the gate swap, the fallback pick, a retry - could
  // still hand the work to an excluded resource. Filtering the pool here means nothing later can
  // resurrect one, because it never enters `agents` in the first place.
  const disabledResources = new Set(config.routing?.disabledResources ?? [])
  const allowedResources = config.routing?.allowedResources?.length ? new Set(config.routing.allowedResources) : null
  const policyAllows = (id) => !disabledResources.has(id) && (!allowedResources || allowedResources.has(id))
  const whyExcluded = (id) => (disabledResources.has(id) ? 'disabled by configuration' : 'not in the allowed resources')
  const switchedOn = config.agents.filter((a) => a.enabled)
  const policyExcluded = switchedOn.filter((a) => !policyAllows(a.id))
  const permitted = switchedOn.filter((a) => policyAllows(a.id))
  // Only agents that are switched on, signed in (deps.ready from setup.js checks) and not at their limit can be picked.
  const notReady = permitted.filter((a) => deps.ready?.[a.id] && !deps.ready[a.id].loggedIn)
  const outAtStart = permitted.filter((a) => !notReady.includes(a) && OUT_STATES.includes(quota[a.id]?.state))
  // Offline: only agents that run on this PC are eligible.
  // Offline implies local-only; `localOnly` is the same restriction chosen on purpose,
  // with Jev still routing (it is a hosted call, so it needs the network either way).
  const localOnly = !!deps.offline || !!deps.localOnly
  // The mirror image: only agents that are NOT on this PC. Offline and local-only win over it,
  // because they are statements about what the machine CAN do, while `remoteOnly` is only a
  // preference about what it SHOULD do. Asking for remote agents with no network is a
  // contradiction, and the honest answer is the offline restriction, not an empty pool.
  const remoteOnly = !localOnly && !!deps.remoteOnly
  const agents = permitted.filter((a) => !notReady.includes(a) && !outAtStart.includes(a)
    && (!localOnly || a.kind === 'local') && (!remoteOnly || a.kind !== 'local'))
  const out = outAtStart.map((a) => ({ id: a.id, until: quota[a.id].until ?? null })) // grows as agents hit limits
  const outLabel = () => { const e = earliest(out); return e ? ` (earliest reset ${hhmm(e)})` : '' }
  // The policy exclusion is reported first: when it emptied the pool, "nobody is signed in" would
  // send the person to the login screen for a resource the configuration is refusing. Only when the
  // policy ALONE emptied it, though: with one resource disabled and the other merely out of quota,
  // "every agent is excluded" is false and hides the reset time the person is waiting for.
  if (agents.length === 0 && policyExcluded.length && permitted.length === 0) throw new Error(`every agent is excluded by the routing policy: ${policyExcluded.map((a) => `${a.id} (${whyExcluded(a.id)})`).join(', ')}`)
  if (agents.length === 0 && outAtStart.length) throw new Error(`all available agents are at their usage limits${outLabel()}: ${out.map((o) => `${o.id}${o.until ? ` until ${hhmm(o.until)}` : ''}`).join(', ')}`)
  // A locality restriction can empty the pool with the policy's help: saying only "no local model
  // is ready" sent the person to download a model they have, and have disabled.
  const excludedHere = (local) => policyExcluded.filter((a) => (a.kind === 'local') === local)
  const alsoExcluded = (local) => { const ex = excludedHere(local); return ex.length ? ` (${ex.map((a) => `${a.id} is ${whyExcluded(a.id)}`).join('; ')})` : '' }
  if (agents.length === 0 && localOnly) throw new Error(`${deps.offline ? 'offline, and no local model is ready' : 'this run is local only, and no local model is ready'}${alsoExcluded(true)}. ${excludedHere(true).length ? 'Allow it in the routing settings, or download' : 'Download'} one in Settings → Jev setup → Local models (needs the internet once)`)
  if (agents.length === 0 && remoteOnly) throw new Error(`this run is online only, and no cloud or subscription agent is ready${alsoExcluded(false)}. Sign one in at Settings → Jev setup, or pick Jev Auto to use the local models on this PC`)
  if (agents.length === 0) throw new Error(`no LLM agent is switched on and signed in${notReady.length ? ` (${notReady.map((a) => `${a.id}: ${deps.ready[a.id].detail}`).join('; ')})` : ''}. Open Settings → Plugins → Jev setup`)
  const byId = new Map(agents.map((a) => [a.id, a]))
  // A manual pick is a judgment too, and an admin exclusion outranks it: saying so is better than
  // silently routing the work somewhere else.
  if (policyExcluded.some((a) => a.id === forceAgent)) throw new Error(`${forceAgent} is excluded by the routing policy (${whyExcluded(forceAgent)})`)
  const blocked = notReady.find((a) => a.id === forceAgent)
  if (blocked) throw new Error(`${forceAgent} cannot run: ${deps.ready[forceAgent].detail}`)
  const limited = out.find((o) => o.id === forceAgent)
  if (limited) throw new Error(`${forceAgent} is at its usage limit${limited.until ? ` until ${hhmm(limited.until)}` : ''}`)
  if (forceAgent && localOnly && !byId.has(forceAgent) && config.agents.some((a) => a.id === forceAgent && a.kind !== 'local')) throw new Error(deps.offline ? `${forceAgent} needs the internet; offline, only local agents run (${[...byId.keys()].join(', ')})` : `${forceAgent} is not a local model; this run is local only (${[...byId.keys()].join(', ')})`)
  if (forceAgent && remoteOnly && !byId.has(forceAgent) && config.agents.some((a) => a.id === forceAgent && a.kind === 'local')) throw new Error(`${forceAgent} runs on this PC; this run is online only (${[...byId.keys()].join(', ')})`)
  if (forceAgent && !byId.has(forceAgent)) throw new Error(`agent "${forceAgent}" is not enabled; enabled: ${[...byId.keys()].join(', ')}`)
  // The outcome domain controller, when index.js wired one, lets the review mature locally.
  // modelOf: the review call masks the model a CLI agent really runs, as the routing call does, for
  // an agent that has not run yet too (one that ran is masked through the model its attempt recorded).
  // Whoever decides the run reviews it, against its own bars.
  const review = deps.review ?? createReview(decider, T, deps.jevUnavailableReason, { outcome: deps.outcomeDomain, modelOf: deps.modelOf })
  const near = (id) => quota[id]?.state === 'near'

  // --- subscription-first gate -------------------------------------------
  // A subscription is free per token but NOT free per percent: its weekly window is the
  // rationed resource. Past the gate, an agent stops doing the WORK (which is bulk tokens)
  // and is kept for judgment roles (review), where it is worth the remaining percent.
  //
  // Computed once, before Jev is asked, and never recomputed inside the loop: re-reading
  // per attempt costs a usage snapshot each time and could land a retry on a different
  // agent than the primary, which means two agents editing one working tree.
  //
  // Unknown weekly deliberately does NOT gate. quota is empty on a cold start and a failed
  // usage fetch reports 'ok' with no windows; treating unknown as "over" would push paid
  // API traffic on every cold start. Being wrong the other way only spends subscription
  // faster, and stopAtPercent plus the existing limit-error path are still the real ceiling.
  const gateAt = (id) => config.policy?.gateAtPercent?.[id] ?? config.policy?.gateAtPercent?.default ?? 80
  const gated = (id) => {
    const q = quota[id]
    if (q?.kind !== 'subscription') return false
    return typeof q.weeklyPercent === 'number' && q.weeklyPercent >= gateAt(id)
  }
  const gatedIds = agents.filter((a) => gated(a.id)).map((a) => a.id)
  // Who Jev may pick for the WORK. A gated subscription cannot take execution work, so offering
  // it and then overriding the answer in code pays Jev to weigh a door that is already shut.
  // `agents` stays whole: judgment roles may still use a gated agent, which is the point of the
  // gate. Falls back to the full list if everything is gated, since no agent is worse than a
  // dear one.
  const workAgents = agents.filter((a) => !gated(a.id))
  const routeAgents = workAgents.length ? workAgents : agents

  // --- capability filtering -------------------------------------------------
  // What code can already tell is impossible never reaches Jev: an executor that cannot take
  // the attached modality, may not change files, or needs a network that is not there is not
  // offered at all. Jev then chooses among candidates that can actually do the work, and code
  // re-checks its pick, so a capability mismatch can never be routed.
  // A policy exclusion is unavailability like any other. The registry is built from every enabled
  // agent, so leaving the excluded ones in here kept their capabilities on offer and let the
  // "nothing here can do this" guard below count an agent that may never run as the one that could.
  // The weekly gate is NOT unavailability: it is the operator's cost policy, enforced on the pick
  // below, and it yields when nothing ungated can do the job. (This line once listed the gated
  // ids too, but through a map that read \`.id\` off plain id strings, so they never counted: the
  // gate has only ever been policy here, and now the code says so instead of appearing to do
  // something else.)
  const unavailableIds = new Set([...policyExcluded, ...notReady, ...outAtStart].map((a) => a.id))
  // Read before the capability filter, because the note is part of what an agent must hold.
  const handoffFile = join(cwd, HANDOFF)
  const priorHandoff = await readFile(handoffFile, 'utf8').catch(() => null)
  // The part of the note Jev reads. It quotes whatever the earlier agent printed, so it is
  // scrubbed before it is cut: a key the cut splits keeps neither the prefix nor the length the
  // scrubber knows it by, and jev.js, which scrubs again, would see only an ordinary word. The
  // context estimate below reads the raw note, so what an agent must hold is measured as it is.
  const handoffForJev = priorHandoff ? redactSecrets(priorHandoff).slice(0, 3000) : undefined
  // How much this request needs an agent to hold, in the units decision.js estimates with: the
  // context window is a hard fact the registry applies (capabilities.js maxInputBytes), so the
  // same check covers online, offline and local-only runs, and every capability-checked move.
  const contextNeed = contextEstimate(task, priorHandoff ? priorHandoff.slice(0, 3000) : undefined)
  const need = {
    inputBytes: contextNeed * CHARS_PER_TOKEN,
    modalities: deps.inputModalities ?? ['text'],
    mutation: !answerOnly,
    ...(localOnly ? { locality: 'local' } : remoteOnly ? { locality: 'hosted' } : {}),
    ...(deps.offline ? { network: false } : {}),
    available: unavailableIds,
  }
  const executors = deps.executors ?? []
  const capable = executors.length ? rank(eligible(executors, need)) : []
  const capableIds = new Set(capable.map((e) => e.id))
  // An unsupported tool is a hard fact, so it is filtered BEFORE any judgment rather than after
  // one: a registered script that cannot take the attached modality, or that this run's
  // restrictions rule out, is never offered to Jev at all. Handing it the whole enabled list and
  // rejecting the answer afterwards paid for a door that was already shut. `toolAllowed` below
  // still re-checks the pick against the capability Jev named, which is only known afterwards.
  const tools = (config.tools ?? []).filter((t) => t.enabled !== false && (!executors.length || capableIds.has(`tool:${t.id}`)))
  // Only narrow the field when the registry actually knows these agents; an unwired registry
  // must not silently empty the pool.
  const known = executors.filter((e) => e.kind !== 'chat').map((e) => e.id)
  // The work pool is the ungated agents that can do it. When none can, the gate yields to the
  // gated ones that can, the same rule every swap below follows: a request nothing ungated can
  // carry out is not refused while an agent that can is merely past its cost gate.
  const capableUngated = routeAgents.filter((a) => capableIds.has(a.id))
  const narrowed = executors.length && routeAgents.some((a) => known.includes(a.id))
    ? (capableUngated.length ? capableUngated : agents.filter((a) => gated(a.id) && capableIds.has(a.id)))
    : routeAgents
  if (executors.length && narrowed.length === 0) {
    const tooSmall = executors.some((e) => e.kind === 'agent' && e.maxInputBytes !== null && need.inputBytes > e.maxInputBytes)
    throw new Error(`nothing here can do this request: it needs ${need.modalities.join('+')} input${need.mutation ? ' and may change files' : ''}${tooSmall ? `, and room for about ${contextNeed} tokens of context` : ''}${localOnly ? ', on this PC' : ''}. Enabled agents: ${routeAgents.map((a) => a.id).join(', ') || 'none'}`)
  }
  const pickPool = narrowed.length ? narrowed : routeAgents
  // The capabilities some pickable executor really has, so Jev is never offered a category
  // nothing on this machine can carry out (tools are offered through their own question).
  const capabilitySet = executors.length
    ? [...new Set(capable.filter((e) => e.kind !== 'chat' && e.kind !== 'tool').flatMap((e) => e.capabilities))].filter((c) => c !== 'deterministic_tool' && c !== 'human_required')
    : null

  /**
   * Choose an agent for a role. Execution roles skip gated subscriptions so their remaining
   * weekly percent is kept for judgment; judgment roles may still use them. Falls back to the
   * ungated ranking rather than failing, because no agent at all is worse than an expensive one.
   */
  const other = (probabilities, avoid, role = 'retry') => {
    if (JUDGMENT_ROLES.includes(role)) {
      // A reviewer may be gated or conserved (judging is what they are kept for), but not one a
      // fact excluded: a model that cannot hold the request cannot hold it to judge it either.
      const judges = agents.filter((a) => !hardOut.has(a.id))
      return pickOther(probabilities, avoid, judges.length ? judges : agents)
    }
    // Work goes only to an agent that can do what the run needs (capableSet is fixed before any
    // work role is asked for), ungated first. The gate yields only when nothing ungated can do the
    // job; a retry handed to an agent that cannot read the input or reach the network is a
    // capability mismatch routed, whatever it saves.
    const able = agents.filter((a) => canDo(a.id))
    const ungated = able.filter((a) => !gated(a.id))
    const pool = ungated.length ? ungated : able.length ? able : agents.filter((a) => !gated(a.id))
    return pickOther(probabilities, avoid, pool.length ? pool : agents)
  }
  const availability = deps.quota ? Object.fromEntries(agents.map((a) => [a.id, gated(a.id) ? 'over the weekly gate: judgment only' : near(a.id) ? 'near limit' : 'ok'])) : undefined

  const { limits } = config
  const productionCritical = config.productionWorkspaces.some((p) => cwd.toLowerCase().startsWith(p.toLowerCase()))
  emit('start', { task, cwd, forceAgent })
  // The environment every git call in the workspace runs with, when the config gives one: the
  // capability benchmark's names its task's repository, kept outside the folder the agent writes to,
  // and holds no key of KzH's (docs/benchmark.md 3.7). KzH's own environment otherwise.
  const gitOpts = config.git?.env ? { env: config.git.env } : {}
  await ensureHandoffIgnored(cwd, gitOpts).catch(() => {})
  const { context, snapshot: startSnap } = await gatherContext(cwd, { productionCritical, signal, ...gitOpts })
  const history = await deps.history.recent(cwd, 10)
  // Agents billed by time of day (DeepSeek): Jev sees which are on their cheap rate right now.
  const pricing = pricingNow(config.pricing?.peak)
  const records = deps.history.records ? await deps.history.records().catch(() => []) : null
  const agentRecord = records ? trackRecord(records, cwd, agents, { availability, pricing, economics: config.resources?.economics }) : undefined
  // Feedback priors: the person's Like/Dislike on earlier answers, read through the same
  // deps.history path history.jsonl uses, every session at once. This session's verdicts alone
  // (the filter feedback.js list() applies for one session) make the counts and reasons that ride
  // each agent's track record into the routing prompt, and the correction a suggestedAgent makes,
  // exactly as when nothing else was read: another session's typed words never reach this
  // session's routing call. The bounded bias applied to Jev's own probabilities once it answers
  // is weighed over every session's verdicts, by how well the work each judged matches this task.
  // No feedback, an unreadable file, or a verdict naming no agent leaves all of this empty.
  const everyVerdict = (deps.history.feedback ? await deps.history.feedback().catch(() => []) : null) ?? []
  const sessionVerdicts = sessionId ? everyVerdict.filter((r) => r?.sessionId === sessionId) : everyVerdict
  const priors = feedbackPrior(sessionVerdicts, agents, { modelOf: deps.modelOf })
  if (agentRecord) {
    for (const [id, f] of priors.agents) {
      if (agentRecord[id]) agentRecord[id] = { ...agentRecord[id], feedback: { likes: f.likes, dislikes: f.dislikes, suggested: f.suggested, recent_reasons: f.reasons } }
    }
  }

  // 1. Routing
  let routing
  const routeStarted = Date.now()
  // Without Jev, deterministic policy picks - but it must still pick something that can do the
  // job. The configured fallback agent is a preference, not an exemption from capability: with an
  // image attached, a text-only fallback would be handed work it cannot read.
  const fallbackPick = () => {
    const can = pickPool.some((a) => a.id === config.fallbackAgent) ? config.fallbackAgent : pickPool[0]?.id
    return can ?? config.fallbackAgent
  }
  // The strategy's steps. A plain pick is one primary step; the decision engine may add a plan
  // step before it and a reviewer after it.
  let plan = null
  if (forceAgent) {
    routing = { mode: 'manual', primaryAgent: forceAgent }
  } else if (deps.offline && !P.local) {
    // Offline is local-only, so the pool is already restricted; pick the best of what is left.
    // A decider on this PC needs no network, so offline it keeps deciding, over the local agents.
    routing = { mode: 'offline', primaryAgent: offlinePick(pickPool.length ? pickPool : agents).id, reason: 'no internet: fixed rule, local agents only' }
  } else if (deps.decide) {
    // The decision engine: task profile, hard eligibility, anonymous candidates with their
    // capability evidence and scarcity, then the resource, the strategy and the judgments, each
    // by whichever authority its routing domain has earned. Gated subscriptions ride along
    // marked, because a frontier floor may outrank the gate; the engine decides that in code.
    try {
      const gatedPool = agents.filter((a) => gated(a.id) && !pickPool.includes(a) && (!executors.length || capableIds.has(a.id) || !known.includes(a.id)))
      const d = await deps.decide({
        task, context, history, tools, answerOnly, runId,
        capableFor: executors.length ? (capability) => new Set(rank(eligible(executors, { ...need, capability })).filter((e) => e.kind === 'agent').map((e) => e.id)) : undefined,
        handoff: handoffForJev,
        agents: [...pickPool, ...gatedPool],
        gated: gatedIds,
        modelOf: deps.modelOf,
        modalities: deps.inputModalities ?? ['text'],
        capabilitySet: capabilitySet ?? undefined,
        availability, trackRecord: agentRecord,
        // The client and the record beside it, always the router's own record: a missing client
        // can never make a Laya run use Jev's (decision.js).
        jev: decider, decider, provider: P, jevUnavailableReason: deps.jevUnavailableReason,
        signal, emit,
      })
      routing = { mode: localOnly ? 'local' : 'jev', ...d.routing }
      plan = d.plan
    } catch (err) {
      if (signal.aborted) throw err
      // Every candidate failing a hard fact is an answer, not an outage. Falling back would route
      // the work to one of the resources just excluded, which is the single thing the exclusions
      // exist to prevent, so the run stops and repeats who was excluded and why.
      if (noCandidatesLeft(err)) throw err
      const pick = fallbackPick()
      routing = { mode: 'fallback', primaryAgent: pick, reason: describeError(err), ...(pick !== config.fallbackAgent ? movedTo('capability', config.fallbackAgent, pick) : {}) }
    }
  } else if (!decider) {
    const pick = fallbackPick()
    routing = { mode: 'fallback', primaryAgent: pick, reason: deps.jevUnavailableReason, ...(pick !== config.fallbackAgent ? movedTo('capability', config.fallbackAgent, pick) : {}) }
  } else {
    try {
      routing = { mode: localOnly ? 'local' : 'jev', ...(await decider.route({ task, context, agents: pickPool, tools, history, availability, trackRecord: agentRecord, ...(capabilitySet ? { capabilities: capabilitySet } : {}), ...(handoffForJev ? { handoff: handoffForJev } : {}) }, signal)) }
    } catch (err) {
      if (signal.aborted) throw err
      const pick = fallbackPick()
      routing = { mode: 'fallback', primaryAgent: pick, reason: describeError(err), ...(pick !== config.fallbackAgent ? movedTo('capability', config.fallbackAgent, pick) : {}) }
    }
  }
  // `mode` says how the pool and the decision path were chosen, whoever chose; `decider` says who
  // that was, for every run, a manual one included: a forced agent under Laya Auto is still
  // Laya's to review. history.jsonl keeps it with the rest of `routing`.
  routing = { ...routing, decider: P.id }
  // Jev has now said what the request needs, so the filter runs a second time with that answer
  // in hand: a `web_research` job must not run on an agent with no network, and a read-only
  // request must not demand - or be granted - write permission. This is what makes the
  // capability answer binding rather than decorative.
  const READ_ONLY_CAPABILITIES = ['quick_answer', 'reasoned_answer', 'project_read', 'web_research', 'image_inspection', 'ocr']
  // `other` is the choice's escape hatch and `human_required` is the "stop and ask" answer:
  // neither is a capability any executor can declare, so filtering on them would empty the field
  // and refuse the very request Jev was flagging. `human_required` is handled below by stopping.
  const namedCapability = routing.capability && routing.capability !== 'other' && routing.capability !== 'human_required'
    ? routing.capability : null
  const needNow = {
    ...need,
    ...(namedCapability ? { capability: namedCapability } : {}),
    ...(READ_ONLY_CAPABILITIES.includes(namedCapability) ? { mutation: false } : {}),
  }
  const capableNow = executors.length ? rank(eligible(executors, needNow)) : []
  const capableNowIds = new Set(capableNow.map((e) => e.id))
  // The agents (not chat models, not scripts) that can carry out what Jev named.
  const capableNowAgents = capableNow.filter((e) => e.kind === 'agent').map((e) => e.id)
  // Answering is the one thing every agent can do, so naming it must never refuse the run: the
  // adapter answers questions itself, and if an answer-shaped capability reaches the router it is
  // better served by an agent than by an error.
  const ANSWER_CAPABILITIES = ['quick_answer', 'reasoned_answer']
  // A Jev-routed local-only run ('local') is held to the same rule: choosing local-only narrows who
  // may do the work, it does not make a local model able to do a job it cannot.
  if (!forceAgent && (routing.mode === 'jev' || routing.mode === 'local') && namedCapability && !ANSWER_CAPABILITIES.includes(namedCapability)
    && executors.length && capableNowAgents.length === 0) {
    throw new Error(`nothing ${routing.mode === 'local' ? 'on this PC' : 'here'} can do this request as "${namedCapability}": ${routeAgents.map((a) => a.id).join(', ') || 'no agents'} cannot carry it out`)
  }
  if (!byId.has(routing.primaryAgent)) routing.primaryAgent = agents[0].id
  // Code checks Jev's pick against what the chosen capability requires, so a mismatch can never
  // be routed: an agent that cannot read the attached input, may not write, or has no network
  // for a look-up is replaced by the best one that can. Jev is a judgment layer, not the
  // permission system.
  const capableSet = capableNowIds.size ? capableNowIds : capableIds
  // What the decision engine excluded as a FACT (a context window too small, a resource the
  // governor reads as unusable, a capability it lacks) rather than as policy (the floor, the
  // gate, conservation). Those bind every move the router makes of its own - swap, retry, review,
  // hand-over - exactly like the facts the router filters itself.
  const hardOut = new Set((routing.decision?.excluded ?? []).filter((e) => e?.hard).map((e) => e.id))
  // Whether an agent can do what this run needs. An agent the registry does not know is not
  // filtered out: an unwired registry must never silently empty the pool.
  function canDo(id) { return !hardOut.has(id) && (!executors.some((e) => e.id === id && e.kind === 'agent') || capableSet.has(id)) }
  // Conservation (decision.js) moved the work off the most capable resource on purpose. It is the
  // decision engine's limit, not a router gate, so that resource is still in pickPool, and every
  // swap below would otherwise be free to hand the work straight back. None of them may; it stays
  // available to review. The capability swap alone may still land there when nothing else can do
  // the job, because a capability is a hard fact and conservation is not.
  const conservedFrom = routing.conservedFrom ?? null
  if (!forceAgent && executors.some((e) => e.id === routing.primaryAgent && e.kind === 'agent') && !capableSet.has(routing.primaryAgent)) {
    // Only an agent that can do what was named may take the work: the very set the pick was just
    // measured against, never the looser one (which let the swap "move" the work onto another
    // agent that cannot do it either). A capability is a hard fact, so it outranks conservation
    // (a spending limit) and the weekly gate (a cost rule): first an agent neither applies to,
    // then the conserved one, and only when nothing ungated can do it at all, a gated one - the
    // gate yields, and the record says so.
    const fitSet = (capableNowIds.size ? capableNow : capable).filter((e) => e.kind === 'agent' && byId.has(e.id) && !hardOut.has(e.id))
    const inPool = fitSet.filter((e) => pickPool.some((a) => a.id === e.id))
    const swap = inPool.find((e) => e.id !== conservedFrom) ?? inPool[0] ?? fitSet.find((e) => gated(e.id))
    if (swap) {
      emit('capability', { from: routing.primaryAgent, to: swap.id, capability: routing.capability ?? null })
      routing = { ...routing, ...movedTo('capability', routing.primaryAgent, swap.id, routing.moves), ...(gated(swap.id) ? { gateYielded: 'capability' } : {}) }
    }
  }
  // What one more job on a resource costs at the margin: 'none' (it runs on this PC), 'low' (a
  // subscription window that is rationed rather than billed per token) or 'metered' (a key that
  // bills per token). The run's own decision snapshot answers first, then the operator's
  // per-agent override, then the billing kind. Routing asks for this property and never for who
  // the provider is, so a newly added resource that is funded the same way is routed the same
  // way the moment it says so, with no code edit here.
  const marginalCost = (id) => routing.decision?.candidates?.find((c) => c.id === id)?.marginalCost
    ?? config.resources?.economics?.[id]?.marginalCost
    ?? marginalCostOf(byId.get(id))
  // Indifference is not a decision. When Jev's top pick is barely ahead of the next one its
  // probabilities carry no information, so fall back to the standing policy instead: the default
  // worker is a resource whose marginal cost is low, being neither metered nor weak. That rescues
  // a coin flip in both directions, away from spending a paid key AND away from handing real work
  // to a small local model, which was how a 0.26 pick landed on qwen-local. Only fires inside the
  // margin, so a confident pick is never overridden, and Jev's own ranking still decides which
  // of the tied agents wins. Local-only and offline runs have nothing low-cost in the list, so
  // nothing moves there.
  const minConfidence = config.policy?.minRoutingConfidence ?? 0.5
  const tieMargin = config.policy?.tieMargin ?? 0.1
  if (!forceAgent && routing.mode === 'jev' && (routing.agentConfidence ?? 1) < minConfidence && marginalCost(routing.primaryAgent) !== 'low') {
    const p = routing.agentProbabilities ?? {}
    const top = p[routing.primaryAgent] ?? 0
    const cheaper = agents
      // Low marginal cost only, never free. "Cheapest" must not mean "weakest": a tie is exactly
      // when Jev cannot tell them apart, so handing the work to a small local model on a coin
      // flip buys a retry, not a saving.
      .filter((a) => a.id !== routing.primaryAgent && a.id !== conservedFrom && !gated(a.id) && canDo(a.id) && marginalCost(a.id) === 'low' && top - (p[a.id] ?? 0) <= tieMargin)
      .sort((x, y) => (p[y.id] ?? 0) - (p[x.id] ?? 0))[0]
    if (cheaper) {
      emit('tiebreak', { from: routing.primaryAgent, to: cheaper.id, confidence: routing.agentConfidence ?? null, margin: tieMargin, decider: P.id })
      routing = { ...routing, ...movedTo('tiebreak', routing.primaryAgent, cheaper.id, routing.moves) }
    }
  }
  // Jev is told about the gate but is a prior, not a rule: enforce it on the work agent. The one
  // exception is the decision engine's own, made in code: a task that needs frontier capability
  // no ungated resource has keeps the gated one, and says so in `decision.gateOverride`.
  if (!forceAgent && gated(routing.primaryAgent) && !routing.decision?.gateOverride && !routing.gateYielded) {
    // Off the gated primary, onto an ungated agent that can really do the work: an unconserved one
    // first, the conserved one before an agent that cannot do the job at all. With nobody ungated
    // able to do it, the gate yields - moving the work to an agent that cannot do it would be a
    // capability mismatch routed to save a subscription window.
    const ungated = agents.filter((a) => !gated(a.id) && canDo(a.id))
    const unconserved = ungated.filter((a) => a.id !== conservedFrom)
    const pool = unconserved.length ? unconserved : ungated
    const swap = pool.length ? pickOther(routing.agentProbabilities, routing.primaryAgent, pool) : null
    if (swap && swap !== routing.primaryAgent) {
      emit('gate', { agent: routing.primaryAgent, to: swap, percent: quota[routing.primaryAgent]?.weeklyPercent ?? null, at: gateAt(routing.primaryAgent) })
      routing = { ...routing, ...movedTo('gate', routing.primaryAgent, swap, routing.moves) }
    } else {
      routing = { ...routing, gateYielded: agents.some((a) => !gated(a.id)) ? 'capability' : 'everything_gated' }
    }
  }

  // The feedback prior, applied. The bounded bias from recent Likes and Dislikes moves an
  // agent's probability, and the top pick is re-read from the adjusted numbers, so a demoted
  // agent loses a close call while a confident pick survives. The bias is weighed here rather
  // than before routing because only now is the task type known: a verdict about the same kind of
  // work counts fully from any session, one about other work a little (verdictWeight). The
  // person's newest correction in this session (a suggestedAgent) is stronger and switches the
  // pick outright, but only to an agent this run could really have used: enabled, in the
  // capability pool, and not past its weekly gate.
  // Manual overrides and non-Jev routes never reach here, so those are untouched.
  // Only vote rows are in `weighed.agents` with a non-zero bias: an answer-only tag contributed no
  // vote (see feedbackPrior), so nothing here can move a pick because of one. Its words already
  // reached the routing prompt through the track record above, which is all it is meant to do.
  // runOfVerdict reads only the verdict's own session, so the history is split by session once
  // rather than filtered whole for every verdict weighed: a verdict that weighs nothing never
  // fills the window, so the scan can walk the whole feedback log.
  const bySession = records && deps.history.runOfVerdict ? Map.groupBy(records, (r) => r?.sessionId) : null
  const runOf = bySession ? (v) => deps.history.runOfVerdict(v, bySession.get(v?.sessionId) ?? []) : undefined
  const weighed = !forceAgent && routing.mode === 'jev'
    ? feedbackPrior(everyVerdict, agents, { modelOf: deps.modelOf, weightOf: verdictWeight({ taskType: routing.taskType, sessionId, runOf }) })
    : null
  if (weighed && (weighed.agents.size || priors.suggestion)) {
    const probs = { ...(routing.agentProbabilities ?? {}) }
    const moved = []
    for (const [id, f] of weighed.agents) {
      if (!f.bias || !pickPool.some((a) => a.id === id && !gated(a.id))) continue
      const before = probs[id] ?? 0
      probs[id] = Math.max(0, Math.min(1, before + f.bias))
      moved.push({ agent: id, from: before, to: probs[id], likes: f.likes, dislikes: f.dislikes })
    }
    const pick = routing.primaryAgent
    // Only an agent this run could really have used may take the work, so a stale or
    // unavailable suggestion still cannot route past capability or the weekly gate.
    const usable = (id) => !!id && id !== conservedFrom && byId.has(id) && !gated(id) && pickPool.some((a) => a.id === id) && canDo(id)
    let primary = pick
    if (priors.suggestion && priors.suggestion !== pick && usable(priors.suggestion)) {
      primary = priors.suggestion
      moved.push({ agent: primary, suggested: true })
    } else if (moved.length) {
      const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0]
      if (top && top !== primary && usable(top)) { primary = top; moved.push({ agent: top, promoted: true }) }
    }
    if (primary !== pick) routing = { ...routing, ...movedTo('feedback', pick, primary, routing.moves) }
    if (moved.length) {
      routing = { ...routing, agentProbabilities: probs, feedback: moved }
      emit('feedback', { from: routing.feedbackFrom ?? null, to: routing.primaryAgent, moved })
    }
  }

  // The plan's primary step follows the pick only where the pick is the reason it must. A strategy
  // may deliberately put a different executor there - LOCAL_FIRST puts the local model in the
  // primary step on purpose - and a swap of the resource BEHIND that step (the tie-break, the gate,
  // feedback) says nothing against the local model, so it keeps its step. The step is rewritten to
  // the pick when it names the very agent a swap moved the work off, or when it could not have
  // been picked itself: the kept step must pass the same hard checks routing.primaryAgent had to -
  // enabled, in the capability pool, able to do what Jev named, and not past its weekly gate.
  // Otherwise a web_research job ran on a local model with no network, the one routing the
  // capability check exists to make impossible. conservedFrom is deliberately not a reason here:
  // decision.js built the plan around the new primary, so no step of it names that resource.
  if (!plan) plan = { strategy: routing.strategy ?? 'STANDARD_DIRECT', steps: [{ role: 'primary', agent: routing.primaryAgent }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: null, fallbackOrder: [], notes: [] }
  const swappedFrom = new Set([routing.capabilityFrom, routing.tiebrokeFrom, routing.gatedFrom, routing.feedbackFrom].filter(Boolean))
  const couldPick = (id) => byId.has(id) && !gated(id) && pickPool.some((a) => a.id === id) && canDo(id)
  const keepStep = (id) => id === routing.primaryAgent || (!swappedFrom.has(id) && couldPick(id))
  plan.steps = plan.steps.map((st) => (st.role === 'primary' && !keepStep(st.agent) ? { ...st, agent: routing.primaryAgent } : st)).filter((st) => st.role !== 'plan' || byId.has(st.agent))
  // Who actually does the work: the strategy's primary step. The same as the routed pick unless a
  // strategy put someone else there, and it is the producer every other role is measured against.
  const workerAgent = plan.steps.find((st) => st.role === 'primary')?.agent ?? routing.primaryAgent
  // The parallel answerer answers the whole task and the planner writes the plan: both are WORK,
  // so both must pass what the worker passed, and neither may be the resource conservation kept
  // back. One that fails is replaced by the strongest agent that passes, or dropped with a note.
  const canWorkBeside = (id) => !!id && id !== workerAgent && id !== conservedFrom && couldPick(id)
  const workerBeside = () => {
    const ranked = (routing.decision?.candidates ?? []).map((c) => c.id).filter(canWorkBeside)
    return ranked.length ? strongestOther({ decision: { candidates: (routing.decision?.candidates ?? []).filter((c) => ranked.includes(c.id)) } }, workerAgent, byId) : null
  }
  if (plan.parallelWith && !canWorkBeside(plan.parallelWith)) {
    const was = plan.parallelWith
    plan.parallelWith = workerBeside()
    plan.notes = [...(plan.notes ?? []), plan.parallelWith ? `${was} could not answer alongside; ${plan.parallelWith} gives the second opinion` : `${was} could not answer alongside and nobody else can; running without a second opinion`]
  }
  const planStep = plan.steps.find((st) => st.role === 'plan')
  if (planStep && planStep.agent !== workerAgent && !canWorkBeside(planStep.agent)) {
    const was = planStep.agent
    const planner = workerBeside()
    plan.steps = planner ? plan.steps.map((st) => (st === planStep ? { ...st, agent: planner } : st)) : plan.steps.filter((st) => st !== planStep)
    plan.notes = [...(plan.notes ?? []), planner ? `${was} could not plan this; ${planner} plans it` : `${was} could not plan this and nobody else can; ${workerAgent} works without a separate plan`]
  }
  // A reviewer the plan REQUIRES is replaced, not dropped, when a swap made it the worker or a
  // fact excluded it: a strategy that promises a frontier review must not be accepted unreviewed
  // while its record still names that strategy. A reviewer may be gated or conserved.
  if (plan.reviewer && (plan.reviewer === workerAgent || !byId.has(plan.reviewer) || hardOut.has(plan.reviewer))) {
    const was = plan.reviewer
    const stand = strongestOther(routing, workerAgent, byId)
    const replacement = stand && !hardOut.has(stand) ? stand : other(routing.agentProbabilities, workerAgent, 'review')
    if (replacement && replacement !== workerAgent && !hardOut.has(replacement)) {
      plan.reviewer = replacement
      plan.notes = [...(plan.notes ?? []), `${was} could not review ${workerAgent}'s work; ${replacement} reviews it`]
    } else {
      plan.reviewer = null; plan.forceReview = false; plan.frontierReview = false
      plan.notes = [...(plan.notes ?? []), `${was} could not review and nobody else can; the review this strategy plans cannot happen`]
    }
  }
  routing = { ...routing, strategy: plan.strategy }

  // An unfinished note from an earlier run goes to the primary agent only when the task continues it.
  const continuing = !!priorHandoff && (typeof routing.continueHandoff === 'number' ? routing.continueHandoff >= T.continueHandoff : /continue|resume|carry on/i.test(task))
  let handoffNote = continuing ? priorHandoff : null
  // Tool only when handler picks it, its "fits" Noul clears the decider's `tool` bar (a Noul
  // bar, not a Choice confidence), and its weakest argument choice clears `toolArgConfidence`. The registry
  // gates it too: a registered script is an executor, so a text-only one must not be handed an
  // image just because its description matched.
  const toolAllowed = (id) => !executors.length || (namedCapability ? capableNowIds.has(`tool:${id}`) : capableIds.has(`tool:${id}`))
  const tool = routing.handler && routing.handler !== 'agent' && (routing.toolFits ?? 0) >= T.tool
    && (routing.toolArgConfidence ?? 0) >= T.toolArgConfidence && toolAllowed(routing.handler)
    ? tools.find((t) => t.id === routing.handler) : undefined
  if (routing.handler && routing.handler !== 'agent' && !tool) {
    emit('capability', { from: `tool:${routing.handler}`, to: routing.primaryAgent, capability: routing.capability ?? null })
  }
  emit('routed', { routing, context, ms: Date.now() - routeStarted, tool: tool?.id, plan: { strategy: plan.strategy, steps: plan.steps, reviewer: plan.reviewer, forceReview: plan.forceReview, parallelWith: plan.parallelWith } })

  // 2. Baseline checks, so later failures can be told apart from pre-existing ones.
  //    Taken before the first agent attempt; a tool run skips them to stay fast.
  // ponytail: after a tool that edited files escalates, the baseline includes the tool's edits.
  // `env`, when the config gives one, is the environment the checks run the agent's code with.
  const checkOpts = { scripts: config.checks.scripts, timeoutMs: config.checks.timeoutMs, outputChars: config.checks.outputChars, signal, ...(config.checks.env ? { env: config.checks.env } : {}) }
  let baseline = null
  const ensureBaseline = async () => {
    if (baseline) return
    baseline = config.checks.enabled ? await runChecks(cwd, checkOpts) : []
    lastChecks = baseline
    if (baseline.length) emit('checks', { phase: 'baseline', checks: baseline.map(({ name, passed, exitCode, durationMs }) => ({ name, passed, exitCode, durationMs })) })
  }
  // Checks must pass before an accept unless the decider routed and said they need not: a decider
  // whose bar is 'always' (Laya's) always requires them, answered or not.
  const requireChecks = routing.mode !== 'jev' || T.needsTests === 'always' || routing.needsTests >= T.needsTests

  // The agent's own note when it updated it during the attempt, else one written from evidence.
  const saveHandoff = async (since) => {
    const s = await stat(handoffFile).catch(() => null)
    const previous = s ? await readFile(handoffFile, 'utf8').catch(() => '') : ''
    if (s && s.mtimeMs >= since - 1000) { emit('handoff', { path: HANDOFF, source: 'agent' }); return previous }
    const text = harnessHandoff({ task, attempts, diff: await changedSince(cwd, startSnap, signal, gitOpts), checks: lastChecks, previous })
    await mkdir(dirname(handoffFile), { recursive: true })
    await writeFile(handoffFile, text)
    emit('handoff', { path: HANDOFF, source: 'harness' })
    return text
  }

  // 3. Execute / review loop. A tool, when Jev picked one, goes first; if the
  //    review does not accept its output, the run escalates to the routed agent.
  const attempts = []
  const assessments = []
  const limitEvents = []
  let lastChecks = []
  let producer = null // agent whose changes are under assessment
  // The plan written by a plan step, handed to the worker's prompt; null until one runs.
  let planText = null
  let parallelDone = false
  // What the parallel second opinion came to, once the two answers have been compared.
  let secondOpinion = null
  // The strategy's own hand-over order (broker.js): who takes the work when the current executor
  // fails, so LOCAL_FIRST's "a stronger resource takes over if it fails" is a promise the loop
  // keeps rather than a line in the record nothing ever read. An agent that has already done the
  // WORK (a primary or retry attempt) is skipped: handing it back the task it just failed is not
  // a hand-over. A plan or a parallel opinion did not do the work, so it does not count.
  // The hand-over order: when a strategy put someone other than the routed resource in the
  // primary step (LOCAL_FIRST), the promise was "a stronger resource takes over", and the stronger
  // resource is the one routing chose - so it goes first. After it, the strategy's own order, but
  // never an agent a router swap just moved the work off (the order was written before the swap),
  // and only one that passes the same hard checks as the pick.
  const handOverOrder = () => [...(workerAgent !== routing.primaryAgent ? [routing.primaryAgent] : []), ...(plan.fallbackOrder ?? [])]
  const fallbackAfter = (avoid) => handOverOrder().find((id) => id !== avoid && !swappedFrom.has(id) && couldPick(id)
    && !attempts.some((a) => a.agent === id && (a.role === 'primary' || a.role === 'retry')))
  // Only a strategy whose primary step is someone other than the routed resource PROMISED a
  // hand-over. broker.js gives every plan a fallbackOrder, so consulting it on every retry let a
  // generic strongest-first list outrank Jev's own ranking for this very failure.
  const promisedHandOver = workerAgent !== routing.primaryAgent
  const firstStep = plan.steps[0] ?? { role: 'primary', agent: workerAgent }
  let next = tool ? { agent: `tool:${tool.id}`, role: 'tool' } : { agent: firstStep.agent, role: firstStep.role }
  let status = null
  let statusReason = ''
  let reviewed = false

  // The decider can read a request as needing a person: a permission nobody granted, a
  // consequential choice, information only they have. Nothing is executed in that case - an agent
  // would guess at an answer it is not allowed to give, and a confident "this needs you" is more
  // useful than a plausible wrong answer. Below the decider's own bar the run proceeds as normal,
  // so one unsure answer cannot stall ordinary work; Laya's bar sits higher than Jev's for that.
  if (!forceAgent && routing.mode === 'jev' && routing.capability === 'human_required'
    && (routing.capabilityConfidence ?? 1) >= T.humanRequired) {
    status = 'needs_human'
    statusReason = `${P.name} read this as needing a person (confidence ${pct(routing.capabilityConfidence)})`
    next = null
  }

  // A run you kill is an outcome, not a gap. Without this the abort escapes before the
  // history is written, so a stopped run leaves no row at all: you cannot see what you
  // killed, and the next run cannot tell "I stopped that one" from "that never happened".
  let stoppedBy = null
  try {
    while (next) {
      const workCount = attempts.filter((a) => a.role !== 'review').length
      const reviewCount = attempts.length - workCount
      if (attempts.length >= limits.maxRounds) { status = 'limit_reached'; statusReason = `maxRounds (${limits.maxRounds}) reached`; break }
      if (next.role !== 'review' && workCount >= limits.maxAttempts) { status = 'limit_reached'; statusReason = `maxAttempts (${limits.maxAttempts}) reached`; break }
      if (next.role === 'review' && reviewCount >= limits.maxReviews) { status = 'limit_reached'; statusReason = `maxReviews (${limits.maxReviews}) reached`; break }

      if (next.role !== 'tool' && !answerOnly) await ensureBaseline()
      const before = await snapshot(cwd, signal, gitOpts)
      const diffSoFar = attempts.length ? await changedSince(cwd, startSnap, signal, gitOpts) : { stat: '', patch: '' }
      const opts = { near: near(next.agent), handoff: handoffNote, plan: planText, skill: plan.skill }
      const prompt = next.role === 'tool' ? '' : next.role === 'primary' ? basePrompt(task, cwd, opts)
        : next.role === 'plan' ? planPrompt(task, cwd, { skill: plan.skill })
        : next.role === 'review' ? reviewPrompt(task, cwd, diffSoFar)
        : retryPrompt(task, cwd, attempts, lastChecks, opts)

      const started = Date.now()
      // This attempt's place in the record. A parallel opinion is pushed right after it, so its
      // end must not be reported as "the last attempt": the inspector pairs starts with ends by
      // index, and the primary would show no result at all.
      const attemptIndex = attempts.length
      emit('attempt_start', { index: attemptIndex, agent: next.agent, role: next.role, ...(next.role === 'tool' ? { args: routing.toolArgs } : {}) })
      const agentDef = byId.get(next.agent)
      const family = effortFamily(agentDef)
      const eff = next.role === 'tool' ? null
        : toAgentEffort(level, agentDef, { complexity: routing.complexity, risk: routing.risk, override: config.effort?.perAgent?.[family], model: deps.modelOf?.(agentDef), bands: T.effortBands })
      const speed = family === 'codex' ? config.effort?.codexSpeed : undefined
      let result
      // A parallel second opinion is read-only work by construction (broker.js offers it only for
      // answer-only requests), so two agents answering at once cannot collide in the working tree.
      const opinionAgent = next.role === 'primary' && answerOnly && !parallelDone && plan.parallelWith && byId.get(plan.parallelWith) ? byId.get(plan.parallelWith) : null
      let opinion = null
      // Each agent's own time limit, which a wait before its work starts does not use up (attemptClock).
      const clock = attemptClock(signal, config.agentTimeoutMs)
      const sideClock = opinionAgent ? attemptClock(signal, config.agentTimeoutMs) : null
      try {
        const main = next.role === 'tool'
          ? deps.runTool(tool, routing.toolArgs ?? {}, task, clock.signal)
          : deps.execute(agentDef, prompt, clock.signal, { effort: eff, speed, untimed: clock.untimed })
        if (opinionAgent) {
          parallelDone = true
          emit('attempt_start', { index: attemptIndex + 1, agent: opinionAgent.id, role: 'opinion' })
          const side = deps.execute(opinionAgent, prompt, sideClock.signal, { effort: toAgentEffort(level, opinionAgent, { complexity: routing.complexity, risk: routing.risk, override: config.effort?.perAgent?.[effortFamily(opinionAgent)], model: deps.modelOf?.(opinionAgent), bands: T.effortBands }), untimed: sideClock.untimed })
            .then((r) => r, (err) => (signal.aborted ? Promise.reject(err) : { stopReason: 'error', diagnostic: describeError(err), answerText: '' }))
          ;[result, opinion] = await Promise.all([main, side])
        } else result = await main
      } catch (err) {
        if (signal.aborted) throw err
        result = { stopReason: 'error', diagnostic: describeError(err), answerText: '' }
      } finally {
        clock.end()
        sideClock?.end()
      }
      const changes = await changedSince(cwd, before, signal, gitOpts)
      let limit = next.role === 'tool' ? { hit: false }
        : (deps.isLimitError ? deps.isLimitError(byId.get(next.agent), result) : builtinLimit(result)) ?? { hit: false }
      const attempt = {
        // A local agent that was still loading may hand the run to another agent (cold-start choice).
        agent: result.ranAs ?? next.agent,
        role: next.role,
        stopReason: result.stopReason,
        diagnostic: result.diagnostic,
        answerText: result.answerText,
        // Its own time: a wait before its work started is kept apart, so an average of these says
        // how long the agent works, not how long it was held back.
        durationMs: Date.now() - started - clock.waitedMs,
        ...(clock.waitedMs ? { waitedMs: clock.waitedMs } : {}),
        changedFiles: changes.files,
        ...(next.role === 'tool' ? {} : { model: deps.modelOf?.(agentDef) }),
        ...(next.role === 'tool' ? {} : servedModel(result)),
        ...(eff ? { effort: `${eff}${speed === 'fast' ? ' 1.5x' : ''}` } : {}),
        ...(limit.hit ? { limitHit: true } : {}),
      }
      attempts.push(attempt)
      if (opinion) {
        const o = { agent: opinionAgent.id, role: 'opinion', stopReason: opinion.stopReason, diagnostic: opinion.diagnostic, answerText: opinion.answerText, durationMs: Date.now() - started - sideClock.waitedMs, ...(sideClock.waitedMs ? { waitedMs: sideClock.waitedMs } : {}), changedFiles: [], model: deps.modelOf?.(opinionAgent), ...servedModel(opinion) }
        attempts.push(o)
        emit('attempt_end', { index: attemptIndex + 1, attempt: { ...o, answerText: (o.answerText ?? '').slice(0, 4000) } })
        // PARALLEL_SECOND_OPINION promises that the two answers are COMPARED. Without this the
        // opinion was run, pushed and then silently dropped, which is two bills for one answer.
        // The comparison is deterministic and coarse, so it never picks a winner: the primary's
        // answer stands and the person is told, with the number, when the second does not match.
        secondOpinion = { agent: opinionAgent.id, ...compareAnswers(result.answerText, opinion.answerText) }
        emit('second_opinion', { agent: opinionAgent.id, primary: attempt.agent, ...secondOpinion })
      }

      // A metered key is read once at routing time from a cached figure, so a long run could
      // spend past both its thresholds before anything looked again. Re-read after each attempt
      // by that agent: the soft tier makes the next prompt say "work in small steps and keep the
      // handoff current", and the hard tier takes the same route a usage limit does, which writes
      // the handoff and hands the task to someone else rather than stopping dead.
      if (next.role !== 'tool' && !limit.hit && deps.checkBalance) {
        const fresh = await deps.checkBalance(next.agent).catch(() => null)
        const was = quota[next.agent]?.state
        if (fresh?.state && fresh.state !== was) {
          quota[next.agent] = { ...(quota[next.agent] ?? {}), ...fresh }
          emit('balance', { agent: next.agent, from: was ?? null, state: fresh.state, balance: fresh.balance ?? null })
          // The attempt is already pushed, and it is the same object: mark it here or the run
          // treats this as a quota stop while the record says a plain failure, which would
          // depress the agent's track record, mis-score the routing pick and hide the pill.
          if (OUT_STATES.includes(fresh.state)) { limit = { hit: true, until: fresh.until ?? null, spent: true }; attempt.limitHit = true }
        }
      }

      if (next.role !== 'tool') {
        const entry = { ts: new Date().toISOString(), runId, workspace: cwd, agent: next.agent, role: next.role, durationMs: attempt.durationMs, tokens: result.usage ?? null, costUsd: result.costUsd ?? null, stopReason: result.stopReason, limitHit: !!limit.hit }
        await (async () => deps.logAttempt?.(entry))().catch(() => {})
      }

      // A usage limit says nothing about the work's quality: skip the review and
      // continue with a fresh key, the peer agent, or pause with a handoff note.
      if (limit.hit) {
        emit('attempt_end', { index: attemptIndex, attempt: { ...attempt, answerText: (attempt.answerText ?? '').slice(0, 4000) } })
        const until = limit.until ?? null
        const reason = diagText(result.diagnostic || result.stopReason).slice(0, 300)
        const { rotated } = (await (async () => deps.onLimit?.(next.agent, { until, reason }))().catch(() => null)) ?? {}
        handoffNote = await saveHandoff(started).catch((err) => { emit('error', { message: `handoff not saved: ${err.message}` }); return handoffNote })
        const isReview = next.role === 'review'
        let action
        if (rotated) {
          action = 'rotated'
          next = { agent: next.agent, role: isReview ? 'review' : 'retry' }
        } else {
          out.push({ id: next.agent, until })
          agents.splice(agents.findIndex((a) => a.id === next.agent), 1)
          byId.delete(next.agent)
          const peer = byId.get(config.agents.find((a) => a.id === next.agent)?.peer ?? PEERS[next.agent])
          // Work may go only to an agent that can do what the run needs (the attached input, the
          // named capability, the context); a review only to one no fact excludes. The peer table
          // says who is the usual stand-in, not that it can stand in for THIS job.
          const candidates = isReview ? agents.filter((a) => a.id !== producer && !hardOut.has(a.id)) : agents.filter((a) => canDo(a.id))
          // The peer is the cheap first choice, but not when it is itself past its weekly gate:
          // handing work to a spent subscription just moves the problem. Then the ranking runs,
          // which skips gated agents for work roles and so lands on the api agent.
          const role = isReview ? 'review' : 'retry'
          const usePeer = candidates.includes(peer) && (isReview || !gated(peer.id))
          const to = usePeer ? peer.id : candidates.length ? pickOther(routing.agentProbabilities, next.agent, JUDGMENT_ROLES.includes(role) ? candidates : (candidates.filter((a) => !gated(a.id)).length ? candidates.filter((a) => !gated(a.id)) : candidates)) : null
          action = to ? 'peer' : 'paused'
          next = to ? { agent: to, role } : null
        }
        limitEvents.push({ agent: attempt.agent, until, action })
        emit('limit', { agent: attempt.agent, until, action })
        if (!next) { status = 'paused_limit'; statusReason = `all agents at their usage limits${outLabel()}` }
        continue
      }

      // A plan step is not the work: its answer becomes the worker's plan and the loop moves
      // straight on to the primary step. A plan that failed is simply no plan.
      if (next.role === 'plan') {
        emit('attempt_end', { index: attemptIndex, attempt: { ...attempt, answerText: (attempt.answerText ?? '').slice(0, 4000) } })
        if (result.stopReason === 'completed' && result.answerText) planText = result.answerText
        else emit('error', { message: `plan step by ${next.agent} produced no plan (${result.stopReason}); the worker starts without one` })
        next = { agent: workerAgent, role: 'primary' }
        continue
      }

      // A reviewer that crashed says nothing about the work: hand the review to
      // an agent that is neither the producer nor the failed reviewer, or to a person.
      if (next.role === 'review' && result.stopReason !== 'completed') {
        const why = `reviewer ${next.agent} failed (${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''})`
        emit('attempt_end', { index: attemptIndex, attempt: { ...attempt, answerText: '' } })
        const failed = attempts.filter((x) => x.role === 'review' && x.stopReason !== 'completed').map((x) => x.agent)
        const reviewer = agents.find((x) => x.id !== producer && !failed.includes(x.id) && !hardOut.has(x.id))
        const assessment = { mode: 'skipped', action: reviewer ? 'second_review' : 'human', why: reviewer ? `${why}; asking ${reviewer.id}` : `${why}; no other reviewer left` }
        assessments.push(assessment)
        emit('review', { index: attemptIndex, assessment })
        if (!reviewer) { status = 'needs_human'; statusReason = assessment.why; break }
        next = { agent: reviewer.id, role: 'review' }
        continue
      }
      if (next.role !== 'review') { producer = next.agent; reviewed = false } else reviewed = true

      // A plain question needs an answer, not project checks or a code review.
      if (answerOnly) {
        emit('attempt_end', { index: attemptIndex, attempt: { ...attempt, answerText: (attempt.answerText ?? '').slice(0, 4000) } })
        if (result.stopReason === 'completed') { status = 'answered'; break }
        next = { agent: fallbackAfter(next.agent) ?? other({}, next.agent, 'retry'), role: 'retry' }
        continue
      }

      if (config.checks.enabled && next.role !== 'tool' && (changes.files === null || changes.files.length > 0)) lastChecks = await runChecks(cwd, checkOpts)
      attempt.checks = lastChecks.map(({ name, passed, exitCode, durationMs }) => ({ name, passed, exitCode, durationMs }))
      emit('attempt_end', { index: attemptIndex, attempt: { ...attempt, answerText: (attempt.answerText ?? '').slice(0, 4000) } })
      const cmp = compareChecks(baseline ?? [], lastChecks)
      const totalDiff = await changedSince(cwd, startSnap, signal, gitOpts)
      const touchedCode = totalDiff.files === null || totalDiff.files.length > 0
      const blockAccept = result.stopReason !== 'completed' || cmp.regressed.length > 0 || (requireChecks && touchedCode && cmp.failing.length > 0)

      // Review plugin: Jev verdict plus deterministic overrides.
      const verification = lastChecks.map((c) => ({ check: c.name, passed: c.passed, exit_code: c.exitCode, output: c.passed ? '' : c.output }))
      const { status: accepted, ...assessment } = await review({ task, routing, attempts, checks: verification, cmp, diff: totalDiff, agents, blockAccept, reviewed, touchedCode, pickOther: other, strategy: plan.strategy, runId }, signal)
      // A strategy that promised a review gets one: accepted work is still shown to the reviewer
      // the plan named before it is final. Deterministic, so a classifier cannot talk its way
      // past it, and only when that reviewer can actually run.
      if (assessment.action === 'accept' && !reviewed && plan.forceReview && plan.reviewer && byId.has(plan.reviewer) && plan.reviewer !== producer) {
        assessment.action = 'second_review'
        assessment.forcedReviewer = plan.reviewer
        assessment.why += `; the ${plan.strategy} strategy requires ${plan.reviewer} to review first`
      }
      assessments.push(assessment)
      emit('review', { index: attemptIndex, assessment })

      const action = assessment.action
      if (action === 'accept') { status = accepted; break }
      if (action === 'human') { status = 'needs_human'; statusReason = assessment.why; break }
      if (next.role === 'tool') next = { agent: workerAgent, role: 'primary' } // escalate tool -> agent
      else if (action === 'second_review') {
        // The reviewer: the one the strategy named, else the strongest other candidate when the
        // disposition asks for a frontier review, else Jev's pick for the job. A review the plan
        // promised goes to the reviewer it named whatever asked for this one (the second-opinion
        // judgment, a quality between the bars): the run counts as reviewed after it, so any other
        // reviewer here meant the named one, often the frontier reviewer, never ran.
        const promised = plan.forceReview && plan.reviewer && byId.has(plan.reviewer) && plan.reviewer !== producer && !reviewed ? plan.reviewer : null
        const strongest = assessment.disposition === 'FRONTIER_REVIEW' ? strongestOther(routing, producer, byId) : null
        const reviewer = assessment.forcedReviewer ?? promised ?? strongest ?? other(assessment.reviewAgentProbabilities, producer, 'review')
        next = { agent: reviewer, role: 'review' }
      } else {
        // Stall guard: work attempts that changed no files are not progress, and another retry
        // will not be different. Stop and ask a person rather than spend again on the same
        // nothing. Uses changedFiles, which every attempt already records.
        const work = attempts.filter((a) => a.role === 'primary' || a.role === 'retry').slice(-(config.policy?.stallAfter ?? STALL_AFTER))
        // changedFiles is null when we could not measure (not a git repo, git status failed):
        // unknown is not zero, and stopping a run that was working costs more than one more attempt.
        if (work.length >= (config.policy?.stallAfter ?? STALL_AFTER) && work.every((a) => a.changedFiles?.length === 0)) {
          emit('stalled', { attempts: work.length, agents: work.map((a) => a.agent) })
          status = 'needs_human'
          statusReason = `${work.length} work attempts in a row changed no files; stopping instead of retrying again`
          break
        }
        // Jev naming the next agent is still a suggestion: a retry is work, so a gated agent
        // must not be taken just because Jev named it. The disposition refines the choice: the
        // same resource again when the fix is within its reach, a different one when it keeps
        // getting this wrong.
        const named = assessment.retryAgent && byId.has(assessment.retryAgent) && !gated(assessment.retryAgent) && canDo(assessment.retryAgent) ? assessment.retryAgent : null
        let retryAgent
        // A strategy that put someone in front of the routed resource PROMISED the hand-over when
        // that step fails ("the local model goes first; the routed resource takes over"). A
        // same-tier retry from the fallback or a local review would retry the local model instead,
        // and the routed resource would never run. The promise comes first; Jev naming a resource
        // outright still outranks it.
        if (promisedHandOver && producer === workerAgent && producer !== routing.primaryAgent) retryAgent = (named && named !== producer ? named : null) ?? fallbackAfter(producer) ?? other(assessment.retryAgentProbabilities, producer, 'retry')
        else if (assessment.disposition === 'RETRY_SAME_TIER' && byId.has(producer) && !gated(producer)) retryAgent = producer
        // Moving off the producer is the hand-over a LOCAL_FIRST-shaped strategy wrote its
        // fallbackOrder for, so there that order comes before the ranking. Anywhere else Jev's
        // ranking for THIS failure is the better information and the order is only a last
        // resort when Jev gave none. Jev naming one resource outright comes first either way.
        else if (assessment.disposition === 'RETRY_DIFFERENT_RESOURCE' || assessment.disposition === 'WRONG') {
          const ranked = Object.keys(assessment.retryAgentProbabilities ?? {}).length > 0
          const handOver = promisedHandOver || !ranked ? fallbackAfter(producer) : null
          retryAgent = named && named !== producer ? named : handOver ?? other(assessment.retryAgentProbabilities, producer, 'retry')
        } else retryAgent = named ?? other(assessment.retryAgentProbabilities, next.agent, 'retry')
        next = { agent: retryAgent, role: 'retry' }
      }
    }
  } catch (err) {
    if (!signal.aborted) throw err
    // Record it, then rethrow: callers still treat an abort as an abort.
    stoppedBy = err
    status = 'stopped'
    statusReason = 'stopped by the user'
  }

  // Accepted work closes the note it continued or wrote, so it never leaks into a later task;
  // a note from other unfinished work stays for its own next session.
  const wroteNote = (await stat(handoffFile).catch(() => null))?.mtimeMs >= runStartedAt - 1000
  if (status?.startsWith('accepted') && (continuing || wroteNote)) {
    await rename(handoffFile, join(cwd, '.kz-harness', `handoff-done-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)).catch(() => {})
  }

  // A run another provider decided says what its calls cost and which did not answer: every call
  // of the review included, so this is filled in only now. `model` is already the client's label.
  if (!P.teacher) {
    let device = null
    try { device = deps.deciderDevice?.() ?? null } catch { /* a device nobody can read is not said */ }
    routing = { ...routing, deciderErrors, deciderMs, ...(device ? { deciderDevice: device } : {}) }
  }

  const record = {
    ts: new Date().toISOString(),
    runId,
    // Which conversation this run belongs to. Without it consecutive runs look unrelated, so
    // "that was wrong, do it again" reads as a brand new job and the correction is lost.
    ...(sessionId ? { sessionId } : {}),
    workspace: cwd,
    task,
    context,
    routing,
    strategy: plan.strategy,
    plan: { strategy: plan.strategy, steps: plan.steps, reviewer: plan.reviewer, forceReview: plan.forceReview, parallelWith: plan.parallelWith, notes: plan.notes ?? [], ...(plan.skill ? { skill: plan.skill } : {}) },
    continuedFromHandoff: continuing,
    ...(secondOpinion ? { secondOpinion } : {}),
    ...(deps.offline ? { offline: true } : {}),
    ...(gatedIds.length ? { gated: gatedIds } : {}),
    availability: { out, near: agents.filter((a) => near(a.id)).map((a) => a.id) },
    limits: limitEvents,
    baseline: (baseline ?? []).map(({ name, passed }) => ({ name, passed })),
    attempts: attempts.map(({ answerText, ...rest }) => ({ ...rest, answerExcerpt: (answerText ?? '').slice(0, 1000) })),
    assessments,
    finalStatus: status,
    statusReason,
  }
  // The work is done either way; a failed history write must not swallow the report.
  await deps.history.append(record).catch((err) => emit('error', { message: `history not saved: ${err.message}` }))
  if (stoppedBy) throw stoppedBy
  emit('final', { status, statusReason })
  // Whose words the person is shown: the PRIMARY's answer. A parallel second opinion is pushed
  // after it, so "the last attempt with any text" handed the run's answer to the opinion and cut
  // the primary's down to a 1000-char excerpt in the record. The opinion speaks only when the
  // primary produced nothing at all.
  const last = answeringAttempt(attempts)
  return { ...record, lastAnswer: last?.answerText ?? '', lastAnswerBy: last ? `${last.agent}${last.model || last.effort ? ` (${[last.model, last.effort].filter(Boolean).join(', ')})` : ''}, ${last.role}` : '' }
}

// Label and scheme of the invisible chain marker at the end of a report. client.js
// matches the same two strings; they are the contract between the halves.
/**
 * Every move the router made of its own, in order, each with where it came from and where it
 * went. A record from before `moves` was kept has only the `<kind>From` fields, and then each
 * reads as a move to the final primary, which is all that record knows.
 */
export function movesOf(R) {
  if (Array.isArray(R?.moves)) return R.moves
  return Object.entries(MOVE_FIELD).filter(([, f]) => R?.[f]).map(([kind, f]) => ({ kind, from: R[f], to: R.primaryAgent }))
}

/** One move in words, for the report. */
export function moveLine(m, R = {}) {
  if (m.kind === 'capability') return `${m.from} cannot do this (${R.capability ?? 'capability unclear'}): ${m.to} took the work`
  if (m.kind === 'tiebreak') return `${m.from} was barely ahead of ${m.to}, a near tie, and ${m.to} costs less at the margin: ${m.to} took the work`
  if (m.kind === 'gate') return `Work moved off ${m.from} (past its weekly gate) to ${m.to}`
  if (m.kind === 'feedback') return `Feedback moved the pick off ${m.from} to ${m.to}`
  return `Work moved from ${m.from} to ${m.to}`
}

const STRIP_LABEL = 'jev-agents'
const STRIP_PREFIX = 'kzh-agents-1-'

// Whose words you are reading: the last attempt that produced an answer, never a parallel
// second opinion - that one is its own step in the chain, not the answer - unless nothing else
// answered at all. The report carries excerpts, the live record carries the full text; either
// one marks the step. The same rule runRouted uses to pick lastAnswer.
const hasText = (a) => !!(a.answerExcerpt || a.answerText)
const answeringAttempt = (attempts) => attempts.findLast((a) => hasText(a) && a.role !== 'opinion') ?? attempts.findLast(hasText)

/** The chain as data: Jev, then one step per agent, in the order the work moved. */
export function answeredSteps(r) {
  const attempts = r.attempts ?? []
  const answering = answeringAttempt(attempts)
  // Only a CONSECUTIVE repeat folds into the step before it. Agents used to be deduplicated
  // across the whole run, which was harmless in an unordered list but lies in a chain: an
  // agent that reviewed, handed off, and reviewed again would show up once, hiding the round
  // trip and making the last handover look like the end of the story.
  const steps = []
  for (const a of attempts) {
    const model = [a.model, a.effort].filter(Boolean).join(', ')
    const role = a.role === 'review' ? 'reviewer' : a.role === 'tool' ? 'tool' : a.role === 'plan' ? 'planner' : a.role === 'opinion' ? 'second opinion' : 'work'
    const last = steps.at(-1)
    const step = last?.agent === a.agent && last.model === model ? last : null
    if (step) { if (!step.roles.includes(role)) step.roles.push(role) } else steps.push({ agent: a.agent, model, roles: [role] })
    if (a === answering) (step ?? steps.at(-1)).answered = true
  }
  // One chain, in the order the work actually moved: router, then whoever worked, then
  // whoever judged. Agents used to be joined with a middot, which read as an unordered list
  // and hid the handover.
  // The router's step names who decided, as the report's heading does (adapter.js decidedBy):
  // the run's decider (Jev, or Laya with its client's model label) whenever it answered a domain,
  // or when there is no per-domain report (legacy named routing); else the local router; else the
  // rules in code alone.
  const decider = r.routing?.decider ?? TEACHER
  const auths = new Set(Object.values(r.routing?.decision?.domains ?? {}).map((d) => d?.authority))
  const byDecider = !r.routing?.decision || auths.has(decider)
  const router = r.routing?.mode === 'jev' || r.routing?.mode === 'local'
    ? [byDecider ? { agent: providerName(decider), model: r.routing.model ?? '', roles: [] } : { agent: auths.has('local') ? 'Local router' : 'Routing rules', model: '', roles: [] }]
    : []
  return [...router, ...steps]
}

/** "Jev (jev-1.13.0) → deepseek (deepseek-flash) → claude (opus) [reviewer]": who took part, in order. */
export function answeredBy(r) {
  return answeredSteps(r).map(({ agent, model, roles }) => {
    const tag = roles.filter((x) => x !== 'work').join(', ')
    return `${agent}${model ? ` (${model})` : ''}${tag ? ` [${tag}]` : ''}`
  }).join(' → ')
}

/** Concise user-facing report. Structured results only, no hidden reasoning. */
export function formatReport(r) {
  const R = r.routing
  const lines = []
  // Who decided the run names the router: Jev, or Laya in Laya Auto. A record from before
  // `decider` was kept was Jev's.
  const decider = R.decider ?? TEACHER
  const name = providerName(decider)
  // Every authority that decided a domain, the rules that rank the resources included; a run
  // with no per-domain report (legacy named routing) was the decider's. The heading names them
  // only: the "Decided by" line under it says which domain each one answered.
  const decided = decidedBy(R.decision?.domains, { detail: false }) ?? `${name} decided`
  const modeLabel = { jev: `AUTO (${decided})`, manual: `MANUAL /${R.primaryAgent}`, fallback: `AUTO, ${name.toUpperCase()} UNAVAILABLE: routing fallback activated`, offline: 'OFFLINE: local models only', local: `AUTO (${decided}), LOCAL MODELS ONLY` }[R.mode]
  lines.push(`**${name} router** · ${modeLabel}${R.mode !== 'offline' && r.offline ? ' · OFFLINE: local models only' : ''}`)
  if (R.mode === 'fallback') lines.push(`Fallback reason: ${R.reason}. Default agent: ${R.primaryAgent}`)
  lines.push(`- Selected agent: **${R.primaryAgent}**${R.mode === 'jev' ? ` (confidence ${pct(R.agentConfidence)}; ${Object.entries(R.agentProbabilities).map(([k, v]) => `${k} ${pct(v)}`).join(', ')})` : ''}`)
  if (R.mode === 'jev') {
    lines.push(`- Task type: ${R.taskType} (confidence ${pct(R.taskTypeConfidence)})`)
    if (R.capability) lines.push(`- Capability: ${R.capability}${R.capabilityConfidence === undefined ? '' : ` (confidence ${pct(R.capabilityConfidence)})`}`)
    lines.push(`- Complexity ${pct(R.complexity)} · Risk ${pct(R.risk)}`)
    lines.push(`- Needs second review ${pct(R.needsSecondOpinion)} · Needs human review ${pct(R.needsHumanReview)} · Needs tests ${pct(R.needsTests)}`)
  }
  // What a provider on this PC answered too flat to act on, which the routing rules stood in for,
  // and every call of it that did not answer at all: nothing it could not decide is passed off as
  // its decision (docs/laya-auto.md 3.3).
  const filled = R.profile?.filledByRules ?? []
  if (filled.length) lines.push(`- Filled by the routing rules (${name}'s answers were too flat to use): ${filled.join(', ')}`)
  for (const e of R.deciderErrors ?? []) lines.push(`- ${name} did not answer: ${e.phase}: ${e.reason}`)
  // A strategy may put someone other than the routed resource in the primary step (LOCAL_FIRST
  // does), and then "Selected agent" alone would name an agent that never ran. This follows the
  // plan, not the decision record: the plan is what the loop executed, whoever made it.
  const worker = r.plan?.steps?.find((st) => st.role === 'primary')?.agent
  if (worker && worker !== R.primaryAgent) lines.push(`- ${worker} does the work under this strategy; ${R.primaryAgent} is the resource behind it`)
  if (R.decision) {
    const d = R.decision
    const p = r.plan ?? d.plan
    const extras = [p?.steps?.some((st) => st.role === 'plan') ? `plan by ${p.steps.find((st) => st.role === 'plan').agent}` : '', p?.reviewer ? `review by ${p.reviewer}` : '', p?.parallelWith ? `second opinion from ${p.parallelWith}` : ''].filter(Boolean)
    lines.push(`- Strategy: ${R.strategy ?? p?.strategy ?? 'STANDARD_DIRECT'}${extras.length ? ` (${extras.join(', ')})` : ''}`)
    // A run another provider decided has no maturity to print: the local ladder's rung says
    // nothing about it (decision.js reports null), so no bracket appears. Its calls are counted
    // to it, with the time they took on this PC and where.
    const domains = Object.entries(d.domains ?? {}).map(([k, v]) => `${k} ${v.authority}${v.maturity ? ` [${v.maturity}]` : ''}`)
    const caller = providerName(d.decider ?? decider)
    const spent = typeof R.deciderMs === 'number' && d.jevCalls ? ` (${(R.deciderMs / 1000).toFixed(1)} s${R.deciderDevice ? ` on the ${deviceName(R.deciderDevice)}` : ''})` : ''
    if (domains.length) lines.push(`- Decided by: ${domains.join(' · ')}${d.jevCalls ? ` · ${d.jevCalls} ${caller} call${d.jevCalls === 1 ? '' : 's'}${spent}` : ` · no ${caller} call`}`)
    const cands = (d.candidates ?? []).map((c) => `${c.key}=${c.id} (${c.tier}, fit ${pct(c.fit)}, scarcity ${c.scarcity == null ? 'unknown' : pct(c.scarcity)}, cost ${c.expectedCost?.class ?? 'unknown'})`)
    if (cands.length) lines.push(`- Candidates: ${cands.join('; ')}`)
    if (d.excluded?.length) lines.push(`- Excluded: ${d.excluded.map((e) => `${e.id} (${e.reason})`).join('; ')}`)
    if (d.gateOverride) lines.push(`- Kept ${R.primaryAgent} despite its weekly gate: the task needs frontier capability nothing else has`)
  }
  // The skill the worker was told to approach the job as (decision.js puts it on the plan; the
  // router's own fallback plan has none, and then nothing is shown).
  const skill = (r.plan ?? R.decision?.plan)?.skill
  if (skill?.primary) lines.push(`- Skill: ${skill.primary}${skill.supporting?.length ? ` (+ ${skill.supporting.join(', ')})` : ''}`)
  // Who the gate held back, and who it did not. The resource that did the work despite its gate is
  // named on its own line with the reason; listing it as "kept for review only" too would say the
  // opposite of what happened.
  const keptPast = R.gateYielded || R.decision?.gateOverride ? R.primaryAgent : null
  const heldBack = (r.gated ?? []).filter((id) => id !== keptPast)
  if (R.gateYielded === 'capability') lines.push(`- Kept ${R.primaryAgent} despite its weekly gate: nothing ungated can do this request`)
  else if (R.gateYielded === 'everything_gated') lines.push(`- Kept ${R.primaryAgent} despite its weekly gate: every agent is past its gate`)
  if (heldBack.length) lines.push(`- Past the weekly gate, kept for review only: ${heldBack.join(', ')}`)
  if (r.routing?.conservedFrom) lines.push(`- Work kept off ${r.routing.conservedFrom} to conserve it for harder work; it stays available to review`)
  for (const m of movesOf(R)) lines.push(`- ${moveLine(m, R)}`)
  if (r.continuedFromHandoff) lines.push(`- Continuing from handoff (${HANDOFF})`)
  const av = r.availability
  if (av?.out.length || av?.near.length) {
    lines.push(`- ${[av.out.length ? `Out: ${av.out.map((o) => `${o.id}${o.until ? ` until ${hhmm(o.until)}` : ''}`).join(', ')}` : '', av.near.length ? `near limit: ${av.near.join(', ')}` : ''].filter(Boolean).join('; ')}`)
  }
  if (r.baseline.length) lines.push(`- Baseline checks: ${r.baseline.map((c) => `${c.name} ${c.passed ? 'pass' : 'FAIL'}`).join(', ')}`)
  // A review another provider stopped under its own accept bar says so where the run is summed up,
  // since that bar is higher than Jev's and its cost should be seen, not guessed (jev-review).
  for (const s of r.assessments ?? []) {
    if (s?.mode && s.mode !== TEACHER && String(s.why ?? '').includes(`under ${providerName(s.mode)}'s accept bar`)) lines.push(`- Review: ${s.action}. ${s.why}`)
  }
  lines.push('', '**Attempts**')
  // Limit-hit attempts get no assessment, so assessments are matched in order over the others.
  let k = 0
  r.attempts.forEach((a, i) => {
    const s = a.limitHit ? undefined : r.assessments[k++]
    lines.push(`${i + 1}. ${a.agent} (${a.role}): ${a.stopReason} in ${Math.round(a.durationMs / 1000)}s${a.diagnostic ? `, ${a.diagnostic}` : ''}`)
    lines.push(`   Changed files: ${a.changedFiles === null ? 'unknown (not git)' : a.changedFiles.length ? a.changedFiles.join(', ') : 'none'}`)
    if (a.checks?.length) lines.push(`   Checks: ${a.checks.map((c) => `${c.name} ${c.passed ? 'pass' : `FAIL(${c.exitCode})`}`).join(', ')}`)
    if (s) lines.push(`   Assessment: ${s.why} → **${s.action}**`)
  })
  for (const l of r.limits ?? []) lines.push(`- Usage limit: ${l.agent}${l.until ? ` (resets ${hhmm(l.until)})` : ''} → ${{ rotated: 'next API key', peer: 'handed to another agent', paused: 'paused' }[l.action]}`)
  // Two resources answered independently, so the person is told what the comparison found rather
  // than being shown one answer as if only one had been asked. The overlap is a word count, not
  // a judgment, so it is named as such and the differing answer is shown instead of discarded.
  const so = r.secondOpinion
  if (so) {
    // Whose answer is shown is said from the attempt that actually wrote it: when the primary
    // came back empty the opinion's answer is shown, and when a retry answered it is the retry's.
    // "The answer below is the primary's" was printed in both cases, and was false in both.
    const by = answeringAttempt(r.attempts ?? [])
    const whose = !by ? 'No answer came back.'
      : by.role === 'primary' ? 'The answer below is the primary\'s.'
      : by.role === 'opinion' ? `The primary gave no answer; the answer below is the second opinion from ${by.agent}.`
      : `The answer below is ${by.agent}'s (${by.role}).`
    // An old record has no `empty` field: it could only fail to compare on an empty side then.
    const found = so.compared
      ? `the two answers ${so.agree ? 'agree' : 'DIFFER'} - wording overlap ${pct(so.similarity)}, a word comparison rather than a judgment.`
      : so.empty === false ? 'both answered, but their wording could not be compared word for word.' : 'nothing came back to compare.'
    lines.push('', `**Second opinion (${so.agent})**: ${found} ${whose}`)
    const opinionText = (r.attempts ?? []).find((a) => a.role === 'opinion')?.answerExcerpt
    if (so.compared && !so.agree && opinionText) lines.push('', `Second opinion from ${so.agent} (excerpt):\n${opinionText}`)
  }
  const reset = earliest(r.availability?.out ?? [])
  const label = {
    answered: 'ANSWERED',
    accepted: 'ACCEPTED',
    accepted_pending_human_review: 'ACCEPTED, human review recommended before merging',
    needs_human: 'NEEDS HUMAN',
    limit_reached: 'STOPPED: limit reached',
    paused_limit: `PAUSED: agents at their limits, handoff saved in ${HANDOFF}${reset ? ` (earliest reset ${hhmm(reset)})` : ''}`,
  }[r.finalStatus] ?? r.finalStatus
  lines.push('', `**Final status: ${label}**${r.statusReason && r.finalStatus !== 'paused_limit' ? ` (${r.statusReason})` : ''}`)
  if (r.lastAnswer) lines.push('', r.lastAnswer.slice(0, 4000))
  // The agent strip under the message (client.js) reads the chain from here. A markdown link
  // reference definition renders as nothing, while raw HTML in message text comes out escaped,
  // so this is the only channel that carries data without showing it.
  const steps = answeredSteps(r)
  if (steps.length) lines.push('', `[${STRIP_LABEL}]: ${STRIP_PREFIX}${Buffer.from(JSON.stringify(steps)).toString('base64url')}`)
  return lines.join('\n')
}
