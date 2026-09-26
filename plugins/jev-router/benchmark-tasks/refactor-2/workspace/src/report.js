// What the shop's dashboard shows about orders.

/** How many orders are in each state. */
export function summary(orders) {
  const counts = Object.fromEntries(['pending', 'paid', 'shipped', 'cancelled'].map((status) => [status, 0]))
  for (const order of orders) counts[order.status]++
  return counts
}

/** The words a customer sees for a state. */
export function statusLabel(status) {
  switch (status) {
    case 'pending':
      return 'Waiting for payment'
    case 'paid':
      return 'Paid, not shipped yet'
    case 'shipped':
      return 'On its way'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Unknown'
  }
}
