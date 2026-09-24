# KzH handoff

Kind: **living handoff**. This is the one to read first, and the one to update. It replaces
`handoff-2026-09-21.md` and `handoff-2026-09-21-pass2.md`, both of which were folded in here on
22 Sep 2026 and deleted; every item they held that was still open is below, and every item they
held that was closed was checked against the code before being dropped.

Written for whoever picks this up next, including another agent. Everything here was verified
unless it says otherwise. Where something is unverified it says so.

## State

```
branch        main                         49aa6cb, pushed; adaptive routing merged and fixed
              fix/routing-self-labelling   merged into main, pushed, safe to delete
              feat/routing-stability-local-context   parked by the owner, not merged
remote        origin github.com/kz-95/kz-harness, PUBLIC
tests         722 tests, 722 pass, 0 fail  (npm --prefix plugins/jev-router test)
app           NOT rebuilt since the merge; the running app is on older plugin code
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

## Where this was left, 24 Sep: read this first

The adaptive router is **merged into `main` and pushed**. It was reviewed before merging, two
blockers were found and fixed, and the suite is green. It has still **never run in the app**, so
everything under "Built but NOT observed" continues to apply to it.

What the design review found, and what was done about it:

1. **The router trained on its own picks.** Once a domain reached local authority, `pickOf`
   returned the local classifier's own answer and an accepted run filed it as `teacher_confirmed`.
   The classifier confirmed itself, and the label named a teacher nobody asked. `confirms()` in
   `training.js` now drops the agreeing label under local authority; evidence that contradicts the
   pick still trains it. A bare thumbs-up also counted as a full-weight human routing label and fed
   promotion, so only the explicit `good pick` tag counts now. Commit `5d7b9f4`.
2. **Three questions asked Jev to compare numbers.** The `resource` choice handed it capability
   scores, scarcity, expected cost, reliability and latency and asked which candidate wins;
   `conserve` and `frontierReview` had the same shape. That is several judgments in one question
   over magnitudes a snap-judgment classifier cannot compare (QUICKREF rules 2 and 4).
   `rankCandidates()` in `broker.js` now does it in code under a new `code` authority, and the two
   yes/no answers come from the governor and the policy. `questions.strategy` stayed: a choice
   between named shapes is a judgment. Commit `a0528db`.

Consequences worth knowing before reading the code:

- `resource_selection` has **no Jev teacher any more**. It trains only on rescues, negatives and a
  person's `good pick` tag, so it matures slowly or not at all. The optimistic comment at
  `decision.js:169` has not been rewritten to say so. Decide which you want, and write it down.
- **Conservation was left with nothing to do** once the ranker prices scarcity itself, so its
  action was redefined: it now removes the most capable resource from the WORK pool whether or not
  the ranking picked it, keeping it available to review. A reviewer's verdict on that was to delete
  the domain outright and keep the removal as a plain pool filter beside the other hard limits.
  That is still open, and it is the largest single deletion available here.

Local models gained a memory answer (`8539b9f`). `estimateMemory()` gives the rough figure before
anything runs, being the weights, the KV cache for that context and the compute scratch, split the
way the layers will load. `readMemoryUsage()` reads the engine's own load report afterwards, which
names the device holding each buffer, so the split is read rather than guessed. A reading is stored
against the model **and** the context size it was measured at, because a reading for one context
says nothing about another. This is the first piece of the resource budget below.

What to do next, in order:

1. **Rebuild the exe and watch a routed run in the app.** The running copy is on older plugin code.
   This is still the one thing the router has never had.
2. **Scrub the handoff before it goes to Jev** (`jev.js:544`). The task text is scrubbed, the
   earlier agent's output is only clipped, and the workspace text is not scrubbed either. A
   one-line fix, on the owner's own stated privacy terms.
3. **Cap `routing-samples.jsonl`.** Eight rows per routed run, no cap, no rotation, parsed whole at
   startup and mirrored in memory. A `slice(-N)` on load covers it.
4. **Set a thread cap.** `llamaArgs` accepts `threads` and nothing sets it, so llama.cpp takes every
   core and the rest of the machine crawls.
5. Then the resource budget, the conservation deletion, and the open work below.

### The resource budget, agreed and part-built

Agreed scope: **one budget page, all consumers**, being max VRAM, max RAM, max cores and max
concurrent tasks, with the local model sizing itself to fit, refusing to start when it cannot, and
the task queue respecting the concurrency cap. The estimate and the measured readback are done; the
budget itself, the computed `--fit-target` and `-t`, refuse-to-load, the watchdog and the settings
UI are not.

Honest limits, so nobody promises more than this can do. VRAM is a real cap, because `--fit-target`
already controls exactly that and only needs computing from the budget rather than hardcoding
256 MiB. Cores is real, via `-t`. Concurrency is real, via the queue. **RAM is not a hard cap**:
Windows needs a native Job Object for that and none is being added, so what it does instead is size
the context to fit, refuse a model whose estimate exceeds the budget, and unload from a watchdog
when the real working set runs over. The Electron shell and the browser view are counted but never
capped, because they have to run.

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

### Still open from the merge review, none of it blocking

- `state.candidates` still ships the full numeric table for `questions.strategy`, which names none
  of its fields. The same cut that removed `candidate_track_record` stopped one field short.
- `decision.js:647` pushes a conservation sample for labelling even when conservation changed
  nothing, which the comment three lines above warns against. Masked today only because `confirms()`
  drops the positive label under `code`.
- A mature local classifier still outranks the `code` ranking for `resource_selection`, on a label
  diet made entirely of failures.
- Dead after the change: `fallbackYes` and `scarceTop` in `decision.js`.
- `history` and `first_resource` still ride a judgments-only call that reads only `task`.
- The flaky acceptance test `five tasks in one workspace, every state, then a restart` passes
  standalone in 0.14 s and has failed under full-suite load at 2 s. Not hardened.

## Open, and needing the OWNER, not an agent

1. **Feedback privacy.** Up to three recent reason STRINGS ride the routing call to TypeSafe,
   inside the per-agent track record, in both modes. With `routing.enabled: false` they go in
   the legacy named call (`agent_track_record`). Under adaptive routing, the default,
   `decision.js` now passes the id-to-key mapping, so they go in the resource call as
   `candidate_track_record`, re-keyed to `RESOURCE_x` and with agent ids, display names,
   providers, model ids (short ones such as `o3` included) and vendor words masked.
   Each string is the chosen tag, when there is one, followed by the reason the person typed.
   In both modes key-shaped secrets and `Bearer` tokens in it are redacted by the same scrubber the Markdown export uses.
   In adaptive mode everything else goes out as typed, and in legacy mode no names are masked.
   Keep, counts-and-tags-only, or local-only.
   Worth knowing before deciding: the bias that actually moves a pick is computed locally by
   `router.js` `feedbackPrior` from `feedback.jsonl` and applied to the resource pick's
   probabilities in the `router.js` block that opens with the comment `// The feedback prior, applied.`
   Under adaptive routing those probabilities come from the `resource_selection` domain: they are Jev's while that domain has Jev decide, the local classifier's when it answers for itself at a local rung, and the deterministic fallback's (all weight on one resource) when Jev is not configured, fails or has no answer.
   With `routing.enabled: false` they are Jev's.
   So the strings only flavour the single call they ride on.
   Nothing accumulates on the far side for your benefit.
   Defaults are easy; the choice is not an engineering one.
