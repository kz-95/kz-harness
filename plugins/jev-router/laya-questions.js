// The Laya wire adapter: KzH's decision questions as Laya's English checkpoint should read them
// (docs/laya-auto.md 4.2, 4.3).
//
// Laya is asked exactly the questions Jev would be asked, built by the unchanged builders in
// jev.js: the same calls, question names, option keys and answer types. Only the rendering
// differs, for the checkpoint's known weaknesses:
//   - every noul gets labels and its own criteria, the workaround Laya's README documents for
//     issue #156 (a confident no on clearly positive input under the default false/true pair);
//   - option texts short enough that Laya's 192-token head never cuts one mid-sentence;
//   - a state view per question group that fits the 512-token row, because the review state as
//     Jev gets it is about 9,200 characters and the checkpoint keeps about 316 state tokens;
//   - one request per view, and for the background comparison chunks of a few questions, so an
//     acting request never waits behind a long one (laya.serve answers one request at a time).
//
// Pure functions, no I/O. The Laya client applies them on the acting path and the shadow path
// alike, so both render identically. Nothing here mutates its input: the questions arrive
// deep-frozen from jev.js and point at its criteria constants, and the shadow is handed the very
// objects a Jev request was built from, so every rendered question, criteria map, label map and
// view is a new object and a rendering can never leak into a later Jev request.

/** Characters of compact JSON a state view may take: about 317 of the row's 512 tokens. */
export const VIEW_LIMIT = 950
/** Estimated head tokens a question may take; Laya's head is 192, and it cuts options past 176. */
export const HEAD_BUDGET = 170
/** Part of the identity (4.5): a change to this rendering is a change to what Laya answers. */
export const ADAPTER_VERSION = 1
/** The one checkpoint KzH asks (4.4); unpinned, laya.serve would route by language. */
export const LAYA_MODEL = 'english'
/** The English checkpoint's context, and the share of it that counts as reaching it (4.2 f). */
const CONTEXT_TOKENS = 512
const AT_LIMIT = 0.97
/** laya.serve refuses a request with more questions than this (413). */
const MAX_ROWS = 64
/** The configuration defaults of `laya` (2.2), used when a caller passes none. */
export const DEFAULT_CORRECTIONS = Object.freeze({ 'choice:11+': 3.27 })
export const DEFAULT_MIN_TOP_MARGIN = 0.1

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

// --- noul labels and criteria (4.2 a) ------------------------------------------------------------

/** What a noul's two options read, instead of Laya's default "false:" and "true:". */
export const NOUL_LABELS = deepFreeze({ true: 'A', false: 'B' })

/**
 * The yes and no of every noul KzH asks, in plain words about the input, so the English
 * checkpoint reads the question rather than a bare true/false pair. `<tool>` stands for the tool
 * id in the per-tool fits question. A noul jev.js gains without an entry here is caught by the
 * tests; at run time it gets a generic pair (GENERIC_NOUL) rather than failing the call.
 */
export const NOUL_TEXT = deepFreeze({
  humanReview: { true: 'yes: a person should inspect the result before it is accepted', false: 'no: passing checks and the review are enough' },
  needsTests: { true: 'yes: tests, type checks, lint or build must pass first', false: 'no: the result can be accepted without checks' },
  secondOpinion: { true: 'yes: a second agent would likely catch mistakes worth the time', false: 'no: a second review would not be worth the time' },
  continueHandoff: { true: 'yes: the task continues the unfinished work in handoff', false: 'no: the task is new work, not that earlier work' },
  '<tool>.fits': { true: 'yes: the <tool> tool does exactly what the task asks', false: 'no: the task needs an AI agent, not the <tool> tool' },
  alsoWork: { true: 'yes: the message also asks for work in the project', false: 'no: the message only needs an answer' },
  addressed: { true: 'yes: the attempt does what the task asked', false: 'no: the attempt does not do what the task asked' },
  complete: { true: 'yes: every part of the task is handled', false: 'no: some part of the task is left undone' },
  unrelatedChanges: { true: 'yes: the diff changes things the task did not ask for', false: 'no: every change in the diff serves the task' },
  regressionRisk: { true: 'yes: the diff could break behavior the task did not touch', false: 'no: the diff is unlikely to break other behavior' },
  needsPerson: { true: 'yes: the attempt asks a question, says it is blocked, or needs a decision only a person can make', false: 'no: the attempt finished or failed on its own' },
})
const GENERIC_NOUL = deepFreeze({ true: 'yes: the answer to the question is yes', false: 'no: the answer to the question is no' })

/** The yes and no texts for a noul by its name, or null when KzH has none for it. */
export function noulText(name) {
  if (Object.hasOwn(NOUL_TEXT, name) && name !== '<tool>.fits') return NOUL_TEXT[name]
  const tool = /^(.+)\.fits$/.exec(String(name))?.[1]
  if (!tool || tool === 'req') return null
  const t = NOUL_TEXT['<tool>.fits']
  return { true: t.true.replaceAll('<tool>', tool), false: t.false.replaceAll('<tool>', tool) }
}

