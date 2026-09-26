# Adaptive routing

How KzH decides who does a piece of work, how it learns to decide that itself, and what it refuses to
decide either way.
This is the reference for the routing architecture.
For what a user sees, read the README; for what is open right now, read `handoff.md`.

## The shape of it

A request goes through the same stages every time.

```
your request
  -> task profile            what this needs: type, complexity, risk, which capabilities, how much
  -> hard eligibility        who could possibly do it: available, capable, allowed, big enough
  -> resource choice         which of those should, given what they cost and how scarce they are
  -> conservation limit      a hard limit in code, not a domain: easy work kept off a scarce strongest resource
  -> execution strategy      one resource, or plan then implement, or implement then review
  -> the work                agents run, deterministic checks run
  -> outcome                 pass, retry, second opinion, frontier review, or a person
  -> what it taught          capability evidence, and a label for every decision above
```

Each judgment in those stages belongs to a **routing domain**, and each domain answers its own question about who is allowed to make it: Jev, a rule in code, the local classifier, or a deterministic fallback.
In a run Laya decides (Laya Auto, [`laya-auto.md`](laya-auto.md)) the question has a fifth answer, `laya`: see [A second decider: Laya](#a-second-decider-laya).
The hard eligibility and the conservation limit are not judgments, and belong to no domain.
The domains mature separately, so task classification can be handled locally while the execution strategy is still asking Jev.

Two domains never ask Jev at all: resource selection and frontier escalation.
They are decided in **code** (`teacher: 'code'` in `routing-policy.js` `DOMAINS`), and carry `authority: 'code'` rather than `jev` or `local`.
Each is a comparison of numbers, and a snap-judgment classifier cannot compare magnitudes; asking one to would be several judgments in a single question besides.
`rankCandidates()` in `broker.js` ranks the candidates.
The frontier review is a rule that reads the task's risk against the `minimumReview` cuts, with the probabilities in `policy.codeJudgments.frontierReview`, the only code judgment left.
It says yes at or above `riskForFrontierReview`, and at or above `riskForReview` when the task wants frontier capability: a minimum or preferred tier of `frontier`, or a `security_review` requirement of 0.5 or more (`decision.js` `frontierProbability`).
The domain controller (`domains.js` `createDomainController`) holds a `teacher: 'code'` domain to code authority and ignores any teacher call a caller passes, and its `state()` reports `teacher: 'code'` or `teacher: 'jev'`.
`resolvePolicy` refuses a teacher other than `jev` or `code` (`routing policy: domain <id>: teacher must be jev or code`), and refuses to change the teacher a shipped domain has (`routing policy: domain <id>: teacher cannot be changed; it is code`, or `jev`).

The resource ranking is never outranked.
`resource_selection` has `localDecides: false` in `DOMAINS`, so its local classifier never decides, at any rung.
The controller holds a domain to that whatever a caller passes: `decide()`'s `localMayDecide` can narrow a classifier's authority, never widen it.
`decision.js` also passes `localMayDecide: false`, and takes the pick from `rankCandidates()` directly rather than from the controller's answer.
The classifier still climbs the ladder, so its standing stays measured.
Its answer is recorded on the sample (`local`) and as `local` in `routing.decision.domains.resource_selection`, and the sample is stored under authority `code`.
The per-decision view in the inspector does not render that local answer, because its shadow line needs a teacher answer to compare against.
`resolvePolicy` refuses a domain `localDecides` that is not `true` or `false`, and refuses to switch it on for a domain that ships with it off: `routing.domains.resource_selection.localDecides: true` stops start-up with `routing policy: domain resource_selection: localDecides cannot be switched on; its local classifier never decides`.
A policy may set `localDecides: false` on another domain, to take its classifier's authority away.
The frontier review's classifier has no such bar: it may decide once it has earned a local rung, and a rule in code decides wherever it does not.

A domain decided in code still has a ladder and still collects samples, because an outcome can
contradict a rule as readily as it can contradict a judgment. What it does not collect is
agreement: a run that goes as planned under `code` teaches the local classifier nothing, for the
same reason it teaches it nothing under the classifier's own authority - a rule confirming itself
is not evidence. So those domains train on rescues, negative outcomes and a person's `good pick`
tag alone.

| Domain | Decides | Risk class |
| --- | --- | --- |
| `task_classification` | What kind of work this is, and what it needs | LOW |
| `skill_selection` | Which skill the work mainly calls for: how it is done, never who does it | LOW |
| `resource_selection` | Which resource does the work | MEDIUM |
| `execution_strategy` | How the work is organised across resources | MEDIUM |
| `second_opinion` | Whether an independent review is worth its cost | MEDIUM |
| `frontier_escalation` | Whether the strongest resource must review | HIGH |
| `outcome_disposition` | What happens after an attempt | HIGH |

The skill is handed to the router in the plan as `plan.skill` (`{ primary, supporting, description, authority }`), always in the `SKILLS` vocabulary of `routing-policy.js`; a task type that is not a skill name is mapped through `TASK_SKILLS`.
`router.js` gives it to whoever does the work: `skillLine` puts `Approach this mainly as <primary> work (<description>). It also draws on <supporting>.` straight after the Workspace line of the worker's prompt (`basePrompt`, so a retry gets it too) and into the plan step's prompt (`planPrompt`).
The run record keeps it as `plan.skill`, and the report prints `- Skill: <primary> (+ <supporting>)`.
The review prompt does not get it.
The plan the router makes itself when no decision engine planned the run (a forced agent, offline, routing switched off, or an engine that failed) has no skill, and then the worker is told nothing about one rather than an invented one.
An answer outside the `SKILLS` vocabulary is replaced by the task type's own skill, and `plan.skill.authority` becomes `fallback`.
The report's `- Skill:` line then shows the skill the run really used, and its `Decided by` line shows `skill_selection fallback`.
The raw answer is kept only in the run record, as `mappedFrom` on `plan.skill` and on `routing.decision.domains.skill_selection`; neither the report nor the inspector shows it.
That sample is left out of the samples the run labels (`routing.decision.samples`), and a verdict given later about the run relabels only the samples in that list, so nothing ever labels it.

Conservation is not a domain.
It is a hard limit in `decision.js`, beside the weekly gate and the capability floor, applied after the resource ranking and before the strategy.
It acts when all of these hold: the most capable candidate is not local, has a marginal cost (not `none`), and its governor conservation level (`governor.js` `conservationHint`) is not `healthy`, which means its scarcity is at or above the curve's first knee, 0.2, with unknown usage counted as healthy; the task is easy enough to move off, with complexity under 0.5 and risk under `minimumReview.riskForReview`; and another candidate whose KNOWN capability tier meets the task's floor exists.
The work then goes to the ranking's own pick if that candidate qualifies, and otherwise to the best of the rest by the ranking's probability, then the one with the lower expected cost, then by id.
The limit has no probability, no 0.5 threshold, no domain, no sample and no label, and `decision.judgments` has no `conserve`.
The conserved resource leaves the work pool and stays available to review, the same way the weekly gate moves work.
The run records it in `routing.conservedFrom`, in `routing.decision.conservation` as `{ from, to, confidence: 1, authority: 'code' }`, as the excluded reason `conserved for harder work: kept for review only`, and as the plan note `<from> conserved for harder work: <to> does it, <from> stays available to review`.
When the limit moves the ranking's own pick, `routing.agentConfidence` is 1, `routing.decision.domains.resource_selection.movedBy` is `conservation`, and the pick's sample is not labelled by that run, because the run tested a different resource.
A `domains/conservation.state.json`, a `classifiers/conservation.json` or conservation samples left by an older version are ignored at start-up, and never trained or labelled.
The router does not hand the work back: its low-confidence tie-break, the feedback re-read (a Like or a `should have been` suggestion) and the weekly-gate swap all pass over `routing.conservedFrom`, and the report says `Work kept off <id> to conserve it for harder work; it stays available to review`.
The capability swap is the one exception: a capability is a hard fact and conservation a spending limit, so when nothing else can do what Jev named, the conserved resource takes the work.
A retry after a failed attempt is not barred from the conserved resource.

The second-opinion and frontier-escalation answers are labelled only where the answer could change the run.
A frontier-escalation answer can, and is labelled, when the plan has no frontier review of its own, the capability floor does not add one anyway, a reviewer exists, and the run reviews at all (an answer-only run never does); only then does a yes add the review.
A second-opinion answer can when nothing else reviews the run: not on an answer-only run, and not when the plan already promises a review.
With a decision record, the second-opinion domain's own yes or no is what `jev-review` acts on, the same answer the run labels, whether or not files changed, so a yes asks for a review of any accepted work result (a primary or retry attempt).
On a tool attempt a yes does not lead to a review of the tool's result: the router sends every tool result that is neither accepted nor handed to a person on to the worker agent, which does the task again as a primary attempt, and that agent's result, once accepted, is the one reviewed.
`thresholds.secondOpinion` and the changed-code condition apply only to a run without a decision record (routing switched off, a legacy route).
A review asked for while the plan promises one (the second-opinion answer, or a quality between the bars) goes to the reviewer the plan named, so a planned frontier reviewer is never replaced by another one.

A strategy's primary step stays as the plan wrote it unless it names an agent a router swap moved the work off (the capability swap, the tie-break, the weekly gate, feedback) or fails a check the pick itself had to pass: enabled, in the pick pool, able to do the capability Jev named, and not past its weekly gate; then it follows the pick.
So `LOCAL_FIRST` keeps its local step when only the resource behind it is swapped, and cannot keep a local model on a job such as `web_research` that it cannot do.
When a failed attempt must move to a different resource, a single retry agent the review named comes first, then Jev's retry ranking; the strategy's hand-over order comes before that ranking only when the strategy put someone other than the routed pick in the primary step (`LOCAL_FIRST`) or Jev gave no ranking.
That hand-over order starts with the routed resource itself when the strategy put someone else in front of it, because `LOCAL_FIRST` promises exactly that ("the local model goes first; the routed resource takes over on failure"), then follows `plan.fallbackOrder`.
It skips any agent a router swap moved the work off (the order was written before the swap) and any agent that fails the checks the pick had to pass, and of the agents that already worked it skips only those that did the work (a primary or retry attempt); a planner or a parallel second opinion has not.
Every move the router makes of its own before the work starts is recorded in `routing.moves` as `{ kind, from, to }`, in the order made (`capability`, `tiebreak`, `gate`, `feedback`), next to the field each move also sets: `capabilityFrom`, `tiebrokeFrom`, `gatedFrom` or `feedbackFrom`.
A retry or a hand-over after a failed attempt is not added to `routing.moves`; it shows as an entry in the record's `attempts`, with its agent and its role.
The report and the inspector name each move with its own target, so after a capability swap and then a gate swap neither reads as a move to the final pick, and the tie-break, which the report used to leave out, is named too.
A record from before `moves` was kept is read from its `capabilityFrom`, `tiebrokeFrom`, `gatedFrom` and `feedbackFrom` fields.

Every one of those moves - the capability swap, the tie-break, the weekly-gate swap, the feedback re-read, the retry, the hand-over - goes only to an agent that can do what the run needs: the attached input, write access when it changes files, and the capability Jev named.
A capability is a hard fact, so it outranks both the conservation limit (a spending limit) and the weekly gate (a cost rule).
The weekly gate is the operator's cost policy, not unavailability: gated agents are still counted as able to do the work, the router keeps them out of the work pool, and the gate yields - visibly, as `routing.gateYielded` and a report line - only when nothing ungated can do the job, or every agent is past its gate.
The decision engine sees a gated resource that could do the work, so its frontier-floor exception (`gateOverride`) can fire in a real install, and the router honours that override rather than swapping the work back off it.

The risk class sets how much evidence a domain needs before it decides anything alone.
The promotion, calibration, drift and rollback thresholds live in `plugins/jev-router/routing-policy.js` and can be changed from config.
A few numbers are fixed in code rather than policy: the conservation curve's knees (scarcity 0.2 and 0.7), the conservation limit's complexity cut (0.5), the reset-discount exponent, the per-source usage confidences in `resources.js`, the 45-day window for an unpinned model version, and the feedback prior's weight, window and other-task-type share in `router.js`.

## What is a fact and what is a judgment

This split is the spine of the design and it is enforced in code, not in a prompt.

**Facts, decided in code, never delegated.**
A resource that is signed out, at its limit, switched off, or not allowed is removed before any judgment happens.
The disabled and allowed lists (`routing.disabledResources`, `routing.allowedResources`) are applied to the router's own pool, so no router-side swap, fallback or retry can bring an excluded resource back, and they apply whether or not adaptive routing is on.
So is one whose context window is known and cannot hold the request, and one whose capability tier on the dimensions the task requires is known to be below the floor the task asks for.
An unknown tier is not excluded: unknown is not the same as insufficient.
When nothing meets the floor, nothing is excluded for it, and the run goes ahead.
The strongest resource that cleared the hard facts, other than the one doing the work, is then made to review.
When no other resource cleared them, nobody reviews, and an answer-only run is never reviewed.
When every candidate fails a hard fact, the run stops with the list of who was excluded and why (`NO_CANDIDATES`), rather than falling back to one of the resources it just excluded.
A resource the disabled or allowed list rules out is also unavailable in the capability registry (`router.js` `unavailableIds`), so its capabilities are neither offered to Jev nor counted by the "nothing here can do this request" guard: when only such a resource could do what Jev named, the run refuses instead of going ahead on one that cannot.
The run stops with `every agent is excluded by the routing policy` only when the policy alone emptied the pool; when another reason also played a part (a usage limit, a sign-in, local-only), that reason's message is given instead, with the earliest reset time when it is a usage limit.
A failing required check is a fact: no classifier can accept work the tests reject.
Keeping easy work off a most capable resource whose allowance is being used up is a limit in code too, not a judgment: the conservation limit above.

**Judgments, which is what the domains learn.**
What kind of work this is, and which skill it mainly calls for.
How the work is organised across resources.
Whether a review earns its cost.
Whether the strongest resource should look at the result before it is accepted.

A classifier that has earned local authority makes judgments.
It never gets to make a fact.

## Resources, and what their providers actually mean

Providers do not agree about anything.
One reports rolling windows as a percentage, another a monetary balance, a third nothing at all.
So quota semantics live in a **provider adapter** (`resources.js`), and each adapter turns its provider's own reporting into one normalised snapshot without flattening what it meant.

A limit carries its own `kind`: `rolling_window`, `fixed_window`, `token_budget`, `request_budget`,
`monetary_budget`, `credit_budget` or `provider_defined`, and a `scope`: `account`, `plan`, `model`, `model_group` or `feature`.
It says what was used, what is left, when it resets and how long the window is, and it says where
the figure came from and how much to trust it: `provider_api`, `provider_cli`, `local_cache`,
`local_observation`, `estimate`, `manual` or `unknown`.
When one limit mixes a measured figure with figures worked out from it, the optional `fieldSources` map gives `used`, `remaining`, `total` or `ratioUsed` a source and confidence of their own; a figure with no entry takes the limit's.
Readers ask `provenanceOf(limit, field)` for a figure's provenance, and `snapshotResources` writes `fieldSources: null` on every limit that has none.
A derived figure's confidence is the measured figure's confidence times its source's trust (`local_observation` 0.6, `estimate` 0.4), and a stale reading discounts `fieldSources` by the same factor as the limit.

`validateLimit` rejects a limit that could not be true: an unknown kind, scope or source, a ratio outside 0..1, a negative `used`, a `total` or `durationMinutes` of zero or less, `rolling: false` on a `rolling_window` or `rolling: true` on a `fixed_window`, and a malformed `fieldSources`.
`remaining` may be negative, because an overdrawn balance is a real reading.

What the shipped adapters actually produce:

| Adapter | Matches | Limits |
| --- | --- | --- |
| `anthropic-subscription` | provider `claude-code` | `rolling_window` per window, scope `account`, from the OAuth usage endpoint (`provider_api`) or the statusline cache (`local_cache`) |
| `openai-subscription` | provider `codex` | `rolling_window` per window, scope `account`, from the CLI (`provider_cli`); also the plan name |
| `deepseek-api` | `llm.provider` `deepseek` or `deepseek-official` | one `monetary_budget`, scope `account` |
| `local-model` | a local agent | none: nothing to conserve |
| `generic-api` | any other agent | none: a metered key nothing is known about |

For the DeepSeek balance only `remaining` is the provider's word (`provider_api`, 0.95, or 0.3 when the last refresh failed).
Its `total` is the highest balance this machine has seen the key hold (`local_observation`), and `used` and `ratioUsed` are worked out from that mark (`estimate`).
No shipped adapter produces a `fixed_window`, `token_budget`, `request_budget`, `credit_budget` or `provider_defined` limit, or any scope other than `account`.
Those kinds and scopes are validated and round-trip through `snapshotResources`, so a new adapter can use them, but the governor gives them only the generic reading below and ignores scope entirely.

Unknown is never invented.
No usage data means no limits, confidence zero, and a scarcity of `null` that reads as unknown
everywhere downstream; the expected job cost counts an unknown scarcity as zero, at confidence zero.
A reading older than the staleness window keeps its numbers and loses confidence.

The **governor** (`governor.js`) turns a snapshot into pressure.
Any limit with a `ratioUsed` is read by that share, discounted when its reset is close.
The binding limit is the one under the most pressure once the reset is taken into account, and the
reset discount is cubed rather than linear, because a weekly window three days from its reset is not
half as pressing as one about to roll over: only a reset that is genuinely close should discount
much.
A `monetary_budget` with a measured balance is also read against the soft and hard floors the router applies (`handoffAtBalance`, `minBalance`), and that measured reading is the floor of the pressure, whatever the confidences are.
A share spent can only raise it: one that reads lower is ignored, and one that reads higher stands on its own when it is at least as trusted as the balance, and otherwise (the DeepSeek estimate) is blended in by the two confidences, so it counts only as far as it is trusted (`governor.js` `limitPressure`).
So a guess can make a shortage look worse, never better, in pressure and in the scarcity the router acts on alike: a balance of 7.5 whose highest seen balance was 8 reads exactly as scarce as the same balance measured by the floors alone, at any staleness.
The floors themselves read continuously, for every floor setting.
With the soft floor above the hard one, pressure runs from 1 at the hard floor to 0.7 at the soft floor, and above it eases from 0.7 to nothing at `budgetSoftMultiple` times the soft floor, so a cent either side of the soft floor reads the same.
With no band (the soft floor at, under or missing from the hard floor), it eases from 1 at the hard floor to nothing at `budgetSoftMultiple` times it.
Floors of 0 and 0 mean no floor: an empty balance reads 1, and any balance above it gives no floor reading, so the share spent speaks, or the scarcity reads as unknown.
A limit of any other kind without a `ratioUsed` gives no pressure, which reads as unknown.
The scarcity's confidence is the confidence of the reading it rests on, not the limit's raw figure.
Pressure becomes scarcity through the conservation curve for that plan, so a plan that conserves
earlier can be configured to do so without any of it being a rule about a named provider.
A plan the provider does not report and `resources.plans` does not name uses the default curve (from 60% to 85% used).

Expected job cost is what routing actually compares:

```
execution   = marginal cost by funding type + scarcity
retry       = how likely this resource is to fail here, times what a retry costs
review      = what the task's risk says a review is worth
escalation  = failure probability times risk
```

Retry is execution times the failure probability times `retryWeight`, escalation is that failure probability times risk, and review does not depend on the resource at all (`governor.js` `expectedJobCost`).
The failure probability comes from the candidate's reliability and its fit for the task, so between two candidates of equal reliability and fit retry is a fixed multiple of execution, escalation is a constant, and the total orders exactly as execution does.
With the default weights a subscription (marginal 0.3) stops looking cheaper than an unpressured metered key (0.6) at scarcity 0.3.
On the default curve that is 65% of the binding limit used, on `pro` and `plus` 60%, on `max` and `team` 74% (reset-discounted, so a little later in raw use when the reset is near).
That is early in the conservation band and well before its aggressive knee, which is what makes subscription-first stop short of subscription-wasteful.

## Capability, as evidence rather than rules

There are no rules of the form "architecture goes to X" anywhere in this codebase, and adding one
would be a regression.
Instead, every subject has a profile of scores per capability dimension, and routing compares
what the task requires against what each resource is believed to be good at.

Belief can come from three places, combined as a precision-weighted mean rather than a plain average:

1. **Priors**, in `config/capability-priors.json`.
   These are the owner's observations, stated as machine-readable numbers with their own confidence.
   They are evidence, not rules: they seed a family's profile and real evidence overtakes them.
2. **Benchmark evidence**, weighed at a reliability of 0.7 with a 180-day half-life.
   Its producer is the capability benchmark in the Router tab ([`benchmark.md`](benchmark.md) section 3), which writes, for every agent that finishes all its tasks, one row per task and credited dimension, score 1 or 0, confidence 0.9.
   Each row's `n` is 3 over the number of the set's tasks that credit its dimension, so a whole run weighs on a dimension as three observations at reliability 0.7, 1.89 when fresh.
   A task that does not fit the window KzH gives a local model is not run and gives no row, not even a `long_context` one, so such a run weighs less on the dimensions those tasks credit ([`benchmark.md`](benchmark.md) 3.9).
   The rows are not runs: they are left out of `samples`, and so out of `evidenceSamples`, the ranking's `evidenceRuns` and the Router tab's observations, and reported as the dimension's `benchmark` summary, `{ score, tasks, passed, weight }`.
   A benchmark row with a `runId` counts only when that `runId` is the newest recorded for its subject and benchmark id, by file order, also after a reload; older rows stay on file and count in `explain()`'s `notCounted`.
   The 180-day half-life and the 45-day window for unpinned names apply, and a benchmark alone leaves a model cold.
   Nothing writes a `benchmark_prior`: no importer brings in published benchmarks.
3. **Execution evidence** from real runs here: did the work get accepted, did the checks pass, did a
   reviewer agree.
   A person's Like or Dislike counts here too, as `human_outcome` evidence recorded when the verdict is given: `POST /jev-router/feedback` stores it and hands it to `index.js` `onVerdict`, while a run's end records the run's own evidence and no verdict (`runEvidence`), because nobody can judge an answer before it exists.
   Every routed reply ends with an invisible `[jev-run]: kzh-run-1-<runId>` link definition (`index.js` `withRunMark`), and the client reads it off the answer and posts it with every verdict as `runId`, so a verdict is credited to exactly the run its answer came from.
   Without a run id (a reply from before the mark), the run is the one an earlier form of the same verdict was credited to, else the last run of its session that had ended when the answer was FIRST judged: every form of a verdict is dated by its first (`effectiveVerdicts`, reading every row through `feedback.js` `history`), so a tag changed or a reason edited after a newer run ended still lands on the answer the person was looking at.
   One verdict counts once: its newest recording replaces every older row with the same verdict key, whatever the dimension, and clearing it, or re-tagging it `too slow`, appends a retraction line to `capability-evidence.jsonl`.
   A verdict keeps what it counted only when it is re-posted unchanged (the same like or dislike, the same tag, the same answerer and run), the registry still counts that form, and either learning is off or the agent that gave the judged answer is no longer configured (a custom agent deleted, a local model uninstalled).
   A clear, a changed verdict or tag, or a `too slow` tag always retracts, whatever the configuration, and removing an unrelated agent (a reviewer) never blocks it.
   Evidence for a past run uses the model each attempt recorded: an attempt that recorded none (a CLI on its own default) is keyed with no model and is never re-keyed to a model configured since, and an edited `llm.model` does not move past runs either.
   The same step relabels the run's routing samples in the two domains that read human feedback, task classification and skill selection: every sample carries the `runId` of the run that wrote it, so a "misread my question" given after the run ended reaches the label the run end could not know about.
   With `routing.learn` false every verdict is still stored, marked `learningOff`, and a clear or a changed verdict still takes back the evidence and the human routing label the earlier form gave; only new credit and new labels wait for learning to be on.
   A label recomputed while learning is off reads only the verdicts that were learnt from, never one given while learning was off.

Each piece of evidence is weighted by how trustworthy its source is, how sure it was, how many
observations it carries, how old it is and how close its task type is to the one being asked about.
Three consequences fall out of that arithmetic, and each has a test:

- A couple of good runs cannot overturn hundreds of observations.
- Real evidence eventually overtakes any prior, however confident the prior was.
- A dimension nobody has observed stays unknown at zero confidence and is never invented.

Confidence is how much evidence there is and how well it agrees: `(1 - exp(-precision / confidenceScale)) * agreement`, where agreement is `1 - 2 * spread / sqrt(precision)` clamped to 0..1 and spread is the weighted spread of the evidence scores, prior excluded.
Unanimous evidence has agreement exactly 1, and ten runs split evenly between excellent and terrible are reported as less certain than ten that agree.

A subject is keyed `provider|model|version`, where the version is the one the attempt recorded, else the one reported now for a run that ended in the last 10 minutes, else the model name.
The only real version today is a local model's: its manifest SHA-256, checked at install, which `index.js` `localVersionOf` gives every profile reader and writer (run evidence, verdicts, the decision engine, the Router tab) and `execute` stamps on each local attempt as `modelVersion`.
Nothing else reports one: Claude Code and Codex give only the `model` their own config file names (often an alias such as `opus`), and an API agent only its configured `llm.model`.
The router keeps a `modelVersion` on any attempt whose executor returns `modelVersion` or `model`, and never invents one; no cloud or subscription executor returns either yet.
A past run is never credited to a version reported later: without a recorded `modelVersion` it is keyed by its recorded model name, and with no recorded model by none.
A version counts as pinned only when it is a dated snapshot id or a content digest, so a local model is pinned and the others are not, unless their configured name is itself a dated snapshot.
For an unpinned subject only the last 45 days of evidence count, so a new version released silently behind an unchanged alias does inherit the old version's record, for at most that long.
A pinned version under a new key starts cold with only its family prior, and a newly released model can overtake an older favourite without a line of routing code changing.
Recent verified failures pull a score down even when the lifetime record is strong.

### Resources are anonymous in the candidate table

The local classifier and the review call see candidates as `RESOURCE_A`, `RESOURCE_B` and so on, each with its capability scores, tier, scarcity, cost class, latency, reliability and how many verified runs stand behind its profile.
Jev sees that table only in the review call, where the reviewer and the fixer are picked over it.
No routing call carries candidate data: the ranking is code's, and the strategy question is offered only strategies the pool can run, so it has nothing about the candidates to read.
The table itself never carries a provider or model name.
This is enforced where the candidate list is built, not by scrubbing afterwards, and tests fail if a provider name reaches the table or any per-resource channel of the call that carries it.

No adaptive routing call carries `recent_outcomes`, `first_resource`, `candidate_availability` or `candidate_track_record`, and nothing in one is re-keyed to `RESOURCE_x`: those calls have no per-resource channel at all.
`jev.js` `route()` reads the history, the availability and the track record only for the legacy named question, and reads no id-to-key mapping.
Re-keying happens only in the review call: its attempts name a `resource` key (a tool attempt keeps its `tool:<id>`, because a tool is not an anonymous resource), and the reviewer and fixer are chosen over the anonymous candidate data.
Free text in the review call's identity channels (an executor's diagnostic, and the reason a resource is outside the work table) is masked: a specific name becomes that resource's key when exactly one candidate owns it, and `[resource]` otherwise, and a vendor or family word (`claude`, `gpt`, `qwen`, `grok`, `glm`, `kimi` and the like) that is not one candidate's own name becomes `[resource]` too.
A vendor or family word followed by a version (`qwen2.5`, `llama3`, `gpt4o`, `gpt-4o`, `claude3`) is masked whole, and a word that merely begins with those letters (`gptext`, `llamas`) is left alone.
A point release after any name is a longer version, not that name, and is masked whole as `[resource]`: `gpt-5.6` with only `gpt-5` configured, `grok-2.1` with `grok-2`, `o3.1`, `claude.2`.
The names that count are specific ones only (`features.js` `identityNames`): the agent's id, its display name, its `provider` and `llm.provider`, and its model ids.
So a provider word that names one agent (`claude-code`, `openrouter`) reads as that agent's key, and one several agents share reads `[resource]`.
Generic words are refused as names even when a caller passes them: the task types, tiers, skills, strategies, cost tiers such as `local` and `free-local`, words such as `spawn`, `agent` and `model`, and short all-letter words (`ab`, `ok`).
A short model id is a name: `o3`, `o1` and `r1` mix letters and digits, and are masked like any other.
A model setting is often an alias rather than an id (`best`, `default`, `opus`, `sonnet`), so a model string counts as a name only when it is shaped like an id, with a digit or a separator (`features.js` `modelIdOf`); `best` as a name would be masked inside every reason that says "the best fit", and the brand words among the aliases are masked anyway, as brand terms.
The review call applies that rule to the configured `llm.model`, to the model a CLI agent really runs by its own config (`modelOf`), and to the model each attempt recorded, so an agent that ran and was removed from config since is still masked.
In the review call a resource outside the work table carries why it is out and whether that was a hard fact, as `kept_out_by`: `hard_fact`, `policy_or_judgment` (the weekly gate, the capability floor, the conservation limit), `not_offered_for_this_request` (the router never offered it to the engine), or `unrecorded` for a record from before the engine kept its exclusions, which claims no reason.
One that cleared the hard facts but does not do the work (past its gate, under the floor, conserved) also carries the numbers it would be judged on, from `decision.reviewOnly`, under the key the decision engine assigned it over the pool of this run, before the floor, the gate and conservation narrowed that pool.
No routing call shows any key, so the review call is the only call in which Jev sees one.
Object keys are never touched.
Every string value is masked, including one in a field that looks categorical: a category the router wrote (a cost tier, a task type, an outcome) cannot be a name, so masking leaves it as it was, while a `status` or `source` inside an executor's diagnostic, which the router does not define, is exactly where a name would otherwise ride out.
A tool attempt keeps its `tool:<id>`, because a tool is not an anonymous resource, and the review prompt says so.

