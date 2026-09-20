// Keys live only in .env; accounts.json holds metadata. Rotation order, .env
// rewrite, first-run registration, live activation and /use parsing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccounts, parseEnv, parseUse, setEnvLines } from '../accounts.js'

const creds = (values = {}, source = 'file') => {
  const calls = []
  return { calls, resolve: async (r) => (values[r] ? { value: values[r], source } : undefined), describe: async () => ({ source }), set: async (r, v) => { calls.push(['set', r, v]) }, unset: async (r) => { calls.push(['unset', r]) } }
}
function setup(values, source) {
  const dir = mkdtempSync(join(tmpdir(), 'kz-acc-'))
  const envFile = join(dir, '.env')
  writeFileSync(envFile, '# my keys\r\nTYPESAFE_API_KEY="ts-1"\r\nDEEPSEEK_API_KEY=sk-old\r\nOTHER=x\r\n')
  const credentials = creds(values, source)
  return { dir, envFile, credentials, acc: createAccounts({ dataDir: dir, envFile, credentials }) }
}

test('setEnvLines keeps other lines, CRLF and comments; parseEnv unquotes', () => {
  const src = '# c\r\nA="1"\r\nexport B=2\r\nC=3\r\n'
  const out = setEnvLines(src, { B: 'new', C: null, D: '4' })
  assert.equal(out, '# c\r\nA="1"\r\nB=new\r\nD=4\r\n')
  assert.deepEqual([...parseEnv(out)], [['A', '1'], ['B', 'new'], ['D', '4']])
})

test('first run registers the keys DSH uses as "default"; values stay out of accounts.json', async () => {
  const { dir, envFile, acc } = setup({ DEEPSEEK_API_KEY: 'sk-old', TYPESAFE_API_KEY: 'ts-1' })
  const s = await acc.list()
  assert.deepEqual(s.keys.deepseek.map((k) => [k.name, k.active]), [['default', true]])
  assert.equal(s.keys.jev[0].name, 'default')
  const env = parseEnv(readFileSync(envFile, 'utf8'))
  assert.equal(env.get('KZ_KEY__deepseek__default'), 'sk-old')
  assert.equal(env.get('OTHER'), 'x')
  assert.ok(!readFileSync(join(dir, 'accounts.json'), 'utf8').includes('sk-old'))
  assert.equal(await acc.resolveKey('jev', 'default'), 'ts-1')
})

test('activation rewrites .env only and clears the store copy; rotation cycles and skips spent keys', async () => {
  const { envFile, credentials, acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.addKey('deepseek', 'second', 'sk-two')
  await acc.addKey('deepseek', 'third', 'sk-three')
  assert.equal(acc.activeKey('deepseek'), 'default')
  assert.equal(acc.nextKey('deepseek'), 'second')
  assert.equal(acc.nextKey('deepseek', (n) => n === 'second'), 'third')
  await acc.markExhausted('deepseek:second', { until: new Date(Date.now() + 60_000).toISOString(), reason: '402' })
  assert.equal(acc.nextKey('deepseek'), 'third')
  const r = await acc.activate('deepseek', 'third')
  // .env is read once at launch, so a switch needs a restart; that is the price of one home for the secret.
  assert.equal(r.restartRequired, true)
  // The store is cleared, never written: a copy there would shadow the .env we just wrote.
  assert.deepEqual(credentials.calls.at(-1), ['unset', 'DEEPSEEK_API_KEY'])
  assert.equal(credentials.calls.some((c) => c[0] === 'set'), false, 'a key value is never handed to the credential store')
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).get('DEEPSEEK_API_KEY'), 'sk-three')
  assert.equal(acc.nextKey('deepseek'), 'default') // wraps, skipping the exhausted one
  assert.ok(!existsSync(`${envFile}.tmp`))
  await acc.removeKey('deepseek', 'third') // active one: next becomes active
  assert.equal(acc.activeKey('deepseek'), 'default')
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).has('KZ_KEY__deepseek__third'), false)
})

test('activation says restart whatever the store says, and a store without unset is tolerated', async () => {
  const { acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' }, 'env')
  await acc.addKey('deepseek', 'b', 'sk-b')
  assert.equal((await acc.activate('deepseek', 'b')).restartRequired, true)

  // No credentials service at all: .env is still written and nothing throws.
  const dir = mkdtempSync(join(tmpdir(), 'kz-acc-'))
  const envFile = join(dir, '.env')
  writeFileSync(envFile, 'DEEPSEEK_API_KEY=sk-old\n')
  const bare = createAccounts({ dataDir: dir, envFile })
  await bare.addKey('deepseek', 'b', 'sk-b')
  assert.equal((await bare.activate('deepseek', 'b')).restartRequired, true)
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).get('DEEPSEEK_API_KEY'), 'sk-b')
})

test('bad names and values are refused', async () => {
  const { acc } = setup({})
  await assert.rejects(acc.addKey('deepseek', 'Bad Name', 'sk'), /key name/)
  await assert.rejects(acc.addKey('deepseek', 'ok', 'has space'), /value/)
  await assert.rejects(acc.setLimits('claude', { stopAtPercent: 140 }), /0-100/)
})

test('/use parses aliases, all, and rejects unknown agents', () => {
  const ids = ['claude', 'codex', 'deepseek', 'mine']
  assert.deepEqual(parseUse('claude ds', ids), ['claude', 'deepseek'])
  assert.deepEqual(parseUse('GPT + DS', ids), ['codex', 'deepseek'])
  assert.deepEqual(parseUse('chatgpt', ids), ['codex'])
  assert.deepEqual(parseUse('cc, mine', ids), ['claude', 'mine'])
  assert.deepEqual(parseUse('all', ids), ids)
  assert.throws(() => parseUse('', ids), /usage/)
  assert.throws(() => parseUse('gemini', ids), /unknown agent gemini/)
})
