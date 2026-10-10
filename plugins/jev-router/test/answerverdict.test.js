// Like/Dislike under an answer: the DOM-free decisions behind the control. The browser half of
// client.js is a classic script, so the pure helpers exposed on `__test` are read the same way
// the transcript and task-list tests read theirs. The control itself is rendered at the end, with a
// stand-in React and a stubbed route; how it looks is verified in the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

const { messageProvenance, messageRunId, verdictProvider, storedVerdict, toggledVerdict, feedbackBody, canSuggest, modelId, tagsFor, toggledTag } = loadPlugin().__test
const marker = (steps) => `Some answer.\n\n[jev-agents]: kzh-agents-1-${Buffer.from(JSON.stringify(steps)).toString('base64url')}\n`

test('answer verdict: a routed answer reports its agent and model from the chain marker', () => {
  const text = marker([
    { agent: 'Jev', model: 'jev-1.13.0', roles: [] },
    { agent: 'deepseek', model: 'deepseek-flash, high', roles: ['work'], answered: true },
  ])
  assert.deepEqual(messageProvenance(text), { agent: 'deepseek', model: 'deepseek-flash', provider: '' })
})

test('answer verdict: a direct answer reports provider and model from the credit line', () => {
  assert.deepEqual(
    messageProvenance('Reply.\n\n> Answered by: DeepSeek Flash (`deepseek/deepseek-flash`), directly: a question, no agents or project work'),
    { agent: '', model: 'deepseek-flash', provider: 'deepseek' },
  )
  // When the pretty name equals the pair there are no backticks, and the bare pair still names both.
  assert.deepEqual(
    messageProvenance('> Answered by: local/gemma-e4b, directly: a question, no agents or project work'),
    { agent: '', model: 'gemma-e4b', provider: 'local' },
  )
})

test('answer verdict: a message that reports no provenance says so instead of guessing', () => {
  assert.equal(messageProvenance('A background result with no credit at all.'), null)
  assert.equal(messageProvenance(''), null)
  assert.equal(messageProvenance(undefined), null)
})

test('answer verdict: a routed verdict is attributable before the agent list loads', () => {
  // The bug: a click made before loadEnabledAgents() resolves used to post an empty provider,
  // which feedbackPrior drops, so the owner's teaching signal was stored but never moved a pick.
  // The chain chip already names the agent and feedbackPrior resolves an agent id directly
  // (router.js:187), so the verdict is attributable from the answer's own text, with the
  // enabled-agent list left out of the decision entirely.
  const prov = messageProvenance(marker([
    { agent: 'Jev', model: 'jev-1.13.0', roles: [] },
    { agent: 'deepseek', model: 'deepseek-flash, high', roles: ['work'], answered: true },
  ]))
  assert.equal(verdictProvider(prov), 'deepseek', 'the chain chip names the agent itself')
  assert.notEqual(verdictProvider(prov), '', 'a fast click cannot store an empty provider')
  // The exact body the control posts when the list has not arrived: no agents argument exists.
  const body = feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', suggestedAgent: '', provider: verdictProvider(prov), model: prov.model })
  assert.equal(body.provider, 'deepseek', 'the committed row is attributable')
  assert.equal(body.model, 'deepseek-flash')
})

test('answer verdict: a direct answer keeps its provider, and no provenance stays empty', () => {
  const direct = messageProvenance('> Answered by: DeepSeek Flash (`deepseek/deepseek-flash`), directly: a question, no agents or project work')
  assert.equal(verdictProvider(direct), 'deepseek', 'a direct answer names its own provider')
  assert.equal(verdictProvider(null), '', 'a bare result card attributes to nothing rather than guessing')
  assert.equal(verdictProvider(undefined), '')
})

test('answer verdict: the stored verdict is the newest row for that message', () => {
  const rows = [
    { messageId: 'a', verdict: 'like' },
    { messageId: 'b', verdict: 'dislike' },
    { messageId: 'a', verdict: 'dislike', reason: 'wrong agent' },
  ]
  assert.deepEqual(storedVerdict(rows, 'a'), { messageId: 'a', verdict: 'dislike', reason: 'wrong agent' })
  assert.deepEqual(storedVerdict(rows, 'b'), { messageId: 'b', verdict: 'dislike' })
  assert.equal(storedVerdict(rows, 'c'), null)
  assert.equal(storedVerdict(undefined, 'a'), null)
})

test('answer verdict: clicking the active verdict clears it, a different one wins', () => {
  assert.equal(toggledVerdict('like', 'like'), null)
  assert.equal(toggledVerdict('dislike', 'dislike'), null)
  assert.equal(toggledVerdict('like', 'dislike'), 'dislike')
  assert.equal(toggledVerdict('dislike', 'like'), 'like')
  assert.equal(toggledVerdict(null, 'like'), 'like')
})

