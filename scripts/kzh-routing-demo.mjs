#!/usr/bin/env node
// Watch the adaptive router decide, without starting the app.
//
// Every module the running harness uses is the real one here: the provider adapters, the
// capability registry and its priors, the resource governor, the decision engine, the broker,
// the routing loop, the training store and the maturity ladder. Only two things are stood in
// for, and both are named on screen: the agents (they print instead of editing files) and Jev
// (it answers from the candidate table it is handed, the way the real one is asked to).
//
// It prints what the Jev inspector's Decisions and Router tabs show, so the routing behaviour
// can be read and argued with before the app is rebuilt. Nothing it does touches your projects,
// your keys or your real history: it works in a throwaway folder under the system temp directory.
//
//   node scripts/kzh-routing-demo.mjs              a healthy machine, one task of each kind
//   node scripts/kzh-routing-demo.mjs --pressure   the same, with the subscriptions far into their week
//   node scripts/kzh-routing-demo.mjs --learn 60   route 60 tasks, then show what matured
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDecisionEngine } from '../plugins/jev-router/decision.js'
import { createDomainRegistry } from '../plugins/jev-router/domains.js'
import { createCapabilityRegistry, loadPriors } from '../plugins/jev-router/profiles.js'
import { snapshotResources } from '../plugins/jev-router/resources.js'
import { governorSignals } from '../plugins/jev-router/governor.js'
import { formatReport, runRouted } from '../plugins/jev-router/router.js'
import { resolvePolicy } from '../plugins/jev-router/routing-policy.js'
import { createTrainingStore, labelFromRun } from '../plugins/jev-router/training.js'
import { line } from '../plugins/jev-router/adapter.js'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback }
if (has('--help') || has('-h')) {
  process.stdout.write(`${[
    'Watch the adaptive router decide, without starting the app.',
    '',
    '  --pressure      run with the subscriptions 88% through their week',
    '  --learn <n>     route n tasks first, then report which routing domains matured',
    '  --quiet         decisions only, no per-run event log',
    '',
    'The agents and Jev are stood in for; every routing module is the real one.',
  ].join('\n')}\n`)
  process.exit(0)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const PRIORS = loadPriors(join(root, 'config', 'capability-priors.json'))
const policy = resolvePolicy(has('--learn') ? {
  // Small gates, so a demo of a few dozen runs can show a domain actually maturing. The shipped
  // numbers are hundreds of runs per rung; the shape of every check is identical.
  gates: {
    LOW: { shadowSamples: 10, guardedSamples: 20, localOnlySamples: 30, perClassSamples: 5, holdoutSamples: 3, recentWindow: 20, guarded: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.3 }, localOnly: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.35 }, maxHighConfidenceError: 0.35, confidenceThreshold: 0.6, minOutcomeBacked: 0.5, maxTeacherOnly: 0.5, rollback: { recentAccuracyFloor: 0.7, maxEce: 0.4, repromoteSamples: 5 } },
    MEDIUM: { shadowSamples: 10, guardedSamples: 20, localOnlySamples: 30, perClassSamples: 5, holdoutSamples: 3, recentWindow: 20, guarded: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.3 }, localOnly: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.35 }, maxHighConfidenceError: 0.35, confidenceThreshold: 0.6, minOutcomeBacked: 0.5, maxTeacherOnly: 0.5, rollback: { recentAccuracyFloor: 0.7, maxEce: 0.4, repromoteSamples: 5 } },
    HIGH: { shadowSamples: 10, guardedSamples: 20, localOnlySamples: 30, perClassSamples: 5, holdoutSamples: 3, recentWindow: 20, guarded: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.3 }, localOnly: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.35 }, maxHighConfidenceError: 0.35, confidenceThreshold: 0.6, minOutcomeBacked: 0.5, maxTeacherOnly: 0.5, rollback: { recentAccuracyFloor: 0.7, maxEce: 0.4, repromoteSamples: 5 } },
  },
  retrain: { minSamples: 8, everyNewSamples: 1, epochs: 300, learningRate: 0.3 },
  minClassRecall: 0.4,
} : {})