What the calls do not anonymise is the work itself: the task text, the workspace facts (branch, changed file names, dependency names), the folder's handoff note (a note the harness wrote lists earlier attempts by agent id), and in the review call the latest answer, the diff and the check output.
Key-shaped strings in them are masked before any cut the router makes on the way to Jev, with one exception: a configured tool's output (`index.js` `runTool`) is cut first and scrubbed after.
Nothing in them is anonymised; the README's privacy section lists every cut.
So Jev never sees a name in the table, but it can see one wherever the work or the handoff note mentions it.
With `routing.enabled: false` none of this applies: Jev picks named agents from their descriptions, with the history, availability and track record keyed by agent id.
The default descriptions say only which CLI or API each agent runs and how it is paid for, and a local agent's say only which model it is, that it runs on this PC through llama.cpp, and that it is free, private and works offline, so on default config the legacy pick has little but cost and the track record to tell agents apart; write your own descriptions if you route that way.
A description can reach Jev under adaptive routing too, on a run with no decision record (a forced agent, or a run whose decision engine failed and fell back): there the review and retry picks are made over the named agents and their descriptions.

It matters for two reasons.
A judgment made from brand is a judgment made from prejudice.
And a classifier trained on classes named after today's models is worthless the day the models
change, whereas one trained on candidate characteristics keeps working.

