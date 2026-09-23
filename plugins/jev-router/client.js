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
    // Services captured in apply (ctx.sessions, ctx.sidebarRight, ctx.layout, ctx.uiWorkspace).
    let sessionsApi
    let sidebarRight
    let layout
    let uiWorkspace
    // The Remote namespace the shipped Files tab uses (`ctx.remote.workspaceFiles`). Optional: when
    // absent the left sidebar file tree stays off rather than taking the whole plugin down.
    let workspaceFiles

    // ---------- helpers ----------
    const api = async (path, init) => {
      const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      return body
    }
    const ms = (n) => (n == null ? '-' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`)
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
.kzh-wb-row{display:flex;align-items:center;gap:8px;padding:3px 0;min-width:0}
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

    /**
     * Tell the server which background results this browser has actually rendered.
     *
     * A finished task stays "unread" until its message is in the conversation, and the engine
     * has no hook for "a person has now seen this", so the acknowledgement has to come from
     * here. Rows are matched by the job id the server puts at the front of the notice summary
     * (`jev-3 · Fix sidebar width · Completed`); each id is acknowledged once, and an id whose
     * request failed is forgotten so the next pass tries again. A renamed engine simply leaves
     * the selector empty.
     */
    const ackedResults = new Set()
    /**
     * The job id a notice summary starts with (`jev-3 · Fix sidebar width · Completed`), or
     * null when the row is not one of ours. Pure, so the contract with the server is testable.
     * Our summaries always carry three fields - id, task, status - and requiring all three is
     * what keeps another plugin's two-field notice from being mistaken for one of ours.
     */
    const resultIdOf = (summary) => {
      const parts = String(summary ?? '').split('·').map((s) => s.trim())
      if (parts.length < 3) return null
      return /^[a-z][\w-]{0,40}$/.test(parts[0]) ? parts[0] : null
    }
    function acknowledgeResults() {
      // The engine renders the producer and the summary as TEXT inside marked spans, not as
      // attribute values: `data-context-source` and `data-context-summary` are boolean
      // attributes on those spans (dsh-client-ui-chat ContextInjectionRow). So read the text,
      // and check the producer by its text too - a selector on the attribute value never
      // matches, which is how an earlier version silently acknowledged nothing.
      const ids = []
      for (const span of document.querySelectorAll('[data-context-summary]')) {
        const row = span.closest('[data-disclosure-row]') ?? span.parentElement
        if ((row?.querySelector('[data-context-source]')?.textContent ?? '').trim() !== 'jev-router') continue
        const id = resultIdOf(span.textContent)
        if (!id || ackedResults.has(id)) continue
        ackedResults.add(id)
        ids.push(id)
      }
      if (!ids.length) return
      post('/jev-router/tasks/seen', { jobIds: ids }).catch(() => { for (const id of ids) ackedResults.delete(id) })
    }
    function startResultAcks() {
      const pass = coalesce(acknowledgeResults)
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

    /** `decisionCard`: the decision card is rendered beside this one and carries the gate notes itself. */
    function WhatHappened({ s, decisionCard = false }) {
      const R = s.routed?.routing
      if (!R) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'What the code did'), h('div', { className: 'muted' }, s.error ? s.error.message : 'Routing…'))
      const kind = s.routed.tool ? 'tool' : R.mode === 'jev' ? 'agent' : R.mode
      const badge = { tool: 'tool', agent: 'agent', manual: 'manual', fallback: 'fallback' }[kind]
      const line = s.routed.tool
        ? `Jev picked tool ${s.routed.tool} (fits ${pct(R.toolFits)}, args ${pct(R.toolArgConfidence)}); no LLM needed`
        : R.mode === 'jev' ? `Jev picked ${movesOf(R)[0]?.from ?? R.primaryAgent} (confidence ${pct(R.agentConfidence)})`
          : R.mode === 'manual' ? `You forced ${R.primaryAgent}` : `Jev unavailable (${R.reason}); default agent ${movesOf(R)[0]?.from ?? R.primaryAgent}`
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
    // ---- end pure display helpers
    const AUTHORITY = {
      local: ['ok', 'local router'],
      jev: ['', 'Jev'],
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
          h('span', { className: cx('badge', d.jevCalls ? 'agent' : 'tool') }, d.jevCalls ? `${d.jevCalls} Jev call${d.jevCalls === 1 ? '' : 's'}` : 'no Jev call'),
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

    /**
     * The Router view: how far each routing domain has matured, what is blocking the next step,
     * and what the capability registry currently believes about each resource and on what
     * evidence. This is the tab that answers "why did it pick that, and who decided".
     */
    function RouterView({ data, error, busy, onRefresh }) {
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
          h('div', { className: 'muted', style: { margin: '6px 0' } }, MATURITY_WORDS[d.maturity] ?? ''),
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
              v.benchmark ? ` · benchmark ${pct(v.benchmark.score)}` : '')))))
      })
      return h('div', null,
        h('div', { className: 'head' },
          h('div', { className: 'label', style: { margin: 0 } }, data.learning ? 'The router is learning from every routed task' : 'Learning is switched off: Jev decides and nothing is recorded'),
          h('button', { onClick: onRefresh, disabled: busy }, busy ? 'Reading…' : 'Refresh')),
        h('div', { className: 'card' }, h('div', { className: 'label' }, 'Routing domains'), ...domains),
        h('div', { className: 'card' }, h('div', { className: 'label' }, 'Resources, as the provider adapters report them'), h('ul', { className: 'plain' }, ...resources)),
        h('div', { className: 'card' }, h('div', { className: 'label' }, 'What each resource is believed to be good at'),
          h('div', { className: 'why', style: { margin: '4px 0 8px' } }, 'Priors are the owner\'s starting observations. Recorded runs, reviews and feedback move them; an unknown dimension stays unknown.'),
          ...profiles))
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
        h(WhatHappened, { s, decisionCard: true }),
        h(RoutingDecision, { s }),
        h(Questions, { traces: s.traces }))
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
      const timing = done
        ? (t.durationMs != null ? ms(t.durationMs) : elapsed(t.startedAt, t.finishedAt ?? t.startedAt))
        : elapsed(t.startedAt, now)
      const meta = [
        queued ? (pos > 1 ? `${ordinal(pos)} in line` : 'next up') : null,
        t.agent ?? (queued ? 'Jev picks' : null),
        t.model, t.effort,
        phase, folderOf(t.workspace), timing || null,
      ].filter(Boolean).join(' · ')
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
        detail: String(t.progressText ?? t.lastLine ?? '').trim() || '…',
        canStop: !done,
        canClear: done,
      }
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

    /** Live work in this session: a background task counts once, not as its job and its run too. */
    function liveCount({ runs, jobs, entries, tasks }) {
      const shadowRuns = new Set(tasks.map((t) => t.runId).filter(Boolean))
      return tasks.filter((t) => LIVE_TASK.includes(t.state)).length
        + jobs.filter((j) => j.kind !== 'jev' && (j.status === 'running' || j.status === 'stopping')).length
        + runs.filter((r) => !shadowRuns.has(r.id) && summarize(r).running).length
        + entries.filter((e) => e.kind === 'child' && e.activity === 'running').length
    }

    // Live work sorts above the waiting line, which sorts above everything finished.
    const RANK = { running: 0, routing: 0, verifying: 0, reviewing: 0, queued: 1 }
    function taskItems({ sessionId, runs, jobs, entries, tasks, open, now }) {
      // A background task owns both a job and a router run; show the task, not its two shadows.
      const shadowed = new Set(tasks.map((t) => t.runId).filter(Boolean))
      const fromTasks = tasks.map((t) => {
        const queued = t.state === 'queued'
        const m = taskRowModel(t, now)
        const key = `t${t.jobId}`
        return {
          key, at: t.startedAt ?? t.queuedAt ?? 0, status: t.state, title: m.title, kind: t.jobId,
          position: t.position ?? 0, icon: m.icon, label: m.label, meta: m.meta,
          struck: m.struck, unread: m.unread, reason: m.reason,
          body: open.has(key) && t.reportAvailable
            ? h(TaskReport, { jobId: t.jobId })
            : h('div', { className: 'answer-text' }, m.detail),
          // Only worth offering when something else is genuinely ahead of it.
          runNext: queued && (t.position ?? 0) > 2 && { workspace: t.workspace, jobId: t.jobId },
          stop: m.canStop && { what: m.title, run: () => post('/jev-router/tasks/stop', { jobId: t.jobId }) },
          clear: m.canClear && { what: m.title, run: () => post('/jev-router/tasks/clear', { jobIds: [t.jobId] }) },
        }
      })
      const fromRuns = runs.filter((r) => !shadowed.has(r.id)).map((r) => {
        const s = summarize(r)
        const cur = s.attempts.at(-1)
        const status = r.stopped ? 'stopped' : s.running ? 'running' : s.error || s.final?.status === 'limit_reached' ? 'failed' : 'done'
        return {
          key: `r${r.id}`, at: r.startedAt ?? 0, status, title: r.task, kind: 'Jev',
          meta: [cur ? `${cur.agent} (${cur.role})` : s.routed?.routing?.primaryAgent ?? 'routing…', s.final ? STATUS[s.final.status]?.[1] ?? s.final.status : null, ms(s.total)].filter(Boolean).join(' · '),
          body: h('div', { className: 'answer-text', 'aria-live': status === 'running' ? 'polite' : undefined }, r.events.map((e) => e.text ?? e.type).join('\n')),
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
      if (s === 'paused_limit' || s === 'needs_human') return 'warn'
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
      const ownedIds = new Set((taskRows ?? []).map((r) => r.task?.runId).filter(Boolean))
      const ownedByTask = (p) => p.record && (taskRows ?? []).some((r) => r.task?.task === p.record.task && Number.isFinite(r.at) && Number.isFinite(p.at) && Math.abs(r.at - p.at) <= RUN_MATCH_MS)
      const out = []
      for (const p of pairs ?? []) {
        if (p.live ? ownedIds.has(p.live.id) : ownedByTask(p)) continue
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
                  it.reason ? h('div', { className: cx('reason', it.status) }, it.reason) : null)),
              h('div', { style: { marginTop: 6 } }, it.body)),
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
              className: 'btn danger', 'aria-label': `Stop ${it.title}`,
              onClick: () => setConfirm({
                title: 'Stop this task?',
                body: `Stop "${clip(it.stop.what, 120)}"? Work it already did stays in the workspace.`,
                confirmLabel: 'Stop task',
                run: it.stop.run,
              }),
            }, 'Stop') : null)))),
        confirm ? h(Confirm, {
          title: confirm.title,
          body: confirm.body,
          confirmLabel: confirm.confirmLabel,
          onCancel: () => setConfirm(null),
          onConfirm: () => { const c = confirm; setConfirm(null); act(c.run) },
        }) : null)
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
      const [confirm, setConfirm] = useState(false)
      const [err, setErr] = useState('')
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
      // The panel helpers throw when the right sidebar is missing; a click there must do nothing,
      // never throw, so the header can never become a dead end.
      const openOverview = () => { try { togglePanel(OVERVIEW_KIND) } catch {} }
      const stopAll = () => {
        setErr('')
        Promise.all(live.map((t) => post('/jev-router/tasks/stop', { jobId: t.jobId }))).catch((e) => setErr(e.message))
      }
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
            'aria-label': `Stop all ${live.length} running task${live.length === 1 ? '' : 's'}`,
            title: `Stop: ${clip(what, 160)}`, onClick: () => setConfirm(true),
          }, 'Stop all') : null),
        h('ul', { className: 'kzh-wb-list', 'aria-label': 'Background tasks' }, ...tasks.map((t, i) => {
          const m = taskRowModel(t, now)
          const isLive = LIVE_TASK.includes(t.state)
          // The mark is a glyph, or the stylesheet's spinner while the task works; the pill beside
          // it says the same state in words, so shape and colour are never the only difference.
          return h('li', { key: m.jobId ?? `t${i}`, className: cx('kzh-wb-row', isLive && 'live') },
            h('span', { className: 'kzh-wb-mark', 'aria-hidden': true }, isLive ? '' : m.icon),
            h('span', { className: cx('kzh-wb-title', m.struck && 'struck'), title: m.title || undefined }, m.title || 'Untitled task'),
            h('span', { className: 'kzh-wb-state' }, m.label),
            h('span', { className: 'kzh-wb-meta', title: m.meta }, m.meta),
            isLive ? h('span', { className: 'kzh-wb-time' }, elapsed(t.startedAt, now) || 'starting') : null)
        })),
        // The same news the background button gives, spoken: one polite line, never taking focus.
        h('span', { className: 'kzh-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, resultAnnouncement(awaitingDelivery(tasks))),
        err ? h('div', { className: 'kzh-wb-err', role: 'alert' }, err) : null,
        confirm ? h(Confirm, {
          title: 'Stop all running tasks?',
          body: `${live.length} task${live.length === 1 ? '' : 's'} in this session stop now: ${clip(what, 200)}. Work already done stays in the workspace.`,
          confirmLabel: `Stop ${live.length}`,
          onCancel: () => setConfirm(false),
          onConfirm: () => { setConfirm(false); stopAll() },
        }) : null)
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
      const acct = a.account?.email ?? a.account?.label
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
            h('dt', null, 'Limit saves'), h('dd', null, 'agents skipped at their limit, and limit hits moved to another key or agent, in runs that did not pause; counted, not priced')),
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

    /** Settings: subscription logins and API keys per provider. */
    function KeyProvider({ provider, list, busy, act, ask, setNotice }) {
      const [name, setName] = useState('')
      const [key, setKey] = useState('')
      const label = providerLabel(provider)
      const activate = (n) => act(async () => {
        const r = await post('/jev-router/keys/activate', { provider, name: n })
        if (r?.restartRequired) setNotice('Restart the harness to apply (Kz-harness → Restart harness)')
      })
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
          h('input', { type: 'text', required: true, pattern: '[A-Za-z0-9_]{1,32}', title: 'Letters, digits or _', placeholder: 'Key name, e.g. acct2', 'aria-label': `${label} key name`, value: name, onChange: (e) => setName(e.target.value) }),
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
        ...[...new Set(['deepseek', 'jev', ...Object.keys(keys)])].map((p) => h(KeyProvider, { key: p, provider: p, list: keys[p] ?? [], busy, act, ask, setNotice })))
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
          : view === 'router' ? h(RouterView, { ...routing, onRefresh: routing.load })
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

    function TaskQueue() {
      useStyle()
      useUiTick()
      const { open } = queueOpen.use()
      const face = currentFace()
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
      const line = R.mode === 'jev' ? `Jev picked ${movesOf(R)[0]?.from ?? R.primaryAgent ?? '?'}` : R.mode === 'manual' ? `You forced ${R.primaryAgent ?? '?'}` : `Mode ${R.mode ?? '?'}`
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
    function EffortCard() {
      const [e, setE] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => { api('/jev-router/effort').then(setE, (x) => setErr(x.message)) }, [])
      const save = async (next) => { setErr(''); try { setE(await api('/jev-router/effort', { method: 'POST', body: JSON.stringify(next) })) } catch (x) { setErr(x.message) } }
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
            e.codexSpeed === 'fast' ? '1.5x (uses more of your plan)' : 'Normal'))))
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
      const load = useCallback(async (recheck) => {
        setBusy(true); setError('')
        try { setData(await api(`/jev-router/setup${recheck ? '?recheck=1' : ''}`)) } catch (e) { setError(e.message) } finally { setBusy(false) }
      }, [])
      useEffect(() => { load(false) }, [load])
      const act = async (fn) => { setError(''); setBusy(true); try { await fn(); loadUsage(false); await load(false) } catch (e) { setError(e.message); setBusy(false) } }

      if (!data) return h('div', { className: 'jevi' }, h('h3', null, 'Jev setup'), error ? h('div', { className: 'err' }, error) : h('div', { className: 'muted' }, 'Checking logins…'))
      const onCount = data.agents.filter((a) => a.enabled).length
      const usable = data.agents.filter((a) => a.enabled && a.status?.loggedIn).length
      const provider = data.providers.find((p) => p.id === form.provider)

      return h('div', { className: 'jevi', style: { height: 'auto' } },
        h('h3', null, 'Jev setup'),
        h('p', { className: 'muted' }, 'Which LLM agents Jev can route to, and whether each one is signed in. At least one LLM must stay on.'),
        h(AgentChips, { agents: data.agents, usage, busy, onToggle: (id, enabled) => act(() => post('/jev-router/agents', { id, enabled })) }),
        error ? h('div', { className: 'err', role: 'alert' }, error) : null,
        notice ? h('div', { className: 'note', role: 'status' }, notice) : null,

        h('div', { className: 'card', style: { marginTop: 12 } },
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

        h(AccountsCard, { setupAgents: data.agents, usage, busy, act, ask: setConfirm, setNotice }),

        h(LocalModelsCard, { ask: setConfirm }),

        h(EffortCard),

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
            : h('div', { className: 'muted' }, 'None yet. Add scripts under `tools` in the jev-router entry of ~/.dsh/profiles/web/cordis.patch.yml; Jev runs one when it fully covers a task.')),

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

    /** Local engine + module status, polled while shown (faster while something installs). */
    function useLocal(active) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(async () => {
        try { setData(await api('/jev-router/local')); setError('') } catch (e) { setError(e.message) }
      }, [])
      const busy = !!data?.modules?.some((m) => ACTIVE_JOB.includes(m.job?.state) || m.state === 'verifying')
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
              const blocked = x.rating.fit === 'no'
              const id = `jevi-llm-${x.id}`
              return h('li', { key: x.id, style: { alignItems: 'flex-start' } },
                h('label', { htmlFor: id, style: { display: 'flex', gap: 8, minWidth: 0, cursor: inst || blocked ? 'default' : 'pointer' } },
                  h('input', { id, type: 'checkbox', checked: !inst && !!picked?.has(x.id), disabled: inst || blocked || ACTIVE_JOB.includes(job?.state), onChange: () => toggle(x.id), style: { marginTop: 3 } }),
                  h('div', { style: { minWidth: 0 } },
                    h('div', null, h('b', null, x.name), h('span', { className: 'pill' }, bytes(x.size)), inst ? h('span', { className: 'pill ok' }, 'installed') : null, x.suggested && !inst ? h('span', { className: 'pill ok' }, 'suggested') : null),
                    h('div', { className: cx('why', blocked && 'err') }, blocked ? `Won't fit: ${x.rating.reason}` : x.rating.label),
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

    /** Settings → Jev setup: engine status, chat model, idle stop, GPU layers, installed modules. */
    function LocalModelsCard({ ask }) {
      const { data, error, load } = useLocal(true)
      const [msg, setMsg] = useState('')
      const [idle, setIdle] = useState('')
      const [layers, setLayers] = useState('')
      const [startModel, setStartModel] = useState('')
      useEffect(() => {
        if (!data) return
        setIdle((v) => v || String(data.settings.idleMinutes))
        setLayers((v) => v || String(data.settings.gpuLayers ?? 'auto'))
      }, [data])
      const run = async (fn) => { setMsg(''); try { await fn(); await load() } catch (e) { setMsg(e.message) } }
      if (!data) return h('div', { className: 'card' }, h('div', { className: 'label' }, 'Local models'), h('div', { className: error ? 'err' : 'muted' }, error || 'Loading…'))
      const e = data.engine
      const models = data.modules.filter((m) => m.kind === 'model' && m.state === 'installed')
      const pick = startModel || data.settings.chatModel || models[0]?.id || ''
      const rows = removableRows(data)
      const busyJobs = data.modules.filter((m) => ACTIVE_JOB.includes(m.job?.state) || m.state === 'verifying')
      return h('section', { className: 'card', 'aria-labelledby': 'jevi-local-h' },
        h('div', { className: 'head' },
          h('div', { className: 'label', id: 'jevi-local-h', style: { margin: 0 } }, 'Local models'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { className: 'btn primary', onClick: () => openLlm('install') }, 'Install…'),
            h('button', { className: 'btn danger', disabled: !rows.length, onClick: () => openLlm('remove') }, 'Remove…'))),
        h('p', { className: 'why', style: { margin: '4px 0 8px' } }, 'Free, private models on this PC (llama.cpp, 127.0.0.1 only). Used when you are offline, as a fallback chat model, and as cheap agents Jev may pick. Type /install-llm in any chat to add one.'),
        h('div', null, h('span', { className: cx('dot', e.running ? 'on' : 'off') }),
          !e.installed ? 'Engine not installed.' : e.running ? `Running ${e.model}${e.ready ? '' : ' (loading…)'} · 127.0.0.1:${e.port} · context ${e.ctx}${e.gpuLayers ? ` · ${e.gpuLayers.gpu}/${e.gpuLayers.total} layers on GPU` : ''}${e.vision ? ' · vision' : ''}` : `Stopped (engine: ${e.variant}). Starts by itself when a local model is needed.`),
        h('div', { className: 'why' }, 'On a 4 GB GPU a model bigger than ~3 GB splits between GPU and CPU and gets several times slower; the rest waits in RAM.'),
        e.installed && models.length ? h('div', { className: 'limits', style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('label', { htmlFor: 'jevi-lm-chat' }, 'Chat model ',
            h('select', { id: 'jevi-lm-chat', value: data.settings.chatModel ?? '', onChange: (ev) => run(() => post('/jev-router/local/settings', { chatModel: ev.target.value })) },
              ...models.map((m) => h('option', { key: m.id, value: m.id }, m.name)))),
          h('label', { htmlFor: 'jevi-lm-idle' }, 'Stop after idle (min) ',
            h('input', { id: 'jevi-lm-idle', type: 'number', min: 1, max: 240, value: idle, style: { width: 64 }, onChange: (ev) => setIdle(ev.target.value), onBlur: () => run(() => post('/jev-router/local/settings', { idleMinutes: Number(idle) })) })),
          h('label', { htmlFor: 'jevi-lm-ngl' }, 'GPU layers ',
            h('input', { id: 'jevi-lm-ngl', type: 'text', value: layers, style: { width: 64 }, title: "'auto' fits as many layers as free VRAM allows; a number pins it", onChange: (ev) => setLayers(ev.target.value), onBlur: () => run(() => post('/jev-router/local/settings', { gpuLayers: layers.trim() === 'auto' ? 'auto' : Number(layers) })) })),
          e.running
            ? h('button', { className: 'btn', onClick: () => run(() => post('/jev-router/local/stop', {})) }, 'Stop')
            : h(React.Fragment, null,
              h('select', { 'aria-label': 'Model to start', value: pick, onChange: (ev) => setStartModel(ev.target.value) }, ...models.map((m) => h('option', { key: m.id, value: m.id }, m.name))),
              h('button', { className: 'btn', onClick: () => run(() => post('/jev-router/local/start', { model: pick })) }, 'Start'))) : null,
        msg ? h('div', { className: 'err', role: 'alert' }, msg) : null,
        busyJobs.length ? h('div', { style: { marginTop: 8 } }, ...busyJobs.map((m) => h('div', { key: m.id }, h('b', null, m.name), m.state === 'verifying' ? h('div', { className: 'why' }, 'Checking SHA256…') : h(JobLine, { job: m.job })))) : null,
        rows.length ? h('ul', { className: 'plain', style: { marginTop: 8 } }, ...rows.map((r) => {
          const m = data.modules.find((x) => x.id === r.ids[0])
          return h('li', { key: r.id },
            h('div', { style: { minWidth: 0 } },
              h('div', null, h('b', null, r.name), m?.state === 'corrupt' ? h('span', { className: 'pill bad' }, 'SHA256 mismatch') : h('span', { className: 'pill ok' }, 'installed'), m?.agent ? h('span', { className: 'pill' }, m.agent) : null),
              h('div', { className: 'why' }, `${r.files.join(', ')} · ${bytes(r.size)}`),
              m?.badges ? h(Badges, { list: m.badges }) : null),
            h('button', { className: 'btn danger', 'aria-label': `Remove ${r.name}`, onClick: () => ask(removeConfirm([r], () => post('/jev-router/local/remove', { ids: r.ids }))) }, 'Remove'))
        })) : h('div', { className: 'muted', style: { marginTop: 8 } }, 'Nothing installed yet. Install… suggests models that fit this PC.'))
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
    const tagsFor = (verdict) => TAGS_FOR[verdict] ?? []
    /** A tag is optional: clicking the selected chip removes it. Pure, so it unit-tests. */
    const toggledTag = (current, clicked) => (current === clicked ? '' : clicked)

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

    /**
     * Like/Dislike with an optional one-line reason, under every assistant answer. The seat gives
     * `messageId` plus the standard `sessionId` and `useChat`; with no way to name the message there
     * is nothing to attach a verdict to, so it renders nothing.
     */
    function AnswerVerdict({ messageId, sessionId, useChat }) {
      useStyle()
      const nameMap = names.use()
      // The message text carries both provenance shapes: the chain marker and the direct credit line.
      const text = useChat ? useChat((s) => messageText(s.legacy.nodes, messageId)) : ''
      const [state, setState] = useState({ verdict: null, reason: '', tag: '', suggestedAgent: '' })
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [agents, setAgents] = useState(null)
      // A click made before the stored verdict lands wins: the person's action is newer than the read.
      const touched = useRef(false)
      const prov = messageProvenance(text) ?? { agent: '', model: '', provider: '' }

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
            if (r) setState({ verdict: r.verdict, reason: r.reason ?? '', tag: r.tag ?? '', suggestedAgent: r.suggestedAgent ?? '' })
          })
          .catch(() => {})
        return () => { stop = true }
      }, [sessionId, messageId])

      if (!messageId || !sessionId) return null
      const provider = verdictProvider(prov)

      /** Optimistic: show the new verdict, then POST; a failure puts the old one back and says so. */
      const commit = async (next) => {
        const prev = state
        touched.current = true
        setEditing(false)
        setState(next)
        try {
          await post('/jev-router/feedback', feedbackBody({
            sessionId, messageId, verdict: next.verdict, reason: next.reason, tag: next.tag,
            suggestedAgent: next.suggestedAgent, provider, model: prov.model, runId: messageRunId(text),
          }))
        } catch (e) {
          setState(prev)
          toast(`Feedback not saved: ${e.message}`)
        }
      }
      const pick = (v) => {
        const next = toggledVerdict(state.verdict, v)
        if (!next) return commit({ verdict: null, reason: '', tag: '', suggestedAgent: '' })
        // A tag the new verdict does not offer is dropped, so a leftover chip cannot ride along.
        const tag = tagsFor(next).includes(state.tag) ? state.tag : ''
        return commit({ verdict: next, reason: state.reason, tag, suggestedAgent: next === 'dislike' ? state.suggestedAgent : '' })
      }
      const saveReason = () => {
        if (!state.verdict) return
        setEditing(false)
        if (draft.trim() === state.reason) return
        commit({ ...state, reason: draft })
      }
      const editReason = () => { setDraft(state.reason); setEditing(true) }
      const setSuggested = (id) => commit({ ...state, suggestedAgent: id })
      const setTag = (tag) => commit({ ...state, tag: toggledTag(state.tag, tag) })

      return h('div', { className: 'kzh-vd', role: 'group', 'aria-label': 'Rate this answer' },
        h('button', {
          type: 'button', className: cx('kzh-vd-btn', state.verdict === 'like' && 'on'),
          'aria-pressed': state.verdict === 'like',
          title: state.verdict === 'like' ? 'Liked. Click to clear.' : 'This answer was right',
          onClick: () => pick('like'),
        }, state.verdict === 'like' ? 'Liked' : 'Like'),
        h('button', {
          type: 'button', className: cx('kzh-vd-btn', state.verdict === 'dislike' && 'on'),
          'aria-pressed': state.verdict === 'dislike',
          title: state.verdict === 'dislike' ? 'Disliked. Click to clear.' : 'This answer was wrong',
          onClick: () => pick('dislike'),
        }, state.verdict === 'dislike' ? 'Disliked' : 'Dislike'),
        // The optional tag, one chip per category, offered after the verdict so the person can say
        // WHAT was wrong rather than only that something was. Selected state is aria-pressed, never
        // colour alone, and every chip is a real button so it is keyboard operable.
        state.verdict ? h('div', {
          className: 'kzh-vd-tags', role: 'group',
          'aria-label': state.verdict === 'dislike' ? 'What was wrong (optional)' : 'What was good (optional)',
        }, ...tagsFor(state.verdict).map((t) => h('button', {
          key: t, type: 'button', className: 'kzh-vd-tag',
          'aria-pressed': state.tag === t,
          title: state.tag === t ? `${t}. Click to remove this tag.` : `Tag this verdict: ${t}`,
          onClick: () => setTag(t),
        }, t))) : null,
        state.verdict ? (editing
          ? h('input', {
              className: 'kzh-vd-reason', type: 'text', value: draft, autoFocus: true,
              placeholder: 'Why?', 'aria-label': 'Why: the reason for this verdict',
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
        state.verdict === 'dislike' ? h('label', { className: 'kzh-vd-sug' },
          h('span', { className: 'kzh-vd-suglab' }, 'should have been'),
          h('select', {
            className: 'kzh-vd-select', value: state.suggestedAgent,
            'aria-label': 'should have been: the agent that should have answered',
            onChange: (e) => setSuggested(e.target.value),
          }, h('option', { value: '' }, 'no suggestion'),
            ...(agents ?? []).filter(canSuggest).map((a) => h('option', { key: a.id, value: a.id }, nameMap.agents?.[a.id] ?? a.id)))) : null)
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
      __test: { Markdown, transcriptButton, transcriptClicks, actions: ACTIONS, taskRowModel, taskLabels, liveTasks, liveSummary, workBoardHeader, resultIdOf, awaitingDelivery, resultAnnouncement, toggleActionOf, coalesce, startTranscripts, startResultAcks, userInputs, historyStep, arrowIntent, fileTreeRows: treeRows, orderTreeEntries, treeChildPath, fileAddressFor, treeFailureLine, fileTreeSearchLabels: FILE_TREE_SEARCH_LABELS, messageProvenance, messageRunId, verdictProvider, storedVerdict, toggledVerdict, feedbackBody, canSuggest, modelId, tagsFor, toggledTag, overviewGroups: OVERVIEW_GROUPS, overviewText, conversationLedger, turnWindows, bucketFor, pairRuns, runLedgerRows, taskLedgerRows, jobLedgerRows, subagentLedgerRows, buildLedger, recordState, recordDurationMs },
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
        if (IN_APP) {
          document.documentElement.classList.add('kzh-in-app')
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-titlebar' }, TitleBar))
        } else {
          ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'kz-launcher', order: 100 }, HeaderActions))
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'kz-shortcuts', order: 16, label: () => 'Shortcuts' }, ShortcutsSection))
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'jev-agents', order: 100 }, AgentStrip))
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
