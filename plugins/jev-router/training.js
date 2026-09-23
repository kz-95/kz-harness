// The training store: every routing decision as a sample, and what the run later proved.
//
// Two row kinds share one append-only JSONL. A sample row is written at decision time and holds
// the feature vectors, the teacher's answer, the local classifier's answer and who was
// authoritative. An outcome row is appended after the run finishes and carries only the sample
// id and the label the run justified; `list()` joins the newest outcome onto its sample. Nothing
// is ever rewritten, so a crash can only truncate the line being written, and the reader drops
// that line the way feedback.js drops its own.
//
// `labelFromRun` is where a finished run becomes a label, and it is deliberately conservative:
// Jev's pick is confirmed only when that pick did the accepted work, and a rescue by another
// resource labels the rescuer, never the pick. A run that gives no evidence (paused on a usage
// limit, stopped, continued from a handoff) yields null rather than a guess. No row ever holds
// task text, answers, diffs or secrets: ids, numbers, categories and timestamps only.
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { FEATURE_SCHEMA_VERSION, validateFeatures } from './features.js'
import { ROUTING_TAGS } from './feedback.js'
import { DISPOSITIONS, STRATEGIES, tierAtLeast } from './routing-policy.js'

/** Where a label came from, from strongest to weakest evidence. */
export const LABEL_SOURCES = Object.freeze(['verified_outcome', 'human', 'teacher_confirmed', 'verified_negative'])
/** The label sources that count as outcome-backed: the run itself, or a person, said so. */
export const OUTCOME_BACKED = Object.freeze(['verified_outcome', 'teacher_confirmed', 'human'])
/** Who answered the decision the sample records. */
export const AUTHORITIES = Object.freeze(['jev', 'local', 'deterministic', 'fallback'])

