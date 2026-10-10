// A stand-in for colibri's `coli serve` with its Laya engine (colibri 2.0.0, c/openai_server.py), for
// the tests of the side-by-side comparison (docs/laya-auto.md 13). It behaves like colibri where KzH
// depends on it:
//   - `GET /health` answers `{ status: 'ok' }` with no `loaded` list, which is why KzH counts colibri
//     reachable only once it has answered a test question;
//   - `POST /v1/systemone` needs no key unless `apiKey` is given (then a bearer or `x-api-key`, else
//     401), takes TypeSafe Jev's request, ignores `model` and every noul's `labels`, and refuses what
//     colibri refuses, with colibri's own 422 envelope `{ error: { message, type, param, code } }`: no
//     state, no questions or more than 64, a choice whose criteria are not an object, a score whose
//     criteria are not a list, a type it does not know;
//   - it answers in colibri's shapes, probabilities rounded to 6 decimals: a noul as `{ type, noul }`
//     with no confidence, a choice and a score with `confidence` = (n * peak - 1) / (n - 1), and the
//     reply as `{ id, model, provider: 'colibri', answers, usage: { input_tokens, output_tokens: 0, cost: 0 } }`;
//   - one request at a time, each taking `msPerRequest`.
// `refuseNext(status, message)`, `hangNext()`, `reshapeNext(fn)` and `setMsPerRequest(n)` drive a
// refusal, an answer that never comes, one in a shape colibri never gives (`fn` of the reply it would
// have sent) and a slow one; closing it ends every wait. It never runs a model: `answer(name,
// question, state)` gives each question's probabilities in option order (a noul's are [false, true]).
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const MAX_QUESTIONS = 64
const round6 = (x) => Math.round(x * 1e6) / 1e6
const isDict = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** How many options a question has, as colibri's decision record lists them: a noul's false and true. */
export function optionCount(q) {
  if (q?.type === 'choice') return Object.keys(q.criteria ?? {}).length
  if (q?.type === 'score') return Array.isArray(q.criteria) ? q.criteria.length : 0
  return 2
}

/** The first option sure, the rest sharing what is left: a noul answers no, P(true) 0.3. */
export function defaultAnswer(name, question) {
  const k = optionCount(question)
  return Array.from({ length: k }, (_, i) => (i === 0 ? (k === 1 ? 1 : 0.7) : 0.3 / (k - 1)))
}

/** What colibri refuses before its engine sees a request, in its own words (c/openai_server.py systemone). */
function refusal(body) {
  if (body.state == null) return { message: '`state` is required: the content the questions are about.', param: 'state' }
  const raw = body.questions
  if (!isDict(raw) || !Object.keys(raw).length) return { message: '`questions` must be a non-empty object of id: question.', param: 'questions' }
  if (Object.keys(raw).length > MAX_QUESTIONS) return { message: `\`questions\` accepts at most ${MAX_QUESTIONS} entries.`, param: 'questions' }
  for (const [id, q] of Object.entries(raw)) {
    const where = `questions.${id}`
    if (!isDict(q)) return { message: `\`${where}\` must be an object.`, param: where }
    if (q.type === 'noul') {
      if (q.criteria != null && !isDict(q.criteria)) return { message: `\`${where}.criteria\` must be an object with \`true\` and/or \`false\`.`, param: `${where}.criteria` }
    } else if (q.type === 'choice') {
      if (!isDict(q.criteria) || !Object.keys(q.criteria).length) return { message: `\`${where}.criteria\` must be a non-empty object of label: description.`, param: `${where}.criteria` }
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || !q.criteria.length) return { message: `\`${where}.criteria\` must be an array of 1 to 255 level descriptions.`, param: `${where}.criteria` }
    } else return { message: `\`${where}.type\` must be "noul", "choice" or "score".`, param: `${where}.type` }
  }
  return null
}

/** (n * peak - 1) / (n - 1): 1 when all of it is on one option, 0 when flat, as colibri gives a choice or a score. */
const confidenceOf = (p) => (p.length < 2 ? 1 : round6(Math.max(0, (p.length * Math.max(...p) - 1) / (p.length - 1))))

/** One answer in colibri's shape (`_systemone_decide`): a noul carries no confidence. */
function toAnswer(q, p) {
  const best = p.indexOf(Math.max(...p))
  if (q.type === 'noul') return { type: 'noul', noul: round6(p[1]) }
  if (q.type === 'choice') {
    const labels = Object.keys(q.criteria)
    return { type: 'choice', choice: labels[best], probabilities: Object.fromEntries(labels.map((l, i) => [l, round6(p[i])])), confidence: confidenceOf(p) }
  }
  return {
    type: 'score',
    score: round6(p.reduce((s, x, i) => s + i * x, 0)),
    legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c ?? `level ${i}`])),
    probabilities: Object.fromEntries(p.map((x, i) => [String(i), round6(x)])),
    confidence: confidenceOf(p),
  }
}

