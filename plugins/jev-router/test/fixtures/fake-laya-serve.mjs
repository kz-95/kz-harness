// A stand-in for the official `python -m laya.serve` (Laya 0.3.20), shared by every group's tests
// (docs/laya-auto.md 9.2). It behaves like the real server where KzH depends on it:
//   - the port answers only once the model has "loaded" (`loadMs`), since laya.serve preloads
//     before uvicorn binds, and `GET /health` reports `loaded` and echoes the device it was given;
//   - `POST /v1/systemone` checks the bearer key, refuses more than 64 questions (413), refuses a
//     malformed question, `labels` on a non-noul or a bad label map included, with laya/agent.py's
//     own 422 text naming the question, runs one request at a time behind one lock, takes
//     `rows x msPerRow`, keeps computing when the client disconnects, exactly as the one-worker
//     executor does, and answers an exception in the model with a bare 500;
//   - answers have Laya's shape and rounding, and `usage.input_tokens` follows a stated formula
//     so a client's context-limit accounting can be tested.
// It never runs a model: `answer(name, question, state)` gives each question's probabilities in
// option order (a noul's are [false, true]), by default deterministic from a hash.
//
// Run as a script (`node fake-laya-serve.mjs [interpreter args ignored]`) it reads laya.serve's own
// environment (LAYA_HOST, LAYA_PORT, LAYA_API_KEY, LAYA_MODELS, LAYA_DEVICE) and FAKE_LAYA_LOAD_MS,
// FAKE_LAYA_MS_PER_ROW, FAKE_LAYA_EXIT_AFTER_MS and FAKE_LAYA_PRINT (a comma list of no-cuda,
// cpu-fallback, gpu-oom, temps), which print Laya's own warning lines verbatim, so the sidecar tests
// can spawn it as the interpreter.
import { realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const MAX_QUESTIONS = 64
const MAX_STATE_CHARS = 50000
const CONTEXT_TOKENS = 512
const KNOWN_MODELS = ['english', 'multilingual', 'typed-decisions']
const TYPES = ['choice', 'score', 'noul']
const round4 = (x) => Math.round(x * 1e4) / 1e4

// --- Laya's rendering, as laya/common.py does it -----------------------------------------------

/** Python's json.dumps(v, ensure_ascii=False, separators=(', ', ': ')). */
function pyJson(v) {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ')}}`
  return JSON.stringify(v) ?? 'null'
}
const criterion = (v) => (typeof v === 'string' ? v : pyJson(v))

/** Option texts in label-index order (`render_options`); a noul is always [false, true]. */
export function renderOptions(q) {
  const crit = q.criteria
  if (q.type === 'choice') {
    const entries = Array.isArray(crit) ? crit.map((k) => [k, null]) : Object.entries(crit)
    return entries.map(([k, v]) => (v == null || v === '' ? String(k) : `${k}: ${criterion(v)}`))
  }
  if (q.type === 'score') return crit.map((c, i) => `level ${i}: ${criterion(c)}`)
  const labels = q.labels ?? { false: 'false', true: 'true' }
  const c = Object.fromEntries(Object.entries(crit ?? {}).map(([k, v]) => [String(k).toLowerCase(), v]))
  return [
    `${labels.false.trim()}: ${c.false == null || c.false === '' ? 'no, the statement does not hold' : criterion(c.false)}`,
    `${labels.true.trim()}: ${c.true == null || c.true === '' ? 'yes, the statement holds' : criterion(c.true)}`,
  ]
}

/** Python's repr() of a string: single quotes unless it holds one and no double quote, escapes as Python writes them. */
function pyStr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    const named = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[ch]
    if (named) out += named
    else if (ch === quote) out += `\\${quote}`
    // What str.isprintable() rejects: every control, format, private or unassigned character and
    // every separator but the space.
    else if (ch !== ' ' && /^[\p{C}\p{Z}]$/u.test(ch)) out += c <= 0xff ? `\\x${c.toString(16).padStart(2, '0')}` : c <= 0xffff ? `\\u${c.toString(16).padStart(4, '0')}` : `\\U${c.toString(16).padStart(8, '0')}`
    else out += ch
  }
  return `${quote}${out}${quote}`
}

