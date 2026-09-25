// "Jev Auto" as a model in the DSH picker. Picking it sends every chat message
// straight to the router: no chat LLM in front deciding whether to call it.
// Live router progress streams as the reasoning block; the report is the reply.
import { resolve } from 'node:path'
import { eligible, rank } from './capabilities.js'
import { isLocalLevel, localAgentFor } from './effort.js'
import { TEACHER, providerName } from './providers.js'
import { fileURLToPath } from 'node:url'

export const JEV_PROVIDER = 'jev'
// The "No project" workspace (<harness>/no-project): chat only, agents never run there.
const NO_PROJECT = resolve(fileURLToPath(new URL('../../no-project', import.meta.url))).toLowerCase()
export const isNoProject = (cwd) => !!cwd && resolve(cwd).toLowerCase() === NO_PROJECT
const MODEL = 'jev-auto'
const LAYA_MODEL = 'laya-auto'
// Four ways to let Jev choose, by how much of the machine's outside world is in play.
// Jev itself is a hosted call, so 'offline' drops it and falls back to the fixed rule.
// 'local' and 'online' are mirrors: each keeps Jev routing and narrows the pool to one side.
// 'offline' and a genuinely dead network both beat 'online', because those are statements about
// what this machine CAN do, while 'online' is only a preference about what it SHOULD use.
// `decider` is who answers the routing, intent and review questions of a row (providers.js):
// Laya Auto is the one row Laya decides, with no Jev call at all (docs/laya-auto.md 3.1).
const JEV_MODELS = {
  'jev-auto': {
    mode: 'auto',
    decider: 'jev',
    name: 'Jev Auto',
    description: 'Every message goes straight to the Jev router, which picks Claude, Codex, DeepSeek or a tool, then reviews the result.',
  },
  // Right after Jev Auto, and only while Laya can be asked at all (listModels). There is no Laya
  // twin of the rows below: offline, Laya Auto narrows the pool to the local agents itself, and a
  // local effort forces the agent under it exactly as it does under Jev Auto.
  'laya-auto': {
    mode: 'auto',
    decider: 'laya',
    name: 'Laya Auto',
    description: 'Laya, a decision model on this PC, routes every message and reviews the result instead of Jev. No Jev call is made and no routing or review question leaves this PC; offline it keeps routing, to the local models. The agent it picks still sees your task and code, and questions are answered by the chat model as in Jev Auto.',
  },
  // Key order is menu order, and it reads as a gradient from the most off-machine to the least.
  'jev-online': {
    mode: 'online',
    decider: 'jev',
    name: 'Jev Auto · Online',
    description: 'Jev routes, but only over the cloud and subscription agents: Claude, Codex, DeepSeek. The local models on this PC are never picked, so nothing waits on your own hardware. Everything Jev Auto sends still applies, and the agent you are routed to sees your code.',
  },
  'jev-local': {
    mode: 'local',
    decider: 'jev',
    name: 'Jev Auto · Local',
    description: 'Jev routes, but only over the local models on this PC. Your code is only edited here; Jev still sees the task text, file names, the answer, your check output and a slice of the diff when it reviews. It also sends the handoff note from a previous task (up to 3000 characters, quoting an earlier agent\'s answer) on the routing call.',
  },
  'jev-offline': {
    mode: 'offline',
    // Named for the record; offline Jev is never called.
    decider: 'jev',
    name: 'Offline · Local only',
    description: 'Nothing leaves this PC: local models, a fixed routing rule and the project checks. No Jev call, so no calibrated routing or review.',
  },
}
/**
 * How wide the field of agents is (`mode`) and who decides (`decider`), for a picked model id. An
 * unknown id (an agent row, an old selection) is Jev Auto; `laya-auto` is always known, so a saved
 * Laya Auto selection never silently becomes Jev.
 */
export const rowOf = (model) => {
  const row = JEV_MODELS[String(model ?? '')] ?? JEV_MODELS[MODEL]
  return { mode: row.mode, decider: row.decider }
}
// A model pair is usable only when it names both a provider and a model. A failed aux
// resolution still returns a truthy object with empty strings, so without this test that
// object beats the local fallback in the `??` chains and the model-list filter below.
const usableModel = (m) => typeof m?.provider === 'string' && m.provider !== '' && typeof m.model === 'string' && m.model !== ''
// One entry per enabled agent, next to Jev Auto: picking it sends every message
// to that agent, skipping the routing question. `/claude …` still works per message.
// How sure Jev must be that a message is a question before the agents are skipped. A wrong
// "task" costs one agent run; a wrong "question" sends real project work to a chat model that
// cannot touch files, so it cannot be done at all. Unsure therefore means task.
// Only applies to Jev's own answer, which always carries a confidence. The offline classifier
// is a deterministic word test with no confidence to report, and gating it on a number it does
// not have would stop offline mode answering questions at all.
// Both bars are the answering provider's (`cls.thresholds`, from classify): Laya's sit higher,
// because it is zero-shot on these questions (docs/laya-auto.md 2.6); these are Jev's.
const MIN_QUESTION_CONFIDENCE = 0.6
const isQuestion = (c) => c?.kind === 'question' && (c.confidence === undefined || c.confidence >= (c.thresholds?.minQuestionConfidence ?? MIN_QUESTION_CONFIDENCE))
// How sure Jev must be that a question *also* asks for work before anything is queued. A wrong
// "also" costs one background run of something the person only asked about, so the bar is above
// the question floor but not as high as a destructive action's.
const ALSO_WORK = 0.7
const alsoWork = (c) => (c.alsoWork ?? 0) >= (c.thresholds?.alsoWork ?? ALSO_WORK)

const AGENT_PREFIX = 'agent-'
const agentIdOf = (model) => (String(model ?? '').startsWith(AGENT_PREFIX) ? String(model).slice(AGENT_PREFIX.length) : null)
// An agent's own name, from its config entry (or the local-model manifest), never
// a table in here: a new agent names itself and this keeps working.
const titleCase = (id) => String(id).replace(/[-_]+/g, ' ').replace(/\b./g, (c) => c.toUpperCase())
export const nameOfAgent = (a) => a.name?.trim() || titleCase(a.id)

// The router run is not idempotent (agents edit files), so never let the runtime retry it.
const NO_RETRY = Object.freeze({ mode: 'normal', maxRetries: 0, retryableCodes: Object.freeze([]), initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 })

/**
 * What a model row accepts, defaulting to text. The engine reads this field as a contract:
 * a declared list without 'image' makes it refuse an attachment outright, and a list with
 * 'image' makes it hand the bytes over. So it is never set to 'image' on a hunch - the
 * caller asks whether something downstream really reads the picture first.
 */
