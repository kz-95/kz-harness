/**
 * Splits a list into pages of `pageSize` items.
 *
 * paginate(items, page, pageSize) returns { items, page, pageSize, totalItems, totalPages }:
 * - pages are counted from 1, so page 1 holds the first pageSize items;
 * - a page under 1, or one that is not a whole number, throws a RangeError;
 * - totalPages is how many pages the items fill, and 0 when there are no items;
 * - the last page may hold fewer than pageSize items;
 * - a page after the last one holds no items.
 *
 * @param {unknown[]} items
 * @param {number} page
 * @param {number} [pageSize] 1 or more, 20 by default
 */
export function paginate(items, page, pageSize = 20) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a whole number, 1 or more')
  }
  if (!Number.isInteger(page) || page < 0) {
    throw new RangeError('page must be a whole number, 1 or more')
  }
  const totalItems = items.length
  const fullPages = Math.floor(totalItems / pageSize)
  const totalPages = Math.max(1, fullPages)
  const start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalItems,
    totalPages,
  }
}
