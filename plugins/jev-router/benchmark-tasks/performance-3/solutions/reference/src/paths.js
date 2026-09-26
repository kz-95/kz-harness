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
  // ways[c] is the number of paths to the cell in column c of the row being filled in: the paths
  // from above (the row before) plus the paths from the left (this row so far).
  const ways = new Array(cols).fill(0n)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === '#') ways[c] = 0n
      else if (r === 0 && c === 0) ways[c] = 1n
      else ways[c] += c > 0 ? ways[c - 1] : 0n
    }
  }
  return ways[cols - 1]
}