test('answer verdict: the POST body drops empty optionals and always keeps an empty reason', () => {
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'like', reason: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'like', reason: '' },
  )
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: 'wrong agent', suggestedAgent: 'claude', provider: 'codex', model: 'gpt-5' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: 'wrong agent', suggestedAgent: 'claude', provider: 'codex', model: 'gpt-5' },
  )
})

test('answer verdict: the tag rides the POST only when picked, and never on a clear', () => {
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', tag: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '' },
    'an unpicked tag is left out, not sent as empty',
  )
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', tag: 'wrong agent', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', tag: 'wrong agent' },
  )
  // The clear is built with the tag already dropped, so a pending chip cannot outlive the verdict.
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: null, reason: '', tag: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'clear', reason: '' },
  )
})

test('answer verdict: the offered tags match the verdict, and a pick toggles off', () => {
  assert.deepEqual(tagsFor('like'), ['good pick', 'good answer'])
  assert.deepEqual(tagsFor('dislike'), ['wrong agent', 'misread my question', 'wrong scope', 'not enough detail', 'too slow'])
  assert.deepEqual(tagsFor(null), [], 'no verdict, no chips')
  // A tag is optional: the same chip clicked again removes it.
  assert.equal(toggledTag('', 'too slow'), 'too slow')
  assert.equal(toggledTag('too slow', 'too slow'), '')
  assert.equal(toggledTag('too slow', 'wrong agent'), 'wrong agent')
})

test('answer verdict: clicking the active button sends the clear tombstone, not nothing', () => {
  // toggledVerdict nulls the UI state; feedbackBody is what decides the wire value, and a cleared
  // verdict must still be posted so the store can tombstone it.
  assert.equal(toggledVerdict('like', 'like'), null)
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: toggledVerdict('like', 'like'), reason: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'clear', reason: '' },
  )
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: toggledVerdict('like', 'dislike'), reason: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '' },
  )
})

test('answer verdict: the should-have-been list only offers ids the route accepts', () => {
  assert.equal(canSuggest({ id: 'claude' }), true)
  assert.equal(canSuggest({ id: 'gemma-local' }), true)
  assert.equal(canSuggest({ id: 'auto' }), false)
  assert.equal(canSuggest({ id: 'Claude' }), false)
  assert.equal(canSuggest({ id: 'has space' }), false)
  assert.equal(canSuggest(null), false)
})

test('answer verdict: a chain model keeps only the model, not the effort', () => {
  assert.equal(modelId('deepseek-flash, high'), 'deepseek-flash')
  assert.equal(modelId('opus'), 'opus')
  assert.equal(modelId(undefined), '')
})

test('answer verdict: the run an answer came from rides every verdict, read off the answer itself', async () => {
  // Without it the server can only guess the run by time: a first verdict on an older answer,
  // given after a newer run in the session had ended, was credited to the newer run.
  const { withRunMark } = await import('../index.js')
  const { validFeedback } = await import('../feedback.js')
  const text = withRunMark(`The answer.\n\n${marker([{ agent: 'deepseek', model: 'deepseek-flash', roles: ['work'], answered: true }]).trim()}`, 'run-older-1')
  assert.equal(messageRunId(text), 'run-older-1', 'the client reads the mark route() writes')
  assert.equal(messageRunId('A background result with no mark.'), '')
  // A turn that reports two runs is judged on the last, as its provenance is.
  assert.equal(messageRunId(withRunMark(withRunMark('two runs', 'first'), 'second')), 'second')
  const body = feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: 'dislike', reason: '', provider: 'deepseek', model: 'deepseek-flash', runId: messageRunId(text) })
  assert.equal(body.runId, 'run-older-1')
  assert.equal(validFeedback(body).runId, 'run-older-1', 'and the server stores it as sent')
  assert.ok(!('runId' in feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: null, runId: 'run-older-1' })), 'a clear needs no run')
  assert.ok(!('runId' in feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: 'like', runId: '' })), 'no mark, no field')
})

test('answer verdict: the reply route() hands back carries the run mark', () => {
  // route() lives inside apply(), which needs the whole plugin runtime, so its return is read from
  // the source: every routed reply must go through withRunMark, or the client has no run to send.
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = index.indexOf('async function route(')
  const body = index.slice(start, index.indexOf('\n  async function ', start + 1))
  const replies = body.match(/return [^\n]*formatReport\(result\)[^\n]*/g) ?? []
  assert.ok(replies.length >= 1, 'route() returns the formatted report')
  for (const r of replies) assert.match(r, /withRunMark\(formatReport\(result\), result\.runId\)/, r)
})

