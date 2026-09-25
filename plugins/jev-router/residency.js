// The local model processes KzH keeps loaded on this PC, and the one RAM budget they share
// (docs/laya-auto.md 7.7).
//
// Two kinds of process can be resident at once: llama.cpp's llama-server, which local.js starts
// for a local chat model or agent, and Laya's laya.serve, which laya-sidecar.js starts. They are
// supervised apart, so neither can stop the other by accident, but the resource budget's RAM limit
// is one limit for every local model process, so what each holds is registered here and one
// watchdog reads them together.
//
// Each resident says whether it is held and whether it is busy:
//   - held: someone relies on it staying loaded. llama is always held, because the local model is
//     what the person is using; Laya is held only while an open Laya Auto run, a Test Laya, an
//     install check or the Keep Laya loaded switch holds it. A resident that is not held gives its
//     memory up to one that needs it (`yieldFor`), and is the watchdog's first victim.
//   - keepWhileHeld: a hold binds the watchdog too, so a held Laya is never unloaded to fit the
//     budget. llama's hold does not: today's rule for an over-budget llama is kept as it was.
//   - busy: a request someone is waiting for is in flight, so a yield passes it by.
import { workingSetOf } from './local.js'

const GB = 1024 ** 3
const r1 = (x) => Math.round(x * 10) / 10
const num = (v) => {
  const x = typeof v === 'function' ? v() : v
  return Number.isFinite(x) ? x : null
}

/**
 * The registry of resident local model processes.
 *
 * `set(id, entry)` registers one, replacing any earlier entry under that id, and returns the stored
 * entry, which `clear(id, entry)` takes to clear only that one (a late clear from a process since
 * replaced changes nothing). An entry:
 *   { pid, startedAt, device, name, busy: () => boolean, held: () => boolean, keepWhileHeld?: boolean,
 *     unload: (why) => Promise<void>, ramGB?: number | () => number, vramGB?: number | () => number }
 * `ramGB` and `vramGB` are what it holds by its own account (measured or estimated); the watchdog's
 * latest working-set reading, kept on the entry as `workingSetGB`, wins for RAM once there is one.
 *
 * `unload(why)` is handed `{ kind: 'budget' | 'yield', text, for? }`: the watchdog's reason, or for a
 * yield the name of the resident that asked, so each resident can say why it went.
 */
export function createResidency({ log = () => {} } = {}) {
  const residents = new Map()
  // Bumped whenever a resident comes or goes, so a reading taken across a change is known stale.
  let gen = 0

  const ramOf = (r) => r.workingSetGB ?? num(r.ramGB) ?? 0
  const others = (id, heldOnly) => [...residents.values()].filter((r) => r.id !== id && (!heldOnly || r.held()))
  const sum = (xs) => r1(xs.reduce((a, b) => a + b, 0))

  return {
    set(id, entry) {
      const stored = { busy: () => false, held: () => false, keepWhileHeld: false, name: id, ...entry, id, workingSetGB: null }
      residents.set(id, stored)
      gen++
      return stored
    },
    clear(id, entry) {
      if (!residents.has(id) || (entry && residents.get(id) !== entry)) return
      residents.delete(id)
      gen++
    },
    get: (id) => residents.get(id) ?? null,
    list: () => [...residents.values()],
    generation: () => gen,
    /** RAM the other residents hold, in GB; with `heldOnly`, only those a hold keeps loaded. */
    othersRamGB: (id, { heldOnly = false } = {}) => sum(others(id, heldOnly).map(ramOf)),
    /** VRAM the other residents hold by their own account, in GB. */
    othersVramGB: (id, { heldOnly = false } = {}) => sum(others(id, heldOnly).map((r) => num(r.vramGB) ?? 0)),
    /** The names of the other residents, for a message that says what shares the budget. */
    othersNames: (id, { heldOnly = false } = {}) => others(id, heldOnly).map((r) => r.name),
    /**
     * Unload every other resident that is neither held nor busy, so `id` gets the GPU layers and
     * RAM it would have had without them. Returns the ids unloaded. An unload that fails is
     * logged and left out: the start that asked goes ahead either way.
     */
    async yieldFor(id, { name = id } = {}) {
      const gone = []
      for (const r of others(id, false)) {
        if (r.held() || r.busy()) continue
        try {
          await r.unload({ kind: 'yield', for: name, text: `unloaded so ${name} could have the GPU and RAM` })
          gone.push(r.id)
        } catch (err) { log(`residency: ${r.id} did not unload for ${name}: ${err.message}`) }
      }
      return gone
    },
  }
}

