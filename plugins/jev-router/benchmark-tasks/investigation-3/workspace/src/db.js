// The items, in memory: a stand-in for the database.

const ITEMS = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}`, priceCents: 100 + ((i * 37) % 900) }))

/** Items from `offset`, at most `limit` of them. */
export async function listItems(offset, limit) {
  return ITEMS.slice(offset, offset + limit)
}

/** One item by id, or null. */
export async function findItem(id) {
  return ITEMS.find((item) => item.id === id) ?? null
}
