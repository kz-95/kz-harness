# Docs index

One row per document: what it covers, and **when to reach for it**. Kind matters, because a
research note and a confirmed rule carry different weight and mixing them is how the wrong one
gets trusted. Update this index in the same change that adds, renames or removes a document.

| Document | Kind | Covers | Reach for it when |
| --- | --- | --- | --- |
| [handoff.md](handoff.md) | Living handoff | Current state, what is open and who it needs, what is verified live versus only built, root causes worth keeping, standing setup, gotchas | **Start here.** Picking the work up cold, or deciding what to do next |
| [adaptive-routing.md](adaptive-routing.md) | Reference, matches the code | How the router decides: the stages a decision goes through, the eight routing domains and their risk classes, provider quota adapters and the governor, capability as evidence rather than rules, the anonymous candidate table, the maturity ladder and every gate on it, drift, out-of-distribution and rollback, what is recorded, and what it does not do yet | Changing any routing threshold, adding a provider or a model family, reading the Router tab, or working out why a domain is not being trusted yet |
| [superpowers/specs/2026-09-21-jev-auto-ux-and-general-routing-design.md](superpowers/specs/2026-09-21-jev-auto-ux-and-general-routing-design.md) | Spec, build against it | The Jev Auto UX and the general routing design | Changing how routing chooses an agent, or how the Jev Auto model presents itself |
| [superpowers/plans/2026-09-21-jev-auto-foreground-and-routing.md](superpowers/plans/2026-09-21-jev-auto-foreground-and-routing.md) | Plan, a record of intent | The foreground and routing plan behind that spec | Asking why the spec is shaped the way it is, not what to build |

## Outside this repo

- **TypeSafe and Jev docs**: an offline snapshot lives at `~/.claude/docs/typesafe/`, covering Jev
  `jev-1.13.0`, Python SDK 0.7.0 and JS SDK 0.6.0, taken 21 Sep 2026. Read it locally rather than
  fetching `docs.typesafe.ai`. `QUICKREF.md` there is the whole contract in one page.
- **The DSH engine** is not vendored. It lives in the npx cache under
  `@deepseek-ai/dsh-*`, and its slot catalogue is inside
  `@deepseek-ai/dsh-cordis-client-runner/lib/client.js`. Anything read out of it is an internal of
  a package that ships without changelogs, so record the evidence here rather than relying on it.
- **Live dashboard**: `progress/progress.html`, a per-item record of what is verified, built,
  partial or open. It tracks the tree, so its percentage goes DOWN when a defect is found.

## Superseded, deliberately deleted

`handoff-2026-09-21.md` and `handoff-2026-09-21-pass2.md` were folded into `handoff.md` on
22 Sep 2026. Every open item was carried across and every closed item was re-checked against the
code first. Two same-day handoffs where one silently supersedes the other is the exact trap this
index exists to prevent.
