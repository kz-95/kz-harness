// Splitting lists.

/** The items in lists of `size`, the last one maybe shorter. */
export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** The items with `item` put in at `index`. */
export function insertAt(items, index, item) {
  const copy = items.slice()
  copy.splice(index, 0, item)
  return copy
}
