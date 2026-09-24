# Jev Auto UX and General Routing Design

> **Superseded in part, 24 Sep 2026.** The UX half of this document - the foreground and
> background split, delivery and at-most-once, task states, the result head, the effort ladder and
> the transcript controls - still matches the code and is still worth building against.
>
> The **General Capability Routing** half does not. The Jev questions for the executor pick, the
> seven-step cost-policy ordering and the preferred model set were superseded by `53d90e1` and
> `a0528db`. Resource selection, conservation and frontier escalation are now decided in code, and
> candidates reach the decision layer anonymised as `RESOURCE_A`/`RESOURCE_B` with no provider or
> model named anywhere in the routing path - so a named preferred-model list is not a detail that
> drifted, it is the opposite of the design.
>
> Build the routing half against [adaptive-routing.md](../../adaptive-routing.md) and
> [roadmap.md](../../roadmap.md) instead. This file is kept as a record of intent.


Date: 2026-09-21
Status: Awaiting user review
Workspace: `C:\Harness`

## Summary

Jev Auto is a continuously available conversation at the front of KzH. The user can always keep talking to it. Any operation that reads, checks, transforms, researches, or changes something runs as a background task and never occupies or interrupts the foreground conversation.

Jev itself remains the typed decision layer rather than a text generator. A conversational model speaks in the foreground, while Jev decides whether a request needs only a direct answer or should also launch one or more background capabilities. It chooses the least expensive capable path for quick answers, OCR, image inspection, document work, research, deterministic tools, project changes, and future registered capabilities.

Background-task output will no longer be inserted into another model's answer. Every completed task will be delivered as a separate, clearly attributed message after the active response finishes. The task list will use the same persisted task state as chat delivery so users can always tell what is waiting, running, completed, failed, stopped, or awaiting display.

The top bar will also gain one control that expands or collapses every reasoning and tool transcript in the current conversation.

## Problems

### Mixed message ownership

The adapter currently prepends pending background reports to the next response. This can make a background agent appear to interrupt another model and makes it difficult to identify who produced each section.

### Code-only routing vocabulary

The current intent question divides messages into direct questions and project coding tasks. The router and agent descriptions also assume that routed work means code. That prevents Jev from selecting OCR, image, document, research, and other non-code capabilities as first-class handlers.

### Stale or ambiguous task progress

The task list can retain incomplete progress when runs stop, hit limits, fail during review, or finish without their report being displayed. A user cannot reliably tell which task completed, which task stopped, and which result remains unread.

### Transcript controls are fragmented

Individual reasoning and tool details can be opened or closed, but there is no conversation-wide control. Inspecting or hiding all execution details requires repetitive interaction.

## Goals

1. Keep the foreground conversation available while any number of background tasks are queued or running.
2. Never insert a background result inside an active foreground answer.
3. Make the producer and task associated with every background result unmistakable.
4. Keep task-list state accurate through every terminal outcome, including process interruption and app restart.
5. Route non-code work using registered capabilities and select the cheapest executor that fully satisfies the request.
6. Answer simple questions with a fast local model when one is available and capable.
7. Let users expand or collapse every reasoning and tool transcript with one top-bar control.
8. Preserve existing manual agent selection, offline operation, verification, review, quotas, and per-workspace serialization.

## Non-goals

- Building every possible capability in this change.
- Allowing Jev to generate prose, perform OCR, or execute side effects itself.
- Replacing deterministic verification with model judgment.
- Merging unrelated agents into a single visible speaker.
- Running two mutating tasks concurrently in the same workspace.

## Terminology

- **Foreground response:** The answer currently streaming in the conversation.
- **Front conversation:** The always-available conversational layer through which the user talks to Jev Auto. It acknowledges requests, answers questions, reports task state, and launches background work, but does not itself perform long-running operations.
- **Background task:** Work submitted to the job queue and executed outside the foreground response.
- **Result delivery:** The separate conversation message that presents a finished background task.
- **Unread result:** A terminal task whose result has not yet been displayed successfully in its owning conversation.
- **Capability:** A registered handler category such as direct answer, OCR, image inspection, document processing, web research, deterministic tool, or project agent.
- **Executor:** The concrete tool, local model, hosted model, or agent that performs a capability.

## User Experience

### Always-available front conversation

Jev Auto behaves like a front desk that never closes:

1. Every user message receives a foreground conversational response.
2. Simple questions are answered directly by the fastest capable conversational model.
3. Requests requiring work are acknowledged immediately and converted into background tasks.
4. The user can continue talking, asking questions, or launching other work while tasks run.
5. Foreground answers never wait for project checks, OCR, research, file edits, reviews, or another workspace's queue.
6. A background task may stream progress to its task-list row, but not into the foreground message.
7. Finished results are delivered as separate attributed messages only at a safe boundary between foreground responses.

