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
    { domain: 'task_classification', question: 'taskType', layaAnswered: 41, agree: { all: { n: 41, agree: 22 }, informative: { n: 30, agree: 19 } }, personSaid: { n: 4, jevRight: 3, layaRight: 2 }, whereJevWasContradicted: { n: 3, layaRight: 1 }, layaAutoRuns: { runs: 12, failed: 2 }, fieldAgreement: { risk: 0.64 } },
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
    ['task classification', '41', '19 of 30 (63%)', '3 / 2 of 4', '1 of 3', '2 of 12'],
    ['second opinion', '0', 'none yet', 'none yet', 'none yet', 'none yet'],
  ], 'a source with no rows says so, and shows no rate')
  // The sources are kept apart, and each says what it can show.
  assert.ok(whys.some((w) => w.startsWith('A person said: the rows a person labelled, the least biased.') && w.includes("never Laya's accuracy") && w.includes('never an accuracy')))
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
