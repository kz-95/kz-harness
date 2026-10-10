// jev-router: DSH plugin. TypeSafe Jev routes each coding task to one of the
// registered agents, deterministic checks verify the result, and Jev assesses
// it (accept / second review / retry / human) within configured limits.
//
// Executors are DSH subagent providers, so auth and permissions stay native:
//   claude   -> @deepseek-ai/dsh-subagent-claude-code (Claude subscription login)
//   codex    -> @deepseek-ai/dsh-subagent-codex       (ChatGPT login)
//   deepseek -> built-in `spawn` provider              (DSH's DeepSeek model)
// A new agent is one `agents` entry naming any installed subagent provider.
//
// Laya, a decision model on this PC, is the second decider beside Jev (docs/laya-auto.md): in the
// Laya Auto row it answers every routing, intent and review question instead of Jev, and in Jev
// Auto it answers the same questions in the background (the shadow) so the two can be compared.
// Its supervisor, client, stores and shadow are all wired here.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { createJev } from './jev.js'
import { OUT_STATES, formatReport, notReadyWhy, pickedBy, plannedEffort, pricingNow, routerStep, routingPolicy, runRouted, whyNotPicked } from './router.js'
import { LEVELS, RATINGS_AGREE, claudeFastMode, codexServiceTier, effortBias, effortBiases, effortFamily, effortVotes, ratingWay, toAgentEffort } from './effort.js'
import { run } from './workspace.js'
import { authAction, canAuth, checkAgents } from './setup.js'
import { JEV_PROVIDER, isNoProject, jevAdapter, line, nameOfAgent } from './adapter.js'
import { LOCK_UNAVAILABLE, NEEDS_LANE, executorsFrom, lockOf } from './capabilities.js'
import { createDelivery } from './delivery.js'
import { createFormatter } from './format.js'
import { CLEAR, createFeedback, tagVotesOnAgent, validFeedback } from './feedback.js'
import { TERMINAL_STATES, WAITING, createLanes, createMutex, createRunLog, createTasks, guessMissed, laneKey, runAdmitted, runKeysOf, seenResults, startedNoticeDue, validJobId } from './tasks.js'
import { againNotice, changeNotice, changeReason, creditLine, effortFrom, followUpTask, learnedLine, liveStatusSentence, movedNotice, noTaskWords, planReply, queuedReply, ratedEffortLine, restartTask, restartedReason, startNowWords, startedNotice, startingReply, steerWords, steeredTaskWords, withRunMark, workerStep } from './reply-words.js'
import { createWaitStats, waitEstimate } from './waits.js'
import { SESSION_ID, exportSession, redactSecrets } from './export.js'
import { KEY_NAME, KEY_NAME_RULE, createAccounts, keyProviderOf, kindOf, parseUse } from './accounts.js'
import { createUsage, detectLimit, longWindowPercent } from './usage.js'
import { DOMAINS, gatesFor, resolvePolicy } from './routing-policy.js'
import { answererUnconfigured, createCapabilityRegistry, evidenceFromFeedback, evidenceFromRun, loadPriors, subjectOf } from './profiles.js'
import { snapshotResources } from './resources.js'
import { governorSignals } from './governor.js'
import { createTrainingStore, labelFromRun } from './training.js'
import { createDomainRegistry } from './domains.js'
import { createDecisionEngine } from './decision.js'
import { LOCAL_PROVIDER, buildCatalog, createConnectivity, createLocalModels, detectSpecs, installLlmCommand, localAdapter, looksLikeQuestion, readManifest, removeLlmCommand } from './local.js'
import { JEV_THRESHOLDS, LAYA_SCHEMA, MINIMUM_REVIEW_KEYS, resolveProviders, thresholdsSchema } from './providers.js'
import { createResidency } from './residency.js'
import { LAYA_TEXT, LayaUnavailable, createLayaSidecar } from './laya-sidecar.js'
import { createLayaInstaller, installOffer, readPins } from './laya-install.js'
import { createLayaClient } from './laya-client.js'
import { createColibriLaya } from './colibri-laya.js'
import { createProbe, runSelfTest, selfTestCalls, taskCalls } from './laya-selfcheck.js'
import { estimateRequestTokens, renderForLaya } from './laya-questions.js'
import { createShadow, jevHostOf } from './shadow.js'
import { agentEnv, createBenchmark, timedOutBy } from './benchmark.js'
import { INTENT_TAGS, classifyIntent } from './intent.js'
import { createReplyLedger, replyFeatures, replyGates } from './reply-ledger.js'
import { createLiveStore } from './live.js'
import { processHandover } from './handover.js'
import { patchKeyOf, patchState } from './engine-patches.js'
import { createSteerers, heardInEvents, heardInTap, heldWords, idleWhy, livePath, liveWords, nextState, nowHeldWords, nowLeft, nowPath, nowWords, sendLive, sendNow, sendableWhy, steerStateWords, steerableRole } from './steer.js'

export const name = 'jev-router'
export const inject = ['tools', 'commands', 'subagents', 'credentials']

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const harnessDir = fileURLToPath(new URL('../../', import.meta.url))
const LOCAL_PERSONA = 'You are a careful software engineer working as a delegated coding agent on a small local model. Keep changes small and focused, complete the task in the given workspace, and report concisely.'
// How many runs one /jev-router/history response carries, newest last. The cap is a response
// size, not a storage rule: history.jsonl keeps every run.
const HISTORY_RESPONSE_CAP = 200

const Agent = Schema.object({
  id: Schema.string().pattern(/^[a-z][a-z0-9_-]*$/).required().description('Short id, also the manual override command name.'),
  provider: Schema.string().required().description('Subagent provider name, e.g. claude-code, codex, spawn.'),
  name: Schema.string().description('Shown in the model menu, the inspector and reports. Defaults to the id, title-cased.'),
  // What the agent IS, not what it is good at. Capability beliefs live as data in
  // config/capability-priors.json and are measured from here on; a strengths sentence here would be
  // a second, unmeasured belief system. When a run has a decision record, Jev reads the anonymous
  // candidate table instead of this text, for the resource pick and for review and retry. Without
  // one it reads this text: with routing.enabled false, on a run whose agent was picked by hand, and
  // on a run that fell back because the decision engine failed. There, on the default text, Jev
  // tells the agents apart mainly by how each is paid for. That is deliberate: those paths are not
  // the adaptive router, and the old strengths prose contradicted the owner's priors.
  description: Schema.string().required().description('What this agent is: which CLI or API it runs, and how it is paid for. Not what it is good at: capability beliefs live in config/capability-priors.json and are measured from real runs. When a run has a decision record, Jev reads the anonymous candidate table instead. Without one (routing.enabled false, an agent picked by hand, or a run that fell back because the decision engine failed) this is what Jev reads for the pick, the review and the retry, so on the default text it tells the agents apart mainly by how each is paid for; write your own here if you route that way.'),
  enabled: Schema.boolean().default(true),
  persona: Schema.string().description('Optional persona for providers that accept one (spawn).'),
  credentialRef: Schema.string().description('API key credential that must be set for this agent to run (BYOK agents).'),
  peer: Schema.string().description('Agent that takes over when this one hits its limit (default: claude <-> codex).'),
  llm: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).description('Model for `spawn` agents, e.g. any provider added in Settings -> Models (BYOK). Required, or the agent inherits Jev as its model.'),
})

const Tool = Schema.object({
  id: Schema.string().pattern(/^[a-z][a-z0-9_-]*$/).required(),
  description: Schema.string().required().description('What the tool does exactly. Jev picks it only when it fully covers the task.'),
  command: Schema.string().required().description('Shell command, run in the workspace. The task text arrives on stdin; each param as env var JEV_ARG_<PARAM>.'),
  params: Schema.dict(Schema.object({
    question: Schema.string().required(),
    options: Schema.dict(String).required().description('value -> description; Jev picks one.'),
  })).default({}),
  enabled: Schema.boolean().default(true),
})

