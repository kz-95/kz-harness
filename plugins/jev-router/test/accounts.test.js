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

test('the DeepSeek key in use is the one active as the harness started, whatever it was switched to since; other providers use no stored key', async () => {
  const { acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.list()
  assert.equal(typeof acc.keyInUse, 'function')
  await acc.addKey('deepseek', 'second', 'sk-two')
  await acc.activate('deepseek', 'second')
  assert.equal(acc.activeKey('deepseek'), 'second')
  assert.equal(acc.keyInUse('deepseek'), 'default', 'the switch waits for a restart')
  await acc.addKey('moonshot', 'm1', 'mk-one')
  assert.equal(acc.keyInUse('moonshot'), null)
})

test('a key removed while its call ran keeps no spent mark, and a key added under a spent one\'s name starts fresh', async () => {
  const { acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.list()
  assert.equal(typeof acc.markKeyExhausted, 'function')
  const until = new Date(Date.now() + 3_600_000).toISOString()
  await acc.addKey('deepseek', 'spare', 'sk-spare')
  await acc.removeKey('deepseek', 'spare')
  await acc.markKeyExhausted('deepseek', 'spare', { until, reason: 'HTTP 402' })
  assert.equal((await acc.list()).exhausted['deepseek:spare'], undefined, 'no mark for a key no longer listed')
  await acc.markKeyExhausted('deepseek', 'default', { until, reason: 'HTTP 402' })
  assert.equal((await acc.list()).exhausted['deepseek:default']?.reason, 'HTTP 402')
  // A mark left over from an older key of that name (written before this rule) is cleared by adding it.
  await acc.markExhausted('deepseek:spare', { until, reason: 'HTTP 402' })
  await acc.addKey('deepseek', 'spare', 'sk-new')
  assert.equal((await acc.list()).exhausted['deepseek:spare'], undefined)
})

test('after a restart the key in use is the one active at that launch, not the first listed; a plugin reload without a restart keeps the launch key', async () => {
  const { dir, envFile, credentials, acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.list()
  await acc.addKey('deepseek', 'second', 'sk-two')
  await acc.activate('deepseek', 'second')
  // The plugin applied again in the same process: its calls still go out on the launch key.
  const reloaded = createAccounts({ dataDir: dir, envFile, credentials })
  await reloaded.list()
  assert.equal(reloaded.keyInUse('deepseek'), 'default')
  // A restart: the key active then is the one in use, and a switch since waits for the next.
  const restarted = createAccounts({ dataDir: dir, envFile, credentials, launched: {} })
  await restarted.list()
  assert.equal(restarted.keyInUse('deepseek'), 'second')
  await restarted.activate('deepseek', 'default')
  assert.equal(restarted.keyInUse('deepseek'), 'second')
})

test('a key removed and added again under the launch key\'s name is not the key in use, and a limit on the old one does not mark it', async () => {
  const { acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.list()
  assert.equal(acc.keyInUse('deepseek'), 'default')
  await acc.removeKey('deepseek', 'default')
  await acc.addKey('deepseek', 'default', 'sk-new')
  assert.equal(acc.keyInUse('deepseek'), null, 'the calls still go out on the old key, which is not stored')
  await acc.markKeyExhausted('deepseek', 'default', { until: new Date(Date.now() + 3_600_000).toISOString(), reason: 'HTTP 402' })
  assert.equal((await acc.list()).exhausted['deepseek:default'], undefined)
})

test('a key added while the active one is spent becomes the active one, for after a restart; a mark says whether it was made', async () => {
  const { acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.list()
  const until = new Date(Date.now() + 3_600_000).toISOString()
  assert.equal(await acc.markKeyExhausted('deepseek', 'default', { until, reason: 'HTTP 402' }), true)
  assert.equal(await acc.markKeyExhausted('deepseek', 'nokey', { until, reason: 'HTTP 402' }), false)
  const r = await acc.addKey('deepseek', 'fresh', 'sk-fresh')
  assert.deepEqual([r.restartRequired, acc.activeKey('deepseek')], [true, 'fresh'])
  // Beside an active key that is not spent, an added key waits in reserve.
  await acc.addKey('deepseek', 'spare', 'sk-spare')
  assert.equal(acc.activeKey('deepseek'), 'fresh')
})

test('the launch key removed keeps its last reading and a limit met on it with the process, through a plugin reload', async () => {
  const { dir, envFile, credentials } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  const launched = {}
  const acc = createAccounts({ dataDir: dir, envFile, credentials, launched })
  await acc.list()
  assert.equal(typeof acc.noteKeyInUse, 'function')
  acc.noteKeyInUse('deepseek', { name: 'default', balance: { amount: 2, currency: 'USD' }, state: 'stopped', until: null })
  await acc.markKeyExhausted('deepseek', 'default', { until: new Date(Date.now() + 3_600_000).toISOString(), reason: 'HTTP 402' })
  await acc.addKey('deepseek', 'second', 'sk-two')
  await acc.removeKey('deepseek', 'default')
  // The plugin applied again: the process's record of the key in use is the same one.
  const reloaded = createAccounts({ dataDir: dir, envFile, credentials, launched })
  await reloaded.list()
  const gone = reloaded.launchKeyGone('deepseek')
  assert.deepEqual([gone?.name, gone?.spent?.reason, gone?.reading?.balance?.amount], ['default', 'HTTP 402', 2])
})

test('a restart is asked for only when the key made active is not the one calls go out on; an added key takes over from one out by the caller\'s reading', async () => {
  const { acc } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.list()
  const r1 = await acc.addKey('deepseek', 'second', 'sk-two', { isOut: (n) => n === 'default' })
  assert.deepEqual([r1.restartRequired, acc.activeKey('deepseek')], [true, 'second'])
  // Back on the launch key: nothing to restart for.
  assert.equal((await acc.activate('deepseek', 'default')).restartRequired, false)
  await acc.activate('deepseek', 'second')
  assert.equal((await acc.removeKey('deepseek', 'second')).restartRequired, false, 'removing the pending key leaves the launch key active')
  await assert.rejects(acc.addKey('deepseek', '_x', 'sk-x'), /starting with a letter or digit/)
})

test('removing the last key removes its value where DSH reads it too, and asks for a restart; an active key removed gives way to the next usable one', async () => {
  const { acc, envFile } = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await acc.list()
  const r = await acc.removeKey('deepseek', 'default')
  assert.equal(r.restartRequired, true, 'calls go out on the removed key until the restart')
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).get('DEEPSEEK_API_KEY'), undefined, 'deleted from this PC, as the dialog says')
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).get('OTHER'), 'x')
  // Keys a (active), b (spent) and c: removing a skips b.
  const two = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await two.acc.list()
  await two.acc.addKey('deepseek', 'b', 'sk-b')
  await two.acc.addKey('deepseek', 'c', 'sk-c')
  await two.acc.markKeyExhausted('deepseek', 'b', { until: new Date(Date.now() + 3_600_000).toISOString(), reason: 'HTTP 402' })
  await two.acc.removeKey('deepseek', 'default')
  assert.equal(two.acc.activeKey('deepseek'), 'c')
  // Out by the caller's reading is skipped too.
  const three = setup({ DEEPSEEK_API_KEY: 'sk-old' })
  await three.acc.list()
  await three.acc.addKey('deepseek', 'b', 'sk-b')
  await three.acc.addKey('deepseek', 'c', 'sk-c')
  await three.acc.removeKey('deepseek', 'default', { isOut: (n) => n === 'b' })
  assert.equal(three.acc.activeKey('deepseek'), 'c')
})

test('removing a Jev key takes its value from where Jev falls back to it too, whatever keys are left; a restart is said for DeepSeek only', async () => {
  const { acc, envFile, credentials } = setup({ DEEPSEEK_API_KEY: 'sk-old', TYPESAFE_API_KEY: 'ts-1' })
  await acc.list()
  await acc.addKey('jev', 'fresh', 'ts-2')
  await acc.activate('jev', 'fresh')
  const r = await acc.removeKey('jev', 'default')
  assert.equal(r.restartRequired, false, 'Jev reads its key per call')
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).get('TYPESAFE_API_KEY'), undefined, 'the removed key is gone from this PC')
  assert.ok(credentials.calls.some(([op, ref]) => op === 'unset' && ref === 'TYPESAFE_API_KEY'), 'and from the credential store')
  assert.equal(parseEnv(readFileSync(envFile, 'utf8')).get('DEEPSEEK_API_KEY'), 'sk-old', 'another provider\'s line stays')
  assert.deepEqual(acc.restartPendingProviders(), [])
  await acc.addKey('deepseek', 'second', 'sk-two')
  await acc.activate('deepseek', 'second')
  assert.deepEqual(acc.restartPendingProviders(), ['deepseek'])
})

