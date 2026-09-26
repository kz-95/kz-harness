// Reading log lines and choosing which to print.

export const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']

/**
 * One line of the log, `<time> <LEVEL> <text>`, as { time, level, text }, or null for a line of
 * any other shape.
 */
export function parseLine(line) {
  const m = /^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/.exec(line)
  return m ? { time: m[1], level: m[2], text: m[3] } : null
}

/**
 * The entries at `level` or above and at or after `sinceMs`, in the order given; with neither,
 * every entry.
 */
export function filterEntries(entries, { level = null, sinceMs = null } = {}) {
  const min = level ? LEVELS.indexOf(level) : 0
  return entries.filter((entry) => LEVELS.indexOf(entry.level) >= min && (sinceMs === null || Date.parse(entry.time) >= sinceMs))
}
