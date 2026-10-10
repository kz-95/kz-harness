// Every sentence the chat shows about a background task before its result lands: the start reply
// (A when the plan is known or, once the predictor has earned it, predicted, B when the task waits
// its turn, C when the pick takes longer than the reply waits), the lines of that wait, the credit
// under the reply, its hidden marks, the milestone notices, the agent line of the result's head,
// and what a direct answer is told is running now (docs/live-agent-view.md, Features 2 and 3).
// What they quote comes from where it arises: the router's own lines (adapter.js line()), which
// fill the wait's block and a moved notice's body, and the reasons a task runs as work that writes
// or as a task at all.
//
// Facts in, words out, and nothing else: no model writes any of this, so the chat can only ever say
// what the router really picked. Names come in already resolved (adapter.js nameOfAgent), so this
// module needs no agent list of its own.
import { speedWord } from './effort.js'
import { TEACHER, providerName } from './providers.js'
import { heldWords, nowHeldWords } from './steer.js'
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

/** The effort as the task list shows it (router.js attempt_start): Codex at 1.5x speed and Claude Code in fast mode say so. */
export const effortWord = (effort, speed) => (effort ? `${effort}${speedWord(speed)}` : '')

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
 * the chat replies setting: with milestones off the reply promises only the result. `likely` is the
 * predicted pick, `{ agent, effort, speed }` with the agent by name, once the predictor has earned
 * saying it (reply-ledger.js earnedGuess): the pick is still made when the task starts.
 */
