// The live view in the browser (docs/live-agent-view.md Feature 1, slice 4): the Live tab, the card
// under a start reply, the work board's second line and the Tasks tab's live tail, with the pure
// helpers that word them. client.js is a classic script, so it is run here as the page runs it, with a
// stand-in React that keeps state across renders, GET /jev-router/live and /jev-router/tasks answered
// from this file, and the timers it sets held rather than run, so each poll is run by the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const nodes = (n) => (Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [])
const textOf = (n) => (Array.isArray(n) ? n.map(textOf).join('') : n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : n.children.map(textOf).join(''))

/** The pure helpers, from client.js run with a React that renders nothing. */
function helpers() {
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', client)(window)
  const React = { createElement, Fragment: 'fragment', useState: (v) => [v, () => {}], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
}

/**
 * A stand-in React that keeps state across renders for the one component mounted, as
 * observability.test.js has it: the components it renders are called in place with the mounted one's
 * hooks, and it renders again on the next microtask after a state change, as React batches it. A
 * component given a key keeps hooks of its own under that key, as React keeps its state: rendered
 * under another key it starts afresh, and one no longer rendered is let go, its effects cleaned up.
 */
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
    useCallback: (f, deps) => {
      const [v, k] = slot()
      if (v.slots[k] && same(v.slots[k].deps, deps)) return v.slots[k].f
      v.slots[k] = { f, deps }
      return f
    },
    useRef: (init) => { const [v, k] = slot(); if (!(k in v.slots)) v.slots[k] = { current: init }; return v.slots[k] },
  }
  const keyed = (n) => {
    const host = current
    const root = host.root
    const id = `${n.type.name}:${n.props.key}`
    const own = root.keyed.get(id) ?? { slots: [], root, schedule: root.schedule }
    root.keyed.set(id, own)
    root.seen.add(id)
    Object.assign(own, { i: 0, effects: root.effects })
    current = own
    try { return expand(n.type({ ...n.props, children: n.children })) } finally { current = host }
  }
  const expand = (n) => (Array.isArray(n) ? n.map(expand) : !n || typeof n !== 'object' ? n
    : typeof n.type === 'function' ? (n.props.key != null ? keyed(n) : expand(n.type({ ...n.props, children: n.children })))
      : { ...n, children: n.children.map(expand) })
  const cleanup = (slots) => { for (const x of slots) x?.cleanup?.() }
  const mount = (Component, props) => {
    const view = { slots: [], i: 0, effects: [], queued: false, tree: null, renders: 0, keyed: new Map(), seen: new Set() }
    view.root = view
    view.render = () => {
      view.renders++
      view.queued = false; view.i = 0; view.effects = []; view.seen = new Set()
      current = view
      view.tree = expand(Component(props))
      current = null
      for (const [id, own] of view.keyed) if (!view.seen.has(id)) { cleanup(own.slots); view.keyed.delete(id) }
      for (const run of view.effects) run()
    }
    view.schedule = () => { if (!view.queued) { view.queued = true; queueMicrotask(view.render) } }
    view.unmount = () => { cleanup(view.slots); for (const own of view.keyed.values()) cleanup(own.slots) }
    view.render()
    return view
  }
  return { React, mount }
}

/**
 * `name` from client.js mounted with `props`, behind GET /jev-router/tasks answering `pg.tasks` and
 * GET /jev-router/live answering `pg.live(query)` (a body, or `{ code, body }`), with every POST kept
 * and answered with `pg.answers[path]` where a test sets one.
 * The timers it sets are held: `pg.run(ms)` runs those set for `ms` once and lets what they cause
 * settle, and `pg.tick(ms)` runs the intervals set for `ms` once. `now` is the page's clock where a
 * test moves it by hand (Date.now in client.js). `pg.document.hidden` is the page's own, and
 * `pg.fire(type)` tells its listeners. `pg.mount(other, props)` mounts another component on the same
 * page, as a chat has a card under each reply, and each mount counts its renders. With `sidebar`,
 * the client is applied with a right sidebar that keeps each tab it is asked to open (`pg.opened`).
 */
