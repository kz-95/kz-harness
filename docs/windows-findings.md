# Windows findings on `feat/benchmark`

Kind: **work order**. A list of defects with their evidence, each one verified on the owner's
Windows machine on 26 Sep 2026. Delete this file once they are fixed; it describes a moment, not
a design.

Branch: `feat/benchmark`, which stacks on `feat/laya-auto`, which stacks on `fix/roadmap-open-items`.
All three branch from `main` and none is merged.

Suite on Windows: **1330 tests, 1309 pass, 21 fail**. On Linux the same tree is green.

---

## Read this before fixing anything

**This branch has never run on Windows.** Not "was not tested carefully" — literally never
executed. `test/doc-queue.test.js` and `test/speed-run.test.js` both die at module load on a bare
drive-letter path, so between them not one test in either file has ever run on the target OS. The
CRLF-regex failures below are a repeat of commit `d56c19e`, which fixed exactly that class of bug
in September, and a single Windows run would have caught every one of them.

**A Linux session cannot verify most of these fixes.** That is the trap this document exists to
close. Of the 22 findings, 15 fail *only* on Windows, so a cloud session can write the fix, see
green, and have proved nothing. For each finding below there is a **Check on Linux** line giving a
way to test the fix without Windows — usually by asserting on the platform-dependent input rather
than on the platform. Where no such check exists it says so, and that finding has to be verified
on the owner's machine before the branch merges.

Nothing here needed anything installed. Every Laya, `uv` and torch test uses fakes and passed with
no Python present, so "it needs Laya running" is not an explanation for any failure in this list.

---

## C — real defects, four of them

### C1. The graded agent receives the owner's account name

`benchmark.js:224`, `gradeEnv()`.

The function passes five variables — `PATH`, `SystemRoot`, `TEMP`, `TMP`, `BENCH_WORKSPACE` — and
`test/benchmark.test.js:219` asserts that is all the child sees. On Windows it is not. libuv adds
eight more to any child that does not set them, so the graded process gets thirteen.

Measured on the owner's machine, spawning with exactly those five:

```
child sees 13 keys: BENCH_WORKSPACE HOMEDRIVE HOMEPATH LOGONSERVER PATH SYSTEMDRIVE
                    SystemRoot TEMP TMP USERDOMAIN USERNAME USERPROFILE WINDIR
USERNAME in child: fghfh
```

So the agent's graded code can read `USERNAME`, `USERPROFILE` and `HOMEPATH`. The documented
five-variable promise is false, and the comment asserting it is worse than the leak because it
stops anyone looking.

**Fix (small, about five lines):** set `USERNAME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`,
`LOGONSERVER`, `USERDOMAIN`, `SYSTEMDRIVE` and `WINDIR` to `''` in `gradeEnv`. An empty string
suppresses them; omitting them does not.

**Still open after that fix, and it is a decision, not a patch:** `TEMP` and `PATH` are kept
deliberately and both contain `C:\Users\fghfh` on a normal Windows install. Either point `TEMP` at
the benchmark's own scratch root, or accept it and change the claim in the comment and the test to
say what is actually true.

**Check on Linux:** assert the behaviour, not the platform. Spawn a child with the five variables
and assert the key set equals the five plus whatever the platform adds, with a hardcoded expected
list per platform — so the Windows list is written down and reviewable even where it cannot run.
A test that just asserts `USERNAME` is absent passes vacuously on Linux and proves nothing.

### C2. Every retry nests the harness's own handoff note inside itself

`router.js:1133-1136`, with the wrap at `router.js:528`.

`saveHandoff(since)` decides whether a note was written by an agent by checking
`mtimeMs >= since - 1000`, where `since` is the start of *this* attempt. When an attempt takes
longer than about a second — which is nearly always — the harness re-runs `harnessHandoff`, sees
its own previous note as agent-written, and wraps it under `## Earlier note`. The
`slice(0, 2000)` clip then pushes the genuine earlier note out of the file entirely.

**This is not a Windows bug.** Linux CI was simply fast enough for the one-second window to hold.
It is real-world data loss on every platform, in the feature the project relies on for continuity
between agents.

**Fix (needs thought):** track what the harness itself last wrote and compare against that, rather
than inferring authorship from a one-second clock heuristic. A recorded hash or a marker line in
the note is enough; the clock never will be, because the thing it is racing is the agent's own
runtime.

**Check on Linux:** yes, fully. Make the attempt take two seconds and assert the note is not
nested. The bug reproduces anywhere once the timing is forced, which is also why it should have a
regression test that does not depend on how fast the machine is.

### C3. A rename without the retry the rest of the repo uses

`local.js:1083`, and the same bare `rename` at `local.js:127`.

Observed on Windows as `EPERM: rename 'local.json.tmp' -> 'local.json'`, surfaced to the person as
`Could not load Big again: EPERM…`. A virus scanner or any open handle causes it.

`laya-install.js:190-196` and `training.js` already retry `EPERM`, `EACCES` and `EBUSY` for exactly
this reason. This is the one place that does not.

**Fix (small):** reuse the existing retry helper at both sites.

**Check on Linux:** partly. Inject a `rename` that throws `EPERM` once and assert it retries and
succeeds. That proves the retry, not the underlying Windows condition, which is fine — the retry
is the whole fix.

### C4. A path printed raw where every other path is normalised

`scripts/red-check.mjs:316` prints `f.rel` directly; lines 82, 225-235 and 359 all go through
`gitPath()`. On Windows the report reads `plug\test\fixtures.test.js` in among forward-slash paths.

