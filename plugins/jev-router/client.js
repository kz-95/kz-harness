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
    // Services captured in apply (ctx.sessions, ctx.sidebarRight, ctx.layout, ctx.uiWorkspace).
    let sessionsApi
    let sidebarRight
    let layout
    let uiWorkspace

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
.jevi details.answer{margin:4px 0 0}
.jevi details.answer summary{cursor:pointer;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}
.jevi .answer-text{white-space:pre-wrap;word-break:break-word;margin-top:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);max-height:240px;overflow:auto}
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
@keyframes kzh-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.jevi .st.running{animation:none}}
.kzh-bar{display:flex;align-items:center;gap:2px}
.kzh-ib{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.kzh-ib:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kzh-ib[aria-pressed=true],.kzh-ib[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.kzh-ib:disabled{opacity:.45;cursor:default}
.kzh-ib:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kzh-dot{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}
.kzh-menu{position:fixed;z-index:10000;min-width:250px;padding:4px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 28px var(--dsw-alias-bg-mask-3);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}
.kzh-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kzh-menu button:hover,.kzh-menu button:focus{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.kzh-menu button:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary)}
.kzh-menu .grow{flex:1}
.kzh-menu .n{font:var(--dsw-font-xxxs-11);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:0 6px}
.kzh-menu kbd{font:var(--dsw-font-xxxs-11);font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-caption)}
.kzh-menu [role=separator]{border-top:1px solid var(--dsw-alias-border-l1);margin:4px 2px}
.kzh-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10001;pointer-events:auto;max-width:min(480px,calc(100% - 32px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 14px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);box-shadow:0 8px 28px var(--dsw-alias-bg-mask-3)}
.jevi.kzb{padding:0;overflow:hidden;display:flex;flex-direction:column}
.kzb-bar{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kzb-bar input[type=text]{flex:1;min-width:0;margin:0 4px}
.kzb .view{flex:1;min-height:0;position:relative}
.kzb iframe{display:block;border:0;width:100%;height:100%;background:#fff}
.kzb .note{margin:6px 8px}
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
        use() {
          const [, force] = useState(0)
          useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f) } }, [])
          return value
        },
      }
    }
    const toasts = makeStore({ text: '', n: 0 })
    const toast = (text) => toasts.set({ text, n: toasts.get().n + 1 })

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

    /** Everything the header, the menu and the hotkeys can do. `keys` is the default combo ('' = none). */
    const ACTIONS = [
      { id: 'terminal', label: 'Terminal', keys: 'Ctrl+`', run: async () => {
        const cwd = currentCwd()
        if (!cwd) throw new Error('This session has no project folder')
        await post('/jev-router/open-terminal', { cwd })
      } },
      { id: 'background', label: 'Background tasks', keys: 'Ctrl+Alt+B', run: () => openPanel(KIND, { view: 'jobs' }) },
      { id: 'browser', label: 'Browser', keys: 'Ctrl+Alt+W', run: () => togglePanel(BROWSER_KIND) },
      { id: 'jev-inspector', label: 'Jev inspector', keys: 'Ctrl+Alt+J', run: () => togglePanel(KIND, { view: 'decisions' }) },
      { id: 'files', label: 'Files', keys: 'Ctrl+Alt+E', run: () => openPanel('files') },
      { id: 'usage', label: 'Usage', keys: 'Ctrl+Alt+U', run: () => openPanel(KIND, { view: 'usage' }) },
      { id: 'left-sidebar', label: 'Toggle left sidebar', keys: 'Ctrl+B', run: () => layout.toggleSidebar() },
      { id: 'focus-mode', label: 'Focus mode', keys: 'Ctrl+Shift+F', run: focusMode },
      { id: 'new-session', label: 'New session', keys: 'Ctrl+Alt+N', run: () => {
        if (uiWorkspace?.startSession) return uiWorkspace.startSession()
        const b = document.querySelector('button[aria-label="New session"]')
        if (!b) throw new Error('New session is not available here')
        b.click()
      } },
      // No composer focus API; the message box is DSH's one Lexical editor.
      { id: 'focus-input', label: 'Focus message box', keys: '', run: () => document.querySelector('[data-lexical-editor="true"]')?.focus() },
      { id: 'jev-setup', label: 'Jev setup settings', keys: '', run: () => openSettings('Jev setup') },
      { id: 'shortcuts', label: 'Shortcuts settings', keys: '', run: () => openSettings('Shortcuts') },
    ]
    const ACT = Object.fromEntries(ACTIONS.map((a) => [a.id, a]))
    const DEFAULTS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.keys]))
    const DEFAULT_RATIO = 20
    // Shortcuts DSH, its editor and the Kz-harness app already use (read-only; conflict detection checks them).
    const BUILTIN = [
      ['Ctrl+Enter', 'Send message (DSH message box)'], ['Shift+Enter', 'New line (DSH message box)'],
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
            a.end?.answerText ? h('details', { className: 'answer' },
              h('summary', null, `Answer from ${a.agent}${a.end.model ? ` (${a.end.model})` : ''}`),
              h('div', { className: 'answer-text' }, a.end.answerText)) : null,
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
    const ST = { running: ['', 'Running'], done: ['✓', 'Done'], failed: ['✕', 'Failed'], stopped: ['■', 'Stopped'] }
    const elapsed = (from, to) => (from ? ms(to - from) : '')
    const openKid = (sessionId, e) => sessionsApi?.openSubagent?.({ parentSessionId: sessionId, childSessionId: e.id, mode: e.mode, ...(e.label ? { label: e.label } : {}) })

    function taskItems({ sessionId, runs, jobs, entries, now }) {
      const fromRuns = runs.map((r) => {
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
      const fromJobs = jobs.map((j) => {
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
      // Running first, then newest.
      return [...fromRuns, ...fromJobs, ...fromKids].sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.at - a.at)
    }

    function Tasks({ sessionId, runs, jobs, entries }) {
      useSubagentCatalog(sessionId)
      const [confirm, setConfirm] = useState(null)
      const [err, setErr] = useState('')
      const anyRunning = runs.some((r) => summarize(r).running) || jobs.some((j) => j.status === 'running' || j.status === 'stopping')
      const now = useNow(anyRunning)
      const items = taskItems({ sessionId, runs, jobs, entries, now })
      if (!items.length) return h('div', { className: 'empty' }, 'Nothing running or finished in this session yet.')
      return h('div', null,
        err ? h('div', { className: 'err', role: 'alert' }, err) : null,
        h('ul', { className: 'plain', 'aria-label': 'Background tasks' }, ...items.map((it) => h('li', { key: it.key, className: 'task', style: { display: 'block' } },
          h('div', { className: 'top' },
            h('details', null,
              h('summary', null,
                h('span', { className: cx('st', it.status), role: 'img', 'aria-label': ST[it.status][1] }, ST[it.status][0]),
                h('span', { style: { minWidth: 0 } },
                  h('div', { className: 'title', title: it.title }, it.title),
                  h('div', { className: 'why' }, h('span', { className: 'pill', style: { marginLeft: 0, marginRight: 6 } }, it.kind), it.meta))),
              h('div', { style: { marginTop: 6 } }, it.body)),
            it.stop ? h('button', { className: 'btn danger', 'aria-label': `Stop ${it.title}`, onClick: () => setConfirm(it.stop) }, 'Stop') : null)))),
        confirm ? h(Confirm, {
          title: 'Stop this task?',
          body: `Stop "${confirm.what.length > 120 ? `${confirm.what.slice(0, 120)}…` : confirm.what}"? Work it already did stays in the workspace.`,
          confirmLabel: 'Stop task',
          onCancel: () => setConfirm(null),
          onConfirm: () => { const c = confirm; setConfirm(null); setErr(''); Promise.resolve(c.run()).catch((e) => setErr(e.message)) },
        }) : null)
    }

    // ---------- accounts, usage, limits ----------
    const AGENT_LABEL = { claude: 'Claude', codex: 'GPT', deepseek: 'DeepSeek', jev: 'Jev', chat: 'Chat model' }
    const PROVIDER_LABEL = { deepseek: 'DeepSeek', jev: 'Jev' }
    const agentLabel = (id) => AGENT_LABEL[id] ?? id
    const providerLabel = (p) => PROVIDER_LABEL[p] ?? p
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

    function LimitInput({ agentId, field, label, value, percent }) {
      const [v, setV] = useState(value ?? '')
      const [dirty, setDirty] = useState(false)
      const [msg, setMsg] = useState('')
      useEffect(() => { if (!dirty) setV(value ?? '') }, [value, dirty])
      const save = async () => {
        if (!dirty) return
        const n = Number(v)
        if (v === '' || !Number.isFinite(n) || n < 0 || (percent && n > 100)) { setMsg(percent ? 'Enter 0–100' : 'Enter a number ≥ 0'); return }
        setMsg('Saving…')
        try { await post('/jev-router/limits', { agentId, [field]: n }); setDirty(false); setMsg('Saved') } catch (e) { setMsg(e.message) }
      }
      const id = `jevi-lim-${agentId}-${field}`
      return h('label', { htmlFor: id }, label,
        h('input', { id, type: 'number', min: 0, max: percent ? 100 : undefined, step: percent ? 1 : 0.01, value: v,
          onChange: (e) => { setV(e.target.value); setDirty(true); setMsg('') }, onBlur: save, onKeyDown: (e) => { if (e.key === 'Enter') save() } }),
        h('span', { className: cx('saved', msg && msg !== 'Saved' && msg !== 'Saving…' && 'bad'), 'aria-live': 'polite' }, msg))
    }

    function KeyStates({ list }) {
      return h('ul', { className: 'plain' }, ...list.map((k) => {
        const st = stateInfo(k)
        return h('li', { key: k.name },
          h('span', null, h('span', { className: cx('dot', st.dot) }), h('b', null, k.name), k.active ? h('span', { className: 'pill ok' }, 'active') : null),
          h('span', { className: 'why' }, [money(k.balance), typeof k.spentUsd === 'number' ? `$${k.spentUsd.toFixed(2)} this month` : null, k.state ? st.text : null].filter(Boolean).join(' · ')))
      }))
    }

    function UsageCard({ a, keys }) {
      const st = stateInfo(a)
      const acct = a.account?.email ?? a.account?.label
      const L = a.limits ?? {}
      const fields = a.kind === 'subscription'
        ? [['handoffAtPercent', 'Handoff at %', true], ['stopAtPercent', 'Stop at %', true]]
        : a.id === 'jev' ? [] : [['minBalance', `Min balance${a.balance?.currency ? ` (${a.balance.currency})` : ''}`, false]]
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
        money(a.balance) ? h('div', { style: { marginTop: 6 } }, 'Balance ', h('b', null, money(a.balance))) : null,
        typeof a.spentUsd === 'number' ? h('div', { style: { marginTop: 6 } }, 'Spent this month ', h('b', null, `$${a.spentUsd.toFixed(2)}`)) : null,
        keys?.length ? h(KeyStates, { list: keys }) : null,
        fields.length ? h('div', { className: 'limits' }, ...fields.map(([k, label, percent]) => h(LimitInput, { key: k, agentId: a.id, field: k, label, percent, value: L[k] }))) : null,
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

    function UsageView({ usage, error, busy, onRefresh }) {
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
        ...agents.map((a) => h(UsageCard, { key: a.id, a, keys: keysFor(a) })),
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
        if (['decisions', 'subagents', 'jobs', 'usage'].includes(v)) setView(v)
      }, [nav?.revision, nav?.params?.view])
      const runs = useRuns(sessionId, visible)
      const entries = useSessions?.((s) => s.subagentsByParent?.[sessionId]?.entries) ?? EMPTY
      const jobs = useSessions?.((s) => s.jobsBySession?.[sessionId]) ?? EMPTY
      const liveKids = entries.filter((e) => e.kind === 'child' && e.activity === 'running').length
      const liveJobs = jobs.filter((j) => j.status === 'running' || j.status === 'stopping').length
      const { usage, error: usageErr, busy: usageBusy, load: loadUsage } = useUsage(visible)
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
        h('div', { className: 'tabs', role: 'tablist' }, tab('decisions', 'Decisions', runs.length), tab('subagents', 'Subagents', liveKids), tab('jobs', 'Background', liveJobs + liveKids + runs.filter((r) => summarize(r).running).length), tab('usage', 'Usage', limited)),
        view === 'decisions' ? h(Decisions, { runs }) : view === 'subagents' ? h(Subagents, { sessionId, entries })
          : view === 'usage' ? h(UsageView, { usage, error: usageErr, busy: usageBusy, onRefresh: () => loadUsage(true) }) : h(Tasks, { sessionId, runs, jobs, entries }))
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
        }) : null,
        confirm ? h(Confirm, { ...confirm, onCancel: () => setConfirm(null), onConfirm: () => { const c = confirm; setConfirm(null); act(c.run) } }) : null)
    }

    // ---------- icons (16px, currentColor) ----------
    const svg = (...kids) => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' }, ...kids)
    const P = (d) => h('path', { d })
    const ICON = {
      terminal: () => svg(P('M3 4.5 6.5 8 3 11.5'), P('M8 12h5')),
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
    function MoreMenu({ anchor, items, onClose }) {
      const ref = useRef(null)
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
      return h('div', { ref, role: 'menu', 'aria-label': 'More panels and actions', className: 'kzh-menu', onKeyDown,
        style: r ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) } : undefined },
      ...items.map((it, n) => (it === '-' ? h('div', { key: `sep${n}`, role: 'separator' }) : h('button', {
        key: it.id, type: 'button', role: 'menuitem', tabIndex: -1,
        onClick: () => { onClose(true); runAction(it.id) },
      }, h('span', { className: 'grow' }, ACT[it.id].label), it.count ? h('span', { className: 'n', 'aria-label': `${it.count} running` }, it.count) : null,
      it.keys ? h('kbd', null, it.keys) : null))))
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
      const running = runs.filter((r) => summarize(r).running).length
        + jobs.filter((j) => j.status === 'running' || j.status === 'stopping').length
        + entries.filter((e) => e.kind === 'child' && e.activity === 'running').length
      const kind = activeKind()
      const tip = (id) => (bindings[id] ? `${ACT[id].label} (${bindings[id]})` : ACT[id].label)
      const btn = (id, extra = {}) => h('button', {
        key: id, type: 'button', className: 'kzh-ib', title: tip(id), 'aria-label': extra.label ?? ACT[id].label,
        'aria-keyshortcuts': bindings[id] ? ariaKeys(bindings[id]) : undefined, 'aria-pressed': extra.pressed, onClick: () => runAction(id),
      }, ICON[id](), extra.dot ? h('span', { className: 'kzh-dot', 'aria-hidden': true }) : null)
      const item = (id, count) => ({ id, keys: bindings[id], count })
      return h('div', { className: 'kzh-bar' },
        btn('terminal'),
        btn('background', { dot: running > 0, label: running ? `Background tasks, ${running} running` : 'Background tasks' }),
        btn('browser', { pressed: kind === BROWSER_KIND }),
        btn('jev-inspector', { pressed: kind === KIND }),
        h('button', {
          ref: more, type: 'button', className: 'kzh-ib', 'aria-label': 'More', title: 'More', 'aria-haspopup': 'menu', 'aria-expanded': menu,
          onClick: () => setMenu((m) => !m),
        }, ICON.more()),
        menu ? h(MoreMenu, {
          anchor: more,
          onClose: (refocus) => { setMenu(false); if (refocus) more.current?.focus() },
          items: [item('files'), item('background', running), item('browser'), item('terminal'), item('jev-inspector'), item('usage'), '-',
            item('left-sidebar'), item('focus-mode'), item('new-session'), item('focus-input'), '-', item('shortcuts'), item('jev-setup')],
        }) : null)
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

    // ---------- brand: Kz-harness logo in the sidebar and above the new-session headline ----------
    const LOGO = '/jev-router/logo.png'
    const BrandMark = ({ size = 24 }) => h('img', { src: LOGO, width: size, height: size, alt: '', style: { display: 'block', borderRadius: 6 } })
    const BrandName = () => h('span', { style: { font: 'var(--dsw-font-s-strong-14)', color: 'var(--dsw-alias-label-primary)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' } }, 'Kz-harness')
    const HeroMark = ({ size = 40, className }) => h('img', { src: LOGO, width: size, height: size, alt: 'Kz-harness', className, style: { display: 'block' } })

    return {
      inject: ['slots', 'sidebarRightTabs', 'sessions', 'sidebarRight', 'layout'],
      apply(ctx) {
        sessionsApi = ctx.sessions
        sidebarRight = ctx.sidebarRight
        layout = ctx.layout
        uiWorkspace = ctx.get('uiWorkspace') // optional: New session falls back to DSH's own button
        loadHotkeys()
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
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'kz-launcher', order: 100 }, HeaderActions))
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'kz-shortcuts', order: 16, label: () => 'Shortcuts' }, ShortcutsSection))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kz-toast' }, Toast))
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