/** Python's repr() of a parsed JSON value, as `%r` prints it (numbers as JavaScript prints them). */
function pyRepr(v) {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'string') return pyStr(v)
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${pyStr(k)}: ${pyRepr(x)}`).join(', ')}}`
  return String(v)
}

/** The name of a parsed JSON value's Python type, as `type(v).__name__` gives it. */
const pyType = (v) => (v === null ? 'NoneType' : Array.isArray(v) ? 'list' : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool'
  : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : 'dict')
const isDict = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Why Laya would refuse this question, or null: `Agent._check_question` in laya/agent.py 0.3.20,
 * its messages word for word, in its order. laya.serve answers each with 422 and the message.
 */
function refusal(id, q) {
  const name = `question ${pyStr(id)}`
  if (!isDict(q)) return `${name}: definition must be a dict, got ${pyType(q)}`
  // `t not in QTYPES` raises TypeError for a list or a dict, which laya.serve answers with a bare 500.
  if (q.type && typeof q.type === 'object') throw new TypeError(`unhashable type: '${pyType(q.type)}'`)
  if (!TYPES.includes(q.type)) return `${name}: unknown type ${pyRepr(q.type)}; use one of ['choice', 'noul', 'score']`
  if (!('instructions' in q)) return `${name}: no 'instructions'; add the text the model should answer`
  const crit = q.criteria
  if (q.type === 'choice') {
    if (!crit || typeof crit !== 'object') return `${name}: a choice question takes 'criteria' as a dict of label -> description, or a list of labels`
    if (!Object.keys(crit).length) return `${name}: a choice question needs at least one criterion`
  } else if (q.type === 'score') {
    if (!Array.isArray(crit)) return `${name}: a score question takes 'criteria' as a list of level descriptions, index 0 first`
    if (!crit.length) return `${name}: a score question needs at least one level`
  } else if (crit != null && !isDict(crit)) {
    return `${name}: a noul question takes 'criteria' as a dict with optional 'true'/'false' descriptions, or omits it`
  } else if (isDict(crit)) {
    const keys = [...new Set(Object.keys(crit).map((k) => k.toLowerCase()))].sort()
    if (!keys.every((k) => k === 'true' || k === 'false')) {
      return `${name}: a noul question takes 'criteria' keyed only 'true'/'false' (either or both, and omitted is fine), got ${pyRepr(keys)}. `
        + "Those keys are the option texts the model reads; any other key was silently dropped and replaced with the defaults. "
        + "If you want the answer worded differently, keep 'criteria' keyed 'true'/'false' and set 'labels' instead."
    }
  }
  if ('labels' in q) {
    if (q.type !== 'noul') return `${name}: 'labels' is only supported for noul questions`
    // `labels: null` is Laya's default pair (`_resolve_noul_labels(None)`), not a refusal.
    const l = q.labels
    const ok = l === null || (isDict(l) && Object.keys(l).sort().join() === 'false,true'
      && typeof l.false === 'string' && typeof l.true === 'string' && l.false.trim() && l.true.trim() && l.false.trim() !== l.true.trim())
    if (!ok) return `${name}: noul labels must map exactly 'false' and 'true' to distinct non-empty strings`
  }
  return null
}

/**
 * The input tokens Laya would report for one request, by a stated formula: per question row
 * `min(512, ceil(head chars / 3.6) + ceil(state chars / 3.0))`, where head chars are the
 * instruction and every option text, and state chars the state as sent (compact JSON).
 */
export function inputTokens(state, questions) {
  const s = Math.ceil((typeof state === 'string' ? state.length : (JSON.stringify(state ?? null) ?? '').length) / 3.0)
  return Object.values(questions).reduce((n, q) => {
    const ins = typeof q.instructions === 'string' ? q.instructions : pyJson(q.instructions ?? null)
    const head = ins.length + renderOptions(q).reduce((m, o) => m + o.length, 0)
    return n + Math.min(CONTEXT_TOKENS, Math.ceil(head / 3.6) + s)
  }, 0)
}

