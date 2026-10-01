# KzH handoff

Kind: **living handoff**. This is the one to read first, and the one to update. It replaces
`handoff-2026-09-21.md` and `handoff-2026-09-21-pass2.md`, both of which were folded in here on
22 Sep 2026 and deleted; every item they held that was still open is below, and every item they
held that was closed was checked against the code before being dropped.

Written for whoever picks this up next, including another agent. Everything here was verified
unless it says otherwise. Where something is unverified it says so.

## State

```
branch        main                         977e39e, pushed; the roadmap and the doc cleanup
              fix/roadmap-open-items       the roadmap's open items, not merged
              feat/laya-auto               Laya Auto, stacked on the above, not merged
              feat/benchmark               the capability and speed benchmark, stacked again, not merged
              fix/windows-findings         5 commits on feat/benchmark: the first Windows run's findings
remote        origin github.com/kz-95/kz-harness, PUBLIC
tests         1354 tests, 1354 pass, 0 fail on Windows (npm --prefix plugins/jev-router test)
              1309/1330 before this branch: the stack had never been run on Windows at all
app           NOT rebuilt since any of this; the running app is on older plugin code
```

Git authorship is the GitHub noreply alias on every commit. All five were rewritten on 22 Sep
before the first push, because a commit's author email is part of the object it is hashed from,
so it is cheap to change while nothing is published and impossible afterwards. Do not add a
personal address back: set it per repo with `git config --local user.email`.

Plugin-loaded check, the cheap signal worth keeping: from inside the running page,
`/jev-router/usage` returns 200 and a bogus path returns 404. From a shell it is 401 for
everything, because the API wants the engine's per-process token. If cordis ever marks the plugin
INACTIVE the app still boots and looks normal, so that 404 is the only cheap sign every KzH
feature is silently gone.

## Progress log

One line per finished workflow step, newest first, written by `scripts/doc-queue.mjs log` when the step ends.

- 2026-09-29 17:16 UTC, Queue and cost findings, item 1 and review rounds 2-28: Read passes before writers with lock checks and a per-repository run log, the parallel second opinion, DeepSeek keys by the launch key with Restart harness, usage floors per switched-on agent, the stored Jev key in the launcher and installer, the app kept in the tray with the harness page recovered by Retry, a forward-only splash, quit wording everywhere, kzh-running.js shared by the speed run and the Laya command line, and a Laya orphan sweep that keeps what it cannot settle; 28 adversarial review rounds, each finding fixed with a test that fails on the code before it. Built, not yet watched in the app (1585 tests, 1584 pass, 0 fail, 1 skipped).
- 2026-09-26 13:50 UTC, Queue and cost: effort floor, strategy risk bands, queue view: Auto effort reaches low (bands 0.125/0.375/0.6); review strategies and second opinion gated by riskBands; waiting line says why, place, estimate from past runs; per-row Stop and Remove; foreground runs wait beside background tasks; git reads take no index lock. Built, not yet watched in the app (commit ea2b4e6; 1381 tests, 1380 pass, 0 fail, 1 skipped).
- 2026-09-26 05:47 UTC, Speed-Run.bat and the speed run logs: Speed-Run.bat runs the local speed benchmark with KzH closed and every speed run, from the card or the .bat, is logged in speed-runs.log with a detail log per run; the first run against the real llama-server b10964 (CPU, tiny test models) found and fixed the non-streamed HTTP 500 and a 0.8 percent high generation speed; a code reviewer and a four-lens review workflow with verifiers confirmed issues in every part, each fixed; red-check finds all 28 new tests failing at f88947a (1353 tests, 1352 pass, 0 fail, 1 skipped).
- 2026-09-26 02:56 UTC, Benchmark review and fixes: Second review of benchmark step B2 fixed on feat/benchmark: a stop is a stop however the run returns, a task folder's git repository kept outside the scratch root and every benchmark git call run with no key of KzH's, a task that does not fit a local window records nothing, plan ids start one run within 30 minutes, the card's reads, tables, confirmation, progress and last-run words say what happened, and Cancel during the speed run's restore says why; red-check against da08532 finds 32 of the 43 new tests failing at the base and 11 passing there (commit 5f19588; 1325 tests, 1324 pass, 0 fail, 1 skipped).
- 2026-09-26 00:04 UTC, B2: Benchmark step B2 built and reviewed on feat/benchmark: the capability benchmark, 27 fixed Node.js tasks in nine skills plus a preflight, run one at a time on each picked agent, forced at high effort, in the KzH scratch workspace through the normal run path, graded by code, and recorded as capped benchmark evidence of which only the newest run counts, behind a confirmation that says what it spends; tested with stub agents, a fake Codex command and the fake llama-server only (commit 1363776; 1286 tests, 1285 pass, 0 fail, 1 skipped).
- 2026-09-25 20:36 UTC, B1: Benchmark step B1 built and reviewed on feat/benchmark: local models' speed measured at an 8,192-token depth with llama-server's own timings, kept in local.json beside the memory readings, shown as measured in the install picker and the Local models card, local agents held back off their time limit meanwhile; tested against a fake llama-server only (commit c0ef03c; 1231 tests, 1230 pass, 0 fail, 1 skipped).
- 2026-09-25 17:21 UTC, Compaction at 97 percent: The engine's compaction-basic set to 0.97 of the window in config/cordis.patch.yml, with a 1,024-token summary on local models and a test of the arithmetic.
- 2026-09-25 16:53 UTC, Wording fixes and the doc queue: The CPU-fallback note and the signal restart line corrected; scripts/doc-queue.mjs added with its tests, and red-check taught repository scripts (1196 tests, 1195 pass, 0 fail, 1 skipped).
- 2026-09-25 16:24 UTC, Real laya.serve run on the fixed code: 8 of 9 end-to-end steps passed, step 1 not run for disk; figures within about 10 percent of the first run.
- 2026-09-25 15:55 UTC, Whole-branch review and fixes: 54 findings from five lenses and the finished end-to-end test; 50 fixed with tests, 4 already fixed, none refuted (1188 tests, 1187 pass, 0 fail, 1 skipped).
- 2026-09-25 09:30 UTC, First real laya.serve run: Start, a wrong key, KzH's four real bodies and a kill mid-call against the real server on random weights (commit 79bc6c0).
- 2026-09-25 09:05 UTC, Laya build, groups G1 to G8: Nine groups in five waves, each built in a worktree, reviewed, fixed and merged; G9 stopped by the weekly usage limit (commit 6ebfabe; 1132 tests, 1131 pass, 0 fail, 1 skipped).
- 2026-09-24 18:20 UTC, Laya design: Three designs judged, the winner synthesised into laya-auto.md and 80 review issues fixed (commit 1549455).

## Where this was left, 24 Sep (second pass): read this first

The adaptive router was merged into `main` on 24 Sep (the first pass, below).
The second pass is branch `fix/roadmap-open-items`: pushed, not merged, and `main` is unchanged by it.
It closes roadmap §0 items 1 to 3, builds the resource budget (roadmap §1 build steps 1 to 6), deletes conservation as a domain (roadmap §4), carries out two owner decisions, and matches feedback to the task type.
None of it has run in the app: the router has still never been watched, and the budget page has never been seen, so both belong under "Built but NOT observed".

What the second pass did:

1. **What goes to Jev is scrubbed before it is cut** (roadmap §0 item 1).
   `jev.js` `route()` scrubs the task, the workspace facts and the handoff note, and every other free-text channel of the route and review calls is scrubbed.
   Every router-side cut on the way to Jev now scrubs first: the handoff note before its 3000 cut (`router.js`), an executor's thrown error before its 300 cut (`describeError`), check output before its tail is taken (`workspace.js` `runChecks`), and a harness-written note's answer and earlier-note excerpts before their 2000 cuts (`harnessHandoff`).
   The one exception left is a configured tool's output (`index.js` `runTool`), an owner decision below.
   Each routing call carries only the state its questions read: the task call the task, the workspace facts and the handoff note; the strategy call the task and `task_profile`; a judgments-only call the task alone.
   No adaptive routing call carries the candidate table, the history, the availability or the track record; the candidate table rides only the review call.
2. **Conservation is a hard limit, and the resource ranking is never outranked** (roadmap §4, and an owner decision).
   The `conservation` domain is gone: it has no state, classifier or new samples, old ones on disk are ignored, and so is `codeJudgments.conserve`; the limit lives in `decision.js` beside the weekly gate and the capability floor.
   `resource_selection` has `localDecides: false`, which `resolvePolicy` refuses to switch on, and `decision.js` takes the pick from `rankCandidates()` at every rung.
   `routing-policy.js` `DOMAINS` gained `teacher: 'code'` on resource selection and frontier escalation, and the domain controller holds such a domain to code authority.
3. **Training samples capped** (roadmap §0 item 2).
   `routing-samples.jsonl` is capped per domain at `samplesCap(policy)`, 10000 with the shipped gates, and compacted by an atomic rewrite that keeps running totals of what the cap let go of in a `dropped` row; the domains count new evidence on `samples.seen`.
   A split with no holdout share no longer leaves a one-row holdout slice (`domains.js` `splitRows`).
4. **The resource budget** (roadmap §0 item 3, §1 build steps 1 to 6), below.
   It includes a local model's context sized down to the RAM budget, the **Tasks at once** count of runs holding a slot, and the install picker's `unknown` rating for a GPU whose size is capped at 4 GB by `AdapterRAM`.
5. **Feedback matched by task type.**
   The feedback bias reads verdicts from every session and every workspace, each weighted 1 for the same task type and 0.25 for any other; [`adaptive-routing.md`](adaptive-routing.md) has the rules.
   The POST route's handling is `index.js` `createFeedbackRoute` and the router's history deps are `createHistoryDeps`, and both are tested.
6. **Who decided, in words, and dead code.**
   A `teacher: 'code'` domain says a rule in code decides at its rung, and a domain whose classifier never decides says so at every rung (`client.js` `maturityWords`).
   The reasoning line names every authority that decided a domain and which domains the local router decided (`adapter.js` `decidedBy`), and the report header names the same authorities without the domain lists, so a typical adaptive run reads `Jev and routing rules decided` rather than crediting Jev with the pick.
   The `identities` mapping, `decide()`'s `everyAgent`, the `OPENING_STRATEGIES` fallback, `fallbackYes` and `scarceTop` are gone.

What is next, in order:

1. Everything under "For the desktop agent" below, starting with getting the branch into the app and watching one routed run.
2. Laya: the providerised `jev.js` and Laya Auto are built on `feat/laya-auto`, and the final review of the whole branch is done and its fixes are in (see "Laya: built on `feat/laya-auto`, not yet observed"); what is left is the owner's desktop checklist.

### The first pass, for context

The adaptive router was reviewed before it was merged, and two blockers were found and fixed:

1. **The router trained on its own picks.** Once a domain reached local authority, `pickOf`
   returned the local classifier's own answer and an accepted run filed it as `teacher_confirmed`.
   The classifier confirmed itself, and the label named a teacher nobody asked. `confirms()` in
   `training.js` now drops the agreeing label under local authority; evidence that contradicts the
   pick still trains it. A bare thumbs-up also counted as a full-weight human routing label and fed
   promotion, so only the explicit `good pick` tag counts now. Commit `5d7b9f4`.
2. **Three questions asked Jev to compare numbers.**
   The `resource` choice handed it capability scores, scarcity, expected cost, reliability and latency and asked which candidate wins; `conserve` and `frontierReview` had the same shape.
   That is several judgments in one question over magnitudes a snap-judgment classifier cannot compare (QUICKREF rules 2 and 4).
   `rankCandidates()` in `broker.js` now does it in code under a new `code` authority.
   The frontier review became a rule in code, and conservation, in the second pass, a hard limit rather than a judgment.
   `questions.strategy` stayed: a choice between named shapes is a judgment.
   Commit `a0528db`.

The two consequences that pass left open are closed by the second pass: `resource_selection`, which has no Jev teacher, is decided by the ranking in code at every rung and its local classifier never decides, and the comment above the ranking in `decision.js` says so; and conservation, left with nothing to do, is a plain limit rather than a domain.
The first pass also gave local models a memory answer (`8539b9f`), `estimateMemory()` before a run and `readMemoryUsage()` after it, which became the first piece of the resource budget below.

### The resource budget, built

Agreed scope, now built: **one budget page, all consumers**, being max VRAM, max RAM, max cores and max concurrent tasks.
Roadmap §1 has the design and says where the build differs from it, and the README's local models section has the page as a person sees it.

The API behind the page:

- `GET /jev-router/local` returns `{ ...status(), online, slots }` (`index.js` `localStatus`).
  `slots` is `{ held, waiting, max }` from `tasks.js` `createLanes().slots()`: `held` is the agent runs holding a slot under `maxConcurrentTasks` across every workspace, a foreground `/auto`, `/<agent>` or `jev_route` run counting the same as a background task, and read-only runs too: each holds a lane of its own under the cap (`tasks.js` `readLaneKey`); `waiting` is the runs kept out by the cap alone, the first in line in a workspace where nothing runs (a read-only task waiting for its slot among them), and nothing with no cap; `max` is null with no cap.
  `status().settings` holds `maxVramGB` (GB of 1024^3 bytes, above 0 and at most 1024, or null for no limit), `maxRamGB` (above 0 and at most 4096, or null), `maxCores` (whole number 1-256, or null), `maxConcurrentTasks` (whole number 1-64, or null), and `measured`, keyed `'<modelId>@<ctx>'`, each reading `{ vramGB, ramGB, totalGB, gpuFraction, roomGB, gpuLayers, at }`.
  `settings.chatModel` is the chat model in effect: the stored choice if the budget lets it load, else the quickest installed model that fits, else null.
  `status().budget` is `{ threads, defaultThreads, fitTargetMiB, vramNotApplied }`: the `-t` the next load gets, what an unset core limit means, the MiB kept free per GPU, and why the VRAM budget cannot be held (`GPU layers are pinned to N, which --fit does not move`, `this GPU reports its memory through a 32-bit field that stops at 4 GB`, or `this PC's GPU memory is unknown`), else null.
  `status().engine` adds `threads`, `fitTargetMiB` and `workingSetGB`, the watchdog's latest reading in GB, only while a RAM budget is set.
  Each `status().modules[]` entry has `ctx`, the context the next load gets, sized to the RAM budget; `ctxReducedFrom`, the context it would have had without the budget, or null; `memory` at that context (`{ vramGB, ramGB, totalGB, gpuFraction, source }`, `source` being `estimated` or `measured`, plus `roomGB`, `gpuLayers` and `at` when measured); and `overBudget`, the refusal text or null.
- `POST /jev-router/local/settings` takes a patch with any of the four fields: a field left out keeps its value, and null lifts the limit.
  It answers 200 `{ ok: true }`, or 400 `{ error }` with exactly one of `max VRAM: GB above 0, at most 1024, or null for no limit`, `max RAM: GB above 0, at most 4096, or null for no limit`, `max cores: whole number 1-256, or null for no limit` or `max concurrent tasks: whole number 1-64, or null for no limit`.
  A refused patch saves nothing.