The keys are positional: `RESOURCE_x` is assigned by sorted id over the pool of this run, so adding a resource whose id sorts earlier, or one being unavailable for a run, shifts the keys of the others.
Nothing that matters depends on the key staying put: the ranker scores each candidate by its features, and the familiar-candidate check (`candidateSamples`) counts resources by their stable id, in code, so a new resource that inherits an old key is still flagged unfamiliar.

### Where a provider name still decides something

Quota semantics live in the adapters, and the only kind of work a provider name decides is work with an image attached.
Three name checks outside the adapters still shape routing.
`accounts.js` `kindOf` says a `claude-code` or `codex` agent is a subscription, and `index.js` stamps that billing `kind` on every agent.
When an agent fails mid-task, `usage.js` `detectLimit` checks the failure for a limit hit with the pattern for its provider (`claude-code` or `codex`, and the API pattern for any other agent), and the default peer to hand over to is by agent id (`claude` and `codex`), overridable with an agent's own `peer`.
`index.js` `agentSeesImages` counts every `claude-code` or `codex` agent as able to take an image, and any other agent only when the catalog entry for its `llm` model declares image input, so a provider name decides which agents stay eligible when an image is attached.
The cost readers below read the billing kind and never test a provider name.
Provider names also set how an attempt runs, not who runs it: `effort.js` `effortFamily` reads the provider (`claude-code`, `codex`, or an `llm.provider` of `deepseek` or `deepseek-official`) to turn the effort level into the value each executor takes, `router.js` passes the speed setting only to a `codex` agent, and `index.js` `modelOf` reads a `claude-code` or `codex` agent's model from that CLI's own config.
A candidate with no resource snapshot takes its funding `source` from its kind, and its marginal cost from the snapshot, then `resources.economics.<id>.marginalCost`, then the kind (`decision.js`).
The executor registry's cost class, which orders the capability-swap target, comes from the kind and the same override (`capabilities.js` `executorsFrom`).
The router's low-confidence tie-break decides by marginal cost (the run's decision record, then `resources.economics`, then the kind).
`index.js` passes the override to the decision engine and to `executorsFrom`, so it reaches every one of those readers, not only the ones that go through a resource snapshot.
The `cost_tier` in the track record Jev reads follows the same override (`none` reads `free-local`, or `free` for an agent that is not local, `low` reads `subscription`, `metered` reads `api`), then the billing kind (`router.js` `trackRecord`).

