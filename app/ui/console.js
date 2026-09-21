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
// Collapsed the splash shows the last few lines; expanded it keeps a scrollback in place,
// so you can read what is happening without opening a second window.
let miniCap = 8
function trimMini() { while (mini.children.length > miniCap) mini.firstChild.remove() }
function pushMini(e) {
  mini.append(lineEl(e))
  trimMini()
  if (document.querySelector('.mini-console')?.classList.contains('expanded')) mini.lastChild?.scrollIntoView({ block: 'end' })
}

const expand = document.getElementById('expand')
expand?.addEventListener('click', async () => {
  const box = document.querySelector('.mini-console')
  const open = !box.classList.contains('expanded')
  box.classList.toggle('expanded', open)
  expand.setAttribute('aria-expanded', String(open))
  expand.textContent = open ? 'Show less' : 'Show more'
  miniCap = open ? 500 : 8
  if (open) {
    // Backfill what happened before the page was ready, rather than only what arrives next.
    const state = await window.harness?.state?.().catch(() => null)
    if (state?.logs?.length) {
      mini.replaceChildren(...state.logs.slice(-miniCap).map((e) => lineEl(e)))
      mini.lastChild?.scrollIntoView({ block: 'end' })
    }
  } else trimMini()
})

const stepsEl = document.getElementById('steps')
function showSteps(s) {
  if (!stepsEl) return
  const steps = s.steps ?? []
  // Nothing useful to show once it is running, or when the launcher sent no step list.
  if (!steps.length || s.phase === 'ready') { stepsEl.replaceChildren(); stepsEl.hidden = true; return }
  const at = steps.findIndex((x) => x.id === s.step)
  stepsEl.hidden = false
  // Only steps the launcher actually reported are ticked. A first run fetches the engine and
  // a later one does not, so ticking everything above the current step would claim work that
  // never happened.
  const done = new Set(s.done ?? [])
  stepsEl.replaceChildren(...steps.map((step, i) => {
    const li = document.createElement('li')
    const state = i < at ? (done.has(step.id) ? 'done' : 'skipped')
      : i === at && s.phase !== 'error' ? 'now'
      : 'todo'
    li.className = state
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.textContent = { done: '\u2713', now: '\u25cf', skipped: '\u2013' }[state] ?? '\u25cb'
    const text = document.createElement('span')
    text.textContent = state === 'skipped' ? `${step.label} - not needed` : step.label
    li.append(dot, text)
    return li
  }))
}

function showStatus(s) {
  showSteps(s)
  document.body.classList.toggle('is-error', s.phase === 'error')
  document.getElementById('status-text').textContent = s.message
  document.getElementById('error-actions').hidden = s.phase !== 'error'
  // "Use it here" only makes sense while an orphaned engine holds the port and the launcher
  // has confirmed nothing else owns it. Foreign holders and other live harnesses hide it.
  const useHere = document.getElementById('use-here')
  useHere.hidden = !(s.phase === 'error' && s.holder === 'orphan')
  useHere.disabled = false
  useHere.textContent = 'Use it here'
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
// The launcher re-inspects the holder before stopping anything, so a port that changed hands
// between the error state and this click is never killed from here.
document.getElementById('use-here').addEventListener('click', async (ev) => {
  ev.target.disabled = true
  ev.target.textContent = 'Stopping the orphaned engine…'
  const r = await window.harness.useHere().catch(() => null)
  if (!r?.ok) ev.target.textContent = 'Use it here'
})

// Main window only: our own title bar with the ☰ menu (the log window keeps the normal frame).
if (view === 'start') {
  document.getElementById('titlebar').hidden = false
  document.body.classList.add('has-titlebar')
  const b = document.getElementById('tb-menu')
  b.addEventListener('click', () => { const r = b.getBoundingClientRect(); window.harness.menu({ x: r.left, y: r.bottom }) })
}

window.harness.state().then(({ status, logs }) => {
  showStatus(status)
  if (view === 'start') { logs.slice(-8).forEach(pushMini); entries = logs.slice() } else { entries = logs.slice(); render() }
})
window.harness.onLog(append)
window.harness.onStatus(showStatus)
