// The Router tab's words for how far a routing domain has matured. client.js is a classic browser
// script - window.__ModuleLoader__.load({ id, factory }) - so the real file body runs as a
// function of `window`, its factory gets a fake `react`, and the pure helpers come back as
// `__test` (the same loader test/overview.test.js uses). The states it reads are the ones a real
// domain registry reports, which is what index.js hands the tab.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDomainRegistry } from '../domains.js'
import { MATURITY, resolvePolicy } from '../routing-policy.js'
import { createTrainingStore } from '../training.js'

function loadPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

const { maturityWords } = loadPlugin().__test

test('the Router tab never says the local router decides a domain whose classifier never decides, nor Jev one a rule decides', () => {
  const root = mkdtempSync(join(tmpdir(), 'kz-routerview-'))
  const reg = createDomainRegistry({ policy: resolvePolicy(), store: createTrainingStore({ file: join(root, 'samples.jsonl') }), artifactsDir: join(root, 'classifiers'), stateDir: root })
  const states = reg.states()
  // The resource ranking's classifier climbs the ladder like any other, because its standing is
  // still measured, but no rung lets it decide: the ranking makes the pick (decision.js). The words
  // for a rung would say otherwise, at LOCAL_ONLY most of all.
  for (const maturity of MATURITY) {
    const words = maturityWords({ ...states.resource_selection, maturity })
    assert.match(words, /a rule in code decides/, maturity)
    assert.doesNotMatch(words, /local router decides|Jev decides/, maturity)
  }
  // The frontier review asks Jev nothing: a rule in code decides it wherever its classifier does
  // not, so no rung may say Jev decides, and the local rungs still say the classifier decides.
  assert.equal(states.frontier_escalation.teacher, 'code', 'the domain says so in its state')
  for (const maturity of MATURITY) {
    const words = maturityWords({ ...states.frontier_escalation, maturity })
    assert.ok(words, maturity)
    assert.doesNotMatch(words, /Jev/, maturity)
    if (maturity === 'GUARDED_LOCAL' || maturity === 'LOCAL_ONLY') assert.match(words, /^the local router decides/, maturity)
    else assert.match(words, /a rule in code decides/, maturity)
  }
  // A policy may take a Jev-taught domain's local authority away: then Jev decides at every rung,
  // and the words say so rather than naming a rule in code that does not exist for it.
  const barred = maturityWords({ ...states.task_classification, localDecides: false, maturity: 'LOCAL_ONLY' })
  assert.match(barred, /^Jev decides at every rung; the local router is recorded beside it for comparison and never decides$/)
  // A domain whose classifier may decide keeps the words for its rung.
  assert.equal(maturityWords({ ...states.task_classification, maturity: 'LOCAL_ONLY' }), 'the local router decides normal cases with no Jev call')
  assert.equal(maturityWords(states.task_classification), 'Jev decides; the local router is not trained yet')
})

// ---------- Jev and Laya, side by side (docs/laya-auto.md 5.6, 8.4) ----------

// The same client, with a React whose createElement records what it was asked for, so the card
// can be read as the person reads it; `expand` calls the components in the tree in place.
function renderPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const React = { createElement, Fragment: 'fragment', useState: (v) => [v, () => {}], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return { src, ...registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test }
}
const expand = (n) => (!n || typeof n !== 'object' ? n : typeof n.type === 'function' ? expand(n.type({ ...n.props, children: n.children })) : { ...n, children: n.children.map(expand) })
const nodes = (n) => (n && typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [])
const textOf = (n) => (n == null || n === false ? '' : typeof n !== 'object' ? String(n) : n.children.map(textOf).join(''))

// The comparison as GET /jev-router/laya/compare answers it (8.4): every figure a count, and a
// source with no rows `{ n: 0 }`, never a rate.
const COMPARE = {
  identity: `laya-0.3.20|english|1a2b3c4d5e6f|adapter-1|corr:choice:11+=3.27|margin:0.1`,
  thresholds: { jev: 'a1b2c3d4e5f6', laya: '0f1e2d3c4b5a' }, jevHost: 'api.typesafe.ai', days: 7,
  questions: [
    { name: 'taskType', type: 'choice', options: 12, corrected: 40, compared: 41, agree: { all: { n: 41, agree: 22 }, informative: { n: 30, agree: 19 } }, inTopTwo: 33, meanDifference: null, atBar: null, flat: 11, layaMedianMs: 950 },
    { name: 'alsoWork', type: 'noul', options: 2, corrected: 0, compared: 12, agree: { all: { n: 12, agree: 9 }, informative: { n: 0, agree: 0 } }, inTopTwo: null, meanDifference: 0.12, atBar: { n: 12, agree: 10 }, flat: 12, layaMedianMs: 300 },
  ],
  domains: [
    { domain: 'task_classification', question: 'taskType', layaAnswered: 41, agree: { all: { n: 41, agree: 22 }, informative: { n: 30, agree: 19 } }, personSaid: { n: 4, jevRight: 3, layaRight: 2 }, whereJevWasContradicted: { n: 3, layaRight: 1 }, layaAutoRuns: { runs: 12, failed: null }, fieldAgreement: { risk: 0.64 } },
    { domain: 'execution_strategy', question: 'strategy', layaAnswered: 40, agree: { all: { n: 40, agree: 30 }, informative: { n: 20, agree: 16 } }, personSaid: { n: 0 }, whereJevWasContradicted: { n: 0 }, layaAutoRuns: { runs: 12, failed: 2 }, fieldAgreement: null },
    { domain: 'second_opinion', question: 'secondOpinion', layaAnswered: 0, agree: { all: { n: 0, agree: 0 }, informative: { n: 0, agree: 0 } }, personSaid: { n: 0 }, whereJevWasContradicted: { n: 0 }, layaAutoRuns: { runs: 0 }, fieldAgreement: null },
  ],
  actions: {
    wouldHaveActedSame: [{ what: 'review_action', n: 20, same: 11 }, { what: 'needs_human', n: 0, same: 0 }],
    review: { jev: { accept: 12, second_review: 3, human: 1, retry: 4, belowAcceptBar: 3 }, laya: { accept: 5, second_review: 10, human: 1, retry: 4, belowAcceptBar: 10 } },
  },
  skips: { answered: 120, partial: 2, failed: 1, skipped: { not_running: 3, starting: 1, queue_full: 0, too_old: 0, jev_failed: 1, yielded: 2 }, atContextLimit: 0 },
  latency: { jev: { intent: 110, route: 900, review: 800 }, laya: { intent: 300, route: 950, review: null } },
  standing: [],
}

