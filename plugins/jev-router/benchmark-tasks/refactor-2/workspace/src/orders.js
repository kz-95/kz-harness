// An order moves from pending to paid to shipped, and may be cancelled before it ships.

/** A new order, waiting for payment. */
export function createOrder(id, totalCents) {
  return { id, totalCents, status: 'pending', history: ['pending'] }
}

/** The order in its next state, with that state added to its history. */
export function transition(order, status) {
  return { ...order, status, history: [...order.history, status] }
}

/** Whether the order can still change: it is waiting for payment or paid and not yet shipped. */
export function isOpen(order) {
  return order.status === 'pending' || order.status === 'paid'
}

/** Cancels an order that has not shipped; an order cancelled already stays as it is. */
export function cancel(order) {
  if (order.status === 'shipped') throw new Error(`order ${order.id} has shipped and cannot be cancelled`)
  if (order.status === 'cancelled') return order
  return transition(order, 'cancelled')
}
