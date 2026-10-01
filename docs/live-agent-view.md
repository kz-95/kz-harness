<!-- The design of feat/live-agent-view, from a research, three-design and two-judge workflow (30 Sep), plus the Strata study. Each slice below is built and reviewed in turn. -->
# Implementation plan: live agent view, start replies, learned replies, reply ratings and queue controls

Repository `/home/user/kz-harness`, branch `feat/live-agent-view`. I changed nothing in the repository while writing this plan. I used one scratch folder to re-read `@anthropic-ai/claude-agent-sdk@0.3.263`, `@deepseek-ai/dsh-subagent-in-process-driver@0.1.5-rc.2` and the Codex app-server README at `rust-v0.153.4`, and I have deleted it. `git status` is clean.

---

## 0. Basis

### 0.1 Which design this builds on, and what it takes from the others

The judges split. Judge 1 picked Design 1 and Judge 2 picked Design 3, and each scored both of those 8 overall. Their graft lists point the same way, so this plan does the following:

- **Frame from Design 3 (person first):**
  - The start reply ships first, together with the delivery hazard fixes.
  - The learning clock starts in shadow early, because maturity takes weeks.
  - Progress reaches the chat as appended notices, which start no model turn.
  - Results stay the notices they are today.
  - One wording module holds every sentence the chat shows.
- **Engineering contract from Design 1:**
  - One engine patch, pinned to a version and anchored exactly once per edit.
  - All-or-nothing per file, output on stdout only, always exits 0.
  - The plugin sends the patch's request fields only when the marker is present in the installed file.
  - Every piece of guidance ends in exactly one tracked state.
  - The local intent classifier can only ever decide "task".
  - `tasks.delivered()` is hardened on the server.
- **Grafted from Design 2** (both judges, or Judge 2):
  - The in-chat LiveRunCard.
  - Claude's AsyncIterable input channel for steering, behind an experimental toggle that is off by default.
  - Codex Send now on the same thread, with the effort bug fixed.
  - Codex file detail from `item/completed` and `turn/diff/updated`.
  - The pinned connector files vendored as MIT test fixtures.
  - Tapped token usage returned into `usage.jsonl`.
  - A red-check for every slice.

Where this plan departs from all three designs:

- **Pick prediction.** It is neither a ladder domain (Design 2) nor a side-effect-free copy of `decision.js` (Design 3, `foresee`). It is a small separate reply predictor. It uses the same `classifier.js` and learns from what the router actually ran. It is trusted only by its measured record against `routed.primary`. So it cannot promote a routing domain on self-observation, and it cannot drift from a duplicated pipeline.
- **Binding verdicts.** No "bound copy" feedback rows are appended. Plan verdicts bind through a task key carried in the history record (`runOfVerdict`, `feedbackFor`). They are replayed at run end inside the feedback route's existing serialized queue.
- **One patch version.** Every engine hook (tap, steer, Send now, input channel, continuation) ships in a single patch version in slice 5, inert until the plugin uses it. The owner's PC then goes through one patch migration, not two.

### 0.2 Errors the judges found, and how this plan fixes each

1. **Plan verdicts bound by jobId, which is reused after a restart.** `dsh-jobs-local` `lib/index.js` builds `` `${spec.kind}-${count}` `` from an in-memory Map, and `tasks.js` enqueue splices the old record "an id reused after a restart".
   Fix: `tasks.enqueue` mints `key = randomUUID()`, saves it (SAVED `key`), and carries it in the reply mark, the ledger, `route()`, `runRouted` and the history record (`record.taskKey`). Every new route takes `key`. Verdicts bind by `sessionId` plus `taskKey` or `runId`, never by jobId alone.
2. **resultIdOf read the third `·` field.** `taskName` is clipped task text and may itself contain `·`.
   Fix: the **last** field must be a terminal `TASK_LABELS` value (`Completed`, `Failed`, `Stopped`, `Needs input`, `Paused by limit`). The name is `parts.slice(1, -1)`.
3. **A naive argv[1] main guard.**
   Fix: `if (runAsScript(import.meta.url))` from `scripts/run-as-script.mjs`.
4. **A bound feedback copy appended outside the queue.**
   Fix: no copies. `createFeedbackRoute` gains `bindRun(record)`, which runs in the same promise queue as posted verdicts.
5. **Design 2's Codex continuation read process-wide effort at a later turn/start.**
   Fix: `kzhWire()` runs synchronously inside `start()`, which `runAgent` holds under `envStarts`. It snapshots `KZ_CODEX_EFFORT` and `KZ_CODEX_SERVICE_TIER` into `wire.kzhTurnExtras`. turn/start spreads `...this.kzhTurnExtras` after the effort patch's env lines, so a continuation turn uses the effort its run started with.
6. **"Run it read-only beside" cannot work.** `runAdmitted` chooses the read lane only at entry.
   Fix: dropped.
7. **`extraArgs {thinking-display}` is not the SDK's route.** In `sdk.mjs` the SDK emits `--thinking-display` only from `options.thinking`.
   Fix: nothing is forced by default. The patch exposes `kzhControl.thinkingDisplay(d)`, which calls `Query.setMaxThinkingTokens(null, d)`; `sdk.d.ts:2672` documents that `null` keeps the session's thinking and changes only the display. This stays off unless the owner's check in slice 5 shows no thinking text.
8. **Claude input channel on by default.**
   Fix: it is behind "Let Steer reach a running Claude Code (experimental)", default off. With it off, the prompt is today's string. In the channel path, a non-success result that follows a successful one never fails the run.
9. **Observed router choices recorded as `verified_outcome`** (this defeats `domains.js` `isOutcomeBacked`).
   Fix: there is no ladder domain for the pick. The reply predictor has its own artifact, fed from `reply-ledger.jsonl`.
10. **An unverified gzip/SSE claim.**
    Fix: SSE is deferred and nothing depends on it. The live view polls a cursor route.
11. **Two unknowns that the code already answers.** Both are settled in 0.3, and the WeakMap-by-signal fallback is dropped.
12. **`item/fileChange/patchUpdated` treated as normal.** It fires only with `features.apply_patch_streaming_events` (README line 1884).
    Fix: file detail comes from `fileChange` `changes[{path, kind, diff}]` on `item/started` and `item/completed`, plus `turn/diff/updated`, which is emitted after every FileChange (line 1809). `patchUpdated` is used only if it arrives.
13. **A trusted local "question" would send work to a chat model.**
    Fix: `DOMAINS.intent.localLabels = ['task']`, enforced in `domains.js` `decide()`.
14. **Claude steer message content as an array of strings.**
    Fix: `message: { role: 'user', content: [{ type: 'text', text }] }`, the same shape the SDK's own string write uses (`IL()` in `sdk.mjs`).
15. **Design 1's instant reply needs every routing domain at LOCAL_ONLY** (`decision.js` `NOT_LOCAL` includes GUARDED_LOCAL, so `groupOpen` calls Jev).
    Fix: the reply no longer waits for routing once the predictor has earned it (see Feature 3). "Picked on this PC" is claimed only when the run's own event log shows no decider call before `routed`.
16. **Intent labels skewed to "task"** (training and the per-class gate read verified rows only, and the per-class gate applies only at LOCAL_ONLY).
    Fix, part 1: a new `requiredClasses: ['task', 'question']` gate at GUARDED_LOCAL and LOCAL_ONLY, with `perClassSamples` (100) verified rows per class.
    Fix, part 2: more outcome-backed `question` labels (see Feature 3).
17. **Design 2 hardened only the client.**
    Fix: `tasks.delivered()` refuses non-terminal tasks, and `/tasks/seen` also checks the task name. This also closes a jobId-reuse acknowledgement across restarts.
18. **Misattributions in Design 3.** `feedbackPrior` lives in `router.js:379`; `WAITING` is exported from `tasks.js`. The plan names the right files.

### 0.3 Open questions settled by reading the code

- **A function-valued request field reaches the connector.** `SubagentRuntime.start` spreads `{...request, descriptor}` into `provider.start` (dsh-subagent `lib/index.js:3155-3159`). `assertCapabilities` checks only `agentOptions`, `outputSchema`, `maxDepth`, `toolFilter` and `persona`. `kzhTap` and `kzhControl` arrive unchanged.
- **Spawn cancel then followup gives the new turn's result.** The in-process driver's `drivePublishedRun` sets `flags.cancelled` only from the run signal or `dispose()`. `result` awaits `child.whenIdle()`, which follows replacement work, and `readResult` reads `foldConsumedWork(snapshotEvents(boundary)).end`, the last turn.
- **Agent-scoped listeners see only their own agent.** Every `agent/*` event, including `agent/assistant-stream` and `agent/inbox/claimed`, is documented "Scope-filtered dispatch: agent-scoped listeners receive only that agent" (dsh-agent `runtime-types.d.ts`). `Agent.ctx` is "Agent-scoped context; its contributions ... unwind on disposal". `session/event` gives agent-scoped listeners only sessions entered through that agent (dsh-session `types/index.d.ts:55-62`). So `sub.localAgent.ctx.on(...)` needs no global listener and no hold buffer.
- **Claude SDK input semantics** (`sdk.mjs`):
  - A string prompt writes one user message; `readMessages` calls `endInput()` at the first result when `isSingleUserTurn` holds.
  - An iterable prompt goes through `streamInput()`. It writes each message, and when the iterable ends it waits for the first result (canUseTool is set, so there are bidirectional needs) and then calls `endInput()`.
  - So `streamInput` on the connector's string-prompt query cannot keep stdin open for a later turn. Steering needs the iterable channel.
- **Claude result fields.**
  - `user_message_uuids` lists every uuid a turn consumed, "any queued user message folded into the running turn between tool rounds" included (`sdk.d.ts:4991`).
  - `queued_turn_count` counts sends still pending (`4982`).
  - `terminal_reason` includes `aborted_streaming` and `aborted_tools`.
  - `modelUsage` and `total_cost_usd` are cumulative. Read the latest result, never a sum.
- **Codex `turn/steer` is stable** (README lines 225 and 1419-1434). It takes `{threadId, expectedTurnId, input, clientUserMessageId?}` and returns `{turnId}`. The resulting `userMessage` item echoes `clientId` (line 1825). Review and manual-compaction turns reject it.
- **Codex command output encoding.** `item/commandExecution/outputDelta` is documented as plain appended text (line 1879). Only `command/exec/outputDelta` and `process/outputDelta` are base64 (lines 238 and 243). The projector treats it as text.
- **Job limit.** `dsh-jobs-local` allows 10 active jobs per owner, waiting jev tasks included. It throws "background job limit reached for this owner (limit: 10) ...", which the `tasks.js` regex `/unavailable|job controller/` does not match. The registry is inserted as `id: jobs` (dsh-base `cordis.patch.yml:81-82`), so `config/cordis.patch.yml` can set `maxConcurrentJobsPerOwner`.
- **The effort env is read inside `start()`.** `settleRunResult` calls `attempt()` synchronously, and `runTurn` builds its turn/start params before its first `await`. Snapshotting at wire construction is therefore exact.
- **Connector versions stay pinned.** `Update-Harness.ps1` reinstalls the connectors only with `-BumpDsh` (line 104), at the new engine version. The patch's version check then refuses, and the UI says so.

### 0.4 Still open

These need the owner or one live run; details are in section 5:

- Claude CLI folding behaviour.
- Claude's default thinking display.
- Codex reasoning summaries under the owner's config.
- Real Jev and Laya latency, which sets the wait default.
- Real-app rendering.
- A Codex continuation on an ephemeral thread.
- Several product choices: Send now over the cap, "stop the holder", the effort bias default, and transcript retention.

---

## 1. Design per feature

### Feature 1: live view of each agent's work (Kilo Code style)

#### What the person sees

**Work board row** (the sticky card at the top of the chat). Each live task gets a second line: `<phrase> · <n> tool calls · <tokens> · <ago>`. Example: `Running a command: npm test · 14 tool calls · 18.2k tokens · 3 s ago`. A dot pulses while the newest item is under 5 s old. Clicking the row opens the Live tab on that task. Waiting rows keep today's wait words.

**Phrase table.** It lives in `live.js` `activityOf` and every view uses it.

- Agent items:
  - reasoning: `Thinking`
  - commentary text: `Writing`
  - final text: `Writing its answer`
  - Read, Grep, Glob, LS, or Codex read/search `commandActions`: `Reading the code` or `Searching the code`
  - Edit, Write, MultiEdit, or Codex fileChange: `Editing <file>`
  - Bash or commandExecution: `Running a command: <first 60 chars>`
  - WebFetch, WebSearch, or Codex webSearch: `Searching the web`
  - Task, or any Claude message with `parent_tool_use_id`: `Delegating to a sub-agent`
  - TodoWrite or `turn/plan/updated`: `Planning next steps`
  - `system/api_retry`: `Retrying the model (attempt <n>, in <s> s)`
  - nothing from the agent yet: `Starting <Agent>...`
- Router phases:
  - `Choosing the agent (Jev)`, or `(Laya)`
  - `Running your checks before it starts`
  - `Running your checks: <names>`
  - `<Reviewer> is reviewing the changes`
  - `Done in <duration>`

**Stall wording.** It never says "stuck".

- A command open for more than 60 s: `Waiting on a command for 3m 05s: npm test`.
- No provider item for 90 s and nothing open: `No news from Claude Code for 1m 30s. It may still be thinking; Stop is on this row.`
- `tool_progress` and `system/thinking_tokens` heartbeats count as activity.

**Unpatched connector:** `Working (live detail is off for Codex: see Settings, Jev setup, Live agent view)`.

**LiveRunCard** (new; slot `conversation.chat.assistant-actions`, id `jev-live`, order 105, between AgentStrip 100 and AnswerVerdict 110). It renders under any assistant message that carries the `[jev-job]` mark (the start reply, Feature 2). It shows:

- avatar, task name, and `Claude Code · claude-opus-4-1 · effort high (14 tool calls)`
- the status phrase and the active elapsed time
- an auto-scrolling list of the last 8 tool rows (glyph, name, one line of input)
- `Starting Claude Code...` until the first item
- buttons: `Open live view`; `Steer...` and `Send now...` (from slices 8 and 10); `Stop`
- when finished: `Done in 7m 12s · 23 tool calls · 41k tokens`

It polls only while its task is live and the card is on screen.

**Tasks tab row.** While running, the disclosure body shows the last 6 live items instead of the single last line, plus `Open live view`.

**New right-sidebar tab "Live".** Id `jev-router/live`, kind `jev-live`, guide `Watch agents work: text, tool calls and reasoning as they stream`, Shortcuts action `Open Live`. Params are `{ task: <key> }` or `{ run: <runId> }`. With no param it shows a picker: live tasks first, then recently finished ones.

- **Header:** `jev-3 · Claude Code · claude-opus-4-1 · effort high · 2m 14s · 18.2k tokens · last activity 2 s ago`. The model is the one the provider reports (Claude `system/init`, Codex thread/start response). Elapsed time leaves out time in line and untimed waits.
- **Timeline:** one section per attempt, e.g. `Attempt 1 · Claude Code · work` and `Review · Codex`. Each section holds:
  - router milestones as grey lines (`Picked by Jev: Claude Code`, `Checks before start: test pass`, `Review: changes requested`)
  - reasoning blocks in Preview mode: 120 px, follows the stream, fade mask, `Show all`. When only counts arrive: `Thinking... (about 1.2k tokens)`.
  - text as Markdown (`primitives().MarkdownText`)
  - tool rows (`Read src/app.ts`, `Searched for useTasks`), each with state glyph and words
  - command rows (`Ran npm test · exit 1 · 14 s`) with a 20-line ANSI-stripped output tail that has carriage returns applied; it folds once the command ends
  - file rows (`Edited src/app.ts +12 -3`) with a unified diff capped at 400 lines, then `Show all`
  - a Codex `Files changed` panel from `turn/diff/updated`
  - plan checklists
  - steer bubbles `You: ...` with their state (Feature 5)
  - a usage line per attempt
  - a turn replaced by Send now reads `Replaced by your message`, never `Interrupted`
- **Controls:** `Follow` (on; scrolling up turns it off and shows `Jump to latest`), `Open full session` (spawn children only, `sessionsApi.openSubagent` as client.js already does), `Steer...` (slice 8), `Stop`.
- **Notes under the header, only when they apply:**
  - `Codex shares its reasoning as short summaries.`
  - `Claude Code shows thinking only when Claude shares it; text and tool calls always show.`
  - `This local model runs with thinking off (Settings, Local models), so there is no reasoning to show.`
  - `Live detail for Codex is off: <reason the patch recorded>. You still see the router's steps, and the result posts as usual.`
- **End line:** `Finished: Completed in 4m 10s.`
- **After a restart:** `Saved transcript (last 256 KB). The task's report is in the chat.`
- **Empty:** `Nothing is running in this chat. When a task starts you can watch it here.`

**Settings, Jev setup, "Live agent view" card:**

