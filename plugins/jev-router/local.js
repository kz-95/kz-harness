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
import { localAgentFor, quickestLocal } from './effort.js'
import { createBudgetWatchdog, createResidency } from './residency.js'

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

/** What llama.cpp's --fit keeps free on each GPU when no VRAM budget says otherwise, in MiB. */
export const FIT_TARGET_MIB = 256

/**
 * llama-server arguments. `gpuLayers` 'auto' lets the server fit layers into
 * free VRAM (--fit, on by default), keeping `fitTargetMiB` free; a number pins
 * it. One slot, so the whole context serves the one request. Log level 4 so
 * the "offloaded N/M layers to GPU" line can be read. `threads` becomes -t;
 * start() always sets it, from the core budget or defaultThreads().
 */
export function llamaArgs({ modelPath, alias, port, ctx, gpuLayers = 'auto', fitTargetMiB = FIT_TARGET_MIB, thinking = false, threads }) {
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
 * fails or times out. The endpoints are tried one at a time and the first answer
 * ends the check, so once connectivity is known the later ones are never
 * contacted. The budget is split evenly across them, so a slow first endpoint
 * cannot starve the rest and the whole check still fits in `timeoutMs`. Cached
 * for `ttlMs`; one probe in flight. The default list is the Jev endpoint alone:
 * DeepSeek is deliberately not probed, because a connectivity check must not
 * contact a provider this run has not chosen. With one endpoint the whole
 * `timeoutMs` budget goes to it, so the worst case is unchanged.
 */
export function createConnectivity({ fetch = globalThis.fetch, urls = ['https://api.typesafe.ai'], timeoutMs = 2500, ttlMs = 30_000, now = Date.now } = {}) {
  let cache = null
  let pending = null
  const each = Math.max(1, Math.floor(timeoutMs / urls.length))
  const reached = async () => {
    for (const url of urls) {
      if (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(each) }).then(() => true, () => false)) return true
    }
    return false
  }
  return {
    async online(force = false) {
      if (!force && cache && now() - cache.at < ttlMs) return cache.online
      pending ??= reached().then((online) => {
        cache = { at: now(), online }
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

/**
 * Offline routing rule: the strongest local agent that can run, by the manifest's `role`.
 * Ranked by `local-high` itself, so the effort ladder and offline mode cannot disagree
 * about which installed model is the best one.
 */
export function offlinePick(agents) {
  const id = localAgentFor('local-high', agents)
  return agents.find((a) => a.id === id) ?? null
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
 * What Win32_VideoController.AdapterRAM reads for every card of 4 GB or more. The field is 32 bits
 * wide and stops here, so a card at this figure has at least this much and nobody can say how much
 * more: an 8 GB card and a 4 GB one read the same.
 */
const ADAPTER_RAM_CEILING = 4293918720
/** A GPU sized from that ceiling in words: its size is not known, only that it is at least the ceiling. */
const CAPPED_GB = Math.round(ADAPTER_RAM_CEILING / GB)
const CAPPED_SIZE = `memory unknown, ${CAPPED_GB} GB or more`

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
      // A size at the ceiling is marked, so nothing works out a VRAM budget from a size the card may
      // well not have (the budget's --fit-target). nvidia-smi's own size wins for a card it lists.
      if (!gpus.some((g) => g.name === name)) gpus.push({ name, vendor: vendorOf(name), vramGB: vendorOf(name) === 'intel' ? 0 : Number(v) / GB || 0, ...(Number(v) >= ADAPTER_RAM_CEILING && { sizeCapped: true }) })
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

/**
 * "RTX 3050 Laptop 4 GB · 24 GB RAM · i5-11400H 6 cores · 52 GB free". A GPU sized from AdapterRAM's
 * ceiling says its size is unknown, "Radeon RX 6600 (memory unknown, 4 GB or more)", rather than print
 * the ceiling as if it were the size.
 */
export function specsLine(s) {
  const g = s.gpus.find((x) => x.vendor === 'nvidia') ?? s.gpus.find((x) => x.vramGB > 0) ?? s.gpus[0]
  const vram = g?.sizeCapped ? ` (${CAPPED_SIZE})` : g?.vramGB ? ` ${Math.round(g.vramGB)} GB` : ''
  const gpu = g ? `${g.name.replace(/^NVIDIA\s+|GeForce\s+/gi, '').replace(/\s+GPU$/i, '')}${vram}` : 'no GPU'
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
/** The GPUs an engine build can put layers on: NVIDIA's for a CUDA build, any but Intel's for Vulkan, none for the CPU build. */
const gpusFor = (specs, variant) => (variant === 'cpu' ? [] : specs.gpus.filter((g) => (variant.startsWith('cuda') ? g.vendor === 'nvidia' : g.vendor !== 'intel')))
/** GPU memory the engine can use for model layers on this PC. */
export const usableVramGB = (specs, variant) => Math.max(0, ...gpusFor(specs, variant).map((g) => g.vramGB))

/**
 * How a module would run here: gpu | split | cpu | unknown | no (won't fit, with reason).
 * Estimate: tokens/s from the bytes read per token over GPU and CPU memory bandwidth.
 *
 * A GPU sized from AdapterRAM's ceiling (detectSpecs) has at least the ceiling and nobody can say how
 * much more, so it is not read as a 4 GB card. What the ceiling holds runs fully on it whatever its
 * size, and is rated 'gpu' as before. Anything bigger may split or may run fully on it, which is not
 * known: it is rated 'unknown', with no single speed (`wordsPerSec` null) but the two ends it lies
 * between (`wordsPerSecRange`): split as on a card of the ceiling's size, and fully on the GPU.
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
  const below = (() => {
    const frac = Math.min(1, Math.max(0, (vram - RESERVE_GB - 0.25) / weights))
    if (vram > 0 && vram >= (m.minVramGB ?? 0) && frac > 0.1) {
      const tps = 1 / ((frac * weights) / GPU_GBPS + ((1 - frac) * weights) / CPU_GBPS)
      return { fit: 'split', label: `Splits GPU + CPU (slower, ~${words(tps)} words/s est.)`, wordsPerSec: words(tps) }
    }
    const tps = CPU_GBPS / weights
    return { fit: 'cpu', label: `CPU only (slow, ~${words(tps)} words/s est.)`, wordsPerSec: words(tps) }
  })()
  if (!gpusFor(specs, variant).some((g) => g.sizeCapped)) return below
  const range = [below.wordsPerSec, words(GPU_GBPS / weights)]
  return { fit: 'unknown', label: `Runs on the GPU as far as its memory allows (this GPU's memory is unknown, ${CAPPED_GB} GB or more: ~${range[0]} to ~${range[1]} words/s est.)`, wordsPerSec: null, wordsPerSecRange: range }
}

/** Compute buffers and the scratch llama.cpp keeps beside the weights, whatever the context. */
const COMPUTE_GB = 0.3
/** What a token of context costs in the KV cache when the manifest does not say. */
const FALLBACK_KV_GB_PER_TOKEN = 100 / 1024 / 1024

/**
 * What a token of context costs this model in the KV cache, in GB.
 *
 * The manifest may say outright (`kvGbPerToken`). Otherwise it is read back out of the figure the
 * manifest does carry: `recommendedVramGB` is what the model wants at its own context size, so
 * whatever that is over the weights, the compute buffers and the desktop's own reserve is the KV
 * cache for that many tokens. A model with neither falls back to a flat guess, which is the only
 * number here that is truly invented and the first one a measured run replaces.
 */
export function kvGbPerToken(m) {
  if (Number.isFinite(m.kvGbPerToken)) return m.kvGbPerToken
  const ctx = m.contextSize
  const headroom = (m.recommendedVramGB ?? 0) - m.size / GB - COMPUTE_GB - RESERVE_GB
  if (Number.isFinite(ctx) && ctx > 0 && headroom > 0) return headroom / ctx
  return FALLBACK_KV_GB_PER_TOKEN
}

/**
 * Roughly what this model will take here, in GB, split the way it will actually load: the weights
 * and their KV cache ride whichever memory holds the layers, so the GPU's share is the share of
 * layers it takes, and the rest stays in RAM. `RESERVE_GB` is the desktop and the CUDA context,
 * which is spent the moment anything at all goes to the GPU.
 *
 * Every number is an estimate until the model has actually run once. `source` says which it is,
 * so nothing shows a guess and a measurement in the same shape; `measured` is what a test run
 * recorded for this model at this context size, on a run with this GPU room (the caller passes no
 * other), and it wins outright when it is there.
 *
 * @param {object} m         manifest model entry
 * @param {object} p
 * @param {number} p.ctx     context size the model will run with
 * @param {number} [p.vramGB] GPU memory the engine may use; 0 for a CPU-only run
 * @param {object} [p.measured] a previous run's reading: { vramGB, ramGB }
 * @returns {{ vramGB: number, ramGB: number, totalGB: number, gpuFraction: number, source: 'measured'|'estimated' }}
 */
export function estimateMemory(m, { ctx, vramGB = 0, measured = null } = {}) {
  if (measured && Number.isFinite(measured.vramGB) && Number.isFinite(measured.ramGB)) {
    return { ...measured, totalGB: measured.vramGB + measured.ramGB, gpuFraction: measured.gpuFraction ?? null, source: 'measured' }
  }
  const weights = m.size / GB
  const kv = Math.max(0, ctx) * kvGbPerToken(m)
  const live = weights + kv + COMPUTE_GB
  // The same reading of the GPU's room rateModule uses, so the picker's speed and its memory can
  // never describe two different splits of the same model.
  const room = Math.max(0, vramGB - RESERVE_GB)
  const gpuFraction = live > 0 ? Math.min(1, room / live) : 0
  const onGpu = live * gpuFraction
  return {
    vramGB: r1(onGpu > 0 ? onGpu + RESERVE_GB : 0),
    ramGB: r1(live - onGpu),
    totalGB: r1(live + (onGpu > 0 ? RESERVE_GB : 0)),
    gpuFraction: r1(gpuFraction),
    source: 'estimated',
  }
}

const r1 = (x) => Math.round(x * 10) / 10

/**
 * What the engine says it actually took, read from its own load report. llama.cpp prints one
 * line per buffer it allocates - the weights, the KV cache and the compute scratch - each named
 * by the device that holds it, so the split is read rather than guessed. A device named CPU is
 * RAM and anything else is the GPU, which is the one assumption here and the one that holds for
 * CUDA, Vulkan and Metal alike.
 *
 * Returns null until at least one buffer line has been seen, so a caller can tell "the engine
 * has not said yet" from "the engine said nothing was allocated".
 *
 * @param {string[]} lines  the engine's output, in any order
 * @returns {{ vramGB: number, ramGB: number, totalGB: number, gpuFraction: number }|null}
 */
export function readMemoryUsage(lines) {
  let vramMiB = 0
  let ramMiB = 0
  let seen = false
  for (const l of lines) {
    const m = /(\S+)\s+(?:model|KV|compute)\s+buffer size\s*=\s*([\d.]+)\s*MiB/i.exec(String(l))
    if (!m) continue
    const mib = Number(m[2])
    if (!Number.isFinite(mib)) continue
    seen = true
    if (/^cpu/i.test(m[1])) ramMiB += mib
    else vramMiB += mib
  }
  if (!seen) return null
  const vramGB = vramMiB / 1024
  const ramGB = ramMiB / 1024
  const total = vramGB + ramGB
  return { vramGB: r1(vramGB), ramGB: r1(ramGB), totalGB: r1(total), gpuFraction: total > 0 ? r1(vramGB / total) : 0 }
}

/** Default context and GPU layers for a model on this PC (manifest values unless the PC is small). */
// DSH's system prompt plus tool list alone is ~8.6k tokens, so a local model needs well over 8k of context.
export const MIN_CTX = 12288
export const defaultsFor = (m, specs, variant) => ({
  ctx: specs && specs.ramGB < 12 ? MIN_CTX : Math.max(MIN_CTX, m.contextSize ?? 16384),
  gpuLayers: variant === 'cpu' ? 0 : m.gpuLayers ?? 'auto',
})

/**
 * The contexts the resource budget may start a model with, largest first: `ctx`, the one it would
 * start with anyway, then each whole k (1024 tokens) below it, the unit the page prints a context in,
 * down to MIN_CTX. Never below the floor, and never above `ctx`: a context the plugin config set
 * under the floor is left as it is, since the budget only ever takes context away.
 */
export function contextSteps(ctx) {
  const steps = [ctx]
  for (let c = Math.ceil(ctx / 1024) * 1024 - 1024; c >= MIN_CTX; c -= 1024) steps.push(c)
  return steps
}

/** "Official · Stable · Verified (…)" */
export const badgesOf = (m) => [
  m.reliability?.startsWith('official') ? 'Official' : 'Community',
  m.reliability?.endsWith('stable') ? 'Stable' : 'Preview',
  m.verified ? `Verified${m.verifiedOn ? ` (${m.verifiedOn.split(',')[0]})` : ''}` : 'Not tested yet',
]

const TIER = { gpu: 2, split: 2, unknown: 2, cpu: 1, ok: 0, no: -1 }
/**
 * Suggest 1-2 models for this PC. Reliability first (official-stable and verified
 * only), then fit (runs at a usable speed), then quality (manifest rank), then
 * Hugging Face downloads as a tie-breaker. Every other module says why it is not suggested.
 *
 * A model rated 'unknown' (a GPU sized from AdapterRAM's ceiling) is ranked down as slow only
 * if it is slow even fully on the GPU: that it would be slow on a card of the ceiling's size is a
 * guess at the size, and taking it would rank a bigger card as a 4 GB one.
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
  const best = (rating) => rating.wordsPerSecRange?.[1] ?? rating.wordsPerSec
  const usable = (r) => TIER[r.rating.fit] + ((r.rating.fit === 'split' || r.rating.fit === 'unknown') && best(r.rating) < 3 ? -1 : 0)
  ok.sort((a, b) => usable(b) - usable(a) || (a.m.rank ?? 99) - (b.m.rank ?? 99) || (b.downloads ?? 0) - (a.downloads ?? 0))
  const g = specs.gpus.find((x) => x.vramGB > 0)
  const pc = `${g ? (g.sizeCapped ? `GPU (${CAPPED_SIZE}) + ` : `${Math.round(g.vramGB)} GB GPU + `) : ''}${Math.round(specs.ramGB)} GB RAM`
  const speed = (rating) => (rating.wordsPerSecRange ? `~${rating.wordsPerSecRange[0]} to ~${rating.wordsPerSecRange[1]}` : `~${rating.wordsPerSec}`)
  const vision = (r) => rows.find((x) => x.m.kind === 'vision' && x.m.for === r.m.id && !x.installed)
  const picks = ok.slice(0, 2).map((r, i) => ({
    id: r.m.id,
    reason: (r.m.role === 'best-quality' || (i === 0 && r.m.rank === 1)
      ? `${r.m.name}: best quality that still runs on your ${pc} (${r.rating.label.replace(/ \(.*/, '')}, ${speed(r.rating)} words/s)`
      : `${r.m.name}: lighter and faster (${r.rating.label.replace(/ \(.*/, '')}, ${speed(r.rating)} words/s)`)
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

// ---------- the resource budget ----------

/**
 * The resource budget: how much of this PC KzH may use. Every limit is optional, and null, the
 * default, means no limit, which is how KzH behaved before there was a budget. Sizes are in GB of
 * 1024^3 bytes, the unit every figure in this file uses.
 *
 * VRAM, cores and tasks at once are real caps. RAM is not: without a native Job Object nothing can
 * stop a process growing, so the RAM budget refuses a model whose figure is over it and unloads one
 * whose working set stays over it. The page that sets these has to say so.
 */
const BUDGET = {
  maxVramGB: { ok: (v) => Number.isFinite(v) && v > 0 && v <= 1024, why: 'max VRAM: GB above 0, at most 1024, or null for no limit' },
  maxRamGB: { ok: (v) => Number.isFinite(v) && v > 0 && v <= 4096, why: 'max RAM: GB above 0, at most 4096, or null for no limit' },
  maxCores: { ok: (v) => Number.isInteger(v) && v >= 1 && v <= 256, why: 'max cores: whole number 1-256, or null for no limit' },
  maxConcurrentTasks: { ok: (v) => Number.isInteger(v) && v >= 1 && v <= 64, why: 'max concurrent tasks: whole number 1-64, or null for no limit' },
}

/**
 * Threads for llama-server when the budget sets no core limit.
 *
 * llama.cpp's own default is every physical core, and generating is held back by memory bandwidth
 * long before arithmetic, so the last cores add little speed while taking the whole machine: the
 * app, its browser view and the agents' processes then crawl. This leaves them at least a quarter
 * of the machine, and at least two cores from three cores up (rounding the model's share down is
 * what keeps the quarter: 10 cores give it 7, not 8). A machine of one or two cores still gives it
 * one thread, since llama.cpp cannot run on none. When the physical count is unknown (it is read on
 * Windows only), half the logical processors stands in for it, since nearly every x86 CPU runs two
 * threads a core; erring low is the safe side of this setting.
 *
 * @param {{ cores?: number|null, threads: number }} cpu  detectSpecs().cpu
 */
export function defaultThreads({ cores, threads }) {
  const n = cores || Math.max(1, Math.floor(threads / 2))
  return Math.max(1, Math.min(n - 2, Math.floor((n * 3) / 4)))
}

/**
 * The --fit-target for a VRAM budget, in MiB.
 *
 * llama.cpp's --fit places layers until each GPU still has this much free, counted against what is
 * free as the model loads. Keeping free everything the GPU has beyond the budget therefore holds the
 * model to the budget whatever else is using the GPU: it gets the budget less what the desktop and
 * other programs hold, never more. Counting from a reading of free VRAM instead would hand it the
 * whole budget, but that reading is taken before the load and goes stale, and a stale one lets the
 * model over. A budget the GPU cannot reach leaves the usual margin. The margin is per GPU, so this
 * is exact with one GPU, and two could each take up to the budget.
 *
 * @param {object} p
 * @param {number|null} p.maxVramGB  the budget, or null for none
 * @param {number} p.gpuTotalGB      the GPU's size, 0 when it is not known
 */
export function fitTargetMiB({ maxVramGB, gpuTotalGB }) {
  if (maxVramGB == null || !(gpuTotalGB > 0)) return FIT_TARGET_MIB
  return Math.max(FIT_TARGET_MIB, Math.ceil((gpuTotalGB - maxVramGB) * 1024))
}

/**
 * Why the budget refuses a model's memory figure, or null when it fits.
 *
 * The figure is for the run this start would get (planFor): estimated for the GPU room the VRAM
 * budget leaves it, or measured on a run with that same room and the same GPU layers. So its VRAM
 * side is already held to the VRAM budget, by --fit, which moves the layers that do not fit onto
 * the CPU, and VRAM is never refused on its own account. (Where --fit cannot hold it, with layers
 * pinned by hand or a GPU of unknown size, start() logs that the VRAM budget is not applied.) What
 * the budget can honestly refuse is what lands in RAM, the figure's RAM side. That covers the two
 * budgets together as well: what stays on the GPU is at most the VRAM budget, so a figure over both
 * added up always puts more than the RAM budget into RAM. With no RAM budget nothing is refused.
 *
 * planFor sizes the context down to the floor before it asks, so a refusal at MIN_CTX says that
 * not even the floor fits. One at any other context is at a context the plugin config set under it.
 *
 * @param {{ vramGB: number, ramGB: number, source: string }} memory  estimateMemory()'s figure
 * @param {{ maxVramGB?: number|null, maxRamGB?: number|null }} budget
 * @param {{ name: string, ctx: number }} about  the model and context, for the message
 */
function overBudget(memory, { maxVramGB = null, maxRamGB = null }, { name, ctx, held = { gb: 0, by: [] } }) {
  if (!overRam(memory, maxRamGB == null ? null : maxRamGB - held.gb)) return null
  const budget = [maxVramGB != null && `${maxVramGB} GB VRAM`, `${maxRamGB} GB RAM`].filter(Boolean).join(' + ')
  const at = ctx === MIN_CTX ? `even at the ${MIN_CTX / 1024}k context floor` : `at ${ctx} context`
  const less = held.gb > 0 ? `, less the ${held.gb} GB ${held.by.join(' and ')} holds` : ''
  return `${name} needs about ${memory.ramGB} GB of RAM ${at} (${memory.source}: ${memory.vramGB} GB VRAM + ${memory.ramGB} GB RAM), over the resource budget of ${budget}${less}. Raise the RAM budget or use a smaller model.`
}

/** Whether a memory figure puts more into RAM than the RAM budget allows; never with no RAM budget. */
const overRam = (memory, maxRamGB) => maxRamGB != null && !!memory && memory.ramGB > maxRamGB

/**
 * A process's working set in bytes, as this OS reports it: tasklist on Windows, whose "Mem Usage"
 * column is the working set, and ps everywhere else, whose RSS is the same thing. null when it
 * cannot be read, a process that has gone included. `run` is injectable for tests.
 */
export async function workingSetOf(pid, { run = exec, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (platform === 'win32') return parseTasklistMemory(await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']))
  return parsePsRss(await run('ps', ['-o', 'rss=', '-p', String(pid)]))
}

/**
 * `tasklist /FO CSV /NH` -> bytes. The last field is the working set in KB, written with the
 * locale's thousands separator ("1,234,567 K", "1.234.567 K", "1 234 567 Ko"), so every non-digit
 * goes. No quoted row is tasklist saying no such process is running.
 */
export function parseTasklistMemory(out) {
  const row = String(out ?? '').split(/\r?\n/).find((l) => l.startsWith('"'))
  const kb = row?.trim().replace(/^"|"$/g, '').split('","').at(-1).replace(/\D/g, '')
  return kb ? Number(kb) * 1024 : null
}

/** `ps -o rss= -p <pid>` -> bytes. ps reports RSS in KiB; anything but one number is no reading. */
export function parsePsRss(out) {
  const kib = /^\s*(\d+)\s*$/.exec(String(out ?? ''))?.[1]
  return kib ? Number(kib) * 1024 : null
}

/**
 * Kill a process and every process it started, by pid. On Windows that is `taskkill /t /f`, as the
 * engine has always been stopped; a venv's python.exe there can be a redirector whose child is the
 * real interpreter, so killing the one pid alone would leave the model loaded. Elsewhere the tree is
 * read from `ps` and every process in it gets SIGKILL. Synchronous, so the process exit hook can use
 * it. Returns whether anything was killed; a pid that has gone already is not an error.
 * `run` (spawnSync's shape) and `platform` are injectable for tests.
 */
export function killTree(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (platform === 'win32') return run('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).status === 0
  const children = new Map()
  for (const line of String(run('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout ?? '').split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number)
    if (Number.isSafeInteger(p) && Number.isSafeInteger(pp)) children.set(pp, [...(children.get(pp) ?? []), p])
  }
  const tree = []
  const walk = (p) => { if (tree.includes(p)) return; tree.push(p); for (const c of children.get(p) ?? []) walk(c) }
  walk(pid)
  let killed = false
  for (const p of tree) { try { process.kill(p, 'SIGKILL'); killed = true } catch { /* gone already */ } }
  return killed
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
 * @param {string} p.settingsFile  UI settings (chat model, idle minutes, GPU layers, the resource budget)
 * @param {number} [p.port]      first port to try (next ones if taken)
 * @param {number} [p.contextSize]  the context every model starts with, in place of its manifest's (a RAM budget may size it down, to MIN_CTX at least)
 * @param {() => Promise<object>} [p.specs]  detectSpecs() for this PC (cached by the caller)
 * @param {(m: object) => void} [p.onChange]  a module was installed, removed or verified
 * @param {(s: object) => void} [p.onSettings]  the settings were changed and saved; called with them
 * @param {(pid: number) => Promise<number|null>} [p.readWorkingSet]  the RAM watchdog's reading, in bytes (tests)
 * @param {() => number} [p.now]  the RAM watchdog's clock (tests)
 * @param {number} [p.watchEveryMs]  how often the RAM watchdog reads, while a RAM budget is set
 * @param {object} [p.residency]  createResidency(): every local model process on this PC, llama-server
 *   and Laya's laya.serve, under one RAM budget. The loaded engine registers there as 'llama'; one of
 *   its own is made when none is shared, which holds llama alone, exactly as before there was a second.
 */
export function createLocalModels({ modules, engineDir, modelsDir, settingsFile, port: basePort = 8081, contextSize, specs: getSpecs = async () => null, spawn = nodeSpawn, fetch = globalThis.fetch, log = () => {}, onChange = () => {}, onSettings = () => {}, readWorkingSet = workingSetOf, now = Date.now, watchEveryMs = 5000, residency = createResidency({ log }) }) {
  const exe = join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  const engines = modules.filter((m) => m.kind === 'engine')
  const models = modules.filter((m) => m.kind === 'model')
  const mod = (id) => modules.find((m) => m.id === id)
  let engine = null // { child, modelId, port, key, ready, startedAt, gpuLayers, tail, threads, fitTargetMiB, resident }
  let busy = 0
  let idleTimer = null
  // Models the RAM watchdog unloaded: why, and the context it was running with. Loading one again at
  // that context or a larger one would only end the same way, so until a setting that decides how
  // much of it lands in RAM changes, planFor sizes it below that context, and refuses it only when
  // there is no smaller one left (it was unloaded at the floor).
  const tripped = new Map()
  const RAM_DECIDERS = ['maxRamGB', 'maxVramGB', 'gpuLayers']
  // The context each model was last planned with (planFor), for contextOf(), which has to answer at
  // once: the window DSH and the formatter fill must be the one llama-server is started with.
  const planned = new Map()
  // The context llama-server was started with, while it runs `id`. A loaded model is not restarted
  // when the budget changes, so until it is unloaded this, not the next load's plan, is its window.
  const runningCtx = (id) => (engine?.modelId === id ? engine.ctx : null)
  let lock = Promise.resolve()
  let installing = Promise.resolve()
  const jobs = new Map() // module id -> { state: queued | downloading | extracting | done | failed, received, total, bytesPerSec, error }

  const DEFAULTS = { chatModel: null, idleMinutes: 10, gpuLayers: null, keepWarm: false, loadAtStart: null, measured: {}, ...Object.fromEntries(Object.keys(BUDGET).map((k) => [k, null])) }
  const loadMs = new Map() // model id -> last load time, for the "~8 s" estimate
  const readSettings = async () => ({ ...DEFAULTS, ...JSON.parse(await readFile(settingsFile, 'utf8').catch(() => '{}')) })
  async function setSettings(patch) {
    const was = await readSettings()
    const s = { ...was }
    for (const [k, rule] of Object.entries(BUDGET)) {
      if (patch[k] === undefined) continue
      if (!(patch[k] === null || rule.ok(patch[k]))) throw new Error(rule.why)
      s[k] = patch[k]
    }
    if (patch.idleMinutes !== undefined) {
      if (!(Number.isInteger(patch.idleMinutes) && patch.idleMinutes >= 1 && patch.idleMinutes <= 240)) throw new Error('idle minutes: whole number 1-240')
      s.idleMinutes = patch.idleMinutes
    }
    if (patch.gpuLayers !== undefined) {
      if (!(patch.gpuLayers === null || patch.gpuLayers === 'auto' || (Number.isInteger(patch.gpuLayers) && patch.gpuLayers >= 0 && patch.gpuLayers <= 999))) throw new Error("GPU layers: 'auto' or 0-999")
      s.gpuLayers = patch.gpuLayers
    }
    if (patch.keepWarm !== undefined) {
      if (typeof patch.keepWarm !== 'boolean') throw new Error('keepWarm: true or false')
      s.keepWarm = patch.keepWarm
    }
    if (patch.loadAtStart !== undefined) {
      if (patch.loadAtStart !== null && !(await installed()).some((m) => m.id === patch.loadAtStart)) throw new Error(`${patch.loadAtStart} is not installed`)
      s.loadAtStart = patch.loadAtStart
    }
    if (patch.chatModel !== undefined) {
      if (!(await installed()).some((m) => m.id === patch.chatModel)) throw new Error(`${patch.chatModel} is not installed`)
      s.chatModel = patch.chatModel
    }
    await save(s)
    // Changed, not merely sent: a settings form that posts the whole budget on every save sends the
    // same RAM budget again, and that must not load a tripped model straight back into the same overload.
    if (RAM_DECIDERS.some((k) => s[k] !== was[k])) tripped.clear()
    // Whatever follows the budget (the task queue's cap, the router's readiness) hears of the change
    // here, the one place settings are written. A listener that fails must not undo a saved change.
    try { onSettings(s) } catch (err) { log(`local: settings change not handed on: ${err.message}`) }
    return s
  }

  async function save(s) {
    await mkdir(dirname(settingsFile), { recursive: true })
    await writeFile(`${settingsFile}.tmp`, JSON.stringify(s, null, 2))
    await rename(`${settingsFile}.tmp`, settingsFile)
  }

  // One RAM watchdog over every resident local model process, llama and Laya together. It reads
  // nothing while nothing is resident, so it can run for as long as the local models are up.
  const watchdog = createBudgetWatchdog({ residency, readSettings, readWorkingSet, now, everyMs: watchEveryMs, log: (t) => log(`local: ${t}`) })
  watchdog.start()

  /**
   * Keep what a real load took, under the model and the context size it was measured at, so the
   * estimate is only ever shown for a pairing nothing has measured yet. The reading carries the GPU
   * room and layers of its run (`roomGB`, `gpuLayers`), and stands only for a run like it
   * (measuredFor). A later reading replaces an earlier one: the newest run is the one that describes
   * this machine as it is now.
   */
  async function recordMemory(modelId, ctx, memory) {
    const s = await readSettings()
    s.measured = { ...s.measured, [`${modelId}@${ctx}`]: { ...memory, at: new Date().toISOString() } }
    await save(s)
  }

  /**
   * What a run recorded for this model at this context size, or null if none has, or if that run
   * was not like this one: another GPU room (`roomGB`, what planFor gives it) or other GPU layers
   * split the model another way. A GPU run's RAM side says nothing about a CPU run, which puts all
   * of it in RAM, and a run held to a tight VRAM budget overstates RAM once the budget is lifted;
   * taken as they are, the first lets an oversized model through and the second refuses a model
   * for good, since a refused model never runs again to be measured. Such a run stays on file and
   * the estimate for this one stands in. A reading from before the room was recorded has none.
   */
  const measuredFor = (s, modelId, ctx, { roomGB, gpuLayers }) => {
    const got = s.measured?.[`${modelId}@${ctx}`]
    return got && got.roomGB === roomGB && got.gpuLayers === gpuLayers ? got : null
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
    const models = (await installed()).filter((m) => m.agent)
    const s = await readSettings()
    return Promise.all(models.map(async (m) => ({
      id: m.agent.id, name: m.agent.name ?? (m.name ? `${m.name} (local)` : undefined), provider: 'spawn', description: m.agent.description, enabled: true,
      // `role` ('fast' | 'balanced' | 'best-quality') ranks the local models for the
      // local-low / local-high effort levels; size only breaks a tie.
      // `contextSize` is the window llama-server will really be started with here (planFor, which
      // sizes it to the resource budget), so the router's capability registry and the resource
      // snapshot both know what this model can hold, and a request that does not fit is refused
      // before any judgment. While the model runs, a request meets the window it was started with,
      // and the router keeps this until it is told again, by which time the model may have been
      // loaded afresh with the planned one: so it gets the smaller of the two, never more than
      // either run holds.
      role: m.role, size: m.size, llm: { provider: LOCAL_PROVIDER, model: m.id, contextSize: Math.min((await planFor(m, s)).ctx, runningCtx(m.id) ?? Infinity) }, persona,
    })))
  }

  /**
   * Router readiness for a local agent: no login, no quota; the engine must be installed, and this
   * PC must be able to run the model. Insufficient hardware is a hard fact like a missing file: a
   * model that needs more memory than the machine has cannot do any job, so it is not ready, and
   * the router drops it before any judgment. The rule is the same one the model picker shows as
   * "Won't fit" (rateModule), so setup and routing never disagree about what runs here.
   */
  async function readiness(modelId) {
    const variant = await engineVariant()
    if (!variant) return { installed: false, loggedIn: false, detail: 'llama.cpp engine not installed: type /install-llm' }
    const m = (await installed()).find((x) => x.id === modelId)
    if (!m) return { installed: false, loggedIn: false, detail: `${mod(modelId)?.file ?? modelId} not installed: type /install-llm` }
    const specs = await getSpecs().catch(() => null)
    const fit = specs ? rateModule(m, specs, variant, { installed: true }) : null
    if (fit?.fit === 'no') return { installed: true, loggedIn: false, detail: `this PC cannot run ${m.file}: ${fit.reason}` }
    // Over the resource budget is as hard a fact as too little memory: start() would refuse it, so
    // the router must not pick it and then fail the task at the load.
    const { refusal } = await planFor(m, await readSettings())
    if (refusal) return { installed: true, loggedIn: false, detail: refusal }
    return { installed: true, loggedIn: true, detail: `free, local: ${m.file}` }
  }

  /**
   * The model answering direct questions: the one chosen in Settings if installed, else the
   * quickest installed one. Manifest order used to decide the fallback, which sent every simple
   * question to whichever model the manifest happened to list first - Qwen here, ~8 tokens/s -
   * instead of to the `fast` role that exists for exactly this job (Gemma 4 E4B, ~47 tokens/s).
   * A direct answer is a short one, so speed is what a local chat model is for; the stored
   * choice still wins over both.
   *
   * Either way only among the models the resource budget lets load, a watchdog unload included.
   * Titles, compaction and direct answers go to the local chat model first, and a refused one
   * would fail each of them at the load rather than leave them to the next agent.
   */
  async function chatModel() {
    if (!(await engineInstalled())) return null
    const s = await readSettings()
    const fits = []
    for (const m of await installed()) if (!(await planFor(m, s)).refusal) fits.push(m)
    return fits.find((m) => m.id === s.chatModel)?.id ?? quickestLocal(fits)?.id ?? null
  }

  async function runDefaults(m) {
    const d = defaultsFor(m, await getSpecs().catch(() => null), await engineVariant())
    return { ctx: Math.min(contextSize ?? d.ctx, m.maxContext ?? Infinity), gpuLayers: d.gpuLayers }
  }

  /**
   * What the budget makes of a start: the thread count, the --fit-target, and, when the VRAM budget
   * cannot be held by --fit, why not, so the log can say so instead of implying a cap that is not
   * there. Layers pinned in Settings are loaded as pinned and --fit does not move them; a CPU run
   * (no layers, or the CPU build) uses no VRAM, so any budget holds. A GPU sized from AdapterRAM's
   * ceiling (detectSpecs) has no known size either: a margin worked out from 4 GB on an 8 GB card
   * would let the model take about twice the budget.
   *
   * A core budget is a cap, not a request: above the machine's logical processors it would have
   * llama.cpp run more threads than there are, oversubscribed, which is the crawl -t is there to stop.
   */
  function limitsFor(s, specs, variant, gpuLayers) {
    const cpu = specs?.cpu ?? { cores: null, threads: cpus().length }
    const auto = defaultThreads(cpu)
    const machine = cpu.threads || cpus().length || Infinity
    const gpus = specs && variant ? gpusFor(specs, variant) : []
    const sizeCapped = gpus.some((g) => g.sizeCapped)
    const gpuTotalGB = sizeCapped ? 0 : Math.max(0, ...gpus.map((g) => g.vramGB))
    let unapplied = null
    if (s.maxVramGB != null && variant !== 'cpu' && gpuLayers !== 0) {
      if (typeof gpuLayers === 'number') unapplied = `GPU layers are pinned to ${gpuLayers}, which --fit does not move`
      else if (sizeCapped) unapplied = 'this GPU reports its memory through a 32-bit field that stops at 4 GB'
      else if (!(gpuTotalGB > 0)) unapplied = "this PC's GPU memory is unknown"
    }
    return { threads: s.maxCores == null ? auto : Math.min(s.maxCores, machine), defaultThreads: auto, fitTargetMiB: fitTargetMiB({ maxVramGB: s.maxVramGB, gpuTotalGB }), unapplied }
  }

  /**
   * How a model would start here under these settings: its context, its GPU layers, the GPU room it
   * would have, what it would take (measured if a run like this one has reported it, estimated until
   * then), and the budget's refusal, if any. The GPU room is what the start would really give it:
   * none on a CPU run, otherwise the GPU's usable memory held to the VRAM budget. start(),
   * readiness(), chatModel(), agents() and status() all read this, so the load, the router and the
   * settings page cannot disagree about what fits.
   *
   * The context is sized to the RAM budget: the largest of contextSteps(), from the one it would
   * start with (runDefaults) down to MIN_CTX, whose figure the budget holds. Each context is judged
   * by its own figure, measured there or estimated there, since a reading at one context says
   * nothing about another. The VRAM budget comes into it where it applies, through the room: the
   * layers it keeps off the GPU land in RAM, and the figure with them. On its own it sizes nothing,
   * since --fit holds it and nothing is refused on its account, and with no RAM budget the context is
   * the one it would start with. Only a model over the budget even at the floor is refused, with its
   * figure there. `reducedFrom` is the context it would have started with, when the budget took some away.
   *
   * A model the RAM watchdog unloaded is sized below the context it was unloaded at: its real use
   * there was over the budget, whatever the figure says, and says nothing about a smaller context.
   * Only one unloaded at the smallest context it can have is refused on the watchdog's account.
   *
   * The RAM budget is shared with the other resident local model processes (Laya's laya.serve),
   * but only those a hold keeps loaded count against it here: one nothing holds is unloaded before
   * this model starts (start() yields it), so a context is never sized down for a Laya that would
   * be gone by the time the model loads. The plan only reads the residency; unloading is start()'s.
   */
  async function planFor(m, s) {
    const specs = await getSpecs().catch(() => null)
    const variant = (await engineVariant()) ?? 'cpu'
    const d = await runDefaults(m)
    const gpuLayers = s.gpuLayers ?? d.gpuLayers
    const room = !specs || gpuLayers === 0 ? 0 : Math.min(usableVramGB(specs, variant), s.maxVramGB ?? Infinity)
    const figureAt = (ctx) => estimateMemory(m, { ctx, vramGB: room, measured: measuredFor(s, m.id, ctx, { roomGB: room, gpuLayers }) })
    const held = { gb: residency.othersRamGB('llama', { heldOnly: true }), by: residency.othersNames('llama', { heldOnly: true }) }
    const ramLeft = s.maxRamGB == null ? null : s.maxRamGB - held.gb
    const all = contextSteps(d.ctx)
    const unloaded = tripped.get(m.id)
    const steps = unloaded ? all.filter((c) => c < unloaded.ctx) : all
    const ctx = steps.find((c) => !overRam(figureAt(c), ramLeft)) ?? steps.at(-1) ?? all.at(-1)
    const memory = figureAt(ctx)
    planned.set(m.id, ctx)
    const refusal = unloaded && !steps.length ? `the RAM watchdog unloaded ${m.name ?? m.id}: ${unloaded.why}. Raise the RAM budget to load it again.` : overBudget(memory, s, { name: m.name ?? m.id, ctx, held })
    return { ctx, reducedFrom: ctx < d.ctx ? d.ctx : null, gpuLayers, room, specs, variant, memory, refusal }
  }

  function kill(child) {
    if (!child || child.exitCode !== null) return
    if (process.platform === 'win32' && child.pid) killTree(child.pid)
    else child.kill('SIGKILL')
  }
  const onExit = () => kill(engine?.child)
  process.on('exit', onExit)

  async function stop() {
    clearTimeout(idleTimer)
    const e = engine
    engine = null
    if (e) { residency.clear('llama', e.resident); kill(e.child); log(`local: engine stopped (${e.modelId})`) }
  }

  /**
   * What the RAM watchdog does when llama is the resident it unloads: today's trip-and-stop. The
   * model is kept as tripped at the context it ran with, so planFor sizes it below that until what
   * decides its RAM changes, and whoever follows the local models is told at once. Only llama's own
   * unload records a trip: a Laya unloaded for the budget never shrinks llama's context.
   */
  const unloadFor = (e) => async (why) => {
    if (engine !== e) return
    tripped.set(e.modelId, { why: why.text, ctx: e.ctx })
    log(`local: unloaded ${e.modelId}: ${why.text}`)
    await stop()
    // The router caches readiness for minutes and the chat model with it. Told now, it stops
    // offering this model at once, instead of sending it tasks that each fail at the load.
    onChange(mod(e.modelId))
  }

  /**
   * One reading of the RAM watchdog, which watches every resident local model process together
   * (residency.js): while a RAM budget is set their working sets are read every `watchEveryMs`, and
   * when the sum stays over the budget for 30 seconds one of them is unloaded, a Laya nothing holds
   * first. With llama alone resident this is exactly the old per-engine watchdog. Tests take
   * readings by hand, on their own clock.
   */
  const checkMemory = () => watchdog.check()

  async function start(modelId) {
    const m = (await installed()).find((x) => x.id === modelId)
    if (!m) throw new Error(`local model ${modelId} is not installed (type /install-llm)`)
    if (!(await engineInstalled())) throw new Error('llama.cpp engine not installed (type /install-llm)')
    // A resident nothing holds (a Laya loaded earlier by a test or a run that has ended) gives the
    // GPU and RAM up first, so --fit sees the whole GPU and the context is sized as if it were
    // never there. A held Laya stays, and planFor counts its RAM.
    await residency.yieldFor('llama', { name: m.id })
    const s = await readSettings()
    // Refused before anything is spawned: RAM cannot be capped once the model is loading, so a
    // model the budget cannot hold is not started at all.
    const plan = await planFor(m, s)
    if (plan.refusal) throw new Error(plan.refusal)
    const port = await freePort(basePort)
    const key = randomBytes(24).toString('hex')
    const { ctx, gpuLayers } = plan
    const limits = limitsFor(s, plan.specs, plan.variant, gpuLayers)
    if (limits.unapplied) log(`local: VRAM budget of ${s.maxVramGB} GB not applied: ${limits.unapplied}`)
    if (plan.reducedFrom) log(`local: the resource budget reduced ${m.id}'s context from ${plan.reducedFrom} to ${ctx}, the largest that fits it`)
    const vision = await visionFor(m.id)
    const args = [
      ...llamaArgs({ modelPath: join(modelsDir, m.file), alias: m.id, port, ctx, gpuLayers, fitTargetMiB: limits.fitTargetMiB, threads: limits.threads, thinking: !!m.thinking }),
      // The vision projector stays on the CPU so the GPU keeps the text model's layers.
      ...(vision ? ['--mmproj', join(modelsDir, vision.file), '--no-mmproj-offload'] : ['--no-mmproj']),
    ]
    const child = spawn(exe, args, { cwd: engineDir, env: { ...process.env, LLAMA_API_KEY: key }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const e = { child, modelId: m.id, port, key, ctx, vision: !!vision, startedAt: Date.now(), gpuLayers: null, threads: limits.threads, fitTargetMiB: limits.fitTargetMiB, tail: [], memoryLines: [], memory: null }
    const onLine = (chunk) => {
      for (const l of String(chunk).split('\n')) {
        const off = /offloaded (\d+)\/(\d+) layers to GPU/.exec(l)
        if (off) e.gpuLayers = { gpu: Number(off[1]), total: Number(off[2]) }
        // Kept apart from the tail, which is a short window for an error message and would have
        // dropped these long before the engine finished reporting them.
        if (/buffer size\s*=/i.test(l) && e.memoryLines.length < 60) e.memoryLines.push(l)
        if (l.trim()) { e.tail.push(l.trim()); if (e.tail.length > 30) e.tail.shift() }
      }
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)
    const exited = new Promise((r) => child.once('exit', r)).then((code) => { if (engine === e) engine = null; return code })
    child.once('error', (err) => { e.tail.push(err.message); if (engine === e) engine = null })
    engine = e
    log(`local: engine starting ${m.id} on 127.0.0.1:${port} (ctx ${ctx}, GPU layers ${gpuLayers}, ${limits.threads} threads, ${limits.fitTargetMiB} MiB kept free on the GPU${vision ? ', vision' : ''})`)
    e.ready = (async () => {
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null || engine !== e) throw new Error(`llama-server exited: ${e.tail.slice(-3).join(' | ')}`)
        const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
        if (ok) {
          e.loaded = true
          loadMs.set(m.id, Date.now() - e.startedAt)
          // What it really took, at this context size, on this machine. Recorded against both, and
          // with the GPU room and layers it ran with, so a reading is never shown for a context it
          // was not measured at, nor taken for a run that splits the model another way.
          e.memory = readMemoryUsage(e.memoryLines)
          if (e.memory) { await recordMemory(m.id, ctx, { ...e.memory, roomGB: plan.room, gpuLayers }); log(`local: ${m.id} took ${e.memory.vramGB} GB VRAM + ${e.memory.ramGB} GB RAM at ctx ${ctx}`) }
          log(`local: engine ready: ${m.id}, ${e.gpuLayers ? `${e.gpuLayers.gpu}/${e.gpuLayers.total} layers on GPU` : 'GPU layers unknown'}`)
          // Resident, and watched, from here on, not while loading: the budget is about the model as
          // it runs, and a model too big to load under it was refused before it started. Held,
          // because the local model is what the person is using: nothing is ever unloaded for it
          // to yield to, though the watchdog may still unload it for the budget as it always could.
          if (engine === e) {
            e.resident = residency.set('llama', {
              pid: child.pid, startedAt: e.startedAt, device: gpuLayers === 0 || plan.variant === 'cpu' ? 'cpu' : 'gpu', name: m.id,
              busy: () => busy > 0, held: () => true, unload: unloadFor(e),
              ramGB: () => e.memory?.ramGB ?? plan.memory.ramGB, vramGB: () => e.memory?.vramGB ?? plan.memory.vramGB,
            })
          }
          return
        }
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
    const { idleMinutes, keepWarm } = await readSettings()
    if (busy > 0 || keepWarm) return
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
    // The run each model would really get here: the context it would start with and the GPU room
    // the budget leaves it, so the memory figures below describe that run rather than a default one.
    const plans = new Map(await Promise.all(modules.filter((m) => m.kind === 'model').map(async (m) => [m.id, await planFor(m, s)])))
    const variant = (await engineVariant()) ?? 'cpu'
    const limits = limitsFor(s, await getSpecs().catch(() => null), variant, s.gpuLayers ?? (variant === 'cpu' ? 0 : 'auto'))
    return {
      engine: { installed: await engineInstalled(), variant: await engineVariant(), running: !!engine, ready, model: engine?.modelId ?? null, vision: !!engine?.vision, port: engine?.port ?? null, ctx: engine?.ctx ?? null, gpuLayers: engine?.gpuLayers ?? null, threads: engine?.threads ?? null, fitTargetMiB: engine?.fitTargetMiB ?? null, memory: engine?.memory ?? null, workingSetGB: engine?.resident?.workingSetGB ?? null, startedAt: engine?.startedAt ?? null, busy },
      settings: { ...s, chatModel: await chatModel() },
      // What the budget makes of the next load: the thread count (and the default an unset core
      // limit means), the VRAM kept free, and why the VRAM budget cannot be held when it cannot.
      budget: { threads: limits.threads, defaultThreads: limits.defaultThreads, fitTargetMiB: limits.fitTargetMiB, vramNotApplied: limits.unapplied },
      modules: modules.map((m, i) => ({
        id: m.id, kind: m.kind, variant: m.variant, for: m.for, name: m.name, file: m.file, size: m.size, license: m.license, notes: m.notes, source: m.source,
        agent: m.agent?.id ?? null, state: states[i], job: jobs.get(m.id) ?? null, badges: badgesOf(m),
        // What it would take here at the context it would run with, measured if a run has ever
        // reported it and a rough estimate until then. The caller shows which, never both.
        memory: plans.get(m.id)?.memory ?? null,
        ctx: plans.get(m.id)?.ctx ?? null,
        // The context it would have started with, when the budget sized it down to `ctx`; else null.
        ctxReducedFrom: plans.get(m.id)?.reducedFrom ?? null,
        // The budget's refusal, word for word what start() would throw, or null when it fits.
        overBudget: plans.get(m.id)?.refusal ?? null,
      })),
    }
  }

  return {
    readiness, installed, agents, chatModel, stream, acquire, status, install, plan, remove, setSettings, settled, engineVariant, visionFor, readSettings, checkMemory,
    /** True when `modelId` is loaded and answering (no cold start). */
    isLoaded: (modelId) => !!engine?.loaded && engine.modelId === modelId,
    /** True while a request holds the engine: a stream is open, or a start is under way for one. */
    isBusy: () => busy > 0,
    /** Expected load time: the last one measured this session, else ~8 s. */
    loadEstimateMs: (modelId) => loadMs.get(modelId) ?? 8000,
    start: async (id) => { const c = await acquire(id); c.release() },
    stop: async () => { if (busy > 0) throw new Error('a local model is answering right now'); await stop() },
    dispose: async () => { process.off('exit', onExit); watchdog.stop(); await stop() },
    /**
     * The context window a request to `id` meets: the one llama-server was started with while it runs
     * `id`, else the one it was last planned with (planFor), which the next load gets, else what its
     * manifest asks for.
     */
    contextOf: (id) => { const m = mod(id); return runningCtx(id) ?? planned.get(id) ?? (m ? Math.min(contextSize ?? Math.max(MIN_CTX, m.contextSize ?? 16384), m.maxContext ?? Infinity) : contextSize ?? 16384) },
    modelOf: mod,
    modules,
  }
}

/**
 * A local model is not loaded yet: say so, and after `delayMs` offer to switch to `alt`
 * (a cloud agent) instead of waiting. The question is withdrawn once loading finishes.
 * @returns {Promise<'ready'|'switch'>}
 */
export async function coldStart({ name, estimateMs = 8000, load, say, ask, alt, delayMs = 1500 }) {
  say(`Loading ${name} (local, ~${Math.max(1, Math.round(estimateMs / 1000))} s)…`)
  let loaded = false
  const loading = Promise.resolve().then(load).then(() => { loaded = true })
  loading.catch(() => {})
  if (!ask || !alt) { await loading; return 'ready' }
  const early = await Promise.race([loading.then(() => true), new Promise((r) => setTimeout(r, delayMs, false))])
  if (early || loaded) return 'ready'
  const withdraw = new AbortController()
  loading.then(() => withdraw.abort(new Error('loaded')), () => {})
  const keep = 'Keep waiting'
  const other = `Switch to ${alt}`
  let answer
  try {
    answer = await ask({
      signal: withdraw.signal,
      questions: [{ id: 'cold-start', header: 'Local model', question: `${name} is still loading. Keep waiting or run this step on ${alt}?`, options: [{ label: keep, description: `Wait for ${name} (free, on this PC)` }, { label: other, description: `Run on ${alt} now` }] }],
    })
  } catch {
    // Withdrawn because loading finished, or no answerer: wait for the model.
    await loading
    return 'ready'
  }
  if (answer?.answers?.[0]?.selected?.includes(other)) { say(`Switching to ${alt} while ${name} loads`); return 'switch' }
  await loading
  return 'ready'
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

const listLine = (x) => `- \`${x.id}\` ${x.name} · ${size(x.size)} · ${x.rating.fit === 'no' ? `won't fit: ${x.rating.reason}` : x.rating.label}${x.agent ? ` · agent ${x.agent}` : x.for ? ` · add-on for ${x.for}` : ''} · ${x.installed ? '✓ installed' : 'not installed'}`

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