test('the Router tab\'s side-by-side card reads the comparison by its own names, and says what each column can judge', () => {
  const { LayaCompare } = renderPlugin()
  assert.equal(typeof LayaCompare, 'function', 'client.js has the side-by-side card')
  const card = expand(LayaCompare({ data: COMPARE }))
  const all = nodes(card)
  assert.equal(textOf(all.find((n) => n.props.id === card.props['aria-labelledby'])), 'Jev and Laya, side by side')
  const whys = all.filter((n) => n.props.className === 'why').map(textOf)
  assert.equal(whys[0], 'From the calls Laya answered in the background in Jev Auto, and the runs Laya decided in Laya Auto. Checkpoint english, weights 1a2b3c4, adapter 1. Agreement is not accuracy, and outcomes are counted only where they can judge: see each column.')
  const [domains, questions] = all.filter((n) => n.type === 'table')
  const heads = (t) => nodes(t).filter((n) => n.type === 'th' && n.props.scope === 'col').map(textOf)
  const rows = (t) => nodes(t).filter((n) => n.type === 'tr' && n.children.some((c) => c?.props?.scope === 'row')).map((tr) => tr.children.map(textOf))
  assert.deepEqual(heads(domains), ['Domain', 'Laya answered', 'Agrees with Jev (informative only)', 'A person said (Jev right / Laya right)', "Where Jev's pick was contradicted (Laya had it right)", 'Laya Auto runs that failed'])
  assert.deepEqual(rows(domains), [
    // No outcome of a run can fault a task type: the count is not measured, never 0 failed.
    ['task classification', '41', '19 of 30 (63%)', '3 / 2 of 4', '1 of 3', 'not measured (12 runs)'],
    ['execution strategy', '40', '16 of 20 (80%)', 'none yet', 'none yet', '2 of 12'],
    ['second opinion', '0', 'none yet', 'none yet', 'none yet', 'none yet'],
  ], 'a source with no rows says so, and shows no rate')
  // The sources are kept apart, and each says what it can show.
  assert.ok(whys.some((w) => w.startsWith('A person said: the rows a person labelled, the least biased.') && w.includes("never Laya's accuracy") && w.includes('never an accuracy')))
  assert.ok(whys.some((w) => w.includes('a review counts as failed only when the person disliked what it accepted or another agent\'s review did not accept it, and a task type or a skill is judged only by what a person said, so it is not measured there.')))
  assert.ok(whys.includes('task classification, profile fields that agree with Jev: risk 64.0%'))
  assert.deepEqual(heads(questions), ['Question', 'Compared', 'Agree', 'Agree, informative only', 'Mean difference', 'Laya median ms'])
  assert.deepEqual(rows(questions), [
    ['taskTypeuncalibrated (12 options)', '41', '22 of 41 (54%)', '19 of 30 (63%)', '-', '950 ms'],
    ['alsoWork', '12', '9 of 12 (75%)', 'none yet', '0.12', '300 ms'],
  ])
  assert.ok(nodes(questions).some((n) => n.type === 'span' && n.props.className === 'pill warn' && textOf(n) === 'uncalibrated (12 options)'), 'on the question Laya\'s answers were corrected for, and no other')
  // Would it have acted the same, the review actions each accept bar stopped, the skips and the times.
  assert.ok(whys.includes('Review action: the same in 11 of 20 (55%)'))
  assert.ok(whys.includes('Stop for a person: none compared yet'))
  assert.ok(whys.includes("Review actions, Jev: accept 12, second review 3, human 1, retry 4; 3 stopped under Jev's accept bar"))
  assert.ok(whys.includes("Review actions, Laya: accept 5, second review 10, human 1, retry 4; 10 stopped under Laya's accept bar"))
  assert.ok(whys.includes('Skipped: 3 not running, 1 starting, 0 queue full, 0 waited too long, 2 gave way to a local model, 1 Jev call failed; 1 failed.'))
  assert.ok(whys.includes('Median answer time: Jev intent 110 ms, route 900 ms, review 800 ms; Laya intent 300 ms, route 950 ms, review not measured.'))
  assert.equal(LayaCompare({ data: null }), null, 'nothing to show before the comparison has been read')
})

/**
 * A stand-in React that keeps state across renders for the one component mounted, as
 * laya-card.test.js has it. The components in the tree it renders are left as they are, to be found
 * by their type, and it renders again on the next microtask after a state change, as React batches it.
 */
