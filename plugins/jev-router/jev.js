// TypeSafe Jev judgments for routing and post-execution assessment.
// Jev only answers typed questions; all policy (thresholds, limits, overrides)
// lives in router.js so raw judgments stay reusable and inspectable.
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk'
import { CAPABILITIES } from './capabilities.js'
import { redactSecrets } from './export.js'

export const TASK_TYPES = {
  architecture: 'Designing structure, data flow, or a strategy across components before or instead of writing code',
  implementation: 'Writing new code or features to a known requirement',
  debugging: 'Finding and fixing the cause of incorrect behavior, a failing test, or an error',
  review: 'Reading existing code or a diff and reporting problems, without being asked to change it',
  refactor: 'Restructuring or renaming existing code without changing behavior',
  testing: 'Writing or repairing tests',
  documentation: 'Writing or updating docs, comments, or READMEs',
  investigation: 'Researching how something works or why something happens, producing findings rather than a change',
  security: 'Work whose main concern is authentication, authorization, secrets, or vulnerabilities',
  performance: 'Work whose main concern is speed, memory, or resource usage',
  simple_change: 'A small, mechanical, low-judgment edit such as a typo, constant, or one-line fix',
  other: 'None of the above fits',
}

const COMPLEXITY_LEVELS = [
  'Trivial: a mechanical edit in one place with an obvious answer',
  'Small: a contained change in one or two files with a clear approach',
  'Moderate: several files or some design judgment, but a well-understood problem',
  'Hard: cross-cutting change, unclear root cause, or real design trade-offs',
  'Extremely complex: ambiguous requirements, many interacting systems, or concurrency and distributed-state reasoning',
]

const RISK_LEVELS = [
  'Negligible: a mistake has no user-visible effect, for example docs or a test fixture',
  'Low: a mistake causes a minor, easily noticed and reverted defect',
  'Moderate: a mistake could break a feature for some users until fixed',
  'High: a mistake could corrupt data, break a core flow, or cause an outage',
  'Production-critical: a mistake could compromise security, authentication, money, or irreversible data',
]

export const VERDICTS = {
  accept: {
    what: 'The evidence shows the task is done: the result addresses the request and verification supports it',
    not_for: 'Results with failing required checks, unaddressed parts of the task, or open risk that deserves another look',
  },
  second_review: {
    what: 'The result looks plausible, but its risk or uncertainty justifies an independent review by a different agent',
    not_for: 'Results that are clearly wrong (retry) or clearly fine (accept)',
  },
  retry: {
    what: 'The result is incomplete or wrong, or checks fail because of it, and another attempt could fix it',
    not_for: 'Problems that need a human decision such as unclear scope, destructive actions, or credentials',
  },
  human: {
    what: 'A person should decide: scope is unclear, the change is risky or destructive, agents failed repeatedly, or evidence is missing',
    not_for: 'Routine outcomes an agent can settle',
  },
}

/**
 * Mask key-shaped strings on anything that goes to Jev, with the same scrubber the
 * Markdown export uses. A key pasted into the chat was already masked in the log and
 * in the export; sending it verbatim to a third party was the one path that missed.
 * Secrets only, on purpose: the routing judgment is made of the task text, the diff
 * and the check output, so stripping code, paths or branch names would quietly make
 * every routing decision worse.
 */
const scrub = (text) => (typeof text === 'string' ? redactSecrets(text) : text)
/**
 * `scrub` every string inside a nested plain object or array. The track record is built from the
 * person's own feedback, including the free text they typed in the Why? box, so it is the one
 * payload on the routing call that can carry an arbitrary sentence. A key pasted into that box
 * must not ride out with it, and the README promises keys are masked in everything sent to Jev.
 */
const scrubDeep = (v) => (Array.isArray(v) ? v.map(scrubDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]))
    : scrub(v))

