// Prices by SKU, read through a cache in front of the store.
import { createCache } from './cache.js'

/**
 * @param {{ store: object, cache?: object }} deps
 */
export function createPrices({ store, cache = createCache({ capacity: 500, ttlMs: 60_000 }) }) {
  return {
    /** The price of `sku` in cents, or null when there is none. */
    async getPrice(sku) {
      const cached = cache.get(sku)
      if (cached !== undefined) return cached
      const cents = await store.read(sku)
      if (cents !== null) cache.set(sku, cents)
      return cents
    },

    /** Changes one price. */
    async updatePrice(sku, cents) {
      await store.write(sku, cents)
      cache.set(sku, cents)
    },

    /** Changes many prices at once, from a supplier's list. */
    async importPrices(list) {
      for (const { sku, cents } of list) {
        await store.write(sku, cents)
        cache.set(sku, cents)
      }
    },
  }
}
