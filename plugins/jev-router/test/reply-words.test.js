// The words the chat shows about a background task before its result (reply-words.js,
// docs/live-agent-view.md Feature 2): the start reply A, B and C, the lines of its wait, its credit
// and its hidden marks, the milestone notices, the result's agent line, and the sentence a direct
// answer is told about what runs now. Golden strings: a change of wording is a change here too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  JOB_MARK, RUN_MARK, againNotice, changeNotice, choosingLine, creditLine, durationWords, effortFrom, endedReply, liveStatusSentence,
  movedNotice, planReply, queuedReply, queuedSentence, readingLine, resultAgent, startedNotice, startingReply, startingSentence, withMarks, workerStep,
} from '../reply-words.js'

// client.js is a classic browser script, run here as a function of `window` (as test/workboard.test.js
// does) for the reader of result notices the browser acknowledges with.
function loadClient() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
}

const WS = 'C:\\work\\kz-harness'
const KEY = '5f8d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f'
const verdict = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
const claude = { jobId: 'jev-4', workspace: WS, agent: 'Claude Code', model: 'claude-opus-4-1', effort: 'high' }
const AFTER = ' I\'ll report back here when it\'s done. Keep chatting.'

test('reply A names the plan: a routed pick with its credit, a forced agent that waits, an unknown model, no effort, a tool, read only, a reviewer, a planner and a local model first', () => {
  assert.equal(planReply({ ...claude, reviewer: { name: 'Codex', model: 'gpt-5.5' } }), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness, and **Codex** reviews it before it's accepted.${AFTER}`)
  assert.equal(planReply({ ...claude, credit: '> Picked by Jev in 2.4 s: a code change, medium risk, so effort high.' }), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness.${AFTER}\n\n> Picked by Jev in 2.4 s: a code change, medium risk, so effort high.`)
  // A forced agent's plan is known at once, and it can still have to wait its turn.
  const waiting = { why: 'workspace', place: 2, ahead: 0, estimate: { lowMs: 240_000, highMs: 240_000 } }
  assert.equal(planReply({ ...claude, waiting, credit: creditLine({ by: 'you', agent: 'Claude Code', effort: 'high', from: 'auto' }) }), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. It waits 2nd in line (another task is running there, about 4 min left).${AFTER}\n\n> You picked Claude Code; effort high (Auto in Settings).`)
  assert.equal(planReply({ ...claude, waiting: { why: 'cap', place: 1, ahead: 0, slot: 1 } }), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. It waits next for a free slot (the resource budget caps how many tasks run at once).${AFTER}`)
  assert.equal(planReply({ ...claude, agent: 'Codex', model: null, effort: 'medium', speed: 'fast' }), `OK, I'll run **Codex** with its own default model (effort medium 1.5x) in the background as **jev-4** in kz-harness.${AFTER}`, 'a model nobody named, and Codex at 1.5x as the task list says it')
  assert.equal(planReply({ ...claude, agent: 'Qwen3 8B (local)', model: 'qwen3-8b', effort: null }), `OK, I'll run **Qwen3 8B (local)** with **qwen3-8b** in the background as **jev-4** in kz-harness.${AFTER}`, 'an agent with no effort family has no effort clause')
  assert.equal(planReply({ ...claude, tool: 'lint' }), `OK, I'll run the **lint** tool on this in the background as **jev-4** in kz-harness.${AFTER}`)
  assert.equal(planReply({ ...claude, agent: 'Qwen3 8B (local)', model: 'qwen3-8b', effort: null, planner: { name: 'Claude Code', model: 'claude-opus-4-1' }, localFirst: true }), `OK, I'll run **Qwen3 8B (local)** with **qwen3-8b** in the background as **jev-4** in kz-harness. **Claude Code** (claude-opus-4-1) writes a plan for it first. If the local model can't finish it, a stronger agent takes over.${AFTER}`)
  const why = 'Laya could not sort this message (timed out after 8 s); treating it as a task.'
  assert.equal(planReply({ ...claude, access: { mode: 'read', verdict }, why }), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. Read only: Jev judged it only reads the project (93%, its bar is 80%), so it runs on an agent locked against writing, beside any task changing kz-harness. ${why}${AFTER}`)
  assert.equal(planReply({ ...claude, access: { mode: 'write', verdict, why: 'no agent here can be locked against writing (codex: Codex cannot be locked through its provider)' } }), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. Read only: Jev judged it only reads the project (93%, its bar is 80%), but no agent here can be locked against writing (codex: Codex cannot be locked through its provider), so it runs as work that writes, and a task changing kz-harness waits for it.${AFTER}`)
})

test('reply B says where a waiting task stands and why, and who picks when it starts; reply C says a started task\'s agent is still being chosen; each promises the pick only while milestones are on', () => {
  const waiting = { why: 'workspace', place: 2, ahead: 0, estimate: { lowMs: 240_000, highMs: 240_000, text: 'Starts in about 4 min, estimated from 5 past runs of claude.' }, facts: '' }
  assert.equal(queuedReply({ jobId: 'jev-5', workspace: WS, waiting }), 'OK, **jev-5** is queued: 2nd in line for kz-harness (another task is running there, about 4 min left). Jev picks the agent when it starts; I\'ll say which here, and report back when it\'s done. Keep chatting.')
  assert.equal(queuedReply({ jobId: 'jev-5', workspace: WS, waiting: { why: 'chat', place: 2, ahead: 0, estimate: null } }), 'OK, **jev-5** is queued: 2nd in line for kz-harness (a run started from the chat is using it). Jev picks the agent when it starts; I\'ll say which here, and report back when it\'s done. Keep chatting.', 'no figure, no time left')
  const cap = { why: 'cap', place: 1, ahead: 0, slot: 1, facts: 'Tasks at once: 2 of 2 in use (2 background tasks).' }
  assert.equal(queuedReply({ jobId: 'jev-5', workspace: WS, waiting: cap, decider: 'laya' }), 'OK, **jev-5** is queued: next for a free slot to start in kz-harness (the resource budget caps how many tasks run at once). Tasks at once: 2 of 2 in use (2 background tasks). Laya picks the agent when it starts; I\'ll say which here, and report back when it\'s done. Keep chatting.')
  assert.equal(queuedReply({ jobId: 'jev-5', workspace: WS, waiting: { why: 'line', place: 3, ahead: 1 }, progress: 'off' }), 'OK, **jev-5** is queued: 3rd in line for kz-harness (an earlier task there is waiting for a free slot). Jev picks the agent when it starts; I\'ll report back here when it\'s done. Keep chatting.', 'with milestones off, no promise to say the pick')
  assert.equal(queuedReply({ jobId: 'jev-5', workspace: WS, waiting: { why: 'workspace', place: 2, ahead: 0 }, access: { mode: 'write', verdict, why: 'no agent here can be locked against writing' } }), 'OK, **jev-5** is queued: 2nd in line for kz-harness (another task is running there). Read only: Jev judged it only reads the project (93%, its bar is 80%), but no agent here can be locked against writing, so it waits for kz-harness like work that writes. Jev picks the agent when it starts; I\'ll say which here, and report back when it\'s done. Keep chatting.')
  assert.equal(queuedSentence({ jobId: 'jev-7', workspace: 'C:\\work\\Harness', waiting: { why: 'workspace', place: 2, ahead: 0 } }), 'OK, **jev-7** is queued: 2nd in line for Harness (another task is running there).', 'B\'s first sentence, which a question that also asks for work ends with')

  assert.equal(startingReply({ jobId: 'jev-4', workspace: WS, waitedMs: 15_000 }), 'OK, **jev-4** is starting in kz-harness, and Jev is still choosing the agent (15 s so far). I\'ll say here which one it picks, and report back when it\'s done. Keep chatting.')
  assert.equal(startingReply({ jobId: 'jev-4', workspace: WS }), 'OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent. I\'ll say here which one it picks, and report back when it\'s done. Keep chatting.', 'a reply that did not wait')
  assert.equal(startingReply({ jobId: 'jev-4', workspace: WS, decider: 'laya', waitedMs: 1500, progress: 'off' }), 'OK, **jev-4** is starting in kz-harness, and Laya is still choosing the agent (1.5 s so far). I\'ll report back here when it\'s done. Keep chatting.')
  assert.equal(startingReply({ jobId: 'jev-4', workspace: WS, access: { mode: 'read', verdict } }), 'OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent. Read only: Jev judged it only reads the project (93%, its bar is 80%), so it runs on an agent locked against writing, beside any task changing kz-harness. I\'ll say here which one it picks, and report back when it\'s done. Keep chatting.')
  assert.equal(startingSentence({ jobId: 'jev-7', workspace: 'C:\\work\\Harness' }), 'OK, **jev-7** is starting in Harness, and Jev is choosing the agent.', 'C\'s first sentence, which a question that also asks for work ends with')
  assert.equal(endedReply({ jobId: 'jev-4', label: 'Failed' }), '**jev-4** ended before Jev picked its agent (Failed). Its result is posted here as its own message.')
})

test('a task judged read only that no agent can lock, waiting only for a free slot, is told in B, and in an A that says where it waits, that it runs as work that writes and a task changing its folder waits for it: nothing holds the folder, so it never waits for it', () => {
  const cap = { why: 'cap', place: 1, ahead: 0, slot: 1 }
  const access = { mode: 'write', verdict, why: 'no agent here can be locked against writing' }
  assert.equal(queuedReply({ jobId: 'jev-5', workspace: WS, waiting: cap, access }), 'OK, **jev-5** is queued: next for a free slot to start in kz-harness (the resource budget caps how many tasks run at once). Read only: Jev judged it only reads the project (93%, its bar is 80%), but no agent here can be locked against writing, so it runs as work that writes, and a task changing kz-harness waits for it. Jev picks the agent when it starts; I\'ll say which here, and report back when it\'s done. Keep chatting.')
  assert.equal(planReply({ ...claude, waiting: cap, access }), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. It waits next for a free slot (the resource budget caps how many tasks run at once). Read only: Jev judged it only reads the project (93%, its bar is 80%), but no agent here can be locked against writing, so it runs as work that writes, and a task changing kz-harness waits for it.${AFTER}`)
})

test('B and C say why a message the decider could not sort runs as a task, after where it stands and before who picks or what they promise', () => {
  const why = 'Laya could not sort this message (timed out after 8 s); treating it as a task.'
  const cap = { why: 'cap', place: 1, ahead: 0, slot: 1, facts: 'Tasks at once: 2 of 2 in use (2 background tasks).' }
  assert.equal(queuedReply({ jobId: 'jev-5', workspace: WS, waiting: cap, decider: 'laya', why }), `OK, **jev-5** is queued: next for a free slot to start in kz-harness (the resource budget caps how many tasks run at once). Tasks at once: 2 of 2 in use (2 background tasks). ${why} Laya picks the agent when it starts; I'll say which here, and report back when it's done. Keep chatting.`)
  assert.equal(startingReply({ jobId: 'jev-4', workspace: WS, decider: 'laya', waitedMs: 15_000, why }), `OK, **jev-4** is starting in kz-harness, and Laya is still choosing the agent (15 s so far). ${why} I'll say here which one it picks, and report back when it's done. Keep chatting.`)
  assert.equal(startingReply({ jobId: 'jev-4', workspace: WS, decider: 'laya', why, progress: 'off' }), `OK, **jev-4** is starting in kz-harness, and Laya is choosing the agent. ${why} I'll report back here when it's done. Keep chatting.`, 'with milestones off too')
})

test('the lines of the wait: the decider reading the message, and the reply choosing, which says what Stop does here', () => {
  assert.equal(readingLine(), 'Jev is reading your message (task or question)…')
  assert.equal(readingLine('laya'), 'Laya is reading your message (task or question)…')
  assert.equal(choosingLine({ jobId: 'jev-4', waitMs: 15_000 }), 'Queued as jev-4. Choosing the agent (I reply once it\'s picked, at most 15 s). Stop here ends this reply only; the task keeps going (stop it on the work board).')
  assert.equal(choosingLine({ jobId: 'jev-4', waitMs: 1500 }), 'Queued as jev-4. Choosing the agent (I reply once it\'s picked, at most 1.5 s). Stop here ends this reply only; the task keeps going (stop it on the work board).')
})

test('every credit: Jev, Laya on this PC, your pick, this PC with no call, the routing rules, where the effort came from, and your feedback moving the pick', () => {
  const profile = { taskType: 'implementation', complexity: 0.4, risk: 0.5, effort: 'high', from: 'auto' }
  assert.equal(creditLine({ by: 'decider', decider: 'jev', ms: 2400, ...profile }), '> Picked by Jev in 2.4 s: a code change, medium risk, so effort high.')
  assert.equal(creditLine({ by: 'decider', decider: 'laya', ms: 1900, ...profile }), '> Picked by Laya on this PC in 1.9 s: a code change, medium risk, so effort high.')
  assert.equal(creditLine({ by: 'you', agent: 'Claude Code', effort: 'high', from: 'auto' }), '> You picked Claude Code; effort high (Auto in Settings).')
  assert.equal(creditLine({ by: 'local', decider: 'jev', ms: 400, ...profile }), '> Picked on this PC in 0.4 s, no Jev call: a code change, medium risk, so effort high.')
  assert.equal(creditLine({ by: 'local', decider: 'laya', ms: 30, effort: null }), '> Picked on this PC in under 0.1 s, no Laya call.', 'a local model takes no effort, and a quick pick is not said to take 0 s')
  assert.equal(creditLine({ by: 'rules', decider: 'jev', ms: 300, reason: 'TYPESAFE_API_KEY not configured', effort: 'high', from: 'auto' }), '> Picked by the routing rules in 0.3 s, since Jev could not pick (TYPESAFE_API_KEY not configured); effort high (Auto in Settings).')
  assert.equal(creditLine({ by: 'decider', decider: 'jev', ms: 2400, ...profile, movedOff: 'Codex' }), '> Picked by Jev in 2.4 s: a code change, medium risk, so effort high. Your feedback moved it off Codex.')
  // Auto reads the larger of complexity and risk, an unknown one as 0.5, and the credit names that one.
  assert.equal(creditLine({ by: 'decider', ms: 2400, taskType: 'refactor', complexity: 0.7, risk: 0.2, effort: 'xhigh', from: 'auto' }), '> Picked by Jev in 2.4 s: a refactor, complex, so effort xhigh.')
  assert.equal(creditLine({ by: 'decider', ms: 2400, taskType: 'debugging', complexity: 0.1, risk: 0.2, effort: 'low', from: 'auto' }), '> Picked by Jev in 2.4 s: a bug to fix, low risk, so effort low.')
  assert.equal(creditLine({ by: 'decider', ms: 2400, taskType: 'implementation', risk: 0.25, effort: 'high', from: 'auto' }), '> Picked by Jev in 2.4 s: a code change, so effort high.', 'an unknown complexity reads 0.5, above that low risk, so neither is said')
  for (const [from, words] of [['menu', 'your pick in the model menu'], ['default', 'the default in Settings'], ['agent', 'set for this agent in Settings']]) {
    assert.equal(creditLine({ by: 'decider', ms: 2400, ...profile, effort: 'xhigh', from }), `> Picked by Jev in 2.4 s: a code change, medium risk; effort xhigh (${words}).`)
  }
  // Where the effort came from, in the order router.js plannedEffort reads it.
  const settings = (over = {}) => ({ default: 'auto', perAgent: {}, ...over })
  assert.equal(effortFrom({ asked: 'high', settings: settings({ perAgent: { claude: 'low' } }), family: 'claude' }), 'agent', 'the agent\'s own value wins over everything')
  assert.equal(effortFrom({ asked: 'high', settings: settings({ default: 'low' }), family: 'claude' }), 'menu')
  assert.equal(effortFrom({ asked: 'auto', settings: settings({ default: 'low' }), family: 'codex' }), 'default', 'Auto in the menu defers to Settings')
  assert.equal(effortFrom({ asked: null, settings: settings(), family: null }), 'auto')
})

test('a pick made on this PC or by the routing rules after the decider was asked says it could not pick, and why when a call failed, never that no call was made', () => {
  const profile = { taskType: 'implementation', complexity: 0.4, risk: 0.5, effort: 'high', from: 'auto' }
  const reason = 'Error: 503 Service Unavailable'
  assert.equal(creditLine({ by: 'local', called: true, decider: 'jev', ms: 400, reason, ...profile }), '> Picked on this PC in 0.4 s, since Jev could not pick (Error: 503 Service Unavailable): a code change, medium risk, so effort high.')
  assert.equal(creditLine({ by: 'local', called: true, decider: 'laya', ms: 400, ...profile }), '> Picked on this PC in 0.4 s, since Laya could not pick: a code change, medium risk, so effort high.', 'answers too flat to use, and no call that failed')
  assert.equal(creditLine({ by: 'rules', called: true, decider: 'jev', ms: 300, reason, effort: 'high', from: 'auto' }), '> Picked by the routing rules in 0.3 s, since Jev could not pick (Error: 503 Service Unavailable); effort high (Auto in Settings).')
  assert.equal(creditLine({ by: 'rules', called: true, decider: 'jev', ms: 300, effort: 'high', from: 'auto' }), '> Picked by the routing rules in 0.3 s, since Jev could not pick; effort high (Auto in Settings).')
  assert.equal(creditLine({ by: 'local', called: false, decider: 'jev', ms: 400, ...profile }), '> Picked on this PC in 0.4 s, no Jev call: a code change, medium risk, so effort high.', 'with no call, as before')
})

test('all four notice kinds: started, started again as work that writes, a change of plan and a move to another agent; no summary holds a `·`, so none is ever read as a result', () => {
  const started = startedNotice({ jobId: 'jev-5', workspace: WS, agent: 'Claude Code', model: 'claude-opus-4-1', effort: 'medium', waitedMs: 6 * 60_000, waitedFor: 'folder' })
  assert.deepEqual(started, {
    summary: 'jev-5 started: Claude Code, claude-opus-4-1, effort medium',
    text: '**jev-5** started: **Claude Code** (claude-opus-4-1, effort medium) is working on it in kz-harness. It waited 6 min for the folder. Watch it on the work board; the result posts here when it\'s done.',
  })
  assert.equal(startedNotice({ jobId: 'jev-5', workspace: WS, agent: 'Codex', model: null, effort: 'high', speed: 'fast', waitedMs: 45_000, waitedFor: 'slot' }).text, '**jev-5** started: **Codex** (its own default model, effort high 1.5x) is working on it in kz-harness. It waited 45 s for a free slot. Watch it on the work board; the result posts here when it\'s done.')
  assert.equal(startedNotice({ jobId: 'jev-5', workspace: WS, agent: 'Big (local)', model: 'big', effort: null, waitedMs: 300 }).text, '**jev-5** started: **Big (local)** (big) is working on it in kz-harness. Watch it on the work board; the result posts here when it\'s done.', 'a start with no wait worth saying')
  const tool = startedNotice({ jobId: 'jev-5', workspace: WS, tool: 'lint' })
  assert.deepEqual(tool, { summary: 'jev-5 started: the lint tool', text: '**jev-5** started: the **lint** tool is working on it in kz-harness. Watch it on the work board; the result posts here when it\'s done.' })
  const again = againNotice({ jobId: 'jev-4', agent: 'Codex', model: 'gpt-5.5', effort: 'medium', why: 'claude said it needs to change files: the parser', changesFiles: true })
  assert.deepEqual(again, { summary: 'jev-4 started again as work that writes', text: '**jev-4** needed to change files, so it started again as work that writes: **Codex** (gpt-5.5, effort medium).' })
  const codex = { jobId: 'jev-4', by: 'decider', decider: 'jev', agent: 'Codex', model: 'gpt-5.5', effort: 'medium', saidAgent: 'Claude Code', saidEffort: 'high' }
  const limit = changeNotice({ ...codex, why: 'Claude Code reached its 5-hour limit (resets 14:20)' })
  assert.deepEqual(limit, { summary: 'jev-4: Codex instead of Claude Code', text: 'Claude Code reached its 5-hour limit (resets 14:20), so Jev gave the work to Codex (gpt-5.5, effort medium).' })
  assert.equal(changeNotice(codex).text, 'Jev picked Codex (gpt-5.5, effort medium) when it started.', 'with no hard fact, only what was picked')
  assert.equal(changeNotice({ ...codex, why: 'your feedback moved the pick off Claude Code' }).text, 'Your feedback moved the pick off Claude Code, so Jev gave the work to Codex (gpt-5.5, effort medium).')
  const effort = changeNotice({ jobId: 'jev-4', by: 'you', agent: 'Claude Code', model: 'claude-opus-4-1', effort: 'xhigh', saidAgent: 'Claude Code', saidEffort: 'high' })
  assert.deepEqual(effort, { summary: 'jev-4: effort xhigh instead of high', text: 'It started on Claude Code (claude-opus-4-1, effort xhigh).' })
  const lines = ['claude hit its usage limit (resets 14:20): handing the task to another agent', 'Running codex (retry)…']
  const moved = movedNotice({ jobId: 'jev-4', agent: 'Codex', lines })
  assert.deepEqual(moved, { summary: 'jev-4 moved to Codex', text: lines.join('\n') })
  // A name that holds the separator loses it in a summary, and keeps it in the body.
  const dotted = startedNotice({ jobId: 'jev-6', workspace: WS, agent: 'Kimi · API', model: 'k2', effort: null })
  assert.equal(dotted.summary, 'jev-6 started: Kimi - API, k2')
  assert.match(dotted.text, /\*\*Kimi · API\*\*/)
  const { resultIdOf, resultOf } = loadClient()
  for (const n of [started, tool, again, limit, effort, moved, dotted]) {
    assert.equal(n.summary.includes('·'), false, n.summary)
    assert.equal(resultIdOf(n.summary), null, `the browser reads no result in "${n.summary}"`)
    assert.equal(resultOf(n.summary), null)
  }
})

test('the notice that a task started again as work that writes says why its read pass went back: that it needed to change files only when the work does, else why it could not run locked, in the router\'s words', () => {
  const codex = { jobId: 'jev-4', agent: 'Codex', model: 'gpt-5.5', effort: 'medium' }
  const after = 'so it started again as work that writes: **Codex** (gpt-5.5, effort medium).'
  for (const why of ['claude said it needs to change files: the parser has to change', 'Jev\'s routing named project_change (71%), which may change files']) {
    assert.equal(againNotice({ ...codex, why, changesFiles: true }).text, `**jev-4** needed to change files, ${after}`, why)
  }
  for (const why of [
    'codex, the agent picked for it, cannot be locked against writing: Codex cannot be locked through its provider',
    'deepseek could not be started locked: its provider takes no per-start tool filter',
    'no other agent that can be locked is left to try',
    'Jev\'s routing named web_research (85%), and no locked agent is known to reach the web',
    'Jev\'s routing could not name what it needs (other), and unsure means it may write',
  ]) assert.equal(againNotice({ ...codex, why }).text, `**jev-4** could not run locked against writing (${why}), ${after}`, 'not that it needed to change files, which nothing said')
  assert.equal(againNotice(codex).text, `**jev-4** was handed back by its read pass, ${after}`, 'with no reason known, only what happened')
  const tool = againNotice({ jobId: 'jev-4', tool: 'lint', why: 'no other agent that can be locked is left to try' })
  assert.deepEqual(tool, { summary: 'jev-4 started again as work that writes', text: '**jev-4** could not run locked against writing (no other agent that can be locked is left to try), so it started again as work that writes: the **lint** tool.' }, 'the summary is the same whatever the cause')
})

test('the result head names the agent, its model, its effort and how long the task ran, and who would pick for a task nobody picked for', () => {
  const r = { agent: 'claude', model: 'claude-opus-4-1', effort: 'high', durationMs: 7 * 60_000 + 12_000 }
  assert.equal(resultAgent(r, { claude: 'Claude Code' }), 'Claude Code · claude-opus-4-1 · effort high · took 7 min')
  assert.equal(resultAgent({ ...r, effort: null, durationMs: 45_000 }, {}), 'claude · claude-opus-4-1 · took 45 s', 'a name it cannot read leaves the id; no effort, no clause')
  assert.equal(resultAgent({ ...r, model: null, durationMs: null }, { claude: 'Claude Code' }), 'Claude Code · effort high')
  assert.equal(resultAgent({ agent: null, decider: 'laya' }), 'Laya picks')
  assert.equal(resultAgent({ agent: null }), 'Jev picks')
  assert.deepEqual([durationWords(0), durationWords(59_400), durationWords(90_000), durationWords(65 * 60_000), durationWords(120 * 60_000)], ['0 s', '59 s', '2 min', '1 h 5 min', '2 h'])
})

test('the sentence a direct answer is told names every live task of the chat, what it runs on, how long and its last line, and where a waiting one stands', () => {
  const live = [
    { jobId: 'jev-4', state: 'running', agent: 'claude', durationMs: 6 * 60_000, progressText: 'Running npm test' },
    { jobId: 'jev-5', state: 'queued', waiting: { why: 'workspace', place: 2, ahead: 0 } },
  ]
  assert.equal(liveStatusSentence(live, { claude: 'Claude Code' }), 'Right now in this chat: jev-4 is running on Claude Code (6 min, last: running npm test); jev-5 waits 2nd in line.')
  assert.equal(liveStatusSentence([
    { jobId: 'jev-6', state: 'routing', decider: 'laya' },
    { jobId: 'jev-7', state: 'reviewing', agent: 'codex', durationMs: 90_000, progressText: 'Review: accept.' },
    { jobId: 'jev-8', state: 'queued', waiting: { why: 'cap', place: 1, ahead: 0, slot: 2 } },
  ], {}), 'Right now in this chat: jev-6 is starting, and Laya is choosing its agent; jev-7 is being reviewed (2 min, last: review: accept.); jev-8 waits 2nd for a free slot.')
  assert.equal(liveStatusSentence([], {}), '', 'nothing live, nothing said')
})

test('a task still starting on an agent it was forced to is said to start on that agent, since nobody is choosing it', () => {
  // A forced agent is on the task's record from the moment it is queued (tasks.js enqueue); any other
  // task gets its agent only from its routing, which moves it to running.
  assert.equal(liveStatusSentence([{ jobId: 'jev-6', state: 'routing', decider: 'laya', agent: 'claude' }], { claude: 'Claude Code' }), 'Right now in this chat: jev-6 is starting on Claude Code.')
  assert.equal(liveStatusSentence([{ jobId: 'jev-6', state: 'routing', decider: 'jev', agent: 'big-local' }], {}), 'Right now in this chat: jev-6 is starting on big-local.', 'a name it cannot read leaves the id')
  assert.equal(liveStatusSentence([{ jobId: 'jev-6', state: 'routing', decider: 'laya', agent: null }], { claude: 'Claude Code' }), 'Right now in this chat: jev-6 is starting, and Laya is choosing its agent.', 'one with no agent yet is still being chosen')
})

test('a tool that does the work is named as the start reply names it, in the result\'s head and in what a direct answer is told, never by the id the task list keeps', () => {
  // The task list keeps a tool as `tool:<id>` (tasks.js applyEvent); no agent name covers it.
  const names = { claude: 'Claude Code' }
  assert.equal(resultAgent({ agent: 'tool:lint', model: null, effort: null, durationMs: 3000 }, names), 'the lint tool · took 3 s', 'as reply A says `the **lint** tool`')
  assert.equal(liveStatusSentence([{ jobId: 'jev-7', state: 'running', agent: 'tool:lint', durationMs: 3000 }], names), 'Right now in this chat: jev-7 is running on the lint tool (3 s).')
  assert.equal(resultAgent({ agent: 'claude', model: null, effort: 'high', durationMs: 3000 }, names), 'Claude Code · effort high · took 3 s', 'an agent is named as before')
})

test('a start reply\'s hidden marks: the task by its key, the run once one has begun, and the agent strip\'s chain with the worker by its id', () => {
  const steps = [{ agent: 'Jev', model: '', roles: [] }, workerStep({ agent: 'claude', model: 'claude-opus-4-1', effort: 'high', speed: null })]
  assert.deepEqual(steps[1], { agent: 'claude', model: 'claude-opus-4-1, high', roles: ['work'] })
  assert.deepEqual(workerStep({ agent: 'codex', model: 'gpt-5.5', effort: 'xhigh', speed: 'fast' }), { agent: 'codex', model: 'gpt-5.5, xhigh 1.5x', roles: ['work'] })
  assert.deepEqual(workerStep({ tool: 'lint' }), { agent: 'lint', model: '', roles: ['tool'] })
  const text = withMarks('OK, I\'ll run it.', { key: KEY, runId: 'run-4', steps })
  const [said, ...marks] = text.split('\n\n')
  assert.equal(said, 'OK, I\'ll run it.')
  assert.deepEqual(marks.map((m) => m.split(':')[0]), ['[jev-job]', '[jev-run]', '[jev-agents]'], 'each after a blank line, as definitions must be')
  assert.equal(JOB_MARK.exec(text)?.[1], KEY)
  assert.equal(RUN_MARK.exec(text)?.[1], 'run-4')
  assert.deepEqual(JSON.parse(Buffer.from(/\[jev-agents\]: kzh-agents-1-(\S+)/.exec(text)[1], 'base64url').toString()), steps)
  assert.equal(withMarks('B.', { key: KEY }), `B.\n\n[jev-job]: kzh-job-1-${KEY}`, 'a waiting task has no run or agents yet')
  assert.equal(withMarks('x', { key: 'not a key!' }), 'x', 'nothing that is no key')
})

test('a direct answer\'s hidden mark names the intent sample its message was recorded as, and nothing that is no id', async () => {
  const words = await import('../reply-words.js')
  assert.equal(typeof words.intentMark, 'function', 'reply-words.js writes the intent mark')
  const id = '9b2f4c1e-7a6d-4e3b-9c8a-1f2e3d4c5b6a'
  assert.equal(words.intentMark(id), `[jev-intent]: kzh-intent-1-${id}`)
  const text = `An answer.\n\n> Answered by: x/y, directly: a question, no agents or project work\n\n${words.intentMark(id)}`
  assert.equal(words.INTENT_MARK.exec(text)?.[1], id, 'read back as the other marks are')
  assert.deepEqual([words.intentMark('not an id!'), words.intentMark(null)], ['', ''], 'and no mark for what is no sample id')
})
