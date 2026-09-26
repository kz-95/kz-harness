/**
 * A token bucket rate limiter.
 *
 * createLimiter({ capacity, refillPerSecond, now }) returns { take(n = 1), waitMs(n = 1) }.
 * `now` returns the current time in milliseconds; it defaults to Date.now.
 */
export function createLimiter({ capacity, refillPerSecond, now = Date.now } = {}) {
  const positive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0
  if (!positive(capacity) || !positive(refillPerSecond)) throw new RangeError('capacity and refillPerSecond must be positive finite numbers')
  let tokens = capacity
  let latest = now()
  // Tokens come back only for time after the latest reading: a clock that went back adds nothing.
  const refill = () => {
    const t = now()
    if (t <= latest) return
    tokens = Math.min(capacity, tokens + ((t - latest) / 1000) * refillPerSecond)
    latest = t
  }
  return {
    take(n = 1) {
      refill()
      if (tokens < n) return false
      tokens -= n
      return true
    },
    waitMs(n = 1) {
      if (n > capacity) return Infinity
      refill()
      if (tokens >= n) return 0
      return Math.ceil(((n - tokens) / refillPerSecond) * 1000)
    },
  }
}
