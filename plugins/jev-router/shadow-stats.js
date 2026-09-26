// What the Laya shadow shows: agreement with Jev, what either would have done, and Laya's standing
// (docs/laya-auto.md 5.5, 6.7, 8.4).
//
// Pure: rows in, figures out, nothing stored and nothing read. shadow.js runs it in a worker over
// the files, so a file at its cap is never parsed on the thread that streams the run the person is
// watching.
//
// Agreement is not accuracy: Jev is not ground truth, and nothing here is ever a gate. Accuracy is
// only what an outcome can judge, and almost every outcome KzH records is selected by the acting
// router's own failures, so the sources are kept apart and each is reported as what it can show:
//   - A person said: rows a person labelled (a routing tag, or for the review a like or dislike of
//     the run's answer); the only figure called accuracy, and paired only where both answers are
//     determined;
//   - Where Jev's pick was contradicted: rows that exist only because Jev's pick went wrong, so they
//     say how often Laya would have had it right there, never how often Laya is right;
//   - Laya Auto runs that failed: a failure rate of the runs Laya decided, never an accuracy; in the
//     review only evidence independent of that review counts, and for the task type and the skill,
//     which no outcome of a run labels, it is not measured (null) rather than a rate of 0.
// Pooled, one figure would measure the mix of modes: on second_opinion, where Jev mostly says no,
// the contradicted rows are rescues labelled yes, and a Laya that always says yes would score 1.0.
// No figure here is built from any text: rows, samples and history hold ids, labels and numbers,
// and a feedback row is read for its verdict, its tag and the keys it is read back by alone.
import { createHash } from 'node:crypto'
import { reviewAction } from '../jev-review/index.js'
import { CLEAR } from './feedback.js'
import { TASK_TYPES } from './jev.js'
import { DISPOSITIONS, SKILLS, STRATEGIES } from './routing-policy.js'

/** The question that teaches each routing domain the shadow can judge (5.5). */
export const DOMAIN_QUESTIONS = Object.freeze({
  task_classification: 'taskType',
  skill_selection: 'skill',
  execution_strategy: 'strategy',
  second_opinion: 'secondOpinion',
  outcome_disposition: 'disposition',
})
/** Every group a standing is kept for: the domains, and two that are no routing domain. */
export const GROUPS = Object.freeze([...Object.keys(DOMAIN_QUESTIONS), 'review_action', 'intent'])
/** The labels each group answers with; a yes/no group is one whose labels are exactly yes and no. */
export const GROUP_LABELS = Object.freeze({
  task_classification: Object.freeze(Object.keys(TASK_TYPES)),
  skill_selection: Object.freeze(Object.keys(SKILLS)),
  execution_strategy: Object.freeze(Object.keys(STRATEGIES)),
  second_opinion: Object.freeze(['yes', 'no']),
  outcome_disposition: DISPOSITIONS,
  review_action: Object.freeze(['accept', 'second_review', 'retry', 'human']),
  intent: Object.freeze(['task', 'question']),
})
/** Yes/no by its label set, whatever routing-policy.js calls its kind (second_opinion is `multiclass` there). */
export const isYesNo = (group) => {
  const labels = GROUP_LABELS[group]
  return !!labels && labels.length === 2 && labels.includes('yes') && labels.includes('no')
}
// The two groups the acting review's own action labels: only evidence independent of it judges them.
const REVIEW_GROUPS = new Set(['outcome_disposition', 'review_action'])
// The domains no outcome of a run labels as failed: training.js labelClassification gives a task type
// or a skill a label only from a person's tag or the teacher's own confirmation, which never comes
// for Laya, so a Laya Auto run of theirs is judged by what a person said and never counted failed.
const NO_RUN_FAILURE = new Set(['task_classification', 'skill_selection'])
const ACCEPTS = new Set(['accept', 'PASS'])
const REVIEW_NOULS = ['addressed', 'complete', 'unrelatedChanges', 'regressionRisk', 'needsPerson']
const WORK_ROLES = new Set(['primary', 'retry'])
const CONTRADICTING = new Set(['verified_outcome', 'verified_negative', 'later_review'])
// The profile fields task_classification hands over besides its label (6.7).
const PROFILE_FIELDS = ['risk', 'complexity', 'humanReview', 'needsTests', 'capability', 'minimumCapability', 'preferredCapability']
// A noul's bar per provider, by the thresholds key that holds it; the rest feed the review's quality.
const NOUL_BARS = { alsoWork: 'alsoWork', humanReview: 'humanReview', needsTests: 'needsTests', continueHandoff: 'continueHandoff', needsPerson: 'needsPerson', secondOpinion: 'judgmentYes' }
const SKIPS = ['not_running', 'starting', 'queue_full', 'too_old', 'jev_failed', 'yielded']
const PHASES = ['intent', 'route', 'review']
const DAY_MS = 86_400_000