// ---------- under a start reply the verdict rates the pick (docs/live-agent-view.md Feature 4, slice 6) ----------
// Each test first asks whether client.js has the helper, so the code before the slice fails it by
// that assertion rather than by calling what is not there.
const t = loadPlugin().__test
const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e'
const startReply = `OK, I'll run **jev-4** in kz-harness on Codex (gpt-5.5, effort high).\n\n[jev-job]: kzh-job-1-${KEY}\n[jev-run]: kzh-run-1-run-4`

test('answer verdict: a [jev-job] message rates the pick, with the plan tags, and the effort select only with wrong effort', async () => {
  assert.equal(typeof t.verdictMode, 'function', 'client.js tells a start reply from an answer')
  const { validFeedback } = await import('../feedback.js')
  assert.equal(t.verdictMode(startReply), 'plan')
  assert.equal(t.messageJobKey(startReply), KEY)
  assert.equal(t.verdictMode('An answer.'), 'answer')
  assert.deepEqual(t.tagsFor('like', 'plan'), ['good pick'])
  assert.deepEqual(t.tagsFor('dislike', 'plan'), ['wrong agent', 'wrong effort', 'misread my question', 'wrong scope', 'should have been a question'])
  for (const v of ['like', 'dislike']) for (const tag of t.tagsFor(v, 'plan')) assert.equal(validFeedback({ sessionId: 's-1', messageId: 'm-1', verdict: v, about: 'plan', taskKey: KEY, tag }).tag, tag, `the route takes ${tag}`)
  assert.deepEqual(t.verdictSelects('plan', 'dislike', 'wrong effort'), { agent: false, effort: true })
  assert.deepEqual(t.verdictSelects('plan', 'dislike', 'wrong agent'), { agent: true, effort: false })
  assert.deepEqual(t.verdictSelects('plan', 'dislike', ''), { agent: true, effort: false }, 'an untagged dislike may still name the agent')
  for (const tag of ['misread my question', 'wrong scope', 'should have been a question']) assert.deepEqual(t.verdictSelects('plan', 'dislike', tag), { agent: false, effort: false }, tag)
  assert.deepEqual(t.verdictSelects('plan', 'like', 'good pick'), { agent: false, effort: false })
  assert.deepEqual(t.planEfforts, [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']])
  // A choice its select no longer shows is dropped with the tag that showed it.
  assert.deepEqual(t.shownOnly('plan', { verdict: 'dislike', tag: 'misread my question', suggestedAgent: 'codex', suggestedEffort: 'xhigh' }), { verdict: 'dislike', tag: 'misread my question', suggestedAgent: '', suggestedEffort: '' })
  assert.deepEqual(t.shownOnly('plan', { verdict: 'dislike', tag: 'wrong effort', suggestedAgent: 'codex', suggestedEffort: 'xhigh' }), { verdict: 'dislike', tag: 'wrong effort', suggestedAgent: '', suggestedEffort: 'xhigh' })
})

test('answer verdict: the POST body of a verdict about the pick has about, taskKey, runId and suggestedEffort, and the route stores them', async () => {
  const { validFeedback } = await import('../feedback.js')
  const body = feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: 'dislike', reason: '', tag: 'wrong effort', provider: 'codex', model: 'gpt-5.5', runId: messageRunId(startReply), about: 'plan', taskKey: KEY, suggestedEffort: 'xhigh' })
  assert.deepEqual(body, { sessionId: 's-1', messageId: 'm-1', verdict: 'dislike', reason: '', tag: 'wrong effort', provider: 'codex', model: 'gpt-5.5', runId: 'run-4', about: 'plan', taskKey: KEY, suggestedEffort: 'xhigh' })
  const stored = validFeedback(body)
  assert.deepEqual([stored.about, stored.taskKey, stored.runId, stored.suggestedEffort], ['plan', KEY, 'run-4', 'xhigh'])
  assert.deepEqual(feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: null, about: 'plan', taskKey: KEY, suggestedEffort: 'xhigh' }), { sessionId: 's-1', messageId: 'm-1', verdict: 'clear', reason: '' }, 'a clear carries only its keys')
})

