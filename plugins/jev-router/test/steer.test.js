// Steer on a running task (steer.js, docs/live-agent-view.md Feature 5, slice 8): which agent at work
// takes the person's words now and how, what becomes of each piece of guidance, and the words for
// each state and provider; and Send now into a running agent (slice 10). Golden strings: a change of
// wording is a change here too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STEER_PREFIX, createSteerers, guidanceLine, guidanceLines, heardInEvents, heardInTap, heldWords, idleWhy, livePath, liveWords, nextState,
  reachedWork, sendLive, sendableWhy, steerLine, steerStateWords, steerableRole,
} from '../steer.js'
// What slice 10 adds (Send now into a running agent), read through the namespace so this file still
// loads on the code before it, where each of its tests fails on what is missing.
import * as S from '../steer.js'

/** An attempt at work as runAgent registers it: a spawn child with its inbox, or a connector's control. */
const spawnEntry = (steer = () => {}) => ({ attempt: 0, role: 'primary', agentId: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', sub: { localAgent: { steer } }, control: null })
const codexEntry = (steer) => ({ attempt: 0, role: 'primary', agentId: 'codex', name: 'Codex', provider: 'codex', sub: {}, control: steer ? { steer } : {} })
const claudeEntry = (control = { steer: () => { throw new Error('never called') } }) => ({ attempt: 0, role: 'retry', agentId: 'claude', name: 'Claude Code', provider: 'claude-code', sub: {}, control })
/** A Claude Code run started with its input channel, as runAgent starts one while Settings' switch is on: the engine patch fills its hooks. */
const channelEntry = (hooks = {}) => claudeEntry({ channel: true, steer: async () => {}, sendNow: async () => {}, ...hooks })

test('the delivery choice: a spawn child takes words through its inbox, a patched Codex through turn/steer, Claude Code with the switch off and a tool take none, and nothing at work waits', () => {
  assert.deepEqual(livePath(spawnEntry()), { path: 'spawn', why: null })
  assert.deepEqual(livePath(codexEntry(async () => {})), { path: 'codex', why: null })
  assert.deepEqual(livePath(codexEntry(null)), { path: null, why: 'unpatched' }, 'a Codex connector without the engine patch has no control to steer with')
  assert.deepEqual(livePath(claudeEntry()), { path: null, why: 'claude-off' })
  assert.deepEqual(livePath(claudeEntry(), { claudeSteer: true }), { path: null, why: 'claude' }, 'a Claude Code run started without the input channel takes no words, whatever Settings say now')
  assert.deepEqual(livePath(channelEntry(), { claudeSteer: true }), { path: 'claude', why: null }, 'one started with it takes them through it')
  assert.deepEqual(livePath(channelEntry()), { path: null, why: 'claude-off' }, 'and none once the switch is off again')
  assert.deepEqual(livePath(claudeEntry(null), { claudeSteer: true }), { path: null, why: 'unpatched' }, 'a Claude Code connector without the engine patch has no control')
  assert.deepEqual(livePath({ ...claudeEntry(), provider: 'claude-code-readonly' }), { path: null, why: 'claude-off' }, 'its read-only row is Claude Code too')
  assert.deepEqual(livePath({ attempt: 0, role: 'tool', agentId: 'tool:lint', provider: 'tool' }), { path: null, why: 'tool' })
  assert.deepEqual(livePath({ ...spawnEntry(), sub: {} }), { path: null, why: 'none' }, 'a spawn run with no in-process agent has no inbox')
  assert.deepEqual(livePath(null), { path: null, why: 'idle' })
  assert.deepEqual(['checking', 'checks', 'reviewing', 'ending', 'done', 'between', 'starting', 'choosing'].map(idleWhy), ['checks', 'checks', 'review', 'ending', 'ending', 'between', 'between', 'between'])
  assert.deepEqual(['primary', 'retry', 'plan', 'review', 'opinion', 'tool'].map(steerableRole), [true, true, true, false, false, false])
  // The dialog sends while an agent takes words, or while none is at work; never past one that cannot take them.
  assert.deepEqual([sendableWhy('spawn', null), sendableWhy(null, 'checks'), sendableWhy(null, 'between'), sendableWhy(null, 'claude-off'), sendableWhy(null, 'unpatched'), sendableWhy(null, 'tool')], [true, true, true, false, false, false])
})

test('with no agent that takes words at work, the attempt the run has at work says why they wait: a configured tool takes none, so the dialog cannot send them, and an agent\'s review sends them with the next attempt', () => {
  const tool = { index: 2, role: 'tool', agent: 'tool:lint', name: 'the lint tool', detail: 'tool' }
  const review = { index: 1, role: 'review', agent: 'deepseek', name: 'DeepSeek agent', detail: 'live' }
  assert.equal(idleWhy('attempt', tool), 'tool')
  assert.equal(idleWhy('attempt', { index: 0, role: 'primary', agent: 'tool:lint', detail: null }), 'tool', 'a tool picked as the work')
  assert.equal(idleWhy('attempt', review), 'review')
  assert.equal(idleWhy('attempt', { index: 0, role: 'primary', agent: 'deepseek', name: 'DeepSeek agent', detail: null }), 'between', 'a work attempt whose agent has not started yet')
  assert.equal(idleWhy('attempt', null), 'between')
  assert.deepEqual([sendableWhy(null, idleWhy('attempt', tool)), sendableWhy(null, idleWhy('attempt', review))], [false, true])
  assert.equal(heldWords({ jobId: 'jev-4', why: idleWhy('attempt', review), name: review.name }), 'jev-4\'s work is being reviewed right now, so this goes with its next attempt, if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: idleWhy('attempt', tool), name: tool.name }), 'The lint tool can\'t take messages mid-run. It goes to the next attempt if there is one.')
})

test('the registry keeps one attempt per run, and an attempt that ends lets only itself go', () => {
  const steerers = createSteerers()
  const first = spawnEntry()
  const second = codexEntry(async () => {})
  const offFirst = steerers.add('run-1', first)
  assert.equal(steerers.of('run-1'), first)
  const offSecond = steerers.add('run-1', second)
  offFirst()
  assert.equal(steerers.of('run-1'), second, 'the retry at work stays')
  offSecond()
  assert.equal(steerers.of('run-1'), null)
  assert.equal(steerers.size, 0)
  assert.equal(typeof steerers.add('', first), 'function', 'no run, nothing kept')
  assert.equal(steerers.size, 0)
})

test('the words go to a spawn child\'s inbox as the person\'s, prefixed and under the steer\'s id; Codex takes them with that id as its client id, and a refusal says why', async () => {
  const inbox = []
  assert.deepEqual(await sendLive(spawnEntry((m) => inbox.push(m)), 'spawn', { id: 'g1', text: 'use tabs' }), { sent: true })
  assert.deepEqual(inbox, [{ id: 'g1', role: 'user', content: [{ type: 'text', text: `${STEER_PREFIX}use tabs` }], source: { kind: 'user' } }])
  assert.equal(STEER_PREFIX, '(Added by the person while you work on this task.) ')
  const turns = []
  assert.deepEqual(await sendLive(codexEntry(async (text, clientId) => { turns.push([text, clientId]); return { turnId: 't1' } }), 'codex', { id: 'g2', text: 'run the linter' }), { sent: true })
  assert.deepEqual(turns, [[`${STEER_PREFIX}run the linter`, 'g2']])
  const refused = await sendLive(codexEntry(async () => { throw Object.assign(new Error('no turn is running'), { code: 'kzh-no-turn' }) }), 'codex', { id: 'g3', text: 'x' })
  assert.deepEqual(refused, { sent: false, why: 'kzh-no-turn' })
  assert.deepEqual(await sendLive(spawnEntry(() => { throw new Error('the agent is gone') }), 'spawn', { id: 'g4', text: 'x' }), { sent: false, why: 'the agent is gone' })
  // A turn/steer with no answer within the bound is taken as sent: what the agent reads says the rest.
  assert.deepEqual(await sendLive(codexEntry(() => new Promise(() => {})), 'codex', { id: 'g5', text: 'x', acceptMs: 10 }), { sent: true })
  assert.deepEqual(await sendLive(claudeEntry(), null, { id: 'g6', text: 'x' }), { sent: false, why: 'none' })
})

test('what an agent took in is read from a spawn child\'s committed user messages and from a Codex userMessage item\'s client id', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { id: 'prompt-1', role: 'user', content: [] } },
    { seq: 1, type: 'assistant/message', data: { message: { id: 'm1' } } },
    { seq: 2, type: 'user/message', data: { id: 'g1', role: 'user', content: [] } },
    { seq: 3, type: 'user/message', data: {} },
  ]
  assert.deepEqual(heardInEvents(events), ['prompt-1', 'g1'])
  assert.deepEqual(heardInEvents(null), [])
  const item = (method, x) => ({ provider: 'codex', method, params: { item: x } })
  assert.equal(heardInTap(item('item/completed', { type: 'userMessage', id: 'u1', clientId: 'g2', content: [] })), 'g2')
  assert.equal(heardInTap(item('item/started', { type: 'userMessage', id: 'u1', clientId: 'g2' })), null, 'only once the item is finished')
  assert.equal(heardInTap(item('item/completed', { type: 'userMessage', id: 'u1' })), null, 'a message the turn began with has no client id')
  assert.equal(heardInTap(item('item/completed', { type: 'agentMessage', clientId: 'g2' })), null)
  assert.equal(heardInTap({ provider: 'claude-code', message: { type: 'result' } }), null)
})

