// Reading the page a client asks for from ?offset= and ?limit=.
import { config } from '../config.js'

/**
 * Sets `req.page` to { offset, limit }. The limit is capped at 100 (config.maxPage), so no
 * response holds more than 100 items.
 */
export function paging(req) {
  const offset = Math.max(0, Number.parseInt(req.query.get('offset') ?? '0', 10) || 0)
  const asked = Number.parseInt(req.query.get('limit') ?? '', 10)
  const limit = Number.isNaN(asked) || asked < 1 ? config.defaultPageSize : Math.min(asked, config.maxPage)
  req.page = { offset, limit }
}
