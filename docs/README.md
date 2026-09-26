# Docs index

One row per document: what it covers, and **when to reach for it**. Kind matters, because a
research note and a confirmed rule carry different weight and mixing them is how the wrong one
gets trusted. Update this index in the same change that adds, renames or removes a document.

| Document | Kind | Covers | Reach for it when |
| --- | --- | --- | --- |
| [handoff.md](handoff.md) | Living handoff | Current state, what is open and who it needs, what is verified live versus only built, root causes worth keeping, standing setup, gotchas | **Start here.** Picking the work up cold, or deciding what to do next |
| [roadmap.md](roadmap.md) | Design, build against it | What is still to build and why it is shaped that way: the one open item left in section 0 (get the branch into the app, rebuilding the exe only if `app/` changed, and watch one routed run), the resource budget as built and what each of its limits can honestly enforce, Laya as a second decision provider beside Jev, how the local classifier ladder should end, and the conservation deletion as done. Ends with what is decided, what is not, and who decides it | Picking up the next piece of work, or about to re-open a decision that was already made |
| [laya-auto.md](laya-auto.md) | Design, build against it | Laya as a local decision provider beside Jev, as the owner decided on 24 Sep 2026: the provider record that puts every Jev-calibrated cut-off per provider, the Laya Auto picker row where Laya alone decides on this PC with no Jev call, the background shadow in Jev Auto and how it is compared, the question adapter for Laya's known weaknesses, learning integrity (separate stores, Laya's standing, where the dumb arbiter will sit), the `laya.serve` sidecar with its install, weights, supervision and resource budget, the Settings card with exact strings, the tests, and a build plan in parallel groups | Building any part of Laya Auto or the shadow, changing a provider threshold, or testing Jev and Laya together on the desktop |
| [benchmark.md](benchmark.md) | Design, build against it | The benchmark the owner decided on 25 Sep 2026, in two parts. B1: each installed local model loaded through the ordinary start at the context its runs get, timed with llama-server's own timings, the tokens per second kept in `local.json` beside the memory readings, and shown as measured in the install picker and the Local models card, with what the run does to the loaded model, its refusals and cancel. B2: a fixed task set of 27 small Node tasks in nine skills, each with checks the agent never sees and a reference solution, run on the agents the person picks through `runRouted` with the agent forced, in a scratch workspace, scored into `benchmark` rows of `capability-evidence.jsonl`, behind a confirmation that says what it spends. Then privacy, the tests, what is not built, and a two-step build plan | Building B1 or B2, changing a benchmark task, reading a benchmark score on the Router tab, or deciding what a benchmark row may claim |
| [adaptive-routing.md](adaptive-routing.md) | Reference, matches the code | How the router decides: the stages a decision goes through, the seven routing domains and their risk classes, provider quota adapters and the governor, capability as evidence rather than rules, the anonymous candidate table, the maturity ladder and every gate on it, drift, out-of-distribution and rollback, what is recorded, and what it does not do yet | Changing any routing threshold, adding a provider or a model family, reading the Router tab, or working out why a domain is not being trusted yet |
| [superpowers/specs/2026-09-21-jev-auto-ux-and-general-routing-design.md](superpowers/specs/2026-09-21-jev-auto-ux-and-general-routing-design.md) | Spec, **superseded in part** | The Jev Auto UX: foreground and background work, delivery, task states, the effort ladder, transcript controls. Its routing half was superseded on 24 Sep and says so at the top | The UX half of Jev Auto. **Not** for routing: that is `adaptive-routing.md`, and building the routing half from here would re-add a question that was deliberately removed |
| [superpowers/plans/2026-09-21-jev-auto-foreground-and-routing.md](superpowers/plans/2026-09-21-jev-auto-foreground-and-routing.md) | Plan, a record of intent | The foreground and routing plan behind that spec | Asking why the spec is shaped the way it is, not what to build |

## Outside this repo

- **TypeSafe and Jev docs**: an offline snapshot lives at `~/.claude/docs/typesafe/`, covering Jev
  `jev-1.13.0`, Python SDK 0.7.0 and JS SDK 0.6.0, taken 21 Sep 2026. Read it locally rather than
  fetching `docs.typesafe.ai`. `QUICKREF.md` there is the whole contract in one page.
- **The DSH engine** is not vendored. It lives in the npx cache under
  `@deepseek-ai/dsh-*`, and its slot catalogue is inside
  `@deepseek-ai/dsh-cordis-client-runner/lib/client.js`. Anything read out of it is an internal of
  a package that ships without changelogs, so record the evidence here rather than relying on it.

## Superseded, deliberately deleted

`progress/progress.html` was deleted on 24 Sep 2026. It was a hand-maintained dashboard of
what was verified, built or open, pinned to a commit that no longer exists on a branch that was
merged, with a hardcoded test count and about sixty line references into files that have since
been rewritten twice. Everything in it that was still true lives in `handoff.md` and
`roadmap.md`, which are generated from the code rather than kept by hand. A second source of
truth that drifts is worse than one source, because it is believed.

`handoff-2026-09-21.md` and `handoff-2026-09-21-pass2.md` were folded into `handoff.md` on
22 Sep 2026. Every open item was carried across and every closed item was re-checked against the
code first. Two same-day handoffs where one silently supersedes the other is the exact trap this
index exists to prevent.