test('answer verdict: a message without the mark keeps today\'s tags and body, and a direct answer may say it should have been a task', async () => {
  assert.equal(typeof t.messageIntentSample, 'function', 'client.js reads a direct answer\'s example')
  assert.deepEqual(tagsFor('dislike'), ['wrong agent', 'misread my question', 'wrong scope', 'not enough detail', 'too slow'])
  assert.deepEqual(t.tagsFor('dislike', 'answer'), tagsFor('dislike'))
  assert.deepEqual(tagsFor('like'), ['good pick', 'good answer'])
  assert.deepEqual(t.verdictSelects('answer', 'dislike', 'too slow'), { agent: true, effort: false }, 'the agent select under any dislike of an answer, as before')
  assert.deepEqual(feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: 'like', reason: '', provider: 'deepseek', about: 'answer', taskKey: '', suggestedEffort: '', intentSample: '' }), { sessionId: 's-1', messageId: 'm-1', verdict: 'like', reason: '', provider: 'deepseek' })
  const direct = 'The answer.\n\n> Answered by: DeepSeek Flash (`deepseek/deepseek-flash`), directly\n\n[jev-intent]: kzh-intent-1-sample-7'
  assert.equal(t.verdictMode(direct), 'answer')
  assert.equal(t.messageIntentSample(direct), 'sample-7')
  assert.equal(t.messageIntentSample('An answer.'), '')
  assert.deepEqual(t.tagsFor('dislike', 'answer', { direct: true }), [...tagsFor('dislike'), 'should have been a task'])
  const { validFeedback } = await import('../feedback.js')
  const body = feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: 'dislike', reason: '', tag: 'should have been a task', intentSample: t.messageIntentSample(direct) })
  assert.deepEqual([validFeedback(body).tag, validFeedback(body).intentSample, 'about' in validFeedback(body)], ['should have been a task', 'sample-7', false])
})

test('answer verdict: the ask appears only when what ran is another agent than the reply said and nothing is rated, once per chat, and not after two typed messages or once asking is off', () => {
  assert.equal(typeof t.askFor, 'function', 'client.js has the ask')
  const row = { said: { agent: 'claude', effort: 'high' }, ran: { agent: 'codex', level: 'high' }, verdict: null, ask: null, askWhenWrong: true }
  const names = { claude: 'Claude Code', codex: 'Codex' }
  const ask = t.askFor({ row, messageId: 'm-1', names })
  assert.equal(ask.text, 'It ran on Codex, not Claude Code as I said. Which was right?')
  assert.deepEqual(ask.choices, [['said', 'Claude Code'], ['ran', 'Codex'], ['either', 'Doesn\'t matter']])
  assert.equal(t.askFor({ row: { ...row, ran: { agent: 'claude' } }, messageId: 'm-1', names }), null, 'what ran is what it said')
  assert.equal(t.askFor({ row: { ...row, said: null }, messageId: 'm-1', names }), null, 'a reply that named no agent')
  assert.equal(t.askFor({ row, rated: true, messageId: 'm-1', names }), null, 'rated here')
  assert.equal(t.askFor({ row: { ...row, verdict: { verdict: 'like' } }, messageId: 'm-1', names }), null, 'or on record')
  assert.equal(t.askFor({ row: { ...row, ask: { answer: 'either' } }, messageId: 'm-1', names }), null, 'never asked twice for one reply')
  assert.equal(t.askFor({ row: { ...row, askWhenWrong: false }, messageId: 'm-1', names }), null, 'off, as Don\'t ask me this leaves it')
  assert.equal(t.askFor({ row, typedSince: 1, messageId: 'm-1', names })?.text, ask.text, 'still asked after one typed message')
  assert.equal(t.askFor({ row, typedSince: 2, messageId: 'm-1', names }), null, 'gone after two')
  const nodes = [{ kind: 'user', content: [] }, { kind: 'assistant', messageId: 'm-1', blocks: [] }, { kind: 'user', content: [] }, { kind: 'context' }, { kind: 'user', content: [] }]
  assert.deepEqual([t.typedAfter(nodes, 'm-1'), t.typedAfter(nodes.slice(0, 3), 'm-1'), t.typedAfter(nodes, 'm-9')], [2, 1, 0])
  // One open ask per chat: a second reply waits until the first lets it go, and another chat has its own.
  let holders = t.claimAsk({}, 's-1', 'm-1')
  assert.equal(t.claimAsk(holders, 's-1', 'm-2'), holders, 'm-2 does not take it from m-1')
  assert.equal(t.askFor({ row, messageId: 'm-2', holder: holders['s-1'], names }), null)
  assert.deepEqual(t.claimAsk(holders, 's-2', 'm-3'), { 's-1': 'm-1', 's-2': 'm-3' })
  holders = t.releaseAsk(holders, 's-1', 'm-1')
  assert.deepEqual(t.claimAsk(holders, 's-1', 'm-2'), { 's-1': 'm-2' })
  // An answer is a verdict about the agent that ran: right, or the one the reply named should have had it.
  assert.deepEqual(t.askVerdict('ran', ask), { verdict: 'like', tag: 'good pick', suggestedAgent: '', provider: 'codex' })
  assert.deepEqual(t.askVerdict('said', ask), { verdict: 'dislike', tag: 'wrong agent', suggestedAgent: 'claude', provider: 'codex' })
  assert.equal(t.askVerdict('either', ask), null)
})

