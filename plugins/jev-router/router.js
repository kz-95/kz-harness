// Routing loop: context -> Jev route -> agent -> deterministic checks -> Jev
// assessment -> accept / second review / retry / human, bounded by limits.
// Dependencies are injected so the loop runs the same in DSH and in tests.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createReview } from '../jev-review/index.js'
import { assertWorkspace, changedSince, compareChecks, ensureHandoffIgnored, gatherContext, runChecks, snapshot } from './workspace.js'

const pct = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a')
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5)
/** Earliest known reset among `{ until }` entries, or null. */
const earliest = (list) => list.map((x) => x.until).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
export const HANDOFF = '.kz-harness/handoff.md'
const OUT_STATES = ['stopped', 'exhausted']
const PEERS = { claude: 'codex', codex: 'claude' }

function describeError(err) {
  // Class name + message only; SDK errors never include the API key.
  return `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? String(err)}`.slice(0, 300)
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

function basePrompt(task, cwd, { near, handoff } = {}) {
  return [
    task,
    '',
    `Workspace: ${cwd}. Work only inside this workspace.`,
    'Do not commit, push, deploy, publish packages, or touch databases.',
    `Keep ${HANDOFF} (in the workspace) updated as you work, with sections Done / Next / Open problems / How to verify, so another agent can take over.`,
    near ? 'You are close to your usage limit: work in small steps and update the handoff after each step.' : '',
    'When done, summarize what you changed (or found) and how you verified it.',
    handoff ? `\nEarlier unfinished work on this task (handoff note from ${HANDOFF}); continue from it:\n${handoff.slice(0, 8000)}` : '',
  ].filter((l, i) => l !== '' || i === 1).join('\n')
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
    `Do not modify any files (do not write ${HANDOFF} either). Report concrete defects or regressions with file and line, or state that the work is correct and complete.`,
  ].join('\n')
}

/** Handoff note written by the harness from evidence when the limited agent left none. */
function harnessHandoff({ task, attempts, diff, checks, previous }) {
  const failing = checks.filter((c) => !c.passed)
  const lastAnswer = attempts.findLast((a) => a.answerText)?.answerText ?? ''
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
    previous ? `\n## Earlier note\n${previous.slice(0, 2000)}` : '',
  ].join('\n')
}

/**
 * @param {object} p
 * @param {string} p.task
 * @param {string} p.cwd
 * @param {string} [p.forceAgent]  manual override; skips Jev routing only
 * @param {object} p.config        plugin config (agents, tools, limits, thresholds, checks)
 * @param {object} p.deps          { ready?: {[agentId]: {loggedIn, detail}}, quota?: {[agentId]: {state, until}}, isLimitError?, onLimit?, logAttempt?, jev | null, jevUnavailableReason, execute(agentDef, prompt, signal), runTool?(tool, args, task, signal), review?, emit?, history }
 * @param {AbortSignal} p.signal
 */