### The feedback bias

A person's Like and Dislike move the pick a little after the decision engine has answered, in the `router.js` block that opens with the comment `// The feedback prior, applied.`, through `feedbackPrior`.
The bias reads verdicts from every session and every workspace, and `verdictWeight` weights each by how well the task type of the run it judged matches the task being routed: 1 for the same `routing.taskType`, 0.25 (`FEEDBACK_OTHER_TYPE`) for any other.
Related types are not told apart, and the 0.25 is a fixed copy of `evidence.similarity.other` that install config does not move.
The run a verdict judged is found by `index.js` `runOfVerdict`: the `runId` the client sends; else the run the capability registry credited the verdict to (`creditedRun`); else the newest run of the verdict's session that ended at or before the answer was first judged.
An edited verdict is dated by its first judgment (`effectiveVerdicts`), the same way its capability evidence and labels are.
A verdict whose kind of work cannot be told (no run found, a manual-pick run with no `taskType`, or no task type for the task at hand) counts by session alone: fully in its own session, and not at all from another.
The window is 20 verdicts' worth of weight, newest first: at full weight that is still the newest 20 rows, a verdict about another task type takes a quarter of a place, and a row that weighs nothing is skipped before the window is counted.
The bias moves a probability by at most 0.15 either way, ramped over 3 verdicts.
It applies only to a run whose `routing.mode` is `jev`: never to a forced agent, a **Jev Auto · Local** run, an offline run or a fallback.
The counts and typed reasons that ride the legacy named call's track record, and the `suggestedAgent` correction that can switch a pick outright, still come only from this session.

