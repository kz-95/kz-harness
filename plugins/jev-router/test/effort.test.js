// Unified effort ladder -> each agent's accepted values, clamping, precedence, and the Jev Auto menu.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoLevel, codexServiceTier, isLocalLevel, localAgentFor, quickestLocal, toAgentEffort } from '../effort.js'
import { jevAdapter } from '../adapter.js'
import { answeredBy, runRouted } from '../router.js'
// What slice 6 adds is read through the namespace, so this file loads before it and each of its tests
// fails by its own assertion there.
import * as effortModule from '../effort.js'

const claude = { id: 'claude', provider: 'claude-code' }
const codex = { id: 'codex', provider: 'codex' }
const ds = { id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }
const local = { id: 'local', provider: 'spawn', kind: 'local', llm: { provider: 'local', model: 'qwen' } }
const other = { id: 'kimi', provider: 'spawn', llm: { provider: 'moonshot', model: 'k2' } }

test('mapping table', () => {
  const table = Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((l) => [l, [claude, codex, ds, local, other].map((a) => toAgentEffort(l, a))]))
  assert.deepEqual(table, {
    low: ['low', 'low', 'low', null, null],
    medium: ['medium', 'medium', 'high', null, null],
    high: ['high', 'high', 'high', null, null],
    xhigh: ['xhigh', 'xhigh', 'max', null, null],
    max: ['max', 'xhigh', 'max', null, null],
    // Claude's top level is spelled 'ultracode'; Codex gets the whole ladder for an
    // unknown/unnamed model but clamps a *known* older one (see the ceiling tests).
    ultra: ['ultracode', 'xhigh', 'max', null, null],
  })
})

test('claude ultra sends ultracode, its real top level, not max', () => {
  assert.equal(toAgentEffort('ultra', claude), 'ultracode')
  // The rungs below ultra are untouched, and 'max' is still max.
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map((l) => toAgentEffort(l, claude)), ['low', 'medium', 'high', 'xhigh', 'max'])
  // A per-agent override to ultra sends ultracode too.
  assert.equal(toAgentEffort('low', claude, { override: 'ultra' }), 'ultracode')
})

test('deepseek takes max at the top, and local levels stay null', () => {
  assert.equal(toAgentEffort('ultra', ds), 'max')
  assert.equal(toAgentEffort('max', ds), 'max')
  assert.equal(toAgentEffort('ultra', local), null)
  assert.equal(toAgentEffort('ultra', other), null)
})

test('auto follows complexity/risk and never picks ultra', () => {
  assert.equal(autoLevel({ complexity: 0.1, risk: 0.2 }), 'medium')
  assert.equal(autoLevel({ complexity: 0.1, risk: 0.5 }), 'high')
  assert.equal(autoLevel({ complexity: 0.9, risk: 0.1 }), 'xhigh')
  assert.equal(autoLevel({}), 'high')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.99, risk: 0.99 }), 'xhigh')
  assert.equal(toAgentEffort(undefined, ds, { complexity: 0.1, risk: 0.2 }), 'high', 'DeepSeek has no medium: it goes up')
})

test('auto reaches the bottom rung: low under the first cut, which the old bands could not give', () => {
  assert.equal(autoLevel({ complexity: 0, risk: 0 }), 'low')
  assert.equal(autoLevel({ complexity: 0.1, risk: 0.05 }), 'low')
  assert.equal(autoLevel({ complexity: 0.125, risk: 0 }), 'medium', 'a cut belongs to the rung above it')
  // The run the work order was written from: complexity 32.5%, risk 1.3%, served at high.
  assert.equal(autoLevel({ complexity: 0.325, risk: 0.013 }), 'medium')
  assert.equal(autoLevel({ complexity: 0.375, risk: 0 }), 'high')
  // Unknown is still the middle, never the floor.
  assert.equal(autoLevel({ risk: 0 }), 'high')
  // Each family's own word for low; an agent with no effort vocabulary still keeps its default.
  assert.equal(toAgentEffort('auto', claude, { complexity: 0.05, risk: 0.05 }), 'low')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.05, risk: 0.05 }), 'low')
  assert.equal(toAgentEffort(undefined, ds, { complexity: 0.1, risk: 0.1 }), 'low')
  assert.equal(toAgentEffort('auto', local, { complexity: 0.05, risk: 0.05 }), null)
  // Bands with an empty low band (low at 0, or no low at all) start at medium as before.
  assert.equal(autoLevel({ complexity: 0, risk: 0 }, { low: 0, medium: 0.25, high: 0.6 }), 'medium')
  assert.equal(autoLevel({ complexity: 0, risk: 0 }, { medium: 0.25, high: 0.6 }), 'medium')
})

