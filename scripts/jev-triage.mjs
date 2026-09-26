// Triage for a code review's raw findings: the stage between FIND and VERIFY.
//
// Several reviewer agents read the same commit through different lenses, so the same
// defect comes back three times in three wordings, next to findings that assert nothing
// at all. VERIFY then pays one agent per finding to open the files and try to refute it,
// which is where nearly all the money goes. This asks Jev three typed questions over the
// finding text alone and hands VERIFY a shorter list: is this the same defect as an
// earlier one in the same file, how severe is it really, and is there anything in it a
// reader could check.
//
// Usage: node scripts/jev-triage.mjs < findings.json > triaged.json
//   in:  [{ file, line, severity, problem, failure, fix }, ...]
//   out: { kept: [...findings + mergedFrom + jevSeverity], dropped: [...+ reason, confidence], stats }
//
// PRIVACY: the findings go to TypeSafe, a third party, and they carry file paths and
// descriptions of code. That is the same class of data this harness already sends Jev
// when it routes a task (task text, diff excerpts, check output), so it is nothing new
// here, but it is worth saying out loud rather than leaving someone to discover it.
// Key-shaped strings are masked first with the same scrubber the Markdown export uses,
// and the TypeSafe key itself is never printed, logged or put in the output.
//
// FAIL OPEN: missing key, no network, a timeout, a 401, an answer that does not parse:
// every finding passes through untouched, stats says triage did not run and why, and the
// exit code stays 0. Losing a real finding to a failed network call is the worst thing
// that could happen here; paying one verify agent for a duplicate is not.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from '../plugins/jev-router/accounts.js'
import { redactSecrets } from '../plugins/jev-router/export.js'
import { JEV_USD_PER_INPUT_TOKEN } from '../plugins/jev-router/usage.js'
import { runAsScript } from './run-as-script.mjs'

// The SDK is the plugin's dependency, not this folder's, so a bare import from scripts/
// would not resolve. Anchored at the plugin's package.json it resolves exactly as it does
// inside the plugin, without naming a path inside the package.
const require = createRequire(new URL('../plugins/jev-router/package.json', import.meta.url))
const { TypeSafeClient, choice, noul, score } = require('@typesafe-ai/sdk')

const KEY = 'TYPESAFE_API_KEY'
const TIMEOUT_MS = 20_000

/**
 * A Noul answers with the probability of yes, and that probability is its own confidence:
 * 0.5 is a shrug. The router acts on its Nouls at 0.5 because a wrong routing decision
 * costs one retry. A drop here costs the bug, because nothing looks at a dropped finding
 * again, so both a drop and a merge need the answer past 0.7 and everything short of that
 * is kept. Keeping a weak finding costs one verify agent; that asymmetry is the whole
 * reason for the number.
 */
const CONFIDENT = 0.7

// The judgment needs what the reviewer said, not an essay. About a paragraph per field,
// which also caps the bill when a reviewer pastes half a file into `problem`.
const FIELD_CHARS = 600
const DUP_HINT_CHARS = 140

const SEVERITY = ['info', 'low', 'medium', 'high', 'critical']
const SEVERITY_LEVELS = [
  'Info: nothing is broken. A note, a preference, a suggestion, or praise',
  'Low: a real but minor defect: cosmetic, or easily noticed and reverted',
  'Medium: a defect that breaks a feature for some users or some inputs',
  'High: a defect that breaks a core flow, loses data on a normal path, or is a real vulnerability',
  'Critical: a defect that corrupts data, compromises security or money, or takes the system down',
]
// Reviewers write their own vocabularies. An unknown word ranks -1, below `info`, so it
// never wins the harshest-severity contest by accident.
const SYNONYMS = { blocker: 'critical', severe: 'critical', major: 'high', moderate: 'medium', warning: 'medium', minor: 'low', nit: 'info', note: 'info', suggestion: 'info', trivial: 'info' }
const rankOf = (s) => { const k = String(s ?? '').trim().toLowerCase(); return SEVERITY.indexOf(SYNONYMS[k] ?? k) }

const ID = (i) => `f${i}`
const INDEX = (id) => Number(String(id).slice(1))
const at = (f) => `${f.file}:${f.line}`
const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places

const clip = (v, max = FIELD_CHARS) => {
  if (v === undefined || v === null) return v
  const s = redactSecrets(String(v))
  return s.length <= max ? s : `${s.slice(0, max)}...[truncated]`
}

/**
 * What Jev sees. The reviewer's own severity is deliberately left out: Jev is being asked
 * for an independent severity, and showing it the label it is meant to second-guess would
 * anchor it on exactly the inflation this is looking for.
 */
const stateOf = (findings) => ({
  findings: Object.fromEntries(findings.map((f, i) => [ID(i), {
    file: clip(f.file), line: f.line, problem: clip(f.problem), failure: clip(f.failure), fix: clip(f.fix),
  }])),
})

