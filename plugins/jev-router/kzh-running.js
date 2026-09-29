// Whether KzH is running on this PC, and in what form, for the tools that must not run beside it:
// the speed run from a shell (scripts/speed-run.mjs) and the Laya command line (laya/install-cli.mjs).
// KzH is its app (Kz-harness.exe, quit from its tray icon: closing its window leaves it running), or
// its engine with no app above it (in a Start-KzH window, or left behind by an app that is gone),
// or, when neither can be seen, whatever answers on its port and cannot be told from it.
import { spawnSync } from 'node:child_process'
import { connect } from 'node:net'

/** Where KzH serves its app (Start-KzH.ps1, app/main.js). */
export const KZH_PORT = 3080

/** Whether something accepts a connection on 127.0.0.1:`port`, within `timeoutMs`. */
export function portAnswers(port, { host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  return new Promise((done) => {
    const socket = connect({ host, port })
    const end = (open) => { socket.destroy(); done(open) }
    socket.setTimeout(timeoutMs, () => end(false))
    socket.once('connect', () => end(true))
    socket.once('error', () => end(false))
  })
}

/**
 * Every process running now as `{ pid, name, cmd }`, or null when they cannot be listed. On
 * Windows the command lines come from CIM, which tells KzH's engine from any other node, and are
 * empty for a process this one may not read (one run as administrator, say); with no PowerShell,
 * tasklist gives the names alone (`cmd` null).
 */
export function processList({ platform = process.platform, run = spawnSync } = {}) {
  if (platform === 'win32') {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    if (r?.status === 0 && typeof r.stdout === 'string' && r.stdout.includes('|')) {
      return r.stdout.split(/\r?\n/).map((l) => /^(\d+)\|([^|]*)\|(.*)$/.exec(l)).filter(Boolean).map(([, pid, name, cmd]) => ({ pid: Number(pid), name: name.trim(), cmd: cmd.trim() }))
    }
    const t = run('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    if (t?.status !== 0 || typeof t.stdout !== 'string') return null
    return t.stdout.split(/\r?\n/).map((l) => /^"([^"]*)","(\d+)"/.exec(l)).filter(Boolean).map(([, name, pid]) => ({ pid: Number(pid), name, cmd: null }))
  }
  const r = run('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' })
  if (r?.status !== 0 || typeof r.stdout !== 'string') return null
  return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(([, pid, cmd]) => ({ pid: Number(pid), name: cmd.trim().split(/\s+/)[0].split('/').pop(), cmd: cmd.trim() }))
}

/**
 * The pid listening on 127.0.0.1:`port`, or null when it cannot be found: netstat on Windows (a
 * listening socket's far end is 0.0.0.0:0 or [::]:0 whatever language Windows speaks), ss elsewhere.
 */