async function page(name, props, { tasks = [], live = () => ({ v: 0, runs: [], done: false }), now = null, sidebar = false } = {}) {
  const pg = { gets: [], posts: [], timers: [], intervals: [], opened: [], tasks, live, answers: {} }
  let busy = 0
  const fetch = async (path, init = {}) => {
    busy++
    try {
      let code = 200
      let body = { error: 'not found' }
      if ((init.method ?? 'GET') === 'POST') { pg.posts.push([path, JSON.parse(init.body)]); body = pg.answers[path] ?? { result: 'requested' } }
      else {
        pg.gets.push(path)
        if (path === '/jev-router/tasks') body = { tasks: pg.tasks }
        else if (path.startsWith('/jev-router/live?')) {
          const r = pg.live(new URLSearchParams(path.slice(path.indexOf('?') + 1)))
          if (r?.code) { code = r.code; body = r.body } else body = r
        } else code = 404
      }
      const text = JSON.stringify(body)
      return { ok: code === 200, status: code, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  let ids = 0
  const setTimeout = (f, ms) => { const id = ++ids; pg.timers.push({ id, f, ms }); return id }
  const clearTimeout = (id) => { pg.timers = pg.timers.filter((x) => x.id !== id) }
  const setInterval = (f, ms) => { const id = ++ids; pg.intervals.push({ id, f, ms }); return id }
  const clearInterval = (id) => { pg.intervals = pg.intervals.filter((x) => x.id !== id) }
  const Clock = now ? class extends Date { static now() { return now() } } : Date
  const listeners = new Map()
  pg.document = {
    hidden: false, getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} },
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
    removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== fn)) },
  }
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } }, addEventListener() {}, removeEventListener() {} }
  new Function('window', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'document', 'Date', client)(window, fetch, setTimeout, clearTimeout, setInterval, clearInterval, pg.document, Clock)
  const { React, mount } = statefulReact()
  const mod = registration.factory((x) => { if (x === 'react') return React; throw new Error(`unexpected require: ${x}`) })
  const t = mod.__test
  assert.equal(typeof t[name], 'function', `client.js has ${name}`)
  // Only the right sidebar is wanted of apply(), which takes it first; what it goes on to register
  // needs the engine's slots, which this page has none of.
  if (sidebar) { try { mod.apply({ sessions: {}, sidebarRight: { openTab: (kind, o) => pg.opened.push([kind, o]), isExpanded: () => false }, layout: {}, get: () => undefined, effect() {} }) } catch { /* past the sidebar */ } }
  const view = mount(t[name], props)
  pg.settle = async () => { for (let quiet = 0; quiet < 3; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  pg.run = async (ms) => { const due = pg.timers.filter((x) => x.ms === ms); pg.timers = pg.timers.filter((x) => x.ms !== ms); for (const x of due) x.f(); await pg.settle() }
  pg.tick = async (ms) => { for (const x of pg.intervals.filter((i) => i.ms === ms)) x.f(); await pg.settle() }
  pg.fire = async (type) => { for (const fn of listeners.get(type) ?? []) fn(); await pg.settle() }
  pg.listening = (type) => (listeners.get(type) ?? []).length
  pg.liveGets = () => pg.gets.filter((p) => p.startsWith('/jev-router/live?')).map((p) => p.slice('/jev-router/live?'.length))
  pg.all = () => nodes(view.tree)
  pg.text = () => textOf(view.tree)
  pg.tree = () => view.tree
  pg.button = (label) => pg.all().find((n) => n.type === 'button' && (textOf(n) === label || n.props['aria-label'] === label))
  pg.click = async (label) => { pg.button(label).props.onClick({ target: {} }); await pg.settle() }
  pg.renders = () => view.renders
  pg.mount = (other, otherProps) => { const v = mount(t[other], otherProps); return { tree: () => v.tree, renders: () => v.renders, close: () => v.unmount() } }
  pg.close = () => view.unmount()
  await pg.settle()
  return pg
}

const NOW = Date.now()
/** One item as GET /jev-router/live gives it (live.js publicItem). */
const item = (id, n, v, over = {}) => ({ id, n, v, at: NOW, attempt: 0, kind: 'text', router: false, title: '', text: '', clippedBefore: 0, state: 'running', meta: {}, ...over })
const ATTEMPT = { index: 0, role: 'primary', agent: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', model: 'deepseek-flash', effort: 'high', detail: 'live', why: null, thinking: null, child: { id: 'child-1', label: 'jev:deepseek' }, tools: 1, tokens: { input: 900, output: 100, cacheRead: 0, reasoning: 0, total: 1000 } }
const summary = (over = {}) => ({ phrase: 'Writing', tools: 1, tokens: 1000, agent: 'DeepSeek agent', model: 'deepseek-flash', effort: 'high', elapsedMs: 12_000, lastActivityAt: NOW - 2000, lastAgentAt: NOW - 2000, live: true, open: null, done: null, ...over })
const TASK = { key: 'k1', jobId: 'jev-3', sessionId: 's1', state: 'running', taskName: 'Fix the parser', taskText: 'Fix the parser', startedAt: NOW - 12_000, agent: 'deepseek', deliveryState: 'pending', runIds: ['run-1'] }
const answer = (v, run, over = {}) => ({ v, runs: [{ runId: 'run-1', v, keptFrom: 1, attempts: [ATTEMPT], child: ATTEMPT.child, summary: summary(), ...run }], done: false, saved: false, patches: {}, task: { key: 'k1', jobId: 'jev-3', taskName: 'Fix the parser', state: 'running', sessionId: 's1' }, ...over })
/** TASK still waiting for a free slot with Tasks at once set to 1, with the controls view() gives it (slice 7). */
const WAITING = { ...TASK, state: 'queued', startedAt: null, queuedAt: NOW - 5000, runIds: [], waiting: { why: 'cap', place: 1, ahead: 0, since: NOW - 5000, placeText: 'next for a free slot', text: 'Waiting for a free slot: the resource budget caps how many tasks run at once.' },
  controls: { sendNow: 'slot', holder: null, heldBy: null, ahead: [], chatAhead: 0, held: 1, max: 1, local: null, forcedLocal: false } }
/** The Send now or Steer dialog open on a page, if one is (client.js QueueDialog). */
const dialogOf = (pg) => pg.all().find((n) => n.props.role === 'dialog')

// ---------- the pure helpers ----------

test('stallWords says what live.js stallOf says, from the same facts and the same clock', async () => {
  const t = helpers()
  assert.equal(typeof t.stallWords, 'function', 'client.js words a stall')
  const { stallOf } = await import('../live.js')
  const at = 1_000_000
  const cases = [
    { open: { since: at - 61_000, command: 'npm test' }, lastAgentAt: at - 61_000, agent: 'DeepSeek agent', live: true },
    { open: { since: at - 59_000, command: 'npm test' }, lastAgentAt: at - 59_000, agent: 'DeepSeek agent', live: true },
    { open: { since: at - 185_000, command: `node ${'x'.repeat(100)}` }, lastAgentAt: at, agent: 'DeepSeek agent', live: true },
    { open: null, lastAgentAt: at - 91_000, agent: 'Claude Code', live: true },
    { open: null, lastAgentAt: at - 89_000, agent: 'Claude Code', live: true },
    { open: null, lastAgentAt: at - 91_000, agent: 'Claude Code', live: false },
    { open: null, lastAgentAt: null, agent: 'Claude Code', live: true },
    { open: null, lastAgentAt: at - 4_000_000, agent: undefined, live: true },
    // A call of a tool that is no command still running: the agent waits on it, and is not silent.
    { open: null, lastAgentAt: at - 91_000, agent: 'DeepSeek agent', live: true, busy: true },
    { open: null, lastAgentAt: at - 91_000, agent: 'DeepSeek agent', live: true, busy: false },
    { open: { since: at - 61_000, command: 'npm test' }, lastAgentAt: at - 61_000, agent: 'DeepSeek agent', live: true, busy: true },
  ]
  for (const c of cases) assert.equal(t.stallWords(c, at), stallOf(c, at)?.words ?? '', JSON.stringify(c))
  assert.equal(t.stallWords(cases[0], at), 'Waiting on a command for 1m 01s: npm test')
  assert.equal(t.stallWords(cases[3], at), 'No news from Claude Code for 1m 31s. It may still be thinking; Stop is on this row.')
  assert.equal(t.stallWords(cases[8], at), '', 'a call still running holds back the silence words')
  // The work board's line and the card take it from the activity, as they take what is open.
  const waiting = { phrase: 'Delegating to a sub-agent', tools: 3, tokens: 0, rate: 0, lastActivityAt: at - 100_000, lastAgentAt: at - 100_000, agent: 'DeepSeek agent', live: true, open: null, busy: true, done: null }
  assert.equal(t.activityLine(waiting, at), 'Delegating to a sub-agent · 3 tool calls · 0 tokens/s · quiet for 1m 40s')
  assert.match(t.activityLine({ ...waiting, busy: false }, at), /^No news from DeepSeek agent for 1m 40s\./)
})

test('the work board\'s line: phrase, tool calls, tokens, the rate while it streams and how long ago, then quiet for N s with the rate at 0', () => {
  const t = helpers()
  assert.equal(typeof t.activityLine, 'function', 'client.js words a task\'s activity')
  const a = { phrase: 'Running a command: npm test', tools: 14, tokens: 18_240, rate: 31.4, lastActivityAt: 100_000, lastAgentAt: 100_000, agent: 'DeepSeek agent', live: true, open: { since: 99_000, command: 'npm test' }, done: null }
  assert.equal(t.activityLine(a, 101_500), 'Running a command: npm test · 14 tool calls · 18.2k tokens · 31 tokens/s · 1 s ago')
  // Nothing for 2 s: the rate has fallen to 0; nothing for 10 s: the line says how long it has been quiet.
  assert.equal(t.activityLine(a, 103_000), 'Running a command: npm test · 14 tool calls · 18.2k tokens · 0 tokens/s · 3 s ago')
  assert.equal(t.activityLine({ ...a, open: null, phrase: 'Thinking' }, 115_000), 'Thinking · 14 tool calls · 18.2k tokens · 0 tokens/s · quiet for 15 s')
  // A command open past a minute: the stall's words take the phrase's place, with the clock's count.
  assert.equal(t.activityLine(a, 165_000), 'Waiting on a command for 1m 06s: npm test · 14 tool calls · 18.2k tokens · 0 tokens/s · quiet for 1m 05s')
  // An agent whose stream this build cannot read has no rate, and one tool call is one. While it works
  // its steps are not heard, so the line says nothing of how quiet it is, then or minutes on; once its
  // result is in, the router's steps are heard again.
  const off = { phrase: 'Working (live detail is off for Claude Code)', tools: 1, tokens: 0, rate: null, lastActivityAt: 100_000, live: false, heard: false, open: null, done: null }
  assert.equal(t.activityLine(off, 101_000), 'Working (live detail is off for Claude Code) · 1 tool call')
  assert.equal(t.activityLine(off, 402_500), 'Working (live detail is off for Claude Code) · 1 tool call')
  assert.equal(t.activityLine({ ...off, phrase: 'Running your checks: test', heard: true }, 115_000), 'Running your checks: test · 1 tool call · quiet for 15 s')
  // Ended: how it went, in the state it ended in.
  const done = { ...a, done: { status: 'accepted', label: 'Completed', ms: 432_000 }, tools: 23, tokens: 41_000 }
  assert.equal(t.activityLine(done, 0), 'Done in 7m 12s · 23 tool calls · 41k tokens')
  assert.equal(t.doneLine(done, 'stopped'), 'Stopped after 7m 12s · 23 tool calls · 41k tokens')
  assert.deepEqual([950, 1000, 18_240, 123_456, 1_234_567].map(t.tokenWords), ['950 tokens', '1k tokens', '18.2k tokens', '123k tokens', '1.2M tokens'])
})

test('mergeLive keeps each step at its newest version, in the order the run made them, lets go of those older than the run keeps but its dropped line, and asks after the newest version next', () => {
  const t = helpers()
  assert.equal(typeof t.mergeLive, 'function', 'client.js merges live reads')
  const first = t.mergeLive(null, answer(5, { items: [item('a', 1, 2, { text: 'one' }), item('b', 2, 5, { text: 'tw' })] }), 10)
  assert.deepEqual([first.v, first.fetchedAt, first.runs[0].items.map((x) => x.text)], [5, 10, ['one', 'tw']])
  // Only what changed comes again: b grows, c is new, and an older copy of a never wins over the newer.
  const second = t.mergeLive(first, answer(9, { items: [item('c', 3, 9, { text: 'three' }), item('b', 2, 8, { text: 'two' }), item('a', 1, 1, { text: 'stale' })] }), 20)
  assert.deepEqual(second.runs[0].items.map((x) => [x.id, x.text]), [['a', 'one'], ['b', 'two'], ['c', 'three']])
  assert.equal(second.v, 9)
  // The run dropped its oldest steps: they go, and the marker that says so stays, first.
  const third = t.mergeLive(second, answer(12, { keptFrom: 3, items: [item('dropped', 0, 12, { kind: 'status', title: 'Older steps dropped (2)', state: 'done' })] }), 30)
  assert.deepEqual(third.runs[0].items.map((x) => x.id), ['dropped', 'c'])
  // A pass that writes, after the read pass: both, in the order they ran.
  const fourth = t.mergeLive(third, { v: 14, runs: [{ runId: 'run-1', v: 12, keptFrom: 3, attempts: [], items: [], summary: {} }, { runId: 'run-2', v: 14, keptFrom: 1, attempts: [], items: [item('x', 1, 14)], summary: {} }], done: true, saved: false })
  assert.deepEqual([fourth.runs.map((r) => r.runId), fourth.done, fourth.runs[0].items.length], [['run-1', 'run-2'], true, 2])
  assert.equal(first.runs[0].items.length, 2, 'what an earlier merge gave is left as it was')
})

test('thinking previews its newest lines with Show all, or its token count; attempts, commands, the header, the notes and the end line are worded', () => {
  const t = helpers()
  for (const f of ['reasoningPreview', 'attemptTitle', 'cleanTerminal', 'liveHeader', 'liveNotes', 'liveEndLine']) assert.equal(typeof t[f], 'function', `client.js has ${f}`)
  const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
  assert.deepEqual(t.reasoningPreview({ text: long }), { text: Array.from({ length: 8 }, (_, i) => `line ${i + 4}`).join('\n'), more: true })
  assert.deepEqual(t.reasoningPreview({ text: 'short' }), { text: 'short', more: false })
  assert.equal(t.reasoningPreview({ text: long }, { full: true }).text, long)
  assert.deepEqual(t.reasoningPreview({ text: '', meta: { tokens: 1234 } }), { text: 'Thinking... (about 1.2k tokens)', more: false })
  // Work attempts are counted apart from the review between them.
  const attempts = [{ index: 0, role: 'primary', name: 'Claude Code' }, { index: 1, role: 'review', name: 'Codex' }, { index: 2, role: 'retry', name: 'Codex' }, { index: 3, role: 'opinion', name: 'DeepSeek agent' }]
  assert.deepEqual(attempts.map((a) => t.attemptTitle(a, attempts)), ['Attempt 1 · Claude Code · work', 'Review · Codex', 'Attempt 2 · Codex · work', 'Second opinion · DeepSeek agent'])
  // Colours stripped, Windows line ends read as line ends, a progress bar at its last state, the last 20 lines.
  const out = `${Array.from({ length: 25 }, (_, i) => `row ${i}`).join('\r\n')}\r\n\u001b[32mPASS\u001b[0m 3 tests\r\nloading 10%\rloading 100%\r\n`
  const clean = t.cleanTerminal(out)
  assert.equal(clean.hidden, 7)
  assert.deepEqual(clean.text.split('\n').slice(-3), ['row 24', 'PASS 3 tests', 'loading 100%'])
  assert.equal(clean.text.split('\n').length, 20)
  assert.equal(t.cleanTerminal('abcdef\rxy').text, 'xycdef', 'a return overwrites from the start of the line, as a terminal does')
  // The header: the job, who, the model it was asked for, the effort, its time, its tokens and how long ago.
  const view = t.mergeLive(null, answer(5, { items: [] }), NOW)
  assert.equal(t.liveHeader(view, NOW), 'jev-3 · DeepSeek agent · deepseek-flash · effort high · 12s · 1k tokens · last activity 2 s ago')
  assert.equal(t.liveHeader(view, NOW + 5000), 'jev-3 · DeepSeek agent · deepseek-flash · effort high · 17s · 1k tokens · last activity 7 s ago', 'it moves on between reads')
  // Notes only where they apply: detail that is off, a local model that thinks silently, a saved transcript.
  assert.deepEqual(t.liveNotes(view), [])
  const off = { ...ATTEMPT, name: 'Claude Code', detail: 'off', why: 'this build has no hook into its stream yet', child: null }
  const local = { ...ATTEMPT, index: 1, name: 'Qwen (local)', thinking: false }
  assert.deepEqual(t.liveNotes({ ...view, saved: true, runs: [{ ...view.runs[0], attempts: [off, local] }] }), [
    'Live detail for Claude Code is off: this build has no hook into its stream yet. You still see the router\'s steps, and the result posts as usual.',
    'This local model runs with thinking off, so there is no reasoning to show.',
    'Saved transcript (last 256 KB). The task\'s report is in the chat.',
  ])
  assert.equal(t.liveEndLine(view), '')
  assert.equal(t.liveEndLine({ ...view, done: true, runs: [{ ...view.runs[0], summary: summary({ done: { status: 'accepted', label: 'Completed', ms: 250_000 } }) }] }), 'Finished: Completed in 4m 10s.')
})

test('the Live tab\'s end line says how its task ended, and its header leaves out the last activity of an agent whose steps it cannot hear', () => {
  const t = helpers()
  assert.equal(typeof t.liveEndLine, 'function', 'client.js words the end line')
  const run = (done, over = {}) => ({ runId: 'run-1', v: 5, keptFrom: 1, attempts: [ATTEMPT], items: [], summary: summary({ done, ...over }) })
  const view = (state, runs) => ({ done: true, runs, task: { key: 'k1', jobId: 'jev-3', state } })
  const handedBack = { status: 'needs_write', label: 'Handed back to its folder\'s line', ms: 45_000 }
  assert.equal(t.liveEndLine(view('stopped', [run(handedBack)])), 'Finished: Stopped in 45s.', 'removed, or caught by a restart, as it waited after its read pass')
  assert.equal(t.liveEndLine(view('completed', [run(handedBack), run({ status: 'accepted', label: 'Completed', ms: 60_000 })])), 'Finished: Completed in 1m 45s.')
  assert.equal(t.liveEndLine(view('stopped', [])), 'Finished: Stopped.', 'stopped before any pass began')
  assert.equal(t.liveEndLine({ done: true, runs: [run({ status: 'failed', label: 'Failed', ms: 5000 })] }), 'Finished: Failed in 5s.', 'a view of one run says how the run ended')
  // Claude Code at work: its steps are not heard, so the header says nothing of its last activity.
  const off = { ...ATTEMPT, name: 'Claude Code', model: 'claude-opus-4-1', detail: 'off', child: null }
  const working = t.mergeLive(null, answer(5, { attempts: [off], summary: summary({ agent: 'Claude Code', model: 'claude-opus-4-1', heard: false, live: false, tokens: 0, lastActivityAt: NOW - 302_000 }) }), NOW)
  assert.equal(t.liveHeader(working, NOW), 'jev-3 · Claude Code · claude-opus-4-1 · effort high · 12s')
})

// ---------- the Live tab ----------

test('the Live tab reads its task every 700 ms after the version it has, merges what changed, reads nothing while the page is hidden, stops once the task has ended, and turns Follow off when scrolled up', async () => {
  const answers = [
    answer(5, { items: [item('m1', 1, 2, { router: true, kind: 'status', title: 'Picked by Jev: DeepSeek agent', attempt: null, state: 'done' }), item('a0:t', 2, 5, { text: 'Looking at' })] }),
    answer(9, { items: [item('a0:t', 2, 8, { text: 'Looking at the parser.' }), item('a0:call:c1', 3, 9, { kind: 'command', title: 'Ran npm test · exit 1', state: 'done', text: '\u001b[31mFAIL\u001b[0m parse.test.js' })] }),
    answer(12, { summary: summary({ done: { status: 'accepted', label: 'Completed', ms: 30_000 } }), items: [item('a0:t', 2, 12, { text: 'Looking at the parser. Fixed it.', state: 'done', meta: { final: true } })] }, { done: true }),
  ]
  let n = 0
  const pg = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true, navigation: { revision: 1, params: { task: 'k1' } } } }) }, { tasks: [TASK], live: () => answers[Math.min(n++, answers.length - 1)] })
  assert.deepEqual(pg.liveGets(), ['task=k1&after=0'])
  assert.match(pg.text(), /Picked by Jev: DeepSeek agent/)
  assert.match(pg.text(), /Attempt 1 · DeepSeek agent · work/)
  assert.match(pg.text(), /jev-3 · DeepSeek agent · deepseek-flash · effort high · \d+s · 1k tokens · last activity \d+ s ago/)
  assert.match(pg.text(), /Usage: 900 tokens in, 100 tokens out/)
  assert.ok(pg.button('Stop'), 'a running task can be stopped from here')
  await pg.run(700)
  assert.deepEqual(pg.liveGets(), ['task=k1&after=0', 'task=k1&after=5'], 'the next read asks only for what changed')
  assert.match(pg.text(), /Looking at the parser\./)
  assert.match(pg.text(), /Ran npm test · exit 1/)
  assert.match(pg.text(), /FAIL parse\.test\.js/, 'its output, without the colour codes')
  assert.match(pg.text(), /Picked by Jev/, 'what came before is kept')
  // The page is hidden: nothing is read until it is shown again.
  pg.document.hidden = true
  await pg.run(700)
  assert.equal(pg.liveGets().length, 2)
  assert.equal(pg.listening('visibilitychange'), 1)
  pg.document.hidden = false
  await pg.fire('visibilitychange')
  assert.deepEqual(pg.liveGets().at(-1), 'task=k1&after=9')
  // The task has ended: the last read says so, and nothing more is asked.
  assert.match(pg.text(), /Finished: Completed in 30s\./)
  assert.equal(pg.timers.filter((x) => x.ms === 700).length, 0, 'no further read is set')
  await pg.run(700)
  assert.equal(pg.liveGets().length, 3)
  // Scrolled up to read: Follow turns off and Jump to latest turns it back on.
  assert.equal(pg.button('Follow').props['aria-pressed'], true)
  const timeline = pg.all().find((x) => x.props?.className === 'kzh-live-tl')
  timeline.props.onScroll({ currentTarget: { scrollHeight: 2000, scrollTop: 100, clientHeight: 400 } })
  await pg.settle()
  assert.equal(pg.button('Follow').props['aria-pressed'], false)
  await pg.click('Jump to latest')
  assert.equal(pg.button('Follow').props['aria-pressed'], true)
  assert.equal(pg.button('Jump to latest'), undefined)
  pg.close()
})

