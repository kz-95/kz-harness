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
  return { calls, resolve: async (r) => (values[r] ? { value: values[r], source } : undefined), describe: async () => ({ source }), set: async (r, v) => { calls.push([r, v]) } }
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

test('activation rewrites DEEPSEEK_API_KEY and the live credential store; rotation cycles and skips spent keys', async () => {
  const { envFile, credentials, acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.addKey('deepseek', 'second', 'sk-two')
  await acc.addKey('deepseek', 'third', 'sk-three')
  assert.equal(acc.activeKey('deepseek'), 'default')
  assert.equal(acc.nextKey('deepseek'), 'second')
  assert.equal(acc.nextKey('deepseek', (n) => n === 'second'), 'third')
  await acc.markExhausted('deepseek:second', { until: new Date(Date.now() + 60_000).toISOString(), reason: '402' })
  assert.equal(acc.nextKey('deepseek'), 'third')
  const r = await acc.activate('deepseek', 'third')
  assert.equal(r.restartRequired, false)
  assert.deepEqual(credentials.calls.at(-1), ['DEEPSEEK_API_KEY', 'sk-three'])
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).get('DEEPSEEK_API_KEY'), 'sk-three')
  assert.equal(acc.nextKey('deepseek'), 'default') // wraps, skipping the exhausted one
  assert.ok(!existsSync(`${envFile}.tmp`))
  await acc.removeKey('deepseek', 'third') // active one: next becomes active
  assert.equal(acc.activeKey('deepseek'), 'default')
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).has('KZ_KEY__deepseek__third'), false)
})

test('an inherited env var shadows the store: activation says restart', async () => {
  const { acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' }, 'env')
  await acc.addKey('deepseek', 'b', 'sk-b')
  assert.equal((await acc.activate('deepseek', 'b')).restartRequired, true)
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