test('the outcome machine: pending guidance is read, carried, returned or left unknown, and a final state stays', () => {
  assert.deepEqual(['read', 'carried', 'unsure', 'ended', 'other'].map((e) => nextState('pending', e)), ['delivered', 'carried', 'unknown', 'returned', 'pending'])
  for (const done of ['delivered', 'carried', 'returned']) assert.deepEqual(['read', 'carried', 'unsure', 'ended'].map((e) => nextState(done, e)), [done, done, done, done], done)
  assert.deepEqual(['read', 'carried', 'ended'].map((e) => nextState('unknown', e)), ['delivered', 'unknown', 'unknown'])
  assert.equal(nextState('added', 'read'), 'added', 'words added before the start are part of the task')
  assert.deepEqual(['pending', 'delivered', 'carried', 'returned', 'unknown'].map((state) => reachedWork({ how: 'live', state })), [false, true, true, false, true])
  assert.equal(reachedWork({ how: 'amend', state: 'added' }), false)
})

test('words for each state: the Live tab, the Tasks row and the card say what became of a piece of guidance, and the result head says it once more', () => {
  const at = new Date(2026, 9, 9, 14, 2, 30).getTime()
  assert.equal(steerStateWords({ state: 'pending' }), 'Waiting for its next step')
  assert.equal(steerStateWords({ state: 'delivered', name: 'Claude Code', readAt: at }), 'Read by Claude Code at 14:02')
  assert.equal(steerStateWords({ state: 'carried', to: { agent: 'codex', name: 'Codex', role: 'review' } }), 'Goes to the next attempt (Codex, review)')
  assert.equal(steerStateWords({ state: 'carried', to: { agent: 'deepseek', name: 'DeepSeek agent', role: 'retry' } }), 'Goes to the next attempt (DeepSeek agent, retry)')
  assert.equal(steerStateWords({ state: 'returned', name: 'Claude Code' }), 'Not used: Claude Code finished first')
  assert.equal(steerStateWords({ state: 'returned' }), 'Not used: the work finished first')
  assert.equal(steerStateWords({ state: 'unknown', name: 'Claude Code' }), 'Sent; Claude Code did not say whether it read it')
  assert.equal(steerStateWords({ state: 'added' }), 'Added to the task before it started')
  const long = 'use tabs, not spaces, in every file the parser touches, and keep the old grammar working'
  assert.equal(guidanceLine({ text: 'use tabs', state: 'delivered', name: 'Claude Code' }), 'Your guidance "use tabs": read by Claude Code.')
  assert.equal(guidanceLine({ text: long, state: 'carried', to: { name: 'Codex', role: 'review' } }), 'Your guidance "use tabs, not spaces, in every file the parser touches, and…": went to the next attempt (Codex, review).')
  assert.equal(guidanceLine({ text: 'run the linter', state: 'returned', name: 'Codex' }), 'Your guidance "run the linter": not used (arrived after the work finished).')
  assert.equal(guidanceLine({ text: 'run the linter', state: 'pending' }), 'Your guidance "run the linter": not used (arrived after the work finished).', 'still pending once the task ended is not used either')
  assert.equal(guidanceLine({ text: 'and the README', how: 'amend', state: 'added' }), 'Your guidance "and the README": added to the task before it started.')
  assert.equal(guidanceLine({ text: 'x', state: 'unknown', name: 'Claude Code' }), 'Your guidance "x": sent; Claude Code did not say whether it read it.')
  assert.deepEqual(guidanceLines([{ text: 'a\nb', state: 'delivered', name: 'Codex' }, { text: '' }, null]), ['Your guidance "a b": read by Codex.'])
  assert.equal(steerLine({ guidance: 'use tabs', state: 'delivered', name: 'Codex', readAt: at }), 'Your guidance "use tabs": read by Codex at 14:02')
  assert.equal(steerLine({ guidance: 'use tabs', state: 'pending' }), 'Your guidance "use tabs": waiting for its next step')
})

