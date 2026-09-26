// Who is calling: `req.client` is the client a bearer token names, or null for an anonymous call.
import { config } from '../config.js'

export function auth(req) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  req.client = token ? config.tokens[token] ?? null : null
}
