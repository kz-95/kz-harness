// Shipping paid orders.
import { transition } from './orders.js'
import { OrderStatus } from './status.js'

/** Whether the order can ship now. */
export function canShip(order) {
  return order.status === OrderStatus.PAID
}

/** Ships a paid order. */
export function ship(order) {
  if (!canShip(order)) throw new Error(`order ${order.id} must be paid before it ships`)
  return transition(order, OrderStatus.SHIPPED)
}
