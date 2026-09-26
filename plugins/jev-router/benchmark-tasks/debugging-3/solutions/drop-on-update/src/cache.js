/**
 * A least-recently-used cache whose entries also expire `ttlMs` after they were set.
 *
 * get() of a live entry makes it the most recently used, and so does set(). When the cache is
 * full, set() of a new key first evicts the least recently used entry.
 *
 * @param {{ capacity: number, ttlMs: number, now?: () => number }} options
 */
export function createCache({ capacity, ttlMs, now = Date.now }) {
  // key -> { value, expires }, least recently used first: a Map keeps insertion order.
  const entries = new Map()
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      // A set is a set, for a key already cached too: it becomes the most recently used, with a
      // time to live that starts now.
      if (!entries.delete(key) && entries.size >= capacity) entries.delete(entries.keys().next().value)
      entries.set(key, { value, expires: now() + ttlMs })
    },
    delete(key) {
      return entries.delete(key)
    },
    get size() {
      return entries.size
    },
  }
}
