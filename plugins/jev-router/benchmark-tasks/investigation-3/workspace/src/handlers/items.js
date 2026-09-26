// GET /api/items and GET /api/items/:id
import { config } from '../config.js'
import { findItem, listItems } from '../db.js'

/** A page's limit for this caller: an anonymous caller gets at most config.anonymousMaxPage. */
function anonymousCap(req, limit) {
  return req.client ? limit : Math.min(limit, config.anonymousMaxPage)
}

export async function listHandler(req) {
  const limit = anonymousCap(req, req.page.limit)
  const items = await listItems(req.page.offset, limit)
  return { status: 200, body: { items, offset: req.page.offset, limit } }
}

export async function itemHandler(req, id) {
  const item = await findItem(Number(id))
  return item ? { status: 200, body: item } : { status: 404, body: { error: 'no such item' } }
}
