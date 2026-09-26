# Benchmark

Kind: **design, build against it**.
The owner decided on 25 Sep 2026 that KzH gets a benchmark in two parts, and this document says how both are built.
The owner's decisions in 1.1 are not up for debate; everything else may be reopened only when the evidence named beside it changes.

**B1, speed and memory:** KzH loads each installed local chat model at the context its runs get, times real generation with llama-server's own timings at the depth of an agent's call, and keeps tokens per second in `local.json` beside the VRAM and RAM it already records per model and context, so the install picker's `~X words/s est.` becomes a measured figure wherever a matching reading exists.
**B2, capability:** a small fixed set of tasks per skill, each in a throwaway folder with tests the agent never sees, run on every agent the person picks through the normal run path with that agent forced, and the pass rate written as `source: 'benchmark'` rows in `capability-evidence.jsonl`, which `profiles.js` already weighs.
Cloud agents cost real usage, so B2 is a button behind a confirmation that says what it will spend, and nothing ever starts it by itself.

It assumes [adaptive-routing.md](adaptive-routing.md) (how capability evidence is weighed) and [laya-auto.md](laya-auto.md) section 7.7 (the residency and the RAM budget) have been read.
Line references are to commit `a1e42b4`, the base of `feat/benchmark`, and engine references are to the pinned engine, `@deepseek-ai/dsh` 0.1.5-rc.2 (Start-KzH.ps1:10), and its packages of the same version.
What B1 and B2 added is named by its functions rather than by line, since it moved the lines around it.
A review of this design was applied on 25 Sep; section 8 says what it changed and which parts of it were rejected, and why.

**Status, 26 Sep:** step B1 (section 2) is built on `feat/benchmark`, in commit `914d8d4` with the fixes of its review in `c0ef03c`, and tested against a fake llama-server (`plugins/jev-router/test/fixtures/fake-llama-server.mjs`).
On 26 Sep it ran for the first time against the real llama-server, build b10964 (the Linux CPU build of the release the manifest pins), through `scripts/speed-run.mjs` (2.12), on a cloud machine with no GPU and two tiny random-weight llama models made for the test, one with a printable ASCII vocabulary and one with byte tokens.
Before the fix of 2.2 the byte-token model was not measured, because llama-server answered its non-streamed request HTTP 500 from its output parser.
After it both were measured, at 188.6 and 216.3 tokens/s generating and 1,583 and 1,527 tokens/s reading, CPU only; their readings stood for the next load in `status()`, whose rating, made by `rateModule()` as the install picker's is, read `CPU only: 189 tokens/s measured on this PC`, and no llama-server was left running.
Those generation figures were taken before the fix of 2.3 and read about 0.8 percent high; a run after it, at 05:33, gave 177.6 and 195.2 (2.13, "Recorded runs").
So B1 is verified against the real llama-server on a CPU, where its reads of `/tokenize` behind the engine's key, of the `timings` in a streamed answer's last event, and of a `prompt_n` of at least 1 on a prompt served from the cache (2.3) all held.
The GPU split, the RTX 3080, the Windows builds of the engine, the real Qwen3 8B and Gemma 4 E4B, the Local models card's speed lines and `Speed-Run.bat` itself are still not observed.
The fixes of 2.2 and 2.3, `scripts/speed-run.mjs` with `Speed-Run.bat` (2.12) and the speed run logs (2.13) are the commit after `f88947a` on `feat/benchmark`, pushed on 26 Sep.
Section 2 describes B1 as it was built, where the build settled what the design left open or corrected it.
Step B2 (section 3) is built on `feat/benchmark`, in commit `d71b76c` with the fixes of its review in `1363776` and of its second review in `5f19588` (26 Sep), and tested with stub agents, a fake Codex command-line tool and the fake llama-server only.
No real Claude Code, Codex, DeepSeek or local agent has run a task of it, so its status is built, not verified.
Section 3 describes B2 as it was built, where the build settled what the design left open or corrected it.
The branch's commits after `a1e42b4` up to `5f19588`, every one this document names among them, were squashed into `f88947a`, which was pushed on 26 Sep.

---

## 0. The design on one page

- B1 measures a model by reloading it through a new `reload()` in `local.js`, which waits until nothing holds the engine and then runs the ordinary `stop()` and `start()`, so the context, the threads, the GPU split and the budget are exactly what a real run gets.
  It sends a warm-up, one fill that reads an 8,192-token prompt, about the depth of an agent's first call, and three requests that each generate 128 tokens after it with `ignore_eos`, to llama-server's native `/completion` endpoint, each streamed as an agent's call is, and reads the engine's own `timings` from the last event of each answer.
- A speed reading lives in `local.json` under `speed`, keyed `<model>@<context>` like the memory readings under `measured`, and stands only for a load of the same weights with the same context, GPU room, GPU layers setting, thread count, engine build, depth and Laya beside it; where it does not stand, the page says why and shows the estimate.
- B1 leaves the engine as it found it: the model that was loaded is loaded again, and an engine that was stopped is stopped.
  It refuses while a local model or Laya is answering or a local agent is working on a task, holds local agents back while it runs without counting the wait against their time limit, and skips a model over the budget with the budget's own refusal.
- The same speed run goes from a shell with KzH closed: `Speed-Run.bat` at the harness root runs `scripts/speed-run.mjs`, which refuses while KzH, a llama-server or a Laya left behind, or another Speed-Run runs, reads the context from the profile, and ends with an exit code a scheduled task can check (2.12).
  Every speed run, from the card or from the shell, is logged in a `speed-runs` folder beside `local.json`: a short entry in `speed-runs.log`, and a detail log of its own (2.13).
- B2's task set is 27 tasks, three levels in each of nine skills taken from the router's task types, plus a one-file preflight task that is never scored and that proves the agent can run a command.
  A task that does not fit the window KzH gives a local model is not run on it and records nothing.
  Every task is a tiny Node 22 project with no dependencies, graded by checks that never enter the agent's folder, and the repository holds one or more reference solutions for each that the suite proves pass while the untouched task fails.
- Each task credits only the capability dimensions its grading can see: the router's `TASK_DIMENSIONS` for its type, without `first_pass_quality` and `reliability`, narrowed where a dimension is not tested.
- B2 runs every task through `runRouted` with the agent forced, at a fixed effort, with one work attempt, no retry, no review and no decider call, one task at a time across the whole benchmark, in a scratch workspace outside the harness and outside any git repository that holds nothing of the person's.
- Its rows are one per task and dimension, score 1 or 0, so their mean is the pass rate and `agreementOf` sees how split the tasks were; a whole run weighs on a dimension as three observations do, and its rows never count as runs.
  An agent's rows are written only when every one of its tasks was scored, an attempt that failed for reasons of the machine is run again rather than scored, and a newer run on the same model replaces an older one.
- The card in the Router tab shows the picks, an estimate per agent built only from what KzH has measured (never an invented price), a confirmation written by the server beside a plan id that starts one run at most, live progress, and two results tables with per-column sort and filter that put the measured pass rate beside the owner's prior, the weight the run carries and the score the Router tab shows.

---

## 1. Scope

### 1.1 Decided by the owner on 25 Sep 2026

1. **Speed and memory for local models.**
   Load each installed local chat model at its configured context, time real generation, and record tokens per second beside the VRAM and RAM KzH already records per model and context in `local.json`, so the install picker's `~X words/s est.` becomes measured where a matching reading exists.
2. **Capability.**
   A small fixed task set per skill, each task a throwaway workspace with its own tests, run on every agent the person picks through the normal run path with that agent forced, the pass rate written as `source: 'benchmark'` rows in `capability-evidence.jsonl`.
   Cloud agents cost real usage, so it is a button behind a confirmation that says what it will spend, never automatic.
   The task set decides what the scores mean, so it is designed with care.

### 1.2 The rules it is held to

- Quality, simplicity, robustness and maintainability come before development cost.
- UI text is honest: it says what is measured and what is not, and a figure always says whether it is measured or estimated.
- No degradation is silent: every skip, refusal, stop and figure left out is said where the person looks.
- Every new test fails on the old code, proven with `node scripts/red-check.mjs <test files> --base a1e42b4`.
- Every table ships with per-column sort and filter, and every delete gets a confirmation that names what goes (docs/handoff.md, "Rules that were applied").
- No em dash or en dash character appears anywhere: code, strings, comments, docs or commits.
- Markdown docs carry one full sentence per physical line.
- Builders never edit the docs; each step queues what the docs must now say with `node scripts/doc-queue.mjs add`, and one writer writes it in.

### 1.3 What exists and is built on

- `local.js` loads one model at a time through `acquire()` (local.js:1201), which starts it with `start()` (local.js:1102) under the plan `planFor()` gives (local.js:1043): the context sized to the RAM budget, the GPU layers setting, the GPU room, and the budget's refusal.
  For the model already loaded, `acquire()` reuses the running engine (local.js:1208), which keeps the context it was started with (local.js:796), and the exported `stop()` throws while a request holds the engine (local.js:1375).
- `busy` counts open requests to the engine (local.js:1206 to 1212), so `isBusy()` (local.js:1371) reads false between a local agent's model calls, while it runs a tool or the router runs its checks.
- Every load reads llama.cpp's load report with `readMemoryUsage()` (local.js:502) and keeps it with `recordMemory()` under `measured["<model>@<ctx>"]` in `local.json` (local.js:860, 1164), and `measuredFor()` (local.js:875) lets a reading stand only for a run with the same GPU room and GPU layers.
- `local.json` is written whole: `setSettings()` and `recordMemory()` each read it, change it and save it through one shared `.tmp` file (local.js:804, 842, 860).
- `rateModule()` (local.js:399) estimates words per second from the model's size over two fixed bandwidth guesses, `suggest()` (local.js:560) ranks models not yet installed, `specsLine()` (local.js:360) prints this PC, and `buildCatalog()` (local.js:1449) hands all of it to the install picker (client.js:4125) and to `/install-llm`; `status()` carries no rating per model (local.js:1351 to 1362).
- The resource budget (local.js:617) holds VRAM through `--fit-target`, which places layers by the VRAM free as the model loads (local.js:646 to 660), cores through `-t` and tasks at once through the lanes, and refuses a model whose RAM figure is over it; the Local models card shows it as a table (client.js:4501) whose Estimated peak cell already says measured or estimated (client.js:4387), and each model's memory line says the same (client.js:4455).
- `runRouted()` (router.js:509) is the one run path: a forced agent skips routing only (router.js:770), checks always decide the accept of a forced run (router.js:1074), and the loop stops at `limits` (router.js:1143).
  Each attempt runs under `AbortSignal.any([signal, AbortSignal.timeout(config.agentTimeoutMs)])` (router.js:1173), and an `execute` that rejects is recorded as `stopReason: 'error'` with the error's class and message as its diagnostic (router.js:1186, 41); nothing records a timeout as such.
  Since B1, each attempt's time limit is an attempt clock instead (`router.js` `attemptClock()`), one per agent in the attempt: `execute(agentDef, prompt, signal, { effort, speed, untimed })` gets `untimed(promise)`, a wait before the work during which the clock stands still, and a stop of the run still ends such a wait at once.
  The clock's signal fires with the reason `AbortSignal.timeout` gives, a `DOMException` named `TimeoutError`, so the reading of a timeout in 3.6 still holds; a configured tool gets the same signal.
  The attempt's `durationMs` is its own time without that wait, and the attempt records the wait as `waitedMs` when it is above 0, so the track record's average time says how long an agent works, not how long it was held back.
  Without a decider the review is the deterministic fallback of `createReview()` (jev-review/index.js:115, 165, 179): accept when the attempt completed and no check blocks it, else retry.
  The attempt's effort comes from `config.effort`, where a per-agent value from Settings wins over the run's level, and Codex's speed from `config.effort.codexSpeed` (router.js:1165, 1166), which `execute` turns into the priority service tier for `fast` (index.js:1339, effort.js:130).
- `index.js` `route()` (index.js:1268) builds everything a run needs around `runRouted()` for a session's root agent, starts every agent with `ctx.subagents.start(..., { parent: agent })` (index.js:1340), awaits the subagent's `dispose()` and ignores its failure (index.js:1359), and takes a lane first (index.js:1285); the lanes (tasks.js:71, index.js:1480) hold one run per workspace and the budget's cap on tasks at once across all of them.
- `workspace.js` gives `run()` (workspace.js:20), which kills a whole process tree on timeout on Windows only, `runChecks()` (workspace.js:140), which runs `npm` with KzH's whole environment (workspace.js:145, 25), and git snapshots (workspace.js:95, 102).
  The design took the tree kill to hold on every system; on Linux and macOS `run()` killed only its direct child until B2 (3.6).
- `profiles.js` accepts `benchmark` rows (profiles.js:42, 221, 232), weighs them at the policy's reliability 0.7 (routing-policy.js:232) with a 180-day half-life (profiles.js:272, routing-policy.js:244), reports them as a dimension's `benchmark` summary (profiles.js:333), and nothing produces one yet; the Router tab already prints `benchmark N%` (client.js:1788).
  A dimension's `samples` counts every row, benchmark rows included (profiles.js:325), and it becomes the ranking's `evidenceRuns` count (broker.js:61), the `evidenceSamples` Jev reads as `verified runs` (jev.js:382, decision.js:368), the inspector's `verified runs behind its profile` (client.js:1603) and the Router tab's `observations` (client.js:1780).
  Routing reads a profile for the task's own type (decision.js:334), which weighs rows of a related type at 0.5 and any other at 0.25 (routing-policy.js:251); the Router tab reads it with no task type (index.js:1967).
- The skills are the router's task types, `TASK_TYPES` in `jev.js:31`, whose twelve keys are also the keys of `TASK_DIMENSIONS` in `routing-policy.js:96`, which says which of `DIMENSIONS` (routing-policy.js:65) a type exercises.
- The pinned engine takes no working directory in a subagent start: `SubagentStartRequest` (`@deepseek-ai/dsh-subagent`, lib/types/types.d.ts) has none, and the Claude Code and Codex providers start their process in `request.parent.session.header.cwd` through `resolveChildCwd()` with no override.
  Every agent the router starts therefore works in the folder of the chat that started it, whatever folder the prompt names (router.js:400).
- Both providers start their process from the engine's scrubbed environment, which drops every variable whose name holds KEY, PASSWORD, SECRET or TOKEN and every `DSH_` name (`scrubbedParentEnv()` in `@deepseek-ai/dsh-subprocess`, which documents it as the base every child of the engine starts from), and their `dispose()` terminates the process and waits for its exit, throwing when it cannot (`disposeClaudeCodeChild()`, `disposeCodexChild()`).
  That a local agent's commands, which run in the engine's own process tree, start from it too is the package's documented rule and not yet read in its code.
  The design asked the builder of B2 to confirm it, and nothing B2 left records that it was confirmed, so it stays the documented rule.
- `config/cordis.patch.yml` runs Claude Code with `acceptEdits`, which lets it edit files in its folder and run only the commands the person's own Claude settings allow; the pinned provider denies any other tool at once rather than asking anyone (its `canUseTool`).
  It runs Codex with `approve-for-me`, its workspace-write sandbox, which lets it write in its folder and read anywhere.
- `scripts/ensure-no-project.mjs` adds the No project workspace to DSH's `workspace.json` before DSH starts, which is how a folder of KzH's own becomes a project a person can open a chat in; it takes the harness folder to be the parent of `scripts/`, which is the kz-harness git repository itself.

---

## 2. B1: speed and memory of local models

### 2.1 What one measurement is

1. The refusals of 2.7 are checked.
   Then, for each model before anything is loaded for it, the skips of 2.7 that a load is not needed to know: this PC cannot run it, the budget refuses it, or its context cannot hold the prompt (2.2).
2. The model is loaded fresh through a new `reload(id)` inside the engine's lock: it waits until nothing holds the engine (`busy` is 0), then runs `stop()` and `start(id)`, so `start()` plans the load under today's settings and the memory reading `recordMemory()` keeps comes from the same load as the speed reading.
   `acquire()` alone would not do, because for the model already loaded it reuses the running engine, loaded perhaps under an older budget.
   The load time from spawn to a healthy `/health` is kept too.
3. With the engine held for the whole measurement, one warm-up request goes to `<url>/completion`, shaped as the requests of 2.2 but with the text prompt `Write one short sentence about the sea.`, `n_predict` 16 and `cache_prompt: false`.
   It is streamed, as every `/completion` of the run is (2.2): its answer must come back with an OK status, every event must parse as JSON and the last must be marked `stop`, and its timings are not read.
   It pays the one-time costs of a first request (buffers allocated, kernels chosen) that no later request pays.
4. The fill: `SPEED_TEXT` is turned into the model's own tokens with llama-server's `/tokenize`, its first 8,192 tokens go to `/completion` as the prompt with `n_predict` 1 and `cache_prompt: true`, and its timings give the prompt speed.
   It sends `ignore_eos: true`, `temperature` 0 and `seed` 1 as the measured requests do, so it generates exactly its one token, and `readTimings()` holds it to `n_predict` 1.
5. Three measured requests follow, each exactly as in 2.2: the same 8,192 tokens, served from the prompt cache, and 128 generated tokens after them.
6. The engine is released, and the next model in the queue is measured, or the restore of 2.6 runs.

### 2.2 The requests

```json
{ "prompt": ["<the first 8,192 token ids of SPEED_TEXT>"], "n_predict": 128, "ignore_eos": true, "cache_prompt": true, "temperature": 0, "seed": 1, "stream": true }
```

- They go to llama-server's native `/completion`, with the engine's own key as a bearer token, because that endpoint takes `n_predict`, `ignore_eos` and a prompt of token ids: every model generates exactly 128 tokens whatever it would say, at the same depth counted in its own tokens.
  `/v1/chat/completions` stops at the model's end of turn and wraps the prompt in each model's own chat template, so two models would be timed on different lengths.
- Every `/completion` of a speed run, the warm-up, the fill and the three timed requests, is sent with `stream: true`, and its last event is read (2.3); `/tokenize` stays a plain JSON request.
  llama-server b10964 runs an answer through its chat output parser at its end, streamed or not, and the parser refuses text that is not whole UTF-8.
  An answer that is not streamed then comes back HTTP 500 with `The model produced output that does not match the expected Content-only format`, even when the text was only cut inside its last character, as 128 tokens of a byte-level tokenizer can be.
  A streamed answer holds such a cut character back, and ends with `stop` and its timings all the same.
  This was reproduced on 26 Sep against the real llama-server b10964 with a tiny model whose vocabulary is byte tokens: the non-streamed request failed every time, and the streamed one ended with `stop` and full timings.
  Text with a broken character inside it is refused either way: streamed, it comes as an error event after HTTP 200, and the model records nothing, with `llama-server stopped with an error: The model produced output that does not match the expected Content-only format` (2.3).
  That was checked against the real server with a logit bias on a lone continuation byte.
  Streaming is also how an agent's own calls reach the model.
  B1 as first built sent `stream: false`, and its first run against the real llama-server (the status at the top) is how this was found.
- The depth is 8,192 tokens because an agent's first call already carries about 8,600 tokens of system prompt and tool list (local.js:523), and generation slows as the context fills, most of all on a CPU or a split load, so a speed taken after a short prompt would promise more than a local agent gets.
  The budget never sizes a load's context below 12,288 tokens (`MIN_CTX`, local.js:524), which holds 8,192 tokens and 128 generated ones.
  The design took that for a floor under every load, and it is not one: the plugin config's `local.contextSize` (down to 2048, index.js) or a manifest's `maxContext` can start a model below it, and `contextSteps()` leaves such a context as it is.
  A model whose planned context is below 8,321 tokens (`SPEED_MIN_CTX`: the 8,192-token prompt, the 128 generated tokens and one cell to spare) is therefore not measured, and nothing is loaded for it, with `<name> not measured: its context of 8k cannot hold the 8,192-token prompt and the 128 tokens generated after it`, the context given in tokens when it is no whole number of k.
- `cache_prompt: true` on the fill and on the measured requests: the fill processes the whole prompt once, which is the prompt speed, and each measured request reuses it from the cache, since llama-server runs one slot (`-np 1`, local.js:68), so what is timed there is generation alone.
- `SPEED_TEXT` is a constant in `local.js`, built by a function so it is exact and readable: numbered short JavaScript functions, about 64,000 characters, far more than 8,192 tokens in any tokenizer.
  A model whose tokenizer makes fewer than 8,192 tokens of it records nothing, with `the speed text is shorter than 8,192 tokens for this model`.
  It is synthetic and fixed, and nothing of the person's is in it.
- `n_predict` 128 keeps the generation phase long against timer granularity (2.5 seconds at 50 tokens a second), and on a CPU-only load of a 5 GB model at 3 tokens a second a repetition takes about 45 seconds.
- Every request that sends the 8,192-token prompt has 30 minutes (`PROMPT_MINUTES`): the fill, because a CPU reads 8,192 tokens at tens of tokens a second, and each timed request too.
  A request for the same model (a chat title, a compaction, which 2.6 lets reach the engine) may take the one slot's prompt cache before any of them, the timed request then reads the whole prompt again, and nothing can tell before it is sent whether one will.
  The warm-up and the `/tokenize` request have 10 minutes.
  A request that takes longer ends that model's measurement with `took longer than <n> minutes`, and a timed request that had such company is run again, as 2.3 says.

### 2.3 Reading llama-server's own timings

llama-server ends a streamed `/completion` (2.2) with an event marked `stop: true`, which carries the same `timings` object a non-streamed answer has, and B1 reads the timings from that last event.
It reads four of their fields: `prompt_n`, `prompt_ms`, `predicted_n` and `predicted_ms`.
Generation speed is `(predicted_n - 1) / predicted_ms * 1000`, since the first generated token comes out of the prompt pass and `predicted_ms` times the other n - 1, and prompt speed is `prompt_n / prompt_ms * 1000`; these are what `predicted_per_second` and `prompt_per_second` report.
llama-server b10964 gives 207.99 ms for 128 tokens, 1.6377 ms a token, and its own 610.61 tokens/s, all of them over 127 (seen against the real server on 26 Sep).
Every reading B1 took before this was fixed on 26 Sep read 128/127 of the speed, about 0.8 percent fast.
Since the fix, each timed request's line in the detail log, `timed request <k> of 3: 177.9 tokens/s generating`, equals llama-server's own `eval time = 713.89 ms / 128 tokens (... 177.90 tokens per second)` printed beside it (2.13).
They are worked out from the counts and the milliseconds rather than read from the rate fields, so a build that drops or renames a rate fails the check below instead of reading as zero.

A pure exported `readTimings(body, { nPredict })` in `local.js` returns `{ tokensPerSec, promptTokensPerSec, promptTokens }`, or a reason:

- no `timings` object, or one of the four fields missing or not a positive finite number: `llama-server did not report its timings`;
  the fill's one token times no generation, so for it `tokensPerSec` is null and `predicted_ms` may be 0, and only the other three fields must be positive;
- `predicted_n` other than `n_predict`: `llama-server generated <n> tokens, not <n_predict>`.

An answer that never reaches its timings records nothing too, each reason after `<name> not measured: ` (2.7):

- an event that carries an error: `llama-server stopped with an error: ` and then its message, the text itself when llama-server sends the error as text alone, or the error's JSON when it has no text message;
- a stream whose last event is not marked `stop`: `llama-server ended its answer before it finished`;
- an event that is not JSON: `llama-server answered with something that is not JSON`;
- an error status: `llama-server answered HTTP <status>: ` and then llama-server's own error message rather than its JSON body, or the error itself when it is text alone, or the body as it came, cut to 200 characters, when it is not JSON or its error has no text message, with trailing spaces and full stops dropped, and nothing after the status when the body is empty.

Neither the error line nor the HTTP line ever reads `[object Object]` or puts the message in quotes.