2. **The `Use it here` holder test** is narrow but not ownership-proof: it can stop a manually
   started copy of the pinned engine on 3080, though it needs an explicit click and refuses
   anything whose command line is not our engine.

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
- **Real wallet thresholds are published**: `255 soft / 240 hard` appear in this file and in
  `progress/progress.html`. The shipped defaults are 10 and 5.
- **`progress/progress.html` is drifting from the tree**: it still names `chore/initial-setup` and
  commit `2aeae40`, says a push is blocked because there is no remote, hardcodes the test count,
  and its result-card and Overview rows now contradict the README and this file.
- **README start time** says 10 to 20 seconds; `app/main.js:49` measures about 40, plus an engine
  download on a first run.
- **README says nothing hardcodes a machine**, but `C:\HarnessProjects` appears at
  `app/main.js:536`, `Start-KzH.ps1:6` and `scripts/Install-Harness.ps1:74`, and
  `scripts/Install-Harness.ps1:75` creates that folder when it is missing.
- **`scripts/Install-Harness.ps1:60`** treats any `cordis.patch.yml` containing "jev-router" as
  configured, so a privacy setting added later never lands on a re-run, while the README says
  re-running does whatever is missing.

Coverage gap worth knowing: no reviewer ran the app, ran the installer, or cloned to a clean
machine. The broken clone URL was found by reading, not by trying it, so the install path is still
unverified end to end. Several of the eleven items above came from a single lens and were not
independently re-derived.

