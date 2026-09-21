// Bounded waits for state that only becomes true after an asynchronous write lands.
//
// A fixed sleep races the write: under load it can return before the write has happened.
// A single immediate read can see the value from before the write. Both make a test pass or
// fail on machine load rather than on the behaviour under test. Poll until the condition
// holds, with a deadline, and throw with the last value seen, so a genuine failure reports
// the actual state instead of a bare timeout.

/** A short, readable form of any observed value, for the timeout message. */
function describe(value) {
  let text
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { text = String(value) }
  if (text === undefined || text === null) return String(text)
  return text.length > 1500 ? `${text.slice(0, 1500)}...` : text
}

/**
 * Poll `read` until `ok(read())` is true, then return that value. Throw once `timeoutMs`
 * has passed. A throw from `read` counts as "not ready yet" and is retried.
 *
 * @param {string} label    what is being waited for, used in the failure message
 * @param {() => any} read  reads the current state
 * @param {(value: any) => boolean} ok
 */
export async function waitFor(label, read, ok, { timeoutMs = 2000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = read() } catch (err) { value = `not readable yet: ${err.message}` }
    if (ok(value)) return value
    if (Date.now() >= deadline) throw new Error(`${label}: still not true after ${timeoutMs}ms, last state: ${describe(value)}`)
    await new Promise((r) => setTimeout(r, everyMs))
  }
}