test('words for each provider: what the agent at work does with the words, or why they wait for the next attempt', () => {
  assert.equal(liveWords('DeepSeek agent'), 'DeepSeek agent takes this in at its next step.')
  assert.equal(liveWords('Codex'), 'Codex takes this in at its next step.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'claude-off', name: 'Claude Code' }), 'Claude Code can\'t take messages mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code"). It goes to the next attempt if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'claude', name: 'Claude Code' }), 'Claude Code started before "Let Steer reach a running Claude Code" was on, so it can\'t take messages mid-run. It goes to the next attempt if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'unpatched', name: 'Codex' }), 'Codex can\'t take messages mid-run while its live detail is off (Settings, Jev setup, Live agent view). It goes to the next attempt if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'checks' }), 'jev-4 is running its checks right now, so this goes with its next attempt, if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'review' }), 'jev-4\'s work is being reviewed right now, so this goes with its next attempt, if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'between' }), 'jev-4 has no agent at work right now, so this goes with its next attempt, if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'ending' }), 'jev-4 is finishing, so this may come too late; its result says whether it was used.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'refused', name: 'Codex' }), 'Codex could not take it at this step. It goes to the next attempt if there is one.')
  assert.equal(heldWords({ jobId: 'jev-4', why: 'tool', name: 'the lint tool' }), 'The lint tool can\'t take messages mid-run. It goes to the next attempt if there is one.')
  for (const why of ['claude-off', 'claude', 'unpatched', 'checks', 'review', 'between', 'ending', 'refused', 'tool', 'none']) assert.doesNotMatch(heldWords({ jobId: 'jev-4', why }), /[\u2013\u2014]|undefined|null/, why)
})