## Open work an agent can do

- **Task-type matching for feedback**, the next real lever. Whether the feedback loop improves
  routing accuracy is UNMEASURABLE until real verdicts accumulate, and there is no task-type
  matching yet, so "similar work" currently means "same session" (`deps.history.feedback` is
  called with a `sessionId`). Recording task features at routing time and matching on them is the
  change. It touches the same function as the privacy question above, so settle that first.
- **Exercise the gemma transfer against a real local model** (`plugins/jev-router/format.js`).
  No real local call has ever been made, only fake streams.
  One finished background result posted in the running app, with a local chat model installed, would settle it.
- **Right-panel guide icons.** KzH registers seven guide rows in `plugins/jev-router/client.js` (Browser, Terminal, Background tasks, Subagents, Usage, Session overview, Jev inspector) and passes no icon for any of them, so all seven show the same generic cube.
  Only Workspace files, the engine's own row, has a real folder icon, so something already makes that one different.
  Find what, then give KzH's seven rows relevant icons.
- **Stale line references in `progress/progress.html`**, if you touch it.
- **Watch the adaptive router in the running app**, which is the one thing it has never had. Start
  KzH, open the Jev inspector, and check three things: the **Router** tab lists all eight domains
  with real sample counts, a routed run's reasoning block carries the `Jev decided; N Jev calls;
  M candidates considered` line, and the Decisions tab shows the candidate table as the router
  saw it, each `RESOURCE_x` key with its agent id next to it (the person sees the mapping; Jev
  does not). Everything else about it is already exercised by
  `node scripts/kzh-routing-demo.mjs --learn 60`, which needs no engine and no network.
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
  - Routing: every router swap (capability, tie-break, weekly gate, feedback, retry, `LOCAL_FIRST`
    hand-over) goes only to an agent that can do the job, and none brings back an agent a hard
    fact excluded; a capability outranks conservation and the gate, and the gate yields visibly
    (`gateYielded`) only when nothing ungated can do it; `gateOverride` reaches the engine in a
    wired install, and a gated resource the override does not keep is recorded as past its gate.
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
  - Masking: short model ids, a vendor word with a version, and a point release after any name are
    masked; model aliases are not names; the routing call and the review call mask the same names
    (`features.js` `identityNames`: id, display name, providers, model ids), including the model a
    CLI agent really runs; no field is a hiding place from the masker.
  - The review call says truthfully why each resource is outside the work table and carries the
    numbers of one kept for review.
  - Labels: a planned forced review is not a rescue; a strategy, conservation, second-opinion or
    frontier answer is labelled by a run only where it could change that run.
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
  - The `POST /jev-router/feedback` line itself is untested: `acceptVerdict` and `onVerdict` are
    tested end to end with a real registry, training store and feedback log, but nothing drives
    `apply()`, so the one line that calls `acceptVerdict` from the route is covered by reading only.

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
