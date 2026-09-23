// The capability registry: what a request needs, and which executor on this machine can
// produce it.
//
// Routing used to be one code-only question - question or coding task - which cannot express
// OCR, a document, a web lookup or "ask the person". Every executor now declares what it can
// do, code removes the executors that cannot do *this* request before Jev is asked, and Jev
// picks from what is left. Adding an executor is a registration, not another branch.
//
// Facts stay in code: availability, credentials, modality support, mutation permission and
// size limits are decided here, never delegated to Jev (see the Jev quick reference rules 4
// and 10 - it cannot count, compare or know what is installed).
import { MARGINAL_COST_BY_KIND, kindOf, marginalCostOf } from './accounts.js'

/** The outcome categories a request can need. Descriptions are what Jev is asked to choose between. */
export const CAPABILITIES = Object.freeze({
  quick_answer: 'A greeting, a short factual answer or small talk: no project access, no tools, answerable from general knowledge',
  reasoned_answer: 'A multi-step explanation or judgement that needs careful reasoning or wide knowledge, but no project files',
  ocr: 'Extract the text that appears in an image or scan, so it can be read or checked',
  image_inspection: 'Look at an image and describe, compare or check what it shows',
  document_processing: 'Read, transform or validate a document such as a PDF, spreadsheet or Word file',
  web_research: 'Find current information from outside this machine, with sources',
  deterministic_tool: 'A fixed, exact operation a registered script does completely, with no judgement',
  project_read: 'Read this project and explain how it behaves, without changing anything',
  project_change: 'Change this project: write, fix, refactor, test or build it',
  human_required: 'The request cannot proceed without a decision, permission or information only the person has',
})

const MODALITIES = ['text', 'image']
const LOCALITY = ['local', 'hosted']
const LATENCY = ['fast', 'medium', 'slow']
const COST = ['free', 'subscription', 'metered']
const KINDS = ['agent', 'chat', 'tool']
/** Declared in this order, so the first thing missing is the thing reported. */
const REQUIRED = ['capabilities', 'modalities', 'mutation', 'network', 'locality', 'latency', 'cost', 'credentials', 'verification', 'maxInputBytes']

const oneOf = (value, allowed) => allowed.includes(value)

/**
 * Check one executor's declaration. Every field is required on purpose: a default here would
 * be a silent assumption about what a model can do, and the whole point of the registry is
 * that code knows rather than guesses.
 */
export function validateExecutor(e) {
  if (!e || typeof e !== 'object') throw new Error('executor: an object is required')
  if (typeof e.id !== 'string' || !e.id) throw new Error('executor id: a non-empty string is required')
  if (typeof e.name !== 'string' || !e.name) throw new Error(`executor ${e.id}: name: a non-empty string is required`)
  for (const field of REQUIRED) {
    if (!(field in e)) throw new Error(`executor ${e.id}: ${field} is required`)
  }
  if (!Array.isArray(e.capabilities)) throw new Error(`executor ${e.id}: capabilities: an array is required`)
  for (const c of e.capabilities) if (!CAPABILITIES[c]) throw new Error(`executor ${e.id}: capabilities: unknown capability "${c}"`)
  if (!Array.isArray(e.modalities) || !e.modalities.length || e.modalities.some((m) => !oneOf(m, MODALITIES))) throw new Error(`executor ${e.id}: modalities: text and/or image`)
  if (typeof e.mutation !== 'boolean') throw new Error(`executor ${e.id}: mutation: true or false is required`)
  if (typeof e.network !== 'boolean') throw new Error(`executor ${e.id}: network: true or false is required`)
  if (!oneOf(e.locality, LOCALITY)) throw new Error(`executor ${e.id}: locality: ${LOCALITY.join(' or ')}`)
  if (!oneOf(e.latency, LATENCY)) throw new Error(`executor ${e.id}: latency: ${LATENCY.join(', ')}`)
  if (!oneOf(e.cost, COST)) throw new Error(`executor ${e.id}: cost: ${COST.join(', ')}`)
  if (!Array.isArray(e.credentials)) throw new Error(`executor ${e.id}: credentials: an array is required`)
  if (!Array.isArray(e.verification)) throw new Error(`executor ${e.id}: verification: an array is required`)
  if (e.maxInputBytes !== null && (!Number.isFinite(e.maxInputBytes) || e.maxInputBytes <= 0)) throw new Error(`executor ${e.id}: maxInputBytes: a positive number or null`)
  if (e.kind !== undefined && !oneOf(e.kind, KINDS)) throw new Error(`executor ${e.id}: kind: ${KINDS.join(', ')}`)
  return e
}

