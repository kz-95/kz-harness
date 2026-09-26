// The conversation-compaction row of config/cordis.patch.yml (the engine's compaction-basic,
// @deepseek-ai/dsh-compaction-basic 0.1.5-rc.2): compact at 97% of a model's window, as the owner
// decided on 25 Sep, and on the local models a summary short enough that the summary request fits
// the window as well. The engine replays everything but the newest retainRatio of the conversation
// to the model with its summary directive and asks for up to maxTokens back, so at worst (a
// conversation that reached the whole window before a step ended) the request is
// (1 - retainRatio) of the window, plus the directive, plus maxTokens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MIN_CTX, readManifest } from '../local.js'

const PATCH = readFileSync(new URL('../../../config/cordis.patch.yml', import.meta.url), 'utf8')
const MANIFEST = readManifest(fileURLToPath(new URL('../../../config/local-models.json', import.meta.url)))

// The engine's defaults and bounds (compaction-basic lib/index.js): retainRatio 0.16 unless set,
// maxTokens 8192, and a ratio in (0, 1] with retainRatio below thresholdRatio.
const ENGINE = { retainRatio: 0.16, maxTokens: 8192 }
// The summary directive the engine appends, 1802 characters in 0.1.5-rc.2: about 515 tokens at
// 3.5 characters a token, rounded up for a tokenizer that packs worse.
const DIRECTIVE_TOKENS = 600

/** The compaction-basic entry: its scalar keys and its one-line model policies. */
function compactionEntry(text) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.trim() === '- id: compaction-basic')
  assert.ok(at >= 0, 'config/cordis.patch.yml has a compaction-basic entry')
  const entry = { policies: [] }
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break // the next top-level entry or comment
    const policy = /^\s+- \{(.*)\}\s*$/.exec(line)
    if (policy) {
      entry.policies.push(Object.fromEntries(policy[1].split(',').map((kv) => kv.split(':').map((s) => s.trim())).map(([k, v]) => [k, /^\d+(\.\d+)?$/.test(v) ? Number(v) : v])))
      continue
    }
    const kv = /^\s+(\w+):\s*(\S+)\s*$/.exec(line)
    if (kv) entry[kv[1]] = Number(kv[2])
  }
  return entry
}

const entry = compactionEntry(PATCH)
const chatModels = MANIFEST.filter((m) => m.kind === 'model')

test('conversations are compacted at 97% of the window, within the engine\'s bounds', () => {
  assert.equal(entry.thresholdRatio, 0.97)
  const retain = entry.retainRatio ?? ENGINE.retainRatio
  assert.ok(entry.thresholdRatio > 0 && entry.thresholdRatio <= 1, 'the engine takes a ratio in (0, 1]')
  assert.ok(retain < entry.thresholdRatio, 'the engine refuses a retained tail as large as the threshold')
})

test('every local chat model has a summary that fits beside what is summarised, at the smallest window the budget allows', () => {
  assert.ok(chatModels.length > 0, 'the manifest lists local chat models')
  const retain = entry.retainRatio ?? ENGINE.retainRatio
  for (const m of chatModels) {
    const policy = entry.policies.find((p) => p.provider === 'local' && p.model === m.id)
    assert.ok(policy, `${m.id} has a compaction policy; without one the engine's ${ENGINE.maxTokens}-token summary overflows its window`)
    const maxTokens = policy.maxTokens ?? ENGINE.maxTokens
    // The RAM budget can size a local model's context down to MIN_CTX, never below it.
    const window = MIN_CTX
    const request = Math.floor(window * (1 - (policy.retainRatio ?? retain))) + DIRECTIVE_TOKENS + maxTokens
    assert.ok(request <= window, `${m.id}: the summary request (${request} tokens) must fit a ${window}-token window`)
    assert.ok(maxTokens >= 512, `${m.id}: a summary under 512 tokens keeps too little to continue from`)
  }
})

test('the engine\'s own summary length would not fit a local window, which is why the local rows exist', () => {
  const request = Math.floor(MIN_CTX * (1 - ENGINE.retainRatio)) + DIRECTIVE_TOKENS + ENGINE.maxTokens
  assert.ok(request > MIN_CTX)
})

test('no policy names a local model the manifest does not have', () => {
  const ids = new Set(chatModels.map((m) => m.id))
  for (const p of entry.policies.filter((x) => x.provider === 'local')) assert.ok(ids.has(p.model), `${p.model} is not a local chat model in config/local-models.json`)
})