// --- answers -------------------------------------------------------------------------------------

/** FNV-1a over a string: a stable seed per question and state. */
function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}

/** Probabilities in option order, deterministic from the question and the state. */
export function defaultAnswer(name, question, state) {
  let x = hash(`${name}\n${JSON.stringify(question)}\n${JSON.stringify(state)}`) || 1
  const k = renderOptions(question).length
  const logits = Array.from({ length: k }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return (x / 0xffffffff) * 3 - 1.5 })
  const top = Math.max(...logits)
  const e = logits.map((z) => Math.exp(z - top))
  const sum = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / sum)
}

const entropyConfidence = (p) => {
  if (p.length < 2) return 1
  const h = -p.reduce((s, x) => s + x * Math.log(Math.max(x, 1e-12)), 0)
  return Math.min(1, Math.max(0, 1 - h / Math.log(p.length)))
}

/** One answer in Laya's shape (`Agent._decode_answers`), rounded to 4 decimals as Laya does. */
function toAnswer(q, p, act) {
  const top = Math.max(...p)
  const action = { act_probability: round4(act) }
  if (q.type === 'choice') {
    const keys = Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q.criteria)
    return {
      type: 'choice', choice: keys[p.indexOf(top)],
      probabilities: Object.fromEntries(keys.map((key, i) => [key, round4(p[i])])),
      confidence: round4(entropyConfidence(p)), answer_confidence: round4(top), action,
    }
  }
  if (q.type === 'score') {
    return {
      type: 'score', score: round4(p.reduce((s, x, i) => s + i * x, 0)),
      legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
      probabilities: Object.fromEntries(p.map((x, i) => [String(i), round4(x)])),
      confidence: round4(entropyConfidence(p)), answer_confidence: round4(top), action,
    }
  }
  return { type: 'noul', noul: round4(p[1]), confidence: round4(Math.max(p[1], 1 - p[1])), answer_confidence: round4(top), action }
}

// --- the server ----------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start a fake laya.serve. Resolves once it listens, which is `loadMs` after the call.
 * @returns {Promise<{ url: string, port: number, requests: object[], busy: () => boolean, close: () => Promise<void>,
 *   setMsPerRow: (n: number) => void, failNext: (status: 500|401|422) => void, hang: () => void }>}
 *   `requests` holds every parsed body (its fields at the top level, and the whole of it as `body`)
 *   with its `arrivedAt`, `startedAt` and `finishedAt` times (ms since the epoch), the response
 *   `status`, and the `authorization` header it came with.
 */
