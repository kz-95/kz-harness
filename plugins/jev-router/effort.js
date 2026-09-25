// One effort ladder for Jev Auto, mapped to what each agent accepts.
// Claude Code (CLAUDE_CODE_EFFORT_LEVEL): low medium high xhigh max ultracode.
// Codex app-server turn effort: low medium high xhigh max ultra (clamped per model).
// DeepSeek via pi-ai (agentOptions.reasoningEffort): off low high max.
// Local llama.cpp and other API models: null (their own defaults).
export const LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'local-low', 'local-high']

// Two of those levels are not efforts at all: they say "run this on the small local
// model" or "on the big one". They pick the agent, and local models take no effort
// value, so every mapping below leaves them null.
export const LOCAL_LEVELS = { 'local-low': 'small', 'local-high': 'large' }
export const isLocalLevel = (level) => Object.hasOwn(LOCAL_LEVELS, level ?? '')

// What a local model is for, from the manifest's own `role`. File size says almost
// nothing about speed here: Gemma 4 E4B is the larger file yet runs ~47 tok/s to
// Qwen3 8B's ~8, because only ~4B of its parameters are active. A model with no
// role sits in the middle and is separated by size.
const ROLE_RANK = { fast: 0, balanced: 1, 'best-quality': 2 }
const rankOf = (a) => ROLE_RANK[a.role] ?? 1

/**
 * Quickest first, by the manifest's `role` and then by file size (a tie falls back to the
 * smaller file, which is the better guess). One rule in one place: the effort ladder, offline
 * mode and the local chat model must never disagree about which installed model is the fast one.
 */
export const byQuickness = (a, b) => rankOf(a) - rankOf(b) || (a.size ?? Infinity) - (b.size ?? Infinity)

/** The quickest of these local models (a manifest entry or an agent), or null for none. */
export const quickestLocal = (models = []) => [...models].sort(byQuickness)[0] ?? null

/**
 * The local agent a local-* level means: the quickest installed model for
 * `local-low`, the strongest for `local-high`. Ranked by the manifest's `role`,
 * so installing another model sorts itself in without touching this code.
 * @param {string} level
 * @param {Array<{id: string, kind?: string, role?: string, size?: number}>} agents enabled agents
 * @returns the agent id, or null when no local model is installed
 */
export function localAgentFor(level, agents = []) {
  const want = LOCAL_LEVELS[level]
  if (!want) return null
  const local = agents.filter((a) => a.kind === 'local' && a.enabled !== false)
  if (!local.length) return null
  const sorted = [...local].sort(byQuickness)
  return (want === 'small' ? sorted[0] : sorted[sorted.length - 1]).id
}

// Claude Code's own ladder: its top rung is spelled 'ultracode', which is what the
// Ultra label in adapter.js has always advertised.
const CLAUDE = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultracode' }
const DEEPSEEK = { off: 'off', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
// Codex app-server effort ladder, weakest to strongest.
const CODEX_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

// Which Codex model families top out below the full ladder, first match wins. This is a
// fallback, not the whole truth: a declared capability list beats it, and a model that
// matches nothing is assumed to take all six rungs, so a model newer than this list is
// never silently capped. Adding a family is one line here. Source: Codex model/list,
// codex-cli 0.145.0: every gpt-5.6 variant (astra, sol, terra, luna, …) takes ultra.
const CODEX_CEILINGS = [
  { pattern: /^gpt-5\.5(?:$|[-.])/, top: 'xhigh' },
  { pattern: /^gpt-5\.6(?:$|[-.])/, top: 'ultra' },
]
const fullLadder = CODEX_ORDER[CODEX_ORDER.length - 1]

/**
 * The strongest effort a model says it supports, from the agent's own model list:
 * `{ models: [{ id, reasoning: { efforts: [{ id }] } }] }`, the same shape adapter.js
 * publishes. Live declaration wins over CODEX_CEILINGS, so a connector that reports
 * capabilities needs no change here. Null when nothing is declared for this model.
 */
function declaredTop(agentDef, model) {
  const declared = agentDef?.models?.find((m) => m.id === model)?.reasoning?.efforts
  if (!Array.isArray(declared) || !declared.length) return null
  const rungs = declared.map((e) => CODEX_ORDER.indexOf(e?.id)).filter((i) => i >= 0)
  return rungs.length ? CODEX_ORDER[Math.max(...rungs)] : null
}

/** Highest Codex effort for a model id: its own declaration, else the family rule. */
function codexTop(agentDef, model) {
  const declared = declaredTop(agentDef, model)
  if (declared) return declared
  // No model name at all tells us nothing, so keep the old conservative xhigh.
  if (!model) return 'xhigh'
  const id = String(model).toLowerCase()
  return CODEX_CEILINGS.find((r) => r.pattern.test(id))?.top ?? fullLadder
}

/** 'claude' | 'codex' | 'deepseek' | null: whose effort vocabulary an agent speaks. */
export function effortFamily(agentDef) {
  if (!agentDef) return null
  if (agentDef.provider === 'claude-code') return 'claude'
  if (agentDef.provider === 'codex') return 'codex'
  if (agentDef.llm?.provider === 'deepseek' || agentDef.llm?.provider === 'deepseek-official') return 'deepseek'
  return null
}

/**
 * The decider's 'auto': cheap tasks medium, most high, hard or risky xhigh. Never ultra. `bands`
 * are the cuts on the larger of complexity and risk, from the record of the provider that
 * decided (thresholds.effortBands); the default is Jev's.
 */
export function autoLevel({ complexity, risk } = {}, bands = { medium: 0.25, high: 0.6 }) {
  const x = Math.max(complexity ?? 0.5, risk ?? 0.5)
  return x < bands.medium ? 'medium' : x < bands.high ? 'high' : 'xhigh'
}

/**
 * Effort value to send to one agent, or null to leave its default.
 * @param {string} level  unified level (LEVELS)
 * @param {object} agentDef
 * @param {{complexity?: number, risk?: number, override?: string, model?: string, bands?: {medium: number, high: number}}} [jev]
 *   override: the agent's own value from Settings (wins over level); bands: autoLevel's cuts
 */
export function toAgentEffort(level, agentDef, { complexity, risk, override, model, bands } = {}) {
  const family = effortFamily(agentDef)
  if (!family) return null
  // A local-* level names a model, not an effort: the agent keeps its own default.
  if (isLocalLevel(override || level)) return null
  const l = override || (!level || level === 'auto' ? autoLevel({ complexity, risk }, bands) : level)
  if (family === 'claude') return CLAUDE[l] ?? null
  if (family === 'deepseek') return DEEPSEEK[l] ?? null
  const i = CODEX_ORDER.indexOf(l)
  if (i < 0) return null
  const top = CODEX_ORDER.indexOf(codexTop(agentDef, model))
  return CODEX_ORDER[Math.min(i, top)]
}

/** Codex service tier for a speed setting: 1.5x is 'priority', normal leaves the default. */
export const codexServiceTier = (speed) => (speed === 'fast' ? 'priority' : null)