/**
 * Start a fake colibri. Resolves once it listens.
 * @returns {Promise<{ url: string, port: number, requests: object[], answered: () => number, setMsPerRequest: (n: number) => void,
 *   refuseNext: (status: number, message?: string) => void, hangNext: () => void, reshapeNext: (fn: (reply: object) => unknown) => void,
 *   close: () => Promise<void> }>}
 *   `requests` holds every request, /health included: its `method`, `path`, `headers`, parsed `body`,
 *   `arrivedAt` and `finishedAt` (ms since the epoch), the `status` answered, and `closedEarly` when
 *   the client closed the connection before the answer was sent.
 */
export async function startFakeColibri({
  host = '127.0.0.1', port = 0, apiKey = null, msPerRequest = 0, answer = defaultAnswer, model = 'laya', provider = 'colibri',
} = {}) {
  const requests = []
  let perRequest = msPerRequest
  const refusals = []
  const reshapes = []
  let hangs = 0
  let answered = 0
  let closed = false
  let gate = Promise.resolve()
  // Every wait the server is in, so close() can end them instead of leaving timers behind.
  const waits = new Set()
  const wait = (ms) => new Promise((resolve) => {
    const w = { resolve, timer: ms === Infinity ? null : setTimeout(() => { waits.delete(w); resolve() }, ms) }
    waits.add(w)
  })

  const send = (entry, res, status, body) => {
    entry.status = status
    entry.finishedAt = Date.now()
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const envelope = (message, param = null, code = null, type = 'invalid_request_error') => ({ error: { message, type, param, code } })

  const decide = async (entry, res) => {
    if (closed) return
    if (hangs > 0) { hangs--; await wait(Infinity); return }
    await wait(perRequest)
    if (closed) return
    const answers = {}
    let tokens = 0
    for (const [id, q] of Object.entries(entry.body.questions)) {
      const given = answer(id, q, entry.body.state)
      const sum = given.reduce((s, x) => s + x, 0)
      answers[id] = toAnswer(q, given.map((x) => x / sum))
      tokens += Math.ceil((JSON.stringify(q).length + JSON.stringify(entry.body.state).length) / 4)
    }
    answered++
    const reply = { id: `req_${randomUUID().replace(/-/g, '')}`, model, provider, answers, usage: { input_tokens: tokens, output_tokens: 0, cost: 0 } }
    const reshape = reshapes.shift()
    return send(entry, res, 200, reshape ? reshape(reply) : reply)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake')
    const entry = { method: req.method, path: url.pathname, headers: { ...req.headers }, body: null, arrivedAt: Date.now(), finishedAt: null, status: null, closedEarly: false }
    requests.push(entry)
    res.on('close', () => { if (!res.writableEnded) entry.closedEarly = true })
    if (req.method === 'GET' && url.pathname === '/health') return send(entry, res, 200, { status: 'ok' })
    if (req.method !== 'POST' || url.pathname !== '/v1/systemone') return send(entry, res, 404, envelope(`Unknown route ${url.pathname}.`, null, null, 'not_found_error'))
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { entry.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { entry.body = null }
      if (apiKey && entry.headers.authorization !== `Bearer ${apiKey}` && entry.headers['x-api-key'] !== apiKey) {
        return send(entry, res, 401, envelope('Invalid or missing API key.', null, 'invalid_api_key', 'authentication_error'))
      }
      if (!isDict(entry.body)) return send(entry, res, 400, envelope('Request body must be a JSON object.'))
      const bad = refusal(entry.body)
      if (bad) return send(entry, res, 422, envelope(bad.message, bad.param))
      // A refusal comes at once, as colibri's own checks do, before the engine is free.
      const refused = refusals.shift()
      if (refused) return send(entry, res, refused.status, envelope(refused.message ?? 'refused by refuseNext', null, null, refused.status >= 500 ? 'server_error' : 'invalid_request_error'))
      // One engine, one request at a time, the next admitted once the one before it is answered.
      const run = gate.then(() => decide(entry, res))
      gate = run.catch(() => {})
      return undefined
    })
    return undefined
  })

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve() }) })
  const bound = server.address().port
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    requests,
    answered: () => answered,
    setMsPerRequest: (n) => { perRequest = n },
    refuseNext: (status, message) => { refusals.push({ status, message }) },
    hangNext: () => { hangs++ },
    reshapeNext: (fn) => { reshapes.push(fn) },
    close: () => new Promise((resolve) => {
      closed = true
      for (const w of waits) { clearTimeout(w.timer); w.resolve() }
      waits.clear()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