- `Claude Code: live detail on` (or the patch's reason)
- `Codex: live detail on`
- `DeepSeek, API and local models: always on (no patch needed)`
- Toggle `Let Steer reach a running Claude Code (experimental)`, default off.
- Select `Claude Code thinking: As Claude Code shows it (default) / Summarized`.

#### Data flow

**`plugins/jev-router/live.js`** (new, pure, no I/O except `persist` and `load`) provides `createLiveStore({ now, caps, dir })`.

- **Structure:** a run holds `attempts[] { index, role, agent, provider, model, effort, startedAt, endedAt, stopReason, child }` and items.
- **Item:** `{ id, v, at, attempt, kind: status|reasoning|text|tool|command|file|plan|usage|model|steer|error, title, text (chunk array, joined on read), state: running|done|failed, meta }`.
- **Versions:** every change bumps one store-wide `v`. `read(runId, afterV)` returns only items changed since, with text tail-capped at 16 KiB plus `clippedBefore`, and the summary (`phrase`, `lastActivityAt`, `tools`, `tokens`, `model`, `effort`, `done`).
- **Caps:** 1500 items and 768 KiB per run; 64 KiB head and tail per item; 40 finished runs in memory, evicted least recently used. Live runs are never evicted. When a run overflows, one `older steps dropped` marker is kept.
- **Safety:** stored text goes through `export.js` `redactSecrets`. Projectors copy and never mutate, because the connectors read Codex params and Claude messages again after the tap. Malformed input increments `dropped` and never throws.
- **Isolation:** each attempt gets its own handle `{ tap, note, end }`, so a read pass beside a writer and a parallel opinion cannot mix.
- **Persistence:** at settle, `persist(taskKey)` writes the task's compacted items to `dataDir/live/<key>.jsonl`, capped at 256 KiB. A truncated last line is skipped on read. `drop(key)` deletes the file when the task is cleared or trimmed.

**Three feeds, none on the run's critical path, none through `onEvent`, `tasks.applyEvent`, `tasks.jsonl` or `t.out`:**

1. **Router milestones.** `route()`'s `onEvent` also calls `live.router(runId, e)` for `routed`, `attempt_start`, `attempt_end`, `checks`, `review`, `limit`, `error`, `final`, `access` and `steer`. `route()` gets `taskKey`, so `live.open(runId, { taskKey, sessionId })`.
2. **Spawn children** (DeepSeek, API-key agents, local llama-server), with no patch. After `sub = await start()`, when `sub.localAgent` exists, `runAgent`:
   - registers `sub.localAgent.ctx.on('agent/assistant-stream', ({ frame }) => handle.frame(frame))` for text-delta, reasoning-delta, tool-call-delta, block-end and usage chunks, and `sub.localAgent.ctx.on('agent/inbox/claimed', ({ message }) => steers.claimed(message.id))` (Feature 5), both inside try/catch;
   - runs a 400 ms unref'd pump over `sub.localAgent.session.snapshotEvents(cursor)` (cursor = `session.seq`), which picks up committed `tool/call`, `tool/result` (its `meta` diff for fs tools becomes a file item), `assistant/message` (usage summed), `user/message` (steer ids) and `turn/start`/`turn/end`, deduplicated by seq. The first pump call starts at 0, so events from before `start()` resolved are backfilled.
   - In `finally`, before `sub.dispose()`: one last pump, `handle.end()`, and unregistering.
   - If `ctx.on` throws, the pump alone still gives per-step detail.
3. **Claude Code and Codex** (all three provider rows, `claude-code-readonly` included). `runAgent` builds `kzhTap = live.tapFor(handle)` and `kzhControl = {}` before `start()`. It adds them to the `ctx.subagents.start` request only when `engine-patches.js` reports the marker for that package. The connector calls the tap for every SDK message or app-server notification.

**Claude projection (`fromClaude`):**

- `system/init`: model item (served model, `apiKeySource`).
- `stream_event` `content_block_start`/`delta`/`stop` (`thinking_delta`, `text_delta`, `input_json_delta`): streaming items. A complete `assistant` message then replaces the partial text.
- A `user` message's `tool_result`, plus `tool_use_result`: finishes the tool item. Edit/Write/MultiEdit `structuredPatch` becomes a file item with +/- counts; Bash `stdout`/`stderr` becomes the command output tail.
- `tool_progress`: elapsed time and heartbeat.
- `system/thinking_tokens`: `Thinking... (about N tokens)`.
- `system/api_retry`: status item.
- `result` (latest wins): usage from `modelUsage` and cost from `total_cost_usd`. Cost is `apiEquivalentUsd` when `apiKeySource === 'none'` (subscription), otherwise `costUsd`.

**Codex projection (`fromCodex`):**

- `kzh/thread-start-response`: model, `reasoningEffort`, sandbox.
- `item/started` creates `agentMessage`, `reasoning`, `commandExecution`, `fileChange` (its `changes`), `mcpToolCall`, `webSearch`, `plan` and `userMessage` items.
- Deltas: `item/agentMessage/delta`, `item/reasoning/summaryTextDelta` (`summaryPartAdded` starts a paragraph), `item/reasoning/textDelta`, `item/commandExecution/outputDelta` (text), `item/plan/delta`.
- `item/completed` finalizes the item (`exitCode`, `durationMs`, `status`, fileChange `changes[{path, kind, diff}]`, `userMessage` `clientId`).
- `turn/diff/updated` feeds the run-level `Files changed` (256 KiB cap); `turn/plan/updated` the plan; `thread/tokenUsage/updated` the usage (total).
- `error` and `warning` become status and error items. `item/fileChange/patchUpdated` is used only if it arrives.

**Usage:** `usageOf(run)` normalizes to the plugin's `TokenUsage` names.

- Anthropic input excludes cache reads.
- Codex `inputTokens` includes `cachedInputTokens`. So `inputTokens = inputTokens - cachedInputTokens` and `cacheReadTokens = cachedInputTokens`.
- When the provider result carries no `usage` (true for both connectors today), `runAgent` returns the tapped usage, plus `apiEquivalentUsd` or `costUsd`, plus `servedModel`.
- The router writes `apiEquivalentUsd` next to `costUsd` on the usage.jsonl row. It records `servedModel` on the attempt, **not** `modelVersion`, so capability profiles keep their keys (`servedModel()` in `router.js` would otherwise re-key Claude and Codex evidence).

**Serving:**

- `GET /jev-router/live?task=<key>|run=<runId>&after=<v>` answers `{ runs: [{ runId, attempts, items, v, summary, child }], patches, done, saved }`. `task` resolves through the task's `runIds`, so a read pass and the writer pass after it both show.
- `GET /jev-router/tasks` gains `key` and `activity` (from `live.activityOfRuns(t.runIds)`, computed at read time, never saved). An `activity()` that throws is caught and logged, as `waitingOf` does for estimates.
- `GET /jev-router/engine-patches`.
- `GET` and `POST /jev-router/live/settings` use `dataDir/live.json`, validated like `/jev-router/effort`.
- **Client:** `useLive(key, visible)` is a `setTimeout` chain every 700 ms while visible and not terminal, paused on `document.hidden`, and it merges by id and `v`. The work board needs no new poller, because `/tasks` already carries `activity`. The LiveRunCard reads one shared, ref-counted `/tasks` poller (`tasksFeed`) instead of one per card. SSE is deferred, as the existing `useRuns` comment already plans.

#### Engine patch: `scripts/patch-agent-live.mjs` (slice 5)

Modelled on `patch-dsh-model-menu.mjs`:

- **Constants:** `WRITTEN_FOR = '0.1.5-rc.2'`, checked against each connector's own `package.json`; marker comment `/* KZH_AGENT_LIVE 1: patched by Kz-harness scripts/patch-agent-live.mjs */`; `roots()` covers the npx cache and `$DSH_HOME/profiles/*/node_modules/@deepseek-ai`.
- **Per package (Claude and Codex independently):**
  - marker at version 1: `applied`;
  - marker at another version: restore `.kzh-backup` when `.kzh-backup.json` records the same package version, then re-apply; otherwise refuse with a reason;
  - unmarked: check the version, then apply every edit, each anchor matching exactly once, all-or-nothing, CRLF preserved.
  - `.kzh-backup` is **refreshed from the unmarked file each time an unmarked file is patched**, so it always describes the file actually installed now. It holds `patch-codex-effort`'s lines when that patch ran first, which is intended.
- **Exports** (for tests): `EDITS`, `CLAUDE_HELPERS`, `CODEX_HELPERS` (strings) and a pure `patchSource(pkg, src, version, marker)`.
- **Status file:** `$DSH_HOME/kzh-engine-patches.json` holds `{ writtenFor, at, 'claude-code': { result, reason, file, version }, codex: {...} }`.
- **Output, stdout only** (PowerShell 5.1 under `$ErrorActionPreference = 'Stop'` never sees native stderr from it):
  - `patch-agent-live: live view and steering hooks added to Claude Code and Codex`
  - `patch-agent-live: NOT APPLIED to <package>: <reason>. Its runs work as before; the Live tab says live detail is off.`
  - nothing when already applied.
- **Main guard and exit:** main runs under `runAsScript(import.meta.url)` inside try/catch and always exits 0.
- **Launcher:** `Start-KzH.ps1` gets one ASCII line after the `patch-codex-effort` line and before `Write-Host 'Starting the engine.'`:
  ```
  # What each Claude Code and Codex run is doing (the Live tab), and Steer / Send now into them.
  node (Join-Path $PSScriptRoot 'scripts\patch-agent-live.mjs')
  ```
  `app/main.js` `stepFor` already files `^patch-` lines under Preparing.

**Claude Code edits** (`dsh-subagent-claude-code/lib/index.js`; `\t` is a literal tab; each `from` occurs once in the pinned file, as verified):

| # | name | from | to |
|---|---|---|---|
| C1 | provider class (helpers go above it) | `var ClaudeCodeProvider = class {` | `CLAUDE_HELPERS` + `var ClaudeCodeProvider = class {` |
| C2 | consume loop head | `async function consumeClaudeQuery(query, onPermissionDenied, onResult) {\n\tlet answer;\n\tfor await (const message of query) {` | `async function consumeClaudeQuery(query, onPermissionDenied, onResult, kzh) {\n\tlet answer;\n\tfor await (const message of query) {\n\t\tkzhSeen(kzh, message);` |
| C3 | result selection | `\t\tonResult?.();\n\t\tanswer = successfulResult(message);` | `\t\tonResult?.();\n\t\tif (kzhSkipResult(kzh, message, answer)) continue;\n\t\tanswer = kzhAnswer(kzh, answer, successfulResult(message));` |
| C4 | per-run KzH state | `\tconst prompt = textTask(request.prompt);` | `\tconst prompt = textTask(request.prompt);\n\tconst kzh = kzhStart(request);` |
| C5 | query start | `\t\tquery$1 = query({\n\t\t\tprompt,\n\t\t\toptions: claudeQueryOptions(spec, controller, captureChild, capturePermissionDiagnostic)\n\t\t});` | `\t\tquery$1 = query({\n\t\t\tprompt: kzhPrompt(kzh, prompt),\n\t\t\toptions: kzhOptions(kzh, claudeQueryOptions(spec, controller, captureChild, capturePermissionDiagnostic))\n\t\t});` |
| C6 | published query | `\tconst publishedQuery = query$1;` | `\tconst publishedQuery = query$1;\n\tkzhPublish(kzh, publishedQuery, request.signal);` |
| C7 | consume call | `\t\t\t\t}), publishedProcessFailure]);` | `\t\t\t\t}, kzh), publishedProcessFailure]);` |

`CLAUDE_HELPERS` are hoisted function declarations:

- **`kzhStart(request)`:** `undefined` unless `request.kzhTap` is a function or `request.kzhControl` is an object. Otherwise `{ tap, control, channel, steered: 0, interrupting: false, pending: Map<uuid, state> }`, where `channel` exists only when `kzhControl.channel === true`.
- **`kzhPrompt(kzh, prompt)`:** the string, unless there is a channel. With one, it returns an AsyncIterable whose first yield is exactly the SDK's own string write, `{ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null }`, followed by pushed messages.
- **`kzhOptions(kzh, o)`:** `{ ...o, includePartialMessages: true }` only when tapped.
- **`kzhPublish(kzh, q, signal)`:** fills `control.steer(text, uuid)`, `control.sendNow(text, uuid)` and `control.thinkingDisplay(d)` (which calls `q.setMaxThinkingTokens(null, d)`). Abort ends the channel.
- **`kzhSeen(kzh, m)`:** calls the tap in try/catch. On a `result`, the channel records uuids from `user_message_uuids` and reports each uuid through `control.onOutcome(uuid, 'delivered')`. It then decides whether to close:
  - nothing pending and `queued_turn_count` not > 0: close;
  - pending but the result carries no uuid list: pending uuids become `unknown`, close;
  - otherwise: arm a 30 s timer that closes.
- **`kzhSkipResult(kzh, m, answer)`:** true once, for a non-success result whose `terminal_reason` starts with `aborted_` while `kzh.interrupting`. Also true for a non-success or error result after a successful answer when `kzh.steered > 0`.
- **`kzhAnswer(kzh, prev, next)`:** `prev === undefined || !kzh?.steered ? next : prev + '\n\n---\n\n' + next`.
- **`kzhClaudeSteer` and `kzhClaudeSendNow`:** reject with `code: 'kzh-no-channel'` without an open channel. Send now sets `interrupting`, awaits `q.interrupt()`, then pushes. The message is `{ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '', uuid }`.

With no `kzh`, every helper is the identity or a no-op. The prompt stays a string and the options are unchanged.

**Codex edits** (`dsh-subagent-codex/lib/index.js`):

| # | name | from | to |
|---|---|---|---|
| X1 | wire class (helpers above it) | `var CodexAppServerWire = class {` | `CODEX_HELPERS` + same |
| X2 | single notification entry | `\t\tthis.transport.onNotification((method, params) => {\n\t\t\ttry {\n\t\t\t\tthis.handleNotification(method, params);` | `\t\tthis.transport.onNotification((method, params) => {\n\t\t\tkzhTapSafe(this.kzhTap, { provider: "codex", method, params });\n\t\t\tif (kzhStale(this, params)) return;\n\t\t\ttry {\n\t\t\t\tthis.handleNotification(method, params);` |
| X3 | thread/start request | `\t\tconst thread = object(object(await this.guarded(this.transport.request("thread/start", {` | `\t\tconst kzhStarted = object(await this.guarded(this.transport.request("thread/start", {` |
| X4 | thread/start response | `\t\t}, signal), signal), "thread/start response").thread, "thread/start thread");` | `\t\t}, signal), signal), "thread/start response");\n\t\tkzhTapSafe(this.kzhTap, { provider: "codex", method: "kzh/thread-start-response", params: kzhStarted });\n\t\tconst thread = object(kzhStarted.thread, "thread/start thread");` |
| X5 | turn/start extras | `\t\t\t\tinput: texts.map((text) => ({` | `\t\t\t\t...this.kzhTurnExtras,\n\t\t\t\tinput: texts.map((text) => ({` |
| X6 | Send now continues the thread | `\t\tconst status = terminal.status;` | `\t\tconst status = terminal.status;\n\t\tif (status === "interrupted" && this.kzhNext !== void 0) return kzhCodexContinue(this, signal);` |
| X7 | wire construction | `\tconst wire = new CodexAppServerWire(child.stdout, child.stdin, spec.permissionMode, spec.model);` | same + `\n\tkzhWire(wire, request);` |

`CODEX_HELPERS`:

- **`kzhTapSafe`.**
- **`kzhWire(wire, request)`:** sets `wire.kzhTap`. Only when `kzhControl` is present, it sets `wire.kzhTurnExtras` (effort and serviceTier snapshotted from env) and fills `control.steer` and `control.sendNow`. It runs before `wire.start()`, so no frame is missed.
- **`kzhStale(wire, params)`:** true for a notification whose `turnId` or `turn.id` is in `wire.kzhDone`.
- **`kzhCodexSteer(wire, text, clientId)`:** rejects `kzh-no-turn` when `turnId` is unset, closed or `terminalObserved`. Otherwise it sends `transport.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: clientId })`.
- **`kzhCodexSendNow(wire, text)`:** the same guards, then sets `wire.kzhNext` and calls `wire.interrupt()`.
- **`kzhCodexContinue(wire, signal)`:** adds the old `turnId` to `kzhDone`, clears `turnId`, `pendingTurnId`, `terminalObserved` and `earlyTurnNotifications`, reports `continued`, and returns `wire.runTurn([next], signal)`.

A turn that completes before the interrupt lands leaves `kzhNext` set, and the plugin reports that guidance as `returned`.

- X2 is the connector's single per-frame entry: buffered early frames re-enter `handleNotification`, not this callback, so nothing is tapped twice.
- No anchor touches `patch-codex-effort`'s turn/start anchor. In either order, turn/start carries `threadId`, then the env effort lines, then `...this.kzhTurnExtras`, then `input`.

**`plugins/jev-router/engine-patches.js`** (new): `patchState({ dshHome })` reads `$DSH_HOME/profiles/web/node_modules/@deepseek-ai/dsh-subagent-{claude-code,codex}/lib/index.js` for `KZH_AGENT_LIVE 1`, plus the reason from the status file. It returns `{ 'claude-code': { on, why }, codex: { on, why } }`, cached for 60 s. A read error means off. `runAgent` maps the providers `claude-code` and `claude-code-readonly` to `claude-code`, and `codex` to `codex`.

#### Fail-safe behaviour

- **Unpatched, version mismatch, or anchor missed:** the file is byte-identical, the run behaves exactly as today, and the plugin never sends `kzhTap` or `kzhControl`. The UI states the reason.
- **Tap failures:** every tap call is guarded twice, in the connector and in the plugin, so a throwing tap never changes a run.
- **Partial messages:** requested only when tapped. Result selection reads the same messages as before.
- **Memory:** bounded by the caps. Transcripts on disk are redacted, capped and deleted with their task. The file store is "Keep transcripts: last 100 tasks / off", default last 100.
- **Spawn:** `ctx.on` failure falls back to the pump. The final drain always runs before `dispose()`.

### Feature 2: immediate start reply, and progress replies that make sense

#### What the person sees

All wording lives in `plugins/jev-router/reply-words.js`, which is pure and never model-written. Names come from `nameOfAgent`. A missing model reads `its own default model`. An agent with no effort family has no effort clause.

**A. Plan known.** Forced agents always get this at once, because their agent, model and effort are known at enqueue. For other tasks the reply waits a bounded time for `routed`:

```
OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness, and **Codex** reviews it before it's accepted. I'll report back here when it's done. Keep chatting.
```

Optional parts:

- planner: ` **Claude Code** (claude-opus-4-1) writes a plan for it first.`
- local first: ` If the local model can't finish it, a stronger agent takes over.`
  As built, it is said only when the plan keeps a local model in front of the routed resource, which takes over if it fails, not for the strategy's name alone: a swap off the local model (a capability it lacks, your feedback) gives its step to the routed resource, which then works from the start (`tasks.js` `planOf` sets `localFirst` as `router.js` `promisedHandOver` reads it; slice 2 review).
- read-only: the existing `accessSentence`
- unsure message: the existing `why`
- tool: `OK, I'll run the **<tool>** tool on this in the background as **jev-4** in kz-harness. I'll report back here when it's done. Keep chatting.`
- a forced agent that has to wait its turn: ` It waits 2nd in line (another task is running there, about 4 min left).` (slice 2 build).

**Credit line** (a blockquote like today's `Answered by`):

- `> Picked by Jev in 2.4 s: a code change, medium risk, so effort high.`
- `> Picked by Laya on this PC in 1.9 s: ...`
- `> You picked Claude Code; effort high (Auto in Settings).`
- `> Picked on this PC in 0.4 s, no Jev call: ...`, only when the run's own event log holds no `jev` or `decider-error` event before `routed`.
- Suffix when feedback moved the pick: ` Your feedback moved it off Codex.`
- As built in slice 2:
  - the offline rule, which asks no decider, reads as the fourth line does;
  - a fallback reads `> Picked by the routing rules in 0.3 s, since Jev could not pick (<reason>); effort high (Auto in Settings).`;
  - the credit names who the agent strip under the reply names as the router (`router.js` `pickedBy`, from `routedBy`, which `routerStep` reads too), so a routing Jev was asked for and answered no domain of, its routing calls failed or its answers too flat to use, reads as a fallback does, with the last failed call's error as the reason (`since Jev could not pick (Error: 503 Service Unavailable)`), and never `Picked by Jev` (slice 2 review);
  - one the local router picked after such a call reads `> Picked on this PC in 0.4 s, since Jev could not pick (<reason>): ...`, never `no Jev call` (slice 2 review);
  - an effort that is not Auto names where it came from: `effort xhigh (your pick in the model menu)`, `(the default in Settings)` or `(set for this agent in Settings)`;
  - Auto names the larger of complexity and risk, which is what it reads, and a pick under 50 ms reads `in under 0.1 s`.
  - a pick that gives the work to a tool names no effort, since the plan's is that of the agent that takes over only if the tool fails (slice 2 review).

**B. Waiting:**

```
OK, **jev-5** is queued: 2nd in line for kz-harness (another task is running there, about 4 min left). Jev picks the agent when it starts; I'll say which here, and report back when it's done. Keep chatting.
```

The place, reason and estimate come from `waits.js` `placeText` and `slotFacts`, `WAITING` in `tasks.js`, and the estimate. From slice 9, once earned: `Jev picks the agent when it starts, likely **Claude Code** (effort medium);`.

**C. Pick not made within the bound** (default 15 s, a setting from 0 to 60 s, where 0 means never wait):

```
OK, **jev-4** is starting in kz-harness, and Jev is still choosing the agent (15 s so far). I'll say here which one it picks, and report back when it's done. Keep chatting.
```

**Reasoning lines while waiting.** A block opens only after 600 ms of silence, so a fast pick looks instant.

- During the intent call: `Jev is reading your message (task or question)...`
- During routing: `Queued as jev-4. Choosing the agent (I reply once it's picked, at most 15 s). Stop here ends this reply only; the task keeps going (stop it on the work board).`, then the router's `line(e)` lines.
  As built, the line of a routing that stops for a person names no agent, `Jev read this as needing a person: no agent runs`, here as in the task list and a run's live lines, since the agent its routing would have picked never runs (slice 2 review).

**Milestone notices.** These are engine notice rows: a visible summary, a collapsed body, no model turn, never rated. Summaries never contain `·`, so `resultIdOf` can never read one as a result.
Until slice 4 brings the Live tab, the started notice's body says `Watch it on the work board; the result posts here when it's done.` (slice 2 build).

- **Started after the reply named no plan:** summary `jev-5 started: Claude Code, claude-opus-4-1, effort medium`. Body: `**jev-5** started: **Claude Code** (claude-opus-4-1, effort medium) is working on it in kz-harness. It waited 6 min for the folder. Watch it in the Live tab; the result posts here when it's done.`
- **Started again after a read pass handed it back:** summary `jev-4 started again as work that writes`. Body: `**jev-4** needed to change files, so it started again as work that writes: **Codex** (gpt-5.5, effort medium).`
  As built, that body is for a hand-back because the work changes files (its agent said so, or its routing named work that may), which the hand-back says (`changesFiles`); any other reads `**jev-4** could not run locked against writing (<the router's reason>), so it started again as work that writes: ...`, and one with no reason known `**jev-4** was handed back by its read pass, so ...` (slice 2 review).
- **Change of plan** (the reply named a different agent or effort; only from a predicted reply or a "likely" clause): summary `jev-4: Codex instead of Claude Code`. Body: `Claude Code reached its 5-hour limit (resets 14:20), so Jev gave the work to Codex (gpt-5.5, effort medium).` The reason clause appears only for a hard fact on the routed record (limit, signed out, weekly gate, feedback move). Otherwise: `Jev picked Codex (gpt-5.5, effort medium) when it started.`
- **Moved mid-run** (a retry on another agent): summary `jev-4 moved to Codex`. Body: that event's `line()`.
  As built, the body is the lines of the events that caused the retry since the previous attempt, then the retry's own line (slice 2 build).
  Those events are a review, a usage limit of the agent whose step it was (the work's, or the plan's before it), and that agent's balance falling under its floor before its limit (slice 2 review).
  A balance that only runs low keeps the work where it is, and a limit of Jev's own key, of a parallel opinion or of a reviewer leaves it there, so no line of theirs is among them (slice 2 review).
  A gate or a capability moves the work while it is routed, before `routed`, and a stall ends the run, so no line of theirs is ever among them either (slice 2 review).
  A routing gets one moved notice, for its work's first move to another agent, so a later move in it posts none, and the task list says where the work is then (slice 2 review).
  As built, a reply stopped in its wait that has not said what it named when its work moves is taken to have named nothing then, as its guard would take it later, so its started notice, naming the agent the work started on, goes out before the moved notice rather than after it (slice 2 review).
  A task's notices go out in the order they were claimed, whichever takes longer to word or to post, one the chat takes only on its retry included (slice 2 review).
- As built, a change of effort alone reads `jev-4: effort xhigh instead of high`, and a forced agent's body reads `It started on Claude Code (claude-opus-4-1, effort xhigh).`, since nobody picked it (slice 2 build).
  In this build that is the only change there is: a reply names a forced agent's plan, which routing never moves off its agent, or the pick it waited for, so the notice naming another agent, and its reason, come with the replies that predict the pick in slice 9 (slice 2 review).

At most one notice per kind per plan generation. They are remembered in the saved `progressPosted`, so a restart never repeats one. Setting: `Progress in chat: Milestones (default) / Start and result only`.
The setting is stored as `progress: 'milestones' | 'off'`: `off` posts no milestone notice, the started one included, so B and C then promise only the result (`I'll report back here when it's done.`) rather than to say the pick (slice 2 build).

**Result.** Still today's notice. Its head gains `Agent: Claude Code · claude-opus-4-1 · effort high · took 7 min` and, from slice 8, one line per piece of guidance.
The agent, model and effort are the work's own, as the task list shows them: the effort its working attempt started at (none for an agent that takes none, whatever level the task was queued at) and the model that attempt ran, never a planner's, a reviewer's or a parallel opinion's (slice 2 review).
As built, a routed task shows no effort until its working attempt starts, so one stopped before that names none, and a run the router stops for a person keeps no agent, model or effort, so its head reads `Agent: Jev picks`, as a result nobody was picked for does (slice 2 review).
As built, any task that ends before its working attempt starts keeps no effort, so a forced agent's head names none when it is removed from the line, refused before it is routed or stopped in line by a restart, whatever level it was queued at (slice 2 review).
As built, a tool that did the work is named as its start reply named it, in the head (`Agent: the lint tool · took 3 s`) and in what a direct answer is told, not by the `tool:lint` the task list keeps (slice 2 review).

**Direct answers while tasks are live.** `ABOUT` gains one sentence built from the task records: `Right now in this chat: jev-4 is running on Claude Code (6 min, last: running npm test); jev-5 waits 2nd in line.` So "how is it going?" gets a true answer. Progress notices (jev-router notices whose summary `resultIdOf` rejects) are removed from the messages `answerDirectly` sends. Result notices stay.
As built, a forced agent's task that is still starting is named with its agent, `jev-4 is starting on Claude Code`, since nobody chooses it; any other still starting is said to be starting while its decider chooses its agent (slice 2 review).

#### Data flow

1. **`router.js`:**
   - New exported pure `plannedEffort({ effort, config, agentDef, routing, model, bands, shift })`, used by `attempt_start`, the parallel opinion, `routed` and the orchestrator's forced path. The reply therefore names exactly the effort the first attempt runs at.
   - `routed` gains `primary: { agent, model: deps.modelOf(agentDef), effort, level, speed }`, and `planner` and `reviewer` (`{ agent, model }`) when the plan has them.
     A run about to stop for a person (`human_required` at the decider's bar) runs no agent, so its `routed` carries `stopsForPerson: true` instead of those three (slice 2 review).
   - A read pass's hand-back (`NEEDS_LANE`) carries `changesFiles` when the work itself changes files (its agent wrote `NEEDS-WRITE-ACCESS`, or its routing named work that may), and the `access` event that hands the task back says so too (slice 2 review).
   - New exported `agentsMark(steps)`, the encoder `formatReport` inlines today.
   - `runRouted` accepts `taskKey` and `intentSample` and writes them on the record.
2. **`tasks.js`:**
   - `key` (a UUID, saved).
   - `watch(key, fn)` returns an unsubscribe; `enqueue`'s `emit` notifies watchers after `applyEvent`; they are cleared at settle.
   - `applyEvent` keeps `t.plan` (saved) and bumps `t.planGen` on each `routed`.
     A `routed` that stops for a person leaves `t.plan` null and `t.planGen` as it was, so no reply names a plan for it and no started notice is due (slice 2 review).
     A `routed` clears the effort the task was queued at, which the working attempt sets again as it starts, and one that stops for a person takes no agent from its routing and keeps no model, so the task list and the result name none (slice 2 review).
     The model, which only the working attempt's end records, shows from that end on, so the row names none while that attempt works, and none for a task stopped before its first working attempt ended (slice 2 review).
     A task that ends before its working attempt has started keeps no effort, as it settles and as a restart's `reconcile()` stops it (the saved `workStarted`), so a forced agent, whose agent and level are on its record from the moment it is queued, names none either once it is removed from the line or refused before it is routed (slice 2 review).
     The plan says `localFirst` when it keeps a local model in front of the routed resource, which takes over if it fails (slice 2 review).
     A `routed` takes the task's agent from the plan's worker (`primary.agent`), as `planOf` does, not from the routing's pick, so a LOCAL_FIRST task's row, what a direct answer is told and its result name the local model its reply named from the pick on, through the baseline checks, not the routed resource behind it, which is named only once a retry hands it the work (slice 2 review).
     A read pass's hand-back keeps the agent a forced task was queued for, as it keeps the level it was queued at, since its pass that writes runs on that agent too (slice 2 review).
   - `noteAck(key, { gen, said })`, where `said` is the agent and effort the reply named.
   - `progressPosted` (saved).
   - Pure exported `startedNoticeDue(t)` returns `'started' | 'again' | 'change' | null`, from `plan`, `planGen`, `ackGen`, `said`, `progressPosted` and the state.
     - `'again'` keys off the hand-back itself (the task's `requeuedAt`, set when a read pass hands it back), not off `planGen === 2` alone.
       A read pass handed back while it was being routed (its routing named work that may change files, or picked an agent that cannot be locked, or no agent could be locked at all) emits no `routed`, so the writer pass after it leaves `planGen` at 1 (slice 1 review).
   - `delivered(jobId, { name, sessionId })` refuses a task that is not terminal, and refuses when `name` is given and does not match `t.taskName` (compared with whitespace around `·` removed).
     - It also refuses a `pending` result, since no notice of it can be in the chat, unless a restart caught it posted and not yet seen, which `reconcile()` marks `postedBeforeRestart` (saved; slice 1 review).
       Without this, an old notice under a reused job id that names the same task marks the new result read while its delivery waits for `whenIdle()`, and the result never posts.
       After a restart it would mark read a task the restart stopped, or a result the app closed on before it was posted, neither of which anything posts.
     - It refuses when `sessionId` is given and is not the task's, since the engine reuses job ids in every chat and another chat can hold an old notice with the same id and name (slice 1 review).
   - The job-limit error becomes `Too many background tasks in this chat (10). Wait for one to finish or remove a waiting one, then send it again.` (the number is read from the error).
3. **`index.js` orchestrator:**
   - `enqueue` returns `{ line, jobId, key, startsNow, forcedPlan }`. The adapter still accepts a bare string, so old stubs keep today's line.
     Once the task is queued, `enqueue` never fails the reply: a forced agent's plan that cannot be worked out then (its agent list unreadable for a moment) is left out, and the reply is B or C, since an error would say nothing was queued (slice 2 review).
   - `watchPlan(key, { signal, waitMs, onLine })` resolves with `{ plan, gen, runId, ms, decidedBy }`, or `{ handedBack }`, `{ settled }` or `null` at the bound. It unsubscribes in every case.
     - As built, it also carries `steps`, the strip's chain, and `decidedBy` is `{ by, decider, taskType, complexity, risk, from, movedOff, reason }` for the credit line (slice 2 build); whether a local model goes first is the plan's own `localFirst` (slice 2 review).
       `decidedBy` also says whether the decider was asked before the pick (`called`), and `by` is who the strip's router step names (`router.js` `pickedBy`), with the last failed call's error as the `reason` when the rules or the local router picked after it (slice 2 review).
     - `{ handedBack, waiting, why }` reads where the task stands on the next turn of the event loop, once `runAdmitted` has put it in its folder's line, so a task that waits there is answered with B, not C; B or C then says why it runs as work that writes, and the `again` notice follows (slice 2 build).
       A task that ends during the wait is answered `**jev-4** ended before Jev picked its agent (Failed). Its result is posted here as its own message.`
     - A `routed` that stops for a person is no pick: the wait goes on to the task's end, which follows at once, so the reply reads `**jev-4** ended before Jev picked its agent (Needs input). ...` and never names the agent that would have run (slice 2 review).
   - `noteAck`.
   - As built, `runOf(key)`: the run a task has begun, which C and the reply that a task ended carry, read as they are written, since `enqueue` answers before a task that starts at once has reached its run (slice 2 review).
   - `liveStatus(sessionId)` for `ABOUT`.
   - A notice scheduler posts through `delivery.notify` when `startedNoticeDue` turns true: on each `routed`, on `noteAck`, on a `retry` attempt_start that changes agent, and on a guard timer `waitMs + 5 s` after an enqueue that started at once (for a reply that was aborted).
     As built, the guard is armed for every task queued from the chat, a waiting one's too, so a B reply stopped before it went out is covered as well; a reply that is out has noted its ack long before it fires (slice 2 build).
     As built, a `retry` that changes agent before the reply has noted its ack notes it as naming nothing, as the guard would later, so the started notice goes out before the moved notice; each task's notices are posted one after another, in the order they were claimed (slice 2 review).
   - Settings in `dataDir/chat-replies.json` via `GET` and `POST /jev-router/chat-replies/settings`: `{ waitMs: 15000, progress: 'milestones', askWhenWrong: true }`.
   - `POST /jev-router/tasks/seen` accepts `{ results: [{ jobId, name }] }` beside the old `{ jobIds }`, with `sessionId`, the chat on screen, when the page knows it (slice 1 review).
   - `route()` takes `taskKey` and `intentSample` from the runner.
   - The history record carries `taskKey`.
   - `config/cordis.patch.yml` sets `- id: jobs` / `config: maxConcurrentJobsPerOwner: 32`, with a comment that waiting jev tasks count.
4. **`adapter.js`,** in the `!answerOnly && orchestrator` branch:
   - enqueue as today;
   - forced: reply A at once;
   - waiting: reply B;
   - starts now and `waitMs > 0`: `watchPlan`, with the lazy reasoning block and the intent-wait line, then A or C.
   - `noteAck` is called before the finish chunk. An abort yields nothing more and does not call `noteAck`, and the guard timer then posts the started notice.
   - The reply carries hidden lines after a blank line: `[jev-job]: kzh-job-1-<key>`, `[jev-run]: kzh-run-1-<runId>` (via `withRunMark`) and `[jev-agents]: kzh-agents-1-<base64url>` (a decider step, then the worker with `model, effort`). AgentStrip therefore shows `Jev -> Claude Code (claude-opus-4-1, high)`, and `messageProvenance` names the worker.
     - As built, the worker's step names the agent by its id, as every report's strip does, because a verdict's attribution reads the agent from it (`client.js` `verdictProvider`); the strip therefore shows `Jev -> claude (claude-opus-4-1, high)` (slice 2 build).
       The decider's step carries the model its answers came from, as a report's does, so a Jev pick's strip shows `Jev (jev-1.13.0) -> claude (claude-opus-4-1, high)` and a Laya pick's `Laya (<its model's label>) -> ...` (slice 2 review).
     - The decider step is `router.js` `routerStep`, the one a report's strip starts with; a forced agent's reply has none, and a B or C reply carries only `[jev-job]`, with `[jev-run]` on C when the run had begun as the task was queued.
       As built, C and the reply that a task ended carry the run the task has begun by the time they are written (`orchestrator.runOf`), as a C written at the end of its wait always has; B written as its task is queued, before its run begins, carries none (slice 2 review).
       B or C written after a read pass handed its task back carries the run the task is on by then, as C at the bound does: the pass that writes, when it starts at once, else the read pass, which ended before its pick and has no history row, so a verdict on the reply credits nothing rather than an earlier run of the chat (slice 2 review).
     - The encoders `agentsMark`, `withRunMark` and `RUN_MARK` live in `reply-words.js` with `jobMark`, and `router.js` and `index.js` export them as before.
   - The `alsoWork` path never waits: it appends C's first sentence to the answer, and a started notice follows.
     As built, a task that has to wait its turn gets B's first sentence instead, since C's would say it is starting (slice 2 build).
     A task judged read only then says so, as every start reply does: that it runs locked, or why it waits like work that writes (slice 2 review).
5. **`delivery.js`** `notify(owner, { key, summary, text })`: awaits `whenIdle()`, re-checks right before appending (skips a settled task or the "off" setting), uses a fresh id and `source { kind: 'plugin', plugin: 'jev-router', form: 'notice', summary }`, tries once plus one retry, and never touches `deliveryState`. `resultSection`'s head gains the agent, model, effort and duration.
6. **`client.js`:** `resultIdOf` checks the last field; a new `resultOf(summary)` returns `{ id, name }`; `acknowledgeResults` posts `{ sessionId, results }`, naming the chat on screen (slice 1 review).
   A Jev setup row: `Wait for the pick before replying: up to 15 s`, plus the progress setting.

#### Fail-safe

- `waitMs = 0` restores today's immediate queued line (reworded as B or C).
- The bounded wait holds the chat turn busy; messages typed meanwhile are queued by the engine.
- Stop during the wait ends the reply only. The task keeps going and its started notice still posts.
- A notice can never acknowledge or block a result: the summary format differs, `delivered()` refuses non-terminal tasks, and `notify` never touches `deliveryState`.

### Feature 3: the reply is learned locally until it is instant

**Principle.** The wording is a fixed template (Jev and Laya answer typed questions and cannot write text; generated wording could misstate what runs). What is learned is the set of decisions inside it: task or question (intent), and the agent and effort. Nothing fine-tunes Jev (hosted TypeSafe) or Laya (a zero-shot local model); `docs/laya-auto.md:656-662` keeps Laya fine-tuning out of scope. What is taught:

- a local **intent** domain whose teacher is Jev and whose corrections come from the person;
- a local **reply predictor** trained on what the router actually ran (Jev's picks, or local routing domains' picks), and so indirectly on every person correction the router absorbs;
- under Laya Auto, the person's plan verdicts become labels in `laya-samples.jsonl`, the owner-given labels `docs/laya-auto.md` asks for. Laya's decisions have their own predictor track record.

#### What the person sees

**Behaviour is unchanged until earned** (slices 3 to 8). Settings, Jev setup gains a `How Jev replies` card:

- `Start replies: after routing (median 4.2 s this week)`
- `Task or question: learning, 212 of 750 checked examples (task 190, question 22 of 100 needed); 95% right lately (needs 94%).`
- `Agent and effort prediction: right 41 of the last 50 (quick replies need 45; "likely" needs 16 of the last 20).`
- `Your ratings on replies: 12 liked, 3 disliked`, plus "What it changed" (the last 10 `Learned:` lines from Feature 4).
- A `Recent replies` table: job, what it said, what ran, how (instant, quick, after routing, your pick, waited) and the rating.
- As built in slice 3, the second line ends `95% right of the last 100 checked (needs 94%)`, the window the recent-accuracy gate reads, where the design had `lately`; with nothing checked yet it ends `not scored yet`, and at a local rung it reads `Task or question: read on this PC when it is sure a message is a task, and by Jev otherwise (812 checked examples); 95% right of the last 225 checked.` (slice 3 build).
  At a local rung no bar follows the accuracy: the one it needed to get there is not what keeps it there, which is more than one figure (`domains.js` rollback), so `(needs 94%)` beside `read on this PC` read as a need it was failing at 93% (slice 3 review).
  A predictor not trained yet reads `Agent and effort prediction: not trained yet; it starts once 60 routed tasks are on record (12 so far).`, and Laya's record has a line of its own, `Under Laya Auto: right 18 of the last 20 (...)`, once any of its guesses is scored.
  The ratings line, the `What it changed` lines and the table's rating column wait for slice 6, which brings the verdicts they show; the table's rows are its newest ten replies (slice 3 build).
  As built, the card opens by saying the guess at the agent changes no reply yet, and that task or question changes one only once it is read on this PC, for a message it is sure is a task, which Jev is not asked about and so runs as work that writes (slice 3 review).
  With learning off it says nothing there learns: `Start replies: after routing (not timed while learning is off)`, and `Agent and effort prediction: off while learning is off; nothing is recorded for it, so it does not train.`, or, for a predictor trained before, `...; it was trained on 75 routed tasks before, and no guess is made or checked now.`, with no record and no Laya line (slice 3 review).
  With adaptive routing off (`routing.enabled: false`) and learning on, it opens by saying only the guess at the agent learns: `... Task or question is not learned while adaptive routing is off (routing.enabled in the jev-router configuration): Jev reads every message.`, as the line on task or question below it says (slice 3 review).
  The first line times the replies that waited for the pick until it came or the wait ran out, and says how many ran out: `Start replies: after routing (median 6.1 s this week; 3 of 10 went out when the wait ran out, before the pick)`; with none timed this week it ends `none timed this week`, and with the wait set to Reply at once it reads `Start replies: at once, without waiting for the pick (Reply at once, in Chat replies)` (slice 3 review).
  The table's `how` for a reply whose wait ran out is `wait ran out` (slice 3 review).
  The second line's accuracy is cut down, never rounded up, to the decimals its bar is set to, since `domains.js` holds the share itself to the bar: 211 right of the last 225 (93.8%) read `94% right of the last 225 checked (needs 94%)` while the domain stayed at SHADOW, and reads `93% ...` (slice 3 review).
  A predictor not trained yet reads `Agent and effort prediction: not trained yet; it is training now, on the routed tasks on record (70 so far).` while its first training runs, and `...; its training failed, and it is tried again after 25 more routed tasks (70 so far).` after one failed; both read `it starts once 60 routed tasks are on record` beside more than 60, and so did a start with that many on record and no predictor saved, which trained none until the next task was routed for (slice 3 review).
  The table's `what ran` for a task that ended before routing picked anything, stopped as it waited or read as needing a person, is `nothing ran` with how it ended, `nothing ran (Stopped)` or `nothing ran (Needs input)`, and `not routed yet` only while its task is still to run; it read `not routed yet` for such a task until the task left the newest ten (slice 3 review).
  A reply that went out once its task had ended is in the table too, as one whose wait for the pick ended as routing read the task as needing a person, which with the wait as it ships is how such a task goes, or reply A for an agent that refused the task at once; it was left out, so `nothing ran (Needs input)` showed only for a task whose routing took longer than the wait (slice 3 review).
  A predictor trained with none of Jev's guesses checked yet reads `Agent and effort prediction: trained on 75 routed tasks; no guess under Jev Auto has been checked yet (...)` while Laya Auto's guesses have a record, which the line under it gives; it read `no guess has been checked yet` beside `Under Laya Auto: right 18 of the last 20 (...)` (slice 3 review).
  The table's `how` for a reply that went out at once beside a task that starts at once, C with the wait for the pick set to Reply at once or the sentence of work asked for beside a question answered directly, is `at once`; it read `waited`, with the wait at Reply at once under a first line saying replies go out without waiting for the pick (slice 3 review).

The Router tab lists the `intent` domain with its maturity. It already iterates `DOMAINS`.
As built, the domain's `state()` reports `localLabels`, and the tab's words for GUARDED_LOCAL and LOCAL_ONLY add `, and only when it answers task: Jev decides every other answer` (`client.js` `maturityWords`, slice 3 build).

**Two stages, each gated by measured records:**

- **Quick** (predictor right at least 45 of the last 50 for this decider, prediction confidence at least 0.90, predicted agent available now). The reply goes out as soon as intent is known, without waiting for routing. The credit reads: `> Predicted on this PC from your recent tasks (right 47 of the last 50); Jev read the message in 1.2 s. The pick is checked again when it starts.`
- **Instant** (Quick, plus the intent domain at GUARDED_LOCAL or above with a trusted local `task`). There is no hosted call and no reasoning block before the reply. The credit reads: `> Instant reply: read and predicted on this PC, no Jev call (right 47 of the last 50). The pick is checked again when it starts.`
- In both stages, if `routed` arrives within 600 ms, the real plan is used instead: the Feature 2 credit, no reasoning block.
- If the router later picks otherwise, the change-of-plan notice posts, the miss counts, and the Feature 4 ask may appear.
- Below 45 of 50: `Quick replies paused: right 43 of the last 50` and the replies wait for routing again.
- Under Laya Auto, intent stays Laya's answer (local, about 1 s, never a hosted call), and the predictor's record is Laya's own.

#### Data flow

**Intent domain** (from slice 3):

- `routing-policy.js`: `DOMAINS.intent = { risk: 'LOW', kind: 'multiclass', label: 'message intent', localLabels: ['task'], requiredClasses: ['task', 'question'] }`. The docstring explains the one-way authority.
- `domains.js` `decide()`: `trusted` also requires `!spec.localLabels || spec.localLabels.includes(local.label)`. The reason then reads `local answer question recorded; only task may be decided on this PC`.
- `gatesOf()` adds `verified samples of <class>` (`perClassSamples`) for each required class at the GUARDED_LOCAL and LOCAL_ONLY targets, so a near one-class store cannot promote.
- `features.js` gets `intentFeatures(text, { modalities })`: text shape signals and hashed unigrams and bigrams (`hashedText`), with no workspace counts. `FEATURE_SCHEMA_VERSION` is unchanged; the domain is new.
- New `plugins/jev-router/intent.js` holds `classifyIntent({ domain, message, modalities, ask, fallback })`, a pure wrapper `index.js` `classify()` calls under Jev Auto:
  - The Jev answer (`kind`, `depth`, `alsoWork`, `readOnly`) is kept whole in a closure. `decide()` gets `{ label: kind, confidence: jev.p ?? 1 }`.
  - A local decision returns `{ kind: 'task', decidedBy: 'local', readOnly: null }` (it runs as work that writes, the safe side).
  - Fallback is today's `{ kind: 'task' }`.
  - It returns `intentSample` (the sample id), which is saved on the task and passed to `route()`. Direct answers carry `[jev-intent]: kzh-intent-1-<sampleId>`.
  - Offline mode and Laya Auto are unchanged; no sample is recorded for them.
  - As built, `decide()` gets `{ label: kind, confidence: jev.confidence ?? 1, model }`: `jev.js` `intent()` returns the kind's probability as `confidence`, and has no `p` (slice 3 build).
  - As built, `classify` also hands `classifyIntent` the message's `modalities`, so a picture sets the features' `has_image`; work queued behind a direct answer (`alsoWork`) carries no sample, since the message was a question whatever that work does; and a dead network, adaptive routing off and learning off record nothing either (slice 3 build).
    No test held that a picture reaches the sample until one sent a screenshot through `index.js` itself (slice 3 review).
  - As built, `resolvePolicy` refuses a `localLabels` or `requiredClasses` that is not a list of labels, a `localLabels` that adds a label the domain ships without, and a `requiredClasses` that drops a class it ships with (slice 3 build).
    How many of each class a rung waits for is the LOW gates' `perClassSamples`, which a policy sets for every LOW domain (slice 3 review).
  - As built, nothing holds the domain below a rung that decides until slice 6: a run routed as an answer that changed no file verifies `question`, so the domain can earn GUARDED_LOCAL on such runs, slowly, and a message it is then sure is a task is decided with no Jev call, runs as work that writes and has no `Read only` sentence in its reply, as this design asks (slice 3 review).
  - As built, `classify` is told the folder a message was sent in (`cwd`), and for one with no folder, in the No project space or in the scratch workspace, where a task is refused, `classifyIntent` passes `localMayDecide: false` to `decide()`: a question the local classifier took for a task would be refused there rather than answered, so it decides nothing there and Jev reads every message, as before the slice (slice 3 review).
  - As built, Jev's store is read as the plugin starts, in the background, wherever the intent domain is used: each message records its sample before it is answered, and the store's first use reads and parses the whole file, which kept the first question after a start waiting a second or more on a well-used store (slice 3 review).
    The append that brings the store a slack of rows past its last check still waits for that check, and once the store is at its cap for the whole file to be rewritten, so about once every 10,000 rows a message waits for it, about a third of a second for a 36 MB store on Linux, as a routing decision has since adaptive routing; it is left as it is, a known limit (slice 3 review).
- `training.js` `labelFromRun('intent', ...)` (`labelIntent`):
  - `task`, `verified_outcome`: a non-answer-only run that completed with changed files, or whose capability is not in the answer capabilities.
  - `question`, `verified_outcome`, negative `task`: a completed run whose `routing.capability` is `quick_answer` or `reasoned_answer` and that changed no files.
  - `question`, human: the plan tag `should have been a question`.
  - `question`, human: a liked direct answer.
  - `task`, human, negative `question`: a direct answer disliked with `should have been a task`.
  - Nothing is labelled for answer-only runs, stopped runs, or steered or amended tasks.
  - As built, a label that is not what the message was taken for (a run means it was taken for a task, a direct answer for a question) carries that as its negative, so the plan tag `should have been a question` has the negative `task` too, and a liked direct answer has none (slice 3 build).
  - As built, a run whose routing named a capability that is no answer labels `task` whether or not it was accepted, and `other` and `human_required` name no capability for this rule (slice 3 build).
  - As built, a person's word labels a stopped run's sample too, since it says what the message was whatever the run did; a steered or amended task's still gets nothing (slice 3 build).
  - As built, `learnFrom` labels the sample in Jev's store, the only store one is recorded in, and passes over any sample whose domain is not the one it was listed under (slice 3 build).

**Reply ledger and predictor** (new `plugins/jev-router/reply-ledger.js`; rows in `dataDir/reply-ledger.jsonl`, never any task text):

- **Row:** `{ ts, sessionId, key, jobId, decider, mode, forced, features: intentFeatures plus pool features, predicted: { agent, level, confidence } | null, said: { agent, effort, model, how } | null, ran: { agent, level, effort, model, runId } | null, match, verdict, ask }`.
- **Pool features:** `avail:<id>` for agents enabled, allowed, ready and not out of allowance (the same checks `orchestrator.enqueue` already uses for read locks), `mode:<mode>`, `level:<menu effort>`, `modal:image`.
- **Predictor:** `classifier.js` `trainMulticlass` and `calibrate` on rows with `ran`, label `<agent>|<level>`. It retrains in the background after every 25 new labelled rows, needs at least 60 rows, and runs one retrain at a time. The artifact is `dataDir/reply-model.json`, saved through `saveArtifact` and `loadArtifact` with domain `reply_predictor`. `predict()` masks the answer to agents available now and is trusted only when the unmasked top class is also the masked top.
- **Gates** (pure): `trackRecord(decider, n)`, `quickGate` (45 of 50), `likelyGate` (16 of 20); the thresholds can be overridden in `config.replies`.
- It writes to no routing training store, so it never promotes a routing domain.
- As built in slice 3:
  - the pool features also carry `decider:<id>`, and `avail:tool:<id>` for each tool switched on, since a tool is a pick too (`tool:<id>` is what ran);
  - a row's `predicted` also carries `trusted`, and its `said` carries `ms`, the time from queueing to the reply going out, which the card's median reads; `said.how` is `routed`, `forced` or `waited` until slice 9 adds `quick` and `instant`, and `match` is null until there are both a guess and what ran;
  - a reply whose wait for the pick ran out first (C at the bound) is `bound`, which its ack says (`adapter.js`), and the card's median times it with `routed`, counting it apart as `atBound`, since leaving it out hid the replies that waited longest and, with routing slower than the wait, said none waited at all; the summary also carries the wait replies are given now, `waitMs`, so with it at 0 the card says replies do not wait (slice 3 review);
  - the predictor learns from rows whose agent nobody picked by hand, trains in a worker thread on the newest 500 of them, the oldest four fifths fitted and the newest fifth calibrated, never shuffled, with no class balancing, since it is asked what the router will most likely pick; trained in the event loop it held the loop 1.4 s on 200 rows and 9.4 s on 1000 here;
  - a reply that named a tool is kept as naming it, `tool:<id>` with no effort or model, as what ran is, never as the agent that takes over only if the tool fails (slice 3 review);
  - the file is rewritten to one line per task, its newest 1000, once it has grown that many lines past them; never when it could not be read, since the copy would hold only what the ledger knows, and after a rewrite that failed, once another 1000 lines are appended (slice 3 review);
  - a predictor whose save the disk refuses (a reader holding `reply-model.json` on Windows) is tried again over about a tenth of a second and, if the save still fails, used all the same, as a routing domain's is, with `reply predictor not saved` in the log; before, it was thrown away and logged as not trained, and no guess was made until 25 more tasks were routed (slice 3 review);
  - `config.replies` is `{ quick: { right, of }, likely: { right, of } }`, and `replyGates` refuses a `right` above its `of` at start-up;
  - nothing is recorded with learning off, and `GET /jev-router/replies/summary` says so (`learning: false`) (slice 3 build);
  - the summary's newest replies each carry `ended`, the final state of the reply's task, read from the task list by key since job ids start again after a restart, `true` once the task has left the list, and null while it is live: a task that ended before routing picked anything never gets `ran` (slice 3 review);
  - a ledger read with rows enough and no predictor trained through them, as after a start with `reply-model.json` deleted or never saved, trains one as it is read rather than once the next task is routed for, never while learning is off (`learns`, though the card still reads the ledger then), and the summary says whether a training is under way (`training`) and how many new rows the next one waits for (`retrainEvery`) (slice 3 review);
  - a reply that went out at once beside a task that starts at once, C with no wait for the pick or the sentence of work asked for beside a question answered directly, is `now`, which its ack says (`adapter.js`), and is not timed; `waited` is then a reply whose task waited its turn or which waited for a pick that did not come (slice 3 review);
  - the row's features read the message as the person wrote it, as its intent sample does, which the adapter hands `enqueue` beside the task (`message`): the task of a message with a picture starts with the line that hands the agent its path, and the row read that line too, folders of this PC and the attachment among its hashed words and the line in its length and line counts (slice 3 review);
  - a ledger disposed of, as the plugin closing or applied again leaves it, starts no retrain: a task of the old plugin still running notes its rows there, and a retrain they started had nobody to end it and saved what it trained to `reply-model.json` behind the plugin that replaced it, even when the change was switching learning off (slice 3 review);
  - nor does a ledger disposed of rewrite the file, which it only appends to: the plugin that replaced it appends its own rows there, and a rewrite from what the old one held dropped them, for good once the plugin started again; each rewrite reads the file again first, each task's newest line there winning, so the live ledger keeps the rows the disposed one appended since it read the file, and the ledgers of one file append and rewrite it one at a time, so a line appended during a rewrite lands in the file the rewrite leaves (slice 3 review);
  - a reply that goes out once its task has ended, as one whose wait for the pick ended with the task (read as needing a person, stopped, failed) or reply A for an agent that refused the task at once (signed out, at its usage limit), is kept as any other, and reply A as `forced`, since the plan it names is kept apart from the task's follow, which is let go as the task settles; such a reply was never kept, so with the wait as it ships Recent replies never held a task read as needing a person, which routing reads within the wait (slice 3 review).

### Feature 4: like or dislike each start reply, say why, and it trains the router

#### What the person sees

The existing AnswerVerdict already renders under the start reply, which is the turn's closing assistant message. When the text carries `[jev-job]`, it switches to plan mode:

- **Group:** aria-label `Rate this pick`. Like has the title `The right agent and effort`; Dislike has the title `The pick was wrong`.
- **Tags:**
  - Like: `good pick`.
  - Dislike: `wrong agent`, `wrong effort`, `misread my question`, `wrong scope`, `should have been a question`.
- **Selects:**
  - `should have been` (the existing agent select) shows with `wrong agent` or an untagged dislike.
  - `effort should have been` (Low / Medium / High / Extra high / Max) shows only with `wrong effort`.
- **Reason placeholder:** `What was not accurate?`
- **`Learned:` line.** After each save, one muted line gives the server's own words for what it changed:
  - `Saved. It is applied when jev-4 ends.`
  - `Learned: the next task in this chat goes to Codex unless you pick one, and this run's pick is labelled for the local router.`
  - `Learned: this run's task type is marked wrong for the local classifier.`
  - `Learned: marked as a question for the task-or-question classifier (it has 214 checked examples).`
  - `Learned: 2 of 3 "effort too high" ratings for Codex on doc edits; at 3, Auto effort there drops one step.`
  - `Learned: Auto effort for Codex on doc edits now runs one step lower (Settings, Effort to reset).`
  - `Learned: this run's pick is confirmed for the local router.`
- **Stop while running:** `should have been a question` given while the task still runs adds a `Stop jev-4` button.
- **One unprompted ask.** It appears only when what ran differs from what the reply said and nothing was rated: `It ran on Codex, not Claude Code as I said. Which was right?` with `[Claude Code] [Codex] [Doesn't matter]` and a small `Don't ask me this`. Rules:
  - at most one open ask per chat;
  - gone after two more typed messages;
  - never asked twice for one reply;
  - off after `Don't ask me this` (the `askWhenWrong` setting).
- **Direct answers** gain the dislike tag `should have been a task`.
- **Settings, Effort:** `Learned from your ratings: Codex Auto effort one step higher for debugging (3 of your last 4 "wrong effort" ratings).` with `[Reset]` and a toggle `Let my ratings move Auto effort` (default on; see 5.3).
- **README fix:** delivered background results (user-role notices) carry no Like/Dislike. The start reply does.

#### Data flow

- **`feedback.js`:**
  - `validFeedback` accepts `about` (`'answer'` by default, or `'plan'`), `taskKey` (UUID), `suggestedEffort` (`low` through `max`) and `intentSample`.
  - `PLAN_TAGS` = `['good pick', 'wrong agent', 'wrong effort', 'misread my question', 'wrong scope', 'should have been a question']` are valid only with `about: 'plan'`. Answers accept `TAGS` plus `should have been a task`.
  - `tagVotesOnAgent(tag)` is false for the answer tags, `wrong effort`, `should have been a question` and `should have been a task`.
  - Unknown values still reject the whole body.
- **`acceptVerdict`:** stamps server-side facts from the ledger row (by `taskKey` and `sessionId`): `planAgent`, `planEffort`, `planLevel`, `planModel`, `taskType`, and `runId` when the ledger has one. It appends (append-only, newest wins, tombstones unchanged), runs `onVerdict`, and returns `effects`, which `POST /feedback` sends back.
- **Binding** (fixes jobId reuse and the time-window mislabel):
  - `runOfVerdict`: by `runId`; else by `taskKey`, the earliest run of that task in the session; else today's rule, for answer verdicts only.
  - `training.js` `feedbackFor`: `taskKey` matches `record.taskKey`. A plan row with neither `runId` nor `taskKey` never matches by time.
  - `onVerdict` returns early while the run has not ended.
  - `createFeedbackRoute(...).bindRun(record)` is called after `learnFrom` in `route()`, inside the route's own queue. It runs `onVerdict` for the newest plan row per message with that `taskKey`. Relabelling is already idempotent (unchanged labels are skipped), so a replay changes nothing.
- **Effects:**
  - `creditVerdict` returns `[]` for `about: 'plan'` before any retract, and `profiles.js` `verdictIsAbout` is false for it: plan verdicts judge the choice, not an answer.
  - `FEEDBACK_DOMAINS` adds `intent` (via `record.intentSample`, or the answer's `intentSample`).
  - `misread my question` and `wrong scope` go through the existing MISREAD path; `good pick` through the existing human positive.
  - `should have been a question` gives intent `question` (human).
  - `wrong agent` with `suggestedAgent` sets the session suggestion and the feedback prior (existing), and gives a human label on the run's `resource_selection` sample (`labelResourceSelection` reads plan rows).
  - Laya-decided runs are relabelled in `layaStore` (existing `onVerdict` rule).
- **`router.js` `feedbackPrior`:** `counts = tagVotesOnAgent(r.tag)`. Non-voting rows still add their reason to `reasons` for the routing prompt, prefixed `plan:` for plan rows.
- **`effort.js`:**
  - `effortBias(rows, family, taskType, resetAt)` returns -1, 0 or +1 from the last 5 `wrong effort` plan rows for that pair, comparing `suggestedEffort` with the stamped `planLevel`. At least 3 must agree in direction.
  - `toAgentEffort(..., { shift })` moves only an `auto` level, within low to xhigh. It never goes to max or ultra, and never touches a per-message level or a Settings override.
  - `plannedEffort` passes `shift` for the agent's family and the routed task type.
  - `routed` records `nudged: { from, to, why }` and `line()` says `effort raised one step for debugging: your ratings`.
  - Reset stores `ratingsResetAt` in `effort.json` (`POST /jev-router/effort/ratings-reset`). Nothing is deleted.

### Feature 5: queue controls, Send now and Steer, for queued and running work

#### Where the controls sit

- **Work board:**
  - waiting rows: `[Send now] [Steer...] [Remove]`
  - running rows: `[Steer...] [Stop]`
  - aria-labels `Send jev-5 now` and `Steer jev-4`
- **Tasks tab rows:** the same, beside the existing `Run next` and `Clear`.
- **Live tab composer:**
  - running: placeholder `Steer jev-4: tell Claude Code something while it works`
  - waiting: `Add to jev-5 before it starts`
- **LiveRunCard:** `Steer...` and `Send now...`.
- **Engine chat queue overlay (TaskQueue):** `Send now` on queued prompts, only while `snap.running`. It calls `face.updateQueue(id, { kind: 'steer' })`, with the tooltip `Give this to the current turn at its next step instead of waiting for the turn to end`.
- **Chat:** `/now jev-5`, `/steer jev-4 <text>`, and `@jev-4 <text>` as a message. The adapter handles the `@` form before any classify call; the job is looked up in this session, newest first.

#### Send now: waiting task

Mechanism:

- `lanes.admit(k, id)`, synchronous:
  - id not waiting in `k`: `{ result: 'not-waiting' }`;
  - lane has a holder: `{ result: 'busy', holder }` and nothing moves;
  - otherwise it removes the waiter, sets `holder` and `who`, `holding++`, calls `go()` and `retell()`. This works at or over the cap; `overCap` and `slotFacts` already word it.
- `tasks.startNow(key)` returns `'started' | 'workspace-busy' | 'chat-busy' | 'not-waiting' | 'already-finished'`.
- `POST /jev-router/tasks/start-now { key }`.
- `view().controls.sendNow` is `'slot'` for wait reasons cap or line, or any read-only task; `'workspace'`, `'chat'` or `null` otherwise.

Dialogs close with `jev-5 has already started.` when the task leaves the line (the `confirmDrift` pattern).

- **Slot wait**, title `Start jev-5 now?`:
  - over the cap: `It runs beside 2 other tasks, over your limit of 2 tasks at once (Settings, Resource budget), so the next task to end frees no slot.`
  - jumping its line: `jev-3 and jev-4 were ahead of it in kz-harness; they wait for it now.`
  - read-only: `It runs locked against writing, beside the task changing kz-harness.`
  - when a local model runs or the task is forced local: `jev-3 runs a local model on this PC; two at once can slow it down a lot.`
  - buttons `[Start now] [Cancel]`; toast `jev-5 started.`
- **Folder held by a task**, title `jev-4 is changing kz-harness`, body `Only one task changes a folder at a time. You can put jev-5 first in line, or stop jev-4 now (what it changed so far stays in the folder) and start jev-5.` Buttons `[Put first in line] [Stop jev-4 and start this] [Cancel]`. The second is the existing stop plus reorder, behind the confirmation `Stop jev-4? Work it already did stays in kz-harness. jev-5 starts as soon as it has stopped.`
- **Held by a chat run:** `A run started from the chat is using kz-harness; jev-5 can go first in line after it.` with `[Put first in line] [Cancel]`.
- **Refused after a race:** `jev-5 could not start now: jev-2 is changing kz-harness, and two tasks never write one folder at once. It stays in line; Run next puts it first.`

#### Steer: waiting task

- `tasks.amend(key, text)` works only while the task is `queued`, and returns `'added' | 'started' | 'already-finished'`. It appends `\n\nAdded while it waited: <text>` to `t.task` and `t.taskText`, pushes `{ id, at, text, how: 'amend', state: 'added' }` onto `t.steers` (saved, text clipped to 2000 characters), and persists.
- **Race-free:** the grant, the runner's `run()` call and `onEntry` happen in one chain of microtasks. `route()` with `laneHeld` awaits nothing before `onEntry` and reads `t.task` at call time. An HTTP handler is a macrotask, so it either lands before or sees `routing`.
- Read-only tasks stay locked; guidance asking for writes makes the read pass hand the task back.
- **Dialog:** title `Steer jev-5`; body `Your words are added to the task before it starts. It keeps its place in line.`; placeholder `What should it do differently?`; button `Add to task`. Drift: `jev-5 started while you were typing, so your words were not added. Steer it again: they now go to the running agent.` The typed text stays in the box.
- **Chat reply:** `Added to jev-5 before it starts. Jev chooses the agent with it.`

#### Steer: running task

- **Registry.** `index.js` keeps `steerers: runId -> { key, attempt, role, agentId, provider, sub, control }`, set in `runAgent` after `start()` and removed in `finally`. Only work roles (`primary`, `retry`, `plan`) can be steered; an opinion or a review cannot.
- **Route and prefix.** `POST /jev-router/tasks/steer { key, text, how: 'auto'|'amend'|'live'|'follow-up'|'restart'|'now' }` answers `{ result, state, words }`. The text is prefixed `(Added by the person while you work on this task.) `.
- **Delivery per provider** (in `plugins/jev-router/steer.js`):
  - **Spawn (DeepSeek, API, local):** `sub.localAgent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })`. `delivered` when `agent/inbox/claimed` reports that id, or the pump sees a `user/message` with it. Words: `DeepSeek takes this in at its next step.`
  - **Codex (patched):** `control.steer(text, clientId)`, which is `turn/steer`. It is `delivered` when a tapped `userMessage` item carries that `clientId`. A rejection (no active turn, or a review or compaction turn) moves it on as below. Words: `Codex takes this in at its next step.`
  - **Claude Code:** only when the experimental toggle is on (the input channel, slice 10). `delivered` when a result's `user_message_uuids` includes the uuid; `unknown` otherwise. Never re-sent. Words: `Claude Code takes this in between tool calls; if it finishes first you'll be told it wasn't used.` With the toggle off, `Now, while it works` is disabled: `Claude Code can't take messages mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code"). It goes to the next attempt if there is one.`
  - **No live path** (toggle off, unpatched, between attempts, during checks or review): the guidance stays `pending` on the task.
- **Every prompt built later includes all guidance so far.** `deps.guidance(runId)` returns the task's steers. `router.js` `withGuidance(prompt, items)` appends `The person added this while the task ran; follow it:` plus the items to the primary, retry, plan and review prompts, so a reviewer judges against it too. Items that were not delivered live become `carried`.
- **Always offered, whatever the provider:**
  - `After it finishes, as a follow-up task`: enqueue `Follow-up to jev-4: <text>` in the same folder, forced to the same agent, first in line.
  - `Stop it and start again with this`: confirm `Stop jev-4 and start again with your message? What it changed so far stays in kz-harness.`, then stop and enqueue `<original task>\n\nThe earlier attempt (jev-4) was stopped; its changes are in the working tree. Also: <text>`, forced to the same agent and first in line. The stopped result's head says `Stopped to start again as jev-6 with your guidance.`
- **One state per piece of guidance,** shown in the Live tab, the Tasks row, the LiveRunCard and the result head:
  - `pending`: `Waiting for its next step`
  - `delivered`: `Read by Claude Code at 14:02`
  - `carried`: `Goes to the next attempt (Codex, review)`
  - `returned`: `Not used: Claude Code finished first`, with `Copy` and `Send as a follow-up`
  - `unknown`: `Sent; Claude Code did not say whether it read it`

  At run end, or on Stop, anything still pending becomes `returned`. Result head lines: `Your guidance "<60 chars>": read by Claude Code.` / `...: went to the next attempt (Codex, review).` / `...: not used (arrived after the work finished).`
- **Learning hygiene:** `record.steered` counts live and carried steers, and `record.amended` marks amended tasks. Steered runs give no `first_pass_quality` or `instruction_following` evidence (`profiles.js` `evidenceFromRun`), and `labelClassification` and `labelIntent` skip steered or amended records. Other outcome labels stay.
- **Chat replies for `@jev-N` and `/steer`** (no model call):
  - `Sent to jev-4: Codex takes it in at its next step.`
  - `jev-5 hasn't started, so I added this to its task.`
  - `jev-4 is running its checks right now, so this goes with its next attempt, if there is one.`
  - `jev-4 already finished. Send it without @jev-4 to start a new task.`

#### Send now: running task (slice 10)

The running dialog gets `Send now` (Ctrl+Enter) beside `Steer` (Enter), with the confirmation `Stop the current step and give it this now? Work already done stays in the folder.`

- **Spawn:** remove our unclaimed steers with `inbox.remove(id)`, then `localAgent.cancel({ kind: 'parent' }, { keepInbox: true })`, then `localAgent.followup(msg)`. `sub.result` is the new turn's (0.3). The old turn reads `Replaced by your message` in the Live tab.
- **Codex (patched):** `control.sendNow(text)`, which interrupts the turn and continues the same thread with the run's own effort (X6, `kzhTurnExtras`). If the turn completed first, the guidance is `returned`.
- **Claude Code (toggle on):** `control.sendNow(text, uuid)`, which calls `query.interrupt()` and then pushes. The aborted result is skipped once (C3).
- **Anything else:** `Send now` is disabled with its reason. `Stop it and start again with this` stays.

---

## 2. File-by-file changes

- **`scripts/patch-agent-live.mjs`** (new, slice 5): the patch as in Feature 1: `EDITS` C1-C7 and X1-X7, the helper strings, `patchSource`, `roots()`, version and marker handling, the backup refresh and upgrade-from-backup, the status file, stdout only, `runAsScript`, exit 0. The header says how to revert: copy `.kzh-backup` back and drop the Start-KzH line.
- **`Start-KzH.ps1`** (slice 5): one ASCII line after `patch-codex-effort`.
- **`config/cordis.patch.yml`:**
  - slice 1: `- id: jobs` / `config: maxConcurrentJobsPerOwner: 32`, with a comment;
  - slice 5: a comment next to the Codex effort note naming `patch-agent-live` and saying that a connector reinstall disables it until Start-KzH runs again.
- **`plugins/jev-router/tasks.js`:**
  - slice 1: `key`; `watch`; `plan` and `planGen`; `progressPosted`; `noteAck`; `startedNoticeDue`; hardened `delivered(jobId, { name })`; readable job-limit error; SAVED gains `key`, `plan`, `progressPosted`, `intentSample`.
  - slice 4: `activity` in `view()`; `onDrop` hook from `trim()` and `clear()`.
  - slice 7: `lanes.admit`, `startNow`, `amend`, `steers` (SAVED), `controls` in `view()`.
  - slice 8: `noteSteer(key, id, patch)`.
- **`plugins/jev-router/router.js`:**
  - slice 1: `plannedEffort`; `routed.primary`, `planner` and `reviewer`; `agentsMark`; `{ attempt, role }` in execute options; `taskKey` and `intentSample` on the record.
  - slice 5: `servedModel` on attempts; `apiEquivalentUsd` on usage rows.
  - slice 6: `feedbackPrior` with `tagVotesOnAgent`, and plan notes; `shift` via `effortBias`; `nudged`.
  - slice 8: `withGuidance` (exported, pure) at every non-tool prompt build; `record.steered` and `record.amended`.
- **`plugins/jev-router/index.js`:**
  - slice 1: `route()` takes `taskKey`, `jobId` and `intentSample`; the runner passes them; `/tasks/seen` accepts `results`; the history record carries `taskKey`.
  - slice 2: the orchestrator's `enqueue` object, `watchPlan`, `noteAck` and forced plan; the notice scheduler and guard timer; `liveStatus`; chat-replies settings routes.
  - slice 3: `classify` through `intent.js`; the ledger's `note` and `routed` hooks; `GET /jev-router/replies/summary`; `learnFrom` labels intent.
  - slice 4: live store; spawn follow (listeners, pump, drain before dispose); `live.router` in `onEvent`; `GET /jev-router/live`; `activity`; transcript persist and drop.
  - slice 5: `engine-patches.js` gating; `kzhTap` and `kzhControl` in `start()`; tapped usage, cost and `servedModel` returned; `GET /jev-router/engine-patches`; live settings routes.
  - slice 6: `acceptVerdict` stamping and `effects`; plan branch in `creditVerdict`; `runOfVerdict` by `taskKey`; `FEEDBACK_DOMAINS += intent`; `bindRun` after `learnFrom`; `GET /jev-router/replies?key=`; the effort ratings-reset route.
  - slice 7: `POST /tasks/start-now` and `/tasks/steer` (amend, follow-up, restart); `/now` and `/steer` commands.
  - slice 8: `steerers` registry; live steer for spawn and Codex; outcome resolution; `deps.guidance`.
  - slice 10: Send now paths; `kzhControl.channel` from the toggle; `thinkingDisplay` when set.
- **`plugins/jev-router/adapter.js`:**
  - slice 2: normalized enqueue result; bounded wait with lazy blocks (intent and routing); A, B and C replies with marks; `alsoWork` sentence; progress notices removed from `answerDirectly` messages; `ABOUT` status sentence. `queuedLine` stays for callers without a key.
    As built, no caller of it is left: an orchestrator that answers a bare line with no key gets that line back as it is, so only its own tests call `queuedLine`, and the live replies have tests of their own for what it says (slice 2 review).
  - slice 3: the `[jev-intent]` mark on direct answers.
  - slice 7: the `@jev-N` shortcut.
  - slice 9: quick and instant paths; `likely` clause.
- **`plugins/jev-router/delivery.js`:**
  - slice 2: `notify`; result head with agent, model, effort and duration.
  - slice 8: guidance lines.
- **`plugins/jev-router/reply-words.js`** (new, slice 2; extended in 3, 6, 7, 8 and 9): every sentence above, pure; summary builders strip `·`.
- **`plugins/jev-router/reply-ledger.js`** (new, slice 3): ledger, predictor, gates.
- **`plugins/jev-router/intent.js`** (new, slice 3): `classifyIntent` and `labelIntent` inputs.
- **`plugins/jev-router/live.js`** (new, slice 4; Claude and Codex projectors in slice 5).
- **`plugins/jev-router/engine-patches.js`** (new, slice 5).
- **`plugins/jev-router/steer.js`** (new, slice 8; Send now in slice 10): registry helpers, provider delivery policy, outcome machine, words.
- **`plugins/jev-router/routing-policy.js`** (slice 3): `DOMAINS.intent`; the `localLabels` and `requiredClasses` docs.
- **`plugins/jev-router/domains.js`** (slice 3): the `localLabels` trust rule; the `requiredClasses` gates.
- **`plugins/jev-router/features.js`** (slice 3): `intentFeatures`.
- **`plugins/jev-router/training.js`:**
  - slice 3: `labelIntent` in `labelFromRun`.
  - slice 6: `feedbackFor` by `taskKey`, and no time match for plan rows; `labelResourceSelection` reads plan rows.
  - slice 8: skip rules for steered or amended records.
- **`plugins/jev-router/feedback.js`** (slice 6): fields, `PLAN_TAGS`, `should have been a task`, `tagVotesOnAgent`.
- **`plugins/jev-router/effort.js`** (slice 6): `effortBias`, `shift`, and the unified level helper.
- **`plugins/jev-router/profiles.js`:**
  - slice 6: `verdictIsAbout` false for plan rows.
  - slice 8: steered runs give no `first_pass_quality` or `instruction_following` evidence.
- **`plugins/jev-router/client.js`** (every new pure helper goes in a marked `// ---- pure ... helpers` block and is exported through `__test`):
  - slice 1: `resultIdOf` (last field), `resultOf`, acks posting `results`.
  - slice 2: chat-replies settings rows.
  - slice 3: `How Jev replies` card.
  - slice 4: `useLive`, shared `tasksFeed`, LivePane plus the Live tab registration, LiveRunCard (slot order 105), WorkBoard line, Tasks live tail, `Open Live` action, live helpers (`mergeLive`, `activityLine`, `stallWords`, `reasoningPreview`, `attemptTitle`, `cleanTerminal`).
  - slice 5: Jev setup `Live agent view` card and patch notes.
  - slice 6: AnswerVerdict plan mode, `Learned` line, the ask, `should have been a task`, the Effort settings line.
  - slice 7: Send now and Steer buttons and dialogs, TaskQueue `Send now`.
  - slice 8: running steer variants and states.
  - slice 10: Send now running, and the Claude toggle wiring.
- **Tests and fixtures:**
  - `plugins/jev-router/test/fixtures/engine/`: the two pinned connector `lib/index.js` files (MIT) with their `package.json`, a `NOTICE` naming origin and version, and ESM stubs for `@deepseek-ai/{schemastery, dsh-timeout, dsh-subagent, dsh-brand, dsh-subprocess, dsh-sdk-protocol}` and `@anthropic-ai/claude-agent-sdk`.
  - New test files as listed per slice.
- **Docs:**
  - `README.md`: a Live agent view section with the patch and how to revert it; start replies and notices; feedback on the pick; Send now and Steer; fix the Like/Dislike-on-results line.
  - `docs/adaptive-routing.md`: the intent domain, one-way authority, `requiredClasses`, the reply predictor.
  - `docs/laya-auto.md`: Laya Auto keeps its intent, and plan verdicts label its store.
  - `docs/handoff.md`: the owner-PC checks in section 5.

---

## 3. Tests per slice

Rules, taken from `scripts/red-check.mjs`:

- Every new test must fail on the previous slice's commit by an assertion, by a missing export, or (only for a new module's own test file) by a missing module. Check with `node scripts/red-check.mjs <files> --base <previous slice commit>`.
- An extended existing test file imports new exports through a namespace import or `await import()`.
- A client test first asserts `typeof t.<Helper> === 'function'`, so its failure at the base is an assertion, not a TypeError.
- Route tests boot `index.js` with the `speed-routes.test.js` fake ctx, where a new route answers 404 at the base.

**Slice 1: groundwork and hazard fixes.**

- `test/tasks.test.js`: "delivered() on a running task returns false, deliveryState stays pending, and the later delivery posts exactly once". Fails today: `delivered()` marks any state.
- `test/tasks.test.js`: "delivered() with a name that is not the task's leaves it unread (a job id reused after a restart)". Fails today: name ignored.
- `test/tasks.test.js`: "each task gets a key, kept across a restart, and a reused job id gets a different key". Fails today: no `key`.
- `test/tasks.test.js`: "watch hears the task's router events; planGen is 2 after a read-pass handback and a writer pass; no watcher is left after 100 enqueue and settle cycles". Fails today: no `watch`.
- `test/tasks.test.js`: "a job registry at its per-owner limit fails the enqueue with 'Too many background tasks in this chat (10)...'". Fails today: raw engine message.
- `test/workboard.test.js`: "resultIdOf reads the last field: 'jev-3 · a · b · Completed' is jev-3 and resultOf's name is 'a · b'; 'jev-3 · Fix · Running' and 'jev-3 started: Codex' are null". Fails today: `jev-3 · Fix · Running` returns `jev-3`.
- `test/router.test.js`: "routed carries primary {agent, model, effort, level} equal to the following attempt_start effort for auto effort at complexity 0.7, a Settings override and a forced agent; planner and reviewer are named". Fails today: no `primary`.
- `test/router.test.js`: "execute is told {attempt, role} for primary, opinion, retry and review". Fails today: absent.
- `test/router.test.js`: "the history record carries taskKey and intentSample". Fails today: absent.
- `test/speed-routes.test.js`: "POST /jev-router/tasks/seen {results:[{jobId, name}]} acknowledges only a finished task with that name". Fails today: `results` ignored, nothing acknowledged.
- `test/jobs-config.test.js` (new): "config/cordis.patch.yml sets jobs maxConcurrentJobsPerOwner to 32". Fails today: absent.

**Slice 2: start reply and milestone notices.**

- `test/reply-words.test.js` (new module): golden strings for A (routed, forced, unknown model, tool, read-only, reviewer, planner, local first), B, C, both reasoning lines, every credit variant, all four notice kinds, the result head, and the `ABOUT` status sentence. Every notice summary has no `·`, and `resultIdOf` returns null for it.
- `test/adapter.test.js`, each case failing today because enqueue returns a string and the adapter replies with the queued line at once:
  - "with enqueue returning {line, jobId, key, startsNow:true} and watchPlan resolving in 10 ms, the text starts 'OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high)', carries the job, run and agents marks, emits no reasoning chunk, and calls noteAck with gen 1";
  - "watchPlan never resolving with waitMs 100: the reasoning block opens only after 600 ms of silence (manual timers) and reply C follows";
  - "a forced agent replies A without calling watchPlan";
  - "an abort during the wait yields no text and never calls noteAck or stop";
  - "a legacy string from enqueue yields exactly today's line";
  - "alsoWork appends C's sentence without waiting";
  - "the intent call taking over 600 ms opens the 'Jev is reading your message' block";
  - "answerDirectly's messages drop jev-router progress notices and keep result notices; ABOUT carries the live sentence when tasks are live".
- `test/delivery.test.js`: "notify waits for whenIdle, appends one notice with form notice, skips a task that settled meanwhile and the off setting, survives an append that throws, and never changes deliveryState". Fails today: no `notify`.
- `test/delivery.test.js`: "the result head names agent, model, effort and duration". Fails today: absent.
- `test/tasks.test.js`: "startedNoticeDue: null while the reply is pending, null when the reply named gen 1, 'started' when it named none, 'again' after a read-pass hand-back, at gen 2 and at gen 1 alike, 'change' when said differs from the plan; progressPosted survives a restart". Fails today: absent.
- `test/speed-routes.test.js`: "a task whose reply was aborted gets exactly one started notice via the guard timer". Fails today: none posted.
- Added by the slice 2 review, each failing on 5fa174c as `scripts/red-check.mjs` requires:
  - `test/speed-routes.test.js`: "a task queued behind another whose reply B is dropped before it goes out gets exactly one started notice via the guard timer", which also fails on a copy of `index.js` whose `follow()` arms the guard only for a task that starts at once, and on one whose guard notes an ack over one the reply already noted;
  - `test/adapter.test.js`: "the wait's block shows the router's own lines after its choosing line, those heard before it opened first, and a pick within 600 ms shows none of them", and "a task queued after a direct answer says, when it is judged read only, that it runs locked or why it waits like work that writes";
  - `test/laya-integration.test.js`: "while a start reply waits for a pick that takes a moment, its block shows the router's own lines after its choosing line, before the reply names the agent", which fails on a copy of `index.js` whose `watchPlan` tells `onLine` nothing, or of `adapter.js` that drops what it heard;
  - `test/laya-integration.test.js`: "a task Jev reads as needing a person names no agent: its reply says it ended, one that waited gets no started notice, and each result reads Needs input", with `test/tasks.test.js` "a routed event for a run the router stops for a person leaves the task no plan, agent or effort, so no reply or result can name one and no started notice is due";
  - `test/laya-integration.test.js`: "a read task whose agent could not be started locked is told, as it starts again as work that writes, the lock it could not have, not that it needed to change files", with the `test/reply-words.test.js` goldens for each cause and `test/read-pass.test.js` "a hand-back says whether the work itself changes files: ...".
- Added by the third review of slice 2, each failing on 5fa174c as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 2 code before it:
  - `test/laya-integration.test.js`: "a reply stopped in its wait whose work moves to another agent gets its started notice before the moved notice, naming the agent the work started on, and none after it";
  - `test/laya-integration.test.js`: "a task read as needing a person whose routing takes a moment names no agent in its reply's block either: the router's line says no agent runs", with `test/adapter.test.js` "the routed line of a run the router stops for a person names no agent, only who read it so";
  - `test/laya-integration.test.js`: the results of "a task Jev reads as needing a person names no agent: ...", the first sent at a level from the model menu, read `Agent: Jev picks`, with `test/tasks.test.js` "a routed task shows no effort until its working attempt starts at its own, so one stopped before that names none in its result";
  - `test/adapter.test.js`: "a pick that gives the work to a tool names no effort in its credit: the effort is the fallback agent's, which runs only if the tool fails";
  - `test/adapter.test.js`: "reply A names the reviewer and the planner the plan has, and says a local model goes first only when the plan says so", with `test/tasks.test.js` "a routed plan says a local model goes first only when it keeps one in front of the routed resource, which takes over if it fails";
  - `test/adapter.test.js`: "reply C, written once its task has started, carries the run the task began, and so does a reply that it ended", with the run mark read in `test/speed-routes.test.js` "a started notice owed once the reply says what it named is posted then, not at the guard, when the pick lands before the reply is out" and "a task that fails before its pick, while its reply waits for it, ...".

  Those that hold what the slice 2 code already did fail on copies of it with that removed:
  - `test/speed-routes.test.js`: "a task in an idle folder gets reply A naming the agent and model its row shows, ..." now holds the second task a second and a half, so its started notice says `It waited N s for the folder.`, which fails on a copy of `index.js` whose `waitedForOf` returns null or swaps the folder and the slot;
  - `test/laya-integration.test.js`: "reply A's credit says where its effort came from: a pick in the model menu, the default in Settings, or one set for the agent in Settings", "reply A's credit says the routing rules picked when Jev could not, and why" and "reply A's credit says when your feedback moved the pick off another agent", which fail on copies of `index.js` whose `follow()` drops the menu's effort, whose `planned()` reads no effort settings, no `movedOff` or no `reason`, or whose `pickedBy` has no fallback branch.
- Added by the fourth review of slice 2, each failing on 5fa174c as `scripts/red-check.mjs` requires.
  The one of a fix also fails on the slice 2 code before it:
  - `test/tasks.test.js`: "a forced agent that ends before its working attempt starts names no effort in its row or its result, whatever level it was queued at: refused before it was routed, removed from the line, or caught in line by a restart".

  Those that hold what the slice 2 code already did fail on copies of it with that removed:
  - `test/speed-routes.test.js`: "with Start and result only saved, ..." now answers its first task with C, which it reads whole, and fails on a copy of `index.js` whose `enqueue` returns no `progress`;
  - `test/laya-integration.test.js`: "a task's notices go out in the order they were claimed: a started notice slow to post still comes before the moved notice claimed after it", which fails on a copy of `index.js` whose `inTurn` does not wait for the notices claimed before;
  - `test/laya-integration.test.js`: "a retry on the agent the work is already on gets no moved notice", which fails on a copy of `index.js` whose `heard` takes any retry for a move;
  - `test/laya-integration.test.js`: "reply A's credit says the routing rules picked when Jev's routing calls failed and the routing domains filled in without them, as the strip under it does, never Jev and never that no Jev call was made" (so named since the sixth review, below), which fails on a copy of `index.js` that counts only an answered call (`jev`) as a call to the decider;
  - `test/laya-card.test.js`: "Jev setup shows the Chat replies card, whose rows post the wait in whole milliseconds and the progress setting, each as the settings route takes it", which fails on a copy of `client.js` whose Jev setup page leaves the card out, or whose wait row posts its value as a string.
- Added by the fifth review of slice 2, each failing on 5fa174c as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 2 code before it:
  - `test/tasks.test.js`: "a task whose plan keeps a local model in front of the routed resource names that local model from the pick on, as its reply did: in its row, in what a direct answer is told, and in its result, stopped or caught by a restart before its attempt starts";
  - `test/read-lane.test.js`: "a task sent to an agent you picked keeps that agent when its read pass hands it back, as it keeps its own effort: its row names it while it waits and as its pass that writes starts, and a direct answer is told it starts on that agent";
  - `test/reply-words.test.js`: "a task still starting on an agent it was forced to is said to start on that agent, since nobody is choosing it" and "a tool that does the work is named as the start reply names it, in the result's head and in what a direct answer is told, never by the id the task list keeps".

  Those that hold what the slice 2 code already did fail on copies of it with that removed:
  - `test/laya-integration.test.js`: "a pick that lands after the guard's grace but within the reply's wait gets reply A and no started notice: the guard waits out the reply's own wait before its grace", which fails on a copy of `index.js` whose guard waits only the grace, not the reply's wait (`}, guardGraceMs)` in `follow()`);
  - `test/laya-integration.test.js`: "reply A for a forced agent names the effort it starts at and where it came from: a pick in the model menu, the default in Settings, or one set for the agent in Settings, and no effort notice follows", which fails on copies of `index.js` whose `forcedPlanOf` passes no menu effort to `plannedEffort`, passes `config` without the Settings `readEffort` read, or credits `from: 'auto'`;
  - `test/laya-integration.test.js`: "reply A carries the agent strip of the pick it names: who picked, with the model its answers came from, then the worker by its id with its model and effort, for a Jev pick and a Laya pick", which fails on a copy of `index.js` whose `planned()` leaves `routerStep` out of the steps, with `test/adapter.test.js` "reply A carries the agent strip the orchestrator works out for the pick, its router step first, rather than one of its own", which fails on a copy of `adapter.js` that ignores the steps `watchPlan` gives;
  - `test/laya-integration.test.js`: "a message Laya could not sort says why it runs as a task in every start reply: A once Laya picks, B while it waits its turn, and C when the reply does not wait for the pick", which fails on a copy of `index.js` whose `enqueue` leaves `why` out of the facts B and C are written from, or of `adapter.js` whose reply A leaves it out, with `test/adapter.test.js` "a message Laya could not sort says why it runs as a task in the start reply the adapter writes: A once the pick lands, C at the bound, and B or C once a read pass hands it back", which fails on copies of `adapter.js` whose A, whose C at the bound, or whose B or C after a hand-back leaves it out, and the `test/reply-words.test.js` golden "B and C say why a message the decider could not sort runs as a task, after where it stands and before who picks or what they promise", which fails on copies of `reply-words.js` whose B or C leaves it out.
- Added by the sixth review of slice 2, each failing on 5fa174c as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 2 code before it:
  - `test/laya-integration.test.js`: "reply A's credit says the routing rules picked when Jev's routing calls failed and the routing domains filled in without them, as the strip under it does, never Jev and never that no Jev call was made", which expected `Picked by Jev` before and now reads the strip's first step too, with `test/router.test.js` "who decided a routing is one rule for the agent strip's router step and a start reply's credit: the decider when it answered a domain, else the local router, else the routing rules, and never the decider when it was not asked", `test/adapter.test.js` "reply A credits the pick to whoever the orchestrator says made it, and one made on this PC after the decider was asked says it could not pick, never that no call was made", which also fails on a copy of `adapter.js` that does not pass `called` to the credit, and the `test/reply-words.test.js` golden "a pick made on this PC or by the routing rules after the decider was asked says it could not pick, and why when a call failed, never that no call was made";
  - `test/adapter.test.js`: "a start reply written after a read pass handed its task back carries the run the task is on by then: B, where it waits for its folder again, and C, where it starts again at once", with `test/laya-integration.test.js` "a read task handed back before its pick in a free folder is told it starts again as work that writes, naming the run of its pass that writes, which a verdict on the reply is credited to" and "a read task handed back before its pick is told it waits for its folder like work that writes, naming the run of its read pass, which a verdict on the reply is credited to nothing for, and gets one notice when it starts again as work that writes", whose Dislike sent with the run the reply names relabels no routing sample.

  The one that holds what the slice 2 code already did fails on a copy of it with that removed:
  - `test/delivery.test.js`: "a task run with a parallel opinion names its worker with the worker's own model and effort in its row and its result head, never the opinion's agent, model or effort", which emits a parallel opinion as `router.js` does, the opinion's end before the primary's, and fails on a copy of `tasks.js` whose `WORK_ROLES` holds `opinion`.
- Added by the seventh review of slice 2, each failing on 5fa174c as `scripts/red-check.mjs` requires.
  The one of a fix also fails on the slice 2 code before it:
  - `test/laya-card.test.js`: "the Chat replies card says what Milestones post: a notice when a task starts on an agent its reply did not name, at another effort, again as work that writes, or moves to another agent".

  Those that hold what the slice 2 code already did fail on copies of it with that removed.
  Each moved notice test before them had a usage limit for its cause, so no test failed on a copy of `index.js` whose `MOVE_CAUSES` holds `limit` alone; both of these do:
  - `test/laya-integration.test.js`: "a retry Jev's review sends to another agent gets one moved notice whose body says why: the review's line, then the retry's", which also fails on a copy of `index.js` whose `MOVE_CAUSES` leaves out `review`;
  - `test/laya-integration.test.js`: "a retry on another agent after DeepSeek's credit falls under its floor gets one moved notice whose body says why: the balance's line, the limit's, then the retry's", which also fails on one whose `MOVE_CAUSES` leaves out `balance`.
- Added by the eighth review of slice 2, each failing on 5fa174c as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 2 code before it:
  - `test/laya-integration.test.js`: "a retry Jev's review sends to another agent after DeepSeek's credit only ran low gets a moved notice whose body is the review's line, then the retry's: a credit over its floor keeps the work where it is, so it is no reason", which also fails on a copy of `index.js` whose `movesWork` takes a balance in any state;
  - `test/laya-integration.test.js`: "a retry Jev's review sends to another agent after Jev switched its own key in the review gets a moved notice whose body is the review's line, then the retry's: Jev's limit moves no work, so it is no reason", which also fails on a copy whose `movesWork` takes a limit of any agent.

  Those that hold what the slice 2 code already did fail on copies of it with that removed:
  - `test/laya-integration.test.js`: "a retry Jev's review keeps on DeepSeek and then sends to another agent gets one moved notice whose body holds only the review since the attempt before it, then the retry's line", which fails on a copy of `index.js` whose `heard` keeps the causes over the start of a work attempt (`Object.assign(f, { workAgent: e.agent, stepAgent: e.agent })`);
  - `test/laya-integration.test.js`: "a task whose work moves twice in one routing gets one moved notice, for its first move: Jev's review sends DeepSeek's answer to Kimi and Kimi's back to DeepSeek", which fails on a copy of `index.js` whose `moved()` claims no notice (`tasks.claimNotice(f.key, 'moved')`), where the chat gets `jev-1 moved to DeepSeek agent` too.

  Those that hold what the code before slice 2 already did are with the guards of item 4 of "Open, and needing the OWNER" in `docs/handoff.md`:
  - `test/reply-words.test.js`: "a task judged read only that no agent can lock, waiting only for a free slot, is told in B, and in an A that says where it waits, that it runs as work that writes and a task changing its folder waits for it: nothing holds the folder, so it never waits for it", which fails on copies of `reply-words.js` whose `queuedReply` or whose `planReply` takes a wait for a free slot for a wait for the folder;
  - `test/adapter.test.js`: "a task queued after a direct answer says, when it is judged read only, that it runs locked or why it waits like work that writes" now holds one waiting only for a free slot too, and fails on a copy of `adapter.js` whose `alsoWork` sentence does the same.

  The seventh review's `MOVE_CAUSES` is now `movesWork`, and its two tests fail on copies of `index.js` whose `movesWork` leaves out a review, or a balance under its floor.

**Slice 3: learning clock in shadow.**

- `test/domains.test.js`:
  - "a domain with localLabels ['task'] at LOCAL_ONLY asks the teacher for a trusted local 'question' and reports authority jev; a trusted local 'task' decides without the teacher". Fails today: any trusted label decides.
  - "requiredClasses blocks GUARDED_LOCAL until each class has perClassSamples verified rows". Fails today: no such gate.
- `test/policy.test.js`: "DOMAINS.intent is LOW with localLabels ['task'] and requiredClasses ['task','question']; every other domain is unchanged". Fails today: absent.
- `test/features.test.js` (new, named for the existing features.js): "intentFeatures has no workspace fields and matches taskTextFeatures' text part". Fails today: missing export.
- `test/intent.test.js` (new module intent.js):
  - "under Jev Auto one sample is recorded with Jev's kind as the teacher label and its id returned";
  - "at LOCAL_ONLY a confident local 'task' makes no jev.intent call and returns {kind:'task', decidedBy:'local', readOnly:null}";
  - "a local 'question' still asks Jev";
  - "offline and Laya Auto record nothing".
- `test/training.test.js`: "labelIntent: accepted run with changes is task verified; answer capability with no changes is question verified with negative task; plan tag gives human question; liked direct answer gives human question; 'should have been a task' gives human task; steered or amended gives null". Fails today: no intent case.
- `test/reply-ledger.test.js` (new module):
  - rows hold no text;
  - scoring at routed;
  - separate windows per decider;
  - `quickGate` false at 44 of 50 and true at 45; `likelyGate` false at 15 of 20 and true at 16;
  - the predictor trained on 200 synthetic rows predicts the majority label per feature pattern;
  - masking drops an unavailable agent and marks the answer untrusted when the unmasked top differs.
- `test/laya-card.test.js`-style client test: "the How Jev replies card renders the gate figures from a stubbed /replies/summary". Fails today: helper missing (asserted).
- As built, "offline and Laya Auto record nothing" needs the plugin's own `classify`, so it is in `test/laya-integration.test.js`, as "no intent sample is recorded where Jev teaches nothing: Jev Auto offline or with no network, Laya Auto, and learning or adaptive routing off; there an answer carries no mark, and with learning off no reply is kept either".
  The code before the slice recorded no sample anywhere, so red-check sees it fail at `dbdec3d` only because it reads the summary route that code did not have, first for the plugin with adaptive routing off, so its part with learning off never runs there; it is with the guards of item 4 of "Open, and needing the OWNER" in `docs/handoff.md`, each of its promises failing on a copy of `index.js` without it.
  `test/intent.test.js` has "without an intent domain the message is sorted as it always was, and nothing is recorded" in its place (slice 3 build).
- Added in the slice 3 build besides, each failing on `dbdec3d`:
  - `test/policy.test.js`: "no policy lets the intent classifier decide a question, or drop task or question from the classes its local rungs wait for";
  - `test/reply-ledger.test.js`: the background retrain after every 25 new labelled rows once there are 60, one at a time; the retrain in a worker thread, as `trainInWorker` called directly runs it (that the ledger's own retrains run there is held by a test the third review of slice 3 added); the file rewritten to one task per line, a truncated last line skipped; and the summary;
  - `test/reply-words.test.js`: "a direct answer's hidden mark names the intent sample its message was recorded as, and nothing that is no id";
  - `test/adapter.test.js`: "a message's intent sample rides its queued task and its run, and a question answered directly ends with its mark after the credit";
  - `test/laya-integration.test.js`: "under Jev Auto each message is one intent sample with Jev's answer as the teacher's, still one Jev call a message: ...", and "the reply ledger keeps what a Jev Auto start reply named and what the router then ran, with no words of the task, and GET /jev-router/replies/summary shows it";
  - `test/routerview.test.js`: "the Router tab lists the message intent, whose local router decides only that a message is a task, at the rungs where it decides at all".
- Added by the slice 3 review, each failing on `dbdec3d` as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 3 code before it:
  - `test/laya-integration.test.js`: "the reply ledger keeps a pick that gives the work to a tool as the tool its start reply named, as what ran names it, never the agent that takes over only if the tool fails";
  - `test/laya-card.test.js`: "with learning off the How Jev replies card says nothing here learns: ...", and "the How Jev replies card says the guess at the agent changes no reply yet, and task or question changes one only once it is read on this PC, ...";
  - `test/reply-ledger.test.js`: "a file the ledger could not read is never rewritten, ...", and "a rewrite that fails, as the rename does while a reader holds the file on Windows, is tried again once another slack of lines is appended, not on every write".

  Those that hold what the slice 3 code already did fail on copies of it with that removed:
  - `test/laya-integration.test.js`: "the reply ledger keeps how each start reply came to name what it named: ...", which fails on copies of `index.js` whose `enqueue` notes `forced: false`, whose `noteSaid` has no `forced` branch, or whose `noteSaid` takes a reply that named no plan for one that waited for routing;
  - `test/intent.test.js`: "whatever a domain lets its local classifier decide, a local decision is a task: the second lock behind the domain's own", which fails on a copy of `intent.js` whose local decision takes the domain's label.
- Added by the second review of slice 3, each failing on `dbdec3d` as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 3 code before it:
  - `test/laya-integration.test.js`: "where no task can run, in No project and the scratch workspace, Jev reads every message on a Jev row, so a question the local classifier is sure is a task is answered there, not refused; in a project folder that classifier decides", which seeds the intent domain at LOCAL_ONLY with a classifier sure a question is a task, and also fails on copies of `index.js` whose `classify` passes no `localMayDecide` or whose `tasksRunIn` leaves out No project or the scratch workspace, of `adapter.js` that tells `classify` no folder, and of `intent.js` that hands `decide()` no `localMayDecide`; with `test/intent.test.js` "where no task can run the local classifier decides nothing: ..." and `test/adapter.test.js` "the intent call is told the folder the message was sent in, ...";
  - `test/laya-card.test.js`: "with adaptive routing off the How Jev replies card opens by saying only the guess at the agent learns, ...", with "no intent sample is recorded where Jev teaches nothing: ..." in `test/laya-integration.test.js` now reading the summary of the plugin with adaptive routing off (`learning: true`, `intent: null`);
  - `test/reply-ledger.test.js`: "a predictor the disk refuses to save, as a rename over reply-model.json is refused while a reader holds it on Windows, is used all the same: ...", which swaps `renameSync` in `node:fs`, and also fails on a copy of `reply-ledger.js` that keeps the predictor but saves it once with no retry;
  - `test/laya-integration.test.js`: "a start reply whose wait for the pick runs out is kept as such and timed with the replies that named the pick, ...", which also fails on copies of `adapter.js` whose C at the bound notes no `bound`, of `index.js` whose `noteSaid` ignores it or whose summary carries no `waitMs`, and of `reply-ledger.js` that times `routed` rows only; with `test/reply-ledger.test.js` "a reply whose wait for the pick ran out is timed with the replies that named the pick, ...", `test/laya-card.test.js` "the How Jev replies card times the start replies whose wait for the pick ran out with those that named it, ..." and `test/adapter.test.js` "reply C notes that its wait for the pick ran out when it did, and no other reply does: ...";
  - `test/laya-card.test.js`: "at a rung where task or question is read on this PC, the How Jev replies card gives its recent accuracy without the bar it climbed past, ...";
  - `test/laya-integration.test.js`: "Jev's routing samples are read as the plugin starts, in the background, so the first message on a Jev row, ...", which counts the reads of `routing-samples.jsonl` through a swapped `readFile`.

  Those that hold what the slice 3 code already did fail on copies of it with that removed:
  - `test/laya-integration.test.js`: "a trained reply predictor guesses as a task is queued, from the agents routing could pick then, and the guess is scored once routing picks: ...", which saves a predictor in the data folder before the plugin starts, and fails on copies of `index.js` whose `noteQueued` records `predicted` as null or hands the predictor an empty list of available agents, whose `noteRan` drops `level`, or whose ledger is given `replyGates({})` in place of `config.replies`;
  - "the reply ledger keeps what a Jev Auto start reply named ..." in `test/laya-integration.test.js` now reads `ran.level` too, and fails on the copy whose `noteRan` drops it.

  Changed on purpose: `test/adapter.test.js` "watchPlan never resolving with waitMs 100: ..." (slice 2) now expects each C at the bound to note `bound: true`; `test/laya-card.test.js` "the How Jev replies card renders the gate figures from a stubbed /replies/summary" expects `none timed this week` where it had `none waited for a pick this week`, and it and "the How Jev replies card says the guess at the agent changes no reply yet, ..." expect no `(needs 94%)` at GUARDED_LOCAL; `test/reply-ledger.test.js` "the summary: ..." expects `atBound: 0` in `startReplies`.
- Added by the third review of slice 3, each failing on `dbdec3d` as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 3 code before it:
  - `test/laya-card.test.js`: "the How Jev replies card never rounds the recent accuracy of task or question up to a bar it misses: ...", which reads 211 right of the last 225 at SHADOW, where the slice 3 code read `94% right of the last 225 checked (needs 94%)`, and the shares beside a bar a policy sets at 94.5%;
  - `test/laya-integration.test.js`: "the summary tells a reply whose task ended before routing picked anything from one whose task is still to be routed: ...", which stops a task as it waits its turn and clears it from the task list, and has Jev read another as needing a person once its reply's wait ran out, and also fails on a copy of `index.js` whose summary takes a task gone from the list for one still to run; with `test/laya-card.test.js` "the How Jev replies card says nothing ran for a reply whose task ended before routing picked anything, ...";
  - `test/reply-ledger.test.js`: "a start whose ledger has rows enough and no predictor trained through them, as after reply-model.json was deleted, trains one as it reads the ledger, ...", with `test/laya-card.test.js` "the How Jev replies card says a prediction not trained yet is training while its first training runs, ..." and `test/laya-integration.test.js` "with learning off the plugin trains no predictor of the pick from the ledger the card still reads, ...", which also fails on copies of `index.js` that gives the ledger no `learns` and of `reply-ledger.js` whose retrain ignores it.

  Those that hold what the slice 3 code already did fail on copies of it with that removed:
  - `test/laya-integration.test.js`: "the reply ledger keeps the pool each task was picked from: ...", which sends a task at Extra High with a screenshot on Jev Auto, one on Jev Auto Online and one on Laya Auto, with Claude switched on but signed out, one tool switched on and one off, and fails on copies of `index.js` whose `noteQueued` drops `modalities`, takes the mode, the effort or the decider for `auto`, `auto` and `jev`, keeps an agent that is not ready, leaves out the tools, or keeps a tool switched off;
  - `test/reply-ledger.test.js`: "a ledger given no way to train, as the plugin's is, retrains in a worker thread, and dispose ends a retrain under way: ...", which counts the workers through a swapped `worker_threads.Worker`, and fails on copies of `reply-ledger.js` whose default `train` trains in place or whose `dispose()` does nothing; with `test/laya-integration.test.js` "the plugin's reply ledger retrains in a worker thread, and closing the plugin ends a retrain under way: ...", which holds the worker's end until the plugin is closed, and also fails on a copy of `index.js` that does not dispose of the ledger as the plugin closes;
  - `test/reply-ledger.test.js`: "the predictor learns from the newest 500 labelled rows, the oldest four fifths fitted and the newest fifth calibrated, in the order they came, and never balanced, ...", which fails on copies of `reply-ledger.js` that read more than 500 rows, balance the classes, fit or calibrate on every row, or shuffle them; with its check of the balancing flag left out, it still fails on the balanced copy, whose guess for a failing test is 0.516 sure where four times in five makes it over 0.8;
  - `test/laya-integration.test.js`: "a message's intent sample says whether a picture came with it, ...", which fails on a copy of `index.js` whose `classify` hands `classifyIntent` no `modalities`, and with `test/intent.test.js` "a sample says whether a picture came with the message, ..." on a copy of `intent.js` that hands `intentFeatures` none;
  - `test/reply-ledger.test.js`: "the summary's Recent replies are its newest ten replies, newest first, ...", which fails on copies of `reply-ledger.js` that keep 9, 11 or 1000, or cut before leaving out the tasks with no reply yet.

  Changed on purpose: `test/reply-ledger.test.js` "a predictor the disk refuses to save, ..." expects the start after it to train on the sixty it reads, as it reads them, where it trained on sixty-one once the next task was routed for.
- Added by the fourth review of slice 3, each failing on `dbdec3d` as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 3 code before it:
  - `test/laya-card.test.js`: "the How Jev replies card never says no guess has been checked beside a record of Laya's: ...", which reads a predictor trained on Laya Auto's picks alone;
  - `test/laya-integration.test.js`: "a start reply that goes out at once beside a task that starts at once is kept as going out at once, never as one that waited: ...", which also fails on copies of `adapter.js` whose C with no wait or whose `alsoWork` sentence notes no `now`, and of `index.js` whose `noteSaid` ignores it; with `test/laya-card.test.js` "the How Jev replies card says a start reply that went out at once beside a task that starts at once went out at once, ...";
  - `test/laya-integration.test.js`: "the reply ledger reads a task sent with a picture by the person's own words, ...", which also fails on copies of `index.js` whose `noteQueued` reads the task and of `adapter.js` that hands `enqueue` no `message`; with `test/adapter.test.js` "the person's own words ride beside each task the adapter queues, ...", which also fails on a copy of `adapter.js` whose `alsoWork` enqueue hands none;
  - `test/reply-ledger.test.js`: "a ledger disposed of, as the plugin closing or applied again leaves it, starts no retrain after, ...".

  Those that hold what the slice 3 code already did fail on copies of it with that removed:
  - `test/laya-integration.test.js`: "the summary gives the How Jev replies card the message intent's figures as the domain's last evaluation counted them: ...", which seeds Jev's store with forty checked examples and a classifier trained through the tenth, and fails on copies of `index.js` whose summary gives `verified: 0`, `classes: {}`, `ev.classes` for `ev.classes.counts`, `recent: null` or the whole of `recent`; "the reply ledger keeps what a Jev Auto start reply named ..." now reads the checked examples and those of each class after a run, and fails on the first three of those copies;
  - `test/reply-ledger.test.js`: "a predictor trained through a task the ledger no longer holds, as after reply-ledger.jsonl alone was deleted, ...", which fails on a copy of `reply-ledger.js` whose retrain waits for that task (`if (through && (at < 0 || list.length - at - 1 < retrainEvery)) return`);
  - `test/laya-integration.test.js`: "after a restart hands out a job id again, the summary reads each reply's task by its key: ...", which fails on a copy of `index.js` whose summary looks a task up by job id (`endedOf(tasks.get(r.jobId)?.key ?? null)`);
  - `test/training.test.js`: "labelIntent: ..." now holds a run routed as project work that failed or was handed to a person, and fails on a copy of `training.js` that labels such a run only when it was accepted (`accepted(record) &&`);
  - `test/laya-integration.test.js`: "a trained reply predictor guesses only among the agents routing could pick as the task is queued: ...", which fails on a copy of `index.js` whose `noteQueued` hands the predictor no list of agents (`ledger.predict(features)`), and "a replies gate whose right is above its of stops the plugin at start-up with the key's name, ...", which fails on a copy whose `apply()` falls back to the gates that ship.

  Changed on purpose: `test/laya-integration.test.js` "a start reply whose wait for the pick runs out is kept as such ..." expects the reply written with the wait set to none as `now`, where it expected `waited`; in `test/adapter.test.js`, "reply C notes that its wait for the pick ran out when it did, ..." and "alsoWork appends C's sentence without waiting" (slice 2) expect such a reply to note `now`, and "a Laya Auto message is sorted by Laya and read against Laya's bars, ..." and "a Laya Auto task is routed and queued as Laya's, ..." (both from before the slice) and "a message's intent sample rides its queued task and its run, ..." expect `message` among what the adapter hands `enqueue`, as `test/layaauto.test.js` "while Laya starts the message waits with the Starting line, ..." (from before the slice) does.
- Added by the fifth review of slice 3, each failing on `dbdec3d` as `scripts/red-check.mjs` requires.
  Those of a fix also fail on the slice 3 code before it:
  - `test/laya-integration.test.js`: "a start reply that goes out once its task has ended is kept all the same: ...", which has Jev read a task as needing a person within the wait for the pick as it ships, and holds reply A for a signed-out Claude until its task has failed, and also fails on a copy of `index.js` that keeps such a reply but reads reply A's plan from the task's follow, which keeps it as `routed`;
  - `test/reply-ledger.test.js`: "a ledger disposed of, as the plugin applied again leaves it, rewrites the file no more: ...", "a rewrite keeps what another ledger appended to the file since this one read it, ..." and "a line another ledger appends while this one rewrites the file goes to the file the rewrite leaves, ...", each also failing on a copy of `reply-ledger.js` without what it holds: the `disposed` check, the read before a rewrite, or the one line of work per file for appends.

  Those that hold what the slice 3 code already did fail on copies of it with that removed:
  - `test/laya-integration.test.js`: "the reply ledger keeps what a Jev Auto start reply named ..." now reads the effort and the model the reply named and those that ran, in the row and in the summary, and fails on copies of `index.js` whose `noteSaid` keeps no effort or model for a pick the reply waited for, or whose `noteRan` keeps none for what ran;
  - `test/laya-integration.test.js`: "the reply ledger keeps the pool each task was picked from: ..." now reads each row's decider too, and fails on a copy of `index.js` whose `noteQueued` keeps every row as Jev's, where only the decider the features are given was read;
  - `test/laya-integration.test.js`: "the summary gives the How Jev replies card the bars task or question is held to by the routing policy in force, ...", which starts the plugin with LOW gates of its own, and fails on a copy of `index.js` whose summary gives the bars that ship.

**Slice 4: live view for the router and spawn agents.**

- `test/live.test.js` (new module):
  - spawn frames plus committed events project to reasoning, text and tool items;
  - backfill overlap deduplicated by seq;
  - `read(after)` returns only changed items, and `v` is monotonic;
  - 3000 events leave at most `maxItems` plus one marker;
  - a 2 MiB output keeps head and tail;
  - live runs are never evicted; finished runs are evicted least recently used;
  - `sk-ant-...` is redacted;
  - malformed input raises `dropped` and never throws;
  - deep-frozen input projects without mutation;
  - `activityOf` with an injected clock gives the exact phrases, the 61 s command words and the 91 s silence words;
  - persist and load round-trip, with a truncated last line skipped.
- `test/live-routes.test.js` (new; fails today because `/live` is 404 and `activity` is absent):
  - "a spawn fake with localAgent.ctx.on and session.snapshotEvents: GET /jev-router/live?task=<key> returns its items across a read pass and the writer pass after it";
  - "the recorded call order shows the last snapshot read before dispose()";
  - "a ctx.on that throws still yields items from the pump";
  - "500 live events leave tasks.jsonl byte-identical after tasks.flushed()";
  - "GET /tasks shows activity for a live task";
  - "Clear deletes dataDir/live/<key>.jsonl".
- `test/liveview.test.js` (new, stand-in React):
  - LivePane polls with `after=<v>`, merges, stops on a terminal state and on `document.hidden`, and turns Follow off on scroll;
  - WorkBoard renders the activity line under a live row;
  - the Tasks row shows the live tail while running and the report once finished;
  - LiveRunCard renders only for a message with a `[jev-job]` mark and shows `Starting Claude Code...` before the first item.

**Slice 5: engine patch for Claude Code and Codex.**

- `test/patch-agent-live.test.js` (new, for scripts/patch-agent-live.mjs), against the vendored pinned files:
  - every `to` present, and a second run byte-identical and `applied`;
  - CRLF copies stay CRLF;
  - a version mismatch writes nothing and the status file names both versions;
  - a missing or duplicated anchor leaves that file untouched while the other package still patches;
  - the backup is refreshed from an unmarked file;
  - a file marked with another version is re-patched from a same-version backup, and refused without one;
  - `patch-codex-effort.mjs` run before or after: turn/start holds `threadId`, then the env lines, then `...this.kzhTurnExtras`, then `input`;
  - `node --check` passes on both outputs;
  - run as a child process with `DSH_HOME` pointing to a temp profile: stdout only, empty stderr, exit 0 on every path, including a thrown error;
  - the main guard holds when reached through a symlinked folder.
- `test/patch-agent-live.test.js`, functional, the patched vendored connectors on stubs:
  - Claude: the tap sees every message of its own run only, and two concurrent runs are isolated; `includePartialMessages` only when tapped; with no kzh fields the prompt is the same string and the options are deep-equal to unpatched; a throwing tap leaves the result unchanged;
  - Codex: two concurrent runs each tap only their own frames, `kzh/thread-start-response` included; the result is unchanged; `kzhTurnExtras` equals the env at `start()` even after the env changes;
  - Claude channel (`control.channel` true): the first message equals the SDK's string write; it ends at the first result when nothing is pending; a steer uuid in the same result's `user_message_uuids` is delivered and the channel ends; an unfolded steer keeps it open until the next result; a result without uuids gives `unknown` and ends; the 30 s timer ends it (fake timers); sendNow skips the aborted result and returns the next; a failed second result keeps the first answer; two successes are joined with `---`;
  - Codex helpers: steer rejects `kzh-no-turn` without a turn, otherwise sends `turn/steer` with `expectedTurnId` and `clientUserMessageId`; sendNow interrupts and continues on the same thread with the snapshot effort; stale old-turn notifications are ignored; a turn completed first leaves `kzhNext` pending.
- `test/engine-patches.test.js` (new module): marker detection per package; reason from the status file; 60 s cache; read errors mean off.
- `test/live.test.js`: Claude fixture stream (init, stream events, assistant, tool_result with structuredPatch, tool_progress, thinking_tokens, api_retry, result with modelUsage) and Codex fixture (thread-start-response, commandExecution with three output deltas and exit 1, fileChange `changes` on `item/completed`, `turn/diff/updated`, reasoning summary, `agentMessage` delta, plan, token usage) project to the expected items; `usageOf` normalizes Codex cached input. Fails today: missing export (namespace import).
- `test/live-routes.test.js`:
  - with a fake marker file, `start()` receives `kzhTap` and `kzhControl` for `claude-code`, `claude-code-readonly` and `codex`, and neither without it;
  - tapped usage is returned when `r.usage` is absent, and the usage.jsonl row carries tokens and `apiEquivalentUsd`;
  - the attempt records `servedModel` and leaves `modelVersion` unset.
- `test/app-main.test.js`: "Start-KzH.ps1 runs patch-agent-live.mjs after patch-codex-effort.mjs and before 'Starting the engine.'". Fails today: line absent.

**Slice 6: rate the pick.**

- `test/feedback.test.js`: accepts `about: 'plan'` with `taskKey`, `suggestedEffort: 'xhigh'` and `wrong effort`; rejects plan tags on answers, `about: 'x'`, `suggestedEffort: 'ultra'` and a bad `taskKey`; accepts `should have been a task` on answers; a clear still stores only its keys. Fails today: fields dropped or tag refused.
- `test/plan-verdict.test.js` (new; fails today because the relabel never happens or lands on the wrong run):
  - "a plan verdict records no capability evidence (recordMany and retract never called)";
  - "given while the run is going it reports 'Saved. It is applied when jev-4 ends.' and relabels nothing; bindRun at run end relabels task_classification as human negative; a second bindRun changes nothing";
  - "binding follows taskKey, not jobId: a pre-restart verdict for jev-3 never touches the new jev-3's run";
  - "a Laya-decided run is relabelled in layaStore only";
  - "'should have been a question' labels the run's intent sample human question";
  - "'wrong agent' with Codex labels resource_selection human and sets the session suggestion";
  - "effects words match what changed".
- `test/router.test.js`: `feedbackPrior` counts a plan `wrong agent` dislike against claude; `wrong effort` and `should have been a question` count nothing but their text reaches `reasons`; a `nudged` shift is named in `routed`. Fails today: all tags vote.
- `test/effort.test.js`: `effortBias` is +1 after 3 of 4 agreeing rows, 0 for mixed, 0 before `resetAt`; `toAgentEffort('auto', codex, { complexity: 0.5, shift: +1 })` gives xhigh where unshifted gives high, never beyond xhigh, and ignores shift for an explicit level or an override. Fails today: missing export.
- `test/training.test.js`: `feedbackFor` matches by `taskKey` and never by time for a plan row; `labelResourceSelection` returns a human label from a plan verdict's `suggestedAgent`.
- `test/profiles.test.js`: `verdictIsAbout` is false for a plan row.
- `test/answerverdict.test.js`:
  - a `[jev-job]` message shows plan tags, and the effort select only with `wrong effort`;
  - the POST body has `about`, `taskKey`, `runId` and `suggestedEffort`;
  - the `Learned` line renders the server's effects;
  - the ask appears only when `said` and `ran` differ and nothing is rated, one per session, gone after two typed messages or on `Don't ask me this`;
  - a message without the mark keeps today's tags and body.

**Slice 7: queue controls for waiting work.**

- `test/tasks.test.js` (fails today: `admit`, `startNow`, `amend` and `controls` are absent):
  - `lanes.admit` starts a cap-waiter at once, and `slots()` shows held 2 with `overCap`;
  - after both release, only one next waiter starts;
  - a held lane answers `busy` and nothing moves;
  - an unknown id answers `not-waiting`;
  - skipped waiters in the same workspace are retold `workspace`;
  - `startNow` returns every status, including `not-waiting` right after the lane admits;
  - `amend` appends text that the next pass's `route()` receives, answers `started` right after the lane admits, and saves `steers`;
  - `view().controls.sendNow` follows the wait reason.
- `test/read-lane.test.js`: `startNow` on a read-only task runs it beside a writer with a cap of 1; a second writer is never admitted to a held workspace; an amended read-only task handed back keeps its amended text.
- `test/steer-routes.test.js` (new; fails today because the routes are 404):
  - `POST /tasks/start-now`;
  - `POST /tasks/steer` with `how: 'amend'`;
  - `how: 'follow-up'` enqueues a forced task first in line;
  - the job-limit error returns the readable words.
- `test/workboard.test.js` and `test/tasklist.test.js`: the button set per state; Send now dialog words from `slotFacts` for cap, line and read-only, plus the local-model warning; the busy dialog for workspace and chat; the dialog closes with the drift sentence when the task starts; the refusal words.
- `test/observability.test.js`: TaskQueue `Send now` renders only while running and calls `updateQueue(id, { kind: 'steer' })`.
- `test/adapter.test.js`: `@jev-5 do X` on a queued task calls `orchestrator.steer` with `amend`, replies `jev-5 hasn't started, so I added this to its task.`, and never calls `classify`.

**Slice 8: steer running work.**

- `test/steer.test.js` (new module): provider delivery choice (spawn live, Codex patched live, Claude off, tool none); state transitions; words for each state and provider.
- `test/live-routes.test.js`:
  - spawn: steer calls `localAgent.steer` with the prefixed text and `role: 'user'`; `inbox/claimed` gives `delivered`; a result that settles first gives `returned` and the head says `not used`;
  - Codex fake: resolved `control.steer` plus a tapped `userMessage` with that `clientId` gives `delivered`; a rejection gives `carried` when another attempt follows;
  - Claude with the toggle off: `control.steer` is never called.
- `test/router.test.js`: `withGuidance` appears in retry, plan and review prompts (a fake execute captures prompts); undelivered items become `carried`; `record.steered` counts them. Fails today: missing export or prompts unchanged.
- `test/profiles.test.js`: a steered run gives no `first_pass_quality` or `instruction_following` rows.
- `test/training.test.js`: `labelClassification` and `labelIntent` return null for a steered or amended record.
- `test/delivery.test.js`: guidance lines in the result head.
- `test/steer-routes.test.js`: `how: 'restart'` stops the task and enqueues the continuation text, forced to the same agent and first in line.
- `test/adapter.test.js`: `@jev-4 text` on a running Codex task replies `Sent to jev-4: Codex takes it in at its next step.`

**Slice 9: quick and instant replies switch on.**

- `test/adapter.test.js` (fails today: the reply always waits for `routed`):
  - with a seeded ledger at 47 of 50 and a confident available prediction, the reply comes before `routed` with the quick credit;
  - with local intent `task` as well, `jev.intent` is never called and no reasoning chunk is emitted;
  - at 44 of 50 it waits;
  - an unavailable predicted agent waits;
  - Laya Auto never uses local intent;
  - `routed` within 600 ms replaces the prediction with the real plan.
- `test/reply-ledger.test.js`: a change of plan after a predicted reply counts as a miss; the paused wording at 43 of 50.
- `test/speed-routes.test.js`: a predicted reply whose route differs posts exactly one change-of-plan notice.

**Slice 10: Send now into running agents, and experimental Claude steering.**

- `test/steer.test.js`: spawn Send now removes our unclaimed steer, then `cancel({kind:'parent'},{keepInbox:true})`, then `followup`, in that order; Codex Send now calls `control.sendNow`, and a pending `kzhNext` at attempt end becomes `returned`. Fails today: missing export.
- `test/live-routes.test.js`: toggle on passes `kzhControl.channel === true` to Claude starts and toggle off does not; `thinkingDisplay('summarized')` is called only when that setting is chosen.
- `test/liveview.test.js`: the running dialog shows `Send now` only where an interrupt path exists, with the disabled reason otherwise; a replaced turn reads `Replaced by your message`.

---

## 4. Slices in order, with done-when

Every slice must pass the full `npm test` in `plugins/jev-router` and a red-check against the previous slice's commit.

1. **Groundwork and hazard fixes.** Covers: task key; hardened `delivered()` and `/tasks/seen` name check; last-field `resultIdOf`; `plannedEffort` and `routed.primary`; `agentsMark`; watch, plan and planGen; attempt and role to execute; `taskKey` on records; job-limit config and words.
   Done when: on the owner's PC a background task behaves as before apart from `key` and `plan` in `tasks.jsonl`, and a result posts exactly once after an app restart that reused its job id.
2. **Start reply and milestone notices.**
   Done when, on the PC:
   - a task in an idle folder gets `OK, I'll run ...` naming the agent, model and effort the Tasks row later shows;
   - a forced agent replies in about a second;
   - a queued task gets B and then one `started` notice;
   - a slow pick gets C and then one notice;
   - no result is ever marked read before it posts (the work board's `Unread result` clears only after the result notice appears).
3. **Learning clock in shadow.** Covers: intent domain with `localLabels` and `requiredClasses`; `classify` through `intent.js` (Jev still decides at JEV_PRIMARY); intent labels; ledger and predictor in shadow; `How Jev replies` card.
   Done when: after a day of use the Router tab shows intent samples, the card shows a scored record, usage.jsonl shows no extra decider calls per message, and routing results are unchanged (existing router tests untouched).
4. **Live view for the router and spawn agents** (no engine patch). Covers: `live.js`; agent-scoped listeners, pump and drain; `/live`; `activity`; Live tab, LiveRunCard, work board line, Tasks tail; saved transcripts.
   Done when, on the PC:
   - a DeepSeek task and a local-model task stream text, tool calls and (DeepSeek) reasoning in the Live tab and in the card under the reply, with `N s ago` ticking;
   - a Claude Code task shows router steps and the honest `live detail is off` note;
   - `tasks.jsonl` write frequency is unchanged.
5. **Engine patch for Claude Code and Codex.** Covers: all engine hooks, inert beyond the tap; gating; Claude and Codex projectors; tapped usage; Jev setup card; launcher line.
   Done when, on the PC:
   - Start-KzH prints `patch-agent-live: live view and steering hooks added to Claude Code and Codex` once, and nothing on the next start;
   - one Claude Code run and one Codex run each show text, tool calls, command output and file edits live, and their usage.jsonl rows carry tokens;
   - `docs/handoff.md` records whether thinking text and reasoning summaries appeared;
   - restoring `.kzh-backup` turns the card to off and runs still work.
6. **Rate the pick.** Covers: plan verdicts, binding, effects, effort bias, the ask, `should have been a task`.
   Done when, on the PC:
   - a dislike on a reply while its task runs says `Saved. It is applied when jev-N ends.`, and at run end the Router tab shows the human label;
   - three `wrong effort, should have been xhigh` ratings on Codex make the next auto Codex reply say xhigh, and Reset restores it;
   - the ask appears once after a real change of plan.
7. **Queue controls for waiting work.**
   Done when, on the PC with Tasks at once set to 1:
   - Send now on a task waiting for a slot starts it with the over-cap sentence;
   - a task behind a writer offers only `Put first in line` and `Stop and start this`;
   - an amended waiting task runs with the added text (Live tab first prompt line and history record);
   - TaskQueue `Send now` works while a Jev turn waits.
8. **Steer running work** (spawn live, Codex `turn/steer`, carried and returned, follow-up, restart).
   Done when, on the PC:
   - a DeepSeek run and a Codex run each show `Read by ... at hh:mm` for a mid-run instruction, and their next step follows it;
   - guidance sent during checks appears in the review prompt;
   - guidance sent after the last step is reported `not used` in the result.
9. **Quick and instant replies switch on when earned.**
   Done when: nothing quick happens on the PC until the card's figures say so; after that a familiar task gets its reply before routing (quick), or with no Jev call in usage.jsonl (instant); a forced mismatch produces the change-of-plan notice and the ask.
10. **Send now into running agents, and experimental Claude steering.**
    Done when, on the PC:
    - Send now on a running DeepSeek task and a running Codex task continues with the new instruction on the same agent (Codex on the same thread, at its original effort);
    - the owner runs one Claude Code task with the toggle on and records in README whether steers were folded mid-turn, ran as a second turn, or came back `unknown`.
    
    The toggle stays off by default unless that run shows reliable folding.

---

## 5. Risks, and what only the owner's Windows PC can verify

### 5.1 Risks

- **Engine drift.** An engine bump (`Update-Harness -BumpDsh`) makes the patch refuse; live detail, steering and Send now for Claude Code and Codex switch off, and the UI says why. Runs are unaffected.
- **IPC volume.** Claude partial messages raise stdout traffic. Projection keeps chunk arrays, and the browser polls at 700 ms. Check CPU on one long run.
- **Memory and disk.** In memory: 40 finished runs of up to 768 KiB each (about 30 MiB worst case). On disk: 100 tasks at 256 KiB each. Tool output can hold secrets; it is redacted, kept local and deleted with its task.
- **Notices in chat history.** Notices are surface events. `answerDirectly` strips them for Jev rows, but a non-Jev chat model picked later still sees them.
  At most two short notices per routing: one that the task started, started on another plan than its reply named, or started again as work that writes, and one that its work moved (slice 2 review).
  So a task gets at most two besides its result, and a read task whose read pass is handed back after its pick at most four, two for each pass (slice 2 review).
- **The bounded wait keeps the chat turn busy for up to 15 s.** `waitMs = 0` restores an immediate reply.
- **Intent label skew and slow maturity.** The LOW gates need 750 verified samples plus 100 per class. `requiredClasses` stops one-class promotion, and a trusted local answer can only say `task` (the cost of a wrong one is one agent run). Quick replies can arrive in weeks; instant ones may take months. The card shows progress honestly.
- **Predictor drift** when agents are switched or hit limits. Masking, top-class agreement and the live 45-of-50 record switch quick replies off by themselves.
- **Send now over the cap** works against the RAM and VRAM budget, and local agents are not serialized against each other. The dialog warns every time.
- **"Stop the holder"** discards the holder's remaining work. It sits behind a second confirmation.
- **The Codex continuation is a small state machine inside the connector.** Stale-turn filtering and tests on the vendored file cover it; the live check is in 5.2.
- **The Claude input channel could hang** if its close rules missed a case. The 30 s timer and the agent's own time limit bound it, and it is off by default.
- **The effort bias is a learned change in behaviour.** It is bounded (plus or minus one step, auto only, at least 3 agreeing ratings), visible and resettable.
- **Raising the job limit to 32** lets more waiting tasks queue per chat. The Tasks-at-once cap still bounds running work.
- **UI verification.** `client.js` changes are seen only through the stand-in React until the app is started (`docs/handoff.md` already notes this).

### 5.2 Owner-PC checks (cannot be proven here)

1. After Start-KzH: the patch line prints once; both connector files carry the marker; `kzh-engine-patches.json` reads applied; an unpatched copy (backup restored) still runs tasks.
2. One Claude Code run:
   - partial messages stream;
   - whether thinking text shows or only `Thinking... (about N tokens)` (the CLI's default display is unverified; if nothing shows, set `Claude Code thinking: Summarized` and confirm `setMaxThinkingTokens(null, 'summarized')` is accepted);
   - Bash output and Edit diffs;
   - the usage row.
3. One Codex run: reasoning summaries under the owner's `~/.codex/config.toml`; command output arrives as text; `fileChange` diffs and `turn/diff/updated`; the plan; token usage.
4. One DeepSeek and one local run: deltas arrive through the agent-scoped listener in the real cordis, not only through the pump; local reasoning is absent while `thinking` is off.
5. Rendering and focus: work board line, LiveRunCard under the start reply, the Live tab's follow and scroll, dialogs and drift closing, and that Like/Dislike appears under the start reply.
6. Real Jev intent plus route latency, and Laya's route seconds, from usage.jsonl `logDecision`, to set `waitMs` (default 15 s).
7. Codex `turn/steer` while a command runs, and Send now's interrupt plus new turn on the ephemeral thread at the original effort.
8. Claude with the toggle on:
   - when a mid-turn stream-json message is folded (`user_message_uuids`);
   - whether an unfolded one runs as a second turn;
   - the interrupted result's `terminal_reason`.

   These decide whether the toggle may ever default on.
9. PowerShell 5.1 launched by Electron: the new script's lines appear under Preparing and never as errors.
10. Send now over the cap with a local model loaded: responsiveness, to settle the product choice in 5.3.

### 5.3 Product decisions left to the owner (defaults in brackets)

- Send now may exceed Tasks at once [yes, with the warning]. Should it refuse when a local model runs or the task is forced local [warn only]?
- Offer "Stop jev-4 and start this" for a folder held by another task [yes, double-confirmed].
- `Let my ratings move Auto effort` [on].
- Transcript retention [last 100 tasks, 256 KiB each; `Off` available].
- Whether progress notices should exist at all beyond `started` [Milestones; `Start and result only` available].
- Whether a chat message that clearly refers to a running task should become a steer automatically [no: only `@jev-N`, `/steer` and the buttons].
- Whether Laya Auto should ever use the Jev-taught intent domain [no: Laya decides every Laya row].

---

## 6. Addendum: what the Strata study adds to the slices

The owner asked to study Niko1221/Strata (commit a790805) and take the best of it.
Verdict: learn from it, do not run it on the owner's PC (an RTX 3080 10 GB and 32 GB of RAM fit only its Coder in low-RAM mode, reading experts from the SSD, speed unmeasured).
These items join the slices below; the rest are follow-up tasks listed at the end.

- **Slice 4: a heartbeat that means progress.**
  Strata sends a heartbeat after 10 s of quiet and keeps a 2 s windowed rate (serve/server.py:320-328, 54-57).
  The live store keeps `lastActivityAt` and a windowed token rate per run in memory only (never in `tasks.jsonl`, which each event would rewrite), and the activity line reads `quiet for N s` with a rate that falls to 0 during a stall.
- **Slice 4: a cut stream is not a finish.**
  Strata always ends a stream with a finish or an error (server.py:1459-1464; test_server.py:339-371).
  `local.js` yields `finish ?? { kind: 'stop' }` (about line 286), so a llama-server stream that died mid-answer is delivered as complete; it gets an `ended early` outcome instead, with a test that cuts the fake server's stream.
- **Slices 7 and 10: an abortable acquire and a cancel scoped to one run.**
  `local.js` `acquire()` takes no signal (about lines 1513-1527), so a cancelled waiter still cold-loads its model, and between two calls of one agent run (busy 0) another model can be swapped in.
  `acquire()` takes a signal; a model is held while an agent's run works; every abort names its run; every live row ends in a final state (server.py:998-1002).
- **Slice 8: message order for a steered local model.**
  Strata puts tool results before the user's text (frontend.py:191-208); `local.js` `toWire` does the reverse (about lines 209-212), so a local model would read a Steer before its tool result.
  Tool results go first; system messages become user messages only after the first non-system message (a literal port of frontend.py:133-138 would demote DSH's own prompt).
- **Slice 2: no silent gap before the reply.**
  Strata opens the stream before it waits (server.py:1056); the lazy reasoning block of Feature 2 already covers the intent and routing waits.
- **Slice 9: gate promotion on measured records.**
  Strata keeps a default unless a candidate wins by more than 3% in interleaved runs and reports standard errors (tools/calibrate.py:32, 153-160); the quick and instant gates above are the same discipline (45 of the last 50, 16 of the last 20), and `shadow-stats.js` gains an interval.
- **Tests: paced fakes that inject faults** (Strata's MockEngine family, server.py:66-89, test_server.py:317-490): `test/fixtures/fake-llama-server.mjs` gains `/v1/chat/completions` pacing, quiet periods, a cut stream and abort logging, for the slices that need them.

Follow-up tasks, not on this branch: a per-type KV cache estimate in `local.js` and a q8_0 KV option gated on a needle check; protecting the agent's prompt prefix (titles and compaction off its slot); a tune step for local-model settings; one sparse MoE with experts in RAM (`--n-cpu-moe`); re-checking VRAM after warm-up under WDDM; an engine update that never leaves the user stranded; plain failure messages (old driver) and "still starting (N s)" narration; page file, priority and iGPU hints; download retries; discriminating fixtures and enforced goldens; evidence folders for benchmark claims.
