// Browser half of jev-router, loaded by DSH as a classic script (no build
// step, so plain React.createElement). Two surfaces:
//   - "Jev" tab in the right sidebar: router decisions per run, Jev's questions
//     and probabilities, subagents and background jobs of the session, and
//     usage/limits per agent. Agent on/off chips sit above the tabs.
//   - "Jev setup" page in Settings: agent logins, on/off switches (at least one
//     LLM stays on), accounts (log in/out, API keys), user-added API-key agents, tools.
//   - Brand: the Kz-harness logo replaces the DeepSeek mark (sidebar, hero).
//   - Session header: Terminal, Background tasks, Browser, Jev inspector buttons
//     and a "more" menu; one window keydown listener runs the same actions by hotkey.
//   - "Browser" right-sidebar tab: a real browser view in the Kz-harness app
//     (window.harness.browser), an iframe elsewhere.
//   - "Shortcuts" page in Settings: edit hotkeys, right sidebar width.
// Data comes from the server half's /jev-router/* routes.
window.__ModuleLoader__.load({
  id: 'jev-router',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const TAB_ID = 'jev-router/inspector'
    const KIND = 'jev-inspector'
    const BROWSER_ID = 'jev-router/browser'
    const BROWSER_KIND = 'kz-browser'
    const TERMINAL_ID = 'jev-router/terminal'
    const TERMINAL_KIND = 'kz-terminal'
    // Subagents, background tasks and usage also stand on their own, so they are
    // reachable in any session without going through the Jev inspector's tabs.
    const SUBAGENTS_ID = 'jev-router/subagents'
    const SUBAGENTS_KIND = 'kz-subagents'
    const TASKS_ID = 'jev-router/tasks'
    const TASKS_KIND = 'kz-tasks'
    const USAGE_ID = 'jev-router/usage'
    const USAGE_KIND = 'kz-usage'
    // The whole session as one chronological ledger: messages, routed runs, tasks, subagents.
    const OVERVIEW_ID = 'jev-router/overview'
    const OVERVIEW_KIND = 'kz-overview'
    // What each agent is doing as it does it (docs/live-agent-view.md Feature 1), by task or run.
    const LIVE_ID = 'jev-router/live'
    const LIVE_KIND = 'jev-live'
    // Services captured in apply (ctx.sessions, ctx.sidebarRight, ctx.layout, ctx.uiWorkspace).
    let sessionsApi
    let sidebarRight
    let layout
    let uiWorkspace
    // The Remote namespace the shipped Files tab uses (`ctx.remote.workspaceFiles`). Optional: when
    // absent the left sidebar file tree stays off rather than taking the whole plugin down.
    let workspaceFiles

    // ---------- helpers ----------
    // A refusal carries the route's status, so a caller can tell "nothing here" (404) from a failure.
    const api = async (path, init) => {
      const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status })
      return body
    }
    // A duration as a person reads one: 450 ms, 41.0 s, 2 min 30 s, 1 h 5 min.
    const ms = (n) => {
      if (n == null) return '-'
      if (n < 1000) return `${Math.round(n)} ms`
      // Rounded first, so 59.96 s is not shown as '60.0 s' beside a minute shown as '1 min'.
      const tenths = Math.round(n / 100)
      if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`
      const sec = Math.round(n / 1000)
      if (sec < 3600) return `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ''}`
      const min = Math.round(sec / 60)
      return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
    }
    const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-')
    const cx = (...c) => c.filter(Boolean).join(' ')

    // DSH design tokens only (fonts, labels, surfaces, borders, states), so both themes follow the app.
    const CSS = `
.jevi{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);padding:12px 14px 24px;overflow:auto;height:100%;box-sizing:border-box}
.jevi h3{font:var(--dsw-font-s-strong-14);margin:0}
.jevi p{margin:4px 0 12px}
.jevi .muted,.jevi .why{color:var(--dsw-alias-label-tertiary)}
.jevi .why{font:var(--dsw-font-xxs-12)}
.jevi details.answer{margin:4px 0 0}
.jevi details.answer summary{cursor:pointer;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}
.jevi .answer-text{white-space:pre-wrap;word-break:break-word;margin-top:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);max-height:240px;overflow:auto}
/* Rendered Markdown brings its own block spacing; pre-wrap would double every gap. */
.jevi .answer-text.answer-md{white-space:normal;max-height:360px;color:var(--dsw-alias-label-primary)}
.jevi .answer-md > :first-child{margin-top:0}
.jevi .answer-md > :last-child{margin-bottom:0}
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
/* The resource budget table: the .limits row's type and colour, headings in the dt colour. */
.jevi table.budget{border-collapse:collapse;margin:4px 0 0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.jevi table.budget th,.jevi table.budget td{font:inherit;text-align:left;vertical-align:middle;padding:3px 12px 3px 0}
.jevi table.budget thead th{color:var(--dsw-alias-label-tertiary)}
.jevi table.budget td{font-variant-numeric:tabular-nums}
/* Jev and Laya side by side: the budget table's type, wide enough to scroll inside its card. */
.jevi table.cmp{display:block;overflow-x:auto;border-collapse:collapse;margin:4px 0 8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.jevi table.cmp th,.jevi table.cmp td{font:inherit;text-align:left;vertical-align:top;padding:3px 10px 3px 0}
.jevi table.cmp thead th{color:var(--dsw-alias-label-tertiary)}
.jevi table.cmp td{font-variant-numeric:tabular-nums}
.jevi .why.shadow{margin-top:2px}
/* Sortable tables: the header is a button that sorts, and a filter field sits under each one. */
.jevi table.sortable{max-height:60vh;overflow:auto}
.jevi table.sortable td .clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-width:200px}
.jevi table.sortable th button.sorter{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;text-align:left}
.jevi table.sortable th input.filter{width:100%;min-width:56px;box-sizing:border-box;font:inherit;padding:2px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
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
.jevi select,.jevi input[type=text],.jevi input[type=number],.jevi input[type=password]{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;max-width:100%;box-sizing:border-box}
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
.jevi .dot.warn{background:var(--dsw-alias-state-warn-primary)}
.jevi .bar i.warn{background:var(--dsw-alias-state-warn-primary)}
.jevi .bar i.bad{background:var(--dsw-alias-state-error-primary)}
.jevi .chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.jevi button.chip{display:inline-flex;align-items:center;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:3px 10px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.jevi button.chip:hover{background:var(--dsw-alias-interactive-bg-hover-accent)}
.jevi button.chip.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}
.jevi button.chip[aria-disabled=true]{cursor:not-allowed}
.jevi button.chip:disabled{opacity:.45;cursor:wait}
.jevi .limits{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin-top:10px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.jevi .limits label{display:flex;align-items:center;gap:6px}
.jevi .limits input{width:72px}
.jevi .saved{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-success-primary)}
.jevi .saved.bad{color:var(--dsw-alias-state-error-primary)}
.jevi form.addkey{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.jevi form.addkey input{flex:1 1 120px}
.jevi .keys{margin-top:12px}
.jevi .seg{display:inline-flex;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px;gap:2px}
.jevi .seg button{background:none;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.jevi .seg button:hover{color:var(--dsw-alias-label-primary)}
.jevi .seg button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12)}
.jevi .stats.save{grid-template-columns:repeat(2,1fr);margin:8px 0}
.jevi .stats.save b{font:var(--dsw-font-m-strong-16,var(--dsw-font-s-strong-14));font-variant-numeric:tabular-nums}
.jevi .stats.save b.neg{color:var(--dsw-alias-state-error-primary)}
.jevi .note{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;margin:6px 0}
.jevi-modal{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;z-index:10000;height:auto;padding:0}
.jevi-modal .box{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px;max-width:380px;width:calc(100% - 32px);box-shadow:0 10px 40px var(--dsw-alias-bg-mask-3)}
.jevi-modal .box.wide{max-width:640px;max-height:calc(100vh - 48px);overflow:auto}
.jevi-modal .box.confirm{display:flex;flex-direction:column;max-height:calc(100vh - 48px);box-sizing:border-box}
.jevi-modal .box.confirm .body{overflow:auto;min-height:0}
.jevi-modal .box.confirm h3,.jevi-modal .box.confirm .actions{flex:none}
.jevi-modal .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.jevi kbd{font:var(--dsw-font-xxxs-11);font-family:var(--ds-font-family-code);padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.jevi kbd.none{font-family:inherit;color:var(--dsw-alias-label-caption);border-style:dashed}
.jevi kbd.capture{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}
.jevi .warnline{color:var(--dsw-alias-state-warn-label);font:var(--dsw-font-xxs-12);margin-top:2px}
.jevi .task{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.jevi .task:last-child{border-bottom:0}
.jevi .task .top{display:flex;align-items:flex-start;gap:8px}
.jevi .task details{flex:1;min-width:0}
.jevi .task summary{cursor:pointer;list-style:none;display:flex;align-items:flex-start;gap:6px}
.jevi .task summary::-webkit-details-marker{display:none}
.jevi .task summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:6px}
.jevi .task .title{font:var(--dsw-font-xs-strong-13);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jevi .st{display:inline-block;flex:none;width:14px;height:14px;margin-top:2px;box-sizing:border-box;text-align:center;font:var(--dsw-font-xxxs-11);line-height:14px}
.jevi .st.running{border:2px solid var(--dsw-alias-bg-layer-3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:kzh-spin .8s linear infinite}
.jevi .st.done{color:var(--dsw-alias-state-success-primary)}
.jevi .st.failed{color:var(--dsw-alias-state-error-primary)}
.jevi .st.stopped{color:var(--dsw-alias-label-caption)}
.jevi .st.queued{color:var(--dsw-alias-label-tertiary)}
/* The canonical task states. The ring says "working" for all four in-flight states, and the
   label text beside it names the state, so a row is never read by colour alone. */
.jevi .st.routing,.jevi .st.verifying,.jevi .st.reviewing{border:2px solid var(--dsw-alias-bg-layer-3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:kzh-spin .8s linear infinite}
.jevi .st.completed{color:var(--dsw-alias-state-success-primary)}
.jevi .st.needs_human,.jevi .st.paused_limit{color:var(--dsw-alias-state-warn-label)}
.jevi .task .title.struck{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}
.jevi .task .unread{display:inline-block;margin-left:6px;padding:0 6px;border-radius:6px;font:var(--dsw-font-xxxs-11);line-height:16px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.jevi .task .reason{margin-top:2px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.jevi .task .reason.failed{color:var(--dsw-alias-state-error-primary)}
.jevi .task .reason.needs_human,.jevi .task .reason.paused_limit{color:var(--dsw-alias-state-warn-label)}
/* The state's name is always spelled out; these tints only help it stand out at a glance. */
.jevi .pill.state.completed{color:var(--dsw-alias-state-success-primary)}
.jevi .pill.state.failed{color:var(--dsw-alias-state-error-primary)}
.jevi .pill.state.stopped{color:var(--dsw-alias-label-caption)}
.jevi .pill.state.needs_human,.jevi .pill.state.paused_limit{color:var(--dsw-alias-state-warn-label)}
/* Composer seat. Metrics copied from DSH's own trigger next to it (28px tall,
   pill radius, 13/20 text) so this lines up with the model button and the ring. */
.kzh-lim{display:inline-flex;align-items:center;position:relative;flex:none}
.kzh-lim>button{display:inline-flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 8px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px;cursor:pointer;outline:none;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.kzh-lim>button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-lim .who{max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kzh-lim .tick{flex:none;width:22px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.kzh-lim .tick i{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}
.kzh-lim .tick i.warn{background:var(--dsw-alias-state-warn-primary)}
.kzh-lim .tick i.bad{background:var(--dsw-alias-state-error-primary)}
.kzh-pop{position:absolute;right:0;bottom:calc(100% + 8px);z-index:10000;width:320px;height:auto;max-width:calc(100vw - 32px);max-height:60vh;overflow-y:auto;overflow-x:hidden;padding:12px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 28px var(--dsw-alias-bg-mask-3);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);text-align:left}
.kzh-pop .err{color:var(--dsw-alias-state-error-primary);margin:0 0 8px}
.kzh-pop .lead{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);margin:0 0 10px}
.kzh-pop .grp{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);margin:10px 0 4px}
.kzh-pop .grp:first-of-type{margin-top:0}
.kzh-pop .row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.kzh-pop .row b{font:var(--dsw-font-xs-strong-13)}
.kzh-pop .row span{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);white-space:nowrap}
.kzh-pop .bar{width:100%;box-sizing:border-box;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin:3px 0 8px}
.kzh-pop .bar i{display:block;max-width:100%;height:100%;background:var(--dsw-alias-state-business-primary)}
.kzh-pop .bar i.warn{background:var(--dsw-alias-state-warn-primary)}
.kzh-pop .bar i.bad{background:var(--dsw-alias-state-error-primary)}
.kzh-pop .more{display:block;width:100%;margin-top:8px;padding:10px 0 0;border:none;border-top:1px solid var(--dsw-alias-border-l1);background:none;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);text-align:left;cursor:pointer}
.kzh-pop .more:hover{color:var(--dsw-alias-label-primary)}
.kzh-q{position:fixed;left:50%;transform:translateX(-50%);bottom:112px;z-index:9999;width:min(560px,calc(100vw - 48px));pointer-events:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 10px 40px var(--dsw-alias-bg-mask-3);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);box-sizing:border-box;overflow:hidden}
.kzh-q .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.kzh-q .hd b{font:var(--dsw-font-xs-strong-13);flex:1;min-width:0}
.kzh-q .hd .n{font:var(--dsw-font-xxxs-11);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:1px 6px}
.kzh-q .hd button{border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:8px;padding:4px 8px;font:var(--dsw-font-xs-13)}
.kzh-q .hd button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-q ol{list-style:none;margin:0;padding:0;max-height:38vh;overflow-y:auto;overflow-x:hidden}
.kzh-q li{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.kzh-q li .no{flex:none;width:18px;text-align:right;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:20px}
.kzh-q li .tx{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.kzh-q li.now .tx{color:var(--dsw-alias-label-primary)}
.kzh-q li .tag{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.kzh-q li button{flex:none;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:6px;padding:2px 6px;font:var(--dsw-font-xxs-12)}
.kzh-q li button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-q li textarea{flex:1;min-width:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;resize:vertical;box-sizing:border-box}
.kzh-q .add{display:flex;gap:8px;align-items:flex-end;padding:10px 12px}
.kzh-q .add textarea{flex:1;min-width:0;min-height:38px;max-height:120px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;resize:vertical;box-sizing:border-box}
.kzh-q .add button{flex:none;border:0;border-radius:8px;padding:8px 12px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-strong-13);cursor:pointer}
.kzh-q .add button:disabled{opacity:.5;cursor:default}
.kzh-q .empty{padding:14px 12px;color:var(--dsw-alias-label-tertiary)}
.kzh-q .err{color:var(--dsw-alias-state-error-primary);padding:0 12px 8px}
@keyframes kzh-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.jevi .st.running,.jevi .st.routing,.jevi .st.verifying,.jevi .st.reviewing{animation:none}}
.kzh-bar{display:flex;align-items:center;gap:2px}.kzh-float{position:fixed;top:10px;z-index:30;pointer-events:auto;display:flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-base);transition:right var(--ds-transition-duration-slow) var(--ds-ease-in-out)}.kzh-titlebar{position:fixed;top:0;left:0;right:0;height:36px;z-index:40;pointer-events:auto;display:flex;align-items:center;gap:2px;padding-left:8px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1);-webkit-app-region:drag;box-sizing:border-box}.kzh-titlebar button,.kzh-titlebar [role=menu]{-webkit-app-region:no-drag}.kzh-tb-drag{flex:1;align-self:stretch}.kzh-tb-menu{display:inline-flex;align-items:center;gap:8px;background:none;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}.kzh-tb-menu:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.kzh-titlebar .kzh-bar{margin:0}html.kzh-in-app{padding-top:36px;box-sizing:border-box;height:100%}html.kzh-in-app body{height:100%}.kzh-float .kzh-bar{margin:0}
.kzh-ib{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.kzh-ib:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-ib[aria-pressed=true],.kzh-ib[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.kzh-ib:disabled{opacity:.45;cursor:default}
.kzh-ib:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kzh-dot{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}
.kzh-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.kzh-menu{position:fixed;z-index:10000;min-width:250px;padding:4px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 28px var(--dsw-alias-bg-mask-3);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}
.kzh-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kzh-menu button:hover,.kzh-menu button:focus{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.kzh-menu button:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary)}
.kzh-menu .grow{flex:1}
.kzh-menu .n{font:var(--dsw-font-xxxs-11);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:0 6px}
.kzh-menu kbd{font:var(--dsw-font-xxxs-11);font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-caption)}
.kzh-menu [role=separator]{border-top:1px solid var(--dsw-alias-border-l1);margin:4px 2px}
.kzh-tip{position:fixed;z-index:10001;width:250px;box-sizing:border-box;padding:6px 8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 8px 28px var(--dsw-alias-bg-mask-3);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);pointer-events:none}
.kzh-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10001;pointer-events:auto;max-width:min(480px,calc(100% - 32px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 14px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);box-shadow:0 8px 28px var(--dsw-alias-bg-mask-3)}
.jevi.kzb{padding:0;overflow:hidden;display:flex;flex-direction:column}
.kzb-bar{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kzb-bar input[type=text]{flex:1;min-width:0;margin:0 4px}
.kzb .view{flex:1;min-height:0;position:relative}
.kzb iframe{display:block;border:0;width:100%;height:100%;background:#fff}
.kzb .note{margin:6px 8px}
.kzh-agents{display:flex;flex:1 1 0;min-width:0;align-items:center;gap:6px;overflow-x:auto;overscroll-behavior-x:contain;white-space:nowrap;scrollbar-width:none;font:var(--dsw-font-xxxs-11)}
.kzh-agents::-webkit-scrollbar{display:none}
.kzh-agents:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:10px}
.kzh-agents .chip{flex:none;border-radius:999px;padding:0 8px;line-height:18px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.kzh-agents .chip.wrote{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.kzh-agents .arrow{flex:none;color:var(--dsw-alias-label-caption)}
.kzh-agents .split{flex:none;width:1px;height:14px;background:var(--dsw-alias-border-l2)}
.kzh-wb{margin:0 0 8px;padding:8px 10px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}
/* The board's host in the conversation scroller: first child, pinned to its top so the card sits
   above the messages and stays put while they scroll under it. Empty (no tasks) hides entirely. */
.kzh-wb-host{position:sticky;top:0;z-index:6;flex:none;width:min(var(--dsh-chat-content-width,920px),100%);margin:0 auto;padding:8px 0;box-sizing:border-box;background:linear-gradient(180deg,var(--dsw-alias-bg-base) 0,var(--dsw-alias-bg-base) calc(100% - 14px),transparent 100%)}
.kzh-wb-host:empty{display:none}
.kzh-wb-host>.kzh-wb{margin:0}
.kzh-wb-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.kzh-wb-open{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.kzh-wb-open:hover .kzh-wb-count{color:var(--dsw-alias-label-primary)}
.kzh-wb-open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:6px}
.kzh-wb-spin{flex:none;width:12px;height:12px;border:2px solid var(--dsw-alias-bg-layer-3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:kzh-spin .8s linear infinite}
.kzh-wb-count{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}
.kzh-wb-stop{flex:none;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:2px 8px;font:var(--dsw-font-xxs-strong-12);cursor:pointer}
.kzh-wb-stop:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-wb-stop:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kzh-wb-list{list-style:none;margin:0;padding:0;max-height:160px;overflow-y:auto}
.kzh-wb-item{min-width:0}
.kzh-wb-row{display:flex;align-items:center;gap:8px;padding:3px 0;min-width:0}
.kzh-wb-why{padding:0 0 3px 24px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kzh-wb-x{flex:none;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:0 6px;font:var(--dsw-font-xxxs-11);cursor:pointer}
.kzh-wb-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-wb-x:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.jevi-modal .box.confirm textarea.kzh-steer-box{flex:none;width:100%;min-height:72px;max-height:200px;margin-top:10px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;resize:vertical;box-sizing:border-box}
.jevi-modal .box.confirm .kzh-steer-note{flex:none;margin-top:8px;color:var(--dsw-alias-state-warn-label)}
.kzh-wb-mark{flex:none;width:16px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.kzh-wb-row.live .kzh-wb-mark{width:12px;height:12px;border:2px solid var(--dsw-alias-bg-layer-3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:kzh-spin .8s linear infinite}
.kzh-wb-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kzh-wb-title.struck{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}
.kzh-wb-state{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary)}
.kzh-wb-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.kzh-wb-time{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.kzh-wb-err{margin-top:6px;color:var(--dsw-alias-state-error-primary)}
/* Left sidebar file tree: a toggle beside the shipped Workspaces search button, and a docked
   panel under the workspace region. Dense and quiet, design tokens only, no new colours. */
.kzh-ft-toggle{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:50%;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}
.kzh-ft-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzh-ft-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kzh-ft-toggleIcon{display:inline-flex;align-items:center;justify-content:center}
.kzh-ft-host{flex:none;min-height:0;max-height:45%;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.kzh-ft{display:flex;flex-direction:column;min-height:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}
.kzh-ft-head{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px 4px;min-width:0}
.kzh-ft-title{flex:none;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11);text-transform:uppercase;letter-spacing:.04em}
.kzh-ft-root{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}
.kzh-ft-reload{flex:none;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 6px;font:var(--dsw-font-xxxs-11);cursor:pointer}
.kzh-ft-reload:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-ft-reload:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kzh-ft-body{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 6px 8px}
.kzh-ft-row{box-sizing:border-box;display:flex;align-items:center;gap:4px;width:100%;min-width:0;padding:2px 6px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kzh-ft-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzh-ft-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.kzh-ft-row.other{cursor:default;color:var(--dsw-alias-label-tertiary)}
.kzh-ft-row.other:hover{background:none}
.kzh-ft-chev{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;color:var(--dsw-alias-label-tertiary);transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.kzh-ft-chev.open{transform:rotate(90deg)}
.kzh-ft-chev.spacer{visibility:hidden}
.kzh-ft-icon{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.kzh-ft-name{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kzh-ft-note{padding:3px 6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}
.kzh-ft-note.kzh-ft-loading{color:var(--dsw-alias-label-secondary)}
/* Like/Dislike under every answer: a quiet action row, design tokens only, text says the state. */
.kzh-vd{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary)}
.kzh-vd-btn{flex:none;border:1px solid transparent;border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:18px;padding:0 8px;cursor:pointer}
.kzh-vd-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-vd-btn[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.kzh-vd-why{flex:none;border:1px solid transparent;border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:18px;padding:0 8px;cursor:pointer}
.kzh-vd-why:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-vd-reason{flex:1 1 140px;min-width:80px;font:inherit;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;box-sizing:border-box}
.kzh-vd-sug{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--dsw-alias-label-tertiary)}
.kzh-vd-suglab{white-space:nowrap}
.kzh-vd-select{font:inherit;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 4px;max-width:160px}
.kzh-vd-tags{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.kzh-vd-tag{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:18px;padding:0 8px;cursor:pointer}
.kzh-vd-tag:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-vd-tag[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.kzh-vd-btn:focus-visible,.kzh-vd-why:focus-visible,.kzh-vd-select:focus-visible,.kzh-vd-reason:focus-visible,.kzh-vd-tag:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kzh-vd-learned{flex:1 1 100%;min-width:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.kzh-vd-ask{flex:1 1 100%;display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0;color:var(--dsw-alias-label-secondary)}
/* Overview: one chronological ledger. Quiet, token only, and text always says the state. */
.kzh-ov-chips{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 10px}
.kzh-ov-chip{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);line-height:20px;padding:0 8px;cursor:pointer}
.kzh-ov-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-ov-chip[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.kzh-ov-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kzh-ov-sec{margin:0 0 10px}
.kzh-ov-hd{display:flex;align-items:baseline;gap:6px;margin:0 0 2px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kzh-ov-hd b{flex:1;min-width:0;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kzh-ov-hd .n{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.kzh-ov-hd .at{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.kzh-ov-row{display:block;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.kzh-ov-row:last-child{border-bottom:0}
.kzh-ov-row>summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:58px 52px 1fr;gap:6px;align-items:baseline}
.kzh-ov-row>summary::-webkit-details-marker{display:none}
.kzh-ov-row>summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:6px}
.kzh-ov-time{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.kzh-ov-time.untimed{color:var(--dsw-alias-state-warn-label)}
.kzh-ov-kind{font:var(--dsw-font-xxxs-11);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 4px;color:var(--dsw-alias-label-secondary);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kzh-ov-main{min-width:0}
.kzh-ov-title{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kzh-ov-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.kzh-ov-meta .who{color:var(--dsw-alias-label-secondary)}
.kzh-ov-meta .state.running,.kzh-ov-meta .state.routing,.kzh-ov-meta .state.verifying,.kzh-ov-meta .state.reviewing{color:var(--dsw-alias-state-business-primary)}
.kzh-ov-meta .state.done,.kzh-ov-meta .state.completed{color:var(--dsw-alias-state-success-primary)}
.kzh-ov-meta .state.failed{color:var(--dsw-alias-state-error-primary)}
.kzh-ov-meta .state.stopped,.kzh-ov-meta .state.queued{color:var(--dsw-alias-label-caption)}
.kzh-ov-meta .state.needs_human,.kzh-ov-meta .state.paused_limit,.kzh-ov-meta .state.warn{color:var(--dsw-alias-state-warn-label)}
.kzh-ov-detail{margin:6px 0 2px 116px}
.kzh-ov-note{margin:0 0 10px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.kzh-ov-note.warn{color:var(--dsw-alias-state-warn-label)}
/* The live view (docs/live-agent-view.md Feature 1): the work board's second line, the Live tab and the card under a start reply. */
.kzh-wb-row.go{cursor:pointer}
.kzh-wb-act{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:0 0 3px 24px;border:0;background:none;box-sizing:border-box;min-width:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer}
.kzh-wb-act:hover{color:var(--dsw-alias-label-primary)}
.kzh-wb-act:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:6px}
.kzh-wb-act .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kzh-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.kzh-dot.fresh{background:var(--dsw-alias-state-success-primary);animation:kzh-pulse 1.2s ease-in-out infinite}
@keyframes kzh-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.kzh-dot.fresh{animation:none}}
.jevi.kzh-live{display:flex;flex-direction:column}
.kzh-live-hd{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);margin:4px 0 6px;overflow-wrap:anywhere}
.kzh-live-note{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0 0 6px}
.kzh-live-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}
.jevi .kzh-live-bar button.btn[aria-pressed=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.kzh-live-tl{flex:1;min-height:0;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}
.kzh-live-sec{margin:0 0 10px}
.kzh-live-sec>h4{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-caption);margin:8px 0 4px}
.kzh-live-ms{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:2px 0;overflow-wrap:anywhere}
.kzh-live-ms.bad{color:var(--dsw-alias-state-error-primary)}
.kzh-live-row{display:flex;align-items:baseline;gap:6px;margin:2px 0;min-width:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.kzh-live-row .g{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.kzh-live-row.done .g{color:var(--dsw-alias-state-success-primary)}
.kzh-live-row.failed .g{color:var(--dsw-alias-state-error-primary)}
.kzh-live-row .t{min-width:0;overflow-wrap:anywhere}
.kzh-live-think{margin:4px 0;padding:4px 8px;border-left:2px solid var(--dsw-alias-border-l2);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.kzh-live-think-t{white-space:pre-wrap;overflow-wrap:anywhere}
/* The preview follows the stream: its newest lines stay in view and the older ones fade out above. */
.kzh-live-think.clip .kzh-live-think-t{max-height:120px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 32px);mask-image:linear-gradient(180deg,transparent 0,#000 32px)}
.kzh-live-text{margin:4px 0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kzh-live-text.answer-md> :first-child{margin-top:0}
.kzh-live-text.answer-md> :last-child{margin-bottom:0}
.kzh-live-step{margin:2px 0}
.kzh-live-step>summary{cursor:pointer;list-style:none}
.kzh-live-step>summary::-webkit-details-marker{display:none}
.kzh-live-out{margin:4px 0 4px 18px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xxs-12-font-size);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto}
.kzh-live-out .add{color:var(--dsw-alias-state-success-primary)}
.kzh-live-out .del{color:var(--dsw-alias-state-error-primary)}
.kzh-live-use{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-caption);margin:4px 0 0}
.kzh-live-end{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);margin:8px 0 0}
.jevi button.linkish,.kzh-lrc button.linkish{background:none;border:0;padding:0;margin:2px 0;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-state-business-primary);cursor:pointer}
.kzh-live-tail{margin:2px 0}
/* The person's words to a task at work (Steer): a bubble in its timeline, a line in its row and card, the box under the Live tab. */
.kzh-live-you{margin:4px 0 4px 24px;padding:4px 8px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kzh-live-you .why,.kzh-guidance .why{display:block;color:var(--dsw-alias-label-tertiary)}
.kzh-live-you .acts,.kzh-guidance .acts{display:flex;gap:10px}
.kzh-guidance{margin:4px 0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.kzh-lrc .kzh-guidance{margin-left:28px}
.kzh-guidance-row{margin:2px 0;overflow-wrap:anywhere}
.kzh-live-steer{margin-top:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}
.kzh-live-steer textarea{width:100%;min-height:40px;max-height:160px;box-sizing:border-box;resize:vertical;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px}
.kzh-live-steer .kzh-steer-note{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin-top:4px}
/* The card under a start reply sits in the reply's actions row: on a line of its own, below the icons. */
[data-turn-tail] :has(> .kzh-lrc){flex-wrap:wrap}
.kzh-lrc{flex:1 0 100%;order:99;box-sizing:border-box;min-width:0;margin:6px 0 2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}
.kzh-lrc-hd{display:flex;align-items:center;gap:8px;min-width:0}
.kzh-lrc-av{flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-3);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary)}
.kzh-lrc-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-strong-12)}
.kzh-lrc-who,.kzh-lrc-now{margin:2px 0 0 28px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.kzh-lrc-now{color:var(--dsw-alias-label-secondary)}
.kzh-lrc-rows{list-style:none;margin:4px 0 0 28px;padding:0}
.kzh-lrc-acts{display:flex;gap:6px;margin:6px 0 0 28px}
.kzh-lrc-acts button{border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:2px 8px;font:var(--dsw-font-xxs-strong-12);cursor:pointer}
.kzh-lrc-acts button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-lrc-acts button.danger{color:var(--dsw-alias-state-error-primary)}
.kzh-lrc-acts button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
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

    /**
     * Confirmation overlay: names what goes, clear cancel. However long its body, the title and the
     * buttons stay in view and the body scrolls between them, so a box taller than the window never
     * loses its top above the edge, where a centred overlay cannot scroll to.
     */
    function Confirm({ title, body, confirmLabel, onCancel, onConfirm }) {
      useEffect(() => {
        const k = (e) => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', k)
        return () => window.removeEventListener('keydown', k)
      }, [onCancel])
      // Focus goes back where it was when the dialog opened (the row's own button), so a keyboard
      // user is not left at the top of the page each time a dialog closes.
      useEffect(() => { const back = typeof document === 'undefined' ? null : document.activeElement; return () => { try { back?.focus?.() } catch {} } }, [])
      return h('div', { className: 'jevi jevi-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'jevi-confirm-t', 'aria-describedby': 'jevi-confirm-b', onClick: onCancel },
        h('div', { className: 'box confirm', onClick: (e) => e.stopPropagation() },
          h('h3', { id: 'jevi-confirm-t' }, title),
          // A body of several paragraphs, as the capability benchmark's confirmation is, is one per line.
          h('div', { className: 'body', id: 'jevi-confirm-b' }, ...(Array.isArray(body) ? body.map((t, i) => h('p', { key: i }, t)) : [h('p', null, body)])),
          h('div', { className: 'actions' },
            h('button', { className: 'btn', onClick: onCancel, autoFocus: true }, 'Cancel'),
            h('button', { className: 'btn danger', onClick: onConfirm }, confirmLabel))))
    }

    /** Tiny shared store: components re-render on set(). */
    function makeStore(value) {
      const subs = new Set()
      return {
        get: () => value,
        set: (patch) => { value = { ...value, ...patch }; for (const f of subs) f() },
        /** Run `f` on every set, off React: for DOM side effects that are not a render. */
        sub: (f) => { subs.add(f); return () => { subs.delete(f) } },
        use() {
          const [, force] = useState(0)
          useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f) } }, [])
          return value
        },
      }
    }
    const toasts = makeStore({ text: '', n: 0 })
    const toast = (text) => toasts.set({ text, n: toasts.get().n + 1 })

    // ---------- all transcripts: one bar button opens or shuts every reasoning and tool block ----------
    // The engine renders a disclosure body only while its row is open, so CSS or an attribute change
    // cannot open one: the row's own click has to run React's local state. Rows also stream in shut,
    // so a follow-up pass opens the new ones while the preference is on.
    const TRANSCRIPT_ROW = '[data-disclosure-row][role="button"]' // reasoning rows and tool-call rows alike
    // A turn's process group can fold its rows away (they become hidden="until-found") while shut.
    const TRANSCRIPT_OPENER = 'button[data-turn-process]'
    // The conversation's own scroller, so rows in other panes (sidebars, settings) are never touched.
    const transcriptScope = () => document.querySelector('[data-conversation-scroll]')

    /**
     * The button's open state, label and whether it does anything at all. `total` is every transcript
     * row in the conversation and `collapsed` how many of them are shut. Pure: numbers in, no DOM.
     */
    function transcriptButton(collapsed, total) {
      const expanded = total > 0 && collapsed === 0
      return { expanded, disabled: total === 0, label: expanded ? 'Collapse all transcripts' : 'Expand all transcripts' }
    }

    /**
     * The rows a pass must click, given `[{ expanded, seen }]` copies of the DOM rows and the
     * preference. `follow` marks the pass that chases streamed-in rows: it only ever opens, and it
     * skips every row it has already decided about, so a row the person shut by hand is not fought
     * over. A click on the button passes no `follow` and overrides that guard. Pure, so it unit-tests.
     */
    function transcriptClicks(rows, open, follow = false) {
      if (follow) return open ? rows.filter((r) => !r.expanded && !r.seen) : []
      return rows.filter((r) => r.expanded !== open)
    }

    /** Kept for this application session only: it deliberately resets when the page reloads. */
    const transcripts = makeStore({ open: false, button: transcriptButton(0, 0) })
    const transcriptSeen = new WeakSet() // rows and group openers a pass has already decided about
    let transcriptKey = ''
    // One pass per burst, on a timer rather than an animation frame: a hidden or minimised window runs
    // no frames at all, so a frame-gated pass would never land (see coalesce).
    const transcriptPass = coalesce(passTranscripts)

    const transcriptRows = (root) => [...root.querySelectorAll(TRANSCRIPT_ROW)].map((row) => ({
      row, expanded: row.getAttribute('aria-expanded') === 'true', seen: transcriptSeen.has(row),
    }))

    /** Recount the conversation's rows; only a changed button state re-renders the bars. */
    function countTranscripts() {
      const root = transcriptScope()
      const rows = root ? transcriptRows(root) : []
      const st = transcriptButton(rows.filter((r) => !r.expanded).length, rows.length)
      const key = `${st.label}|${st.expanded}|${st.disabled}`
      if (key === transcriptKey) return
      transcriptKey = key
      transcripts.set({ button: st })
    }

    /**
     * Unfold the process groups that hide their rows, so "all" means visible and not merely open.
     * `newOnly` is the following pass: it takes the groups it has not decided about yet, and the
     * person folding one back by hand stays folded.
     */
    function openGroups(root, newOnly) {
      const all = [...root.querySelectorAll(TRANSCRIPT_OPENER)]
      for (const g of all) {
        if (g.getAttribute('aria-expanded') === 'true' || (newOnly && transcriptSeen.has(g))) continue
        transcriptSeen.add(g)
        clickRow(g)
      }
      for (const g of all) transcriptSeen.add(g)
    }

    /** Click a row without taking the keyboard focus out of a half-typed message. */
    function clickRow(el) {
      const keep = document.activeElement
      try { el.click() } catch {}
      if (keep && keep !== document.body && keep !== document.activeElement && keep.isConnected) {
        try { keep.focus({ preventScroll: true }) } catch {}
      }
    }

    /** Toggle every transcript: the bar button, the "More" menu item and the hotkey all run this. */
    function toggleTranscripts() {
      const root = transcriptScope()
      if (!root) return
      const open = !transcripts.get().open
      transcripts.set({ open })
      if (open) openGroups(root, false)
      const rows = transcriptRows(root)
      const hits = transcriptClicks(rows, open)
      // Marked before the click, so a row whose click fails is not retried pass after pass.
      for (const r of hits) transcriptSeen.add(r.row)
      for (const r of hits) clickRow(r.row)
      for (const r of rows) transcriptSeen.add(r.row)
      countTranscripts()
      // Opening reveals bodies that hold more shut rows (a tool's own steps); let a pass take those.
      scheduleTranscripts()
    }

    /** One pass: open what the preference wants among the rows nobody has decided about yet. */
    function passTranscripts() {
      const root = transcriptScope()
      const open = transcripts.get().open
      if (root) {
        // Groups first, then the rows: a group opener that is a row too is already open by now.
        if (open) openGroups(root, true)
        const rows = transcriptRows(root)
        const hits = transcriptClicks(rows, open, true)
        for (const r of hits) transcriptSeen.add(r.row)
        for (const r of hits) clickRow(r.row)
        for (const r of rows) transcriptSeen.add(r.row) // decided: later manual changes are left alone
      }
      countTranscripts()
    }

    function scheduleTranscripts() {
      transcriptPass.schedule()
    }

    /**
     * Watch the conversation, one coalesced pass at a time. Every row a pass touches is remembered,
     * so the mutations our own clicks cause cannot start a loop, and a row the person shut by hand is
     * never re-opened behind their back. A renamed engine just leaves the selectors empty: no throw.
     */
    function startTranscripts() {
      const mo = new MutationObserver(scheduleTranscripts)
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'hidden', 'data-open', 'data-conversation-scroll'] })
      scheduleTranscripts()
      return () => { mo.disconnect(); transcriptPass.cancel() }
    }

    // ---- pure result helpers: no React, no state. The contract with the server's result notices
    // (delivery.js), so nothing in it reaches outside it.

    /** The label a finished task's notice summary ends with, one per terminal state, word for word adapter.js TASK_LABELS. */
    const RESULT_LABELS = ['Completed', 'Failed', 'Stopped', 'Needs input', 'Paused by limit']
    /**
     * The job id and the task name a result notice's summary carries (`jev-3 · Fix sidebar width ·
     * Completed`), or null when the row is not one of our results. The first field must be a job
     * id and the last the label of a finished state; the name is everything between, since a
     * task name may hold the separator itself. Requiring a finished state's label last keeps
     * another plugin's notice, and any notice of ours about a task still at work, from being read
     * as a result. Pure, so the contract with the server is testable.
     */
    const resultOf = (summary) => {
      const parts = String(summary ?? '').split('·').map((s) => s.trim())
      if (parts.length < 3 || !RESULT_LABELS.includes(parts[parts.length - 1]) || !/^[a-z][\w-]{0,40}$/.test(parts[0])) return null
      return { id: parts[0], name: parts.slice(1, -1).join(' · ') }
    }
    /** The job id a result notice's summary starts with, or null when the row is not one of our results (resultOf). */
    const resultIdOf = (summary) => resultOf(summary)?.id ?? null

    // ---- end pure result helpers

    /**
     * Tell the server which background results this browser has actually rendered.
     *
     * A finished task stays "unread" until its message is in the conversation, and the engine
     * has no hook for "a person has now seen this", so the acknowledgement has to come from
     * here. Rows are matched by the job id the server puts at the front of the notice summary
     * and the task name after it (`jev-3 · Fix sidebar width · Completed`), and by the chat on
     * screen, which every row in the document is in: the engine hands a job id out again after a
     * restart, in every chat, and the server takes a result as read only under its own task's
     * name and chat, once its own notice has been posted. Each rendered row is acknowledged
     * once, remembered by the row itself rather than by what it says: the same words sent again
     * after a restart give the new task's row the very summary an older row has, and the older
     * row's refusal must not keep the new one from being acknowledged. A row mounted afresh, as
     * after switching chats, is posted again, and the server refuses what it has already taken. A
     * row whose request failed is forgotten so the next pass tries again. A renamed engine simply
     * leaves the selector empty.
     */
    const ackedRows = new WeakSet()
    function acknowledgeResults(openChat) {
      // The engine renders the producer and the summary as TEXT inside marked spans, not as
      // attribute values: `data-context-source` and `data-context-summary` are boolean
      // attributes on those spans (dsh-client-ui-chat ContextInjectionRow). So read the text,
      // and check the producer by its text too - a selector on the attribute value never
      // matches, which is how an earlier version silently acknowledged nothing.
      const results = []
      const spans = []
      for (const span of document.querySelectorAll('[data-context-summary]')) {
        const row = span.closest('[data-disclosure-row]') ?? span.parentElement
        if ((row?.querySelector('[data-context-source]')?.textContent ?? '').trim() !== 'jev-router') continue
        const r = resultOf(span.textContent)
        if (!r || ackedRows.has(span)) continue
        ackedRows.add(span)
        spans.push(span)
        results.push({ jobId: r.id, name: r.name })
      }
      if (!results.length) return
      // The chat is unknown only for a moment, while the engine reads its list of chats again; the
      // rows then go without it, as an older page sends them.
      const sessionId = openChat()
      post('/jev-router/tasks/seen', { ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}), results }).catch(() => { for (const span of spans) ackedRows.delete(span) })
    }
    /** `openChat` names the chat on screen, the engine's selected session; a test hands its own. */
    function startResultAcks(openChat = () => sessionsApi?.list?.getSnapshot?.()?.current) {
      const pass = coalesce(() => acknowledgeResults(openChat))
      const mo = new MutationObserver(pass.schedule)
      mo.observe(document.body, { childList: true, subtree: true })
      pass.schedule()
      return () => { mo.disconnect(); pass.cancel() }
    }

    // ---------- engine UI primitives ----------
    // Conversation context rows are the ENGINE's, deliberately. An earlier build registered the
    // keyed `conversation.chat.node` slot under key 'context' so a jev-router result would read
    // as a Markdown card. That key is kind `keyed`, not `chain`: registering it REPLACES the
    // shipped occupant outright and there is no fall-through, so one plugin row cost all five
    // other forms (instructions, catalog, snapshot, relay, recall) their structured bodies, which
    // fell back to flat text. Do not take that key again. The shipped renderer is not reachable
    // either: ContextInjectionRow and its 23 body helpers are internal to
    // @deepseek-ai/dsh-client-ui-chat and absent from its exports, so "keep the card AND the five"
    // means copying about 520 lines of engine internals that change without a changelog. A
    // jev-router result reads as Markdown in the Overview tab instead, which is a surface KzH owns.
    let uiPrims
    /**
     * The UI primitives (MarkdownText, DisclosureRow, the context icon). Loaded lazily and
     * never at factory time: client.js is a classic script, and the DOM-less unit tests hand
     * the factory a `require` that only knows `react`. A missing module degrades to plain
     * chrome and plain text rather than taking every context row down with it.
     */
    const primitives = () => {
      if (uiPrims === undefined) {
        try { uiPrims = require('@deepseek-ai/dsh-client-ui-primitives') ?? null } catch { uiPrims = null }
      }
      return uiPrims
    }
    /**
     * A block of Markdown, rendered through the engine's own renderer when the primitives are
     * reachable. When they are not, the same text lands in a plain pre-wrapped div, so a report
     * is never hidden by a renderer that failed to load: it only reads less well. The extra
     * class exists because `.answer-text` sets `white-space: pre-wrap`, which would double every
     * gap between rendered block elements.
     */
    function Markdown({ text, className }) {
      const M = primitives()?.MarkdownText
      if (!M) return h('div', { className }, text)
      return h('div', { className: cx(className, 'answer-md') }, h(M, { text }))
    }

    // ---------- actions and hotkeys ----------
    // Left sidebar state has no read API (ctx.layout only toggles); the frame marks it on its root element.
    const leftOpen = () => !document.querySelector('[data-sidebar-collapsed]')
    const rightOpen = () => { try { return !!sidebarRight?.isExpanded() } catch { return false } }
    const activeKind = () => { try { return rightOpen() ? sidebarRight.active()?.kind : undefined } catch { return undefined } }
    const openPanel = (kind, params) => {
      if (!sidebarRight) throw new Error('The right sidebar is not available')
      sidebarRight.openTab(kind, params ? { params } : undefined)
    }
    const togglePanel = (kind, params) => (activeKind() === kind ? sidebarRight.toggleExpanded() : openPanel(kind, params))
    let focusRestore = null
    function focusMode() {
      const left = leftOpen()
      const right = rightOpen()
      if (left || right) {
        focusRestore = { left, right }
        if (left) layout?.toggleSidebar()
        if (right) sidebarRight.toggleExpanded()
      } else {
        const r = focusRestore ?? { left: true, right: false }
        focusRestore = null
        if (r.left) layout?.toggleSidebar()
        if (r.right) sidebarRight?.toggleExpanded()
      }
    }
    const currentCwd = () => {
      const s = sessionsApi?.list?.getSnapshot?.()
      return s?.byId?.[s.current]?.cwd
    }
    // No settings-open API in DSH: click the sidebar's Settings trigger, then the section's nav row (fallback).
    function openSettings(label) {
      if (!document.querySelector('[role="dialog"][aria-modal="true"] nav')) {
        const trigger = document.querySelector('button[aria-label="Settings"],button[aria-label="设置"]')
        if (!trigger) throw new Error('Open Settings from the sidebar')
        trigger.click()
      }
      let tries = 0
      const pick = () => {
        const row = [...document.querySelectorAll('[role="dialog"] nav button')].find((b) => b.textContent.trim() === label)
        if (row) row.click()
        else if (++tries < 20) setTimeout(pick, 50)
      }
      pick()
    }

    /**
     * Everything the header, the menu and the hotkeys can do. `keys` is the default combo ('' = none).
     * `desc` is for someone who has never seen the app, so it says what the action really does: half
     * of these labels (Focus mode, Subagents, Files) tell you nothing on their own.
     */
    const closedTabs = [] // { kind, params } of sidebar tabs closed with Ctrl+W, newest last
    const ACTIONS = [
      { id: 'terminal', label: 'Terminal', keys: 'Ctrl+`', desc: "Opens a terminal window on your desktop, already in this session's project folder.", run: async () => {
        const cwd = currentCwd()
        if (!cwd) throw new Error('This session has no project folder')
        await post('/jev-router/open-terminal', { cwd })
      } },
      { id: 'background', label: 'Background tasks', keys: 'Ctrl+Alt+B', desc: 'Lists work already given to an agent in this session, running or finished, each with a timer, its output and a Stop button.', run: () => togglePanel(TASKS_KIND) },
      { id: 'live', label: 'Open Live', keys: '', desc: 'Opens the Live tab, where you watch an agent work on a task: its text, tool calls and reasoning as they stream.', run: () => togglePanel(LIVE_KIND) },
      { id: 'subagents', label: 'Subagents', keys: '', desc: 'Lists the helper sessions this session started, and opens one so you can read it.', run: () => togglePanel(SUBAGENTS_KIND) },
      { id: 'export', label: 'Export chat as Markdown', keys: 'Ctrl+Alt+M', desc: 'Copies the whole conversation as Markdown text, or saves it as a file.', run: () => openExport() },
      { id: 'queue', label: 'Task queue', keys: 'Ctrl+Alt+Q', desc: 'Lines up prompts you have not sent yet: the agent takes the next one each time it finishes the last.', run: () => openQueue() },
      { id: 'browser', label: 'Browser', keys: 'Ctrl+Alt+W', desc: 'Opens a web page beside the chat, meant for a local dev server or documentation.', run: () => togglePanel(BROWSER_KIND) },
      { id: 'jev-inspector', label: 'Jev inspector', keys: 'Ctrl+Alt+J', desc: 'Shows why Jev sent each task to the agent it picked, with the timings and the questions behind the choice.', run: () => togglePanel(KIND, { view: 'decisions' }) },
      { id: 'files', label: 'Files', keys: 'Ctrl+Alt+E', desc: "Browses the files in this session's project folder, in the right sidebar.", run: () => togglePanel('files') },
      { id: 'usage', label: 'Usage', keys: 'Ctrl+Alt+U', desc: "Shows how much of each account's limit is left, your balance and what Jev saved.", run: () => togglePanel(USAGE_KIND) },
      { id: 'left-sidebar', label: 'Toggle left sidebar', keys: 'Ctrl+B', desc: 'Hides or shows the list of chats down the left side.', run: () => layout.toggleSidebar() },
      { id: 'right-sidebar', label: 'Toggle right sidebar', keys: 'Ctrl+N', desc: 'Hides or shows the right panel: the Jev inspector, background tasks, subagents, browser, files and usage.', run: () => { try { sidebarRight.toggleExpanded() } catch { openPanel(KIND) } } },
      { id: 'focus-mode', label: 'Focus mode', keys: 'Ctrl+Shift+F', desc: 'Hides both side panels so only the chat is left, then puts back the ones you had open.', run: focusMode },
      { id: 'new-session', label: 'New session', keys: 'Ctrl+Alt+N', desc: 'Starts a fresh chat.', run: () => {
        if (uiWorkspace?.startSession) return uiWorkspace.startSession()
        const b = document.querySelector('button[aria-label="New session"]')
        if (!b) throw new Error('New session is not available here')
        b.click()
      } },
      // No composer focus API; the message box is DSH's one Lexical editor.
      // Right-sidebar tabs, browser-style. Reopen covers tabs closed with the hotkey (DSH reports no close events).
      { id: 'close-tab', label: 'Close sidebar tab', keys: 'Ctrl+W', desc: 'Closes the right sidebar panel you are looking at.', run: () => {
        let tab
        try { tab = sidebarRight.isExpanded() ? sidebarRight.active() : null } catch {}
        if (!tab) return
        closedTabs.push({ kind: tab.kind, params: tab.navigation?.params })
        if (closedTabs.length > 20) closedTabs.shift()
        sidebarRight.close(tab.id)
      } },
      { id: 'new-tab', label: 'New sidebar tab', keys: 'Ctrl+Alt+T', desc: "Opens the right sidebar's own list of panels, to pick one from.", run: () => sidebarRight.openTab('guide') },
      { id: 'reopen-tab', label: 'Reopen closed sidebar tab', keys: 'Ctrl+Shift+T', desc: 'Opens again the last right sidebar panel you closed.', run: () => {
        const last = closedTabs.pop()
        if (!last) throw new Error('No closed tab to reopen')
        openPanel(last.kind, last.params)
      } },
      { id: 'focus-input', label: 'Focus message box', keys: '', desc: 'Puts the cursor in the message box, ready to type.', run: () => document.querySelector('[data-lexical-editor="true"]')?.focus() },
      { id: 'jev-setup', label: 'Jev setup settings', keys: '', desc: 'Opens the settings page for agent logins, API keys and which agents Jev may use.', run: () => openSettings('Jev setup') },
      { id: 'shortcuts', label: 'Shortcuts settings', keys: '', desc: 'Opens the settings page where you change these keyboard shortcuts.', run: () => openSettings('Shortcuts') },
      // No default key: it acts on the conversation being read, so it stays opt-in.
      { id: 'transcripts', label: 'Toggle all transcripts', keys: '', desc: 'Opens or shuts every reasoning and tool block of the conversation you are reading, all at once.', run: () => toggleTranscripts() },
    ]
    const ACT = Object.fromEntries(ACTIONS.map((a) => [a.id, a]))
    const DEFAULTS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.keys]))
    const DEFAULT_RATIO = 24
    // Shortcuts DSH, its editor and the Kz-harness app already use (read-only; conflict detection checks them).
    const BUILTIN = [
      ['Ctrl+Enter', 'Send message (message box)'], ['Shift+Enter', 'New line (message box)'],
      ['Ctrl+A', 'Select all'], ['Ctrl+C', 'Copy'], ['Ctrl+X', 'Cut'], ['Ctrl+V', 'Paste'],
      ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'], ['Ctrl+Shift+Z', 'Redo'],
      ['F12', 'Developer tools (Kz-harness app)'], ['Ctrl+Shift+I', 'Developer tools (Kz-harness app)'],
      ['Ctrl+Shift+L', 'Log window (Kz-harness app)'], ['Ctrl+Q', 'Quit (Kz-harness app)'], ['Ctrl+R', 'Reload (Kz-harness app)'],
      ['Ctrl+0', 'Reset zoom'], ['Ctrl+=', 'Zoom in'], ['Ctrl+Shift+=', 'Zoom in'], ['Ctrl+-', 'Zoom out'], ['F11', 'Full screen'],
    ]
    const hotkeys = makeStore({ bindings: { ...DEFAULTS }, ratio: DEFAULT_RATIO })
    /** Other owners of a combo: [{ label }]. */
    const conflictsOf = (id, combo) => !combo ? [] : [
      ...ACTIONS.filter((a) => a.id !== id && hotkeys.get().bindings[a.id] === combo).map((a) => `${a.label} (this list)`),
      ...BUILTIN.filter(([k]) => k === combo).map(([, what]) => what),
    ]

    const CODE_KEY = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space' }
    /** Keyboard event -> "Ctrl+Alt+Shift+Meta+Key" by physical key (layout-proof), or null for a bare modifier. */
    function comboOf(e) {
      const c = e.code ?? ''
      const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^(Digit|Numpad)\d$/.test(c) ? c.slice(-1) : CODE_KEY[c]
        ?? (/^(F([1-9]|1[0-2])|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/.test(e.key) ? e.key : null)
      if (!key) return null
      return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.metaKey ? 'Meta+' : ''}${key}`
    }
    const ariaKeys = (combo) => combo.replace(/Ctrl/g, 'Control').replace(/(^|\+)`$/, '$1Backquote')

    // The shipped sidebar toggles carry no hotkey hint of their own (empty title and
    // aria-keyshortcuts), so the combo would be discoverable only inside Settings. They are matched
    // by their accessible name, which is also the words the tooltip keeps: the combo is appended,
    // never folded into aria-label, so the accessible name reads the same either way. Both words the
    // shipped chrome uses for a shut sidebar are accepted, "Open" (its own dictionary) and "Expand",
    // so a state change never loses the hint. Pure.
    const TOGGLE_ACTION = [
      [/^(Open|Collapse|Expand) sidebar$/i, 'left-sidebar'],
      [/^(Open|Collapse|Expand) right sidebar$/i, 'right-sidebar'],
    ]
    /** A shipped sidebar toggle's aria-label -> its action id, or null when it is not one. Pure. */
    const toggleActionOf = (label) => TOGGLE_ACTION.find(([re]) => re.test(String(label ?? '')))?.[1] ?? null
    /**
     * Write each shipped toggle's combo next to its own words: `title` gets " (combo)" and
     * `aria-keyshortcuts` the ariaKeys form, both dropped again when the action is unbound. The combo
     * is read from the live store, so a rebound key lands by the next pass. An attribute is written
     * only when it differs, so a React render that leaves it alone is never disturbed, and the button
     * itself is never replaced.
     */
    function decorateSidebarToggles() {
      const { bindings } = hotkeys.get()
      for (const b of document.querySelectorAll('button[aria-label]')) {
        const id = toggleActionOf(b.getAttribute('aria-label'))
        if (!id) continue
        const combo = bindings[id] ?? ''
        const words = b.getAttribute('aria-label')
        const title = combo ? `${words} (${combo})` : words
        if (b.title !== title) b.title = title
        const keys = combo ? ariaKeys(combo) : ''
        if ((b.getAttribute('aria-keyshortcuts') ?? '') !== keys) {
          if (keys) b.setAttribute('aria-keyshortcuts', keys)
          else b.removeAttribute('aria-keyshortcuts')
        }
      }
    }
    /**
     * Coalesce a burst of DOM passes into one, on a timer rather than an animation frame: a hidden or
     * minimised window runs no frames at all, so a frame-gated pass would never land, which is the
     * state the app is launched into. Pure bookkeeping, so the decision is unit tested.
     */
    function coalesce(run) {
      let queued = 0
      return {
        schedule: () => { if (!queued) queued = setTimeout(() => { queued = 0; run() }, 0) },
        cancel: () => { if (queued) { clearTimeout(queued); queued = 0 } },
      }
    }
    /** Re-assert the hints on DOM changes and when the bindings change; writes only what differs. */
    function startToggleHints() {
      const pass = coalesce(decorateSidebarToggles)
      const mo = new MutationObserver(pass.schedule)
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'aria-keyshortcuts', 'aria-label'] })
      const unsub = hotkeys.sub(pass.schedule)
      decorateSidebarToggles()
      return () => { mo.disconnect(); unsub(); pass.cancel() }
    }

    // ---------- left sidebar: the open session's workspace as a file tree ----------
    // There is no independent "selected workspace" anywhere in the Client: a session list entry
    // carries only `cwd` (dsh-api-session-controller SessionListEntry), and the shipped Files tab
    // roots itself at that same `cwd`. So this roots at the open session's cwd, which is the
    // workspace path as far as the Client can resolve one.
    //
    // Nothing shipped is replaced. `sidebar.workspaces` is kind SINGLE and owned by the shipped
    // browser (replaceRisk shadows-shipped-ui), so this decorates shipped DOM instead: a toggle
    // button inserted beside the shipped search button, and a host div inserted under the sidebar's
    // region area. Both are re-asserted on DOM mutations by the existing coalesce scheduler, and
    // only while the anchor is found, so a renamed engine leaves the sidebar exactly as it was.
    // The listing is the shipped RPC `ctx.remote.workspaceFiles.list(sessionId, path, signal)`.
    const FILE_TREE_ROW_CAP = 400 // rendered rows; a huge folder must not hang the sidebar
    const FILE_TREE_TOGGLE_ID = 'kzh-file-tree-toggle'
    const FILE_TREE_HOST_ID = 'kzh-file-tree-host'
    // The shipped search button's accessible name, in the two languages this app ships.
    const FILE_TREE_SEARCH_LABELS = ['Search sessions', '搜索会话']
    const fileTree = makeStore({ open: false, toggle: null, host: null })

    /** Directories first, then natural name order. Pure; mirrors the shipped tree's order. */
    function orderTreeEntries(entries) {
      const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
      return [...(entries ?? [])].sort((a, b) => {
        const group = Number(b?.type === 'directory') - Number(a?.type === 'directory')
        return group !== 0 ? group : byName.compare(a?.name ?? '', b?.name ?? '')
      })
    }
    /** One child's path: `/`-joined whatever the parent's separators, trailing ones dropped. Pure. */
    const treeChildPath = (parent, name) => `${String(parent).replace(/[/\\]+$/, '')}/${name}`
    /** The listing failure as one line, in the shipped tree's words. Pure. */
    function treeFailureLine(failure) {
      switch (failure?.code) {
        case 'workspace-file/not-found': return 'That directory is gone. It may have been moved or deleted.'
        case 'workspace-file/outside-workspace': return 'That directory is outside the workspace, so the sidebar will not read it.'
        case 'workspace-file/not-directory': return 'That is not a directory.'
        default: return `Read failed: ${failure?.message ?? 'unknown error'}`
      }
    }
    /**
     * The `dsh-resource://file/...` address of one path in one session, mirroring the shipped
     * `fileAddressFor`: workspace-relative inside the root, the absolute path otherwise. Pure.
     */
    function fileAddressFor(sessionId, root, path) {
      const seg = (s) => encodeURIComponent(String(s)).replace(/%3A/gi, ':')
      const address = (p) => `dsh-resource://file/session/${seg(sessionId)}/${String(p).split('/').map(seg).join('/')}`
      const normalized = String(path).replace(/\\/g, '/')
      const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
      if (!absolute) return address(normalized)
      const base = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
      if (base !== '' && normalized === base) return address('')
      if (base !== '' && normalized.startsWith(`${base}/`)) return address(normalized.slice(base.length + 1))
      return address(normalized)
    }
    /**
     * Flatten the loaded tree to the rows to draw, directories first within each level, stopping at
     * `limit` rows. Levels exist only once a directory is expanded, so this is what is on screen.
     * Loading, empty and failure levels each become one note row. Pure, so the cap unit-tests.
     */
    function treeRows(root, levels, expanded, limit) {
      const open = new Set(expanded ?? [])
      const cap = Number.isFinite(limit) && limit > 0 ? limit : Infinity
      const out = []
      let capped = false
      const push = (row) => { if (out.length >= cap) { capped = true; return false } out.push(row); return true }
      const visit = (path, depth) => {
        if (capped) return
        const level = levels?.[path]
        if (level === undefined || level.status === 'loading') { push({ kind: 'note', note: 'loading', key: `${path}#loading`, depth }); return }
        if (level.status === 'error') { push({ kind: 'note', note: level.message ?? 'Read failed', key: `${path}#error`, depth }); return }
        const entries = orderTreeEntries(level.entries)
        if (!entries.length) push({ kind: 'note', note: 'empty', key: `${path}#empty`, depth })
        for (const entry of entries) {
          if (capped) return
          const child = treeChildPath(path, entry.name)
          if (!push({ kind: entry.type, name: entry.name, path: child, depth })) return
          if (entry.type === 'directory' && open.has(child)) visit(child, depth + 1)
        }
        if (!capped && level.truncated) push({ kind: 'note', note: 'truncated', key: `${path}#truncated`, depth })
      }
      visit(root, 0)
      if (capped) out.push({ kind: 'note', note: 'capped', key: `${root}#capped`, depth: 0 })
      return { rows: out, capped }
    }

    /**
     * The shipped search box: the input whose own box holds the search button. Anchoring on the
     * input (always present in wide mode, absent in the rail) keeps the toggle out of the rail and
     * off every other sidebar. A null answer means the feature stays off with no half-drawn UI.
     */
    function fileTreeAnchor() {
      for (const input of document.querySelectorAll('input[type="text"]')) {
        const box = input.parentElement
        if (!box) continue
        const button = [...box.querySelectorAll('button[aria-label]')]
          .find((b) => FILE_TREE_SEARCH_LABELS.includes(b.getAttribute('aria-label')))
        if (!button) continue
        const slot = box.parentElement        // the search slot
        const header = slot?.parentElement    // the section header
        const workspaces = header?.parentElement
        const region = workspaces?.parentElement?.parentElement ?? null // through the contents wrapper
        if (!slot || !header || !workspaces || !region) continue
        return { box, slot, header, workspaces, region }
      }
      return null
    }
    /** The one toggle button, placed right after the search slot. */
    function fileTreeToggle(anchor) {
      let button = document.getElementById(FILE_TREE_TOGGLE_ID)
      if (!button) {
        button = document.createElement('button')
        button.id = FILE_TREE_TOGGLE_ID
        button.type = 'button'
        button.className = 'kzh-ft-toggle'
        button.setAttribute('aria-controls', FILE_TREE_HOST_ID)
        button.setAttribute('aria-expanded', 'false')
        button.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          fileTree.set({ open: !fileTree.get().open })
        })
      }
      if (button.parentElement !== anchor.slot.parentElement || button.previousElementSibling !== anchor.slot) {
        anchor.slot.parentElement.insertBefore(button, anchor.slot.nextSibling)
      }
      const open = fileTree.get().open
      const label = open ? 'Hide file tree' : 'Show file tree'
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
      if (button.title !== label) button.title = label
      const expanded = String(open)
      if ((button.getAttribute('aria-expanded') ?? '') !== expanded) button.setAttribute('aria-expanded', expanded)
      return button
    }
    /** The one tree host, under the sidebar's workspace region, or null. */
    function fileTreeHost(anchor) {
      let host = document.getElementById(FILE_TREE_HOST_ID)
      if (!host) {
        host = document.createElement('div')
        host.id = FILE_TREE_HOST_ID
        host.className = 'kzh-ft-host'
      }
      // The WorkspaceBrowser root sits inside a display:contents wrapper; insert after that wrapper
      // so the host becomes a sibling flex item of the region, docked under the session list.
      const wrapper = anchor.workspaces.parentElement
      const after = wrapper?.parentElement === anchor.region ? wrapper : anchor.workspaces
      if (host.parentElement !== anchor.region || host.previousElementSibling !== after) {
        anchor.region.insertBefore(host, after.nextSibling)
      }
      return host
    }
    /**
     * One coalesced DOM pass: place the toggle beside the search icon and the host under the
     * region. Idempotent by id, so React re-renders can drop either and the next pass restores it
     * without ever drawing a duplicate. No anchor means the feature is silently off.
     */
    function assertFileTreeDom() {
      const anchor = fileTreeAnchor()
      const prev = fileTree.get()
      if (!anchor) {
        if (prev.toggle || prev.host) {
          document.getElementById(FILE_TREE_TOGGLE_ID)?.remove()
          document.getElementById(FILE_TREE_HOST_ID)?.remove()
          fileTree.set({ toggle: null, host: null })
        }
        return
      }
      const button = fileTreeToggle(anchor)
      const host = fileTree.get().open ? fileTreeHost(anchor) : (document.getElementById(FILE_TREE_HOST_ID)?.remove(), null)
      const patch = {}
      if (prev.toggle !== button) patch.toggle = button
      if (prev.host !== host) patch.host = host
      if (Object.keys(patch).length) fileTree.set(patch)
    }
    function startFileTree() {
      const pass = coalesce(assertFileTreeDom)
      const mo = new MutationObserver(pass.schedule)
      mo.observe(document.body, { childList: true, subtree: true })
      const unsub = fileTree.sub(pass.schedule)
      assertFileTreeDom()
      return () => { mo.disconnect(); unsub(); pass.cancel() }
    }
    /** The toggle's glyph, from the shipped primitives. Draws nothing else. */
    function FileTreeToggleIcon({ open }) {
      const P = primitives()
      const Icon = open ? P?.IconFolderOpen16 : P?.IconFolderClose16
      return h('span', { className: 'kzh-ft-toggleIcon', 'aria-hidden': true }, Icon ? h(Icon, { size: 16 }) : (open ? '-' : '+'))
    }
    /**
     * The tree itself, rendered by this plugin through a portal into the host. Lazy: one directory
     * level per RPC call, directories first, read-only. Rooted at the open session's cwd.
     */
    function FileTree({ sessionId, useSessions }) {
      const cwd = useSessions?.((s) => s.byId?.[sessionId]?.cwd)
      const [levels, setLevels] = useState({})
      const [expanded, setExpanded] = useState([])
      const generations = useRef(new Map())
      const abortRef = useRef(null)

      const load = (path, signal) => {
        if (!workspaceFiles) return
        const generation = (generations.current.get(path) ?? 0) + 1
        generations.current.set(path, generation)
        setLevels((m) => ({ ...m, [path]: { status: 'loading' } }))
        let pending
        try { pending = workspaceFiles.list(sessionId, path, signal) } catch (e) {
          setLevels((m) => ({ ...m, [path]: { status: 'error', message: `Read failed: ${e?.message ?? String(e)}` } }))
          return
        }
        Promise.resolve(pending).then((result) => {
          if (generations.current.get(path) !== generation) return
          if (result?.ok) setLevels((m) => ({ ...m, [path]: { status: 'ready', entries: result.value?.entries ?? [], truncated: !!result.value?.truncated } }))
          else setLevels((m) => ({ ...m, [path]: { status: 'error', message: treeFailureLine(result?.error) } }))
        }, (error) => {
          if (generations.current.get(path) !== generation) return
          setLevels((m) => ({ ...m, [path]: { status: 'error', message: `Read failed: ${error?.message ?? String(error)}` } }))
        })
      }

      useEffect(() => {
        const controller = new AbortController()
        abortRef.current = controller
        generations.current = new Map()
        setLevels({})
        if (cwd === undefined) {
          setExpanded([])
        } else {
          setExpanded([cwd])
          load(cwd, controller.signal)
        }
        return () => { controller.abort(); generations.current = new Map() }
      }, [sessionId, cwd])

      const reload = () => {
        if (cwd === undefined) return
        generations.current = new Map()
        setLevels({})
        setExpanded([cwd])
        load(cwd, abortRef.current?.signal)
      }
      const toggleDir = (path) => {
        const isOpen = expanded.includes(path)
        setExpanded((xs) => (isOpen ? xs.filter((p) => p !== path) : [...xs, path]))
        const level = levels[path]
        if (!isOpen && (level === undefined || level.status === 'error')) load(path, abortRef.current?.signal)
      }
      // A file opens the same way the shipped Files tab opens one: a `dsh-resource://file/...`
      // address through the right sidebar's navigation controller. Nothing custom is invented.
      const openFile = (path) => {
        const address = fileAddressFor(sessionId, cwd, path)
        try {
          if (typeof sidebarRight?.openResourceIn === 'function') sidebarRight.openResourceIn(sessionId, address)
          else if (typeof sidebarRight?.openResource === 'function') sidebarRight.openResource(address)
          else throw new Error('The right sidebar is not available')
        } catch (error) { toast(error?.message ?? String(error)) }
      }

      useStyle()
      const P = primitives()
      const noteText = (note) => note === 'loading' ? 'Reading...'
        : note === 'empty' ? 'Empty directory'
          : note === 'truncated' ? 'Too many entries, showing only some of them.'
            : note === 'capped' ? `Showing the first ${FILE_TREE_ROW_CAP} rows. Collapse a folder to see the rest.`
              : note

      if (cwd === undefined) {
        return h('div', { className: 'kzh-ft', 'data-kzh-ft-state': 'no-workspace' },
          h('p', { className: 'kzh-ft-note' }, 'This session has no workspace directory.'))
      }
      const { rows } = treeRows(cwd, levels, expanded, FILE_TREE_ROW_CAP)
      const rowNodes = rows.map((row) => {
        if (row.kind === 'note') {
          return h('div', { key: row.key, className: cx('kzh-ft-note', row.note === 'loading' && 'kzh-ft-loading') }, noteText(row.note))
        }
        const style = { paddingLeft: `${6 + row.depth * 12}px` }
        if (row.kind === 'directory') {
          const open = expanded.includes(row.path)
          return h('button', {
            key: row.path, type: 'button', className: 'kzh-ft-row dir', style, 'aria-expanded': open, title: row.name,
            onClick: () => toggleDir(row.path),
          },
          h('span', { className: cx('kzh-ft-chev', open && 'open'), 'aria-hidden': true }, P?.IconChevronRightOutline14 ? h(P.IconChevronRightOutline14, { size: 14 }) : '>'),
          h('span', { className: 'kzh-ft-icon', 'aria-hidden': true }, P?.IconFolderOpen16 ? h(open ? P.IconFolderOpen16 : P.IconFolderClose16, { size: 16 }) : ''),
          h('span', { className: 'kzh-ft-name' }, row.name))
        }
        if (row.kind === 'file') {
          return h('button', {
            key: row.path, type: 'button', className: 'kzh-ft-row file', style, title: row.path,
            onClick: () => openFile(row.path),
          },
          h('span', { className: 'kzh-ft-chev spacer', 'aria-hidden': true }),
          h('span', { className: 'kzh-ft-icon', 'aria-hidden': true }, P?.FileTypeIcon ? h(P.FileTypeIcon, { kind: P.classifyFileType ? P.classifyFileType(row.name) : undefined, size: 16 }) : ''),
          h('span', { className: 'kzh-ft-name' }, row.name))
        }
        return h('div', { key: row.path, className: 'kzh-ft-row other', style, 'aria-disabled': 'true', title: 'Not a file or a directory, so it cannot be opened.' },
          h('span', { className: 'kzh-ft-chev spacer', 'aria-hidden': true }),
          h('span', { className: 'kzh-ft-name' }, row.name))
      })
      return h('div', { className: 'kzh-ft', 'data-kzh-ft-state': 'tree', 'data-kzh-ft-root': cwd },
        h('div', { className: 'kzh-ft-head' },
          h('span', { className: 'kzh-ft-title' }, 'Files'),
          h('span', { className: 'kzh-ft-root', title: cwd }, cwd),
          h('button', { type: 'button', className: 'kzh-ft-reload', title: 'Reload file tree', 'aria-label': 'Reload file tree', onClick: reload }, 'Reload')),
        h('div', { className: 'kzh-ft-body' }, ...rowNodes))
    }
    /**
     * Always mounted in the shell overlay; draws nothing of its own. It only portals: the toggle's
     * glyph into the injected button, and the tree into the injected host, both owned by the DOM
     * pass above. So the toggle and the panel can never be duplicated by a React render.
     */
    function FileTreeSeat({ useSessions }) {
      useStyle() // the toggle's own styles must land while the tree is still shut
      const state = fileTree.use()
      const current = useSessions?.((s) => s.current) ?? null
      const RD = portaling()
      if (!RD) return null
      const portals = []
      if (state.toggle) portals.push(RD.createPortal(h(FileTreeToggleIcon, { open: state.open }), state.toggle))
      if (state.open && state.host && current) portals.push(RD.createPortal(h(FileTree, { sessionId: current, useSessions }), state.host))
      return portals.length ? h(React.Fragment, null, ...portals) : null
    }

    let capturing = false // the Shortcuts page is recording a combo; actions stay quiet

    const settle = () => setTimeout(() => window.dispatchEvent(new Event('kz-ui')), 300)
    function runAction(id) {
      const fail = (e) => toast(/seat|mounted|surface|session/i.test(e?.message ?? '') && !currentCwd() ? 'Open a session first' : e?.message ?? String(e))
      try { Promise.resolve(ACT[id].run()).catch(fail) } catch (e) { fail(e) }
      settle()
    }
    function onHotkey(e) {
      if (capturing || e.repeat || e.isComposing || e.defaultPrevented || e.getModifierState?.('AltGraph')) return
      const combo = comboOf(e)
      if (!combo) return
      const t = e.target
      const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      if (typing && !(e.ctrlKey || e.altKey || e.metaKey)) return
      const hit = ACTIONS.find((a) => hotkeys.get().bindings[a.id] === combo)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      runAction(hit.id)
    }

    // Right sidebar opens at a share of the window until the person drags its edge (DSH's default is 45%).
    let userSized = false
    function sizeRightbar(force) {
      if (userSized && !force) return
      try { layout?.panels?.setRightbar?.(Math.max(300, Math.round(window.innerWidth * hotkeys.get().ratio / 100))) } catch {}
    }
    async function loadHotkeys() {
      try {
        const d = await api('/jev-router/hotkeys')
        hotkeys.set({ bindings: { ...DEFAULTS, ...(d.bindings ?? {}) }, ratio: d.rightbarRatio ?? DEFAULT_RATIO })
        sizeRightbar()
      } catch {}
    }
    const saveHotkeys = (next) => post('/jev-router/hotkeys', { bindings: next.bindings, rightbarRatio: next.ratio })

    /** Re-render after anything that may have moved a sidebar (clicks, keys, our own actions). */
    function useUiTick() {
      const [, force] = useState(0)
      useEffect(() => {
        let t
        const later = () => { clearTimeout(t); t = setTimeout(() => force((n) => n + 1), 300) }
        document.addEventListener('click', later, true)
        document.addEventListener('keyup', later, true)
        window.addEventListener('kz-ui', later)
        return () => { clearTimeout(t); document.removeEventListener('click', later, true); document.removeEventListener('keyup', later, true); window.removeEventListener('kz-ui', later) }
      }, [])
    }
    function useNow(active) {
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        if (!active) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [active])
      return now
    }

    // ---------- inspector: data ----------
    function useRuns(sessionId, visible, every = 1000) {
      const [runs, setRuns] = useState([])
      useEffect(() => {
        if (!visible || !sessionId) return
        let stop = false
        let timer
        const tick = async () => {
          try { const r = await api(`/jev-router/log?session=${encodeURIComponent(sessionId)}`); if (!stop) setRuns(r) } catch {}
          // ponytail: 1 s poll of a localhost route; switch to SSE if it ever shows up in profiles.
          if (!stop) timer = setTimeout(tick, every)
        }
        tick()
        return () => { stop = true; clearTimeout(timer) }
      }, [sessionId, visible, every])
      return runs
    }

    function summarize(run) {
      const ev = run.events
      const first = run.startedAt ?? ev[0]?.at ?? Date.now()
      // The run's own last event. Laya's shadow rows land in the same log (5.3), often after the
      // run has ended, and their time is Laya's background work, not how long the run took.
      const last = ev.filter((e) => e.type !== 'shadow').at(-1)
      // A read pass that handed its task to the folder's line (docs/queue-and-cost-findings.md 1)
      // ends there with no final event of its own: it ended, as needs_write, with the reason given.
      const handedBack = ev.find((e) => e.type === 'access' && e.mode === 'write' && e.from === 'read')
      const final = ev.find((e) => e.type === 'final') ?? (handedBack ? { type: 'final', at: handedBack.at, status: 'needs_write', statusReason: handedBack.why } : undefined)
      const error = ev.find((e) => e.type === 'error')
      const routed = ev.find((e) => e.type === 'routed')
      const traces = ev.filter((e) => e.type === 'jev').map((e) => e.trace)
      // Every decider call in the order it settled: an answered one carries its trace, a failed one
      // (`'decider-error'`) only who, which call, how long and why (3.3).
      const calls = ev.filter((e) => e.type === 'jev' || e.type === 'decider-error').map((e) => (e.type === 'jev' ? { trace: e.trace } : { failed: e }))
      const starts = ev.filter((e) => e.type === 'attempt_start')
      const ends = ev.filter((e) => e.type === 'attempt_end')
      const reviews = ev.filter((e) => e.type === 'review')
      const running = !final && !error
      const attempts = starts.map((s) => ({ ...s, end: ends.find((x) => x.index === s.index)?.attempt, review: reviews.find((x) => x.index === s.index)?.assessment }))
      const toolMs = attempts.filter((a) => a.role === 'tool').reduce((t, a) => t + (a.end?.durationMs ?? 0), 0)
      const agentMs = attempts.filter((a) => a.role !== 'tool').reduce((t, a) => t + (a.end?.durationMs ?? 0), 0)
      // The decider's time is every call's, those that failed included: a call that timed out
      // spent its whole deadline, and leaving it out would read as the decider taking no time.
      const failedCalls = calls.filter((c) => c.failed)
      const jevMs = traces.reduce((t, x) => t + x.ms, 0) + failedCalls.reduce((t, c) => t + (c.failed.error?.ms ?? c.failed.ms ?? 0), 0)
      const q = traces.flatMap((t) => t.questions)
      return {
        running, final, error, routed, traces, calls, attempts, jevMs, failedCalls: failedCalls.length, toolMs, agentMs,
        // Who answered this run's routing and review questions: its routing says, else its first call.
        decider: routed?.routing ? deciderOf(routed.routing) : traces[0]?.provider ?? calls[0]?.failed?.error?.provider ?? 'jev',
        endedAt: running ? null : last?.at ?? first,
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
        tile(deciderName(s.decider), ms(s.jevMs), s.failedCalls ? `${s.failedCalls} call${s.failedCalls === 1 ? '' : 's'} failed` : null),
        s.toolMs ? tile('Tool', ms(s.toolMs)) : tile('Agents', ms(s.agentMs)),
        tile('Total', ms(s.total), s.running ? 'running…' : null),
        tile('Questions', `${s.used}/${s.questions}`, `${s.tokIn} in / ${s.tokOut} out tok`))
    }

    const STATUS = {
      accepted: ['ok', 'Accepted'],
      accepted_pending_human_review: ['warn', 'Accepted, human review recommended'],
      needs_human: ['warn', 'Needs human'],
      limit_reached: ['bad', 'Stopped: limit reached'],
      needs_write: ['warn', 'Handed to its folder\'s line'],
    }

    /** `decisionCard`: the decision card is rendered beside this one and carries the gate notes itself. */
    function WhatHappened({ s, decisionCard = false }) {
      const R = s.routed?.routing
      if (!R) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'What the code did'), h('div', { className: 'muted' }, s.error ? s.error.message : 'Routing…'))
      const kind = s.routed.tool ? 'tool' : R.mode === 'jev' ? 'agent' : R.mode
      const badge = { tool: 'tool', agent: 'agent', manual: 'manual', fallback: 'fallback' }[kind]
      // A run Laya decided names Laya (3.2), and offline Laya still decides, over the local agents.
      const decider = deciderOf(R)
      const who = deciderName(decider)
      // A decider picked over the whole pool ('jev') or over the local agents alone ('local': Jev
      // Auto · Local, or Laya Auto offline); only the offline fixed rule, the fallback and a forced
      // agent picked without one.
      const picked = R.mode === 'jev' || R.mode === 'local'
      const line = s.routed.tool
        ? `${who} picked tool ${s.routed.tool} (fits ${pct(R.toolFits)}, args ${pct(R.toolArgConfidence)}); no LLM needed`
        : picked ? `${who} picked ${movesOf(R)[0]?.from ?? R.primaryAgent} (confidence ${pct(R.agentConfidence)})`
          : R.mode === 'manual' ? `You forced ${R.primaryAgent}` : `${who} unavailable (${R.reason}); default agent ${movesOf(R)[0]?.from ?? R.primaryAgent}`
      const rows = []
      if (picked) {
        rows.push(['Task type', `${R.taskType} (${pct(R.taskTypeConfidence)})`], ['Complexity', pct(R.complexity)], ['Risk', pct(R.risk)],
          // A yes under the low risk band is kept as answered and held (decision.js): say so, or the
          // figure reads as a review that never comes.
          ['Second opinion', `${pct(R.needsSecondOpinion)}${R.decision?.domains?.second_opinion?.heldBy === 'risk' ? ' (held: low risk)' : ''}`], ['Human review', pct(R.needsHumanReview)], ['Needs tests', pct(R.needsTests)])
      }
      if (s.routed.tool) for (const [k, v] of Object.entries(R.toolArgs ?? {})) rows.push([`arg ${k}`, v])
      const st = s.final && (STATUS[s.final.status] ?? ['', s.final.status])
      return h('div', { className: 'card' },
        h('div', { className: 'label' }, 'What the code did'),
        h('div', null, h('span', { className: cx('badge', badge) }, badge), line),
        // The decision card says this when it is shown (it renders only with a decision record);
        // anywhere else, the Overview ledger included, this is the only place.
        ...(R.decision && decisionCard ? [] : gateNotes(R).map((t, i) => h('div', { className: 'why', key: `gate${i}` }, t))),
        ...moveNotes(R).map((t, i) => h('div', { className: 'why', key: `move${i}` }, t)),
        rows.length ? h('dl', null, ...rows.flatMap(([k, v]) => [h('dt', { key: `t${k}` }, k), h('dd', { key: `d${k}` }, v)])) : null,
        s.attempts.length ? h('div', { style: { marginTop: 12 } }, h('div', { className: 'label' }, 'Steps'),
          h('ol', { className: 'steps' }, ...s.attempts.map((a) => h('li', { key: a.index },
            h('div', null, h('b', null, a.agent), h('span', { className: 'pill' }, a.role),
              a.end ? h('span', { className: cx('pill', a.end.stopReason === 'completed' ? 'ok' : 'bad') }, `${a.end.stopReason} · ${ms(a.end.durationMs)}`) : h('span', { className: 'pill warn' }, 'running…')),
            a.end?.checks?.length ? h('div', { className: 'why' }, 'Checks: ', a.end.checks.map((c) => `${c.name} ${c.passed ? 'pass' : 'FAIL'}`).join(', ')) : null,
            a.end?.changedFiles?.length ? h('div', { className: 'why' }, 'Changed: ', a.end.changedFiles.join(', ')) : null,
            a.end?.answerText ? h('details', { className: 'answer' },
              h('summary', null, `Answer from ${a.agent}${a.end.model ? ` (${a.end.model})` : ''}`),
              h('div', { className: 'answer-text' }, a.end.answerText)) : null,
            a.review ? h('div', { className: 'why' }, 'Review → ', h('b', null, a.review.action), `: ${a.review.why}`) : null)))) : null,
        st ? h('div', { style: { marginTop: 10 } }, 'Final: ', h('span', { className: cx('pill', st[0]) }, st[1]), s.final.statusReason ? h('span', { className: 'why' }, ` ${s.final.statusReason}`) : null) : null,
        s.error ? h('div', { className: 'err' }, s.error.message) : null)
    }

    // How sure a number is, as words: a score nobody has much evidence for must not read like one
    // that hundreds of runs stand behind.
    const evidenceNote = (c) => (c == null ? '' : c >= 0.75 ? 'well evidenced' : c >= 0.4 ? 'some evidence' : 'little evidence')

    // ---- pure display helpers: no React, no state. test/observability.test.js evaluates this
    // block on its own (the runner cannot import a classic script), so nothing in it may reach
    // outside it except `pct` and `evidenceNote`.

    // Where one figure of a limit came from and how far it can be trusted, read exactly as
    // resources.js provenanceOf reads it: the figure's own `fieldSources` entry when it has one,
    // else the limit's. A limit's `source` and `confidence` are its measured figure's; a share
    // spent worked out from a locally observed high-water mark carries its own, much lower, entry,
    // and printing it under the limit's would present an estimate as the provider's word.
    const provenanceOf = (l, field) => {
      const unit = (c) => (typeof c === 'number' && c >= 0 && c <= 1 ? c : 0)
      const own = l?.fieldSources?.[field]
      if (own) return { source: own.source, confidence: unit(own.confidence) }
      return { source: typeof l?.source === 'string' ? l.source : 'unknown', confidence: unit(l?.confidence) }
    }
    const SOURCE_WORDS = {
      provider_api: 'from the provider',
      provider_cli: 'from the provider CLI',
      local_cache: 'cached',
      local_observation: 'observed locally',
      estimate: 'estimated',
      manual: 'entered by hand',
      unknown: 'source unknown',
    }
    const provenanceNote = (p) => `${SOURCE_WORDS[p.source] ?? String(p.source).replace(/_/g, ' ')}, ${evidenceNote(p.confidence)}`

    /**
     * One limit as a line: each figure with where it came from, at its own confidence. When every
     * figure shares one provenance it is said once; when they differ (a measured balance next to
     * an estimated share spent) each says its own, so the estimate reads as one.
     */
    const limitText = (l) => {
      const figures = []
      if (l.ratioUsed != null) figures.push([`${pct(l.ratioUsed)} used`, provenanceOf(l, 'ratioUsed')])
      if (l.unit && l.unit !== 'percent' && l.remaining != null) figures.push([`${l.remaining} ${l.unit} left`, provenanceOf(l, 'remaining')])
      if (!figures.length) return `${l.id} unknown`
      const [, first] = figures[0]
      if (figures.every(([, p]) => p.source === first.source && p.confidence === first.confidence)) return `${l.id} ${figures.map(([t]) => t).join(', ')} (${provenanceNote(first)})`
      return `${l.id} ${figures.map(([t, p]) => `${t} (${provenanceNote(p)})`).join(', ')}`
    }

    /**
     * Why the pick stands although its weekly gate says otherwise, in words. The decision engine
     * keeps a gated resource for frontier work (`decision.gateOverride`); the router itself lets
     * the gate yield (`gateYielded`) when nothing ungated can do the request, or when everything
     * is gated. The second can happen with no decision record at all.
     */
    const gateNotes = (R) => {
      if (!R) return []
      const out = []
      if (R.decision?.gateOverride) out.push(`${R.primaryAgent} was kept despite its weekly gate: this task needs frontier capability nothing else has`)
      if (R.gateYielded === 'capability') out.push(`${R.primaryAgent} was kept despite its weekly gate: every agent that can do this request is past its gate`)
      else if (R.gateYielded === 'everything_gated') out.push(`${R.primaryAgent} was kept despite its weekly gate: every agent is past its gate`)
      else if (R.gateYielded) out.push(`${R.primaryAgent} was kept despite its weekly gate (${String(R.gateYielded).replace(/_/g, ' ')})`)
      return out
    }
    /**
     * Every move the router made of its own (a capability swap, a near-tie tie-break, the weekly
     * gate, the feedback prior), in order, in the words router.js moveLine writes into the report.
     * A record from before `moves` was kept has only the `<kind>From` fields, each then read as a
     * move to the final primary, which is all that record knows.
     */
    const MOVE_FIELD = { capability: 'capabilityFrom', tiebreak: 'tiebrokeFrom', gate: 'gatedFrom', feedback: 'feedbackFrom' }
    const movesOf = (R) => (Array.isArray(R?.moves) ? R.moves : Object.entries(MOVE_FIELD).filter(([, f]) => R?.[f]).map(([kind, f]) => ({ kind, from: R[f], to: R.primaryAgent })))
    const moveNotes = (R) => movesOf(R).map((m) => (m.kind === 'capability' ? `${m.from} cannot do this (${R.capability ?? 'capability unclear'}): ${m.to} took the work`
      : m.kind === 'tiebreak' ? `${m.from} was barely ahead of ${m.to}, a near tie, and ${m.to} costs less at the margin: ${m.to} took the work`
        : m.kind === 'gate' ? `Work moved off ${m.from} (past its weekly gate) to ${m.to}`
          : m.kind === 'feedback' ? `Feedback moved the pick off ${m.from} to ${m.to}`
            : `Work moved from ${m.from} to ${m.to}`))

    // Who decided, by the provider's id (providers.js providerName): every string that names the
    // decider of a run or the provider of a call reads it here. A run or a call from before the
    // field was recorded was Jev's.
    const DECIDER_NAMES = { jev: 'Jev', laya: 'Laya' }
    const deciderName = (id) => DECIDER_NAMES[id ?? 'jev'] ?? String(id)
    /** Who decided a run: its routing's `decider`, else its decision record's (docs/laya-auto.md 3.2). */
    const deciderOf = (R) => R?.decider ?? R?.decision?.decider ?? 'jev'
    const wholePct = (n, of) => `${of ? Math.round((n / of) * 100) : 0}%`
    const PHASE_WORDS = { route: 'Routing', review: 'Review', intent: 'Intent' }
    const deviceWord = (device) => ({ cuda: 'GPU', gpu: 'GPU', cpu: 'CPU' })[device] ?? String(device)

    // The answers the rules stand in for when Laya's is too flat to use (4.3): those of a route call,
    // as adapter.js FILLED_BY_RULES names them for its live line (the page cannot import it), and
    // the review's agent picks (pickOther) and the intent's depth (the cheap default). Every other
    // flat answer is kept as answered and simply falls under its bar: a yes/no, the disposition, a
    // tool pick and its arguments. The second opinion is filled only on the judgments call, which
    // asks it for its own domain; the one a task-group call carries is the profile's, kept as answered.
    const FILLED_BY_RULES = new Set(['taskType', 'complexity', 'risk', 'skill', 'minimumCapability', 'preferredCapability', 'capability', 'strategy', 'reviewAgent', 'retryAgent', 'depth'])
    // The questions of the resource and judgments call; any other one makes a route call a task-group call.
    const RESOURCE_CALL = new Set(['strategy', 'secondOpinion'])
    /** Whether a route call asked the task group, as adapter.js and shadow.js groupsOf read it. */
    const taskGroupCall = (t) => t?.phase === 'route' && (t.questions ?? []).some((q) => !RESOURCE_CALL.has(q.name))
    /**
     * The pills an answer carries by its own marks, never by its question's name: Laya picks the
     * temperature bucket by option count, so any question asked with that many options can be
     * re-tempered, and none other is (4.3). A flat answer says whether the rules filled it or it
     * was kept as answered; `taskGroup` says the answer's call was a task-group route call.
     */
    const answerPills = (q, { taskGroup = false } = {}) => {
      const out = []
      if (q?.corrected === true) out.push(['warn', `uncalibrated (${Object.keys(q.probabilities ?? q.options ?? {}).length} options)`])
      if (q?.informative === false) {
        const filled = FILLED_BY_RULES.has(q.name) || String(q.name).startsWith('req.') || (q.name === 'secondOpinion' && !taskGroup)
        out.push(['warn', filled ? 'too flat, filled by rules' : 'too flat, kept as answered'])
      }
      return out
    }

    /**
     * One decider call as its card heads it (3.3). A call to a provider on this PC names the provider,
     * the model its client relabelled the answer with, and what it counted, at no cost, and it has no
     * request id to hand anyone; a Jev call is as it was, with the id TypeSafe support can act on.
     * Laya's client splits a call into one request per state view, and says when it waited for an
     * earlier answer, when a request reached the 512-token context and when the task is not English.
     */
    const callCard = (t) => {
      const local = !!t?.provider && t.provider !== 'jev'
      const n = t?.questions?.length ?? 0
      const requests = local ? t.meta?.requests ?? 1 : 1
      const onDevice = local && t.meta?.device ? ` on the ${deviceWord(t.meta.device)}` : ''
      const head = `${PHASE_WORDS[t?.phase] ?? t?.phase}: ${n} question${n === 1 ? '' : 's'} in ${requests === 1 ? 'one request' : `${requests} requests`}${onDevice}`
      const tokens = Number(t?.usage?.input_tokens ?? 0)
      const label = local
        ? `${deciderName(t.provider)} · ${t.model} · ${tokens.toLocaleString('en-US')} tokens on this PC ($0)`
        : `${t?.model} · ${t?.usage?.input_tokens ?? 0} in / ${t?.usage?.output_tokens ?? 0} out tokens`
      const notes = []
      if (local && t.meta?.waitedMs > 0) notes.push(`Waited ${Math.round(t.meta.waitedMs)} ms for an earlier ${deciderName(t.provider)} answer.`)
      if (local && t.meta?.atContextLimit > 0) notes.push(`${t.meta.atContextLimit} of ${requests} request${requests === 1 ? '' : 's'} reached the 512-token limit, so part of the evidence was cut.`)
      if (local && t.meta?.lang === 'non-latin') notes.push("Laya's English checkpoint is unreliable outside English.")
      return { head, label, requestId: local ? 'none (local)' : t?.requestId ?? 'none', notes }
    }
    /**
     * A call that did not answer (the live event `'decider-error'`): who, which call, how long and
     * why, and no questions. Its `error` is what createJev hands onError, `{ phase, callId, provider,
     * ms, error }`; the same fields on the event itself are read too, as adapter.js line() reads them.
     * A Laya call that timed out also says how many questions it asked and where, as the live line
     * and the report do (3.3).
     */
    const failedCall = (e) => {
      const x = e?.error ?? {}
      const of = (k) => x.error?.[k] ?? x[k] ?? e?.[k]
      const provider = x.provider ?? e?.provider ?? 'jev'
      const phase = x.phase ?? e?.phase ?? 'call'
      const questions = of('questions')
      const size = of('code') === 'LAYA_TIMEOUT' && Number.isInteger(questions) && of('device') ? ` (${questions} questions on the ${deviceWord(of('device'))})` : ''
      return {
        head: `${deciderName(provider)} · ${PHASE_WORDS[phase] ?? phase}`,
        text: `failed after ${Math.round(x.ms ?? e?.ms ?? 0)} ms: ${of('message') ?? 'no reason given'}${size}`,
      }
    }

    // What became of the Laya side of a Jev call in Jev Auto (5.6), by the shadow row's reason.
    const SHADOW_SKIPS = {
      not_running: 'skipped: Laya was not running',
      starting: 'skipped: Laya was starting',
      queue_full: 'skipped: Laya was busy',
      too_old: 'skipped: Laya was busy',
      yielded: 'skipped: Laya gave its memory to a local model',
      jev_failed: 'skipped: the Jev call failed',
    }
    /** Whether two answers agree, by the comparison's own rule (shadow-stats.js): the same pick, the same side of 0.5, the same level. */
    const shadowAgrees = (type, j, l) => (type === 'choice' ? j === l : type === 'noul' ? (j >= 0.5) === (l >= 0.5) : type === 'score' ? Math.round(j) === Math.round(l) : false)
    /**
     * Laya's answer as the column shows it: the pick and its probability, P(true) for a yes/no. A
     * tool parameter's pick is recorded as its option's index (`#1`, 5.3), and is shown as the option
     * it names, read through the question's own option keys (`keys`, in the order it asked them).
     */
    const shadowAnswer = (l, keys = null) => {
      if (l.type === 'noul') return pct(l.answer)
      if (l.type === 'score') return `${Number(l.answer).toFixed(2)} of ${(l.p?.length ?? 1) - 1} (${pct(l.confidence)})`
      const index = /^#(\d+)$/.exec(String(l.answer ?? ''))
      const pick = index && keys?.[Number(index[1])] !== undefined ? keys[Number(index[1])] : l.answer
      return `${pick ?? 'no answer'} (${pct(l.confidence)})`
    }
    const shadowMarkOf = (row) => (row.status === 'skipped' ? SHADOW_SKIPS[row.reason] ?? `skipped: ${String(row.reason).replace(/_/g, ' ')}` : 'failed')
    /**
     * The Laya column of one question of a Jev call (5.6): Laya's answer beside Jev's, and whether
     * the two agree, from the shadow row of that call (5.3), which holds both sides as recorded.
     * No row yet is `waiting for Laya` only while one can still land (`waiting`); otherwise the
     * question has no Laya column at all. A row that was skipped or failed marks every question.
     * `keys` are the question's option keys, for a tool parameter recorded by index.
     */
    const shadowCell = (name, row, { waiting = false, keys = null } = {}) => {
      if (!row) return waiting ? { text: null, mark: 'waiting for Laya' } : null
      if (row.status === 'skipped' || row.status === 'failed') return { text: null, mark: shadowMarkOf(row) }
      const l = row.laya?.questions?.[name]
      // A partial row is one whose remaining chunks waited too long behind acting calls.
      if (!l) return { text: null, mark: row.status === 'partial' ? SHADOW_SKIPS.too_old : 'failed' }
      const j = row.jev?.questions?.[name]
      return { text: shadowAnswer(l, keys), mark: j && j.type === l.type ? (shadowAgrees(l.type, j.answer, l.answer) ? 'agrees' : 'differs') : null, flat: l.informative === false }
    }
    /**
     * The shadow's header on a Jev call's card (5.6): how many of its questions Laya answered and
     * how many of those agree, and, for a review, the action each side's answers give under its own
     * thresholds, when the row carries them.
     */
    const shadowHeader = (names, row, { waiting = false } = {}) => {
      if (!row) return waiting ? ['Laya shadow: waiting for Laya. Laya decides nothing in Jev Auto.'] : []
      if (row.status === 'skipped' || row.status === 'failed') return [`Laya shadow: ${shadowMarkOf(row)}. Laya decides nothing in Jev Auto.`]
      let answered = 0
      let agree = 0
      for (const name of names) {
        const cell = shadowCell(name, row)
        if (!cell?.text) continue
        answered++
        if (cell.mark === 'agrees') agree++
      }
      const out = [`Laya shadow: ${answered} of ${names.length} questions answered, ${agree} agree (${wholePct(agree, answered)}). Laya decides nothing in Jev Auto.`]
      if (row.phase === 'review' && row.actions?.jev && row.actions?.laya) out.push(`Review action: Jev ${row.actions.jev}, Laya ${row.actions.laya}.`)
      return out
    }

    // ---- the Router tab's side-by-side card, from GET /jev-router/laya/compare (8.4)
    /**
     * A share's 95% interval as the comparison gives it beside the share (shadow-stats.js interval),
     * `range 45 to 78%`, or '' when it gives none: a share of a few rows is a wide range, not a figure.
     */
    const rangeWords = (iv) => (Number.isFinite(iv?.low) && Number.isFinite(iv?.high) ? `range ${Math.round(iv.low * 100)} to ${Math.round(iv.high * 100)}%` : '')
    /** A count and its rate, `{ n, agree }`, with its range when the comparison gives one; a source with no rows says so and never shows a rate. */
    const cmpAgree = (x, iv) => (x?.n ? `${x.agree} of ${x.n} (${[wholePct(x.agree, x.n), rangeWords(iv)].filter(Boolean).join(', ')})` : 'none yet')
    const cmpWords = (id) => String(id).replace(/_/g, ' ')
    /** The subtitle's checkpoint, weights and adapter, read from the identity string (4.5). */
    const identityWords = (identity) => {
      const [, checkpoint, commit, adapter] = String(identity ?? '').split('|')
      if (!checkpoint || !commit) return 'Every checkpoint, weights and adapter recorded.'
      return `Checkpoint ${checkpoint}, weights ${commit.slice(0, 7)}, adapter ${String(adapter ?? '').replace(/^adapter-/, '') || 'unknown'}.`
    }
    const COMPARE_SKIPS = [['not_running', 'not running'], ['starting', 'starting'], ['queue_full', 'queue full'], ['too_old', 'waited too long'], ['yielded', 'gave way to a local model'], ['jev_failed', 'Jev call failed']]
    const skipsLine = (k) => `Skipped: ${COMPARE_SKIPS.map(([key, w]) => `${k?.skipped?.[key] ?? 0} ${w}`).join(', ')}; ${k?.failed ?? 0} failed.`
    const latencyLine = (l) => {
      const side = (x) => ['intent', 'route', 'review'].map((p) => `${p} ${typeof x?.[p] === 'number' ? `${x[p]} ms` : 'not measured'}`).join(', ')
      return `Median answer time: Jev ${side(l?.jev)}; Laya ${side(l?.laya)}.`
    }
    const ACTED_WORDS = { task_type: 'Task type', capability: 'Capability', strategy: 'Strategy', second_opinion: 'Second opinion', checks_required: 'Checks required', needs_human: 'Stop for a person', review_action: 'Review action' }
    /** "Would it have acted the same" (5.5), and the review actions each provider's own accept bar stopped. */
    const actedLines = (a) => [
      ...(a?.wouldHaveActedSame ?? []).map((w) => `${ACTED_WORDS[w.what] ?? cmpWords(w.what)}: ${w.n ? `the same in ${w.same} of ${w.n} (${wholePct(w.same, w.n)})` : 'none compared yet'}`),
      ...['jev', 'laya'].filter((p) => a?.review?.[p]).map((p) => {
        const r = a.review[p]
        return `Review actions, ${deciderName(p)}: accept ${r.accept ?? 0}, second review ${r.second_review ?? 0}, human ${r.human ?? 0}, retry ${r.retry ?? 0}; ${r.belowAcceptBar ?? 0} stopped under ${deciderName(p)}'s accept bar`
      }),
    ]
    // ---- end pure display helpers
    const AUTHORITY = {
      local: ['ok', 'local router'],
      code: ['ok', 'routing rules'],
      jev: ['', 'Jev'],
      laya: ['', 'Laya'],
      fallback: ['warn', 'safe fallback'],
      none: ['', 'not asked'],
    }

    /**
     * What the adaptive router decided and why: which routing domain was answered by whom, the
     * anonymous candidates with the capability evidence and scarcity they were judged on, what
     * was excluded before any judgment, and the strategy that came out of it.
     */
    function RoutingDecision({ s }) {
      const R = s.routed?.routing
      const d = R?.decision
      if (!d) return null
      const pill = (tone, text, title) => h('span', { className: cx('pill', tone), title }, text)
      const domainRows = Object.entries(d.domains ?? {}).map(([id, v]) => {
        const [tone, who] = AUTHORITY[v.authority] ?? ['', v.authority]
        return h('li', { key: id },
          h('div', null,
            h('b', null, id.replace(/_/g, ' ')),
            pill(tone, who),
            v.maturity ? pill('', v.maturity.replace(/_/g, ' ').toLowerCase()) : null,
            v.confidence != null ? pill(v.requiredConfidence != null && v.confidence < v.requiredConfidence ? 'warn' : 'ok', `${pct(v.confidence)}${v.requiredConfidence != null ? ` of ${pct(v.requiredConfidence)} needed` : ''}`) : null,
            v.ood?.flag ? pill('warn', 'out of distribution') : null),
          h('div', { className: 'why' }, v.label ? `→ ${v.label}. ` : '', v.reason ?? ''),
          v.local && v.teacher && (v.local.label ?? v.local.chosenKey) !== (v.teacher.label ?? v.teacher.chosenKey)
            ? h('div', { className: 'why' }, `shadow: the local router would have said ${v.local.label ?? v.local.chosenKey} (${pct(v.local.confidence)})`)
            : null)
      })
      const candidates = (d.candidates ?? []).map((c) => {
        const caps = Object.entries(c.capabilities ?? {}).map(([dim, v]) => `${dim.replace(/_/g, ' ')} ${pct(v.score)} (${evidenceNote(v.confidence)}${v.samples ? `, ${v.samples} runs` : ''})`)
        return h('li', { key: c.key },
          h('div', null,
            h('b', null, c.key), h('code', { style: { marginLeft: 6 } }, c.id),
            pill(c.id === R.primaryAgent ? 'ok' : '', c.tier),
            pill('', c.source),
            c.cold ? pill('warn', 'new, little evidence') : null),
          h('div', { className: 'why' },
            `fit ${pct(c.fit)} · scarcity ${c.scarcity == null ? 'unknown' : pct(c.scarcity)}`,
            c.resetInMinutes != null ? ` (resets in ${Math.round(c.resetInMinutes)} min)` : '',
            ` · expected cost ${c.expectedCost?.class ?? 'unknown'} · ${c.latency}`,
            c.plan ? ` · ${c.plan} plan` : '',
            ` · ${c.evidenceSamples ?? 0} verified runs behind its profile`),
          caps.length ? h('div', { className: 'why' }, caps.join(' · ')) : null)
      })
      const p = d.plan ?? {}
      const extras = [p.steps?.some((x) => x.role === 'plan') ? `plan by ${p.steps.find((x) => x.role === 'plan').agent}` : '', p.reviewer ? `review by ${p.reviewer}` : '', p.parallelWith ? `second opinion from ${p.parallelWith}` : ''].filter(Boolean)
      return h('div', { className: 'card' },
        h('div', { className: 'label' }, 'How the router decided'),
        h('div', null,
          // The calls are counted to whoever decided the run (3.3): `2 Laya calls`.
          h('span', { className: cx('badge', d.jevCalls ? 'agent' : 'tool') }, d.jevCalls ? `${d.jevCalls} ${deciderName(d.decider ?? R.decider)} call${d.jevCalls === 1 ? '' : 's'}` : `no ${deciderName(d.decider ?? R.decider)} call`),
          `${R.strategy ?? 'STANDARD_DIRECT'}${extras.length ? ` (${extras.join(', ')})` : ''}`),
        p.notes?.length ? h('div', { className: 'why' }, p.notes.join('; ')) : null,
        ...gateNotes(R).map((t, i) => h('div', { className: 'why', key: `gate${i}` }, t)),
        d.belowFloor ? h('div', { className: 'why' }, `nothing meets the ${d.minimumCapability} bar this task asks for; the strongest available reviews`) : null,
        domainRows.length ? h('div', { style: { marginTop: 10 } }, h('div', { className: 'label' }, 'Who decided what'), h('ul', { className: 'plain' }, ...domainRows)) : null,
        candidates.length ? h('div', { style: { marginTop: 10 } }, h('div', { className: 'label' }, 'Candidates, as the router saw them'), h('ul', { className: 'plain' }, ...candidates)) : null,
        d.excluded?.length
          ? h('div', { style: { marginTop: 10 } }, h('div', { className: 'label' }, 'Not offered'),
            h('ul', { className: 'plain' }, ...d.excluded.map((e) => h('li', { key: e.id }, h('code', null, e.id), h('span', { className: 'why' }, ` ${e.reason}`)))))
          : null)
    }

    /** The adaptive router's own state: GET /jev-router/routing, refreshed while the tab is open. */
    function useRouting(visible, every = 10_000) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        setBusy(true)
        try { setData(await api('/jev-router/routing')); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) }
      }, [])
      useEffect(() => {
        if (!visible) return
        let stop = false
        let timer
        const tick = async () => { if (!stop) await load(); if (!stop) timer = setTimeout(tick, every) }
        tick()
        return () => { stop = true; clearTimeout(timer) }
      }, [visible, every, load])
      return { data, error, busy, load }
    }

    const MATURITY_TONE = { JEV_PRIMARY: '', SHADOW: '', GUARDED_LOCAL: 'warn', LOCAL_ONLY: 'ok', ROLLBACK: 'bad' }
    const MATURITY_WORDS = {
      JEV_PRIMARY: 'Jev decides; the local router is not trained yet',
      SHADOW: 'Jev decides; the local router predicts alongside it and is being scored',
      GUARDED_LOCAL: 'the local router decides when it is confident and the case is familiar',
      LOCAL_ONLY: 'the local router decides normal cases with no Jev call',
      ROLLBACK: 'local authority suspended; Jev decides until it is earned back',
    }
    // The same rungs for a domain a rule in code decides instead of Jev (`teacher: 'code'`).
    const CODE_MATURITY_WORDS = {
      JEV_PRIMARY: 'a rule in code decides; the local router is not trained yet',
      SHADOW: 'a rule in code decides; the local router predicts alongside it and is being scored',
      GUARDED_LOCAL: 'the local router decides when it is confident and the case is familiar; a rule in code decides the rest',
      LOCAL_ONLY: 'the local router decides normal cases; a rule in code decides the rest',
      ROLLBACK: 'local authority suspended; a rule in code decides until it is earned back',
    }
    /**
     * What a domain's rung means for who decides. A domain whose local classifier never decides
     * (`localDecides: false` in routing-policy.js, the resource ranking's case) still climbs the
     * ladder, because its standing is measured, but the rung buys it nothing, so the words for
     * the rung would promise an authority it never gets. A domain a rule in code decides
     * (`teacher: 'code'`, the frontier review's case) asks Jev nothing, so the rungs Jev holds
     * elsewhere are the rule's there.
     */
    const maturityWords = (d) => (d?.localDecides === false
      ? `${d?.teacher === 'code' ? 'a rule in code decides' : 'Jev decides'} at every rung; the local router is recorded beside it for comparison and never decides`
      : `${(d?.teacher === 'code' ? CODE_MATURITY_WORDS : MATURITY_WORDS)[d?.maturity] ?? ''}${onlyAnswers(d)}`)
    // A domain whose local router may decide only some answers (`localLabels`, the message intent's
    // case: only that a message is a task) is decided by its teacher on every other answer, at the
    // rungs where the local router decides at all.
    const onlyAnswers = (d) => (Array.isArray(d?.localLabels) && (d.maturity === 'GUARDED_LOCAL' || d.maturity === 'LOCAL_ONLY')
      ? `, and only when it answers ${d.localLabels.join(' or ')}: ${d.teacher === 'code' ? 'a rule in code decides' : 'Jev decides'} every other answer`
      : '')

    /**
     * The comparison of Jev and Laya over the last 7 days, for the current Laya identity (8.4):
     * computed on the server in a worker and cached there for a minute, so it is read once a minute
     * while the Router tab is open. A PC where Laya cannot be asked and nothing was ever compared
     * answers 404, and the card then shows nothing; any other failure is said where the card would be.
     */
    function useLayaCompare(visible, every = 60_000) {
      const [state, setState] = useState({ data: null, error: '' })
      useEffect(() => {
        if (!visible) return
        let stop = false
        let timer
        const tick = async () => {
          try { const d = await api('/jev-router/laya/compare?days=7&identity=current'); if (!stop) setState({ data: d, error: '' }) } catch (e) { if (!stop) setState({ data: null, error: e.status === 404 ? '' : e.message }) }
          if (!stop) timer = setTimeout(tick, every)
        }
        tick()
        return () => { stop = true; clearTimeout(timer) }
      }, [visible, every])
      return state
    }

    /**
     * Jev and Laya, side by side (5.6): what Laya answered in the background in Jev Auto and what
     * came of the runs Laya decided in Laya Auto, from the comparison of 8.4. Every figure is shown
     * with its count, a source with no rows says so, and agreement is never called accuracy: only
     * what a person said is, and each column says what it can judge.
     */
    function LayaCompare({ data }) {
      if (!data) return null
      const table = (heads, rows) => h('table', { className: 'cmp' },
        h('thead', null, h('tr', null, ...heads.map((t) => h('th', { key: t, scope: 'col' }, t)))),
        h('tbody', null, ...rows))
      const cell = (x) => h('td', null, x)
      // A share's range follows its count, when the comparison gives one (`intervals`).
      const ranged = (text, ...ivs) => { const r = ivs.map(rangeWords); return r.every(Boolean) ? `${text} (${r.join(' / ')})` : text }
      const person = (p, iv) => (p?.n ? ranged(`${p.jevRight} / ${p.layaRight} of ${p.n}`, iv?.jevRight, iv?.layaRight) : 'none yet')
      const contradicted = (c, iv) => (c?.n ? ranged(`${c.layaRight} of ${c.n}`, iv?.contradicted) : 'none yet')
      // A domain no outcome of a run can fault (the task type, the skill) says so, never 0 failed.
      const failedRuns = (r, iv) => (!r?.runs ? 'none yet' : r.failed == null ? `not measured (${r.runs} ${r.runs === 1 ? 'run' : 'runs'})` : ranged(`${r.failed} of ${r.runs}`, iv?.failed))
      const domains = (data.domains ?? []).map((d) => h('tr', { key: d.domain },
        h('th', { scope: 'row' }, cmpWords(d.domain)), cell(String(d.layaAnswered ?? 0)), cell(cmpAgree(d.agree?.informative, d.intervals?.agree)),
        cell(person(d.personSaid, d.intervals)), cell(contradicted(d.whereJevWasContradicted, d.intervals)), cell(failedRuns(d.layaAutoRuns, d.intervals))))
      const fields = (data.domains ?? []).filter((d) => d.fieldAgreement && Object.keys(d.fieldAgreement).length)
      const questions = (data.questions ?? []).map((q) => h('tr', { key: q.name },
        h('th', { scope: 'row' }, h('code', null, q.name), q.corrected ? h('span', { className: 'pill warn' }, `uncalibrated (${q.options} options)`) : null),
        cell(String(q.compared ?? 0)), cell(cmpAgree(q.agree?.all, q.intervals?.all)), cell(cmpAgree(q.agree?.informative, q.intervals?.informative)),
        cell(typeof q.meanDifference === 'number' ? q.meanDifference.toFixed(2) : '-'), cell(typeof q.layaMedianMs === 'number' ? `${q.layaMedianMs} ms` : '-')))
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-cmp-h' },
        h('div', { className: 'label', id: 'jevi-cmp-h' }, 'Jev and Laya, side by side'),
        h('div', { className: 'why', style: { margin: '0 0 8px' } }, `From the calls Laya answered in the background in Jev Auto, and the runs Laya decided in Laya Auto. ${identityWords(data.identity)} Agreement is not accuracy, and outcomes are counted only where they can judge: see each column.`),
        table(['Domain', 'Laya answered', 'Agrees with Jev (informative only)', 'A person said (Jev right / Laya right)', "Where Jev's pick was contradicted (Laya had it right)", 'Laya Auto runs that failed'], domains),
        h('div', { className: 'why', style: { marginTop: 4 } }, "A person said: the rows a person labelled, the least biased. Where Jev's pick was contradicted: rows that exist only because Jev's pick went wrong, so they say how often Laya would have had it right there, never Laya's accuracy. Laya Auto runs that failed: a failure rate of the runs Laya decided, never an accuracy; a review counts as failed only when the person disliked what it accepted or another agent's review did not accept it, and a task type or a skill is judged only by what a person said, so it is not measured there. A range beside a share is its 95% interval: how far a longer record could still put it."),
        ...fields.map((d) => h('div', { className: 'why', key: `f${d.domain}` }, `${cmpWords(d.domain)}, profile fields that agree with Jev: ${Object.entries(d.fieldAgreement).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}`)),
        table(['Question', 'Compared', 'Agree', 'Agree, informative only', 'Mean difference', 'Laya median ms'], questions),
        h('div', { className: 'label', style: { margin: '10px 0 4px' } }, 'Would it have acted the same'),
        ...actedLines(data.actions).map((t, i) => h('div', { className: 'why', key: `a${i}` }, t)),
        h('div', { className: 'why', style: { marginTop: 8 } }, skipsLine(data.skips)),
        h('div', { className: 'why' }, latencyLine(data.latency)))
    }

    // ---------- tables with a sort and a filter on every column (docs/handoff.md, the table rule) ----------
    // A table is `columns` of { key, label } and `rows` of cells, one { text, value } per column: the
    // text is what the cell shows and what a filter reads, the value what a sort reads. A value of
    // null is a blank.

    /** What a sort reads of a cell: its value when it has one, else its text. */
    const sortKeyOf = (cell) => (cell && Object.hasOwn(cell, 'value') ? cell.value : cell?.text)
    const isBlank = (v) => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v))

    /**
     * `rows` sorted by column `col`, 'asc' or 'desc'; with no column or direction, as they came.
     * Numbers sort as numbers and text as text, a blank goes last either way, and rows that compare
     * equal keep their order.
     */
    function sortRows(rows, col, dir) {
      if (col == null || !dir) return rows.slice()
      const compare = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }))
      return rows.map((row, i) => [row, i]).sort(([ra, ia], [rb, ib]) => {
        const a = sortKeyOf(ra[col])
        const b = sortKeyOf(rb[col])
        if (isBlank(a) || isBlank(b)) return isBlank(a) === isBlank(b) ? ia - ib : isBlank(a) ? 1 : -1
        const c = compare(a, b)
        return (dir === 'desc' ? -c : c) || ia - ib
      }).map(([row]) => row)
    }

    /** The rows whose cell shows the filter's text in every column that has one, whatever its case. */
    function filterRows(rows, filters) {
      const active = Object.entries(filters ?? {}).map(([col, f]) => [Number(col), String(f ?? '').trim().toLowerCase()]).filter(([, f]) => f)
      return rows.filter((row) => active.every(([col, f]) => String(row[col]?.text ?? '').toLowerCase().includes(f)))
    }

    /**
     * Any table under the table rule: a sort toggle on every column header (none, ascending,
     * descending, said by aria-sort) and a filter field under every header, all filters together.
     * The table scrolls within a height of its own, so its scroll bars stay in view, and a column
     * marked `clamp` shows at most three lines of a cell, with the whole of it as the cell's title.
     */
    function SortTable({ label, columns, rows, empty = 'Nothing yet.' }) {
      const [sort, setSort] = useState({ col: null, dir: null })
      const [filters, setFilters] = useState({})
      const shown = sortRows(filterRows(rows ?? [], filters ?? {}), sort?.col ?? null, sort?.dir ?? null)
      const next = (i) => setSort((s) => (s.col !== i ? { col: i, dir: 'asc' } : s.dir === 'asc' ? { col: i, dir: 'desc' } : { col: null, dir: null }))
      const ariaSort = (i) => (sort?.col === i ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
      return h('table', { className: 'cmp sortable', 'aria-label': label },
        h('thead', null,
          h('tr', null, ...columns.map((c, i) => h('th', { key: c.key, scope: 'col', 'aria-sort': ariaSort(i) },
            h('button', { type: 'button', className: 'sorter', title: `Sort by ${c.label}`, onClick: () => next(i) }, c.label, ariaSort(i) === 'ascending' ? ' ▲' : ariaSort(i) === 'descending' ? ' ▼' : '')))),
          h('tr', null, ...columns.map((c, i) => h('th', { key: `${c.key}-filter` },
            h('input', { type: 'search', className: 'filter', placeholder: 'Filter', 'aria-label': `Filter ${c.label}`, value: filters?.[i] ?? '', onChange: (e) => setFilters((f) => ({ ...f, [i]: e.target.value })) }))))),
        h('tbody', null, ...(shown.length
          ? shown.map((row, k) => h('tr', { key: k }, ...columns.map((c, i) => (c.clamp
            ? h('td', { key: c.key, title: row[i]?.text ?? '' }, h('div', { className: 'clamp' }, row[i]?.text ?? ''))
            : h('td', { key: c.key }, row[i]?.text ?? '')))))
          : [h('tr', { key: 'none' }, h('td', { colSpan: columns.length, className: 'muted' }, (rows ?? []).length ? 'No row matches the filters.' : empty))])))
    }

    // ---------- the capability benchmark (docs/benchmark.md 3.11) ----------

    const BENCH_DIMENSION_COLUMNS = [
      { key: 'agent', label: 'Agent' }, { key: 'model', label: 'Model' }, { key: 'dimension', label: 'Dimension' },
      { key: 'benchmark', label: 'Benchmark' }, { key: 'weight', label: 'Weight' }, { key: 'prior', label: 'Prior' },
      { key: 'now', label: 'Profile now' }, { key: 'skills', label: 'Skills' }, { key: 'run', label: 'Run' },
    ]
    // What came of a task beside the task, so the narrow inspector shows it first; a long why is clamped.
    const BENCH_TASK_COLUMNS = [
      { key: 'agent', label: 'Agent' }, { key: 'task', label: 'Task' }, { key: 'outcome', label: 'Outcome' }, { key: 'why', label: 'Why', clamp: true },
      { key: 'skill', label: 'Skill' }, { key: 'level', label: 'Level' }, { key: 'time', label: 'Time' }, { key: 'tokens', label: 'Tokens' },
      { key: 'effort', label: 'Effort' }, { key: 'run', label: 'Run' },
    ]
    /** How long something has been running, in words. */
    const elapsedText = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

    /**
     * One agent's line while the benchmark runs (3.11): how far it is, what came of its tasks, the
     * task under way with its time or the lanes' waiting line, and when its queue has ended, how.
     */
    function benchmarkProgress(a, now = Date.now()) {
      const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`)
      if (a.status === 'waiting') return `${a.id}: waits for its turn.`
      // Nothing was run on it: its line says why, and there is nothing to count.
      if (a.status === 'not_run' || a.status === 'too_small') return sentence(a.line ?? `${a.id} was not run`)
      const counts = [`${a.passed} passed`, `${a.failed} failed`, ...(a.timedOut ? [`${a.timedOut} timed out`] : [])].join(', ')
      const more = [a.reruns ? `${a.reruns} run again after an error` : '', a.didNotFit ? `${a.didNotFit} did not fit` : ''].filter(Boolean).join('; ')
      // The first, one-file task is not scored: how it went is said apart from the scored tasks counted.
      const first = a.first ? `first task ${{ passed: 'passed', failed: 'failed', timed_out: 'timed out', errored: 'errored', not_scored: 'not scored' }[a.first] ?? a.first}; ` : ''
      const head = `${a.id}: ${first}${a.done} of ${a.total}: ${counts}${more ? `; ${more}` : ''}.`
      // Between tasks the runner may be reading the agent's usage, which may take seconds: its phase says so.
      const between = a.phase === 'spend-before' ? 'Reading its usage before it starts.' : a.phase === 'spend-after' ? 'Reading what it spent.' : 'Starting.'
      if (a.status === 'running') return `${head} ${a.task ? sentence(a.task.waiting ?? `Running ${a.task.id}, ${elapsedText(now - a.task.startedAt)}`) : between}`
      return a.line ? `${head} ${sentence(a.line)}` : head
    }

    /** The benchmark's state, read every 5 seconds, and every 2 while a run goes. */
    function useBenchmark(sessionId, visible) {
      const [state, setState] = useState({ data: null, error: '' })
      const [asked, setAsked] = useState(0)
      useEffect(() => {
        if (!visible) return undefined
        let stop = false
        let timer
        const read = async () => {
          let running = false
          try {
            const d = await api(`/jev-router/benchmark${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`)
            running = !!d.run
            if (!stop) setState({ data: d, error: '' })
          } catch (e) { if (!stop) setState((s) => ({ data: s.data, error: e.message })) }
          if (!stop) timer = setTimeout(read, running ? 2000 : 5000)
        }
        read()
        return () => { stop = true; clearTimeout(timer) }
      }, [sessionId, visible, asked])
      return { ...state, reload: () => setAsked((n) => n + 1) }
    }

    /**
     * The Capability benchmark card of the Router tab (3.11): what it is, where it runs, the agents to
     * pick with what a run on each would spend, a confirmation the server writes, the run's progress
     * with Stop, and the results. Nothing is ever picked for the person.
     */
    function BenchmarkCard({ sessionId, visible = true, now = Date.now() }) {
      const { data, error, reload } = useBenchmark(sessionId, visible)
      const [picked, setPicked] = useState([])
      const [confirm, setConfirm] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const title = h('div', { className: 'label', id: 'jevi-bench-h' }, 'Capability benchmark')
      if (!data) return h('section', { className: 'card', 'aria-labelledby': 'jevi-bench-h' }, title, h('div', { className: error ? 'err' : 'muted', role: error ? 'alert' : undefined }, error || 'Reading the benchmark…'))
      const chosen = (picked ?? []).filter((id) => data.agents.some((a) => a.id === id && a.can))
      const run = data.run
      const act = async (fn) => {
        setMsg(''); setBusy(true)
        try { await fn() } catch (e) { setMsg(e.message) } finally { setBusy(false); reload() }
      }
      const toggle = (id, on) => setPicked((p) => (on ? [...new Set([...(p ?? []), id])] : (p ?? []).filter((x) => x !== id)))
      const askToRun = () => act(async () => {
        const plan = await post('/jev-router/benchmark/plan', { session: sessionId, agents: chosen })
        setConfirm({
          ...plan.confirm,
          run: () => act(async () => { await post('/jev-router/benchmark/start', { session: sessionId, agents: chosen, planId: plan.planId }); setPicked([]) }),
        })
      })
      const askToStop = () => setConfirm({
        title: 'Stop the benchmark?',
        body: 'The task under way is stopped. Every agent that has not finished all its tasks records nothing; agents that finished keep what they recorded.',
        confirmLabel: 'Stop',
        run: () => act(() => post('/jev-router/benchmark/stop', {})),
      })
      // Only from the scratch workspace, with a pick, while nothing runs and the task set on disk is the version it says.
      const canRun = data.where?.state === 'scratch' && data.taskSet?.digestOk !== false && chosen.length > 0 && !run && !busy
      const pick = (a) => h('li', { key: a.id, style: { display: 'block' } },
        h('label', { className: 'toggle', title: a.can ? undefined : a.why },
          h('input', { type: 'checkbox', checked: chosen.includes(a.id), disabled: !a.can || !!run, 'aria-label': `Pick ${a.id}`, onChange: (e) => toggle(a.id, e.target.checked) }),
          h('b', null, a.id), h('span', { className: 'pill' }, a.kindText), h('code', { style: { marginLeft: 6 } }, a.subject)),
        a.can ? null : h('div', { className: 'err' }, a.why),
        ...(a.estimate ?? []).map((t, i) => h('div', { className: 'why', key: `e${i}` }, t)),
        ...(a.warnings ?? []).map((t, i) => h('div', { className: 'warnline', key: `w${i}` }, t)),
        a.lastRun ? h('div', { className: 'why' }, `Last run ${a.lastRun.day}, version ${a.lastRun.version ?? '?'}${a.lastRun.older ? ', older than the task set' : ''}: ${a.lastRun.statusText}.`) : null)
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-bench-h' },
        title,
        h('p', { className: 'why', style: { margin: '0 0 8px' } }, data.what),
        h('div', { className: data.where?.state === 'scratch' ? 'why' : data.where?.state === 'in_git' ? 'err' : 'warnline' }, data.where?.text),
        data.where?.accountText ? h('div', { className: 'warnline' }, data.where.accountText) : null,
        data.taskSet && !data.taskSet.digestOk ? h('div', { className: 'err' }, `The task set on disk no longer matches version ${data.taskSet.version}; nothing can be run until it does.`) : null,
        h('div', { className: 'label', style: { margin: '10px 0 4px' } }, 'Agents'),
        data.agents.length ? h('ul', { className: 'plain' }, ...data.agents.map(pick)) : h('div', { className: 'muted' }, 'No agent is switched on.'),
        h('div', { className: 'head', style: { marginTop: 8 } },
          h('button', { className: 'btn primary', disabled: !canRun, onClick: askToRun }, `Run on ${chosen.length} agent${chosen.length === 1 ? '' : 's'}`),
          run ? h('button', { className: 'btn danger', disabled: busy || run.stopping, onClick: askToStop }, run.stopping ? 'Stopping…' : 'Stop') : null),
        msg ? h('div', { className: 'err', role: 'alert' }, msg) : null,
        error ? h('div', { className: 'err', role: 'alert' }, `The benchmark could not be read: ${error}`) : null,
        run ? h('div', { role: 'status', 'aria-label': 'Benchmark progress', style: { marginTop: 8 } }, ...run.agents.map((a) => h('div', { key: a.id, className: 'why' }, benchmarkProgress(a, now)))) : null,
        !run && data.last ? h('div', { role: 'status', 'aria-label': 'Last benchmark', style: { marginTop: 8 } },
          // A run that ended any other way (its log could not be written, the task set changed under
          // it) ended early, and its lines say why.
          h('div', { className: 'why' }, `The last run ${{ interrupted: 'was interrupted: KzH stopped before it ended, and every agent that had not finished records nothing.', stopped: 'was stopped.', finished: 'finished.' }[data.last.status] ?? 'ended early, and every agent that had not finished records nothing.'}`),
          ...(data.last.lines ?? []).map((t, i) => h('div', { key: i, className: 'why' }, t))) : null,
        h('div', { className: 'label', style: { margin: '10px 0 4px' } }, 'Results by dimension'),
        h(SortTable, { label: 'Benchmark results by dimension', columns: BENCH_DIMENSION_COLUMNS, rows: data.results?.dimensions ?? [], empty: 'No agent has finished a run yet.' }),
        h('div', { className: 'label', style: { margin: '10px 0 4px' } }, 'Tasks'),
        h(SortTable, { label: 'Benchmark tasks', columns: BENCH_TASK_COLUMNS, rows: data.results?.tasks ?? [], empty: 'No task has run yet.' }),
        h('div', { className: 'why', style: { marginTop: 6 } }, data.note),
        confirm ? h(Confirm, { title: confirm.title, body: confirm.body, confirmLabel: confirm.confirmLabel, onCancel: () => setConfirm(null), onConfirm: () => { const c = confirm; setConfirm(null); c.run() } }) : null)
    }

    /**
     * The Router view: how far each routing domain has matured, what is blocking the next step,
     * and what the capability registry currently believes about each resource and on what
     * evidence. This is the tab that answers "why did it pick that, and who decided". `laya` is
     * the comparison of Jev and Laya (useLayaCompare), shown under the domains when there is one.
     * The Capability benchmark card of the chat `sessionId` follows what each resource is believed
     * to be good at (docs/benchmark.md 3.11); `visible` is whether the tab is shown, and the card
     * reads the benchmark only then, as the tab's other reads do.
     */
    function RouterView({ data, error, busy, onRefresh, laya = null, sessionId = null, visible = true }) {
      if (error) return h('div', { className: 'err', role: 'alert' }, error)
      if (!data) return h('div', { className: 'empty' }, busy ? 'Reading the router…' : 'No routing state yet.')
      if (!data.enabled) return h('div', { className: 'empty' }, 'Adaptive routing is switched off in the config; Jev routes every task.')
      const pill = (tone, text, title) => h('span', { className: cx('pill', tone), title }, text)
      const domains = Object.entries(data.domains ?? {}).map(([id, d]) => {
        const gates = d.progress?.gates ?? []
        const done = gates.filter((g) => g.ok).length
        return h('details', { className: 'q', key: id },
          h('summary', null,
            h('div', null, h('b', null, id.replace(/_/g, ' ')), pill(MATURITY_TONE[d.maturity] ?? '', d.maturity.replace(/_/g, ' ').toLowerCase()), pill('', `${d.riskClass.toLowerCase()} risk`)),
            h('div', { className: 'ans' }, d.progress?.next ? `${done}/${gates.length} toward ${d.progress.next.replace(/_/g, ' ').toLowerCase()}` : 'fully matured')),
          h('div', { className: 'muted', style: { margin: '6px 0' } }, maturityWords(d)),
          h('div', { className: 'why' },
            `${d.samples?.verified ?? 0} verified samples`,
            d.samples?.outcomeBacked != null ? `, ${d.samples.outcomeBacked} proved by a run or a person` : '',
            d.artifact ? `, classifier ${d.artifact.sampleCount} samples` : d.artifactReason ? `, no classifier (${d.artifactReason})` : ''),
          d.rollbackReason ? h('div', { className: 'err' }, `Rolled back (${d.rollbackSeverity}): ${d.rollbackReason}`) : null,
          gates.length
            ? h('ul', { className: 'plain' }, ...gates.map((g) => h('li', { key: g.name },
              pill(g.ok ? 'ok' : 'warn', g.ok ? 'met' : 'not yet'),
              ` ${g.name}: ${g.actual ?? 'unknown'} ${g.atMost ? 'against a ceiling of' : 'against'} ${g.required}`)))
            : null,
          d.lastEvaluation?.drift ? h('div', { className: 'why' }, `drift: ${d.lastEvaluation.drift.level}${d.lastEvaluation.drift.worst ? ` (worst ${d.lastEvaluation.drift.worst.feature} at ${d.lastEvaluation.drift.worst.value})` : ''}`) : null,
          typeof d.oodRate === 'number' ? h('div', { className: 'why' }, `${pct(d.oodRate)} of recent decisions were unfamiliar`) : null)
      })
      const resources = (data.resources ?? []).map((r) => h('li', { key: r.id },
        h('div', null, h('b', null, r.id), pill('', r.source), r.plan?.name ? pill('', r.plan.name) : null,
          r.availability?.state && r.availability.state !== 'ok' ? pill('warn', r.availability.state) : null,
          r.stale ? pill('warn', 'stale reading') : null),
        h('div', { className: 'why' },
          // Every figure carries its own provenance. The snapshot's usageSource and confidence are
          // its best limit's measured figure, so printing them once for the whole line put an
          // estimated share spent under the provider's name and its "well evidenced".
          r.limits?.length ? r.limits.map(limitText).join(' · ') : `no limits reported (${provenanceNote({ source: r.usageSource ?? 'unknown', confidence: r.confidence })})`,
          r.governor?.scarcity != null ? ` · scarcity ${pct(r.governor.scarcity)} (${evidenceNote(r.governor.scarcityConfidence ?? 0)})` : ' · scarcity unknown'),
        r.availability?.reason ? h('div', { className: 'why' }, r.availability.reason) : null))
      const profiles = (data.profiles ?? []).map((p) => {
        const dims = Object.entries(p.dimensions ?? {}).sort((a, b) => b[1].score - a[1].score)
        return h('details', { className: 'q', key: p.id },
          h('summary', null,
            h('div', null, h('b', null, p.id), p.subject?.model ? h('code', { style: { marginLeft: 6 } }, p.subject.model) : null, p.cold ? pill('warn', 'new') : null),
            h('div', { className: 'ans' }, `${p.samples ?? 0} observations`)),
          h('ul', { className: 'plain' }, ...dims.map(([dim, v]) => h('li', { key: dim },
            h('div', { className: 'row' }, h('span', null, dim.replace(/_/g, ' ')), h('span', null, pct(v.score))),
            h('div', { className: 'bar' }, h('i', { style: { width: `${Math.max(0, Math.min(1, v.score)) * 100}%` } })),
            h('div', { className: 'why' },
              `${evidenceNote(v.confidence)}`,
              v.prior ? ` · started from a ${v.prior.source.replace(/_/g, ' ')} of ${pct(v.prior.score)}` : '',
              v.execution ? ` · ${v.execution.n} runs here, trend ${v.execution.trend}` : '',
              v.benchmark ? ` · benchmark ${Math.round(v.benchmark.score * 100)}% (${v.benchmark.passed} of ${v.benchmark.tasks} task${v.benchmark.tasks === 1 ? '' : 's'})` : '')))))
      })
      return h('div', null,
        h('div', { className: 'head' },
          h('div', { className: 'label', style: { margin: 0 } }, data.learning ? 'The router is learning from every routed task' : 'Learning is switched off: Jev and the rules in code decide, and nothing is recorded'),
          h('button', { onClick: onRefresh, disabled: busy }, busy ? 'Reading…' : 'Refresh')),
        h('div', { className: 'card' }, h('div', { className: 'label' }, 'Routing domains'), ...domains),
        laya?.error
          ? h('div', { className: 'card' }, h('div', { className: 'label' }, 'Jev and Laya, side by side'), h('div', { className: 'err', role: 'alert' }, `The comparison could not be read: ${laya.error}`))
          : h(LayaCompare, { data: laya?.data ?? null }),
        h('div', { className: 'card' }, h('div', { className: 'label' }, 'Resources, as the provider adapters report them'), h('ul', { className: 'plain' }, ...resources)),
        h('div', { className: 'card' }, h('div', { className: 'label' }, 'What each resource is believed to be good at'),
          h('div', { className: 'why', style: { margin: '4px 0 8px' } }, 'Priors are the owner\'s starting observations. Recorded runs, reviews, feedback and the capability benchmark below move them; an unknown dimension stays unknown.'),
          ...profiles),
        h(BenchmarkCard, { sessionId, visible }))
    }

    /** One answer of a call. `shadow` is Laya's answer to the same question in Jev Auto (shadowCell), or null. */
    function Question({ q, shadow = null, taskGroup = false }) {
      const probs = q.probabilities ?? {}
      const opts = q.type === 'noul'
        ? [['yes', 'Probability the answer is yes', q.answer]]
        : Object.keys(probs).map((k) => [k, q.options?.[k] ?? '', probs[k]]).sort((a, b) => b[2] - a[2])
      const answer = q.type === 'choice' ? q.answer : q.type === 'score' ? `${Number(q.answer).toFixed(2)} of ${Object.keys(probs).length - 1}` : pct(q.answer)
      const markTone = (m) => (m === 'agrees' ? 'ok' : m === 'differs' || m === 'failed' ? 'bad' : 'warn')
      return h('details', { className: cx('q', !q.used && 'unused') },
        h('summary', null,
          h('div', null, h('span', { className: 'pill' }, q.type), h('code', { style: { marginLeft: 6 } }, q.name), q.used ? h('span', { className: 'pill ok' }, 'used') : null,
            ...answerPills(q, { taskGroup }).map(([tone, text]) => h('span', { className: cx('pill', tone), key: text }, text))),
          h('div', { className: 'ans' }, '→ ', answer, q.type === 'choice' && q.options?.[q.answer] ? h('span', { className: 'muted', style: { fontWeight: 400 } }, ` ${q.options[q.answer]}`) : null),
          shadow ? h('div', { className: 'why shadow' }, 'Laya: ', shadow.text ?? '', shadow.flat ? ' (too flat to use)' : '',
            shadow.mark ? h('span', { className: cx('pill', markTone(shadow.mark)) }, shadow.mark) : null) : null),
        h('div', { className: 'muted', style: { margin: '6px 0' } }, q.question),
        ...opts.map(([k, desc, p]) => h('div', { className: 'opt', key: k },
          h('div', { className: 'row' }, h('span', { title: desc }, h('code', null, k), desc ? ` ${desc}` : ''), h('span', null, pct(p))),
          h('div', { className: 'bar' }, h('i', { style: { width: `${Math.max(0, Math.min(1, p)) * 100}%` } })))),
        typeof q.confidence === 'number' ? h('div', { className: 'why', style: { marginTop: 6 } }, `confidence ${q.confidence.toFixed(3)}`) : null)
    }

    /**
     * Every decider call of a run, in the order it settled: the questions and answers of each call
     * that answered, and a card saying why for each that did not (3.3). A Jev call in Jev Auto also
     * shows what Laya answered to the same questions in the background (`shadow`: the rows by call
     * id, and whether a row still missing can yet land), which decides nothing (5.6).
     */
    function Questions({ calls, shadow = null }) {
      const [onlyUsed, setOnlyUsed] = useState(false)
      if (!calls.length) return null
      const first = calls.findIndex((c) => c.trace)
      return h('div', null, ...calls.map((c, i) => {
        if (c.failed) {
          const f = failedCall(c.failed)
          return h('div', { className: 'card', key: i }, h('div', { className: 'label' }, f.head), h('div', { className: 'err' }, f.text))
        }
        const t = c.trace
        const card = callCard(t)
        const qs = t.questions.filter((q) => !onlyUsed || q.used)
        const compared = !!shadow && (t.provider ?? 'jev') === 'jev'
        const row = compared ? shadow.rows.get(t.callId) ?? null : null
        const waiting = compared && shadow.waiting && !!t.callId
        return h('div', { className: 'card', key: i },
          h('div', { className: 'head' },
            h('div', { className: 'label', style: { margin: 0 } }, `${card.head} · ${ms(t.ms)}`),
            i === first ? h('label', { className: 'toggle' }, h('input', { type: 'checkbox', checked: onlyUsed, onChange: (e) => setOnlyUsed(e.target.checked) }), 'Only used') : null),
          h('div', { className: 'why', style: { margin: '4px 0 0' } }, `${card.label}. Greyed-out answers were not needed for this run.`),
          h('div', { className: 'why' }, `Request id: ${card.requestId}`),
          ...card.notes.map((n, k) => h('div', { className: 'warnline', key: `n${k}` }, n)),
          ...(compared ? shadowHeader(t.questions.map((q) => q.name), row, { waiting }) : []).map((line, k) => h('div', { className: 'why', key: `s${k}` }, line)),
          h('div', { style: { marginTop: 8 } }),
          ...qs.map((q) => h(Question, { key: q.name, q, taskGroup: taskGroupCall(t), shadow: compared ? shadowCell(q.name, row, { waiting, keys: Object.keys(q.options ?? q.probabilities ?? {}) }) : null })))
      }))
    }

    // A shadow job waits at most 10 minutes (laya.shadow.maxAgeMs) before its row is written as
    // waited too long, so a row can land until then after the run has ended, and not after.
    const SHADOW_WAIT_MS = 11 * 60_000
    /**
     * The Laya shadow's rows for one Jev-decided run (5.6), by call id, from GET
     * /jev-router/laya/shadow?runId=<id>: the run's inspector id is its run id (2.4), and the rows
     * come from the shadow's memory. Read when the run is shown, and every 5 s while one of its Jev
     * calls has no row and one can still land: while the run goes on, and after it only when the
     * shadow took it, so a run no row can ever come for (Laya not installed, the comparisons off)
     * is read once. A server with no shadow route answers nothing, and no Laya column is shown.
     * `waiting` says a missing row is still to come: the shadow took this run (the routed event
     * says so, or a row of it has landed) and a row can still land.
     */
    function useShadow(run, s, visible, every = 5000) {
      const [got, setGot] = useState({ runId: null, rows: [] })
      const runId = run?.id ?? null
      const ours = s?.decider === 'jev'
      const jevCalls = (s?.traces ?? []).filter((t) => (t.provider ?? 'jev') === 'jev' && t.callId).length
      const read = got.runId === runId
      const rows = read ? got.rows : []
      // From the run's own end, which a row landing after it does not move.
      const recent = !!s && (s.running || Date.now() - s.endedAt < SHADOW_WAIT_MS)
      const missing = (s?.traces ?? []).some((t) => (t.provider ?? 'jev') === 'jev' && t.callId && !rows.some((r) => r.callId === t.callId))
      const took = rows.length > 0 || s?.routed?.shadow === 'answering'
      const wanted = ours && recent && missing && (took || s.running)
      useEffect(() => {
        if (!visible || !runId || !ours || !jevCalls) return
        // Read once; again only while a row can still land, so the last row landing is not read twice.
        if (read && !wanted) return
        let stop = false
        let timer
        const tick = async () => {
          let d
          try { d = await api(`/jev-router/laya/shadow?runId=${encodeURIComponent(runId)}`) } catch { return }
          if (stop) return
          setGot({ runId, rows: Array.isArray(d?.rows) ? d.rows : [] })
          if (wanted) timer = setTimeout(tick, every)
        }
        tick()
        return () => { stop = true; clearTimeout(timer) }
      }, [runId, visible, ours, wanted, jevCalls, every])
      if (!ours) return null
      return { rows: new Map(rows.map((r) => [r.callId, r])), waiting: recent && took }
    }

    function Decisions({ runs }) {
      const [pick, setPick] = useState(null)
      const run = runs.length ? runs.find((r) => r.id === pick) ?? runs.at(-1) : null
      const s = run ? summarize(run) : null
      const shadow = useShadow(run, s, !!run)
      if (!run) return h('div', { className: 'empty' }, 'No routed tasks in this session yet. Pick "Jev Auto" in the model menu, or use /auto, then send a task.')
      return h('div', null,
        runs.length > 1 ? h('select', { value: run.id, onChange: (e) => setPick(e.target.value), 'aria-label': 'Run', style: { width: '100%' } },
          ...runs.slice().reverse().map((r) => h('option', { key: r.id, value: r.id }, `${new Date(r.startedAt).toLocaleTimeString()} · ${r.task.slice(0, 60)}`))) : null,
        h('div', { className: 'why', style: { marginTop: 6 } }, `Task: ${run.task}`),
        h(Stats, { s }),
        h(WhatHappened, { s, decisionCard: true }),
        h(RoutingDecision, { s }),
        h(Questions, { calls: s.calls, shadow }))
    }

    function useSubagentCatalog(sessionId) {
      useEffect(() => {
        sessionsApi?.setSubagentCatalogOpen?.(sessionId, true)
        const t = setInterval(() => sessionsApi?.refreshSubagents?.(sessionId), 3000)
        return () => { clearInterval(t); sessionsApi?.setSubagentCatalogOpen?.(sessionId, false) }
      }, [sessionId])
    }

    function Subagents({ sessionId, entries }) {
      useSubagentCatalog(sessionId)
      const kids = entries.filter((e) => e.kind === 'child')
      if (!kids.length) return h('div', { className: 'empty' }, 'No subagents in this session yet.')
      const open = (e) => sessionsApi?.openSubagent?.({ parentSessionId: sessionId, childSessionId: e.id, mode: e.mode, ...(e.label ? { label: e.label } : {}) })
      return h('ul', { className: 'plain' }, ...kids.slice().reverse().map((e) => h('li', { key: e.id },
        h('span', null, h('span', { className: cx('dot', e.activity === 'running' && 'on') }), e.label ?? e.id, h('span', { className: 'pill' }, e.mode)),
        h('a', { className: 'link', role: 'button', tabIndex: 0, onClick: () => open(e), onKeyDown: (k) => { if (k.key === 'Enter') open(e) } }, 'Open'))))
    }

    // ---------- background tasks: Jev runs, DSH jobs and subagents of this session in one list ----------
    /**
     * What every task state is called, word for word the same as adapter.js TASK_LABELS on the
     * server. The browser cannot import adapter.js (client.js is a classic script), so this is a
     * deliberate copy; test/tasklist.test.js fails the moment the two drift apart, because the
     * list and the message that delivers the result must never disagree about a state's name.
     */
    const taskLabels = {
      queued: 'Waiting', routing: 'Choosing executor', running: 'Running', verifying: 'Verifying',
      reviewing: 'Reviewing', completed: 'Completed', failed: 'Failed', stopped: 'Stopped',
      needs_human: 'Needs input', paused_limit: 'Paused by limit',
    }
    // The four working states spin (the stylesheet draws the ring); every other state carries a
    // glyph of its own. The label text next to it says the state in words, never colour alone.
    const taskIcon = { queued: '·', routing: '', running: '', verifying: '', reviewing: '', completed: '✓', failed: '✕', stopped: '■', needs_human: '!', paused_limit: '‖' }
    /** The five final states; mirrors tasks.js TERMINAL_STATES. Nothing moves a task out of one. */
    const TERMINAL_TASK = ['completed', 'failed', 'stopped', 'needs_human', 'paused_limit']
    /** The five states that are still work in progress. */
    const LIVE_TASK = ['queued', 'routing', 'running', 'verifying', 'reviewing']
    // How the header names live work: the busier phases first, waiting last, so the dominant thing
    // is read first. Display order only: it never changes which tasks count as live.
    const LIVE_DISPLAY_ORDER = ['running', 'verifying', 'reviewing', 'routing', 'queued']
    /** The live tasks only, so the header counts work in progress and never a finished task. */
    const liveTasks = (tasks) => (tasks ?? []).filter((t) => LIVE_TASK.includes(t.state))
    /**
     * The live half of the work board header: "2 running, 1 queued - checking jev auto, rebuild
     * cache.ts", the count first and the live task names after. Pure and DOM-free (the clock is the
     * only input), so test/workboard.test.js pins the exact words. An empty list gives ''.
     */
    function liveSummary(live, now = Date.now()) {
      const counts = LIVE_DISPLAY_ORDER
        .map((s) => [s, live.filter((t) => t.state === s).length])
        .filter(([, n]) => n)
        .map(([s, n]) => `${n} ${s}`)
        .join(', ')
      const names = live.map((t) => taskRowModel(t, now).title).filter(Boolean).join(', ')
      return [counts, names].filter(Boolean).join(' - ')
    }
    /**
     * What the work board header shows and what its button is called. Live work is named, a quiet
     * board keeps the completed summary, and either way the label says the header opens the panel.
     * Pure, so test/workboard.test.js pins both strings without a DOM.
     */
    function workBoardHeader(countLine, live, now = Date.now()) {
      const liveLine = liveSummary(live, now)
      if (live.length && liveLine) {
        return { text: liveLine, label: `Open the session overview. In progress: ${liveLine}` }
      }
      return { text: countLine, label: `Open the session overview. ${countLine}` }
    }
    /**
     * How many finished results are still waiting to be posted. A task that settled while an
     * answer was streaming sits here until that answer ends and its message goes out, which is
     * the spec's "queued for display" - shown outside the active message, never inside it.
     */
    const awaitingDelivery = (tasks) => (tasks ?? []).filter((t) => TERMINAL_TASK.includes(t.state) && t.deliveryState !== 'delivered').length
    /**
     * How that is said, in one place: the button's accessible name and the screen-reader status
     * region use the same words, so what is announced and what is shown can never drift apart.
     */
    const resultAnnouncement = (n) => (n ? `${n} result${n === 1 ? '' : 's'} waiting to be posted` : '')
    // One set of codes for the mixed list: the task states above, plus the job service's own
    // "done" and the run/subagent codes, which are a different vocabulary and stay as they are.
    const ST = { done: ['✓', 'Done'], ...Object.fromEntries([...LIVE_TASK, ...TERMINAL_TASK].map((s) => [s, [taskIcon[s], taskLabels[s]]])) }
    const elapsed = (from, to) => (from ? ms(to - from) : '')
    const openKid = (sessionId, e) => sessionsApi?.openSubagent?.({ parentSessionId: sessionId, childSessionId: e.id, mode: e.mode, ...(e.label ? { label: e.label } : {}) })

    const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`
    const folderOf = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    const clip = (t, n) => (String(t).length > n ? `${String(t).slice(0, n)}…` : String(t))

    /**
     * One task record as the list row shows it: the name and job id, the state in an icon AND in
     * words, who is on it, the phase, the waiting line's position, how long it has been going or
     * how long it took, whether its result is still unread and why it ended the way it did.
     * Pure and DOM-free (the clock is the only input), so test/tasklist.test.js pins every case.
     */
    function taskRowModel(t, now = Date.now()) {
      const state = t.state
      const done = TERMINAL_TASK.includes(state)
      const queued = state === 'queued'
      const pos = t.position ?? t.queuePosition ?? 0
      // The phase, shown only when it says something the state label does not.
      const phase = t.phase && taskLabels[t.phase] !== taskLabels[state] ? taskLabels[t.phase] : null
      // Elapsed while it runs; the record's own duration once it is finished, so a reopened list
      // shows how long the work took rather than how long ago it ended.
      // None while it waits: a task back in its folder's line after a read pass has a start time,
      // but it is waiting, and its time in line is its own (`waited`).
      const timing = done
        ? (t.durationMs != null ? ms(t.durationMs) : elapsed(t.startedAt + (t.inLineMs ?? 0), t.finishedAt ?? t.startedAt))
        // Its running clock leaves out any time back in line after a read pass.
        : queued ? '' : elapsed(t.startedAt + (t.inLineMs ?? 0), now)
      const meta = [
        // Where it stands, as the server reads it off the line (tasks.js waiting.placeText): a
        // task waiting for a free slot is not "next up" when another workspace's goes first. A
        // record without it (an older engine's) keeps the words from its position.
        queued ? (t.waiting?.placeText || (pos > 1 ? `${ordinal(pos)} in line` : 'next up')) : null,
        // A queued task waits for whoever decides it: the task record keeps its decider (3.1).
        t.agent ?? (queued ? `${deciderName(t.decider)} picks` : null),
        t.model, t.effort,
        // A task judged read only runs on an agent locked against writing, beside the folder's writer.
        t.access === 'read' ? 'reads only' : null,
        phase, folderOf(t.workspace), timing || null,
      ].filter(Boolean).join(' · ')
      // What a waiting task waits for now and, where past runs allow, how long: the server reads
      // both off the line as it stands and writes the whole line (tasks.js waiting.text), so every
      // view says the same thing, and an estimate always carries its basis in its own words, or is
      // not there at all.
      const wait = queued ? String(t.waiting?.text ?? '') : ''
      return {
        jobId: t.jobId,
        title: t.taskName || t.taskText || t.task || '',
        label: taskLabels[state] ?? state,
        // The spin is drawn by the stylesheet for the working states; this string is the glyph.
        icon: taskIcon[state] ?? '·',
        struck: state === 'completed',
        // Nothing is unread before there is a result, and a result stays unread until the chat has it.
        unread: done && t.deliveryState !== 'delivered',
        meta,
        // A task that did not complete says why in the row itself, not only behind the disclosure.
        reason: done && state !== 'completed' ? String(t.terminalReason ?? t.progressText ?? '').trim() : '',
        detail: wait || String(t.progressText ?? t.lastLine ?? '').trim() || '…',
        wait,
        // How long it has been in line, from when it was queued: a waiting task has no start time.
        waited: queued ? elapsed(t.waiting?.since ?? t.queuedAt, now) : '',
        // Run next moves it to the front of its own line, so it is offered only with someone there
        // in front of it (the run holding the workspace is not in the line).
        runNext: queued && (t.waiting ? t.waiting.ahead > 0 : pos > 2),
        canStop: !done,
        // A task that never started is taken out of the line, not stopped: nothing ran.
        stopWord: queued ? 'Remove' : 'Stop',
        // Back in the line after its read pass: it ran, locked against writing, and changed nothing,
        // unless its lock check saw files change (readBreach), which the dialog then says instead.
        again: queued && !!t.requeuedAt && !t.readBreach,
        breach: queued && !!t.requeuedAt && t.readBreach?.changed?.length ? t.readBreach.changed : null,
        canClear: done,
      }
    }

    /**
     * The confirmation for stopping one task, in words that fit what it is doing: a task still in
     * line never ran, so taking it out changes nothing in the workspace, which is what a person
     * deciding whether to look needs to know. Pure, so test/workboard.test.js pins it.
     */
    function stopOneWords(m) {
      const what = clip(m.title || 'this task', 120)
      if (m.stopWord === 'Remove' && m.breach) return { title: 'Remove this task from the line?', body: `"${what}" ran a read pass, and ${clip(m.breach.slice(0, 3).join(', '), 200)}${m.breach.length > 3 ? ` and ${m.breach.length - 3} more` : ''} changed in this repository while it read, so its lock may not have held. It leaves the line, and nothing more of it runs.`, confirmLabel: 'Remove task' }
      if (m.stopWord === 'Remove' && m.again) return { title: 'Remove this task from the line?', body: `"${what}" ran only a read pass, locked against writing, so nothing in the workspace has changed. It leaves the line, and its message in the chat says it was removed after its read pass.`, confirmLabel: 'Remove task' }
      return m.stopWord === 'Remove'
        ? { title: 'Remove this task from the line?', body: `"${what}" has not started, so nothing in the workspace has changed. It leaves the line, and its message in the chat says it was removed before it started.`, confirmLabel: 'Remove task' }
        : { title: 'Stop this task?', body: `Stop "${what}"? Work it already did stays in the workspace.`, confirmLabel: 'Stop task' }
    }

    /**
     * The work board's Stop all, its accessible name and its confirmation, counting running and
     * waiting tasks apart: a waiting task is not running, and stopping it loses no work. Pure.
     */
    function stopAllWords(live, now = Date.now()) {
      const waiting = live.filter((t) => t.state === 'queued').length
      const running = live.length - waiting
      const n = live.length
      const tasks = (k) => `${k} task${k === 1 ? '' : 's'}`
      const what = clip(live.map((t) => taskRowModel(t, now).title).filter(Boolean).join(', '), 200)
      const parts = [running ? `${running} running` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(', ')
      // A task back in the line after its read pass did start: it read, locked against writing, and
      // changed nothing, unless its lock check saw files change (stopOneWords says the same of one).
      const models = live.filter((t) => t.state === 'queued').map((t) => taskRowModel(t, now))
      const again = models.filter((m) => m.again).length
      const breached = models.filter((m) => m.breach).length
      const some = (k) => (k === 1 ? 'one of them' : `${k} of them`)
      const unchanged = breached
        ? `Files changed in the repository of ${waiting === 1 ? 'this task' : some(breached)} while its read pass read, so its lock may not have held; nothing more of ${waiting === 1 ? 'it' : 'them'} runs.`
        : !again ? `${waiting === 1 ? 'It has not started' : 'None of them has started'}, so nothing in the workspace changes.`
          : again === waiting ? `${waiting === 1 ? 'It' : 'Each'} ran only a read pass, locked against writing, so nothing in the workspace changes.`
            : `${some(again)[0].toUpperCase()}${some(again).slice(1)} ran only a read pass, locked against writing, and the rest have not started, so nothing in the workspace changes.`
      const body = !waiting ? `${running} running ${running === 1 ? 'task' : 'tasks'} in this session stop${running === 1 ? 's' : ''} now: ${what}. Work already done stays in the workspace.`
        : !running ? `${waiting} waiting ${waiting === 1 ? 'task leaves' : 'tasks leave'} the line: ${what}. ${unchanged}`
          : `${running} running ${running === 1 ? 'task stops' : 'tasks stop'} now and ${waiting} waiting ${waiting === 1 ? 'task leaves' : 'tasks leave'} the line: ${what}. Work already done stays in the workspace.`
      return { label: `Stop all ${tasks(n)} in this session: ${parts}`, title: `Stop all ${tasks(n)}?`, body, confirmLabel: `Stop ${n}` }
    }

    /**
     * Stop one task, or take it out of the line. Remove asks the server to stop it only while it still
     * waits: one that started while the person was confirming is not stopped under words that said
     * nothing had changed, and the person is told why not.
     */
    function stopTask(t, now = Date.now()) {
      const m = taskRowModel(t, now)
      const remove = m.stopWord === 'Remove'
      return post('/jev-router/tasks/stop', { jobId: t.jobId, ...(remove ? { onlyIfWaiting: true } : {}) }).then((r) => {
        if (r?.result === 'started') throw new Error(`"${clip(m.title || 'This task', 120)}" started before it could be removed, so it was not stopped. Use Stop on its row to stop it.`)
        return r
      })
    }

    /**
     * The words of a confirmation about one task, from its row as it is now, or null once it has
     * ended. A dialog never changes what its button does: one whose task started, ended or went
     * back to waiting meanwhile closes and says so (confirmDrift).
     */
    const confirmFor = (tasks, jobId, now, word) => {
      const t = (tasks ?? []).find((x) => x.jobId === jobId)
      if (!t || TERMINAL_TASK.includes(t.state)) return null
      const m = taskRowModel(t, now)
      return !word || m.stopWord === word ? { ...stopOneWords(m), run: () => stopTask(t, now) } : null
    }
    /**
     * Why a dialog about one task closed on its own, or '' while it still fits: the task ended, or
     * started (Remove asked) or went back to waiting (Stop asked) while the person was confirming.
     * The dialog is never reworded into the other action: nobody pressed that one.
     */
    const confirmDrift = (tasks, confirm, now) => {
      if (!confirm?.jobId || !confirm.word) return ''
      const t = (tasks ?? []).find((x) => x.jobId === confirm.jobId)
      const what = clip(t ? taskRowModel(t, now).title || 'This task' : 'This task', 120)
      if (!t || TERMINAL_TASK.includes(t.state)) return `"${what}" ended while you were confirming, so nothing was done.`
      const word = taskRowModel(t, now).stopWord
      if (word === confirm.word) return ''
      return confirm.word === 'Remove'
        ? `"${what}" started while you were confirming, so it was not removed. Use Stop on its row to stop it.`
        : `"${what}" went back to waiting in line while you were confirming, so nothing was stopped. Use Remove on its row to take it out of the line.`
    }

    // ---- pure queue control helpers: no React, no state. Send now and Steer for a task's row
    // (docs/live-agent-view.md Feature 5): which of them a row offers, and the words of their dialogs,
    // from the facts the server reads off the line (tasks.js view().controls). test/workboard.test.js
    // and test/tasklist.test.js pin them; test/observability.test.js renders the dialogs.

    /** What a task's row offers beside Stop or Remove: Send now while it waits in a line, Steer until it ends. */
    const queueActions = (t) => (!t || TERMINAL_TASK.includes(t.state) ? [] : t.state === 'queued' ? [...(t.controls?.sendNow ? ['send'] : []), 'steer'] : ['steer'])
    /** A queue button's accessible name, which names its task: `Send jev-5 now`, `Steer jev-4`. */
    const queueLabel = (action, t) => (action === 'send' ? `Send ${t.jobId} now` : `Steer ${t.jobId}`)
    /** `jev-3 and jev-4`, `jev-2, jev-3 and jev-4`. */
    const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
    const tasksWord = (n) => `${n} task${n === 1 ? '' : 's'}`

    /**
     * The Send now dialog of a waiting task, by what it waits for (controls.sendNow), or null for a task
     * in no line. 'slot', where it can start at once, says what starting it does: over the cap on tasks
     * at once, past those in front of it in its own line, locked against writing beside the task writing
     * in its folder, beside a local model. 'workspace' and 'chat', where its folder is in use and it
     * cannot start, say so and what can be done instead: Put first in line, or stop the task in the way.
     */
    function sendNowWords(t) {
      const c = t?.controls
      if (!c?.sendNow || t.state !== 'queued') return null
      const id = t.jobId
      const folder = folderOf(t.workspace)
      if (c.sendNow === 'workspace') {
        return {
          kind: 'workspace', holder: c.holder ?? null, title: `${c.holder ?? 'Another task'} is changing ${folder}`,
          body: c.holder ? `Only one task changes a folder at a time. You can put ${id} first in line, or stop ${c.holder} now (what it changed so far stays in the folder) and start ${id}.` : `Only one task changes a folder at a time. You can put ${id} first in line.`,
        }
      }
      if (c.sendNow === 'chat') return { kind: 'chat', holder: null, title: `A run from the chat is using ${folder}`, body: `A run started from the chat is using ${folder}; ${id} can go first in line after it.` }
      const ahead = [...(c.ahead ?? []), ...(c.chatAhead ? [c.chatAhead === 1 ? 'a run started from the chat' : `${c.chatAhead} runs started from the chat`] : [])]
      const body = [
        c.max != null && c.held >= c.max ? `It runs beside ${c.held} other ${c.held === 1 ? 'task' : 'tasks'}, over your limit of ${tasksWord(c.max)} at once (Settings, Resource budget), so the next task to end frees no slot.` : '',
        ahead.length === 1 ? `${ahead[0]} was ahead of it in ${folder} and now waits for it.` : ahead.length ? `${andList(ahead)} were ahead of it in ${folder}; they wait for it now.` : '',
        t.access !== 'read' ? '' : c.heldBy === 'task' ? `It runs locked against writing, beside the task changing ${folder}.` : c.heldBy === 'chat' ? `It runs locked against writing, beside the run from the chat using ${folder}.` : 'It runs locked against writing.',
        c.local ? `${c.local} runs a local model on this PC; two at once can slow it down a lot.` : c.forcedLocal ? `${id} runs a local model on this PC; beside other work it can slow down a lot.` : '',
      ].filter(Boolean)
      return { kind: 'slot', holder: null, title: `Start ${id} now?`, body: body.length ? body : [`${id} starts now.`], confirmLabel: 'Start now' }
    }
    /** The second confirmation of Stop it and start this: the task in the folder's way stops, and this one starts once it has. */
    const stopForWords = (t, holder) => ({ title: `Stop ${holder}?`, body: `Work it already did stays in ${folderOf(t.workspace)}. ${t.jobId} starts as soon as it has stopped.`, confirmLabel: `Stop ${holder}` })
    /**
     * The Steer dialog of a task, or null once it has ended. Before it starts, the words are added to it
     * ('amend'); once it is at work, which `started` says the server found while its row still waits,
     * they go to the agent at work now, where it takes them, or with its next attempt (`confirmLabel`,
     * `live`), or stop the step it is on and go to it as what it does next (`now`, Send now), or as a
     * follow-up task, or with a fresh start of it ('running'). What the agent at work does with them, or
     * why it cannot take them, is the server's (controls.steer), and `live` is false only past an agent
     * that cannot take them; `now.open` only where the agent at work can be stopped for them, the
     * dialog saying why not otherwise. `typed` says the dialog was opened while the task waited, so one
     * that started meanwhile says so, and the words typed stay in the box for the other choices.
     */
    function steerDialogWords(t, { typed = false, started = false } = {}) {
      if (!t || TERMINAL_TASK.includes(t.state)) return null
      const id = t.jobId
      if (t.state === 'queued' && !started) return { mode: 'amend', title: `Steer ${id}`, body: 'Your words are added to the task before it starts. It keeps its place in line.', placeholder: 'What should it do differently?', confirmLabel: 'Add to task', note: '' }
      const s = t.controls?.steer ?? null
      const now = { open: !!s?.now?.path, words: s?.now?.words ?? '' }
      return {
        mode: 'running', title: `Steer ${id}`,
        body: [s?.words || `Your words go to ${id} while it works, or with its next attempt.`, ...(!now.open && now.words ? [now.words] : []), `Or send them as a follow-up task that runs after it, or stop it and start again with them. What it changed so far stays in ${folderOf(t.workspace)}.`],
        placeholder: 'What should it do differently?',
        confirmLabel: 'Now, while it works',
        live: s ? s.sendable !== false : true,
        now,
        note: typed ? `${id} started while you were typing, so your words were not added. Steer it again: they now go to the running agent.` : '',
      }
    }
    /** The confirmation of Send now on a task at work: its agent's current step stops for the words. */
    const sendNowRunningWords = (t) => ({ title: `Send now to ${t.jobId}?`, body: 'Stop the current step and give it this now? Work already done stays in the folder.', confirmLabel: 'Send now' })
    /** A task's guidance as its row lists it, oldest first: each piece's words, what became of them, and whether its task ended without them. */
    const guidanceRows = (t) => (Array.isArray(t?.steers) ? t.steers : [])
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({ id: x.id, text: x.text, state: x.state, words: x.words ?? '', returned: x.state === 'returned' }))
    /**
     * The Live tab's box for Steer under a task's timeline: its placeholder, and whether it takes words
     * now (`open`). Before the task starts they are added to it; once it is at work they go to the agent
     * at work or with its next attempt, never past an agent that cannot take them (controls.steer),
     * whose reason the box says instead. Null for a task that has ended.
     */
    function composerWords(t) {
      if (!t?.key || TERMINAL_TASK.includes(t.state)) return null
      if (t.state === 'queued') return { placeholder: `Add to ${t.jobId} before it starts`, open: true }
      const s = t.controls?.steer ?? null
      if (s && s.sendable === false) return { placeholder: s.words, open: false }
      return { placeholder: `Steer ${t.jobId}: tell ${s?.name ?? t.activity?.agent ?? 'the agent'} something while it works`, open: true }
    }
    /** The confirmation of Stop it and start again with your message. */
    const restartWords = (t) => ({ title: `Stop ${t.jobId} and start again?`, body: `Stop ${t.jobId} and start again with your message? What it changed so far stays in ${folderOf(t.workspace)}.`, confirmLabel: 'Stop and start again' })
    /**
     * Why a queue dialog closed on its own, or '' while it still fits, as confirmDrift says it of Stop.
     * Send now's closes once its task has left the line, or what it waits for has changed, so a button
     * never does what nobody read; Steer's once its task has ended, and a fresh start's or a running
     * task's Send now's once its task has gone back to waiting. A task that starts while Steer is open
     * only turns the dialog to the choices for a task at work, the words kept (steerDialogWords).
     */
    function queueDrift(ask, t) {
      if (!ask) return ''
      const id = t?.jobId ?? ask.jobId
      const typing = ask.kind === 'steer' || ask.kind === 'restart' || ask.kind === 'now'
      if (!t || TERMINAL_TASK.includes(t.state)) return typing ? `${id} ended while you were typing, so your words were not sent.` : `${id} ended while you were deciding, so nothing was done.`
      if ((ask.kind === 'restart' || ask.kind === 'now') && t.state === 'queued') return `${id} went back to waiting in line while you were deciding, so nothing was stopped.`
      if (typing) return ''
      if (t.state !== 'queued') return `${id} has already started.`
      if ((t.controls?.sendNow ?? null) !== ask.wait || (ask.wait === 'workspace' && (t.controls?.holder ?? null) !== ask.holder)) return `What ${id} waits for changed while you were deciding, so nothing was done. Send now says what it waits for now.`
      return ''
    }
    // ---- end pure queue control helpers

    /**
     * The overlay of a Send now or Steer dialog: Confirm's, with as many buttons after Cancel as the
     * choice has, and for Steer the box the words are typed in, which keeps them through a drift
     * (`note`, said above the buttons). `onEnter`, when given, is what Enter in the box does (Shift+Enter
     * starts a new line), and `onCtrlEnter` what Ctrl+Enter does.
     */
    function QueueDialog({ title, body, note, text, placeholder, onText, onEnter, onCtrlEnter, actions, onCancel }) {
      useEffect(() => {
        const k = (e) => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', k)
        return () => window.removeEventListener('keydown', k)
      }, [onCancel])
      useEffect(() => { const back = typeof document === 'undefined' ? null : document.activeElement; return () => { try { back?.focus?.() } catch {} } }, [])
      return h('div', { className: 'jevi jevi-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'jevi-queue-t', 'aria-describedby': 'jevi-queue-b', onClick: onCancel },
        h('div', { className: 'box confirm', onClick: (e) => e.stopPropagation() },
          h('h3', { id: 'jevi-queue-t' }, title),
          h('div', { className: 'body', id: 'jevi-queue-b' }, ...(Array.isArray(body) ? body : [body]).map((p, i) => h('p', { key: i }, p))),
          onText ? h('textarea', {
            className: 'kzh-steer-box', rows: 4, value: text, placeholder, 'aria-label': placeholder, autoFocus: true, onChange: (e) => onText(e.target.value),
            ...(onEnter || onCtrlEnter ? {
              onKeyDown: (e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
                const run = e.ctrlKey || e.metaKey ? onCtrlEnter : onEnter
                if (run) { e.preventDefault(); run() }
              },
            } : {}),
          }) : null,
          note ? h('div', { className: 'kzh-steer-note', role: 'alert' }, note) : null,
          h('div', { className: 'actions' },
            h('button', { className: 'btn', onClick: onCancel, autoFocus: !onText }, 'Cancel'),
            ...actions.map((a) => h('button', { key: a.label, className: cx('btn', a.danger && 'danger'), disabled: !!a.disabled, ...(a.title ? { title: a.title } : {}), onClick: a.run }, a.label)))))
    }

    /**
     * Send now and Steer for one view's rows (the work board, the Tasks tab, the Live tab and the card
     * under a start reply): `open(action, t)` opens the dialog of `action` ('send' or 'steer') about
     * task `t`, and `dialog` renders it, worded from the task as the list has it now. What came of it is
     * a toast; what stopped it, or a dialog that closed on its own, goes to `say`, the view's own line
     * for errors.
     */
    function useQueueControls(tasks, say) {
      // null, or what the open dialog is about: `kind` 'send' (with what the task waited for as it
      // opened, and who held its folder), 'stop' (Stop it and start this, to confirm), 'steer' (the
      // words in `text`), 'restart' (Stop it and start again, to confirm) or 'now' (Send now on a task
      // at work, to confirm).
      const [ask, setAsk] = useState(null)
      const [busy, setBusy] = useState(false)
      const t = ask ? (tasks ?? []).find((x) => x.key === ask.key) ?? null : null
      const drift = queueDrift(ask, t)
      useEffect(() => { if (drift) { setAsk(null); say(drift) } }, [drift])
      const open = (action, x) => {
        say('')
        setAsk(action === 'send'
          ? { kind: 'send', key: x.key, jobId: x.jobId, wait: x.controls?.sendNow ?? null, holder: x.controls?.holder ?? null }
          : { kind: 'steer', key: x.key, jobId: x.jobId, text: '', typed: x.state === 'queued', started: false, error: '' })
      }
      const close = () => setAsk(null)
      const request = (fn, onError) => { setBusy(true); Promise.resolve().then(fn).catch(onError).finally(() => setBusy(false)) }
      // A refused Send now closes its dialog and says why; a refused Steer keeps the words in the box.
      const failed = (e) => { setAsk(null); say(e.message) }
      const steerFailed = (e) => setAsk((a) => (a ? { ...a, kind: 'steer', error: e.message } : a))
      const startNow = (stop) => request(async () => {
        const r = await post('/jev-router/tasks/start-now', { key: ask.key, ...(stop ? { stop } : {}) })
        setAsk(null)
        if (r?.result === 'started') toast(`${ask.jobId} started.`)
        else if (r?.result === 'stopping') toast(r.words)
        else say(r?.words ?? '')
      }, failed)
      const putFirst = () => request(async () => {
        await post('/jev-router/tasks/reorder', { workspace: t.workspace, order: [t.jobId] })
        setAsk(null)
        toast(`${t.jobId} is first in line in ${folderOf(t.workspace)}.`)
      }, failed)
      const steer = (how) => request(async () => {
        const r = await post('/jev-router/tasks/steer', { key: ask.key, text: ask.text, how })
        // Started before the words got there: the dialog turns to the choices for a task at work.
        if (r?.result === 'started') { setAsk((a) => (a ? { ...a, kind: 'steer', started: true } : a)); return }
        // Nothing could be stopped for them after all: the words stay in the box for the other choices.
        if (r?.result === 'not-now') { setAsk((a) => (a ? { ...a, kind: 'steer', error: r.words ?? '' } : a)); return }
        setAsk(null)
        if (['added', 'sent', 'replaced', 'pending', 'queued', 'restarting'].includes(r?.result)) toast(r.words)
        else say(r?.words ?? '')
      }, steerFailed)
      let dialog = null
      if (ask && t && !drift) {
        if (ask.kind === 'send') {
          const w = sendNowWords(t)
          if (w) {
            dialog = h(QueueDialog, {
              title: w.title, body: w.body, onCancel: close,
              actions: w.kind === 'slot' ? [{ label: w.confirmLabel, disabled: busy, run: () => startNow(null) }]
                : [{ label: 'Put first in line', disabled: busy, run: putFirst }, ...(w.holder ? [{ label: `Stop ${w.holder} and start this`, danger: true, disabled: busy, run: () => setAsk({ ...ask, kind: 'stop' }) }] : [])],
            })
          }
        } else if (ask.kind === 'stop') {
          const w = stopForWords(t, ask.holder)
          dialog = h(QueueDialog, { title: w.title, body: w.body, onCancel: close, actions: [{ label: w.confirmLabel, danger: true, disabled: busy, run: () => startNow(ask.holder) }] })
        } else if (ask.kind === 'restart') {
          const w = restartWords(t)
          dialog = h(QueueDialog, { title: w.title, body: w.body, onCancel: () => setAsk({ ...ask, kind: 'steer' }), actions: [{ label: w.confirmLabel, danger: true, disabled: busy, run: () => steer('restart') }] })
        } else if (ask.kind === 'now') {
          const w = sendNowRunningWords(t)
          dialog = h(QueueDialog, { title: w.title, body: w.body, onCancel: () => setAsk({ ...ask, kind: 'steer' }), actions: [{ label: w.confirmLabel, danger: true, disabled: busy, run: () => steer('now') }] })
        } else {
          const w = steerDialogWords(t, { typed: ask.typed, started: ask.started })
          const empty = !ask.text.trim()
          if (w) {
            // A task at work takes the words now (Enter), unless the agent at work cannot take them, and
            // Send now (Ctrl+Enter) stops its current step for them where it can be stopped, once confirmed.
            const now = w.mode === 'running' && w.live && !busy && !empty
            const stop = w.mode === 'running' && w.now.open && !busy && !empty
            const sendNow = () => { if (stop) setAsk({ ...ask, kind: 'now' }) }
            dialog = h(QueueDialog, {
              title: w.title, body: w.body, note: ask.error || w.note, text: ask.text, placeholder: w.placeholder, onCancel: close,
              onText: (text) => setAsk((a) => (a ? { ...a, text, error: '' } : a)),
              ...(w.mode === 'running' ? { onEnter: () => { if (now) steer('live') }, onCtrlEnter: sendNow } : {}),
              actions: w.mode === 'amend' ? [{ label: w.confirmLabel, disabled: busy || empty, run: () => steer('amend') }]
                : [
                    { label: w.confirmLabel, disabled: !now, run: () => steer('live') },
                    { label: 'Send now', disabled: !stop, title: w.now.words, run: sendNow },
                    { label: 'Follow-up after it', disabled: busy || empty, run: () => steer('follow-up') },
                    { label: 'Stop and start again', danger: true, disabled: busy || empty, run: () => setAsk({ ...ask, kind: 'restart' }) },
                  ],
            })
          }
        }
      }
      return { open, dialog }
    }

    /** Copy and Send as a follow-up, for a piece of guidance its task ended without (Steer, docs/live-agent-view.md Feature 5). */
    function GuidanceActions({ t, text }) {
      const copy = () => Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => toast('Copied.'), (e) => toast(`Could not copy: ${e.message}`))
      const followUp = () => Promise.resolve().then(() => post('/jev-router/tasks/steer', { key: t.key, text, how: 'follow-up' })).then((r) => toast(r?.words || 'Queued as a follow-up.'), (e) => toast(e.message))
      return h('span', { className: 'acts' },
        h('button', { type: 'button', className: 'linkish', onClick: copy }, 'Copy'),
        h('button', { type: 'button', className: 'linkish', onClick: followUp }, 'Send as a follow-up'))
    }

    /** A task's guidance in its row and its card: each piece, what became of it, and for one not used, Copy and Send as a follow-up. */
    function GuidanceList({ t }) {
      const rows = guidanceRows(t)
      if (!rows.length) return null
      return h('div', { className: 'kzh-guidance', role: 'list', 'aria-label': `Your guidance for ${t.jobId}` },
        ...rows.map((r) => h('div', { key: r.id, role: 'listitem', className: 'kzh-guidance-row' },
          h('span', { className: 't' }, `You: ${r.text}`),
          r.words ? h('span', { className: 'why' }, r.words) : null,
          r.returned ? h(GuidanceActions, { t, text: r.text }) : null)))
    }

    /**
     * The Live tab's box for Steer (composerWords): Enter gives the words to the task, the agent at work
     * or, before it starts, its text, and Shift+Enter starts a new line; what came of them is said under
     * it, and the words stay in the box when they could not go.
     */
    function LiveComposer({ t, say }) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [said, setSaid] = useState('')
      const w = composerWords(t)
      if (!w) return null
      const send = () => {
        const words = text.trim()
        if (!words || busy || !w.open) return
        setBusy(true)
        say('')
        Promise.resolve().then(() => post('/jev-router/tasks/steer', { key: t.key, text: words, how: 'auto' }))
          .then((r) => { if (r?.result !== 'started') setText(''); setSaid(r?.words ?? '') }, (e) => say(e.message))
          .finally(() => setBusy(false))
      }
      return h('div', { className: 'kzh-live-steer' },
        h('textarea', {
          rows: 2, value: text, placeholder: w.placeholder, 'aria-label': w.placeholder, disabled: !w.open || busy,
          onChange: (e) => { setText(e.target.value); setSaid('') },
          onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() } },
        }),
        said ? h('div', { className: 'kzh-steer-note', role: 'status' }, said) : null)
    }

    /** This session's queued, running and finished background tasks, polled while the tab is on screen. */
    function useTasks(sessionId, visible, every = 1000) {
      const [tasks, setTasks] = useState(EMPTY)
      useEffect(() => {
        if (!visible || !sessionId) return
        let stop = false
        let timer
        const tick = async () => {
          try { const d = await api('/jev-router/tasks'); if (!stop) setTasks(d.tasks.filter((t) => t.sessionId === sessionId)) } catch {}
          if (!stop) timer = setTimeout(tick, every)
        }
        tick()
        return () => { stop = true; clearTimeout(timer) }
      }, [sessionId, visible, every])
      return tasks
    }

    /** A finished task's report, fetched only once its row is opened: a report can be long. */
    function TaskReport({ jobId }) {
      const [state, setState] = useState({ loading: true, text: '', err: '' })
      useEffect(() => {
        let stop = false
        api(`/jev-router/tasks/report?id=${encodeURIComponent(jobId)}`).then(
          (d) => { if (!stop) setState({ loading: false, text: d.report ?? '', err: '' }) },
          (e) => { if (!stop) setState({ loading: false, text: '', err: e.message }) })
        return () => { stop = true }
      }, [jobId])
      if (state.err) return h('div', { className: 'err', role: 'alert' }, state.err)
      if (state.loading) return h('div', { className: 'answer-text' }, 'Loading the report…')
      // The report is Markdown as the agent wrote it. This is where a background result is meant
      // to be read now that the conversation row belongs to the engine again.
      return h(Markdown, { className: 'answer-text', text: state.text || 'No report.' })
    }

    // Every router run a task owns: a task judged read only may have run a read pass before the pass
    // that writes, each its own run. An older server names only the current one.
    const runIdsOf = (t) => (t?.runIds?.length ? t.runIds : [t?.runId].filter(Boolean))
    /** Live work in this session: a background task counts once, not as its job and its run too. */
    function liveCount({ runs, jobs, entries, tasks }) {
      const shadowRuns = new Set(tasks.flatMap(runIdsOf))
      return tasks.filter((t) => LIVE_TASK.includes(t.state)).length
        + jobs.filter((j) => j.kind !== 'jev' && (j.status === 'running' || j.status === 'stopping')).length
        + runs.filter((r) => !shadowRuns.has(r.id) && summarize(r).running).length
        + entries.filter((e) => e.kind === 'child' && e.activity === 'running').length
    }

    // Live work sorts above the waiting line, which sorts above everything finished.
    const RANK = { running: 0, routing: 0, verifying: 0, reviewing: 0, queued: 1 }
    function taskItems({ sessionId, runs, jobs, entries, tasks, open, now }) {
      // A background task owns both a job and a router run; show the task, not its two shadows.
      const shadowed = new Set(tasks.flatMap(runIdsOf))
      const fromTasks = tasks.map((t) => {
        const m = taskRowModel(t, now)
        const key = `t${t.jobId}`
        // While it runs, its last live steps and the way to watch it (liveTail); once finished, its report;
        // and below either, the person's guidance with what became of it.
        const shown = open.has(key) && t.reportAvailable ? h(TaskReport, { jobId: t.jobId }) : liveTail(t) ?? h('div', { className: 'answer-text' }, m.detail)
        return {
          key, at: t.startedAt ?? t.queuedAt ?? 0, status: t.state, title: m.title, kind: t.jobId,
          position: t.position ?? 0, icon: m.icon, label: m.label, meta: m.meta,
          struck: m.struck, unread: m.unread, reason: m.reason, wait: m.wait,
          body: guidanceRows(t).length ? h('div', null, shown, h(GuidanceList, { t })) : shown,
          // Send now and Steer, beside Run next and Clear (docs/live-agent-view.md Feature 5).
          queue: queueActions(t).map((action) => ({ action, task: t })),
          // Only worth offering when something else is genuinely ahead of it.
          runNext: m.runNext && { workspace: t.workspace, jobId: t.jobId },
          stop: m.canStop && { what: m.title, jobId: t.jobId, word: m.stopWord },
          clear: m.canClear && { what: m.title, run: () => post('/jev-router/tasks/clear', { jobIds: [t.jobId] }) },
        }
      })
      const fromRuns = runs.filter((r) => !shadowed.has(r.id)).map((r) => {
        const s = summarize(r)
        const cur = s.attempts.at(-1)
        const status = r.stopped ? 'stopped' : s.running ? 'running' : s.error || s.final?.status === 'limit_reached' ? 'failed' : 'done'
        return {
          key: `r${r.id}`, at: r.startedAt ?? 0, status, title: r.task, kind: deciderName(s.decider),
          meta: [cur ? `${cur.agent} (${cur.role})` : s.routed?.routing?.primaryAgent ?? 'routing…', s.final ? STATUS[s.final.status]?.[1] ?? s.final.status : null, ms(s.total)].filter(Boolean).join(' · '),
          // The run's own lines: Laya's shadow rows in the same log (5.3) are for the Decisions tab,
          // and nothing else of the shadow reaches the live stream (3.3).
          body: h('div', { className: 'answer-text', 'aria-live': status === 'running' ? 'polite' : undefined }, r.events.filter((e) => e.type !== 'shadow').map((e) => e.text ?? e.type).join('\n')),
          stop: status === 'running' && { what: r.task, run: () => post('/jev-router/runs/stop', { runId: r.id }) },
        }
      })
      const fromJobs = jobs.filter((j) => j.kind !== 'jev').map((j) => {
        const status = j.status === 'running' || j.status === 'stopping' ? 'running' : j.status === 'killed' ? 'stopped' : j.status === 'failed' ? 'failed' : 'done'
        return {
          key: `j${j.id}`, at: j.startedAt ?? 0, status, title: j.label ?? j.kind, kind: j.kind,
          meta: [j.status, elapsed(j.startedAt, j.finishedAt ?? now)].filter(Boolean).join(' · '),
          body: h('div', { className: 'answer-text' }, j.detail ?? `${j.kind} · ${j.status}`),
        }
      })
      const fromKids = entries.filter((e) => e.kind === 'child').map((e) => {
        const running = e.activity === 'running'
        // Subagent stop goes through its own session face (DSH routes a child's cancel to interruptByParent).
        const face = running ? sessionsApi?.binding?.(e.id)?.session : undefined
        return {
          key: `s${e.id}`, at: 0, status: running ? 'running' : 'done', title: e.label ?? e.id, kind: 'Subagent',
          meta: [e.mode, running ? 'running' : 'idle'].filter(Boolean).join(' · '),
          body: h('a', { className: 'link', role: 'button', tabIndex: 0, onClick: () => openKid(sessionId, e), onKeyDown: (k) => { if (k.key === 'Enter') openKid(sessionId, e) } }, 'Open subagent'),
          stop: typeof face?.cancel === 'function' && { what: e.label ?? e.id, run: () => face.cancel() },
        }
      })
      // Running first, then the waiting line in its own order, then newest.
      return [...fromTasks, ...fromRuns, ...fromJobs, ...fromKids]
        .sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2)
          || (a.status === 'queued' ? (a.position ?? 0) - (b.position ?? 0) : b.at - a.at))
    }

    // ---------- Overview: the whole session as one chronological ledger ----------
    // Everything below is plain data, never React nodes, so grouping, ordering, the shadowing
    // rules and the untimed bucket all unit test without a DOM (test/overview.test.js). The pane
    // turns each row into JSX, and reuses the inspector's own renderers for a run, a task and a
    // subagent rather than re-describing them.
    const OVERVIEW_GROUPS = [
      { id: 'conversation', label: 'Conversation' },
      { id: 'runs', label: 'Routed runs' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'subagents', label: 'Subagents' },
    ]
    const OVERVIEW_UNTIMED = 'Untimed'
    // How close a durable record's own start (ts minus its attempt time) must be to an in-memory
    // run's start for the two to be the same run and not be listed twice.
    const RUN_MATCH_MS = 120_000

    /**
     * Text of a chat-store block list. A user/context row carries `{type:'text'}` blocks and an
     * assistant row `{kind:'text'}` blocks; both carry `.text`, so one reader serves both. Pure.
     */
    function overviewText(blocks) {
      return (Array.isArray(blocks) ? blocks : []).filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n')
    }
    /** One line of a title, whitespace collapsed and clipped. Pure. */
    function overviewClip(t, n = 80) {
      const s = String(t ?? '').replace(/\s+/g, ' ').trim()
      return s.length > n ? `${s.slice(0, n)}...` : s
    }
    /** The source name of a context row, from whichever of the two shapes it carries. Pure. */
    const overviewSource = (n) => n?.provenance?.label ?? n?.source?.plugin ?? n?.source?.kind ?? 'context'

    /**
     * The conversation half of the ledger: one row per chat-store node, in seq order, each tagged
     * with the turn it belongs to. A turn opens at a user message and holds everything up to the
     * next one, which is the turn timeline the store's own `turn` numbering describes; nodes that
     * arrive before any user message sit in turn 0. No wall-clock time is invented: a node with no
     * `time` gets `at: null` and `untimed: true`. Pure.
     */
    function conversationLedger(nodes) {
      const rows = []
      let turn = 0
      let fallbackSeq = 0
      for (const n of Array.isArray(nodes) ? nodes : []) {
        if (!n || typeof n.kind !== 'string') continue
        const seq = Number.isFinite(n.seq) ? n.seq : fallbackSeq++
        const at = Number.isFinite(n.time) ? n.time : null
        const key = `conv:${seq}:${n.kind}`
        const base = { key, seq, group: 'conversation', at, untimed: at === null }
        if (n.kind === 'user') {
          turn += 1
          const text = overviewText(n.content)
          rows.push({ ...base, turn, kind: 'message', title: overviewClip(text) || 'Your message', who: 'You', state: 'done', durationMs: null, detail: text, prompt: true })
          continue
        }
        if (n.kind === 'steering') {
          const text = overviewText(n.content)
          rows.push({ ...base, turn, kind: 'message', title: overviewClip(text) || 'Steering', who: 'You', state: 'done', durationMs: null, detail: text })
          continue
        }
        if (n.kind === 'assistant') {
          const text = overviewText(n.blocks)
          const timing = n.timing
          const durationMs = Number.isFinite(timing?.completedTime) && Number.isFinite(timing?.stepStartTime)
            ? Math.max(0, timing.completedTime - timing.stepStartTime) : null
          rows.push({
            ...base, turn, kind: 'assistant', title: overviewClip(text) || 'Assistant step', who: 'Assistant',
            state: n.interrupted ? 'stopped' : 'done', durationMs, detail: text, assistant: true,
          })
          continue
        }
        if (n.kind === 'context') {
          rows.push({ ...base, turn, kind: 'context', title: `Context: ${overviewClip(overviewSource(n), 60)}`, who: overviewSource(n), state: 'done', durationMs: null, detail: overviewText(n.content) })
          continue
        }
        if (n.kind === 'compaction') {
          const shadowed = Number.isFinite(n.shadowedItemCount) ? `${n.shadowedItemCount} items folded` : ''
          rows.push({ ...base, turn, kind: 'compaction', title: 'Conversation compacted', who: 'System', state: 'done', durationMs: null, detail: [shadowed, n.summary ?? ''].filter(Boolean).join('\n\n') })
          continue
        }
        if (n.kind === 'tool-result' || n.kind === 'tool-call' || n.kind === 'tool') {
          const call = n.call ?? n
          const name = call?.name ?? n.name ?? 'tool'
          rows.push({ ...base, turn, kind: 'tool', title: `Tool: ${name}`, who: name, state: n.isError ? 'failed' : 'done', durationMs: null, detail: String(n.content ?? n.argsRaw ?? '') })
          continue
        }
        // turn-error, turn-max-tokens, unknown: a note from the engine, still worth a row.
        const text = overviewText(n.content) || n.message || n.kind
        rows.push({ ...base, turn, kind: 'notice', title: n.kind, who: 'Engine', state: n.kind === 'unknown' ? 'done' : 'failed', durationMs: null, detail: String(text) })
      }
      return rows.sort((a, b) => a.seq - b.seq)
    }

    /**
     * One time window per conversation turn. A turn starts at its earliest row and ends where the
     * next turn starts; the last turn ends at its own last activity, so later work lands in the
     * trailing bucket rather than being absorbed into the final turn. Turns with no timed row are
     * dropped, since they can bound nothing. Pure.
     */
    function turnWindows(rows) {
      const byTurn = new Map()
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r.group !== 'conversation' || !Number.isFinite(r.turn)) continue
        const w = byTurn.get(r.turn) ?? { turn: r.turn, start: null, end: null, title: '' }
        if (Number.isFinite(r.at)) {
          if (w.start === null || r.at < w.start) w.start = r.at
          if (w.end === null || r.at > w.end) w.end = r.at
        }
        if (r.prompt) w.title = r.title
        byTurn.set(r.turn, w)
      }
      const list = [...byTurn.values()].filter((w) => w.start !== null).sort((a, b) => a.turn - b.turn)
      for (let i = 0; i < list.length; i++) {
        const next = list[i + 1]
        list[i].endBound = next ? next.start : list[i].end
      }
      return list
    }

    /**
     * Which section a timed work row belongs to: a turn number, the leading bucket before the
     * first turn, the trailing bucket after the last one, or `untimed` for a row with no clock.
     * Pure.
     */
    function bucketFor(windows, at) {
      if (!Number.isFinite(at)) return 'untimed'
      if (!windows.length) return 'after'
      if (at < windows[0].start) return 'before'
      let found = null
      for (const w of windows) {
        if (at < w.start) continue
        if (Number.isFinite(w.endBound) && at >= w.endBound) continue
        found = w
      }
      return found ? found.turn : 'after'
    }

    /** A record's own duration: the sum of its attempts. Never a made-up wall clock. Pure. */
    const recordDurationMs = (rec) => (rec?.attempts ?? []).reduce((t, a) => t + (Number.isFinite(a?.durationMs) ? a.durationMs : 0), 0)
    /** A stored finalStatus in the four words the ledger's state column uses. Pure. */
    function recordState(finalStatus) {
      const s = String(finalStatus ?? '')
      if (s.startsWith('accepted') || s === 'answered') return 'done'
      if (s === 'stopped') return 'stopped'
      // A read pass handed to its folder's line is no failure: the task went on as work that writes.
      if (s === 'paused_limit' || s === 'needs_human' || s === 'needs_write') return 'warn'
      return 'failed'
    }

    /**
     * Pair this process's inspector runs with the durable records read back from history.jsonl.
     * A record whose task and computed start (ts minus its attempt time) match a live run is that
     * same run, so it fills the live row's detail instead of appearing a second time. A record with
     * no live partner becomes its own row. Newest last; a row with no time sorts after timed ones.
     * Pure.
     */
    function pairRuns(liveRuns, records) {
      const pairs = (liveRuns ?? []).filter(Boolean).map((run) => ({ id: run.id, live: run, record: null, at: Number.isFinite(run.startedAt) ? run.startedAt : null }))
      for (const rec of records ?? []) {
        const ts = rec?.ts ? Date.parse(rec.ts) : NaN
        const at = Number.isFinite(ts) ? ts - recordDurationMs(rec) : null
        const match = pairs.find((p) => !p.record && p.live && p.live.task === rec.task && Number.isFinite(at) && Number.isFinite(p.at) && Math.abs(p.at - at) <= RUN_MATCH_MS)
        if (match) { match.record = rec; if (rec.runId) match.id = rec.runId; continue }
        pairs.push({ id: rec?.runId ?? `rec:${pairs.length}`, live: null, record: rec, at })
      }
      return pairs.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    }

    /**
     * A routed run as a ledger row. A live run reuses `summarize` for its state and duration; a
     * durable-only run reads the stored record's own fields. A run a background task owns is
     * dropped, because the task row is the one to show: a live run matches its task's `runId`
     * directly (the same shadow `taskItems` already applies), and a durable record, which carries
     * the router's own run id rather than the inspector's, matches its task on the same task text
     * and start time. Pure.
     */
    function runLedgerRows(pairs, taskRows) {
      const ownedIds = new Set((taskRows ?? []).flatMap((r) => runIdsOf(r.task)))
      const ownedByTask = (p) => p.record && (taskRows ?? []).some((r) => r.task?.task === p.record.task && Number.isFinite(r.at) && Number.isFinite(p.at) && Math.abs(r.at - p.at) <= RUN_MATCH_MS)
      const out = []
      for (const p of pairs ?? []) {
        // A durable record carries its run's id, which its task keeps for every pass (runIds).
        if (p.live ? ownedIds.has(p.live.id) : ownedIds.has(p.record?.runId) || ownedByTask(p)) continue
        const at = p.at
        const s = p.live ? summarize(p.live) : null
        const status = p.live
          ? (p.live.stopped ? 'stopped' : s.running ? 'running' : s.error || s.final?.status === 'limit_reached' ? 'failed' : 'done')
          : recordState(p.record?.finalStatus)
        out.push({
          key: `run:${p.id}`, group: 'runs', kind: 'run', at, untimed: !Number.isFinite(at),
          title: p.live?.task ?? p.record?.task ?? '(run)',
          who: s?.routed?.routing?.primaryAgent ?? p.record?.routing?.primaryAgent ?? '',
          status,
          label: p.live ? (s.final ? STATUS[s.final.status]?.[1] ?? s.final.status : s.running ? 'Running' : status) : String(p.record?.finalStatus ?? status),
          durationMs: s ? s.total : recordDurationMs(p.record),
          live: p.live ?? null, record: p.record ?? null,
        })
      }
      return out
    }

    /** This session's background tasks as ledger rows, through the same `taskRowModel` the Tasks tab uses. Pure. */
    function taskLedgerRows(tasks, now) {
      return (tasks ?? []).filter(Boolean).map((t) => {
        const m = taskRowModel(t, now)
        const at = Number.isFinite(t.startedAt) ? t.startedAt : Number.isFinite(t.queuedAt) ? t.queuedAt : null
        return {
          key: `task:${t.jobId}`, group: 'tasks', kind: 'task', at, untimed: at === null,
          title: m.title, who: t.agent ?? '', status: t.state, label: m.label, meta: m.meta,
          reason: m.reason, durationMs: Number.isFinite(t.durationMs) ? t.durationMs : null, detail: m.detail, task: t,
        }
      })
    }

    /** DSH jobs of this session as ledger rows. A job of kind `jev` is the run's shadow and is dropped. Pure. */
    function jobLedgerRows(jobs, now) {
      return (jobs ?? []).filter((j) => j && j.kind !== 'jev').map((j) => {
        const at = Number.isFinite(j.startedAt) ? j.startedAt : null
        const status = j.status === 'running' || j.status === 'stopping' ? 'running' : j.status === 'killed' ? 'stopped' : j.status === 'failed' ? 'failed' : 'done'
        return {
          key: `job:${j.id}`, group: 'tasks', kind: 'job', at, untimed: at === null,
          title: j.label ?? j.kind, who: '', status, label: j.status, meta: elapsed(j.startedAt, j.finishedAt ?? now),
          reason: '', durationMs: null, detail: j.detail ?? `${j.kind} · ${j.status}`, job: j,
        }
      })
    }

    /**
     * Subagents as ledger rows. This engine records no timestamp for a child session, so every
     * subagent row is `untimed` and lands in the Untimed section rather than being given a fake
     * time. Pure.
     */
    function subagentLedgerRows(entries) {
      return (entries ?? []).filter((e) => e && e.kind === 'child').map((e) => ({
        key: `kid:${e.id}`, group: 'subagents', kind: 'subagent', at: null, untimed: true,
        title: e.label ?? e.id, who: '', status: e.activity === 'running' ? 'running' : 'done',
        label: [e.mode, e.activity === 'running' ? 'running' : 'idle'].filter(Boolean).join(' · '),
        meta: '', reason: '', durationMs: null, detail: '', entry: e,
      }))
    }

    /**
     * Assemble the ledger: conversation rows grouped by turn, work rows attached to the turn whose
     * window holds their time, subagents and clock-less rows in an explicit Untimed section, and
     * work that started after the last turn in a trailing bucket. Sections run oldest first, with
     * Untimed last, because it is not a moment in time. Pure.
     */
    function buildLedger({ nodes, runs, tasks, jobs, entries, now }) {
      const conversation = conversationLedger(nodes)
      const windows = turnWindows(conversation)
      const taskRows = taskLedgerRows(tasks, now)
      const runRows = runLedgerRows(runs, taskRows)
      const jobRows = jobLedgerRows(jobs, now)
      const kidRows = subagentLedgerRows(entries)
      const sections = new Map()
      const section = (key, kind, title, at) => {
        if (!sections.has(key)) sections.set(key, { key, kind, title, at, rows: [] })
        return sections.get(key)
      }
      for (const r of conversation) {
        const w = windows.find((x) => x.turn === r.turn)
        const s = section(`turn:${r.turn}`, 'turn', w?.title ? `Turn ${r.turn}: ${w.title}` : r.turn === 0 ? 'Session start' : `Turn ${r.turn}`, w?.start ?? null)
        s.rows.push(r)
      }
      for (const r of [...runRows, ...taskRows, ...jobRows]) {
        const bucket = bucketFor(windows, r.at)
        const w = Number.isFinite(bucket) ? windows.find((x) => x.turn === bucket) : null
        const key = Number.isFinite(bucket) ? `turn:${bucket}` : String(bucket)
        const title = Number.isFinite(bucket)
          ? (w?.title ? `Turn ${bucket}: ${w.title}` : bucket === 0 ? 'Session start' : `Turn ${bucket}`)
          : bucket === 'after' ? 'After the last turn' : bucket === 'before' ? 'Before the first turn' : OVERVIEW_UNTIMED
        section(key, Number.isFinite(bucket) ? 'turn' : bucket, title, w?.start ?? null).rows.push(r)
      }
      for (const r of kidRows) section('untimed', 'untimed', OVERVIEW_UNTIMED, null).rows.push(r)
      const order = (s) => (s.kind === 'turn' ? 0 : s.kind === 'before' ? -1 : s.kind === 'after' ? 1 : 2)
      const list = [...sections.values()]
        .filter((s) => s.rows.length)
        .sort((a, b) => order(a) - order(b) || (a.at ?? Infinity) - (b.at ?? Infinity))
      for (const s of list) s.rows.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.seq ?? 0) - (b.seq ?? 0))
      const counts = Object.fromEntries(OVERVIEW_GROUPS.map((g) => [g.id, [...sections.values()].reduce((t, s) => t + s.rows.filter((r) => r.group === g.id).length, 0)]))
      return { sections: list, counts, conversation: conversation.length }
    }

    function Tasks({ sessionId, runs, jobs, entries, tasks }) {
      useSubagentCatalog(sessionId)
      const [confirm, setConfirm] = useState(null)
      const [err, setErr] = useState('')
      const [open, setOpen] = useState(() => new Set())
      const anyRunning = runs.some((r) => summarize(r).running)
        || jobs.some((j) => j.status === 'running' || j.status === 'stopping')
        || tasks.some((t) => LIVE_TASK.includes(t.state))
      const now = useNow(anyRunning)
      const items = taskItems({ sessionId, runs, jobs, entries, tasks, open, now })
      const finished = tasks.filter((t) => TERMINAL_TASK.includes(t.state))
      const shown = confirm?.jobId ? confirmFor(tasks, confirm.jobId, now, confirm.word) : confirm
      const drift = confirmDrift(tasks, confirm, now)
      useEffect(() => { if (drift) { setConfirm(null); setErr(drift) } }, [drift])
      const queue = useQueueControls(tasks, setErr)
      const act = (fn) => { setErr(''); Promise.resolve(fn()).catch((e) => setErr(e.message)) }
      const toggle = (key, isOpen) => setOpen((s) => { const n = new Set(s); if (isOpen) n.add(key); else n.delete(key); return n })
      if (!items.length) return h('div', { className: 'empty' }, 'Nothing queued, running or finished in this session yet.')
      return h('div', null,
        err ? h('div', { className: 'err', role: 'alert' }, err) : null,
        finished.length ? h('div', { className: 'actions', style: { justifyContent: 'flex-end', marginBottom: 6 } },
          h('button', {
            className: 'btn',
            onClick: () => setConfirm({
              title: 'Clear finished tasks?',
              body: `${finished.length} finished task${finished.length === 1 ? '' : 's'} leave this list and the saved task log. Nothing in your project changes, and results already posted into the chat stay there.`,
              confirmLabel: `Clear ${finished.length}`,
              run: () => post('/jev-router/tasks/clear', { jobIds: finished.map((t) => t.jobId) }),
            }),
          }, `Clear finished (${finished.length})`)) : null,
        h('ul', { className: 'plain', 'aria-label': 'Background tasks' }, ...items.map((it) => h('li', { key: it.key, className: 'task', style: { display: 'block' } },
          h('div', { className: 'top' },
            h('details', { onToggle: (e) => toggle(it.key, e.currentTarget.open) },
              h('summary', null,
                // The icon is a glyph (or the stylesheet's spinner); it is hidden from a screen
                // reader because the label right beside it says the same state in words.
                h('span', { className: cx('st', it.status), 'aria-hidden': true }, it.icon ?? ST[it.status]?.[0] ?? '·'),
                h('span', { style: { minWidth: 0 } },
                  h('div', { className: cx('title', it.struck && 'struck'), title: it.title }, it.title,
                    it.unread ? h('span', { className: 'unread', title: 'This result has not been shown in the chat yet' }, 'Unread result') : null),
                  h('div', { className: 'why' },
                    h('span', { className: 'pill', style: { marginLeft: 0, marginRight: 6 } }, it.kind),
                    // The live region is here, on the state, and not on the progress line above:
                    // a router emits a progress line every few hundred milliseconds, and
                    // announcing each one buries the changes that matter. Phase and terminal
                    // transitions are what a screen reader should hear.
                    h('span', { className: cx('pill', 'state', it.status), style: { marginLeft: 0, marginRight: 6 }, 'aria-live': 'polite', 'aria-atomic': true }, it.label ?? ST[it.status]?.[1] ?? it.status),
                    it.meta),
                  // Why a task failed, stopped, needs a person or ran out of limit: in the row, not only
                  // behind the disclosure, because the reason is the part that needs acting on.
                  it.reason ? h('div', { className: cx('reason', it.status) }, it.reason) : null,
                  // Why it waits, in the row itself: it is what decides whether to act, so it is not
                  // only behind the disclosure. Not a live region: its estimate moves every minute.
                  it.wait ? h('div', { className: 'why' }, it.wait) : null)),
              h('div', { style: { marginTop: 6 } }, it.body)),
            ...(it.queue ?? []).map((q) => h('button', { key: q.action, className: 'btn', 'aria-label': queueLabel(q.action, q.task), onClick: () => queue.open(q.action, q.task) }, q.action === 'send' ? 'Send now' : 'Steer…')),
            it.runNext ? h('button', {
              className: 'btn', 'aria-label': `Run ${it.title} next`,
              onClick: () => act(() => post('/jev-router/tasks/reorder', { workspace: it.runNext.workspace, order: [it.runNext.jobId] })),
            }, 'Run next') : null,
            it.clear ? h('button', {
              className: 'btn', 'aria-label': `Clear ${it.title}`,
              onClick: () => setConfirm({
                title: 'Clear this task?',
                body: `"${clip(it.clear.what, 120)}" leaves this list and the saved task log. Nothing in your project changes.`,
                confirmLabel: 'Clear task',
                run: it.clear.run,
              }),
            }, 'Clear') : null,
            it.stop ? h('button', {
              className: 'btn danger', 'aria-label': `${it.stop.word ?? 'Stop'} ${it.title}`,
              // A task's dialog is worded from its row each time it renders (confirmFor); a run, a
              // job or a subagent is asked about as it was when the button was pressed.
              onClick: () => setConfirm(it.stop.jobId ? { jobId: it.stop.jobId, word: it.stop.word } : { ...stopOneWords({ title: it.stop.what, stopWord: 'Stop' }), run: it.stop.run }),
            }, it.stop.word ?? 'Stop') : null)))),
        shown ? h(Confirm, {
          title: shown.title,
          body: shown.body,
          confirmLabel: shown.confirmLabel,
          onCancel: () => setConfirm(null),
          onConfirm: () => { setConfirm(null); act(shown.run) },
        }) : null,
        queue.dialog)
    }

    // ---------- work board: this session's background tasks, always on screen ----------
    /**
     * A full-width card at the top of the conversation, per session, so what the work is doing
     * never hides behind a tab or scrolls away with the messages (see WorkBoardSeat for the seat).
     * It is task based: this session's background tasks as a checklist, `N/M completed`, with the
     * live ones ticking. The seat is additive and the board renders nothing at all when the session
     * has no tasks, so a quiet chat is not cluttered.
     * Every row reuses taskRowModel, so the words here, in the Tasks panel and in the delivered
     * result message can never drift apart.
     */
    function WorkBoard({ session }) {
      useStyle()
      const sessionId = session?.sessionId
      const tasks = useTasks(sessionId, true, 1000)
      const anyLive = tasks.some((t) => LIVE_TASK.includes(t.state))
      // One tick a second, and only while something is actually moving: a still board is cheap.
      const now = useNow(anyLive)
      // null, 'all' for Stop all, or { jobId } of the one task being stopped or removed.
      const [confirm, setConfirm] = useState(null)
      const [err, setErr] = useState('')
      const drift = confirmDrift(tasks, confirm, now)
      useEffect(() => { if (drift) { setConfirm(null); setErr(drift) } }, [drift])
      const queue = useQueueControls(tasks, setErr)
      if (!tasks.length) return null
      // Only `completed` counts as done: a stopped or failed task is finished, not a success, so
      // the header names every terminal state that did not complete instead of folding it in.
      const done = tasks.filter((t) => t.state === 'completed').length
      const ended = TERMINAL_TASK.filter((s) => s !== 'completed')
        .map((s) => [s, tasks.filter((t) => t.state === s).length]).filter(([, n]) => n)
        .map(([s, n]) => `, ${n} ${taskLabels[s].toLowerCase()}`).join('')
      const countLine = `${done}/${tasks.length} completed${ended}`
      const live = liveTasks(tasks)
      // The header is the indicator and the way in: live work is named, a quiet board keeps the
      // completed summary, and either way the same button opens the Overview tab.
      const { text: headerText, label: openLabel } = workBoardHeader(countLine, live, now)
      const what = live.map((t) => taskRowModel(t, now).title).filter(Boolean).join(', ')
      const all = stopAllWords(live, now)
      // The panel helpers throw when the right sidebar is missing; a click there must do nothing,
      // never throw, so the header can never become a dead end.
      const openOverview = () => { try { togglePanel(OVERVIEW_KIND) } catch {} }
      const act = (fn) => { setErr(''); Promise.resolve().then(fn).catch((e) => setErr(e.message)) }
      // Worded from the rows as they are now, so a dialog opened on a waiting task asks about a
      // running one if it started meanwhile, and closes once the task has ended.
      // Stop all covers the tasks it named when it opened, those still live: never one queued after.
      const named = confirm?.all ? live.filter((t) => confirm.all.includes(t.jobId)) : []
      const words = confirm?.all ? (named.length ? { ...stopAllWords(named, now), run: () => Promise.all(named.map((t) => post('/jev-router/tasks/stop', { jobId: t.jobId }))) } : null)
        : confirm ? confirmFor(tasks, confirm.jobId, now, confirm.word) : null
      return h('div', { className: 'kzh-wb', role: 'region', 'aria-label': 'Background work in this session' },
        h('div', { className: 'kzh-wb-hd' },
          h('button', {
            type: 'button', className: cx('kzh-wb-open', live.length && 'live'),
            'aria-label': openLabel, title: headerText, onClick: openOverview,
          },
            live.length ? h('span', { className: 'kzh-wb-spin', 'aria-hidden': true }) : null,
            h('span', { className: 'kzh-wb-count' }, headerText)),
          // Nothing is ever stopped from here while nothing is live, so the control stays hidden.
          live.length ? h('button', {
            type: 'button', className: 'kzh-wb-stop',
            'aria-label': all.label,
            title: `Stop: ${clip(what, 160)}`, onClick: () => setConfirm({ all: live.map((t) => t.jobId) }),
          }, 'Stop all') : null),
        h('ul', { className: 'kzh-wb-list', 'aria-label': 'Background tasks' }, ...tasks.map((t, i) => {
          const m = taskRowModel(t, now)
          const isLive = LIVE_TASK.includes(t.state)
          // The mark is a glyph, or the stylesheet's spinner while the task works; the pill beside
          // it says the same state in words, so shape and colour are never the only difference.
          // A waiting row's clock is its time in line, from when it was queued; it has no start
          // time, which is what used to leave it reading "starting" for as long as it waited.
          const time = !isLive ? null : t.state === 'queued' ? (m.waited ? `in line ${m.waited}` : null) : elapsed(t.startedAt + (t.inLineMs ?? 0), now) || null
          // What its work is doing now, under a running row (a waiting row keeps its wait words); the
          // row opens the Live tab on the task, and the line is that same way in from the keyboard.
          const act = isLive && t.state !== 'queued' ? t.activity ?? null : null
          const line = act ? activityLine(act, now, t.state) : ''
          const watch = t.key ? () => openLive({ task: t.key }) : null
          return h('li', { key: m.jobId ?? `t${i}`, className: 'kzh-wb-item' },
            h('div', { className: cx('kzh-wb-row', isLive && 'live', watch && 'go'), onClick: watch ? (e) => { if (!e?.target?.closest?.('button')) watch() } : undefined },
              h('span', { className: 'kzh-wb-mark', 'aria-hidden': true }, isLive ? '' : m.icon),
              h('span', { className: cx('kzh-wb-title', m.struck && 'struck'), title: m.title || undefined }, m.title || 'Untitled task'),
              h('span', { className: 'kzh-wb-state' }, m.label),
              h('span', { className: 'kzh-wb-meta', title: m.meta }, m.meta),
              time ? h('span', { className: 'kzh-wb-time' }, time) : null,
              // Send now while it waits in a line, Steer until it ends (docs/live-agent-view.md Feature 5).
              ...queueActions(t).map((a) => h('button', {
                key: a, type: 'button', className: 'kzh-wb-x', 'aria-label': queueLabel(a, t),
                title: a === 'send' ? 'Start it now, ahead of its line' : 'Tell it something, before it starts or after', onClick: () => queue.open(a, t),
              }, a === 'send' ? 'Send now' : 'Steer…')),
              isLive && m.canStop ? h('button', {
                type: 'button', className: 'kzh-wb-x', 'aria-label': `${m.stopWord} ${m.title || 'this task'}`,
                title: m.stopWord === 'Remove' ? 'Take this task out of the line' : 'Stop this task', onClick: () => setConfirm({ jobId: t.jobId, word: m.stopWord }),
              }, m.stopWord) : null),
            line ? h('button', {
              type: 'button', className: 'kzh-wb-act', title: line, onClick: watch ?? undefined,
              'aria-label': `Watch ${m.title || 'this task'} live: ${line}`,
            },
              h('span', { className: cx('kzh-dot', freshNow(act, now) && 'fresh'), 'aria-hidden': true }),
              h('span', { className: 't' }, line)) : null,
            // Why it waits, and how long it may, under the row: the reason is the part that decides
            // what to do about it, so it is never cut off with the meta line.
            m.wait ? h('div', { className: 'kzh-wb-why' }, m.wait) : null)
        })),
        // The same news the background button gives, spoken: one polite line, never taking focus.
        h('span', { className: 'kzh-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, resultAnnouncement(awaitingDelivery(tasks))),
        err ? h('div', { className: 'kzh-wb-err', role: 'alert' }, err) : null,
        words ? h(Confirm, {
          title: words.title,
          body: words.body,
          confirmLabel: words.confirmLabel,
          onCancel: () => setConfirm(null),
          onConfirm: () => { setConfirm(null); act(words.run) },
        }) : null,
        queue.dialog)
    }

    // ---------- work board seat: the top of the conversation, not the composer ----------
    // The board used to sit in conversation.input.dock, the full-width strip directly above the
    // message box. That is not where a task list belongs. None of the top slots can hold it:
    // conversation.session.header is kind SINGLE, so registering it would replace the session title
    // row, and its .utilities and .corner lists are compact, right-aligned header controls. The
    // conversation's own scroller has no top slot at all, so the board mounts into that scroller
    // instead: a host div kept as its first child, sticky to the scroller's top, so the card sits
    // above the messages and stays there while they scroll under it.
    let reactDom
    /** react-dom lazily: the DOM-less unit tests pass a require that knows only `react`. */
    const portaling = () => {
      if (reactDom === undefined) {
        try { reactDom = require('react-dom') ?? null } catch { reactDom = null }
      }
      return reactDom
    }
    /** The conversation scroller and its one board host, created on demand at the very top. */
    function boardHost() {
      const scope = transcriptScope()
      if (!scope) return null
      let host = scope.querySelector(':scope > [data-kzh-work-board]')
      if (!host) {
        host = document.createElement('div')
        host.className = 'kzh-wb-host'
        host.setAttribute('data-kzh-work-board', '')
        scope.insertBefore(host, scope.firstChild)
      }
      return host
    }
    /**
     * The seat itself. It is registered on the session header's utilities list as a mount point
     * only and always renders null there, while WorkBoard renders through a portal into
     * boardHost(). The scroller belongs to React, so the host is re-asserted whenever the body
     * changes: that covers a React render which dropped our foreign child, a session switch that
     * replaced the scroller, and a scroller that only arrives with a later commit than this header
     * seat. No animation frame is involved, because a hidden or minimised window runs none, and a
     * frame-gated first pass left the host missing while the scroller was already on screen.
     */
    function WorkBoardSeat({ sessionId }) {
      useStyle()
      const [host, setHost] = useState(null)
      useEffect(() => {
        const settle = () => { const el = boardHost(); if (el) setHost(el) }
        const mo = new MutationObserver(settle)
        mo.observe(document.body, { childList: true, subtree: true })
        settle()
        return () => mo.disconnect()
      }, [sessionId])
      const RD = portaling()
      if (!RD || !host || !sessionId) return null
      return RD.createPortal(h(WorkBoard, { session: { sessionId } }), host)
    }

    // ---------- the live view: what each agent is doing as it does it ----------
    // docs/live-agent-view.md Feature 1. The server keeps each run's steps as they stream (live.js) and
    // serves them by task or run at GET /jev-router/live; the work board's second line and the Tasks
    // tab's tail read the `activity` each /tasks row already carries, so they need no poller of their
    // own. The words are worked out by pure helpers, which test/liveview.test.js pins without a DOM.

    // ---- pure live helpers: no React, no state. What the live view says, from GET /jev-router/live
    // answers and the `activity` of a /tasks row (live.js), and the clock.

    // The live store's thresholds (live.js LIVE_TIMES), for the words the clock moves between two reads.
    const LIVE_TIMES = { commandMs: 60_000, silenceMs: 90_000, quietMs: 10_000, freshMs: 5_000, rateMs: 2_000 }
    // The mark a start reply carries for its task (reply-words.js JOB_MARK).
    const JOB_MARK = /^\[jev-job\]:\s*kzh-job-1-([\w-]{1,80})\s*$/m
    // How many lines of a command's output, and of a file's diff, a step shows before Show all.
    const TERMINAL_LINES = 20
    const DIFF_LINES = 400

    /** A span of time as the live view says it: `45s`, `3m 05s`, `1h 02m` (live.js spanWords). */
    function spanWords(n) {
      const s = Math.max(0, Math.floor((n ?? 0) / 1000))
      if (s < 60) return `${s}s`
      const pad = (x) => String(x).padStart(2, '0')
      if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
      return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
    }
    /** Text on one line, its first `n` characters, with an ellipsis when there was more (live.js oneLine). */
    const oneLine = (t, n) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x }

    /**
     * Why a live run reads as stalled, or '': the browser's copy of live.js stallOf, so the counts in
     * its words move with the clock between two reads. A call of any tool still running (`busy`)
     * counts as open, as there: the agent waits on it. It never says stuck: a long command or a long
     * think is not one. Its silence words say Stop is on the row, as the work board's row and the
     * card have one; a line with no Stop beside it (`stopHere` false) leaves that out.
     */
    function stallWords({ open, lastAgentAt, agent, live, busy } = {}, now = Date.now(), { stopHere = true } = {}) {
      if (open && now - open.since > LIVE_TIMES.commandMs) return `Waiting on a command for ${spanWords(now - open.since)}: ${oneLine(open.command, 60)}`
      if (live && !open && !busy && Number.isFinite(lastAgentAt) && now - lastAgentAt > LIVE_TIMES.silenceMs) return `No news from ${agent ?? 'the agent'} for ${spanWords(now - lastAgentAt)}. It may still be thinking${stopHere ? '; Stop is on this row' : ''}.`
      return ''
    }

    /** A token count as a person reads one: `950 tokens`, `18.2k tokens`, `41k tokens`, `1.2M tokens`. */
    function tokenWords(n) {
      const x = Math.max(0, Math.round(Number(n) || 0))
      const short = (v, unit) => `${(Math.round(v * 10) / 10).toString()}${unit}`
      if (x < 1000) return `${x} token${x === 1 ? '' : 's'}`
      if (x < 100_000) return `${short(x / 1000, 'k')} tokens`
      if (x < 999_500) return `${Math.round(x / 1000)}k tokens`
      return `${short(x / 1_000_000, 'M')} tokens`
    }
    /** How long ago, in the activity line's words: `3 s ago`, then `2m 05s ago`. */
    const agoWords = (n) => (n < 60_000 ? `${Math.floor(Math.max(0, n) / 1000)} s ago` : `${spanWords(n)} ago`)

    /**
     * The work board's second line for a live task, from its activity (live.js activityOf) and the clock:
     * `Running a command: npm test · 14 tool calls · 18.2k tokens · 31 tokens/s · 1 s ago`. The rate is
     * that of a stream this build reads; it falls to 0 once nothing has come for its window, and past
     * 10 s of quiet the line says `quiet for N s` rather than how long ago. While an agent works whose
     * steps this build cannot hear (live detail off, `heard` false), it says neither, which would read
     * as that agent's silence. A stall's words take the phrase's place, worked out again with the
     * clock. A line with no Stop beside it (`stopHere` false) words a silence by the clock alone, never
     * by the phrase the store read it with, whose words say Stop is on the row. Pure.
     */
    function activityLine(a, now = Date.now(), state = null, { stopHere = true } = {}) {
      if (!a) return ''
      if (a.done) return doneLine(a, state)
      const quiet = Number.isFinite(a.lastActivityAt) && a.heard !== false ? Math.max(0, now - a.lastActivityAt) : null
      const phrase = stallWords({ open: a.open, lastAgentAt: a.lastAgentAt, agent: a.agent, live: a.live, busy: a.busy }, now, { stopHere }) || (stopHere || a.stall?.kind !== 'silence' ? a.phrase : '') || ''
      const rate = typeof a.rate === 'number' ? (quiet != null && quiet >= LIVE_TIMES.rateMs ? 0 : Math.round(a.rate)) : null
      return [
        phrase,
        a.tools ? `${a.tools} tool call${a.tools === 1 ? '' : 's'}` : '',
        a.tokens ? tokenWords(a.tokens) : '',
        rate != null ? `${rate} tokens/s` : '',
        quiet == null ? '' : quiet >= LIVE_TIMES.quietMs ? `quiet for ${quiet < 60_000 ? `${Math.floor(quiet / 1000)} s` : spanWords(quiet)}` : agoWords(quiet),
      ].filter(Boolean).join(' · ')
    }
    /**
     * A finished task's line, from its activity and the state it ended in: `Done in 7m 12s · 23 tool
     * calls · 41k tokens`, or `Stopped after 3m 05s · ...` for one that did not complete. Pure.
     */
    function doneLine(a, state = null) {
      const took = spanWords(a?.done?.ms ?? a?.elapsedMs)
      const head = state && state !== 'completed' && TERMINAL_TASK.includes(state) ? `${taskLabels[state]} after ${took}` : `Done in ${took}`
      return [head, a?.tools ? `${a.tools} tool call${a.tools === 1 ? '' : 's'}` : '', a?.tokens ? tokenWords(a.tokens) : ''].filter(Boolean).join(' · ')
    }
    /** Whether the newest of the work is under 5 s old, which the work board's dot pulses for. */
    const freshNow = (a, now = Date.now()) => !!a && !a.done && Number.isFinite(a.lastActivityAt) && now - a.lastActivityAt < LIVE_TIMES.freshMs

    /**
     * A GET /jev-router/live answer merged into what the view holds: each run's steps by id, a newer
     * version over an older one, in the order the run made them, those older than the run keeps
     * (`keptFrom`) let go but its `Older steps dropped` line; each run's attempts and summary as the
     * answer has them; and `v`, the version the next read asks after. `at` is when it came, for the
     * clock between reads. Pure.
     */
    function mergeLive(prev, body, at = Date.now()) {
      const runs = new Map((prev?.runs ?? []).map((r) => [r.runId, r]))
      for (const r of body?.runs ?? []) {
        if (!r || typeof r.runId !== 'string') continue
        const old = runs.get(r.runId)
        const byId = new Map((old?.items ?? []).map((it) => [it.id, it]))
        for (const it of r.items ?? []) { const was = byId.get(it.id); if (it && typeof it.id === 'string' && !(was?.v > it.v)) byId.set(it.id, it) }
        const keptFrom = r.keptFrom ?? old?.keptFrom ?? 1
        const items = [...byId.values()].filter((it) => it.id === 'dropped' || !(it.n < keptFrom)).sort((x, y) => (x.n ?? 0) - (y.n ?? 0))
        runs.set(r.runId, { ...old, ...r, keptFrom, items })
      }
      // The answer names a task's runs in the order they ran; one it left out keeps its place first.
      const named = (body?.runs ?? []).map((r) => r?.runId).filter((id) => runs.has(id))
      const order = [...[...runs.keys()].filter((id) => !named.includes(id)), ...named]
      return {
        v: Number.isFinite(body?.v) ? body.v : prev?.v ?? 0,
        runs: order.map((id) => runs.get(id)),
        done: !!body?.done, saved: !!(body?.saved || prev?.saved),
        patches: body?.patches ?? prev?.patches ?? {}, task: body?.task ?? prev?.task ?? null,
        fetchedAt: at,
      }
    }

    /**
     * A reasoning block as its preview shows it: what it has thought so far, which the view clips to
     * 120 px under a fade and keeps at its newest line as it streams, with Show all when there is more
     * than the preview holds; where only a count came, `Thinking... (about 1.2k tokens)`. Pure.
     */
    function reasoningPreview(item, { full = false } = {}) {
      const text = String(item?.text ?? '')
      if (!text.trim()) {
        const n = Number(item?.meta?.tokens)
        return { text: n > 0 ? `Thinking... (about ${tokenWords(n)})` : 'Thinking...', more: false }
      }
      const lines = text.split('\n')
      const before = item?.clippedBefore ? `… ${item.clippedBefore} characters before this are not shown here …\n` : ''
      return { text: full ? `${before}${text}` : lines.slice(-8).join('\n'), more: !full && (lines.length > 8 || text.length > 600 || !!item?.clippedBefore) }
    }

    // The roles an attempt can have that are not the work itself (router.js attempt_start).
    const SIDE_ROLES = { review: 'Review', opinion: 'Second opinion', plan: 'Plan' }
    /** An attempt's heading in the timeline: `Attempt 1 · Claude Code · work`, `Review · Codex`. Pure. */
    function attemptTitle(a, attempts = [a]) {
      const name = a?.name ?? a?.agent ?? 'the agent'
      if (SIDE_ROLES[a?.role]) return `${SIDE_ROLES[a.role]} · ${name}`
      if (a?.role === 'tool') return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
      const work = (attempts ?? []).filter((x) => x && !SIDE_ROLES[x.role] && x.role !== 'tool')
      const k = work.findIndex((x) => x === a || x.index === a?.index) + 1
      return `Attempt ${k || 1} · ${name} · work`
    }

    // Terminal control sequences: CSI (colours, cursor moves), OSC (titles, links) and the two-byte ones.
    const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
    /**
     * A command's output as its step shows it: colour and cursor codes stripped, Windows line ends read
     * as line ends, each carriage return applied as a terminal applies it (a progress bar keeps its last
     * state), and the last `max` lines kept, with how many went before them. Pure.
     */
    function cleanTerminal(raw, max = TERMINAL_LINES) {
      const lines = String(raw ?? '').replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map((l) => {
        let out = ''
        for (const part of l.split('\r')) out = part + out.slice(part.length)
        return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      })
      while (lines.length && !lines.at(-1)) lines.pop()
      return { text: lines.slice(-max).join('\n'), hidden: Math.max(0, lines.length - max) }
    }

    /**
     * The Live tab's header line from the merged view and the clock: `jev-3 · Claude Code ·
     * claude-opus-4-1 · effort high · 2m 14s · 18.2k tokens · last activity 2 s ago`. The time counts
     * each pass's own work, its time in line left out, and moves on between reads while it runs; the
     * last activity is left out while an agent works whose steps this build cannot hear. Pure.
     */
    function liveHeader(view, now = Date.now()) {
      const runs = view?.runs ?? []
      const last = runs.at(-1)
      if (!last) return view?.task?.jobId ?? ''
      const a = last.attempts?.at(-1)
      const s = last.summary ?? {}
      const done = !!view.done || !!s.done
      const elapsed = runs.reduce((t, r) => t + (r.summary?.elapsedMs ?? 0), 0) + (done ? 0 : Math.max(0, now - (view.fetchedAt ?? now)))
      const tokens = runs.reduce((t, r) => t + (r.summary?.tokens ?? 0), 0)
      const quiet = Number.isFinite(s.lastActivityAt) && s.heard !== false ? Math.max(0, now - s.lastActivityAt) : null
      const effort = a?.effort ?? s.effort
      return [view.task?.jobId ?? last.runId, a?.name ?? s.agent, a?.model ?? s.model, effort ? `effort ${effort}` : '', spanWords(elapsed), tokens ? tokenWords(tokens) : '', !done && quiet != null ? `last activity ${agoWords(quiet)}` : '']
        .filter(Boolean).join(' · ')
    }

    /**
     * The notes under the header, each only where it applies: what Codex and Claude Code share of their
     * thinking, detail that is off, a local model that does not think aloud, a saved transcript. Pure.
     */
    function liveNotes(view) {
      const attempts = (view?.runs ?? []).flatMap((r) => r.attempts ?? [])
      const off = new Map()
      for (const a of attempts) if (a.detail === 'off' && !off.has(a.name ?? a.agent)) off.set(a.name ?? a.agent, a.why)
      const heard = (provider) => attempts.some((a) => a.detail === 'live' && a.provider === provider)
      return [
        heard('codex') ? 'Codex shares its reasoning as short summaries.' : '',
        heard('claude-code') ? 'Claude Code shows thinking only when Claude shares it; text and tool calls always show.' : '',
        ...[...off].map(([name, why]) => `Live detail for ${name} is off${why ? `: ${why}` : ''}. You still see the router's steps, and the result posts as usual.`),
        attempts.some((a) => a.thinking === false) ? 'This local model runs with thinking off, so there is no reasoning to show.' : '',
        view?.saved ? 'Saved transcript (last 256 KB). The task\'s report is in the chat.' : '',
      ].filter(Boolean)
    }

    /**
     * A finished view's last line, `Finished: Completed in 4m 10s.`, in the words of how its task ended
     * (one stopped as it waited after its read pass reads `Stopped`, never that the pass handed it
     * back), or of how its run ended for a view of one run; '' while it runs. Pure.
     */
    function liveEndLine(view) {
      if (!view?.done) return ''
      const runs = view.runs ?? []
      const ms = runs.reduce((t, r) => t + (r.summary?.done?.ms ?? r.summary?.elapsedMs ?? 0), 0)
      const label = TERMINAL_TASK.includes(view.task?.state) ? taskLabels[view.task.state] : runs.at(-1)?.summary?.done?.label
      return !label ? 'Finished.' : runs.length ? `Finished: ${label} in ${spanWords(ms)}.` : `Finished: ${label}.`
    }

    /** A run's steps in sections: the router's lines before its first attempt, then one section per attempt with its usage. */
    function liveSections(run) {
      const attempts = run.attempts ?? []
      const sections = [{ key: 'routing', attempt: null, items: [] }, ...attempts.map((a) => ({ key: `a${a.index}`, attempt: a, items: [] }))]
      const byIndex = new Map(sections.filter((x) => x.attempt).map((x) => [x.attempt.index, x]))
      for (const it of run.items ?? []) {
        if (it.meta?.hidden) continue
        ;(byIndex.get(it.attempt) ?? sections[0]).items.push(it)
      }
      return sections.filter((x) => x.attempt || x.items.length)
    }

    /** What the Live tab is opened on: `{ task }` or `{ run }`, from its params; null for the picker. */
    const liveTarget = (p) => (typeof p?.task === 'string' && p.task ? { task: p.task } : typeof p?.run === 'string' && p.run ? { run: p.run } : null)

    // ---- end pure live helpers

    /** Open the Live tab on a task or a run. Never throws: with no right sidebar a toast says why. */
    const openLive = (target) => { try { openPanel(LIVE_KIND, target ?? undefined) } catch (e) { toast(e.message) } }

    /**
     * One task's or run's live view, read every 700 ms while `visible`, asking each time only for what
     * changed since the last read and merging it in; it stops once the work has ended (or the read is
     * refused as not there), and while the page is hidden it reads nothing until it is shown again.
     */
    function useLive(target, visible, every = 700) {
      const q = target?.task ? `task=${encodeURIComponent(target.task)}` : target?.run ? `run=${encodeURIComponent(target.run)}` : ''
      const [state, setState] = useState({ q: '', view: null, error: '' })
      const held = useRef(state)
      held.current = state.q === q ? state : { q, view: null, error: '' }
      useEffect(() => {
        if (!visible || !q) return
        let stop = false
        let timer = null
        const wake = () => { if (!document.hidden && !stop && !timer) { document.removeEventListener?.('visibilitychange', wake); tick() } }
        const tick = async () => {
          timer = null
          if (stop) return
          // Hidden: nothing is read until the page is shown again.
          if (document.hidden) { document.addEventListener?.('visibilitychange', wake); return }
          const was = held.current.q === q ? held.current.view : null
          try {
            const body = await api(`/jev-router/live?${q}&after=${was?.v ?? 0}`)
            if (stop) return
            const view = mergeLive(was, body)
            held.current = { q, view, error: '' }
            setState(held.current)
            if (body.done) return
          } catch (e) {
            if (stop) return
            const gone = e.status === 404 ? `This ${target?.task ? 'task is no longer in the task list' : 'run is no longer kept'}, so there is nothing to show.` : e.message
            held.current = { q, view: was, error: gone }
            setState(held.current)
            if (e.status === 400 || e.status === 404) return
          }
          timer = setTimeout(tick, every)
        }
        tick()
        return () => { stop = true; clearTimeout(timer); document.removeEventListener?.('visibilitychange', wake) }
      }, [q, visible, every])
      return held.current
    }

    // One /tasks reader for every card under a start reply and the Live tab's picker, held while any
    // of them needs it: a chat with many start replies still reads the list once a second, not once
    // per card. `at` is when the list was read.
    const tasksFeed = (() => {
      const store = makeStore({ tasks: null, at: 0 })
      let holders = 0
      let running = false
      let timer = null
      const tick = async () => {
        timer = null
        if (!holders) { running = false; return }
        if (!document.hidden) { try { const d = await api('/jev-router/tasks'); store.set({ tasks: d.tasks ?? [], at: Date.now() }) } catch {} }
        if (!holders) { running = false; return }
        timer = setTimeout(tick, 1000)
      }
      return {
        store,
        /** Hold the reader; the function returned lets it go, once. */
        hold() {
          holders++
          if (!running) { running = true; tick() }
          let held = true
          return () => {
            if (!held) return
            held = false
            if (--holders === 0 && timer) { clearTimeout(timer); timer = null; running = false }
          }
        },
      }
    })()
    /** Every task as the shared reader last read them (null before its first read), held while `active`. */
    function useTasksFeed(active) {
      const { tasks, at } = tasksFeed.store.use()
      useEffect(() => (active ? tasksFeed.hold() : undefined), [active])
      return { tasks, at }
    }

    /** Whether an element is on screen, by an IntersectionObserver; true where there is none to ask. */
    function useOnScreen(ref, key) {
      const [on, setOn] = useState(true)
      useEffect(() => {
        const el = ref.current
        if (!el || typeof IntersectionObserver !== 'function') return
        const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)))
        io.observe(el)
        return () => io.disconnect()
      }, [key])
      return on
    }

    const stepGlyph = (state) => (state === 'running' ? '…' : state === 'failed' ? '✕' : '✓')
    /** One step as a row: its state's glyph, then its words. */
    const stepRow = (key, state, title) => h('div', { key, className: cx('kzh-live-row', state) },
      h('span', { className: 'g', 'aria-hidden': true }, stepGlyph(state)),
      h('span', { className: 't' }, title))

    /**
     * A running task's last six live steps and the way to watch it, for its row in the Tasks tab; null
     * for a task that is waiting, finished, or not followed live.
     */
    function liveTail(t) {
      const a = t?.activity
      if (!t?.key || !a || a.done || !LIVE_TASK.includes(t.state) || t.state === 'queued') return null
      const recent = Array.isArray(a.recent) ? a.recent.slice(-6) : []
      return h('div', { className: 'kzh-live-tail' },
        recent.length ? h('div', { role: 'list', 'aria-label': 'Latest steps' }, ...recent.map((r, i) => h('div', { key: i, role: 'listitem' }, stepRow(`r${i}`, r.state, r.title))))
          : h('div', { className: 'answer-text' }, a.phrase ?? ''),
        h('a', { className: 'link', role: 'button', tabIndex: 0, onClick: () => openLive({ task: t.key }), onKeyDown: (k) => { if (k.key === 'Enter') openLive({ task: t.key }) } }, 'Open live view'))
    }

    /**
     * A step of the timeline: the router's lines grey, thinking as a preview, text as Markdown, tools,
     * commands and edits as rows, and the person's words (Steer) as a bubble saying what became of them,
     * as task `t`'s row has it now, with Copy and Send as a follow-up for words it ended without.
     */
    function liveStep(it, { expanded, toggle, t = null }) {
      const key = it.id
      const all = expanded.has(key)
      if (it.kind === 'steer') {
        const piece = (t?.steers ?? []).find((x) => x?.id === it.meta?.steer) ?? null
        const words = piece?.words || it.meta?.words || ''
        return h('div', { key, className: 'kzh-live-you' },
          h('div', { className: 't' }, it.title),
          words ? h('div', { className: 'why' }, words) : null,
          piece?.state === 'returned' && t ? h(GuidanceActions, { t, text: piece.text }) : null)
      }
      if (it.router || it.kind === 'status' || it.kind === 'error') {
        return h('div', { key, className: cx('kzh-live-ms', it.kind === 'error' && 'bad') }, it.title, it.text ? h('div', { className: 'why' }, it.text) : null)
      }
      if (it.kind === 'reasoning') {
        const p = reasoningPreview(it, { full: all })
        return h('div', { key, className: cx('kzh-live-think', !all && 'clip') },
          h('div', { className: 'kzh-live-think-t' }, p.text),
          p.more || all ? h('button', { type: 'button', className: 'linkish', onClick: () => toggle(key) }, all ? 'Show less' : 'Show all') : null)
      }
      if (it.kind === 'text') return h('div', { key }, h(Markdown, { className: 'kzh-live-text', text: it.text ?? '' }))
      if (it.kind === 'command') {
        const out = cleanTerminal(it.text)
        // Open while it runs, folded once it ends with its output's last lines inside. A spawn child's
        // command has no output before then: its session commits nothing between a call and its result.
        return h('details', { key, className: 'kzh-live-step', open: it.state === 'running' },
          h('summary', null, stepRow('s', it.state, it.title)),
          out.text ? h('pre', { className: 'kzh-live-out' }, out.hidden ? `… ${out.hidden} earlier lines …\n` : '', out.text) : null)
      }
      if (it.kind === 'file' || it.kind === 'plan') {
        const lines = String(it.text ?? '').split('\n')
        const shown = all ? lines : lines.slice(0, DIFF_LINES)
        return h('details', { key, className: 'kzh-live-step' },
          h('summary', null, stepRow('s', it.state, it.title)),
          it.text ? h('pre', { className: 'kzh-live-out' }, ...shown.map((l, i) => h('span', { key: i, className: it.kind === 'file' && /^\+(?!\+\+)/.test(l) ? 'add' : it.kind === 'file' && /^-(?!--)/.test(l) ? 'del' : undefined }, `${l}\n`))) : null,
          lines.length > DIFF_LINES ? h('button', { type: 'button', className: 'linkish', onClick: () => toggle(key) }, all ? 'Show less' : `Show all ${lines.length} lines`) : null)
      }
      return stepRow(key, it.state, it.title)
    }

    /**
     * The Live tab: a task's or a run's work as it streams, one section per attempt, with Follow, Open
     * full session and Stop; with neither, a picker of this chat's tasks, the live ones first.
     */
    function LivePane({ useTabInfo, sessionId }) {
      useStyle()
      const info = useTabInfo?.()
      const visible = info?.tab?.visible ?? true
      // Openers name the task or run: openTab(LIVE_KIND, { params: { task } }); revision steps on every re-open.
      const nav = info?.tab?.navigation
      const [target, setTarget] = useState(() => liveTarget(nav?.params))
      useEffect(() => { const t = liveTarget(nav?.params); if (t) setTarget(t) }, [nav?.revision, nav?.params?.task, nav?.params?.run])
      const { tasks } = useTasksFeed(visible)
      const { view, error } = useLive(target, visible)
      const mine = (tasks ?? []).filter((t) => t.sessionId === sessionId && t.key)
      // The clock moves while what is shown can change: a view still being read, or a picker with a
      // live task, whose line says how long it has been quiet.
      const now = useNow(visible && (target ? !view?.done : mine.some((t) => LIVE_TASK.includes(t.state))))
      const [follow, setFollow] = useState(true)
      const [expanded, setExpanded] = useState(() => new Set())
      // null, { jobId, word } of the task being stopped or removed, with the word its button said, or
      // the words of a run's Stop as it was pressed.
      const [confirm, setConfirm] = useState(null)
      const [err, setErr] = useState('')
      const scroller = useRef(null)
      // Following: each read lands at the newest step.
      useEffect(() => { const el = scroller.current; if (follow && el) el.scrollTop = el.scrollHeight }, [follow, view])
      // A dialog never changes what its button does: one whose task started, ended or went back to
      // waiting meanwhile closes and says so, as the work board's does.
      const drift = confirmDrift(tasks, confirm, now)
      useEffect(() => { if (drift) { setConfirm(null); setErr(drift) } }, [drift])
      const queue = useQueueControls(tasks, setErr)
      const toggle = (key) => setExpanded((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
      const act = (fn) => { setErr(''); Promise.resolve().then(fn).catch((e) => setErr(e.message)) }
      if (!target) {
        const liveOnes = mine.filter((t) => LIVE_TASK.includes(t.state))
        const finished = mine.filter((t) => TERMINAL_TASK.includes(t.state)).sort((x, y) => (y.finishedAt ?? 0) - (x.finishedAt ?? 0)).slice(0, 10)
        // A waiting task says what it waits for, as its work board row does: a read pass that handed it
        // back to its line has ended, but its work has not. A row here has no Stop, only Watch, so a
        // stall's words do not say Stop is on it.
        const why = (t) => (t.state === 'queued' ? taskRowModel(t, now).wait || taskLabels.queued
          : [taskLabels[t.state] ?? t.state, t.activity ? activityLine(t.activity, now, t.state, { stopHere: false }) : ''].filter(Boolean).join(' · '))
        const pick = (t) => h('li', { key: t.key },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'title' }, taskRowModel(t, now).title || 'Untitled task'),
            h('div', { className: 'why' }, why(t))),
          h('button', { type: 'button', className: 'btn', 'aria-label': `Watch ${taskRowModel(t, now).title || 'this task'}`, onClick: () => setTarget({ task: t.key }) }, 'Watch'))
        return h('div', { className: 'jevi kzh-live' },
          h('h3', null, 'Live'),
          liveOnes.length ? h('ul', { className: 'plain', 'aria-label': 'Live tasks' }, ...liveOnes.map(pick))
            : h('div', { className: 'empty' }, 'Nothing is running in this chat. When a task starts you can watch it here.'),
          finished.length ? h('div', { className: 'label', style: { marginTop: 12 } }, 'Recently finished') : null,
          finished.length ? h('ul', { className: 'plain', 'aria-label': 'Recently finished tasks' }, ...finished.map(pick)) : null)
      }
      const t = target.task ? mine.find((x) => x.key === target.task) ?? (tasks ?? []).find((x) => x.key === target.task) : null
      const runs = view?.runs ?? []
      const child = runs.at(-1)?.child ?? null
      const childOf = view?.task?.sessionId ?? t?.sessionId ?? sessionId
      const canStop = target.task ? !!t && LIVE_TASK.includes(t.state) : !!view && !view.done
      // A task's button says Remove while it waits in line, as its row does, and its dialog is worded
      // from the row each time it renders (confirmFor); a run's is asked about as it was when pressed.
      const stopWord = t ? taskRowModel(t, now).stopWord : 'Stop'
      const ask = () => setConfirm(t ? { jobId: t.jobId, word: stopWord } : { ...stopOneWords({ title: 'this run', stopWord: 'Stop' }), run: () => post('/jev-router/runs/stop', { runId: target.run }) })
      const shown = confirm?.jobId ? confirmFor(tasks, confirm.jobId, Date.now(), confirm.word) : confirm
      const end = liveEndLine(view)
      return h('div', { className: 'jevi kzh-live' },
        h('div', { className: 'head' },
          h('h3', null, t ? taskRowModel(t, now).title || 'Live' : 'Live'),
          h('button', { type: 'button', className: 'linkish', onClick: () => setTarget(null) }, 'All tasks')),
        h('div', { className: 'kzh-live-hd' }, liveHeader(view, now) || (t ? taskRowModel(t, now).detail : '')),
        ...liveNotes(view).map((n, i) => h('div', { key: `n${i}`, className: 'kzh-live-note' }, n)),
        h('div', { className: 'kzh-live-bar' },
          h('button', { type: 'button', className: 'btn', 'aria-pressed': follow, onClick: () => setFollow(!follow) }, 'Follow'),
          !follow ? h('button', { type: 'button', className: 'btn', onClick: () => setFollow(true) }, 'Jump to latest') : null,
          child && sessionsApi?.openSubagent ? h('button', { type: 'button', className: 'btn', onClick: () => act(() => sessionsApi.openSubagent({ parentSessionId: childOf, childSessionId: child.id, mode: 'one-shot', ...(child.label ? { label: child.label } : {}) })) }, 'Open full session') : null,
          ...queueActions(t).map((a) => h('button', { key: a, type: 'button', className: 'btn', 'aria-label': queueLabel(a, t), onClick: () => queue.open(a, t) }, a === 'send' ? 'Send now' : 'Steer…')),
          canStop ? h('button', { type: 'button', className: 'btn danger', onClick: ask }, stopWord) : null),
        error ? h('div', { className: 'err', role: 'alert' }, error) : null,
        err ? h('div', { className: 'err', role: 'alert' }, err) : null,
        h('div', {
          className: 'kzh-live-tl', ref: scroller, 'aria-live': 'off',
          // Scrolling up to read turns Follow off; Jump to latest turns it back on.
          onScroll: (e) => { const el = e.currentTarget ?? e.target; if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollow(false) },
        },
          !view ? h('div', { className: 'empty' }, error ? '' : t?.state === 'queued' ? taskRowModel(t, now).detail : 'Loading…')
            : !runs.length ? h('div', { className: 'empty' }, t?.state === 'queued' ? taskRowModel(t, now).detail : 'Nothing to show yet.')
              : runs.map((run, ri) => h('div', { key: run.runId },
                runs.length > 1 ? h('div', { className: 'label' }, `Pass ${ri + 1} of ${runs.length}${run.summary?.done?.status === 'needs_write' ? ': read only, handed back to write' : ''}`) : null,
                ...liveSections(run).map((sec) => h('section', { key: sec.key, className: 'kzh-live-sec' },
                  sec.attempt ? h('h4', null, attemptTitle(sec.attempt, run.attempts)) : null,
                  ...sec.items.map((it) => liveStep(it, { expanded, toggle, t })),
                  sec.attempt?.tokens?.total ? h('div', { className: 'kzh-live-use' }, `Usage: ${tokenWords(sec.attempt.tokens.input)} in, ${tokenWords(sec.attempt.tokens.output)} out`) : null)))),
          end ? h('div', { className: 'kzh-live-end' }, end) : null),
        // Steer from here: the words go to the task at work, or onto it before it starts. One box per
        // task, so words typed for one never stay in it as the tab turns to another.
        t ? h(LiveComposer, { key: t.key, t, say: setErr }) : null,
        shown ? h(Confirm, {
          title: shown.title, body: shown.body, confirmLabel: shown.confirmLabel,
          onCancel: () => setConfirm(null),
          onConfirm: () => { setConfirm(null); act(shown.run) },
        }) : null,
        queue.dialog)
    }

    /**
     * The card under a start reply (a message with a `[jev-job]` mark): who works on the task, what it
     * does now and its last tool calls, Open live view and Stop; once it ends, how it went. Here it only
     * reads the message's text, as AgentStrip does, so a reply with no mark, as most are, renders nothing
     * and is kept out of the shared task list's every read (LiveTaskCard reads that).
     */
    function LiveRunCard({ messageId, useChat }) {
      const text = useChat((s) => messageText(s.legacy.nodes, messageId))
      const key = JOB_MARK.exec(String(text ?? ''))?.[1] ?? null
      return key ? h(LiveTaskCard, { taskKey: key }) : null
    }

    /**
     * The card of the task a start reply names (LiveRunCard): it reads the shared task list while the
     * task can still change, and the task's steps only while the task is live and the card is on screen.
     */
    function LiveTaskCard({ taskKey: key }) {
      useStyle()
      const root = useRef(null)
      const since = useRef(Date.now())
      // The list is read while the task can still change, and let go once it has ended or left the list.
      const [settled, setSettled] = useState(false)
      const { tasks, at } = useTasksFeed(!settled)
      const t = (tasks ?? []).find((x) => x.key === key) ?? null
      const live = !!t && LIVE_TASK.includes(t.state)
      useEffect(() => { if (tasks && at > since.current && !live) setSettled(true) }, [tasks, at, live])
      const onScreen = useOnScreen(root, t ? key : '')
      // Its steps are read while it is live and on screen, and once more after it ends if they were
      // being read, for the last of them.
      const seen = useRef(null)
      const { view } = useLive({ task: key }, onScreen && (live || (!!seen.current && !seen.current.done)))
      seen.current = view
      const now = useNow(live)
      // null, or { jobId, word } of the task being stopped or removed, with the word its button said.
      const [confirm, setConfirm] = useState(null)
      const [err, setErr] = useState('')
      // A dialog never changes what its button does: one whose task started, ended or went back to
      // waiting meanwhile closes and says so, as the work board's does.
      const drift = confirmDrift(tasks, confirm, now)
      useEffect(() => { if (drift) { setConfirm(null); setErr(drift) } }, [drift])
      const queue = useQueueControls(tasks, setErr)
      if (!t) return null
      const a = t.activity ?? null
      const name = a?.agent ?? (t.agent ? agentLabel(t.agent) : '')
      const steps = (view?.runs ?? []).flatMap((r) => r.items ?? []).filter((it) => !it.meta?.hidden && !it.router && ['tool', 'command', 'file', 'plan'].includes(it.kind)).slice(-8)
      const m = taskRowModel(t, now)
      // Waiting keeps the wait words; a run that has ended says how it went; one at work says what it
      // does now and for how long, until which it is starting.
      const doing = t.state === 'queued' ? m.wait || m.detail
        : a?.done ? doneLine(a, t.state)
          : !live ? m.reason || m.label
            : a ? [stallWords({ open: a.open, lastAgentAt: a.lastAgentAt, agent: a.agent, live: a.live, busy: a.busy }, now) || a.phrase, spanWords(a.elapsedMs + Math.max(0, now - (at || now)))].filter(Boolean).join(' · ')
              : `Starting ${name || 'the agent'}...`
      const who = [name, a?.model ?? t.model, (a?.effort ?? t.effort) ? `effort ${a?.effort ?? t.effort}` : ''].filter(Boolean).join(' · ')
      return h('div', { className: 'kzh-lrc', ref: root, role: 'group', 'aria-label': `Live: ${m.title || 'task'}` },
        h('div', { className: 'kzh-lrc-hd' },
          h('span', { className: 'kzh-lrc-av', 'aria-hidden': true }, (name || '?').charAt(0).toUpperCase()),
          h('span', { className: 'kzh-lrc-name', title: m.title }, m.title || 'Task')),
        who ? h('div', { className: 'kzh-lrc-who' }, `${who}${a?.tools ? ` (${a.tools} tool call${a.tools === 1 ? '' : 's'})` : ''}`) : null,
        // Not a live region: its clock moves every second, and announcing each would bury what matters.
        h('div', { className: 'kzh-lrc-now' }, doing),
        steps.length ? h('div', { className: 'kzh-lrc-rows', role: 'list', 'aria-label': 'Latest tool calls' }, ...steps.map((it) => h('div', { key: it.id, role: 'listitem' }, stepRow('r', it.state, it.title)))) : null,
        h(GuidanceList, { t }),
        err ? h('div', { className: 'kzh-wb-err', role: 'alert' }, err) : null,
        h('div', { className: 'kzh-lrc-acts' },
          h('button', { type: 'button', onClick: () => openLive({ task: key }) }, 'Open live view'),
          ...queueActions(t).map((q) => h('button', { key: q, type: 'button', 'aria-label': queueLabel(q, t), onClick: () => queue.open(q, t) }, q === 'send' ? 'Send now…' : 'Steer…')),
          live ? h('button', { type: 'button', className: 'danger', onClick: () => setConfirm({ jobId: t.jobId, word: m.stopWord }) }, m.stopWord) : null),
        confirm ? (() => {
          const words = confirmFor(tasks, confirm.jobId, Date.now(), confirm.word)
          if (!words) return null
          return h(Confirm, {
            title: words.title, body: words.body, confirmLabel: words.confirmLabel,
            onCancel: () => setConfirm(null),
            onConfirm: () => { setConfirm(null); setErr(''); Promise.resolve().then(words.run).catch((e) => setErr(e.message)) },
          })
        })() : null,
        queue.dialog)
    }

    // ---------- accounts, usage, limits ----------
    // Names come from the server's live catalog, never a table in here: a provider,
    // model or agent added later names itself. The id shows until they arrive.
    const names = makeStore({ providers: {}, models: {}, agents: {} })
    let namesAsked = false
    const loadNames = () => {
      if (namesAsked) return
      namesAsked = true
      api('/jev-router/names').then((d) => names.set(d), () => { namesAsked = false })
    }
    const agentLabel = (id) => names.get().agents[id] ?? id
    const providerLabel = (p) => names.get().providers[p] ?? p
    const modelLabel = (provider, model) => (model ? names.get().models[`${provider}/${model}`] ?? model : '')
    const WINDOW = { '5h': '5-hour window', weekly: 'Weekly window' }
    /** "14:05" today, "Mon 14:05" otherwise. */
    const when = (t) => {
      if (t == null) return ''
      const d = new Date(t)
      if (Number.isNaN(d.getTime())) return ''
      const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`
    }
    const STATE = { ok: ['ok', 'on', 'OK'], near: ['warn', 'warn', 'Near limit'], stopped: ['bad', 'off', 'Stopped'], exhausted: ['bad', 'off', 'Out'] }
    const stateInfo = (u) => {
      const [pill, dot, text] = STATE[u?.state] ?? ['', '', 'Unknown']
      const until = STATE[u?.state]?.[0] === 'bad' && u.until ? ` until ${when(u.until)}` : ''
      return { pill, dot, text: text + until }
    }
    // Server may still return the snapshot as a map; accept both.
    const usageAgents = (usage) => {
      const a = usage?.agents
      return Array.isArray(a) ? a : Object.entries(a ?? {}).map(([id, v]) => ({ id, ...v }))
    }
    const usageById = (usage) => Object.fromEntries(usageAgents(usage).map((a) => [a.id, a]))
    const money = (b) => (b && b.amount != null ? `${b.amount} ${b.currency ?? ''}`.trim() : null)
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })

    function useUsage(visible) {
      const [usage, setUsage] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const load = useCallback(async (force) => {
        setBusy(true)
        try { setUsage(await api(`/jev-router/usage${force ? '?force=1' : ''}`)); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) }
      }, [])
      useEffect(() => {
        if (!visible) return
        load(false)
        const t = setInterval(() => { if (!document.hidden) load(false) }, 30000)
        return () => clearInterval(t)
      }, [visible, load])
      return { usage, error, busy, load }
    }

    /** One on/off chip per agent with its quota state; the last one on can't go off. */
    function AgentChips({ agents, usage, busy, onToggle }) {
      if (!agents?.length) return null
      const u = usageById(usage)
      const onCount = agents.filter((a) => a.enabled).length
      return h('div', { className: 'chips', role: 'group', 'aria-label': 'Agents Jev may use' }, ...agents.map((a) => {
        const lastOn = a.enabled && onCount === 1
        const st = stateInfo(u[a.id])
        const label = agentLabel(a.id)
        return h('button', {
          key: a.id, type: 'button', className: cx('chip', a.enabled && 'on'), 'aria-pressed': !!a.enabled,
          'aria-disabled': lastOn || undefined, disabled: busy, 'aria-label': `${label}, ${st.text}`,
          title: lastOn ? 'At least one LLM must stay on' : `${label} is ${a.enabled ? 'on' : 'off'} · ${st.text}. Click to switch ${a.enabled ? 'off' : 'on'}.`,
          onClick: () => { if (!lastOn) onToggle(a.id, !a.enabled) },
        }, h('span', { className: cx('dot', st.dot), 'aria-hidden': true }), label)
      }))
    }

    function LimitInput({ agentId, field, label, value, percent, onSaved }) {
      const [v, setV] = useState(value ?? '')
      const [dirty, setDirty] = useState(false)
      const [msg, setMsg] = useState('')
      // What we last wrote. `value` arrives from the usage poll, which can still be carrying
      // the old number for up to its interval after a save. Without this the field snapped
      // back to the old figure the moment it saved, which reads as "Enter did nothing".
      const justSaved = useRef(null)
      useEffect(() => {
        if (dirty) return
        if (justSaved.current !== null && Number(value) !== justSaved.current) return
        justSaved.current = null
        setV(value ?? '')
      }, [value, dirty])
      const save = async () => {
        if (!dirty) return
        const n = Number(v)
        if (v === '' || !Number.isFinite(n) || n < 0 || (percent && n > 100)) { setMsg(percent ? 'Enter 0-100' : 'Enter a number ≥ 0'); return }
        setMsg('Saving…')
        try {
          await post('/jev-router/limits', { agentId, [field]: n })
          justSaved.current = n
          setDirty(false)
          setMsg('Saved')
          // Pull the stored value straight back so the card reflects it now, not at the next
          // poll. Not a forced read: limits live in the local accounts file, not upstream.
          onSaved?.()
        } catch (e) { setMsg(e.message) }
      }
      const id = `jevi-lim-${agentId}-${field}`
      return h('label', { htmlFor: id }, label,
        h('input', { id, type: 'number', min: 0, max: percent ? 100 : undefined, step: percent ? 1 : 0.01, value: v,
          onChange: (e) => { setV(e.target.value); setDirty(true); setMsg('') }, onBlur: save, onKeyDown: (e) => { if (e.key === 'Enter') save() } }),
        h('span', { className: cx('saved', msg && msg !== 'Saved' && msg !== 'Saving…' && 'bad'), 'aria-live': 'polite' }, msg))
    }

    /**
     * Sign in and out of an agent that owns its own credentials. KzH never handles the
     * credentials: sign-in opens the CLI's own flow in a terminal, with the person there.
     * Sign-out clears a stored login, so it is confirmed first and names the account.
     */
    function AuthButtons({ a, account, onDone }) {
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [confirm, setConfirm] = useState(false)
      const go = async (action) => {
        setBusy(action)
        setMsg('')
        try {
          const r = await post('/jev-router/account-auth', { agentId: a.id, action })
          setMsg(r?.detail ?? 'done')
          onDone?.()
        } catch (e) { setMsg(e.message) } finally { setBusy('') }
      }
      const signedIn = a.account?.email || a.account?.label || a.state === 'ok'
      return h('div', { className: 'why', style: { marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
        h('button', { className: 'link', disabled: !!busy, onClick: () => go('login') }, busy === 'login' ? 'Opening…' : signedIn ? 'Sign in again' : 'Sign in'),
        signedIn ? h('button', { className: 'link', disabled: !!busy, onClick: () => setConfirm(true) }, busy === 'logout' ? 'Signing out…' : 'Sign out') : null,
        msg ? h('span', { 'aria-live': 'polite' }, msg) : null,
        confirm ? h(Confirm, {
          title: `Sign out of ${agentLabel(a.id)}?`,
          body: `This clears the stored login${account ? ` for ${account}` : ''} on this PC. Jev will stop routing work to ${agentLabel(a.id)} until you sign in again. Nothing on the provider's side is changed.`,
          confirmLabel: 'Sign out',
          onCancel: () => setConfirm(false),
          onConfirm: () => { setConfirm(false); go('logout') },
        }) : null)
    }

    function KeyStates({ list }) {
      return h('ul', { className: 'plain' }, ...list.map((k) => {
        const st = stateInfo(k)
        return h('li', { key: k.name },
          h('span', null, h('span', { className: cx('dot', st.dot) }), h('b', null, k.name), k.active ? h('span', { className: 'pill ok' }, 'active') : null),
          h('span', { className: 'why' }, [money(k.balance), typeof k.spentUsd === 'number' ? `$${k.spentUsd.toFixed(2)} this month` : null, k.state ? st.text : null].filter(Boolean).join(' · ')))
      }))
    }

    function UsageCard({ a, keys, links, onSaved }) {
      // Where to get a key and where to pay, per provider. Opened in the person's own browser.
      const link = links?.[a.keyProvider] ?? null
      const st = stateInfo(a)
      // A key made active since launch is used only after a restart (usage.js pendingKey).
      const acct = [a.account?.email ?? a.account?.label, a.account?.pendingKey ? `${a.account.pendingKey} after Restart harness` : null].filter(Boolean).join(', ')
      const L = a.limits ?? {}
      const fields = a.kind === 'local' ? [] : a.id === 'jev' ? [['monthlyBudgetUsd', 'Monthly budget ($)', false]] : a.kind === 'subscription'
        ? [['handoffAtPercent', 'Handoff at %', true], ['stopAtPercent', 'Stop at %', true]]
        : [
          // Soft first, then the hard floor: the order they fire in.
          ['handoffAtBalance', `Hand over below${a.balance?.currency ? ` (${a.balance.currency})` : ''}`, false],
          ['minBalance', `Stop below${a.balance?.currency ? ` (${a.balance.currency})` : ''}`, false],
        ]
      return h('div', { className: 'card' },
        h('div', { className: 'head' },
          h('div', { style: { minWidth: 0 } }, h('b', null, agentLabel(a.id)), acct ? h('span', { className: 'why' }, ` · ${acct}`) : null),
          h('span', { className: cx('pill', st.pill) }, st.text)),
        ...(a.windows ?? []).map((w) => {
          const used = Math.max(0, Math.min(100, Number(w.usedPercent) || 0))
          const name = WINDOW[w.name] ?? w.name
          return h('div', { className: 'opt', key: w.name },
            h('div', { className: 'row' }, h('span', null, name), h('span', null, `${Math.round(used)}% used${w.resetsAt ? ` · resets ${when(w.resetsAt)}` : ''}`)),
            h('div', { className: 'bar', role: 'progressbar', 'aria-label': name, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(used) },
              h('i', { className: used >= (L.stopAtPercent ?? 97) ? 'bad' : used >= (L.handoffAtPercent ?? 85) ? 'warn' : '', style: { width: `${used}%` } })))
        }),
        money(a.balance) ? h('div', { style: { marginTop: 6 } }, 'Balance ', h('b', null, money(a.balance)),
          typeof a.creditPercent === 'number' ? h('span', { className: 'why' }, ` · ${a.creditPercent}% of ${money(a.creditPeak) ?? 'your top-up'} left`) : null) : null,
        // Credit left, against the most this key has ever held; a top-up raises the mark.
        typeof a.creditPercent === 'number' ? h('div', {
          className: 'bar', role: 'progressbar', 'aria-label': 'Credit left',
          'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': a.creditPercent, style: { marginTop: 4 },
        }, h('i', { className: a.creditPercent <= 10 ? 'bad' : a.creditPercent <= 25 ? 'warn' : '', style: { width: `${a.creditPercent}%` } })) : null,
        // Providers that bill by the clock (DeepSeek): which rate is running right now.
        a.rateNow ? h('div', { className: 'why', style: { marginTop: 6 } },
          // Anchored on purpose. An unanchored /off-peak/ matched the dear reading too, because
          // it explains itself as "twice its off-peak price", so the badge said off-peak while
          // its own sentence said the opposite. The state is the first word or it is not read.
          h('span', { className: cx('pill', /^off-peak/.test(a.rateNow) ? 'ok' : 'warn') }, /^off-peak/.test(a.rateNow) ? 'off-peak' : 'peak rate'),
          ' ', a.rateNow.replace(/^(off-peak|peak) rate\s*/, '')) : null,
        typeof a.spentUsd === 'number' ? h('div', { style: { marginTop: 6 } },
          'Spent this month ', h('b', null, `$${a.spentUsd < 0.01 && a.spentUsd > 0 ? a.spentUsd.toFixed(4) : a.spentUsd.toFixed(2)}`),
          a.limits?.monthlyBudgetUsd ? h('span', { className: 'why' }, ` of $${a.limits.monthlyBudgetUsd}`) : null) : null,
        // Spend against the budget, not a balance: this provider publishes no balance to read.
        typeof a.spentUsd === 'number' && a.limits?.monthlyBudgetUsd > 0 ? (() => {
          const used = Math.max(0, Math.min(100, (a.spentUsd / a.limits.monthlyBudgetUsd) * 100))
          return h('div', {
            className: 'bar', role: 'progressbar', 'aria-label': 'Budget used this month',
            'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(used), style: { marginTop: 4 },
          }, h('i', { className: used >= 90 ? 'bad' : used >= 70 ? 'warn' : '', style: { width: `${used}%` } }))
        })() : null,
        keys?.length ? h(KeyStates, { list: keys }) : null,
        a.canSignIn ? h(AuthButtons, { a, account: acct, onDone: onSaved }) : null,
        link && (link.topUp || link.keys) ? h('div', { className: 'why', style: { marginTop: 6, display: 'flex', gap: 10 } },
          link.topUp ? h('a', { className: 'link', href: link.topUp, target: '_blank', rel: 'noreferrer noopener' }, 'Top up') : null,
          link.keys ? h('a', { className: 'link', href: link.keys, target: '_blank', rel: 'noreferrer noopener' }, 'Get an API key') : null) : null,
        fields.length ? h('div', { className: 'limits' }, ...fields.map(([k, label, percent]) => h(LimitInput, { key: k, agentId: a.id, field: k, label, percent, value: L[k], onSaved }))) : null,
        a.error ? h('div', { className: 'err' }, a.error) : a.state === 'unknown' || !a.state ? h('div', { className: 'why', style: { marginTop: 6 } }, 'Usage not known yet.') : null)
    }

    function Recent({ rows }) {
      return h('div', { className: 'card' },
        h('div', { className: 'label' }, 'Recent runs'),
        rows.length ? h('ul', { className: 'plain' }, ...rows.slice().reverse().map((r, i) => h('li', { key: i },
          h('div', { style: { minWidth: 0 } },
            h('b', null, agentLabel(r.agent)), r.role || r.phase ? h('span', { className: 'pill' }, r.role ?? r.phase) : null,
            r.limitHit ? h('span', { className: 'pill bad' }, 'limit hit') : null,
            // A task of the capability benchmark is real usage, kept apart from the person's own runs.
            r.purpose === 'benchmark' ? h('span', { className: 'pill', title: 'A task of the capability benchmark: real usage, left out of Saved by Jev and of the estimates of your own runs' }, 'benchmark') : null,
            r.account ? h('div', { className: 'why' }, r.account) : null),
          h('span', { className: 'why', style: { textAlign: 'right' } }, [
            when(r.ts), r.durationMs != null ? ms(r.durationMs) : null,
            r.model ? modelLabel(r.provider, r.model) : null,
            r.tokens ? `${r.tokens.input ?? 0} in / ${r.tokens.output ?? 0} out tok` : null,
            typeof r.costUsd === 'number' ? `$${r.costUsd.toFixed(4)}` : null,
          ].filter(Boolean).join(' · '))))) : h('div', { className: 'muted' }, 'No agent runs logged yet.'))
    }

    // "Saved by Jev": an estimate against a chat LLM front desk; the server does the math, this only formats it.
    const minus = (x) => (x < 0 ? '−' : '')
    const usd = (x) => `${minus(x)}$${Math.abs(x).toFixed(Math.abs(x) >= 1 || x === 0 ? 2 : 4)}`
    const hms = (n) => {
      let s = Math.round(Math.abs(n) / 1000)
      const hh = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); s %= 60
      return minus(n) + [hh && `${hh}h`, (hh || mm) && `${mm}m`, `${s}s`].filter(Boolean).join(' ')
    }
    const count = (n) => new Intl.NumberFormat(undefined, { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n)
    const PERIODS = [['today', 'Today'], ['week', '7 days'], ['all', 'All']]
    function SavingsCard({ savings }) {
      const [period, setPeriod] = useState('week')
      const p = savings.periods?.[period]
      const a = savings.assumptions ?? {}
      if (!p) return null
      const tile = (label, value, neg) => h('div', { className: 'stat' }, h('small', null, label), h('b', { className: neg ? 'neg' : undefined }, value))
      const perM = (x) => `$${Number(x).toFixed(3)} / M tokens`
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-save-h' },
        h('div', { className: 'head' },
          h('div', { className: 'label', id: 'jevi-save-h', style: { margin: 0 } }, 'Saved by Jev (estimate)'),
          h('div', { className: 'seg', role: 'group', 'aria-label': 'Period' }, ...PERIODS.map(([id, label]) =>
            h('button', { key: id, type: 'button', 'aria-pressed': period === id, onClick: () => setPeriod(id) }, label)))),
        h('div', { className: 'stats save', 'aria-live': 'polite' },
          tile('Money saved', usd(p.savedUsd), p.savedUsd < 0),
          tile('Time saved', hms(p.savedMs), p.savedMs < 0),
          tile('Tokens avoided', count(p.llmOutputTokensAvoided)),
          tile('Decisions made', count(p.decisions))),
        h('div', { className: 'why' }, `Jev cost ${usd(p.jevCostUsd)} vs LLM ${usd(p.llmCostUsd)} · Jev used ${count(p.jevTokens.input)} in / ${count(p.jevTokens.output)} out tokens`),
        // Laya's own decisions, counted apart and never priced or saved by Jev (docs/laya-auto.md 3.3).
        p.layaDecisions ? h('div', { className: 'why' }, `Laya: ${count(p.layaDecisions)} decisions on this PC, $0 (Laya counted ${count((p.layaTokens?.input ?? 0) + (p.layaTokens?.output ?? 0))} tokens; not billed).`) : null,
        h('div', { className: 'why' }, `${count(p.directAnswers)} direct answers · ${count(p.toolRuns)} tool runs · ${count(p.limitsAvoided)} limit saves (failed runs avoided)`),
        h('details', { className: 'answer' },
          h('summary', null, 'How this is estimated'),
          h('p', { className: 'why', style: { margin: '6px 0' } }, `Compared with ${a.name ?? 'a chat LLM'} making each Jev decision instead. Prices and times below are assumed, not quotes: change them in settings (cordis.patch.yml → jev-router → savings).`),
          h('dl', { className: 'why' },
            h('dt', null, 'LLM input'), h('dd', null, `${perM(a.inputPerMTok)} (assumed price, change in settings)`),
            h('dt', null, 'LLM output'), h('dd', null, `${perM(a.outputPerMTok)} × ${a.outputTokens} tokens per decision (assumed price, change in settings)`),
            h('dt', null, 'LLM time'), h('dd', null, `${ms(a.latencyMs)} per decision (assumed, change in settings)`),
            h('dt', null, 'Jev'), h('dd', null, `${perM(a.jevInputPerMTok)} input, output free; logged time per call (${ms(a.jevFallbackMs)} when not logged)`),
            h('dt', null, 'Agent run'), h('dd', null, a.agentMedianSamples ? `${ms(a.agentMedianMs)}, median of ${a.agentMedianSamples} completed agent runs` : `${ms(a.agentMedianMs)} default (no completed agent runs yet)`),
            h('dt', null, 'Direct answer'), h('dd', null, 'saves one agent run, minus the answer time'),
            h('dt', null, 'Tool run'), h('dd', null, 'accepted without an agent: saves one agent run, minus the tool time'),
            h('dt', null, 'Limit saves'), h('dd', null, 'agents skipped at their limit, and limit hits handed to another agent, in runs that did not pause; counted, not priced')),
          h('p', { className: 'why', style: { margin: '6px 0 0' } }, 'Negative numbers mean Jev cost more than the assumed baseline.')))
    }

    function UsageView({ usage, error, busy, onRefresh, onSaved }) {
      const agents = usageAgents(usage)
      const keys = usage?.keys ?? {}
      const keysFor = (a) => keys[a.id] ?? keys[a.provider]
      const extra = Object.keys(keys).filter((p) => !agents.some((a) => a.id === p || a.provider === p))
      const checked = agents.map((a) => a.checkedAt).filter(Boolean).sort().at(-1)
      return h('div', null,
        h('div', { className: 'head', style: { marginBottom: 8 } },
          h('span', { className: 'why' }, checked ? `Checked ${when(checked)}` : busy ? 'Loading…' : ''),
          h('button', { className: 'btn', disabled: busy, onClick: onRefresh }, busy ? 'Refreshing…' : 'Refresh')),
        error ? h('div', { className: 'err', role: 'alert' }, error) : null,
        usage?.savings ? h(SavingsCard, { savings: usage.savings }) : null,
        usage && !agents.length ? h('div', { className: 'empty' }, 'No usage data yet.') : null,
        ...agents.map((a) => h(UsageCard, { key: a.id, a, keys: keysFor(a), links: usage?.links, onSaved })),
        ...extra.filter((p) => keys[p]?.length).map((p) => h('div', { className: 'card', key: `k${p}` }, h('div', { className: 'label' }, `${providerLabel(p)} keys`), h(KeyStates, { list: keys[p] }))),
        usage ? h(Recent, { rows: usage.recent ?? [] }) : null)
    }

    // Settings says to restart while the server says a restart would move a provider onto another
    // stored key (/jev-router/setup keysRestartPending, read again after every action), and not
    // otherwise: after any key action of any provider, on reopening Settings, beside another notice.
    function RestartLine({ pending }) {
      if (!pending?.length) return null
      return h('div', { className: 'note', role: 'status' }, `Restart the harness to apply the ${pending.map(providerLabel).join(' and ')} key change (Kz-harness → Restart harness)`)
    }

    /** Settings: subscription logins and API keys per provider. */
    function KeyProvider({ provider, list, busy, act, ask }) {
      const [name, setName] = useState('')
      const [key, setKey] = useState('')
      const label = providerLabel(provider)
      const activate = (n) => act(() => post('/jev-router/keys/activate', { provider, name: n }))
      return h('div', { className: 'keys' },
        h('div', { className: 'label' }, `${label} API keys`),
        list.length ? h('ul', { className: 'plain', role: 'radiogroup', 'aria-label': `Active ${label} key` }, ...list.map((k) => {
          const st = stateInfo(k)
          return h('li', { key: k.name },
            h('label', { className: 'toggle' },
              h('input', { type: 'radio', name: `jevi-key-${provider}`, checked: !!k.active, disabled: busy, onChange: () => activate(k.name) }),
              h('b', null, k.name), k.active ? h('span', { className: 'pill ok' }, 'active') : null),
            h('span', { style: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 } },
              h('span', { className: 'why' }, [money(k.balance), typeof k.spentUsd === 'number' ? `$${k.spentUsd.toFixed(2)} this month` : null].filter(Boolean).join(' · ')),
              k.state ? h('span', { className: cx('pill', st.pill) }, st.text) : null,
              h('button', { className: 'btn danger', disabled: busy, 'aria-label': `Remove ${label} key ${k.name}`, onClick: () => ask({
                title: 'Remove key?', body: `Remove ${label} key '${k.name}'? The key is deleted from this PC.`, confirmLabel: 'Remove key',
                run: () => api(`/jev-router/keys?provider=${encodeURIComponent(provider)}&name=${encodeURIComponent(k.name)}`, { method: 'DELETE' }),
              }) }, 'Remove')))
        })) : h('div', { className: 'muted' }, 'No keys yet.'),
        h('form', { className: 'addkey', autoComplete: 'off', onSubmit: (e) => {
          e.preventDefault()
          const body = { provider, name: name.trim(), key }
          setKey('') // never keep the secret in the page
          act(async () => { await post('/jev-router/keys', body); setName('') })
        } },
          h('input', { type: 'text', required: true, pattern: '[a-z0-9][a-z0-9_\\-]{0,31}', title: 'Up to 32 lowercase letters, digits, - or _, starting with a letter or digit', placeholder: 'Key name, e.g. acct2', 'aria-label': `${label} key name`, value: name, onChange: (e) => setName(e.target.value) }),
          h('input', { type: 'password', required: true, autoComplete: 'off', placeholder: 'API key', 'aria-label': `${label} API key`, value: key, onChange: (e) => setKey(e.target.value) }),
          h('button', { className: 'btn', type: 'submit', disabled: busy }, 'Add key')))
    }

    function AccountsCard({ setupAgents, usage, busy, act, ask, setNotice }) {
      const u = usageById(usage)
      const keys = usage?.keys ?? {}
      const subs = [['claude', 'Claude'], ['codex', 'ChatGPT']]
      return h('div', { className: 'card' },
        h('div', { className: 'label' }, 'Accounts'),
        h('ul', { className: 'plain' }, ...subs.map(([id, label]) => {
          const s = setupAgents.find((a) => a.id === id)
          const email = u[id]?.account?.email ?? u[id]?.account?.label
          const signedIn = !!s?.status?.loggedIn
          return h('li', { key: id },
            h('div', { style: { minWidth: 0 } },
              h('div', null, h('span', { className: cx('dot', signedIn ? 'on' : 'off') }), h('b', null, label)),
              h('div', { className: 'why' }, email ?? s?.status?.detail ?? (signedIn ? 'signed in' : 'not signed in'))),
            h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
              h('button', { className: 'btn', disabled: busy, onClick: () => act(async () => {
                await post('/jev-router/login', { provider: id })
                setNotice(`A ${label} login window opened. Finish signing in there, then press Recheck logins.`)
              }) }, 'Log in'),
              h('button', { className: 'btn danger', disabled: busy || !signedIn, onClick: () => ask({
                title: `Log out of ${label}?`, body: `Log out ${email ?? 'this account'} from ${label}? Jev will stop using ${label} until you log in again.`, confirmLabel: 'Log out',
                run: () => post('/jev-router/logout', { provider: id }),
              }) }, 'Log out')))
        })),
        ...[...new Set(['deepseek', 'jev', ...Object.keys(keys)])].map((p) => h(KeyProvider, { key: p, provider: p, list: keys[p] ?? [], busy, act, ask })))
    }

    const EMPTY = []
    function InspectorBody({ useTabInfo, sessionId, useSessions }) {
      useStyle()
      const info = useTabInfo?.()
      const visible = info?.tab?.visible ?? true
      const [view, setView] = useState('decisions')
      // Openers pick the view: openTab(KIND, { params: { view } }); revision steps on every re-open.
      const nav = info?.tab?.navigation
      useEffect(() => {
        const v = nav?.params?.view
        if (['decisions', 'subagents', 'jobs', 'usage', 'router'].includes(v)) setView(v)
      }, [nav?.revision, nav?.params?.view])
      const runs = useRuns(sessionId, visible)
      const entries = useSessions?.((s) => s.subagentsByParent?.[sessionId]?.entries) ?? EMPTY
      const jobs = useSessions?.((s) => s.jobsBySession?.[sessionId]) ?? EMPTY
      const tasks = useTasks(sessionId, visible)
      const liveKids = entries.filter((e) => e.kind === 'child' && e.activity === 'running').length
      const live = liveCount({ runs, jobs, entries, tasks })
      names.use()
      useEffect(() => { if (visible) loadNames() }, [visible])
      const { usage, error: usageErr, busy: usageBusy, load: loadUsage } = useUsage(visible)
      const routing = useRouting(visible && view === 'router')
      const layaCompare = useLayaCompare(visible && view === 'router')
      const [agents, setAgents] = useState(null)
      const [chipBusy, setChipBusy] = useState(false)
      const [chipErr, setChipErr] = useState('')
      const loadAgents = useCallback(() => api('/jev-router/setup').then((d) => setAgents(d.agents)).catch(() => {}), [])
      useEffect(() => { if (visible) loadAgents() }, [visible, loadAgents])
      const toggle = async (id, enabled) => {
        setChipBusy(true); setChipErr('')
        try { await post('/jev-router/agents', { id, enabled }); await loadAgents() } catch (e) { setChipErr(e.message) } finally { setChipBusy(false) }
      }
      const limited = usageAgents(usage).filter((a) => a.state === 'near' || a.state === 'stopped' || a.state === 'exhausted').length
      const tab = (id, label, n) => h('button', { role: 'tab', 'aria-selected': view === id, onClick: () => setView(id) }, label, n ? h('span', { className: 'n' }, n) : null)
      return h('div', { className: 'jevi' },
        h('h3', null, 'Jev inspector'),
        h(AgentChips, { agents, usage, busy: chipBusy, onToggle: toggle }),
        chipErr ? h('div', { className: 'err', role: 'alert' }, chipErr) : null,
        h('div', { className: 'tabs', role: 'tablist' }, tab('decisions', 'Decisions', runs.length), tab('router', 'Router'), tab('subagents', 'Subagents', liveKids), tab('jobs', 'Background', live), tab('usage', 'Usage', limited)),
        view === 'decisions' ? h(Decisions, { runs })
          : view === 'router' ? h(RouterView, { ...routing, onRefresh: routing.load, laya: layaCompare, sessionId, visible })
            : view === 'subagents' ? h(Subagents, { sessionId, entries })
              : view === 'usage' ? h(UsageView, { usage, error: usageErr, busy: usageBusy, onRefresh: () => loadUsage(true), onSaved: () => loadUsage(false) }) : h(Tasks, { sessionId, runs, jobs, entries, tasks }))
    }

    // ---------- plan limits beside the composer ----------
    // DSH's ring next to Send already shows context use. This is the half it has
    // no view of: how much of each subscription window is gone.
    //
    // Under Jev Auto no single number describes "this chat" - the task may go to
    // any agent - so the reading always names the agent it belongs to, and the
    // popover lists them all. A bare percentage here would claim more than it knows.
    const LIMIT_WINDOW = { '5h': '5-hour limit', weekly: 'Weekly · all models' }
    // Opening the pill re-reads the limits from the providers instead of showing the cached
    // snapshot, which can be up to the usage TTL old. These numbers decide real spending, so a
    // stale reading is worse than a slow one. Throttled because toggling the popover open and
    // shut would otherwise hit every provider each time.
    const FORCE_EVERY_MS = 15_000
    /** Every subscription window across the agents, fullest first. */
    function limitRows(usage) {
      const rows = []
      for (const a of usageAgents(usage)) {
        if (a.kind === 'local' || !a.windows?.length) continue
        for (const w of a.windows) {
          if (w.usedPercent == null) continue
          const used = Math.max(0, Math.min(100, Number(w.usedPercent) || 0))
          rows.push({
            key: `${a.id}-${w.name}`,
            agent: agentLabel(a.id),
            label: LIMIT_WINDOW[w.name] ?? w.name,
            used,
            resetsAt: w.resetsAt,
            tone: used >= (a.limits?.stopAtPercent ?? 97) ? 'bad' : used >= (a.limits?.handoffAtPercent ?? 85) ? 'warn' : '',
          })
        }
      }
      return rows.sort((a, b) => b.used - a.used)
    }

    function LimitsPill() {
      useStyle()
      const [open, setOpen] = useState(false)
      const { usage, error, load } = useUsage(true)
      const root = useRef(null)
      const lastForced = useRef(0)
      useEffect(() => {
        if (!open) return
        const away = (e) => { if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false) }
        const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', away)
        document.addEventListener('keydown', esc)
        return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
      }, [open])
      const rows = limitRows(usage)
      // Nothing known yet: stay out of the composer rather than show a placeholder.
      if (!rows.length) return null
      const worst = rows[0]
      const reading = `${Math.round(worst.used)}%`
      const byAgent = []
      for (const r of rows) {
        const g = byAgent.find((x) => x.agent === r.agent) ?? (byAgent.push({ agent: r.agent, windows: [] }), byAgent.at(-1))
        g.windows.push(r)
      }
      return h('span', { className: 'kzh-lim', ref: root },
        h('button', {
          type: 'button',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': `Plan limits: ${worst.agent} ${worst.label} ${reading} used`,
          title: `${worst.agent} · ${worst.label}: ${reading} used. Jev may route to any agent; open for all of them.`,
          onClick: () => {
            if (!open && Date.now() - lastForced.current > FORCE_EVERY_MS) { lastForced.current = Date.now(); load(true) }
            setOpen(!open)
          },
        },
        h('span', { className: 'tick' }, h('i', { className: worst.tone, style: { width: `${worst.used}%` } })),
        h('span', { className: 'who' }, `${worst.agent} ${reading}`)),
        open ? h('div', { className: 'kzh-pop', role: 'dialog', 'aria-label': 'Plan usage limits' },
          error ? h('div', { className: 'err', role: 'alert' }, error) : null,
          h('p', { className: 'lead' }, 'Per agent, not per chat: Jev picks an agent for each task.'),
          ...byAgent.flatMap((g) => [
            h('div', { className: 'grp', key: `g${g.agent}` }, g.agent),
            ...g.windows.flatMap((r) => [
              h('div', { className: 'row', key: `r${r.key}` }, h('b', null, r.label), h('span', null, `${Math.round(r.used)}%${r.resetsAt ? ` · resets ${when(r.resetsAt)}` : ''}`)),
              h('div', {
                className: 'bar', key: `b${r.key}`, role: 'progressbar', 'aria-label': `${g.agent} ${r.label}`,
                'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(r.used),
              }, h('i', { className: r.tone, style: { width: `${r.used}%` } })),
            ]),
          ]),
          h('button', { className: 'more', onClick: () => { setOpen(false); runAction('usage') } }, 'See detailed breakdown \u2192')) : null)
    }

    // ---------- task queue ----------
    // The engine already queues prompts sent while a turn is running and takes them
    // in FIFO order, and `updateQueue` edits or drops one that has not started. So
    // this is a window onto that queue, not a second one: line several tasks up,
    // the agent works through them, and each drops off the list as it is taken.
    const queueOpen = makeStore({ open: false })
    const openQueue = () => queueOpen.set({ open: !queueOpen.get().open })

    /** The live session face for the chat on screen, or null. */
    const currentFace = () => {
      const id = sessionsApi?.list?.getSnapshot?.()?.current
      return id ? sessionsApi?.binding?.(id)?.session ?? null : null
    }
    const blockText = (blocks) => (Array.isArray(blocks) ? blocks : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()

    /** Re-render on every change to this session's control snapshot. */
    function useSnapshot(face) {
      const [, force] = useState(0)
      useEffect(() => {
        if (!face?.subscribe) return
        return face.subscribe(() => force((n) => n + 1))
      }, [face])
      try { return face?.getSnapshot?.() ?? null } catch { return null }
    }

    // `face` stands in for the chat's own in a test (test/observability.test.js).
    function TaskQueue({ face: given = null } = {}) {
      useStyle()
      useUiTick()
      const { open } = queueOpen.use()
      const face = given ?? currentFace()
      const snap = useSnapshot(face)
      const [draft, setDraft] = useState('')
      const [editing, setEditing] = useState(null) // { id, text }
      const [confirm, setConfirm] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const items = (snap?.queue ?? []).filter((q) => q.placement !== 'context')
      // Worth showing unprompted once something is actually waiting.
      if (!open && !items.length) return null
      if (!face) return null

      const call = async (fn) => {
        setErr(''); setBusy(true)
        try {
          const r = await fn()
          // The RPC reports business failures in its result rather than throwing.
          if (r && r.ok === false) setErr(r.error?.message ?? 'The engine refused that.')
        } catch (e) { setErr(e?.message ?? String(e)) } finally { setBusy(false) }
      }
      const add = () => {
        const text = draft.trim()
        if (!text) return
        setDraft('')
        call(() => face.prompt([{ type: 'text', text }], 'queue'))
      }
      const saveEdit = () => {
        const text = editing.text.trim()
        if (!text) return
        const id = editing.id
        setEditing(null)
        call(() => face.updateQueue(id, { kind: 'edit', content: [{ type: 'text', text }] }))
      }

      return h('div', { className: 'kzh-q', role: 'region', 'aria-label': 'Task queue' },
        h('div', { className: 'hd' },
          h('b', null, 'Task queue'),
          items.length ? h('span', { className: 'n' }, items.length) : null,
          snap?.running ? h('span', { className: 'tag' }, 'agent busy') : null,
          h('button', { onClick: () => queueOpen.set({ open: false }), 'aria-label': 'Hide the task queue' }, 'Hide')),
        err ? h('div', { className: 'err', role: 'alert' }, err) : null,
        items.length
          ? h('ol', null, ...items.map((q, i) => {
            const text = blockText(q.message?.content)
            const isEditing = editing?.id === q.id
            return h('li', { key: q.id, className: i === 0 ? 'now' : '' },
              h('span', { className: 'no' }, `${i + 1}.`),
              isEditing
                ? h('textarea', {
                  value: editing.text, rows: 3, 'aria-label': 'Edit this task',
                  onChange: (e) => setEditing({ id: q.id, text: e.target.value }),
                  onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit(); if (e.key === 'Escape') setEditing(null) },
                })
                : h('span', { className: 'tx' }, text || '(no text)'),
              q.placement === 'steering' ? h('span', { className: 'tag' }, 'steering') : null,
              // Send now: the turn under way takes it at its next step rather than after it ends, which
              // the engine allows only while a turn runs, and only for a prompt not already steering.
              snap?.running && q.placement !== 'steering' && !isEditing
                ? h('button', {
                  disabled: busy, 'aria-label': `Send task ${i + 1} now`,
                  title: 'Give this to the current turn at its next step instead of waiting for the turn to end',
                  onClick: () => call(() => face.updateQueue(q.id, { kind: 'steer' })),
                }, 'Send now')
                : null,
              isEditing
                ? h('button', { onClick: saveEdit, disabled: busy }, 'Save')
                : h('button', { onClick: () => setEditing({ id: q.id, text }), disabled: busy, 'aria-label': `Edit task ${i + 1}` }, 'Edit'),
              isEditing
                ? h('button', { onClick: () => setEditing(null) }, 'Cancel')
                : h('button', {
                  disabled: busy,
                  'aria-label': `Remove task ${i + 1}`,
                  onClick: () => setConfirm({ id: q.id, what: text }),
                }, 'Remove'))
          }))
          : h('div', { className: 'empty' }, 'Nothing queued. Add tasks here and the agent takes them one at a time.'),
        h('div', { className: 'add' },
          h('textarea', {
            value: draft, rows: 2, placeholder: 'Add a task to the queue', 'aria-label': 'Add a task to the queue',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() } },
          }),
          h('button', { onClick: add, disabled: busy || !draft.trim() }, 'Add')),
        confirm ? h(Confirm, {
          title: 'Remove this task?',
          body: `"${clip(confirm.what || '(no text)', 160)}" is dropped from the queue and never runs. Tasks already finished are unaffected.`,
          confirmLabel: 'Remove task',
          onCancel: () => setConfirm(null),
          onConfirm: () => { const c = confirm; setConfirm(null); call(() => face.updateQueue(c.id, { kind: 'remove' })) },
        }) : null)
    }

    // ---------- export the chat as Markdown ----------
    const exportState = makeStore({ open: false })
    const openExport = () => {
      const sessionId = sessionsApi?.list?.getSnapshot?.()?.current
      if (!sessionId) { toast('Open a chat first'); return }
      exportState.set({ open: true, sessionId, tools: true, busy: true, error: '', data: null })
      loadExport(sessionId, true)
    }
    async function loadExport(sessionId, tools) {
      exportState.set({ busy: true, error: '' })
      try {
        const d = await api(`/jev-router/export?session=${encodeURIComponent(sessionId)}&tools=${tools ? 1 : 0}`)
        exportState.set({ busy: false, data: d })
      } catch (e) { exportState.set({ busy: false, error: e.message, data: null }) }
    }

    function ExportDialog() {
      const st = exportState.use()
      useStyle()
      useEffect(() => {
        const k = (e) => { if (e.key === 'Escape') exportState.set({ open: false }) }
        window.addEventListener('keydown', k)
        return () => window.removeEventListener('keydown', k)
      }, [])
      if (!st.open) return null
      const close = () => exportState.set({ open: false })
      const md = st.data?.markdown ?? ''
      const copy = async () => {
        try { await navigator.clipboard.writeText(md); toast('Chat copied as Markdown'); close() } catch (e) { exportState.set({ error: `Could not copy: ${e.message}` }) }
      }
      const download = () => {
        const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }))
        const a = document.createElement('a')
        a.href = url
        a.download = st.data?.filename ?? 'chat.md'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        close()
      }
      const setTools = (tools) => { exportState.set({ tools }); loadExport(st.sessionId, tools) }
      return h('div', { className: 'jevi jevi-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'jevi-export-t', onClick: close },
        h('div', { className: 'box wide', onClick: (e) => e.stopPropagation() },
          h('h3', { id: 'jevi-export-t' }, 'Export this chat'),
          st.error ? h('div', { className: 'err', role: 'alert' }, st.error) : null,
          h('label', { className: 'why', style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 10px' } },
            h('input', { type: 'checkbox', checked: !!st.tools, onChange: (e) => setTools(e.target.checked) }),
            'Include tool calls and their output (folded in the Markdown)'),
          h('div', { className: 'answer-text', style: { maxHeight: 260 } },
            st.busy ? 'Reading the chat…' : md ? `${md.slice(0, 4000)}${md.length > 4000 ? '\n…' : ''}` : 'Nothing to export.'),
          h('p', { className: 'why' }, st.data ? `${md.length.toLocaleString()} characters · ${st.data.filename}` : ''),
          h('div', { className: 'actions' },
            h('button', { className: 'btn', onClick: close }, 'Cancel'),
            h('button', { className: 'btn', disabled: !md, onClick: copy }, 'Copy'),
            h('button', { className: 'btn', disabled: !md, onClick: download }, 'Save .md'))))
    }

    // ---------- standalone panes: the same views, each in its own sidebar tab ----------
    // The Jev inspector keeps all of them as tabs; these are for reaching one directly.
    function SubagentsPane({ useTabInfo, sessionId, useSessions }) {
      useStyle()
      const entries = useSessions?.((s) => s.subagentsByParent?.[sessionId]?.entries) ?? EMPTY
      useTabInfo?.()
      return h('div', { className: 'jevi' }, h('h3', null, 'Subagents'), h(Subagents, { sessionId, entries }))
    }

    function TasksPane({ useTabInfo, sessionId, useSessions }) {
      useStyle()
      names.use()
      const visible = useTabInfo?.()?.tab?.visible ?? true
      useEffect(() => { if (visible) loadNames() }, [visible])
      const runs = useRuns(sessionId, visible)
      const entries = useSessions?.((s) => s.subagentsByParent?.[sessionId]?.entries) ?? EMPTY
      const jobs = useSessions?.((s) => s.jobsBySession?.[sessionId]) ?? EMPTY
      const tasks = useTasks(sessionId, visible)
      return h('div', { className: 'jevi' }, h('h3', null, 'Background tasks'), h(Tasks, { sessionId, runs, jobs, entries, tasks }))
    }

    function UsagePane({ useTabInfo }) {
      useStyle()
      names.use()
      const visible = useTabInfo?.()?.tab?.visible ?? true
      useEffect(() => { if (visible) loadNames() }, [visible])
      const { usage, error, busy, load } = useUsage(visible)
      return h('div', { className: 'jevi' }, h('h3', null, 'Usage'), h(UsageView, { usage, error, busy, onRefresh: () => load(true), onSaved: () => load(false) }))
    }

    // ---------- Overview pane: the ledger's clock and its run detail ----------
    /**
     * The durable run history from `/jev-router/history`, newest last. Read once when the pane
     * appears and then slowly: the file only grows when a run finishes, so a fast poll would buy
     * nothing. `loaded` says the read finished, so the pane can tell an empty session from a
     * session that predates the route, and `error` carries a failed read rather than showing
     * nothing.
     */
    function useHistory(sessionId, visible, every = 15_000) {
      const [state, setState] = useState({ loaded: false, records: [], error: '' })
      useEffect(() => {
        if (!visible || !sessionId) return
        let stop = false
        let timer
        const tick = async () => {
          try {
            const d = await api(`/jev-router/history?session=${encodeURIComponent(sessionId)}`)
            if (!stop) setState({ loaded: true, records: d.records ?? [], error: '' })
          } catch (e) {
            if (!stop) setState({ loaded: true, records: [], error: e.message })
          }
          if (!stop) timer = setTimeout(tick, every)
        }
        tick()
        return () => { stop = true; clearTimeout(timer) }
      }, [sessionId, visible, every])
      return state
    }

    /** A durable run's detail, read from the stored record's own fields (never reshaped). */
    function HistoryRunDetail({ record }) {
      const R = record.routing ?? {}
      // A run Laya decided names Laya (3.2), offline too; an old record without `decider` was Jev's.
      const decider = deciderOf(R)
      const conf = Number.isFinite(R.agentConfidence) ? ` (confidence ${pct(R.agentConfidence)})` : ''
      // As the live run says it (WhatHappened): a decider picked over the whole pool or the local agents.
      const line = R.mode === 'jev' || R.mode === 'local'
        ? `${deciderName(decider)} picked ${movesOf(R)[0]?.from ?? R.primaryAgent ?? '?'}${conf}`
        : R.mode === 'manual' ? `You forced ${R.primaryAgent ?? '?'}` : `Mode ${R.mode ?? '?'}`
      return h('div', { className: 'card' },
        h('div', { className: 'label' }, 'Stored run record'),
        h('div', null, line, Number.isFinite(R.risk) ? h('span', { className: 'why' }, ` · risk ${pct(R.risk)}`) : null),
        ...gateNotes(R).map((t, i) => h('div', { className: 'why', key: `gate${i}` }, t)),
        ...moveNotes(R).map((t, i) => h('div', { className: 'why', key: `move${i}` }, t)),
        record.workspace ? h('div', { className: 'why' }, record.workspace) : null,
        (record.attempts ?? []).length ? h('ol', { className: 'steps' }, ...record.attempts.map((a, i) => h('li', { key: i },
          h('div', null, h('b', null, a.agent ?? '?'), h('span', { className: 'pill' }, a.role ?? ''),
            h('span', { className: cx('pill', a.stopReason === 'completed' ? 'ok' : 'bad') }, `${a.stopReason ?? '?'}${Number.isFinite(a.durationMs) ? ` · ${ms(a.durationMs)}` : ''}`)),
          a.changedFiles?.length ? h('div', { className: 'why' }, 'Changed: ', a.changedFiles.join(', ')) : null,
          a.answerExcerpt ? h('details', { className: 'answer' }, h('summary', null, `Answer from ${a.agent ?? '?'}`), h('div', { className: 'answer-text' }, a.answerExcerpt)) : null))) : null,
        (record.assessments ?? []).length ? h('div', { style: { marginTop: 8 } }, h('div', { className: 'label' }, 'Reviews'),
          ...record.assessments.map((a, i) => h('div', { className: 'why', key: i }, h('b', null, `${a.reviewAgent ?? '?'} → ${a.verdict ?? a.action ?? '?'}`), a.why ? `: ${a.why}` : ''))) : null,
        h('div', { style: { marginTop: 10 } }, 'Final: ', h('span', { className: 'pill' }, String(record.finalStatus ?? '?'))
          , record.statusReason ? h('span', { className: 'why' }, ` ${record.statusReason}`) : null))
    }

    /** One ledger row: time, kind, title, who, state, duration, then the detail behind a disclosure. */
    function OverviewRow({ row, sessionId }) {
      const time = row.untimed ? 'no time' : new Date(row.at).toLocaleTimeString()
      return h('details', { className: 'kzh-ov-row' },
        h('summary', null,
          h('span', { className: cx('kzh-ov-time', row.untimed && 'untimed'), title: row.untimed ? 'This row has no recorded wall-clock time' : new Date(row.at).toLocaleString() }, time),
          h('span', { className: 'kzh-ov-kind', title: row.kind }, row.kind),
          h('span', { className: 'kzh-ov-main' },
            h('div', { className: 'kzh-ov-title', title: row.title }, row.title || '(untitled)'),
            h('div', { className: 'kzh-ov-meta' },
              row.group === 'runs' || row.group === 'tasks' ? h('span', { className: 'pill', style: { marginLeft: 0 } }, row.group === 'runs' ? 'Routed run' : row.kind === 'job' ? 'Job' : 'Task') : null,
              row.who ? h('span', { className: 'who' }, row.who) : null,
              h('span', { className: cx('state', row.status) }, row.label ?? row.status ?? ''),
              row.durationMs != null ? h('span', null, ms(row.durationMs)) : null,
              row.meta ? h('span', null, row.meta) : null,
              row.untimed ? h('span', { className: 'untimed' }, 'no timestamp recorded') : null))),
        h('div', { className: 'kzh-ov-detail' },
          row.reason ? h('div', { className: 'why' }, row.reason) : null,
          row.group === 'runs' && row.live ? h(WhatHappened, { s: summarize(row.live) })
            : row.group === 'runs' && row.record ? h(HistoryRunDetail, { record: row.record })
              : row.group === 'subagents' ? h('a', { className: 'link', role: 'button', tabIndex: 0, onClick: () => openKid(sessionId, row.entry), onKeyDown: (k) => { if (k.key === 'Enter') openKid(sessionId, row.entry) } }, 'Open subagent')
                : h('div', { className: 'answer-text' }, row.detail || 'No further detail recorded.')))
    }

    /**
     * The whole session as one time-ordered ledger: the chat's own turns, the routed runs, the
     * background tasks and the subagents, each row expandable to the inspector's own detail.
     * Subagents carry no time in this engine, so they sit in an explicit Untimed section.
     */
    function OverviewPane({ useTabInfo, sessionId, useSessions, useChat }) {
      useStyle()
      const visible = useTabInfo?.()?.tab?.visible ?? true
      const nodes = (useChat ? useChat((s) => s.legacy.nodes) : null) ?? EMPTY
      const runs = useRuns(sessionId, visible, 2000)
      const history = useHistory(sessionId, visible)
      const entries = useSessions?.((s) => s.subagentsByParent?.[sessionId]?.entries) ?? EMPTY
      const jobs = useSessions?.((s) => s.jobsBySession?.[sessionId]) ?? EMPTY
      const tasks = useTasks(sessionId, visible, 2000)
      const [only, setOnly] = useState(() => new Set())
      const anyRunning = runs.some((r) => summarize(r).running)
        || tasks.some((t) => LIVE_TASK.includes(t.state))
        || entries.some((e) => e.kind === 'child' && e.activity === 'running')
      const now = useNow(anyRunning)
      const pairs = pairRuns(runs, history.records)
      const ledger = buildLedger({ nodes, runs: pairs, tasks, jobs, entries, now })
      const counts = ledger.counts
      const chosen = (g) => only.size === 0 || only.has(g)
      const toggle = (g) => setOnly((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n })
      const shown = ledger.sections
        .map((s) => ({ ...s, rows: s.rows.filter((r) => chosen(r.group)) }))
        .filter((s) => s.rows.length)
      const chips = h('div', { className: 'kzh-ov-chips', role: 'group', 'aria-label': 'Filter the ledger by kind' },
        ...OVERVIEW_GROUPS.map((g) => h('button', {
          key: g.id, className: 'kzh-ov-chip', type: 'button', 'aria-pressed': chosen(g.id),
          onClick: () => toggle(g.id),
        }, `${g.label} (${counts[g.id] ?? 0})`)))
      // The honest empty state: the durable route only holds runs written after it shipped, so a
      // session that predates it must say so rather than look like an empty or broken pane.
      const historyNote = !history.loaded ? h('div', { className: 'kzh-ov-note' }, 'Reading the durable run history...')
        : history.error ? h('div', { className: 'kzh-ov-note warn' }, `Durable run history could not be read: ${history.error}`)
          : history.records.length === 0 ? h('div', { className: 'kzh-ov-note warn' }, 'No durable run history for this session. /jev-router/history reads history.jsonl, which holds only runs written after that route shipped; runs from before it, and any still in the in-memory inspector log, are not in that file.')
            : null
      const timed = ledger.sections.some((s) => s.kind !== 'untimed')
      return h('div', { className: 'jevi' },
        h('h3', null, 'Overview'),
        h('p', { className: 'why' }, 'Every step in this session, oldest first: your messages and the assistant\'s, tool calls, context and compaction, then the routed runs, background tasks and subagents.'),
        historyNote,
        chips,
        !ledger.sections.length ? h('div', { className: 'empty' }, 'Nothing recorded in this session yet.') : null,
        !shown.length && ledger.sections.length ? h('div', { className: 'empty' }, 'No rows match the selected kinds.') : null,
        ...shown.map((s) => h('div', { className: 'kzh-ov-sec', key: s.key },
          h('div', { className: 'kzh-ov-hd' },
            h('b', null, s.title),
            s.kind === 'untimed' ? h('span', { className: 'at' }, 'no time') : s.at != null ? h('span', { className: 'at' }, new Date(s.at).toLocaleTimeString()) : null,
            h('span', { className: 'n' }, `${s.rows.length}`)),
          ...(s.kind === 'untimed' ? [h('div', { className: 'why' }, 'Subagents and any row without a recorded time. This engine does not timestamp a subagent, so none is invented here.')] : []),
          ...s.rows.map((r) => h(OverviewRow, { key: r.key, row: r, sessionId })))),
        !timed && ledger.sections.length ? h('div', { className: 'kzh-ov-note' }, 'No conversation turns with a recorded time in this session; its rows are all in the Untimed section.') : null)
    }

    // ---------- settings: Jev setup: effort ----------
    // Each agent's own names; values are the ids the server maps (effort.js).
    const EFFORT_LADDERS = {
      default: [['auto', 'Auto (Jev picks by task)'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High'], ['max', 'Max'], ['ultra', 'Ultra']],
      claude: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra'], ['max', 'Max'], ['ultra', 'Ultracode']],
      codex: [['low', 'Light'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High'], ['max', 'Max'], ['ultra', 'Ultra']],
      deepseek: [['off', 'Off'], ['low', 'Low'], ['high', 'High'], ['max', 'Max']],
    }
    /**
     * What Settings, Effort says your ratings of the picks changed (GET /jev-router/effort `learned`, in
     * the server's words), and what its toggle does now. Pure.
     */
    function ratedEffortLines(e) {
      const lines = (e?.learned ?? []).map((b) => b.text).filter(Boolean)
      if (lines.length && e.ratingsMove === false) lines.push('Auto effort does not follow these while Let my ratings move Auto effort is off.')
      return lines
    }

    function EffortCard() {
      const [e, setE] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => { api('/jev-router/effort').then(setE, (x) => setErr(x.message)) }, [])
      // What your ratings moved is read with the settings and never sent back: the server works it out.
      const save = async ({ learned, ...next }) => { setErr(''); try { setE({ ...(await api('/jev-router/effort', { method: 'POST', body: JSON.stringify(next) })), learned }) } catch (x) { setErr(x.message) } }
      const reset = async () => { setErr(''); try { setE(await api('/jev-router/effort/ratings-reset', { method: 'POST', body: '{}' })) } catch (x) { setErr(x.message) } }
      if (!e) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'Effort'), h('div', { className: err ? 'err' : 'muted' }, err || 'Loading…'))
      const pick = (id, label, value, options, onChange) => [
        h('dt', { key: `${id}t` }, h('label', { htmlFor: id }, label)),
        h('dd', { key: `${id}d` }, h('select', { id, value: value ?? '', onChange: (ev) => onChange(ev.target.value) }, ...options.map(([v, n]) => h('option', { key: v, value: v }, n)))),
      ]
      const setAgent = (agent, v) => { const perAgent = { ...e.perAgent }; if (v) perAgent[agent] = v; else delete perAgent[agent]; save({ ...e, perAgent }) }
      const follow = [['', 'Follow the level above']]
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-effort-h' },
        h('div', { className: 'label', id: 'jevi-effort-h' }, 'Effort'),
        h('div', { className: 'why' }, 'The Effort choice in the model menu wins over the default; a fixed per-agent effort wins over both. Local models keep their own settings.'),
        err ? h('div', { className: 'err', role: 'alert' }, err) : null,
        h('dl', null,
          ...pick('jevi-ef-d', 'Default level', e.default, EFFORT_LADDERS.default, (v) => save({ ...e, default: v })),
          ...pick('jevi-ef-c', 'Claude', e.perAgent?.claude, [...follow, ...EFFORT_LADDERS.claude], (v) => setAgent('claude', v)),
          ...pick('jevi-ef-x', 'GPT (Codex)', e.perAgent?.codex, [...follow, ...EFFORT_LADDERS.codex], (v) => setAgent('codex', v)),
          ...pick('jevi-ef-s', 'DeepSeek', e.perAgent?.deepseek, [...follow, ...EFFORT_LADDERS.deepseek], (v) => setAgent('deepseek', v)),
          h('dt', null, 'Codex speed'),
          h('dd', null, h('label', { className: 'toggle' },
            h('input', { type: 'checkbox', role: 'switch', checked: e.codexSpeed === 'fast', 'aria-label': 'Codex 1.5x speed', onChange: (ev) => save({ ...e, codexSpeed: ev.target.checked ? 'fast' : 'normal' }) }),
            e.codexSpeed === 'fast' ? '1.5x (uses more of your plan)' : 'Normal')),
          // Claude Code's fast mode reaches a run only through the engine patch (scripts/patch-agent-live.mjs),
          // and its cost is said whichever way the switch is set.
          h('dt', null, 'Claude Code speed'),
          h('dd', null, h('label', { className: 'toggle' },
            h('input', { type: 'checkbox', role: 'switch', checked: e.claudeSpeed === 'fast', 'aria-label': 'Claude Code fast mode', onChange: (ev) => save({ ...e, claudeSpeed: ev.target.checked ? 'fast' : 'normal' }) }),
            e.claudeSpeed === 'fast' ? 'Fast (costs more)' : 'Normal'),
            h('div', { className: 'why' }, 'Fast mode costs more: Claude bills it to your usage credits. A run gets it only while the Live agent view card says the engine patch is on, and an account or model without fast mode runs at normal speed.')),
          // Three of your last five `wrong effort` ratings of one agent on one kind of work move its Auto
          // effort a step (docs/live-agent-view.md Feature 4); Reset makes the ones given so far count no more.
          h('dt', null, 'Your ratings'),
          h('dd', null, h('label', { className: 'toggle' },
            h('input', { type: 'checkbox', role: 'switch', checked: e.ratingsMove !== false, 'aria-label': 'Let my ratings move Auto effort', onChange: (ev) => save({ ...e, ratingsMove: ev.target.checked }) }),
            'Let my ratings move Auto effort'))),
        ...ratedEffortLines(e).map((line, i) => h('div', { key: `r${i}`, className: 'muted' }, line)),
        (e.learned ?? []).length ? h('button', { type: 'button', onClick: reset, title: 'Your ratings given so far move Auto effort no more. Nothing is deleted.' }, 'Reset') : null)
    }

    // ---------- settings: Jev setup: chat replies ----------
    // ---- pure chat replies helpers: no React, no state. The choices the rows offer for the settings
    // POST /jev-router/chat-replies/settings takes (index.js validChatReplies).

    /** How long the start reply may wait for the router's pick, in ms; 0 replies at once. */
    const REPLY_WAITS = [0, 5000, 10_000, 15_000, 30_000, 60_000]
    const replyWaitWords = (ms) => (ms > 0 ? `up to ${Math.round(ms / 100) / 10} s` : 'Reply at once (no wait)')
    /** The wait's choices as [value, words], the saved wait among them even when it is not one of the usual ones. */
    function replyWaitChoices(current) {
      const values = [...new Set([...REPLY_WAITS, ...(Number.isInteger(current) && current >= 0 ? [current] : [])])].sort((a, b) => a - b)
      return values.map((ms) => [String(ms), replyWaitWords(ms)])
    }
    /** What follows the start reply in the chat: the milestone notices, or only the result and a guess's change of plan. */
    const PROGRESS_CHOICES = [['milestones', 'Milestones'], ['off', 'Start and result only']]

    // ---- end pure chat replies helpers

    function ChatRepliesCard() {
      const [s, setS] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => { api('/jev-router/chat-replies/settings').then(setS, (x) => setErr(x.message)) }, [])
      const save = async (patch) => {
        setErr('')
        try {
          const saved = await api('/jev-router/chat-replies/settings', { method: 'POST', body: JSON.stringify(patch) })
          setS(saved)
          // The ask under a start reply follows the switch at once, under the replies already shown too.
          if ('askWhenWrong' in patch) askHolders.set({ asking: (saved?.askWhenWrong ?? patch.askWhenWrong) !== false })
        } catch (x) { setErr(x.message) }
      }
      if (!s) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'Chat replies'), h('div', { className: err ? 'err' : 'muted' }, err || 'Loading…'))
      const pick = (id, label, value, options, onChange) => [
        h('dt', { key: `${id}t` }, h('label', { htmlFor: id }, label)),
        h('dd', { key: `${id}d` }, h('select', { id, value, onChange: (ev) => onChange(ev.target.value) }, ...options.map(([v, n]) => h('option', { key: v, value: v }, n)))),
      ]
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-replies-h' },
        h('div', { className: 'label', id: 'jevi-replies-h' }, 'Chat replies'),
        h('div', { className: 'why' }, 'A task you send starts in the background. Its reply names the agent, model and effort once Jev has picked them, waiting for the pick at most this long, or the guessed ones before the pick once How Jev replies shows quick replies on; a task that waits its turn is answered at once. Milestones add a short notice when a task starts on an agent its reply did not name, starts at another effort than its reply named, starts again as work that writes once its read pass hands it back, or moves to another agent on a retry. Start and result only drops all of them but one: a task that starts on another agent than its reply guessed still gets that notice.'),
        err ? h('div', { className: 'err', role: 'alert' }, err) : null,
        h('dl', null,
          ...pick('jevi-rp-w', 'Wait for the pick before replying', String(s.waitMs), replyWaitChoices(s.waitMs), (v) => save({ waitMs: Number(v) })),
          ...pick('jevi-rp-p', 'Progress in chat', s.progress, PROGRESS_CHOICES, (v) => save({ progress: v })),
          // The one ask under a start reply whose plan changed (docs/live-agent-view.md Feature 4), which
          // Don't ask me this under it switches off.
          h('dt', null, 'When the plan changes'),
          h('dd', null, h('label', { className: 'toggle' },
            h('input', { type: 'checkbox', role: 'switch', checked: s.askWhenWrong !== false, 'aria-label': 'Ask which was right when what ran is not what the reply said', onChange: (ev) => save({ askWhenWrong: ev.target.checked }) }),
            'Ask which was right'))))
    }

    // ---------- settings: Jev setup: how Jev replies ----------
    // ---- pure how-jev-replies helpers: no React, no state. What the How Jev replies card says, from
    // one GET /jev-router/replies/summary answer (index.js repliesSummary): how start replies are made,
    // how far task or question has come toward being read on this PC, how often the predictor of the
    // pick has been right, and which replies its record has switched on.

    /** How a reply came to name what it named, in the Recent replies table's words. */
    const REPLY_HOW_WORDS = { instant: 'instant', quick: 'quick', likely: 'likely', routed: 'after routing', bound: 'wait ran out', now: 'at once', forced: 'your pick', waited: 'waited' }
    /** The gates the summary gives, or the ones the plugin ships with (reply-ledger.js REPLY_GATES). */
    const replyGatesOf = (s) => s?.prediction?.gates ?? { quick: { right: 45, of: 50 }, likely: { right: 16, of: 20 } }
    /** What the guess at the pick changes once its record has earned it, with the gates it must keep. */
    const guessWords = (g) => `Once the guess has been right ${g.quick.right} of the last ${g.quick.of} times, a task that starts at once is told the guessed agent before routing picks (a quick reply), and once right ${g.likely.right} of the last ${g.likely.of}, a task that waits its turn is told the agent likely to run it. Routing still picks, and a pick it makes otherwise is said in a notice, even with Progress in chat at Start and result only, and asked about under the reply while Ask which was right is on.`
    /**
     * A share and the bar it is held to, as percentages to the decimals the bar is set to (none for 94%,
     * one for 98.5%, at most two), the share cut down, never rounded up: domains.js holds the share
     * itself to the bar, so 211 right of 225 (93.8%) reads 93% beside a bar of 94%, never the 94% it
     * misses, and a share reads as the bar only once it is there.
     */
    function percentsAgainst(x, bar) {
      const f = [1, 10].find((m) => Math.abs(bar * 100 * m - Math.round(bar * 100 * m)) < 1e-9) ?? 100
      return [`${Math.floor(x * 100 * f + 1e-9) / f}%`, `${Math.round(bar * 100 * f) / f}%`]
    }
    const secondWords = (ms) => { const s = Math.max(0, ms ?? 0) / 1000; return `${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10} s` }
    const RECENT_REPLY_COLUMNS = [{ key: 'job', label: 'Job' }, { key: 'said', label: 'What it said' }, { key: 'ran', label: 'What ran' }, { key: 'how', label: 'How' }, { key: 'rating', label: 'Rating' }]
    /** How you rated a reply's pick, in the Recent replies table's words: `Disliked: wrong agent`, or '' for none. */
    const ratingWords = (v) => (v?.verdict === 'like' || v?.verdict === 'dislike' ? `${v.verdict === 'like' ? 'Liked' : 'Disliked'}${v.tag ? `: ${v.tag}` : ''}` : '')
    /** What your ratings of the replies' picks changed, newest first, as the card lists them under What it changed. */
    const ratingChanges = (s) => (s?.ratings?.changed ?? []).map((c) => (c.jobId ? `${c.jobId}: ${c.line}` : c.line))

    /**
     * What the card says first: what learns, which replies the guess at the agent changes once its
     * record has earned it (with the gates it keeps), and that task or question changes one only once
     * it is read on this PC, when a quick reply asks Jev nothing at all; with adaptive routing off,
     * which sorts no message here (no `intent` in the summary), that only the guess at the agent
     * learns; with learning off, that nothing here learns.
     */
    const howJevRepliesWhy = (s) => (s?.learning === false
      ? 'A start reply names the agent once routing has picked it. Learning is switched off (routing.learn in the jev-router configuration), so nothing here learns, and no start reply is recorded.'
      : !s?.intent
        ? `A start reply names the agent once routing has picked it. A guess at the agent and effort learns in the background to make that sooner, checked against what routing then picks. ${guessWords(replyGatesOf(s))} Task or question is not learned while adaptive routing is off (routing.enabled in the jev-router configuration): Jev reads every message.`
        : `A start reply names the agent once routing has picked it. Two things learn in the background to make that sooner: whether a message is a task or a question, read on this PC once it has been right often enough, and a guess at the agent and effort, checked against what routing then picks. ${guessWords(replyGatesOf(s))} Task or question changes a reply only once it is read on this PC, and then only for a message it is sure is a task: Jev is not asked about that message, so it gets no read-only verdict and runs as work that writes, and a quick reply to it is instant, with no Jev call at all.`)

    /**
     * Where the guess's replies stand for one decider, from its record and the gates' states
     * (reply-ledger.js gateState): quick replies and the likely agent each `on` while the record keeps
     * its gate, and `paused` once it has fallen below one it kept, when replies wait for routing again;
     * nothing while one has never switched on, which the record line before them says it needs. Beside
     * quick replies under Jev Auto, whether instant ones are on: only while task or question is read on
     * this PC (`intent` 'local', else 'learning', or 'off' with adaptive routing off), and never under
     * Laya Auto, where Laya reads every message itself.
     */
    function guessStageLines(state, record, g, { laya = false, intent = 'learning' } = {}) {
      const lines = []
      const quick = laya ? 'Under Laya Auto, quick replies' : 'Quick replies'
      const likely = laya ? 'Under Laya Auto, "likely"' : '"Likely"'
      const q = record?.quick
      const l = record?.likely
      if (state?.quick === 'on' && q) {
        lines.push(`${quick} on: right ${q.right} of the last ${q.n}, so a task that starts at once is told the guessed agent before routing picks.`)
        if (!laya) {
          lines.push(intent === 'local' ? 'Instant replies on: a message read on this PC as a task gets its reply with no Jev call.'
            : intent === 'off' ? 'Instant replies: none while adaptive routing is off, since Jev reads every message.'
              : 'Instant replies: not until task or question is read on this PC.')
        }
      }
      if (state?.quick === 'paused' && q) lines.push(`${quick} paused: right ${q.right} of the last ${q.n} (they need ${g.quick.right}), so replies wait for routing again.`)
      if (state?.likely === 'on' && l) lines.push(`${likely} on: right ${l.right} of the last ${l.n}, so a task that waits its turn is told the agent likely to run it.`)
      if (state?.likely === 'paused' && l) lines.push(`${likely} paused: right ${l.right} of the last ${l.n} (it needs ${g.likely.right}), so a reply that waits names no agent again.`)
      return lines
    }

    /**
     * The card's lines: how start replies are made, with how long the ones that waited for the pick
     * took this week, until it came or the wait ran out, and how many ran out, or that they go out at
     * once with the wait set to none; how far task or question has come toward reading a task on this
     * PC (its checked examples against what GUARDED_LOCAL needs, of each class, and how often it was
     * right of the last ones checked, against what GUARDED_LOCAL needs until it gets there); the
     * predictor's record against the two gates, Laya's apart when it has one, so a predictor with no
     * guess of Jev's checked yet says that of Jev alone beside one of Laya's; and, under each record,
     * the replies it has switched on or paused (guessStageLines), with which the first line says start
     * replies can go out before routing. With learning off
     * nothing is recorded, so nothing is timed, guessed or trained, and the lines say so rather than
     * count on records that no longer grow.
     */
    function howJevRepliesLines(s) {
      const lines = []
      const off = s?.learning === false
      const sr = s?.startReplies ?? {}
      const ranOut = sr.atBound ? `; ${sr.atBound} of ${sr.n} went out when the wait ran out, before the pick` : ''
      const states = off ? {} : s?.prediction?.states ?? {}
      // Quick replies on for either decider go out before routing; the rest are timed as before.
      const quickOn = states.jev?.quick === 'on' || states.laya?.quick === 'on'
      lines.push(sr.waitMs === 0 ? 'Start replies: at once, without waiting for the pick (Reply at once, in Chat replies)'
        : `Start replies: ${quickOn ? 'before routing when the guess has earned it, else after routing' : 'after routing'} (${off ? 'not timed while learning is off' : sr.n ? `median ${secondWords(sr.medianMs)} this week${ranOut}` : 'none timed this week'})`)
      const i = s?.intent
      if (!i) lines.push('Task or question: Jev reads every message, and nothing is learned from it while adaptive routing or its learning is off.')
      else {
        // The accuracy it needs is the bar for being read on this PC, which a local rung is past: what
        // keeps it there is more than one figure (domains.js rollback), so there the line gives the
        // accuracy alone. Either way it is cut down, never rounded up to a bar it misses.
        const local = i.maturity === 'GUARDED_LOCAL' || i.maturity === 'LOCAL_ONLY'
        const shown = i.recent?.n ? percentsAgainst(i.recent.accuracy, i.needs.recentAccuracy) : null
        const right = shown ? `${shown[0]} right of the last ${i.recent.n} checked${local ? '' : ` (needs ${shown[1]})`}` : 'not scored yet'
        lines.push(local
          ? `Task or question: read on this PC when it is sure a message is a task, and by Jev otherwise (${i.verified} checked examples); ${right}.`
          : `Task or question: learning, ${i.verified} of ${i.needs.samples} checked examples (task ${i.classes?.task ?? 0}, question ${i.classes?.question ?? 0} of ${i.needs.perClass} needed); ${right}.`)
      }
      const p = s?.prediction ?? {}
      if (off) {
        lines.push(p.trained
          ? `Agent and effort prediction: off while learning is off; it was trained on ${p.trained.rows} routed tasks before, and no guess is made or checked now.`
          : 'Agent and effort prediction: off while learning is off; nothing is recorded for it, so it does not train.')
        return lines
      }
      const g = p.gates ?? { quick: { right: 45, of: 50 }, likely: { right: 16, of: 20 } }
      const need = `quick replies need ${g.quick.right}; "likely" needs ${g.likely.right} of the last ${g.likely.of}`
      const record = (r, who) => (r?.n ? `${who}: right ${r.right} of the last ${r.n} (${need}).` : null)
      // Not trained yet: too few routed tasks on record, a first training under way (the ledger
      // starts one as soon as it has enough, as it reads them too), or one that failed, which the
      // ledger tries again only after more tasks, so that it does not fail again on every one.
      const untrained = p.training ? 'it is training now, on the routed tasks on record'
        : (p.labelled ?? 0) >= (p.minRows ?? 60) ? `its training failed, and it is tried again after ${p.retrainEvery ?? 25} more routed tasks`
          : `it starts once ${p.minRows ?? 60} routed tasks are on record`
      // A predictor trained with no guess of Jev's checked yet says so of Jev alone while Laya has a
      // record of its own, which the Laya line under it gives: no guess at all is not what happened.
      const unchecked = p.records?.laya?.quick?.n ? 'no guess under Jev Auto has been checked yet' : 'no guess has been checked yet'
      if (!p.trained) lines.push(`Agent and effort prediction: not trained yet; ${untrained} (${p.labelled ?? 0} so far).`)
      else lines.push(record(p.records?.jev?.quick, 'Agent and effort prediction') ?? `Agent and effort prediction: trained on ${p.trained.rows} routed tasks; ${unchecked} (${need}).`)
      // Which replies the guess has switched on, or paused, for each decider (docs/live-agent-view.md Feature 3).
      const intent = !i ? 'off' : i.maturity === 'GUARDED_LOCAL' || i.maturity === 'LOCAL_ONLY' ? 'local' : 'learning'
      lines.push(...guessStageLines(states.jev, p.records?.jev, g, { intent }))
      const laya = record(p.records?.laya?.quick, 'Under Laya Auto')
      if (laya) lines.push(laya)
      lines.push(...guessStageLines(states.laya, p.records?.laya, g, { laya: true }))
      // Your ratings of the replies' picks, once there is one (docs/live-agent-view.md Feature 4).
      const r = s?.ratings
      if (r?.liked || r?.disliked) lines.push(`Your ratings on replies: ${r.liked} liked, ${r.disliked} disliked`)
      return lines
    }

    /**
     * The Recent replies table's rows, newest first: the job, what its reply named, what then ran, and
     * how the reply came to name it. A task that ended before routing picked anything (`ended`: its
     * final state, or true once it has left the task list) ran nothing and never will, so it is said to
     * have run nothing, with how it ended; only a task still to run is not routed yet.
     */
    function recentReplyRows(s) {
      const name = (id) => (String(id ?? '').startsWith('tool:') ? `the ${String(id).slice('tool:'.length)} tool` : s?.names?.[id] ?? id)
      const plan = (x) => [name(x.agent), x.model, x.effort ? `effort ${x.effort}` : ''].filter(Boolean).join(' · ')
      const ended = (r) => (taskLabels[r.ended] ? `nothing ran (${taskLabels[r.ended]})` : 'nothing ran')
      return (s?.recent ?? []).map((r) => [
        { text: r.jobId ?? '' },
        { text: r.said?.agent ? plan(r.said) : 'no agent named' },
        { text: r.ran?.agent ? plan(r.ran) : r.ended ? ended(r) : 'not routed yet' },
        { text: REPLY_HOW_WORDS[r.said?.how] ?? '' },
        { text: ratingWords(r.verdict) },
      ])
    }

    // ---- end pure how-jev-replies helpers

    function HowJevRepliesCard() {
      const [s, setS] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => { api('/jev-router/replies/summary').then(setS, (x) => setErr(x.message)) }, [])
      if (!s) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'How Jev replies'), h('div', { className: err ? 'err' : 'muted' }, err || 'Loading…'))
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-how-h' },
        h('div', { className: 'label', id: 'jevi-how-h' }, 'How Jev replies'),
        h('div', { className: 'why' }, howJevRepliesWhy(s)),
        ...howJevRepliesLines(s).map((t, i) => h('div', { key: i }, t)),
        ...(ratingChanges(s).length ? [h('div', { key: 'changed', className: 'label', style: { margin: '10px 0 4px' } }, 'What it changed'), ...ratingChanges(s).map((t, i) => h('div', { key: `c${i}`, className: 'muted' }, t))] : []),
        h('div', { className: 'label', style: { margin: '10px 0 4px' } }, 'Recent replies'),
        h(SortTable, { label: 'Recent replies', columns: RECENT_REPLY_COLUMNS, rows: recentReplyRows(s), empty: s.learning === false ? 'No start reply is recorded while learning is off.' : 'No start reply yet.' }))
    }

    // ---------- settings: Jev setup: live agent view ----------
    // ---- pure live agent view helpers: no React, no state. What the Live agent view card says of the
    // engine patch (GET /jev-router/engine-patches), and the choices its rows offer for the settings
    // POST /jev-router/live/settings takes (index.js validLiveSettings).

    /** Whether each agent's own work shows live, as `[agent, words]`: Claude Code and Codex by the engine patch, the rest always. */
    function livePatchLines(patches) {
      const of = (name, p) => [name, p?.on ? 'live detail on' : `live detail off${p?.why ? ` (${p.why})` : ''}`]
      return [of('Claude Code', patches?.['claude-code']), of('Codex', patches?.codex), ['DeepSeek, API and local models', 'always on (no patch needed)']]
    }
    /** How Claude Code shows its thinking in the Live tab. */
    const THINKING_CHOICES = [['default', 'As Claude Code shows it'], ['summarized', 'Summarized']]
    /** Whether each task's transcript is kept on disk after its run, for the Live tab after a restart: the newest 20 tasks' (as shipped), every task's the list keeps, or none. */
    const TRANSCRIPT_CHOICES = [['last20', 'Last 20 tasks'], ['last100', 'Last 100 tasks'], ['off', 'Off']]

    // ---- end pure live agent view helpers

    function LiveAgentViewCard() {
      const [s, setS] = useState(null)
      const [patches, setPatches] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        api('/jev-router/live/settings').then(setS, (x) => setErr(x.message))
        api('/jev-router/engine-patches').then(setPatches, () => setPatches({}))
      }, [])
      const save = async (patch) => { setErr(''); try { setS(await api('/jev-router/live/settings', { method: 'POST', body: JSON.stringify(patch) })) } catch (x) { setErr(x.message) } }
      if (!s || !patches) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'Live agent view'), h('div', { className: err ? 'err' : 'muted' }, err || 'Loading…'))
      const pick = (id, label, value, options, onChange) => [
        h('dt', { key: `${id}t` }, h('label', { htmlFor: id }, label)),
        h('dd', { key: `${id}d` }, h('select', { id, value, onChange: (ev) => onChange(ev.target.value) }, ...options.map(([v, n]) => h('option', { key: v, value: v }, n)))),
      ]
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-live-h' },
        h('div', { className: 'label', id: 'jevi-live-h' }, 'Live agent view'),
        h('div', { className: 'why' }, 'The Live tab and the card under a reply show each agent\'s text, tool calls and thinking as it works. Claude Code and Codex need the engine patch Start-KzH adds at each start: a connector installed again at the same version turns it off until the next start, and one an engine update brings at a new version until KzH is updated for that version. Their runs work as before meanwhile, and the lines below say why one is off.'),
        err ? h('div', { className: 'err', role: 'alert' }, err) : null,
        h('dl', null,
          ...livePatchLines(patches).flatMap(([name, words], i) => [h('dt', { key: `p${i}t` }, name), h('dd', { key: `p${i}d` }, words)]),
          h('dt', null, 'Let Steer reach a running Claude Code (experimental)'),
          h('dd', null, h('label', { className: 'toggle' },
            h('input', { type: 'checkbox', role: 'switch', checked: s.claudeSteer === true, 'aria-label': 'Let Steer reach a running Claude Code (experimental)', onChange: (ev) => save({ claudeSteer: ev.target.checked }) }),
            s.claudeSteer ? 'On' : 'Off')),
          ...pick('jevi-lv-t', 'Claude Code thinking', s.claudeThinking, THINKING_CHOICES, (v) => save({ claudeThinking: v })),
          ...pick('jevi-lv-k', 'Keep transcripts', s.transcripts, TRANSCRIPT_CHOICES, (v) => save({ transcripts: v }))),
        h('div', { className: 'muted' }, 'Steer and Send now reach a running DeepSeek, API, local-model or Codex task as it works. With Let Steer reach a running Claude Code on, they reach a Claude Code task started after it was turned on, through an input channel that is still experimental: Claude Code may take your words between tool calls, after its turn, or without saying whether it read them. Claude Code thinking: Summarized asks each Claude Code task started after it to share its thinking as summaries. Keep transcripts Off deletes the ones kept and keeps none.'))
    }

    // ---------- settings: Jev setup: the Laya decision model ----------
    // ---- pure laya helpers: no React, no state. test/laya-card.test.js evaluates this block on its
    // own (the runner cannot import a classic script), so nothing in it may reach outside it.
    //
    // Everything the Laya card says (docs/laya-auto.md 8.2 and 8.3) comes from one GET
    // /jev-router/laya answer: the sidecar's status (laya-sidecar.js status(), the shape of 8.4)
    // with the shadow's counters, and the few figures that status has no place for yet: what an
    // install would take before anything is installed (`offer`), where Laya lives (`paths`), what
    // Laya would take at its next start (`need`) and what a task costs it here (`running.routeMs`,
    // `running.reviewMs`). Each is optional, and without it the card says less rather than guess.

    const LAYA_INTRO = 'Laya is an open decision model (Apache-2.0) that runs on this PC. In Laya Auto it routes and reviews instead of Jev, and no routing or review question leaves this PC. In Jev Auto it can answer the same questions in the background, so you can compare the two.'
    /** The card's buttons by id, in the words it shows. */
    const LAYA_BUTTONS = {
      install: 'Install Laya…', cancel: 'Cancel', retry: 'Try again', log: 'Show log', cpu: 'Install for the CPU instead',
      start: 'Start', stop: 'Stop', restart: 'Restart', gpu: 'Restart on the GPU', test: 'Test Laya', remove: 'Remove…',
      weightsCheck: 'Check for a newer model', weightsApply: 'Use the newer model', repair: 'Repair', update: 'Update Laya',
    }
    /** The buttons that end what is under way, pressable while another action waits on the server. */
    const LAYA_ENDS = new Set(['stop', 'cancel'])
    const layaDevice = (device) => (device === 'cuda' || device === 'gpu' ? 'GPU' : 'CPU')
    /** Seconds as the model menu says them (adapter.js): one decimal under ten, whole above. */
    const layaSeconds = (ms) => { const s = ms / 1000; return String(s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) }
    const layaGB = (x) => (typeof x === 'number' && Number.isFinite(x) ? String(Math.round(x * 10) / 10) : '?')
    const layaBytes = (b) => (typeof b !== 'number' || !Number.isFinite(b) ? '?' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`)
    /** The CUDA version a PyTorch build was made for, from its local version: 2.14.0+cu128 is 12.8. */
    const torchCuda = (torch) => { const m = /\+cu(\d+)(\d)$/.exec(String(torch ?? '')); return m ? `${m[1]}.${m[2]}` : null }
    const commit7 = (c) => (c ? String(c).slice(0, 7) : 'unknown')
    const sentence = (t) => String(t ?? '').trim().replace(/\.$/, '')
    /**
     * An install or update refused before its first step (a Laya Auto run open, another install
     * under way) ran nothing: it says why, and never names a step it did not reach (7.10).
     */
    const notStarted = (job) => `The ${job.kind === 'update' ? 'update' : 'install'} did not start: ${sentence(job.error)}.`
    /**
     * What a task costs Laya on this PC, as the model menu says it (3.1), or that it is not measured
     * yet while the device has no per-phase figure (`msPerToken`). Measured, with no figure for a
     * task, it says nothing rather than call a measured Laya unmeasured.
     */
    const measuredLine = (r) => (typeof r?.routeMs === 'number' && typeof r?.reviewMs === 'number'
      ? `Measured here: about ${layaSeconds(r.routeMs)} s to route a task and ${layaSeconds(r.reviewMs)} s to review each attempt.`
      : Object.values(r?.msPerToken ?? {}).some((x) => typeof x === 'number') ? '' : 'Not measured on this PC yet.')

    /**
     * The Jev router card's line (8.1): where Jev calls go, and when TYPESAFE_BASE_URL sends them
     * elsewhere, that the Jev column of every comparison is that server's answers. Null while the
     * server does not say, since the page cannot know.
     */
    const jevHostLine = (jev) => (!jev?.host ? null : jev.hostFromEnv
      ? `TYPESAFE_BASE_URL is set, so Jev calls go to ${jev.host}, and the Jev column of the comparisons is that server's answers.`
      : `Jev calls go to ${jev.host}.`)

    /**
     * The status lines and buttons for the state Laya is in (8.2), each line `{ text, tone }`
     * (tone '' for the state itself, 'why', 'warn' or 'err'), and the last log lines of a failure.
     * A settings error and pins that could not be read outrank every state, since Laya Auto is off
     * until they are put right, each with its own remedy: the laya block is the person's
     * cordis.patch.yml, and the pins are the harness's own config/laya.json, which its update puts
     * back. A Laya left running by an earlier session and stopped at start is said above the state's
     * own line.
     */
    function layaState(st, now = Date.now()) {
      const out = { lines: [], buttons: [], log: [], progress: null }
      if (!st) return out
      const line = (text, tone = '') => out.lines.push({ text, tone })
      if (st.configError || st.pinsError) {
        if (st.configError) line(`Laya settings error: ${sentence(st.configError)}. Fix jev-router laya in cordis.patch.yml; Laya Auto is off until then.`, 'err')
        if (st.pinsError) line(`Laya's pinned versions could not be read (${sentence(st.pinsError)}); run Update-Harness.ps1. Laya Auto is off until then.`, 'err')
        return out
      }
      // The sweep could not always read the orphan's working set (ramGB null): then no figure is said.
      const orphan = st.orphanStopped
      if (orphan) line(`Stopped a Laya left running by an earlier session (pid ${orphan.pid}${typeof orphan.ramGB === 'number' ? `, ${orphan.ramGB} GB RAM` : ''}).`, 'warn')
      // One the sweep found alive and could not read (run as administrator): kept on record and named.
      const unchecked = st.orphansUnchecked ?? []
      if (unchecked.length) line(`A Laya an earlier session left may still be running (pid ${unchecked.join(', ')}); it could not be checked or stopped from here (it may run as administrator). End it in Task Manager (Details, right-click pid ${unchecked[0]}, End process tree; run Task Manager as administrator if it says access is denied), or restart the PC.`, 'warn')
      if (st.recovered) line(st.recovered, 'warn')
      const i = st.installed
      const r = st.running ?? {}
      const job = st.install ?? {}
      switch (st.state) {
        case 'not_installed': {
          const o = st.offer
          // What installing takes on disk is an estimate the install itself works with; what Laya
          // takes after it is not known until an install has measured it, so it is not said.
          const disk = o?.disk?.[o.gpu ? 'gpu' : 'cpu']
          line(disk ? `Not installed. Needs about ${disk.installingGB} GB of free disk while installing, and the internet once.` : 'Not installed. Installing it needs free disk and the internet once.')
          if (o) line(o.gpu ? `PyTorch with CUDA will be installed for your ${o.gpu.name}.` : 'No usable NVIDIA GPU found: Laya will run on the CPU. On a 4-core test machine that took about 20 s to route a task and about 10 s to review each attempt; this PC is not measured yet.', 'why')
          out.buttons = ['install']
          break
        }
        case 'installing': {
          const verb = { update: 'Updating', repair: 'Repairing' }[job.kind] ?? 'Installing'
          const progress = job.total > 0 ? ` (${layaBytes(job.received)} of about ${layaBytes(job.total)})`
            : typeof job.stepStartedAt === 'number' ? ` (${Math.max(0, Math.round((now - job.stepStartedAt) / 60_000))} min)` : ''
          line(job.step ? `${verb}, step ${job.step} of ${job.of ?? 8}: ${job.name}${progress}.` : `${verb}: getting ready.`)
          // The steps carry the bar, and a step that reports its bytes fills its own share of it,
          // so the longest step of the install - PyTorch, which is most of the gigabytes - moves
          // rather than sitting still. Before the first step there is nothing to measure, and an
          // install that reports no step is shown as working rather than as stuck at zero.
          const of = job.of ?? 8
          const within = job.total > 0 ? Math.min(1, job.received / job.total) : 0
          out.progress = { value: job.step ? Math.min(1, (job.step - 1 + within) / of) : null, label: `${verb} Laya` }
          out.buttons = ['cancel']
          break
        }
        case 'install_failed': {
          const step = job.failedStep ?? job.step
          if (!step) line(notStarted(job), 'err')
          else if (job.kind === 'update' && i) line(`Update failed at step ${step} (${job.name}); still on Laya ${i.laya}.`, 'err')
          else line(`Install failed at step ${step} (${job.name}): ${sentence(job.error)}. The previous install, if any, is untouched.`, 'err')
          // The Laya that was there is untouched and stopped (7.10), so what a stopped Laya offers
          // is offered too: Laya Auto starts it on demand anyway, and pressing Start clears the error.
          out.buttons = ['retry', 'log', ...(job.offerCpu ? ['cpu'] : []), ...(i ? ['start', 'test', 'remove'] : [])]
          break
        }
        case 'stopped': {
          if (st.stoppedBecause === 'idle') line(`Stopped after ${st.settings?.idleMinutes ?? '?'} min without a Laya Auto request. It starts again when Laya Auto needs it; the Jev Auto comparisons never start it.`)
          else if (st.stoppedBecause === 'budget') line(`Stopped by the resource budget: ${sentence(st.why)}.`)
          else if (st.stoppedBecause === 'yielded') line(`Unloaded so ${st.why ?? 'a local model'} could have the GPU and RAM; it starts again when Laya Auto needs it.`)
          // Why it stopped is said until it starts again, and a stopped Laya offers what any does.
          if (st.stoppedBecause) { out.buttons = ['start', 'test', 'remove']; break }
          // A start the RAM budget or a GPU with no room turned down leaves it stopped with the
          // reason and no stoppedBecause (7.7): the reason names the numbers, above the usual line.
          if (st.why) line(`Not started: ${sentence(st.why)}.`, 'warn')
          const cuda = torchCuda(i?.torch)
          line(`Installed, not running. Laya ${i?.laya}, English checkpoint ${commit7(i?.weights?.commit)}, PyTorch ${i?.torch} (${i?.cuda ? `for the GPU${cuda ? `, CUDA ${cuda}` : ''}` : 'for the CPU'}).`)
          out.buttons = ['start', 'test', 'remove']
          break
        }
        case 'starting': {
          out.buttons = ['stop']
          // Before the process is launched (an install's swap waited out, the orphan sweep, the
          // device and RAM checks, the weights) nothing is loading yet, on either device.
          // Nothing here can be measured - the model is loading inside a process that says so
          // only when it is done - so the bar says working, never a figure nobody has.
          out.progress = { value: null, label: 'Starting Laya' }
          if (!st.running) { line('Starting: getting ready…'); break }
          const secs = typeof r.startedAt === 'number' ? Math.max(0, Math.round((now - r.startedAt) / 1000)) : 0
          const last = typeof r.lastLoadMs === 'number' ? `; the last start took ${Math.round(r.lastLoadMs / 1000)} s` : ''
          line(`Starting: loading the model on the ${layaDevice(r.device)} (${secs} s${last})${r.measuring ? ', measuring Laya on this PC' : ''}…`)
          break
        }
        case 'ready': {
          const said = measuredLine(r)
          const measured = said ? ` ${said}` : ''
          if (r.device === 'cuda' && r.spilling) {
            line("Running on the GPU, but its memory is spilling into system memory, so Laya and the local models are slow. Stop the local model, pick CPU for Laya, or set Prefer No Sysmem Fallback for Laya's python.exe in the NVIDIA Control Panel.", 'warn')
            out.buttons = ['stop', 'restart', 'test']
          } else if (r.device === 'cuda') {
            line(`Running on the GPU (${r.gpu ?? i?.gpu ?? 'GPU'}): ${layaGB(r.vramGB)} GB VRAM, ${layaGB(r.ramGB)} GB RAM.${measured}`)
            out.buttons = ['stop', 'restart', 'test']
          } else if (r.deviceWhy) {
            // On the CPU for a reason, not by choice: the GPU is offered again, where PyTorch has CUDA.
            line(`Running on the CPU, not the GPU: ${sentence(r.deviceWhy)}.${measured}`)
            out.buttons = i?.cuda ? ['gpu', 'stop', 'test'] : ['stop', 'restart', 'test']
          } else {
            line(`Running on the CPU (${r.threads ?? '?'} threads): ${layaGB(r.ramGB)} GB RAM.${measured}`)
            out.buttons = ['stop', 'restart', 'test']
          }
          break
        }
        case 'restarting': {
          const x = st.restart ?? {}
          // An exit by a signal is named as one, as the sidecar's own lines name it (describeExit).
          const how = x.code != null ? `exit code ${x.code}` : x.signal ? `signal ${x.signal}` : 'reason unknown'
          line(`Laya stopped unexpectedly (${how}) and is restarting (attempt ${x.attempt ?? '?'} of ${x.of ?? 3}).`, 'warn')
          // Stop ends the backoff (7.4), so a crash loop can be ended from here.
          out.buttons = ['stop']
          break
        }
        case 'stopping': line('Stopping…'); break
        case 'failed': {
          line(`Stopped after an error: ${sentence(st.why)}. Laya Auto refuses messages until you press Start.`, 'err')
          out.log = st.logTail ?? []
          out.buttons = ['start', 'log']
          break
        }
        case 'disabled': line('Switched off in the configuration (jev-router laya.enabled is false).'); break
        default: line(`Laya is ${String(st.state).replace(/_/g, ' ')}.`)
      }
      // A failed update leaves the old Laya running (7.10); a failed repair, removal or model check
      // leaves Laya as it was. Either says so while Laya goes on.
      if (job.error && st.state !== 'install_failed') {
        if (job.kind === 'update' && i) line(job.failedStep ?? job.step ? `Update failed at step ${job.failedStep ?? job.step} (${job.name}); still on Laya ${i.laya}.` : notStarted(job), 'err')
        else if (job.kind !== 'install') line(`${{ repair: 'Repair', remove: 'Removing Laya', weights: 'The model check' }[job.kind] ?? 'Laya'} failed: ${sentence(job.error)}.`, 'err')
      }
      // What the installer had to say: each CUDA tag it tried, and why it installed for the CPU (7.2).
      if (['install', 'update'].includes(job.kind)) for (const n of job.notes ?? []) line(n, 'why')
      // Why the supervisor last restarted it on its own (7.5), until the person starts it again: an
      // exit, a request past the hard limit (whose line says it all), or the health, 500 and 401 checks.
      const re = st.lastRestart
      if (re?.why && ['ready', 'starting'].includes(st.state)) {
        line(re.kind === 'exit' ? `Laya stopped unexpectedly (${re.why}) and was restarted.`
          : re.kind === 'hung' ? re.why : `Laya was restarted: ${sentence(String(re.why).replace(/; restarting.*$/, ''))}.`, 'why')
      }
      return out
    }

    /** The shadow's skips by reason, in the order the card and the Router tab list them (5.6, 8.2). */
    const LAYA_SKIPS = [['not_running', 'not running'], ['starting', 'starting'], ['queue_full', 'queue full'], ['too_old', 'waited too long'], ['yielded', 'gave way to a local model'], ['jev_failed', 'Jev call failed']]
    /**
     * The counters (8.2), from the comparison of the last 7 days (8.4): how many of Jev's calls
     * Laya answered in the background, every skip by its reason, and how often the two agreed over
     * every question both answered. Null until the comparison has been read.
     */
    const layaCounters = (compare) => {
      const k = compare?.skips
      if (!k) return null
      const skipped = LAYA_SKIPS.reduce((n, [key]) => n + (k.skipped?.[key] ?? 0), 0)
      const answered = (k.answered ?? 0) + (k.partial ?? 0)
      const all = (compare.questions ?? []).reduce((a, q) => ({ n: a.n + (q.agree?.all?.n ?? 0), agree: a.agree + (q.agree?.all?.agree ?? 0) }), { n: 0, agree: 0 })
      return `Last 7 days: Laya answered ${answered} of ${answered + (k.failed ?? 0) + skipped} Jev calls in the background (${skipped} skipped: ${LAYA_SKIPS.map(([key, w]) => `${k.skipped?.[key] ?? 0} ${w}`).join(', ')}). ${all.n ? `Agreement ${Math.round((all.agree / all.n) * 100)}%.` : 'No answers compared yet.'}`
    }

    // laya-selfcheck.js selfTestLine, which the page cannot import: the test holds the two to the
    // same words for every result.
    const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
    /** The card's line for the last Test Laya (4.6, 8.2). */
    const selfTestLine = (r) => {
      const commit = String(r?.identity ?? '').split('|')[2]?.slice(0, 7) || 'unknown'
      const out = [`Test Laya (model ${commit}):`]
      out.push(r?.protocol?.ok && !r?.error ? 'protocol ok.' : `protocol failed (${r?.error ?? r?.protocol?.problems?.[0] ?? 'no answer'}).`)
      if (r?.timings) {
        const where = r.device === 'cuda' ? 'the GPU' : r.device === 'cpu' ? 'the CPU' : 'this PC'
        out.push(`On ${where}: intent ${r.timings.intent} ms, routing ${r.timings.route} ms, review ${r.timings.review} ms.`)
      }
      // A run that stopped at an error asked only some of the pairs, so no count is made of them.
      const pairs = r?.error ? [] : r?.pairs ?? []
      if (pairs.length) {
        const misses = pairs.filter((p) => !p.separates)
        let text = `${pairs.length - misses.length} of ${pairs.length} yes/no questions separate`
        if (misses.length) {
          const n = misses.filter((p) => p.noOnYes).length
          const m = misses.filter((p) => p.yesOnNo).length
          const why = [n ? `${n} answered no to the clear yes, the pattern of Laya issue #156` : '', m ? `${m} answered yes to the clear no` : ''].filter(Boolean).join('; ')
          text += `; ${listed(misses.map((p) => p.name))} ${misses.length === 1 ? 'does' : 'do'} not${why ? ` (${why})` : ''}`
        }
        out.push(`${text}.`)
      }
      if (r?.kind) out.push(`Task or question: ${r.kind.separates ? 'separates' : 'does not separate'}.`)
      return out.join(' ')
    }

    /**
     * The lines under the card's switches (8.2): what to turn on to test Jev and Laya together once
     * an install has finished, that the comparisons stop while Laya is not running, the counters,
     * the last Test Laya, and Laya's own warnings.
     */
    function layaNotes(st, compare) {
      const out = []
      if (!st?.installed || st.configError || st.pinsError || st.state === 'disabled') return out
      const s = st.settings ?? {}
      if (st.install?.kind === 'install' && !st.install.error && st.state !== 'installing' && !(s.startWithKzh && s.keepLoaded)) {
        out.push({ text: 'To test Jev and Laya together, turn on Start Laya when KzH starts and Keep Laya loaded.', tone: 'note' })
      }
      if (s.shadow && ['stopped', 'failed', 'install_failed'].includes(st.state)) out.push({ text: 'Laya is not running, so Jev Auto records no comparisons now. Press Start, or turn on Start Laya when KzH starts and Keep Laya loaded.', tone: 'warn' })
      const counters = layaCounters(compare)
      if (counters) out.push({ text: counters, tone: 'why' })
      if (compare?.error) out.push({ text: `The comparisons could not be read: ${sentence(compare.error)}.`, tone: 'warn' })
      if (st.selfTest) out.push({ text: selfTestLine(st.selfTest), tone: 'why' })
      for (const w of st.warnings ?? []) out.push({ text: w?.text ?? String(w), tone: 'warn' })
      return out
    }

    /**
     * The versions (8.2 and 7.10): which Laya and model this PC has, with the model's own buttons,
     * and when this KzH version pins another Laya, that too with `Update Laya`. The result of the
     * last `Check for a newer model` (`weights`) says whether there is one to use.
     */
    function layaVersions(st) {
      const i = st?.installed
      if (!i || st.configError || st.pinsError || st.state === 'disabled') return []
      const want = st.expected ?? {}
      const pinned = want.laya && i.laya !== want.laya ? `This KzH version pins Laya ${want.laya}; ${i.laya} is installed.`
        : want.torch && i.torch && !String(i.torch).startsWith(want.torch) ? `This KzH version pins PyTorch ${want.torch}; ${i.torch} is installed.` : null
      const w = i.weights
      const out = [{
        text: `Laya ${i.laya}${pinned ? '' : ', pinned by this KzH version'}. Model ${commit7(w?.commit)}${w?.downloadedAt ? `, downloaded ${String(w.downloadedAt).slice(0, 10)}` : ''}.`,
        buttons: ['weightsCheck', ...(st.weights?.changed ? ['weightsApply'] : []), 'repair'],
      }]
      if (st.weights) {
        out.push({ text: st.weights.changed ? `A newer Laya model is available (${commit7(st.weights.latest)}; this PC has ${commit7(st.weights.current)}).` : 'This PC has the newest Laya model.', buttons: [] })
      }
      if (pinned) out.push({ text: pinned, buttons: ['update'] })
      return out
    }

    /**
     * The help under each switch (8.2), with what Laya takes when it is kept loaded: its figure now
     * where it runs, else what it would take at its next start (`need`).
     */
    function layaHelp(st) {
      const r = st?.running
      const vram = r?.device === 'cuda' && typeof r.vramGB === 'number' ? r.vramGB : st?.need?.cuda?.vramGB
      const ram = r?.device === 'cpu' && typeof r.ramGB === 'number' ? r.ramGB : st?.need?.cpu?.ramGB
      const kept = 'Laya stays loaded and keeps its memory even when a local model starts: '
      const counted = 'which the RAM budget counts before a local model\'s context is sized.'
      return {
        device: "While Laya is loaded on the GPU and kept loaded, the VRAM budget holds Laya and the chat model together. On a 4 GB GPU, pick CPU here if the chat model needs the whole GPU. If Laya gets slow on the GPU, set Prefer No Sysmem Fallback for Laya's python.exe in the NVIDIA Control Panel.",
        startWithKzh: 'Laya then has its model loaded before your first message. Unless Keep Laya loaded is on, it still unloads after the idle time, and whenever a local model needs its memory.',
        keepLoaded: st?.installed?.cuda === false
          ? `${kept}${typeof ram === 'number' ? `about ${layaGB(ram)} GB of RAM` : 'its RAM'}, ${counted}`
          : typeof vram === 'number' && typeof ram === 'number'
            ? `${kept}about ${layaGB(vram)} GB of GPU memory, so local models get fewer GPU layers, or about ${layaGB(ram)} GB of RAM, ${counted}`
            : `${kept}its GPU memory, so local models get fewer GPU layers, or its RAM, ${counted}`,
        shadow: "Laya answers every Jev question too, on this PC, and both answers are recorded side by side. It never delays a Jev Auto run and never starts or keeps Laya loaded: when Laya is busy, starting or not running, or a local model is answering or needs Laya's memory, the comparison waits or is skipped and counted. Only Keep Laya loaded makes Laya hold memory beside a local model. Nothing is sent anywhere.",
        colibri: 'Empty is off. The address of a colibri you run yourself on this PC with its Laya engine, such as http://127.0.0.1:8000: each request laya.serve answers in Laya Auto and the shadow is then asked of colibri too, after laya.serve and for comparison only. KzH installs nothing of colibri and sends it no key.',
        vramGB: typeof vram === 'number' ? vram : null,
      }
    }

    /** The install dialog (8.3) for the device picked in it: where, what it downloads, the disk it needs, and the choice. */
    function layaInstallDialog(st, device) {
      const o = st?.offer ?? {}
      const want = st?.expected ?? {}
      const torch = o.torch?.[device]
      const disk = o.disk?.[device]
      return {
        title: 'Install Laya',
        lines: [
          ...(st?.paths ? [`Where: ${st.paths.engine} (Python and PyTorch) and ${st.paths.models} (the model).`] : []),
          `Downloads once, then works offline: Python${o.python ? ` ${o.python}` : ''} (about 30 MB, GitHub), PyTorch ${want.torch}${torch ? ` (about ${layaBytes(torch.bytes)}, ${torch.source})` : ''}, Laya ${want.laya} and its libraries (about 100 MB, PyPI), and Laya's English model (0.8 to 1.7 GB, Hugging Face).`,
          ...(disk ? [`Needs about ${disk.installingGB} GB of free disk while installing.`] : []),
        ],
        // The GPU is offered where there is a usable one, and where the server does not say: the
        // installer itself falls back to the CPU wheel when the driver has no CUDA to offer (7.2).
        choices: [
          ...(o.gpu ? [{ value: 'gpu', label: `GPU: ${o.gpu.name} with CUDA ${o.gpu.cuda} (speed not measured on this PC yet; Test Laya measures it after the install)` }]
            : !st?.offer ? [{ value: 'gpu', label: 'GPU (speed not measured on this PC yet; Test Laya measures it after the install)' }] : []),
          { value: 'cpu', label: 'CPU only (smaller download; on a 4-core test machine, about 20 s to route a task and about 10 s to review each attempt)' },
        ],
      }
    }

    /** The remove dialog (8.3), with each folder's size where the server reports it. */
    function layaRemoveDialog(st) {
      const p = st?.paths ?? { engine: 'engine\\laya', models: 'models\\laya' }
      const b = st?.installed?.bytes
      const size = (x) => (typeof x === 'number' ? ` (${layaBytes(x)})` : '')
      return {
        title: 'Remove Laya?',
        body: `Stops Laya and deletes ${p.engine}${size(b?.engine)} and ${p.models}${size(b?.models)}. Your recorded comparisons and Laya samples are kept. Laya Auto leaves the model menu.`,
        confirmLabel: 'Remove Laya',
      }
    }
    /**
     * colibri Laya, side by side (13): the card's section once the colibri Laya address is set, from
     * the `colibri` figures of GET /jev-router/laya (GET /jev-router/laya/colibri has the same).
     * Whether colibri answers, or why not; what was compared and how often it agreed with laya.serve,
     * by question type; how long each took; colibri's three gaps, as the figures meet them; and that
     * nothing it answers is used. Each line is `{ text, tone }`, and a share is never rounded up.
     */
    function colibriLines(c) {
      if (!c?.on) return []
      const out = []
      const r = c.reachable ?? {}
      const how = "KzH checks it with one test question, since colibri's /health lists no loaded model."
      if (r.checking) out.push({ text: `Asking colibri its test question… ${how}`, tone: 'why' })
      else if (r.ok === true) out.push({ text: `Reachable: colibri answered its test question${typeof r.ms === 'number' ? ` in ${layaSeconds(r.ms)} s` : ''}${r.model ? ` as ${r.model}` : ''}. ${how}`, tone: '' })
      else if (r.ok === false) out.push({ text: `Not reachable: ${sentence(r.why)}. ${how}`, tone: 'warn' })
      else out.push({ text: `Not checked yet. ${how}`, tone: 'why' })
      if (r.ok === true && r.model && !/laya/i.test(r.model)) out.push({ text: `colibri says it serves ${r.model}, not Laya: start it with Laya's model, as its docs/laya.md says.`, tone: 'warn' })
      const n = c.compared ?? {}
      const d = c.dropped ?? {}
      const f = c.failed ?? {}
      // What the record holds (the rows kept), and apart from it what was dropped since KzH started.
      const unanswered = [
        f.timeout ? `${f.timeout} past ${f.timeout === 1 ? 'its' : 'their'} deadline` : '',
        f.refused ? `${f.refused} refused by colibri` : '',
        f.unreachable ? `${f.unreachable} cut off` : '',
        f.bad_answer ? `${f.bad_answer} answered in a shape KzH could not read` : '',
      ].filter(Boolean)
      const notAsked = [
        d.busy ? `${d.busy} while colibri was answering another` : '',
        d.local_busy ? `${d.local_busy} while a local model was answering` : '',
        d.laya_busy ? `${d.laya_busy} while laya.serve had more to answer on the CPU` : '',
        d.not_reachable ? `${d.not_reachable} while colibri could not be reached` : '',
      ].filter(Boolean)
      const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`
      out.push({
        text: `${n.questions ? `Compared ${plural(n.questions, 'question')} in ${plural(n.requests, 'request')}${n.since ? ` since ${String(n.since).slice(0, 10)}` : ''}.`
          : 'Nothing compared yet: each request laya.serve answers in Laya Auto or the shadow is asked of colibri too, after laya.serve, one at a time.'}${unanswered.length ? ` Not answered: ${listed(unanswered)}.` : ''}${notAsked.length ? ` Not asked since KzH started: ${listed(notAsked)}.` : ''}`,
        tone: 'why',
      })
      const a = c.agreement ?? {}
      const share = (x) => `${x.agreed} of ${x.compared} (${Math.floor((100 * x.agreed) / x.compared)}%)`
      const parts = [
        a.choice?.compared ? `choice ${share(a.choice)}` : '',
        a.score?.compared ? `score ${share(a.score)} within ${a.score.tolerance} of a level` : '',
        a.noul?.compared ? `yes/no ${share(a.noul)}` : '',
      ].filter(Boolean)
      if (parts.length) out.push({ text: `Agreement with laya.serve: ${listed(parts)}.`, tone: '' })
      const ms = c.medianMs ?? {}
      if (typeof ms.laya === 'number' && typeof ms.colibri === 'number') out.push({ text: `Median time per request: laya.serve ${layaSeconds(ms.laya)} s, colibri ${layaSeconds(ms.colibri)} s.`, tone: 'why' })
      out.push({ text: `Yes/no questions go to colibri as KzH sends them, labels and all; colibri ignores the labels, so it reads each in its raw false/true form, unlike laya.serve${c.rawNouls ? ` (${c.rawNouls} so far)` : ''}.`, tone: 'why' })
      out.push({ text: `colibri gives a yes/no answer no confidence: each is recorded as unknown and left out of every figure that needs one${c.confidenceUnknown ? ` (${c.confidenceUnknown} so far)` : ''}.`, tone: 'why' })
      out.push({ text: `Nothing colibri answers is used: it decides nothing, and nothing learns from it. Its answers are kept in ${c.file ?? 'colibri-laya.jsonl'} only.`, tone: 'note' })
      return out
    }
    // ---- end pure laya helpers

    /**
     * Laya's status, GET /jev-router/laya, polled while shown: every 1.5 s while it installs, starts,
     * stops or restarts, or while `fast` (an action of the card waits on the server), else every 5 s.
     * Only the newest read is applied, as the local models card does.
     */
    function useLaya(active, fast = false) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const seq = useRef(0)
      const load = useCallback(async () => {
        const n = ++seq.current
        try { const d = await api('/jev-router/laya'); if (n === seq.current) { setData(d); setError('') } } catch (e) { if (n === seq.current) setError(e.message) }
      }, [])
      const moving = fast || ['installing', 'starting', 'stopping', 'restarting'].includes(data?.state)
      useEffect(() => {
        if (!active) return
        load()
        const t = setInterval(() => { if (!document.hidden) load() }, moving ? 1500 : 5000)
        return () => clearInterval(t)
      }, [active, moving, load])
      return { data, error, load }
    }

    /**
     * The install dialog (8.3): what an install takes, and the choice of GPU or CPU. Escape closes
     * it from wherever the focus is inside it, which starts on Cancel.
     */
    function LayaInstallDialog({ st, device, onDevice, onInstall, onClose }) {
      const d = layaInstallDialog(st, device)
      return h('div', { className: 'jevi jevi-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'jevi-laya-install-t', onClick: onClose, onKeyDown: (e) => { if (e.key === 'Escape') onClose() } },
        h('div', { className: 'box wide', onClick: (e) => e.stopPropagation() },
          h('h3', { id: 'jevi-laya-install-t' }, d.title),
          ...d.lines.map((l, i) => h('p', { key: i, className: 'why' }, l)),
          h('div', { role: 'radiogroup', 'aria-label': 'Where Laya runs' }, ...d.choices.map((c) => h('label', { key: c.value, className: 'toggle', style: { margin: '6px 0' } },
            h('input', { type: 'radio', name: 'jevi-laya-device', value: c.value, checked: device === c.value, onChange: () => onDevice(c.value) }), c.label))),
          h('div', { className: 'actions' },
            h('button', { className: 'btn', onClick: onClose, autoFocus: true }, 'Cancel'),
            h('button', { className: 'btn primary', onClick: () => onInstall(device) }, 'Install'))))
    }

    /**
     * Settings → Jev setup → Laya decision model (8.2): the state Laya is in and what can be done
     * about it, its per-PC switches (laya.json, saved through POST /jev-router/laya/settings), what
     * the comparisons in Jev Auto have counted, the last Test Laya, and its versions. Every button
     * posts to its route of 8.4 and reloads; a refusal (Stop while a Laya Auto run is open, a
     * setting out of range) is shown as the server words it.
     */
    function LayaCard({ ask }) {
      const [busy, setBusy] = useState('')
      // A start or a Test Laya from the card waits on the server while the model loads, for minutes
      // on a first start: the status is read as often as while Laya moves, so the card follows it.
      const { data: st, error, load } = useLaya(true, !!busy)
      const [compare, setCompare] = useState(null)
      const [msg, setMsg] = useState('')
      // How many times Stop or Cancel was pressed: an action one of them ended says nothing of its own.
      const ended = useRef(0)
      const [shownLog, setShownLog] = useState(null)
      const [installing, setInstalling] = useState(null)
      // The idle time as typed, until it is saved: the field shows it over the saved value, so a
      // status poll never puts the saved one back mid-edit, and follows the saved one otherwise.
      const [idleEdit, setIdleEdit] = useState(null)
      // The colibri Laya address as typed, kept over the saved one the same way until it is saved.
      const [colibriEdit, setColibriEdit] = useState(null)
      const installed = !!st?.installed
      useEffect(() => {
        if (!installed) return
        let stop = false
        // A comparison that could not be read is said under the switches, never dropped in silence.
        const read = () => api('/jev-router/laya/compare?days=7&identity=current').then((d) => { if (!stop) setCompare(d) }, (e) => { if (!stop) setCompare(e.status === 404 ? null : { error: e.message }) })
        read()
        const t = setInterval(read, 60_000)
        return () => { stop = true; clearInterval(t) }
      }, [installed])
      if (!st) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'Laya decision model'), h('div', { className: error ? 'err' : 'muted' }, error || 'Loading…'))
      // Stop and Cancel end what is under way, so they stay pressable while another action waits on
      // the server, and the action they end (a start that was loading) does not report its own end
      // as a failure: the person asked for it. Each action clears only its own busy mark.
      const act = async (id, fn) => {
        const mine = LAYA_ENDS.has(id) ? ++ended.current : ended.current
        setMsg(''); setBusy(id)
        try { await fn(); await load() } catch (e) { if (ended.current === mine) setMsg(e.message) } finally { setBusy((b) => (b === id ? '' : b)) }
      }
      // The dialog's first choice: the GPU, unless the server says there is no usable one.
      const device = st.offer && !st.offer.gpu ? 'cpu' : 'gpu'
      const save = (patch) => act('settings', () => post('/jev-router/laya/settings', patch))
      // Saved and reloaded, and only then the edit dropped, so the field goes from what was typed to
      // what was saved; a refused value is dropped too, and the field shows what is saved beside the
      // refusal. Whatever was typed while the save was on its way is kept.
      const saveIdle = async () => {
        const typed = idleEdit
        if (typed == null) return
        if (Number(typed) !== st.settings?.idleMinutes) await save({ idleMinutes: Number(typed) })
        setIdleEdit((v) => (v === typed ? null : v))
      }
      // Saved as typed less the spaces around it, and saved again unchanged, which asks colibri its test question again.
      const saveColibri = async () => {
        const typed = colibriEdit
        if (typed == null) return
        await save({ colibriUrl: typed.trim() })
        setColibriEdit((v) => (v === typed ? null : v))
      }
      const press = {
        install: () => setInstalling(device),
        cancel: () => act('cancel', () => post('/jev-router/laya/install/cancel', {})),
        // Again for the device the failed install was for, when the server says which; otherwise
        // the dialog asks again, since a guess could install for the GPU what was asked for the CPU.
        retry: () => (st.install?.kind === 'update' ? act('retry', () => post('/jev-router/laya/update', {}))
          : st.install?.device ? act('retry', () => post('/jev-router/laya/install', { device: st.install.device }))
            : setInstalling(device)),
        cpu: () => act('cpu', () => post('/jev-router/laya/install', { device: 'cpu' })),
        log: () => act('log', async () => setShownLog((await api('/jev-router/laya/log?lines=200')).lines ?? [])),
        start: () => act('start', () => post('/jev-router/laya/start', {})),
        stop: () => act('stop', () => post('/jev-router/laya/stop', {})),
        restart: () => act('restart', () => post('/jev-router/laya/restart', {})),
        gpu: () => act('gpu', () => post('/jev-router/laya/restart', { device: 'gpu' })),
        test: () => act('test', () => post('/jev-router/laya/selftest', {})),
        remove: () => ask({ ...layaRemoveDialog(st), run: async () => { await post('/jev-router/laya/remove', {}); await load() } }),
        weightsCheck: () => act('weightsCheck', () => post('/jev-router/laya/weights/check', {})),
        weightsApply: () => act('weightsApply', () => post('/jev-router/laya/weights/apply', {})),
        repair: () => act('repair', () => post('/jev-router/laya/repair', {})),
        update: () => act('update', () => post('/jev-router/laya/update', {})),
      }
      const button = (id) => h('button', { key: id, className: cx('btn', id === 'install' && 'primary', id === 'remove' && 'danger'), disabled: !!busy && !LAYA_ENDS.has(id), onClick: press[id] }, busy === id && id === 'test' ? 'Testing…' : LAYA_BUTTONS[id])
      const tone = (t) => ({ why: 'why', warn: 'warnline', err: 'err', note: 'note' })[t] ?? undefined
      const view = layaState(st)
      const s = st.settings ?? {}
      const help = layaHelp(st)
      const switchable = installed && !st.configError && !st.pinsError && st.state !== 'disabled'
      const toggle = (id, label, key, text) => [
        h('dt', { key: `${id}t` }, label),
        h('dd', { key: `${id}d` },
          h('label', { className: 'toggle' }, h('input', { id, type: 'checkbox', role: 'switch', checked: !!s[key], disabled: busy === 'settings', 'aria-label': label, onChange: (e) => save({ [key]: e.target.checked }) }), s[key] ? 'On' : 'Off'),
          h('div', { className: 'why' }, text)),
      ]
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-laya-h' },
        h('div', { className: 'label', id: 'jevi-laya-h' }, 'Laya decision model'),
        h('p', { className: 'why', style: { margin: '0 0 8px' } }, LAYA_INTRO),
        ...view.lines.map((l, i) => h('div', { key: `l${i}`, className: tone(l.tone) }, l.text)),
        // A plain `progress`: it reads as a bar to the eye and as a progress bar to a screen
        // reader, and with no `value` it is the platform's own "working, length unknown".
        view.progress ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' } },
          h('progress', {
            max: 1,
            ...(view.progress.value == null ? {} : { value: view.progress.value }),
            'aria-label': view.progress.label,
            style: { flex: 1, height: 6 },
          }),
          view.progress.value == null ? null : h('span', { className: 'why' }, `${Math.round(view.progress.value * 100)}%`)) : null,
        view.log.length ? h('div', { className: 'answer-text' }, view.log.join('\n')) : null,
        view.buttons.length ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } }, ...view.buttons.map(button)) : null,
        msg ? h('div', { className: 'err', role: 'alert' }, msg) : null,
        shownLog ? h('div', null, h('div', { className: 'answer-text' }, shownLog.length ? shownLog.join('\n') : 'The log is empty.'), h('button', { className: 'btn', onClick: () => setShownLog(null) }, 'Hide log')) : null,
        switchable ? h('dl', null,
          h('dt', null, h('label', { htmlFor: 'jevi-laya-device' }, 'Device')),
          h('dd', null,
            h('select', { id: 'jevi-laya-device', value: s.device ?? 'auto', disabled: busy === 'settings', onChange: (e) => save({ device: e.target.value }) },
              h('option', { value: 'auto' }, 'Auto (the GPU when it has room)'), h('option', { value: 'gpu' }, 'GPU'), h('option', { value: 'cpu' }, 'CPU')),
            h('div', { className: 'why' }, help.device)),
          ...toggle('jevi-laya-start', 'Start Laya when KzH starts', 'startWithKzh', help.startWithKzh),
          ...toggle('jevi-laya-keep', 'Keep Laya loaded', 'keepLoaded', help.keepLoaded),
          h('dt', null, h('label', { htmlFor: 'jevi-laya-idle' }, 'Unload after idle (minutes)')),
          h('dd', null, h('input', { id: 'jevi-laya-idle', type: 'number', min: 1, max: 240, value: idleEdit ?? String(s.idleMinutes ?? ''), disabled: !!s.keepLoaded, style: { width: 64 }, onChange: (e) => setIdleEdit(e.target.value), onBlur: saveIdle })),
          ...toggle('jevi-laya-shadow', 'Answer beside Jev in Jev Auto', 'shadow', help.shadow),
          h('dt', null, h('label', { htmlFor: 'jevi-laya-colibri' }, 'colibri Laya address')),
          h('dd', null,
            h('input', { id: 'jevi-laya-colibri', type: 'text', placeholder: 'http://127.0.0.1:8000', spellCheck: false, value: colibriEdit ?? String(s.colibriUrl ?? ''), disabled: busy === 'settings', style: { width: 220 }, onChange: (e) => setColibriEdit(e.target.value), onBlur: saveColibri }),
            h('div', { className: 'why' }, help.colibri))) : null,
        switchable && st.installed.cuda ? h('div', { className: 'why' }, layaHeldNote(help.vramGB)) : null,
        switchable && s.colibriUrl ? h('section', { 'aria-labelledby': 'jevi-laya-colibri-h', style: { marginTop: 8 } },
          h('div', { className: 'label', id: 'jevi-laya-colibri-h' }, 'colibri Laya, side by side'),
          ...colibriLines(st.colibri).map((l, i) => h('div', { key: `c${i}`, className: tone(l.tone) }, l.text))) : null,
        ...layaNotes(st, compare).map((n, i) => h('div', { key: `n${i}`, className: tone(n.tone), style: { marginTop: 6 } }, n.text)),
        ...layaVersions(st).map((v, i) => h('div', { key: `v${i}`, style: { marginTop: 8 } },
          h('div', { className: 'why' }, v.text),
          v.buttons.length ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } }, ...v.buttons.map(button)) : null)),
        installing ? h(LayaInstallDialog, {
          st, device: installing, onDevice: setInstalling, onClose: () => setInstalling(null),
          onInstall: (d) => { setInstalling(null); act('install', () => post('/jev-router/laya/install', { device: d })) },
        }) : null)
    }

    // ---------- settings: Jev setup ----------
    function SetupSection() {
      useStyle()
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [removing, setRemoving] = useState(null)
      const [form, setForm] = useState({ id: '', provider: '', model: '', description: '' })
      const [confirm, setConfirm] = useState(null)
      const [notice, setNotice] = useState('')
      const { usage, load: loadUsage } = useUsage(true)
      // Provider and agent names from the server's catalog: this page may be the first to need them.
      names.use()
      useEffect(() => { loadNames() }, [])
      const load = useCallback(async (recheck) => {
        setBusy(true); setError('')
        try { setData(await api(`/jev-router/setup${recheck ? '?recheck=1' : ''}`)) } catch (e) { setError(e.message) } finally { setBusy(false) }
      }, [])
      useEffect(() => { load(false) }, [load])
      // What an action changed is read back whether or not it succeeded: one can fail halfway (a key
      // removed, the next one not made active), and the page shows the state it left.
      const act = async (fn) => {
        setError(''); setBusy(true)
        let failed = null
        try { await fn() } catch (e) { failed = e }
        loadUsage(false)
        await load(false)
        if (failed) setError(failed.message)
      }

      if (!data) return h('div', { className: 'jevi' }, h('h3', null, 'Jev setup'), error ? h('div', { className: 'err' }, error) : h('div', { className: 'muted' }, 'Checking logins…'))
      // The stored Jev key in use, from the polled reading once there is one: Jev moves on to its next
      // key by itself at a limit, and the key list beside this shows that.
      const jevKeyNow = usage && Object.hasOwn(usage, 'jevActiveKey') ? usage.jevActiveKey : data.jev.activeKey
      // Whether Jev's credential is set, from the same reading: what Jev falls back to without a stored key.
      const jevCredentialNow = usage && Object.hasOwn(usage, 'jevCredentialSet') ? usage.jevCredentialSet : data.jev.credentialSet ?? data.jev.configured
      const onCount = data.agents.filter((a) => a.enabled).length
      const usable = data.agents.filter((a) => a.enabled && a.status?.loggedIn).length
      const provider = data.providers.find((p) => p.id === form.provider)

      return h('div', { className: 'jevi', style: { height: 'auto' } },
        h('h3', null, 'Jev setup'),
        h('p', { className: 'muted' }, 'Which LLM agents Jev can route to, and whether each one is signed in. At least one LLM must stay on.'),
        h(AgentChips, { agents: data.agents, usage, busy, onToggle: (id, enabled) => act(() => post('/jev-router/agents', { id, enabled })) }),
        error ? h('div', { className: 'err', role: 'alert' }, error) : null,
        notice ? h('div', { className: 'note', role: 'status' }, notice) : null,
        // The usage reading is polled, so a key a run switched by itself shows here too.
        h(RestartLine, { pending: usage?.keysRestartPending ?? data.keysRestartPending }),

        h('div', { className: 'card', style: { marginTop: 12 } },
          h('div', { className: 'label' }, 'Jev router'),
          h('div', null, h('span', { className: cx('dot', jevKeyNow || jevCredentialNow ? 'on' : 'off') }),
            jevKeyNow ? `Jev key '${jevKeyNow}' is active. Jev routes and reviews.` : jevCredentialNow ? `${data.jev.credentialRef} is set. Jev routes and reviews.` : `${data.jev.credentialRef} missing. Routing falls back to the default agent. See C:\\Harness\\README.md step 2.`),
          jevHostLine(data.jev) ? h('div', { className: 'why' }, jevHostLine(data.jev)) : null),

        h(LayaCard, { ask: setConfirm }),

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
                h('div', { className: 'why' }, a.status?.detail ?? 'not checked'),
                // Whether a task judged read only can run on it locked against writing, and how.
                a.readOnly ? h('div', { className: 'why' }, a.readOnly.how ? `Read-only work: yes, ${a.readOnly.how}` : `Read-only work: no, ${a.readOnly.why}`) : null),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 } },
                h('label', { className: 'toggle', title: lastOn ? 'At least one LLM must stay on' : '' },
                  h('input', { type: 'checkbox', role: 'switch', checked: a.enabled, disabled: lastOn || busy, 'aria-label': `Use ${a.id}`, onChange: (e) => act(() => api('/jev-router/agents', { method: 'POST', body: JSON.stringify({ id: a.id, enabled: e.target.checked }) })) }),
                  a.enabled ? 'On' : 'Off'),
                a.custom ? h('button', { className: 'btn danger', onClick: () => setRemoving(a.id) }, 'Remove') : null))
          }))),

        h(AccountsCard, { setupAgents: data.agents, usage, busy, act, ask: setConfirm, setNotice }),

        h(LocalModelsCard, { ask: setConfirm }),

        h(EffortCard),

        h(ChatRepliesCard),

        h(HowJevRepliesCard),

        h(LiveAgentViewCard),

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
                h('dt', null, h('label', { htmlFor: 'jevi-d' }, 'What it is')),
                h('dd', null, h('input', { id: 'jevi-d', type: 'text', required: true, placeholder: 'What it is, e.g. Mistral API, paid per token', value: form.description, onChange: (e) => setForm({ ...form, description: e.target.value }), style: { width: '100%' } }))),
              h('div', { style: { marginTop: 10 } }, h('button', { className: 'btn primary', type: 'submit' }, 'Add agent')))),

        h('div', { className: 'card' },
          h('div', { className: 'label' }, 'Tools (no LLM)'),
          data.tools.length
            ? h('ul', { className: 'plain' }, ...data.tools.map((t) => h('li', { key: t.id }, h('div', null, h('b', null, t.id), h('div', { className: 'why' }, t.description)), h('code', { className: 'why' }, t.command))))
            : h('div', { className: 'muted' }, 'None yet. Add scripts under `tools` in the jev-router entry of ~/.kzh/profiles/web/cordis.patch.yml; Jev runs one when it fully covers a task.')),

        removing ? h(Confirm, {
          title: `Remove agent "${removing}"?`,
          body: `Jev will stop routing tasks to ${removing}. The provider and API key in Settings → Models are not touched.`,
          confirmLabel: 'Remove agent',
          onCancel: () => setRemoving(null),
          onConfirm: () => { const id = removing; setRemoving(null); act(() => api(`/jev-router/custom?id=${encodeURIComponent(id)}`, { method: 'DELETE' })) },
        }) : null,
        confirm ? h(Confirm, { ...confirm, onCancel: () => setConfirm(null), onConfirm: () => { const c = confirm; setConfirm(null); act(c.run) } }) : null)
    }

    // ---------- local models: /install-llm and /remove-llm pickers, Settings card ----------
    // A bare /install-llm or /remove-llm opens a picker here (commandUi decoration in apply);
    // typed ids still run the server command. Installs run on the server and survive closing the dialog.
    const llmDialog = makeStore({ mode: null })
    const openLlm = (mode) => llmDialog.set({ mode })
    const bytes = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`)
    const ACTIVE_JOB = ['queued', 'downloading', 'extracting']

    /**
     * Local engine + module status, polled while shown (faster while something installs). Only the
     * newest load is applied: a poll that read the status before a save and answers after the save's
     * own reload would put the old values back on the page until the next poll.
     */
    function useLocal(active) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const seq = useRef(0)
      const load = useCallback(async () => {
        const n = ++seq.current
        try { const d = await api('/jev-router/local'); if (n === seq.current) { setData(d); setError('') } } catch (e) { if (n === seq.current) setError(e.message) }
      }, [])
      // Polled faster while something moves: an install, a hash, or a speed benchmark.
      const busy = !!data?.modules?.some((m) => ACTIVE_JOB.includes(m.job?.state) || m.state === 'verifying') || data?.speedRun?.state === 'running'
      useEffect(() => {
        if (!active) return
        load()
        const t = setInterval(() => { if (!document.hidden) load() }, busy ? 1500 : 5000)
        return () => clearInterval(t)
      }, [active, busy, load])
      return { data, error, load }
    }

    function JobLine({ job }) {
      if (!job) return null
      const p = job.total ? Math.min(100, Math.floor((job.received / job.total) * 100)) : 0
      const text = { queued: 'Queued', downloading: `Downloading ${p}%${job.bytesPerSec ? ` · ${(job.bytesPerSec / 1e6).toFixed(1)} MB/s` : ''}`, extracting: 'Unpacking…', done: 'Installed, SHA256 verified', failed: `Failed: ${job.error}` }[job.state] ?? job.state
      return h('div', { style: { marginTop: 4 } },
        h('div', { className: cx('why', job.state === 'failed' && 'err') }, text),
        ACTIVE_JOB.includes(job.state) ? h('div', { className: 'bar', role: 'progressbar', 'aria-label': 'Install progress', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p }, h('i', { style: { width: `${p}%` } })) : null)
    }
    const Badges = ({ list }) => h('div', { className: 'why' }, list.join(' · '))

    function InstallPicker({ onClose }) {
      const [cat, setCat] = useState(null)
      const [error, setError] = useState('')
      const [picked, setPicked] = useState(null)
      const [sent, setSent] = useState(false)
      const { data } = useLocal(true)
      useEffect(() => {
        api('/jev-router/local/catalog').then((c) => { setCat(c); setPicked(new Set(c.suggestions.map((s) => s.id))) }, (e) => setError(e.message))
      }, [])
      const jobOf = (id) => data?.modules?.find((m) => m.id === id)?.job
      const installedNow = (x) => x.installed || data?.modules?.find((m) => m.id === x.id)?.state === 'installed'
      const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
      const install = async () => {
        setError('')
        try { await post('/jev-router/local/install', { ids: [...picked] }); setSent(true) } catch (e) { setError(e.message) }
      }
      const engineJobs = cat ? cat.engine.ids.map(jobOf).filter(Boolean) : []
      return h('div', { className: 'jevi jevi-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'jevi-llm-t', onClick: onClose },
        h('div', { className: 'box wide', onClick: (e) => e.stopPropagation() },
          h('h3', { id: 'jevi-llm-t' }, 'Install local models'),
          error ? h('div', { className: 'err', role: 'alert' }, error) : null,
          !cat ? h('div', { className: 'muted' }, error ? '' : 'Checking this PC…') : h(React.Fragment, null,
            h('div', { className: 'note' }, h('b', null, 'Your PC: '), cat.pc),
            h('div', { className: 'card' },
              h('div', { className: 'label' }, 'Suggested for your PC'),
              cat.suggestions.length
                ? h('ul', { className: 'plain' }, ...cat.suggestions.map((s) => h('li', { key: s.id }, h('span', null, s.reason))))
                : h('div', { className: 'why' }, cat.none)),
            h('div', { className: 'why', style: { margin: '0 0 8px' } }, `Engine for this PC: ${cat.engine.name}${cat.engine.installed ? ' (installed)' : ` · ${bytes(cat.engine.size)}, installed first`}`),
            ...engineJobs.map((j, i) => h(JobLine, { key: `e${i}`, job: j })),
            h('ul', { className: 'plain', 'aria-label': 'Local models' }, ...cat.modules.map((x) => {
              const inst = installedNow(x)
              const job = jobOf(x.id)
              // A row not pinned yet cannot be picked: nothing downloads a file it has no SHA-256 for
              // (local.js isPinned), and its line under the badges says what pins it.
              const blocked = x.rating.fit === 'no' || !!x.unpinned
              const id = `jevi-llm-${x.id}`
              return h('li', { key: x.id, style: { alignItems: 'flex-start' } },
                h('label', { htmlFor: id, style: { display: 'flex', gap: 8, minWidth: 0, cursor: inst || blocked ? 'default' : 'pointer' } },
                  h('input', { id, type: 'checkbox', checked: !inst && !blocked && !!picked?.has(x.id), disabled: inst || blocked || ACTIVE_JOB.includes(job?.state), onChange: () => toggle(x.id), style: { marginTop: 3 } }),
                  h('div', { style: { minWidth: 0 } },
                    h('div', null, h('b', null, x.name), h('span', { className: 'pill' }, x.unpinned ? 'size not checked yet' : bytes(x.size)), inst ? h('span', { className: 'pill ok' }, 'installed') : null, x.suggested && !inst ? h('span', { className: 'pill ok' }, 'suggested') : null),
                    h('div', { className: cx('why', x.rating.fit === 'no' && 'err') }, x.rating.fit === 'no' ? `Won't fit: ${x.rating.reason}` : x.rating.label),
                    h(Badges, { list: x.badges }),
                    h('div', { className: 'why' }, [x.agent ? `Agent: ${x.agent}` : x.for ? `Add-on for ${x.for}` : null, `Source: ${x.repo}`, x.license].filter(Boolean).join(' · ')),
                    x.notes ? h('div', { className: 'why' }, x.notes) : null,
                    x.whyNot && !inst ? h('div', { className: 'why' }, x.whyNot) : null,
                    h(JobLine, { job }))))
            }))),
          sent ? h('div', { className: 'note', role: 'status' }, 'Installing. You can close this; progress also shows in Settings → Jev setup → Local models and the log.') : null,
          h('div', { className: 'actions' },
            h('button', { className: 'btn', onClick: onClose, autoFocus: true }, 'Close'),
            h('button', { className: 'btn primary', disabled: !picked?.size || !cat, onClick: install }, `Install${picked?.size ? ` (${picked.size})` : ''}`))))
    }

    /** Installed modules as removable rows: the engine is one row (one folder). */
    function removableRows(data) {
      const mods = data?.modules ?? []
      const eng = mods.filter((m) => m.kind === 'engine' && m.state === 'installed')
      return [
        ...(eng.length ? [{ id: 'engine', ids: eng.map((m) => m.id), name: `llama.cpp engine (${data.engine.variant ?? eng[0].variant})`, files: ['engine/llama (whole folder)'], size: eng.reduce((n, m) => n + m.size, 0) }] : []),
        ...mods.filter((m) => m.kind !== 'engine' && ['installed', 'corrupt'].includes(m.state)).map((m) => ({ id: m.id, ids: [m.id], name: m.name, files: [m.file], size: m.size })),
      ]
    }
    const removeConfirm = (rows, run) => ({
      title: rows.length > 1 ? `Remove ${rows.length} local modules?` : `Remove ${rows[0].name}?`,
      body: `This deletes ${rows.flatMap((r) => r.files).join(', ')} (${bytes(rows.reduce((n, r) => n + r.size, 0))} in total) from this PC. A running local model is stopped first. You can install it again later.`,
      confirmLabel: rows.length > 1 ? `Remove ${rows.length}` : 'Remove',
      run,
    })

    function RemovePicker({ onClose }) {
      const { data, error: loadErr, load } = useLocal(true)
      const [picked, setPicked] = useState(() => new Set())
      const [confirm, setConfirm] = useState(null)
      const [error, setError] = useState('')
      const [done, setDone] = useState('')
      const rows = removableRows(data)
      const chosen = rows.filter((r) => picked.has(r.id))
      const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
      return h('div', { className: 'jevi jevi-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'jevi-llmr-t', onClick: onClose },
        h('div', { className: 'box wide', onClick: (e) => e.stopPropagation() },
          h('h3', { id: 'jevi-llmr-t' }, 'Remove local models'),
          error || loadErr ? h('div', { className: 'err', role: 'alert' }, error || loadErr) : null,
          done ? h('div', { className: 'note', role: 'status' }, done) : null,
          !data ? h('div', { className: 'muted' }, 'Loading…') : rows.length === 0 ? h('div', { className: 'muted' }, 'Nothing is installed.')
            : h('ul', { className: 'plain' }, ...rows.map((r) => h('li', { key: r.id },
              h('label', { className: 'toggle' },
                h('input', { type: 'checkbox', checked: picked.has(r.id), onChange: () => toggle(r.id) }),
                h('b', null, r.name)),
              h('span', { className: 'why' }, `${r.files.join(', ')} · ${bytes(r.size)}`)))),
          h('div', { className: 'actions' },
            h('button', { className: 'btn', onClick: onClose, autoFocus: true }, 'Close'),
            h('button', { className: 'btn danger', disabled: !chosen.length, onClick: () => setConfirm(removeConfirm(chosen, () => post('/jev-router/local/remove', { ids: chosen.flatMap((r) => r.ids) }))) }, `Remove${chosen.length ? ` (${chosen.length})` : ''}`))),
        confirm ? h(Confirm, {
          ...confirm,
          onCancel: () => setConfirm(null),
          onConfirm: () => {
            const c = confirm
            setConfirm(null); setError('')
            Promise.resolve(c.run()).then(() => { setDone('Removed.'); setPicked(new Set()); load() }, (e) => setError(e.message))
          },
        }) : null)
    }

    function LlmDialog() {
      useStyle()
      const { mode } = llmDialog.use()
      const close = useCallback(() => llmDialog.set({ mode: null }), [])
      useEffect(() => {
        if (!mode) return
        const k = (e) => { if (e.key === 'Escape' && !document.querySelector('#jevi-confirm-t')) close() }
        window.addEventListener('keydown', k)
        return () => window.removeEventListener('keydown', k)
      }, [mode, close])
      if (mode === 'install') return h(InstallPicker, { onClose: close })
      if (mode === 'remove') return h(RemovePicker, { onClose: close })
      return null
    }

    // ---- pure budget helpers: no React, no state. test/budgetpanel.test.js evaluates this block
    // on its own (the runner cannot import a classic script), so nothing in it may reach outside it.

    // local.js MIN_CTX. The page cannot import it, so it keeps a copy, and the test holds the two to
    // the same number: a floor explained as 12k beside a model clamped somewhere else would mislead.
    const MIN_CTX = 12288
    /** A size in GB as the page prints it, '-' when there is none. */
    const gbText = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${x} GB` : '-')
    /** A context size in tokens, as "16k" when it is a whole number of k. */
    const ctxText = (n) => (Number.isInteger(n) && n > 0 && n % 1024 === 0 ? `${n / 1024}k` : String(n))
    /**
     * "32k to 21k". Both ends in one unit: a context the plugin config set to no whole number of k is
     * the first one the budget tries, and then it and the one it came down to are given in tokens.
     */
    const reducedText = (from, to) => ([from, to].every((n) => n % 1024 === 0) ? `${ctxText(from)} to ${ctxText(to)}` : `${from} tokens to ${to} tokens`)
    const threadsText = (n) => `${n} thread${n === 1 ? '' : 's'}`
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    /** The day a figure was measured, "25 Sep", with its year when that is not this one. */
    const dayText = (iso, now = new Date()) => {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return 'an unknown day'
      return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}`
    }

    // local.js SPEED_DEPTH and SPEED_PREDICT, which the Benchmark button's words state; the test holds
    // the copies to the same numbers, as it does MIN_CTX.
    const SPEED_DEPTH = 8192
    const SPEED_PREDICT = 128
    const layaText = (device) => (device === 'cuda' ? 'the GPU' : 'the CPU')

    /**
     * An installed model's speed line (docs/benchmark.md 2.9), from the `speed` status() gives it
     * (`{ reading, stands, why }`, the reading for its next load) and its `rating`: the reading when
     * it stands, with where and how it was taken; the reading, why it does not stand for the next
     * load, and the estimate for that load; or, with none, the estimate, which says it is one.
     */
    const speedLine = (m) => {
      const r = m?.speed?.reading
      const rating = m?.rating
      // The estimate for the next load, from the rating status() gives when no reading stands for it.
      const estimate = () => {
        const guess = rating.wordsPerSecRange ? `about ${rating.wordsPerSecRange[0]} to ${rating.wordsPerSecRange[1]} words/s` : `about ${rating.wordsPerSec} words/s`
        const unknown = rating.wordsPerSecRange ? ", a range because this GPU's memory is unknown" : ''
        const from = rating.moe ? 'the weights it reads per token, its active experts and the rest,' : 'its size'
        return `${guess} estimated from ${from} and this PC's memory bandwidth${unknown}`
      }
      if (!r) {
        if (!rating) return 'Speed: not measured on this PC.'
        if (rating.fit === 'no') return `Speed: not measured on this PC, which cannot run it: ${rating.reason}.`
        return `Speed: not measured on this PC; ${estimate()}.`
      }
      const tps = Number(r.tokensPerSec).toFixed(1)
      if (!m.speed.stands) {
        const stale = `Speed: measured ${tps} tokens/s on ${dayText(r.at)}, but ${m.speed.why}, so that reading does not stand for the next load. Benchmark it again.`
        if (!rating) return stale
        if (rating.fit === 'no') return `${stale} This PC cannot run it now: ${rating.reason}.`
        return `${stale} Until then, ${estimate()}.`
      }
      const layers = r.cpuMoe?.cpuLayers ? `the experts of ${r.cpuMoe.cpuLayers} of ${r.cpuMoe.layers} layers in RAM` : r.cpuMoe ? 'every expert on the GPU' : r.layersOnGpu ? `${r.layersOnGpu.gpu} of ${r.layersOnGpu.total} layers on the GPU` : 'the engine did not report its GPU split'
      const beside = r.laya ? `, Laya on ${layaText(r.laya)} beside it` : ''
      const peak = Number.isFinite(r.peakRamGB) ? `, peak RAM ${r.peakRamGB.toFixed(1)} GB` : ''
      const how = `(measured ${dayText(r.at)}; ${layers}, ${threadsText(r.threads)}${beside}${peak})`
      const depth = `${Number(r.depth).toLocaleString('en-US')} tokens into a conversation`
      return r.promptTokensPerSec == null
        ? `Speed: ${tps} tokens/s generating, ${depth} ${how}. Its reading speed was not measured, because llama-server reused its prompt cache.`
        : `Speed: ${tps} tokens/s generating and ${Math.round(r.promptTokensPerSec)} tokens/s reading, both ${depth} ${how}.`
    }

    /**
     * What the speed run's output check found for the reading a model's speed line gives, when that
     * reading stands (docs/benchmark.md 2.15): the same as the baseline, kept as the first one,
     * accepted, or not checked. Null for a reading from before there was a check.
     */
    const outputLine = (m) => {
      const r = m?.speed?.reading
      const o = r?.output
      if (!o || !m.speed.stands) return null
      if (o.state === 'same') return `Output: the same as the ${dayText(o.baselineAt)} baseline, its first ${o.agreed} of ${o.of} ${o.unit} agreeing (${o.need} needed).`
      if (o.state === 'baseline') {
        const also = o.also ? ` It agrees with the ${dayText(o.also.baselineAt)} baseline of ${o.also.other} for its first ${o.also.agreed} of ${o.also.of} ${o.also.unit}.` : ''
        return `Output: kept on ${dayText(r.at)} as the baseline for this engine build and GPU split, which later runs are held to.${also}`
      }
      if (o.state === 'accepted') return `Output: accepted as the new baseline on ${dayText(o.acceptedAt)}; it had differed from the ${dayText(o.baselineAt)} one after ${o.agreed} ${o.unit}.`
      if (o.state === 'unchecked') return `Output: not checked (${o.why}).`
      return null
    }

    /**
     * A figure held apart because its output differed from the baseline (2.15), for the line its
     * Accept new output button sits on: what it is, and why it is not the model's speed. Null with none.
     */
    const heldLine = (m) => {
      const r = m?.speed?.held
      const o = r?.output
      if (!o) return null
      return `Benchmark of ${dayText(r.at)}: ${Number(r.tokensPerSec).toFixed(1)} tokens/s generating, but its output differs from the ${dayText(o.baselineAt)} baseline after ${o.agreed} ${o.unit} (${o.need} needed), so it is not taken as this model's speed. If the new output reads right, accept it: the figure becomes the model's speed and the output its baseline.`
    }

    /**
     * The Benchmark button's title: what it does, and how long it takes by the model's last reading
     * (its load, the fill at its reading speed and three generations at its speed), or that nobody
     * knows yet.
     */
    const speedButtonTitle = (m) => {
      const r = m?.speed?.reading
      let wait = 'How long is not known until it has run once; on the CPU it can take 10 minutes or more'
      if (r && r.tokensPerSec > 0) {
        const read = r.promptTokensPerSec > 0 ? r.depth / r.promptTokensPerSec : 0
        const minutes = Math.max(1, Math.round(((r.loadMs ?? 0) / 1000 + read + (3 * r.nPredict) / r.tokensPerSec) / 60))
        wait = `About ${minutes} minute${minutes === 1 ? '' : 's'} by its last measurement${read ? '' : ', and longer by the time it takes to read the prompt, which was not measured'}`
      }
      return `Load it at the context its runs get, read an ${SPEED_DEPTH.toLocaleString('en-US')}-token prompt and time ${SPEED_PREDICT} generated tokens after it three times. ${wait}; a model you had loaded is loaded again after.`
    }

    /**
     * What the card says of the speed run (status().speedRun, 2.5 and 2.9): while it goes, where it
     * is, what follows and that local agents wait; the models measured so far, with their readings
     * or why none was recorded; and, once it has ended, what became of the model that was loaded.
     */
    const speedRunText = (run, modules) => {
      if (!run) return { running: false, status: [], done: [], restore: null, cancel: null, log: null }
      const name = (id) => (modules ?? []).find((m) => m.id === id)?.name ?? id
      const status = []
      const c = run.current
      if (run.state === 'running' && c) {
        if (c.phase === 'restoring') status.push(c.id ? `Speed benchmark: loading ${name(c.id)} again, as it was before.` : 'Speed benchmark: stopping the engine again, as it was before.')
        else {
          const phase = {
            loading: 'loading it at the context its runs get',
            warming: 'a first short request, not timed',
            reading: `reading an ${SPEED_DEPTH.toLocaleString('en-US')}-token prompt`,
            measuring: `timing ${SPEED_PREDICT} generated tokens, ${c.run} of 3`,
            checking: 'checking its output against the one kept from its first run',
          }[c.phase] ?? c.phase
          const k = run.done.length + 1
          const then = run.queue.length ? ` Then ${run.queue.map(name).join(', ')}.` : ''
          status.push(`Speed benchmark: ${name(c.id)}, ${k} of ${k + run.queue.length}: ${phase}.${then}`)
        }
        status.push('Local agents wait until the speed benchmark ends; a chat title or a compaction waits for the model being measured.')
      }
      // Cancel stops a run while it measures; once pressed it is under way, and while the run puts the
      // engine back there is nothing left to stop (local.js cancelBenchmark refuses it and says why).
      const restoring = run.state === 'running' && c?.phase === 'restoring'
      const cancelled = run.state === 'running' && !!run.cancelled
      const cancel = { disabled: restoring || cancelled, label: cancelled ? 'Cancelling…' : 'Cancel', title: restoring ? 'The speed benchmark has measured every model it will and is putting the engine back as it was before it; that cannot be cancelled.' : undefined }
      // Where the run is logged (2.13), once it has ended, and at once a log that could not be written.
      const log = run.logError
        ? { text: `The speed run log could not be written (${run.logError}); the readings are kept all the same.`, err: true }
        : run.log && run.state !== 'running' && run.restore
          ? { text: `Logged in ${run.log.history}, with this run in detail in ${run.log.detail.split(/[\\/]/).pop()} beside it.`, err: false }
          : null
      return { running: run.state === 'running', status, done: (run.done ?? []).map((d) => ({ text: d.text, ok: !!d.ok })), restore: run.restore ?? null, cancel, log }
    }

    /**
     * The four limits, in the order the table lists them. `title` is the field's tooltip: what the
     * limit holds and what blank means. VRAM, cores and tasks at once are real caps; RAM is not, and
     * the words under the table say so (budgetNotes).
     */
    const BUDGET_ROWS = [
      { key: 'maxVramGB', label: 'VRAM', id: 'jevi-lm-vram', unit: 'GB', title: 'GPU memory the local model may use, in GB. The layers that do not fit run from RAM. Blank: no limit.' },
      { key: 'maxRamGB', label: 'RAM', id: 'jevi-lm-ram', unit: 'GB', title: 'Memory the local model may use, in GB. A soft limit: see below. Blank: no limit.' },
      { key: 'maxCores', label: 'Cores', id: 'jevi-lm-cores', unit: '', title: 'Threads the local model may run on. Blank: a default that leaves the app at least a quarter of the machine.' },
      { key: 'maxConcurrentTasks', label: 'Tasks at once', id: 'jevi-lm-tasks', unit: '', title: 'Agent runs at once across every workspace, foreground and background, read-only runs included. A workspace runs one task that writes at a time; a task judged read only runs beside it on an agent locked against writing. Blank: no limit.' },
    ]

    /** The budget in words, "2 GB VRAM + 8 GB RAM", as local.js words it in a refusal; null when none is set. */
    const budgetText = (s) => [s?.maxVramGB != null && `${s.maxVramGB} GB VRAM`, s?.maxRamGB != null && `${s.maxRamGB} GB RAM`].filter(Boolean).join(' + ') || null

    const NO_FIGURE = { text: '-', note: null, title: null }
    /**
     * Tasks at once, now, from the response's `slots`: the runs holding a slot, counted by the lanes
     * that hold the cap, so a foreground /auto, /<agent> or jev_route is in it as much as a background
     * task. With a cap, the runs waiting only for a free slot are named beside it; a run waiting
     * behind another in its own workspace is not, since a free slot would not start it. Lowering the
     * cap stops nothing that runs, so the count can be over it, and the tooltip then says why. '-'
     * only when the response carries no count, which is not the same as none running: a count of the
     * background tasks alone would leave out the foreground runs, so the page never makes one up.
     */
    const tasksNow = (slots) => {
      if (!Number.isInteger(slots?.held)) return { ...NO_FIGURE, title: 'How many run now is not reported to this page' }
      const capped = slots.max != null
      const waiting = capped && slots.waiting > 0 ? slots.waiting : 0
      const over = capped && slots.held > slots.max ? ' That is more than the budget: lowering it stops nothing that already runs, and nothing new starts until fewer do.' : ''
      const waits = !capped ? '' : waiting ? ` ${waiting} more ${waiting === 1 ? 'waits' : 'wait'} for a free slot.` : ' None waits for a free slot.'
      return {
        text: String(slots.held),
        note: waiting ? `${waiting} waiting` : null,
        title: `Agent runs holding a slot now, across every workspace: a foreground /auto, /<agent> or jev_route counts as much as a background task.${over}${waits}`,
      }
    }

    /**
     * Laya's share of the memory the budget holds (docs/laya-auto.md 7.7), from the Laya status the
     * response carries as `laya` (null or absent when Laya is not installed): what it takes now while
     * it runs, else what it would take at its next start (`need`), on the device it runs or would
     * run on. A held Laya (Keep Laya loaded, or an open Laya Auto run) keeps its memory beside a
     * local model; any other gives it up when a local model starts, but one that started after the
     * model loaded stays beside it until it is stopped, so while both are loaded they count together.
     * Null when Laya is not installed.
     */
    const layaShare = (laya) => {
      if (!laya?.installed) return null
      const r = laya.running
      const held = (r?.held ?? []).length > 0 || !!laya.settings?.keepLoaded
      const device = r ? r.device : laya.need?.device ?? null
      const from = r ?? (device ? { vramGB: laya.need?.cuda?.vramGB, ramGB: laya.need?.[device]?.ramGB } : {})
      return {
        running: !!r, held, device, vramGB: device === 'cuda' ? from.vramGB ?? null : null, ramGB: from.ramGB ?? null,
        source: { vramGB: r?.vramSource ?? null, ramGB: r?.ramSource ?? null },
      }
    }
    const sumGB = (a, b) => Math.round(((a ?? 0) + (b ?? 0)) * 100) / 100
    const layaOn = (l) => (l.device === 'cuda' ? 'the GPU' : 'the CPU')
    /**
     * Where a running Laya's figure comes from (7.7), as a Now cell's note says it and its title
     * explains it, the way llama.cpp's say `load report` or `working set`: its working set while a
     * RAM budget is set, else what its first start on that device measured, which is never read again.
     */
    const layaFigure = (laya, side) => (laya.source?.[side] === 'working set'
      ? { note: 'working set', says: `its real memory use on ${layaOn(laya)}, read every 5 seconds while a RAM budget is set` }
      : { note: 'at its first start', says: `what it took on ${layaOn(laya)} when its first start there measured it; ${side === 'ramGB' ? 'its real use is read only while a RAM budget is set' : 'the GPU memory it holds is not read again while it runs'}` })
    /** A Now cell with Laya in it while Laya runs: the two together, and each one's share (7.7). */
    const withLayaNow = (cell, llama, laya, side) => {
      const mine = laya?.running ? laya[side] : null
      if (typeof mine !== 'number') return cell
      const { note, says } = layaFigure(laya, side)
      return {
        text: gbText(sumGB(llama, mine)),
        note: `Laya ${gbText(mine)} ${note}, llama.cpp ${typeof llama === 'number' ? gbText(llama) : 'not loaded'}`,
        title: `${typeof llama === 'number' ? `llama.cpp: ${String(cell.title).replace(/\.$/, '')}. ` : ''}Laya: ${says}.`,
      }
    }
    /**
     * An Estimated peak cell with Laya in it: added when Laya is held, else the larger of the two
     * (7.7), and never less than what Laya and the model loaded now take together (`loadedNow`, the
     * model's figure in the Now cell), since a Laya that started after the model stays beside it.
     * With no local model the budget lets load, the peak is Laya's, and the note says so.
     */
    const withLayaPeak = (cell, llama, laya, side, loadedNow = null) => {
      const mine = laya?.[side]
      if (typeof mine !== 'number') return cell
      const hasModel = typeof llama === 'number'
      const figure = laya.running ? layaFigure(laya, side).says : `what it would take at its next start, on ${layaOn(laya)}`
      const model = hasModel ? `llama.cpp: ${cell.title} ` : ''
      if (laya.held) {
        const note = hasModel ? `Laya ${gbText(mine)}, llama.cpp ${gbText(llama)}` : `Laya ${gbText(mine)}; no local model the budget lets load`
        return { text: gbText(sumGB(llama, mine)), note, title: `${model}Laya: ${figure}. Laya is held (Keep Laya loaded, or a Laya Auto run), so it keeps its memory beside a local model, and the two are counted together.` }
      }
      const together = laya.running && typeof loadedNow === 'number' ? sumGB(loadedNow, mine) : null
      const larger = Math.max(llama ?? 0, mine)
      const note = together != null && together >= larger ? `Laya ${gbText(mine)} and llama.cpp ${gbText(loadedNow)}, loaded together now`
        : !hasModel ? `Laya ${gbText(mine)}; no local model the budget lets load` : `the larger of Laya ${gbText(mine)} and llama.cpp ${gbText(llama)}`
      return { text: gbText(Math.max(together ?? 0, larger)), note, title: `${model}Laya: ${figure}. Laya is not held, so it gives its memory up when a local model starts; while both are loaded they are counted together.` }
    }
    /** What a held Laya on the GPU costs the local models, said on the Laya card and under this table (7.7). */
    const layaHeldNote = (vramGB) => `While Laya is held (Keep Laya loaded, or a Laya Auto run), the VRAM budget holds Laya and the chat model together${typeof vramGB === 'number' ? `, and on a 4 GB GPU local models get about ${Math.round(vramGB * 10) / 10} GB less` : ''}. Otherwise Laya gives the GPU up when a local model starts.`
    /**
     * The table's cells from GET /jev-router/local, one row per limit: the saved budget as its field
     * shows it, what the loaded model uses now, and the most the next load could take.
     *
     * Now is the loaded model's own figure: VRAM from the engine's load report, and RAM from the
     * watchdog's latest reading of the working set (taken only while a RAM budget is set), else from
     * the load report. Each says which, since the two measure different things. The estimated peak is
     * the largest figure among the installed models the budget lets load, because any of them may be
     * the next one loaded; a model the budget refuses never loads, so it is no part of the peak. Only
     * RAM is refused, so a VRAM peak can be over the VRAM budget where --fit does not hold it, and
     * its tooltip says so rather than leave a figure over the budget in the budget's own row
     * unexplained. Tasks at once is the runs holding a slot now (tasksNow).
     */
    const budgetCells = (status) => {
      const s = status?.settings ?? {}
      const e = status?.engine ?? {}
      const b = status?.budget ?? {}
      const loaded = e.running ? e.memory : null
      const loadable = (status?.modules ?? []).filter((m) => m.kind === 'model' && m.state === 'installed' && m.memory && !m.overBudget)
      const peak = (side) => {
        const top = loadable.reduce((a, m) => (a && a.memory[side] >= m.memory[side] ? a : m), null)
        if (!top) return { ...NO_FIGURE, title: 'No installed model the budget lets load' }
        const over = side === 'vramGB' && s.maxVramGB != null && top.memory.vramGB > s.maxVramGB
          ? ` That is more than the VRAM budget${b.vramNotApplied ? ', which is not applied: see below' : ''}.` : ''
        return { text: gbText(top.memory[side]), note: top.memory.source, title: `${top.name} at ${ctxText(top.ctx)} context, the most any installed model the budget lets load would take.${over}` }
      }
      const report = "What the loaded model took, from the engine's own load report"
      const ramNow = e.running && e.workingSetGB != null ? { text: gbText(e.workingSetGB), note: 'working set', title: "The loaded model's real memory use, read every 5 seconds while a RAM budget is set" }
        : loaded ? { text: gbText(loaded.ramGB), note: 'load report', title: `${report}. Its real use is read only while a RAM budget is set.` } : NO_FIGURE
      // llama.cpp's own figures, for Laya's share beside them.
      const llama = {
        now: { vramGB: loaded?.vramGB ?? null, ramGB: e.running ? e.workingSetGB ?? loaded?.ramGB ?? null : null },
        peak: (side) => loadable.reduce((a, m) => Math.max(a ?? 0, m.memory[side] ?? 0), null),
      }
      const laya = layaShare(status?.laya)
      const cells = {
        maxVramGB: { now: withLayaNow(loaded ? { text: gbText(loaded.vramGB), note: 'load report', title: report } : NO_FIGURE, llama.now.vramGB, laya, 'vramGB'), peak: withLayaPeak(peak('vramGB'), llama.peak('vramGB'), laya, 'vramGB', llama.now.vramGB) },
        maxRamGB: { now: withLayaNow(ramNow, llama.now.ramGB, laya, 'ramGB'), peak: withLayaPeak(peak('ramGB'), llama.peak('ramGB'), laya, 'ramGB', llama.now.ramGB) },
        maxCores: {
          now: e.running && e.threads ? { text: threadsText(e.threads), note: null, title: 'Threads the loaded model runs on' } : NO_FIGURE,
          // A core budget above what this PC has gives it every processor there is, and no more.
          peak: b.threads ? { text: threadsText(b.threads), note: s.maxCores == null ? 'default' : b.threads < s.maxCores ? 'all this PC has' : null, title: 'Threads the next load gets' } : NO_FIGURE,
        },
        maxConcurrentTasks: { now: tasksNow(status?.slots), peak: NO_FIGURE },
      }
      return BUDGET_ROWS.map((r) => ({ ...r, value: s[r.key] == null ? '' : String(s[r.key]), ...cells[r.key] }))
    }

    /**
     * What a budget field's text asks the server to save: `{ patch }`, `{ error }` for text that is no
     * number, or `{}` when there is nothing to send (never typed in, or the value already saved).
     * Blank is no limit. A decimal comma reads as a point, but only with one or two digits after it,
     * since three are a thousands separator (4,096 is not 4.096 GB). Text that is no number is refused
     * here and never sent: JSON has no NaN, so it would reach the server as null and lift the limit,
     * the opposite of what was typed. The bounds are left to the server, which keeps the one copy.
     */
    const budgetPatch = (key, text, saved) => {
      if (text == null) return {}
      const t = String(text).trim().replace(/^(\d+),(\d{1,2})$/, '$1.$2')
      const value = t === '' ? null : Number(t)
      if (value !== null && !Number.isFinite(value)) {
        const row = BUDGET_ROWS.find((r) => r.key === key)
        return { error: `${row.label}: a number${row.unit ? ` of ${row.unit}` : ''}, or blank for no limit` }
      }
      return value === (saved ?? null) ? {} : { patch: { [key]: value } }
    }
    /** A refusal from the server in the page's words: what the API calls null is a blank field here. */
    const budgetError = (message) => String(message).replace(/, or null for no limit$/, ', or blank for no limit')

    /**
     * One installed model against the budget (`s`, the settings) and what the budget makes of the
     * next load (`b`, status().budget): what it takes at the context it runs with, measured or
     * estimated (always saying which), and whether it fits. `over` is the refusal a load would throw,
     * word for word, a RAM watchdog unload included. With no budget set there is nothing to fit, and
     * the line says nothing of it. `floor` warns of a context under MIN_CTX, which the plugin config
     * can set and the page must not pass over in silence. `reduced` says when the RAM budget sized
     * the context down to the one the line shows, from what to what (reducedText); a model refused
     * even at the floor loads with none, and its refusal says so instead.
     *
     * Only RAM is ever refused. VRAM is held by --fit, and where --fit cannot hold it (layers pinned
     * by hand, a GPU of unknown size) a model loads whatever its VRAM figure, and an estimate there
     * assumes the budget holds. So "fits" is said only of a figure the VRAM budget really holds, and
     * otherwise the line says why it is not.
     */
    const modelFit = (m, s, b) => {
      if (!m?.memory) return null
      const budget = budgetText(s)
      const vram = s?.maxVramGB == null ? null
        : b?.vramNotApplied ? 'VRAM budget not applied'
          : m.memory.vramGB > s.maxVramGB ? `over your VRAM budget of ${gbText(s.maxVramGB)}` : null
      const fits = !budget || m.overBudget ? '' : ` · ${vram ?? `fits your budget of ${budget}`}`
      // A measured figure says the day it was taken, which recordMemory keeps as `at`.
      const source = m.memory.source === 'measured' && m.memory.at ? `measured on ${dayText(m.memory.at)}` : m.memory.source
      return {
        line: `${ctxText(m.ctx)} context: ${gbText(m.memory.vramGB)} VRAM + ${gbText(m.memory.ramGB)} RAM (${source})${fits}`,
        over: m.overBudget ?? null,
        floor: Number.isFinite(m.ctx) && m.ctx < MIN_CTX ? `${ctxText(m.ctx)} context is below the ${ctxText(MIN_CTX)} floor, so expect a context-exceeded error mid-chat: it comes from the context size, not from the model.` : null,
        reduced: m.ctxReducedFrom && !m.overBudget ? `The budget reduced its context from ${reducedText(m.ctxReducedFrom, m.ctx)}, the largest that fits it.` : null,
      }
    }

    /** A model as the pickers name it: one the budget refuses says so beside its name. */
    const modelName = (m) => (m.overBudget ? `${m.name} (over budget)` : m.name)
    /**
     * The chat model select's options. The server answers with the chat model in effect, which is
     * the stored choice only while the budget lets it load, so a model the budget refuses is named
     * as over it and cannot be picked: picked, it would be saved, and the select would jump back to
     * the model in effect with no word why. With none the budget lets load there is no chat model,
     * and the select says so rather than show the first model as if it were the one in use.
     */
    const chatModelOptions = (models, chatModel) => [
      ...(chatModel == null ? [{ value: '', label: 'None fits the budget', disabled: true }] : []),
      ...models.map((m) => ({ value: m.id, label: modelName(m), disabled: !!m.overBudget })),
    ]

    /**
     * The words under the table, which say what the budget can and cannot hold. RAM gets the honest
     * version: nothing KzH can use stops a process's memory from growing (that takes a native Job
     * Object), so it is kept by sizing a model's context down to fit it, by refusing a model over it
     * even at the floor and by the watchdog, and the page must not imply a cap. The app window and its
     * browser view are never capped, and no figure here includes them. The context floor is
     * explained, because a floor that is only enforced costs whoever meets the error it prevents an
     * hour of blaming the model.
     */
    const budgetNotes = (status) => [
      { text: `RAM is a soft limit: nothing KzH can use stops a process's memory from growing. A model whose figure is over the RAM budget loads with a smaller context, down to the ${ctxText(MIN_CTX)} floor; one still over it there is refused before it loads, and a watchdog unloads a model whose real use stays over it for 30 seconds.`, warn: false },
      { text: 'The app window and its browser view are never capped, since the app cannot run without them, and they are not in these figures: leave room for them when you set the RAM budget.', warn: false },
      ...(status?.budget?.vramNotApplied ? [{ text: `VRAM budget not applied: ${status.budget.vramNotApplied}.`, warn: true }] : []),
      ...(status?.laya?.installed?.cuda ? [{ text: layaHeldNote(status.laya.running?.device === 'cuda' ? status.laya.running.vramGB : status.laya.need?.cuda?.vramGB), warn: false }] : []),
      { text: `The context floor is ${ctxText(MIN_CTX)} (${MIN_CTX} tokens): the system prompt and the tool list alone take about 8.6k tokens, and below roughly 12k a local model stops mid-chat with a context-exceeded error that looks like a fault in the model but is not one.`, warn: false },
    ]
    // ---- end pure budget helpers

    /**
     * The resource budget, inside the local models card: one row per limit, with the field that sets
     * it, what the loaded model uses now and the most the next load could take (budgetCells), then
     * what the budget can and cannot hold, in words (budgetNotes). A field saves when it loses focus,
     * like the panel's other fields; `edits` holds what is being typed, over the saved value, until then.
     * `errors` holds each field's refusal by key, shown in the table's order.
     */
    function ResourceBudget({ data, edits, errors, onEdit, onSave }) {
      const figure = (c) => h('td', { title: c.title ?? undefined }, c.text, c.note ? h('span', { className: 'why' }, ` (${c.note})`) : null)
      return h(React.Fragment, null,
        h('div', { className: 'label', id: 'jevi-lm-budget-h', style: { margin: '12px 0 4px' } }, 'Resource budget'),
        h('p', { className: 'why', style: { margin: '0 0 4px' } }, 'How much of this PC KzH may use. Leave a field blank for no limit.'),
        h('table', { className: 'budget', 'aria-labelledby': 'jevi-lm-budget-h' },
          h('thead', null, h('tr', null, h('td', null), h('th', { scope: 'col' }, 'Budget'), h('th', { scope: 'col' }, 'Now'), h('th', { scope: 'col' }, 'Estimated peak'))),
          h('tbody', null, ...budgetCells(data).map((c) => h('tr', { key: c.key },
            h('th', { scope: 'row' }, h('label', { htmlFor: c.id }, c.label)),
            h('td', null,
              h('input', { id: c.id, type: 'text', inputMode: c.unit ? 'decimal' : 'numeric', value: edits[c.key] ?? c.value, placeholder: 'no limit', title: c.title, style: { width: 64 }, onChange: (ev) => onEdit(c.key, ev.target.value), onBlur: () => onSave(c.key) }),
              c.unit ? ` ${c.unit}` : null),
            figure(c.now), figure(c.peak))))),
        ...BUDGET_ROWS.filter((r) => errors[r.key]).map((r) => h('div', { key: `err-${r.key}`, className: 'err', role: 'alert' }, errors[r.key])),
        ...budgetNotes(data).map((n, i) => h('div', { key: i, className: n.warn ? 'warnline' : 'why', style: { marginTop: 4 } }, n.text)))
    }

    /** Settings → Jev setup: engine status, chat model, idle stop, GPU layers, the resource budget, installed modules. */
    function LocalModelsCard({ ask }) {
      const { data, error, load } = useLocal(true)
      const [msg, setMsg] = useState('')
      const [idle, setIdle] = useState('')
      const [layers, setLayers] = useState('')
      const [startModel, setStartModel] = useState('')
      // Budget fields being typed in, by key, until they save. Blank is a value here (no limit), so
      // the fill-it-if-empty the idle and layers fields use would put the saved value back over a
      // field just cleared at the next poll.
      const [budget, setBudget] = useState({})
      // Each field's refusal by key, so a save of one field never clears another's: a field still
      // showing a value that was refused must go on saying it was not saved.
      const [budgetMsg, setBudgetMsg] = useState({})
      useEffect(() => {
        if (!data) return
        setIdle((v) => v || String(data.settings.idleMinutes))
        setLayers((v) => v || String(data.settings.gpuLayers ?? 'auto'))
      }, [data])
      const run = async (fn) => { setMsg(''); try { await fn(); await load() } catch (e) { setMsg(e.message) } }
      // Saved, reloaded, and only then the edit dropped, so the field goes from what was typed to
      // what was saved and never shows the old value in between. A refused one keeps what was typed,
      // with the reason under the table. The edit is dropped only if it is still the text that was
      // saved: whatever was typed while the save was on its way is kept, and saved at the next blur.
      const saveBudget = async (key) => {
        const typed = budget[key]
        if (typed === undefined) return
        const { patch, error: bad } = budgetPatch(key, typed, data.settings[key])
        setBudgetMsg((m) => ({ ...m, [key]: bad ?? '' }))
        if (bad) return
        if (patch) {
          try { await post('/jev-router/local/settings', patch); await load() } catch (e) { setBudgetMsg((m) => ({ ...m, [key]: budgetError(e.message) })); return }
        }
        setBudget((b) => { if (b[key] !== typed) return b; const n = { ...b }; delete n[key]; return n })
      }
      if (!data) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'Local models'), h('div', { className: error ? 'err' : 'muted' }, error || 'Loading…'))
      const e = data.engine
      const models = data.modules.filter((m) => m.kind === 'model' && m.state === 'installed')
      const pick = startModel || data.settings.chatModel || models[0]?.id || ''
      const rows = removableRows(data)
      // Mixture-of-experts models not installed yet: where they would run on this PC, or why they
      // would not, and what pins one that is not checked yet, before anyone opens Install….
      const moeRows = data.modules.filter((m) => m.kind === 'model' && m.moe && m.state !== 'installed')
      const busyJobs = data.modules.filter((m) => ACTIVE_JOB.includes(m.job?.state) || m.state === 'verifying')
      // The speed benchmark (docs/benchmark.md 2.9). It is free and changes nothing but which model is
      // loaded, so it asks for no confirmation; a refusal shows under the head with the card's others.
      const speed = speedRunText(data.speedRun, data.modules)
      const canBenchmark = e.installed && models.length > 0 && !speed.running
      const benchmark = (ids) => run(() => post('/jev-router/local/benchmark', ids ? { ids } : {}))
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-local-h' },
        h('div', { className: 'head' },
          h('div', { className: 'label', id: 'jevi-local-h', style: { margin: 0 } }, 'Local models'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { className: 'btn', disabled: !canBenchmark, title: `Measure every installed model's speed on this PC, one after another: each is loaded at the context its runs get, reads an ${SPEED_DEPTH.toLocaleString('en-US')}-token prompt and generates ${SPEED_PREDICT} tokens after it three times. A model you had loaded is loaded again after.`, onClick: () => benchmark(null) }, 'Benchmark all'),
            h('button', { className: 'btn primary', onClick: () => openLlm('install') }, 'Install…'),
            h('button', { className: 'btn danger', disabled: !rows.length, onClick: () => openLlm('remove') }, 'Remove…'))),
        h('p', { className: 'why', style: { margin: '4px 0 8px' } }, 'Free, private models on this PC (llama.cpp, 127.0.0.1 only). Used when you are offline, as a fallback chat model, and as cheap agents Jev may pick. Type /install-llm in any chat to add one.'),
        speed.status.length || speed.done.length || speed.restore || speed.log ? h('div', { role: 'status', 'aria-label': 'Speed benchmark', style: { margin: '0 0 8px' } },
          ...speed.status.map((t, i) => h('div', { key: `s${i}`, className: i === 0 ? null : 'why' }, t)),
          ...speed.done.map((d, i) => h('div', { key: `d${i}`, className: cx('why', !d.ok && 'err') }, d.text)),
          speed.restore ? h('div', { className: 'why' }, speed.restore) : null,
          speed.log ? h('div', { className: cx('why', speed.log.err && 'err') }, speed.log.text) : null,
          speed.running ? h('button', { className: 'btn', style: { marginTop: 4 }, disabled: speed.cancel.disabled, title: speed.cancel.title, onClick: () => run(() => post('/jev-router/local/benchmark/cancel', {})) }, speed.cancel.label) : null) : null,
        h('div', null, h('span', { className: cx('dot', e.running ? 'on' : 'off') }),
          !e.installed ? 'Engine not installed.' : e.running ? `Running ${e.model}${e.ready ? '' : ' (loading…)'} · 127.0.0.1:${e.port} · context ${e.ctx}${e.gpuLayers ? ` · ${e.gpuLayers.gpu}/${e.gpuLayers.total} layers on GPU` : ''}${e.vision ? ' · vision' : ''}` : `Stopped (engine: ${e.variant}). Starts by itself when a local model is needed.`),
        h('div', { className: 'why' }, 'On a 4 GB GPU a model bigger than ~3 GB splits between GPU and CPU and gets several times slower; the rest waits in RAM.'),
        e.installed && models.length ? h('div', { className: 'limits', style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('label', { htmlFor: 'jevi-lm-chat' }, 'Chat model ',
            h('select', { id: 'jevi-lm-chat', value: data.settings.chatModel ?? '', onChange: (ev) => run(() => post('/jev-router/local/settings', { chatModel: ev.target.value })) },
              ...chatModelOptions(models, data.settings.chatModel).map((o) => h('option', { key: o.value, value: o.value, disabled: o.disabled }, o.label)))),
          h('label', { htmlFor: 'jevi-lm-idle' }, 'Stop after idle (min) ',
            h('input', { id: 'jevi-lm-idle', type: 'number', min: 1, max: 240, value: idle, style: { width: 64 }, onChange: (ev) => setIdle(ev.target.value), onBlur: () => run(() => post('/jev-router/local/settings', { idleMinutes: Number(idle) })) })),
          h('label', { htmlFor: 'jevi-lm-ngl' }, 'GPU layers ',
            h('input', { id: 'jevi-lm-ngl', type: 'text', value: layers, style: { width: 64 }, title: "'auto' fits as many layers as free VRAM allows; a number pins it", onChange: (ev) => setLayers(ev.target.value), onBlur: () => run(() => post('/jev-router/local/settings', { gpuLayers: layers.trim() === 'auto' ? 'auto' : Number(layers) })) })),
          e.running
            ? h('button', { className: 'btn', onClick: () => run(() => post('/jev-router/local/stop', {})) }, 'Stop')
            : h(React.Fragment, null,
              h('select', { 'aria-label': 'Model to start', value: pick, onChange: (ev) => setStartModel(ev.target.value) }, ...models.map((m) => h('option', { key: m.id, value: m.id }, modelName(m)))),
              h('button', { className: 'btn', onClick: () => run(() => post('/jev-router/local/start', { model: pick })) }, 'Start'))) : null,
        msg ? h('div', { className: 'err', role: 'alert' }, msg) : null,
        busyJobs.length ? h('div', { style: { marginTop: 8 } }, ...busyJobs.map((m) => h('div', { key: m.id }, h('b', null, m.name), m.state === 'verifying' ? h('div', { className: 'why' }, 'Checking SHA256…') : h(JobLine, { job: m.job })))) : null,
        rows.length ? h('ul', { className: 'plain', style: { marginTop: 8 } }, ...rows.map((r) => {
          const m = data.modules.find((x) => x.id === r.ids[0])
          // What it takes at the context it runs with, under the budget as it stands, so a budget
          // change shows its effect on each model at the next reload.
          const chat = m?.kind === 'model' && m.state === 'installed'
          const fit = chat ? modelFit(m, data.settings, data.budget) : null
          return h('li', { key: r.id },
            h('div', { style: { minWidth: 0 } },
              h('div', null, h('b', null, r.name), m?.state === 'corrupt' ? h('span', { className: 'pill bad' }, 'SHA256 mismatch') : h('span', { className: 'pill ok' }, 'installed'), m?.agent ? h('span', { className: 'pill' }, m.agent) : null, fit?.over ? h('span', { className: 'pill bad' }, 'over budget') : null),
              h('div', { className: 'why' }, `${r.files.join(', ')} · ${bytes(r.size)}`),
              fit ? h('div', { className: 'why' }, fit.line) : null,
              fit?.reduced ? h('div', { className: 'why' }, fit.reduced) : null,
              fit?.over ? h('div', { className: cx('why', 'err') }, fit.over) : null,
              fit?.floor ? h('div', { className: 'warnline' }, fit.floor) : null,
              chat ? h('div', { className: 'why' }, speedLine(m)) : null,
              chat && outputLine(m) ? h('div', { className: 'why' }, outputLine(m)) : null,
              // A figure whose output differed from its baseline, with both outputs to read and the button that takes it (2.15).
              chat && heldLine(m) ? h('div', { className: 'warnline' }, heldLine(m)) : null,
              chat && heldLine(m) ? h('details', { className: 'answer' },
                h('summary', null, 'Both outputs'),
                h('div', { className: 'why' }, `The baseline, of ${dayText(m.speed.held.output.baselineAt)}:`),
                h('div', { className: 'answer-text' }, m.speed.held.output.baselineText),
                h('div', { className: 'why' }, `This run, of ${dayText(m.speed.held.at)}:`),
                h('div', { className: 'answer-text' }, m.speed.held.output.text)) : null,
              chat && heldLine(m) ? h('button', { className: 'btn', style: { marginTop: 4 }, disabled: speed.running, 'aria-label': `Accept new output of ${r.name}`, title: 'Take this figure as the model\'s speed, and keep this output as the baseline its later runs are held to.', onClick: () => run(() => post('/jev-router/local/benchmark/accept-output', { id: m.id })) }, 'Accept new output') : null,
              m?.badges ? h(Badges, { list: m.badges }) : null),
            h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
              chat ? h('button', { className: 'btn', disabled: !canBenchmark, 'aria-label': `Benchmark ${r.name}`, title: speedButtonTitle(m), onClick: () => benchmark([m.id]) }, 'Benchmark') : null,
              h('button', { className: 'btn danger', 'aria-label': `Remove ${r.name}`, onClick: () => ask(removeConfirm([r], () => post('/jev-router/local/remove', { ids: r.ids }))) }, 'Remove')))
        })) : h('div', { className: 'muted', style: { marginTop: 8 } }, 'Nothing installed yet. Install… suggests models that fit this PC.'),
        moeRows.length ? h('ul', { className: 'plain', 'aria-label': 'Mixture-of-experts models not installed', style: { marginTop: 8 } }, ...moeRows.map((m) => h('li', { key: m.id },
          h('div', { style: { minWidth: 0 } },
            h('div', null, h('b', null, m.name), h('span', { className: 'pill' }, 'not installed')),
            m.rating ? h('div', { className: cx('why', m.rating.fit === 'no' && 'err') }, m.rating.fit === 'no' ? `Won't fit: ${m.rating.reason}` : m.rating.label) : null,
            m.unpinned ? h('div', { className: 'warnline' }, `${m.unpinned[0].toUpperCase()}${m.unpinned.slice(1)}`) : null)))) : null,
        h(ResourceBudget, { data, edits: budget, errors: budgetMsg, onEdit: (k, v) => setBudget((b) => ({ ...b, [k]: v })), onSave: saveBudget }))
    }

    // ---------- icons (16px, currentColor) ----------
    const svg = (...kids) => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' }, ...kids)
    const P = (d) => h('path', { d })
    const ICON = {
      terminal: () => svg(P('M3 4.5 6.5 8 3 11.5'), P('M8 12h5')),
      // Reasoning/transcript: a page of lines, half of them showing.
      reasoning: () => svg(h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2 }), P('M5 6h6M5 8.5h6M5 11h3')),
      background: () => svg(P('M5.5 4h8M5.5 8h8M5.5 12h8'), P('M2.5 4h.01M2.5 8h.01M2.5 12h.01')),
      browser: () => svg(h('circle', { cx: 8, cy: 8, r: 6 }), P('M2 8h12'), P('M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14c-1.8-1.8-2.6-3.8-2.6-6S6.2 3.8 8 2z')),
      'jev-inspector': () => svg(h('circle', { cx: 7, cy: 7, r: 4.5 }), P('m10.5 10.5 3 3'), P('M5 7h4M7 5v4')),
      more: () => svg(h('circle', { cx: 8, cy: 3.5, r: 0.6 }), h('circle', { cx: 8, cy: 8, r: 0.6 }), h('circle', { cx: 8, cy: 12.5, r: 0.6 })),
      back: () => svg(P('M10 3.5 5.5 8l4.5 4.5')),
      forward: () => svg(P('M6 3.5 10.5 8 6 12.5')),
      reload: () => svg(P('M13 8a5 5 0 1 1-1.5-3.6'), P('M13 2.5v3h-3')),
      stop: () => svg(P('M4 4l8 8M12 4l-8 8')),
      external: () => svg(P('M9 3h4v4'), P('M13 3 7.5 8.5'), P('M11 9.5V13H3V5h3.5')),
    }

    // ---------- Browser tab ----------
    const HOME = 'http://localhost:3000'
    const httpUrl = (u) => { try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x.href : null } catch { return null } }
    const toUrl = (text) => httpUrl(text.trim()) ?? (/^[\w.-]+(:\d+)?(\/|$)/.test(text.trim()) ? httpUrl(`http://${text.trim()}`) : null)

    // Terminal tab (Start page entry): opens Windows Terminal in this session's project folder. The shell
    // runs outside the app on purpose: no command ever travels through the harness web server.
    function TerminalBody({ useTabInfo }) {
      useStyle()
      const info = useTabInfo?.()
      const [msg, setMsg] = useState('')
      const cwd = currentCwd()
      const open = async () => {
        try {
          if (!cwd) throw new Error('This session has no project folder')
          await post('/jev-router/open-terminal', { cwd })
          setMsg('Opened Windows Terminal in this folder.')
        } catch (e) { setMsg(e.message) }
      }
      const opened = useRef(false)
      useEffect(() => { if (info?.tab?.visible !== false && !opened.current) { opened.current = true; open() } }, [info?.tab?.visible])
      return h('div', { className: 'jevi' },
        h('h3', null, 'Terminal'),
        h('p', { className: 'muted' }, cwd ? cwd : 'Open a session in a project folder to use the terminal.'),
        h('button', { className: 'btn primary', disabled: !cwd, onClick: open }, 'Open terminal here'),
        msg ? h('div', { className: 'why', role: 'status', style: { marginTop: 8 } }, msg) : null,
        h('p', { className: 'why', style: { marginTop: 12 } }, 'The terminal opens as its own window (Windows Terminal, or PowerShell if that is not installed), so it has everything a real terminal has.'))
    }

    function BrowserBody({ useTabInfo, sessionId }) {
      useStyle()
      const info = useTabInfo?.()
      const visible = info?.tab?.visible ?? true
      const native = window.harness?.browser // the Kz-harness app's real browser view; absent in a plain web browser
      const store = `kz-browser:${sessionId}`
      const [url, setUrl] = useState(() => { try { return httpUrl(sessionStorage.getItem(store) ?? '') ?? HOME } catch { return HOME } })
      const [text, setText] = useState(url)
      const [state, setState] = useState(null) // native: { url, title, canGoBack, canGoForward, loading }
      const [hist, setHist] = useState({ list: [url], i: 0 }) // iframe fallback history (cross-origin frames hide theirs)
      const [frameKey, setFrameKey] = useState(0)
      const [err, setErr] = useState('')
      const box = useRef(null)
      const input = useRef(null)
      const remember = (u) => { try { sessionStorage.setItem(store, u) } catch {} }
      const call = (p) => Promise.resolve(p).catch((e) => setErr(e.message))

      useEffect(() => native?.onState((s) => {
        setState(s)
        if (httpUrl(s.url ?? '')) { setUrl(s.url); remember(s.url); if (document.activeElement !== input.current) setText(s.url) }
      }), [native])

      // Keep the native view over the placeholder; hide it while any modal dialog is up (it would cover the dialog).
      useEffect(() => {
        if (!native || !visible) return
        const el = box.current
        let last = ''
        let first = true
        const report = () => {
          const r = el.getBoundingClientRect()
          const modal = !!document.querySelector('[aria-modal="true"]')
          const key = modal ? 'hidden' : `${r.left},${r.top},${r.width},${r.height}`
          if (key === last) return
          last = key
          if (modal) return call(native.hide())
          call(native.show({ x: r.left, y: r.top, width: r.width, height: r.height, ...(first ? { url } : {}) }))
          first = false
        }
        const ro = new ResizeObserver(report)
        ro.observe(el)
        window.addEventListener('resize', report)
        window.addEventListener('scroll', report, true)
        // ponytail: 250 ms poll catches moves without a resize (split panes, sidebar slides, dialogs); an observer per cause if it ever costs.
        const t = setInterval(report, 250)
        report()
        return () => { ro.disconnect(); clearInterval(t); window.removeEventListener('resize', report); window.removeEventListener('scroll', report, true); call(native.hide()) }
      }, [native, visible])

      const go = (raw) => {
        const u = toUrl(raw)
        if (!u) return setErr('Enter an http:// or https:// address.')
        if (!native && new URL(u).origin === location.origin) return setErr('The harness itself cannot open inside its own browser tab.')
        setErr(''); setUrl(u); setText(u); remember(u)
        if (native) call(native.navigate(u))
        else setHist((hs) => ({ list: [...hs.list.slice(0, hs.i + 1), u], i: hs.i + 1 }))
      }
      const step = (d) => {
        if (native) return call(d < 0 ? native.back() : native.forward())
        const i = hist.i + d
        if (i < 0 || i >= hist.list.length) return
        setHist({ ...hist, i }); setUrl(hist.list[i]); setText(hist.list[i]); remember(hist.list[i])
      }
      const loading = !!state?.loading
      const ib = (label, icon, onClick, disabled) => h('button', { type: 'button', className: 'kzh-ib', 'aria-label': label, title: label, disabled, onClick }, icon())
      return h('div', { className: 'jevi kzb' },
        h('form', { className: 'kzb-bar', role: 'toolbar', 'aria-label': 'Browser', onSubmit: (e) => { e.preventDefault(); go(text) } },
          ib('Back', ICON.back, () => step(-1), native ? !state?.canGoBack : hist.i === 0),
          ib('Forward', ICON.forward, () => step(1), native ? !state?.canGoForward : hist.i >= hist.list.length - 1),
          loading ? ib('Stop loading', ICON.stop, () => call(native.stop())) : ib('Reload', ICON.reload, () => (native ? call(native.reload()) : setFrameKey((k) => k + 1))),
          h('input', { ref: input, type: 'text', 'aria-label': 'Address', spellCheck: false, autoComplete: 'off', value: text, onChange: (e) => setText(e.target.value), onFocus: (e) => e.target.select() }),
          ib('Open in your browser', ICON.external, () => (native ? call(native.openExternal()) : window.open(url, '_blank', 'noopener,noreferrer')))),
        err ? h('div', { className: 'err', role: 'alert', style: { margin: '6px 8px' } }, err) : null,
        native ? null : h('div', { className: 'note why' }, 'Many sites refuse to be shown inside another page (X-Frame-Options). If this stays blank, use "Open in your browser". Meant for local dev servers and docs.'),
        h('div', { className: 'view', ref: box },
          native ? null : h('iframe', { key: frameKey, src: url, title: 'Browser', sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups', referrerPolicy: 'no-referrer' })))
    }

    // ---------- session header: launcher buttons and the "more" menu ----------
    const TIP_ID = 'kzh-menu-tip'
    const TIP_W = 250
    /**
     * Where the hint for one menu row goes. The menu hugs the window's right edge, so the hint sits
     * to its left and only flips to the right when that would go off screen. Vertically it is pinned
     * by its top half or its bottom half, never by a guessed height, so the bottom rows cannot push
     * it below the window and it needs no second render to measure itself (no flicker, no reflow).
     */
    function tipStyle(el) {
      const r = el.getBoundingClientRect()
      const left = r.left - TIP_W - 8 >= 8 ? r.left - TIP_W - 8 : Math.min(r.right + 8, window.innerWidth - TIP_W - 8)
      const above = r.top + r.height / 2 < window.innerHeight / 2
      return above ? { left, top: r.top } : { left, bottom: window.innerHeight - r.bottom }
    }

    function MoreMenu({ anchor, items, onClose }) {
      const ref = useRef(null)
      const [hint, setHint] = useState(null) // { id, style } of the row the pointer or the focus is on
      useEffect(() => {
        ref.current?.querySelector('[role=menuitem]')?.focus()
        const outside = (e) => { if (!ref.current?.contains(e.target) && !anchor.current?.contains(e.target)) onClose(false) }
        document.addEventListener('pointerdown', outside, true)
        return () => document.removeEventListener('pointerdown', outside, true)
      }, [])
      const onKeyDown = (e) => {
        const list = [...ref.current.querySelectorAll('[role=menuitem]')]
        const i = list.indexOf(document.activeElement)
        const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key]
        if (to !== undefined) { e.preventDefault(); list[(to + list.length) % list.length]?.focus() }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true) }
        else if (e.key === 'Tab') onClose(false)
      }
      const r = anchor.current?.getBoundingClientRect()
      // Pointer and keyboard both raise the hint. Leaving only clears it when the row that leaves is
      // the one showing, so hovering elsewhere cannot blank the hint of the row that has the focus.
      const show = (it) => (e) => setHint({ id: it.id, style: tipStyle(e.currentTarget) })
      const hide = (it) => () => setHint((k) => (k?.id === it.id ? null : k))
      // The hint is a sibling of the menu, not a child: a role=tooltip inside a role=menu is not a menu item.
      return h(React.Fragment, null,
        h('div', { ref, role: 'menu', 'aria-label': 'More panels and actions', className: 'kzh-menu', onKeyDown,
          style: r ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) } : undefined },
        ...items.map((it, n) => (it === '-' ? h('div', { key: `sep${n}`, role: 'separator' }) : h('button', {
          key: it.id, type: 'button', role: 'menuitem', tabIndex: -1,
          // No title attribute: the browser's own tip would pop up a second later, next to this one.
          'aria-describedby': hint?.id === it.id ? TIP_ID : undefined,
          onClick: () => { onClose(true); runAction(it.id) },
          onMouseEnter: show(it), onMouseLeave: hide(it), onFocus: show(it), onBlur: hide(it),
        }, h('span', { className: 'grow' }, ACT[it.id].label), it.count ? h('span', { className: 'n', 'aria-label': `${it.count} running` }, it.count) : null,
        it.keys ? h('kbd', null, it.keys) : null)))),
        hint ? h('div', { id: TIP_ID, role: 'tooltip', className: 'kzh-tip', style: hint.style }, ACT[hint.id].desc) : null)
    }

    function HeaderActions({ sessionId, useSessions }) {
      useStyle()
      useUiTick()
      const { bindings } = hotkeys.use()
      const [menu, setMenu] = useState(false)
      const more = useRef(null)
      const runs = useRuns(sessionId, true, 5000)
      const jobs = useSessions?.((s) => s.jobsBySession?.[sessionId]) ?? EMPTY
      const entries = useSessions?.((s) => s.subagentsByParent?.[sessionId]?.entries) ?? EMPTY
      const tasks = useTasks(sessionId, true, 5000)
      const running = liveCount({ runs, jobs, entries, tasks })
      // Finished results whose message has not been posted yet: the task settled while an answer
      // was still streaming, so delivery is waiting for it to end. The spec wants this said
      // outside the active message, and never by touching it - this is a count, not an insert.
      const awaiting = awaitingDelivery(tasks)
      const kind = activeKind()
      const all = transcripts.use()
      useEffect(() => { scheduleTranscripts() }, []) // rows may already be on screen when this mounts
      const tip = (id, label = ACT[id].label) => (bindings[id] ? `${label} (${bindings[id]})` : label)
      const btn = (id, extra = {}) => h('button', {
        key: id, type: 'button', className: 'kzh-ib', title: tip(id), 'aria-label': extra.label ?? ACT[id].label,
        'aria-keyshortcuts': bindings[id] ? ariaKeys(bindings[id]) : undefined, 'aria-pressed': extra.pressed, onClick: () => runAction(id),
      }, ICON[id](), extra.dot ? h('span', { className: 'kzh-dot', 'aria-hidden': true }) : null)
      const item = (id, count) => ({ id, keys: bindings[id], count })
      return h('div', { className: 'kzh-bar' },
        // The same news the dot gives, for a screen reader: one polite announcement, in a region
        // that is always present (a live region added together with its text is not announced).
        // It never takes the focus, so an arriving result cannot interrupt what you are typing.
        h('span', { className: 'kzh-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, resultAnnouncement(awaiting)),
        btn('terminal'),
        btn('background', {
          dot: running > 0 || awaiting > 0,
          pressed: kind === TASKS_KIND,
          label: [running ? `Background tasks, ${running} running` : 'Background tasks', resultAnnouncement(awaiting)].filter(Boolean).join(', '),
        }),
        btn('browser', { pressed: kind === BROWSER_KIND }),
        btn('jev-inspector', { pressed: kind === KIND }),
        // Every reasoning and tool transcript of this conversation at once (see the transcript block
        // above). Disabled while the conversation has none, and it never takes the keyboard focus.
        h('button', {
          type: 'button', className: 'kzh-ib', disabled: all.button.disabled,
          title: tip('transcripts', all.button.label), 'aria-label': all.button.label, 'aria-expanded': all.button.expanded,
          'aria-keyshortcuts': bindings.transcripts ? ariaKeys(bindings.transcripts) : undefined,
          onClick: () => runAction('transcripts'),
        }, ICON.reasoning()),
        h('button', {
          ref: more, type: 'button', className: 'kzh-ib', 'aria-label': 'More', title: 'More', 'aria-haspopup': 'menu', 'aria-expanded': menu,
          onClick: () => setMenu((m) => !m),
        }, ICON.more()),
        menu ? h(MoreMenu, {
          anchor: more,
          onClose: (refocus) => { setMenu(false); if (refocus) more.current?.focus() },
          items: [item('files'), item('background', running), item('browser'), item('terminal'), item('jev-inspector'), item('transcripts'), item('subagents'), item('usage'), '-', item('queue'), item('export'), '-',
            item('left-sidebar'), item('right-sidebar'), item('focus-mode'), item('new-session'), item('focus-input'), '-', item('shortcuts'), item('jev-setup')],
        }) : null)
    }

    // Pages without a session header (the new-session start page) get the same launcher as a floating
    // bar at the top right of the main area, plus a right-sidebar toggle: DSH only offers "reopen
    // sidebar" inside a session header, so hiding the sidebar there would otherwise strand it.
    const rightbarWidth = () => document.querySelector('[data-rightbar-col]')?.getBoundingClientRect().width ?? 0
    // The right-sidebar toggle button also shows the panel's hotkey (Ctrl+N by default), so the combo
    // is discoverable from the button itself and not only in Settings -> Shortcuts. The words stay
    // combo free for the accessible name; the combo travels in `title` and `aria-keyshortcuts`, the
    // same shape the header buttons use. Each caller reads the binding through `hotkeys.use()`, so a
    // change on the Shortcuts page re-renders the label at once.
    const rightbarToggleWhat = (expanded) => (expanded ? 'Hide right sidebar' : 'Show right sidebar')
    const rightbarToggleTitle = (what, key) => (key ? `${what} (${key})` : what)
    const headerBarShown = () => [...document.querySelectorAll('.kzh-bar')].some((el) => !el.closest('.kzh-float'))
    function FloatingBar({ useSessions }) {
      useStyle()
      useUiTick()
      const rightbarKey = hotkeys.use().bindings['right-sidebar']
      const [, bump] = useState(0)
      useEffect(() => {
        // Re-check placement when the frame changes (sidebar opened/closed/dragged, session header mounted).
        const mo = new MutationObserver(() => bump((n) => n + 1))
        mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-rightbar-collapsed'] })
        return () => mo.disconnect()
      }, [])
      if (headerBarShown()) return null
      let expanded = false
      try { expanded = !!sidebarRight?.isExpanded() } catch {}
      const what = rightbarToggleWhat(expanded)
      return h('div', { className: 'kzh-float', style: { right: Math.round(rightbarWidth()) + 12 } },
        h(HeaderActions, { sessionId: null, useSessions }),
        h('button', {
          type: 'button', className: 'kzh-ib', 'aria-label': what, title: rightbarToggleTitle(what, rightbarKey),
          'aria-keyshortcuts': rightbarKey ? ariaKeys(rightbarKey) : undefined,
          'aria-pressed': expanded,
          onClick: () => { try { sidebarRight.toggleExpanded() } catch { openPanel(KIND) } },
        }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
          h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }), h('path', { d: 'M10 2.5v11' }))))
    }

    // Inside the Kz-harness app the window has no native title bar: this strip is it. Logo + ☰ menu on
    // the left, every launcher button and the right-sidebar toggle on the right (next to Windows'
    // own min/max/close), on every page, so hiding a sidebar never hides the buttons.
    const IN_APP = !!window.harness?.titlebar
    const TITLE_H = 36
    function TitleBar({ useSessions }) {
      useStyle()
      useUiTick()
      const rightbarKey = hotkeys.use().bindings['right-sidebar']
      const [, bump] = useState(0)
      useEffect(() => {
        const wco = navigator.windowControlsOverlay
        const f = () => bump((n) => n + 1)
        wco?.addEventListener?.('geometrychange', f)
        window.addEventListener('resize', f)
        return () => { wco?.removeEventListener?.('geometrychange', f); window.removeEventListener('resize', f) }
      }, [])
      // Leave room for Windows' caption buttons (the overlay reports where they are).
      const area = navigator.windowControlsOverlay?.getTitlebarAreaRect?.()
      const padRight = area && area.width ? Math.max(8, window.innerWidth - (area.x + area.width) + 8) : 146
      const current = useSessions?.((st) => st.current) ?? null
      let expanded = false
      try { expanded = !!sidebarRight?.isExpanded() } catch {}
      const what = rightbarToggleWhat(expanded)
      const menuBtn = useRef(null)
      return h('div', { className: 'kzh-titlebar', style: { paddingRight: padRight } },
        h('button', {
          ref: menuBtn, type: 'button', className: 'kzh-tb-menu', 'aria-label': 'Kz-harness menu', title: 'Menu',
          onClick: () => { const r = menuBtn.current.getBoundingClientRect(); window.harness.menu({ x: r.left, y: r.bottom }) },
        }, h('img', { src: LOGO, width: 18, height: 18, alt: '' }), h('span', null, 'Kz-harness')),
        h('div', { className: 'kzh-tb-drag' }),
        h(HeaderActions, { sessionId: typeof current === 'string' ? current : null, useSessions }),
        h('button', {
          type: 'button', className: 'kzh-ib', 'aria-label': what, title: rightbarToggleTitle(what, rightbarKey),
          'aria-keyshortcuts': rightbarKey ? ariaKeys(rightbarKey) : undefined,
          'aria-pressed': expanded,
          onClick: () => { try { sidebarRight.toggleExpanded() } catch { openPanel(KIND) } },
        }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
          h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }), h('path', { d: 'M10 2.5v11' }))))
    }

    function Toast() {
      const { text, n } = toasts.use()
      const [shown, setShown] = useState(false)
      useEffect(() => {
        if (!n) return
        setShown(true)
        const t = setTimeout(() => setShown(false), 4000)
        return () => clearTimeout(t)
      }, [n])
      return shown ? h('div', { className: 'kzh-toast', role: 'status' }, text) : null
    }

    // ---------- settings: Shortcuts ----------
    function ShortcutsSection() {
      useStyle()
      const hk = hotkeys.use()
      const [capture, setCapture] = useState(null) // action id being recorded
      const [msg, setMsg] = useState('')
      const [resetAll, setResetAll] = useState(false)
      const [ratio, setRatio] = useState(String(hk.ratio))
      useEffect(() => { setRatio(String(hk.ratio)) }, [hk.ratio])
      const save = async (patch) => {
        const prev = hotkeys.get()
        const next = { ...prev, ...patch }
        hotkeys.set(next)
        setMsg('Saving…')
        try { await saveHotkeys(next); setMsg('Saved') } catch (e) { hotkeys.set(prev); setMsg(e.message) }
      }
      const bind = (id, combo) => save({ bindings: { ...hotkeys.get().bindings, [id]: combo } })

      // Record the next combo: Esc cancels, Backspace clears. Capture phase, so DSH's own Esc handlers stay out of it.
      useEffect(() => {
        if (!capture) return
        capturing = true
        const onKey = (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') return setCapture(null)
          if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { bind(capture, ''); return setCapture(null) }
          const combo = comboOf(e)
          // A bare key or Shift+key would fire while moving around the page; only F-keys may go without Ctrl/Alt/Win.
          if (!combo || !(e.ctrlKey || e.altKey || e.metaKey || /^F\d/.test(combo.split('+').at(-1)))) return
          bind(capture, combo)
          setCapture(null)
        }
        window.addEventListener('keydown', onKey, true)
        return () => { capturing = false; window.removeEventListener('keydown', onKey, true) }
      }, [capture])

      const saveRatio = () => {
        const n = Number(ratio)
        if (!Number.isInteger(n) || n < 15 || n > 50) return setMsg('Right sidebar width: a whole number from 15 to 50')
        if (n === hk.ratio) return
        save({ ratio: n }).then(() => sizeRightbar(true))
      }

      return h('div', { className: 'jevi', style: { height: 'auto' } },
        h('h3', null, 'Shortcuts'),
        h('p', { className: 'muted' }, 'Keys for the header buttons and panels. They work anywhere in the harness, also while typing when they use Ctrl, Alt or Win.'),
        msg ? h('div', { className: cx('saved', msg !== 'Saved' && msg !== 'Saving…' && 'bad'), role: 'status' }, msg) : null,
        h('div', { className: 'card', style: { marginTop: 10 } },
          h('div', { className: 'head' }, h('div', { className: 'label', style: { margin: 0 } }, 'Actions'),
            h('button', { className: 'btn danger', onClick: () => setResetAll(true) }, 'Reset all to defaults')),
          h('ul', { className: 'plain', 'aria-label': 'Shortcuts' }, ...ACTIONS.map((a) => {
            const combo = hk.bindings[a.id] ?? ''
            const clash = conflictsOf(a.id, combo)
            const rec = capture === a.id
            const lid = `kzh-sc-${a.id}`
            return h('li', { key: a.id },
              h('div', { style: { minWidth: 0 } },
                h('div', { id: lid }, a.label),
                clash.length ? h('div', { className: 'warnline', id: `${lid}-w` }, `Also used by: ${clash.join('; ')}`) : null),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 } },
                rec ? h('kbd', { className: 'capture', 'aria-live': 'assertive' }, 'Press Ctrl/Alt/Win + key… Esc cancels, Backspace clears')
                  : h('kbd', { className: combo ? '' : 'none' }, combo || 'Not set'),
                h('button', { className: 'btn', 'aria-labelledby': `${lid}-c ${lid}`, id: `${lid}-c`, 'aria-describedby': clash.length ? `${lid}-w` : undefined, onClick: () => setCapture(rec ? null : a.id) }, rec ? 'Cancel' : 'Change'),
                h('button', { className: 'btn', 'aria-labelledby': `${lid}-r ${lid}`, id: `${lid}-r`, disabled: combo === a.keys, onClick: () => bind(a.id, a.keys) }, 'Reset')))
          }))),
        h('div', { className: 'card' },
          h('div', { className: 'label' }, 'Right sidebar'),
          h('div', { className: 'limits', style: { marginTop: 0 } },
            h('label', { htmlFor: 'kzh-ratio' }, 'Width when it opens (% of the window)',
              h('input', { id: 'kzh-ratio', type: 'number', min: 15, max: 50, step: 1, value: ratio, onChange: (e) => setRatio(e.target.value), onBlur: saveRatio, onKeyDown: (e) => { if (e.key === 'Enter') saveRatio() } }))),
          h('div', { className: 'why', style: { marginTop: 6 } }, 'Dragging the sidebar edge keeps your width until the page reloads.')),
        h('div', { className: 'card' },
          h('div', { className: 'label' }, 'Built in (read-only)'),
          h('ul', { className: 'plain', 'aria-label': 'Built-in shortcuts' }, ...BUILTIN.map(([k, what]) => h('li', { key: k + what }, h('span', null, what), h('kbd', null, k))))),
        resetAll ? h(Confirm, {
          title: 'Reset all shortcuts?',
          body: `All ${ACTIONS.length} shortcuts go back to their defaults and the right sidebar width goes back to ${DEFAULT_RATIO}%. Your own keys are lost.`,
          confirmLabel: 'Reset all',
          onCancel: () => setResetAll(false),
          onConfirm: () => { setResetAll(false); save({ bindings: { ...DEFAULTS }, ratio: DEFAULT_RATIO }).then(() => sizeRightbar(true)) },
        }) : null)
    }

    // ---------- agent strip: who produced each answer, in the message's own action row ----------
    // The chain travels inside the message, as a link reference definition the markdown renderer
    // drops (router.js writes it). The run log is memory only and keeps 20 runs per session, so
    // looking the message up there would credit older answers wrongly, or not at all.
    const STRIP_MARK = /^\[jev-agents\]:\s*kzh-agents-1-([A-Za-z0-9_-]+)\s*$/gm
    const fromBase64Url = (b) => {
      const bytes = Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }

    /** Every chain this message carries, in the order it posted them: one turn can report several finished runs. */
    function chainsOf(text) {
      const out = []
      for (const m of text.matchAll(STRIP_MARK)) {
        try { out.push(JSON.parse(fromBase64Url(m[1]))) } catch {}
      }
      return out
    }

    /** Text of one finalized assistant message. Newest first: the message being read is usually the last. */
    function messageText(nodes, messageId) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (n.kind === 'assistant' && n.messageId === messageId) return n.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n')
      }
      return ''
    }
    // ---------- composer input history: the arrows walk the session's own user messages ----------
    // The composer is a Lexical editor whose draft lives in the session input machine, so the one
    // correct writer is inputActions.setDraft (the InputActions face the conversation package hands
    // every session-scoped slot); setting DOM text would fight the editor. How many past inputs to
    // keep: enough for a long session, small enough that the oldest are rarely missed.
    const HISTORY_MAX = 50

    /** Text of each user message in the transcript, oldest first, capped at the newest HISTORY_MAX. Pure. */
    function userInputs(nodes) {
      const out = []
      for (const n of nodes) {
        if (n?.kind !== 'user') continue
        const text = (n.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        if (text.trim() !== '') out.push(text)
      }
      return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out
    }

    /**
     * One ArrowUp/ArrowDown step over `entries` (oldest first). `index` is the recalled
     * position (null while the person is on their own draft), `draft` the draft captured
     * when the walk began. Returns the next walk state and the text to write, or null when
     * the key changes nothing (no history, oldest entry, or a draft already showing).
     */
    function historyStep(entries, index, draft, dir) {
      const n = entries.length
      if (dir === 'up') {
        if (!n) return null
        if (index === null) return { index: n - 1, draft, text: entries[n - 1] }
        if (index === 0) return null
        return { index: index - 1, draft, text: entries[index - 1] }
      }
      if (dir !== 'down' || index === null) return null
      if (index < n - 1) return { index: index + 1, draft, text: entries[index + 1] }
      return { index: null, draft: null, text: draft ?? '' }
    }

    /**
     * Which history direction an arrow may take: `up` only with the caret on the first line,
     * `down` only on the last. Any selection, or a caret mid-text on a later line, answers
     * null so ordinary multiline editing keeps the key. Pure.
     */
    function arrowIntent(key, before, after, hasSelection) {
      if (hasSelection) return null
      if (key === 'ArrowUp' && !before.includes('\n')) return 'up'
      if (key === 'ArrowDown' && !after.includes('\n')) return 'down'
      return null
    }

    /** Text before and after the caret in the composer, and whether a range is selected. */
    function caretParts(root) {
      const sel = window.getSelection && window.getSelection()
      if (!sel || sel.rangeCount === 0) return null
      const range = sel.getRangeAt(0)
      if (!root.contains(range.startContainer)) return null
      const before = document.createRange()
      before.selectNodeContents(root)
      before.setEnd(range.startContainer, range.startOffset)
      const after = document.createRange()
      after.selectNodeContents(root)
      after.setStart(range.endContainer, range.endOffset)
      return { before: before.toString(), after: after.toString(), hasSelection: !range.collapsed }
    }

    const stepLabel = ({ agent, model, roles }) => {
      const tag = (roles ?? []).filter((r) => r !== 'work').join(', ')
      return `${agent}${model ? ` (${model})` : ''}${tag ? ` [${tag}]` : ''}`
    }

    // Chromium does not arrow-scroll this focused overflow row on its own, and a chain
    // that only a mouse can reach is a chain half the readers cannot read.
    const scrollChain = (e) => {
      const by = { ArrowRight: 80, ArrowLeft: -80 }[e.key]
      if (by === undefined) return
      e.preventDefault()
      e.currentTarget.scrollBy({ left: by })
    }

    /** One scrollable row of chips per finalized message: Jev, then each agent, in run order. */
    function AgentStrip({ messageId, useChat }) {
      useStyle()
      // Selecting the text, not the node, keeps this row out of every unrelated chat change.
      const text = useChat((s) => messageText(s.legacy.nodes, messageId))
      const chains = chainsOf(text)
      if (!chains.length) return null
      return h('div', { className: 'kzh-agents', role: 'group', tabIndex: 0, 'aria-label': 'Agents that produced this answer', onKeyDown: scrollChain },
        ...chains.flatMap((steps, c) => [
          c ? h('span', { key: `s${c}`, className: 'split', 'aria-hidden': true }) : null,
          ...steps.flatMap((step, i) => [
            i ? h('span', { key: `a${c}.${i}`, className: 'arrow', 'aria-hidden': true }, '→') : null,
            // Blue is the one whose words you are reading; every supporting step stays grey.
            // Colour alone would leave that unsaid for a screen reader, so the label says it too.
            h('span', {
              key: `c${c}.${i}`,
              className: cx('chip', step.answered && 'wrote'),
              ...(step.answered ? { 'aria-label': `${stepLabel(step)}, wrote this answer` } : {}),
            }, stepLabel(step)),
          ]),
        ]).filter(Boolean))
    }

    // ---------- like/dislike: the teaching signal under every answer ----------
    // The verdict and the person's own words are what teach Jev which pick was wrong (router.js
    // folds the read-back rows into its priors). This renders in the turn tail, so it appears for
    // direct answers, routed agent runs and background results alike, with or without a credit line.
    const SUGGESTABLE = /^[a-z][a-z0-9_-]{0,40}$/
    const canSuggest = (a) => !!a && typeof a.id === 'string' && SUGGESTABLE.test(a.id) && a.id !== 'auto'

    // The tags offered for each verdict, in display order and in plain words. They are the same
    // strings feedback.js validates, split so only sensible ones are offered: "good pick" never
    // appears under a dislike. "good pick", "wrong agent", "misread my question" and "wrong
    // scope" describe the routing and may move Jev's priors; "good answer", "not enough detail"
    // and "too slow" describe the answer alone and never move a pick.
    const TAGS_FOR = {
      like: ['good pick', 'good answer'],
      dislike: ['wrong agent', 'misread my question', 'wrong scope', 'not enough detail', 'too slow'],
    }
    // Under a start reply the verdict judges the pick the reply named, not an answer (feedback.js
    // PLAN_TAGS): the agent, the effort, the reading of the message and whether it was a task at all.
    // A question answered directly may say it should have been a task instead.
    const PLAN_TAGS_FOR = {
      like: ['good pick'],
      dislike: ['wrong agent', 'wrong effort', 'misread my question', 'wrong scope', 'should have been a question'],
    }
    const TASK_TAG = 'should have been a task'
    /** The tags offered for a verdict about an answer (`mode` 'answer') or the pick (`plan`); a direct answer (`direct`) adds TASK_TAG to a dislike. */
    const tagsFor = (verdict, mode = 'answer', { direct = false } = {}) => (mode === 'plan' ? PLAN_TAGS_FOR[verdict] ?? []
      : verdict === 'dislike' && direct ? [...TAGS_FOR.dislike, TASK_TAG] : TAGS_FOR[verdict] ?? [])
    /** A tag is optional: clicking the selected chip removes it. Pure, so it unit-tests. */
    const toggledTag = (current, clicked) => (current === clicked ? '' : clicked)

    // ---- pure plan verdict helpers: no React, no state. The Like and Dislike under a start reply
    // judge its pick (docs/live-agent-view.md Feature 4): what they offer, what they post, the line
    // that says what a verdict changed, and the one ask under a reply whose plan changed.

    // The example a question answered directly was recorded as (reply-words.js INTENT_MARK).
    const INTENT_MARK = /^\[jev-intent\]:\s*kzh-intent-1-([\w-]{1,80})\s*$/m
    /** What the verdicts under this message judge: the pick of a start reply (its `[jev-job]` mark), or an answer. */
    const verdictMode = (text) => (JOB_MARK.test(String(text ?? '')) ? 'plan' : 'answer')
    /** The task a start reply is about, by its key, '' for a message that names none. */
    const messageJobKey = (text) => JOB_MARK.exec(String(text ?? ''))?.[1] ?? ''
    /** The example a direct answer's message was recorded as, '' for any other message. */
    const messageIntentSample = (text) => INTENT_MARK.exec(String(text ?? ''))?.[1] ?? ''
    /** The efforts the pick should have run at, as the effort select offers them (feedback.js SUGGESTED_EFFORTS). */
    const PLAN_EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]
    /**
     * Which "should have been" selects a verdict shows: under an answer, the agent one with any dislike,
     * as always; under a start reply, the agent one with `wrong agent` or a dislike with no tag, and the
     * effort one only with `wrong effort`.
     */
    const verdictSelects = (mode, verdict, tag) => (verdict !== 'dislike' ? { agent: false, effort: false }
      : mode !== 'plan' ? { agent: true, effort: false }
        : { agent: !tag || tag === 'wrong agent', effort: tag === 'wrong effort' })
    /** A verdict's state with what its selects no longer show dropped, so a leftover choice cannot ride along. */
    const shownOnly = (mode, s) => {
      const show = verdictSelects(mode, s.verdict, s.tag)
      return { ...s, suggestedAgent: show.agent ? s.suggestedAgent ?? '' : '', suggestedEffort: show.effort ? s.suggestedEffort ?? '' : '' }
    }
    /** The line under a saved verdict: the server's own words for what it changed (index.js verdictEffects), '' for none. */
    const learnedLine = (effects) => (Array.isArray(effects) ? effects.filter((x) => typeof x === 'string' && x).join(' ') : '')
    /** How many messages the person has typed since an assistant message. */
    function typedAfter(nodes, messageId) {
      const list = Array.isArray(nodes) ? nodes : []
      let at = -1
      list.forEach((n, i) => { if (n?.kind === 'assistant' && n.messageId === messageId) at = i })
      return at < 0 ? 0 : list.slice(at + 1).filter((n) => n?.kind === 'user').length
    }
    /**
     * The ask under a start reply whose plan changed, or null: only when what ran is another agent than
     * the reply named (`row`, GET /jev-router/replies?key=), nothing was rated, it was never answered,
     * asking is on (`askWhenWrong`), fewer than two messages have been typed since, and no other reply
     * of the chat holds the chat's one ask (`holder`, the message that does, or null). Its choices are
     * the agent the reply named (`said`), the one that ran (`ran`), and `either`.
     */
    function askFor({ row, rated = false, typedSince = 0, messageId, holder = null, names = {} }) {
      const said = row?.said?.agent
      const ran = row?.ran?.agent
      if (!said || !ran || said === ran || rated || row.verdict || row.ask || row.askWhenWrong === false || typedSince >= 2) return null
      if (holder && holder !== messageId) return null
      const name = (id) => (String(id).startsWith('tool:') ? `the ${String(id).slice('tool:'.length)} tool` : names[id] ?? id)
      return { text: `It ran on ${name(ran)}, not ${name(said)} as I said. Which was right?`, choices: [['said', name(said)], ['ran', name(ran)], ['either', 'Doesn\'t matter']], said, ran }
    }
    /** Take the chat's one ask for this reply: the holders with it, unchanged when another reply holds it. */
    const claimAsk = (holders, sessionId, messageId) => (holders?.[sessionId] && holders[sessionId] !== messageId ? holders : { ...holders, [sessionId]: messageId })
    /** Let the chat's ask go, when this reply holds it. */
    const releaseAsk = (holders, sessionId, messageId) => {
      if (holders?.[sessionId] !== messageId) return holders
      const { [sessionId]: _gone, ...rest } = holders
      return rest
    }
    /**
     * The verdict an answer to the ask posts: the agent that ran was right (`good pick`), or the one the
     * reply named should have had it. A tool is no agent a verdict can name (feedback.js takes an agent
     * or provider id), so a tool on either side is left out, and the verdict still says the pick was
     * right or wrong.
     */
    const agentOf = (id) => (String(id ?? '').startsWith('tool:') ? '' : id)
    const askVerdict = (answer, ask) => (answer === 'ran' ? { verdict: 'like', tag: 'good pick', suggestedAgent: '', provider: agentOf(ask.ran) }
      : answer === 'said' ? { verdict: 'dislike', tag: 'wrong agent', suggestedAgent: agentOf(ask.said), provider: agentOf(ask.ran) } : null)

    // ---- end pure plan verdict helpers

    /** A chain writes "model, effort"; the feedback route wants the model id alone. */
    const modelId = (s) => String(s ?? '').split(',')[0].trim()

    /**
     * provider/model as the message itself reports them. A routed answer carries the chain marker,
     * so the answering step names the agent and its model. A direct answer carries the credit line,
     * whose `provider/model` pair (in backticks when the pretty name differs from the pair) names
     * both. Null when the message reports neither, which is the honest answer for a bare result
     * card, and leaves both fields out of the POST rather than guessing them.
     */
    function messageProvenance(text) {
      const t = String(text ?? '')
      const chains = chainsOf(t)
      if (chains.length) {
        const steps = chains[chains.length - 1] ?? []
        const step = steps.findLast((s) => s && s.answered) ?? steps[steps.length - 1]
        if (step && (step.agent || step.model)) return { agent: step.agent ?? '', model: modelId(step.model), provider: '' }
      }
      // "Answered by: DeepSeek Flash (`deepseek/deepseek-flash`), directly" or "Answered by: local/gemma-e4b, directly".
      const m = /Answered by:[^\n]*?(?:\(`([^`]+)`\)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+-]+))/.exec(t)
      const pair = m && (m[1] || m[2])
      if (pair) {
        const cut = pair.indexOf('/')
        if (cut > 0 && cut < pair.length - 1) return { agent: '', model: pair.slice(cut + 1), provider: pair.slice(0, cut) }
      }
      return null
    }

    // The run an answer came from, as route() wrote it (index.js withRunMark): a link reference
    // definition the markdown renderer drops, like the chain marker. It is the one exact link from
    // a message to its run; without it the server can only guess the run by time, and a verdict on
    // an older answer given after a newer run ended would be credited to the newer run.
    const RUN_MARK = /^\[jev-run\]:\s*kzh-run-1-([\w-]{1,80})\s*$/gm

    /** The run id the message names, '' when none. A turn that reports several runs is judged on the last, as its provenance is. */
    function messageRunId(text) {
      let id = ''
      for (const m of String(text ?? '').matchAll(RUN_MARK)) id = m[1]
      return id
    }

    /**
     * The attribution a verdict stores. A routed answer's chain marker names only its agent, and
     * that agent id is exactly what router.js resolves a verdict to first (feedbackPrior checks the
     * agent id before any provider), so it is sent as `provider`. That makes the verdict
     * attributable from the answer's own text at the moment it is clicked, with no wait on the
     * enabled-agent list the suggestion menu loads: a click made in the first moments after an
     * answer still moves a prior, instead of storing an empty provider that every prior drops. A
     * direct answer has no chain chip and keeps naming its own provider from the credit line. Null
     * provenance (a bare result card) attributes to nothing rather than guessing, as before.
     */
    const verdictProvider = (prov) => prov?.agent || prov?.provider || ''

    /** The stored verdict for one message. The server already keeps one row per message, newest last. */
    function storedVerdict(rows, messageId) {
      let found = null
      for (const r of rows ?? []) if (r && r.messageId === messageId) found = r
      return found
    }

    /** Clicking the active verdict clears it; otherwise the clicked one wins. Pure, so it unit-tests. */
    const toggledVerdict = (current, clicked) => (current === clicked ? null : clicked)

    // The wire value for a cleared verdict. The store keeps it as a tombstone row, so a clear is
    // an append like any other verdict and never rewrites the file.
    const CLEAR = 'clear'

    /**
     * The POST body, with every empty optional left out rather than sent as "". A null verdict is
     * the clear: it goes on the wire as `clear` so the route stores the tombstone, and a clear
     * carries no tag, because there is no verdict left for a tag to describe.
     */
    const feedbackBody = (f) => ({
      sessionId: f.sessionId,
      messageId: f.messageId,
      verdict: f.verdict ?? CLEAR,
      reason: f.reason ?? '',
      ...(f.tag ? { tag: f.tag } : {}),
      ...(f.suggestedAgent ? { suggestedAgent: f.suggestedAgent } : {}),
      ...(f.provider ? { provider: f.provider } : {}),
      ...(f.model ? { model: f.model } : {}),
      // Sent with every verdict and every edit of one, like the attribution; a clear needs no run.
      ...(f.verdict && f.runId ? { runId: f.runId } : {}),
      // A verdict about the pick says so and names its task, and may name the effort it should have
      // run at; one about an answer leaves all three off, as it always has, and names the example a
      // direct answer's message was recorded as.
      ...(f.verdict && f.about === 'plan' && f.taskKey ? { about: 'plan', taskKey: f.taskKey } : {}),
      ...(f.verdict && f.about === 'plan' && f.taskKey && f.suggestedEffort ? { suggestedEffort: f.suggestedEffort } : {}),
      ...(f.verdict && f.intentSample ? { intentSample: f.intentSample } : {}),
    })

    // The "should have been" picker is the same enabled-agent list the setup page and the model
    // menu read, from the server, never a list baked in here. Fetched once per page and cached.
    let enabledAgentsCache = null
    let enabledAgentsPending = null
    const loadEnabledAgents = () => {
      if (enabledAgentsCache) return Promise.resolve(enabledAgentsCache)
      if (!enabledAgentsPending) {
        enabledAgentsPending = api('/jev-router/setup')
          .then((d) => {
            enabledAgentsCache = (d.agents ?? []).filter((a) => a.enabled).map((a) => ({ id: a.id, provider: a.provider }))
            return enabledAgentsCache
          })
          .catch(() => { enabledAgentsPending = null; return [] })
      }
      return enabledAgentsPending
    }

    // The chat's one ask under a start reply whose plan changed: the message that holds it, by chat,
    // and whether asking is on as this page last saved it (`Don't ask me this`, or the switch in
    // Settings, Chat replies), which a reply's row read before the save does not know; null until then.
    const askHolders = makeStore({ holders: {}, asking: null })

    /**
     * Like/Dislike with an optional one-line reason, under every assistant answer. The seat gives
     * `messageId` plus the standard `sessionId` and `useChat`; with no way to name the message there
     * is nothing to attach a verdict to, so it renders nothing. Under a start reply (its `[jev-job]`
     * mark) the verdict rates the pick the reply named (docs/live-agent-view.md Feature 4): its tags are
     * about the agent, the effort and the reading of the message, a dislike may name the effort it
     * should have run at, and a reply whose plan changed may ask, once, which was right. Once a verdict
     * is saved, one muted line gives the server's own words for what it changed.
     */
    function AnswerVerdict({ messageId, sessionId, useChat }) {
      useStyle()
      const nameMap = names.use()
      // The message text carries both provenance shapes: the chain marker and the direct credit line.
      const text = useChat ? useChat((s) => messageText(s.legacy.nodes, messageId)) : ''
      const typedSince = useChat ? useChat((s) => typedAfter(s.legacy.nodes, messageId)) : 0
      const mode = verdictMode(text)
      const plan = mode === 'plan'
      const taskKey = plan ? messageJobKey(text) : ''
      const intentSample = plan ? '' : messageIntentSample(text)
      // `provider` is set only by an answer to the ask, which is about the agent that ran.
      const [state, setState] = useState({ verdict: null, reason: '', tag: '', suggestedAgent: '', suggestedEffort: '', provider: '' })
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [agents, setAgents] = useState(null)
      const [learned, setLearned] = useState('')
      // The reply's row in the reply ledger: what it named and what then ran, for the ask.
      const [row, setRow] = useState(null)
      const [confirm, setConfirm] = useState(false)
      // A click made before the stored verdict lands wins: the person's action is newer than the read.
      const touched = useRef(false)
      const prov = messageProvenance(text) ?? { agent: '', model: '', provider: '' }
      const asks = askHolders.use()
      // The task, read while its reply says it should have been a question, so it can be stopped.
      const { tasks } = useTasksFeed(plan && state.tag === 'should have been a question')

      useEffect(() => { loadNames() }, [])
      // Enabled agents, once: the "should have been" suggestion list. Attribution does not wait on
      // this, because a routed answer's chain chip names its agent directly (see verdictProvider).
      useEffect(() => {
        let stop = false
        loadEnabledAgents().then((list) => { if (!stop) setAgents(list) })
        return () => { stop = true }
      }, [])
      // The verdict already given, so a reload shows it as pressed.
      useEffect(() => {
        if (!sessionId || !messageId) return
        let stop = false
        api(`/jev-router/feedback?session=${encodeURIComponent(sessionId)}`)
          .then((d) => {
            if (stop || touched.current) return
            const r = storedVerdict(d.feedback, messageId)
            // A rating of the pick keeps the agent it was given about, which the ask may have named.
            if (r) setState({ verdict: r.verdict, reason: r.reason ?? '', tag: r.tag ?? '', suggestedAgent: r.suggestedAgent ?? '', suggestedEffort: r.suggestedEffort ?? '', provider: r.about === 'plan' ? r.provider ?? '' : '' })
          })
          .catch(() => {})
        return () => { stop = true }
      }, [sessionId, messageId])
      // The row is read again while what the ask needs can still land. A reply that names its guess
      // (a quick or instant reply, a likely agent) goes out before routing picks, so what ran comes
      // later, or never if its task ends first. What the reply named is noted just after it is out, so
      // a read may find no row yet, or one without it: such misses are read again three times running,
      // then given up, as a row that never comes (the reply ledger off, or a reply of another chat).
      useEffect(() => {
        if (!taskKey || !sessionId) return
        let stop = false
        let timer
        let misses = 0
        const read = async () => {
          let again = true
          if (!document.hidden) {
            try {
              const d = await api(`/jev-router/replies?key=${encodeURIComponent(taskKey)}&session=${encodeURIComponent(sessionId)}`)
              if (stop) return
              setRow(d)
              // What the reply named and what ran are each noted once, so a row with both is final, as
              // is one whose reply named no agent, which has nothing to ask about.
              misses = d.said ? 0 : misses + 1
              again = d.said ? !!d.said.agent && !d.ran && !d.ended : misses < 4
            } catch { again = ++misses < 4 }
          }
          if (!stop && again) timer = setTimeout(read, 3000)
        }
        read()
        return () => { stop = true; clearTimeout(timer) }
      }, [taskKey, sessionId])
      // Asking as this page last saved it, where it did, over the setting the row was read with.
      const seen = row && asks.asking !== null ? { ...row, askWhenWrong: asks.asking } : row
      const ask = plan ? askFor({ row: seen, rated: !!state.verdict, typedSince, messageId, holder: asks.holders[sessionId] ?? null, names: nameMap.agents ?? {} }) : null
      // The chat's one ask: taken while this reply's is due, let go once it is not.
      useEffect(() => {
        if (!ask || !sessionId) return undefined
        askHolders.set({ holders: claimAsk(askHolders.get().holders, sessionId, messageId) })
        return () => askHolders.set({ holders: releaseAsk(askHolders.get().holders, sessionId, messageId) })
      }, [!!ask, sessionId, messageId])

      if (!messageId || !sessionId) return null
      const provider = verdictProvider(prov)

      /** Optimistic: show the new verdict, then POST; a failure puts the old one back and says so. Answers whether it was saved. */
      const commit = async (next) => {
        const prev = state
        touched.current = true
        setEditing(false)
        setState(next)
        try {
          const res = await post('/jev-router/feedback', feedbackBody({
            sessionId, messageId, verdict: next.verdict, reason: next.reason, tag: next.tag,
            suggestedAgent: next.suggestedAgent, provider: next.provider || provider, model: next.provider && next.provider !== provider ? '' : prov.model, runId: messageRunId(text),
            about: mode, taskKey, suggestedEffort: next.suggestedEffort, intentSample,
          }))
          // Under an answer the line is shown only when something was learned from the verdict.
          const line = learnedLine(res?.effects)
          setLearned(plan || line.startsWith('Learned:') ? line : '')
          return true
        } catch (e) {
          setState(prev)
          toast(`Feedback not saved: ${e.message}`)
          return false
        }
      }
      const pick = (v) => {
        const next = toggledVerdict(state.verdict, v)
        if (!next) return commit({ verdict: null, reason: '', tag: '', suggestedAgent: '', suggestedEffort: '', provider: '' })
        // A tag the new verdict does not offer is dropped, so a leftover chip cannot ride along.
        const tag = tagsFor(next, mode, { direct: !!intentSample }).includes(state.tag) ? state.tag : ''
        return commit(shownOnly(mode, { ...state, verdict: next, tag }))
      }
      const saveReason = () => {
        if (!state.verdict) return
        setEditing(false)
        if (draft.trim() === state.reason) return
        commit({ ...state, reason: draft })
      }
      const editReason = () => { setDraft(state.reason); setEditing(true) }
      const setSuggested = (id) => commit({ ...state, suggestedAgent: id })
      const setEffort = (level) => commit({ ...state, suggestedEffort: level })
      const setTag = (tag) => commit(shownOnly(mode, { ...state, tag: toggledTag(state.tag, tag) }))
      // The ask's answer: a verdict about the agent that ran, unless either was right, and the answer
      // kept on the reply's row, so it is never asked again. A verdict that was not saved leaves the
      // ask open, to be answered again.
      const answerAsk = async (answer) => {
        const said = askVerdict(answer, ask)
        if (said && !(await commit({ ...state, ...said, suggestedEffort: '' }))) return
        try { const d = await post('/jev-router/replies/ask', { key: taskKey, answer, sessionId }); setRow((r) => ({ ...r, ask: d.ask })) } catch (e) { toast(`Answer not saved: ${e.message}`) }
      }
      const stopAsking = async () => {
        try { await post('/jev-router/chat-replies/settings', { askWhenWrong: false }); askHolders.set({ asking: false }) } catch (e) { toast(`Not saved: ${e.message}`) }
      }
      const show = verdictSelects(mode, state.verdict, state.tag)
      const t = plan && taskKey ? (tasks ?? []).find((x) => x.key === taskKey) ?? null : null
      const stopping = plan && state.tag === 'should have been a question' && !!t && LIVE_TASK.includes(t.state) ? taskRowModel(t) : null
      const words = confirm && t ? confirmFor(tasks, t.jobId, Date.now(), stopping?.stopWord) : null
      const asking = !!ask && asks.holders[sessionId] === messageId

      return h('div', { className: 'kzh-vd', role: 'group', 'aria-label': plan ? 'Rate this pick' : 'Rate this answer' },
        h('button', {
          type: 'button', className: cx('kzh-vd-btn', state.verdict === 'like' && 'on'),
          'aria-pressed': state.verdict === 'like',
          title: state.verdict === 'like' ? 'Liked. Click to clear.' : plan ? 'The right agent and effort' : 'This answer was right',
          onClick: () => pick('like'),
        }, state.verdict === 'like' ? 'Liked' : 'Like'),
        h('button', {
          type: 'button', className: cx('kzh-vd-btn', state.verdict === 'dislike' && 'on'),
          'aria-pressed': state.verdict === 'dislike',
          title: state.verdict === 'dislike' ? 'Disliked. Click to clear.' : plan ? 'The pick was wrong' : 'This answer was wrong',
          onClick: () => pick('dislike'),
        }, state.verdict === 'dislike' ? 'Disliked' : 'Dislike'),
        // The optional tag, one chip per category, offered after the verdict so the person can say
        // WHAT was wrong rather than only that something was. Selected state is aria-pressed, never
        // colour alone, and every chip is a real button so it is keyboard operable.
        state.verdict ? h('div', {
          className: 'kzh-vd-tags', role: 'group',
          'aria-label': state.verdict === 'dislike' ? 'What was wrong (optional)' : 'What was good (optional)',
        }, ...tagsFor(state.verdict, mode, { direct: !!intentSample }).map((tg) => h('button', {
          key: tg, type: 'button', className: 'kzh-vd-tag',
          'aria-pressed': state.tag === tg,
          title: state.tag === tg ? `${tg}. Click to remove this tag.` : `Tag this verdict: ${tg}`,
          onClick: () => setTag(tg),
        }, tg))) : null,
        state.verdict ? (editing
          ? h('input', {
              className: 'kzh-vd-reason', type: 'text', value: draft, autoFocus: true,
              placeholder: plan ? 'What was not accurate?' : 'Why?', 'aria-label': 'Why: the reason for this verdict',
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveReason() }
                else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
              },
            })
          : h('button', {
              type: 'button', className: 'kzh-vd-why',
              title: state.reason || 'Add a one-line reason',
              'aria-label': state.reason ? `Why: ${state.reason}. Activate to edit.` : 'Add a reason',
              onClick: editReason,
            }, state.reason ? 'Why? (saved)' : 'Why?')) : null,
        show.agent ? h('label', { className: 'kzh-vd-sug' },
          h('span', { className: 'kzh-vd-suglab' }, 'should have been'),
          h('select', {
            className: 'kzh-vd-select', value: state.suggestedAgent,
            'aria-label': plan ? 'should have been: the agent that should have run it' : 'should have been: the agent that should have answered',
            onChange: (e) => setSuggested(e.target.value),
          }, h('option', { value: '' }, 'no suggestion'),
            ...(agents ?? []).filter(canSuggest).map((a) => h('option', { key: a.id, value: a.id }, nameMap.agents?.[a.id] ?? a.id)))) : null,
        show.effort ? h('label', { className: 'kzh-vd-sug' },
          h('span', { className: 'kzh-vd-suglab' }, 'effort should have been'),
          h('select', {
            className: 'kzh-vd-select', value: state.suggestedEffort,
            'aria-label': 'effort should have been: the effort it should have run at',
            onChange: (e) => setEffort(e.target.value),
          }, h('option', { value: '' }, 'no suggestion'), ...PLAN_EFFORTS.map(([v, n]) => h('option', { key: v, value: v }, n)))) : null,
        // Said to have been a question while it still runs: it can be stopped from here.
        stopping ? h('button', { type: 'button', className: 'kzh-vd-why', onClick: () => setConfirm(true) }, `${stopping.stopWord} ${t.jobId}`) : null,
        words ? h(Confirm, {
          title: words.title, body: words.body, confirmLabel: words.confirmLabel,
          onCancel: () => setConfirm(false),
          onConfirm: () => { setConfirm(false); Promise.resolve().then(words.run).catch((e) => toast(e.message)) },
        }) : null,
        learned ? h('div', { className: 'kzh-vd-learned', role: 'status' }, learned) : null,
        asking ? h('div', { className: 'kzh-vd-ask', role: 'group', 'aria-label': ask.text },
          h('span', null, ask.text),
          ...ask.choices.map(([answer, label]) => h('button', { key: answer, type: 'button', className: 'kzh-vd-tag', onClick: () => answerAsk(answer) }, label)),
          h('button', { type: 'button', className: 'kzh-vd-why', title: 'Never ask which was right when a plan changes (Settings, Chat replies)', onClick: stopAsking }, 'Don\'t ask me this')) : null)
    }

    /**
     * Invisible session resident that gives the composer shell-style ArrowUp/ArrowDown history.
     * It draws nothing: it only registers one window keydown listener, the same way this plugin's
     * other global listeners do, and removes it on teardown.
     */
    function ComposerHistory({ useChat, useInput, inputActions }) {
      const nodes = useChat((s) => s.legacy.nodes)
      const draft = useInput((s) => s.draft)
      const entries = userInputs(nodes)
      // The walk lives in refs: recalling an entry re-renders the composer, not this listener.
      const walk = useRef({ index: null, draft: null })
      const shown = useRef(null)
      const entriesRef = useRef(entries)
      const draftRef = useRef(draft)
      useEffect(() => { entriesRef.current = entries }, [entries])
      useEffect(() => { draftRef.current = draft }, [draft])
      // A draft the person typed ends the walk, so the next ArrowUp starts at the newest entry again.
      useEffect(() => { if (draft !== shown.current) walk.current = { index: null, draft: null } }, [draft])
      useEffect(() => {
        if (!inputActions) return
        const onKey = (e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
          const root = e.target && e.target.closest ? e.target.closest('[data-composer-input]') : null
          if (!root) return
          const caret = caretParts(root)
          if (!caret) return
          const dir = arrowIntent(e.key, caret.before, caret.after, caret.hasSelection)
          if (!dir) return
          // Entering the walk captures whatever was being typed; while inside it, that saved draft stays.
          const saved = walk.current.index === null ? draftRef.current : walk.current.draft
          const next = historyStep(entriesRef.current, walk.current.index, saved, dir)
          if (!next) return
          e.preventDefault()
          walk.current = { index: next.index, draft: next.draft }
          shown.current = next.text
          inputActions.setDraft(next.text)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [inputActions])
      return null
    }

    // ---------- brand: Kz-harness logo in the sidebar and above the new-session headline ----------
    const LOGO = '/jev-router/logo.png'
    const BrandMark = ({ size = 24 }) => h('img', { src: LOGO, width: size, height: size, alt: '', style: { display: 'block', borderRadius: 6 } })
    const BrandName = () => h('span', { style: { font: 'var(--dsw-font-s-strong-14)', color: 'var(--dsw-alias-label-primary)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' } }, 'Kz-harness')
    const HeroMark = ({ size = 40, className }) => h('img', { src: LOGO, width: size, height: size, alt: 'Kz-harness', className, style: { display: 'block' } })

    return {
      inject: ['slots', 'sidebarRightTabs', 'sessions', 'sidebarRight', 'layout'],
      // The task-row decisions are pure, so the DOM-less unit tests read them from here
      // (test/transcripts.test.js and test/tasklist.test.js): client.js is a classic script and
      // cannot be imported by node. `taskLabels` is the copy the anti-drift test compares with
      // adapter.js TASK_LABELS on the server. The two start* schedulers are exposed with stubbable
      // DOM globals so a test can prove a pass lands on a timer while no frame is ever delivered.
      // ResourceBudget and LocalModelsCard are rendered with stand-in Reacts in test/budgetpanel.test.js,
      // SetupSection, ChatRepliesCard and HowJevRepliesCard in test/laya-card.test.js and InspectorBody in test/routerview.test.js.
      // The live view's pane, card and helpers are in test/liveview.test.js. Send now and Steer's helpers are
      // in test/workboard.test.js and test/tasklist.test.js, their dialogs and TaskQueue in test/observability.test.js.
      __test: { Markdown, ResourceBudget, LocalModelsCard, InstallPicker, transcriptButton, transcriptClicks, actions: ACTIONS, taskRowModel, taskLabels, liveTasks, liveSummary, workBoardHeader, stopOneWords, stopAllWords, stopTask, WorkBoard, Tasks, resultIdOf, resultOf, awaitingDelivery, resultAnnouncement, toggleActionOf, coalesce, startTranscripts, startResultAcks, userInputs, historyStep, arrowIntent, fileTreeRows: treeRows, orderTreeEntries, treeChildPath, fileAddressFor, treeFailureLine, fileTreeSearchLabels: FILE_TREE_SEARCH_LABELS, messageProvenance, messageRunId, verdictProvider, storedVerdict, toggledVerdict, feedbackBody, canSuggest, modelId, tagsFor, toggledTag, verdictMode, messageJobKey, messageIntentSample, planEfforts: PLAN_EFFORTS, verdictSelects, shownOnly, learnedLine, typedAfter, askFor, claimAsk, releaseAsk, askVerdict, AnswerVerdict, overviewGroups: OVERVIEW_GROUPS, overviewText, conversationLedger, turnWindows, bucketFor, pairRuns, runLedgerRows, taskLedgerRows, jobLedgerRows, subagentLedgerRows, buildLedger, recordState, recordDurationMs, maturityWords, summarize, Stats, WhatHappened, RoutingDecision, Questions, Decisions, HistoryRunDetail, RouterView, sortRows, filterRows, SortTable, BenchmarkCard, benchmarkProgress, LayaCompare, LayaCard, SetupSection, InspectorBody, SavingsCard, UsageCard, RestartLine, taskItems, ratedEffortLines, EffortCard, replyWaitChoices, progressChoices: PROGRESS_CHOICES, ChatRepliesCard, howJevRepliesWhy, howJevRepliesLines, recentReplyRows, ratingChanges, HowJevRepliesCard, livePatchLines, thinkingChoices: THINKING_CHOICES, transcriptChoices: TRANSCRIPT_CHOICES, LiveAgentViewCard, LivePane, LiveRunCard, mergeLive, activityLine, doneLine, stallWords, reasoningPreview, attemptTitle, cleanTerminal, liveHeader, liveNotes, liveEndLine, liveTail, tokenWords, spanWords, queueActions, queueLabel, sendNowWords, stopForWords, steerDialogWords, sendNowRunningWords, restartWords, queueDrift, TaskQueue, guidanceRows, composerWords, GuidanceList, LiveComposer },
      apply(ctx) {
        sessionsApi = ctx.sessions
        sidebarRight = ctx.sidebarRight
        layout = ctx.layout
        uiWorkspace = ctx.get('uiWorkspace') // optional: New session falls back to DSH's own button
        loadHotkeys()
        // Transcript rows stream in shut: a pass follows them while the preference is on (see above).
        ctx.effect(() => startTranscripts())
        ctx.effect(() => startResultAcks())
        // Shipped sidebar toggles: the combo is written onto the button itself, not only shown in
        // Settings (see decorateSidebarToggles).
        ctx.effect(() => startToggleHints())
        // Left sidebar file tree: the toggle and its panel live in injected DOM, and the listing is
        // the same RPC the shipped Files tab uses. The Remote namespace is optional, so its absence
        // only leaves this feature off, never the whole plugin (see the file tree section).
        ctx.inject(['remote', 'remote.workspaceFiles'], (c) => {
          workspaceFiles = c.get('remote.workspaceFiles') ?? c.remote?.workspaceFiles ?? null
          c.effect(() => () => { workspaceFiles = null })
          c.effect(() => startFileTree())
        })
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-file-tree' }, FileTreeSeat))
        ctx.effect(() => {
          window.addEventListener('keydown', onHotkey, true)
          const onResize = () => sizeRightbar()
          window.addEventListener('resize', onResize)
          // DSH marks its frame data-dragging while an edge is dragged: from then on the person's width wins.
          const mo = new MutationObserver(() => { if (document.querySelector('[data-dragging]')) userSized = true })
          mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-dragging'] })
          sizeRightbar()
          return () => { window.removeEventListener('keydown', onHotkey, true); window.removeEventListener('resize', onResize); mo.disconnect() }
        })
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: BROWSER_ID,
          kind: BROWSER_KIND,
          priority: 'extension',
          title: () => 'Browser',
          guide: [{ order: 60, title: () => 'Browser', description: () => 'Local dev servers and docs' }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: BROWSER_ID }, BrowserBody))
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TERMINAL_ID,
          kind: TERMINAL_KIND,
          priority: 'extension',
          title: () => 'Terminal',
          guide: [{ order: 55, title: () => 'Terminal', description: () => "Open a terminal in this session's project folder" }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TERMINAL_ID }, TerminalBody))
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TASKS_ID,
          kind: TASKS_KIND,
          priority: 'extension',
          title: () => 'Tasks',
          guide: [{ order: 52, title: () => 'Background tasks', description: () => 'Queued, running and finished work in this session' }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TASKS_ID }, TasksPane))
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: SUBAGENTS_ID,
          kind: SUBAGENTS_KIND,
          priority: 'extension',
          title: () => 'Subagents',
          guide: [{ order: 53, title: () => 'Subagents', description: () => 'Child sessions this session started' }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SUBAGENTS_ID }, SubagentsPane))
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: USAGE_ID,
          kind: USAGE_KIND,
          priority: 'extension',
          title: () => 'Usage',
          guide: [{ order: 54, title: () => 'Usage', description: () => 'Limits, balances and what Jev saved' }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: USAGE_ID }, UsagePane))
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: OVERVIEW_ID,
          kind: OVERVIEW_KIND,
          priority: 'extension',
          title: () => 'Overview',
          guide: [{ order: 49, title: () => 'Session overview', description: () => 'Every step in this session: messages, routed runs, background tasks, subagents' }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: OVERVIEW_ID }, OverviewPane))
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: LIVE_ID,
          kind: LIVE_KIND,
          priority: 'extension',
          title: () => 'Live',
          guide: [{ order: 51, title: () => 'Live', description: () => 'Watch agents work: text, tool calls and reasoning as they stream' }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: LIVE_ID }, LivePane))
        if (IN_APP) {
          document.documentElement.classList.add('kzh-in-app')
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-titlebar' }, TitleBar))
        } else {
          ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'kz-launcher', order: 100 }, HeaderActions))
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'kz-shortcuts', order: 16, label: () => 'Shortcuts' }, ShortcutsSection))
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'jev-agents', order: 100 }, AgentStrip))
        // The card under a start reply, between the strip and the verdict: it renders only for a
        // message with a `[jev-job]` mark, so every other answer is left as it was.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'jev-live', order: 105 }, LiveRunCard))
        // The verdict control, under every answer. A separate id and order, so the strip above is
        // untouched and neither can displace the other.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'jev-feedback', order: 110 }, AnswerVerdict))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-toast' }, Toast))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-llm' }, LlmDialog))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-export' }, ExportDialog))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-queue' }, TaskQueue))
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'kz-limits', order: 90, label: () => 'Plan limits' }, LimitsPill))
        // Composer history: an invisible resident in the composer tool row, so the arrows work only
        // while that composer is on screen. It renders nothing (see ComposerHistory).
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'kz-history', order: 91 }, ComposerHistory))
        // The work board's seat. It is NOT the composer dock any more (the strip above the message
        // box, where a task list must not live): it portals into the top of the conversation
        // scroller instead. This header utilities entry is only the mount point and draws nothing
        // of its own (see WorkBoardSeat). One registration, so the board can never appear twice.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'kz-work-board-seat', order: 30 }, WorkBoardSeat))
        // A bare /install-llm or /remove-llm opens the picker; typed arguments still go to the server command.
        ctx.inject(['commandUi'], (c) => {
          for (const [name, mode] of [['install-llm', 'install'], ['remove-llm', 'remove']]) {
            c.effect(() => c.commandUi.decorate({ name, available: () => true, ui: { kind: 'action', run: () => openLlm(mode) } }))
          }
        })
        if (!IN_APP) ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-float' }, FloatingBar))
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
        // Mode menu notes: an English (Kz-harness) language pack that says who each mode affects.
        // Chosen once automatically when the UI is in plain English; Settings -> General can switch back.
        ctx.inject(['locale'], (c) => {
          const KZ = 'en-x-kzh'
          c.effect(() => c.locale.addLanguage({ id: KZ, label: 'English (Kz-harness)', fallback: 'en' }))
          c.effect(() => c.locale.register('settings.agentPreset', KZ, {
            presetStandardName: 'Standard mode',
            presetStandardDescription: 'Recommended. Full toolbox: file editing, shell, file and web search, skills, planning, subagents. Used by DeepSeek and your API-key agents; Claude Code and Codex always use their own tools. Pick the model (Jev Auto) separately.',
            presetPtcName: 'PTC mode',
            presetPtcDescription: 'Experimental. Same tools, but the model writes one TypeScript program to chain them. Only affects DeepSeek and API-key agents; Claude Code and Codex are unchanged.',
            presetMinimalName: 'Minimal mode',
            presetMinimalDescription: 'For testing. DeepSeek and API-key agents get only a shell, so they do worse. Claude Code and Codex are unchanged.',
            presetCordisName: 'Creator mode',
            presetCordisDescription: 'For plugin authors only: Standard plus letting the model run code inside the engine to build new modes. Not for everyday use.',
          }))
          const t = setTimeout(() => {
            try { if (c.locale.getSnapshot().active === 'en') c.locale.setLocale(KZ) } catch {}
          }, 1500)
          c.effect(() => () => clearTimeout(t))
        })
      },
    }
  },
})