/**
 * The executors that can actually do this request, before Jev is asked.
 *
 * @param {Array<object>} executors every registered executor
 * @param {object} request
 * @param {string} [request.capability]        what the request needs
 * @param {string[]} [request.modalities]      what the input carries (default: text)
 * @param {boolean} [request.mutation]         true when files may be changed
 * @param {'local'|'hosted'} [request.locality] 'local' restricts everything to this PC, 'hosted'
 *   is the mirror and keeps everything off it. Only these two values do anything: an unknown
 *   string would filter nothing and read as "no restriction", so the caller must use one of them.
 * @param {boolean} [request.network]          false when there is no internet
 * @param {Set<string>} [request.available]    ids that are NOT usable right now (limits, signed out)
 * @param {Set<string>} [request.credentials]  credential names that exist; omit to skip the check
 * @param {number} [request.inputBytes]        size of the attached input
 */
export function eligible(executors, request = {}) {
  const wants = request.modalities ?? ['text']
  return executors.filter((e) => {
    if (request.capability && !e.capabilities.includes(request.capability)) return false
    if (!wants.every((m) => e.modalities.includes(m))) return false
    if (request.mutation && !e.mutation) return false
    if (request.locality === 'local' && e.locality !== 'local') return false
    if (request.locality === 'hosted' && e.locality === 'local') return false
    if (request.network === false && e.network) return false
    if (request.available?.has?.(e.id)) return false
    if (request.credentials && e.credentials.some((c) => !request.credentials.has(c))) return false
    if (e.maxInputBytes !== null && (request.inputBytes ?? 0) > e.maxInputBytes) return false
    return true
  })
}

const contextBytesOf = (a, local, localContextSize) => {
  const tokens = Number.isFinite(a.llm?.contextSize) && a.llm.contextSize > 0 ? a.llm.contextSize
    : local && Number.isFinite(localContextSize) && localContextSize > 0 ? localContextSize : null
  return tokens === null ? null : tokens * CHARS_PER_TOKEN
}

const COST_ORDER = { free: 0, subscription: 1, metered: 2 }
// The executor cost class for a marginal cost in the resources.js vocabulary: 'none' runs on this
// PC, 'low' draws on a window already paid for, 'metered' bills per token.
const COST_OF_MARGINAL = Object.freeze({ none: 'free', low: 'subscription', metered: 'metered' })
const LATENCY_ORDER = { fast: 0, medium: 1, slow: 2 }
const isTool = (e) => (e.kind === 'tool' ? 0 : 1)
const isLocal = (e) => (e.locality === 'local' ? 0 : 1)

/**
 * Cheapest-first ordering of the executors that could do the work.
 *
 * A deterministic tool that fully covers the request wins outright - it is exact, instant and
 * free. For a simple answer the fastest local model wins: free, private, no network. Otherwise
 * it is expected cost to a correct result, and latency breaks the tie.
 */
export function rank(list, { simple = false } = {}) {
  return [...list].sort((a, b) =>
    isTool(a) - isTool(b)
    || (simple
      ? isLocal(a) - isLocal(b) || LATENCY_ORDER[a.latency] - LATENCY_ORDER[b.latency]
      : COST_ORDER[a.cost] - COST_ORDER[b.cost] || LATENCY_ORDER[a.latency] - LATENCY_ORDER[b.latency])
    || a.id.localeCompare(b.id))
}

/** A registry of executors, so new ones are registered rather than branched on. */
export function createRegistry() {
  const byId = new Map()
  const api = {
    register(executor) {
      validateExecutor(executor)
      if (byId.has(executor.id)) throw new Error(`executor ${executor.id} is already registered`)
      const entry = Object.freeze({ kind: 'agent', description: null, ...executor })
      byId.set(executor.id, entry)
      return entry
    },
    all: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
    has: (id) => byId.has(id),
    /** Who can do this request, best first. */
    offered: (request = {}) => rank(eligible(api.all(), request), { simple: request.simple ?? request.capability === 'quick_answer' }),
    clear: () => byId.clear(),
  }
  return api
}

// What an agent can do, by what it is. Deliberately conservative: an agent is only credited
// with the web when it actually has the network, and with reading images when it really can,
// so the registry never promises a capability the executor would fail to deliver.
const AGENT_BASE = ['project_read', 'project_change', 'reasoned_answer', 'document_processing']
const IMAGE_WORK = ['ocr', 'image_inspection']

