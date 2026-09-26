// The app's settings: the defaults, then config.json beside src/, then the environment.
import { readFileSync } from 'node:fs'

const DEFAULTS = { timeout: 3000, retries: 2, region: 'us-east' }

/** A duration in milliseconds: a number of milliseconds, or text such as 250ms, 4s or 2m. */
function duration(value) {
  if (typeof value === 'number') return value
  const m = /^(\d+)(ms|s|m)$/.exec(String(value).trim())
  if (!m) throw new Error(`not a duration: ${value}`)
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000 }[m[2]]
}

/**
 * The settings, each from the last of these that sets it: the defaults, config.json, and the
 * environment variables APP_TIMEOUT_MS, APP_RETRIES and APP_REGION.
 */
export function loadConfig({ env = process.env, file = new URL('../config.json', import.meta.url) } = {}) {
  const config = { ...DEFAULTS }
  let fromFile = {}
  try {
    fromFile = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // No config.json: the defaults stand.
  }
  if (fromFile.timeout !== undefined) config.timeout = duration(fromFile.timeout)
  if (fromFile.retries !== undefined) config.retries = Number(fromFile.retries)
  if (fromFile.region !== undefined) config.region = String(fromFile.region)
  if (env.APP_TIMEOUT_MS) config.timeout = duration(env.APP_TIMEOUT_MS)
  if (env.APP_RETRIES) config.retries = Number(env.APP_RETRIES)
  if (env.APP_REGION) config.region = env.APP_REGION
  return config
}
