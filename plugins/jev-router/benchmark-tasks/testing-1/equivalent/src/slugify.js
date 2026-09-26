/**
 * Turns a title into the slug of a URL:
 * - lower case;
 * - accents removed, so é becomes e;
 * - any run of characters other than a to z and 0 to 9 becomes one dash;
 * - no dash at either end;
 * - at most 60 characters: a longer slug is cut back to the end of the last whole word that fits,
 *   and a first word longer than 60 characters is cut at 60.
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const words = []
  let word = ''
  for (const ch of title.normalize('NFKD').toLowerCase()) {
    if (/\p{M}/u.test(ch)) continue
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) word += ch
    else if (word) { words.push(word); word = '' }
  }
  if (word) words.push(word)
  let out = ''
  for (const w of words) {
    const next = out ? `${out}-${w}` : w
    if (next.length > 60) return out || w.slice(0, 60)
    out = next
  }
  return out
}