## How a domain earns the right to decide

```
JEV_PRIMARY -> SHADOW -> GUARDED_LOCAL -> LOCAL_ONLY
```

One rung at a time, never skipped.

- **JEV_PRIMARY.** Jev decides.
  The local classifier may train but controls nothing.
- **SHADOW.** Jev still decides.
  The local classifier predicts alongside it and both answers are recorded, so its agreement can be measured before it is trusted.
- **GUARDED_LOCAL.** The local classifier decides cases it is confident about and that look like what it was trained on.
  Everything else goes to Jev.
- **LOCAL_ONLY.** The local classifier decides normal cases with no Jev call at all; an unconfident or unfamiliar case still goes to Jev.

For the two domains a rule in code decides, the rule stands wherever Jev would, and the resource ranking's classifier never decides at any rung.

`ROLLBACK` is also a defined maturity value, but with the default policy nothing puts a domain in it: a rollback moves the domain straight to a lower rung and marks it with the reason, the severity and when it happened.

To reach SHADOW a domain needs its verified samples and a trained classifier.
To climb past it, a domain must pass every gate for the rung, at its risk class:

- enough **verified** samples, where verified means the run produced evidence about whether the
  decision was right, not merely that a decision was made;
- **accuracy** on a time-ordered holdout the classifier never trained on, and separately on the
  recent window: the newest rows after its training slice (found by sample id), up to `recentWindow`;
  a rung needs at least the smaller of `recentWindow` and the share of its own sample gate a
  time-aware split leaves unseen (30% of it at the default 0.7 train split), so an old good record
  cannot carry a currently bad classifier, the published sample gate is the real one, and rows the
  classifier cannot learn from cannot stand in for rows it can;
- **macro F1** and recall on every significant class, so strong aggregate accuracy cannot hide a rare but important
  class being handled badly;