test('with no task named, the Live tab offers this chat\'s tasks, the live ones first, or says nothing is running', async () => {
  const done = { ...TASK, key: 'k0', jobId: 'jev-1', state: 'completed', taskName: 'Write the docs', finishedAt: NOW - 1000, activity: { ...summary(), done: { status: 'accepted', label: 'Completed', ms: 60_000 }, tools: 3, tokens: 5000 } }
  const elsewhere = { ...TASK, key: 'k9', jobId: 'jev-9', sessionId: 's2', taskName: 'Another chat\'s task' }
  const pg = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) }, { tasks: [done, { ...TASK, activity: summary() }, elsewhere] })
  assert.deepEqual(pg.liveGets(), [], 'nothing is read before a task is picked')
  assert.match(pg.text(), /Fix the parser[\s\S]*Recently finished[\s\S]*Write the docs/)
  assert.match(pg.text(), /Completed · Done in 1m 00s · 3 tool calls · 5k tokens/)
  assert.doesNotMatch(pg.text(), /Another chat's task/)
  await pg.click('Watch Fix the parser')
  assert.deepEqual(pg.liveGets(), ['task=k1&after=0'])
  pg.close()
  const empty = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) }, { tasks: [] })
  assert.match(empty.text(), /Nothing is running in this chat\. When a task starts you can watch it here\./)
  empty.close()
})