// --- option texts (4.2 b) ------------------------------------------------------------------------

/**
 * Hand-written option texts of at most 8 words (score levels at most 6), keyed by the family a
 * question's options come from. jev.js's own descriptions run to 20 words and the English
 * checkpoint gives the instruction and every option 192 tokens together, so today it cuts
 * `taskType` options to 14 tokens, `skill` to 12 and `capability` to 16, mid-sentence. These say
 * the same in words that fit; the keys, which are what KzH reads back, never change.
 */
export const LAYA_SHORT = deepFreeze({
  taskType: {
    architecture: 'design structure or data flow first',
    implementation: 'write new code to a known need',
    debugging: 'find and fix the cause of a bug',
    review: 'read code or a diff, report problems',
    refactor: 'restructure code, same behavior',
    testing: 'write or repair tests',
    documentation: 'write or update docs',
    investigation: 'find out how or why, report',
    security: 'mainly auth, secrets or vulnerabilities',
    performance: 'mainly speed or memory use',
    simple_change: 'a small mechanical edit, like a typo',
    other: 'none of these fits',
  },
  skill: {
    debugging: 'find and fix wrong behavior',
    implementation: 'write new code',
    refactoring: 'restructure, same behavior',
    architecture: 'design structure and data flow',
    explanation: 'explain how or why',
    review: 'read code, report problems',
    security: 'auth, secrets, vulnerabilities',
    testing: 'write or repair tests',
    frontend: 'user interface and layout',
    backend: 'services, APIs, jobs',
    database: 'schemas, queries, migrations',
    performance: 'speed and memory',
    documentation: 'docs and comments',
    devops: 'build, packaging, deployment',
  },
  capability: {
    quick_answer: 'a short answer or chat, no project',
    reasoned_answer: 'a reasoned answer, no project files',
    ocr: 'read the text in an image',
    image_inspection: 'describe or check an image',
    document_processing: 'read or convert a PDF or spreadsheet',
    web_research: 'find current facts online',
    deterministic_tool: 'an exact job a script does',
    project_read: 'read the project, change nothing',
    project_change: 'change the project: code, tests, build',
    human_required: 'only the person can decide or provide it',
    other: 'nothing here fits',
  },
  tier: {
    standard: 'a mid-range model: routine, clear work',
    strong: 'a strong model: judgment, several files',
    frontier: 'the strongest model: subtle, risky or security work',
  },
  strategy: {
    CHEAP_DIRECT: 'the cheapest does it',
    STANDARD_DIRECT: 'a mid-tier one does it',
    PREMIUM_DIRECT: 'the strongest does it',
    LOCAL_FIRST: 'a local model first',
    CHEAP_THEN_PREMIUM_REVIEW: 'cheap work, strong review',
    PREMIUM_PLAN_CHEAP_EXECUTE: 'strong plan, cheap work',
    CHEAP_EXECUTE_FRONTIER_REVIEW: 'cheap work, strongest reviews',
    PARALLEL_SECOND_OPINION: 'two answer, then compare',
    RETRY_DIFFERENT_RESOURCE: 'retry on another resource',
    FRONTIER_ESCALATION: 'escalate to the strongest',
    HUMAN_ESCALATION: 'stop and ask a person',
  },
  verdict: {
    accept: 'done, and the checks support it',
    second_review: 'plausible, but another agent should review',
    retry: 'incomplete or wrong, another attempt could fix it',
    human: 'a person should decide',
  },
  disposition: {
    PASS: 'done and verified well enough to accept',
    RETRY_SAME_TIER: 'wrong, a similar model could fix it',
    RETRY_DIFFERENT_RESOURCE: 'wrong, a different resource should try',
    SECOND_OPINION: 'plausible but uncertain: get an independent review',
    FRONTIER_REVIEW: 'risky or subtle: the strongest should judge',
    WRONG: 'clearly wrong: the approach must change',
    HUMAN: 'a person must decide',
  },
  kind: {
    task: 'work that reads or changes the project',
    question: 'a question or chat to answer directly',
  },
  depth: {
    everyday: 'small talk or a short, simple answer',
    deep: 'needs careful reasoning or wide knowledge',
  },
  handler: {
    agent: 'an AI coding agent is needed',
  },
  complexity: [
    'trivial: one obvious mechanical edit',
    'small: one or two files, clear',
    'moderate: several files or some judgment',
    'hard: cross-cutting, unclear cause, trade-offs',
    'extreme: ambiguous, many interacting systems',
  ],
  risk: [
    'negligible: no user-visible effect',
    'low: a minor, easily reverted defect',
    'moderate: could break a feature',
    'high: data loss, core flow, outage',
    'critical: security, money or irreversible data',
  ],
  requirement: [
    'not needed at all',
    'marginal: a little helps',
    'useful: noticeably better with strength',
    'important: weakness here likely fails',
    'central: the task is essentially this',
  ],
})