// ---------- the control as the page runs it, behind a stubbed route ----------
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const treeNodes = (n) => (n && typeof n === 'object' ? [n, ...n.children.flatMap(treeNodes)] : [])
const textOf = (n) => (n == null || n === false ? '' : typeof n !== 'object' ? String(n) : n.children.map(textOf).join(''))

/** A stand-in React that keeps the mounted component's state across renders, as test/laya-card.test.js has it. */
function statefulReact() {
  let current = null
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const slot = () => { const v = current; return [v, v.i++] }
  const React = {
    createElement,
    Fragment: 'fragment',
    useState: (init) => {
      const [v, k] = slot()
      if (!(k in v.slots)) v.slots[k] = typeof init === 'function' ? init() : init
      return [v.slots[k], (x) => { const next = typeof x === 'function' ? x(v.slots[k]) : x; if (!Object.is(next, v.slots[k])) { v.slots[k] = next; v.schedule() } }]
    },
    useEffect: (fn, deps) => {
      const [v, k] = slot()
      const prev = v.slots[k]
      if (prev && same(prev.deps, deps)) return
      v.slots[k] = { deps, cleanup: null }
      v.effects.push(() => { prev?.cleanup?.(); v.slots[k].cleanup = fn() ?? null })
    },
    useCallback: (f) => f,
    useRef: (init) => { const [v, k] = slot(); if (!(k in v.slots)) v.slots[k] = { current: init }; return v.slots[k] },
  }
  const mount = (Component, props) => {
    const view = { slots: [], i: 0, effects: [], queued: false, tree: null }
    view.render = () => {
      view.queued = false; view.i = 0; view.effects = []
      current = view
      view.tree = Component(props)
      current = null
      for (const run of view.effects) run()
    }
    view.schedule = () => { if (!view.queued) { view.queued = true; queueMicrotask(view.render) } }
    view.unmount = () => { for (const x of view.slots) x?.cleanup?.() }
    view.render()
    return view
  }
  return { React, mount }
}

test('answer verdict: under a start reply the Learned line renders the server\'s effects once a verdict is saved, and the POST names the task, the run and the effort', async () => {
  const posted = []
  const fetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    if (path === '/jev-router/feedback' && init?.method === 'POST') posted.push(body)
    const answer = path === '/jev-router/feedback' && init?.method === 'POST' ? { ok: true, record: body, effects: ['Learned: 1 of 3 "effort too low" ratings for Codex on doc edits; at 3, Auto effort there rises one step.'] }
      : path.startsWith('/jev-router/feedback') ? { feedback: [] } : path.startsWith('/jev-router/replies') ? { said: { agent: 'codex' }, ran: { agent: 'codex' }, askWhenWrong: true } : {}
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, appendChild() {} }), createTextNode: () => ({}) }
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } }, addEventListener() {}, removeEventListener() {} }
  new Function('window', 'fetch', 'document', 'setTimeout', 'clearTimeout', src)(window, fetch, document, () => 0, () => {})
  const lib = registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
  assert.equal(typeof lib.verdictMode, 'function', 'client.js rates a start reply\'s pick')
  const nodes = [{ kind: 'user', content: [{ type: 'text', text: 'tidy the docs' }] }, { kind: 'assistant', messageId: 'm-1', blocks: [{ kind: 'text', text: startReply }] }]
  const view = mount(lib.AnswerVerdict, { messageId: 'm-1', sessionId: 's-1', useChat: (pick) => pick({ legacy: { nodes } }) })
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  await settle()
  const find = (pred) => treeNodes(view.tree).find(pred)
  assert.equal(find((n) => n.props?.role === 'group' && n.props['aria-label'])?.props['aria-label'], 'Rate this pick')
  find((n) => n.type === 'button' && textOf(n) === 'Dislike').props.onClick()
  await settle()
  find((n) => n.type === 'button' && textOf(n) === 'wrong effort').props.onClick()
  await settle()
  const effort = find((n) => n.type === 'select' && n.props['aria-label']?.startsWith('effort should have been'))
  assert.ok(effort, 'the effort select shows with wrong effort')
  assert.equal(find((n) => n.type === 'select' && n.props['aria-label']?.startsWith('should have been:')), undefined, 'and the agent select does not')
  effort.props.onChange({ target: { value: 'xhigh' } })
  await settle()
  const last = posted.at(-1)
  assert.deepEqual([last.about, last.taskKey, last.runId, last.tag, last.suggestedEffort], ['plan', KEY, 'run-4', 'wrong effort', 'xhigh'])
  assert.equal(textOf(find((n) => n.props?.className === 'kzh-vd-learned')), 'Learned: 1 of 3 "effort too low" ratings for Codex on doc edits; at 3, Auto effort there rises one step.')
  view.unmount()
})