function clip(text, max) {
  const s = scrub(text)
  if (typeof s !== 'string') return s
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`
}

function agentCriteria(agents) {
  return Object.fromEntries(agents.map((a) => [a.id, { what: a.description }]))
}

// Normalize a Score over N described levels to 0..1.
const unit = (answer, levels) => answer.score / (levels.length - 1)

/** One Jev call as the Inspector shows it: timing, usage, every question and its full answer. */
function traceOf(phase, questions, res, ms, used) {
  return {
    phase,
    ms,
    model: res.model,
    // The call's own id from `x-typesafe-request-id`. The quick reference's house rule is to log
    // it with the model, because it is the only handle TypeSafe support can act on when a
    // judgment looks wrong.
    requestId: res.requestId,
    usage: res.usage,
    questions: Object.entries(questions).map(([name, q]) => {
      const a = res.answers[name]
      return {
        name,
        type: q.type,
        question: typeof q.instructions === 'string' ? q.instructions : q.instructions.question,
        options: q.type === 'choice' ? Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, typeof v === 'string' ? v : v?.what])) : q.type === 'score' ? { ...q.criteria } : undefined,
        answer: a.type === 'choice' ? a.choice : a.type === 'score' ? a.score : a.noul,
        confidence: a.confidence,
        probabilities: a.probabilities,
        used: used(name, res.answers),
      }
    }),
  }
}

export function createJev({ apiKey, model, timeoutMs, onTrace }) {
  const client = new TypeSafeClient({ apiKey, ...(model ? { defaultModel: model } : {}) })
  const ask = async (phase, state, questions, signal, used = () => true) => {
    const t0 = Date.now()
    const call = client.systemOne({ state, questions }, { timeout: timeoutMs, signal })
    // `.withResponse()` is how the SDK hands back the request id; without it the id never
    // reaches the log. Falls back cleanly if a future SDK drops the method.
    const { data: res, requestId } = typeof call?.withResponse === 'function'
      ? await call.withResponse()
      : { data: await call, requestId: undefined }
    onTrace?.(traceOf(phase, questions, requestId ? { ...res, requestId } : res, Date.now() - t0, used))
    return res
  }

  return {
    /**
     * Initial routing. `agents` is the enabled registry slice; `tools` are
     * deterministic scripts Jev may pick instead of an agent. Every tool's
     * parameter questions are asked speculatively in the same single call.
     */
    async route({ task, context, agents, tools = [], history, availability, trackRecord, handoff, capabilities }, signal) {
      const state = { task: scrub(task), workspace: context, recent_outcomes: history }
      if (availability) state.agent_availability = availability
      if (trackRecord) state.agent_track_record = scrubDeep(trackRecord)
      if (handoff) state.handoff = clip(handoff, 3000)
      const questions = {
        agent: choice(
          {
            question: 'Which coding agent should handle `task` first?',
            focus: 'Match the nature of `task` and the facts in `workspace` to each agent\'s strengths. `recent_outcomes` shows how agents did on earlier tasks here.'
              + (trackRecord ? ' Prefer the cheapest agent likely to succeed, judged by `agent_track_record` (accepted rate for this kind of task here, then overall): free-local agents for simple or read-only work, api agents for routine work, subscription agents for hard, risky or cross-cutting work or where cheaper agents keep failing. Avoid agents with repeated limit hits. Where `price_now` says an agent is on its standard (not off-peak) rate, prefer an equally capable agent that is not, unless the task needs that one.' : '')
              + (availability ? ' Prefer agents that are \'ok\' in `agent_availability` over those \'near limit\'.' : ''),
          },
          agentCriteria(agents),
        ),
        taskType: choice('What kind of work does `task` ask for?', TASK_TYPES),
        complexity: score('How complex is `task` to carry out correctly in this workspace?', COMPLEXITY_LEVELS),
        risk: score('How much harm could a wrong result for `task` cause if shipped?', RISK_LEVELS),
        secondOpinion: noul('Would an independent second agent reviewing the result of `task` likely catch mistakes worth the extra time?'),
        humanReview: noul('Should a person inspect the result of `task` before it is accepted, even if checks pass?'),
        needsTests: noul('Should deterministic checks (tests, type checker, lint, build) be required to pass before the result of `task` is accepted?'),
      }
      if (handoff) questions.continueHandoff = noul('Does `task` ask to continue the earlier unfinished work described in `handoff`?')
      // What kind of outcome this needs. Batched with everything else, so it costs only its own
      // tokens and no extra round trip. The options are the capabilities some pickable executor
      // really has: a category nothing on this machine can carry out is never offered, and
      // `human_required` is always available because a person always is.
      if (capabilities?.length) {
        questions.capability = choice(
          {
            question: 'What kind of outcome does `task` need?',
            focus: 'Choose what finishing the task actually requires. Explaining while changing code is still `project_change`; reading the project without changing it is `project_read`.',
          },
          {
            ...Object.fromEntries(capabilities.map((c) => [c, { what: CAPABILITIES[c] }])),
            human_required: { what: CAPABILITIES.human_required },
            // Choice is relative, so something always wins (quick reference rule 6): without an
            // escape hatch a request that fits nothing is forced into the nearest wrong category.
            other: { what: 'Nothing in this list fits: the request needs something these executors are not described as doing' },
          },
        )
      }
      if (tools.length) {
        questions.handler = choice(
          {
            question: 'Can a fixed tool fully handle `task`, or does it need an AI coding agent?',
            focus: 'Pick a tool only when it does exactly what `task` asks with no judgment, writing, or code changes. Anything else needs an agent.',
          },
          { agent: { what: 'An AI coding agent is needed: the task involves reasoning, writing, or changing code' }, ...Object.fromEntries(tools.map((t) => [t.id, { what: t.description }])) },
        )
        for (const t of tools) {
          // Atomic yes/no per tool (skill-suggestion cookbook); the handler choice alone is too broad.
          questions[`${t.id}.fits`] = noul({
            question: `Does the \`${t.id}\` tool do exactly what \`task\` asks, with nothing left for an AI agent?`,
            focus: `The \`${t.id}\` tool: ${t.description}`,
          })
          for (const [p, def] of Object.entries(t.params ?? {})) {
            questions[`${t.id}.${p}`] = choice(def.question, Object.fromEntries(Object.entries(def.options).map(([k, v]) => [k, { what: v }])))
          }
        }
      }
      // Per-tool fits/params are speculative; only the handler's pick is used.
      const used = (name, ans) => !name.includes('.') || name.startsWith(`${ans.handler?.choice}.`)
      const { answers, model: usedModel } = await ask('route', state, questions, signal, used)
      const handler = answers.handler?.choice ?? 'agent'
      const params = handler === 'agent' ? [] : Object.keys(tools.find((t) => t.id === handler)?.params ?? {})
      return {
        model: usedModel,
        primaryAgent: answers.agent.choice,
        agentConfidence: answers.agent.confidence,
        agentProbabilities: answers.agent.probabilities,
        // What the request needs. Undefined when no registry was wired, so nothing downstream
        // has to guess whether the answer is meaningful.
        capability: answers.capability?.choice,
        capabilityConfidence: answers.capability?.confidence,
        taskType: answers.taskType.choice,
        taskTypeConfidence: answers.taskType.confidence,
        complexity: unit(answers.complexity, COMPLEXITY_LEVELS),
        risk: unit(answers.risk, RISK_LEVELS),
        needsSecondOpinion: answers.secondOpinion.noul,
        needsHumanReview: answers.humanReview.noul,
        needsTests: answers.needsTests.noul,
        continueHandoff: answers.continueHandoff?.noul,
        handler,
        handlerConfidence: answers.handler?.confidence,
        toolFits: handler === 'agent' ? undefined : answers[`${handler}.fits`]?.noul,
        // Call confidence = weakest argument (function-calling cookbook); 1 when the tool takes none.
        toolArgConfidence: handler === 'agent' ? undefined : Math.min(1, ...params.map((p) => answers[`${handler}.${p}`].confidence)),
        toolArgs: handler === 'agent' ? undefined : Object.fromEntries(params.map((p) => [p, answers[`${handler}.${p}`].choice])),
      }
    },

    /**
     * Is the latest message work to carry out in the project, or a question to answer directly?
     * And how much does answering it well depend on real reasoning?
     *
     * Both ride the one call (~0.1 s), so the second question costs no extra round trip. It
     * decides which model answers: everyday talk goes to the local model first (free, private,
     * instant), and Jev is the one that decides when it is worth waking a bigger model.
     */
    async intent({ message }, signal) {
      const { answers } = await ask('intent', { message: scrub(message) }, {
        kind: choice(
          { question: 'What does `message` ask for?', focus: 'Only work that reads or changes the project counts as a task. Questions about tools, accounts, concepts or this app are questions.' },
          {
            task: { what: 'Work to carry out in the code project: fix, build, change, refactor, review, test, investigate or explain its code or files', not_for: 'General questions or chat that need no project files' },
            question: { what: 'A question or conversation to answer directly, such as how something works, why something happened, or advice', not_for: 'Requests to read, change or check files in the project' },
          },
        ),
        depth: choice(
          { question: 'How much does answering `message` well depend on careful reasoning or wide, current knowledge?', focus: 'Judge the question itself, not who is asking it or how it is worded.' },
          {
            everyday: { what: 'Greetings, small talk, thanks, a short how-to or factual answer, or something a small local model handles well', not_for: 'Anything whose answer needs several steps of reasoning, wide or current knowledge, or the details of this project' },
            deep: { what: 'Needs careful step-by-step reasoning, wide or up-to-date knowledge, or knowledge of this project: worth the strongest available model', not_for: 'Greetings, thanks, small talk, and one-line factual or how-to answers' },
          },
        ),
        // One message may do both: answer it and ask for work. Asked independently so a message
        // that is mostly a question can still queue the change it mentions - the old single
        // question-versus-task choice could not express that at all.
        alsoWork: noul('Even if `message` is a question to answer directly, does it also ask for work to be carried out in the project?'),
      }, signal)
      return {
        kind: answers.kind.choice,
        confidence: answers.kind.confidence,
        // Undefined when Jev did not answer that one: the caller then keeps the cheap default.
        depth: answers.depth?.choice,
        depthConfidence: answers.depth?.confidence,
        alsoWork: answers.alsoWork?.noul,
      }
    },

    /** Post-execution assessment over summarized, deterministic evidence. */
    async assess({ task, routing, attempts, checks, diff, agents }, signal) {
      const state = {
        task: scrub(task),
        routing: { task_type: routing.taskType, risk: routing.risk, complexity: routing.complexity },
        // Only the newest attempt is sent in full. Earlier ones shrink to what the review
        // actually uses them for: who tried, how it ended, and whether anything moved. Round 3
        // used to resend rounds 1 and 2 at full length, paying for the same words every round.
        attempts: attempts.map((a, i) => ({
          agent: a.agent,
          role: a.role,
          status: a.stopReason,
          diagnostic: scrub(a.diagnostic),
          ...(i === attempts.length - 1 ? { answer: clip(a.answerText, 2500) } : {}),
          changed_files: a.changedFiles,
        })),
        // Check output is test and build stdout, which prints whatever the run had in env.
        verification: checks.map((c) => ({ ...c, output: scrub(c.output) })),
        diff: { stat: diff.stat, excerpt: clip(diff.patch, 6000) },
      }
      // One snap judgment per question: atomic Nouls (yes = the thing named) decide
      // in jev-review; the broad verdict is kept as a displayed signal only.
      const { answers } = await ask('review', state, {
        verdict: choice(
          {
            question: 'Given the latest entry in `attempts`, `verification`, and `diff`, what should happen next for `task`?',
            focus: 'Judge the evidence, not the agent\'s own claims. A failing required check in `verification` means the task is not done.',
          },
          VERDICTS,
        ),
        addressed: noul('Does the latest entry in `attempts` (its answer and `diff`) do what `task` asked?'),
        complete: noul('Is every part of `task` handled by the latest entry in `attempts` and `diff`, with nothing left undone?'),
        unrelatedChanges: noul('Does `diff` change anything `task` did not ask for?'),
        regressionRisk: noul('Does `diff` carry meaningful risk of breaking behavior that `task` did not ask to change?'),
        needsPerson: noul('Does the latest entry in `attempts` ask a question, report being blocked, or need a decision only a person can make?'),
        // Asked separately because they are different jobs. A careful critic and a strong
        // fixer are rarely the same agent, and one answer spent on both meant whichever the
        // run happened to need got the other one's pick. Both ride this same call, so the
        // split costs no extra round trip.
        reviewAgent: choice(
          {
            question: 'If another agent REVIEWS the latest attempt without changing it, which agent should judge it?',
            focus: 'Judging rewards care and independence over speed or cost, and costs few tokens. Prefer an agent other than the one that produced the work, unless it is clearly the best judge.',
          },
          agentCriteria(agents),
        ),
        retryAgent: choice(
          {
            question: 'If another agent has to FIX the latest attempt, which agent should do the work?',
            focus: 'Fixing is bulk work: weigh track record on this kind of task and cost. Prefer an agent other than the one that just failed, unless it is clearly the best fit.',
          },
          agentCriteria(agents),
        ),
      }, signal, (name) => name !== 'verdict')
      return {
        verdict: answers.verdict.choice,
        verdictConfidence: answers.verdict.confidence,
        verdictProbabilities: answers.verdict.probabilities,
        addressed: answers.addressed.noul,
        complete: answers.complete.noul,
        unrelatedChanges: answers.unrelatedChanges.noul,
        regressionRisk: answers.regressionRisk.noul,
        needsPerson: answers.needsPerson.noul,
        reviewAgent: answers.reviewAgent.choice,
        reviewAgentProbabilities: answers.reviewAgent.probabilities,
        retryAgent: answers.retryAgent.choice,
        retryAgentProbabilities: answers.retryAgent.probabilities,
      }
    },
  }
}
