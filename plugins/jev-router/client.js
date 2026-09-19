// Browser half of jev-router, loaded by DSH as a classic script (no build
// step, so plain React.createElement). Two surfaces:
//   - "Jev" tab in the right sidebar: router decisions per run, Jev's questions
//     and probabilities, subagents and background jobs of the session.
//   - "Jev setup" page in Settings: agent logins, on/off switches (at least one
//     LLM stays on), user-added API-key agents, tools.
//   - Brand: the Kz Harness logo replaces the DeepSeek mark (sidebar, hero).
// Data comes from the server half's /jev-router/* routes.
window.__ModuleLoader__.load({
  id: 'jev-router',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React
    const TAB_ID = 'jev-router/inspector'
    const KIND = 'jev-inspector'
    let sessionsApi // ctx.sessions, captured in apply

    // ---------- helpers ----------
    const api = async (path, init) => {
      const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      return body
    }
    const ms = (n) => (n == null ? '–' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`)
    const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '–')
    const cx = (...c) => c.filter(Boolean).join(' ')

    // DSH design tokens only (fonts, labels, surfaces, borders, states), so both themes follow the app.
    const CSS = `
.jevi{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);padding:12px 14px 24px;overflow:auto;height:100%;box-sizing:border-box}
.jevi h3{font:var(--dsw-font-s-strong-14);margin:0}
.jevi p{margin:4px 0 12px}
.jevi .muted,.jevi .why{color:var(--dsw-alias-label-tertiary)}
.jevi .why{font:var(--dsw-font-xxs-12)}
.jevi code,.jevi dd{font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xxs-12-font-size)}
.jevi .tabs{display:flex;gap:4px;margin:10px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.jevi .tabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary);padding:6px 8px;cursor:pointer;font:var(--dsw-font-xs-13);transition:color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.jevi .tabs button:hover{color:var(--dsw-alias-label-primary)}
.jevi .tabs button[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-strong-13)}
.jevi .tabs .n{font:var(--dsw-font-xxxs-11);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:1px 6px;margin-left:5px}
.jevi .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0 12px}
.jevi .stat{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 4px;text-align:center}
.jevi .stat b{display:block;font:var(--dsw-font-s-strong-14);margin-top:2px}
.jevi .stat small{display:block;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-caption)}
.jevi .card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;margin:0 0 10px}
.jevi .label{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-caption);margin:0 0 8px}
.jevi .badge{display:inline-block;border-radius:6px;padding:0 7px;margin-right:8px;font:var(--dsw-font-xxs-strong-12);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.jevi .badge.tool{background:var(--dsw-alias-state-success-primary)}
.jevi .badge.fallback{background:var(--dsw-alias-state-warn-primary)}
.jevi .badge.manual{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.jevi .pill{display:inline-block;border-radius:6px;padding:0 6px;margin-left:6px;font:var(--dsw-font-xxxs-11);line-height:18px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.jevi .pill.ok{color:var(--dsw-alias-state-success-primary)}
.jevi .pill.bad{color:var(--dsw-alias-state-error-primary)}
.jevi .pill.warn{color:var(--dsw-alias-state-warn-label)}
.jevi dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:8px 0 0}
.jevi dt{color:var(--dsw-alias-label-tertiary)}
.jevi dd{margin:0;word-break:break-word;align-self:center}
.jevi ol.steps{margin:0;padding-left:18px}
.jevi ol.steps li{margin:0 0 8px}
.jevi details.q{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:10px;padding:8px 10px;margin:0 0 6px}
.jevi details.q.unused{opacity:.55}
.jevi details.q summary{cursor:pointer;list-style:none}
.jevi details.q summary::-webkit-details-marker{display:none}
.jevi .ans{font:var(--dsw-font-xs-strong-13);margin-top:2px}
.jevi .opt{margin:6px 0 0}
.jevi .opt .row{display:flex;justify-content:space-between;gap:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.jevi .opt .row span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jevi .bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);margin-top:3px}
.jevi .bar i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.jevi .toggle{display:flex;align-items:center;gap:6px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);cursor:pointer}
.jevi .head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.jevi select,.jevi input[type=text]{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;max-width:100%;box-sizing:border-box}
.jevi select:focus-visible,.jevi input:focus-visible,.jevi button:focus-visible,.jevi a:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.jevi button.btn{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-elevated-fill);border:0;border-radius:8px;padding:5px 12px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.jevi button.btn:hover{background:var(--dsw-alias-interactive-bg-hover-accent)}
.jevi button.btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.jevi button.btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.jevi button.btn.danger{background:transparent;color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.jevi button.btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.jevi button.btn:disabled{opacity:.45;cursor:not-allowed}
.jevi ul.plain{list-style:none;margin:0;padding:0}
.jevi ul.plain li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.jevi ul.plain li:last-child{border-bottom:0}
.jevi .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption);margin-right:7px;vertical-align:1px}
.jevi .dot.on{background:var(--dsw-alias-state-success-primary)}
.jevi .dot.off{background:var(--dsw-alias-state-error-primary)}
.jevi a.link{color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:none;font:var(--dsw-font-xxs-strong-12)}
.jevi .err{color:var(--dsw-alias-state-error-primary);margin:6px 0}
.jevi .empty{color:var(--dsw-alias-label-tertiary);padding:24px 8px;text-align:center}
.jevi-modal{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;z-index:10000;height:auto;padding:0}
.jevi-modal .box{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px;max-width:380px;width:calc(100% - 32px);box-shadow:0 10px 40px var(--dsw-alias-bg-mask-3)}
.jevi-modal .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
`
    function useStyle() {
      useEffect(() => {
        if (document.getElementById('jevi-style')) return
        const s = document.createElement('style')
        s.id = 'jevi-style'
        s.textContent = CSS
        document.head.appendChild(s)
      }, [])
    }

    /** Confirmation overlay: names what goes, clear cancel. */
    function Confirm({ title, body, confirmLabel, onCancel, onConfirm }) {
      useEffect(() => {
        const k = (e) => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', k)
        return () => window.removeEventListener('keydown', k)
      }, [onCancel])
      return h('div', { className: 'jevi jevi-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'jevi-confirm-t', onClick: onCancel },
        h('div', { className: 'box', onClick: (e) => e.stopPropagation() },
          h('h3', { id: 'jevi-confirm-t' }, title),
          h('p', null, body),
          h('div', { className: 'actions' },
            h('button', { className: 'btn', onClick: onCancel, autoFocus: true }, 'Cancel'),
            h('button', { className: 'btn danger', onClick: onConfirm }, confirmLabel))))
    }

    // ---------- inspector: data ----------
    function useRuns(sessionId, visible) {
      const [runs, setRuns] = useState([])
      useEffect(() => {
        if (!visible || !sessionId) return
        let stop = false
        let timer
        const tick = async () => {
          try { const r = await api(`/jev-router/log?session=${encodeURIComponent(sessionId)}`); if (!stop) setRuns(r) } catch {}
          // ponytail: 1 s poll of a localhost route; switch to SSE if it ever shows up in profiles.
          if (!stop) timer = setTimeout(tick, 1000)
        }
        tick()
        return () => { stop = true; clearTimeout(timer) }
      }, [sessionId, visible])
      return runs
    }

    function summarize(run) {
      const ev = run.events
      const first = run.startedAt ?? ev[0]?.at ?? Date.now()
      const last = ev.at(-1)
      const final = ev.find((e) => e.type === 'final')
      const error = ev.find((e) => e.type === 'error')
      const routed = ev.find((e) => e.type === 'routed')
      const traces = ev.filter((e) => e.type === 'jev').map((e) => e.trace)
      const starts = ev.filter((e) => e.type === 'attempt_start')
      const ends = ev.filter((e) => e.type === 'attempt_end')
      const reviews = ev.filter((e) => e.type === 'review')
      const running = !final && !error
      const attempts = starts.map((s) => ({ ...s, end: ends.find((x) => x.index === s.index)?.attempt, review: reviews.find((x) => x.index === s.index)?.assessment }))
      const toolMs = attempts.filter((a) => a.role === 'tool').reduce((t, a) => t + (a.end?.durationMs ?? 0), 0)
      const agentMs = attempts.filter((a) => a.role !== 'tool').reduce((t, a) => t + (a.end?.durationMs ?? 0), 0)
      const jevMs = traces.reduce((t, x) => t + x.ms, 0)
      const q = traces.flatMap((t) => t.questions)
      return {
        running, final, error, routed, traces, attempts, jevMs, toolMs, agentMs,
        total: (running ? Date.now() : last?.at ?? first) - first,
        questions: q.length, used: q.filter((x) => x.used).length,
        tokIn: traces.reduce((t, x) => t + (x.usage?.input_tokens ?? 0), 0),
        tokOut: traces.reduce((t, x) => t + (x.usage?.output_tokens ?? 0), 0),
      }
    }

    // ---------- inspector: views ----------
    function Stats({ s }) {
      const tile = (label, value, sub) => h('div', { className: 'stat' }, h('small', null, label), h('b', null, value), sub ? h('small', null, sub) : null)
      return h('div', { className: 'stats' },
        tile('Jev', ms(s.jevMs)),
        s.toolMs ? tile('Tool', ms(s.toolMs)) : tile('Agents', ms(s.agentMs)),
        tile('Total', ms(s.total), s.running ? 'running…' : null),
        tile('Questions', `${s.used}/${s.questions}`, `${s.tokIn} in / ${s.tokOut} out tok`))
    }

    const STATUS = {
      accepted: ['ok', 'Accepted'],
      accepted_pending_human_review: ['warn', 'Accepted, human review recommended'],
      needs_human: ['warn', 'Needs human'],
      limit_reached: ['bad', 'Stopped: limit reached'],
    }

    function WhatHappened({ s }) {
      const R = s.routed?.routing
      if (!R) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'What the code did'), h('div', { className: 'muted' }, s.error ? s.error.message : 'Routing…'))
      const kind = s.routed.tool ? 'tool' : R.mode === 'jev' ? 'agent' : R.mode
      const badge = { tool: 'tool', agent: 'agent', manual: 'manual', fallback: 'fallback' }[kind]
      const line = s.routed.tool
        ? `Jev picked tool ${s.routed.tool} (fits ${pct(R.toolFits)}, args ${pct(R.toolArgConfidence)}); no LLM needed`
        : R.mode === 'jev' ? `Jev picked ${R.primaryAgent} (confidence ${pct(R.agentConfidence)})`
          : R.mode === 'manual' ? `You forced ${R.primaryAgent}` : `Jev unavailable (${R.reason}); default agent ${R.primaryAgent}`
      const rows = []
      if (R.mode === 'jev') {
        rows.push(['Task type', `${R.taskType} (${pct(R.taskTypeConfidence)})`], ['Complexity', pct(R.complexity)], ['Risk', pct(R.risk)],
          ['Second opinion', pct(R.needsSecondOpinion)], ['Human review', pct(R.needsHumanReview)], ['Needs tests', pct(R.needsTests)])
      }
      if (s.routed.tool) for (const [k, v] of Object.entries(R.toolArgs ?? {})) rows.push([`arg ${k}`, v])
      const st = s.final && (STATUS[s.final.status] ?? ['', s.final.status])
      return h('div', { className: 'card' },
        h('div', { className: 'label' }, 'What the code did'),
        h('div', null, h('span', { className: cx('badge', badge) }, badge), line),
        rows.length ? h('dl', null, ...rows.flatMap(([k, v]) => [h('dt', { key: `t${k}` }, k), h('dd', { key: `d${k}` }, v)])) : null,
        s.attempts.length ? h('div', { style: { marginTop: 12 } }, h('div', { className: 'label' }, 'Steps'),
          h('ol', { className: 'steps' }, ...s.attempts.map((a) => h('li', { key: a.index },
            h('div', null, h('b', null, a.agent), h('span', { className: 'pill' }, a.role),
              a.end ? h('span', { className: cx('pill', a.end.stopReason === 'completed' ? 'ok' : 'bad') }, `${a.end.stopReason} · ${ms(a.end.durationMs)}`) : h('span', { className: 'pill warn' }, 'running…')),
            a.end?.checks?.length ? h('div', { className: 'why' }, 'Checks: ', a.end.checks.map((c) => `${c.name} ${c.passed ? 'pass' : 'FAIL'}`).join(', ')) : null,
            a.end?.changedFiles?.length ? h('div', { className: 'why' }, 'Changed: ', a.end.changedFiles.join(', ')) : null,
            a.review ? h('div', { className: 'why' }, 'Review → ', h('b', null, a.review.action), `: ${a.review.why}`) : null)))) : null,
        st ? h('div', { style: { marginTop: 10 } }, 'Final: ', h('span', { className: cx('pill', st[0]) }, st[1]), s.final.statusReason ? h('span', { className: 'why' }, ` ${s.final.statusReason}`) : null) : null,
        s.error ? h('div', { className: 'err' }, s.error.message) : null)
    }

    function Question({ q }) {
      const probs = q.probabilities ?? {}
      const opts = q.type === 'noul'
        ? [['yes', 'Probability the answer is yes', q.answer]]
        : Object.keys(probs).map((k) => [k, q.options?.[k] ?? '', probs[k]]).sort((a, b) => b[2] - a[2])
      const answer = q.type === 'choice' ? q.answer : q.type === 'score' ? `${Number(q.answer).toFixed(2)} of ${Object.keys(probs).length - 1}` : pct(q.answer)
      return h('details', { className: cx('q', !q.used && 'unused') },
        h('summary', null,
          h('div', null, h('span', { className: 'pill' }, q.type), h('code', { style: { marginLeft: 6 } }, q.name), q.used ? h('span', { className: 'pill ok' }, 'used') : null),
          h('div', { className: 'ans' }, '→ ', answer, q.type === 'choice' && q.options?.[q.answer] ? h('span', { className: 'muted', style: { fontWeight: 400 } }, ` ${q.options[q.answer]}`) : null)),
        h('div', { className: 'muted', style: { margin: '6px 0' } }, q.question),
        ...opts.map(([k, desc, p]) => h('div', { className: 'opt', key: k },
          h('div', { className: 'row' }, h('span', { title: desc }, h('code', null, k), desc ? ` ${desc}` : ''), h('span', null, pct(p))),
          h('div', { className: 'bar' }, h('i', { style: { width: `${Math.max(0, Math.min(1, p)) * 100}%` } })))),
        typeof q.confidence === 'number' ? h('div', { className: 'why', style: { marginTop: 6 } }, `confidence ${q.confidence.toFixed(3)}`) : null)
    }

    function Questions({ traces }) {
      const [onlyUsed, setOnlyUsed] = useState(false)
      if (!traces.length) return null
      return h('div', null, ...traces.map((t, i) => {
        const qs = t.questions.filter((q) => !onlyUsed || q.used)
        return h('div', { className: 'card', key: i },
          h('div', { className: 'head' },
            h('div', { className: 'label', style: { margin: 0 } }, `${t.phase === 'route' ? 'Routing' : 'Review'}: ${t.questions.length} questions in one request · ${ms(t.ms)}`),
            i === 0 ? h('label', { className: 'toggle' }, h('input', { type: 'checkbox', checked: onlyUsed, onChange: (e) => setOnlyUsed(e.target.checked) }), 'Only used') : null),
          h('div', { className: 'why', style: { margin: '4px 0 8px' } }, `${t.model} · ${t.usage?.input_tokens ?? 0} in / ${t.usage?.output_tokens ?? 0} out tokens. Greyed-out answers were not needed for this run.`),
          ...qs.map((q) => h(Question, { key: q.name, q })))
      }))
    }

    function Decisions({ runs }) {
      const [pick, setPick] = useState(null)
      if (!runs.length) return h('div', { className: 'empty' }, 'No routed tasks in this session yet. Pick "Jev Auto" in the model menu, or use /auto, then send a task.')
      const run = runs.find((r) => r.id === pick) ?? runs.at(-1)
      const s = summarize(run)
      return h('div', null,
        runs.length > 1 ? h('select', { value: run.id, onChange: (e) => setPick(e.target.value), 'aria-label': 'Run', style: { width: '100%' } },
          ...runs.slice().reverse().map((r) => h('option', { key: r.id, value: r.id }, `${new Date(r.startedAt).toLocaleTimeString()} · ${r.task.slice(0, 60)}`))) : null,
        h('div', { className: 'why', style: { marginTop: 6 } }, `Task: ${run.task}`),
        h(Stats, { s }),
        h(WhatHappened, { s }),
        h(Questions, { traces: s.traces }))
    }

    function Subagents({ sessionId, entries }) {
      useEffect(() => {
        sessionsApi?.setSubagentCatalogOpen?.(sessionId, true)
        const t = setInterval(() => sessionsApi?.refreshSubagents?.(sessionId), 3000)
        return () => { clearInterval(t); sessionsApi?.setSubagentCatalogOpen?.(sessionId, false) }
      }, [sessionId])
      const kids = entries.filter((e) => e.kind === 'child')
      if (!kids.length) return h('div', { className: 'empty' }, 'No subagents in this session yet.')
      const open = (e) => sessionsApi?.openSubagent?.({ parentSessionId: sessionId, childSessionId: e.id, mode: e.mode, ...(e.label ? { label: e.label } : {}) })
      return h('ul', { className: 'plain' }, ...kids.slice().reverse().map((e) => h('li', { key: e.id },
        h('span', null, h('span', { className: cx('dot', e.activity === 'running' && 'on') }), e.label ?? e.id, h('span', { className: 'pill' }, e.mode)),
        h('a', { className: 'link', role: 'button', tabIndex: 0, onClick: () => open(e), onKeyDown: (k) => { if (k.key === 'Enter') open(e) } }, 'Open'))))
    }

    function Jobs({ jobs }) {
      if (!jobs.length) return h('div', { className: 'empty' }, 'No background work in this session.')
      return h('ul', { className: 'plain' }, ...jobs.map((j) => h('li', { key: j.id },
        h('span', null, h('span', { className: cx('dot', (j.status === 'running' || j.status === 'stopping') && 'on') }), j.label ?? j.kind, h('span', { className: 'pill' }, j.kind)),
        h('span', { className: 'why' }, j.status, j.startedAt ? ` · ${ms((j.finishedAt ?? Date.now()) - j.startedAt)}` : ''))))
    }

    const EMPTY = []
    function InspectorBody({ useTabInfo, sessionId, useSessions }) {
      useStyle()
      const info = useTabInfo?.()
      const visible = info?.tab?.visible ?? true
      const [view, setView] = useState('decisions')
      const runs = useRuns(sessionId, visible)
      const entries = useSessions?.((s) => s.subagentsByParent?.[sessionId]?.entries) ?? EMPTY
      const jobs = useSessions?.((s) => s.jobsBySession?.[sessionId]) ?? EMPTY
      const liveKids = entries.filter((e) => e.kind === 'child' && e.activity === 'running').length
      const liveJobs = jobs.filter((j) => j.status === 'running' || j.status === 'stopping').length
      const tab = (id, label, n) => h('button', { role: 'tab', 'aria-selected': view === id, onClick: () => setView(id) }, label, n ? h('span', { className: 'n' }, n) : null)
      return h('div', { className: 'jevi' },
        h('h3', null, 'Jev inspector'),
        h('div', { className: 'tabs', role: 'tablist' }, tab('decisions', 'Decisions', runs.length), tab('subagents', 'Subagents', liveKids), tab('jobs', 'Background', liveJobs)),
        view === 'decisions' ? h(Decisions, { runs }) : view === 'subagents' ? h(Subagents, { sessionId, entries }) : h(Jobs, { jobs }))
    }

    // ---------- settings: Jev setup ----------
    function SetupSection() {
      useStyle()
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [removing, setRemoving] = useState(null)
      const [form, setForm] = useState({ id: '', provider: '', model: '', description: '' })
      const load = useCallback(async (recheck) => {
        setBusy(true); setError('')
        try { setData(await api(`/jev-router/setup${recheck ? '?recheck=1' : ''}`)) } catch (e) { setError(e.message) } finally { setBusy(false) }
      }, [])
      useEffect(() => { load(false) }, [load])
      const act = async (fn) => { setError(''); setBusy(true); try { await fn(); await load(false) } catch (e) { setError(e.message); setBusy(false) } }

      if (!data) return h('div', { className: 'jevi' }, h('h3', null, 'Jev setup'), error ? h('div', { className: 'err' }, error) : h('div', { className: 'muted' }, 'Checking logins…'))
      const onCount = data.agents.filter((a) => a.enabled).length
      const usable = data.agents.filter((a) => a.enabled && a.status?.loggedIn).length
      const provider = data.providers.find((p) => p.id === form.provider)

      return h('div', { className: 'jevi', style: { height: 'auto' } },
        h('h3', null, 'Jev setup'),
        h('p', { className: 'muted' }, 'Which LLM agents Jev can route to, and whether each one is signed in. At least one LLM must stay on.'),
        error ? h('div', { className: 'err', role: 'alert' }, error) : null,

        h('div', { className: 'card' },
          h('div', { className: 'label' }, 'Jev router'),
          h('div', null, h('span', { className: cx('dot', data.jev.configured ? 'on' : 'off') }),
            data.jev.configured ? `${data.jev.credentialRef} is set. Jev routes and reviews.` : `${data.jev.credentialRef} missing. Routing falls back to the default agent. See C:\\Harness\\README.md step 2.`)),

        h('div', { className: 'card' },
          h('div', { className: 'head' }, h('div', { className: 'label', style: { margin: 0 } }, `LLM agents · ${usable} ready`),
            h('button', { className: 'btn', disabled: busy, onClick: () => load(true) }, busy ? 'Checking…' : 'Recheck logins')),
          usable === 0 ? h('div', { className: 'err' }, 'No agent is both on and signed in. Sign in to one below, or add an API-key agent.') : null,
          h('ul', { className: 'plain' }, ...data.agents.map((a) => {
            const lastOn = a.enabled && onCount === 1
            return h('li', { key: a.id },
              h('div', { style: { minWidth: 0 } },
                h('div', null, h('span', { className: cx('dot', a.status?.loggedIn ? 'on' : 'off') }), h('b', null, a.id),
                  h('span', { className: 'pill' }, a.llm ? `${a.llm.provider} / ${a.llm.model}` : a.provider), a.custom ? h('span', { className: 'pill' }, 'API key') : null),
                h('div', { className: 'why' }, a.status?.detail ?? 'not checked')),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 } },
                h('label', { className: 'toggle', title: lastOn ? 'At least one LLM must stay on' : '' },
                  h('input', { type: 'checkbox', role: 'switch', checked: a.enabled, disabled: lastOn || busy, 'aria-label': `Use ${a.id}`, onChange: (e) => act(() => api('/jev-router/agents', { method: 'POST', body: JSON.stringify({ id: a.id, enabled: e.target.checked }) })) }),
                  a.enabled ? 'On' : 'Off'),
                a.custom ? h('button', { className: 'btn danger', onClick: () => setRemoving(a.id) }, 'Remove') : null))
          }))),

        h('div', { className: 'card' },
          h('div', { className: 'label' }, 'Add an API-key agent'),
          data.providers.length === 0
            ? h('div', { className: 'muted' }, 'No API-key models yet. Add a provider and key in Settings → Models first; it then shows up here.')
            : h('form', { onSubmit: (e) => { e.preventDefault(); act(async () => { await api('/jev-router/custom', { method: 'POST', body: JSON.stringify(form) }); setForm({ id: '', provider: '', model: '', description: '' }) }) } },
              h('dl', null,
                h('dt', null, h('label', { htmlFor: 'jevi-p' }, 'Provider')),
                h('dd', null, h('select', { id: 'jevi-p', value: form.provider, required: true, onChange: (e) => setForm({ ...form, provider: e.target.value, model: '' }) },
                  h('option', { value: '' }, 'Choose…'), ...data.providers.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
                h('dt', null, h('label', { htmlFor: 'jevi-m' }, 'Model')),
                h('dd', null, h('select', { id: 'jevi-m', value: form.model, required: true, disabled: !provider, onChange: (e) => setForm({ ...form, model: e.target.value }) },
                  h('option', { value: '' }, 'Choose…'), ...(provider?.models ?? []).map((m) => h('option', { key: m.id, value: m.id }, m.name)))),
                h('dt', null, h('label', { htmlFor: 'jevi-i' }, 'Name')),
                h('dd', null, h('input', { id: 'jevi-i', type: 'text', required: true, pattern: '[a-z][a-z0-9_-]{0,31}', placeholder: 'e.g. kimi', value: form.id, onChange: (e) => setForm({ ...form, id: e.target.value.toLowerCase() }) })),
                h('dt', null, h('label', { htmlFor: 'jevi-d' }, 'Good at')),
                h('dd', null, h('input', { id: 'jevi-d', type: 'text', required: true, placeholder: 'What Jev should send it, e.g. quick fixes and tests', value: form.description, onChange: (e) => setForm({ ...form, description: e.target.value }), style: { width: '100%' } }))),
              h('div', { style: { marginTop: 10 } }, h('button', { className: 'btn primary', type: 'submit' }, 'Add agent')))),

        h('div', { className: 'card' },
          h('div', { className: 'label' }, 'Tools (no LLM)'),
          data.tools.length
            ? h('ul', { className: 'plain' }, ...data.tools.map((t) => h('li', { key: t.id }, h('div', null, h('b', null, t.id), h('div', { className: 'why' }, t.description)), h('code', { className: 'why' }, t.command))))
            : h('div', { className: 'muted' }, 'None yet. Add scripts under `tools` in the jev-router entry of ~/.dsh/profiles/web/cordis.patch.yml; Jev runs one when it fully covers a task.')),

        removing ? h(Confirm, {
          title: `Remove agent "${removing}"?`,
          body: `Jev will stop routing tasks to ${removing}. The provider and API key in Settings → Models are not touched.`,
          confirmLabel: 'Remove agent',
          onCancel: () => setRemoving(null),
          onConfirm: () => { const id = removing; setRemoving(null); act(() => api(`/jev-router/custom?id=${encodeURIComponent(id)}`, { method: 'DELETE' })) },
        }) : null)
    }

    // ---------- brand: Kz Harness logo in the sidebar and above the new-session headline ----------
    const LOGO = '/jev-router/logo.png'
    const BrandMark = ({ size = 24 }) => h('img', { src: LOGO, width: size, height: size, alt: '', style: { display: 'block', borderRadius: 6 } })
    const BrandName = () => h('span', { style: { font: 'var(--dsw-font-s-strong-14)', color: 'var(--dsw-alias-label-primary)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' } }, 'Kz Harness')
    const HeroMark = ({ size = 40, className }) => h('img', { src: LOGO, width: size, height: size, alt: 'Kz Harness', className, style: { display: 'block' } })

    return {
      inject: ['slots', 'sidebarRightTabs', 'sessions'],
      apply(ctx) {
        sessionsApi = ctx.sessions
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          priority: 'extension',
          title: () => 'Jev',
          guide: [{ order: 50, title: () => 'Jev inspector', description: () => 'Routing decisions, subagents, background work' }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, InspectorBody))
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'jev-setup', order: 15, label: () => 'Jev setup' }, SetupSection))
        ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark))
        ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName))
        ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroMark))
      },
    }
  },
})
