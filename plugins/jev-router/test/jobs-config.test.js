// The background jobs row of config/cordis.patch.yml: the engine's jobs registry
// (@deepseek-ai/dsh-jobs-local 0.1.5-rc.2, which dsh-base inserts as `id: jobs`) allows 10 active
// jobs per chat unless configured. Every jev-router task holds one from the moment it is queued
// until it ends, waiting tasks included, so the tenth waiting task made the eleventh message fail
// (docs/live-agent-view.md 0.3). How many run at once stays with Tasks at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PATCH = readFileSync(new URL('../../../config/cordis.patch.yml', import.meta.url), 'utf8')

/** The scalar keys under the `config:` of one top-level `- id: <id>` entry, or null when there is no such entry. */
function entryConfig(text, id) {
  // Split on either line ending: on Windows the file is checked out CRLF.
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => l.trim() === `- id: ${id}` && /^- /.test(l))
  if (at < 0) return null
  const config = {}
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break // the next top-level entry or comment
    const kv = /^\s{4,}(\w+):\s*(\S+)\s*$/.exec(line)
    if (kv) config[kv[1]] = /^\d+$/.test(kv[2]) ? Number(kv[2]) : kv[2]
  }
  return config
}

test('config/cordis.patch.yml sets jobs maxConcurrentJobsPerOwner to 32', () => {
  const jobs = entryConfig(PATCH, 'jobs')
  assert.ok(jobs, 'config/cordis.patch.yml has a jobs entry')
  assert.equal(jobs.maxConcurrentJobsPerOwner, 32)
  // The engine's own schema: a whole number of at least 1.
  assert.ok(Number.isSafeInteger(jobs.maxConcurrentJobsPerOwner) && jobs.maxConcurrentJobsPerOwner >= 1)
})
