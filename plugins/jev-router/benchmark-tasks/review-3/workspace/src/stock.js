// Stock levels per SKU. Every change of a level runs under that SKU's lock, so two changes to one
// SKU never interleave.

/**
 * @param {Record<string, number>} [initial] units in stock by SKU
 */
export function createStock(initial = {}) {
  const levels = new Map(Object.entries(initial))
  const locks = new Map()

  /** Runs `change` once every earlier change of `sku` has finished, and resolves to its result. */
  function withLock(sku, change) {
    const before = locks.get(sku) ?? Promise.resolve()
    const run = before.then(change)
    locks.set(sku, run.catch(() => {}))
    return run
  }

  return {
    /** Units of `sku` in stock now. */
    available(sku) {
      return levels.get(sku) ?? 0
    },

    /**
     * Takes `qty` units of `sku` when at least that many are in stock, and resolves to true;
     * otherwise takes nothing and resolves to false.
     */
    take(sku, qty) {
      return withLock(sku, async () => {
        const have = levels.get(sku) ?? 0
        if (have > qty) {
          levels.set(sku, have - qty)
          return true
        }
        return false
      })
    },

    /** Puts `qty` units of `sku` back. */
    put(sku, qty) {
      return withLock(sku, async () => {
        levels.set(sku, (levels.get(sku) ?? 0) + qty)
      })
    },

    /** The SKUs with fewer than `threshold` units left, fewest first. */
    lowStock(threshold) {
      return [...levels]
        .filter(([, units]) => units < threshold)
        .sort((a, b) => a[1] - b[1])
        .map(([sku, units]) => ({ sku, units }))
    },
  }
}
