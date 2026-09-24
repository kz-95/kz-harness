# KzH roadmap

Kind: **design, build against it**. Every decision here has been made and is not up for
re-litigation unless the evidence named beside it changes. Where something is undecided it says
so and says who decides.

Written for whoever builds this next, including an agent with no memory of the conversation that
produced it. It assumes [handoff.md](handoff.md) has been read: that file says where the work was
left and what is broken; this one says what to build and why it is shaped that way.

Nothing here has run in the app. Treat every estimate as an estimate.

---

## 0. The four small fixes, before anything else

These are not part of a feature. They are open defects with known one-line answers, and each one
gets worse the longer the surrounding code grows around it.

| # | What | Where | Why now |
| --- | --- | --- | --- |
| 1 | Scrub the handoff and the workspace text before they go to Jev | `jev.js:544` | The task text is scrubbed; the earlier agent's output is only clipped, and the workspace text is not scrubbed at all. A secret in an agent's output leaves the machine. |
| 2 | Cap `routing-samples.jsonl` | `training.js:98` | Eight rows per routed run, no cap, no rotation, parsed whole at startup and mirrored in memory. `slice(-N)` on load. |
| 3 | Set a thread cap | `local.js` `llamaArgs` | `threads` is accepted and never set, so llama.cpp takes every core and the machine crawls. Becomes the `maxCores` budget in §1. |
| 4 | Rebuild the exe and watch one routed run | — | The running app is on older plugin code. The router has still never been observed live. |

Do 4 first if only one gets done. Everything below is built on the assumption that the router
works, and nobody has seen it work.

---

## 1. The resource budget

### What it is for

One page where the owner says how much of the machine KzH may use, and every consumer obeys it.
The problem it solves is stated plainly: the local model is usually **not** what overloads the
PC. Electron, a Chromium browser view and N agent subprocesses are. A limiter that governs only
llama-server caps the well-behaved thing and leaves the actual hog unbounded, so the budget is one
page covering all consumers, and the local model is simply the first one to obey it.

### The four limits, and what each can honestly enforce

| Limit | Enforced by | Real cap? |
| --- | --- | --- |
| Max VRAM | `--fit-target` computed from the budget instead of the hardcoded 256 MiB | **Yes.** llama.cpp already does exactly this; it only needs the number. |
| Max cores | `-t` on llama-server | **Yes.** |
| Max concurrent tasks | The existing per-workspace queue in `tasks.js` | **Yes.** |
| Max RAM | Context sizing, refuse-to-load, watchdog | **No.** See below. |

**RAM cannot be hard-capped.** Doing it properly on Windows needs a Job Object with
`ProcessMemoryLimit`, which is a native Win32 call, and no native binding is being added to this
app. So the RAM budget is three softer things, and the UI must say so rather than implying a
guarantee:

1. Size the context so the estimate fits the budget.
2. Refuse to start a model whose estimate exceeds the budget, naming the figure and the budget.
3. A watchdog that unloads if the real working set stays over the budget for about 30 seconds.

The Electron shell and the browser view are **counted but never capped**. They have to run, and a
budget that could kill them is a budget that breaks the app.

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

`readMemoryUsage` reads the engine's own load report afterwards. llama.cpp prints one line per
buffer it allocates, each named by the device holding it, so the GPU/RAM split is **read, not
guessed**. It returns `null` until at least one buffer line has been seen, so a caller can tell
"the engine has not said yet" from "the engine said nothing was allocated" — those are different
and must not collapse into the same zero.

A reading is stored under `${modelId}@${ctx}`, against the model **and** the context size it was
measured at. A reading for one context says nothing about another, and storing it per model alone
would quietly show a 12k measurement beside a 32k setting.

