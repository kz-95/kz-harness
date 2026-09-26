// Signed session cookies.
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The HMAC-SHA256 of `body` with `key`, in base64url.
 * @param {string} body
 * @param {string} key
 */
function mac(body, key) {
  return createHmac('sha256', key).update(body).digest('base64url')
}

/**
 * A session cookie for `payload`: `<payload>.<signature>`, both in base64url. The payload is JSON
 * such as { "user": "ana", "exp": 1790000000 }, where `exp` is when the session expires, in
 * seconds since the epoch; the signature is the HMAC-SHA256 of the payload's base64url text.
 * @param {{ exp: number } & Record<string, unknown>} payload
 * @param {string} key
 */
export function sign(payload, key) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${mac(body, key)}`
}

/**
 * The payload of a cookie `sign` made with `key` whose session has not expired at `now`
 * (milliseconds since the epoch), or null for any other cookie: one with a missing, empty or
 * wrong signature, one whose payload is not JSON, and one whose session has expired.
 * @param {string} cookie
 * @param {string} key
 * @param {number} [now]
 */
export function verify(cookie, key, now = Date.now()) {
  if (typeof cookie !== 'string') return null
  const dot = cookie.lastIndexOf('.')
  if (dot < 0) return null
  const body = cookie.slice(0, dot)
  // Compared whole and in constant time: a prefix, or an empty signature, is not a signature.
  const given = Buffer.from(cookie.slice(dot + 1))
  const expected = Buffer.from(mac(body, key))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload?.exp !== 'number' || payload.exp * 1000 <= now) return null
  return payload
}
