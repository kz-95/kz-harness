// Local models: llama.cpp's llama-server, bundled under <harness>/engine/llama,
// serving one GGUF from <harness>/models on 127.0.0.1 only. Started on demand by
// the `local` model provider, stopped after N idle minutes and on unload/exit.
// Each start gets a fresh API key (env LLAMA_API_KEY, never the command line),
// so other programs on the PC cannot use the server.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, join } from 'node:path'

export const LOCAL_PROVIDER = 'local'

const SHA = /^[0-9a-f]{64}$/
const ID = /^[a-z][a-z0-9._-]{0,47}$/
const FILE = /^[\w.-]+\.(gguf|zip)$/
// Official sources only: llama.cpp's own GitHub releases, and Hugging Face (the model's own organization; see README).
const SOURCE = /^https:\/\/(github\.com\/ggml-org\/llama\.cpp\/releases\/download\/|huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/)/

/**
 * config/local-models.json: the modules (engine builds and GGUF models) that can
 * be installed. Checked strictly: download URLs and file names come only from here.
 */
export function readManifest(path) {
  const { modules } = JSON.parse(readFileSync(path, 'utf8'))
  const seen = new Set()
  for (const m of modules) {
    const bad = (why) => { throw new Error(`local-models.json: ${m.id ?? '?'}: ${why}`) }
    if (!ID.test(m.id ?? '') || seen.has(m.id)) bad('id: unique, lowercase')
    seen.add(m.id)
    if (!['engine', 'model', 'vision'].includes(m.kind)) bad("kind: 'engine', 'model' or 'vision'")
    if (m.kind === 'engine' && !['cuda12', 'cuda13', 'vulkan', 'cpu'].includes(m.variant)) bad('variant: cuda12, cuda13, vulkan or cpu')
    if (!SOURCE.test(m.source ?? '')) bad('source: an official GitHub release or Hugging Face URL')
    if (!FILE.test(m.file ?? '') || !(m.kind === 'engine' ? /\.zip$/ : /\.gguf$/).test(m.file)) bad('file: a .zip (engine) or .gguf (model, vision) name')
    if (!(Number.isSafeInteger(m.size) && m.size > 0)) bad('size: bytes')
    if (!SHA.test(m.sha256 ?? '')) bad('sha256: 64 hex characters')
    if (m.kind === 'model' && m.agent && !/^[a-z][a-z0-9_-]*$/.test(m.agent.id ?? '')) bad('agent.id')
  }
  for (const v of modules.filter((m) => m.kind === 'vision')) {
    if (!modules.some((m) => m.kind === 'model' && m.id === v.for)) throw new Error(`local-models.json: ${v.id}: for: the model id this add-on extends`)
  }
  return modules
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * llama-server arguments. `gpuLayers` 'auto' lets the server fit layers into
 * free VRAM (--fit, on by default), keeping `fitTargetMiB` free; a number pins
 * it. One slot, so the whole context serves the one request. Log level 4 so
 * the "offloaded N/M layers to GPU" line can be read.
 */
export function llamaArgs({ modelPath, alias, port, ctx, gpuLayers = 'auto', fitTargetMiB = 256, thinking = false, threads }) {
  return [
    '-m', modelPath,
    '--alias', alias,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(ctx),
    '-np', '1',
    '-ngl', String(gpuLayers),
    '--fit-target', String(fitTargetMiB),
    '--jinja',
    // Thinking is slow on a 4 GB GPU; off unless the manifest entry sets "thinking": true.
    '--reasoning', thinking ? 'auto' : 'off',
    '--no-webui',
    '-lv', '4',
    ...(threads ? ['-t', String(threads)] : []),
  ]
}

/** First free TCP port on 127.0.0.1 from `from`, trying `tries` ports. */
export async function freePort(from, tries = 10) {
  for (let p = from; p < from + tries; p++) {
    const ok = await new Promise((done) => {
      const s = createServer().once('error', () => done(false)).once('listening', () => s.close(() => done(true)))
      s.listen(p, '127.0.0.1')
    })
    if (ok) return p
  }
  throw new Error(`no free port in ${from}-${from + tries - 1}`)
}

export async function sha256File(path) {
  const h = createHash('sha256')
  for await (const c of createReadStream(path)) h.update(c)
  return h.digest('hex')
}

/**
 * Resumable, verified download: bytes go to `<dest>.part` (resumed with a Range
 * request), the finished file must match `size` and `sha256`, and only then is
 * it renamed to `dest`. A mismatch deletes the partial file.
 */
export async function downloadVerified({ url, dest, size, sha256, fetch = globalThis.fetch, onProgress = () => {}, signal }) {
  const part = `${dest}.part`
  let have = (await stat(part).catch(() => null))?.size ?? 0
  if (have > size) { await unlink(part); have = 0 }
  if (have < size) {
    const r = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: 'follow', signal })
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`)
    if (have && r.status !== 206) have = 0 // server ignored the range: start over
    const fh = await open(part, have ? 'a' : 'w')
    try {
      for await (const chunk of r.body) {
        await fh.write(chunk)
        have += chunk.length
        if (have > size) throw new Error(`download larger than expected (${size} bytes)`)
        onProgress(have, size)
      }
    } finally { await fh.close() }
  }
  if (have !== size) throw new Error(`download incomplete: ${have} of ${size} bytes (press Download again to resume)`)
  const got = await sha256File(part)
  if (got !== sha256) {
    await unlink(part).catch(() => {})
    throw new Error(`SHA256 mismatch (expected ${sha256}, got ${got}); the file was deleted`)
  }
  await rename(part, dest)
  return { bytes: size, sha256: got }
}

/**
 * Online when any probe answers at all (any HTTP status); offline when every one
 * fails or times out. Cached for `ttlMs`; one probe in flight.
 */
export function createConnectivity({ fetch = globalThis.fetch, urls = ['https://api.typesafe.ai', 'https://api.deepseek.com'], timeoutMs = 2500, ttlMs = 30_000, now = Date.now } = {}) {
  let cache = null
  let pending = null
  const probe = (url) => fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) }).then(() => true, () => false)
  return {
    async online(force = false) {
      if (!force && cache && now() - cache.at < ttlMs) return cache.online
      pending ??= Promise.all(urls.map(probe)).then((r) => {
        cache = { at: now(), online: r.some(Boolean) }
        return cache.online
      }).finally(() => { pending = null })
      return pending
    },
    last: () => cache,
  }
}

// ponytail: keyword heuristic, used only offline when Jev can't classify; a local classifier call if it misroutes often.
const QUESTION = /^(what|why|how|when|where|who|which|whose|is|are|was|were|does|do|did|can|could|should|would|will|explain|describe|tell me|what's|whats)\b/i
/** Offline stand-in for Jev's task-or-question call. */
export const looksLikeQuestion = (text) => /\?\s*$/.test(text.trim()) || QUESTION.test(text.trim())

/** Offline routing rule: the preferred local agent that can run, else any local agent. */
export function offlinePick(agents, prefer = ['qwen-local', 'gemma-local']) {
  const local = agents.filter((a) => a.kind === 'local')
  return prefer.map((id) => local.find((a) => a.id === id)).find(Boolean) ?? local[0] ?? null
}

// ---------- OpenAI-compatible wire <-> DSH stream chunks ----------

const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
const flatten = (blocks) => blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? IMAGE_OMITTED : b.type === 'tool-result' ? flatten(b.content) : '')).join('')

const IMAGE_OMITTED = '[image omitted: this local model reads text only]'
/** User blocks -> OpenAI content: a string, or parts when an image is sent (`images`: attachmentId -> { mediaType, data }). */
function userContent(blocks, images) {
  const parts = blocks.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    if (b.type !== 'image') return null
    const img = images?.get(b.attachment?.attachmentId)
    return img ? { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${Buffer.from(img.data).toString('base64')}` } } : { type: 'text', text: IMAGE_OMITTED }
  }).filter(Boolean)
  return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts
}