/**
 * One page: client.js loaded with a stand-in React that keeps state, and `fetch` answered by
 * `route(path, init, body)`, whose throw is a refusal (a 400 with its message, or the throw's own
 * `status`). `settle` lets every request and render queued so far finish. The page's timers are
 * `timers` when given, and never fire otherwise.
 */
function pageWith(route, timers = { setTimeout: () => 0, clearTimeout: () => {} }) {
  const { React, mount } = statefulReact()
  const fetch = async (path, init) => {
    let status = 200
    let answer
    try { answer = await route(path, init, init?.body ? JSON.parse(init.body) : null) } catch (err) { status = err.status ?? 400; answer = { error: err.message } }
    return { ok: status === 200, status, json: async () => answer ?? {}, text: async () => JSON.stringify(answer ?? {}) }
  }
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, appendChild() {} }), createTextNode: () => ({}) }
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } }, addEventListener() {}, removeEventListener() {} }
  new Function('window', 'fetch', 'document', 'setTimeout', 'clearTimeout', src)(window, fetch, document, timers.setTimeout, timers.clearTimeout)
  const lib = registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  return { lib, mount, settle }
}
const replyNodes = [{ kind: 'user', content: [{ type: 'text', text: 'tidy the docs' }] }, { kind: 'assistant', messageId: 'm-1', blocks: [{ kind: 'text', text: startReply }] }]
const changedPlan = { said: { agent: 'claude' }, ran: { agent: 'codex' }, verdict: null, ask: null, askWhenWrong: true }
const find = (view, pred) => treeNodes(view.tree).find(pred)
const button = (view, words) => find(view, (n) => n.type === 'button' && textOf(n) === words)
const askOf = (view) => find(view, (n) => n.props?.className === 'kzh-vd-ask')

test('answer verdict: under a start reply whose plan changed the ask shows, not after two typed messages, and Stop jev-N shows while its task runs and it should have been a question', async () => {
  for (const state of ['running', 'completed']) {
    let typed = replyNodes
    const page = pageWith((path) => (path.startsWith('/jev-router/feedback') ? { feedback: [] } : path.startsWith('/jev-router/replies') ? changedPlan
      : path === '/jev-router/tasks' ? { tasks: [{ key: KEY, jobId: 'jev-4', state, title: 'tidy the docs', queuedAt: Date.now() - 5000, startedAt: Date.now() - 4000 }] } : {}))
    assert.equal(typeof page.lib.askFor, 'function', 'client.js has the ask')
    const view = page.mount(page.lib.AnswerVerdict, { messageId: 'm-1', sessionId: 's-1', useChat: (pick) => pick({ legacy: { nodes: typed } }) })
    await page.settle()
    const ask = askOf(view)
    assert.ok(ask, 'the ask shows under the reply')
    assert.equal(ask.props['aria-label'], 'It ran on codex, not claude as I said. Which was right?')
    assert.ok(button(view, 'Don\'t ask me this'))
    // Two messages typed since the reply, and the ask is gone.
    typed = [...replyNodes, { kind: 'user', content: [] }, { kind: 'user', content: [] }]
    view.render()
    await page.settle()
    assert.equal(askOf(view), undefined, 'gone after two typed messages')
    // Said to have been a question while its task runs: it can be stopped from here, and not once it has ended.
    button(view, 'Dislike').props.onClick()
    await page.settle()
    button(view, 'should have been a question').props.onClick()
    await page.settle()
    assert.equal(!!button(view, 'Stop jev-4'), state === 'running', `a ${state} task`)
    view.unmount()
  }
})

