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
 * The decider's 'auto': trivial tasks low, cheap ones medium, most high, hard or risky xhigh.
 * Never max or ultra. `bands` are the cuts on the larger of complexity and risk, from the record of
 * the provider that decided (thresholds.effortBands); the default is Jev's. Each key names the
 * level under its cut, as riskBands does, so the ladder starts at low: with medium as the first
 * cut, low could not be reached from any answer at all. Unknown reads 0.5.
 */
export function autoLevel({ complexity, risk } = {}, bands = { low: 0.125, medium: 0.375, high: 0.6 }) {
  const x = Math.max(complexity ?? 0.5, risk ?? 0.5)
  return x < (bands.low ?? 0) ? 'low' : x < bands.medium ? 'medium' : x < bands.high ? 'high' : 'xhigh'
}

// The rungs Auto may be moved along by your ratings (effortBias): never to max or ultra, as Auto
// itself never goes there.
const AUTO_RUNGS = ['low', 'medium', 'high', 'xhigh']

/**
 * The unified level an agent runs at, read one way by toAgentEffort and by whatever names the plan:
 * the agent's own Settings value, else the level asked, else Auto from complexity and risk, moved
 * `shift` rungs (-1, 0 or +1, effortBias) within low to xhigh. Only Auto moves: a level picked in the
 * model menu or in Settings is kept as it was picked.
 */
export function unifiedLevel(level, { complexity, risk, override, bands, shift = 0 } = {}) {
  if (override) return override
  if (level && level !== 'auto') return level
  const auto = autoLevel({ complexity, risk }, bands)
  const at = AUTO_RUNGS.indexOf(auto) + (Number.isInteger(shift) ? shift : 0)
  return AUTO_RUNGS[Math.max(0, Math.min(AUTO_RUNGS.length - 1, at))]
}

/**
 * Effort value to send to one agent, or null to leave its default.
 * @param {string} level  unified level (LEVELS)
 * @param {object} agentDef
 * @param {{complexity?: number, risk?: number, override?: string, model?: string, bands?: {low?: number, medium: number, high: number}, shift?: number}} [jev]
 *   override: the agent's own value from Settings (wins over level); bands: autoLevel's cuts;
 *   shift: the rungs your ratings move Auto by (unifiedLevel)
 */
export function toAgentEffort(level, agentDef, { complexity, risk, override, model, bands, shift } = {}) {
  const family = effortFamily(agentDef)
  if (!family) return null
  // A local-* level names a model, not an effort: the agent keeps its own default.
  if (isLocalLevel(override || level)) return null
  const l = unifiedLevel(level, { complexity, risk, override, bands, shift })
  if (family === 'claude') return CLAUDE[l] ?? null
  if (family === 'deepseek') return DEEPSEEK[l] ?? null
  const i = CODEX_ORDER.indexOf(l)
  if (i < 0) return null
  const top = CODEX_ORDER.indexOf(codexTop(agentDef, model))
  return CODEX_ORDER[Math.min(i, top)]
}

/** Codex service tier for a speed setting: 1.5x is 'priority', normal leaves the default. */
export const codexServiceTier = (speed) => (speed === 'fast' ? 'priority' : null)

/**
 * The speed an agent's attempt runs at, from Settings, Effort: Codex's 'normal' or 'fast' (1.5x),
 * 'fast-mode' for Claude Code's fast mode, and null for Claude Code at normal speed or any other agent.
 */
export function agentSpeed(family, effortSettings) {
  if (family === 'codex') return effortSettings?.codexSpeed ?? null
  if (family === 'claude') return effortSettings?.claudeSpeed === 'fast' ? 'fast-mode' : null
  return null
}

/** KZ_CLAUDE_FAST_MODE for a speed: '1' has the patched connector ask the SDK for fast mode, anything else leaves it off. */
export const claudeFastMode = (speed) => (speed === 'fast-mode' ? '1' : null)

/** What a speed adds to the effort the task list and the replies show: Codex's 1.5x, Claude Code's fast mode. */
export const speedWord = (speed) => (speed === 'fast' ? ' 1.5x' : speed === 'fast-mode' ? ', fast mode' : '')