const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'Claude Code', enabled: true, kind: 'subscription' },
  { id: 'codex', provider: 'codex', description: 'Codex', enabled: true, kind: 'subscription' },
  { id: 'deepseek', provider: 'spawn', description: 'DeepSeek', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  { id: 'qwen-local', provider: 'spawn', description: 'Qwen on this PC', enabled: true, kind: 'local', role: 'best-quality', llm: { provider: 'local', model: 'qwen3-8b' } },
]
const modelOf = (a) => a.llm?.model ?? (a.provider === 'claude-code' ? 'claude-opus-5' : 'gpt-5.6')
const weekly = has('--pressure') ? 88 : 22
const now = Date.now()
const at = (m) => new Date(now + m * 60_000).toISOString()
const win = (name, minutes, usedPercent, resetsAt) => ({ name, minutes, usedPercent, resetsAt })
const usage = {
  claude: { kind: 'subscription', provider: 'claude-code', windows: [win('5h', 300, 12, at(140)), win('weekly', 10080, weekly, at(4 * 24 * 60))], via: 'oauth-usage', state: weekly >= 85 ? 'near' : 'ok', checkedAt: at(-1), limits: {} },
  codex: { kind: 'subscription', provider: 'codex', windows: [win('5h', 300, 6, at(200)), win('weekly', 10080, weekly - 4, at(5 * 24 * 60))], via: 'codex-app-server', plan: 'plus', state: 'ok', checkedAt: at(-1), limits: {} },
  deepseek: { kind: 'api', provider: 'spawn', windows: [], balance: { amount: 26, currency: 'USD' }, creditPercent: 65, creditPeak: { amount: 40, currency: 'USD' }, state: 'ok', checkedAt: at(-1), limits: { minBalance: 5, handoffAtBalance: 10 } },
  'qwen-local': { kind: 'local', provider: 'spawn', windows: [], state: 'ok', checkedAt: at(-1), limits: {} },
}
const ready = Object.fromEntries(AGENTS.map((a) => [a.id, { installed: true, loggedIn: true, detail: 'ready' }]))

// The tasks, and what a real Jev would have said about each. Only the profile is scripted: which
// resource gets the work, under which strategy, is the router's own decision from here on.
const TASKS = [
  {
    title: 'A trivial rename',
    task: 'rename the MAX_RETRIES constant to MAX_ATTEMPTS everywhere it is used',
    profile: { taskType: 'simple_change', taskTypeConfidence: 0.94, complexity: 0.05, risk: 0.05, requirements: { coding: 0.35, general_reasoning: 0.15 }, skills: { primary: 'refactoring', supporting: [] }, minimumCapability: 'standard', preferredCapability: 'standard', verification: ['checks'], needsSecondOpinion: 0.05, needsHumanReview: 0.05, needsTests: 0.6 },
  },
  {
    title: 'A normal implementation',
    task: 'add a retry with backoff to the usage fetch and cover it with a test',
    profile: { taskType: 'implementation', taskTypeConfidence: 0.9, complexity: 0.45, risk: 0.3, requirements: { coding: 0.85, testing: 0.6, general_reasoning: 0.4 }, skills: { primary: 'implementation', supporting: ['testing'] }, minimumCapability: 'standard', preferredCapability: 'strong', verification: ['checks'], needsSecondOpinion: 0.2, needsHumanReview: 0.1, needsTests: 0.9 },
  },
  {
    title: 'A design question',
    task: 'design how the routing domains should share one training store, and explain the trade-offs',
    profile: { taskType: 'architecture', taskTypeConfidence: 0.92, complexity: 0.85, risk: 0.5, requirements: { architecture: 0.95, explanation: 0.9, planning: 0.85, coding: 0.25, general_reasoning: 0.8 }, skills: { primary: 'architecture', supporting: ['explanation'] }, minimumCapability: 'strong', preferredCapability: 'frontier', verification: ['consistency-review'], needsSecondOpinion: 0.5, needsHumanReview: 0.4, needsTests: 0.2 },
  },
  {
    title: 'A security-critical review',
    task: 'review the credential handling in the accounts module for ways a key could leak',
    profile: { taskType: 'security', taskTypeConfidence: 0.95, complexity: 0.8, risk: 0.95, requirements: { security_review: 0.95, code_review: 0.9, general_reasoning: 0.7, coding: 0.3 }, skills: { primary: 'security', supporting: ['review'] }, minimumCapability: 'frontier', preferredCapability: 'frontier', verification: ['checks', 'consistency-review'], needsSecondOpinion: 0.7, needsHumanReview: 0.6, needsTests: 0.4 },
  },
]

