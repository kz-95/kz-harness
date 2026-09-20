// Time-of-day pricing: which agents are on their cheap rate right now.
// DeepSeek's discount window wraps past midnight UTC, which is the part that breaks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inUtcWindow, pricingNow } from '../router.js'

const utc = (h, m = 0) => Date.UTC(2026, 0, 15, h, m)

test('inUtcWindow: a window that wraps past midnight', () => {
  // DeepSeek's default: 16:30 -> 00:30 UTC.
  for (const [h, m] of [[16, 30], [17, 0], [23, 59], [0, 0], [0, 29]]) {
    assert.equal(inUtcWindow(utc(h, m), '16:30', '00:30'), true, `${h}:${m} is off-peak`)
  }
  for (const [h, m] of [[0, 30], [1, 0], [9, 0], [16, 29]]) {
    assert.equal(inUtcWindow(utc(h, m), '16:30', '00:30'), false, `${h}:${m} is standard rate`)
  }
})

test('inUtcWindow: a plain window, its edges, and a Date', () => {
  assert.equal(inUtcWindow(utc(9), '09:00', '17:00'), true, 'start is inside')
  assert.equal(inUtcWindow(utc(17), '09:00', '17:00'), false, 'end is outside')
  assert.equal(inUtcWindow(utc(16, 59), '09:00', '17:00'), true)
  assert.equal(inUtcWindow(new Date(utc(12)), '09:00', '17:00'), true, 'takes a Date too')
  // Equal ends mean "always", not "never": the window wraps the whole day.
  assert.equal(inUtcWindow(utc(3), '12:00', '12:00'), true)
})

test('inUtcWindow: rejects anything that is not HH:MM', () => {
  for (const bad of ['', '9', '9am', '24:00', '12:60', '1:2', null, undefined]) {
    assert.throws(() => inUtcWindow(utc(12), bad, '17:00'), /HH:MM/, JSON.stringify(bad))
  }
})

// DeepSeek's real scheme from 2026-09-10: dearer only Mon-Fri 09:00-12:00 and 14:00-18:00
// Beijing, which is 01:00-04:00 and 06:00-10:00 UTC. Everything else is the cheap rate.
// 2026-01-15 is a Thursday; 2026-01-17 is a Saturday.
const DS = {
  deepseek: {
    windowsUtc: [{ fromUtc: '01:00', toUtc: '04:00' }, { fromUtc: '06:00', toUtc: '10:00' }],
    daysUtc: [1, 2, 3, 4, 5],
    note: 'twice off-peak on every line',
  },
}
const sat = (h) => Date.UTC(2026, 0, 17, h)

test('pricingNow: peak only inside a weekday window, off-peak everywhere else', () => {
  for (const h of [1, 3, 6, 9]) assert.match(pricingNow(DS, utc(h)).deepseek, /peak rate until/, `${h}:00 Thursday is peak`)
  // The gap between the two windows, and the evening: both already the cheap rate.
  for (const h of [0, 4, 5, 10, 18, 23]) assert.match(pricingNow(DS, utc(h)).deepseek, /off-peak rate/, `${h}:00 Thursday is off-peak`)
})

test('pricingNow: the whole weekend is off-peak, including business hours', () => {
  for (const h of [1, 3, 6, 9]) assert.match(pricingNow(DS, sat(h)).deepseek, /off-peak rate/, `${h}:00 Saturday is off-peak`)
})

test('pricingNow: names the window end and carries the note', () => {
  assert.match(pricingNow(DS, utc(6)).deepseek, /until 10:00 UTC/, 'the window it is actually in, not the first one')
  assert.match(pricingNow(DS, utc(1)).deepseek, /until 04:00 UTC/)
  assert.match(pricingNow(DS, utc(18)).deepseek, /twice off-peak on every line/)
})

test('pricingNow: a window it cannot read tells Jev nothing, even outside peak hours', () => {
  const broken = { broken: { windowsUtc: [{ fromUtc: '01:00', toUtc: '04:00' }, { fromUtc: 'lunchtime', toUtc: '10:00' }] } }
  // The good window does not match at 18:00, so a partial check would call it off-peak and
  // sound authoritative about a config it could not parse.
  assert.equal('broken' in pricingNow(broken, utc(18)), false)
  assert.equal('broken' in pricingNow(broken, utc(2)), false)
  assert.deepEqual(pricingNow({ empty: { windowsUtc: [] } }, utc(9)), {}, 'no windows, nothing said')
  assert.deepEqual(pricingNow(), {}, 'nothing configured, nothing said')
})
