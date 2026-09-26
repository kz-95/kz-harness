// Exporting orders as CSV, for the shop's spreadsheet.

/**
 * One line of CSV from cell values. A cell holding a comma, a double quote or a line break is put
 * in double quotes, with each double quote in it doubled.
 * @param {unknown[]} cells
 */
export function csvLine(cells) {
  return cells
    .map((value) => {
      const text = String(value ?? '')
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    })
    .join(',')
}

/**
 * The orders as CSV: a header line, then one line per order, with CRLF line ends.
 * @param {{ id: string, name: string, note: string, totalCents: number }[]} orders
 */
export function ordersCsv(orders) {
  const lines = [csvLine(['id', 'name', 'note', 'total'])]
  for (const order of orders) lines.push(csvLine([order.id, order.name, order.note, (order.totalCents / 100).toFixed(2)]))
  return lines.join('\r\n')
}