const TEXT_ONLY = Object.freeze(['text'])
const BY_MODALITY = Object.freeze(['text', 'image'])

const info = (provider, modalities = TEXT_ONLY, id = MODEL) => ({
  provider,
  id,
  name: JEV_MODELS[id]?.name ?? JEV_MODELS[MODEL].name,
  description: JEV_MODELS[id]?.description ?? JEV_MODELS[MODEL].description,
  inputModalities: modalities,
  reasoning: JEV_MODELS[id]?.decider === 'laya' ? LAYA_REASONING : REASONING,
})

/** One agent as a pickable model: same checks and review, no routing question. */
const agentInfo = (provider, a, modalities = TEXT_ONLY) => ({
  provider,
  id: `${AGENT_PREFIX}${a.id}`,
  name: nameOfAgent(a),
  description: `Always ${nameOfAgent(a)}, no routing. ${a.description ?? ''}`.trim(),
  inputModalities: modalities,
  reasoning: REASONING,
})

// Effort in the model menu. Ids are Jev's unified ladder (effort.js maps them per agent).
const REASONING = Object.freeze({
  defaultEffort: 'auto',
  efforts: Object.freeze([
    { id: 'auto', name: 'Auto', description: 'Jev picks by task (Settings default applies)' },
    { id: 'low', name: 'Low', description: 'Claude Low · GPT Light · DeepSeek Low' },
    { id: 'medium', name: 'Medium', description: 'Claude Medium · GPT Medium · DeepSeek High' },
    { id: 'high', name: 'High', description: 'Claude High · GPT High · DeepSeek High' },
    { id: 'xhigh', name: 'Extra High', description: 'Claude Extra · GPT Extra High · DeepSeek Max' },
    { id: 'max', name: 'Max', description: 'Claude Max · GPT Max · DeepSeek Max' },
    { id: 'ultra', name: 'Ultra', description: 'Claude Ultracode (its top level) · GPT Ultra · DeepSeek Max' },
    // These two pick a model rather than an effort: the smallest installed local
    // model for a quick answer, the largest when it is worth the wait.
    // "Free" is the token bill, not a privacy claim: these pick the executor only, so in Jev Auto
    // the routing and review calls still go out. Saying "private" here read as more than that.
    { id: 'local-low', name: 'Local · quick', description: 'The smallest local model on this PC. Free to run, fastest.' },
    { id: 'local-high', name: 'Local · best', description: 'The largest local model on this PC. Free to run, slower.' },
  ]),
})
// The same ladder on the Laya Auto row, where Laya's answers are what Auto reads.
const LAYA_REASONING = Object.freeze({
  ...REASONING,
  efforts: Object.freeze(REASONING.efforts.map((e) => (e.id === 'auto' ? { ...e, description: 'Laya picks by task (Settings default applies)' } : e))),
})

// Text the person typed. DSH also sends plugin context (skill catalogs, reminders)
// as user-role messages and blocks; those must never become the routed task.
const textOf = (content) => (content ?? [])
  .filter((b) => b.type === 'text' && !b.text.trimStart().startsWith('<system-reminder>'))
  .map((b) => b.text).join('\n').trim()
