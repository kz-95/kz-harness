// The live store (live.js): what a routed run is doing as it does it, from the router's milestones
// and a spawn child's own stream, bounded, redacted, and saved per task once a run ends
// (docs/live-agent-view.md Feature 1). The frames and events below have the shapes the pinned engine
// gives them: dsh-agent AssistantStreamFrame for `agent/assistant-stream`, and dsh-session
// SessionEvent for what `session.snapshotEvents(cursor)` returns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { LIVE_CAPS, LIVE_TIMES, createLiveStore, editDiff, phraseOf, spanWords, stallOf, toolKindOf, toolTitle } from '../live.js'
// What slice 5 adds (the engine patch's taps and the providers' own token counts), read through the
// namespace so this file still loads on the code before it.
import * as L from '../live.js'

const made = []
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'kz-live-')); made.push(d); return d }

/** A clock a test moves by hand. */
function clock(start = 1_000_000) {
  let t = start
  const now = () => t
  now.add = (ms) => { t += ms; return t }
  return now
}

// ---- the engine's shapes ----

const frame = {
  start: (attemptId, turn, step) => ({ type: 'start', attemptId, revision: 1, turn, step }),
  chunk: (attemptId, index, chunk) => ({ type: 'chunk', attemptId, revision: 1, index, time: 0, chunk }),
  end: (attemptId, seq) => ({ type: 'end', attemptId, revision: 1, index: 0, outcome: seq == null ? { kind: 'abandoned' } : { kind: 'committed', eventType: 'assistant/message', seq } }),
}
const ev = (seq, type, data, time = 0) => ({ seq, time, type, data })
const toolResult = (callId, text, { isError = false, meta } = {}) => ({
  turn: 1, step: 1,
  message: { id: `res-${callId}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }] },
  ...(meta ? { meta } : {}),
})
const assistant = (turn, step, content, usage = { inputTokens: 1200, outputTokens: 300 }) => ({ turn, step, message: { id: `msg-${turn}-${step}`, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }, content }, stream: [], usage })

/**
 * One step of a spawn child as it streams: it thinks, says what it is about to do, and calls the
 * shell; the frames come first, then what the session commits (`seq` from `seq0`).
 */
function oneStep({ attemptId = 'llm-1', turn = 1, step = 1, seq0 = 0, callId = 'call-1', command = 'npm test' } = {}) {
  const args = JSON.stringify({ command })
  return {
    frames: [
      frame.start(attemptId, turn, step),
      frame.chunk(attemptId, 0, { type: 'block-start', index: 0, blockType: 'reasoning' }),
      frame.chunk(attemptId, 1, { type: 'reasoning-delta', index: 0, text: 'The tests may already fail; ' }),
      frame.chunk(attemptId, 2, { type: 'reasoning-delta', index: 0, text: 'run them first.' }),
      frame.chunk(attemptId, 3, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The tests may already fail; run them first.' } }),
      frame.chunk(attemptId, 4, { type: 'block-start', index: 1, blockType: 'text' }),
      frame.chunk(attemptId, 5, { type: 'text-delta', index: 1, text: 'Running the tests.' }),
      frame.chunk(attemptId, 6, { type: 'block-end', index: 1, block: { type: 'text', text: 'Running the tests.' } }),
      frame.chunk(attemptId, 7, { type: 'block-start', index: 2, blockType: 'tool-call' }),
      frame.chunk(attemptId, 8, { type: 'tool-call-delta', index: 2, id: callId, name: 'bash', argumentsDelta: args.slice(0, 5) }),
      frame.chunk(attemptId, 9, { type: 'tool-call-delta', index: 2, id: callId, argumentsDelta: args.slice(5) }),
      frame.chunk(attemptId, 10, { type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'bash', arguments: args } }),
      frame.chunk(attemptId, 11, { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } }),
      frame.chunk(attemptId, 12, { type: 'finish', reason: { kind: 'tool-calls' } }),
      frame.end(attemptId, seq0 + 2),
    ],
    events: [
      ev(seq0, 'turn/start', { turn }),
      ev(seq0 + 1, 'step/start', { turn, step }),
      ev(seq0 + 2, 'assistant/message', assistant(turn, step, [
        { type: 'reasoning', text: 'The tests may already fail; run them first.' },
        { type: 'text', text: 'Running the tests.' },
        { type: 'tool-call', id: callId, name: 'bash', arguments: args },
      ])),
      ev(seq0 + 3, 'tool/call', { turn, step, callId, name: 'bash', arguments: args }, 1000),
      ev(seq0 + 4, 'tool/result', toolResult(callId, 'FAIL src/a.test.js\n1 failing', { meta: { exitCode: 1 } }), 15_000),
    ],
  }
}

/** A store with one run whose router has picked DeepSeek and started its first attempt, and that attempt's handle. */
function started({ now = clock(), caps, times, dir, checks = false } = {}) {
  const live = createLiveStore({ now, caps, times, dir })
  live.open('run-1', { taskKey: 'key-1', sessionId: 'chat-1', decider: 'jev' })
  live.describe('run-1', { names: { deepseek: 'DeepSeek agent', claude: 'Claude Code' }, checks, reviewer: 'jev' })
  live.router('run-1', { type: 'jev', trace: { phase: 'route' } })
  live.router('run-1', { type: 'routed', routing: { mode: 'jev', decider: 'jev', primaryAgent: 'deepseek', decision: { domains: { task_classification: { authority: 'jev' } } } }, primary: { agent: 'deepseek', model: 'deepseek-flash', effort: 'high' } })
  live.router('run-1', { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary', effort: 'high' })
  const h = live.attempt('run-1', 0)
  h.started({ provider: 'spawn', model: 'deepseek-flash', detail: 'live', child: { id: 'child-1', label: 'jev:deepseek' } })
  return { live, h, now }
}
const shown = (live, after = 0) => live.read('run-1', after).items.filter((i) => !i.meta.hidden)

test('spawn frames plus committed events project to reasoning, text and tool items', () => {
  const { live, h } = started()
  const s = oneStep()
  for (const f of s.frames) h.frame(f)
  h.events(s.events)
  const items = shown(live)
  assert.deepEqual(items.map((i) => [i.kind, i.title, i.state]), [
    ['status', 'Picked by Jev: DeepSeek agent', 'done'],
    ['reasoning', 'Thinking', 'done'],
    ['text', '', 'done'],
    ['command', 'Ran npm test · exit 1 · 14s', 'done'],
  ])
  assert.equal(items[1].text, 'The tests may already fail; run them first.')
  assert.equal(items[2].text, 'Running the tests.')
  assert.equal(items[3].text, 'FAIL src/a.test.js\n1 failing', 'the command\'s output, for its tail')
  assert.equal(items[3].meta.command, 'npm test')
  assert.equal(items[3].meta.exitCode, 1)
  const run = live.read('run-1')
  assert.deepEqual([run.summary.tools, run.summary.tokens, run.summary.model], [1, 1500, 'deepseek-flash'], 'one tool call, and the step\'s usage counted once though both the stream and the session carried it')
  assert.deepEqual(run.child, { id: 'child-1', label: 'jev:deepseek' })
  assert.deepEqual(run.attempts.map((a) => [a.index, a.role, a.name, a.detail]), [[0, 'primary', 'DeepSeek agent', 'live']])
})

test('an edit\'s result becomes a file item with its line counts and diff, and a final answer reads as one', () => {
  const { live, h } = started()
  const edit = JSON.stringify({ file_path: 'src/app.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nB2\nc' })
  h.events([
    ev(0, 'assistant/message', assistant(1, 1, [{ type: 'tool-call', id: 'e1', name: 'edit', arguments: edit }])),
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'e1', name: 'edit', arguments: edit }),
    ev(2, 'tool/result', toolResult('e1', 'Edited src/app.ts', { meta: { diffs: [{ path: 'src/app.ts', oldText: 'a\nb\nc', newText: 'a\nB\nB2\nc' }] } })),
    ev(3, 'assistant/message', assistant(1, 2, [{ type: 'text', text: 'Fixed it.' }])),
  ])
  const items = shown(live).slice(1)
  assert.deepEqual(items.map((i) => [i.kind, i.title]), [['file', 'Edited src/app.ts +2 -1'], ['text', '']])
  assert.deepEqual([items[0].meta.plus, items[0].meta.minus, items[0].meta.path], [2, 1, 'src/app.ts'])
  assert.equal(items[0].text, '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+B2\n c')
  assert.equal(items[1].meta.final, true, 'a message with no tool call is the answer')
  assert.equal(live.activityOf('run-1').phrase, 'Writing its answer')
  assert.deepEqual(editDiff('new.txt', null, 'x\ny'), { plus: 2, minus: 0, diff: '--- /dev/null\n+++ b/new.txt\n@@ -1,0 +1,2 @@\n+x\n+y' })
})

test('the pump alone gives per-step detail when the listener gave nothing, and a stream the pump read first is hidden, not shown twice', () => {
  const { live, h } = started()
  const s = oneStep()
  // No frames at all: the committed events are the whole of it.
  h.events(s.events)
  assert.deepEqual(shown(live).slice(1).map((i) => [i.kind, i.state]), [['reasoning', 'done'], ['text', 'done'], ['command', 'done']])
  // The same step's frames arriving after the pump read its message (a listener late to the race):
  // their items are the same steps again, and are hidden.
  for (const f of s.frames) h.frame(f)
  assert.deepEqual(shown(live).slice(1).map((i) => i.kind), ['reasoning', 'text', 'command'])
  assert.equal(live.read('run-1').summary.tokens, 1500, 'still counted once')
})

test('backfill overlap is deduplicated by seq', () => {
  const { live, h, now } = started()
  const s = oneStep()
  h.events(s.events.slice(0, 4))
  // The next read starts before where the last one ended, as a pump that read from 0 again would.
  h.events(s.events)
  h.events(s.events.slice(2))
  // One that stops at the tool call already answered: taken again, the call would run once more.
  h.events(s.events.slice(1, 4))
  const items = shown(live).slice(1)
  assert.deepEqual(items.map((i) => [i.kind, i.title, i.state]), [['reasoning', 'Thinking', 'done'], ['text', '', 'done'], ['command', 'Ran npm test · exit 1 · 14s', 'done']])
  assert.equal(live.read('run-1').summary.tools, 1)
  now.add(61_000)
  assert.equal(live.activityOf('run-1').open, null, 'the call that came back is not open again')
  assert.doesNotMatch(live.activityOf('run-1').phrase, /Waiting on a command/)
})

test('a tool call streamed in a model call that committed no message never ran: it leaves the timeline and is never open, and the call retried after it is the one shown', () => {
  // Committed as an attempt with no message, or abandoned; cut before or after its call's block ended;
  // retried under a new call id, or under the same one, as a local model's own numbering may give.
  const variants = [
    { outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 0 }, blockEnd: false, sameId: false },
    { outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 0 }, blockEnd: true, sameId: true },
    { outcome: { kind: 'abandoned' }, blockEnd: true, sameId: false },
    { outcome: { kind: 'abandoned' }, blockEnd: false, sameId: true },
  ]
  for (const { outcome, blockEnd, sameId } of variants) {
    const label = JSON.stringify({ outcome: outcome.kind, blockEnd, sameId })
    const now = clock()
    const { live, h } = started({ now })
    const args = JSON.stringify({ command: 'npm test' })
    h.frame(frame.start('llm-1', 1, 1))
    h.frame(frame.chunk('llm-1', 0, { type: 'block-start', index: 0, blockType: 'tool-call' }))
    h.frame(frame.chunk('llm-1', 1, { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'bash', argumentsDelta: args }))
    if (blockEnd) h.frame(frame.chunk('llm-1', 2, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'bash', arguments: args } }))
    h.frame(frame.chunk('llm-1', 3, { type: 'finish', reason: { kind: 'error', failure: { message: 'socket hang up' } } }))
    h.frame({ type: 'end', attemptId: 'llm-1', revision: 1, index: 4, outcome })
    const committed = outcome.kind === 'committed'
    if (committed) h.events([ev(0, 'assistant/attempt', { turn: 1, step: 1, stream: [] })])
    assert.deepEqual(shown(live).filter((i) => i.state === 'running').map((i) => i.title), [], `${label}: nothing of it reads as running`)
    assert.equal(live.activityOf('run-1').open, null, label)
    assert.deepEqual(shown(live).slice(1).map((i) => [i.kind, i.title]), [['error', 'The model call failed: socket hang up']], `${label}: the call's failure is what shows`)
    // The model call is tried again, and its tool call runs and comes back.
    const retry = oneStep({ attemptId: 'llm-2', seq0: committed ? 1 : 0, callId: sameId ? 'call_a' : 'call_b' })
    for (const f of retry.frames) h.frame(f)
    h.events(retry.events)
    assert.deepEqual(shown(live).slice(1).map((i) => [i.kind, i.title, i.state]), [
      ['error', 'The model call failed: socket hang up', 'failed'],
      ['reasoning', 'Thinking', 'done'],
      ['text', '', 'done'],
      ['command', 'Ran npm test · exit 1 · 14s', 'done'],
    ], label)
    assert.equal(live.read('run-1').summary.tools, 1, `${label}: one tool call ran`)
    now.add(61_000)
    assert.doesNotMatch(live.activityOf('run-1').phrase, /Waiting on a command/, label)
  }
})