const at = (ts) => { const t = Date.parse(ts); return Number.isNaN(t) ? 0 : t }
const r2 = (x) => Math.round(x * 100) / 100
const r3 = (x) => Math.round(x * 1000) / 1000
const num = (x) => typeof x === 'number' && Number.isFinite(x)
const median = (xs) => {
  const s = xs.filter(num).sort((a, b) => a - b)
  if (!s.length) return null
  const m = s.length >> 1
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2)
}
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v)

/** The 12-hex fingerprint of a provider's thresholds, as a shadow row records it (5.3). */
export const thresholdsHash = (t) => (t ? createHash('sha256').update(JSON.stringify(stable(t))).digest('hex').slice(0, 12) : null)

/** A bar a value clears: `'always'` always, a number at or over it. */
const clears = (x, bar) => bar === 'always' || (num(x) && num(bar) && x >= bar)
/**
 * A provider's thresholds when it has them, else null. Laya's are null while its settings are
 * invalid (2.2), and rows recorded before still reach a comparison of every identity and pair: a
 * figure that needs a side's bars is then left out rather than read against no bar.
 */
const barsOf = (t) => (t && typeof t === 'object' && t.accept && typeof t.accept === 'object' ? t : null)

/**
 * Whether an answer was right, wrong or undetermined by one outcome (5.5):
 *
 *   human with a label (good pick)        right when equal, wrong when not
 *   human with only negativeLabel X       wrong when X; right when not X in a yes/no group; else undetermined
 *   verified_outcome with a label         right when equal, wrong when not
 *   verified_negative (negativeLabel X)   as human with only X
 *   teacher_confirmed                     undetermined for both providers: the acting router agreeing with itself
 *
 * outcome_disposition and review_action are the acting review's own labels: their verified outcomes
 * derive from what that review did, so only independent evidence judges them. A person's like of the
 * run's answer makes an accept right and a dislike makes it wrong (`{ labelSource: 'human', verdict }`),
 * and a later review by another agent that did not accept makes it wrong
 * (`{ labelSource: 'later_review', accepted: false }`); any other answer stays undetermined.
 * @param {string|null} answer  the label an answer gives in this group
 * @param {object|null} outcome  a sample's outcome, or the independent evidence above
 * @param {string} group  a routing domain, `review_action` or `intent`
 * @returns {'right'|'wrong'|'undetermined'}
 */
export function judge(answer, outcome, group) {
  if (answer == null || !outcome || typeof outcome !== 'object') return 'undetermined'
  const source = outcome.labelSource
  if (REVIEW_GROUPS.has(group)) {
    if (!ACCEPTS.has(answer)) return 'undetermined'
    if (source === 'human' && (outcome.verdict === 'like' || outcome.verdict === 'dislike')) return outcome.verdict === 'like' ? 'right' : 'wrong'
    if (source === 'later_review' && outcome.accepted === false) return 'wrong'
    return 'undetermined'
  }
  if (group === 'intent' || source === 'teacher_confirmed') return 'undetermined'
  if ((source === 'human' || source === 'verified_outcome') && outcome.label != null) return answer === outcome.label ? 'right' : 'wrong'
  if ((source === 'human' || source === 'verified_negative' || source === 'verified_outcome') && outcome.negativeLabel != null) {
    if (answer === outcome.negativeLabel) return 'wrong'
    return isYesNo(group) ? 'right' : 'undetermined'
  }
  return 'undetermined'
}