- **calibration**: expected calibration error under a ceiling (the artifact's training-time figure), and a cap on how often it is wrong
  while claiming high confidence;
- **no meaningful drift** between what it was trained on and the recent rows it did not train on;
- **no pending regression**: nothing the rollback check would act on at the target rung (a recent accuracy or calibration breach, a retry, escalation or failure rate well over its baseline), and for LOCAL_ONLY an out-of-distribution rate over `oodRateDegrade`;
  the rates count towards the first local rung too, although the teacher made the decisions behind them, on purpose: a domain promoted into a spike would start the rung one window from losing it;
- and for LOCAL_ONLY, enough holdout samples, enough samples of every significant class, and **label quality**: enough of the evidence must come from a run or a person
  rather than from the teacher agreeing with itself.

That last gate is the one that stops the router learning to copy Jev's mistakes.
A label of `teacher_confirmed` means the pick the run acted on went on to be accepted: Jev's pick, or the local classifier's when it had authority at GUARDED_LOCAL or LOCAL_ONLY.
It is useful and trained on at a reduced weight, but it is not independent evidence, and a domain cannot reach LOCAL_ONLY on it.
Once a row has an outcome, the outcome is the truth: a refuted answer (`verified_negative`, or a person tagging it `misread my question` or `wrong scope`) is never trained or scored as the teacher's label.

## What pulls the privilege back

**Out of distribution.** A category the classifier never saw, a candidate it has barely ranked, a
numeric feature far outside its training range in both sigmas and absolute terms, high entropy or a
thin margin between the top two answers.
In GUARDED_LOCAL that hands the decision to Jev.
In LOCAL_ONLY a significant one also steps the domain down to GUARDED_LOCAL, because an unfamiliar routing space is
not something to keep deciding alone.

**Drift.** PSI per numeric feature and Jensen-Shannon divergence per categorical, against the
histogram the classifier was actually trained on.
Two guards keep this honest: a feature with almost no spread is skipped, because PSI over a
near-constant feature is noise, and a window with too few observations is not read at all.

**Regression.** Recent accuracy under its floor, calibration error over its ceiling on the recent
window (rows the classifier fitted neither its weights nor its temperature on), or retry,
escalation and failure rates well above their own baselines.
Accuracy and calibration count only over as many recent rows as the rung is judged on: fewer is not a measurement, so a short window (an artifact trained before its training slice was marked has one right after the upgrade) is never read as a regression.
A recent accuracy more than `rollback.severeAccuracyGap` (0.05) under its floor acts at once, as a severe rollback.
Every other breach needs `rollback.consecutiveWindows` (2) consecutive windows and is a significant rollback: a smaller accuracy miss, a calibration breach, or a retry, escalation or failure rate breach, however large.
A window is an evaluation with verified rows newer than the last window counted, so evaluating the same rows again is not a second window, good or bad.
A bad window counted at the rung the domain holds blocks promotion until a clean window clears it or a second one rolls the domain back, whatever the next rung's own reading says; that rung reads calibration over a larger window, where a breach counted over the smaller one might not show.
Stepping down from a local rung, for any reason, settles the bad windows: one bad window before a critical failure does not follow the domain back up and make the first bad window at the re-earned rung "sustained".

The destination depends on severity.
Minor (drift or out-of-distribution in LOCAL_ONLY) goes down one rung, significant to SHADOW, severe or critical to JEV_PRIMARY.
A rolled-back domain keeps collecting evidence, and must show new evidence gathered since the rollback, over consecutive good
windows, before it gets a rung back.
That applies to every severity, critical included, and to every rung up to the one it lost: each needs `repromoteSamples` new rows since the rollback or since the rung below it was re-earned, over `repromotion.consecutiveWindows` windows, on top of its own gates.
The rollback record (reason, severity, `recoverTo`) stays until the domain is back on the rung it lost; a critical rollback is the longest way back only because it starts from JEV_PRIMARY.
Each domain's saved state carries `stateVersion` (3 today).
A state saved before version 2 has its rollback point re-anchored at the first evaluation after the upgrade, so the rows that caused the rollback never count towards undoing it, while a current state keeps its point across restarts.
A state older than 3 with an open rollback owes every rung up to LOCAL_ONLY and restarts its window count, and a bad-window count saved at a rung that decides nothing is dropped.

**A changed world.** A new resource narrows the domains that rank resources (today only `resource_selection`) from LOCAL_ONLY to GUARDED_LOCAL, and leaves the others
alone: adding a coding model must not reset a mature task classifier.
The ids already seen are kept in `known-resources.json`, so adding an agent to config and restarting counts as new.
On the first start without that file, and only when stored resource samples show routing has happened, the set is rebuilt from the candidate ids in those samples plus every agent id `history.jsonl` names as the pick, an attempt, gated, out or near its limit (`index.js` `createResourceTracker`).
The seed also reads the candidates and exclusions each history record keeps (`routing.decision.candidates`, `routing.decision.excluded`), so an agent that was only ever excluded or passed over is not announced as new.
A classifier artifact that fails its checksum, or was trained on a different feature schema, is not
loaded at all, and a domain that was deciding locally drops to JEV_PRIMARY.

## The classifier itself

Deliberately small: a multinomial logistic regression over standardised features for the
multiclass domains, and a logistic scorer over candidate features for resource selection, which is a
ranking problem.
Ranking matters, because a classifier whose output classes were fixed model names could not survive
a resource being added.

Training is deterministic: weights start at zero, full-batch gradient descent, no random
initialisation, so the same data gives the same artifact.
Confidence is calibrated by temperature scaling on a validation slice, because an uncalibrated
probability is not something to gate a routing decision on.
The split is time-aware, oldest to train, newest held out, so no later outcome can leak into a
decision the classifier is being judged on.

Every artifact carries its domain, its version, its feature schema version, sample count, calibration metrics, the distribution it supports, where its training and calibration slices end (`trainedThrough`, `calibratedThrough`, by sample id), and a checksum over all of it.
The calibration metrics (temperature, ECE, Brier score, high-confidence error rate and a reliability table) are measured on the validation slice, or on the training slice when there is no validation slice.
The artifact's `validation` field is always null: holdout accuracy, balanced accuracy and macro F1 are measured at every evaluation and kept in the domain state (`lastEvaluation`), not in the artifact.
An artifact that does not verify is not loaded.

A domain retrains after `everyNewSamples` new verified rows since its artifact was trained.
At GUARDED_LOCAL or LOCAL_ONLY a retrained classifier is a challenger: it goes into service only after passing the gates of the rung the domain holds.
One that fails is not put into service, the classifier in service keeps deciding (the rollback checks keep measuring it every window), the rejection is recorded in `state.challenger` with the rung and the gates it failed, and it is not retried until `everyNewSamples` more rows arrive.
With no classifier in service to keep, the domain steps down to SHADOW.

## What is recorded, and what is not

Recorded, in `~/.kzh/jev-router/` (the folder of `historyFile`):

| File | What |
| --- | --- |
| `routing-samples.jsonl` | One row per routing decision: the feature vectors, the candidates' keys, agent ids and features, the teacher's answer, the local classifier's answer, who was authoritative. Then an outcome row when the run proves something. Capped per domain (below). |
| `capability-evidence.jsonl` | One row per piece of capability evidence: subject (provider, model, version), dimension, score, source, confidence, task type, and for a verdict its session and message ids, its run and the batch it was recorded in; plus a retraction line when a verdict is cleared or stops saying anything about capability. |
| `classifiers/` | The trained artifacts, one per domain, plus the previous one. |
| `domains/` | Each domain's maturity state. |
| `known-resources.json` | The agent ids the resource domains have already seen. |
| `history.jsonl` | One row per routed run, written by the router, not by the learning store: the **task text as typed**, the workspace's absolute path, the routing context (branch, up to 30 uncommitted file paths, file-type counts, script and dependency names), the routing decision, each attempt's error diagnostic and changed file paths, and the **first 1000 characters of each attempt's answer**. |
| `tasks.jsonl` | The last 100 background tasks: the **task text** again, and the finished **report**, clipped to 20,000 characters, which includes up to 4000 characters of the answer and the changed file names. |
| `feedback.jsonl` | Each Like or Dislike, its tag, the reason the person typed, the answer's agent and model, the run it came from (`runId`), and `learningOff` when it was given with learning off. |
| `usage.jsonl` | One row per agent attempt and per answered Jev or Laya call (`agent: 'laya'`, at $0): ids, the workspace path, tokens, cost and quota. A direct answer's row names the row's `decider`. |
| `laya-samples.jsonl` | One row per domain decision of a run Laya decided, in the same shape as `routing-samples.jsonl` with `teacher: null` and Laya's answer as `provider`, then its outcome rows. Same cap and compaction. No classifier reads it. |
| `laya-shadow.jsonl` | One row per Jev call in Jev Auto that Laya answered beside Jev, or was skipped for: both sides' answers as numbers and option keys (a tool parameter's as its index), the call's timings and why a comparison was skipped. Newest 10,000 rows. |
| `laya-standing.jsonl` | Laya's standing per domain, appended at most once a minute after a run: a reading, never an authority. |

Nothing redacts a key out of `history.jsonl`, `tasks.jsonl` or `feedback.jsonl`: a key pasted into a task or a reason is stored there as typed.

The learning store (`routing-samples.jsonl`, `capability-evidence.jsonl`, `classifiers/`, `domains/`, `known-resources.json`) holds no prompt, answer, diff, check output, file content or key.
Its rows hold ids, numbers, categories and timestamps.
The task text is not stored there either, but it is not absent from the sample the way the others are:
a bag-of-words classifier needs the words, so what is written down is unigram and bigram counts
hashed into 2048 anonymous buckets (`hashedText` in `features.js`).
That is a one-way map from many different words onto the same bucket number, so the sentence
cannot be read back out of it, and it is worth being exact about rather than calling it nothing.
There are tests that write a marker string into a task, its answer, a diagnostic and a feedback reason and fail if it
appears in the routing samples or the capability evidence.