test('a model call that failed or stopped at its output limit leaves an agent that has worked reading as thinking until the next call streams, never as starting again; before any step of its work it is still starting, and a reviewer still reviewing', () => {
  const failed = { kind: 'error', failure: { code: 'HTTP_503', message: 'Service Unavailable' } }
  // A call DSH tries again after a wait: its failure's own line is the attempt's newest until the
  // next call streams, and it says nothing of what the agent does meanwhile.
  for (const reason of [failed, { kind: 'max-tokens' }]) {
    const label = reason.kind
    const now = clock()
    const { live, h } = started({ now })
    const phrase = () => live.activityOf('run-1').phrase
    assert.equal(phrase(), 'Starting DeepSeek agent...', `${label}: nothing from the agent yet`)
    // Its first call fails before its first token, as a 503 does: still no step of its work.
    h.frame(frame.start('llm-0', 1, 1))
    h.frame(frame.chunk('llm-0', 0, { type: 'finish', reason: failed }))
    h.frame({ type: 'end', attemptId: 'llm-0', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 0 } })
    h.events([ev(0, 'assistant/attempt', { turn: 1, step: 1, stream: [] })])
    assert.equal(phrase(), 'Starting DeepSeek agent...', `${label}: a call that failed is no step of its work`)
    // The call tried again works a step; a later call fails, or stops at the model's output limit.
    const s = oneStep({ attemptId: 'llm-1', seq0: 1 })
    for (const f of s.frames) h.frame(f)
    h.events(s.events)
    h.frame(frame.start('llm-2', 1, 2))
    h.frame(frame.chunk('llm-2', 0, { type: 'block-start', index: 0, blockType: 'text' }))
    h.frame(frame.chunk('llm-2', 1, { type: 'text-delta', index: 0, text: 'Now the lexer' }))
    h.frame(frame.chunk('llm-2', 2, { type: 'finish', reason }))
    const kept = reason.kind !== 'error'
    h.frame({ type: 'end', attemptId: 'llm-2', revision: 1, index: 3, outcome: { kind: 'committed', eventType: kept ? 'assistant/message' : 'assistant/attempt', seq: 6 } })
    h.events([ev(6, kept ? 'assistant/message' : 'assistant/attempt', kept ? assistant(1, 2, [{ type: 'text', text: 'Now the lexer' }]) : { turn: 1, step: 2, stream: [] })])
    assert.match(shown(live).at(-1).title, kept ? /output limit/ : /^The model call failed: Service Unavailable$/, label)
    now.add(5000)
    assert.equal(phrase(), 'Thinking', `${label}: it waits on the model again, as after a call that came back`)
    assert.equal(live.activityOf('run-1').stall, null)
    // The next call says what it does as it streams.
    h.frame(frame.start('llm-3', 1, 2))
    h.frame(frame.chunk('llm-3', 0, { type: 'block-start', index: 0, blockType: 'text' }))
    assert.equal(phrase(), 'Writing', label)
  }
  // A reviewer whose first call failed has still said nothing of the changes: it is reviewing them.
  const { live } = started()
  live.router('run-1', { type: 'attempt_start', index: 1, agent: 'deepseek', role: 'review' })
  const review = live.attempt('run-1', 1)
  review.started({ provider: 'spawn', detail: 'live' })
  assert.equal(live.activityOf('run-1').phrase, 'DeepSeek agent is reviewing the changes')
  review.frame(frame.start('llm-r', 1, 1))
  review.frame(frame.chunk('llm-r', 0, { type: 'finish', reason: failed }))
  review.frame({ type: 'end', attemptId: 'llm-r', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 0 } })
  assert.equal(live.activityOf('run-1').phrase, 'DeepSeek agent is reviewing the changes')
})

test('a tool call whose arguments still stream reads as the kind of call it is: an edit as editing a file and a shell call as running a command, as its row says, never as using a tool', () => {
  /** What a run reads as, and its newest row, while a call of `name` streams `args` and has not ended. */
  const streaming = (name, args) => {
    const { live, h } = started()
    h.frame(frame.start('llm-1', 1, 1))
    h.frame(frame.chunk('llm-1', 0, { type: 'block-start', index: 0, blockType: 'tool-call' }))
    h.frame(frame.chunk('llm-1', 1, { type: 'tool-call-delta', index: 0, id: 'c1', name, argumentsDelta: args.slice(0, 12) }))
    h.frame(frame.chunk('llm-1', 2, { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: args.slice(12) }))
    return { phrase: live.activityOf('run-1').phrase, row: shown(live).at(-1).title }
  }
  // A write's whole new text streams as its arguments, which can take tens of seconds.
  const file = JSON.stringify({ file_path: 'src/app.ts', content: 'export const x = 1\n'.repeat(400) })
  for (const name of ['write', 'edit', 'MultiEdit', 'str_replace_editor']) assert.deepEqual(streaming(name, file), { phrase: 'Editing a file', row: 'Editing a file' }, name)
  for (const name of ['bash', 'Bash', 'shell']) assert.deepEqual(streaming(name, JSON.stringify({ command: 'npm test -- --grep parser' })), { phrase: 'Running a command', row: 'Running a command' }, name)
  // The kinds the phrase table names read as before, and a tool none of them names as its own.
  assert.equal(streaming('read', JSON.stringify({ file_path: 'src/app.ts' })).phrase, 'Reading the code')
  assert.equal(streaming('job_output', JSON.stringify({ id: 'job-1', wait: true })).phrase, 'Using job_output')
})

test('read(after) returns only the items changed since, and v only grows', () => {
  const { live, h } = started()
  const first = live.read('run-1')
  const v0 = live.v
  assert.equal(first.items.length, 1)
  h.frame(frame.start('llm-1', 1, 1))
  h.frame(frame.chunk('llm-1', 0, { type: 'block-start', index: 0, blockType: 'text' }))
  h.frame(frame.chunk('llm-1', 1, { type: 'text-delta', index: 0, text: 'Hel' }))
  const second = live.read('run-1', v0)
  assert.deepEqual(second.items.map((i) => [i.kind, i.text]), [['text', 'Hel']], 'the milestone did not change, so it is not sent again')
  const v1 = live.v
  assert.ok(v1 > v0)
  h.frame(frame.chunk('llm-1', 2, { type: 'text-delta', index: 0, text: 'lo' }))
  const third = live.read('run-1', v1)
  assert.deepEqual(third.items.map((i) => i.text), ['Hello'], 'the item again, whole')
  assert.ok(third.items[0].v > second.items[0].v)
  assert.deepEqual(live.read('run-1', live.v).items, [], 'nothing since the newest v')
})

test('3000 events leave at most maxItems items plus one marker', () => {
  const caps = { items: 100 }
  const { live, h } = started({ caps })
  const list = []
  for (let i = 0; i < 1000; i++) {
    const args = JSON.stringify({ file_path: `src/f${i}.ts` })
    list.push(ev(3 * i, 'tool/call', { turn: 1, step: i, callId: `c${i}`, name: 'read', arguments: args }))
    list.push(ev(3 * i + 1, 'tool/result', toolResult(`c${i}`, 'x')))
    list.push(ev(3 * i + 2, 'step/end', { turn: 1, step: i }))
  }
  h.events(list)
  const run = live.read('run-1')
  assert.equal(run.items.length, caps.items + 1, 'the cap, and the marker')
  assert.equal(run.items[0].id, 'dropped')
  assert.equal(run.items[0].title, `Older steps dropped (${1000 + 1 - caps.items})`, 'one marker, which counts what went, the first milestone among it')
  assert.equal(run.items.at(-1).title, 'Read src/f999.ts', 'the newest kept')
  assert.equal(run.keptFrom, run.items[1].n, 'and where what is kept starts, for a client to drop the rest')
  assert.equal(run.summary.tools, 1000, 'what went is still counted')
  assert.equal(LIVE_CAPS.items, 1500, 'the cap as shipped')
})

test('a 2 MiB output keeps its head and its tail, and a read sends the last 16 KiB with how much came before', () => {
  const { live, h } = started()
  const head = 'HEAD-OF-OUTPUT\n'
  const tail = '\nTAIL-OF-OUTPUT'
  const big = `${head}${'x'.repeat(2 * 1024 * 1024)}${tail}`
  h.events([ev(0, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"cat big.log"}' }), ev(1, 'tool/result', toolResult('c1', big))])
  const it = live.read('run-1').items.at(-1)
  assert.equal(it.text.length, LIVE_CAPS.readChars, 'a read sends the last 16 KiB')
  assert.ok(it.text.endsWith(tail))
  assert.equal(it.clippedBefore, big.length - LIVE_CAPS.readChars, 'and says how much came before it')
  const dir = tmp()
  const saving = createLiveStore({ dir, caps: { readChars: 4 * 1024 * 1024 } })
  saving.open('r', { taskKey: 'k' })
  saving.router('r', { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
  saving.attempt('r', 0).events([ev(0, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"cat big.log"}' }), ev(1, 'tool/result', toolResult('c1', big))])
  const whole = saving.read('r').items.at(-1).text
  assert.ok(whole.startsWith(head), 'the head is kept')
  assert.ok(whole.endsWith(tail), 'and the tail')
  assert.match(whole, /… \d+ characters not kept …/)
  assert.ok(whole.length < 2 * LIVE_CAPS.itemChars + 100, `64 KiB of each, not 2 MiB: ${whole.length}`)
})

test('live runs are never evicted; finished runs are evicted least recently used', () => {
  const live = createLiveStore({ caps: { finished: 2 } })
  for (const id of ['a', 'b', 'c', 'd']) live.open(id, {})
  live.finish('a')
  live.finish('b')
  live.read('a') // a is now used more recently than b
  live.finish('c')
  assert.deepEqual(['a', 'b', 'c', 'd'].filter((id) => live.has(id)), ['a', 'c', 'd'], 'b, the least recently used finished run, went')
  for (let i = 0; i < 50; i++) live.open(`live-${i}`, {})
  assert.ok(live.has('d'), 'a live run stays however many come after it')
  assert.equal(live.stats().live, 51)
  live.finish('d')
  assert.deepEqual(['a', 'c', 'd'].filter((id) => live.has(id)), ['c', 'd'])
})

test('a key-shaped secret is redacted in what is read and what is saved', async () => {
  const dir = tmp()
  const { live, h, now } = started({ dir })
  const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  // Any of the key past its first six characters, whole or cut short.
  const part = /api03-[A-Z0-9]/
  h.frame(frame.start('llm-1', 1, 1))
  h.frame(frame.chunk('llm-1', 0, { type: 'block-start', index: 0, blockType: 'text' }))
  // Split across deltas, as a stream splits it: each piece alone looks like nothing.
  for (const [i, piece] of [`export KEY=${key.slice(0, 9)}`, key.slice(9, 25), `${key.slice(25)} done`].entries()) h.frame(frame.chunk('llm-1', i + 1, { type: 'text-delta', index: 0, text: piece }))
  h.events([ev(0, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: `curl -H "x-api-key: ${key}"` }) }, now())])
  const items = live.read('run-1').items
  const all = JSON.stringify(items)
  assert.doesNotMatch(all, /ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/)
  assert.match(items.find((i) => i.kind === 'text').text, /sk-ant...REDACTED done$/)
  // What the run is doing now quotes the command too, in the work board's line and in what is open,
  // and a minute on in its stall's words: each redacted before it is cut to length.
  const doing = () => JSON.stringify([live.read('run-1').summary, live.activityOfRuns(['run-1'])])
  assert.equal(live.activityOfRuns(['run-1']).phrase, 'Running a command: curl -H "x-api-key: sk-ant...REDACTED"')
  assert.doesNotMatch(doing(), part)
  now.add(LIVE_TIMES.commandMs + 1000)
  assert.equal(live.activityOfRuns(['run-1']).stall.kind, 'command')
  assert.doesNotMatch(doing(), part)
  // A key far into a long command, where the row's own cut would leave part of it, too short to know.
  h.events([ev(1, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: `echo ${'x'.repeat(60)} ${key}` }) })])
  assert.doesNotMatch(JSON.stringify(live.read('run-1')), part)
  live.finish('run-1')
  await live.persist('key-1')
  assert.doesNotMatch(readFileSync(join(dir, 'key-1.jsonl'), 'utf8'), part)
})