// --- reading a row -------------------------------------------------------------------------------

const answerIn = (row, side, name) => row?.[side]?.questions?.[name] ?? null
const informative = (a) => a?.informative !== false
/** A score's expected level on its own 0..1 scale, as jev.js unit() reads it. */
const unitOf = (a) => (num(a?.answer) && Array.isArray(a?.p) && a.p.length > 1 ? a.answer / (a.p.length - 1) : null)
/** Rows where both sides answered: a row with a Jev error or a skip counts in coverage only. */
const compared = (row) => row?.status === 'answered' || row?.status === 'partial'

function agreesOn(type, j, l) {
  if (type === 'choice') return j.answer === l.answer
  if (type === 'noul') return (j.answer >= 0.5) === (l.answer >= 0.5)
  if (type === 'score') return Math.round(j.answer) === Math.round(l.answer)
  return false
}

/** How many of one row's questions both answered, and on how many they agree: the server log's line. */
export function rowAgreement(row) {
  let n = 0
  let agree = 0
  for (const [name, j] of Object.entries(row?.jev?.questions ?? {})) {
    const l = answerIn(row, 'laya', name)
    if (!l || l.type !== j?.type) continue
    n++
    if (agreesOn(j.type, j, l)) agree++
  }
  return { n, agree }
}

/** The review action one side's nouls give with its own thresholds and the row's recorded context (5.5). */
function actionOf(row, side, T) {
  if (!T) return null
  const q = row?.[side]?.questions ?? {}
  const a = Object.fromEntries(REVIEW_NOULS.map((n) => [n, q[n]?.answer]))
  if (!REVIEW_NOULS.every((n) => num(a[n]))) return null
  const ctx = { risk: num(row.review?.risk) ? row.review.risk : null, blockAccept: row.review?.blockAccept === true, reviewed: row.review?.reviewed === true }
  const r = reviewAction(a, ctx, T)
  // Below the accept bar: nothing blocked it and nobody was needed; the quality alone stopped it.
  const below = !ctx.blockAccept && !(a.needsPerson >= (T.needsPerson ?? 0.6)) && r.quality < r.bar && r.quality > (T.reject ?? 0.3)
  return { ...r, below, informative: REVIEW_NOULS.every((n) => informative(q[n])) }
}

/**
 * The review action each side's nouls give at its own thresholds with a review row's recorded
 * context, for the inspector's `Review action: Jev accept, Laya second_review.` (5.6); a side with
 * no bars or without every review noul is null.
 */
export function reviewActions(row, thresholds) {
  const act = (side) => actionOf(row, side, barsOf(thresholds?.[side]))?.action ?? null
  return { jev: act('jev'), laya: act('laya') }
}

/** One side's label in one group, and whether Laya marked it informative. Null when it has none. */
function labelIn(group, row, side, T) {
  if (group === 'review_action') {
    if (row?.phase !== 'review') return null
    const r = actionOf(row, side, T[side])
    return r ? { label: r.action, informative: r.informative } : null
  }
  if (group === 'intent') {
    const a = row?.phase === 'intent' ? answerIn(row, side, 'kind') : null
    return a ? { label: a.answer, informative: informative(a) } : null
  }
  if (group === 'outcome_disposition' && row?.phase !== 'review') return null
  // The judgments group's noul teaches second_opinion; the one that rides the task group is the profile's.
  if (group === 'second_opinion' && !row?.groups?.includes('judgments')) return null
  if (group !== 'outcome_disposition' && row?.phase !== 'route') return null
  const a = answerIn(row, side, DOMAIN_QUESTIONS[group])
  if (!a) return null
  if (group === 'second_opinion') return num(a.answer) && T[side] ? { label: a.answer >= T[side].judgmentYes ? 'yes' : 'no', informative: informative(a) } : null
  return { label: a.answer, informative: informative(a) }
}

// --- joining a row to what happened --------------------------------------------------------------

