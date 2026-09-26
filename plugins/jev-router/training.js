// The training store: every routing decision as a sample, and what the run later proved.
//
// Two row kinds share one JSONL. A sample row is written at decision time and holds the feature
// vectors, the teacher's answer, the local classifier's answer and who was authoritative. An
// outcome row is appended after the run finishes and carries only the sample id and the label
// the run justified; `list()` joins the newest outcome onto its sample. Every routed run adds a
// sample per domain and most of them an outcome, so the file is capped (samplesCap): once it has
// grown a slack past what the cap keeps, it is rewritten whole to a temporary file that is then
// renamed over it. A crash therefore leaves one complete file or the other, and otherwise can
// only truncate the line being appended, which the reader drops the way feedback.js drops its
// own. A rewritten file starts with a third kind of row, the count of what the cap let go of.
//
// `labelFromRun` is where a finished run becomes a label, and it is deliberately conservative:
// Jev's pick is confirmed only when that pick did the accepted work, and a rescue by another
// resource labels the rescuer, never the pick. A run that gives no evidence (paused on a usage
// limit, stopped, continued from a handoff) yields null rather than a guess. No row ever holds
// task text, answers, diffs or secrets: ids, numbers, categories and timestamps only.
//
// A store has a kind (docs/laya-auto.md 6.1). The `jev` store, routing-samples.jsonl, holds what
// Jev Auto decided and is what the local classifiers learn from; the `laya` store,
// laya-samples.jsonl, holds every decision of a run Laya decided, and no classifier reads it.
// The two are kept apart by the stores themselves: the Jev store refuses a Laya row outright,
// because the ladders roll back on the failure rates of their own store, and a Laya run's
// failures there would demote classifiers that decided none of those runs.
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { FEATURE_SCHEMA_VERSION, validateFeatures } from './features.js'
import { ROUTING_TAGS } from './feedback.js'
import { TEACHER } from './providers.js'
import { DISPOSITIONS, STRATEGIES, resolvePolicy, tierAtLeast } from './routing-policy.js'

/** Where a label came from, from strongest to weakest evidence. */
export const LABEL_SOURCES = Object.freeze(['verified_outcome', 'human', 'teacher_confirmed', 'verified_negative'])
/** The label sources that count as outcome-backed: the run itself, or a person, said so. */
export const OUTCOME_BACKED = Object.freeze(['verified_outcome', 'teacher_confirmed', 'human'])
/** Who answered the decision a sample in the Jev store records. */
export const AUTHORITIES = Object.freeze(['jev', 'local', 'code', 'deterministic', 'fallback'])
/** Who may answer a decision in any store: Jev's list, and the provider that decided a Laya run. */
export const ALL_AUTHORITIES = Object.freeze(['jev', 'laya', 'local', 'code', 'deterministic', 'fallback'])
/**
 * The authorities each kind of store records. A Laya run is decided by Laya or by a rule, never by
 * Jev and never by a local classifier: the owner decided that Laya decides, and a classifier Jev
 * taught deciding would put Jev's teaching back into it.
 */
export const STORE_AUTHORITIES = Object.freeze({ jev: AUTHORITIES, laya: Object.freeze(['laya', 'code', 'deterministic', 'fallback']) })
/** The kinds of store, each its own file. */
export const STORE_KINDS = Object.freeze(Object.keys(STORE_AUTHORITIES))

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
// The count a compaction writes at the top of the file. It has no id, so a reader from before the
// cap skips it as a row it does not know.
const isDroppedRow = (r) => r && typeof r === 'object' && !('id' in r) && r.dropped && typeof r.dropped === 'object'
const tally = (v) => (Number.isInteger(v) && v > 0 ? v : 0)
const at = (ts) => { const t = Date.parse(ts); return Number.isNaN(t) ? 0 : t }
// Rows as JSONL, a thousand lines at a time, so a file at the cap is never built as one string.
function* jsonl(rows) {
  for (let i = 0; i < rows.length; i += 1000) yield rows.slice(i, i + 1000).map((r) => `${JSON.stringify(r)}\n`).join('')
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' && v ? v : null)

/**
 * What a provider that is not the teacher answered, as a Laya sample keeps it: its pick, its
 * probabilities and confidence, whether it was informative enough to act on, and which model,
 * identity and script answered. Only these fields are kept, so a caller cannot store a text by
 * handing over more; a field that is not what it should be refuses the row.
 */
function providerAnswer(p) {
  if (p === null || p === undefined) return null
  if (!isObject(p) || !str(p.id) || p.id === TEACHER) throw new Error(`training sample: provider must be { id, label | chosenKey, ... } naming a provider that is not ${TEACHER}`)
  if (p.probabilities !== undefined && !isObject(p.probabilities)) throw new Error('training sample: provider.probabilities must be an object')
  if (p.confidence !== undefined && !(typeof p.confidence === 'number' && Number.isFinite(p.confidence))) throw new Error('training sample: provider.confidence must be a number')
  return {
    id: p.id,
    label: str(p.label),
    chosenKey: str(p.chosenKey),
    probabilities: Object.fromEntries(Object.entries(p.probabilities ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))),
    confidence: p.confidence ?? 0,
    informative: p.informative !== false,
    model: str(p.model),
    identity: str(p.identity),
    lang: str(p.lang),
  }
}