const WORK_ROLES = new Set(['primary', 'retry'])
// A label or tag value that belongs to another module's vocabulary, checked when this file loads.
// None of these strings are ours to define: naming them through their own lists means a strategy,
// disposition or tag renamed there fails here loudly, instead of quietly ending the labels.
const known = (name, vocabulary) => {
  if (!(Array.isArray(vocabulary) ? vocabulary.includes(name) : name in vocabulary)) throw new Error(`training: ${name} is not in the routing vocabulary`)
  return name
}
const RESCUE_REVIEW = known('CHEAP_EXECUTE_FRONTIER_REVIEW', STRATEGIES)
const RESCUE_RETRY = known('RETRY_DIFFERENT_RESOURCE', STRATEGIES)
const PASS = known('PASS', DISPOSITIONS)
const RETRY_SAME_TIER = known('RETRY_SAME_TIER', DISPOSITIONS)
const RETRY_OTHER = known('RETRY_DIFFERENT_RESOURCE', DISPOSITIONS)
const HUMAN = known('HUMAN', DISPOSITIONS)
// Feedback tags that say the task was understood wrongly, which is the classifier's mistake, and
// the one that says the pick was right.
const MISREAD_TAGS = new Set([known('misread my question', ROUTING_TAGS), known('wrong scope', ROUTING_TAGS)])
const GOOD_PICK = known('good pick', ROUTING_TAGS)
// Strictly stronger, through routing-policy's own tier ordering rather than a second copy of it:
// a peer of the same tier is no escalation, and an unknown tier is never stronger than anything.
const strongerTier = (a, b) => tierAtLeast(a, b) && !tierAtLeast(b, a)
const isOutcomeRow = (r) => r && typeof r === 'object' && typeof r.id === 'string' && 'outcomeTs' in r
const isSampleRow = (r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.domain === 'string' && !('outcomeTs' in r)
const at = (ts) => { const t = Date.parse(ts); return Number.isNaN(t) ? 0 : t }

/**
 * A validated, id-stamped sample row from what the decision engine hands over. Throws on a row
 * that could not be trained on (no domain, no input features), because a malformed sample on
 * disk is a malformed sample in every artifact after it.
 */
export function normalizeSample(sample, { now }) {
  if (!sample || typeof sample !== 'object') throw new Error('training sample: an object is required')
  if (typeof sample.domain !== 'string' || !sample.domain) throw new Error('training sample: domain is required')
  if (!sample.input || typeof sample.input !== 'object' || !sample.input.features) throw new Error('training sample: input.features is required')
  // features.js decides what a well formed vector is, here as everywhere: a NaN numeric or a
  // non-string category refused now is one that cannot quietly poison every artifact after it.
  validateFeatures(sample.input.features)
  for (const c of Array.isArray(sample.input.candidates) ? sample.input.candidates : []) validateFeatures(c?.features ?? {})
  const { id, ts, runId, domain, input, teacher, local, authority, extra } = sample
  return {
    id: typeof id === 'string' && id ? id : randomUUID(),
    ts: typeof ts === 'string' && ts ? ts : now(),
    runId: runId ?? null,
    domain,
    // The store stamps the schema version, not the caller: an artifact must refuse a sample whose
    // features were built under a different schema, and that only works when the stamp is honest.
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    input,
    teacher: teacher ?? null,
    local: local ?? null,
    authority: AUTHORITIES.includes(authority) ? authority : 'fallback',
    outcome: null,
    ...(extra && typeof extra === 'object' ? { extra } : {}),
  }
}

/**
 * @param {object} p
 * @param {string} p.file        routing-samples.jsonl
 * @param {() => string} [p.now] the clock, ISO, injectable so a test can order rows
 */
export function createTrainingStore({ file, now = () => new Date().toISOString() }) {
  const samples = new Map() // id -> sample row, in file order
  const outcomes = new Map() // id -> newest outcome row
  let loading = null

  // Same tolerant read as feedback.js: a line that does not parse is dropped, which is what a
  // write cut off by a crash looks like, and a missing file is empty rather than an error.
  const rows = async () => {
    const raw = await readFile(file, 'utf8').catch(() => '')
    const out = []
    for (const l of raw.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(l)) } catch { /* a truncated final line */ }
    }
    return out
  }
  const remember = (r) => {
    if (isOutcomeRow(r)) {
      // Later rows win: the file is appended in time order, and a re-resolved outcome replaces.
      const prev = outcomes.get(r.id)
      if (!prev || at(r.outcomeTs) >= at(prev.outcomeTs)) outcomes.set(r.id, r)
    } else if (isSampleRow(r)) samples.set(r.id, r)
  }
  const ready = () => {
    if (!loading) loading = rows().then((list) => { samples.clear(); outcomes.clear(); for (const r of list) remember(r) })
    return loading
  }
  const write = async (row) => {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(row)}\n`)
    remember(row)
    return row
  }
  const join = (s) => {
    const o = outcomes.get(s.id)
    return o ? { ...s, outcome: o.outcome ?? null, outcomeTs: o.outcomeTs } : { ...s, outcome: null }
  }
  const verifiedOf = (r) => r.outcome?.verified === true

  const api = {
    /** Read the file into memory, replacing what was there. Returns the counts found. */
    async load() {
      loading = null
      await ready()
      return { samples: samples.size, outcomes: outcomes.size }
    },
    /**
     * Append one sample. Assigns an id when the caller gave none, stamps the feature schema
     * version and the time, and returns the stored row. Never rewrites.
     */
    async append(sample) {
      await ready()
      return write(normalizeSample(sample, { now }))
    },
    /** Append an outcome for a sample id. The newest outcome for an id is the one read back. */
    async resolveOutcome(id, outcome) {
      await ready()
      if (typeof id !== 'string' || !id) throw new Error('training outcome: a sample id is required')
      if (!outcome || typeof outcome !== 'object') throw new Error('training outcome: an outcome object is required')
      return write({ id, outcomeTs: now(), outcome })
    },
    /** One sample joined with its newest outcome, or null when the id is unknown. */
    async get(id) {
      await ready()
      const s = samples.get(id)
      return s ? join(s) : null
    },
    /**
     * Samples joined with their newest outcome, oldest first and newest last. `domain` filters
     * to one routing domain, `verifiedOnly` keeps rows whose outcome is verified, `since` (ISO or
     * ms) drops samples older than it.
     */
    async list({ domain, verifiedOnly = false, since } = {}) {
      await ready()
      const floor = since == null ? null : typeof since === 'number' ? since : at(since)
      const out = []
      let i = 0
      for (const s of samples.values()) {
        i++
        if (domain && s.domain !== domain) continue
        if (floor != null && at(s.ts) < floor) continue
        const r = join(s)
        if (verifiedOnly && !verifiedOf(r)) continue
        out.push([r, i])
      }
      // Stable by timestamp; a row with no readable ts keeps its file position.
      return out.sort((a, b) => at(a[0].ts) - at(b[0].ts) || a[1] - b[1]).map(([r]) => r)
    },
    /**
     * Counts for one domain (or all when omitted): how many samples, how many verified, how many
     * of those the run or a person backed, how many still rest on the teacher alone, and how
     * often the local classifier agreed with the teacher where both answered (the shadow
     * comparison). `agree` is a count; divide by `n` for the rate.
     */
    async stats(domain) {
      const list = await api.list({ domain })
      const out = {
        total: list.length, verified: 0, outcomeBacked: 0, teacherOnly: 0,
        byLabel: {}, byLabelSource: {}, byAuthority: {}, localAgreement: { n: 0, agree: 0 },
      }
      const bump = (map, key) => { if (key != null) map[key] = (map[key] ?? 0) + 1 }
      for (const r of list) {
        bump(out.byAuthority, r.authority)
        if (verifiedOf(r)) {
          out.verified++
          if (OUTCOME_BACKED.includes(r.outcome.labelSource)) out.outcomeBacked++
          bump(out.byLabelSource, r.outcome.labelSource)
        } else out.teacherOnly++
        bump(out.byLabel, labelOf(r.outcome) ?? labelOf(r.teacher) ?? labelOf(r.local))
        if (r.teacher && r.local) {
          const t = labelOf(r.teacher); const l = labelOf(r.local)
          if (t != null && l != null) { out.localAgreement.n++; if (t === l) out.localAgreement.agree++ }
        }
      }
      return out
    },
  }
  return api
}

/** The label a prediction or outcome carries, whatever the domain calls it. */
const labelOf = (p) => (p ? (p.label ?? p.chosenKey ?? null) : null)

/**
 * The answer the run actually acted on: the local one when the local classifier had authority,
 * otherwise the teacher's. It is the pick a label confirms or contradicts. A local answer under
 * any other authority is shadow data that never ran, and a fallback or deterministic pick the
 * sample does not record is nothing the run can confirm, so both yield no pick and no label.
 */
const pickOf = (sample) => (sample?.authority === 'local' ? sample.local ?? null : sample?.teacher ?? null)

/**
 * A run that went as planned only confirms a pick somebody else made. Under local authority the
 * pick is the classifier's own, so "it worked" is the classifier agreeing with itself: training on
 * it closes the loop, and the label would name a teacher that was never asked. Evidence that
 * contradicts the pick - a rescue, a negative outcome, a person's tag - is real either way and
 * still gets through; only the agreeing label is dropped.
 */
const confirms = (sample, outcome) => (sample?.authority === 'local' ? null : outcome)

const attemptsOf = (record) => (Array.isArray(record?.attempts) ? record.attempts : [])
const workAttempts = (record) => attemptsOf(record).filter((a) => a && WORK_ROLES.has(a.role) && !a.limitHit)
const accepted = (record) => String(record.finalStatus ?? '').startsWith('accepted') || record.finalStatus === 'answered'
const noEvidence = (record) => record.finalStatus === 'paused_limit' || record.finalStatus === 'stopped' || !!record.continuedFromHandoff
const details = (record) => {
  const attempts = attemptsOf(record)
  return {
    finalStatus: record.finalStatus ?? null,
    attempts: attempts.length,
    // Escalated: the run needed more than its first planned work attempt.
    escalated: attempts.some((a) => a && (a.role === 'retry' || a.role === 'review')) || record.finalStatus === 'needs_human',
  }
}
const candidateLookup = (sample) => {
  const list = Array.isArray(sample?.input?.candidates) ? sample.input.candidates : []
  // A strategy or yes/no sample has no candidate features to rank, so the decision engine records
  // only the tier of each resource beside it (extra.candidates: { id, key, tier }). The rescue
  // rule needs nothing more, and without it that rule could never fire for those domains.
  const tiers = Array.isArray(sample?.extra?.candidates) ? sample.extra.candidates : []
  const tierOf = (id) => {
    const t = list.find((c) => c.id === id)?.features?.categorical?.tier ?? tiers.find((c) => c?.id === id)?.tier
    return typeof t === 'string' ? t : null
  }
  return {
    idOf: (key) => list.find((c) => c.key === key)?.id ?? null,
    keyOf: (id) => list.find((c) => c.id === id)?.key ?? null,
    tierOf,
    any: list.length > 0,
  }
}

// When a timestamp is, in ms; NaN for anything unreadable, which every comparison below refuses.
const whenOf = (ts) => (typeof ts === 'string' ? Date.parse(ts) : NaN)

/**
 * The feedback rows about this run. By runId when the verdict carries one. Otherwise by session,
 * and only when the verdict was given after this run's answer existed (record.ts is written when
 * the run ends) and before `until`, the next run in the session when the caller knows it: a
 * verdict is about the last run of the session that ended at or before it. Without the time rule
 * every run of the session with the same last agent matched every verdict in it, so one Like
 * labelled many runs. The time rule is the one profiles.js verdictIsAbout applies to capability
 * evidence (not exported there, so restated here). One difference, kept on purpose: a session
 * verdict that names no agent still counts, because a routing label credits no agent, while one
 * that names an agent must name the one that answered last.
 */
const feedbackFor = (record, feedback, lastAgent, until) => (Array.isArray(feedback) ? feedback : []).filter((f) => {
  if (!f || typeof f !== 'object') return false
  if (f.runId) return f.runId === record.runId
  if (!record.sessionId || f.sessionId !== record.sessionId) return false
  if (f.provider && f.provider !== lastAgent) return false
  const given = whenOf(f.ts); const ended = whenOf(record.ts)
  if (!(given >= ended)) return false
  return until === undefined || until === null || given < whenOf(until)
})

function labelResourceSelection(sample, record) {
  const pick = pickOf(sample)
  const key = pick?.chosenKey
  const cands = candidateLookup(sample)
  if (!key || !cands.any) return null
  const pickId = cands.idOf(key)
  const work = workAttempts(record)
  const last = work.at(-1)
  const base = { verified: true, details: details(record) }
  // Checked before the status, not after it: a run continued from a handoff, paused on a usage
  // limit or stopped by the person can still be filed as accepted, and none of those three say
  // anything about this pick. The status only means something once the run really ran.
  if (noEvidence(record)) return null
  if (accepted(record)) {
    if (!last) return null
    if (last.agent === pickId) return confirms(sample, { chosenKey: key, labelSource: 'teacher_confirmed', ...base })
    const rescuer = cands.keyOf(last.agent)
    // The rescuer is the label; the pick becomes the negative. A rescuer outside the candidate
    // table still proves the pick wrong, but names nobody the classifier could have chosen.
    if (rescuer) return { chosenKey: rescuer, labelSource: 'verified_outcome', negativeKey: key, ...base }
    return work.some((a) => a.agent === pickId) ? { chosenKey: null, negativeKey: key, labelSource: 'verified_negative', ...base } : null
  }
  if (record.finalStatus === 'needs_human' || record.finalStatus === 'limit_reached') return { chosenKey: null, negativeKey: key, labelSource: 'verified_negative', ...base }
  const mine = work.filter((a) => a.agent === pickId)
  const nothingSucceeded = !work.some((a) => a.stopReason === 'completed')
  if (mine.length && mine.every((a) => a.stopReason !== 'completed') && nothingSucceeded) return { chosenKey: null, negativeKey: key, labelSource: 'verified_negative', ...base }
  return null
}

function labelClassification(sample, record, feedback, until) {
  const pick = pickOf(sample)
  const label = pick?.label
  if (label == null) return null
  const base = { verified: true, details: details(record) }
  const rows = feedbackFor(record, feedback, workAttempts(record).at(-1)?.agent, until)
  if (rows.some((f) => MISREAD_TAGS.has(f.tag))) return { label: null, negativeLabel: label, labelSource: 'human', ...base }
  // An explicit routing tag only: a plain thumbs-up is about the answer, not about who was picked.
  if (rows.some((f) => f.tag === GOOD_PICK)) return { label, labelSource: 'human', ...base }
  if (noEvidence(record)) return null
  if (accepted(record)) return confirms(sample, { label, labelSource: 'teacher_confirmed', ...base })
  return null
}

/**
 * Did a stronger resource rescue the run outside the plan? Only meaningful for a *_DIRECT
 * strategy, which planned no second resource. Returns the strategy that would have covered it.
 */
function unplannedRescue(sample, record) {
  const strategy = String(record.strategy ?? record.plan?.strategy ?? '')
  if (!strategy.endsWith('_DIRECT')) return null
  const attempts = attemptsOf(record).filter((a) => a && !a.limitHit)
  const first = attempts.find((a) => WORK_ROLES.has(a.role))
  if (!first) return null
  const cands = candidateLookup(sample)
  const stronger = (a) => strongerTier(cands.tierOf(a.agent), cands.tierOf(first.agent))
  const lastWork = attempts.filter((a) => WORK_ROLES.has(a.role)).at(-1)
  if (lastWork && lastWork.agent !== first.agent && lastWork.role === 'retry' && stronger(lastWork)) return RESCUE_RETRY
  // A review the plan forced, by the reviewer the plan named, is the design working, not a rescue.
  // It is exactly how a conserved frontier resource comes back into a run (frontier escalation
  // asks it to review the cheaper resource's work), so counting it would teach conservation it
  // was wrong on every accepted run that went as planned. A retry is never planned this way: a
  // stronger resource having to take the work over is still a rescue.
  const planned = (a) => record.plan?.forceReview === true && a.agent === record.plan?.reviewer
  if (attempts.some((a) => a.role === 'review' && a.agent !== first.agent && a.stopReason === 'completed' && stronger(a) && !planned(a))) return RESCUE_REVIEW
  return null
}

function labelStrategy(domain, sample, record) {
  const pick = pickOf(sample)
  const label = pick?.label
  if (label == null) return null
  const base = { verified: true, details: details(record) }
  if (noEvidence(record)) return null
  if (record.finalStatus === 'needs_human' || record.finalStatus === 'limit_reached') return { label: null, negativeLabel: label, labelSource: 'verified_negative', ...base }
  if (!accepted(record)) return null
  const rescue = unplannedRescue(sample, record)
  if (rescue) {
    // The yes/no domains answer "should more have been planned"; a rescue says yes. Conservation
    // asks the opposite question, "should the strongest resource have been spared", so a stronger
    // resource having to rescue the run says conserving it was wrong.
    const covering = domain === 'execution_strategy' ? rescue : domain === 'conservation' ? 'no' : 'yes'
    if (covering !== label) return { label: covering, negativeLabel: label, labelSource: 'verified_outcome', ...base }
  }
  return confirms(sample, { label, labelSource: 'teacher_confirmed', ...base })
}

function labelDisposition(sample, record) {
  const pick = pickOf(sample)
  const label = pick?.label
  const decidedAt = sample?.extra?.decidedAt
  if (label == null || !Number.isInteger(decidedAt)) return null
  const attempts = attemptsOf(record)
  const decided = attempts[decidedAt]
  if (!decided) return null
  const base = { verified: true, details: details(record) }
  if (noEvidence(record)) return null
  const later = attempts.slice(decidedAt + 1).filter((a) => a && WORK_ROLES.has(a.role) && !a.limitHit)
  let needed = null
  if (record.finalStatus === 'needs_human') needed = HUMAN
  else if (later.length) needed = later[0].agent === decided.agent ? RETRY_SAME_TIER : RETRY_OTHER
  else if (accepted(record)) needed = PASS
  if (!needed) return null
  return needed === label ? confirms(sample, { label, labelSource: 'teacher_confirmed', ...base }) : { label: needed, negativeLabel: label, labelSource: 'verified_outcome', ...base }
}

/**
 * The outcome a finished run justifies for one sample, or null when the run gives no evidence.
 * The rules are per domain (see the file header): a pick that did the accepted work is
 * confirmed, a rescue by another resource or strategy becomes the label with the pick as the
 * negative, a run handed to a person is a verified negative for the pick, and a run paused on a
 * usage limit, stopped, or continued from a handoff proves nothing. The result always carries
 * `details: { finalStatus, attempts, escalated }` and never any text.
 * @param {string} domain   a routing domain id
 * @param {object} sample   the stored sample row
 * @param {object} record   the history.jsonl record of the run
 * @param {{ feedback?: object[], until?: string }} [deps] feedback rows (feedback.js shape), and
 *   the end of the next run in the same session when the caller knows it (see feedbackFor)
 */
export function labelFromRun(domain, sample, record, { feedback = [], until } = {}) {
  if (!sample || !record || typeof record !== 'object') return null
  switch (domain) {
    case 'resource_selection': return labelResourceSelection(sample, record)
    case 'task_classification':
    case 'skill_selection': return labelClassification(sample, record, feedback, until)
    case 'execution_strategy':
    case 'conservation':
    case 'second_opinion':
    case 'frontier_escalation': return labelStrategy(domain, sample, record)
    case 'outcome_disposition': return labelDisposition(sample, record)
    default: return null
  }
}

/**
 * Label every sample of a finished run and append the outcome rows. `samplesForRun` may be
 * stored rows or the `{ domain, id }` references the decision engine keeps; a reference is
 * looked up in the store. Returns the outcomes appended, one entry per sample that got one.
 * @param {object} store       a training store
 * @param {object} record      the history.jsonl record of the run
 * @param {object[]} samplesForRun
 * @param {{ feedback?: object[], until?: string }} [deps]
 */
export async function attachOutcomes(store, record, samplesForRun = [], { feedback = [], until } = {}) {
  const out = []
  for (const ref of Array.isArray(samplesForRun) ? samplesForRun : []) {
    if (!ref?.id) continue
    const sample = ref.input ? ref : await store.get(ref.id)
    if (!sample) continue
    const domain = ref.domain ?? sample.domain
    const outcome = labelFromRun(domain, sample, record, { feedback, until })
    if (!outcome) continue
    await store.resolveOutcome(sample.id, outcome)
    out.push({ id: sample.id, domain, outcome })
  }
  return out
}
