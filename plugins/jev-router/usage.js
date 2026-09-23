// Usage: quota per agent (subscription windows, API balances, Jev spend), the
// ok / near / stopped / exhausted state the router acts on, and usage.jsonl.
// Remote reads are cached and rate-limited; state is recomputed from the cache
// on every snapshot, so a new exhaustion mark counts immediately.
import { spawn as nodeSpawn } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LIMITS, keyProviderOf, kindOf } from './accounts.js'
import { canAuth } from './setup.js'

const TTL = 3 * 60_000
const BACKOFF = 5 * 60_000
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6

/**
 * A prepaid balance as a share of the most that key has ever held. A subscription
 * has a window to divide by; a balance does not, so the high-water mark stands in
 * for one and a top-up resets it to full by raising the mark.
 * @returns 0-100, or null when there is nothing to compare against.
 */
export function creditPercent(balance, peak) {
  if (!balance || !peak || peak.currency !== balance.currency) return null
  const top = Number(peak.amount)
  if (!(top > 0)) return null
  return Math.max(0, Math.min(100, Math.round((Number(balance.amount) / top) * 100)))
}

const iso = (t) => (t == null ? null : new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t).toISOString())
const future = (t) => t && Date.parse(t) > Date.now()

/**
 * ok / near / stopped / exhausted / unknown. Unknown (fetch failed, no data) never blocks.
 * @param {{kind, windows?, balance?, limits, exhausted?, error?}} q
 */
export function stateOf({ kind, windows, balance, limits, exhausted, error }) {
  if (exhausted && future(exhausted.until)) return { state: 'exhausted', until: exhausted.until }
  if (kind === 'subscription') {
    if (!windows?.length) return { state: error ? 'unknown' : 'ok', until: null }
    const over = windows.filter((w) => w.usedPercent >= limits.stopAtPercent)
    if (over.length) return { state: 'stopped', until: over.map((w) => w.resetsAt).filter(Boolean).sort().at(-1) ?? null }
    return { state: windows.some((w) => w.usedPercent >= limits.handoffAtPercent) ? 'near' : 'ok', until: null }
  }
  if (kind === 'local') return { state: 'ok', until: null }
  if (balance && limits.minBalance != null && balance.amount < limits.minBalance) return { state: 'stopped', until: null }
  // Soft tier, mirroring handoffAtPercent: still usable, but Jev prefers others and the
  // agent is told to work in small steps and keep the handoff current.
  if (balance && limits.handoffAtBalance != null && balance.amount < limits.handoffAtBalance) return { state: 'near', until: null }
  return { state: error && !balance ? 'unknown' : 'ok', until: null }
}

/**
 * The longest window's percentage: the "weekly" one for both providers today, found by
 * duration rather than by name so a relabelled window cannot silently disable the gate.
 * Sub-day windows are ignored; a 5-hour window is not the resource the policy rations.
 * @returns 0-100, or null when no long window is known (never 0, which would read as "empty").
 */
export function longWindowPercent(windows) {
  const long = (windows ?? []).filter((w) => typeof w.usedPercent === 'number' && (w.minutes ?? 0) >= 1440)
  if (!long.length) return null
  return long.reduce((a, b) => ((a.minutes ?? 0) >= (b.minutes ?? 0) ? a : b)).usedPercent
}

// Exhaustion signals, per executor. Only failures count: a finished answer may talk about rate limits.
const LIMIT_TEXT = {
  'claude-code': /usage limit|rate[_ ]limit|hit your limit/i,
  codex: /usage limit|status failed: limit\b|"category":"limit"|usageLimitExceeded/i,
  api: /\bQUOTA\b|\b402\b|insufficient[\s_-]+(?:balance|quota|credits?)|quota[\s_-]+exceeded|usage[\s_-]+limit/i,
}
/** @returns {{hit: boolean, until?: string}} */
export function detectLimit(agentDef, result) {
  if (!result || result.stopReason === 'completed') return { hit: false }
  const d = result.diagnostic
  const text = `${typeof d === 'string' ? d : JSON.stringify(d ?? '')}\n${result.stopReason === 'error' ? result.answerText ?? '' : ''}`
  if (!(LIMIT_TEXT[agentDef.provider] ?? LIMIT_TEXT.api).test(text)) return { hit: false }
  // Claude reports "usage limit reached|<unix seconds>"; other tools give no reset time here.
  const ts = /\|(\d{10})\b/.exec(text)?.[1]
  return ts ? { hit: true, until: iso(Number(ts)) } : { hit: true }
}

