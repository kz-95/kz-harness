// JSON over HTTP, with retries for the failures that are worth another try.
import { retry } from './retry.js'

/** An HTTP answer that is not a success; `status` is its status code. */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${url}`)
    this.name = 'HttpError'
    this.status = status
  }
}

/**
 * Whether a failed request is worth sending again.
 *
 * A network error (no status at all) is, and so is a 5xx answer or a 429 (too many requests).
 * Every other 4xx answer is final: the same request would fail the same way, so it is never
 * sent again.
 *
 * @param {unknown} error
 */
export function isRetryable(error) {
  const status = error?.status
  if (status === undefined) return true
  if (status >= 500) return true
  return status >= 400
}

/**
 * Sends `init` to `url` and resolves to the JSON of the answer, retrying as isRetryable says.
 *
 * @param {string} url
 * @param {{ init?: RequestInit, fetchImpl?: typeof fetch, retries?: number, delayMs?: number, wait?: (ms: number) => Promise<void> }} [options]
 */
export async function requestJson(url, { init = {}, fetchImpl = fetch, retries = 3, delayMs = 200, wait } = {}) {
  return retry(async () => {
    const res = await fetchImpl(url, init)
    if (!res.ok) throw new HttpError(res.status, url)
    return res.json()
  }, { retries, delayMs, shouldRetry: isRetryable, ...(wait ? { wait } : {}) })
}

/** GETs `url` as JSON. */
export function getJson(url, options = {}) {
  return requestJson(url, { ...options, init: { method: 'GET', headers: { accept: 'application/json' } } })
}

/** POSTs `body` to `url` as JSON, and resolves to the JSON of the answer. */
export function postJson(url, body, options = {}) {
  return requestJson(url, {
    ...options,
    init: { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) },
  })
}
