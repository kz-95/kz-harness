# KzH roadmap

Kind: **design, build against it**. Every decision here has been made and is not up for
re-litigation unless the evidence named beside it changes. Where something is undecided it says
so and says who decides.

Written for whoever builds this next, including an agent with no memory of the conversation that
produced it. It assumes [handoff.md](handoff.md) has been read: that file says where the work was
left and what is broken; this one says what to build and why it is shaped that way.

Nothing here has run in the app. Treat every estimate as an estimate.

---

## 0. The four small fixes: three done, one open

These were not part of a feature.
Three were open defects with known answers, and branch `fix/roadmap-open-items` fixed them on 24 Sep.
The fourth needs the Windows machine and is the one thing in this section not done.

| # | What | Where | Why it was needed | Status |
| --- | --- | --- | --- | --- |
| 1 | Scrub the handoff and the workspace text before they go to Jev | `jev.js` `route()`, `router.js`, `workspace.js` `runChecks` | The task text was scrubbed; the earlier agent's output was only clipped, and the workspace text was not scrubbed at all. A secret in an agent's output left the machine. | **Done 24 Sep.** Every free-text channel of the route and review calls is scrubbed, and every router-side cut on the way to Jev scrubs before it cuts. One exception is open, a configured tool's output (`index.js` `runTool`), see §5. |
| 2 | Cap `routing-samples.jsonl` | `training.js` `samplesCap`, `createTrainingStore` | Eight rows per routed run, no cap, no rotation, parsed whole at startup and mirrored in memory. | **Done 24 Sep.** Capped per domain at a size derived from the gates (10000 with the shipped ones), compacted by an atomic rewrite that records what it dropped; the domains count new evidence on `samples.seen`. |
| 3 | Set a thread cap | `local.js` `llamaArgs`, `defaultThreads` | `threads` was accepted and never set, so llama.cpp took every core and the machine crawled. | **Done 24 Sep.** `-t` is always set: a default that leaves the machine at least a quarter of its cores, or the `maxCores` budget from §1. |
| 4 | Get the branch into the app (rebuild the exe only if `app/` changed) and watch one routed run | - | The running app is on older plugin code. The router has still never been observed live. | **Open.** |

Do 4 first.
Everything below is built on the assumption that the router works, and nobody has seen it work.

---

## 1. The resource budget

Built on 24 Sep (build steps 1 to 6 below), covered by tests, and never seen in the running app.
The settings page is described in the README's local models section and the API behind it in [handoff.md](handoff.md); this section keeps the design and says where the build differs from it.

### What it is for

One page where the owner says how much of the machine KzH may use, and every consumer obeys it.
The problem it solves is stated plainly: the local model is usually **not** what overloads the
PC. Electron, a Chromium browser view and N agent subprocesses are. A limiter that governs only
llama-server caps the well-behaved thing and leaves the actual hog unbounded, so the budget is one
page covering all consumers, and the local model is simply the first one to obey it.

### The four limits, and what each can honestly enforce

| Limit | Enforced by | Real cap? |
| --- | --- | --- |
| Max VRAM | `--fit-target` of `max(256, ceil((GPU size - maxVramGB) x 1024))` MiB (`local.js` `fitTargetMiB`), in place of the hardcoded 256 MiB | **Yes, where `--fit` can hold it.** Not with GPU layers pinned by hand, which `--fit` does not move, or on a GPU whose size is unknown or read through the 32-bit `AdapterRAM` field that stops at 4 GB, where the target stays 256 MiB. In those cases the start logs why and the page says `VRAM budget not applied`. |
| Max cores | `-t` on llama-server, capped at the logical processor count | **Yes.** |
| Max concurrent tasks | A cap across every workspace on the per-workspace lanes in `tasks.js` (`createLanes`) | **Yes.** It counts foreground `/auto`, `/<agent>` and `jev_route` runs as well as background tasks. |
| Max RAM | Context sizing, refuse-to-load and the watchdog | **No.** See below. |