`source` is `'measured'` or `'estimated'` and the UI must show which. This is the same provenance
rule the inspector already follows for usage figures ("estimated, little evidence" against "from
the provider, well evidenced"), and it exists for the same reason: a number with nothing behind it
reads exactly like one with a hundred runs behind it, which is the one way a view like this
misleads.

### What the page shows

```
                 Budget        Now       Estimated peak
  VRAM           3.0 GB        2.8 GB    2.8 GB
  RAM            8 GB          5.2 GB    7.1 GB
  Cores          6 of 8        —         —
  Tasks at once  2             1         —
```

And per model, updating live as the context slider moves, because a context number is abstract
until it is priced:

```
  Gemma 4 E4B, 16k context    3.1 GB VRAM + 0.6 GB RAM   (estimated)
  Gemma 4 E4B, 12k context    2.8 GB VRAM + 0.5 GB RAM   (estimated)   fits your 3.0 GB budget
```

**The context floor is not negotiable and must be explained, not just enforced.** `MIN_CTX` is
12288 because DSH's system prompt plus its tool list is about 8.6k tokens on its own; below roughly
12k the model errors out mid-chat with a context-exceeded message that looks like a model fault and
is not one. A slider that silently clamps will cost somebody an hour. Say why on the page.

### What the budget decides that a person would otherwise get wrong

The budget does not shrink a model. Three things set a local model's memory, and only one of them
is adjustable after install:

- **Parameter count** (4B, 9B, 12B) — baked into the file. At Q4, roughly **half the B count in
  GB** before context.
- **Quantisation** (Q4, Q6, Q8) — baked into the file. Q4 is about half of Q8.
- **Context size** — the only one a setting can move, and it only touches the KV cache. On a 4B,
  16k down to 12k saves a few hundred MB, not gigabytes.

So the budget's real job in the picker is to decide **which models may be installed at all**:

```
  ✅ Gemma 4 E4B Q4     2.6 GB    fits, ~18 words/s
  ⚠️ Qwen3 8B Q4        5.8 GB    over budget; would split to CPU, ~3 words/s
  ❌ Gemma 12B Q4       7.2 GB    will not run usefully on this PC
```

`rateModule` already computes fit and speed. What it lacks is the GB figure and a comparison
against the budget rather than against the whole GPU.

### Build order

1. Budget stored in settings, validated like the other fields in `setSettings`.
2. `--fit-target` and `-t` computed from it in `llamaArgs`.
3. Refuse-to-load, naming the estimate and the budget in the error.
4. Watchdog on the real working set.
5. The settings page: the table, the slider, the live per-model figures, estimated against measured.
6. The queue reads `maxConcurrentTasks`.

Steps 1 to 4 are testable with no app and no tokens. Step 5 needs the app.

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
| Latency | ~33 ms on a T4 against Jev's ~236–276 ms | Real, and local. |
| Cost | $0 self-hosted against $0.042/M | Real. |
| Open bug #156 | `noul` follows its option labels instead of the input | Returns a confident "no" for clearly positive input. |
| Maturity | v0.3.9, 144 commits, 33 open issues | Pre-1.0. Three of the limitations above are open bugs, not history. |

One thing in KzH's favour: moving `conserve` and `frontierReview` into code shrank the `noul`
surface Laya would have to get right. What remains on `noul` is `secondOpinion` and the per-tool
`fits` questions.

### Non-negotiable design rules

**1. Thresholds live on the provider record, never shared.** The review policy's accept bars
(0.55 / 0.70 / 0.85) are tuned against Jev's calibration. Laya ships over-confident. Sharing one
threshold set would silently mis-gate every decision in the system. This is a small change now and
an impossible one later, which is why it is the first step.

**2. The arbiter stays in code and stays dumb.** When several sources can answer a domain,
something picks who answers. That rule is roughly fifteen lines: highest maturity wins, ties go to
the cheaper source, anything in ROLLBACK is out, nobody mature means Jev. It must **never** be
learned. A meta-classifier arbitrating classifiers has less evidence than any of the classifiers it
arbitrates, and it makes a bad pick unattributable — you cannot tell whether the domain was wrong
or the choice of who answered it was.

**3. Decide from the agreement data, not from a README.** Nobody has the number that matters: how
often Laya and Jev agree on *these* decisions. Shadow mode produces it for nothing.

### Build order

1. **Providerise `jev.js`.** Endpoint, key, model and thresholds become a provider record
   `{ id, baseUrl, apiKey, model, thresholds }` passed to `askJev`, instead of constants. Pure
   refactor, no behaviour change, fully testable without tokens. **Worth doing whether or not Laya
   ever ships** — it is what makes any second provider possible, including a BYOK one.
2. Laya as a local module in the manifest, installed and supervised like a llama.cpp model, and
   budgeted by §1 like any other local model. It has a cold start, so it reuses the existing
   keep-warm and load-at-start settings.
3. **Shadow mode.** Jev answers and is acted on; Laya answers the same batch in parallel; both are
   recorded. Free: $0 and ~33 ms.
4. **Read the data. Decide nothing before this point.**
5. Fit temperatures from the shadow data, then its own thresholds, then let its ladder run.
6. Fine-tune on `routing-samples.jsonl` if the data says it is worth it. That file already holds
   task features, the question, the answer and a verified outcome, which is the shape of a
   fine-tuning set. Laya's README puts a fine-tune at about 4–5 hours over ~30k questions on free
   Kaggle GPUs.

Steps 1 to 3 are ordinary engineering. Steps 5 and 6 are a machine-learning project with a real
chance the answer is "not good enough on our decisions", and the entire point of doing 3 and 4
first is to find that out for the price of nothing.

---

## 3. The local classifier ladder, and how it should end

The ladder — `classifier.js`, `training.js` and much of `domains.js`, about 2,100 lines plus 1,800
lines of tests — exists to avoid a Jev call that costs $0.042 per million input tokens and about
150 ms. The saving it was built for is close to zero, and until the fix on 24 Sep the resource
question still went to Jev on every run anyway, so a fully matured task domain removed no call at
all.

What is genuinely valuable in it, and must survive whatever happens:

- **The authority machinery in `domains.js`**: the maturity ladder, SHADOW → GUARDED_LOCAL →
  LOCAL_ONLY, rollback on a critical failure, OOD detection, per-domain authority. This is
  provider-agnostic and answers a real question: how does a second opinion earn the right to decide,
  and how is it pulled when it degrades. Point it at Laya and it becomes useful rather than
  machinery guarding a toy.
- **The data collection**: `routing-samples.jsonl` and the labelling rules. Its role changes from
  an online training feed to a fine-tuning dataset exported periodically, which is the safer
  design — offline training can be evaluated before it ships, online training drifts silently.

What should go, when the evidence says so:

- **The hand-rolled classifier itself**: the softmax gradient descent, the five overlapping drift
  statistics, the calibration written by hand.

**Do not delete it on this argument alone.** Delete it when the shadow data from §2 shows something
better on these decisions. Then it leaves measured out rather than argued out, and if it turns out
to beat Laya it stays and has earned it.

One open finding sharpens this: `resource_selection` now has no Jev teacher, so it trains almost
entirely on failures. It either never matures, or matures on a failure-skewed sample and then
outranks a correct arithmetic rule. Somebody has to pick: bar `local` from taking authority where a
`code` ranking exists, or accept it and write down that it is accepted. The optimistic comment at
`decision.js:169` currently claims the good outcome without having chosen it.

---

## 4. Conservation: the deletion that is waiting

Once `rankCandidates()` prices scarcity, conservation's old rule became unreachable. Rather than
delete the domain, its action was redefined: it removes the most capable resource from the **work**
pool whether or not the ranking picked it, keeping it available to review. That is genuinely useful
— it stops a mid-run hand-over from spending the capacity the ranking just held back — and it is
not a judgment.

A reviewer's verdict, and it is the right one: a controller, a maturity ladder, a training lane, a
probability, a confidence and a report row are being maintained to express

```js
if (hint.level !== 'healthy' && target) pool = pool.filter((c) => c.id !== mostCapable.id)
```

**Recommended:** drop `conservation` from the domain registry, keep the pool removal as a plain
guard in `decision.js` beside the other hard limits, and drop `codeJudgments.conserve` with it. One
fewer dead classifier, same behaviour, smaller diff.

This also closes the open finding at `decision.js:647`, where a conservation sample is pushed for
labelling even when conservation changed nothing — masked today only because `confirms()` drops the
positive label under `code` authority, and live again the moment that domain gets a teacher.

---

## 5. What is decided, and what is not

**Decided, do not re-open without new evidence:**

- One budget page covering all consumers, not a local-model-only limiter.
- RAM is soft-limited and the UI says so.
- Laya is an addition beside Jev, not a replacement.
- Provider thresholds are per provider.
- The arbiter is code, never learned.
- Shadow before authority, always.

**Not decided, and who decides:**

- **Feedback privacy** (owner, not an agent). Up to three recent typed reason strings ride the
  routing call. Keep, counts-and-tags-only, or local-only. See handoff.md; the choice is not an
  engineering one.
- **Whether a mature local classifier may outrank a `code` ranking** (owner or architect). Both
  answers are defensible; shipping without choosing is not.
- **Whether to delete the classifier ladder** (deferred to the shadow data, deliberately).

---

## 6. Order of work

1. §0 — the four small fixes. Rebuild and watch a routed run first.
2. §1 steps 1–4 — the budget, enforced. No app needed, no tokens.
3. §4 — delete the conservation domain. A clean deletion while the code is fresh.
4. §1 steps 5–6 — the settings page and the queue cap.
5. §2 step 1 — providerise `jev.js`. Useful on its own.
6. §2 steps 2–4 — Laya installed, shadowed, and the agreement data read.
7. Everything after that is decided by data that does not exist yet.
