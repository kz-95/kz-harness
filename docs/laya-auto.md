# Laya Auto

Kind: **design, build against it**.
Every decision here is made; the owner's own decisions of 24 Sep 2026 are not up for debate, and the rest may be reopened only when the evidence named beside it changes.

Laya Auto is a second decision provider for KzH, beside Jev, that runs on this PC.
In the **Laya Auto** row of the model picker, Laya alone answers every routing, intent and review question, with no Jev call, offline included.
In **Jev Auto**, Jev decides exactly as today, and Laya answers the same questions in the background so the two can be compared.
This document says what to build, file by file, what every string says, how the answers are kept from contaminating what KzH has learnt from Jev, and how to prove it works in the cloud and on the owner's laptop.
It is written for agents that each build one group of section 11 in their own git worktree without talking to each other, so every shared contract is spelled out here, and where this document and a group disagree, the document wins until it is changed first.

It assumes [roadmap.md](roadmap.md) section 2 and [adaptive-routing.md](adaptive-routing.md) have been read.
Line references are to commit `8e5d376`, the head of `feat/laya-auto` this design was written against.
It is built on `feat/laya-auto`, and wherever the build departed from the first text and the code was right, the text was changed to match, so it describes what exists.
Nothing here has run in the app; what ran against the real `laya.serve` in the cloud, and what it measured, is in 9.4.

---

## 0. The design on one page

- One idea carries it: a frozen **provider record** per decider (`jev`, `laya`), and every place that reads a Jev constant today reads the record of the provider that answered instead.
- `createJev` takes a record and a client; the question builders in `jev.js` do not change, and nothing Laya-specific enters `jev.js`.
- Laya runs as the official **`python -m laya.serve`** from PyPI `laya` 0.3.20, in a Python sidecar supervised by a new `laya-sidecar.js` beside `local.js`, never inside it, so it can never evict the chat model.
- A **Laya client** (`laya-client.js`) wraps the sidecar: one request on the wire at a time, acting calls before background ones, measured deadlines, no retries, and the Laya wire adapter and answer normalisation of section 4.
- The **Laya wire adapter** (`laya-questions.js`) asks exactly Jev's questions, rendered for Laya's weaknesses: bug #156 labels and criteria on every noul, short option texts, a state view per question that fits 512 tokens, the English checkpoint pinned.
- Laya's choice and score confidence is read as **max probability**, the quantity Laya itself calls calibrated, the shipped `choice:11+` clamp is undone, and an answer too flat to mean anything is marked and filled visibly by the routing rules.
- **Laya Auto** is one new picker row; `routing.mode` keeps its meaning and a new `routing.decider` names who decided; when Laya cannot answer, the run says so and never calls Jev.
- The **shadow** hooks every Jev call in Jev Auto, is never awaited, never starts Laya and never keeps it loaded, yields Laya's memory to a local model that needs it, runs at below-normal priority in chunks of four questions, and writes `laya-shadow.jsonl` with answers and numbers only.
- **Learning integrity is structural**: Laya-decided runs write to their own `laya-samples.jsonl`, the Jev store refuses Laya rows, the local classifiers never read Laya's store, and Laya reviews credit no capability evidence except task-type-free reliability.
- Laya's **own ladder** is built now as its measurement, a per-domain reading that keeps its sources apart (what a person said, where Jev's pick was contradicted, how often Laya Auto runs failed) with agreement with Jev beside it; it has no rung and no gate, because every outcome KzH records today is selected by the acting router's failures, and the dumb code arbiter that would read it waits for an unconditioned evaluation and a mixed mode nobody has asked for.

---

## 1. Scope and the owner's decisions

### 1.1 Decided by the owner on 24 Sep 2026

1. **Laya Auto is a model-picker row beside Jev Auto.**
   In Laya Auto, Laya decides, purely locally: no Jev call at all, and it works offline.
   This overrides the roadmap's "shadow before authority" rule for the Laya Auto row only.
2. **In Jev Auto, Jev decides as today, and Laya also answers the same questions in the background (shadow).**
   Both answers are recorded side by side, so the owner can test both together and the inspector shows where they agree.
   The shadow must never slow or break a Jev Auto run.
3. **Laya runs as a Python sidecar: the official `laya.serve` from NandhaKishorM/laya (PyPI `laya`), started and stopped by KzH like llama-server.**
   It uses torch with CUDA on the RTX 3050 where available, and the CPU otherwise.
   The installer adds uv, which fetches Python and torch once.
   Laya downloads its own weights; the owner's PC reaches huggingface.co, and the cloud machine does not.
4. **Thresholds live on the provider record, never shared with Jev's** (roadmap rule 1).
   **The arbiter, where one is needed, stays in code and dumb** (roadmap rule 2).
5. **The owner tests Jev and Laya together on the desktop next session.**
   The cloud session that builds this cannot download Laya weights, but can install `laya` and torch from PyPI and run the real `laya.serve` on a random-weight checkpoint built with `laya.common.build_model`, which exercises the real protocol, latency, memory and supervision with meaningless answers.

The third-party servers stiermid/laya-serve and nvkudva/laya-server are not used or depended on; their notes are cited only for wire behaviour.

### 1.2 The engineering values that decide the rest

Quality, simplicity, robustness, scalability and long-term maintainability come before development cost.
No degradation is silent: every fallback, skip, device change and filled field is said where the person looks.
UI text is honest, and says what is measured and what is not.
Every new test fails against the old code, and `scripts/red-check.mjs` proves it (section 9.1).
No em dash or en dash character appears anywhere, in code, strings or docs.

### 1.3 What this design adds on top of the decisions

The owner's decisions say who decides; this design makes sure that what KzH reads from Laya means what KzH thinks it means.
Every number compared against a bar is read through the provider that produced it: its thresholds, its confidence semantics and its known weaknesses.
Every shadow row says exactly which model, checkpoint, weights and adapter answered, and which later evidence can and cannot judge it.
No Laya answer reaches Jev's training data, the local classifiers, capability evidence beyond reliability, or Jev's spend, and this holds by construction (separate files, refusing stores), not by filters someone could forget.

### 1.4 In scope, and not

In scope: the provider record and its thresholds, the Laya Auto row, the shadow, the sidecar and its install, the Settings card, learning integrity, the agreement and standing views, and the tests.
Out of scope now: section 10.

---

## 2. The provider record, and providerising `jev.js`

This is roadmap section 2, build step 1, and it is worth doing whether or not Laya ever ships.
For Jev it is a pure refactor: the Jev record carries today's values, and the existing test suite passes unmodified after group G1 and after every later group (9.1).

### 2.1 The record

New file `plugins/jev-router/providers.js`.

```js
/** @typedef {object} Provider  frozen; built once in apply() by resolveProviders(config, { policy })
 * @property {'jev'|'laya'} id
 * @property {'Jev'|'Laya'} name                  every UI string uses this
 * @property {boolean} teacher                    true only for jev: its answers teach domains, can be confirmed by an accepted run, and credit review evidence
 * @property {boolean} local                      true for laya: runs on this PC, needs no network
 * @property {string|undefined} model             sent as the request model: config.jevModel ('jev-1.13.0') | 'english';
 *                                                undefined on an old-form record made without one, so the SDK's own default applies as before
 * @property {{intent:number, route:number, review:number}|null} timeoutMs
 *                                                jev: config.jevTimeoutMs per attempt for every phase (null on an old-form record made without one,
 *                                                the SDK's own timeout); laya: null, the Laya client computes deadlines (section 4.5)
 * @property {number} maxRetries                  jev 2 (the SDK default, unchanged); laya 0
 * @property {number} usdPerInputToken            jev 0.042e-6 (usage.js JEV_USD_PER_INPUT_TOKEN); laya 0
 * @property {Thresholds} thresholds              every key of section 2.6, frozen
 */
export const TEACHER = 'jev'
export const DECIDER_IDS = Object.freeze(['jev', 'laya'])
export const providerName = (id) => ({ jev: 'Jev', laya: 'Laya' })[id] ?? String(id)
export const JEV_THRESHOLDS = deepFreeze({ /* the Jev column of 2.6 */ })
export const LAYA_THRESHOLDS = deepFreeze({ /* the Laya column of 2.6 */ })
export const MINIMUM_REVIEW_KEYS = Object.freeze(['riskForReview', 'riskForFrontierReview'])   // Jev reads these from routing.minimumReview only
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6   // moved here from usage.js, which re-exports it
export const DEFAULT_JEV = jevRecord({ model: 'jev-1.13.0', timeoutMs: 20000 })   // Jev as the Config defaults make it
export function jevRecord({ model, timeoutMs, thresholds }) { /* a Jev record: createJev's old form, router.js's default */ }
export function deepFreeze(v) { /* freezes a plain value and everything inside it */ }
export function resolveProviders(config, { policy, env = process.env }) {
  /* -> { jev: Provider, laya: Provider | null, layaError: string | null, layaSettings: object | null } */ }
export function validateThresholds(t, id) { /* throws Error('providers: laya.thresholds.accept: low 0.9 is above medium 0.8') */ }
export function thresholdsSchema(defaults, { omit = [] } = {}) { /* the Schemastery object for one provider's thresholds */ }
```

`layaSettings` is the validated `laya` block of 2.2 with every default filled and Laya's thresholds in it, deep-frozen, and null when `layaError` is set: `Config` declares `laya` as `Schema.any()`, so without it the sidecar and the Laya client would read the raw block with no defaults filled.
Jev's `Config` uses `thresholdsSchema(JEV_THRESHOLDS, { omit: MINIMUM_REVIEW_KEYS })`, because rows 20 and 21 of 2.6 keep `routing.minimumReview` as their one source for Jev, and a second home for them in `thresholds` would be silently ignored; `LAYA_SCHEMA` uses `thresholdsSchema(LAYA_THRESHOLDS)` with every key.
The price moved here from `usage.js`, which re-exports it, so `usage.js` can import `DEFAULT_JEV` without an import cycle; `scripts/jev-triage.mjs` still imports it from `usage.js`.

`Thresholds` is flat and reuses the names `config.thresholds` already has:

```js
{
  minQuestionConfidence, alsoWork,                          // adapter.js
  supportingSkill, verificationChecks,                      // jev.js profileFromAnswers
  continueHandoff, tool, toolArgConfidence, needsTests,     // router.js
  humanRequired,                                            // router.js
  judgmentYes, riskForReview, riskForFrontierReview,        // decision.js
  easyComplexity, requirementWanted,                        // decision.js, broker.js
  needsPerson, reject, accept: { low, medium, high },       // jev-review
  riskBands: { low, medium }, humanReview, secondOpinion,   // jev-review
  effortBands: { medium, high },                            // effort.js
}
```

The record deliberately carries **no key and no endpoint**.
Jev's key rotates at runtime on 429 and 402 (`index.js` `makeJev`), and Laya's key and port change on every sidecar start, so either would go stale on a long-lived record, and the record is something traces and the inspector show.
The key and the client are handed to `createJev` beside the record.

### 2.2 Where it is configured and validated

**Jev's record** is built from the keys that exist today, so no existing `cordis.patch.yml` changes meaning:
`credentialRef`, `jevModel`, `jevTimeoutMs`, `thresholds.accept|secondOpinion|humanReview|needsTests|tool`, and `routing.minimumReview` through `resolvePolicy()` for `riskForReview` and `riskForFrontierReview`.
The formerly hard-coded Jev cut-offs become new keys of `thresholds` in the `Config` schema (`index.js:84-238`), each with today's constant as its default: `minQuestionConfidence` 0.6, `alsoWork` 0.7, `supportingSkill` 0.15, `verificationChecks` 0.5, `continueHandoff` 0.5, `toolArgConfidence` 0.5, `humanRequired` 0.6, `judgmentYes` 0.5, `needsPerson` 0.6, `reject` 0.3, `riskBands` `{ low: 0.25, medium: 0.6 }`, `easyComplexity` 0.5, `requirementWanted` 0.5, `effortBands` `{ medium: 0.25, high: 0.6 }`.
`thresholds.humanRequired`, read today at `router.js:1061` but never declared, is declared.
`TYPESAFE_BASE_URL` keeps redirecting Jev exactly as today, because Jev decides as today; the Jev router card shows the host Jev calls go to, and when the variable is set it says so (section 8.1).

**Laya's record** comes from a new `laya` key in the same `Config` (from `cordis.patch.yml`, under `id: jev-router`), declared there only as `laya: Schema.any().default({}).description('The Laya decision model; validated by providers.js, see docs/laya-auto.md 2.2.')`.
The host validates `Config` before `apply()` runs and a Schemastery error there stops the whole plugin from loading, so a typed `laya` block in `Config` would let one bad Laya value take Jev Auto down.
Instead `providers.js` exports `LAYA_SCHEMA` and `resolveProviders` runs it inside its own `try/catch`:

```js
export const LAYA_SCHEMA = Schema.object({
  enabled: Schema.boolean().default(true).description('Offer Laya Auto and the Laya shadow once Laya is installed. Off, KzH never starts Laya.'),
  port: Schema.natural().default(8091).description('First 127.0.0.1 port for laya.serve; the next ones are tried when it is taken.'),
  connectivityUrl: Schema.string().default('http://www.msftconnecttest.com/connecttest.txt').description('What Laya Auto probes to learn whether cloud agents can run. Never a TypeSafe address.'),
  deadlines: Schema.object({
    floorMs: Schema.natural().default(8000),
    ceilingMs: Schema.natural().default(120000),
    hardMs: Schema.natural().max(290000).default(270000),   // below Node's own 300 s headers timeout (4.5)
    startWaitMs: Schema.natural().default(300000),          // the ready bound of 7.5
  }).default({}),
  shadow: Schema.object({
    maxQueue: Schema.natural().min(1).default(8),
    maxAgeMs: Schema.natural().default(600000),
    chunkRows: Schema.natural().min(1).default(4),
  }).default({}),
  temperatureCorrections: Schema.dict(Schema.number().min(0.2).max(5)).default({ 'choice:11+': 3.27 }),
  minTopMargin: Schema.number().min(0).max(1).default(0.1),
  thresholds: thresholdsSchema(LAYA_THRESHOLDS),
}).default({})
```

