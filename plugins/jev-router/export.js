// Export one chat as Markdown. DSH stores each session as JSON-lines appended
// in its own zstd frame (session.v3.jsonl.zstd), so a file is many frames back
// to back; Node decompresses one frame at a time, hence the splitter below.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** Session ids come from the browser: never join one into a path, only match it. */
export const SESSION_ID = /^[\w-]{1,80}$/

/**
 * Every zstd frame in `buf`, concatenated. The magic bytes can also occur inside
 * compressed data, so a candidate split that fails to decompress is extended to
 * the next candidate rather than trusted.
 * ponytail: O(frames^2) worst case; a session is tens of frames, so it never shows.
 */
export function unzstd(buf) {
  const starts = []
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i)
  const parts = []
  for (let s = 0; s < starts.length;) {
    let moved = false
    for (let e = s + 1; e <= starts.length; e++) {
      const end = e === starts.length ? buf.length : starts[e]
      try { parts.push(zstdDecompressSync(buf.subarray(starts[s], end))); s = e; moved = true; break } catch { /* not a frame boundary */ }
    }
    if (!moved) break // trailing bytes we cannot read: keep everything up to here
  }
  return Buffer.concat(parts)
}

/** Events of one stored session, oldest first; unreadable lines are skipped. */
export function parseEvents(buf) {
  return unzstd(buf).toString('utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

/**
 * The stored file for `sessionId`, searched across every workspace folder.
 * @returns the path, or null when this session has nothing on disk yet.
 */
export async function findSession(root, sessionId) {
  if (!SESSION_ID.test(sessionId ?? '')) throw new Error('session: a session id')
  for (const workspace of await readdir(root).catch(() => [])) {
    const dirs = await readdir(join(root, workspace)).catch(() => [])
    // Stored as the bare id or as "session-<id>", depending on when it was written.
    const hit = dirs.find((d) => d === sessionId || d === `session-${sessionId}` || `session-${d}` === sessionId)
    if (hit) return join(root, workspace, hit, 'session.v3.jsonl.zstd')
  }
  return null
}

/**
 * Key-shaped strings, by the prefixes the common providers use. A transcript is
 * written verbatim by the engine, so anything ever pasted into a chat is still in
 * it; an export leaves the machine, so it gets scrubbed on the way out.
 * Deliberately prefix-based: a pattern loose enough to catch "any long token"
 * would eat file hashes, ids and base64 out of ordinary tool output.
 */
const SECRETS = [
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, // OpenAI, Anthropic, DeepSeek
  /\b(tsk_[A-Za-z0-9_-]{12,})/g, // TypeSafe
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g, // GitHub
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, // Slack
  /\b(AIza[A-Za-z0-9_-]{20,})/g, // Google
  /\b(hf_[A-Za-z0-9]{20,})/g, // Hugging Face
  /\b(AKIA[0-9A-Z]{16})\b/g, // AWS access key id
]
/** Replace every key-shaped string with its first few characters and a marker. */
export function redactSecrets(text) {
  let out = String(text)
  for (const re of SECRETS) out = out.replace(re, (m) => `${m.slice(0, 6)}...REDACTED`)
  return out.replace(/((?:Bearer|Authorization:\s*Bearer)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1...REDACTED')
}

const CLOCK = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '')
const textOf = (content) => (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim()
const fence = (body, lang = '') => {
  // A body containing ``` needs a longer fence, or it ends the block early.
  const ticks = '`'.repeat(Math.max(3, ...[...String(body).matchAll(/`{3,}/g)].map((m) => m[0].length + 1)))
  return `${ticks}${lang}\n${body}\n${ticks}`
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… ${s.length - n} more characters` : s)

/**
 * The whole conversation as Markdown: what you typed, what the assistant said,
 * and (unless `tools` is false) each tool call and its result, folded away.
 * Key-shaped strings are redacted: the file leaves the machine, the transcript does not.
 * @param {object[]} events from {@link parseEvents}
 * @param {{tools?: boolean, maxToolChars?: number, now?: number}} [opts]
 */
export function toMarkdown(events, { tools = true, maxToolChars = 4000, now = Date.now() } = {}) {
  const head = events.find((e) => e.type === 'session')
  const title = events.findLast((e) => e.type === 'session/title')?.data?.title?.trim()
  const model = events.findLast((e) => e.type === 'request/header')?.data?.header?.config
  const calls = new Map() // callId -> the tool/call event, so a result can name its tool
  for (const e of events) if (e.type === 'tool/call') calls.set(e.data?.callId, e.data)

  const out = [`# ${title || 'Chat'}`, '']
  const facts = [
    head?.cwd ? `**Workspace:** \`${head.cwd}\`` : null,
    head?.id ? `**Session:** \`${head.id}\`` : null,
    model ? `**Model:** \`${model.provider}/${model.model}\`${model.reasoningEffort ? ` (effort ${model.reasoningEffort})` : ''}` : null,
    head?.createdAt ? `**Started:** ${CLOCK(head.createdAt)} UTC` : null,
    `**Exported:** ${CLOCK(now)} UTC`,
  ].filter(Boolean)
  out.push(facts.join('  \n'), '', '---', '')

  for (const e of events) {
    if (e.type === 'user/message') {
      const body = textOf(e.data?.content)
      if (body) out.push(`## You · ${CLOCK(e.time)}`, '', body, '')
    } else if (e.type === 'assistant/message') {
      const body = textOf(e.data?.message?.content)
      if (body) out.push(`## Assistant · ${CLOCK(e.time)}`, '', body, '')
    } else if (tools && e.type === 'tool/result') {
      const call = calls.get(e.data?.message?.source?.callId)
      const name = call?.name ?? 'tool'
      const result = (e.data?.message?.content ?? [])
        .flatMap((b) => (b.type === 'tool-result' ? (b.content ?? []) : []))
        .filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      out.push(`<details><summary>Tool: <code>${name}</code></summary>`, '')
      if (call?.arguments) out.push(fence(clip(String(call.arguments), maxToolChars), 'json'), '')
      out.push(fence(clip(result || '(no output)', maxToolChars)), '', '</details>', '')
    }
  }
  return `${redactSecrets(out.join('\n')).replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** A safe, recognisable file name for the export. */
export function fileNameFor(title, at = Date.now()) {
  const stem = String(title ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return `${stem || 'chat'}-${new Date(at).toISOString().slice(0, 10)}.md`
}

/** Read one stored session and render it. Throws when the session has nothing saved yet. */
export async function exportSession(root, sessionId, opts) {
  const file = await findSession(root, sessionId)
  if (!file) throw Object.assign(new Error('this chat has nothing saved yet'), { status: 404 })
  const events = parseEvents(await readFile(file))
  const title = events.findLast((e) => e.type === 'session/title')?.data?.title?.trim() || 'Chat'
  return { markdown: toMarkdown(events, opts), title, filename: fileNameFor(title) }
}