The budget's refusal, which is `start()`'s error, the router's readiness detail and a module's `overBudget` alike, reads `<Name> needs about <ramGB> GB of RAM even at the 12k context floor (<estimated|measured>: <vramGB> GB VRAM + <ramGB> GB RAM), over the resource budget of [<maxVramGB> GB VRAM + ]<maxRamGB> GB RAM. Raise the RAM budget or use a smaller model.`
It reads `at <ctx> context` in place of `even at the 12k context floor` only for a model whose context starts under the floor (set so by the plugin config or the manifest's `maxContext`), since the budget sizes every other context down before it refuses.
After a watchdog unload at the 12k floor it reads `the RAM watchdog unloaded <Name>: its working set stayed over the <maxRamGB> GB RAM budget for <s> s (last reading <GB> GB). Raise the RAM budget to load it again.`
`detectSpecs` marks a GPU sized from `Win32_VideoController.AdapterRAM` at 4293918720 bytes or more with `sizeCapped: true`, and its real size is treated as unknown for the VRAM budget and in the install picker.

How the context is sized (`local.js` `planFor`): the largest of `contextSteps(ctx)`, from the context the model would start with down to 12288 in whole k, whose figure fits the RAM budget, a VRAM budget counting through the GPU room it leaves.
The chosen context is the `-c` that `start()` passes, what `status()` reports and what a measured reading is stored under.
`contextOf(id)` is the running engine's `-c` while it runs that model, else the context `planFor` last chose, else the manifest default, and `agents()` reports `llm.contextSize` as the smaller of the planned and the running context.
`index.js` `onSettings` calls `refreshLocal()`, so the router's local agents pick up the budget-sized window after any settings save.
A loaded model is not restarted when the budget changes; its window follows only after it unloads.
The watchdog records an unload as `{ why, ctx }`, the next load is sized below that context, and only an unload at the 12k floor leaves the model refused, until `maxRamGB`, `maxVramGB` or `gpuLayers` changes.

Honest limits, so nobody promises more than this can do.
VRAM is a real cap where `--fit` can hold it: `--fit-target` keeps free everything the GPU has beyond the budget, but not with GPU layers pinned by hand, or on a GPU whose size is unknown or capped at 4 GB by `AdapterRAM`, and then the page says `VRAM budget not applied`.
Cores is real, via `-t`.
Concurrency is real, via the cap on the lanes in `tasks.js`, and it counts foreground runs and read-only runs as well as background tasks.
**RAM is not a hard cap**: Windows needs a native Job Object for that and none is being added, so the RAM budget sizes the context down until the figure fits, refuses a model whose figure is over it even at the 12k floor, and has a watchdog unload a model whose real working set stays over it for 30 s.
The Electron shell and the browser view are never capped and are not in the figures, because they have to run.

Two things worth knowing before touching the page.
The card's status poll applies only its newest response (`client.js` `useLocal`), so a slow poll can no longer undo a save on screen.
`test/budgetpanel.test.js` runs the whole `LocalModelsCard` with a stand-in React that keeps state, over a real `createLocalModels` behind stubbed routes (`card()`, `statefulReact()`), a pattern other card tests can reuse.

### Laya: built on `feat/laya-auto`, not yet observed

The design the owner decided on 24 Sep is [`laya-auto.md`](laya-auto.md), and branch `feat/laya-auto` builds it group by group (its section 11).
With G8 integrated, the plugin wires all of it (`index.js`): both provider records built once, Laya's sidecar with its install recovery and orphan sweep run first in `apply()`, the Laya client every Laya call goes through, the shadow of Jev Auto, the RAM residency shared with llama, one run id per run across `usage.jsonl`, `history.jsonl`, the samples, the shadow rows, the inspector and Stop, the Laya Auto row and `/laya` with the refusals of 3.5, Laya's own sample store and verdict relabelling, and the Laya routes of 8.4.
Whole runs are tested in `plugins/jev-router/test/laya-integration.test.js` against a fake `laya.serve` supervised by the real sidecar; the store and authority rules are in [`adaptive-routing.md`](adaptive-routing.md), "A second decider: Laya".
Nothing of it has run in the app or against real Laya weights.

G9, the cloud test against the real `laya.serve`, is `plugins/jev-router/test/e2e/laya.e2e.mjs` with `plugin-host.mjs`, `check_render.py` and `scripts/laya-render-check.mjs` (committed as `7519f8f`), run by hand with `KZH_LAYA_E2E=1 KZH_LAYA_HARNESS=<dir> npm --prefix plugins/jev-router run test:e2e`; `npm test` never runs it.
The harness held laya 0.3.20, torch 2.14.0 and transformers 5.17.0 from the pinned lock, and a random-weight checkpoint at the real English architecture planted as a Hugging Face snapshot, because huggingface.co is blocked in the cloud; `test/e2e/make_ckpt.py` builds that checkpoint, `test/e2e/plant_hf_cache.py` plants it, and Laya's own `fetch_weights.py` loaded it offline.
Its final run, on 25 Sep 2026 from 11:16:08 to 11:26:11 UTC, drove the real `laya.serve` through KzH's real supervisor, adapter, client and plugin on 4 vCPU (load 0.67 at the start), with Laya on the CPU on the one thread `defaultThreads` gives that machine.
It passed 8 steps, failed none and did not run 1; `laya-auto.md` 9.4 has every figure, and these are the ones to know:

| Step of 9.4 | Result |
| --- | --- |
| 1, the install through `laya-install.js` | not run: the disk had 1.7 GB free and the venv's packages already take 5.4 GB, so a second torch does not fit |
| 2 and 3, the checkpoint and the start | the planted snapshot complete, `weights.json` present; ready in 9.5 s with the short warm-up (the full warm-up of a first start took 131.6 s in an earlier run), 2.41 GB RAM, the temperature warning parsed; a wrong key got 401, and the machine's non-loopback address was refused |
| 4, KzH's four real bodies | intent 1.63 s, resource and judgments 3.19 s, task group 48.71 s (20 questions, 2 requests), review 18.40 s (9 questions, 4 requests); every question answered, every answer flat, none at the context limit; an intent through `createJev` with Laya's record in 1.76 s |
| 5, the gate against the real lock | this PC's own figures refused a route call with a 3 s deadline in 2 ms (`Laya would need about 46 s for this call on the CPU, over its 3 s deadline`) and sent nothing; with the prediction set low, the call rejected at 3001 ms while `laya.serve` answered it 45.1 s after the call, only 1 of its 2 requests went, and an intent issued at the rejection waited 42.1 s in the gate and then took 1.65 s alone; a caller aborting at 2 s did the same, and an intent aborted while queued was never sent; never more than 1 request on the wire |
| 6, Jev Auto with the shadow | 2136 ms with the shadow off and 2101 ms with it on, with a fake Jev at 300 ms and a stub agent at 500 ms; every shadow row answered, the last landing 42.5 s after the run ended; no usage row for Laya |
| 7, Laya Auto through the plugin | a 188.2 s run whose first agent worked 125 s, headed `**Laya router** · AUTO (routing rules and the safe fallback decided)`; the flat answers filled by the rules and said so, both reviews Laya's, `needs_human` from the flat review; 0 TypeSafe requests, 0 Jev calls, 0 SDK clients built without a `baseURL`; Laya held 184.2 s on one interpreter, and stopped for idle 65.1 s after the run |
| 8, supervision | 6.91, 9.37 and 7.31 ms per token for intent, route and review, a 2.42 GB working set; killed mid-route, the call failed with the reason and Laya answered again in 11.0 s; with a 1 GB RAM budget the watchdog kept a held Laya, took llama before a held Laya, and took an unheld Laya first; the idle stop came 62.0 s after the last acting request while all 21 shadow intents offered were answered, and `ensureReady` restarted it in 11.0 s |
| 9, the render check | 32 calls, 55 requests and 194 rows encoded with Laya's own code and the proxy tokenizer: 0 options, views or instructions cut, 0 refused; the tightest row had 15 tokens to spare |

Two earlier full runs passed every step too, the later one within about 10 percent of these figures; the earlier one printed `(waited 1 ms for an earlier Laya answer)` on a call that had waited for nothing, which the review then fixed.
The CPU figures are slow because the thread default (`limitsFor`) gives a 4-vCPU machine one thread; a PC with more cores gets more, and the GPU is expected to be far faster, unmeasured.

The final review of the whole branch, across all nine groups, came next, and every finding was checked against the code before anything changed: of 54 findings, 46 distinct problems were fixed, 4 repeated another finding, and 4 were already fixed when checked.
Every fix but the one that corrected 9.4's text has a test that fails on the code before it, and where the code was right and the design was not, `laya-auto.md` was changed to match; it now describes what exists.
What was fixed, by kind:

- **Learning and the standing.**
  Laya's samples lost the identity and script the client reported, so no Laya Auto run ever counted in Laya's standing or on the side-by-side card; `route()`, `intent()` and `assess()` now hand the client's `meta` on.
  A Laya Auto run was counted as failed on its own review's action and in domains no outcome can judge; now only independent evidence counts, and `task_classification` and `skill_selection` say `not measured`.
  A task type too flat to use threw away the tool Laya had picked, and the model menu's cost of routing a task left out the resource and judgments call.
- **What the person reads.**
  The model menu called a measured Laya unmeasured while it restarted or updated; a timeout's line left out the call's size; a lone call said it had waited 1 ms; the task-group call claimed the rules filled `secondOpinion`.
  The card read fields the server never sent, disabled Stop while a Start waited, told the person to fix cordis.patch.yml when the harness's own pins could not be read, hid Start after a failed update, and offered no Remove after an idle stop; the Router tab showed a comparison card on a PC without Laya.
  The inspector printed shadow events as a bare `shadow`, showed tool-parameter answers as indexes, gave failed calls 0 ms in the Stats tile, and read a Jev Auto · Local pick as `Jev unavailable (undefined)`; the budget table's peak could be below Now, and its Laya cells called stored figures what Laya takes now.
  A crash that left Laya failed still said it was restarting; the wait lines misdescribed a stop or a crash backoff; a start the budget refused sent the person to Start and the log; a hung request's restart never reached the card; a step's second line reached the server log without its `[jev] ` prefix.
- **Supervision and install.**
  An update was refused only after its download while a Laya Auto run was open; every command the installer ran inherited the person's TypeSafe settings and Hugging Face token; a start could declare a Laya that had just exited ready; the GPU spill warning cleared while the spill went on; a disposed supervisor could still start Laya; a stop held the engine's process open for 15 s; a crashed `llama-server` stayed in the RAM budget beside Laya; `laya.connectivityUrl` took a TypeSafe address or no address at all.
- **Tests that proved too little.**
  Three owner decisions are now guarded through `index.js` itself (a failed Laya call never goes to Jev, offline Laya Auto routes to the local models, Laya Auto is never shadowed), and so is a Jev Auto run replying before a slow Laya has answered; a shadow row the disk refuses, and the event loop during a comparison or compaction at the file's cap, are measured; tests that passed on the old code were rewritten or moved into `test/fixtures.test.js`, whose tests test only the shared test code.
  `scripts/red-check.mjs` passes on every test the branch adds or extends: a test that fails at the base only because a file the change adds is missing runs again with those files in place (365 new tests when it was last run over all of them, at `caf7ad3`).
- **G9 finished**: the integrity check and the export of the desktop checklist, `make_ckpt.py`, `plant_hf_cache.py` and the `test:e2e` script.

The run in the table above was of `7519f8f`, before those fixes.
After them the whole test ran again against the real `laya.serve`, on 25 Sep from 16:12 to 16:24 UTC on the fixed code, and passed the same 8 steps with step 1 again not run for disk.
Its figures are within about 10 percent of the table: ready in 16.0 s with the short warm-up; intent 1.64 s, resource 3.02 s, task group 46.5 s, review 18.6 s; the gate refused a 3 s route call in 2 ms (`about 45 s`), held its slot until `laya.serve` answered 44.8 s later, and never sent the aborted queued call; Jev Auto took 2168 ms with the shadow off and 2207 ms with it on, the last shadow row landing 43.4 s after the run; the Laya Auto run took 192.2 s with 0 TypeSafe requests and named the 17 fields the rules filled; a kill mid-call now reads `Laya stopped while answering (signal SIGKILL); it is restarting` and Laya answered again in 13.3 s; the render check cut nothing in 194 rows.
Still testable only on the owner's PC: the install itself (step 1 of 9.4, and whether each pinned CUDA tag has a torch 2.14.0 wheel for Windows), the GPU (its speed, its memory beside the chat model, the sysmem spill), answer quality and issue #156 with the labels workaround on the real English weights, Windows process handling (the venv redirector's interpreter pid, the tree kill, priorities, the orphan sweep), the render check with the real tokenizer, and the shadow on real Jev Auto runs; `laya-auto.md` 9.5 walks through all of it.
The desktop helpers of 9.5 are in `scripts/`: `laya-render-check.mjs` (step 5), `laya-integrity-check.mjs` (step 12, which exits 1 naming every violation) and `laya-export.mjs` (step 13, the one file to bring back, which reduces `history.jsonl` field by field and redacts every string); `test/laya-desktop-helpers.test.js` runs the last two on data of their own, with a task text and keys planted in `history.jsonl` that never reach the export.
Two wording gaps found in that pass are fixed: the CPU-fallback note now says to choose Remove and Install Laya again (the card has no Reinstall button), and the restarting line names an exit by a signal as `signal SIGKILL`, not as an exit code.
The suite passes: 1196 tests, 1195 pass, 0 fail, 1 skipped, three runs in a row on the pushed head.
Everything above is pushed on `feat/laya-auto`.
What is left is the owner's desktop checklist, `laya-auto.md` 9.5.

What follows is the reasoning from before the design, kept for why it is shaped this way.
`laya-serve` speaks the same `POST /v1/systemone` protocol as Jev, with the same `choice`, `score`
and `noul` answers, so a second decision provider is a `baseUrl`, not a rewrite. The owner's intent
is **an additional Laya Auto beside Jev Auto, each with its own maturity ladder**, not a
replacement.

Read the numbers before betting on it. Laya's base checkpoints score **0.362** and **0.342** on its
own typed-decisions benchmark, against **0.318** random and **0.461** majority-class, so zero-shot
it is worse than always guessing the commonest answer; the **0.766** that beats Jev's **0.727**
belongs to a fine-tuned checkpoint. It ships over-confident, mean ECE **0.466** until temperatures
are refitted, and the multilingual checkpoint ships with none fitted at all. Open bug #156 has
`noul` following its option labels instead of the input. All of these figures come from Laya's own
README, which states plainly that the Jev column is third-party published and was never measured
there.

So thresholds must live **on the provider record**, never shared with Jev's, and the first step is
providerising `jev.js` so endpoint, key, model and thresholds stop being constants. That step is
worth doing whether or not Laya ever ships, because it is what makes any second provider possible,
including a BYOK one. Then shadow mode, which costs nothing, and a decision taken from the
agreement data rather than from anybody's README. `routing-samples.jsonl` is already the shape of a
fine-tuning set, which is the only reason the fine-tune step is interesting at all.

One rule if this is built: when several sources can answer a domain, the rule choosing **who
answers** stays in code and stays dumb. Highest maturity wins, ties go to the cheaper source,
anything rolled back is out, and nobody mature means Jev. A learned arbiter would have less
evidence than the classifiers it arbitrates, and would make a bad pick unattributable.

### From the merge review: all closed on 24 Sep

The six items still open from the merge review are closed by the second pass, so nobody re-opens them.
`state.candidates` no longer rides the strategy call, because no routing call carries candidate data.
No conservation sample exists to push for labelling.
A mature local classifier cannot outrank the `code` ranking (`localDecides: false`).
`fallbackYes` and `scarceTop` are gone from `decision.js`.
`history` and `first_resource` ride no judgments-only call.
The acceptance test `five tasks in one workspace, every state, then a restart` awaits `tasks.flushed()` and runs on an injected clock, where it used to poll the file for up to 2 s and failed under full-suite load.

## For the desktop agent

These need the Windows machine, the running app or the owner, and could not be done in the cloud session that built `fix/roadmap-open-items`.

1. **Get the branch into the app and watch one routed run** (roadmap §0 item 4).
   Where: `C:\Harness` on the branch (or on `main` once it is merged), then start KzH fresh, since a `client.js` change needs an app START; the branch changes no `app/` code, so the exe needs rebuilding (`npm run package`, app stopped first) only if `app/` has changed since.
   Route one project task under **Jev Auto** and open the Jev inspector.
   Done when: the **Router** tab lists all eight domains with real sample counts, the message intent among them; frontier escalation's words name a rule in code at its rung (`a rule in code decides; the local router is not trained yet` at JEV_PRIMARY), and resource selection reads `a rule in code decides at every rung; the local router is recorded beside it for comparison and never decides`; the run's reasoning block carries the decision line (`adapter.js` `decidedBy`), on a cold router `Jev and routing rules decided; 2 Jev calls; 3 candidates considered` (the task call, then the strategy and second-opinion call), or `the local router (task classification, skill selection), Jev and routing rules decided; 1 Jev call; ...` once both task domains answer locally, and the report header uses the short form, `AUTO (Jev and routing rules decided)` or `AUTO (the local router, Jev and routing rules decided)`; and the **Decisions** tab shows each `RESOURCE_x` key with its agent id next to it.
2. **Look at the Resource budget table** (Settings → Jev setup → Local models, with at least one local model installed).
   Check: the four rows (VRAM, RAM, Cores, Tasks at once) with their Budget, Now and Estimated peak cells; a field saves when it loses focus; blank is no limit; `4,5` is read as 4.5 and `4,096` is refused; a refused field keeps its own error line under the table; an over-budget model shows the `over budget` pill and the refusal word for word; the chat model select shows `None fits the budget` when nothing fits; a model the RAM budget sized down shows `The budget reduced its context from <X> to <Y>, the largest that fits it.`; the soft-RAM note and the 12k context warning read as the README says; and the Tasks at once Now cell shows the runs holding a slot (`0` when nothing runs), with `N waiting` beside it when a cap is set and runs wait, and `-` only when the response carries no count.
   Look at it at the app's normal width and at a narrow one.
   Done when every item reads as described and nothing clips or overlaps at either width.
3. **Right-panel guide icons**: the seven KzH rows showing the generic cube (see "Open work an agent can do").
   Done when each of the seven rows shows its own icon in the running app.
4. **Installer fixes**, each needing the Windows machine to test.
   `scripts/Install-Harness.ps1:60` treats any `cordis.patch.yml` containing "jev-router" as configured, so a privacy setting added later never lands on a re-run.
   `scripts/Set-TypeSafeKey.ps1:7` writes a second, persistent HKCU copy of `TYPESAFE_API_KEY`, which `Start-KzH.ps1` (its `GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')` read) reads back.
   `C:\HarnessProjects` is hardcoded at `app/main.js:536`, `Start-KzH.ps1:6` and `scripts/Install-Harness.ps1:74`.
   Done when a re-run adds a missing setting, the key lives only in `~/.kzh/.env`, and the projects folder follows `-Workspace`.
5. **Jev and Laya together, on the desktop** (roadmap §2; built on `feat/laya-auto`, see "Laya: built on `feat/laya-auto`, not yet observed" above).
   The providerised `jev.js` and all of Laya are built and tested in the cloud; Laya needs this machine to install, run on the GPU and shadow real Jev Auto runs.
   The test machine is the owner's desktop: an RTX 3080 with 10 GB of VRAM, an i7-8700K (6 cores, 12 threads) and 32 GB of RAM.
   Expect Laya on the GPU (about 2.5 GB of VRAM before it is measured, leaving about 7 GB for a local chat model beside it), the installer choosing the newest CUDA tag the NVIDIA driver allows (cu130, cu128 or cu126; with an older driver it says so and installs for the CPU), and 4 threads on the CPU when it falls back.
   Done when the owner has worked through `docs/laya-auto.md` 9.5 and brought back its one export file, the one `node scripts\laya-export.mjs` writes, never `history.jsonl` or `usage.jsonl`.
6. **Exercise the gemma transfer against a real local model** (`plugins/jev-router/format.js`).
   Done when one finished background result is posted in the running app with a local chat model installed.
7. **The `Use it here` kill path.**
   Done when, on the real machine, a click is seen to stop an orphaned engine on port 3080 and to refuse anything whose command line is not the engine.
8. **Owner decision: a configured tool's output is cut before it is scrubbed.**
   `index.js` `runTool` keeps the last 8000 characters as the answer and the last 500 as the diagnostic, so a key straddling the cut reaches the review call as a fragment; scrubbing first changes what the person is shown and what history stores.
   Options: scrub the tool answer everywhere, or keep a scrubbed copy for Jev.
   Done when the owner has chosen and the choice is in roadmap §5.
9. **Owner decision: whether Jev is offered the whole capability vocabulary.**
   Jev is offered only the capabilities some agent in the pool can carry out (the "Still open" bullet under the 23 Sep fix rounds); offering the whole vocabulary so code can refuse is a design choice.
   Done when the owner has chosen and the choice is in roadmap §5.
10. **Run the speed benchmark against the real llama-server** (`feat/benchmark`, docs/benchmark.md step B1; see "Built but NOT observed").
    It has run against the real llama-server only on a Linux CPU with tiny test models, so what is left is the GPU, the Windows CUDA build and the real models.
    Where: Settings → Jev setup → Local models, with both local models (Qwen3 8B and Gemma 4 E4B) installed; run **Benchmark all**.
    Check that each model gets a reading whose three runs agree, that the card's lines and the install picker's measured labels read as docs/benchmark.md 2.9 says, that a local agent task started during the run waits with its line, and that the model loaded before is loaded again after.
    The measuring can also be done with KzH not running (quit it from its tray icon): double-click `Speed-Run.bat` in the harness folder (docs/benchmark.md 2.12), which has never run on Windows, and check that it measures both models, prints its table and ends with exit code 0.
    Bring back what the runs wrote in `%USERPROFILE%\.kzh\jev-router\speed-runs` (docs/benchmark.md 2.13), from the card and from `Speed-Run.bat` alike: `speed-runs.log` and the newest `speed-run-<time>.log`.
    Done when every item reads as described, and any reading refused says why in words of docs/benchmark.md 2.7.
11. **Run the capability benchmark with real agents** (`feat/benchmark`, docs/benchmark.md step B2; see "Built but NOT observed").
    Where: restart KzH so `Start-KzH.ps1` adds **KzH scratch** to the project list, open a chat in it, then the Jev inspector's Router tab, Capability benchmark card; pick Claude Code, Codex, DeepSeek and one local agent, read the confirmation, and run.
    Check that each agent's first task (write what `node --version` prints to `hello.txt`) passes, so Claude Code's permissions let it run `node` in its folder.
    Check that no task fails with `wrote outside its folder` for a file the engine or the command-line tool itself writes in the scratch root: the listing of the scratch root before and after each task was only tested with stub agents.
    Check that the Usage tab marks the rows `benchmark`, that `capability-evidence.jsonl` gets rows with `source: benchmark` for every agent that finished, and that the Router tab's profile line shows `benchmark N% (k of n tasks)`.
    Done when a full run on each picked agent finishes, or each stop says why in words of docs/benchmark.md 3.8.

