# KzH handoff

Kind: **living handoff**. This is the one to read first, and the one to update. It replaces
`handoff-2026-09-21.md` and `handoff-2026-09-21-pass2.md`, both of which were folded in here on
22 Sep 2026 and deleted; every item they held that was still open is below, and every item they
held that was closed was checked against the code before being dropped.

Written for whoever picks this up next, including another agent. Everything here was verified
unless it says otherwise. Where something is unverified it says so.

## State

```
branch        main                         977e39e, pushed; adaptive routing merged, unchanged by the branch below
              fix/roadmap-open-items       pushed, NOT merged into main; the second pass of 24 Sep
              fix/routing-self-labelling   merged into main, pushed, safe to delete
              feat/routing-stability-local-context   parked by the owner, not merged
remote        origin github.com/kz-95/kz-harness, PUBLIC
tests         820 tests, 819 pass, 0 fail, 1 skipped on fix/roadmap-open-items  (npm --prefix plugins/jev-router test)
app           NOT rebuilt; the running app is on older plugin code than either branch
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
2. Providerise `jev.js` (roadmap §2 step 1), then Laya (roadmap §2 steps 2 to 4).

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

### Laya, discussed and not started

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
5. **Providerise `jev.js`** (roadmap §2 step 1), then Laya (roadmap §2 steps 2 to 4).
   Not started.
   Step 1 is a pure refactor that needs no app; Laya's steps need the machine to install and shadow it.
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

## Open, and needing the OWNER, not an agent

1. **The `Use it here` holder test** is narrow but not ownership-proof: it can stop a manually started copy of the pinned engine on 3080, though it needs an explicit click and refuses anything whose command line is not our engine.
2. **A configured tool's output is cut before it is scrubbed**, and **whether Jev is offered the whole capability vocabulary**: items 8 and 9 of "For the desktop agent".

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
- **Two small edges in the budget-sized context**, neither urgent.
  A measured reading over the RAM budget moves the next load down 1k without a watchdog unload, and the router keeps the old, larger window until its next refresh; the watchdog normally catches the same overload.
  `index.js` `refreshLocal` joins a refresh already in flight (`refreshing ??=`), which may have read the settings before a save that lands during it; this predates the branch, applies to `onChange` too, and the window is small.
- **Benchmark evidence has no source yet.** `profiles.js` aggregates three kinds of evidence -
  declared priors, published benchmarks and this harness's own verified runs - and only the first
  and third ever arrive. Nothing writes a `benchmark` row or a `benchmark_prior`; the source is
  weighed (reliability 0.7, 180-day half-life in `routing-policy.js`) but always empty. The
  arithmetic is there and tested; a harness that fetches or imports results is not.
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