/** Which LAYA_SHORT family a question's options come from, by the question's name. */
function familyOf(name) {
  if (name === 'minimumCapability' || name === 'preferredCapability') return 'tier'
  if (String(name).startsWith('req.')) return 'requirement'
  return ['taskType', 'skill', 'capability', 'strategy', 'verdict', 'disposition', 'kind', 'depth', 'handler', 'complexity', 'risk'].includes(name) ? name : null
}

const words = (text, n) => String(text ?? '').split(/\s+/).filter(Boolean).slice(0, n).join(' ')
const r2 = (x) => Number(x).toFixed(2)
const r4 = (x) => Math.round(x * 1e4) / 1e4

/** A criterion as plain text: `what` for `{ what, not_for }`, since Laya renders an object as JSON. */
function whatOf(v) {
  if (v == null || typeof v === 'string') return v ?? ''
  if (typeof v === 'object' && typeof v.what === 'string') return v.what
  return pyJson(v)
}

/**
 * One anonymous review or retry candidate in eight words: `tier strong, fit 0.72, cost low,
 * reliability 0.80`, from the numbers the review state already carries for its key (jev.js
 * `candidateState`). Each `level` drops the least telling number, so a long candidate list still
 * fits the head: fit first, then cost, then reliability.
 */
export function shortCandidateLine(c, level = 0) {
  if (!c || level >= 4) return ''
  const numbers = c.candidate_for_work !== false || c.tier !== undefined || c.capabilities
  if (!numbers) return 'not a candidate for the work'
  const parts = [`tier ${c.tier ?? 'unknown'}`]
  if (level < 1 && typeof c.task_fit === 'number') parts.push(`fit ${r2(c.task_fit)}`)
  if (level < 2 && c.expected_cost?.class) parts.push(`cost ${c.expected_cost.class}`)
  if (level < 3 && typeof c.reliability?.score === 'number') parts.push(`reliability ${r2(c.reliability.score)}`)
  return `${c.candidate_for_work === false ? 'review only: ' : ''}${parts.join(', ')}`
}

// How much of a text survives at each fitting level. Level 0 is what the design asks for; the
// later ones only apply when a question has so many options that even those overrun the head.
const PERSON_WORDS = [8, 6, 4, 2, 0]
const SHORT_WORDS = [8, 8, 4, 2, 0]
const LEVELS = PERSON_WORDS.length

// The choices whose option texts are the person's own words from config: an agent's description
// (the named pick, and the review picks without a decision record), a tool's description (the
// handler), and a tool parameter's options (`<tool>.<param>`).
const PERSON_WRITTEN = new Set(['agent', 'handler', 'reviewAgent', 'retryAgent'])
const personWritten = (name) => PERSON_WRITTEN.has(name) || String(name).includes('.')

/**
 * The option texts of one choice at one fitting level, keyed as asked: the hand-written text where
 * KzH defines the options, the candidate line for an anonymous review pick, the first words of a
 * person-written text (or of a KzH text that has no hand-written one yet), and otherwise the plain
 * `what`.
 */
function choiceTexts(name, criteria, state, level) {
  const family = LAYA_SHORT[familyOf(name)]
  const candidates = (name === 'reviewAgent' || name === 'retryAgent') && Array.isArray(state?.candidates) ? state.candidates : []
  const out = {}
  for (const [key, v] of Object.entries(criteria)) {
    const short = family && !Array.isArray(family) ? family[key] : undefined
    const candidate = candidates.find((c) => c?.key === key)
    if (short !== undefined) out[key] = words(short, SHORT_WORDS[level])
    else if (candidate) out[key] = shortCandidateLine(candidate, level)
    else if (level > 0 || family || personWritten(name)) out[key] = words(whatOf(v), PERSON_WORDS[level])
    else out[key] = whatOf(v)
  }
  return out
}

/** The level texts of one score at one fitting level. */
function scoreTexts(name, criteria, level) {
  const short = LAYA_SHORT[familyOf(name)]
  const own = Array.isArray(short) && short.length === criteria.length
  return criteria.map((c, i) => words(own ? short[i] : whatOf(c), own ? SHORT_WORDS[level] : PERSON_WORDS[level]))
}

// --- instructions (4.2 c) and the head estimate --------------------------------------------------

/** Python's `json.dumps(v, ensure_ascii=False, separators=(', ', ': '))`, as Laya renders an object. */
function pyJson(v) {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`
  if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ')}}`
  return JSON.stringify(v) ?? 'null'
}

/** The instruction text as Laya reads it: a string as is, anything else as JSON text. */
const instructionText = (ins) => (typeof ins === 'string' ? ins : pyJson(ins ?? null))