test('malformed input raises dropped and never throws', () => {
  const { live, h } = started()
  const bad = [null, undefined, 7, 'frame', {}, { type: 'chunk' }, { type: 'chunk', attemptId: 'x' }, { type: 'chunk', attemptId: 'x', chunk: { type: 'wat' } }, { type: 'chunk', attemptId: 'x', chunk: null }]
  for (const f of bad) assert.doesNotThrow(() => h.frame(f))
  for (const e of [null, 'events', 5, [null], [{ seq: 'one', type: 'tool/call' }], [{ seq: 1 }], [{ seq: 2, type: 'tool/result', data: null }], [{ seq: 3, type: 'assistant/message', data: { message: { content: 'not a list' } } }]]) {
    assert.doesNotThrow(() => h.events(e))
  }
  assert.doesNotThrow(() => live.router('run-1', null))
  assert.doesNotThrow(() => live.router('run-1', { type: 'attempt_end', index: 0, attempt: null }))
  assert.doesNotThrow(() => live.router('nobody', { type: 'routed' }))
  assert.doesNotThrow(() => live.attempt('nobody', 0).frame(frame.start('x', 1, 1)))
  const run = live.read('run-1')
  assert.ok(run.summary.dropped >= 10, `counted: ${run.summary.dropped}`)
  assert.equal(live.stats().dropped, run.summary.dropped)
})

test('deep-frozen input projects without mutation', () => {
  const freeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v) } return o }
  const s = oneStep()
  const frames = freeze(structuredClone(s.frames))
  const events = freeze(structuredClone(s.events))
  const before = JSON.stringify([frames, events])
  const { live, h } = started()
  for (const f of frames) h.frame(f)
  h.events(events)
  assert.equal(JSON.stringify([frames, events]), before)
  assert.equal(live.read('run-1').summary.dropped, 0, 'and nothing failed on the way, as a write into frozen input would')
  assert.deepEqual(shown(live).slice(1).map((i) => i.kind), ['reasoning', 'text', 'command'])
})