The foreground model must not claim that background work is complete. It reports only observed queue state, for example:

```text
I have queued the receipt OCR as task jev-4. You can keep talking while it runs.
```

This separation is architectural, not merely visual. Foreground conversation streams and background job streams use different message identities and delivery channels.

### Foreground and background ordering

When a background task finishes while another response is streaming:

1. Do not modify or append to the active response.
2. Mark the task result as ready and unread.
3. Show a lightweight status indicator outside the active message:

   `[Background task completed, queued for display]`

4. Wait until the active response reaches a terminal stream event.
5. Deliver each ready result as its own conversation message in completion order.
6. Mark a result read only after its message has been accepted by the conversation renderer.

If several tasks finish during one response, their result messages are delivered consecutively after that response. A failed delivery remains unread and is retried on the next safe delivery opportunity.

### Background result message

Every result uses a dedicated visual container and semantic label:

```text
──────────────── Background task result ────────────────
Task: Fix sidebar width
Task ID: jev-3
Agent: Claude Code
Model: Opus 5
Status: Completed

Result:
...
──────────────── End background result ─────────────────
```

Required properties:

- Visually distinct background or bordered section.
- Accessible label announcing it as a background-task result.
- Task name, task ID, agent, model when known, and terminal status.
- Result body, failure reason, or stopped explanation.
- A link or action that opens the matching task-list entry.
- No reuse of the active model's chat bubble or speaker identity.

### Task list

Each task row displays:

- Task name and stable job ID.
- State icon and label.
- Assigned agent and model when known.
- Current phase.
- Latest progress line.
- Queue position when waiting.
- Elapsed time while running and total duration after completion.
- Unread-result indicator.
- Expandable final report or failure detail.

States and presentation:

| Internal state | User label | Presentation |
| --- | --- | --- |
| `queued` | Waiting | Clock icon and queue position |
| `routing` | Choosing executor | Active progress indicator |
| `running` | Running | Active progress indicator, agent, phase, timer |
| `verifying` | Verifying | Active progress indicator and current check |
| `reviewing` | Reviewing | Active progress indicator and reviewer |
| `completed` | Completed | Check mark and struck-through task title |
| `failed` | Failed | Error icon and visible failure reason |
| `stopped` | Stopped | Stop icon and explanation |
| `needs_human` | Needs input | Attention icon and required decision |
| `paused_limit` | Paused by limit | Pause icon and reset or handoff detail |

The list must derive from one canonical task record. Chat delivery status is a field on that record, not a separate inferred list.

### Transcript toggle

Add one top-bar button:

- Label: `Expand all transcripts` when any transcript is collapsed.
- Label: `Collapse all transcripts` when all transcripts are expanded.
- Applies to reasoning blocks and tool-call transcript blocks in the current conversation.
- Newly created transcript blocks follow the active global preference.
- The preference is retained for the current application session.
- The button includes `aria-expanded`, a tooltip, keyboard focus styling, and a configurable shortcut entry.
- The control is disabled or hidden when the conversation contains no transcript blocks.

## General Capability Routing

### Three-stage interaction model

Each user message passes through three explicit stages:

1. **Conversation decision:** Can the front conversation answer immediately, or must work be launched?
2. **Capability selection:** What kind of background outcome does the request require?
3. **Executor selection:** Which available executor can produce that outcome at the lowest expected total cost while meeting quality, privacy, modality, and side-effect requirements?

One message may do both. For example, the foreground can answer a clarification immediately while queuing OCR or project inspection behind it. This replaces the current mutually exclusive question-versus-code-task boundary with a reusable capability registry and independent foreground/background outcomes.

### Initial capability categories

| Capability | Example | Preferred path |
| --- | --- | --- |
| `quick_answer` | Greeting or simple factual question | Fast local chat model |
| `reasoned_answer` | Multi-step explanation | Stronger local or hosted chat model |
| `ocr` | Extract text from an image or scan | Deterministic OCR tool, then optional verification |
| `image_inspection` | Describe or check an attached image | Vision-capable local model, tool, or agent |
| `document_processing` | Read, transform, or validate PDF/DOCX | Document tool or capable agent |
| `web_research` | Current information with sources | Browser/search-capable handler |
| `deterministic_tool` | Exact conversion or known script | Registered script or tool |
| `project_read` | Explain repository behavior | Read-only project agent |
| `project_change` | Implement or fix something | Mutating project agent plus checks and review |
| `human_required` | Missing authorization or consequential choice | Ask the user |

The registry is data driven. New capabilities and executors can be added without adding another routing branch.

### Capability contract

Each registered executor declares:

