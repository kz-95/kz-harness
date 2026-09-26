// Statistics over lists of numbers.

/** The middle value, or the mean of the two middle values; NaN for an empty list. */
export function median(values) {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** The arithmetic mean; NaN for an empty list. */
export function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : NaN
}
