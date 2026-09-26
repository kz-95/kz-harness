// Placing an order: reserve the stock, charge the customer, and keep the stock.
import { FREE_SHIPPING_FROM, shippingCents } from './shipping.js'

/**
 * @param {{ reservations: ReturnType<import('./reservations.js').createReservations>, payments: { charge(customer: string, cents: number): Promise<{ id: string }> } }} deps
 */
export function createOrders({ reservations, payments }) {
  return {
    /**
     * Places an order for `qty` units of one SKU. `unitCents` is the price of one unit and
     * `unitGrams` its weight in grams.
     *
     * Resolves to { orderId, paymentId, totalCents } once the stock is reserved and the customer
     * has been charged. Throws when the stock is not there, and then charges nothing. When the
     * payment fails its error is thrown, and the stock is not kept for the order.
     */
    async placeOrder({ orderId, customer, sku, qty, unitCents, unitGrams }) {
      const reservation = reservations.reserve(orderId, sku, qty)
      if (!reservation) throw new Error(`${sku} is out of stock`)
      const goods = unitCents * qty
      const shipping = goods >= FREE_SHIPPING_FROM ? 0 : shippingCents(unitGrams * qty)
      const totalCents = goods + shipping
      let payment
      try {
        payment = await payments.charge(customer, totalCents)
      } catch (err) {
        throw new Error(`payment for order ${orderId} failed: ${err.message}`)
      }
      reservations.confirm((await reservation).id)
      return { orderId, paymentId: payment.id, totalCents }
    },
  }
}
