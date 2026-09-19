<p align="center"><img src="app/assets/logo-256.png" width="128" alt="Kz Harness logo"></p>

<h1 align="center">Kz Harness</h1>

<p align="center">One desktop app for Claude Code, Codex and DeepSeek. You type a task, <a href="https://docs.typesafe.ai/introduction">Jev</a> picks who does it, the project's own checks verify it, and Jev reviews the result.</p>

---

Kz Harness is a reskin and a set of plugins on top of [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH). It is shared as-is for anyone to use, fork, copy and change; see [License](#license).

```text
You type a task in the Kz Harness app ("Jev Auto" model, or /auto)
  -> jev-router: Jev picks one, in a single ~0.3 s call
       |-> Claude Code   (your Claude subscription)
       |-> Codex         (your ChatGPT subscription)
       |-> DeepSeek      (DeepSeek API key)
       |-> any API-key model you add (Settings -> Jev setup)
       |-> a tool script, when no LLM is needed
  -> the project's own checks: git diff + npm typecheck / lint / test / build
  -> jev-review: pass / second opinion / retry (tools escalate to an agent) / human
  -> report in the chat; every decision in the Jev inspector (right sidebar)
```

## What you get

- **Kz Harness app:** its own window and icon, a start screen, a colored log (Ctrl+Shift+L), and a tray icon. Closing it stops everything.
- **Jev Auto:** a model in the picker, and the default. Every message goes straight to the router, with no chat model in front of it. Live steps show in the thinking box.
- **Jev inspector** (right sidebar):
  - **Decisions:** timings, the pick and its reason, each step and its review, and every question Jev was asked with its probabilities.
  - **Subagents:** each helper run in the session, with Open.
  - **Background:** the session's background jobs.
- **Settings → Jev setup:**
  - Login check for each agent, with Recheck.
  - On/off switches; at least one LLM always stays on.
  - Add or remove your own API-key agents.
- **Tools without an LLM:** Jev can run a script of yours when that fully covers the task.
- **Safety rails:**
  - Checks that passed before must still pass.
  - Retries are capped.
  - A second opinion always comes from a different agent.
  - Agents never commit, push or deploy.
  - Keys never touch this repo.

## Install (new PC)

**You need:** Windows 10/11, [Node.js](https://nodejs.org) 22.19 or newer (24 recommended), [Git](https://git-scm.com), and at least one of:

| Agent | Install | Sign in |
|---|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | run `claude`, then `/login` |
| Codex | `npm i -g @openai/codex` (or the Codex app) | `codex login`, Sign in with ChatGPT |
| DeepSeek | nothing | an API key from https://platform.deepseek.com/api_keys |

Also get a Jev key from https://console.typesafe.ai/keys. Without it the harness still works; it just uses a fixed default agent and says so.

**1. Get the code.** The scripts assume `C:\Harness`:

```powershell
git clone git@github.com:kz-95/kz-harness.git C:\Harness
```

**2. Add your keys.** Create the file `C:\Users\<you>\.dsh\.env`. It must be in `.dsh`, never in the repo. Use exactly these names:

```
TYPESAFE_API_KEY="your TypeSafe key"
DEEPSEEK_API_KEY="your DeepSeek key"
```

**3. Run the installer.** It is safe to run again at any time; it only does what is missing:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Install-Harness.ps1
```

It checks your tools and installs the packages and the Electron app. It installs DeepSeek Harness with the Claude and Codex connectors, writes the harness settings (backing up anything it replaces), makes Jev Auto the default model, and creates **Kz Harness** shortcuts on the Desktop and in the Start menu. At the end it tells you which keys or CLIs are still missing.

**4. First start.**

1. Double-click **Kz Harness**. The start screen shows the log; after 10–20 s the harness opens in the same window.
2. If it says "Internal Testing Notice", click **Continue**.
3. Click **Settings → Jev setup**. Every agent you plan to use should show a green dot. A red dot says what to run; do it, then click **Recheck logins**.
4. Click **Choose workspace** and pick a project folder. `C:\HarnessProjects` is the default place for projects.

## Everyday use

1. Open **Kz Harness**.
2. Check the bottom of the text box: the model should read **Jev Auto** and the mode **Standard mode**.
3. Type the task and press Enter, for example `Fix the bug in the user lookup function and make sure the tests pass.`
4. Watch the steps in the thinking box, or open the log (Ctrl+Shift+L) or the Jev inspector.
5. Read the report. **Final status:** `ACCEPTED` means done. `NEEDS HUMAN` means look at it yourself. `STOPPED` means the retry limit was hit.

Choose the agent yourself with `/claude …`, `/codex …` or `/deepseek …`. Jev's pick is skipped; the checks and the review still run. `/auto …` lets Jev choose from any model.

Example report:

```text
Jev router · AUTO (Jev decided)
- Selected agent: codex (confidence 0.62; claude 0.21, codex 0.62, deepseek 0.17)
- Task type: debugging (confidence 0.88)
- Complexity 0.34 · Risk 0.28
- Baseline checks: typecheck pass, test FAIL
Attempts
1. codex (primary): completed in 48s
   Changed files: src/users.ts
   Checks: typecheck pass, test pass
   Assessment: quality 0.81 ≥ bar 0.70 (risk 0.28) → accept
Final status: ACCEPTED
```

## Updating

In the app: **Harness → Check for updates…**. It runs `scripts\Update-Harness.ps1`, streams the output into the log and restarts the harness. From a terminal:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Update-Harness.ps1            # pull code, refresh packages
powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Update-Harness.ps1 -BumpDsh   # also move to the newest DSH
```

- **Harness code:** pulled from git as a fast-forward only. With local changes, it tells you to commit or stash first.
- **DeepSeek Harness:** pinned in `Start-DSH.ps1`, because the plugins are tested against that version. A newer one is only reported; `-BumpDsh` switches to it and reinstalls the connectors. If that breaks startup, run `git checkout Start-DSH.ps1` to go back.
- **Claude Code and Codex** update themselves.

## How Jev decides

Jev is TypeSafe's System One model. It answers typed questions with calibrated probabilities and never writes code. The harness follows the [Jev docs](https://docs.typesafe.ai/introduction): all questions go in one call, each question is a single judgment, and the decisions are made in code.

**Before running:** one call, about 0.3 s. It asks:
- which agent should go first;
- the task type (12 kinds);
- complexity and risk, as described levels scaled to 0–1;
- whether a second opinion, a person, or passing tests are needed;
- for each configured tool, whether it fits the task exactly, and its arguments.

Context sent to Jev is small: the task, file-type counts, npm script and dependency names, changed file names and recent outcomes. Source files are never sent for routing.

**After each run:** one call over the diff, the check results and the agent's answer, with yes/no questions:
- **addressed:** did it do what was asked?
- **complete:** is anything left undone?
- **unrelated changes:** did it change things it wasn't asked to?
- **regression risk**
- **needs a person:** did it ask a question or report being blocked?

It also asks which agent should go next.

**The policy lives in code** (`plugins/jev-review/index.js`):

| Situation | Action |
|---|---|
| The agent failed, a check that passed now fails, or required checks fail | retry (never accepted) |
| "needs a person" ≥ 0.6 | human |
| quality ≥ the accept bar | accept. First a second opinion from a different agent if routing asked for one and code changed. |
| quality ≤ 0.3 | retry, with another agent |
| in between | second opinion, then human |

- **quality** is `min(addressed, complete, 1 − unrelated changes, 1 − regression risk)`.
- **The accept bar scales with the task's risk:** 0.55 below risk 0.25, 0.70 below 0.6, and 0.85 above that. A read-only question passes easily; a risky change has to earn it.
- **Limits:** 3 attempts, 2 reviews and 5 rounds in total. The Jev model is pinned to `jev-1.13.0`, so these thresholds keep their meaning.
- **Tools:** Jev runs a tool only if it picked that tool, the tool's "fits exactly" probability is at least 0.5, and its weakest argument answer is at least 0.5. If the review rejects the tool's output, the task goes to the routed agent.

## Configuration

Harness settings live in `~/.dsh/profiles/web/cordis.patch.yml`. The installer writes it from [`config/cordis.patch.yml`](config/cordis.patch.yml). Omitted fields use the defaults in `plugins/jev-router/index.js`. Edits reload live. A patch replaces a row's whole `config`, so restate every nested field you change.

```yaml
- insert:
    - id: jev-router
      name: 'C:/Harness/plugins/jev-router/index.js'
      config:
        fallbackAgent: claude
        limits: { maxAttempts: 3, maxReviews: 2, maxRounds: 5 }
        thresholds:
          accept: { low: 0.55, medium: 0.7, high: 0.85 }
          secondOpinion: 0.6
          humanReview: 0.7
          needsTests: 0.5
          tool: 0.5
        checks: { enabled: true, scripts: [typecheck, lint, test, build], timeoutMs: 600000, outputChars: 3000 }
        productionWorkspaces: ['C:\Work\production-app']   # Jev is told these are production-critical
```

**API-key agents** (OpenRouter, Kimi, Qwen, a local server):
1. Add the provider and key in **Settings → Models**.
2. In **Settings → Jev setup → Add an API-key agent**, pick the model and say what it is good at.

They are stored in `~/.dsh/jev-router/agents.json`, together with the on/off switches.

**More subagent agents:** add an entry to `agents` naming any installed DSH subagent provider. A `spawn` agent needs `llm: { provider, model }`; otherwise it would inherit Jev as its model.

**Tools (no LLM):** parameters are choices Jev fills in, and they arrive as `JEV_ARG_<NAME>`. The task text arrives on stdin, never in the environment, because `cmd.exe` would expand it into the command line.

```yaml
        tools:
          - id: run-tests
            description: Run the project's test suite and report the result, nothing else
            command: npm test
          - id: git-log
            description: Show recent commits
            command: git log --oneline -n %JEV_ARG_COUNT%
            params:
              count: { question: 'How many commits does the task ask for?', options: { '10': 'about ten or unspecified', '50': 'many or a longer history' } }
```

**auxModel** (default `deepseek-official` / `deepseek-flash`) is the real model that writes session titles and compacts long Jev Auto conversations.

## Where things live

| What | Where |
|---|---|
| Keys | `~/.dsh/.env` (Jev, DeepSeek). Claude and Codex logins stay in `~/.claude` and `~/.codex`. Nothing is in the repo. |
| Harness settings | `~/.dsh/profiles/web/cordis.patch.yml`, `~/.dsh/settings.yaml` |
| Agent switches and API-key agents | `~/.dsh/jev-router/agents.json` |
| Run history | `~/.dsh/jev-router/history.jsonl`, one line per task. The inspector's live view is in memory and empty after a restart. |
| Projects | `C:\HarnessProjects` by default. `jev-router-test` there is a safe practice project, if you have it. |

Permissions: Claude Code runs in `acceptEdits` mode. Codex runs in `approve-for-me` mode (workspace-write sandbox with Codex auto-review). Agents are told not to commit, push, deploy, publish or touch databases, and the router never does any of these.

## Troubleshooting

| You see | Do this |
|---|---|
| Start screen: another harness is already running | A `Start-DSH.cmd` window or a second Kz Harness is open. Close it, then click **Retry**. |
| Jev setup shows a red dot | Do what the line under it says, then click **Recheck logins**. |
| "no LLM agent is switched on and signed in" | Turn on or sign in to at least one agent in **Settings → Jev setup**. |
| Report says **JEV UNAVAILABLE** | `TYPESAFE_API_KEY` is missing from `~/.dsh/.env` or TypeSafe is unreachable (the reason is shown). Fix it and restart from the Harness menu. |
| Codex can't read files, or "windows sandbox helper … not found" | `~/.codex/config.toml` uses the elevated Windows sandbox, whose helper ships with the Codex app. `Start-DSH.ps1` adds it to PATH; open the Codex app once if the launcher warns it is missing. |
| Claude or Codex login expired | `claude` then `/login`; or `codex login`. Jev routes to other agents meanwhile. |
| `/claude` or `/codex` says the provider is not registered | Run the installer again. |
| **Jev Auto**, the inspector or Jev setup is missing | **Harness → Restart harness**. If still missing, run the installer again. |
| Node version error | Install Node 24; `node --version` should show v24. |
| Run stopped with "limit reached" | Read the attempts in the report; raise `limits` only if retries were making progress. |

Without the app: `Start-DSH.cmd` starts the harness in a console window and opens it in your browser.

## Project layout

| Path | What |
|---|---|
| `app/` | Electron desktop app. `main.js` starts and stops DSH and has the menus and updates. `preload.js` is a narrow bridge. `ui/` is the start screen and log window. `assets/` holds the icons. |
| `plugins/jev-router/` | DSH plugin: routing loop (`router.js`), Jev questions (`jev.js`), the Jev Auto model (`adapter.js`), login checks (`setup.js`), git and checks (`workspace.js`), and the browser half (`client.js`: inspector, setup page, brand). |
| `plugins/jev-review/` | DSH plugin: review policy and the `jevReview` service. It is a separate package because DSH refuses two plugins from one package. |
| `config/cordis.patch.yml` | Harness settings template used by the installer |
| `scripts/` | `Install-Harness.ps1`, `Update-Harness.ps1`, `Set-TypeSafeKey.ps1` (alternative to `.env`: stores the Jev key as a user environment variable) |
| `Start-DSH.ps1` / `.cmd` | Starts DSH. It pins the DSH version, checks the Jev key and finds the Codex sandbox helper. |
| `presets-legacy/` | The retired "Jev Auto" mode, for reference only. Its sessions had no file tools. |

Tests: `cd plugins\jev-router` then `npm test`. They cover the routing loop, review policy, tools, login gating, process handling and the Jev Auto model, using a throwaway git repo and fake Jev and agents.

## Open items

- The five routing scenarios (null bug, Redis/PostgreSQL design, diff review, three-file rename, auth race) against real agents.
- A first real tool, checking that Jev picks it for a matching task.

## License

[MIT No Attribution](LICENSE): anyone may use, copy, change, fork and share this, anywhere, with no conditions. Kz Harness is a sharing project: a reskin and plugins on top of other people's software. DeepSeek Harness, Claude Code, Codex, Jev, DeepSeek and Electron keep their own licenses and terms. The logo shows marks of Anthropic, OpenAI and DeepSeek, which belong to their owners; replace them if you redistribute the app.