/** The option texts exactly as Laya's `render_options` builds them, in its order. */
export function renderOptions(q) {
  const crit = q?.criteria
  if (q?.type === 'choice') {
    const entries = Array.isArray(crit) ? crit.map((k) => [k, null]) : Object.entries(crit ?? {})
    return entries.map(([k, v]) => (v == null || v === '' ? String(k) : `${k}: ${typeof v === 'string' ? v : pyJson(v)}`))
  }
  if (q?.type === 'score') return (Array.isArray(crit) ? crit : []).map((c, i) => `level ${i}: ${typeof c === 'string' ? c : pyJson(c)}`)
  const labels = q?.labels ?? { false: 'false', true: 'true' }
  const text = (v, fallback) => (v == null || v === '' ? fallback : typeof v === 'string' ? v : pyJson(v))
  return [
    `${labels.false}: ${text(crit?.false, 'no, the statement does not hold')}`,
    `${labels.true}: ${text(crit?.true, 'yes, the statement holds')}`,
  ]
}

/** Characters of the head Laya builds for a question: its instruction and every option as rendered. */
export function headChars(q) {
  return instructionText(q?.instructions).length + renderOptions(q).reduce((n, o) => n + o.length, 0)
}

/** Characters of a state as sent: a string as is, anything else as compact JSON. */
export const stateChars = (state) => (typeof state === 'string' ? state.length : (JSON.stringify(state ?? null) ?? '').length)

/** An option's own text, without the key, level or label Laya puts before it. */
function optionTexts(q) {
  const text = (v) => (v == null ? '' : typeof v === 'string' ? v : pyJson(v))
  if (q?.type === 'choice') return Array.isArray(q.criteria) ? [] : Object.values(q.criteria ?? {}).map(text)
  if (q?.type === 'score') return (Array.isArray(q.criteria) ? q.criteria : []).map(text)
  return renderOptions(q).map((o) => o.slice(o.indexOf(': ') + 2))
}

/**
 * Head tokens a question will take, estimated: ceil(chars / 3.6) + 4 per option + 8, where chars
 * are the instruction and the option texts, and the 4 per option cover each option's mask token,
 * its key or label and the separator. Measured with a proxy of the English tokenizer, it runs
 * over the real count for KzH's lower-case keys and under it for the upper-case strategy keys,
 * whose texts are kept shortest for that reason.
 */
export function estimateHeadTokens(q) {
  const chars = instructionText(q?.instructions).length + optionTexts(q).reduce((n, t) => n + t.length, 0)
  return Math.ceil(chars / 3.6) + 4 * renderOptions(q).length + 8
}

/**
 * The input tokens one request will cost, estimated the way 4.5 predicts a call: per question row
 * `min(512, ceil(head chars / 3.6) + ceil(state chars / 3.0))`. The fake Laya counts the same.
 */
export function estimateRequestTokens({ state, questions }) {
  const s = Math.ceil(stateChars(state) / 3.0)
  return Object.values(questions ?? {}).reduce((n, q) => n + Math.min(CONTEXT_TOKENS, Math.ceil(headChars(q) / 3.6) + s), 0)
}

/**
 * An instruction with the state fields it names spelled as its view has them. jev.js words each
 * question for the state Jev gets, and a view renames or leaves out some of those fields, so an
 * unchanged instruction would point the model at a field it never sees (4.1 lets the wording
 * change). `names` is the view's `[as jev.js says it, as the view has it]` list, most specific first.
 */
function reword(ins, names) {
  if (!names?.length) return ins
  const swap = (s) => names.reduce((t, [from, to]) => t.replaceAll(from, to), s)
  if (typeof ins === 'string') return swap(ins)
  if (ins && typeof ins === 'object' && !Array.isArray(ins) && typeof ins.question === 'string') {
    return { ...ins, question: swap(ins.question), ...(typeof ins.focus === 'string' ? { focus: swap(ins.focus) } : {}) }
  }
  return ins
}

/** `{ question, focus }` as its two parts; anything else is one string with no focus. */
function instructionParts(ins) {
  if (ins && typeof ins === 'object' && !Array.isArray(ins) && typeof ins.question === 'string') {
    return { question: ins.question, focus: typeof ins.focus === 'string' && ins.focus ? ins.focus : null }
  }
  return { question: instructionText(ins), focus: null }
}

/**
 * One rendered question with its options at the richest level that fits HEAD_BUDGET (with the bare
 * question), and then the focus added only if it still fits.
 */
function fitted(base, textsAt, ins) {
  const { question, focus } = instructionParts(ins)
  let q
  for (let level = 0; level < LEVELS; level++) {
    q = { ...base, instructions: question, criteria: textsAt(level) }
    if (estimateHeadTokens(q) <= HEAD_BUDGET) break
  }
  if (focus) {
    const withFocus = { ...q, instructions: `${question} ${focus}` }
    if (estimateHeadTokens(withFocus) <= HEAD_BUDGET) q = withFocus
  }
  return q
}

