// Shipping paid orders.
import { transition } from './orders.js'

/** Whether the order can ship now. */
export function canShip(order) {
  return order.status === 'paid'
}

/** Ships a paid order. */
export function ship(order) {
  if (!canShip(order)) throw new Error(`order ${order.id} must be paid before it ships`)
  return transition(order, 'shipped')
}
