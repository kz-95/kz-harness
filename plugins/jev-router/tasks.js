// Non-blocking orchestration: routed tasks run as DSH background jobs, one task that
// writes at a time per workspace (a lane), while the chat stays free. A task judged read
// only takes a slot of its own and runs beside it, on an agent locked against writing
// (runAdmitted). The resource budget can also cap how many run at once across every
// workspace, read-only runs included.
//
// One task is one record. The task list and the chat both read that record, so the
// row and the delivered message can never disagree, and a result stays unread until
// the conversation has actually taken it.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { line } from './adapter.js'
import { NEEDS_LANE } from './capabilities.js'
import { SESSION_ID } from './export.js'
import { placeText, slotFacts, waitText } from './waits.js'
import { commonGitDir, outerRepoRoot } from './workspace.js'

export const laneKey = (cwd) => resolve(cwd).toLowerCase()
/**
 * The lane of one read-only task: its own, so it waits for nothing in its workspace and only for a
 * slot under the cap. NUL never occurs in a path, so no workspace's key can be one of these.
 */
export const readLaneKey = (cwd, jobId) => `${laneKey(cwd)}\0read:${jobId}`
/** The lane a task waits in or holds: its own for a read-only task, its workspace's otherwise. */
export const laneOf = (t) => (t.access === 'read' ? readLaneKey(t.workspace, t.jobId) : laneKey(t.workspace))

/**
 * Admit one task and run it. A task judged read only takes a slot of its own and runs a read pass
 * (`run({ mode: 'read' })`); when that pass cannot do it locked (NEEDS_LANE) the slot is given up
 * first, then the task waits for its workspace like work that writes and runs once more, as a
 * writer told why (`run({ mode: 'write', from })`). Giving the slot up before waiting is what lets
 * it through with a cap of 1: holding it while waiting for a workspace would wait for itself.
 * Any other task runs once, as a writer, in its workspace's lane.
 *
 * `who` describes the run on the lane (createLanes acquire), a fresh copy per pass, since route()
 * writes what it learns of the run onto it; the run gets it as `pass.who`.
 */
export async function runAdmitted({ lanes, task: t, signal, who = null, onWait, run }) {
  const whoOf = (mode) => (who ? { ...who, ...(mode === 'read' ? { reads: true } : {}) } : undefined)
  let from = null
  if (t.access === 'read') {
    const readWho = whoOf('read')
    const release = await lanes.acquire(readLaneKey(t.workspace, t.jobId), t.jobId, signal, { onWait, who: readWho })
    try { return await run({ mode: 'read', who: readWho }) } catch (err) {
      if (err?.code !== NEEDS_LANE || signal?.aborted) throw err
      from = { why: err.message, readPass: err.readPass ?? null }
    } finally { release() }
  }
  const writeWho = whoOf('write')
  const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal, { onWait, who: writeWho })
  try { return await run({ mode: 'write', who: writeWho, ...(from ? { from } : {}) }) } catch (err) {
    if (err?.code === NEEDS_LANE) throw new Error(`a pass that writes cannot be handed back: ${err.message}`)
    throw err
  } finally { release() }
}

/** Every state a task can be in; the task list shows one label per state. */
export const TASK_STATES = Object.freeze([
  'queued', 'routing', 'running', 'verifying', 'reviewing',
  'completed', 'failed', 'stopped', 'needs_human', 'paused_limit',
])
/**
 * Terminal states are final. Nothing moves a task out of one: a late event from a
 * finished run must not put a completed task back to running.
 */
export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'stopped', 'needs_human', 'paused_limit'])
const FINISHED = TERMINAL_STATES

/**
 * The job service speaks its own vocabulary. A task that stopped for a person or a
 * limit still *ran to its end*, so it is not reported to the job service as a
 * failure; only a real failure or a kill is.
 */
const JOB_STATUS = { completed: 'completed', needs_human: 'completed', paused_limit: 'completed', failed: 'failed', stopped: 'killed' }

/**
 * The router's final status -> the task's terminal state.
 *
 * `limit_reached` is the run giving up because the review kept rejecting it, so it is a
 * failure, not a success: reporting it as Completed would tell the person the opposite of
 * what happened. Only an `accepted*` status means the work was accepted.
 */
const terminalOf = (status) => {
  if (status === 'needs_human') return 'needs_human'
  if (status === 'paused_limit') return 'paused_limit'
  if (status === 'limit_reached') return 'failed'
  return 'completed'
}

/**
 * What a task that has to wait is told, by what it waits for (acquire's `onWait`): another task in
 * its own workspace, or a free slot under the resource budget's cap on tasks at once. The first is
 * what a queued event with no text has always read as.
 */
export const WAITING = {
  workspace: 'Waiting: another task is running in this workspace',
  // A run started from the chat (/auto, /<agent>, jev_route, an answer with no chat model) has no
  // row on the work board, so "another task" would point at nothing the person can see.
  chat: 'Waiting: a run started from the chat is using this workspace',
  cap: 'Waiting for a free slot: the resource budget caps how many tasks run at once',
  // Only the task list says this one (lanes why()): a run joining the line is told 'workspace' or
  // 'cap', and it becomes 'line' only as the line moves, when nothing runs in its workspace and an
  // earlier task there waits for the slot first.
  line: 'Waiting: an earlier task in this workspace is waiting for a free slot first',
}

/**
 * One lane per workspace: a holder and a reorderable waiting line. A read-only task has a lane of
 * its own (readLaneKey), so it never waits in its workspace's line and nothing waits behind it.
 * acquire() resolves with release() when it is this id's turn; an abort while waiting rejects.
 *
 * `max` caps how many lanes may hold at once across every workspace (the resource budget's tasks
 * at once); null, the default, is no cap. A workspace still runs one task that writes at a time
 * whatever the cap; a read-only task's own lane counts under the cap like any other. When a slot frees, the workspace whose waiting task arrived first gets it, so a busy
 * workspace cannot keep a quiet one waiting; within a workspace its own line's order decides.
 *
 * The cap counts every run that holds a lane, a foreground /auto, /<agent> or jev_route as much as
 * a background task: each runs an agent's processes, which is what overloads the PC. None is
 * exempt, so each is told when it has to wait: acquire's `onWait` hears why ('workspace' or 'cap',
 * see WAITING) as the run joins the line, and not at all when it starts at once.
 */
