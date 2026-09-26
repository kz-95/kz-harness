// Which middleware and handler a request goes through, in order.
import { healthHandler } from './handlers/health.js'
import { itemHandler, listHandler } from './handlers/items.js'
import { auth } from './middleware/auth.js'
import { paging } from './middleware/paging.js'

const ROUTES = [
  { method: 'GET', pattern: /^\/health$/, middleware: [], handler: healthHandler },
  { method: 'GET', pattern: /^\/api\/items$/, middleware: [auth, paging], handler: listHandler },
  { method: 'GET', pattern: /^\/api\/items\/(\d+)$/, middleware: [auth], handler: itemHandler },
]

/** The response to `req` ({ method, path, query, headers }), as { status, body }. */
export async function route(req) {
  for (const r of ROUTES) {
    const m = req.method === r.method ? r.pattern.exec(req.path) : null
    if (!m) continue
    for (const step of r.middleware) step(req)
    return r.handler(req, ...m.slice(1))
  }
  return { status: 404, body: { error: 'not found' } }
}
