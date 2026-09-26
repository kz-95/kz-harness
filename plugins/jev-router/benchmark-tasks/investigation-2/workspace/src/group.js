// Grouping items.

/** Items grouped by what `keyOf` gives for each, as a Map in the order keys first appear. */
export function groupBy(items, keyOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}