test('auto reads the bands of the provider that decided, and Jev\'s by default', () => {
  // Wider bands than Jev's: the same task lands a rung lower.
  const bands = { medium: 0.4, high: 0.8 }
  assert.equal(autoLevel({ complexity: 0.3, risk: 0.2 }, bands), 'medium')
  assert.equal(autoLevel({ complexity: 0.7, risk: 0.2 }, bands), 'high')
  assert.equal(autoLevel({ complexity: 0.8, risk: 0.2 }, bands), 'xhigh')
  assert.equal(autoLevel({}, bands), 'high', 'unknown is 0.5')
  assert.equal(autoLevel({ complexity: 0.3, risk: 0.2 }), 'medium')
  assert.equal(autoLevel({ complexity: 0.5, risk: 0.2 }), 'high')
  assert.equal(autoLevel({ complexity: 0.7, risk: 0.2 }), 'xhigh')
  // toAgentEffort hands them on for 'auto' only: a level or an override is not moved by them.
  assert.equal(toAgentEffort('auto', claude, { complexity: 0.3, risk: 0.3, bands }), 'medium')
  assert.equal(toAgentEffort(undefined, ds, { complexity: 0.7, risk: 0.1, bands }), 'high')
  assert.equal(toAgentEffort('auto', claude, { complexity: 0.5, risk: 0.3 }), 'high')
  assert.equal(toAgentEffort('xhigh', claude, { complexity: 0.1, risk: 0.1, bands }), 'xhigh')
  assert.equal(toAgentEffort('auto', claude, { complexity: 0.1, override: 'max', bands }), 'max')
})

test('codex clamps to the model top effort; speed maps to the priority tier', () => {
  // gpt-5.5 tops out at xhigh today; nothing here may silently raise or lower that.
  assert.equal(toAgentEffort('ultra', codex, { model: 'gpt-5.5' }), 'xhigh')
  assert.equal(toAgentEffort('max', codex, { model: 'gpt-5.5' }), 'xhigh')
  assert.equal(toAgentEffort('high', codex, { model: 'gpt-5.5' }), 'high')
  assert.equal(codexServiceTier('fast'), 'priority')
  assert.equal(codexServiceTier('normal'), null)
})

test('every gpt-5.6 variant takes ultra, and a model we have never seen is not capped', () => {
  for (const model of ['gpt-5.6', 'gpt-5.6-luna', 'gpt-5.6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'GPT-5.6-Luna']) {
    assert.equal(toAgentEffort('ultra', codex, { model }), 'ultra', model)
  }
  // Unknown/newer is the benefit of the doubt, not a quiet clamp.
  for (const model of ['gpt-6', 'gpt-5.7-orion', 'some-future-model']) {
    assert.equal(toAgentEffort('ultra', codex, { model }), 'ultra', model)
  }
  // Older/unknown families still get every rung below their ceiling.
  assert.equal(toAgentEffort('low', codex, { model: 'gpt-5.6-luna' }), 'low')
})

test('a declared model capability list beats the built-in ceilings', () => {
  const declared = { id: 'codex', provider: 'codex', models: [{ id: 'gpt-5.5', reasoning: { efforts: [{ id: 'low' }, { id: 'ultra' }] } }] }
  assert.equal(toAgentEffort('ultra', declared, { model: 'gpt-5.5' }), 'ultra', 'the connector declares this build takes ultra')
  // A declaration that tops out lower still clamps.
  const legacy = { id: 'codex', provider: 'codex', models: [{ id: 'gpt-5.6-sol', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] }
  assert.equal(toAgentEffort('ultra', legacy, { model: 'gpt-5.6-sol' }), 'high')
  // No declaration for the running model: the pattern rules decide.
  assert.equal(toAgentEffort('ultra', declared, { model: 'gpt-5.6-luna' }), 'ultra')
})

test('per-agent override wins over level', () => {
  assert.equal(toAgentEffort('max', ds, { override: 'off' }), 'off')
  assert.equal(toAgentEffort('low', claude, { override: 'xhigh' }), 'xhigh')
})

test('adapter declares efforts and forwards the chosen one', async () => {
  let got
  const a = jevAdapter({ ctx: { agents: { get: () => ({}) } }, route: async ({ effort }) => { got = effort; return 'r' }, auxModel: { provider: 'x', model: 'y' } })
  const m = await a.resolveModel('jev', 'jev-auto')
  assert.equal(m.reasoning.defaultEffort, 'auto')
  assert.deepEqual(m.reasoning.efforts.map((e) => e.id), ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'local-low', 'local-high'])
  for await (const _ of a.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'fix it' }] }], reasoningEffort: 'xhigh', sessionId: 's' })) { /* drain */ }
  assert.equal(got, 'xhigh')
})

