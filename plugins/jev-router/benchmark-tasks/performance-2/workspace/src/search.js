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
  return {
    /** How many times `word` occurs in the text. */
    count(word) {
      if (typeof word !== 'string' || !WORD.test(word)) return 0
      const pattern = new RegExp(`(?<![A-Za-z0-9'])${word}(?![A-Za-z0-9'])`, 'gi')
      return (text.match(pattern) ?? []).length
    },
  }
}