function statefulReact() {
  let current = null
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const slot = () => { const v = current; return [v, v.i++] }
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
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

test('the Router tab shows the side-by-side card under the routing domains, read from the route of 8.4', async () => {
  const { RouterView, LayaCompare } = renderPlugin()
  assert.equal(typeof RouterView, 'function', 'the Router view can be rendered')
  const data = { enabled: true, learning: true, domains: {}, resources: [], profiles: [] }
  const tree = RouterView({ data, error: '', busy: false, onRefresh() {}, laya: { data: COMPARE, error: '' } })
  const cards = nodes(tree).filter((n) => n.type === LayaCompare)
  assert.equal(cards.length, 1, 'the card is in the view')
  assert.equal(cards[0].props.data, COMPARE)

  // The inspector, behind its routes, with the timers it sets recorded rather than run: the
  // comparison is read only while the Router tab is open, once a minute, and handed to the view.
  const gets = []
  const timers = new Map()
  let ids = 0
  let busy = 0
  const answers = { '/jev-router/laya/compare?days=7&identity=current': COMPARE, '/jev-router/routing': data, '/jev-router/tasks': { tasks: [] }, '/jev-router/setup': { agents: [] } }
  const fetch = async (path) => {
    busy++
    try {
      gets.push(path)
      const text = JSON.stringify(answers[path] ?? (path.startsWith('/jev-router/log?') ? [] : {}))
      return { ok: true, status: 200, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const globals = {
    fetch, document: { hidden: false, getElementById: () => ({}), head: { appendChild() {} } },
    setTimeout: (f, ms) => { timers.set(++ids, { f, ms }); return ids }, clearTimeout: (id) => { timers.delete(id) },
    setInterval: () => 0, clearInterval: () => {},
  }
  const { React, mount } = statefulReact()
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', ...Object.keys(globals), readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window, ...Object.values(globals))
  const plugin = registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
  const view = mount(plugin.InspectorBody, { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }), useSessions: () => undefined })
  const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  await settle()
  const COMPARE_ROUTE = '/jev-router/laya/compare?days=7&identity=current'
  const reads = () => gets.filter((g) => g === COMPARE_ROUTE).length
  const minute = () => [...timers.values()].filter((t) => t.ms === 60_000)
  const wait = async (ms) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.f() } await settle() }
  assert.equal(reads(), 0, 'not while the Decisions tab is open')
  nodes(view.tree).find((n) => n.type === 'button' && n.props.role === 'tab' && textOf(n) === 'Router').props.onClick()
  await settle()
  assert.equal(reads(), 1)
  const shown = nodes(view.tree).find((n) => n.type === plugin.RouterView)
  assert.deepEqual(shown.props.laya, { data: COMPARE, error: '' }, 'the Router view is handed the comparison')
  assert.equal(minute().length, 1, 'and reads it again in a minute')
  await wait(60_000)
  assert.equal(reads(), 2)
  // Another tab: no more reads.
  nodes(view.tree).find((n) => n.type === 'button' && n.props.role === 'tab' && textOf(n) === 'Decisions').props.onClick()
  await settle()
  assert.equal(minute().length, 0)
  view.unmount()
})

test('the Router tab shows no side-by-side card on a PC with nothing to compare, and says why when the comparison could not be read', async () => {
  const { RouterView, LayaCompare } = renderPlugin()
  assert.equal(typeof RouterView, 'function', 'the Router view can be rendered')
  const data = { enabled: true, learning: true, domains: {}, resources: [], profiles: [] }
  // Handed a failure, the view says it where the card would be.
  const failed = RouterView({ data, error: '', busy: false, onRefresh() {}, laya: { data: null, error: 'the comparison worker exited with code 1' } })
  const alert = nodes(failed).find((n) => n.props?.role === 'alert')
  assert.ok(alert, 'the failure is shown')
  assert.equal(textOf(alert), 'The comparison could not be read: the comparison worker exited with code 1')
  assert.ok(nodes(failed).some((n) => n.props?.className === 'label' && textOf(n) === 'Jev and Laya, side by side'), 'where the card would be')
  assert.ok(!nodes(RouterView({ data, error: '', busy: false, onRefresh() {}, laya: { data: null, error: '' } })).some((n) => n.props?.role === 'alert'))

  // The inspector behind its routes: the comparison answers 404 on a PC where Laya cannot be asked
  // and nothing was compared, and 500 when it could not be worked out.
  const mountWith = async (compare) => {
    let busy = 0
    const fetch = async (path) => {
      busy++
      try {
        const [status, body] = path === '/jev-router/laya/compare?days=7&identity=current' ? compare
          : [200, path === '/jev-router/routing' ? data : path === '/jev-router/tasks' ? { tasks: [] } : path === '/jev-router/setup' ? { agents: [] } : path.startsWith('/jev-router/log?') ? [] : {}]
        const text = JSON.stringify(body)
        return { ok: status === 200, status, json: async () => JSON.parse(text) }
      } finally { busy-- }
    }
    const globals = {
      fetch, document: { hidden: false, getElementById: () => ({}), head: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    }
    const { React, mount } = statefulReact()
    let registration
    const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
    new Function('window', ...Object.keys(globals), readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window, ...Object.values(globals))
    const plugin = registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
    const view = mount(plugin.InspectorBody, { sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }), useSessions: () => undefined })
    const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
    await settle()
    nodes(view.tree).find((n) => n.type === 'button' && n.props.role === 'tab' && textOf(n) === 'Router').props.onClick()
    await settle()
    const shown = nodes(view.tree).find((n) => n.type === plugin.RouterView).props.laya
    view.unmount()
    return shown
  }
  assert.deepEqual(await mountWith([404, { error: 'Laya cannot be asked on this PC, and nothing has been compared' }]), { data: null, error: '' }, 'nothing to compare is no failure')
  assert.deepEqual(await mountWith([500, { error: 'the comparison worker exited with code 1' }]), { data: null, error: 'the comparison worker exited with code 1' })
  assert.equal(LayaCompare({ data: null }), null)
})

// ---------- the capability benchmark's card (docs/benchmark.md 3.11) ----------

