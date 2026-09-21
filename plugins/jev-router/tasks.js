// Non-blocking orchestration: routed tasks run as DSH background jobs, one at a
// time per workspace (a lane), while the chat stays free.
//
// One task is one record. The task list and the chat both read that record, so the
// row and the delivered message can never disagree, and a result stays unread until
// the conversation has actually taken it.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { line } from './adapter.js'

export const laneKey = (cwd) => resolve(cwd).toLowerCase()

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
 * One lane per workspace: a holder and a reorderable waiting line.
 * acquire() resolves with release() when it is this id's turn; an abort while waiting rejects.
 */
export function createLanes() {
  const lanes = new Map() // key -> { holder: id | null, waiting: [{ id, go }] }
  const get = (k) => { if (!lanes.has(k)) lanes.set(k, { holder: null, waiting: [] }); return lanes.get(k) }
  const next = (k) => {
    const l = lanes.get(k)
    if (!l || l.holder) return
    if (!l.waiting.length) { lanes.delete(k); return }
    const w = l.waiting.shift()
    l.holder = w.id
    w.go()
  }
  return {
    acquire(k, id, signal) {
      return new Promise((res, rej) => {
        if (signal?.aborted) return rej(signal.reason ?? new DOMException('Stopped', 'AbortError'))
        const l = get(k)
        const onAbort = () => {
          const i = l.waiting.indexOf(w)
          if (i >= 0) { l.waiting.splice(i, 1); next(k); rej(signal.reason ?? new DOMException('Stopped', 'AbortError')) }
        }
        const w = {
          id,
          go: () => {
            signal?.removeEventListener('abort', onAbort)
            let released = false
            res(() => { if (released) return; released = true; l.holder = null; next(k) })
          },
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        l.waiting.push(w)
        next(k)
      })
    },
    busy: (k) => !!lanes.get(k)?.holder,
    /** 0 = running, 2 = first behind the running one ("2nd in line"), -1 = not in this lane. */
    position(k, id) {
      const l = lanes.get(k)
      if (!l) return -1
      if (l.holder === id) return 0
      const i = l.waiting.findIndex((w) => w.id === id)
      return i < 0 ? -1 : i + 1 + (l.holder ? 1 : 0)
    },
    /** Waiting ids in `order` first (in that order), the rest after, unchanged. */
    reorder(k, order) {
      const l = lanes.get(k)
      const ids = new Set(l?.waiting.map((w) => w.id) ?? [])
      const unknown = order.filter((id) => !ids.has(id))
      if (unknown.length) throw new Error(`not waiting in this workspace: ${unknown.join(', ')}`)
      const rank = new Map(order.map((id, i) => [id, i]))
      l.waiting.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    },
  }
}

/** Serialize async sections (set process env + start a subagent). */
export function createMutex() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn)
    tail = run.catch(() => {})
    return run
  }
}

const JOB_ID = /^[a-z][\w-]{0,40}$/
/** Body list of job ids: 1-100 short ids. Throws otherwise. */
export function validJobIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((x) => typeof x === 'string' && JOB_ID.test(x))) throw new Error('jobIds: array of 1-100 job ids')
  return ids
}
export const validJobId = (id) => validJobIds([id])[0]

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/** The fields that are written to disk, in one place: the record is the one source of truth. */
const SAVED = [
  'jobId', 'sessionId', 'workspace', 'taskName', 'taskText', 'capability', 'executor', 'agent', 'model',
  'state', 'phase', 'progressText', 'queuedAt', 'startedAt', 'finishedAt', 'terminalReason',
  'deliveryState', 'deliveredAt', 'seq', 'settledSeq', 'effort', 'mode', 'finalStatus', 'statusReason', 'modalities',
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
})

/**
 * @param {object} p
 * @param {string} p.file        tasks.jsonl (the whole record, so an interrupted task survives a restart)
 * @param {ReturnType<typeof createLanes>} p.lanes
 * @param {() => object|null} p.jobs   ctx.jobs, or null when this DSH has no job service
 * @param {(t, {signal, emit, onEntry}) => Promise<string>} p.run  runs one task (route()) and returns its report
 */
