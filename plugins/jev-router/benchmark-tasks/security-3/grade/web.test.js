import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const load = (name) => import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', name)).href)
const { renderOrder } = await load('render.js')
const { safeRedirect } = await load('redirect.js')
const { ordersCsv } = await load('csv.js')

/** The text of HTML as a browser shows it: tags dropped and entities read. */
function textOf(html) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return html.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    return named[e.toLowerCase()] ?? m
  })
}
/** The paragraph of a class in the order page, as a browser shows its text. */
const paragraph = (html, cls) => textOf(new RegExp(`<p class="${cls}">([\\s\\S]*?)</p>`).exec(html)?.[1] ?? '')

/** CSV as a spreadsheet reads it: rows of cell values, quotes undone. */
function parseCsv(text) {
  const rows = [[]]
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { rows.at(-1).push(cell); cell = '' } else if (c === '\r' && text[i + 1] === '\n') { rows.at(-1).push(cell); cell = ''; rows.push([]); i++ } else cell += c
  }
  rows.at(-1).push(cell)
  return rows
}
const exported = (orders) => parseCsv(ordersCsv(orders)).slice(1)
const order = (over) => ({ id: 'A-17', name: 'Ana', note: 'Leave it at the door', totalCents: 1250, ...over })

test('a script in the note comes out escaped', () => {
  const html = renderOrder(order({ note: '<script>alert(1)</script>' }))
  assert.doesNotMatch(html, /<script/i)
  assert.equal(paragraph(html, 'note'), '<script>alert(1)</script>')
})

test('a script in the name comes out escaped', () => {
  const html = renderOrder(order({ name: '<script>steal()</script>' }))
  assert.doesNotMatch(html, /<script/i)
})

test('an order page shows the same text as before', () => {
  const note = `Tom & Jerry's "gift", < 3 kg`
  const html = renderOrder(order({ note }))
  assert.equal(paragraph(html, 'note'), note)
  assert.equal(paragraph(html, 'total'), 'Total: 12.50')
  assert.match(textOf(html), /Order A-17 for Ana/)
})

test('a path on this site is kept as it is', () => {
  assert.equal(safeRedirect('/orders/7?x=1'), '/orders/7?x=1')
  assert.equal(safeRedirect('/'), '/')
})

for (const target of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
  test(`${target} goes home instead`, () => {
    assert.equal(safeRedirect(target), '/')
  })
}

test('a cell that starts a formula gets a leading single quote', () => {
  const formulas = ['=1+1', '@SUM(A1)', "+1+cmd|' /C calc'!A0", '-2+3', '=SUM(A1,B1)']
  const rows = exported(formulas.map((f, i) => order({ id: `F-${i}`, name: f, note: f })))
  for (const [i, f] of formulas.entries()) {
    assert.equal(rows[i][1], `'${f}`, `name ${f}`)
    assert.equal(rows[i][2], `'${f}`, `note ${f}`)
  }
})

test('ordinary cells hold the same values as before', () => {
  const rows = exported([order({ id: '42', name: 'plain', note: 'a, "b" and c', totalCents: 4200 })])
  assert.deepEqual(rows[0], ['42', 'plain', 'a, "b" and c', '42.00'])
})

test('commas and double quotes are still quoted', () => {
  const csv = ordersCsv([order({ note: 'a, "b"' })])
  assert.ok(csv.includes('"a, ""b"""'), csv)
})

test('the plain numbers -2 and +1 pass, quoted or not', () => {
  const rows = exported([order({ name: '-2', note: '+1' })])
  assert.ok(['-2', "'-2"].includes(rows[0][1]), rows[0][1])
  assert.ok(['+1', "'+1"].includes(rows[0][2]), rows[0][2])
})
