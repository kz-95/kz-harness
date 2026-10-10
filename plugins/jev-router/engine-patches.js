// Whether the engine patch for Claude Code and Codex (scripts/patch-agent-live.mjs, run by
// Start-KzH.ps1) is in the connectors this PC's engine runs, and if not, why (docs/live-agent-view.md
// Feature 1). runAgent hands a run the patch's request fields, `kzhTap` and `kzhControl`, only when its
// connector carries the patch's marker: a connector without it is never handed fields it does not
// know, and runs as it ships. The Live tab, the work board and Settings say what this reads.
//
// The marker is read from the installed file itself, so a connector reinstalled since the patch ran
// reads as off at once; the reason comes from the status file the patch writes beside the engine's
// profiles ($DSH_HOME/kzh-engine-patches.json). A file that cannot be read means off.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The version of the patch this plugin speaks: a connector marked with another one is off. */
export const PATCH_VERSION = '2'
/** How long one reading is kept: the connectors change only when the engine starts again. */
export const PATCH_TTL_MS = 60_000
/** The connector packages, by the provider family they serve. */
export const PATCH_PACKAGES = Object.freeze({ 'claude-code': 'dsh-subagent-claude-code', codex: 'dsh-subagent-codex' })
const MARKED = /KZH_AGENT_LIVE (\d+)/

/** The connector a provider row runs on: Claude Code's for its own row and its read-only one, Codex's for Codex, else null. */
export const patchKeyOf = (provider) => (provider === 'claude-code' || provider === 'claude-code-readonly' ? 'claude-code' : provider === 'codex' ? 'codex' : null)

/** The installed connector of `key` in the engine's web profile, which the harness runs. */
export const connectorFile = (dshHome, key) => join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', PATCH_PACKAGES[key], 'lib', 'index.js')

/** The version of the connector `key` installed now, from its package.json, or null. */
function installedVersion(dshHome, key) {
  try { return JSON.parse(readFileSync(join(dirname(dirname(connectorFile(dshHome, key))), 'package.json'), 'utf8')).version ?? null } catch { return null }
}

/**
 * Why a connector without the marker is off, from what the patch last recorded of it: one installed
 * again since is patched at the next start only at the version the patch was written for.
 */
function offWhy(said, writtenFor, installed) {
  if (typeof said?.reason === 'string' && said.reason) return said.reason
  if (['patched', 'upgraded', 'applied'].includes(said?.result)) {
    return installed && typeof writtenFor === 'string' && installed !== writtenFor
      ? `its connector was installed again at version ${installed} after the patch ran, and the patch was written for ${writtenFor}, so it stays off until KzH is updated for that version`
      : 'its connector was installed again after the patch ran; the next start of the harness patches it again'
  }
  return 'the engine patch has not run on it yet; Start-KzH runs it at each start'
}

/**
 * What the connectors are now, read without a cache: `{ 'claude-code': { on, why }, codex: { on, why } }`,
 * `why` null when `on`.
 */
export function readPatchState({ dshHome }) {
  let status = null
  try { status = JSON.parse(readFileSync(join(dshHome, 'kzh-engine-patches.json'), 'utf8')) } catch { status = null }
  const out = {}
  for (const key of Object.keys(PATCH_PACKAGES)) {
    let src
    try { src = readFileSync(connectorFile(dshHome, key), 'utf8') } catch (err) {
      out[key] = Object.freeze({ on: false, why: err.code === 'ENOENT' ? 'its connector is not installed' : `its connector could not be read (${err.code ?? err.message})` })
      continue
    }
    const mark = MARKED.exec(src)
    out[key] = Object.freeze(mark?.[1] === PATCH_VERSION ? { on: true, why: null }
      : mark ? { on: false, why: `its connector carries version ${mark[1]} of the engine patch, and this plugin speaks version ${PATCH_VERSION}` }
        : { on: false, why: offWhy(status?.[key], status?.writtenFor, installedVersion(dshHome, key)) })
  }
  return Object.freeze(out)
}

// Each engine home's last reading, for a caller that keeps none of its own.
const kept = new Map()

/**
 * What the connectors are, read at most once a minute (PATCH_TTL_MS) per engine home: the plugin
 * keeps a `cache` of its own, so one applied again reads them afresh; `now` is the clock.
 */
export function patchState({ dshHome, now = Date.now, cache = kept } = {}) {
  const hit = cache.get(dshHome)
  if (hit && now() - hit.at < PATCH_TTL_MS) return hit.state
  const state = readPatchState({ dshHome })
  cache.set(dshHome, { at: now(), state })
  return state
}