test('the Live tab\'s list says what a task back in its line waits for, never that it is done because its read pass is', async () => {
  const back = { ...TASK, state: 'queued', requeuedAt: NOW - 2000, waiting: { why: 'workspace', place: 2, ahead: 0, since: NOW - 2000, placeText: '2nd in line', text: 'Waiting: another task is running in this workspace.' }, activity: { ...summary(), done: { status: 'needs_write', label: 'Handed back to its folder\'s line', ms: 42_000 }, tools: 3 } }
  const pg = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) }, { tasks: [back] })
  assert.match(pg.text(), /Fix the parser/)
  assert.match(pg.text(), /Waiting: another task is running in this workspace\./)
  assert.doesNotMatch(pg.text(), /Done in/)
  pg.close()
})

test('the Live tab\'s list never says Stop is on a row that has only Watch: a silence it words by its own clock leaves Stop out, and so does one the store read just before the list\'s clock moved; the work board\'s line keeps it', async () => {
  // The store read the agent's silence half a second past the 90 s mark, and worded it with Stop in it.
  const said = 'No news from DeepSeek agent for 1m 30s. It may still be thinking; Stop is on this row.'
  const silent = { phrase: said, stall: { kind: 'silence', ms: 90_500, words: said }, tools: 2, tokens: 1000, rate: 0, lastActivityAt: NOW - 90_500, lastAgentAt: NOW - 90_500, agent: 'DeepSeek agent', live: true, heard: true, open: null, busy: false, done: null }
  // The list's clock some seconds on, and one that last ticked just before the read, short of the mark.
  for (const [at, words] of [[NOW + 4500, /Running · No news from DeepSeek agent for 1m 35s\. It may still be thinking\. · 2 tool calls/], [NOW - 600, /Running · 2 tool calls · 1k tokens · 0 tokens\/s · quiet for 1m 29s/]]) {
    const pg = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) }, { tasks: [{ ...TASK, activity: silent }], now: () => at })
    assert.match(pg.text(), words)
    const rows = pg.all().filter((n) => n.type === 'li')
    assert.equal(rows.length, 1)
    for (const li of rows) {
      const stops = nodes(li).filter((n) => n.type === 'button' && /^Stop\b/.test(textOf(n)))
      assert.ok(!/Stop is on this row/.test(textOf(li)) || stops.length, `a row that says Stop is on it holds one: ${textOf(li)}`)
    }
    pg.close()
  }
  // The work board's row and the card have a Stop beside the line, which says so.
  assert.match(helpers().activityLine(silent, NOW + 4500), /^No news from DeepSeek agent for 1m 35s\. It may still be thinking; Stop is on this row\. · /)
  assert.equal(helpers().stallWords(silent, NOW + 4500, { stopHere: false }), 'No news from DeepSeek agent for 1m 35s. It may still be thinking.')
})

test('the Live tab\'s list moves its clock while a task in it is live: a task gone quiet reads quiet for N s with its rate at 0, and its stall words count on, as the work board\'s line does', async () => {
  let at = NOW
  // Its last step came 5 s after the list was opened, and nothing since.
  const quiet = { phrase: 'Thinking', tools: 2, tokens: 1000, rate: 12, lastActivityAt: NOW + 5000, lastAgentAt: NOW + 5000, agent: 'DeepSeek agent', live: true, heard: true, open: null, busy: false, done: null }
  const pg = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) }, { tasks: [{ ...TASK, activity: quiet }], now: () => at })
  assert.match(pg.text(), /Thinking · 2 tool calls · 1k tokens · 12 tokens\/s · 0 s ago/)
  // Three minutes on: the list is read again each second, and the clock moves with it.
  at = NOW + 190_000
  await pg.run(1000)
  await pg.tick(1000)
  assert.match(pg.text(), /No news from DeepSeek agent for 3m 05s\. It may still be thinking\. · 2 tool calls · 1k tokens · 0 tokens\/s · quiet for 3m 05s/)
  assert.doesNotMatch(pg.text(), /0 s ago/)
  pg.close()
  // A list with nothing live in it holds no clock.
  const done = { ...TASK, state: 'completed', finishedAt: NOW, activity: { ...quiet, done: { status: 'accepted', label: 'Completed', ms: 60_000 } } }
  const still = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) }, { tasks: [done], now: () => at })
  assert.deepEqual(still.intervals, [])
  still.close()
})

test('the Live tab leaves out a step the store hid: a tool call that never ran, and a stream\'s steps already shown from the message it committed', async () => {
  const items = [
    item('a0:m3:0', 1, 2, { kind: 'reasoning', title: 'Thinking', text: 'Run the tests first.', state: 'done' }),
    item('a0:m3:1', 2, 3, { kind: 'text', text: 'Running the tests.', state: 'done' }),
    // The same steps from the stream, which the session's message was read before.
    item('a0:llm-1:0', 3, 4, { kind: 'reasoning', title: 'Thinking', text: 'Run the tests first.', state: 'done', meta: { hidden: true } }),
    item('a0:llm-1:1', 4, 5, { kind: 'text', text: 'Running the tests.', state: 'done', meta: { hidden: true } }),
    // A call streamed in a model call that failed, which never ran, and the call made when it was tried again.
    item('a0:call:c1', 5, 6, { kind: 'command', title: 'Running npm test', state: 'failed', meta: { hidden: true } }),
    item('a0:call:c2', 6, 7, { kind: 'command', title: 'Ran npm test · exit 0', state: 'done', text: 'ok' }),
  ]
  const pg = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true, navigation: { revision: 1, params: { task: 'k1' } } } }) }, { tasks: [TASK], live: () => answer(7, { items }) })
  const section = textOf(pg.all().find((x) => x.type === 'section' && x.props.className === 'kzh-live-sec' && /Attempt 1/.test(textOf(x))))
  assert.match(section, /Ran npm test · exit 0/)
  assert.doesNotMatch(section, /Running npm test/, 'the call that never ran')
  assert.equal(section.split('Running the tests.').length - 1, 1, 'the text, once')
  assert.equal(section.split('Run the tests first.').length - 1, 1, 'the thinking, once')
  pg.close()
})

test('the Live tab\'s Stop keeps the word its button had: a dialog whose task went back to waiting closes and says so, stopping nothing, as the work board\'s does; a waiting task\'s button is Remove, which stops it only while it waits, and a running task\'s Stop stops it', async () => {
  const opened = { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true, navigation: { revision: 1, params: { task: 'k1' } } } }) }
  const running = { ...TASK, activity: summary() }
  const back = { ...TASK, state: 'queued', requeuedAt: NOW - 1000, waiting: { why: 'workspace', place: 2, ahead: 0, since: NOW - 1000, placeText: '2nd in line', text: 'Waiting: another task is running in this workspace.' } }
  const pg = await page('LivePane', opened, { tasks: [running], live: () => answer(3, { items: [] }) })
  await pg.click('Stop')
  assert.ok(pg.button('Stop task'), 'it asks before stopping the task')
  // Its read pass hands the task back to its folder's line while the dialog is open.
  pg.tasks = [back]
  await pg.run(1000)
  assert.equal(pg.button('Stop task'), undefined, 'the dialog has closed')
  assert.deepEqual(pg.posts, [], 'nothing was stopped')
  assert.match(pg.text(), /"Fix the parser" went back to waiting in line while you were confirming, so nothing was stopped\. Use Remove on its row to take it out of the line\./)
  // Its button says Remove now, as its row does, and Remove asks the server to stop it only while it waits.
  await pg.click('Remove')
  await pg.click('Remove task')
  assert.deepEqual(pg.posts, [['/jev-router/tasks/stop', { jobId: 'jev-3', onlyIfWaiting: true }]])
  pg.close()
  const run = await page('LivePane', opened, { tasks: [running], live: () => answer(3, { items: [] }) })
  await run.click('Stop')
  await run.click('Stop task')
  assert.deepEqual(run.posts, [['/jev-router/tasks/stop', { jobId: 'jev-3' }]])
  run.close()
  // Opened on one run rather than a task, it reads that run, and its Stop stops that run.
  const one = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true, navigation: { revision: 1, params: { run: 'run-1' } } } }) }, { tasks: [], live: () => answer(3, { items: [] }, { task: undefined }) })
  assert.deepEqual(one.liveGets(), ['run=run-1&after=0'])
  await one.click('Stop')
  await one.click('Stop task')
  assert.deepEqual(one.posts, [['/jev-router/runs/stop', { runId: 'run-1' }]])
  one.close()
})