/**
 * A validated, id-stamped sample row from what the decision engine hands over. Throws on a row
 * that could not be trained on (no domain, no input features), because a malformed sample on
 * disk is a malformed sample in every artifact after it.
 *
 * `kind` is the store's (docs/laya-auto.md 6.2). The Jev store throws on a Laya row, an authority
 * `laya` or any `provider` field: that is a programming error, which the integrity tests prove
 * never happens, and the domain controller logs if it ever does. The Laya store throws on a
 * teacher, because Laya is never one, and keeps the provider's answer. An authority the store does
 * not know is read as `fallback` in either, as it always was, so an old row reads unchanged.
 */
export function normalizeSample(sample, { now, kind = 'jev' }) {
  if (!STORE_KINDS.includes(kind)) throw new Error(`training sample: unknown store kind ${kind}`)
  if (!sample || typeof sample !== 'object') throw new Error('training sample: an object is required')
  if (typeof sample.domain !== 'string' || !sample.domain) throw new Error('training sample: domain is required')
  if (!sample.input || typeof sample.input !== 'object' || !sample.input.features) throw new Error('training sample: input.features is required')
  if (kind === 'jev' && (sample.authority === 'laya' || sample.provider !== undefined)) throw new Error('training: a laya sample was refused by the jev store')
  if (kind !== 'jev' && sample.teacher !== undefined && sample.teacher !== null) throw new Error(`training: a sample with a teacher was refused by the ${kind} store`)
  // features.js decides what a well formed vector is, here as everywhere: a NaN numeric or a
  // non-string category refused now is one that cannot quietly poison every artifact after it.
  validateFeatures(sample.input.features)
  for (const c of Array.isArray(sample.input.candidates) ? sample.input.candidates : []) validateFeatures(c?.features ?? {})
  const { id, ts, runId, domain, input, teacher, local, code, authority, extra } = sample
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
    code: code ?? null,
    authority: STORE_AUTHORITIES[kind].includes(authority) ? authority : 'fallback',
    // The Jev sample's shape is unchanged: only a Laya row has the field at all.
    ...(kind === 'jev' ? {} : { provider: providerAnswer(sample.provider) }),
    outcome: null,
    ...(extra && typeof extra === 'object' ? { extra } : {}),
  }
}

/**
 * How far above the most demanding gate's need the cap sits. The holdout is carved from the
 * verified rows the classifier can learn from, and a verified row can be one it cannot: a
 * verified negative says what the answer was not and carries no label. A quarter on top lets a
 * fifth of the kept verified rows be like that before the holdout gate could starve.
 */
const CAP_HEADROOM = 1.25

/**
 * How many samples of each domain the store keeps: its newest this many, and its newest this
 * many verified ones (see `kept` in createTrainingStore). Derived from the policy so that it can
 * never starve a gate: the largest verified-row need of any risk class, with CAP_HEADROOM on top.
 * A class needs its LOCAL_ONLY sample gate, and enough rows for the time-aware split to hold out
 * its holdout gate; the holdout is carved from those same rows, not added to them. With the
 * shipped gates HIGH asks the most: 6000 verified samples, and a holdout of 1200, which a 15%
 * holdout share only yields from 8000. 8000 and a quarter is 10000. A gate raised in config
 * raises the cap with it. A split that holds nothing out has the holdout gate scored on its
 * validation slice instead (measure() in domains.js), so that share is the one that carves it; a
 * split with neither has nothing to score that gate on at any size, and only the sample gate
 * counts. Either way the cap stays finite.
 * @param {object} [policy] resolvePolicy() result
 */
