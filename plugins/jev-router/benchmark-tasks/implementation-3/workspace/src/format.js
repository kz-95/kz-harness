// How the tool prints an entry.

/** One entry as a line: the time, the level padded to five characters, and the text. */
export function formatEntry(entry) {
  return `${entry.time} ${entry.level.padEnd(5)} ${entry.text}`
}