// ---- what your ratings say of Auto effort (docs/live-agent-view.md Feature 4) ----

/** The efforts a rating can name, weakest first: the unified levels a verdict about the pick takes. */
const RATED = ['low', 'medium', 'high', 'xhigh', 'max']
/** How many of the newest `wrong effort` ratings of one agent family and task type are read, and how many must agree. */
export const RATINGS_READ = 5
export const RATINGS_AGREE = 3

/**
 * The level a `wrong effort` rating is read against: the one Auto would have chosen, before your
 * ratings moved it (`planUnmoved`, stamped when they had), else the level the plan ran at
 * (`planLevel`). Against the moved level, a rating that asked for Auto's own level read as a vote
 * past it, and three of them moved Auto a step beyond what they asked for.
 */
const ratedAgainst = (r) => (RATED.includes(r?.planUnmoved) ? r.planUnmoved : r?.planLevel)

/**
 * The newest `wrong effort` ratings of one agent family on one task type since `resetAt`, at most
 * RATINGS_READ of them: `up` say the pick ran too low (the effort it should have run at is above the
 * level Auto would have chosen, ratedAgainst), `down` too high, of `n` read. A rating whose plan ran
 * at no unified level says neither, nor does one that names the level Auto would have chosen, which
 * counts among the `n` read and so takes the place of an older one that moved it. Rows are
 * feedback.js rows as stored, which index.js stamps with the plan's family, levels and task type
 * (acceptVerdict, or bindRun for a rating given before routing picked anything).
 */
export function effortVotes(rows, family, taskType, resetAt = null) {
  // A rating given before the last Reset is read no more; one whose time cannot be read, once there
  // has been a Reset, cannot be shown to come after it.
  const since = resetAt ? Date.parse(resetAt) : NaN
  const after = (r) => Number.isNaN(since) || Date.parse(r.ts) >= since
  const read = (rows ?? []).filter((r) => r?.about === 'plan' && r.verdict === 'dislike' && r.tag === 'wrong effort'
    && r.planFamily === family && r.taskType === taskType && RATED.includes(r.suggestedEffort) && RATED.includes(ratedAgainst(r))
    && after(r)).slice(-RATINGS_READ)
  return { up: read.filter((r) => ratingWay(r) > 0).length, down: read.filter((r) => ratingWay(r) < 0).length, n: read.length }
}

/** Which way one `wrong effort` rating says Auto should go: +1 up, -1 down, 0 for none it can say. */
export const ratingWay = (r) => (RATED.includes(r?.suggestedEffort) && RATED.includes(ratedAgainst(r)) ? Math.sign(RATED.indexOf(r.suggestedEffort) - RATED.indexOf(ratedAgainst(r))) : 0)

/**
 * The rungs your ratings move Auto effort by for one agent family on one task type: +1 when at least
 * RATINGS_AGREE of its newest RATINGS_READ `wrong effort` ratings since `resetAt` say it ran too low,
 * -1 when they say too high, else 0.
 */
export function effortBias(rows, family, taskType, resetAt = null) {
  const { up, down } = effortVotes(rows, family, taskType, resetAt)
  return up >= RATINGS_AGREE ? 1 : down >= RATINGS_AGREE ? -1 : 0
}

/**
 * Every agent family and task type your ratings move Auto effort for now, as Settings, Effort lists
 * them: `{ family, taskType, shift, agree, n }`, `agree` of the `n` ratings read saying so.
 */
export function effortBiases(rows, resetAt = null) {
  const pairs = new Map()
  for (const r of rows ?? []) if (r?.about === 'plan' && r.tag === 'wrong effort' && r.planFamily && r.taskType) pairs.set(`${r.planFamily}\u0000${r.taskType}`, [r.planFamily, r.taskType])
  const out = []
  for (const [family, taskType] of pairs.values()) {
    const v = effortVotes(rows, family, taskType, resetAt)
    const shift = effortBias(rows, family, taskType, resetAt)
    if (shift) out.push({ family, taskType, shift, agree: shift > 0 ? v.up : v.down, n: v.n })
  }
  return out
}
