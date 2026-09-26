// The states an order can be in, written in one place.

export const OrderStatus = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  SHIPPED: 'shipped',
  CANCELLED: 'cancelled',
})