test('answer verdict: a reply that named its guess before routing picked reads its row again until what ran lands, and asks then without a remount; a task that ends first, or a row that never comes, is read no more', async () => {
  // The page's timers, fired by hand: `tick` runs every read due.
  const due = new Map()
  let ids = 0
  const timers = { setTimeout: (fn) => { due.set(++ids, fn); return ids }, clearTimeout: (id) => { due.delete(id) } }
  const tick = async (page) => { const run = [...due.values()]; due.clear(); for (const fn of run) fn(); await page.settle() }
  const notYet = () => { throw Object.assign(new Error('no start reply of that task is recorded'), { status: 404 }) }
  /** A reply mounted over the ledger's row as it reads one read after another (`rows`, the last one kept), with how many reads were made. */
  const replyOver = async (rows) => {
    const seen = { reads: 0 }
    const page = pageWith((path) => {
      if (path.startsWith('/jev-router/feedback')) return { feedback: [] }
      if (!path.startsWith('/jev-router/replies')) return {}
      const row = rows[Math.min(seen.reads++, rows.length - 1)]
      return row ?? notYet()
    }, timers)
    seen.page = page
    seen.view = page.mount(page.lib.AnswerVerdict, { messageId: 'm-1', sessionId: 's-1', useChat: (pick) => pick({ legacy: { nodes: replyNodes } }) })
    await page.settle()
    return seen
  }
  const named = { ...changedPlan, ran: null, ended: null }

  // Its said note is not written yet, then it is and nothing has run, then routing picks another agent.
  const r = await replyOver([null, named, named, { ...named, ran: { agent: 'codex' } }])
  assert.equal(askOf(r.view), undefined, 'no row yet')
  await tick(r.page)
  assert.equal(askOf(r.view), undefined, 'named, and nothing has run yet')
  await tick(r.page)
  await tick(r.page)
  assert.equal(r.reads, 4, 'the row is read again while nothing has run')
  assert.equal(askOf(r.view)?.props['aria-label'], 'It ran on codex, not claude as I said. Which was right?', 'the ask shows once what ran lands')
  await tick(r.page)
  assert.equal(r.reads, 4, 'and the row is read no more')
  r.view.unmount()

  // A task that ends with nothing run is read once, a row that never comes three times more, and an unmounted reply no more.
  const ended = await replyOver([{ ...named, ended: 'cancelled' }])
  for (let i = 0; i < 5; i++) await tick(ended.page)
  assert.equal(ended.reads, 1, 'a task that has ended runs nothing more')
  ended.view.unmount()
  const never = await replyOver([null])
  for (let i = 0; i < 6; i++) await tick(never.page)
  assert.equal(never.reads, 4, 'a row that never comes is given up')
  never.view.unmount()
  const left = await replyOver([named])
  assert.equal(due.size, 1, 'a reply waiting for what ran reads again')
  left.view.unmount()
  assert.equal(due.size, 0, 'until it is unmounted')
})

test('answer verdict: Don\'t ask me this takes the ask away, and the Chat replies switch brings it back on the same page', async () => {
  const posted = []
  let asking = true
  const page = pageWith((path, init, body) => {
    if (init?.method === 'POST') posted.push([path, body])
    if (path === '/jev-router/chat-replies/settings') { if (body && 'askWhenWrong' in body) asking = body.askWhenWrong; return { waitMs: 4000, progress: 'milestones', askWhenWrong: asking } }
    return path.startsWith('/jev-router/feedback') ? { feedback: [] } : path.startsWith('/jev-router/replies') ? { ...changedPlan, askWhenWrong: asking } : {}
  })
  assert.equal(typeof page.lib.askFor, 'function', 'client.js has the ask')
  const reply = page.mount(page.lib.AnswerVerdict, { messageId: 'm-1', sessionId: 's-1', useChat: (pick) => pick({ legacy: { nodes: replyNodes } }) })
  const card = page.mount(page.lib.ChatRepliesCard, {})
  await page.settle()
  assert.ok(askOf(reply), 'the ask shows under the reply whose plan changed')
  button(reply, 'Don\'t ask me this').props.onClick()
  await page.settle()
  assert.deepEqual(posted.at(-1), ['/jev-router/chat-replies/settings', { askWhenWrong: false }])
  assert.equal(askOf(reply), undefined, 'gone with Don\'t ask me this')
  // A reply shown after that reads the setting off: the switch brings its ask back too.
  const later = page.mount(page.lib.AnswerVerdict, { messageId: 'm-1', sessionId: 's-2', useChat: (pick) => pick({ legacy: { nodes: replyNodes } }) })
  await page.settle()
  assert.equal(askOf(later), undefined)
  const toggle = find(card, (n) => n.type === 'input' && n.props.role === 'switch')
  assert.equal(toggle.props.checked, true, 'the card was read before the ask was switched off')
  toggle.props.onChange({ target: { checked: true } })
  await page.settle()
  assert.deepEqual(posted.at(-1), ['/jev-router/chat-replies/settings', { askWhenWrong: true }])
  assert.ok(askOf(reply), 'the switch brings the ask back under the reply')
  assert.ok(askOf(later), 'and under the reply read while it was off')
  reply.unmount(); later.unmount(); card.unmount()
})