const pad = (s, n) => String(s).padEnd(n)
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : 'unknown')
const rule = (t) => `\n${'-'.repeat(78)}\n${t}\n${'-'.repeat(78)}`
const out = (t = '') => process.stdout.write(`${t}\n`)

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kzh-demo-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
  writeFileSync(join(dir, 'a.txt'), 'x')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=demo', '-c', 'user.email=demo@demo', 'commit', '-qm', 'init')
  return dir
}

/**
 * A stand-in Jev. It classifies from the script and then picks the candidate with the best
 * capability fit per unit of expected cost, which is roughly what the real prompt asks for. It
 * only ever sees the anonymous table, exactly as the real one does.
 */
function demoJev(profile) {
  const calls = []
  return {
    calls,
    route: async (a) => {
      calls.push(a)
      const r = { model: 'jev-demo' }
      if (a.ask?.task) { r.profile = profile; Object.assign(r, { taskType: profile.taskType, complexity: profile.complexity, risk: profile.risk, handler: 'agent' }) }
      if (a.candidates && a.ask?.resource) {
        const value = (c) => {
          const req = Object.entries(profile.requirements)
          const fit = req.reduce((acc, [d, w]) => acc + w * (c.capabilities?.[d]?.score ?? 0.5), 0) / req.reduce((acc, [, w]) => acc + w, 0)
          return fit / Math.max(0.1, c.expectedCost?.total ?? 0.5)
        }
        const chosen = a.candidates.reduce((m, c) => (value(c) > value(m) ? c : m))
        r.resource = { chosenKey: chosen.key, confidence: 0.82, probabilities: Object.fromEntries(a.candidates.map((c) => [c.key, c.key === chosen.key ? 0.82 : 0.18 / Math.max(1, a.candidates.length - 1)])) }
        const cheap = a.candidates.some((c) => c.marginalCost !== 'low' && c.key !== chosen.key)
        const strategy = profile.risk >= 0.8 && cheap ? 'CHEAP_EXECUTE_FRONTIER_REVIEW'
          : profile.complexity >= 0.8 && a.candidates.length > 1 ? 'PREMIUM_PLAN_CHEAP_EXECUTE'
            : 'STANDARD_DIRECT'
        r.strategy = { choice: strategy, confidence: 0.75, probabilities: { [strategy]: 0.75 } }
      }
      if (a.candidates && a.ask?.judgments) Object.assign(r, { secondOpinion: profile.needsSecondOpinion, conserve: profile.complexity < 0.3 ? 0.8 : 0.3, frontierReview: profile.risk >= 0.8 ? 0.9 : 0.15 })
      return r
    },
    assess: async () => ({
      verdict: 'accept', verdictConfidence: 0.9, verdictProbabilities: {}, disposition: 'PASS', dispositionConfidence: 0.9, dispositionProbabilities: {},
      addressed: 0.92, complete: 0.9, unrelatedChanges: 0.05, regressionRisk: 0.05, needsPerson: 0.03,
      reviewAgent: 'claude', reviewAgentProbabilities: {}, retryAgent: 'claude', retryAgentProbabilities: {},
    }),
  }
}

