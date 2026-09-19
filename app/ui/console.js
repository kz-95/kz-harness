// Start screen (#start) and full log window (#logs), fed by the main process.
const view = location.hash === '#logs' ? 'logs' : 'start'
document.getElementById(view).hidden = false

const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
let entries = []
let filter = ''
let level = 'all'

function lineEl(e, needle) {
  const li = document.createElement('li')
  li.className = `line ${e.level}`
  const time = document.createElement('time')
  time.textContent = fmt.format(e.t)
  const mark = document.createElement('span')
  mark.className = 'mark'
  const text = document.createElement('span')
  if (needle) {
    // Highlight matches; built with text nodes only, never innerHTML.
    const lower = e.text.toLowerCase()
    let i = 0
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, i)) {
      text.append(e.text.slice(i, at))
      const m = document.createElement('mark')
      m.textContent = e.text.slice(at, at + needle.length)
      text.append(m)
      i = at + needle.length
    }
    text.append(e.text.slice(i))
  } else text.textContent = e.text
  li.append(time, mark, text)
  return li
}

const passes = (e) =>
  (level === 'all' || (level === 'warn' ? e.level === 'warn' || e.level === 'error' : e.level === 'error')) &&
  (!filter || e.text.toLowerCase().includes(filter))

// ---------- start screen ----------
const mini = document.getElementById('mini')
function pushMini(e) {
  mini.append(lineEl(e))
  while (mini.children.length > 8) mini.firstChild.remove()
}

function showStatus(s) {
  document.body.classList.toggle('is-error', s.phase === 'error')
  document.getElementById('status-text').textContent = s.message
  document.getElementById('error-actions').hidden = s.phase !== 'error'
  const pill = document.getElementById('log-status')
  pill.textContent = { starting: 'starting', ready: 'running', error: 'stopped' }[s.phase] ?? s.phase
  pill.className = `pill ${s.phase}`
}

// ---------- log window ----------
const list = document.getElementById('lines')
const follow = document.getElementById('follow')
const count = document.getElementById('count')

function render() {
  const shown = entries.filter(passes)
  list.replaceChildren(...shown.map((e) => lineEl(e, filter)))
  if (!shown.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = entries.length ? 'No lines match.' : 'Nothing logged yet.'
    list.append(li)
  }
  count.textContent = `${shown.length} of ${entries.length} lines`
  if (follow.checked) list.scrollTop = list.scrollHeight
}

function append(e) {
  entries.push(e)
  if (entries.length > 5000) entries.shift()
  if (view === 'start') return pushMini(e)
  if (!passes(e)) { count.textContent = `${entries.filter(passes).length} of ${entries.length} lines`; return }
  list.querySelector('.empty')?.remove()
  list.append(lineEl(e, filter))
  count.textContent = `${entries.filter(passes).length} of ${entries.length} lines`
  if (follow.checked) list.scrollTop = list.scrollHeight
}

document.getElementById('filter').addEventListener('input', (ev) => { filter = ev.target.value.trim().toLowerCase(); render() })
for (const b of document.querySelectorAll('.seg button')) {
  b.addEventListener('click', () => {
    level = b.dataset.level
    for (const o of document.querySelectorAll('.seg button')) o.setAttribute('aria-checked', String(o === b))
    render()
  })
}
follow.addEventListener('change', () => { if (follow.checked) list.scrollTop = list.scrollHeight })
list.addEventListener('scroll', () => {
  // Scrolling up to read pauses follow; scrolling back to the bottom resumes it.
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 8
  if (follow.checked !== atBottom) follow.checked = atBottom
})
document.getElementById('copy').addEventListener('click', async (ev) => {
  const text = entries.filter(passes).map((e) => `${fmt.format(e.t)}  ${e.text}`).join('\n')
  await navigator.clipboard.writeText(text)
  ev.target.textContent = 'Copied'
  setTimeout(() => { ev.target.textContent = 'Copy' }, 1200)
})

// ---------- wiring ----------
for (const b of document.querySelectorAll('[data-open-logs]')) b.addEventListener('click', () => window.harness.openLogs())
document.getElementById('retry').addEventListener('click', () => window.harness.retry())

window.harness.state().then(({ status, logs }) => {
  showStatus(status)
  if (view === 'start') { logs.slice(-8).forEach(pushMini); entries = logs.slice() } else { entries = logs.slice(); render() }
})
window.harness.onLog(append)
window.harness.onStatus(showStatus)