`routing-samples.jsonl` is capped per domain at `samplesCap(policy)` (`training.js`).
Each domain keeps its newest cap samples and its newest cap verified samples, each with its newest outcome row; newest is by `ts`, then by place in the file.
With the shipped gates the cap is 10000: HIGH needs 6000 samples for LOCAL_ONLY, a holdout of 1200 at a 15% holdout share needs 8000 rows, and 8000 x 1.25 is 10000.
The cap follows the resolved config, so raising `routing.gates` raises it.
When `routing.split` has a holdout share of 0 the validation share carves the holdout (a split of 0.8/0.2/0 gives 7500), and a split with neither counts only `localOnlySamples`; the cap is always finite.
The file is compacted once it holds `slack` rows past what the cap keeps, and the slack defaults to the cap; the check runs on load and after every `slack` appended rows.
Compaction writes a temporary file, fsyncs it and renames it over the file, trying the rename up to 7 times in all while it fails with `EPERM`, `EACCES` or `EBUSY`.
A rename that still fails leaves the file untouched and logs `[jev] routing samples not compacted: ...`.
A file that exists but cannot be read (any error but `ENOENT`) is never rewritten, and `[jev] routing samples not read: ...` is logged.
Once the cap has let anything go, a compacted file starts with a row `{"dropped": {<domain>: {"samples": n, "verified": n}}}` holding running totals of what it let go of; the store reads it back through the synchronous `dropped(domain)`, and `GET /jev-router/routing` reports it as `training.dropped`.
Every domain evaluation, and the state's `samples`, carries `samples.seen`: the verified rows held plus the verified rows the cap let go of.
The counts of what arrived since something are all taken on `seen`: `sinceRollback`, `sinceArtifact`, the retrain trigger (`everyNewSamples`), the rollback point, the good and bad window counts, `challenger.verified`, and the artifact's `extras.verifiedSamples` and `trainingDataVersion`.
`samples.verified` still counts the rows held, and the sample gates read it.
Domain state files need no migration: `stateVersion` stays 3.
With a split whose holdout share is 0, every row the training slice leaves goes to validation (`domains.js` `splitRows`); flooring both shares used to leave one row over as a one-row holdout slice that the holdout gate was scored on.

What goes to Jev changed with this work in three ways.
The task call asks more (the requirement dimensions, skills, the minimum and preferred tier, verification), and it is the only routing call that carries the workspace facts and the handoff note.
A second call asks how to organise the work and whether a second opinion is worth it, and carries only `task`, plus the task profile's numbers (`task_profile`) when it asks the strategy question, since the task group is never asked in the same call.
A judgments-only call carries `task` alone.
The strategy question reads ``How should the work for `task` be organised?``, and its options are exactly the strategies `decision.js` passes from `broker.js` `eligibleStrategies()`; a call given fewer than two asks no strategy question.
When the task classification and skill selection domains have both matured locally there is no task call, and this is the only call.
And the per-agent maps the old named routing call carried (`recent_outcomes`, `agent_availability`, `agent_track_record`) ride no call under adaptive routing: only the review call names resources, and only by key.
The README's privacy section is the full account.

## Configuration

Everything is under the `routing` and `resources` blocks of the plugin config, and everything omitted keeps the
default in `routing-policy.js`.

```yaml
- id: jev-router
  config:
    routing:
      enabled: true          # false: Jev routes every task over named agents, the way it did before
      learn: true            # false: no samples, no local authority; Jev and the rules in code decide
      disabledResources: []  # never pick these (agent ids)
      allowedResources: []   # when set, pick only these
      gates:
        MEDIUM:
          guardedSamples: 1500
          guarded: { accuracy: 0.96, maxEce: 0.04 }
      governor:
        conservation:
          plans:
            pro: { startAt: 0.55, aggressiveAt: 0.8 }
            max: { startAt: 0.7, aggressiveAt: 0.9 }
    resources:
      plans: { claude: max }   # agent id -> plan, for a provider that does not report its plan
```

The `routing` values shown are the defaults; `resources.plans` is empty by default, so a Claude plan is unknown until it is named there.
The schema passes the `gates`, `governor`, `retrain` and `drift` blocks through as free-form objects and `resolvePolicy` merges them over the defaults, so a misspelt key inside them is accepted and does nothing; check a change against `routing-policy.js`.
`minimumReview` takes `riskForReview` (default 0.6) and `riskForFrontierReview` (default 0.8).
They are the deterministic fallback for the second-opinion judgment when neither Jev nor a trusted local classifier answers, and the rule that decides the frontier review wherever its local classifier does not.
`riskForFrontierReview` also decides when the fallback strategy is `CHEAP_EXECUTE_FRONTIER_REVIEW`, and `riskForReview` is where the conservation limit stops.
They steer no resource pick, because the ranking makes the pick at any risk, and they do not force a review on their own.
`resolvePolicy` refuses to start on a value the arithmetic cannot use, the way it refuses a bad gate: a `governor` that is not an object, a conservation curve outside 0..1 or with `startAt` above `aggressiveAt`, `resetProximityWeight` outside 0..1, a negative `staleAfterMinutes`, `staleConfidence` outside 0..1, a negative cost weight or marginal, a `budgetSoftMultiple` not above 1, and a rollback destination that is not below every rung it rolls back from (`minorTo` below LOCAL_ONLY, `significantTo` and `severeTo` below GUARDED_LOCAL; `ROLLBACK` is allowed).
`minClassRecall` (default 0.85) is the per-class recall floor; a domain is held to its own risk class's `gates.<LOW|MEDIUM|HIGH>.minClassRecall` when one is set, else to the global value (`domains.js` `gatesOf`).

Switching `enabled` off stops the decision engine, the adapters and the governor: the loop asks Jev directly over named agents.
It is not quite an off switch for all of this: the disabled and allowed lists still apply, and a finished run still records capability evidence.
Switching `learn` off keeps the capability profiles and the governor but never records a routing sample and never gives a domain local authority.
It also stops recording a finished run's own capability evidence (`index.js` `learnFrom` returns before `runEvidence`), so the evidence already on disk still informs routing but no longer grows.
A verdict is still stored, marked `learningOff`, and clearing or changing one still takes back what its earlier form counted, while new credit from a verdict waits for learning.

## Watching it work

```
node scripts/kzh-routing-demo.mjs              a healthy machine, one task of each kind
node scripts/kzh-routing-demo.mjs --pressure   the same, with Claude 88% and Codex 84% through their week
node scripts/kzh-routing-demo.mjs --learn 45   route 45 tasks, then show which domains matured
```

Every routing module in that script is the real one.
Only the agents and Jev are stood in for, and it says so on screen.
It prints the candidate table, the decision, who decided it and what the reasoning block would have shown, which is the same information the Jev inspector's **Decisions** tab renders.
The reasoning block's decision line names every authority that decided a domain (`adapter.js` `decidedBy`), in a fixed order: `the local router (<the domains it decided>)`, `Jev`, `routing rules`, then `the safe fallback (<domains>)` when some domains fell back.
When every domain fell back it reads `safe fallback, nothing could decide`, and only a run with no per-domain report (legacy named routing) reads `Jev decided`.
A typical run on a cold router reads `Jev and routing rules decided; 2 Jev calls; 3 candidates considered`: the task call, then the strategy and second-opinion call.
Once both task domains answer locally there is no task call, and it reads `the local router (task classification, skill selection), Jev and routing rules decided; 1 Jev call; 3 candidates considered`.
The report header (`router.js` `formatReport`) uses the short form without the domain lists, such as `AUTO (Jev and routing rules decided)` or `AUTO (the local router, Jev and routing rules decided)`, because the `Decided by` line right under it lists each domain.
The agent strip under the answer (`router.js` `answeredSteps`) opens with the same router: `Jev` when Jev answered any domain or there is no per-domain report, else `Local router`, else `Routing rules`.
With learning off there is no domain registry, and the report still names who answered each domain (Jev or the fallback for the task and the strategy, the ranking for the pick) rather than `none`.
The inspector shows each `RESOURCE_x` key with the agent id next to it: the person sees the mapping, Jev does not.