/**
 * One question as Laya is sent it: the same name, type and option keys, new objects throughout,
 * its instruction naming the fields as `names` (the view's) spells them.
 */
function renderQuestion(name, q, state, names) {
  const ins = reword(q?.instructions, names)
  if (q?.type === 'noul') {
    const text = noulText(name) ?? GENERIC_NOUL
    return fitted({ type: 'noul', labels: { ...NOUL_LABELS } }, () => ({ true: text.true, false: text.false }), ins)
  }
  if (q?.type === 'score' && Array.isArray(q.criteria)) {
    return fitted({ type: 'score' }, (level) => scoreTexts(name, q.criteria, level), ins)
  }
  if (q?.type === 'choice' && q.criteria && typeof q.criteria === 'object') {
    // A list of bare labels is Laya's other choice form; keep it as a list, it has no text to cut.
    if (Array.isArray(q.criteria)) return fitted({ type: 'choice' }, () => [...q.criteria], ins)
    return fitted({ type: 'choice' }, (level) => choiceTexts(name, q.criteria, state, level), ins)
  }
  // Not a question KzH builds: sent as it came, as a copy, so nothing downstream shares it.
  return JSON.parse(JSON.stringify(q ?? null))
}

// --- state views (4.2 d) -------------------------------------------------------------------------

// Every clip is measured in characters of the JSON text it becomes, since that is what the view
// limit counts: a quote or a newline costs two.
const unitLength = (c) => (c === 0x22 || c === 0x5c ? 2 : c >= 0x20 ? 1 : [8, 9, 10, 12, 13].includes(c) ? 2 : 6)
const jsonLength = (s) => JSON.stringify(s).length - 2
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff
/** Where the cut marker goes: one character, so a cut costs one. */
const CUT = '…'

/** The longest start of `s` whose JSON text is at most `max` characters. */
function headPart(s, max) {
  let n = 0
  let i = 0
  for (; i < s.length; i++) {
    const w = unitLength(s.charCodeAt(i))
    if (n + w > max) break
    n += w
  }
  if (i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1))) i--
  return s.slice(0, i)
}

/** The longest end of `s` whose JSON text is at most `max` characters. */
function tailPart(s, max) {
  let n = 0
  let j = s.length
  for (; j > 0; j--) {
    const w = unitLength(s.charCodeAt(j - 1))
    if (n + w > max) break
    n += w
  }
  if (j < s.length && j > 0 && isLow(s.charCodeAt(j))) j++
  return s.slice(j)
}

/** `clip`: keeps the head, marked with CUT when anything was cut. */
function head(s, max) {
  if (typeof s !== 'string') return s
  return jsonLength(s) <= max ? s : max < 2 ? '' : `${headPart(s, max - 1)}${CUT}`
}

/** `tail`: keeps the end, for text whose last words matter most (a question an agent asks). */
function tail(s, max) {
  if (typeof s !== 'string') return s
  return jsonLength(s) <= max ? s : max < 2 ? '' : `${CUT}${tailPart(s, max - 1)}`
}

/** The start and the end of a long message, the middle marked as cut. */
function headTail(s, h, t) {
  if (typeof s !== 'string' || jsonLength(s) <= h + t + 3) return s
  return `${headPart(s, h)} ${CUT} ${tailPart(s, t)}`
}

/**
 * A structured value cut to at most `max` characters of compact JSON while it stays valid JSON:
 * short entries first, then each longer one in a fair share of what is left, lists cut at the
 * end, strings cut with the marker. A new value, never the one passed in.
 */
function fitJson(v, max) {
  const whole = JSON.stringify(v)
  if (whole === undefined) return undefined
  if (whole.length <= max) return JSON.parse(whole)
  if (typeof v === 'string') return max >= 4 ? head(v, max - 2) : undefined
  if (v === null || typeof v !== 'object') return undefined
  if (Array.isArray(v)) {
    const out = []
    let used = 2
    for (const x of v) {
      const room = max - used - (out.length ? 1 : 0)
      if (room < 6) break
      const y = fitJson(x, room)
      if (y === undefined) break
      out.push(y)
      used += JSON.stringify(y).length + (out.length > 1 ? 1 : 0)
      if (JSON.stringify(y) !== JSON.stringify(x)) break
    }
    return out
  }
  const entries = Object.entries(v).filter(([, x]) => JSON.stringify(x) !== undefined)
  const short = entries.filter(([, x]) => JSON.stringify(x).length <= 40)
  const long = entries.filter(([, x]) => JSON.stringify(x).length > 40)
  const out = {}
  let used = 2
  const put = (k, x, share) => {
    const cost = JSON.stringify(k).length + 1 + (Object.keys(out).length ? 1 : 0)
    const y = share - cost >= 4 ? fitJson(x, share - cost) : undefined
    if (y === undefined) return
    out[k] = y
    used += cost + JSON.stringify(y).length
  }
  for (const [k, x] of short) put(k, x, max - used)
  long.forEach(([k, x], i) => put(k, x, Math.floor((max - used) / (long.length - i))))
  return out
}

