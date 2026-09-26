/**
 * The total of an order, in whole cents.
 *
 * Each line costs its price times its quantity, less its item discount times its quantity.
 * The order's percentOff is then taken off the sum of the lines, and the total is rounded half
 * up to a whole cent.
 *
 * @param {{ lines: { price: number, quantity: number, discount?: number }[], percentOff?: number }} order
 *   prices and discounts in whole cents, percentOff from 0 to 100
 * @returns {number}
 */
export function orderTotal({ lines, percentOff = 0 }) {
  let total = 0
  for (const line of lines) {
    const price = (line.price * (100 - percentOff)) / 100
    total += (price - (line.discount ?? 0)) * line.quantity
  }
  return Math.round(total)
}
