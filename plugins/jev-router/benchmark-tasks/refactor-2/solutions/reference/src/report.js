// What the shop's dashboard shows about orders.
import { OrderStatus } from './status.js'

/** How many orders are in each state. */
export function summary(orders) {
  const counts = Object.fromEntries(Object.values(OrderStatus).map((status) => [status, 0]))
  for (const order of orders) counts[order.status]++
  return counts
}

/** The words a customer sees for a state. */
export function statusLabel(status) {
  switch (status) {
    case OrderStatus.PENDING:
      return 'Waiting for payment'
    case OrderStatus.PAID:
      return 'Paid, not shipped yet'
    case OrderStatus.SHIPPED:
      return 'On its way'
    case OrderStatus.CANCELLED:
      return 'Cancelled'
    default:
      return 'Unknown'
  }
}