/** One field cut to `max`, or undefined when it is absent, empty, or has no room left. */
const fitField = (value, max, cut) => {
  if (value === undefined || value === null || value === '' || max < 2) return undefined
  const v = typeof value !== 'string' ? fitJson(value, max) : cut === 'tail' ? tail(value, max) : head(value, max)
  const text = JSON.stringify(v)
  return v === '' || text === '{}' || text === '[]' ? undefined : v
}

/**
 * One state view from `[key, value, max, cut, keep]` fields, in the order the model should read
 * them: a string keeps its head, or its end when `cut` is 'tail', and anything else is cut as
 * JSON. Each field is cut to its own budget, and when the whole still exceeds VIEW_LIMIT the
 * largest field that is not `keep` gives up the difference, so the limit holds by construction
 * whatever the text escapes to. Absent fields are left out.
 */
function view(fields) {
  const limits = fields.map((f) => f[2])
  for (;;) {
    const out = {}
    const sizes = fields.map(([key, value, , cut], i) => {
      const v = fitField(value, limits[i], cut)
      if (v === undefined) return 0
      out[key] = v
      return JSON.stringify(v).length
    })
    const over = JSON.stringify(out).length - VIEW_LIMIT
    if (over <= 0) return out
    let i = -1
    for (let j = 0; j < fields.length; j++) if (!fields[j][4] && sizes[j] > 0 && (i < 0 || sizes[j] > sizes[i])) i = j
    // Only kept fields are left and they alone overrun: they are short by definition, so this is
    // a caller's error; cut them rather than send a view over the limit.
    if (i < 0) for (let j = 0; j < fields.length; j++) if (sizes[j] > 0 && (i < 0 || sizes[j] > sizes[i])) i = j
    limits[i] = Math.max(0, Math.min(limits[i], sizes[i]) - over - 2)
  }
}

/**
 * The checks as one line, `typecheck pass, lint pass, test FAIL (regressed)`, from the review's
 * verification: in run order when it fits, else failures first, since the line is cut at its end.
 */
function checksLine(verification, max) {
  const results = Array.isArray(verification) ? verification : Array.isArray(verification?.results) ? verification.results : []
  if (!results.length) return 'no checks ran'
  const regressed = new Set(verification?.regressed ?? [])
  const fixed = new Set(verification?.fixed ?? [])
  const items = results.map((r) => {
    const name = String(r?.name ?? r?.check ?? 'check')
    const failed = r?.passed === false
    return { failed, text: `${name} ${failed ? 'FAIL' : 'pass'}${failed && regressed.has(name) ? ' (regressed)' : !failed && fixed.has(name) ? ' (fixed)' : ''}` }
  })
  const inOrder = items.map((x) => x.text).join(', ')
  return jsonLength(inOrder) <= max ? inOrder : [...items.filter((x) => x.failed), ...items.filter((x) => !x.failed)].map((x) => x.text).join(', ')
}

const filesLine = (files) => (Array.isArray(files) ? (files.length ? files.join(', ') : 'none') : undefined)
/** An answer without the marker jev.js appends when it cut the answer, so its end is real text. */
const answerText = (a) => (typeof a === 'string' ? a.replace(/\n\.\.\.\[truncated \d+ chars\]$/, '') : undefined)

const CHECKS_MAX = 90