/** The samples, feedback and history a figure reads, indexed once. */
function indexOf({ jevSamples = [], layaSamples = [], feedback = [], history = [] }) {
  const jev = new Map()
  for (const s of jevSamples) {
    if (!s?.runId || !s.domain) continue
    const key = s.domain === 'outcome_disposition' ? `${s.runId}|${s.domain}|${s.extra?.decidedAt}` : `${s.runId}|${s.domain}`
    jev.set(key, s)
  }
  // A person's verdict on a run's answer, read back as feedback.js list() reads it: the newest row
  // per (sessionId, messageId), a pair whose newest row clears it dropped, then by time, newest
  // last. Only like and dislike, never the words.
  const newest = new Map()
  for (const f of feedback) if (f && typeof f === 'object' && f.sessionId && f.messageId) newest.set(`${f.sessionId}\n${f.messageId}`, f)
  const kept = [...newest.values()].filter((f) => f.verdict !== CLEAR).map((f, i) => [f, i]).sort((a, b) => at(a[0].ts) - at(b[0].ts) || a[1] - b[1])
  const verdicts = new Map()
  for (const [f] of kept) {
    if (f.runId && (f.verdict === 'like' || f.verdict === 'dislike')) verdicts.set(f.runId, f.verdict)
  }
  const runs = new Map()
  for (const h of history) if (h?.runId) runs.set(h.runId, h)
  return { jev, verdicts, runs, laya: layaSamples.filter((s) => s && typeof s === 'object') }
}

/**
 * The evidence about the review of attempt `k` of a run that does not come from that review: the
 * person's like or dislike of the run's answer, when this was the review of the last work, and a
 * later review by another agent after which the work was not accepted as it stood.
 */
function independentEvidence(runId, k, idx) {
  const out = []
  const record = idx.runs.get(runId)
  const attempts = Array.isArray(record?.attempts) ? record.attempts : null
  if (!attempts || !Number.isInteger(k) || !attempts[k]) return out
  const after = attempts.slice(k + 1)
  const laterWork = after.some((a) => a && WORK_ROLES.has(a.role) && !a.limitHit)
  const verdict = idx.verdicts.get(runId)
  if (verdict && !laterWork) out.push({ source: 'person', outcome: { labelSource: 'human', verdict } })
  const reviewedByOther = after.some((a) => a?.role === 'review' && a.stopReason === 'completed' && a.agent !== attempts[k].agent)
  if (reviewedByOther && (laterWork || record.finalStatus === 'needs_human')) out.push({ source: 'contradicted', outcome: { labelSource: 'later_review', accepted: false } })
  return out
}

/** Every piece of evidence about one row in one group, each as a person said or a contradiction. */
function evidenceFor(group, row, idx) {
  if (group === 'intent') return []
  const out = []
  if (group !== 'review_action') {
    const key = group === 'outcome_disposition' ? `${row.runId}|${group}|${row.attempt}` : `${row.runId}|${group}`
    const o = idx.jev.get(key)?.outcome
    if (o?.labelSource === 'human') out.push({ source: 'person', outcome: o })
    else if (CONTRADICTING.has(o?.labelSource)) out.push({ source: 'contradicted', outcome: o })
  }
  if (REVIEW_GROUPS.has(group)) out.push(...independentEvidence(row.runId, row.attempt, idx))
  return out
}

// --- one group's figures -------------------------------------------------------------------------

const pair = () => ({ n: 0, agree: 0 })

/**
 * Every figure of one group, from the compared shadow rows and the samples Laya decided. The two
 * shapes (8.4's domain entry, 6.7's standing row) are both read from this.
 */
