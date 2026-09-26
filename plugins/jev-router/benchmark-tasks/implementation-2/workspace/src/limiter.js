/**
 * A token bucket rate limiter.
 *
 * createLimiter({ capacity, refillPerSecond, now }) returns { take(n = 1), waitMs(n = 1) }.
 * `now` returns the current time in milliseconds; it defaults to Date.now.
 */
export function createLimiter({ capacity, refillPerSecond, now = Date.now } = {}) {
  throw new Error('createLimiter is not implemented yet')
}
