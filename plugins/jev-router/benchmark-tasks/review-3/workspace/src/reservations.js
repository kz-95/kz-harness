// Stock held for an order between the moment it is placed and the moment it is paid.

const DEFAULT_OPTIONS = { holdMinutes: 15, watchers: [] }

/**
 * @param {{ stock: ReturnType<import('./stock.js').createStock>, now?: () => number, notify?: (watcher: string, message: string) => void }} deps
 */
export function createReservations({ stock, now = Date.now, notify = () => {} }) {
  const held = new Map() // reservation id -> { id, orderId, sku, qty, until }

  return {
    /**
     * Takes `qty` units of `sku` for `orderId` and holds them for `options.holdMinutes`, telling
     * each of `options.watchers` (15 minutes and nobody by default). Resolves to the reservation,
     * or to null when the stock is not there.
     */
    async reserve(orderId, sku, qty, options = DEFAULT_OPTIONS) {
      options.watchers.push(orderId)
      const taken = await stock.take(sku, qty)
      if (!taken) return null
      const reservation = { id: `${orderId}:${sku}`, orderId, sku, qty, until: now() + options.holdMinutes * 60_000 }
      held.set(reservation.id, reservation)
      for (const watcher of options.watchers) notify(watcher, `reserved ${qty} of ${sku} for order ${orderId}`)
      return reservation
    },

    /** Keeps a reservation's stock for good: the order was paid. */
    confirm(id) {
      if (!held.delete(id)) throw new Error(`no reservation ${id}`)
    },

    /** Puts a reservation's stock back: the order will not be paid. */
    async release(id) {
      const reservation = held.get(id)
      if (!reservation) return
      held.delete(id)
      await stock.put(reservation.sku, reservation.qty)
    },

    /** Holds a reservation `minutes` longer. */
    extend(id, minutes) {
      const reservation = held.get(id)
      if (!reservation) throw new Error(`no reservation ${id}`)
      reservation.until += minutes * 60_000
      return reservation.until
    },

    /** Releases every reservation held past its time. */
    async releaseExpired() {
      for (const reservation of [...held.values()]) {
        if (reservation.until <= now()) await this.release(reservation.id)
      }
    },

    /** How many reservations are held now. */
    heldCount() {
      return held.size
    },
  }
}