- Supported capabilities.
- Accepted input modalities.
- Whether it may read or mutate project files.
- Network requirement.
- Privacy locality.
- Expected latency class.
- Cost class or current measured price.
- Required credentials or installation state.
- Verification hooks.
- Maximum supported input size.

Code filters incapable or unavailable executors before Jev sees the options. Jev never chooses a handler that cannot accept the supplied modality or perform the required side effect.

### Jev questions

One batched TypeSafe request should ask independent judgments over the same compact state:

- Whether a direct conversational answer is useful now.
- Whether background work is required in addition to, or instead of, that answer.
- Capability choice from the currently available capability set, including `human_required` and `other`.
- Whether the request can be fully satisfied without project or tool access.
- Whether attached media must be inspected.
- Whether the result requires current external information.
- Whether the action changes files or external state.
- Complexity and consequence risk.
- Whether deterministic verification is required.
- Preferred executor among only the capable, available candidates.
- Branch-specific argument choices for registered deterministic tools, asked speculatively in the same request.

Known rules remain in code. File presence, modality support, login state, network availability, cost calculation, queue state, arithmetic, limits, and permissions are not delegated to Jev.

### Cost policy

Executor selection uses this order:

1. Must satisfy capability, modality, privacy, and side-effect requirements.
2. Must be available, authenticated, installed, and below its stop limit.
3. Prefer deterministic tools over models when they fully cover the request.
4. Prefer the fastest suitable local model for simple direct answers.
5. Prefer lower expected total cost among executors likely to meet the quality bar.
6. Include retry probability, verification cost, and historical success rate in expected cost.
7. Escalate on low confidence rather than silently choosing an incapable cheap option.

This treats “cost efficient” as expected cost to a correct result, not merely the cheapest individual call.

### Preferred model set

The primary models Jev Auto should normally route across are:

- GPT-5.6 family.
- Claude Opus 5.
- Claude Sonnet 5.
- DeepSeek V4.1 Flash (`deepseek-flash` internally).

Claude Fable remains a supported executor and supports Ultracode, but it is not added to the primary set unless its capability, latency, cost, or availability makes it the best eligible choice. The registered model catalog remains the source of capability and availability facts; preference affects ranking after incapable and unavailable models are removed.

### Effort mapping

The foreground conversation stays responsive at every selected effort. Effort controls the executor launched for background work, not the speed or availability of the front conversation.

When the user selects `Ultra`, each background executor receives its own highest intended mode:

- Claude Code Opus 5, Sonnet 5, and Fable: `ultracode`.
- Codex GPT-5.6 and newer: `ultra`, including Astra, Sol, Terra, and Luna.
- Older Codex models: highest effort actually supported by that model.
- DeepSeek: `max`.
- Local models and deterministic tools: no synthetic effort value; use their configured execution mode.

The adapter and settings UI must use the same mapping. A label must never advertise Claude Ultracode while the execution layer silently sends Claude `max`.

### OCR example

For “read the text on this receipt and check the total”:

1. Code detects an attached image and offers only image-capable handlers.
2. Jev selects `ocr` and separately marks arithmetic verification as required.
3. A deterministic OCR engine extracts text.
4. Code parses numeric candidates and calculates totals.
5. A narrow verification step checks ambiguous fields if needed.
6. The answer identifies the OCR tool and any verifying model.

Jev does not perform OCR, calculate the total, or generate the response itself.

## State and Event Model

### Canonical task record

```text
TaskRecord
  jobId
  sessionId
  workspace
  taskName
  taskText
  capability
  executor
  agent
  model
  state
  phase
  queuePosition
  progressText
  queuedAt
  startedAt
  finishedAt
  terminalReason
  report
  deliveryState: pending | delivering | delivered
  deliveredAt
```

Every transition is persisted. On application restart, any task left in a non-terminal state without a live job is reconciled to `stopped` with an interruption reason rather than remaining visually active forever.

### Event ordering

Events carry a task ID, monotonically increasing per-task sequence number, timestamp, state, phase, and display text. The browser ignores older sequence numbers so delayed events cannot move a completed task back to running.

Terminal transitions are idempotent. Duplicate completion notices may retry result delivery but cannot duplicate the visible report after the delivery acknowledgement is persisted.

## Error and Recovery Behavior

- If Jev is unavailable, deterministic capability filters still run and the configured fallback policy selects an executor.
- If no executor supports the input, explain what is missing and do not pretend the task ran.
- If a worker reaches a usage limit, persist the current task state and handoff before selecting another executor.
- If the application exits during a task, reconcile the task on startup using the job service. If the job no longer exists, mark it stopped and preserve its last progress line.
- If a result message cannot be rendered, keep `deliveryState: pending` and retry later.
- If the conversation no longer exists, retain the result in the task list as unread.
- Stopping a task never discards work already written; the row and report state explain this explicitly.