Validation runs twice, and both runs are inside `resolveProviders`.
Schemastery checks types and ranges: every threshold is `Schema.number().min(0).max(1)`, and `verificationChecks` and `needsTests` also accept the string `'always'`, which means "always require checks".
The sentinel is a string because Schemastery treats `null` as absent: an explicit `null` on a key whose default is 0.5 silently becomes 0.5, and a key whose default is `null` is left out of the validated object.
`resolveProviders` then fills every key the validated object lacks from `JEV_THRESHOLDS` or `LAYA_THRESHOLDS`, so no reader ever sees `undefined` for a threshold, and checks orderings: `accept.low <= accept.medium <= accept.high`, `reject < accept.low`, `riskBands.low < riskBands.medium`, `riskForReview <= riskForFrontierReview`, `effortBands.medium < effortBands.high`, and every `temperatureCorrections` key matches `^(choice|score|noul):(2|3-5|6-10|11\+)$`.
It also checks `connectivityUrl`: an `http` or `https` address whose host is neither `typesafe.ai` nor any name under it nor the host `TYPESAFE_BASE_URL` sends Jev to (read from `resolveProviders`' `env` option, `process.env` by default), because Laya Auto probes it before every route, chat-model pick and title and nothing in a Laya Auto session contacts TypeSafe (6.9, invariant 5); a value that is no such address would fail every probe and narrow every Laya Auto run to the local agents as if offline.
A bad Jev value throws in `apply()`, as a bad Jev threshold does today, because Jev's keys stay typed in `Config`.
A bad Laya value, a type or range error as much as an ordering error or a connectivity address Laya Auto may not probe, is caught there: it leaves the Jev record intact, sets `layaError`, takes Laya Auto out of the picker, turns the shadow off, and shows the message on the Laya card (section 8).

Per-PC switches the Settings card edits live in `~/.kzh/jev-router/laya.json`, written only by `laya-sidecar.js` `setSettings()` with per-field checks, as `local.json` is for llama models (section 7.6).

### 2.3 `createJev` (`jev.js`)

```js
export function createJev({ provider, apiKey, client, onTrace, onError, onCall })   // new form
export function createJev({ apiKey, model, timeoutMs, onTrace })                    // old form, still accepted: builds a Jev record from these
```

- `client` defaults to `new TypeSafeClient({ apiKey, defaultModel: provider.model, retry: { maxRetries: provider.maxRetries } })`, so the four test files that patch `TypeSafeClient.prototype.systemOne` (`adaptive`, `handoff`, `jev`, `policy`) and the 30 old-form calls keep working.
  A `local` record handed no client is refused (`createJev: Laya runs on this PC and needs its own client`), because the default client would send its questions to the TypeSafe host with whatever key the environment holds.
- `ask(phase, state, questions, signal, used, context)` changes in five small ways:
  1. The per-call options are `{ timeout: provider.timeoutMs?.[phase], signal, phase }`; the SDK copies only named fields in `#request` and ignores `phase`, and the Laya client reads it.
  2. Every call gets a `callId` (`randomUUID()`), carried by its trace, so a shadow answer pairs with it.
  3. A failed call calls `onError?.({ phase, callId, provider: provider.id, ms, error: { class, code, status, message } })` inside `try/catch` and then rethrows, and it never calls `onTrace`: every trace keeps `questions` and `usage`, so the consumers that read them today (`adapter.js` `line()`, the inspector's `traces.flatMap((t) => t.questions)` at `client.js:1224` and `:1567`, and the usage row `index.js` writes for every trace at `:914`) never meet a trace without them, and until G6 and G8 wire `onError`, a failed call is exactly as silent as today.
  4. Before sending, `ask` deep-freezes `questions` (the objects the SDK builders returned, which hold references to the `jev.js` criteria constants) and calls `onCall?.({ callId, phase, state, questions, used, context })` synchronously inside `try/catch`; if it returns a function, `ask` calls that function with `{ trace }` or `{ error }` once the acting call settles, also inside `try/catch`, and never awaits anything it returns (section 5).
     `context` is the numbers-only object the caller passed, for the review `{ attempt, risk, blockAccept, reviewed }` (below), else `null`.
     The settle function and `onError` are called before `onTrace`, so an `onTrace` that throws, which still breaks the call as it always did, can never leave a shadow job unsettled; the settle function gets the raw error as `{ error }`, and `onError` the `{ class, code, status, message }` summary.
  5. `res.meta`, when the client supplies it, is copied onto the trace, and `route()`, `intent()` and `assess()` return it as `meta`, so `decision.js` and `jev-review` store its `identity` and `lang` on a Laya sample (6.2) and Laya's standing reads Laya Auto runs under the identity that decided them (6.7).
- The `jev.js` criteria constants that the builders are handed by reference (`TASK_TYPES`, `TIERS`, `COMPLEXITY_LEVELS`, `RISK_LEVELS`, `REQUIREMENT_LEVELS`, `VERDICTS`, `DISPOSITION_CRITERIA`, `jev.js:20-107`) are deep-frozen at module load, because the SDK keeps a reference to them in every question and the shadow receives those same objects: an adapter that rewrote one in place would change every later Jev request in the process.
  The `SKILLS`, `STRATEGIES` and `CAPABILITIES` texts reach a question only as strings inside objects built per call, so no file outside `jev.js` changes for this.
- `ask()` already tolerates a client without `withResponse()` (`jev.js:480-482`), so the Laya client returns a plain promise and `requestId` is `undefined`.
- `traceOf` gains `callId`, `provider`, `meta`, and, per question, `informative`, `corrected` and `servedConfidence` when the answer carries them.
  `trace.provider` is the provider's id (`'jev'` or `'laya'`), the value `onError` and the usage rows carry too, and every display string comes from `providerName(id)`.
- `profileFromAnswers(answers, thresholds)` reads `thresholds.supportingSkill` instead of 0.15 and `thresholds.verificationChecks` instead of 0.5, where `'always'` always adds `'checks'`.
  It leaves out every **score and choice** marked `informative: false` and lists their names in `profile.filledByRules` (section 4.3).
  A noul keeps its value even when it is marked flat, because every noul bar that reads a profile field sits away from 0.5 and a flat answer simply falls below it (no handoff, no human-review flag), and Laya's `needsTests` is `'always'`; `filledByRules` never names a noul.
- **The flat-answer contract.** `route()`, `intent()` and `assess()` each return `uninformative: string[]`, the names of the questions whose answer carried `informative: false`, computed generically as `Object.keys(answers).filter((n) => answers[n].informative === false)`; with Jev it is always `[]`.
  This is the only way a caller learns that an answer outside the profile was flat: `route()` returns `strategy` as `{ choice, confidence, probabilities }` and `secondOpinion` as a bare number, the resource and judgments call has no profile at all, `intent()` returns `depth` as a bare choice, and `assess()` returns `disposition`, `reviewAgent` and `retryAgent` with no flag.
  Who reads it is fixed in 2.5: `decision.js` for `taskType`, `skill`, `strategy` and `secondOpinion`; `jev-review` for `disposition`, `reviewAgent` and `retryAgent`; `classify` for `depth`.
- `assess(input, signal, context)` takes the numbers-only `context` that `jev-review` fills (`{ attempt: attempts.length - 1, risk: routing.risk ?? null, blockAccept, reviewed }`) and hands it to `ask`, because `blockAccept` and `reviewed` are computed in `router.js`, reach `jev-review` only, and are not in the review state; the shadow needs them to compute the review action both providers would have taken (5.5).
- `assess()` returns `model` (the served model); today it drops it (`jev.js:836-852`), so outcome samples store `teacher.model: null`.
- The returned object gains `provider`, the record, so every consumer reads `jev.provider.thresholds` and `jev.provider.name`.

No Laya code enters `jev.js`: rendering, normalisation and the gate all live in the Laya client, and the `informative` flag is read generically, whoever set it.

### 2.4 `index.js`

- `apply()` calls `resolveProviders(config, { policy })` once; the result is `providers`.
- `apply(ctx, config, { laya, local })` takes a third argument for tests only (Laya's harness folder and the supervisor's seams, and stand-ins for the local models' methods); the host passes two, so nothing changes for it.
- Before anything else, `apply()` runs the sidecar's orphan sweep (7.5), so a Laya left running by an engine crash never holds memory while the card says stopped.
- `makeJev({ onTrace, runId, emit })` becomes `makeDecider(id, { onTrace, onError, runId, emit, signal })`.
  - `'jev'`: today's function (accounts key first, then `config.credentialRef`, rotation on 429 and 402), building `createJev({ provider: providers.jev, apiKey, onTrace, onError, onCall })`, where `onCall` is `shadow.offerer({ runId })` when the shadow is on (section 5.1).
    A rotation repeats the call on a new client, so `ask` and `onCall` run twice for one logical call; the first settle function receives the 429 or 402 as `{ error }`, and the shadow withdraws that job (5.2), so one logical call yields at most one compared row.
  - `'laya'`: `layaUnavailable('act')` first (below), then `createJev({ provider: providers.laya, client: layaClient.client('act', { runId, onWait }), onTrace, onError })`; no accounts, no rotation, no shadow.
    The acting client calls `sidecar.ensureReady` before every request, not once per run (4.5).
  - `onTrace` logs through `usage.logDecision` (2.5) instead of `usage.logJev`; `onError` emits the live event `{ type: 'decider-error', at, error }` (3.3), whose `error` is the argument `onError` got, `{ phase, callId, provider, ms, error }`, and logs nothing to `usage.jsonl`.
- **One run id per run.**
  `route()` mints its `runId` before `logRun`, and `logRun(sessionId, task, runId)` uses it as `entry.id`, so the inspector's live run, `POST /jev-router/runs/stop`, the task record (`tasks.js` `runId: entry.id`) and the shadow route all carry the same id.
  `route()` passes it into `runRouted` as `deps.runId`, and `router.js` uses `deps.runId ?? randomUUID()` instead of minting its own at `router.js:494`.
  Today usage rows carry `index.js`'s id, the inspector and Stop carry the log entry's (`index.js:1022`), and samples and history carry `router.js`'s, so nothing could join a shadow row, a usage row, a live run and a sample; after this change `usage.jsonl`, `history.jsonl`, both sample stores, `laya-shadow.jsonl` and the inspector's run share one id.
- `layaUnavailable(role)` is the one function that decides whether Laya can be asked at all, called by `route()` for every decider `'laya'` run (so by `stream()`, background tasks and `/laya` alike) and by `classify`: in order, not installed, `laya.enabled` false, `layaError`, `config/laya.json` unreadable, `routing.enabled` false (for `route()` only), and the sidecar state `failed`; it throws `LayaUnavailable` with the exact 3.5 text, which `stream()` shows as its reply and a task or `/laya` shows as its error.
  `route()` with decider `'laya'` refuses when `providers.laya` is null and never falls back to `DEFAULT_JEV` or to the old-form Jev record.
- `classify(message, mode, decider = 'jev', { onWait })`:
  - `'jev'`: unchanged.
  - `'laya'`: never probes TypeSafe.
    After `layaUnavailable('intent')`, it asks Laya's intent through `makeDecider('laya')`, whose client waits for a start exactly as a routing call does, bounded by `startWaitMs` plus the intent deadline, and emits the `Starting Laya` line through `onWait`.
    Only a refusal, a failed start or a timeout gives `{ kind: 'task', unsure: true, why: 'Laya could not sort this message (<reason>); treating it as a task.' }`; the adapter's No project branch treats `unsure` as the answering side, as the comment there already asks (`Unsure stays on the answering side here`, `adapter.js:461-466`).
  - When `uninformative` lists `depth`, the result's `depth` is `undefined`, so the adapter keeps the cheap default.
  - The result carries `thresholds: providers[decider].thresholds`, so the adapter's bars are the answering provider's.
- The adapter's own connectivity check becomes `isOffline(decider)`: `index.js` hands `jevAdapter` a function that probes `laya.connectivityUrl` for `'laya'` and `api.typesafe.ai` for `'jev'`, and `adapter.js` calls it with the row's decider in `chatModels` (`adapter.js:296`) and in the side-request path for session titles and compaction (`adapter.js:390`), so no path of a Laya Auto session contacts a TypeSafe host.
- `route({ ..., mode, decider = 'jev' })`:
  - `'jev'`: `offline` and the decider exactly as today.
  - `'laya'`: `layaUnavailable('act')` decides whether it runs at all; `offline` comes from `layaConnectivity.online()`, a second `createConnectivity({ urls: [config.laya.connectivityUrl] })`, and only narrows the pool; `deps.decider` is the Laya instance.
    Once the decider is made and before anything runs, `route()` waits for Laya's start (`ensureReady`, with the `Starting Laya` line), so a start still pending past `startWaitMs`, or one that failed, refuses the run before anything has run, as 3.5 says, rather than surfacing only as a failed first call of a run the rules then decide; later calls still wait for their own start through the client.
  - `deps.provider = providers[decider]` is always passed, so thresholds exist even when the decider is null.
  - While a Laya-decided run is open, from the moment it holds its workspace's lane and has its inspector entry to its return, it holds the sidecar (`sidecar.hold(runId)` and `release(runId)`, 7.6), so neither the idle stop nor the watchdog takes Laya away between its calls.
    The hold does not cover a wait for the lane behind another task, which would keep Laya loaded, and keep it from giving its memory to a local model, for no Laya call; `layaUnavailable` still refuses before the lane.
  - After a Laya-decided run, `learnFrom` runs and `maybeRetrain` does not: the evaluation pass stamps and persists every Jev domain state file (`domains.js:586, 609`), and a Laya run gives those domains nothing new to evaluate.
    `noteResources` still runs, because a new agent is a fact about the pool, whoever routed.
- `learnFrom(record, samples)` builds the review's `outcome_disposition` entries with the store the run's decider names (`record.routing.decider === 'laya' ? 'laya' : 'jev'`), as it does for `decisionSamples` (6.3).
- Tasks: the adapter hands `orchestrator.enqueue` the row's `decider`, and for a message the decider could not sort the `why` its line says, as a second argument, `enqueue(fields, { decider, why })`, so the task's own fields stay the ones `test/tasks.test.js` checks; `tasks.enqueue` takes `decider`, `tasks.js` adds it to `SAVED`, and `run()` passes `t.decider ?? 'jev'` to `route()`, which applies `layaUnavailable` when the task runs, however long after it was queued.
- A `/laya <task>` command is always registered beside `/auto` (`index.js:1310`) and calls `route({ task, agent, signal, decider: 'laya' })`, so one task can be sent to Laya from a Jev Auto session; when Laya cannot be asked it answers with the same 3.5 refusal text.
- The two sample stores, the sidecar, the Laya client, the shadow and the residency registry are created in `apply()` and disposed with `ctx.effect`; the sidecar's `readBudget` is wired to `local.readSettings()` (7.4).
- The HTTP routes of section 8.4 are added, `GET /jev-router/setup` gains `laya: sidecar.status()` beside `jev.host` and `jev.hostFromEnv` (8.1), and `GET /jev-router/local` carries Laya's status of 8.4 as `laya` while Laya is installed, which the budget table reads (7.7).

### 2.5 `router.js`, `decision.js`, `jev-review`, `adapter.js`, `usage.js`, `effort.js`, `broker.js`

- **`router.js`** `runRouted`: `const P = deps.provider ?? jevRecord({ thresholds: config.thresholds })`, `const T = P.thresholds`: for old callers a Jev record on the thresholds they pass through `config.thresholds`, which `DEFAULT_JEV` would ignore; with the default thresholds the two are the same.
  Every cut-off of 2.6 that lives in `router.js` reads `T`, and `createReview(deps.decider ?? deps.jev, T, ...)` gets the provider's thresholds.
  `deps.jev` stays accepted as an alias of `deps.decider`.
  The mode branches are in 3.2.
- **`decision.js`** `decide({ ..., decider, provider, sink })`, with `jev` kept as an alias of `decider`:
  - `provider` is always the record passed by the router, never read off the client, so a missing client can never make a Laya run use Jev's record.
    A caller that passes none decides as Jev on `DEFAULT_JEV`'s thresholds, and for Jev, record or not, rows 20 and 21 (`riskForReview`, `riskForFrontierReview`) come from `policy.minimumReview`, their one source (2.6), so a caller with a configured `minimumReview` decides exactly as before.
  - Every literal `'jev'` authority (`decision.js:386, 396, 413, 567, 661`) becomes `provider.id`.
  - Every controller call passes `answeredBy: provider.teacher ? 'jev' : provider.id`, and `sink` only when the provider is not the teacher (6.3): a Jev run writes each domain's own store even when a caller hands it a sink, so one sink wired for every run can never send Jev's samples to the Laya store, which would refuse them.
  - `askJev` keeps its name and batching; `jevCalls` keeps its name and counts calls to the answering provider, and every string that prints it names `decision.decider` (3.3).
  - The cut-offs reach the rest through a per-run policy object, `const pol = { ...policy, minimumReview: { riskForReview: T.riskForReview, riskForFrontierReview: T.riskForFrontierReview }, requirementWanted: T.requirementWanted, easyComplexity: T.easyComplexity, judgmentYes: T.judgmentYes }`, which `candidateTier` and `broker.js` `rankCandidates` already receive, so no new parameter crosses into `broker.js` and nothing is added to the stored profile.
  - `rawOf(d) = d.provider?.raw ?? d.teacher?.raw` replaces every read of `d.teacher.raw`.
  - The task domain's `extra` stores the numeric profile as `extra.profile` only when `provider.teacher`, else as `extra.providerProfile` (6.6).
  - Each teacher closure passes the answer's flat flag to the controller from the route answer's `uninformative` list (2.3): `informative: !r.uninformative?.includes(name)` with `name` `taskType` for `task_classification`, `skill` for `skill_selection`, `strategy` for `execution_strategy` and `secondOpinion` for `second_opinion`; `decide()` reads it (6.3).
  - When the provider's profile lists `filledByRules`, the profile is `fillFlat(heuristicProfile(task), raw.profile)`, a per-field merge: each top-level field Laya answered is taken from Laya; `requirements` is merged per dimension, `{ ...heuristic.requirements, ...answered(raw.profile.requirements) }`, so a flat `req.*` is filled at the heuristic's 0.7 when its task type exercises that dimension and is otherwise absent, which reads as not wanted; flat `minimumCapability` and `preferredCapability` take the heuristic's fixed `'standard'` and `'strong'`; and `heuristic: true` is deleted, so the skill authority (`decision.js:404`) is not reported as `fallback` for a profile that is mostly Laya's.
    A Jev profile never lists `filledByRules`, so Jev is unchanged.
  - When only Laya's task type was too flat, `task_classification` records `fallback` for the type, and the profile still takes Laya's informative fields from the route answer `askJev` already holds, merged the same way, instead of today's whole `heuristicProfile(task)` (`decision.js:389`).
    The tool pick stays as Laya answered it too: `handler`, `handlerConfidence`, `toolFits`, `toolArgConfidence` and `toolArgs` are kept, so only the type comes from the rules; a Jev run never reaches this branch with a teacher answer.
  - The decision object gains `decider: provider.id`, and its report of a domain carries the provider's answer as `provider: { label, confidence, informative }` where there is one.
- **`broker.js`**: `evidenceTrust` reads `policy.requirementWanted ?? 0.5` instead of 0.5 (`broker.js:50`).
- **`effort.js`**: `autoLevel({ complexity, risk }, bands = { medium: 0.25, high: 0.6 })` and `toAgentEffort(level, agentDef, { ..., bands })`; `router.js` passes `T.effortBands`.
- **`plugins/jev-review/index.js`**: `createReview(decider, thresholds, unavailableReason, { outcome, modelOf })` keeps its signature.
  - `review()` computes `const mode = decider?.provider?.id ?? 'jev'` once, at its top, and the assessment's `mode` is `mode` instead of the literal `'jev'`.
  - The policy branch `if (a.mode === 'jev')` becomes `if (DECIDER_IDS.includes(a.mode))`, and `domain?.authority === 'jev' && domain.teacher?.raw` becomes `domain?.authority === mode && rawOf(domain)`, with `a = rawOf(domain)`; it reads `mode`, never `a.mode`, because on the success path `a` is still unassigned there (`jev-review/index.js:63, 83`).
  - `assess` is called as `jev.assess(input, signal, { attempt: attempts.length - 1, risk: routing.risk ?? null, blockAccept, reviewed })` (2.3).
  - The outcome teacher closure passes `informative: !raw.uninformative?.includes('disposition')`; under Laya a flat disposition still gives authority `'laya'` with the raw assessment (6.3), so the review action comes from Laya's nouls and the deterministic accept or retry applies only when Laya gave no answer at all.
  - `NEEDS_PERSON`, `REJECT` and the risk bands read `thresholds.needsPerson`, `thresholds.reject` and `thresholds.riskBands`, falling back to today's constants when an old-shape thresholds object is passed.
  - The noul policy moves into an exported pure function, `reviewAction(a, { risk, blockAccept, reviewed }, thresholds) -> { action, why, quality, bar }`, which `shadow-stats.js` reuses.
    Under Laya, a review that stops below accept says so in `why`: `quality 0.52 under Laya's accept bar 0.80 (risk 0.50)`.
  - A `reviewAgent` or `retryAgent` listed in `uninformative` is replaced by `pickOther({}, last.agent)`, the deterministic peer pick the fallback path already uses, and `why` says so (`; Laya's review and retry picks were too flat to use, so the peer rule stands in for them`).
    Its probabilities are deleted with it, because the router picks the reviewer from `reviewAgentProbabilities`, and a flat distribution kept there would still rank by noise.
  - A `disposition` listed in `uninformative` labels the outcome sample and nothing else: the router, which reads the disposition for who reviews and who retries, is handed the one the review action implies (none for a retry), its confidence and probabilities are deleted, and `why` adds `; Laya's disposition was too flat to use, so the review action stands in for it`.
  - When no domain is wired and the Laya call fails, the reason is `Laya unavailable (<message>)`, so both paths name the provider (3.5); a Jev failure keeps today's `describeError(err)`.
- **`adapter.js`**: section 3.1 and 3.3.
  `isQuestion(cls)` reads `cls.thresholds?.minQuestionConfidence ?? 0.6`, and the also-work test reads `cls.thresholds?.alsoWork ?? 0.7`.
  `isOffline(decider)` replaces `isOffline()` in `chatModels` and the side-request path (2.4), and `line()` gains the `'decider-error'` case (3.3).
- **`usage.js`**: `logDecision({ provider, tokens, ...entry })` appends `{ agent: provider.id, ..., costUsd: tokens.input * provider.usdPerInputToken }`; `logJev` stays as an alias for the Jev record.
  Only acting calls that answered are logged (a failed call reaches `onError`, never `onTrace`); shadow calls never reach `usage.jsonl`, so Laya never appears in spend.
  The Jev monthly spend already counts `agent === 'jev'` rows only (`usage.js:205`), and so does the decisions part of `computeSavings` (`usage.js:347`).
  The rest of `computeSavings` does not: direct answers are `agent: 'chat'` rows and tool runs and limits avoided come from every `history.jsonl` run (`usage.js:356-371`), so a Laya Auto question, tool run or skipped limited agent would be counted in "Saved by Jev".
  So direct-answer rows gain `decider` (`index.js:1455`, from the row the question came through), `computeSavings` counts only rows and runs whose `decider ?? 'jev'` (`routing?.decider` for runs) is `'jev'`, and the Usage tab shows Laya's own line (3.3); Laya is never priced at $0.042 per million and never counted in "Saved by Jev".
  Each period of `computeSavings` gains `layaDecisions` and `layaTokens: { input, output }`, the numbers that line prints, since `usage.js` is the one reader of `usage.jsonl`.

### 2.6 Every Jev-calibrated cut-off, per provider

Laya's starting values follow three rules, stated once so each row does not repeat them.
**Rule A:** where the two errors cost differently, Laya's bar moves so that the error Laya is more likely to make is the one that is cheaper to recover from, because Laya is zero-shot on KzH's questions and ships over-confident (mean ECE 0.466, roadmap section 2).
"Cheaper to recover from" is not always the cheaper run: a review run costs money and catches a mistake, while a skipped review can ship one, so each row below names the direction it picks.
**Rule B:** where the cut is the midpoint of a yes/no label that is stored and later scored, it stays 0.5, because moving it would change what the stored label means.
**Rule C:** where a cut reads an expected score, a flatter distribution regresses toward 0.5, so no Laya cut on an expected score sits at 0.5: the informative filter of 4.3 tests the top probability, not the expected value, so an answer such as `[0.17, 0.17, 0.32, 0.17, 0.17]` passes it with a risk of exactly 0.5.
Laya's choice and score confidences are max probabilities after section 4.3, not Laya's served entropy figure, so a Laya bar reads "the answer's own probability".
None of these values is a calibration; section 10 names the data that will set them.

| # | Today | What it gates | Key | Jev | Laya | Why Laya's value |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `adapter.js:55` `MIN_QUESTION_CONFIDENCE` | a message read as a question skips the agents | `minQuestionConfidence` | 0.6 | 0.8 | A, toward a task: a wrong "question" sends real work to a chat model that cannot touch files; 0.8 is 4:1 on a two-way choice. |
| 2 | `adapter.js:60`, read at `:493` `ALSO_WORK` | queue background work from a question | `alsoWork` | 0.7 | 0.8 | A, toward no background run: a wrong yes starts a run nobody asked for. Laya issue #156 is the opposite error (a confident no on clearly positive input), which this bar does not guard against; Test Laya measures it (4.6). |
| 3 | `jev.js:447` | supporting skills from the skill distribution | `supportingSkill` | 0.15 | 0.2 | Fourteen options put uniform at 0.071, and after the 11+ correction Laya's distributions are flatter; a wrong hint is cheap either way. |
| 4 | `jev.js:450` | `'checks'` in the profile's verification | `verificationChecks` | 0.5 | `'always'` | A, toward checks: skipping checks on a wrong "no" is the expensive mistake. |
| 5 | `router.js:1006` `thresholds.needsTests` | require checks before accepting | `needsTests` | 0.5 | `'always'` | A, toward checks, and `undefined >= 0` is false, so a numeric 0 would skip checks whenever Laya gave no answer. |
| 6 | `router.js:980` | hand the earlier note to the agent | `continueHandoff` | 0.5 | 0.6 | A, toward no handoff: a wrong yes injects stale context; a wrong no keeps the note on disk. |
| 7 | `router.js:987` `thresholds.tool` | run a fixed tool instead of an agent | `tool` | 0.5 | 0.8 | A, toward an agent: a tool on a misjudged fit does the wrong work with no judgment. #156 would push `fits` toward no, which errs the same way. |
| 8 | `router.js:988` (hard-coded) | the weakest tool-argument choice | `toolArgConfidence` | 0.5 | 0.7 | A, toward an agent, on max probability. |
| 9 | `router.js:1061` `thresholds.humanRequired ?? 0.6` (undeclared) | stop the run as `needs_human` | `humanRequired` | 0.6 | 0.8 | A, toward running: capability has up to 11 options and is re-tempered when it has 11; stopping ordinary work on an unsure answer is the error the code comment warns about, and the review's `needsPerson` still catches a blocked agent. |
| 10 | `decision.js:547, 557` | the second-opinion label from P(true) | `judgmentYes` | 0.5 | 0.5 | B. The code rule's own outputs (0, 1, or the `codeJudgments` cuts) keep 0.5. |
| 11 | `jev-review:18` `NEEDS_PERSON` | review action `human` | `needsPerson` | 0.6 | 0.6 | Kept at Jev's value. #156 is a confident no on clearly positive input, so a higher bar would add to the documented miss: a blocked agent's question would reach the person less often and cost a retry run more often. It moves only when the Test Laya pairs (4.6) show which way any bias goes under the labels workaround. |
| 12 | `jev-review:19` `REJECT` | quality at or below it: retry | `reject` | 0.3 | 0.3 | Neither side is safe (a retry costs a work run, the band above it a review run); measured by the review action in 5.5. |
| 13-15 | `jev-review:118` | accept bar by risk band | `accept.low/medium/high` | 0.55 / 0.70 / 0.85 | 0.65 / 0.80 / 0.90 | A, toward another review: accept is the one review action that ends the run with nobody else looking; failing checks still block accept in code. The cost is visible, not silent: the English noul temperature (1.98) pulls every P(true) toward 0.5, so many Laya reviews will stop below these bars, and each says so in its `why` (2.5) and is counted in the comparison (5.5, 8.4). |
| 16-17 | `jev-review:118` (`< 0.25`, `< 0.6`) | the risk bands for 13-15 | `riskBands.low/medium` | 0.25 / 0.6 | 0.25 / 0.6 | Level boundaries on the provider's own risk; 13-15 already moved. |
| 18 | `jev-review:137` `thresholds.humanReview` | status `accepted_pending_human_review` | `humanReview` | 0.7 | 0.6 | A, toward the flag: a flag, not a block; flagging more is the safe side. |
| 19 | `jev-review:47` `thresholds.secondOpinion` | a second opinion for a run with no routing decision | `secondOpinion` | 0.6 | 0.6 | Inert under Laya, so it keeps Jev's value: Laya Auto always has a routing decision whose `second_opinion` label `wantsSecondOpinion` reads first, and its manual branch (a local effort, 3.1) and its fallback branch carry no `needsSecondOpinion`, so `(undefined ?? 0) >= bar` is false whatever the bar. |
| 20 | `routing-policy.js:315` `riskForReview`, read at `decision.js:608, 670, 679` | review when no answer; the conservation limit | `riskForReview` | 0.6 | 0.45 | C and A, toward a review and away from conservation: a flat or unknown risk, 0.5, is at or above the bar, so it gets a review and the scarce resource keeps the work. |
| 21 | `routing-policy.js:315` `riskForFrontierReview`, read at `decision.js:640, 677` | frontier review; the cheap-execute fallback | `riskForFrontierReview` | 0.8 | 0.7 | C, toward the stronger reviewer: it costs a frontier review run where Jev would not ask for one, and a mistake a weaker reviewer misses is the dearer error. |
| 22 | `decision.js:608` | move easy work off the scarce resource | `easyComplexity` | 0.5 | 0.4 | A, toward keeping the work on the scarce resource: conserve only when Laya says clearly easy; the cost is allowance spent that Jev would have saved. |
| 23 | `decision.js:191, 678, 721`; `broker.js:50` | a requirement counts as wanted | `requirementWanted` | 0.5 | 0.6 | C, toward fewer wanted dimensions: regression toward 0.5 would otherwise mark most dimensions wanted and demand stronger tiers on noise. This direction is the cheaper run and the riskier one; a pick too weak for the work shows up as a failed check or a review that does not accept, which the bars of rows 13-15 and 20-21 already lean against. |
| 24-25 | `effort.js:100-101` | effort medium, high, xhigh | `effortBands.medium/high` | 0.25 / 0.6 | 0.25 / 0.6 | Cost against quality with no safe side; kept, now on the record. |

For Jev, rows 20 and 21 keep their single source, `routing.minimumReview`, and every other row comes from `thresholds` with today's value as the default, so a Jev run makes exactly today's decisions.

Cut-offs that stay shared or Jev-only, on purpose:

- `router.js:840-842` `policy.minRoutingConfidence` 0.5 and `policy.tieMargin` 0.1: under adaptive routing they read the code ranking's confidence, which no provider produces, and the legacy named path that read Jev's answer is never Laya's, because `route()` refuses every decider `'laya'` run while `routing.enabled` is false, whatever sent it (`layaUnavailable`, 2.4).
- `features.js:164` (requirement 0.5 in the classifier's features): a feature definition, and per provider it would make one feature mean two things inside one training set.
- `decision.js:166-169` class-profile cuts: they read class means of Jev teacher numbers, and no Laya number reaches the Jev store (6.1).
- `profiles.js:771` (credit only mode `'jev'`) and `:778` (`independent_review` at 0.7): Laya reviews credit nothing (6.6).
- `broker.js:105` `demand = max(complexity, risk)`: a continuous weight, not a cut.
- `routing-policy.js` `codeJudgments.frontierReview`: code's own outputs, not a cut on a provider's answer.
- `scripts/jev-triage.mjs:52` `CONFIDENT 0.7`: a Jev-only developer script with its own client, part of no mode.

---

## 3. The Laya Auto mode

### 3.1 The picker row

`JEV_MODELS` in `adapter.js` gains a `decider` field on every row and one new row, placed right after `jev-auto` (key order is menu order):

| id | name | mode | decider | offered when |
| --- | --- | --- | --- | --- |
| `jev-auto` | Jev Auto | auto | jev | always |
| `laya-auto` | Laya Auto | auto | laya | Laya is installed, `laya.enabled` is not false, no `layaError`, and `routing.enabled` is not false |
| `jev-online` | Jev Auto · Online | online | jev | a local agent exists (unchanged) |
| `jev-local` | Jev Auto · Local | local | jev | as today |
| `jev-offline` | Offline · Local only | offline | jev (never called) | as today |

Description of the new row, exact:
"Laya, a decision model on this PC, routes every message and reviews the result instead of Jev. No Jev call is made and no routing or review question leaves this PC; offline it keeps routing, to the local models. The agent it picks still sees your task and code, and questions are answered by the chat model as in Jev Auto."
`listModels` appends one sentence by state, and the sidecar emits `llm/adapters-updated` on every state change so the menu refreshes:

| Laya state | Sentence appended |
| --- | --- |
| Ready on the GPU, measured | `Measured on this PC, on the GPU: about <r> s to route a task and <v> s to review each attempt.` |
| Ready on the CPU, measured | `Measured on this PC, on the CPU: about <r> s to route a task and <v> s to review each attempt.` |
| Not measured yet | `Not measured on this PC yet.` |
| Installed, not running | `Laya is not running; the first message starts it (the last start took <s> s).` |
| Failed | `Laya could not start: press Start in Settings → Jev setup → Laya decision model.` |

`<r>` is the measured intent, task group and resource and judgments calls together, and `<v>` the measured review call, both from the per-phase figures of 4.5, so the sentence gives what a task costs rather than one call.
The calls are sized from `laya-selfcheck.js`, each rendered as the Laya client sends it: for `<r>`, `taskCalls()`, being Test Laya's intent on a clear task, its route call, and a resource and judgments call for the same rename task over three candidates; for `<v>`, Test Laya's review call.
`index.js` hands `jevAdapter` two functions for the row: `layaRow()`, which answers `{ state, device, routeMs, reviewMs, lastStartMs }`, or null while the row is not offered, and `layaUnavailable(role)`, whose refusal `stream()` shows as its reply.
The measured sentence is read from the device Laya runs on, or would start on, whatever the state, so a restart, a start not yet launched or an update in progress never calls a measured Laya unmeasured; an update that failed over a stopped Laya reads as `Installed, not running`, since the old install is untouched and the first message starts it.

- `modeOf(model)` becomes `rowOf(model) -> { mode, decider }`; an unknown id still maps to Jev Auto, but `laya-auto` is always a known id and `resolveModel` always resolves it, so a saved selection never silently becomes Jev.
- The group heading (`providerInfo` name, `adapter.js:327`) changes from `Jev` to `Kz-harness`, because the group holds Laya Auto and the plain agent rows too; the route id stays `jev`, so `settings.yaml`, the installer's `agent-default-model: jev / jev-auto` and every saved bookmark are untouched.
- No second Laya row is added: offline, Laya Auto narrows the pool to local agents itself (3.5), and a `local-low` or `local-high` effort forces the agent exactly as it does under Jev Auto.
- Under a local effort, `stream()` sets `forceAgent` and skips `classify` (`adapter.js:370-379, 436`), and the router takes the manual branch (`router.js:711`), so Laya routes nothing and still reviews; the heading reads `**Laya router** · MANUAL /<agent>`, and the `decider` stays `laya` because the effort override changes only `mode`.
- `deepNote` reads "Laya judged this worth the stronger model, so " under Laya.
- `queuedLine` says "Laya picks" instead of "Jev picks" for a Laya task, and appends the `why` that `classify` returned.

### 3.2 `routing.mode` and `routing.decider`

`routing.mode` keeps its five values and their meaning (how the pool and the decision path were chosen): `'jev'` now reads "a decider routed over the full pool".
A new `routing.decider` (`'jev' | 'laya'`) names which one, and is stored in `history.jsonl` with the rest of `routing`; old rows without it read as `'jev'`.
It is called `decider`, not `provider`, because `provider` already names an agent's executor kind and the DSH route in this code.
Laya runs also record `routing.model` as the Laya model label (3.3), `routing.deciderErrors: [{ phase, reason }]` for every Laya call that did not answer, `routing.deciderMs`, the time of the route calls that answered, as `runRouted` measured it, and `routing.deciderDevice` when the optional `deps.deciderDevice()` names one, so the report can say `2 Laya calls (21.4 s on the CPU)`; a Jev run records no errors, time or device, so its history row is unchanged.

What the branches keyed on `'jev'` do under Laya:

| `router.js` | Branch | Under Laya |
| --- | --- | --- |
| 711 | manual (forced agent) | Unchanged; Laya reviews. |
| 713 | `else if (deps.offline)`: fixed rule | Becomes `else if (deps.offline && !P.local)`. Offline Laya Auto takes the decision engine over local agents (`mode: 'local'`); Jev rows are unchanged. |
| 736, 752 | `mode: localOnly ? 'local' : 'jev'` | Unchanged, plus `decider: P.id`. |
| 784 | refuse a named capability nobody can do | Same rule; the message names no decider. |
| 842 | tie-break (legacy path) | Unchanged; it reads the code ranking's confidence (2.6). |
| 893 | feedback prior | Unchanged: it weighs the person's verdicts about agents, whoever routed; only `verdictWeight` reads a verdict about a Laya-decided run as one of unknown type, so Laya's label never sets its weight (6.6). |
| 980 | continue handoff | `T.continueHandoff`. |
| 987-988 | run a tool | `T.tool`, `T.toolArgConfidence`. |
| 1006 | require checks | `routing.mode !== 'jev' \|\| T.needsTests === 'always' \|\| routing.needsTests >= T.needsTests`. |
| 1060-1061 | stop as `needs_human` | `T.humanRequired`; reason text `Laya read this as needing a person (confidence 0.85)`, in the number format Jev's reason has always had. |
| 1424-1426 | agent strip router step | `{ agent: P.name, model: routing.model }` when any domain's authority is `P.id`. |
| 1446-1456 | heading and profile lines | 3.3. |

`client.js` reads the mode too: `WhatHappened` (`client.js:1255-1262`) and `HistoryRunDetail` (`client.js:3025`) read a run whose mode is `'jev'` or `'local'` as a pick by its decider, as `router.js` records both, and print `Laya picked <agent> (confidence 41.0%)` when `routing.decider === 'laya'` and `Jev picked` otherwise, so a Jev Auto · Local run and an offline Laya Auto run read as picks, live and in the stored record alike.

### 3.3 What the person sees

Report heading (`router.js` `formatReport`): `**${P.name} router** · ${modeLabel}`, exact examples:

- `**Laya router** · AUTO (Laya and routing rules decided)`
- `**Laya router** · AUTO (Laya, routing rules and the safe fallback decided)` when some domains fell back (`decidedBy` composes it)
- `**Laya router** · AUTO (Laya and routing rules decided), LOCAL MODELS ONLY · OFFLINE: local models only` offline
- `**Laya router** · MANUAL /qwen-local` under a local effort
- `**Laya router** · AUTO, LAYA UNAVAILABLE: routing fallback activated` when the decision engine threw, followed by `Fallback reason: <reason>. Default agent: <agent>` (today's line)

Lines under the heading, added:

- `- Filled by the routing rules (Laya's answers were too flat to use): risk, req.planning` when `profile.filledByRules` is not empty.
- `- Laya did not answer: route: timed out after 42 s (20 questions on the CPU)`, one per `routing.deciderErrors` entry.
- `- Decided by: task_classification laya · skill_selection laya · resource_selection code · ... · 2 Laya calls (21.4 s on the CPU)`; a Laya-decided run reports `maturity: null` for every domain (6.3), code-taught ones included, so no maturity bracket is printed: the local ladder's rung says nothing about a Laya run.
- `- Review: second_review. quality 0.52 under Laya's accept bar 0.80 (risk 0.50)` when a Laya review stops below accept (2.5).

`decidedBy()` (`adapter.js`) gets `'laya'` in `AUTHORITY_ORDER` (`['local', 'jev', 'laya', 'code']`) named `Laya`, and the client's `AUTHORITY` map (`client.js:1364`) learns `laya: ['', 'Laya']`.

Live reasoning lines (`adapter.js` `line()`); the event type of an answered call stays `'jev'`, because it lives only in memory, and `line()` names `e.trace.provider`; a failed call is the event `'decider-error'` (2.4), which carries no `questions`:

- `Laya route: 20/20 questions in 950 ms on the GPU`, with ` (waited 4200 ms for an earlier Laya answer)` when the gate held it.
- `Laya route failed after 42000 ms: timed out after 42 s (20 questions on the CPU); routing rules decide those domains`, from `'decider-error'`; a Jev failure reads `Jev route failed after <ms> ms: <message>` from the same case.
  The Laya client's timeout names only its deadline in its message and carries the call's size and device beside it, `questions` and `device`, which `adapter.js` `timeoutSize` adds in parentheses here and in the report's `Laya did not answer` line, and the inspector adds to its failed-call card; a route call never sent because the prediction was over its deadline has no `; routing rules decide those domains` (3.5).
- `Starting Laya on this PC: loading the model on the GPU (12 s; the last start took 41 s)…` every 5 s, then `Laya is ready on the GPU (loaded in 41 s)`.
- `Waiting for Laya: it is answering an earlier call (4 s)…` every 5 s once an acting request has waited 2 s in the gate (4.5).
- `Laya route: 4 answers too flat to use (risk, req.planning, req.long_context, req.testing); the routing rules filled them`
- `Laya review: 1 of 4 requests reached the 512-token limit, so part of the evidence was cut`
- Decision: `Laya and routing rules decided; 2 Laya calls; 3 candidates considered`.
- Routed: `Routed to claude (laya)`, or `(laya, local)` when the pool was local only.
- In Jev Auto, once per run at the routed event: `Laya is answering the same questions in the background; compare them in Jev → Decisions`, or `Laya is not running, so this run is not compared`; nothing else about the shadow reaches the live stream.
  `router.js` knows nothing of the shadow, so `index.js` sets `shadow: 'answering' | 'not_running'` on the routed event and `line()` prints the note from it; each line of a step reaches the server log as its own `[jev] ` line, so the app files the note as the router's too.
- Under Laya, the legacy tie-break line reads `The routing rules could not tell <a> from <b> (confidence <p>%): <b> takes the work as the standing policy`, because the ranking there is the code domain's; Jev's line is unchanged.
- An empty message in Laya Auto gets `Type a task and Laya will route it.`, the Laya Auto row's Auto effort reads `Laya picks by task (Settings default applies)`, and a Laya task with no agent yet reads `Laya picks` in its result.

Agent strip (`answeredSteps`): `Laya (laya-english/0.3.20@1a2b3c4) → deepseek (deepseek-flash) → claude (opus) [reviewer]`.
The model is the Laya client's relabel (4.5), because `laya.serve` always answers `laya-rl-agent`, which names neither checkpoint nor version.

Inspector, Decisions tab, for a Laya call:

- The call label reads `Laya · laya-english/0.3.20@1a2b3c4 · 5,610 tokens on this PC ($0)`, and the request id reads `none (local)`.
- Every answer marked `corrected: true` carries the pill `uncalibrated (<k> options)`, with `<k>` its own option count; the pill follows the flag, not the question's name, because Laya picks the temperature bucket by option count (4.3).
  An answer marked `informative: false` carries `too flat, filled by rules` where the rules fill it (the fields of 4.3's table that are filled, and `secondOpinion` only on a route call without the task group, as `shadow.js` reads the groups), else `too flat, kept as answered`: a flat noul and a flat disposition are kept as answered (4.3), so the one wording would be untrue for them.
- A `'decider-error'` event shows as a call card `failed after <ms> ms: <message>` with no questions, and a timeout's card adds ` (<n> questions on the CPU | GPU)`.
- The Stats tile, "What the code did" and the "How the router decided" badge of the history view (`client.js:1417`, today `${d.jevCalls} Jev calls`) name the provider from `decision.decider`: `2 Laya calls`.
  The tile's time counts the calls that failed as well as those that answered, and says `1 call failed` or `<n> calls failed` under it.
- The task list's queued line reads `<decider> picks` from the task record's `decider`, and the background list names the decider as the run's kind; old records read as Jev.
- The shadow view for Jev calls is in 5.6.

Usage: acting Laya calls are `usage.jsonl` rows with `agent: 'laya'` and `costUsd: 0`; the Usage tab adds one line, `Laya: <n> decisions on this PC, $0 (Laya counted <t> tokens; not billed).`, and "Saved by Jev" counts only Jev-decided rows and runs (2.5).

### 3.4 Intent in Laya Auto

`classify(message, mode, 'laya')` asks Laya's intent, and reads `minQuestionConfidence` 0.8 and `alsoWork` 0.8 from the Laya record (2.6); `depth` is read as today unless it was flat.
It never contacts TypeSafe, and neither does anything else in a Laya Auto session: the chat model that answers a question and the session title are chosen with `isOffline('laya')`, which probes `laya.connectivityUrl` (2.4).
While Laya is not ready, the message waits for the start with the `Starting Laya` line, bounded as a routing call is, and is then asked: a message treated as a task without asking would wait for the same start inside `route()` anyway, and would send a question to agents as a full run.
Only a refusal, a failed start or a timeout makes it a task without an answer, with the line `Laya could not sort this message (<reason>); treating it as a task`, because unsure means task (`adapter.js:49-56`) and a word rule would send "why does this test fail?" to a chat model that cannot touch files.
In the No project space, where no agent can run, that unsure result is answered as a question instead of refused (2.4).

### 3.5 When Laya is missing, loading, failed, too slow, or offline

No state ever switches a Laya run to Jev, and no state waits without a visible line and a deadline.
The refusals are made by one function, `layaUnavailable` (2.4), which `route()` calls for every decider `'laya'` run, so a message in `stream()`, a queued background task and `/laya` all get the same reply; `stream()` calls it too, before routing, so the reply to a message is immediate.
Every acting Laya request then goes through `sidecar.ensureReady({ signal, onWait })`, which emits the loading line every 5 s, and not only the run's first one: a run's Laya calls can be minutes apart (the route, an agent that works for half an hour, the review), and the run holds the sidecar for its whole length (7.6), so a later call finds Laya ready unless it crashed.

| State | What happens | Exact reply or line |
| --- | --- | --- |
| Not installed | Refused before anything runs | `Laya Auto did not run this: Laya is not installed on this PC. Install it in Settings → Jev setup → Laya decision model, or pick Jev Auto. Nothing was run.` |
| `laya.enabled` false | Refused | `Laya Auto did not run this: Laya is switched off in the configuration (jev-router laya.enabled). Nothing was run.` |
| `layaError` | Refused | `Laya Auto did not run this: Laya's settings are invalid (<message>). Nothing was run.` |
| `config/laya.json` unreadable | Refused | `Laya Auto did not run this: Laya's pinned versions could not be read (<message>); run Update-Harness.ps1. Nothing was run.` |
| `routing.enabled` false | Refused | `Laya Auto needs adaptive routing (routing.enabled in the jev-router configuration). Nothing was run.` |
| `failed` (sticky until the person presses Start) | Refused | `Laya Auto did not run this: Laya stopped after an error (<reason>). Press Start in Settings → Jev setup → Laya decision model, where the log is. Nothing was run.` |
| Stopped | `ensureReady` starts it; the run waits up to `laya.deadlines.startWaitMs` (300 s, the ready bound of 7.5, so a cold first start after a boot or an install is not refused while it is still legitimately loading), abortable by Stop | `Starting Laya on this PC: loading the model on the <GPU \| CPU> (<n> s; the last start took <s> s)…` |
| Starting, stopping or restarting | The same wait, the same bound; a stop or restart in progress is waited out, then started (7.4) | Starting: the same line, its seconds counted from the launch of this start's process. Stopping: `Waiting for Laya to finish stopping, then starting it…`, then the start line. Restarting: `Laya stopped unexpectedly (<exit code <code> \| signal <signal>>); restarting it in <n> s (attempt <a> of 3)…`, then the start line |
| Still starting past `startWaitMs` | Refused | `Laya Auto did not run this: Laya was still starting after <n> s. Nothing was run. Send it again once Settings → Jev setup → Laya decision model says Running.`; `startWaitMs` is both a waiter's bound and the start's own ready bound (7.5), so only the first waiter reads this, and a run that joined the same start reads the next row with `laya.serve was not ready after <n> s`: through a message the first waiter is the intent, so the message becomes an unsure task (3.4) and its run is refused with the next row's text |
| Start failed during this wait | Refused | `Laya Auto did not run this: Laya could not start (<reason>). Press Start in Settings → Jev setup → Laya decision model, where the log is. Nothing was run.` |
| Start turned down by the RAM budget or a GPU with no room (7.7): nothing ran and nothing was logged, and Start is turned down the same way | Refused | `Laya Auto did not run this: <reason>. Nothing was run.`, for example `Laya Auto did not run this: Laya needs about 3.3 GB of RAM; the budget leaves 1.2 GB beside qwen3-8b. Stop the local model or raise the RAM budget. Nothing was run.`; a later call of a run already under way fails with the reason alone |
| A call passes its deadline mid-run | That call's domains take their deterministic fallback, and a timed-out review takes jev-review's deterministic accept or retry, exactly as a Jev failure reads today | The failure line of 3.3, the `Laya did not answer` report line, and the review line, which with the outcome domain wired (learning on) reads `Review: accept. fallback policy (Laya unavailable (timed out after 40 s); using the deterministic fallback)` and without it `Review: accept. fallback policy (Laya unavailable (timed out after 40 s))` |
| A later call of an open run finds Laya down (it crashed and is restarting) | `ensureReady` starts it again with the same line, bounded by that call's own deadline plus `startWaitMs`; past that, the call fails as a timeout | The start line, then the call's own lines |
| Predicted time over a deadline | Not sent (4.5) | `Laya route failed after 0 ms: Laya would need about 150 s for this call on the CPU, over its 120 s deadline` |
| The sidecar dies mid-call | As a timeout, reason `Laya stopped while answering (exit code <code>); it is restarting`, with `signal <signal>` in place of the code when a signal ended it, and, when that exit left it `failed` (the fourth in ten minutes), `Laya stopped while answering and will not restart until Start is pressed: <reason>` | The failure line |
| No internet | Laya needs no network; the connectivity probe to `laya.connectivityUrl` narrows the pool to local agents and Laya still decides | The offline heading of 3.3 |

The Laya client rejects with an `Error` whose `name` is `'Error'`, whose `message` is the reason as the person should read it (`timed out after 40 s`), and whose `code` classifies it, so `describeError` and `domains.js` print the message as is.
The codes are `LAYA_TIMEOUT`, `LAYA_PREDICTED_OVER`, `LAYA_EXITED`, `LAYA_HTTP_500`, `LAYA_UNAVAILABLE`, `LAYA_HTTP_<status>` for any other HTTP status (a second 401, a 422, a 413), `LAYA_BAD_ANSWER` for a 200 that does not answer what was asked (checked with `laya-selfcheck.js` `checkAnswers`), `LAYA_ADAPTER` when rendering throws, and `LAYA_ERROR` when the SDK refuses a request before sending it.
When `ensureReady` refuses mid-run, the message is the short reason (`Laya could not start (<reason>)`), and the full reply of the table above rides on `err.reply` with `err.reason`; a start still pending past `startWaitMs` in the middle of a call is `LAYA_TIMEOUT` (`timed out: Laya was still starting after <n> s`), and `LAYA_EXITED` waits up to 1 s for the sidecar to report the exit code or signal it names.
`stream()` shows the refusals it checks itself before routing (not installed, switched off, invalid settings, unreadable pins, routing off, and `failed`) word for word; a refusal raised inside `route()` while the run waits for its own start reaches the reply after the adapter's usual `jev-router: ` prefix; a queued task's reason and `/laya`'s error are always the refusal text exactly.

Why a Laya Auto run is refused rather than run on rules when Laya cannot start: the person picked Laya Auto to have Laya decide, and a run decided entirely by rules under a Laya heading is not what was asked for.
Once a run has started, one failed Laya call does not stop it: that decision falls to the rules and the report says so.

---

## 4. Which questions Laya is asked, and how

### 4.1 The invariant, and the calls

Laya is asked exactly the questions Jev would be asked in the same situation: the same call groups, question names, option keys and answer types, built by the unchanged builders in `jev.js`.
Only the rendering differs: instruction wording, option text, noul labels and criteria, which slice of the state each question sees, and how the questions are split into HTTP requests.
The speculative tool-parameter questions stay, and so does the second-opinion noul that rides both the task group and the judgments group, because the comparison of section 5 is only meaningful with the same questions on both sides.
A test builds every call with the `jev.js` builders at maximal inputs and asserts the invariant for the Laya rendering (9.3).

| Call | Questions | CPU, 4 vCPU, random-weight English checkpoint |
| --- | --- | --- |
| `intent` | `kind`, `depth`, `alsoWork` | 1.1 to 1.6 s |
| `route`, task group | `taskType`, `complexity`, `risk`, `humanReview`, `needsTests`, `skill`, `minimumCapability`, `preferredCapability`, ten `req.*`, `capability`, and `secondOpinion`, `continueHandoff`, `handler`, `<tool>.fits`, `<tool>.<param>` when present | 20 to 22 s as sent today; 16.0 to 17.6 s with short option texts |
| `route`, resource and judgments | `strategy` (only with two or more eligible strategies), `secondOpinion` | 1.2 to 2.0 s |
| `review`, per attempt | `verdict`, `disposition`, `addressed`, `complete`, `unrelatedChanges`, `regressionRisk`, `needsPerson`, `reviewAgent`, `retryAgent` | 12 to 17 s as sent today; 8.7 s split by the state each group reads |

These figures ran torch on all four cores; the cloud run of 9.4, with the one thread `defaultThreads` gives 4 vCPU, measured about 1.6 s, 49 s, 3.2 s and 18 s.
On the GPU the same calls are expected to take about a second; nobody has measured it, and the owner's test does (9.5).

In Laya Auto, Laya answers every one of them, including the intent and the review nouls that belong to no routing domain; the code-taught domains (`resource_selection`, `frontier_escalation`) stay with their rules.

### 4.2 The Laya wire adapter (`laya-questions.js`)

Pure functions, no I/O, applied inside the Laya client so the acting path and the shadow path render identically.
They never mutate their input: the questions arrive deep-frozen from `jev.js` (2.3), and every rendered question, criteria map and label map is a new object, so a rendering can never leak into a later Jev request.

```js
export function renderForLaya({ phase, state, questions }, { role, chunkRows }) -> [{ key, state, questions }]   // role: 'act' | 'shadow'
export function mergeLaya({ phase, questions }, parts /* [{ key, response }] */) -> { answers, usage, meta: { requests, rows, atContextLimit, missing } }
export function normalizeLayaAnswers(answers, questions, { temperatureCorrections, minTopMargin }) -> { answers, uninformative: [], corrected: [] }
export function estimateHeadTokens(question) -> number   // ceil(chars / 3.6) + 4 x options + 8
export function headChars(question) -> number            // the whole head as Laya builds it, keys included
export function estimateRequestTokens({ state, questions }) -> number
export const NOUL_TEXT, LAYA_SHORT, VIEW_LIMIT = 950, HEAD_BUDGET = 170, ADAPTER_VERSION = 1
```

It never changes a question name, an option key or an answer shape, so no answer needs mapping back.
`meta.missing` names any question no response answered.
In `estimateHeadTokens`, `chars` counts the instruction and the option texts only, and each option's key, level or label is covered by the 4 per option: counting the keys too over-estimated lower-case option sets by 40 to 50 percent against the OLMo proxy tokenizer (`taskType` estimated 204 against a real 127), which would have ruled out the 8-word texts of (b).
The estimate runs under the real count for the upper-case `strategy` keys (135 against 179, the options at 165 of Laya's 176-token option limit), so the strategy texts are kept the shortest.
`headChars`, which feeds `estimateRequestTokens`, the prediction of 4.5 and the fake's usage (9.2), counts the whole head, keys included.

**(a) Bug #156, noul labels and criteria.**
Every noul gets `labels: { true: 'A', false: 'B' }` and explicit `criteria: { true, false }` from `NOUL_TEXT`, the form Laya's own README documents as the workaround; the answer KzH reads stays `noul` = P(true).
Without it, Laya renders the default `false:` and `true:` pair that the English checkpoint can follow instead of the input.
`NOUL_TEXT` covers every noul KzH sends: `humanReview`, `needsTests`, `secondOpinion`, `continueHandoff`, `<tool>.fits` (generic text naming the tool id), `alsoWork`, `addressed`, `complete`, `unrelatedChanges`, `regressionRisk`, `needsPerson`.
For example `needsPerson: { true: 'yes: the attempt asks a question, says it is blocked, or needs a decision only a person can make', false: 'no: the attempt finished or failed on its own' }`.
The official `laya.serve` passes `labels` through, and the SDK sends it untouched (verified in the design pass); a test fails when `jev.js` gains a noul with no `NOUL_TEXT` entry.
Whether it helps on the real English weights is exactly what Test Laya (4.6) and the shadow data measure.

**(b) Option text.**
The English checkpoint gives the instruction and all options 192 tokens, and today cuts `taskType` options to 14 tokens, `skill` to 12 and `capability` to 16, mid-sentence.
`LAYA_SHORT` gives hand-written texts of at most 8 words for `taskType`, `skill`, `capability` (every `CAPABILITIES` key plus `human_required` and `other`), the tiers, `strategy`, `verdict`, `disposition` and the intent's `kind` and `depth`, for example `debugging: find and fix the cause of a bug`; score levels get at most 6 words, for example `critical: security, money or irreversible data`.
Person-written text (tool descriptions and tool-parameter options) is cut to its first 8 words.
The candidate options of `reviewAgent` and `retryAgent` become `tier strong, fit 0.72, cost low, reliability 0.80` (`shortCandidateLine`), with keys unchanged.
Any other `{ what, not_for }` becomes the plain `what` string, because Laya renders an object as JSON text and spends the head budget on braces and quotes.
Measured on the real server: short texts took the task call from 21.6 to 22.3 s down to 16.0 to 17.6 s.
When those texts still overrun `HEAD_BUDGET`, which happens with many review candidates, tools or tool options, the option texts lose detail level by level: a person's text goes from 8 words to 6, 4, 2 and 0, and a candidate line drops `fit`, then `cost`, then `reliability`, then its tier, down to the bare key, so every choice stays within 170 head tokens up to about 20 review candidates by the estimate; KzH's own fixed option sets always fit at the first level.

**(c) Instructions.**
A `{ question, focus }` instruction becomes one string: the question, plus the focus only while `estimateHeadTokens` stays within `HEAD_BUDGET` (170).
Where a view (d) renames or leaves out a state field the `jev.js` instruction names, the instruction is reworded to name the field as the view has it (for example `` `checks` `` for `` `verification` `` in the outcome view), so it never points the model at a field it does not see.

**(d) State views, the fix for review-state truncation.**
Today the review state is about 9,200 characters, the English checkpoint keeps about 316 state tokens per row (11%), and neither `verification` nor `diff` reaches the model.
Every question is its own sequence row that re-encodes the state, so giving each question group its own state view costs no extra compute.
Each view is built from the already scrubbed state `jev.js` built, so no new text leaves the scrubbers, and is at most `VIEW_LIMIT` (950) characters of compact JSON by construction (`clip` keeps the head, `tail` keeps the end):

| Phase | View | Questions | State |
| --- | --- | --- | --- |
| review | outcome | `verdict`, `disposition`, `addressed`, `complete` | `{ checks: 'typecheck pass, lint pass, test FAIL (regressed)', task: clip 300, diff_stat: clip 150, files: clip 120, answer_end: tail 250 }`, checks first so right-truncation can never drop them |
| review | diff | `unrelatedChanges`, `regressionRisk` | `{ task: clip 250, diff_stat: clip 150, diff: clip 520 }` |
| review | person | `needsPerson` | `{ status, answer_end: tail 700, task: clip 150 }`, because the question an agent asks is at the end of its answer |
| review | pick | `reviewAgent`, `retryAgent` | `{ task: clip 200, task_type, risk, latest: { resource, status } }` |
| route | task | every task-group question but `continueHandoff` and `secondOpinion` | `{ task: clip 520, workspace: clip 380 }` |
| route | handoff | `continueHandoff` | `{ task: clip 300, handoff: clip 600 }`, which today never sees the handoff behind a long task |
| route | resource | `strategy`, `secondOpinion` | `{ task: clip 520, task_profile: clip 400 }` (the profile only when `jev.js` sent one); `secondOpinion` comes here on the task-group call too, so that call is two requests, the task view with 19 rows and this one with 1 (three with a handoff) |
| route | agent | `agent`, the legacy named-agent pick (`routing.enabled` false, so only the shadow can send it) | `{ task: clip 300, agent_track_record: clip 260, agent_availability: clip 90, recent_outcomes: clip 160, workspace: clip 150 }` |
| intent | message | all three | `{ message: head 600 + ' … ' + tail 300 }` |

Field budgets can add up to more than 950 once JSON punctuation is counted (the diff view's 250 + 150 + 520 plus its keys is 956), so the limit is enforced on the whole: when a view still exceeds `VIEW_LIMIT`, the largest field that is not pinned gives up the difference, a few characters of the diff excerpt at most.
Pinned fields never give way: the outcome view's `checks`, the person view's `status`, and the pick view's `task_type`, `risk` and `latest`; `checks` has 90 characters, and when its line would be cut, the failures go first.
A phase with no views (none today) gets the whole state as one view cut to the limit.

**(e) Requests.**
An acting call sends one request per view; a shadow call further splits each view into chunks of `laya.shadow.chunkRows` (4) questions, so an acting request never waits behind more than one chunk (4.5).
Every request carries `model: 'english'`.

**(f) Truncation detection.**
Laya's `usage.input_tokens` counts real tokens after truncation, so a request whose `input_tokens / rows >= 0.97 x 512` counts in `meta.atContextLimit`, is named in the reasoning line and the inspector, and is stored on the shadow row; the views aim well under the limit, so a hit means an estimate was wrong.

**(g) The 20-question CPU cost.**
Nothing in the adapter drops a row, because every row is needed for the invariant; the levers above cut CPU time by a quarter to a third, and the rest is made visible and bounded: measured deadlines (4.5), the latency sentence on the picker row (3.1), shadow chunks at below-normal priority (5.2), and the GPU where it has room (7.7).

### 4.3 Answer normalisation, and where a flat answer is filled

`normalizeLayaAnswers` runs in the Laya client after `mergeLaya`, in this order:

1. **The 11+ bucket.**
   For every question whose bucket (Laya's own `temp_bucket` rule: `2`, `3-5`, `6-10`, `11+` options) has an entry in `laya.temperatureCorrections`, probabilities become `p'_i = p_i^(1/tau) / sum_j p_j^(1/tau)`, marked `corrected: true`.
   Laya computes `p = softmax(z / T)`, so this is exactly `softmax(z / (T x tau))` up to Laya's 4-decimal rounding.
   The English checkpoint ships `choice:11+` at 0.1006, which Laya clamps to 0.5 and itself calls uncalibrated; the default `{ 'choice:11+': 3.27 }` brings the effective temperature to 0.5 x 3.27 = 1.637, which is Laya's own per-type choice temperature (1.6369), the one Laya applies to a choice whose bucket has no entry (`laya/agent.py:657`).
   A neutral 1.0 would leave these answers sharper than every fitted choice bucket of the checkpoint (1.906 for 2 options, 1.760 for 3 to 5), and inflate their max probability against `humanRequired`, the informative filter and the calibration figures.
   The bucket is chosen by option count, not by question name, so the correction touches every choice asked with 11 or more options: always `taskType` (12) and `skill` (14); `capability` only when all nine capabilities are offered (plus `human_required` and `other`); `strategy` with 11 eligible strategies; and `reviewAgent`, `retryAgent` and `handler` when enough candidates or tools are on offer.
   The `6-10` bucket ships 1.00002, which is as good as unfitted; it is left alone, and the inspector's pill (3.3) follows each answer's `corrected` flag, so it is never shown on an uncorrected answer and never missing from a corrected one.
2. **Confidence.**
   Every choice and score `confidence` becomes the max probability after step 1, the quantity Laya's `answer_confidence` reports and its own docstring calls the calibrated one; a noul keeps `max(p, 1 - p)`.
   Laya's served `confidence` for choice and score is normalised entropy, which Laya's docstring says must not share a threshold with max probability (for two options it needs p of about 0.93 to reach 0.6); it is kept as `servedConfidence` for the trace only.
3. **Informative.**
   An answer whose top probability is under `1 / k + laya.minTopMargin` (0.1) is marked `informative: false`.
   An uninformed model produces flat distributions, and a flat five-level score has an expected value of exactly 0.5 after `jev.js` `unit()`, which sits on the 0.5 cuts and would flip on noise.
   The filter tests the top probability, not the expected value, so it does not keep every score off 0.5; that is why no Laya cut on an expected score sits at 0.5 (2.6, Rule C).
   With random weights almost every answer is flat, so the cloud runs are decided by the rules and say so; on real weights the share is unmeasured, which is why it is counted and shown, and `minTopMargin: 0` switches the filter off.

Where a flat answer goes, and which field carries the flag there (2.3):

| Answer | Read by | Flag read from | When `informative: false` |
| --- | --- | --- | --- |
| `taskType` | `task_classification` | `route().uninformative` | The domain takes its deterministic fallback (`heuristicProfile`), reason `Laya's answer was too flat to use`. |
| `skill` | `skill_selection` | `route().uninformative` | The fallback. |
| `strategy` | `execution_strategy` | `route().uninformative` | The fallback strategy. |
| `secondOpinion` noul, on the call without the task group | `second_opinion` | `route().uninformative` | The code rule (risk at or above `riskForReview`). |
| `complexity`, `risk`, `req.*` | the profile | `profile.filledByRules` | Left out; `heuristicProfile` fills them field by field (2.5). |
| `minimumCapability`, `preferredCapability` | tiers | `profile.filledByRules` | Left out; `heuristicProfile`'s fixed `'standard'` and `'strong'` fill them (2.5). |
| `capability` | capability filter, `needs_human` stop | `profile.filledByRules` | Left out, so treated as not answered: no capability filter, no stop. |
| intent `depth` | which chat model answers | `intent().uninformative` | `classify` returns it undefined, so the caller keeps the cheap default. |
| `disposition` | outcome domain label | `assess().uninformative` | The domain still gives authority `laya` with the raw assessment; the sample is stored with `informative: false` and left out of every standing; the review action comes from the nouls, as for Jev (6.3), and the router is handed the disposition that action implies, never the flat one (2.5). |
| `reviewAgent`, `retryAgent` | review and retry picks | `assess().uninformative` | `pickOther`, the deterministic peer pick (2.5). |
| every other noul, the `secondOpinion` a task-group call carries for the profile included | bars that sit away from 0.5, profile fields included | `uninformative`, for the record only | Kept as answered: a flat noul falls below every Laya bar (no stop, no accept, no tool, no handoff, no human-review flag, a second review), and the profile keeps it (2.3). |

### 4.4 The checkpoint: English, pinned

Every Laya request carries `model: 'english'`, and the sidecar preloads only it (`LAYA_MODELS=english`).

- KzH's states and questions are English JSON, and Laya's own Router sends all four captured bodies to English.
- English ships fitted temperatures for every bucket but the one 4.3 corrects; `laya-multilingual` ships none, and has the #131 position bias on score questions, of which the task call asks thirteen.
- `laya-typed-decisions` is fine-tuned on four unrelated synthetic workflows.
- Pinning means one calibration per provider; unpinned, `laya.serve` maps KzH's `jev-1.13.0` to no checkpoint (`_resolve_model` returns None) and lets the Router route by language, and a French state was verified to route to multilingual and fail with HTTP 500 when only English is on the PC.
- The cost is the 512-token context, which the views of 4.2 address; the review stays the weakest call, and the standing (6.7) will show it.
- A task that is mostly non-Latin script is flagged `lang: 'non-latin'` on the trace, the shadow row and the Laya sample, and the inspector says `Laya's English checkpoint is unreliable outside English`.

### 4.5 Deadlines, retries, and the Laya client (`laya-client.js`)

Jev keeps `jevTimeoutMs` 20000 per attempt and the SDK's two retries, as today.
Laya has **no retries**: `laya.serve` runs one inference at a time behind one lock and never cancels an abandoned request, and its 500s are model errors, so a retry only queues the same work again.

```js
export function createLayaClient({ sidecar, settings /* providers.layaSettings */, isLocalBusy, log, now,
                                   fetch, adapter, timing /* for tests */ }) -> {
  client(role /* 'act' | 'shadow' */, { runId, onWait }) -> { systemOne({ state, questions }, { signal, phase }) -> Promise<Answer> },
  offerShadow({ callId, runId, phase, state, questions, context, onDone }) -> { queued: true } | { dropped: reason },   // synchronous, O(1)
  withdraw(callId, reason),                                                                                           // drops a shadow job not yet finished
  counters(), busy(), identity(), dispose(),
}
// Answer: { model: 'laya-english/0.3.20@1a2b3c4', answers, usage: { input_tokens, output_tokens: 0 },
//           meta: { provider: 'laya', device, waitedMs, requests, rows, atContextLimit, uninformative, corrected, lang, identity,
//                   predictedMs, deadlineMs } }
```

`onDone` follows only `{ queued: true }`: an offer dropped at once (`{ dropped: reason }`) never calls it.
`client('shadow')` is a background caller on the shadow's queue, at its priority, and never starts Laya.
`predictedMs` and `deadlineMs` on an acting Answer's meta make the per-call prediction visible on the trace.
`waitedMs` is the time a call spent behind another request, and 0 for a call that found the slot free and was first to take it, so a lone call never reads as having waited.
`dispose()` fails every queued call with `Laya was stopped with KzH` and abandons the request on the wire with its socket, the one case in which a socket is aborted.

The gate inside the client:

- **One request on the wire at a time**, because the server runs one anyway, and concurrency only builds a hidden queue: after a client aborted a 20-question call at 2 s, a 3-question intent call took 22.7 s instead of 1.3 s.
  `/health` cannot say busy (it answered in 3 to 14 ms during inference), so busy is the gate's own state.
- **Acting requests go first**, first in first out, before every shadow chunk; a shadow chunk in flight finishes, so an acting request waits for at most one chunk plus the acting requests ahead of it.
- **Readiness per request**: every acting request calls `sidecar.ensureReady({ signal, onWait })` before it is sent, so a request that finds Laya crashed or restarting waits for the start with the `Starting Laya` line, bounded by its own deadline plus `startWaitMs`, instead of failing at once (3.5).
- **A visible wait**: an acting request that has waited 2 s in the gate calls `onWait`, which emits `Waiting for Laya: it is answering an earlier call (<n> s)…` every 5 s (3.3).
- **Deadline per acting call**: `clamp(predictedMs x 2 + 2000, floorMs, ceilingMs)` (8 s and 120 s by default), covering the gate wait and every request of the call.
  `predictedMs` is the call's estimated input tokens (per row `min(512, ceil(head chars / 3.6) + ceil(state chars / 3.0))`, from the rendered requests) times `msPerToken[device][phase]`, an exponentially weighted average (alpha 0.3) of `ms / usage.input_tokens` per device and per phase (`intent`, `route`, `review`), stored in `laya.json`.
  Per token and per phase, because the cost of a row differs by two to two and a half times between phases (intent 367 to 533 ms per row, the route 800 to 880, the split review 967, on the CPU): one figure per device, seeded by the cheapest phase, gave the first route after a start a 16.7 s deadline against a real 16.0 to 17.6 s.
  A phase with no figure yet uses the largest figure measured for that device, and a device with none uses 4 ms per token; the first start per device and identity warms up all three phases (7.5), so a fresh start already has a route figure.
- **Predicted over the deadline**: when the predicted remaining time of the request in flight, plus the predicted time of every acting request queued ahead, plus this call's own predicted time exceeds its deadline, the call fails at once with `Laya would need about <s> s for this call on the <device>, over its <d> s deadline`.
- **The run's signal never reaches the socket.**
  The client does not pass the caller's `signal` to the SDK: `laya.serve` never cancels a job it has started, so an aborted socket would leave the server computing with no response ever to arrive, and the gate would have lost its only exact signal that the server is free.
  When the caller's signal fires (Stop, or the run's lane ending it), the caller's promise rejects at once, as at the deadline, and the request in flight keeps its slot.
- **At the deadline the caller's promise rejects, and the socket stays open**: the SDK timeout is `hardMs` and the soft deadline is a `Promise.race`, so the gate keeps the slot until the abandoned request's own response arrives, which is the only exact signal that the server is free again.
- **A queued request whose caller aborted or whose deadline passed** is removed from the queue before it is sent, so abandoned work never reaches the server.
- **Past `hardMs`** (270 s) the gate aborts the socket and asks the sidecar to restart, because a server that has not answered for that long cannot be trusted to be free.
  `hardMs` is capped at 290 s in the schema because Node 22's `fetch` has its own 300 s headers timeout and `laya.serve` sends no header until inference ends; an `APIConnectionError` whose cause has code `UND_ERR_HEADERS_TIMEOUT` is treated as the same hard path.
- **Two HTTP 500s in a row** restart the sidecar (a CUDA out-of-memory state that Laya did not survive surfaces only as `inference failed`).
- **A 401** rebuilds the SDK client from `sidecar.connection()` and retries that request once, because the usual cause is a client built before a restart changed the key; a second 401 asks the sidecar to restart on a fresh port (7.5).
- **Priority**: the interpreter runs below normal by default, is raised to normal for the duration of acting requests, and is raised at once when an acting request starts waiting behind a shadow chunk (`sidecar.setPriority()`, 7.4).
- **Each request**: `renderForLaya`, then an SDK client of the running instance, `new TypeSafeClient({ apiKey: key, baseURL: 'http://127.0.0.1:<port>', defaultModel: 'english', retry: { maxRetries: 0 }, timeout: hardMs })`, rebuilt on every start because the key and port change; then `mergeLaya` and `normalizeLayaAnswers`; then `sidecar.noteResult({ status, ms, tokens, phase, role })`, which updates `msPerToken`, resets the idle timer only for `role: 'act'`, and feeds the GPU spill check of 7.7.
- **The model label**: `laya.serve` always answers `model: 'laya-rl-agent'`; the client relabels it `laya-english/<laya version>@<weights commit, 7 characters>` and puts the full identity on `meta.identity`: `laya-0.3.20|english|<commit 12>|adapter-1|corr:choice:11+=3.27|margin:0.1`.
  Several corrections are joined sorted and comma-separated (`corr:choice:11+=3.27,score:3-5=1.2`), and none reads `corr:none`.
  The identity names what decides what Laya answers (version, checkpoint, weights, adapter, corrections, margin) and nothing else: the device and the task's script are recorded beside it on each row (5.3), never in it, so a GPU-to-CPU fallback does not start a new identity.

### 4.6 Test Laya

`laya-selfcheck.js` (G2) holds fixed calls in KzH's own shapes and the maximal warm-up bodies of 7.5, built with the `jev.js` builders through a capturing client that never sends anything, and rendered with `laya-questions.js`.
It exports `createProbe(connection, { timeoutMs = 120000, temperatureCorrections, minTopMargin })`, which sends those bodies with a bare SDK client (`new TypeSafeClient({ apiKey, baseURL, defaultModel: 'english', retry: { maxRetries: 0 }, timeout: timeoutMs })`, because the SDK's own 10 s default is under a CPU route call), renders, merges and normalises each call as the Laya client does, and checks the answers, so the sidecar's warm-up and the install's step 7 (G3) can run it without `laya-client.js` (G4), which itself needs a running sidecar.
A connection without a key or a url is refused, because the SDK would fill either from `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL`.
The probe is `{ systemOne, warmUp({ full, signal }), protocol({ signal }), selfTest({ identity, signal }) }`; `warmUp` and `protocol` never throw, and resolve to `{ ok, error, status, problems, calls: [{ name, phase, ms, tokens, rows, requests, answers }] }`, where `status` is the HTTP status of a call that failed (a 401, say).
The card's **Test Laya** button runs the same calls through the real Laya client and adapter (wired in G8):

- **Protocol**: an intent on `Fix the failing test in src/parser.ts` and on `What does the --fit flag in llama.cpp do?`, a route on `Rename the variable foo to bar in utils.js`, and a review of a fixed synthetic attempt; pass when every question is answered with the right type, probabilities sum to 1 within 0.01, confidences are in [0, 1], and each call ends within its deadline.
- **Timings**: intent, route and review milliseconds on the current device, the intent being the mean of the two protocol intents.
- **Noul pairs**: for the seven nouls `alsoWork`, `needsPerson`, `unrelatedChanges`, `addressed`, `complete`, `continueHandoff` and `humanReview`, one clearly-yes and one clearly-no state; a pair separates when the yes probe's P(true) exceeds the no probe's by at least 0.2.
  The result also records the direction of any miss: a pair whose yes probe falls under 0.5 is the #156 pattern (a confident no on clearly positive input), and one whose no probe rises over 0.5 is the opposite bias.
- **The kind pair**: the intent `kind` of the two protocol intents, on a clear task and a clear question, a two-option choice with no noul labels, reported on its own line, because a kind pair that does not separate says nothing about #156; it separates when P(task) on the clear task exceeds P(task) on the clear question by at least 0.2.

The result goes to `laya.json` `lastSelfTest` with the identity, and is shown on the card; it gates nothing, but a noul pair that does not separate is the direct symptom of #156, and the owner should see it before trusting Laya Auto.
With random weights, the protocol passes and no pair separates, and the cloud test asserts the card says so.

---

## 5. The shadow in Jev Auto

### 5.1 When it fires

On every acting Jev call (intent, both route groups, every review) from Jev Auto, Jev Auto · Online and Jev Auto · Local, when all of these hold:

- Laya is installed, `laya.enabled`, no `layaError`, and `routing.learn` is not false (learning off records nothing new, the shadow included);
- the card's switch "Answer beside Jev in Jev Auto" is on (the default once installed);
- the sidecar is ready: the shadow **never starts Laya**, because loading 2 to 3 GB silently is a resource surprise, and the call is recorded as skipped (`not_running` or `starting`).

The shadow also **never keeps Laya loaded**: its requests do not reset the idle timer and never hold the sidecar (7.6), and a Laya that nothing holds gives its memory up to a local model that needs it (7.7), with the comparisons skipped meanwhile counted as `yielded`.
A group Jev is not asked (a domain matured to a local rung) gets no shadow, because the comparison is with Jev.
Offline · Local only and Laya Auto have no shadow: neither calls Jev.

### 5.2 It never delays or breaks a Jev Auto run

- `jev.js` `ask()` calls `onCall` synchronously and returns as soon as Jev answers; `offerShadow` only validates and enqueues the unadapted spec, O(1), and rendering happens later in the gate.
  The spec's question objects are deep-frozen by `ask()` and the criteria constants they point to are frozen at load (2.3), and `renderForLaya` builds new objects (4.2), so no shadow work can change a later Jev request; the question objects are shared, never copied, which keeps the offer O(1).
- Nothing in the run awaits the shadow; its promise is detached, every error is caught inside `shadow.js` and becomes a `failed` row, and it is not tied to the run's abort signal, so stopping a run never throws out of the shadow and a comparison can land after the run has ended.
- One computation at a time, acting Laya calls first, at most `maxQueue` (8) waiting jobs: a new job past that is dropped (`queue_full`), so the earlier calls of a run stay complete.
- A shadow chunk starts only when no local model request is in flight (`local.isBusy()`, a new one-line export of `createLocalModels` over its `busy` counter at `local.js:757`), whatever Laya's device, so Laya never competes with the llama.cpp model a run is using; a job that waits longer than `maxAgeMs` (10 min) is dropped (`too_old`), and one whose remaining chunks aged out is written `partial` with the answers it has.
- The interpreter runs below normal priority during shadow work (4.5), so on the CPU a comparison yields to the app, the run's checks and llama.cpp.
- **Memory.** A Laya loaded only because it was started earlier (by Test Laya, a Laya Auto run or the install check) is not held: shadow requests leave its idle timer running, and when a local model starts or the RAM watchdog trips under Jev Auto, Laya is unloaded first, llama's context is never sized down and its `tripped` record never written on Laya's account, and the local model gets the GPU layers and RAM it would have had without Laya (7.7).
  Only a held Laya (an open Laya Auto run, a Test Laya, an install check, or `keepLoaded` switched on by the person, 7.6) stays beside a local model, and the card says what it costs (8.2).
- **A Jev call that fails** settles its shadow job with `{ error }`: the job is withdrawn if it is still queued, its remaining chunks are dropped if it has started, and its row is written `skipped` with reason `jev_failed`, which counts in coverage and never in agreement.
  So a 429 or 402 that `makeJev` rotates and repeats (2.4) yields one compared row, for the repeat, and a Jev timeout spends at most one Laya chunk.
- The remaining overlap is one shadow chunk already running when a local agent starts: a few seconds on the CPU, well under one on the GPU; the switch on the card turns the whole shadow off.

Three tests prove the first points (9.3).
With a fake Laya that takes 5 s, a Jev Auto `runRouted` with `deps.runId` fixed and the shadow's clock fixed gives the same record as the same run with the shadow off, compared after removing `ts`, `runId` and every `durationMs` and `ms` (the record carries a fresh id, a timestamp and per-attempt durations, so two runs are never deep-equal as they stand), and each run resolves within the same run's time with the shadow off plus 500 ms, a tenth of one Laya chunk, before Laya has answered anything; a run is its Jev calls plus the router's own git work and review, so Jev's latency alone bounds nothing.
The runs themselves use real timers, since the router spawns git and the fake Laya is a real server, and the shadow's hook and settle functions, timed on the run's thread, take under 50 ms in all (under 1 ms measured).
And two consecutive Jev Auto runs with the shadow on send Jev request bodies byte-identical to the same two runs with the shadow off, which is what catches a mutation that only shows on the next call.
And through `index.js`, a Jev Auto run with a Laya that takes 3 s a question replies before Laya has answered any of its calls, with each of them still waiting.

### 5.3 What is recorded, and where

`plugins/jev-router/shadow.js`:

```js
export function createShadow({ file, laya /* createLayaClient() */, enabled /* () => boolean */, log, now,
                              providers /* the records, for their thresholds */, jevHost /* jevHostOf() */, onRow /* the inspector's entry.events push */,
                              files /* routing-samples, laya-samples, feedback, history, laya-standing */, cap, slack }) -> {
  offerer({ runId }) -> onCall,   // the hook createJev takes; runId null for intent
  read({ runId, since }) -> rows, // from the in-memory index, never the file
  waiting({ runId }) -> [{ callId, phase }],   // the inspector's `waiting for Laya`
  rowOf(callId), loaded(), flush(),
  compare({ days, identity }),    // the comparison of 8.4, in the worker, cached
  recordStanding(),               // the append of 6.7, in the worker
  counters() -> { answered, partial, skipped: { not_running, starting, queue_full, too_old, jev_failed, yielded }, failed },
}
```

One row per shadowed call in `~/.kzh/jev-router/laya-shadow.jsonl`, written when both sides have settled:

```js
{
  id, ts, runId,                                   // runId null for intent
  callId, phase: 'route' | 'review' | 'intent', groups: ['task'] | ['resource', 'judgments'] | null,
  attempt: 2 | null, review: { risk: 0.4, blockAccept: false, reviewed: false } | null,   // from onCall's context (2.3), numbers and booleans only, for reviewAction()
  actions: { jev: 'accept', laya: 'second_review' } | null,   // review rows only: reviewAction() on each side's own nouls and thresholds, null for a side without them; the inspector's review line (5.6)
  identity: '<the identity string of 4.5>', device: 'cuda' | 'cpu', lang: 'latin' | 'non-latin',
  thresholds: { jev: '<sha256 of the Jev record's thresholds, 12>', laya: '<sha256 of Laya's, 12>' },
  status: 'answered' | 'partial' | 'skipped' | 'failed',
  reason: null | 'not_running' | 'starting' | 'queue_full' | 'too_old' | 'jev_failed' | 'yielded' | 'timeout' | '<error code>',
  queuedMs, ms, rows, requests, atContextLimit,
  jev:  { model: 'jev-1.13.0', host: 'api.typesafe.ai', ms, error: null, questions: { <name>: { type, answer, p, confidence } } },
  laya: { questions: { <name>: { type, answer, p, confidence, informative, corrected } } },
}
```

- `p` is the probabilities of a choice or score as an array in the question's option order, rounded to 3 decimals, and P(true) for a noul; answers are recorded as asked, with anonymous candidate keys (`RESOURCE_A`) for the review and retry picks.
  A 20-question route row with objects keyed by option name measured 7.7 KB; arrays are estimated to keep it near 3 KB, and the file cap below is set with that margin.
- A tool-parameter answer (`<tool>.<param>`) is recorded as its option index (`'#2'`), because tool option keys are person-written config that `jev.js` deliberately leaves unscrubbed so they can come back as the tool's arguments (`jev.js:623-630`).
- No state, task text, question text, answer text or diff is written, the same rule as `routing-samples.jsonl` (`training.js:16-17`).
- `thresholds` and `jev.host` let every figure be filtered to rows that were answered under the same bars and against the same Jev server: `TYPESAFE_BASE_URL` can point Jev elsewhere (8.1), and the would-have-acted figures depend on Laya's thresholds.
- The file keeps its newest 10,000 rows, compacted by rewrite-then-rename as `training.js` does.
- `shadow.js` keeps an in-memory index by `runId` and `callId` of the rows written since start and the newest 2,000 read at start, bounded at the cap, so the Decisions tab's poll (5.6) never reads or parses the file; the comparison of 8.4, the standing of 6.7, that read of the newest rows at start and the compaction all run in a `worker_threads` worker over the files, and the comparison is cached for 60 s or until 100 new rows arrive, so no read of a file at its cap runs on the DSH engine's main thread, which streams the Jev Auto run the person is watching.
  Taking the 2,000 rows back from the worker costs the main thread about 100 ms once, at plugin start, the same as parsing them there would.
- A row the disk refuses is logged (`laya shadow: row not saved: <reason>`) and kept in memory, the Jev call answers as usual, and the next row is written once the disk takes it.
- Joins are by the unified run id (2.4): routing domains to Jev's samples by `(runId, domain)`, because each routing domain decides once per run; `outcome_disposition` by `(runId, extra.decidedAt === attempt)`, where `attempt` comes from the review's `context`, not from counting the state's attempts; review actions and final status to `history.jsonl` by `runId`.
- Jev's own samples are not changed, and nothing trains on a shadow row.
- The shadow answer also goes to the run's in-memory inspector log (`entry.events.push({ type: 'shadow', at, row })`) and to the server log as one line: `[jev] Laya shadow route: 20 answered in 950 ms, 14/20 agree with Jev`.

### 5.4 Privacy

- Shadow requests go to `127.0.0.1` only (`LAYA_HOST=127.0.0.1`; upstream's default is `0.0.0.0`), with a bearer key that exists only in memory for that sidecar process.
- The sidecar runs with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` and `HF_HUB_DISABLE_TELEMETRY=1`, and `laya` makes no network call besides Hugging Face downloads.
- Laya receives exactly what Jev already received, after the same scrubbing `jev.js` applies (`scrub`, `scrubDeep`), and the views only cut and reorder it.
- `laya.serve` logs access lines only, never bodies, and KzH's copy of its log is a local file.
- The recorded rows hold no text, tool option keys included; nothing about the shadow leaves the PC.
- What the owner brings back from the desktop test is one bundle written by `scripts/laya-export.mjs` (9.5), never `history.jsonl` or `usage.jsonl` as they are: `history.jsonl` holds the task text as typed, workspace and file paths and the start of every answer, and nothing redacts a key pasted into a task.

### 5.5 Agreement, and what can judge who was right

`plugins/jev-router/shadow-stats.js` is pure, computed on read in the worker of 5.3, never stored, per identity (default: the current one), per thresholds pair and Jev host (default: the current ones), and per period (7 days or all).

Per question:

- choice: agree when the top options match; also reported, whether Jev's pick is in Laya's top two;
- noul: agree when both sides fall on the same side of 0.5, and separately at each provider's own bar where one exists (for example `alsoWork` at 0.7 for Jev and 0.8 for Laya); the mean absolute difference of P(true);
- score: agree when the rounded levels match; the mean absolute difference in unit scale; and agreement at `requirementWanted` for the `req.*` scores;
- every agreement figure twice, over every answered question and over Laya's informative answers only, because a flat answer's top option is noise and leaving it out raises agreement;
- coverage: answered, partial, skipped by reason, failed; `atContextLimit` hits; the uninformative share.
- Rows with a Jev error (`jev_failed`) count in coverage only.

"Would it have acted the same", the figure that matters: task type, capability, strategy, second opinion at each provider's own `judgmentYes`, checks required at each provider's own `needsTests`, the `needs_human` stop, and the review action computed with `reviewAction()` on each provider's own nouls and thresholds with the row's recorded risk, `blockAccept` and `reviewed`.
Task type, capability, strategy and second opinion are compared only where Laya's answer was informative, because a flat one is filled by rules that no row records, and the `needs_human` stop reads a flat Laya capability as no stop, as the router does.
For the review it also counts, per provider, how many actions were `second_review` or `human` because the quality stayed under that provider's accept bar, so the cost of Laya's higher bars (2.6 rows 13-15) is a number, not a guess.

Per domain, through the question that teaches it: `taskType` for `task_classification`, `skill` for `skill_selection`, `strategy` for `execution_strategy`, `secondOpinion` in the judgments group for `second_opinion`, `disposition` for `outcome_disposition`; plus two groups that are no routing domain, `review_action` and `intent` (agreement only, since intent has no verified label).

The outcome judge, `judge(answer, outcome, domain)`, decides for each answer on each row with an outcome whether it was right, wrong or undetermined.
A yes/no domain is one whose labels are exactly `{ yes, no }`, whatever its `kind` in `routing-policy.js` (`second_opinion` is declared `multiclass` there).

| Outcome label source | Right | Wrong | Otherwise |
| --- | --- | --- | --- |
| `human` with a label (`good pick`) | answer equals the label | answer differs | |
| `human` with only `negativeLabel` X (`misread my question`, `wrong scope`) | yes/no domain and answer differs from X | answer equals X | undetermined (multiclass) |
| `verified_outcome` with a label | answer equals the label | answer differs | |
| `verified_negative` (`negativeLabel` X) | yes/no domain and answer differs from X | answer equals X | undetermined (multiclass) |
| `teacher_confirmed` | | | undetermined for both providers |

A confirmation is undetermined for everyone, because it is the acting router agreeing with itself: the accept that confirmed the pick came from that router's own review.
`outcome_disposition` and `review_action` go further: every `verified_outcome` row of theirs is undetermined too, because `labelDisposition` derives the needed disposition from what followed the acting review (`training.js:571-588`), and what followed is that review's own action (accept ends the run, retry starts the next attempt, human sets `needs_human`).
For those two groups only evidence independent of the acting review decides: the person's like or dislike of the run's answer (a dislike makes an accept wrong, a like makes it right), and a later review by another agent in the same run that did not accept what the acting review accepted.
Both are read with `history.jsonl`, reduced to each run's id, final status and each attempt's agent, role, stop reason and limit hit, which `standing()` and `compare()` take as `history`: a like or dislike, joined by the feedback's run id, judges only the review of the run's last work attempt, and a later review is a completed review by another agent followed by more work or by `needs_human`; of feedback only the verdict, tag and run id are read, with the time and keys `feedback.js` reads it back by, never its words.
`labelDisposition` never yields `SECOND_OPINION` or `FRONTIER_REVIEW`, so `second_review` and `human` are reported as rates per provider and never counted against a truth that cannot contain them.
The inspector keeps the decisive sources apart and says why: `A person said` rows are the least biased; `Where Jev's pick was contradicted` rows exist only because Jev's pick went wrong, so they measure how often Laya would have had it right there, never Laya's accuracy.
Paired accuracy is reported only on rows where both answers are determined, and only from `A person said` rows.

### 5.6 Inspector

**Decisions tab, per run.**
Each question card of a Jev call gains a `Laya` column (answer and probability) and a mark: `agrees`, `differs`, `waiting for Laya`, `skipped: Laya was busy`, `skipped: Laya was not running`, `skipped: Laya was starting`, `skipped: Laya gave its memory to a local model`, `skipped: the Jev call failed`, `failed`.
The card's header reads `Laya shadow: 27 of 29 questions answered, 21 agree (78%). Laya decides nothing in Jev Auto.`
For a review call it adds `Review action: Jev accept, Laya second_review.`
The column is filled from `GET /jev-router/laya/shadow?runId=<id>`, where `<id>` is the live run's `entry.id`, which is the run id since 2.4, polled every 5 s while a row is still waiting.
A tool-parameter answer, recorded as its option index (5.3), is shown by its option's name, taken from the Jev call's own question, and agreement is still worked out on the recorded values.
The shadow rows stay in the run's inspector entry for this tab, and the Tasks panel's run body leaves them out, so no bare `shadow` line is printed there.

**Router tab, across runs.**
A card titled `Jev and Laya, side by side`, with the subtitle `From the calls Laya answered in the background in Jev Auto, and the runs Laya decided in Laya Auto. Checkpoint english, weights <commit 7>, adapter 1. Agreement is not accuracy, and outcomes are counted only where they can judge: see each column.`
It shows, from `GET /jev-router/laya/compare?days=7&identity=current` (8.4), which answers 404 on a PC where Laya cannot be asked and nothing was ever compared, and then there is no card; any other failure is said where the card would be, `The comparison could not be read: <message>`:

- a domain table with the columns `Domain`, `Laya answered`, `Agrees with Jev (informative only)`, `A person said (Jev right / Laya right)`, `Where Jev's pick was contradicted (Laya had it right)`, `Laya Auto runs that failed`;
- a question table with the columns `Question`, `Compared`, `Agree`, `Agree, informative only`, `Mean difference`, `Laya median ms`, with `uncalibrated (<k> options)` on each question whose Laya answers were corrected (4.3);
- the would-have-acted rows of 5.5, with the review actions stopped by each provider's accept bar;
- the skip line `Skipped: <a> not running, <b> starting, <c> queue full, <d> waited too long, <e> gave way to a local model, <f> Jev call failed; <g> failed.`;
- the median answer time of each provider.

---

## 6. Learning integrity

### 6.1 Separate stores, refusing stores

| File | Written by | Holds |
| --- | --- | --- |
| `routing-samples.jsonl` (unchanged) | Jev Auto runs only | Jev-taught samples for the local classifiers |
| `laya-samples.jsonl` (new) | Laya Auto runs only | every domain decision of a Laya-decided run |
| `laya-shadow.jsonl` (new) | the shadow | section 5.3 |

Both sample files use `createTrainingStore`, which gains `kind: 'jev' | 'laya'` (default `'jev'`), with the same cap and compaction; `training.js` exports `STORE_KINDS`, and each store exposes its `kind`.
The separation is structural for one decisive reason: the local ladders roll back on the retry, escalation and failure rates of every verified row in their store (`domains.js` `ratesOf`, lines 1128-1136, read by the breach check at line 922), so Laya Auto's failures in a shared store would demote Jev-taught classifiers that decided none of those runs.
Because no Laya Auto row enters `routing-samples.jsonl`, the local classifiers' training, their evaluation windows, drift and out-of-distribution statistics, `classProfiles` and `stats().localAgreement` cannot see a Laya answer, whatever filter anyone forgets.

### 6.2 Authority names, the teacher, and the sample fields

- `training.js` keeps `AUTHORITIES` exactly as it is (`['jev', 'local', 'code', 'deterministic', 'fallback']`, the Jev store's list), so the assertion at `test/training.test.js:47` stands unchanged, and adds `ALL_AUTHORITIES = ['jev', 'laya', 'local', 'code', 'deterministic', 'fallback']` and per store `STORE_AUTHORITIES.jev = AUTHORITIES` and `STORE_AUTHORITIES.laya = ['laya', 'code', 'deterministic', 'fallback']`.
- The teacher stays `'jev'`: `routing-policy.js` keeps "teacher must be jev or code" (`routing-policy.js:404-409`), and `domains.js` `state().teacher` is unchanged; Laya is never a teacher.
- `normalizeSample(sample, { now, kind })`:
  - `kind: 'jev'` **throws** on `authority: 'laya'` and on any `provider` field (`training: a laya sample was refused by the jev store`), a programming error that the integrity tests prove never happens and that `domains.js:532` logs if it does;
  - `kind: 'laya'` requires `teacher: null`, keeps `authority: 'laya'` and keeps a well-formed `provider` field;
  - an unknown authority is still rewritten to `'fallback'` on both, as today, so old rows read unchanged.
- A Laya sample:

```js
{ id, ts, runId, domain, featureSchemaVersion, input,
  teacher: null,
  local: { label, chosenKey, probabilities, confidence, artifactVersion, ood } | null,   // recorded beside, never decided
  code: { label, chosenKey, probabilities, confidence } | null,
  authority: 'laya' | 'code' | 'deterministic' | 'fallback',
  provider: { id: 'laya', label, chosenKey, probabilities, confidence, informative, model, identity, lang } | null,
  outcome: null,
  extra }                                                   // extra.providerProfile for task_classification
```

- The Jev sample shape is unchanged.
- `LABEL_SOURCES` is unchanged: no new label source is added.

### 6.3 How a Laya-decided run decides a domain

The controller's `decide()` (`domains.js:429`) gains two parameters, so there is one decide path, not a parallel one:

```js
decide({ features, candidates, jev, fallback, codeAuthority, localMayDecide, context,
         answeredBy = 'jev',   // 'laya': the call passed as `jev` is Laya's and this is a Laya-decided run
         sink })               // the store the sample goes to; required when answeredBy is not 'jev'
```

When `answeredBy` is not `'jev'`:

- the domain's ladder is read-only: no `noteOod`, no `setMaturity`, no state write;
- the local classifier is computed read-only and recorded as `local`, and never decides at any rung, because the owner decided that Laya decides and a classifier taught by Jev deciding would put Jev's teaching back into a Laya run; a prediction that throws is ignored rather than marking the artifact unusable, as a Jev run would, so every state file stays byte-identical (6.9, invariant 4), and the next Jev decision finds the same fault and acts on it;
- an answer gives `authority = answeredBy` and is stored in `provider`, with `teacher: null`, and the reason `Laya decides this run; the local classifier is recorded beside it and never decides a Laya run` (the clause after the semicolon only when there is a classifier);
- a throw gives the deterministic answer (`code` or `fallback`), never local and never Jev, with the reason `Laya unavailable (<message>); using the deterministic fallback`, and so does no answer, with `Laya had no answer for this question; using the deterministic fallback`, and a question Laya was not asked, with `Laya was not asked this one; using the deterministic fallback`;
- an answer the teacher closure marks `informative: false` (2.5) gives the deterministic answer too, with the reason `Laya's answer was too flat to use`, in every domain but `outcome_disposition`, and the sample still records Laya's answer as `provider` with `informative: false`, so a standing can leave it out and count the informative share (6.7) rather than never see it;
- in `outcome_disposition` a flat disposition still gives `authority: 'laya'` with the raw assessment, and only the sample records `provider.informative: false`, which keeps it out of every figure of 6.7; the review action there comes from Laya's nouls, never from the disposition (2.5), so a flat disposition is no reason to throw Laya's review away, and with random weights (a 7-option choice needs p over 0.243 to count) it would otherwise turn almost every Laya review into the deterministic accept, and only when learning is on;
- a code-taught domain is decided by its rule, with the reason `a rule in code decides this domain`, and never by its classifier, even where its classifier holds a local rung (`frontier_escalation`) at which Jev Auto would let it decide;
- the sample goes to `sink`, and the returned object carries `provider`, `teacher: null`, `jevCalled: false` and `maturity: null`, code-taught domains included, because the local ladder's rung says nothing about a Laya run (3.3).

`decision.js` passes `answeredBy` and `sink` on every controller call (2.5).
For the review, `index.js` hands `runRouted` an outcome-domain facade for Laya runs, `{ decide: (args) => outcome.decide({ ...args, answeredBy: 'laya', sink: layaStore }) }`, so `jev-review` stays ignorant of stores.
`decisionSamples` entries become `{ domain, id, store: 'jev' | 'laya' }`, and so do the `outcome_disposition` entries `learnFrom` builds from `record.assessments[].outcomeDomain.sampleId` (`index.js:686-697`), with the store taken from `record.routing.decider` (2.4); without it a Laya review sample would be looked up in the Jev store, found missing and skipped silently.

### 6.4 Outcome labelling

- `learnFrom(record, samples)` resolves each sample in its own store with the unchanged `labelFromRun` (`training.js:605`).
- `pickOf(sample)` (`training.js:420`) returns `sample.provider` under authority `'laya'`.
- `confirms(sample, outcome)` (`training.js:430`) returns the outcome only under authority `'jev'`, the teacher: an accepted run confirms only the teacher's pick.
  For every existing authority this is today's behaviour, since a `fallback` or `deterministic` sample has no teacher pick to confirm.
- Evidence that contradicts a pick (a rescue labelled `verified_outcome`, a `verified_negative`, a person's `misread my question` or `good pick` tag labelled `human`) is labelled for every authority, as it is today for local and code picks.
- `onVerdict` (`index.js:386`) relabels in the store `run.routing.decider` names; it lives in `index.js`, so its test is G8's (6.9).

### 6.5 Do Laya Auto runs feed the local classifiers?

Not in this build.
Their samples live in `laya-samples.jsonl`, and no local classifier reads that file.
The only evidence they could add is outcome-backed labels, which are facts about the task and not Laya's answers; but in a Laya-decided run those rows are selected by Laya's failures, and mixing them into a Jev-taught ladder's windows would bias its accuracy low and could roll it back for mistakes that were not its own.
Switching it on later is one change, the local registry reading the outcome-backed rows of `laya-samples.jsonl` for training only, outside every evaluation window and rate, made when section 10's data says so.

### 6.6 Capability evidence and class profiles

- `profiles.js` `evidenceFromRun`: for a record with `routing.decider === 'laya'` it emits only `reliability` rows, whether each attempt completed, which depend on no judgment.
  Every other row rests on Laya: the dimensions a task exercises come from Laya's task type (`profiles.js:709-710`), `objective_deterministic` rests on Laya's accept (`profiles.js:764`), and `independent_review` on Laya's assessment.
- Those reliability rows carry no `taskType`: every evidence row today carries `record.routing.taskType` (`profiles.js:728`), which in a Laya run is Laya's label, and `evidenceWeight` weights a row by that type's similarity to the task at hand (`profiles.js:261-271`), so Laya's label would decide how much each row counts when Jev Auto reads a profile.
  A row with no task type is general evidence, fully relevant, which is what a completed-or-not count is.
- `router.js` `verdictWeight` (`router.js:262-272`) treats a verdict about a Laya-decided run as a verdict whose run type is unknown, so the session rule weighs it, and Laya's label never sets whether a person's verdict counts 1 or 0.25 in Jev Auto's feedback prior (`router.js:894`).
- The review-attempt loop (`profiles.js:772-777`) is unchanged: it credits `independent_review` from any assessment of a completed review attempt whatever its mode, and in Jev Auto that includes `local` and `fallback` assessments, which Jev Auto's capability evidence counts today.
  A Laya-decided record never reaches the loop, because the record-level check above returns before it, so the loop needs no mode check; if one is ever added it is `assessmentOf(a)?.mode !== 'laya'`, never `=== 'jev'`, which would silently drop Jev Auto's own local-mode evidence.
  `profiles.js:771` stays `own?.mode === 'jev'`.
- `evidenceFromFeedback` gives nothing for a Laya-decided record, because its dimensions come from Laya's task type too, and `answererUnconfigured` answers false for such a record, since a missing agent is not why its verdict gives no rows.
- `history.jsonl` keeps every field, so the withheld rows can be backfilled if a later decision allows it.
- `classProfiles()` reads only the Jev store, and Laya's numbers are stored as `extra.providerProfile`, so they never reach the class means the local path acts on.
- Capability profiles are shared by both modes, and a zero-shot model reading a shortened review state must not move what Jev Auto believes about the agents.

### 6.7 "Each with its own maturity ladder": Laya's standing

Jev Auto's ladder is unchanged: per domain, the local classifier against Jev as teacher.
The owner's decisions leave no row in which a ladder would hand authority to Laya: Laya Auto acts whatever Laya's maturity, and Jev Auto acts on Jev.
So Laya's ladder is built now as its **measurement**, a standing per (domain, `laya`), computed by `shadow-stats.js` `standing({ shadowRows, jevSamples, layaSamples, feedback, history, identity, thresholds, jevHost })`, where `history` is `history.jsonl` reduced as 5.5 says.

No outcome KzH records today is a fair test of Laya, so the standing has no rung, no gate and no single accuracy.
In a shadow row Jev acted, and `teacher_confirmed` is undetermined, so the decisive rows are person tags and outcomes that exist because Jev's pick was contradicted: Laya is scored right exactly where it disagreed with Jev on a Jev failure.
In a Laya Auto row nothing confirms a Laya pick (`confirms`, 6.4), so the decisive rows are Laya's own failures.
Pooled, one accuracy would measure the mix of modes, not Laya: on `second_opinion` in Jev Auto, where Jev mostly answers no, the decisive rows are rescues (label yes) and negatives of no, and a Laya that always answers yes would score near 1.0 and clear the GUARDED_LOCAL gates.
So the sources are never pooled, and each is reported only as what it can show:

- **A person said**, from shadow rows and Laya Auto rows alike: accuracy on rows a person labelled (`good pick`, `misread my question`, `wrong scope`, and for the review groups a like or dislike of the answer), with Jev's accuracy on the same rows beside it; the only figure called accuracy.
- **Where Jev's pick was contradicted**, from shadow rows only: `{ n, right }`, how often Laya's answer was the corrected label, never called accuracy.
- **Laya Auto runs that failed**, from Laya's acted samples only: the rate of `verified_outcome` and `verified_negative` rows among Laya-decided runs of that domain, a failure rate and never an accuracy.
  In `outcome_disposition` those rows derive from the acting review's own action (5.5), which under Laya comes from its nouls, so an accepted run would count as failed whenever Laya's disposition was not `PASS`; there a run counts as failed only when evidence independent of that review judges its disposition wrong (a dislike of an answer it accepted, or a later review by another agent that did not accept it).
  `task_classification` and `skill_selection` are labelled only by a person's tag or the teacher's confirmation, never by a run's outcome, so no Laya Auto run of theirs can be counted as failed: `failed` is `null` there, not measured, and the card says so rather than show 0.
- Rows are never an answer marked uninformative.
- Beside them, never as a gate: agreement with Jev, over all answers and over informative ones (Jev is not ground truth, and gating on it would stop Laya from ever being better than Jev).
- For `task_classification`, whose authority hands over the whole profile while its measured label is only `taskType`, the standing records `fieldAgreement` for every profile field it hands over (risk, complexity, the requirements, `humanReview`, `needsTests`, capability, the tiers); it is agreement with Jev, so it is shown and never used as a floor (6.8).
- `outcome_disposition` and the `review_action` group are judged only by evidence independent of the acting review (5.5), and report `second_review` and `human` as rates; intent gets agreement only.
- Each evaluation pass appends the standing to `~/.kzh/jev-router/laya-standing.jsonl`, outside `domains/`, so no file the Jev ladders own changes on Laya's account.
  The pass is the Laya-only one: after a Laya-decided run `route()` skips `maybeRetrain` (2.4), and `index.js`, at most once a minute after any run, asks the comparison worker of 5.3 for the standing and appends it.

```js
{ ts, identity, domain,
  laya: { answered, informativeShare, agreementWithJev: { all, informative },
          personSaid: { n, right },
          whereJevWasContradicted: { n, right },
          layaAutoFailed: { runs, failed },
          fieldAgreement: { risk: 0.64 } },
  jev: { acted, personSaid: { n, right } } }
```

The standing is a reading, not an authority: nothing acts on it in this build, and no arbiter may read it until an unconditioned evaluation exists (6.8, 10).

### 6.8 Where the dumb arbiter will sit (not built)

For a future mixed row only, in `domains.js` `decide()`, at the single point where `trusted` and `mayDecide` are computed (`domains.js:449-457`): a pure `arbitrate({ domain, local, laya, jevAvailable })` of about fifteen lines.
It needs something this build does not have: an unconditioned evaluation of Laya per domain, rows whose truth does not depend on who acted, for example the owner labelling a random sample of runs of both modes whatever their outcome.
Once that exists, candidates are the local classifier when trusted at its rung, and Laya when its unconditioned accuracy meets the domain's gates from `routing-policy.js`, its recent window is not under the rollback floor, its corrected confidence is at or above the domain's `confidenceThreshold`, and the input is in distribution.
`task_classification` hands over fields that have no outcome-based check at all (6.7), so no arbiter may grant it to Laya until one exists; agreement with Jev is not such a check.
The candidate at the higher rung wins (the local classifier's own rung, or the rung whose gates Laya's unconditioned accuracy meets), ties go to the cheaper source (local, then Laya, then Jev), and nobody mature means Jev, or the rule for a code-taught domain.
It is never learned, as roadmap rule 2 says.

### 6.9 Integrity invariants, each with a test

Invariants 2, 3, 6 and 8 are unit tests in `test/integrity.test.js` (G5), except the `verdictWeight` clause of 6, which is in `test/router.test.js` (G6) because `router.js` is G6's; 1, 4, 5, 7 and 9 need whole runs or `index.js` and live in `test/laya-integration.test.js` (G8).

1. A Laya-decided run appends nothing to `routing-samples.jsonl`.
2. The Jev store throws on authority `laya` and on a `provider` field; the Laya store throws on a non-null `teacher`.
3. `classProfiles` over the Jev store is identical before and after a Laya Auto run.
4. A Laya Auto run, with its `learnFrom`, leaves every controller state file under `~/.kzh/jev-router/domains/` (`<domain>.state.json` and the artifacts) byte-identical: no maturity, rollback record, window counter or evaluation stamp changes on Laya's account.
5. No `TypeSafeClient` is constructed without a `127.0.0.1` `baseURL`, and no fetch reaches a TypeSafe host, during a whole Laya Auto session through the adapter: a question answered by the chat model, a task, and a session title (constructor and fetch spies).
6. `evidenceFromRun` on a Laya-decided record yields only `reliability` rows, with no `taskType`; a mode `laya` assessment is never `independent_review`; a `local`-mode review assessment in a Jev-decided record still credits `independent_review`, as today; and `verdictWeight` gives a verdict about a Laya-decided run the weight of an unknown type.
7. `computeSavings` and the Jev monthly spend are unchanged by Laya usage rows, by a Laya Auto direct answer, and by a Laya Auto history record that ran a tool or skipped a limited agent.
8. An accepted run that agrees with a Laya pick yields no label.
9. `onVerdict` on a Laya-decided run relabels in the Laya store only.

---

## 7. The sidecar

### 7.1 Files and folders

| Path | What |
| --- | --- |
| `config/laya.json` | the pins of 7.2 |
| `config/laya/requirements.in` | `laya[serve]==0.3.20` and `torch==2.14.0`, and the line `# exclude-newer: 2026-09-24T12:00:00Z` that bounds the lock's resolution (7.2) |
| `config/laya/requirements.lock` | one universal, hash-pinned lock without torch (7.2) |
| `<harness>\engine\uv\uv.exe` | uv, installed by the installer |
| `<harness>\engine\laya\python\` | uv-managed CPython (`UV_PYTHON_INSTALL_DIR`) |
| `<harness>\engine\laya\venv\` | the virtual environment; `venv.new` while installing or updating, `venv.old` only during the swap of 7.2 step 8 |
| `<harness>\engine\laya\cache\` | the uv cache (`UV_CACHE_DIR`), deleted after install and after update, so an update downloads again |
| `<harness>\engine\laya\swap.json` | the install journal of 7.2 step 8, present only while a swap is in progress |
| `<harness>\engine\laya\install.lock` | held by whichever process installs, updates, repairs or removes (the card or `install-cli.mjs`), with its pid |
| `<harness>\engine\laya\run\` | the sidecar's working directory, always empty |
| `<harness>\engine\laya\installed.json` | `{ laya, torch, torchIndex, cuda, gpu, python, uv, lockSha256, torchWheels, installedAt }`, `torchWheels` being `[{ name: 'torch', version, recordSha256 }]` (7.2 step 4) |
| `<harness>\models\laya\hf\` | `HF_HOME` for Laya's weights, a plain Hugging Face cache |
| `<harness>\models\laya\weights.json` | `{ repo, commit, files: { <path>: { size, mtimeMs, sha256 } }, downloadedAt, loadedAt }`, recorded only after the files have loaded once through Laya (7.3) |
| `~/.kzh/jev-router/laya.json` | per-PC settings, measurements, the last Test Laya |
| `~/.kzh/jev-router/laya/laya-serve.log`, `install.log` | logs, rotated at 5 MB, two kept |
| `~/.kzh/jev-router/laya/sidecar.json` | `{ pid, interpreterPid, interpreterPath, port, startedAt }`, never the key |
| `~/.kzh/jev-router/laya-standing.jsonl` | the standing of 6.7, outside `domains/` |

`engine/` and `models/` are already gitignored.
The working directory matters: Laya's `Agent` treats `convaiinnovations/laya` as a local path whenever that relative path exists (`laya/agent.py:252`), so the sidecar runs from a folder where it cannot.

### 7.2 Install

**uv comes with the installer.**
`scripts/Install-Harness.ps1` and `scripts/Update-Harness.ps1` gain one step, `uv (for the optional Laya decision model)`, that runs every time: if `engine\uv\uv.exe` is missing or not version 0.12.18, it downloads `https://github.com/astral-sh/uv/releases/download/0.12.18/uv-x86_64-pc-windows-msvc.zip`, checks size 17,891,221 bytes and SHA-256 `cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff` (the release's own `.sha256` file matches, checked in this pass), and unpacks it; it prints `ok: uv 0.12.18`, installs no Python and downloads nothing else.

**Everything else is one implementation, `laya-install.js`**, used by the card's `Install Laya` button (`POST /jev-router/laya/install`) and by `Install-Harness.ps1 -Laya`, which runs `node plugins\jev-router\laya\install-cli.mjs install`, so the logic is not copied into PowerShell.
The CLI takes `install [--gpu | --cpu] | update | repair | remove | recover`; without a flag it installs for the GPU when the NVIDIA driver reports a CUDA version.
Every uv call runs with `UV_PYTHON_INSTALL_DIR=<harness>\engine\laya\python`, `UV_CACHE_DIR=<harness>\engine\laya\cache` and `UV_NO_CONFIG=1`, so nothing lands in the user profile.
The cache and the venvs are both under `engine\laya`, on one drive, so uv's default hard-link mode applies and a package's files exist once on disk; deleting the cache afterwards leaves the linked files in the venv.
Only one process installs at a time: `laya-install.js` takes `engine\laya\install.lock` (created exclusively, holding its pid) for install, update, repair and remove, and a second caller, the card or the CLI, is refused with `Another Laya install is running (pid <pid>).`; a lock whose pid is not alive is taken over.
`install-cli.mjs` refuses while the harness is running (the DSH engine answers on 3080), because it cannot stop the app's sidecar: `Close Kz-harness first, or install Laya from Settings → Jev setup → Laya decision model.`

`config/laya.json`:

```json
{
  "uv": { "version": "0.12.18", "source": "https://github.com/astral-sh/uv/releases/download/0.12.18/uv-x86_64-pc-windows-msvc.zip",
          "size": 17891221, "sha256": "cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff",
          "linux": { "source": "https://github.com/astral-sh/uv/releases/download/0.12.18/uv-x86_64-unknown-linux-gnu.tar.gz",
                     "size": 19798687, "sha256": "89eadd7c76fc063887959510d5ba0ab1264dfd5f1143b925ddb73021a40acf16" } },
  "python": "3.12",
  "laya": "0.3.20",
  "torch": { "version": "2.14.0",
             "cuda": [ { "tag": "cu130", "minDriverCuda": 13.0 }, { "tag": "cu128", "minDriverCuda": 12.8 }, { "tag": "cu126", "minDriverCuda": 12.6 } ],
             "indexBase": "https://download.pytorch.org/whl/" },
  "lock": "config/laya/requirements.lock",
  "weights": { "repo": "convaiinnovations/laya", "checkpoint": "english",
               "allow": ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"], "approxBytes": 842609220 },
  "vramEstimateGB": 2.5, "ramEstimateGB": { "cpu": 3.3, "cuda": 1.5 }
}
```

`uv.linux` pins the Linux build the same way, so `laya-install.js` can fetch the pinned uv for the cloud end-to-end test (9.4); the Windows pins are the ones above.

`config/laya/requirements.lock` is written by `scripts/laya-lock.mjs` with `uv pip compile config/laya/requirements.in --universal --python-version 3.12 --generate-hashes --no-emit-package torch --exclude-newer <cutoff> --default-index https://pypi.org/simple --custom-compile-command "node scripts/laya-lock.mjs"`, and a header naming uv 0.12.18 and the cutoff.
The cutoff is the `# exclude-newer:` line of `requirements.in`, 2026-09-24T12:00:00Z, after laya 0.3.20's upload that day, so running the script again gives the same lock until the line is moved on purpose; the result is the same as an uncut compile.
It pins every dependency, transformers and huggingface_hub included, because Laya shipped 28 releases in 7 days; it resolves from PyPI today (checked in this pass: 62 pinned packages, torch excluded, the Linux-only CUDA libraries behind `sys_platform == 'linux'` markers).
One universal lock is used on Windows and in the cloud end-to-end test, so the file the laptop installs is exercised before the laptop.
The torch variant for Windows cannot be checked from the cloud (download.pytorch.org is blocked here), and nobody has confirmed that each listed tag has a 2.14.0 win_amd64 cp312 wheel: the first real check is the owner's install.
So `torchIndexes(specs.cuda)` lists, in order, every `cuda` entry whose `minDriverCuda` is at or below the driver's CUDA version (`detectSpecs().cuda`), and step 4 tries them in turn (below); with none, or with no NVIDIA driver, it is the CPU wheel from PyPI, with the reason on the card.
The tag the laptop took is recorded in checklist step 1 and then written into `config/laya.json` as the first entry.

The steps, each shown on the card with its progress, each resumable:

1. `Checking the downloads and disk`: free disk (8 GB while installing for the GPU, 3 GB for the CPU, both estimates until the desktop install measures its peak, which then goes into `config/laya.json`); HEAD probes of 5 s each to `github.com` (uv and Python come from GitHub releases), `pypi.org`, `files.pythonhosted.org`, `huggingface.co`, and for the GPU `download.pytorch.org`; an unreachable host is named in the error.
2. `Getting uv`: `engine\uv\uv.exe --version` must print 0.12.18; when the installer was not re-run, `downloadVerified` (`local.js:102`) fetches it with the pins above.
3. `Getting Python 3.12`: `uv python install 3.12`, then `uv venv --relocatable --python 3.12 --python-preference only-managed <harness>\engine\laya\venv.new`.
4. `Installing PyTorch 2.14.0 for the GPU (CUDA <x>)` or `Installing PyTorch 2.14.0 for the CPU`: `uv pip install --python venv.new torch==2.14.0 --index-url https://download.pytorch.org/whl/<tag>`, or from PyPI for the CPU; progress is the cache folder's size against the wheel size; the SHA-256 of torch's installed `RECORD` file, which lists a hash for every file the wheel installed, goes to `installed.json` as `torchWheels`, so a later change is detectable, because the CUDA wheel cannot be hash-locked from the cloud and uv keeps no wheel file to hash.
   When the index has no matching wheel for a tag (HTTP 404, or uv's `no matching distribution` / `no solution`), the step tries the next tag of the list, and the card names each tag tried: `PyTorch 2.14.0 has no Windows wheel for cu130; trying cu128.` (naming `Linux` there on Linux); only when every listed tag fails does the step fail, offering `Install for the CPU instead`.
5. `Installing Laya 0.3.20`: `uv pip install --python venv.new --no-deps --require-hashes -r config/laya/requirements.lock`, then `uv pip check --python venv.new`, then `venv.new\Scripts\python.exe -I -c "import json, torch, laya; print(json.dumps(...))"` reporting the torch version, `torch.cuda.is_available()`, the GPU name and the laya version.
   It is `uv pip install`, never `uv pip sync`, because sync removes every package not in the lock, and the lock leaves torch out.
6. `Downloading the Laya model from Hugging Face`: section 7.3; progress is the bytes under `models\laya\hf\hub\` against `weights.approxBytes`.
7. `Checking that it starts`: the real sidecar start of 7.4 from `venv.new` on a port from the sidecar's own allocator (7.8) and the chosen device, then the protocol checks of `createProbe(connection)` (4.6), then stop.
   On an update, the running sidecar is stopped first (refused while a Laya Auto run is open), because a second Laya on a 4 GB GPU beside the first would run out of memory or fall back to the CPU and the check would pass or fail on the wrong device; when the check fails, the old sidecar is started again from `venv`.
8. `Cleaning up`, a journalled swap:
   1. write `swap.json` `{ step: 'stopping', from: 'venv', to: 'venv.new' }`;
   2. stop the running sidecar if any, and wait until its spawned and interpreter pids have exited, not only until `taskkill` returns;
   3. rename `venv` to `venv.old` (journal `renamed-old`), then `venv.new` to `venv` (journal `renamed-new`), each rename retried with backoff for up to 30 s on `EPERM`, `EACCES` and `EBUSY`, as `training.js:254-260` does, because Windows keeps a directory locked while a process that is exiting or an antivirus scan of the new DLLs still holds a handle;
   4. delete `venv.old` (retried the same way; a leftover is deleted at the next start), write `installed.json`, delete `swap.json`, delete the uv cache, and report the space freed.

A failed step leaves the previous install untouched and removes `venv.new`; Hugging Face's partial downloads are kept and resume on `Try again` (7.3).
A step with no progress for 5 minutes fails with `No progress for 5 minutes while <step name>.`
At plugin start, before the orphan sweep, `laya-install.js` `recover()` finishes or undoes an interrupted install, so an engine killed between two renames (Use it here's tree kill, an app quit, Check for updates restarting the harness) never leaves `installed.json` pointing at a missing venv: with `swap.json` present, `venv.old` present and no `venv`, it renames `venv.old` back to `venv`; with `renamed-new` journalled and `venv` present, it deletes `venv.old` and completes the step; a `venv.new` with no journal is deleted; and each action is logged and shown on the card: `An interrupted Laya install was rolled back; Laya <version> is still installed.`
When torch installs but reports no CUDA on an NVIDIA machine, the card says `Installed for the CPU: PyTorch reports no usable CUDA (driver CUDA <x>). Update the NVIDIA driver, then choose Remove and Install Laya again.`, and nothing is retried silently.
Expected sizes, all recorded as measured by the install: uv 18 MB, Python about 30 MB, PyTorch about 2.5 GB for the GPU or about 120 MB for the CPU wheel, Laya and its libraries about 100 MB, the English checkpoint 0.84 GB in fp16 (the published file may be fp32, 1.7 GB).
`Remove` stops the sidecar and deletes `engine\laya` and `models\laya`; `laya-shadow.jsonl`, `laya-samples.jsonl` and the standings stay.
`Repair` is step 6 alone: the weights, offline first, loaded once through Laya and recorded (7.3).
The card has no Reinstall button: a reinstall is `Remove` and then `Install Laya`, which is what the note says.

### 7.3 Weights: download, cache, offline copy

- Laya downloads its own weights, with its own loader: step 6 runs `venv\Scripts\python.exe -I -u -X utf8 plugins\jev-router\laya\fetch_weights.py` with `HF_HOME=<harness>\models\laya\hf`, `HF_HUB_DISABLE_TELEMETRY=1`, `HF_HUB_DISABLE_SYMLINKS_WARNING=1` and `HF_HUB_DISABLE_XET=1`.
- `HF_HUB_DISABLE_XET=1` because the lock pins `hf-xet` 1.6.0 beside `huggingface_hub` 1.33.0, which would otherwise fetch Xet-backed files from Xet storage hosts that step 1 does not probe, and without the classic `.incomplete` file and HTTP range resume; with it, the download goes to huggingface.co and its CDN only, and resumes.
  The desktop test checks the resume once (9.5 step 1).
- `fetch_weights.py --repo convaiinnovations/laya --checkpoint english` calls `laya.router.Router(device='cpu').preload(['english'])`, which downloads exactly the files Laya's `Agent` loads with its own allow-patterns (`laya/agent.py:259-270`) and proves they load, then prints the snapshot commit and each file's size as JSON.
  It refuses when Laya's own `DEFAULT_MODELS` loads that checkpoint from another repo, so `weights.json` never names a repo Laya did not read.
- It runs first with `HF_HUB_OFFLINE=1`, and goes online only when that fails, so a copied cache installs with no network.
- KzH then hashes every file under the snapshot into `weights.json`, with each file's size and `mtimeMs`; the commit is the snapshot folder name.
- `weights.json` is only ever written after the files have loaded once through Laya: on load, Laya rewrites `tokenizer/tokenizer_config.json` inside the snapshot when `tokenizer_class` is missing or `TokenizersBackend` (`laya/agent.py:33-72`), so a record taken before a load would see that file change at the first start and refuse the second.
  Step 6 records after `Router.preload`; `Repair` and `Use the newer model` load once the same way before recording; the cloud test's planted cache goes through `fetch_weights.py` in offline mode for the same reason (9.4).
  A mismatch limited to `tokenizer/tokenizer_config.json` whose new content parses as JSON is re-recorded with a log line, not refused.
- The revision cannot be pinned in advance, because huggingface.co is blocked here, so it is recorded at install and frozen: every later start runs with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, and Laya resolves `refs/main` in KzH's own cache to the commit that was downloaded.
- Before each start KzH checks `weights.json` against the files (size and modification time; a full hash only when either changed), and refuses to spawn with `Laya's model files are not complete on this PC (model.safetensors is missing). Choose Repair, or copy models\laya\hf from another PC.` rather than letting Laya fail inside its load.
- **Offline copy**: `models\laya\hf` is a plain Hugging Face cache; copying it to the same place on another PC and choosing `Repair` verifies and records it with no network call.
  The cloud end-to-end test plants its random-weight checkpoint the same way (9.4).
- Hugging Face on Windows without Developer Mode stores copies instead of symlinks, which costs only disk.

### 7.4 Supervision: `laya-sidecar.js`, a second supervisor

`local.js` is not given a second slot.
`createLocalModels` holds one `engine` (`local.js:756`) and `acquire()` stops it to start another (`local.js:1155-1170`), with llama-specific arguments, memory reading and planning throughout, so a Python process inside it would touch every one of those paths and could evict the chat model; a separate supervisor cannot, by construction, and `acquire()` can never stop Laya.
It imports from `local.js` only the pure helpers `freePort`, `workingSetOf`, `defaultThreads`, `sha256File` and `downloadVerified`, and a new exported `killTree(pid)`.

```js
export function createLayaSidecar({ harnessDir, dataDir, config /* providers.layaSettings */, pins, specs, residency,
                                   configError,  // providers.layaError, or the reason config/laya.json could not be read: Laya stays off
                                   readBudget,   // () => Promise<{ maxRamGB, maxVramGB, maxCores }>, wired to local.readSettings() in apply()
                                   probe,        // laya-selfcheck.js createProbe (4.6), for the warm-up
                                   isLocalBusy,
                                   isBusy,       // the Laya client's gate: a request is on the wire (7.5, and the hardMs watch)
                                   spawn, fetch, run, log, now, onChange,
                                   platform, killTree, readWorkingSet, setPriority, isAlive, timing }) -> {   // the last six for tests
  status(), installed(), isReady(), paths,
  start({ reason, device }), stop({ reason }), restart({ reason, device }),
  warm({ atStartup }),                                                                   // a background start when installed and not failed; never throws;
                                                                                         // with atStartup, only when startWithKzh is on
  ensureReady({ signal, onWait }) -> Promise<{ url, key, device, pid }>,                // throws LayaUnavailable(reason), bounded by deadlines.startWaitMs
  hold(key), release(key), held(),                                                       // an open Laya Auto run, a Test Laya, an install check (7.6)
  connection() -> { url, key, device, pid } | null,
  reservePort() -> Promise<number>, freePortReservation(port),                          // the one port allocator (7.8)
  setPriority('normal' | 'below_normal'),
  noteResult({ status, ms, tokens, phase, role }),                                       // 500 counting, idle timer (acting only), msPerToken, the GPU spill check
  sweepOrphans(),                                                                        // run by apply() first (7.5)
  checkStart({ venv, device }),                                                          // the real start install step 7 checks with, so the installer needs no second supervisor
  noteInstall(job), suspend(), resume(),                                                 // the installer's progress as the installing states; a start waits while the venv is swapped
  noteSelfTest(result),                                                                  // Test Laya's result into laya.json, which has one writer
  readSettings(), setSettings(patch),
  logTail(n), dispose(),
}
```

`dispose()` leaves the supervisor disposed for good: nothing starts, restarts or checks Laya afterwards (a start, `ensureReady`, `warm` or `checkStart` refuses with `Laya was stopped with KzH`, and a call waiting out a crash backoff hears so at once), and an exit is no longer acted on.
A `restart` the person asks for is refused while a Laya Auto run holds Laya, as Stop is; the Laya client's own restart of a request past `hardMs` (`restart({ reason: 'hung' })`) is not, and is recorded as the supervisor's own (7.5).

The command is the official entry point, nothing KzH-owned in Python on the serving path:

```
<harness>\engine\laya\venv\Scripts\python.exe -I -u -X utf8 -m laya.serve
cwd <harness>\engine\laya\run, windowsHide, stdout and stderr to laya-serve.log and to the tail kept in memory
```

`-I` keeps user site-packages and `PYTHON*` variables out of the venv, `-u` makes Laya's `print` warnings arrive as they happen, and `-X utf8` keeps the log in UTF-8.

| Env | Value | Why |
| --- | --- | --- |
| `LAYA_HOST` | `127.0.0.1` | upstream's default is `0.0.0.0`, which would expose the port on the LAN and raise a firewall prompt |
| `LAYA_PORT` | `reservePort()`, from `config.laya.port` (8091) upward (7.8) | llama-server's `freePort` tries 8081 to 8090, and 3080 is the DSH engine |
| `LAYA_API_KEY` | `randomBytes(24).toString('hex')`, new per start | the SDK requires a key, and nothing else on the PC can then call it |
| `LAYA_MODELS` | `english` | preload only the pinned checkpoint |
| `LAYA_PRELOAD` | `1` | the port answers only once the model is loaded |
| `LAYA_DEVICE` | `cuda` or `cpu`, resolved in 7.7 | KzH must know what it asked for |
| `LAYA_THREADS` | `maxCores == null ? defaultThreads(specs.cpu) : Math.min(maxCores, machine threads)`, as `local.js` `limitsFor` computes llama's (`local.js:985`), with `maxCores` from `readBudget()` | oversubscribing is a large regression, and llama.cpp shares the CPU; `maxCores` defaults to null, and `Math.min(null, n)` is 0, which `laya.serve` ignores (`serve.py` `_apply_thread_limit`), leaving torch on every logical core |
| `LAYA_AUTO_TASK` | `0` | never auto-route to typed-decisions |
| `LAYA_LOG_LEVEL` | `warning` | access lines only at warning and above |
| `HF_HOME`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1` | | no network at start or inference |
| `TOKENIZERS_PARALLELISM` | `false` | no extra thread pool beside `LAYA_THREADS` |

Every `TYPESAFE_*` variable and the Hugging Face token (`HF_TOKEN`, and `HUGGING_FACE_HUB_TOKEN`, its older name) are removed from the child's environment, and from that of every command the installer runs (uv, Python, the import check and `fetch_weights.py`), by one filter, `withoutSecrets` in `laya-install.js`: Laya's weights are public, and nothing Laya runs talks to TypeSafe.

**The real interpreter.**
On Windows the venv's `python.exe` can be a redirector that starts the base interpreter as its child, so after the port answers the supervisor runs `Get-CimInstance Win32_Process -Filter "ParentProcessId=<spawned pid>"` once and takes the `python.exe` child as `interpreterPid`, else the spawned pid itself; the RAM reading and the priority changes target `interpreterPid`, and the kill targets the tree.

States: `not_installed`, `installing`, `install_failed`, `stopped`, `starting`, `ready`, `restarting`, `failed`, `stopping`, `disabled`.
What each state means to every caller:

| State | `ensureReady` (every acting request, `classify`) | `warm()` | Card `Stop` |
| --- | --- | --- | --- |
| `not_installed`, `installing` (first install), `disabled`, settings error | throws `LayaUnavailable` with the 3.5 text | nothing | not shown |
| `install_failed` | as `not_installed` when nothing was installed before, else as the running install's own state | nothing | as that state |
| `stopped` | starts it and waits, bounded by `startWaitMs` | starts it | not shown |
| `starting` | waits, same bound | nothing | stops it, unless an open Laya Auto run holds it |
| `ready` | returns at once | nothing | refused while an open Laya Auto run holds it (Keep Laya loaded and Test Laya do not): `Laya is deciding for an open Laya Auto run; stop that run first.` |
| `restarting` (crash backoff) | waits for the restart, same bound | nothing | stops it and ends the backoff |
| `stopping` | waits for the exit, then starts it, same bound | starts it after the exit | nothing more |
| `failed` | throws `LayaUnavailable` at once; sticky until the person presses Start | nothing | not shown; `Start` clears it |

A start that fails (an early exit before ready, or the ready bound passing) sets `failed` with the reason and the last 20 log lines, and never enters the crash backoff of 7.5: reloading torch three more times while a run waits helps nobody.
The one exception is a bind failure (`address already in use` in the log after the model loaded), which retries once on the next port from `reservePort()` without counting.
A start that is stopped, or whose interpreter exits, while the warm-up takes its last readings ends there, `stopped` or `failed`, and never declares a gone Laya ready or leaves it registered in the residency.
`Restart on the GPU` checks the GPU room of 7.7 before it stops the running CPU instance, and when there is no room it refuses with the numbers and leaves Laya running on the CPU.

### 7.5 Health, readiness and restarts

- `laya.serve` builds and preloads the Router before uvicorn binds (`uvicorn.run(create_app(), ...)`), so the port answers only when the model is loaded.
- Ready means: the child is alive, `GET /health` (polled every 500 ms, 2 s timeout) answers `status: 'ok'` with `loaded` containing `english`, and the warm-up has answered through `probe(connection)` with this start's key, which also proves that the server answering on the port is this child and not a leftover.
- **The warm-up** always sends Test Laya's two intent probes, which pay CUDA initialisation before the first real call.
  On the first start per device and identity (no per-phase figure in `laya.json` for that device yet), it also sends the maximal route task view and the maximal review view that `laya-selfcheck.js` builds (4.6), because KzH's largest requests put 19 rows of about 280 tokens, or 9 rows of 512, into one tensor, a large multiple of the intent probes' activation memory.
  Those requests measure `msPerToken` for every phase (4.5) and the VRAM and RAM peaks the budget reads (7.7); on the CPU they add about 25 s to that one start, and the start line says `measuring Laya on this PC`.
  Measured this way, a first real route cannot be the first request to need that much memory, and a GPU that cannot hold it is found at start, not in a run.
- The bound is 300 s for the first start after an install (the first import of torch while antivirus scans about 3 GB of DLLs) and the same for later starts, and `loadMs` is recorded per start in `laya.json` and shown in the start line; an early exit fails the start with the last 20 log lines (7.4).
- The device comes from the log, because `/health`'s `device` only echoes `LAYA_DEVICE` (`serve.py` `health`).
  Three of Laya's own lines are parsed: `CUDA requested but not available. Falling back to CPU.` (`laya/agent.py:302`), `could not place the model on cuda, so it is running on CPU` (`laya/agent.py:431`), and `GPU memory exceeded during inference. Falling back to CPU...` (`laya/agent.py:628`).
  Any of them sets `device: 'cpu'` with `deviceWhy`, moves the deadlines to the CPU figures, and shows `Restart on the GPU` on the card; nothing is silent.
  The third line is printed for any runtime error whose text contains `memory` or `cuda` (`laya/agent.py:625-638`), so a CUDA context broken by sleep prints it too; its `deviceWhy` reads `the GPU failed during inference (out of memory, or a CUDA error such as after sleep or hibernation)`, never plain "out of memory".
- The temperature warning (`this checkpoint ships invalid temperatures ... choice:11+=0.1006 -> 0.5`) is parsed into `status().warnings`.
- While ready, `/health` is polled every 30 s with a 10 s timeout; three failures in a row restart the sidecar, and a miss is not counted while a request is in flight on the gate, whose own state already knows the server is busy and whose `hardMs` covers a hung inference: a below-normal Python thread beside llama.cpp and a build can take seconds to answer while it computes a shadow chunk.
- An unexpected exit of a ready sidecar restarts with backoff (at once, after 10 s, after 60 s); a fourth exit within 10 minutes stops restarting and sets `failed`.
- A request busy longer than `hardMs` (270 s) restarts it: `Laya spent over 270 s on one request and was restarted.`
  The Laya client usually sees it first and asks with `restart({ reason: 'hung' })`, which is recorded as the supervisor's own restart (`lastRestart`, with an exit's code and signal when an exit caused one), so the card says why (8.2), and which is not refused while a run holds Laya.
- Two HTTP 500s in a row restart it; `laya.serve` answers any inference exception with a bare `inference failed` and logs no traceback (`serve.py` `create_app`), so the reason shown is the non-access log lines since that request started, else `laya.serve gave no reason`.
- A 401 on a request is first read as a stale key: the client rebuilds from `connection()` and retries once (4.5).
  A second 401 means a server that is not this child answers on the port, and the sidecar restarts on a fresh port; a leftover `laya.serve` holding the port cannot be the cause of a failed bind in the same start, which exits and is handled in 7.4.
- **Orphans**: `apply()` calls `sweepOrphans()` before anything else, not only before a start, because an engine crash that skipped the exit hook leaves a Laya holding about 2.5 GB of VRAM, 3.3 GB of RAM and a port while the card says stopped and llama.cpp fits around it.
  It reads `sidecar.json` and kills the tree of each recorded pid (`pid` and `interpreterPid`) that is alive, whose executable path is under `<harness>\engine\laya\` (the venv's redirector or the base interpreter in `python\`, whose command line holds the base path, not the venv's) and whose command line contains `laya.serve`.
  What it killed is logged and shown on the card: `Stopped a Laya left running by an earlier session (pid <pid>, <r> GB RAM).`
  The app's "Use it here" tree kill of the 3080 engine already takes the sidecar with it.

### 7.6 Start with KzH, keep loaded, idle

`~/.kzh/jev-router/laya.json`, written only by `setSettings` with per-field checks:

```json
{ "startWithKzh": false, "keepLoaded": false, "idleMinutes": 30, "device": "auto", "shadow": true,
  "measured": { "cpu": { "identity": null, "msPerToken": { "intent": null, "route": null, "review": null }, "ramGB": null, "loadMs": [] },
                "cuda": { "identity": null, "msPerToken": { "intent": null, "route": null, "review": null }, "ramGB": null, "vramGB": null, "loadMs": [] } },
  "lastSelfTest": null }
```

`measured.<device>.identity` names the Laya version, weights commit and adapter the figures were taken with, so "the first start per device and identity" (7.5) can tell when they belong to another identity and measure again.

- `startWithKzh`: `apply()` calls `warm()` after the plugin is up, never awaited and never blocking start-up.
- **Held.** The sidecar is held while any hold is open: `route()` holds it for every open Laya-decided run, from its start to its return (2.4), Test Laya and the install check hold it while they run, and `keepLoaded` holds it permanently.
  A held Laya is never idle-stopped, never the watchdog's victim, and never unloaded to make room for a local model (7.7).
- **Idle.** Otherwise the sidecar stops after `idleMinutes` (1 to 240) without an acting request or a Test Laya; shadow requests never reset the timer, so Jev Auto use with the shadow on does not keep Laya loaded, and a Laya started once by a test is gone again within `idleMinutes`.
  The idle time runs from the last acting request, `ensureReady` (which comes before every acting request), Test Laya, or the release of the last hold, and is checked every 5 s against the clock rather than by one timer.
- Both switches default off, because a resident model on a 4 GB GPU would take layers from the local agents in every Jev Auto run; the card says what that costs, and the owner's checklist turns both on for the test (9.5).
- These are Laya's own settings: `local.js` `loadAtStart` is stored but never acted on and `keepWarm` has no UI, and fixing those is not this change.

### 7.7 The resource budget

**Device** (`device: 'auto' | 'gpu' | 'cpu'`):

- `auto` takes the GPU when `installed.json` says torch has CUDA, `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits` shows at least Laya's VRAM need plus 0.3 GB free, and, with a VRAM budget set (`readBudget().maxVramGB`), llama's resident VRAM plus Laya's need stays within it; otherwise the CPU, with the reason on the card, for example `Running on the CPU, not the GPU: the GPU had 0.9 GB free and Laya needs about 2.5 GB.`
- `gpu` with no room refuses to start and names the numbers, rather than starting into an out-of-memory fallback.
- Laya's VRAM need is measured (the change in `memory.used` across load and the full warm-up of 7.5, since per-process figures are often not reported under WDDM) and is 2.5 GB before any measurement: Laya moves the fp32 model to the device and only autocasts to fp16 (`laya/agent.py:395-417`), so the weights alone are about 1.69 GB, before the CUDA context and activations.
- **Spill into system memory.** NVIDIA's Windows drivers from 536.40 ship a "CUDA Sysmem Fallback Policy" whose default lets an allocation that does not fit spill into shared system memory instead of failing, so on a 4 GB GPU shared with llama.cpp, running out of VRAM raises no error, Laya never prints its fallback line, and both models slow down over PCIe while `memory.used` (dedicated memory) cannot show it.
  So after each acting GPU request `noteResult` compares its ms per token with the device's figure for that phase, and when a request takes over three times as long while `nvidia-smi` shows dedicated memory within 0.3 GB of full, the card and the run's lines say `Laya's GPU memory is spilling into system memory, so it and the local models are slow. Stop the local model, or pick CPU for Laya.`, and the comparison counts it.
  The request is judged before it is folded into the figure, and a spilled request, acting or in the background, never is: folded in, it would raise the figure the next request is judged against, and the warning would clear on the next call while the spill went on.
  So the figure, and with it the deadlines and the model menu's cost, stays Laya's unspilled speed; a call the spill pushes past its deadline fails as a timeout, beside the spill line, and the warning stays until an acting request is back under three times the figure.
  The card's help and the checklist (9.5 step 6) say how to set `Prefer No Sysmem Fallback` for the venv's `python.exe` in the NVIDIA Control Panel, so a spill becomes an out-of-memory error that Laya reports.

**VRAM beside llama.cpp**: no hold-back is added in `local.js`.
llama.cpp's `--fit` places layers against what is free as the model loads (`local.js` `fitTargetMiB`), so when Laya is already resident, llama fits around it and a VRAM budget holds both; adding Laya's VRAM to the hold-back would count it twice.
That is the cost of a **held** Laya only: when a local model starts and Laya is on the GPU and not held, `local.js` asks the residency to unload it first (`residency.yieldFor('llama')`), so llama's `--fit` sees the whole GPU and the local agent gets the layers it would have had without Laya; the shadow comparisons skipped meanwhile are counted `yielded`.
When llama is resident first, the `auto` rule above keeps the sum within the budget or puts Laya on the CPU.
The card and the local models card say it plainly: `While Laya is held (Keep Laya loaded, or a Laya Auto run), the VRAM budget holds Laya and the chat model together, and on a 4 GB GPU local models get about <x> GB less. Otherwise Laya gives the GPU up when a local model starts.`

**RAM: one budget for every local model process.**
New `plugins/jev-router/residency.js`:

```js
export function createResidency({ log }) -> {
  set(id, { pid, startedAt, device, name, busy: () => boolean, held: () => boolean, keepWhileHeld,
            unload: (why /* { kind: 'budget' | 'yield', text, for } */) => Promise<void>,
            ramGB, vramGB /* a number, or a function of none */ }) -> entry,
  clear(id, entry), get(id), list(), generation(),
  othersRamGB(id, { heldOnly }), othersVramGB(id, { heldOnly }), othersNames(id, { heldOnly }),
  yieldFor(id, { name }) -> Promise<string[]>,   // unloads every other resident that is neither held nor busy; returns their ids
}
export function victimOf(list)   // the watchdog's victim order, below
export function createBudgetWatchdog({ residency, readSettings, readWorkingSet = workingSetOf, now, everyMs = 5000, graceMs = 30000, log }) -> { check(), start(), stop() }
```

`ramGB` and `vramGB` are what a resident holds by its own account, measured or estimated, and the watchdog's latest working-set reading, kept on the entry as `workingSetGB`, wins for RAM once there is one.
`name` is what the card and the refusals say; `keepWhileHeld` makes a hold bind the watchdog too, so a held Laya is never unloaded to fit the budget, while llama, always held, keeps today's rule; `unload` is told why, for a yield with the name of the resident that asked, so each can say why it went.
`clear(id, entry)` clears only that entry, so a late clear from a process since replaced changes nothing, and `generation()` counts arrivals and departures, so a reading taken across one is known stale.

- `local.js` registers the llama engine when it is ready, with `held: () => true` because the local model is what the person is using, and clears it on stop and when `llama-server` exits on its own, so a crashed engine holds nothing in the budget beside Laya; its `unload` is today's trip-and-stop body of `checkMemory` (`local.js:1050`), so the per-model `tripped` bookkeeping and the context sizing after an unload are unchanged when llama itself is the one unloaded.
- The one watchdog is made by `createLocalModels({ residency })` over the residency `apply()` hands it (it makes its own when given none), and runs for as long as the local models are up, reading nothing, not even the settings, while nothing is resident; `local.checkMemory()` stays exported for tests, calling it.
- `laya-sidecar.js` registers Laya the same way, named `Laya`, with `held` from 7.6, `keepWhileHeld: true`, and `busy` true only while the Laya client has raised the interpreter to normal priority for an acting request (4.5), so a shadow chunk never keeps Laya from giving way to a local model or from its idle stop.
- The watchdog reads every resident's working set every 5 s while a RAM budget is set; when the sum stays over `maxRamGB` for 30 s, it unloads, in this order: a Laya that is not held, then today's rule over the rest (the most recently started resident that is not busy, else the most recently started), never a held Laya; it logs why.
  Only the resident actually unloaded is recorded as tripped, so llama's `tripped` context is never shrunk because Laya's share pushed the sum over.
- Refuse-to-load uses the sum of what will stay: llama's `start()` calls `residency.yieldFor('llama')` just before its `planFor`, and `planFor`, which `status()`, readiness, `chatModel()` and `agents()` also call and which therefore only reads, subtracts `othersRamGB('llama', { heldOnly: true })` from `maxRamGB`, so llama's context is never sized down for a Laya that nothing holds, and no settings poll or readiness check ever unloads Laya; Laya refuses to start when its need plus every other resident is over it, and never unloads llama to fit: `Laya needs about 3.3 GB of RAM; the budget leaves 1.2 GB beside qwen3-8b. Stop the local model or raise the RAM budget.`
- Laya's RAM need is its measured peak working set for that device, from the full warm-up of 7.5, else 3.3 GB on the CPU (measured peak 3.26 GB on KzH's bodies) or 1.5 GB on the GPU.
- **Cores**: `LAYA_THREADS` as in 7.4.
  An acting Laya call on the CPU while `local.isBusy()` shares the cores with llama.cpp, and nothing coordinates the two thread pools; the call's live line says so, `Laya is sharing the CPU with the local model, so this call may take longer`, and its deadline already covers it through the measured figures.
  The line names the model when the client's `isLocalBusy` returns its name rather than `true`; `local.isBusy()` returns a boolean today.
- **Budget table**: `ResourceBudget` (`client.js:3597`) adds Laya to Now and Estimated peak, with a breakdown that says where Laya's figure comes from, as llama.cpp's cells say `load report` or `working set`: `2.3 GB (Laya 2.3 GB at its first start, llama.cpp not loaded)`.
  Laya's VRAM is always what its first full warm-up on the GPU measured (7.5), since the GPU memory of one process is not read while it runs; its RAM is its working set while a RAM budget is set, else what that warm-up measured; `status().running` carries `vramSource` and `ramSource` (`'first start' | 'working set'`), and the cells' titles say which, never `what it takes now` for a stored figure.
  The Estimated peak of a held Laya is Laya and the largest local model the budget lets load, counted together; that of a Laya nothing holds is the larger of the two alone, since it gives its memory up when a local model starts, and never less than Laya and the loaded model together now (`..., loaded together now`), and its title says `gives its memory up when a local model starts; while both are loaded they are counted together`.

### 7.8 Ports, key, logs

- Port: `reservePort()` is the one allocator for the main sidecar and the install or update check sidecar: it finds the first free port from 8091 upward on 127.0.0.1 and keeps it reserved in memory until that process exits, so two starts never take the same port during the seconds or minutes before `laya.serve` binds (it binds only after loading the model), which `freePort`'s immediate close of its probe socket cannot prevent (`local.js:79-88`).
- Key: new per start, in memory only, never logged or written to disk; it is both `LAYA_API_KEY` and the SDK `apiKey`.
- Logs: `~/.kzh/jev-router/laya/laya-serve.log`, rotated at 5 MB; the last 200 lines are served by `GET /jev-router/laya/log`; the KzH server log gets one line per start, ready, stop, exit, restart, yield and device change, for example `[jev] laya: ready in 14.2 s on cuda (NVIDIA GeForce RTX 3050 Laptop GPU), 2.31 GB VRAM` and `[jev] laya: exited (code 3221225477); restarting (1 of 3)`.
- Shadow skips are counted, not logged.

### 7.9 Windows specifics

- Spawned hidden; stopped with `taskkill /pid <spawned pid> /t /f`, as `local.js:1028` stops llama-server, on stop, on plugin dispose and in a `process.on('exit')` hook; a stop waits until both pids have exited.
- The real interpreter is found once per start (7.4); priority uses `os.setPriority(interpreterPid, os.constants.priority.PRIORITY_BELOW_NORMAL | PRIORITY_NORMAL)`.
- Binding 127.0.0.1 raises no Windows Defender Firewall prompt.
- Short paths (`C:\Harness\engine\laya\venv\...`) keep torch's deepest files under 260 characters, and a Hugging Face snapshot path is about 130.
- Windows cannot delete a loaded DLL, so Remove and Update stop the sidecar first, and the swap retries (7.2).
- After sleep or hibernation a CUDA context can break; Laya then prints its GPU fallback line and moves to the CPU (7.5), and the card offers `Restart on the GPU`.
- `nvidia-smi` ships with the driver.

### 7.10 Updating Laya later

- Nothing updates on its own.
- A KzH release that changes `config/laya.json` or the lock makes the card say `This KzH version pins Laya 0.3.24; 0.3.20 is installed.` with `Update Laya`, which runs steps 1, 3, 4, 5 and 7 of 7.2 to build and check `venv.new` beside the running one, then the swap of step 8.
  Step 1's disk check counts the running venv, which stays on disk until the swap; the uv cache was deleted after the install, so an update downloads PyTorch again (about 2.5 GB for the GPU) and needs the network.
  Step 7 stops the running sidecar first, as 7.2 says, because a second Laya beside it on a 4 GB GPU would test the wrong device; it is refused while a Laya Auto run is open.
  So an update is refused before step 1 while a Laya Auto run is open, and downloads nothing it could not use: `The update did not start: Laya is deciding for an open Laya Auto run; stop that run first.`; a run that opens during the download is still refused at step 7.
  On any failure the old install is started again and keeps running: `Update failed at step <n> (<step name>); still on Laya 0.3.20.`
- The weights move separately: `Check for a newer model` downloads `main` into a staging cache and says whether the commit changed; `Use the newer model` loads the staged files once through Laya (7.3), then swaps them and records the new commit.
- Either change starts a new identity, so agreement, standing and thresholds tuned on one revision are never silently assumed to hold for the next.

---

## 8. Settings UI

### 8.1 The Jev router card

The existing `Jev router` card (`client.js:3187-3191`) adds one line: `Jev calls go to api.typesafe.ai.`, or, when `TYPESAFE_BASE_URL` is set, `TYPESAFE_BASE_URL is set, so Jev calls go to <host>, and the Jev column of the comparisons is that server's answers.`, read from the setup answer's `jev.host` and `jev.hostFromEnv` (2.4); an answer without them leaves the line out rather than guess.

### 8.2 The Laya card

Settings → Jev setup gets `LayaCard`, placed right after the `Jev router` card, fed by `GET /jev-router/laya`.

Title: `Laya decision model`.
Intro: `Laya is an open decision model (Apache-2.0) that runs on this PC. In Laya Auto it routes and reviews instead of Jev, and no routing or review question leaves this PC. In Jev Auto it can answer the same questions in the background, so you can compare the two.`

| State | Status line | Buttons |
| --- | --- | --- |
| `not_installed` | `Not installed. Needs about <n> GB of free disk while installing, and the internet once.` (what Laya takes after an install is not known until one has measured it, so it is not said) then `PyTorch with CUDA will be installed for your <GPU name>.` or `No usable NVIDIA GPU found: Laya will run on the CPU. On a 4-core test machine that took about 20 s to route a task and about 10 s to review each attempt; this PC is not measured yet.` | `Install Laya…` |
| `installing` | `Installing, step <n> of 8: <step name> (<received> of about <total>).` when the step has a byte total, else `(<m> min)` counted from the step's own start (`install.stepStartedAt`), and `Installing: getting ready.` before the first step; an update or a repair says `Updating` or `Repairing` | `Cancel` |
| `install_failed` | `Install failed at step <n> (<step name>): <reason>. The previous install, if any, is untouched.`, or after a failed update `Update failed at step <n> (<step name>); still on Laya <version>.`, or for a job refused before its first step (a Laya Auto run open, another install under way) `The <install \| update> did not start: <reason>.`, which a refused update also shows beside the Laya that keeps running | `Try again` (for the device the failed install was for), `Show log`, and `Install for the CPU instead` when step 4 failed for the GPU; over a Laya that is still installed, also `Start`, `Test Laya`, `Remove…` |
| `stopped` | `Installed, not running. Laya <version>, English checkpoint <commit 7>, PyTorch <version> (for the GPU, CUDA <x> \| for the CPU).`, with `Not started: <reason>.` above it when the RAM budget or a GPU with no room turned a start down (7.7) | `Start`, `Test Laya`, `Remove…` |
| `starting` | `Starting: loading the model on the <GPU \| CPU> (<n> s; the last start took <s> s)…`, with `, measuring Laya on this PC` during the first full warm-up (7.5), and `Starting: getting ready…` before the process is launched | `Stop` |
| `ready`, GPU | `Running on the GPU (<GPU name>): <v> GB VRAM, <r> GB RAM. Measured here: about <a> s to route a task and <b> s to review each attempt.` | `Stop`, `Restart`, `Test Laya` |
| `ready`, CPU by choice | `Running on the CPU (<n> threads): <r> GB RAM. Measured here: about <a> s to route a task and <b> s to review each attempt.` | `Stop`, `Restart`, `Test Laya` |
| `ready`, CPU by fallback | `Running on the CPU, not the GPU: <reason>. Measured here: about <a> s to route a task and <b> s to review each attempt.` | `Restart on the GPU`, `Stop`, `Test Laya` where PyTorch has CUDA, else `Stop`, `Restart`, `Test Laya` |
| `ready`, GPU spilling | `Running on the GPU, but its memory is spilling into system memory, so Laya and the local models are slow. Stop the local model, pick CPU for Laya, or set Prefer No Sysmem Fallback for Laya's python.exe in the NVIDIA Control Panel.` (7.7) | `Stop`, `Restart`, `Test Laya` |
| `restarting` | `Laya stopped unexpectedly (exit code <code>) and is restarting (attempt <n> of 3).`, the signal's name in the code's place when a signal ended it | `Stop`, which ends the crash backoff (7.4) |
| `stopping` | `Stopping…` | |
| `failed` | `Stopped after an error: <reason>. Laya Auto refuses messages until you press Start.` with the last log lines | `Start`, `Show log` |
| stopped by the budget | `Stopped by the resource budget: <why>.` | `Start`, `Test Laya`, `Remove…` |
| stopped when idle | `Stopped after <n> min without a Laya Auto request. It starts again when Laya Auto needs it; the Jev Auto comparisons never start it.` | `Start`, `Test Laya`, `Remove…` |
| stopped for a local model | `Unloaded so <model> could have the GPU and RAM; it starts again when Laya Auto needs it.` | `Start`, `Test Laya`, `Remove…` |
| an orphan was stopped at start | `Stopped a Laya left running by an earlier session (pid <pid>, <r> GB RAM).` above the state's own line | |
| `disabled` | `Switched off in the configuration (jev-router laya.enabled is false).` | |
| settings error | `Laya settings error: <message>. Fix jev-router laya in cordis.patch.yml; Laya Auto is off until then.` | |
| pins unreadable | `Laya's pinned versions could not be read (<message>); run Update-Harness.ps1. Laya Auto is off until then.` (`config/laya.json` is the harness's own file, never the person's cordis.patch.yml) | |

Rows under the status line:

- `Device`: a select of `Auto (the GPU when it has room)`, `GPU`, `CPU`, with the help `While Laya is loaded on the GPU and kept loaded, the VRAM budget holds Laya and the chat model together. On a 4 GB GPU, pick CPU here if the chat model needs the whole GPU. If Laya gets slow on the GPU, set Prefer No Sysmem Fallback for Laya's python.exe in the NVIDIA Control Panel.`
- `Start Laya when KzH starts` (switch), help `Laya then has its model loaded before your first message. Unless Keep Laya loaded is on, it still unloads after the idle time, and whenever a local model needs its memory.`
- `Keep Laya loaded` (switch), help `Laya stays loaded and keeps its memory even when a local model starts: about <v> GB of GPU memory, so local models get fewer GPU layers, or about <r> GB of RAM, which the RAM budget counts before a local model's context is sized.`, and `Unload after idle (minutes)` (1 to 240, disabled while the switch is on).
- `Answer beside Jev in Jev Auto` (switch), help `Laya answers every Jev question too, on this PC, and both answers are recorded side by side. It never delays a Jev Auto run and never starts or keeps Laya loaded: when Laya is busy, starting or not running, or a local model is answering or needs Laya's memory, the comparison waits or is skipped and counted. Only Keep Laya loaded makes Laya hold memory beside a local model. Nothing is sent anywhere.`
- `Stop` while a Laya Auto run is open is refused with `Laya is deciding for an open Laya Auto run; stop that run first.` (7.4).
- `Stop` and `Cancel` stay pressable while another button's request waits on the server (a Start or a Test Laya on a stopped Laya waits for the model to load), the status is read every 1.5 s while one does, and the action a Stop ended says nothing of its own.
- A comparison that could not be read is said under the switches: `The comparisons could not be read: <message>.`
- Right after an install finishes: `To test Jev and Laya together, turn on Start Laya when KzH starts and Keep Laya loaded.`
- When the shadow is on and Laya is not running: `Laya is not running, so Jev Auto records no comparisons now. Press Start, or turn on Start Laya when KzH starts and Keep Laya loaded.`
- The counters: `Last 7 days: Laya answered <a> of <b> Jev calls in the background (<c> skipped: <d> not running, <e> starting, <f> queue full, <g> waited too long, <h> gave way to a local model, <i> Jev call failed). Agreement <p>%.`, where `<a>` counts answered and partial rows, `<b>` also counts the failed ones, which the parenthesis does not list, and `No answers compared yet.` stands in for the agreement until a question has been compared.
- The last Test Laya: `Test Laya (model <commit 7>): protocol ok. On the <GPU | CPU>: intent <a> ms, routing <b> ms, review <c> ms. <k> of 7 yes/no questions separate; <names> do not (<n> answered no to the clear yes, the pattern of Laya issue #156; <m> answered yes to the clear no). Task or question: <separates | does not separate>.`
  The parenthesis shows only the counts that are not zero and is left out when both are; a single miss reads `does not`; a failed protocol reads `protocol failed (<first problem>).`, and a run that stopped at an error gives no pair count, since a count over the pairs asked so far would read as one over all seven; an unknown device reads `On this PC`.
- After a restart the supervisor made on its own, while Laya is starting or ready again and until the person starts or stops it: `Laya stopped unexpectedly (<exit code <code> | signal <signal>>) and was restarted.`, the `hardMs` line of 7.5 as it stands, or `Laya was restarted: <why>.` for the health, 500 and 401 checks.
- What the installer said, as lines of their own: each CUDA tag it tried (7.2 step 4), why it installed for the CPU, and what `recover()` did at start (7.2).
- A failed update over a Laya that keeps running reads `Update failed at step <n> (<step name>); still on Laya <version>.` beside the state's own line, and a failed repair, removal or model check reads `<Repair | Removing Laya | The model check> failed: <reason>.`, since Laya is left as it was.
- Warnings: `Laya reports uncalibrated confidence for questions with 11 or more options (always taskType and skill; capability, strategy and the agent picks when that many are offered); KzH re-tempers them and marks each such answer uncalibrated.`
- Versions: `Laya 0.3.20, pinned by this KzH version. Model <commit 7>, downloaded <date>.` with `Check for a newer model` and `Repair`; when an update is pinned, `This KzH version pins Laya <new>; <old> is installed.` with `Update Laya`.

### 8.3 Dialogs

Install, title `Install Laya`:
`Where: C:\Harness\engine\laya (Python and PyTorch) and C:\Harness\models\laya (the model).`
`Downloads once, then works offline: Python 3.12 (about 30 MB, GitHub), PyTorch 2.14.0 (about <size>, <source>), Laya 0.3.20 and its libraries (about 100 MB, PyPI), and Laya's English model (0.8 to 1.7 GB, Hugging Face).`
`Needs about <n> GB of free disk while installing.`
The folders come from the status's `paths`, the disk figure and PyTorch's size and source from the installer's own estimates (`laya-install.js` `installOffer`: 8 GB and about 2.5 GB from `download.pytorch.org` for the GPU, 3 GB and about 120 MB from PyPI for the CPU), and the remove dialog's sizes from what the status measured of each folder (`installed.bytes`); a figure the status does not carry is left out, never guessed.
The choices are `GPU: <GPU name> with CUDA <x> (speed not measured on this PC yet; Test Laya measures it after the install)` when the offer names an NVIDIA GPU whose driver runs one of the pinned CUDA builds, and always `CPU only (smaller download; on a 4-core test machine, about 20 s to route a task and about 10 s to review each attempt)`, with the buttons `Install` and `Cancel`.
A status that carries no offer still gets a plain `GPU (speed not measured on this PC yet; Test Laya measures it after the install)` choice, because the installer itself falls back to the CPU wheel when the driver has no CUDA to offer (7.2).

Remove, title `Remove Laya?`:
`Stops Laya and deletes C:\Harness\engine\laya (<size>) and C:\Harness\models\laya (<size>). Your recorded comparisons and Laya samples are kept. Laya Auto leaves the model menu.`
Buttons `Remove Laya` and `Cancel`.

### 8.4 Routes

| Route | Body or answer |
| --- | --- |
| `GET /jev-router/laya` | the status below |
| `POST /jev-router/laya/install` | `{ device: 'gpu' \| 'cpu' }` |
| `POST /jev-router/laya/install/cancel`, `/start`, `/stop`, `/restart`, `/remove`, `/update`, `/repair`, `/selftest` | `{}`; `/restart` takes `{ device }` |
| `POST /jev-router/laya/weights/check`, `/weights/apply` | `{}` |
| `POST /jev-router/laya/settings` | a partial `laya.json` settings object; 400 with the field's message when invalid |
| `GET /jev-router/laya/log?lines=200` | `{ lines }` |
| `GET /jev-router/laya/shadow?runId=<id>` | `{ rows }`, the rows of 5.3 for that run id, which is also the inspector's live `entry.id` (2.4), from the in-memory index |
| `GET /jev-router/laya/compare?days=7\|all&identity=current\|all` | the comparison below, computed in the worker of 5.3; 404 while Laya cannot be asked and nothing was compared |

```json
{ "state": "not_installed | installing | install_failed | stopped | starting | ready | restarting | failed | stopping | disabled",
  "why": null,
  "install": { "step": 3, "of": 8, "name": "Getting Python 3.12", "received": 0, "total": 0, "error": null,
               "kind": "install", "device": "gpu", "stepStartedAt": 1790000000000, "failedStep": null, "offerCpu": false, "notes": [] },
  "installed": { "laya": "0.3.20", "torch": "2.14.0+cu128", "cuda": true, "gpu": "NVIDIA GeForce RTX 3050 Laptop GPU",
                 "python": "3.12.11", "weights": { "commit": "<40 hex>", "bytes": 842609220, "downloadedAt": 1790000000000 }, "diskBytes": 0,
                 "bytes": { "engine": 0, "models": 0 } },
  "offer": { "gpu": { "name": "NVIDIA GeForce RTX 3050 Laptop GPU", "cuda": 12.8 }, "python": "3.12",
             "disk": { "gpu": { "installingGB": 8 }, "cpu": { "installingGB": 3 } },
             "torch": { "gpu": { "bytes": 2684354560, "source": "download.pytorch.org" }, "cpu": { "bytes": 125829120, "source": "PyPI" } } },
  "expected": { "laya": "0.3.20", "torch": "2.14.0" },
  "running": { "port": 8091, "pid": 1234, "interpreterPid": 1240, "device": "cuda", "deviceWhy": null, "spilling": false, "spills": 0, "threads": 6,
               "loadMs": 41000, "startedAt": 1790000000000, "measuring": false, "lastLoadMs": 41000, "gpu": "NVIDIA GeForce RTX 3050 Laptop GPU",
               "ramGB": 1.9, "ramSource": "first start", "vramGB": 2.3, "vramSource": "first start", "msPerToken": { "intent": 0.2, "route": 0.3, "review": 0.2 },
               "busy": false, "held": ["run:<runId>"], "lastCallMs": 950, "localBusy": false, "routeMs": 2100, "reviewMs": 1400 },
  "restart": null,
  "lastRestart": null,
  "stoppedBecause": null,
  "orphanStopped": null,
  "settings": { "startWithKzh": false, "keepLoaded": false, "idleMinutes": 30, "device": "auto", "shadow": true },
  "shadow": { "answered": 0, "partial": 0, "skipped": { "not_running": 0, "starting": 0, "queue_full": 0, "too_old": 0, "jev_failed": 0, "yielded": 0 }, "failed": 0 },
  "selfTest": null, "warnings": [], "logTail": [], "configError": null, "pinsError": null,
  "recovered": null, "weights": null,
  "paths": { "engine": "C:\\Harness\\engine\\laya", "models": "C:\\Harness\\models\\laya" },
  "need": { "device": "cuda", "cpu": { "ramGB": 3.3 }, "cuda": { "ramGB": 1.5, "vramGB": 2.5 } } }
```

The sidecar's `status()` answers most of it, and `GET /jev-router/laya` adds what the card reads beside it: `shadow`, the shadow's counters (the sidecar leaves it null); `running.routeMs` and `reviewMs`, what a task costs Laya on its device (3.1); `recovered`, what `recover()` did at start (7.2); `weights`, the last `Check for a newer model` as `{ current, latest, changed }`; `paths`, where Laya lives; `need`, the device of the next start and what it would take there, measured or else the estimates of `config/laya.json`; and `offer`.
`offer` is there only while Laya is not installed.
`configError` is an error in the `laya` block of cordis.patch.yml and `pinsError` the reason `config/laya.json` could not be read, each with its own remedy on the card; either turns Laya off, and the state reads `disabled` for either, as for `laya.enabled` false, so these two fields tell the three apart.
`restart` is `{ attempt, of, code, signal }` while `restarting`, and `lastRestart` is `{ kind: 'exit' | 'hung' | 'health' | '500' | 'unauthorized', why, at }`, with an exit's `code` and `signal`, for the last restart the supervisor made on its own, until the person starts or stops Laya.
`install.failedStep` is the step a job failed at, 0 or null for one refused before its first step (8.2), `offerCpu` says whether to offer the CPU after a failed GPU install, and `notes` are the lines the installer had to say (7.2).

`stoppedBecause` is `null | 'idle' | 'budget' | 'yielded'`, and `why` carries the budget's text for `budget` and the model's name for `yielded`; `orphanStopped` is `null | { pid, ramGB }` (7.5).

The comparison, every figure a count so the client can show `n` beside each rate; `agree` is always `{ n, agree }` over every answered question and `{ n, agree }` over Laya's informative answers only (5.5):

```json
{ "identity": "laya-0.3.20|english|<commit 12>|adapter-1|corr:choice:11+=3.27|margin:0.1",
  "thresholds": { "jev": "<12 hex>", "laya": "<12 hex>" }, "jevHost": "api.typesafe.ai", "days": 7,
  "questions": [ { "name": "taskType", "type": "choice", "options": 12, "corrected": 40,
                   "compared": 41, "agree": { "all": { "n": 41, "agree": 22 }, "informative": { "n": 30, "agree": 19 } },
                   "inTopTwo": 33, "meanDifference": null, "atBar": null, "flat": 11, "layaMedianMs": 950 } ],
  "domains": [ { "domain": "task_classification", "question": "taskType", "layaAnswered": 41,
                 "agree": { "all": { "n": 41, "agree": 22 }, "informative": { "n": 30, "agree": 19 } },
                 "personSaid": { "n": 4, "jevRight": 3, "layaRight": 2 },
                 "whereJevWasContradicted": { "n": 3, "layaRight": 1 },
                 "layaAutoRuns": { "runs": 12, "failed": null },
                 "fieldAgreement": { "risk": 0.64 } } ],
  "actions": { "wouldHaveActedSame": [ { "what": "review_action", "n": 20, "same": 11 } ],
               "review": { "jev": { "accept": 12, "second_review": 3, "human": 1, "retry": 4, "belowAcceptBar": 3 },
                           "laya": { "accept": 5, "second_review": 10, "human": 1, "retry": 4, "belowAcceptBar": 10 } } },
  "skips": { "answered": 120, "partial": 2, "failed": 1,
             "skipped": { "not_running": 3, "starting": 1, "queue_full": 0, "too_old": 0, "jev_failed": 1, "yielded": 2 },
             "atContextLimit": 0 },
  "latency": { "jev": { "intent": 110, "route": 900, "review": 800 }, "laya": { "intent": 300, "route": 950, "review": 600 } },
  "standing": [ "the rows of 6.7, computed afresh for the identity asked" ] }
```

`meanDifference` is filled for nouls and scores, `atBar` for nouls with a bar per provider (`{ n, agree }`), `inTopTwo` for choices; `latency` holds median milliseconds per phase; a domain with no rows of a source has `{ "n": 0 }` there, `layaAutoRuns` included, never a rate.
`layaAutoRuns.failed` counts runs, not samples; `fieldAgreement` is a share per field for `task_classification` and null for every other domain, and the `review_action` group's `question` is null.
`standing` is computed afresh from the same files as the rest, so it is the newest reading, rather than read back from `laya-standing.jsonl`.
`layaAutoRuns.failed` (and the standing's `layaAutoFailed.failed`) is `null` where no outcome of a run can fault the pick, `task_classification` and `skill_selection` (6.7), and the card shows `not measured (<n> runs)` there.

Every string avoids em and en dashes.

---

## 9. Testing

### 9.1 The rule, made mechanical

Every new test exercises a new seam (a module, export, field or behaviour), so it fails against the old code, and the existing suites keep passing unchanged, which is how "no behaviour change for Jev" is proven.
No existing assertion is edited by any group: where a change would have touched one (the `AUTHORITIES` list at `test/training.test.js:47`), the design keeps the old export and adds a new one (6.2) instead.
`scripts/red-check.mjs <test files...> [--base <commit>] [--keep]` proves the first half:

- It adds a temporary worktree at the base (default `8e5d376`, under `TMPDIR` when it is set, and left in place with `--keep` so a result can be looked into) and links the current `plugins/jev-router/node_modules` into it (a directory junction on Windows, a symlink elsewhere), because `node_modules` is untracked and without it every test that imports `jev.js` or `index.js` fails on `@typesafe-ai/sdk` or `@deepseek-ai/schemastery`, never by assertion.
- It runs each given file on the current code first, where every test must pass, since a test that fails on both sides proves nothing, then copies the files in with `test/fixtures`, runs `node --test --test-reporter=tap` on each at the base, and reads the result of every test, not of every file.
- A test counts as new when its full name is not among the tests of the base's own version of that file (run first, with the same reporter, when the file exists at the base); every new test must fail there, and the check exits non-zero naming each new test that passed, so one failing new test cannot carry ten that pass.
- It prints the kind of each failure, and accepts three: an assertion, a missing module (`ERR_MODULE_NOT_FOUND`) only for a new module's own tests (a test file the base lacks, named for a module absent at the base and present now: `test/<m>.test.js` tests `<m>.js`), and a missing export (`SyntaxError: The requested module ... does not provide an export named ...`) for a new export of an existing module.
  An extended test file imports a new export of an existing module through a namespace import (`import * as training from '../training.js'`) or a dynamic `import()` inside the test, so the other tests of the file still load and fail by assertion; a static named import of a new export would fail the whole file at link time, and an extended file that does not load at the base is refused.
- A new test that fails at the base in a way that proves nothing there, because a module or a file this change adds (`providers.js`, `config/laya.json`) is missing, is run once more on the base with every file the change adds put in place and none it edits.
  It counts only when it then fails by an assertion or a missing export, because then the old code of the files the change edits is what fails it; one that passes there tested only what the change adds, and belongs in that module's own test file, and one that breaks there (a `TypeError` on a function the old code lacks) asserts first that the function exists.
- One test file is not asked to fail: `test/fixtures.test.js`, which tests the shared test code in `test/fixtures` (9.2), not the plugin, so its tests pass on any code.
  Each new test there must pass at the base instead, which shows it tests only the fixtures, and is listed as a test of the fixtures; one that fails there tests the code under test, and belongs in that code's own test file, where it counts as a new test.

Every group runs it on its new and extended tests before merging, and runs the whole suite (`npm test` in `plugins/jev-router`).

### 9.2 The fake Laya (shared by every group's tests)

`plugins/jev-router/test/fixtures/fake-laya-serve.mjs`, owned by group G2, behaves like the official `laya.serve` where it matters:

```js
export async function startFakeLaya({
  host = '127.0.0.1', port = 0, apiKey, loadMs = 0, msPerRow = 0,
  answer = defaultAnswer,            // (name, question, state) -> probabilities in option order, deterministic from a hash
  device = 'cpu',
  models = ['english'],              // what /health says is loaded; a request for any other model gets Laya's 500
  onInference,                       // (entry) called as each inference starts, for tests
}) -> { url, port, requests /* [{ body, authorization, arrivedAt, startedAt, finishedAt, status }] */, busy(), close(),
        setMsPerRow(n), failNext(status /* 500 | 401 | 422 */), hang() }
```

- `GET /health` answers `{ status: 'ok', loaded: ['english'], device }` only after `loadMs`, and the port is not listening before, as with the real server.
- `POST /v1/systemone` checks the bearer key (401 `{ detail: 'invalid or missing bearer token' }`), refuses more than 64 questions (413), refuses `labels` on a non-noul or a bad label map (422 naming the question), runs one request at a time behind one lock, takes `rows x msPerRow`, keeps computing when the client disconnects, and answers 500 `{ detail: 'inference failed' }` on `failNext(500)`.
- An answer has Laya's shape: `{ model: 'laya-rl-agent', answers, usage: { input_tokens, output_tokens: 0 }, routing: { model: 'english', reason: "explicit model='english'" } }`, where a choice is `{ type, choice, probabilities, confidence /* normalised entropy */, answer_confidence /* max p */, action }`, a score `{ type, score /* expected level */, legend, probabilities: { '0': ... }, confidence, answer_confidence, action }`, and a noul `{ type, noul, confidence /* max(p, 1 - p) */, answer_confidence, action }`, rounded to 4 decimals.
- `usage.input_tokens` is `sum over rows of min(512, ceil(head chars / 3.6) + ceil(state chars / 3.0))`, so the adapter's `atContextLimit` can be tested.
- Run as a script (`node fake-laya-serve.mjs`), it reads `LAYA_HOST`, `LAYA_PORT`, `LAYA_API_KEY`, `LAYA_MODELS`, `LAYA_DEVICE` and `FAKE_LAYA_LOAD_MS`, `FAKE_LAYA_MS_PER_ROW`, `FAKE_LAYA_EXIT_AFTER_MS`, which exits with code 1 that long after the process started, and `FAKE_LAYA_PRINT`, a comma list of `no-cuda`, `cpu-fallback`, `gpu-oom` and `temps`, which print Laya's own warning lines verbatim; the sidecar tests spawn it as the interpreter.

`plugins/jev-router/test/fixtures/kzh-bodies.json`, also G2's, holds KzH's four request bodies (intent, task group, resource and judgments, review), generated from the `jev.js` builders at maximal inputs by the capture script the research used (`/tmp/claude-0/laya-understand/critic/capture.mjs` is the reference).

### 9.3 Unit tests

- `test/providers.test.js` (new, G1): the Jev record from a legacy config equals today's values key by key; `thresholds.humanRequired` reaches the Jev record; an override changes Laya and never Jev; records are frozen; every threshold key is present after `resolveProviders`, filled from the defaults; `'always'` is accepted for `verificationChecks` and `needsTests`; each ordering check throws naming the key; a bad Laya block, a type or range error (`accept.low: 1.5`, a correction of 10) as much as an ordering error, yields `layaError` and leaves Jev intact.
- `test/jev.test.js` (extended, G1): the new form sends `defaultModel` and `retry.maxRetries` from the record and `timeout` per phase; `phase` rides the per-call options; a failed call calls `onError` with its class and never `onTrace`; `onCall` fires once per call with the unadapted state and deep-frozen questions, `assess`'s third argument reaches it as `context`, its settle function gets the trace, and a never-settling or throwing hook never delays or breaks the return; a hook that rewrites every question and criterion it is handed leaves that request and every later one byte-identical, and the exported criteria are frozen; `route()`, `intent()` and `assess()` return `uninformative` from the answers' flags, and `[]` for Jev; `profileFromAnswers` reads `supportingSkill` and `verificationChecks` (`'always'` always adds checks), leaves out flat scores and choices and keeps flat nouls; `assess` returns the model; the old form still works.
- `test/usage.test.js`, `test/pricing.test.js`, `test/savings.test.js` (extended, G1): a Laya row costs $0 and is not counted by `computeSavings` or the Jev monthly spend; a direct-answer row with `decider: 'laya'`, and a history record with `routing.decider: 'laya'` that ran a tool or skipped a limited agent, are not counted in "Saved by Jev"; rows without `decider` count as today; shadow calls write nothing.
- `test/effort.test.js` (extended, G1): `autoLevel` with custom bands.
- `test/laya-questions.test.js` (new, G2): the invariant for every call at maximal inputs; every noul gets labels and `NOUL_TEXT` criteria, and a noul without text fails; every choice at its maximum option count estimates within 170 head tokens; every view is at most 950 characters, with checks first in the outcome view, on the captured 9,206-character review state; `atContextLimit` from usage; `model: 'english'` on every request; shadow chunks of `chunkRows`; `renderForLaya` on deep-frozen inputs, in strict mode, never throws and returns new objects; `normalizeLayaAnswers` re-tempers exactly the answers asked with 11 or more options (a capability question with all nine capabilities is corrected, one with seven is not) at the default 3.27 and keeps keys, sets max-probability confidence, keeps `servedConfidence`, and marks flat answers.
- `test/laya-selfcheck.test.js` (new, G2): seven noul pairs and the kind pair reported apart, with the direction of each miss, and the card text for all, some and no pairs separating; `createProbe` against the fake.
- `test/fixtures.test.js` (new, G2): the fake of 9.2 against what it promises (readiness, the key, the size, Laya's 422 and 500 texts, one request at a time, Laya's answer shape and token formula, the script's environment and warning lines), and `kzh-bodies.json` held to the `jev.js` builder calls it was made from, a staleness guard; tests of test code, which pass on any code with those builders, as `red-check.mjs` shows (9.1).
- `test/laya-sidecar.test.js` (new, G3), with the fake as the interpreter: the exact command and environment (`LAYA_HOST=127.0.0.1`, a 48-hex key that differs across starts, `LAYA_MODELS=english`, `HF_HUB_OFFLINE=1`, no `TYPESAFE_*`, `LAYA_THREADS` equal to `defaultThreads` when `maxCores` is null and to `min(maxCores, threads)` otherwise, read through `readBudget`), the empty working directory; readiness needs `english` loaded plus a warm-up answered with this start's key, so another server answering `/health` on the port is not ready; the full warm-up on the first start per device and identity and the intent probes only afterwards; the three device lines, the GPU failure wording, and the temperature warning; each state of the 7.4 table for `ensureReady`, `warm()` and Stop; a failed start sets a sticky `failed` without entering the backoff, and a bind failure retries once on the next port uncounted; crash backoff and `failed` after the fourth exit of a ready sidecar; `Restart on the GPU` with no room refuses and leaves the CPU instance running; the hung restart past `hardMs`; two 500s restart; a 401 is retried once before a restart on a new port; `/health` misses are not counted while a request is in flight; weights verification refuses before spawning; idle stop after acting requests only, never reset by shadow requests, stopped by a hold; keep loaded, start with KzH; Stop refused while held; `reservePort` never hands out one port twice; the orphan sweep matches venv and base interpreter paths; the GPU spill message; settings validation messages.
- `test/laya-install.test.js` (new, G3), spawn stubbed: step order and exact commands (`uv pip install`, never `sync`); the torch tags by driver CUDA version, falling through to the next tag on a 404 or no matching distribution and naming each tag tried; the CPU-fallback text; a failure keeps the old venv; the swap with an injected `EBUSY` on the second rename, retried; a kill between the two renames, recovered by `recover()` at the next start; a stale `venv.new` deleted; `install.lock` refuses a second caller and the CLI refuses while the harness runs; an update stops the old sidecar for step 7 and starts it again on failure; `installed.json` and `weights.json` contents, with `mtimeMs`, written only after a load; a `tokenizer_config.json` that changed on load is re-recorded, not refused; offline-first weights with `HF_HUB_DISABLE_XET=1`; the no-progress failure.
- `test/residency.test.js` (new, G3): the summed watchdog unloads a Laya that is not held first, never a held Laya, and otherwise the most recently started resident that is not busy; only the resident unloaded is recorded as tripped; `yieldFor` unloads an unheld Laya and leaves a held one; refuse-to-load subtracts held residents only; a Laya start never stops llama.
- `test/local.test.js` (extended, G3): `isBusy()` while a stream is open; llama registers in the residency and leaves it when it stops or exits on its own, and a late exit never clears a newer engine; a local model's start calls `yieldFor` first, and its plan subtracts held residents' RAM only and never unloads; with Laya loaded but not held, a local model start gets the same context and fit target as with no Laya, and a busy llama is never the watchdog's victim because of Laya's share.
- `test/laya-client.test.js` (new, G4): one request on the wire; acting before a queued shadow chunk; each drop reason; the deadline rejects on time while the slot stays held until the fake answers; the caller's signal never reaches the socket: an abort during a request rejects at once and holds the slot until the fake answers, and an abort or a passed deadline while queued removes the request before the fake ever receives it; the prediction counts every acting request ahead and fails fast; the waiting line after 2 s; with an intent-only warm-up, the first route at its measured cost does not time out; `ensureReady` before every request, so a restart between two calls of one run is waited out; the hard ceiling restarts, and `UND_ERR_HEADERS_TIMEOUT` takes the same path; a 401 is rebuilt and retried once; zero retries on a 500; priority raised and lowered; the model relabel, `meta`, and an identity that does not change with the device.
- `test/shadow.test.js` (new, G4): with a 5 s fake Laya, `deps.runId` fixed and the shadow's clock fixed, a Jev Auto `runRouted` record equals the shadow-off run's once `ts`, `runId`, `durationMs` and `ms` are removed, the shadow's hook and settle functions take under 50 ms in all on the run's thread, and each run resolves within the shadow-off run's time plus 500 ms, for a Laya that answers, throws, hangs, returns garbage, and an adapter that throws; two consecutive Jev Auto runs send Jev request bodies byte-identical with the shadow on and off; rows pair by `callId` in either arrival order; each skip reason is recorded and counted; a failed Jev call withdraws its job, and a rotated 429 yields one compared row; review rows carry the `context` numbers; tool-parameter answers are recorded as indexes; a marker string placed in the task, an answer, a tool description and a tool option key never appears in the file; intent rows carry `runId: null`; learning off writes nothing; a row the disk refuses is logged and kept in memory, the Jev call answers, and the next row is written once the disk takes it; compaction keeps the newest 10,000 rows; on a file at the cap, `read({ runId })` takes under 20 ms of main-thread time, and comparing it or compacting it never holds the event loop up 100 ms (`monitorEventLoopDelay`).
- `test/shadow-stats.test.js` (new, G4): the judge table row by row, the `human` row with only a `negativeLabel` included, and yes/no domains by label set; `verified_outcome` rows of `outcome_disposition` and `review_action` undetermined, a dislike after an accept decisive; agreement for choice, noul and score, over all answers and informative ones; `jev_failed` rows excluded from agreement; review actions through `reviewAction` with the row's `context`, and the below-accept-bar counts; the sources of 6.7 never pooled (an always-yes Laya on `second_opinion` gets no accuracy from contradicted rows); identity, thresholds and Jev host separation; the compare output has exactly the shape of 8.4; the same marker test over `laya-standing.jsonl`.
- `test/training.test.js`, `test/domains.test.js`, `test/decision.test.js`, `test/policy.test.js`, `test/profiles.test.js`, `test/guards.test.js` (extended, G5) and `test/integrity.test.js` (new, G5): the store kinds and refusals; `AUTHORITIES` unchanged and `ALL_AUTHORITIES` added; `answeredBy: 'laya'` never lets a mature, confident local classifier decide, leaves the ladder state untouched, stores `provider` with `teacher: null`, reports `maturity: null`, and falls back deterministically on a throw or a flat answer in every domain but `outcome_disposition`, where a flat disposition keeps authority `laya` with `informative: false` on the sample; `pickOf` and `confirms`; every domain reports `laya` with the code domains staying `code`; the cut-offs come from the record through the policy object; `fillFlat` merges per field, requirements per dimension, drops `heuristic`, and fills the tiers with `standard` and `strong`; in the review, `mode` comes from the decider, so a Laya review with the outcome domain wired does not throw; a flat disposition with nouls under the bar gives `second_review`, never accept; flat review or retry picks give `pickOther`; `assess` gets the `context`; Laya's accept bars and the `under Laya's accept bar` wording; both fallback reason strings of 3.5; a `local`-mode review assessment in a Jev-decided record still credits `independent_review`; a Laya-decided record gives reliability rows with no `taskType`; invariants 2, 3, 6 and 8, the Laya-marker test over `laya-samples.jsonl`.
- `test/layaauto.test.js` (new, G6), whole runs through `runRouted` and the adapter with fakes: Laya Auto never calls Jev (its `systemOne` throws if called); the exact headings, strip and lines, with no maturity bracket and the `'decider-error'` line; checks always required; a `human_required` capability at 0.7 does not stop the run under Laya (bar 0.8) and does under Jev (0.6); offline Laya Auto uses the decision engine over local agents; a local effort gives `MANUAL` with a Laya review; `laya-auto` is listed only when offered, with the state sentences; `stream()` shows a refusal from `layaUnavailable` as its reply; `chatModels` and the title path call `isOffline('laya')`; in the No project space an `unsure` task is answered, not refused.
- `test/router.test.js`, `test/adapter.test.js`, `test/tasks.test.js`, `test/onlinemode.test.js` (extended, G6): each branch of 3.2 under Laya and unchanged under Jev; the routed line; `decidedBy` naming Laya; the task record keeping `decider`; `Laya picks` in the queued line; the group heading; `verdictWeight` weighs a verdict about a Laya-decided run as one of unknown type (the rest of invariant 6).
- `test/laya-card.test.js` (new, G7), through `client.js` `__test` with stand-in React as `budgetpanel.test.js` does: every state's exact strings and buttons (the spill, yield and orphan lines included), the counters, the Test Laya line with seven pairs and the kind pair, and the warning lines; `test/routerview.test.js`, `test/observability.test.js` and `test/budgetpanel.test.js` (extended, G7): the shadow column and marks, the side-by-side card rendered from the 8.4 shape, provider names, `2 Laya calls` in the history view's badge, the pill driven by `corrected`, the `'decider-error'` call card, Laya in the budget table.
- `test/laya-integration.test.js` (new, G8), with the fake: invariants 1, 4, 5, 7 and 9 over whole runs, 5 over a question, a task and a session title in one Laya Auto session; a Laya Auto run end to end; a Jev Auto run with the shadow unchanged, and replying while Laya, at 3 s a question, has answered none of its calls; every refusal of 3.5 word for word through `stream()`, a queued task and `/laya`, and a decider `'laya'` run with `providers.laya` null refused; `classify` for Laya never probes TypeSafe, waits for a start with the start line, and gives a task only on a refusal or a timeout; with `idleMinutes` 1 and an agent that works for 2 minutes, the review is answered by Laya, not by the fallback; one id in `usage.jsonl`, `history.jsonl`, the shadow rows, the inspector's `entry.id` and `/runs/stop`; `maybeRetrain` skipped after a Laya run; a Laya review sample's outcome lands in `laya-samples.jsonl`; the orphan sweep runs first in `apply()`; a `laya` block with a range error leaves the plugin loadable and Jev Auto working; a marker string placed in a Laya Auto task, a tool description and a tool option key never appears in `laya.json`, `laya-samples.jsonl`, `laya-shadow.jsonl` or `laya-standing.jsonl`; the route shapes of 8.4.

### 9.4 The cloud end-to-end test, against the real `laya.serve`

`plugins/jev-router/test/e2e/laya.e2e.mjs`, with `plugin-host.mjs`, `check_render.py` and `scripts/laya-render-check.mjs`, run by hand with `KZH_LAYA_E2E=1 KZH_LAYA_HARNESS=<dir> npm --prefix plugins/jev-router run test:e2e` and skipped without `KZH_LAYA_E2E=1`; it lies outside the `test/*.test.js` glob, so `npm test` never runs it.
It proves the real protocol, latency, memory and supervision with meaningless answers, and asserts nothing about answer quality.
Each step runs on its own: a step that fails is reported with its reason and what it measured, the next one runs, everything measured goes to `e2e-report.json` in the data folder, and the script exits 1 when any step failed.
Steps 2 to 5 and 8 drive the supervisor and the client directly; steps 6 and 7 boot the plugin with `apply()` on the same harness once the first supervisor has gone, since one harness has one Laya.

1. **Install for real, except the weights**: `laya-install.js` with `{ skipWeights: true, torchIndex: 'pypi' }` (download.pytorch.org is blocked here, so torch comes from PyPI) installs from the same universal lock the laptop uses, and `uv pip check` passes.
2. **Plant the checkpoint**: `test/e2e/make_ckpt.py` builds the English architecture with `laya.common.build_model` (ModernBERT-large: hidden 1024, 28 layers, intermediate 2624, 16 heads, vocab 50368; 421.29M parameters; fp16 safetensors of 842,609,220 bytes; the English `rl_agent_config.json` with its real temperatures, `choice:11+` 0.1006 included) and `test/e2e/plant_hf_cache.py` lays it out as `models/laya/hf/hub/models--convaiinnovations--laya/snapshots/<40 hex>/` with `refs/main`, the tokenizer being OLMo's GPT-NeoX BPE as a proxy (fetched from GitHub raw, pinned by SHA-256); `fetch_weights.py` then loads it once through Laya in offline mode, exactly as the owner's download does, and `weights.json` is recorded after that load (7.3).
   The step checks that the snapshot is complete and that `weights.json` is there.
3. **Start through the real supervisor** on the CPU: readiness, `device: 'cpu'`, the temperature warning parsed, a wrong key refused with 401 and no retry, and a connection to the machine's non-loopback address on the same port refused.
4. **KzH's real bodies** (`kzh-bodies.json`, 9.2) through the Laya client's acting client: intent, task group, resource and judgments, review; no 4xx (labels accepted), every question answered, the model relabelled, no request at the context limit; then an intent through `createJev({ provider: providers.laya, client })`.
   The timings depend on the threads Laya is given: on 4 vCPU the default (`defaultThreads`, 7.4) is one thread, on which they are about 1.6 s, 49 s, 3.2 s and 18 s (below); the appendix's benchmarks, which gave about 1.5 s, 16 to 18 s, 1.5 s and 9 s, ran torch on all four cores.
5. **The gate against the real lock**, in two parts.
   First, with this PC's own measured figures: a route call with a 3 s deadline is refused at once by the prediction of 4.5 (`LAYA_PREDICTED_OVER`, `Laya would need about <n> s for this call on the CPU, over its 3 s deadline`), and nothing is sent.
   Then, with the prediction set low so the same call is sent: it rejects at 3 s, the slot stays held until the server's own response arrives (as long as the call takes on that machine: about 45 s later with one thread on 4 vCPU, 16 to 20 s on all four cores), the rest of the call is never sent, and an acting call queued meanwhile goes out only then and runs alone; a route call whose caller aborts at 2 s does the same, and an intent call queued behind it and aborted before it is sent never reaches the server.
6. **Shadow**: a Jev Auto task through the plugin (`apply()` on the harness, a fake Jev at 300 ms, a stub agent at 500 ms), once with the shadow off and once on, takes the same time while the real Laya computes, and the shadow rows land later, one per Jev call, with no usage row for Laya.
7. **Laya Auto**: a task through the plugin, with KzH's own supervisor on the real `laya.serve`, `idleMinutes` 1 and a first agent that works for over 2 minutes, completes with no TypeSafe contact (fetch, SDK-client and Jev spies) and no line that mentions Jev; with random weights nearly every answer is flat, so the rules fill them and the heading and lines say so; the open run holds Laya past its idle minute on one interpreter, and once the run returns, Laya stops for idle.
8. **Supervision**: the first start's full warm-up records a figure for every phase and a RAM peak; the working set is positive and under 3.5 GB; killing the interpreter mid-call fails the call with the reason, the state goes `restarting` then `ready`, and the next call answers; with a 1 GB RAM budget and a 1 s grace, and a stand-in llama resident held as the local chat model always is, the watchdog passes a held Laya by, takes llama before a held Laya, and takes an unheld Laya first; a 1-minute idle setting stops Laya while shadow requests keep arriving, a shadow request after the stop finds it stopped and never starts it, and `ensureReady` starts it again.
9. **Render check**: `scripts/laya-render-check.mjs` runs `test/e2e/check_render.py` in Laya's venv, which encodes every request KzH sends with Laya's own `_check_question`, `_to_internal` and `_encode_state` (which calls `build_sequence`) and the checkpoint's tokenizer, and finds no question refused, no option of any KzH choice cut and no view cut.

It cannot show answer quality, GPU behaviour, or Windows process handling, and here it did not show the install itself (step 1); the desktop test does (9.5).

**Measured on 25 Sep 2026.**
The final run went from 11:16:08 to 11:26:11 UTC (10 min 3 s), on commit `7519f8f`, against the real `laya.serve` (laya 0.3.20, torch 2.14.0, transformers 5.17.0) on the planted random-weight English checkpoint `a6d3a27924f93be3527df924eda584c20d053ba4`.
The machine had 4 vCPU and a load of 0.67 at the start, and Laya ran on the CPU with 1 thread, `defaultThreads` there.
8 steps passed, 0 failed, and 1 was not run.

| Step | Result |
| --- | --- |
| 1 | Not run: the disk had 1.7 GB free and the venv's packages already take 5.4 GB, so a second torch install does not fit; the harness links the existing venv, installed from the pinned lock. |
| 2 | The snapshot `a6d3a279` is complete and `weights.json` is present. |
| 3 | Ready through `sidecar.ensureReady` in 9.5 s, with the short warm-up; the full warm-up of the first start on this device and identity took 131.6 s in an earlier run. Device `cpu`, 1 thread, 2.41 GB RAM, `127.0.0.1:8091`, Laya's temperature warning parsed. A wrong key got 401, and the machine's non-loopback address on the same port was refused (`ECONNREFUSED`). |
| 4 | Through `createLayaClient`: the intent (3 questions) in 1.63 s, resource and judgments (2 questions) in 3.19 s, the task group (20 questions, 2 requests) in 48.71 s, the review (9 questions, 4 requests) in 18.40 s. Every question was answered and every answer was flat; no request reached the context limit; the model was relabelled `laya-english/0.3.20@a6d3a27`. An intent through `createJev` with Laya's record took 1.76 s: kind `task`, `uninformative` `[kind, depth, alsoWork]`. |
| 5 | (a) This PC's own figures and a 3 s deadline: refused in 2 ms with `LAYA_PREDICTED_OVER`, `Laya would need about 46 s for this call on the CPU, over its 3 s deadline`, and 0 requests sent. (b) The prediction set low, so the 3 s floor is the deadline: rejected at 3001 ms with `timed out after 3 s`, the request still on the wire, and `laya.serve` answering 45.1 s after the call; only 1 of the call's 2 requests was ever sent; an intent issued at the rejection waited 42.1 s in the gate, went out only after that answer, and took 1.65 s on the wire, alone. (c) The caller aborting at 2 s: rejected at 2000 ms with the caller's own reason, and `laya.serve` answering 42.8 s after the call; an intent queued behind it and aborted 1 s later rejected within 1 ms and was never sent; the next intent took 1.39 s, all of it on the wire. There was never more than 1 request on the wire. |
| 6 | 2136 ms with the shadow off and 2101 ms with it on, made of 4 Jev calls (1203 ms), the agent (500 ms) and 398 ms of the rest. The shadow's first Laya request went 2 ms after the message, and 2 of its 12 requests went during the run. Every row was answered; measured from the end of the run: the intent, 3 rows in 1.58 s, landed 0.5 s before it, with `runId` null; the task group, 20 rows in 6 chunks in 27.1 s, 26.5 s after; resource and judgments, 2 rows in 4.6 s, 31.1 s after; the review, 9 rows in 4 requests in 11.4 s, 42.5 s after. No usage row was written for Laya. |
| 7 | The run took 188.2 s under the heading `**Laya router** · AUTO (routing rules and the safe fallback decided)`, with the lines `Laya route: 20/20 questions in 31041 ms on the CPU`, `Laya route: 18 answers too flat to use (...); the routing rules filled them`, `Laya route: 2/2 questions in 3535 ms on the CPU`, `Laya route: 2 answers too flat to use (strategy, secondOpinion)...`, `Laya review: 8/9 questions in 14604 ms on the CPU` and `Laya review: 8/9 questions in 11125 ms on the CPU`. The report named the 17 fields the rules filled; the decider was `laya`, the model `laya-english/0.3.20@a6d3a27`, both reviews Laya's, with no decider errors. The final status was `needs_human`: the flat review gave `second_review`, then `human`. TypeSafe contact: 0 requests, 0 Jev calls, 0 SDK clients built without a `baseURL`; the only host that was not loopback was the connectivity probe. Laya was held for 184.2 s over 93 polls, one interpreter pid, ready throughout, and stopped for idle 65.1 s after the run returned. |
| 8 | Measured per token: intent 6.91 ms, route 9.37 ms, review 7.31 ms; a RAM peak of 2.41 GB and a working set of 2.42 GB (bound 3.5 GB). The interpreter killed mid-route: the call failed with `Laya stopped while answering (the process ended); it is restarting`, the states went `restarting`, `starting`, `ready`, and Laya was back and answering in 11.0 s. The watchdog at a 1 GB budget with a 1 s grace: a held Laya alone stayed (the same pid, `RAM watchdog: over the 1 GB RAM budget, and every resident is held`); held beside a held llama stand-in, llama was unloaded and Laya stayed; unheld beside it, Laya was unloaded first (`stoppedBecause` `budget`, why `the local models together stayed over the 1 GB RAM budget for 1 s (last reading 2.4 GB: Laya 2.3 GB, llama-server (stand-in) 0.1 GB)`) and llama was not touched, and `ensureReady` restarted it in 9.0 s. Idle at 1 minute: Laya stopped for idle 62.0 s after the last acting request, while 21 shadow intents were offered, one every 3 s, and all 21 answered, none cut by the stop; a shadow offer after the stop was dropped as `not_running` and Laya stayed stopped; `ensureReady` restarted it in 11.0 s, and it answered. |
| 9 | 32 calls, 55 requests and 194 question rows, encoded with the planted proxy tokenizer (`max_len` 512, `head_max_len` 192): 0 options cut, 0 views cut, 0 instructions cut, 0 refused. The longest row was 497 tokens, the least state room 329 tokens, the largest view 354 tokens, and the tightest row had 15 tokens to spare; it took 9.7 s. A separate sanity request showed the checker does flag a 122-token option (kept 48), 30 crowded options (kept 4 tokens each) and a 1214-token state. |

Two earlier full runs also passed every step, the later one with figures within about 10 percent of these (a route prediction of 43 s against 46 s, for one); the earlier one printed `(waited 1 ms for an earlier Laya answer)` in step 7 on a call that had waited for nothing, which the client no longer says (4.5).
A first attempt was stopped by hand after step 3, because four busy-loop processes that were not the test's held all four cores, and none of its figures is used.
The run predates the fixes of the final review, some of which change what it printed: the task-group line no longer names `secondOpinion` among the answers the rules filled (4.3), so it would say 17, as the report did; a call the kill cut off names the exit (`signal SIGKILL` there), and a timeout names its size (3.3).
After them the whole test ran again on the fixed code, on 25 Sep from 16:12 to 16:24 UTC, and passed the same 8 steps with step 1 again not run; its figures are within about 10 percent of the table, and the changed lines now read as the fixes say (17 filled fields named, `signal SIGKILL` on the kill).

### 9.5 The owner's desktop checklist: Jev and Laya together

Before: pull `feat/laya-auto`, run `Install-Harness.ps1` (expect `ok: uv 0.12.18`), start KzH.
Write down the result of every step; together they are the data section 10 waits for.

1. **Install.**
   Settings → Jev setup → Laya decision model → `Install Laya…`, GPU.
   Working means every step completes and the card reads `Installed, not running. Laya 0.3.20, English checkpoint <commit 7>, PyTorch 2.14.0+cu<x> (for the GPU, CUDA <x>).`
   Record the time per step, the sizes and the peak free-disk use, every CUDA tag tried and the one taken, and the model's commit and size (they go into `config/laya.json` afterwards).
   Once, press `Cancel` during step 6 and then `Try again`, and record whether the model download resumed or started over.
2. **Start.**
   Turn on `Start Laya when KzH starts` and `Keep Laya loaded`, Device Auto, press Start.
   Working means `Running on the GPU (NVIDIA GeForce RTX 3050 Laptop GPU)` within about two minutes; if it says the CPU, record the reason, stop the local chat model, and press `Restart on the GPU`.
3. **Loopback only.**
   `netstat -ano | findstr :8091` shows only `127.0.0.1:8091`.
4. **Test Laya.**
   Working means `protocol ok`.
   Record intent, routing and review milliseconds on the GPU (the goal is a routing decision under 3 s), and which yes/no pairs separate: this is the first real evidence on #156 with the labels workaround.
5. **Render check.**
   `node scripts\laya-render-check.mjs` runs `check_render.py` in Laya's venv with the real tokenizer; working means `0 options cut, 0 views cut`.
6. **The budget beside a local model.**
   With Laya on the GPU and `Keep Laya loaded` on, load the local chat model and record its `N/M layers on GPU` log line and its speed; stop Laya, restart the chat model, and record both again; record Laya's RAM, and both its dedicated and its shared GPU memory in Task Manager (shared memory growing means the driver is spilling, 7.7); decide whether Device should stay Auto.
   Then turn `Keep Laya loaded` off, start Laya, and load the chat model: the card should say Laya was unloaded for it, and the chat model's layer line should match the run without Laya.
   If Laya's calls get much slower beside the chat model while dedicated memory is full, set `Prefer No Sysmem Fallback` for `C:\Harness\engine\laya\python\...\python.exe` in the NVIDIA Control Panel (Manage 3D settings, Program Settings, CUDA Sysmem Fallback Policy) and record the difference.
7. **Jev Auto with the shadow.**
   Pick Jev Auto and send eight to ten real tasks: a plain question, a typo fix, a bug fix, a docs edit, a refactor, a test, something risky (auth), one that should need a person, one that also asks for work, one continuing an earlier task.
   Working means each run feels as fast as before (the `Jev route: ... in ... ms` lines are unchanged), Jev → Decisions shows a Laya column or a stated skip under every Jev call, the server log shows `[jev] Laya shadow ...` lines, and Router → Jev and Laya, side by side counts grow.
8. **Laya Auto.**
   Pick Laya Auto and send the same kinds of tasks in a scratch project.
   Working means the heading says `**Laya router**`, the lines say `Laya route: ... on the GPU` (write down the milliseconds: the first real GPU figures), no line mentions Jev, Usage shows Laya rows at $0.00 and neither Jev's spend nor "Saved by Jev" moves, and every result is sensible or the report shows which domain and which answer went wrong and what the rules filled.
9. **Offline.**
   Turn Wi-Fi off and send a Laya Auto task: it routes to a local model and the heading says `OFFLINE: local models only`; Jev Auto on the same task says Jev is unavailable, as before.
10. **Failure drills.**
    Press Stop on the card and send a Laya Auto task: `Starting Laya on this PC...`, then a normal run.
    End the Laya `python.exe` in Task Manager during a Laya Auto routing call: the run reports `Laya did not answer` with the reason, uses the rules and never calls Jev; the card shows the restart; the next task uses Laya again.
    Set Device to CPU and send a task: slow, with honest lines, and within its deadlines.
11. **Contention.**
    With Laya on the CPU, run a local-agent task in Jev Auto: the local agent's speed is unchanged, and the comparisons wait or are skipped and counted.
12. **Feedback and integrity.**
    Use `good pick` and `misread my question` on a few runs of each mode, then run `node scripts\laya-integrity-check.mjs`: no Laya-decided run id in `routing-samples.jsonl`, no capability evidence but reliability from Laya runs, no Jev call in a Laya run and every Laya row at $0.00, "Saved by Jev" and Jev's spend unchanged by Laya rows, and no shadow row of a Laya run.
    Working means `All 5 checks passed.` and exit code 0; it exits 1 naming every violation, and says so when no run on the PC was decided by Laya, since then it has proved nothing.
13. **Bring back** one file: run `node scripts\laya-export.mjs`, which writes `laya-export-<date>.json` and prints what it holds: the shadow rows, both sample stores, the standings, `laya.json`, `installed.json`, `weights.json`, the last 500 lines of `laya-serve.log`, and the `history.jsonl` rows reduced field by field to `runId`, the time, the routing labels and numbers, each attempt's agent, role and stop reason, the final status and each review's mode and action, every string passed through `export.js` `redactSecrets`.
    Never bring back `history.jsonl` or `usage.jsonl` themselves: they hold the task text as typed, workspace and file paths and the start of every answer, and nothing redacts a key pasted into a task.
    Add the card's text by hand.

---

## 10. Deliberately not built now, and the data that decides each

| Not built | Why not now | Decided by |
| --- | --- | --- |
| A mixed arbiter row, provider rungs, rollback records | No row needs them (decisions 1 and 2), and no outcome KzH records is a fair test of Laya (6.7) | First an unconditioned evaluation: the owner labels a random sample of runs of both modes, whatever their outcome, so a domain's Laya accuracy does not depend on who acted; then a domain whose Laya accuracy on those rows meets its gates and holds for two evaluation windows, and for `task_classification` an outcome-based check for every field it hands over; then the seam of 6.8 |
| Temperature refit for Laya | Needs verified outcomes per question type that are not selected by failures | At least 200 person-labelled or unconditioned rows per question bucket with Laya's calibration error on them over 0.1; fitted on log-probabilities with the classifier's calibration split, stored as `temperatureCorrections`, which starts a new identity |
| Laya thresholds from data | Same | Each of the keys of 2.6 from its own curve in the shadow and outcome data, the review action first |
| Fine-tuning Laya on KzH decisions | Needs task text joined by `runId` from history and a labelled set of about 30k questions; samples hold no text by design | Laya's person-labelled accuracy clearly below Jev's on a domain over at least 300 rows, agreement no longer rising, and a separate opt-in capture of text |
| Local classifiers learning from Laya Auto outcomes | They bias the ladders' windows (6.5) | Laya Auto in daily use with enough outcome-backed rows to matter, read for training only |
| Capability evidence from Laya runs beyond reliability | It would move Jev Auto's beliefs about agents on a weak signal | Laya's `review_action` reading on evidence independent of the acting review (5.5); the rows can be backfilled from history |
| The multilingual or typed-decisions checkpoint | 4.4 | Non-Latin tasks over 10% of runs in the rows' `lang` field |
| Counterbalanced nouls (each asked twice, labels swapped) or a two-option neutral choice | One more cost with no evidence yet | Test Laya pairs failing on real weights, or noul agreement far below choice agreement |
| laya-ts or ONNX in a worker thread | Needs an off-PC export, and the Python sidecar is the reference path | The sidecar proving fragile on Windows |
| fp16 weights on the GPU (half the VRAM) | Changes Laya's official loading path | Step 6 of the checklist showing local models suffer too much beside Laya |
| Pruning or merging questions for speed | It would change decisions and break the comparison | GPU milliseconds, and which Laya answers ever change a run |
| Starting Laya from the shadow | A silent 2 to 3 GB start | The owner, after the test |
| The `local.js` `loadAtStart` fix and a manifest kind for Python modules | Not needed by Laya | Independent |
| A request id for Laya answers | `laya.serve` sends none; `callId` pairs answers | Upstream |
| `scripts/jev-triage.mjs` providerised | A Jev-only tool outside every mode | Independent |

---

## 11. Build plan

### 11.1 Shared contracts

Every group codes against these, as written in this document; a group that needs another's module codes against its contract with a stub and integrates when that group lands.

| Contract | Section |
| --- | --- |
| The provider record, `TEACHER`, `DECIDER_IDS`, the `Thresholds` keys and both columns of defaults | 2.1, 2.6 |
| The `laya` Config block and the new `thresholds` keys | 2.2 |
| `createJev` new form, the `onCall` hook with its `context` and its settle function, `onError` and the `'decider-error'` event, the trace shape; the `uninformative` list on `route()`, `intent()` and `assess()` and which caller reads which name; `assess(input, signal, context)` | 2.3, 2.4, 2.5, 4.3 |
| One run id: `logRun(sessionId, task, runId)` and `entry.id === runId`; `deps.runId`; `layaUnavailable`; `isOffline(decider)`; `sidecar.hold` and `release` around a Laya-decided run | 2.4 |
| `routing.decider`, `routing.model`, `routing.deciderErrors`; the task field `decider`; the row field `decider` | 3.1, 3.2 |
| The exact UI strings | 3.1, 3.3, 3.5, 5.6, 8 |
| `renderForLaya`, `mergeLaya`, `normalizeLayaAnswers`, the views, the `informative`, `corrected` and `servedConfidence` answer fields | 4.2, 4.3 |
| `createLayaClient`, its gate rules (the caller's signal never reaches the socket, per-phase `msPerToken`), its error codes and its `Answer` shape; the identity string | 4.5, 3.5 |
| `createProbe(connection)` and the warm-up bodies | 4.6, 7.5 |
| `createShadow`, the shadow row, the judge, the standing row | 5.3, 5.5, 6.7 |
| The store kinds, `STORE_AUTHORITIES`, the Laya sample, `decide({ answeredBy, sink })`, `decisionSamples` entries, `reviewAction()` | 6.2, 6.3, 2.5 |
| `createLayaSidecar` with `readBudget`, `probe`, `hold`, `reservePort` and `sweepOrphans`; the state table; `laya.json`, `installed.json`, `weights.json`, `swap.json`, `install.lock`, `config/laya.json` | 7 |
| `createResidency` with `held` and `yieldFor`, `createBudgetWatchdog` and its victim order, `local.isBusy()`, `killTree` | 7.4, 7.7, 5.2 |
| The HTTP routes, the status JSON and the comparison JSON | 8.4 |
| The fake Laya and `kzh-bodies.json` | 9.2 |

### 11.2 Groups

Nine groups, each in its own git worktree off `feat/laya-auto`, each owning distinct files; all paths under `plugins/jev-router/` unless they start with `config/`, `scripts/`, `plugins/jev-review/`, `docs/` or `README.md`.

| Group | Owns | Builds | Tests | Depends on |
| --- | --- | --- | --- | --- |
| G1 provider-core | `providers.js` (new), `jev.js`, `usage.js`, `effort.js`, `scripts/red-check.mjs` (new), `test/providers.test.js` (new), `test/jev.test.js`, `test/usage.test.js`, `test/pricing.test.js`, `test/savings.test.js`, `test/effort.test.js` | 2.1 to 2.3 (the record, `LAYA_SCHEMA`, `onCall` with `context`, `onError`, `uninformative`, the frozen constants), `usage.logDecision` and the `decider` filter of `computeSavings`, effort bands, `red-check.mjs` | 9.3 G1 items; the existing suite unmodified | none |
| G2 laya-wire | `laya-questions.js`, `laya-selfcheck.js` (new), `test/fixtures/fake-laya-serve.mjs`, `test/fixtures/kzh-bodies.json` (new), `test/laya-questions.test.js`, `test/laya-selfcheck.test.js`, `test/fixtures.test.js` (new) | 4.2, 4.3, 4.6 with `createProbe` and the warm-up bodies, 9.2 | 9.3 G2 items | none |
| G3 sidecar | `laya-sidecar.js`, `laya-install.js`, `residency.js`, `laya/fetch_weights.py`, `laya/install-cli.mjs` (new), `local.js`, `config/laya.json`, `config/laya/requirements.in`, `config/laya/requirements.lock`, `scripts/laya-lock.mjs` (new), `scripts/Install-Harness.ps1`, `scripts/Update-Harness.ps1`, `test/laya-sidecar.test.js`, `test/laya-install.test.js`, `test/residency.test.js` (new), `test/local.test.js` | 7 whole (the state table, holds, `reservePort`, the orphan sweep, the swap journal and `recover()`, `install.lock`, the residency's victim order and `yieldFor`), `local.isBusy()`, `killTree` | 9.3 G3 items | G2 (the fake for tests, and `createProbe` for the warm-up and install step 7, so G3 never needs `laya-client.js`) |
| G4 client-shadow | `laya-client.js`, `shadow.js`, `shadow-stats.js` (new), `test/laya-client.test.js`, `test/shadow.test.js`, `test/shadow-stats.test.js` (new) | 4.5, 5 whole, 6.7 `standing`, the comparison of 8.4 | 9.3 G4 items | G1, G2, G5 (`reviewAction()`, `STORE_AUTHORITIES` and the Laya sample shape, which `shadow-stats.js` imports); G3's sidecar is a stub object in its tests |
| G5 learning | `training.js`, `domains.js`, `decision.js`, `broker.js`, `profiles.js`, `plugins/jev-review/index.js`, `test/training.test.js`, `test/domains.test.js`, `test/decision.test.js`, `test/policy.test.js`, `test/profiles.test.js`, `test/guards.test.js`, `test/adaptive.test.js`, `test/integrity.test.js` (new) | 2.5 for these files, 6.1 to 6.6, `reviewAction()` | 9.3 G5 items | G1 |
| G6 modes | `adapter.js`, `router.js`, `tasks.js`, `test/layaauto.test.js` (new), `test/router.test.js`, `test/adapter.test.js`, `test/tasks.test.js`, `test/onlinemode.test.js` | 3 whole for these files, `isOffline(decider)`, the `'decider-error'` line, `verdictWeight` (6.6), the `stream()` side of the refusals; `classify`, `layaUnavailable` and the route-level refusals are G8's, in `index.js` | 9.3 G6 items | G1, G5 |
| G7 ui | `client.js`, `test/laya-card.test.js` (new), `test/routerview.test.js`, `test/observability.test.js`, `test/budgetpanel.test.js` | 3.3 inspector, 5.6, 8.1 to 8.3, the budget table line | 9.3 G7 items | codes against 8.4 at once; merges after G6 |
| G8 integration | `index.js`, `test/laya-integration.test.js` (new), `README.md`, `docs/adaptive-routing.md`, `docs/handoff.md` | 2.2 (`laya: Schema.any()` and the new `thresholds` keys in `Config`), 2.4 (`makeDecider`, one run id, `layaUnavailable`, `classify`, `isOffline(decider)`, holds, skipping `maybeRetrain` after a Laya run, `learnFrom` per store, the orphan sweep first in `apply()`, `readBudget`), 3.4, 3.5, 6.3's facade, `onVerdict` per store (6.4), the stores, sidecar, client, shadow and residency wiring, the routes of 8.4, `/laya`, start with KzH; the README's Laya section and the docs' authority and store notes | 9.3 G8 items | G1 to G7 |
| G9 e2e | `test/e2e/laya.e2e.mjs`, `test/e2e/make_ckpt.py`, `test/e2e/plant_hf_cache.py`, `test/e2e/check_render.py` (new), `package.json` (the `test:e2e` script), `scripts/laya-render-check.mjs`, `scripts/laya-integrity-check.mjs`, `scripts/laya-export.mjs` (new) | 9.4, and the three desktop helpers of 9.5 | 9.4 in the cloud; the render and integrity helpers exit non-zero on any cut or violation; a marker-string test shows that a key or a task text planted in `history.jsonl` never reaches the export | G8 |

Merge order: G1 and G2 (either order), then G3 and G5 (either order), then G4, then G6, then G7, then G8, then G9.
Each group rebases on the latest merged work before its own merge, runs `red-check.mjs` on its new and extended tests, and runs the whole suite.
After G9, the owner runs 9.5.

---

## 12. Where the three designs disagreed, and what was chosen

This design starts from the correctness-first design and grafts the judges' recommended ideas from the minimal-seam and operations designs; every choice below is one line, and `review` marks a choice changed by the review of this document against the code.

| Choice | Taken from | Why |
| --- | --- | --- |
| Confidence is max probability after correction, not Laya's served entropy | correctness-first | Laya's own docstring says only max probability is calibrated and the two must not share a threshold. |
| Re-temper `choice:11+` and mark flat answers `informative: false` | correctness-first | A flat score sits exactly on the 0.5 cuts; filling it visibly beats acting on noise. |
| Per-question state views, measured by the operations design's split | correctness-first, operations | Only views get the checks and the diff inside the English checkpoint's 316 state tokens. |
| Labels plus per-noul criteria for #156 | correctness-first, operations | It is the form Laya's README documents; labels alone keep the generic text. |
| Option texts of at most 8 words | operations | Measured a quarter faster, and nothing is cut mid-sentence. |
| Speculative tool-parameter questions kept | correctness-first, minimal-seam | The comparison needs the same questions on both sides. |
| Normalisation and rendering live in the Laya client, and `createJev` takes a record and a client | minimal-seam | `jev.js` stays provider-agnostic, with no three-layer split. |
| The record carries no key or endpoint | minimal-seam | Both change at runtime and would go stale on a record the inspector shows. |
| `TYPESAFE_BASE_URL` still redirects Jev; the Jev card shows the host | judges | Jev decides as today; an explicit `jevBaseUrl` would change it. |
| Two keys, `verificationChecks` and `needsTests` | minimal-seam | Merging them would change Jev's behaviour when `thresholds.needsTests` is not 0.5. |
| `'always'` means always require checks | operations | `undefined >= 0` is false, so a 0 bar skips checks whenever Laya gives no answer; a string, because Schemastery turns `null` into the default. |
| Cut-offs reach `decision.js` and `broker.js` through a per-run policy object | minimal-seam | The profile is stored in history and should not carry cuts. |
| `decision.js` takes the record from the router, never from the client | judges | A missing client must never make a Laya run use Jev's record. |
| One run id per run | correctness-first | Without it no shadow row, usage row and sample can be joined. |
| `routing.decider`, not `routing.provider` | correctness-first | `provider` already names an agent's executor kind and the DSH route. |
| One picker row, no Laya Auto · Local | minimal-seam, judges | The owner decided one row; offline narrowing covers the local case. |
| A local effort in Laya Auto is a manual run that Laya reviews | judges | That is what the code does (`adapter.js:376`, `router.js:711`); the minimal-seam claim otherwise was wrong. |
| Group heading `Kz-harness` | minimal-seam | The group holds Laya Auto and the plain agent rows as well as Jev's. |
| Refuse a Laya Auto run that Laya cannot start | correctness-first, operations | The person asked for Laya to decide. |
| A message while Laya loads waits for it and is then asked; unsure after a refusal or timeout means task, except in the No project space | this design | The run would wait for the same start anyway; a word rule sends work to a chat model. |
| Laya Auto probes `laya.connectivityUrl`, never TypeSafe, in routing, question answering and titles alike | correctness-first | A TypeSafe outage must not narrow a local decider's pool, and a Laya Auto session must not contact TypeSafe. |
| `/laya <task>` command | operations | One task to Laya from a Jev Auto session, for testing both together. |
| Separate `laya-samples.jsonl` and a refusing Jev store | correctness-first | Shared-store rates would roll back Jev-taught ladders on Laya's failures. |
| One decide path with `answeredBy` and `sink`, not `provider-decide.js` | minimal-seam | Two decide paths drift. |
| No `provider_confirmed` source; `confirms` passes only the teacher's picks | minimal-seam | Confirmations are undetermined in the judge anyway. |
| Laya Auto runs do not feed the local classifiers yet | correctness-first | Their outcome rows are selected by Laya's failures. |
| Capability evidence from Laya runs is reliability only, with no task type; the review-attempt loop is left as it is | correctness-first | Every other row rests on Laya's type, accept or assessment, and a mode check in the loop would drop Jev Auto's own local-mode evidence. |
| The standing keeps its sources apart and has no rung or gate; agreement beside it, never a gate | correctness-first, review | Every recorded outcome is selected by the acting router's failures, so a pooled accuracy measures the mode mix; gating on agreement would stop Laya from ever beating Jev. |
| Where Jev's pick was contradicted, and field agreement for `task_classification`, both shown and neither a floor | minimal-seam, operations | The first is the sharpest shadow evidence; the second covers the fields the domain hands over, and is agreement with Jev, so it cannot gate. |
| Shadow rows in their own file, not in `routing-samples.jsonl` | correctness-first | A third row kind would couple Jev's training data to Laya. |
| Shadow calls not in `usage.jsonl` | minimal-seam | Spend records only what acted. |
| The official `python -m laya.serve`, no KzH launcher | minimal-seam, correctness-first | Owner decision 3, and a launcher would depend on upstream internals. |
| Device from all three of Laya's log lines | operations | The GPU-to-CPU fallback during inference would otherwise be silent. |
| The real interpreter pid from a process-tree lookup | minimal-seam | The Windows venv redirector hides it, and no launcher is needed. |
| The gate holds the socket until the abandoned request answers, not a drain probe, and never forwards the run's signal to it | correctness-first | The response itself is the exact signal, and an aborted socket would lose it while the server keeps computing. |
| Measured deadlines, per device, per phase and per token, not fixed ones | correctness-first, review | They follow the GPU or the CPU without a setting, and one figure per device seeded by the intent was too tight for the first route. |
| Shadow chunks of four questions | correctness-first | An acting call waits behind at most one chunk. |
| The shadow never starts Laya and never keeps it loaded, and an unheld Laya gives its memory to a local model; start with KzH and keep loaded default off | minimal-seam, judges, review | A resident GPU model would take layers from local agents in every Jev Auto run; the card and the checklist turn them on for the test, and say what that costs. |
| A shadow chunk waits while a local model request is in flight, on any device | judges | The same guarantee as skipping, with more coverage. |
| Below-normal priority only outside acting requests | correctness-first | A permanent low priority would slow Laya Auto's own calls. |
| uv installed by `Install-Harness.ps1` and `Update-Harness.ps1` every time | minimal-seam | Owner decision 3. |
| uv 0.12.18 with its SHA-256, torch 2.14.0, the torch index from the driver's CUDA version | operations | Verified pins and a stated rule instead of a guess. |
| One universal hash-locked lock without torch | minimal-seam | The cloud end-to-end test installs the same file the laptop does. |
| `uv pip install`, never `uv pip sync`, after torch | judges | Sync would uninstall torch, which the lock leaves out. |
| Build and check `venv.new`, then a journalled swap recovered at start | operations, review | A failed install or update keeps the old one running, and an engine killed between two renames never leaves no venv. |
| Weights through Laya's own `Router.preload`, offline first, then hashed into `weights.json` | operations, minimal-seam, correctness-first | Laya downloads exactly what it loads, a copied cache needs no network, and the files are verified. |
| No VRAM hold-back in `local.js` | operations, judges | `--fit` already fits around the VRAM Laya holds. |
| A summed RAM residency with one watchdog | operations | The RAM budget means every local model process. |
| VRAM estimate 2.5 GB | operations | Laya keeps fp32 weights on the GPU. |
| Port 8091 | minimal-seam, correctness-first | llama-server's `freePort` tries 8081 to 8090. |
| Test Laya: protocol, timings and paired probes | correctness-first, operations | The first real evidence on #156, visible before trusting Laya Auto. |
| `scripts/red-check.mjs` | operations | It makes "every test fails against the old code" mechanical. |
| The event type stays `'jev'`, with `trace.provider` | this design | It lives only in memory, and renaming it touches the inspector for no behaviour. |

---

## Appendix: evidence

- The research pass: `laya_understand.json` in the session scratchpad (maps `laya-core`, `laya-servers`, `kzh-jev-client`, `kzh-modes-ui`, `kzh-local-models`, `kzh-learning`, and the critic, who ran things).
- The three design passes' scratch, with their probes against the real `laya.serve` 0.3.20 on a random-weight English checkpoint: `/tmp/claude-0/laya-design/{correctness-first,minimal-seam,operations-ux}/`.
- CPU figures (4 vCPU Xeon): the critic's `bench_py.py` (route 20.0 to 21.2 s, review 11.7 to 13.0 s, intent 1.1 to 1.2 s, resource 1.2 to 1.3 s, peak RSS 3.26 GB); the operations pass (route 21.6 to 22.3 s as sent, 16.0 to 17.6 s with short options; review 12.2 to 12.9 s as sent, 8.7 s split three ways; load 7.0 s from a warm cache; RSS 2.5 GB steady, 3.2 GB peak); the minimal-seam pass (ready after 92.6 s on a cold disk; a one-question probe waited 19.3 s behind an abandoned 20-question call; `/health` answered in 3 to 14 ms during inference).
- Wire behaviour (correctness-first and minimal-seam probes with KzH's SDK 0.6.0): `labels` accepted on a noul, 422 on a choice; `model: 'english'` answered with `routing.reason` `explicit model='english'`; an unpinned French state routed to multilingual and failed with 500; a wrong key gave 401; the answer's model is always `laya-rl-agent` with no request id; the 9-question review reported `input_tokens` 4608, every row at the limit.
- Checked in this pass: the uv 0.12.18 Windows zip's SHA-256 against the release's own `.sha256` file; `uv pip compile` of `laya[serve]==0.3.20` and `torch==2.14.0` with `--universal --python-version 3.12 --generate-hashes --no-emit-package torch` resolves from PyPI (62 pinned packages, the CUDA libraries Linux-only by marker); download.pytorch.org and huggingface.co are blocked from this machine.
- Code checked in this pass, in `/home/user/kz-harness` at `8e5d376`: every line reference above, and in particular the two run ids (`index.js:1054`, `router.js:494`), the unmoded review-attempt loop (`profiles.js:772-777`), `assess()` dropping the model (`jev.js:836-852`), the `--fit` rule (`local.js` `fitTargetMiB`), the local effort override (`adapter.js:370-379`), and the store rates that roll ladders back (`domains.js:922, 1128-1136`).
- The cloud end-to-end run of 25 Sep 2026, on commit `7519f8f`, against the real `laya.serve` 0.3.20 on the planted random-weight checkpoint: its figures are in 9.4, and its report is `/tmp/claude-0/laya-e2e/data/e2e-report.json` in that session.
- Laya source checked in the clone at 0.3.20: `laya/serve.py` (environment, `_resolve_model`, the one-worker lock, the bare 500, `/health` echoing `LAYA_DEVICE`, preload before bind), `laya/agent.py` (lines 252, 259-270, 302, 395-417, 431, 625-638, 660-705), `laya/common.py` (`render_options`, `build_sequence`, `answer_confidence`, `confidence_from_probs`, `temp_bucket`), `laya/router.py` (`Router.preload`, `predict`), and README lines 931-952 (#156).
