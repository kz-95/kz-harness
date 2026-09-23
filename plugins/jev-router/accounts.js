// Accounts: API keys per provider. A key's value lives in exactly one place,
// ~/.dsh/.env; everything else refers to it by variable name. Per-agent
// limits, exhaustion marks, and the subscription tools' own login/logout.
// Metadata lives in accounts.json; no function here ever returns a key value
// except resolveKey, which is server-internal.
import { exec, spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const KEY_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex']
// An api key gets the same two tiers a subscription has: a soft one that hands the
// work over while there is still credit to finish cleanly, and a hard floor that
// refuses to start. In the key's own currency, so a CNY balance means CNY figures.
export const DEFAULT_LIMITS = {
  subscription: { handoffAtPercent: 85, stopAtPercent: 97 },
  api: { minBalance: 5, handoffAtBalance: 10 },
  // TypeSafe exposes no balance endpoint (its SDK has only /v1/models and /v1/systemone),
  // so Jev is measured by what this harness has spent, against a budget you set.
  jev: { monthlyBudgetUsd: 5 },
}
const envName = (provider, name) => `KZ_KEY__${provider}__${name}`
// Env var that DSH itself reads for a provider's active key.
const ACTIVE_ENV = { deepseek: 'DEEPSEEK_API_KEY' }

/** 'local' agents run a model on this PC (llama.cpp): free, no keys, no quota. */
export const kindOf = (a) => (SUBSCRIPTION_PROVIDERS.includes(a.provider) ? 'subscription' : a.llm?.provider === 'local' ? 'local' : 'api')
// What one more job on an agent costs at the margin, in the resources.js vocabulary. Who funds
// the tokens is an ACCOUNT fact, so it is answered here with the rest of the billing knowledge
// and routing asks for the property instead of testing a provider name. A live ResourceSnapshot
// and the operator's config.resources.economics override both outrank this: it is only the
// answer when nothing else has said anything.
export const MARGINAL_COST_BY_KIND = Object.freeze({ local: 'none', subscription: 'low', api: 'metered' })
export const marginalCostOf = (a) => (a ? MARGINAL_COST_BY_KIND[a.kind] ?? MARGINAL_COST_BY_KIND[kindOf(a)] : null) ?? 'metered'
/** Key provider an api agent draws from: 'deepseek' for DSH's DeepSeek, else its BYOK llm provider. */
export const keyProviderOf = (a) => (a.provider !== 'spawn' || a.llm?.provider === 'local' ? null : a.llm?.provider === 'deepseek-official' ? 'deepseek' : a.llm?.provider ?? null)

// --- .env ---------------------------------------------------------------
const unquote = (v) => {
  const t = v.trim()
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t
}
export function parseEnv(text) {
  const out = new Map()
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=(.*)$/.exec(l)
    if (m) out.set(m[1], unquote(m[2]))
  }
  return out
}
/** Set (string) or remove (null) the given names; every other line is kept as is. */
export function setEnvLines(text, updates) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  if (lines.at(-1) === '') lines.pop()
  const left = new Map(Object.entries(updates))
  const out = []
  for (const l of lines) {
    const name = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(l)?.[1]
    if (name === undefined || !left.has(name)) { out.push(l); continue }
    const v = left.get(name)
    left.delete(name)
    if (v !== null) out.push(`${name}=${v}`)
  }
  for (const [name, v] of left) if (v !== null) out.push(`${name}=${v}`)
  return out.length ? `${out.join(eol)}${eol}` : ''
}
export async function readEnvFile(file) {
  try { return await readFile(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return ''; throw err }
}
export async function writeEnvFile(file, updates) {
  const next = setEnvLines(await readEnvFile(file), updates)
  const tmp = `${file}.tmp`
  await writeFile(tmp, next, { mode: 0o600 })
  await rename(tmp, file)
}

// --- /use ---------------------------------------------------------------
const ALIASES = { gpt: 'codex', chatgpt: 'codex', openai: 'codex', ds: 'deepseek', cc: 'claude' }
/** `/use claude ds` -> ['claude', 'deepseek']; 'all' -> every id. Throws on unknown names. */
export function parseUse(input, ids) {
  const words = String(input).toLowerCase().split(/[\s,+&]+/).filter((w) => w && w !== 'and' && w !== 'only')
  if (!words.length) throw new Error(`usage: /use <agents…> or /use all (agents: ${ids.join(', ')})`)
  if (words.includes('all')) return [...ids]
  const picked = words.map((w) => ALIASES[w] ?? w)
  const unknown = picked.filter((w) => !ids.includes(w))
  if (unknown.length) throw new Error(`unknown agent ${unknown.join(', ')}; agents: ${ids.join(', ')}`)
  return [...new Set(picked)]
}

// Fixed command strings only (never user input); a shell so Windows finds the .cmd shims.
const sh = (command, timeoutMs = 20_000) => new Promise((done) => {
  exec(command, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout}${stderr}`.trim() }))
})
const LOGIN = { claude: ['Claude login', 'claude auth login'], codex: ['ChatGPT login', 'codex login'] }
const LOGOUT = { claude: 'claude auth logout', codex: 'codex logout' }

/**
 * @param {object} p
 * @param {string} p.dataDir
 * @param {string} p.envFile              ~/.dsh/.env
 * @param {object} [p.credentials]        DSH credentials service (resolve/describe/unset); values are never written to it
 * @param {string} [p.jevCredentialRef]   Jev key used when no jev key is registered
 * @param {Function} [p.codexAccount]     async () => {email, planType} | null
 * @param {Function} [p.run]              shell runner, injectable for tests
 * @param {Function} [p.open]             opens a visible console running a command
 */
export function createAccounts({ dataDir, envFile, credentials, jevCredentialRef = 'TYPESAFE_API_KEY', codexAccount, run = sh, open = openConsole }) {
  const file = join(dataDir, 'accounts.json')
  const read = async () => {
    let raw
    try { raw = await readFile(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return { keys: {}, limits: {}, exhausted: {} }; throw err }
    const s = JSON.parse(raw) // damaged file must throw, not read as empty and be overwritten
    // peakBalance must be read back or every mutate() erases the high-water marks.
    return { keys: s.keys ?? {}, limits: s.limits ?? {}, exhausted: s.exhausted ?? {}, peakBalance: s.peakBalance ?? {} }
  }
  let queue = Promise.resolve()
  let cache = null
  // One queue for every read-modify-write of accounts.json and .env.
  const mutate = (fn) => {
    const next = queue.then(async () => {
      const s = await read()
      const r = await fn(s)
      await mkdir(dataDir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(s, null, 2))
      await rename(tmp, file)
      cache = s
      return r
    })
    queue = next.catch(() => {})
    return next
  }

  // First run: register the keys DSH already uses as "default", so rotation can come back to them.
  let boot = null
  const ready = () => (boot ??= (async () => {
    const s = await read()
    const seed = []
    for (const [provider, ref] of [['deepseek', ACTIVE_ENV.deepseek], ['jev', jevCredentialRef]]) {
      if (s.keys[provider]?.length) continue
      const hit = await credentials?.resolve(ref).catch(() => undefined)
      if (hit?.value) seed.push([provider, hit.value])
    }
    if (seed.length) {
      await queue
      await writeEnvFile(envFile, Object.fromEntries(seed.map(([p, v]) => [envName(p, 'default'), v])))
      await mutate((s2) => { for (const [p] of seed) if (!s2.keys[p]?.length) s2.keys[p] = [{ name: 'default', active: true, addedAt: new Date().toISOString() }] })
    }
    cache = await read()
  })().catch((err) => { boot = null; throw err }))

  const keyValue = async (provider, name) => parseEnv(await readEnvFile(envFile)).get(envName(provider, name))

  async function applyActive(provider, name) {
    const ref = ACTIVE_ENV[provider]
    if (!ref) return { restartRequired: false }
    const value = await keyValue(provider, name)
    if (!value) throw new Error(`key ${provider}/${name} has no value in .env`)
    await writeEnvFile(envFile, { [ref]: value })
    // One home for a secret: ~/.dsh/.env. The engine resolves a key per request in
    // the order process env > .credentials.yaml > .env, so a copy left in the store
    // would shadow the file we just wrote. Clear it instead of writing a second copy.
    // The cost is that .env is read once at launch, so switching keys needs a restart.
    await credentials?.unset?.(ref).catch(() => {})
    return { restartRequired: true }
  }

  const accounts = {
    ready,
    /** Metadata only. Sync after ready(); callers on the hot path use this. */
    cached: () => cache ?? { keys: {}, limits: {}, exhausted: {} },
    async list() { await ready(); await queue; return cache },
    async addKey(provider, name, value) {
      if (!KEY_NAME.test(name ?? '')) throw new Error('key name: lowercase letters, digits, - or _ (max 32)')
      if (typeof value !== 'string' || !value.trim() || /[\s"'\\#]/.test(value.trim())) throw new Error('key value missing or has spaces/quotes')
      await ready()
      const first = await mutate(async (s) => {
        const list = (s.keys[provider] ??= [])
        if (list.some((k) => k.name === name)) throw new Error(`${provider} already has a key named ${name}`)
        await writeEnvFile(envFile, { [envName(provider, name)]: value.trim() })
        list.push({ name, active: list.length === 0, addedAt: new Date().toISOString() })
        return list.length === 1
      })
      return first ? accounts.activate(provider, name) : { restartRequired: false }
    },
    async removeKey(provider, name) {
      await ready()
      const next = await mutate(async (s) => {
        const list = s.keys[provider] ?? []
        const k = list.find((x) => x.name === name)
        if (!k) throw new Error(`no ${provider} key named ${name}`)
        s.keys[provider] = list.filter((x) => x !== k)
        delete s.exhausted[`${provider}:${name}`]
        await writeEnvFile(envFile, { [envName(provider, name)]: null })
        // ponytail: removing the only key leaves DSH's own DEEPSEEK_API_KEY in place.
        return k.active ? s.keys[provider][0]?.name : undefined
      })
      return next ? accounts.activate(provider, next) : { restartRequired: false }
    },
    async activate(provider, name) {
      await ready()
      return mutate(async (s) => {
        const list = s.keys[provider] ?? []
        if (!list.some((k) => k.name === name)) throw new Error(`no ${provider} key named ${name}`)
        const r = await applyActive(provider, name)
        for (const k of list) k.active = k.name === name
        return r
      })
    },
    /** Next key after the active one, in list order, skipping ones `isOut(name)` rejects. */
    nextKey(provider, isOut = () => false) {
      const s = accounts.cached()
      const list = s.keys[provider] ?? []
      const i = list.findIndex((k) => k.active)
      const now = Date.now()
      for (let n = 1; n < list.length; n++) {
        const k = list[(i + n) % list.length]
        const ex = s.exhausted[`${provider}:${k.name}`]
        if (ex && Date.parse(ex.until) > now) continue
        if (!isOut(k.name)) return k.name
      }
      return null
    },
    activeKey: (provider) => accounts.cached().keys[provider]?.find((k) => k.active)?.name ?? null,
    /** Server-internal only: never send the result to a client or a log. */
    resolveKey: keyValue,
    /**
     * Remember the most credit a key has ever held, so a balance can be shown as a
     * share of it. A top-up raises the mark, which is what makes it self-maintaining;
     * a different currency replaces it rather than being compared against.
     * @returns the mark now in force, or null when there is nothing to compare.
     */
    async notePeakBalance(provider, name, balance) {
      if (!balance || !(Number(balance.amount) >= 0)) return null
      await ready()
      const key = `${provider}:${name}`
      const seen = accounts.cached().peakBalance?.[key]
      const same = seen && seen.currency === balance.currency
      if (same && seen.amount >= balance.amount) return seen
      const mark = { amount: Number(balance.amount), currency: balance.currency, at: new Date().toISOString() }
      await mutate((st) => { (st.peakBalance ??= {})[key] = mark })
      return mark
    },
    async setLimits(agentId, limits) {
      const clean = {}
      for (const f of ['handoffAtPercent', 'stopAtPercent']) if (limits[f] !== undefined) {
        const n = Number(limits[f]); if (!(n >= 0 && n <= 100)) throw new Error(`${f} must be 0-100`); clean[f] = n
      }
      for (const f of ['minBalance', 'handoffAtBalance', 'monthlyBudgetUsd']) if (limits[f] !== undefined) {
        const n = Number(limits[f]); if (!(n >= 0)) throw new Error(`${f} must be ≥ 0`); clean[f] = n
      }
      await ready()
      return mutate((s) => { s.limits[agentId] = { ...s.limits[agentId], ...clean } })
    },
    async markExhausted(key, { until, reason }) {
      await ready()
      return mutate((s) => { s.exhausted[key] = { until, reason: String(reason ?? '').slice(0, 200), at: new Date().toISOString() } })
    },
    async clearExpired() {
      await ready()
      const now = Date.now()
      if (!Object.values(cache.exhausted).some((e) => Date.parse(e.until) <= now)) return
      return mutate((s) => { for (const [k, e] of Object.entries(s.exhausted)) if (!(Date.parse(e.until) > now)) delete s.exhausted[k] })
    },
    async claudeStatus() {
      const r = await run('claude auth status --json')
      try { const s = JSON.parse(r.out); return { loggedIn: !!s.loggedIn, email: s.email ?? null, plan: s.subscriptionType ?? null } } catch { return { loggedIn: false, email: null } }
    },
    async codexStatus() {
      const a = await codexAccount?.().catch(() => null)
      return a?.email ? { loggedIn: true, email: a.email, plan: a.planType ?? null } : { loggedIn: false, email: null }
    },
    async logout(provider) {
      if (!Object.hasOwn(LOGOUT, provider)) throw new Error('provider must be claude or codex')
      const r = await run(LOGOUT[provider])
      if (!r.ok) throw new Error(`${LOGOUT[provider]} failed: ${r.out.slice(0, 200)}`)
    },
    openLogin(provider) {
      if (!Object.hasOwn(LOGIN, provider)) throw new Error('provider must be claude or codex')
      open(...LOGIN[provider])
    },
  }
  return accounts
}

/** New visible console window running a fixed command; stays open (`cmd /k`) so the user sees the result. */
function openConsole(title, command) {
  const c = spawn(`start "${title}" cmd /k ${command}`, { shell: true, detached: true, stdio: 'ignore' })
  c.on('error', () => {})
  c.unref()
}
