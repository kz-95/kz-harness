// Hourly balance guard for the DeepSeek key.
//
// Reads the balance the same way the Usage tab does, then compares it to the two
// thresholds the owner set in ~/.kzh/jev-router/accounts.json:
//   handoffAtBalance  soft: finish the current task, then hand over
//   minBalance        hard: stop giving DeepSeek execution work at all
//
// The key is read from the env file and never printed, never logged and never put in
// the output. Only the balance and the verdict leave this script.
//
// Exit codes are the signal, so a scheduler can act without parsing text:
//   0 ok, 1 soft threshold crossed, 2 hard threshold crossed, 3 could not check.
//
// Every path returns a code from one place. An earlier draft assigned process.exitCode
// and fell through, so the "hard cut off" branch was overwritten by the "ok" line at the
// bottom and the guard reported ok at every balance. A monitor that cannot say no is
// worse than no monitor, so the verdict is computed once and returned once.
//
// Exit is by process.exitCode, never process.exit(): calling exit() while the fetch
// socket is still closing trips a libuv assertion on Windows and loses the real code.
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.kzh')
const ACCOUNTS = join(HOME, 'jev-router', 'accounts.json')
const LOG = join(HOME, 'jev-router', 'balance-watch.jsonl')

/** The key, from the first env file that has one. Returned, never printed. */
function apiKey() {
  for (const f of [join(HOME, '.env'), join(homedir(), '.dsh', '.env')]) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  }
  return null
}

/** The owner's thresholds. A missing file falls back to the plugin's own defaults. */
function limits() {
  try {
    const d = JSON.parse(readFileSync(ACCOUNTS, 'utf8')).limits?.deepseek ?? {}
    return { soft: d.handoffAtBalance ?? 10, hard: d.minBalance ?? 5 }
  } catch { return { soft: 10, hard: 5 } }
}

function record(row) {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`)
  } catch { /* the check must not fail because its own log could not be written */ }
}

/** @returns {Promise<{code: 0|1|2|3, text: string}>} one verdict, from one place. */
async function check() {
  const key = apiKey()
  if (!key) {
    record({ ok: false, reason: 'no key' })
    return { code: 3, text: 'NO KEY, cannot check. No DEEPSEEK_API_KEY in the env files.' }
  }

  let res
  try {
    res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    // A network blip must never read as "fine", and never as "empty".
    record({ ok: false, reason: `unreachable: ${err.name}` })
    return { code: 3, text: `COULD NOT REACH DeepSeek (${err.name}). No verdict.` }
  }

  if (!res.ok) {
    record({ ok: false, reason: `http ${res.status}` })
    return { code: 3, text: `DeepSeek answered HTTP ${res.status}. No verdict.` }
  }

  const body = await res.json().catch(() => null)
  // The CNY wallet is the one this account is billed in; USD is a separate wallet.
  const infos = body?.balance_infos ?? []
  const row = infos.find((b) => b.currency === 'CNY') ?? infos[0]
  const amount = row ? Number(row.total_balance) : NaN
  if (!Number.isFinite(amount)) {
    record({ ok: false, reason: 'unparsable' })
    return { code: 3, text: 'Could not read a balance from the reply. No verdict.' }
  }

  const { soft, hard } = limits()
  const cur = row.currency ?? 'CNY'
  const state = amount < hard ? 'HARD' : amount < soft ? 'SOFT' : 'ok'
  record({ ok: true, balance: amount, currency: cur, soft, hard, state })

  if (state === 'HARD') {
    return { code: 2, text: `HARD CUT OFF. ${amount} ${cur} is below the hard floor of ${hard}. DeepSeek must take no more execution work.` }
  }
  if (state === 'SOFT') {
    return { code: 1, text: `SOFT HANDOFF. ${amount} ${cur} is below ${soft}, above the hard floor of ${hard}. Finish the current task, then hand over.` }
  }
  return { code: 0, text: `ok. ${amount} ${cur} (soft at ${soft}, hard at ${hard}).` }
}

const { code, text } = await check()
console.log(`balance-watch: ${text}`)
process.exitCode = code