In the app, the inspector's **Router** tab shows each domain's maturity, which gate it is waiting on, what each provider adapter currently reports, and what the registry believes about each resource with the evidence behind every number.
A dimension's line adds `benchmark 75% (9 of 12 tasks)` when benchmark rows count for it, and a dimension only a benchmark has measured is listed too; the Capability benchmark card follows ([`benchmark.md`](benchmark.md) 3.11).
Under the maturity pill it says what the rung means for who decides (`client.js` `maturityWords`), and a domain decided in code says so.
A domain whose state reports `localDecides: false` (the resource ranking) shows `a rule in code decides at every rung; the local router is recorded beside it for comparison and never decides` in place of the rung's words, while the pill still shows the rung.
A domain Jev teaches whose local authority a policy took away (`localDecides: false` set in config) reads `Jev decides at every rung; ...` instead, because no rule in code decides it.
With learning off the tab's heading reads `Learning is switched off: Jev and the rules in code decide, and nothing is recorded`.
A `teacher: 'code'` domain whose classifier may decide (the frontier review) names the rule where the other domains name Jev:

| Rung | Words for the frontier review |
| --- | --- |
| JEV_PRIMARY | a rule in code decides; the local router is not trained yet |
| SHADOW | a rule in code decides; the local router predicts alongside it and is being scored |
| GUARDED_LOCAL | the local router decides when it is confident and the case is familiar; a rule in code decides the rest |
| LOCAL_ONLY | the local router decides normal cases; a rule in code decides the rest |
| ROLLBACK | local authority suspended; a rule in code decides until it is earned back |

When a code-decided domain is at a local rung and its classifier does not decide, the decision's reason keeps why (out of distribution, too little confidence, a classifier that never decides) and appends `; a rule in code decides this one`.
It prints every limit figure with its own provenance and confidence, so a DeepSeek balance reads, for example, `balance 60.0% used (estimated, little evidence), 40 USD left (from the provider, well evidenced)`, and scarcity is shown at its own confidence.
The run view says when the weekly gate yielded or the decision engine kept a gated frontier resource, on the decision card or, where that card is not shown (the Overview ledger, a stored run), on the run itself, and it names every move the router made, each with where it went.

## A second decider: Laya

Laya, a decision model on this PC, answers the same questions as Jev ([`laya-auto.md`](laya-auto.md) is the design).
Who decides a run is `routing.decider` on its record (`'jev'`, or `'laya'` for a Laya Auto run and `/laya`; a record without it was Jev's), and every cut-off the run reads comes from that provider's record (`providers.js`), never from a constant both share.
The teacher stays Jev: `routing-policy.js` still refuses any teacher but `jev` or `code`, and a domain's `state().teacher` is unchanged.

In a run Laya decides, every domain Jev would be asked about is answered by Laya, whatever rung its ladder holds, and records authority `laya`; the code-taught domains (`resource_selection`, `frontier_escalation`) are decided by their rules exactly as in Jev Auto; a domain whose Laya answer failed, or was too flat to use, takes its deterministic answer (`code` or `fallback`), never the local classifier and never Jev.
The one exception is `outcome_disposition`, where a flat disposition still gives authority `laya` and only the sample says `informative: false`, because the review's action comes from Laya's yes/no answers, not from the disposition.
The local classifier's answer is recorded beside Laya's and never decides, so Jev's teaching never enters a Laya run, and every domain reports `maturity: null` there: the local ladder's rung says nothing about a Laya run.

The stores are kept apart by construction, not by filters:

- `training.js` `createTrainingStore` takes a `kind`. The Jev store, `routing-samples.jsonl`, throws on authority `laya` and on any `provider` field; the Laya store, `laya-samples.jsonl`, throws on a teacher. `AUTHORITIES` is unchanged (the Jev store's list); `ALL_AUTHORITIES` adds `laya`, and `STORE_AUTHORITIES` gives each store its own.
- A Laya run's decisions write to the Laya store only (`decide({ answeredBy: 'laya', sink })`), and never touch a domain's ladder: no out-of-distribution note, no maturity change, no state write. The review's `outcome_disposition` is decided behind a facade in `index.js` that sends it to the Laya store, so `jev-review` knows nothing of stores.
- The labels a finished run earns are resolved in the store each sample was written to (`decisionSamples` entries carry `store`), and a person's verdict relabels in the store `routing.decider` names (`index.js` `onVerdict`). An accepted run confirms only the teacher's pick, so an accepted Laya run labels nothing; evidence against a Laya pick (a rescue, a negative outcome, a person's tag) is labelled as it is for any pick.
- After a Laya-decided run the Jev evaluation pass (`maybeRetrain`) does not run: it stamps and saves every Jev domain state, and a Laya run gives those domains nothing new. Laya's own pass appends its standing to `laya-standing.jsonl`, outside `domains/`.
- No local classifier reads `laya-samples.jsonl`, so their training, evaluation windows, drift and out-of-distribution statistics, `classProfiles` and `stats().localAgreement` cannot see a Laya answer.
- A Laya-decided run's capability evidence is only whether each attempt completed (`reliability`), with no task type, because every other row would rest on Laya's own judgment; a person's verdict on such a run gives no capability evidence, and weighs in the feedback prior as a verdict on a run of unknown type.

The decision line and the report name Laya where they name Jev: `Laya and routing rules decided; 2 Laya calls; 3 candidates considered`, and `AUTO (Laya and routing rules decided)`.

## What this does not do yet

- **No published benchmarks.** The capability benchmark in the Router tab is the source of `benchmark` rows now (see Benchmark evidence under "Capability, as evidence rather than rules").
  What stays empty is `benchmark_prior`: nothing imports published benchmarks.
- **Only local models have a real version.** Claude Code, Codex and API agents report no served version, so they are keyed by their configured model name and protected only by the 45-day window, unless that name is itself a dated snapshot.
- **Most limit kinds and scopes have no producer.** Only `rolling_window` and `monetary_budget` limits, all at scope `account`, come from a shipped adapter; the governor ignores scope.
- **A reply with no run mark.** A verdict on an answer that carries no `[jev-run]` mark (one from before the mark existed) is credited by time, so a first verdict on an older answer, given after a newer run in the same session had already ended, is credited to that newer run, and every later form of that verdict follows it there.
- **Keys are positional; familiarity is not.** `RESOURCE_x` is assigned over the current pool, so a resource's key can shift when the pool changes.
  The ranker learns from each candidate's features, never its key, so its choices do not depend on the shift, and the familiar-candidate check counts resources by their stable id (in code; the classifier never sees an id), so a new resource that inherits an old key is still flagged unfamiliar.
  An artifact trained before that change is read by key until its next retrain.
- **Routing does not read a local model's speed.**
  The resource snapshot routing reads carries no tokens per second (`resources.js`, `tokensPerSecond: null`), and the latency class comes from whether a resource is local, an API or a subscription.
  The speed benchmark measures a local model's tokens per second for the Local models card and the install picker ([`benchmark.md`](benchmark.md) section 2), and routing does not read that reading either.
  Its memory is measured once it has run (`local.js` `readMemoryUsage`), and estimated until then.
  Its context is the plugin config's `local.contextSize` when set, else the manifest's (16,384 when the manifest names none), or 12,288 on a PC with under 12 GB RAM, and never above the manifest's `maxContext`.
  A RAM budget sizes it down to the largest whole k that fits, to 12,288 at least (`local.js` `planFor`).
- **Anthropic reports no plan name**, so `pro` against `max` has to be configured by hand in `resources.plans`; unconfigured, the default curve applies.
  Codex reports its plan; DeepSeek has no plan concept at all.
- **A monetary budget without a provider total** is read against the soft and hard floors plus an estimated share, so its
  pressure is coarser than a window's.
- **Retraining is in-process.** It runs after a task settles, at most once a minute, not on a schedule.
  A POST to `/jev-router/routing/evaluate` also evaluates every domain and retrains those with enough new evidence, on demand and without the one-minute limit, but nothing in the app calls it.
  Short of that request, a machine that never finishes a task never retrains.
- **The maturity numbers are untested against reality.** The gates are reasoned defaults; nobody has
  yet accumulated the thousands of verified samples it would take to find out whether they are set
  in the right place.