/**
 * Short-lived `codex app-server` (stdio, newline-delimited JSON-RPC 2.0, same
 * framing as DSH's codex executor): initialize -> initialized -> requests, then kill.
 */
export function codexRpc(requests, { spawn = nodeSpawn, timeoutMs = 15_000 } = {}) {
  return new Promise((done, fail) => {
    const c = spawn('codex app-server', { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    const results = {}
    let buf = ''
    const stop = (err) => {
      clearTimeout(timer)
      c.stdin.end()
      // shell: true wraps codex in cmd.exe; kill the whole tree.
      if (process.platform === 'win32' && c.pid) nodeSpawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
      else c.kill()
      err ? fail(err) : done(results)
    }
    const timer = setTimeout(() => stop(new Error('codex app-server timed out')), timeoutMs)
    const send = (m) => c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
    c.on('error', stop)
    c.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineText = buf.slice(0, i); buf = buf.slice(i + 1)
        let m; try { m = JSON.parse(lineText) } catch { continue }
        if (m.id === 0) {
          if (m.error) return stop(new Error(`codex initialize: ${m.error.message}`))
          send({ method: 'initialized' })
          requests.forEach(([method, params], n) => send({ id: n + 1, method, params }))
        } else if (typeof m.id === 'number' && m.id > 0) {
          results[requests[m.id - 1][0]] = m.error ? { error: m.error.message } : m.result
          if (Object.keys(results).length === requests.length) stop()
        }
      }
    })
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'kz-harness', title: 'Kz-harness', version: '0.1.0' }, capabilities: { experimentalApi: false } } })
  })
}

/** One cached remote read: fresh for TTL, backs off after an error, one request in flight. */
function cached(fetcher, ttl = TTL) {
  let value = null
  let at = 0
  let backoffUntil = 0
  let pending = null
  return async (force = false) => {
    const now = Date.now()
    if (pending) return pending
    if (value && !force && now - at < ttl) return value
    if (now < backoffUntil) return value ?? { error: 'waiting before retrying' }
    pending = fetcher().then((v) => { value = v; at = Date.now(); return v }, (err) => {
      backoffUntil = Date.now() + (err.backoffMs ?? BACKOFF)
      value = { ...(value?.windows || value?.balance ? value : {}), error: err.message }
      return value
    }).finally(() => { pending = null })
    return pending
  }
}

/**
 * @param {object} p
 * @param {string} p.dataDir
 * @param {object} p.accounts   createAccounts() result
 * @param {Function} [p.fetch]
 * @param {Function} [p.spawn]
 * @param {string} [p.home]
 */
