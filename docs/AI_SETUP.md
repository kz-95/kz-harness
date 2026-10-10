# Setting up KzH with an AI coding assistant

This page is for a coding agent, Claude Code or Codex, that the owner asked to set up, check or diagnose Kz-harness (KzH) on their Windows PC.
Every step is a Windows PowerShell 5.1 command, or a JSON route of the jev-router plugin with what its answer means.
A person can follow it too, though a person's own path is the README's [Install (new PC)](../README.md#install-new-pc) and [Troubleshooting](../README.md#troubleshooting).
The routes are read from `plugins/jev-router/index.js`, and `plugins/jev-router/test/ai-setup.test.js` fails when a route there has no row on this page.

## Ground rules

- **Ask before any download, install or deletion.**
  Say what it is, how big it is and where it goes, and wait for a yes.
  That covers `Install-Harness.ps1` with its `-LocalModels` and `-Laya`, `Update-Harness.ps1`, the Laya command line, `npm i -g`, `winget`, deleting anything under `~/.kzh` or `C:\Harness`, and the routes that download or delete: `POST /jev-router/local/install`, `POST /jev-router/local/remove`, `POST /jev-router/laya/install`, `POST /jev-router/laya/update`, `POST /jev-router/laya/repair`, `POST /jev-router/laya/weights/apply`, `POST /jev-router/laya/remove`, `POST /jev-router/tasks/clear`, `DELETE /jev-router/keys` and `DELETE /jev-router/custom`.
- **Ask before any other change.**
  Every `POST` and `DELETE` route changes KzH or its settings: read with `GET` first, say what you would change, and wait for a yes.
  Never rate an answer or a pick for the owner (`POST /jev-router/feedback`, `POST /jev-router/replies/ask`): those ratings train the router.
- **Ask before you stop or restart KzH.**
  A restart stops every background task at work or waiting in line, for good: each ends `stopped`, with `interrupted: the app restarted while this task was running` or `the app restarted while this task waited in line, so it never started`.
  The Tasks tab shows whether any is at work.
- **Never print a key.**
  Keys live in `~/.kzh/.env`, and `scripts\Set-TypeSafeKey.ps1` may also have stored `TYPESAFE_API_KEY` as a user environment variable.
  Never print `.env`, `Get-ChildItem Env:`, `$env:TYPESAFE_API_KEY` or any other `*_API_KEY`: list the names of the keys that are set instead (section 1).
  Stored keys never come out of the routes: `GET /jev-router/setup` and `GET /jev-router/usage` say whether a key is set and which stored key is active, by its name, never its value.
  Never put a key into a route or a file yourself: the owner adds keys in Settings or in `.env`.
- **Never copy the engine's token.**
  The `dsh web: http://127.0.0.1:3080/?token=...` line that Start-KzH prints carries the access token of that engine process: leave it in the console, out of files, chats and commits.
- **Keep what the routes return on this PC.**
  History, tasks, the live view and the export carry the owner's task text, file paths and answers, and a key the owner once pasted into a task is still in its text.
- **Reruns are safe.**
  The installer does only what is missing, and the speed run and the Laya command line refuse, rather than run, while KzH is running.
- **PowerShell 5.1 is not bash.**
  There is no `&&` (use `;`, then check `$LASTEXITCODE`), `curl` is `Invoke-WebRequest`, and a `.ps1` runs with `powershell -ExecutionPolicy Bypass -File <script>`.

## 0. Where things are

| What | Where |
| --- | --- |
| The harness | `C:\Harness`, a git clone; the scripts assume it |
| KzH's data | `~/.kzh` (`$env:USERPROFILE\.kzh`), which `Start-KzH.ps1` sets as `DSH_HOME`; the plugin's own files are in `~/.kzh/jev-router` |
| The engine | DSH, at the version `Start-KzH.ps1` pins, run from the npm cache; it serves KzH's page and the plugin's routes on `127.0.0.1:3080` only |
| The app | `C:\Harness\app\dist\Kz-harness-win32-x64\Kz-harness.exe`, which the Kz-harness icon starts; it starts the engine through `Start-KzH.ps1` and stays in the tray |
| Projects | `C:\HarnessProjects` by default; `C:\Harness\no-project` is the chat-only workspace |

## 1. Look at the machine

```powershell
$PSVersionTable.PSVersion          # 5.1 is what this page is written for
node --version                     # 22.19 or newer, 24 recommended
git --version
claude --version                   # each agent the owner uses
codex --version
netstat -ano | findstr ":3080"     # a LISTENING line: KzH's engine, or another program, holds its port; the pid is the last column
Get-Process Kz-harness, llama-server -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime
```

Which keys are set, by name only:

```powershell
Select-String -Path "$env:USERPROFILE\.kzh\.env" -Pattern '^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=' | ForEach-Object { $_.Matches[0].Groups[1].Value }
[bool]$env:TYPESAFE_API_KEY        # True or False, never the value
```

A key stored from Settings is named `KZ_KEY__<provider>__<name>`.
Jev needs `TYPESAFE_API_KEY` or a stored Jev key; without one KzH still runs, on a fixed default agent, and says so.

## 2. Install and update

```powershell
git clone https://github.com/kz-95/kz-harness.git C:\Harness                  # only where there is no C:\Harness yet
powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Install-Harness.ps1
```

The installer checks the tools, installs the packages and the engine with the Claude and Codex connectors, writes the KzH settings (backing up anything it replaces), builds `Kz-harness.exe` with its shortcuts, and lists any keys or CLIs still missing.
It is safe to run again: it does only what is missing.
`-LocalModels qwen3-8b,gemma4-e4b` (or `all`) also downloads those local models, by their ids in `config\local-models.json`.
A model the list marks `not checked yet` (`qwen3-30b-a3b`) is refused by name and left out of `all` until `node scripts\pin-model.mjs <id>` has pinned it; that reads its size and SHA-256 from Hugging Face and writes them into `config\local-models.json`, a file git tracks, so ask before running it.
`-Laya` also installs the Laya decision model: Python, PyTorch, Laya and its model, several GB.
`-NoShortcuts` leaves the Desktop and the Start menu alone.
The agents' own CLIs are `npm i -g @anthropic-ai/claude-code` and `npm i -g @openai/codex`, and signing in needs the owner: `claude`, then `/login`, and `codex login`.

```powershell
powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Update-Harness.ps1    # pulls the harness from git and refreshes its packages; -BumpDsh moves to a newer engine
```

A change under `app\` reaches `Kz-harness.exe` only once the installer builds it again, with the app quit first.
A change to `plugins\jev-router\client.js` needs KzH started again, not a page reload: the engine builds the plugin bundle at its start.

## 3. Start, check and stop

```powershell
& "C:\Harness\app\dist\Kz-harness-win32-x64\Kz-harness.exe"                    # the app, as the icon starts it
C:\Harness\Start-KzH.cmd                                                       # the engine in a console, and KzH in the browser
powershell -ExecutionPolicy Bypass -File C:\Harness\Start-KzH.ps1 -NoOpen        # the same without the browser
powershell -ExecutionPolicy Bypass -File C:\Harness\Start-KzH.ps1 -Workspace D:\Work   # another projects folder than C:\HarnessProjects
```

`Start-KzH.ps1` sets `DSH_HOME`, puts the Codex sandbox helper on `PATH`, applies the engine patches (`scripts\patch-*.mjs`) to the engine it is about to run, and starts it.
It prints `Starting the engine.`, then, once the engine serves, after about 40 s and longer on a first run, the `dsh web:` line with the token.
Double-clicking a `.ps1` opens Notepad, on purpose.

To call the JSON routes (section 7), the app must run with a debug port, which it refuses unless `KZH_DEBUG=1` is set.
With KzH running, this is a restart: ask first.

```powershell
$env:KZH_DEBUG='1'; Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& "C:\Harness\app\dist\Kz-harness-win32-x64\Kz-harness.exe" --remote-debugging-port=9222
node C:\Harness\scripts\kzh-ui-test.mjs list       # the pages on the debug port; KzH's has 3080 in its URL
```

To stop KzH, right-click its tray icon and choose Quit; closing its window leaves it running.
Ending `Kz-harness.exe` any other way leaves its engine running on port 3080, and the next start offers **Use it here**, which stops that engine and everything it started.
To do that by hand, with the owner's yes:

```powershell
netstat -ano | findstr ":3080"                                                          # the pid is the last column
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object Name, CommandLine    # node.exe running @deepseek-ai\dsh ... web is KzH's engine
taskkill /PID <pid> /T /F                                                                # the engine, with the llama-server or Laya it started
netstat -ano | findstr ":3080"                                                          # nothing: the port is free
```

## 4. The speed run

```powershell
C:\Harness\Speed-Run.bat --no-pause                          # every installed local chat model
C:\Harness\Speed-Run.bat --models qwen3-8b --no-pause        # only these, comma separated
C:\Harness\Speed-Run.bat --context 24576 --no-pause          # the context KzH starts local models with, when it cannot read it
C:\Harness\Speed-Run.bat --accept-output --models qwen3-8b --no-pause   # take a figure kept aside because its output differed; measures nothing
$LASTEXITCODE
```

It measures each installed local model as Settings → Local models → Benchmark all does, with KzH closed, and stores each reading in `~/.kzh/jev-router/local.json`, where KzH finds it at its next start.
From a tool, always pass `--no-pause`: without it the window waits for a key at the end.
`--verbose` shows the engine's log as it runs.
It loads every model in turn, on the GPU where there is one, and takes minutes: ask first.
Exit codes: 0, every model was measured; 1, a model was not measured, and its line says why; 2, it could not run (no engine, no model, an unknown model, a bad argument, a context it cannot tell); 3, KzH, a llama-server, a Laya or another speed run is running; 4, every model was measured and a model's output differs from its baseline; 130, cancelled with Ctrl+C.
Each model's run ends with an output check: 64 tokens of a fixed prompt, decoded greedily, held to the first output kept for the same weights, engine build and GPU split in `~/.kzh/jev-router/speed-baselines.json`.
A figure whose output differs is kept aside, not taken as the model's speed, until the owner accepts the new output (`--accept-output`, or **Accept new output** on the model's row in Settings → Local models); ask before accepting it, and show the owner both outputs, which the card shows under **Both outputs**.
Every run is logged in `~/.kzh/jev-router/speed-runs`: `speed-runs.log` holds one entry per run, and `speed-run-<time>Z.log` every phase, request and engine line of one run.

## 5. The Laya command line

```powershell
cd C:\Harness
node plugins\jev-router\laya\install-cli.mjs install          # for the GPU when the NVIDIA driver reports a CUDA version, else the CPU
node plugins\jev-router\laya\install-cli.mjs install --cpu    # or --gpu
node plugins\jev-router\laya\install-cli.mjs update           # or repair, remove, recover
$LASTEXITCODE                                                 # 0 done, 1 refused or failed, 2 a usage error
```

It runs the same install as the Laya card in Settings (`laya-install.js`), as `Install-Harness.ps1 -Laya` does, into `C:\Harness\engine\laya` and `C:\Harness\models\laya`.
An install downloads Python, PyTorch, Laya and its model, several GB, and `remove` deletes Laya's folders: ask first.
`recover` finishes or rolls back an install that was cut off, deleting what it half built, and prints `ok:` with what it did.
It refuses while KzH runs and says how to stop it; with KzH running, install from Settings → Jev setup → Laya decision model instead.
It reads KzH's data folder, `~/.kzh/jev-router`, unless `DSH_HOME` names another.

```powershell
node scripts\laya-integrity-check.mjs --json      # read only: has anything a Laya-decided run did reached what Jev teaches, credits or counts?
```

## 6. Tests

```powershell
cd C:\Harness\plugins\jev-router
npm test                                 # every test file
node --test test\ai-setup.test.js        # one file
```

`npm --prefix plugins/jev-router test` from `C:\Harness` runs the same.
`npm test` runs `test/run.mjs`, which runs every `test/*.test.js` in a temp folder of its own and removes that folder at the end.
The tests run on fakes of the engine, the agents, llama-server and Laya.
The totals come last, as `# tests`, `# pass`, `# fail` and `# skipped` (in a terminal they start with an info mark instead of `#`): `# fail` must be 0, and a few tests skip by platform.
`test\ai-setup.test.js` fails when a route `index.js` serves has no row on this page, or when this page names one it does not serve: change this page in the same change as the route.

## 7. The JSON routes

### How to call one

The routes sit behind the engine's own Host, Origin and cookie checks, which only KzH's page passes, opened as it is with the engine's per-process token: `Invoke-RestMethod` or `curl` from a shell is refused.
Call them from inside KzH's page, through the debug port of section 3:

```powershell
node C:\Harness\scripts\kzh-ui-test.mjs eval "fetch('/jev-router/setup', { credentials: 'include' }).then((r) => r.json())" 3080
```

`eval` waits for the promise and prints the JSON, and `3080` picks KzH's page among the debug port's pages.
For a write, put the call in a file, which spares PowerShell 5.1's quoting:

```powershell
Set-Content -Encoding ASCII "$env:TEMP\kzh-call.js" "fetch('/jev-router/runs/stop', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: '<run id>' }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))"
node C:\Harness\scripts\kzh-ui-test.mjs evalfile "$env:TEMP\kzh-call.js" 3080
```

Every route answers JSON with `cache-control: no-store`, `GET /jev-router/logo.png` aside.
A refusal is `{ "error": "<why>" }`: 400 for a bad field, which the message names, or anything else that fails; 404 for no such route, task, run, reply or saved chat; 409 while a run or an install is already going; 500 when a saved chat cannot be read for an export.
A `POST` or `DELETE` without `content-type: application/json` is refused with 415, and no body, before it is read.
A task's `key` is a UUID, its `jobId` is the `jev-N` the chat shows, and a chat's id is each of its tasks' `sessionId`.

### Setup, agents and keys

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/setup` | `?recheck` asks every agent's CLI again, rather than reusing the reading kept for 5 minutes | Start here. `jev`: `configured`, `activeKey` (the stored Jev key in use, by name), `credentialSet`, `credentialRef`, `host`, and `hostFromEnv` when `TYPESAFE_BASE_URL` moved Jev's calls. `laya`: Laya's supervisor status. `agents`: each with `id`, `provider`, `description`, `enabled`, `custom`, `llm`, `readOnly` and `status` `{ installed, loggedIn, detail }`, where `detail` says what to run when it is not ready. `providers`: the models of Settings → Models. `tools`. `keysRestartPending`: the providers a restart would move onto another stored key. |
| `POST /jev-router/agents` | `{ id, enabled }` | `{ ok }`: one agent switched on or off; 404 for an unknown agent, and 400 for switching on one that `cordis.patch.yml` switches off |
| `POST /jev-router/agents/only` | `{ ids }` | `{ ids }`: exactly these agents on and the rest off, as `/use` does |
| `POST /jev-router/custom` | `{ id, provider, model, description }` | `{ ok }`: a new API-key agent on a model of Settings → Models |
| `DELETE /jev-router/custom` | `?id=` | `{ ok }`: that custom agent removed |
| `POST /jev-router/account-auth` | `{ agentId, action }`, `action` being `login` or `logout` | `{ ok, detail }`: `login` opens a terminal running the agent's own sign-in, for the owner to finish; `logout` signs it out |
| `POST /jev-router/login` | `{ provider }`, `claude` or `codex` | `{ ok }`: a console window running that CLI's sign-in, for the owner |
| `POST /jev-router/logout` | `{ provider }`, `claude` or `codex` | `{ ok }`: that CLI signed out |
| `GET /jev-router/usage` | `?force=1` reads every quota again | `agents`: each agent's quota, state and `rateNow`. `links`. `keys`: the stored keys by name, never a value. `keysRestartPending`, `jevActiveKey`, `jevCredentialSet`. `recent`: the last 50 rows of `usage.jsonl`. `handoffs`: the workspaces with a `.kz-harness/handoff.md`, and when it changed. `savings`. |
| `POST /jev-router/keys` | `{ provider, name, key }` | `{ ok, restartRequired }`: a key stored in `.env` as `KZ_KEY__<provider>__<name>`; it carries the key, so it is the owner's, from Settings → Usage |
| `POST /jev-router/keys/activate` | `{ provider, name }` | `{ ok, restartRequired }`: that stored key made the active one; `restartRequired` says the harness must restart to use it |
| `DELETE /jev-router/keys` | `?provider=&name=` | `{ ok, restartRequired }`: that stored key deleted |
| `POST /jev-router/limits` | `{ agentId }`, an agent or `jev`, with any of `handoffAtPercent` and `stopAtPercent` (0 to 100), `minBalance`, `handoffAtBalance` and `monthlyBudgetUsd` | `{ ok }`: the limits the Usage tab sets |

### Background tasks, runs and the live view

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/tasks` | `?workspace=` keeps one workspace's | `{ tasks }`, the background tasks KzH keeps (the last 100), each with `key`, `jobId`, `sessionId`, `workspace`, `taskName`, `taskText`, `state` (`queued`, `routing`, `running`, `verifying`, `reviewing`, then `completed`, `failed`, `stopped`, `needs_human` or `paused_limit`), `phase`, `position`, `agent`, `model`, `effort`, `plan`, `queuedAt`, `startedAt`, `finishedAt`, `terminalReason`, `finalStatus`, `progressText`, `runIds`, `waiting`, `activity`, `controls` and `steers` |
| `GET /jev-router/tasks/report` | `?id=<jobId>` | `{ report }`: a finished task's report; 404 while it has none |
| `POST /jev-router/tasks/stop` | `{ jobId, onlyIfWaiting }` | `{ result }`: `requested`, `already-finished`, or `started` when `onlyIfWaiting` found it at work and left it |
| `POST /jev-router/tasks/reorder` | `{ workspace, order }`, the job ids in their new order | `{ ok }` |
| `POST /jev-router/tasks/clear` | `{ jobIds }` | `{ cleared }`: the finished ones of those tasks, taken off the list |
| `POST /jev-router/tasks/start-now` | `{ key, stop }`, `stop` being the job id of a task to stop for it | `{ result, holder, words }`: Send now, what came of it in words, and the task in its folder's way |
| `POST /jev-router/tasks/steer` | `{ key, text, how }`, `how` being `auto` (the default), `amend`, `live`, `now`, `follow-up` or `restart` | `{ result, state, words }`, with the `jobId` and `key` of a task it queued, or the `id` of words given to a task at work |
| `POST /jev-router/tasks/seen` | `{ results, sessionId }` | `{ acknowledged }`: how the page marks results read; an agent has no reason to call it |
| `GET /jev-router/live` | `?task=<key>` or `?run=<runId>`, and `&after=<v>` for what changed since | `{ runs, v, patches, done, saved, task }`: each run's `attempts`, its `items` (text, tool calls and reasoning, the last 16 KiB of each) and its `summary`, what it is doing now; `done` once nothing more will come; `saved` when it came from the task's saved transcript |
| `GET /jev-router/log` | `?session=<chat id>` | the Jev inspector's runs of that chat, newest 20, from memory only: each `{ id, startedAt, task, events, jobId, taskKey }` |
| `GET /jev-router/history` | `?session=<chat id>` | `{ session, total, returned, truncated, records }`: that chat's runs from `history.jsonl`, newest 200 |
| `POST /jev-router/runs/stop` | `{ runId }` | `{ ok }`: that run stopped; 404 when no run with that id is going |

### Routing and learning

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/routing` | nothing | `{ enabled, learning, domains, policy, resources, profiles, training }`: whether adaptive routing is on and learning, how far each routing domain has come and what holds it back, each provider's limits and availability as the router sees them now, what each agent is believed good at and on what evidence, and the training store's counts; nothing in it carries task text or a key |
| `POST /jev-router/routing/evaluate` | `{}` | `{ domains }`: an evaluation pass now (train, measure, and move any domain that has earned it), which otherwise runs by itself after runs; 400 with learning off |

### Start replies and feedback

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/replies/summary` | nothing | The How Jev replies card: `learning`, `startReplies` with its `waitMs`, the reply predictor's record and gates, `recent` replies with how each task `ended`, `intent` (how far reading task or question on this PC has come), and `names`; no task text |
| `GET /jev-router/replies` | `?key=<task key>`, and `&session=<chat id>` | `{ key, jobId, said, ran, verdict, ask, askWhenWrong, ended }`: what a start reply named, what then ran, how its pick was rated and its ask answered, and whether its task has ended |
| `POST /jev-router/replies/ask` | `{ key, answer, sessionId }`, `answer` being `said`, `ran` or `either` | `{ key, ask }`: the owner's answer to the ask under a reply whose plan changed; the owner's alone |
| `POST /jev-router/feedback` | `{ sessionId, messageId, verdict }`, `verdict` being `like`, `dislike` or `clear`, with any of `reason`, `tag`, `suggestedAgent`, `provider`, `model`, `runId`, `about` (`answer` or `plan`), `taskKey`, `suggestedEffort` and `intentSample` | `{ ok, record, effects }`: the owner's verdict, stored and learned from; the owner's alone |
| `GET /jev-router/feedback` | `?session=` | `{ feedback }`: the verdicts, the latest for each answer |

### Settings

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/effort` | nothing | `{ default, perAgent, codexSpeed, claudeSpeed, ratingsMove, ratingsResetAt, learned }`: Settings → Effort, and what the owner's ratings move Auto effort by now, in words |
| `POST /jev-router/effort` | the whole object `GET` answered, changed | the settings saved; a field left out goes back to its default |
| `POST /jev-router/effort/ratings-reset` | `{}` | the effort settings again: ratings given before now move Auto effort no more, and none is deleted |
| `GET /jev-router/chat-replies/settings` | nothing | `{ waitMs, progress, askWhenWrong }`: how the chat answers a task it queues |
| `POST /jev-router/chat-replies/settings` | any of those fields | the settings saved; a field left out keeps its value |
| `GET /jev-router/live/settings` | nothing | `{ claudeSteer, claudeThinking, transcripts }`: the Live agent view card |
| `POST /jev-router/live/settings` | any of those fields, `transcripts` being `last20`, `last100` or `off` | the settings saved; a field left out keeps its value, and `transcripts: 'off'` deletes the transcripts kept so far |
| `GET /jev-router/engine-patches` | nothing | `{ "claude-code": { on, why }, codex: { on, why } }`: whether the engine patch behind the live view, Steer and Send now is in each connector, and why not |
| `GET /jev-router/hotkeys` | nothing | `{ bindings, rightbarRatio }`: the Shortcuts page |
| `POST /jev-router/hotkeys` | the whole object, changed | the shortcuts saved; a binding left out is unbound |

### Local models

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/local` | nothing | `engine` (`installed`, `variant`, `running`, `ready`, `model`, `port`, `ctx`, `gpuLayers`, `threads` and its memory), `settings`, `budget`, `modules` (each engine build and model with its `state`: `installed`, `missing`, `verifying` or `corrupt`, its download `job`, `memory`, `ctx`, `overBudget` and `speed`), `speedRun`, `online` and `slots` |
| `GET /jev-router/local/catalog` | nothing | the install picker: `pc`, `specs`, `engine`, and `modules` with their fit on this PC, `suggested` and `reason`, and `suggestions` |
| `GET /jev-router/local/log` | `?lines=` (200 unless said, 500 at most) | `{ file, lines }`: the tail of `llama-server.log` |
| `POST /jev-router/local/start` | `{ model }` | `{ ok }`: that model loaded |
| `POST /jev-router/local/stop` | `{}` | `{ ok }`: the local model stopped |
| `POST /jev-router/local/install` | `{ ids }` | `{ ids }`: the downloads begun, verified by SHA256; follow them in `GET /jev-router/local` |
| `POST /jev-router/local/remove` | `{ ids }` | `{ ok }`: those models, or the engine, deleted from disk |
| `POST /jev-router/local/settings` | any of `chatModel`, `idleMinutes`, `gpuLayers`, `keepWarm`, `loadAtStart`, `maxVramGB`, `maxRamGB`, `maxCores` and `maxConcurrentTasks` | `{ ok }` |
| `POST /jev-router/local/benchmark` | `{ ids }`, or none for every model | `{ queued }`: the speed benchmark begun; 409 while one runs |
| `POST /jev-router/local/benchmark/cancel` | `{}` | `{ ok }`, also when nothing runs; 409 while a cancelled run puts the engine back |
| `POST /jev-router/local/benchmark/accept-output` | `{ id }` | `{ ok }`: that model's speed figure, kept aside because its output differed from its baseline, becomes its speed, and that output its baseline; 400 when it has none kept aside, 409 while a speed run goes |

### Laya

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/laya` | nothing | Laya's status, the whole shape in [laya-auto.md](laya-auto.md) 8.4: `state` (`not_installed`, `installing`, `install_failed`, `stopped`, `starting`, `ready`, `restarting`, `stopping`, `failed` or `disabled`), `why`, `install` (an install's step, bytes and `error`), `installed`, `expected`, `running`, `settings`, `selfTest`, `warnings`, `logTail`, `configError`, `pinsError`, `shadow`, `colibri`, `recovered`, `paths`, `need` and, until installed, `offer` |
| `GET /jev-router/laya/log` | `?lines=` (200 unless said, 500 at most) | `{ lines }`: the last lines Laya printed, kept in memory as they go to `laya-serve.log`, or a failed install's own lines |
| `GET /jev-router/laya/shadow` | `?runId=` | `{ rows, waiting }`: Laya's answers beside Jev's for that run |
| `GET /jev-router/laya/compare` | `?days=` (7, or `all`) and `&identity=` (`current` or `all`) | the side-by-side comparison of Jev and Laya; 404 when Laya cannot be asked on this PC and nothing was compared |
| `GET /jev-router/laya/colibri` | nothing | colibri's Laya beside `laya.serve` ([laya-auto.md](laya-auto.md) 13), the figures the Laya card shows: `address`, `on`, `reachable` (`ok`, `why`, `model`, `checking`), `compared`, `failed`, `dropped` (`busy`, `local_busy`, `laya_busy`, `not_reachable`), `agreement` by question type, `gap`, `medianMs`, `confidence` (each engine's own figure and not one scale: `laya.serve`'s normalised entropy, colibri's (n * peak - 1) / (n - 1)), `rawNouls`, `confidenceUnknown`, and `used`, always false |
| `POST /jev-router/laya/settings` | any of `startWithKzh`, `keepLoaded`, `idleMinutes` (1 to 240), `device` (`auto`, `gpu` or `cpu`), `shadow` and `colibriUrl` (empty for off, or `http://` on 127.0.0.1, localhost or [::1] with its port) | the settings saved; a `colibriUrl` given is checked at once with colibri's test question |
| `POST /jev-router/laya/selftest` | `{}` | Test Laya's result: its fixed calls, run through Laya, which it starts if stopped |
| `POST /jev-router/laya/start` | `{}` | `{ ok }`: Laya started |
| `POST /jev-router/laya/stop` | `{}` | `{ ok }`: Laya stopped |
| `POST /jev-router/laya/restart` | `{ device }`, optional | `{ ok }`: Laya started again, on that device when one is named |
| `POST /jev-router/laya/install` | `{ device }`, `gpu` or `cpu` | `{ ok }` once the install has begun; follow it in `GET /jev-router/laya` |
| `POST /jev-router/laya/update` | `{ device }`, optional | `{ ok }` once begun |
| `POST /jev-router/laya/repair` | `{}` | `{ ok }` once begun |
| `POST /jev-router/laya/weights/check` | `{}` | `{ ok }` once begun: a check for a newer Laya model |
| `POST /jev-router/laya/weights/apply` | `{}` | `{ ok }` once begun: the newer model downloaded and put in place |
| `POST /jev-router/laya/install/cancel` | `{}` | `{ ok }`: the install going stopped |
| `POST /jev-router/laya/remove` | `{}` | `{ ok }` once Laya's folders are deleted; its records stay |

The install, update, repair, weights and remove routes answer 409 while another Laya install runs, and 400 when the harness's pins (`config\laya.json`) cannot be read.

### Capability benchmark

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/benchmark` | `?session=<chat id>`, optional | The Router tab's card: `what`, `note`, `taskSet`, `where` (the scratch workspace), `learn`, `agents` (each with `can`, `why`, `estimate`, `warnings` and `lastRun`), `run` (the run going) and `last` |
| `POST /jev-router/benchmark/plan` | `{ session, agents }` | `{ planId, confirm }`: what a run on those agents would spend, which the owner must see and confirm |
| `POST /jev-router/benchmark/start` | `{ session, agents, planId }` | `{ runId }`: the run begun, spending the agents' quota or money; 409 while one runs |
| `POST /jev-router/benchmark/stop` | `{}` | `{ ok }` |

### The rest

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /jev-router/names` | nothing | `{ providers, models, agents }`: the display name of each |
| `GET /jev-router/export` | `?session=<chat id>`, and `&tools=0` to leave tool calls out | `{ markdown, title, filename }`: the chat as Markdown, with keys redacted |
| `POST /jev-router/open-terminal` | `{ cwd }`, a project folder | `{ ok }`: the owner's terminal opened there |
| `GET /jev-router/logo.png` | nothing | the KzH logo, a PNG and the one answer that is not JSON |

## Logs and data files

Everything with state in it is under `~/.kzh`; the README's [Where things live](../README.md#where-things-live) says what each file holds.

| What | Where |
| --- | --- |
| Engine and launcher output | the app's start screen, or the `Start-KzH.cmd` console; neither the app nor `Start-KzH.ps1` writes it to a file |
| llama-server's log | `~/.kzh/jev-router/llama-server.log`, 5 MB, and the older `llama-server.log.1`: each start's command line and port, the load, ready, stop and exit, with the key taken out |
| Laya's logs | `~/.kzh/jev-router/laya/laya-serve.log` (5 MB, two kept), and `laya/install.log` |
| Speed runs | `~/.kzh/jev-router/speed-runs/speed-runs.log`, and `speed-run-<time>Z.log` for each run; the output check's baselines in `~/.kzh/jev-router/speed-baselines.json` |
| Runs | `history.jsonl` (each routed run, its task text, workspace, decision and answers) and `usage.jsonl` (tokens, cost and quota of each attempt and Jev call), in `~/.kzh/jev-router` |
| Background tasks | `tasks.jsonl`, and `live/<task key>.jsonl` for each task's saved transcript (with `transcripts` at `last20`, as shipped, a finished task further back than the newest 20 keeps none) |
| Settings | `accounts.json`, `agents.json`, `effort.json`, `chat-replies.json`, `live.json`, `hotkeys.json`, `local.json` and `laya.json` in `~/.kzh/jev-router`; the engine's are `~/.kzh/profiles/web/cordis.patch.yml` (the jev-router row, its `laya` and `local` blocks included) and `~/.kzh/settings.yaml` |
| colibri's Laya beside `laya.serve` | `colibri-laya.jsonl` in `~/.kzh/jev-router`, written only while the colibri Laya address is set: both answers to each request compared, and when colibri was found reachable or not; nothing learns from it |
| What KzH learned | `routing-samples.jsonl`, `capability-evidence.jsonl`, `classifiers/`, `domains/`, `known-resources.json`, `feedback.jsonl`, `reply-ledger.jsonl`, `reply-model.json`, `laya-samples.jsonl`, `laya-shadow.jsonl`, `laya-standing.jsonl` and `benchmark.jsonl`, in `~/.kzh/jev-router`; never delete them without the owner |
| The engine patches | `~/.kzh/kzh-engine-patches.json`, what `scripts\patch-agent-live.mjs` last did to each connector |
| Keys | `~/.kzh/.env`: never print it |
| Chats | `~/.kzh/sessions/<workspace>/<session>/session.v3.jsonl.zstd`, written by the engine |
| Local models | `C:\Harness\engine\llama` and `C:\Harness\models`, from the list in `config\local-models.json` |
| Laya | `C:\Harness\engine\laya` and `C:\Harness\models\laya`, at the versions `config\laya.json` pins |

```powershell
Get-Content "$env:USERPROFILE\.kzh\jev-router\llama-server.log" -Tail 50
Get-Content "$env:USERPROFILE\.kzh\jev-router\laya\laya-serve.log" -Tail 50
Get-Content "$env:USERPROFILE\.kzh\jev-router\speed-runs\speed-runs.log" -Tail 20
```

## Symptoms and what to do

| Symptom | What to do |
| --- | --- |
| `node` is missing or older than 22.19 | Ask, then have Node.js 24 installed from https://nodejs.org, and open a new PowerShell window. |
| A `.ps1` opens in Notepad | Run it with `powershell -ExecutionPolicy Bypass -File <script>`. |
| Start screen: another harness is already running | A `Start-KzH.cmd` console or a second Kz-harness is open: close the console, or quit the other Kz-harness from its tray icon, then click **Retry**. |
| Start screen: a Kz-harness engine is still running on port 3080, left behind by an app that is no longer open | Click **Use it here**, or stop it by hand (section 3) with the owner's yes. |
| Start screen: the harness page stopped or could not load | Only the page failed: **Retry** opens it again without restarting the engine. |
| `GET /jev-router/setup` shows an agent with `loggedIn: false` | Its `detail` says what to run, such as `claude` then `/login`, `codex login`, or which key is missing; the owner does it, then `GET /jev-router/setup?recheck`. |
| `GET /jev-router/setup` shows `jev.configured: false`, or a report says **JEV UNAVAILABLE** | The Jev key is missing, or TypeSafe cannot be reached: the owner adds `TYPESAFE_API_KEY` to `~/.kzh/.env` or a Jev key in Settings, then **Restart harness**. |
| A report says **OFFLINE: local models only** | Neither TypeSafe nor DeepSeek answered: check the connection. |
| Codex cannot read files, or "windows sandbox helper ... not found" | The helper comes with the Codex app, and `Start-KzH.ps1` puts it on `PATH`: the owner opens the Codex app once, then starts KzH again. |
| "all available agents are at their usage limits" | `GET /jev-router/usage` shows each agent's quota and reset time; the owner raises a limit in Usage or adds a key. |
| "Too many background tasks in this chat (10)" | `~/.kzh/profiles/web/cordis.patch.yml` has no `jobs` row yet: with the owner's yes and no task running, copy the `jobs` block from `C:\Harness\config\cordis.patch.yml` into it. |
| A local model shows `missing` or `corrupt` in `GET /jev-router/local` | It is not installed, or failed its SHA256 check: install it again (`POST /jev-router/local/install`, or `/install-llm` in the chat), with the owner's yes. |
| A local model will not start, or ran on the CPU | `GET /jev-router/local/log`, or the end of `llama-server.log`: it says each start's command line, the port, `offloaded N/N layers to GPU` and why it stopped; `modules[].overBudget` in `GET /jev-router/local` gives a refusal by the resource budget, word for word. |
| Laya's `state` is `failed` | `why` and `logTail` in `GET /jev-router/laya`, and `GET /jev-router/laya/log`. |
| Laya's `state` is `install_failed` | `install.error` in `GET /jev-router/laya` and `GET /jev-router/laya/log` say why; with the owner's yes, install again from the card or the Laya command line. |
| Laya's `state` is `disabled` | `configError`: the `laya` block of `cordis.patch.yml` is wrong, and the message says which field. `pinsError`: the harness's own `config\laya.json` cannot be read, which `Update-Harness.ps1` puts back. Neither: Laya is switched off. |
| The Laya command line says KzH is running | Quit KzH from its tray icon and run it again, or install from Settings → Jev setup → Laya decision model. |
| The speed run exits 3 | KzH, a llama-server, a Laya or another speed run is running: its line says which; quit KzH from its tray icon, or stop a left-behind process (section 3). |
| The speed run exits 2 | Its line says why; for a context it cannot read, pass `--context <tokens>`. |
| The Live tab shows no tool steps for Claude Code or Codex | `GET /jev-router/engine-patches` says why the patch is off; starting KzH again lets `Start-KzH.ps1` apply it again. |
| A header button, a sidebar tab or Jev Auto is missing | **Kz-harness → Restart harness**; if it is still missing, run the installer again. |
| `kzh-ui-test.mjs` says the DevTools endpoint is not reachable | The app is not running with a debug port: section 3, with the owner's yes. |
| A route answers 415 | The request had no `content-type: application/json`. |
| `npm test` ends with `# fail` above 0 | Run the failing file alone (`node --test test\<file>.test.js`) and read the first assertion; a test is changed only on purpose, never to make it pass. |
