// Accounts: API keys per provider. A key's value lives in exactly one place,
// <DSH_HOME>/.env (~/.kzh/.env for KzH); everything else refers to it by variable name. Per-agent
// limits, exhaustion marks, and the subscription tools' own login/logout.
// Metadata lives in accounts.json; no function here ever returns a key value
// except resolveKey, which is server-internal.
import { exec, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const KEY_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** What KEY_NAME asks for, said the same wherever a name is refused. */
export const KEY_NAME_RULE = 'key name: up to 32 lowercase letters, digits, - or _, starting with a letter or digit'
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
/** Whether `provider`'s agent calls go out on a stored key, read once at launch (DeepSeek). */
export const readsKeyAtLaunch = (provider) => Object.hasOwn(ACTIVE_ENV, provider)
// The key each provider's agent calls go out on, per data folder and .env file, for the life of
// this process: DSH reads it once at launch, so a plugin reloaded without a restart must not take
// a switch made since for it. Kept on globalThis because a reload may import this module afresh.
const processLaunched = (dataDir, envFile) => {
  const all = (globalThis[Symbol.for('kz-harness.jev-router.launchedKeys')] ??= new Map())
  const key = `${resolve(dataDir)}\0${resolve(envFile ?? '')}`
  if (!all.has(key)) all.set(key, {})
  return all.get(key)
}

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
 * @param {string} p.envFile              <DSH_HOME>/.env (~/.kzh/.env)
 * @param {object} [p.credentials]        DSH credentials service (resolve/describe/unset); values are never written to it
 * @param {string} [p.jevCredentialRef]   Jev key used when no jev key is registered
 * @param {Function} [p.codexAccount]     async () => {email, planType} | null
 * @param {Function} [p.run]              shell runner, injectable for tests
 * @param {Function} [p.open]             opens a visible console running a command
 * @param {object} [p.launched]           the keys in use since launch ({ provider: { name, id } | null }); this process's own by default, a fresh one standing in for a restart in tests
 */
export function createAccounts({ dataDir, envFile, credentials, jevCredentialRef = 'TYPESAFE_API_KEY', codexAccount, run = sh, open = openConsole, launched = processLaunched(dataDir, envFile) }) {
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
      await mutate((s2) => { for (const [p] of seed) if (!s2.keys[p]?.length) s2.keys[p] = [{ name: 'default', active: true, addedAt: new Date().toISOString(), id: randomUUID() }] })
    }
    cache = await read()
    // The key each provider's agent calls really go out on: the one active as the harness started,
    // since DSH reads it once at launch; a switch made since waits for a restart. Known by name and
    // its own id (when it was added, for a key stored before ids), so a key removed and added again
    // under its name is not taken for it.
    for (const p of Object.keys(ACTIVE_ENV)) {
      if (Object.hasOwn(launched, p)) continue
      const k = cache.keys[p]?.find((x) => x.active)
      launched[p] = k ? { name: k.name, id: idOf(k) } : null
    }
  })().catch((err) => { boot = null; throw err }))
  const idOf = (k) => k.id ?? k.addedAt ?? null
  // Whether a restart would change the stored key agent calls go out on: the active key is not the
  // one in use since launch (a key made active since, the launch key removed, or one stored after
  // a launch with none). Only a provider read at launch ever needs one.
  const restartPending = (s, provider) => {
    if (!Object.hasOwn(ACTIVE_ENV, provider)) return false
    const active = s.keys[provider]?.find((k) => k.active) ?? null
    return launched[provider] ? active !== (launchedEntry(s, provider) ?? null) || !launchedEntry(s, provider) : !!active
  }
  // The listed key that is the one launched, or undefined when it is gone (removed, or replaced by
  // another under its name).
  const launchedEntry = (s, provider) => {
    const l = launched[provider]
    const k = l ? s.keys[provider]?.find((x) => x.name === l.name) : null
    return k && idOf(k) === l.id ? k : undefined
  }

  const keyValue = async (provider, name) => parseEnv(await readEnvFile(envFile)).get(envName(provider, name))

  async function applyActive(provider, name) {
    const ref = ACTIVE_ENV[provider]
    if (!ref) return { restartRequired: false }
    const value = await keyValue(provider, name)
    if (!value) throw new Error(`key ${provider}/${name} has no value in .env`)
    await writeEnvFile(envFile, { [ref]: value })
    // One home for a secret: <DSH_HOME>/.env. The engine resolves a key per request in
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
    /**
     * Add a stored key. It becomes the active one when it is the first, or when the active one is
     * spent: marked, or out by `isOut(name)` (the caller's reading: below its floor, say), as a
     * limit's switch would have made it.
     */
    async addKey(provider, name, value, { isOut = () => false } = {}) {
      if (!KEY_NAME.test(name ?? '')) throw new Error(KEY_NAME_RULE)
      if (typeof value !== 'string' || !value.trim() || /[\s"'\\#]/.test(value.trim())) throw new Error('key value missing or has spaces/quotes')
      await ready()
      const first = await mutate(async (s) => {
        const list = (s.keys[provider] ??= [])
        if (list.some((k) => k.name === name)) throw new Error(`${provider} already has a key named ${name}`)
        await writeEnvFile(envFile, { [envName(provider, name)]: value.trim() })
        // A new key has no history, whatever a key once removed under its name went through.
        delete s.exhausted[`${provider}:${name}`]
        delete s.peakBalance?.[`${provider}:${name}`]
        const active = list.find((k) => k.active)
        const spent = !!active && (Date.parse(s.exhausted[`${provider}:${active.name}`]?.until) > Date.now() || !!isOut(active.name))
        list.push({ name, active: list.length === 0, addedAt: new Date().toISOString(), id: randomUUID() })
        return list.length === 1 || spent
      })
      return first ? accounts.activate(provider, name) : { restartRequired: accounts.restartPending(provider) }
    },
    /**
     * Remove a stored key: from this PC, as the Settings dialog says. Its value goes from where DSH
     * or Jev reads a key itself too, when that holds it: DEEPSEEK_API_KEY once no DeepSeek key is
     * left, and the Jev credential (its .env line, and the credential store) for any Jev key.
     * An active key removed gives way to the next usable one after it, skipping one marked or out
     * by `isOut(name)`, as a limit's switch would pick; the first left when none is.
     */
    async removeKey(provider, name, { isOut = () => false } = {}) {
      await ready()
      const next = await mutate(async (s) => {
        const list = s.keys[provider] ?? []
        const k = list.find((x) => x.name === name)
        if (!k) throw new Error(`no ${provider} key named ${name}`)
        // The launch key removed is still the one calls go out on until a restart: a limit met on
        // it goes with the process's record of it (launchKeyGone).
        const mark = s.exhausted[`${provider}:${name}`]
        if (launchedEntry(s, provider) === k && Date.parse(mark?.until) > Date.now()) launched[provider].goneSpent = { until: mark.until, reason: mark.reason }
        const at = list.indexOf(k)
        const rest = (s.keys[provider] = list.filter((x) => x !== k))
        delete s.exhausted[`${provider}:${name}`]
        delete s.peakBalance?.[`${provider}:${name}`]
        // Where DSH or Jev reads a key itself, the removed key's value goes too: for DeepSeek once
        // no key is left (activating the next one rewrites DEEPSEEK_API_KEY otherwise), for Jev
        // whenever it is there, as its fallback when no Jev key is stored. Its line in .env, and
        // the credential store when that holds it.
        const lines = { [envName(provider, name)]: null }
        const ref = Object.hasOwn(ACTIVE_ENV, provider) ? (rest.length ? null : ACTIVE_ENV[provider]) : provider === 'jev' ? jevCredentialRef : null
        if (ref) {
          const env = parseEnv(await readEnvFile(envFile))
          const value = env.get(envName(provider, name))
          if (value && env.get(ref) === value) lines[ref] = null
          const stored = await credentials?.resolve?.(ref).catch(() => undefined)
          if (value && (env.get(ref) === value || stored?.value === value)) await credentials?.unset?.(ref).catch(() => {})
        }
        await writeEnvFile(envFile, lines)
        if (!k.active || !rest.length) return undefined
        const now = Date.now()
        const usable = (x) => !(Date.parse(s.exhausted[`${provider}:${x.name}`]?.until) > now) && !isOut(x.name)
        return ([...rest.slice(at), ...rest.slice(0, at)].find(usable) ?? rest[0]).name
      })
      if (next) await accounts.activate(provider, next)
      return { restartRequired: accounts.restartPending(provider) }
    },
    async activate(provider, name) {
      await ready()
      return mutate(async (s) => {
        const list = s.keys[provider] ?? []
        const chosen = list.find((k) => k.name === name)
        if (!chosen) throw new Error(`no ${provider} key named ${name}`)
        await applyActive(provider, name)
        for (const k of list) k.active = k.name === name
        return { restartRequired: restartPending(s, provider) }
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
    /**
     * The stored key an agent call on `provider` goes out on now, or null when none does: DSH reads
     * a provider's key once at launch (DEEPSEEK_API_KEY), so it is the key active then, however the
     * active key has been switched since; any other provider's calls use no stored key at all.
     */
    keyInUse: (provider) => (Object.hasOwn(ACTIVE_ENV, provider) ? launchedEntry(accounts.cached(), provider)?.name ?? null : null),
    /** Whether a restart would change the key agent calls on `provider` go out on (restartPending). */
    restartPending: (provider) => restartPending(accounts.cached(), provider),
    /** Every provider a restart would move onto another key: what Settings says to restart for. */
    restartPendingProviders: () => Object.keys(ACTIVE_ENV).filter((p) => restartPending(accounts.cached(), p)),
    /** The name of the key agent calls on `provider` go out on, stored or not, or null (keyInUse). */
    launchKeyName: (provider) => (Object.hasOwn(ACTIVE_ENV, provider) ? launched[provider]?.name ?? null : null),
    /**
     * The key calls on `provider` still go out on when it is no longer stored (removed, or replaced
     * by another under its name), as { name, spent }, with `spent` its limit met since; else null.
     */
    launchKeyGone: (provider) => {
      const l = Object.hasOwn(ACTIVE_ENV, provider) ? launched[provider] : null
      if (!l || launchedEntry(accounts.cached(), provider)) return null
      return { name: l.name, spent: Date.parse(l.goneSpent?.until) > Date.now() ? l.goneSpent : null, reading: l.reading ?? null }
    },
    /**
     * Keep the latest reading of the key calls go out on with the process's record of it, so it is
     * still known, through a plugin reload, once the key is no longer stored (launchKeyGone).
     */
    noteKeyInUse(provider, reading) {
      const l = launched[provider]
      if (l && launchedEntry(accounts.cached(), provider)?.name === reading?.name) l.reading = { ...reading, at: new Date().toISOString() }
    },
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
    /**
     * Mark one stored key spent, while it is still the key listed under that name, and say whether
     * it was marked. Another key added under the launch key's name keeps no mark; the launch key
     * itself, no longer stored, is noted spent for the life of this process (launchKeyGone).
     */
    async markKeyExhausted(provider, name, { until, reason }) {
      await ready()
      return mutate((s) => {
        const k = s.keys[provider]?.find((x) => x.name === name)
        const l = launched[provider]
        if (l?.name === name && (!k || launchedEntry(s, provider) !== k)) { l.goneSpent = { until, reason: String(reason ?? '').slice(0, 200) }; return false }
        if (!k) return false
        s.exhausted[`${provider}:${name}`] = { until, reason: String(reason ?? '').slice(0, 200), at: new Date().toISOString() }
        return true
      })
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
