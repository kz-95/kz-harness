// Payment and refunds.
import { transition } from './orders.js'
import { OrderStatus } from './status.js'

/** Pays a pending order in full. */
export function pay(order, amountCents) {
  if (order.status !== OrderStatus.PENDING) throw new Error(`order ${order.id} is ${order.status}, not waiting for payment`)
  if (amountCents !== order.totalCents) throw new Error(`order ${order.id} costs ${order.totalCents} cents, not ${amountCents}`)
  return transition(order, OrderStatus.PAID)
}

/** Whether money was taken for the order and has to be given back: it was paid and then cancelled. */
export function needsRefund(order) {
  return order.status === OrderStatus.CANCELLED && order.history.includes(OrderStatus.PAID)
}