const typedByPerson = (m) => m.role === 'user' && (m.source?.kind ?? 'user') === 'user'
// A background job's completion notice (dsh-tool-jobs): { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' }.
const isJobNotice = (m) => m.role === 'user' && m.source?.kind === 'plugin' && (m.source.plugin === 'tool-jobs' || m.source.form === 'notice')
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`

/**
 * The user-facing label for every task state. Kept beside `line()` because the chat and the
 * task list must never disagree about what a state is called.
 */
export const TASK_LABELS = Object.freeze({
  queued: 'Waiting',
  routing: 'Choosing executor',
  running: 'Running',
  verifying: 'Verifying',
  reviewing: 'Reviewing',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  needs_human: 'Needs input',
  paused_limit: 'Paused by limit',
})

/**
 * One finished background task as a self-contained, attributed section: who did it, which
 * task it was, how it ended, and the result. It never borrows the chat model's voice, so a
 * reader can always tell where the assistant stopped and the background work began.
 */
export function resultSection(r) {
  const head = [
    '**Background task result**',
    `Task: ${r.taskName ?? r.task}`,
    `Task ID: ${r.jobId}`,
    `Agent: ${r.agent ?? `${providerName(r.decider ?? TEACHER)} picks`}${r.model ? ` · ${r.model}` : ''}`,
    `Status: ${TASK_LABELS[r.state] ?? r.state}`,
  ]
  // A task that did not complete says why first: the reason is the useful part.
  const body = r.state === 'completed'
    ? r.report ?? 'Done. No text report was produced.'
    : [r.terminalReason, r.report].filter(Boolean).join('\n\n') || 'No further detail was recorded.'
  return `${head.join('\n')}\n\n${body}`
}

/** One text block of a message, so several can be composed without ending the stream. */
function* textBlock(text, index = 0) {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
}

const AUTHORITY_ORDER = ['local', 'jev', 'laya', 'code']
const joinAnd = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
/**
 * Who decided a routed run, in words, from its per-domain report: every authority that answered
 * a domain, named once, in a fixed order. The local router names what it decided, because that is
 * the part that changes as the router learns. `code` is the rules that rank the resources and
 * answer the frontier review, which decide part of every adaptive run, so a run Jev taught the
 * rest of reads "Jev and routing rules decided" rather than crediting Jev with the pick, and a run
 * Laya decided reads "Laya and routing rules decided".
 * @param {object} [domains]  routing.decision.domains
 * @param {{ detail?: boolean }} [opts]  false leaves out which domains the local router and the
 *   fallback answered, for a heading with the per-domain list right under it
 * @returns {string|null} null when there is no per-domain report (legacy named routing)
 */
export function decidedBy(domains, { detail = true } = {}) {
  const by = new Map()
  for (const [id, d] of Object.entries(domains ?? {})) {
    if (!d?.authority || d.authority === 'none') continue
    by.set(d.authority, [...(by.get(d.authority) ?? []), id.replace(/_/g, ' ')])
  }
  if (!by.size) return null
  // Nothing could decide anything: the deterministic stand-in answered every domain.
  if ([...by.keys()].every((a) => a === 'fallback')) return 'safe fallback, nothing could decide'
  const which = (a) => (detail ? ` (${by.get(a).join(', ')})` : '')
  const names = AUTHORITY_ORDER.filter((a) => by.has(a)).map((a) => (a === 'local' ? `the local router${which(a)}` : a === 'code' ? 'routing rules' : providerName(a)))
  if (by.has('fallback')) names.push(`the safe fallback${which('fallback')}`)
  return `${joinAnd(names)} decided`
}

/** Where a provider on this PC ran a call, in the words the lines and the card use. */
export const deviceName = (device) => ({ cuda: 'GPU', gpu: 'GPU', cpu: 'CPU' })[device] ?? String(device)

/**
 * How big a Laya call that timed out was and where it ran, ` (20 questions on the CPU)`, from its
 * error or from what jev.js kept of it (errorOf); empty for any other failure (docs/laya-auto.md 3.3).
 */
export const timeoutSize = (err) => (err?.code === 'LAYA_TIMEOUT' && Number.isInteger(err.questions) && err.device ? ` (${err.questions} questions on the ${deviceName(err.device)})` : '')

// A route answer too flat to act on that the routing rules stand in for (docs/laya-auto.md 4.3):
// a score or a choice of the task profile, the strategy, and the second-opinion yes/no of the
// judgments call, which the code rule answers instead. Nothing else is filled: a flat tool pick and
// its arguments are kept as answered, as is every other flat yes/no, and simply fall under their
// bars, so none of them is said to be filled. The second opinion a task-group call carries is the
// profile's, which keeps a flat yes/no as answered (jev.js profileFromAnswers), so there it is not.
const FILLED_BY_RULES = new Set(['taskType', 'complexity', 'risk', 'skill', 'minimumCapability', 'preferredCapability', 'capability', 'strategy'])
// The questions of the resource and judgments call; any other one makes it a task-group call, as
// shadow.js groupsOf reads it.
const RESOURCE_CALL = new Set(['strategy', 'secondOpinion'])
const filledByRules = (q, taskGroup) => q.used && q.informative === false
  && (FILLED_BY_RULES.has(q.name) || q.name.startsWith('req.') || (q.name === 'secondOpinion' && !taskGroup))

// What the shadow of Jev Auto says once per run, at the routed event, and nothing else of it
// reaches the live stream (docs/laya-auto.md 3.3). Whoever wires the shadow sets `shadow` on the
// routed event: 'answering' when Laya takes this run's questions too, 'not_running' when it cannot.
const SHADOW_NOTE = {
  answering: 'Laya is answering the same questions in the background; compare them in Jev → Decisions',
  not_running: 'Laya is not running, so this run is not compared',
}

/**
 * One line per router event, for the live reasoning block and the app log. A call answered by a
 * provider on this PC can say more than one thing (the device, answers too flat to use, evidence
 * cut at the context limit), and each is a line of its own, joined with newlines.
 */
export function line(e) {
  switch (e.type) {
    // What it waits for, when the lanes said (tasks.js WAITING): the cap on tasks at once is not
    // another task in this workspace.
    case 'queued': return e.text ?? 'Waiting: another task is running in this workspace'
    case 'loading': return e.text
    case 'start': return `Task received${e.forceAgent ? ` (forced: ${e.forceAgent})` : ''}`
    // An answered call. The event keeps its old name whoever answered, since it lives only in
    // memory; the trace names the provider, and Laya's client adds the device and its wait.
    case 'jev': {
      const t = e.trace
      const who = providerName(t.provider ?? TEACHER)
      const where = t.meta?.device ? ` on the ${deviceName(t.meta.device)}` : ''
      const waited = t.meta?.waitedMs > 0 ? ` (waited ${Math.round(t.meta.waitedMs)} ms for an earlier ${who} answer)` : ''
      const out = [`${who} ${t.phase}: ${t.questions.filter((q) => q.used).length}/${t.questions.length} questions in ${t.ms} ms${where}${waited}`]
      const taskGroup = t.questions.some((q) => !RESOURCE_CALL.has(q.name))
      const flat = t.phase === 'route' ? t.questions.filter((q) => filledByRules(q, taskGroup)).map((q) => q.name) : []
      if (flat.length) out.push(`${who} route: ${flat.length} answer${flat.length === 1 ? '' : 's'} too flat to use (${flat.join(', ')}); the routing rules filled ${flat.length === 1 ? 'it' : 'them'}`)
      const cut = t.meta?.atContextLimit ?? 0
      if (cut > 0) out.push(`${who} ${t.phase}: ${cut} of ${t.meta.requests ?? cut} request${(t.meta.requests ?? cut) === 1 ? '' : 's'} reached the 512-token limit, so part of the evidence was cut`)
      return out.join('\n')
    }
    // A call that did not answer: it has no questions, only who, which call, how long and why.
    // `error` is what createJev hands its onError hook, `{ phase, callId, provider, ms, error }`;
    // those fields on the event itself are read too. The domains a failed Laya route call leaves
    // behind take their deterministic fallback, and the line says so; a call never sent because
    // Laya would pass its deadline reads as docs/laya-auto.md 3.5 writes it, the prediction alone.
    case 'decider-error': {
      const x = e.error ?? {}
      // A field of the error as jev.js kept it, else of the payload, else of the event.
      const of = (k) => x.error?.[k] ?? x[k] ?? e[k]
      const provider = x.provider ?? e.provider ?? TEACHER
      const phase = x.phase ?? e.phase ?? 'call'
      const code = of('code')
      const rules = provider !== TEACHER && phase === 'route' && code !== 'LAYA_PREDICTED_OVER' ? '; routing rules decide those domains' : ''
      return `${providerName(provider)} ${phase} failed after ${Math.round(x.ms ?? e.ms ?? 0)} ms: ${of('message') ?? 'no reason given'}${timeoutSize({ code, questions: of('questions'), device: of('device') })}${rules}`
    }
    case 'routed': {
      const note = SHADOW_NOTE[e.shadow] ? `\n${SHADOW_NOTE[e.shadow]}` : ''
      if (e.tool) return `Routed to tool ${e.tool}${note}`
      const strategy = e.plan?.strategy && e.plan.strategy !== 'STANDARD_DIRECT' ? `, ${e.plan.strategy.toLowerCase().replace(/_/g, ' ')}` : ''
      const reviewer = e.plan?.reviewer ? `, ${e.plan.reviewer} reviews` : ''
      // A run another provider decided names it, and the mode only when the pool was narrowed or
      // nobody routed: `(laya)`, `(laya, local)`. Jev's line is as it always was.
      const decider = e.routing.decider ?? TEACHER
      const how = decider === TEACHER ? e.routing.mode : e.routing.mode === 'jev' ? decider : `${decider}, ${e.routing.mode}`
      return `Routed to ${e.routing.primaryAgent} (${how})${strategy}${reviewer}${note}`
    }
    // Who decided, at what maturity, and how the candidates compared. One line: the inspector's
    // Decisions tab carries the full table. The calls are counted to whoever decided the run.
    case 'decision': {
      const name = providerName(e.decision?.decider ?? TEACHER)
      const calls = e.decision?.jevCalls ?? 0
      const who = decidedBy(e.decision?.domains) ?? `${name} decided`
      const seen = e.decision?.candidates?.length ?? 0
      return `${who}; ${calls ? `${calls} ${name} call${calls === 1 ? '' : 's'}` : `no ${name} call`}; ${seen} candidate${seen === 1 ? '' : 's'} considered`
    }
    // Under Laya the near tie is always the routing rules' own ranking (the resource is a code
    // domain), so that is who could not tell; Jev's line is as it was.
    case 'tiebreak': return `${(e.decider ?? TEACHER) === TEACHER ? 'Jev' : 'The routing rules'} could not tell ${e.from} from ${e.to} (confidence ${e.confidence == null ? 'unknown' : Math.round(e.confidence * 100)}%): ${e.to} takes the work as the standing policy`
    case 'stalled': return `${e.attempts} work attempts in a row changed no files (${(e.agents ?? []).join(', ')}): stopping instead of spending again`
    case 'checks': return `Baseline checks: ${e.checks.map((c) => `${c.name} ${c.passed ? 'pass' : 'FAIL'}`).join(', ')}`
    case 'capability': return `${e.from} cannot do this (${e.capability ?? 'capability unclear'}): ${e.to} takes the work`
    case 'attempt_start': return `Running ${e.agent} (${e.role})…`
    case 'attempt_end': return `${e.attempt.agent}${e.attempt.effort ? ` (effort ${e.attempt.effort})` : ''} finished: ${e.attempt.stopReason} in ${Math.round(e.attempt.durationMs / 1000)}s`
    case 'review': return `Review: ${e.assessment.action}. ${e.assessment.why}`
    case 'balance': return `${e.agent} credit ${e.balance ? `${e.balance.amount} ${e.balance.currency ?? ''}`.trim() : 'changed'}: ${{ near: 'low, working in small steps and keeping the handoff current', stopped: 'below the floor, handing the task over', exhausted: 'spent, handing the task over' }[e.state] ?? e.state}`
    case 'gate': return `${e.agent} is ${e.percent == null ? 'past' : `${Math.round(e.percent)}% into`} its weekly window (gate ${e.at}%): ${e.to} takes the work, ${e.agent} stays for review`
    case 'feedback': return `Feedback moved the pick${e.from ? ` off ${e.from}` : ''} to ${e.to}`
    case 'limit': return `${e.agent} hit its usage limit${e.until ? ` (resets ${new Date(e.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}: ${{ rotated: 'switched API key, continuing', peer: 'handing the task to another agent', paused: 'no agent left, pausing' }[e.action] ?? e.action}`
    case 'handoff': return `Handoff note saved (${e.source === 'agent' ? 'by the agent' : 'by the harness'}): ${e.path}`
    case 'final': return `Final: ${e.status}`
    case 'error': return `Error: ${e.message}`
    default: return e.type
  }
}

