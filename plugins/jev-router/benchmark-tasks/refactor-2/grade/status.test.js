import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const src = join(process.env.BENCH_WORKSPACE, 'src')
const load = (name) => import(pathToFileURL(join(src, name)).href)
const STATES = ['pending', 'paid', 'shipped', 'cancelled']

test('orders behave as before', async () => {
  const { cancel, createOrder, isOpen, transition } = await load('orders.js')
  const { needsRefund, pay } = await load('billing.js')
  const { canShip, ship } = await load('shipping.js')
  const order = createOrder('o1', 900)
  assert.deepEqual(order, { id: 'o1', totalCents: 900, status: 'pending', history: ['pending'] })
  assert.equal(isOpen(order), true)
  assert.throws(() => pay(order, 800), /costs 900 cents, not 800/)
  const paid = pay(order, 900)
  assert.deepEqual(paid.history, ['pending', 'paid'])
  assert.equal(canShip(order), false)
  assert.equal(canShip(paid), true)
  assert.throws(() => ship(order), /must be paid before it ships/)
  const shipped = ship(paid)
  assert.equal(shipped.status, 'shipped')
  assert.equal(isOpen(shipped), false)
  assert.throws(() => cancel(shipped), /has shipped and cannot be cancelled/)
  assert.throws(() => pay(paid, 900), /is paid, not waiting for payment/)
  const refunded = cancel(paid)
  assert.equal(refunded.status, 'cancelled')
  assert.equal(needsRefund(refunded), true)
  assert.equal(needsRefund(cancel(createOrder('o2', 5))), false)
  assert.equal(cancel(refunded), refunded, 'an order cancelled already stays as it is')
  assert.deepEqual(transition(order, 'paid').history, ['pending', 'paid'])
})

test('the report behaves as before', async () => {
  const { statusLabel, summary } = await load('report.js')
  assert.deepEqual(summary([{ status: 'paid' }, { status: 'paid' }, { status: 'cancelled' }]), { pending: 0, paid: 2, shipped: 0, cancelled: 1 })
  assert.deepEqual(Object.keys(summary([])), STATES)
  assert.deepEqual(STATES.map(statusLabel), ['Waiting for payment', 'Paid, not shipped yet', 'On its way', 'Cancelled'])
  assert.equal(statusLabel('lost'), 'Unknown')
})

test('OrderStatus is a frozen object with exactly the four states', async () => {
  const { OrderStatus } = await load('status.js')
  assert.ok(Object.isFrozen(OrderStatus), 'OrderStatus is frozen')
  assert.deepEqual({ ...OrderStatus }, { PENDING: 'pending', PAID: 'paid', SHIPPED: 'shipped', CANCELLED: 'cancelled' })
})

/** Every .js file under src/, as [path from src/ with forward slashes, text]. */
function sources(dir = src) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.js') ? [[relative(src, path).split('\\').join('/'), readFileSync(path, 'utf8')]] : []
  })
}

/**
 * The string literals of a script, comments left out: the value of every '...' and "..." string
 * and of every template literal without a substitution. A slash starts a regular expression where
 * an expression may begin, so a quote inside one is not taken for a string.
 */
function stringLiterals(code) {
  const out = []
  let i = 0
  let last = ''
  const braces = []
  const readQuoted = (q) => {
    let value = ''
    for (i++; i < code.length && code[i] !== q; i++) {
      if (code[i] === '\\') { value += code[i + 1]; i++ } else value += code[i]
    }
    i++
    return value
  }
  const readTemplate = () => {
    let value = ''
    let plain = true
    for (i++; i < code.length; i++) {
      if (code[i] === '\\') { value += code[i + 1]; i++ } else if (code[i] === '`') { i++; if (plain) out.push(value); return } else if (code[i] === '$' && code[i + 1] === '{') { plain = false; braces.push('template'); i += 2; return } else value += code[i]
    }
  }
  while (i < code.length) {
    const c = code[i]
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue }
    if (c === '/' && code[i + 1] === '*') { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue }
    if (c === '"' || c === "'") { out.push(readQuoted(c)); last = 'x'; continue }
    if (c === '`') { readTemplate(); last = 'x'; continue }
    if (c === '{') { braces.push('code'); last = c; i++; continue }
    if (c === '}') {
      if (braces.pop() === 'template') {
        // The rest of a template after a substitution: its text is no literal of its own.
        for (; i < code.length; i++) {
          if (code[i] === '\\') i++
          else if (code[i] === '`') { i++; break } else if (code[i] === '$' && code[i + 1] === '{') { braces.push('template'); i += 2; break }
        }
      } else i++
      last = '}'
      continue
    }
    if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(code.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let inClass = false
      for (i++; i < code.length; i++) {
        if (code[i] === '\\') i++
        else if (code[i] === '[') inClass = true
        else if (code[i] === ']') inClass = false
        else if (code[i] === '/' && !inClass) { i++; break }
      }
      while (/[a-z]/i.test(code[i] ?? '')) i++
      last = 'x'
      continue
    }
    if (!/\s/.test(c)) last = c
    i++
  }
  return out
}

test('no bare state string is left in src/ outside src/status.js', () => {
  const left = sources().filter(([file]) => file !== 'status.js').flatMap(([file, text]) => stringLiterals(text).filter((s) => STATES.includes(s)).map((s) => `${file}: '${s}'`))
  assert.deepEqual(left, [])
})

test('every file that used a state imports ./status.js', () => {
  for (const file of ['orders.js', 'billing.js', 'shipping.js', 'report.js']) {
    assert.match(readFileSync(join(src, file), 'utf8'), /\bfrom\s*['"]\.\/status\.js['"]/, `${file} imports ./status.js`)
  }
})
