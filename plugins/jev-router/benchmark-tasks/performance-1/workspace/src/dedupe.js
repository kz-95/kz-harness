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
  const out = []
  for (const value of list) {
    if (!out.includes(value)) out.push(value)
  }
  return out
}