The prompt speed is the fill's, kept when it processed at least 8,000 prompt tokens; otherwise the prompt speed reads `not measured: llama-server reused its prompt cache`, and generation speed is still recorded.
The generation speed is the median of the three measured requests, with all three kept.
The three must agree: when the fastest and the slowest differ by more than 15 percent of the median, the model records nothing, with `the three runs disagreed; something else was using the machine`.
A measured request is run again when another request reached the engine during it, which a count of `acquire()` calls read before and after it shows, or when Laya's `busy()` read true at its start or its end; after three such repeats the model records nothing, with `other requests kept arriving while it was measured`.
Company is read at the start and the end of each request, so a Laya still answering when one request ends is also answering as the next starts, and costs two repeats.
A Laya process loaded or unloaded beside the model at any point from its load to the end of the last timed request (unloaded, stopped, restarted or started) is not company but another machine, since `--fit` placed the layers around what was resident at the load, and running a request again would not help.
Such a model records nothing, with `<name> not measured: Laya was loaded or unloaded beside it while it was measured`.
The residents are compared as residency entries, so a Laya that stopped and started again on the same device counts as a change.
A request refused by `readTimings` records nothing for that model and says why; there is no fallback to a wall clock.
The timed requests rely on llama.cpp reading the last prompt token again when it serves a prompt from the cache, so that their `prompt_n` is at least 1: a `prompt_n` of 0 would be refused as `llama-server did not report its timings`.
The real llama-server b10964 did so on 26 Sep, on its Linux CPU build: every timed request of both test models was measured (the status at the top); its Windows CUDA build has not been checked (docs/handoff.md, "Built but NOT observed").

### 2.4 What is stored, where, and how it is keyed

`local.json` gains a `speed` map beside `measured`, keyed the same way:

```json
"speed": {
  "qwen3-8b@16384": {
    "at": "2026-09-26T10:00:00.000Z",
    "tokensPerSec": 21.2, "promptTokensPerSec": 412.7, "depth": 8192, "nPredict": 128,
    "runs": [{ "tokensPerSec": 21.0 }, { "tokensPerSec": 21.2 }, { "tokensPerSec": 21.5 }],
    "loadMs": 7810,
    "roomGB": 4, "gpuLayers": "auto", "threads": 6,
    "engine": { "variant": "cuda12", "sha256": "<the manifest SHA-256 of that variant's llama-server zip>" },
    "weights": { "file": "Qwen3-8B-Q4_K_M.gguf", "sha256": "<its manifest SHA-256>" },
    "layersOnGpu": { "gpu": 29, "total": 37 },
    "vision": false, "laya": null
  }
}
```

- The key is the model id and the context the load really had, the engine's `e.ctx`.
- `promptTokensPerSec` is null when the fill was served from the prompt cache (2.3).
- Every condition comes from the engine object that ran, never from a fresh `planFor()`.
  `start()` keeps on the engine, beside the `e.threads` it already kept (local.js:1128), the plan's GPU room and GPU layers setting (`e.roomGB`, `e.gpuLayersSetting`), the installed build (`e.build`), the weights it loaded (`e.weights`), and the Laya residents beside it at the spawn (`e.beside`) with their device (`e.laya`); once `/health` answers it adds the load time (`e.loadMs`).
- `engine` names the installed build: its variant and the manifest SHA-256 of that variant's first engine module in `config/local-models.json`, its llama-server zip, which the manifest lists before the CUDA runtime zip.
  A manifest update that changes only the CUDA runtime therefore leaves a reading standing.
- `weights` is the model's file and manifest SHA-256, from the engine that ran.
- `layersOnGpu` is the engine's own `offloaded N/M layers` line (`e.gpuLayers`, local.js:1132), null when the engine did not print it, and `vision` says whether the add-on was loaded.
- `laya` is the device of the Laya processes resident beside the model when llama-server was spawned, held or not (`laya.serve`, or its install check while one runs): `cuda` when any of them is on the GPU, else `cpu`, and null when there were none.
  A Laya that did not give way to the load, because it was held or busy answering when `residency.yieldFor` ran, shares the GPU and the CPU with it however its hold changes afterwards.
- A pure `speedFor(s, id, next)` beside `measuredFor()` lets a reading stand only when the next load's weights have the same SHA-256, and the key and the conditions `roomGB`, `gpuLayers`, `threads`, `engine`, `depth` and `laya` all equal what the next load would get.
  The weights are checked before every other condition.
  The next load's `weights` are the manifest's file and SHA-256 for that model, so a manifest update that ships other weights under the same model id (another quantisation) takes the reading away, and a reading that names no weights stands for none.
  The next load's `laya` is the device a held Laya is resident on now, since one nothing holds gives way when a model loads (local.js:1109), so a reading taken beside an unheld Laya does not stand for a load that will not have it.
  Each of those decides how fast the model runs: other weights are another model, the room, the layers setting and a Laya on the GPU split it between GPU and CPU, the threads set the CPU half's speed, another build is another program, and a deeper prompt generates more slowly.
- `speedFor()` gives the reading under the next load's key, and with none there the newest reading of the model at any other context, as one that does not stand, so the card can say why rather than say nothing was measured.
- A newer reading replaces the older one under its key, as a memory reading does: the newest run describes the machine as it is now.
- The map is a sibling of `measured`, not a field inside its entries, because every load writes its memory entry whole (local.js:862), and a load that did not measure speed must never erase a speed reading.
  `DEFAULTS` gains `speed: {}`, and `setSettings()` never takes a `speed` patch, since it copies only the keys it knows.
- Every write to `local.json` goes through one queue, a `mutate(fn)` chained on a promise, which re-reads the file inside it, applies `fn` and saves; `setSettings()`, `recordMemory()` and the speed writer all use it.
  Before B1, two writers that interleaved each saved what they read before the other saved, so one change was lost, or they collided on the shared `.tmp` file; a RAM budget saved during Benchmark all would have dropped a speed reading.
  A `fn` that throws saves nothing, and the queue goes on.
- `status()` gives every model a `speed` of `{ reading, stands, why }`, the reading under the key the next load would use, whether it stands, and when it does not, which condition differs, in words the card prints (2.9), and a `rating`, what `rateModule()` makes of the model on this PC, which the card's estimate lines need.

### 2.5 Benchmark per model and Benchmark all

- One speed run at a time, holding a queue of model ids.
- **Benchmark** on a model's row queues that one model; **Benchmark all** queues every installed chat model, in manifest order, with the model loaded now last, so the run ends with it loaded and the restore of 2.6 needs no load of its own; it is still reloaded once, to be measured.
- Benchmark all does not leave out a chat model whose file is on disk but cannot be measured: one whose SHA256 does not match the manifest, `<name> not measured: its file does not match the manifest's SHA256; install it again (type /install-llm <id>)`, or one still being hashed, `<name> not measured: its file is still being checked (SHA256); benchmark it when that is done`.
  Each is put first in the run's order as a `done` line that is not measured, in the card, the detail log and the history, and the count of the models measured reads on from them, so the card's `<k> of <n>` and a waiting local agent's line (2.6) name the right model.
  With only such models installed, Benchmark all runs and records each as not measured, rather than refusing with `No local chat model is installed`.
  Named in `ids`, by Benchmark on its row or `Speed-Run.bat --models`, such a model is refused instead (2.7).
- A second request while a run is going is refused: `A speed benchmark is already running.`
- The run reports itself in `status().speedRun`: `state` (`idle` or `running`), `current` (`{ id, phase, run }`, phase `loading`, `warming`, `reading` or `measuring`, run 1 to 3), `queue`, `done` (`{ id, ok, text }` per model, in order) and `restore`.
  While the restore of 2.6 runs, `current` has phase `restoring`, with the id of the model loaded before, or null.
  `cancelled` says whether Cancel has been pressed on the run going, and is false once none goes (2.8).
  Once the run has ended, `state` is `idle` and `done` and `restore` keep what it left until the next run starts.
  `log` and `logError` say where the run is logged and what could not be written (2.13).
- A measured model's `done` line reads `Qwen3 8B: 21.2 tokens/s generating and 413 tokens/s reading, 8,192 tokens into a conversation, at 16k context.`, the context given in tokens when it is no whole number of k.
  When the fill was served from the prompt cache, `; its reading speed was not measured, because llama-server reused its prompt cache` stands in place of the reading speed.
  A model that recorded nothing has `ok` false and the line `<name> not measured: <why>` (2.7).

### 2.6 The model the person had loaded, and requests that arrive meanwhile

- At the start the run notes the model the engine had loaded (`isLoaded`), or that none was.
- At the end, whether the run finished, failed or was cancelled, a model that was loaded and is not the one loaded now is loaded again through `acquire()`, so it waits for anything in flight, and an engine that was stopped at the start is stopped again if nothing holds it.
- The last line says which: `Qwen3 8B is loaded again, as it was before.`, `The engine is stopped again, as it was before.`, or `Could not load Qwen3 8B again: <error>.`
  Two more lines cover what the design did not name: `The engine was stopped before; <model> stays loaded, because a request is using it now.` when a request holds the engine at the end, and `KzH closed during the speed benchmark, so nothing was loaded again.` when the local models are disposed mid-run, which aborts the run and loads nothing after it (2.8).
  `Speed-Run.bat` disposes of them with its own words when it has to stop at once (2.12), and the line then reads `The speed run was stopped at once, so nothing was loaded again.`
- Local agents wait for the whole run.
  The count of local-agent attempts in flight and their wait live in `local.js` (`localAgentAttempt()`), which `index.js` wraps around `execute` for every agent of kind local (the `execute` `route()` builds, index.js:1334, which B2 moves into `runDepsFor()`, so benchmark tasks share the count), so the refusal of 2.7 and the wait read one count.
  While a speed run goes, a local agent's attempt waits before it starts its subagent, with the line `Waiting for the speed benchmark to finish (<model>, <k> of <n>).`, said again each time the run moves on to another model.
  Without it the run and an agent would take turns: every measured model would unload the agent's model, and every agent turn would load it again and read its whole context again, which on a CPU takes minutes each time and can run a person's task past its timeout.
- The wait goes through the router's untimed wait (1.3), so it does not count against the attempt's time limit (`agentTimeoutMs`, 20 minutes by default).
  A speed run of any length holds a local agent back for as long as it lasts, and the attempt then starts with its whole time limit, so the wait never turns into a failed attempt, a retry, or capability evidence against a model whose agent never started.
  Only a stop of the run ends the wait early, with the error `stopped while it waited for the speed benchmark to finish (<reason>)`, and a stopped run writes no capability evidence.
- Other local requests, a chat title or a compaction, wait for the model being measured as any request for another model waits (local.js:1204), and may load their own model between two measured models.
- While the run goes, the card says so: `Local agents wait until the speed benchmark ends; a chat title or a compaction waits for the model being measured.`
- An unheld Laya gives its memory up when a measured model loads, as it does for any local start (`residency.yieldFor`, local.js:1109); one that is held, or busy answering a call as the model loads, stays, and the reading records the device it is on (2.4).

### 2.7 Refusals

The whole run is refused, with the reason as the route's error, when:

