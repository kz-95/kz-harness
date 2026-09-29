// How long a task waiting in its workspace's line may still wait, from what past runs took
// (docs/queue-and-cost-findings.md 3). The history rows come in, the figure and its words go out,
// and index.js keeps the one set of statistics the task list's poll reads, added to as each run
// ends rather than read again from the file.
//
// The rule is the one the inspector and the memory figures already follow: a number says what it
// stands on, "estimated from 8 past runs of claude at medium effort", or there is nothing at all.
// A figure with nothing behind it reads exactly like one with a hundred runs behind it, which is
// the one way a queue view can mislead.
//
// Only the running task has a shape to match: the tasks behind it have not been routed yet, so
// they are counted at what a run in the same workspace takes. A task that waits for a free slot
// under the cap gets no figure, nor does one whose workspace's slot another workspace's earlier
// task will take first: the next slot goes to whichever task anywhere arrived first when any
// running task anywhere ends, and no one past run says when that is.

/** Past runs a figure needs at the level it is drawn from; under it the level is passed over. */
export const MIN_RUNS = 5
/** The newest runs a level keeps, as trackRecord reads an agent's (router.js). */
export const WINDOW = 50

const finite = (x) => typeof x === 'number' && Number.isFinite(x)

// A workspace as the lanes key it (tasks.js laneKey), without importing the lanes: a path's case
// and its separators do not make it another folder on Windows.
const keyOf = (p) => String(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

/**
 * What one history row says about how long work takes, or null when it says nothing:
 * - a row written before runs recorded their wall-clock time (their attempt times leave out the
 *   checks, the review calls and the steps between attempts);
 * - a run cut short, stopped by a person or at an agent's usage limit, whose time is where it was
 *   cut and not what the work takes;
 * - an answer-only run (answered, or marked answerOnly whatever it came to), and a read pass handed
 *   back to the lane, which say how long an answer takes, not the work a task in the line waits behind.
 * A run whose work went to a tool first counts at its workspace only: no agent's shape fits it.
 * @returns {{ ms: number, runId?: string, decider: string, agent: string|null, effort: string|null, review: boolean, workspace: string|null } | null}
 */
export function sampleOf(row) {
  if (!finite(row?.wallMs) || row.wallMs < 0) return null
  if (['stopped', 'paused_limit', 'answered', 'needs_write'].includes(row.finalStatus) || row.answerOnly || row.access?.mode === 'read') return null
  const attempts = row.attempts ?? []
  if (attempts.some((a) => a?.limitHit)) return null
  const first = attempts.find((a) => a?.role === 'primary' || a?.role === 'retry' || a?.role === 'tool')
  // No work attempt at all (a person was asked before anything ran) says nothing about an agent;
  // it held the workspace that long all the same, so it counts there.
  const tool = !first || first.role === 'tool' || !!row.routing?.tool
  return {
    ms: row.wallMs,
    ...(row.runId ? { runId: row.runId } : {}),
    decider: row.routing?.decider ?? 'jev',
    agent: tool ? null : row.routing?.primaryAgent ?? null,
    effort: tool ? null : attempts.find((a) => a?.role === 'primary')?.effort ?? null,
    review: !!(row.plan?.forceReview && row.plan?.reviewer),
    workspace: row.workspace ? keyOf(row.workspace) : null,
  }
}

/**
 * The levels a figure for a run of this shape is drawn from, most like it first, all within the
 * provider that decided it (a Laya-decided run spends minutes on its CPU calls a Jev run does not):
 * the same agent at the same effort with or without a planned review, then the agent at that
 * effort, then the agent, then the workspace. Effort and a planned review are what lengthen a run;
 * the strategy's name is not (the three DIRECT strategies build one plan), nor is the task type,
 * whose labels differ between Jev and Laya. `basis` is how the text names the level.
 */
function levels({ decider = 'jev', agent, effort, review } = {}, workspace) {
  const out = []
  const d = `${decider}|`
  if (agent && effort && review != null) out.push({ key: `${d}are|${agent}|${effort}|${review ? 1 : 0}`, basis: `of ${agent} at ${effort} effort with ${review ? 'a' : 'no'} planned review` })
  if (agent && effort) out.push({ key: `${d}ae|${agent}|${effort}`, basis: `of ${agent} at ${effort} effort` })
  if (agent) out.push({ key: `${d}a|${agent}`, basis: `of ${agent}` })
  if (workspace) out.push({ key: `${d}w|${keyOf(workspace)}`, basis: 'in this workspace' })
  return out
}

/**
 * The statistics every figure is drawn from: each level's newest WINDOW durations, sorted when a
 * figure asks for them. `load` takes the history once, `add` each row as its run ends; a run is
 * counted once however it arrives (a row appended while the file was being read comes both ways).
 */
export function createWaitStats() {
  const levelsOf = new Map() // key -> { runs: number[] newest last, sorted: number[] | null }
  const seen = new Set()
  // `older`: the row is from before every run already counted (the start-up read of the file, which
  // can land after a run that ended meanwhile was added), so it goes in front and the window keeps
  // the newest.
  const put = (row, older) => {
    const s = sampleOf(row)
    if (!s) return false
    if (s.runId) { if (seen.has(s.runId)) return false; seen.add(s.runId) }
    for (const { key } of levels(s, s.workspace)) {
      let level = levelsOf.get(key)
      if (!level) levelsOf.set(key, (level = { runs: [], sorted: null }))
      if (older) { if (level.runs.length < WINDOW) level.runs.unshift(s.ms) } else { level.runs.push(s.ms); if (level.runs.length > WINDOW) level.runs.shift() }
      level.sorted = null
    }
    return true
  }
  const add = (row) => put(row, false)
  return {
    add,
    load(rows = []) { for (let i = rows.length - 1; i >= 0; i--) put(rows[i], true) },
    /** A level's durations, sorted, or [] for a level with none. */
    get(key) {
      const level = levelsOf.get(key)
      if (!level) return []
      level.sorted ??= [...level.runs].sort((a, b) => a - b)
      return level.sorted
    },
  }
}

/** Statistics built from these rows at once: createWaitStats() loaded with them. */
export function waitStats(rows = []) {
  const stats = createWaitStats()
  stats.load(rows)
  return stats
}

// The q-quantile of sorted numbers, interpolated between the two nearest.
function quantile(sorted, q) {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/**
 * How much longer the running task takes: the middle half of what the past runs most like it took
 * beyond the time it has run so far, counting only those that lasted longer than that. A task that
 * has already run longer than all but a few of them gets no figure, rather than a negative one or a
 * coarser level's, which would say what a typical run of another kind takes.
 * @param {ReturnType<typeof createWaitStats>} stats
 * @param {{ shape?: object, workspace?: string, elapsedMs: number }} run
 * @returns {{ lowMs: number, highMs: number, n: number, k: number, basis: string } | { over: true, n: number, k: number, basis: string } | null}
 */
export function remainingOf(stats, { shape, workspace, elapsedMs = 0 }) {
  for (const { key, basis } of levels(shape, workspace)) {
    const all = stats.get(key)
    if (all.length < MIN_RUNS) continue
    const left = all.filter((ms) => ms > elapsedMs).map((ms) => ms - elapsedMs)
    if (left.length < MIN_RUNS) return { over: true, n: all.length, k: left.length, basis }
    return { lowMs: quantile(left, 0.25), highMs: quantile(left, 0.75), n: all.length, k: left.length, basis }
  }
  return null
}

/** The middle half of what a whole run in this workspace takes, or null under MIN_RUNS. */
function wholeRunIn(stats, workspace, decider = 'jev') {
  const all = workspace ? stats.get(`${decider}|w|${keyOf(workspace)}`) : []
  return all.length < MIN_RUNS ? null : { lowMs: quantile(all, 0.25), highMs: quantile(all, 0.75), n: all.length }
}

/** A span in words, rounded to whole minutes: under a minute, about 4 min, 3 to 7 min, 1 h 5 min to 2 h. */
export function spanText(lowMs, highMs) {
  const min = (ms) => Math.max(0, Math.round(ms / 60_000))
  const text = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`)
  const [a, b] = [min(lowMs), min(highMs)]
  if (b < 1 || (a < 1 && b === 1)) return 'under a minute'
  if (a === b) return `about ${text(b)}`
  // "0 to 3 min" reads as a figure that includes now; "under 3 min" says the same thing plainly.
  if (a < 1) return `under ${text(b)}`
  return b < 60 ? `about ${a} to ${b} min` : `about ${text(a)} to ${text(b)}`
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`

/**
 * Where a waiting task stands, in the words the row's meta line shows: its place in its
 * workspace's line, or, for the first in a line whose workspace nobody holds, its place among
 * those waiting for a free slot, which is not "next up" when another workspace's task goes first.
 * @param {{ why: string, place: number, slot?: number }} w  lanes waitOf()
 */
export function placeText(w) {
  if (!w) return ''
  if (w.why === 'cap') return w.slot > 1 ? `${ordinal(w.slot)} for a free slot` : 'next for a free slot'
  return `${ordinal(w.place)} in line`
}

/**
 * The estimate one waiting task is shown, with its basis in the same sentence, or null when there
 * is nothing to draw one from: it waits for a free slot, another workspace's task takes the slot
 * its workspace frees first, more tasks run than the cap now allows, KzH has no record of when the
 * run holding its workspace started, that run only answers a question, or fewer than MIN_RUNS past
 * runs say anything about it.
 * @param {ReturnType<typeof createWaitStats>} stats
 * @param {{ why: string, ahead: number, slotsAhead?: number, overCap?: boolean }} w  lanes waitOf()
 * @param {{ holder: { shape?: object, elapsedMs: number } | null, workspace: string }} p
 * @returns {{ lowMs: number|null, highMs: number|null, n: number, text: string } | null}
 */
export function waitEstimate(stats, w, { holder, workspace, ahead: aheadWho = [] }) {
  if ((w?.why !== 'workspace' && w?.why !== 'chat') || !holder || holder.answerOnly || w.overCap || w.slotsAhead > 0) return null
  const decider = holder.shape?.decider ?? 'jev'
  const runs = (n, d = decider) => `${n} past ${d === 'laya' ? 'Laya ' : ''}run${n === 1 ? '' : 's'}`
  const rest = remainingOf(stats, { shape: holder.shape, workspace, elapsedMs: holder.elapsedMs })
  if (!rest) return null
  // The figure stands on the k runs that lasted longer than the running task has so far, not on
  // every run at the level: that is the number the text gives.
  const lasted = `ran longer than the running task has so far`
  if (rest.over) return { lowMs: null, highMs: null, n: rest.k, text: `No estimate: only ${rest.k} of the ${runs(rest.n)} ${rest.basis} ${lasted}, and an estimate needs ${MIN_RUNS}.` }
  const from = rest.k === rest.n ? `estimated from ${runs(rest.n)} ${rest.basis}` : `estimated from the ${rest.k} of ${runs(rest.n)} ${rest.basis} that ${lasted}`
  if (!w.ahead) return { lowMs: rest.lowMs, highMs: rest.highMs, n: rest.k, text: `Starts in ${spanText(rest.lowMs, rest.highMs)}, ${from}.` }
  const tail = `${w.ahead} more task${w.ahead === 1 ? ' is' : 's are'} ahead of this one`
  // Each run ahead counts at what a whole run in this workspace takes under its own decider; one
  // whose decider is unknown, or that only answers a question, cannot be counted.
  const byDecider = new Map()
  const counted = [...Array(w.ahead)].map((_, i) => aheadWho[i]).every((o) => {
    if (!o?.decider || o.answerOnly) return false
    byDecider.set(o.decider, (byDecider.get(o.decider) ?? 0) + 1)
    return true
  })
  const wholes = counted ? [...byDecider].map(([d, count]) => ({ d, count, whole: wholeRunIn(stats, workspace, d) })) : []
  if (!counted || wholes.some((x) => !x.whole)) return { lowMs: null, highMs: null, n: rest.k, text: `The running task likely ends in ${spanText(rest.lowMs, rest.highMs)}, ${from}; ${tail}.` }
  const lowMs = rest.lowMs + wholes.reduce((sum, x) => sum + x.count * x.whole.lowMs, 0)
  const highMs = rest.highMs + wholes.reduce((sum, x) => sum + x.count * x.whole.highMs, 0)
  const aheadFrom = wholes.map((x) => `${runs(x.whole.n, x.d)} in this workspace`).join(' and ')
  return { lowMs, highMs, n: rest.k, text: `Starts in ${spanText(lowMs, highMs)}, ${from} for the running task and ${aheadFrom} for the ${w.ahead === 1 ? 'task' : `${w.ahead} tasks`} ahead of it.` }
}

const KIND_WORDS = { task: ['background task', 'background tasks'], chat: ['run from the chat', 'runs from the chat'], benchmark: ['capability benchmark task', 'capability benchmark tasks'] }
const count = (n, [one, many]) => `${n} ${n === 1 ? one : many}`
const list = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

/**
 * What else decides when a waiting task starts, in sentences, none of them a figure: the slots of
 * Tasks at once and what holds them (none of it may be on this session's board: a task of another
 * session, a run from the chat, a benchmark task), tasks in other workspaces that take the next free
 * slot first, and runs from the chat, which have no row, waiting in front of it in its own line.
 * @param {{ why: string, slotsAhead?: number, slotsAheadHere?: number, overCap?: boolean, chatAhead?: number, max?: number, held?: object }} w  lanes waitOf()
 */
export function slotFacts(w) {
  if (!w) return ''
  const out = []
  if ((w.why === 'cap' || w.why === 'line' || w.overCap) && w.max != null) {
    const by = w.held ?? {}
    const total = Object.values(by).reduce((a, b) => a + b, 0)
    const parts = [...new Set(['task', 'chat', 'benchmark', ...Object.keys(by)])].filter((kind) => by[kind]).map((kind) => count(by[kind], KIND_WORDS[kind] ?? KIND_WORDS.task))
    out.push(w.overCap
      ? `Tasks at once: ${total} in use, over the ${w.max} now set, so the next to end frees no slot (${list(parts)}).`
      : `Tasks at once: ${total} of ${w.max} in use (${list(parts)}).`)
  }
  // Lines that take a free slot before this one: other workspaces' tasks, and this workspace's own
  // read-only tasks, each waiting on a lane of its own (tasks.js readLaneKey), said apart.
  const here = w.slotsAheadHere ?? 0
  const elsewhere = (w.slotsAhead ?? 0) - here
  if ((w.why === 'workspace' || w.why === 'chat') && elsewhere > 0) out.push(`${elsewhere === 1 ? '1 task waiting in another workspace takes a free slot' : `${elsewhere} tasks waiting in other workspaces take free slots`} before this one.`)
  if ((w.why === 'workspace' || w.why === 'chat') && here > 0) out.push(`${here === 1 ? '1 read-only task in this workspace takes a free slot' : `${here} read-only tasks in this workspace take free slots`} before this one.`)
  if (w.chatAhead > 0) out.push(`${count(w.chatAhead, KIND_WORDS.chat)} ${w.chatAhead === 1 ? 'waits' : 'wait'} ahead of it in this line.`)
  return out.join(' ')
}

/** A waiting task's whole line: why it waits, then the estimate when there is one, each a sentence. */
export function waitText(reason, estimate, facts = '') {
  const said = String(reason ?? '').trim()
  return [said && !/[.!?]$/.test(said) ? `${said}.` : said, facts, estimate?.text ?? ''].filter(Boolean).join(' ')
}
