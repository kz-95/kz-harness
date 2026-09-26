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
  const plain = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  const slug = plain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length <= 60) return slug
  const end = slug.slice(0, 61).lastIndexOf('-')
  return end > 0 ? slug.slice(0, end) : slug.slice(0, 60)
}
