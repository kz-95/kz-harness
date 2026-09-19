// TypeSafe Jev judgments for routing and post-execution assessment.
// Jev only answers typed questions; all policy (thresholds, limits, overrides)
// lives in router.js so raw judgments stay reusable and inspectable.
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk'

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

function clip(text, max) {
  if (typeof text !== 'string') return text
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`
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
    const res = await client.systemOne({ state, questions }, { timeout: timeoutMs, signal })
    onTrace?.(traceOf(phase, questions, res, Date.now() - t0, used))
    return res
  }

  return {
    /**
     * Initial routing. `agents` is the enabled registry slice; `tools` are
     * deterministic scripts Jev may pick instead of an agent. Every tool's
     * parameter questions are asked speculatively in the same single call.
     */
    async route({ task, context, agents, tools = [], history }, signal) {
      const state = { task, workspace: context, recent_outcomes: history }
      const questions = {
        agent: choice(
          {
            question: 'Which coding agent should handle `task` first?',
            focus: 'Match the nature of `task` and the facts in `workspace` to each agent\'s strengths. `recent_outcomes` shows how agents did on earlier tasks here.',
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
        taskType: answers.taskType.choice,
        taskTypeConfidence: answers.taskType.confidence,
        complexity: unit(answers.complexity, COMPLEXITY_LEVELS),
        risk: unit(answers.risk, RISK_LEVELS),
        needsSecondOpinion: answers.secondOpinion.noul,
        needsHumanReview: answers.humanReview.noul,
        needsTests: answers.needsTests.noul,
        handler,
        handlerConfidence: answers.handler?.confidence,
        toolFits: handler === 'agent' ? undefined : answers[`${handler}.fits`]?.noul,
        // Call confidence = weakest argument (function-calling cookbook); 1 when the tool takes none.
        toolArgConfidence: handler === 'agent' ? undefined : Math.min(1, ...params.map((p) => answers[`${handler}.${p}`].confidence)),
        toolArgs: handler === 'agent' ? undefined : Object.fromEntries(params.map((p) => [p, answers[`${handler}.${p}`].choice])),
      }
    },

    /** Post-execution assessment over summarized, deterministic evidence. */
    async assess({ task, routing, attempts, checks, diff, agents }, signal) {
      const state = {
        task,
        routing: { task_type: routing.taskType, risk: routing.risk, complexity: routing.complexity },
        attempts: attempts.map((a) => ({
          agent: a.agent,
          role: a.role,
          status: a.stopReason,
          diagnostic: a.diagnostic,
          answer: clip(a.answerText, 2500),
          changed_files: a.changedFiles,
        })),
        verification: checks,
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
        nextAgent: choice(
          {
            question: 'If another agent works on `task` next, to review or to fix the latest attempt, which agent is best?',
            focus: 'An independent perspective usually helps most. Prefer an agent other than the one that just failed or produced the work, unless it is clearly the best fit.',
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
        nextAgent: answers.nextAgent.choice,
        nextAgentProbabilities: answers.nextAgent.probabilities,
      }
    },
  }
}