export function createUsage({ dataDir, accounts, fetch = globalThis.fetch, spawn = nodeSpawn, home = homedir() }) {
  const file = join(dataDir, 'usage.jsonl')

  const claude = cached(async () => {
    // Prefer the OMC statusline cache when it is fresh: one less call to a private endpoint.
    const omc = await readFile(join(home, '.claude', 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (omc?.data && !omc.error && Date.now() - omc.timestamp < TTL) {
      const d = omc.data
      // `via` names the source so the resource adapter can say how much to trust the figure.
      return { windows: [{ name: '5h', minutes: 300, usedPercent: d.fiveHourPercent, resetsAt: iso(d.fiveHourResetsAt) }, { name: 'weekly', minutes: 10080, usedPercent: d.weeklyPercent, resetsAt: iso(d.weeklyResetsAt) }], via: 'omc-cache' }
    }
    const cred = await readFile(join(home, '.claude', '.credentials.json'), 'utf8').then(JSON.parse).catch(() => null)
    const o = cred?.claudeAiOauth
    // Never refresh tokens here: Claude Code owns them.
    if (!o?.accessToken) throw new Error('not signed in to Claude')
    if (o.expiresAt && o.expiresAt < Date.now()) throw Object.assign(new Error('token expired: open Claude once to refresh'), { backoffMs: 60_000 })
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) throw new Error(`Claude usage HTTP ${r.status}`)
    const j = await r.json()
    return { windows: [['5h', j.five_hour, 300], ['weekly', j.seven_day, 10080]].filter(([, w]) => w).map(([name, w, minutes]) => ({ name, minutes, usedPercent: w.utilization, resetsAt: iso(w.resets_at) })), via: 'oauth-usage' }
  })

  const codex = cached(async () => {
    const r = await codexRpc([['account/rateLimits/read'], ['account/read', {}]], { spawn })
    const rl = r['account/rateLimits/read']?.rateLimits
    if (!rl) throw new Error(r['account/rateLimits/read']?.error ?? 'no rate limits from codex')
    // Carry the duration too: the gate finds the longest window by minutes rather than by
    // label, so a renamed window cannot silently switch the policy off.
    const win = (w, fallback) => w && { name: w.windowDurationMins === 300 ? '5h' : w.windowDurationMins === 10080 ? 'weekly' : fallback, minutes: w.windowDurationMins ?? null, usedPercent: w.usedPercent, resetsAt: iso(w.resetsAt) }
    const acct = r['account/read']?.account
    return { windows: [win(rl.primary, 'primary'), win(rl.secondary, 'secondary')].filter(Boolean), email: acct?.email ?? null, plan: acct?.planType ?? rl.planType ?? null, limitReached: rl.rateLimitReachedType ?? null, via: 'codex-app-server' }
  })

  const balances = new Map() // keyName -> cached fetcher
  const deepseekBalance = (name) => {
    if (!balances.has(name)) balances.set(name, cached(async () => {
      const key = await accounts.resolveKey('deepseek', name)
      if (!key) throw new Error('key value missing')
      const r = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`DeepSeek balance HTTP ${r.status}`)
      const j = await r.json()
      // An account can hold several currencies (e.g. USD 0.00 and CNY 364.02): show the one with money on it,
      // compare the user's minimum against that one.
      const b = [...(j.balance_infos ?? [])].sort((x, y) => Number(y.total_balance) - Number(x.total_balance))[0]
      return { balance: b ? { amount: Number(b.total_balance), currency: b.currency, available: j.is_available } : null, available: j.is_available }
    }))
    return balances.get(name)
  }

  const lines = () => readJsonl(file)
  const jevSpent = async () => {
    const month = new Date().toISOString().slice(0, 7)
    const out = {}
    for (const l of await lines()) if (l.agent === 'jev' && l.ts?.startsWith(month)) out[l.account] = (out[l.account] ?? 0) + (l.costUsd ?? 0)
    return out
  }

  const limitsOf = (id, kind) => ({ ...(DEFAULT_LIMITS[kind] ?? {}), ...accounts.cached().limits[id] })
  const exhaustedOf = (k) => accounts.cached().exhausted[k]

  /** Per-key state for api providers: exhausted mark, else balance below the provider agent's minBalance. */
  async function keyStates(force, minBalance) {
    const keys = accounts.cached().keys
    const spent = keys.jev?.length ? await jevSpent() : {}
    const out = {}
    for (const [provider, list] of Object.entries(keys)) {
      out[provider] = await Promise.all(list.map(async (k) => {
        const row = { name: k.name, active: !!k.active }
        const q = provider === 'deepseek' ? await deepseekBalance(k.name)(force) : null
        if (q) {
          row.balance = q.balance ?? null
          if (q.error) row.error = q.error
          // How much of this key's credit is left, against the most it has ever held.
          const peak = await accounts.notePeakBalance(provider, k.name, row.balance).catch(() => null)
          row.creditPercent = creditPercent(row.balance, peak)
          row.creditPeak = peak
        }
        if (provider === 'jev') row.spentUsd = spent[k.name] ?? 0
        const s = stateOf({ kind: 'api', balance: row.balance, limits: { minBalance: minBalance[provider] }, exhausted: exhaustedOf(`${provider}:${k.name}`), error: q?.error })
        return { ...row, state: s.state, until: s.until }
      }))
    }
    return out
  }

  async function snapshot(agents, { force = false } = {}) {
    await accounts.ready()
    const needs = new Set(agents.map((a) => a.provider))
    const [cq, xq] = await Promise.all([needs.has('claude-code') ? claude(force) : null, needs.has('codex') ? codex(force) : null])
    const claudeEmail = needs.has('claude-code') ? (await claudeLogin()).email : null
    const minBalance = {}
    for (const a of agents) { const p = keyProviderOf(a); if (p) minBalance[p] = limitsOf(a.id, 'api').minBalance }
    const keys = await keyStates(force, minBalance)
    const checkedAt = new Date().toISOString()
    const out = {}
    for (const a of agents) {
      const kind = kindOf(a)
      const limits = limitsOf(a.id, kind)
      const base = { kind, provider: a.provider, keyProvider: keyProviderOf(a), canSignIn: canAuth(a.provider), limits, windows: [], balance: null, creditPercent: null, spentUsd: null, error: null, checkedAt }
      if (kind === 'subscription') {
        const q = a.provider === 'claude-code' ? cq : a.provider === 'codex' ? xq : null
        // `via` and `plan` ride along for the resource adapters: where the figure came from, and
        // the plan name when the provider reports one (Codex does, Claude does not).
        Object.assign(base, { windows: q?.windows ?? [], error: q?.error ?? null, via: q?.via ?? null, plan: q?.plan ?? null, account: { label: a.provider === 'codex' ? 'ChatGPT' : 'Claude', email: a.provider === 'codex' ? q?.email ?? null : claudeEmail } })
        out[a.id] = { ...base, ...stateOf({ ...base, exhausted: exhaustedOf(a.id) }) }
        continue
      }
      const provider = keyProviderOf(a)
      const list = keys[provider] ?? []
      const active = list.find((k) => k.active)
      Object.assign(base, { account: { label: kind === 'local' ? 'free, local' : active?.name ?? a.credentialRef ?? provider ?? a.id }, balance: active?.balance ?? null, creditPercent: active?.creditPercent ?? null, creditPeak: active?.creditPeak ?? null, error: active?.error ?? null })
      const own = stateOf({ ...base, exhausted: exhaustedOf(a.id) })
      // With keys, the agent is out only when every key is: rotation moves past a spent active key.
      const usable = list.filter((k) => k.state === 'ok' || k.state === 'unknown')
      out[a.id] = own.state === 'exhausted' || !list.length ? { ...base, ...own }
        // The active key's own state carries the soft tier: keys are scored against minBalance
        // only, so without this "hand over below" never fires for an api agent.
        : usable.length ? { ...base, state: usable.some((k) => k.state === 'ok') ? (own.state === 'near' ? 'near' : 'ok') : 'unknown', until: null }
        : { ...base, state: list.every((k) => k.state === 'exhausted') ? 'exhausted' : 'stopped', until: list.map((k) => k.until).filter(Boolean).sort()[0] ?? null }
    }
    const jevKeys = keys.jev ?? []
    const jevActive = jevKeys.find((k) => k.active)
    out.jev = { kind: 'api', provider: 'jev', keyProvider: 'jev', account: { label: jevActive?.name ?? 'default' }, windows: [], balance: null, spentUsd: jevKeys.reduce((s, k) => s + (k.spentUsd ?? 0), 0), limits: limitsOf('jev', 'jev'), state: jevKeys.length && jevKeys.every((k) => k.state === 'exhausted') ? 'exhausted' : 'ok', until: null, error: null, checkedAt }
    last = { out, keys }
    return out
  }
  let last = null

  let claudeLoginCache = null
  const claudeLogin = async () => {
    if (!claudeLoginCache || Date.now() - claudeLoginCache.at > 5 * 60_000) claudeLoginCache = { at: Date.now(), value: accounts.claudeStatus().catch(() => ({ email: null })) }
    return claudeLoginCache.value
  }

  const append = async (entry) => {
    await mkdir(dataDir, { recursive: true })
    await appendFile(file, `${JSON.stringify(entry)}\n`)
  }

  return {
    snapshot,
    /** Last snapshot { out, keys }, synchronously; null before the first. */
    last: () => last,
    codexAccount: async () => { const q = await codex(); return q.email ? { email: q.email, planType: q.plan } : null },
    resetLogin: () => { claudeLoginCache = null },
    markExhausted: (key, v) => accounts.markExhausted(key, v),
    clearExpired: () => accounts.clearExpired(),
    logAttempt: (entry) => append({ ts: new Date().toISOString(), ...entry, limitHit: !!entry.limitHit }),
    logJev: ({ tokens, ...entry }) => append({
      ts: new Date().toISOString(), agent: 'jev', ...entry,
      tokens: { input: tokens?.input ?? 0, output: tokens?.output ?? 0 },
      costUsd: (tokens?.input ?? 0) * JEV_USD_PER_INPUT_TOKEN,
    }),
    recent: async (n = 50) => (await lines()).slice(-n),
    lines,
    /** "Saved by Jev" estimate over usage.jsonl and history.jsonl; see computeSavings. */
    savings: async ({ historyFile = join(dataDir, 'history.jsonl'), now, ...opts } = {}) =>
      computeSavings(await lines(), await readJsonl(historyFile), opts, now),
  }
}

