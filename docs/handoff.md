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
  `slots` is `{ held, waiting, max }` from `tasks.js` `createLanes().slots()`: `held` is the agent runs holding a slot under `maxConcurrentTasks` across every workspace, a foreground `/auto`, `/<agent>` or `jev_route` run counting the same as a background task; `waiting` is the runs kept out by the cap alone, the first in line in a workspace where nothing runs, and nothing with no cap; `max` is null with no cap.
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
Concurrency is real, via the cap on the lanes in `tasks.js`, and it counts foreground runs as well as background tasks.
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
   Done when: the **Router** tab lists all seven domains with real sample counts; frontier escalation's words name a rule in code at its rung (`a rule in code decides; the local router is not trained yet` at JEV_PRIMARY), and resource selection reads `a rule in code decides at every rung; the local router is recorded beside it for comparison and never decides`; the run's reasoning block carries the decision line (`adapter.js` `decidedBy`), on a cold router `Jev and routing rules decided; 2 Jev calls; 3 candidates considered` (the task call, then the strategy and second-opinion call), or `the local router (task classification, skill selection), Jev and routing rules decided; 1 Jev call; ...` once both task domains answer locally, and the report header uses the short form, `AUTO (Jev and routing rules decided)` or `AUTO (the local router, Jev and routing rules decided)`; and the **Decisions** tab shows each `RESOURCE_x` key with its agent id next to it.
2. **Look at the Resource budget table** (Settings → Jev setup → Local models, with at least one local model installed).
   Check: the four rows (VRAM, RAM, Cores, Tasks at once) with their Budget, Now and Estimated peak cells; a field saves when it loses focus; blank is no limit; `4,5` is read as 4.5 and `4,096` is refused; a refused field keeps its own error line under the table; an over-budget model shows the `over budget` pill and the refusal word for word; the chat model select shows `None fits the budget` when nothing fits; a model the RAM budget sized down shows `The budget reduced its context from <X> to <Y>, the largest that fits it.`; the soft-RAM note and the 12k context warning read as the README says; and the Tasks at once Now cell shows the runs holding a slot (`0` when nothing runs), with `N waiting` beside it when a cap is set and runs wait, and `-` only when the response carries no count.
   Look at it at the app's normal width and at a narrow one.
   Done when every item reads as described and nothing clips or overlaps at either width.
3. **Right-panel guide icons**: the seven KzH rows showing the generic cube (see "Open work an agent can do").
   Done when each of the seven rows shows its own icon in the running app.
4. **Installer fixes**, each needing the Windows machine to test.
   `scripts/Install-Harness.ps1:60` treats any `cordis.patch.yml` containing "jev-router" as configured, so a privacy setting added later never lands on a re-run.
   `scripts/Set-TypeSafeKey.ps1:7` writes a second, persistent HKCU copy of `TYPESAFE_API_KEY`, which `Start-KzH.ps1:21` reads back.
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
    The measuring can also be done with KzH closed: double-click `Speed-Run.bat` in the harness folder (docs/benchmark.md 2.12), which has never run on Windows, and check that it measures both models, prints its table and ends with exit code 0.
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
  environment, which `Start-KzH.ps1:21` reads back and which outranks `~/.kzh/.env`. The README
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
  Start KzH, open the Jev inspector, and check four things: the **Router** tab lists all seven domains with real sample counts; the two domains a rule in code decides say so at their rung; a routed run's reasoning block carries the decision line, on a cold router `Jev and routing rules decided; 2 Jev calls; 3 candidates considered`; and the Decisions tab shows the candidate table as the router saw it, each `RESOURCE_x` key with its agent id next to it (the person sees the mapping; Jev does not).
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
  effort, a ticking timer for live rows, `Stop all` behind the Confirm overlay. Renders nothing
  when the session has no tasks. The header is itself the live indicator and a real button that
  opens the Overview tab.
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