export async function runRouted({ task, cwd, forceAgent, answerOnly = false, config, deps, signal = new AbortController().signal }) {
  const emit = (type, data = {}) => deps.emit?.({ type, at: Date.now(), ...data })
  await assertWorkspace(cwd)
  const runId = randomUUID()
  const runStartedAt = Date.now()
  const quota = deps.quota ?? {}
  // Only agents that are switched on, signed in (deps.ready from setup.js checks) and not at their limit can be picked.
  const notReady = config.agents.filter((a) => a.enabled && deps.ready?.[a.id] && !deps.ready[a.id].loggedIn)
  const outAtStart = config.agents.filter((a) => a.enabled && !notReady.includes(a) && OUT_STATES.includes(quota[a.id]?.state))
  const agents = config.agents.filter((a) => a.enabled && !notReady.includes(a) && !outAtStart.includes(a))
  const out = outAtStart.map((a) => ({ id: a.id, until: quota[a.id].until ?? null })) // grows as agents hit limits
  const outLabel = () => { const e = earliest(out); return e ? ` (earliest reset ${hhmm(e)})` : '' }
  const tools = (config.tools ?? []).filter((t) => t.enabled !== false)
  if (agents.length === 0 && outAtStart.length) throw new Error(`all available agents are at their usage limits${outLabel()}: ${out.map((o) => `${o.id}${o.until ? ` until ${hhmm(o.until)}` : ''}`).join(', ')}`)
  if (agents.length === 0) throw new Error(`no LLM agent is switched on and signed in${notReady.length ? ` (${notReady.map((a) => `${a.id}: ${deps.ready[a.id].detail}`).join('; ')})` : ''}. Open Settings → Plugins → Jev setup`)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const blocked = notReady.find((a) => a.id === forceAgent)
  if (blocked) throw new Error(`${forceAgent} cannot run: ${deps.ready[forceAgent].detail}`)
  const limited = out.find((o) => o.id === forceAgent)
  if (limited) throw new Error(`${forceAgent} is at its usage limit${limited.until ? ` until ${hhmm(limited.until)}` : ''}`)
  if (forceAgent && !byId.has(forceAgent)) throw new Error(`agent "${forceAgent}" is not enabled; enabled: ${[...byId.keys()].join(', ')}`)
  const other = (probabilities, avoid) => pickOther(probabilities, avoid, agents)
  const review = deps.review ?? createReview(deps.jev, config.thresholds, deps.jevUnavailableReason)
  const near = (id) => quota[id]?.state === 'near'
  const availability = deps.quota ? Object.fromEntries(agents.map((a) => [a.id, near(a.id) ? 'near limit' : 'ok'])) : undefined

  const { limits, thresholds } = config
  const productionCritical = config.productionWorkspaces.some((p) => cwd.toLowerCase().startsWith(p.toLowerCase()))
  emit('start', { task, cwd, forceAgent })
  await ensureHandoffIgnored(cwd).catch(() => {})
  const handoffFile = join(cwd, HANDOFF)
  const priorHandoff = await readFile(handoffFile, 'utf8').catch(() => null)
  const { context, snapshot: startSnap } = await gatherContext(cwd, { productionCritical, signal })
  const history = await deps.history.recent(cwd, 10)

  // 1. Routing
  let routing
  const routeStarted = Date.now()
  if (forceAgent) {
    routing = { mode: 'manual', primaryAgent: forceAgent }
  } else if (!deps.jev) {
    routing = { mode: 'fallback', primaryAgent: config.fallbackAgent, reason: deps.jevUnavailableReason }
  } else {
    try {
      routing = { mode: 'jev', ...(await deps.jev.route({ task, context, agents, tools, history, availability, ...(priorHandoff ? { handoff: priorHandoff.slice(0, 3000) } : {}) }, signal)) }
    } catch (err) {
      if (signal.aborted) throw err
      routing = { mode: 'fallback', primaryAgent: config.fallbackAgent, reason: describeError(err) }
    }
  }
  if (!byId.has(routing.primaryAgent)) routing.primaryAgent = agents[0].id
  // An unfinished note from an earlier run goes to the primary agent only when the task continues it.
  const continuing = !!priorHandoff && (typeof routing.continueHandoff === 'number' ? routing.continueHandoff >= 0.5 : /continue|resume|carry on/i.test(task))
  let handoffNote = continuing ? priorHandoff : null
  // Tool only when handler picks it, its "fits" Noul clears thresholds.tool (a Noul
  // bar, not a Choice confidence), and its weakest argument choice is confident.
  const tool = routing.handler && routing.handler !== 'agent' && (routing.toolFits ?? 0) >= (thresholds.tool ?? 0.5) && (routing.toolArgConfidence ?? 0) >= 0.5
    ? tools.find((t) => t.id === routing.handler) : undefined
  emit('routed', { routing, context, ms: Date.now() - routeStarted, tool: tool?.id })

  // 2. Baseline checks, so later failures can be told apart from pre-existing ones.
  //    Taken before the first agent attempt; a tool run skips them to stay fast.
  // ponytail: after a tool that edited files escalates, the baseline includes the tool's edits.
  const checkOpts = { scripts: config.checks.scripts, timeoutMs: config.checks.timeoutMs, outputChars: config.checks.outputChars, signal }
  let baseline = null
  const ensureBaseline = async () => {
    if (baseline) return
    baseline = config.checks.enabled ? await runChecks(cwd, checkOpts) : []
    lastChecks = baseline
    if (baseline.length) emit('checks', { phase: 'baseline', checks: baseline.map(({ name, passed, exitCode, durationMs }) => ({ name, passed, exitCode, durationMs })) })
  }
  const requireChecks = routing.mode !== 'jev' || routing.needsTests >= thresholds.needsTests

  // The agent's own note when it updated it during the attempt, else one written from evidence.
  const saveHandoff = async (since) => {
    const s = await stat(handoffFile).catch(() => null)
    const previous = s ? await readFile(handoffFile, 'utf8').catch(() => '') : ''
    if (s && s.mtimeMs >= since - 1000) { emit('handoff', { path: HANDOFF, source: 'agent' }); return previous }
    const text = harnessHandoff({ task, attempts, diff: await changedSince(cwd, startSnap, signal), checks: lastChecks, previous })
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
  let next = tool ? { agent: `tool:${tool.id}`, role: 'tool' } : { agent: routing.primaryAgent, role: 'primary' }
  let status = null
  let statusReason = ''
  let reviewed = false

  while (next) {
    const workCount = attempts.filter((a) => a.role !== 'review').length
    const reviewCount = attempts.length - workCount
    if (attempts.length >= limits.maxRounds) { status = 'limit_reached'; statusReason = `maxRounds (${limits.maxRounds}) reached`; break }
    if (next.role !== 'review' && workCount >= limits.maxAttempts) { status = 'limit_reached'; statusReason = `maxAttempts (${limits.maxAttempts}) reached`; break }
    if (next.role === 'review' && reviewCount >= limits.maxReviews) { status = 'limit_reached'; statusReason = `maxReviews (${limits.maxReviews}) reached`; break }

    if (next.role !== 'tool' && !answerOnly) await ensureBaseline()
    const before = await snapshot(cwd, signal)
    const diffSoFar = attempts.length ? await changedSince(cwd, startSnap, signal) : { stat: '', patch: '' }
    const opts = { near: near(next.agent), handoff: handoffNote }
    const prompt = next.role === 'tool' ? '' : next.role === 'primary' ? basePrompt(task, cwd, opts)
      : next.role === 'review' ? reviewPrompt(task, cwd, diffSoFar)
      : retryPrompt(task, cwd, attempts, lastChecks, opts)

    const started = Date.now()
    emit('attempt_start', { index: attempts.length, agent: next.agent, role: next.role, ...(next.role === 'tool' ? { args: routing.toolArgs } : {}) })
    let result
    try {
      const agentSignal = AbortSignal.any([signal, AbortSignal.timeout(config.agentTimeoutMs)])
      result = next.role === 'tool'
        ? await deps.runTool(tool, routing.toolArgs ?? {}, task, agentSignal)
        : await deps.execute(byId.get(next.agent), prompt, agentSignal)
    } catch (err) {
      if (signal.aborted) throw err
      result = { stopReason: 'error', diagnostic: describeError(err), answerText: '' }
    }
    const changes = await changedSince(cwd, before, signal)
    const limit = next.role === 'tool' ? { hit: false }
      : (deps.isLimitError ? deps.isLimitError(byId.get(next.agent), result) : builtinLimit(result)) ?? { hit: false }
    const attempt = {
      agent: next.agent,
      role: next.role,
      stopReason: result.stopReason,
      diagnostic: result.diagnostic,
      answerText: result.answerText,
      durationMs: Date.now() - started,
      changedFiles: changes.files,
      ...(next.role === 'tool' ? {} : { model: deps.modelOf?.(byId.get(next.agent)) }),
      ...(limit.hit ? { limitHit: true } : {}),
    }
    attempts.push(attempt)
    if (next.role !== 'tool') {
      const entry = { ts: new Date().toISOString(), runId, workspace: cwd, agent: next.agent, role: next.role, durationMs: attempt.durationMs, tokens: result.usage ?? null, costUsd: result.costUsd ?? null, stopReason: result.stopReason, limitHit: !!limit.hit }
      await (async () => deps.logAttempt?.(entry))().catch(() => {})
    }

    // A usage limit says nothing about the work's quality: skip the review and
    // continue with a fresh key, the peer agent, or pause with a handoff note.
    if (limit.hit) {
      emit('attempt_end', { index: attempts.length - 1, attempt: { ...attempt, answerText: (attempt.answerText ?? '').slice(0, 4000) } })
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
        const candidates = isReview ? agents.filter((a) => a.id !== producer) : agents
        const to = candidates.includes(peer) ? peer.id : candidates.length ? pickOther(routing.agentProbabilities, next.agent, candidates) : null
        action = to ? 'peer' : 'paused'
        next = to ? { agent: to, role: isReview ? 'review' : 'retry' } : null
      }
      limitEvents.push({ agent: attempt.agent, until, action })
      emit('limit', { agent: attempt.agent, until, action })
      if (!next) { status = 'paused_limit'; statusReason = `all agents at their usage limits${outLabel()}` }
      continue
    }

    // A reviewer that crashed says nothing about the work: hand the review to
    // an agent that is neither the producer nor the failed reviewer, or to a person.
    if (next.role === 'review' && result.stopReason !== 'completed') {
      const why = `reviewer ${next.agent} failed (${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''})`
      emit('attempt_end', { index: attempts.length - 1, attempt: { ...attempt, answerText: '' } })
      const failed = attempts.filter((x) => x.role === 'review' && x.stopReason !== 'completed').map((x) => x.agent)
      const reviewer = agents.find((x) => x.id !== producer && !failed.includes(x.id))
      const assessment = { mode: 'skipped', action: reviewer ? 'second_review' : 'human', why: reviewer ? `${why}; asking ${reviewer.id}` : `${why}; no other reviewer left` }
      assessments.push(assessment)
      emit('review', { index: attempts.length - 1, assessment })
      if (!reviewer) { status = 'needs_human'; statusReason = assessment.why; break }
      next = { agent: reviewer.id, role: 'review' }
      continue
    }
    if (next.role !== 'review') { producer = next.agent; reviewed = false } else reviewed = true

    // A plain question needs an answer, not project checks or a code review.
    if (answerOnly) {
      emit('attempt_end', { index: attempts.length - 1, attempt: { ...attempt, answerText: (attempt.answerText ?? '').slice(0, 4000) } })
      if (result.stopReason === 'completed') { status = 'answered'; break }
      next = { agent: other({}, next.agent), role: 'retry' }
      continue
    }

    if (config.checks.enabled && next.role !== 'tool' && (changes.files === null || changes.files.length > 0)) lastChecks = await runChecks(cwd, checkOpts)
    attempt.checks = lastChecks.map(({ name, passed, exitCode, durationMs }) => ({ name, passed, exitCode, durationMs }))
    emit('attempt_end', { index: attempts.length - 1, attempt: { ...attempt, answerText: (attempt.answerText ?? '').slice(0, 4000) } })
    const cmp = compareChecks(baseline ?? [], lastChecks)
    const totalDiff = await changedSince(cwd, startSnap, signal)
    const touchedCode = (totalDiff.files?.length ?? 0) > 0
    const blockAccept = result.stopReason !== 'completed' || cmp.regressed.length > 0 || (requireChecks && touchedCode && cmp.failing.length > 0)

    // Review plugin: Jev verdict plus deterministic overrides.
    const verification = lastChecks.map((c) => ({ check: c.name, passed: c.passed, exit_code: c.exitCode, output: c.passed ? '' : c.output }))
    const { status: accepted, ...assessment } = await review({ task, routing, attempts, checks: verification, cmp, diff: totalDiff, agents, blockAccept, reviewed, touchedCode, pickOther: other }, signal)
    assessments.push(assessment)
    emit('review', { index: attempts.length - 1, assessment })

    const action = assessment.action
    if (action === 'accept') { status = accepted; break }
    if (action === 'human') { status = 'needs_human'; statusReason = assessment.why; break }
    if (next.role === 'tool') next = { agent: routing.primaryAgent, role: 'primary' } // escalate tool -> agent
    else if (action === 'second_review') next = { agent: other(assessment.nextAgentProbabilities, producer), role: 'review' }
    else next = { agent: assessment.nextAgent && byId.has(assessment.nextAgent) ? assessment.nextAgent : other({}, next.agent), role: 'retry' }
  }

  // Accepted work closes the note it continued or wrote, so it never leaks into a later task;
  // a note from other unfinished work stays for its own next session.
  const wroteNote = (await stat(handoffFile).catch(() => null))?.mtimeMs >= runStartedAt - 1000
  if (status?.startsWith('accepted') && (continuing || wroteNote)) {
    await rename(handoffFile, join(cwd, '.kz-harness', `handoff-done-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)).catch(() => {})
  }

  const record = {
    ts: new Date().toISOString(),
    runId,
    workspace: cwd,
    task,
    context,
    routing,
    continuedFromHandoff: continuing,
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
  emit('final', { status, statusReason })
  const last = attempts.findLast((x) => x.answerText)
  return { ...record, lastAnswer: last?.answerText ?? '', lastAnswerBy: last ? `${last.agent}${last.model ? ` (${last.model})` : ''}, ${last.role}` : '' }
}

/** "Jev (jev-1.13.0) → deepseek (deepseek-flash) · claude (opus), reviewer": who took part, in order. */
export function answeredBy(r) {
  const seen = new Map()
  for (const a of r.attempts ?? []) {
    const key = `${a.agent}|${a.model ?? ''}`
    const roles = seen.get(key) ?? new Set()
    roles.add(a.role === 'review' ? 'reviewer' : a.role === 'tool' ? 'tool' : 'work')
    seen.set(key, roles)
  }
  const who = [...seen].map(([key, roles]) => {
    const [agent, model] = key.split('|')
    const tag = [...roles].filter((x) => x !== 'work').join(', ')
    return `${agent}${model ? ` (${model})` : ''}${tag ? `, ${tag}` : ''}`
  })
  const jev = r.routing?.mode === 'jev' ? `Jev${r.routing.model ? ` (${r.routing.model})` : ''}` : null
  return [jev, who.join(' · ')].filter(Boolean).join(' → ')
}

/** Concise user-facing report. Structured results only, no hidden reasoning. */
export function formatReport(r) {
  const R = r.routing
  const lines = []
  const modeLabel = { jev: 'AUTO (Jev decided)', manual: `MANUAL /${R.primaryAgent}`, fallback: 'AUTO, JEV UNAVAILABLE: routing fallback activated' }[R.mode]
  lines.push(`**Jev router** · ${modeLabel}`)
  if (R.mode === 'fallback') lines.push(`Fallback reason: ${R.reason}. Default agent: ${R.primaryAgent}`)
  lines.push(`- Selected agent: **${R.primaryAgent}**${R.mode === 'jev' ? ` (confidence ${pct(R.agentConfidence)}; ${Object.entries(R.agentProbabilities).map(([k, v]) => `${k} ${pct(v)}`).join(', ')})` : ''}`)
  if (R.mode === 'jev') {
    lines.push(`- Task type: ${R.taskType} (confidence ${pct(R.taskTypeConfidence)})`)
    lines.push(`- Complexity ${pct(R.complexity)} · Risk ${pct(R.risk)}`)
    lines.push(`- Needs second review ${pct(R.needsSecondOpinion)} · Needs human review ${pct(R.needsHumanReview)} · Needs tests ${pct(R.needsTests)}`)
  }
  if (r.continuedFromHandoff) lines.push(`- Continuing from handoff (${HANDOFF})`)
  const av = r.availability
  if (av?.out.length || av?.near.length) {
    lines.push(`- ${[av.out.length ? `Out: ${av.out.map((o) => `${o.id}${o.until ? ` until ${hhmm(o.until)}` : ''}`).join(', ')}` : '', av.near.length ? `near limit: ${av.near.join(', ')}` : ''].filter(Boolean).join('; ')}`)
  }
  if (r.baseline.length) lines.push(`- Baseline checks: ${r.baseline.map((c) => `${c.name} ${c.passed ? 'pass' : 'FAIL'}`).join(', ')}`)
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
  const reset = earliest(r.availability?.out ?? [])
  const label = {
    answered: 'ANSWERED',
    accepted: 'ACCEPTED',
    accepted_pending_human_review: 'ACCEPTED, human review recommended before merging',
    needs_human: 'NEEDS HUMAN',
    limit_reached: 'STOPPED: limit reached',
    paused_limit: `PAUSED: agents at their limits, handoff saved in ${HANDOFF}${reset ? ` (earliest reset ${hhmm(reset)})` : ''}`,
  }[r.finalStatus] ?? r.finalStatus
  const by = answeredBy(r)
  if (by) lines.push('', `_Answered by: ${by}_`)
  lines.push('', `**Final status: ${label}**${r.statusReason && r.finalStatus !== 'paused_limit' ? ` (${r.statusReason})` : ''}`)
  if (r.lastAnswer) lines.push('', `**Answer from ${r.lastAnswerBy || 'the last agent'}**`, r.lastAnswer.slice(0, 4000))
  return lines.join('\n')
}