async function readJsonl(path) {
  const raw = await readFile(path, 'utf8').catch(() => '')
  // ponytail: reads the whole log; tail-read or monthly rotation if it grows past a few MB.
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

export const DEFAULT_BASELINE = { name: 'Chat LLM front desk (DeepSeek Flash)', inputPerMTok: 0.28, outputPerMTok: 1.1, outputTokens: 300, latencyMs: 4000 }
const JEV_FALLBACK_MS = 800 // Jev call time when the log line predates `ms`
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/**
 * Estimate of what Jev saved compared with a chat LLM front desk making the same decisions.
 *   decision (every Jev route/review/intent call): LLM cost = (input x inputPerMTok + outputTokens x outputPerMTok) / 1e6,
 *     Jev cost = logged costUsd (input x $0.042/M, output free); time saved = latencyMs - Jev ms (800 when unlogged).
 *   direct answer (question answered by the chat model, no agent): time saved = agent median - answer time.
 *   tool run (a tool did the work, review accepted, no agent ran): time saved = agent median - tool time.
 *   limits avoided: agents skipped at routing for being stopped/exhausted, plus limit hits moved to a
 *     rotated key or a peer, in runs that did not end paused. Counted, not priced.
 * Agent median = median durationMs of completed primary agent attempts, all time; agentMedianFallbackMs when none.
 * No clamping: a negative saving is reported as negative.
 * @param {object[]} usage usage.jsonl lines
 * @param {object[]} runs  history.jsonl records
 */
export function computeSavings(usage, runs, { baseline = DEFAULT_BASELINE, agentMedianFallbackMs = 10_000 } = {}, now = Date.now()) {
  const b = { ...DEFAULT_BASELINE, ...baseline }
  const done = usage.filter((l) => l.agent !== 'jev' && l.agent !== 'chat' && l.role === 'primary' && l.stopReason === 'completed' && Number.isFinite(l.durationMs)).map((l) => l.durationMs)
  const agentMs = done.length ? median(done) : agentMedianFallbackMs
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0)
  const starts = { today: midnight.getTime(), week: now - 7 * 86_400_000, all: -Infinity }
  const periods = {}
  for (const [name, since] of Object.entries(starts)) {
    const within = (x) => Date.parse(x.ts) >= since
    const p = { decisions: 0, jevCostUsd: 0, llmCostUsd: 0, savedUsd: 0, savedMs: 0, llmOutputTokensAvoided: 0, jevTokens: { input: 0, output: 0 }, directAnswers: 0, toolRuns: 0, limitsAvoided: 0 }
    for (const l of usage.filter(within)) {
      if (l.agent === 'jev') {
        const input = l.tokens?.input ?? 0
        p.decisions++
        p.jevTokens.input += input
        p.jevTokens.output += l.tokens?.output ?? 0
        p.jevCostUsd += l.costUsd ?? input * JEV_USD_PER_INPUT_TOKEN
        p.llmCostUsd += (input * b.inputPerMTok + b.outputTokens * b.outputPerMTok) / 1e6
        p.llmOutputTokensAvoided += b.outputTokens
        p.savedMs += b.latencyMs - (l.ms ?? JEV_FALLBACK_MS)
      } else if (l.agent === 'chat' && l.role === 'direct-answer') {
        p.directAnswers++
        p.savedMs += agentMs - (l.durationMs ?? 0)
      }
    }
    for (const r of runs.filter(within)) {
      const work = (r.attempts ?? []).filter((a) => a.role !== 'review')
      if (work.length === 1 && work[0].role === 'tool' && r.finalStatus?.startsWith('accepted')) {
        p.toolRuns++
        p.savedMs += agentMs - (work[0].durationMs ?? 0)
      }
      if (r.finalStatus !== 'paused_limit') {
        const ev = r.limits ?? []
        // availability.out = agents out at routing + agents that hit a limit without a key to rotate to.
        const skipped = (r.availability?.out?.length ?? 0) - ev.filter((e) => e.action !== 'rotated').length
        p.limitsAvoided += Math.max(0, skipped) + ev.filter((e) => e.action === 'rotated' || e.action === 'peer').length
      }
    }
    p.savedUsd = p.llmCostUsd - p.jevCostUsd
    periods[name] = p
  }
  return {
    periods,
    assumptions: {
      ...b,
      jevInputPerMTok: JEV_USD_PER_INPUT_TOKEN * 1e6,
      jevOutputPerMTok: 0,
      jevFallbackMs: JEV_FALLBACK_MS,
      agentMedianMs: agentMs,
      agentMedianSamples: done.length,
      agentMedianFallbackMs,
    },
  }
}

