// The conversation context row belongs to the ENGINE, and a jev-router report reads as Markdown
// in the Overview tab instead.
//
// An earlier build registered the keyed `conversation.chat.node` slot under key 'context' so a
// background result would render as a card. That key is kind `keyed`, not `chain`: registering it
// replaces the shipped occupant outright, with no fall-through, so one plugin row cost all five
// other forms (instructions, catalog, snapshot, relay, recall) their structured bodies. They fell
// back to flat text, which loses no words but reads badly.
//
// The first test is a tripwire, in the same spirit as the animation-frame guards in
// togglehints.test.js: it fails if anyone takes that key again. It reads the source rather than a
// registration, because the registration only runs inside a live engine, and the point is to catch
// the line in review, not at runtime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * The plugin body as a function of `window`, with a `require` the caller controls, so a test can
 * decide whether the engine UI primitives are reachable. Mirrors loadPlugin in togglehints.test.js.
 */
function loadPlugin({ primitives = null, calls = [] } = {}) {
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', SRC)(window)
  const React = {
    createElement: (type, props, ...children) => {
      const node = { type, props: props ?? {}, children }
      calls.push(node)
      return node
    },
    Fragment: {},
    useState: (v) => [v, () => {}],
    useEffect() {},
    useCallback: (f) => f,
    useRef: () => ({}),
  }
  const factory = registration.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === null) throw new Error('not reachable')
      return primitives
    }
    throw new Error(`unexpected require: ${id}`)
  })
  return { plugin: factory, calls }
}

test('context rows: the plugin never registers the keyed context node again', () => {
  // Any form of the registration, however it is spelled or spaced.
  const takesTheKey = /register\s*\(\s*\{[^}]*conversation\.chat\.node[^}]*key:\s*['"]context['"]/s.test(SRC)
  assert.equal(takesTheKey, false, 'registering key context replaces the shipped row for all six forms, not only ours')
  assert.equal(/key:\s*['"]context['"]/.test(SRC), false, 'no keyed context registration in any shape')
})

test('context rows: the acknowledgement pass still reads the spans the shipped row emits', () => {
  // The shipped ContextInjectionRow emits both, so giving the row back does not blind the pass
  // that marks a delivered result as read. If either selector goes, that pass is silently dead.
  assert.ok(SRC.includes('[data-context-summary]'), 'the pass finds rows by their summary span')
  assert.ok(SRC.includes('[data-context-source]'), 'the pass reads the producer from its source span')
})

test('Markdown: renders through the engine renderer, and marks the block so pre-wrap stops doubling gaps', () => {
  const MarkdownText = function MarkdownText() {}
  const { plugin, calls } = loadPlugin({ primitives: { MarkdownText } })
  calls.length = 0
  const node = plugin.__test.Markdown({ className: 'answer-text', text: '# title\n\nbody' })
  assert.equal(node.type, 'div')
  assert.equal(node.props.className, 'answer-text answer-md')
  const inner = node.children[0]
  assert.equal(inner.type, MarkdownText)
  assert.equal(inner.props.text, '# title\n\nbody')
})

test('Markdown: an unreachable primitives module degrades to the plain text, never to nothing', () => {
  // The report is the whole point of the row. A renderer that failed to load must cost formatting,
  // not the words.
  const { plugin } = loadPlugin({ primitives: null })
  const node = plugin.__test.Markdown({ className: 'answer-text', text: '# title\n\nbody' })
  assert.equal(node.type, 'div')
  assert.equal(node.props.className, 'answer-text', 'no answer-md: pre-wrap is what lays this text out')
  assert.equal(node.children[0], '# title\n\nbody')
})