// ---------- Send now into a running agent, and Claude Code's input channel (slice 10) ----------

test('Send now on a spawn child gives back the steers it has not taken in, then cancels its turn with its inbox kept, then queues the words as its next turn, after those it gave back, in that order', async () => {
  const calls = []
  const inbox = new Set(['g1'])
  const agent = {
    steer() {},
    inbox: { remove: (id) => { calls.push(['remove', id]); return inbox.delete(id) } },
    cancel: (cause, options) => calls.push(['cancel', cause, options]),
    followup: (message) => calls.push(['followup', message]),
  }
  const entry = { ...spawnEntry(), sub: { localAgent: agent } }
  assert.equal(typeof S.nowPath, 'function', 'steer.js says how Send now stops the agent at work')
  assert.deepEqual(S.nowPath(entry), { path: 'spawn', why: null })
  const sent = await S.sendNow(entry, 'spawn', { id: 'n1', text: 'stop and fix the lexer first', unclaimed: [{ id: 'g1', text: 'use tabs' }, { id: 'g0', text: 'taken in already' }] })
  assert.deepEqual(sent, { sent: true, folded: ['g1'] }, 'only the steer still in its inbox goes with the words')
  assert.deepEqual(calls, [
    ['remove', 'g1'],
    ['remove', 'g0'],
    ['cancel', { kind: 'parent' }, { keepInbox: true }],
    ['followup', { id: 'n1', role: 'user', content: [{ type: 'text', text: `${STEER_PREFIX}use tabs` }, { type: 'text', text: `${STEER_PREFIX}stop and fix the lexer first` }], source: { kind: 'user' } }],
  ])
  // A child that cannot be stopped says why, and nothing more is done to it.
  const stuck = { ...entry, sub: { localAgent: { ...agent, cancel: () => { throw new Error('the agent is gone') }, followup: () => calls.push(['never']) } } }
  assert.deepEqual(await S.sendNow(stuck, 'spawn', { id: 'n2', text: 'x' }), { sent: false, why: 'the agent is gone' })
  assert.equal(calls.at(-1)[0], 'followup', 'no follow-up after a cancel that failed')
  assert.deepEqual(await S.sendNow(spawnEntry(), null, { id: 'n3', text: 'x' }), { sent: false, why: 'none' })
})

