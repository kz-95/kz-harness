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
