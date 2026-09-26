/**
 * The values of `list` without repeats, each kept where it first appears.
 *
 * Values are compared as Array.prototype.includes compares them: NaN matches NaN, 0 matches -0,
 * and an object matches only itself.
 *
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
export function dedupe(list) {
  // A Set compares as includes does (SameValueZero), in constant time. It stores -0 as 0, so it
  // only says what was seen; the value kept is the one from the list, -0 included.
  const seen = new Set()
  const out = []
  for (const value of list) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
