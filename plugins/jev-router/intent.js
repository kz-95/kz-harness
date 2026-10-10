// The message intent: is a chat message a task to carry out in the project, or a question to answer
// directly (docs/live-agent-view.md Feature 3)? Under Jev Auto, Jev answers it, and the intent domain
// (routing-policy.js DOMAINS.intent) learns from Jev and from what came of each message, as every
// routing domain does. Its authority runs one way: once mature, the local classifier may decide that
// a message is a task, the side whose mistake costs one agent run, and only Jev may say it is a
// question, since a task taken for a question goes to a chat model that cannot touch the project.
//
// Laya Auto and offline mode sort a message their own ways, and nothing is recorded for them
// (index.js classify). Nothing here touches a file or the network: the domain records the sample,
// and `ask` is Jev's call.
import { intentFeatures } from './features.js'

export const TASK = 'task'
export const QUESTION = 'question'

/**
 * The capabilities that answer without touching the project (capabilities.js), as router.js reads
 * them: a run whose routing named one, and that changed no file, was asked a question.
 */
export const ANSWER_CAPABILITIES = Object.freeze(['quick_answer', 'reasoned_answer'])

/**
 * The verdict tags that say what a message was (feedback.js takes them from slice 6 on): on a start
 * reply, that it was a question after all; on a direct answer, that it was a task after all.
 */
export const INTENT_TAGS = Object.freeze({ question: 'should have been a question', task: 'should have been a task' })

/**
 * Sort one message under Jev Auto through the intent domain, which records it as a sample and lets
 * its local classifier decide once it has earned a rung, and then only that the message is a task.
 * Jev's answer is kept whole: the domain learns only its kind, while the caller needs the rest (how
 * deep a question is, whether it also asks for work, whether the work only reads the project).
 * Without a domain (routing learning off) it is Jev's answer as it always was, and no sample.
 * @param {object} p
 * @param {object|null} p.domain   the intent domain's controller (domains.js), or null
 * @param {string} p.message       the words the person typed
 * @param {string[]} [p.modalities] what came with them, read for whether a picture did
 * @param {(() => Promise<object|null>)|null} p.ask  Jev's intent call (jev.js intent), or null with no Jev
 * @param {() => object} [p.fallback] the message when nobody could sort it: a task, the safe side
 * @param {boolean} [p.localMayDecide] false where no task can run (index.js classify), where a
 *   question taken for a task would be refused rather than answered: the local classifier decides
 *   nothing there, whatever its rung, Jev is asked as before there was a domain, and the local
 *   answer is recorded beside Jev's for comparison
 * @returns {Promise<object>} Jev's answer when Jev decided, `{ kind: 'task', decidedBy: 'local', readOnly: null }`
 *   when the local classifier did (it runs as work that writes), else the fallback; each with
 *   `intentSample`, the id of the sample the domain recorded, when it recorded one
 */
export async function classifyIntent({ domain, message, modalities = ['text'], ask = null, fallback = () => ({ kind: TASK }), localMayDecide = true }) {
  const plain = async () => { try { return (await ask?.()) ?? fallback() } catch { return fallback() } }
  if (!domain) return plain()
  let jev = null
  let asked = false
  const teach = ask ? async () => {
    asked = true
    jev = await ask()
    return jev?.kind ? { label: jev.kind, confidence: jev.confidence ?? 1, model: jev.model ?? null } : null
  } : null
  let d
  try {
    d = await domain.decide({
      features: intentFeatures(message, { modalities }),
      jev: teach,
      localMayDecide,
      fallback: () => ({ label: TASK, probabilities: { [TASK]: 1 }, confidence: 0.5 }),
    })
  } catch {
    // The domain could not decide, which it never should: the message is sorted as it was before
    // there was a domain, from Jev's answer when one came.
    return jev?.kind ? jev : asked ? fallback() : plain()
  }
  const sample = d.sampleId ? { intentSample: d.sampleId } : {}
  // Whatever the domain's classifier decided here, the message is a task: a second lock on the one
  // way its authority runs, behind the domain's own (domains.js, `localLabels`).
  if (d.authority === 'local') return { kind: TASK, decidedBy: 'local', readOnly: null, ...sample }
  if (d.authority === 'jev' && jev?.kind) return { ...jev, ...sample }
  return { ...fallback(), ...sample }
}
