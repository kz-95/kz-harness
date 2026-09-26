/**
 * Runs async jobs, `limit` of them at a time: a new job starts as soon as one finishes.
 *
 * Resolves, once every job has settled, to one result per job, in the order the jobs were given:
 * { status: 'fulfilled', value } for a job that resolved, { status: 'rejected', reason } for one
 * that rejected. It never rejects itself.
 *
 * @param {(() => Promise<unknown>)[]} jobs
 * @param {number} limit  how many jobs may run at once, 1 or more
 * @returns {Promise<({ status: 'fulfilled', value: unknown } | { status: 'rejected', reason: unknown })[]>}
 */
export function runAll(jobs, limit) {
  return new Promise((resolve) => {
    const results = new Array(jobs.length)
    let next = 0
    let running = 0
    let settled = 0
    if (jobs.length === 0) {
      resolve(results)
      return
    }
    // Whichever way a job settles, its slot is free again and the next job may start.
    const done = (i, result) => {
      results[i] = result
      running--
      settled++
      if (settled === jobs.length) resolve(results)
      else startMore()
    }
    const startMore = () => {
      while (running < limit && next < jobs.length) {
        const i = next++
        running++
        jobs[i]().then(
          (value) => done(i, { status: 'fulfilled', value }),
          (reason) => done(i, { status: 'rejected', reason }),
        )
      }
    }
    startMore()
  })
}