function groupFigures(group, rows, idx, T) {
  const f = {
    answered: 0, informative: 0, agree: { all: pair(), informative: pair() },
    personLaya: { n: 0, right: 0 }, personJev: { n: 0, right: 0 }, paired: { n: 0, jevRight: 0, layaRight: 0 },
    contradicted: { n: 0, right: 0 }, jevActed: 0, layaAuto: { runs: new Set(), failed: new Set() }, fields: null,
  }
  for (const row of rows) {
    const j = labelIn(group, row, 'jev', T)
    const l = labelIn(group, row, 'laya', T)
    if (j) f.jevActed++
    if (!l) continue
    f.answered++
    if (l.informative) f.informative++
    if (!j) continue
    const same = j.label === l.label
    f.agree.all.n++
    if (same) f.agree.all.agree++
    if (l.informative) { f.agree.informative.n++; if (same) f.agree.informative.agree++ }
    for (const e of evidenceFor(group, row, idx)) {
      const jr = judge(j.label, e.outcome, group)
      // An answer marked too flat to use is never a row of any source (6.7).
      const lr = l.informative ? judge(l.label, e.outcome, group) : 'undetermined'
      if (e.source === 'person') {
        if (jr !== 'undetermined') { f.personJev.n++; if (jr === 'right') f.personJev.right++ }
        if (lr !== 'undetermined') { f.personLaya.n++; if (lr === 'right') f.personLaya.right++ }
        if (jr !== 'undetermined' && lr !== 'undetermined') {
          f.paired.n++
          if (jr === 'right') f.paired.jevRight++
          if (lr === 'right') f.paired.layaRight++
        }
      } else if (jr === 'wrong' && lr !== 'undetermined') {
        // Only where the evidence really contradicts Jev's own answer on that row.
        f.contradicted.n++
        if (lr === 'right') f.contradicted.right++
      }
    }
  }
  // The runs Laya decided: a person's word on them counts as said, their failures as a rate apart.
  // They are no answer beside Jev's, so `answered` and the informative share stay the shadow's:
  // counting the informative ones there and leaving the flat ones out would inflate the share.
  if (DOMAIN_QUESTIONS[group]) {
    if (NO_RUN_FAILURE.has(group)) f.layaAuto.failed = null
    for (const s of idx.laya) {
      if (s.domain !== group || s.authority !== 'laya' || !s.provider || s.provider.informative === false) continue
      if (s.runId) f.layaAuto.runs.add(s.runId)
      const o = s.outcome
      const evidence = o?.labelSource === 'human' ? [{ source: 'person', outcome: o }] : []
      if (REVIEW_GROUPS.has(group)) evidence.push(...independentEvidence(s.runId, s.extra?.decidedAt, idx))
      for (const e of evidence) {
        if (e.source !== 'person') continue
        const lr = judge(s.provider.label, e.outcome, group)
        if (lr !== 'undetermined') { f.personLaya.n++; if (lr === 'right') f.personLaya.right++ }
      }
      if (!s.runId || !f.layaAuto.failed) continue
      // A review's own action labels its outcome_disposition sample (a run Laya's nouls accepted is
      // labelled PASS against whatever disposition Laya gave), so there only evidence independent of
      // that review says the run failed (5.5): a dislike of an answer it accepted, or a later review
      // by another agent that did not accept it. Elsewhere it is the outcome's own verdict on the pick.
      const failed = REVIEW_GROUPS.has(group)
        ? evidence.some((e) => judge(s.provider.label, e.outcome, group) === 'wrong')
        : o?.labelSource === 'verified_outcome' || o?.labelSource === 'verified_negative'
      if (failed) f.layaAuto.failed.add(s.runId)
    }
  }
  if (group === 'task_classification') f.fields = fieldAgreement(rows)
  return f
}

/**
 * Agreement with Jev on every profile field task_classification hands over besides its label, as a
 * share per field (6.7). Laya's flat scores and choices are left out, as the profile leaves them
 * out; its nouls are kept, as the profile keeps them.
 */
function fieldAgreement(rows) {
  const counts = {}
  for (const row of rows) {
    if (row?.phase !== 'route' || !row.groups?.includes('task')) continue
    const names = [...PROFILE_FIELDS, ...Object.keys(row.laya?.questions ?? {}).filter((n) => n.startsWith('req.'))]
    for (const name of names) {
      const j = answerIn(row, 'jev', name)
      const l = answerIn(row, 'laya', name)
      if (!j || !l || (l.type !== 'noul' && !informative(l))) continue
      const c = (counts[name] ??= pair())
      c.n++
      if (agreesOn(j.type, j, l)) c.agree++
    }
  }
  return Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, r2(c.agree / c.n)]))
}

// --- the tables ----------------------------------------------------------------------------------