const stateRoot = mkdtempSync(join(tmpdir(), 'kzh-demo-state-'))
const profiles = createCapabilityRegistry({ file: join(stateRoot, 'capability-evidence.jsonl'), priors: PRIORS, policy })
const store = createTrainingStore({ file: join(stateRoot, 'routing-samples.jsonl') })
const domains = createDomainRegistry({ policy, store, artifactsDir: join(stateRoot, 'classifiers'), stateDir: join(stateRoot, 'domains') })
const engine = createDecisionEngine({ policy, domains, profiles, priors: PRIORS, store })
const snapshots = snapshotResources({ agents: AGENTS, usage, ready, config: {}, specs: { gpus: [{ name: 'RTX 3050 Laptop', vendor: 'nvidia', vramGB: 4 }], ramGB: 24 }, modelOf, policy })

const config = {
  agents: AGENTS, tools: [], fallbackAgent: 'claude', agentTimeoutMs: 60_000,
  limits: { maxAttempts: 3, maxReviews: 2, maxRounds: 6 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: true, scripts: ['test'], timeoutMs: 30_000, outputChars: 400 },
  productionWorkspaces: [], effort: {},
}

async function routeOne({ task, profile, quiet }) {
  const dir = repo()
  const jev = demoJev(profile)
  let samples = []
  const events = []
  const execute = async (a, prompt) => {
    const role = /Plan, but do not carry out/.test(prompt) ? 'plans' : /Independently review/.test(prompt) ? 'reviews' : 'works'
    writeFileSync(join(dir, 'a.txt'), `${Math.random()}`)
    return { stopReason: 'completed', answerText: `[${a.id} ${role} here]` }
  }
  const r = await runRouted({
    task, cwd: dir, config, signal: new AbortController().signal,
    deps: {
      jev, execute, modelOf,
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      emit: (e) => events.push(e),
      decide: async (a) => { const d = await engine.decide({ ...a, snapshots }); samples = d.samples ?? []; return d },
      outcomeDomain: domains.get('outcome_disposition'),
    },
  })
  // The routing decisions, plus the review's own: its sample id rides back on the assessment.
  const all = [
    ...samples,
    ...(r.assessments ?? []).map((a) => a.outcomeDomain?.sampleId).filter(Boolean).map((id) => ({ domain: 'outcome_disposition', id })),
  ]
  for (const { domain, id } of all) {
    const sample = await store.get(id)
    const outcome = sample && labelFromRun(domain, sample, r)
    if (outcome) await store.resolveOutcome(id, outcome)
  }
  rmSync(dir, { recursive: true, force: true })
  return { run: r, jev, events, quiet }
}