test('activityOf with an injected clock gives the exact phrases, the 61 s command words and the 91 s silence words', () => {
  const now = clock()
  const live = createLiveStore({ now })
  live.open('run-1', { taskKey: 'k', decider: 'jev' })
  live.describe('run-1', { names: { deepseek: 'DeepSeek agent', claude: 'Claude Code' }, checks: true, reviewer: 'jev' })
  const phrase = () => live.activityOf('run-1').phrase
  assert.equal(phrase(), 'Choosing the agent (Jev)')
  live.router('run-1', { type: 'routed', routing: { mode: 'jev', decider: 'jev', primaryAgent: 'deepseek' }, primary: { agent: 'deepseek' } })
  assert.equal(phrase(), 'Running your checks before it starts')
  live.router('run-1', { type: 'checks', phase: 'baseline', checks: [{ name: 'test', passed: true }, { name: 'lint', passed: false }] })
  assert.equal(phrase(), 'Starting DeepSeek agent...')
  live.router('run-1', { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
  const h = live.attempt('run-1', 0)
  h.started({ provider: 'spawn', detail: 'live' })
  assert.equal(phrase(), 'Starting DeepSeek agent...', 'nothing from the agent yet')
  const steps = [
    [{ type: 'block-start', index: 0, blockType: 'reasoning' }, 'Thinking'],
    [{ type: 'block-start', index: 1, blockType: 'text' }, 'Writing'],
  ]
  h.frame(frame.start('l1', 1, 1))
  for (const [c, words] of steps) { h.frame(frame.chunk('l1', 0, c)); assert.equal(phrase(), words) }
  const call = (id, name, args, seq) => h.events([ev(seq, 'tool/call', { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) }, now())])
  call('r', 'read', { file_path: 'a.ts' }, 0); assert.equal(phrase(), 'Reading the code')
  call('g', 'grep', { pattern: 'useTasks' }, 1); assert.equal(phrase(), 'Searching the code')
  call('w', 'web_search', { query: 'x' }, 2); assert.equal(phrase(), 'Searching the web')
  call('t', 'task', { description: 'look' }, 3); assert.equal(phrase(), 'Delegating to a sub-agent')
  call('p', 'todo_write', { todos: [{ content: 'a', status: 'pending' }] }, 4); assert.equal(phrase(), 'Planning next steps')
  call('e', 'edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, 5); assert.equal(phrase(), 'Editing src/app.ts')
  const long = 'npm test -- --reporter=dot --grep "the parser keeps every line of a very long input"'
  call('b', 'bash', { command: long }, 6)
  assert.equal(phrase(), `Running a command: ${long.slice(0, 60)}…`, 'its first 60 characters')
  // 61 s on that command: the words of a long command, never "stuck".
  now.add(61_000)
  assert.equal(phrase(), `Waiting on a command for 1m 01s: ${long.slice(0, 60)}…`)
  assert.equal(live.activityOf('run-1').stall.kind, 'command')
  // It comes back, and so does every other call; then 91 s of silence with nothing open.
  h.events([ev(7, 'tool/result', toolResult('b', 'ok'), now())])
  for (const [i, id] of ['r', 'g', 'w', 't', 'p', 'e'].entries()) h.events([ev(8 + i, 'tool/result', toolResult(id, 'ok'), now())])
  assert.equal(phrase(), 'Thinking', 'a call that came back leaves the model reading what it gave')
  now.add(91_000)
  assert.equal(phrase(), 'No news from DeepSeek agent for 1m 31s. It may still be thinking; Stop is on this row.')
  assert.doesNotMatch(phrase(), /stuck/i)
  // The router's phases after the work, in router.js's order: the agent's result is in, the checks
  // run over what it changed, and only then does its attempt end, which the review follows.
  h.end({ stopReason: 'completed' })
  assert.equal(phrase(), 'Running your checks: test, lint')
  now.add(95_000)
  assert.equal(phrase(), 'Running your checks: test, lint', 'its agent is done, so it is never said to be silent while the checks run')
  assert.equal(live.activityOf('run-1').stall, null)
  live.router('run-1', { type: 'attempt_end', index: 0, attempt: { agent: 'deepseek', role: 'primary', stopReason: 'completed', changedFiles: ['src/app.ts'] } })
  assert.equal(phrase(), 'Jev is reviewing the changes', 'the checks ran before the attempt\'s end, so the review comes after it')
  live.router('run-1', { type: 'review', index: 0, assessment: { action: 'retry', why: 'tests fail' } })
  live.router('run-1', { type: 'attempt_start', index: 1, agent: 'claude', role: 'retry' })
  const off = live.attempt('run-1', 1)
  off.started({ provider: 'claude-code', detail: 'off', why: 'no live hook into Claude Code in this build' })
  assert.equal(phrase(), 'Working (live detail is off for Claude Code)')
  // An agent this build cannot hear is done once its result is in, as one it hears is.
  off.end({ stopReason: 'completed' })
  assert.equal(phrase(), 'Running your checks: test, lint')
  live.router('run-1', { type: 'attempt_end', index: 1, attempt: { agent: 'claude', role: 'retry', stopReason: 'completed', changedFiles: [] } })
  assert.equal(phrase(), 'Jev is reviewing the changes', 'nothing changed, so the checks were skipped, and the review comes next')
  live.router('run-1', { type: 'attempt_start', index: 2, agent: 'tool:lint', role: 'tool' })
  assert.equal(phrase(), 'Running the lint tool')
  live.router('run-1', { type: 'final', status: 'accepted' })
  now.add(5_000)
  live.finish('run-1')
  const done = live.activityOf('run-1')
  assert.equal(done.phrase, `Done in ${spanWords(done.elapsedMs)}`)
  assert.deepEqual(done.done, { status: 'accepted', label: 'Completed', ms: done.elapsedMs })
  assert.equal(spanWords(185_000), '3m 05s')
  assert.equal(spanWords(45_400), '45s')
  assert.equal(spanWords(3_725_000), '1h 02m')
  assert.equal(stallOf({ open: null, lastAgentAt: 0, agent: 'X', live: false }, 200_000), null, 'an agent this build cannot hear is never said to be silent')
})

test('a call of any tool still running holds back the silence words as a command does, since the agent waits on it rather than thinks: a sub-agent, a fetch, a job it waits for; once it comes back, 91 s of silence reads as before', () => {
  const calls = [
    ['subagent', { prompt: 'Look at the lexer.', run_in_background: false }, 'Delegating to a sub-agent'],
    ['web_fetch', { url: 'https://example.com/spec' }, 'Searching the web'],
    ['job_output', { id: 'job-1', wait: true }, 'Using job_output'],
  ]
  for (const [name, args, words] of calls) {
    const now = clock()
    const { live, h } = started({ now })
    const a = JSON.stringify(args)
    // Its session commits nothing between the call and its result, and nothing streams meanwhile.
    h.events([ev(0, 'assistant/message', assistant(1, 1, [{ type: 'tool-call', id: 'c1', name, arguments: a }])), ev(1, 'tool/call', { turn: 1, step: 1, callId: 'c1', name, arguments: a }, now())])
    now.add(100_000)
    const waiting = live.activityOf('run-1')
    assert.deepEqual([waiting.phrase, waiting.stall, waiting.busy, waiting.open], [words, null, true, null], `${name}: still waiting on its call, which is no command`)
    h.events([ev(2, 'tool/result', toolResult('c1', 'done'), now())])
    assert.equal(live.activityOf('run-1').busy, false, name)
    now.add(91_000)
    assert.equal(live.activityOf('run-1').phrase, 'No news from DeepSeek agent for 1m 31s. It may still be thinking; Stop is on this row.', name)
  }
  // A call streamed but never made (its arguments still coming) is no call it waits on.
  const now = clock()
  const { live, h } = started({ now })
  h.frame(frame.start('llm-1', 1, 1))
  h.frame(frame.chunk('llm-1', 0, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'subagent', argumentsDelta: '{"prompt":' }))
  assert.equal(live.activityOf('run-1').busy, false)
  now.add(91_000)
  assert.match(live.activityOf('run-1').phrase, /^No news from DeepSeek agent for 1m 31s\./)
  assert.equal(stallOf({ open: null, lastAgentAt: 0, agent: 'X', live: true, busy: true }, 200_000), null, 'the store\'s rule, as the browser has it')
})

test('once an attempt\'s agent is done the run says what router.js does next: the review, the work after a plan, the end of an answer, and a parallel opinion still at work keeps it at the attempt', () => {
  const run = (facts, role = 'primary') => {
    const live = createLiveStore()
    live.open('r', { decider: 'jev' })
    live.describe('r', { names: { deepseek: 'DeepSeek agent', codex: 'Codex' }, reviewer: 'jev', checks: false, ...facts })
    live.router('r', { type: 'routed', routing: { mode: 'jev', decider: 'jev', primaryAgent: 'deepseek' }, primary: { agent: 'deepseek' } })
    live.router('r', { type: 'attempt_start', index: 0, agent: 'deepseek', role })
    const h = live.attempt('r', 0)
    h.started({ detail: 'live' })
    return { live, h, phrase: () => live.activityOf('r').phrase }
  }
  const after = (facts, role) => { const r = run(facts, role); r.h.end({ stopReason: 'completed' }); return r.phrase() }
  assert.equal(after({}), 'Jev is reviewing the changes', 'no checks were named, so the review is next')
  assert.equal(after({ reviewer: null }, 'retry'), 'Checking the changes', 'offline the checks alone decide')
  assert.equal(after({}, 'review'), 'Jev is reviewing the changes', 'the decider reads what the reviewer said')
  assert.equal(after({}, 'plan'), 'Starting DeepSeek agent...', 'a plan step goes on to the work')
  assert.equal(after({ answerOnly: true }), 'Finishing')
  // An answer with a parallel opinion: the run stays at its attempt until both agents are done.
  const two = run({ answerOnly: true })
  two.live.router('r', { type: 'attempt_start', index: 1, agent: 'codex', role: 'opinion' })
  const side = two.live.attempt('r', 1)
  side.started({ detail: 'live' })
  two.h.end({ stopReason: 'completed' })
  assert.notEqual(two.phrase(), 'Finishing', 'the opinion is still at work')
  side.end({ stopReason: 'completed' })
  assert.equal(two.phrase(), 'Finishing')
})

test('the router\'s milestones say who picked, the checks, the review and a limit, in the run\'s own words', () => {
  const { live } = started({ checks: true })
  live.router('run-1', { type: 'checks', phase: 'baseline', checks: [{ name: 'test', passed: true }] })
  live.router('run-1', { type: 'attempt_end', index: 0, attempt: { agent: 'deepseek', role: 'primary', stopReason: 'completed', changedFiles: ['a'] } })
  live.router('run-1', { type: 'review', index: 0, assessment: { action: 'retry', why: 'the tests fail after the change' } })
  live.router('run-1', { type: 'limit', agent: 'claude', action: 'peer' })
  live.router('run-1', { type: 'error', message: 'handoff not saved: EACCES' })
  const router = live.read('run-1').items.filter((i) => i.router)
  assert.deepEqual(router.map((i) => [i.title, i.attempt]), [
    ['Picked by Jev: DeepSeek agent', null],
    ['Checks before start: test pass', null],
    ['Review: changes requested', 0],
    ['Claude Code hit its usage limit: handing the task to another agent', 0],
    ['Error: handoff not saved: EACCES', 0],
  ])
  assert.equal(router[2].text, 'the tests fail after the change')
  // Forced, by the routing rules, and on this PC with no call: each says so.
  const who = (routing, called) => {
    const l = createLiveStore()
    l.open('r', {})
    l.describe('r', { names: { codex: 'Codex' } })
    if (called) l.router('r', { type: 'decider-error', error: {} })
    l.router('r', { type: 'routed', routing: { decider: 'jev', primaryAgent: 'codex', ...routing }, primary: { agent: 'codex' } })
    return l.read('r').items[0].title
  }
  assert.equal(who({ mode: 'manual' }), 'You picked Codex')
  assert.equal(who({ mode: 'fallback' }), 'Picked by the routing rules: Codex')
  assert.equal(who({ mode: 'offline' }, false), 'Picked on this PC: Codex')
  assert.equal(who({ mode: 'jev', decision: { domains: { a: { authority: 'local' } } } }, true), 'Picked on this PC: Codex')
  const stop = createLiveStore()
  stop.open('r', {})
  stop.router('r', { type: 'routed', stopsForPerson: true, routing: { decider: 'jev' } })
  assert.equal(stop.read('r').items[0].title, 'Jev read this as needing a person: no agent runs')
})

test('the heartbeat: a windowed token rate that falls to 0 while nothing streams, and how long it has been quiet', () => {
  const now = clock()
  const { live, h } = started({ now })
  h.frame(frame.start('l1', 1, 1))
  h.frame(frame.chunk('l1', 0, { type: 'block-start', index: 0, blockType: 'text' }))
  for (let i = 0; i < 10; i++) { h.frame(frame.chunk('l1', i + 1, { type: 'text-delta', index: 0, text: 'abcdefgh' })); now.add(100) }
  const streaming = live.activityOf('run-1')
  assert.equal(streaming.rate, 10, '80 characters, about 20 tokens, over the last 2 s')
  assert.equal(streaming.fresh, true)
  now.add(LIVE_TIMES.rateMs + 1)
  const quiet = live.activityOf('run-1')
  assert.equal(quiet.rate, 0, 'nothing in the window')
  assert.equal(quiet.quietMs, 100 + LIVE_TIMES.rateMs + 1, 'since the last delta')
  assert.equal(quiet.fresh, true, 'its newest change is still under 5 s old')
  now.add(10_000)
  const still = live.activityOf('run-1')
  assert.ok(still.quietMs > LIVE_TIMES.quietMs, 'quiet for over 10 s, which the activity line says')
  assert.equal(still.fresh, false)
  // An agent whose stream this build cannot read has no rate at all, rather than one of 0.
  live.router('run-1', { type: 'attempt_start', index: 1, agent: 'claude', role: 'retry' })
  live.attempt('run-1', 1).started({ detail: 'off' })
  assert.equal(live.activityOf('run-1').rate, null)
})

test('while an agent works whose steps this build cannot hear, the run says it is not heard, so its quiet is never taken for that agent\'s', () => {
  const now = clock()
  const { live } = started({ now })
  assert.equal(live.activityOf('run-1').heard, true, 'a stream this build reads')
  live.router('run-1', { type: 'attempt_start', index: 1, agent: 'claude', role: 'retry' })
  const off = live.attempt('run-1', 1)
  off.started({ provider: 'claude-code', detail: 'off', why: 'no hook' })
  now.add(302_000)
  assert.equal(live.activityOf('run-1').heard, false)
  off.end({ stopReason: 'completed' })
  assert.equal(live.activityOf('run-1').heard, true, 'its result is in, and the router\'s steps, which are heard, are what the run does now')
  live.router('run-1', { type: 'attempt_start', index: 2, agent: 'tool:lint', role: 'tool' })
  assert.equal(live.activityOf('run-1').heard, false, 'nor is a tool\'s own run heard')
})

test('the activity of a task\'s runs: its newest run\'s phrase with the tool calls and tokens of them all, and its last six items', () => {
  const { live, h } = started()
  h.events(oneStep().events)
  live.finish('run-1')
  live.open('run-2', { taskKey: 'key-1' })
  live.describe('run-2', { names: { deepseek: 'DeepSeek agent' } })
  live.router('run-2', { type: 'routed', routing: { mode: 'manual', decider: 'jev', primaryAgent: 'deepseek' }, primary: { agent: 'deepseek' } })
  live.router('run-2', { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
  const h2 = live.attempt('run-2', 0)
  h2.started({ detail: 'live' })
  h2.events(oneStep({ callId: 'call-9', command: 'npm run lint' }).events)
  h2.events(oneStep({ turn: 2, seq0: 5, callId: 'call-10', command: 'npm run build' }).events)
  const a = live.activityOfRuns(['run-1', 'run-2', 'gone'])
  assert.equal(a.tools, 3)
  assert.equal(a.tokens, 4500)
  assert.equal(a.phrase, 'Thinking')
  assert.deepEqual(a.recent.map((r) => r.title), ['Thinking', 'Running the tests.', 'Ran npm run lint · exit 1 · 14s', 'Thinking', 'Running the tests.', 'Ran npm run build · exit 1 · 14s'], 'the newest six of its seven: You picked DeepSeek agent is the one left out')
  assert.equal(live.activityOfRuns(['gone']), null)
  assert.equal(live.activityOfRuns(null), null)
})

test('a finished task\'s activity took the time of each of its passes, its time in line between them left out, as the Live tab\'s end line counts it', () => {
  const now = clock()
  const live = createLiveStore({ now })
  for (const [runId, ms, status] of [['read-pass', 120_000, 'needs_write'], ['writer', 300_000, 'accepted']]) {
    live.open(runId, { taskKey: 'key-1' })
    now.add(ms)
    live.finish(runId, { status })
    // In its folder's line before the pass that writes starts.
    now.add(30_000)
  }
  const a = live.activityOfRuns(['read-pass', 'writer'])
  assert.deepEqual(a.done, { status: 'accepted', label: 'Completed', ms: 420_000 })
  assert.equal(a.elapsedMs, 420_000)
  assert.equal(a.phrase, 'Done in 7m 00s')
  assert.deepEqual(live.activityOfRuns(['read-pass']).done, { status: 'needs_write', label: 'Handed back to its folder\'s line', ms: 120_000 }, 'a pass alone took its own time')
})

test('a task\'s done line counts a pass the store has let go of while the task waited in line, its time, tool calls and tokens, as the Live tab\'s end line counts it from the saved transcript', async () => {
  const dir = tmp()
  const now = clock()
  const live = createLiveStore({ dir, now, caps: { finished: 1 } })
  const pass = (runId, ms, steps, status) => {
    live.open(runId, { taskKey: 'key-1' })
    live.router(runId, { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
    const h = live.attempt(runId, 0)
    h.started({ provider: 'spawn', detail: 'live' })
    for (let i = 0; i < steps; i++) h.events(oneStep({ seq0: 5 * i, callId: `c${i}`, command: `npm run step-${i}` }).events)
    now.add(ms)
    live.finish(runId, { status })
  }
  pass('read-pass', 60_000, 1, 'needs_write')
  await live.persist('key-1')
  // In its folder's line while other runs come and go: the store lets the read pass go.
  now.add(30_000)
  for (const id of ['other-1', 'other-2']) { live.open(id, { taskKey: 'key-2' }); live.finish(id) }
  assert.equal(live.has('read-pass'), false)
  pass('writer', 30_000, 2, 'accepted')
  await live.persist('key-1')
  const a = live.activityOfRuns(['read-pass', 'writer'])
  assert.deepEqual(a.done, { status: 'accepted', label: 'Completed', ms: 90_000 }, 'both passes, its time in line left out')
  assert.deepEqual([a.phrase, a.elapsedMs, a.tools, a.tokens], ['Done in 1m 30s', 90_000, 3, 4500])
  // The Live tab adds up the passes it reads: the read pass from its saved transcript, the writer as the store holds it.
  const saved = (await live.load('key-1')).runs.find((r) => r.runId === 'read-pass')
  assert.equal(saved.summary.done.ms + live.read('writer').summary.done.ms, a.done.ms)
  // What is kept of a pass let go of leaves with its task.
  await live.drop('key-1')
  assert.equal(live.activityOfRuns(['read-pass', 'writer']).done.ms, 30_000)
  // And it is bounded: past its cap, the pass let go of longest ago is no longer counted.
  const at = clock()
  const small = createLiveStore({ now: at, caps: { finished: 1, spent: 1 } })
  for (const [id, ms] of [['p1', 1000], ['p2', 2000], ['p3', 4000]]) { small.open(id, { taskKey: 'k' }); at.add(ms); small.finish(id) }
  assert.deepEqual(['p1', 'p2', 'p3'].map((id) => small.has(id)), [false, false, true])
  assert.equal(small.activityOfRuns(['p1', 'p2', 'p3']).done.ms, 6000, 'p3 as held, p2 as kept, p1 forgotten')
})

test('persist and load round-trip, with a truncated last line skipped, and drop deletes the file', async () => {
  const dir = tmp()
  const { live, h } = started({ dir })
  h.events(oneStep().events)
  live.router('run-1', { type: 'final', status: 'accepted' })
  live.finish('run-1')
  await live.persist('key-1')
  const file = join(dir, 'key-1.jsonl')
  const saved = await createLiveStore({ dir }).load('key-1')
  assert.equal(saved.runs.length, 1)
  const [run] = saved.runs
  const fresh = live.read('run-1')
  assert.deepEqual(run.items.map((i) => [i.kind, i.title, i.text]), fresh.items.map((i) => [i.kind, i.title, i.text]))
  assert.deepEqual(run.summary.done, fresh.summary.done)
  assert.deepEqual(run.attempts.map((a) => a.name), ['DeepSeek agent'])
  // A crash in the middle of the last line.
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  writeFileSync(file, `${lines.join('\n')}\n${lines.at(-1).slice(0, 20)}`)
  const cut = await createLiveStore({ dir }).load('key-1')
  assert.equal(cut.runs[0].items.length, run.items.length, 'the cut line is passed over, and the rest read')
  assert.equal(await createLiveStore({ dir }).load('no-such-task'), null)
  await live.drop('key-1')
  assert.equal(existsSync(file), false)
  assert.equal(await live.load('key-1'), null)
})

test('a store disposed of saves and deletes nothing, and what it was asked meanwhile is done as a plugin applied again reopens it, a delete never undone by a later save', async () => {
  const dir = tmp()
  const { live, h } = started({ dir })
  h.events(oneStep().events)
  await live.dispose()
  // The run ends after the plugin closed, before the one applied again has taken its task over.
  live.router('run-1', { type: 'final', status: 'accepted' })
  live.finish('run-1')
  await live.persist('key-1')
  const file = join(dir, 'key-1.jsonl')
  assert.equal(existsSync(file), false, 'nothing is saved while the store is disposed of')
  assert.equal(typeof live.reopen, 'function', 'a store the plugin applied again goes on with is reopened')
  live.reopen()
  await live.flushed()
  assert.equal((await live.load('key-1'))?.runs.length, 1, 'the save it was asked for meanwhile is made as it reopens')
  // A task that left the list meanwhile is deleted, whatever save was asked for after.
  await live.dispose()
  await live.drop('key-1')
  await live.persist('key-1')
  assert.equal(existsSync(file), true, 'nor is anything deleted while the store is disposed of')
  live.reopen()
  await live.flushed()
  assert.equal(existsSync(file), false)
})

test('a saved transcript stays within its cap: the oldest items go first, and a line says how many', async () => {
  const dir = tmp()
  const { live, h } = started({ dir, caps: { savedBytes: 8 * 1024 } })
  const list = []
  for (let i = 0; i < 200; i++) list.push(ev(2 * i, 'tool/call', { turn: 1, step: i, callId: `c${i}`, name: 'bash', arguments: JSON.stringify({ command: `echo ${i}` }) }), ev(2 * i + 1, 'tool/result', toolResult(`c${i}`, `line ${i}\n`.repeat(20))))
  h.events(list)
  live.finish('run-1')
  await live.persist('key-1')
  const raw = readFileSync(join(dir, 'key-1.jsonl'), 'utf8')
  assert.ok(Buffer.byteLength(raw) <= 8 * 1024, `${Buffer.byteLength(raw)} bytes`)
  const back = await live.load('key-1')
  assert.ok(back.dropped > 100, `${back.dropped} left out`)
  assert.equal(back.runs[0].items.at(-1).title, 'Ran echo 199', 'the newest kept')
})

test('a pass the store let go of keeps its saved steps when its task saves again: the save builds on the file, in the order the passes ran, within the cap', async () => {
  const dir = tmp()
  const now = clock()
  const live = createLiveStore({ dir, now, caps: { finished: 1, savedBytes: 16 * 1024 } })
  const pass = (runId, n, word) => {
    now.add(1000)
    live.open(runId, { taskKey: 'key-1' })
    live.router(runId, { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
    const list = []
    for (let i = 0; i < n; i++) list.push(ev(2 * i, 'tool/call', { turn: 1, step: i, callId: `c${i}`, name: 'bash', arguments: JSON.stringify({ command: `${word} ${i}` }) }), ev(2 * i + 1, 'tool/result', toolResult(`c${i}`, `line ${i}\n`.repeat(20))))
    live.attempt(runId, 0).events(list)
  }
  const file = join(dir, 'key-1.jsonl')
  const rows = () => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  pass('read-pass', 60, 'cat')
  live.router('read-pass', { type: 'access', mode: 'write', from: 'read', why: 'it needs to change files' })
  live.finish('read-pass')
  await live.persist('key-1')
  const leftBefore = rows().find((r) => r.t === 'run').left
  assert.ok(leftBefore > 0, 'the read pass alone is over the cap, so its oldest steps are left out, and its line says how many')
  // The task waits in its folder's line while other runs come and go, and the read pass is let go.
  pass('writer', 5, 'echo')
  for (const id of ['other-1', 'other-2']) { live.open(id, { taskKey: 'key-2' }); live.finish(id) }
  assert.equal(live.has('read-pass'), false, 'the read pass is no longer held')
  live.finish('writer')
  await live.persist('key-1')
  const back = await createLiveStore({ dir }).load('key-1')
  assert.deepEqual(back?.runs.map((r) => r.runId), ['read-pass', 'writer'], 'both passes, in the order they ran')
  assert.equal(back.runs[0].summary.done.label, 'Handed back to its folder\'s line')
  assert.equal(back.runs[0].items.filter((i) => !i.router).at(-1).title, 'Ran cat 59', 'the read pass\'s steps, as its own save left them')
  assert.deepEqual(back.runs[1].items.map((i) => i.title), [0, 1, 2, 3, 4].map((i) => `Ran echo ${i}`), 'and the writer\'s whole: the oldest steps go first')
  const heads = rows().filter((r) => r.t === 'run')
  assert.ok(heads[0].left > leftBefore, `what was left out of the read pass stays out, and more with it: ${heads[0].left}`)
  assert.equal(heads[1].left, undefined)
  assert.equal(back.dropped, heads[0].left, 'and the file says how many in all')
  assert.ok(Buffer.byteLength(readFileSync(file, 'utf8')) <= 16 * 1024)
})

const fsp = createRequire(import.meta.url)('node:fs/promises')
/**
 * Run `fn` with `name` of node:fs/promises replaced by `fake(real)`, as every module that imports it
 * sees it: syncBuiltinESMExports carries the swap over to the named imports live.js holds.
 */
async function swapped(name, fake, fn) {
  const real = fsp[name]
  fsp[name] = fake(real)
  syncBuiltinESMExports()
  try { return await fn() } finally {
    fsp[name] = real
    syncBuiltinESMExports()
  }
}

test('a saved transcript a save cannot read is left as it is, rather than written over with only the passes the store holds, and the log says why; the next save that reads it keeps every pass', async () => {
  const dir = tmp()
  const now = clock()
  const logs = []
  const live = createLiveStore({ dir, now, caps: { finished: 1 }, log: (m) => logs.push(m) })
  const pass = (runId, command) => {
    live.open(runId, { taskKey: 'key-1' })
    live.router(runId, { type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
    live.attempt(runId, 0).events(oneStep({ command }).events)
    now.add(1000)
    live.finish(runId)
  }
  const file = join(dir, 'key-1.jsonl')
  pass('read-pass', 'cat src/parse.js')
  await live.persist('key-1')
  const before = readFileSync(file, 'utf8')
  // The read pass is let go of while its task waits in line, and the pass that writes ends.
  for (const id of ['other-1', 'other-2']) { live.open(id, { taskKey: 'key-2' }); live.finish(id) }
  assert.equal(live.has('read-pass'), false)
  pass('writer', 'npm test')
  // As the save reads the file, something holds it (an antivirus on Windows answers EBUSY).
  await swapped('readFile', (real) => async (path, ...rest) => {
    if (String(path) === file) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return real(path, ...rest)
  }, () => live.persist('key-1'))
  assert.equal(readFileSync(file, 'utf8'), before, 'the read pass is still on disk, as its own save left it')
  assert.ok(logs.some((m) => /^live transcript of key-1: not saved, since the one already there could not be read: EBUSY/.test(m)), logs.join('\n'))
  await live.persist('key-1')
  assert.deepEqual((await createLiveStore({ dir }).load('key-1')).runs.map((r) => r.runId), ['read-pass', 'writer'])
})

test('a task\'s saves and its delete land one after another, in the order asked: a delete asked while a save is still being written leaves no file, and a save asked while another is written builds on it', async () => {
  const dir = tmp()
  const file = join(dir, 'key-1.jsonl')
  // A run ends and is saved, and the task is cleared at once, before the save has landed.
  const { live, h } = started({ dir })
  h.events(oneStep().events)
  live.finish('run-1')
  const saving = live.persist('key-1')
  const dropping = live.drop('key-1')
  await live.flushed()
  assert.equal(existsSync(file), false, 'the save landed, and then the delete')
  await Promise.all([saving, dropping])
  assert.equal(existsSync(file), false)
  // Two saves of one task, the second asked while the first is written, its pass let go of meanwhile.
  const other = createLiveStore({ dir, caps: { finished: 1 } })
  other.open('a', { taskKey: 'key-1' })
  other.finish('a')
  const first = other.persist('key-1')
  other.open('b', { taskKey: 'key-1' })
  other.finish('b')
  assert.equal(other.has('a'), false)
  await Promise.all([first, other.persist('key-1')])
  assert.deepEqual((await other.load('key-1')).runs.map((r) => r.runId), ['a', 'b'], 'the second read what the first wrote')
})

test('the words of a tool row and of a phrase, by the names DSH and Claude Code give their tools', () => {
  assert.deepEqual(['read', 'Read', 'LS', 'grep', 'Glob', 'edit', 'MultiEdit', 'write', 'str_replace_editor', 'bash', 'Bash', 'web_fetch', 'WebSearch', 'Task', 'TodoWrite', 'mystery'].map(toolKindOf),
    ['read', 'read', 'read', 'search', 'search', 'edit', 'edit', 'edit', 'edit', 'command', 'command', 'web', 'web', 'delegate', 'plan', 'other'])
  assert.equal(toolTitle('read', { file_path: 'src/app.ts' }), 'Read src/app.ts')
  assert.equal(toolTitle('grep', '{"pattern":"useTasks"}'), 'Searched for useTasks')
  assert.equal(toolTitle('bash', { command: 'npm test' }, false), 'Running npm test')
  assert.equal(toolTitle('mystery', { thing: 'x' }), 'mystery x')
  assert.equal(phraseOf({ kind: 'text', state: 'running', meta: {} }), 'Writing')
  assert.equal(phraseOf({ kind: 'command', state: 'done', meta: { command: 'x' } }), 'Thinking')
  assert.equal(phraseOf(null), null)
})

// ---- Claude Code and Codex, through the engine patch (scripts/patch-agent-live.mjs) ---------------

/** A store with one run whose first attempt is `agent` on `provider`, its connector patched: the attempt's handle and its tap. */
function patchedRun(agent, provider, { now = clock(), caps, dir } = {}) {
  const live = createLiveStore({ now, caps, dir })
  live.open('run-1', { taskKey: 'key-1', sessionId: 'chat-1', decider: 'jev' })
  live.describe('run-1', { names: { claude: 'Claude Code', codex: 'Codex' }, checks: false, reviewer: 'jev' })
  live.router('run-1', { type: 'routed', routing: { mode: 'jev', decider: 'jev', primaryAgent: agent, decision: { domains: { task_classification: { authority: 'jev' } } } }, primary: { agent, model: 'asked-for', effort: 'high' } })
  live.router('run-1', { type: 'attempt_start', index: 0, agent, role: 'primary', effort: 'high' })
  const h = live.attempt('run-1', 0)
  h.started({ provider, model: 'asked-for', detail: 'live' })
  return { live, h, now, tap: typeof live.tapFor === 'function' ? live.tapFor(h) : null }
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) } return o }
const steps = (live) => live.read('run-1').items.filter((i) => !i.router && !i.meta.hidden)

// What the Claude Code CLI streams through the Agent SDK (sdk.d.ts SDKMessage), in a run's order.
const cc = {
  init: () => ({ type: 'system', subtype: 'init', session_id: 's', uuid: 'u0', model: 'claude-opus-4-1', apiKeySource: 'none', cwd: '/w', tools: ['Bash', 'Edit'], mcp_servers: [], permissionMode: 'acceptEdits', slash_commands: [], output_style: 'default', skills: [], claude_code_version: '2.1.0' }),
  retry: () => ({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 5000, error_status: 529, error: 'overloaded', session_id: 's', uuid: 'u1' }),
  ev: (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's', uuid: 'ev' }),
  whole: (id, block, stop = null, usage = undefined) => ({ type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: `a-${id}`, message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-1', content: [block], stop_reason: stop, ...(usage ? { usage } : {}) } }),
  results: (id, content, isError, data) => ({ type: 'user', parent_tool_use_id: null, session_id: 's', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, tool_use_result: data }),
}
const claudeRun = () => [
  cc.init(),
  cc.retry(),
  cc.ev({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1000, cache_read_input_tokens: 5000 } } }),
  cc.ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
  cc.ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me look.' } }),
  cc.ev({ type: 'content_block_stop', index: 0 }),
  cc.ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  cc.ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'I will fix ' } }),
  cc.ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'it.' } }),
  cc.ev({ type: 'content_block_stop', index: 1 }),
  cc.ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} } }),
  cc.ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/app.ts",' } }),
  cc.ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"old_string":"a","new_string":"b"}' } }),
  cc.ev({ type: 'content_block_stop', index: 2 }),
  cc.ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 200 } }),
  cc.ev({ type: 'message_stop' }),
  cc.whole('msg_1', { type: 'thinking', thinking: 'Let me look.', signature: 'x' }),
  cc.whole('msg_1', { type: 'text', text: 'I will fix it.' }),
  cc.whole('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' } }, 'tool_use', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 }),
  { type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Edit', parent_tool_use_id: null, elapsed_time_seconds: 2, session_id: 's', uuid: 'p1' },
  cc.results('toolu_1', 'The file src/app.ts has been updated.', false, { filePath: 'src/app.ts', oldString: 'a', newString: 'b', originalFile: 'x\na\n', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-a', '+b'] }], userModified: false, replaceAll: false }),
  // The CLI counts thinking it does not share before the next call is named.
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1234, estimated_tokens_delta: 1234, session_id: 's', uuid: 't1' },
  cc.ev({ type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 500 } } }),
  cc.ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} } }),
  cc.ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } }),
  cc.ev({ type: 'content_block_stop', index: 0 }),
  cc.ev({ type: 'message_stop' }),
  cc.whole('msg_2', { type: 'thinking', thinking: '', signature: 'y' }),
  cc.whole('msg_2', { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } }, 'tool_use'),
  cc.results('toolu_2', 'Exit code 1\nFAIL 1 test', true, { stdout: 'FAIL 1 test', stderr: '', interrupted: false }),
  cc.ev({ type: 'message_start', message: { id: 'msg_3' } }),
  cc.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  cc.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
  cc.ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }),
  cc.whole('msg_3', { type: 'text', text: 'Done.' }, 'end_turn'),
  { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's', uuid: 'res', num_turns: 3, duration_ms: 9000, duration_api_ms: 8000, stop_reason: 'end_turn', total_cost_usd: 0.5, usage: {}, permission_denials: [], modelUsage: { 'claude-opus-4-1': { inputTokens: 3000, outputTokens: 900, cacheReadInputTokens: 20000, cacheCreationInputTokens: 1000, webSearchRequests: 0, costUSD: 0.5, contextWindow: 200000, maxOutputTokens: 32000 } } },
]