/** DSH GenerateOptions -> llama-server /v1/chat/completions body. */
export function toWire(options, images) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const m of options.messages) {
    if (m.role === 'system') { const t = textOf(m.content); if (t) messages.push({ role: 'system', content: t }); continue }
    if (m.role === 'assistant') {
      const calls = m.content.filter((b) => b.type === 'tool-call').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
      messages.push({ role: 'assistant', content: textOf(m.content), ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    const results = m.content.filter((b) => b.type === 'tool-result')
    const content = userContent(m.content.filter((b) => b.type !== 'tool-result'), images)
    if (content.length || !results.length) messages.push({ role: 'user', content })
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: flatten(r.content) || '(no output)' })
  }
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.tools?.length ? { tools: options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop?.length ? { stop: options.stop } : {}),
  }
}

/** SSE `data:` payloads from a fetch body. */
export async function* sseData(body) {
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1)
      if (l.startsWith('data:')) yield l.slice(5).trim()
    }
  }
}

const FINISH = { stop: { kind: 'stop' }, tool_calls: { kind: 'tool-calls' }, length: { kind: 'max-tokens' } }
const failure = (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } })

/** OpenAI chat-completion chunks -> DSH StreamChunks (block-end, usage and finish at the end). */
export async function* translate(payloads) {
  const order = []
  let text, reasoning
  const tools = new Map()
  let finish, usage
  const open = (kind) => { const b = { index: order.length, kind, text: '' }; order.push(b); return b }
  for await (const p of payloads) {
    if (p === '[DONE]') break
    let c
    try { c = JSON.parse(p) } catch { yield failure('MALFORMED_RESPONSE', `bad SSE payload: ${p.slice(0, 120)}`); return }
    if (c.error) { yield failure('PROVIDER_ERROR', String(c.error.message ?? c.error).slice(0, 300)); return }
    for (const ch of c.choices ?? []) {
      const d = ch.delta ?? {}
      if (d.reasoning_content) {
        if (!reasoning) { reasoning = open('reasoning'); yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' } }
        reasoning.text += d.reasoning_content
        yield { type: 'reasoning-delta', index: reasoning.index, text: d.reasoning_content }
      }
      if (d.content) {
        if (!text) { text = open('text'); yield { type: 'block-start', index: text.index, blockType: 'text' } }
        text.text += d.content
        yield { type: 'text-delta', index: text.index, text: d.content }
      }
      for (const call of d.tool_calls ?? []) {
        let b = tools.get(call.index ?? 0)
        if (!b) { b = open('tool-call'); tools.set(call.index ?? 0, b); yield { type: 'block-start', index: b.index, blockType: 'tool-call' } }
        if (call.id) b.id = call.id
        if (call.function?.name) b.name = call.function.name
        const frag = call.function?.arguments ?? ''
        b.text += frag
        yield { type: 'tool-call-delta', index: b.index, id: b.id ?? '', ...(b.name ? { name: b.name } : {}), argumentsDelta: frag }
      }
      if (ch.finish_reason) finish = FINISH[ch.finish_reason] ?? { kind: 'error', failure: { code: String(ch.finish_reason).toUpperCase(), message: `model stopped: ${ch.finish_reason}` } }
    }
    if (c.usage) usage = { inputTokens: c.usage.prompt_tokens ?? 0, outputTokens: c.usage.completion_tokens ?? 0 }
  }
  for (const b of order) {
    const block = b.kind === 'tool-call' ? { type: 'tool-call', id: b.id ?? `call_${b.index}`, name: b.name ?? '', arguments: b.text || '{}' } : { type: b.kind, text: b.text }
    yield { type: 'block-end', index: b.index, block }
  }
  if (usage) yield { type: 'usage', usage }
  if (!order.length && (!finish || finish.kind === 'stop')) { yield failure('EMPTY_RESPONSE', 'local model returned no content'); return }
  yield { type: 'finish', reason: finish ?? { kind: 'stop' } }
}

// ---------- this PC: specs, engine build, fit, suggestions ----------

const GB = 1024 ** 3
const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`
const exec = (cmd, args) => new Promise((done) => {
  const c = nodeSpawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  c.stdout.on('data', (d) => { out += d })
  c.on('error', () => done(null))
  c.on('exit', (code) => done(code === 0 ? out : null))
  setTimeout(() => { c.kill(); done(null) }, 10_000).unref?.()
})
const vendorOf = (name) => (/nvidia|geforce|rtx|quadro/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'other')

/**
 * What this PC has: GPUs (VRAM, NVIDIA driver and its CUDA version), RAM, CPU,
 * free disk where the models go. `probe` is injectable for tests.
 */
export async function detectSpecs({ dir, probe = {} } = {}) {
  const run = probe.run ?? exec
  const osx = probe.os ?? { totalmem, freemem, cpus }
  const fsStat = probe.statfs ?? statfs
  const gpus = []
  let cuda = null
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'])
  if (smi) {
    for (const l of smi.trim().split('\n').filter(Boolean)) {
      const [name, total, used, driver] = l.split(',').map((x) => x.trim())
      gpus.push({ name, vendor: 'nvidia', vramGB: Number(total) / 1024, usedGB: Number(used) / 1024, driver })
    }
    cuda = Number(/CUDA Version:\s*([\d.]+)/.exec((await run('nvidia-smi', [])) ?? '')?.[1]) || null
  }
  if (process.platform === 'win32' || probe.run) {
    const cim = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }; "CORES|" + ((Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum)'])
    for (const l of (cim ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) {
      const [name, v] = l.split('|')
      if (name === 'CORES') { if (Number(v)) probe.cores = Number(v); continue }
      if (!gpus.some((g) => g.name === name)) gpus.push({ name, vendor: vendorOf(name), vramGB: vendorOf(name) === 'intel' ? 0 : Number(v) / GB || 0 })
    }
  }
  const cpuList = osx.cpus()
  let diskFreeBytes = null
  for (let d = dir; d; d = dirname(d) === d ? null : dirname(d)) {
    const s = await fsStat(d).catch(() => null)
    if (s) { diskFreeBytes = s.bavail * s.bsize; break }
  }
  return {
    gpus,
    cuda,
    ramGB: osx.totalmem() / GB,
    ramFreeGB: osx.freemem() / GB,
    cpu: { name: cpuList[0]?.model?.trim() ?? 'CPU', threads: cpuList.length, cores: probe.cores ?? null },
    diskFreeBytes,
  }
}

/** "RTX 3050 Laptop 4 GB · 24 GB RAM · i5-11400H 6 cores · 52 GB free" */
export function specsLine(s) {
  const g = s.gpus.find((x) => x.vendor === 'nvidia') ?? s.gpus.find((x) => x.vramGB > 0) ?? s.gpus[0]
  const gpu = g ? `${g.name.replace(/^NVIDIA\s+|GeForce\s+/gi, '').replace(/\s+GPU$/i, '')}${g.vramGB ? ` ${Math.round(g.vramGB)} GB` : ''}` : 'no GPU'
  const cpu = s.cpu.name.replace(/\(R\)|\(TM\)|CPU|@.*$|\d+th Gen|Intel|AMD/gi, '').replace(/\s+/g, ' ').trim()
  return [gpu, `${Math.round(s.ramGB)} GB RAM`, `${cpu} ${s.cpu.cores ?? s.cpu.threads} ${s.cpu.cores ? 'cores' : 'threads'}`, s.diskFreeBytes != null ? `${Math.round(s.diskFreeBytes / GB)} GB free` : null].filter(Boolean).join(' · ')
}

/** Engine build for this PC: CUDA when an NVIDIA driver supports it (newest that fits), else Vulkan for any other GPU, else CPU. */
export function pickEngineVariant(specs, modules) {
  const engines = modules.filter((m) => m.kind === 'engine')
  const has = (v) => engines.some((m) => m.variant === v)
  if (specs.gpus.some((g) => g.vendor === 'nvidia') && specs.cuda) {
    const cuda = [...new Set(engines.filter((m) => m.minCuda && specs.cuda >= m.minCuda).sort((a, b) => b.minCuda - a.minCuda).map((m) => m.variant))]
    if (cuda[0]) return cuda[0]
  }
  if (specs.gpus.some((g) => g.vendor !== 'other') && has('vulkan')) return 'vulkan'
  return 'cpu'
}

// ponytail: fixed bandwidth guesses (laptop GPU / dual-channel DDR4); measured speeds on the manifest's verified PC matched within ~15%.
const GPU_GBPS = 150
const CPU_GBPS = 25
const RESERVE_GB = 0.8 // desktop + CUDA context
/** GPU memory the engine can use for model layers on this PC. */
export const usableVramGB = (specs, variant) => (variant === 'cpu' ? 0 : Math.max(0, ...specs.gpus.filter((g) => (variant.startsWith('cuda') ? g.vendor === 'nvidia' : g.vendor !== 'intel')).map((g) => g.vramGB)))

/**
 * How a module would run here: gpu | split | cpu | no (won't fit, with reason).
 * Estimate: tokens/s from the bytes read per token over GPU and CPU memory bandwidth.
 */
export function rateModule(m, specs, variant, { installed = false } = {}) {
  const need = m.size * 1.1
  if (!installed && specs.diskFreeBytes != null && specs.diskFreeBytes < need) return { fit: 'no', label: "Won't fit", reason: `needs ${gb(need)} free disk, ${gb(specs.diskFreeBytes)} free` }
  if (m.minRamGB && specs.ramGB + 0.5 < m.minRamGB) return { fit: 'no', label: "Won't fit", reason: `needs ${m.minRamGB} GB RAM, this PC has ${Math.round(specs.ramGB)} GB` }
  if (m.kind === 'vision') return { fit: 'ok', label: 'Runs on the CPU next to its model' }
  if (m.kind !== 'model') return { fit: 'ok', label: 'Engine' }
  const weights = Math.max(0.5, (m.recommendedVramGB ?? m.size / GB + 1) - RESERVE_GB) // GB read per generated token
  const vram = usableVramGB(specs, variant)
  const words = (tps) => Math.max(1, Math.round(tps * 0.75))
  if (vram >= (m.recommendedVramGB ?? Infinity)) {
    const tps = GPU_GBPS / weights
    return { fit: 'gpu', label: 'Runs fully on GPU (fast)', wordsPerSec: words(tps) }
  }
  const frac = Math.min(1, Math.max(0, (vram - RESERVE_GB - 0.25) / weights))
  if (vram > 0 && vram >= (m.minVramGB ?? 0) && frac > 0.1) {
    const tps = 1 / ((frac * weights) / GPU_GBPS + ((1 - frac) * weights) / CPU_GBPS)
    return { fit: 'split', label: `Splits GPU + CPU (slower, ~${words(tps)} words/s est.)`, wordsPerSec: words(tps) }
  }
  const tps = CPU_GBPS / weights
  return { fit: 'cpu', label: `CPU only (slow, ~${words(tps)} words/s est.)`, wordsPerSec: words(tps) }
}

/** Default context and GPU layers for a model on this PC (manifest values unless the PC is small). */
export const defaultsFor = (m, specs, variant) => ({
  ctx: specs && specs.ramGB < 12 ? Math.min(4096, m.contextSize ?? 8192) : m.contextSize ?? 8192,
  gpuLayers: variant === 'cpu' ? 0 : m.gpuLayers ?? 'auto',
})

/** "Official · Stable · Verified (…)" */
export const badgesOf = (m) => [
  m.reliability?.startsWith('official') ? 'Official' : 'Community',
  m.reliability?.endsWith('stable') ? 'Stable' : 'Preview',
  m.verified ? `Verified${m.verifiedOn ? ` (${m.verifiedOn.split(',')[0]})` : ''}` : 'Not tested yet',
]

const TIER = { gpu: 2, split: 2, cpu: 1, ok: 0, no: -1 }
/**
 * Suggest 1-2 models for this PC. Reliability first (official-stable and verified
 * only), then fit (runs at a usable speed), then quality (manifest rank), then
 * Hugging Face downloads as a tie-breaker. Every other module says why it is not suggested.
 * @param {{m: object, rating: object, installed: boolean, downloads?: number}[]} rows
 */
export function suggest(rows, specs) {
  const why = {}
  const ok = []
  for (const r of rows.filter((x) => x.m.kind === 'model')) {
    if (r.installed) why[r.m.id] = 'already installed'
    else if (r.m.reliability !== 'official-stable') why[r.m.id] = `not suggested: ${r.m.reliability ?? 'unknown'} release`
    else if (!r.m.verified) why[r.m.id] = 'not suggested: not tested with this engine yet'
    else if (r.rating.fit === 'no') why[r.m.id] = r.rating.reason
    else ok.push(r)
  }
  const usable = (r) => TIER[r.rating.fit] + (r.rating.fit === 'split' && r.rating.wordsPerSec < 3 ? -1 : 0)
  ok.sort((a, b) => usable(b) - usable(a) || (a.m.rank ?? 99) - (b.m.rank ?? 99) || (b.downloads ?? 0) - (a.downloads ?? 0))
  const g = specs.gpus.find((x) => x.vramGB > 0)
  const pc = `${g ? `${Math.round(g.vramGB)} GB GPU + ` : ''}${Math.round(specs.ramGB)} GB RAM`
  const vision = (r) => rows.find((x) => x.m.kind === 'vision' && x.m.for === r.m.id && !x.installed)
  const picks = ok.slice(0, 2).map((r, i) => ({
    id: r.m.id,
    reason: (r.m.role === 'best-quality' || (i === 0 && r.m.rank === 1)
      ? `${r.m.name}: best quality that still runs on your ${pc} (${r.rating.label.replace(/ \(.*/, '')}, ~${r.rating.wordsPerSec} words/s)`
      : `${r.m.name}: lighter and faster (${r.rating.label.replace(/ \(.*/, '')}, ~${r.rating.wordsPerSec} words/s)`)
      + (vision(r) ? '; add the vision add-on to read images offline' : ''),
  }))
  for (const r of ok.slice(2)) why[r.m.id] = 'fits, but the suggested ones are better here'
  if (picks.length) return { picks, why }
  const smallest = rows.filter((x) => x.m.kind === 'model' && !x.installed).sort((a, b) => a.m.size - b.m.size)[0]
  const allInstalled = rows.filter((x) => x.m.kind === 'model').every((x) => x.installed)
  return {
    picks: [],
    why,
    none: allInstalled ? 'Every model in the list is already installed.'
      : `Nothing in the list runs well on this PC${smallest ? `; the smallest is ${smallest.m.name} (${gb(smallest.m.size)}${smallest.rating.fit === 'no' ? `, ${smallest.rating.reason}` : ''})` : ''}. The cloud agents (Claude, Codex, DeepSeek) need no download.`,
  }
}

/** `/install-llm` and `/remove-llm` arguments: ids (or all) and a trailing `confirm`. */
export function parseLlmArgs(raw, ids) {
  const words = String(raw ?? '').trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  const confirm = words.at(-1) === 'confirm'
  const rest = confirm ? words.slice(0, -1) : words
  const all = rest.includes('all')
  const picked = rest.filter((w) => w !== 'all')
  return { ids: all ? [...ids] : [...new Set(picked.filter((w) => ids.includes(w)))], unknown: picked.filter((w) => !ids.includes(w)), all, confirm, empty: rest.length === 0 }
}

// ---------- the engine ----------

const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
/** Unzip with the OS's own bsdtar (Windows 10+ ships it); no extra dependency. */
function unzip(zip, dir, spawn) {
  return new Promise((done, fail) => {
    const c = spawn(TAR, ['-xf', zip, '-C', dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr.on('data', (d) => { err += d })
    c.on('error', fail)
    c.on('exit', (code) => (code === 0 ? done() : fail(new Error(`unzip failed (${code}): ${err.slice(0, 200)}`))))
  })
}

/**
 * @param {object} p
 * @param {object[]} p.modules   readManifest() result
 * @param {string} p.engineDir   folder for llama-server.exe and its DLLs
 * @param {string} p.modelsDir   folder for *.gguf
 * @param {string} p.settingsFile  UI settings (chat model, idle minutes, GPU layers)
 * @param {number} [p.port]      first port to try (next ones if taken)
 * @param {number} [p.contextSize]  overrides every model's context size
 * @param {() => Promise<object>} [p.specs]  detectSpecs() for this PC (cached by the caller)
 * @param {(m: object) => void} [p.onChange]  a module was installed, removed or verified
 */
export function createLocalModels({ modules, engineDir, modelsDir, settingsFile, port: basePort = 8081, contextSize, specs: getSpecs = async () => null, spawn = nodeSpawn, fetch = globalThis.fetch, log = () => {}, onChange = () => {} }) {
  const exe = join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  const engines = modules.filter((m) => m.kind === 'engine')
  const models = modules.filter((m) => m.kind === 'model')
  const mod = (id) => modules.find((m) => m.id === id)
  let engine = null // { child, modelId, port, key, ready, startedAt, gpuLayers, tail }
  let busy = 0
  let idleTimer = null
  let lock = Promise.resolve()
  let installing = Promise.resolve()
  const jobs = new Map() // module id -> { state: queued | downloading | extracting | done | failed, received, total, bytesPerSec, error }

  const DEFAULTS = { chatModel: null, idleMinutes: 10, gpuLayers: null }
  const readSettings = async () => ({ ...DEFAULTS, ...JSON.parse(await readFile(settingsFile, 'utf8').catch(() => '{}')) })
  async function setSettings(patch) {
    const s = { ...(await readSettings()) }
    if (patch.idleMinutes !== undefined) {
      if (!(Number.isInteger(patch.idleMinutes) && patch.idleMinutes >= 1 && patch.idleMinutes <= 240)) throw new Error('idle minutes: whole number 1-240')
      s.idleMinutes = patch.idleMinutes
    }
    if (patch.gpuLayers !== undefined) {
      if (!(patch.gpuLayers === null || patch.gpuLayers === 'auto' || (Number.isInteger(patch.gpuLayers) && patch.gpuLayers >= 0 && patch.gpuLayers <= 999))) throw new Error("GPU layers: 'auto' or 0-999")
      s.gpuLayers = patch.gpuLayers
    }
    if (patch.chatModel !== undefined) {
      if (!(await installed()).some((m) => m.id === patch.chatModel)) throw new Error(`${patch.chatModel} is not installed`)
      s.chatModel = patch.chatModel
    }
    await mkdir(dirname(settingsFile), { recursive: true })
    await writeFile(`${settingsFile}.tmp`, JSON.stringify(s, null, 2))
    await rename(`${settingsFile}.tmp`, settingsFile)
    return s
  }

  // Install markers. Engine: <engineDir>/.installed/<id>.json once its zip was verified and unpacked.
  // Model/vision: <modelsDir>/.verified/<file>.json with the file's size, mtime and hash, so a 5 GB file is hashed once.
  const engineMarker = (m) => join(engineDir, '.installed', `${m.id}.json`)
  const fileMarker = (m) => join(modelsDir, '.verified', `${m.file}.json`)
  const readJson = (p) => readFile(p, 'utf8').then(JSON.parse, () => null)
  const writeJson = async (p, v) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(v)) }
  const hashing = new Map() // module id -> Promise

  /** installed | missing | verifying | corrupt (file present, SHA256 differs from the manifest). */
  async function stateOf(m) {
    if (['queued', 'downloading', 'extracting'].includes(jobs.get(m.id)?.state)) return 'missing'
    if (m.kind === 'engine') return (await stat(exe).catch(() => null))?.isFile() && (await readJson(engineMarker(m)))?.sha256 === m.sha256 ? 'installed' : 'missing'
    const path = join(modelsDir, m.file)
    const st = await stat(path).catch(() => null)
    if (!st?.isFile()) return 'missing'
    const mark = await readJson(fileMarker(m))
    if (mark && mark.size === st.size && Math.floor(mark.mtimeMs) === Math.floor(st.mtimeMs)) return mark.sha256 === m.sha256 ? 'installed' : 'corrupt'
    // A file placed by hand: hash it once, in the background.
    if (!hashing.has(m.id)) {
      hashing.set(m.id, sha256File(path).then(async (sha256) => {
        await writeJson(fileMarker(m), { size: st.size, mtimeMs: st.mtimeMs, sha256 })
        log(`local: ${m.file}: SHA256 ${sha256 === m.sha256 ? 'verified' : 'DOES NOT MATCH the manifest'}`)
        onChange(m)
      }).catch((err) => log(`local: ${m.file}: could not hash (${err.message})`)).finally(() => hashing.delete(m.id)))
    }
    return 'verifying'
  }
  /** Wait for background hashing (tests). */
  const settled = () => Promise.all([...hashing.values()])

  /** The installed engine build (every module of one variant installed), or null. */
  async function engineVariant() {
    const st = await Promise.all(engines.map(stateOf))
    const variants = [...new Set(engines.map((e) => e.variant))]
    return variants.find((v) => engines.every((e, i) => e.variant !== v || st[i] === 'installed')) ?? null
  }
  const engineInstalled = async () => (await engineVariant()) !== null
  async function installed(kind = 'model') {
    const list = modules.filter((m) => m.kind === kind)
    const st = await Promise.all(list.map(stateOf))
    return list.filter((_, i) => st[i] === 'installed')
  }
  const visionFor = async (modelId) => (await installed('vision')).find((v) => v.for === modelId) ?? null

  /** Router agents for installed models (manifest `agent`); none until the model is installed. */
  async function agents(persona) {
    return (await installed()).filter((m) => m.agent).map((m) => ({
      id: m.agent.id, provider: 'spawn', description: m.agent.description, enabled: true, llm: { provider: LOCAL_PROVIDER, model: m.id }, persona,
    }))
  }

  /** Router readiness for a local agent: no login, no quota; the engine must be installed. */
  async function readiness(modelId) {
    if (!(await engineInstalled())) return { installed: false, loggedIn: false, detail: 'llama.cpp engine not installed: type /install-llm' }
    const m = (await installed()).find((x) => x.id === modelId)
    if (!m) return { installed: false, loggedIn: false, detail: `${mod(modelId)?.file ?? modelId} not installed: type /install-llm` }
    return { installed: true, loggedIn: true, detail: `free, local: ${m.file}` }
  }

  /** The model answering direct questions: the chosen one if installed, else the first installed in manifest order. */
  async function chatModel() {
    if (!(await engineInstalled())) return null
    const have = await installed()
    const { chatModel: want } = await readSettings()
    return (have.find((m) => m.id === want) ?? have[0])?.id ?? null
  }

  async function runDefaults(m) {
    const d = defaultsFor(m, await getSpecs().catch(() => null), await engineVariant())
    return { ctx: Math.min(contextSize ?? d.ctx, m.maxContext ?? Infinity), gpuLayers: d.gpuLayers }
  }

  function kill(child) {
    if (!child || child.exitCode !== null) return
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }
  const onExit = () => kill(engine?.child)
  process.on('exit', onExit)

  async function stop() {
    clearTimeout(idleTimer)
    const e = engine
    engine = null
    if (e) { kill(e.child); log(`local: engine stopped (${e.modelId})`) }
  }

  async function start(modelId) {
    const m = (await installed()).find((x) => x.id === modelId)
    if (!m) throw new Error(`local model ${modelId} is not installed (type /install-llm)`)
    if (!(await engineInstalled())) throw new Error('llama.cpp engine not installed (type /install-llm)')
    const s = await readSettings()
    const port = await freePort(basePort)
    const key = randomBytes(24).toString('hex')
    const d = await runDefaults(m)
    const gpuLayers = s.gpuLayers ?? d.gpuLayers
    const vision = await visionFor(m.id)
    const args = [
      ...llamaArgs({ modelPath: join(modelsDir, m.file), alias: m.id, port, ctx: d.ctx, gpuLayers, thinking: !!m.thinking }),
      // The vision projector stays on the CPU so the GPU keeps the text model's layers.
      ...(vision ? ['--mmproj', join(modelsDir, vision.file), '--no-mmproj-offload'] : ['--no-mmproj']),
    ]
    const child = spawn(exe, args, { cwd: engineDir, env: { ...process.env, LLAMA_API_KEY: key }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const e = { child, modelId: m.id, port, key, ctx: d.ctx, vision: !!vision, startedAt: Date.now(), gpuLayers: null, tail: [] }
    const onLine = (chunk) => {
      for (const l of String(chunk).split('\n')) {
        const off = /offloaded (\d+)\/(\d+) layers to GPU/.exec(l)
        if (off) e.gpuLayers = { gpu: Number(off[1]), total: Number(off[2]) }
        if (l.trim()) { e.tail.push(l.trim()); if (e.tail.length > 30) e.tail.shift() }
      }
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)
    const exited = new Promise((r) => child.once('exit', r)).then((code) => { if (engine === e) engine = null; return code })
    child.once('error', (err) => { e.tail.push(err.message); if (engine === e) engine = null })
    engine = e
    log(`local: engine starting ${m.id} on 127.0.0.1:${port} (ctx ${d.ctx}, GPU layers ${gpuLayers}${vision ? ', vision' : ''})`)
    e.ready = (async () => {
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null || engine !== e) throw new Error(`llama-server exited: ${e.tail.slice(-3).join(' | ')}`)
        const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
        if (ok) { log(`local: engine ready: ${m.id}, ${e.gpuLayers ? `${e.gpuLayers.gpu}/${e.gpuLayers.total} layers on GPU` : 'GPU layers unknown'}`); return }
        await Promise.race([sleep(500), exited])
      }
      throw new Error('llama-server did not become ready within 5 minutes')
    })()
    e.ready.catch(() => { if (engine === e) stop() })
    return e.ready
  }

  const scheduleIdle = async () => {
    clearTimeout(idleTimer)
    if (busy > 0 || !engine) return
    const { idleMinutes } = await readSettings()
    if (busy > 0) return
    idleTimer = setTimeout(() => { if (busy === 0) stop() }, idleMinutes * 60_000)
    idleTimer.unref?.()
  }

  /**
   * Hold the engine on `modelId` for one request. Starts it, or switches model
   * once no other request is using it. Returns the connection and a release().
   */
  function acquire(modelId) {
    // ponytail: one model loaded at a time (4 GB VRAM); a request for the other model waits for in-flight ones.
    const got = lock.then(async () => {
      while (busy > 0 && engine && engine.modelId !== modelId) await sleep(500)
      clearTimeout(idleTimer)
      busy++
      try {
        if (!engine || engine.modelId !== modelId) { await stop(); await start(modelId) } else await engine.ready
      } catch (err) { busy--; scheduleIdle(); throw err }
      const e = engine
      let released = false
      return { url: `http://127.0.0.1:${e.port}`, key: e.key, vision: e.vision, release: () => { if (!released) { released = true; busy--; scheduleIdle() } } }
    })
    lock = got.catch(() => {})
    return got
  }

  /**
   * One chat completion, streamed as DSH chunks. `attachments` (DSH's attachment
   * store) supplies image bytes when the model has its vision add-on installed.
   */
  async function* stream(options, { attachments } = {}) {
    let conn
    try { conn = await acquire(options.model) } catch (err) { yield failure('LOCAL_ENGINE', err.message.slice(0, 300)); return }
    try {
      let images
      if (conn.vision && attachments) {
        images = new Map()
        const refs = options.messages.flatMap((m) => m.content.filter((b) => b.type === 'image').map((b) => b.attachment))
        for (const ref of refs) images.set(ref.attachmentId, await attachments.readImageRequest(ref, { maxPixels: 1024 * 1024, maxBytes: 1024 * 1024 }, options.signal))
      }
      const r = await fetch(`${conn.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${conn.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(toWire(options, images)),
        signal: options.signal,
      })
      if (!r.ok) { yield failure(`HTTP_${r.status}`, (await r.text().catch(() => '')).slice(0, 300) || `llama-server HTTP ${r.status}`); return }
      yield* translate(sseData(r.body))
    } finally { conn.release() }
  }

  /** Download, verify (size + SHA256) and place one module. */
  async function installOne(m) {
    const job = jobs.get(m.id)
    Object.assign(job, { state: 'downloading', startedAt: Date.now(), received: 0 })
    let lastLog = 0
    let resumedAt = null
    const onProgress = (n) => {
      resumedAt ??= n
      job.received = n
      const secs = (Date.now() - job.startedAt) / 1000
      job.bytesPerSec = secs > 0 ? (n - resumedAt) / secs : 0
      if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`local: ${m.id} ${Math.floor((n / m.size) * 100)}% (${(job.bytesPerSec / 1e6).toFixed(1)} MB/s)`) }
    }
    log(`local: installing ${m.id} from ${m.source} (${gb(m.size)})`)
    try {
      if (m.kind === 'engine') {
        await mkdir(engineDir, { recursive: true })
        const zip = join(engineDir, m.file)
        await downloadVerified({ url: m.source, dest: zip, size: m.size, sha256: m.sha256, fetch, onProgress })
        job.state = 'extracting'
        await unzip(zip, engineDir, spawn)
        await unlink(zip)
        await writeJson(engineMarker(m), { sha256: m.sha256 })
      } else {
        await mkdir(modelsDir, { recursive: true })
        const dest = join(modelsDir, m.file)
        await downloadVerified({ url: m.source, dest, size: m.size, sha256: m.sha256, fetch, onProgress })
        const st = await stat(dest)
        await writeJson(fileMarker(m), { size: st.size, mtimeMs: st.mtimeMs, sha256: m.sha256 })
      }
      job.state = 'done'
      job.received = m.size
      log(`local: installed ${m.id} (${m.file}, SHA256 verified)`)
    } catch (err) {
      job.state = 'failed'
      job.error = err.message
      log(`local: install of ${m.id} failed: ${err.message}`)
      throw err
    } finally { onChange(m) }
  }

  /**
   * What installing `ids` takes, in order: the engine build for this PC when none
   * is installed, a vision add-on's model, then the modules; installed ones skipped.
   */
  async function plan(ids) {
    const want = ids.map((id) => { const m = mod(id); if (!m) throw new Error(`unknown module ${id}`); return m })
    const out = []
    const add = async (m) => { if (!out.includes(m) && (await stateOf(m)) !== 'installed' && !['queued', 'downloading', 'extracting'].includes(jobs.get(m.id)?.state)) out.push(m) }
    if (!(await engineInstalled()) && want.some((m) => m.kind !== 'engine')) {
      const variant = pickEngineVariant((await getSpecs().catch(() => null)) ?? { gpus: [] }, modules)
      for (const e of engines.filter((x) => x.variant === variant)) await add(e)
    }
    for (const m of want) {
      if (m.kind === 'engine') for (const e of engines.filter((x) => x.variant === m.variant)) await add(e)
      else { if (m.kind === 'vision') await add(mod(m.for)); await add(m) }
    }
    return out
  }

  /** Install modules one after another, in the background; status() and the log show progress. */
  async function install(ids) {
    const todo = await plan(Array.isArray(ids) ? ids : [ids])
    const specs = await getSpecs().catch(() => null)
    const need = todo.reduce((n, m) => n + m.size * 1.1, 0)
    if (specs?.diskFreeBytes != null && specs.diskFreeBytes < need) throw new Error(`not enough disk space: needs ${gb(need)}, ${gb(specs.diskFreeBytes)} free`)
    for (const m of todo) jobs.set(m.id, { state: 'queued', received: 0, total: m.size, bytesPerSec: 0, error: null })
    const run = installing.then(async () => {
      for (const m of todo) {
        try { await installOne(m) } catch {
          for (const rest of todo.slice(todo.indexOf(m) + 1)) Object.assign(jobs.get(rest.id), { state: 'failed', error: `skipped: ${m.id} failed` })
          return
        }
      }
    })
    installing = run.catch(() => {})
    return todo.map((m) => m.id)
  }

  async function remove(id) {
    const m = mod(id)
    if (!m) throw new Error(`unknown module ${id}`)
    const using = engine && (m.kind === 'engine' || engine.modelId === m.id || (m.kind === 'vision' && engine.modelId === m.for))
    if (using && busy > 0) throw new Error(`${m.kind === 'engine' ? 'a local model' : m.name} is answering right now; try again when it is idle`)
    const stopped = !!using
    if (using) await stop()
    if (m.kind === 'engine') await rm(engineDir, { recursive: true, force: true }) // every engine build lives in this one folder
    else { await rm(join(modelsDir, m.file), { force: true }); await rm(fileMarker(m), { force: true }) }
    jobs.delete(m.id)
    onChange(m)
    return { stopped }
  }

  async function status() {
    const s = await readSettings()
    const states = await Promise.all(modules.map(stateOf))
    const ready = engine ? await Promise.race([engine.ready.then(() => true, () => false), sleep(0).then(() => false)]) : false
    return {
      engine: { installed: await engineInstalled(), variant: await engineVariant(), running: !!engine, ready, model: engine?.modelId ?? null, vision: !!engine?.vision, port: engine?.port ?? null, ctx: engine?.ctx ?? null, gpuLayers: engine?.gpuLayers ?? null, startedAt: engine?.startedAt ?? null, busy },
      settings: { ...s, chatModel: await chatModel() },
      modules: modules.map((m, i) => ({
        id: m.id, kind: m.kind, variant: m.variant, for: m.for, name: m.name, file: m.file, size: m.size, license: m.license, notes: m.notes, source: m.source,
        agent: m.agent?.id ?? null, state: states[i], job: jobs.get(m.id) ?? null, badges: badgesOf(m),
      })),
    }
  }

  return {
    readiness, installed, agents, chatModel, stream, acquire, status, install, plan, remove, setSettings, settled, engineVariant, visionFor,
    start: async (id) => { const c = await acquire(id); c.release() },
    stop: async () => { if (busy > 0) throw new Error('a local model is answering right now'); await stop() },
    dispose: async () => { process.off('exit', onExit); await stop() },
    contextOf: (id) => { const m = mod(id); return m ? Math.min(contextSize ?? m.contextSize ?? 8192, m.maxContext ?? Infinity) : contextSize ?? 8192 },
    modelOf: mod,
    modules,
  }
}

/** DSH model provider `local`: every installed model, served through the engine above. */
export function localAdapter(local, { attachments } = {}) {
  const info = async (provider, m) => ({
    provider, id: m.id, name: `${m.name ?? m.id} (local)`, description: 'Free, private, runs on this PC with llama.cpp. Weaker than the cloud models.',
    inputModalities: (await local.visionFor(m.id)) ? ['text', 'image'] : ['text'],
  })
  return {
    providerInfo: (p) => ({ id: p, name: 'Local (llama.cpp)' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async (p) => Promise.all((await local.installed()).map((m) => info(p, m))),
    async resolveModel(p, id) {
      return { ...(await info(p, local.modelOf(id) ?? { id })), context: { contextWindow: local.contextOf(id) } }
    },
    async prepareCall(p, m, s) { return { model: await this.resolveModel(p, m, s), stream: (o) => this.stream(o) } },
    stream: (options) => local.stream(options, { attachments: attachments?.() }),
  }
}

// ---------- picker data and the /install-llm, /remove-llm commands ----------

const size = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`)

/**
 * Everything the install picker shows: this PC, the engine build it needs, each
 * model / add-on with its fit, badges and install state, and the suggestions.
 * `downloads`: Hugging Face download counts by repo (tie-breaker only, may be empty).
 */
export async function buildCatalog(local, specs, { downloads = {} } = {}) {
  const st = await local.status()
  const variant = st.engine.variant ?? pickEngineVariant(specs, local.modules)
  const byIdState = new Map(st.modules.map((x) => [x.id, x]))
  const rows = local.modules.filter((m) => m.kind !== 'engine').map((m) => {
    const installed = byIdState.get(m.id).state === 'installed'
    return { m, installed, rating: rateModule(m, specs, variant, { installed }), downloads: downloads[m.hfRepo] }
  })
  const sug = suggest(rows, specs)
  const engineMods = local.modules.filter((m) => m.kind === 'engine' && m.variant === variant)
  return {
    pc: specsLine(specs),
    specs,
    engine: { variant, installed: st.engine.installed, installedVariant: st.engine.variant, ids: engineMods.map((m) => m.id), name: engineMods[0]?.name ?? variant, size: engineMods.reduce((n, m) => n + m.size, 0) },
    modules: rows.map(({ m, installed, rating }) => ({
      ...byIdState.get(m.id), installed, rating, role: m.role ?? null, repo: m.hfRepo ?? m.source.split('/').slice(3, 5).join('/'),
      suggested: sug.picks.some((p) => p.id === m.id), reason: sug.picks.find((p) => p.id === m.id)?.reason ?? null, whyNot: sug.why[m.id] ?? null,
    })),
    suggestions: sug.picks,
    none: sug.none ?? null,
  }
}

const listLine = (x) => `- \`${x.id}\` ${x.name} · ${size(x.size)} · ${x.rating.fit === 'no' ? `won't fit: ${x.rating.reason}` : x.rating.label}${x.agent ? ` · agent ${x.agent}` : x.for ? ` · add-on for ${x.for}` : ''} · ${x.installed ? '✓ installed' : '—'}`

/** `/install-llm [ids…|all]`: bare lists and suggests; with ids starts the verified install in the background. */
export async function installLlmCommand(raw, { local, catalog }) {
  const c = await catalog()
  const ids = c.modules.map((x) => x.id).concat(c.engine.ids)
  const a = parseLlmArgs(raw, ids)
  if (a.unknown.length) return { kind: 'error', text: `Unknown: ${a.unknown.join(', ')}. Valid ids: ${ids.join(', ')}` }
  if (a.empty) {
    return {
      kind: 'success',
      text: [
        `**Your PC:** ${c.pc}`,
        c.suggestions.length ? `**Suggested:**\n${c.suggestions.map((s) => `- ${s.reason}`).join('\n')}` : `**Suggested:** ${c.none}`,
        '', '**Local models**', ...c.modules.map(listLine),
        '', `Engine for this PC: ${c.engine.name}${c.engine.installed ? ' (installed)' : ` (${size(c.engine.size)}, installed first)`}.`,
        'Install with `/install-llm <id…>` or `/install-llm all`, or pick in Settings → Jev setup → Local models. Official sources only; every file is SHA256-verified.',
      ].join('\n'),
    }
  }
  const want = a.all ? c.modules.filter((x) => !x.installed && x.rating.fit !== 'no').map((x) => x.id) : a.ids
  const blocked = c.modules.filter((x) => want.includes(x.id) && !x.installed && x.rating.fit === 'no')
  if (blocked.length) return { kind: 'error', text: blocked.map((x) => `${x.name} won't fit: ${x.rating.reason}`).join('\n') }
  const todo = await local.install(want)
  if (!todo.length) return { kind: 'success', text: 'Already installed.' }
  const mods = todo.map((id) => local.modelOf(id))
  return { kind: 'success', text: `Installing ${mods.map((m) => `${m.name} (${size(m.size)})`).join(', ')}. Official source, resumable, SHA256-verified. Watch progress in Settings → Jev setup → Local models or the log; the model's agent switches on when it is done.` }
}

/** `/remove-llm <ids…> [confirm]`: without `confirm` only says what would be deleted. */
export async function removeLlmCommand(raw, { local }) {
  const st = await local.status()
  const installedIds = st.modules.filter((x) => x.state === 'installed' || x.state === 'corrupt').map((x) => x.id)
  const a = parseLlmArgs(raw, installedIds)
  if (a.unknown.length) return { kind: 'error', text: `Not installed or unknown: ${a.unknown.join(', ')}. Installed: ${installedIds.join(', ') || 'nothing'}` }
  if (a.empty || !a.ids.length) {
    return { kind: 'success', text: installedIds.length ? `Installed: ${installedIds.map((id) => `\`${id}\``).join(', ')}. Type \`/remove-llm <id…>\`, then confirm.` : 'No local model or engine is installed.' }
  }
  const mods = a.ids.map((id) => local.modelOf(id))
  const what = mods.map((m) => (m.kind === 'engine' ? `the llama.cpp engine folder (engine/llama, includes ${m.file.replace(/\.zip$/, '')})` : `${m.file} (${size(m.size)})`))
  if (!a.confirm) return { kind: 'success', text: `This deletes: ${what.join(', ')}. Type \`/remove-llm ${a.ids.join(' ')} confirm\` to delete.` }
  const notes = []
  for (const m of mods) {
    const r = await local.remove(m.id)
    notes.push(`${m.name}${r.stopped ? ' (stopped it first)' : ''}`)
  }
  return { kind: 'success', text: `Removed: ${notes.join(', ')}.` }
}
