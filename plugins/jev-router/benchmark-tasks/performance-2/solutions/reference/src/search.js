// Counting words in a text.

const WORD = /^[A-Za-z0-9']+$/

/**
 * An index over one text that says how often a word occurs in it.
 *
 * A word is a run of letters, digits and apostrophes: A to Z, a to z, 0 to 9 and '. Words are
 * compared without regard to case, and whole: "cat" is not counted inside "cats" or "o'cat".
 * count() of anything that is not a word, the empty string included, is 0.
 *
 * @param {string} text
 */
export function createIndex(text) {
  // The text is read once, the first time it is asked about, into a count per word; every call
  // after that is one lookup.
  let counts = null
  const build = () => {
    counts = new Map()
    for (const w of text.split(/[^A-Za-z0-9']+/)) {
      if (!w) continue
      const key = w.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return {
    /** How many times `word` occurs in the text. */
    count(word) {
      if (typeof word !== 'string' || !WORD.test(word)) return 0
      if (!counts) build()
      return counts.get(word.toLowerCase()) ?? 0
    },
  }
}