/** The question table of 8.4: per question, agreement over all answers and over Laya's informative ones. */
function questionTable(rows, T) {
  const byName = new Map()
  for (const row of rows) {
    for (const [name, j] of Object.entries(row.jev?.questions ?? {})) {
      const l = answerIn(row, 'laya', name)
      if (!l || !j || j.type !== l.type) continue
      let s = byName.get(name)
      if (!s) {
        const options = j.type === 'noul' ? 2 : Array.isArray(j.p) ? j.p.length : Array.isArray(l.p) ? l.p.length : null
        s = { name, type: j.type, options, corrected: 0, compared: 0, all: pair(), inf: pair(), inTopTwo: 0, diffs: [], bar: pair(), hasBar: false, flat: 0, ms: [] }
        byName.set(name, s)
      }
      const same = agreesOn(j.type, j, l)
      s.compared++
      s.all.n++
      if (same) s.all.agree++
      if (informative(l)) { s.inf.n++; if (same) s.inf.agree++ } else s.flat++
      if (l.corrected === true) s.corrected++
      if (num(row.ms)) s.ms.push(row.ms)
      if (j.type === 'choice' && Array.isArray(j.p) && Array.isArray(l.p)) {
        const jevPick = j.p.indexOf(Math.max(...j.p))
        const top = l.p.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, i]) => i)
        if (top.includes(jevPick)) s.inTopTwo++
      }
      if (j.type === 'noul' && num(j.answer) && num(l.answer)) s.diffs.push(Math.abs(j.answer - l.answer))
      if (j.type === 'score' && num(unitOf(j)) && num(unitOf(l))) s.diffs.push(Math.abs(unitOf(j) - unitOf(l)))
      // At each provider's own bar, where the question has one.
      const key = NOUL_BARS[name] ?? (j.type === 'noul' && /\.fits$/.test(name) ? 'tool' : j.type === 'score' && name.startsWith('req.') ? 'requirementWanted' : null)
      if (key && T.jev && T.laya) {
        const jv = j.type === 'score' ? unitOf(j) : j.answer
        const lv = l.type === 'score' ? unitOf(l) : l.answer
        if (num(jv) && num(lv)) {
          s.hasBar = true
          s.bar.n++
          if (clears(jv, T.jev[key]) === clears(lv, T.laya[key])) s.bar.agree++
        }
      }
    }
  }
  return [...byName.values()].map((s) => ({
    name: s.name, type: s.type, options: s.options, corrected: s.corrected,
    compared: s.compared, agree: { all: s.all, informative: s.inf },
    inTopTwo: s.type === 'choice' ? s.inTopTwo : null,
    meanDifference: s.type === 'choice' || !s.diffs.length ? null : r3(s.diffs.reduce((a, b) => a + b, 0) / s.diffs.length),
    atBar: s.hasBar ? s.bar : null,
    flat: s.flat,
    layaMedianMs: median(s.ms),
  }))
}

/**
 * Whether each provider would have acted the same, on each provider's own answers and bars (5.5):
 * task type, capability and strategy where Laya's answer was informative (a flat one is filled by
 * the rules, which no row records); the second opinion at each own judgmentYes; checks required at
 * each own needsTests; the needs_human stop at each own humanRequired, where a flat capability
 * stops nothing; and the review action through reviewAction(), with how many stopped under each
 * provider's accept bar.
 */