/**
 * One call, three judgments, O(n) questions.
 *
 * The obvious shape for MERGE is a Noul per pair, which is O(n^2) questions and, on a real
 * review, costs more than the verify agents it saves. Instead each finding is asked once,
 * as a Choice, which earlier finding it repeats: the same answer in n questions rather
 * than n^2/2, and the chains it produces group three wordings of one defect just as well.
 * Candidates are restricted to the same file by a free prefilter, so Jev is never asked to
 * compare a finding in one file with a finding in another.
 */
function questionsFor(findings) {
  const questions = {}
  const earlierInFile = new Map()
  findings.forEach((f, i) => {
    const me = ID(i)
    questions[`testable.${me}`] = noul({
      question: `Does finding \`${me}\` assert something about the code that another agent could check and find true or false?`,
      focus: 'Yes when it names a concrete behaviour, value, path or condition that either holds or does not. No when it is a preference, a general worry, advice, or praise, with nothing to confirm or refute.',
    })
    questions[`severity.${me}`] = score({
      question: `How severe is the problem finding \`${me}\` describes?`,
      focus: 'Judge the consequence the finding actually describes, in this file, on a path that really runs.',
    }, SEVERITY_LEVELS)
    const earlier = earlierInFile.get(f.file) ?? []
    if (earlier.length) {
      questions[`dup.${me}`] = choice({
        question: `Which earlier finding, if any, is about the same underlying defect as finding \`${me}\`?`,
        focus: 'The same defect means one fix settles both, even where the two describe it differently or point at different lines. Two different defects in the same function are not the same defect.',
      }, {
        none: { what: `No earlier finding describes the same defect as \`${me}\`` },
        ...Object.fromEntries(earlier.map((e) => [e, { what: `The same defect as \`${e}\`: ${clip(findings[INDEX(e)].problem, DUP_HINT_CHARS)}` }])),
      })
    }
    earlierInFile.set(f.file, [...earlier, me])
  })
  return questions
}

/** The key, the way the plugin resolves it: the process env first, then the harness .env. Returned, never printed. */
function apiKey() {
  const fromEnv = process.env[KEY]?.trim()
  if (fromEnv) return fromEnv
  for (const file of [join(process.env.DSH_HOME || join(homedir(), '.kzh'), '.env'), join(homedir(), '.dsh', '.env')]) {
    if (!existsSync(file)) continue
    const value = parseEnv(readFileSync(file, 'utf8')).get(KEY)
    if (value) return value
  }
  return null
}

/** The real Jev call, in jev.js's shape. Null when there is no key, which is a fail-open reason, not an error. */
export function createAsk({ timeoutMs = TIMEOUT_MS, model } = {}) {
  const key = apiKey()
  if (!key) return null
  const client = new TypeSafeClient({ apiKey: key, ...(model ? { defaultModel: model } : {}) })
  return async (state, questions) => {
    const t0 = Date.now()
    const call = client.systemOne({ state, questions }, { timeout: timeoutMs })
    // The request id only arrives through `.withResponse()`, and it is the one handle
    // TypeSafe support can act on when a judgment looks wrong. Falls back cleanly.
    const { data, requestId } = typeof call?.withResponse === 'function'
      ? await call.withResponse()
      : { data: await call, requestId: undefined }
    return { ...data, requestId, ms: Date.now() - t0 }
  }
}

function passThrough(findings, reason) {
  return {
    kept: findings.slice(),
    dropped: [],
    stats: { in: findings.length, kept: findings.length, merged: 0, droppedNoClaim: 0, inflated: 0, jev: { ran: false, reason: redactSecrets(String(reason)) } },
  }
}