**RAM cannot be hard-capped.** Doing it properly on Windows needs a Job Object with
`ProcessMemoryLimit`, which is a native Win32 call, and no native binding is being added to this
app. So the RAM budget is three softer things, and the UI must say so rather than implying a
guarantee:

1. Size the context so the estimate fits the budget.
   Built: `local.js` `planFor` takes the largest context of `contextSteps(ctx)`, from the one the model would start with down to `MIN_CTX` (12288) in whole k, whose `estimateMemory()` figure fits the RAM budget.
   A VRAM budget counts through the GPU room it leaves, since the layers it keeps off the GPU land in RAM; with no RAM budget the context is the one it would start with anyway.
   The chosen context is the `-c` that `start()` passes, what `status().modules[].ctx` and `.memory` report, and what a measured reading is stored under.
   `contextOf(id)` is the window a request meets now: the running engine's `-c` while it runs that model, else the context `planFor` last chose, else the manifest default.
   `agents()` reports `llm.contextSize` as the smaller of the planned context and the running `-c`, so the router is never promised more than either run holds, and `index.js` `onSettings` calls `refreshLocal()`, so the router's local agents pick up the budget-sized window after any settings save.
   A loaded model is not restarted when the budget changes: its window follows the budget only after it unloads (the idle timer, the watchdog, a stop, or a switch to another model).
   There is still no context slider.
2. Refuse to start a model whose figure exceeds the budget, naming the figure and the budget.
   Built: only the RAM side is refused, for the exact run the start would get (the GPU room is the usable VRAM held to `maxVramGB`, or 0 with GPU layers at 0 or the CPU build, and the GPU layers setting is part of it), so a figure over both budgets added up always puts more than the RAM budget into RAM.
   Since the context is sized first, only a model over the budget even at the 12k floor is refused, and the message then says `even at the 12k context floor`.
   The refusal is `start()`'s error, the router's readiness detail and the page's `overBudget`, word for word.
3. A watchdog that unloads if the real working set stays over the budget for about 30 seconds.
   Built: it reads the working set every 5 s while a RAM budget is set, with a 30 s grace, and a reading that cannot be taken restarts the count.
   It unloads, logs `local: unloaded <id>: ...` and tells the router at once.
   It records the unload as `{ why, ctx }`, and the next load is sized below that context; the model is refused with the watchdog's reason only when no smaller context is left, which means an unload at the 12k floor.
   The record clears when `maxRamGB`, `maxVramGB` or `gpuLayers` is saved with a different value; saving the same value again does not clear it.

The Electron shell and the browser view are **never capped, and not counted in the figures**.
They have to run, and a budget that could kill them is a budget that breaks the app.
The page says so, and tells the person to leave room for them when setting the RAM budget.

### The memory estimate

Built already, in `local.js`. Two functions, and the distinction between them is the whole design:

```
estimateMemory(m, { ctx, vramGB, measured })  ->  { vramGB, ramGB, totalGB, gpuFraction, source }
readMemoryUsage(lines)                        ->  { vramGB, ramGB, totalGB, gpuFraction } | null
```

`estimateMemory` is the rough figure before anything has run: the weights, the KV cache for that
many tokens, and the compute scratch, split the way the layers will actually load. The KV cost per
token comes from the manifest's `kvGbPerToken` where it says so, and is otherwise read back out of
`recommendedVramGB` against `contextSize`. A model with neither falls back to a flat 100 KiB per
token, which is the one truly invented number in the file and the first thing a measured run
replaces.

`readMemoryUsage` reads the engine's own load report afterwards.
llama.cpp prints one line per buffer it allocates, each named by the device holding it, so the GPU/RAM split is **read, not guessed**.
It returns `null` until at least one buffer line has been seen, so a caller can tell "the engine has not said yet" from "the engine said nothing was allocated"; those are different and must not collapse into the same zero.