export function queuedReply({ jobId, workspace, waiting, decider = TEACHER, access, why, progress = 'milestones', likely = null }) {
  const where = folderOf(workspace)
  const facts = waiting?.facts ? ` ${waiting.facts}` : ''
  const guess = likely?.agent ? `, likely **${likely.agent}**${likely.effort ? ` (effort ${effortWord(likely.effort, likely.speed)})` : ''}` : ''
  return `${queuedSentence({ jobId, workspace, waiting })}${facts}${accessSentence(access, where, waiting?.why !== 'cap')}${why ? ` ${why}` : ''} ${providerName(decider ?? TEACHER)} picks the agent when it starts${guess}; ${promise(progress !== 'off', 'I\'ll say which here, and report back when it\'s done')}. Keep chatting.`
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
 * agent works and why, and `nudged` (router.js plannedEffort) that your ratings moved Auto a step,
 * so the profile is not said to give an effort it did not; `movedOff` names the agent your
 * feedback moved the pick off.
 */
export function creditLine({ by, decider = TEACHER, ms, agent, taskType, complexity, risk, effort, speed, from = 'auto', nudged = null, movedOff, reason, called = false }) {
  const who = providerName(decider ?? TEACHER)
  const couldNot = reason ? `, since ${who} could not pick (${reason})` : called ? `, since ${who} could not pick` : ''
  const head = by === 'you' ? `You picked ${agent}`
    : by === 'local' ? `Picked on this PC ${took(ms)}${couldNot || `, no ${who} call`}`
      : by === 'rules' ? `Picked by the routing rules ${took(ms)}${couldNot}`
        : `Picked by ${who}${decider === 'laya' ? ' on this PC' : ''} ${took(ms)}`
  const kind = by === 'you' || by === 'rules' ? '' : [TASK_TYPE_WORDS[taskType] ?? '', driverWords({ complexity, risk })].filter(Boolean).join(', ')
  // An Auto effort your ratings moved a step names them as its cause: the profile gave the step before it.
  const tail = !effort ? ''
    : from === 'auto' && nudged ? `; effort ${effortWord(effort, speed)} (Auto, ${nudgedWay(nudged)} one step by ${nudged.why ?? 'your ratings'})`
      : from === 'auto' && kind ? `, so effort ${effortWord(effort, speed)}` : `; effort ${effortWord(effort, speed)} (${EFFORT_FROM_WORDS[from] ?? EFFORT_FROM_WORDS.auto})`
  return `> ${head}${kind ? `: ${kind}` : ''}${tail}.${movedOff ? ` Your feedback moved it off ${movedOff}.` : ''}`
}

/**
 * The credit under a quick reply, which names the predicted pick before routing makes it
 * (docs/live-agent-view.md Feature 3): the predictor's record that earned it, right `right` of the
 * last `of`, and which decider read the message and how long that took (`read`, `{ by, ms }`), or
 * null when no decider's answer came, as offline, where a word rule on this PC reads it. Routing
 * still picks, and a pick it makes otherwise is said in a notice of its own, the one Start and result
 * only posts too (tasks.js guessMissed).
 */
export function quickCredit({ right, of, read = null }) {
  const reader = read ? `; ${providerName(read.by ?? TEACHER)} read the message${read.by === 'laya' ? ' on this PC' : ''} ${took(read.ms)}` : ''
  return `> Predicted on this PC from your recent tasks (right ${right} of the last ${of})${reader}. The pick is checked again when it starts.`
}

/**
 * The credit under an instant reply: a quick reply to a message the local classifier was sure is a
 * task (intent.js), so no Jev call came before it.
 */
export const instantCredit = ({ right, of }) => `> Instant reply: read and predicted on this PC, no Jev call (right ${right} of the last ${of}). The pick is checked again when it starts.`

// ---- milestone notices ------------------------------------------------------------------------------
// Engine notice rows: a summary, a collapsed body, no model turn, never rated. Each summary is built
// with noDots, so no notice can be read as a result, and a task gets at most one of each kind per
// routing (tasks.js startedNoticeDue and claimNotice).

/**
 * The started notice, for a task whose reply named no plan: who works on it, with what, and how long
 * it waited first (`waitedMs` for `waitedFor`, 'folder' or 'slot'), and where to watch it work.
 */
export function startedNotice({ jobId, workspace, agent, model, effort, speed, tool, waitedMs, waitedFor }) {
  const where = folderOf(workspace)
  const waited = waitedMs >= 1000 ? ` It waited ${durationWords(waitedMs)} for ${waitedFor === 'slot' ? 'a free slot' : 'the folder'}.` : ''
  const after = ' Watch it in the Live tab; the result posts here when it\'s done.'
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

/** A time of day as the chat says it, `14:20` on this PC's clock; '' for none. */
const clockOf = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

/**
 * Why routing gave the work to another agent than a reply named, as a change-of-plan notice says it
 * (changeNotice `why`), from a hard fact on the routed record about the agent the reply named
 * (`agent`, by name): `limit`, at its usage limit, which resets at `until` when that is known;
 * `signed-out`; `not-ready`, a model on this PC that cannot run; `gate`, past its weekly gate; and
 * `feedback`, your feedback moved the pick off it. Null for anything else, which no fact explains.
 */
export function changeReason({ kind, agent, until = null }) {
  if (kind === 'limit') { const at = until ? clockOf(until) : ''; return `${agent} is at its usage limit${at ? ` (resets ${at})` : ''}` }
  if (kind === 'signed-out') return `${agent} is not signed in`
  if (kind === 'not-ready') return `${agent} is not ready on this PC`
  if (kind === 'gate') return `${agent} is past its weekly gate`
  if (kind === 'feedback') return `your feedback moved the pick off ${agent}`
  return null
}

/**
 * The notice for a plan other than the reply said: another agent (`saidAgent`), a tool (`tool`, which
 * a reply naming a guessed pick never names), or the same agent at another effort (`saidEffort`).
 * `why` is a hard fact on the routed record that moved the work, such as a limit or your feedback
 * (changeReason); without one it says only what was picked, since nothing else is known. `by` is who
 * picked, as creditLine has it: the decider, the local router or the routing rules, or you.
 */
export function changeNotice({ jobId, by, decider = TEACHER, agent, model, effort, speed, tool, saidAgent, saidEffort, why }) {
  const who = by === 'local' ? 'the local router' : by === 'rules' ? 'the routing rules' : providerName(decider ?? TEACHER)
  const worker = tool ? `the ${tool} tool` : agent
  const otherAgent = !!tool || (saidAgent && saidAgent !== agent)
  const summary = otherAgent ? `${jobId}: ${worker} instead of ${saidAgent}` : `${jobId}: effort ${effortWord(effort, speed) || 'its own'} instead of ${saidEffort || 'its own'}`
  const ran = tool ? worker : `${agent} ${modelAndEffort(model, effort, speed)}`
  const text = why ? `${upper(why)}, so ${who} gave the work to ${ran}.`
    : by === 'you' ? `It started on ${ran}.`
      : `${upper(who)} picked ${ran} when it started.`
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

// ---- what a rating changed -------------------------------------------------------------------------
// The words a Like or Dislike is answered with once it is saved, under a start reply or a direct
// answer (docs/live-agent-view.md Feature 4), and what Settings, Effort and the router's own lines
// say of the effort your ratings move. index.js works out what changed; this only words it.

/** A task type's work, in the words your ratings' effort is said of: `for debugging`, `on doc edits`. */
const WORK_WORDS = Object.freeze({
  architecture: 'design questions',
  implementation: 'code changes',
  debugging: 'debugging',
  review: 'reviews',
  refactor: 'refactors',
  testing: 'test work',
  documentation: 'doc edits',
  investigation: 'investigations',
  security: 'security work',
  performance: 'performance work',
  simple_change: 'small changes',
  other: 'other work',
})
export const workWords = (taskType) => WORK_WORDS[taskType] ?? String(taskType ?? 'this work').replace(/_/g, ' ')

/** Whose effort ladder a rating moves (effort.js effortFamily), as Settings, Effort names it. */
const FAMILY_WORDS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', deepseek: 'DeepSeek' })
export const familyWords = (family) => FAMILY_WORDS[family] ?? String(family ?? '')

// One clause, two joined by `and`, more by semicolons with `and` before the last.
const clauses = (list) => (list.length <= 2 ? list.join(', and ') : `${list.slice(0, -1).join('; ')}; and ${list.at(-1)}`)

/**
 * The line a saved verdict is answered with. `suggested` names the agent the session's next task goes
 * to; `pick` is `labelled` or `confirmed` when the run's pick was labelled, `misread` when its task
 * type was marked wrong, each in Jev's store or Laya's (`store`); `intent` is the label the message's
 * example was given, with how many checked examples the task-or-question classifier has; `effort` is
 * how far `wrong effort` ratings of one agent family on one task type have come (`agree` of `need`
 * the same `way`, and whether Auto now runs a rung off, `moved`, or would, `off`); `pending` the job
 * id of a run whose labels wait for it to end (empty for one with no id); `unran` true when those
 * labels have no run to wait for, since its task ended with none on record (stopped while it waited,
 * failed before its routing was saved, or stopped by a restart); `learning` false while learning is off.
 */
export function learnedLine({ suggested = null, pick = null, misread = false, store = 'jev', intent = null, effort = null, pending = null, unran = false, learning = true } = {}) {
  const laya = store === 'laya'
  const said = []
  if (suggested) said.push(`the next task in this chat goes to ${suggested} unless you pick one`)
  if (pick === 'labelled') said.push(`this run's pick is labelled for ${laya ? 'Laya\'s record' : 'the local router'}`)
  if (misread) said.push(`this run's task type is marked wrong for ${laya ? 'Laya\'s record' : 'the local classifier'}`)
  if (pick === 'confirmed') said.push(`this run's pick is confirmed for ${laya ? 'Laya\'s record' : 'the local router'}`)
  if (intent) said.push(`marked as a ${intent.label} for the task-or-question classifier (it has ${intent.checked} checked examples)`)
  if (effort && !effort.off) {
    const up = effort.way > 0
    const what = `${familyWords(effort.family)} on ${workWords(effort.taskType)}`
    said.push(effort.moved
      ? `Auto effort for ${what} now runs one step ${up ? 'higher' : 'lower'} (Settings, Effort to reset)`
      : `${effort.agree} of ${effort.need} "effort too ${up ? 'low' : 'high'}" ratings for ${what}; at ${effort.need}, Auto effort there ${up ? 'rises' : 'drops'} one step`)
  }
  const off = effort?.off ? ' Auto effort does not follow your ratings now (Settings, Effort).' : ''
  if (pending !== null) {
    const when = `when ${pending || 'its task'} ends`
    return said.length ? `Learned: ${clauses(said)}. The rest is applied ${when}.${off}` : `Saved. It is applied ${when}.${off}`
  }
  if (unran) return said.length ? `Learned: ${clauses(said)}. The task ended with no run on record to apply the rest to.${off}` : `Saved. The task ended with no run on record to apply it to.${off}`
  if (said.length) return `Learned: ${clauses(said)}.${off}`
  return `Saved.${learning ? '' : ' Learning is off, so nothing is learned from it.'}${off}`
}

/** What Settings, Effort says your ratings changed for one agent family and task type (effort.js effortBiases). */
export const ratedEffortLine = ({ family, taskType, shift, agree, n }) => `Learned from your ratings: ${familyWords(family)} Auto effort one step ${shift > 0 ? 'higher' : 'lower'} for ${workWords(taskType)} (${agree} of your last ${n} "wrong effort" ratings).`

// The rungs Auto runs on, weakest first (effort.js unifiedLevel).
const AUTO_RUNGS = ['low', 'medium', 'high', 'xhigh']
// Which way your ratings moved Auto (router.js plannedEffort `nudged`).
const nudgedWay = (nudged) => (AUTO_RUNGS.indexOf(nudged.to) > AUTO_RUNGS.indexOf(nudged.from) ? 'raised' : 'lowered')
/** What the router's line says of an Auto effort your ratings moved (router.js plannedEffort `nudged`). */
export const nudgedWords = (nudged, taskType) => `effort ${nudgedWay(nudged)} one step for ${workWords(taskType)}: ${nudged.why ?? 'your ratings'}`

// ---- Send now and Steer ----------------------------------------------------------------------------
// What the chat and the task routes answer when the person starts a waiting task at once or steers one
// (docs/live-agent-view.md Feature 5): `/now jev-5`, `/steer jev-5 <text>`, `@jev-5 <text>`, and the
// buttons, whose dialogs client.js words. tasks.js and index.js decide what happened; this only words
// it. Words for a task at work go to its agent where it takes them mid-run, and otherwise wait for its
// next attempt (steer.js).

/**
 * What became of words for the task `jobId`, by what tasks.js or index.js answered (`result`) and how
 * they were sent (`via`: '@' for `@jev-5 <text>`, 'steer' for `/steer` and the routes). `decider` and
 * `agent` say who takes the words into account once it starts: the decider picking its agent, or the
 * agent it was sent to. For a task at work, `agent` is the agent at work, and `why` why the words wait
 * for its next attempt rather than reach it now (steer.js heldWords), or for Send now ('replaced',
 * 'not-now') why it has nothing it can stop (steer.js nowHeldWords). `path` 'claude' says Claude
 * Code's input channel took them.
 */
export function steerWords({ jobId, result, via = 'steer', decider = TEACHER, agent = null, names = {}, why = null, path = null }) {
  if (result === 'added') {
    if (via === '@') return `${jobId} hasn't started, so I added this to its task.`
    const who = agent ? `${workerWords(agent, names)} gets it with the task` : `${providerName(decider ?? TEACHER)} chooses the agent with it`
    return `Added to ${jobId} before it starts. ${upper(who)}.`
  }
  if (result === 'started') return `${jobId} started while you were typing, so your words were not added. Steer it again: they now go to the running agent.`
  if (result === 'sent') return path === 'claude'
    ? `Sent to ${jobId}: ${agent ? workerWords(agent, names) : 'Claude Code'} takes it in between tool calls; if it finishes first you'll be told it wasn't used.`
    : `Sent to ${jobId}: ${agent ? workerWords(agent, names) : 'its agent'} takes it in at its next step.`
  if (result === 'replaced') return `Sent to ${jobId} now: ${agent ? workerWords(agent, names) : 'its agent'} stops what it is doing and starts on your words.`
  if (result === 'not-now') return nowHeldWords({ jobId, why, name: agent ? workerWords(agent, names) : null })
  if (result === 'pending') return heldWords({ jobId, why, name: agent ? workerWords(agent, names) : null })
  if (result === 'already-finished') return via === '@' ? `${jobId} already finished. Send it without @${jobId} to start a new task.` : `${jobId} already finished. Send your words as a new message to start a new task.`
  if (result === 'not-started') return `${jobId} hasn't started: Steer adds your words to it before it starts.`
  if (result === 'no-owner') return `${jobId} is from before the app restarted, so nothing can be queued for it from here. Send your words as a new message to start a new task.`
  if (result === 'unavailable') return 'Background tasks are not available in this chat, so nothing was queued.'
  return ''
}

/** A task queued from Steer for the task `jobId`: as a follow-up, or as a fresh start of it ('restarting'). */
export function steeredTaskWords({ jobId, newJobId, result, workspace, agent = null, names = {}, waiting = null }) {
  const on = agent ? `, on ${workerWords(agent, names)}` : ''
  const where = waiting ? `first in line in ${folderOf(workspace)}` : `in ${folderOf(workspace)}, starting now`
  return result === 'restarting'
    ? `Stopping ${jobId}. ${newJobId} starts again with your message, ${where}${on}.`
    : `Queued ${newJobId} as a follow-up to ${jobId}, ${where}${on}.`
}

/** The reason a task stopped to start again with the person's words says first in its result. */
export const restartedReason = (newJobId) => `Stopped to start again as ${newJobId} with your guidance.`

/** The fresh start of a task that was stopped to start again with the person's words. */
export const restartTask = ({ task, jobId, text }) => `${task}\n\nThe earlier attempt (${jobId}) was stopped; its changes are in the working tree. Also: ${text}`

/** A follow-up task, queued to run after the task `jobId` with the person's words. */
export const followUpTask = ({ jobId, text }) => `Follow-up to ${jobId}: ${text}`

/**
 * What Send now came to for the task `jobId`, by what tasks.js startNow answered. `holder` is the
 * task that holds its folder; `over` says it started over the cap on tasks at once, `max`.
 */
export function startNowWords({ jobId, result, workspace, holder = null, over = false, max = null }) {
  const folder = folderOf(workspace)
  const stays = 'It stays in line; Run next puts it first.'
  if (result === 'started') return over && max != null ? `${jobId} started, over your limit of ${max} task${max === 1 ? '' : 's'} at once: the next task to end frees no slot.` : `${jobId} started.`
  if (result === 'workspace-busy') return `${jobId} could not start now: ${holder ?? 'another task'} is changing ${folder}, and two tasks never write one folder at once. ${stays}`
  if (result === 'chat-busy') return `${jobId} could not start now: a run started from the chat is using ${folder}. ${stays}`
  if (result === 'stopping') return `Stopping ${holder}; ${jobId} starts as soon as it has stopped.`
  if (result === 'not-waiting') return `${jobId} has already started.`
  if (result === 'already-finished') return `${jobId} already finished.`
  return ''
}

/** No task of that id in this chat, for `/now`, `/steer` and `@jev-5`. */
export const noTaskWords = (jobId) => `There is no ${jobId} in this chat, so nothing was sent.`
