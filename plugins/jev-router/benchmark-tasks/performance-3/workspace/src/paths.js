/**
 * How many paths lead from the top-left cell of `grid` to its bottom-right cell, moving only right
 * or down and never onto a '#' cell, as a BigInt.
 *
 * `grid` is a list of rows of equal length, each a string of '.' (open) and '#' (blocked). A grid
 * with no cells, or whose first or last cell is blocked, has 0n paths; a grid of one open cell has
 * 1n.
 *
 * @param {string[]} grid
 * @returns {bigint}
 */
export function countPaths(grid) {
  const rows = grid.length
  const cols = rows ? grid[0].length : 0
  if (!rows || !cols) return 0n
  const walk = (r, c) => {
    if (r >= rows || c >= cols || grid[r][c] === '#') return 0n
    if (r === rows - 1 && c === cols - 1) return 1n
    return walk(r + 1, c) + walk(r, c + 1)
  }
  return walk(0, 0)
}
