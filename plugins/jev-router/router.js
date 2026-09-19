// Routing loop: context -> Jev route -> agent -> deterministic checks -> Jev
// assessment -> accept / second review / retry / human, bounded by limits.
// Dependencies are injected so the loop runs the same in DSH and in tests.
import { createReview } from '../jev-review/index.js'
import { assertWorkspace, changedSince, compareChecks, gatherContext, runChecks, snapshot } from './workspace.js'

const pct = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a')

function describeError(err) {
  // Class name + message only; SDK errors never include the API key.
  return `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? String(err)}`.slice(0, 300)
}

/** Highest-probability enabled agent other than `avoid`, falling back to registry order. */
export function pickOther(probabilities, avoid, agents) {
  const ranked = agents.map((a) => a.id).sort((x, y) => (probabilities?.[y] ?? 0) - (probabilities?.[x] ?? 0))
  return ranked.find((id) => id !== avoid) ?? ranked[0]
}

function basePrompt(task, cwd) {
  return [
    task,
    '',
    `Workspace: ${cwd}. Work only inside this workspace.`,
    'Do not commit, push, deploy, publish packages, or touch databases.',
    'When done, summarize what you changed (or found) and how you verified it.',
  ].join('\n')
}

function retryPrompt(task, cwd, attempts, checks) {
  const last = attempts.at(-1)
  const failing = checks.filter((c) => !c.passed).map((c) => `### ${c.name} (exit ${c.exitCode})\n${c.output}`)
  return [
    basePrompt(task, cwd),
    '',
    'Earlier attempts did not finish this task. Their current changes are still in the working tree.',
    ...attempts.map((a, i) => `Attempt ${i + 1} by ${a.agent} (${a.role}): ${a.stopReason}. ${a.diagnostic ?? ''}\n${(a.answerText ?? '').slice(0, 1500)}`),
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
    'Do not modify any files. Report concrete defects or regressions with file and line, or state that the work is correct and complete.',
  ].join('\n')
}

/**
 * @param {object} p
 * @param {string} p.task
 * @param {string} p.cwd
 * @param {string} [p.forceAgent]  manual override; skips Jev routing only
 * @param {object} p.config        plugin config (agents, tools, limits, thresholds, checks)
 * @param {object} p.deps          { ready?: {[agentId]: {loggedIn, detail}}, jev | null, jevUnavailableReason, execute(agentDef, prompt, signal), runTool?(tool, args, task, signal), review?, emit?, history }
 * @param {AbortSignal} p.signal
 */
