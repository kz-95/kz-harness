// Pins a candidate row of config/local-models.json: reads its file's size and SHA-256 from Hugging
// Face and writes them into the row, so KzH can download the file and check it (README, "Local
// models & offline").
//
//   node scripts/pin-model.mjs <id> [--manifest <path>]
//
// A candidate row ships with `hfRepo` and `file` but no `size` or `sha256`, since they could not be
// read where the row was written; KzH shows it as "not checked yet" and downloads nothing for it.
// Run on a PC that reaches Hugging Face, this:
//
//   1. refuses a row whose repo is not in a model maker's own organization (local.js VENDOR_ORGS),
//      or whose source is not that repo's resolve/main URL of its file, before asking anything;
//   2. reads the repo (GET /api/models/<repo>): the answer must be for that repo, not one it moved
//      to, open to anyone without a login, and state a license, the one the row names when it
//      names one;
//   3. reads the file's size and SHA-256 twice, from the repo's file list (GET /api/models/<repo>/
//      tree/main, the entry's `lfs` size and oid) and from a HEAD of the file's resolve URL, the URL
//      KzH downloads, whose redirect carries them as x-linked-size and x-linked-etag (the LFS
//      SHA-256, in quotes); the two must agree;
//   4. writes `size` and `sha256` after `file` (and the repo's license, when the row names none),
//      checks the manifest still loads (local.js readManifest), and prints what it wrote.
//
// It downloads nothing but those answers. A row pinned already is left as it is: the same figures
// say so, and other figures are refused, since a file that changed on Hugging Face needs a look
// before its row does. Exit codes: 0 pinned, or pinned already to these figures; 1 refused, the
// line saying why; 2 a bad argument.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VENDOR_ORGS, isPinned, readManifest } from '../plugins/jev-router/local.js'
import { runAsScript } from './run-as-script.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const MANIFEST = join(here, '..', 'config', 'local-models.json')
export const HUB = 'https://huggingface.co'
export const EXIT = { pinned: 0, refused: 1, usage: 2 }
const USAGE = 'usage: node scripts/pin-model.mjs <id> [--manifest <path>]'
const GB = 1024 ** 3
const SHA = /^[0-9a-f]{64}$/

/** A refusal: what the script prints, and exits 1 on. */
export class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why) }