test('the table rule: sortRows sorts numbers as numbers and text as text, puts a blank last either way and keeps equal rows in their order; filterRows reads each column\'s shown text whatever its case, all filters together', () => {
  const { sortRows, filterRows } = renderPlugin()
  assert.equal(typeof sortRows, 'function', 'client.js has sortRows')
  assert.equal(typeof filterRows, 'function', 'client.js has filterRows')
  const row = (name, rate, outcome) => [{ text: name, value: name }, { text: rate == null ? '' : `${rate}%`, value: rate }, { text: outcome }]
  const rows = [row('b', 10, 'Passed'), row('a', 9, 'failed'), row('c', null, 'passed'), row('d', 100, 'Passed'), row('e', 10, 'timed out')]
  const names = (list) => list.map((r) => r[0].text)
  assert.deepEqual(names(sortRows(rows, 1, 'asc')), ['a', 'b', 'e', 'd', 'c'], '9 before 10 before 100, the two tens in their order, the blank last')
  assert.deepEqual(names(sortRows(rows, 1, 'desc')), ['d', 'b', 'e', 'a', 'c'], 'descending: the blank still last, the two tens still in their order')
  assert.deepEqual(names(sortRows(rows, 2, 'asc')), ['a', 'b', 'c', 'd', 'e'], 'text by what it says, whatever its case, equal ones in their order')
  assert.deepEqual(names(sortRows(rows, 0, 'desc')), ['e', 'd', 'c', 'b', 'a'])
  const same = sortRows(rows, null, null)
  assert.deepEqual(names(same), ['b', 'a', 'c', 'd', 'e'], 'no sort: as they came')
  assert.notEqual(same, rows, 'a copy, never the rows themselves')
  assert.deepEqual(sortRows([[{ text: 'debugging-10' }], [{ text: 'debugging-9' }]], 0, 'asc').map((r) => r[0].text), ['debugging-9', 'debugging-10'], 'numbers inside text too')
  assert.deepEqual(names(filterRows(rows, { 2: 'PASSED' })), ['b', 'c', 'd'], 'case-insensitive')
  assert.deepEqual(names(filterRows(rows, { 2: 'passed', 1: '10' })), ['b', 'd'], 'every filter together, on the text each cell shows')
  assert.deepEqual(names(filterRows(rows, { 0: '  ', 1: '' })), names(rows), 'an empty filter filters nothing')
  assert.deepEqual(filterRows(rows, { 2: 'nothing like it' }), [])
})

test('the capability benchmark\'s progress lines say how far each agent is, what came of its tasks, the task under way or the slot it waits for, and how its queue ended', () => {
  const { benchmarkProgress } = renderPlugin()
  assert.equal(typeof benchmarkProgress, 'function', 'client.js has the progress lines')
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  const agent = (over) => ({ id: 'codex', kind: 'subscription', status: 'running', total: 28, done: 12, passed: 9, failed: 2, timedOut: 1, reruns: 1, didNotFit: 0, task: null, line: null, ...over })
  assert.equal(benchmarkProgress(agent({ task: { id: 'debugging-2', startedAt: now - 120_000, waiting: null } }), now), 'codex: 12 of 28: 9 passed, 2 failed, 1 timed out; 1 run again after an error. Running debugging-2, 2 min.')
  assert.equal(benchmarkProgress(agent({ done: 0, passed: 0, failed: 0, timedOut: 0, reruns: 0, task: { id: 'preflight', startedAt: now - 3000, waiting: 'Waiting for a free slot: the resource budget caps how many tasks run at once' } }), now), 'codex: 0 of 28: 0 passed, 0 failed. Waiting for a free slot: the resource budget caps how many tasks run at once.')
  assert.equal(benchmarkProgress(agent({ id: 'qwen-local', kind: 'local', total: 20, done: 20, passed: 14, failed: 6, timedOut: 0, reruns: 0, didNotFit: 8, status: 'finished', line: 'qwen-local finished: recorded 27 tasks as evidence.' }), now), 'qwen-local: 20 of 20: 14 passed, 6 failed; 8 did not fit. qwen-local finished: recorded 27 tasks as evidence.')
  assert.equal(benchmarkProgress(agent({ status: 'errored', line: 'codex stopped at debugging-2: it ended in an error twice (ECONNRESET). Nothing is recorded for it.' }), now), 'codex: 12 of 28: 9 passed, 2 failed, 1 timed out; 1 run again after an error. codex stopped at debugging-2: it ended in an error twice (ECONNRESET). Nothing is recorded for it.')
  assert.equal(benchmarkProgress(agent({ status: 'waiting', done: 0 }), now), 'codex: waits for its turn.')
  assert.equal(benchmarkProgress(agent({ done: 0, passed: 0, failed: 0, timedOut: 0, reruns: 0, task: null, phase: null }), now), 'codex: 0 of 28: 0 passed, 0 failed. Starting.')
  assert.equal(benchmarkProgress(agent({ status: 'not_run', done: 0, line: 'codex was not run: the benchmark was stopped.' }), now), 'codex was not run: the benchmark was stopped.')
})

test('the progress line says how the first, one-file task went apart from the scored tasks it counts', () => {
  const { benchmarkProgress } = renderPlugin()
  assert.equal(typeof benchmarkProgress, 'function', 'client.js has the progress lines')
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  const agent = (over) => ({ id: 'claude', kind: 'subscription', status: 'running', total: 27, done: 12, passed: 9, failed: 2, timedOut: 1, reruns: 0, didNotFit: 0, task: { id: 'debugging-2', startedAt: now - 120_000, waiting: null }, line: null, first: 'passed', ...over })
  assert.equal(benchmarkProgress(agent(), now), 'claude: first task passed; 12 of 27: 9 passed, 2 failed, 1 timed out. Running debugging-2, 2 min.')
  assert.equal(benchmarkProgress(agent({ first: null, done: 0, passed: 0, failed: 0, timedOut: 0, task: { id: 'preflight', startedAt: now - 5000, waiting: null } }), now), 'claude: 0 of 27: 0 passed, 0 failed. Running preflight, 5 s.')
  assert.equal(benchmarkProgress(agent({ first: 'failed', done: 0, passed: 0, failed: 0, timedOut: 0, task: null, status: 'preflight_failed', line: 'claude could not do the first, one-file task (hello.txt was not written): it has to run node in its folder. Nothing else was run on it.' }), now), 'claude: first task failed; 0 of 27: 0 passed, 0 failed. claude could not do the first, one-file task (hello.txt was not written): it has to run node in its folder. Nothing else was run on it.')
})

test('the progress line says when the runner reads an agent\'s usage, before its first task and after its last, rather than that it is starting', () => {
  const { benchmarkProgress } = renderPlugin()
  assert.equal(typeof benchmarkProgress, 'function', 'client.js has the progress lines')
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  const agent = (over) => ({ id: 'codex', kind: 'subscription', status: 'running', total: 27, done: 0, passed: 0, failed: 0, timedOut: 0, reruns: 0, didNotFit: 0, task: null, line: null, ...over })
  assert.equal(benchmarkProgress(agent({ phase: 'spend-before' }), now), 'codex: 0 of 27: 0 passed, 0 failed. Reading its usage before it starts.')
  assert.equal(benchmarkProgress(agent({ phase: 'spend-after', done: 27, passed: 27 }), now), 'codex: 27 of 27: 27 passed, 0 failed. Reading what it spent.')
})

