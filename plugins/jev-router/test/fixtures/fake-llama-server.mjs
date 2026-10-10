// A stand-in for llama.cpp's llama-server as local.js drives it (docs/benchmark.md 5.1), with no
// process and no port, shared by the speed benchmark's tests and those of a local model's chat:
//   - `spawn` hands local.js a child that prints `report()` as its load report when its /health is
//     first asked, as llama-server writes it on stderr before it answers, and exits when killed.
//     Its pid, 2147483647, is one no process can have, since the Windows stop path calls taskkill on it;
//   - `fetch` answers /health, and /tokenize and /completion as llama-server does: /tokenize gives
//     `tokens(model)` token ids, and /completion keeps its one slot's prompt cache, so a prompt of
//     token ids that starts with the cached one reads only its last token again, and answers with a
//     `timings` object worked out from `speed(model)` ({ generate, read } in tokens a second), which
//     `timings(entry, worked)` may replace for one request; a request with `stream` is answered as
//     llama-server streams, events ending in one with `stop` and the timings, and one without is
//     answered HTTP 500 when `parserRefuses(entry)`, as llama-server's chat output parser does; a
//     greedy request (top_k 1, the speed run's output check) gets `greedy(entry)`'s text when it is
//     given, streamed a word an event, each with a token id of its own as b10964 sends them, or none
//     with `{ text, ids: false }`, and `{ error }` answers it HTTP 500 with that message;
//   - `/v1/chat/completions` streams a chat answer as llama-server does, a chunk an event and then
//     [DONE]: `chat(entry)` says what (`reasoning`, `content`, `toolCalls` of { id, name, arguments },
//     `finish` and `usage`; a short text answer without it) and how, Strata's paced fakes injecting
//     faults (serve/server.py MockEngine): `paceMs` between events, `quiet` ({ after, ms }, or a list
//     of them) a pause after that many events, as a model that thinks before it speaks, and `cut`
//     ({ after }) a stream that stops after that many events with no finish_reason and no [DONE],
//     closed cleanly (a server that dies breaks its connection off instead, which fetch's body reads
//     as an error); an answer aborted mid-stream stops with its signal's reason;
//   - /v1/models answers as b10964 does, only with the start's key and naming its --alias, and each
//     such check is kept in `probes` rather than with the requests; `refuses(port)` true has an engine
//     started on that port say it could not bind it and exit, never answering there, and
//     `stranger(port)` a function answers every request to that port in its place, as another
//     program holding the port would;
//   - every request is kept, with its path, headers, body, the model loaded and the engine's key;
//     `hold(match)` holds the next request it picks until the function it returns is called, and a
//     held request that is aborted rejects with its signal's reason, as fetch does; `healthy(run)`
//     false keeps an engine loading, answering /health with 503; each request aborted, held or
//     mid-stream, is logged in `aborts` with the events it had sent.
import { EventEmitter } from 'node:events'

export const FAKE_PID = 2147483647
/** The token id the stand-in gives a piece of greedy text: the same piece, the same id. */
export const tokenOf = (piece) => [...piece].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 1_000_003, 7)

/** What a /completion answered: its JSON body, or the last event of a streamed answer. */
export async function answerOf(response) {
  const text = await response.text()
  if (!/event-stream/.test(response.headers.get('content-type') ?? '')) return JSON.parse(text)
  return JSON.parse(text.split('\n').filter((l) => l.startsWith('data: ')).at(-1).slice(6))
}

/**
 * A chat answer as llama-server streams it, its OpenAI chunk events in order: the reasoning and the
 * text a word an event, each tool call's name and then its arguments, the finish_reason, and the usage.
 */
export function chatEvents({ reasoning = '', content = '', toolCalls = [], finish = toolCalls.length ? 'tool_calls' : 'stop', usage = { prompt_tokens: 100, completion_tokens: 20 } } = {}) {
  const chunk = (delta, finishReason = null) => ({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: finishReason }] })
  const words = (text) => text.match(/\S+\s*|\s+/g) ?? []
  return [
    ...words(reasoning).map((w) => chunk({ reasoning_content: w })),
    ...words(content).map((w) => chunk({ content: w })),
    ...toolCalls.flatMap((c, index) => [
      chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }),
      ...words(c.arguments ?? '{}').map((w) => chunk({ tool_calls: [{ index, function: { arguments: w } }] })),
    ]),
    chunk({}, finish),
    { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'fake', choices: [], usage: { ...usage, total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) } },
  ]
}