test('the Live tab\'s bar offers Send now and Steer… while its task waits in line and only Steer… once it is at work, each named by its task and each opening its dialog', async () => {
  const opened = { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true, navigation: { revision: 1, params: { task: 'k1' } } } }) }
  const pg = await page('LivePane', opened, { tasks: [WAITING] })
  assert.equal(textOf(pg.button('Send jev-3 now')), 'Send now')
  assert.equal(textOf(pg.button('Steer jev-3')), 'Steer…')
  await pg.click('Send jev-3 now')
  assert.match(textOf(dialogOf(pg)), /^Start jev-3 now\?It runs beside 1 other task, over your limit of 1 task at once \(Settings, Resource budget\), so the next task to end frees no slot\./)
  assert.deepEqual(pg.posts, [], 'nothing is sent before it is confirmed')
  await pg.click('Start now')
  assert.deepEqual(pg.posts, [['/jev-router/tasks/start-now', { key: 'k1' }]])
  assert.equal(dialogOf(pg), undefined, 'the dialog has closed')
  await pg.click('Steer jev-3')
  assert.match(textOf(dialogOf(pg)), /^Steer jev-3Your words are added to the task before it starts\. It keeps its place in line\./)
  pg.close()
  const run = await page('LivePane', opened, { tasks: [{ ...TASK, activity: summary() }], live: () => answer(3, { items: [] }) })
  assert.equal(run.button('Send jev-3 now'), undefined, 'a task at work has nothing to send now')
  assert.equal(textOf(run.button('Steer jev-3')), 'Steer…')
  await run.click('Steer jev-3')
  // Since slice 8 its words go to it as it works, too.
  assert.match(textOf(dialogOf(run)), /^Steer jev-3Your words go to jev-3 while it works, or with its next attempt\./)
  assert.deepEqual(['Now, while it works', 'Follow-up after it', 'Stop and start again'].map((l) => !!run.button(l)), [true, true, true], 'its words go to it now, as a follow-up task or with a fresh start')
  run.close()
})

// ---------- the work board and the Tasks tab ----------

test('the work board shows what a running task does under its row, with a dot that pulses while its newest step is fresh, and a waiting row keeps its wait words', async () => {
  const running = { ...TASK, activity: { phrase: 'Running a command: npm test', tools: 14, tokens: 18_200, rate: 31, lastActivityAt: Date.now() - 1000, lastAgentAt: Date.now() - 1000, agent: 'DeepSeek agent', live: true, open: { since: Date.now() - 1000, command: 'npm test' }, done: null } }
  const waiting = { ...TASK, key: 'k2', jobId: 'jev-4', state: 'queued', taskName: 'Tidy the docs', startedAt: null, queuedAt: Date.now() - 5000, activity: null, waiting: { why: 'workspace', place: 2, ahead: 0, since: Date.now() - 5000, placeText: '2nd in line', text: 'Waiting: another task is running in this workspace.' } }
  const pg = await page('WorkBoard', { session: { sessionId: 's1' } }, { tasks: [running, waiting], sidebar: true })
  const line = pg.all().find((x) => x.props?.className === 'kzh-wb-act')
  assert.ok(line, 'a running row has its second line')
  assert.match(textOf(line), /^Running a command: npm test · 14 tool calls · 18\.2k tokens · \d+ tokens\/s · \d+ s ago$/)
  assert.match(line.props['aria-label'], /^Watch Fix the parser live: Running a command: npm test/)
  assert.ok(nodes(line).some((x) => x.props?.className === 'kzh-dot fresh'), 'the dot pulses: its newest step is under 5 s old')
  assert.equal(pg.all().filter((x) => x.props?.className === 'kzh-wb-act').length, 1, 'the waiting row has none')
  assert.match(pg.text(), /Waiting: another task is running in this workspace\./)
  // A click on the row opens the Live tab on its task, except one on its Stop; its second line opens it too.
  const row = pg.all().find((x) => x.props?.className === 'kzh-wb-row live go')
  row.props.onClick({ target: { closest: () => null } })
  assert.deepEqual(pg.opened, [['jev-live', { params: { task: 'k1' } }]], 'the row opens the Live tab on its task')
  row.props.onClick({ target: { closest: (s) => (s === 'button' ? {} : null) } })
  assert.equal(pg.opened.length, 1, 'a click on its Stop opens nothing')
  line.props.onClick({ target: {} })
  assert.deepEqual(pg.opened, [['jev-live', { params: { task: 'k1' } }], ['jev-live', { params: { task: 'k1' } }]], 'and its second line opens it, from the keyboard too')
  pg.close()
})

test('a running task\'s row in the Tasks tab shows its last six live steps and Open live view, and a finished one its report', () => {
  const t = helpers()
  assert.equal(typeof t.liveTail, 'function', 'client.js has the Tasks tab\'s live tail')
  const recent = Array.from({ length: 7 }, (_, i) => ({ kind: 'tool', title: `Read f${i}.txt`, state: i === 6 ? 'running' : 'done' }))
  const running = { ...TASK, activity: { ...summary(), recent } }
  const finished = { ...TASK, key: 'k0', jobId: 'jev-1', state: 'completed', reportAvailable: true, activity: { ...summary(), done: { status: 'accepted', label: 'Completed', ms: 1 }, recent } }
  const items = t.taskItems({ sessionId: 's1', runs: [], jobs: [], entries: [], tasks: [running, finished], open: new Set(['tjev-1']), now: NOW })
  const body = (jobId) => items.find((x) => x.key === `t${jobId}`).body
  const tail = textOf(body('jev-3'))
  assert.match(tail, /Read f1\.txt[\s\S]*Read f6\.txt/)
  assert.doesNotMatch(tail, /Read f0\.txt/, 'six, the newest')
  assert.match(tail, /Open live view$/)
  assert.equal(body('jev-1').type.name, 'TaskReport', 'a finished task shows its report')
})

// ---------- the card under a start reply ----------

test('the card under a start reply renders only for a message with a [jev-job] mark, says Starting Claude Code... before the first step, shows the last eight tool calls, and how it went once done', async () => {
  const chat = (text) => (sel) => sel({ legacy: { nodes: [{ kind: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text }] }] } })
  const reply = 'OK, I\'ll run Claude Code on it.\n\n[jev-job]: kzh-job-1-k1'
  const claude = { ...TASK, agent: 'claude', activity: { phrase: 'Starting Claude Code...', agent: 'Claude Code', model: 'claude-opus-4-1', effort: 'high', tools: 0, tokens: 0, rate: null, elapsedMs: 0, lastActivityAt: NOW, live: false, open: null, done: null, recent: [] } }
  // A message without the mark: nothing, and nothing is read.
  const plain = await page('LiveRunCard', { messageId: 'm1', useChat: chat('Just an answer.') }, { tasks: [claude] })
  assert.equal(plain.tree(), null)
  assert.deepEqual(plain.gets, [])
  plain.close()
  const pg = await page('LiveRunCard', { messageId: 'm1', useChat: chat(reply) }, { tasks: [claude], live: () => answer(3, { attempts: [], items: [] }) })
  assert.match(pg.text(), /Fix the parser/)
  assert.match(pg.text(), /Claude Code · claude-opus-4-1 · effort high/)
  assert.match(pg.text(), /Starting Claude Code\.\.\./)
  assert.ok(pg.button('Open live view'))
  assert.ok(pg.button('Stop'))
  // Ten tool calls in: the last eight.
  const steps = Array.from({ length: 10 }, (_, i) => item(`a0:call:c${i}`, i + 1, 10 + i, { kind: 'tool', title: `Read f${i}.txt`, state: 'done' }))
  pg.live = () => answer(20, { items: steps })
  await pg.run(700)
  assert.match(pg.text(), /Read f2\.txt[\s\S]*Read f9\.txt/)
  assert.doesNotMatch(pg.text(), /Read f1\.txt/)
  // Done: how it went, and no Stop. The task ended with a tool call made after the card's last read
  // of its steps: the card reads them once more, for the last of them, and then no more.
  pg.tasks = [{ ...claude, state: 'completed', activity: { ...claude.activity, tools: 23, tokens: 41_000, done: { status: 'accepted', label: 'Completed', ms: 432_000 } } }]
  pg.live = () => answer(21, { items: [item('a0:call:c10', 11, 21, { kind: 'tool', title: 'Write notes.md', state: 'done' })] }, { done: true })
  await pg.run(1000)
  await pg.run(700)
  assert.match(pg.text(), /Done in 7m 12s · 23 tool calls · 41k tokens/)
  assert.equal(pg.button('Stop'), undefined)
  assert.match(pg.text(), /Read f3\.txt[\s\S]*Read f9\.txt[\s\S]*Write notes\.md/, 'the last of its steps, read once more after it ended')
  assert.doesNotMatch(pg.text(), /Read f2\.txt/)
  const reads = pg.liveGets().length
  await pg.run(700)
  assert.equal(pg.liveGets().length, reads, 'and no more once the view says it is done')
  pg.close()
})