/** How long the summed working set must stay over the RAM budget before a resident is unloaded. */
const GRACE_MS = 30_000

/**
 * The victim when the sum is over the budget: a resident nothing holds first (Laya when no run,
 * test or switch holds it), the most recently started of those; then, never a held Laya, today's
 * rule over the rest: the most recently started resident that is not busy, else the most recently
 * started.
 */
export function victimOf(list) {
  const newest = [...list].sort((a, b) => b.startedAt - a.startedAt)
  const unheld = newest.find((r) => !r.held())
  if (unheld) return unheld
  const rest = newest.filter((r) => !(r.keepWhileHeld && r.held()))
  return rest.find((r) => !r.busy()) ?? rest[0] ?? null
}

/**
 * One watchdog for the RAM budget over every resident. RAM cannot be capped, so while a RAM budget
 * is set every resident's working set is read every `everyMs`, and when their sum stays over the
 * budget for `graceMs` one resident is unloaded (victimOf), even mid-answer: the budget is there to
 * keep the PC usable. Only readings that all say "over" count: a reading that cannot be taken, or
 * a resident coming or going, starts the count again, since neither is evidence the sum is over.
 * Only the resident actually unloaded is told why; the others' bookkeeping (llama's `tripped`
 * context) is never touched on another's account.
 *
 * `check()` takes one reading; a check while one is out joins it. `start()` runs it every
 * `everyMs` (a check with nothing resident reads nothing, not even the settings); `stop()` ends it.
 */
export function createBudgetWatchdog({ residency, readSettings, readWorkingSet = workingSetOf, now = Date.now, everyMs = 5000, graceMs = GRACE_MS, log = () => {} }) {
  let overSince = null // { at, gen }: when the sum went over, under which set of residents
  let watching = null
  let timer = null

  const describe = (list, maxRamGB, forMs, totalGB) => {
    const s = Math.round(forMs / 1000)
    // One resident reads as it always has, word for word.
    if (list.length === 1) return `its working set stayed over the ${maxRamGB} GB RAM budget for ${s} s (last reading ${totalGB} GB)`
    return `the local models together stayed over the ${maxRamGB} GB RAM budget for ${s} s (last reading ${totalGB} GB: ${list.map((r) => `${r.name} ${r.workingSetGB} GB`).join(', ')})`
  }

  function check() {
    watching ??= (async () => {
      const list = residency.list()
      if (!list.length) { overSince = null; return }
      const { maxRamGB } = await readSettings()
      if (maxRamGB == null) {
        overSince = null
        for (const r of list) r.workingSetGB = null
        return
      }
      const gen = residency.generation()
      const bytes = await Promise.all(list.map((r) => Promise.resolve().then(() => readWorkingSet(r.pid)).catch(() => null)))
      // A resident came or went while the readings were out: what they add up to describes
      // nothing that is running now.
      if (residency.generation() !== gen) { overSince = null; return }
      list.forEach((r, i) => { r.workingSetGB = bytes[i] == null ? null : r1(bytes[i] / GB) })
      if (bytes.some((b) => b == null)) { overSince = null; return }
      const total = bytes.reduce((a, b) => a + b, 0)
      if (total <= maxRamGB * GB) { overSince = null; return }
      if (overSince?.gen !== gen) overSince = { at: now(), gen }
      const forMs = now() - overSince.at
      if (forMs < graceMs) return
      const victim = victimOf(list)
      if (!victim) { log(`RAM watchdog: over the ${maxRamGB} GB RAM budget, and every resident is held`); return }
      overSince = null
      await victim.unload({ kind: 'budget', text: describe(list, maxRamGB, forMs, r1(total / GB)) })
    })().finally(() => { watching = null })
    return watching
  }

  return {
    check,
    start() {
      if (timer) return
      timer = setInterval(() => { check().catch((err) => log(`RAM watchdog: ${err.message}`)) }, everyMs)
      timer.unref?.()
    },
    stop() { clearInterval(timer); timer = null },
  }
}