/** The client over a fetch that `answer(path, init)` answers with [status, body], mounted with state as a browser has it. */
function benchmarkClient(answer) {
  const calls = []
  let busy = 0
  const fetch = async (path, init = {}) => {
    busy++
    try {
      calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      const [status, body] = answer(path, init)
      const text = JSON.stringify(body)
      return { ok: status === 200, status, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const globals = {
    fetch, document: { hidden: false, getElementById: () => ({}), head: { appendChild() {} } },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  }
  const { React, mount } = statefulReact()
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } }, addEventListener() {}, removeEventListener() {} }
  new Function('window', ...Object.keys(globals), readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window, ...Object.values(globals))
  const plugin = registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
  const settle = async (view) => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  return { plugin, mount, settle, calls }
}

// GET /jev-router/benchmark as the server answers it once two agents have finished a run.
const cell = (text, value = text) => ({ text, value })
const BENCH_STATE = {
  what: '27 fixed tasks in nine skills, each in a new folder with its own checks.',
  note: 'Pass rates are over three small tasks per skill, so 2 of 3 is not a precise 67%.',
  taskSet: { id: 'kzh-capability', version: '1', digestOk: true, tasks: 27, skills: [] },
  where: { state: 'scratch', path: '/h/kzh-scratch', text: 'This chat is in the KzH scratch workspace (/h/kzh-scratch), which holds nothing of yours: the benchmark runs here.', accountText: null },
  learn: true,
  agents: [
    { id: 'codex', name: 'Codex', kind: 'subscription', kindText: 'subscription', model: 'gpt-5', subject: 'openai-gpt gpt-5', can: true, why: null, estimate: ['Uses your ChatGPT subscription.'], warnings: [], fit: null, lastRun: null },
    { id: 'deepseek', name: 'DeepSeek', kind: 'api', kindText: 'API key', model: 'deepseek-flash', subject: 'deepseek deepseek-flash', can: false, why: 'deepseek cannot run: DEEPSEEK_API_KEY missing', estimate: [], warnings: [], fit: null, lastRun: null },
  ],
  run: null,
  last: { runId: 'bench-1', status: 'finished', at: '2026-09-25T10:00:00.000Z', lines: ['codex finished: recorded 27 tasks as evidence.', 'claude finished: recorded 27 tasks as evidence.'] },
  results: {
    dimensions: [
      [cell('codex'), cell('gpt-5'), cell('coding'), cell('75% (9 of 12)', 0.75), cell("1.9 against the prior's 4.8", 1.89), cell('0.85, owner prior', 0.85), cell('84%, well evidenced', 0.84), cell('implementation, debugging, refactor, testing'), cell('25 Sep, version 1', 1)],
      [cell('claude'), cell('opus'), cell('coding'), cell('100% (12 of 12)', 1), cell("1.9 against the prior's 4.8", 1.89), cell('0.93, owner prior', 0.93), cell('94%, well evidenced', 0.94), cell('implementation, debugging, refactor, testing'), cell('25 Sep, version 1', 1)],
      [cell('codex'), cell('gpt-5'), cell('testing'), cell('67% (2 of 3)', 2 / 3), cell("1.9 against the prior's 0.0", 1.89), cell('none', -1), cell('67%, some evidence', 0.67), cell('testing'), cell('25 Sep, version 1', 1)],
    ],
    tasks: [
      [cell('codex'), cell('debugging-2'), cell('failed', 'failed'), cell('the grade failed 2 of 8 tests'), cell('debugging'), cell('2', 2), cell('3 min', 180_000), cell('41,000', 41_000), cell('high'), cell('25 Sep, version 1', 1)],
    ],
  },
  leftovers: 0,
}