/** A license as a repo or a row names it, for comparing: "Apache-2.0 (Gemma 4)" and "apache-2.0" are one. */
const licenseKey = (l) => String(l ?? '').trim().split(/\s+\(/)[0].toLowerCase()

/** An ETag as the hub sends it, `"<sha256>"` or a weak `W/"..."`, without its marks. */
const etagOf = (v) => String(v ?? '').replace(/^W\//, '').replace(/^"|"$/g, '')

/**
 * Pin row `id` of the manifest at `manifest` from `hub` (Hugging Face; tests give a fake one). Says
 * each line of what it found and wrote through `say`. Returns `{ row, written }`, `written` false for
 * a row pinned already to these figures; throws a Refusal with why it pinned nothing.
 */
export async function pinModel({ id, manifest = MANIFEST, hub = HUB, fetch = globalThis.fetch, say = () => {} }) {
  let modules
  try { modules = readManifest(manifest) } catch (err) { refuse(`The manifest did not load: ${err.message}`) }
  const row = modules.find((m) => m.id === id)
  if (!row) refuse(`${id} is not a row of ${manifest}. Its model rows: ${modules.filter((m) => m.kind !== 'engine').map((m) => m.id).join(', ')}.`)
  if (row.kind === 'engine') refuse(`${id} is an engine build, pinned from its GitHub release, not from Hugging Face.`)
  const org = String(row.hfRepo ?? '').split('/')[0]
  if (!VENDOR_ORGS.includes(org)) refuse(`${id}: ${row.hfRepo ?? 'no hfRepo'} is not in a model maker's own organization (${VENDOR_ORGS.join(', ')}); KzH takes models only from those.`)
  const source = `${HUB}/${row.hfRepo}/resolve/main/${row.file}`
  if (row.source !== source) refuse(`${id}: its source is not ${source}, the file of its hfRepo, so this would pin a file KzH does not download.`)

  const ask = async (path, init = {}) => {
    try { return await fetch(`${hub}${path}`, { ...init, signal: AbortSignal.timeout(30_000) }) } catch (err) { refuse(`Hugging Face did not answer (${err.cause?.message ?? err.message}). Run this on a PC that reaches huggingface.co.`) }
  }
  const json = async (path) => {
    const r = await ask(path)
    if (!r.ok) refuse(`Hugging Face answered HTTP ${r.status} for ${path}${r.status === 401 || r.status === 404 ? ': the repo is private, or there is none by that name' : ''}.`)
    try { return await r.json() } catch { refuse(`Hugging Face answered ${path} with something that is not JSON.`) }
  }

  // The repo: this one, open to anyone, and its license.
  const info = await json(`/api/models/${row.hfRepo}`)
  if (info?.id !== row.hfRepo) refuse(`${id}: Hugging Face answers for ${info?.id ?? 'no repo'}, not ${row.hfRepo}: the repo moved. Point the row at the new one by hand only if it is still ${org}'s own.`)
  if (info.private || info.gated) refuse(`${id}: ${row.hfRepo} is ${info.private ? 'private' : 'gated'}, so it cannot be downloaded without a Hugging Face login, which KzH does not have.`)
  const license = info.cardData?.license ?? info.tags?.find((t) => typeof t === 'string' && t.startsWith('license:'))?.slice('license:'.length)
  if (!license || typeof license !== 'string') refuse(`${id}: ${row.hfRepo} states no license, so it is not pinned.`)
  if (row.license && licenseKey(row.license) !== licenseKey(license)) refuse(`${id}: ${row.hfRepo} states the license ${license}, and the row says ${row.license}. Read the license, correct the row's by hand if it may be used, and run this again.`)

  // The file: its size and SHA-256 from the file list, and from the redirect of the URL KzH downloads.
  const tree = await json(`/api/models/${row.hfRepo}/tree/main`)
  const entry = Array.isArray(tree) ? tree.find((e) => e?.path === row.file) : null
  if (!entry) refuse(`${id}: ${row.hfRepo} has no ${row.file} in its main branch.`)
  if (!entry.lfs || !Number.isSafeInteger(entry.lfs.size) || !SHA.test(entry.lfs.oid ?? '')) refuse(`${id}: ${row.file} is not stored as a large file in ${row.hfRepo}, so the hub gives no SHA-256 of it.`)
  const head = await ask(`/${row.hfRepo}/resolve/main/${row.file}`, { method: 'HEAD', redirect: 'manual', headers: { 'accept-encoding': 'identity' } })
  if (head.status >= 400) refuse(`Hugging Face answered HTTP ${head.status} to a HEAD of ${row.file}.`)
  const size = Number(head.headers.get('x-linked-size'))
  const sha256 = etagOf(head.headers.get('x-linked-etag')).toLowerCase()
  if (!Number.isSafeInteger(size) || size <= 0 || !SHA.test(sha256)) refuse(`${id}: the HEAD of ${row.file} carries no x-linked-size and x-linked-etag of a large file (HTTP ${head.status}), so its size and SHA-256 are not known.`)
  if (size !== entry.lfs.size || sha256 !== entry.lfs.oid) refuse(`${id}: the file list says ${entry.lfs.size} bytes, SHA-256 ${entry.lfs.oid}, and the download says ${size} bytes, SHA-256 ${sha256}; they must agree.`)

  const commit = head.headers.get('x-repo-commit')
  say(`${id}: ${row.hfRepo}, ${row.file}${commit ? `, at commit ${commit}` : ''}`)
  say(`  size     ${size} bytes (${(size / GB).toFixed(1)} GB)`)
  say(`  sha256   ${sha256}`)
  say(`  license  ${license}${row.license ? ` (the row says ${row.license})` : ', written to the row, which named none'}`)
  if (isPinned(row)) {
    if (row.size === size && row.sha256 === sha256) { say(`Pinned already to these figures; ${manifest} is unchanged.`); return { row, written: false } }
    refuse(`${id} is pinned already to ${row.size} bytes, SHA-256 ${row.sha256}: the file on Hugging Face has changed since. Find out why before changing a pinned row by hand.`)
  }

  // The row with size and sha256 after its file, the rest as it was, and the manifest checked as KzH reads it.
  const text = JSON.parse(readFileSync(manifest, 'utf8'))
  const at = text.modules.findIndex((m) => m.id === id)
  const pinned = {}
  for (const [k, v] of Object.entries(text.modules[at])) {
    pinned[k] = v
    if (k === 'file') Object.assign(pinned, { size, sha256 }, row.license ? {} : { license })
  }
  text.modules[at] = pinned
  const tmp = `${manifest}.pin.tmp`
  writeFileSync(tmp, `${JSON.stringify(text, null, 2)}\n`)
  try { readManifest(tmp) } catch (err) { rmSync(tmp, { force: true }); refuse(`The pinned manifest would not load (${err.message}), so nothing was written.`) }
  renameSync(tmp, manifest)
  say(`Written to ${manifest}. KzH offers ${row.name ?? id} at its next start: Settings, Jev setup, Local models, Install.`)
  say('Git tracks that file: commit the change (and push it, for your other PCs), since Update-Harness.ps1 pulls nothing while a file has changes of its own.')
  return { row: pinned, written: true }
}

export function parseArgs(argv) {
  const out = { id: null, manifest: MANIFEST }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--manifest' && argv[i + 1]) out.manifest = resolve(argv[++i])
    else if (!a.startsWith('-') && !out.id) out.id = a
    else return null
  }
  return out.id ? out : null
}

if (runAsScript(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (!args) { console.error(USAGE); process.exit(EXIT.usage) }
  try {
    await pinModel({ ...args, say: (t) => console.log(t) })
    process.exitCode = EXIT.pinned
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    console.error(`Not pinned: ${err.message}`)
    process.exitCode = EXIT.refused
  }
}
