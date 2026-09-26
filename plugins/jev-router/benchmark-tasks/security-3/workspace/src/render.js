// The order page.

/** Text made safe for HTML element content and attribute values. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** An amount in cents as money, such as 12.50. */
export function formatCents(cents) {
  return (cents / 100).toFixed(2)
}

/**
 * The HTML of one order: its id, the customer's name, the note the customer left, and the total.
 * @param {{ id: string, name: string, note: string, totalCents: number }} order
 */
export function renderOrder(order) {
  return [
    '<article class="order">',
    `  <h1>Order ${escapeHtml(order.id)} for ${escapeHtml(order.name)}</h1>`,
    `  <p class="note">${order.note}</p>`,
    `  <p class="total">Total: ${formatCents(order.totalCents)}</p>`,
    '</article>',
  ].join('\n')
}
