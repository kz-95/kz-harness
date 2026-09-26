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

/** The entries at `level` or above, in the order given; every entry when there is no level. */
export function filterEntries(entries, { level = null } = {}) {
  if (!level) return entries
  const min = LEVELS.indexOf(level)
  return entries.filter((entry) => LEVELS.indexOf(entry.level) >= min)
}