export async function runRouted({ task, cwd, forceAgent, config, deps, signal = new AbortController().signal }) {
  const emit = (type, data = {}) => deps.emit?.({ type, at: Date.now(), ...data })
  await assertWorkspace(cwd)
  // Only agents that are switched on and signed in (deps.ready from setup.js checks) can be picked.
  const notReady = config.agents.filter((a) => a.enabled && deps.ready?.[a.id] && !deps.ready[a.id].loggedIn)
  const agents = config.agents.filter((a) => a.enabled && !notReady.includes(a))
  const tools = (config.tools ?? []).filter((t) => t.enabled !== false)
  if (agents.length === 0) throw new Error(`no LLM agent is switched on and signed in${notReady.length ? ` (${notReady.map((a) => `${a.id}: ${deps.ready[a.id].detail}`).join('; ')})` : ''}. Open Settings → Plugins → Jev setup`)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const blocked = notReady.find((a) => a.id === forceAgent)
  if (blocked) throw new Error(`${forceAgent} cannot run: ${deps.ready[forceAgent].detail}`)
  if (forceAgent && !byId.has(forceAgent)) throw new Error(`agent "${forceAgent}" is not enabled; enabled: ${[...byId.keys()].join(', ')}`)
  const other = (probabilities, avoid) => pickOther(probabilities, avoid, agents)
  const review = deps.review ?? createReview(deps.jev, config.thresholds, deps.jevUnavailableReason)

  const { limits, thresholds } = config
  const productionCritical = config.productionWorkspaces.some((p) => cwd.toLowerCase().startsWith(p.toLowerCase()))
  emit('start', { task, cwd, forceAgent })
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
      routing = { mode: 'jev', ...(await deps.jev.route({ task, context, agents, tools, history }, signal)) }
    } catch (err) {
      if (signal.aborted) throw err
      routing = { mode: 'fallback', primaryAgent: config.fallbackAgent, reason: describeError(err) }
    }
  }
  if (!byId.has(routing.primaryAgent)) routing.primaryAgent = agents[0].id
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

  // 3. Execute / review loop. A tool, when Jev picked one, goes first; if the
  //    review does not accept its output, the run escalates to the routed agent.
  const attempts = []
  const assessments = []
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

    if (next.role !== 'tool') await ensureBaseline()
    const before = await snapshot(cwd, signal)
    const diffSoFar = attempts.length ? await changedSince(cwd, startSnap, signal) : { stat: '', patch: '' }
    const prompt = next.role === 'tool' ? '' : next.role === 'primary' ? basePrompt(task, cwd)
      : next.role === 'review' ? reviewPrompt(task, cwd, diffSoFar)
      : retryPrompt(task, cwd, attempts, lastChecks)

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
    const attempt = {
      agent: next.agent,
      role: next.role,
      stopReason: result.stopReason,
      diagnostic: result.diagnostic,
      answerText: result.answerText,
      durationMs: Date.now() - started,
      changedFiles: changes.files,
    }
    attempts.push(attempt)
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

  const record = {
    ts: new Date().toISOString(),
    workspace: cwd,
    task,
    context,
    routing,
    baseline: (baseline ?? []).map(({ name, passed }) => ({ name, passed })),
    attempts: attempts.map(({ answerText, ...rest }) => ({ ...rest, answerExcerpt: (answerText ?? '').slice(0, 1000) })),
    assessments,
    finalStatus: status,
    statusReason,
  }
  // The work is done either way; a failed history write must not swallow the report.
  await deps.history.append(record).catch((err) => emit('error', { message: `history not saved: ${err.message}` }))
  emit('final', { status, statusReason })
  return { ...record, lastAnswer: attempts.findLast((x) => x.answerText)?.answerText ?? '' }
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
  if (r.baseline.length) lines.push(`- Baseline checks: ${r.baseline.map((c) => `${c.name} ${c.passed ? 'pass' : 'FAIL'}`).join(', ')}`)
  lines.push('', '**Attempts**')
  r.attempts.forEach((a, i) => {
    const s = r.assessments[i]
    lines.push(`${i + 1}. ${a.agent} (${a.role}): ${a.stopReason} in ${Math.round(a.durationMs / 1000)}s${a.diagnostic ? `, ${a.diagnostic}` : ''}`)
    lines.push(`   Changed files: ${a.changedFiles === null ? 'unknown (not git)' : a.changedFiles.length ? a.changedFiles.join(', ') : 'none'}`)
    if (a.checks?.length) lines.push(`   Checks: ${a.checks.map((c) => `${c.name} ${c.passed ? 'pass' : `FAIL(${c.exitCode})`}`).join(', ')}`)
    if (s) lines.push(`   Assessment: ${s.why} → **${s.action}**`)
  })
  const label = {
    accepted: 'ACCEPTED',
    accepted_pending_human_review: 'ACCEPTED, human review recommended before merging',
    needs_human: 'NEEDS HUMAN',
    limit_reached: 'STOPPED: limit reached',
  }[r.finalStatus] ?? r.finalStatus
  lines.push('', `**Final status: ${label}**${r.statusReason ? ` (${r.statusReason})` : ''}`)
  if (r.lastAnswer) lines.push('', '**Last agent answer**', r.lastAnswer.slice(0, 4000))
  return lines.join('\n')
}
