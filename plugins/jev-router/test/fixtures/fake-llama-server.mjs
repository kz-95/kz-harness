// A stand-in for llama.cpp's llama-server as local.js drives it (docs/benchmark.md 5.1), with no
// process and no port, shared by the speed benchmark's tests:
//   - `spawn` hands local.js a child that prints `report()` as its load report when its /health is
//     first asked, as llama-server writes it on stderr before it answers, and exits when killed.
//     Its pid, 2147483647, is one no process can have, since the Windows stop path calls taskkill on it;
//   - `fetch` answers /health, and /tokenize and /completion as llama-server does: /tokenize gives
//     `tokens(model)` token ids, and /completion keeps its one slot's prompt cache, so a prompt of
//     token ids that starts with the cached one reads only its last token again, and answers with a
//     `timings` object worked out from `speed(model)` ({ generate, read } in tokens a second), which
//     `timings(entry, worked)` may replace for one request;
//   - every request is kept, with its path, headers, body, the model loaded and the engine's key;
//     `hold(match)` holds the next request it picks until the function it returns is called, and a
//     held request that is aborted rejects with its signal's reason, as fetch does; `healthy(run)`
//     false keeps an engine loading, answering /health with 503.
import { EventEmitter } from 'node:events'

export const FAKE_PID = 2147483647

export function fakeLlamaServer({ report = () => [], tokens = () => 20_000, speed = () => ({ generate: 20, read: 400 }), timings = null, onRequest = null, healthy = () => true } = {}) {
  const started = []
  const requests = []
  const holds = []
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const argOf = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

  const spawn = (cmd, args, opts = {}) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, pid: FAKE_PID })
    child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0) } }
    started.push({ cmd, args, key: opts.env?.LLAMA_API_KEY ?? null, child, model: argOf(args, '--alias'), ctx: Number(argOf(args, '-c')), threads: Number(argOf(args, '-t')), reported: false, healthy: false, cache: [] })
    return child
  }
  const current = () => started.findLast((s) => s.child.exitCode === null) ?? null

  const waitFor = (gate, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => reject(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    gate.then(() => { signal?.removeEventListener('abort', abort); resolve() })
  })

  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    const run = current()
    if (path === '/health') {
      if (!run) throw new TypeError('fetch failed: connection refused')
      // Still loading: llama-server answers /health with 503 until its model is in memory.
      if (!healthy(run)) return json({ error: { code: 503, message: 'Loading model' } }, 503)
      if (!run.reported) { run.reported = true; for (const l of report(run)) run.child.stderr.emit('data', `${l}\n`) }
      run.healthy = true
      return json({ status: 'ok' })
    }
    const body = init.body ? JSON.parse(init.body) : null
    const entry = { path, headers: { ...init.headers }, body, model: run?.model ?? null, key: run?.key ?? null, at: Date.now() }
    requests.push(entry)
    onRequest?.(entry)
    const i = holds.findIndex((h) => h.match(entry))
    if (i >= 0) { const [h] = holds.splice(i, 1); h.arrived(entry); await waitFor(h.gate, init.signal) }
    init.signal?.throwIfAborted()
    // What the engine that was asked answers with: none, once it has exited.
    if (!run || run.child.exitCode !== null) throw new TypeError('fetch failed: connection refused')
    if (entry.headers.authorization !== `Bearer ${run.key}`) return json({ error: { code: 401, message: 'Invalid API Key' } }, 401)
    if (path === '/tokenize') return json({ tokens: Array.from({ length: tokens(run.model) }, (_, n) => 1000 + n) })
    if (path === '/completion') {
      const prompt = Array.isArray(body.prompt) ? body.prompt : String(body.prompt).split(/\s+/).map((_, n) => n + 1)
      const cached = Array.isArray(body.prompt) && body.cache_prompt && run.cache.length > 0 && run.cache.length <= prompt.length && run.cache.every((t, n) => t === prompt[n])
      // One slot: a prompt read from the cache is read again from its last token, as llama-server does.
      const promptN = cached ? Math.max(1, prompt.length - run.cache.length + 1) : prompt.length
      run.cache = body.cache_prompt ? prompt : []
      const { generate, read } = speed(run.model)
      const worked = { prompt_n: promptN, prompt_ms: (promptN / read) * 1000, predicted_n: body.n_predict, predicted_ms: (body.n_predict / generate) * 1000 }
      const t = timings ? timings(entry, worked) : worked
      return json({ content: 'x'.repeat(Math.max(0, body.n_predict)), ...(t === undefined ? {} : { timings: t }) })
    }
    return json({ error: 'not found' }, 404)
  }

  return {
    started,
    requests,
    spawn,
    fetch,
    /** The requests to `path`, oldest first. */
    to: (path) => requests.filter((r) => r.path === path),
    /**
     * Hold the next request that `match` (a path, or a function of the request) picks until the
     * returned `release()` is called. `arrived` resolves with the request once it has come in.
     */
    hold(match) {
      let release
      let arrived
      const gate = new Promise((r) => { release = r })
      const seen = new Promise((r) => { arrived = r })
      holds.push({ match: typeof match === 'function' ? match : (e) => e.path === match, gate, arrived })
      return { release, arrived: seen }
    },
  }
}