## Open, and needing the OWNER, not an agent

1. **The `Use it here` holder test** is narrow but not ownership-proof: it can stop a manually started copy of the pinned engine on 3080, though it needs an explicit click and refuses anything whose command line is not our engine.
2. **A configured tool's output is cut before it is scrubbed**, and **whether Jev is offered the whole capability vocabulary**: items 8 and 9 of "For the desktop agent".
3. **Whether the table rule covers the Resource budget table.**
   The Resource budget table on the Local models card (`client.js` `ResourceBudget`, client.js:4506 at `a1e42b4`, 4602 at `c0ef03c`) has no per-column sort or filter, which the table rule asks of every table (this file, "Rules that were applied and must keep being applied").
   It is a fixed form of input rows, and whether the rule covers such a form is the owner's call.
   The benchmark leaves the table untouched and puts the date of a measured memory figure on each model's memory line instead (docs/benchmark.md 2.9).
4. **Whether a new test of a promise the code already kept may pass on the old code.**
   The rule is that every new test fails on the old code (`scripts/red-check.mjs`).
   The second review of benchmark step B2 (`5f19588`) added 11 tests of promises the code kept but no test held, such as that a run with learning off records nothing and that a task set with a defect is refused as it loads, and red-check against `da08532` exits 1 naming them as passed at the base (docs/benchmark.md 5.2).
   Such a test cannot fail on code that already keeps its promise, so either the rule has an exception for it or those tests need another proof, such as failing on a copy of the code with the promise removed; that is the owner's call.
   The review of `fix/queue-and-cost` added sixteen more such guards (a plan-mode start, each condition of the lock check's run count, per-repository counting, the start-time lock re-check, Remove's server guard, the Background tab's Remove, per-provider risk bands, a read pass outside git never waiting on the run log, a DeepSeek key added in Settings beside one out by its reading taking over, a key row after one agent's attempt scored against every switched-on agent's floor, a Jev key held only in the credential store unset when removed, Jev setup read back after an action that failed, Jev's Usage row counting every Jev call this month, the in-app browser view closed with its window, the window closed to the tray and reopened on the harness page, `Start-KzH.ps1`'s engine line printed after the patches and before the engine starts); each was proven to fail on a copy of the code with its promise removed.
   The review of slice 1 of `feat/live-agent-view` added one more, `a result a restart caught posted and not yet seen is marked read by its notice, after the next restart too` in `test/tasks.test.js`, which fails on copies of `tasks.js` whose `reconcile()` sets no `postedBeforeRestart`, whose load drops the saved mark, or whose `delivered()` refuses every `pending` result.
   Slice 2 of `feat/live-agent-view` added one more, `a legacy string from enqueue yields exactly today's line` in `test/adapter.test.js` (an orchestrator that answers a bare line, with no task key, gets that line back as the reply and is asked for no `watchPlan` or `noteAck`), which fails on a copy of `adapter.js` whose `startReply` has no branch for a line without a key.
   The review of slice 2 added one more, `a task queued after a direct answer says, when it is judged read only, that it runs locked or why it waits like work that writes` in `test/adapter.test.js`.
   The queued line the old code put after the answer said `Read only` already, and red-check sees the test fail at `5fa174c` only because that code cannot read the object its stub orchestrator answers; it fails on a copy of `adapter.js` whose `alsoWork` branch drops the access sentence.
   The fourth review of slice 2 added one more, `a retry on the agent the work is already on gets no moved notice` in `test/laya-integration.test.js`.
   The old code posted no notice at all, so it posted none for such a retry either, and red-check sees the test fail at `5fa174c` only because it reads the start reply that code did not write; it fails on a copy of `index.js` whose `heard` takes any retry for a move.
   The fifth review of slice 2 added three more.
   `a pick that lands after the guard's grace but within the reply's wait gets reply A and no started notice: the guard waits out the reply's own wait before its grace` in `test/laya-integration.test.js` holds that no started notice goes beside a reply that named the plan, which the old code kept by posting none; red-check sees it fail at `5fa174c` only because it reads the start reply that code did not write, and it fails on a copy of `index.js` whose guard waits only the grace, not the reply's wait (`}, guardGraceMs)` in `follow()`).
   `a message Laya could not sort says why it runs as a task in every start reply: A once Laya picks, B while it waits its turn, and C when the reply does not wait for the pick` in `test/laya-integration.test.js` holds the reason the old queued line gave already, and red-check sees it fail at `5fa174c` only because it reads the start replies that code did not write; it fails on a copy of `index.js` whose `enqueue` leaves `why` out of the facts B and C are written from, and on one of `adapter.js` whose reply A leaves it out.
   `a message Laya could not sort says why it runs as a task in the start reply the adapter writes: A once the pick lands, C at the bound, and B or C once a read pass hands it back` in `test/adapter.test.js` holds the same reason in the replies the adapter writes itself, and red-check sees it fail at `5fa174c` only because that code cannot read the object its stub orchestrator answers; it fails on copies of `adapter.js` whose A, whose C at the bound, or whose B or C after a hand-back leaves it out.
   The eighth review of slice 2 added two more, of the rule that a task judged read only that no agent can lock, waiting only for a free slot, runs as work that writes and is never said to wait for its folder, which nothing holds.
   The old queued line kept that rule, and `test/read-intake.test.js` holds it there, but `queuedLine` has no caller left, so no test held the start replies that say it now, and a copy without the rule in any of the three places that keep it passed every test.
   `a task judged read only that no agent can lock, waiting only for a free slot, is told in B, ...` in `test/reply-words.test.js` fails at `5fa174c` only because `reply-words.js` is new; it fails on copies of `reply-words.js` whose `queuedReply` passes `true` for whether the task waits for its folder, or whose `planReply` passes only whether it waits at all (`!!waiting`).
   `a task queued after a direct answer says, when it is judged read only, that it runs locked or why it waits like work that writes` in `test/adapter.test.js`, from the first review above, now holds one waiting only for a free slot too, and fails on a copy of `adapter.js` whose `alsoWork` sentence passes only whether the task does not start now (`!q.startsNow`).
   Only a forced agent's reply A says where it waits, and a forced agent is never judged read only, since the adapter asks the decider nothing for one, so the test holds `planReply`'s rule as the words that function gives, not as a reply the chat writes now.
   Slice 3 of `feat/live-agent-view` added one more, `no intent sample is recorded where Jev teaches nothing: Jev Auto offline or with no network, Laya Auto, and learning or adaptive routing off; there an answer carries no mark, and with learning off no reply is kept either` in `test/laya-integration.test.js`.
   The code before slice 3 recorded no intent sample anywhere and kept no reply ledger, and red-check sees the test fail at `dbdec3d` only because it reads the summary route that code did not have, first for the plugin with adaptive routing off, so its part with learning off never runs there; it fails on copies of `index.js` whose `classify` records a sample offline (through `classifyIntent` in its offline branch), records Laya's intent through the intent domain, builds the domain registry with learning off, takes the intent domain with adaptive routing off, or keeps the reply ledger with learning off (`ledgerOn`).
   Two of slice 3's new tests, which fail at `dbdec3d` on what they add, also hold a promise the old code kept, and each fails on a copy with that promise removed.
   `a message's intent sample rides its queued task and its run, and a question answered directly ends with its mark after the credit` in `test/adapter.test.js` holds that work queued behind a direct answer carries no sample, and fails on a copy of `adapter.js` whose `alsoWork` enqueue carries it.
   `under Jev Auto each message is one intent sample with Jev's answer as the teacher's, still one Jev call a message: ...` in `test/laya-integration.test.js` holds that Jev is asked once per message, and fails on a copy of `intent.js` that asks Jev again for the answer it returns.
   The second review of slice 3 added one more, `where no task can run, in No project and the scratch workspace, Jev reads every message on a Jev row, so a question the local classifier is sure is a task is answered there, not refused; in a project folder that classifier decides` in `test/laya-integration.test.js`.
   The code before slice 3 answered such a question there, since it asked Jev about every message, and red-check sees the test fail at `dbdec3d` only because it seeds the intent domain with features that code did not have; it fails on the slice 3 code before the fix, and on copies of `index.js` whose `classify` passes no `localMayDecide` or whose `tasksRunIn` leaves out No project or the scratch workspace, of `adapter.js` that tells `classify` no folder, and of `intent.js` that hands `decide()` no `localMayDecide`.
5. **Whether "one writer per workspace" means per folder or per repository.**
   Lanes are keyed by folder (`tasks.js` `laneKey`), so two tasks that write in two folders of one git repository (`repo/pkg-a` and `repo/pkg-b`, or `repo` and `repo/pkg-a`) run at once.
   `changedSince` reads the whole repository's `git status`, so each is credited with the other's changes: its `Changed files`, the checks it triggers, the stall guard (`N work attempts in a row changed no files`) and the learning features all count them.
   Scoping a run's changes to its own folder would miss a writer's real edits outside it (a monorepo's root `package.json`); keying lanes by repository would stop two packages of one monorepo from being worked on at once.
   The review of `fix/queue-and-cost` left it as it was; which rule holds is the owner's call.

### Decided by the owner, 24 Sep 2026

- **Feedback privacy: keep as now.**
  Now means this, checked against `jev.js` `route()`: the typed reasons ride only the legacy named call (`routing.enabled: false`), inside `agent_track_record`, with key-shaped secrets and `Bearer` tokens scrubbed and names not masked.
  Each is the chosen tag, when there is one, followed by the reason the person typed, up to three per agent, from this session only.
  Under adaptive routing, the default, no routing call carries any track record, availability or history, so the reasons do not leave the machine at all.
  The bias that moves a pick is computed locally either way (`router.js` `feedbackPrior`, applied in the block that opens with the comment `// The feedback prior, applied.`), to the ranking's probabilities under adaptive routing and to Jev's with `routing.enabled: false`.
- **A mature local classifier may not outrank the `code` ranking.**
  The resource ranking decides at every rung (`localDecides: false` in `routing-policy.js` `DOMAINS`), and no policy can switch that on.

## From the pre-publication audit, 22 Sep

Five lenses ran over the committed tree before the first push, each finding then given to a second
agent whose job was to refute it. Four were confirmed and fixed before publishing: a Windows
account name in this file, an `ssh` clone URL that fails for every stranger, a privacy list that
omitted two payloads, and an undocumented `git fetch` at every start. A fifth was found the same
way and fixed in code rather than in prose: `agent_track_record` rode the routing call unscrubbed
while it carries the person's own typed feedback reasons.

These were raised and NOT fixed. None blocks publishing; all are real.

- **`scripts/Set-TypeSafeKey.ps1:7`** writes `TYPESAFE_API_KEY` into the persistent HKCU user
  environment, which `Start-KzH.ps1` (its `GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')` read) reads back and which outranks `~/.kzh/.env`. The README
  says keys live in exactly one place, and its removal instructions only cover `.env`. A second
  copy nobody is told to rotate.
- **Real wallet thresholds are published**: `255 soft / 240 hard` appear in this file. The
  shipped defaults are 10 and 5.
- ~~README start time~~ and ~~README says nothing hardcodes a machine~~ were both fixed in the
  README on 24 Sep: it now says about 40 seconds and longer on a first run, and it names
  `C:\HarnessProjects` as the one built-in path with `-Workspace` as the override. The code still
  hardcodes it at `app/main.js:536`, `Start-KzH.ps1:6` and `scripts/Install-Harness.ps1:74`; the
  prose was made honest rather than the code made general, which is the cheaper of the two and
  should be revisited if anyone ever ships this to someone else's PC.
- **`scripts/Install-Harness.ps1:60`** treats any `cordis.patch.yml` containing "jev-router" as
  configured, so a privacy setting added later never lands on a re-run, while the README says
  re-running does whatever is missing.

Coverage gap worth knowing: no reviewer ran the app, ran the installer, or cloned to a clean
machine. The broken clone URL was found by reading, not by trying it, so the install path is still
unverified end to end. Several of the eleven items above came from a single lens and were not
independently re-derived.

## Open work an agent can do

- **Next time, after the owner's desktop test: optimisation, done on the owner's PC.**
  The owner decided on 25 Sep that work continues locally from here, not in the cloud.
  1. **A benchmark.**
     First speed and memory: load each installed local model at the configured context, time real generation, and store `tokensPerSec` beside the VRAM and RAM `local.json` already records per model and context, so the picker's `~X words/s est.` becomes measured.
     Then capability: a small fixed task set per skill, each task in a throwaway workspace with its own tests, run on every agent through the normal routing, the pass rate written as `source: 'benchmark'` rows in `capability-evidence.jsonl` (`profiles.js` already weighs them at 0.7 with a 180-day half-life and the Router tab already shows them).
     The task set is the part that decides what the scores mean; cloud agents cost real usage, so it is a button behind a confirmation, never automatic.
     It is designed in [`benchmark.md`](benchmark.md), kind design, build against it, as two steps built in that order: B1, speed and memory of local models, then B2, capability.
     It is built: B1 in `914d8d4` and `c0ef03c`, and B2 in `d71b76c` with its review fixed in `1363776` and its second review in `5f19588`, both on `feat/benchmark`.
     What remains is observing both against the real engine and agents: items 10 and 11 of "For the desktop agent".
  2. **Compaction at 97 percent: done on 25 Sep, in the cloud.**
     Conversation compaction belongs to the engine's `compaction-basic` plugin (`@deepseek-ai/dsh-compaction-basic`, read at the pinned 0.1.5-rc.2), whose `thresholdRatio` defaults to 0.8; `config/cordis.patch.yml` now sets it to 0.97.
     The engine replays all but the newest 16% of the conversation to the model and asks for a summary of up to `maxTokens` (8,192 by default), which on a local model's 12,288 to 16,384-token window does not fit even at the old 80%, so each local chat model gets a 1,024-token summary; `test/compaction-config.test.js` checks that arithmetic for every chat model in `config/local-models.json` at the smallest window the RAM budget allows.
     An existing install gets the new rows only by hand: `Update-Harness.ps1` lists them under "missing in" the live config and merges nothing, by design, so the owner pastes the `compaction-basic` block into the live `cordis.patch.yml`.
     Two limits stay: every KzH row tells the engine it has a 1,000,000-token window (`adapter.js`), so a Jev Auto or Laya Auto chat compacts only at 970,000 tokens, which a chat of messages and answers seldom reaches; and Claude Code and Codex compact their own sessions by their own rules, which this setting does not touch.
  3. **Laya's thresholds and temperatures from the desktop export**, as `laya-auto.md` section 10 lays out, once the export is back.
  4. **Run fix batches in parallel.**
     A review's fixes were run one batch at a time in the cloud, where two helpers can run at once; on the owner's PC (up to 10), batches that own distinct files run in parallel worktrees, followed by one merge and full-suite step.

- **Exercise the gemma transfer against a real local model** (`plugins/jev-router/format.js`).
  No real local call has ever been made, only fake streams.
  One finished background result posted in the running app, with a local chat model installed, would settle it.
  It needs the machine: item 6 of "For the desktop agent".
- **Right-panel guide icons.** KzH registers seven guide rows in `plugins/jev-router/client.js` (Browser, Terminal, Background tasks, Subagents, Usage, Session overview, Jev inspector) and passes no icon for any of them, so all seven show the same generic cube.
  Only Workspace files, the engine's own row, has a real folder icon, so something already makes that one different.
  Find what, then give KzH's seven rows relevant icons.
- **Watch the adaptive router in the running app**, which is the one thing it has never had.
  Start KzH, open the Jev inspector, and check four things: the **Router** tab lists all eight domains with real sample counts, the message intent among them; the two domains a rule in code decides say so at their rung; a routed run's reasoning block carries the decision line, on a cold router `Jev and routing rules decided; 2 Jev calls; 3 candidates considered`; and the Decisions tab shows the candidate table as the router saw it, each `RESOURCE_x` key with its agent id next to it (the person sees the mapping; Jev does not).
  Item 1 of "For the desktop agent" has the exact words to look for.
  Everything else about it is already exercised by `node scripts/kzh-routing-demo.mjs --learn 60`, which needs no engine and no network.
- **Memory readings are not tied to the model's weights.**
  Memory readings under `measured` in `local.json` are keyed by model and context, and `measuredFor()` compares only the GPU room and the GPU layers beside them.
  After a manifest update ships other weights under the same model id, the old weights' memory reading still sizes the context in `planFor()` and shows on the card as measured, and if it puts the model over the budget the model is refused and never loads to be measured again.
  Speed readings compare the weights since the review of benchmark step B1; memory readings want the same condition: keep the weights in `recordMemory()` and compare them in `measuredFor()`.
  The review of B1 found it and left it, since it predates B1.
- **Two small edges in the budget-sized context**, neither urgent.
  A measured reading over the RAM budget moves the next load down 1k without a watchdog unload, and the router keeps the old, larger window until its next refresh; the watchdog normally catches the same overload.
  `index.js` `refreshLocal` joins a refresh already in flight (`refreshing ??=`), which may have read the settings before a save that lands during it; this predates the branch, applies to `onChange` too, and the window is small.
- **Published benchmarks have no source.**
  Benchmark evidence itself has one since step B2 (`feat/benchmark`): the capability benchmark writes `source: benchmark` rows (`profiles.js` `benchmarkEvidence()`), capped so a whole run weighs three observations per dimension, left out of `samples` and `evidenceSamples`, and counted only for the newest run per subject and benchmark id.
  `benchmark_prior` rows still have no producer: nothing imports published benchmarks, which docs/benchmark.md section 6 keeps out of scope.
- **A routing domain retrains in-process.** After a run settles, `index.js` evaluates every
  domain in the background, at most once a minute; a domain first trains at 50 verified samples
  and retrains after every 100 new ones. The routing call never waits for it, but it is
  bounded synchronous work in the engine's own process, and a much larger sample store would
  want it moved off.
- **What the 23 Sep fix rounds left open.** Seven rounds of fixes, each checked by a second agent
  that reproduced every defect with a probe, and every fix proven by a test that fails against
  the old code.
  Closed, so nobody re-opens them:
  - Routing: every router swap (capability, tie-break, weekly gate, feedback, retry, `LOCAL_FIRST` hand-over) goes only to an agent that can do the job, and none brings back an agent a hard fact excluded; a capability outranks the conservation limit and the gate, and the gate yields visibly (`gateYielded`) only when nothing ungated can do it; `gateOverride` reaches the engine in a wired install, and a gated resource the override does not keep is recorded as past its gate.
  - Every move the router makes is recorded in `routing.moves` with its own target, and the report
    and the inspector name each one, the tie-break included.
  - A review the plan promised goes to the reviewer it named, whatever asked for it.
  - The governor treats a measurement as the floor under an estimate at any confidence.
    Its pressure from a balance is continuous at both floors for every floor setting except floors
    of nothing (both 0, or one 0 and the other unset), where an empty balance reads 1 and a cent
    above it gives no floor reading, so a share spent speaks if there is one and the resource
    otherwise reads as unknown.
    It refuses policy values its arithmetic cannot use, and conservation acts only on a resource
    that is actually being used up.
  - Masking: short model ids, a vendor word with a version, and a point release after any name are masked; model aliases are not names; no field is a hiding place from the masker.
    The review call masks the names `features.js` `identityNames` gives (id, display name, providers, model ids), including the model a CLI agent really runs.
    Since the second pass the adaptive routing calls carry no identity channel at all, so beyond the key scrub of their free text (task, workspace, handoff) there is nothing in them to mask.
  - The review call says truthfully why each resource is outside the work table and carries the
    numbers of one kept for review.
  - Labels: a planned forced review is not a rescue; a strategy, second-opinion or frontier answer is labelled by a run only where it could change that run.
    Conservation, a limit since the second pass, is never labelled.
  - Verdicts: the client sends the run id every routed answer carries, so a verdict lands on its
    own run; a verdict credits capability evidence once, relabels its run's routing samples, keeps
    what it counted only when re-posted unchanged, and is withdrawn by a clear or a change even with
    learning off, without bringing in a verdict given while learning was off; it relabels only the
    samples its run labels, never one the engine left out on purpose.
  - Maturity: recent accuracy and calibration read only rows the classifier was not trained on,
    and a window too short to measure is not read as a regression; a pending regression, and a bad
    window counted at the rung the domain holds, blocks promotion; a window needs new rows; every
    rung up to the one lost is re-earned on new evidence; stepping down from a local rung settles
    the bad windows; a retrained classifier at a local rung serves only after passing that rung's
    gates.
  - `resources.economics` reaches the engine, the executor ranking and the cost tier in the track
    record Jev reads; the upgrade seed reads decision records; familiarity is counted by resource
    id, not by the positional key; the local-model rewrite of a background result keeps the agent
    chain and the run mark exactly as written.
  Still open:
  - Jev is offered only the capabilities some agent in the run's pool can carry out, so it cannot
    name one nobody here has: on **Jev Auto · Local** a look-up (`web_research`) is classified as
    something a local model can do and runs on it, and the router's "nothing here can do this"
    refusal fires only for a capability that was offered but that no agent left in the pick pool
    can do.
    Offering the whole vocabulary so the code can refuse is a design choice for the owner, since it
    also lets Jev name capabilities the machine could never run.
  - A verdict on an answer from before the run mark existed is still credited by time: a FIRST
    verdict on an older answer, given after a newer run in the same session had ended, lands on
    that newer run.
  - Executors: only local runs return `modelVersion`; a cloud or subscription executor that can
    report the model it served should return it from `execute`, and `router.js` will record it.
  - The `POST /jev-router/feedback` handling is `index.js` `createFeedbackRoute` now, tested end to end in `profiles.test.js`: a verdict is stored, credited and relabelled; a bad body is a 400; learning off is honoured; posts are applied in stored order; and the next verdict is taken after a store failure.
    The history deps `apply()` gives the router are `createHistoryDeps`, which is tested too.
    Still untested, because they need the plugin runtime: the deps object `apply()` passes to `createFeedbackRoute` (`records: allRecords`, `agents: enabledAgents`, `learn: () => config.routing?.learn !== false`, `log` and the rest) and the one-line `send(status, body)` branch.

Closed on the way past, so nobody re-opens them: the `README.md` dangling "described below" is gone
(it reads "the list below" and resolves), and the one machine-specific path in the repo, a Windows
account name inside a `progress.html` note, now reads `~/.kzh`.

A warning that cost a real defect here. Checking that with `git grep <the name>` passes for the
wrong reason when the file you just wrote is still UNTRACKED, because `git grep` searches tracked
files only. Write the check so it cannot quote the thing it is looking for, and run it after
`git add`, not before.

## Built but NOT observed, do not claim these as working

- **The live agent view's groundwork** (`feat/live-agent-view`, slice 1 of [`live-agent-view.md`](live-agent-view.md)).
  Every background task has a `key` of its own, a UUID saved in `tasks.jsonl` that every run of the task is handed and its history row keeps as `taskKey`, and a `plan`, what the router picked when it last routed it (`tasks.js` `planOf`); `tasks.watch(key, fn)` hears a task's router events until it settles.
  `planGen` counts the task's `routed` events: 2 for a task a read pass handed back after it was routed (its agent said it needs to change files, could not be started locked, or no other agent that can be locked was left to try), and 1 for one handed back while it was being routed (the routing named work that may change files, or picked an agent that cannot be locked, or no agent could be locked at all), so slice 2's `again` notice must key off the hand-back itself, not off `planGen === 2` alone.
  The browser acknowledges each result row it rendered once, remembered by the row itself, naming the task's id and name and the chat on screen (`POST /jev-router/tasks/seen` with `results` and `sessionId`), so a new row that reads exactly as an older one is still acknowledged.
  `tasks.delivered()` marks read only a finished task whose name matches, whose chat matches when the page names one, and whose notice can be in the chat: one claimed for delivery (`delivering()`), or one a restart caught posted and not yet seen, which `reconcile()` marks `postedBeforeRestart` (saved, so the mark holds through later restarts).
  Any other unread result has no notice and is refused: one waiting to be posted or whose post failed, one the restart stopped, and one that settled but was not posted before the app closed, which nothing posts after the restart, so it stays unread until it is cleared.
  So an older result's row under a job id the engine reused after a restart, even one naming the same task, can no longer mark the new task's result read before it has posted, nor ever from another chat; an older page's bare `jobIds`, which name no chat, are still heard under the other rules.
  A row an older build wrote carries no such mark, so a finished, unread one is taken as possibly posted, as every restored result used to be, and one it left waiting or running is stopped and refused.
  A known limit: a result whose claim had not reached `tasks.jsonl` when the app was killed, in the moment after its notice was posted, comes back as never posted and stays unread until it is cleared.
  That refusal is a deliberate change: `delivered()` used to mark a finished result read before anything had claimed it, so the `tasks.test.js` tests `a finished task is delivered to its own session exactly once` and `delivered() with a name that is not the task's leaves it unread (a job id reused after a restart)` now claim it with `delivering()` first, as `delivery.js` does.
  The routed event names the agent doing the work with its model and the effort its first attempt starts at (`router.js` `plannedEffort`), and the planner and the reviewer; each agent start is told its attempt index and role; `agentsMark` is the agent strip's chain mark on its own.
  `config/cordis.patch.yml` raises the engine's background job limit per chat from 10 to 32 (its `jobs` row), and a task refused at the limit reads `Too many background tasks in this chat (32). Wait for one to finish or remove a waiting one, then send it again.`
  All of it is tested with fakes only (the `tasks`, `router`, `workboard`, `transcripts`, `speed-routes`, `jobs-config` and `laya-integration` test files).
  To verify on the owner's PC:
  - a background task behaves as before, apart from `key`, `plan` and an empty `intentSample` (nothing sets one yet) on its row in `tasks.jsonl`;
  - run a task, restart KzH, and run another in the same chat, which the engine gives the first one's job id; do it twice, once with other words and once with the very same words, so that the two result rows read the same: each result posts exactly once, and the Background tab's `Unread result` clears only after that result has appeared, also when the page is reloaded while the result waits for an answer to finish streaming;
  - send the very same words in another chat after the restart instead, and keep the first chat on screen until the new result has posted: that result stays `Unread result` until its own chat is opened;
  - close KzH while such a task under a reused job id still runs, start it again and open the chat holding the older row with the same words: the stopped task stays `Unread result` until it is cleared;
  - paste the `jobs` block into the live `~/.kzh/profiles/web/cordis.patch.yml` by hand while no task runs (`Update-Harness.ps1` lists it as missing and merges nothing; taking the new limit can restart the engine's job service, which stops the tasks it holds), then check that an eleventh task in one chat is queued rather than refused.
- **The start reply and its milestone notices** (`feat/live-agent-view`, slice 2 of [`live-agent-view.md`](live-agent-view.md); the README's Background tasks section).
  Every sentence the chat shows about a task before its result is written by code, and no model writes any of it.
  The replies, the lines of the wait and the notices are in `reply-words.js`, and what they quote comes from where it arises: the router's own lines (`adapter.js` `line()`, which fill the wait's block and are a moved notice's body), why a read pass handed a task back (`router.js`) and why a message Laya could not sort runs as a task (`index.js`).
  A task queued from the chat gets a start reply instead of the old `Queued → ...` line (`adapter.js` `startReply`, from what `index.js` `orchestrator.enqueue` returns): A names the agent, its model and its effort, with a credit line saying who picked and why that effort, at once for a forced agent and, for a task that starts at once, as soon as the router picks within the wait Settings allows (15 s by default, `orchestrator.watchPlan`); B says where a task that waits stands and why; C says a started task's agent is still being chosen once the wait has passed.
  The reply carries hidden marks: the task by its key (`[jev-job]`), its run once one has begun (`[jev-run]`) and, on A, the agent strip's chain, the picker then the worker by its id, which is what a verdict's attribution reads.
  A reasoning block opens only after 600 ms with nothing to show: `Jev is reading your message (task or question)…` while the message is sorted, then `Queued as jev-4. Choosing the agent (...)` and the router's own lines while the reply waits; Stop there ends the reply only, and the task goes on.
  Milestone notices are engine notice rows (`delivery.js` `notify`), each posted once per kind and routing (`tasks.js` `startedNoticeDue`, `claimNotice`, the saved `progressPosted`): `jev-5 started: ...` for a task whose reply named no plan, `jev-4 started again as work that writes` after a read pass handed it back, `jev-2: effort max instead of high` when a forced agent starts at another effort than its reply named, and `jev-4 moved to Codex` for a retry on another agent.
  A change of plan that names another agent than the reply did (`jev-4: Codex instead of Claude Code`, with the hard fact that moved the work) cannot arise in this build, since a reply names a forced agent's plan, which routing never moves, or the pick it waited for; it comes with the replies that predict the pick (slice 9).
  A reply that never said what it named (stopped in its wait) is taken, the wait and 5 s after its task was queued, to have named nothing, so the started notice still comes.
  When its work moves to another agent before then, it is taken so at that moment, so the started notice names the agent the work started on and comes before the moved notice; a task's notices go out in the order they were claimed.
  Settings, Jev setup, Chat replies sets the wait (0 to 60 s) and `Progress in chat` (Milestones, or Start and result only, when no notice is posted and B and C promise only the result), in `chat-replies.json` through `GET` and `POST /jev-router/chat-replies/settings`; `askWhenWrong` is kept there for slice 6.
  The result's head reads `Agent: Claude Code · claude-opus-4-1 · effort high · took 7 min`, and a question answered directly is told what the chat's tasks are doing now, with the milestone notices left out of what its chat model is sent.
  Deliberate changes to what existed, and to the tests that held it: the chat no longer shows the `Queued → ...` line (`queuedLine` stays, though no caller of it is left, since an orchestrator that answers a bare line with no task key gets that line back as it is), so `test/laya-integration.test.js` reads the start replies in its assertions and its harness keeps notices apart from results (`world.notices`), and the source check in `test/tasks.test.js` reads the reply's new wait line; `agentsMark`, `RUN_MARK` and `withRunMark` moved into `reply-words.js` and are exported from `router.js` and `index.js` as before; and a Like or Dislike given on a start reply is now attributed to the worker its strip names and bound to its run once that run has ended (slice 6 makes it a verdict on the pick).
  The review of slice 2 made the task list's model and effort the work's own, where they were the last attempt's of any role, so a reviewed task showed its reviewer's model and effort beside its worker, and a local model the level the task was queued at; the effort now shows from the moment the working attempt starts, and the result's head reads the same fields.
  A second review of slice 2 stopped the chat naming an agent for a run the router stops for a person (`human_required` at the decider's bar): that `routed` event carries `stopsForPerson` and no `primary`, the task keeps no plan, and the reply waits on for the task's end, so it reads `**jev-4** ended before Jev picked its agent (Needs input). ...` and no started notice follows.
  It also made the `again` notice say why the read pass went back: `needed to change files` only when the hand-back says the work does (`changesFiles`, from an agent's `NEEDS-WRITE-ACCESS` or a routing that named work that may change files), else `could not run locked against writing (<the router's reason>)`.
  And a task queued after a direct answer says `Read only: ...` again after its first sentence, as the old queued line did, when it is judged read only.
  A third review of slice 2 made six more fixes.
  A reply stopped in its wait whose work moved to another agent before its guard fired got its started notice after the moved notice, naming the agent the work had left; it now comes first (`index.js` `heard`, `inTurn`).
  A pick that gives the work to a tool named, in its credit, the effort of the agent that takes over only if the tool fails; it names none now.
  The reply said `If the local model can't finish it, a stronger agent takes over.` for a LOCAL_FIRST strategy whose local step a swap had given to the routed resource; the plan now says `localFirst` only when a local model works in front of the routed resource, which takes over if it fails, as `router.js` `promisedHandOver` reads it (`tasks.js` `planOf`).
  A run the router stops for a person took the agent its routing would have picked, so its result's head named that agent and the effort it was queued at; it now takes none, and a routed task shows no effort until its working attempt starts, so a task stopped before its first attempt names none either.
  The router's line for a routing that stops for a person, which fills the reply's block once it opens, read `Routed to <agent> (jev)`; it now reads `Jev read this as needing a person: no agent runs`, wherever the router's lines show.
  C, and the reply that a task ended before its pick, carry the run the task has begun by the time they are written (`orchestrator.runOf`); C carried none before, since the run id was read as the task was queued, before a task that starts at once reaches its run.
  `index.js` no longer works out a reason for a change of plan that names another agent (`movedWhy`), since no such change can arise in this build; a retry on another agent gets the moved notice, with the router's own lines for why.
  Its tests: the guard timer for a waiting task whose reply B is dropped before it goes out (which fails on a copy of `index.js` arming it only for a task that starts at once), the router's own lines in the wait's block (which fail on a copy whose `watchPlan` tells `onLine` nothing, or whose adapter drops what it heard), and one for each of the three fixes.
  The third review added a test for each of its fixes, each failing on the code before it, and tests of what that code already did, each failing on a copy of it with that removed.
  The guard timer's test now also checks that the task queued first gets no notice, which fails on a copy of `index.js` whose guard notes an ack over one the reply already noted.
  The test of a task in an idle folder now holds the task behind it a second and a half, so its started notice says `It waited N s for the folder.`, which fails on a copy of `index.js` whose `waitedForOf` returns null or swaps the folder and the slot.
  Three `test/laya-integration.test.js` tests read the credit's words through `index.js`: an effort from the model menu, the Settings default or the agent's own setting, a pick the routing rules made when Jev could not, and a pick your feedback moved; they fail on copies of `index.js` whose `follow()` drops the menu's effort, whose `planned()` reads no effort settings, no `movedOff` or no `reason`, or whose `pickedBy` has no fallback branch.
  Two harness seams came with them: `test/laya-integration.test.js`'s `plugin()` takes `replies`, as `test/speed-routes.test.js`'s does, and its fake Jev fails the calls `jev.refuses` names.
  Its tests read two more things from their harnesses: the messages the chat model of `test/laya-integration.test.js` is sent, and, in `test/speed-routes.test.js`, the chat's adapter, for a test that reads a reply's chunks itself.
  A fourth review of slice 2 made one fix, and added tests of what the code already did.
  A forced agent (its own row in the model menu) has its agent and the level it was queued at on its record from the moment it is queued, so one that ended before its first working attempt (removed from the line, refused before it was routed, or stopped in line by a restart) named that level in its result's head, as `Agent: DeepSeek agent · effort medium`, although nothing ran at it and reply A may have named another (DeepSeek at medium starts at high).
  A task now keeps no effort once it ends before its working attempt starts, as it settles and as a restart stops it (`tasks.js` `settle` and `reconcile`, from the saved `workStarted`), so its row and its result's head name none; a waiting row still shows the level it was queued at.
  Its test, `a forced agent that ends before its working attempt starts names no effort in its row or its result, ...` in `test/tasks.test.js`, fails on the code before it.
  The tests of what the code already did each fail on a copy of it with that removed.
  `with Start and result only saved, ...` in `test/speed-routes.test.js` checked its first reply for a word reply A never holds; that reply is now C, read whole, and the test fails on a copy of `index.js` whose `enqueue` returns no `progress`.
  `a task's notices go out in the order they were claimed: ...` in `test/laya-integration.test.js` has the chat refuse the started notice once, so it goes out a second later on its retry, before the moved notice claimed after it; it fails on a copy of `index.js` whose `inTurn` does not wait for the notices claimed before.
  `a retry on the agent the work is already on gets no moved notice` fails on a copy of `index.js` whose `heard` takes any retry for a move.
  `reply A's credit says the routing rules picked when Jev's routing calls failed and the routing domains filled in without them, as the strip under it does, never Jev and never that no Jev call was made` (so named since the sixth review below, whose credit fix it now holds as well) fails on a copy of `index.js` that counts only an answered call (`jev`) as a call, and not a failed one (`decider-error`).
  `Jev setup shows the Chat replies card, ...` in `test/laya-card.test.js` runs the card on the Jev setup page behind the settings route, and fails on a copy of `client.js` whose Jev setup page leaves the card out, or whose wait row posts its value as a string, which the route refuses; `client.js` exports `ChatRepliesCard` through `__test` for it.
  One more harness seam came with them: the chat of `test/laya-integration.test.js` refuses a message for which `world.refuseAppend` returns true.
  A fifth review of slice 2 made four fixes, corrected two lines of the README, and added tests of what the code already did.
  A task whose plan keeps a local model in front of the routed resource (LOCAL_FIRST) named the routed resource from its pick until the local model's attempt started after the baseline checks, which can take minutes, so its row, what a direct answer is told and a result stopped in that time named an agent that never ran and that its reply did not name; `tasks.js` `applyEvent` now takes the agent from the plan's worker (`primary.agent`), as `planOf` does.
  A direct answer was told that Jev or Laya was choosing the agent of a task still starting on an agent the person had picked; it is now told the task is starting on that agent (`reply-words.js` `liveStatusSentence`).
  A read pass's hand-back dropped the agent a forced task was queued for, although its pass that writes runs on that agent too, so its row read `Jev picks` while it waited and a direct answer was told Jev was choosing while it started; the hand-back now keeps it, as it keeps the level the task was queued at (`tasks.js` `askedAgent`).
  A tool that did the work was named by the id the task list keeps, `Agent: tool:lint`, in its result's head and in what a direct answer is told; it is now named as its start reply named it, `the lint tool` (`reply-words.js` `workerWords`).
  The README said no notice names another agent than the reply did, which the moved notice does; it now says so of a change of plan alone, as the design does, and its strip example names the model Jev answered from, as `router.js` `routerStep` writes it (`Jev (jev-1.13.0) → claude (...)`).
  Its tests of the fixes each fail on the code before them: `a task whose plan keeps a local model in front of the routed resource names that local model from the pick on, ...` in `test/tasks.test.js`, `a task sent to an agent you picked keeps that agent when its read pass hands it back, ...` in `test/read-lane.test.js`, and two goldens in `test/reply-words.test.js`.
  The tests of what the code already did each fail on a copy of it with that removed.
  `a pick that lands after the guard's grace but within the reply's wait gets reply A and no started notice: ...` in `test/laya-integration.test.js` has Jev answer each call 400 ms late under a 100 ms grace, and fails on a copy of `index.js` whose guard waits only the grace, not the reply's wait.
  `reply A for a forced agent names the effort it starts at and where it came from: ...` in the same file sends DeepSeek agent's own row at a menu effort, under a Settings default and under a setting for the agent, and fails on copies of `index.js` whose `forcedPlanOf` passes no menu effort to `plannedEffort`, reads no effort settings, or credits Auto.
  `reply A carries the agent strip of the pick it names: ...` in the same file reads the strip of a Jev pick and of a Laya pick, and fails on a copy of `index.js` whose `planned()` leaves `routerStep` out; `reply A carries the agent strip the orchestrator works out for the pick, ...` in `test/adapter.test.js` fails on a copy of `adapter.js` that ignores the steps `watchPlan` gives and makes its own, whose fallback is now marked as the one for an orchestrator that gives none.
  The two tests that a message Laya could not sort says why it runs as a task, in `test/laya-integration.test.js` and `test/adapter.test.js`, are with the guards in item 4 above; a golden in `test/reply-words.test.js` holds where B and C say it, and fails on copies of `reply-words.js` whose B or C leaves it out.
  One more harness seam came with them: a test in `test/laya-integration.test.js` slows the fake Jev by wrapping `TypeSafeClient.prototype.systemOne` itself, and puts it back when it ends.
  A sixth review of slice 2 made two fixes, said in the README when the task list shows a task's model, and added a test of what the code already did.
  Reply A's credit gave Jev the pick when every Jev routing call had failed and the routing domains had filled in by their rules under adaptive routing, as shipped, so it read `Picked by Jev in under 0.1 s: test work, medium risk, so effort high.` above a strip that read `Routing rules → deepseek (deepseek-flash, high)`.
  The credit now names who the strip names (`router.js` `pickedBy`, which reads `routedBy` as `routerStep` does), with the last failed call's error as the reason (`index.js` `heard`): `Picked by the routing rules in under 0.1 s, since Jev could not pick (Error: 503 Service Unavailable); effort high (Auto in Settings).`
  A pick the local router made after such a call reads `Picked on this PC in 0.4 s, since Jev could not pick (...): ...`, and never `no Jev call`, which is said only when no call was made.
  A start reply written after a read pass handed its task back carried no run mark, although the task's run had begun, so a Like or Dislike on it fell back to whichever run of the chat had ended last, which can be an earlier task's.
  B or C written then now carries the run the task is on by then (`orchestrator.runOf`), as C at the bound does: the pass that writes, when it starts at once, else the read pass, which ended before its pick and has no history row, so a verdict on the reply relabels no run and credits nothing.
  Its tests of the fixes each fail on the code before them.
  `reply A's credit says the routing rules picked when Jev's routing calls failed ...` in `test/laya-integration.test.js` now expects that wording and checks the strip's first step, with `who decided a routing is one rule for the agent strip's router step and a start reply's credit: ...` in `test/router.test.js`, `reply A credits the pick to whoever the orchestrator says made it, ...` in `test/adapter.test.js`, which also fails on a copy of `adapter.js` that does not pass `called` to the credit, and a golden in `test/reply-words.test.js`.
  `a start reply written after a read pass handed its task back carries the run the task is on by then: ...` in `test/adapter.test.js` holds B and C, and `a read task handed back before its pick in a free folder is told it starts again as work that writes, naming the run of its pass that writes, ...` in `test/laya-integration.test.js` reads the run from its history row; the B test beside it, now `a read task handed back before its pick is told it waits for its folder like work that writes, naming the run of its read pass, ...`, sends a Dislike with that run and sees no routing sample relabelled, which a Dislike with no run named relabels.
  The test of what the code already did fails on a copy of it with that removed: `a task run with a parallel opinion names its worker with the worker's own model and effort in its row and its result head, never the opinion's agent, model or effort` in `test/delivery.test.js` emits a parallel opinion as `router.js` does, the opinion's end before the primary's, and fails on a copy of `tasks.js` whose `WORK_ROLES` holds `opinion`, where the row names the opinion's agent and takes its model.
  The README said the task's row in the Background tab then shows the model reply A named, and the owner check below asked for it, but the row names the model only once the working attempt has ended, since only the attempt's end records the model it ran (`tasks.js` `applyEvent`); both now say so.
  A seventh review of slice 2 made one fix, let the moved notice listen only for what can reach it, and added tests of what the code already did.
  The Chat replies card (Settings, Jev setup) said Milestones add a notice only when a task starts on an agent its reply did not name, although they also post a start at another effort than its reply named, a start again as work that writes once its read pass hands it back, and a move to another agent on a retry; it now names all four, as the README's Milestone notices list does.
  Its test, `the Chat replies card says what Milestones post: ...` in `test/laya-card.test.js`, fails on the code before it.
  `index.js` counted a gate, a capability and a stall among the events whose lines say why a retry went to another agent (`MOVE_CAUSES`), and the design named a gate among them, but none of those can reach a moved notice: a gate or a capability moves the work while it is routed, before the `routed` that clears the list, and a stall ends the run.
  The list now holds a usage limit, a change in a metered key's balance and a review, and the design says so; what the notice says is unchanged.
  The tests of what the code already did each fail on a copy of it with that removed.
  Every moved notice test before them had a usage limit for its cause, so no test failed on a copy of `index.js` whose `MOVE_CAUSES` held `limit` alone; both of them do.
  `a retry Jev's review sends to another agent gets one moved notice whose body says why: ...` in `test/laya-integration.test.js` has Jev's review send DeepSeek's first answer to another resource (`RETRY_DIFFERENT_RESOURCE`), and fails on a copy of `index.js` whose `MOVE_CAUSES` leaves out `review`.
  `a retry on another agent after DeepSeek's credit falls under its floor gets one moved notice whose body says why: ...` in the same file has DeepSeek's key spent under its floor by its first attempt, so its body holds the balance's line and the limit's before the retry's, and fails on a copy whose `MOVE_CAUSES` leaves out `balance`.
  An eighth review of slice 2 made one fix, corrected the design's bound on notices per task, and added tests of what the code already did.
  The moved notice's body gave every usage limit, every change in a metered key's balance and every review since the last work attempt as a reason for the move, so a key that only ran low (`deepseek credit 21 USD: low, working in small steps and keeping the handoff current`), Jev's own key switched during its review, a parallel opinion's limit or a reviewer's were named as why the work moved, though none of them moved it.
  `index.js` `heard` now keeps only what sends the work elsewhere (`movesWork`): a review, and a usage limit of the agent whose step it was, the work's or the plan's before it, with that agent's balance falling under its floor before it; the design says so.
  The agent whose step it was (`stepAgent`) is the work's from the start of each work attempt and the planner's from the start of a plan step, so a planner's limit that sends the work to another agent is still among them, as it was before; no test reaches `heard` with a plan step, since no test that runs the whole plugin has agents that make the plan-first strategy eligible.
  Its tests each fail on the code before it.
  `a retry Jev's review sends to another agent after DeepSeek's credit only ran low gets a moved notice whose body is the review's line, then the retry's: ...` in `test/laya-integration.test.js` spends DeepSeek's key from 50 to 21, under the 22 at which it works in small steps and over its floor of 20, and fails on a copy of `index.js` whose `movesWork` takes a balance in any state.
  `a retry Jev's review sends to another agent after Jev switched its own key in the review gets a moved notice whose body is the review's line, then the retry's: ...` in the same file has the review's first call on Jev's key j1 meet a 429, so Jev goes on with j2, and fails on a copy whose `movesWork` takes a limit of any agent.
  The tests of what the code already did each fail on a copy of it with that removed.
  `a retry Jev's review keeps on DeepSeek and then sends to another agent gets one moved notice whose body holds only the review since the attempt before it, ...` in the same file holds the design's "since the previous attempt", and fails on a copy of `index.js` whose `heard` keeps the causes over the start of a work attempt (`Object.assign(f, { workAgent: e.agent, stepAgent: e.agent })`), where the body also holds the review that kept the work on DeepSeek.
  `a task whose work moves twice in one routing gets one moved notice, for its first move: ...` in the same file fails on a copy of `index.js` whose `moved()` claims no notice (`tasks.claimNotice(f.key, 'moved')`), where the chat also gets `jev-1 moved to DeepSeek agent`.
  The seventh review's `MOVE_CAUSES` is now `movesWork`, and its two tests fail on copies of `index.js` whose `movesWork` leaves out a review, or a balance under its floor.
  Two guards of the rule that a task judged read only that no agent can lock, waiting only for a free slot, is never said to wait for its folder are with item 4 above.
  The design's risks said a task gets at most three short notices, but one notice of each kind per routing gives a read task whose read pass is handed back after its pick a started notice and a moved notice in that pass, and a started again and a moved notice in the pass that writes, four in all.
  The code keeps that rule, since a cap of three would drop the move of the pass that writes, and the design now says at most two per routing, so at most two besides the result, and four for such a read task.
  The README now says which lines the moved notice gives for why, and that a later move in the same routing posts none.
  Known limits: the started notice points at the work board, since the Live tab comes with slice 4; a pick made in the last moments of the wait can still be answered as C, with the started notice after it.
  B written as its task is queued comes before its task's run begins, so it carries no run mark, and a Like or Dislike on it falls back, as one on an answer from before the mark does, to the last run of the chat that had ended, until slice 6 binds a verdict to its task.
  A verdict on B or C written after a read pass handed its task back is about the run it names, so one on B, which names the read pass, counts for nothing, not for the pass that writes after it.
  The Background tab's row names a task's model only once its working attempt has ended: while that attempt works, which can take many minutes, it shows the agent and the effort alone, and a task stopped before its first working attempt ended names no model, in its row or its result.
  A forced agent's reply names no plan when its agent list cannot be read at the moment the task is queued: it is B or C, whose words say Jev picks the agent although the person did, and the started notice then names it.
  A task whose work moves to another agent a second time in one routing gets no second moved notice, so the chat's last notice can name an agent the work has since left; its row in the Background tab names the agent it is on.
  All of it is tested with fakes only (the `reply-words`, `adapter`, `tasks`, `delivery`, `read-pass`, `read-lane`, `speed-routes`, `laya-integration`, `replies-card` and `laya-card` test files).
  To verify on the owner's PC:
  - a task in an idle folder gets `OK, I'll run ...` naming the agent, model and effort its row in the Background tab shows once its working attempt has ended (the agent from the pick on, the effort from the attempt's start, and the model only from its end), and the strip under it reads `Jev (<the model Jev answered from>) → <agent id> (<model>, <effort>)`;
  - when Jev's routing calls fail (a Jev key the service refuses, saved for the check and then put back, say), a task's credit reads `Picked by the routing rules in ... s, since Jev could not pick (...)` above a strip that starts `Routing rules`, and never `Picked by Jev`;
  - a forced agent (its own row in the model menu) replies in about a second, and a task queued behind another gets B and then one `started` notice;
  - with the wait set to 5 s, a pick that takes longer gets C and then one notice, and Stop during the wait leaves the task running and still brings one notice;
  - no result is marked read before it posts (the work board's `Unread result` clears only once the result's row appears), and no notice changes the unread count;
  - `how is it going?` while a task runs is answered with that task, its agent and its last line;
  - with a local model installed, a task the router gives it first (LOCAL_FIRST, its reply saying a stronger agent takes over) shows that local model in its row and in `how is it going?` from the pick on, through the baseline checks, and the agent behind it only once that agent takes over;
  - `Start and result only` posts no notice, and the replies then promise only the result;
  - a task Jev reads as needing a person (`deploy this to production with my AWS keys`) is answered that it ended (Needs input), names no agent, in its text or in the block of its wait, and brings no started notice, and its result's head reads `Agent: Jev picks`;
  - the real Jev and Laya pick times against the 15 s default (live-agent-view.md 5.2 item 6).
- **The learning clock, in shadow** (`feat/live-agent-view`, slice 3 of [`live-agent-view.md`](live-agent-view.md); the README's How Jev replies paragraph under Background tasks, and its It learns section).
  Nothing the slice adds changes a reply until the message intent earns a rung that decides on this PC, and then only for a message its local classifier is sure is a task: Jev is not asked about that message, so it gets no read-only verdict, runs as work that writes and its reply has no `Read only` sentence.
  Everything else the slice adds learns or shows what it learned, and decides nothing.
  The message intent is a routing domain of its own, `intent` (`routing-policy.js` `DOMAINS`, LOW risk), so the Router tab lists it with its rung.
  Its local classifier may only ever decide `task` (`localLabels`), and it needs verified samples of task and of question before a local rung, 100 of each with the shipped gates (`requiredClasses`); `domains.js` holds both whatever a caller passes, and `resolvePolicy` refuses a policy that lets the classifier decide more than `task` or drops task or question from the classes its local rungs wait for.
  How many of each a rung waits for is `routing.gates.LOW.perClassSamples`, which a policy sets for every LOW domain, so a policy that sets it to 0 lets the domain climb on tasks alone, to decide nothing but `task` all the same.
  On the Jev rows, `index.js` `classify` goes through `intent.js` `classifyIntent`: the domain records each message as a sample with Jev's answer as the teacher's, Jev still decides at JEV_PRIMARY and SHADOW and is asked once per message as before, and the answer carries the sample's id (`intentSample`).
  The task and its run keep that id, so its history record does, and a direct answer ends with it as a hidden mark, `[jev-intent]: kzh-intent-1-<id>`; work queued behind a direct answer carries none.
  Offline mode, a dead network, Laya Auto, adaptive routing off and learning off record no sample.
  A finished run labels the sample (`training.js` `labelIntent`), and the labels a person's word gives are read already, though nothing gives them before slice 6.
  The reply ledger (`reply-ledger.js`, `reply-ledger.jsonl`) keeps a row per task queued from the chat: what its start reply named, how, and how long after the task was queued; what the router ran from its first routing; and the guess of a predictor of the pick, scored against what ran.
  The predictor (`reply-model.json`) trains in a worker thread once 60 tasks routing picked for are on record, and again after every 25 more, and a start with that many on record and none saved trains one as it first reads them; no reply reads it.
  Settings, Jev setup, How Jev replies shows all of it, from `GET /jev-router/replies/summary`.
  Deliberate changes to what existed: on the Jev rows with adaptive routing and learning on, `classify` asks Jev through the intent domain, and a Jev error still makes the message a task, as before; `learnFrom` passes over a sample whose domain is not the one it was listed under; the read-lock check in `orchestrator.enqueue` moved into `pickableNow`, which the ledger reads too; reply C at the bound notes `bound` with its ack, and Jev's store is read as the plugin starts wherever the intent domain is used (both from the second review); the build changed no existing test, and the second review changed one from before the slice, `watchPlan never resolving with waitMs 100: ...` in `test/adapter.test.js`, whose replies at the bound now note `bound`.
  The review of slice 3 made four fixes, corrected what the slice said of the message intent and of the domains, and added tests of what the code already did.
  A start reply that named a tool the router gave the work to was kept in the reply ledger as naming the agent that takes over only if the tool fails, with that agent's effort and model, so the card's Recent replies read `Claude Code · claude-opus-4-1 · effort high` beside `the lint tool`, and the verdicts of slice 6, which read what a reply said, would have read it too; it is kept now as naming the tool (`tool:lint`), as what ran is (`index.js` `noteSaid`).
  The How Jev replies card did not read `learning: false`, so with learning off it promised the predictor would start once 60 routed tasks were on record, which never come, said no reply waited for a pick this week, and showed a record from before as current; it now says nothing there learns: start replies are not timed, the prediction is off, and no start reply is recorded (`client.js` `howJevRepliesWhy` and `howJevRepliesLines`).
  The reply ledger took a file it could not read (any error but `ENOENT`, such as `EBUSY` while a scanner holds it on Windows) for an empty one, and its compaction then rewrote the file with only the rows noted since, losing its history and the predictor's scored record; it now never rewrites such a file, appends to it, and the next start that reads it has every row (`reply-ledger.js` `unread`, as `training.js` has it).
  After a rewrite whose rename kept failing, as it does while a reader holds the file on Windows, the ledger rewrote and fsynced the whole file on every later write, three or four a task, logging each failure; it now tries again once another slack of lines has been appended (`failedAt`).
  The card, the README and this entry said nothing learned here changes a reply yet, and this entry that the intent domain cannot reach a local rung before slice 6; but a run routed as an answer that changed no file verifies `question`, so the domain can earn GUARDED_LOCAL, and a message it is then sure is a task gets no Jev call and so no read-only verdict, and runs as work that writes.
  The code is as the design asks, so the card, the README and this entry now say what changes a reply and when.
  The docs index, item 1 of "For the desktop agent" and "Watch the adaptive router in the running app" in "Open work an agent can do" said the Router tab lists seven routing domains; it lists eight, the message intent among them.
  The title of `no policy lets the intent classifier decide a question, ...` in `test/policy.test.js` said no policy lets it reach a rung that decides without both classes, and this entry that it needs 100 of each, though a policy sets how many (`perClassSamples`); the title now names what its body holds, and the entry says how many and where they are set.
  Its tests of the fixes each fail on the code before them.
  `the reply ledger keeps a pick that gives the work to a tool as the tool its start reply named, ...` in `test/laya-integration.test.js` has Jev route a task to a `fixer` tool, where the code before it kept `deepseek`, `high` and `deepseek-flash` as what the reply said.
  `with learning off the How Jev replies card says nothing here learns: ...` and `the How Jev replies card says the guess at the agent changes no reply yet, ...` in `test/laya-card.test.js` read the card behind a stubbed summary, with learning off and at GUARDED_LOCAL; `client.js` exports `howJevRepliesWhy` through `__test`.
  `a file the ledger could not read is never rewritten, ...` and `a rewrite that fails, as the rename does while a reader holds the file on Windows, ...` in `test/reply-ledger.test.js` swap `readFile` and `rename` in `node:fs/promises`, as `test/training.test.js` does.
  The tests of what the code already did each fail on a copy of it with that removed.
  `the reply ledger keeps how each start reply came to name what it named: ...` in `test/laya-integration.test.js` reads through `index.js` a reply that waited for its pick, one that waited its turn, and one for an agent picked in the model menu, with the summary's timing and its count of rows the predictor learns from; it fails on copies of `index.js` whose `enqueue` notes `forced: false`, whose `noteSaid` has no `forced` branch, or whose `noteSaid` takes a reply that named no plan for one that waited for routing.
  `whatever a domain lets its local classifier decide, a local decision is a task: ...` in `test/intent.test.js` hands `classifyIntent` a domain whose own lock let a local `question` decide, and fails on a copy of `intent.js` whose local decision takes the domain's label.
  The review left one thing as it was: `learnFrom`'s check that a sample's domain is the one it was listed under has no test, since every listing the plugin makes names a sample its own domain recorded under a fresh id, so only a damaged store or record reaches it.
  The second review of slice 3 made six fixes and added a test of what the code already did.
  In the No project space and the scratch workspace, where a task is refused, a local rung of the message intent could decide that a question was a task, which was then refused (`This is the **No project** space, so no agent can work on files here.`) rather than answered, every time it was sent; `classify` is now told the folder a message was sent in (`cwd`), and where no task can run `classifyIntent` passes `localMayDecide: false`, so Jev reads every message there, as before the slice (`index.js` `tasksRunIn`, `intent.js`, `adapter.js`).
  With adaptive routing off and learning on, the How Jev replies card opened by saying task or question learns, and the line below it that nothing is learned from it; it now opens by saying only the guess at the agent learns (`client.js` `howJevRepliesWhy`).
  A retrained predictor whose save the disk refused, as a rename over `reply-model.json` is refused while a reader holds it on Windows, was thrown away and logged as not trained, so no guess was made until 25 more tasks were routed; the save is now tried again over about a tenth of a second and, if it still fails, logged as not saved, and the predictor is used all the same, as a routing domain's is (`reply-ledger.js` `maybeRetrain` and `whileHeld`).
  The card's median of start replies left out every reply whose wait for the pick ran out, so with routing slower than the wait it said `none waited for a pick this week` of replies that had each waited the whole wait, and with the wait set to Reply at once it still said `after routing`; such a reply now notes `bound` with its ack, the median times it with the replies that named the pick, the line says how many ran out, ends `none timed this week` when none was timed, and with the wait at 0 reads `Start replies: at once, without waiting for the pick (Reply at once, in Chat replies)` (`adapter.js`, `index.js` `noteSaid` and `repliesSummary`, `reply-ledger.js` `ledgerSummary`, `client.js` `howJevRepliesLines`).
  At a local rung the card gave task or question's accuracy with `(needs 94%)`, the bar it climbed past, which is not what keeps it there, so at 93% it read as failing a need while the domain kept its rung; there the line now gives the accuracy alone (`client.js` `howJevRepliesLines`).
  Since every message on a Jev row records its intent sample before it is answered, the first question after a start waited for Jev's store to be read and parsed whole, about a second on 8,000 samples and four on 30,000, where before the slice a question never touched the store; it is now read as the plugin starts, in the background, wherever the intent domain is used (`index.js`).
  Its tests of the fixes each fail on the code before them.
  `where no task can run, in No project and the scratch workspace, ...` in `test/laya-integration.test.js` seeds the intent domain at LOCAL_ONLY with a classifier sure that `How do I center a div?` is a task, with `where no task can run the local classifier decides nothing: ...` in `test/intent.test.js` and `the intent call is told the folder the message was sent in, ...` in `test/adapter.test.js`.
  `with adaptive routing off the How Jev replies card opens by saying only the guess at the agent learns, ...` and `at a rung where task or question is read on this PC, ...` in `test/laya-card.test.js` read the card behind a stubbed summary.
  `a predictor the disk refuses to save, ...` in `test/reply-ledger.test.js` swaps `renameSync` in `node:fs`, which `classifier.js` saves through.
  `a start reply whose wait for the pick runs out is kept as such and timed with the replies that named the pick, ...` in `test/laya-integration.test.js` has Jev's routing take a second against a wait of 0.3 s, with tests of the same in `test/adapter.test.js`, `test/reply-ledger.test.js` and `test/laya-card.test.js`.
  `Jev's routing samples are read as the plugin starts, ...` in `test/laya-integration.test.js` counts the reads of `routing-samples.jsonl` through a swapped `readFile`.
  The test of what the code already did fails on copies of it with that removed: `a trained reply predictor guesses as a task is queued, ...` in `test/laya-integration.test.js` saves a predictor in the data folder before the plugin starts, and fails on copies of `index.js` whose `noteQueued` records `predicted` as null or hands the predictor an empty list of available agents, whose `noteRan` drops `level`, or whose ledger is given `replyGates({})`; before it, no plugin test had a trained predictor, so each of those copies passed every test, and `the reply ledger keeps what a Jev Auto start reply named ...` now reads `ran.level` too.
  Besides the test from before the slice named above, three of slice 3's own tests changed on purpose: `the How Jev replies card renders the gate figures from a stubbed /replies/summary` and `the How Jev replies card says the guess at the agent changes no reply yet, ...` in `test/laya-card.test.js` expect `none timed this week` and no `(needs 94%)` at GUARDED_LOCAL, and `the summary: ...` in `test/reply-ledger.test.js` expects `atBound: 0`.
  The third review of slice 3 made three fixes and added tests of what the code already did.
  The How Jev replies card rounded the recent accuracy of task or question to a whole percent, so 211 right of the last 225 (93.8%) read `94% right of the last 225 checked (needs 94%)` while `domains.js` held the share itself under the bar and the domain stayed at SHADOW; the accuracy is now cut down, never rounded up, to the decimals its bar is set to, and a bar set between two whole percents is given as set (`client.js` `percentsAgainst`).
  The card's Recent replies said `not routed yet` of a task that had ended before routing picked anything, stopped as it waited or read as needing a person once its reply's wait ran out, since such a task never gets `ran`; the summary now gives each reply the final state of its task, read from the task list by key since job ids start again after a restart (`ended`, true once the task has left the list), and the table reads `nothing ran (Stopped)` or `nothing ran (Needs input)` for it and `not routed yet` only while its task is still to run (`index.js` `repliesSummary`, `reply-ledger.js` `ledgerSummary`, `client.js` `recentReplyRows`).
  A start with 60 or more tasks routing picked for on record and no predictor saved, as with `reply-model.json` deleted or never saved, trained none until the next task was routed for, and the card meanwhile read `not trained yet; it starts once 60 routed tasks are on record (70 so far)`, as it also did while a first training ran and after one failed; the ledger now trains one as it is first read, never while learning is off (`learns`), and the summary says whether a training is under way, so the card reads `it is training now` or `its training failed, and it is tried again after 25 more routed tasks` (`reply-ledger.js` `createReplyLedger`, `client.js` `howJevRepliesLines`).
  That one came to the review split: one judge took the wait for the next routed task as the plan, which a code comment and a test of the second review said; the card's line was false all the same, in that state and in the other two, so it was fixed.
  Its tests of the fixes each fail on the code before them.
  `the How Jev replies card never rounds the recent accuracy of task or question up to a bar it misses: ...` in `test/laya-card.test.js` reads 211 right of the last 225 at SHADOW.
  `the summary tells a reply whose task ended before routing picked anything from one whose task is still to be routed: ...` in `test/laya-integration.test.js` stops a task as it waits its turn and clears it from the task list, and has Jev read another as needing a person once its reply's wait ran out; `the How Jev replies card says nothing ran for a reply whose task ended before routing picked anything, ...` in `test/laya-card.test.js` reads the table behind a stubbed summary.
  `a start whose ledger has rows enough and no predictor trained through them, ...` in `test/reply-ledger.test.js` and `the How Jev replies card says a prediction not trained yet is training while its first training runs, ...` in `test/laya-card.test.js` hold the training as the ledger is read, and `with learning off the plugin trains no predictor of the pick from the ledger the card still reads, ...` in `test/laya-integration.test.js` also fails on copies of `index.js` that gives the ledger no `learns` and of `reply-ledger.js` whose retrain ignores it.
  The tests of what the code already did each fail on a copy of it with that removed.
  `the reply ledger keeps the pool each task was picked from: ...` in `test/laya-integration.test.js` fails on copies of `index.js` whose `noteQueued` drops `modalities`, takes the mode, the effort or the decider for `auto`, `auto` and `jev`, keeps an agent that is signed out, leaves out the tools, or keeps a tool switched off; `say` in that file now takes pictures, and the plugin's context gives the attachment store a test sets (`world.attachments`).
  `a ledger given no way to train, as the plugin's is, retrains in a worker thread, and dispose ends a retrain under way: ...` in `test/reply-ledger.test.js` fails on copies of `reply-ledger.js` whose default `train` trains in place or whose `dispose()` does nothing, and so does `the plugin's reply ledger retrains in a worker thread, and closing the plugin ends a retrain under way: ...` in `test/laya-integration.test.js`, which holds the worker's end until the plugin is closed and also fails on a copy of `index.js` that does not dispose of the ledger as the plugin closes; both swap `worker_threads.Worker`.
  `the predictor learns from the newest 500 labelled rows, the oldest four fifths fitted and the newest fifth calibrated, in the order they came, and never balanced, ...` in `test/reply-ledger.test.js` fails on copies of `reply-ledger.js` that read more than 500 rows, balance the classes, fit or calibrate on every row, or shuffle them; with its check of the balancing flag left out it still fails on the balanced copy, whose guess for a failing test is 0.516 sure where four times in five makes it over 0.8.
  `a message's intent sample says whether a picture came with it, ...` in `test/laya-integration.test.js` fails on a copy of `index.js` whose `classify` hands `classifyIntent` no `modalities`, and with `a sample says whether a picture came with the message, ...` in `test/intent.test.js` on a copy of `intent.js` that hands `intentFeatures` none.
  `the summary's Recent replies are its newest ten replies, newest first, ...` in `test/reply-ledger.test.js` fails on copies of `reply-ledger.js` that keep 9, 11 or 1000, or cut before leaving out the tasks with no reply yet.
  One test of the slice changed on purpose: `a predictor the disk refuses to save, ...` in `test/reply-ledger.test.js` expects the start after it to train on the sixty it reads, as it reads them, where it trained on sixty-one once the next task was routed for.
  The fourth review of slice 3 made four fixes and added tests of what the code already did.
  A predictor trained with none of Jev's guesses checked yet said `no guess has been checked yet` beside `Under Laya Auto: right 18 of the last 20 (...)`, as it does for someone who routes on Laya Auto alone; it now says `no guess under Jev Auto has been checked yet` while Laya's guesses have a record, and `no guess has been checked yet` only while neither has (`client.js` `howJevRepliesLines`).
  A start reply that went out at once beside a task that starts at once, C with the wait for the pick set to Reply at once or the sentence of work asked for beside a question answered directly, was kept as `waited`, so with the wait at Reply at once every row of Recent replies read `waited` under a first line saying replies go out without waiting for the pick; its ack now says so, the ledger keeps it as `now`, and the table reads `at once` (`adapter.js`, `index.js` `noteSaid`, `client.js` `REPLY_HOW_WORDS`).
  That one came to the review split: one judge took `waited` for the catch-all the README and `noteSaid` define it as; the word was false beside the card's own first line all the same, as `after routing` was with the wait at 0 until the second review, so it was fixed.
  The reply ledger read a task sent with a picture by the text its agent is sent, which starts with the line that hands the agent the picture's path, so the row's hashed words held folders of this PC and the attachment, and its length and line counts were the line's; the adapter now hands `enqueue` the person's own words beside the task (`message`), and the row reads them, as the message's intent sample does (`adapter.js`, `index.js` `noteQueued`).
  That one came to the review twice, split both times: one judge took the routed text for what a predictor of the router's pick should read, since the router reads it; but the design, `docs/adaptive-routing.md` and the code's own comments say the row holds the message's `intentFeatures`, which hold nothing of the workspace (`features.js`), and the path put the workspace there for pictures alone.
  A ledger disposed of, as the plugin closing or applied again leaves it, still started a retrain when a task of the old plugin noted the row that called for one, or as it first read rows enough: nothing could end that worker, and it saved what it trained to `reply-model.json` behind the plugin that replaced it, even when the change was switching learning off; it now starts none once disposed of (`reply-ledger.js` `dispose`).
  That one came to the review split: one judge found the worker ends by itself in seconds and its save is whole; the save behind the plugin that replaced it and the training with learning switched off were real all the same, and the fix is one flag, as Laya's supervisor has one (`disposed` in `index.js`).
  Its tests of the fixes each fail on the code before them.
  `the How Jev replies card never says no guess has been checked beside a record of Laya's: ...` in `test/laya-card.test.js` reads a predictor trained on Laya Auto's picks alone.
  `a start reply that goes out at once beside a task that starts at once is kept as going out at once, ...` in `test/laya-integration.test.js` also fails on copies of `adapter.js` whose C with no wait or whose `alsoWork` sentence notes no `now`, and of `index.js` whose `noteSaid` ignores it; `the How Jev replies card says a start reply that went out at once ...` in `test/laya-card.test.js` reads the table behind a stubbed summary.
  `the reply ledger reads a task sent with a picture by the person's own words, ...` in `test/laya-integration.test.js` also fails on copies of `index.js` whose `noteQueued` reads the task and of `adapter.js` that hands `enqueue` no `message`; `the person's own words ride beside each task the adapter queues, ...` in `test/adapter.test.js` also fails on a copy whose `alsoWork` enqueue hands none.
  `a ledger disposed of, as the plugin closing or applied again leaves it, starts no retrain after, ...` in `test/reply-ledger.test.js` notes fifty rows after `dispose()`, and reads a ledger disposed of before its first read.
  The tests of what the code already did each fail on a copy of it with that removed.
  `the summary gives the How Jev replies card the message intent's figures as the domain's last evaluation counted them: ...` in `test/laya-integration.test.js` seeds Jev's store with forty checked examples and a classifier trained through the tenth, and fails on copies of `index.js` whose summary gives `verified: 0`, `classes: {}`, `ev.classes` for `ev.classes.counts`, `recent: null` or the whole of `recent`; `the reply ledger keeps what a Jev Auto start reply named ...` now reads the checked examples and those of each class after a run too, and fails on the first three of those copies; before, no test of the plugin read them.
  `a predictor trained through a task the ledger no longer holds, as after reply-ledger.jsonl alone was deleted, ...` in `test/reply-ledger.test.js` fails on a copy of `reply-ledger.js` whose retrain waits for that task to come back (`if (through && (at < 0 || list.length - at - 1 < retrainEvery)) return`), which never trained such a predictor again, though the README says deleting the file is safe.
  `after a restart hands out a job id again, the summary reads each reply's task by its key: ...` in `test/laya-integration.test.js` stops `jev-2` as it waits, starts the plugin again on the same data and queues another `jev-2`, and fails on a copy of `index.js` whose summary looks a task up by job id (`endedOf(tasks.get(r.jobId)?.key ?? null)`), which `the summary tells a reply whose task ended ...` passes, its job ids being new within one run.
  `labelIntent: ...` in `test/training.test.js` now holds a run routed as project work that failed or was handed to a person, and fails on a copy of `training.js` that labels such a run only when it was accepted (`accepted(record) &&`).
  `a trained reply predictor guesses only among the agents routing could pick as the task is queued: ...` in `test/laya-integration.test.js` saves a predictor sure of Claude, switched on and signed out, and fails on a copy of `index.js` whose `noteQueued` hands the predictor no list of agents (`ledger.predict(features)`), which `a trained reply predictor guesses as a task is queued, ...` passes, since every agent its predictor knows is one routing could pick.
  `a replies gate whose right is above its of stops the plugin at start-up with the key's name, ...` in `test/laya-integration.test.js` fails on a copy of `index.js` whose `apply()` falls back to the gates that ship when `replyGates` refuses.
  Those two came to the review split: one judge found each promise held by a test of the function itself, `predictReply` and `replyGates`; a copy of the plugin without the promise passed every test all the same, so each now has a test of the plugin.
  Changed on purpose: `a start reply whose wait for the pick runs out is kept as such ...` in `test/laya-integration.test.js` expects the reply written with the wait set to none as `now`; in `test/adapter.test.js`, `reply C notes that its wait for the pick ran out when it did, ...` and `alsoWork appends C's sentence without waiting` (slice 2) expect such a reply to note `now`, and `a Laya Auto message is sorted by Laya ...` and `a Laya Auto task is routed and queued as Laya's, ...`, both from before the slice, and `a message's intent sample rides its queued task and its run, ...` expect `message` among what the adapter hands `enqueue`, as `while Laya starts the message waits with the Starting line, ...` in `test/layaauto.test.js`, from before the slice, does.
  The review left one thing as it was, which came to it split: Jev's store checks itself against its cap in the append that brings it a slack of rows past the last check, and rewrites and fsyncs the whole file there once it is at its cap, and since a message's intent sample is appended before the message is answered, that message waits for it.
  A routing decision has waited for it the same way since adaptive routing shipped; it comes once every 10,000 rows, about 600 runs, and took about a third of a second for a 36 MB store on the Linux machine the suite ran on; an append that did not wait for it would change when every write of the store resolves, which its own tests hold, so it is a known limit, below.
  The fifth review of slice 3 made two fixes, added tests of what the code already did, and corrected where red-check sees one test fail at `dbdec3d`.
  A start reply that went out once its task had ended was never kept in the reply ledger, since `orchestrator.noteAck` noted it only for a task still waiting or running: routing reads a task as needing a person well within the wait for the pick as it ships, so its reply, `ended before Jev picked its agent (Needs input)`, went out once the task had ended, Recent replies never held it, and `nothing ran (Needs input)` showed only for a task whose routing took longer than the wait.
  The same went for a reply whose wait ended with its task stopped or failed, and for reply A for an agent that refused the task at once, signed out or at its usage limit.
  Such a reply is kept now as any other, and reply A as your pick: the plan it names is kept apart from the task's follow, which is let go as the task settles; read from the follow, it would be kept as a pick the reply waited for, and timed with those (`index.js` `noteAck`, `noteSaid` and `forcedPlans`).
  A reply ledger disposed of, as the plugin applied again leaves it, still rewrote `reply-ledger.jsonl` from what it held once a task of the old plugin noted the line that brought it a slack past that, so every row the plugin that replaced it had appended was gone from the file, and gone for good once the plugin started again; and the live ledger's own rewrite dropped the rows the disposed one appended after the live one read the file.
  A ledger disposed of now only appends, each rewrite reads the file again first and keeps each task's newest line there, and the ledgers of one file append and rewrite it one at a time, so a line appended during a rewrite lands in the file the rewrite leaves (`reply-ledger.js` `fit`, `layOver` and `onFile`).
  Its tests of the fixes each fail on the code before them.
  `a start reply that goes out once its task has ended is kept all the same: ...` in `test/laya-integration.test.js` has Jev read a task as needing a person within the wait as it ships, and holds reply A for a signed-out Claude until its task has failed (`say` in that file now takes `hold`, awaited with each event of a reply); it also fails on a copy of `index.js` that keeps such a reply but reads reply A's plan from the task's follow, which keeps it as `routed`.
  `a ledger disposed of, as the plugin applied again leaves it, rewrites the file no more: ...`, `a rewrite keeps what another ledger appended to the file since this one read it, ...` and `a line another ledger appends while this one rewrites the file goes to the file the rewrite leaves, ...` in `test/reply-ledger.test.js` each also fail on a copy of `reply-ledger.js` without what it holds: the `disposed` check, the read before a rewrite, or the one line of work per file for appends.
  The tests of what the code already did each fail on a copy of it with that removed.
  `the reply ledger keeps what a Jev Auto start reply named ...` in `test/laya-integration.test.js` now reads the effort and the model the reply named and those that ran, in the row and in the summary, and fails on copies of `index.js` whose `noteSaid` keeps no effort or model for a pick the reply waited for, or whose `noteRan` keeps none for what ran; before, a test of the plugin read them only for an agent picked by hand, a reply that named nothing and a tool.
  `the reply ledger keeps the pool each task was picked from: ...` in the same file now reads each row's decider too, and fails on a copy of `index.js` whose `noteQueued` keeps every row as Jev's, where before only the decider the row's features are given was read, so Laya Auto's guesses could have been scored in Jev's record with every test passing.
  `the summary gives the How Jev replies card the bars task or question is held to by the routing policy in force, ...` in the same file starts the plugin with LOW gates that need 600 checked examples, 50 of each class and 94.5% recent accuracy, and fails on a copy of `index.js` whose summary gives the bars that ship.
  That one came to the review split: one judge found the summary reads the policy in force, which it does; a copy giving the bars that ship passed every test all the same, so it now has a test of the plugin, as the fourth review gave `predictReply` and `replyGates` one.
  Item 4 of "Open, and needing the OWNER" above and `live-agent-view.md` said red-check sees `no intent sample is recorded where Jev teaches nothing: ...` fail at `dbdec3d` only on its last line; it fails there at the summary of the plugin with adaptive routing off, which the second review added, and both now say so.
  Known limits: until slice 6 a question answered directly gets no label, so `question` is verified only by a run routed as an answer that changed no file, which makes a local rung slow to reach (750 verified samples, 100 of them questions, and the GUARDED_LOCAL accuracy gates) but does not bar it; once it is reached, a message the classifier is sure is a task runs as the first line of this entry says.
  The card has no ratings line, no `What it changed` lines and no rating column yet: they come with the verdicts on the pick, in slice 6.
  The predictor is trained on every PC that routes 60 tasks, whatever it later earns, at about 5 s of one core for 500 rows on a laptop, in a worker thread.
  About once every 10,000 rows Jev's store takes, about 600 runs, the message whose intent sample brings the store a slack past its last check waits for that check, and once the store is at its cap for the whole file to be rewritten and fsynced: about a third of a second for a 36 MB store on Linux, more for a larger one, and unmeasured on Windows (`training.js` `write`).
  All of it is tested with fakes only (the `domains`, `policy`, `features`, `intent`, `training`, `reply-ledger`, `reply-words`, `adapter`, `laya-integration`, `laya-card` and `routerview` test files).
  To verify on the owner's PC:
  - after a day of use, the Router tab lists `intent` with its samples (Jev decides at its rung), and its verified count rises with tasks that ran and changed files;
  - the How Jev replies card shows the week's median for start replies that waited for the pick, until it came or the wait ran out, with how many ran out, the intent's checked examples by class, and, once 60 tasks routing picked for are on record, the predictor's scored record (`right N of the last M`);
  - `usage.jsonl` shows one Jev row with `phase: intent` per message, and no more decider calls per message than before the update;
  - routing results are unchanged: the same agents and efforts for the same kinds of task as before the update;
  - a question answered directly ends with the hidden `[jev-intent]` mark (in the message's raw text), and its Like and Dislike work as before;
  - with `routing.learn: false` in the jev-router configuration and KzH restarted, the How Jev replies card says nothing there learns and promises no prediction, and `reply-ledger.jsonl` gains no line;
  - nothing stalls while the predictor retrains: watch a reply and the work board when `reply-model.json` is rewritten;
  - the first question on a Jev row after KzH starts is answered as soon as the next, on a PC whose `routing-samples.jsonl` holds thousands of samples;
  - in the No project space every Jev Auto message has its own Jev row with `phase: intent` in `usage.jsonl`, and a question is answered there, never refused as a task;
  - with 60 or more tasks routing picked for on record, deleting `reply-model.json` and restarting KzH has the How Jev replies card say `it is training now` when it is opened, and then the predictor's record, with the file back;
  - a task removed from the Tasks list while it waits its turn reads `nothing ran (Stopped)` under What ran in Recent replies, and one Jev reads as needing a person, with the wait for the pick as it ships, `nothing ran (Needs input)`;
  - with Reply at once in Chat replies, a task sent in an idle folder reads `at once` under How in Recent replies, and one that waits its turn behind it `waited`;
  - on a PC whose `routing-samples.jsonl` is at its cap, tens of megabytes, how long a compaction of it takes on Windows (the file shrinks when one runs, about once every 600 runs): the message whose intent sample brings one waits that long for its answer.
- **Read-only work** (`fix/queue-and-cost`; the README's Read-only work section).
  Nothing of it has run with real agents: `test/read-intake.test.js`, `test/read-lane.test.js` and `test/read-pass.test.js` drive it with fakes only (a fake Jev, fake agents and a fake lock, and the read pass against throwaway git repositories).
  A known limit: links inside a run's folder are not followed, so a writer in a folder of projects that writes through a junction in it into a repository opened where it really lives is not counted beside that repository's read pass, and its change reads as a breach (the README says so).
  To verify on the owner's PC, from `docs/queue-and-cost-findings.md` item 1:
  - plan mode against the owner's own `~/.claude` settings, in a test repository with a long writing task holding the folder: a task judged read only that asks Claude to create a file and run `git stash` changes nothing while it reads, and either its report's lock check says `measured` or it is handed back (`Needs the folder after all`), in which case Remove it before its turn, since as work that writes it really does both (the README's plan-mode row section has the steps);
  - that the patch loader mounts the second `subagent-claude-code` row, so `ctx.subagents.list()` shows `claude-code-readonly`, and that Claude's login, model and `CLAUDE_CODE_EFFORT_LEVEL` reach it;
  - that a plan-mode Claude gives its answer rather than writing a plan, and whether it writes `NEEDS-WRITE-ACCESS`, plain or in Markdown, when asked to change files.
    It cannot leave plan mode by itself: `@deepseek-ai/dsh-subagent-claude-code` 0.1.5-rc.2 starts a plan-mode provider with `disallowedTools: spec.permissionMode === "plan" ? ["AskUserQuestion", "ExitPlanMode"] : ["AskUserQuestion"]` (`lib/index.js:307`, in `claudeQueryOptions`, the options `startClaudeCodeRun` passes to the Claude query);
  - whether plan mode reaches the web;
  - for spawn agents (DeepSeek, API-key and local), that `ctx.tools.get('read', root)` resolves, `ctx.tools.modeFor(root)` is `native`, and the check after the start sees exactly the allow list;
  - Windows git with `GIT_OPTIONAL_LOCKS`, with a writer looping `git add` beside a reader;
  - on Windows, the lock check's handling of a workspace below its repository's top (paths joined onto `git rev-parse --show-toplevel`'s forward-slash real path; the one `git hash-object --stdin-paths` started in the workspace folder, which relies on git reading its input paths from the repository's top; the per-file fallback run from that top), of a submodule opened as its own workspace (`--show-superproject-working-tree`), and of a nested repository it cannot see into, each tested with git on Linux only;
  - on Windows git, KzH's reading of a folder as the review of `fix/queue-and-cost` rewrote it, tested with git 2.43 on Linux only: `git status --porcelain=v2 -z`, one `git hash-object --stdin-paths` for every changed file, `:(top,literal)` pathspecs for `git diff` in batches under 8,000 characters, `diff.autoRefreshIndex=false` on KzH's own diffs, and `.git/config` and the hooks folder compared by content, with linked worktrees related through `--git-common-dir`, and runs related through both spellings of a folder reached through a junction; and that a workspace reached through a junction, a subst drive or typed in another case reads the same files, since `fs.realpath` (native, GetFinalPathNameByHandleW) and a case-blind compare were tested only with symlinks on Linux;
  - that the engine keeps apart two `jev:claude` children of the same parent running at once, a reader and a writer started from one chat, which never happened before;
  - for spawn agents, that no tool call of the child's own layer lands before a failed view check stops it, since the check runs after `start()` has handed the child its prompt;
  - Remove and Stop on a reader waiting for its slot, and on a task waiting again after a hand-back;
  - under Laya Auto, that `readOnly` mostly lands under Laya's 0.9, so tasks wait in the line.
- **The capability benchmark** (docs/benchmark.md step B2, `feat/benchmark` at `5f19588`).
  It has never run a real agent: `plugins/jev-router/test/benchmark-run.test.js` runs stub agents only, with a fake Codex command and the fake llama-server.
  Unconfirmed: that the pinned engine starts Claude Code and Codex in the scratch chat's folder, so the prompt's `Workspace:` line points them at the task folder; that Codex's sandbox and Claude Code's edit permission let them write in the task folder; that neither command-line tool writes files of its own in the scratch root during a task, which the outside-the-folder check would fail the task for; the real spend of 28 tasks per agent; and a local model's tasks at its real window.
  The router's prompt now names the handoff note by its full path in the task folder, so that an agent working from the scratch root keeps it there; that Claude Code and Codex write it at that path, and not relative to their working directory, was tested only with a stub that resolves the path from its parent's folder as a command-line tool would.
  Since the second review of B2 a task folder's git repository is kept outside the scratch root (docs/benchmark.md 3.7), so an agent's own git commands in its folder find no repository; how Claude Code and Codex work in a folder with no repository, and that KzH's git calls with `GIT_DIR` and `GIT_WORK_TREE` behave on Windows as they do on Linux, where the suite ran, are unconfirmed.
  The desktop check is item 11 of "For the desktop agent".
- **`workspace.js` `run()` kills the whole process tree on Linux and macOS** since `d71b76c`, through `local.js` `killTree()`, which walks `ps`.
  Before, a check that ran past its time left its grandchildren running, which in this repository's own suite left looping test processes behind after every run.
  `test/workspace.test.js` proves it on Linux; nobody has run it on macOS, and Windows was not affected, since `taskkill /t` already ended the tree.
- **The speed benchmark** (docs/benchmark.md step B1, `feat/benchmark`).
  It is built and tested against a fake llama-server (`plugins/jev-router/test/fixtures/fake-llama-server.mjs`).
  On 26 Sep it ran against the real llama-server b10964, its Linux CPU build, through `scripts/speed-run.mjs`, with two tiny random-weight test models on a cloud machine with no GPU: both were measured, their readings stood for the next load, and no llama-server was left running (docs/benchmark.md, the status at the top).
  That run confirmed, on a CPU, its reads of `/tokenize` behind the engine's API key, of the `timings` in a streamed `/completion`'s last event, and of `prompt_n` on a prompt served from the cache (at least 1, as llama.cpp reads the last token again); it also found that llama-server's output parser can refuse a `/completion` that is not streamed, so every one is now streamed.
  What is left is the GPU and the real models: nobody has run Benchmark all or `Speed-Run.bat` on the RTX 3080, with the Windows CUDA build, or with Qwen3 8B and Gemma 4 E4B, so the GPU split and their real speeds are unobserved, and `Speed-Run.bat` itself has never run on Windows.
  Nobody has looked at the Local models card's speed lines or the install picker's measured labels either, and the attempt clock that keeps a local agent's wait off its time limit (`router.js` `attemptClock()`) has run only in tests.
  The desktop check is item 10 of "For the desktop agent".
- **Laya Auto and the Laya comparison in Jev Auto** (`feat/laya-auto`).
  Whole runs are tested against a fake `laya.serve`; the real `laya.serve` has answered KzH's real bodies, and whole Jev Auto and Laya Auto runs through the plugin, only on random weights in the cloud, and only on the code from before the final review's fixes (the Laya section above).
  No real Laya weights have answered a KzH question, no GPU has run it, no Windows process handling has been seen, and nobody has looked at the Laya card or the inspector's Laya column.
  The desktop checklist is `laya-auto.md` 9.5.
- **The whole adaptive router** (22 Sep, `feat/adaptive-routing`, audited and fixed 23 Sep). It is
  covered by its own test files (`adaptive`, `classifier`, `decision`, `domains`, `governor`,
  `jev`, `observability`, `policy`, `profiles`, `resources`, `training` under
  `plugins/jev-router/test/`, plus the adaptive-routing cases added to the older `router` file; run
  `node --test` on them for the current count) and driven end to end by `scripts/kzh-routing-demo.mjs`,
  which runs the real policy, adapters, governor, capability registry, decision engine, broker,
  routing loop, training store and maturity ladder with only the agents and Jev stood in for. That
  is a real exercise of the code, but it is not the running app: no KzH start has been watched
  route a task this way, and the inspector's new **Router** tab has never been seen render, for
  the usual reason that a `client.js` change needs an app START. Reference:
  [`adaptive-routing.md`](adaptive-routing.md); what it still does not do is the last section of
  that file, not repeated here.
- **Everything the second pass built** (24 Sep, `fix/roadmap-open-items`, not merged).
  The scrub-before-cut rule, the conservation limit, the samples cap, feedback matched by task type and the Router tab's words for code-decided domains are covered by tests only.
  The resource budget is too: the `local`, `tasks` and `budgetpanel` test files drive the settings, the refusal, the watchdog on its own clock, the thread and `--fit-target` arithmetic, the lanes' cap and the whole settings card, but no real llama-server has been started under a budget, no working set has been read on Windows, and nobody has looked at the page.
- **Live provider quota through the new adapters.** `snapshotResources` reads the same
  `usage.js` numbers the Usage tab has always shown, so the inputs are real, but the normalised
  snapshot (`kind`, `scope`, `rolling`, `resetsAt`, `source`, `confidence`, `fieldSources`) has
  only ever been built from those numbers in tests. Anthropic reports no plan name, so a Claude
  plan is unknown unless `resources.plans` names it, and an unknown plan gets the default
  conservation curve (60% to 85%), not the Max one (70% to 90%). Only `rolling_window` and
  `monetary_budget` limits at scope `account` are ever produced; DeepSeek's `total`, `used` and
  `ratioUsed` are derived from a locally seen high-water mark and labelled so.
- **Jev review, as it really runs.** From `bb66efb` until the 23 Sep fix, every real Jev review
  threw on the check shape jev-review passes (`checks.map` on `{ results, regressed, fixed,
  failing }`) and silently fell back to the deterministic policy; the tests passed because they
  handed over a bare array. Any review seen in that period was the fallback. The fixed path is
  covered by tests only.

- The gemma 4 message transfer (`format.js`).
  No real local call has ever been made, only fake streams.
  Its chunking and fallback paths are unit-tested, and so is keeping the agent chain and the run mark out of the rewrite.
  Its timeout is not: no test sets `timeoutMs`, checks the `AbortSignal` passed to the stream, or runs a stream that outlasts the deadline.
- The orphan-kill path of `Use it here`; only its holder classification was exercised.
- The work-board indicator's LIVE state was rendered from server-shaped data, not a running task.
- The work board's queue view (`fix/queue-and-cost`, `client.js` `WorkBoard`): each live row's own Stop or Remove with its confirmation (`stopOneWords`, `confirmFor`), a waiting row's time in line (`in line 32.0 s`, where it read `starting`) and the line under it with why it waits and the estimate, and Stop all's name and confirmation counting running and waiting tasks apart (`stopAllWords`).
  The Background tab's Remove and its narrower Run next are the same change.
  So are the dialogs that close with a notice when their task starts, ends or goes back to waiting while they are open (`confirmDrift`), Stop all covering only the tasks it named when it opened, the reason `Waiting: a run started from the chat is using this workspace` (`tasks.js` `WAITING.chat`) and the sentences on the slots of Tasks at once under a waiting row (`waits.js` `slotFacts`).
  `test/workboard.test.js` covers the words and `test/observability.test.js` renders the board with a stand-in React; a `client.js` change needs an app START, so none of it has been watched render.
  That focus returns to the row's button when a dialog closes (`client.js` `Confirm`) is to be verified in the app: the stand-in React calls child components in place and never unmounts one, so the effect that gives focus back never runs its cleanup in a test.
- An agent's usage limit on a stored API key (`fix/queue-and-cost`, `index.js` `onLimit`, `accounts.js` `keyInUse`).
  The key marked spent, named on the call's usage row and judged for the agent's availability and balance floors (`usage.js` snapshot) is the DeepSeek key active as the plugin first read `accounts.json` in this process (kept on `globalThis` across plugin reloads), on the reading that DSH reads `DEEPSEEK_API_KEY` from `.env` once at launch (the comment in `accounts.js` `applyActive`); the next usable key is made active for after a restart, the Usage card shows it as `<name> after Restart harness`, and no agent goes on with a new key within the run.
  To verify on the owner's PC: with two DeepSeek keys, a 402 on the first marks only it spent and switches the active key once; the DeepSeek agent stays out until Restart harness; after it, calls go out on the second; and a live config reload (`cordis.patch.yml`) does not take the pending switch for the key in use.
  Other providers' agents use no stored key (nothing passes a `KZ_KEY__<provider>__<name>` value to them), so their limit marks only the agent; whether that is the intended scope of stored keys is the owner's call.
  `Start-KzH.ps1` and `scripts/Install-Harness.ps1` (each with its own `Get-StoredJevKey`) now count the Jev key `accounts.json` marks active, while its `KZ_KEY__jev__<name>` line holds a value, in place of `TYPESAFE_API_KEY`; written without a PowerShell to run them here, so on the owner's PC:
  - first make sure no copy of `TYPESAFE_API_KEY` can reach either script: a copy in `~/.kzh/.env` or the user environment skips both checks (`[Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY','User')` must return nothing; `scripts/Set-TypeSafeKey.ps1` writes that one), and one in the machine environment or in the process that starts KzH skips the launcher's (`...,'Machine')` must return nothing; quit Kz-harness from the tray or the app menu, since closing its window leaves it running with its old environment and Restart harness reuses that; close any terminal opened while it was set);
  - then remove the seeded Jev `default` beside another Jev key, start KzH afresh and re-run the installer: the Kz-harness log should say `Jev key '<name>' (stored in Settings) is in use.` and the installer `Jev key '<name>' present (stored in Settings)`, lines only the new code prints.
  - Also on the owner's PC: closing the Kz-harness window now leaves it running in the tray (`app/main.js` registers its own `window-all-closed` listener), as `main.js` meant since `bb66efb`; before, with no listener, Electron quit the app when its window closed, and the tray's Show could never be reached.
    Show from the tray rebuilds the window on the running harness page (not the start screen) and the Browser tab builds a fresh in-app browser view, since the old one closed with its window; to watch: close the window, Show from the tray, open the Browser tab.
    The first close shows a tray notice, once per Windows user (a `told-still-running` file in the app's user data folder), that Kz-harness is still running and how to quit it.
    Every message that said to close Kz-harness before a rebuild, a speed run, a Laya install or a key change now says to quit it (the app's update line, `Install-Harness.ps1`, `Update-Harness.ps1`, `Set-TypeSafeKey.ps1`, `speed-run.mjs`, `laya/install-cli.mjs`, README, `docs/benchmark.md`, `docs/laya-auto.md`).
    `speed-run.mjs` and `laya/install-cli.mjs` also cover an engine with no app above it, in a `Start-KzH` window or left behind, which has no tray icon: both find what runs with `kzh-running.js` and name the engine's pid (the one listening on 3080, else the engine rather than the npx wrapper above it, and the wrapper only while it is all that runs), saying to close that window or end the pid's process tree in Task Manager; what answers on 3080 and cannot be told from the engine gets the tray advice only when the process list could not be read.
    The speed run settles whatever answers on 3080 and cannot be told from KzH (run as administrator, or tasklist's names alone) before it calls a llama-server or a Laya left behind, since that engine runs its own; the Laya command line lets another program on 3080 be, as the speed run does.
    A load the harness page cancels (ERR_ABORTED, -3: a second reload, or the app loading another page) is no page failure.
    The Laya command line sweeps a Laya an earlier session left before its job, and an install check from a supervisor that never swept sweeps first.
    A sweep leaves alone an install check another live process runs under `install.lock`, and keeps on record (and names, on the card, in the log and to the speed run) a recorded Laya that is alive but cannot be read, most likely run as administrator; the command line runs nothing beside such a Laya.
    Run by hand, the command line reads `~/.kzh/jev-router` when `DSH_HOME` is not set, as KzH does (it read `~/.dsh`).
    Whatever answers on 3080 is another program when its name is not node or its pid cannot be found while no node that could be the engine runs; the advice for what cannot be told from KzH is in short sentences.
    The installer refuses Install, Update, Repair, Remove and Use the newer model beside a Laya the sweep could not check, from the card as from the command line; a lock whose pid another program has taken holds nothing; the speed run says an install at work is running rather than calling its check a leftover; a pid the sweep's own tree kill ended is not named.
    A harness page that crashes or fails to load while the engine runs now leaves the start screen saying the harness is still running, with Retry and no startup checklist (the log window's pill says `running`), and its Retry, or Show from the tray with the window open or closed, opens the page again instead of restarting the engine and ending its tasks.
    The splash only moves forward (the patch lines after a fetch used to put it back on Preparing), `Start-KzH.ps1` prints `Starting the engine.` right before it boots the engine, which moves the splash on in place of the old 2.5 s timer, and a restart's splash starts its steps afresh.
    `test/app-main.test.js` drives `app/main.js` with a fake Electron (Electron's own quit when the last window closes modelled in the test), runs `app/ui/console.js` against a small fake DOM fed the statuses `main.js` sends, and checks that `Start-KzH.ps1` prints its engine line after the patches and before either engine start; the real Electron 44 window, tray notice, start screen and a PowerShell run of the launcher have not been watched.
- The context-row revert and the Overview Markdown (22 Sep). Unit-tested, but a `client.js` change
  needs an app START, so neither half has been watched render.
- **Jev Auto - Online** (22 Sep), the mirror of local-only: Jev still routes, over cloud and
  subscription agents only. `remoteOnly` in `router.js`, `locality: 'hosted'` in `capabilities.js`,
  the row in `adapter.js`. Precedence is the part worth remembering: `offline` and `localOnly` beat
  it, because they say what the machine CAN do while `remoteOnly` only says what it SHOULD prefer,
  so a dead network reports the offline restriction instead of an empty agent pool.
  `test/onlinemode.test.js` covers the filter, both precedence rules, the no-cloud-agent error and
  that `locality: 'hosted'` is actually understood rather than silently ignored. Never observed in
  the running app.

## Verified live in the running app

- Panel toggle hotkeys: left `Ctrl+B`, right `Ctrl+N`, written onto the SHIPPED
  `Collapse/Open sidebar` and `Collapse/Open right sidebar` buttons too, not only KzH's own.
- Right panel default width 24 percent of the window (`DEFAULT_RATIO` in `client.js`).
- Work board at the top of the conversation: the session's background tasks as a checklist,
  header `N/M completed` plus the non-completed terminals named, per-row state, agent, model,
  effort, a ticking timer for running rows, `Stop all` behind the Confirm overlay. Renders nothing
  when the session has no tasks. The header is itself the live indicator and a real button that
  opens the Overview tab.
  What changed since on `fix/queue-and-cost` is built, not verified: see the work board's queue view under Built but NOT observed.
- Overview tab (`kind kz-overview`, order 49) plus `GET /jev-router/history`, returning durable
  run records from `history.jsonl` (capped 200, oldest first, tolerant of a truncated final line).
  Before this, run history lived only in a 20-run in-memory map.
- Feedback: Like/Dislike with tags, a `Why?` line and a `should have been...` picker on every
  assistant response, stored at `<DSH_HOME>/jev-router/feedback.jsonl`, fed into routing.
- Composer history: ArrowUp recalls the previous input, ArrowDown walks forward.
- Left sidebar file tree beside the Workspaces search icon, one level at a time, 400-row cap,
  clicking a file opens it in the right sidebar.
- App shell: the `ELECTRON_RUN_AS_NODE` false-positive startup refusal is fixed.
  On the port-busy screen only the holder classification behind `Use it here` was exercised: `inspectPortHolder` (`app/main.js`) sorts the process on port 3080 into `orphan`, `running` or `foreign`, and the button is shown only for `orphan`.
  What a click then does (stop that process tree and start this app's engine, `useHere`) has never been observed, so it stays under Built but NOT observed.
- `scripts/kzh-ui-test.mjs`: a dependency-free CDP tester that replaces Playwright here.

## Root causes worth keeping

- **A closed plugin still wrote to its data folder.**
  Its cleanup effects stopped Laya, the reply ledger's retrain and the local models, but returned nothing and waited for no write under way, so the last task record (the claim of a result just posted, or a progress line held back half a second, `tasks.jsonl` rewritten whole through `tasks.jsonl.tmp`), Laya's standing, the evaluation pass and what the run taught all landed after `close()` had resolved.
  In the tests that was an `ENOTEMPTY` from the clean-up's `rmSync`, about 1 run in 8 of `reply A's credit says the routing rules picked when Jev could not, and why` under load; in the product it was lost data, since the engine's jobs outlive a reload of the plugin, and the old plugin's rewrite of `tasks.jsonl`, the training stores, the domain states, `known-resources.json` or `laya.json` from what it held could land after the plugin applied again had read and written them.
  Closing now starts no evaluation pass or standing, writes every task record asked for so far and none after (a disposed store claims no result or notice it could not save, so the next start posts that result once), and stops every store that rewrites its file from memory (`dispose()` in `tasks.js`, `training.js`, `domains.js`, `shadow.js`, `laya-sidecar.js` and `createResourceTracker`, as `reply-ledger.js` already had).
  Each cleanup returns a promise that settles once the writes under way have, bounded at 5 s (`inBackground` and `closeWithin` in `index.js`); the shadow's also waits for the row of a call Jev answered that the Laya client's dispose ends, and the ledger's for a row still waiting behind its first read.
  Cordis 4.0.2 to 4.0.4 awaits a cleanup's promise in `_unload` before `_reload`, so the plugin applied again reads the folder only after those writes.
  A run still going in the old plugin (a task, a capability benchmark, a speed benchmark) is not waited for: as it ends it appends its rows and logs, and no store rewrites its file from what the old plugin held.
  So a test that ends with a run of its plugin still going waits for that run first, as `a foreground /auto beside a background task in its workspace waits its turn, ...` in `test/laya-integration.test.js` now does for its task.
  Guards, each failing at `2450bee` by assertion: `a plugin closed as soon as its task's result is posted has written all it will: ...`, `closing waits for the writes under way, ...` and `a plugin applied again keeps the task records it writes: ...` in `test/laya-integration.test.js`; `a tasks store's dispose(), as the plugin closes or is applied again, resolves once every write asked of it before has landed: ...` and `a tasks store disposed of, ... never rewrites tasks.jsonl from what it holds, ...` in `test/tasks.test.js`; the `... disposed of, as the plugin closing or applied again leaves it, ...` tests in `test/training.test.js`, `test/domains.test.js`, `test/shadow.test.js`, `test/adaptive.test.js` and `test/laya-sidecar.test.js`; `a shadow disposed of has on disk, once its dispose resolves, the row of a call Jev has answered ...` in `test/shadow.test.js`; and `a ledger's dispose(), ... resolves once every row noted before it is on disk, ...` in `test/reply-ledger.test.js`.

- **Checks ran only after an attempt that itself changed files.**
  An agent that fixed the work and then hit its usage limit (or its credit floor) skipped the checks, since the limit path continues before them.
  The agent that took over found nothing left to change, so `router.js` kept the stale failing baseline, blocked the accept as `failing: test`, and could stop the run as `needs_human` with the work done.
  The router now marks the checks stale whenever any non-tool attempt changes files, and re-runs them at the next attempt that reaches them.
  Guard: `work an agent did before its usage limit is checked again by the next attempt, even one that changes nothing` in `test/router.test.js`.

- **A masker's refusal fell back to the raw text.** The masker stopped matching `grok-2` inside
  `grok-2.1`, which is right, since the longer string is a different version. A brand word had a
  longer pattern to catch it, but a configured name that is no brand word had none, so the whole
  version string went out verbatim. For a masker, "this is not that name" has to mean "mask it as
  something else", never "leave it".
- **A count outlived the rung it was about.** The bad-window count survived a rollback that did
  not come from its own evaluation (a critical failure), rode the whole climb back, and made the
  first bad window at the re-earned rung look "sustained". State that describes a rung has to be
  settled when the rung is left, whatever took it.
- **The weekly gate was never part of capability eligibility, while the code said it was.**
  `router.js` built `unavailableIds` as `[...notReady, ...outAtStart, ...gatedIds].map((a) => a.id)`,
  but `gatedIds` holds id STRINGS, and `'claude'.id` is `undefined`. So every gated agent counted as
  capable, a checker reasoned from the line as written and reported the opposite bug, and the first
  fix for it passed its tests against the old code. The lesson has two halves: a map over a mixed
  array of objects and strings fails silently, and a new test is not a regression test until it has
  been run against the code it claims to fix and seen to fail.
- **A script run through a link did nothing and exited 0.**
  Scripts decided whether they were run as a command by comparing `resolve(process.argv[1])` with `fileURLToPath(import.meta.url)`, but Node gives the main module its real path, links resolved, while `process.argv[1]` keeps the path it was asked for.
  So through a link to the harness folder (a junction on Windows) the script did nothing and exited 0, which a scheduled task reads as success; this was reproduced with `doc-queue.mjs` through a symlink.
  `scripts/run-as-script.mjs` compares real paths, case-blind on Windows, and `speed-run`, `doc-queue`, `laya-export`, `laya-integrity-check`, `laya-render-check` and `jev-triage` use it; `ensure-no-project.mjs` already had its own correct copy.
  `test/run-as-script.test.js` starts every such script through a link to the harness.
- **A shell tool rewrote the Windows null device.**
  An agent's shell tool in the cloud turned `nul` in a `.bat` it wrote into `/dev/null`, so every run of `Speed-Run.bat` would have said Node.js is missing: in cmd.exe that redirect fails when `C:\dev` does not exist, and the command it guards does not run.
  Write `.bat` and `.cmd` files with a file-writing tool, never through a shell heredoc or `printf`, and keep the test in `test/speed-run.test.js` that rejects a Unix redirect.

1. **`requestAnimationFrame` NEVER fires in this renderer.** The window reports `document.hidden`
   true, `visibilityState hidden`, `outerWidth 0`, and a scheduled callback is never called, while
   `setTimeout` works normally. Any work deferred to a frame is a silent no-op. Every coalescer in
   `client.js` was moved to `setTimeout`, and three tests fail if a frame scheduler is reintroduced
   into the shared `coalesce` helper: one in `test/togglehints.test.js` and two in
   `test/transcripts.test.js`.
   This was the hidden cause of three features appearing broken.

2. **The task store silently dropped writes.** `tasks.js` persists by writing a `.tmp` file and
   renaming it over `tasks.jsonl`; on Windows, if a reader holds the destination open the rename
   fails with `EPERM` and the writer caught, logged and DROPPED the whole write. Measured over 300
   iterations each: with a reader polling every 1 ms, 106/300 mid-delivery and 115/300 routing
   writes were lost; with no reads in the window, 0/300. In production the reader is the browser
   polling `/jev-router/tasks`. Fixed with a bounded rename retry on `EPERM`/`EACCES`/`EBUSY`.

3. **`reconcile()` treated an unrecognised task state as "was running when the process died"** and
   overwrote the settled record, including resetting delivery to pending so a false notice was
   queued into the chat. Four accepted runs on this machine were corrupted by a restart before it
   was caught. Code fixed, rows repaired by hand, backup at
   `~/.kzh/jev-router/tasks.jsonl.bak-before-repair`. The lesson generalises: **not recognising a
   value is not evidence about what happened.**

4. **"It does not remember the last item"**: `~/.kzh/settings.yaml` named `model: agent-deepseek`,
   and the adapter turns any `agent-*` model into a forced agent run, which skips classification
   and carries no transcript. Set to `jev-auto`. Sessions remember questions now; routed tasks
   still do not, by design.

5. **The app refused to start from a terminal** because `ELECTRON_RUN_AS_NODE` trips its debug
   guard, even though the packaged exe has the RunAsNode fuse off so the variable cannot make it
   run as Node. The guard now counts that variable only in a dev build.

## The context row, and why not to take it again

Four doors were checked before the 22 Sep revert. Three are shut, and the fourth is a trap:

1. Fall through to the shipped renderer. Shut. `conversation.chat.node` is kind `keyed`, not
   `chain`. Registering the key replaces the occupant outright and there is no `next`.
2. `require` the shipped component the way the plugin already requires the UI primitives. Shut.
   `ContextMessageNodeView` and `ContextInjectionRow` are internal to
   `@deepseek-ai/dsh-client-ui-chat`; its client entry exports only `apply`, `inject`,
   `isRunningTool`, `isSettledTool` and `EMPTY_CHAT_SNAPSHOT`.
3. A per-form slot, so KzH takes only its own form. Shut. All 68 documented slot keys were listed.
   There is no context body slot: one key, `context`, covers all six forms.
4. Copy the shipped bodies. Possible and measured: 520 lines across 23 functions, plus a CSS module
   whose class names are hashed per build. That is engine internals with no changelog behind them,
   so it would break quietly. Rejected for that reason, not for the line count.

Worth knowing, because the first pass did not record it: KzH rows carry `form: 'notice'`, and the
engine already has a dedicated `NoticeBody` for that form. It renders the text plain, no Markdown.
Markdown on one row was the entire prize, and five structured bodies was the price.

`test/contextrow.test.js` fails if anyone registers the key again, and covers the Markdown
helper's fallback: an unreachable primitives module costs formatting, never the words.

## Standing setup, leave running

- **Hourly balance watch**: scheduled task `kzh-deepseek-balance-watch`, running `node scripts/check-deepseek-balance.mjs`.
  Exit 0 ok, 1 soft handoff, 2 hard cut off, 3 could not check.
  It prints one `balance-watch:` line on every run, exit 0 included, so the exit code, not the output, is what tells ok from a problem.
  Thresholds 255 soft / 240 hard, read from `handoffAtBalance` and `minBalance` in `~/.kzh/jev-router/accounts.json`, with 10 and 5 used when they are unset.
  It fails open on a network error: a failure to check is never reported as a zero balance.
  Verified working unattended.
- **Jev triage**: `scripts/jev-triage.mjs` merges duplicate review findings and drops ones with no
  testable claim, in one batched Jev call, about $0.0001. It FAILS OPEN: if Jev is unreachable
  every finding passes through untouched, because losing a real finding to a network error is
  worse than paying for one extra verifier. Every drop is logged and auditable.

## Rules that were applied and must keep being applied

- Commits are authored by the human alone. Never add an AI as co-author or in the message.
- Never commit or push to `main`. Feature branches only, named after the work.
- No em dashes or en dashes anywhere, in code, comments, UI strings, YAML or docs.
- Every table ships with per-column sort and filter. Every delete gets a confirmation overlay
  naming what goes, with a clear cancel.
- Reviewers run with `/caveman` and `/ponytail`, and never review their own work.
- Status vocabulary is strict: `verified` means the behaviour was observed. Tests passing without
  watching the app is `built`. Do not upgrade either on anyone's assertion.
- The docs are updated as the work goes, never only at the end, so they say how far a run got even when it dies (decided by the owner on 25 Sep).
  Agents working in parallel never edit the docs themselves: each queues what the docs must now say with `node scripts/doc-queue.mjs add --doc <file> --fact "<text>" [--section ...] [--evidence ...]`.
  One writer, never two at once, runs after each step: it reads `node scripts/doc-queue.mjs list`, checks every note against the code, writes it into the docs, marks it with `done <id>`, and commits with that step.
  Each finished step also gets its dated line in this file's Progress log with `node scripts/doc-queue.mjs log --step "<step>" --summary "<one line>" [--commit <sha>] [--tests "<tests> <pass> <fail> <skipped>"]`, which needs no model.
  A final docs step is only a check that the queue is empty and that no two docs contradict each other.

## Gotchas that will waste your time otherwise

- Killing `Kz-harness.exe` does NOT stop the engine it spawned.
  The engine orphans on port 3080, and the next start stops on "A Kz-harness engine is still running on port 3080, left behind by an app that is no longer open" with a `Use it here` button.
  That button's kill path has never been observed, so either click it and watch the log, or kill the `node ... @deepseek-ai\dsh ... web` process yourself and confirm 3080 is free before clicking Retry or relaunching.
  "Another harness is already running on port 3080" now appears only while a live `Kz-harness.exe` still sits above the engine.
- A `client.js` change needs an app START, not a page reload: the engine composes and caches the
  plugin bundle at startup.
- `Input.dispatchKeyEvent` delivers NOTHING while the window is hidden. Keyboard checks must use
  in-page events or DOM calls. Do not trust a dispatch that reports success with no DOM change.
- The app API needs the per-process token. Query it from inside the page with
  `credentials: 'include'`, never from a shell.
- App-shell changes (`app/**`) need `npm run package` before they reach the exe, and the app must
  be stopped first or packaging fails with EBUSY on the dist directory.
- The exe refuses to start with a debug switch (`--inspect`, `--remote-debugging-port`, `--remote-debugging-pipe`, `--js-flags`, or `--inspect` in `NODE_OPTIONS`) unless `KZH_DEBUG=1` is set.
  With it set, the exe starts with any of these switches and any port, but its fuses still ignore `--inspect` and `NODE_OPTIONS`.
  For `scripts/kzh-ui-test.mjs`, start it with `--remote-debugging-port=9222`, the port the script uses unless `--port` or `KZH_CDP_PORT` sets another.
- `~/.kzh/profiles` paths are SYMLINKS, and `grep -r` does not follow symlinked directories.

## How to verify the current claims

```
npm --prefix plugins/jev-router test                   # read the tests, pass, fail and skipped totals at the end
node scripts/kzh-ui-test.mjs list                      # needs the app on a debug port (9222 by default)
node scripts/kzh-ui-test.mjs evalfile <file.js> 3080   # drive the page whose URL contains 3080, in-page events only
```

Run all three from the repo root.
The `--prefix` form runs the tests inside `plugins/jev-router` without moving the shell, so `scripts/kzh-ui-test.mjs` still resolves.
When the output is piped, the totals print as `# tests`, `# pass`, `# fail` and `# skipped`; in a terminal the same totals start with an info mark instead of `#`.

`npm test` runs `node --test "test/*.test.js"`, and the node test runner prints the totals as its
last lines. Those are the numbers the `tests` line under State records; if they disagree, the
State line is stale, not the run. `# fail` must be 0, and on Linux `# skipped` is the one
Windows-only test (engine zip unpack).