/**
 * Turn the live catalog into executor declarations.
 *
 * Everything here is a fact this process already knows - the agent's billing kind, the
 * manifest's role, whether it can be handed an image - so no model is asked what it can do.
 *
 * The cost class comes from the agent's billing kind (`a.kind`, which index.js sets through
 * accounts.js kindOf) and the operator's economics override, never from the provider's name:
 * rank() sorts on it, so a name test here would decide which executor a capability swap lands on.
 *
 * @param {object} p
 * @param {Array<object>} [p.agents]  config.agents entries (kind/provider/role/llm)
 * @param {Array<object>} [p.tools]   config.tools (deterministic scripts)
 * @param {Array<{provider: string, model: string, name?: string}>} [p.chat] chat models for direct answers
 * @param {(agentId: string) => boolean} [p.seesImages] agents that can be handed an image
 * @param {Record<string, {marginalCost?: string}>} [p.economics] config.resources.economics
 */
/**
 * Characters per token, in every context-size estimate: here, where an agent's context window
 * becomes a maximum input, and in decision.js contextEstimate, which sizes the request. Both sides
 * must use the same unit or the registry and the engine would disagree about what fits.
 */
export const CHARS_PER_TOKEN = 4

export function executorsFrom({ agents = [], tools = [], chat = [], seesImages = () => false, economics = {}, localContextSize = null } = {}) {
  const out = []
  for (const a of agents) {
    if (a.enabled === false) continue
    // An agent not yet stamped with its kind (a caller that skipped index.js) gets the one
    // accounts.js would give it: that is where billing knowledge lives, not here.
    const kind = Object.hasOwn(MARGINAL_COST_BY_KIND, a.kind) ? a.kind : kindOf(a)
    const local = kind === 'local'
    const override = economics?.[a.id]?.marginalCost
    const marginal = Object.hasOwn(COST_OF_MARGINAL, override) ? override : marginalCostOf({ ...a, kind })
    const capabilities = [...AGENT_BASE, ...(seesImages(a.id) ? IMAGE_WORK : [])]
    if (!local) capabilities.push('web_research') // a hosted agent can also look things up
    out.push(validateExecutor({
      id: a.id,
      name: a.name ?? a.id,
      kind: 'agent',
      description: a.description ?? null,
      capabilities,
      modalities: seesImages(a.id) ? ['text', 'image'] : ['text'],
      mutation: true,
      network: !local,
      locality: local ? 'local' : 'hosted',
      latency: local ? (a.role === 'fast' ? 'fast' : 'medium') : 'slow',
      cost: COST_OF_MARGINAL[marginal] ?? 'metered',
      credentials: a.credentialRef ? [a.credentialRef] : [],
      verification: ['checks', 'review'],
      // The context window, where one is known (a local model's, from its own setting or the
      // local-model default), as a maximum input in the same units the request is sized in. A
      // request that does not fit is a hard fact: eligible() drops the agent before any judgment.
      maxInputBytes: contextBytesOf(a, local, localContextSize),
    }))
  }
  for (const t of tools) {
    if (t.enabled === false) continue
    out.push(validateExecutor({
      id: `tool:${t.id}`,
      name: t.id,
      kind: 'tool',
      description: t.description ?? null,
      capabilities: ['deterministic_tool'],
      modalities: ['text'],
      mutation: true, // a registered script runs a command in the workspace
      network: false,
      locality: 'local',
      latency: 'fast',
      cost: 'free',
      credentials: [],
      verification: [],
      maxInputBytes: null,
    }))
  }
  for (const m of chat) {
    const local = m.provider === 'local'
    const image = seesImages(m.model) || seesImages(`${m.model}`)
    out.push(validateExecutor({
      id: `chat:${m.provider}/${m.model}`,
      name: m.name ?? m.model,
      kind: 'chat',
      description: m.name ?? null,
      capabilities: ['quick_answer', 'reasoned_answer', ...(image ? IMAGE_WORK : [])],
      modalities: image ? ['text', 'image'] : ['text'],
      mutation: false, // a direct answer never touches the project
      network: !local,
      locality: local ? 'local' : 'hosted',
      latency: local ? 'fast' : 'medium',
      cost: local ? 'free' : 'metered',
      credentials: [],
      verification: [],
      maxInputBytes: null,
    }))
  }
  return out
}