// A rate over a handful of runs is noise: trackRecord already withholds an agent's accepted
// rate below 3 attempts. A calibration curve is a stronger claim than one rate, so the bar is
// higher here, and a bucket under it reports its count with no rate at all.
export const MIN_CALIBRATION_SAMPLES = 10

const workAttempts = (r) => (r.attempts ?? []).filter((a) => a.role === 'primary' || a.role === 'retry')
/**
 * A usage limit stops a run for lack of allowance, and a continued run did not start from this
 * route, so neither says anything about the pick. Dropped, not counted as failures.
 */
const scorable = (r) => !r.continuedFromHandoff && r.finalStatus !== 'paused_limit' && !(r.attempts ?? []).some((a) => a.limitHit)
/** The agent Jev picked did the work that was accepted, and the run never fell through to a peer. */
const pickWorked = (r) => String(r.finalStatus).startsWith('accepted') && workAttempts(r).at(-1)?.agent === r.routing?.primaryAgent
const r2 = (x) => Math.round(x * 100) / 100

/**
 * Calibration: when Jev said it was X% sure of the agent, how often was it right? Buckets runs by
 * routing.agentConfidence decile and reports count, mean confidence and observed success rate per
 * bucket, with the sample size beside every number.
 *
 * Right is `pickWorked` above, not raw finalStatus: a run whose peer rescued it is a wrong pick
 * even though the work was accepted. Everything else scorable counts as wrong, and that includes
 * needs_human, which reflects the reviewer's bar as much as the router's pick, so this measures
 * "the pick carried the run on its own" and nothing finer. Read `scored` before any rate: below
 * `minSamples` the rate is null on purpose, because a curve drawn from 3 runs is worse than none.
 *
 * Pure and read-only: rows in, plain object out. No fetch, no write, no Jev call.
 * @param {object[]} runs history.jsonl records
 */
