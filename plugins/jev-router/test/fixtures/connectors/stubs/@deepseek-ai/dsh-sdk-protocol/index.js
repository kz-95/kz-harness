// A stand-in for dsh-sdk-protocol's JsonRpcLineTransport: JSON-RPC, one message a line, read from
// `input` and written to `output`. Requests are numbered and answered by id, a server's requests go
// to onRequest and are answered with what it gives, and notifications go to onNotification in the
// order their lines arrive.
export class JsonRpcLineTransport {
  #input
  #output
  #next = 1
  #pending = new Map()
  #onRequest = null
  #onNotification = null
  #buffer = ''
  #closed = false

  constructor(input, output) {
    this.#input = input
    this.#output = output
  }

  onRequest(fn) { this.#onRequest = fn }
  onNotification(fn) { this.#onNotification = fn }

  start() {
    this.#input.setEncoding?.('utf8')
    this.#input.on('data', (chunk) => {
      this.#buffer += chunk
      let at
      while ((at = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, at)
        this.#buffer = this.#buffer.slice(at + 1)
        if (line.trim()) this.#take(JSON.parse(line))
      }
    })
  }

  #take(m) {
    if (m.method !== undefined && m.id !== undefined) {
      Promise.resolve()
        .then(() => this.#onRequest?.(m.method, m.params))
        .then((result) => this.#write({ id: m.id, result }), (error) => this.#write({ id: m.id, error: { message: String(error?.message ?? error) } }))
      return
    }
    if (m.method !== undefined) { this.#onNotification?.(m.method, m.params); return }
    const waiting = this.#pending.get(m.id)
    if (!waiting) return
    this.#pending.delete(m.id)
    if (m.error) waiting.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
    else waiting.resolve(m.result)
  }

  request(method, params, signal) {
    if (this.#closed) return Promise.reject(new Error('transport closed'))
    const id = this.#next++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      signal?.addEventListener('abort', () => { if (this.#pending.delete(id)) reject(signal.reason ?? new Error('aborted')) }, { once: true })
      this.#write({ id, method, params })
    })
  }

  notify(method, params) { this.#write({ method, ...(params === undefined ? {} : { params }) }) }
  flush() { return Promise.resolve() }

  close() {
    this.#closed = true
    for (const waiting of this.#pending.values()) waiting.reject(new Error('transport closed'))
    this.#pending.clear()
  }

  #write(m) { if (!this.#closed) this.#output.write(`${JSON.stringify(m)}\n`) }
}
