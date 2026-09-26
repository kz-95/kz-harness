import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ordersCsv } from '../src/csv.js'
import { safeRedirect } from '../src/redirect.js'
import { renderOrder } from '../src/render.js'

test('an order page shows the order', () => {
  const html = renderOrder({ id: 'A-17', name: 'Ana', note: 'Leave it at the door', totalCents: 1250 })
  assert.match(html, /Order A-17 for Ana/)
  assert.match(html, /Leave it at the door/)
  assert.match(html, /Total: 12\.50/)
})

test('a redirect to a page of this site is kept', () => {
  assert.equal(safeRedirect('/orders/7'), '/orders/7')
  assert.equal(safeRedirect(''), '/')
})

test('orders export as CSV', () => {
  assert.equal(ordersCsv([{ id: 'A-17', name: 'Ana', note: 'Leave it at the door', totalCents: 1250 }]), 'id,name,note,total\r\nA-17,Ana,Leave it at the door,12.50')
})
