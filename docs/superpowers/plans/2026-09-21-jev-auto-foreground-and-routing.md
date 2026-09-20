# Jev Auto Foreground and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Jev Auto continuously conversational in the foreground while all operational work runs in accurately tracked background tasks with separate attributed results, general capability routing, correct Ultra mappings, and a global transcript control.

**Architecture:** Split conversation response, semantic capability selection, background execution, persisted task state, and result delivery into explicit boundaries. The adapter always owns the foreground response; the task service owns asynchronous work and delivery acknowledgements; a capability registry filters eligible executors before one batched Jev request ranks them; the browser renders task events and transcript state without inferring backend state.

**Tech Stack:** Node.js 22 ESM, `node:test`, DSH/Cordis plugins, `@typesafe-ai/sdk` 0.6.0 with Jev `jev-1.13.0`, browser DOM APIs.

## Global Constraints

- Preserve the current dirty working tree and re-read a file immediately before each patch.
- Do not commit. Commits are authored by the human only.
- Jev is a typed judgment layer and must never generate text.
- Batch independent Jev questions into one request.
- Keep arithmetic, exact lookup, availability, permissions, limits, queue state, and side effects in code.
- The foreground conversation must never wait for operational background work.
- One mutating task per workspace remains mandatory.
- API keys remain server-side.
- Log the returned Jev model and request ID.
- Pin the routing model to `jev-1.13.0`.
- Complete each behavior through a witnessed red-green-refactor cycle.
- Do not claim completion without a fresh independent review and fresh relevant verification.

---

### Task 1: Correct Ultra capability mapping

**Files:**
- Modify: `plugins/jev-router/effort.js`
- Modify: `plugins/jev-router/test/effort.test.js`

**Interfaces:**
- Consumes: `toAgentEffort(level, agentDef, { complexity, risk, override, model })`.
- Produces: executor-native effort strings, including Claude `ultracode`, GPT-5.6 `ultra`, and DeepSeek `max`.

- [ ] Write failing table cases proving Ultra maps Claude Opus 5, Sonnet 5, and Fable to `ultracode`; GPT-5.6 Astra, Sol, Terra, and Luna to `ultra`; DeepSeek V4.1 Flash to `max`; and older Codex models to their declared maximum.
- [ ] Run `node --test test/effort.test.js` from `plugins/jev-router` and confirm the Claude and Luna cases fail for the current hardcoded mappings.
- [ ] Replace the restrictive mappings with a small capability resolver. Prefer declared supported efforts when supplied; retain a conservative fallback for older models.
- [ ] Run the focused effort tests and confirm they pass.
- [ ] Refactor duplicate model-family checks while keeping the focused tests green.

### Task 2: Persist accurate background-task state and delivery state

**Files:**
- Modify: `plugins/jev-router/tasks.js`
- Modify: `plugins/jev-router/test/tasks.test.js`
- Modify: `plugins/jev-router/index.js`

**Interfaces:**
- Produces `TaskRecord` fields: `state`, `phase`, `progressText`, `eventSequence`, `terminalReason`, `report`, `deliveryState`, `deliveredAt`, `agent`, and `model`.
- Produces `pending(sessionId)` records rather than preformatted concatenated chat text.
- Produces `ackPending(sessionId, jobIds)` that acknowledges only successfully rendered results.

- [ ] Write a failing task-state transition test covering queued, routing, running, verifying, reviewing, completed, failed, stopped, needs-human, and paused-limit states.
- [ ] Write a failing stale-event test proving an older sequence cannot regress a completed task to running.
- [ ] Write a failing delivery test proving pending results remain unread until their exact IDs are acknowledged and cannot be duplicated afterward.
- [ ] Write a failing restart-reconciliation test proving persisted non-terminal tasks without live jobs become stopped with an interruption reason.
- [ ] Run `node --test test/tasks.test.js` and confirm each new behavior fails for the intended missing contract.
- [ ] Implement one transition function that validates ordering, updates phase/progress, and persists terminal details.
- [ ] Store structured pending results and targeted delivery acknowledgements.
- [ ] Reconcile stale live records during task-service initialization.
- [ ] Run the focused task tests and refactor persistence duplication after green.

### Task 3: Separate foreground conversation from background execution and delivery

**Files:**
- Modify: `plugins/jev-router/adapter.js`
- Modify: `plugins/jev-router/index.js`
- Modify: `plugins/jev-router/test/adapter.test.js`
- Modify: `plugins/jev-router/test/tasks.test.js`

**Interfaces:**
- Consumes structured pending task results from Task 2.
- Produces independent foreground reply blocks, immediate task acknowledgements, and separately identifiable background-result messages.
- Produces renderer acknowledgement carrying the delivered task IDs.

- [ ] Write a failing stream test where a foreground answer is active when a task completes; assert the task report is absent from the foreground text.
- [ ] Write a failing ordering test proving multiple finished reports are emitted only after the foreground stream ends and remain in completion order.
- [ ] Write a failing attribution test proving each result carries task name, ID, agent, model, and terminal status.
- [ ] Write a failing mixed-outcome test proving one user message may receive a conversational answer and enqueue background work.
- [ ] Run `node --test test/adapter.test.js test/tasks.test.js` and confirm the tests fail because pending reports are currently prepended.
- [ ] Replace `before` text concatenation with a foreground response channel plus structured post-stream result delivery.
- [ ] Keep job-notice turns from rerouting prior user input.
- [ ] Acknowledge only result messages that the output stream completed successfully.
- [ ] Run the focused tests and refactor block-index handling after green.