test('Claude Code through the engine patch: init, a retry, streamed thinking, text and tool calls, an edit\'s patch, a command\'s output, tool progress, counted thinking and the result project to the expected items, read and never written to', () => {
  const { live, h, tap } = patchedRun('claude', 'claude-code')
  assert.equal(typeof live.tapFor, 'function', 'the store hands out a tap per attempt')
  const messages = deepFreeze(claudeRun())
  const phrases = {}
  // What streams shows as it comes, before the whole message replaces it.
  const streamed = {}
  const ofKind = (kind) => steps(live).filter((x) => x.kind === kind).map((x) => [x.title, x.text, x.state])
  for (const [i, m] of messages.entries()) {
    tap({ provider: 'claude-code', message: m })
    if (i === 1) phrases.retry = live.activityOf('run-1').phrase
    if (i === 4) streamed.thinking = ofKind('reasoning')
    if (i === 8) streamed.text = ofKind('text')
    if (i === 12) phrases.streamingEdit = live.activityOf('run-1').phrase
    if (i === 13) streamed.edit = ofKind('file')
    if (i === 18) phrases.edit = live.activityOf('run-1').phrase
    if (i === 28) phrases.command = live.activityOf('run-1').phrase
  }
  assert.deepEqual(phrases, { retry: 'Retrying the model (attempt 2, in 5 s)', streamingEdit: 'Editing a file', edit: 'Editing src/app.ts', command: 'Running a command: npm test' })
  assert.deepEqual(streamed, {
    thinking: [['Thinking', 'Let me look.', 'running']],
    text: [['', 'I will fix it.', 'running']],
    edit: [['Editing src/app.ts', '', 'running']],
  }, 'thinking and text as their deltas come, and a call named by its streamed arguments once they are whole')
  const read = live.read('run-1')
  assert.equal(read.summary.dropped, 0, 'every message was read, none written into')
  assert.deepEqual(steps(live).map((i) => [i.kind, i.title, i.state]), [
    ['status', 'Model: claude-opus-4-1', 'done'],
    ['status', 'Retrying the model (attempt 2, in 5 s)', 'done'],
    ['reasoning', 'Thinking', 'done'],
    ['text', '', 'done'],
    ['file', 'Edited src/app.ts +1 -1', 'done'],
    ['reasoning', 'Thinking', 'done'],
    ['command', 'Ran npm test · exit 1', 'failed'],
    ['text', '', 'done'],
  ])
  const [, , think, said, edit, counted, command, answer] = steps(live)
  assert.equal(think.text, 'Let me look.')
  assert.equal(said.text, 'I will fix it.', 'the whole message replaces what streamed')
  assert.equal(edit.text, '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n x\n-a\n+b')
  assert.deepEqual([edit.meta.plus, edit.meta.minus, edit.meta.elapsedMs], [1, 1, 2000])
  assert.deepEqual([counted.text, counted.meta.tokens], ['', 1234], 'thinking it only counted: Thinking... (about 1.2k tokens)')
  assert.equal(command.text, 'FAIL 1 test')
  assert.deepEqual([answer.text, answer.meta.final], ['Done.', true])
  assert.equal(read.attempts[0].model, 'claude-opus-4-1', 'the model the CLI says served it')
  assert.deepEqual([read.summary.tools, read.summary.tokens, read.summary.model], [2, 24_900, 'claude-opus-4-1'])
  assert.deepEqual(h.usage(), { usage: { inputTokens: 3000, outputTokens: 900, cacheReadTokens: 20_000, cacheWriteTokens: 1000, totalTokens: 24_900 }, apiEquivalentUsd: 0.5, servedModel: 'claude-opus-4-1' })
})

