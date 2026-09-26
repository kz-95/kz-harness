// What shipping costs.

/**
 * The shipping price of a parcel, in cents: 499 up to 1 kg, then 150 for each further kilogram
 * or part of one.
 * @param {number} weightKg the parcel's weight in kilograms
 */
export function shippingCents(weightKg) {
  if (!(weightKg > 0)) throw new RangeError('a parcel weighs something')
  if (weightKg <= 1) return 499
  return 499 + Math.ceil(weightKg - 1) * 150
}

/** Free shipping from this order total, in cents. */
export const FREE_SHIPPING_FROM = 5000