### Task 4: Add general capability and executor routing

**Files:**
- Create: `plugins/jev-router/capabilities.js`
- Modify: `plugins/jev-router/jev.js`
- Modify: `plugins/jev-router/router.js`
- Modify: `plugins/jev-router/index.js`
- Modify: `plugins/jev-router/test/jev.test.js`
- Modify: `plugins/jev-router/test/router.test.js`
- Create: `plugins/jev-router/test/capabilities.test.js`

**Interfaces:**
- Produces `buildCapabilityCatalog({ agents, tools, models, connectivity, attachments })`.
- Produces filtered executor records with capability, modalities, mutation, network, locality, latency, cost, readiness, limits, and verification hooks.
- Extends Jev routing output with `foreground`, `backgroundRequired`, `capability`, `executor`, and existing risk/complexity signals.

- [ ] Write failing registry tests proving text-only executors are excluded from OCR/image work, unavailable executors are removed, project-read handlers cannot mutate, and deterministic tools rank before models when they fully cover the request.
- [ ] Write a failing Jev payload test proving capability choice, foreground usefulness, background requirement, modality need, external-information need, mutation, risk, verification, executor choice, and speculative tool arguments share one request.
- [ ] Write failing routing tests for quick local answers, OCR plus deterministic arithmetic, project reads, project changes, current web research, and human escalation.
- [ ] Run the three focused test files and confirm failures identify the current code-only classification boundary.
- [ ] Implement the data-driven registry and code-side eligibility filter.
- [ ] Replace mutually exclusive question/task classification with independent foreground and background judgments.
- [ ] Preserve the old manual-agent, offline, quota, checks, review, and handoff behavior through adapters around the new routing result.
- [ ] Ensure TypeSafe question definitions and thresholds remain centralized and `request_id` plus model are logged.
- [ ] Run focused capability, Jev, router, and adapter tests; refactor only after green.

### Task 5: Render accurate task rows and separate background-result sections

**Files:**
- Modify: `plugins/jev-router/client.js`
- Modify or create browser-facing tests under `plugins/jev-router/test/` following the existing client test pattern.

**Interfaces:**
- Consumes canonical `TaskRecord` JSON and background-result metadata.
- Produces accessible task rows and visually separate result containers.

- [ ] Write failing DOM behavior tests for every task state, sequence-safe updates, queue position, elapsed time, unread marker, terminal detail, and completed strike-through.
- [ ] Write a failing result-render test proving the section has an accessible background-task heading and task/executor attribution.
- [ ] Run the focused client tests and confirm the old task rendering lacks the required state and attribution.
- [ ] Implement one state-to-view mapping table and a reusable result-section renderer.
- [ ] Ensure result arrival does not move focus or interrupt an active response.
- [ ] Run focused client tests and refactor repeated DOM construction after green.

### Task 6: Add global transcript expansion control

**Files:**
- Modify: `plugins/jev-router/client.js`
- Modify: `plugins/jev-router/test/hotkeys.test.js`
- Modify or create browser-facing transcript tests under `plugins/jev-router/test/`.

**Interfaces:**
- Produces a top-bar button with `aria-expanded`, dynamic label, session preference, and configurable shortcut.
- Applies to existing and newly inserted reasoning and tool transcript disclosure elements.

- [ ] Write failing tests for expand all, collapse all, label synchronization, `aria-expanded`, new transcript inheritance, no-transcript disabled state, and keyboard activation.
- [ ] Run the focused tests and confirm the global control is absent.
- [ ] Implement a single transcript-state controller and observe newly inserted transcript nodes.
- [ ] Register the top-bar action and shortcut through existing header/hotkey primitives.
- [ ] Run focused tests and refactor state/listener duplication after green.

### Task 7: Documentation, regression verification, and independent review

**Files:**
- Modify: `README.md`
- Verify: all files changed in Tasks 1 through 6.

**Interfaces:**
- Produces user-facing documentation matching verified behavior.

- [ ] Update README terminology only after implementation behavior is green: always-available foreground conversation, background result sections, canonical task states, general capabilities, preferred models, Ultra mapping, and transcript control.
- [ ] Run `npm test` from `plugins/jev-router` and record pass/fail counts.
- [ ] Run the app's relevant build, lint, or syntax checks discovered from its package scripts.
- [ ] Manually test foreground conversation during a long background run and verify the result arrives afterward as a separate message.
- [ ] Queue five tasks and exercise completed, failed, stopped, waiting, and running states, then restart and verify reconciliation.
- [ ] Manually verify quick local answering, OCR executor eligibility, Ultra mappings, and global transcript state.
- [ ] Request an independent diff review from a different model or agent. Fix findings through new failing tests.
- [ ] Re-run the full verification suite after review fixes and report exact evidence and remaining limitations.