function actionTable(rows, T) {
  const same = Object.fromEntries(['task_type', 'capability', 'strategy', 'second_opinion', 'checks_required', 'needs_human', 'review_action'].map((w) => [w, pair()]))
  const tally = (what, a, b) => { same[what].n++; if (a === b) same[what].agree++ }
  const review = { jev: { accept: 0, second_review: 0, human: 0, retry: 0, belowAcceptBar: 0 }, laya: { accept: 0, second_review: 0, human: 0, retry: 0, belowAcceptBar: 0 } }
  // What each would have done at its own bars needs both sides' bars.
  const bars = !!(T.jev && T.laya)
  for (const row of rows) {
    const j = (n) => answerIn(row, 'jev', n)
    const l = (n) => answerIn(row, 'laya', n)
    if (row.phase === 'route') {
      for (const [what, name] of [['task_type', 'taskType'], ['capability', 'capability'], ['strategy', 'strategy']]) {
        if (j(name) && l(name) && informative(l(name))) tally(what, j(name).answer, l(name).answer)
      }
      if (bars && row.groups?.includes('judgments') && j('secondOpinion') && l('secondOpinion') && informative(l('secondOpinion'))) {
        tally('second_opinion', j('secondOpinion').answer >= T.jev.judgmentYes, l('secondOpinion').answer >= T.laya.judgmentYes)
      }
      if (bars && j('needsTests') && l('needsTests')) tally('checks_required', clears(j('needsTests').answer, T.jev.needsTests), clears(l('needsTests').answer, T.laya.needsTests))
      if (bars && j('capability') && l('capability')) {
        const stops = (a, bar, ok = true) => ok && a.answer === 'human_required' && num(a.confidence) && a.confidence >= bar
        tally('needs_human', stops(j('capability'), T.jev.humanRequired), stops(l('capability'), T.laya.humanRequired, informative(l('capability'))))
      }
    }
    if (row.phase === 'review') {
      const ja = actionOf(row, 'jev', T.jev)
      const la = actionOf(row, 'laya', T.laya)
      for (const [side, r] of [['jev', ja], ['laya', la]]) {
        if (!r) continue
        review[side][r.action]++
        if (r.below) review[side].belowAcceptBar++
      }
      if (ja && la) tally('review_action', ja.action, la.action)
    }
  }
  return {
    wouldHaveActedSame: Object.entries(same).map(([what, c]) => ({ what, n: c.n, same: c.agree })),
    review,
  }
}

/** Coverage: every row by how it ended, and the requests that reached the 512-token context. */
function skipTable(rows) {
  const out = { answered: 0, partial: 0, failed: 0, skipped: Object.fromEntries(SKIPS.map((r) => [r, 0])), atContextLimit: 0 }
  for (const row of rows) {
    if (row?.status === 'answered' || row?.status === 'partial' || row?.status === 'failed') out[row.status]++
    else if (row?.status === 'skipped' && Object.hasOwn(out.skipped, row.reason)) out.skipped[row.reason]++
    if (num(row?.atContextLimit)) out.atContextLimit += row.atContextLimit
  }
  return out
}

function latencyTable(rows) {
  const out = { jev: {}, laya: {} }
  for (const phase of PHASES) {
    const mine = rows.filter((r) => r?.phase === phase)
    out.jev[phase] = median(mine.map((r) => r.jev?.ms))
    out.laya[phase] = median(mine.filter(compared).map((r) => r.ms))
  }
  return out
}

// --- the two readings ----------------------------------------------------------------------------

/** Rows of the current identity, thresholds pair and Jev host, in the period, unless told otherwise. */
function selectRows(rows, { identity, hashes, jevHost, since }) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object'
    && (identity == null || r.identity === identity)
    && (hashes == null || (r.thresholds?.jev === hashes.jev && r.thresholds?.laya === hashes.laya))
    && (jevHost == null || r.jev?.host === jevHost)
    && (since == null || at(r.ts) >= since))
}

const selectLaya = (samples, identity, since) => (Array.isArray(samples) ? samples : []).filter((s) => s && typeof s === 'object'
  && (identity == null || s.provider?.identity === identity) && (since == null || at(s.ts) >= since))

/**
 * Laya's standing per group (6.7): a reading, not an authority. Nothing acts on it and nothing may
 * gate on it; it keeps its sources apart and puts agreement with Jev beside them, never in them.
 * @param {object} p
 * @param {object[]} p.shadowRows   laya-shadow.jsonl rows
 * @param {object[]} [p.jevSamples] routing-samples.jsonl samples, each joined with its newest outcome
 * @param {object[]} [p.layaSamples] laya-samples.jsonl samples, likewise
 * @param {object[]} [p.feedback]   feedback.jsonl rows (their verdicts, run ids, times and keys are all that is read)
 * @param {object[]} [p.history]    history.jsonl records, reduced to runId, attempts and finalStatus
 * @param {string} p.identity       the Laya identity to read (4.5)
 * @param {{ jev: object, laya: object }} p.thresholds  both providers' thresholds, the bars read here
 * @param {string} [p.jevHost]      only rows answered against this Jev server
 * @param {number} [p.now]
 * @returns {object[]} one row per group, in the shape laya-standing.jsonl keeps
 */
