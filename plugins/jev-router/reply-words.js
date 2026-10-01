// Every sentence the chat shows about a background task before its result lands: the start reply
// (A when the plan is known, B when the task waits its turn, C when the pick takes longer than the
// reply waits), the lines of that wait, the credit under the reply, its hidden marks, the milestone
// notices, the agent line of the result's head, and what a direct answer is told is running now
// (docs/live-agent-view.md, Feature 2). What they quote comes from where it arises: the router's own
// lines (adapter.js line()), which fill the wait's block and a moved notice's body, and the reasons
// a task runs as work that writes or as a task at all.
//
// Facts in, words out, and nothing else: no model writes any of this, so the chat can only ever say
// what the router really picked. Names come in already resolved (adapter.js nameOfAgent), so this
// module needs no agent list of its own.
import { TEACHER, providerName } from './providers.js'
import { placeText, spanText } from './waits.js'

// ---- small words ----------------------------------------------------------------------------------

/** The folder a workspace is known by in a sentence: its last path segment. */
export const folderOf = (workspace) => String(workspace ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? String(workspace ?? '')

/** Seconds as the replies say them: one decimal under ten, whole above. */
export const secondsOf = (ms) => { const s = Math.max(0, ms ?? 0) / 1000; return String(s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) }

/** How long something took, as the credit says it: `in 2.4 s`, and `in under 0.1 s` rather than `in 0 s`. */
const took = (ms) => ((ms ?? 0) < 50 ? 'in under 0.1 s' : `in ${secondsOf(ms)} s`)

/** A span of time in words: `45 s` under a minute, `7 min` under an hour, `1 h 5 min` above. */
export function durationWords(ms) {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/**
 * A notice's summary with no `·` in it. The browser reads a summary split on `·` whose last field
 * is a finished state as a result (client.js resultOf), so a summary without one can never be.
 */
export const noDots = (s) => String(s ?? '').replace(/\s*·\s*/g, ' - ')

/** The effort as the task list shows it (router.js attempt_start): Codex at 1.5x speed says so. */
export const effortWord = (effort, speed) => (effort ? `${effort}${speed === 'fast' ? ' 1.5x' : ''}` : '')

/** An agent's model in a sentence, or what it runs when none is known. */
const modelWords = (model) => model || 'its own default model'

/** `(claude-opus-4-1, effort high)`: an agent's model and effort, the effort left out when it takes none. */
const modelAndEffort = (model, effort, speed) => `(${modelWords(model)}${effort ? `, effort ${effortWord(effort, speed)}` : ''})`

const upper = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s)
const lower = (s) => (s ? `${s[0].toLowerCase()}${s.slice(1)}` : s)
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/**
 * Why a task waits, in the few words a sentence about it carries, by what the lanes say it waits
 * for (tasks.js WAITING has the longer words the task list shows).
 */
export const WAIT_WORDS = Object.freeze({
  workspace: 'another task is running there',
  chat: 'a run started from the chat is using it',
  line: 'an earlier task there is waiting for a free slot',
  cap: 'the resource budget caps how many tasks run at once',
})

/** Why a task waits and, when past runs give a figure for it, how long it still may: `another task is running there, about 4 min left`. */
function waitReason(waiting) {
  const est = waiting?.estimate
  const left = est && Number.isFinite(est.lowMs) && Number.isFinite(est.highMs) ? `, ${spanText(est.lowMs, est.highMs)} left` : ''
  return `${WAIT_WORDS[waiting?.why] ?? 'waiting its turn'}${left}`
}

/**
 * Where a waiting task stands and why: `2nd in line for kz-harness (another task is running
 * there, about 4 min left)`, from where it waits (tasks.js waitingOf, which reads lanes waitOf()).
 */
export function standingWords(waiting, workspace) {
  const where = folderOf(workspace)
  const place = waiting?.why === 'cap' ? `${placeText(waiting)} to start in ${where}` : `${placeText(waiting)} for ${where}`
  return `${place} (${waitReason(waiting)})`
}

/**
 * The start reply's sentence on read-only work, or nothing for a task not judged read only. One that
 * cannot be locked runs as work that writes: it waits for the folder when something holds it, and
 * otherwise takes it, so a task that changes it waits instead. `waits` says it waits for the folder.
 */
export function accessSentence(access, where, waits) {
  const v = access?.verdict
  if (!v?.reads) return ''
  const judged = ` Read only: ${providerName(v.by ?? TEACHER)} judged it only reads the project (${Math.round(v.p * 100)}%, its bar is ${Math.round(v.bar * 100)}%)`
  return access.mode === 'read'
    ? `${judged}, so it runs on an agent locked against writing, beside any task changing ${where}.`
    : `${judged}, but ${access.why ?? 'no agent here can be locked against writing'}, so ${waits ? `it waits for ${where} like work that writes` : `it runs as work that writes, and a task changing ${where} waits for it`}.`
}

// ---- the hidden marks -----------------------------------------------------------------------------
// A message carries data the chat never shows as markdown link reference definitions, which the
// renderer drops, after a blank line (a definition cannot interrupt the paragraph before it). The
// browser reads each back (client.js): the task a start reply is about, the run a message came from,
// who took part, and the intent sample a direct answer's message was recorded as.

/** The task a start reply is about, by its key (tasks.js key), as the live view and the verdict read it. */
export const JOB_MARK = /^\[jev-job\]:\s*kzh-job-1-([\w-]{1,80})\s*$/m
export const jobMark = (key) => (typeof key === 'string' && /^[\w-]{1,80}$/.test(key) ? `[jev-job]: kzh-job-1-${key}` : '')

// The run an answer came from. The engine assigns the message id after this side has returned the
// text, so the message is the only thing that can hold the link; client.js reads it back (RUN_MARK)
// and posts it with a verdict as `runId`.
export const RUN_MARK = /^\[jev-run\]:\s*kzh-run-1-([\w-]{1,80})\s*$/m
export const withRunMark = (text, runId) => (typeof runId === 'string' && /^[\w-]{1,80}$/.test(runId) ? `${text}\n\n[jev-run]: kzh-run-1-${runId}` : text)

// The intent sample a question answered directly was recorded as (intent.js), which a verdict on the
// answer labels: a Like says the message was a question, `should have been a task` that it was not.
export const INTENT_MARK = /^\[jev-intent\]:\s*kzh-intent-1-([\w-]{1,80})\s*$/m
export const intentMark = (sampleId) => (typeof sampleId === 'string' && /^[\w-]{1,80}$/.test(sampleId) ? `[jev-intent]: kzh-intent-1-${sampleId}` : '')

const STRIP_LABEL = 'jev-agents'
const STRIP_PREFIX = 'kzh-agents-1-'

/**
 * The chain as the chat's agent strip reads it (client.js STRIP_MARK), carrying the steps as
 * base64url JSON. A report ends with one, and any message that names who works on a task can carry
 * one the same way.
 */
export const agentsMark = (steps) => `[${STRIP_LABEL}]: ${STRIP_PREFIX}${Buffer.from(JSON.stringify(steps)).toString('base64url')}`

/**
 * The working agent's step of the agent strip (router.js answeredSteps writes a report's): the agent
 * by its id, which a verdict's attribution reads (client.js verdictProvider), with its model and
 * effort as a report writes them, or the tool that takes the work.
 */
export const workerStep = (plan) => (plan?.tool
  ? { agent: plan.tool, model: '', roles: ['tool'] }
  : { agent: plan?.agent, model: [plan?.model, effortWord(plan?.effort, plan?.speed)].filter(Boolean).join(', '), roles: ['work'] })

/**
 * A start reply with its hidden lines: the task, the run once one has begun, and who works on it once
 * that is known (the steps router.js answeredSteps writes, agent ids included, since a verdict's
 * attribution reads the agent from them).
 */
export function withMarks(text, { key, runId, steps } = {}) {
  const job = jobMark(key)
  const marked = withRunMark(job ? `${text}\n\n${job}` : text, runId)
  return steps?.length ? `${marked}\n\n${agentsMark(steps)}` : marked
}

// ---- the start reply --------------------------------------------------------------------------------

/**
 * Reply A: the plan is known, because the agent was forced or the router picked within the wait.
 * `agent` is the working agent's name with its `model`, `effort` and `speed`; `reviewer` and
 * `planner` are `{ name, model }` when the plan has them; `localFirst` says a local model goes
 * first; `tool` names a tool that takes the work; `waiting` is where a forced task stands when it
 * waits its turn; `access` and `why` are the read-only verdict and the reason an unsure message runs
 * as a task; `credit` is the line under it (creditLine).
 */
export function planReply({ jobId, workspace, agent, model, effort, speed, reviewer, planner, localFirst, tool, waiting, access, why, credit }) {
  const where = folderOf(workspace)
  const first = tool
    ? `OK, I'll run the **${tool}** tool on this in the background as **${jobId}** in ${where}.`
    : `OK, I'll run **${agent}** with ${model ? `**${model}**` : modelWords(model)}${effort ? ` (effort ${effortWord(effort, speed)})` : ''} in the background as **${jobId}** in ${where}${reviewer ? `, and **${reviewer.name}** reviews it before it's accepted` : ''}.`
  const parts = [
    first,
    !tool && planner ? ` **${planner.name}** (${modelWords(planner.model)}) writes a plan for it first.` : '',
    !tool && localFirst ? ' If the local model can\'t finish it, a stronger agent takes over.' : '',
    waiting ? ` It waits ${placeText(waiting)} (${waitReason(waiting)}).` : '',
    accessSentence(access, where, !!waiting && waiting.why !== 'cap'),
    why ? ` ${why}` : '',
    ' I\'ll report back here when it\'s done. Keep chatting.',
  ]
  return `${parts.join('')}${credit ? `\n\n${credit}` : ''}`
}

/** What a reply promises about the pick: to say it here, unless milestone notices are off. */
const promise = (says, sayWhich) => (says ? sayWhich : 'I\'ll report back here when it\'s done')

/** Reply B's first sentence: the task is queued, where it stands and why. */
export const queuedSentence = ({ jobId, workspace, waiting }) => `OK, **${jobId}** is queued: ${standingWords(waiting, workspace)}.`

/**
 * Reply B: the task waits its turn, so nobody has picked its agent yet. `waiting` is where it stands
 * (tasks.js waitingOf); its `facts` (waits.js slotFacts) follow the first sentence. `progress` is
 * the chat replies setting: with milestones off the reply promises only the result.
 */
export function queuedReply({ jobId, workspace, waiting, decider = TEACHER, access, why, progress = 'milestones' }) {
  const where = folderOf(workspace)
  const facts = waiting?.facts ? ` ${waiting.facts}` : ''
  return `${queuedSentence({ jobId, workspace, waiting })}${facts}${accessSentence(access, where, waiting?.why !== 'cap')}${why ? ` ${why}` : ''} ${providerName(decider ?? TEACHER)} picks the agent when it starts; ${promise(progress !== 'off', 'I\'ll say which here, and report back when it\'s done')}. Keep chatting.`
}

/**
 * Reply C's first sentence: the task is starting and its agent is still being chosen, for
 * `waitedMs` so far when the reply waited for the pick (none when it did not wait).
 */
export const startingSentence = ({ jobId, workspace, decider = TEACHER, waitedMs = null }) => `OK, **${jobId}** is starting in ${folderOf(workspace)}, and ${providerName(decider ?? TEACHER)} is ${waitedMs ? `still choosing the agent (${secondsOf(waitedMs)} s so far)` : 'choosing the agent'}.`

/** Reply C: the task has started, and the pick takes longer than the reply waits (or it does not wait). */
export function startingReply({ jobId, workspace, decider = TEACHER, waitedMs = null, access, why, progress = 'milestones' }) {
  return `${startingSentence({ jobId, workspace, decider, waitedMs })}${accessSentence(access, folderOf(workspace), false)}${why ? ` ${why}` : ''} ${promise(progress !== 'off', 'I\'ll say here which one it picks, and report back when it\'s done')}. Keep chatting.`
}

/** The reply for a task that ended while the reply waited for its pick: its result follows as its own message. */
export const endedReply = ({ jobId, decider = TEACHER, label }) => `**${jobId}** ended before ${providerName(decider ?? TEACHER)} picked its agent (${label}). Its result is posted here as its own message.`

// ---- the lines of the wait --------------------------------------------------------------------------
// A reasoning block opens only after a moment with nothing to show, so a quick answer looks instant.

/** The line while the decider sorts the message into a task or a question. */
export const readingLine = (decider = TEACHER) => `${providerName(decider ?? TEACHER)} is reading your message (task or question)…`

/** The line while the reply waits for the pick, which says what Stop does here. */
export const choosingLine = ({ jobId, waitMs }) => `Queued as ${jobId}. Choosing the agent (I reply once it's picked, at most ${secondsOf(waitMs)} s). Stop here ends this reply only; the task keeps going (stop it on the work board).`

// ---- the credit -------------------------------------------------------------------------------------

/** What kind of work a task is, from the decider's task type (routing-policy.js TASK_SKILLS keys). */
const TASK_TYPE_WORDS = Object.freeze({
  architecture: 'a design question',
  implementation: 'a code change',
  debugging: 'a bug to fix',
  review: 'a review',
  refactor: 'a refactor',
  testing: 'test work',
  documentation: 'a docs change',
  investigation: 'an investigation',
  security: 'security work',
  performance: 'performance work',
  simple_change: 'a small change',
})

// Where the words for a risk or a complexity change: the cuts Auto effort reads by default
// (providers.js effortBands medium and high), so `medium risk` lands where Auto says high.
const BAND = (x) => (x < 0.375 ? 0 : x < 0.6 ? 1 : 2)

/**
 * What drove Auto effort, in words: Auto reads the larger of complexity and risk, an unknown one as
 * 0.5 (effort.js autoLevel), so that one is named, `medium risk` or `complex`, and nothing is when
 * the larger is the one nobody knows.
 */
function driverWords({ complexity, risk }) {
  const c = Number.isFinite(complexity) ? complexity : null
  const r = Number.isFinite(risk) ? risk : null
  if (c === null && r === null) return ''
  const riskLeads = (r ?? 0.5) >= (c ?? 0.5)
  if (riskLeads) return r === null ? '' : `${['low', 'medium', 'high'][BAND(r)]} risk`
  return c === null ? '' : ['simple', 'moderately complex', 'complex'][BAND(c)]
}

/**
 * Where the effort came from, for the credit's words: `agent`, the agent's own Settings value, which
 * wins over everything; `menu`, the level picked in the model menu; `default`, the Settings default
 * level; `auto`, the decider's Auto (router.js plannedEffort reads them in this order).
 */
export function effortFrom({ asked, settings, family }) {
  if (family && settings?.perAgent?.[family]) return 'agent'
  if (asked && asked !== 'auto') return 'menu'
  if (settings?.default && settings.default !== 'auto') return 'default'
  return 'auto'
}

const EFFORT_FROM_WORDS = Object.freeze({
  agent: 'set for this agent in Settings',
  menu: 'your pick in the model menu',
  default: 'the default in Settings',
  auto: 'Auto in Settings',
})

/**
 * The credit under reply A, a blockquote as a direct answer's `Answered by` is. `by` is who picked,
 * as the agent strip under the reply names the router: `decider` (Jev, or Laya on this PC) when it
 * answered, `local` for the local router or the offline rule, `rules` when the routing rules stood in
 * for a decider that could not pick, `you` for a forced agent. `called` says the decider was asked
 * before the pick, and `reason` why it could not pick: a pick made on this PC says there was no call
 * only when there was none, and otherwise, as the rules' pick does, that the decider could not pick.
 * `ms` is how long the pick took; the profile (`taskType`, `complexity`, `risk`) says what the
 * decider made of the task; `effort` with its `speed` and `from` (effortFrom) says how hard the
 * agent works and why; `movedOff` names the agent your feedback moved the pick off.
 */
export function creditLine({ by, decider = TEACHER, ms, agent, taskType, complexity, risk, effort, speed, from = 'auto', movedOff, reason, called = false }) {
  const who = providerName(decider ?? TEACHER)
  const couldNot = reason ? `, since ${who} could not pick (${reason})` : called ? `, since ${who} could not pick` : ''
  const head = by === 'you' ? `You picked ${agent}`
    : by === 'local' ? `Picked on this PC ${took(ms)}${couldNot || `, no ${who} call`}`
      : by === 'rules' ? `Picked by the routing rules ${took(ms)}${couldNot}`
        : `Picked by ${who}${decider === 'laya' ? ' on this PC' : ''} ${took(ms)}`
  const kind = by === 'you' || by === 'rules' ? '' : [TASK_TYPE_WORDS[taskType] ?? '', driverWords({ complexity, risk })].filter(Boolean).join(', ')
  const tail = !effort ? '' : from === 'auto' && kind ? `, so effort ${effortWord(effort, speed)}` : `; effort ${effortWord(effort, speed)} (${EFFORT_FROM_WORDS[from] ?? EFFORT_FROM_WORDS.auto})`
  return `> ${head}${kind ? `: ${kind}` : ''}${tail}.${movedOff ? ` Your feedback moved it off ${movedOff}.` : ''}`
}

// ---- milestone notices ------------------------------------------------------------------------------
// Engine notice rows: a summary, a collapsed body, no model turn, never rated. Each summary is built
// with noDots, so no notice can be read as a result, and a task gets at most one of each kind per
// routing (tasks.js startedNoticeDue and claimNotice).

/**
 * The started notice, for a task whose reply named no plan: who works on it, with what, and how long
 * it waited first (`waitedMs` for `waitedFor`, 'folder' or 'slot').
 */
export function startedNotice({ jobId, workspace, agent, model, effort, speed, tool, waitedMs, waitedFor }) {
  const where = folderOf(workspace)
  const waited = waitedMs >= 1000 ? ` It waited ${durationWords(waitedMs)} for ${waitedFor === 'slot' ? 'a free slot' : 'the folder'}.` : ''
  const after = ' Watch it on the work board; the result posts here when it\'s done.'
  if (tool) return { summary: noDots(`${jobId} started: the ${tool} tool`), text: `**${jobId}** started: the **${tool}** tool is working on it in ${where}.${waited}${after}` }
  return {
    summary: noDots(`${jobId} started: ${agent}, ${modelWords(model)}${effort ? `, effort ${effortWord(effort, speed)}` : ''}`),
    text: `**${jobId}** started: **${agent}** ${modelAndEffort(model, effort, speed)} is working on it in ${where}.${waited}${after}`,
  }
}

/**
 * The notice for a task a read pass handed back, which started again as work that writes. It says
 * why the pass went back as the hand-back did: `changesFiles` when the work itself changes files
 * (its agent said so, or its routing named work that may), else why it could not run locked, in the
 * router's own words (`why`, tasks.js accessWhy).
 */
export function againNotice({ jobId, agent, model, effort, speed, tool, why, changesFiles }) {
  const cause = changesFiles ? 'needed to change files' : why ? `could not run locked against writing (${why})` : 'was handed back by its read pass'
  return {
    summary: noDots(`${jobId} started again as work that writes`),
    text: `**${jobId}** ${cause}, so it started again as work that writes: ${tool ? `the **${tool}** tool` : `**${agent}** ${modelAndEffort(model, effort, speed)}`}.`,
  }
}

/**
 * The notice for a plan other than the reply said: another agent (`saidAgent`), or the same one at
 * another effort (`saidEffort`). `why` is a hard fact on the routed record that moved the work, such
 * as a limit or your feedback; without one it says only what was picked, since nothing else is known.
 * `by` is who picked, as creditLine has it.
 */
export function changeNotice({ jobId, by, decider = TEACHER, agent, model, effort, speed, saidAgent, saidEffort, why }) {
  const who = providerName(decider ?? TEACHER)
  const otherAgent = saidAgent && saidAgent !== agent
  const summary = otherAgent ? `${jobId}: ${agent} instead of ${saidAgent}` : `${jobId}: effort ${effortWord(effort, speed) || 'its own'} instead of ${saidEffort || 'its own'}`
  const ran = `${agent} ${modelAndEffort(model, effort, speed)}`
  const text = why ? `${upper(why)}, so ${who} gave the work to ${ran}.`
    : by === 'you' ? `It started on ${ran}.`
      : `${who} picked ${ran} when it started.`
  return { summary: noDots(summary), text }
}

/** The notice for a retry on another agent: its summary names the agent, its body the router's own lines. */
export function movedNotice({ jobId, agent, lines = [] }) {
  return { summary: noDots(`${jobId} moved to ${agent}`), text: lines.filter(Boolean).join('\n') || `**${jobId}** moved to **${agent}**.` }
}

// ---- the result's head ------------------------------------------------------------------------------

/**
 * Who works on a task, as the start reply names it: an agent by `names` (id to name) when it is known
 * there, else by its id, and a tool, which the task list keeps as `tool:<id>`, as `the lint tool`.
 */
const workerWords = (agent, names) => names?.[agent] ?? (String(agent).startsWith('tool:') ? `the ${String(agent).slice('tool:'.length)} tool` : agent)

/**
 * The `Agent:` line of a result's head (adapter.js resultSection): who did the work, named as the
 * start reply named it (workerWords), its model, its effort and how long the task ran. A task nobody
 * was picked for says who would have picked.
 */
export function resultAgent(r, names = {}) {
  if (!r?.agent) return `${providerName(r?.decider ?? TEACHER)} picks`
  return [
    workerWords(r.agent, names),
    r.model || '',
    r.effort ? `effort ${r.effort}` : '',
    Number.isFinite(r.durationMs) ? `took ${durationWords(r.durationMs)}` : '',
  ].filter(Boolean).join(' · ')
}

// ---- what a direct answer is told -----------------------------------------------------------------

/**
 * One sentence of what this chat's tasks are doing now, for the chat model answering a question
 * directly, so "how is it going?" gets a true answer: `Right now in this chat: jev-4 is running on
 * Claude Code (6 min, last: running claude (primary)…); jev-5 waits 2nd in line.` Empty when nothing
 * is live. `tasks` are the chat's live tasks as the list shows them (tasks.js view), oldest first.
 */
export function liveStatusSentence(tasks, names = {}) {
  const said = (tasks ?? []).map((t) => {
    if (t.state === 'queued') return `${t.jobId} waits ${t.waiting ? placeText(t.waiting) : 'in line'}`
    const agent = t.agent ? workerWords(t.agent, names) : null
    // A task still starting has an agent only when it was forced (tasks.js enqueue): nobody chooses
    // it, so it is named. Any other gets its agent from its routing, which moves it to running, and a
    // read pass that hands it back clears the one it took (tasks.js applyEvent).
    if (t.state === 'routing') return agent ? `${t.jobId} is starting on ${agent}` : `${t.jobId} is starting, and ${providerName(t.decider ?? TEACHER)} is choosing its agent`
    const doing = t.state === 'verifying' ? 'is having its checks run' : t.state === 'reviewing' ? 'is being reviewed' : `is running${agent ? ` on ${agent}` : ''}`
    const last = t.progressText ? `, last: ${clip(lower(String(t.progressText).trim()), 80)}` : ''
    return `${t.jobId} ${doing} (${durationWords(t.durationMs ?? 0)}${last})`
  })
  return said.length ? `Right now in this chat: ${said.join('; ')}.` : ''
}
