// The work a plugin still has under way as it closes, handed to the plugin the engine applies after it
// on the same data folder, as a setting of it changes (docs/handoff.md, "Decided by the owner, 9 Oct":
// the new plugin takes the work over).
//
// Cordis applies a plugin again by running its apply() once more on the module it imported once
// (Fiber.update: restart, which awaits each cleanup in _unload, then _reload), and the engine's
// background jobs outlive both (dsh-jobs-local: registrations outlive producer fibers). So a task's run
// goes on in the closures of the plugin that closed, and only something outside that instance can tell
// the plugin applied after it. Module scope outlives the instance; the registry is kept on globalThis
// under a Symbol all the same, so a copy of this module imported again (the plugin switched off and on,
// or reloaded from disk) finds the same one.
//
// A closing plugin leaves on its folder's shelf what the next plugin goes on with: its memory-only
// registries (`kept`: the lanes, the live store, the steer registry, its task follows, the agents
// whose read-only lock did not hold), which its runs keep writing to from its closures, and its tasks
// still going (`tasks`, tasks.js handOff), each with the promise of its result. The next plugin
// applied on the folder starts on the registries (join) and takes them with the tasks as its task
// list is made (take), together, so a task never goes to a plugin that queues and watches beside
// other registries than the ones its run writes to; from then on the plugin that closed reports
// through that one (heir), and a pass of its work that starts before then waits for it (handedOver).
// What no plugin takes within the bound expires: each task is then reported as it was before, by the
// plugin that closed, which saves and posts none of it.

import { resolve } from 'node:path'

/** How long what a closing plugin hands over waits for the next plugin on its data folder: one applied again takes it at once. */
export const HANDOVER_WAIT_MS = 60_000

// One shelf per data folder, however its path is spelled: Windows reads paths without regard to case.
const folderKey = (folder) => resolve(folder).toLowerCase()

/**
 * A registry of what closing plugins hand over, by data folder (processHandover is the process's one;
 * a test makes its own). `waitMs` bounds how long a shelf waits for the next plugin.
 */
export function createHandover({ waitMs = HANDOVER_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const shelves = new Map() // folder key -> { from, kept, tasks, timer, decided, decide }
  // A shelf nobody took in time, or one a later close replaces: its tasks are reported as before.
  const expire = (shelf) => {
    clearTimer(shelf.timer)
    for (const entry of shelf.tasks) { try { entry.expire?.() } catch { /* the others still expire */ } }
    shelf.decide()
  }
  return {
    /**
     * This plugin's place on `folder`, as it is applied. `kept` is what the plugin that closed on the
     * folder before it, within the bound, left of its memory-only registries, for this one to go on
     * with; null when none did. `take(hooks)` takes those registries and that plugin's tasks still
     * going, once, and makes this plugin its heir: `hooks` (`route`, `learnFromRun`, `bindRun`,
     * `transcriptAtEnd`) are what the plugin that closed calls from then on for the work it still has.
     * A plugin whose start fails before it takes them leaves both on the shelf for the next. `heir()`
     * is, for a plugin that has closed, the hooks of the newest plugin that took its work over, or
     * null. `leave({ kept, tasks })` puts what this plugin still has going on the shelf as it closes.
     * `handedOver()` resolves once the newest plugin holding this one's work is applied, or once what
     * it left as it closed has expired, so a pass of that work that starts in between waits for the
     * plugin applied after the close rather than run in the one that closed.
     */
    join(folder) {
      const k = folderKey(folder)
      const shelf = shelves.get(k) ?? null
      let next = null
      const place = {
        kept: shelf?.kept ?? null,
        hooks: null,
        take(hooks = {}) {
          place.hooks = hooks
          // Only the shelf there as this plugin started, and only while it waits.
          if (!shelf || shelves.get(k) !== shelf) return []
          shelves.delete(k)
          clearTimer(shelf.timer)
          shelf.from.follow(place)
          shelf.decide()
          return shelf.tasks
        },
        follow(heir) { next = heir },
        heir() {
          let p = next
          while (p?.successor()) p = p.successor()
          return p?.hooks ?? null
        },
        successor: () => next,
        // What this plugin left on the shelf as it closed, while it may still wait there.
        left: null,
        leave({ kept: left = null, tasks = [] } = {}) {
          const old = shelves.get(k)
          if (old) { shelves.delete(k); expire(old) }
          let decide
          const decided = new Promise((r) => { decide = r })
          const mine = { from: place, kept: left, tasks, timer: null, decided, decide }
          mine.timer = setTimer(() => { if (shelves.get(k) === mine) { shelves.delete(k); expire(mine) } }, waitMs)
          mine.timer?.unref?.()
          shelves.set(k, mine)
          place.left = mine
        },
        async handedOver() {
          for (;;) {
            let p = place
            while (p.successor()) p = p.successor()
            // Taken over by a plugin still applied, or by none within the bound: nothing more to wait for.
            if (!p.left || shelves.get(k) !== p.left) return
            await p.left.decided
          }
        },
      }
      return place
    },
    /** Whether a shelf waits on `folder` now. */
    waiting: (folder) => shelves.has(folderKey(folder)),
  }
}

const REGISTRY = Symbol.for('kzh.jev-router.handover')

/** The process's one registry, shared by every copy of this module imported (globalThis under a Symbol). */
export const processHandover = () => (globalThis[REGISTRY] ??= createHandover())