async function judge(findings, call) {
  const questions = questionsFor(findings)
  const res = await call(stateOf(findings), questions)
  const answers = res?.answers
  if (!answers) throw new Error('the response carried no answers')
  // Anything not a finite number here means the answer did not parse, which is a fail-open
  // reason: the caller gets every finding back rather than a list filtered on nonsense.
  const num = (v, name) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`answer ${name} is not a number`); return v }

  // MERGE, resolved into chains: f3 repeats f2 repeats f1 is one group, not two pairs.
  const parent = findings.map((_, i) => i)
  const rootOf = (i) => { let r = i; while (parent[r] !== r) r = parent[r]; return r }
  const mergeConfidence = new Map()
  findings.forEach((_, i) => {
    const a = answers[`dup.${ID(i)}`]
    if (!a) return // first finding in its file: no question was asked
    if (a.choice === 'none' || num(a.confidence, `dup.${ID(i)}`) < CONFIDENT) return
    const j = INDEX(a.choice)
    if (!Number.isInteger(j) || j < 0 || j >= i) throw new Error(`dup.${ID(i)} names ${a.choice}`)
    parent[i] = rootOf(j)
    mergeConfidence.set(i, a.confidence)
  })

  const testable = findings.map((_, i) => num(answers[`testable.${ID(i)}`]?.noul, `testable.${ID(i)}`))
  const jevSeverity = findings.map((_, i) => {
    const s = Math.round(num(answers[`severity.${ID(i)}`]?.score, `severity.${ID(i)}`))
    return SEVERITY[Math.min(SEVERITY.length - 1, Math.max(0, s))]
  })

  const groups = new Map()
  findings.forEach((_, i) => { const r = rootOf(i); groups.set(r, [...(groups.get(r) ?? []), i]) })

  const kept = []
  const dropped = []
  let merged = 0
  let droppedNoClaim = 0
  for (const [root, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    const dupes = group.filter((i) => i !== root)
    merged += dupes.length
    // A merged finding leaves `kept`, so it is listed here too: `dropped` is the one place
    // to look for everything that did not make it through, and mergedFrom keeps its text.
    for (const i of dupes) {
      dropped.push({ ...findings[i], reason: `merged: the same defect as the finding at ${at(findings[root])}`, confidence: round(mergeConfidence.get(i)) })
    }
    // The harshest severity any reviewer gave, on purpose: reviewers disagree downward as
    // often as upward, and how many of them saw it is itself signal, which mergedFrom counts.
    const worst = group.reduce((a, b) => (rankOf(findings[b].severity) > rankOf(findings[a].severity) ? b : a))
    const entry = {
      ...findings[root],
      severity: findings[worst].severity,
      mergedFrom: dupes.map((i) => ({ line: findings[i].line, severity: findings[i].severity, problem: findings[i].problem, confidence: round(mergeConfidence.get(i)) })),
      jevSeverity: jevSeverity[root],
    }
    // TRIAGE, over the whole group: a duplicate often states the claim better than the
    // first reviewer did, so a group goes only when no wording of it says anything
    // checkable. A Noul is its own confidence, so one comparison carries both the answer
    // and the certainty: 0.3 or less is a confident no, anything above it is kept.
    const loudest = Math.max(...group.map((i) => testable[i]))
    if (loudest <= 1 - CONFIDENT) {
      droppedNoClaim += 1
      dropped.push({
        ...entry,
        reason: `no testable claim: nothing in it is true or false about the code${dupes.length ? `, and neither is any of its ${dupes.length} duplicate(s)` : ''}`,
        confidence: round(1 - loudest),
      })
    } else kept.push(entry)
  }

  const input = res.usage?.input_tokens ?? 0
  const output = res.usage?.output_tokens ?? 0
  return {
    kept,
    dropped,
    stats: {
      in: findings.length,
      kept: kept.length,
      merged,
      droppedNoClaim,
      // Reviewers inflate; this is the count, and every kept finding carries both severities.
      inflated: kept.filter((k) => rankOf(k.severity) > SEVERITY.indexOf(k.jevSeverity)).length,
      jev: {
        ran: true,
        model: res.model,
        requestId: res.requestId,
        ms: res.ms,
        calls: 1,
        questions: Object.keys(questions).length,
        tokens: { input, output },
        costUsd: round(input * JEV_USD_PER_INPUT_TOKEN, 6),
      },
    },
  }
}

/**
 * Triage `findings`. Never throws for a Jev problem: it returns everything instead.
 * `ask` is the seam the tests stub; left out, the real client is built from the key.
 */
export async function triage(findings, { ask } = {}) {
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array')
  if (!findings.length) return passThrough(findings, 'no findings to triage')
  try {
    const call = ask ?? createAsk()
    if (!call) return passThrough(findings, `${KEY} is not configured`)
    return await judge(findings, call)
  } catch (err) {
    return passThrough(findings, err?.message || String(err))
  }
}

const invokedDirectly = runAsScript(import.meta.url)
if (invokedDirectly) {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  let findings = null
  // A byte order mark is what a Windows producer puts in front of its JSON, and JSON.parse
  // refuses it: stripping it here beats a confusing "unexpected token" on a valid file.
  try { findings = JSON.parse(text.replace(/^﻿/, '')) } catch (err) { process.stderr.write(`jev-triage: stdin is not JSON: ${err.message}\n`) }
  if (Array.isArray(findings)) {
    process.stdout.write(`${JSON.stringify(await triage(findings), null, 2)}\n`)
  } else {
    // Not a Jev failure and nothing to pass through, so this one is a real error. Exit is by
    // exitCode, never process.exit(), so stdout is flushed before the process ends.
    if (findings !== null) process.stderr.write('jev-triage: expected a JSON array of findings on stdin\n')
    process.exitCode = 1
  }
}