test('answer verdict: an answer to the ask whose verdict is refused leaves the ask open and keeps no answer; one that is saved keeps it', async () => {
  const posted = []
  let refuse = true
  const page = pageWith((path, init, body) => {
    if (init?.method === 'POST') posted.push(path)
    if (path === '/jev-router/feedback' && init?.method === 'POST') { if (refuse) throw new Error('provider: an agent or provider id'); return { ok: true, record: body, effects: ['Learned: this run\'s pick is confirmed for the local router.'] } }
    if (path === '/jev-router/replies/ask') return { ok: true, ask: { answer: 'ran' } }
    return path.startsWith('/jev-router/feedback') ? { feedback: [] } : path.startsWith('/jev-router/replies') ? changedPlan : {}
  })
  assert.equal(typeof page.lib.askFor, 'function', 'client.js has the ask')
  const view = page.mount(page.lib.AnswerVerdict, { messageId: 'm-1', sessionId: 's-1', useChat: (pick) => pick({ legacy: { nodes: replyNodes } }) })
  await page.settle()
  const choice = (words) => treeNodes(askOf(view)).find((n) => n.type === 'button' && textOf(n) === words)
  choice('codex').props.onClick()
  await page.settle()
  assert.deepEqual(posted, ['/jev-router/feedback'], 'no answer is kept for a verdict that was refused')
  assert.ok(askOf(view), 'and the ask is still open')
  refuse = false
  choice('codex').props.onClick()
  await page.settle()
  assert.deepEqual(posted, ['/jev-router/feedback', '/jev-router/feedback', '/jev-router/replies/ask'])
  assert.equal(askOf(view), undefined, 'answered')
  view.unmount()
})

test('answer verdict: an answer to the ask names no tool as an agent, so a tool on either side still posts a verdict the route takes', async () => {
  assert.equal(typeof t.askFor, 'function', 'client.js has the ask')
  const { validFeedback } = await import('../feedback.js')
  const row = (said, ran) => ({ said: { agent: said }, ran: { agent: ran }, verdict: null, ask: null, askWhenWrong: true })
  for (const [said, ran] of [['claude', 'tool:grep'], ['tool:grep', 'claude']]) {
    const ask = t.askFor({ row: row(said, ran), messageId: 'm-1', names: { claude: 'Claude Code' } })
    assert.ok(ask, `asked when ${said} was said and ${ran} ran`)
    for (const answer of ['said', 'ran']) {
      const body = t.feedbackBody({ sessionId: 's-1', messageId: 'm-1', ...t.askVerdict(answer, ask), about: 'plan', taskKey: KEY })
      assert.doesNotThrow(() => validFeedback(body), `${answer} when ${said} was said and ${ran} ran: ${JSON.stringify(body)}`)
    }
  }
  const named = t.askFor({ row: row('claude', 'tool:grep'), messageId: 'm-1', names: { claude: 'Claude Code' } })
  assert.deepEqual(t.askVerdict('said', named), { verdict: 'dislike', tag: 'wrong agent', suggestedAgent: 'claude', provider: '' }, 'the agent the reply named still should have had it')
  assert.deepEqual(t.askVerdict('said', t.askFor({ row: row('tool:grep', 'claude'), messageId: 'm-1', names: {} })), { verdict: 'dislike', tag: 'wrong agent', suggestedAgent: '', provider: 'claude' }, 'a tool named: the agent that ran was wrong')
})

test('answer verdict: under an answer the Learned line shows only when something was learned', async () => {
  let effects = ['Saved.']
  const page = pageWith((path, init, body) => (path === '/jev-router/feedback' && init?.method === 'POST' ? { ok: true, record: body, effects }
    : path.startsWith('/jev-router/feedback') ? { feedback: [] } : {}))
  assert.equal(typeof page.lib.learnedLine, 'function', 'client.js shows what a verdict changed')
  const nodes = [{ kind: 'user', content: [{ type: 'text', text: 'what is a lock file?' }] }, { kind: 'assistant', messageId: 'm-a', blocks: [{ kind: 'text', text: 'A lock file pins versions.\n\nAnswered by: DeepSeek Flash (`deepseek/deepseek-flash`), directly' }] }]
  const view = page.mount(page.lib.AnswerVerdict, { messageId: 'm-a', sessionId: 's-1', useChat: (pick) => pick({ legacy: { nodes } }) })
  await page.settle()
  assert.equal(find(view, (n) => n.props?.role === 'group')?.props['aria-label'], 'Rate this answer')
  button(view, 'Like').props.onClick()
  await page.settle()
  assert.equal(find(view, (n) => n.props?.className === 'kzh-vd-learned'), undefined, 'a plain verdict\'s Saved. is not shown under an answer')
  effects = ['Learned: marked as a question for the task-or-question classifier (it has 214 checked examples).']
  button(view, 'Dislike').props.onClick()
  await page.settle()
  assert.equal(textOf(find(view, (n) => n.props?.className === 'kzh-vd-learned')), effects[0])
  view.unmount()
})