// Seconds as the picker says them: one decimal under ten, whole above.
const seconds = (ms) => { const s = ms / 1000; return String(s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) }

/**
 * The sentence the Laya Auto row adds to its description, by Laya's state on this PC
 * (docs/laya-auto.md 3.1), so the menu says what a task costs before it is picked.
 * @param {object} row  what `layaRow` answers: `state` (the sidecar's, 7.4), `device` ('cuda' or
 *   'cpu', where it runs or would start), `routeMs` (the measured intent, task group and resource
 *   and judgments calls together, on that device), `reviewMs` (one measured review call) and
 *   `lastStartMs` (how long the last start took), each null when unknown
 * @returns {string}
 */
export function layaRowSentence(row) {
  if (row?.state === 'failed') return 'Laya could not start: press Start in Settings → Jev setup → Laya decision model.'
  // An update that failed over a stopped Laya leaves the old install, which the first message starts.
  if (row?.state === 'stopped' || row?.state === 'install_failed') return `Laya is not running; the first message starts it${typeof row.lastStartMs === 'number' ? ` (the last start took ${seconds(row.lastStartMs)} s)` : ''}.`
  if (row?.device && typeof row.routeMs === 'number' && typeof row.reviewMs === 'number') {
    return `Measured on this PC, on the ${deviceName(row.device)}: about ${seconds(row.routeMs)} s to route a task and ${seconds(row.reviewMs)} s to review each attempt.`
  }
  return 'Not measured on this PC yet.'
}

/**
 * @param {object} p
 * @param {object} p.ctx     cordis context with `llm` and `agents`
 * @param {Function} p.route the router's route({ task, agent, forceAgent, mode, decider, signal, emit })
 * @param {Function} [p.classify] (message, mode, decider, { onWait, signal }) -> { kind: 'task' | 'question', thresholds?, unsure?, why? };
 *   `onWait(line)` is each line of what it waits for (Laya starting on this PC), shown as it comes
 * @param {{provider: string, model: string}} p.auxModel real model for title and compaction requests
 * @param {(ms: number, model: {provider: string, model: string}, row: {decider: 'jev'|'laya'}) => void} [p.onDirectAnswer] a question in a project was answered by a chat model, no agent;
 *   `row.decider` is who decides the row the question came through, for the usage row: "Saved by Jev" counts only Jev's
 * @param {(decider: 'jev'|'laya') => Promise<boolean>} [p.isOffline] true when the internet is unreachable, probed where the
 *   row's decider says: a Laya Auto session never contacts a TypeSafe host
 * @param {() => Promise<{provider: string, model: string}|null>} [p.localChat] the local chat model, when one is installed
 * @param {object} [p.orchestrator] background tasks: { pending(sessionId) -> string[], ackPending(sessionId), enqueue({ agent, task, effort, forceAgent, mode, sessionId, modalities }, { decider, why }) -> chat text, or null to run blocking }
 * @param {() => Promise<Array<{id: string, description?: string, kind?: string, enabled?: boolean}>>} [p.agents] enabled agents, each offered as its own model
 * @param {(model: {provider: string, model: string}) => Promise<boolean>} [p.canSeeImages] does this model's own catalog entry declare image input?
 * @param {(agentId: string) => Promise<boolean>} [p.agentSeesImages] can this agent be handed an image (its tools open the file)?
 * @param {(refs: Array<object>, o: {sessionId?: string, cwd?: string}) => Promise<string[]>} [p.handOffImages] save image bytes where an agent can read them, returning the paths
 * @param {() => Promise<Array<object>>} [p.answerExecutors] the registered chat executors, for capability-routed direct answers
 * @param {(role: 'act') => void|Promise<void>} [p.layaUnavailable] throws, with the reply the person reads, when Laya cannot be
 *   asked at all (docs/laya-auto.md 3.5); a Laya Auto message is refused with it before anything is sorted or run
 * @param {() => Promise<object|null>} [p.layaRow] Laya's state for the Laya Auto row (layaRowSentence), or null while
 *   the row is not offered: Laya not installed, switched off, its settings invalid, or adaptive routing off
 */
