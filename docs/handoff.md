# KzH handoff

Kind: **living handoff**. This is the one to read first, and the one to update. It replaces
`handoff-2026-09-21.md` and `handoff-2026-09-21-pass2.md`, both of which were folded in here on
22 Sep 2026 and deleted; every item they held that was still open is below, and every item they
held that was closed was checked against the code before being dropped.

Written for whoever picks this up next, including another agent. Everything here was verified
unless it says otherwise. Where something is unverified it says so.

## State

```
branch        main                         (primary; chore/initial-setup points at the same commit)
remote        origin github.com/kz-95/kz-harness, PUBLIC
tests         388 pass, 0 fail             (cd plugins/jev-router && npm test)
app           exe rebuilt 21 Sep 22:16, engine on 127.0.0.1:3080
```

Git authorship is the GitHub noreply alias on every commit. All five were rewritten on 22 Sep
before the first push, because a commit's author email is part of the object it is hashed from,
so it is cheap to change while nothing is published and impossible afterwards. Do not add a
personal address back: set it per repo with `git config --local user.email`.

```
```

Plugin-loaded check, the cheap signal worth keeping: from inside the running page,
`/jev-router/usage` returns 200 and a bogus path returns 404. From a shell it is 401 for
everything, because the API wants the engine's per-process token. If cordis ever marks the plugin
INACTIVE the app still boots and looks normal, so that 404 is the only cheap sign every KzH
feature is silently gone.

## Open, and needing the OWNER, not an agent

1. **Feedback privacy.** Up to three recent reason STRINGS ride the routing call to TypeSafe.
   Keep, counts-and-tags-only, or local-only. Worth knowing before deciding: the bias that
   actually moves a pick is computed locally at `router.js:537` from `feedback.jsonl`, so the
   strings only flavour the single call they ride on. Nothing accumulates on the far side for
   your benefit. Defaults are easy; the choice is not an engineering one.
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

- **`scripts/Set-TypeSafeKey.ps1:8`** writes `TYPESAFE_API_KEY` into the persistent HKCU user
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
  `app/main.js:536` and `Start-KzH.ps1:6`.
- **`scripts/Install-Harness.ps1:60`** treats any `cordis.patch.yml` containing "jev-router" as
  configured, so a privacy setting added later never lands on a re-run, while the README says
  re-running does whatever is missing.

Coverage gap worth knowing: no reviewer ran the app, ran the installer, or cloned to a clean
machine. The broken clone URL was found by reading, not by trying it, so the install path is still
unverified end to end. About fourteen of the items above came from a single lens and were not
independently re-derived.

## Open work an agent can do

- **Task-type matching for feedback**, the next real lever. Whether the feedback loop improves
  routing accuracy is UNMEASURABLE until real verdicts accumulate, and there is no task-type
  matching yet, so "similar work" currently means "same session" (`deps.history.feedback` is
  called with a `sessionId`). Recording task features at routing time and matching on them is the
  change. It touches the same function as the privacy question above, so settle that first.
- **Exercise the gemma transfer against a real local model** (`plugins/jev-router/format.js`).
  This is the only thing marked built-but-never-observed that a single real run would settle.
- **Right-panel guide icons.** Six of seven rows use the same generic cube; only Workspace files
  has a real folder icon, so something already makes that one different. Find what, then give the
  rest relevant icons.
- **Stale line references in `progress/progress.html`**, if you touch it.

Closed on the way past, so nobody re-opens them: the `README.md` dangling "described below" is gone
(it reads "the list below" and resolves), and the one machine-specific path in the repo, a Windows
account name inside a `progress.html` note, now reads `~/.kzh`.

A warning that cost a real defect here. Checking that with `git grep <the name>` passes for the
wrong reason when the file you just wrote is still UNTRACKED, because `git grep` searches tracked
files only. Write the check so it cannot quote the thing it is looking for, and run it after
`git add`, not before.

## Built but NOT observed, do not claim these as working

- The gemma 4 message transfer (`format.js`). No real local call has ever been made, only fake
  streams. Its chunking, timeout and fallback paths are unit-tested.
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
- App shell: the `ELECTRON_RUN_AS_NODE` false-positive startup refusal is fixed, and a
  `Use it here` button recovers a port held by our own orphaned engine.
- `scripts/kzh-ui-test.mjs`: a dependency-free CDP tester that replaces Playwright here.

## Root causes worth keeping

1. **`requestAnimationFrame` NEVER fires in this renderer.** The window reports `document.hidden`
   true, `visibilityState hidden`, `outerWidth 0`, and a scheduled callback is never called, while
   `setTimeout` works normally. Any work deferred to a frame is a silent no-op. Every coalescer in
   `client.js` was moved to `setTimeout`, and two tests fail if a frame scheduler is reintroduced.
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

- **Hourly balance watch**: scheduled task `kzh-deepseek-balance-watch`, running
  `node scripts/check-deepseek-balance.mjs`. Exit 0 ok and SILENT, 1 soft handoff, 2 hard cut off,
  3 could not check. Thresholds 255 soft / 240 hard. It fails open on a network error: a failure
  to check is never reported as a zero balance. Verified working unattended.
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

- Killing `Kz-harness.exe` does NOT stop the engine it spawned. The engine orphans on port 3080
  and the next start sits on "another harness is already running on port 3080". Kill the
  `node ... @deepseek-ai\dsh ... web` process too, and confirm 3080 is free before relaunching.
- A `client.js` change needs an app START, not a page reload: the engine composes and caches the
  plugin bundle at startup.
- `Input.dispatchKeyEvent` delivers NOTHING while the window is hidden. Keyboard checks must use
  in-page events or DOM calls. Do not trust a dispatch that reports success with no DOM change.
- The app API needs the per-process token. Query it from inside the page with
  `credentials: 'include'`, never from a shell.
- App-shell changes (`app/**`) need `npm run package` before they reach the exe, and the app must
  be stopped first or packaging fails with EBUSY on the dist directory.
- The exe refuses debug switches unless `KZH_DEBUG=1`, and then only with
  `--remote-debugging-port=9222` for `scripts/kzh-ui-test.mjs`.
- `~/.kzh/profiles` paths are SYMLINKS, and `grep -r` does not follow symlinked directories.

## How to verify the current claims

```
cd plugins/jev-router && npm test                      # 388 pass expected
node scripts/kzh-ui-test.mjs list                      # needs the app on a debug port
node scripts/kzh-ui-test.mjs evalfile <file.js> 3080   # drive the page, in-page events only
```