/** The fields of each view, from the state jev.js built (already scrubbed); see the 4.2 d table. */
const VIEWS = {
  review: {
    order: ['outcome', 'diff', 'person', 'pick'],
    of: { verdict: 'outcome', disposition: 'outcome', addressed: 'outcome', complete: 'outcome', unrelatedChanges: 'diff', regressionRisk: 'diff', needsPerson: 'person', reviewAgent: 'pick', retryAgent: 'pick' },
    fallback: 'outcome',
    // The jev.js instructions name `attempts`, `verification`, `diff` and `candidates`, which three
    // views carry under other names or not at all: the outcome view has the latest attempt, the
    // checks and the diff's stat, the person view the latest attempt's status and answer, and the
    // pick view the latest attempt's resource, with each candidate's numbers in its option text.
    names: {
      outcome: [
        ['the latest entry in `attempts` (its answer and `diff`)', 'the latest attempt (its `answer_end`, `files` and `diff_stat`)'],
        ['the latest entry in `attempts`', 'the latest attempt (`answer_end`, `files`)'],
        ['`verification`', '`checks`'],
        ['`diff`', '`diff_stat`'],
      ],
      person: [['the latest entry in `attempts`', 'the latest attempt (`status`, `answer_end`)']],
      pick: [
        ['`resource` of the latest work entry in `attempts`', '`resource` in `latest`'],
        ['`resource` of an agent entry in `attempts`', '`resource` in `latest`'],
        ['an anonymous candidate in `candidates`', 'an anonymous candidate'],
      ],
    },
    build(v, state) {
      const attempts = Array.isArray(state?.attempts) ? state.attempts : []
      const latest = attempts[attempts.length - 1] ?? {}
      const answer = answerText(latest.answer)
      if (v === 'outcome') {
        // Checks first, so the right-truncation Laya applies to a state can never drop them.
        return view([['checks', checksLine(state?.verification, CHECKS_MAX), CHECKS_MAX, 'head', true], ['task', state?.task, 300], ['diff_stat', state?.diff?.stat, 150], ['files', filesLine(latest.changed_files), 120], ['answer_end', answer, 250, 'tail']])
      }
      if (v === 'diff') return view([['task', state?.task, 250], ['diff_stat', state?.diff?.stat, 150], ['diff', state?.diff?.excerpt, 520]])
      // The question an agent asks, or the block it reports, is at the end of its answer.
      if (v === 'person') return view([['status', latest.status, 40, 'head', true], ['answer_end', answer, 700, 'tail'], ['task', state?.task, 150]])
      // A class profile's risk is a mean, sixteen digits long: rounded, it fits its 12 characters
      // instead of being left out.
      const risk = typeof state?.routing?.risk === 'number' ? r4(state.routing.risk) : state?.routing?.risk
      return view([['task', state?.task, 200], ['task_type', state?.routing?.task_type, 40, 'head', true], ['risk', risk, 12, 'head', true], ['latest', { resource: latest.resource ?? latest.agent, status: latest.status }, 120, 'head', true]])
    },
  },
  route: {
    order: ['task', 'handoff', 'resource', 'agent'],
    of: { continueHandoff: 'handoff', strategy: 'resource', secondOpinion: 'resource', agent: 'agent' },
    fallback: 'task',
    build(v, state) {
      if (v === 'task') return view([['task', state?.task, 520], ['workspace', state?.workspace, 380]])
      // Today the handoff never reaches the model behind a long task and workspace.
      if (v === 'handoff') return view([['task', state?.task, 300], ['handoff', state?.handoff, 600]])
      if (v === 'resource') return view([['task', state?.task, 520], ['task_profile', state?.task_profile, 400]])
      // The legacy named-agent pick (routing.enabled false) reads the per-agent evidence.
      return view([['task', state?.task, 300], ['agent_track_record', state?.agent_track_record, 260], ['agent_availability', state?.agent_availability, 90], ['recent_outcomes', state?.recent_outcomes, 160], ['workspace', state?.workspace, 150]])
    },
  },
  intent: {
    order: ['message'],
    of: {},
    fallback: 'message',
    build: (v, state) => view([['message', headTail(state?.message, 600, 300), 903, 'head']]),
  },
}

/** A phase this adapter has no views for: the whole state as one view, cut to the limit. */
const WHOLE = { order: ['state'], of: {}, fallback: 'state', build: (v, state) => (typeof state === 'string' ? head(state, VIEW_LIMIT) : fitJson(state ?? {}, VIEW_LIMIT)) }

// --- requests (4.2 e) ----------------------------------------------------------------------------

/**
 * One call as the requests Laya is sent: one per state view for an acting call, and chunks of
 * `chunkRows` questions per view for a background (shadow) call, so an acting request waits
 * behind at most one chunk. Every request pins `model: 'english'`.
 * @param {{ phase: 'intent'|'route'|'review', state: object, questions: object }} call  as jev.js built it
 * @param {{ role?: 'act'|'shadow', chunkRows?: number }} [opts]
 * @returns {{ key: string, model: string, state: object, questions: object }[]}
 */
export function renderForLaya({ phase, state, questions }, { role = 'act', chunkRows = 4 } = {}) {
  const views = VIEWS[phase] ?? WHOLE
  const groups = new Map(views.order.map((v) => [v, []]))
  for (const name of Object.keys(questions ?? {})) groups.get(Object.hasOwn(views.of, name) ? views.of[name] : views.fallback).push(name)
  const size = role === 'shadow' ? Math.min(MAX_ROWS, Math.max(1, Math.floor(chunkRows) || 1)) : MAX_ROWS
  const requests = []
  for (const [v, names] of groups) {
    for (let i = 0; i < names.length; i += size) {
      const part = names.slice(i, i + size)
      requests.push({
        key: names.length > size ? `${v}.${i / size + 1}` : v,
        model: LAYA_MODEL,
        state: views.build(v, state),
        questions: Object.fromEntries(part.map((n) => [n, renderQuestion(n, questions[n], state, views.names?.[v])])),
      })
    }
  }
  return requests
}

/**
 * The answers of every request of one call, as one answer in the order the questions were asked.
 * `meta.atContextLimit` counts the requests whose rows reached the 512-token context on average
 * (Laya counts real tokens after truncation), which means a view estimate was wrong (4.2 f);
 * `meta.missing` names any question no response answered.
 * @param {{ questions: object }} call  the questions as jev.js built them
 * @param {{ key: string, response: { answers?: object, usage?: { input_tokens?: number } } }[]} parts
 */