test('router: menu beats default, per-agent beats menu; effort shows in Answered by', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-effort-'))
  writeFileSync(join(dir, 'a.txt'), 'x')
  const g = (...x) => execFileSync('git', x, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i')
  const seen = []
  const config = {
    agents: [{ ...claude, enabled: true, description: 'a' }, { ...ds, enabled: true, description: 'b' }],
    fallbackAgent: 'claude', agentTimeoutMs: 60_000,
    limits: { maxAttempts: 1, maxReviews: 0, maxRounds: 1 },
    thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
    checks: { enabled: false, scripts: [] }, productionWorkspaces: [],
    effort: { default: 'low', perAgent: {}, codexSpeed: 'normal' },
  }
  const run = (effort, cfg = config) => runRouted({ task: 't', cwd: dir, forceAgent: 'claude', effort, config: cfg, deps: { jev: null, execute: async (_a, _p, _s, o) => { seen.push(o.effort); return { stopReason: 'completed', answerText: 'ok' } }, modelOf: () => 'opus', history: { recent: async () => [], append: async () => {} } } })
  await run(undefined); await run('auto'); await run('high')
  const r = await run('high', { ...config, effort: { ...config.effort, perAgent: { claude: 'max' } } })
  assert.deepEqual(seen, ['low', 'low', 'high', 'max'])
  assert.match(answeredBy(r), /claude \(opus, max\)/)
})

test('local-low and local-high name a model by size, not by id', () => {
  // Real numbers from config/local-models.json: the fast model is the BIGGER file,
  // so role has to decide this, not size.
  const agents = [
    { id: 'claude', provider: 'claude-code', enabled: true },
    { id: 'gemma-local', kind: 'local', enabled: true, role: 'fast', size: 5_154_941_280 },
    { id: 'qwen-local', kind: 'local', enabled: true, role: 'best-quality', size: 5_027_783_488 },
  ]
  assert.equal(localAgentFor('local-low', agents), 'gemma-local', 'the fast model, though it is the larger file')
  assert.equal(localAgentFor('local-high', agents), 'qwen-local', 'the best-quality model, though it is the smaller file')
  // A newly installed model sorts itself in with no code change.
  // A model with no role sits between fast and best-quality, ranked by size against its peers.
  const withUnroled = [...agents, { id: 'mid-local', kind: 'local', enabled: true, size: 3_000_000_000 }]
  assert.equal(localAgentFor('local-low', withUnroled), 'gemma-local', 'an explicit fast role still wins')
  assert.equal(localAgentFor('local-high', withUnroled), 'qwen-local', 'an explicit best-quality role still wins')
  // With no roles at all it falls back to size, which is better than nothing.
  const unroled = [{ id: 'a-local', kind: 'local', enabled: true, size: 1 }, { id: 'b-local', kind: 'local', enabled: true, size: 9 }]
  assert.equal(localAgentFor('local-low', unroled), 'a-local')
  assert.equal(localAgentFor('local-high', unroled), 'b-local')
  // The local chat model defaults through the same rule, so no caller can pick a different
  // "quickest" model: manifest entries arrive in manifest order, not in speed order.
  assert.equal(quickestLocal([{ id: 'qwen3-8b', role: 'best-quality', size: 5_027_783_488 }, { id: 'gemma4-e4b', role: 'fast', size: 5_154_941_280 }]).id, 'gemma4-e4b')
  assert.equal(quickestLocal(unroled).id, 'a-local')
  assert.equal(quickestLocal([]), null)
})

test('local levels need a local model, and are not efforts', () => {
  assert.equal(localAgentFor('local-low', []), null, 'no local model installed')
  assert.equal(localAgentFor('local-low', [{ id: 'gemma-local', kind: 'local', enabled: false, size: 1 }]), null, 'a disabled agent is not picked')
  assert.equal(localAgentFor('high', [{ id: 'gemma-local', kind: 'local', enabled: true, size: 1 }]), null, 'an ordinary level names no model')
  assert.equal(isLocalLevel('local-low'), true)
  assert.equal(isLocalLevel('high'), false)
  assert.equal(isLocalLevel(undefined), false)
  // A cloud agent asked for a local level keeps its own default rather than a bad value.
  for (const a of [{ provider: 'claude-code' }, { provider: 'codex' }, { llm: { provider: 'deepseek' } }]) {
    assert.equal(toAgentEffort('local-low', a), null)
    assert.equal(toAgentEffort('local-high', a), null)
  }
})

