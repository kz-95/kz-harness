// Login checks for each agent: is the CLI installed and signed in, or is the
// API key present. Used by the Settings setup page and before every route, so
// Jev only ever picks an agent that can actually run.
import { exec } from 'node:child_process'

// Fixed command strings only (never user input); a shell so Windows finds the claude.cmd / codex.cmd shims.
const run = (command, timeoutMs = 20_000) => new Promise((resolve) => {
  exec(command, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) =>
    resolve({ ok: !err, code: err?.code ?? 0, out: `${stdout}${stderr}`.trim() }))
})

const CHECKS = {
  async 'claude-code'() {
    const r = await run('claude auth status')
    if (!r.ok && /not recognized|not found|ENOENT/i.test(r.out)) return { installed: false, loggedIn: false, detail: 'Claude Code CLI not found. Install: npm i -g @anthropic-ai/claude-code' }
    try {
      const s = JSON.parse(r.out)
      return { installed: true, loggedIn: !!s.loggedIn, detail: s.loggedIn ? `signed in (${s.authMethod})` : 'not signed in. Run: claude  then /login' }
    } catch { return { installed: true, loggedIn: false, detail: r.out.slice(0, 200) || 'could not read login status' } }
  },
  async codex() {
    const r = await run('codex login status')
    if (!r.ok && /not recognized|not found|ENOENT/i.test(r.out)) return { installed: false, loggedIn: false, detail: 'Codex CLI not found. Install: npm i -g @openai/codex' }
    const loggedIn = r.ok && /logged in/i.test(r.out)
    return { installed: true, loggedIn, detail: loggedIn ? r.out.split('\n')[0] : 'not signed in. Run: codex login' }
  },
}

/**
 * @param {object[]} agents   router agent entries
 * @param {(ref: string) => Promise<unknown>} resolveCredential
 * @returns {Promise<Record<string, {installed: boolean, loggedIn: boolean, detail: string}>>}
 */
export async function checkAgents(agents, resolveCredential) {
  const out = {}
  await Promise.all(agents.map(async (a) => {
    if (CHECKS[a.provider]) out[a.id] = await CHECKS[a.provider]()
    else if (a.credentialRef) {
      const key = await resolveCredential(a.credentialRef).catch(() => undefined)
      out[a.id] = { installed: true, loggedIn: !!key?.value, detail: key?.value ? `${a.credentialRef} set` : `${a.credentialRef} missing. Add it in Settings → Models` }
    } else out[a.id] = { installed: true, loggedIn: true, detail: 'no login needed' }
  }))
  return out
}