function showRun(title, { run: r, jev, events }) {
  const d = r.routing.decision
  out(rule(title))
  out(`Task            ${r.task}`)
  out(`Jev said        ${r.routing.taskType}, complexity ${pct(r.routing.complexity)}, risk ${pct(r.routing.risk)}, needs at least a ${d.minimumCapability} resource`)
  out('')
  out('Candidates, anonymous, as the router judged them')
  for (const c of d.candidates) {
    const caps = Object.entries(c.capabilities).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')} ${pct(v.score)}`).join(', ')
    out(`  ${pad(c.key, 11)} ${pad(c.id, 12)} ${pad(c.tier, 9)} fit ${pad(pct(c.fit), 6)} scarcity ${pad(c.scarcity == null ? 'unknown' : pct(c.scarcity), 8)} cost ${pad(c.expectedCost?.class ?? '?', 9)} ${caps}`)
  }
  for (const e of d.excluded) out(`  excluded    ${pad(e.id, 12)} ${e.reason}`)
  out('')
  out(`Decision        ${r.routing.primaryAgent} under ${r.strategy}`)
  if (d.plan?.reviewer) out(`                reviewed by ${d.plan.reviewer}${d.plan.frontierReview ? ' (the strongest available)' : ''}`)
  if (d.plan?.steps?.some((x) => x.role === 'plan')) out(`                planned first by ${d.plan.steps.find((x) => x.role === 'plan').agent}`)
  for (const n of d.plan?.notes ?? []) out(`                ${n}`)
  out(`Who decided     ${Object.entries(d.domains).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.authority}`).join(' | ')}`)
  out(`Jev calls       ${d.jevCalls} (${jev.calls.map((c) => Object.entries(c.ask ?? {}).filter(([, v]) => v).map(([k]) => k).join('+')).join(', ') || 'none'})`)
  out(`Ran             ${r.attempts.map((a) => `${a.agent} (${a.role})`).join(' then ')}`)
  out(`Finished        ${r.finalStatus}`)
  if (!events.quiet) {
    out('')
    out('What the reasoning block would have shown:')
    for (const e of events) { const t = line(e); if (t) out(`  ${t}`) }
  }
}

async function main() {
  out(rule('KzH adaptive routing, driven headlessly'))
  out('Real: provider adapters, capability registry and priors, governor, decision engine,')
  out('      broker, routing loop, training store, maturity ladder.')
  out('Stood in for: the agents (they print instead of editing) and Jev (it answers from the')
  out('      anonymous candidate table it is handed).')
  out(`Subscriptions are ${weekly}% through their week${has('--pressure') ? ' (--pressure)' : ''}.`)

  out(rule('What each resource looks like right now'))
  const signals = governorSignals({ snapshots, policy })
  for (const s of snapshots) {
    const g = signals.get(s.resourceId)
    const limits = s.limits.length ? s.limits.map((l) => `${l.id} ${l.ratioUsed == null ? 'unknown' : pct(l.ratioUsed)}`).join(', ') : 'no limits reported'
    out(`  ${pad(s.resourceId, 12)} ${pad(s.source, 13)} ${pad(limits, 34)} scarcity ${pad(g.scarcity == null ? 'unknown' : pct(g.scarcity), 8)} via ${s.usageSource.replace(/_/g, ' ')}`)
  }

  for (const t of TASKS) showRun(t.title, { ...(await routeOne({ ...t, quiet: has('--quiet') })), quiet: has('--quiet') })

  const n = valueOf('--learn', 0)
  if (n > 0) {
    out(rule(`Routing ${n} more tasks, then seeing what the router learned`))
    for (let i = 0; i < n; i++) {
      const t = TASKS[i % TASKS.length]
      await routeOne({ task: `${t.task} (${i})`, profile: t.profile, quiet: true })
      if ((i + 1) % 10 === 0) out(`  ${i + 1} routed`)
    }
    for (let i = 0; i < 4; i++) await domains.evaluateAll()
    out('')
    out('Routing domains')
    for (const [id, st] of Object.entries(domains.states())) {
      const blocked = st.progress?.blocked ?? []
      out(`  ${pad(id.replace(/_/g, ' '), 22)} ${pad(st.maturity, 14)} ${pad(`${st.samples?.verified ?? 0} verified`, 14)} ${st.progress?.next ? `next ${st.progress.next}${blocked.length ? `, waiting on ${blocked.join(', ')}` : ', all gates met'}` : 'fully matured'}`)
    }
    out('')
    out('One more task of the same shape, to see who decides now:')
    const again = await routeOne({ ...TASKS[1], quiet: true })
    out(`  who decided   ${Object.entries(again.run.routing.decision.domains).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.authority}`).join(' | ')}`)
    out(`  Jev calls     ${again.run.routing.decision.jevCalls}`)
    out(`  picked        ${again.run.routing.primaryAgent} under ${again.run.strategy}`)
  }

  out(rule('The report a person would have seen for the last run'))
  const last = await routeOne({ ...TASKS[3], quiet: true })
  out(formatReport(last.run).split('\n').slice(0, 26).join('\n'))
  out('')
  out(`Demo state was written to ${stateRoot} and can be deleted.`)
}

main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1) })