export function mergeLaya({ questions }, parts) {
  const got = {}
  let input = 0
  let rows = 0
  let atContextLimit = 0
  for (const { response } of parts ?? []) {
    const answers = response?.answers ?? {}
    const n = Object.keys(answers).length
    const tokens = Number(response?.usage?.input_tokens) || 0
    rows += n
    input += tokens
    if (n && tokens / n >= AT_LIMIT * CONTEXT_TOKENS) atContextLimit++
    for (const [name, a] of Object.entries(answers)) got[name] = a
  }
  const names = Object.keys(questions ?? {})
  return {
    answers: Object.fromEntries(names.filter((n) => got[n]).map((n) => [n, got[n]])),
    usage: { input_tokens: input, output_tokens: 0 },
    meta: { requests: (parts ?? []).length, rows, atContextLimit, missing: names.filter((n) => !got[n]) },
  }
}

// --- answer normalisation (4.3) ------------------------------------------------------------------

/** Laya's own temperature bucket rule (`temp_bucket`): by question type and option count. */
export const bucketOf = (type, k) => `${type}:${k <= 2 ? '2' : k <= 5 ? '3-5' : k <= 10 ? '6-10' : '11+'}`

/** The option keys an answer's probabilities are in, in the question's order. */
function optionKeys(type, q, a) {
  if (type === 'choice') return Array.isArray(q?.criteria) ? q.criteria.map(String) : q?.criteria ? Object.keys(q.criteria) : Object.keys(a?.probabilities ?? {})
  if (type === 'score') return (Array.isArray(q?.criteria) ? q.criteria : Object.keys(a?.probabilities ?? {})).map((_, i) => String(i))
  return ['false', 'true']
}

/**
 * Laya's answers read the way KzH's bars expect (4.3), in this order:
 *   1. every answer whose bucket has an entry in `temperatureCorrections` is re-tempered,
 *      p'_i = p_i^(1/tau) / sum_j p_j^(1/tau), and marked `corrected`: by default only a choice
 *      with 11 or more options, whose shipped temperature Laya clamps and calls uncalibrated;
 *   2. `confidence` becomes the max probability, the one Laya calls calibrated; the served
 *      figure (normalised entropy for a choice or a score) is kept as `servedConfidence`, and a
 *      re-tempered answer's `answer_confidence` (Laya's own max probability) is its new one too;
 *   3. an answer whose top probability is under 1/k + `minTopMargin` is marked
 *      `informative: false`, since a flat answer's pick is noise; a margin of 0 turns this off.
 * Keys, choices and answer types are kept; every answer is a new object.
 * @returns {{ answers: object, uninformative: string[], corrected: string[] }}
 */
export function normalizeLayaAnswers(answers, questions, { temperatureCorrections = DEFAULT_CORRECTIONS, minTopMargin = DEFAULT_MIN_TOP_MARGIN } = {}) {
  const out = {}
  const uninformative = []
  const corrected = []
  for (const [name, a] of Object.entries(answers ?? {})) {
    const q = questions?.[name]
    const type = a?.type ?? q?.type
    const keys = optionKeys(type, q, a)
    let p = type === 'noul'
      ? (typeof a?.noul === 'number' ? [1 - a.noul, a.noul] : null)
      : a?.probabilities ? keys.map((k) => Number(a.probabilities[k]) || 0) : null
    const tau = temperatureCorrections?.[bucketOf(type, keys.length)]
    const fix = !!p && typeof tau === 'number' && tau > 0 && tau !== 1 && p.some((x) => x > 0)
    if (fix) {
      const w = p.map((x) => (x > 0 ? x ** (1 / tau) : 0))
      const sum = w.reduce((s, x) => s + x, 0)
      p = w.map((x) => r4(x / sum))
    }
    const next = { ...a, servedConfidence: a?.confidence, corrected: fix }
    if (fix && type === 'choice') next.probabilities = Object.fromEntries(keys.map((k, i) => [k, p[i]]))
    if (fix && type === 'score') {
      next.probabilities = Object.fromEntries(keys.map((k, i) => [k, p[i]]))
      next.score = r4(p.reduce((s, x, i) => s + i * x, 0))
    }
    if (fix && type === 'noul') next.noul = p[1]
    if (p) {
      const top = Math.max(...p)
      next.confidence = r4(top)
      // The served figure is the max probability before step 1, the very one it corrects.
      if (fix) next.answer_confidence = r4(top)
      next.informative = !(minTopMargin > 0) || top >= 1 / keys.length + minTopMargin - 1e-9
    } else {
      next.informative = true
    }
    if (fix) corrected.push(name)
    if (!next.informative) uninformative.push(name)
    out[name] = next
  }
  return { answers: out, uninformative, corrected }
}