// ---------- your ratings move Auto effort (docs/live-agent-view.md Feature 4, slice 6) ----------
// A `wrong effort` rating as acceptVerdict stores it: stamped with the family, level and task type of the plan it judged.
const rating = (suggestedEffort, planLevel, { ts = '2026-10-01T10:00:00.000Z', family = 'codex', taskType = 'debugging' } = {}) => ({
  ts, sessionId: 's-1', messageId: `m-${ts}-${suggestedEffort}`, verdict: 'dislike', reason: '', tag: 'wrong effort', about: 'plan',
  taskKey: '0f8fad5b-d9cb-469f-a165-70867728950e', suggestedEffort, planFamily: family, planLevel, taskType,
})
const at = (min) => `2026-10-01T10:${String(min).padStart(2, '0')}:00.000Z`

test('effortBias: +1 once 3 of the last 4 ratings say the pick ran too low, 0 when they are mixed, and 0 for ratings before a Reset', () => {
  assert.equal(typeof effortModule.effortBias, 'function', 'effort.js reads what your ratings say of Auto effort')
  const { effortBias } = effortModule
  const three = [rating('xhigh', 'high', { ts: at(1) }), rating('low', 'high', { ts: at(2) }), rating('xhigh', 'high', { ts: at(3) }), rating('max', 'high', { ts: at(4) })]
  assert.equal(effortBias(three, 'codex', 'debugging'), 1)
  assert.equal(effortBias(three.slice(0, 3), 'codex', 'debugging'), 0, 'two of three is not enough')
  assert.equal(effortBias(three, 'codex', 'documentation'), 0, 'another task type is another pair')
  assert.equal(effortBias(three, 'claude', 'debugging'), 0, 'and so is another agent family')
  const mixed = [rating('xhigh', 'high', { ts: at(1) }), rating('low', 'high', { ts: at(2) }), rating('xhigh', 'high', { ts: at(3) }), rating('medium', 'high', { ts: at(4) })]
  assert.equal(effortBias(mixed, 'codex', 'debugging'), 0)
  const lower = [1, 2, 3].map((m) => rating('medium', 'xhigh', { ts: at(m) }))
  assert.equal(effortBias(lower, 'codex', 'debugging'), -1)
  assert.equal(effortBias(three, 'codex', 'debugging', at(3)), 0, 'a Reset at 10:03 leaves two ratings after it')
  assert.equal(effortBias([...three, rating('xhigh', 'high', { ts: at(5) }), rating('xhigh', 'high', { ts: at(6) })], 'codex', 'debugging', at(3)), 1, 'and three after it count again')
  // Only the newest five are read: three old ones that said too low are outvoted by five that say too high.
  const turned = [...[1, 2, 3].map((m) => rating('xhigh', 'high', { ts: at(m) })), ...[4, 5, 6, 7, 8].map((m) => rating('medium', 'high', { ts: at(m) }))]
  assert.equal(effortBias(turned, 'codex', 'debugging'), -1)
  // A like, an answer's verdict and a rating that names the level it ran at say nothing of the effort.
  assert.equal(effortBias([...three.slice(0, 2), { ...three[2], verdict: 'like' }, { ...three[3], about: undefined }, rating('high', 'high', { ts: at(5) })], 'codex', 'debugging'), 0)
})

test('effortBias: a rating is read against the level Auto would have chosen, so ratings that ask for it back at a run your ratings moved take the step back and none past it', () => {
  const { effortBias, ratingWay, unifiedLevel } = effortModule
  const asked = { complexity: 0.2, risk: 0.2 }
  assert.equal(unifiedLevel('auto', asked), 'medium', 'Auto\'s own level for this work')
  const raised = [1, 2, 3].map((m) => rating('high', 'medium', { ts: at(m) }))
  assert.equal(unifiedLevel('auto', { ...asked, shift: effortBias(raised, 'codex', 'debugging') }), 'high', 'three ratings that ask for high move Auto up a step')
  // Runs now go at high, a step above the medium Auto would have chosen (`planUnmoved`), and three ratings of them ask for medium.
  const atRaised = (suggested, m) => ({ ...rating(suggested, 'high', { ts: at(m) }), planUnmoved: 'medium' })
  assert.equal(ratingWay(atRaised('medium', 4)), 0, 'one that asks for Auto\'s own level asks for no step either way')
  const back = [...raised, ...[4, 5, 6].map((m) => atRaised('medium', m))]
  assert.equal(effortBias(back, 'codex', 'debugging'), 0, 'they take the place of the ratings that moved it, and move it no step past where they asked')
  assert.equal(unifiedLevel('auto', { ...asked, shift: effortBias(back, 'codex', 'debugging') }), 'medium', 'medium, as they asked, not low')
  // Three that ask for low at a raised run are read against medium too, and move Auto to low.
  const lower = [...raised, ...[4, 5, 6].map((m) => atRaised('low', m))]
  assert.equal(unifiedLevel('auto', { ...asked, shift: effortBias(lower, 'codex', 'debugging') }), 'low')
  // A rating stamped with no level Auto would have chosen is read against the level it ran at.
  assert.equal(ratingWay(rating('medium', 'high')), -1)
})

