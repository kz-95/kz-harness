// `npm test`: the node test runner, in a temp folder of its own that is removed when it ends.
// The tests make thousands of temp folders (a repo, an engine home, a data folder per test) and
// most never remove theirs, so run against the system's temp folder they filled it: about 1,800
// folders a run, kept until something cleared it. Here each run's folders go with the run, and a
// test that leaks one costs nothing. TMPDIR is what node reads for os.tmpdir() on Linux and macOS,
// TEMP and TMP on Windows; child processes the tests start inherit all three.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'kzh-tests-'))
const args = process.argv.slice(2)
// The runner run from inside another test gets that test's context, and would report to it.
const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root }
delete env.NODE_TEST_CONTEXT

const child = spawn(process.execPath, ['--test', ...(args.length ? args : ['test/*.test.js'])], { stdio: 'inherit', env })
// Ctrl+C reaches the runner through the console too; passing it on covers a stop sent to this process alone.
const forward = (signal) => { if (child.exitCode === null) child.kill(signal) }
process.on('SIGINT', forward)
process.on('SIGTERM', forward)

child.on('exit', (code, signal) => {
  // A test's process still holding a file on Windows can make one removal fail: retry a little, then say what is left.
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch (err) { process.stderr.write(`test/run.mjs: could not remove ${root}: ${err.message}\n`) }
  process.exit(code ?? (signal ? 1 : 0))
})