test('Send now on Codex hands the engine patch\'s sendNow the words with the piece\'s id, as it does a Claude Code run with its input channel; a refusal says why; and a Send now its agent never took in as its attempt ends, as a Codex turn that completed before its interrupt landed leaves it (kzhNext still set), is returned', async () => {
  assert.equal(typeof S.sendNow, 'function', 'steer.js hands a running agent words to replace its current step with')
  assert.equal(typeof S.nowLeft, 'function', 'and says which of them its agent never took in as its attempt ends')
  const handed = []
  const codex = { ...codexEntry(null), control: { steer: async () => {}, sendNow: async (text, id) => { handed.push(['codex', text, id]) } } }
  assert.deepEqual(S.nowPath(codex), { path: 'codex', why: null })
  assert.deepEqual(await S.sendNow(codex, 'codex', { id: 'n1', text: 'run the linter now' }), { sent: true, folded: [] })
  const claude = channelEntry({ sendNow: async (text, uuid) => { handed.push(['claude', text, uuid]) } })
  assert.deepEqual(S.nowPath(claude, { claudeSteer: true }), { path: 'claude', why: null })
  assert.deepEqual(await S.sendNow(claude, 'claude', { id: 'n2', text: 'stop there' }), { sent: true, folded: [] })
  assert.deepEqual(handed, [['codex', `${STEER_PREFIX}run the linter now`, 'n1'], ['claude', `${STEER_PREFIX}stop there`, 'n2']])
  // Claude Code's steer goes through its channel the same way.
  const steered = []
  assert.deepEqual(await sendLive(channelEntry({ steer: async (text, uuid) => { steered.push([text, uuid]) } }), 'claude', { id: 'g3', text: 'use tabs' }), { sent: true })
  assert.deepEqual(steered, [[`${STEER_PREFIX}use tabs`, 'g3']])
  const noTurn = { ...codex, control: { sendNow: async () => { throw Object.assign(new Error('no turn is running'), { code: 'kzh-no-turn' }) } } }
  assert.deepEqual(await S.sendNow(noTurn, 'codex', { id: 'n4', text: 'x' }), { sent: false, why: 'kzh-no-turn' })
  const closed = channelEntry({ sendNow: async () => { throw Object.assign(new Error('no open input channel'), { code: 'kzh-no-channel' }) } })
  assert.deepEqual(await S.sendNow(closed, 'claude', { id: 'n5', text: 'x' }), { sent: false, why: 'kzh-no-channel' })
  assert.deepEqual(await S.sendNow({ ...codex, control: { sendNow: () => new Promise(() => {}) } }, 'codex', { id: 'n6', text: 'x', acceptMs: 10 }), { sent: true, folded: [] }, 'not answered within the bound, taken as sent')
  // As attempt 0 of run-1 ends: only its own Send now still pending was not used.
  const steers = [
    { id: 'n1', how: 'now', state: 'pending', runId: 'run-1', attempt: 0 },
    { id: 'n7', how: 'now', state: 'delivered', runId: 'run-1', attempt: 0 },
    { id: 'g8', how: 'live', state: 'pending', runId: 'run-1', attempt: 0 },
    { id: 'n9', how: 'now', state: 'pending', runId: 'run-1', attempt: 1 },
    { id: 'n10', how: 'now', state: 'pending', runId: 'run-2', attempt: 0 },
    { id: 'n11', how: 'now', state: 'pending', refused: true, runId: 'run-1', attempt: 0 },
  ]
  const left = S.nowLeft(steers, { runId: 'run-1', attempt: 0 })
  assert.deepEqual(left.map((s) => [s.id, nextState(s.state, 'ended')]), [['n1', 'returned']], 'a steer still waiting goes on to the next attempt instead, and so does a Send now its agent refused')
  assert.deepEqual(S.nowLeft(null, { runId: 'run-1', attempt: 0 }), [])
})