test('toAgentEffort: a shift moves Auto one rung, never past xhigh, and never a level picked in the menu or in Settings', () => {
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.5 }), 'high', 'unshifted')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.5, shift: +1 }), 'xhigh')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.5, shift: -1 }), 'medium')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.9, shift: +1 }), 'xhigh', 'Auto never goes to max or ultra')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.05, risk: 0.05, shift: -1 }), 'low', 'nor below low')
  assert.equal(toAgentEffort('high', codex, { complexity: 0.5, shift: +1 }), 'high', 'a level picked in the menu is kept')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.5, override: 'medium', shift: +1 }), 'medium', 'and a Settings value per agent')
  assert.equal(toAgentEffort('auto', claude, { complexity: 0.5, shift: +1 }), 'xhigh', 'Claude Code moves too')
})

test('Claude Code speed: Fast sends a Claude Code attempt fast mode and the task list says it beside the effort, while Codex keeps its own speed', async () => {
  // Read through the namespace, as these are new beside slice 6's.
  assert.equal(typeof effortModule.agentSpeed, 'function', 'effort.js says the speed an agent runs at')
  const effort = { default: 'high', perAgent: {}, codexSpeed: 'fast', claudeSpeed: 'fast' }
  assert.deepEqual(['claude', 'codex', 'deepseek', null].map((family) => effortModule.agentSpeed(family, effort)), ['fast-mode', 'fast', null, null])
  assert.equal(effortModule.agentSpeed('claude', { ...effort, claudeSpeed: 'normal' }), null, 'Normal leaves fast mode off')
  assert.equal(effortModule.agentSpeed('claude', { default: 'auto', perAgent: {}, codexSpeed: 'fast' }), null, 'and so do settings saved before Claude Code had a speed')
  assert.deepEqual(['fast-mode', 'fast', 'normal', null].map(effortModule.claudeFastMode), ['1', null, null, null], 'only fast mode sets KZ_CLAUDE_FAST_MODE')
  assert.equal(codexServiceTier('fast-mode'), null, 'and Codex is never sent Claude Code\'s speed')
  assert.deepEqual(['fast-mode', 'fast', 'normal', null].map(effortModule.speedWord), [', fast mode', ' 1.5x', '', ''])

  const dir = mkdtempSync(join(tmpdir(), 'jev-fast-'))
  writeFileSync(join(dir, 'a.txt'), 'x')
  const g = (...x) => execFileSync('git', x, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i')
  const config = {
    agents: [{ ...claude, enabled: true, description: 'a' }, { ...codex, enabled: true, description: 'b' }],
    fallbackAgent: 'claude', agentTimeoutMs: 60_000,
    limits: { maxAttempts: 1, maxReviews: 0, maxRounds: 1 },
    thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
    checks: { enabled: false, scripts: [] }, productionWorkspaces: [], effort,
  }
  const run = async (forceAgent) => {
    const seen = []
    const events = []
    await runRouted({ task: 't', cwd: dir, forceAgent, config, deps: { jev: null, emit: (e) => events.push(e), execute: async (_a, _p, _s, o) => { seen.push([o.effort, o.speed]); return { stopReason: 'completed', answerText: 'ok' } }, modelOf: () => 'opus', history: { recent: async () => [], append: async () => {} } } })
    return { seen, word: events.find((e) => e.type === 'attempt_start')?.effort }
  }
  assert.deepEqual(await run('claude'), { seen: [['high', 'fast-mode']], word: 'high, fast mode' })
  assert.deepEqual(await run('codex'), { seen: [['high', 'fast']], word: 'high 1.5x' }, 'Codex at 1.5x is said as before')
})
