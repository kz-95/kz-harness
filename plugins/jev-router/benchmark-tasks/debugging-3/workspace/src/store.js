// The price store: the slow source of truth the cache sits in front of. In production this is a
// database; here it is a map, and it counts its reads so the cache's effect can be seen.

/**
 * @param {Record<string, number>} [initial] price in cents by SKU
 */
export function createStore(initial = {}) {
  const prices = new Map(Object.entries(initial))
  let reads = 0
  return {
    /** The price of `sku` in cents, or null when the store has none. */
    async read(sku) {
      reads++
      return prices.has(sku) ? prices.get(sku) : null
    },
    async write(sku, cents) {
      prices.set(sku, cents)
    },
    /** How many times read() has been called. */
    get reads() {
      return reads
    },
  }
}