export function portOwner(port, { platform = process.platform, run = spawnSync } = {}) {
  if (platform === 'win32') {
    const r = run('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    if (r?.status !== 0 || typeof r.stdout !== 'string') return null
    for (const line of r.stdout.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/)
      if (f.length >= 5 && /^TCP$/i.test(f[0]) && f[1].endsWith(`:${port}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(f[2]) && Number(f.at(-1)) > 0) return Number(f.at(-1))
    }
    return null
  }
  const r = run('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
  const pid = r?.status === 0 && typeof r.stdout === 'string' ? /pid=(\d+)/.exec(r.stdout)?.[1] : null
  return pid ? Number(pid) : null
}

/**
 * Whether a command line is KzH's engine: node running the @deepseek-ai/dsh package with `web` as
 * its own argument, as Start-KzH.ps1 starts it and app/main.js's isEngineCommand reads it.
 */
export const isKzhEngine = (cmd) => /\bnode(\.exe)?\b/i.test(cmd ?? '') && /@deepseek-ai[\\/]dsh\b/i.test(cmd ?? '') && /(?:^|\s)web(?:\s|$)/i.test(cmd ?? '')

/**
 * What of KzH runs now, from the process list and whatever answers on its port:
 *   { app }      Kz-harness.exe runs (with its engine or not);
 *   { engine }   its engine runs with no app above it: the process that listens on the port when
 *                that is one of them, else the engine itself rather than the npx wrapper that
 *                Start-KzH.ps1's npx start puts above it, since ending the wrapper leaves it running,
 *                and the wrapper only while it is all there is (npx still resolving the package);
 *   { unknown }  something answers on the port and cannot be told from KzH: a node whose command
 *                line cannot be read (run as administrator, or listed by name alone), a pid missing
 *                from the list, or an owner that cannot be found while such a node runs or no list
 *                could be read (`unknown` says who, `pid` is its pid or null, `candidates` the nodes
 *                that could be the engine, never `self`, the process asking; stopUnknown() says how
 *                to stop it);
 *   { other }    a program that is not KzH answers on the port: its command line says so, or its
 *                name does, since KzH's engine is always node, or its pid cannot be found while no
 *                process that could be the engine runs (`other.name` and `other.pid` then null);
 *                otherNote() says so;
 *   {}           nothing of KzH, and nothing on its port.
 * `list` (the processes, or null) comes with each, for the checks that follow.
 */
export async function kzhRunning({ port = KZH_PORT, answers = portAnswers, processes = processList, owner = portOwner, self = process.pid } = {}) {
  const list = await processes()
  const app = list?.find((p) => /^kz-harness(\.exe)?$/i.test(p.name))
  if (app) return { list, app }
  const engines = list?.filter((p) => isKzhEngine(p.cmd)) ?? []
  const listening = await answers(port)
  const pid = listening ? await owner(port) : null
  const holder = pid ? list?.find((p) => p.pid === pid) ?? null : null
  if (engines.length) return { list, engine: engines.find((p) => p === holder) ?? engines.find((p) => !/npx-cli\.js/i.test(p.cmd)) ?? engines[0] }
  if (!listening) return { list }
  if (holder && (holder.cmd || !isNode(holder.name))) return { list, other: holder }
  // The tool asking (the speed run, the Laya command line) is a node too, never the engine.
  const candidates = list?.filter((p) => p.pid !== self && isNode(p.name) && !p.cmd) ?? null
  if (!pid && candidates && !candidates.length) return { list, other: { name: null, pid: null } }
  const unknown = holder
    ? `${holder.name}, pid ${pid}, whose command line ${holder.cmd === null ? 'could not be listed' : 'cannot be read (it may run as administrator)'}`
    : pid ? `pid ${pid}, which cannot be looked up` : 'a program that cannot be found'
  return { list, unknown, pid, candidates }
}

/** Whether a process name is node's, as KzH's engine's always is. */
const isNode = (name) => /^node(\.exe)?$/i.test(name ?? '')

/**
 * How to stop what kzhRunning() found on the port and could not tell from KzH (`unknown`), in
 * sentences, `kzh` being the name the caller uses (KzH, Kz-harness). A process list that was read
 * has no Kz-harness.exe in it, so there is no tray icon to quit from: KzH there is an engine in a
 * Start-KzH window or one left behind, most likely run as administrator, whose command line reads
 * empty. Only with no list at all may it be the app.
 */
export function stopUnknown({ list, pid, candidates }, kzh = 'KzH') {
  const inTaskManager = (which) => `end it in Task Manager (Details, right-click ${which}, End process tree; run Task Manager as administrator if it says access is denied)`
  if (!list) return `If it is Kz-harness, quit it (${QUIT_APP}) or close its Start-KzH window. If it is another program, close it`
  if (pid) return `No Kz-harness app is running. If pid ${pid} is another program, close it. If it is ${kzh}'s engine, close the Start-KzH window it runs in, or, with no such window open, ${inTaskManager(`pid ${pid}`)}`
  const pids = (candidates ?? []).map((p) => p.pid)
  return `No Kz-harness app is running. If it is ${kzh}'s engine (node.exe, pid ${pids.join(' or ')}), close the Start-KzH window it runs in, or, with no such window open, ${inTaskManager('its pid')}. If it is another program, close it`
}

/** The note for a program on the port that is not KzH (kzhRunning's `other`), `what` going ahead. */
export function otherNote({ other }, { port = KZH_PORT, kzh = 'KzH', what }) {
  return other.pid
    ? `Another program answers on 127.0.0.1:${port} (${other.name}, pid ${other.pid}); it is not ${kzh}'s engine, so ${what} goes ahead.`
    : `Something answers on 127.0.0.1:${port} whose pid could not be found; no process that could be ${kzh}'s engine runs, so ${what} goes ahead.`
}

/** How to stop KzH's app: its window's X only hides it in the tray. */
export const QUIT_APP = 'right-click its tray icon and choose Quit; closing its window leaves it running'

/** How to stop an engine with no app above it: its Start-KzH window, or the engine itself. */
export const stopEngine = (pid) => `close the Start-KzH window it runs in, or, if no such window is open, end it in Task Manager (Details, right-click pid ${pid}, End process tree)`
