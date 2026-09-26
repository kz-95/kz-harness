/**
 * Formats a duration given in milliseconds as text such as 1h 02m 03s.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new RangeError(`not a duration in milliseconds: ${ms}`)
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (n) => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}h ${two(minutes)}m ${two(seconds)}s`
  if (minutes > 0) return `${minutes}m ${two(seconds)}s`
  return `${seconds}s`
}
