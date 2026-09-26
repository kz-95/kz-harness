// Payment and refunds.
import { transition } from './orders.js'

/** Pays a pending order in full. */
export function pay(order, amountCents) {
  if (order.status !== 'pending') throw new Error(`order ${order.id} is ${order.status}, not waiting for payment`)
  if (amountCents !== order.totalCents) throw new Error(`order ${order.id} costs ${order.totalCents} cents, not ${amountCents}`)
  return transition(order, 'paid')
}

/** Whether money was taken for the order and has to be given back: it was paid and then cancelled. */
export function needsRefund(order) {
  return order.status === 'cancelled' && order.history.includes('paid')
}