test('the card under a start reply leaves out a step the store hid: its last eight tool calls are the newest the timeline shows', async () => {
  const chat = (text) => (sel) => sel({ legacy: { nodes: [{ kind: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text }] }] } })
  const steps = Array.from({ length: 9 }, (_, i) => item(`a0:call:c${i}`, i < 8 ? i + 1 : 10, 10 + i, { kind: 'tool', title: `Read f${i}.txt`, state: 'done' }))
  // A call streamed in a model call that failed, among the newest: it never ran.
  const unrun = item('a0:call:x', 9, 30, { kind: 'command', title: 'Running npm test', state: 'failed', meta: { hidden: true } })
  const pg = await page('LiveRunCard', { messageId: 'm1', useChat: chat('OK.\n\n[jev-job]: kzh-job-1-k1') }, { tasks: [{ ...TASK, activity: summary() }], live: () => answer(30, { items: [...steps, unrun] }) })
  assert.doesNotMatch(pg.text(), /Running npm test/, 'the call that never ran')
  assert.match(pg.text(), /Read f1\.txt[\s\S]*Read f8\.txt/, 'the newest eight it shows')
  assert.doesNotMatch(pg.text(), /Read f0\.txt/)
  pg.close()
})

test('the card\'s Remove, still open as its task starts, removes nothing and stops nothing: the dialog closes and says why, as the work board\'s does', async () => {
  const chat = (text) => (sel) => sel({ legacy: { nodes: [{ kind: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text }] }] } })
  const waiting = { ...TASK, state: 'queued', startedAt: null, queuedAt: NOW - 5000, waiting: { why: 'workspace', place: 2, ahead: 0, since: NOW - 5000, placeText: '2nd in line', text: 'Waiting: another task is running in this workspace.' } }
  const pg = await page('LiveRunCard', { messageId: 'm1', useChat: chat('OK, jev-3 is queued.\n\n[jev-job]: kzh-job-1-k1') }, { tasks: [waiting] })
  await pg.click('Remove')
  assert.ok(pg.button('Remove task'), 'it asks before taking the task out of the line')
  // The task starts while the dialog is open, and the card reads the list again.
  pg.tasks = [{ ...TASK, activity: summary() }]
  await pg.run(1000)
  assert.equal(pg.button('Stop task'), undefined, 'the dialog never turns into one that stops it')
  assert.equal(pg.button('Remove task'), undefined, 'it has closed')
  assert.deepEqual(pg.posts, [])
  assert.match(pg.text(), /"Fix the parser" started while you were confirming, so it was not removed\. Use Stop on its row to stop it\./)
  pg.close()
})

test('the card under a start reply offers Send now… and Steer… while its task waits and only Steer… once it is at work, each named by its task and each opening its dialog', async () => {
  const chat = (text) => (sel) => sel({ legacy: { nodes: [{ kind: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text }] }] } })
  const reply = chat('OK, jev-3 is queued.\n\n[jev-job]: kzh-job-1-k1')
  const pg = await page('LiveRunCard', { messageId: 'm1', useChat: reply }, { tasks: [WAITING] })
  assert.equal(textOf(pg.button('Send jev-3 now')), 'Send now…')
  assert.equal(textOf(pg.button('Steer jev-3')), 'Steer…')
  await pg.click('Send jev-3 now')
  assert.match(textOf(dialogOf(pg)), /^Start jev-3 now\?It runs beside 1 other task, over your limit of 1 task at once/)
  await pg.click('Cancel')
  assert.equal(dialogOf(pg), undefined, 'Cancel closes it')
  await pg.click('Steer jev-3')
  assert.match(textOf(dialogOf(pg)), /^Steer jev-3Your words are added to the task before it starts\./)
  pg.all().find((n) => n.type === 'textarea').props.onChange({ target: { value: 'Also update the README.' } })
  await pg.settle()
  await pg.click('Add to task')
  assert.deepEqual(pg.posts, [['/jev-router/tasks/steer', { key: 'k1', text: 'Also update the README.', how: 'amend' }]])
  pg.close()
  const run = await page('LiveRunCard', { messageId: 'm1', useChat: reply }, { tasks: [{ ...TASK, activity: summary() }], live: () => answer(3, { items: [] }) })
  assert.equal(run.button('Send jev-3 now'), undefined, 'a task at work has nothing to send now')
  assert.equal(textOf(run.button('Steer jev-3')), 'Steer…')
  await run.click('Steer jev-3')
  assert.deepEqual(['Follow-up after it', 'Stop and start again'].map((l) => !!run.button(l)), [true, true], 'its words go as a follow-up task or with a fresh start')
  run.close()
})

test('a reply with no [jev-job] mark is kept out of the shared task list: as the list is read each second, only a card with a task renders again', async () => {
  const chat = (text) => (sel) => sel({ legacy: { nodes: [{ kind: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text }] }] } })
  // A card with a running task holds the shared reader; a card under a plain reply on the same page does not hear it.
  const pg = await page('LiveRunCard', { messageId: 'm1', useChat: chat('OK.\n\n[jev-job]: kzh-job-1-k1') }, { tasks: [{ ...TASK, activity: summary() }], live: () => answer(3, { items: [] }) })
  const plain = pg.mount('LiveRunCard', { messageId: 'm1', useChat: chat('Just an answer.') })
  assert.equal(plain.tree(), null)
  const before = pg.renders()
  for (let i = 0; i < 3; i++) await pg.run(1000)
  assert.ok(pg.renders() > before, 'the list was read, and the card with a task heard it')
  assert.equal(plain.renders(), 1, 'the plain card rendered once and heard none of it')
  plain.close()
  pg.close()
})

test('the Live tab says what Codex and Claude Code share of their thinking while their detail is live through the engine patch, and why it is off when it is not', () => {
  const t = helpers()
  const view = (...attempts) => ({ ...answer(1, { items: [] }), runs: [{ ...answer(1, { items: [] }).runs[0], attempts }] })
  const codex = { ...ATTEMPT, index: 0, agent: 'codex', name: 'Codex', provider: 'codex', child: null }
  const claude = { ...ATTEMPT, index: 1, agent: 'claude', name: 'Claude Code', provider: 'claude-code', child: null }
  assert.deepEqual(t.liveNotes(view(codex, claude)), [
    'Codex shares its reasoning as short summaries.',
    'Claude Code shows thinking only when Claude shares it; text and tool calls always show.',
  ])
  assert.deepEqual(t.liveNotes(view({ ...codex, detail: 'off', why: 'dsh-subagent-codex 0.1.6 is installed, and this patch was written for 0.1.5-rc.2' })), [
    'Live detail for Codex is off: dsh-subagent-codex 0.1.6 is installed, and this patch was written for 0.1.5-rc.2. You still see the router\'s steps, and the result posts as usual.',
  ], 'off, it says why, and nothing of what it would share')
  assert.deepEqual(t.liveNotes(view(ATTEMPT)), [], 'a spawn agent\'s thinking needs no note')
})

// ---------- Steer on a task at work (docs/live-agent-view.md Feature 5, slice 8) ----------

/** TASK at work on a spawn agent, with what Steer does now with words for it (tasks.js view().controls.steer). */
const STEERING = { ...TASK, activity: summary(), controls: { sendNow: null, steer: { path: 'spawn', why: null, agent: 'deepseek', name: 'DeepSeek agent', sendable: true, words: 'DeepSeek agent takes this in at its next step.' } } }
const CLAUDE_OFF = 'Claude Code can\'t take messages mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code"). It goes to the next attempt if there is one.'
const onClaude = { ...STEERING, controls: { sendNow: null, steer: { path: null, why: 'claude-off', agent: 'claude', name: 'Claude Code', sendable: false, words: CLAUDE_OFF } } }
const openedOn = { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true, navigation: { revision: 1, params: { task: 'k1' } } } }) }

