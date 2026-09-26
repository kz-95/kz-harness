// Intervals of whole numbers, each written [start, end] with both ends included: [3, 5] holds 3,
// 4 and 5, and [4, 4] holds 4 alone.

/** Throws a RangeError for an interval whose start is after its end. */
function check(interval) {
  const [start, end] = interval
  if (!(start <= end)) throw new RangeError(`[${start}, ${end}] starts after it ends`)
}

/**
 * Merges the intervals of `list` that overlap or touch: [1, 3] and [2, 6] give [1, 6], and so do
 * [1, 3] and [4, 6], which touch, since no whole number lies between 3 and 4.
 * - Returns the merged intervals sorted by their start, whatever order they came in.
 * - Never changes the list it is given, or the intervals in it.
 * - Throws a RangeError when an interval starts after it ends.
 * @param {[number, number][]} list
 * @returns {[number, number][]}
 */
export function merge(list) {
  for (const interval of list) check(interval)
  const order = [...list.keys()].sort((a, b) => list[a][0] - list[b][0] || a - b)
  const out = []
  let start = null
  let end = null
  for (const k of order) {
    const [s, e] = list[k]
    if (start !== null && s - 1 <= end) {
      if (e > end) end = e
      continue
    }
    if (start !== null) out.push([start, end])
    start = s
    end = e
  }
  if (start !== null) out.push([start, end])
  return out
}

/**
 * Removes every whole number of `cut` from the intervals of `list`.
 * - An interval `cut` covers wholly is gone; one it covers in part keeps what lies outside the
 *   cut, which is two intervals when the cut lies inside it.
 * - The end points of `cut` are removed too, since both ends are included: [1, 10] less [4, 6]
 *   is [1, 3] and [7, 10].
 * - Returns the intervals that are left merged and sorted, as merge() returns them, and an empty
 *   list when nothing is left; never changes its arguments.
 * - Throws a RangeError when `cut`, or an interval of `list`, starts after it ends.
 * @param {[number, number][]} list
 * @param {[number, number]} cut
 * @returns {[number, number][]}
 */
export function subtract(list, cut) {
  check(cut)
  const pieces = []
  for (const [start, end] of merge(list)) {
    const left = [start, Math.min(end, cut[0] - 1)]
    const right = [Math.max(start, cut[1] + 1), end]
    for (const piece of [left, right]) if (piece[0] <= piece[1]) pieces.push(piece)
  }
  return pieces
}
