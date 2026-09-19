// One effort ladder for Jev Auto, mapped to what each agent accepts.
// Claude Code (CLAUDE_CODE_EFFORT_LEVEL): low medium high xhigh max.
// Codex app-server turn effort: low medium high xhigh max ultra (clamped per model).
// DeepSeek via pi-ai (agentOptions.reasoningEffort): off low high max.
// Local llama.cpp and other API models: null (their own defaults).
export const LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const CLAUDE = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' }
const DEEPSEEK = { off: 'off', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
const CODEX_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
// Highest effort per Codex model (live model/list, codex-cli 0.145.0); unknown models get all six.
const CODEX_TOP = { 'gpt-5.5': 'xhigh', 'gpt-5.6-luna': 'max' }

/** 'claude' | 'codex' | 'deepseek' | null: whose effort vocabulary an agent speaks. */
export function effortFamily(agentDef) {
  if (!agentDef) return null
  if (agentDef.provider === 'claude-code') return 'claude'
  if (agentDef.provider === 'codex') return 'codex'
  if (agentDef.llm?.provider === 'deepseek' || agentDef.llm?.provider === 'deepseek-official') return 'deepseek'
  return null
}

/** Jev's 'auto': cheap tasks medium, most high, hard or risky xhigh. Never ultra. */
export function autoLevel({ complexity, risk } = {}) {
  const x = Math.max(complexity ?? 0.5, risk ?? 0.5)
  return x < 0.25 ? 'medium' : x < 0.6 ? 'high' : 'xhigh'
}

/**
 * Effort value to send to one agent, or null to leave its default.
 * @param {string} level  unified level (LEVELS)
 * @param {object} agentDef
 * @param {{complexity?: number, risk?: number, override?: string, model?: string}} [jev]
 *   override: the agent's own value from Settings (wins over level)
 */
export function toAgentEffort(level, agentDef, { complexity, risk, override, model } = {}) {
  const family = effortFamily(agentDef)
  if (!family) return null
  const l = override || (!level || level === 'auto' ? autoLevel({ complexity, risk }) : level)
  if (family === 'claude') return CLAUDE[l] ?? null
  if (family === 'deepseek') return DEEPSEEK[l] ?? null
  const i = CODEX_ORDER.indexOf(l)
  if (i < 0) return null
  const top = CODEX_ORDER.indexOf(CODEX_TOP[model] ?? (model ? 'ultra' : 'xhigh'))
  return CODEX_ORDER[Math.min(i, top)]
}

/** Codex service tier for a speed setting: 1.5x is 'priority', normal leaves the default. */
export const codexServiceTier = (speed) => (speed === 'fast' ? 'priority' : null)