test('a Jev key held only in the credential store is unset from it when removed, and a store holding another value is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-acc-'))
  const envFile = join(dir, '.env')
  writeFileSync(envFile, 'DEEPSEEK_API_KEY=sk-old\n')
  const credentials = creds({ TYPESAFE_API_KEY: 'ts-store' })
  const acc = createAccounts({ dataDir: dir, envFile, credentials })
  assert.equal((await acc.list()).keys.jev[0].name, 'default', 'registered from the store')
  await acc.addKey('jev', 'fresh', 'ts-2')
  await acc.activate('jev', 'fresh')
  await acc.removeKey('jev', 'default')
  assert.ok(credentials.calls.some(([op, ref]) => op === 'unset' && ref === 'TYPESAFE_API_KEY'), 'unset from the store')
  // The store now holds another value: removing 'fresh' leaves it.
  const other = creds({ TYPESAFE_API_KEY: 'ts-other' })
  const acc2 = createAccounts({ dataDir: mkdtempSync(join(tmpdir(), 'kz-acc-')), envFile: join(dir, '.env2'), credentials: other })
  writeFileSync(join(dir, '.env2'), '')
  await acc2.list()
  await acc2.addKey('jev', 'mine', 'ts-mine')
  await acc2.removeKey('jev', 'mine')
  assert.ok(!other.calls.some(([op]) => op === 'unset'), 'a different value in the store is not the removed key')
})
