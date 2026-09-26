// Ranking players by score.

/** Players by score, best first, and by name among equal scores. */
function byScore(players) {
  return players.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/** The `n` best players. */
export function topScores(players, n = 3) {
  return byScore(players).slice(0, n)
}

/** A player's place, counting from 1, or 0 when the player is not there. */
export function rankOf(players, name) {
  return byScore(players.slice()).findIndex((p) => p.name === name) + 1
}
