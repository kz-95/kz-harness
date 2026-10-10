// scripts/pin-model.mjs against a fake Hugging Face on 127.0.0.1: what it reads, what it writes into
// the manifest, and every refusal, each leaving the manifest as it was. The figures here are a
// test's own, not any real file's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, Refusal, pinModel } from '../../../scripts/pin-model.mjs'
import { readManifest } from '../local.js'

const SCRIPT = fileURLToPath(new URL('../../../scripts/pin-model.mjs', import.meta.url))
const sha = (s) => createHash('sha256').update(s).digest('hex')
const REPO = 'Qwen/Qwen3-30B-A3B-GGUF'
const FILE = 'Qwen3-30B-A3B-Q4_K_M.gguf'
const SIZE = 123_456_789
const OID = sha('a test file')
const ENGINE = { id: 'eng', kind: 'engine', variant: 'cpu', name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') }
const CANDIDATE = {
  id: 'qwen3-30b-a3b', kind: 'model', name: 'Qwen3 30B A3B', source: `https://huggingface.co/${REPO}/resolve/main/${FILE}`, hfRepo: REPO, file: FILE,
  license: 'Apache-2.0', reliability: 'official-stable', verified: false, moe: { totalParamsB: 30.5, activeParamsB: 3.3, expertShare: 0.95, layers: 48 },
}

function manifestWith(modules) {
  const path = join(mkdtempSync(join(tmpdir(), 'jev-pin-')), 'local-models.json')
  writeFileSync(path, `${JSON.stringify({ about: 'test', modules }, null, 2)}\n`)
  return path
}

/**
 * A stand-in for Hugging Face: the repo's API answer, its file list and the HEAD of the file's
 * resolve URL, each changeable by a test. Every request is kept, so a test can say what was asked.
 */
async function fakeHub(over = {}) {
  const asked = []
  const answers = {
    info: { id: REPO, author: 'Qwen', private: false, gated: false, cardData: { license: 'apache-2.0' }, tags: ['gguf', 'license:apache-2.0'] },
    tree: [{ type: 'file', path: 'README.md', size: 900, oid: sha('readme') }, { type: 'file', path: FILE, size: SIZE, oid: sha('pointer'), lfs: { oid: OID, size: SIZE, pointerSize: 135 } }],
    head: { status: 302, headers: { location: '/xet/blob', 'x-linked-size': String(SIZE), 'x-linked-etag': `"${OID}"`, 'x-repo-commit': 'c0ffee' } },
    ...over,
  }
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`)
    const json = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === `/api/models/${REPO}`) return json(answers.info)
    if (req.method === 'GET' && req.url === `/api/models/${REPO}/tree/main`) return json(answers.tree)
    if (req.method === 'HEAD' && req.url === `/${REPO}/resolve/main/${FILE}`) { res.writeHead(answers.head.status, answers.head.headers); return res.end() }
    res.statusCode = 404
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { hub: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((r) => server.close(r)) }
}

test('pin-model pins a candidate row from the file list and the HEAD of the URL KzH downloads, writing size and sha256 after file and nothing else', async (t) => {
  const fake = await fakeHub()
  t.after(fake.close)
  const manifest = manifestWith([ENGINE, CANDIDATE])
  const before = JSON.parse(readFileSync(manifest, 'utf8'))
  const said = []
  const out = await pinModel({ id: 'qwen3-30b-a3b', manifest, hub: fake.hub, say: (l) => said.push(l) })
  assert.equal(out.written, true)
  const after = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.deepEqual(after.modules[0], before.modules[0], 'the other rows as they were')
  assert.deepEqual(Object.keys(after.modules[1]), ['id', 'kind', 'name', 'source', 'hfRepo', 'file', 'size', 'sha256', 'license', 'reliability', 'verified', 'moe'])
  assert.deepEqual({ ...after.modules[1], size: undefined, sha256: undefined }, { ...CANDIDATE, size: undefined, sha256: undefined })
  assert.equal(after.modules[1].size, SIZE)
  assert.equal(after.modules[1].sha256, OID)
  assert.equal(readManifest(manifest).length, 2, 'the manifest loads as KzH reads it')
  assert.ok(readFileSync(manifest, 'utf8').endsWith('}\n'))
  // The HEAD's redirect is read, never followed: nothing of the file itself is fetched.
  assert.deepEqual(fake.asked, [`GET /api/models/${REPO}`, `GET /api/models/${REPO}/tree/main`, `HEAD /${REPO}/resolve/main/${FILE}`])
  assert.deepEqual(said.slice(0, 4), [
    `qwen3-30b-a3b: ${REPO}, ${FILE}, at commit c0ffee`,
    `  size     ${SIZE} bytes (0.1 GB)`,
    `  sha256   ${OID}`,
    '  license  apache-2.0 (the row says Apache-2.0)',
  ])
  assert.match(said[4], /^Written to .*local-models\.json\. KzH offers Qwen3 30B A3B at its next start: Settings, Jev setup, Local models, Install\.$/)
  assert.match(said[5], /commit the change/)

  // Again: the same figures leave the file alone; other figures are refused, the file as it was.
  const pinned = readFileSync(manifest, 'utf8')
  const again = []
  assert.equal((await pinModel({ id: 'qwen3-30b-a3b', manifest, hub: fake.hub, say: (l) => again.push(l) })).written, false)
  assert.match(again.at(-1), /^Pinned already to these figures/)
  const changed = await fakeHub({ head: { status: 302, headers: { 'x-linked-size': String(SIZE + 1), 'x-linked-etag': `"${sha('other')}"` } }, tree: [{ type: 'file', path: FILE, size: SIZE + 1, lfs: { oid: sha('other'), size: SIZE + 1 } }] })
  t.after(changed.close)
  await assert.rejects(pinModel({ id: 'qwen3-30b-a3b', manifest, hub: changed.hub }), (err) => err instanceof Refusal && /is pinned already to 123456789 bytes.*has changed since/.test(err.message))
  assert.equal(readFileSync(manifest, 'utf8'), pinned)
})

test('pin-model writes the repo\'s license into a row that names none, and refuses one that names another', async (t) => {
  const fake = await fakeHub()
  t.after(fake.close)
  const unnamed = manifestWith([{ ...CANDIDATE, license: undefined }])
  await pinModel({ id: 'qwen3-30b-a3b', manifest: unnamed, hub: fake.hub })
  const row = JSON.parse(readFileSync(unnamed, 'utf8')).modules[0]
  assert.deepEqual(Object.keys(row).slice(5, 9), ['file', 'size', 'sha256', 'license'])
  assert.equal(row.license, 'apache-2.0')
  const other = manifestWith([{ ...CANDIDATE, license: 'MIT' }])
  const text = readFileSync(other, 'utf8')
  await assert.rejects(pinModel({ id: 'qwen3-30b-a3b', manifest: other, hub: fake.hub }), /states the license apache-2.0, and the row says MIT/)
  assert.equal(readFileSync(other, 'utf8'), text)
})

test('pin-model refuses a repo outside a model maker\'s own organization before it asks Hugging Face anything', async (t) => {
  const fake = await fakeHub()
  t.after(fake.close)
  // A candidate row from an uploader: the manifest itself refuses it.
  const reupload = manifestWith([{ ...CANDIDATE, hfRepo: 'unsloth/Qwen3-30B-A3B-GGUF', source: `https://huggingface.co/unsloth/Qwen3-30B-A3B-GGUF/resolve/main/${FILE}` }])
  await assert.rejects(pinModel({ id: 'qwen3-30b-a3b', manifest: reupload, hub: fake.hub }), (err) => err instanceof Refusal && /maker's own organization \(Qwen, google\)/.test(err.message))
  // A pinned row from one, pinned again.
  const pinned = manifestWith([{ ...CANDIDATE, id: 'other', hfRepo: 'Org/Other-GGUF', source: 'https://huggingface.co/Org/Other-GGUF/resolve/main/other.gguf', file: 'other.gguf', size: 1, sha256: sha('o') }])
  await assert.rejects(pinModel({ id: 'other', manifest: pinned, hub: fake.hub }), /Org\/Other-GGUF is not in a model maker's own organization \(Qwen, google\); KzH takes models only from those/)
  // A row whose source is not its repo's file.
  const elsewhere = manifestWith([{ ...CANDIDATE, id: 'other', size: 1, sha256: sha('o'), source: 'https://huggingface.co/Qwen/Another-GGUF/resolve/main/x.gguf', file: 'x.gguf' }])
  await assert.rejects(pinModel({ id: 'other', manifest: elsewhere, hub: fake.hub }), /its source is not https:\/\/huggingface\.co\/Qwen\/Qwen3-30B-A3B-GGUF\/resolve\/main\/x\.gguf/)
  await assert.rejects(pinModel({ id: 'eng', manifest: manifestWith([ENGINE, CANDIDATE]), hub: fake.hub }), /is an engine build, pinned from its GitHub release/)
  assert.deepEqual(fake.asked, [], 'not one request')
})

test('pin-model refuses, writing nothing, what it cannot check: figures that disagree, a HEAD without them, no license, a gated repo, one that moved, a file not in it', async (t) => {
  const cases = [
    [{ tree: [{ type: 'file', path: FILE, size: SIZE, lfs: { oid: sha('another'), size: SIZE } }] }, /the file list says 123456789 bytes, SHA-256 [0-9a-f]{64}, and the download says 123456789 bytes, SHA-256 [0-9a-f]{64}; they must agree/],
    [{ head: { status: 200, headers: { 'content-length': '135' } } }, /carries no x-linked-size and x-linked-etag of a large file \(HTTP 200\)/],
    [{ head: { status: 302, headers: { 'x-linked-size': String(SIZE), 'x-linked-etag': '"abc123"' } } }, /carries no x-linked-size and x-linked-etag/],
    [{ head: { status: 401, headers: {} } }, /answered HTTP 401 to a HEAD/],
    [{ info: { id: REPO, gated: false, cardData: {}, tags: ['gguf'] } }, /states no license, so it is not pinned/],
    [{ info: { id: REPO, gated: 'auto', cardData: { license: 'apache-2.0' } } }, /is gated, so it cannot be downloaded without a Hugging Face login/],
    [{ info: { id: 'Someone/Qwen3-30B-A3B-GGUF', cardData: { license: 'apache-2.0' } } }, /answers for Someone\/Qwen3-30B-A3B-GGUF, not Qwen\/Qwen3-30B-A3B-GGUF: the repo moved/],
    [{ tree: [{ type: 'file', path: 'README.md', size: 1 }] }, /has no Qwen3-30B-A3B-Q4_K_M\.gguf in its main branch/],
    [{ tree: [{ type: 'file', path: FILE, size: 135 }] }, /is not stored as a large file/],
  ]
  for (const [over, why] of cases) {
    const fake = await fakeHub(over)
    const manifest = manifestWith([CANDIDATE])
    const text = readFileSync(manifest, 'utf8')
    await assert.rejects(pinModel({ id: 'qwen3-30b-a3b', manifest, hub: fake.hub }), (err) => err instanceof Refusal && why.test(err.message), String(why))
    assert.equal(readFileSync(manifest, 'utf8'), text, `nothing written: ${why}`)
    await fake.close()
  }
  // No answer at all.
  await assert.rejects(pinModel({ id: 'qwen3-30b-a3b', manifest: manifestWith([CANDIDATE]), hub: 'http://127.0.0.1:9', fetch: async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }) } }), /Hugging Face did not answer \(connect ECONNREFUSED\)\. Run this on a PC that reaches huggingface\.co\./)
})

test('pin-model from a shell: a usage line and exit 2 without an id, and exit 1 with the reason for a row the manifest does not have', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  const none = run()
  assert.equal(none.status, EXIT.usage)
  assert.match(none.stderr, /^usage: node scripts\/pin-model\.mjs <id> \[--manifest <path>\]/)
  const unknown = run('nope', '--manifest', manifestWith([ENGINE, CANDIDATE]))
  assert.equal(unknown.status, EXIT.refused)
  assert.match(unknown.stderr, /^Not pinned: nope is not a row of .*local-models\.json\. Its model rows: qwen3-30b-a3b\./)
})