A reading is stored under `${modelId}@${ctx}`, against the model **and** the context size it was measured at.
A reading for one context says nothing about another, and storing it per model alone would quietly show a 12k measurement beside a 32k setting.
A reading also carries the `roomGB` and `gpuLayers` of its run, and counts as `measured` only for a run with the same GPU room and the same layers (`local.js` `measuredFor`); for any other run the estimate is shown.
A GPU run's RAM side says nothing about a CPU run, and a run held to a tight VRAM budget overstates RAM once the budget is lifted, so taking either as it stands would let an oversized model through or refuse a model for good.
A newer reading replaces the older one.
Readings saved before the room was recorded carry none, so they count only once the model has run again and been measured anew.

`source` is `'measured'` or `'estimated'` and the UI must show which. This is the same provenance
rule the inspector already follows for usage figures ("estimated, little evidence" against "from
the provider, well evidenced"), and it exists for the same reason: a number with nothing behind it
reads exactly like one with a hundred runs behind it, which is the one way a view like this
misleads.

### What the page shows

Built as the **Resource budget** table in Settings → Jev setup → Local models (`client.js` `ResourceBudget`, inside `LocalModelsCard`).
The figures here are illustrative:

```
                 Budget    Now                    Estimated peak
  VRAM           3 GB      2.8 GB (load report)   2.8 GB (estimated)
  RAM            8 GB      5.2 GB (working set)   7.1 GB (measured)
  Cores          6         6 threads              6 threads
  Tasks at once  2         2 (1 waiting)          -
```

Budget is a field that saves when it loses focus, and blank is no limit.
A decimal comma is read as a point only with one or two digits after it, so `4,096` is refused rather than read as 4.096.
Text that is no number is refused on the page and never sent, and the server's bounds errors are shown with `or blank for no limit` in place of `or null for no limit`.
Each refused field keeps its own error line under the table until that field is saved or corrected.
Now is the loaded model's own figure: VRAM from the engine's load report, and RAM from the watchdog's working set while a RAM budget is set, else from the load report, each cell saying which.
Cores shows the loaded engine's thread count.
Tasks at once shows how many agent runs hold a slot now, across every workspace, from the response's `slots` (`client.js` `tasksNow`): `0` when nothing runs, and the note `N waiting` when a cap is set and runs wait for a free slot.
It shows `-` only when the response carries no count, and the tooltip then says `How many run now is not reported to this page`.
Lowering the cap stops no run already going, so Now can be above the budget, and the tooltip then says so and that nothing new starts until fewer runs are going.
Estimated peak is the largest figure among the installed models the budget lets load, never a model that is not installed or is refused; for Cores it is the next load's threads, noted `default` or `all this PC has`.

And per installed model, at the context it would run with, because a context number is abstract until it is priced:

```
  16k context: 2.9 GB VRAM + 0.8 GB RAM (estimated) · fits your budget of 3 GB VRAM + 8 GB RAM
```

The line ends in one of `· fits your budget of <budget>` (only when a VRAM budget, if set, really holds the figure), `· VRAM budget not applied`, or `· over your VRAM budget of <N> GB`, and in nothing when no budget is set or the budget refuses the model.
A model the budget refuses gets an `over budget` pill and the refusal word for word, a RAM watchdog unload included, and the pickers name it `<Name> (over budget)`.
When the RAM budget sized a model's context down, a line under it says so: `The budget reduced its context from 16k to 13k, the largest that fits it.`, with both ends in tokens when either is not a whole k (`from 20000 tokens to 19456 tokens`; `client.js` `reducedText`).
The chat model select will not pick a refused model, and says `None fits the budget` when no model fits; the `Model to start` select still allows Start, which shows the refusal.
There is no context slider.

**The context floor is not negotiable and must be explained, not just enforced.**
`MIN_CTX` is 12288 because DSH's system prompt plus its tool list is about 8.6k tokens on its own; below roughly 12k the model errors out mid-chat with a context-exceeded message that looks like a model fault and is not one.
The page says why under the table, and a model whose context is below the floor gets a warning line.

### What the budget decides that a person would otherwise get wrong

The budget does not shrink a model. Three things set a local model's memory, and only one of them
is adjustable after install:

- **Parameter count** (4B, 9B, 12B): baked into the file.
  At Q4, roughly **half the B count in GB** before context.
- **Quantisation** (Q4, Q6, Q8): baked into the file.
  Q4 is about half of Q8.
- **Context size**: the only one a setting can move, and it only touches the KV cache.
  On a 4B, 16k down to 12k saves a few hundred MB, not gigabytes.

So the budget's real job in the picker is to decide **which models may be installed at all**:

```
  ✅ Gemma 4 E4B Q4     2.6 GB    fits, ~18 words/s
  ⚠️ Qwen3 8B Q4        5.8 GB    over budget; would split to CPU, ~3 words/s
  ❌ Gemma 12B Q4       7.2 GB    will not run usefully on this PC
```

`rateModule` already computes fit and speed.
What it lacks is the GB figure and a comparison against the budget rather than against the whole GPU.
That is not built: the install picker still rates a model against the whole GPU, never against the budget.
What it does now is refuse to make up a GPU size.
On a GPU sized from the `AdapterRAM` ceiling (`sizeCapped`), a model that does not fit in 4 GB is rated `unknown`, with no single speed (`wordsPerSec` null) but a `wordsPerSecRange` from split on a 4 GB card to fully on the GPU; a model that fits in 4 GB is still rated `gpu`.
`suggest` ranks an `unknown` model down only when even its full-GPU speed is under 3 words/s.
A suggestion's reason gives such a model's speed as both ends, `~<split> to ~<full GPU> words/s`, and only the best-quality reason names the PC, as `GPU (memory unknown, 4 GB or more) + <N> GB RAM`.
`specsLine` prints such a GPU as, for example, `Radeon RX 6600 (memory unknown, 4 GB or more)`.

### Build order

All six were done on 24 Sep, except the context slider in step 5.

1. Budget stored in settings, validated like the other fields in `setSettings`: **done**.
2. `--fit-target` and `-t` computed from it in `llamaArgs`: **done**.
3. Refuse-to-load, naming the estimate and the budget in the error: **done**.
4. Watchdog on the real working set: **done**.
5. The settings page, with the table, the slider, the live per-model figures, estimated against measured: **done, without the slider**.
6. The queue reads `maxConcurrentTasks`: **done**.

Steps 1 to 4 and 6 are tested with no app and no tokens.
Step 5 is tested too (`test/budgetpanel.test.js` runs the whole card), but nobody has looked at it in the app.

---

## 2. Laya as a second decision provider

### The intent, stated exactly

**An additional "Laya Auto" beside "Jev Auto", each with its own maturity ladder. Not a
replacement.** Jev stays as the teacher and the quality bar.

### Why it fits with almost no work

`laya-serve` speaks the same `POST /v1/systemone` wire protocol as TypeSafe's hosted Jev API, with
the same `choice`, `score` and `noul` answer shapes and the same usage block. So a second provider
is a `baseUrl`, not a rewrite: the question building, the batching, the `requestId` capture, the
tracing and the inspector all keep working unchanged.

### Read these numbers before betting anything on it

All of them are from Laya's own README, which states plainly that its Jev column is third-party
published and was never measured there, with differing sample sizes and prompts. It is a
competitor's scorecard.

| | Figure | What it means |
| --- | --- | --- |
| Typed decisions, base checkpoints | **0.362** and **0.342** | Against **0.318** random and **0.461** majority-class. Zero-shot it is worse than always guessing the commonest answer. |
| Typed decisions, fine-tuned | **0.766** against Jev's **0.727** | The number people quote. It belongs to a fine-tuned checkpoint, not to anything you can install. |
| Calibration as shipped | mean ECE **0.466** | Over-confident until temperatures are refitted, which drops it to 0.081. The multilingual checkpoint ships with **no** fitted temperatures at all. |
| Latency | ~33 ms on a T4 against Jev's ~236 to 276 ms | Real, and local. |
| Cost | $0 self-hosted against $0.042/M | Real. |
| Open bug #156 | `noul` follows its option labels instead of the input | Returns a confident "no" for clearly positive input. |
| Maturity | v0.3.9, 144 commits, 33 open issues | Pre-1.0. Three of the limitations above are open bugs, not history. |

One thing in KzH's favour: moving `frontierReview` into code, and conservation out of the judgments altogether, shrank the `noul` surface Laya would have to get right.
What remains on `noul` in the routing call is `secondOpinion`, the task group's `humanReview`, `needsTests` and `continueHandoff`, and the per-tool `fits` questions; the intent call has `alsoWork`, and the review call five more (`addressed`, `complete`, `unrelatedChanges`, `regressionRisk`, `needsPerson`).

### Non-negotiable design rules

**1. Thresholds live on the provider record, never shared.** The review policy's accept bars
(0.55 / 0.70 / 0.85) are tuned against Jev's calibration. Laya ships over-confident. Sharing one
threshold set would silently mis-gate every decision in the system. This is a small change now and
an impossible one later, which is why it is the first step.

**2. The arbiter stays in code and stays dumb.**
When several sources can answer a domain, something picks who answers.
That rule is roughly fifteen lines: highest maturity wins, ties go to the cheaper source, anything in ROLLBACK is out, nobody mature means Jev.
It must **never** be learned.
A meta-classifier arbitrating classifiers has less evidence than any of the classifiers it arbitrates, and it makes a bad pick unattributable: you cannot tell whether the domain was wrong or the choice of who answered it was.

**3. Decide from the agreement data, not from a README.** Nobody has the number that matters: how
often Laya and Jev agree on *these* decisions. Shadow mode produces it for nothing.

### Build order

1. **Providerise `jev.js`.**
   Endpoint, key, model and thresholds become a provider record `{ id, baseUrl, apiKey, model, thresholds }` passed to `askJev`, instead of constants.
   Pure refactor, no behaviour change, fully testable without tokens.
   **Worth doing whether or not Laya ever ships**: it is what makes any second provider possible, including a BYOK one.
2. Laya as a local module in the manifest, installed and supervised like a llama.cpp model, and
   budgeted by §1 like any other local model. It has a cold start, so it reuses the existing
   keep-warm and load-at-start settings.
3. **Shadow mode.** Jev answers and is acted on; Laya answers the same batch in parallel; both are
   recorded. Free: $0 and ~33 ms.
4. **Read the data. Decide nothing before this point.**
5. Fit temperatures from the shadow data, then its own thresholds, then let its ladder run.
6. Fine-tune on `routing-samples.jsonl` if the data says it is worth it.
   That file already holds task features, the question, the answer and a verified outcome, which is the shape of a fine-tuning set.
   Laya's README puts a fine-tune at about 4 to 5 hours over ~30k questions on free Kaggle GPUs.

Steps 1 to 3 are ordinary engineering. Steps 5 and 6 are a machine-learning project with a real
chance the answer is "not good enough on our decisions", and the entire point of doing 3 and 4
first is to find that out for the price of nothing.

---

## 3. The local classifier ladder, and how it should end

The ladder (`classifier.js`, `training.js` and much of `domains.js`, about 2,100 lines plus 1,800 lines of tests) exists to avoid a Jev call that costs $0.042 per million input tokens and about 150 ms.
The saving it was built for is close to zero, and until the fix on 24 Sep the resource question still went to Jev on every run anyway, so a fully matured task domain removed no call at all.

What is genuinely valuable in it, and must survive whatever happens:

- **The authority machinery in `domains.js`**: the maturity ladder, SHADOW → GUARDED_LOCAL →
  LOCAL_ONLY, rollback on a critical failure, OOD detection, per-domain authority. This is
  provider-agnostic and answers a real question: how does a second opinion earn the right to decide,
  and how is it pulled when it degrades. Point it at Laya and it becomes useful rather than
  machinery guarding a toy.
- **The data collection**: `routing-samples.jsonl` and the labelling rules.
  Its role changes from an online training feed to a fine-tuning dataset exported periodically, which is the safer design: offline training can be evaluated before it ships, online training drifts silently.

What should go, when the evidence says so:

- **The hand-rolled classifier itself**: the softmax gradient descent, the five overlapping drift
  statistics, the calibration written by hand.

**Do not delete it on this argument alone.** Delete it when the shadow data from §2 shows something
better on these decisions. Then it leaves measured out rather than argued out, and if it turns out
to beat Laya it stays and has earned it.

One finding sharpened this, and it is decided.
`resource_selection` has no Jev teacher, so it trains almost entirely on failures, and a classifier matured on that sample would outrank a correct arithmetic rule.
The owner decided on 24 Sep that it may not: `resource_selection` has `localDecides: false` in `routing-policy.js` `DOMAINS`, no policy can switch it on, and `decision.js` takes the pick from `rankCandidates()` at every rung.
The classifier still climbs the ladder, and its answer is recorded beside the ranking's for comparison.
The comment above the resource ranking in `decision.js` now says the classifier learns only from runs that contradict the ranking and never decides.

---

## 4. Conservation: deleted as a domain (done 24 Sep)

Conservation is a hard limit in `decision.js` now, beside the weekly gate and the capability floor.
It keeps easy work off the most capable resource while that resource's allowance is being used up, and keeps the resource available to review.
The domain is gone: it has no state, classifier or new samples, `codeJudgments.conserve` is gone with it, and a conservation state file, classifier or samples an older version left on disk are ignored at start-up.
That also closed the finding that a conservation sample was pushed for labelling even when conservation changed nothing: there is no sample now.
The conditions it acts on are in [adaptive-routing.md](adaptive-routing.md).

---

## 5. What is decided, and what is not

**Decided, do not re-open without new evidence:**

- One budget page covering all consumers, not a local-model-only limiter.
- RAM is soft-limited and the UI says so.
- Laya is an addition beside Jev, not a replacement.
- Provider thresholds are per provider.
- The arbiter is code, never learned.
- Shadow before authority, always.
- Conservation is a hard limit in code, not a routing domain.
- **Feedback privacy: keep as now** (owner, 24 Sep 2026).
  Now means this: the typed reasons ride only the legacy named call (`routing.enabled: false`), inside `agent_track_record`, with key-shaped secrets and `Bearer` tokens scrubbed and names not masked.
  Under adaptive routing, the default, no routing call carries any track record, availability or history, so the reasons do not leave the machine at all.
- **A mature local classifier may not outrank the `code` ranking** (owner, 24 Sep 2026).
  The resource ranking decides at every rung (`localDecides: false`), and no policy can switch that on.

**Not decided, and who decides:**

- **Whether to delete the classifier ladder** (deferred to the shadow data, deliberately).
- **A configured tool's output is cut before it is scrubbed** (owner).
  `index.js` `runTool` keeps the last 8000 characters as the answer and the last 500 as the diagnostic, so a key straddling the cut reaches the review call as a fragment no scrubber recognises.
  Scrubbing first changes what the person is shown and what history stores.
  Options: scrub the tool answer everywhere, or keep a scrubbed copy for Jev.
- **Whether Jev is offered the whole capability vocabulary** (owner).
  Today it is offered only the capabilities some agent in the pool can carry out, so it cannot name one nobody here has, and a look-up on **Jev Auto · Local** runs on a local model.
  Offering the whole vocabulary would let code refuse instead, and would also let Jev name capabilities the machine could never run.

---

## 6. Order of work

1. §0, the four small fixes: items 1 to 3 are done; getting the branch into the app (rebuilding the exe only if `app/` changed) and watching one routed run is not, and is still first.
2. §1 steps 1 to 4, the budget, enforced: **done 24 Sep**.
3. §4, delete the conservation domain: **done 24 Sep**.
4. §1 steps 5 and 6, the settings page and the queue cap: **done 24 Sep**, the page not yet looked at in the app.
5. §2 step 1, providerise `jev.js`, which is useful on its own: **next**.
6. §2 steps 2 to 4: Laya installed, shadowed, and the agreement data read.
7. Everything after that is decided by data that does not exist yet.