export function samplesCap(policy = resolvePolicy()) {
  const share = policy.split.holdout > 0 ? policy.split.holdout : policy.split.validation
  let need = 0
  for (const g of Object.values(policy.gates ?? {})) {
    const heldOut = g.holdoutSamples > 0 && share > 0 ? Math.ceil(g.holdoutSamples / share) : 0
    need = Math.max(need, g.localOnlySamples, heldOut)
  }
  return Math.ceil(need * CAP_HEADROOM)
}

/**
 * @param {object} p
 * @param {string} p.file          routing-samples.jsonl, or laya-samples.jsonl for a `laya` store
 * @param {'jev'|'laya'} [p.kind]  which runs the store holds (see normalizeSample); `jev` by default.
 *   Both kinds keep the same cap and compaction
 * @param {() => string} [p.now]   the clock, ISO, injectable so a test can order rows
 * @param {object} [p.policy]      resolvePolicy() result, which the cap is derived from
 * @param {number} [p.cap]         samples kept per domain; samplesCap(policy) when not given
 * @param {number} [p.slack]       how many rows past what the cap keeps the file may grow before
 *   it is rewritten. One cap's worth by default. At the cap the file holds, for each of seven
 *   domains, about a cap's worth of samples and as many outcome rows, so that is about a
 *   sixteenth of it, and with some sixteen rows to a routed run a rewrite comes every six hundred
 *   or so runs, never on every append.
 * @param {(m: string) => void} [p.log]
 */
