// What a run's final status says about the work, in one place. Every reader that learns from runs
// reads it from here, so none of them counts as a failure what another counts as a success:
//   router.js trackRecord (the accepted rate the routing call is shown),
//   training.js (the outcome labels of the routing samples),
//   profiles.js (capability evidence),
//   usage.js pickWorked and scorable (calibration),
//   domains.js ratesOf (a domain's failure rate, which blocks promotion and triggers rollback).
// waits.js sampleOf learns how long work takes, not whether it worked, so it keeps a rule of its
// own: it leaves out answered runs and read passes as well as the silent statuses below.
// An answer-only run that answered did what it was asked, as accepted work did. Before this module
// three of those readers counted every answered run as a failure, which read-only work, answered by
// the thousand, would have turned into rollbacks and a worse accepted rate for every agent it ran on.

/**
 * An attempt that did the run's work: a primary or a retry, or a parallel second opinion whose
 * answer became the run's because the primary failed (router.js marks it `answered`). A planner,
 * a reviewer, a tool and any other opinion did not. Every reader that credits an agent with a
 * run's outcome reads the work from here, so the agent that answered is the one credited.
 */
export const isWorkAttempt = (a) => !!a && (a.role === 'primary' || a.role === 'retry' || (a.role === 'opinion' && a.answered === true))

/** The work was done: accepted (with or without a person's review to follow), or answered. */
export const succeeded = (status) => String(status ?? '').startsWith('accepted') || status === 'answered'

/**
 * Statuses that say nothing about the work either way: a run out of allowance, one a person
 * stopped, and a read pass handed to its folder's line (it could not do the work locked, which is
 * no verdict on the agent). They are left out, never counted as failures.
 */
export const SILENT_STATUSES = Object.freeze(['paused_limit', 'stopped', 'needs_write'])