export function createLanes({ max = null } = {}) {
  const lanes = new Map() // key -> { holder: id | null, who: object | null, waiting: [{ id, n, go, onWait, told, who }] }
  let limit = max ?? Infinity
  let holding = 0 // lanes with a holder, across every workspace
  let arrivals = 0 // numbers every waiter in arrival order, across workspaces
  const get = (k) => { if (!lanes.has(k)) lanes.set(k, { holder: null, who: null, waiting: [] }); return lanes.get(k) }
  const heldReason = (l) => (l.who?.kind === 'chat' ? 'chat' : 'workspace')
  const firstArrival = (l) => Math.min(...l.waiting.map((w) => w.n))
  // Why a run joining lane `k` now would wait, or null when it would start at once. A lane with
  // waiters and no holder is one whose waiters are held back by the cap: next() lets anyone in the
  // moment both its workspace and a slot are free, so a run joining it waits behind the first of
  // them ('line') rather than for a slot of its own.
  const waitsFor = (k) => (lanes.get(k)?.holder ? heldReason(lanes.get(k)) : lanes.get(k)?.waiting.length ? 'line' : holding >= limit ? 'cap' : null)
  // What the waiter at index `i` of lane `l` waits for now.
  const reasonOf = (l, i) => (l.holder ? heldReason(l) : i === 0 ? 'cap' : 'line')
  // Every run holding a slot now, by kind, for the words of a wait for one.
  const heldBy = () => {
    const by = {}
    for (const o of lanes.values()) if (o.holder) { const kind = o.who?.kind ?? 'task'; by[kind] = (by[kind] ?? 0) + 1 }
    return by
  }
  // Tasks in lines other than `k`'s that take a free slot before lane `k` does, next() picking by
  // first arrival. Only lines nobody holds, unless `held`: a held line's holder frees a slot and its
  // workspace together, and its own earlier waiter then takes that slot.
  // A key's workspace: a read-only task's own lane (readLaneKey) belongs to the workspace before the NUL.
  const workspaceOf = (key) => key.split('\0')[0]
  // With one slot, counted by task: a line keeps beating lane `k` to each slot while its earliest
  // arrival from its next task on is before `n`, so each of its tasks up to the last that arrived
  // first counts. With more, by line: once a line's first task holds a slot, its next waits for
  // that one to end, and lane `k` may get a slot first, so only its first task surely goes before.
  const earlierForSlot = (k, n, { held = false } = {}) => {
    let count = 0
    let here = 0
    for (const [key, o] of lanes) {
      if (key === k || (!held && o.holder)) continue
      let first = 0
      for (let j = 0; j < o.waiting.length && Math.min(...o.waiting.slice(j).map((w) => w.n)) < n && (limit === 1 || j === 0); j++) first++
      count += first
      if (workspaceOf(key) === workspaceOf(k)) here += first
    }
    return { count, here }
  }
  // A waiter whose reason changed since it was last told is told again: its live lines, its task
  // row's last line and the benchmark card then follow the line rather than keep the reason it had
  // when it joined. A listener that throws here is past the point where it could refuse to join.
  const retell = () => {
    for (const l of lanes.values()) {
      l.waiting.forEach((w, i) => {
        const why = reasonOf(l, i)
        if (w.told === why || !w.onWait) return
        w.told = why
        try { w.onWait(why) } catch { /* it keeps its place; only the words failed */ }
      })
    }
  }
  // Hand out every slot the cap allows: a lane nobody holds, with somebody waiting, lets the head
  // of its line in. With no cap that is every such lane, which is what this did before there was one.
  const next = () => {
    while (holding < limit) {
      let pick = null
      for (const l of lanes.values()) if (!l.holder && l.waiting.length && (!pick || firstArrival(l) < firstArrival(pick))) pick = l
      if (!pick) break
      const w = pick.waiting.shift()
      pick.holder = w.id
      pick.who = w.who ?? null
      holding++
      w.go()
    }
    for (const [k, l] of lanes) if (!l.holder && !l.waiting.length) lanes.delete(k)
    retell()
  }
  return {
    acquire(k, id, signal, { onWait, who } = {}) {
      return new Promise((res, rej) => {
        if (signal?.aborted) return rej(signal.reason ?? new DOMException('Stopped', 'AbortError'))
        // Told before it joins the line: a listener that throws then fails this call and leaves
        // nothing in the line, where a waiter nobody holds a promise for would take the lane for good.
        const why = waitsFor(k)
        if (why) onWait?.(why)
        const l = get(k)
        const onAbort = () => {
          const i = l.waiting.indexOf(w)
          if (i >= 0) { l.waiting.splice(i, 1); next(); rej(signal.reason ?? new DOMException('Stopped', 'AbortError')) }
        }
        const w = {
          id,
          n: arrivals++,
          onWait,
          told: why,
          who,
          go: () => {
            signal?.removeEventListener('abort', onAbort)
            let released = false
            res(() => { if (released) return; released = true; l.holder = null; l.who = null; holding--; next() })
          },
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        l.waiting.push(w)
        next()
      })
    },
    busy: (k) => !!lanes.get(k)?.holder,
    /** Whether a task joining lane `k` now would wait: its workspace is taken, or the cap is. */
    waits: (k) => !!waitsFor(k),
    /** A new cap (null: none). Raising it lets waiting work in at once; lowering it stops nothing that runs. */
    setMax(n) { limit = n ?? Infinity; next() },
    /**
     * The cap as it stands now, counted where it is held: `held` is every run holding a slot, a
     * foreground run as much as a background task, since each holds its workspace's lane; `waiting`
     * is the runs kept waiting only by the cap, the first in each line whose workspace nobody holds
     * (position 1); `max` is the cap, null for none. A run behind another in its own workspace is not
     * waiting for a slot, since a free one would not start it, and with no cap nothing is.
     */
    slots() {
      let waiting = 0
      for (const l of lanes.values()) if (!l.holder && l.waiting.length) waiting++
      return { held: holding, waiting, max: limit === Infinity ? null : limit }
    },
    /**
     * 0 = running, 2 = first behind the running one ("2nd in line"), 1 = first in line with nothing
     * running in this workspace (waiting for a slot under the cap), -1 = not in this lane.
     */
    position(k, id) {
      const l = lanes.get(k)
      if (!l) return -1
      if (l.holder === id) return 0
      const i = l.waiting.findIndex((w) => w.id === id)
      return i < 0 ? -1 : i + 1 + (l.holder ? 1 : 0)
    },
    /**
     * Where `id` stands in lane `k` now, read off the line as it is (and told again through its
     * onWait as its reason changes), or null when it is not waiting there:
     * - why: 'workspace' while another run holds its workspace; 'cap' for the first in a line whose
     *   workspace nobody holds, which starts at a free slot; 'line' for one behind that first;
     * - place: its place in its workspace's line, the run holding it counted (as position());
     * - ahead: the runs waiting in front of it in its workspace;
     * - slot: for 'cap', its place among the lines waiting for a slot, by first arrival, a line
     *   whose workspace is held counted too (its holder's slot goes to its own earlier waiter);
     * - slotsAhead: tasks in lines nobody holds, in other workspaces, that arrived before its own
     *   line's first once those in front of it have started, and so take a slot before it does
     *   (0 with no cap); slotsAheadHere of them are its own workspace's read-only tasks, each on
     *   a lane of its own;
     * - overCap: more runs hold slots than the cap now allows, so the next to end frees none.
     */
    waitOf(k, id) {
      const l = lanes.get(k)
      const i = l ? l.waiting.findIndex((w) => w.id === id) : -1
      if (i < 0) return null
      const why = reasonOf(l, i)
      // Its line's first arrival once those in front of it have started: a reordered line can hold
      // an earlier arrival behind it. For the head of the line that is firstArrival(l).
      const earlier = earlierForSlot(k, Math.min(...l.waiting.slice(i).map((o) => o.n)))
      return {
        why, place: i + 1 + (l.holder ? 1 : 0), ahead: i,
        ...(why === 'cap' ? { slot: earlierForSlot(k, firstArrival(l), { held: true }).count + 1 } : {}),
        slotsAhead: limit === Infinity ? 0 : earlier.count,
        slotsAheadHere: limit === Infinity ? 0 : earlier.here,
        overCap: holding > limit,
        chatAhead: l.waiting.slice(0, i).filter((o) => o.who?.kind === 'chat').length,
        // What an estimate reads, never shown as is: who holds the workspace and who waits in front.
        holder: l.holder ? l.who : null,
        aheadWho: l.waiting.slice(0, i).map((o) => o.who ?? null),
        ...(limit === Infinity ? {} : { max: limit, held: heldBy() }),
      }
    },
    /** Waiting ids in `order` first (in that order), the rest after, unchanged. */
    reorder(k, order) {
      const l = lanes.get(k)
      const ids = new Set(l?.waiting.map((w) => w.id) ?? [])
      const unknown = order.filter((id) => !ids.has(id))
      if (unknown.length) throw new Error(`not waiting in this workspace: ${unknown.join(', ')}`)
      if (!l) return
      const rank = new Map(order.map((id, i) => [id, i]))
      l.waiting.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
      retell()
    },
  }
}

/**
 * The keys a run in `cwd` is known by to a run log (laneKey form): its folders, and the git folder
 * its repository's worktrees share (null outside git). The folders are the one given and the one it
 * really is, its outermost repository's top inside git (a submodule's runs count with its
 * superproject's, whose `git status` shows the changed submodule) and the folder itself outside. A
 * link or junction on the way makes the two differ, and a run in a folder that holds either writes
 * into it.
 */
export async function runKeysOf(cwd) {
  const top = await outerRepoRoot(cwd).catch(() => null)
  const real = await realpath(top ?? cwd).catch(() => top ?? cwd)
  const common = await commonGitDir(cwd).catch(() => null)
  return [[...new Set([laneKey(cwd), laneKey(real)])], common ? laneKey(common) : null]
}

/**
 * Every run going on, and every run that ended while one started before its end still goes on,
 * each by its folder keys (laneKey form; one key, or a list of the spellings it is known by), the
 * git folder its repository's worktrees share when there is one, and when it started and ended, in
 * one sequence. `beside(run)` is whether any other run went on at any time while `run` did in a
 * related folder: the same one, one that holds it, one inside it, or another worktree of the same
 * repository. `sep` is the path separator the keys use.
 *
 * `track(lookup, fallback)` opens a run whose keys are still being looked up (`lookup()` resolves
 * to [key, common], as runKeysOf does; `fallback` is the key when it fails), so the run it counts
 * never waits for git.
 * Until its keys are known a run is related to every run: the safe side, where a lock check says it
 * cannot tell rather than blame an agent. `besideNow(run)` is what a lock check asks: it fixes the
 * runs that count at the moment it is asked (one that starts later cannot have written what the
 * check read), waits `ms` at most for the lookups among those that could have overlapped `run`,
 * then answers.
 */
export function createRunLog({ sep = '/', waitMs = 5000 } = {}) {
  const log = [] // { key, common, pending, start, end: number | null }
  let seq = 0
  const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`)
  const keys = (r) => [r.key].flat()
  const related = (a, b) => !a.key || !b.key || keys(a).some((x) => keys(b).some((y) => within(x, y) || within(y, x))) || (!!a.common && a.common === b.common)
  // Another run that went on while `me` did and had started by `upTo`.
  const overlaps = (o, me, upTo) => o !== me && o.start <= upTo && (o.end === null || o.end > me.start)
  const api = {
    open(key = null, common = null, pending = null) { const r = { key, common, pending, start: ++seq, end: null }; log.push(r); return r },
    key(r, key, common = null) { Object.assign(r, { key, common }) },
    track(lookup, fallback = null) {
      const r = api.open()
      r.pending = Promise.resolve().then(lookup).then(([key, common]) => api.key(r, key, common), () => api.key(r, fallback))
      return r
    },
    close(r) {
      if (r.end !== null) return
      r.end = ++seq
      // An ended run matters only to one still going that started before it ended.
      const oldest = Math.min(...log.filter((o) => o.end === null).map((o) => o.start))
      for (let i = log.length - 1; i >= 0; i--) if (log[i].end !== null && log[i].end < oldest) log.splice(i, 1)
    },
    beside: (me, upTo = Infinity) => log.some((o) => overlaps(o, me, upTo) && related(o, me)),
    async besideNow(me, ms = waitMs) {
      const upTo = seq
      const waits = log.filter((o) => overlaps(o, me, upTo) && !o.key && o.pending).map((o) => o.pending)
      if (waits.length) {
        let timer
        await Promise.race([Promise.allSettled(waits), new Promise((res) => { timer = setTimeout(res, ms) })])
        clearTimeout(timer)
      }
      return api.beside(me, upTo)
    },
    get size() { return log.length },
  }
  return api
}

/**
 * Serialize async sections (set process env + start a subagent). A section whose `signal` aborts
 * while it waits its turn rejects at once and never runs; the ones after it keep their order.
 */
export function createMutex() {
  let tail = Promise.resolve()
  return (fn, signal) => {
    const turn = tail
    let release
    tail = new Promise((r) => { release = r })
    return new Promise((resolve, reject) => {
      const stopped = () => reject(signal.reason ?? new DOMException('Stopped', 'AbortError'))
      signal?.addEventListener('abort', stopped, { once: true })
      turn.then(async () => {
        signal?.removeEventListener('abort', stopped)
        if (signal?.aborted) { stopped(); release(); return }
        try { resolve(await fn()) } catch (err) { reject(err) } finally { release() }
      })
    })
  }
}

const JOB_ID = /^[a-z][\w-]{0,40}$/
/** Body list of job ids: 1-100 short ids. Throws otherwise. */
export function validJobIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((x) => typeof x === 'string' && JOB_ID.test(x))) throw new Error('jobIds: array of 1-100 job ids')
  return ids
}
export const validJobId = (id) => validJobIds([id])[0]

/**
 * A task's name as a result notice's summary carries it (delivery.js: `jev-3 · <name> · Completed`),
 * with whitespace around `·` removed and any other run of it read as one space: the browser reads
 * each field of the summary back trimmed, and a task name may hold the separator itself.
 */
const nameKey = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/ ?· ?/g, '·').trim()

/**
 * The results a browser says it rendered (POST /jev-router/tasks/seen), as `{ jobId, name, sessionId }`:
 * `results`, each naming the task as its notice summary does, then the bare `jobIds` an older page
 * sends, which carry no name to check. `sessionId` is the chat the rows are in, on every entry when
 * the page says which, and a chat that is no session id marks nothing read. An entry that is
 * neither is dropped.
 */
export function seenResults(body) {
  const valid = (id) => { try { return validJobId(id) } catch { return null } }
  const chat = body?.sessionId ?? null
  if (chat !== null && !(typeof chat === 'string' && SESSION_ID.test(chat))) return []
  const inChat = chat === null ? {} : { sessionId: chat }
  const named = (Array.isArray(body?.results) ? body.results : [])
    .filter((r) => valid(r?.jobId) && typeof r.name === 'string')
    .map((r) => ({ jobId: r.jobId, name: r.name, ...inChat }))
  const bare = (Array.isArray(body?.jobIds) ? body.jobIds : []).filter(valid).map((jobId) => ({ jobId, ...inChat }))
  return [...named, ...bare]
}

/**
 * The engine's refusal of one more background job in a chat (dsh-jobs-local: `background job limit
 * reached for this owner (limit: 10); use job_kill ...`), in words a person can act on. Every task
 * holds its job from the moment it is queued, so waiting ones count; the limit is read from the refusal.
 */
const jobLimitWords = (message) => {
  const n = /limit:\s*(\d+)/.exec(message)?.[1]
  return `Too many background tasks in this chat${n ? ` (${n})` : ''}. Wait for one to finish or remove a waiting one, then send it again.`
}

/**
 * What a routed event says a task runs as (router.js routed): the agent that does the work with
 * its model and the effort its first attempt starts at, the planner and the reviewer when the plan
 * has them, the tool tried first when there is one, and `localFirst` when a local model works first
 * and the routed resource takes over if it fails. Kept on the record, so what was said of a task can
 * be set against what it ran.
 */
const planOf = (e) => ({
  agent: e.primary?.agent ?? e.routing?.primaryAgent ?? null,
  model: e.primary?.model ?? null,
  effort: e.primary?.effort ?? null,
  level: e.primary?.level ?? null,
  speed: e.primary?.speed ?? null,
  ...(e.planner ? { planner: { agent: e.planner.agent, model: e.planner.model ?? null } } : {}),
  ...(e.reviewer ? { reviewer: { agent: e.reviewer.agent, model: e.reviewer.model ?? null } } : {}),
  ...(e.tool ? { tool: e.tool } : {}),
  ...(localFirstOf(e) ? { localFirst: true } : {}),
})

/**
 * Whether a routed plan puts a local model to work first, with the routed resource taking over if
 * it fails. The strategy's name is not enough: the router keeps LOCAL_FIRST's local step in front
 * of the routed resource only while that local model could have taken the work itself, and gives
 * the step to the routed resource when a swap moved the work off the local model (a capability it
 * lacks, your feedback): a hand-over is promised only when the worker is not the routed resource
 * (router.js promisedHandOver).
 */
const localFirstOf = (e) => e.plan?.strategy === 'LOCAL_FIRST' && !!e.primary?.agent && !!e.routing?.primaryAgent && e.primary.agent !== e.routing.primaryAgent

/**
 * Which milestone notice a task is owed now, if any (docs/live-agent-view.md Feature 2), from what
 * its start reply named (noteAck: `ackGen`, the routing whose plan it named, 0 for none, and `said`,
 * the agent and effort) against what the router planned (`plan`, `planGen`):
 * - 'again' once a task a read pass handed back (`requeuedAt`) is routed again as work that writes,
 *   whatever its reply named: that was the read pass's plan, or none. A read pass handed back while it
 *   was being routed emits no routed event, so this keys off the hand-back, not off the routing count;
 * - 'started' once the router picks for a task whose reply named no plan;
 * - 'change' when the reply named another agent or effort than the plan it runs;
 * - null while the reply has said nothing yet, before the pick, once the task has ended, and once that
 *   notice has been posted for this routing (`progressPosted`, one of each kind per plan generation).
 * Pure, so the notice scheduler (index.js) and the tests read one rule.
 */
export function startedNoticeDue(t) {
  if (!t || FINISHED.includes(t.state) || t.ackGen == null || !t.plan) return null
  const gen = t.planGen ?? 0
  const posted = (kind) => (t.progressPosted?.[kind] ?? -1) >= gen
  if (t.requeuedAt) return posted('again') ? null : 'again'
  if (!t.said?.agent || !(t.ackGen >= 1)) return posted('started') ? null : 'started'
  const differs = t.said.agent !== t.plan.agent || (t.said.effort ?? null) !== (t.plan.effort ?? null)
  return differs && !posted('change') ? 'change' : null
}

/** What a read pass's measured breach changed, in words: the files, a few at most. */
const breachWords = (b) => {
  const files = b?.changed ?? []
  return `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''} changed in this repository while no other run was going on`
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/**
 * The fields that are written to disk, in one place: the record is the one source of truth.
 * `decider` is who decides the task when it runs (Jev, or Laya from Laya Auto), however long after
 * it was queued: route() then asks whether that one can be asked at all.
 */
const SAVED = [
  'jobId', 'sessionId', 'workspace', 'taskName', 'taskText', 'capability', 'executor', 'agent', 'model',
  'state', 'phase', 'progressText', 'queuedAt', 'startedAt', 'finishedAt', 'terminalReason',
  'deliveryState', 'deliveredAt', 'seq', 'settledSeq', 'effort', 'mode', 'decider', 'finalStatus', 'statusReason', 'modalities',
  // Read-only work: the decider's verdict at intake, whether the task runs as a read pass ('read')
  // or waits in its workspace's line ('write'), why a task judged read only writes, and when a
  // read pass handed it back to its workspace's line.
  'readVerdict', 'access', 'accessWhy', 'requeuedAt',
  // Files the read pass's lock check saw change although no other run went on, when it handed the
  // task back: the task did not leave the folder as it found it, and says so.
  'readBreach',
  // The time it spent back in line after its read pass, which is no part of its running time.
  'inLineMs',
  // Every pass's run id, so the history rows of a read pass and of the pass that writes after it
  // stay the task's own after a restart, when only those rows are left to match.
  'runIds',
  // The task's own id, which no restart hands to another task as the engine does its job id; what
  // the router planned for it when it was last routed; and the intent sample of the message that
  // queued it, which its history row keeps.
  'key', 'plan', 'intentSample',
  // Whether a restart caught the result posted and not yet seen, so that its notice may be in the
  // chat although it is on offer again (reconcile()): no other unread result has one (delivered()).
  'postedBeforeRestart',
  // The milestone notices posted in its chat, each kind by the routing it was posted for
  // (claimNotice()), so a restart never posts one again.
  'progressPosted',
  // Whether its working attempt had started, so a restart that stops it keeps the effort only of
  // one that ran at it (reconcile()).
  'workStarted',
]

/** A record from disk (possibly written by an older version) with every field present. */
const hydrate = (raw) => ({
  ...raw,
  // An older build recorded a settled task as "done"; this build calls that state "completed".
  // Any other value is copied through untouched: not recognising it says nothing about what happened.
  state: raw.state === 'done' ? 'completed' : raw.state,
  taskName: raw.taskName ?? raw.task ?? '',
  taskText: raw.taskText ?? raw.task ?? '',
  capability: raw.capability ?? null,
  executor: raw.executor ?? null,
  phase: raw.phase ?? null,
  progressText: raw.progressText ?? raw.lastLine ?? null,
  terminalReason: raw.terminalReason ?? null,
  deliveryState: raw.deliveryState ?? (raw.announced ? 'delivered' : 'pending'),
  deliveredAt: raw.deliveredAt ?? null,
  seq: raw.seq ?? 1,
  settledSeq: raw.settledSeq ?? 0,
  finalStatus: raw.finalStatus ?? null,
  // Every task before there was a choice was Jev's.
  decider: raw.decider ?? 'jev',
  // Every task before there was a read lane waited in its workspace.
  access: raw.access === 'read' ? 'read' : 'write',
  readVerdict: raw.readVerdict ?? null,
  accessWhy: raw.accessWhy ?? null,
  requeuedAt: raw.requeuedAt ?? null,
  readBreach: raw.readBreach ?? null,
  inLineMs: raw.inLineMs ?? 0,
  runIds: Array.isArray(raw.runIds) ? raw.runIds : raw.runId ? [raw.runId] : null,
  // Every task before there were keys gets one as it loads, so every task has one.
  key: typeof raw.key === 'string' && raw.key ? raw.key : randomUUID(),
  plan: raw.plan ?? null,
  intentSample: raw.intentSample ?? null,
  // A build before this mark put a result a restart caught posted back on offer without one, so any
  // row it wrote may have its notice in the chat.
  postedBeforeRestart: typeof raw.postedBeforeRestart === 'boolean' ? raw.postedBeforeRestart : true,
  progressPosted: raw.progressPosted && typeof raw.progressPosted === 'object' && !Array.isArray(raw.progressPosted) ? raw.progressPosted : {},
  // A row a build before this mark wrote is not known to have run at its effort, so a restart that
  // stops it names none, as that build's result named none.
  workStarted: raw.workStarted === true,
})

/**
 * @param {object} p
 * @param {string} p.file        tasks.jsonl (the whole record, so an interrupted task survives a restart)
 * @param {ReturnType<typeof createLanes>} p.lanes
 * @param {() => object|null} p.jobs   ctx.jobs, or null when this DSH has no job service
 * @param {(t, {signal, emit, onEntry}) => Promise<string>} p.run  runs one task (route()) and returns its report
 * @param {(w: {key: string, workspace: string} & object) => ({lowMs: number|null, highMs: number|null, text: string}|null)} [p.wait]
 *   the estimate of how long a waiting task still waits, handed where it stands (lanes waitOf()),
 *   from waits.js through index.js; none without it
 */
export function createTasks({ file, lanes, jobs: getJobs, run, onSettled, wait, now = Date.now, max = 100, log = () => {} }) {
  const tasks = [] // oldest first
  // Records that came off disk. Only these can be leftovers from a previous process;
  // a task created after this call is this process's own and must not be reconciled.
  const restored = []
  let settledCount = 0
  // Once the plugin closes or is applied again (dispose), the file is rewritten no more: the plugin
  // that replaces this one reads it and writes its own records there, which this store does not hold.
  let disposed = false

  const persist = () => {
    if (disposed) return writing
    const rows = tasks.map((t) => JSON.stringify({
      ...Object.fromEntries(SAVED.map((k) => [k, t[k] ?? null])),
      report: t.report ? clip(t.report, 20_000) : null,
    }))
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, rows.length ? `${rows.join('\n')}\n` : '')
      // A reader that has the destination open makes rename fail on Windows with EPERM/EBUSY.
      // That failure used to drop the whole write, leaving a stale record on disk that a restart
      // would read as the truth. Retry the rename a few times instead of losing it.
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${file}.tmp`, file); break } catch (err) {
          if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err
          await new Promise((r) => setTimeout(r, 5 * (attempt + 1)))
        }
      }
    }).catch((err) => log(`tasks not saved: ${err.message}`))
    return writing
  }
  let writing = Promise.resolve()
  // Progress lines arrive far more often than states change, and the file is rewritten
  // whole. Coalesce them; a state change writes immediately through persist().
  let soon = null
  const persistSoon = () => {
    if (soon) return
    soon = setTimeout(() => { soon = null; persist() }, 500)
    soon.unref?.()
  }
  // Every write asked for so far, a coalesced progress write written now rather than later.
  const flushed = () => {
    if (soon) { clearTimeout(soon); soon = null; persist() }
    return writing
  }

  const ready = readFile(file, 'utf8').then((raw) => {
    let keyed = false
    for (const l of raw.split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(l)
        const t = hydrate(row)
        tasks.push(t)
        restored.push(t)
        keyed ||= t.key !== row.key
      } catch {}
    }
    // trim() is the one rule for dropping rows. Cutting the oldest lines blindly would take
    // finished reports that were never posted, and the next persist() writes that loss back.
    trim()
    return keyed
  }, () => false).then(reconcile)

  /**
   * A record on disk that is not terminal belongs to a process that is gone: DSH jobs do
   * not survive a restart, so that work can never finish. Leaving it "running" would show
   * a task that is silently dead, so it becomes stopped, keeps its last progress line, and
   * stays unread so the person is told what happened to it.
   *
   * A state this build does not know is left alone: not recognising a value says nothing
   * about what happened, and rewriting it would replace a settled outcome with a false one.
   *
   * `keyed` says a record from before there were keys was given one as it loaded, which is saved
   * now, so that record keeps the same key through the next restart as well.
   */
  function reconcile(keyed = false) {
    let touched = keyed
    for (const t of restored) {
      if (!TASK_STATES.includes(t.state) || FINISHED.includes(t.state)) {
        // A result caught mid-delivery by the restart: no append is in flight any more, and
        // nothing says whether the message made it. Offering it again risks the report showing
        // twice; dropping it risks losing it for good, and the spec settles that in favour of
        // retrying until the renderer acknowledges it. It is marked as one whose notice may be in
        // the chat, so the row the browser renders there can still acknowledge it (delivered()).
        if (t.deliveryState === 'delivering') {
          t.deliveryState = 'pending'
          t.postedBeforeRestart = true
          t.seq = (t.seq ?? 1) + 1
          touched = true
        }
        continue
      }
      // One back in line after its read pass, which ran locked, changed nothing either.
      const again = t.state === 'queued' && !!t.startedAt
      const started = !!t.startedAt && !again
      const finishedAt = t.finishedAt ?? now()
      Object.assign(t, {
        state: 'stopped',
        finishedAt,
        // Its time back in line, to the restart, is no part of the time it ran.
        ...(again && t.requeuedAt ? { inLineMs: (t.inLineMs ?? 0) + Math.max(0, finishedAt - t.requeuedAt) } : {}),
        // One that was still in line never ran: nothing in the workspace changed, and its last line
        // is a reason to wait that no longer holds.
        terminalReason: started ? 'interrupted: the app restarted while this task was running'
          : again ? (t.readBreach ? `the app restarted while this task waited in line again after its read pass, during which ${breachWords(t.readBreach)}` : 'the app restarted while this task waited in line again after its read pass, so it changed nothing')
            : 'the app restarted while this task waited in line, so it never started',
        progressText: started ? t.progressText ?? 'Stopped: the app was closed while this task was running' : 'Stopped: the app was closed while this task waited in line',
        ...(started ? {} : { phase: null }),
        // One whose working attempt had not started never ran at the level it was queued at (settle).
        ...(t.workStarted ? {} : { effort: null }),
        // It never had a result, so no notice of it can be in the chat, and nothing posts one now.
        deliveryState: 'pending',
        deliveredAt: null,
        postedBeforeRestart: false,
        seq: (t.seq ?? 1) + 1,
      })
      touched = true
    }
    if (touched) persist()
  }

  const find = (jobId) => tasks.find((t) => t.jobId === jobId)
  // Who hears each task's router events as they happen (watch()), by task key: a set of listeners
  // per task, let go of as the task settles.
  const watchers = new Map()
  const tell = (t, e) => {
    const heard = watchers.get(t.key)
    if (!heard?.size) return
    const seen = view(t)
    for (const fn of [...heard]) {
      // A listener that throws is its own: the task and the others it tells go on.
      try { fn(e, seen) } catch (err) { log(`a watcher of ${t.jobId} failed: ${err.message}`) }
    }
  }
  // Finished tasks are dropped oldest first. Live ones are never dropped - forgetting a running
  // task would lose its result - and neither is a finished one whose result has not been posted
  // yet: dropping that loses the only copy of the report. Bounded in practice by one such record
  // at a time per workspace.
  const trim = () => {
    while (tasks.length > max) {
      const i = tasks.findIndex((t) => FINISHED.includes(t.state) && t.deliveryState === 'delivered')
      if (i < 0) break
      tasks.splice(i, 1)
    }
  }

  /**
   * Move a task to another state, bumping its sequence. Refuses once terminal, so a
   * delayed event cannot regress a settled task. Returns false when refused.
   */
  function transition(t, state, extra = {}) {
    if (!TASK_STATES.includes(state)) throw new Error(`unknown task state: ${state}`)
    if (FINISHED.includes(t.state)) return false
    // Leaving "waiting" is the moment the clock starts, however the task got there.
    const startedAt = t.startedAt ?? (state === 'queued' ? null : now())
    Object.assign(t, { startedAt }, extra, { state, seq: t.seq + 1 })
    persist()
    return true
  }

  /** The phase a router event puts the task in, and the label the list shows. */
  const PHASE_OF = { queued: 'queued', loading: 'routing', start: 'routing', routed: 'running', attempt_start: 'running', checks: 'verifying', review: 'reviewing' }
  const STATE_OF_PHASE = { verifying: 'verifying', reviewing: 'reviewing' }
  /** The roles of an attempt that does the task's work (router.js), as against a plan step, a review or a parallel opinion. */
  const WORK_ROLES = new Set(['primary', 'retry', 'tool'])

  /**
   * One router event for a task: the work agent with its model and effort, the current phase and
   * the latest progress line. Ignored once the task is terminal (see transition).
   */
  function applyEvent(jobId, e) {
    const t = find(jobId)
    if (!t || FINISHED.includes(t.state)) return false
    // A read pass handed the task to its workspace's line: it is waiting again, as work that writes,
    // and the agent, model and effort the read pass took are not the ones it will run with, nor is
    // the plan it was routed with. No working attempt of the pass that writes has started yet. An
    // agent it was queued for (forced) is the one that pass runs on too, so it keeps it, as it keeps
    // the level it was queued at: nobody picks it, and its row and a direct answer say so.
    if (e.type === 'access' && e.mode === 'write' && t.access === 'read') {
      Object.assign(t, { access: 'write', accessWhy: e.why ?? null, readBreach: e.breach ?? null, agent: t.askedAgent ?? null, model: null, effort: t.askedEffort ?? null, workStarted: false, plan: null })
      transition(t, 'queued', { phase: 'queued', requeuedAt: now() })
    }
    if (e.type === 'final') {
      t.finalStatus = e.status ?? null
      // Why the run ended the way it did. Without this the row could say "Needs input" and
      // nothing about what the person is being asked, which is the only useful part.
      t.statusReason = e.statusReason ?? null
    }
    if (e.type === 'routed') {
      // The agent that does the work, as the plan names it (planOf), with no effort until its working
      // attempt starts at its own: the level the task was queued at is not the one any attempt starts
      // at. That is the plan's worker, not the routing's pick: a LOCAL_FIRST plan keeps a local model
      // in front of the routed resource, which works only if the local model fails, so the row, what a
      // direct answer is told and the result name the local model the start reply named, from the
      // pick on, and not only once its attempt starts after the baseline checks. A run the router
      // stops for a person runs no agent (router.js stopsForPerson), so it takes none from the
      // routing, whom the decider would have picked, and no model either: its result names nobody, as
      // its reply did.
      if (e.stopsForPerson) Object.assign(t, { agent: null, model: null })
      else t.agent = e.tool ? `tool:${e.tool}` : e.primary?.agent ?? e.routing?.primaryAgent ?? t.agent
      t.effort = null
      // What the request turned out to need, recorded on the one canonical record.
      if (e.routing?.capability) t.capability = e.routing.capability
      // What it runs as, and which of the task's routings this is: a task a read pass hands back
      // after it was routed (its agent said it needs to change files or could not be started
      // locked, or no agent that can be locked was left to try) is routed again as work that
      // writes, its second; one handed back while it was being routed (the routing named work that
      // may write, or picked an agent that cannot be locked, or no agent could be locked at all)
      // emits no routed event then, and is routed once. A run the router stops for a person runs
      // nothing (router.js stopsForPerson), so it has no plan: no reply names one, and no notice
      // says one started.
      t.plan = e.stopsForPerson ? null : planOf(e)
      if (t.plan) t.planGen = (t.planGen ?? 0) + 1
    }
    // Work roles only. This used to take every attempt, so a run that ended in a review
    // reported the reviewer as the agent, and the list said "claude" for work deepseek did; the
    // model and effort went on doing so, and named the worker with its reviewer's model and effort
    // in the list and in the result's head. The effort is the one the work attempt starts at, none
    // for an agent that takes none (a local model, a tool), whatever level the task was queued
    // with; the model, which only the attempt's end records, is never another agent's.
    if (e.type === 'attempt_start' && WORK_ROLES.has(e.role)) {
      if (e.agent !== t.agent) t.model = null
      Object.assign(t, { agent: e.agent, effort: e.effort ?? null, workStarted: true })
    }
    // An end that names no role is taken as the work's, as every end was before.
    if (e.type === 'attempt_end' && (e.attempt?.role == null || WORK_ROLES.has(e.attempt.role))) {
      t.model = e.attempt?.model ?? t.model
      Object.assign(t, { effort: e.attempt?.effort ?? null, workStarted: true })
    }
    const phase = PHASE_OF[e.type]
    if (phase) {
      t.phase = phase
      // Verifying and reviewing are states, not just labels: the list shows them as work
      // in progress, and they move back to running when the run goes back to the agent.
      if (STATE_OF_PHASE[phase]) transition(t, STATE_OF_PHASE[phase])
      // An event from a task that has not been marked as started yet still means it is
      // running, so the clock starts here rather than only in onEntry.
      else if (phase === 'running' && t.state !== 'running') transition(t, 'running')
      else { t.seq += 1; persistSoon() }
    } else {
      t.seq += 1
      persistSoon()
    }
    t.progressText = e.text ?? (typeof line === 'function' ? line(e) : e.type)
    persistSoon()
    return true
  }

  /**
   * Start `task` as a background job owned by `owner` (the session's live root agent).
   * Returns the task, or null when background jobs are unavailable (caller runs it blocking).
   */
  function enqueue({ owner, sessionId, workspace, task, forceAgent, effort, mode, decider, capability, taskName, executor, agent, modalities, readVerdict, access, accessWhy, intentSample }) {
    const jobs = getJobs()
    if (!jobs) return null
    const ac = new AbortController()
    let finish
    const done = new Promise((r) => { finish = r })
    const t = {
      // Minted here, never reused: the engine counts job ids from 1 again after a restart.
      key: randomUUID(), plan: null, planGen: 0, intentSample: intentSample ?? null,
      // What its start reply named, once it is out (noteAck()), and the milestone notices posted since.
      ackGen: null, said: null, progressPosted: {},
      jobId: null, sessionId, workspace,
      taskName: taskName ?? clip(String(task).replace(/\s+/g, ' '), 80), taskText: task, task,
      capability: capability ?? null, executor: executor ?? null, modalities: modalities ?? ['text'],
      state: 'queued', phase: 'queued', agent: agent ?? forceAgent ?? null, model: null, mode: mode ?? 'auto', decider: decider ?? 'jev', effort: effort && effort !== 'auto' ? effort : null,
      // The effort it was queued with, kept for a writer pass after a read pass took another.
      askedEffort: effort && effort !== 'auto' ? effort : null,
      // The agent it was queued for, when it was forced to one, kept the same way.
      askedAgent: agent ?? forceAgent ?? null,
      // Whether a working attempt has started at its own effort (applyEvent): until one has, the
      // effort shown is the level it was queued at, which a task that ends first never ran at (settle).
      workStarted: false,
      readVerdict: readVerdict ?? null, access: access === 'read' ? 'read' : 'write', accessWhy: accessWhy ?? null, requeuedAt: null, inLineMs: 0,
      queuedAt: now(), startedAt: null, finishedAt: null, terminalReason: null, finalStatus: null,
      progressText: 'Waiting', lastLine: 'Waiting', report: null, runId: null,
      deliveryState: 'pending', deliveredAt: null, postedBeforeRestart: false, seq: 1, settledSeq: 0,
      owner, ac, out: '',
    }
    let cursor = 0
    let id
    try {
      id = jobs.start({
        kind: 'jev', label: clip(t.taskName, 80), owner,
        run: () => ({
          cancel: (reason) => ac.abort(reason instanceof Error ? reason : new Error(String(reason ?? 'stopped'))),
          done,
          // Drop what was read: the string would otherwise hold every line of a long run
          // for as long as the task entry lives.
          readOutput: () => { const s = t.out.slice(cursor); t.out = ''; cursor = 0; return s },
        }),
      })
    } catch (err) {
      if (/unavailable|job controller/i.test(err.message)) return null
      // The engine's own words tell a model to use job_kill; a person is told what they can do.
      if (/job limit reached/i.test(err.message)) throw new Error(jobLimitWords(err.message), { cause: err })
      throw err
    }
    t.jobId = id
    // Hold a waiter on this job for its whole life. The job service marks a job that has
    // waiters as already reported when it settles, which is what stops tool-jobs posting its
    // own notice - that notice would wake the model for a result this plugin delivers itself.
    try { jobs.wait?.(id, 86_400_000, owner)?.catch?.(() => {}) } catch {}
    for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].jobId === id) tasks.splice(i, 1) // an id reused after a restart
    tasks.push(t)
    persist()
    trim()
    const say = (text) => { t.progressText = text; t.out += `${text}\n` }
    // Whoever watches the task hears each event once the record holds it.
    const emit = (e) => {
      applyEvent(t.jobId, e)
      say(e.text ?? line(e))
      tell(t, e)
    }
    const settle = (state, report, detail) => {
      if (FINISHED.includes(t.state)) return // idempotent: a second settle cannot re-report
      Object.assign(t, {
        state, report: report ? clip(report, 20_000) : null, finishedAt: now(),
        // A real failure or a user stop explains itself; otherwise the router's own reason for
        // stopping early (needs a person, paused at a limit) is the explanation.
        terminalReason: detail ?? t.statusReason ?? null, settledSeq: ++settledCount, seq: t.seq + 1,
        // One that is waiting when it ends, a task back in line after its read pass included, keeps
        // no Waiting phase: the row would read Stopped and Waiting at once.
        ...(t.startedAt && t.state !== 'queued' ? {} : { phase: null }),
        ...(t.startedAt && t.state === 'queued' && t.requeuedAt ? { inLineMs: (t.inLineMs ?? 0) + now() - t.requeuedAt } : {}),
        // One that ends before its working attempt starts (removed from the line, refused before it
        // was routed, a forced agent included) never ran at the level it was queued at, so its row
        // and its result name no effort.
        ...(t.workStarted ? {} : { effort: null }),
      })
      if (report) t.out += `\n${report}\n`
      say({ completed: 'Done', needs_human: 'Needs input', paused_limit: 'Paused: agents at their limits', failed: `Failed: ${detail ?? ''}`, stopped: 'Stopped' }[state] ?? state)
      persist()
      finish({ status: JOB_STATUS[state] ?? 'completed', ...(report ? { output: report } : {}), ...(detail ? { detail } : {}) })
      // Its watchers hear that it ended, once, and are let go: nothing more is said of a settled task.
      tell(t, { type: 'settled', state })
      watchers.delete(t.key)
      // Hand the finished result to whoever owns the conversation. It is delivered outside the
      // job, and a failure there must never stop the task from settling.
      try { onSettled?.(resultOf(t), t.owner) } catch (err) { log(`result ${t.jobId} not handed over: ${err.message}`) }
    }
    // Started here, not a tick later: run() joins the task's line before it does anything else, so
    // by the time enqueue returns the task's place is read off the line (the chat's queued line
    // says what the work board will), never predicted.
    let running
    try {
      running = Promise.resolve(run(t, {
        signal: ac.signal,
        emit,
        onEntry: (entry) => {
          // The lane let it through and the run has really begun: the wait line is no longer true.
          // A writer pass after a read pass keeps the first start: the task began then, and its
          // time back in line between the two is kept apart (inLineMs), no part of its running time.
          // Every pass's run id is kept, so no view shows a pass this task owns as a run of its own.
          transition(t, 'routing', {
            startedAt: t.startedAt ?? now(), runId: entry?.id ?? null, runIds: [...(t.runIds ?? []), ...(entry?.id ? [entry.id] : [])], phase: 'routing',
            ...(t.state === 'queued' && t.requeuedAt ? { inLineMs: (t.inLineMs ?? 0) + now() - t.requeuedAt } : {}),
          })
          say('Starting')
        },
      }))
    } catch (err) { running = Promise.reject(err) }
    running
      .then(
        (report) => settle(t.finalStatus ? terminalOf(t.finalStatus) : 'completed', report),
        // A task stopped before the lane let it in never ran, and its message says so: nothing in
        // the workspace can have changed, which a person deciding whether to look should know.
        (err) => (ac.signal.aborted
          ? settle('stopped', null, !t.startedAt ? 'removed from the line before it started' : t.state === 'queued' ? (t.readBreach ? `removed from the line after its read pass, during which ${breachWords(t.readBreach)}` : 'removed from the line after its read pass, before it changed anything') : 'stopped by the user')
          : settle('failed', `jev-router: ${err?.message ?? err}`, err?.message ?? String(err))),
      )
    return t
  }

  const position = (t) => (t.state === 'queued' ? lanes.position(laneOf(t), t.jobId) : t.state === 'running' || t.state === 'routing' || t.state === 'verifying' || t.state === 'reviewing' ? 0 : null)
  /**
   * What a waiting task waits for and where it stands, read off the line as it is now: the task list
   * polls it, so the words follow the line as it moves. `placeText` is the meta line's words for its
   * place, `reason` the sentence for why, `estimate` how long it may still wait with its basis in
   * its own text (or null), and `text` the whole line the row shows. `since` is when it joined this
   * line: when it was queued, or when a read pass handed it back to its workspace's line.
   * Null for a task that is not waiting in a line (yet, or any more).
   */
  const waitingOf = (t) => {
    if (t.state !== 'queued') return null
    const key = laneOf(t)
    const w = lanes.waitOf(key, t.jobId)
    if (!w) return null
    let estimate = null
    let failed = false
    // An estimate is extra: one that cannot be made must never take the task list down with it, and
    // is never silently missing either: the line says it failed, where a short record says nothing.
    try { estimate = wait?.({ key, workspace: t.workspace, ...w }) ?? null } catch (err) { failed = true; log(`no wait estimate for ${t.jobId}: ${err.message}`) }
    const reason = WAITING[w.why]
    const facts = [slotFacts(w), failed ? 'No estimate: working it out failed, and the server log says why.' : ''].filter(Boolean).join(' ')
    // Only plain fields reach the list: who holds the lane and who waits in front are the
    // estimate's inputs, not the view's.
    const { holder, aheadWho, held, ...seen } = w
    return { ...seen, since: t.requeuedAt ?? t.queuedAt, placeText: placeText(w), reason, facts, estimate, text: waitText(reason, estimate, facts) }
  }
  // How long a task has run: none while it waits, a task back in line after its read pass included,
  // since it is not running; its time back in line is left out once it runs again or ends.
  const ranMs = (t) => (t.startedAt && t.state !== 'queued' ? (t.finishedAt ?? now()) - t.startedAt - (t.inLineMs ?? 0) : null)
  const view = (t) => ({
    key: t.key, jobId: t.jobId, sessionId: t.sessionId, workspace: t.workspace,
    task: t.taskText, taskName: t.taskName, taskText: t.taskText,
    capability: t.capability, executor: t.executor,
    state: t.state, status: t.state, phase: t.phase, position: position(t), queuePosition: position(t),
    mode: t.mode, decider: t.decider, agent: t.agent, model: t.model, effort: t.effort,
    plan: t.plan ?? null, planGen: t.planGen ?? 0,
    ackGen: t.ackGen ?? null, said: t.said ?? null, progressPosted: t.progressPosted ?? {},
    readVerdict: t.readVerdict, access: t.access, accessWhy: t.accessWhy, requeuedAt: t.requeuedAt, readBreach: t.readBreach ?? null, inLineMs: t.inLineMs ?? 0,
    queuedAt: t.queuedAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    terminalReason: t.terminalReason, finalStatus: t.finalStatus, statusReason: t.statusReason,
    progressText: t.progressText, lastLine: t.progressText,
    reportAvailable: !!t.report, runId: t.runId, runIds: t.runIds ?? (t.runId ? [t.runId] : []),
    deliveryState: t.deliveryState, deliveredAt: t.deliveredAt, seq: t.seq,
    durationMs: ranMs(t),
    waiting: waitingOf(t),
  })

  /** What the chat needs to render one finished task as its own message, the effort and how long it ran included. */
  const resultOf = (t) => ({
    jobId: t.jobId, sessionId: t.sessionId, workspace: t.workspace,
    task: t.taskText, taskName: t.taskName, capability: t.capability,
    agent: t.agent, model: t.model, effort: t.effort ?? null, decider: t.decider, state: t.state, status: t.state,
    terminalReason: t.terminalReason, finalStatus: t.finalStatus,
    report: t.report,
    finishedAt: t.finishedAt, queuedAt: t.queuedAt, durationMs: ranMs(t), deliveryState: t.deliveryState, seq: t.seq,
  })

  /**
   * Finished results of this session that are not in the conversation yet, in the order they
   * finished. `delivering` is deliberately NOT offered: by then the message exists, and
   * offering it again would post the same report twice. Reading does not consume - a turn
   * that dies before the message is out must not lose the only copy.
   */
  const unread = (sessionId) => tasks
    .filter((t) => t.sessionId === sessionId && FINISHED.includes(t.state) && t.deliveryState === 'pending')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || (a.settledSeq ?? 0) - (b.settledSeq ?? 0))

  return {
    ready,
    /**
     * Resolves once every write asked for so far has landed or failed and been logged, a progress
     * write still waiting to be coalesced included (it is written now rather than in half a
     * second). This is how to know the file holds the latest state: polling the file races the
     * writer, and on Windows a reader holding the file open is exactly what makes its rename fail.
     */
    flushed,
    /**
     * The plugin is closing or applied again: every write asked for so far, a progress write still
     * waiting to be coalesced included, goes to the file, and none after it. A task that settles
     * later and every other change are kept in memory only, since a rewrite from them would put back
     * what this store holds over the records the plugin that replaces it has written, and no result
     * or notice is claimed after, since its claim could not be saved. Resolves once those writes have
     * landed or failed and been logged.
     */
    dispose() {
      const last = flushed()
      disposed = true
      return last
    },
    enqueue,
    applyEvent,
    /**
     * Hear the router events of the task with this key as they happen: `fn(event, task)`, with the
     * task as the list shows it once the event is on its record. As the task settles `fn` hears
     * `{ type: 'settled', state }` once more and is let go, so nothing is kept for a task that has
     * ended. Returns the unsubscribe; a key naming no task still waiting or running hears nothing.
     */
    watch(key, fn) {
      const t = tasks.find((x) => x.key === key)
      if (!t || FINISHED.includes(t.state) || typeof fn !== 'function') return () => {}
      if (!watchers.has(key)) watchers.set(key, new Set())
      const heard = watchers.get(key)
      // A listener of its own per call, so a function watching twice is let go by each call alone.
      const listener = (e, seen) => fn(e, seen)
      heard.add(listener)
      return () => { heard.delete(listener); if (!heard.size && watchers.get(key) === heard) watchers.delete(key) }
    },
    /** How many listeners watch tasks now (watch()): none once every task watched has settled. */
    get watching() {
      let n = 0
      for (const heard of watchers.values()) n += heard.size
      return n
    },
    /**
     * What the start reply named of the task with this key, once it is out: `gen`, the routing whose
     * plan it named (1 for a forced agent's plan or a pick it waited for, 0 for none), and `said`, the
     * agent and effort it named. Until this is noted no milestone notice is due (startedNoticeDue).
     * False for a key that names no task still waiting or running.
     */
    noteAck(key, { gen = 0, said = null } = {}) {
      const t = tasks.find((x) => x.key === key)
      if (!t || FINISHED.includes(t.state)) return false
      t.ackGen = Number.isInteger(gen) && gen >= 0 ? gen : 0
      t.said = typeof said?.agent === 'string' && said.agent ? { agent: said.agent, effort: said.effort ?? null } : null
      return true
    },
    /**
     * Claim the milestone notice of `kind` for the task's current routing. Only the first caller gets
     * true, so two triggers at once cannot post one notice twice, and the claim is saved
     * (progressPosted), so a restart never posts it again. False for a key that names no task still
     * waiting or running.
     */
    claimNotice(key, kind) {
      const t = tasks.find((x) => x.key === key)
      // A store disposed of could not save the claim, so it makes none.
      if (disposed || !t || FINISHED.includes(t.state) || typeof kind !== 'string' || !kind) return false
      const gen = t.planGen ?? 0
      if ((t.progressPosted?.[kind] ?? -1) >= gen) return false
      t.progressPosted = { ...(t.progressPosted ?? {}), [kind]: gen }
      persist()
      return true
    },
    /** The task with this key as the list shows it, or null: a key, unlike a job id, is never handed out twice. */
    byKey: (key) => { const t = tasks.find((x) => x.key === key); return t ? view(t) : null },
    get: (jobId) => { const t = find(jobId); return t ? view(t) : null },
    list: () => tasks.map(view),
    report: (jobId) => find(jobId)?.report ?? null,
    /**
     * Finished results of this session that have not been shown yet, in the order they
     * finished. Reading does NOT consume: a turn that dies before the result reaches the
     * person must not lose the only copy. The caller marks each one delivered once the
     * conversation has accepted its message.
     */
    results: (sessionId) => unread(sessionId).map(resultOf),
    /**
     * Claim a result for delivery. This is a claim, not a flag: only the caller that moves it
     * out of `pending` gets true, so two attempts racing to post the same result cannot both
     * append it. The append itself happens after this returns.
     */
    delivering(jobId) {
      const t = find(jobId)
      // A store disposed of could not save the claim, and a result posted without it would read as
      // never posted once the plugin starts again, so nothing is claimed: it stays unread on disk.
      if (disposed || !t || t.deliveryState !== 'pending') return false
      t.deliveryState = 'delivering'
      persist()
      return true
    },
    /**
     * The conversation has taken the result's message. This is the only thing that marks a
     * result read, so a duplicate notice can retry delivery without the report ever being
     * shown twice. Safe to call twice.
     *
     * Only a result whose notice can be in the chat is taken: one claimed for delivery (delivering()),
     * or one a restart caught posted and not yet seen (postedBeforeRestart). A task still waiting or
     * running has no result, and any other unread one has no notice: it waits to be posted, its post
     * failed, or the app closed before it was posted (a task the restart stopped included), after
     * which nothing posts it. All of them are refused: the engine hands a job id out again after a
     * restart, and an old notice in the chat under that id, even one naming the same task, must never
     * mark the new task's result read before it has posted. `name`, when given, must also be the
     * task's own as its notice summary carries it (nameKey), and `sessionId`, when given, the chat the
     * task is in, since another chat can hold such an old notice too.
     */
    delivered(jobId, { name, sessionId } = {}) {
      const t = find(jobId)
      if (!t || !FINISHED.includes(t.state)) return false
      if (typeof name === 'string' && nameKey(name) !== nameKey(t.taskName)) return false
      if (typeof sessionId === 'string' && sessionId !== t.sessionId) return false
      if (t.deliveryState === 'delivered') return false
      if (t.deliveryState === 'pending' && !t.postedBeforeRestart) return false
      t.deliveryState = 'delivered'
      t.deliveredAt = now()
      persist()
      try { getJobs()?.read(t.jobId, t.owner) } catch {} // marks the job reported, so no second notice
      return true
    },
    /** The append failed, so no message was created: put it back on offer. */
    undeliver(jobId) {
      const t = find(jobId)
      if (!t || t.deliveryState === 'delivered') return false
      t.deliveryState = 'pending'
      persist()
      return true
    },
    /**
     * Stop a task. `onlyIfWaiting` is Remove: a task that left the line and started while the person
     * was confirming is not stopped under words that said nothing had changed ('started').
     */
    stop(jobId, { onlyIfWaiting = false } = {}) {
      const t = find(jobId)
      if (!t) throw Object.assign(new Error('no task with that id'), { status: 404 })
      if (FINISHED.includes(t.state)) return 'already-finished'
      if (onlyIfWaiting && t.state !== 'queued') return 'started'
      try { getJobs()?.kill(jobId, t.owner, 'stopped by the user') } catch {}
      // A record restored from disk has no live controller: there is nothing running to abort.
      t.ac?.abort(new Error('stopped by the user'))
      return 'requested'
    },
    /** Stop the task whose inspector run id is `runId` (the inspector's Stop button). */
    stopRun(runId) {
      const t = tasks.find((x) => x.runId === runId && !FINISHED.includes(x.state))
      return t ? this.stop(t.jobId) : null
    },
    reorder(workspace, order) {
      if (typeof workspace !== 'string' || !workspace) throw new Error('workspace: the task folder')
      validJobIds(order)
      // A read-only task waits for a slot of its own, not in this line, so it has no place in it.
      const reads = order.filter((id) => find(id)?.access === 'read')
      if (reads.length) throw new Error(`a read-only task waits for a slot of its own, not in this workspace's line: ${reads.join(', ')}`)
      lanes.reorder(laneKey(workspace), order)
    },
    clear(jobIds) {
      validJobIds(jobIds)
      const gone = new Set(jobIds.filter((id) => FINISHED.includes(find(id)?.state)))
      for (let i = tasks.length - 1; i >= 0; i--) if (gone.has(tasks[i].jobId) && FINISHED.includes(tasks[i].state)) tasks.splice(i, 1)
      persist()
      return [...gone]
    },
  }
}
