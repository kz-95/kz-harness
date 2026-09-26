// Dropping repeats.

/** The items without repeats of what `keyOf` gives, each first one kept, in order. */
export function uniqueBy(items, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