test('Send now stops only an agent that has a way to be stopped, and says why not for the rest, while Steer\'s words for Claude Code\'s channel say what it may do with them', () => {
  assert.equal(typeof S.nowPath, 'function', 'steer.js says how Send now stops the agent at work')
  assert.deepEqual(S.nowPath(null), { path: null, why: 'idle' })
  assert.deepEqual(S.nowPath(spawnEntry()), { path: null, why: 'none' }, 'a spawn run with nothing to cancel its turn by')
  assert.deepEqual(S.nowPath(codexEntry(null)), { path: null, why: 'unpatched' })
  assert.deepEqual(S.nowPath(channelEntry()), { path: null, why: 'claude-off' }, 'Settings\' switch off')
  assert.deepEqual(S.nowPath(claudeEntry({ steer: async () => {}, sendNow: async () => {} }), { claudeSteer: true }), { path: null, why: 'claude' }, 'started before the switch was on')
  assert.deepEqual(S.nowPath(claudeEntry(null), { claudeSteer: true }), { path: null, why: 'unpatched' })
  assert.deepEqual(S.nowPath({ attempt: 0, role: 'tool', agentId: 'tool:lint', provider: 'tool' }), { path: null, why: 'tool' })
  assert.equal(typeof S.nowWords, 'function')
  assert.equal(S.nowWords('DeepSeek agent'), 'Send now stops DeepSeek agent\'s current step and gives it your words at once.')
  assert.equal(typeof S.nowHeldWords, 'function')
  const held = (why, name) => S.nowHeldWords({ jobId: 'jev-4', why, name })
  assert.equal(held('claude-off', 'Claude Code'), 'Send now can\'t stop Claude Code mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code").')
  assert.equal(held('claude', 'Claude Code'), 'Send now can\'t stop Claude Code mid-run: it started before "Let Steer reach a running Claude Code" was on.')
  assert.equal(held('unpatched', 'Codex'), 'Send now can\'t stop Codex mid-run while its live detail is off (Settings, Jev setup, Live agent view).')
  assert.equal(held('tool', 'the lint tool'), 'Send now can\'t stop the lint tool mid-run.')
  assert.equal(held('checks'), 'Send now has nothing to stop while jev-4 runs its checks.')
  assert.equal(held('review'), 'Send now has nothing to stop while jev-4\'s work is being reviewed.')
  assert.equal(held('ending'), 'Send now has nothing to stop: jev-4 is finishing.')
  assert.equal(held('between'), 'Send now has nothing to stop: jev-4 has no agent at work right now.')
  for (const why of ['claude-off', 'claude', 'unpatched', 'checks', 'review', 'between', 'ending', 'tool', 'none']) assert.doesNotMatch(held(why), /[\u2013\u2014]|undefined|null/, why)
  assert.equal(liveWords('Claude Code', 'claude'), 'Claude Code takes this in between tool calls; if it finishes first you\'ll be told it wasn\'t used.')
  assert.equal(liveWords('Codex', 'codex'), 'Codex takes this in at its next step.')
})