test('the Live tab\'s box under a task at work: Enter gives it the words, how auto, and says what came of them, Shift+Enter starts a new line; a waiting task\'s box adds to it before it starts; past an agent that cannot take words the box is off and says why', async () => {
  const pg = await page('LivePane', openedOn, { tasks: [STEERING], live: () => answer(3, { items: [] }) })
  const box = () => pg.all().find((n) => n.type === 'textarea')
  assert.equal(box()?.props.placeholder, 'Steer jev-3: tell DeepSeek agent something while it works')
  box().props.onChange({ target: { value: 'use tabs' } })
  await pg.settle()
  let prevented = 0
  box().props.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault: () => { prevented++ } })
  await pg.settle()
  assert.deepEqual([pg.posts, prevented], [[], 0], 'Shift+Enter starts a new line')
  pg.answers['/jev-router/tasks/steer'] = { result: 'sent', state: 'pending', id: 'g1', words: 'Sent to jev-3: DeepSeek agent takes it in at its next step.' }
  box().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => { prevented++ } })
  await pg.settle()
  assert.deepEqual(pg.posts, [['/jev-router/tasks/steer', { key: 'k1', text: 'use tabs', how: 'auto' }]])
  assert.deepEqual([box().props.value, prevented], ['', 1], 'sent, the box empties')
  assert.match(pg.text(), /Sent to jev-3: DeepSeek agent takes it in at its next step\./)
  pg.close()
  const wait = await page('LivePane', openedOn, { tasks: [WAITING] })
  assert.equal(wait.all().find((n) => n.type === 'textarea')?.props.placeholder, 'Add to jev-3 before it starts')
  wait.close()
  const claude = await page('LivePane', openedOn, { tasks: [onClaude], live: () => answer(3, { items: [] }) })
  const off = claude.all().find((n) => n.type === 'textarea')
  assert.deepEqual([off?.props.placeholder, off?.props.disabled], [CLAUDE_OFF, true])
  claude.close()
})

test('the Live tab\'s box is its task\'s own: turned to another task, it holds none of the words typed for the one before, nor what came of those sent', async () => {
  let at = NOW
  let nav = { revision: 1, params: { task: 'k1' } }
  const other = { ...STEERING, key: 'k2', jobId: 'jev-4', taskName: 'Fix the lexer', taskText: 'Fix the lexer', runIds: ['run-2'] }
  const pg = await page('LivePane', { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true, navigation: nav } }) }, { tasks: [STEERING, other], live: () => answer(3, { items: [] }), now: () => at })
  const box = () => pg.all().find((n) => n.type === 'textarea')
  assert.equal(box()?.props.placeholder, 'Steer jev-3: tell DeepSeek agent something while it works')
  box().props.onChange({ target: { value: 'use tabs' } })
  await pg.settle()
  pg.answers['/jev-router/tasks/steer'] = { result: 'sent', state: 'pending', id: 'g1', words: 'Sent to jev-3: DeepSeek agent takes it in at its next step.' }
  box().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await pg.settle()
  assert.match(pg.text(), /Sent to jev-3: DeepSeek agent takes it in at its next step\./)
  box().props.onChange({ target: { value: 'and the half of a thought' } })
  await pg.settle()
  assert.equal(box().props.value, 'and the half of a thought')
  // Open live view on jev-4's card in the chat turns the tab to it.
  nav = { revision: 2, params: { task: 'k2' } }
  at += 1000
  await pg.tick(1000)
  assert.equal(box()?.props.placeholder, 'Steer jev-4: tell DeepSeek agent something while it works')
  assert.equal(box().props.value, '', 'the words typed for jev-3 are not in jev-4\'s box')
  assert.doesNotMatch(pg.text(), /Sent to jev-3/)
  box().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await pg.settle()
  assert.deepEqual(pg.posts, [['/jev-router/tasks/steer', { key: 'k1', text: 'use tabs', how: 'auto' }]], 'nothing goes to jev-4')
  pg.close()
})

test('a steer bubble in the Live tab says what became of the words as its task\'s row has it now, else as the live view heard it, and words its task ended without offer Copy and Send as a follow-up', async () => {
  const bubble = item('steer:g1', 3, 3, { kind: 'steer', router: true, title: 'You: use tabs', text: 'use tabs', state: 'done', meta: { steer: 'g1', state: 'pending', words: 'Waiting for its next step' } })
  const heard = await page('LivePane', openedOn, { tasks: [STEERING], live: () => answer(3, { items: [bubble] }) })
  assert.equal(textOf(heard.all().find((n) => n.props.className === 'kzh-live-you')), 'You: use tabsWaiting for its next step')
  heard.close()
  const ended = { ...STEERING, steers: [{ id: 'g1', how: 'live', text: 'use tabs', state: 'returned', words: 'Not used: DeepSeek agent finished first' }] }
  const pg = await page('LivePane', openedOn, { tasks: [ended], live: () => answer(3, { items: [bubble] }) })
  assert.equal(textOf(pg.all().find((n) => n.props.className === 'kzh-live-you')), 'You: use tabsNot used: DeepSeek agent finished firstCopySend as a follow-up')
  pg.answers['/jev-router/tasks/steer'] = { result: 'queued', state: null, jobId: 'jev-4', words: 'Queued jev-4 as a follow-up to jev-3, in kz-harness, starting now, on DeepSeek agent.' }
  await pg.click('Send as a follow-up')
  assert.deepEqual(pg.posts, [['/jev-router/tasks/steer', { key: 'k1', text: 'use tabs', how: 'follow-up' }]])
  pg.close()
})

test('the Steer dialog of a task at work: Now, while it works gives the words to the agent at work, how live, and so does Enter in its box; past an agent that cannot take them it is off, and the dialog says why', async () => {
  const codex = { ...STEERING, controls: { sendNow: null, steer: { path: 'codex', why: null, agent: 'codex', name: 'Codex', sendable: true, words: 'Codex takes this in at its next step.' } } }
  const pg = await page('LivePane', openedOn, { tasks: [codex], live: () => answer(3, { items: [] }) })
  await pg.click('Steer jev-3')
  assert.match(textOf(dialogOf(pg)), /^Steer jev-3Codex takes this in at its next step\.Or send them as a follow-up task that runs after it/)
  const box = () => nodes(dialogOf(pg)).find((n) => n.type === 'textarea')
  assert.equal(pg.button('Now, while it works')?.props.disabled, true, 'no words yet')
  box().props.onChange({ target: { value: 'run the linter' } })
  await pg.settle()
  pg.answers['/jev-router/tasks/steer'] = { result: 'sent', state: 'pending', id: 'g2', words: 'Sent to jev-3: Codex takes it in at its next step.' }
  await pg.click('Now, while it works')
  assert.deepEqual(pg.posts, [['/jev-router/tasks/steer', { key: 'k1', text: 'run the linter', how: 'live' }]])
  assert.equal(dialogOf(pg), undefined, 'the dialog closed')
  await pg.click('Steer jev-3')
  box().props.onChange({ target: { value: 'and the docs' } })
  await pg.settle()
  box().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await pg.settle()
  assert.deepEqual(pg.posts.at(-1), ['/jev-router/tasks/steer', { key: 'k1', text: 'and the docs', how: 'live' }])
  pg.close()
  const claude = await page('LivePane', openedOn, { tasks: [onClaude], live: () => answer(3, { items: [] }) })
  await claude.click('Steer jev-3')
  nodes(dialogOf(claude)).find((n) => n.type === 'textarea').props.onChange({ target: { value: 'use tabs' } })
  await claude.settle()
  assert.ok(textOf(dialogOf(claude)).startsWith(`Steer jev-3${CLAUDE_OFF}`), textOf(dialogOf(claude)))
  assert.deepEqual(['Now, while it works', 'Follow-up after it', 'Stop and start again'].map((l) => claude.button(l)?.props.disabled), [true, false, false])
  claude.close()
})

test('the card under a start reply lists the guidance its task was given, with what became of each piece', async () => {
  const steered = { ...STEERING, steers: [{ id: 'g1', how: 'live', text: 'use tabs', state: 'delivered', words: 'Read by DeepSeek agent at 14:02' }] }
  const chat = (text) => (sel) => sel({ legacy: { nodes: [{ kind: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text }] }] } })
  const pg = await page('LiveRunCard', { messageId: 'm1', useChat: chat('OK, jev-3 started.\n\n[jev-job]: kzh-job-1-k1') }, { tasks: [steered], live: () => answer(3, { items: [] }) })
  const list = pg.all().find((n) => n.props.role === 'list' && n.props['aria-label'] === 'Your guidance for jev-3')
  assert.equal(textOf(list), 'You: use tabsRead by DeepSeek agent at 14:02')
  pg.close()
})