export function calibration(runs, { minSamples = MIN_CALIBRATION_SAMPLES } = {}) {
  const raw = Array.from({ length: 10 }, () => ({ n: 0, successes: 0, sum: 0 }))
  let noConfidence = 0
  let unscorable = 0
  for (const r of runs ?? []) {
    const c = r.routing?.agentConfidence
    if (!(Number.isFinite(c) && c >= 0 && c <= 1)) { noConfidence++; continue }
    if (!scorable(r)) { unscorable++; continue }
    // Confidence 1 belongs in the top decile, not an eleventh bucket of its own.
    const b = raw[Math.min(9, Math.floor(c * 10))]
    b.n++
    b.sum += c
    if (pickWorked(r)) b.successes++
  }
  const rateOf = (n, successes) => (n >= minSamples ? r2(successes / n) : null)
  const buckets = raw.map((b, i) => ({
    range: `${i / 10}-${(i + 1) / 10}`,
    n: b.n,
    successes: b.successes,
    meanConfidence: b.n ? r2(b.sum / b.n) : null,
    successRate: rateOf(b.n, b.successes),
  }))
  const scored = raw.reduce((s, b) => s + b.n, 0)
  const successes = raw.reduce((s, b) => s + b.successes, 0)
  const enough = buckets.filter((b) => b.successRate !== null).length
  return {
    label: 'the agent Jev picked did the accepted work, no peer fallback, no limit, no handoff',
    minSamples,
    runs: (runs ?? []).length,
    scored,
    skipped: { noConfidence, unscorable },
    overall: {
      n: scored,
      successes,
      meanConfidence: scored ? r2(raw.reduce((s, b) => s + b.sum, 0) / scored) : null,
      successRate: rateOf(scored, successes),
    },
    buckets,
    note: enough
      ? `${enough} of 10 deciles have at least ${minSamples} scored runs; the rest report counts only`
      : `not enough data: no decile has ${minSamples} scored runs (${scored} scored in total), counts only`,
  }
}