- a local model is answering (`isBusy()`): `A local model is answering right now; a speed benchmark would unload it mid-answer. Try again when it is idle.`
- a local agent is working on a task (the count of 2.6 above 0): `A local agent is working on a task; start the speed benchmark when it has finished.`
- Laya is answering a call (the Laya client's `busy()`, laya-client.js:635): `Laya is answering a call right now, and would slow the measurement. Try again when it is idle.`
- a capability run still has a local agent's task to run, which B2 added (3.8), read from `benchmark.js` `localPending()` through `createLocalModels`' `capabilityBusy`: `A capability benchmark is running a local model's tasks; start the speed benchmark when they have finished.`
- a speed run is going (2.5): `A speed benchmark is already running.`, with status 409;
- `ids` is given and is not a non-empty list of strings: `ids: the local chat models to measure, or none for every installed one`;
- the engine is not installed: `The llama.cpp engine is not installed (type /install-llm).`;
- no chat model is installed, and none whose file is on disk but cannot be measured (2.5): `No local chat model is installed (type /install-llm).`;
- an id names no local chat model, a vision add-on's id included: `No local chat model is named <id>.`;
- an id names a chat model whose file is on disk but cannot be measured (2.5): `<name> cannot be measured: ` and then the same why as its line in Benchmark all;
- an id names a chat model that is not installed: `<name> is not installed (type /install-llm <id>).`

A single model is skipped with its reason, and the run goes on to the next, when:

- this PC cannot run it (`rateModule()` rates it `no`): `<name> not measured: <reason>`;
- the budget refuses it: `<name> not measured: ` and then the refusal `planFor()` gives, word for word, which is what `start()` would throw;
- its planned context is below 8,321 tokens (2.2): `<name> not measured: its context of 8k cannot hold the 8,192-token prompt and the 128 tokens generated after it`, found before anything is loaded;
- its load fails: `<name> not measured: it did not load (<error>)`;
- the engine exits mid-measurement: `<name> not measured: the engine stopped while it was measured`;
- the RAM watchdog unloads it mid-measurement: `<name> not measured: the RAM watchdog unloaded it: <its reason>`;
- a Laya is loaded or unloaded beside it during its measurement (2.3): `<name> not measured: Laya was loaded or unloaded beside it while it was measured`;
- the speed text is too short for its tokenizer, a request's timings are refused (2.3), the three runs disagree, requests keep arriving, or a request runs past its time: `<name> not measured: <why>`, with the words of 2.2 and 2.3;
- llama-server answers a request with an error status, with something that is not JSON, with a streamed answer that carries an error or ends before its last event, with no token list for the speed text, or not at all: `llama-server answered HTTP <status>: <its error message>`, `llama-server answered with something that is not JSON`, `llama-server stopped with an error: <its message>`, `llama-server ended its answer before it finished`, `llama-server did not tokenize the speed text` or `llama-server did not answer (<error>)` after `<name> not measured: `, with the words of 2.3;
- anything else goes wrong: `<name> not measured: something went wrong (<error>)`.

### 2.8 Cancel

`POST /jev-router/local/benchmark/cancel` aborts the request in flight and drops the queue.
During `loading` there is no request to abort, so it aborts through a signal `start()` now takes: one that fires before the spawn spawns nothing, and one that fires after it stops the loading engine at once, which `start()`'s wait for `/health` sees and fails on (local.js:1154), instead of leaving a big model's load to run for up to 5 minutes before the restore.
The same signal ends `reload()`'s wait for the engine to be free.
A model whose three measured requests had not all finished records nothing, and its line reads `<name> not measured: cancelled`; readings already taken are kept; the restore of 2.6 runs.
The last line reads `Stopped. Readings already taken are kept; ` followed by the restore line.
While the speed run puts the engine back as it was (the phase `restoring`), every model is done and the restore must run, so Cancel is refused and says why: `local.js` `cancelBenchmark()` throws, and the route answers 409 with `The speed benchmark has measured every model it will and is putting the engine back as it was before it; that cannot be cancelled.`, which the card shows as its alert.
A Cancel with nothing running, or on a run already cancelled, has nothing more to do and still answers 200.
The second review of B2 made it so: before, a press during the restore was ignored while the route answered ok.

Once the local models are disposed (KzH closing, or the plugin reloading), a speed run going is cancelled, and `start()` refuses right before it would spawn llama-server, with `KzH is closing, so <name> was not loaded`.
So nothing that was already on its way loads a model with no exit hook: not a speed run's restore that waited behind a chat title, not the title itself.
A restore that was waiting then ends the run with `Stopped. Readings already taken are kept; KzH closed during the speed benchmark, so nothing was loaded again.`, or, from `Speed-Run.bat`, `...; the speed run was stopped at once, so nothing was loaded again.` (`dispose({ why })`).

### 2.9 How the numbers are shown

**The install picker and `/install-llm`.**
`buildCatalog()` passes an installed model's standing reading to `rateModule()`, which then rates it from the reading: `source: 'measured'`, `fit` from `layersOnGpu` (all layers on the GPU is `gpu`, some is `split`, none is `cpu`), `wordsPerSec` from the measured tokens with the same 0.75 the estimate uses, and a label that says so:

- `Runs fully on GPU: 21 tokens/s measured on this PC on 25 Sep, 8,192 tokens into a conversation (about 16 words/s)`
- `Splits GPU + CPU (29 of 37 layers on the GPU): 8.4 tokens/s measured on this PC on 25 Sep, 8,192 tokens into a conversation (about 6 words/s)`
- `CPU only: 2.9 tokens/s measured on this PC on 25 Sep, 8,192 tokens into a conversation (about 2 words/s)`

When `layersOnGpu` is null, `fit` stays the estimate's, and the label reads `21 tokens/s measured on this PC on 25 Sep, 8,192 tokens into a conversation (about 16 words/s); the engine did not report its GPU split, so where it runs is estimated`.
`rateModule()` returns `source: 'estimated'` on every model rating it does not take from a reading, a `no` one included, and such a rating keeps its label, `est.` included, so a measured figure and a guessed one never look alike.
A model this PC cannot run is rated `no` whatever its reading says.
Engine and vision add-on ratings carry no `source`, since they have no speed.
A figure's day reads `25 Sep`, with its year when it is not this one (`2 Mar 2024`), here, in the card's speed line and in each memory line.
`/install-llm` prints the same labels, since `listLine()` reads `rating.label`.
`suggest()` is unchanged: it only ever suggests models that are not installed, which nobody can have measured.
`specsLine()` is unchanged: a reading belongs to the PC that line describes, and the picker prints both.

**The Local models card.**
Each installed model's row gets a speed line from a pure `speedLine(m)` in the budget helper block:

- standing: `Speed: 21.2 tokens/s generating and 413 tokens/s reading, both 8,192 tokens into a conversation (measured 25 Sep; 29 of 37 layers on the GPU, 6 threads).`, with `, Laya on the GPU beside it` before the closing parenthesis when it was;
  with no GPU split reported, `the engine did not report its GPU split` stands where the split would be;
  when its reading speed was not measured, the line reads `Speed: 21.2 tokens/s generating, 8,192 tokens into a conversation (...).` and says so in a sentence of its own: `Its reading speed was not measured, because llama-server reused its prompt cache.`;
- not standing: `Speed: measured 21.2 tokens/s on 25 Sep, but <why>, so that reading does not stand for the next load. Benchmark it again. Until then, about 6 words/s estimated from its size and this PC's memory bandwidth.`, as section 0 says, with the estimate's range and `, a range because this GPU's memory is unknown` where the GPU's size is unknown;
  it ends `Benchmark it again. This PC cannot run it now: <reason>.` when the rating is `no`, and at `Benchmark it again.` when `status()` gives no rating;
- none: `Speed: not measured on this PC; about 17 words/s estimated from its size and this PC's memory bandwidth.`, or with the estimate's range where the GPU's size is unknown, from the `rating` `status()` now carries;
  a model this PC cannot run reads `Speed: not measured on this PC, which cannot run it: <reason>.`, and with no rating the line is `Speed: not measured on this PC.`

`<why>` is one of:

- `it does not say which weights of this model it was measured on`, or `it was measured on other weights of this model`;
- `it was measured at 16k context and the next load gets 14k`, or `it was measured at a context of <n> tokens and the next load gets <m>` when either is no whole number of k;
- `it was measured with GPU layers auto and they are now pinned to 20`, or `it was measured with GPU layers pinned to 20 and they are now auto`;
- `it was measured with 4 GB of GPU room and the VRAM budget now leaves 2 GB`;
- `it was measured with 6 threads and the next load gets 4`;
- `it was measured on another engine build`;
- `it was measured with Laya on the GPU beside it and the next load will not have Laya beside it`, `it was measured without Laya beside it and Laya is now on the GPU beside it`, or `it was measured with Laya on the CPU beside it and Laya is now on the GPU`;
- `it was measured at another depth`.

The conditions are checked in that order, and the first that differs is the one named.

Each model's memory line (client.js:4455) gains the date a measured figure was taken, which `recordMemory()` already stores as `at`: `16k context: 3.9 GB VRAM + 2.1 GB RAM (measured on 25 Sep)`.
Each row gets a **Benchmark** button, titled `Load it at the context its runs get, read an 8,192-token prompt and time 128 generated tokens after it three times. <wait>; a model you had loaded is loaded again after.`, where `<wait>` is `About 3 minutes by its last measurement` when a reading exists (its load time, the fill at its prompt speed and three generations at its speed) and otherwise `How long is not known until it has run once; on the CPU it can take 10 minutes or more`.
When the reading has no prompt speed, `, and longer by the time it takes to read the prompt, which was not measured` follows `by its last measurement`.
The card head gets **Benchmark all**, titled `Measure every installed model's speed on this PC, one after another: each is loaded at the context its runs get, reads an 8,192-token prompt and generates 128 tokens after it three times. A model you had loaded is loaded again after.`
Benchmark all and every Benchmark button are disabled while a run goes, and while the engine or every chat model is not installed.
A speed run is free and changes nothing but which model is loaded, so it needs no confirmation; a refusal of 2.7 shows in the card's alert line.

The run shows in a status region under the card's intro:

- while it goes, `Speed benchmark: <name>, <k> of <n>: <phase>.`, with `Then <names>.` when more follow, the phases worded `loading it at the context its runs get`, `a first short request, not timed`, `reading an 8,192-token prompt` and `timing 128 generated tokens, <run> of 3`;
- during the restore of 2.6, `Speed benchmark: loading <name> again, as it was before.` or `Speed benchmark: stopping the engine again, as it was before.`;
- while it goes, the line of 2.6 on local agents, and **Cancel**;
  during the restore Cancel is shown disabled, with the sentence of 2.8 as its title, and once pressed it reads `Cancelling…` and stays disabled until the run has ended, which `status().speedRun`'s `cancelled` tells it;
  the second review of B2 made it so, since before Cancel stayed enabled after a press;
- then the `done` lines, a model not measured in the error colour, and the restore line, which stay until the next run;
- once the run has ended, where it is logged, and at once, in the error colour, a log that could not be written (2.13).

The card polls every 1.5 seconds while a run goes, as it does during an install.

**The resource budget table.**
B1 leaves it as it is: its shape, its cells and their titles.
It has no per-column sort or filter, which the table rule asks of every table (docs/handoff.md:593); it is a fixed form of input rows, and whether the rule covers such a form is the owner's call, which docs/handoff.md lists under "Open, and needing the OWNER, not an agent" rather than this design deciding it.
Running Benchmark all is how every installed model's figure there becomes measured.

### 2.10 Routes

- `GET /jev-router/local`, as today, now with `speedRun` and each model's `speed` and `rating`.
- `POST /jev-router/local/benchmark` with `{ ids?: string[] }` (none means Benchmark all): 200 with `{ queued }`, the ids in the order they will be measured, 400 with a refusal of 2.7, 409 while a speed run is going.
  The run goes on in the background after the answer.
- `POST /jev-router/local/benchmark/cancel`: 200 with `{ ok: true }`, also when nothing runs or the run is already cancelled, and 409 with the refusal of 2.8 while the run puts the engine back as it was.

### 2.11 What B1 does not measure

- Generation deeper than 8,192 tokens: an agent's context grows as its task goes on, and generation slows further as it does.
- Prompt reading with a warm cache: an agent's later calls reuse most of their prompt, so they wait far less than 8,192 tokens at the measured prompt speed.
- Speed while another program uses the GPU: `--fit` places layers by the VRAM free as the model loads, so a reading taken while another program held VRAM describes a smaller split, and nothing records that program.
  The reading keeps the split it ran with, which the card prints, and the agreement rule of 2.3 catches load that comes and goes during it.
- Any cloud agent's speed, the vision add-on's image reading, or Laya's own speed, which Laya's card measures.
- Models that are not installed: their figures stay the bandwidth estimate, marked `est.`.

### 2.12 From a shell: Speed-Run.bat

`Speed-Run.bat` at the harness root runs `node scripts/speed-run.mjs`: the same speed run as Benchmark all, with KzH closed, double-clicked or started by a Task Scheduler entry the owner makes (6).
The script runs `local.js`'s own speed run (`createLocalModels().benchmark()`), so each model is loaded, measured, refused or skipped as 2.1 to 2.8 say, and its reading goes to `local.json` exactly as the in-app run stores it (2.4), where the Local models card and the install picker find it when KzH starts.
Nothing in KzH starts it or schedules it.

```
Speed-Run.bat                          every installed local chat model
Speed-Run.bat --models qwen3-8b        only the models named, comma separated
Speed-Run.bat --context 24576          the context KzH starts local models with, when the
                                       profile sets one this cannot read
Speed-Run.bat --no-pause               no key press at the end (Task Scheduler)
Speed-Run.bat --verbose                the engine log as it runs
```

- `--models <id>,<id>` measures only those models, each id refused as Benchmark's `ids` are (2.7).
  It also takes the words that follow it, up to the next `--` argument, since PowerShell hands `--models a,b` to a .bat as `--models a b`.
- `--context <tokens>`, a whole number of 2048 or more, says outright the context KzH starts local models with, and always wins over the profile's (below).
- `--verbose` prints the engine log as it runs, and `--no-pause` leaves out the key press at the end.
  The .bat reads `--no-pause` word by word with a `for` loop, so an `&` or a `|` in the arguments breaks no pipe.
- `--harness <dir>` and `--data <dir>` point elsewhere; they default to the harness the script sits in and `<DSH_HOME>/jev-router`, with `DSH_HOME` `~/.kzh` when it is not set, as `Start-KzH.ps1` sets it.

**What it checks before anything is loaded.**
One Speed-Run goes at a time, and that is checked first, so a second Speed-Run meets `Another speed run is going (Speed-Run.bat, pid <n>). Let it finish, or end it, and run this again.` with exit code 3 rather than the first one's llama-server.
`speed-run.lock` in the `speed-runs` folder holds the pid of the one going, and is given back when the script ends.
A lock whose pid is not alive, or now names a program that is not a speed run, is one a crash left, and is taken over; one whose program cannot be read is taken for a speed run.
A lock that cannot be taken for any other reason ends the run with exit code 2.

Then `machineCheck()` reads the running processes, with their pids: on Windows from CIM, with their command lines, or tasklist's names alone when PowerShell fails, and from `ps` elsewhere.
It refuses the run, with exit code 3, while:

- KzH's engine runs (node running `@deepseek-ai/dsh` with `web`, the test `app/main.js` uses), or `Kz-harness.exe` does: `KzH is running (its engine, <name>).` or `KzH is running (Kz-harness.exe).`, then `Close KzH and run this again: the speed run and KzH would load models over each other on one GPU, and both write local.json.`;
- a `llama-server` runs with KzH closed, one a crash left behind, say, which holds memory the readings would lose;
- a `laya.serve` an earlier KzH left running holds memory the same way, found from the pids in Laya's `sidecar.json` that are alive and run `laya.serve`: `Start KzH and close it again, which stops it, or end pid <n> in Task Manager, and run this again.`

Whatever answers on `127.0.0.1:3080` is found by its pid, from `netstat -ano` on Windows and `ss` elsewhere, and looked up in the process list.
On Windows a listening socket is read by its far end, `0.0.0.0:0` or `[::]:0`, so netstat's output is read in any Windows language.
The run goes ahead only when that program's command line can be read and is not KzH's engine: it is another program (LibreChat and GNS3 use that port too), and a note names it and its pid.
Otherwise it is refused, since nobody can tell whether KzH is running: when the owner cannot be found or looked up, and when its command line reads empty, as KzH's engine's does when it runs as administrator.
Every refusal is written in `speed-runs.log` with why (2.13).
Once the checks pass, it prints `Keep KzH closed until this ends: it would load models beside the ones measured.`; a KzH started during a run is not stopped by it.

**The context.**
KzH starts a local model at the plugin config's `local.contextSize` when the profile sets one, and a reading stands only for a load at the context it was taken at (2.4).
So without `--context`, the script reads jev-router's `config.local.contextSize` from `<DSH_HOME>/profiles/web/cordis.patch.yml` and then `<DSH_HOME>/cordis.patch.yml`, the later winning, and uses it, printing `Context: <n> tokens, jev-router's local.contextSize in <file>.`
Only a `contextSize` key under a jev-router entry's `config.local` counts, in the block form or the one-line forms; a comment, a line commented out, another plugin's `contextSize` and an agent's `llm.contextSize` do not.
When a patch file gives jev-router's `local.contextSize` in a form this cannot read (`24k`, or an `!include`), the run is refused with exit code 2 and `<file> gives jev-router's local.contextSize in a form this cannot read. Run this again with --context <the number KzH starts local models with>: ...`.
`<DSH_HOME>` here is the folder above the data folder, so it follows `--data`.

**What it prints and writes.**
A model file placed by hand is hashed once first, as the Local models card does, and Ctrl+C ends that wait.
One whose SHA256 does not match the manifest is then named by the run itself as not measured (2.5), so the run ends with exit code 1 and a scheduled check sees it.
It prints the PC as the install picker does, then names only the models it will measure: `Measuring <names>: a warm-up, the 8,192-token prompt, then three timed requests each.`, or `No model can be measured; each says why below.`
A model the run already knows it cannot measure (2.5) is left out of that line and has its own `NO` line.
Then come each phase, its timed requests said as `timed request <k> of 3` as in the detail log, each model's line as the card has it (2.5), the restore line (2.6), and a table in plain ASCII, whose figures come from `local.speedResults()`: generate and read tokens/s (`cached` where the reading speed was not measured), context, layers on the GPU, VRAM and RAM from the load's memory reading, load seconds and threads.
`local.js` logs the run as it logs the card's runs (2.13), with `Speed-Run.bat` as who started it, in `<data>/speed-runs`, which is `%USERPROFILE%\.kzh\jev-router\speed-runs` on Windows by default.
The script ends with `<n> speed readings saved in local.json, where KzH reads them.` (`1 speed reading` for one), or `No speed reading was saved.`; it does not say that `local.json` is unchanged, since a load writes its memory reading there whatever became of the speed.
Then, only when the logs hold the run, `Every speed run on this PC: <the path of speed-runs.log>` and `This run in detail: <the path of the run's detail log>`.
When a log could not be written it says `The speed run log could not be written: <file>: <code>. This run is not in it, or not all of it.` instead.
When Laya is installed, it says that Laya was not loaded during the run, so the readings stand while no Laya is held beside the model (2.4); with Laya held, Benchmark in the card is the run to make.
A bad argument, or an error nobody foresaw, is written in the history too, its first line, while the console gets the whole of it, since a scheduled run shows nobody its console.

**Stopping it.**
Ctrl+C is answered for the step it lands in.
Before any model is loaded it prints `Cancelling: no model has been loaded yet, so the run ends here.`, ends the wait on a hand-placed file's SHA256 check too, loads nothing, exits with 130 and writes `did not run. Cancelled with Ctrl+C before any model was loaded.` in the history.
The script then exits within a second, even while that hash would go on.
A press while `local.js` is starting the run cancels the run as soon as it exists.
While the run goes, it cancels the run as Cancel does (2.8), and only when there is something to cancel; during the restore it prints why that cannot be cancelled (2.8), and once the run has ended it prints `The run has ended; there is nothing to cancel.`, and the exit code is the run's own.
A second Ctrl+C prints `Stopping at once.` and gives the cancelled model up to 10 seconds to let go of the engine, so the run can end itself and say so.
Only then is the engine stopped from the script, and the restore line then says `the speed run was stopped at once, so nothing was loaded again` rather than that KzH closed (2.8).
cmd then asks `Terminate batch job (Y/N)?`, and N keeps the window open on the results.
Closing the console window (SIGHUP on Windows), Ctrl+Break (SIGBREAK) or SIGTERM would end node without its exit event, and llama-server, which has no console of its own, would outlive the script with its memory.
Each is turned into an exit with 128 plus the signal's number, which runs `local.js`'s exit hook and so stops llama-server.
When that happens while a run goes, the history first gets `<UTC minute>, Speed-Run.bat: ended by <signal> while it measured (its console was closed, or it was stopped). Readings already taken are kept.` with the detail log's name, and the lock is given back.
This ran for real on 26 Sep in the cloud: SIGHUP mid-run gave exit code 129 and left no llama-server running (2.13, "Recorded runs").

Exit codes, for a scheduled run:

- 0: every model was measured;
- 1: a model was not measured, and its line says why, a model whose file does not match the manifest's SHA256 included;
- 2: it could not run: no engine, no model, an unknown model, a bad argument, a manifest that did not load, a context it cannot tell, a lock it cannot take, or Node.js not on the `PATH`, where the .bat says `Install Node.js 22.19 or newer` (the plugin's `engines`); a missing install also names `scripts\Install-Harness.ps1 -LocalModels <id,id|all>`;
- 3: KzH, a llama-server, a Laya left behind or another Speed-Run is running, or a program on KzH's port cannot be told from KzH;
- 130: cancelled with Ctrl+C;
- 128 plus the signal's number, 129 for SIGHUP: its console was closed, or it was ended.

`test/speed-run.test.js` drives the script over the fake llama-server (5.1), and on 26 Sep `node scripts/speed-run.mjs` ran against the real llama-server b10964 on Linux (the status at the top).
`Speed-Run.bat` itself has only been read by its test (plain ASCII, CRLF line ends, cmd.exe's `nul` rather than any Unix redirect, the `for` loop, the line that runs the script and the exit code it passes on) and has never run on Windows.

### 2.13 Speed run logs

Every speed run is logged, from the card and from `Speed-Run.bat` alike, in `<data>/speed-runs` beside `local.json`, which is `%USERPROFILE%\.kzh\jev-router\speed-runs` on the owner's PC.
`index.js` passes that folder to `createLocalModels()` as `speedLogDir`, and `scripts/speed-run.mjs` passes the one under its own data folder.
Who started a run is `local.js` `benchmark()`'s `by`, up to 60 characters: `Settings, Local models` for the card, and `Speed-Run.bat` for the shell.

**The history.**
`speed-runs.log` holds one entry per run, appended when the run ends and never rewritten, in plain text with a blank line after each:

```
<UTC minute>, <who started it>: <k> of <n> measured[, stopped]
  PC: <the PC>; engine: <variant> build <12 hex digits>; budget: <limits set>, GPU layers <setting>; <Laya held on the GPU | no Laya held>
  <model>  <x> tokens/s generating, <y> tokens/s reading, <context>, <g>/<n> layers on the GPU, <v> GB VRAM + <r> GB RAM, loaded in <s> s, <t> threads
  <model>  not measured: <why>
  <the restore line>
  Details: speed-run-<time>.log
```

- The first line says when the run started, to the minute in UTC, who started it, how many of its models were measured, and `, stopped` when it was cancelled.
- The second gives the PC as `specsLine()` does, with commas for its middle dots so the line stays ASCII; the engine build, its variant and the first 12 hex digits of its SHA-256; the budget, that is the VRAM, RAM and cores limits when set and the GPU layers setting; and whether Laya was held, and on which device.
- Then comes a row per model, in the run's order, from `speedFigures()`: generation speed, reading speed or `reading speed not measured (prompt cache)`, context, the layers on the GPU or `layers on the GPU not reported`, VRAM and RAM from the load's memory reading or `memory not reported`, load seconds or `load time not reported`, and threads or `threads not reported`.
  A model not measured has `not measured: <why>`, and one a Cancel dropped from the queue has `not measured: cancelled before its turn`.
- Then the restore line of 2.6, or 2.8's `Stopped. ...` line, and `Details: ` with the name of the run's detail log, followed by ` (incomplete: <what failed>)` when it could not all be written.

A run from `Speed-Run.bat` that never starts (another Speed-Run going, a lock it cannot take, KzH running, a llama-server or a Laya left behind, a program on KzH's port that cannot be told from KzH, no engine, no model, an unknown model or one that cannot be measured, a manifest that does not load, a context it cannot tell, Ctrl+C before any model was loaded, a bad argument or an error nobody foresaw, of which the first line) gets one line, `<UTC minute>, Speed-Run.bat: did not run. <why>`, a blank line after it, and no detail log, so a scheduled run that did nothing says why where the runs are kept.
A run from `Speed-Run.bat` whose console is closed, or that is ended, mid-run gets `<UTC minute>, Speed-Run.bat: ended by <signal> while it measured (its console was closed, or it was stopped). Readings already taken are kept.` and a `Details:` line in place of its entry, since `local.js` cannot finish one (2.12).
A run the card's route refuses is answered in the card's alert (2.7) and is not logged.

A run cut off before its end, KzH ended with taskkill for a restart or an update, or a crash, wrote its detail log as it went but never its history entry, which only its end writes.
So when the local models are next made, at KzH's next start or the next `Speed-Run.bat`, each detail log with no `Ended after` line whose name the history does not give gets its entry:

```
<its start minute> UTC, <who started it>: cut off before it ended (KzH was closed, restarted or updated during it, or it stopped); found when the local models next started
  <each model's line it had reached, or: No model had been measured.>
  Readings of the models it had finished are kept.
  Details: <its name> (it ends where the run was cut off)
```

The console says so too: `local: a speed run cut off before its end is now in speed-runs.log (<name>)`.
While `speed-run.lock` is held by a live pid, a Speed-Run going in another process, the detail logs are left alone, since that one's is still being written.
A run starts only after that check, so a new detail log is never taken for a cut-off one.

**The detail log.**
Each run also gets its own `speed-run-<UTC time to the millisecond>.log` beside the history, for example `speed-run-2026-09-26T04-44-32-561Z.log`, named to the millisecond so no two runs share one.
Its head gives the start time and who started it, the PC, the engine build with its whole SHA-256, the budget, the Laya held, the models in order, and what each gets: a warm-up, the 8,192-token prompt read once, then 128 tokens generated three times, the median kept.
Then comes every step, each with its UTC time to the millisecond: each phase; every line of the local models' log while the run goes, which holds the engine's start with its context, GPU layers and threads, the memory the load took, the layer split and each stop; every line llama-server itself prints, whole lines only, as `llama-server: <its line>`, which holds its load report (the device, how the layers and buffers were fitted, the layer split) and each request's timing lines; the prompt read, with its tokens and tokens/s, or that llama-server read only part of it and took the rest from its cache; each timed request's tokens/s; a request run again, and why; each model's line; the restore; and at the end `Ended after <s> s. The summary is in speed-runs.log.`
It is written line by line as the run goes, so a run that dies leaves what it got to.
llama-server's own lines are about 170 a load and 20 a request on b10964, so a two-model run's detail log is some 600 lines, 65 KB for the run of 05:33 below, where the run's own lines alone were 2.4 KB at 04:44.
Nothing prunes either log.

**When a log cannot be written.**
A log that cannot be written never stops the run, and the readings are stored all the same.
The first failure is kept and nothing more is written to the detail log: the console says `local: the speed run log could not be written (<file>: <code>)`, or `local: the speed run history could not be written (speed-runs.log: <code>)`, `status().speedRun.logError` carries it, the card says at once, while the run still goes, `The speed run log could not be written (<why>); the readings are kept all the same.`, and the history entry's `Details:` line says the detail log is incomplete.

**Where it shows.**
`status().speedRun` gains `log`, `{ history, detail }` with both paths, and `logError`; its `done` lines keep `id`, `ok` and `text`, and `local.speedResults()` gives each line's `ctx`, `reading` and `memory`, or its `why`.
Once a run has ended, the card adds `Logged in <history path>, with this run in detail in <detail name> beside it.` to its status region (2.9), and `Speed-Run.bat` prints both paths (2.12).

**Recorded runs.**
All were in the cloud container on 26 Sep 2026, with the real llama-server b10964 (its Linux CPU build), 1 thread, 16k context and the two 11 MB random-weight test models of the status at the top:

The runs up to 05:00 were taken before the fix of 2.3, so their generation figures read about 0.8 percent high.

- 04:27 UTC, before the fix of 2.2: the byte-token model not measured, HTTP 500 with `The model produced output that does not match the expected Content-only format`;
- 04:29 UTC: Tiny 204.8 tokens/s generating and 1,617 reading;
- 04:32 UTC: Tiny 188.6 and 1,583, Bytes 216.3 and 1,527;
- 04:44 UTC, with the logs: Tiny 205.5 and 1,573, Bytes 199.6 and 1,557, the run 16.3 s end to end, with a history entry and a detail log as this section describes, the detail log then named to the second;
- 04:59 UTC, with the machine check, the lock and the logs: Tiny 218.4 and 1,599, Bytes 212.9 and 1,562, exit code 0;
- 05:00 UTC, SIGHUP sent to the script mid-run, while Bytes read its prompt: exit code 129, the history got `ended by SIGHUP while it measured`, no llama-server was left running, and the lock was given back.

After the fix of 2.3:

- 05:33 UTC: Tiny 177.6 and 1,469, Bytes 195.2 and 1,551, each timed request equal to llama-server's own `eval time` line beside it in the detail log (177.90 and 177.9, 165.95 and 166.0, 177.62 and 177.6 for Tiny), the detail log some 600 lines with llama-server's own.

They show that the machinery works against the real server.
They say nothing about the owner's RTX 3080 or the real models, whose runs belong in the owner's own `speed-runs.log`.

---

## 3. B2: capability

### 3.1 What a score means, and what it does not

A benchmark pass rate says: on three small, self-contained Node.js tasks of this kind, at three levels, this agent as KzH runs it on this PC, forced, at high effort, with one attempt and no review, left the folder in a state its checks accept this often.
It does not say how the agent does on the person's own code, in another language, on work larger than about 6,000 tokens (version 1's largest task holds 1,757, 3.3), with a retry or a review, or at another effort.
For a local model it is over the tasks that fit its window beside an agent's system prompt; a task that does not fit is not run on it and records nothing, neither a failure of the skill nor long context, since the window is KzH's setting and not the model (3.3, 3.9).
An attempt that ended because the machine, the network or the engine failed is run again, not scored (3.6).
Three tasks per skill are few: 2 of 3 is not a precise 67 percent, and every figure on the card carries its count.
That is why the rows go in as evidence at the benchmark's reliability of 0.7, why a whole run weighs on a dimension as three observations do, so it moves a prior only as far as a few observations can, and why the card shows each one beside the prior and the score the Router tab shows.

### 3.2 The skills and the dimensions they credit

The skills are nine of the router's twelve task types, so a benchmark row carries the same `taskType` as a run's own evidence and is weighed by the same task similarity (profiles.js:275).
A task credits the dimensions `TASK_DIMENSIONS` gives its type, without `first_pass_quality` and `reliability`, which `evidenceFromRun` gives rules of their own about how a run went (profiles.js:790, 791), and narrowed where the grading cannot see a dimension.

| Skill (task type) | `TASK_DIMENSIONS` | Credited by its tasks | Why |
| --- | --- | --- | --- |
| `implementation` | coding, first_pass_quality, instruction_following | coding, instruction_following | first_pass_quality is a rule about runs |
| `debugging` | debugging, coding, general_reasoning | debugging, coding, general_reasoning | all three are graded |
| `refactor` | coding, long_context, reliability | coding | a task that fits the window is not long context; reliability is a rule about runs |
| `testing` | testing, coding | testing, coding | all graded |
| `review` | code_review, security_review | code_review | the planted defects are not security flaws |
| `security` | security_review, code_review | security_review, code_review | all graded |
| `performance` | debugging, general_reasoning | debugging, general_reasoning | all graded |
| `simple_change` | instruction_following, reliability | instruction_following | reliability is a rule about runs |
| `investigation` | general_reasoning, explanation, long_context | general_reasoning | an exact answer shows no explanation, and the files are small |

Left out: `architecture` and `documentation`, because no deterministic check can tell a good design or a good document from a plausible one, and a model asked to judge them would make the score that model's opinion; and `other`, which is no skill.
A task that does not fit an agent's window (3.3) is not run on it and gives no row at all (3.9).
The design recorded a `long_context` row of 0 for such a task; the second review of B2 dropped it, since the window is the context KzH gives the model, not what the model can do.
Dimensions no task credits keep what they have: system_design, planning, explanation, frontend, backend, database, tool_use, vision, reliability, first_pass_quality and long_context.

### 3.3 The shape of a task

- A task is a tiny Node 22 ESM project with no dependencies: `package.json` with `"type": "module"` and `"scripts": { "test": "node --test" }`, `src/`, and, for most, a few visible tests in `test/`.
- Nothing is installed and nothing touches the network, so every agent, local ones included, can run it, and a check can never fail for want of a package.
- Its size is bounded by level, counted as the prompt plus every file of the workspace at 4 characters a token (`CHARS_PER_TOKEN`, capabilities.js:176): level 1 at most 1,500 tokens, level 2 at most 3,000, level 3 at most 6,000.
- Whether a task fits an agent is worked out per agent before the run: the agent's window, less 8,600 tokens for the system prompt and tool list an agent's first call carries (local.js:523), less the task's own tokens, less a fixed 2,000 for what its tools print, must not fall below 0.
  A local model's window is the context its next load gets (`contextOf()`), 12,288 to 16,384 tokens once the RAM budget has sized it, so level 1 always fits, level 2 needs a window of about 16k, and a level 3 task near its bound fits none; a cloud agent's window is taken to fit every task.
  The router would not stop such a task, since its context estimate is the task text plus 4,000 tokens (decision.js:228), and compaction at 97 percent of the window would throw the task's files away, so a run would prove the size of the window rather than the skill.
  A task that does not fit is therefore not run on that agent: its task row reads `did_not_fit`, it gives no evidence row (3.9), and the card says `k of 27 tasks fit this model's window` (3.10).
- Version 1's tasks are well under their level's bound: from 185 tokens (simple_change-1) to 1,757 (review-3), and level 3 from 356 (performance-3) to 1,757.
  So with an agent's 8,600 and the tools' 2,000 set aside, all 27 fit a window of 16,384, 26 fit 12,288 (all but review-3), and at 8,192 not even the preflight, 61 tokens, fits.
  The bounds above say what a task may hold, and these sizes decide which tasks a local model's window holds; `node -e "import('./plugins/jev-router/benchmark.js').then(({ loadTaskSet }) => console.log(loadTaskSet().tasks.map((t) => t.id + ' ' + t.tokens).join('\n')))"` prints them.
- A local agent whose window cannot hold even the preflight beside an agent's system prompt cannot be picked (3.8).
- Every agent runs every task that fits it, so a pass rate is over the same tasks for every agent whose window holds them.
- A prompt reads like an ordinary request, names what the task protects (`Do not change the existing tests or package.json.`), and never says benchmark, graded, hidden, evaluation or test harness, since a model told it is being measured may work differently.
  The router adds its usual lines around it (router.js:396): the workspace, not to commit, the handoff note, and to summarize.
- `protect` lists paths whose files at the start an agent must leave alone; a file it adds under a protected folder, such as a test of its own in `test/`, is allowed, because agents often add one and nothing in a prompt forbids it.
  `onlyChanged`, where set, lists the only files that may change, and there an added file is a change.
- Each task has one reference solution or more in the repository, and the suite proves that the untouched workspace fails its grade and every solution passes (5.2).
  A second solution is kept wherever the grade accepts two readings of the prompt or two ways of writing the same thing, so the grade is proven to accept both.

### 3.4 The task set

Version 1 is 27 tasks and the preflight task.
Each prompt below is the exact text sent, line breaks included.
Visible tests show one or two cases; the grade checks what the prompt asks, and a task passes only when every check holds.

#### Preflight: `hello`

Never scored.
It runs first on every agent, and when it fails nothing else runs on that agent (3.8).
Workspace: `package.json` only.

```text
Run node --version in this folder and write exactly what it prints to a new file named hello.txt in this folder.
```

Grade: `hello.txt` exists and its content, trimmed, equals what `node --version` prints when the grader runs it with the same `PATH`.
The file is read as UTF-8 with or without a byte order mark, or as the UTF-16 a Windows PowerShell redirection writes, so what it says counts and not how a shell encoded it.
A version cannot be guessed to its last digit, so a pass shows the agent ran a command in its folder, which every task after it needs.
The preflight has no stored reference solution, since what `node --version` prints depends on the machine: the suite writes `hello.txt` from `node --version` when it runs.
An agent that cannot, Claude Code without `node` among the commands the person's Claude settings allow for one, stops here, before anything else is spent, and the card says why (3.8).

#### implementation-1: `duration-format` (level 1)

Workspace: `src/duration.js` (a stub that throws), `test/duration.test.js` (3723000 and 5000).
Protected: `package.json`, `test/`.

```text
Implement formatDuration(ms) in src/duration.js.
It turns a number of milliseconds into text such as 1h 02m 03s.
Ignore any part of a second.
Leave hours out when they are 0, and leave minutes out as well when hours and minutes are both 0, so 62000 is 1m 02s and 5000 is 5s.
Write minutes and seconds with two digits whenever a larger unit comes before them.
Hours keep counting past 24, so 90000000 is 25h 00m 00s.
A negative number, NaN or Infinity throws a RangeError.
Do not change the existing tests or package.json.
```

Grade: 0, 999, 1000, 59999, 60000, 62000, 3600000, 3723000, 5400000 and 90000000 give `0s`, `0s`, `1s`, `59s`, `1m 00s`, `1m 02s`, `1h 00m 00s`, `1h 02m 03s`, `1h 30m 00s` and `25h 00m 00s`; -1, NaN, Infinity and -Infinity throw a RangeError.

#### implementation-2: `token-bucket` (level 2)

Workspace: `src/limiter.js` (a stub), `test/limiter.test.js` (starts full, refuses when empty).
Protected: `package.json`, `test/`.

```text
Implement createLimiter({ capacity, refillPerSecond, now }) in src/limiter.js: a token bucket that starts full.
take(n = 1) removes n tokens and returns true when at least n are there, and otherwise removes nothing and returns false.
Tokens come back continuously at refillPerSecond, never above capacity, counted from the latest time now() has returned, in milliseconds; a clock that goes backwards adds nothing until it passes that latest time again.
waitMs(n = 1) returns the number of milliseconds, rounded up to a whole number, until take(n) would succeed: 0 when it would now, and Infinity when n is more than capacity.
createLimiter throws a RangeError unless capacity and refillPerSecond are positive finite numbers.
Do not change the existing tests or package.json.
```

Grade, on an injected clock: half a token after 500 ms is not enough and `waitMs` says 500; a long idle refills to capacity and no further; a clock moved backwards adds nothing, and refill resumes only once the clock passes the latest time seen; `waitMs` rounds up (334 ms for one token at 3 a second); `take(0)` is true; each invalid argument throws a RangeError.

#### implementation-3: `log-filter` (level 3)

Workspace: `src/cli.js`, `src/args.js`, `src/filter.js`, `src/format.js`, `data/app.txt` (24 lines of `2026-09-20T10:15:00Z INFO text`), `test/cli.test.js` (`--level WARN`).
Protected: `package.json`, `test/`, `data/`.

```text
Add a --since option to the log tool, which runs as node src/cli.js <file> [options].
--since takes either an ISO 8601 date-time such as 2026-09-20T12:00:00Z or an age: a whole number followed by m, h or d, such as 30m, 12h or 3d, counted back from the time in the environment variable LOG_NOW (an ISO date-time), or from the current time when LOG_NOW is not set.
Only lines whose timestamp is at or after that moment are printed, and --since works together with --level.
For a value that is neither form, the tool prints exactly error: --since expects an ISO date-time or an age like 12h on stderr, prints nothing on stdout and exits with code 2.
Keep the existing options and output format as they are, and list --since in the usage text that --help prints.
Do not change the existing tests, package.json or data/.
```

Grade, spawning the tool: an ISO bound is inclusive; `90m`, `2h` and `1d` against a set `LOG_NOW`; `--since` with `--level`; `3w`, `abc`, `12` and a missing value each print the exact error on stderr, nothing on stdout, and exit 2; `--help` lists `--since`; `--level` alone prints what it printed before.

#### debugging-1: `cart-total` (level 1)

Workspace: `src/cart.js`, `test/cart.test.js` (one order that fails).
Prices are integer cents; a line is price times quantity less the item discount times quantity, and `percentOff` applies to the sum, rounded half up.
The bug takes `percentOff` off each line before the item discount.
Protected: `package.json`, `test/`.

```text
The cart total is wrong for some orders; test/cart.test.js has one that fails.
Find the cause in src/ and fix it.
Do not change the existing tests or package.json.
```

Grade: eight orders, with and without item discounts and `percentOff`, a quantity of 0, a half cent that rounds up, and 100 percent off.

#### debugging-2: `job-pool` (level 2)

Workspace: `src/pool.js` (`runAll(jobs, limit)`; a job that rejects never frees its slot), `test/pool.test.js` (a failing job followed by others, which hangs until the test's 2-second timeout).
Protected: `package.json`, `test/`.

```text
Sometimes runAll in src/pool.js stops starting jobs and never finishes; test/pool.test.js reproduces it.
Find the cause and fix it without changing how results are reported.
Do not change the existing tests or package.json.
```

Grade: five failures under a limit of 2 do not stall; results come back in input order as `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }`; instrumented jobs never run more than `limit` at once; an empty list gives `[]`; a limit above the number of jobs works.

#### debugging-3: `price-cache` (level 3)

Workspace: `ISSUE.md`, `src/cache.js` (an LRU cache with a time to live, on a Map), `src/prices.js`, `src/store.js`, `test/prices.test.js` (basics that pass).
Two bugs: `updatePrice` writes the store and leaves the old price cached until it expires, and setting a key that is already cached leaves it where it was in the eviction order.
`ISSUE.md` says: `After we change a price, some customers keep seeing the old one for up to a minute. Separately, a price that was updated a moment ago sometimes has to be fetched from the store again, while prices nobody touched for hours stay cached.`
Protected: `package.json`, `test/`, `ISSUE.md`.

```text
Read ISSUE.md: users report two problems with prices.
Find the causes in src/ and fix them.
Do not change ISSUE.md, the existing tests or package.json.
```

Grade: an updated price is what the next read returns; a read of a cached price within its time to live does not reach the store, which the grade counts, so a fix that drops the cache fails; after a set on a cached key, that key is evicted last; expiry still works; the capacity holds.
Both bugs must be fixed.

#### refactor-1: `temperature` (level 1)

Workspace: `src/convert.js` (`cToF`, `fToC`, `cToK` and `kToC`, each with the same three-line check that throws `TypeError('temperature must be a finite number')`), `test/convert.test.js`.
Protected: `package.json`, `test/`.

```text
Every function in src/convert.js repeats the same input check.
Move it into one function, assertTemperature, exported from a new file src/check.js, and call it from every function, so that the error message is written in one place only.
Behaviour must not change.
Do not change the existing tests or package.json.
```

Grade: every conversion and every error as before, `-0` and strings included; `src/check.js` exports `assertTemperature`; the message appears exactly once across `src/`; `src/convert.js` imports `./check.js`; and, with the agent's `src/check.js` swapped for one that records its calls and throws the same error, each of the four functions calls `assertTemperature` with its argument.

#### refactor-2: `order-status` (level 2)

Workspace: `src/orders.js`, `src/billing.js`, `src/shipping.js`, `src/report.js`, which use `'pending'`, `'paid'`, `'shipped'` and `'cancelled'` as bare strings, and `test/orders.test.js`.
Protected: `package.json`, `test/`.

```text
The order states are written as bare strings all over src/.
Put them in one frozen object, OrderStatus, exported from a new file src/status.js, with the keys PENDING, PAID, SHIPPED and CANCELLED and the same string values, and use it everywhere in src/ instead of the strings.
Behaviour must not change.
Do not change the existing tests or package.json.
```

Grade: the behaviour tests; `OrderStatus` is frozen with exactly those four entries; outside `src/status.js`, with comments stripped, no string literal equal to a state value is left; every file that used one imports `./status.js`.

#### refactor-3: `callbacks-to-promises` (level 3)

Workspace: `src/read-config.js`, `src/merge.js`, `src/save.js`, `src/index.js`, all with node-style callbacks over callback `fs`, and `fixtures/a.json`, `fixtures/b.json`; no visible tests.
Protected: `package.json`, `fixtures/`.

```text
Convert the callback API in src/ to promises.
Every exported function that takes a callback as its last argument should instead take no callback and return a promise that resolves to the value the callback received, or rejects with the error it received.
Use async and await inside, and node:fs/promises instead of the callback functions of node:fs.
Keep every function's name, arguments and results otherwise the same, and update src/index.js, which uses them, in the same way.
Do not change package.json or fixtures/.
```

Grade: each export returns a promise; the same values on the fixtures, a round trip through `save` in a copy included; a missing file rejects with code `ENOENT`; each function's `length` is its old one less the callback; `main()` in `src/index.js` returns a promise of the same merged output; and no callback function of `node:fs` is called while they run.
The last check wraps those functions before it imports `src/` and hands the wrappers to every import form through `syncBuiltinESMExports()` from `node:module`, so `node:fs/promises`, `fs.promises` and `import { promises } from 'node:fs'` all pass, and a second reference solution uses `fs.promises`.

#### testing-1: `slugify` (level 1)

Workspace: `src/slugify.js`, correct, whose doc comment promises: lower case; accents removed; any run of characters that are not letters or digits becomes one dash; no dash at either end; at most 60 characters, cut back to the last whole word.
No `test/` folder.
Protected: `package.json`, `src/`.

```text
Write tests for src/slugify.js in test/slugify.test.js, using node:test, that check everything its doc comment promises.
Do not change src/ or package.json.
```

Grade (mutants, 3.6): five mutants, each breaking one promise (no lower case; accents kept; runs not collapsed; dashes kept at the ends; no length limit).

#### testing-2: `money-split` (level 2)

Workspace: `src/split.js`, correct: `split(cents, weights)` returns integers that add up to `cents`, shares floored and the remainder given one cent at a time by largest remainder, ties to the earliest; it throws a RangeError for negative or non-integer cents, no weights, a negative weight, or weights that are all 0.
Protected: `package.json`, `src/`.

```text
Write tests for src/split.js in test/split.test.js, using node:test, that check everything its doc comment promises.
Do not change src/ or package.json.
```

Grade (mutants): six (remainder to the last; remainder dropped; ties to the largest weight; negative cents accepted; all-zero weights not refused; shares rounded instead of floored).

#### testing-3: `intervals` (level 3)

Workspace: `src/intervals.js`, correct: `merge(list)` merges inclusive integer intervals that overlap or touch (`[1, 3]` and `[4, 6]` give `[1, 6]`), returns them sorted, never changes its input, and throws a RangeError for an interval whose start is after its end; `subtract(list, cut)` removes a cut from each.
Protected: `package.json`, `src/`.

```text
Write tests for src/intervals.js in test/intervals.test.js, using node:test, that check everything its doc comments promise for both functions.
Do not change src/ or package.json.
```

Grade (mutants): eight (touching not merged; unsorted input returned unsorted; a nested interval lost; the input changed; a start after the end accepted; `subtract` keeps the cut's end points; a cut covering everything leaves `[[]]` instead of `[]`; a cut inside one interval drops its right part).

#### review-1: `pagination` (level 1)

Workspace: `src/paginate.js`, about 40 lines, whose doc comment promises pages counted from 1, a RangeError for a page under 1, `totalPages` of 0 for no items, and a last page that may be partial.
Planted: `totalPages` uses `Math.floor`; the page check is `page < 0`; an empty list gives `Math.max(1, ...)`.
Only `REVIEW.json` may change.

```text
Review src/paginate.js against what its doc comment promises.
Write every defect you find to REVIEW.json in this folder: a JSON array of objects with file (the path from this folder, such as src/paginate.js), line (the line of the defect) and problem (one sentence).
Do not change any other file.
```

Grade (findings, 3.6): all 3 found, at most 2 findings that match none.

#### review-2: `retry-helper` (level 2)

Workspace: `src/retry.js` and `src/http.js`, about 100 lines together.
Planted: `retries` attempts instead of `retries + 1`; the delay's promise is not awaited; the last error is swallowed and `undefined` returned; a 4xx other than 429, which the doc comment calls final, is retried.
Only `REVIEW.json` may change.

```text
Review src/retry.js and src/http.js against what their doc comments promise.
Write every defect you find to REVIEW.json in this folder: a JSON array of objects with file (the path from this folder, such as src/retry.js), line (the line of the defect) and problem (one sentence).
Do not change any other file.
```

Grade (findings): at least 3 of the 4, at most 2 findings that match none.

#### review-3: `inventory` (level 3)

Workspace: `CHANGE.md`, which describes a change just made to reservations, and four files in `src/`, about 200 lines.
Planted: `reserve()` not awaited, so two orders can take the last item; a stock check with `>` where `>=` is meant; a default options object shared and changed between calls; an error path that leaves a reservation held; a weight passed in grams where kilograms are expected.
Only `REVIEW.json` may change.

```text
CHANGE.md describes a change that was just made to src/.
Review the code in src/ for defects, in that change or anywhere else.
Write every defect you find to REVIEW.json in this folder: a JSON array of objects with file (the path from this folder, such as src/stock.js), line (the line of the defect) and problem (one sentence).
Do not change any other file.
```

Grade (findings): at least 4 of the 5, at most 3 findings that match none.

#### security-1: `static-files` (level 1)

Workspace: `src/serve.js` (`resolveRequest(root, urlPath)` returns the file to serve or null, and joins the decoded path with the root without checking where it lands), `public/`, `secret.txt` beside it, `test/serve.test.js`.
Protected: `package.json`, `test/`.

```text
A report says resolveRequest in src/serve.js lets a request read files outside the public folder.
Fix it without breaking normal requests.
Do not change the existing tests or package.json.
```

Grade: `../secret.txt`, `%2e%2e/secret.txt`, `..%2fsecret.txt`, `a/../../secret.txt`, `..\secret.txt` on every OS, and an absolute path give null; `index.html`, `css/site.css` and `a/../index.html` give their path inside the root; a malformed escape gives null without throwing.

#### security-2: `session-cookie` (level 2)

Workspace: `src/session.js` (`sign(payload, key)` gives `<payload>.<signature>` in base64url; `verify(cookie, key, now)` gives the payload or null), `test/session.test.js` (a valid cookie round trip).
Planted: the signature is compared with a prefix of the expected one of its own length, so a cookie with an empty signature verifies; `exp` is never checked although the doc comment says expired sessions are refused; the comparison is not constant-time.
Protected: `package.json`, `test/`.

```text
Review src/session.js for security problems and fix every one you find.
Valid sessions must keep working exactly as they do now.
Do not change the existing tests or package.json.
```

Grade: a missing, empty, truncated or altered signature, an altered payload, another key, and an `exp` in the past each give null; a valid cookie gives its payload; and `verify` calls `timingSafeEqual` from `node:crypto`.
The last check wraps `timingSafeEqual` before it imports `src/` and hands the wrapper to every import form through `syncBuiltinESMExports()`, so `crypto.timingSafeEqual` and a named import both pass, and a second reference solution uses the named import.

#### security-3: `export-links` (level 3)

Workspace: `src/render.js` (the order page escapes the name but not the note), `src/redirect.js` (`safeRedirect(target)` accepts `//evil.example` and `https://evil.example`), `src/csv.js` (a cell starting with `=`, `+`, `-` or `@` is written as it is), `test/web.test.js` (normal behaviour).
Protected: `package.json`, `test/`.

```text
This small web module has security problems in more than one file.
Find and fix them while keeping normal behaviour: pages render the same text, redirects to this site's own paths still work, and exported CSV holds the same values.
Do not change the existing tests or package.json.
```

Grade: `<script>` in a note and in a name comes out escaped; `/orders/7?x=1` is kept and `//evil.example`, `https://evil.example`, `/\evil.example` and `javascript:alert(1)` become `/`; the formula cells `=1+1`, `@SUM(A1)`, `+1+cmd|' /C calc'!A0` and `-2+3` get a leading single quote; `42` and `plain` are unchanged; the plain numbers `-2` and `+1` pass quoted or not; commas and quotes are still quoted.
Plain numbers pass either way because the prompt asks for the same values while the OWASP guidance on CSV injection quotes every cell that starts with one of the four characters, so both readings are right; a second reference solution quotes them.

#### performance-1: `dedupe` (level 1)

Workspace: `src/dedupe.js` (keeps first occurrences in order, compared as `includes` compares, which makes it quadratic), `test/dedupe.test.js`.
Protected: `package.json`, `test/`.

```text
dedupe() in src/dedupe.js is far too slow on large lists.
Make it fast while returning exactly the same results as now.
Do not change the existing tests or package.json.
```

Grade: the same results as the original on NaN, -0 and 0, and objects by identity; 200,000 values, half of them repeats, in under 2 seconds, where the quadratic version takes tens of seconds and a linear one tens of milliseconds, a margin no PC erases.
Every call runs in a child process with a timeout (3.6).

#### performance-2: `word-count` (level 2)

Workspace: `src/search.js` (`createIndex(text).count(word)` scans the whole text with a new regular expression on every call; words are runs of letters, digits and apostrophes, counted case-insensitively as whole words), `test/search.test.js`.
Protected: `package.json`, `test/`.

```text
count() in src/search.js is too slow when it is asked many times about the same text.
Make many calls fast while every call returns exactly what it returns now.
Do not change the existing tests or package.json.
```

Grade: the original's answers on a small text (case, apostrophes, digits, punctuation at word edges, an absent word, the empty string); 20,000 calls over 2 MB of text, building the index included, in under 2 seconds.
Every call runs in a child process with a timeout (3.6).

#### performance-3: `grid-paths` (level 3)

Workspace: `src/paths.js` (`countPaths(grid)` counts the paths that move right or down around `#` cells, by plain recursion, as a BigInt), `test/paths.test.js`.
Protected: `package.json`, `test/`.

```text
countPaths() in src/paths.js takes far too long on grids of 20 by 20 cells or more.
Make it return the same answers quickly on grids up to 60 by 60.
Do not change the existing tests or package.json.
```

Grade: exact BigInt answers on eight grids (a blocked start gives 0n, 1 by 1 gives 1n, several with obstacles, and 60 by 60 open gives C(118, 59)), each in under 2 seconds, in a child process with a timeout (3.6).

#### simple_change-1: `greeting` (level 1)

Workspace: `src/config.js` (`greeting: 'Hello'`), `src/index.js` (`greet(name)` gives `<greeting>, <name>!`), `README.md` (which also says the default is Hello).
Only `src/config.js` may change.

```text
Change the default greeting from Hello to Welcome.
Change only src/config.js.
```

Grade: `greet('Ana')` is `Welcome, Ana!` and nothing but `src/config.js` changed.
The README's Hello is the point: the instruction says to leave it.

#### simple_change-2: `flag-rename` (level 2)

Workspace: `src/cli.js`, `src/options.js`, `src/run.js`, `README.md`.
Only `src/cli.js`, `src/options.js` and `README.md` may change.

```text
Rename the command-line flag --verbose to --debug in src/cli.js, src/options.js and README.md.
Keep --verbose working as an old name for --debug, but when it is used print exactly warning: --verbose is deprecated, use --debug on stderr, once.
The usage text that --help prints must list --debug and not --verbose.
Change no other file.
```

Grade: `--debug` turns debug output on; `--verbose` does too and prints the exact warning once on stderr; `--help` lists `--debug` and not `--verbose`; the README names `--debug` and not `--verbose`; no other file changed.

#### simple_change-3: `upload-limit` (level 3)

Workspace: `src/limits.js` (`MAX_UPLOAD_BYTES = 10 * 1024 * 1024`), `src/errors.js` (`File too large (max 10 MB)`), `src/hint.js` (`Files up to 10485760 bytes`), `src/upload.js`, `test/upload.test.js`.
Only the first three may change.

```text
Raise the upload limit from 10 MB to 25 MB.
Every place in src/ that states or enforces the limit must agree with the new one, and nothing else may change.
Do not change the tests or package.json.
```

Grade: 26214400 bytes is accepted and one byte more is refused with `File too large (max 25 MB)`; the hint says `26214400 bytes`; `10 MB`, `10485760` and `10 * 1024 * 1024` appear nowhere in `src/`; only the three files changed.

#### investigation-1: `config-precedence` (level 1)

Workspace: `src/config.js` (defaults, then `config.json`, then the environment variable `APP_TIMEOUT_MS`), `config.json` (`"timeout": "4s"`).
Only `ANSWER.json` may change.

```text
With the environment variable APP_TIMEOUT set to 2500 and config.json as it is in this folder, what timeout in milliseconds does loadConfig() in src/config.js return, and where does that value come from?
Write the answer to ANSWER.json as {"timeout": <number>, "source": "env" or "file" or "default"}.
Do not change any other file.
```

Grade (answer, 3.6): `{"timeout": 4000, "source": "file"}`, since the code reads `APP_TIMEOUT_MS`, not `APP_TIMEOUT`, and parses `4s` as 4000.

#### investigation-2: `mutating-helper` (level 2)

Workspace: six files of array helpers in `src/`; `topScores` in `src/rank.js` sorts the array it is given through a helper, and the other functions copy first, one of them a local array it then sorts.
Only `ANSWER.json` may change.

```text
One exported function in src/ changes the array it is given.
Write its file and name to ANSWER.json as {"file": "src/<file>.js", "function": "<name>"}.
Do not change any other file.
```

Grade (answer): `{"file": "src/rank.js", "function": "topScores"}`.

#### investigation-3: `request-limit` (level 3)

Workspace: eight files, a router, middleware, handlers and config; a comment in the paging middleware says the limit is capped at 100, the config's `maxPage` is 100, and the items handler applies `anonymousCap`, 50 when there is no `Authorization` header, after it.
Only `ANSWER.json` may change.

```text
A client calls GET /api/items?limit=500 with no Authorization header.
What is the largest number of items the response can hold, and which function sets that number last?
Write the answer to ANSWER.json as {"maxItems": <number>, "function": "<name>"}.
Do not change any other file.
```

Grade (answer): `{"maxItems": 50, "function": "anonymousCap"}`.

### 3.5 Where the tasks live, and versioning

```text
plugins/jev-router/benchmark-tasks/
  task-set.json                  { "id": "kzh-capability", "version": "1", "digest": "<sha256>", "tasks": ["preflight", "implementation-1", ...] }
  preflight/                     task.json, workspace/, grade/, solutions/
  <skill>-<level>/
    task.json                    id, skill, level, dimensions, folder, prompt, protect, onlyChanged, grade
    workspace/                   copied into the agent's folder, CRLF turned to LF
    grade/                       checks the agent never sees; *.test.js run with BENCH_WORKSPACE set
    solutions/<name>/            one reference solution or more, each laid over workspace/ by the suite
    mutants/<name>/, equivalent/ testing tasks only: versions of src/ the agent's tests must fail and pass
```

- `task.json` holds the prompt as one string, the dimensions (checked to be a non-empty subset of 3.2's credited set for its skill), the neutral `folder` name that becomes the package's name, `protect` and `onlyChanged` as paths from the folder, and `grade`: `{ "kind": "tests", "tests": { "<grade file>": <number of tests> } }`, `{ "kind": "mutants", "file": "src/slugify.js" }`, `{ "kind": "findings", "defects": [{ "file", "from", "to" }], "minFound", "maxExtra" }` or `{ "kind": "answer", "expect": { ... } }`.
- `version` is a string, because `normaliseEvidence` keeps `benchmark.version` only as one (profiles.js:232), and every row carries it.
- `digest` is the SHA-256 over every file under `benchmark-tasks/` except `task-set.json`: each file's path relative to `benchmark-tasks/` with forward slashes, a NUL, its content with CRLF read as LF, and a NUL, in the order of those paths sorted by UTF-16 code unit (JavaScript's default sort), so a Windows checkout hashes the same as any other.
  The NUL that ends each file keeps the end of one file's content and the next file's path from running together into the same bytes.
  A test recomputes it and fails on any change with `The task set changed: raise version to "<n+1>" and set digest to "<new>".`, so no task can change under a version already recorded.
- The runner reads the task set again whenever its files or `task-set.json` change: the digest is recomputed at every card read, plan and start, which takes a few milliseconds, so the card's `The task set on disk no longer matches version <v>; nothing can be run until it does.` and the refusal of a plan or a start follow the files on disk, not the first read of the process.
  During a run the digest is checked before each task and again before each grade, since the graders are read from disk.
  A change found before a task stops that agent with `<agent> stopped at <task>: the task set on disk changed during the run and no longer matches version <v>. Nothing is recorded for it.`, status `set_changed`.
  A change found once an agent has worked leaves its task not scored, with `the task set on disk changed while it ran and no longer matches version <v>, so it was not graded`, and stops that agent the same way.
  Every later agent then gets `<agent> was not run: the task set on disk changed during the run.`, and agents that finished before keep what they recorded.
  The review of B2 made it so: before, the set was read once per KzH process, so a branch switch or a pull while KzH ran would have graded with the new graders under the old version and digest.
- Every task file is UTF-8 text that the repository's `.gitignore` does not drop.
  Its `*.log` and `.*` rules (.gitignore:3, 7) would drop a `data/app.log` or a `.gitattributes`, which would exist on the builder's disk, pass the suite and the digest there, and never be committed, so the owner's clone would fail the digest and the task.
  A test runs `git ls-files --others --ignored --exclude-standard plugins/jev-router/benchmark-tasks` and fails on any line it prints, and the validation refuses a task file whose name starts with a dot; that is why implementation-3's log is `data/app.txt`.
- The runner copies a workspace into its task folder with CRLF turned to LF, and the suite grades the reference solutions through the same copy, so the agent gets the bytes the suite proved the grade on, whatever a checkout's `core.autocrlf` did to them.
- The folder lives in the plugin because its graders and the runner are code the plugin tests, and it sits outside `test/`, so `npm test` (`node --test "test/*.test.js"`) never runs a task's own files.
- A new version is a new benchmark for the same id: a run on it replaces the older run's rows for that model as any newer run does (3.9), and the card marks an agent whose last run was on an older version.

### 3.6 Grading

Grading starts once `runRouted()` has returned.
That is after `execute` has awaited the subagent's `dispose()`, which terminates the agent's process and waits for its exit in both providers (1.3), so nothing of the agent is running when its folder is graded; a `dispose()` that failed makes the task `errored` (below).
Nothing of the grading is in the agent's folder while the agent works.

- **Changes:** the runner stages the folder in its own repository (`git add -A`, with `.kz-harness/` excluded as `ensureHandoffIgnored` already does) and reads the changed paths and the patch against the start commit; the patch, cut to 20,000 characters, is kept in the task's row so a result can be read after the folder is gone.
  That repository is kept outside the scratch root, and every git call on the folder runs with the environment of 3.7, so nothing the agent wrote there configures the git that reads its changes (`benchmark.js` `changesOf()`).
- **What npm leaves:** a `package-lock.json`, and a `node_modules/` folder, that appear where `package.json` lists no dependencies are what `npm install` leaves in any project (npm 10 writes the lock file even then), so they are not counted as changes; the task's row names them, and the card's note under the tables says so.
- **Protected files:** every file under a protected path at the start is hashed when the folder is made and again now; a changed or deleted one fails the task with `changed <path>, which the task protects`, and a file the agent added there does not.
- **Only changed:** where `onlyChanged` is set, any other changed or added path fails the task with `changed <path>; only <list> may change`.
- **Outside the folder:** the runner lists every path under the scratch root outside the task's folder, with its size and modification time, before the agent starts and after it ends; a path added, changed or removed fails the task with `wrote outside its folder: <path>`, and a path the agent added is deleted, so no later agent finds it.
  The agent's working directory is the scratch root, not its folder (3.7), so a file written with a relative path lands there, and the prompt's `Workspace:` line, which names the folder by its full path, is the instruction it did not follow.
  The one instruction KzH itself adds that asks for a file names the folder too: the router's prompt names the handoff note by its full path, `Keep <folder>/.kz-harness/handoff.md updated as you work, ...` (`router.js` `handoffIn()`), in the first attempt's prompt, a retry's, the plan step's and the review's.
  An agent that keeps the note it is asked for therefore keeps it in its folder, where `.kz-harness/` is left out of the changes.
  The review of B2 made it so: before, the line named `.kz-harness/handoff.md (in the workspace)`, and an agent that resolved that against its own working directory wrote the note in the scratch root, so an otherwise solved task failed with `wrote outside its folder: .kz-harness`.
- **A listing that stopped short:** a listing of the scratch root reads at most 50,000 entries (`benchmark.js` `LIST_CAP`).
  When the listing before a task stops there, no agent is started: the task is `not_scored` with `the scratch root <path> holds more than 50,000 entries beside the task's folder, too many to check what its agent writes outside it`, and the agent's queue stops with that reason (3.8).
  When the listing after it stops there, a task that would have been graded is `not_scored` with the same reason instead, and the queue stops the same way.
  A listing that stopped short is never read for what the agent wrote outside its folder, so nothing is deleted by it (`outsideChanges()`).
  The second review of B2 made it so: before, a listing past the cap was used as if whole, writes beyond it went unnoticed, and an entry that merely moved past the cap was reported as a change, or deleted as one the agent added.
- **Tests** (`kind: tests`): `node --test --test-reporter=tap <grade files>` runs with `process.execPath`, in an empty temporary folder, through `workspace.js` `run()`, with 60 seconds, and with an environment of `PATH`, `SystemRoot`, `TEMP`, `TMP` and `BENCH_WORKSPACE` only.
  The graders import from `BENCH_WORKSPACE` and spawn `process.execPath` for command-line tasks.
  The task passes when the exit code is 0, the summary's `# pass` equals the number of tests `task.json` gives for its grade files, and `# fail`, `# cancelled`, `# skipped` and `# todo` are all 0; the failing test names, up to ten, become the reason.
  The count is what stops code that ends the process early: a module that calls `process.exit(0)` when a grade test imports it ends that file's child with exit 0, and node:test then reports the file as one passing test and never runs the rest (seen on Node 22.22.2), which "at least one test and no failure" would pass.
  The suite checks each count against a run on the reference solutions (5.2).
- **Performance tasks:** every call of the agent's code runs in a child process, `spawnSync(process.execPath, [<a runner in grade/>, ...], { timeout })`.
  A timed case is measured inside its child, from the agent's own calls only, so the start of a process and the case's own setup are not counted against its 2 seconds, and the child is killed after 4 seconds; an untimed case has 10 seconds.
  The reasons are `took longer than 2 seconds: <seconds>` for a timed case that finished late, `took longer than 2 seconds: stopped after 4` for one that was killed, and `took longer than 10 seconds` for an untimed case that was killed.
  The design had the 2 seconds measured from the parent, and so measured, a reference solution's case failed on a loaded four-core machine.
  node:test's own per-test timeout cannot interrupt a synchronous loop, so without the child a slow answer would hold a core to the 60-second cap, and the untouched grid-paths, whose plain recursion on 20 by 20 never ends, would do so in every run of the suite.
- **Every process a check starts ends with it:** `workspace.js` `run()`, which runs the grades and the checks, kills the whole process tree when a command runs past its time or is stopped, through `local.js` `killTree(pid)`, which walks `ps` on Linux and macOS and uses `taskkill /t` on Windows.
  Before B2 only the direct child was killed on Linux and macOS, so a check or an agent's test that never ends, such as a `node --test` file in a process of its own, kept spinning after its grade had failed; Windows already ended the tree.
- **Mutants** (`kind: mutants`): the agent's tests run on copies of the folder, each run with 60 seconds: the original must pass with at least one test, `equivalent/` (the same behaviour, written differently) must pass, and each mutant laid over `grade.file` must fail.
  The equivalent version is what stops tests that check the source text rather than the behaviour: they kill every mutant and fail it.
  A mutant run that times out counts as survived, since a hang is not a test that caught the mutant; the original or the equivalent timing out fails the task.
  The task passes when the agent's tests pass both and kill every mutant; the reason names the mutants that survived.
  At most four copies run at once.
- **Findings** (`kind: findings`): `REVIEW.json` must parse as an array of objects with a string `file` and a whole-number `line`; a finding matches a planted defect when its path, with backslashes turned to slashes and a leading `./` dropped, equals the defect's and its line lies within `from` to `to`; each defect and each finding is matched at most once, and the matching is the largest there is, found by augmenting paths (`matchFindings()`), so neither how many defects are found nor how many findings match none depends on the order of the defects or of the findings.
  The design said most specific range first; the second review of B2 found that the order the defects were tried in changed nothing, and it was removed as dead code.
  The task passes when at least `minFound` defects are matched and at most `maxExtra` findings match none.
- **Answer** (`kind: answer`): `ANSWER.json` must parse and deep-equal `expect`, strings compared trimmed and paths as for findings.
- A byte order mark at the start of `REVIEW.json` or `ANSWER.json`, which some editors and shells write, is not read as part of the JSON.

A task's outcome is one of:

- `passed`: every check held;
- `failed`: a check did not hold, with the reason, or the checks ran past 60 seconds (`the checks did not finish in 60 seconds`);
- `timed_out`: the attempt ran past `config.agentTimeoutMs`; scored as failed, shown apart, and said in the confirmation (3.11).
  It is told from the attempt's own signal, not from any text: the wrapper around `execute` in `runDepsFor()` (3.8) reads the signal the router hands it (router.js:1173) when `execute` returns, and a reason that is `AbortSignal.timeout`'s, a `DOMException` named `TimeoutError`, while the run's own signal is not aborted, marks the attempt timed out.
  The run itself records such an attempt only as `stopReason: 'error'` or `'aborted'`, whichever way the provider settled it;
- `errored`: an outcome of the machine rather than the agent, not scored, and run again once in a fresh folder (3.8).
  It is an attempt that ended in an error that is neither a timeout nor a usage limit (a dropped network, an engine crash), a `dispose()` that failed (index.js:1359 ignores that today; a benchmark attempt does not), or, for a local agent, a model loaded or unloaded by the engine during the task, which counters of engine loads and RAM-watchdog unloads that `local.js` gains show when read before and after (a watchdog unload, local.js:1083, or another local request swapping the model).
  As built, the counters are `local.js` `engineCounters()`, and the reasons read `it ended in an error (<diagnostic>)`, `its process did not close (<error>)` and `the engine loaded or unloaded a model while it worked`.
  Three more cases are the machine's too: a local agent's model that did not load before its task (`its model did not load (<error>)`), a grade that could not run (`it could not be graded (<error>)`), and a run that failed after its agent worked (`the run failed after its agent worked (<error>)`);
- `did_not_fit`: the task does not fit a local agent's window (3.3); not run, and it gives no evidence row (3.9);
- `not_scored`: a usage limit, a refusal before the attempt started (signed out, excluded by the routing policy, at its limit), a stop by the person, a cancel, or a folder that could not be made.
  As built, a stop reads `it was stopped from the inspector` or `the benchmark was stopped` (3.8), and three more cases are not scored: the chat the benchmark was started from is no longer loaded in the engine, the task set on disk changed while the agent worked (3.5), and a scratch root too big to list whole (above).

Only `passed`, `failed` and `timed_out` are scored as the skill.

### 3.7 The scratch workspace

Every agent the router starts works in the folder of the chat that started it: the pinned engine takes no working directory in a subagent start, and Claude Code and Codex are started in the parent session's folder (1.3), which for a routed run is the chat's workspace (index.js:1340).
This design's review read the pinned engine's subagent start (`@deepseek-ai/dsh-subagent`, `dsh-subagent-claude-code` and `dsh-subagent-codex` at 0.1.5-rc.2) for a working directory per subagent and found none.
The only lever is the parent's session folder; the plugin cannot make a session (it has only `ctx.agents.get`), and handing the engine a copy of the parent with another folder would build on an engine internal that nobody has tried.
So a task folder cannot be an agent's workspace: the agent's working directory, Codex's sandbox and Claude Code's edit permission all cover the chat's folder, and the task folder is named only in the prompt (`Workspace: <folder>. Work only inside this workspace.`, router.js:400).
A task folder in one of the person's projects would put the person's code, and its `CLAUDE.md` and `AGENTS.md`, beside every task, make the score depend on which project it was started from, and let an agent change the person's files where the grading never looks.
So capability runs happen in a workspace of KzH's own that holds nothing of the person's, and the rules below make up for its being shared by every task.

- It is `kzh-scratch` beside the harness folder, the harness's parent joined with `kzh-scratch` (`C:\kzh-scratch` for a harness in `C:\Harness`), outside the harness tree, so neither the task set's graders and solutions nor the harness's own docs are inside any agent's working tree.
  Its path is sent to cloud agents in every prompt; when it holds the Windows account name, as it does for a harness under the user profile, the card says so.
- It is outside every git repository.
  The harness is one, and Claude Code and Codex treat the repository around their folder as the project, so an agent in `<harness>/kzh-scratch` would have the harness's git status, its recent commit subjects and its `CLAUDE.md` in its context, and the graders two folders up.
  `git rev-parse --show-toplevel` run in the scratch root must fail, which `scripts/ensure-no-project.mjs` checks at every start of KzH and the benchmark's routes check at every plan and start; when it succeeds, the script does not add the workspace, and the routes refuse with `The KzH scratch folder <path> is inside the git repository <top>, where an agent would take that repository for its project.`
- `scripts/ensure-no-project.mjs` adds it to DSH's workspace list, titled `KzH scratch`, the way it adds No project, and writes its `README.md`: `Scratch space. KzH creates and deletes folders here; keep nothing of yours in it.`
  When a git repository holds the folder, the script neither makes nor lists it, and prints `kzh-scratch: not added: <path> is inside the git repository <top>, where an agent would take that repository for its project`.
  Before DSH has made its workspace store, the script makes both folders and says nothing, and the next start of KzH lists them.
- The script does its work whenever node runs it, whatever path it is run through: node gives the main module its real path, so the script compares the real path of the file node was asked to run with its own, case-insensitively on Windows, and a harness folder reached through a link or a junction still lists No project and KzH scratch (`runAsScript()`).
  When it is run by its name yet does not resolve to itself, it says so on stderr, `ensure-no-project: <path> did not resolve to <its own path>, so no workspace was listed`, rather than listing nothing in silence.
  The second review of B2 made it so: before, the check compared the path as given, and through a link the script did nothing and said nothing, a regression from the version before B2, and the benchmark card stayed at `The KzH scratch workspace is added to the project list when KzH next starts.` for good.
- The benchmark starts only from a chat whose workspace is that folder: the start route reads the session's root agent with the engine's `agents.get(sessionId)` (as adapter.js:550 does) and refuses any other.
- A normal routed run in it is refused in `route()`: `The KzH scratch workspace is for the capability benchmark only; open one of your projects to run tasks.`
- The whole benchmark runs one task at a time across all its agents (3.8), so while an agent works, the only task folder in the scratch root is its own, and no agent can read or write another's work in progress.
- Each task gets a folder named with 12 random hex characters, so a folder's name says nothing about its agent or task, and a git repository with `core.autocrlf` off, a local user, and one commit of the task's files, so `changedSince()` reports only what the agent did.
- That repository is kept outside the scratch root, in `benchmark-git` beside `benchmark.jsonl` in KzH's data folder, under the folder's name, and every git call on the folder, the benchmark's own and the router's, names it with `GIT_DIR` and the folder with `GIT_WORK_TREE` (`benchmark.js` `gitEnv()`, `prepareFolder()`, `changesOf()`).
  Git never reads a `.git` inside the work tree it is given, so nothing an agent writes into its folder, a `.git/config` or a `.git/info/attributes` that names a filter, configures the git KzH runs there, and an agent's own git commands in its folder find no repository.
  The repository is deleted with its folder once the task is graded, a folder that could not be made whole is deleted with its repository at once, and a start deletes every repository an interrupted run left there, since no run is going then.
  The second review of B2 made it so: before, the repository was the folder's own `.git`, and a clean filter the agent named there ran with KzH's whole environment, keys included, from `git add -A` and from the router's `git status`, `hash-object` and `diff`, and what it printed could reach the patch `benchmark.jsonl` keeps.
- Every git call the benchmark makes, on a task folder and in the scratch root, runs with the agents' scrubbed environment: KzH's less every name holding KEY, PASSWORD, SECRET or TOKEN, every `DSH_` name and every `GIT_` name of KzH's own, with `core.fsmonitor` off (4).
- The runner lists the scratch root before and after each task, and a path outside the task's folder that the agent added, changed or removed fails the task and, when the agent added it, is deleted (3.6).
- A folder is deleted as soon as its task is graded, its patch kept in the row, so no agent can ever read another agent's finished work on the same task.
- A `folder` row naming the folder goes into `benchmark.jsonl` before the agent starts.
  It also lists, as `top`, the names at the top of the scratch root as its task begins, or null when they could not be read.
  At a start, every folder with a `folder` row and no `task` row, which an interrupted run left, is deleted with its repository, and the confirmation names them (3.11).
  For the last such task of the newest run in the log, every entry at the top of the scratch root that its `top` does not list is deleted with the leftover folder, and the confirmation names each one first: `It first deletes 1 task folder an interrupted run left in <root>, and what appeared in <root> after that run's last task began, which its agent may have written outside its folder: notes.txt and src.`, or, when no folder is left, `It first deletes what appeared in <root> after the last task of an interrupted run began, which its agent may have written outside its folder: <names>.`
  An older run's task has no such entries, since the start after it deleted them, and a plan leaves out the rows of the run going.
  The plan id covers these entries, so a start whose list moved is refused with `what else it would delete changed` (3.11).
  Nothing else in the scratch root is ever touched, apart from what an agent wrote outside its folder during its own task and what appeared after an interrupted task began, which is always named first.
  The review of B2 added the entries: before, what an agent had written outside its folder by the time KzH stopped stayed in every later agent's working directory.

### 3.8 The runner, through the normal run path

`benchmark.js` holds the runner; `index.js` gives it one function that runs one task:

1. `route()` is split once: everything it builds around `runRouted()` for a session's root agent (the enabled agents, the key rotation, the quota, `execute` with its subagent start, readiness, the executor registry, `modelOf`, the limit handling, `checkBalance` and `logAttempt`) moves into `runDepsFor({ agent, cwd, sessionId, runId, signal, onEvent, purpose, benchmarkRunId, onExecuted })`, and `route()` calls it, so the two paths cannot drift apart.
   `route()`'s behaviour does not change, and its tests say so.
   The `execute` it builds carries B1's count of local-agent attempts and their wait during a speed run (2.6), and reports each attempt to `onExecuted`, when one is given, with whether the attempt's signal timed out, whether `dispose()` failed, the tokens the subagent reported, the version of the model it ran on when one is known (`modelVersion`, a local model's weights), and, for a local agent, the engine's load and unload counters before and after; `route()` gives none.
   The version is read as the attempt starts and reported at once, so an attempt that rejects still names its weights (3.9).
2. The benchmark's task runner calls `runRouted()` with those deps and:
   - `forceAgent` the agent, and a `config` that is KzH's with its `effort` block replaced by `{ default: 'high', perAgent: {}, codexSpeed: 'normal' }`, so every agent runs at high effort, and Codex at its normal service tier, whatever Settings say.
     `high` is what a forced run under the Auto effort gets when nothing is known about the task (effort.js:103); fixing it means the spend the confirmation states cannot change between the confirmation and the start, and a score does not move when Settings do.
     Each attempt records the effort it ran at;
   - `decider: null` and no `decide` or `outcomeDomain`, so the review is the deterministic fallback (jev-review/index.js:165): no Jev or Laya call, nothing sent to TypeSafe, no routing sample written;
   - `limits` of one work attempt, no review and one round (`maxAttempts: 1`, `maxReviews: 0`, `maxRounds: 1`), because a fallback review's retry goes to another agent (jev-review/index.js:169), which would score the wrong one;
   - `checks` of the task's own `test` script with 120 seconds, the normal checks as the task defines them, which decide the run's own status and are recorded, while the grade of 3.6 decides the score.
     They run with `env` set to the environment the engine gives the agents' own processes, KzH's less every name holding KEY, PASSWORD, SECRET or TOKEN and every `DSH_` name, which `runChecks()` gains as an option and `runRouted()` passes from `config.checks.env`; today the checks run the agent's code with KzH's whole environment (workspace.js:145, 25), TypeSafe's key included (Start-KzH.ps1:20);
   - `config.git.env`, the environment every git call `runRouted()` makes in the workspace runs with, set to the task folder's `gitEnv()` (3.7); `workspace.js` `ensureHandoffIgnored()`, `gatherContext()`, `snapshot()` and `changedSince()` take an `env` for it, and KzH's own environment is used when none is given, so `route()`, which gives none, behaves as before;
   - `offline: false` with no connectivity probe, so nothing reaches a TypeSafe host; a cloud agent without the network fails with its own error, which is `errored` (3.6);
   - a `history` that reads nothing and keeps the run's record for the task's row, so a benchmark run never enters `history.jsonl`, the track record, the feedback priors or the session's verdicts, and `learnFrom()` is never called for it;
   - `logAttempt` writing to `usage.jsonl` as every run does, since real usage is real usage, with `purpose: 'benchmark'` and the benchmark run id on the row; `computeSavings()` leaves such rows out of its agent median, the estimates of 3.10 leave them out of the person's own runs, and the Usage tab marks them.
3. Each task takes the lane of its own folder (`lanes.acquire(laneKey(folder), ...)`), so it counts against the Tasks at once cap like every run and waits with the lanes' own words (`WAITING`, tasks.js:52); one task at a time means the benchmark holds at most one slot.
4. Each task's run is logged under the scratch session like any run (`logRun`), so its events show in that chat's inspector live, and its run id goes into `stoppers`, so the inspector's Stop stops that task: it is not scored, and that agent's run is then incomplete.

The order and the stops:

- The whole benchmark is one queue, one task at a time: the picked local agents first, agent by agent, because they share one engine and the speed benchmark waits for them (2.7), then the cloud agents in the order picked, each agent's tasks together.
  Queues side by side would let every agent read and write the others' folders while they work, since all of them work in the scratch root (3.7).
- Before each of a local agent's tasks the runner loads its model (`local.start(id)`, which does nothing when it is loaded), so any load during the task is one the task did not ask for.
- An agent's queue runs the preflight task, then the 27 tasks in skill order (3.2) and level order; a task that does not fit its window (3.3) is recorded as `did_not_fit` without running.
- An `errored` task is run again once, in a fresh folder; when that errors too, the agent's queue stops with nothing recorded: `<agent> stopped at <task>: it ended in an error twice (<last error>). Nothing is recorded for it.`
- A queue also stops, with nothing recorded for that agent, when the preflight fails (`<agent> could not do the first, one-file task (<why>): it has to run node in its folder. Nothing else was run on it.`, where `<why>` is the preflight's reason, with `Claude Code runs only the commands your Claude settings allow.` added for a Claude Code agent) or when a task is not scored (`<agent> stopped at <task>: <why>. Nothing is recorded for it.`).
- A local agent whose window cannot hold even the preflight beside an agent's system prompt (3.3) cannot be picked: the card shows its box disabled with the reason `<agent> cannot hold even the first, one-file task beside an agent's system prompt in its window of <n> tokens` in the error colour, its estimate gives no line of how many tasks fit, and a plan that names it is refused with 400 and that reason (`benchmark.js` `fitOf()`'s `preflight`, `tooSmall()`, `agentsNow()`'s `why`).
  The runner's `too_small` status, with the line `<reason>. Nothing was run on it.`, is kept only as a guard no plan reaches.
  The second review of B2 made it so: before, such an agent could be picked, its estimate said `0 of 27 tasks fit ...; the other 27 are recorded as long context it cannot hold`, the confirmation promised to run the first task on it, and the runner then ran and recorded nothing.
- A timed-out task is scored as failed and the queue goes on.
- An agent that scored every task but whose rows cannot be made into evidence, such as one whose attempts name more than one model, ends with status `not_recorded` and `<agent> finished, but its results were not recorded: <why>.`, where `<why>` is `profiles.js` `benchmarkEvidence()`'s error, for example `<agent> ran on more than one model during the benchmark (<models>), so its results describe no one model`.
- **Stop** aborts the run and any lane wait of the benchmark; the task under way records itself as stopped (router.js:1390), every agent whose queue had not finished records nothing, and agents that finished keep what they recorded.
  The agent under way reads `<agent> was stopped at <task>. Nothing is recorded for it.`, and each agent after it `<agent> was not run: the benchmark was stopped.`
- A stop is read from who stopped the task, not from how `runRouted()` came back: `index.js` `runBenchmarkTask()` returns `stoppedBy`, `person` for the inspector's Stop and `benchmark` for the benchmark's own, on its normal return as well as when `runRouted()` throws.
  `runRouted()` returns without throwing when a provider settles a stopped attempt as aborted, or when the stop lands after the attempt while the router's git and checks read it as a failure.
  Such a task is `not_scored`, with `it was stopped from the inspector` or `the benchmark was stopped` (`attemptOutcome()`), and is never started again.
  The second review of B2 made it so: before, the inspector's Stop on a provider that settles as aborted read as `errored` (`it ended with aborted`) and the stopped agent was started again at real cost, and a Stop during the checks let the task be graded and scored.
- One benchmark run at a time; a start while one runs is refused with 409.
- A start whose picks include a local agent is refused while a speed run is going (`A speed benchmark is running; start this when it has finished, or leave the local agents out.`), and the speed run's refusal of 2.7 covers the other way round while the queue has a local agent's task left.
- A KzH restart ends the run: `benchmark.jsonl` then holds a run with no end row, which reads as `interrupted`, and every agent without an agent row records nothing.
  KzH closing stops the run the same way, through a disposer in `index.js`.
- A `benchmark.jsonl` that cannot be written as a run starts refuses the start with status 500 and `The benchmark did not start: the benchmark's log could not be written (<error>).`, and nothing is left running, so a later start and the speed benchmark are not held.
- One that cannot be written partway ends the run there.
  A task folder whose `folder` row could not be written is deleted at once, since no later start would find it.
  The agent under way gets `<agent> stopped at <task>. Nothing is recorded for it.`, each agent still waiting `<agent> was not run.`, and the card shows those lines and `The run ended there: the benchmark's log could not be written (<error>).` under `The last run ended early` (3.11); an `end` row with status `failed` and that reason is written when the log takes it.
  Any other failure the queue does not catch ends the run the same way, with `The run ended there: it failed (<error>).`
  The review of B2 made it so: before, a start whose run row failed stayed running until KzH restarted, refusing every start and the speed benchmark, and a failure partway read as `interrupted`.

`benchmark.jsonl` in the data folder holds, in order: a `run` row (run id, task set id, version and digest, the picks, the plan id, the session, whether learning was on), a `folder` row before each task's agent starts (agent, task id, folder, and `top`, the names at the top of the scratch root as the task begins, 3.7), one `task` row per task and attempt (agent, task id, skill, level, folder, whether it was a rerun, subject, model, model version, effort, outcome, reason, duration, tokens, stop reason, error cut to 300 characters, the visible checks' names and results, the grade's detail, the patch, the answer cut to 1,000 characters), one `agent` row when a queue ends (status, its line, its subject, the usage snapshot before and after, how many evidence rows it recorded), and an `end` row.
Every row carries `ts`, the time by the runner's clock at which it was written.
A task row's `subject` is the subject its attempt ran as, through `profiles.js` `subjectOfAttempt`, which is what its evidence records, or null when no attempt ran; a `did_not_fit` row has none.
A task row also keeps the task's wall time from its start to its row, `wallMs`, which the estimate of 3.10 adds up, and `waitedMs` when the attempt waited for a speed run (2.6).
An `agent` row's `line` is the whole sentence the card shows, `<agent> finished: recorded 27 tasks as evidence.` for a finished agent, and its `recorded` is the number of evidence rows it wrote, 45 for a full cloud run and 0 when nothing was recorded, not the number of tasks.
Its status is `finished`, `stopped`, `errored`, `not_scored`, `preflight_failed`, `set_changed`, `too_small`, `not_run` or `not_recorded`.
The `end` row's status is `finished`, `stopped`, `set_changed` or `failed`, and a `failed` one holds `reason`.
The review of B2 put the `subject` on the task rows, `top` on the folder rows and the evidence count in `recorded`; before, an agent row's `recorded` was a number of tasks.

### 3.9 Scoring and the evidence rows

When an agent's queue has scored every task, `profiles.js` `benchmarkEvidence()` turns its task rows into evidence, and `capabilities.recordMany()` writes them as one batch:

```json
{ "ts": "<when the task ended>", "subject": { "provider": "claude-code", "family": "anthropic-claude", "model": "opus", "version": "opus" },
  "dimension": "debugging", "score": 1, "source": "benchmark", "confidence": 0.9, "n": 0.5,
  "taskType": "debugging", "benchmark": { "id": "kzh-capability", "version": "1" }, "runId": "<benchmark run id>", "note": "debugging-2" }
```

- Each row's `ts` is its task row's `ts`: the time, by the runner's clock, at which the runner wrote the task row, right after the task was graded.
  The runner's `append()` hands the stamped row back to the queue for `benchmarkEvidence()`, so decay and the 45-day window of unpinned names count from each task's end.
  The review of B2 made it so: before, the rows carried no `ts`, and the registry stamped the time the agent's whole queue was recorded.
- One row per task and credited dimension, score 1 for passed and 0 for failed or timed out.
  Their mean is the pass rate, which is exactly what the profile's `benchmark.score` reports (profiles.js:333) and the Router tab prints, and one row per task lets `agreementOf` see how split the tasks were, where one row holding a rate would read as unanimous.
- **A task that did not fit gives no row.** A task that does not fit a local agent's window (`did_not_fit`) is not run and gives no evidence row at all: the window is the context KzH gives the model, KzH's own setting and the RAM budget of the moment, not what the model can do, and routing already keeps a task from a window too small for it (decision.js).
  There is no `long_context` row, and `n` stays 3 over the set's tasks that credit the dimension, so a run in which some tasks did not fit weighs less on those dimensions, and such a task still counts as done for the all-or-nothing rule below.
  This replaces the design's one `long_context` row of 0 per task that did not fit.
  The second review of B2 made it so: before, a window KzH had set small wrote a score of 0 under the model's pinned weights that decayed over 180 days and stayed after the window grew, and the card and the Router tab showed `long context 0% (0 of 1)` for a task that never ran.
- The subject is the one the attempt recorded, through the same `subjectOfAttempt` `evidenceFromRun` uses (profiles.js:682): the model the agent ran and, for a local model, the SHA-256 of its weights, so a benchmark row and a run's own row for the same model share a key.
  A local agent's attempt reads the version of the weights it runs on as it starts, and `execute` reports it to the benchmark (`onExecuted`'s `modelVersion`, 3.8) beside the tokens, so an attempt that rejects, as a provider may on the attempt's time limit, still names its weights: the router builds such an attempt's result as `stopReason: 'error'` without them, and the task row takes them from the report (`benchmark.js` `runOne()`).
  The timed-out task is then scored as failed under the weights, like the agent's other tasks.
  The second review of B2 made it so: before, such a row had `modelVersion` null and a subject named by the bare model, `benchmarkEvidence()` saw two subjects, and the whole agent ended `not_recorded` with the false line that it ran on more than one model.
- `confidence` is 0.9, as for a run's own checks: the grading is as deterministic as they are, and what makes a benchmark weaker evidence than a run on the person's own work, being synthetic and small, is what the reliability of 0.7 already says.
- **A run's weight is capped.** `n` is 3 divided by the number of tasks in the set that credit the row's dimension: 12 for coding (0.25), 9 for general_reasoning, 6 for debugging, instruction_following and code_review, and 3 for testing and security_review.
  A whole run therefore weighs on each dimension as 3 observations at the benchmark's reliability do, 3 x 0.9 x 0.7 = 1.89 when fresh, against 4.8 for an owner prior at confidence 0.6 (`priorStrength` 8, routing-policy.js:237).
  With `n` 1 a run would write 45 rows, 12 of them on coding weighing 7.56, more than the owner's prior, which 3.1 rules out: Claude passing 9 of 12 coding tasks would move its coding score from 0.93 to 0.82 on one synthetic run, where with the cap it moves to 0.88.
  A run in which some tasks did not fit weighs less on the skills' dimensions, since only the rows it wrote count; the card prints each dimension's weight beside the prior's (3.11).
- **Not runs.** Benchmark rows are left out of a dimension's `samples` (profiles.js:325), and so out of the profile's `samples`, the ranking's `evidenceRuns` count (broker.js:61), the `evidenceSamples` Jev reads as `verified runs` (jev.js:382), the inspector's `verified runs behind its profile` (client.js:1603) and the Router tab's `observations` (client.js:1780).
  The dimension's `benchmark` summary carries them instead, as `{ score, tasks, passed, weight }` (profiles.js `dimensionProfile`): `score` is the plain pass rate of the rows that count, one row per task so their mean is the rate, `tasks` and `passed` count those rows, and `weight` is what they carry in the score now.
  The card's Weight column reads that weight from `explain()` for the run's own rows, beside the prior's `k0` (3.11).
  Otherwise one benchmark would read to Jev as 45 verified runs for a model that has never run a real task, and its 12 coding rows would count as fully run-backed at `evidenceRuns` 5 (routing-policy.js:326).
- `note` is the task id (at most 200 characters, an inspector label), and nothing of a task's text or the agent's answer is in a row.
- **All or nothing per agent:** a queue that stopped, was cancelled or was interrupted records nothing, so evidence is always a whole task set, never the easy half of one; a task recorded as `did_not_fit` counts as done.
- **A newer run replaces an older one:** in `profiles.js`, a `benchmark` row with a `runId` counts only when its `runId` is the newest recorded for its subject and `benchmark.id`, newest by file order as verdict batches are; older rows stay on file, count in `explain()`'s `notCounted`, and the rule survives a reload.
  Running the same fixed tasks twice measures run-to-run variance, not twice the capability, so counting both would double evidence that is not independent.
  Two picks that resolve to the same subject are refused in one plan (3.11), since both would write rows under the one run id and both would count.
- The benchmark half-life of 180 days applies, and so does the unpinned window: a model KzH knows only by a name its provider may repoint (`opus`, `deepseek-flash`) stops counting a row after 45 days (profiles.js:58); a local model is pinned by its weights and has no such window.
  The design had the card say until when; as built, the note under its tables says a run of such a model stops counting 45 days after it, and gives no date.
- A benchmark alone leaves a model `cold` (profiles.js:608), as today: `cold()` reads false only once a row of another source counts.
- The Router tab shows a dimension that only a benchmark has measured, although its `samples` are 0: the route that serves it keeps a dimension with a prior, a sample or a `benchmark` summary.
- With `routing.learn` off nothing is recorded: the results show on the card and nowhere else, and the confirmation says so before anything runs.

### 3.10 The cost estimate

The estimate for each agent is built from what KzH has measured, and says where each figure comes from; where KzH knows nothing, it says so, and it never invents a price.
It covers 28 runs: the preflight and 27 tasks, fewer for a local agent whose window some tasks do not fit.
Every figure taken from the person's own runs leaves out `usage.jsonl` rows with `purpose: 'benchmark'`, which are an unfinished benchmark's tasks, not the person's runs.

- **Time:** the wall time of each task in its last complete benchmark run, from its start to its row with the grading included (`wallMs`, 3.8), added up; else the median of its completed work attempts in `usage.jsonl` times the number of runs, said to be from other work; else unknown.
  Its line is `About 2 h 10 min by its last benchmark (25 Sep, 28 tasks).`, `How long it takes is not known until it has run once; its runs on your work took a median of 6 min each, about 2 h 48 min for 28 tasks, at whatever effort they ran at.`, or `How long it takes is not known until it has run once.`
- **Tokens:** the last complete benchmark's tokens are one figure per attempt that reported tokens, a rerun's included, and the estimate uses their median where that benchmark left no reading of the spend; else the median of its completed work attempts that reported tokens; else unknown.
  Every multiplied token figure starts with `about`.
- **Local agents** (`kindOf` local): `Free: runs on this PC. ` and the time line, then `26 of 27 tasks fit this model's window of 12,288 tokens beside an agent's system prompt; the other 1 is not run, and records nothing.` (`the other 8 are not run, and record nothing.` for more than one), or `All 27 tasks fit this model's window of 16,384 tokens beside an agent's system prompt.`
  A window that cannot hold even the first task gives no such line, since that agent cannot be picked (3.8).
  A finished agent with tasks that did not fit reads `<agent> finished: recorded 26 of 27 tasks as evidence; 1 did not fit its window of 12,288 tokens and was not run.` (`were` for more than one).
  The second review of B2 made these lines so, with no long context row any more (3.9).
  The design's example, `19 of 27 tasks fit this model's window of 16,384 tokens`, does not describe version 1, whose tasks all fit 16,384 (3.3).
- **Subscriptions:** `Uses your Claude subscription. Weekly window at 42% now, 5-hour window at 10%.`, or `Its windows are not known right now.` in place of the windows, then one of:
  - `The last benchmark on claude (25 Sep, 28 tasks) moved the weekly window from 38% to 44%; other use of the account in that time is in that figure too.`;
  - when that benchmark left no weekly reading before and after it, `The last benchmark on claude (25 Sep, 28 tasks) left no reading of the weekly window before and after it, so what 28 tasks take of it is not known; that benchmark used a median of 41,000 tokens per task, about 1.1 million tokens for 28 tasks.`;
  - with no benchmark yet, `How much of the window 28 tasks take is not known until one benchmark has run; its runs on your work used a median of 41,000 tokens each (38 runs).`;
  then the time line.
  A subscription whose account label is not known right now, as on the first read after KzH starts when the usage snapshot has not answered yet, reads `Uses your subscription.` before its windows.
  The second review of B2 made it so: before, the fallback word went inside the template and read `Uses your subscription subscription.`
- **Metered keys:** `Paid from DEEPSEEK_API_KEY, balance 364.02 CNY.`, or `balance not known right now`, then one of:
  - `The last benchmark on deepseek (25 Sep, 28 tasks) took the balance from 365.10 to 364.58 CNY: 0.52 CNY.`;
  - when that benchmark left no reading of the balance, `The last benchmark on deepseek (24 Sep, 28 tasks) left no reading of the balance before and after it, and KzH has no price table for deepseek, so what 28 tasks cost is not known; that benchmark used a median of 40,000 tokens per task, about 1.1 million tokens for 28 tasks.`, and with balances in two currencies `read the balance in USD before it and in CNY after it` in place of `left no reading of the balance before and after it`;
  - with no benchmark yet, `KzH has no price table for deepseek, so what 28 tasks cost is not known until one benchmark has run; its runs on your work used a median of 38,000 tokens each (42 runs), about 1.1 million tokens for 28 tasks.`;
  then the time line.
  Where the last benchmark left no tokens either, `that benchmark used ...` becomes `KzH has no record of the tokens it used; its runs on your work used a median of <n> tokens each (<k> runs), about <m> tokens for 28 tasks`, and with neither, `KzH has no record of the tokens it used, nor of the tokens its other runs use`; an agent with no benchmark and no tokens of its own reads `KzH has no record yet of the tokens its runs use`.
  The review of B2 made the estimate read the last benchmark's tokens: before, a metered line said the cost was not known until one benchmark had run even when one had.
  Where the config has peak hours for it (`config.pricing.peak`, index.js:147), the rate now as `pricingNow()` words it (router.js:179), and the peak window with whether the run would reach it: `Its peak rate, twice the off-peak price, applies from 01:00 to 04:00 and from 06:00 to 10:00 UTC on weekdays; at its estimated 2 h 10 min, a run started now would reach it at 01:00 UTC.`, with ` on <weekday>` after `UTC` when that is another UTC day, `... a run started now would start in it.`, `... at its estimated 2 h 10 min, a run started now would end before it.`, or `... how long the run takes is not known, so it may reach it.`
- **Warnings**, each on its own line: past the weekly gate (`claude is past its weekly gate (82%, gate 80%): KzH keeps what is left of its window for reviews, and the benchmark would spend it.`); near a limit (`codex is near its limit (<summary>); it may stop partway, and then records nothing.`).
- The measured spend comes from a forced usage snapshot taken before an agent's first task and after its last, kept in its `agent` row: the windows' percentages for a subscription, the balance for a metered key.
- The usage figures the benchmark reads are bounded: the card's and the plan's read waits at most 4 seconds, and the forced read before and after an agent at most 15, and either then falls back on the last snapshot, so a provider that does not answer holds neither the card nor the run.
- The effort and Codex's speed are fixed by the benchmark (3.8), so a figure from the last benchmark was spent as this one will spend; a figure from the person's other runs was spent at whatever effort they ran at, and the line says it is from other work.
- An agent that cannot run is shown unticked and disabled with the reason readiness, the quota or the routing policy gives, word for word.
  As built, the reason reads `<agent> cannot run: <readiness detail>`, `<agent> is at its usage limit until 14:05` (without the time when none is known), or `<agent> is excluded by the routing policy (disabled by configuration)`, with `not in the allowed resources` for an agent outside `routing.allowedResources`.

### 3.11 The card

A **Capability benchmark** card in the Router tab, under "What each resource is believed to be good at", polls `GET /jev-router/benchmark` every 5 seconds, and every 2 while a run goes.
It reads only while the inspector's Router tab is shown: `InspectorBody` hands `RouterView` whether its tab is visible, and `RouterView` hands it to `BenchmarkCard`, as it does for the tab's routing and comparison reads.
The second review of B2 made it so: before, the card kept reading with the inspector hidden, and each read hashes every task file and asks for usage and readiness.

- **What it is**, always shown: `27 fixed tasks in nine skills, each in a new folder with its own checks, run on each agent you pick, forced, at high effort, with one attempt and no review, one task at a time. Small Node.js tasks only: no architecture, documentation, frontend, database or vision work, so those keep their priors.`
- **Where**, one line: in the scratch workspace, `This chat is in the KzH scratch workspace (<path>), which holds nothing of yours: the benchmark runs here.`; elsewhere, `Capability runs happen in the KzH scratch workspace (<path>), so no agent is started in one of your projects. Open it from the project list as KzH scratch, start a chat there, and run the benchmark from that chat's Jev tab.`; not yet in the list, `The KzH scratch workspace is added to the project list when KzH next starts.`; inside a git repository, the refusal of 3.7; a chat the engine has not loaded, `This chat is not loaded in the engine; send any message in it, then try again.`
  When the path holds the Windows account name, a second line: `This path holds your Windows account name, and every task's prompt sends it to the agent.`, with `your account name` on another system.
  When the task set on disk no longer matches its version (3.5), a line in the error colour: `The task set on disk no longer matches version <v>; nothing can be run until it does.`
- **Picks:** every enabled agent, unticked, with its kind (subscription, API key, local), its estimate lines (3.10), and its last run's date and version; none is ever ticked for the person.
  As built, a pick shows the agent's id, its kind as a pill, and its subject as `<family> <model>`; an agent that cannot run has its box disabled and its reason under it in the error colour, warnings follow the estimate lines, and the last run reads `Last run 25 Sep, version 1: finished.`, with `, older than the task set` after the version when it is older.
  Its day is written as every date on the card is (`benchmark.js` `dayText()`, with the year when it is not this one), and how its queue ended in the words of `AGENT_STATUS_WORDS`, for example `Last run 20 Dec 2025, version 1: its window cannot hold the first task, so nothing ran.`; `GET /jev-router/benchmark` gives each `lastRun` its `day` and `statusText`.
  The words for how an agent's queue ended are `finished`, `stopped`, `stopped after an error twice`, `stopped at a task that was not scored`, `could not do the first task`, `stopped: the task set changed`, `its window cannot hold the first task, so nothing ran`, `not run`, and `finished, but its results could not be recorded`.
  The second review of B2 made it so: before, the pick used the browser's date format (`Dec 20`, no year) beside `20 Dec 2025` in the Run column, and printed the status code with its underscores replaced (`too small`, `set changed`).
  Two picks that resolve to the same subject are refused: `claude and claude-work both run anthropic-claude opus, and one run records one set of results per model; pick one of them.`
- **Run on N agents** is enabled only in the scratch workspace, with at least one pick, while no run goes and while the task set on disk matches its version; when it does not, the error line of **Where** stands beside a disabled button.
  The second review of B2 made it so: before, the button stayed enabled under that line, and the person learned why only from the plan's 400.
  It asks the server for the plan, whose confirmation the server writes, and shows it in the existing `Confirm` (client.js:390).
  `Confirm` keeps its title and its buttons in view however long its body is: its box is a column at most the window's height less 48 pixels, padding included, and the body scrolls between the title and the buttons (`.jevi-modal .box.confirm`).
  The second review of B2 made it so: before, the box had no height limit, and the centred overlay put a confirmation taller than the window partly above its top edge, where it cannot be scrolled to, so on a 1366 by 768 laptop the four-agent benchmark confirmation lost its title and its first paragraph, which says what the run does.
  The confirmation reads:
  - title `Run the capability benchmark on 3 agents?`, button `Run on 3 agents`, the body shown one paragraph per line, which `Confirm` now takes as a list;
  - body: `Runs the first, one-file task, which is not scored, and 27 more on each of claude, codex and deepseek, one task at a time, agent after agent, each in a new folder of the KzH scratch workspace, with the agent forced, at high effort (Codex at normal speed), one attempt, no retry and no review.`, then `A task that runs past the 20-minute limit counts as failed. One that ends in an error of the machine or the network is run once more, and a second error stops that agent with nothing recorded.`, then `Each folder is deleted once its task is graded, and what the agent changed in its folder is kept with the result.`, then `Anything that appears elsewhere in <scratch root> while a task runs is deleted, and fails that task; only its path is kept with the result.`, then each agent's spend lines from 3.10, then `The benchmark takes one slot under your Tasks at once budget like any run, so your own tasks may wait for a free slot.`, then, when there are any, `It first deletes 3 task folders an interrupted run left in <path>.`, or the longer line of 3.7 when an interrupted task left entries beside its folder, then `Results are recorded as capability evidence for every agent that finishes all its tasks: source benchmark, weighed at 0.7 of a run's own checks, a whole run counting on each dimension as three observations.` or `Learning is switched off, so the results are shown here and recorded nowhere else.`
  - With one agent, the first paragraph reads `Runs the first, one-file task, which is not scored, and 27 more on claude, one task at a time, each in a new folder ...`; when the picks run different numbers of tasks, as a local agent whose window some tasks do not fit does, it reads `and up to 27 more on each of ...` and ends with ` A local model runs fewer: a task that does not fit its window is not run, and records nothing.`
    The second review of B2 counted the first, one-file task apart from the scored tasks, and added the fourth paragraph, which names what else a run deletes: before, the confirmation said `Runs 28 tasks` while the card said 27, with nothing saying why, and named only the task folders, saying what the agent changed is kept, which was false for what it wrote outside its folder.
  - The start carries the plan id the server gave with that text.
    The plan id is a random id that `POST /jev-router/benchmark/plan` gives with its confirmation and keeps in memory with what the plan covers, good for one start within 30 minutes (`benchmark.js` `PLAN_TTL_MS`); KzH keeps the 20 newest, and a restart forgets them.
    A start refused because a run is already going leaves the id as it was; any other start takes it at once, so it is never good for a second start, whatever becomes of the first.
    A start with an id the route never gave, one already used, or one over 30 minutes old is refused with 409: `This confirmation cannot start a run: KzH did not give it, or it has already started one; review it again.` or `This confirmation cannot start a run: it is over 30 minutes old; review it again.`
    The start still works the plan out again and refuses with 409 one whose key (`benchmark.js` `planKeyOf()`, a hash of what the plan covers) moved: `What the benchmark would run or spend changed since you confirmed it (<what>); review it again.`, with the words of `planChanges()`.
    The key covers the task set's id, version and digest, each pick's id, kind, model, subject, state and gate, each local pick's window, whether learning is on, the folders to delete and the entries beside them of 3.7, and not the live percentages and balances, which move by the minute; the effort and Codex's speed are fixed by the benchmark, so Settings cannot change them after the confirmation.
    The second review of B2 made it so: before, the plan id was that hash itself, so it stayed good after the run it confirmed, across restarts, and could be worked out, and a replayed or worked-out start spent cloud usage with no confirmation shown for it.
- **Progress:** per agent, `12 of 28: 9 passed, 2 failed, 1 timed out; 1 run again after an error` (and `3 did not fit` for a local agent), the task under way with its elapsed time (`running debugging-2, 2 min`, or the lanes' `Waiting for a free slot` line), and when its queue ends, `finished: recorded 27 tasks as evidence`, `finished: not recorded, learning is off`, or its stop line from 3.8.
  As built (`client.js` `benchmarkProgress()`), a progress line names the agent, counts only its scored tasks that fit its window, and says how the first, one-file task went before them: `claude: first task passed; 12 of 27: 9 passed, 2 failed, 1 timed out. Running debugging-2, 2 min.`, with `; 1 run again after an error` after the counts when there was one.
  Before the first task has ended it reads `claude: 0 of 27: 0 passed, 0 failed. Running preflight, 5 s.`; the run's agents carry `first`, the preflight's outcome, and `total`, the number of scored tasks that fit.
  The counts are followed by `Running debugging-2, 2 min.` (seconds under a minute), the lanes' waiting line, `Starting.` before its first task with no read under way, or the end line.
  While the runner reads a cloud agent's usage before its first task or after its last, which may take up to 15 seconds, the agent's progress carries a `phase`, `spend-before` or `spend-after`, and its line ends `Reading its usage before it starts.` or `Reading what it spent.` in place of `Starting.`
  The second review of B2 made it so: before, the progress counted the unscored first task as a pass (`28 of 28: 28 passed` beside `recorded 27 tasks`), and an agent that had done all its tasks read `Starting.` while its spend was read.
  An agent's end line names the agent too, since the last run's lines are also shown on their own under the card: `<agent> finished: recorded <n> tasks as evidence.`, `<agent> finished: recorded 26 of 27 tasks as evidence; 1 did not fit its window of 12,288 tokens and was not run.` (3.10), or `<agent> finished: not recorded, learning is off.`
  An agent still waiting reads `<agent>: waits for its turn.`, and one that was not run, or whose window was too small, shows its line alone.
  **Stop** asks first: `Stop the benchmark?`, `The task under way is stopped. Every agent that has not finished all its tasks records nothing; agents that finished keep what they recorded.`, button `Stop`.
- **The last run**, once none goes, under the card: `The last run finished.`, `The last run was stopped.`, `The last run was interrupted: KzH stopped before it ended, and every agent that had not finished records nothing.`, or, for any other end (`failed`, when its log could not be written or the queue failed, or `set_changed`, when the task set changed under it), `The last run ended early, and every agent that had not finished records nothing.`, each followed by its agents' lines, which say why.
- **Results,** two tables, both with a sort toggle on every column header (none, ascending, descending, announced with `aria-sort`) and a filter field under every header (case-insensitive, on the text the cell shows, all filters together):
  - **By dimension**, one row per agent and dimension its last finished run recorded: Agent, Model, Dimension, Benchmark (`67% (2 of 3)`, sorted by the rate), Weight (`1.9 against the prior's 4.8`: the run's weight on that dimension now, beside the prior's; `1.9, with no prior` where the Prior column reads `none`; `not recorded (1.9 had it been)` when learning was off, and `no longer counted` when a newer run or the unpinned window took it away), Prior (the prior `priorFor()` gives that model, `0.85, owner prior` or `0.64, family prior`, or `none`), Profile now (the score the Router tab shows after the benchmark, with its evidence note: `88%, well evidenced`, `some evidence` or `little evidence`, or `unknown`), Skills (the skills whose tasks credited it), Run (date and version, marked when the version is older than the task set's).
    The second review of B2 gave the Weight cell its words for a dimension with no prior: before, it read `1.9 against the prior's 0.0` beside a Prior of `none`.
  - **Tasks**, one row per task and attempt: Agent, Task, Outcome, Why, Skill, Level, Time, Tokens, Effort, Run, so the narrow inspector shows what came of a task beside it.
    A Why cell shows at most three lines, with the whole reason as its title, and its filter reads the whole reason.
    The Skill of the preflight reads `first task`, and an Outcome reads `passed`, `failed`, `timed out`, `errored`, `did not fit` or `not scored`, with `, run again` on a rerun.
    The table holds the tasks behind every dimension row: for each agent, the tasks of its last finished run, which the By dimension table is read from, and beside them the tasks of its latest run when that run did not finish, whose Run cell ends `, <how it ended>; not recorded`, for example `27 Sep, version 1, stopped; not recorded`, in the words of `AGENT_STATUS_WORDS` (the picks above).
    The second review of B2 made it so: before, the Tasks table read each agent's last run of any status, so after a later run that stopped, an agent's standing dimension rows stayed while the tasks behind them left the table; and at a 340-pixel sidebar only Agent, Task, Skill and Level showed, and one reason made a row 390 pixels tall.
  - An empty table reads `No agent has finished a run yet.` or `No task has run yet.`, and one whose filters match nothing `No row matches the filters.`
  - Under them: `Pass rates are over three small tasks per skill, so 2 of 3 is not a precise 67%. Prior is the owner's starting observation. Profile now is the score the Router tab shows, read with no task type; routing reads each dimension for the task's own type, which counts benchmark rows of other skills at a half or a quarter, so a routed task can read a different number. A whole run weighs on a dimension as three observations at 0.7 of a run's own checks, and halves every 180 days; for a model KzH knows only by name it stops counting 45 days after the run. A package-lock.json that npm install writes in a task with no dependencies is not counted as a change.`
- The sort and filter live in pure helpers, `sortRows` and `filterRows`, and one `SortTable` component renders any table of `{ key, label }` columns and `{ text, value }` cells, so the next table gets the rule for free.
  Each header is a button titled `Sort by <column>` that shows ▲ or ▼ while it sorts, and each filter is a search field labelled `Filter <column>`; numbers sort as numbers, a blank sorts last either way, and rows that compare equal keep their order.
  In the results tables a blank cell, such as the Time and Tokens of a task that did not fit and never ran, has the value null, so it sorts last either way; -1 stands only behind a word that should sort below every figure (`none`, `unknown`, `not recorded`).
  The second review of B2 made it so: before, a blank Time or Tokens cell had the value -1 and sorted first when ascending, while a blank Effort sorted last.
  Every sortable table scrolls within a height of its own, at most 60 percent of the window, so its scroll bars stay in view, and a column marked `clamp` shows at most three lines of a cell (`SortTable`); before the second review of B2, the Tasks table's one horizontal scroll bar sat under its last row, nearly 3,000 pixels below its header.
- The Router tab's profile line keeps `benchmark N%` and adds the tasks, `benchmark 75% (9 of 12 tasks)`, and one task in the singular, `benchmark 100% (1 of 1 task)`; its lead line names the benchmark among what moves a prior.

### 3.12 Routes

- `GET /jev-router/benchmark?session=<id>`: the task set (id, version, the skills with their task counts and credited dimensions), where the session stands (3.7), whether learning is on, the agents with their estimates, the run under way, and the two results tables' rows.
  As built it also carries `what` and `note`, the card's fixed texts, whether the task set's digest holds, `last`, the last run's end and lines once none goes, each agent's `lastRun` with its `day` and `statusText` (3.11), and `leftovers`, how many folders and entries a start would delete first; a session that is not a session id is refused with 400 and `session: a session id`.
  It reads the run going and `benchmark.jsonl` together, after its reads of the agents, readiness and usage, which may take seconds: a run is then either still going, or has ended with its end row in the log, which the runner writes before it lets go of the run (`benchmark.js` `state()`).
  The second review of B2 made it so: before, the log was read beside those reads and the run going after them, so a read that a run's end overtook answered `run` null with the log as it was before the end, and the card said `The last run was interrupted: KzH stopped before it ended` of a run that had finished, without its last agent's lines and results, until the next poll.
- `POST /jev-router/benchmark/plan` with `{ session, agents }`: 200 with `{ planId, confirm: { title, body, confirmLabel } }`, 400 for a pick that cannot run, two picks with one subject, a session outside the scratch workspace, or a scratch folder inside a git repository.
  A local agent whose window cannot hold even the first task is a pick that cannot run, with the reason of 3.8.
  As built, 400 also for a chat the engine has not loaded, a task set whose digest does not hold (`The task set on disk no longer matches version <v> of it (its files hash to <12 hex>, not <12 hex>), so no result could say which tasks it was over.`), `agents` that is not a list of ids, at least one, each once (`agents: the ids of the agents to run, at least one, each once`), and an id that names no enabled agent (`No enabled agent is named <id>.`); outside the scratch workspace it reads `The capability benchmark runs only from a chat in the KzH scratch workspace (<path>).`
- `POST /jev-router/benchmark/start` with `{ session, agents, planId }`: 200 with `{ runId }`, 400 as for the plan, 409 for a plan id it cannot take (one the route never gave, one already used, or one over 30 minutes old, 3.11), a changed plan, a run under way (`A capability benchmark is already running.`), or a speed run with local picks, and 500 when `benchmark.jsonl` cannot be written (3.8).
- `POST /jev-router/benchmark/stop`: 200 with `{ ok: true }`, also when nothing runs.

---

## 4. Privacy

- The tasks are fixed synthetic projects in the repository.
  Nothing of the person's is read into a task, a prompt, a grade or a speed request.
- No agent is started in one of the person's projects: capability runs happen in the scratch workspace (3.7), and the benchmark reads and writes none of `history.jsonl`, the feedback, the track record or a project's handoff note.
- No Jev or Laya call is made and no connectivity probe is sent, so nothing reaches TypeSafe.
- A cloud agent receives the task's files and prompt, the router's usual lines and the scratch folder's path, which the card says when it holds the account name, plus its own global setup (`~/.claude`, `~/.codex`) exactly as in every run of that command-line tool.
- What is kept, all on this PC: `benchmark.jsonl` (ids, numbers, outcomes, short reasons, the patch and up to 1,000 characters of the agent's answer, all about synthetic tasks), `usage.jsonl` rows as for any run, marked, the evidence rows (ids, numbers and the task id), the speed readings in `local.json` (numbers), and the speed run logs (2.13: the PC's hardware line, the engine build, the figures and the local models' own log lines during each run).
- No key of KzH's is in the environment of the agent's code: Claude Code's and Codex's processes get the engine's scrubbed environment, as a local agent's commands do by the engine's documented rule (1.3), the run's checks get the same (3.8), and the grader gets five variables and nothing else (3.6).
- Every git call the benchmark makes, on a task folder and in the scratch root, runs with the agents' scrubbed environment (`benchmark.js` `gitEnv()`: KzH's less every name holding KEY, PASSWORD, SECRET or TOKEN, every `DSH_` name and every `GIT_` name of KzH's own) and with `core.fsmonitor` off, so nothing git starts there, a filter of the person's own git config included, has a key of KzH's.
  A task folder's repository is kept outside the scratch root (3.7), so no filter an agent names in its folder runs at all.
  Grading and the checks still run code the agent wrote with KzH's own rights, as every run's checks already do; there is no sandbox around it.
- What keeps tasks apart, and what does not:
  - One task runs at a time across the whole benchmark, and a folder is deleted once it is graded, so no other agent's work, in progress or finished, is ever in the scratch root beside a task.
  - An agent's working directory is the scratch root, not its task folder, because the pinned engine starts every agent in its chat's folder (3.7); only the prompt's `Workspace:` line points it at the task folder.
    Codex's sandbox and Claude Code's edit permission therefore cover the whole scratch root, and a file an agent writes there outside its folder fails its task and is deleted (3.6).
  - The scratch root is outside the harness folder and outside any git repository, so no agent's context carries the harness's git status, its commits or its `CLAUDE.md`, and nothing of the task set is inside its working tree.
  - Nothing keeps an agent from reading the rest of the disk: Codex's sandbox allows reads anywhere, and the graders and reference solutions are in the harness folder beside the scratch root, where an agent that searched the disk could find them; a result would show that only as a pass, and detecting it is not built (6).
- The tasks are in a public repository, so a model trained after they were published may have seen them; a new version of the task set is the remedy, and the card shows each run's version.

---

## 5. Tests

Every new test fails on the old code, proven with `node scripts/red-check.mjs <test files> --base a1e42b4`, and the full suite stays green (`npm --prefix plugins/jev-router test`: 1200 tests, 1199 pass, 1 skipped on Linux at the base).
A new test in a file the base already has first asserts that each new export it uses exists, reached through a namespace import or a dynamic `import()`, for example `assert.equal(typeof local.readTimings, 'function')`, as test/decision.test.js:850 does.
At the base it then fails on an assertion, which red-check counts; calling the missing export would fail with a TypeError, which red-check refuses (scripts/red-check.mjs:232), and a static named import would stop the whole existing file from loading at the base, which it refuses too (scripts/red-check.mjs:336).
This holds for `readTimings`, `speedFor`, `reload` and the speed run in `test/local.test.js`, `speedLine` in `test/budgetpanel.test.js`, `sortRows` and `filterRows` through the client's `__test` in `test/routerview.test.js`, and `benchmarkEvidence` in `test/profiles.test.js`.

### 5.1 B1, with a fake llama-server

The design had `test/local.test.js`'s `fakeEngine()` extended; B1 was built instead over a shared fake llama-server, `test/fixtures/fake-llama-server.mjs`, which answers `/completion` and `/tokenize` as llama-server does, with `timings` a test sets, and keeps each request's URL, headers and body.
The list below is the design's; what was built follows it.

- `readTimings()` works both speeds out from the counts and the milliseconds, and refuses a body with no `timings`, a missing or non-positive field, or `predicted_n` other than `n_predict`, each with its reason.
- A speed run reloads the model through `reload()`, which waits until nothing holds the engine and then stops and starts it at the planned context, also when that model was loaded already, where `acquire()` alone would reuse the old load.
- It sends a warm-up, a `/tokenize` of the speed text, a fill of exactly its first 8,192 tokens with `n_predict` 1 and `cache_prompt: true`, and three measured requests with the same tokens, `n_predict` 128, `ignore_eos`, `cache_prompt: true` and `temperature` 0, all with the engine's key, and records the median and all three runs under `<id>@<ctx>`.
- The reading's key and conditions come from the engine that ran (its context, threads, GPU room and layers setting), not from a `planFor()` made after it: a budget changed while the model was loaded gives a reading under the loaded context, not the new plan's.
- A speed text shorter than 8,192 tokens records nothing with its reason; a fill that processed fewer than 8,000 tokens keeps generation speed and says prompt speed was not measured.
- Three generation speeds more than 15 percent apart record nothing, with the reason; a measured request during which another request reached the engine, or Laya's `busy()` read true, is repeated, and after three repeats the model records nothing.
- A reading stands only for the same weights, context, GPU room, GPU layers setting, threads, engine build, depth and Laya device, and each difference gives its own words; a plain load after the reading keeps it.
- The whole run is refused, each with its exact text, while a local model is answering, while a local agent's attempt is in flight between its model calls (where `isBusy()` reads false), and while Laya is answering; a model over the RAM budget is skipped with `planFor()`'s refusal word for word, and the others are measured.
- While a speed run goes, a local agent's attempt waits before its subagent starts, with its line, and starts when the run ends.
- The model loaded before is loaded again; an engine that was stopped is stopped again; the loaded model is measured last, so the run ends with it loaded.
- Cancel mid-measurement aborts the request, records nothing for that model, keeps earlier readings and restores; cancel during loading stops the engine at once, without waiting for `/health`.
- A `setSettings()` and a `recordMemory()` interleaved with a speed write keep all three changes in `local.json`.
- `buildCatalog()` rates an installed model with a standing reading as measured, with its label, `wordsPerSec`, `fit` and `source`, and every other one as estimated; a reading with no GPU split keeps the estimated fit and says so; `/install-llm` prints the measured label; `suggest()` is unchanged; `status()` carries each model's `rating`.
- `test/budgetpanel.test.js`: `speedLine()` for a standing reading, one that does not stand, and none, the range where the GPU's size is unknown included; a model's memory line carries the date of a measured figure.
- `test/speed-routes.test.js`, new: the routes, through `apply()` with a minimal fake host in the test file: 200, 400 and 409 from `POST /jev-router/local/benchmark`, the Laya-busy and local-agent refusals, and cancel.

As built, B1's tests are 15 new in `test/local.test.js`, 4 new in `test/budgetpanel.test.js` and 3 in the new `test/speed-routes.test.js`, and red-check passes on all 22 against `9d21fae`, the commit before B1, whose plugin code is `a1e42b4`'s.
`apply()` takes a `localModels` seam, passed to `createLocalModels`, so the routes test runs models of its own over the fake llama-server; at the base those tests fail on that seam.
The existing tests that pinned a model rating's shape and a measured memory line without its day were changed with the rule.
A test beyond the list covers a watchdog unload mid-measurement and a load that fails.

The review of B1 added 9 tests and renamed one, 10 new by name, and red-check passes on all 10 against `914d8d4`, the B1 commit: 1 in `test/router.test.js` (the attempt clock), 1 in `test/speed-routes.test.js` (a wait longer than `agentTimeoutMs` through `apply()`, whose `plugin()` helper now takes a config to lay over its own), 6 in `test/local.test.js` with the `speedFor` test renamed to name the weights, and 1 in `test/budgetpanel.test.js`.
The test of a prompt read again scales time by replacing `AbortSignal.timeout` inside the test and restoring it after.

Checked on 25 Sep at `c0ef03c`: `node scripts/red-check.mjs plugins/jev-router/test/local.test.js plugins/jev-router/test/budgetpanel.test.js plugins/jev-router/test/speed-routes.test.js plugins/jev-router/test/router.test.js --base 9d21fae` finds 31 new tests (21, 5, 4 and 1), and all 31 fail at the base by an accepted kind; the same files against `914d8d4` find the review's 10, and all 10 fail there.
The full suite at `c0ef03c` is 1231 tests, 1230 pass, 0 fail, 1 skipped on Linux.

The streamed requests (2.2, 2.3), the speed run from a shell (2.12), the speed run logs (2.13) and the reviews of that work added 28 tests by name: 18 in `test/speed-run.test.js`, 7 in `test/local.test.js`, 1 in `test/budgetpanel.test.js` and 2 in `test/run-as-script.test.js`.
`test/speed-run.test.js`, new, the own test file of `scripts/speed-run.mjs`, has 18, driven through `main()` over a harness of its own and the fake llama-server: the whole run, with the readings in `local.json`, the table and the logs; `--models` and its refusals, each written in `speed-runs.log`; a model not measured giving exit 1; the refusal while KzH runs, before anything is loaded, with why written in `speed-runs.log`; `machineCheck()`, where KzH's engine or app, a llama-server or a Laya left behind each stop the run and a program on KzH's port is looked up by its pid; `processList()` from CIM, tasklist and `ps`, and `portOwner()` from netstat and `ss`; Ctrl+C before any model is loaded; the lock; the console closed mid-run; a model whose file does not match the manifest, named as not measured so the run exits 1; Ctrl+C mid-run; the arguments, PowerShell's split `--models` among them; the profile's context, where a comment or another `contextSize` is not it; a bad argument or an error nobody foresaw written in the history; Ctrl+C once every model is done, and a second Ctrl+C mid-run that lets the run end itself; a speed run log that cannot be written, said at the end with no paths given as if the logs held the run; the ASCII table; and `Speed-Run.bat` being plain ASCII with CRLF line ends, cmd.exe's `nul` and its `for` loop, running the script from the folder it sits in and passing its exit code on.
`test/local.test.js` has 7: every `/completion` of a speed run is streamed, so a model is measured against a server whose parser refuses non-streamed answers, and the failure lines of 2.3 read word for word, an error sent as text alone and one with no text message among them; the engine's start line, which now says `1 thread` or `3 threads` and leaves out the GPU room when GPU layers is 0; every run logged in the history and in its detail log; a log that cannot be written never stopping the run; Benchmark all naming a model whose file does not match the manifest as not measured, first, and counting the models it measures on from it (2.5); a run cut off before its end getting its history entry when the local models next start; and a history row saying a figure its reading lacks is missing, never a zero.
The test of the requests' shape now expects `stream: true`, and the `readTimings()` test works generation out over n - 1, with a fill whose `predicted_ms` is 0.
The fake llama-server answers a streamed `/completion` as llama-server does, with events ending in one marked `stop` that carries the timings, answers a non-streamed one HTTP 500 with the parser's words when `parserRefuses(entry)` says so, times generation over n - 1 as llama-server does, and exports `answerOf(response)`, the JSON body or the last event of a streamed answer, which the test of a prompt read again now reads its timings through.
`test/budgetpanel.test.js` has 1: the card's log line once a run has ended, and at once when its log could not be written.
`test/run-as-script.test.js`, new, the own test file of `scripts/run-as-script.mjs`, has 2: a script runs when node was asked for it by its own path or through a link to its folder, and not when it is imported; and every script of the harness that runs as a command answers when started through a link to the harness.
`scripts/red-check.mjs` against `f88947a` finds the 28 new tests, and all 28 fail at the base by an accepted kind: the 18 in `test/speed-run.test.js` on a missing export, the 2 in `test/run-as-script.test.js` on the missing module `scripts/run-as-script.mjs`, and the 7 in `test/local.test.js` and the 1 in `test/budgetpanel.test.js` by assertion.
Its first pass flagged two tests in `test/local.test.js` that failed at the base by TypeError; each now asserts first that the new function exists, and passes the rule.

### 5.2 B2, with stub agents

`test/benchmark.test.js`, the new module's own:

- The task set loads and is valid: the preflight and nine skills of three levels; each skill a key of `TASK_DIMENSIONS`; dimensions a non-empty subset of 3.2's credited set; prompts free of the words 3.3 rules out; each level within its token budget; every protected path present; folder names unique; no file name starting with a dot; every tests-kind task with a test count per grade file.
- `git ls-files --others --ignored --exclude-standard plugins/jev-router/benchmark-tasks` prints nothing.
- The digest matches the files, over forward-slash paths in code-unit order with CRLF read as LF, and a changed byte fails with the new digest in the message; the copy into a task folder writes LF.
- For every task, the untouched workspace fails its grade and every reference solution passes, with the real graders in real processes; a tests-kind grade's `# pass` on each solution equals the count in its `task.json`.
  The suite grades on half the machine's cores, and on two at least: grading every task at once slowed a reference solution's timed performance case past its 4-second kill on a four-core machine.
- A module that calls `process.exit(0)` when a grade file imports it fails the grade; so does a run with a cancelled, skipped or todo test.
- A performance answer whose timed call runs past 2 seconds is killed and fails with its reason, and the suite's check of the untouched performance tasks takes seconds, not minutes.
- For each testing task, the reference tests pass on the original and the equivalent version and kill every mutant; tests that check the source text fail on the equivalent version; tests that assert nothing kill no mutant; a mutant run that times out counts as survived.
- A protected file changed or deleted, a path outside `onlyChanged` changed or added, a missing or malformed `REVIEW.json` or `ANSWER.json`, a path written in the scratch root outside the task's folder (which is then deleted), and checks that run past their time each fail with their reason.
  A test file added under a protected `test/` passes, and a `package-lock.json` written where there are no dependencies is not a change.
- The grading process's environment holds no variable but the five of 3.6, and the run's checks get no variable whose name holds KEY, PASSWORD, SECRET or TOKEN.
- A task folder is a git repository with `core.autocrlf` off and one commit, so only the agent's changes are reported; it is deleted after grading; its `folder` row is written before the agent starts, and at a start only folders with a `folder` row and no `task` row are deleted.
- Whether a task fits a window: level 1 fits 12,288, level 2 needs about 16k, a level-3 task near its bound fits neither, and a cloud agent fits all.
- Findings matching and answer comparison, case by case, and each grade's accepted alternatives: `fs.promises`, a named `timingSafeEqual` and quoted plain numbers pass, while implementation-2 accepts only the clock rule its prompt states.
- Each kind's estimate lines from a last run, from `usage.jsonl` rows with benchmark rows left out, and from nothing; the gate and near warnings; the peak window reached, avoided and unknown; the confirmation with learning on and off; a plan id unchanged by a moved balance and changed by an agent's state, model, subject or window or by the task set.
- The runner with a fake task runner and the real `createLanes()`: one task at a time across all agents, local agents first and each agent's tasks together; with a cap of 1 never two tasks at once; a failed preflight stops the agent; an `errored` task runs again once in a fresh folder, and a second error stops the agent with nothing recorded; a limit hit stops it; a timeout is scored as failed; a task that does not fit is not run and gives no evidence row; each stop records nothing for that agent while finished agents keep theirs; a run with no end row reads as interrupted after a reload.

`test/profiles.test.js`, extended: `benchmarkEvidence()` gives the rows of 3.9, the subject from the attempt's recorded model and version, with `n` of 3 over the tasks crediting each dimension, so a whole run weighs 1.89 on coding when fresh; benchmark rows are left out of `samples` and `evidenceSamples` and reported as the dimension's `benchmark` summary with its tasks, passes and weight; a newer run replaces an older one for the same subject and benchmark id, also after a reload, and `explain()` counts the older rows as not counted; a profile's `benchmark.score` is the pass rate; an unpinned model's rows stop counting after 45 days and a local model's do not.
The existing tests that counted benchmark rows in `samples` change with the rule.

`test/local.test.js`, extended for B2: the counters of engine loads and watchdog unloads move on a load and on an unload, and on nothing else.

`test/workspace.test.js`, extended: `runChecks()` runs its scripts with the `env` it is given, `run()` says when its own time limit ended a command, and a time limit ends every process a command started.

`test/ensure-no-project.test.js`, new, which the design did not list: the scratch workspace is `kzh-scratch` beside the harness folder, made with its README and listed in DSH as KzH scratch beside No project, once; one inside a git repository is neither made nor listed, and the line names the repository; and before DSH has made its workspace store, both folders are made and nothing is said.

`test/tasks.test.js` and `test/handoff.test.js`, changed with the code: the lanes now have three ways in, the benchmark's among them, and the router's prompt names the handoff note by its full path.

`test/usage.test.js`, extended: `computeSavings()` leaves rows with `purpose: 'benchmark'` out of its agent median.

`test/routerview.test.js`, extended, through the client's `__test` export: `sortRows()` (numbers as numbers, blanks last, a stable order) and `filterRows()` (per column, case-insensitive, all together); the results rows put the pass rate beside the weight, the prior and the Router tab's score, with the Profile now label; the progress lines.

`test/benchmark-run.test.js`, new, through `apply()` and `index.js` only, with stub agents whose subagent start writes a reference solution, writes nothing, edits a protected file, writes outside its folder, rejects, or runs past a short `agentTimeoutMs`.
`apply()` takes a `benchmark` seam, `{ scratchRoot, tasksDir }`, so the file runs the benchmark in a folder of its own over tasks of its choosing.
It signs Codex in through a fake `codex` command first on the `PATH`, which answers `codex login status` and the app-server's usage questions, reads Codex's model from a `CODEX_HOME` of its own, runs the local agent over the fake llama-server of `test/fixtures`, and holds the one slot of Tasks at once with a project task to show the speed run's refusal while a local agent's task waits:

- a task runs through `runRouted()`: the stub is started with the session's root agent as parent and a prompt holding the task's text and the `Workspace:` line of its own folder;
- the stub's effort is high and Codex's service tier is normal although Settings name another effort and Codex speed `fast`;
- no decider is asked and nothing reaches a TypeSafe host;
- `history.jsonl` is untouched, `usage.jsonl` rows carry `purpose: 'benchmark'`, and `capability-evidence.jsonl` gets the rows of every agent that finished;
- a stub that runs past the timeout is `timed_out` whether its provider resolves `aborted` or rejects with the timeout's `DOMException`; a stub that rejects otherwise, or whose `dispose()` throws, is `errored` and runs once more;
- a start from a session outside the scratch workspace is refused, and so is a normal routed task inside it;
- a start whose plan changed, a second start, a start with two picks of one subject, and a start with local picks during a speed run are refused, and a speed run is refused while a local agent's task is pending.

It reads the task files from `benchmark-tasks/` directly and imports no new module.
The design said that at the base it therefore fails on the routes; as built, it reads the task files as it loads, so at `6b5b4b4` the file stops with ENOENT on `benchmark-tasks/preflight/task.json`.
The red-check script proves its tests in its step 4, with the change's added files in place, where each fails on the routes by its own assertion, and the file's header says so.

As built, B2's suite is 1276 tests, 1275 pass, 0 fail, 1 skipped, three runs in a row at `d71b76c`, and red-check against `6b5b4b4` passes on every new test.
The review of B2 added ten tests, each failing at `d71b76c` by assertion, as `node scripts/red-check.mjs plugins/jev-router/test/benchmark.test.js plugins/jev-router/test/benchmark-run.test.js plugins/jev-router/test/routerview.test.js plugins/jev-router/test/handoff.test.js --base d71b76c` shows (8, 1, 1 and 0 new):

- in `test/benchmark-run.test.js`, a stub that keeps the handoff note at the path its prompt names, resolved from its parent's folder as a command-line tool would, passes and leaves nothing in the scratch root;
- in `test/benchmark.test.js`, an agent row's `recorded` count and the task rows' `subject`, evidence `ts` from the runner's clock under a registry with another clock, the metered and subscription estimates after a benchmark with no reading, a start whose log cannot be written, a log that fails partway, the entries an interrupted task left at the top of the scratch root, the task set read again when it changes, and a task set changed during a run;
- in `test/routerview.test.js`, the card's words for a run that ended early.

Checked by the docs writer of B2 at `1363776`: that red-check finds the 10 and all 10 fail at the base by an accepted kind, and the full suite is 1286 tests, 1285 pass, 0 fail, 1 skipped on Linux.

The second review of B2 added 43 tests by name, four of them in place of a test whose promise changed (three in `test/benchmark.test.js`, and one in `test/profiles.test.js`, which it split in two): 21 in `test/benchmark.test.js`, 8 in `test/benchmark-run.test.js`, 8 in `test/routerview.test.js`, 2 in `test/budgetpanel.test.js`, 2 in `test/profiles.test.js`, and 1 each in `test/local.test.js` and `test/ensure-no-project.test.js`.
Most hold a change of sections 2 and 3 that names the second review; these hold promises that had no test:

- `test/benchmark-run.test.js` deletes `NODE_TEST_CONTEXT` inside each test, once the test runner has read it, so a task's checks run the task's own `node --test` as they do on the person's PC and fail when its tests fail: under that variable, which `agentEnv()` passes on, `node --test` reports to a parent that is not there and exits 0, and before, every check in that file read as passed.
- A test holds the promise of one work attempt, no retry and no review: a forced agent whose task's own checks still fail is started once for it, `usage.jsonl` holds one primary row per task, and the task row records the failing check; before, removing the benchmark's limits failed no test.
- A run with learning off records nothing: `capability-evidence.jsonl` stays empty, the agent row has `recorded` 0 and `not recorded, learning is off.`, and the Weight column reads `not recorded (<n> had it been)`.
- The task's own checks run the agent's code with no key of KzH's: agent-written code records the environment of every process that runs it, and neither the checks, which npm runs as the test script, nor the grade find the key set in KzH's environment.
- A test through `apply()` holds that a local agent's task during which the engine loads a model again, which the stub causes by stopping and starting the model through `/jev-router/local`, is `errored` with `the engine loaded or unloaded a model while it worked` and run again, never graded against the model; before, only hand-made reports reached `attemptOutcome()`, and dropping the engine counters from the report failed no test.
- A table-driven test loads copies of the task set with one defect each and holds that `loadTaskSet()` refuses each, naming it: a telltale word in a prompt, a task over its level's tokens, a skill, level or folder that is not one, a dimension its skill does not credit, an empty prompt, a `package.json` with its own test script, a dependency or another name, a protected path it lacks, a path out of its folder, a dot file, a grade of no kind, a grade file it lacks or with no count, mutants with no equivalent version, a planted defect on no line, a `minFound` over the defects, an answer grade with nothing to match, no reference solution, a set whose first task is not the preflight, and a task listed twice; before, `taskProblems()` could have found nothing wrong and no test would have failed.
- What the estimate says of an agent's runs on your work, the median of their tokens and of their time, leaves out `usage.jsonl` rows with `purpose: 'benchmark'`; before, both test worlds read no usage lines and removing the filter failed no test.
- KzH closing stops a run: the plugin's disposers run while a task is held, the task reads `not_scored` with `the benchmark was stopped`, the agent at work `stopped` and the next `not_run`, the end row `stopped`, and nothing is recorded.
- A scratch folder whose path holds the account name gives the line that every task's prompt sends it to the agent.
- `GET /jev-router/routing` shows a dimension only a benchmark has measured and no prior covers, instruction following after simple_change-1, with its benchmark summary.

`test/speed-routes.test.js` now times a local agent's wait for a speed run from when its run says it waits, rather than from when the task was sent, so the check no longer fails under load.

Checked by the docs writer of the second review at `5f19588`: `node scripts/red-check.mjs plugins/jev-router/test/benchmark.test.js plugins/jev-router/test/benchmark-run.test.js plugins/jev-router/test/routerview.test.js plugins/jev-router/test/budgetpanel.test.js plugins/jev-router/test/local.test.js plugins/jev-router/test/profiles.test.js plugins/jev-router/test/ensure-no-project.test.js --base da08532`, whose plugin code is `1363776`'s, finds the 43, and 32 of them fail at the base by assertion.
The other 11 pass at the base, so red-check exits 1 and names them: five in `test/benchmark.test.js` (the task set that is not sound, the findings matched whatever their order, learning off, the estimate that leaves out the benchmark's own attempts, and the account name), five in `test/benchmark-run.test.js` (the checks with no key, one attempt for a task whose checks still fail, the engine loading a model again, KzH closing, and the Router tab's dimension only a benchmark measured), and in `test/profiles.test.js` the half of the split `benchmarkEvidence` test that holds a timed-out task's 0 and the runs that give nothing.
Each holds a promise the code already kept before the second review, which is why it passes there: the rule that every new test fails on the old code cannot hold for a test of a promise that was kept but untested, and whether such a test is acceptable is the owner's call (docs/handoff.md, "Open, and needing the OWNER, not an agent").
The full suite at `5f19588` is 1325 tests, 1324 pass, 0 fail, 1 skipped on Linux.

---

## 6. What is not built now

- Estimates for models that are not installed calibrated from a measured one on this PC; they stay the fixed bandwidth guess.
- Generation speed deeper than 8,192 tokens, and measured speed fed into routing's latency or the cold-start line's `~8 s`.
- Speed of cloud agents.
- Tasks in any language but JavaScript, and tasks for architecture, documentation, frontend, backend, database, tool use, long context or vision.
- Any task judged by a model; each would make the score that model's opinion.
- A second attempt, a review or a plan step inside the benchmark, and scores per effort level: rows are keyed by model, as all evidence is.
- Any run that KzH starts or schedules by itself, of either kind.
  The owner's ruling in 1.1 is about the capability benchmark: cloud agents cost real usage, so B2 is never automatic and nothing starts it by itself.
  Speed runs are free, and on 26 Sep the owner asked for one that can run by itself for checking: `Speed-Run.bat` (2.12), which a Task Scheduler entry the owner makes may start, with `--no-pause` and exit codes for that.
- `benchmark_prior` rows imported from published benchmarks.
- A task folder as the agent's own working directory, and runs from any workspace: the pinned engine takes no working directory in a subagent start (3.7).
  When an engine that takes one is pinned, the task folder becomes the agent's workspace, and the one-task-at-a-time rule and the listing of the scratch root can be reconsidered.
- Detecting an agent that read beyond its folder.
- Deleting results or evidence: `capability-evidence.jsonl` is append-only, and a newer run is how an older one stops counting.

---

## 7. Build plan

Two steps, one after the other, B1 then B2, each on `feat/benchmark`, each ending with the full suite green, `red-check` passing on its new tests, its docs queued, and one commit.

### Step B1: speed and memory

Owns:

- `plugins/jev-router/local.js`: `SPEED_TEXT`, `readTimings()`, `speedFor()`, the `speed` map, `reload()`, the `mutate()` queue every `local.json` write goes through, a count of `acquire()` calls, the engine's `roomGB` and `gpuLayersSetting`, the speed run with its queue, refusals, restore and cancel, `status().speedRun` and each model's `speed` and `rating`, and `rateModule()` and `buildCatalog()` rating from a standing reading (2.1 to 2.9).
- `plugins/jev-router/index.js`: `POST /jev-router/local/benchmark` and `.../benchmark/cancel`, with the Laya-busy and local-agent refusals and 409 (2.10), and the count of local-agent attempts in flight around `execute`, with their wait while a speed run goes (2.6).
- `plugins/jev-router/client.js`: the Local models card's speed lines, the date on each model's memory line, Benchmark and Benchmark all, the run's status and Cancel, with `speedLine()` in the pure budget helper block; the Resource budget table is not touched.

Tests: `test/local.test.js` and `test/budgetpanel.test.js`, extended, and `test/speed-routes.test.js`, new, through `apply()`, as 5.1 lists.

Docs queued: this document's status (B1 built, what was verified), README.md's Local models section (the speed benchmark and what it measures, at what depth), and docs/handoff.md's open work.

Built on 25 Sep in `914d8d4`, with the fixes of its review in `c0ef03c`, which also touched `plugins/jev-router/router.js` for the attempt clock (1.3, 2.6), and tested against a fake llama-server.
On 26 Sep it ran against the real llama-server b10964 on a CPU with two tiny test models (the status at the top), which found that llama-server's output parser can refuse a `/completion` that is not streamed.
Every `/completion` of a speed run is now streamed (2.2, 2.3), `scripts/speed-run.mjs` with `Speed-Run.bat` runs the speed run from a shell (2.12), with `test/speed-run.test.js`, new (5.1), and every speed run is logged in `speed-runs.log` and a detail log of its own (2.13).
A review of that work found the generation speed about 0.8 percent fast, since it counted a token the prompt pass makes, and it is now worked out over the other n - 1 (2.3).
That change is the commit after `f88947a` on `feat/benchmark`, pushed on 26 Sep; the GPU and the real models are still not observed.

### Step B2: capability

Owns:

- `plugins/jev-router/benchmark.js` (new): the task set's loading, validation and digest, the fit of each task to each agent, folder preparation, listing and cleanup, grading, the estimate and the confirmation, the plan id, the runner with its one queue, reruns, stops and `benchmark.jsonl` (3.3 to 3.11).
- `plugins/jev-router/benchmark-tasks/` (new): `task-set.json`, the preflight and the 27 tasks of 3.4 with their workspaces, graders, reference solutions, mutants and equivalents.
- `plugins/jev-router/profiles.js`: `benchmarkEvidence()`, the capped `n`, benchmark rows left out of `samples` with the dimension's `benchmark` summary, the rule that a newer run replaces an older one, and the comments that say nothing produces benchmark rows.
- `plugins/jev-router/local.js`: the counters of engine loads and watchdog unloads.
- `plugins/jev-router/workspace.js` and `router.js`: the `env` option of `runChecks()` and `config.checks.env` passed to it.
- `plugins/jev-router/usage.js`: `computeSavings()` leaving benchmark rows out of its agent median.
- `plugins/jev-router/index.js`: `runDepsFor()` split out of `route()`, with `onExecuted` and the failed-dispose report, the scratch workspace and its refusal in `route()`, the `/jev-router/benchmark` routes, and the wiring to the lanes, the capability registry, usage and the speed run's refusal.
- `plugins/jev-router/client.js`: the Capability benchmark card, `SortTable` with `sortRows()` and `filterRows()`, the Usage tab's mark on benchmark rows, and the Router tab's profile and lead lines.
- `scripts/ensure-no-project.mjs` (the KzH scratch workspace beside the harness, and its check that no git repository holds it), and `config/capability-priors.json`'s `about` text, which says nothing records benchmark evidence.

Tests: `test/benchmark.test.js` and `test/benchmark-run.test.js`, new, and `test/profiles.test.js`, `test/local.test.js`, `test/workspace.test.js`, `test/usage.test.js` and `test/routerview.test.js`, extended, as 5.2 lists.

Docs queued: this document's status, docs/adaptive-routing.md's benchmark evidence and "No benchmark source" (the benchmark is the source now, the capped weight, rows that are not runs, and the rule that a newer run replaces an older one), README.md's line that there is no benchmark source, and docs/handoff.md's "Benchmark evidence has no source yet" and open work.

Built on 25 Sep in `d71b76c` on `feat/benchmark`: `benchmark.js`, the preflight and the 27 tasks of task set `kzh-capability` version 1 under `plugins/jev-router/benchmark-tasks/`, the `/jev-router/benchmark` routes, the Capability benchmark card, `benchmarkEvidence()` and the rule that the newest run counts.
It also made `workspace.js` `run()` kill the whole process tree on Linux and macOS (3.6), and added `test/ensure-no-project.test.js` (5.2).
It was tested with stub agents, a fake Codex command-line tool on the `PATH` and the fake llama-server (`test/benchmark.test.js`, `test/benchmark-run.test.js`), and has not run with a real Claude Code, Codex, DeepSeek or local agent.
Its suite was 1276 tests, 1275 pass, 0 fail, 1 skipped, three runs in a row, and red-check against `6b5b4b4` passed on every new test.

The review of B2 was fixed on 25 Sep in `1363776`: eight findings, all verified and fixed, none rejected.
The handoff note is named by its full path in the task folder (3.6); a start whose log cannot be written is refused and leaves nothing running, and a log failure partway ends the run with that reason (3.8); the estimate reads the last benchmark's tokens and says when it left no reading (3.10); evidence `ts` is each task's end (3.9); what an interrupted task left beside its folder is named in the confirmation and deleted (3.7); the task set is read again when its files change, and a change during a run stops it (3.5); agent rows count evidence rows and task rows name their subject (3.8); and the run test's header says how it fails at a base without the task set (5.2).
Its suite is 1286 tests, 1285 pass, 0 fail, 1 skipped, three runs in a row, and red-check against `d71b76c` finds all 10 new tests failing at the base by assertion.

The second review of B2 was fixed on 26 Sep in `5f19588`.
A stop is a stop however the run comes back (3.8); a task folder's repository is kept outside the scratch root, and every git call of the benchmark runs with no key of KzH's (3.7, 4); a local attempt that rejects on its time limit still names its weights (3.9); a task that does not fit a local window records nothing, and a window that cannot hold the first task cannot be picked (3.2, 3.8, 3.9, 3.10); a plan id starts one run within 30 minutes (3.11); the card reads only while the Router tab is shown, and its tables, confirmation, progress and last-run words say what happened (3.11, 3.12); Cancel during the speed run's restore says why (2.8); `ensure-no-project.mjs` runs through a link (3.7); a listing of the scratch root that stopped short is never read (3.6); and the untested promises have tests (5.2).
Its suite is 1325 tests, 1324 pass, 0 fail, 1 skipped, and red-check against `da08532` finds 32 of its 43 new tests failing at the base by assertion and 11 passing there, which 5.2 names.

---

## 8. Review applied, 25 Sep

Each finding was checked against the code at `a1e42b4` and the pinned engine's packages before it was applied.

- **B2-isolation** held and is applied: the pinned engine has no working directory per subagent (read in `@deepseek-ai/dsh-subagent`, `-claude-code` and `-codex` 0.1.5-rc.2), so the benchmark runs one task at a time, in a scratch root beside the harness and outside any git repository, with a listing of the scratch root before and after each task (3.6, 3.7, 3.8, 4).
- **B2-gitignore-taskfiles** held and is applied (3.5), except its claim that a workspace `.gitignore` is dropped: `!.gitignore` (.gitignore:4) keeps it, and `git check-ignore` exits 1 for one; `data/app.log` and any `.gitattributes` are dropped as it says.
- **B1-acquire-no-reload** held and is applied (2.1, 2.4, 2.5).
- **B1-evicts-local-agent** held and is applied (2.6, 2.7).
- **B2-infra-failures-scored** held and is applied (3.6, 3.8), with two changes: a timeout is told from the attempt signal's reason rather than from its duration, which is exact; and the providers' `dispose()` already terminates the agent's process and waits for its exit, so what was missing is only that index.js:1359 ignores its failure.
- **B2-local-window** held and is applied (3.2, 3.3, 3.9, 3.10).
- **B2-tests-tautology** held, reproduced on Node 22.22.2, and is applied (3.4, 3.5, 3.6).
- **B2-false-negatives** held, npm 10.9.7 writing `package-lock.json` in a project with no dependencies, and is applied (3.3, 3.4, 3.6); the graders that matched source text now wrap `node:fs` and `node:crypto` through `syncBuiltinESMExports()`, which was checked to reach named, default and namespace imports.
- **B2-security3-contradiction** held and is applied by grading only formula cells and accepting plain numbers either way (3.4).
- **B2-evidence-overstated** held, the arithmetic confirmed against profiles.js:315 to 327, and is applied (3.9, 3.11).
- **B2-claude-permissions** held in part and is applied through the preflight (3.4).
  Its other scenario does not hold: the pinned provider denies an unapproved tool at once (`canUseTool`), so no prompt waits for the timeout.
  Showing each agent's command permission in the confirmation is rejected, because KzH cannot read the person's Claude settings, and the preflight is where it is learned; a fixed allowlist cannot be passed, because the provider's start options take none.
- **B2-spend-unconfirmed** held and is applied by fixing the effort and Codex's speed for the benchmark, with the peak window in the estimate and benchmark rows left out of the person's runs (3.8, 3.10, 3.11).
- **B1-speedFor-conditions** held and is applied (2.3, 2.4).
- **B1-label-depth** held and is applied by measuring at a depth of 8,192 tokens, which also measures prompt speed at the size of an agent's call, with wait lines from the model's own reading (2.1, 2.2, 2.9, 2.11, 6).
- **B1-settings-write-race** held and is applied (2.4).
- **B1-missing-seams** held and is applied (2.4, 2.8, 2.9), with one change: a cancel during loading stops the engine at once rather than through the lock, which the load it cancels holds.
- **B2-leftover-folders** held and is applied (3.7, 3.8).
- **B2-now-column** held and is applied by naming the column Profile now and saying under the tables how routing's reading differs (3.11).
- **B2-key-claim** held for the run's checks and is applied (3.8, 4); its claim that the agent's own shell carries KzH's keys does not hold, because the engine starts agents' processes from `scrubbedParentEnv()`, which drops every name holding KEY, PASSWORD, SECRET or TOKEN.
- **B2-same-subject-double** held and is applied by refusing such picks (3.9, 3.11).
- **B2-perf-timing** held and is applied (3.4, 3.6).
- **B1-budget-table-rule** held, and is applied by leaving the Resource budget table untouched and moving the memory date to each model's memory line (2.9); recording an exemption is rejected, because only the owner can grant one, so the question is queued for the owner in docs/handoff.md.
- **tests-redcheck-extended** held and is applied (5).
