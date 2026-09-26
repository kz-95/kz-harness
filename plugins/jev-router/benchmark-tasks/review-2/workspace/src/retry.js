// Calling something again when it fails.

/** Resolves after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calls `fn` until it succeeds, and resolves to what it resolved to.
 *
 * - `fn` is called at most `retries` times more after the first call, so `retries + 1` times in
 *   all; `fn(attempt)` is told which call it is, counting from 0.
 * - Between two calls it waits `delayMs`, and the wait doubles after each retry.
 * - `shouldRetry(error)` says whether an error is worth another call. When it says no, or when
 *   no retries are left, the last error is thrown to the caller.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ retries?: number, delayMs?: number, shouldRetry?: (error: unknown) => boolean, wait?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<T>}
 */
export async function retry(fn, { retries = 3, delayMs = 100, shouldRetry = () => true, wait = sleep } = {}) {
  let delay = delayMs
  let lastError
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (!shouldRetry(error)) throw error
      wait(delay)
      delay *= 2
    }
  }
  return undefined
}