test('Claude Code through the engine patch: on an API key the result\'s cost is money spent, a sub-agent\'s own messages stay under its Task call, a file Write made reads as lines added, and until the result the calls\' own counts are the tokens', () => {
  const { live, h, tap } = patchedRun('claude', 'claude-code')
  assert.equal(typeof live.tapFor, 'function')
  tap({ provider: 'claude-code', message: { ...cc.init(), apiKeySource: 'ANTHROPIC_API_KEY' } })
  tap({ provider: 'claude-code', message: cc.whole('msg_1', { type: 'tool_use', id: 'toolu_t', name: 'Task', input: { description: 'Find the config', prompt: 'Look for it' } }, 'tool_use', { input_tokens: 100, output_tokens: 20 }) })
  tap({ provider: 'claude-code', message: { ...cc.whole('msg_sub', { type: 'text', text: 'Searching inside.' }), parent_tool_use_id: 'toolu_t' } })
  assert.equal(live.activityOf('run-1').phrase, 'Delegating to a sub-agent', 'the sub-agent works under the call that runs it')
  assert.equal(live.activityOf('run-1').tokens, 120)
  tap({ provider: 'claude-code', message: cc.results('toolu_t', [{ type: 'text', text: 'It is in config/app.json.' }], false, undefined) })
  // A file Write makes has no hunks: its whole text is what it added.
  tap({ provider: 'claude-code', message: cc.whole('msg_2', { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: 'notes.md', content: 'one\ntwo\n' } }, 'tool_use') })
  tap({ provider: 'claude-code', message: cc.results('toolu_w', 'File created successfully at: notes.md', false, { type: 'create', filePath: 'notes.md', content: 'one\ntwo\n', structuredPatch: [], originalFile: null }) })
  tap({ provider: 'claude-code', message: { ...claudeRun().at(-1), total_cost_usd: 0.25 } })
  assert.deepEqual(steps(live).map((i) => [i.kind, i.title]), [['status', 'Model: claude-opus-4-1'], ['tool', 'Delegated to a sub-agent: Find the config'], ['file', 'Edited notes.md +2 -0']])
  assert.equal(steps(live)[1].text, 'It is in config/app.json.')
  assert.equal(steps(live)[2].text, '--- /dev/null\n+++ b/notes.md\n+one\n+two')
  assert.deepEqual([h.usage().costUsd, h.usage().apiEquivalentUsd], [0.25, undefined])
})