test('the capability benchmark card: the results tables put the pass rate beside the weight, the prior and the Router tab\'s score under Profile now, every column sorts and filters, and a run is started only on the confirmation the server wrote', async () => {
  const c = benchmarkClient((path, init) => {
    if (path === '/jev-router/benchmark?session=s1') return [200, BENCH_STATE]
    if (path === '/jev-router/benchmark/plan') return [200, { planId: 'plan-1', confirm: { title: 'Run the capability benchmark on 1 agent?', body: ['Runs 28 tasks on codex.', 'Learning is switched off, so the results are shown here and recorded nowhere else.'], confirmLabel: 'Run on 1 agent' } }]
    if (path === '/jev-router/benchmark/start') return [200, { runId: 'bench-2' }]
    return [404, { error: `not found: ${init.method ?? 'GET'} ${path}` }]
  })
  assert.equal(typeof c.plugin.BenchmarkCard, 'function', 'client.js has the benchmark card')
  const card = c.mount(c.plugin.BenchmarkCard, { sessionId: 's1', now: Date.parse('2026-09-25T12:00:00.000Z') })
  await c.settle(card)
  const all = nodes(card.tree)
  assert.equal(textOf(all.find((n) => n.props.id === 'jevi-bench-h')), 'Capability benchmark')
  assert.ok(all.some((n) => textOf(n) === BENCH_STATE.where.text), 'where it runs')
  assert.ok(all.some((n) => n.props?.role === 'status' && textOf(n).includes('codex finished: recorded 27 tasks as evidence.')), 'how the last run ended, agent by agent')
  // An agent that cannot run is shown, unticked and disabled, with its reason.
  const box = (id) => all.find((n) => n.type === 'input' && n.props['aria-label'] === `Pick ${id}`)
  assert.deepEqual([box('codex').props.checked, box('codex').props.disabled], [false, false], 'none is ever ticked for the person')
  assert.equal(box('deepseek').props.disabled, true)
  assert.ok(all.some((n) => n.props?.className === 'err' && textOf(n) === 'deepseek cannot run: DEEPSEEK_API_KEY missing'))

  // The two tables, each a table of the table rule.
  const tables = all.filter((n) => n.type === c.plugin.SortTable)
  assert.deepEqual(tables.map((t) => t.props.label), ['Benchmark results by dimension', 'Benchmark tasks'])
  const byDim = c.mount(c.plugin.SortTable, tables[0].props)
  const heads = (v) => nodes(v.tree).filter((n) => n.type === 'th' && n.props.scope === 'col').map((n) => textOf(n).replace(/ [▲▼]$/, ''))
  const body = (v) => nodes(v.tree).filter((n) => n.type === 'tr' && n.children.some((x) => x?.type === 'td')).map((tr) => tr.children.map(textOf))
  assert.deepEqual(heads(byDim), ['Agent', 'Model', 'Dimension', 'Benchmark', 'Weight', 'Prior', 'Profile now', 'Skills', 'Run'])
  assert.deepEqual(body(byDim)[0], ['codex', 'gpt-5', 'coding', '75% (9 of 12)', "1.9 against the prior's 4.8", '0.85, owner prior', '84%, well evidenced', 'implementation, debugging, refactor, testing', '25 Sep, version 1'])
  const tasks = c.mount(c.plugin.SortTable, tables[1].props)
  assert.deepEqual(heads(tasks), ['Agent', 'Task', 'Outcome', 'Why', 'Skill', 'Level', 'Time', 'Tokens', 'Effort', 'Run'])
  // Sort by Benchmark: ascending, descending, then none, said by aria-sort.
  const header = (v, label) => nodes(v.tree).find((n) => n.type === 'th' && n.props.scope === 'col' && textOf(n).startsWith(label))
  const click = async (v, label) => { nodes(header(v, label)).find((n) => n.type === 'button').props.onClick(); await c.settle(v) }
  assert.equal(header(byDim, 'Benchmark').props['aria-sort'], 'none')
  await click(byDim, 'Benchmark')
  assert.equal(header(byDim, 'Benchmark').props['aria-sort'], 'ascending')
  assert.deepEqual(body(byDim).map((r) => r[3]), ['67% (2 of 3)', '75% (9 of 12)', '100% (12 of 12)'], 'by the rate, not by the text')
  await click(byDim, 'Benchmark')
  assert.equal(header(byDim, 'Benchmark').props['aria-sort'], 'descending')
  assert.deepEqual(body(byDim).map((r) => r[3]), ['100% (12 of 12)', '75% (9 of 12)', '67% (2 of 3)'])
  await click(byDim, 'Benchmark')
  assert.equal(header(byDim, 'Benchmark').props['aria-sort'], 'none')
  assert.deepEqual(body(byDim).map((r) => r[0]), ['codex', 'claude', 'codex'], 'as they came')
  // A filter under every header, all together.
  const filter = async (v, label, value) => { nodes(v.tree).find((n) => n.type === 'input' && n.props['aria-label'] === `Filter ${label}`).props.onChange({ target: { value } }); await c.settle(v) }
  assert.equal(nodes(byDim.tree).filter((n) => n.type === 'input' && n.props.type === 'search').length, 9)
  await filter(byDim, 'Agent', 'CODEX')
  assert.deepEqual(body(byDim).map((r) => r[2]), ['coding', 'testing'])
  await filter(byDim, 'Profile now', 'well')
  assert.deepEqual(body(byDim).map((r) => r[2]), ['coding'])
  await filter(byDim, 'Model', 'opus')
  assert.deepEqual(body(byDim), [['No row matches the filters.']])

  // Run: the server works out the plan and writes the confirmation; the start carries its plan id.
  box('codex').props.onChange({ target: { checked: true } })
  await c.settle(card)
  const run = nodes(card.tree).find((n) => n.type === 'button' && textOf(n) === 'Run on 1 agent')
  assert.equal(run.props.disabled, false)
  run.props.onClick()
  await c.settle(card)
  const confirm = nodes(card.tree).find((n) => typeof n.type === 'function' && n.props?.confirmLabel === 'Run on 1 agent')
  assert.ok(confirm, 'the confirmation is shown')
  assert.deepEqual([confirm.props.title, confirm.props.body], ['Run the capability benchmark on 1 agent?', ['Runs 28 tasks on codex.', 'Learning is switched off, so the results are shown here and recorded nowhere else.']])
  assert.deepEqual(c.calls.filter((x) => x.method === 'POST').map((x) => [x.path, x.body]), [['/jev-router/benchmark/plan', { session: 's1', agents: ['codex'] }]], 'nothing starts before the confirmation')
  confirm.props.onConfirm()
  await c.settle(card)
  assert.deepEqual(c.calls.filter((x) => x.method === 'POST').map((x) => [x.path, x.body]).at(-1), ['/jev-router/benchmark/start', { session: 's1', agents: ['codex'], planId: 'plan-1' }])
  for (const v of [card, byDim, tasks]) v.unmount()
})