export function standing({ shadowRows = [], jevSamples = [], layaSamples = [], feedback = [], history = [], identity, thresholds, jevHost, now = Date.now() } = {}) {
  const T = { jev: barsOf(thresholds?.jev), laya: barsOf(thresholds?.laya) }
  const hashes = thresholds ? { jev: thresholdsHash(thresholds.jev), laya: thresholdsHash(thresholds.laya) } : null
  const rows = selectRows(shadowRows, { identity, hashes, jevHost }).filter(compared)
  const idx = indexOf({ jevSamples, layaSamples: selectLaya(layaSamples, identity), feedback, history })
  const ts = new Date(now).toISOString()
  return GROUPS.map((group) => {
    const f = groupFigures(group, rows, idx, T)
    return {
      ts, identity, domain: group,
      laya: {
        answered: f.answered,
        informativeShare: f.answered ? r2(f.informative / f.answered) : null,
        agreementWithJev: f.agree,
        personSaid: f.personLaya,
        whereJevWasContradicted: f.contradicted,
        layaAutoFailed: { runs: f.layaAuto.runs.size, failed: f.layaAuto.failed?.size ?? null },
        ...(f.fields ? { fieldAgreement: f.fields } : {}),
      },
      jev: { acted: f.jevActed, personSaid: f.personJev },
    }
  })
}

/**
 * The comparison of 8.4, every figure a count so the reader can show `n` beside each rate; a
 * source with no rows is `{ n: 0 }`, never a rate. By default the current identity, thresholds
 * pair and Jev host only, over `days` (7, or 'all').
 * @param {object} p  as standing(), and:
 * @param {number|'all'} [p.days]
 * @param {'current'|'all'} [p.scope]  'all' reads every identity, thresholds pair and Jev host
 */
export function compare({ shadowRows = [], jevSamples = [], layaSamples = [], feedback = [], history = [], identity, thresholds, jevHost, days = 7, scope = 'current', now = Date.now() } = {}) {
  const T = { jev: barsOf(thresholds?.jev), laya: barsOf(thresholds?.laya) }
  const hashes = { jev: thresholdsHash(thresholds?.jev), laya: thresholdsHash(thresholds?.laya) }
  const current = scope !== 'all'
  const since = days === 'all' ? null : now - Number(days) * DAY_MS
  const all = selectRows(shadowRows, { identity: current ? identity : null, hashes: current ? hashes : null, jevHost: current ? jevHost : null, since })
  const rows = all.filter(compared)
  const idx = indexOf({ jevSamples, layaSamples: selectLaya(layaSamples, current ? identity : null, since), feedback, history })
  const domains = GROUPS.map((group) => {
    const f = groupFigures(group, rows, idx, T)
    return {
      domain: group,
      question: DOMAIN_QUESTIONS[group] ?? (group === 'intent' ? 'kind' : null),
      layaAnswered: f.answered,
      agree: f.agree,
      personSaid: f.paired.n ? f.paired : { n: 0 },
      whereJevWasContradicted: f.contradicted.n ? { n: f.contradicted.n, layaRight: f.contradicted.right } : { n: 0 },
      layaAutoRuns: f.layaAuto.runs.size ? { runs: f.layaAuto.runs.size, failed: f.layaAuto.failed?.size ?? null } : { n: 0 },
      fieldAgreement: f.fields,
    }
  })
  return {
    identity: current ? identity : 'all',
    thresholds: hashes,
    jevHost: current ? jevHost : 'all',
    days,
    questions: questionTable(rows, T),
    domains,
    actions: actionTable(rows, T),
    skips: skipTable(all),
    latency: latencyTable(all),
    standing: standing({ shadowRows, jevSamples, layaSamples, feedback, history, identity, thresholds, jevHost: current ? jevHost : undefined, now }),
  }
}
