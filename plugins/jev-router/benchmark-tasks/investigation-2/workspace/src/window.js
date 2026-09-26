// The ends of lists.

/** The last `n` items, newest first. */
export function latestFirst(items, n) {
  const tail = items.slice(-n)
  tail.reverse()
  return tail
}

/** The items sorted by `at`, oldest first. */
export function chronological(items) {
  const copy = Array.from(items)
  copy.sort((a, b) => a.at - b.at)
  return copy
}
