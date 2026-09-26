// hello.txt holds what node --version prints when this process runs it with the same PATH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Text as a shell may have written it: UTF-8 with or without a byte order mark, or the UTF-16 a
// Windows PowerShell redirection writes. What the file says is what counts, not its encoding.
function readText(file) {
  const b = readFileSync(file)
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le')
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le')
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8')
  return b.toString('utf8')
}

test('hello.txt holds what node --version prints', () => {
  const file = join(process.env.BENCH_WORKSPACE, 'hello.txt')
  assert.ok(existsSync(file), 'hello.txt was not written')
  let expected
  try { expected = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim() } catch (err) { assert.fail(`node is not on the PATH: ${err.message}`) }
  assert.equal(readText(file).trim(), expected)
})