test('a task\'s row in the Tasks tab lists its guidance below what the row shows, a running one\'s tail and a finished one\'s report alike, and a row with none is as it was', () => {
  const t = helpers()
  assert.equal(typeof t.GuidanceList, 'function', 'a task\'s row lists its guidance')
  const steers = [{ id: 'g1', how: 'live', text: 'use tabs', state: 'delivered', words: 'Read by DeepSeek agent at 14:02' }, { id: 'g2', how: 'live', text: 'run the linter', state: 'returned', words: 'Not used: DeepSeek agent finished first' }]
  const running = { ...TASK, steers, activity: { ...summary(), recent: [{ kind: 'tool', title: 'Read f.txt', state: 'done' }] } }
  const finished = { ...TASK, key: 'k0', jobId: 'jev-1', state: 'completed', reportAvailable: true, steers }
  const plain = { ...TASK, key: 'k9', jobId: 'jev-9', activity: { ...summary(), recent: [] } }
  const items = t.taskItems({ sessionId: 's1', runs: [], jobs: [], entries: [], tasks: [running, finished, plain], open: new Set(['tjev-1']), now: NOW })
  const body = (jobId) => items.find((x) => x.key === `t${jobId}`).body
  for (const id of ['jev-3', 'jev-1']) {
    const [shown, list] = body(id).children
    assert.equal(list?.type, t.GuidanceList, id)
    const rendered = list.type(list.props)
    assert.equal(rendered.props['aria-label'], `Your guidance for ${id}`)
    assert.deepEqual(rendered.children.map((row) => textOf(row.children.slice(0, 2))), ['You: use tabsRead by DeepSeek agent at 14:02', 'You: run the linterNot used: DeepSeek agent finished first'])
    assert.deepEqual(rendered.children.map((row) => !!row.children[2]), [false, true], 'Copy and Send as a follow-up only for words its task ended without')
    if (id === 'jev-1') assert.equal(shown.type.name, 'TaskReport')
  }
  assert.equal(body('jev-9').props.className, 'kzh-live-tail', 'with no guidance the row shows what it showed before')
})

// ---------- Send now into a running agent (docs/live-agent-view.md Feature 5, slice 10) ----------

test('the Steer dialog of a task at work offers Send now where its agent can be stopped, and Ctrl+Enter in its box: confirmed, it sends the words how now; past an agent that cannot be stopped Send now is off and the dialog says why, as it does when nothing could be stopped after all', async () => {
  const stoppable = { ...STEERING, controls: { sendNow: null, steer: { ...STEERING.controls.steer, now: { path: 'spawn', why: null, words: 'Send now stops DeepSeek agent\'s current step and gives it your words at once.' } } } }
  const pg = await page('LivePane', openedOn, { tasks: [stoppable], live: () => answer(3, { items: [] }) })
  await pg.click('Steer jev-3')
  const box = () => nodes(dialogOf(pg)).find((n) => n.type === 'textarea')
  assert.equal(pg.button('Send now')?.props.disabled, true, 'no words yet')
  box().props.onChange({ target: { value: 'stop and fix the lexer first' } })
  await pg.settle()
  assert.deepEqual([pg.button('Send now')?.props.disabled, pg.button('Send now')?.props.title], [false, 'Send now stops DeepSeek agent\'s current step and gives it your words at once.'])
  assert.deepEqual(nodes(dialogOf(pg)).filter((n) => n.type === 'button').map(textOf), ['Cancel', 'Now, while it works', 'Send now', 'Follow-up after it', 'Stop and start again'])
  await pg.click('Send now')
  assert.equal(textOf(dialogOf(pg)), 'Send now to jev-3?Stop the current step and give it this now? Work already done stays in the folder.CancelSend now')
  assert.deepEqual(pg.posts, [], 'nothing is sent before it is confirmed')
  pg.answers['/jev-router/tasks/steer'] = { result: 'replaced', state: 'pending', id: 'n1', words: 'Sent to jev-3 now: DeepSeek agent stops what it is doing and starts on your words.' }
  await pg.click('Send now')
  assert.deepEqual(pg.posts, [['/jev-router/tasks/steer', { key: 'k1', text: 'stop and fix the lexer first', how: 'now' }]])
  assert.equal(dialogOf(pg), undefined, 'the dialog closed')
  // Ctrl+Enter in the box asks the same; Cancel goes back to the words.
  await pg.click('Steer jev-3')
  box().props.onChange({ target: { value: 'and the docs' } })
  await pg.settle()
  let prevented = 0
  box().props.onKeyDown({ key: 'Enter', ctrlKey: true, shiftKey: false, preventDefault: () => { prevented++ } })
  await pg.settle()
  assert.deepEqual([textOf(dialogOf(pg)).startsWith('Send now to jev-3?'), prevented, pg.posts.length], [true, 1, 1])
  await pg.click('Cancel')
  assert.equal(box()?.props.value, 'and the docs', 'back to the words, kept')
  // Nothing could be stopped after all (its agent ended between two reads): the words stay, and the dialog says why.
  pg.answers['/jev-router/tasks/steer'] = { result: 'not-now', state: null, words: 'Send now has nothing to stop while jev-3 runs its checks.' }
  box().props.onKeyDown({ key: 'Enter', ctrlKey: true, shiftKey: false, preventDefault() {} })
  await pg.settle()
  await pg.click('Send now')
  assert.deepEqual(pg.posts.at(-1), ['/jev-router/tasks/steer', { key: 'k1', text: 'and the docs', how: 'now' }])
  assert.equal(box()?.props.value, 'and the docs')
  assert.match(textOf(dialogOf(pg)), /Send now has nothing to stop while jev-3 runs its checks\./)
  pg.close()
  // Claude Code with the switch off: Send now is off, and the dialog says why.
  const offNow = 'Send now can\'t stop Claude Code mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code").'
  const claudeTask = { ...onClaude, controls: { sendNow: null, steer: { ...onClaude.controls.steer, now: { path: null, why: 'claude-off', words: offNow } } } }
  const claude = await page('LivePane', openedOn, { tasks: [claudeTask], live: () => answer(3, { items: [] }) })
  await claude.click('Steer jev-3')
  nodes(dialogOf(claude)).find((n) => n.type === 'textarea').props.onChange({ target: { value: 'use tabs' } })
  await claude.settle()
  assert.equal(claude.button('Send now')?.props.disabled, true)
  assert.ok(textOf(dialogOf(claude)).startsWith(`Steer jev-3${CLAUDE_OFF}${offNow}Or send them`), textOf(dialogOf(claude)))
  nodes(dialogOf(claude)).find((n) => n.type === 'textarea').props.onKeyDown({ key: 'Enter', ctrlKey: true, shiftKey: false, preventDefault() {} })
  await claude.settle()
  assert.ok(textOf(dialogOf(claude)).startsWith('Steer jev-3'), 'Ctrl+Enter asks nothing where nothing can be stopped')
  assert.deepEqual(claude.posts, [])
  claude.close()
})

test('a turn Send now replaced reads Replaced by your message in the Live tab, never as a stopped or failed call, while a call stopped for any other reason still says so', async () => {
  const { createLiveStore } = await import('../live.js')
  const store = createLiveStore({ now: () => NOW })
  store.open('run-1', { taskKey: 'k1', sessionId: 's1', decider: 'jev' })
  store.describe('run-1', { names: { deepseek: 'DeepSeek agent' } })
  store.router('run-1', { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary', effort: 'high' })
  const h = store.attempt('run-1', 0)
  h.started({ provider: 'spawn', model: 'deepseek-flash', detail: 'live', child: { id: 'child-1', label: 'jev:deepseek' } })
  const call = (id, turn) => {
    h.frame({ type: 'start', attemptId: id, revision: 1, turn, step: 1 })
    h.frame({ type: 'chunk', attemptId: id, revision: 1, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    h.frame({ type: 'chunk', attemptId: id, revision: 1, index: 1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Rewriting the parser' } })
  }
  const stopped = (id, turn, seq) => {
    h.frame({ type: 'chunk', attemptId: id, revision: 1, index: 2, time: 0, chunk: { type: 'finish', reason: { kind: 'aborted' } } })
    h.frame({ type: 'end', attemptId: id, revision: 1, index: 3, outcome: { kind: 'abandoned' } })
    h.events([{ seq, time: 0, type: 'turn/end', data: { turn, reason: { kind: 'aborted', reason: { kind: 'parent' } } } }])
  }
  call('llm-1', 1)
  // Send now: said before the step is stopped, so the step it ends is read as replaced.
  store.router('run-1', { type: 'steer', id: 'n1', guidance: 'stop and fix the lexer first', state: 'pending', how: 'now', replacing: true, attempt: 0, name: 'DeepSeek agent', words: 'Waiting for its next step' })
  stopped('llm-1', 1, 0)
  // A later call stopped for another reason (the run's Stop) still says so.
  call('llm-2', 2)
  stopped('llm-2', 2, 1)
  const items = store.read('run-1').items
  const pg = await page('LivePane', openedOn, { tasks: [STEERING], live: () => answer(3, { items }) })
  const text = pg.text()
  assert.equal(text.split('Replaced by your message').length - 1, 1, text)
  assert.ok(text.indexOf('You: stop and fix the lexer first') < text.indexOf('Replaced by your message'), 'the words, then the step they replaced')
  assert.equal(text.split('The model call was stopped').length - 1, 1, 'only the call stopped for another reason')
  assert.doesNotMatch(text, /Interrupted/)
  pg.close()
})