**Fix:** one line. **Check on Linux:** no, and it does not matter; it is cosmetic and obvious on
inspection.

---

## A — test bugs, eighteen of them

None of these indicate anything wrong with the production code. All are the test encoding a
Linux assumption.

### Never load at all — do these first

| Where | What | Fix |
| --- | --- | --- |
| `test/doc-queue.test.js:12` | `await import(fileURLToPath(...))` with a bare `C:\…` path. `ERR_UNSUPPORTED_ESM_URL_SCHEME`, the file never loads | pass the `URL` or its `.href` |
| `test/speed-run.test.js:18` | same | same |

Until these two load, neither file has run on Windows even once, and nothing either of them claims
to verify is verified there.

### CRLF, the repeat of `d56c19e`

The note from that commit, worth restating because it keeps costing: `.` does not match `\r`, so
`.*\n` never matches on a CRLF checkout, and a `$`-anchored regex never matches a line that ends
`…\r`.

| Where | What | Fix |
| --- | --- | --- |
| `test/benchmark.test.js:130` | `text.replace(/\n/g, '\r\n')` on an already-CRLF checkout produces `\r\r\n`. `taskSetDigest` (`benchmark.js:79-86`) normalises correctly | `/\r?\n/g` |
| `test/laya-install.test.js:672` | `lock.split('\n')` then `endsWith('\\')`; CRLF leaves `\r` last | strip `\r` |
| `test/tasks.test.js:390` | source-text regex with `\n` against a CRLF file | `\r?\n` |
| `test/tasks.test.js:410` | `$`-anchored regex, captured line ends `…\r`. Precisely `d56c19e`'s bug | `\r?$` or `[^\r\n]*` |

### Windows paths

| Where | What | Fix |
| --- | --- | --- |
| `test/laya-integration.test.js:365` | `bytesUnder` does `l.split(':')[0]` on `"C:\path:size:mtime"`, so it opens `…\C` | split from the right, or use a separator a path cannot contain |
| `test/laya-sidecar.test.js:686`, `:1050` | hardcoded `models/laya/hf`; `laya-install.js:161` deliberately emits `models\laya\hf` on win32 | one shared fix, compare normalised |

### Platform-specific process handling

| Where | What | Fix |
| --- | --- | --- |
| `test/laya-integration.test.js:971-972` | the `run` stub implements only the `ps` branch, but `processInfo` (`laya-sidecar.js:115-117`) uses `powershell.exe Get-CimInstance` on win32, so the orphan is never recognised. **Production code is right** | stub both branches |
| `test/fixtures/fake-llama-server.mjs:36-37` | the fake child sets `exitCode` only on `child.kill()`, but `local.js:1298-1301` uses `killTree` → `taskkill` on win32, which cannot touch a fake pid. Three engine-lifecycle invariants (failures 15, 17, 18) are therefore **unverified on Windows** | make the fake respond to the win32 path too |

Worth taking while in there, and not a test bug: **`local.js:1299` calls `killTree` on win32 with
no fallback.** If `taskkill` returns non-zero the engine is never stopped and
`child.kill('SIGKILL')` is never tried. One line.

### Timing and hermeticity

| Where | What | Fix |
| --- | --- | --- |
| `test/benchmark.test.js:212` | Node 24 (this machine runs v24.18) hangs a never-resolving test instead of reporting `# cancelled 1`, so the grade falls through to its timeout text. A Node-version assumption, not a Windows one. Costs 68 s of every suite run | one line |
| `test/benchmark.test.js:927` | negative control: `mkdtempSync(tmpdir())` on Windows lands under `C:\Users\fghfh\`, so the "path does not hold the account name" case cannot exist. **The production detector at `benchmark.js:1002-1007` is correct**, and the default scratch root is `C:\kzh-scratch` with no username in it | build the negative case from a path the test controls, not from `tmpdir()` |
| `test/laya-integration.test.js:519` | not hermetic: local models are read from the real `C:\Harness\models` (`index.js:58`, `931`, `954`) rather than the test's `harnessDir` seam. This machine has `gemma-4-E4B` installed, so routing picked `gemma-local` over the expected `qwen-local` | route model discovery through the existing seam. **Needs thought**, and it is the one A-bucket item that points at a missing seam in production rather than at the test |
| `test/laya-integration.test.js:582` | a race between two start bounds; got `Laya was still starting after 0 s` where it expected `laya.serve was not ready after 0 s` | **Needs thought**; timing-fragile either way |

---

## What to do, in order

1. `doc-queue.test.js:12` and `speed-run.test.js:18`. Until they load, the rest is guesswork.
2. **C2**, the nested handoff note. It is the only finding here that loses data, and it loses it on
   every platform, today, in normal use.
3. **C1**, the environment leak, plus the `TEMP`/`PATH` decision that the fix leaves open.
4. **C3** and the `killTree` fallback beside it.
5. The CRLF and path one-liners, as one commit.
6. The three needs-thought items: the integration test's model seam, the start-bound race, the
   fake server's win32 kill path.
7. **C4** last, or never.

## Before this merges to `main`

The suite must run on the owner's Windows machine and report 0 failures. A green Linux run is not
evidence for 15 of these 22 findings, which is the whole reason they survived to be found here.
Whoever fixes them on Linux should expect a second round after the first Windows run, and should
say plainly in the pull request which fixes they were able to verify and which they were not.