export async function startFakeLaya({
  host = '127.0.0.1', port = 0, apiKey, loadMs = 0, msPerRow = 0, answer = defaultAnswer, device = 'cpu',
  models = ['english'], onInference,
} = {}) {
  const requests = []
  let perRow = msPerRow
  const failures = []
  let hanging = false
  let working = false
  let closed = false
  let gate = Promise.resolve()
  // Every wait the server is in, so close() can end them instead of leaving timers behind.
  const waits = new Set()
  const wait = (ms) => new Promise((resolve) => {
    const w = { resolve, timer: ms === Infinity ? null : setTimeout(() => { waits.delete(w); resolve() }, ms) }
    waits.add(w)
  })

  const send = (res, status, body) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const infer = async (entry, res) => {
    const { body } = entry
    if (closed) return undefined
    entry.startedAt = Date.now()
    working = true
    try {
      const failure = failures[0] === 422 || failures[0] === 500 ? failures.shift() : null
      if (failure === 422) return send(res, entry.status = 422, { detail: `question '${Object.keys(body.questions)[0]}': refused by failNext(422)` })
      const bad = Object.entries(body.questions).map(([id, q]) => refusal(id, q)).find(Boolean)
      if (bad) return send(res, entry.status = 422, { detail: bad })
      onInference?.(entry)
      if (hanging) { hanging = false; await wait(Infinity); return undefined }
      const rows = Object.keys(body.questions).length
      await wait(rows * perRow)
      if (closed) return undefined
      const model = KNOWN_MODELS.includes(String(body.model ?? '').trim().toLowerCase()) ? String(body.model).trim().toLowerCase() : null
      if (failure === 500 || (model && !models.includes(model))) return send(res, entry.status = 500, { detail: 'inference failed' })
      const answers = {}
      for (const [id, q] of Object.entries(body.questions)) {
        const given = answer(id, q, body.state)
        const sum = Array.isArray(given) ? given.reduce((s, x) => s + x, 0) : 0
        if (!Array.isArray(given) || given.length !== renderOptions(q).length || given.some((x) => !(x >= 0)) || !(sum > 0)) {
          return send(res, entry.status = 500, { detail: 'inference failed' })
        }
        answers[id] = toAnswer(q, given.map((x) => x / sum), defaultAnswer(`${id}#act`, { type: 'noul' }, body.state)[1])
      }
      return send(res, entry.status = 200, {
        model: 'laya-rl-agent',
        answers,
        usage: { input_tokens: inputTokens(body.state, body.questions), output_tokens: 0 },
        routing: model ? { model, reason: `explicit model='${body.model}'` } : { model: 'english', reason: 'English Latin text' },
      })
    } catch {
      // Any other exception in the model (here, a throwing `answer` or `onInference`) is what
      // serve.py answers with a bare 500, so a test can drive a model error this way.
      return send(res, entry.status = 500, { detail: 'inference failed' })
    } finally {
      entry.finishedAt = Date.now()
      working = false
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake')
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', loaded: [...models], device })
    if (req.method !== 'POST' || url.pathname !== '/v1/systemone') return send(res, 404, { detail: 'Not Found' })
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { parsed = null }
      // The parsed body itself, as 9.2 has it (`requests[0].questions`), and whole under `body`,
      // with what the fake saw of it beside.
      const entry = {
        ...(isDict(parsed) ? parsed : {}),
        body: parsed, authorization: req.headers.authorization ?? null, arrivedAt: Date.now(), startedAt: null, finishedAt: null, status: null,
      }
      requests.push(entry)
      const finish = (status, detail) => { entry.status = status; entry.finishedAt = Date.now(); send(res, status, { detail }) }
      if (failures[0] === 401) { failures.shift(); return finish(401, 'invalid or missing bearer token') }
      if (apiKey != null && entry.authorization !== `Bearer ${apiKey}`) return finish(401, 'invalid or missing bearer token')
      const body = entry.body
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('questions' in body)) return finish(400, "request body must be an object with a 'questions' field")
      if (!body.questions || typeof body.questions !== 'object' || Array.isArray(body.questions)) return finish(400, "'questions' must be an object")
      const n = Object.keys(body.questions).length
      if (n > MAX_QUESTIONS) return finish(413, `too many questions (${n} > ${MAX_QUESTIONS})`)
      const stateLength = typeof body.state === 'string' ? body.state.length : String(JSON.stringify(body.state ?? null)).length
      if (stateLength > MAX_STATE_CHARS) return finish(413, `state too large (${stateLength} > ${MAX_STATE_CHARS} chars)`)
      // One worker: a request waits for the one before it, and a client that goes away does not
      // stop its own computation.
      const run = gate.then(() => infer(entry, res))
      gate = run.catch(() => {})
      return undefined
    })
    return undefined
  })

  if (loadMs > 0) await sleep(loadMs)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve() }) })
  const bound = server.address().port
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    requests,
    busy: () => working,
    setMsPerRow: (n) => { perRow = n },
    failNext: (status) => { failures.push(status) },
    hang: () => { hanging = true },
    close: () => new Promise((resolve) => {
      closed = true
      for (const w of waits) { clearTimeout(w.timer); w.resolve() }
      waits.clear()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

// --- run as the interpreter ----------------------------------------------------------------------

// Laya's own lines, verbatim (laya/agent.py 302, 431, 628; the RuntimeWarning from the English
// checkpoint's config as Python prints it on stderr).
const PRINTS = {
  'no-cuda': { out: 'Warning: CUDA requested but not available. Falling back to CPU.' },
  temps: {
    err: '/venv/lib/python3.12/site-packages/laya/router.py:260: RuntimeWarning: laya: this checkpoint ships invalid temperatures or values outside [0.5, 5]; using choice:11+=0.1006 -> 0.5. Treat confidence from the affected entries as uncalibrated.\n'
      + '  agent = Agent(repo, device=self.device, token=self.token, subfolder=sub)',
  },
  'cpu-fallback': {
    out: '\n[laya] Warning: could not place the model on cuda, so it is running on CPU.\n'
      + '  Reason: CUDA out of memory. Tried to allocate 64.00 MiB. GPU 0 has a total capacity of 4.00 GiB of which 12.00 MiB is free.\n'
      + '  Inference will be roughly 10-15x slower (~200-500 ms rather than ~35 ms).\n'
      + '  If this is a newer NVIDIA GPU (Blackwell / RTX 50-series), your PyTorch build\n'
      + '  may not support its CUDA architecture:\n'
      + '    pip install --pre torch --index-url https://download.pytorch.org/whl/nightly/cu128\n'
      + '  See https://pytorch.org/get-started/locally/',
  },
  'gpu-oom': { out: 'Warning: GPU memory exceeded during inference. Falling back to CPU...', atInference: true },
}

async function main() {
  const env = process.env
  const started = Date.now()
  const prints = String(env.FAKE_LAYA_PRINT ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  // In Laya's order: the device check, then the temperatures, then placing the model.
  for (const name of ['no-cuda', 'temps', 'cpu-fallback']) {
    if (!prints.includes(name)) continue
    if (PRINTS[name].out) process.stdout.write(`${PRINTS[name].out}\n`)
    if (PRINTS[name].err) process.stderr.write(`${PRINTS[name].err}\n`)
  }
  const exitAfter = Number(env.FAKE_LAYA_EXIT_AFTER_MS)
  if (exitAfter > 0) setTimeout(() => process.exit(1), Math.max(0, exitAfter - (Date.now() - started)))
  const port = Number(String(env.LAYA_PORT ?? '8000').trim())
  const host = env.LAYA_HOST || '0.0.0.0'
  let oomPrinted = !prints.includes('gpu-oom')
  try {
    await startFakeLaya({
      host,
      port,
      apiKey: env.LAYA_API_KEY || undefined,
      loadMs: Number(env.FAKE_LAYA_LOAD_MS) || 0,
      msPerRow: Number(env.FAKE_LAYA_MS_PER_ROW) || 0,
      device: env.LAYA_DEVICE || 'auto',
      models: String(env.LAYA_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean).length
        ? String(env.LAYA_MODELS).split(',').map((s) => s.trim()).filter(Boolean)
        : [...KNOWN_MODELS],
      onInference: () => { if (!oomPrinted) { oomPrinted = true; process.stdout.write(`${PRINTS['gpu-oom'].out}\n`) } },
    })
  } catch (err) {
    // What uvicorn prints when the port is taken, after the model loaded, and its exit code.
    if (err?.code === 'EADDRINUSE') {
      process.stderr.write(`ERROR:    [Errno 98] error while attempting to bind on address ('${host}', ${port}): address already in use\n`)
      process.exit(1)
    }
    throw err
  }
}

/**
 * Whether node was asked to run this file. Node names the main module by its real path, so a fake
 * spawned through a symlink or a directory junction is compared by real paths, and on Windows
 * without case, as scripts/jev-triage.mjs does.
 */
function invokedDirectly() {
  let given
  try { given = process.argv[1] ? realpathSync(process.argv[1]) : null } catch { given = null }
  if (!given) return false
  const self = realpathSync(fileURLToPath(import.meta.url))
  return process.platform === 'win32' ? given.toLowerCase() === self.toLowerCase() : given === self
}

if (invokedDirectly()) await main()
