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
  const refuse = (why) => { throw new RangeError(why) }
  if (!(Number.isInteger(cents) && cents >= 0)) refuse('cents must be a whole number, 0 or more')
  if (!Array.isArray(weights) || !weights.length) refuse('at least one weight is needed')
  let total = 0
  for (const w of weights) {
    if (!(w >= 0)) refuse('a weight cannot be negative')
    total += w
  }
  if (!(total > 0)) refuse('at least one weight must be above 0')
  const shares = []
  const remainders = []
  let given = 0
  weights.forEach((w, i) => {
    const exact = (cents * w) / total
    shares[i] = Math.floor(exact)
    remainders.push([exact - shares[i], i])
    given += shares[i]
  })
  remainders.sort(([ra, ia], [rb, ib]) => (ra === rb ? ia - ib : rb - ra))
  for (let k = 0; k < cents - given; k++) shares[remainders[k][1]] += 1
  return shares
}