export function createTasks({ file, lanes, jobs: getJobs, run, onSettled, now = Date.now, max = 100, log = () => {} }) {
  const tasks = [] // oldest first
  // Records that came off disk. Only these can be leftovers from a previous process;
  // a task created after this call is this process's own and must not be reconciled.
  const restored = []
  let settledCount = 0

  const persist = () => {
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

  const ready = readFile(file, 'utf8').then((raw) => {
    for (const l of raw.split('\n').filter(Boolean)) {
      try { const t = hydrate(JSON.parse(l)); tasks.push(t); restored.push(t) } catch {}
    }
    // trim() is the one rule for dropping rows. Cutting the oldest lines blindly would take
    // finished reports that were never posted, and the next persist() writes that loss back.
    trim()
  }, () => {}).then(reconcile)

  /**
   * A record on disk that is not terminal belongs to a process that is gone: DSH jobs do
   * not survive a restart, so that work can never finish. Leaving it "running" would show
   * a task that is silently dead, so it becomes stopped, keeps its last progress line, and
   * stays unread so the person is told what happened to it.
   *
   * A state this build does not know is left alone: not recognising a value says nothing
   * about what happened, and rewriting it would replace a settled outcome with a false one.
   */
  function reconcile() {
    let touched = false
    for (const t of restored) {
      if (!TASK_STATES.includes(t.state) || FINISHED.includes(t.state)) {
        // A result caught mid-delivery by the restart: no append is in flight any more, and
        // nothing says whether the message made it. Offering it again risks the report showing
        // twice; dropping it risks losing it for good, and the spec settles that in favour of
        // retrying until the renderer acknowledges it.
        if (t.deliveryState === 'delivering') {
          t.deliveryState = 'pending'
          t.seq = (t.seq ?? 1) + 1
          touched = true
        }
        continue
      }
      Object.assign(t, {
        state: 'stopped',
        finishedAt: t.finishedAt ?? now(),
        terminalReason: 'interrupted: the app restarted while this task was running',
        progressText: t.progressText ?? 'Stopped: the app was closed while this task was running',
        deliveryState: 'pending',
        deliveredAt: null,
        seq: (t.seq ?? 1) + 1,
      })
      touched = true
    }
    if (touched) persist()
  }

  const find = (jobId) => tasks.find((t) => t.jobId === jobId)
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

  /**
   * One router event for a task: the work agent, the model, the current phase and the
   * latest progress line. Ignored once the task is terminal (see transition).
   */
  function applyEvent(jobId, e) {
    const t = find(jobId)
    if (!t || FINISHED.includes(t.state)) return false
    if (e.type === 'final') {
      t.finalStatus = e.status ?? null
      // Why the run ended the way it did. Without this the row could say "Needs input" and
      // nothing about what the person is being asked, which is the only useful part.
      t.statusReason = e.statusReason ?? null
    }
    if (e.type === 'routed') {
      t.agent = e.tool ? `tool:${e.tool}` : e.routing?.primaryAgent ?? t.agent
      // What the request turned out to need, recorded on the one canonical record.
      if (e.routing?.capability) t.capability = e.routing.capability
    }
    // Work roles only. This used to take every attempt, so a run that ended in a review
    // reported the reviewer as the agent, and the list said "claude" for work deepseek did.
    if (e.type === 'attempt_start' && (e.role === 'primary' || e.role === 'retry')) t.agent = e.agent
    if (e.type === 'attempt_end') {
      t.model = e.attempt?.model ?? t.model
      t.effort = e.attempt?.effort ?? t.effort
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
  function enqueue({ owner, sessionId, workspace, task, forceAgent, effort, mode, capability, taskName, executor, agent, modalities }) {
    const jobs = getJobs()
    if (!jobs) return null
    const ac = new AbortController()
    let finish
    const done = new Promise((r) => { finish = r })
    const t = {
      jobId: null, sessionId, workspace,
      taskName: taskName ?? clip(String(task).replace(/\s+/g, ' '), 80), taskText: task, task,
      capability: capability ?? null, executor: executor ?? null, modalities: modalities ?? ['text'],
      state: 'queued', phase: 'queued', agent: agent ?? forceAgent ?? null, model: null, mode: mode ?? 'auto', effort: effort && effort !== 'auto' ? effort : null,
      queuedAt: now(), startedAt: null, finishedAt: null, terminalReason: null, finalStatus: null,
      progressText: 'Waiting', lastLine: 'Waiting', report: null, runId: null,
      deliveryState: 'pending', deliveredAt: null, seq: 1, settledSeq: 0,
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
    const emit = (e) => {
      applyEvent(t.jobId, e)
      say(e.text ?? line(e))
    }
    const settle = (state, report, detail) => {
      if (FINISHED.includes(t.state)) return // idempotent: a second settle cannot re-report
      Object.assign(t, {
        state, report: report ? clip(report, 20_000) : null, finishedAt: now(),
        // A real failure or a user stop explains itself; otherwise the router's own reason for
        // stopping early (needs a person, paused at a limit) is the explanation.
        terminalReason: detail ?? t.statusReason ?? null, settledSeq: ++settledCount, seq: t.seq + 1,
      })
      if (report) t.out += `\n${report}\n`
      say({ completed: 'Done', needs_human: 'Needs input', paused_limit: 'Paused: agents at their limits', failed: `Failed: ${detail ?? ''}`, stopped: 'Stopped' }[state] ?? state)
      persist()
      finish({ status: JOB_STATUS[state] ?? 'completed', ...(report ? { output: report } : {}), ...(detail ? { detail } : {}) })
      // Hand the finished result to whoever owns the conversation. It is delivered outside the
      // job, and a failure there must never stop the task from settling.
      try { onSettled?.(resultOf(t), t.owner) } catch (err) { log(`result ${t.jobId} not handed over: ${err.message}`) }
    }
    Promise.resolve()
      .then(() => run(t, {
        signal: ac.signal,
        emit,
        onEntry: (entry) => {
          // The lane let it through and the run has really begun.
          transition(t, 'routing', { startedAt: now(), runId: entry?.id ?? null })
        },
      }))
      .then(
        (report) => settle(t.finalStatus ? terminalOf(t.finalStatus) : 'completed', report),
        (err) => (ac.signal.aborted
          ? settle('stopped', null, 'stopped by the user')
          : settle('failed', `jev-router: ${err?.message ?? err}`, err?.message ?? String(err))),
      )
    return t
  }

  const position = (t) => (t.state === 'queued' ? lanes.position(laneKey(t.workspace), t.jobId) : t.state === 'running' || t.state === 'routing' || t.state === 'verifying' || t.state === 'reviewing' ? 0 : null)
  const view = (t) => ({
    jobId: t.jobId, sessionId: t.sessionId, workspace: t.workspace,
    task: t.taskText, taskName: t.taskName, taskText: t.taskText,
    capability: t.capability, executor: t.executor,
    state: t.state, status: t.state, phase: t.phase, position: position(t), queuePosition: position(t),
    mode: t.mode, agent: t.agent, model: t.model, effort: t.effort,
    queuedAt: t.queuedAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    terminalReason: t.terminalReason, finalStatus: t.finalStatus, statusReason: t.statusReason,
    progressText: t.progressText, lastLine: t.progressText,
    reportAvailable: !!t.report, runId: t.runId,
    deliveryState: t.deliveryState, deliveredAt: t.deliveredAt, seq: t.seq,
    durationMs: t.startedAt ? (t.finishedAt ?? now()) - t.startedAt : null,
  })

  /** What the chat needs to render one finished task as its own message. */
  const resultOf = (t) => ({
    jobId: t.jobId, sessionId: t.sessionId, workspace: t.workspace,
    task: t.taskText, taskName: t.taskName, capability: t.capability,
    agent: t.agent, model: t.model, state: t.state, status: t.state,
    terminalReason: t.terminalReason, finalStatus: t.finalStatus,
    report: t.report,
    finishedAt: t.finishedAt, queuedAt: t.queuedAt, deliveryState: t.deliveryState, seq: t.seq,
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
    enqueue,
    applyEvent,
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
      if (!t || t.deliveryState !== 'pending') return false
      t.deliveryState = 'delivering'
      persist()
      return true
    },
    /**
     * The conversation has taken the result's message. This is the only thing that marks a
     * result read, so a duplicate notice can retry delivery without the report ever being
     * shown twice. Safe to call twice.
     */
    delivered(jobId) {
      const t = find(jobId)
      if (!t) return false
      if (t.deliveryState === 'delivered') return false
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
    stop(jobId) {
      const t = find(jobId)
      if (!t) throw Object.assign(new Error('no task with that id'), { status: 404 })
      if (FINISHED.includes(t.state)) return 'already-finished'
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
