# Queue, cost and clarity: three findings from the first real run

Kind: **work order**. Observed on the owner's PC on 26 Sep 2026, in the app, on `main` at
`7c82697`. Delete this file once the three are done; it describes a moment, not a design.

The first time Jev Auto was watched doing real work, three things went wrong at once. None is a
crash and every test passes, which is the point: these are the kind of fault only a real run
shows.

## What was seen

Three tasks sent to the `jev-router-test` workspace, one after another:

```
1 running, 2 queued
  help me do a sample for running jev auto        Running   claude · opus[1m] · high   693.1 s
  can you help me get a realistic 1k to 1million  Waiting   2nd in line
  ok you can use it                               Waiting   3rd in line

Jev 1.7 s   Agents 543.2 s   Total 692.7 s   Questions 31/32
Task type testing 76%   Complexity 32.5%   Risk 1.3%
Strategy CHEAP_EXECUTE_FRONTIER_REVIEW (review by codex)
Step 1 claude  completed 543.2 s
Step 2 codex   review  running...
Review -> second_review: quality 0.41, between 0.3 and bar 0.55
```

Eleven and a half minutes, two frontier agents, an escalating review, and two other tasks unable
to start. For a request to write a sample.

---

## 1. Read-only work waits behind work that writes

`laneKey` (`tasks.js:12`) is the workspace folder and a lane has exactly one holder
(`createLanes`, same file), so every task in one workspace runs strictly one at a time. No
setting changes this: `maxConcurrentTasks` is a cap *across* workspaces, and the panel's own help
says "A workspace still runs one at a time."

The rule is right. Two agents editing one folder at once corrupt each other's work, and that is
worth a queue.

What is wrong is that it has **no exemption for work that writes nothing**. The second task above
is a research question that touches no file, and it waited eleven minutes behind a code task for
no reason at all.

**What to build.** A task that cannot write does not take the workspace lane. The classifier
already answers close to this - a question is separated from a task before routing, and the
capability profile says whether the work is read-only - so the input probably exists already;
find it before adding one. `acquire` already reports *why* something waits (`'workspace'` or
`'cap'`), so the shape for a third answer, "it did not have to", is there.

Two things this must not become:

- A read-only task still counts against `maxConcurrentTasks`. The cap is about the machine's
  RAM and cores, and a read-only agent uses both.
- "Read-only" has to come from what the router decided, not from a word rule over the message.
  Unsure means it writes, as it already does elsewhere for the same reason.

## 2. Cheap work is served as though it were expensive

Complexity 32.5%, risk 1.3%, and the run drew `opus[1m]` at `high` effort, a frontier review by a
second agent, and then an escalation round when the review scored 0.41.

Two separate causes, and the first is exact:

**The effort ladder cannot go low.** `autoLevel` (`effort.js:103`):

```js
return x < bands.medium ? 'medium' : x < bands.high ? 'high' : 'xhigh'
```

with `bands = { medium: 0.25, high: 0.6 }`. So `x = max(complexity, risk) = 0.325` gives
`'high'`. And the first branch returns `'medium'`, which means **`'low'` is never returned for
any input at all**: the bottom rung of the unified ladder is unreachable from auto, and the
effective floor is medium. A task at 0% complexity gets the same effort as one at 24%.

That is a defect in the mapping, not a threshold anyone tuned: the band named `medium` is being
used as a floor rather than as the lower edge of a range.

**Fix:** make the bands cover the ladder they name - below the first cut is `'low'` - and re-read
the cuts themselves afterwards, because 0.25 as the medium cut was chosen against a ladder that
started at medium.

**The strategy is over-cautious for low risk.** `CHEAP_EXECUTE_FRONTIER_REVIEW` at risk 1.3%
spends a second frontier agent on reviewing work nobody would lose sleep over, and the review
bar then failed it at 0.41 against 0.55 and escalated again. The judgments behind it read
second opinion 67%, human review 86%, needs tests 69% - all high for writing a sample.

This one is a judgement call rather than an arithmetic bug, so decide it deliberately: at what
risk does a frontier review earn its minutes? The accept bars are already risk-scaled
(0.55 / 0.70 / 0.85); the strategy choice is not scaled the same way and probably should be.

**Do not fix this by making Jev more cautious about strategy.** The resource pick is arithmetic
in code now and the strategy is a categorical judgment; the cost of a strategy is a number, so
the *affordability* of one belongs beside the ranking, not in a question.

## 3. The queue does not say what it is doing

A waiting row says `2nd in line` and nothing else. It does not say:

- **why** it waits - the workspace, not the cap, and the two are fixed by different things;
- **how long** - every ingredient for an estimate is recorded (past runs per agent and strategy,
  and the running task's own elapsed time), and none of it is shown;
- **what can be done about it** - the only control is `Stop all`, which kills work that is
  minutes from finishing along with the queue behind it.

**What to build.** The reason in words, the position, an estimate drawn from past runs of the
same shape, and per-row cancel. `acquire`'s `onWait` already carries the reason; `WAITING[why]`
already turns it into a sentence. The estimate is the new part, and it should say what it is: an
estimate from N past runs, or nothing at all when there is no record to draw on. A number with
nothing behind it is the one way a queue view can mislead, which is the same rule the inspector
and the memory figures already follow.

---

## Order, and why

1. **Read-only skips the lane.** Biggest relief for the least code, and it needs no judgement
   calls about cost.
2. **The effort floor.** A one-line arithmetic defect with a clear right answer, and it makes
   every cheap task cheaper straight away.
3. **The strategy's risk scaling.** Needs a decision about where the bar sits; take it
   deliberately rather than by tuning until it feels better.
4. **The queue view.** Once 1 and 2 land there is less waiting to explain, so the explanation can
   be built against what is left rather than against today's worst case.

## Before any of it is called done

It has to be watched in the app, not just tested. Every one of these faults was invisible to
1354 passing tests, and the thing that found them was sending three messages and looking at the
screen.