export function fakeLlamaServer({ report = () => [], tokens = () => 20_000, speed = () => ({ generate: 20, read: 400 }), timings = null, onRequest = null, healthy = () => true, parserRefuses = () => false, chat = null, refuses = () => false, stranger = () => null, greedy = null } = {}) {
  const started = []
  const requests = []
  const probes = []
  const holds = []
  const aborts = []
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const argOf = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

  const spawn = (cmd, args, opts = {}) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, pid: FAKE_PID })
    const exit = (code) => { child.exitCode = code; child.emit('exit', code); child.emit('close', code) }
    child.kill = () => { if (child.exitCode === null) exit(0) }
    const port = Number(argOf(args, '--port'))
    started.push({ cmd, args, key: opts.env?.LLAMA_API_KEY ?? null, child, model: argOf(args, '--alias'), port, ctx: Number(argOf(args, '-c')), threads: Number(argOf(args, '-t')), reported: false, healthy: false, cache: [], refused: refuses(port) })
    // A port another program holds: llama-server says so as it binds, before it loads anything, and exits.
    if (started.at(-1).refused) setImmediate(() => { child.stderr.emit('data', `srv          start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: ${port}\n`); exit(1) })
    return child
  }
  const current = () => started.findLast((s) => s.child.exitCode === null && !s.refused) ?? null

  const waitFor = (gate, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => reject(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    gate.then(() => { signal?.removeEventListener('abort', abort); resolve() })
  })

  const fetch = async (url, init = {}) => {
    const { pathname: path, port } = new URL(String(url))
    const other = stranger(Number(port))
    if (other) return other(path, init)
    const run = current()
    if (path === '/health') {
      if (!run) throw new TypeError('fetch failed: connection refused')
      // Still loading: llama-server answers /health with 503 until its model is in memory.
      if (!healthy(run)) return json({ error: { code: 503, message: 'Loading model' } }, 503)
      if (!run.reported) { run.reported = true; for (const l of report(run)) run.child.stderr.emit('data', `${l}\n`) }
      run.healthy = true
      return json({ status: 'ok' })
    }
    if (path === '/v1/models') {
      if (!run) throw new TypeError('fetch failed: connection refused')
      probes.push({ port: run.port, authorization: init.headers?.authorization ?? null, key: run.key })
      if (!healthy(run)) return json({ error: { code: 503, message: 'Loading model' } }, 503)
      if (init.headers?.authorization !== `Bearer ${run.key}`) return json({ error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' } }, 401)
      return json({ object: 'list', data: [{ id: run.model, aliases: [run.model], object: 'model', owned_by: 'llamacpp' }] })
    }
    const body = init.body ? JSON.parse(init.body) : null
    const entry = { path, headers: { ...init.headers }, body, model: run?.model ?? null, key: run?.key ?? null, at: Date.now() }
    requests.push(entry)
    onRequest?.(entry)
    const i = holds.findIndex((h) => h.match(entry))
    if (i >= 0) {
      const [h] = holds.splice(i, 1)
      h.arrived(entry)
      try { await waitFor(h.gate, init.signal) } catch (err) { aborts.push({ path, model: entry.model, sent: 0 }); throw err }
    }
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
      // As llama-server times it: the first token comes out of the prompt pass, and predicted_ms is the other n - 1.
      const worked = { prompt_n: promptN, prompt_ms: (promptN / read) * 1000, predicted_n: body.n_predict, predicted_ms: (Math.max(0, body.n_predict - 1) / generate) * 1000 }
      const t = timings ? timings(entry, worked) : worked
      // The output check's greedy request, answered with the text given for it, a word an event.
      const said = greedy && body.top_k === 1 ? greedy(entry) : null
      if (said?.error) return json({ error: { code: 500, message: said.error, type: 'server_error' } }, 500)
      if (said != null) {
        const { text, ids = true } = typeof said === 'string' ? { text: said } : said
        const pieces = String(text).match(/\S+\s*|\s+/g) ?? []
        const events = [...pieces.map((piece) => ({ index: 0, content: piece, ...(ids && { tokens: [tokenOf(piece)] }), stop: false })), { index: 0, content: '', ...(ids && { tokens: [] }), stop: true, tokens_predicted: pieces.length, ...(t === undefined ? {} : { timings: t }) }]
        return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const content = 'x'.repeat(Math.max(0, body.n_predict))
      // What llama-server b10964 does with text cut inside its last character, which its chat output
      // parser refuses: an answer that is not streamed comes back HTTP 500, and a streamed one holds
      // the cut character back and ends with its timings all the same.
      if (!body.stream && parserRefuses(entry)) return json({ error: { code: 500, message: 'The model produced output that does not match the expected Content-only format', type: 'server_error' } }, 500)
      if (!body.stream) return json({ content, ...(t === undefined ? {} : { timings: t }) })
      // Streamed: an event per piece of text, then the last one, with stop and the timings.
      const events = [...(content ? [{ index: 0, content, stop: false }] : []), { index: 0, content: '', stop: true, tokens_predicted: body.n_predict, ...(t === undefined ? {} : { timings: t }) }]
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (path === '/v1/chat/completions') {
      const said = chat?.(entry) ?? { content: 'Done.' }
      return new Response(paced(chatEvents(said), said, init.signal, (sent) => aborts.push({ path, model: entry.model, sent })), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return json({ error: 'not found' }, 404)
  }

  /**
   * The events as a body that streams them `paceMs` apart, pauses where `quiet` says, stops without a
   * word where `cut` says, and ends in [DONE]; an abort of `signal` stops it with its reason, as fetch's
   * body does, and `aborted(sent)` hears how many events had gone.
   */
  function paced(events, { paceMs = 0, quiet = [], cut = null }, signal, aborted) {
    const enc = new TextEncoder()
    const pauses = [quiet ?? []].flat()
    let sent = 0
    let timer = null
    let stop = null
    return new ReadableStream({
      start(c) {
        stop = () => { clearTimeout(timer); aborted(sent); c.error(signal.reason) }
        if (signal?.aborted) return stop()
        signal?.addEventListener('abort', stop, { once: true })
        const end = (last) => { signal?.removeEventListener('abort', stop); if (last) c.enqueue(enc.encode(last)); c.close() }
        const next = () => {
          if (cut && sent >= cut.after) return end(null)
          if (sent === events.length) return end('data: [DONE]\n\n')
          c.enqueue(enc.encode(`data: ${JSON.stringify(events[sent++])}\n\n`))
          const pause = pauses.filter((q) => q.after === sent).reduce((t, q) => t + q.ms, 0)
          timer = setTimeout(next, paceMs + pause)
        }
        next()
      },
      cancel() { clearTimeout(timer); signal?.removeEventListener('abort', stop) },
    })
  }

  return {
    started,
    requests,
    probes,
    aborts,
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

/**
 * A stand-in for the host a model or engine file is downloaded from (Hugging Face, GitHub releases),
 * for downloadVerified: it serves `data` with Range and Content-Range as they do, and each request
 * goes as the next entry of `plan` says, one entry a request: `{ cutAfter: n }` sends n bytes and
 * then breaks the connection off, as a dropped Wi-Fi does, which fetch's body reads as an error;
 * `{ status }` answers that status alone; `{ stall: true }` sends its headers and then nothing until
 * the request is aborted; `{ ignoreRange: true }` answers 200 with the whole file; `{ from: n }`
 * answers 206 with the file from byte n, whatever was asked. A request past the plan is served as
 * asked. Every request's Range header is kept in `ranges`.
 */
export function fakeDownload(data, plan = []) {
  const ranges = []
  const fetch = async (url, init = {}) => {
    const range = init.headers?.range ?? null
    const step = plan[ranges.length] ?? {}
    ranges.push(range)
    init.signal?.throwIfAborted()
    if (step.status) return new Response(null, { status: step.status })
    const asked = range && !step.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0
    const from = step.from ?? asked
    const body = data.subarray(from, step.cutAfter == null ? undefined : from + step.cutAfter)
    const headers = { 'accept-ranges': 'bytes', 'content-length': String(data.length - from) }
    if (from || (range && !step.ignoreRange)) headers['content-range'] = `bytes ${from}-${data.length - 1}/${data.length}`
    // The bytes go out on one pull and the break or the end on the next, since an error drops what is still queued.
    let sent = false
    const stream = new ReadableStream({
      start(c) {
        if (!step.stall) return
        const stop = () => c.error(init.signal.reason)
        if (init.signal?.aborted) stop()
        else init.signal?.addEventListener('abort', stop, { once: true })
      },
      pull(c) {
        if (step.stall) return new Promise(() => {})
        if (!sent && body.length) { sent = true; c.enqueue(new Uint8Array(body)); return }
        if (step.cutAfter != null) c.error(new TypeError('terminated', { cause: new Error('other side closed') }))
        else c.close()
      },
    })
    return new Response(stream, { status: from || (range && !step.ignoreRange) ? 206 : 200, headers })
  }
  return { fetch, ranges }
}