export const Config = Schema.object({
  agents: Schema.array(Agent).default([
    {
      id: 'claude',
      name: 'Claude Code',
      provider: 'claude-code',
      description: 'The Claude Code CLI (claude-code), signed in with its own login and paid for by your Claude subscription.',
      enabled: true,
    },
    {
      id: 'codex',
      name: 'Codex (GPT)',
      provider: 'codex',
      description: 'The OpenAI Codex CLI (codex), signed in with its own login and paid for by your ChatGPT subscription.',
      enabled: true,
    },
    {
      id: 'deepseek',
      name: 'DeepSeek agent',
      provider: 'spawn',
      description: 'The native harness agent (spawn) on the DeepSeek API, paid per token from the DEEPSEEK_API_KEY balance.',
      enabled: true,
      credentialRef: 'DEEPSEEK_API_KEY',
      llm: { provider: 'deepseek', model: 'deepseek-flash' },
      persona: 'You are a careful senior software engineer working as a delegated coding agent. Complete the task in the given workspace and report concisely.',
    },
  ]).description('Cloud and subscription agents. Local agents (qwen-local, gemma-local, …) come from config/local-models.json once their model is installed.'),
  tools: Schema.array(Tool).default([]).description('Deterministic scripts Jev can run instead of an LLM agent.'),
  auxModel: Schema.object({
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
  }).default({}).description('Real model the Jev Auto model hands session titles, conversation compaction and direct answers to. Unset, these follow this machine: the installed local chat model when there is one, then the first enabled agent that pins llm.provider and llm.model. Set both to pin one.'),
  local: Schema.object({
    port: Schema.natural().default(8081).description('First 127.0.0.1 port for llama-server; the next ones are tried when it is taken.'),
    contextSize: Schema.natural().min(2048).description('Context tokens every local model starts with; unset = the model\'s manifest value (16,384), 12,288 on PCs with under 12 GB RAM. A RAM budget may size it down, to 12,288 at least.'),
    modelWaitCapMinutes: Schema.natural().min(1).max(60).default(2).description('How long, in minutes, a local agent waits for another local model before its own goes next: from then on no local agent joins that model ahead of it, and its model is loaded once the agents already on that model end. 1 to 60; the wait is always capped.'),
    outputCheckShare: Schema.number().min(0).max(1).default(0.5).description('How much of the output a model gave in its first speed run with this engine build and GPU split a later run must repeat, from its start, for the two to count as the same: 0.5, as shipped, is the first 32 of 64 tokens; 1 all of it; 0 takes every output as the same. A run whose output differs keeps its speed figure apart until it is accepted in Settings, Local models. Provisional until it is measured on this PC.'),
  }).description('Local models (llama.cpp llama-server under <harness>/engine/llama, GGUF files under <harness>/models).'),
  format: Schema.object({
    enabled: Schema.boolean().default(true).description('Rewrite a finished background result into readable prose with the installed local chat model before it is posted. Off, the report is posted exactly as the agent wrote it.'),
    timeoutMs: Schema.natural().min(1000).default(60_000).description('Wall clock for one rewrite call; on timeout the report is posted as written.'),
    reserveTokens: Schema.natural().default(2048).description('Context kept back for the prompt and the answer when sizing the report body against the model window.'),
  }).default({}).description('Message transfer: the result body is rewritten by the small local model when one is installed. Only the report body changes; the structured head (task, id, agent, status) is never touched.'),
  effort: Schema.object({
    default: Schema.union(LEVELS).default('auto').description('Effort when the model menu says Auto.'),
    perAgent: Schema.object({
      claude: Schema.union(['low', 'medium', 'high', 'xhigh', 'max']),
      codex: Schema.union(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      deepseek: Schema.union(['off', 'low', 'high', 'max']),
    }).default({}).description('Fixed effort per agent; wins over the menu and the default.'),
    codexSpeed: Schema.union(['normal', 'fast']).default('normal').description('fast = Codex 1.5x (service tier priority).'),
    claudeSpeed: Schema.union(['normal', 'fast']).default('normal').description('fast = Claude Code fast mode, which costs more (it needs usage credits on your Claude account and the engine patch the Live agent view card names).'),
    ratingsMove: Schema.boolean().default(true).description('Let your `wrong effort` ratings of the picks move Auto effort one step for an agent and a kind of work (Settings, Effort).'),
    ratingsResetAt: Schema.string().description('Ratings given before this time move Auto effort no more (Settings, Effort, Reset). Nothing is deleted.'),
  }).default({}),
  pricing: Schema.object({
    peak: Schema.dict(Schema.object({
      windowsUtc: Schema.array(Schema.object({
        fromUtc: Schema.string().pattern(/^\d{1,2}:\d{2}$/).required().description('Window start, UTC "HH:MM".'),
        toUtc: Schema.string().pattern(/^\d{1,2}:\d{2}$/).required().description('Window end, UTC "HH:MM"; an end at or before the start wraps past midnight.'),
      })).default([]).description('The hours the dearer rate applies. Everything outside them is off-peak.'),
      daysUtc: Schema.array(Schema.number().min(0).max(6)).default([1, 2, 3, 4, 5]).description('UTC days peak applies, 0 = Sunday. The default is Monday to Friday.'),
      note: Schema.string().description('Shown to Jev, e.g. what the difference costs.'),
    })).default({
      // DeepSeek charges double during Beijing business hours only: Mon-Fri 09:00-12:00 and
      // 14:00-18:00 CST, which is 01:00-04:00 and 06:00-10:00 UTC. Everything else, every
      // evening and the whole weekend, is already the cheap rate. Confirmed from DeepSeek's
      // 2026-09-10 pricing notice; check https://api-docs.deepseek.com/quick_start/pricing
      // and edit here if they move it.
      deepseek: {
        windowsUtc: [{ fromUtc: '01:00', toUtc: '04:00' }, { fromUtc: '06:00', toUtc: '10:00' }],
        daysUtc: [1, 2, 3, 4, 5],
        note: 'DeepSeek peak is exactly twice off-peak on every line: output 8 vs 4 CNY per million tokens',
      },
    }).description('Agent id -> the hours its provider charges its DEARER rate. Jev prefers an agent on its cheap rate when the choice is otherwise even.'),
  }).default({}).description('Time-of-day pricing, for the providers that have it.'),
  links: Schema.dict(Schema.object({
    keys: Schema.string().description('Where this provider issues API keys.'),
    topUp: Schema.string().description('Where this provider takes payment.'),
  })).default({
    // console.typesafe.ai/keys and /billing both resolve (307 to login), so both are real.
    // DeepSeek serves 403 to anything unauthenticated, so /top_up could not be checked:
    // api_keys is known good, and the rest is editable here if it ever moves.
    deepseek: { keys: 'https://platform.deepseek.com/api_keys', topUp: 'https://platform.deepseek.com/top_up' },
    jev: { keys: 'https://console.typesafe.ai/keys', topUp: 'https://console.typesafe.ai/billing' },
  }).description('Per key-provider links shown on the Usage cards: where to get a key, where to top up.'),
  policy: Schema.object({
    gateAtPercent: Schema.dict(Schema.number().min(0).max(100)).default({
      // Past this share of its WEEKLY window a subscription stops doing bulk work and is
      // kept for reviewing, where its remaining percent buys the most. Set per plan:
      // Claude Pro 80 / Max 90; Codex Plus 80 / Pro 90. The plan cannot be detected
      // reliably (the live endpoint reports none, and the cached credential lags an
      // upgrade), so this is yours to set rather than something guessed for you.
      default: 80,
    }).description('Agent id -> weekly percent at which it stops taking execution work. "default" applies to the rest.'),
    minRoutingConfidence: Schema.number().min(0).max(1).default(0.5)
      .description('Below this confidence Jev is treated as undecided, and a metered pick is swapped for a subscription agent it rated about the same.'),
    tieMargin: Schema.number().min(0).max(1).default(0.1)
      .description('How close another agent must be to the top pick to count as tied, for the swap above.'),
    stallAfter: Schema.number().min(1).max(10).default(2)
      .description('Work attempts in a row that change no files before the run stops and asks a person, instead of retrying again.'),
  }).default({}).description('Cost policy: how far a subscription is spent on bulk work before the API takes over.'),
  routing: Schema.object({
    enabled: Schema.boolean().default(true).description('Adaptive routing: capability profiles, resource adapters and the learning routing domains. Off, the router asks Jev the way it always did.'),
    learn: Schema.boolean().default(true).description('Record every routing decision, its verified outcome and the capability evidence a run or a verdict gives, and let a routing domain earn local authority. Off, nothing new is recorded and Jev keeps deciding: the capability evidence already on disk still informs routing, but it no longer grows.'),
    disabledResources: Schema.array(String).default([]).description('Resource (agent) ids the router may never pick.'),
    allowedResources: Schema.array(String).default([]).description('When set, the only resource ids the router may pick.'),
    gates: Schema.dict(Schema.any()).description('Promotion, calibration and rollback thresholds per risk class (LOW, MEDIUM, HIGH). Omitted fields keep the defaults in routing-policy.js.'),
    governor: Schema.dict(Schema.any()).description('Conservation curves per plan, reset weighting, staleness and the expected-cost weights.'),
    capabilityTiers: Schema.dict(Schema.number().min(0).max(1)).description('Effective score at which a resource counts as standard, strong or frontier.'),
    minimumReview: Schema.dict(Schema.number().min(0).max(1)).description('riskForReview and riskForFrontierReview: the risk at which the DETERMINISTIC FALLBACK asks for a review, or a frontier review, when neither Jev nor a trusted local classifier answers those judgments. Not a floor under their answers.'),
    retrain: Schema.dict(Schema.any()).description('How often a routing domain retrains, and the training options.'),
    drift: Schema.dict(Schema.number()).description('Drift and out-of-distribution thresholds.'),
    priorsFile: Schema.string().description('Capability priors file, relative to the harness root. Default: config/capability-priors.json'),
  }).default({}).description('The adaptive router: what each resource is good at, what it costs, and which routing domains have earned the right to decide without Jev.'),
  // The measured records the start reply's predictor of the pick must keep (reply-ledger.js
  // REPLY_GATES); replyGates() refuses a right above its of.
  replies: Schema.object({
    quick: Schema.object({
      right: Schema.natural().min(1).default(45),
      of: Schema.natural().min(1).default(50),
    }).default({}).description('A start reply may name the predicted agent before routing once the predictor was right this many times (right) of its last scored replies (of).'),
    likely: Schema.object({
      right: Schema.natural().min(1).default(16),
      of: Schema.natural().min(1).default(20),
    }).default({}).description('A reply that waits may name the likely agent once the predictor was right this many times (right) of its last scored replies (of).'),
  }).default({}).description('When a start reply may name the guess of its predictor of the pick. The predictor learns in the background from every routed task and is scored against what the router runs; a reply names its guess only while the predictor keeps the record set here, and the How Jev replies card in Settings shows that record and whether quick replies and the likely agent are on or paused.'),
  resources: Schema.object({
    plans: Schema.dict(Schema.string()).default({}).description('Agent id -> plan name (pro, max, plus, team). Sets the conservation curve for a provider that does not report its plan.'),
    economics: Schema.dict(Schema.object({ marginalCost: Schema.union(['none', 'low', 'metered']) })).default({}).description('Agent id -> how a job on it is funded, when the default by provider is wrong.'),
  }).default({}).description('Facts about each provider that its own API does not report.'),
  fallbackAgent: Schema.string().default('claude').description('Agent used when Jev is unavailable.'),
  credentialRef: Schema.string().default('TYPESAFE_API_KEY').description('Credential name for the TypeSafe API key (env, .credentials.yaml, or .env).'),
  jevModel: Schema.string().default('jev-1.13.0').description('TypeSafe model id, pinned so tuned thresholds keep their meaning.'),
  jevTimeoutMs: Schema.natural().default(20_000),
  agentTimeoutMs: Schema.natural().default(20 * 60_000),
  limits: Schema.object({
    maxAttempts: Schema.natural().min(1).default(3).description('Primary attempt plus retries.'),
    maxReviews: Schema.natural().default(2),
    maxRounds: Schema.natural().min(1).default(5).description('All agent runs, work and review.'),
  }),
  // Jev's cut-offs, each defaulting to the value the code has always used, so a config that sets
  // none of them decides as it always did (docs/laya-auto.md 2.6). riskForReview and
  // riskForFrontierReview stay under routing.minimumReview, their one source for Jev.
  thresholds: thresholdsSchema(JEV_THRESHOLDS, { omit: MINIMUM_REVIEW_KEYS }).description('Every bar Jev\'s answers are read against. Laya has its own, under laya.thresholds.'),
  // Typed only in providers.js (LAYA_SCHEMA), which resolveProviders runs inside its own try/catch:
  // the host refuses to load the plugin on a Config error, and one bad Laya value must not take
  // Jev Auto down with it.
  laya: Schema.any().default({}).description('The Laya decision model; validated by providers.js, see docs/laya-auto.md 2.2.'),
  checks: Schema.object({
    enabled: Schema.boolean().default(true),
    scripts: Schema.array(String).default(['typecheck', 'lint', 'test', 'build']).description('package.json scripts to run when present, in order.'),
    timeoutMs: Schema.natural().default(10 * 60_000),
    outputChars: Schema.natural().default(3000),
  }),
  productionWorkspaces: Schema.array(String).default([]).description('Path prefixes Jev is told are production-critical.'),
  historyFile: Schema.string().default(join(dshHome, 'jev-router', 'history.jsonl')),
  registerTool: Schema.boolean().default(true).description('Expose the jev_route tool (used by the Jev Auto preset).'),
  savings: Schema.object({
    baseline: Schema.object({
      name: Schema.string().default('Chat LLM front desk (DeepSeek Flash)'),
      inputPerMTok: Schema.number().min(0).default(0.28).description('Assumed USD per million input tokens.'),
      outputPerMTok: Schema.number().min(0).default(1.1).description('Assumed USD per million output tokens.'),
      outputTokens: Schema.natural().default(300).description('Assumed output tokens per decision.'),
      latencyMs: Schema.natural().default(4000).description('Assumed time per decision.'),
    }).description('The "without Jev" setup the Usage tab estimate compares against: a chat LLM making each Jev decision. Assumptions, not quoted prices.'),
    agentMedianFallbackMs: Schema.natural().default(10_000).description('Agent run time assumed until the usage log has completed agent runs.'),
  }),
})

function textOf(blocks) {
  return (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
}

/**
 * The version an agent really runs, where one is known, for subjectOf and the evidence helpers.
 * A local model's is the manifest SHA-256 of its weights file: an agent for it only exists once
 * the installer has verified the file against that hash, so it names the exact bytes and
 * profiles.js treats it as pinned. Nothing else reports a reliable version today (a CLI alias or
 * an API id is a name its provider may repoint), so the rest is undefined and keyed by the
 * unpinned model name. One function, passed to every reader and writer of profiles, so the
 * evidence a run records and the profile a decision reads have the same key.
 * @param {{ modelOf: (id: string) => { sha256?: string } | undefined }} local createLocalModels()
 */
export const localVersionOf = (local) => (agentDef, model) => (agentDef?.llm?.provider === LOCAL_PROVIDER ? local?.modelOf(agentDef.llm.model ?? model)?.sha256 : undefined)

/**
 * The capability evidence a run gives when it ends: what it did, and no human verdict. Nobody
 * can judge an answer before it exists, and a verdict already in the session is about an earlier
 * answer, so feedback is left out here and credited once, when it is given (creditVerdict).
 * Handing the session's feedback in here as well would count one verdict twice.
 * @param {object} record one history.jsonl row
 * @param {object} deps   evidenceFromRun's, minus feedback
 */
export const runEvidence = (record, deps) => evidenceFromRun(record, { ...deps, feedback: [] })

/**
 * Credit one like, dislike or clear to the capability evidence, when it is given. A run's own
 * evidence is recorded as it ends, before its answer can be judged, so this is the ONLY place a
 * verdict becomes evidence. The run it is about is runOfVerdict's. A clear, or a newest form
 * that credits nothing (a `too slow` tag, an agent that run did not use), retracts whatever the
 * verdict had counted, the same "newest wins" rule feedback.js reads with.
 *
 * Old evidence is kept, rather than replaced or retracted, only when the verdict did not change:
 * the same like or dislike with the same tag as the form before it (`previous`), which is also
 * what the registry counts now (countsAs). Then either learning is off, which stops new credit
 * and nothing here is new, or the rows came back empty only because the agent that gave the
 * judged answer is no longer configured (answererUnconfigured), which says nothing about the
 * verdict. Anything else the person did - a clear, a changed verdict or tag, a tag that is not
 * about capability - is a withdrawal, and a withdrawal is not learning: it retracts with
 * learning off too, and an unrelated agent (a reviewer) being removed never blocks it.
 * @param {object} verdict   one feedback.js row, as stored
 * @param {object[]} records history.jsonl rows (any sessions; only the verdict's is read)
 * @param {{ capabilities: object, previous?: object|null, learn?: boolean } & object} deps the
 *   registry, the form of this verdict before this one (none: it is new), whether learning is
 *   on (default on), and evidenceFromFeedback's deps
 * @returns {object[]} the rows recorded
 */
export function creditVerdict(verdict, records, { capabilities, previous = null, learn = true, ...deps }) {
  // A verdict about the pick a start reply named judges the choice, not an answer: it is no one's
  // capability evidence (profiles.js verdictIsAbout), so it has nothing to record or take back, nor
  // has the clear of one, which carries only its keys.
  if (verdict?.about === 'plan' || (verdict?.verdict === CLEAR && previous?.about === 'plan')) return []
  const run = runOfVerdict(verdict, records, capabilities)
  const cleared = verdict?.verdict === CLEAR
  const rows = cleared || !run || !learn ? [] : evidenceFromFeedback(verdict, run, deps)
  if (rows.length) {
    capabilities.recordMany(rows)
    return rows
  }
  const unchanged = !cleared && sameForm(previous, verdict) && !!capabilities.countsAs?.(verdict)
  if (unchanged && (!learn || (!!run && answererUnconfigured(verdict, run, deps)))) return []
  capabilities.retract(verdict)
  return []
}

// Two forms of one verdict say the same thing: the same like or dislike, the same tag, about the
// same answerer and the same run (a reason is free text and says nothing new about capability).
// A missing attribution matches only a missing one. A run id matches unless both name one and they
// differ: a form posted before the client sent run ids says nothing about which run it was, and
// is found on the run it was credited to either way (runOfVerdict).
const sameForm = (a, b) => !!a && !!b && a.verdict === b.verdict && (a.tag ?? '') === (b.tag ?? '')
  && (a.provider ?? '') === (b.provider ?? '') && (a.model ?? '') === (b.model ?? '')
  && (!a.runId || !b.runId || a.runId === b.runId)

/**
 * The row a verdict is stored as. One given while learning is off is marked: it was stored and
 * nothing learnt from it, so a withdrawal made while learning is still off must not bring it in
 * (onVerdict). A clear is the absence of a verdict and needs no mark.
 * @param {object} record validFeedback's row
 * @param {boolean} [learn]
 */
export const verdictRow = (record, learn = true) => (learn === false && record?.verdict !== CLEAR ? { ...record, learningOff: true } : record)

/**
 * The run a verdict is about. The run its answer came from, when the verdict says which
 * (`runId`: the client reads it off the answer message, where route() writes it with
 * withRunMark), exactly, whatever ran since; a runId that names no run of its session is about
 * nothing here. Otherwise the one it was credited to before, when it was (a reason edited, a tag
 * or a mind changed later is about the same answer, even after newer runs in the session), else
 * the last run of its session that ended at or before the verdict was given. Callers pass the
 * verdict as effectiveVerdicts() dates it - when the answer was FIRST judged - so an edit made
 * after a newer run ended still lands on the answer that was judged. That last rule is a guess:
 * without a runId, a first verdict on an older answer given after a newer run ended lands on the
 * newer run.
 *
 * A verdict that names its task (`taskKey`, which one about a start reply's pick always does) is about
 * the earliest run of that task in its session, the one whose routing its reply named, and about no
 * run while that run has not ended: a job id is used again after a restart, a task key never is. A
 * verdict about the pick that names neither is about no run: by time it could only be guessed at.
 */
export function runOfVerdict(verdict, records, capabilities) {
  const inSession = (records ?? []).filter((r) => r && r.sessionId === verdict?.sessionId)
  if (typeof verdict?.runId === 'string' && verdict.runId) return inSession.find((r) => r.runId === verdict.runId) ?? null
  if (typeof verdict?.taskKey === 'string' && verdict.taskKey) {
    let first = null
    for (const r of inSession) if (r.taskKey === verdict.taskKey && !(Date.parse(first?.ts) <= Date.parse(r.ts))) first = r
    return first
  }
  if (verdict?.about === 'plan') return null
  const creditedTo = capabilities?.creditedRun?.(verdict)
  let run = creditedTo ? inSession.find((r) => r.runId === creditedTo) : undefined
  if (!run) {
    const given = Date.parse(verdict?.ts)
    // The newest run that had ended when the verdict was given; on a tie, the later written.
    for (const r of inSession) { const t = Date.parse(r.ts); if (t <= given && !(Date.parse(run?.ts) > t)) run = r }
  }
  return run ?? null
}

// The run an answer came from, carried in the answer's own text the way router.js carries the
// agent chain: a markdown link reference definition renders as nothing, after a blank line, since a
// definition cannot interrupt the paragraph a report may end on. It is written where every hidden
// mark a message carries is (reply-words.js), since a start reply carries one as a report does.
export { RUN_MARK, withRunMark } from './reply-words.js'

/**
 * One row per judged message: its NEWEST form (what the person thinks now), dated when the
 * answer was FIRST judged (which answer it is about). feedback.jsonl is append-only, so a changed
 * tag or an edited reason is a new row with a new time; dating it by that time moved it onto
 * whichever run had ended most recently, which is not the answer the person was looking at.
 * @param {object[]} rows feedback.js rows, any order
 */
export function effectiveVerdicts(rows) {
  const by = new Map()
  const loose = []
  for (const f of rows ?? []) {
    if (!f || typeof f !== 'object') continue
    if (!f.sessionId || !f.messageId) { loose.push(f); continue }
    const k = `${f.sessionId}\u0000${f.messageId}`
    const cur = by.get(k)
    if (!cur) { by.set(k, { row: f, first: f.ts }); continue }
    if (Date.parse(f.ts) < Date.parse(cur.first)) cur.first = f.ts
    if (!(Date.parse(cur.row.ts) > Date.parse(f.ts))) cur.row = f
  }
  return [...[...by.values()].map(({ row, first }) => ({ ...row, ts: first, ...(row.ts !== first ? { editedAt: row.ts } : {}) })), ...loose]
}

/**
 * Everything a verdict changes, when it is given: the capability evidence of the run it is about,
 * that run's routing labels in the domains that read human feedback (task classification, skill
 * selection and, from a verdict about the pick, resource selection), and the intent of the message
 * (a direct answer's own example, or the example of the message that asked for the run). All of it
 * happens here and only here: a run's own evidence and labels are written as it ends, before anyone
 * can judge its answer. With `learn` off it still runs, for what the person withdrew: a clear or a
 * changed verdict takes back what the earlier form counted, and only new credit waits for learning
 * to be on. A verdict about the pick whose task's run has not ended yet labels nothing (`pending`):
 * bindRun applies it as that run ends.
 *
 * The labels are relabelled in the store of whoever decided the run (docs/laya-auto.md 6.4): Jev's
 * `training` store for a Jev-decided run, `layaStore` for a run Laya decided, and never the other.
 * A Laya run's samples looked up in the Jev store would be missing there and skipped silently. A
 * message's intent is only ever recorded in Jev's store (intent.js), so it is labelled there.
 * @param {object} stored the feedback.js row just appended
 * @param {{ feedbackRows: object[], records: object[], capabilities: object, training?: object, layaStore?: object, versionOf?: Function, agents?: object[], priors?: object, learn?: boolean }} deps
 * @returns {Promise<{ run: object|null, evidence: object[], relabelled: string[], changes: object[], pending: boolean }>}
 *   `changes` are the labels given, `{ domain, id, outcome, store }`, `store` 'jev' or 'laya', and
 *   `outcome` null for a person's label taken off
 */
export async function onVerdict(stored, { feedbackRows, records, capabilities, training, layaStore, versionOf, agents, priors, learn = true }) {
  const effective = effectiveVerdicts(feedbackRows)
  const isThis = (f) => f?.sessionId === stored?.sessionId && f?.messageId === stored?.messageId
  const verdict = effective.find(isThis) ?? stored
  // The form this verdict had before this one: feedback.jsonl is append-only and this is called
  // after `stored` was appended, so it is the last row of the pair and the one before it is that.
  const forms = (feedbackRows ?? []).filter(isThis)
  const previous = forms.at(-2) ?? null
  // What the verdict is about. A clear carries only its keys, so what it takes back is what the
  // message's last form before it named (a clear may follow a clear): its run, its task, whether it
  // judged the pick, and a direct answer's example. Placed by time instead, the clear of a verdict
  // about the pick landed on the newest run of the chat, and a direct answer's on no example at all.
  const last = verdict.verdict === CLEAR ? forms.findLast((f) => f?.verdict !== CLEAR) : null
  const judged = last ? { ...verdict, ...Object.fromEntries(['about', 'taskKey', 'runId', 'intentSample'].filter((k) => last[k]).map((k) => [k, last[k]])) } : verdict
  const run = runOfVerdict(judged, records, capabilities)
  const evidence = creditVerdict(verdict, records, { capabilities, previous, learn, versionOf, agents, priors })
  const relabelled = []
  const changes = []
  const pending = judged.about === 'plan' && !run
  const done = () => ({ run, evidence, relabelled, changes, pending })
  // With learning off nothing new is learnt, but a verdict the person cleared or changed is
  // withdrawn: a human label it gave is recomputed without it. The same verdict again changes
  // nothing, and a sample no person labelled has nothing of it to withdraw.
  const withdrawn = verdict.verdict === CLEAR || !sameForm(previous, verdict)
  if (!learn && !withdrawn) return done()
  // With learning off the label is recomputed from the verdicts that were learnt from, which
  // leaves out this one and every verdict given while learning was off: those were stored and
  // never applied, and a withdrawal is not the moment to start applying them.
  const feedback = learn ? effective : effective.filter((f) => !isThis(f) && !f.learningOff)
  /**
   * Label one sample from `record` and the feedback, unless that is the label it has. A person's label
   * that no word left gives, where the run alone gives none (a stopped run, or a direct answer's
   * example, which ran nothing), is taken off: the sample is as it was before the person said it.
   */
  const relabel = async (from, domain, sample, record, until) => {
    if (!learn && sample.outcome?.labelSource !== 'human') return
    const outcome = labelFromRun(domain, sample, record, { feedback, until })
    const was = sample.outcome
    if (!outcome) {
      if (was?.labelSource !== 'human') return
      await from.withdrawOutcome(sample.id)
    } else {
      if (was && was.labelSource === outcome.labelSource && was.label === outcome.label && was.negativeLabel === outcome.negativeLabel
        && was.chosenKey === outcome.chosenKey && was.negativeKey === outcome.negativeKey) return
      await from.resolveOutcome(sample.id, outcome)
    }
    relabelled.push(sample.id)
    changes.push({ domain, id: sample.id, outcome, store: from === training ? 'jev' : 'laya' })
  }
  // The message's intent: a direct answer's own example, which ran nothing, else the example of the
  // message that asked for the run. A verdict about the pick waits for its run, as its labels do.
  const intent = judged.intentSample ? { id: judged.intentSample, record: {} } : run?.intentSample ? { id: run.intentSample, record: run } : null
  if (intent && training) {
    const sample = await training.get(intent.id)
    if (sample?.domain === 'intent') await relabel(training, 'intent', sample, intent.record)
  }
  const store = run?.routing?.decider === 'laya' ? layaStore : training
  if (!run?.runId || !store) return done()
  // Only the samples the run itself labels (the decision record lists them). One the engine left
  // out on purpose - an off-vocabulary skill answer the run did not carry out, a judgment that
  // could not change the run - says nothing a verdict about the run could confirm or refute.
  const labels = Array.isArray(run.routing?.decision?.samples) ? new Set(run.routing.decision.samples.map((x) => x?.id)) : null
  // The next run of the session bounds which verdicts are about this one (training.js feedbackFor).
  const after = (records ?? []).filter((r) => r?.sessionId === run.sessionId && Date.parse(r.ts) > Date.parse(run.ts)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0]
  for (const domain of FEEDBACK_DOMAINS) {
    for (const sample of await store.list({ domain })) {
      if (sample.runId !== run.runId) continue
      if (labels && !labels.has(sample.id)) continue
      await relabel(store, domain, sample, run, after?.ts)
    }
  }
  return done()
}

// The verdicts about the pick that label something once their run has ended (training.js): what was
// misread, a pick named right or wrong, and a message that should have been a question.
const LABELS_AT_RUN_END = new Set(['good pick', 'wrong agent', 'misread my question', 'wrong scope', INTENT_TAGS.question])
const labelsAtRunEnd = (v) => LABELS_AT_RUN_END.has(v.tag) || (!v.tag && v.verdict === 'dislike' && !!v.suggestedAgent)

/**
 * What a saved verdict changed, as the one line the person is shown under what they judged
 * (reply-words.js learnedLine), from what onVerdict did (`applied`): the labels it gave a person's
 * word to, the agent the session's next task goes to now, how far `wrong effort` ratings of the plan's
 * agent family and task type have come, or that its labels wait for its task's run to end, or have
 * none to wait for once its task has ended with no run on record. A clear changed nothing to tell,
 * so it has no line.
 * @param {object} verdict the stored row
 * @param {{ changes?: object[], pending?: boolean }} applied onVerdict's
 * @param {object} [ctx] `learn` whether learning is on; `jobId` the reply's task; `ended` true once
 *   that task has ended, so a run its labels wait for never comes; `fresh` false when
 *   the verdict is applied after it was given (bindRun), when its suggestion may no longer be the
 *   newest; `nameOf(id)` an agent's name; `intentChecked` the intent domain's checked examples;
 *   `ratings` `{ rows, resetAt, move }`: every verdict now (feedback.js list()), the last Reset of
 *   Settings, Effort and whether ratings move Auto effort
 * @returns {string[]} the line, or none
 */
export function verdictEffects(verdict, applied, { learn = true, jobId = null, ended = false, fresh = true, nameOf = (id) => id, intentChecked = 0, ratings = null } = {}) {
  if (!verdict || verdict.verdict === CLEAR) return []
  const human = (applied?.changes ?? []).filter((c) => c.outcome?.labelSource === 'human')
  const of = (...domains) => human.filter((c) => domains.includes(c.domain))
  const picks = of('resource_selection')
  const kinds = of('task_classification', 'skill_selection')
  // A label that names the pick as wrong (a negative) relabels it; one that names it alone confirms it.
  const pick = picks.some((c) => c.outcome.negativeKey) ? 'labelled' : picks.length || kinds.some((c) => c.outcome.label != null) ? 'confirmed' : null
  const misread = kinds.some((c) => c.outcome.label == null && c.outcome.negativeLabel != null)
  const intent = of('intent')[0]
  const suggested = fresh && verdict.verdict === 'dislike' && verdict.suggestedAgent && tagVotesOnAgent(verdict.tag) ? nameOf(verdict.suggestedAgent) : null
  let effort = null
  const way = verdict.about === 'plan' && verdict.tag === 'wrong effort' && verdict.planFamily && verdict.taskType ? ratingWay(verdict) : 0
  if (way && ratings) {
    const votes = effortVotes(ratings.rows, verdict.planFamily, verdict.taskType, ratings.resetAt)
    const moved = effortBias(ratings.rows, verdict.planFamily, verdict.taskType, ratings.resetAt) === way
    effort = { family: verdict.planFamily, taskType: verdict.taskType, way, agree: way > 0 ? votes.up : votes.down, need: RATINGS_AGREE, moved, off: ratings.move === false }
  }
  // Labels that wait for the task's run, which a task that has ended with none on record never has.
  const waits = !!(applied?.pending && learn && labelsAtRunEnd(verdict))
  const pending = waits && !ended ? jobId ?? '' : null
  return [learnedLine({ suggested, pick, misread, store: human.some((c) => c.store === 'laya') ? 'laya' : 'jev', intent: intent ? { label: intent.outcome.label, checked: intentChecked } : null, effort, pending, unran: waits && ended, learning: learn })]
}

/**
 * What POST /jev-router/feedback does with a valid verdict: store it, then apply it (onVerdict).
 * The verdict itself is always stored (the routing prior reads it). Crediting it as evidence is
 * learning, so new credit waits for learning to be on; a clear or a changed verdict still takes
 * back what the earlier form counted, because a person withdrawing a verdict is not new learning.
 * Skipping onVerdict altogether with learning off left a withdrawn like counting, then and after
 * learning came back on, since nothing replays feedback.jsonl. A failure to apply it is logged
 * and never loses the stored verdict.
 *
 * A verdict about the pick is stamped first with what the plan it judged was (`planOf`, the reply
 * ledger's row of its task in its chat): the agent, effort, level, model and agent family it ran
 * with (`planAgent`, `planEffort`, `planLevel`, `planModel`, `planFamily`), the level Auto chose
 * before your ratings moved it when they did (`planUnmoved`), its task type, and its run (`runId`)
 * once it has one, server-side facts whatever the reply showed; `planOf` says too whether its task
 * has ended (`ended`), so labels waiting for a run it never had are not said to come. `explain`
 * gives what the words of what it changed need (verdictEffects).
 * @param {object} record validFeedback's row
 * @param {{ feedback: object, records: () => Promise<object[]>, agents: () => Promise<object[]>, learn: boolean, log?: (m: string) => void, planOf?: Function, explain?: Function } & object} deps
 *   `records` and `agents` are read after the append, so they are as fresh as the verdict
 * @returns {Promise<{ record: object, effects: string[] }>} the stored row, and what it changed in words
 */
export async function acceptVerdict(record, { feedback, records, agents, log = () => {}, planOf = null, explain = null, ...deps }) {
  const plan = record.about === 'plan' && planOf ? await Promise.resolve().then(() => planOf(record)).catch((err) => { log(`the plan a verdict judged was not read: ${err.message}`); return null }) : null
  const stored = await feedback.append(verdictRow(plan?.facts ? { ...record, ...plan.facts } : record, deps.learn))
  let applied = null
  try {
    applied = await onVerdict(stored, { ...deps, feedbackRows: await feedback.history(stored.sessionId), records: await records(), agents: await agents() })
  } catch (err) { log(`a verdict was stored but not credited: ${err.message}`) }
  const told = applied && explain ? await Promise.resolve().then(() => explain(stored, applied)).catch(() => ({})) : {}
  return { record: stored, effects: applied ? verdictEffects(stored, applied, { ...told, learn: deps.learn !== false, jobId: plan?.jobId ?? null, ended: plan?.ended === true }) : [] }
}

/**
 * POST /jev-router/feedback without the HTTP: the request body's text in, the status and the JSON
 * to answer with out. A body that is not JSON, or not a verdict validFeedback accepts, is a 400
 * that stores nothing, so an unknown tag is refused before it could be read as routing rights. A
 * valid one is stored and applied by acceptVerdict, one verdict at a time: the evidence is
 * recorded in the order feedback.jsonl is written, so a quick like-then-dislike cannot land the
 * other way round. apply() makes one for the plugin's life, which is what makes it one queue. A
 * store that fails throws, and the route answers that as it answers any other failure. The answer
 * carries the stored row and what it changed, in words (`effects`), and `onApplied` is told both.
 *
 * Its `bindRun(record)` applies the verdicts about the pick of the task a run was for, once that run
 * has ended (route() calls it after learnFrom has labelled the run): the newest form of each, in the
 * same queue as verdicts being given, so neither lands half way through the other. A verdict given
 * while the run went on labelled nothing then; one applied before, or the same again, relabels
 * nothing, since a label that is already so is left as it is. A verdict given before routing picked
 * anything (its task waited in its folder's line, or its reply was the guess's) was stored with no
 * plan to stamp it with: it is stamped now (`planOf`), stored again as the newest form of the same
 * verdict and dated as it was given, and applied as that; an effort rating is told how far it has come.
 *
 * Its `noRun({ taskKey, sessionId })` is for a task that has ended with no run on record (one that
 * failed before routing wrote its row, one stopped before it, a restart's): no bindRun ever comes
 * for it, so each verdict about its pick that was told its labels wait for the task to end is told
 * now, in the same queue, that there is no run to apply them to. A task with a run on record is
 * left to bindRun.
 * @param {{ learn: () => boolean, onApplied?: (record: object, effects: string[]) => unknown } & object} deps
 *   acceptVerdict's, with `learn` read as each verdict arrives, so a verdict is marked by the
 *   setting it was given under
 * @returns {((raw: string) => Promise<{ status: number, body: object }>) & { bindRun: (record: object) => Promise<object[]>, noRun: (task: { taskKey: string, sessionId: string }) => Promise<object[]> }}
 */
export function createFeedbackRoute({ learn, onApplied = () => {}, ...deps }) {
  let queue = Promise.resolve()
  const serial = (task) => { const job = queue.then(task); queue = job.catch(() => {}); return job }
  const told = async (record, effects) => { try { await onApplied(record, effects) } catch { /* the verdict stands either way */ } }
  const post = async (raw) => {
    let record
    try { record = validFeedback(JSON.parse(raw)) } catch (err) { return { status: 400, body: { error: err.message } } }
    const on = learn()
    const got = await serial(async () => {
      const out = await acceptVerdict(record, { ...deps, learn: on })
      await told(out.record, out.effects)
      return out
    })
    return { status: 200, body: { ok: true, record: got.record, effects: got.effects } }
  }
  // A verdict about the pick with no plan on it, stamped with the plan its task was routed with once
  // there is one, else as it was. What reads a verdict's plan (effort.js effortVotes, router.js
  // feedbackPrior) reads the newest form of it, which feedback.jsonl only ever gains by an append.
  // Its run is left as it was given, by its task's key: the ledger's run is its task's first pass,
  // which for a read pass handed back is no run on record, and would leave the verdict about none.
  const stampLate = async (given) => {
    if (given.planAgent || !deps.planOf) return given
    const plan = await Promise.resolve().then(() => deps.planOf(given)).catch((err) => { deps.log?.(`the plan a verdict judged was not read: ${err.message}`); return null })
    if (!plan?.facts?.planAgent) return given
    const { runId: _run, ...facts } = plan.facts
    return deps.feedback.append({ ...given, ...facts })
  }
  post.bindRun = (record) => (!record?.taskKey || !record.sessionId ? Promise.resolve([]) : serial(async () => {
    const on = learn()
    const rows = await deps.feedback.history(record.sessionId)
    // The newest form of each verdict in the chat: one changed or cleared while the run went on is
    // applied as it stands now.
    const newest = new Map()
    for (const r of rows) if (r?.messageId) newest.set(r.messageId, r)
    const out = []
    for (const given of newest.values()) {
      if (given.about !== 'plan' || given.taskKey !== record.taskKey || given.verdict === CLEAR) continue
      const stored = await stampLate(given)
      const stamped = stored !== given
      if (stamped) rows.push(stored)
      const applied = await onVerdict(stored, { ...deps, feedbackRows: rows, records: await deps.records(), agents: await deps.agents(), learn: on })
      // An effort rating stamped now says how far it has come, which it could not say as it was given.
      if (!applied.changes.length && !(stamped && stored.tag === 'wrong effort')) continue
      const words = deps.explain ? await Promise.resolve().then(() => deps.explain(stored, applied)).catch(() => ({})) : {}
      const effects = verdictEffects(stored, applied, { ...words, learn: on, fresh: false })
      await told(stored, effects)
      out.push({ record: stored, ...applied, effects })
    }
    return out
  }).catch((err) => { deps.log?.(`verdicts on a task were not applied as its run ended: ${err.message}`); return [] }))
  post.noRun = (task) => (!task?.taskKey || !task.sessionId ? Promise.resolve([]) : serial(async () => {
    const newest = new Map()
    for (const r of await deps.feedback.history(task.sessionId)) if (r?.messageId) newest.set(r.messageId, r)
    // The ones told their labels wait for the task's run: about its pick, and given with learning on.
    const waiting = [...newest.values()].filter((v) => v.about === 'plan' && v.taskKey === task.taskKey && v.verdict !== CLEAR && !v.learningOff && labelsAtRunEnd(v))
    if (!waiting.length || (await deps.records()).some((r) => r?.sessionId === task.sessionId && r.taskKey === task.taskKey)) return []
    const out = []
    for (const stored of waiting) {
      const effects = verdictEffects(stored, { changes: [], pending: true }, { ended: true, fresh: false })
      await told(stored, effects)
      out.push({ record: stored, effects })
    }
    return out
  }).catch((err) => { deps.log?.(`verdicts on a task that ended with no run were not told so: ${err.message}`); return [] }))
  return post
}

/**
 * What the router reads its priors from (runRouted's deps.history): history.jsonl and the feedback
 * log beside it. A function of its own, which apply() makes once, so the wiring the feedback prior
 * depends on - the run a verdict is about, placed with the capability registry's credit - is
 * tested without the plugin runtime.
 * @param {object} p
 * @param {string} p.historyFile  history.jsonl
 * @param {object} p.feedback     feedback.js's store for the log beside it
 * @param {object} [p.capabilities] the capability registry, whose creditedRun places a verdict
 */
export function createHistoryDeps({ historyFile, feedback, capabilities, onAppend }) {
  const dataDir = dirname(historyFile)
  // ponytail: reads the whole file; switch to a tail read if history grows past a few MB.
  const allRecords = async () => {
    const raw = await readFile(historyFile, 'utf8').catch(() => '')
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }
  return {
    async recent(cwd, n) {
      return (await allRecords()).filter((r) => r.workspace === cwd).slice(-n)
        .map((r) => ({ task_type: r.routing?.taskType, first_agent: r.routing?.primaryAgent, attempts: r.attempts?.length, outcome: r.finalStatus }))
    },
    // Full rows for trackRecord: what each agent costs, how it has done here, and whether it is
    // on its cheap rate right now. Without this the router silently skips all of that and Jev
    // picks with no cost or history prior at all.
    records: allRecords,
    // The same priors path as history.jsonl, one file over: the router reads it to demote an
    // agent whose picks were disliked and promote one whose picks were liked. The rows are
    // list()'s, dated by their newest form, which is the order the router's window reads them
    // in; a row whose answer was first judged earlier also carries that time as `judgedAt`
    // (effectiveVerdicts), which is what places it on a run below.
    async feedback(sessionId) {
      const [rows, forms] = await Promise.all([feedback.list(sessionId), feedback.history(sessionId)])
      const key = (f) => `${f.sessionId}\u0000${f.messageId}`
      const judged = new Map(effectiveVerdicts(forms).map((f) => [key(f), f.ts]))
      return rows.map((r) => { const at = judged.get(key(r)); return at && at !== r.ts ? { ...r, judgedAt: at } : r })
    },
    // The run a verdict is about, which the router's feedback prior reads the task type off: the
    // same run its capability evidence is credited to, so both read a verdict as one answer.
    // Placed, as the evidence is, by when the answer was first judged: dated by its latest edit,
    // a verdict with no runId that was never credited (learning off, a tag that credits
    // nothing) and was edited after a newer run ended was read as being about that newer run.
    runOfVerdict: (verdict, records) => runOfVerdict(verdict?.judgedAt ? { ...verdict, ts: verdict.judgedAt } : verdict, records, capabilities),
    async append(record) {
      await mkdir(dataDir, { recursive: true })
      await appendFile(historyFile, `${JSON.stringify(record)}\n`)
      // Told once the row is on disk, so whatever counts runs as they end counts only real rows.
      try { onAppend?.(record) } catch { /* the row is written; a listener's failure is its own */ }
    },
  }
}

// The routing domains whose labels a person's verdict can change (training.js labelClassification,
// and labelResourceSelection for a verdict about the pick). The message's intent, which a verdict
// can change too, is found by its example's id, not by the run (onVerdict).
const FEEDBACK_DOMAINS = ['task_classification', 'skill_selection', 'resource_selection']

/**
 * Run a configured tool in the workspace; its output is the attempt's answer.
 * The task text goes to stdin only, never into the environment or the command
 * line: cmd.exe expands %VAR% before parsing & | ", so free text there is
 * command injection. JEV_ARG_* values are safe: they are option keys from config.
 */
function runTool(cwd, timeoutMs) {
  return async (tool, args, task, signal) => {
    const env = { ...process.env, ...Object.fromEntries(Object.entries(args).map(([k, v]) => [`JEV_ARG_${k.toUpperCase()}`, v])) }
    const r = await run(tool.command, [], { cwd, shell: true, env, input: task, timeoutMs, signal })
    return {
      stopReason: r.code === 0 ? 'completed' : 'error',
      diagnostic: r.code === 0 ? undefined : `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}: ${r.output.slice(-500)}`,
      answerText: r.output.slice(-8000),
    }
  }
}

/**
 * Which resource ids the ranking routing domains have already seen, so a new one can narrow them
 * (domains.js `new_resource`). The set lives in `file`, because an in-memory set seeded on the
 * first call of a process swallowed exactly the ordinary case: add a provider to config, restart,
 * and the new id is part of the seed, so nothing ever fired.
 *
 * Without the file (first start, or an install from before it existed) the set is rebuilt from
 * what is on disk: the ids the stored ranking samples show were candidates, and every agent id
 * history.jsonl names (the ones that ran, were picked, were out of allowance, near it or gated,
 * and every candidate and exclusion in the run's decision record). That is every agent the
 * decision engine ever saw. The one agent still unseen is one router.js removed before the engine
 * was asked (a routing-policy exclusion) or that was never routed at all; such an agent is
 * announced once on that first start, and narrows the ranking domains once. Empty there too
 * means nothing was ever routed, so nothing has matured that a new resource could invalidate,
 * and the current agents are simply recorded.
 * @param {{ file: string, store?: { list: Function }, records?: () => Promise<object[]>, domains?: { noteEnvironmentChange: Function } | null }} p
 */
export function createResourceTracker({ file, store, records, domains }) {
  let known = null
  let queue = Promise.resolve()
  // Once the plugin closes or is applied again (dispose), the set is saved no more: the plugin that
  // replaces this one has read the file and saves its own, which this set would be written over. A
  // note asked before still saves, and closing waits for it.
  let disposed = false
  const rankingDomains = Object.entries(DOMAINS).filter(([, d]) => d.kind === 'ranking').map(([id]) => id)
  const seed = async () => {
    try {
      const ids = JSON.parse(await readFile(file, 'utf8'))
      if (Array.isArray(ids)) return new Set(ids.filter((x) => typeof x === 'string'))
    } catch { /* no file yet, or a damaged one: rebuild from the samples */ }
    const ids = new Set()
    const add = (id) => { if (typeof id === 'string' && id) ids.add(id) }
    for (const domain of rankingDomains) {
      for (const row of (await store?.list?.({ domain }).catch(() => [])) ?? []) {
        for (const c of row?.input?.candidates ?? []) add(c?.id)
      }
    }
    // Only when the samples show routing happened: with none, nothing has matured to protect.
    if (ids.size) {
      for (const r of (await records?.().catch(() => [])) ?? []) {
        add(r?.routing?.primaryAgent)
        for (const a of Array.isArray(r?.attempts) ? r.attempts : []) add(a?.agent)
        for (const id of Array.isArray(r?.gated) ? r.gated : []) add(id)
        for (const o of Array.isArray(r?.availability?.out) ? r.availability.out : []) add(o?.id)
        for (const id of Array.isArray(r?.availability?.near) ? r.availability.near : []) add(id)
        // The decision record names every agent the engine saw: the candidates, and the ones it
        // ruled out (disabled, too small a context window, under the floor, gated, conserved).
        for (const c of Array.isArray(r?.routing?.decision?.candidates) ? r.routing.decision.candidates : []) add(c?.id)
        for (const e of Array.isArray(r?.routing?.decision?.excluded) ? r.routing.decision.excluded : []) add(e?.id)
      }
    }
    return ids
  }
  const save = async () => {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify([...known].sort()))
    await rename(tmp, file)
  }
  return {
    /** Record `agents`; returns the ids that were new to an existing set (and were announced). */
    note(agents) {
      const saves = !disposed
      const next = queue.then(async () => {
        if (!domains) return []
        const first = known === null
        if (first) known = await seed()
        const ids = (agents ?? []).map((a) => a?.id).filter((id) => typeof id === 'string')
        const fresh = ids.filter((id) => !known.has(id))
        const seeded = known.size > 0
        for (const id of fresh) known.add(id)
        if (saves && (fresh.length || first)) await save()
        if (!seeded || !fresh.length) return []
        domains.noteEnvironmentChange({ kind: 'new_resource', detail: fresh.join(', ') })
        return fresh
      })
      // One at a time, so two runs starting together cannot both announce the same id.
      queue = next.catch(() => {})
      return next
    },
    /** The plugin is closing or applied again: resolves once the saves asked for so far have landed, and saves none after. */
    dispose() {
      disposed = true
      return queue
    },
  }
}

/** How long closing waits for the plugin's writes still under way (closeWithin). */
const CLOSE_WAIT_MS = 5000

/**
 * Resolves once every promise in `work` has settled, or after `ms`, logging how many had not. The
 * engine applies the plugin again only once its closing has resolved (cordis awaits a cleanup's
 * promise), so a write that never ends must not hold that, or KzH quitting, for good. Never rejects;
 * a null in `work` counts as settled.
 * @param {Array<Promise<unknown>|null|undefined>} work
 * @param {{ ms?: number, log?: (m: string) => void }} [o]
 */
export async function closeWithin(work, { ms = CLOSE_WAIT_MS, log = () => {} } = {}) {
  const list = work.filter(Boolean)
  let left = list.length
  const all = Promise.allSettled(list.map((p) => Promise.resolve(p).finally(() => { left-- })))
  // Held, not unref'd: the bound is how long closing may wait, and it goes the moment all is settled.
  let timer
  const bound = new Promise((r) => { timer = setTimeout(r, ms, false) })
  const settled = await Promise.race([all.then(() => true), bound])
  clearTimeout(timer)
  if (!settled) log(`${left} of ${list.length} still under way after ${ms / 1000} s; closing without waiting for ${left === 1 ? 'it' : 'them'}`)
}

/** How often a spawn child's committed session events are read for the live view (followSpawn). */
const LIVE_PUMP_MS = 400

/**
 * Follow a spawn child's own work into its attempt's live handle (live.js), beside the run and never
 * in its way: the agent-scoped `agent/assistant-stream` and `agent/inbox/claimed` listeners, which
 * hear only this child (dsh-agent runtime-types.d.ts), and a pump over its session's committed events
 * every `pumpMs`, unref'd, its first read from seq 0 so what came before the follow began is read
 * too. A listener that cannot be registered leaves the pump alone to give the detail. `drain()`,
 * called before the child is disposed of, reads the session one last time, ends the handle and lets
 * go of the listeners. For a child with no local agent (Claude Code, Codex, a remote run) there is
 * nothing to follow, and `drain()` only ends the handle: its agent is done, and the run moves on.
 * `onHeard(id)` hears the id of each message the child took in, claimed from its inbox or committed
 * as a `user/message`, so a Steer sent to it is known read (steer.js); never in the child's way either.
 */
export function followSpawn(sub, handle, { pumpMs = LIVE_PUMP_MS, onHeard = () => {} } = {}) {
  const agent = sub?.localAgent
  if (!agent) return { drain({ stopReason = null } = {}) { handle.end({ stopReason }) } }
  const offs = []
  const listen = (name, fn) => {
    try {
      const off = agent.ctx.on(name, (payload) => { try { fn(payload) } catch { /* the live view's own */ } })
      if (typeof off === 'function') offs.push(off)
    } catch { /* the pump still reads what was committed */ }
  }
  const heard = (id) => { try { onHeard(id) } catch { /* the steer's own */ } }
  listen('agent/assistant-stream', (p) => handle.frame(p?.frame))
  listen('agent/inbox/claimed', (p) => { handle.claimed(p?.message?.id); heard(p?.message?.id) })
  let cursor = 0
  const pump = () => {
    let events
    try { events = agent.session.snapshotEvents(cursor) } catch { return }
    if (!events?.length) return
    const last = events[events.length - 1]?.seq
    cursor = Number.isInteger(last) ? last + 1 : cursor + events.length
    handle.events(events)
    for (const id of heardInEvents(events)) heard(id)
  }
  pump()
  const timer = setInterval(pump, pumpMs)
  timer.unref?.()
  let drained = false
  return {
    drain({ stopReason = null } = {}) {
      if (drained) return
      drained = true
      clearInterval(timer)
      pump()
      handle.end({ stopReason })
      for (const off of offs) { try { off() } catch { /* the agent's context unwinds it on disposal anyway */ } }
    },
  }
}

/**
 * @param {object} ctx     the plugin context
 * @param {object} config  Config, as the host validated it
 * @param {{ laya?: object, local?: object, localModels?: object, benchmark?: { scratchRoot?: string, tasksDir?: string }, replies?: { graceMs?: number }, live?: { pumpMs?: number, store?: object } }} [seams]  for tests only; the host passes none.
 *   `laya.harnessDir` is the folder Laya's engine, model and pins (config/laya.json) live under
 *   (the harness by default), and the rest of `laya` (`spawn`, `run`, `fetch`, `timing`,
 *   `isAlive`, `killTree`, `readWorkingSet`) goes to Laya's supervisor as it is, so a test can run
 *   a fake laya.serve on a PC of its own. `local` stands in for methods of the local models
 *   (`chatModel`), so a test can have a local chat model without llama.cpp. `localModels` goes to
 *   createLocalModels as it is (`modules`, `engineDir`, `modelsDir`, `spawn`, `fetch`, `specs`, `port`),
 *   so a test can run a fake llama-server with models of its own instead of the harness's.
 *   `benchmark` places the capability benchmark's scratch workspace and task set elsewhere
 *   (docs/benchmark.md 3.7), so a test runs it in a folder of its own over tasks of its choosing.
 *   `replies.graceMs` is how long after the start reply's wait a reply that never said what it named
 *   is taken to have named nothing (5 s), so a test of a stopped reply need not wait seconds for it.
 *   `live.pumpMs` is how often a spawn child's session is read for the live view (400 ms), and
 *   `live.store` the live store itself (live.js createLiveStore over `<dataDir>/live`), so a test can
 *   hold it: let a run go as forty others would, or hold a read of a saved transcript.
 *   `handover` is the registry the work still going as the plugin closes is handed over through
 *   (handover.js, the process's one by default), so a test's plugins on one data folder are a plugin
 *   applied again when they share one, and a restart of the app when they do not.
 */
export function apply(ctx, config, { laya: layaSeams = {}, local: localSeams = {}, localModels: localModelSeams = {}, benchmark: benchmarkSeams = {}, replies: replySeams = {}, live: liveSeams = {}, handover: handoverSeam = null } = {}) {
  // A spawn agent without a pinned model inherits the parent's model, which is Jev itself.
  const unpinned = config.agents.filter((a) => a.provider === 'spawn' && !(a.llm?.provider && a.llm?.model))
  if (unpinned.length) throw new Error(`jev-router: spawn agents need llm: { provider, model }: ${unpinned.map((a) => a.id).join(', ')}`)
  if (config.auxModel.provider === JEV_PROVIDER) throw new Error('jev-router: auxModel must be a real model, not Jev')
  const dataDir = dirname(config.historyFile)
  // Policy first: every threshold the router reasons with, config over the defaults. A broken
  // priors file is fatal on purpose, and found before anything starts: routing on a half-read set
  // of capability numbers would be worse than not starting.
  const policy = resolvePolicy(config.routing ?? {})
  const priorsFile = join(harnessDir, policy.priorsFile ?? 'config/capability-priors.json')
  let priors = { families: {}, models: {} }
  try { priors = loadPriors(priorsFile) } catch (err) {
    if (config.routing?.enabled !== false) throw new Error(`jev-router: capability priors not loaded from ${priorsFile}: ${err.message}`)
  }

  // --- Laya, the decision model on this PC ----------------------------------
  // Both deciders' records (providers.js), built once: a run reads every cut-off from the record
  // of the provider that answers it. A bad Jev value throws here, as a bad Jev threshold always
  // has; a bad Laya value only takes Laya out (layaError), and Jev Auto runs on.
  const providers = resolveProviders(config, { policy })
  const layaLog = (m) => process.stdout.write(`[jev] ${m}\n`)
  const layaError = providers.layaError
  const { harnessDir: layaHarness = harnessDir, ...supervisor } = layaSeams
  // Laya's pins are a harness file, not the laya block: when they cannot be read, Laya can be
  // neither installed nor asked, and what puts them back is the harness's update, never an edit of
  // cordis.patch.yml, so the failure is kept apart from layaError and says so.
  let pins = null
  let pinsError = null
  try { pins = readPins(layaHarness) } catch (err) { pinsError = err.message }
  // Laya's record only while nothing is wrong with its settings: a run Laya cannot be asked for is
  // refused, and never decided under Jev's record instead (2.4).
  const LAYA = layaError ? null : providers.laya
  const layaSettings = LAYA ? providers.layaSettings : null
  if (layaError) layaLog(`laya: ${layaError}; Laya Auto and the Laya shadow are off until it is fixed`)
  if (pinsError) layaLog(`laya: ${pinsUnreadable(pinsError)}; Laya Auto and the Laya shadow are off until then`)
  // One RAM budget for every local model process, llama and Laya together (7.7).
  const residency = createResidency({ log: (m) => layaLog(`local: ${m}`) })
  let layaClient = null
  const sidecar = createLayaSidecar({
    // Unreadable pins reach the supervisor as its one reason Laya cannot be asked whatever its
    // state, so nothing starts it; the refusals and the status name them apart (layaUnavailable).
    harnessDir: layaHarness, dataDir, config: layaSettings ?? {}, configError: layaError ?? (pinsError && pinsUnreadable(pinsError)), pins: pins ?? {},
    specs: () => specs(), residency,
    // The budget llama's planner reads, read the same way (7.4).
    readBudget: () => local.readSettings(),
    probe: (conn) => createProbe(conn, { temperatureCorrections: layaSettings?.temperatureCorrections, minTopMargin: layaSettings?.minTopMargin }),
    isLocalBusy: () => local.isBusy(),
    isBusy: () => layaClient?.busy() ?? false,
    log: layaLog,
    // The model menu offers Laya Auto by Laya's state, so every change of it refreshes the menu (3.1).
    onChange: () => { try { llmRuntime?.emit?.('llm/adapters-updated') } catch {} },
    ...supervisor,
  })
  const installer = pins ? createLayaInstaller({ harnessDir: layaHarness, dataDir, pins, specs: () => specs(), sidecar, log: layaLog }) : null
  // Before anything else: finish or roll back an install an engine kill interrupted (7.2), then
  // stop a laya.serve an earlier session left holding memory and a port while the card says
  // stopped (7.5). Every start waits for both.
  const layaStartup = Promise.resolve(installer?.recover())
    .catch((err) => layaLog(`laya install: nothing recovered: ${err.message}`))
    .then(() => sidecar.sweepOrphans())
    .catch((err) => layaLog(`laya: the orphan sweep failed: ${err.message}`))
  // Nothing starts Laya once the plugin is disposed, however long the startup above took: a
  // laya.serve started on a disposed supervisor has no exit hook and nobody to stop it, and that
  // supervisor would even restart it after a crash, the orphan the sweep is there for. Nor does any
  // background pass that writes the data folder start (inBackground, below): closing waits for the
  // ones under way, and one started after could land behind the plugin that replaces this one.
  let disposed = false
  const afterStartup = async () => {
    await layaStartup
    if (disposed) throw new LayaUnavailable('Laya was stopped with KzH', { reason: 'disposed' })
  }
  const layaReady = async (o) => { await afterStartup(); return sidecar.ensureReady(o) }
  // colibri's Laya beside laya.serve (docs/laya-auto.md 13): while the card's colibri Laya address
  // is set, each request laya.serve answers for a Laya Auto run or the shadow is asked of it too,
  // after laya.serve and in the background, and both answers go to colibri-laya.jsonl only. It
  // decides nothing and teaches nothing; KzH runs nothing of colibri.
  const colibri = createColibriLaya({
    file: join(dataDir, 'colibri-laya.jsonl'),
    address: () => sidecar.readSettings().colibriUrl ?? '',
    isLocalBusy: () => local.isBusy(),
    log: layaLog,
  })
  // An address saved on an earlier day is checked once now, so the card says whether colibri answers.
  colibri.check().catch(() => {})
  layaClient = createLayaClient({
    sidecar: { ...sidecar, ensureReady: layaReady },
    settings: layaSettings,
    isLocalBusy: () => local.isBusy(),
    log: layaLog,
    onAnswered: (answered) => colibri.offer(answered),
  })
  // Laya can be asked at all: installed, switched on, its settings valid and its pins read. Whether
  // a run may be decided by it is layaUnavailable's, below, which says why not.
  const layaAskable = () => !!LAYA && !pinsError && layaSettings.enabled !== false && !!sidecar.installed()
  // The shadow of Jev Auto (5): on while Laya can be asked, learning is on (off, nothing new is
  // recorded, the comparisons included) and the card's switch is on. It never starts Laya and
  // never keeps it loaded: the Laya client skips a call while Laya is not ready, and counts why.
  const shadowOn = () => layaAskable() && config.routing?.learn !== false && sidecar.readSettings().shadow !== false
  const shadow = createShadow({
    file: join(dataDir, 'laya-shadow.jsonl'),
    laya: layaClient,
    enabled: shadowOn,
    log: layaLog,
    providers: { jev: providers.jev, laya: LAYA },
    // A row also goes to the inspector's log of its run, whose id is the run id (5.3); one that
    // lands after the run has left memory is on disk only.
    onRow: (row) => { logEntry(row.runId)?.events.push({ type: 'shadow', at: Date.now(), row }) },
    files: {
      jevSamples: join(dataDir, 'routing-samples.jsonl'), layaSamples: join(dataDir, 'laya-samples.jsonl'),
      feedback: join(dataDir, 'feedback.jsonl'), history: config.historyFile, standing: join(dataDir, 'laya-standing.jsonl'),
    },
  })
  // Closing stops Laya and its client, which settles every shadow job, queued or on the wire, and
  // waits until laya.json and the row of each call Jev has answered are on disk and laya.serve has
  // exited. A request to colibri on its way is abandoned with its socket, and nothing of it is written.
  ctx.effect(() => () => {
    disposed = true
    layaClient.dispose()
    return closeWithin([sidecar.dispose(), shadow.dispose(), colibri.dispose()], { log: (m) => layaLog(`laya: ${m}`) })
  })

  // Like/Dislike on a finished answer, next to history.jsonl, read back by the router below.
  const feedback = createFeedback({ file: join(dataDir, 'feedback.jsonl') })

  // --- the adaptive router ------------------------------------------------
  // The capability registry (what each resource is good at, priors plus recorded evidence), the
  // training store (every decision and what the run proved), the routing domains (who may decide
  // what, and what they must prove first) and the decision engine that puts them together.
  const capabilities = createCapabilityRegistry({ file: join(dataDir, 'capability-evidence.jsonl'), priors, policy })
  try { capabilities.load() } catch (err) { process.stdout.write(`[jev] capability evidence not loaded: ${err.message}\n`) }
  // What the router reads its priors from: history.jsonl, the feedback log beside it, and the run
  // each verdict is about, placed with this registry's credit (createHistoryDeps).
  // What the waiting line's estimates are drawn from (waits.js): the history, read once at start and
  // then added to as each run appends its row, never read on the task list's once-a-second poll.
  // Until the first read lands the levels are simply short, and no estimate is given.
  const waitStatsNow = createWaitStats()
  const history = createHistoryDeps({ historyFile: config.historyFile, feedback, capabilities, onAppend: (record) => waitStatsNow.add(record) })
  const allRecords = history.records
  allRecords().then((rows) => waitStatsNow.load(rows), () => {})
  const training = createTrainingStore({ file: join(dataDir, 'routing-samples.jsonl'), policy, log: (m) => process.stdout.write(`[jev] ${m}\n`) })
  // Every decision of a run Laya decided goes to a store of its own (docs/laya-auto.md 6.1): no
  // local classifier reads it, and the Jev store refuses a Laya row, so Laya Auto's failures can
  // never roll back a ladder Jev taught. The same cap and compaction as Jev's.
  const layaStore = createTrainingStore({ file: join(dataDir, 'laya-samples.jsonl'), kind: 'laya', policy, log: (m) => process.stdout.write(`[jev] ${m}\n`) })
  const storeOf = (kind) => (kind === 'laya' ? layaStore : training)
  const domains = config.routing?.learn === false ? null : createDomainRegistry({
    policy,
    store: training,
    artifactsDir: join(dataDir, 'classifiers'),
    stateDir: join(dataDir, 'domains'),
    log: (m) => process.stdout.write(`[jev] ${m}\n`),
  })
  domains?.load()
  // Each message on a Jev row records its intent sample in Jev's store before it is answered
  // (intent.js), and the store's first use reads and parses the whole file, a second or more on a
  // well-used PC: it is read now, in the background, so the first question after a start does not
  // wait for it. Only where the intent domain is used, with adaptive routing and its learning on.
  if (domains && config.routing?.enabled !== false) training.load().catch((err) => process.stdout.write(`[jev] routing samples not read at start: ${err.message}\n`))
  const decisions = createDecisionEngine({ policy, domains, profiles: capabilities, priors, store: training, economics: config.resources?.economics ?? {}, log: (m) => process.stdout.write(`[jev] ${m}\n`) })
  // Which agent ids the routing domains have already seen. A new one narrows the domains that
  // rank resources, and nothing else: adding a coding model must not reset a mature task
  // classifier. Persisted, because the ordinary way to add one is to edit config and restart.
  const resourceTracker = createResourceTracker({ file: join(dataDir, 'known-resources.json'), store: training, records: allRecords, domains })
  const noteResources = (agents) => resourceTracker.note(agents).catch((err) => process.stdout.write(`[jev] known resources not updated: ${err.message}\n`))
  // The reply ledger (reply-ledger.js): what each start reply said and what the router then ran, with
  // a predictor of the pick that learns from the two in a worker thread, whose guess a start reply
  // names only once the decider's record has earned it (guessFor). With learning off nothing is
  // recorded in it, as in every other learning record, so no reply names a guess, and nothing is
  // trained from what it holds (`learns`), though the card still reads it.
  const ledgerOn = () => config.routing?.learn !== false
  const ledger = createReplyLedger({ file: join(dataDir, 'reply-ledger.jsonl'), modelFile: join(dataDir, 'reply-model.json'), gates: replyGates(config.replies), learns: ledgerOn, log: (m) => process.stdout.write(`[jev] ${m}\n`) })
  const ledgerFailed = (err) => process.stdout.write(`[jev] reply ledger not updated: ${err?.message ?? err}\n`)
  ctx.effect(() => () => closeWithin([ledger.dispose()], { log: (m) => process.stdout.write(`[jev] reply ledger: ${m}\n`) }))

  // The live view of each run (live.js, docs/live-agent-view.md Feature 1): the router's milestones and
  // each spawn child's own stream, in memory for the Live tab, the card under a start reply, the work
  // board and the Tasks tab, and each task's transcript in `live/<key>.jsonl` once a run of it ends,
  // none once the plugin has closed (below). Memory only besides that, and never in tasks.jsonl,
  // which each event would rewrite.
  // The plugin that closed on this data folder just before this one, as the engine applied it again,
  // left what it had going here (handover.js, docs/handoff.md "Decided by the owner, 9 Oct"): its runs
  // go on in its closures, so its memory-only registries (this live store, the steer registry, the
  // lanes, its task follows and the agents whose read-only lock did not hold) are this plugin's from
  // now on, and what those runs write to them is seen, steered and waited for here. They are taken
  // with its tasks as the task list is made, and the tasks adopted as it loads (createTasks takeOver).
  const place = (handoverSeam ?? processHandover()).join(dataDir)
  const inherited = place.kept ?? {}
  const live = liveSeams.store ?? inherited.live ?? createLiveStore({ dir: join(dataDir, 'live'), log: (m) => process.stdout.write(`[jev] ${m}\n`) })
  // The live store the plugin before this one disposed of saves and deletes again: it is this one's now.
  if (live === inherited.live) live.reopen()
  // Whether the engine patch (scripts/patch-agent-live.mjs) is in the Claude Code and Codex connectors
  // this PC runs, and if not why (engine-patches.js), read at most once a minute: a run is handed the
  // patch's fields only when its connector carries it. The Live tab, the work board and Settings, Jev
  // setup, Live agent view say the same (GET /jev-router/engine-patches).
  const patchCache = new Map()
  const enginePatches = () => patchState({ dshHome, cache: patchCache })
  // Steer on a running task (docs/live-agent-view.md Feature 5): the attempts at work that take the
  // person's words now, one per run (steer.js), and each run of a task with its task's key and its own
  // onEvent (`say`), so what becomes of a piece of guidance is said on the run it was sent to, in its
  // live view and its log, and noted on its task (tasks.js noteSteer). Memory only, let go as each ends.
  const steerers = inherited.steerers ?? createSteerers()
  const steerRuns = inherited.steerRuns ?? new Map() // runId -> { key, say, names }
  // The person's words whole, by the id of a piece the task's record keeps clipped (tasks.js
  // noteSteer), for the prompts its runs build after them. Memory only, let go as the task settles.
  const steerTexts = inherited.steerTexts ?? new Map() // steer id -> words
  /** A task's guidance as the prompts of its runs carry it: each piece in the person's words, whole. */
  const guidanceOf = (key) => (tasks.byKey(key)?.steers ?? []).map((s) => (steerTexts.has(s?.id) ? { ...s, text: steerTexts.get(s.id) } : s))
  // Why the live detail of an agent's own work is off: a Claude Code or Codex connector the engine patch
  // is not in says why it is not, and an agent run out of process has no stream this side can read.
  const liveOffWhy = (provider) => { const key = patchKeyOf(provider); return key ? enginePatches()[key].why ?? 'the engine patch is not in its connector' : 'it runs out of process, with no stream KzH can read' }

  /**
   * What a finished run taught: capability evidence per resource, and the label each routing
   * decision of that run turned out to deserve. Capability evidence is append-only, and the
   * routing samples are appended and compacted under their cap (training.js); neither can block
   * the run, which has already finished by the time this is called.
   */
  async function learnFrom(record, samples) {
    // Learning off means nothing new is recorded: capability evidence changes future routing just
    // as a trained domain does, so recording it would keep the router learning by another door.
    if (!record || config.routing?.learn === false) return
    try {
      const agents = await enabledAgents()
      // No feedback here: a verdict is credited when it is given (creditVerdict, POST /feedback).
      const rows = runEvidence(record, { versionOf, agents, priors })
      if (rows.length) capabilities.recordMany(rows)
    } catch (err) { process.stdout.write(`[jev] capability evidence not recorded: ${err.message}\n`) }
    if (!domains) return
    // The review's own decision is a routing decision too, and its sample id comes back on the
    // assessment rather than from the decision engine. Without this the outcome domain would
    // collect samples for ever and never see one of them verified, so it could never mature.
    // Each sample is labelled in the store it was written to: the decision engine names the
    // store of each of its own, and the review's is in the store of whoever decided the run (6.3).
    const reviewStore = record.routing?.decider === 'laya' ? 'laya' : 'jev'
    const all = [
      ...(samples ?? []),
      ...(record.assessments ?? []).map((a) => a.outcomeDomain?.sampleId).filter(Boolean).map((id) => ({ domain: 'outcome_disposition', id, store: reviewStore })),
      // The intent of the message that asked for the run (intent.js), which only Jev Auto records, in
      // Jev's store: what the run did says whether it was a task or a question (training.js labelIntent).
      ...(record.intentSample ? [{ domain: 'intent', id: record.intentSample, store: 'jev' }] : []),
    ]
    if (!all.length) return
    try {
      // No feedback here either: at the moment a run ends no verdict about its answer can exist.
      // A verdict relabels this run's samples when it is given (onVerdict), by their runId.
      for (const { domain, id, store } of all) {
        const from = storeOf(store)
        const sample = await from.get(id)
        if (!sample || sample.domain !== domain) continue
        const outcome = labelFromRun(domain, sample, record)
        if (outcome) await from.resolveOutcome(id, outcome)
      }
    } catch (err) { process.stdout.write(`[jev] routing outcomes not recorded: ${err.message}\n`) }
  }

  // What the plugin writes to its data folder in the background, with nothing waiting for it: what a
  // finished run taught, the evaluation pass, Laya's standing, the usage row of a decider call or of
  // a direct answer, the reply ledger's rows, a task's live transcript and the first read of the
  // accounts. Closing waits for each one under way, so none lands after it; a transcript a run still
  // going asks for once the plugin has closed is not saved at all (live.js dispose).
  const background = new Set()
  const inBackground = (p) => {
    const done = Promise.resolve(p).then(() => {}, () => {})
    background.add(done)
    done.then(() => background.delete(done))
    return p
  }

  // Retraining is a background pass, not part of a run: a routing decision never waits for it.
  let retraining = null
  let lastRetrain = 0
  const maybeRetrain = () => {
    if (disposed || !domains || retraining || Date.now() - lastRetrain < 60_000) return
    lastRetrain = Date.now()
    retraining = inBackground(domains.evaluateAll().catch((err) => process.stdout.write(`[jev] routing evaluation failed: ${err.message}\n`)).finally(() => { retraining = null }))
  }
  // Laya's own evaluation pass (6.7): at most once a minute after any run, its standing is worked
  // out in the shadow's worker and appended to laya-standing.jsonl, outside domains/, so no file
  // the Jev ladders own changes on Laya's account. A reading only: nothing acts on it.
  let standing = null
  let lastStanding = 0
  const maybeStanding = () => {
    if (disposed || !layaAskable() || config.routing?.learn === false || standing || Date.now() - lastStanding < 60_000) return
    lastStanding = Date.now()
    standing = inBackground(shadow.recordStanding().catch((err) => process.stdout.write(`[jev] laya standing not recorded: ${err.message}\n`)).finally(() => { standing = null }))
  }

  // Setup-page state, layered over config: on/off switches and user-added
  // API-key (BYOK) agents. At least one LLM agent always stays on.
  const setupFile = join(dataDir, 'agents.json')
  const readSetup = async () => {
    let raw
    try { raw = await readFile(setupFile, 'utf8') } catch (err) { if (err.code === 'ENOENT') return { disabled: [], custom: [] }; throw err }
    // A damaged file must not read as empty: the next save would erase every added agent.
    const s = JSON.parse(raw)
    return { disabled: s.disabled ?? [], custom: s.custom ?? [] }
  }
  // All read-modify-write of the setup file goes through one queue, so quick toggles never overwrite each other.
  let setupQueue = Promise.resolve()
  const mutateSetup = (fn) => {
    const next = setupQueue.then(async () => saveSetup(await fn(await readSetup())))
    setupQueue = next.catch(() => {})
    return next
  }
  const customAgent = (c) => ({
    id: c.id,
    provider: 'spawn',
    description: c.description,
    enabled: true,
    custom: true,
    llm: { provider: c.provider, model: c.model },
    persona: 'You are a careful senior software engineer working as a delegated coding agent. Complete the task in the given workspace and report concisely.',
  })
  // Local agents: one per installed model module (config/local-models.json), refreshed when a module changes.
  let localAgents = []
  const allAgents = (s) => [...config.agents, ...localAgents, ...s.custom.map(customAgent)]
  const enabledAgents = async () => {
    const s = await readSetup()
    return allAgents(s).map((a) => ({ ...a, kind: kindOf(a), peer: a.peer ?? PEERS[a.id], enabled: a.enabled && !s.disabled.includes(a.id) }))
  }
  async function saveSetup(s) {
    if (!allAgents(s).some((a) => a.enabled && !s.disabled.includes(a.id))) throw new Error('at least one LLM agent must stay on')
    await mkdir(dataDir, { recursive: true })
    const tmp = `${setupFile}.tmp`
    await writeFile(tmp, JSON.stringify(s, null, 2))
    await rename(tmp, setupFile)
    readyGen++
    readyCache = null
    // Which agents are on can change the aux fallback; refresh it now.
    resolveAux()
  }

  // Login status per agent, cached so routing does not shell out on every message.
  // A check that started before a newer one (or before a setup change) never overwrites it.
  let readyCache = null
  let readyGen = 0
  let readyPending = null
  const READY_MS = 5 * 60_000
  const resolveCredential = (ref) => ctx.credentials.resolve(ref)
  async function readiness(force = false) {
    if (force) { readyGen++; readyPending = null }
    else if (readyCache && Date.now() - readyCache.at < READY_MS) return readyCache.value
    if (!readyPending) {
      const gen = readyGen
      readyPending = readSetup().then(async (s) => {
        const list = allAgents(s)
        const value = await checkAgents(list.filter((a) => kindOf(a) !== 'local'), resolveCredential)
        // Local agents: ready when their model file and the engine are present; no login, no quota.
        for (const a of list.filter((x) => kindOf(x) === 'local')) value[a.id] = await local.readiness(a.llm.model)
        return value
      }).then((value) => {
        if (gen === readyGen) readyCache = { at: Date.now(), value }
        return value
      }).finally(() => { if (gen === readyGen) readyPending = null })
    }
    return readyPending
  }
  /**
   * Which agents are ready by the last reading, for the reply ledger's guess (noteQueued), which a
   * start reply may wait for: the reading at hand however old, a new one begun in the background once
   * it is older than routing keeps one, since a new one asks each agent's tool and can take seconds.
   * Only with no reading at hand, the first after a start, a sign-in or a change in Jev setup, does the
   * guess wait for one.
   */
  async function readinessAtHand() {
    if (!readyCache) return readiness()
    if (Date.now() - readyCache.at >= READY_MS) readiness().catch(() => {})
    return readyCache.value
  }

  // Accounts (keys, limits, logins) and usage (quota, state, usage.jsonl).
  const accounts = createAccounts({
    dataDir,
    envFile: join(dshHome, '.env'),
    credentials: ctx.credentials,
    jevCredentialRef: config.credentialRef,
    codexAccount: () => usage.codexAccount(),
  })
  // Key rows are scored against the floors of every switched-on agent drawing on them, whichever
  // agents a reading is for (a balance check after one agent's attempt, the benchmark's spend).
  const usage = createUsage({ dataDir, accounts, floorAgents: () => enabledAgents(), jevKeyInUse: () => jevStoredKeyInUse() })

  // Local models (llama-server on 127.0.0.1), installed module by module from config/local-models.json.
  let modules = []
  try { modules = readManifest(join(harnessDir, 'config', 'local-models.json')) } catch (err) { process.stdout.write(`[jev] local: manifest not loaded: ${err.message}\n`) }
  let specsCache = null
  const specs = () => {
    if (!specsCache || Date.now() - specsCache.at > 10 * 60_000) specsCache = { at: Date.now(), value: detectSpecs({ dir: join(harnessDir, 'models') }) }
    return specsCache.value
  }
  let llmRuntime = null
  let refreshing = null
  let localLoaded = false
  const refreshLocal = () => (refreshing ??= local.agents(LOCAL_PERSONA).then(async (list) => {
    // A model installed while KzH runs gets its agent switched on, even if it was switched off before a removal.
    // The first load at startup keeps the person's on/off choices.
    const added = localLoaded ? list.filter((a) => !localAgents.some((x) => x.id === a.id)).map((a) => a.id) : []
    localAgents = list
    localLoaded = true
    if (added.length && (await readSetup()).disabled.some((id) => added.includes(id))) {
      await mutateSetup((s) => ({ ...s, disabled: s.disabled.filter((id) => !added.includes(id)) })).catch(() => {})
    }
    readyGen++; readyCache = null
    try { llmRuntime?.emit?.('llm/adapters-updated') } catch {}
  }).catch(() => {}).finally(() => { refreshing = null }))
  // The capability benchmark (docs/benchmark.md 3), made once everything it reads exists, below.
  let benchmark = null
  const localModels = createLocalModels({
    modules,
    engineDir: join(harnessDir, 'engine', 'llama'),
    modelsDir: join(harnessDir, 'models'),
    settingsFile: join(dataDir, 'local.json'),
    // Every speed run's summary and its detail log (docs/benchmark.md 2.13), beside local.json,
    // where Speed-Run.bat writes its runs too.
    speedLogDir: join(dataDir, 'speed-runs'),
    // How much of a speed run's output baseline a later run must repeat to be the same (docs/benchmark.md 2.15).
    outputShare: config.local.outputCheckShare,
    // llama-server's own lines and KzH's on each start, rotated at 5 MB with one older file kept,
    // its key taken out; GET /jev-router/local/log serves the tail.
    serverLog: join(dataDir, 'llama-server.log'),
    port: config.local.port,
    contextSize: config.local.contextSize,
    // How long a local agent's attempt waits for another model before its own goes next (the owner, 9 Oct).
    modelWaitCapMinutes: config.local.modelWaitCapMinutes,
    specs,
    log: (t) => process.stdout.write(`[jev] ${t}\n`),
    onChange: () => { refreshLocal(); resolveAux() },
    // The resource budget reaches what follows it: readiness, since a local model over the budget is
    // not ready, the lanes' cap on tasks at once, the chat model, which is the quickest local model
    // the budget lets load, and the local agents' context windows, which the budget sizes. `lanes`
    // is declared further down; this runs only on a saved settings change, and no request can make
    // one before apply() has returned.
    onSettings: (s) => { readyGen++; readyCache = null; lanes.setMax(s.maxConcurrentTasks); resolveAux(); refreshLocal() },
    // The residency Laya is in too, so one RAM budget covers both and an unheld Laya gives its
    // memory up when a local model starts (7.7).
    residency,
    // Laya answering a call refuses a speed benchmark, and has a measured request run again
    // (docs/benchmark.md 2.3, 2.7): it would slow the measurement.
    layaBusy: () => layaClient?.busy() ?? false,
    // So does a capability benchmark with a local agent's task left: the two would unload each
    // other's model (docs/benchmark.md 2.7). `benchmark` is made further down, before any request.
    capabilityBusy: () => benchmark?.localPending() ?? false,
    ...localModelSeams,
  })
  // Every local model process on this PC in one status: llama's, and Laya's beside it while Laya is
  // installed, which the resource budget table counts with llama's (7.7).
  const local = { ...localModels, ...localSeams, status: async () => ({ ...(await localModels.status()), laya: sidecar.installed() ? await layaStatus() : null }) }
  ctx.effect(() => () => { local.dispose() })
  refreshLocal()
  // Start Laya with KzH when the card says so (7.6): after the startup sweep, in the background,
  // never awaited and never holding up anything else.
  layaStartup.then(() => { if (!disposed) sidecar.warm({ atStartup: true }) })
  // Hugging Face download counts: a tie-breaker for suggestions only, cached a day, skipped offline.
  let hfCache = { at: 0, value: {} }
  const hfDownloads = async () => {
    if (Date.now() - hfCache.at < 86_400_000 || !(await connectivity.online())) return hfCache.value
    hfCache = { at: Date.now(), value: hfCache.value }
    const repos = [...new Set(modules.map((m) => m.hfRepo).filter(Boolean))]
    const got = await Promise.all(repos.map((r) => fetch(`https://huggingface.co/api/models/${r}`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json()).then((j) => [r, j.downloads ?? 0], () => null)))
    hfCache.value = Object.fromEntries(got.filter(Boolean))
    return hfCache.value
  }
  const catalog = async () => buildCatalog(local, await specs(), { downloads: await hfDownloads().catch(() => ({})) })
  const connectivity = createConnectivity()
  // Laya needs no network, so a Laya Auto session asks laya.connectivityUrl whether cloud agents
  // can run, never a TypeSafe host: not to route, not to pick the chat model, not for a title (2.4).
  const layaConnectivity = createConnectivity({ urls: [(layaSettings ?? LAYA_SCHEMA({})).connectivityUrl] })
  const isOffline = async (decider = 'jev') => !(await (decider === 'laya' ? layaConnectivity : connectivity).online())
  const localChat = async () => { const id = await local.chatModel(); return id ? { provider: LOCAL_PROVIDER, model: id } : null }
  // Titles, compaction and direct answers need one real chat model, and none is assumed:
  // a hidden DeepSeek default sent that housekeeping to api.deepseek.com for everyone. An
  // unpinned auxModel follows this machine instead, local chat model first, then the first
  // enabled agent that pins a provider and model. The object is live; the adapter holds this
  // reference and reads it per call, so a model installed later is picked up without a
  // restart. An empty pair means neither was found: the request fails and its caller falls
  // through, never to a DeepSeek call nobody asked for.
  let auxResolved = { provider: '', model: '' }
  const auxPinned = () => (config.auxModel.provider && config.auxModel.model ? { provider: config.auxModel.provider, model: config.auxModel.model } : null)
  const resolveAux = async () => {
    const pinned = auxPinned()
    if (pinned) { auxResolved = pinned; return }
    const local = await localChat().catch(() => null)
    if (local) { auxResolved = local; return }
    const first = (await enabledAgents().catch(() => [])).find((a) => a.enabled && a.llm?.provider && a.llm?.model)
    auxResolved = first ? { provider: first.llm.provider, model: first.llm.model } : { provider: '', model: '' }
  }
  const auxModel = {
    get provider() { return auxResolved.provider },
    get model() { return auxResolved.model },
  }
  // The chat models a direct answer may use: the aux model when one resolved, then the
  // installed local chat model. Only complete pairs are offered, because the capability
  // registry refuses an executor with an empty name.
  const chatPair = async () => {
    const local = await localChat().catch(() => null)
    const aux = auxResolved.provider && auxResolved.model ? { provider: auxResolved.provider, model: auxResolved.model } : null
    const same = !!aux && !!local && aux.provider === local.provider && aux.model === local.model
    return [aux, same ? null : local].filter(Boolean)
  }
  resolveAux()
  // The first read registers the keys the engine already uses, in accounts.json.
  inBackground(accounts.ready().catch((err) => process.stdout.write(`[jev] accounts not loaded: ${err.message}
`)))

  // Quota for routing: never waits long; an unanswered fetch leaves the agent 'unknown', which does not block.
  async function quotaFor(agents) {
    await accounts.clearExpired().catch(() => {})
    const snap = await Promise.race([
      usage.snapshot(agents).catch(() => null),
      new Promise((r) => setTimeout(r, 4000, null)),
    ]) ?? usage.last()?.out ?? {}
    // weeklyPercent is what the subscription-first policy rations; it was computed
    // upstream and thrown away here, which is why that policy was unimplementable.
    return Object.fromEntries(Object.entries(snap).map(([id, q]) => [id, {
      state: q.state, until: q.until, kind: q.kind, weeklyPercent: longWindowPercent(q.windows), summary: summaryOf(q),
    }]))
  }

  // The outcome domain, for the review service: while it is immature Jev judges every result and
  // teaches it; once it has earned authority the review is decided here without a Jev call.
  const outcomeDomain = () => (config.routing?.enabled === false ? null : domains?.get('outcome_disposition') ?? null)
  // The intent domain, for sorting a message under Jev Auto (intent.js): none with adaptive routing
  // off, when Jev is asked as it always was, or with learning off, so nothing is recorded.
  const intentDomain = () => (config.routing?.enabled === false ? null : domains?.get('intent') ?? null)

  // The outcome domain of a run Laya decides, behind a facade that decides for Laya into Laya's
  // store (6.3), so jev-review stays ignorant of stores.
  const layaOutcomeDomain = () => {
    const outcome = outcomeDomain()
    return outcome ? { decide: (args) => outcome.decide({ ...args, answeredBy: 'laya', sink: layaStore }) } : null
  }

  // What Laya Auto says when routing is off: Laya decides only through the adaptive router (3.5).
  const ROUTING_OFF = 'Laya Auto needs adaptive routing (routing.enabled in the jev-router configuration). Nothing was run.'
  /**
   * Whether Laya can be asked at all, the one place that decides it (docs/laya-auto.md 2.4, 3.5):
   * throws LayaUnavailable with the reply the person reads, in this order, when Laya is not
   * installed, is switched off, has invalid settings, its pins cannot be read, when routing is off
   * (a run only, `role` 'act'; the intent of a message is still Laya's to answer), or when it
   * stopped after an error. A run it refuses is never handed to Jev.
   * @param {'act'|'intent'} [role]
   */
  function layaUnavailable(role = 'act') {
    const refuse = (message, reason, detail = null) => { throw new LayaUnavailable(message, { reason, detail }) }
    if (!sidecar.installed()) refuse(LAYA_TEXT.notInstalled, 'not_installed')
    if ((layaSettings ?? config.laya)?.enabled === false) refuse(LAYA_TEXT.disabled, 'disabled')
    if (!LAYA) refuse(LAYA_TEXT.invalid(layaError), 'invalid', layaError)
    if (pinsError) refuse(`Laya Auto did not run this: ${pinsUnreadable(pinsError)}. Nothing was run.`, 'pins', pinsError)
    if (role === 'act' && config.routing?.enabled === false) refuse(ROUTING_OFF, 'routing_off')
    const s = sidecar.status()
    if (s.state === 'failed') refuse(LAYA_TEXT.failed(s.why ?? 'unknown'), 'failed', s.why ?? null)
  }

  const tokensOf = (t) => ({ input: t.usage?.input_tokens ?? 0, output: t.usage?.output_tokens ?? 0 })
  /**
   * The client of whoever decides (docs/laya-auto.md 2.4), in createJev's shape with its record on
   * `provider`. Every answered call is logged through usage.logDecision, priced by that record;
   * a failed one goes to `onError` only and is never a usage row.
   *
   * Jev: a client on the active jev key; on 429/402 it moves to the next jev key and retries the
   * call once. Every call is offered to the shadow, which decides per call whether Laya answers it
   * too, so a rotated call's first settle gets the 429 or 402 and its job is withdrawn. Null
   * without a key.
   *
   * Laya: refused by layaUnavailable first; then the Laya client, which waits for a start and
   * holds its own gate, with no accounts, no rotation and no shadow.
   * @param {'jev'|'laya'} id
   * @param {{ onTrace?: Function, onError?: Function, runId?: string|null, emit?: Function, onWait?: (line: string) => void, role?: 'act'|'intent' }} [o]
   */
  async function makeDecider(id, { onTrace = () => {}, onError = () => {}, runId = null, emit = () => {}, onWait, role = 'act' } = {}) {
    if (id === 'laya') {
      layaUnavailable(role)
      return createJev({
        provider: LAYA,
        client: layaClient.client('act', { runId, onWait }),
        onTrace: (t) => {
          onTrace(t)
          inBackground(usage.logDecision({ provider: LAYA, runId, phase: t.phase, ms: t.ms, model: t.model, tokens: tokensOf(t) }).catch(() => {}))
        },
        onError,
      })
    }
    if (id !== 'jev') throw new Error(`jev-router: no decider named ${id}`)
    await accounts.ready().catch(() => {})
    let name = accounts.activeKey('jev')
    let value = name ? await accounts.resolveKey('jev', name) : undefined
    if (!value) { name = 'default'; value = (await resolveCredential(config.credentialRef).catch(() => undefined))?.value }
    if (!value) return null
    const onCall = shadow.offerer({ runId: runId === 'intent' ? null : runId })
    const build = () => createJev({
      provider: providers.jev,
      apiKey: value,
      onTrace: (t) => {
        onTrace(t)
        // model and request id together: the two things a TypeSafe support query needs.
        inBackground(usage.logDecision({ provider: providers.jev, runId, account: name, phase: t.phase, ms: t.ms, model: t.model, requestId: t.requestId, tokens: tokensOf(t) }).catch(() => {}))
      },
      onError,
      onCall,
    })
    let client = build()
    const call = (method) => async (...args) => {
      try { return await client[method](...args) } catch (err) {
        if (err?.status !== 429 && err?.status !== 402) throw err
        const until = new Date(Date.now() + (err.status === 402 ? 24 : 1) * 3600_000).toISOString()
        await accounts.markExhausted(`jev:${name}`, { until, reason: `HTTP ${err.status}` })
        const next = accounts.nextKey('jev')
        if (!next) throw err
        await accounts.activate('jev', next)
        const nextValue = await accounts.resolveKey('jev', next)
        if (!nextValue) throw err
        emit({ type: 'limit', at: Date.now(), agent: 'jev', until, action: 'rotated' })
        name = next; value = nextValue; client = build()
        return await client[method](...args)
      }
    }
    return { provider: providers.jev, route: call('route'), assess: call('assess'), intent: call('intent') }
  }

  /**
   * Task or question? Questions are answered directly by a chat model instead of running agents in
   * the workspace. `mode` is the picked row's; 'offline' keeps this on the local heuristic.
   * `decider` is who answers it: the result carries that provider's `thresholds`, so the adapter's
   * bars are the answering provider's, and a `depth` answered too flat to use is left out, so the
   * caller keeps the cheap default.
   *
   * Jev: through the intent domain (intent.js), which records the message as a sample, with Jev's
   * answer as the teacher's, and lets a local classifier that has earned a rung say it is a task with
   * no Jev call; the answer carries the sample's id as `intentSample`. It lets it only where a task
   * can run (`cwd`, the folder the message was sent in): in No project and the scratch workspace a
   * task is refused, so a question it took for one would go unanswered, and Jev reads every message
   * there, as before there was a domain. Without Jev (no key, error) everything is a task, as before.
   * `modalities` says whether a picture came with the words.
   * Laya (docs/laya-auto.md 3.4): never probes TypeSafe. A message waits for Laya to start, with
   * the Starting Laya line through `onWait`, bounded as a routing call is, and is then asked; only a
   * refusal, a failed start or a timeout makes it a task, marked `unsure` with the reason, because
   * unsure means task and a word rule would send work to a chat model that cannot touch files.
   * Neither Laya nor offline mode records an intent sample: Laya is no teacher, and offline nobody is.
   * @param {string} message
   * @param {string} mode
   * @param {'jev'|'laya'} [decider]
   * @param {{ onWait?: (line: string) => void, signal?: AbortSignal, modalities?: string[], cwd?: string }} [o]
   */
  async function classify(message, mode, decider = 'jev', { onWait, signal, modalities, cwd } = {}) {
    const answered = (r, thresholds) => ({ ...r, depth: r.uninformative?.includes('depth') ? undefined : r.depth, thresholds })
    if (decider === 'laya') {
      const thresholds = LAYA?.thresholds
      const unsure = (why) => ({ kind: 'task', unsure: true, why: `Laya could not sort this message (${why}); treating it as a task.`, thresholds })
      let laya
      try { laya = await makeDecider('laya', { runId: 'intent', onWait, role: 'intent' }) } catch (err) { return unsure(layaReason(err)) }
      try { return answered(await laya.intent({ message }, signal), thresholds) } catch (err) {
        if (signal?.aborted) throw err
        return unsure(err?.message ?? String(err))
      }
    }
    const thresholds = providers.jev.thresholds
    // Offline mode is a choice, not a network state: it must not call out even with the internet up.
    if (mode === 'offline' || await isOffline('jev')) return { kind: looksLikeQuestion(message) ? 'question' : 'task', offline: true, thresholds }
    const jev = await makeDecider('jev', { runId: 'intent' }).catch(() => null)
    if (!jev) return { kind: 'task', thresholds }
    return answered(await classifyIntent({ domain: intentDomain(), message, modalities, localMayDecide: tasksRunIn(cwd), ask: () => jev.intent({ message }, AbortSignal.timeout(config.jevTimeoutMs)) }), thresholds)
  }

  // The model each agent runs, for the "Answered by" line. Claude and Codex use their own settings
  // unless the executor pins one; read at most once a minute.
  let modelCache = { at: 0, claude: null, codex: null }
  function refreshModels() {
    if (Date.now() - modelCache.at < 60_000) return
    modelCache.at = Date.now()
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const codexDir = process.env.CODEX_HOME || join(homedir(), '.codex')
    readFile(join(claudeDir, 'settings.json'), 'utf8').then((t) => { modelCache.claude = JSON.parse(t).model ?? null }).catch(() => {})
    readFile(join(codexDir, 'config.toml'), 'utf8').then((t) => { modelCache.codex = t.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null }).catch(() => {})
  }
  function modelOf(agentDef) {
    if (!agentDef) return undefined
    if (agentDef.llm?.model) return agentDef.llm.model
    refreshModels()
    if (agentDef.provider === 'claude-code') return modelCache.claude ?? undefined
    if (agentDef.provider === 'codex') return modelCache.codex ?? undefined
    return undefined
  }
  refreshModels()
  // The one versionOf every profile reader and writer gets (localVersionOf).
  const versionOf = localVersionOf(local)
  /**
   * What the plan a verdict about the pick judged was (acceptVerdict): from the reply ledger's row of
   * its task, when that row is of the verdict's chat, the agent, effort, level and model the router ran
   * the task with at its first routing, the level Auto chose before your ratings moved it when they did
   * (`planUnmoved`), the agent's family, its task type and its run; and the task's job id and whether
   * it has ended (out of the list, or in a final state), for the words. With learning off the ledger
   * keeps no row, and nothing is stamped.
   */
  async function planOfVerdict(v) {
    const t = tasks.byKey(v.taskKey)
    const jobId = t?.sessionId === v.sessionId ? t.jobId : null
    const ended = !t || TERMINAL_STATES.includes(t.state)
    const row = await ledger.row(v.taskKey)
    if (!row || row.sessionId !== v.sessionId) return { jobId, ended, facts: null }
    const ran = row.ran ?? {}
    const agentDef = ran.agent ? (await enabledAgents()).find((a) => a.id === ran.agent) : null
    const facts = { planAgent: ran.agent, planEffort: ran.effort, planLevel: ran.level, planUnmoved: ran.unmoved, planModel: ran.model, planFamily: effortFamily(agentDef), taskType: ran.taskType, runId: ran.runId }
    return { jobId: jobId ?? row.jobId ?? null, ended, facts: Object.fromEntries(Object.entries(facts).filter(([, x]) => typeof x === 'string' && x)) }
  }
  /** What the words of what a verdict changed need (verdictEffects): the agents' names, the intent domain's checked examples, and your ratings of effort. */
  async function explainVerdict(_v, applied) {
    const names = await agentNamesNow()
    const settings = await readEffort()
    const intentChanged = applied?.changes?.some((c) => c.domain === 'intent')
    return {
      nameOf: (id) => names[id] ?? id,
      intentChecked: intentChanged ? (await training.list({ domain: 'intent', verifiedOnly: true })).length : 0,
      ratings: { rows: await feedback.list(), resetAt: settings.ratingsResetAt ?? null, move: settings.ratingsMove !== false },
    }
  }
  /**
   * A verdict about the pick, and what it changed, kept on its reply's row in the reply ledger, for the
   * How Jev replies card: a clear keeps none. A clear carries only its keys, so its task is the one the
   * message's verdict before it named. Only a row of the verdict's chat that exists is noted, which
   * with learning off none does.
   */
  async function noteRated(v, effects) {
    if (!v || !ledgerOn()) return
    const rated = v.verdict === CLEAR ? (await feedback.history(v.sessionId)).filter((r) => r?.messageId === v.messageId && r.verdict !== CLEAR).at(-1) : v
    if (rated?.about !== 'plan' || !rated.taskKey) return
    const row = await ledger.row(rated.taskKey)
    if (!row || row.sessionId !== v.sessionId) return
    await ledger.note(rated.taskKey, { verdict: v.verdict === CLEAR ? null : { verdict: v.verdict, tag: v.tag ?? null, at: v.ts, learned: effects?.[0] ?? null } })
  }
  // What POST /jev-router/feedback does (createFeedbackRoute), made once so every verdict the
  // plugin is given goes through its one queue, and every verdict about a pick is applied there as
  // its task's run ends (bindRun), or told there is none to apply it to as its task ends with no run
  // on record (noRun).
  const postFeedback = createFeedbackRoute({
    feedback, records: allRecords, capabilities, training, layaStore, versionOf, agents: enabledAgents, priors,
    learn: () => config.routing?.learn !== false,
    log: (m) => process.stdout.write(`[jev] ${m}\n`),
    planOf: planOfVerdict,
    explain: explainVerdict,
    onApplied: noteRated,
  })
  // The verdicts about a task's pick are applied as its run ends by the plugin that holds the task
  // then: one applied again after this one closed, which took the task over and was given the
  // verdicts since, when there is one (handover.js), else this one.
  const bindRunNow = (record) => (place.heir()?.bindRun ?? postFeedback.bindRun)(record)
  /**
   * What a run that ended taught, learned by this plugin: the capability evidence and the labels its
   * routing decisions earned (learnFrom), then the verdicts about its task's pick, applied over them
   * (bindRun), then an evaluation pass, only Laya's own for a run Laya decided (2.4, 6.7). Never on the
   * run's critical path, and never fatal.
   */
  const learnFromRun = (result, samples, { byLaya = false } = {}) => inBackground(learnFrom(result, samples).then(() => postFeedback.bindRun(result)).then(() => {
    if (!byLaya) maybeRetrain()
    maybeStanding()
  }).catch(() => {}))
  // Learned by the plugin that holds the run's task as it ends: one applied again after this one
  // closed learns it in the stores it reads and evaluates, where a row this one appended to its own,
  // closed, would be missing from them until a restart, and lost once they rewrite their files.
  const learnFromRunNow = (result, samples, how) => (place.heir()?.learnFromRun ?? learnFromRun)(result, samples, how)

  const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString()
  const keyOut = (provider, name) => ['stopped', 'exhausted'].includes(usage.last()?.keys?.[provider]?.find((k) => k.name === name)?.state)
  // Latest reset among the fullest windows: when a subscription agent is usable again.
  const resetOf = (id) => {
    const w = usage.last()?.out?.[id]?.windows ?? []
    const top = Math.max(...w.map((x) => x.usedPercent))
    return w.filter((x) => x.usedPercent === top).map((x) => x.resetsAt).filter(Boolean).sort().at(-1) ?? null
  }

  // A limit. One the balance check after an attempt found (`floor`: the agent's own Stop below, or a
  // mark already made) is the agent's own reading, which the next snapshot shows again: nothing is
  // marked. A real limit error spends the stored key the call went out on (`key`, the one in use as
  // the router started the call; null when it used none), which holds out every agent whose calls
  // go out on it, and makes the next usable key active in its place, once: a limit on a key another
  // limit already switched away from switches nothing more. That switch reaches agent calls only
  // after a restart (accounts.launchKeyName), so no agent goes on with a new key within the run.
  // An agent whose calls use no stored key is marked itself, until its reset.
  async function onLimit(a, { until, reason, key, floor = false } = {}) {
    if (!a || floor) return { rotated: false }
    const provider = kindOf(a) === 'api' ? keyProviderOf(a) : null
    const spent = provider ? (key === undefined ? accounts.launchKeyName(provider) : key) : null
    let keyHeld = false
    if (spent) {
      // Switched from only when the key marked is the active one: not another added under its name.
      const marked = await accounts.markKeyExhausted(provider, spent, { until: until ?? hoursFromNow(6), reason })
      keyHeld = marked || !!accounts.launchKeyGone(provider)?.spent
      if (marked && accounts.activeKey(provider) === spent) {
        const next = accounts.nextKey(provider, (n) => keyOut(provider, n))
        if (next) await accounts.activate(provider, next).catch(() => {})
      }
    }
    // A key's own mark holds the agent out while its calls go out on that key, and no longer:
    // after a restart onto another key it is usable at once.
    if (!keyHeld) await accounts.markExhausted(a.id, { until: until ?? (kindOf(a) === 'subscription' ? resetOf(a.id) : null) ?? hoursFromNow(1), reason })
    return { rotated: false }
  }

  // The stored Jev key Jev's calls go out on, as makeDecider resolves one per call: the active one
  // while its value is there, else null (Jev falls back to its credential, or has none).
  const jevStoredKeyInUse = async () => {
    await accounts.ready().catch(() => {})
    const name = accounts.activeKey('jev')
    return name && (await accounts.resolveKey('jev', name).catch(() => undefined)) ? name : null
  }

  // Before routing: an active key already known to be spent gives way to the next usable one.
  async function rotateSpentKeys(agents) {
    for (const p of new Set(agents.filter((a) => a.enabled).map(keyProviderOf).filter(Boolean))) {
      const active = accounts.activeKey(p)
      const next = active && keyOut(p, active) ? accounts.nextKey(p, (n) => keyOut(p, n)) : null
      if (next) await accounts.activate(p, next).catch(() => {})
    }
  }

  // Switch exactly these agents on and the rest off (the /use command and POST /agents/only).
  async function useOnly(ids) {
    await mutateSetup((s) => ({ ...s, disabled: allAgents(s).map((a) => a.id).filter((id) => !ids.includes(id)) }))
    return ids
  }
  const switchable = async () => allAgents(await readSetup()).filter((a) => a.enabled).map((a) => a.id)

  // Router decision log per session, for the Jev inspector. Memory only; history.jsonl is the durable record.
  const logs = new Map() // sessionId -> runs [{ id, startedAt, task, events, jobId?, taskKey? }], most recently used last
  // The entry's id is the run's id (docs/laya-auto.md 2.4), so the live run, Stop, the task
  // record, usage.jsonl, history.jsonl, the samples and the shadow's rows all name one run alike.
  // A pass of a background task names the task too (`of`: its job id and its key).
  function logRun(sessionId, task, runId = randomUUID(), of = null) {
    const runs = logs.get(sessionId) ?? []
    const entry = { id: runId, startedAt: Date.now(), task, events: [], ...(of?.jobId ? { jobId: of.jobId, taskKey: of.taskKey ?? null } : {}) }
    runs.push(entry)
    if (runs.length > 20) runs.shift()
    logs.delete(sessionId)
    logs.set(sessionId, runs)
    if (logs.size > 50) logs.delete(logs.keys().next().value)
    return entry
  }
  /** The inspector's entry of one run, while it is still in memory. */
  const logEntry = (runId) => {
    if (!runId) return null
    for (const runs of logs.values()) { const entry = runs.find((r) => r.id === runId); if (entry) return entry }
    return null
  }
  const stoppers = new Map() // run id -> AbortController, while the run is active (POST /runs/stop)
  // Setting the process-wide effort variables and starting the Claude Code or Codex agent that reads
  // them, one start at a time (runAgent).
  const envStarts = createMutex()

  // The token counts of an agent's usage as usage.jsonl keeps them, whatever names its provider gives them.
  const usageTokens = (u) => (u ? { input: u.inputTokens ?? u.input ?? 0, output: u.outputTokens ?? u.output ?? 0, cacheRead: u.cacheReadTokens ?? u.cacheRead ?? 0, reasoning: u.reasoningTokens ?? u.reasoning ?? 0 } : null)

  /**
   * Everything runRouted() needs around it to run agents for the chat whose root agent is `agent`,
   * in `cwd` (docs/benchmark.md 3.8): the enabled agents, the key rotation, the quota, `execute`
   * with its subagent start, readiness, the executor registry, `modelOf`, the limit handling,
   * `checkBalance` and `logAttempt`. route() and the capability benchmark both build their runs on
   * it, so the two cannot drift apart. Resolves to { agents, byId, ready, deps }.
   *
   * `purpose` and `benchmarkRunId`, when given, go on every usage.jsonl row the run writes, so the
   * benchmark's real usage is kept and marked. `onExecuted`, when given, hears of each attempt
   * `execute` ran once it is over: whether the attempt's own time limit ended it (not a stop of the
   * run, `signal`), whether its subagent's dispose() failed, its tokens, the version of the model it
   * ran on when one is known (a local model's weights), and for a local agent the engine's load and
   * unload counters before and after. route() gives neither.
   * @param {{ agent: object, cwd: string, sessionId: string, runId: string, signal: AbortSignal, onEvent: (e: object) => void, purpose?: string|null, benchmarkRunId?: string|null, onExecuted?: ((report: object) => void)|null }} p
   */
  async function runDepsFor({ agent, cwd, sessionId, runId, signal, onEvent, purpose = null, benchmarkRunId = null, onExecuted = null }) {
    const onWait = (text) => onEvent({ type: 'loading', at: Date.now(), text })
    const agents = await enabledAgents()
    await rotateSpentKeys(agents)
    const quota = await quotaFor(agents)
    const byId = new Map(agents.map((a) => [a.id, a]))
    // The account a call goes out on: a subscription's login, the stored key an api agent's calls
    // go out on (accounts.launchKeyName; still so once removed), else its own credential.
    const accountOf = (a) => (kindOf(a) === 'subscription' ? usage.last()?.out?.[a.id]?.account?.email ?? null : accounts.launchKeyName(keyProviderOf(a)) ?? a.credentialRef ?? null)

    // A local agent's attempt is counted while it runs, so a speed benchmark is refused meanwhile,
    // and while one goes it waits before its subagent starts, with a line that says so
    // (docs/benchmark.md 2.6): the two would otherwise take turns unloading each other's model.
    // It holds its model until it ends, so another local agent's attempt on another model waits for
    // it in the same way, its line naming the task that holds the model (local.js). Each wait is
    // `untimed`: the attempt's time limit stands still while it lasts, so a long benchmark or
    // another task's work never runs the task out of time before it has begun.
    const execute = async (agentDef, prompt, agentSignal, options = {}) => {
      const localAgent = kindOf(agentDef) === 'local'
      const report = onExecuted ? { agent: agentDef.id, timedOut: false, disposeError: null, tokens: null, ...(localAgent ? { engine: { before: local.engineCounters(), after: null } } : {}) } : null
      let reached = false
      try {
        return await (localAgent
          ? local.localAgentAttempt(() => { reached = true; return runAgent(agentDef, prompt, agentSignal, options, report) }, { signal: agentSignal, onWait, untimed: options.untimed, model: agentDef.llm?.model ?? null, who: holderOf(runId) })
          : runAgent(agentDef, prompt, agentSignal, options, report))
      } catch (err) {
        // A locked agent stopped while it still waited for its turn on this PC never started.
        if (options.locked && localAgent && !reached && !signal.aborted) throw Object.assign(new Error(`stopped before ${agentDef.id} started: ${err?.message ?? err}`), { notStarted: true })
        throw err
      } finally {
        if (report) {
          report.timedOut = timedOutBy(agentSignal, signal)
          if (report.engine) report.engine.after = local.engineCounters()
          try { onExecuted(report) } catch { /* the caller's */ }
        }
      }
    }
    const runAgent = async (agentDef, prompt, agentSignal, { effort: eff, speed, locked = false, images = false, onStarted, onEnded, attempt: attemptIndex = null, role = null } = {}, report = null) => {
      // A read pass starts the agent locked against writing, or not at all (capabilities.js lockOf):
      // Claude Code through its plan-mode provider row, a spawn agent with only the read tools its
      // parent sees. The lock is read again here, at the start itself, so one that stopped holding
      // since the router looked (a lock breach, a provider gone) is never started unlocked.
      const lock = locked ? lockFor(agentDef, agent, { images }) : null
      if (lock && !lock.lock) throw Object.assign(new Error(lock.why), { code: LOCK_UNAVAILABLE })
      // Claude Code and Codex executors take no per-run options: they read these from process.env
      // when the run starts (Claude: SDK child env, read as its start() builds the query, and its fast
      // mode read by the engine patch as the start begins, scripts/patch-agent-live.mjs; Codex:
      // patched turn/start, see README). The variables are process-wide, and a read pass now starts
      // beside a writer as a matter of course, so setting them and starting the agent is one step
      // at a time (envStarts): two starts at once would otherwise swap their efforts.
      const envBound = agentDef.provider === 'claude-code' || agentDef.provider === 'codex'
      const setEffortEnv = () => {
        if (agentDef.provider === 'claude-code') { setEnv('CLAUDE_CODE_EFFORT_LEVEL', eff); setEnv('KZ_CLAUDE_FAST_MODE', claudeFastMode(speed)) }
        if (agentDef.provider === 'codex') { setEnv('KZ_CODEX_EFFORT', eff); setEnv('KZ_CODEX_SERVICE_TIER', codexServiceTier(speed)) }
      }
      // A local run names the weights it ran on, so its history record keeps that version
      // however late it is read back (a verdict an hour on, a backfill), never the one
      // installed by then; profiles.js does not ask versionOf about a past run. It is read as the
      // attempt starts and reported at once, so an attempt that rejects (on its time limit, say),
      // whose result the router builds without it, still says which weights it ran on
      // (docs/benchmark.md 3.9).
      const version = versionOf(agentDef, agentDef.llm?.model ?? null)
      if (report && version) report.modelVersion = version
      // In-process children see global tools; hide the router so an agent never re-routes its own
      // task. A locked child's allow list hides it too, with everything else that is not reading.
      const toolFilter = lock?.lock?.toolFilter ?? (agentDef.provider === 'spawn' && config.registerTool ? { deny: ['jev_route'] } : null)
      // The attempt's own handle in the live view, so a parallel opinion never mixes with it.
      const handle = live.attempt(runId, attemptIndex)
      // Claude Code and Codex tell what their run does only through the engine patch: its fields go on
      // the start only when the connector carries it (engine-patches.js), since one without it would
      // not know them, and only for a run the live view follows. The tap feeds the attempt's handle, and
      // says which of the person's words a Codex turn took in; the control's hooks are for steering:
      // Codex's `steer` and `sendNow` take them mid-run (Steer, Send now), and so do Claude Code's
      // through an input channel, which a task's work attempt is started with only while Settings'
      // "Let Steer reach a running Claude Code" is on. Each says what became of words it took
      // (`onOutcome`): Claude Code's read or not said, Codex's Send now gone on with.
      const provider = lock?.lock?.provider ?? agentDef.provider
      const patchKey = patchKeyOf(provider)
      const tap = live.tapFor(handle)
      const steerable = steerableRole(role) && steerRuns.has(runId)
      if (patchKey === 'claude-code') await liveSettingsRead
      const channel = patchKey === 'claude-code' && steerable && liveSettings.claudeSteer === true
      const kzh = patchKey && live.has(runId) && enginePatches()[patchKey].on
        ? { kzhTap: (frame) => { tap(frame); steerHeard(runId, heardInTap(frame)) }, kzhControl: { ...(channel ? { channel: true } : {}), onOutcome: (id, outcome) => steerOutcome(runId, id, outcome) } }
        : null
      let sub
      const start = () => ctx.subagents.start(provider, {
        label: `jev:${agentDef.id}`,
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal: agentSignal,
        ...(agentDef.persona ? { persona: agentDef.persona } : {}),
        ...(toolFilter ? { toolFilter } : {}),
        // Pin the model: a spawn child otherwise inherits the parent's (Jev) model and routes back into Jev.
        ...(agentDef.llm?.provider && agentDef.llm?.model ? { agentOptions: { provider: agentDef.llm.provider, model: agentDef.llm.model, ...(eff ? { reasoningEffort: eff } : {}) } } : {}),
        ...(kzh ?? {}),
      })
      try {
        sub = await (envBound ? envStarts(() => {
          // Read once more at the start itself: a lock breach recorded while this start waited its
          // turn is seen before anything starts.
          if (locked) { const now = lockFor(agentDef, agent, { images }); if (!now.lock) throw Object.assign(new Error(now.why), { code: LOCK_UNAVAILABLE }) }
          setEffortEnv()
          return start()
        }, agentSignal) : start())
      } catch (err) {
        if (lock && !agentSignal?.aborted) throw Object.assign(new Error(`could not start ${agentDef.id} locked: ${err?.message ?? err}`), { code: LOCK_UNAVAILABLE })
        // Stopped before its child existed, by its own time limit or a primary that failed beside
        // it rather than the run's Stop: it never ran, so it is never said to have run locked.
        if (lock && !signal.aborted) throw Object.assign(new Error(`stopped before ${agentDef.id} started: ${err?.message ?? err}`), { notStarted: true })
        throw err
      }
      // A child's own tools are outside the allow list (dsh-tools view()), so what a locked child can
      // really call is read once it exists; anything beyond reading, or a view that cannot be read,
      // and it is stopped before it works.
      if (lock?.lock?.toolFilter) {
        let seen = null
        try { seen = sub.localAgent && typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas(sub.localAgent).map((t) => t.name) : null } catch { seen = null }
        const beyond = seen ? seen.filter((n) => !lock.lock.toolFilter.allow.includes(n)) : null
        if (!seen || beyond.length) {
          await sub.dispose().catch(() => {})
          throw Object.assign(new Error(seen ? `its child could still see ${beyond.join(', ')}` : 'what its child can see could not be read'), { code: LOCK_UNAVAILABLE })
        }
      }
      // Started locked: the router's lock check covers it whatever this attempt comes to, a Stop included.
      if (lock) { try { onStarted?.() } catch { /* the router's */ } }
      // Claude Code thinking: Summarized (Settings, Jev setup, Live agent view) asks a patched run to
      // share its thinking as summaries (the SDK's setMaxThinkingTokens(null, 'summarized'), which
      // keeps how much it thinks); As Claude Code shows it asks nothing.
      if (kzh && patchKey === 'claude-code' && liveSettings.claudeThinking === 'summarized') askThinking(kzh.kzhControl, 'summarized', agentDef.id)
      // What the agent does as it does it, for the live view, beside the run and never in its way: a
      // spawn child's own stream and session (followSpawn), a patched connector's taps, or, for an
      // agent this build cannot read, why its detail is off, and for Claude Code and Codex where
      // Settings says so.
      const heard = !!sub.localAgent || !!kzh
      handle.started({
        provider: agentDef.provider, model: agentDef.llm?.model ?? modelOf(agentDef) ?? null,
        child: sub.localAgent ? { id: sub.id, label: `jev:${agentDef.id}` } : null,
        detail: heard ? 'live' : 'off', why: heard ? null : liveOffWhy(provider),
        ...(!heard && patchKey ? { see: 'Settings, Jev setup, Live agent view' } : {}),
        // A local model thinks aloud only when its manifest entry says so (llamaArgs), which the Live tab says.
        thinking: agentDef.llm?.provider === LOCAL_PROVIDER ? !!local.modelOf?.(agentDef.llm.model)?.thinking : null,
      })
      // A run the live view does not hold (the capability benchmark's) is not followed at all.
      const following = live.has(runId) ? followSpawn(sub, handle, { pumpMs: liveSeams.pumpMs, onHeard: (id) => steerHeard(runId, id) }) : { drain() {} }
      // A task's work attempt takes the person's words from here until its agent's result is in
      // (Steer, Send now): never an opinion or a review, nor a run of the chat.
      const unsteer = steerable
        ? steerers.add(runId, { attempt: attemptIndex, role, agentId: agentDef.id, name: nameOfAgent(agentDef), provider, sub, control: kzh?.kzhControl ?? null })
        : () => {}
      // The words given while it waited to start, after its prompt was built, go to it now (steerOnStart).
      if (steerable) steerOnStart(runId)
      let stopReason = null
      try {
        // The agent's result is in once this settles; the router is told before its process is
        // disposed of, which can take a while, so a primary that breaks off meanwhile is not taken
        // to have stopped it. From then on no word reaches it: a spawn child given a steer once idle
        // would start a turn nobody waits for.
        const r = await Promise.resolve(sub.result).finally(() => { unsteer(); try { onEnded?.() } catch { /* the router's */ } })
        stopReason = r.stopReason
        // Neither connector's result says what its run spent: a patched one's tap heard it, tokens,
        // cost and the model that served it, which the router records as `servedModel`, never as a
        // model version, so capability evidence keeps its keys.
        const tapped = kzh ? handle.usage() : null
        const spent = r.usage && typeof r.usage === 'object' && Object.keys(r.usage).length ? r.usage : tapped?.usage ?? r.usage
        if (report) report.tokens = usageTokens(spent)
        return {
          stopReason: r.stopReason, diagnostic: r.diagnostic, answerText: textOf(r.output), usage: spent, ...(version ? { modelVersion: version } : {}),
          ...(tapped?.costUsd != null ? { costUsd: tapped.costUsd } : {}),
          ...(tapped?.apiEquivalentUsd != null ? { apiEquivalentUsd: tapped.apiEquivalentUsd } : {}),
          ...(tapped?.servedModel ? { servedModel: tapped.servedModel } : {}),
        }
      } finally {
        unsteer()
        // The last of what the child committed is read before it is disposed of, which takes its session.
        following.drain({ stopReason })
        // Words Send now gave this attempt that its agent never took in were not used, and the next
        // attempt's prompt is not given them: they were to replace a step of this one.
        if (steerable) endNow(runId, attemptIndex)
        // Both providers' dispose() ends the agent's process and waits for its exit. A failure here
        // is still not the run's, but a caller that grades the folder next is told of it: something
        // of the agent may still be running there (docs/benchmark.md 3.6).
        await sub.dispose().catch((err) => { if (report) report.disposeError = String(err?.message ?? err) })
      }
    }

    // Which agents can be handed an image. A fact about their own tool loop, not a guess.
    const seesImages = new Set()
    for (const a of agents) if (await agentSeesImages(a.id).catch(() => false)) seesImages.add(a.id)
    const ready = await readiness()
    return {
      agents,
      byId,
      ready,
      deps: {
        ready,
        // Capability routing: what each executor on this machine really is, so code can drop
        // the ones that cannot do this request before Jev is asked (and check its pick after).
        executors: executorsFrom({
          agents,
          tools: config.tools ?? [],
          chat: await chatPair(),
          seesImages: (id) => seesImages.has(id),
          economics: config.resources?.economics ?? {},
        }),
        execute,
        // How each agent is locked against writing for a read pass, with this run's parent's view.
        lockOf: (a, o) => lockFor(a, agent, o),
        runTool: runTool(cwd, config.agentTimeoutMs),
        modelOf,
        emit: onEvent,
        quota,
        isLimitError: detectLimit,
        onLimit: (agentId, info) => onLimit(byId.get(agentId), info),
        // The key (an api agent's active key, else null) and the account a call starts on.
        accountAt: (agentId) => { const a = byId.get(agentId); if (!a) return null; const p = kindOf(a) === 'api' ? keyProviderOf(a) : null; return { key: p ? accounts.launchKeyName(p) : null, account: accountOf(a) } },
        // Only metered keys need re-reading; a subscription's window is rationed by the gate,
        // and a local model costs nothing.
        checkBalance: async (agentId) => {
          const a = byId.get(agentId)
          if (!a || kindOf(a) !== 'api') return null
          const snap = await usage.snapshot([a], { force: true }).catch(() => null)
          const q = snap?.[agentId]
          return q ? { state: q.state, balance: q.balance ?? null, until: q.until ?? null } : null
        },
        logAttempt: (entry) => {
          // This run's id (shared with its Jev call lines) and normalized token counts win over the router's.
          const { tokens: u, runId: _routerRunId, answerText: _a, ...rest } = entry
          const a = byId.get(entry.agent)
          return usage.logAttempt({
            // The account the call started on, when the router says; else the one active now.
            ...rest, runId, sessionId, workspace: cwd, provider: a?.provider ?? null, account: rest.account !== undefined ? rest.account : a ? accountOf(a) : null,
            tokens: usageTokens(u),
            costUsd: rest.costUsd ?? null, quotaBefore: quota[entry.agent]?.summary ?? null, quotaAfter: usage.last()?.out?.[entry.agent] ? summaryOf(usage.last().out[entry.agent]) : null,
            ...(purpose ? { purpose } : {}),
            ...(benchmarkRunId ? { benchmarkRunId } : {}),
          }).catch(() => {})
        },
      },
    }
  }

  // The capability benchmark's scratch workspace, beside the harness (docs/benchmark.md 3.7): no
  // routed task runs there but the benchmark's.
  const scratchRoot = resolve(benchmarkSeams.scratchRoot ?? join(harnessDir, '..', 'kzh-scratch'))
  const sameDir = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))
  const inScratch = (cwd) => sameDir(cwd, scratchRoot) || resolve(cwd).startsWith(scratchRoot + sep)
  const SCRATCH_ONLY = 'The KzH scratch workspace is for the capability benchmark only; open one of your projects to run tasks.'
  /** Whether a task sent from a chat in `cwd` can run there: one with no folder, in No project or in the scratch workspace is refused. */
  const tasksRunIn = (cwd) => !!cwd && !isNoProject(cwd) && !inScratch(cwd)

  // A routed agent is started as a child of the chat that routed it (runAgent's `parent`), and a
  // child that called jev_route would route its own task again, waiting on the lane its own parent
  // holds, forever. Spawn children cannot see the tool (runAgent's toolFilter); this refuses the
  // call by who makes it, whatever the provider: a child (its session header's parentSession) of
  // a chat with a route running now. Keyed on the caller, not the workspace, so another run in
  // the same folder, a foreground /auto beside a background task, waits its turn in the lane.
  const routing = new Map() // session id -> routes running now for it
  const nestedIn = (agent) => { const up = agent?.session?.header?.parentSession; return !!up && (routing.get(up) ?? 0) > 0 }

  // Read-only work (docs/queue-and-cost-findings.md 1). An agent whose lock did not hold (files
  // changed while it ran locked and no task was changing the folder) takes no read-only work until
  // the harness restarts; by agent id, with when and what changed. The plugin that closed just before
  // leaves its own here, so neither a setting changed nor a breach its run still going finds after the
  // close trusts the agent again (handover.js).
  const distrusted = inherited.distrusted ?? new Map()
  // How `a` can be locked against writing when `parent` starts it, or why not: the facts as the
  // engine reports them now (capabilities.js lockOf), the parent's own view of the tools included.
  const lockFor = (a, parent, { images = false } = {}) => {
    let toolMode
    try { toolMode = ctx.tools?.modeFor?.(parent) } catch { toolMode = undefined }
    return lockOf(a, {
      providerNamed: (n) => ctx.subagents.getProvider?.(n),
      visibleTool: (n) => ctx.tools?.get?.(n, parent) !== undefined,
      toolMode,
      images,
      distrusted: distrusted.get(a.id) ?? null,
    })
  }
  // What Jev setup says of an agent's read-only work. A spawn agent's tools depend on the chat that
  // starts it, so only what holds for every run is read here, and the rest as each run starts.
  const readOnlyOf = (a) => {
    const l = a.provider === 'spawn'
      ? lockOf(a, { providerNamed: (n) => ctx.subagents.getProvider?.(n), visibleTool: () => true, toolMode: 'native', distrusted: distrusted.get(a.id) ?? null })
      : lockFor(a, null)
    return l.lock ? { how: a.provider === 'spawn' ? 'read tools only, checked as each run starts' : l.lock.how, why: null } : { how: null, why: l.why }
  }
  // Said once in the server log, the first time a task is judged read only: which agents can take
  // such work and how, and which cannot and why.
  let readOnlyLogged = false
  const logReadOnly = (agents) => {
    if (readOnlyLogged) return
    readOnlyLogged = true
    const parts = agents.map((a) => { const r = readOnlyOf(a); return r.how ? `${a.id} by ${r.how}` : `not ${a.id} (${r.why})` })
    process.stdout.write(`[jev] read-only work: ${parts.join('; ') || 'no agent is switched on'}\n`)
  }
  // Every run going on, and every run that ended while one started before its end still goes on,
  // each by the folders it works in as a repository sees them (runKeysOf) and when it started and ended
  // (in one sequence). A read pass's lock check can only pin a change on its own agents when no
  // other run, a writer or another read pass, went on at any time while it ran in a folder that
  // holds its repository or sits inside it: `git status` sees the whole repository, and a run in a
  // folder above it (a folder of projects, a repository holding a clone that is not a submodule)
  // writes into it just the same. Linked worktrees of one repository share the .git/config and hooks
  // the lock check compares, so runs in them are related too, and a folder reached through a link
  // is known by both its spellings.
  const runLog = createRunLog({ sep })
  // Which run holds each workspace's lane, since when, and what it turned out to be, while it runs:
  // a waiting task's estimate starts from how long that run has gone and what it runs (waits.js
  // levels), taken from its own events as they pass (route()'s onEvent). A lane held by anything
  // else, a benchmark, has no entry here and so no estimate.
  // A run holding a lane is described on the lane itself (acquire's `who`): what kind of run it is,
  // who decides it, since when it holds the lane and what it turned out to be. The lane hands it to
  // whoever asks where a waiting task stands, so no second record keyed by workspace can drift from
  // who really holds it.
  // What a run holding a lane is, from its events: who decided it, which agent does the work (none
  // for a tool), whether its plan has a review by a second agent, and the effort its first work
  // attempt started at.
  const noteShape = (held, e) => {
    if (!held) return
    if (e.type === 'routed') held.shape = { ...held.shape, decider: e.routing?.decider ?? held.shape?.decider, agent: e.tool ? null : e.routing?.primaryAgent ?? null, review: !!(e.plan?.forceReview && e.plan?.reviewer) }
    if (e.type === 'attempt_start' && e.role === 'primary' && held.shape && held.shape.effort === undefined) held.shape = { ...held.shape, effort: e.effort ?? null }
  }
  // One routed run. A background task's pass also names its task: `jobId` and `taskKey` (tasks.js
  // key), both on the inspector's entry and the key alone on the history row, and `intentSample`,
  // the intent sample of the message that queued it.
  async function route({ task, agent, forceAgent, answerOnly, effort, mode = 'auto', decider = 'jev', laneHeld = false, who: laneWho = null, access = null, modalities, signal = new AbortController().signal, emit, onEntry, taskKey = null, jobId = null, intentSample = null }) {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('cannot determine the session workspace; open a workspace first')
    if (inScratch(cwd)) throw new Error(SCRATCH_ONLY)
    // Who decides the run. Laya is refused here, before anything is queued or run, when it cannot
    // be asked at all, whatever sent the run (a message, a background task however long after it
    // was queued, /laya), and a run it refuses is never handed to Jev (docs/laya-auto.md 3.5).
    const laya = decider === 'laya'
    if (laya) layaUnavailable('act')
    else if (decider !== 'jev') throw new Error(`jev-router: no decider named ${decider}`)
    const key = resolve(cwd).toLowerCase()
    if (nestedIn(agent)) throw new Error('a routed agent must do its task directly, not call jev_route: it would wait for its own run to end')
    // A read pass runs beside whatever holds its workspace, so it may only come from the task
    // runner, which gave it a slot of its own (tasks.js runAdmitted).
    const readPass = access?.mode === 'read'
    if (readPass && !laneHeld) throw new Error('a read pass runs only from the task runner, on a slot of its own')
    // One queue per workspace for every caller. Background tasks and slash commands
    // used to hold two independent mutexes, which let both run in one working tree. The budget's
    // cap on tasks at once counts this run too, so when it has to wait it says so, in its live lines
    // and the log, rather than sitting silent until a task in another workspace ends.
    const who = laneHeld ? laneWho : { kind: 'chat', decider, answerOnly: !!answerOnly }
    const release = laneHeld ? () => {} : await lanes.acquire(key, `route-${randomUUID()}`, signal, { who, onWait: (why) => { emit?.({ type: 'queued', text: WAITING[why] }); process.stdout.write(`[jev] ${WAITING[why]}\n`) } })
    const routingFor = agent?.session?.id
    if (routingFor) routing.set(routingFor, (routing.get(routingFor) ?? 0) + 1)
    const sessionId = sessionIdOf(agent) ?? cwd
    // One id for the whole run, minted before anything records it (2.4): the inspector's entry,
    // Stop, the task record, the router, usage.jsonl and the shadow's rows all carry it.
    const runId = randomUUID()
    const entry = logRun(sessionId, task, runId, { jobId, taskKey })
    const held = who
    if (held) Object.assign(held, { runId, startedAt: entry.startedAt, shape: { decider } })
    onEntry?.(entry)
    const stop = new AbortController()
    stoppers.set(runId, stop)
    signal = AbortSignal.any([signal, stop.signal])
    // Every run is counted as it starts, by the folder its repository is known by, which git looks
    // up meanwhile: nothing is awaited for it, so no run waits on it (a Laya start included), and
    // until it is known the run counts as related to every other (createRunLog). Only after
    // onEntry: nothing may be awaited between the lane letting a task in and its record saying so,
    // or a Remove meant for a waiting task would stop one that already holds its lane.
    const counted = runLog.track(() => runKeysOf(cwd), laneKey(cwd))
    // From the moment a Laya-decided run starts to its return, Laya is held: neither the idle stop
    // nor the RAM watchdog takes it away between the run's calls, which can be minutes apart (7.6).
    if (laya) sidecar.hold(runId)
    let client = null
    // Jev Auto says once, at the routed event, whether Laya answers the same questions in the
    // background, and nothing else of the shadow reaches the live stream (3.3).
    const withShadowNote = (e) => (e.type === 'routed' && !laya && client && shadowOn() ? { ...e, shadow: sidecar.isReady() ? 'answering' : 'not_running' } : e)
    // Each step also goes to the server log, which the Kz-harness app shows in its log window, and to
    // the live view, which takes the milestones it marks and never throws. A piece of the person's
    // guidance a prompt carried to an attempt (router.js) is noted on its task first (carriedSteer).
    const told = (e) => { noteShape(held, e); entry.events.push({ ...e, text: line(e) }); live.router(runId, e); emit?.(e); logStep(line(e)) }
    const onEvent = (event) => { const e = withShadowNote(event); told(e.type === 'steer' && e.state === 'carried' && steerRuns.has(runId) ? carriedSteer(runId, e) : e) }
    // The live view of the run (live.js), opened before its first event and ended in the finally below:
    // its milestones, and each agent's own work where this build can read it. A run of the chat is
    // followed as a task's pass is. `ended` is how it ended: its final status, or how without one.
    live.open(runId, { taskKey, sessionId, decider })
    // A task's run takes the person's words as it works (Steer), and says what becomes of them on its
    // own events; `names` are its agents' names, once known.
    if (taskKey) steerRuns.set(runId, { key: taskKey, say: told, names: {} })
    live.describe(runId, { checks: config.checks?.enabled !== false, answerOnly: !!answerOnly || readPass })
    let ended = null
    // The run's history.jsonl row once router.js has written it, which it does for a stopped run too.
    let recorded = null
    try {
      const onTrace = (trace) => onEvent({ type: 'jev', at: Date.now(), trace })
      // A call that did not answer is a line of its own, and never a usage row (2.4, 3.3).
      const onError = (error) => onEvent({ type: 'decider-error', at: Date.now(), error })
      // Review runs on this same client (router's default createReview), so it shares key rotation and the usage log.
      // Offline: no Jev at all (fixed routing rule, deterministic review), so nothing waits on a dead network.
      // 'local' keeps Jev routing but only over local models; 'offline' also drops Jev.
      const localOnly = mode === 'local' || mode === 'offline'
      // The mirror of localOnly. The router drops it when offline or local-only is in force, so a
      // dead network reports the offline restriction rather than an empty agent pool.
      const remoteOnly = mode === 'online'
      // Laya needs no network: offline it keeps deciding, and its own probe only narrows the pool
      // to the local agents.
      const offline = mode === 'offline' || await isOffline(decider)
      const onWait = (text) => onEvent({ type: 'loading', at: Date.now(), text })
      client = laya
        ? await makeDecider('laya', { onTrace, onError, runId, emit: onEvent, onWait })
        : offline ? null : await makeDecider('jev', { onTrace, onError, runId, emit: onEvent })
      // A stopped Laya is started now, and the run waits for it with the Starting Laya line; one
      // still starting after startWaitMs, or whose start failed, refuses the run as one that cannot
      // be asked at all does, before anything has run (3.5). A later call that finds Laya down waits
      // for its own start and, past that, fails as a timeout.
      if (laya) await layaReady({ signal, onWait })
      const { agents, ready, deps } = await runDepsFor({ agent, cwd, sessionId, runId, signal, onEvent })
      // Who reviews its attempts (offline, the checks alone decide), and the agents by their names.
      const names = Object.fromEntries(agents.map((a) => [a.id, nameOfAgent(a)]))
      live.describe(runId, { reviewer: client ? decider : null, names })
      if (steerRuns.has(runId)) steerRuns.get(runId).names = names

      // What each resource actually is right now, through its provider's own adapter: its limits
      // in that provider's own terms, its economics, its hardware, how much to trust the figures.
      await noteResources(agents)
      const snapshots = config.routing?.enabled === false ? [] : snapshotResources({
        agents,
        usage: usage.last()?.out ?? {},
        ready,
        config,
        specs: await specs().catch(() => null),
        now: Date.now,
        modelOf,
        policy,
        rates: pricingNow(config.pricing?.peak),
      })
      // The samples this run's decisions produced, so the outcome can label them afterwards.
      let decisionSamples = []
      const result = await runRouted({
        task,
        cwd,
        sessionId,
        forceAgent,
        answerOnly,
        effort,
        access,
        taskKey,
        intentSample,
        config: { ...config, agents, effort: await readEffort() },
        signal,
        deps: {
          ...deps,
          // A read pass's lock check: whether any other run went on in a related folder while it
          // ran (one was going at its start, one is going now, or one started and ended since),
          // and what to do when files changed with none of that.
          ...(readPass ? {
            // Asked once the folder has been read again: the runs that count are fixed then, and
            // their folder lookups still pending are waited for (createRunLog besideNow).
            besideOther: () => runLog.besideNow(counted),
            onLockBreach: (ids, files) => {
              for (const id of ids) distrusted.set(id, { at: Date.now(), files })
              process.stdout.write(`[jev] read-only lock did not hold: ${files.join(', ')} changed in ${cwd} while ${ids.join(', ')} ran locked; ${ids.join(', ')} takes no read-only work until the harness restarts\n`)
            },
          } : {}),
          // Whoever decides, and always its record beside it, so the run's bars are its bars even
          // when there is no client (docs/laya-auto.md 2.4).
          decider: client,
          provider: laya ? LAYA : providers.jev,
          runId,
          // When this run took its lane: its history row's wall time counts from here, as the
          // waiting line's figure for a run holding the lane does (waits.js).
          startedAt: entry.startedAt,
          offline,
          localOnly,
          remoteOnly,
          jevUnavailableReason: laya ? 'Laya unavailable' : offline ? (mode === 'offline' ? 'offline mode: local models and checks only' : 'offline: no internet, checks only') : `${config.credentialRef} not configured`,
          // Where Laya ran its calls, for the report's lines.
          ...(laya ? { deciderDevice: () => sidecar.connection()?.device ?? sidecar.status().running?.device ?? null } : {}),
          inputModalities: modalities ?? ['text'],
          // The decision engine. Absent (routing switched off) the loop asks Jev directly, the
          // way it did before any of this existed.
          // A Laya-decided run's samples go to Laya's store, and its review decides the outcome
          // domain for Laya into that store (6.3).
          ...(config.routing?.enabled === false ? {} : {
            decide: async (args) => {
              const d = await decisions.decide({ ...args, versionOf, snapshots, ...(laya ? { sink: layaStore } : {}) })
              decisionSamples = d.samples ?? []
              return d
            },
            outcomeDomain: laya ? layaOutcomeDomain() : outcomeDomain(),
          }),
          history: { ...history, append: async (record) => { await history.append(record); recorded = record } },
          // What the person added to the task as it ran (Steer), which every prompt built from here on
          // carries (router.js withGuidance), in their words whole.
          guidance: () => (taskKey ? guidanceOf(taskKey) : []),
        },
      })
      // What the run proved, recorded after the fact: capability evidence per resource, and the
      // label each routing decision earned. Never on the run's critical path, and never fatal.
      // A Laya-decided run gives the Jev domains nothing new to evaluate, and their evaluation pass
      // stamps and saves every Jev domain state, so only Laya's own pass follows it (2.4, 6.7).
      // The verdicts about this task's pick given while it ran are applied now, over what learnFrom
      // labelled from the run alone, by the plugin that holds the task now (learnFromRunNow).
      learnFromRunNow(result, decisionSamples, { byLaya: laya })
      ended = result.finalStatus ?? null
      return withRunMark(formatReport(result), result.runId)
    } catch (err) {
      // A read pass that cannot do the task locked is no error: the task goes to its folder's line
      // (tasks.js runAdmitted), and its record and row say why. Nothing is learned from it.
      if (err?.code === NEEDS_LANE) onEvent({ type: 'access', at: Date.now(), mode: 'write', from: 'read', why: err.message, ...(err.changesFiles ? { changesFiles: true } : {}), ...(err.readPass?.breach ? { breach: err.readPass.breach } : {}) })
      else onEvent({ type: 'error', at: Date.now(), message: err.message })
      ended = err?.code === NEEDS_LANE ? 'needs_write' : signal.aborted ? 'stopped' : 'failed'
      // A stopped run is on the record too, and the verdicts about its task's pick given while it went
      // are applied to it now, though nothing is labelled from how it ended (no learnFrom). A run that
      // failed wrote no row, so there is no run to apply them to.
      if (ended === 'stopped' && recorded) inBackground(bindRunNow(recorded))
      throw err
    } finally {
      // Guidance no agent had read as the run ends was not used, which its bubble says before the
      // transcript is saved; a read pass handing its task back keeps it for the pass that writes.
      if (taskKey && ended !== 'needs_write') { try { endGuidance(runId, taskKey) } catch { /* the task's end says it */ } }
      steerRuns.delete(runId)
      // The live view says the run has ended, and a task's transcript is saved as each of its runs ends.
      live.finish(runId, { status: ended })
      // Its task's transcript, by the Keep transcripts and the task list of the plugin that has taken
      // the task over when this one has closed (handover.js).
      const atEnd = place.heir()?.transcriptAtEnd ?? transcriptAtEnd
      atEnd(taskKey)
      if (laya) sidecar.release(runId)
      runLog.close(counted)
      if (routingFor) { const n = (routing.get(routingFor) ?? 1) - 1; if (n > 0) routing.set(routingFor, n); else routing.delete(routingFor) }
      release()
      stoppers.delete(runId)
    }
  }

  // Each agent at high effort and Codex and Claude Code at their normal speed, whatever Settings say,
  // so the spend the confirmation states cannot change after it and a score does not move when
  // Settings do; one work attempt, no review and one round, so no other agent is ever scored for it
  // (docs/benchmark.md 3.8).
  const BENCHMARK_EFFORT = Object.freeze({ default: 'high', perAgent: {}, codexSpeed: 'normal', claudeSpeed: 'normal' })
  const BENCHMARK_LIMITS = Object.freeze({ maxAttempts: 1, maxReviews: 0, maxRounds: 1 })

  /**
   * One task of the capability benchmark through the normal run path (docs/benchmark.md 3.8): the
   * agent forced, in the task's `folder`, started with the scratch chat's root agent `owner` as its
   * parent, with no decider, no Jev or Laya call and no routing sample, and a history that keeps
   * the run's record for the task's row and writes nothing to history.jsonl. It takes the lane of its
   * own folder, so it counts under the cap on tasks at once, is logged under the scratch session
   * like any run and can be stopped from the inspector. `git` is the environment every git call on
   * the folder runs with (benchmark.js gitEnv). Resolves to { record, executed, error, stoppedBy },
   * never rejecting: what the run came to is benchmark.js's to read.
   */
  async function runBenchmarkTask({ agent: agentDef, owner, session, folder, git, prompt, benchmarkRunId, signal, onWait, onStart }) {
    const executed = []
    let record = null
    let release = null
    const stop = new AbortController()
    const runId = randomUUID()
    const runSignal = AbortSignal.any([signal, stop.signal])
    // Who stopped the task, if anyone: the person from the inspector, or the benchmark's own Stop.
    const stoppedBy = () => (stop.signal.aborted ? 'person' : signal.aborted ? 'benchmark' : null)
    try {
      release = await lanes.acquire(laneKey(folder), `benchmark-${runId}`, signal, { who: { kind: 'benchmark' }, onWait: (why) => onWait?.(WAITING[why]) })
      onStart?.()
      const entry = logRun(session, prompt, runId)
      stoppers.set(runId, stop)
      const onEvent = (e) => { entry.events.push({ ...e, text: line(e) }); logStep(line(e)) }
      try {
        const { agents, deps } = await runDepsFor({ agent: owner, cwd: folder, sessionId: session, runId, signal: runSignal, onEvent, purpose: 'benchmark', benchmarkRunId, onExecuted: (r) => executed.push(r) })
        await runRouted({
          task: prompt,
          cwd: folder,
          sessionId: session,
          forceAgent: agentDef.id,
          config: {
            ...config,
            agents,
            effort: BENCHMARK_EFFORT,
            limits: BENCHMARK_LIMITS,
            // The task's own test script decides the run's own status and is recorded; the grade
            // decides the score. It runs the agent's code with the environment the engine gives the
            // agents' own processes, so no key of KzH's is within its reach.
            checks: { enabled: true, scripts: ['test'], timeoutMs: 120_000, outputChars: config.checks?.outputChars ?? 3000, env: agentEnv() },
            // Every git call on the task folder runs with the environment benchmark.js gives it: the
            // folder's repository, kept outside the scratch root where no agent writes, and no key
            // of KzH's (docs/benchmark.md 3.7).
            git: { env: git },
          },
          signal: runSignal,
          deps: {
            ...deps,
            decider: null,
            provider: providers.jev,
            runId,
            offline: false,
            jevUnavailableReason: 'the capability benchmark asks no decider',
            history: { recent: async () => [], records: async () => [], feedback: async () => [], append: async (r) => { record = r } },
          },
        })
      } catch (err) {
        onEvent({ type: 'error', at: Date.now(), message: err.message })
        throw err
      }
      // runRouted() returns without throwing after a stop too: when the provider settles the stopped
      // attempt as aborted rather than rejecting, and when the stop lands after the attempt, while
      // the router's git and checks read it as a failure. A stop is a stop either way.
      return { record, executed, stoppedBy: stoppedBy() }
    } catch (err) {
      return { record, executed, error: err, stoppedBy: stoppedBy() }
    } finally {
      stoppers.delete(runId)
      release?.()
    }
  }

  // --- Background tasks -------------------------------------------------
  // A routed task runs as a DSH background job so the chat stays free, and one
  // at a time per workspace (a lane) so two agents never edit the same folder.
  // The result is posted into the chat on the session's next turn.
  // The lanes of the plugin that closed just before, when it left them: its runs still hold theirs.
  const lanes = inherited.lanes ?? createLanes()
  // The budget's cap on tasks at once, across every workspace. Changes arrive through onSettings.
  local.readSettings().then((s) => lanes.setMax(s.maxConcurrentTasks), () => {})

  // The delivery path lives in its own module so it can be tested (test/delivery.test.js): it is
  // the path a person's result travels, and inside this closure it had no test at all. It needs
  // the task registry, which is built just below with a callback that calls it, so the reference
  // is filled in immediately afterwards.
  let delivery = null
  // The finished result body is rewritten by this before it is posted. Filled in by the llm block
  // below, once the local chat model can be asked; until then (and with no local model) it no-ops.
  let formatter = null
  const tasks = createTasks({
    file: join(dataDir, 'tasks.jsonl'),
    lanes,
    // Optional service: without the tool-jobs plugin there is no job controller,
    // enqueue() returns null and the adapter runs the task blocking, as before.
    // ctx.jobs THROWS when 'jobs' is not in this plugin's inject list, rather than
    // returning undefined, so ask for it the way an optional service must be asked.
    // Absent (no tool-jobs plugin) means enqueue() returns null and tasks run blocking.
    jobs: () => { try { return ctx.get?.('jobs') ?? null } catch { return null } },
    // The result goes to its conversation the moment the task settles, and keeps trying if
    // that first attempt does not land; no prompt of its runs needs its guidance whole any more;
    // and a rating of its pick told to wait for its run is told so if it ended with none on record.
    onSettled: (result, owner) => {
      for (const s of result?.steers ?? []) steerTexts.delete(s?.id)
      delivery.deliverWithRetry(result, owner).catch(() => {})
      const t = tasks.get(result?.jobId)
      if (t?.key) inBackground(postFeedback.noRun({ taskKey: t.key, sessionId: t.sessionId }))
    },
    // Each task a restart stopped had no run of it end here, so the same goes for it.
    onRestartStopped: (t) => { inBackground(postFeedback.noRun({ taskKey: t.key, sessionId: t.sessionId })) },
    // The tasks the plugin that closed just before still had going, taken over here as the list loads:
    // a pass of one that starts after is run on this plugin's `route` once the list has loaded, so what
    // it says is heard here from its first event (takeFollows), what each of their runs taught is
    // learned here as it ends (`learnFromRun`), and so is a rating of a pick given here (`bindRun`, for
    // a run stopped, which teaches nothing else); its transcript is kept or not by this plugin's Keep
    // transcripts (`transcriptAtEnd`).
    takeOver: place.take({ route: (opts) => tasks.ready.catch(() => {}).then(() => route(opts)), learnFromRun, bindRun: (record) => postFeedback.bindRun(record), transcriptAtEnd: (key) => transcriptAtEnd(key) }),
    // How long a waiting task may still wait, from the runs like the one holding its workspace.
    wait: ({ workspace, holder, aheadWho, ...where }) => waitEstimate(waitStatsNow, where, { holder: holder?.startedAt ? { shape: holder.shape, elapsedMs: Date.now() - holder.startedAt, answerOnly: holder.answerOnly } : null, ahead: aheadWho, workspace }),
    // What its work is doing now (the work board's second line, the Tasks tab's live tail), from the
    // live view of its runs, read as the list is read and never saved.
    activity: (t) => live.activityOfRuns(t.runIds),
    // A task that leaves the list takes its saved live transcript with it.
    onDrop: (key) => { inBackground(live.drop(key)) },
    // Send now warns when a local model runs beside it, or it was sent to one itself.
    isLocal: (id) => localAgents.some((a) => a.id === id),
    // What Steer does now with words for a task at work, which its dialog says.
    steering: (t) => steerFacts(t),
    log: (m) => process.stdout.write(`[jev] ${m}
`),
    run: (t, { signal, emit, onEntry }) => {
      // Read before the first emit: `t.agent` becomes the agent the router picked and a read pass
      // sets `t.effort` to its own, so a writer pass after one runs with what the task was queued with.
      const forceAgent = t.agent ?? undefined
      const effort = t.effort ?? undefined
      const verdict = t.readVerdict ?? null
      const writeWhy = t.accessWhy ?? null
      // Only say "waiting" when it will wait, and what for: its workspace, or the cap on tasks at once.
      // A task judged read only takes a slot of its own first, and its workspace's lane only if its
      // read pass hands it back (tasks.js runAdmitted).
      // Whoever the task was queued for decides it, and route() asks now whether Laya can be
      // asked, however long ago the task was queued.
      return runAdmitted({ lanes, task: t, signal, who: { kind: 'task', decider: t.decider ?? 'jev' }, onWait: (why) => emit({ type: 'queued', text: WAITING[why] }),
        // A pass that starts once a plugin applied after this one has taken the task over is run by that
        // plugin, with its settings: this one has closed, and saves and posts nothing (handover.js). One
        // that starts after the close, before then, waits for it, within the bound (handedOver).
        run: async (pass) => {
          if (disposed) await place.handedOver()
          return (place.heir()?.route ?? route)({
            task: t.task, agent: t.owner, forceAgent, effort, mode: t.mode ?? 'auto', decider: t.decider ?? 'jev', laneHeld: true, who: pass.who,
            access: verdict || pass.mode === 'read' ? { mode: pass.mode, verdict, ...(pass.from ? { from: pass.from } : pass.mode === 'write' && writeWhy ? { why: writeWhy } : {}) } : null,
            modalities: t.modalities ?? ['text'], signal, emit, onEntry,
            // Each pass is the task's own, whatever the engine's job id comes to name after a restart.
            taskKey: t.key, jobId: t.jobId, intentSample: t.intentSample ?? null,
          })
        } })
    },
  })
  // Filled in now that the registry exists; onSettled above only dereferences it once a task
  // actually settles, which cannot happen before this line has run.
  delivery = createDelivery({
    tasks,
    log: (m) => process.stdout.write(`[jev] ${m}\n`),
    // Lazy: the formatter is built by the llm block below and is null until then.
    format: (r, text) => (formatter ? formatter(r, text) : text),
    // The result's head names the agent as the start reply did.
    names: () => agentNamesNow(),
    progress: () => chatReplies.progress,
  })

  // Closing, as KzH quits or the engine applies the plugin again, settles what the plugin has under
  // way on disk before the plugin that replaces it reads the folder: every task record asked for so
  // far, the switches saved so far, the live transcripts saved or deleted so far, and the background
  // writes (inBackground). Nothing new starts, and no store rewrites its file from what it holds
  // after, since the plugin that replaces this one writes its own rows there; a run still going keeps
  // only its appends, and saves no transcript as it ends. The routing domains stop saving last, once
  // an evaluation pass under way has saved what it found.
  // What is still going is left for the plugin the engine applies next on this data folder to take
  // over (handover.js): the tasks in line or at work, and the registries their runs write to from
  // here. One applied again within the bound records, saves and posts their results, and the live
  // store, which it reopens, saves their transcripts; as KzH quits, none is applied, and they end here
  // as before, saving and posting nothing.
  ctx.effect(() => () => {
    disposed = true
    const pending = [tasks.dispose(), training.dispose(), layaStore.dispose(), resourceTracker.dispose(), live.dispose(), setupQueue, ...background]
    place.leave({ kept: { lanes, live, steerers, steerRuns, steerTexts, following, distrusted }, tasks: tasks.handOff() })
    return closeWithin(pending, { log: (m) => process.stdout.write(`[jev] data folder: ${m}\n`) }).then(() => { domains?.dispose() })
  })

  // --- Chat replies: the start reply and the milestone notices (docs/live-agent-view.md Feature 2)
  // How the chat answers a task it queues (Settings, Jev setup, Chat replies): how long the start
  // reply waits for the router's pick, and whether milestone notices follow it. One small JSON file,
  // read once and kept here, so a reply never waits on a disk read; a file that cannot be read is
  // the settings as shipped.
  const chatRepliesFile = join(dataDir, 'chat-replies.json')
  let chatReplies = CHAT_REPLIES
  const chatRepliesRead = readFile(chatRepliesFile, 'utf8')
    .then((raw) => { chatReplies = validChatReplies(JSON.parse(raw)) })
    .catch(() => {})
  // Settings, Jev setup, Live agent view (validLiveSettings): one small JSON file, read once and kept
  // here; a file that cannot be read is the settings as shipped. Whether transcripts are kept is read
  // as each run ends; the two Claude Code settings are kept for Steer and Send now into a running task.
  const liveSettingsFile = join(dataDir, 'live.json')
  let liveSettings = LIVE_SETTINGS
  const liveSettingsRead = readFile(liveSettingsFile, 'utf8')
    .then((raw) => { liveSettings = validLiveSettings(JSON.parse(raw)) })
    .catch(() => {})
  // Keep transcripts, Last 20 tasks: a finished task further back than the task list's newest 20
  // keeps its record but not its transcript, deleted as each run ends and once at start-up. One
  // still at work keeps its own until its run ends: that saves it, and the deletes after it take it.
  // A plugin that has closed leaves that to the one that took its tasks over, by that one's settings.
  const pruneTranscripts = async () => {
    await liveSettingsRead
    if (disposed || liveSettings.transcripts !== 'last20') return
    await tasks.ready
    if (disposed) return
    const list = tasks.list()
    for (const t of list.slice(0, Math.max(0, list.length - TRANSCRIPTS_LAST))) if (t.key && TERMINAL_STATES.includes(t.state)) inBackground(live.drop(t.key))
  }
  inBackground(pruneTranscripts())
  // A task's transcript as one of its runs ends. Keep transcripts off (Live agent view): none is
  // saved, and one kept before is deleted. Last 20 tasks: the task's own is saved, and the ones of
  // tasks now past the newest 20 go. A run of the plugin that closed before this one ends here too,
  // once this one has taken its task over (handover.js).
  const transcriptAtEnd = (taskKey) => {
    if (taskKey) inBackground(liveSettings.transcripts === 'off' ? live.drop(taskKey) : live.persist(taskKey))
    inBackground(pruneTranscripts())
  }
  // Each agent's own name by its id, for the words the chat shows.
  const agentNamesNow = async () => Object.fromEntries((await enabledAgents().catch(() => [])).map((a) => [a.id, nameOfAgent(a)]))

  // Each task queued from the chat is followed while it lives, for what its router events say that
  // its record does not keep: whether the decider was asked before the pick, what the task waited
  // for, which agent works on it now, what moved it, and whether its read pass handed it back
  // because the work changes files. The start reply's credit and the milestone notices read it.
  // Memory only, and let go as the task settles. The follows of the plugin that closed just before go
  // on here, with the tasks this one took over from it (takeFollows, below).
  const following = inherited.following ?? new Map() // task key -> { key, jobId, owner, decider, asked, called, calledBefore, failedWhy, failedBefore, routed, waitedFor, workAgent, stepAgent, causes, changesFiles, guard, guardAt, unwatch, posting, movedOwed }
  // The plan reply A names for a task sent to an agent picked in the model menu (enqueue), by task
  // key, for the reply ledger's note of what that reply said (noteSaid). Kept apart from the follow,
  // which is let go as the task settles: an agent that refuses the task at once, signed out or at its
  // usage limit, can end it before its reply A is out. Let go once that reply is noted, or once its
  // task has left the task list, as one whose reply was stopped before it said what it named.
  const forcedPlans = new Map()
  // How a start reply that named the predictor's guess before routing picked came to name it (noteSaid).
  const GUESSES = ['quick', 'instant', 'likely']
  // How long after its wait a start reply that never said what it named (stopped mid-wait) is taken
  // to have named nothing, so the task's started notice still comes.
  const guardGraceMs = replySeams.graceMs ?? 5000
  // Whether a router event of a followed task can send its work to another agent, so its line is
  // among those that say why a retry went there (the moved notice's body): a review, and a usage
  // limit of the agent whose step it was (the work's, or the plan's before it), with that agent's
  // balance falling under its floor before it. A balance that only runs low keeps the work where it
  // is, and a limit of Jev's own key, of a parallel opinion or of a reviewer leaves it there: none of
  // those is of the agent whose step it was. A gate or a capability moves the work while it is
  // routed, before the `routed` that clears these, and a stall ends the run, so none of those is
  // ever among them.
  const movesWork = (f, e) => e.type === 'review' || (e.agent === f.stepAgent && (e.type === 'limit' || (e.type === 'balance' && OUT_STATES.includes(e.state))))
  // What a wait was for, from its reason (tasks.js WAITING): the folder, or a free slot.
  const waitedForOf = (why) => (why === 'workspace' || why === 'chat' ? 'folder' : why === 'cap' || why === 'line' ? 'slot' : null)
  const whyOfText = (text) => Object.keys(WAITING).find((k) => WAITING[k] === text) ?? null
  // Why a call to the decider did not answer, from its decider-error event (jev.js errorOf, which the
  // event carries as `error`), in the words a fallback's reason has (router.js describeError), for a
  // credit that says why the decider could not pick (router.js pickedBy).
  const failedWhyOf = (e) => {
    const x = e.error?.error ?? e.error ?? {}
    return redactSecrets(`${x.class ?? 'Error'}: ${x.message ?? 'no reason given'}`).slice(0, 300)
  }

  /** Follow a task just queued from the chat (tasks.js watch) until it settles, for its start reply and its notices. */
  function follow(t, { owner, decider, asked, waitMs }) {
    const f = {
      key: t.key, jobId: t.jobId, owner, decider, asked: asked && asked !== 'auto' ? asked : null,
      called: false, calledBefore: false, failedWhy: null, failedBefore: null, routed: null, workAgent: null, stepAgent: null, causes: [], changesFiles: false, guard: null, unwatch: null,
      // A task that waits as it is queued was told so before this could listen (tasks.enqueue).
      waitedFor: waitedForOf(tasks.get(t.jobId)?.waiting?.why),
      // Its notices so far, posted one after another (inTurn).
      posting: Promise.resolve(),
    }
    following.set(t.key, f)
    f.unwatch = tasks.watch(t.key, (e) => heard(f, e))
    // A start reply that never says what it named notes nothing (adapter.js startReply), as when it is
    // stopped in its wait for the pick: once it has had that wait and a grace for its text to go out,
    // it is taken to have named no plan, so the task's started notice still comes.
    const guardMs = Math.max(0, waitMs) + guardGraceMs
    // When that is, for a plugin applied again that takes the task over to keep (takeFollows).
    f.guardAt = Date.now() + guardMs
    f.guard = setTimeout(() => {
      if (tasks.byKey(f.key)?.ackGen == null) tasks.noteAck(f.key, { gen: 0, said: null })
      noticeDue(f)
    }, guardMs)
    f.guard.unref?.()
  }
  /** Let go of a task that has settled: nothing more is said of it but its result. */
  function unfollow(f) {
    clearTimeout(f.guard)
    f.unwatch?.()
    following.delete(f.key)
  }
  /**
   * The tasks the plugin that closed just before still followed, and this one took over as its list
   * loaded (createTasks takeOver), are followed from here (handover.js): that plugin's watch of each is
   * let go and this one's taken up, so the start reply's guard, the milestone notices and what the
   * reply ledger notes as each is routed are this plugin's from now on, and a notice owed meanwhile,
   * which that plugin could not claim, is posted now.
   */
  function takeFollows(taken) {
    // A plugin closed before its list loaded follows nothing: the plugin applied after it takes them.
    if (disposed) return
    for (const f of taken) {
      if (following.get(f.key) !== f || !tasks.byKey(f.key)) continue
      f.unwatch?.()
      clearTimeout(f.guard)
      f.unwatch = tasks.watch(f.key, (e) => heard(f, e))
      // A start reply not out yet keeps the wait it had: the chat's turn may still be writing it.
      if (tasks.byKey(f.key).ackGen == null) {
        f.guard = setTimeout(() => {
          if (tasks.byKey(f.key)?.ackGen == null) tasks.noteAck(f.key, { gen: 0, said: null })
          noticeDue(f)
        }, Math.max(0, (f.guardAt ?? 0) - Date.now()))
        f.guard.unref?.()
      }
      noticeDue(f)
      // A move heard after that plugin closed, before this one took the task over, is said from here.
      if (f.movedOwed) { const { e, lines } = f.movedOwed; f.movedOwed = null; moved(f, e, lines) }
    }
  }
  const takenFollows = [...following.values()]
  if (takenFollows.length) tasks.ready.then(() => takeFollows(takenFollows)).catch(() => {})
  /** One router event of a followed task, heard once its record holds it (tasks.js watch). */
  function heard(f, e) {
    if (e.type === 'settled') return unfollow(f)
    if (e.type === 'queued' && whyOfText(e.text)) f.waitedFor = waitedForOf(whyOfText(e.text))
    if (e.type === 'jev' || e.type === 'decider-error') f.called = true
    // Why the decider's last call did not answer, for a credit that says why it could not pick.
    if (e.type === 'decider-error') f.failedWhy = failedWhyOf(e)
    // A read pass handed the task back: the pass that writes after it is routed afresh. Whether it
    // went back because its work changes files is kept for the notice that it started again.
    if (e.type === 'access' && e.mode === 'write') Object.assign(f, { called: false, failedWhy: null, routed: null, workAgent: null, stepAgent: null, causes: [], changesFiles: !!e.changesFiles })
    if (movesWork(f, e)) f.causes.push(e)
    // A run the router stops for a person starts no agent, so nothing is said to have started.
    if (e.type === 'routed' && !e.stopsForPerson) {
      Object.assign(f, { routed: e, calledBefore: f.called, failedBefore: f.failedWhy, workAgent: e.tool ? null : e.primary?.agent ?? e.routing?.primaryAgent ?? null, causes: [] })
      noticeDue(f)
      if (ledgerOn()) noteRan(f, e)
    }
    // A plan step comes before the work, on an agent of its own whose limit sends the work elsewhere.
    if (e.type === 'attempt_start' && e.role === 'plan') f.stepAgent = e.agent
    if (e.type === 'attempt_start' && (e.role === 'primary' || e.role === 'retry')) {
      if (e.role === 'retry' && f.workAgent && e.agent !== f.workAgent) {
        // A reply that has not said what it named by the time the work moves was stopped in its wait.
        // It is taken to have named nothing now, as its guard would take it later, so the notice it is
        // owed goes first, naming the agent the work started on, and the moved notice follows it: left
        // to the guard, that notice would come after the moved one and name an agent the work has left.
        if (tasks.byKey(f.key)?.ackGen == null) { tasks.noteAck(f.key, { gen: 0, said: null }); noticeDue(f) }
        moved(f, e, [...f.causes.map((c) => line(c)), line(e)])
      }
      Object.assign(f, { workAgent: e.agent, stepAgent: e.agent, causes: [] })
    }
  }
  // A notice is extra: one that cannot be worked out or posted is logged, and the task goes on.
  const noticeFailed = (f) => (err) => process.stdout.write(`[jev] notice for ${f.jobId} not posted: ${err?.message ?? err}\n`)
  /**
   * Post one notice of a followed task once every notice claimed for it before has gone out or
   * failed, so they land in the order they were claimed, however long each takes to word. `claim`
   * claims the notice (tasks.js claimNotice) before it awaits anything, and resolves with its words,
   * or with nothing when none is owed. Never rejects.
   */
  function inTurn(f, claim) {
    const before = f.posting
    const words = claim()
    const posting = (async () => {
      const said = await words
      if (!said) return
      await before
      await delivery.notify(f.owner, { key: f.key, ...said })
    })().catch(noticeFailed(f))
    f.posting = before.then(() => posting)
    return posting
  }
  /**
   * Post the milestone notice a followed task is owed now, if any (tasks.js startedNoticeDue). Start
   * and result only posts one of them: the change of plan of a guess routing did not pick (tasks.js
   * guessMissed), worded as under Milestones. Never rejects.
   */
  function noticeDue(f) {
    return inTurn(f, async () => {
      const seen = tasks.byKey(f.key)
      const kind = startedNoticeDue(seen)
      const missed = kind === 'change' && guessMissed(seen)
      if (!kind || (chatReplies.progress === 'off' && !missed) || !tasks.claimNotice(f.key, kind)) return null
      const names = await agentNamesNow()
      const nameOf = (id) => names[id] ?? id
      const p = seen.plan
      const base = { jobId: f.jobId, workspace: seen.workspace, agent: nameOf(p.agent), model: p.model, effort: p.effort, speed: p.speed, tool: p.tool }
      if (kind === 'change') {
        // A reply that named a forced agent's plan, which routing never moves off its agent, or the pick
        // it waited for can differ only in effort. One that named a guess before the pick (a quick
        // reply, or the likely agent of one that waited) can name another agent, and then says why the
        // work went elsewhere when the routing's record holds a hard fact about the agent it named.
        const cause = missed ? whyNotPicked(f.routed, seen.said.agent) : null
        const why = cause ? changeReason({ ...cause, agent: nameOf(seen.said.agent) }) : null
        return { ...changeNotice({ ...base, by: pickedBy(f.routed?.routing, f.calledBefore), decider: f.decider, saidAgent: nameOf(seen.said.agent), saidEffort: seen.said.effort, why }), missedGuess: missed }
      }
      return kind === 'again' ? againNotice({ ...base, why: seen.accessWhy, changesFiles: f.changesFiles })
        : startedNotice({ ...base, waitedMs: f.waitedFor && seen.startedAt ? seen.startedAt - seen.queuedAt : 0, waitedFor: f.waitedFor })
    })
  }
  /**
   * Post the moved notice for a retry on another agent, with the router's own lines for why. Heard
   * once this plugin has closed, it is left for the plugin applied again to post as it takes the task
   * over (takeFollows), since a claim here could not be saved. Never rejects.
   */
  function moved(f, e, lines) {
    if (disposed) { f.movedOwed = { e, lines }; return Promise.resolve() }
    return inTurn(f, async () => {
      if (chatReplies.progress === 'off' || !tasks.claimNotice(f.key, 'moved')) return null
      const names = await agentNamesNow()
      return movedNotice({ jobId: f.jobId, agent: names[e.agent] ?? e.agent, lines })
    })
  }
  /**
   * A followed task's plan as the start reply names it: the plan (tasks.js planOf, which says whether
   * a local model goes first), which routing it is, its run, how long the pick took, the agent
   * strip's chain, and who picked it and why (reply-words.js creditLine).
   */
  async function planned(f, seen, e = f.routed) {
    const r = e?.routing ?? {}
    const agentDef = (await enabledAgents().catch(() => [])).find((a) => a.id === seen.plan.agent)
    const settings = await readEffort()
    // Who picked, as the strip's router step names it (router.js pickedBy), so the credit never gives
    // the decider a pick the rules or the local router made after its calls failed.
    const by = pickedBy(r, f.calledBefore)
    return {
      plan: seen.plan, gen: seen.planGen, runId: seen.runId, ms: e?.ms ?? null,
      steps: [routerStep(r), workerStep(seen.plan)].filter(Boolean),
      decidedBy: {
        by, called: !!f.calledBefore, decider: r.decider ?? seen.decider,
        taskType: r.taskType ?? null, complexity: r.complexity ?? null, risk: r.risk ?? null,
        from: effortFrom({ asked: f.asked, settings, family: effortFamily(agentDef) }),
        // The step your ratings moved Auto (router.js plannedEffort), named only when it changed
        // what the agent is sent: DeepSeek runs medium as it runs high, and Codex stops at its
        // model's top.
        nudged: e?.nudged && toAgentEffort(e.nudged.from, agentDef, { model: seen.plan.model }) !== seen.plan.effort ? e.nudged : null,
        movedOff: r.feedbackFrom ?? null,
        // Why the decider could not pick: a fallback's own reason, else the last call of it that
        // failed before a pick the rules or the local router made.
        reason: r.mode === 'fallback' ? r.reason ?? null : by === 'rules' || by === 'local' ? f.failedBefore ?? null : null,
      },
    }
  }
  /**
   * What a forced agent runs with, worked out as its first attempt will (router.js plannedEffort),
   * so the start reply names it before the task starts: the plan, its words and the credit.
   */
  async function forcedPlanOf(agentId, { effort, decider }) {
    const agentDef = (await enabledAgents()).find((a) => a.id === agentId)
    if (!agentDef) return null
    const settings = await readEffort()
    const model = modelOf(agentDef) ?? null
    const asked = effort && effort !== 'auto' ? effort : undefined
    const bands = (decider === 'laya' ? LAYA : providers.jev)?.thresholds?.effortBands
    const { effort: sent, level, speed } = plannedEffort({ effort: asked, config: { ...config, effort: settings }, agentDef, routing: null, model, bands })
    const name = nameOfAgent(agentDef)
    return {
      plan: { agent: agentId, model, effort: sent, level, speed },
      words: { agent: name, model, effort: sent, speed },
      credit: creditLine({ by: 'you', agent: name, effort: sent, speed, from: effortFrom({ asked, settings, family: effortFamily(agentDef) }) }),
    }
  }

  /**
   * The agents a task in `mode` could run on now, as the router will judge them: switched on (`on`),
   * of those the ones allowed, in this mode and the one asked for when one was (`could`), and why one
   * of them is not ready (`unready`): signed out, or at its usage limit by the last usage read, which
   * the router reads afresh. Read-only work asks it which agents could be locked, and the reply
   * ledger which ones the router could pick, by the last reading of which are ready too (`atHand`,
   * readinessAtHand), since a reply may not wait for a new one.
   */
  async function pickableNow({ mode, forceAgent, atHand = false }) {
    const { allows } = routingPolicy(config)
    const localOnly = mode === 'local' || mode === 'offline'
    const on = (await enabledAgents()).filter((a) => a.enabled)
    const ready = await (atHand ? readinessAtHand() : readiness()).catch(() => ({}))
    const out = usage.last()?.out ?? {}
    // At its limit by the last reading, unless the time it resets has passed since.
    const spent = (q) => OUT_STATES.includes(q?.state) && !(q.until && Date.parse(q.until) <= Date.now())
    const could = on.filter((a) => allows(a.id) && (!localOnly || a.kind === 'local') && (mode !== 'online' || a.kind !== 'local') && (!forceAgent || a.id === forceAgent))
    // One that is signed out or out of allowance is no lock, and the queued line says why.
    const unready = (a) => (ready?.[a.id] && !ready[a.id].loggedIn ? notReadyWhy(a, ready) : spent(out[a.id]) ? 'at its usage limit' : null)
    return { on, could, unready }
  }

  /**
   * What the reply ledger keeps of a task as it is queued (reply-ledger.js): the message's features
   * with the pool it is picked from, and the predictor's guess, which resolves once noted. `task` is
   * the message as the person wrote it, as its intent sample reads it: a picture shows only as
   * `has_image`, its `modality` and `modal:image`, never as the line that hands the agent its path,
   * which names folders of this PC and a new attachment each time. The reply waits for it only once
   * the decider's record has earned naming a guess (guessFor), and then not for a new reading of
   * which agents are ready, which can take seconds: it reads them as the last reading has them.
   */
  async function noteQueued(t, { task, mode, effort, forced, modalities }) {
    const { could, unready } = await pickableNow({ mode, atHand: true })
    const available = [...could.filter((a) => !unready(a)).map((a) => a.id), ...(config.tools ?? []).filter((x) => x.enabled !== false).map((x) => `tool:${x.id}`)]
    const features = replyFeatures({ text: task, modalities, available, mode, level: effort && effort !== 'auto' ? effort : 'auto', decider: t.decider })
    // A task sent to an agent picked by hand has nothing for the router to pick, so nothing to guess.
    const predicted = forced ? null : await ledger.predict(features, available)
    await ledger.note(t.key, { ts: new Date(t.queuedAt).toISOString(), sessionId: t.sessionId, jobId: t.jobId, decider: t.decider, mode, forced, features, predicted })
    return predicted
  }
  /**
   * What a start reply may say of the pick before routing makes it (docs/live-agent-view.md Feature
   * 3): the predictor's guess for the task (`noting`, noteQueued's), once the decider's own record has
   * earned naming it (reply-ledger.js earnedGuess), `quick` for a task that starts at once and
   * `likely` for one that waits its turn, with the record that earned it. The plan it names is worked
   * out as the first attempt would run it (router.js plannedEffort): at the level the person picked in
   * the model menu, else at the default effort in Settings when that is a level, and only with Auto
   * there too at the guessed one, since routing's read of the task sets an Auto level. Null when it is
   * not earned; the guess is awaited only once the gate holds, so a reply that cannot name one never
   * waits for it.
   */
  async function guessFor(t, noting, { startsNow, asked }) {
    const held = await ledger.gates(t.decider)
    if (!(startsNow ? held.quick : held.likely)) return null
    // A guess that could not be noted names nothing; its failure is logged where it is noted.
    const predicted = await noting.catch(() => null)
    const earned = await ledger.earned(t.decider, predicted)
    const record = startsNow ? earned.quick : earned.likely
    const agentDef = record ? (await enabledAgents()).find((a) => a.id === predicted.agent) : null
    if (!agentDef) return null
    const settings = await readEffort()
    const model = modelOf(agentDef) ?? null
    const bands = (t.decider === 'laya' ? LAYA : providers.jev)?.thresholds?.effortBands
    // A level the menu or Settings fixes is the one the first attempt starts at, whatever the guess
    // learned before it was set: handed none, plannedEffort reads the one in Settings.
    const level = asked && asked !== 'auto' ? asked : settings.default && settings.default !== 'auto' ? undefined : predicted.level ?? undefined
    const { effort, level: ran, speed } = plannedEffort({ effort: level, config: { ...config, effort: settings }, agentDef, routing: null, model, bands })
    return { kind: startsNow ? 'quick' : 'likely', plan: { agent: predicted.agent, model, effort, level: ran, speed }, name: nameOfAgent(agentDef), record: { right: record.right, of: record.of } }
  }
  /**
   * What a start reply named, for the reply ledger, once it is out: the agent, effort and model, and
   * how the reply came to name them: `forced` for an agent picked by hand, `routed` for the pick it
   * waited for, `bound` for a reply whose wait for the pick ran out first (C at the bound), `now` for
   * one that went out at once beside a task that starts at once (C with no wait for the pick, or the
   * sentence of work queued behind a direct answer), with nothing waiting, and `waited` for any other
   * that named no plan, whose task waited its turn or which waited for a pick that did not come; with
   * how long after the task was queued. A pick that gives the work to a tool is kept as its reply
   * named it, the tool alone (`tool:<id>`, as noteRan keeps what ran), never the agent that takes
   * over only if the tool fails. A reply that went out once its task had ended is noted as any other:
   * reply A for an agent picked by hand is still `forced`, its plan being kept apart from the follow.
   * A reply that named the predictor's guess before routing picked (`guess`) is noted as it named it,
   * with its model, whatever routing has picked by then: `quick` or `instant` beside a task that starts
   * at once, and `likely` for reply B naming the agent likely to run it.
   */
  function noteSaid(key, { gen = 0, said = null, bound = false, now = false, guess = null } = {}) {
    const t = tasks.byKey(key)
    const forcedPlan = forcedPlans.get(key) ?? null
    forcedPlans.delete(key)
    if (!t) return
    const guessed = GUESSES.includes(guess) && !!said?.agent
    const named = !guessed && gen >= 1 && !!said?.agent
    // The routing's plan the reply named, while it is still the task's.
    const plan = named && !forcedPlan && t.planGen === gen ? t.plan : null
    const words = guessed ? { agent: said.agent, effort: said.effort ?? null, model: said.model ?? null }
      : !named ? { agent: null, effort: null, model: null }
        : forcedPlan ? { agent: said.agent, effort: said.effort ?? null, model: forcedPlan.model ?? null }
          : plan?.tool ? { agent: `tool:${plan.tool}`, effort: null, model: null }
            : { agent: said.agent, effort: said.effort ?? null, model: plan?.model ?? null }
    const how = guessed ? guess : !named ? (bound === true ? 'bound' : now === true ? 'now' : 'waited') : forcedPlan ? 'forced' : 'routed'
    inBackground(ledger.note(key, { said: { ...words, how, ms: Math.max(0, Date.now() - t.queuedAt) } }).catch(ledgerFailed))
  }
  /** What the router ran for a followed task, from its `routed` event: the predictor's guess is scored against it. */
  function noteRan(f, e) {
    const p = e.primary ?? {}
    // With the task type, which a verdict about the pick is stamped with (planOfVerdict), and the level
    // Auto chose before your ratings moved it (`nudged`), which an effort rating of it is read against.
    const ran = e.tool
      ? { agent: `tool:${e.tool}`, level: null, effort: null, model: null, taskType: e.routing?.taskType ?? null }
      : { agent: p.agent ?? e.routing?.primaryAgent ?? null, level: p.level ?? null, effort: p.effort ?? null, model: p.model ?? null, taskType: e.routing?.taskType ?? null, ...(e.nudged?.from ? { unmoved: e.nudged.from } : {}) }
    if (ran.agent) inBackground(ledger.routed(f.key, { ...ran, runId: tasks.byKey(f.key)?.runId ?? null }).catch(ledgerFailed))
  }
  /**
   * GET /jev-router/replies/summary, for the How Jev replies card: how start replies are made now
   * (the wait for the pick they are given, from the Chat replies card, 0 for none), and how long the
   * ones that waited for the pick took this week, until it came or the wait ran out, with how many ran
   * out; how far the intent domain has come toward reading a task on this PC (its verified samples, of
   * each class, and its recent accuracy, against what GUARDED_LOCAL needs); the reply predictor's
   * record per decider against the quick and likely gates, and where each gate stands, on, paused or
   * off (reply-ledger.js gateState); the newest replies, each with how its task ended once it has
   * (`ended`); and each agent's name. Nothing here carries task text.
   */
  async function repliesSummary() {
    const g = gatesFor(policy, 'intent')
    const d = intentDomain()?.state() ?? null
    const ev = d?.lastEvaluation ?? null
    const s = await ledger.summary()
    // A task that ended before routing picked anything, stopped as it waited or read as needing a
    // person, has no `ran` and never will: its final state, or true for one no longer on the task
    // list (only a finished task leaves it), tells it from a task still to be routed, which has null.
    const endedOf = (key) => { const t = key ? tasks.byKey(key) : null; return !t ? true : TERMINAL_STATES.includes(t.state) ? t.state : null }
    return {
      learning: ledgerOn(),
      ...s,
      startReplies: { ...s.startReplies, waitMs: chatReplies.waitMs },
      recent: s.recent.map(({ key, ...r }) => ({ ...r, ended: endedOf(key) })),
      intent: d ? {
        maturity: d.maturity,
        verified: d.samples?.verified ?? 0,
        classes: ev?.classes?.counts ?? {},
        recent: ev?.recent ? { accuracy: ev.recent.accuracy, n: ev.recent.n } : null,
        needs: { samples: g.guardedSamples, perClass: g.perClassSamples, recentAccuracy: g.guarded.recentAccuracy },
      } : null,
      names: await agentNamesNow(),
    }
  }

  const orchestrator = {
    /** Unread finished results for this session, in the order they finished. */
    results: (sessionId) => tasks.results(sessionId),
    /** How much is still in flight here, so a notice turn can say something true. */
    live: (sessionId) => tasks.list().filter((t) => t.sessionId === sessionId && !TERMINAL_STATES.includes(t.state)).length,
    /** The result is being rendered now; still unread until delivered(). */
    delivering: (jobId) => tasks.delivering(jobId),
    /** The result's message was accepted: stop offering it. */
    delivered: (jobId) => tasks.delivered(jobId),
    /**
     * Queue one chat task, or return null when background jobs are unavailable. Returns what the start
     * reply needs (adapter.js startReply): `line`, the reply to give without waiting for the pick (A
     * for a forced agent, whose plan is known now, B for a task that waits its turn, C for one that
     * starts at once), `jobId`, `key`, `runId` once its run has begun, `startsNow`, `forcedPlan` (the
     * agent, model and effort a forced agent runs with), the chat replies settings' `waitMs` and
     * `progress`, where it `waiting`s, and the read-only `access` verdict; and, once the predictor's
     * record has earned naming its guess (guessFor), `quick`, the guessed plan a task that starts at
     * once is told before routing picks, with that record, or `likely`, the agent B names as likely.
     */
    // `modalities` rides along: dropped here the task record falls back to text, the capability
    // filter stops requiring image support, and an attached picture reaches an agent that is blind to it.
    async enqueue({ agent, task, effort, forceAgent, mode, sessionId, modalities }) {
      // The adapter's second argument: `decider`, the row's, kept on the task so it decides the run
      // whenever it starts; `why`, the reason a message the decider could not sort was queued as a
      // task, said in the reply; `readVerdict`, the decider's verdict on whether the message only
      // reads the project (adapter.js readOnlyVerdict); `intentSample`, the sample the message
      // was recorded as (intent.js), which the task and each run of it carry; and `message`, the
      // person's own words, which the reply ledger reads of the message, where `task` is what the
      // agent is sent, with the line that hands it a picture first. Read from `arguments` so this
      // signature stays the one test/tasks.test.js checks the task's own fields against.
      const { decider = 'jev', why, readVerdict = null, intentSample = null, message = null } = arguments[1] ?? {}
      const cwd = agent?.session?.header?.cwd
      if (!cwd) throw new Error('cannot determine the session workspace; open a workspace first')
      if (inScratch(cwd)) throw new Error(SCRATCH_ONLY)
      await chatRepliesRead
      // A task judged read only runs as a read pass only when some agent this run could pick can be
      // locked against writing now; otherwise it waits in its workspace's line, and says why. The
      // verdict is kept either way: set against what the task changed, it is how the bars are judged.
      let access = 'write'
      let accessWhy = null
      if (readVerdict?.reads) {
        // Only agents that could run it now: any other lock is no promise, and the read pass would
        // only hand it back.
        const { on, could, unready } = await pickableNow({ mode, forceAgent })
        logReadOnly(on)
        const images = (modalities ?? []).includes('image')
        const locks = could.map((a) => (unready(a) ? { id: a.id, lock: null, why: unready(a) } : { id: a.id, ...lockFor(a, agent, { images }) }))
        if (locks.some((l) => l.lock)) access = 'read'
        else accessWhy = `no agent here can be locked against writing (${locks.map((l) => `${l.id}: ${l.why}`).join('; ') || (on.length ? 'none of the agents switched on may take this task' : 'no agent is switched on')})`
      }
      // sessionId comes from the caller that will also read the results back.
      const t = tasks.enqueue({ owner: agent, sessionId: sessionId ?? sessionIdOf(agent) ?? cwd, workspace: cwd, task, forceAgent, effort, mode, decider, modalities, readVerdict, access, accessWhy, intentSample })
      if (!t) return null
      // Followed before anything is awaited: its router events start at the next microtask.
      const replies = chatReplies
      follow(t, { owner: agent, decider: t.decider, asked: effort, waitMs: replies.waitMs })
      const noting = ledgerOn() ? noteQueued(t, { task: message ?? task, mode, effort, forced: !!forceAgent, modalities }) : null
      if (noting) inBackground(noting.catch(ledgerFailed))
      // Read from the line the task joined as it was queued (tasks.enqueue starts its runner, which
      // joins before enqueue returns), which counts every run holding or waiting for it, a foreground
      // one as much as a task. A read task's own lane is read the same way: it waits only for a slot.
      const waiting = tasks.get(t.jobId)?.waiting ?? null
      const facts = { jobId: t.jobId, workspace: cwd, decider: t.decider, why, progress: replies.progress, ...(readVerdict ? { access: { mode: t.access, verdict: readVerdict, why: accessWhy } } : {}) }
      // The task is queued now, so nothing from here on may fail the reply: a forced agent's plan that
      // cannot be worked out (its agent list unreadable for a moment) is left out, and the reply is the
      // one a task with no plan yet gets. An error here would say nothing was queued, and a person who
      // sent the task again would run it twice.
      const forced = forceAgent
        ? await forcedPlanOf(forceAgent, { effort, decider: t.decider }).catch((err) => { process.stdout.write(`[jev] plan for ${t.jobId}'s reply not worked out: ${err?.message ?? err}\n`); return null })
        : null
      // What reply A names, for the reply ledger's note of what it said once it is out (noteSaid).
      if (forced && ledgerOn()) {
        for (const k of forcedPlans.keys()) if (!tasks.byKey(k)) forcedPlans.delete(k)
        forcedPlans.set(t.key, forced.plan)
      }
      // A guess at the pick the decider's record has earned naming (guessFor): the plan a task that
      // starts at once is told before routing picks (`quick`, which the adapter words), or the agent a
      // task that waits its turn is told is likely to run it, in reply B itself. None for a forced agent.
      const guess = noting && !forceAgent
        ? await guessFor(t, noting, { startsNow: !waiting, asked: effort }).catch((err) => { process.stdout.write(`[jev] guess for ${t.jobId}'s reply not worked out: ${err?.message ?? err}\n`); return null })
        : null
      const likely = waiting && guess?.kind === 'likely' ? guess : null
      const line = forced ? planReply({ ...facts, ...forced.words, waiting, credit: forced.credit })
        : waiting ? queuedReply({ ...facts, waiting, likely: likely ? { agent: likely.name, effort: likely.plan.effort, speed: likely.plan.speed } : null })
          : startingReply(facts)
      return {
        line, jobId: t.jobId, key: t.key, runId: tasks.get(t.jobId)?.runId ?? null, startsNow: !waiting, forcedPlan: forced?.plan ?? null,
        waitMs: replies.waitMs, progress: replies.progress, waiting, access: facts.access ?? null,
        // What a reply that names the guess says of it once it is out (noteAck): its plan, and the
        // record that earned it.
        ...(!waiting && guess?.kind === 'quick' ? { quick: { plan: guess.plan, record: guess.record } } : {}),
        ...(likely ? { likely: { agent: likely.plan.agent, effort: likely.plan.effort ?? null, model: likely.plan.model ?? null } } : {}),
      }
    },
    /**
     * Wait for the router's pick for the task with this key, at most `waitMs` (the setting's), telling
     * `onLine` each router line meanwhile. Resolves with the plan once picked ({ plan, gen, runId, ms,
     * steps, decidedBy }: planned()), with `{ handedBack, waiting, why }` when a read pass
     * hands the task back to its folder's line first, with `{ settled }` when it ends first (a run the
     * router stops for a person picks no agent, and so ends first), and with null at the bound, on
     * Stop, or for a key that names no task. It lets go of the task in every case.
     */
    watchPlan(key, { signal, waitMs = chatReplies.waitMs, onLine } = {}) {
      return new Promise((resolve) => {
        let over = false
        let timer = null
        let off = () => {}
        const end = (value) => {
          if (over) return
          over = true
          clearTimeout(timer)
          off()
          signal?.removeEventListener('abort', stop)
          resolve(value)
        }
        const stop = () => end(null)
        const seen = tasks.byKey(key)
        if (!seen) return end(null)
        if (TERMINAL_STATES.includes(seen.state)) return end({ settled: seen.state })
        // Handed back or picked before the wait began: said at once.
        if (seen.requeuedAt) return end({ handedBack: true, waiting: seen.waiting ?? null, why: seen.accessWhy ?? null })
        const f = following.get(key)
        if (seen.plan && f?.routed) return end(planned(f, seen))
        if (signal?.aborted) return end(null)
        off = tasks.watch(key, (e, now) => {
          if (e.type === 'settled') return end({ settled: e.state })
          // Handed back by its read pass: where it stands is read once it has joined its folder's line,
          // which runAdmitted does as the pass's end unwinds, so a task that waits is not said to start.
          if (e.type === 'access' && e.mode === 'write') {
            off()
            return setImmediate(() => end({ handedBack: true, waiting: tasks.byKey(key)?.waiting ?? null, why: e.why ?? null }))
          }
          try { onLine?.(e.text ?? line(e)) } catch { /* the reply's lines are its own; the task goes on */ }
          // A run the router stops for a person has no agent to name: the wait goes on to its end,
          // which follows at once, so the reply says it ended rather than what would have run.
          if (e.type === 'routed' && !e.stopsForPerson) end(planned(following.get(key) ?? { calledBefore: false }, now, e))
        })
        timer = setTimeout(stop, Math.max(0, waitMs))
        timer.unref?.()
        signal?.addEventListener('abort', stop, { once: true })
      })
    },
    /**
     * The run the task with this key has begun, or null. A start reply written after the task was
     * queued carries it: `enqueue` answers before a task that starts at once has reached its run.
     */
    runOf: (key) => tasks.byKey(key)?.runId ?? null,
    /**
     * What the start reply named of a task, once it is out (tasks.js noteAck): a notice may be due
     * now, and the reply ledger keeps what it said. A reply that goes out once its task has ended,
     * as one whose wait for the pick ended with it (read as needing a person, stopped, failed) or
     * reply A for an agent that refused the task at once, is kept in the ledger all the same, though
     * no notice is due. False for a task no longer waiting or running.
     */
    noteAck(key, ack) {
      const live = tasks.noteAck(key, ack)
      if (live) { const f = following.get(key); if (f) noticeDue(f) }
      if (ledgerOn()) noteSaid(key, ack)
      return live
    },
    /** One sentence of what this chat's tasks are doing now, for a question answered directly; '' when nothing is. */
    async liveStatus(sessionId) {
      const live = tasks.list().filter((t) => t.sessionId === sessionId && !TERMINAL_STATES.includes(t.state))
      return live.length ? liveStatusSentence(live, await agentNamesNow()) : ''
    },
    /**
     * The task `jobId` of this chat as the list shows it, or null. The newest is taken: the engine hands
     * a job id out again after a restart, and the older task under it is the one that has ended.
     */
    taskOf: (sessionId, jobId) => tasks.list().findLast((t) => t.sessionId === sessionId && t.jobId === jobId) ?? null,
    /** Send now for the task with this key (startTaskNow). */
    startNow: (key, options) => startTaskNow(key, options),
    /** Steer the task with this key with the person's words (steerTask). */
    steer: (key, options) => steerTask(key, options),
  }

  // --- Send now and Steer (docs/live-agent-view.md Feature 5) ---------------------------------------
  // The routes, the /now and /steer commands and the adapter's `@jev-5 <words>` all come here, so each
  // says the same thing of the same outcome (reply-words.js). Words for a task at work reach the agent
  // at work where its provider takes them mid-run (steer.js), and every prompt its run builds after
  // carries them (router.js withGuidance); what becomes of each piece is noted on its task.

  /** Who holds a local model for run `runId`, as a wait for it names it: its task, else another run. */
  const holderOf = (runId) => tasks.byKey(steerRuns.get(runId)?.key)?.jobId ?? 'another run'

  /** The run a task at work is on now, its last pass's: the one its words go to. */
  const runOfTask = (t) => (Array.isArray(t?.runIds) && t.runIds.length ? t.runIds.at(-1) : t?.runId ?? null)

  /**
   * What Steer does now with words for the task at work `t` (tasks.js view().controls.steer): the
   * agent at work takes them (`path`), or why they wait for its next attempt (`why`), whether its
   * dialog can send them (`sendable`), and the words it says so in. With none that takes them at
   * work, why is read off where its run stands and the attempt it has at work: an agent's review or
   * a configured tool takes no words either.
   */
  function steerFacts(t) {
    const runId = runOfTask(t)
    const entry = runId ? steerers.of(runId) : null
    const claudeSteer = liveSettings.claudeSteer === true
    const way = livePath(entry, { claudeSteer })
    const going = !!runId && steerRuns.has(runId)
    const atWork = !entry && going ? live.atWorkOf(runId) : null
    const why = way.why === 'idle' ? idleWhy(going ? live.phaseOf(runId) : 'ending', atWork) : way.why
    const name = entry?.name ?? atWork?.name ?? null
    // Send now (slice 10): whether the agent at work can be stopped for the words now, and if not why,
    // read off where the run stands as Steer's is while none is at work.
    const stop = nowPath(entry, { claudeSteer })
    const nowWhy = stop.why === 'idle' ? why : stop.why
    return {
      path: way.path, why, agent: entry?.agentId ?? atWork?.agent ?? null, name, sendable: sendableWhy(way.path, why), words: way.path ? liveWords(name, way.path) : heldWords({ jobId: t.jobId, why, name }),
      now: { path: stop.path, why: stop.path ? null : nowWhy, words: stop.path ? nowWords(name) : nowHeldWords({ jobId: t.jobId, why: nowWhy, name }) },
    }
  }

  /**
   * Say a piece of guidance as it is now on the run it went to: its live view's bubble and its log's
   * line. `replacing` says Send now is stopping the step at work for it (true) or could not (false),
   * so the live view reads the step it ends as replaced by the person's message.
   */
  function sayGuidance(run, s, { replacing = null } = {}) {
    if (!run || !s) return
    try {
      run.say({ type: 'steer', at: Date.now(), id: s.id, guidance: s.text, state: s.state, ...(s.how ? { how: s.how } : {}), ...(replacing === null ? {} : { replacing }), ...(Number.isInteger(s.attempt) ? { attempt: s.attempt } : {}), name: s.name ?? null, ...(s.readAt ? { readAt: s.readAt } : {}), ...(s.to ? { to: s.to } : {}), words: steerStateWords(s) })
    } catch { /* the live view's own */ }
  }

  /** Move the piece of guidance `s` of the task with this key by `event` (steer.js nextState): noted on the task, and said on its run. */
  function moveSteer(run, key, s, event, patch = {}) {
    const state = nextState(s.state, event)
    if (state === s.state) return s
    const now = tasks.noteSteer(key, s.id, { ...patch, state })
    sayGuidance(run, now)
    return now
  }

  /**
   * The agent at work in run `runId` took in the message `id`: a piece of guidance sent to it is read,
   * and so are the steers a Send now gave back from its inbox to go with it (`foldedInto`).
   */
  function steerHeard(runId, id) {
    if (typeof id !== 'string' || !id) return
    try {
      const run = steerRuns.get(runId)
      const steers = run ? tasks.byKey(run.key)?.steers ?? [] : []
      const s = steers.find((x) => x?.id === id && (x.how === 'live' || x.how === 'now'))
      if (!s) return
      const at = Date.now()
      moveSteer(run, run.key, s, 'read', { readAt: at })
      if (s.how === 'now') for (const x of steers) if (x?.foldedInto === id) moveSteer(run, run.key, x, 'read', { readAt: at })
    } catch (err) { process.stdout.write(`[jev] a steer read by its agent was not noted: ${err.message}\n`) }
  }

  /**
   * What a connector's hook says became of the message `id` it was given (the engine patch's
   * `onOutcome`): Claude Code read it ('delivered') or closed its input without saying ('unknown'),
   * and Codex went on with a Send now's words as its next turn ('continued'), which is reading them.
   */
  function steerOutcome(runId, id, outcome) {
    if (outcome === 'delivered' || outcome === 'continued') return steerHeard(runId, id)
    if (outcome !== 'unknown' || typeof id !== 'string') return
    try {
      const run = steerRuns.get(runId)
      const s = run ? tasks.byKey(run.key)?.steers?.find((x) => x?.id === id && (x.how === 'live' || x.how === 'now')) : null
      if (s) moveSteer(run, run.key, s, 'unsure')
    } catch (err) { process.stdout.write(`[jev] what became of a steer was not noted: ${err.message}\n`) }
  }

  /** Attempt `attempt` of run `runId` has ended: the words Send now gave it that its agent never took in were not used (steer.js nowLeft). */
  function endNow(runId, attempt) {
    try {
      const run = steerRuns.get(runId)
      for (const s of run ? nowLeft(tasks.byKey(run.key)?.steers, { runId, attempt }) : []) moveSteer(run, run.key, s, 'ended', { endedAt: Date.now() })
    } catch (err) { process.stdout.write(`[jev] a Send now its agent never took in was not noted: ${err.message}\n`) }
  }

  /** Ask a patched Claude Code run to show its thinking as `display` says; one that cannot is said in the log and runs on as it was. */
  function askThinking(control, display, agentId) {
    const failed = (err) => process.stdout.write(`[jev] ${agentId} keeps its own thinking display: ${err?.message ?? err}\n`)
    try { Promise.resolve(control?.thinkingDisplay?.(display)).catch(failed) } catch (err) { failed(err) }
  }

  /**
   * A prompt of run `runId` carried a piece of guidance no agent had read to the next attempt (a
   * `steer` event of router.js): noted on the task with the agent it went to, by name, which the event
   * the live view and the log hear says too.
   */
  function carriedSteer(runId, e) {
    const run = steerRuns.get(runId)
    const s = run ? tasks.byKey(run.key)?.steers?.find((x) => x?.id === e.id) : null
    if (!s) return e
    const to = { agent: e.to?.agent ?? null, name: run.names[e.to?.agent] ?? e.to?.agent ?? null, role: e.to?.role ?? null }
    const now = nextState(s.state, 'carried') === s.state ? s : tasks.noteSteer(run.key, s.id, { state: 'carried', to, carriedAt: Date.now() })
    return { ...e, ...(Number.isInteger(s.attempt) ? { attempt: s.attempt } : {}), state: now.state, to: now.to ?? to, name: now.name ?? null, words: steerStateWords(now) }
  }

  /**
   * Run `runId` of the task with this key has ended: its guidance no agent had read was not used, a
   * Send now its agent refused included (the other words Send now gave were moved as their attempt
   * ended, endNow).
   */
  function endGuidance(runId, key) {
    const run = steerRuns.get(runId)
    for (const s of tasks.byKey(key)?.steers ?? []) if ((s?.how === 'live' || s?.how === 'now') && s.state === 'pending') moveSteer(run, key, s, 'ended', { endedAt: Date.now() })
  }

  /**
   * Words for the task at work `t`, noted on it, and sent to the agent at work where its provider
   * takes them mid-run; otherwise, or when it refuses them, they wait for its next attempt, whose
   * prompt carries them. Answers `{ result: 'sent' | 'pending', state, id, words }`, or null for a
   * task that has ended, which takes no more words (tasks.js noteSteer).
   */
  async function steerLive(t, words, names) {
    const runId = runOfTask(t)
    const run = runId ? steerRuns.get(runId) : null
    const entry = runId ? steerers.of(runId) : null
    const facts = steerFacts(t)
    const s = tasks.noteSteer(t.key, randomUUID(), { text: words, how: 'live', state: 'pending', runId, ...(entry ? { attempt: entry.attempt, agent: entry.agentId, name: entry.name } : {}) })
    if (!s) return null
    // The task's record keeps the words clipped; the agent at work and every prompt built after them
    // have them whole.
    if (s.text !== words) steerTexts.set(s.id, words)
    sayGuidance(run, s)
    const agent = entry?.agentId ?? facts.agent ?? null
    const named = entry ? { ...names, [entry.agentId]: entry.name } : names
    const answer = (result, why = null, path = null) => ({ result, state: tasks.byKey(t.key)?.steers?.find((x) => x?.id === s.id)?.state ?? s.state, id: s.id, words: steerWords({ jobId: t.jobId, result, agent, names: named, why, path }) })
    if (!facts.path) return answer('pending', facts.why)
    const sent = await sendLive(entry, facts.path, { id: s.id, text: words })
    if (sent.sent) return answer('sent', null, facts.path)
    process.stdout.write(`[jev] ${entry.name} did not take the steer for ${t.jobId} now (${sent.why}); it goes with the next attempt\n`)
    return answer('pending', 'refused')
  }

  /**
   * The work attempt of run `runId` has just started its agent (runAgent). Words given to its task
   * after the attempt's prompt was built, while it waited to start (for another task's local model, a
   * speed run), took no attempt and are in no prompt: they go to this agent now, as they would have
   * had it been at work (steerLive). An agent that takes no words mid-run, or refuses them, leaves
   * them for the next attempt, as before.
   */
  function steerOnStart(runId) {
    try {
      const run = steerRuns.get(runId)
      const entry = steerers.of(runId)
      const t = run ? tasks.byKey(run.key) : null
      const way = livePath(entry, { claudeSteer: liveSettings.claudeSteer === true })
      if (!t || !way.path) return
      const waiting = (t.steers ?? []).filter((s) => s?.how === 'live' && s.state === 'pending' && s.runId === runId && !Number.isInteger(s.attempt))
      for (const s of waiting) {
        // Still `pending`, which its bubble already says: only the attempt and agent it went to are new.
        tasks.noteSteer(run.key, s.id, { attempt: entry.attempt, agent: entry.agentId, name: entry.name })
        sendLive(entry, way.path, { id: s.id, text: steerTexts.get(s.id) ?? s.text }).then((sent) => {
          if (!sent.sent) process.stdout.write(`[jev] ${entry.name} did not take the steer for ${t.jobId} as it started (${sent.why}); it goes with the next attempt\n`)
        })
      }
    } catch (err) { process.stdout.write(`[jev] the words given before an agent started were not sent to it: ${err.message}\n`) }
  }

  /**
   * Send now for the task at work `t` (slice 10): its agent stops its current step and takes the
   * words as what it does next (steer.js sendNow), noted on the task with `how: 'now'`. Where nothing
   * can be stopped for them it answers `not-now` with why and notes nothing, so the words stay with
   * the person for Steer's other choices; an agent that refuses them leaves them for the next attempt
   * (`refused`), as a refused steer does. A spawn child's steers it has not taken in go with the
   * words, ahead of them, and are read when they are. Answers `{ result: 'replaced' | 'pending' |
   * 'not-now', state, id, words }`, or null for a task that has ended.
   */
  async function steerNow(t, words, names) {
    const runId = runOfTask(t)
    const run = runId ? steerRuns.get(runId) : null
    const entry = runId ? steerers.of(runId) : null
    const facts = steerFacts(t)
    const named = entry ? { ...names, [entry.agentId]: entry.name } : names
    const agent = entry?.agentId ?? facts.agent ?? null
    if (!facts.now.path) return { result: 'not-now', state: null, words: steerWords({ jobId: t.jobId, result: 'not-now', agent, names: named, why: facts.now.why }) }
    const s = tasks.noteSteer(t.key, randomUUID(), { text: words, how: 'now', state: 'pending', runId, attempt: entry.attempt, agent: entry.agentId, name: entry.name })
    if (!s) return null
    if (s.text !== words) steerTexts.set(s.id, words)
    const unclaimed = (tasks.byKey(t.key)?.steers ?? []).filter((x) => x?.how === 'live' && x.state === 'pending' && x.runId === runId && x.attempt === entry.attempt).map((x) => ({ id: x.id, text: steerTexts.get(x.id) ?? x.text }))
    // Said before the step is stopped, so the live view reads the step it ends as replaced.
    sayGuidance(run, s, { replacing: true })
    const answer = (result, why = null) => ({ result, state: tasks.byKey(t.key)?.steers?.find((x) => x?.id === s.id)?.state ?? s.state, id: s.id, words: steerWords({ jobId: t.jobId, result, agent, names: named, why }) })
    const sent = await sendNow(entry, facts.now.path, { id: s.id, text: words, unclaimed })
    if (sent.sent) {
      for (const id of sent.folded) tasks.noteSteer(t.key, id, { foldedInto: s.id })
      return answer('replaced')
    }
    process.stdout.write(`[jev] ${entry.name} could not be stopped for the words sent now to ${t.jobId} (${sent.why}); they go with the next attempt\n`)
    sayGuidance(run, tasks.noteSteer(t.key, s.id, { refused: true }) ?? s, { replacing: false })
    return answer('pending', 'refused')
  }

  /**
   * Send now: start the waiting task with this key at once (tasks.js startNow), and what came of it in
   * words. `stop` names the task holding its folder, stopped for it (Stop it and start this). Answers
   * `{ result, holder, words }`, `holder` the task in the folder's way, if one is.
   */
  async function startTaskNow(key, { stop = null } = {}) {
    await tasks.ready
    const t = tasks.byKey(key)
    if (!t) throw Object.assign(new Error('no task with that key'), { status: 404 })
    const before = t.controls ?? {}
    const result = tasks.startNow(key, stop ? { stop } : {})
    // Over the cap when every slot was in use already, as the dialog said before it was confirmed.
    const over = result === 'started' && before.max != null && before.held >= before.max
    const holder = result === 'stopping' ? stop : tasks.byKey(key)?.controls?.holder ?? before.holder ?? null
    return { result, holder, words: startNowWords({ jobId: t.jobId, result, workspace: t.workspace, holder, over, max: before.max ?? null }) }
  }

  /**
   * Steer the task with this key with the person's words. `how`: 'amend' adds them to a task that has
   * not started; 'live' gives them to a task at work (steerLive); 'now' stops the step a task at work
   * is on and gives them to it as what it does next (steerNow); 'follow-up' queues them as a task of
   * their own in its folder, on the agent it works on, first in line; 'restart' stops a task at work
   * and starts it again with them, on the same agent, first in line and the moment the folder is free;
   * 'auto' amends a task that has not started and gives them to one at work. `via` words the answer
   * for `@jev-5` ('@') or the rest ('steer'). Answers `{ result, state, words }`, `state` the words'
   * on the task ('added', 'pending', or null), with the `jobId` and `key` of a task it queued, or the
   * `id` of a piece given to a task at work.
   */
  async function steerTask(key, { text, how = 'auto', via = 'steer' } = {}) {
    await tasks.ready
    // The agents' names are read first, from disk: the task is read after them, with nothing awaited
    // between that and what is done with the words, so a task that ends meanwhile is taken as ended.
    const names = await agentNamesNow().catch(() => ({}))
    const t = tasks.byKey(key)
    if (!t) throw Object.assign(new Error('no task with that key'), { status: 404 })
    if (!['auto', 'amend', 'live', 'now', 'follow-up', 'restart'].includes(how)) throw Object.assign(new Error('how: auto, amend, live, now, follow-up or restart'), { status: 400 })
    const words = typeof text === 'string' ? text.trim() : ''
    if (!words) throw Object.assign(new Error('text: the words to send'), { status: 400 })
    // A forced agent takes the words with the task; otherwise its decider picks the agent with them.
    const basis = tasks.queuedWith(key)
    const said = (result) => ({ result, state: result === 'added' ? 'added' : null, words: steerWords({ jobId: t.jobId, result, via, decider: t.decider, agent: t.state === 'queued' ? basis?.agent ?? null : null, names }) })
    const ended = TERMINAL_STATES.includes(t.state)
    if (how === 'amend' || (how === 'auto' && (t.state === 'queued' || ended))) return said(tasks.amend(key, words))
    if ((how === 'live' || how === 'now') && ended) return said('already-finished')
    if (t.state === 'queued') return said('not-started')
    if (how === 'auto' || how === 'live') return (await steerLive(t, words, names)) ?? said('already-finished')
    if (how === 'now') return (await steerNow(t, words, names)) ?? said('already-finished')
    if (how === 'restart' && ended) return said('already-finished')
    if (!basis) return said('no-owner')
    const restart = how === 'restart'
    const next = tasks.enqueue({
      owner: basis.owner, sessionId: basis.sessionId, workspace: basis.workspace, mode: basis.mode, decider: basis.decider,
      task: restart ? restartTask({ task: basis.task, jobId: t.jobId, text: words }) : followUpTask({ jobId: t.jobId, text: words }),
      forceAgent: basis.agent ?? undefined,
      // A fresh start runs as the task was asked for: its effort, and its pictures handed over again.
      effort: restart ? basis.effort ?? undefined : undefined,
      modalities: restart ? basis.modalities : ['text'],
    })
    if (!next) return said('unavailable')
    // No start reply goes out for it, so its started notice is what tells the chat it began.
    follow(next, { owner: basis.owner, decider: next.decider, asked: restart ? basis.effort : null, waitMs: 0 })
    // First in its folder's line: only the task at work there goes before it.
    if (tasks.get(next.jobId)?.waiting) tasks.reorder(basis.workspace, [next.jobId])
    if (restart) {
      // It takes the folder the moment the stopped task lets it go, whatever the cap; a task at work
      // that holds no folder line of its own (a read pass) is stopped all the same.
      const why = restartedReason(next.jobId)
      if (tasks.startNow(next.key, { stop: t.jobId, why }) !== 'stopping') tasks.stop(t.jobId, { why })
    }
    const result = restart ? 'restarting' : 'queued'
    const waiting = !!tasks.get(next.jobId)?.waiting
    return { result, state: null, jobId: next.jobId, key: next.key, words: steeredTaskWords({ jobId: t.jobId, newJobId: next.jobId, result, workspace: basis.workspace, agent: basis.agent, names, waiting }) }
  }

  /** The task key a request names, or a 400. */
  const taskKeyIn = (body) => {
    if (typeof body?.key !== 'string' || !/^[\w-]{1,80}$/.test(body.key)) throw Object.assign(new Error('key: a task key'), { status: 400 })
    return body.key
  }

  // `/now jev-5` and `/steer jev-5 <words>`: the same as the buttons, for this chat's task by its id.
  const taskRef = (agent, jobId) => orchestrator.taskOf(sessionIdOf(agent), jobId)
  ctx.commands.register({
    name: 'now',
    description: 'Start a waiting background task now, ahead of its line and over Tasks at once if need be, e.g. /now jev-5',
    input: { hint: '<task id>' },
    handler: async ({ agent, rawInput }) => {
      const jobId = rawInput.trim().toLowerCase()
      if (!/^jev-\d+$/.test(jobId)) return { kind: 'error', text: 'Usage: /now <task id>, e.g. /now jev-5' }
      const t = taskRef(agent, jobId)
      if (!t) return { kind: 'error', text: noTaskWords(jobId) }
      try {
        const r = await startTaskNow(t.key)
        return { kind: r.result === 'started' ? 'success' : 'error', text: r.words }
      } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
    },
  })
  ctx.commands.register({
    name: 'steer',
    description: 'Give a background task your words: added before it starts, or to the agent at work, e.g. /steer jev-5 also update the README',
    input: { hint: '<task id> <words>' },
    handler: async ({ agent, rawInput }) => {
      const [, ref, text] = /^\s*(\S+)\s*([\s\S]*)$/.exec(rawInput ?? '') ?? []
      const jobId = String(ref ?? '').toLowerCase()
      if (!/^jev-\d+$/.test(jobId) || !text?.trim()) return { kind: 'error', text: 'Usage: /steer <task id> <words>, e.g. /steer jev-5 also update the README' }
      const t = taskRef(agent, jobId)
      if (!t) return { kind: 'error', text: noTaskWords(jobId) }
      try {
        const r = await steerTask(t.key, { text, how: 'auto' })
        return { kind: ['added', 'sent', 'pending'].includes(r.result) ? 'success' : 'error', text: r.words }
      } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
    },
  })

  ctx.commands.register({
    name: 'use',
    description: 'Switch on exactly these agents, e.g. /use claude ds, /use gpt, /use all (aliases: gpt/chatgpt = codex, ds = deepseek, cc = claude)',
    input: { hint: '<agents…> | all' },
    handler: async ({ rawInput }) => {
      try {
        const on = await useOnly(parseUse(rawInput, await switchable()))
        return { kind: 'success', text: `Agents on: ${on.join(', ')}` }
      } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
    },
  })

  // Slash commands: /auto lets Jev choose; /<agent-id> forces that agent (post-review still runs).
  // Local models from the chat. A bare /install-llm or /remove-llm opens the picker in the browser
  // (client.js decorates these commands); these server handlers serve the typed forms and any client without the picker.
  ctx.commands.register({
    name: 'install-llm',
    description: 'Install a local model (llama.cpp, runs on this PC, works offline). Bare: picker with suggestions for this PC',
    input: { hint: '[id… | all]' },
    handler: async ({ rawInput }) => {
      try { return await installLlmCommand(rawInput, { local, catalog }) } catch (err) { return { kind: 'error', text: `install-llm: ${err.message}` } }
    },
  })
  ctx.commands.register({
    name: 'remove-llm',
    description: 'Remove an installed local model or the engine. Bare: picker; typed form asks you to repeat it with "confirm"',
    input: { hint: '[id…] [confirm]' },
    handler: async ({ rawInput }) => {
      try { return await removeLlmCommand(rawInput, { local }) } catch (err) { return { kind: 'error', text: `remove-llm: ${err.message}` } }
    },
  })

  ctx.commands.register({
    name: 'auto',
    description: 'Jev routes this task to the best agent, verifies, and reviews the result',
    input: { hint: '<task>' },
    handler: async ({ agent, rawInput, signal }) => {
      const task = rawInput.trim()
      if (!task) return { kind: 'error', text: 'Usage: /auto <task>' }
      try { return { kind: 'success', text: await route({ task, agent, signal }) } } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
    },
  })
  // One task to Laya from any session, a Jev Auto one included, for testing both together (2.4).
  // When Laya cannot be asked it answers with the same reply Laya Auto gives.
  ctx.commands.register({
    name: 'laya',
    description: 'Laya, the decision model on this PC, routes this task and reviews the result instead of Jev',
    input: { hint: '<task>' },
    handler: async ({ agent, rawInput, signal }) => {
      const task = rawInput.trim()
      if (!task) return { kind: 'error', text: 'Usage: /laya <task>' }
      try { return { kind: 'success', text: await route({ task, agent, signal, decider: 'laya' }) } } catch (err) {
        return { kind: 'error', text: err instanceof LayaUnavailable ? err.message : `jev-router: ${err.message}` }
      }
    },
  })
  for (const a of config.agents.filter((x) => x.enabled)) {
    ctx.commands.register({
      name: a.id,
      description: `Run this task on ${a.id} (manual override); Jev still reviews the result`,
      input: { hint: '<task>' },
      handler: async ({ agent, rawInput, signal }) => {
        const task = rawInput.trim()
        if (!task) return { kind: 'error', text: `Usage: /${a.id} <task>` }
        try { return { kind: 'success', text: await route({ task, agent, forceAgent: a.id, signal }) } } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
      },
    })
  }

  if (config.registerTool) {
    ctx.tools.register({
      name: 'jev_route',
      description: 'Hand a coding task to the Jev router. Jev picks Claude Code, Codex or DeepSeek, the agent works in the current workspace, tests/typecheck/lint/build run, and Jev assesses the result. Returns a structured report. Pass the user\'s request verbatim.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The user\'s request, verbatim.' },
          agent: { type: 'string', enum: ['auto', ...config.agents.filter((x) => x.enabled).map((x) => x.id)], description: 'Leave as auto unless the user named an agent.' },
        },
        required: ['task'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const forceAgent = args.agent && args.agent !== 'auto' ? args.agent : undefined
        return await route({ task: args.task, agent: exec.agent, forceAgent, signal: exec.signal })
      },
    })
  }

  // Models the setup page offers for new BYOK agents: everything in Settings -> Models except Jev itself.
  let llm = null
  // The engine's agents, for the capability benchmark's look-up of the chat it starts from.
  let agentsApi = null
  async function modelProviders() {
    if (!llm) return []
    const out = []
    for (const p of llm.listProviders().filter((x) => x.id !== JEV_PROVIDER)) {
      const models = await llm.listModels(p.id).catch(() => [])
      if (models.length) out.push({ id: p.id, name: p.name ?? p.id, models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) })
    }
    return out
  }

  const knownProviders = async () => ['deepseek', 'jev', ...(await modelProviders()).map((p) => p.id)]

  // What a model really takes, asked of the catalog it is registered with: the same
  // declaration the engine's own gate reads, so the picker and the gate cannot disagree.
  async function canSeeImages(m) {
    if (!m?.provider || !m?.model) return false
    const info = await llm?.resolveModel?.(m.provider, m.model).catch(() => null)
    return info?.inputModalities?.includes('image') === true
  }
  // Claude Code and Codex own their tool loop, so they open an image file we name. Every other
  // agent is an in-process model, which reads an image only when that model itself accepts one.
  const OWNS_IMAGE_READING = new Set(['claude-code', 'codex'])
  const agentSeesImages = async (agentId) => {
    const a = (await enabledAgents().catch(() => [])).find((x) => x.id === agentId)
    if (!a) return false
    return OWNS_IMAGE_READING.has(a.provider) || await canSeeImages(a.llm)
  }
  /**
   * Attached image bytes, for an agent that cannot be handed content blocks: written where the
   * agent's own tools can open them, so the path can travel in the prompt. Under the workspace's
   * .kz-harness folder - already git-excluded locally, and already never counted as a change an
   * agent made - so a sandboxed agent reads it as an ordinary project file.
   */
  async function handOffImages(refs, { cwd } = {}) {
    const store = ctx.get?.('attachments')
    if (!store || !cwd || !refs?.length) return []
    const dir = join(cwd, '.kz-harness', 'attachments')
    await mkdir(dir, { recursive: true })
    const out = []
    for (const ref of refs) {
      const img = await store.readImageRequest(ref, { maxPixels: 4_000_000, maxBytes: 8_000_000 }, AbortSignal.timeout(20_000))
      const ext = String(img.mediaType).split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
      const name = String(ref.attachmentId ?? randomUUID()).replace(/[^\w.-]/g, '')
      const file = join(dir, `${name || randomUUID()}.${ext}`)
      await writeFile(file, img.data)
      out.push(file)
    }
    return out
  }

  // Display names for the browser half: providers and models from the live catalog,
  // agents from their own config entry. No table of names in the client, so a new
  // provider, model or agent names itself everywhere it is shown.
  async function displayNames() {
    const providers = { jev: 'Jev' }
    const models = {}
    for (const p of await modelProviders()) {
      providers[p.id] = p.name
      for (const m of p.models) models[`${p.id}/${m.id}`] = m.name
    }
    const agents = { jev: 'Jev', chat: 'Chat model' }
    for (const a of await enabledAgents().catch(() => [])) agents[a.id] = nameOfAgent(a)
    return { providers, models, agents }
  }

  // --- Laya on the model menu, the Laya card and the inspector's Laya views -
  /**
   * The Laya Auto row's state (docs/laya-auto.md 3.1), or null while the row is not offered: Laya
   * not installed, switched off, its settings invalid, or adaptive routing off. What a task costs
   * is said once the device it runs on, or would start on, has measured every phase, whatever the
   * state: a restart, an update or a start under way changes nothing this PC measured.
   */
  async function layaRow() {
    if (!layaAskable() || config.routing?.enabled === false) return null
    const s = sidecar.status()
    const { measured, device: wanted } = sidecar.readSettings()
    // Where it runs, else where it would start.
    const device = s.running?.device ?? nextDevice(s, wanted)
    return { state: s.state, device, ...layaCosts(measured[device]?.msPerToken), lastStartMs: measured[device]?.loadMs?.at(-1) ?? null }
  }
  // The device Laya would start on: the GPU where PyTorch has CUDA and the CPU was not picked.
  const nextDevice = (s, wanted) => (s.installed?.cuda && wanted !== 'cpu' ? 'cuda' : 'cpu')

  // What an install would get on this PC (7.2): PyTorch for the GPU where the driver runs one of
  // the pinned CUDA builds, else for the CPU, and the disk and downloads it takes.
  const layaOffer = async () => installOffer(pins, await specs().catch(() => null))

  /**
   * GET /jev-router/laya (8.4): the sidecar's status, the shadow's counters, and what the card
   * reads beside them: what recover() did at start, the last check for a newer model, where Laya
   * lives, what it would take at its next start, what a task costs it where it runs, until it is
   * installed, what an install would get, and the two reasons Laya can be off apart, since each has
   * its own remedy: an error in the laya block of cordis.patch.yml (`configError`), and the harness's
   * own pins that could not be read (`pinsError`), which its update puts back. The supervisor holds
   * either as its `configError`, so Laya reads as off for both.
   */
  async function layaStatus() {
    const s = sidecar.status()
    const { measured, device } = sidecar.readSettings()
    const job = installer?.status().job
    return {
      ...s,
      running: s.running ? { ...s.running, ...layaCosts(measured[s.running.device]?.msPerToken) } : null,
      shadow: shadow.counters(),
      colibri: colibri.summary(),
      recovered: installer?.status().message ?? null,
      configError: layaError ?? null,
      pinsError,
      weights: job?.kind === 'weights' && job.weights ? job.weights : null,
      paths: { engine: sidecar.paths.engine, models: sidecar.paths.models },
      need: {
        device: nextDevice(s, device),
        cpu: { ramGB: measured.cpu.ramGB ?? pins?.ramEstimateGB?.cpu ?? null },
        cuda: { ramGB: measured.cuda.ramGB ?? pins?.ramEstimateGB?.cuda ?? null, vramGB: measured.cuda.vramGB ?? pins?.vramEstimateGB ?? null },
      },
      ...(s.installed ? {} : { offer: await layaOffer() }),
    }
  }

  /**
   * Test Laya (4.6): its fixed calls through the real Laya client and adapter, starting Laya when
   * it is stopped and holding it while they run. The result goes to laya.json and the card; it
   * gates nothing.
   */
  async function layaSelfTest() {
    layaUnavailable('intent')
    sidecar.hold('selftest')
    try {
      await afterStartup()
      const conn = await sidecar.ensureReady({})
      const client = layaClient.client('act')
      const result = await runSelfTest((body, o) => client.systemOne(body, o), { identity: layaClient.identity(), device: conn.device })
      await sidecar.noteSelfTest(result)
      return result
    } finally { sidecar.release('selftest') }
  }

  /** The routes under /jev-router/laya (8.4). A long job (an install, an update, a repair) answers once it has begun, and the card follows it through GET /jev-router/laya. */
  async function layaRoute(req, url, send) {
    const op = url.pathname.slice('/jev-router/laya'.length)
    if (req.method === 'GET') {
      if (op === '') return send(200, await layaStatus())
      if (op === '/log') {
        const n = Math.min(500, Math.max(1, Math.trunc(Number(url.searchParams.get('lines'))) || 200))
        // An install that failed says why in its own lines; otherwise laya.serve's log.
        const s = sidecar.status()
        return send(200, { lines: s.state === 'install_failed' ? (installer?.status().job?.lines ?? []).slice(-n) : sidecar.logTail(n) })
      }
      if (op === '/shadow') {
        const runId = url.searchParams.get('runId')
        if (!runId) return send(400, { error: 'runId: the run id' })
        return send(200, { rows: shadow.read({ runId }), waiting: shadow.waiting({ runId }) })
      }
      // colibri's Laya beside laya.serve (13): the figures the card shows, also with no address set.
      if (op === '/colibri') return send(200, colibri.summary())
      if (op === '/compare') {
        const days = url.searchParams.get('days') ?? '7'
        const identity = url.searchParams.get('identity') ?? 'current'
        if (days !== 'all' && !(Number.isInteger(Number(days)) && Number(days) > 0)) return send(400, { error: "days: a whole number of days, or 'all'" })
        if (identity !== 'current' && identity !== 'all') return send(400, { error: "identity: 'current' or 'all'" })
        const c = await shadow.compare({ days: days === 'all' ? 'all' : Number(days), identity })
        // A PC where Laya cannot be asked and nothing was ever compared has nothing to put side by
        // side: the Router tab shows no card, rather than a table of nothing (5.6).
        if (!layaAskable() && !comparedAnything(c)) return send(404, { error: 'Laya cannot be asked on this PC, and nothing has been compared' })
        return send(200, c)
      }
      return send(404, { error: 'not found' })
    }
    if (req.method !== 'POST') return send(404, { error: 'not found' })
    const body = JSON.parse((await readBody(req)) || '{}')
    if (op === '/settings') {
      const saved = await sidecar.setSettings(body)
      // A colibri Laya address saved is checked at once with the test question; the card's next read shows what it found.
      if (Object.hasOwn(body, 'colibriUrl')) colibri.check().catch(() => {})
      return send(200, saved)
    }
    if (op === '/selftest') return send(200, await layaSelfTest())
    if (op === '/start') { await afterStartup(); await sidecar.start({ reason: 'user' }); return send(200, { ok: true }) }
    if (op === '/stop') { await sidecar.stop({ reason: 'user' }); return send(200, { ok: true }) }
    if (op === '/restart') { await afterStartup(); await sidecar.restart({ reason: 'user', device: body.device }); return send(200, { ok: true }) }
    const jobs = {
      '/install': () => {
        if (body.device !== 'gpu' && body.device !== 'cpu') throw new Error("device: 'gpu' or 'cpu'")
        return installer.install({ device: body.device })
      },
      '/update': () => installer.update({ device: body.device }),
      '/repair': () => installer.repair(),
      '/weights/check': () => installer.checkWeights(),
      '/weights/apply': () => installer.applyWeights(),
    }
    if (op === '/install/cancel') { installer?.cancel(); return send(200, { ok: true }) }
    if (!jobs[op] && op !== '/remove') return send(404, { error: 'not found' })
    if (!installer) return send(400, { error: pinsUnreadable(pinsError) })
    if (installer.status().running) return send(409, { error: `Another Laya install is running (pid ${process.pid}).` })
    // Removing is quick and the card waits for it; the rest take minutes and report as they go.
    if (op === '/remove') { await installer.remove(); return send(200, { ok: true }) }
    jobs[op]().catch(() => {})
    return send(200, { ok: true })
  }

  // "Jev Auto" in the model picker: every message goes straight to the router, no chat model in front.
  ctx.inject(['llm', 'agents'], (c) => {
    llm = c.llm
    llmRuntime = c
    agentsApi = c.agents
    // Message transfer: the local chat model rewrites a finished result body into prose. Built
    // here because `c.llm` is what it streams through; it is asked only when a result settles.
    formatter = createFormatter({
      stream: (opts) => c.llm.stream(opts),
      chatModel: () => local.chatModel(),
      contextOf: (id) => local.contextOf(id),
      enabled: config.format?.enabled ?? true,
      timeoutMs: config.format?.timeoutMs ?? 60_000,
      reserveTokens: config.format?.reserveTokens ?? 2048,
      log: (m) => process.stdout.write(`[jev] ${m}\n`),
    })
    c.effect(() => () => { llm = null; llmRuntime = null; formatter = null; agentsApi = null })
    c.effect(() => c.llm.registerAdapter([JEV_PROVIDER], jevAdapter({
      ctx: c, route, classify, auxModel, isOffline, localChat, orchestrator, agents: enabledAgents,
      canSeeImages, agentSeesImages, handOffImages,
      // Direct answers route through the same registry as background work: a chat model is
      // offered for what it can actually do, and its provider/model ride along so the answer
      // can be streamed from it.
      answerExecutors: async () => {
        const chat = await chatPair()
        const sees = new Set()
        for (const m of chat) if (await canSeeImages(m).catch(() => false)) sees.add(m.model)
        return executorsFrom({ chat, seesImages: (id) => sees.has(id) }).map((e) => {
          const [provider, ...model] = e.id.replace(/^chat:/, '').split('/')
          return { ...e, provider, model: model.join('/') }
        })
      },
      // A question answered without an agent: the "Saved by Jev" estimate counts these, only the
      // ones that came through a row Jev decides (2.5).
      onDirectAnswer: (durationMs, m, row) => inBackground(usage.logAttempt({ agent: 'chat', role: 'direct-answer', durationMs, provider: m.provider, model: m.model, decider: row?.decider ?? 'jev' }).catch(() => {})),
      // Laya Auto refuses a message at once when Laya cannot be asked, and is on offer, with what
      // a task costs on this PC, only while it can (3.1, 3.5).
      layaUnavailable,
      layaRow,
    })))
    // Local models in the picker and for local agents: our own adapter, so a request can start llama-server first.
    c.effect(() => c.llm.registerAdapter([LOCAL_PROVIDER], localAdapter(local, { attachments: () => c.get?.('attachments') })))
  })

  // DSH project folders: the only places the Terminal button may open a terminal.
  let workspaceRegistry = null
  ctx.inject(['workspaceRegistry'], (c) => {
    workspaceRegistry = c.workspaceRegistry
    c.effect(() => () => { workspaceRegistry = null })
  })
  const hotkeysFile = join(dataDir, 'hotkeys.json')
  // Effort settings from Settings -> Jev setup, over the Config defaults.
  const effortFile = join(dataDir, 'effort.json')
  const readEffort = async () => { try { return Config.dict.effort({ ...config.effort, ...JSON.parse(await readFile(effortFile, 'utf8').catch(() => '{}')) }) } catch { return config.effort } }
  const saveEffort = async (clean) => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(`${effortFile}.tmp`, JSON.stringify(clean, null, 2))
    await rename(`${effortFile}.tmp`, effortFile)
  }
  /** Settings, Effort as its card reads it: the settings, and what your ratings move Auto effort by now (effort.js effortBiases), in words. */
  const effortView = async () => {
    const settings = await readEffort()
    const learned = effortBiases(await feedback.list(), settings.ratingsResetAt ?? null).map((b) => ({ ...b, text: ratedEffortLine(b) }))
    return { ...settings, learned }
  }

  // --- The capability benchmark (docs/benchmark.md 3) -----------------------
  // Its runner, over this plugin's own state: the agents, readiness, the quota and the usage figures
  // the router reads, the capability registry it records into, and runBenchmarkTask, which runs one
  // task through runRouted() as every run is run.
  const excludedBy = (id) => {
    const disabled = config.routing?.disabledResources ?? []
    const allowed = config.routing?.allowedResources ?? []
    return disabled.includes(id) ? 'disabled by configuration' : allowed.length && !allowed.includes(id) ? 'not in the allowed resources' : null
  }
  benchmark = createBenchmark({
    scratchRoot,
    file: join(dataDir, 'benchmark.jsonl'),
    ...(benchmarkSeams.tasksDir ? { tasksDir: benchmarkSeams.tasksDir } : {}),
    agents: enabledAgents,
    readiness: () => readiness(),
    quota: quotaFor,
    // A provider that does not answer must not hold the card or the run: an ordinary read waits as
    // the router's quota read does, a forced one (the spend before and after an agent) longer, and
    // either falls back on the last snapshot.
    usage: (list, { force = false } = {}) => Promise.race([
      usage.snapshot(list, { force }).catch(() => null),
      new Promise((done) => setTimeout(done, force ? 15_000 : 4000, null).unref?.()),
    ]).then((snap) => snap ?? usage.last()?.out ?? {}),
    usageLines: () => usage.lines(),
    windowOf: (a) => local.contextOf(a.llm?.model),
    subjectOf: (a) => subjectOf(a, { modelOf, versionOf, priors }),
    capabilities,
    priors,
    policy,
    learn: () => config.routing?.learn !== false,
    runTask: runBenchmarkTask,
    sessionAgent: (id) => { try { return agentsApi?.get?.(id) ?? null } catch { return null } },
    listed: () => (workspaceRegistry?.list?.() ?? []).some((w) => typeof w?.path === 'string' && sameDir(w.path, scratchRoot)),
    speedRunning: () => !!local.speedRunning?.(),
    loadModel: (a) => local.start(a.llm?.model),
    gateAt: (id) => config.policy?.gateAtPercent?.[id] ?? config.policy?.gateAtPercent?.default ?? 80,
    excludedBy,
    peak: config.pricing?.peak ?? {},
    rateNow: (id) => pricingNow(config.pricing?.peak)[id] ?? null,
    agentTimeoutMs: config.agentTimeoutMs,
    log: (m) => process.stdout.write(`[jev] ${m}\n`),
  })
  // KzH closing stops a run: nothing records for an agent that had not finished.
  ctx.effect(() => () => { benchmark?.stop() })

  /** The routes under /jev-router/benchmark (docs/benchmark.md 3.12). A refusal answers with its own status. */
  async function benchmarkRoute(req, url, send) {
    const op = url.pathname.slice('/jev-router/benchmark'.length)
    try {
      if (req.method === 'GET' && op === '') {
        const session = url.searchParams.get('session') || null
        if (session !== null && !SESSION_ID.test(session)) return send(400, { error: 'session: a session id' })
        return send(200, await benchmark.state({ session }))
      }
      if (req.method !== 'POST') return send(404, { error: 'not found' })
      const body = JSON.parse((await readBody(req)) || '{}')
      if (op === '/plan') return send(200, await benchmark.plan({ session: body.session, agents: body.agents }))
      if (op === '/start') return send(200, await benchmark.start({ session: body.session, agents: body.agents, planId: body.planId }))
      if (op === '/stop') { benchmark.stop(); return send(200, { ok: true }) }
      return send(404, { error: 'not found' })
    } catch (err) {
      return send(err.status ?? 400, { error: err.message })
    }
  }

  // HTTP routes for the browser half (inspector tab, setup page), behind DSH's own Host/Origin/cookie checks.
  ctx.inject(['webServer', 'connection'], (c) => {
    c.effect(() => c.webServer.register({
      kind: 'prefix',
      path: '/jev-router',
      handler: async (req, res) => {
        const deny = c.connection.requestRejection(req)
        if (deny) { res.statusCode = deny; return res.end() }
        // Writes need a JSON body type: a cross-site form cannot send one without a CORS preflight.
        if (req.method !== 'GET' && !isJsonRequest(req)) { res.statusCode = 415; return res.end() }
        const url = new URL(String(req.url), 'http://localhost')
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method === 'GET' && url.pathname === '/jev-router/logo.png') {
            res.setHeader('content-type', 'image/png')
            res.setHeader('cache-control', 'max-age=86400')
            return res.end(await readFile(new URL('./assets/logo.png', import.meta.url)))
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/log') return send(200, logs.get(url.searchParams.get('session')) ?? [])
          // The durable record, not the in-memory tail above: every run this session ever wrote to
          // history.jsonl, newest last, returned as stored. A truncated final line (a crash mid
          // append) is skipped by allRecords the same way tasks.jsonl reading skips one, so a bad
          // last line cannot hide the runs before it.
          if (req.method === 'GET' && url.pathname === '/jev-router/history') {
            const session = url.searchParams.get('session')
            if (!SESSION_ID.test(session ?? '')) return send(400, { error: 'session: a session id' })
            const all = (await allRecords()).filter((r) => r.sessionId === session)
            const records = all.slice(-HISTORY_RESPONSE_CAP)
            return send(200, { session, total: all.length, returned: records.length, truncated: all.length > records.length, records })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/runs/stop') {
            const { runId } = JSON.parse(await readBody(req))
            const stop = stoppers.get(runId)
            // A background task aborts through its own controller, so it settles as stopped, not failed.
            const task = tasks.stopRun(runId)
            if (!stop && !task) return send(404, { error: 'no active run with that id' })
            for (const runs of logs.values()) for (const r of runs) if (r.id === runId) r.stopped = true
            stop?.abort(new Error('stopped by the user'))
            return send(200, { ok: true })
          }
          // Export one chat as Markdown, read from DSH's own stored session log.
          if (req.method === 'GET' && url.pathname === '/jev-router/export') {
            const session = url.searchParams.get('session') ?? ''
            if (!SESSION_ID.test(session)) return send(400, { error: 'session: a session id' })
            try {
              return send(200, await exportSession(join(dshHome, 'sessions'), session, { tools: url.searchParams.get('tools') !== '0' }))
            } catch (err) { return send(err.status ?? 500, { error: err.message }) }
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/names') return send(200, await displayNames())
          // Laya's card, the inspector's Laya column and the side-by-side card (docs/laya-auto.md 8.4).
          if (url.pathname === '/jev-router/laya' || url.pathname.startsWith('/jev-router/laya/')) return await layaRoute(req, url, send)
          // The capability benchmark's card in the Router tab (docs/benchmark.md 3.12).
          if (url.pathname === '/jev-router/benchmark' || url.pathname.startsWith('/jev-router/benchmark/')) return await benchmarkRoute(req, url, send)
          // The adaptive router's own state, for the Jev inspector: how far each routing domain
          // has matured and what is blocking the next rung, what the registry currently believes
          // each resource is good at and on what evidence, and what each provider's limits look
          // like right now. Read only, and nothing here carries task text or a key.
          if (req.method === 'GET' && url.pathname === '/jev-router/routing') {
            const agents = await enabledAgents()
            const snaps = snapshotResources({
              agents, usage: usage.last()?.out ?? {}, ready: await readiness(), config,
              specs: await specs().catch(() => null), modelOf, policy, rates: pricingNow(config.pricing?.peak),
            })
            const profiles = agents.map((a) => {
              const subject = subjectOf(a, { modelOf, versionOf, priors })
              const p = capabilities.profileOf(subject)
              return {
                id: a.id,
                subject: { provider: subject.provider, family: subject.family, model: subject.model },
                cold: p.cold,
                samples: p.samples,
                lastUpdate: p.lastUpdate,
                // Only the dimensions something is actually known about: an unknown one is
                // reported as unknown rather than as a number nobody stands behind.
                // A dimension only a benchmark has measured is known too: its rows are not runs.
                dimensions: Object.fromEntries(Object.entries(p.dimensions ?? {}).filter(([, d]) => d.prior || d.samples > 0 || d.benchmark)),
              }
            })
            return send(200, {
              enabled: config.routing?.enabled !== false,
              learning: !!domains,
              domains: domains ? domains.states() : {},
              policy: { capabilityTiers: policy.capabilityTiers, minimumReview: policy.minimumReview, gates: policy.gates, drift: policy.drift },
              resources: snaps.map((r) => ({
                id: r.resourceId, provider: r.provider, adapter: r.adapter, source: r.source, model: r.model,
                plan: r.plan, limits: r.limits, availability: r.availability, economics: r.economics,
                usageSource: r.usageSource, confidence: r.confidence, stale: r.stale, checkedAt: r.checkedAt,
                governor: governorSignals({ snapshots: [r], policy }).get(r.resourceId) ?? null,
              })),
              profiles,
              training: await training.stats().catch(() => null),
            })
          }
          // Force an evaluation pass: train on what is there, measure it, and move any domain
          // that has earned it. Normally this runs by itself after a run; this is for the setup
          // page and for anyone who wants to see where a domain stands right now.
          if (req.method === 'POST' && url.pathname === '/jev-router/routing/evaluate') {
            if (!domains) return send(400, { error: 'routing learning is switched off' })
            return send(200, { domains: await domains.evaluateAll() })
          }
          // Background tasks: the task list column (queued / running / finished).
          if (req.method === 'GET' && url.pathname === '/jev-router/tasks') {
            await tasks.ready
            const ws = url.searchParams.get('workspace')
            const all = tasks.list()
            return send(200, { tasks: ws ? all.filter((t) => laneKey(t.workspace) === laneKey(ws)) : all })
          }
          // The Live tab, the card under a start reply and the Tasks tab's live tail (live.js): a task's
          // runs by its key (a read pass and the pass that writes after it), or one run by its id,
          // each with its items changed since `after`. A run of a task the store no longer holds, as
          // after a restart, is read from its saved transcript, and `saved` says so of a task that has
          // ended. `done` once nothing more will come: the task has ended, or the run.
          if (req.method === 'GET' && url.pathname === '/jev-router/live') {
            await tasks.ready
            const key = url.searchParams.get('task')
            const run = url.searchParams.get('run')
            const after = Number(url.searchParams.get('after') ?? 0)
            const LIVE_ID = /^[\w-]{1,80}$/
            if ((key === null) === (run === null) || !LIVE_ID.test(key ?? run)) return send(400, { error: 'task: a task key, or run: a run id' })
            if (!Number.isSafeInteger(after) || after < 0) return send(400, { error: 'after: a version, a whole number from 0' })
            const t = key ? tasks.byKey(key) : null
            if (key && !t) return send(404, { error: 'no task with that key' })
            const ids = key ? t.runIds : [run]
            let runs = ids.map((id) => live.read(id, after))
            // The version these reads are of, taken with them: whatever changes while the saved
            // transcript is read below comes after it, so the next poll, which asks after it, has it.
            const v = live.v
            let saved = false
            // Runs the store no longer holds come from the saved transcript, once: it does not change.
            if (key && runs.some((r) => !r)) {
              const s = after > 0 ? null : await live.load(key)
              const kept = new Map((s?.runs ?? []).map((r) => [r.runId, r]))
              const fromFile = runs.map((r, i) => !r && kept.has(ids[i]))
              runs = ids.map((id, i) => runs[i] ?? kept.get(id) ?? null)
              // Said only of a task that has ended, whose report is in the chat: a pass the store let
              // go of while the task still works is shown from the file without the note.
              saved = TERMINAL_STATES.includes(t.state) && fromFile.some(Boolean)
            }
            runs = runs.filter(Boolean)
            if (run && !runs.length) return send(404, { error: 'no live run with that id' })
            const done = key ? TERMINAL_STATES.includes(t.state) : runs.every((r) => r.summary?.done)
            return send(200, { runs, v, patches: enginePatches(), done, saved, ...(t ? { task: { key: t.key, jobId: t.jobId, taskName: t.taskName, state: t.state, sessionId: t.sessionId } } : {}) })
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/tasks/report') {
            await tasks.ready // a task restored from tasks.jsonl has a report before the list is asked for
            const report = tasks.report(url.searchParams.get('id') ?? '')
            return report === null ? send(404, { error: 'no report for that task' }) : send(200, { report })
          }
          if (req.method === 'POST' && url.pathname.startsWith('/jev-router/tasks/')) {
            const body = JSON.parse(await readBody(req))
            try {
              if (url.pathname === '/jev-router/tasks/stop') return send(200, { result: tasks.stop(validJobId(body.jobId), { onlyIfWaiting: body.onlyIfWaiting === true }) })
              if (url.pathname === '/jev-router/tasks/reorder') { tasks.reorder(body.workspace, body.order ?? []); return send(200, { ok: true }) }
              if (url.pathname === '/jev-router/tasks/clear') return send(200, { cleared: tasks.clear(body.jobIds ?? []) })
              // Send now and Steer (docs/live-agent-view.md Feature 5), for a task by its key, which no
              // restart hands to another task as the engine does a job id. Each answers what came of it in
              // words, which the browser shows as they are.
              if (url.pathname === '/jev-router/tasks/start-now') return send(200, await startTaskNow(taskKeyIn(body), { stop: body.stop == null ? null : validJobId(body.stop) }))
              if (url.pathname === '/jev-router/tasks/steer') return send(200, await steerTask(taskKeyIn(body), { text: body.text, how: body.how ?? 'auto' }))
              // The browser reporting that it has actually rendered these result messages. This
              // is the only thing that marks a result read, which is what "unread" means. Each
              // result names its task as its notice does, and the page names the chat the rows are
              // in, so an old notice under a job id the engine reused after a restart, in this chat
              // or another, never marks the new task read (tasks.js delivered()); an older page's
              // bare `jobIds` are still heard.
              if (url.pathname === '/jev-router/tasks/seen') {
                await tasks.ready
                const seen = seenResults(body)
                return send(200, { acknowledged: seen.filter((r) => tasks.delivered(r.jobId, { name: r.name, sessionId: r.sessionId })).map((r) => r.jobId) })
              }
            } catch (err) { return send(err.status ?? 400, { error: err.message }) }
          }
          // Shortcuts page: key bindings and the right sidebar width, one small JSON file.
          if (req.method === 'GET' && url.pathname === '/jev-router/effort') return send(200, await effortView())
          if (req.method === 'POST' && url.pathname === '/jev-router/effort') {
            if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') return send(415, { error: 'JSON only' })
            let clean
            // What your ratings moved is worked out from them each time it is read, never saved.
            try { const { learned: _shown, ...body } = JSON.parse(await readBody(req)) ?? {}; clean = Config.dict.effort(body) } catch (err) { return send(400, { error: err.message }) }
            await saveEffort(clean)
            return send(200, clean)
          }
          // Settings, Effort, Reset: your ratings given before now move Auto effort no more. Nothing is
          // deleted: the time is kept beside the settings, and the ratings are read from it on.
          if (req.method === 'POST' && url.pathname === '/jev-router/effort/ratings-reset') {
            await saveEffort({ ...(await readEffort()), ratingsResetAt: new Date().toISOString() })
            return send(200, await effortView())
          }
          // How the chat answers a task it queues (Settings, Jev setup, Chat replies): a patch of the
          // fields to change, each checked, saved whole and taken by the next reply.
          if (req.method === 'GET' && url.pathname === '/jev-router/chat-replies/settings') { await chatRepliesRead; return send(200, chatReplies) }
          if (req.method === 'POST' && url.pathname === '/jev-router/chat-replies/settings') {
            await chatRepliesRead
            let next
            try { next = validChatReplies(JSON.parse(await readBody(req)), chatReplies) } catch (err) { return send(400, { error: err.message }) }
            await mkdir(dataDir, { recursive: true })
            await writeFile(`${chatRepliesFile}.tmp`, JSON.stringify(next, null, 2))
            await rename(`${chatRepliesFile}.tmp`, chatRepliesFile)
            chatReplies = next
            return send(200, next)
          }
          // Settings, Jev setup, Live agent view: whether the engine patch is in the Claude Code and Codex
          // connectors, and why not (engine-patches.js), and the live settings, saved whole.
          if (req.method === 'GET' && url.pathname === '/jev-router/engine-patches') return send(200, enginePatches())
          if (req.method === 'GET' && url.pathname === '/jev-router/live/settings') { await liveSettingsRead; return send(200, liveSettings) }
          if (req.method === 'POST' && url.pathname === '/jev-router/live/settings') {
            if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') return send(415, { error: 'JSON only' })
            await liveSettingsRead
            let next
            try { next = validLiveSettings(JSON.parse(await readBody(req)), liveSettings) } catch (err) { return send(400, { error: err.message }) }
            await mkdir(dataDir, { recursive: true })
            await writeFile(`${liveSettingsFile}.tmp`, JSON.stringify(next, null, 2))
            await rename(`${liveSettingsFile}.tmp`, liveSettingsFile)
            const was = liveSettings
            liveSettings = next
            // Keep transcripts off: the ones kept so far go too, each in its task's own turn.
            if (next.transcripts === 'off' && was.transcripts !== 'off') { await tasks.ready; for (const t of tasks.list()) if (t.key) inBackground(live.drop(t.key)) }
            return send(200, next)
          }
          // Settings, Jev setup, How Jev replies: how start replies are made, how far task or question
          // has come, and the reply predictor's record (repliesSummary), read only.
          if (req.method === 'GET' && url.pathname === '/jev-router/replies/summary') return send(200, await repliesSummary())
          // One start reply's row, by its task's key (the reply's [jev-job] mark), for the ask under a
          // reply whose plan changed (docs/live-agent-view.md Feature 4): what it named and what then
          // ran, how its pick was rated and the ask answered, whether asking is on, and whether its task
          // has ended. A reply of another chat, when the page names its chat, is none of this one's.
          if (req.method === 'GET' && url.pathname === '/jev-router/replies') {
            const key = url.searchParams.get('key') ?? ''
            const session = url.searchParams.get('session')
            if (!TASK_KEY.test(key)) return send(400, { error: 'key: the task key a start reply carries' })
            const row = await ledger.row(key)
            if (!row || (session !== null && row.sessionId !== session)) return send(404, { error: 'no start reply of that task is recorded' })
            const t = tasks.byKey(key)
            return send(200, { key, jobId: row.jobId, said: row.said, ran: row.ran, verdict: row.verdict, ask: row.ask, askWhenWrong: chatReplies.askWhenWrong !== false, ended: !t ? true : TERMINAL_STATES.includes(t.state) ? t.state : null })
          }
          // The person's answer to that ask, kept on the reply's row so the reply is never asked about
          // again: `said` (the agent the reply named was right), `ran` (the one that ran was) or `either`.
          if (req.method === 'POST' && url.pathname === '/jev-router/replies/ask') {
            let body
            try { body = JSON.parse(await readBody(req)) } catch { return send(400, { error: 'expected JSON' }) }
            const answer = body?.answer
            if (!TASK_KEY.test(String(body?.key ?? ''))) return send(400, { error: 'key: the task key a start reply carries' })
            if (!ASK_ANSWERS.includes(answer)) return send(400, { error: `answer: one of ${ASK_ANSWERS.join(', ')}` })
            const row = ledgerOn() ? await ledger.row(body.key) : null
            if (!row || (body.sessionId !== undefined && row.sessionId !== body.sessionId)) return send(404, { error: 'no start reply of that task is recorded' })
            const next = await ledger.note(body.key, { ask: { answer, at: new Date().toISOString() } })
            return send(200, { key: body.key, ask: next.ask })
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/hotkeys') {
            const raw = await readFile(hotkeysFile, 'utf8').catch((err) => { if (err.code === 'ENOENT') return '{}'; throw err })
            return send(200, JSON.parse(raw))
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/hotkeys') {
            const clean = validHotkeys(JSON.parse(await readBody(req)))
            await mkdir(dataDir, { recursive: true })
            await writeFile(`${hotkeysFile}.tmp`, JSON.stringify(clean, null, 2))
            await rename(`${hotkeysFile}.tmp`, hotkeysFile)
            return send(200, clean)
          }
          // Like/Dislike on a finished answer, with the person's reason and an optional tag
          // saying what the verdict was about. The client posts one verdict per answer message;
          // a later verdict for the same message replaces the earlier one on read, tag included.
          // A verdict of `clear` appends the tombstone instead, and the GET stops reporting that
          // message, so a cleared verdict survives a reload. An unknown tag is rejected here with
          // a 400 by validFeedback, before it is stored. The GET is for the inspector and for a
          // page that reloads.
          // The verdict also becomes capability evidence here, once, for the run it is about
          // (creditVerdict): a run's own evidence was recorded when it ended, before anyone could
          // judge it. One queue, so the evidence is recorded in the order feedback.jsonl is
          // written and a quick like-then-dislike cannot land the other way round. All of that
          // is postFeedback's (createFeedbackRoute), so the route is tested without a server.
          if (req.method === 'POST' && url.pathname === '/jev-router/feedback') {
            const { status, body } = await postFeedback(await readBody(req))
            return send(status, body)
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/feedback') {
            const session = url.searchParams.get('session')
            if (session !== null && !SESSION_ID.test(session)) return send(400, { error: 'session: a session id' })
            return send(200, { feedback: await feedback.list(session ?? undefined) })
          }
          // Sign in / out of an agent by running its own CLI. The client sends an agent id and
          // "login" or "logout", never a command: the command is chosen here, by provider.
          if (req.method === 'POST' && url.pathname === '/jev-router/account-auth') {
            const { agentId, action } = JSON.parse(await readBody(req))
            const agent = (await enabledAgents()).find((a) => a.id === agentId)
            if (!agent || !canAuth(agent.provider)) return send(400, { error: 'that agent has no sign-in of its own' })
            if (action !== 'login' && action !== 'logout') return send(400, { error: 'action must be login or logout' })
            // A visible terminal, because the CLI asks questions and opens a browser.
            const terminal = (argv) => {
              const shell = () => spawn('powershell.exe', ['-NoExit', '-Command', argv.join(' ')], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
              spawn('wt.exe', [...argv], { detached: true, stdio: 'ignore' }).on('error', shell).unref()
            }
            try {
              const r = await authAction(agent.provider, action, terminal)
              // The cached readiness is now stale either way.
              await readiness(true).catch(() => {})
              return send(200, r)
            } catch (err) { return send(400, { error: err.message }) }
          }
          // Opens the user's own terminal in a DSH project folder; the client sends only the folder, never a command.
          if (req.method === 'POST' && url.pathname === '/jev-router/open-terminal') {
            const { cwd } = JSON.parse(await readBody(req))
            const dir = await workspaceDir(cwd, (workspaceRegistry?.list() ?? []).map((w) => w.path))
            const shell = () => spawn('powershell.exe', ['-NoExit'], { cwd: dir, detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
            spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' }).on('error', shell).unref()
            return send(200, { ok: true })
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/setup') {
            const [agents, status, jevKey, jevStored] = await Promise.all([
              enabledAgents(),
              readiness(url.searchParams.has('recheck')),
              resolveCredential(config.credentialRef).catch(() => undefined),
              jevStoredKeyInUse(),
            ])
            return send(200, {
              // Where Jev calls go: TYPESAFE_BASE_URL still redirects Jev, and the card says so (8.1).
              // Which key Jev's calls go out on, as it resolves one per call: the active stored Jev key
              // while its value is there, else the credential.
              jev: { configured: !!jevStored || !!jevKey?.value, activeKey: jevStored, credentialSet: !!jevKey?.value, credentialRef: config.credentialRef, host: jevHostOf(), hostFromEnv: !!process.env.TYPESAFE_BASE_URL?.trim() },
              laya: sidecar.status(),
              agents: agents.map((a) => ({ id: a.id, provider: a.provider, description: a.description, enabled: a.enabled, custom: !!a.custom, llm: a.llm?.provider ? a.llm : undefined, status: status[a.id], readOnly: readOnlyOf(a) })),
              providers: await modelProviders(),
              tools: (config.tools ?? []).map((t) => ({ id: t.id, description: t.description, command: t.command, enabled: t.enabled })),
              // The providers a restart would move onto another stored key: Settings says so while it would.
              keysRestartPending: accounts.restartPendingProviders(),
            })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/agents') {
            const body = JSON.parse(await readBody(req))
            const target = allAgents(await readSetup()).find((a) => a.id === body.id)
            if (!target) return send(404, { error: `unknown agent ${body.id}` })
            if (!target.enabled && body.enabled) return send(400, { error: `${body.id} is switched off in cordis.patch.yml (enabled: false); change it there` })
            await mutateSetup((s) => ({ ...s, disabled: body.enabled ? s.disabled.filter((x) => x !== body.id) : [...new Set([...s.disabled, body.id])] }))
            return send(200, { ok: true })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/agents/only') {
            const body = JSON.parse(await readBody(req))
            if (!Array.isArray(body.ids)) return send(400, { error: 'ids: array of agent ids' })
            return send(200, { ids: await useOnly(parseUse(body.ids.join(' '), await switchable())) })
          }
          // Accounts and usage. Key values go in (POST /keys) and never come out.
          if (req.method === 'GET' && url.pathname === '/jev-router/usage') {
            const agents = await enabledAgents()
            const snap = await usage.snapshot(agents, { force: url.searchParams.get('force') === '1' })
            const lines = await usage.lines()
            const workspaces = [...new Set(lines.map((l) => l.workspace).filter(Boolean))]
            const handoffs = (await Promise.all(workspaces.map(async (w) => {
              const st = await stat(join(w, '.kz-harness', 'handoff.md')).catch(() => null)
              return st && { workspace: w, updatedAt: st.mtime.toISOString() }
            }))).filter(Boolean)
            // What each agent costs at this hour, for the agents whose provider bills by the clock.
            const rates = pricingNow(config.pricing?.peak)
            return send(200, {
              agents: Object.entries(snap).map(([id, q]) => ({ id, ...q, rateNow: rates[id] ?? null })),
              links: config.links ?? {},
              keys: usage.last().keys,
              // Beside the key list, and polled with it: the providers a restart would move onto another
              // key, and the stored Jev key Jev's calls go out on (Jev switches keys by itself).
              keysRestartPending: accounts.restartPendingProviders(),
              jevActiveKey: await jevStoredKeyInUse(),
              jevCredentialSet: !!(await resolveCredential(config.credentialRef).catch(() => undefined))?.value,
              recent: lines.slice(-50),
              handoffs,
              savings: await usage.savings({ ...config.savings, historyFile: config.historyFile }).catch(() => null),
            })
          }
          if (url.pathname === '/jev-router/keys' || url.pathname === '/jev-router/keys/activate') {
            const b = req.method === 'DELETE' ? Object.fromEntries(url.searchParams) : req.method === 'POST' ? JSON.parse(await readBody(req)) : {}
            if (!(await knownProviders()).includes(b.provider)) return send(400, { error: `unknown provider ${b.provider}` })
            if (!KEY_NAME.test(b.name ?? '')) return send(400, { error: KEY_NAME_RULE })
            let r
            // A key added beside an active key that is out (spent, or below its floor) takes over.
            if (req.method === 'POST' && url.pathname === '/jev-router/keys') r = await accounts.addKey(b.provider, b.name, b.key, { isOut: (n) => keyOut(b.provider, n) })
            else if (req.method === 'POST') r = await accounts.activate(b.provider, b.name)
            else if (req.method === 'DELETE' && url.pathname === '/jev-router/keys') r = await accounts.removeKey(b.provider, b.name, { isOut: (n) => keyOut(b.provider, n) })
            else return send(404, { error: 'not found' })
            return send(200, { ok: true, restartRequired: !!r?.restartRequired })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/limits') {
            const b = JSON.parse(await readBody(req))
            if (b.agentId !== 'jev' && !(await enabledAgents()).some((a) => a.id === b.agentId)) return send(404, { error: `unknown agent ${b.agentId}` })
            await accounts.setLimits(b.agentId, b)
            return send(200, { ok: true })
          }
          if (req.method === 'POST' && (url.pathname === '/jev-router/login' || url.pathname === '/jev-router/logout')) {
            const { provider } = JSON.parse(await readBody(req))
            if (url.pathname.endsWith('/login')) accounts.openLogin(provider)
            else await accounts.logout(provider)
            // The login window finishes on its own; the page's recheck (?recheck) picks up the new status.
            usage.resetLogin()
            readyGen++; readyCache = null
            return send(200, { ok: true })
          }
          // Local models: status for the Settings card, the picker's catalog, installs and removals (manifest ids only).
          if (req.method === 'GET' && url.pathname === '/jev-router/local') {
            return send(200, await localStatus({ local, lanes, online: connectivity.last()?.online ?? null }))
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/local/catalog') return send(200, await catalog())
          // The tail of llama-server's log on disk, as GET /jev-router/laya/log serves Laya's: `lines` of it, 200 unless said, 500 at most.
          if (req.method === 'GET' && url.pathname === '/jev-router/local/log') {
            const n = Math.min(500, Math.max(1, Math.trunc(Number(url.searchParams.get('lines'))) || 200))
            return send(200, { file: local.logFile ?? null, lines: await local.logTail(n) })
          }
          if (req.method === 'POST' && url.pathname.startsWith('/jev-router/local/')) {
            const b = JSON.parse((await readBody(req)) || '{}')
            const op = url.pathname.slice('/jev-router/local/'.length)
            // The speed benchmark (docs/benchmark.md 2.10): Benchmark on a model's row sends its id,
            // Benchmark all none. A refusal answers 400 with its reason, and 409 while a run goes.
            if (op === 'benchmark') {
              try { return send(200, { queued: await local.benchmark({ ids: b.ids }) }) } catch (err) { return send(err.status ?? 400, { error: err.message }) }
            }
            // Cancel: 200, also when nothing runs; 409 with why while the run puts the engine back.
            if (op === 'benchmark/cancel') {
              try { local.cancelBenchmark(); return send(200, { ok: true }) } catch (err) { return send(err.status ?? 400, { error: err.message }) }
            }
            // Accept new output (2.15): the model's figure held because its output differed from its
            // baseline becomes its speed, and that output its baseline. 400 when it has none held, 409 while a run goes.
            if (op === 'benchmark/accept-output') {
              try { await local.acceptOutput(b.id); return send(200, { ok: true }) } catch (err) { return send(err.status ?? 400, { error: err.message }) }
            }
            const ids = Array.isArray(b.ids) ? b.ids.map(String) : []
            if (op === 'start') await local.start(String(b.model ?? ''))
            else if (op === 'stop') await local.stop()
            else if (op === 'install') return send(200, { ids: await local.install(ids) })
            // The page asks for confirmation (Confirm modal naming every file and size) before calling this.
            else if (op === 'remove') { for (const id of ids) await local.remove(id) }
            else if (op === 'settings') await local.setSettings(b)
            else return send(404, { error: 'not found' })
            return send(200, { ok: true })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/custom') {
            const b = JSON.parse(await readBody(req))
            if (!/^[a-z][a-z0-9_-]{0,31}$/.test(b.id ?? '')) return send(400, { error: 'name: lowercase letters, digits, - or _, starting with a letter' })
            if (!b.description) return send(400, { error: 'say what the agent is: which model or API it runs, and how it is paid for' })
            const provider = (await modelProviders()).find((p) => p.id === b.provider)
            if (!provider?.models.some((m) => m.id === b.model)) return send(400, { error: `${b.provider} / ${b.model} is not a model in Settings → Models` })
            await mutateSetup((s) => {
              if (allAgents(s).some((a) => a.id === b.id)) throw new Error(`an agent named ${b.id} already exists`)
              return { ...s, custom: [...s.custom, { id: b.id, provider: b.provider, model: b.model, description: String(b.description).slice(0, 500) }] }
            })
            return send(200, { ok: true })
          }
          if (req.method === 'DELETE' && url.pathname === '/jev-router/custom') {
            const id = url.searchParams.get('id')
            await mutateSetup((s) => ({ disabled: s.disabled.filter((x) => x !== id), custom: s.custom.filter((c) => c.id !== id) }))
            return send(200, { ok: true })
          }
          send(404, { error: 'not found' })
        } catch (err) { send(400, { error: err.message }) }
      },
    }))
  })
}

const PEERS = { claude: 'codex', codex: 'claude' }

// A key combo as the Shortcuts page writes it: modifiers in this order, then one key; '' = unbound.
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?([A-Z0-9`\-=[\]\;',./]|F([1-9]|1[0-2])|Enter|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/

/** Shortcuts page body -> what gets stored: { bindings: {actionId: combo}, rightbarRatio? }. Throws on anything else. */
export function validHotkeys(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected an object')
  const { bindings = {}, rightbarRatio } = body
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('bindings: object of action id -> key combo')
  const entries = Object.entries(bindings)
  if (entries.length > 40) throw new Error('too many bindings')
  for (const [id, combo] of entries) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error(`bad action id ${id}`)
    if (typeof combo !== 'string' || (combo !== '' && !COMBO.test(combo))) throw new Error(`bad key combo for ${id}`)
  }
  if (rightbarRatio !== undefined && !(Number.isInteger(rightbarRatio) && rightbarRatio >= 15 && rightbarRatio <= 50)) throw new Error('rightbarRatio: whole number 15-50')
  return { bindings: Object.fromEntries(entries), ...(rightbarRatio !== undefined ? { rightbarRatio } : {}) }
}

/**
 * How the chat answers a task it queues, as shipped (docs/live-agent-view.md Feature 2): the start
 * reply waits up to 15 s for the router's pick, milestone notices follow it, and a reply that named
 * another plan than ran may ask which was right.
 */
export const CHAT_REPLIES = Object.freeze({ waitMs: 15_000, progress: 'milestones', askWhenWrong: true })
/** The answers the ask under a start reply takes (POST /jev-router/replies/ask): the agent it named was right, the one that ran was, or either was. */
export const ASK_ANSWERS = Object.freeze(['said', 'ran', 'either'])
// A task's key as tasks.js makes it (randomUUID), which its start reply carries in its [jev-job] mark.
const TASK_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The chat replies settings with `patch` laid over `current` (POST /jev-router/chat-replies/settings):
 * a field left out keeps its value, and one this build does not know is dropped. Throws on the first
 * field that is wrong, naming what it takes, so a refused patch saves nothing. `progress` 'off' is
 * Settings' "Start and result only": the start reply and the result, and no milestone notice between
 * but the change of plan of a guess routing did not pick (tasks.js guessMissed).
 */
export function validChatReplies(patch, current = CHAT_REPLIES) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('chat replies: an object of the settings to change')
  const next = { ...CHAT_REPLIES, ...current }
  if ('waitMs' in patch) {
    if (!Number.isInteger(patch.waitMs) || patch.waitMs < 0 || patch.waitMs > 60_000) throw new Error('waitMs: whole milliseconds from 0 to 60000 (0 replies at once)')
    next.waitMs = patch.waitMs
  }
  if ('progress' in patch) {
    if (patch.progress !== 'milestones' && patch.progress !== 'off') throw new Error("progress: 'milestones', or 'off' for the start reply and the result only")
    next.progress = patch.progress
  }
  if ('askWhenWrong' in patch) {
    if (typeof patch.askWhenWrong !== 'boolean') throw new Error('askWhenWrong: true or false')
    next.askWhenWrong = patch.askWhenWrong
  }
  return { waitMs: next.waitMs, progress: next.progress, askWhenWrong: next.askWhenWrong }
}

/**
 * Settings, Jev setup, Live agent view, as shipped (docs/live-agent-view.md Feature 1): whether Steer may
 * reach a running Claude Code through its input channel (experimental, off), how Claude Code shows its
 * thinking ('default', as it shows it, or 'summarized'), and whether each task's transcript is kept on
 * disk ('last20', the newest 20 tasks of the task list, 'last100', every task the list keeps, or 'off').
 */
export const LIVE_SETTINGS = Object.freeze({ claudeSteer: false, claudeThinking: 'default', transcripts: 'last20' })

/** Keep transcripts, Last 20 tasks: how many of the task list's newest tasks keep their transcripts. */
export const TRANSCRIPTS_LAST = 20

/**
 * The live settings with `patch` laid over `current` (POST /jev-router/live/settings): a field left out
 * keeps its value, and one this build does not know is dropped. Throws on the first field that is
 * wrong, naming what it takes, so a refused patch saves nothing.
 */
export function validLiveSettings(patch, current = LIVE_SETTINGS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('live settings: an object of the settings to change')
  const next = { ...LIVE_SETTINGS, ...current }
  if ('claudeSteer' in patch) {
    if (typeof patch.claudeSteer !== 'boolean') throw new Error('claudeSteer: true or false')
    next.claudeSteer = patch.claudeSteer
  }
  if ('claudeThinking' in patch) {
    if (patch.claudeThinking !== 'default' && patch.claudeThinking !== 'summarized') throw new Error("claudeThinking: 'default', as Claude Code shows it, or 'summarized'")
    next.claudeThinking = patch.claudeThinking
  }
  if ('transcripts' in patch) {
    if (!['last20', 'last100', 'off'].includes(patch.transcripts)) throw new Error("transcripts: 'last20', 'last100', or 'off' to keep none")
    next.transcripts = patch.transcripts
  }
  return { claudeSteer: next.claudeSteer, claudeThinking: next.claudeThinking, transcripts: next.transcripts }
}

/** The folder a terminal may open in: an existing directory that is a DSH project folder. */
export async function workspaceDir(cwd, projectPaths) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd: the session folder')
  const dir = resolve(cwd)
  const same = (p) => resolve(p).toLowerCase() === dir.toLowerCase()
  if (!projectPaths.some(same)) throw new Error('that folder is not a harness project')
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error('that folder does not exist')
  return dir
}

/**
 * GET /jev-router/local: the local models' status, whether this PC is online, and `slots`, how many
 * runs hold a slot under the budget's cap on tasks at once and how many wait for one (lanes.slots()).
 * The count comes from the lanes because that is where the cap is held: a count of background tasks
 * would leave out the foreground /auto, /<agent> and jev_route runs the cap counts as well.
 */
export const localStatus = async ({ local, lanes, online }) => ({ ...(await local.status()), online, slots: lanes.slots() })

/** One line for Jev and the log: windows, balance or spend. */
function summaryOf(q) {
  const parts = (q.windows ?? []).map((w) => `${w.name} ${Math.round(w.usedPercent)}%`)
  if (q.balance) parts.push(`balance ${q.balance.amount.toFixed(2)} ${q.balance.currency}`)
  if (q.spentUsd != null) parts.push(`$${q.spentUsd.toFixed(2)} this month`)
  return `${q.state}${parts.length ? `: ${parts.join(' · ')}` : ''}`
}

const sessionIdOf = (agent) => agent?.session?.id ?? agent?.session?.header?.id

/**
 * Laya's pins (config/laya.json) could not be read: a harness file, which the harness's update
 * puts back, so this never points at the laya block in cordis.patch.yml as a settings error does.
 */
const pinsUnreadable = (message) => `Laya's pinned versions could not be read (${message}); run Update-Harness.ps1`

/** A refusal of Laya as the reason one call could not be asked, in the Laya client's words (3.4). */
export const layaReason = (err) => ({
  not_installed: 'Laya is not installed on this PC',
  disabled: 'Laya is switched off in the configuration',
  invalid: `Laya's settings are invalid (${err?.detail})`,
  pins: `Laya's pinned versions could not be read (${err?.detail})`,
  routing_off: 'adaptive routing is off',
  failed: `Laya stopped after an error (${err?.detail ?? 'unknown'})`,
})[err?.reason] ?? String(err?.message ?? err)

// The input tokens of what routing one task sends (its intent, its task group and its resource and
// judgments call) and of Test Laya's review, rendered as the Laya client renders them: the sizes the
// picker's figures are worked out over. Built once, on first use.
let layaCallTokens = null
const callTokens = () => {
  if (layaCallTokens) return layaCallTokens
  const tokens = (c) => renderForLaya(c, { role: 'act' }).reduce((n, r) => n + estimateRequestTokens(r), 0)
  const of = (phase) => taskCalls().filter((c) => c.phase === phase).reduce((n, c) => n + tokens(c), 0)
  layaCallTokens = { intent: of('intent'), route: of('route'), review: tokens(selfTestCalls().protocol.find((c) => c.name === 'review')) }
  return layaCallTokens
}

/** Whether a comparison (8.4) holds anything: a Jev call Laya answered, skipped or failed in the background, or a run Laya decided. */
function comparedAnything(c) {
  const k = c?.skips ?? {}
  const rows = (k.answered ?? 0) + (k.partial ?? 0) + (k.failed ?? 0) + Object.values(k.skipped ?? {}).reduce((a, n) => a + (n ?? 0), 0)
  return rows > 0 || (c?.domains ?? []).some((d) => (d.layaAutoRuns?.runs ?? 0) > 0)
}

/**
 * What a task and a review cost Laya on one device (docs/laya-auto.md 3.1): the measured ms per
 * token of each phase (4.5) over what routing a task sends (its intent, its task group and its
 * resource and judgments call), and over Test Laya's review for each attempt. `{}` until the device
 * has a figure for every phase, which its first start measures.
 * @param {{ intent?: number|null, route?: number|null, review?: number|null }} [msPerToken]
 * @returns {{ routeMs?: number, reviewMs?: number }}
 */
export function layaCosts(msPerToken) {
  const m = msPerToken ?? {}
  if (!['intent', 'route', 'review'].every((p) => typeof m[p] === 'number' && Number.isFinite(m[p]))) return {}
  const t = callTokens()
  return { routeMs: Math.round(t.intent * m.intent + t.route * m.route), reviewMs: Math.round(t.review * m.review) }
}

// Model text can quote anything; mask key-shaped strings before they reach the log.
// One redaction rule for the log and the export, so a provider added to one covers both.
const redactLine = redactSecrets

/**
 * One step of a run to the server log. A step can be several lines (a Laya call with its device and
 * flat answers, a routed step with the shadow's note), and the Kz-harness app reads the log line by
 * line, filing a line as the router's only by its own `[jev] ` prefix (app/main.js levelOf), so
 * every line carries it.
 */
const logStep = (text) => { for (const l of redactLine(text).split('\n')) process.stdout.write(`[jev] ${l}\n`) }

// Writes must declare a JSON body: a cross-site form cannot send one without a CORS preflight.
export const isJsonRequest = (req) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json'

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (d) => { chunks.push(d); size += d.length; if (size > 64 * 1024) { fail(new Error('body too large')); req.destroy() } })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

function setEnv(name, value) { if (value) process.env[name] = value; else delete process.env[name] }
