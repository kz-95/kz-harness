/**
 * Splits an amount of money, in whole cents, into shares by weight.
 *
 * - Returns one whole number of cents per weight, in the order of the weights, and the shares add
 *   up to `cents` exactly.
 * - Each share is first the floor of cents * weight / (the sum of the weights). The cents left
 *   over are then given out one at a time, to the shares with the largest remainders first; when
 *   two remainders are equal, the earlier share gets the cent.
 * - Throws a RangeError when cents is negative or not a whole number, when there are no weights,
 *   when a weight is negative, or when every weight is 0.
 *
 * @param {number} cents
 * @param {number[]} weights
 * @returns {number[]}
 */
export function split(cents, weights) {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('cents must be a whole number, 0 or more')
  if (!Array.isArray(weights) || weights.length === 0) throw new RangeError('at least one weight is needed')
  if (weights.some((w) => !(w >= 0))) throw new RangeError('a weight cannot be negative')
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total === 0) throw new RangeError('at least one weight must be above 0')
  const exact = weights.map((w) => (cents * w) / total)
  const shares = exact.map((x) => Math.floor(x))
  let left = cents - shares.reduce((sum, s) => sum + s, 0)
  const byRemainder = exact
    .map((x, i) => ({ i, remainder: x - Math.floor(x) }))
    .sort((a, b) => b.remainder - a.remainder || weights[b.i] - weights[a.i] || a.i - b.i)
  for (const { i } of byRemainder) {
    if (left === 0) break
    shares[i]++
    left--
  }
  return shares
}