## Accessibility

- Background results use semantic grouping and a readable heading, not color alone.
- State icons always include text labels.
- Progress updates avoid excessive live-region announcements; announce only meaningful phase and terminal changes.
- Transcript controls are keyboard accessible and expose expanded state.
- Focus is not stolen when a background result arrives.
- New result messages can expose a non-modal “new background result” indicator for screen-reader and keyboard users.

## Testing Strategy

Implementation follows test-driven development. Each behavior begins with a failing test.

### Adapter and delivery tests

- A foreground answer can stream while background tasks are running.
- Launching a task returns an immediate conversational acknowledgement.
- A single user message may produce a foreground answer and enqueue background work without conflating them.
- A completed background result never appears inside an active foreground response.
- A result is delivered only after the foreground stream ends.
- Multiple results are delivered in completion order as separate messages.
- Every result contains task name, ID, agent, model when known, and status.
- Failed delivery stays pending and retries without duplication.
- Job notices cannot reroute the previous user request.

### Task-state tests

- Every allowed transition updates the task row.
- Older event sequence numbers cannot regress state.
- Completed, failed, stopped, needs-human, and paused-limit states are terminal and visible.
- Restart reconciliation removes stale running states.
- Delivery acknowledgement changes only the matching result to delivered.
- Queue reordering updates displayed positions.

### Capability-routing tests

- Simple questions choose an available quick local model.
- OCR requests never route to text-only executors.
- Exact supported operations choose deterministic tools.
- Project changes choose mutating agents and retain checks and review.
- Read-only project questions do not grant mutation unnecessarily.
- Current-information requests require a network-capable research handler.
- Unavailable executors are omitted before the Jev request.
- All independent Jev judgments are batched into one request.
- Low-confidence or no-match results escalate safely.
- Model and request ID are logged for each Jev call.
- Selecting Ultra sends `ultracode` to Claude Code background work, not `max`.
- Selecting Ultra supports Claude Opus 5, Sonnet 5, and Fable in Ultracode mode.
- Selecting Ultra sends `ultra` to GPT-5.6 and newer Codex models, including Astra, Sol, Terra, and Luna.
- Effort settings do not block or slow the foreground conversation layer.

### UI tests

- Expand-all opens every reasoning and tool transcript.
- Collapse-all closes every reasoning and tool transcript.
- Newly arriving transcript blocks follow the current global state.
- Button label and `aria-expanded` remain synchronized.
- Task terminal states have distinct text labels and do not rely on color alone.
- Background reports render as their own attributed sections.

### End-to-end scenarios

1. Start a long task, ask a question while it runs, finish the task during the answer, and verify the answer completes before a separate result appears.
2. Queue five tasks in one workspace, stop one, fail one, complete two, leave one waiting, restart the app, and verify every row and report is correct.
3. Submit a receipt image for OCR and arithmetic checking, then verify capability selection, tool execution, calculation in code, and attribution.
4. Ask a greeting and verify the fast local model answers without starting a project job.

## Implementation Boundaries

Expected areas of change:

- `plugins/jev-router/adapter.js`: foreground/background delivery separation.
- `plugins/jev-router/tasks.js`: canonical task state, delivery state, sequencing, and restart reconciliation.
- `plugins/jev-router/jev.js`: general capability and executor judgments.
- `plugins/jev-router/router.js`: capability execution policy and verification dispatch.
- `plugins/jev-router/client.js`: task-list rendering, background-result presentation hooks, and top-bar transcript control.
- Related router and UI tests.
- README behavior documentation after implementation is verified.

Existing uncommitted changes in these files must be preserved. Implementation should be performed as small test-first patches against the current working tree.

## Acceptance Criteria

The work is accepted when:

1. The user can continue a foreground conversation while background tasks are queued or running.
2. A background task cannot interrupt or share a message with a foreground model answer.
3. Every delivered background result visibly identifies its task and executor.
4. Five queued tasks can be followed accurately from waiting through terminal state, including after restart.
5. Completed tasks are checked and struck through, while failed, stopped, paused, and needs-input tasks remain visibly distinct.
6. Unread and delivered result state is accurate and persistent.
7. Jev routes at least direct answers, OCR, deterministic tools, project reads, and project changes through the capability registry.
8. Simple questions use a capable quick local model when available.
9. OCR and other modality-specific work cannot be assigned to incapable executors.
10. Expand-all and collapse-all control all current and newly arriving transcripts.
11. Ultra maps to Claude Code Ultracode, GPT-5.6-and-newer Codex Ultra, and DeepSeek Max.
12. All relevant automated tests pass, and a separate review verifies the implementation before it is called complete.
