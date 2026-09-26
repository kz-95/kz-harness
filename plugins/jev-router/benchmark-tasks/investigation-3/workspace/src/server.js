// The HTTP server: node src/server.js
import { createServer } from 'node:http'
import { config } from './config.js'
import { route } from './router.js'

export function start(port = config.port) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const req = { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers }
    const { status, body } = await route(req)
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }).listen(port)
}

if (import.meta.url === `file://${process.argv[1]}`) start()