// What a Codex app-server notifies (app-server README at rust-v0.153.4), in a run's order.
const cx = (method, params) => ({ provider: 'codex', method, params: { threadId: 'thr_1', turnId: 'turn_1', ...params } })
const codexRun = () => [
  { provider: 'codex', method: 'kzh/thread-start-response', params: { thread: { id: 'thr_1', ephemeral: true }, model: 'gpt-5.4', reasoningEffort: 'high', sandbox: { type: 'workspaceWrite' } } },
  cx('turn/started', { turn: { id: 'turn_1', status: 'inProgress', items: [], error: null } }),
  cx('item/started', { item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] } }),
  cx('item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: 'Reading the tests.', summaryIndex: 0 }),
  cx('item/reasoning/summaryPartAdded', { itemId: 'rs_1', summaryIndex: 1 }),
  cx('item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: 'Then the fix.', summaryIndex: 1 }),
  cx('item/completed', { item: { type: 'reasoning', id: 'rs_1', summary: ['Reading the tests.', 'Then the fix.'], content: [] } }),
  cx('item/started', { item: { type: 'commandExecution', id: 'cmd_1', command: 'npm test', cwd: '/w', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'npm test' }] } }),
  cx('item/commandExecution/outputDelta', { itemId: 'cmd_1', delta: '> test\n' }),
  cx('item/commandExecution/outputDelta', { itemId: 'cmd_1', delta: 'FAIL src/app.test.ts\n' }),
  cx('item/commandExecution/outputDelta', { itemId: 'cmd_1', delta: '1 failed\n' }),
  cx('item/completed', { item: { type: 'commandExecution', id: 'cmd_1', command: 'npm test', cwd: '/w', status: 'failed', commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: '> test\nFAIL src/app.test.ts\n1 failed\n', exitCode: 1, durationMs: 14_000 } }),
  cx('item/started', { item: { type: 'commandExecution', id: 'cmd_2', command: 'sed -n 1,40p src/app.ts', cwd: '/w', status: 'inProgress', commandActions: [{ type: 'read', command: 'sed -n 1,40p src/app.ts', name: 'app.ts', path: 'src/app.ts' }] } }),
  cx('item/completed', { item: { type: 'commandExecution', id: 'cmd_2', command: 'sed -n 1,40p src/app.ts', cwd: '/w', status: 'completed', commandActions: [{ type: 'read', command: 'sed -n 1,40p src/app.ts', name: 'app.ts', path: 'src/app.ts' }], aggregatedOutput: 'export const a = 1\n', exitCode: 0, durationMs: 20 } }),
  cx('item/started', { item: { type: 'fileChange', id: 'fc_1', changes: [], status: 'inProgress' } }),
  cx('item/completed', { item: { type: 'fileChange', id: 'fc_1', changes: [{ path: 'src/app.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n' }], status: 'completed' } }),
  cx('turn/diff/updated', { diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n' }),
  cx('turn/plan/updated', { explanation: null, plan: [{ step: 'Read the tests', status: 'completed' }, { step: 'Fix the constant', status: 'inProgress' }, { step: 'Run the tests', status: 'pending' }] }),
  cx('item/started', { item: { type: 'agentMessage', id: 'msg_1', text: '', phase: 'final_answer' } }),
  cx('item/agentMessage/delta', { itemId: 'msg_1', delta: 'Fixed ' }),
  cx('item/agentMessage/delta', { itemId: 'msg_1', delta: 'it.' }),
  cx('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 15_000, inputTokens: 12_000, cachedInputTokens: 9000, outputTokens: 3000, reasoningOutputTokens: 1000 }, last: { totalTokens: 4000, inputTokens: 3500, cachedInputTokens: 3000, outputTokens: 500, reasoningOutputTokens: 100 }, modelContextWindow: 272_000 } }),
  cx('item/completed', { item: { type: 'agentMessage', id: 'msg_1', text: 'Fixed it.', phase: 'final_answer' } }),
  cx('turn/completed', { turn: { id: 'turn_1', status: 'completed', items: [], error: null } }),
]

test('Codex through the engine patch: the thread/start response, a reasoning summary, a command with its streamed output and exit 1, a read, a fileChange\'s changes, the turn\'s diff, the plan, the answer and token usage project to the expected items', () => {
  const { live, h, tap } = patchedRun('codex', 'codex')
  assert.equal(typeof live.tapFor, 'function', 'the store hands out a tap per attempt')
  const frames = deepFreeze(codexRun())
  const phrases = {}
  // What streams shows as it comes, before item/completed gives the whole item.
  const streamed = {}
  const ofKind = (kind) => steps(live).filter((x) => x.kind === kind).map((x) => [x.title, x.text, x.state])
  for (const [i, f] of frames.entries()) {
    tap(f)
    if (i === 5) streamed.reasoning = ofKind('reasoning')
    if (i === 9) phrases.command = live.activityOf('run-1').phrase
    if (i === 10) streamed.command = ofKind('command')
    if (i === 20) { phrases.answer = live.activityOf('run-1').phrase; streamed.answer = ofKind('text') }
  }
  assert.deepEqual(phrases, { command: 'Running a command: npm test', answer: 'Writing its answer' })
  assert.deepEqual(streamed, {
    reasoning: [['Thinking', 'Reading the tests.\n\nThen the fix.', 'running']],
    command: [['Running npm test', '> test\nFAIL src/app.test.ts\n1 failed\n', 'running']],
    answer: [['', 'Fixed it.', 'running']],
  }, 'a summary\'s parts, a command\'s output and the answer as their deltas come')
  const read = live.read('run-1')
  assert.equal(read.summary.dropped, 0)
  assert.deepEqual(steps(live).map((i) => [i.kind, i.title, i.state]), [
    ['status', 'Model: gpt-5.4', 'done'],
    ['reasoning', 'Thinking', 'done'],
    ['command', 'Ran npm test · exit 1 · 14s', 'failed'],
    ['tool', 'Read src/app.ts', 'done'],
    ['file', 'Edited src/app.ts +1 -1', 'done'],
    ['file', 'Files changed: 1 file +1 -1', 'done'],
    ['plan', 'Updated the plan', 'done'],
    ['text', '', 'done'],
  ])
  const [, think, command, , edit, files, plan, answer] = steps(live)
  assert.equal(think.text, 'Reading the tests.\n\nThen the fix.')
  assert.equal(command.text, '> test\nFAIL src/app.test.ts\n1 failed\n')
  assert.equal(edit.text, '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n')
  assert.match(files.text, /^diff --git a\/src\/app\.ts/)
  assert.equal(plan.text, '[x] Read the tests\n[~] Fix the constant\n[ ] Run the tests')
  assert.deepEqual([answer.text, answer.meta.final], ['Fixed it.', true])
  assert.deepEqual([read.summary.tools, read.summary.tokens, read.attempts[0].model], [3, 15_000, 'gpt-5.4'])
  assert.deepEqual(h.usage(), { usage: { inputTokens: 3000, outputTokens: 3000, cacheReadTokens: 9000, reasoningTokens: 1000, totalTokens: 15_000 }, servedModel: 'gpt-5.4' })
})

test('Codex\'s reads and searches keep none of what their commands print: each row names its file or its words, forty reads of a large file are forty steps, and the saved transcript holds none of the code', async () => {
  const dir = tmp()
  const { live, tap } = patchedRun('codex', 'codex', { dir })
  assert.equal(typeof live.tapFor, 'function')
  const shell = (id, command, actions, out) => {
    tap(cx('item/started', { item: { type: 'commandExecution', id, command, cwd: '/w', status: 'inProgress', commandActions: actions } }))
    tap(cx('item/commandExecution/outputDelta', { itemId: id, delta: out.slice(0, 100) }))
    tap(cx('item/commandExecution/outputDelta', { itemId: id, delta: out.slice(100) }))
    const running = live.read('run-1').items.find((x) => x.id.endsWith(`cx:${id}`))
    tap(cx('item/completed', { item: { type: 'commandExecution', id, command, cwd: '/w', status: 'completed', commandActions: actions, aggregatedOutput: out, exitCode: 0, durationMs: 5 } }))
    return running
  }
  const source = (n) => `export const SOURCE_MARKER_${n} = 1\n`.padEnd(30_000, 'x')
  const running = shell('rd_0', 'cat src/app.ts', [{ type: 'read', command: 'cat src/app.ts', name: 'app.ts', path: 'src/app.ts' }], source(0))
  assert.deepEqual([running.title, running.text, running.state], ['Reading src/app.ts', '', 'running'], 'the file it prints is not shown as it streams')
  shell('sr_0', 'rg useTasks src', [{ type: 'search', command: 'rg useTasks src', query: 'useTasks', path: 'src' }], 'src/a.ts:1:useTasks()\n')
  for (let n = 1; n < 40; n++) shell(`rd_${n}`, `cat src/f${n}.ts`, [{ type: 'read', command: `cat src/f${n}.ts`, name: `f${n}.ts`, path: `src/f${n}.ts` }], source(n))
  const rows = steps(live)
  assert.deepEqual(rows.slice(0, 3).map((x) => [x.kind, x.title, x.text, x.state]), [
    ['tool', 'Read src/app.ts', '', 'done'],
    ['tool', 'Searched for useTasks', '', 'done'],
    ['tool', 'Read src/f1.ts', '', 'done'],
  ])
  assert.deepEqual([rows.length, rows.every((x) => x.text === '')], [41, true], 'no step was dropped to make room for text nobody sees')
  assert.equal(live.read('run-1').items.some((x) => x.id === 'dropped'), false)
  live.finish('run-1')
  await live.persist('key-1')
  assert.doesNotMatch(readFileSync(join(dir, 'key-1.jsonl'), 'utf8'), /SOURCE_MARKER|useTasks\(\)/)
})

test('Codex\'s Files changed counts each file once, an added one and a renamed one too, and a line of a file that starts with -- or ++ as the line it is', () => {
  const { live, tap } = patchedRun('codex', 'codex')
  assert.equal(typeof live.tapFor, 'function')
  const files = () => steps(live).find((x) => x.meta.panel === 'files')
  const added = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n'
  tap(cx('turn/diff/updated', { diff: added }))
  assert.deepEqual([files().title, files().meta.files], ['Files changed: 1 file +2 -0', 1])
  // An SQL comment taken out and a line that starts with ++ put in, beside the added file and a rename.
  const sql = 'diff --git a/db/schema.sql b/db/schema.sql\nindex 1111111..2222222 100644\n--- a/db/schema.sql\n+++ b/db/schema.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ counter\n create table t (a int);\n'
  const renamed = 'diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n'
  tap(cx('turn/diff/updated', { diff: added + sql + renamed }))
  assert.deepEqual([files().title, files().meta.files, files().meta.plus, files().meta.minus], ['Files changed: 3 files +3 -1', 3, 3, 1])
  // A diff without git's lines counts a file at each +++ header.
  tap(cx('turn/diff/updated', { diff: '--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n--- a/y.txt\n+++ b/y.txt\n@@ -1 +1,2 @@\n a\n+---\n' }))
  assert.equal(files().title, 'Files changed: 2 files +2 -1')
})

test('Codex\'s Files changed is every turn\'s diff, so the turn Send now replaced keeps what it changed, and a file both turns changed counts once', () => {
  const { live, tap } = patchedRun('codex', 'codex')
  assert.equal(typeof live.tapFor, 'function')
  const files = () => steps(live).filter((x) => x.meta.panel === 'files').map((x) => [x.title, x.text])
  const a1 = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-one\n+two\n'
  tap(cx('turn/diff/updated', { diff: a1 }))
  // Send now's interrupt ends the first turn, and the run goes on with the next on the same thread.
  tap(cx('turn/completed', { turn: { id: 'turn_1', status: 'interrupted', items: [], error: null } }))
  const b = 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n'
  tap(cx('turn/diff/updated', { turnId: 'turn_2', diff: b }))
  assert.deepEqual(files(), [['Files changed: 2 files +2 -2', a1 + b]])
  // The next turn changes a.ts too: its update replaces its own diff only, and a.ts is one file.
  const a2 = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-two\n+three\n'
  tap(cx('turn/diff/updated', { turnId: 'turn_2', diff: b + a2 }))
  assert.deepEqual(files(), [['Files changed: 2 files +3 -3', a1 + b + a2]])
})

test('an edit counts the lines it changes whatever they hold: a Codex update that takes out -- lines, a new file whose text has @@ in it, a deleted file, and a Claude Code Write of a file with @@ in it', () => {
  const { live, tap } = patchedRun('codex', 'codex')
  assert.equal(typeof live.tapFor, 'function')
  const change = (id, c) => tap(cx('item/completed', { item: { type: 'fileChange', id, changes: [c], status: 'completed' } }))
  change('fc_1', { path: 'db/schema.sql', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,1 @@\n--- old comment\n--- another\n create table t;\n' })
  change('fc_2', { path: 'a.sql', kind: { type: 'add' }, diff: 'line1\nline2 @@ x\nline3\n' })
  change('fc_3', { path: 'gone.md', kind: { type: 'delete' }, diff: '--- a heading rule\n@@ not a hunk\n' })
  assert.deepEqual(steps(live).map((x) => [x.title, x.text]), [
    ['Edited db/schema.sql +0 -2', '--- a/db/schema.sql\n+++ b/db/schema.sql\n@@ -1,3 +1,1 @@\n--- old comment\n--- another\n create table t;\n'],
    ['Edited a.sql +3 -0', '--- /dev/null\n+++ b/a.sql\n+line1\n+line2 @@ x\n+line3'],
    ['Edited gone.md +0 -2', '--- a/gone.md\n+++ /dev/null\n---- a heading rule\n-@@ not a hunk'],
  ])
  const claude = patchedRun('claude', 'claude-code')
  claude.tap({ provider: 'claude-code', message: cc.whole('msg_1', { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: 'notes.md', content: '@@ -1 +1 @@\n-a\n' } }, 'tool_use') })
  claude.tap({ provider: 'claude-code', message: cc.results('toolu_w', 'File created successfully at: notes.md', false, { type: 'create', filePath: 'notes.md', content: '@@ -1 +1 @@\n-a\n', structuredPatch: [], originalFile: null }) })
  assert.deepEqual(steps(claude.live).map((x) => [x.title, x.text]), [['Edited notes.md +2 -0', '--- /dev/null\n+++ b/notes.md\n+@@ -1 +1 @@\n+-a']])
})

test('Codex through the engine patch: an error it tries again is a status line and one it does not a failed step, a warning is a status line, a failed turn says why, a patch shows as it is made, an MCP tool and a web search are steps, a declined command did not run, and raw reasoning and the plan stream', () => {
  const { live, tap } = patchedRun('codex', 'codex')
  assert.equal(typeof live.tapFor, 'function')
  const last = () => { const all = steps(live); const x = all[all.length - 1]; return [x.kind, x.title, x.text, x.state] }
  tap(cx('error', { error: { message: 'stream disconnected before completion' }, willRetry: true }))
  assert.deepEqual(last(), ['status', 'Codex hit an error and tries again: stream disconnected before completion', '', 'done'])
  tap(cx('warning', { message: 'Reconnecting... 1/5' }))
  assert.deepEqual(last(), ['status', 'Codex: Reconnecting... 1/5', '', 'done'])
  tap(cx('item/started', { item: { type: 'fileChange', id: 'fc_9', changes: [], status: 'inProgress' } }))
  tap(cx('item/fileChange/patchUpdated', { itemId: 'fc_9', changes: [{ path: 'src/b.ts', kind: { type: 'add' }, diff: 'export const b = 1\n' }] }))
  assert.deepEqual(last(), ['file', 'Editing src/b.ts', '--- /dev/null\n+++ b/src/b.ts\n+export const b = 1', 'running'])
  tap(cx('item/started', { item: { type: 'mcpToolCall', id: 'mcp_1', server: 'docs', tool: 'lookup', status: 'inProgress', arguments: { topic: 'hooks' } } }))
  assert.deepEqual(last(), ['tool', 'lookup hooks', '', 'running'])
  tap(cx('item/completed', { item: { type: 'mcpToolCall', id: 'mcp_1', server: 'docs', tool: 'lookup', status: 'failed', arguments: { topic: 'hooks' }, result: null, error: { message: 'docs server is down' }, durationMs: 300 } }))
  assert.deepEqual(last(), ['tool', 'lookup hooks (failed)', 'docs server is down', 'failed'])
  tap(cx('item/started', { item: { type: 'webSearch', id: 'ws_1', query: 'node test mock timers' } }))
  tap(cx('item/completed', { item: { type: 'webSearch', id: 'ws_1', query: 'node test mock timers' } }))
  assert.deepEqual(last(), ['tool', 'Searched the web for node test mock timers', '', 'done'])
  tap(cx('item/started', { item: { type: 'commandExecution', id: 'cmd_9', command: 'rm -rf build', cwd: '/w', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'rm -rf build' }] } }))
  tap(cx('item/completed', { item: { type: 'commandExecution', id: 'cmd_9', command: 'rm -rf build', cwd: '/w', status: 'declined', commandActions: [{ type: 'unknown', command: 'rm -rf build' }], aggregatedOutput: null, exitCode: null, durationMs: null } }))
  assert.deepEqual(last(), ['command', 'Did not run rm -rf build (declined)', '', 'failed'])
  tap(cx('item/started', { item: { type: 'reasoning', id: 'rs_9', summary: [], content: [] } }))
  tap(cx('item/reasoning/textDelta', { itemId: 'rs_9', delta: 'The constant is read twice.', contentIndex: 0 }))
  assert.deepEqual(last(), ['reasoning', 'Thinking', 'The constant is read twice.', 'running'])
  tap(cx('item/started', { item: { type: 'plan', id: 'pl_9', text: '' } }))
  tap(cx('item/plan/delta', { itemId: 'pl_9', delta: '1. Read it once' }))
  assert.deepEqual(last(), ['plan', 'Planning next steps', '1. Read it once', 'running'])
  tap(cx('error', { error: { message: 'You have hit your usage limit.' }, willRetry: false }))
  assert.deepEqual(last(), ['error', 'Codex reported an error: You have hit your usage limit.', '', 'failed'])
  tap(cx('turn/completed', { turn: { id: 'turn_1', status: 'failed', items: [], error: { message: 'You have hit your usage limit.' } } }))
  assert.deepEqual(last(), ['error', 'The turn failed: You have hit your usage limit.', '', 'failed'])
  assert.equal(live.read('run-1').summary.dropped, 0)
})

test('a Claude Code tool call\'s streamed arguments are let go once they are whole, or once the next model call starts after a call cut off, so a long run of large edits holds no more than the steps it keeps', () => {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc')
  const { live, tap } = patchedRun('claude', 'claude-code', { caps: { items: 10 } })
  assert.equal(typeof live.tapFor, 'function')
  // Each message parsed from a line, as the SDK reads the CLI's output, so its strings are whole in memory.
  const say = (event) => tap({ provider: 'claude-code', message: JSON.parse(JSON.stringify(cc.ev(event))) })
  const start = (index, n) => say({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${n}`, name: 'Edit', input: {} } })
  const args = (index, n) => {
    say({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: `{"file_path":"src/f${n}.ts","old_string":"a",` } })
    say({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: `"new_string":"${'x'.repeat(100_000)}"}` } })
  }
  const heap = () => { gc(); return process.memoryUsage().heapUsed }
  const before = heap()
  // One model call of 150 edits, each 100 KB of arguments: their stops let each go, before the call's own.
  say({ type: 'message_start', message: { id: 'msg_big' } })
  for (let n = 0; n < 150; n++) { start(n, n); args(n, n); say({ type: 'content_block_stop', index: n }) }
  const whole = heap() - before
  say({ type: 'message_stop' })
  // 150 model calls cut off in their edit's arguments, as a broken stream leaves them.
  for (let n = 150; n < 300; n++) { say({ type: 'message_start', message: { id: `msg_${n}` } }); start(0, n); args(0, n) }
  say({ type: 'message_start', message: { id: 'msg_last' } })
  const cut = heap() - before
  const mb = (x) => `${Math.round(x / 1024 / 1024)} MB`
  assert.ok(whole < 8 * 1024 * 1024, `after 15 MB of arguments made whole, the run holds ${mb(whole)}`)
  assert.ok(cut < 8 * 1024 * 1024, `after 15 MB more cut off, the run holds ${mb(cut)}`)
  assert.equal(steps(live).filter((x) => x.id !== 'dropped').length, 10, 'the steps it keeps')
})

test('usageOf puts each provider\'s token counts in the plugin\'s names: Codex\'s cached input is taken out of its input, Claude Code\'s models are summed', () => {
  assert.equal(typeof L.usageOf, 'function', 'live.js exports usageOf')
  assert.deepEqual(L.usageOf('codex', { totalTokens: 15_000, inputTokens: 12_000, cachedInputTokens: 9000, outputTokens: 3000, reasoningOutputTokens: 1000 }), { inputTokens: 3000, outputTokens: 3000, cacheReadTokens: 9000, reasoningTokens: 1000, totalTokens: 15_000 })
  assert.deepEqual(L.usageOf('codex', { inputTokens: 100, cachedInputTokens: 400, outputTokens: 10 }), { inputTokens: 0, outputTokens: 10, cacheReadTokens: 100, reasoningTokens: 0, totalTokens: 110 }, 'never below 0, whatever it says')
  assert.deepEqual(L.usageOf('claude-code', { opus: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 }, haiku: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }), { inputTokens: 11, outputTokens: 6, cacheReadTokens: 100, cacheWriteTokens: 20, totalTokens: 137 })
  assert.deepEqual(L.usageOf('anthropic', { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 90 }), { inputTokens: 7, outputTokens: 3, cacheReadTokens: 90, cacheWriteTokens: 0, totalTokens: 100 })
  for (const [provider, raw] of [['claude-code', {}], ['codex', null], ['spawn', { inputTokens: 1 }]]) assert.equal(L.usageOf(provider, raw), null, `${provider} ${JSON.stringify(raw)}`)
})

test('a tap never throws back into the connector: a frame it cannot read raises dropped, and a tap of an attempt the store does not hold does nothing', () => {
  const { live, tap } = patchedRun('codex', 'codex')
  assert.equal(typeof live.tapFor, 'function')
  for (const f of [null, 7, {}, { provider: 'other' }, { provider: 'claude-code', message: 5 }, { provider: 'codex', method: 9 }, cx('item/agentMessage/delta', { itemId: 3 }), cx('item/started', { item: null })]) assert.doesNotThrow(() => tap(f))
  assert.equal(live.read('run-1').summary.dropped, 8)
  const elsewhere = live.tapFor(live.attempt('no-such-run', 0))
  assert.doesNotThrow(() => elsewhere(codexRun()[0]))
  assert.equal(live.attempt('no-such-run', 0).usage(), null)
  assert.doesNotThrow(() => live.tapFor({ tap() { throw new Error('a handle that breaks') } })(codexRun()[0]))
})

test('an attempt whose connector the engine patch is not in says its live detail is off, and where Settings says why', () => {
  const { live, h } = patchedRun('codex', 'codex')
  h.started({ provider: 'codex', model: 'gpt-5.4', detail: 'off', why: 'dsh-subagent-codex 0.1.6 is installed, and this patch was written for 0.1.5-rc.2', see: 'Settings, Jev setup, Live agent view' })
  assert.equal(live.activityOf('run-1').phrase, 'Working (live detail is off for Codex: see Settings, Jev setup, Live agent view)')
  assert.equal(live.read('run-1').attempts[0].why, 'dsh-subagent-codex 0.1.6 is installed, and this patch was written for 0.1.5-rc.2')
})

test('a steer event of a run is a bubble in the attempt it was sent to, You: and the words, changed in place as they move on and saying nothing of what the agent does; phaseOf says where the run stands between its agents', () => {
  const { live } = started()
  assert.equal(typeof live.phaseOf, 'function', 'the store says where a run stands')
  assert.equal(live.phaseOf('run-1'), 'attempt')
  assert.equal(live.phaseOf('no-such-run'), null)
  const phrase = live.read('run-1').summary.phrase
  live.router('run-1', { type: 'steer', id: 'g1', guidance: 'use tabs\nand spaces nowhere', state: 'pending', attempt: 0, words: 'Waiting for its next step' })
  const bubble = () => live.read('run-1').items.find((i) => i.kind === 'steer')
  assert.deepEqual([bubble()?.title, bubble()?.text, bubble()?.attempt, bubble()?.router, bubble()?.meta], ['You: use tabs and spaces nowhere', 'use tabs\nand spaces nowhere', 0, true, { steer: 'g1', state: 'pending', words: 'Waiting for its next step' }])
  assert.equal(live.read('run-1').summary.phrase, phrase, 'the person\'s words are no step of the agent\'s')
  const v = live.read('run-1').v
  live.router('run-1', { type: 'steer', id: 'g1', guidance: 'use tabs', state: 'delivered', words: 'Read by DeepSeek agent at 14:02' })
  const changed = live.read('run-1', v).items
  assert.deepEqual(changed.map((i) => [i.kind, i.text, i.meta.state, i.meta.words]), [['steer', 'use tabs\nand spaces nowhere', 'delivered', 'Read by DeepSeek agent at 14:02']], 'one bubble, changed in place, its words as first given')
  live.router('run-1', { type: 'steer', guidance: 'no id' })
  assert.equal(live.read('run-1').items.filter((i) => i.kind === 'steer').length, 1, 'an event with no id makes nothing')
})

test('atWorkOf names the attempt a run has at work while its result is not in, an agent\'s review and a configured tool as well as the work, and none between attempts', () => {
  const { live, h } = started()
  assert.equal(typeof live.atWorkOf, 'function', 'the store says what a run has at work')
  assert.deepEqual(live.atWorkOf('run-1'), { index: 0, role: 'primary', agent: 'deepseek', name: 'DeepSeek agent', detail: 'live' })
  h.end({ stopReason: 'completed' })
  assert.equal(live.atWorkOf('run-1'), null, 'its agent\'s result is in')
  live.router('run-1', { type: 'attempt_end', index: 0, attempt: { stopReason: 'completed' } })
  live.router('run-1', { type: 'attempt_start', index: 1, agent: 'deepseek', role: 'review' })
  assert.deepEqual(live.atWorkOf('run-1'), { index: 1, role: 'review', agent: 'deepseek', name: 'DeepSeek agent', detail: null })
  live.router('run-1', { type: 'attempt_end', index: 1, attempt: { stopReason: 'completed' } })
  assert.equal(live.atWorkOf('run-1'), null, 'between attempts')
  live.router('run-1', { type: 'attempt_start', index: 2, agent: 'tool:lint', role: 'tool' })
  assert.deepEqual(live.atWorkOf('run-1'), { index: 2, role: 'tool', agent: 'tool:lint', name: 'the lint tool', detail: 'tool' })
  assert.equal(live.atWorkOf('no-such-run'), null)
})

test('the step Send now replaced reads Replaced by your message once, Codex\'s interrupted turn and Claude Code\'s aborted result alike, in the attempt it was sent to, and what the stopped turn had running ends there; words it could not send leave the next stop unsaid as ever', () => {
  const live = createLiveStore({ now: clock() })
  live.open('run-1', { taskKey: 'key-1', sessionId: 'chat-1', decider: 'jev' })
  live.describe('run-1', { names: { codex: 'Codex', claude: 'Claude Code' } })
  live.router('run-1', { type: 'attempt_start', index: 0, agent: 'codex', role: 'primary', effort: 'high' })
  const codex = live.attempt('run-1', 0)
  codex.started({ provider: 'codex', model: 'gpt-5-codex', detail: 'live' })
  const turnEnd = (id, status) => codex.tap({ provider: 'codex', method: 'turn/completed', params: { threadId: 'th', turn: { id, status, items: [] } } })
  codex.tap({ provider: 'codex', method: 'item/started', params: { threadId: 'th', turnId: 'tu1', item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: 'inProgress' } } })
  const command = () => live.read('run-1').items.find((i) => i.kind !== 'steer' && i.attempt === 0 && i.title.includes('npm test'))
  assert.equal(command()?.state, 'running')
  live.router('run-1', { type: 'steer', id: 'n1', guidance: 'run the linter first', state: 'pending', how: 'now', replacing: true, attempt: 0, words: 'Waiting for its next step' })
  turnEnd('tu1', 'interrupted')
  assert.deepEqual([command()?.title, command()?.state], ['Ran npm test · stopped', 'failed'], 'the command the interrupted turn ran ends with it, never left running')
  turnEnd('tu2', 'interrupted')
  const replaced = (attempt) => live.read('run-1').items.filter((i) => i.title === 'Replaced by your message' && i.attempt === attempt)
  assert.deepEqual(replaced(0).map((i) => [i.kind, i.state]), [['status', 'done']], 'once: a later interrupt, as a Stop gives, is no replacement')
  assert.equal(live.read('run-1').items.find((i) => i.kind === 'steer')?.meta.now, true, 'the bubble says it was sent now')
  live.router('run-1', { type: 'attempt_end', index: 0, attempt: { agent: 'codex', stopReason: 'completed' } })
  live.router('run-1', { type: 'attempt_start', index: 1, agent: 'claude', role: 'retry', effort: 'high' })
  const claude = live.attempt('run-1', 1)
  claude.started({ provider: 'claude-code', model: 'claude-opus-4-1', detail: 'live' })
  const aborted = () => claude.tap({ provider: 'claude-code', message: { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', session_id: 's1' } })
  // Sent and refused: the stop that follows is not said to be a replacement.
  live.router('run-1', { type: 'steer', id: 'n2', guidance: 'stop', state: 'pending', how: 'now', replacing: true, attempt: 1, words: 'Waiting for its next step' })
  live.router('run-1', { type: 'steer', id: 'n2', guidance: 'stop', state: 'pending', how: 'now', replacing: false, attempt: 1, words: 'Waiting for its next step' })
  aborted()
  assert.deepEqual(replaced(1), [])
  // A command Claude Code still had running when its turn was stopped: its result never comes.
  claude.tap({ provider: 'claude-code', message: cc.ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} } }) })
  claude.tap({ provider: 'claude-code', message: cc.whole('msg_b', { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'npm run build' } }, 'tool_use') })
  const build = () => live.read('run-1').items.find((i) => i.attempt === 1 && i.title.includes('npm run build'))
  assert.equal(build()?.state, 'running')
  live.router('run-1', { type: 'steer', id: 'n3', guidance: 'stop and fix the lexer', state: 'pending', how: 'now', replacing: true, attempt: 1, words: 'Waiting for its next step' })
  aborted()
  assert.equal(replaced(1).length, 1)
  assert.deepEqual([build()?.title, build()?.state], ['Ran npm run build · stopped', 'failed'], 'the command the aborted result stopped ends with it, never left running')
  assert.equal(replaced(0).length, 1, 'each in its own attempt')
})

test('a spawn child\'s turn that ends stopped ends the calls it had not got back, failed, while a call its next turn makes runs on', () => {
  const { live, h } = started()
  const call = (turn, callId, seq) => h.events([{ seq, time: 0, type: 'tool/call', data: { turn, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command: `sleep ${seq}` }) } }])
  call(1, 'call-1', 0)
  call(2, 'call-2', 1)
  h.events([{ seq: 2, time: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } } }])
  const states = live.read('run-1').items.filter((i) => i.kind === 'command').map((i) => [i.title, i.state])
  assert.deepEqual(states, [['Ran sleep 0 · stopped', 'failed'], ['Running sleep 1', 'running']])
})