export function createTrainingStore({ file, kind = 'jev', now = () => new Date().toISOString(), policy, cap = samplesCap(policy), slack = cap, log = () => {} }) {
  if (!STORE_KINDS.includes(kind)) throw new Error(`training store: kind must be one of ${STORE_KINDS.join(', ')}`)
  // A cap of 0 would drop every sample, and a slack of 0 rewrite the file on every append.
  if (!(cap >= 1) || !(slack >= 1)) throw new Error('training store: cap and slack must each be at least 1')
  const samples = new Map() // id -> sample row, in file order
  const outcomes = new Map() // id -> newest outcome row
  // domain -> { samples, verified }: how many the cap has let go of, ever. Once a domain is at
  // the cap its verified count stops growing, so this is the part of the history that says how
  // much evidence the domain has seen rather than how much it still holds, and the domains count
  // new evidence on it. Lost for good if not counted when the rows go, so it is written into
  // every rewritten file.
  let dropped = new Map()
  let loading = null
  let lines = 0 // rows in the file, as far as this store knows
  let checkedAt = 0 // `lines` when the file was last measured against the cap
  let unread = false // the file exists and could not be read
  let queue = Promise.resolve()

  // Every change to the file goes through here, one at a time. An append that ran while a
  // compaction was between writing its copy and renaming it over the file would land in the file
  // being replaced, and be lost with it.
  const serial = (task) => {
    const run = queue.then(task)
    queue = run.catch(() => {})
    return run
  }

  // Same tolerant read as feedback.js: a line that does not parse is dropped, which is what a
  // write cut off by a crash looks like, and a missing file is empty rather than an error.
  const rows = async () => {
    let raw = ''
    try { raw = await readFile(file, 'utf8') } catch (err) {
      // Any other failure leaves a file this store knows nothing of, and it must never rewrite
      // one: the rewrite would keep only what it knows, which is nothing.
      if (err.code !== 'ENOENT') { unread = true; log(`routing samples not read: ${err.message}`) }
    }
    const out = []
    const all = raw.split('\n').filter(Boolean)
    for (const l of all) {
      try { out.push(JSON.parse(l)) } catch { /* a truncated final line */ }
    }
    return { list: out, lines: all.length }
  }
  const remember = (r) => {
    if (isOutcomeRow(r)) {
      // Later rows win: the file is appended in time order, and a re-resolved outcome replaces.
      const prev = outcomes.get(r.id)
      if (!prev || at(r.outcomeTs) >= at(prev.outcomeTs)) outcomes.set(r.id, r)
    } else if (isSampleRow(r)) samples.set(r.id, r)
    else if (isDroppedRow(r)) {
      // Totals, not increments: each rewrite writes the whole count.
      dropped = new Map(Object.entries(r.dropped).map(([d, c]) => [d, { samples: tally(c?.samples), verified: tally(c?.verified) }]))
    }
  }
  const isVerified = (id) => outcomes.get(id)?.outcome?.verified === true

  /**
   * The samples the cap keeps. In each domain its newest `cap`, whatever became of them, so an
   * outcome or a person's verdict arriving late still finds its sample; and its newest `cap`
   * verified ones, because those are what the gates count. Once a domain holds a local rung, an
   * accepted run under local authority confirms nothing (confirms()), so most new samples stay
   * unverified, and a cap on samples alone would push out exactly the rows the gates need.
   * Newest in the order list() reads them: by time, then by place in the file.
   */
  const kept = () => {
    const byDomain = new Map()
    let i = 0
    for (const s of samples.values()) {
      i++
      if (!byDomain.has(s.domain)) byDomain.set(s.domain, [])
      byDomain.get(s.domain).push([s, i])
    }
    const keep = new Set()
    for (const list of byDomain.values()) {
      list.sort((a, b) => at(b[0].ts) - at(a[0].ts) || b[1] - a[1])
      let verified = 0
      list.forEach(([s], newer) => {
        const v = isVerified(s.id)
        if (newer < cap || (v && verified < cap)) keep.add(s.id)
        if (v) verified++
      })
    }
    return keep
  }

  // What the file holds once the cap is applied: the count of what it let go of, then the kept
  // samples in file order, then the newest outcome of each. An older outcome of a kept sample,
  // and any outcome of a sample not kept, is never read back and goes.
  const compacted = (keep) => {
    const count = new Map([...dropped].map(([d, c]) => [d, { ...c }]))
    const stay = []
    for (const s of samples.values()) {
      if (keep.has(s.id)) { stay.push(s); continue }
      const c = count.get(s.domain) ?? { samples: 0, verified: 0 }
      c.samples++
      if (isVerified(s.id)) c.verified++
      count.set(s.domain, c)
    }
    const out = count.size ? [{ dropped: Object.fromEntries(count) }] : []
    for (const s of stay) out.push(s)
    for (const s of stay) if (outcomes.has(s.id)) out.push(outcomes.get(s.id))
    return { rows: out, count }
  }

  const rewrite = async (list) => {
    const tmp = `${file}.tmp`
    await mkdir(dirname(file), { recursive: true })
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(jsonl(list))
      // On disk before the rename, or a power cut could leave the new name on an empty file.
      await handle.sync()
    } finally { await handle.close() }
    // A reader that has the destination open makes rename fail on Windows with EPERM/EBUSY, as
    // tasks.js found. Retry a few times rather than leave the file at its full size.
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, file); break } catch (err) {
        if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err
        await new Promise((r) => setTimeout(r, 5 * (attempt + 1)))
      }
    }
  }

  /**
   * Apply the cap: memory holds only what the cap keeps from here on, and the file is rewritten
   * to match once it holds `slack` rows more than that. Called on load and after every `slack`
   * appended rows, always inside the queue.
   */
  const fit = async () => {
    checkedAt = lines
    const keep = kept()
    const { rows: list, count } = compacted(keep)
    for (const id of [...samples.keys()]) if (!keep.has(id)) samples.delete(id)
    for (const id of [...outcomes.keys()]) if (!samples.has(id)) outcomes.delete(id)
    dropped = count
    if (unread || lines - list.length < slack) return
    try {
      await rewrite(list)
      lines = checkedAt = list.length
    } catch (err) { log(`routing samples not compacted: ${err.message}`) }
  }

  const ready = () => {
    if (!loading) {
      loading = serial(async () => {
        unread = false
        const read = await rows()
        samples.clear(); outcomes.clear(); dropped = new Map()
        for (const r of read.list) remember(r)
        lines = read.lines
        await fit()
      })
    }
    return loading
  }
  const write = (row) => serial(async () => {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(row)}\n`)
    lines++
    remember(row)
    if (lines - checkedAt >= slack) await fit()
    return row
  })
  const join = (s) => {
    const o = outcomes.get(s.id)
    return o ? { ...s, outcome: o.outcome ?? null, outcomeTs: o.outcomeTs } : { ...s, outcome: null }
  }
  const verifiedOf = (r) => r.outcome?.verified === true

  const api = {
    /** Which runs this store holds: `jev` or `laya`. */
    kind,
    /**
     * Read the file into memory, replacing what was there, and apply the cap to it (rewriting the
     * file when it has grown a slack past it). Returns the counts kept.
     */
    async load() {
      loading = null
      await ready()
      return { samples: samples.size, outcomes: outcomes.size }
    },
    /**
     * Append one sample. Assigns an id when the caller gave none, stamps the feature schema
     * version and the time, and returns the stored row.
     */
    async append(sample) {
      await ready()
      return write(normalizeSample(sample, { now, kind }))
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
     * How many samples of one domain (or of all when omitted) the cap has let go of, and how many
     * of those were verified. Everything else here counts what the store still holds, which stops
     * growing once a domain is at its cap; this is the rest of what the domain has seen. Read from
     * memory as it stands, without waiting for a load, so that read in the same turn as list() it
     * counts the same moment: a load or a compaction changes the rows and this count together, in
     * one synchronous step. Before the first list() or load() it is zero.
     */
    dropped(domain) {
      const gone = domain ? [dropped.get(domain)] : [...dropped.values()]
      return { samples: gone.reduce((n, c) => n + (c?.samples ?? 0), 0), verified: gone.reduce((n, c) => n + (c?.verified ?? 0), 0) }
    },
    /**
     * Counts for one domain (or all when omitted): how many samples, how many verified, how many
     * of those the run or a person backed, how many still rest on the teacher alone, and how
     * often the local classifier agreed with the teacher where both answered (the shadow
     * comparison). `agree` is a count; divide by `n` for the rate. `dropped` is how many samples
     * the cap has let go of, and how many of those were verified (see dropped()): everything else
     * here counts what the store still holds, so this is the only count that keeps growing past
     * the cap.
     */
    async stats(domain) {
      const list = await api.list({ domain })
      const out = {
        total: list.length, verified: 0, outcomeBacked: 0, teacherOnly: 0,
        byLabel: {}, byLabelSource: {}, byAuthority: {}, localAgreement: { n: 0, agree: 0 },
        dropped: api.dropped(domain),
      }
      const bump = (map, key) => { if (key != null) map[key] = (map[key] ?? 0) + 1 }
      for (const r of list) {
        bump(out.byAuthority, r.authority)
        if (verifiedOf(r)) {
          out.verified++
          if (OUTCOME_BACKED.includes(r.outcome.labelSource)) out.outcomeBacked++
          bump(out.byLabelSource, r.outcome.labelSource)
        } else out.teacherOnly++
        bump(out.byLabel, labelOf(r.outcome) ?? labelOf(r.teacher) ?? labelOf(r.provider) ?? labelOf(r.local))
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
 * the rule's own when a rule in code did, the provider's when a provider that is not the teacher
 * (Laya) did, otherwise the teacher's. It is the pick a label confirms or contradicts. A local
 * answer under any other authority is shadow data that never ran, and a fallback or deterministic
 * pick the sample does not record is nothing the run can confirm, so both yield no pick and no
 * label.
 */
const pickOf = (sample) => (sample?.authority === 'local' ? sample.local ?? null
  : sample?.authority === 'code' ? sample.code ?? null
    : sample?.authority === 'laya' ? sample.provider ?? null
      : sample?.teacher ?? null)

/**
 * A run that went as planned only confirms the teacher's pick. Under local authority the pick is
 * the classifier's own, so "it worked" is the classifier agreeing with itself: training on it
 * closes the loop, and the label would name a teacher that was never asked. A rule in code is the
 * same case: an accepted run would teach the classifier to reproduce the rule it is meant to learn
 * past. So is Laya's: the accept that would confirm its pick came from its own review. A fallback
 * or deterministic sample has no pick to confirm. Evidence that contradicts the pick - a rescue, a
 * negative outcome, a person's tag - is real whoever picked and still gets through; only the
 * agreeing label is dropped.
 */
const confirms = (sample, outcome) => (sample?.authority === TEACHER ? outcome : null)

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
  // It is exactly how a conserved frontier resource comes back into a run (the frontier review
  // asks it to review the cheaper resource's work), so counting it would teach the direct strategy
  // it needed a review on every accepted run that went as planned. A retry is never planned this
  // way: a stronger resource having to take the work over is still a rescue.
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
    // The yes/no domains answer "should more have been planned"; a rescue says yes.
    const covering = domain === 'execution_strategy' ? rescue : 'yes'
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
 * `details: { finalStatus, attempts, escalated }` and never any text. A domain that is not a
 * routing domain gets null too, which is what a `conservation` sample an older version left in
 * the store gets: conservation is a hard limit now, with nothing for a run to confirm.
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