test('a confirmation longer than the window keeps its title and its buttons in view and scrolls its body, so what a run will do and spend can always be read', async () => {
  const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of what the run will do and spend.`)
  const c = benchmarkClient((path) => {
    if (path === '/jev-router/benchmark?session=s1') return [200, BENCH_STATE]
    if (path === '/jev-router/benchmark/plan') return [200, { planId: 'plan-1', confirm: { title: 'Run the capability benchmark on 1 agent?', body, confirmLabel: 'Run on 1 agent' } }]
    return [404, { error: 'not found' }]
  })
  assert.equal(typeof c.plugin.BenchmarkCard, 'function', 'client.js has the benchmark card')
  const card = c.mount(c.plugin.BenchmarkCard, { sessionId: 's1', now: Date.parse('2026-09-25T12:00:00.000Z') })
  await c.settle(card)
  nodes(card.tree).find((n) => n.type === 'input' && n.props['aria-label'] === 'Pick codex').props.onChange({ target: { checked: true } })
  await c.settle(card)
  nodes(card.tree).find((n) => n.type === 'button' && textOf(n) === 'Run on 1 agent').props.onClick()
  await c.settle(card)
  const at = nodes(card.tree).find((n) => typeof n.type === 'function' && n.props?.confirmLabel === 'Run on 1 agent')
  const dialog = c.mount(at.type, at.props)
  const box = nodes(dialog.tree).find((n) => /\bbox\b/.test(n.props?.className ?? ''))
  assert.deepEqual(box.children.map((n) => n.props?.className ?? n.type), ['h3', 'body', 'actions'], 'the title, a body that scrolls, then the buttons')
  assert.deepEqual(box.children[1].children.map(textOf), body)
  // The layout, read from the style sheet the client puts in the page.
  const css = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const rule = (selector) => new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
  assert.match(box.props.className, /\bconfirm\b/)
  assert.match(rule('.jevi-modal .box.confirm'), /display:flex/)
  assert.match(rule('.jevi-modal .box.confirm'), /flex-direction:column/)
  assert.match(rule('.jevi-modal .box.confirm'), /max-height:calc\(100vh - 48px\)/)
  assert.match(rule('.jevi-modal .box.confirm'), /box-sizing:border-box/, 'its padding inside that height')
  assert.match(rule('.jevi-modal .box.confirm .body'), /overflow:auto/)
  dialog.unmount()
  card.unmount()
})

test('a pick\'s last run reads its day as every date on the card does, with its year when it is not this one, and how its queue ended in words', async () => {
  const lastRun = (over) => ({ at: '2025-12-20T09:00:00.000Z', day: '20 Dec 2025', version: '1', older: false, status: 'too_small', statusText: 'its window cannot hold the first task, so nothing ran', ...over })
  const agents = [{ ...BENCH_STATE.agents[0], lastRun: lastRun() }, { ...BENCH_STATE.agents[1], lastRun: lastRun({ day: '26 Sep', status: 'set_changed', statusText: 'stopped: the task set changed', older: true }) }]
  const c = benchmarkClient((path) => (path === '/jev-router/benchmark?session=s1' ? [200, { ...BENCH_STATE, agents }] : [404, { error: 'not found' }]))
  assert.equal(typeof c.plugin.BenchmarkCard, 'function', 'client.js has the benchmark card')
  const card = c.mount(c.plugin.BenchmarkCard, { sessionId: 's1', now: Date.parse('2026-09-26T12:00:00.000Z') })
  await c.settle(card)
  const lines = nodes(card.tree).filter((n) => n.props?.className === 'why').map(textOf).filter((t) => t.startsWith('Last run'))
  assert.deepEqual(lines, ['Last run 20 Dec 2025, version 1: its window cannot hold the first task, so nothing ran.', 'Last run 26 Sep, version 1, older than the task set: stopped: the task set changed.'])
  card.unmount()
})

test('while the task set on disk does not match its version, the card says nothing can run and Run cannot be pressed', async () => {
  const c = benchmarkClient((path) => (path === '/jev-router/benchmark?session=s1' ? [200, { ...BENCH_STATE, taskSet: { ...BENCH_STATE.taskSet, digestOk: false } }] : [404, { error: 'not found' }]))
  assert.equal(typeof c.plugin.BenchmarkCard, 'function', 'client.js has the benchmark card')
  const card = c.mount(c.plugin.BenchmarkCard, { sessionId: 's1', now: Date.parse('2026-09-26T12:00:00.000Z') })
  await c.settle(card)
  assert.ok(nodes(card.tree).some((n) => n.props?.className === 'err' && textOf(n) === 'The task set on disk no longer matches version 1; nothing can be run until it does.'))
  nodes(card.tree).find((n) => n.type === 'input' && n.props['aria-label'] === 'Pick codex').props.onChange({ target: { checked: true } })
  await c.settle(card)
  assert.equal(nodes(card.tree).find((n) => n.type === 'button' && textOf(n) === 'Run on 1 agent').props.disabled, true)
  card.unmount()
})

test('the benchmark card reads the benchmark only while the Router tab is shown, as the tab\'s other reads do', async () => {
  const { RouterView, BenchmarkCard } = renderPlugin()
  assert.equal(typeof BenchmarkCard, 'function', 'client.js has the benchmark card')
  const data = { enabled: true, learning: true, domains: {}, resources: [], profiles: [] }
  const card = (tree) => nodes(tree).find((n) => n.type === BenchmarkCard)
  assert.equal(card(RouterView({ data, error: '', busy: false, onRefresh() {}, laya: { data: null, error: '' }, sessionId: 's1', visible: false })).props.visible, false, 'hidden, it is handed so')
  assert.equal(card(RouterView({ data, error: '', busy: false, onRefresh() {}, laya: { data: null, error: '' }, sessionId: 's1', visible: true })).props.visible, true)

  // The inspector hands the Router view whether its tab is shown.
  const fetch = async (path) => {
    const text = JSON.stringify(path === '/jev-router/routing' ? data : path === '/jev-router/tasks' ? { tasks: [] } : path === '/jev-router/setup' ? { agents: [] } : path.startsWith('/jev-router/log?') ? [] : {})
    return { ok: true, status: 200, json: async () => JSON.parse(text) }
  }
  const globals = { fetch, document: { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} }
  const { React, mount } = statefulReact()
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', ...Object.keys(globals), readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window, ...Object.values(globals))
  const plugin = registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
  const tab = { visible: true }
  const view = mount(plugin.InspectorBody, { sessionId: 's1', useTabInfo: () => ({ tab }), useSessions: () => undefined })
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  await settle()
  nodes(view.tree).find((n) => n.type === 'button' && n.props.role === 'tab' && textOf(n) === 'Router').props.onClick()
  await settle()
  assert.equal(nodes(view.tree).find((n) => n.type === plugin.RouterView).props.visible, true)
  tab.visible = false
  view.render()
  await settle()
  assert.equal(nodes(view.tree).find((n) => n.type === plugin.RouterView).props.visible, false, 'the tab is hidden')
  view.unmount()
})

test('in the narrow inspector the tasks table puts the outcome and why beside the task, keeps a long why to three lines with the whole of it on hover, and scrolls within a height of its own', async () => {
  const why = 'failed 3 of 8 checks: '.concat('a long reason '.repeat(60)).trim()
  const task = [cell('codex'), cell('debugging-2'), cell('failed', 'failed'), cell(why), cell('debugging'), cell('2', 2), cell('3 min', 180_000), cell('41,000', 41_000), cell('high'), cell('25 Sep, version 1', 1)]
  const c = benchmarkClient((path) => (path === '/jev-router/benchmark?session=s1' ? [200, { ...BENCH_STATE, results: { ...BENCH_STATE.results, tasks: [task] } }] : [404, { error: 'not found' }]))
  assert.equal(typeof c.plugin.BenchmarkCard, 'function', 'client.js has the benchmark card')
  const card = c.mount(c.plugin.BenchmarkCard, { sessionId: 's1', now: Date.parse('2026-09-26T12:00:00.000Z') })
  await c.settle(card)
  const at = nodes(card.tree).filter((n) => n.type === c.plugin.SortTable)[1]
  const tasks = c.mount(c.plugin.SortTable, at.props)
  assert.deepEqual(nodes(tasks.tree).filter((n) => n.type === 'th' && n.props.scope === 'col').map(textOf), ['Agent', 'Task', 'Outcome', 'Why', 'Skill', 'Level', 'Time', 'Tokens', 'Effort', 'Run'])
  const cells = nodes(tasks.tree).filter((n) => n.type === 'td')
  assert.deepEqual(cells.map(textOf), task.map((x) => x.text), 'every cell shows its whole text')
  const whyCell = cells[3]
  assert.equal(whyCell.props.title, why, 'the whole of it on hover')
  assert.equal(whyCell.children[0]?.props?.className, 'clamp')
  assert.equal(cells[2].props.title, undefined, 'a short cell is not clamped')
  const css = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const rule = (selector) => new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
  assert.match(rule('.jevi table.sortable'), /max-height:/, 'a height of its own, so its scroll bars are in view')
  assert.match(rule('.jevi table.sortable'), /overflow:auto/)
  assert.match(rule('.jevi table.sortable td .clamp'), /-webkit-line-clamp:3/)
  tasks.unmount()
  card.unmount()
})

test('the capability benchmark card says a run that ended early did, with the lines that say why, and never that KzH stopped', async () => {
  const lines = ['ql stopped at investigation-1. Nothing is recorded for it.', 'cx was not run.', "The run ended there: the benchmark's log could not be written (EISDIR: illegal operation on a directory)."]
  const c = benchmarkClient((path) => (path === '/jev-router/benchmark?session=s1' ? [200, { ...BENCH_STATE, last: { runId: 'bench-3', status: 'failed', at: '2026-09-25T11:00:00.000Z', lines } }] : [404, { error: 'not found' }]))
  assert.equal(typeof c.plugin.BenchmarkCard, 'function', 'client.js has the benchmark card')
  const card = c.mount(c.plugin.BenchmarkCard, { sessionId: 's1', now: Date.parse('2026-09-25T12:00:00.000Z') })
  await c.settle(card)
  const last = nodes(card.tree).find((n) => n.props?.role === 'status' && n.props['aria-label'] === 'Last benchmark')
  assert.deepEqual(last.children.filter(Boolean).map(textOf), ['The last run ended early, and every agent that had not finished records nothing.', ...lines])
  card.unmount()
})

test('the Router tab\'s profile line gives a dimension\'s benchmark pass rate with its tasks, its lead line names the benchmark among what moves a prior, and the benchmark card follows, for the chat the tab is in', () => {
  const { RouterView, BenchmarkCard } = renderPlugin()
  assert.equal(typeof BenchmarkCard, 'function', 'client.js has the benchmark card')
  const data = {
    enabled: true, learning: true, domains: {}, resources: [],
    profiles: [{ id: 'codex', subject: { model: 'gpt-5' }, cold: true, samples: 0, dimensions: { coding: { score: 0.88, confidence: 0.7, prior: { score: 0.93, source: 'owner_prior' }, execution: null, benchmark: { score: 0.75, tasks: 12, passed: 9, weight: 1.89 } } } }],
  }
  const tree = RouterView({ data, error: '', busy: false, onRefresh() {}, laya: { data: null, error: '' }, sessionId: 's1' })
  const whys = nodes(tree).filter((n) => n.props?.className === 'why').map(textOf)
  assert.ok(whys.some((w) => w.endsWith(' · benchmark 75% (9 of 12 tasks)')), whys.join('\n'))
  assert.ok(whys.includes("Priors are the owner's starting observations. Recorded runs, reviews, feedback and the capability benchmark below move them; an unknown dimension stays unknown."))
  assert.ok(nodes(tree).some((n) => n.type === 'summary' && textOf(n).endsWith('0 observations')), 'benchmark rows are no observations of runs')
  const cards = nodes(tree).filter((n) => n.type === BenchmarkCard)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].props.sessionId, 's1')
})

test('the Router tab\'s profile line names one benchmark task in the singular', () => {
  const { RouterView } = renderPlugin()
  assert.equal(typeof RouterView, 'function', 'the Router view can be rendered')
  const data = {
    enabled: true, learning: true, domains: {}, resources: [],
    profiles: [{ id: 'ql', subject: { model: 'qwen' }, cold: true, samples: 0, dimensions: { testing: { score: 0.6, confidence: 0.3, prior: null, execution: null, benchmark: { score: 1, tasks: 1, passed: 1, weight: 1.89 } } } }],
  }
  const whys = nodes(RouterView({ data, error: '', busy: false, onRefresh() {}, laya: { data: null, error: '' }, sessionId: 's1' })).filter((n) => n.props?.className === 'why').map(textOf)
  assert.ok(whys.some((w) => w.endsWith(' · benchmark 100% (1 of 1 task)')), whys.join('\n'))
})