export function jevAdapter({ ctx, route, classify, auxModel, onDirectAnswer, isOffline, localChat, orchestrator, agents, canSeeImages, agentSeesImages, handOffImages, answerExecutors, layaUnavailable, layaRow }) {
  // Typed messages seen per session: a turn with no new one is a job notice (or a retry), not a new task.
  const seenTyped = new Map()
  // An image with no words is still something the person sent. Leaving it out of the count
  // would make that turn look like a repeat of the last one and never run.
  const hasImage = (m) => (m?.content ?? []).some((b) => b?.type === 'image')
  const isTyped = (m) => typedByPerson(m) && (!!textOf(m.content) || hasImage(m))

  // Does anything downstream of this row really read a picture? Asked of the catalog rather
  // than assumed: the same declaration the engine's own gate consults.
  const chatSeesImages = async (m) => !!m && (await canSeeImages?.(m).catch(() => false)) === true
  const agentSees = async (a) => (await agentSeesImages?.(a.id).catch(() => false)) === true
  // Cached briefly: listModels asks once per row, and each answer walks every agent.
  let visionCache = { at: 0, value: null }
  const anyVisionPath = async () => {
    if (visionCache.value !== null && Date.now() - visionCache.at < 10_000) return visionCache.value
    let value = await chatSeesImages(auxModel)
    if (!value) {
      const local = await localChat?.().catch(() => null)
      if (local) value = await chatSeesImages(local)
    }
    if (!value) for (const a of await agents?.().catch(() => []) ?? []) {
      if (a.enabled !== false && await agentSees(a)) { value = true; break }
    }
    visionCache = { at: Date.now(), value }
    return value
  }
  // Chat models to try, in order. Conversation starts on the local model when one is
  // installed: free, private, instant, and the hosted model sits behind it. Jev's `depth`
  // answer is what moves a question the local model would answer badly to the front, and a
  // model that fails to answer still falls through to the next one.
  //
  // When the caller supplies a registry, the order comes from it instead: the same capability
  // filter and ranking the background executors get, so a chat model is chosen for what it can
  // actually do (`quick_answer` or `reasoned_answer`) rather than by a rule kept in here.
  // Whether the internet is there is asked where the row's decider says, so Laya Auto never
  // probes a TypeSafe host to pick the model that answers.
  const chatModels = async (mode = 'auto', { deep = false, images = false, decider = TEACHER } = {}) => {
    const local = await localChat?.().catch(() => null)
    const offline = mode === 'offline' || await isOffline?.(decider).catch(() => false)
    const wanted = {
      capability: deep ? 'reasoned_answer' : 'quick_answer',
      modalities: images ? ['text', 'image'] : ['text'],
      mutation: false,
      ...(offline ? { locality: 'local', network: false } : mode === 'online' ? { locality: 'hosted' } : {}),
    }
    const ranked = await answerExecutors?.().then((list) => (list?.length ? rank(eligible(list, wanted), { simple: !deep }) : null)).catch(() => null)
    if (ranked?.length) {
      // A difficult question goes to the stronger configured conversational model, not to the
      // cheapest capable one: the spec asks for the fastest capable local model on *simple*
      // answers and the stronger model on hard ones. Cost ranking is for the simple case, and
      // without this the credit line would claim "Jev judged this worth the stronger model"
      // while a small local model was doing the answering.
      const isAux = (e) => e.provider === auxModel.provider && e.model === auxModel.model
      const ordered = deep ? [...ranked].sort((a, b) => Number(isAux(b)) - Number(isAux(a))) : ranked
      return { offline, models: ordered.map((e) => ({ provider: e.provider, model: e.model })) }
    }
    const list = offline
      ? (local ? [local] : [])
      : (deep && local ? [auxModel, local] : [local, auxModel]).filter(usableModel)
    if (!images) return { offline, models: list }
    return { offline, models: await keepReaders(list) }
  }
  /** Only the models that really read an image, in the order they were given. */
  const keepReaders = async (list) => {
    const canRead = []
    for (const m of list) if (await chatSeesImages(m)) canRead.push(m)
    return canRead
  }
  return {
    // The group holds Laya Auto and the plain agent rows as well as Jev's, so it is named for the
    // app; its id stays `jev`, so saved selections and the installer's default are untouched.
    providerInfo: (p) => ({ id: p, name: 'Kz-harness' }),
    providerRetryPolicy: () => NO_RETRY,
    imageRequestPricing: () => undefined,
    async listModels(p) {
      // A catalog that cannot be read still offers Jev Auto, so the picker never comes up empty.
      const list = await agents?.().catch(() => []) ?? []
      const hasLocal = list.some((a) => a.kind === 'local' && a.enabled !== false)
      // Laya Auto is on offer only while Laya can be asked at all, and says by its state what a
      // task costs on this PC; a reader that fails offers nothing rather than a row that refuses.
      const laya = await layaRow?.().catch(() => null) ?? null
      // Every extra row is about drawing a line between the local models and the rest, so with no
      // local model installed there is no line to draw: the two local rows cannot run, and Online
      // would be a second name for Jev Auto, which already has nothing but cloud agents to pick.
      const ways = Object.keys(JEV_MODELS).filter((id) => (id === LAYA_MODEL ? !!laya : id === MODEL || hasLocal))
      // A Jev row can carry an image only when the run it starts will end somewhere that
      // reads it. Saying so otherwise is worse than refusing: the engine stops blocking the
      // attachment and the picture is silently dropped on the way to a model that never saw it.
      const any = await anyVisionPath()
      const rows = await Promise.all(list.filter((a) => a.enabled !== false).map(async (a) => [a, await agentInfo(p, a, (await agentSees(a)) ? BY_MODALITY : TEXT_ONLY)]))
      const row = (id) => {
        const r = info(p, any ? BY_MODALITY : TEXT_ONLY, id)
        return id === LAYA_MODEL ? { ...r, description: `${r.description} ${layaRowSentence(laya)}` } : r
      }
      return [...ways.map(row), ...rows.map(([, r]) => r)]
    },
    async resolveModel(p, m) {
      const id = agentIdOf(m)
      const a = id && (await agents?.().catch(() => []) ?? []).find((x) => x.id === id)
      if (a) return { ...agentInfo(p, a, (await agentSees(a)) ? BY_MODALITY : TEXT_ONLY), context: { contextWindow: 1_000_000 } }
      return { ...info(p, (await anyVisionPath()) ? BY_MODALITY : TEXT_ONLY, m), context: { contextWindow: 1_000_000 } }
    },
    async prepareCall(p, m, s) {
      // Keep the picked model on the call: a forced agent is read back from it in stream().
      return { model: await this.resolveModel(p, m, s), stream: (o) => this.stream({ ...o, model: o.model ?? m }) }
    },

    async *stream(options) {
      const lastTyped = options.messages.findLast(isTyped)
      const task = textOf(lastTyped?.content)
      // Images ride the same message. They reach a chat model as blocks (the adapter that
      // talks to the provider reads the bytes), but never an agent prompt, which is a string.
      const images = (lastTyped?.content ?? []).filter((b) => b?.type === 'image')
      // "Claude Code" or "Codex (GPT)" picked in the model menu: that agent, every message.
      const pickedAgent = agentIdOf(options.model) ?? undefined
      // Jev Auto / Local / Online / Offline: how wide the field of agents is. Laya Auto: Laya
      // decides instead of Jev, over the same field Jev Auto has.
      const row = rowOf(options.model)
      let mode = row.mode
      const { decider } = row
      // A local-* effort means "run it locally on this size of model": it forces the
      // agent and keeps the run local, whichever Jev row is picked. That includes Online:
      // the effort is a per-message choice and the row is a standing one, so the specific
      // choice wins, exactly as it already does over plain Jev Auto. It changes only the mode:
      // under Laya Auto the forced run is still Laya's to review.
      let effort = options.reasoningEffort
      let localForced
      if (!options.purpose && isLocalLevel(effort)) {
        const list = await agents?.().catch(() => []) ?? []
        localForced = localAgentFor(effort, list)
        effort = undefined
        if (localForced) mode = mode === 'offline' ? 'offline' : 'local'
      }
      // localAgentFor returns null when nothing is installed; keep one absent value.
      const forceAgent = pickedAgent ?? localForced ?? undefined

      // Side requests (session title, compaction) reuse this route; a real model answers them.
      // The resolved aux model while it is usable, the local one otherwise: naming a chat is one
      // short line of housekeeping, and an empty aux pair would fail the request outright.
      if (options.purpose) {
        const { reasoningEffort: _r, ...rest } = options
        const local = await localChat?.().catch(() => null)
        // The local model is the only thing the probe could switch to, and with none installed
        // offline and online pick the same model, so the probe would decide nothing and is
        // skipped: a session title must not be what sends the HEAD out on its own. When it does
        // go out, it goes where the row's decider says, never to TypeSafe from Laya Auto.
        const offline = local ? await isOffline?.(decider).catch(() => false) : false
        const aux = usableModel(auxModel) ? auxModel : null
        const m = (offline ? local : aux) ?? local ?? auxModel
        // A title has a tiny output budget: no thinking, as the official DeepSeek connector did.
        const title = options.purpose === 'session-title' && m.provider !== 'local' ? { reasoningEffort: 'off' } : {}
        yield* ctx.llm.stream({ ...rest, ...title, provider: m.provider, model: m.model })
        return
      }

      const agent = (options.sessionId && ctx.agents.get(options.sessionId)) ?? ctx.agents.currentInitiator?.()
      const sid = options.sessionId ?? agent?.session?.id ?? agent?.id
      // Finished background results. They are never prepended to a model's answer: that made a
      // background agent look like it interrupted whoever was speaking, with no way to tell
      // whose text was whose. Reading does not consume them, so a turn that dies before the
      // text is out cannot lose the only copy.
      const unread = orchestrator?.results?.(sid) ?? []
      // Called once the text has actually gone out, which is what marks a result read.
      const typed = options.messages.filter(isTyped).length
      const fresh = seenTyped.get(sid) !== typed
      // Re-insert so the cap evicts the least recently USED, not the first seen: evicting a
      // live session loses its counter, and the next job notice then looks like a new task
      // and routes the work a second time.
      seenTyped.delete(sid)
      seenTyped.set(sid, typed)
      if (seenTyped.size > 200) seenTyped.delete(seenTyped.keys().next().value)
      // A turn carrying no new typed message is a notice answering itself (a settled job, a
      // subagent, a schedule). Results are NOT written here: the plugin posts each one as its
      // own message (index.js deliverResult), which is the only way a background result can
      // avoid borrowing the assistant's voice - and the only way it cannot be posted twice.
      const afterTyped = options.messages.slice(options.messages.findLastIndex((m) => isTyped(m)) + 1)
      if (orchestrator && !fresh && (afterTyped.some(isJobNotice) || unread.length)) {
        const live = orchestrator.live?.(sid) ?? 0
        yield* textReply(live || unread.length
          ? `Still working: ${live} task${live === 1 ? '' : 's'} in this workspace${unread.length ? `, ${unread.length} result${unread.length === 1 ? '' : 's'} still to post` : ''} (see the task list).`
          : 'Nothing here needs you; a finished task arrives as its own message.')
        return
      }
      // Highest block index the model used, so later blocks do not collide with its own.
      const pos = { last: -1 }
      if (!task && !images.length) { yield* textReply(`Type a task and ${providerName(decider)} will route it.`); return }
      // A bare `/skill` message only loads that skill into the conversation; there is nothing to run yet.
      const skill = task.match(/^\/([\w:.-]+)$/)
      if (skill && !images.length) { yield* textReply(`Skill \`${skill[1]}\` is loaded into this conversation. Tell me what to do with it.`); return }
      // Laya Auto when Laya cannot be asked at all (not installed, switched off, its settings
      // invalid, routing off, or stopped after an error): the same reply route() would give, but
      // at once, before anything is sorted or run, and never a switch to Jev (docs/laya-auto.md 3.5).
      if (decider === 'laya' && layaUnavailable) {
        try { await layaUnavailable('act') } catch (err) { yield* textReply(String(err?.message ?? err)); return }
      }
      // One classifier call for both branches below. `depth` is the decider saying how much
      // answering this well depends on real reasoning: it decides which model answers, not how
      // hard anyone works. While it waits (Laya starting on this PC) it says what it waits for,
      // as it happens, in a reasoning block of its own that opens only if there is something to say.
      let cls = null
      // The first block free for what the message shows next: 0, or after the waiting lines.
      let first = 0
      if (!forceAgent && task && classify) {
        const waits = []
        let wake
        let settled = false
        const onWait = (w) => { waits.push(typeof w === 'string' ? w : w?.text ?? line(w)); wake?.() }
        const onStop = () => wake?.()
        options.signal?.addEventListener('abort', onStop, { once: true })
        Promise.resolve()
          .then(() => classify(task, mode, decider, { onWait, signal: options.signal }))
          .then((r) => { cls = r ?? null }, () => { cls = null })
          .finally(() => { settled = true; wake?.() })
        let at = null
        let said = ''
        try {
          while ((!settled || waits.length) && !options.signal?.aborted) {
            if (!waits.length) { await new Promise((r) => { wake = r }); wake = undefined; continue }
            if (at === null) { at = pos.last + 1; yield { type: 'block-start', index: at, blockType: 'reasoning' } }
            const text = `${waits.shift()}\n`
            said += text
            yield { type: 'reasoning-delta', index: at, text }
          }
        } finally { options.signal?.removeEventListener('abort', onStop) }
        if (at !== null) { yield { type: 'block-end', index: at, block: { type: 'reasoning', text: said } }; pos.last = at; first = at + 1 }
        if (!settled) throw new DOMException('Stopped', 'AbortError')
      }
      const deep = cls?.depth === 'deep'
      const answer = async function* (plan, note, onAnswered) {
        // Whatever this message already showed (the lines of a Laya start) keeps its blocks: the
        // model's own blocks are numbered after them.
        pos.shift = first
        return yield* answerWithAny(ctx, options, plan, onAnswered, note, pos)
      }
      // An image cannot ride the agent prompt: that prompt is one string, and the Claude Code
      // and Codex bridges flatten content blocks to text before their CLI ever sees them. So
      // the bytes go to a file and the agent is told the path - a path is the one thing that
      // survives the trip, because reading a file is the agent's own tool, not the hub's.
      let handedOff
      const handOff = async () => {
        if (handedOff !== undefined) return handedOff
        handedOff = images.length
          ? await handOffImages?.(images.map((b) => b.attachment), { sessionId: sid, cwd: agent?.session?.header?.cwd }).catch(() => []) ?? []
          : []
        return handedOff
      }
      const imageLine = async () => {
        const paths = await handOff()
        if (!paths.length) return ''
        const what = paths.length === 1 ? 'an image' : `${paths.length} images`
        return `The person attached ${what}. Open ${paths.map((p) => `\`${p}\``).join(', ')} and look at ${paths.length === 1 ? 'it' : 'them'} before you answer.\n\n`
      }

      // "No project": everything is chat. Project work needs a real folder for the agents.
      if (isNoProject(agent?.session?.header?.cwd)) {
        // Unsure stays on the answering side here, unlike in a real project: no agent can run
        // in this space at all, so refusing an unsure message helps nobody. A message Laya could
        // not sort is such a message: a task only because nothing said otherwise.
        if (forceAgent || (cls?.kind === 'task' && !cls.unsure)) {
          yield* textReply('This is the **No project** space, so no agent can work on files here. Pick or add your project folder in the workspace menu next to the message box, then send the task again. Questions are answered here directly.', first)
          return
        }
        const answered = yield* answer(await chatModels(mode, { deep, images: images.length > 0, decider }), deepNote(deep, mode, decider))
        if (answered !== true) {
          yield* textReply(images.length
            ? 'No model available here can read an image: the chat model is text-only and no local vision model is installed. Add the vision add-on in Settings → Jev setup → Local models, or switch to a model that reads images, then send it again.'
            : `No chat model could answer (${answered}). Check DeepSeek or Local models in Settings → Jev setup, or ask inside a project folder so an agent can answer.`, first)
          return
        }
        return
      }

      // Questions get a direct answer from a chat model; only project work goes to the agents.
      let routeTask = task
      let answerOnly = false
      // Only a confident "question" skips the agents. The two mistakes are not equal: calling
      // a question a task costs one agent run, while calling a task a question sends real work
      // to a chat model with no file access, which cannot do it at all. So an unsure answer
      // falls to the task side.
      if (!forceAgent && isQuestion(cls)) {
        const started = Date.now()
        const choices = await chatModels(mode, { deep, images: images.length > 0, decider })
        const answered = yield* answer(choices, deepNote(deep, mode, decider), (m) => onDirectAnswer?.(Date.now() - started, m, { decider }))
        if (answered === true) {
          // "One message may do both": a message can be a question and also ask for work. The
          // answer has just gone out, so the work is queued behind it and the queue line rides
          // at the end of this same message - the person is answered now and the work starts.
          // Who decides rides beside the task's own fields: the queued run is the row's.
          if (alsoWork(cls) && orchestrator) {
            try {
              const queued = await orchestrator.enqueue({ agent, task: (await imageLine()) + task, effort, forceAgent, mode, sessionId: sid, modalities: images.length ? ['text', 'image'] : ['text'] }, { decider })
              if (queued) yield* textBlock(`\n\n${queued}`, pos.last + 1)
            } catch (err) { yield* textBlock(`\n\njev-router: ${err.message}`, pos.last + 1) }
          }
          return
        }
        // No chat model available: one agent answers, without touching the project, checks or review.
        process.stdout.write(`[jev] No chat model could answer (${answered}); asking an agent\n`)
        routeTask = `Answer this question directly and briefly. Do not modify any files.\n\n${task}`
        answerOnly = true
      }

      // Anything an agent has to look at goes with the prompt, or the run is refused outright:
      // an agent working from the words alone would answer about a picture it never saw.
      if (images.length) {
        if (!(await handOff()).length) {
          yield* textReply('I could not put the attached image anywhere an agent can read it, so I have not started this task: the agent would work from your words alone and never see the picture. Nothing was run. Attach the file instead (the paperclip), which agents can open by path, or ask about the image in a chat.', first)
          return
        }
        routeTask = (await imageLine()) + routeTask
      }

      // A message the decider could not sort is run as a task, and the person is told why: with
      // the queued line (queuedLine appends it), or first among the live lines.
      const why = cls?.why ?? null
      // Project work runs in the background (one at a time per workspace); the chat stays free.
      if (!answerOnly && orchestrator) {
        let queued
        // routeTask, not task: a queued run needs the image path with its prompt too.
        try { queued = await orchestrator.enqueue({ agent, task: routeTask, effort, forceAgent, mode, sessionId: sid, modalities: images.length ? ['text', 'image'] : ['text'] }, { decider, why }) } catch (err) { yield* textReply(`jev-router: ${err.message}`, first); return }
        if (queued) { yield* textReply(queued, first); return }
      }
      // Live routing progress first, then the report. `pos` keeps the block indices honest so a
      // finished result can be appended after all of it instead of in front.
      const base = pos.last + 1

      // Router events -> live reasoning lines, report -> reply text. A local
      // controller stops the run on Stop and also when the runtime drops this stream.
      const ac = new AbortController()
      const onAbort = () => { ac.abort(options.signal?.reason); wake?.() }
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true })
      const queue = why ? [why] : []
      let wake
      let done = false
      let result
      let error
      const emit = (e) => { queue.push(line(e)); wake?.() }
      route({ task: routeTask, answerOnly, agent, forceAgent, mode, decider, effort, modalities: images.length ? ['text', 'image'] : ['text'], signal: ac.signal, emit })
        .then((r) => { result = r }, (e) => { error = e })
        .finally(() => { done = true; wake?.() })

      try {
        let trace = ''
        yield { type: 'block-start', index: base, blockType: 'reasoning' }
        while ((!done || queue.length) && !ac.signal.aborted) {
          if (!queue.length) { await new Promise((r) => { wake = r }); wake = undefined; continue }
          const text = `${queue.shift()}\n`
          trace += text
          yield { type: 'reasoning-delta', index: base, text }
        }
        yield { type: 'block-end', index: base, block: { type: 'reasoning', text: trace } }
        pos.last = base
        if (ac.signal.aborted) throw error ?? new DOMException('Stopped', 'AbortError')
        yield* textReply(error ? `jev-router: ${error.message}` : result, base + 1)
        pos.last = base + 1
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        if (!done) ac.abort()
      }
    },
  }
}

/**
 * What the chat model is told before the person's own words. Deliberately short: this text
 * rides every direct answer, and a small local model copies the shape of a long brief into a
 * long answer. Plain talk was the whole request, so it is one sentence of context and one of
 * style - restating the app's architecture made every chat reply sound like a manual.
 */
const ABOUT = 'You are talking with the person who runs this app: Kz-harness, where the Jev router sends coding work to Claude Code, Codex, DeepSeek or models on this PC, and questions like this one are answered directly (logins, keys and usage limits are in Settings → Jev setup). Reply the way a person talks in chat: a couple of plain sentences, no headings, no bullet lists, no restating the question. Say so briefly when you are unsure.'

/** The decider's reason for putting a stronger model first, said out loud in the answer's credit line. */
const deepNote = (deep, mode, decider = TEACHER) => (deep && mode !== 'offline'
  ? `${providerName(decider)} judged this worth the stronger model, so `
  : '')

/** Try each chat model in order until one answers; returns true, or the last failure reason. */
async function* answerWithAny(ctx, options, { offline, models }, onAnswered, note = '', pos) {
  let why = offline ? 'offline and no local model installed' : 'no chat model configured'
  let i = 0
  for (const m of models) {
    // The first model gets Jev's own reason for the pick; a later one is a hand-off.
    const said = i === 0 ? note : `${models[0].provider === 'local' ? 'the local model could not answer this, so ' : 'the first model could not answer, so '}`
    const r = yield* answerDirectly(ctx, options, m, offline, said, pos)
    if (r === true) { onAnswered?.(m); return true }
    process.stdout.write(`[jev] Chat model ${m.provider}/${m.model} could not answer (${r})\n`)
    why = r
    i++
  }
  return why
}


/**
 * Stream the answer from the chat model. Returns true, or the failure reason (having yielded nothing)
 * when that model fails before producing text, so the caller can fall back to an agent.
 * `pos` records the highest block index used, so a finished result can be appended after the answer.
 */
async function* answerDirectly(ctx, options, auxModel, offline = false, note = '', pos) {
  // Ask the catalog what this model is actually called: "deepseek-flash" is an api
  // id, and says nothing about which DeepSeek model answered.
  const pair = `${auxModel.provider}/${auxModel.model}`
  const named = await ctx.llm.resolveModel?.(auxModel.provider, auxModel.model).catch(() => null) ?? null
  const label = named?.name?.trim() || pair
  // No tools: a direct answer must not start work (or call the router) on its own.
  const { reasoningEffort: _r, purpose: _p, tools: _t, toolChoice: _tc, ...rest } = options
  const messages = options.messages.map((m, i) => (i === options.messages.length - 1 && m.role === 'user'
    ? { ...m, content: [{ type: 'text', text: ABOUT }, ...m.content] }
    : m))
  const held = []
  let flowing = false
  // Blocks the stream already holds come first; the model's own are numbered after them.
  const shift = pos?.shift ?? 0
  let lastIndex = shift
  // The name the picker shows, plus the id a bug report needs.
  const credit = `\n\n> ${offline ? 'OFFLINE: local models only. ' : ''}${note}Answered by: ${label}${label === pair ? '' : ` (\`${pair}\`)`}, directly: a question, no agents or project work`
  try {
    for await (const raw of ctx.llm.stream({ ...rest, messages, provider: auxModel.provider, model: auxModel.model })) {
      const chunk = shift && typeof raw.index === 'number' ? { ...raw, index: raw.index + shift } : raw
      if (typeof chunk.index === 'number') { lastIndex = Math.max(lastIndex, chunk.index); if (pos) pos.last = Math.max(pos.last, lastIndex) }
      if (flowing && chunk.type === 'finish' && chunk.reason?.kind === 'stop') {
        const i = lastIndex + 1
        yield { type: 'block-start', index: i, blockType: 'text' }
        yield { type: 'text-delta', index: i, text: credit }
        yield { type: 'block-end', index: i, block: { type: 'text', text: credit } }
      }
      if (flowing) { yield chunk; continue }
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') return `${chunk.reason.failure?.code ?? 'error'}: ${chunk.reason.failure?.message ?? ''}`.slice(0, 200)
      held.push(chunk)
      if (chunk.type === 'text-delta') { flowing = true; for (const c of held) yield c }
    }
  } catch (err) { if (!flowing) return `${err?.code ?? err?.name ?? 'error'}: ${err?.message ?? ''}`.slice(0, 200); throw new Error('chat model stopped mid-answer') }
  if (!flowing) for (const c of held) yield c
  return true
}

/**
 * The chat line for a queued task. With no agent forced, whoever decides the task picks one; `why`
 * is the reason a message the decider could not sort was queued as a task (classify), said after.
 */
export function queuedLine({ jobId, agent, position, workspace, decider = TEACHER, why }) {
  const where = String(workspace).split(/[\\/]/).filter(Boolean).at(-1) ?? workspace
  return `Queued → ${agent ?? `${providerName(decider ?? TEACHER)} picks`} as **${jobId}** (${position > 0 ? `${ordinal(position)} in line for ${where}` : `starting now in ${where}`}). Keep chatting: the result posts here when done.${why ? ` ${why}` : ''}`
}

async function* textReply(text, index = 0) {
  yield* textBlock(text, index)
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
