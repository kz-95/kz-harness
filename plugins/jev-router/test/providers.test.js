// The provider records: Jev's carries exactly today's values, Laya's its own, and a bad Laya
// block never takes Jev down (docs/laya-auto.md 2.1, 2.2, 2.6).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DECIDER_IDS, DEFAULT_JEV, JEV_THRESHOLDS, LAYA_SCHEMA, LAYA_THRESHOLDS, MINIMUM_REVIEW_KEYS, TEACHER,
  jevRecord, providerName, resolveProviders, thresholdsSchema, validateThresholds,
} from '../providers.js'
import { resolvePolicy } from '../routing-policy.js'

// A config as the jev-router Config produces it today, before any Laya key existed: the five
// threshold keys it declares, with their defaults, and nothing else.
const LEGACY = {
  credentialRef: 'TYPESAFE_API_KEY',
  jevModel: 'jev-1.13.0',
  jevTimeoutMs: 20_000,
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  routing: {},
}
const policyOf = (config) => resolvePolicy(config.routing ?? {})
const resolve = (config) => resolveProviders(config, { policy: policyOf(config) })

// Every cut-off as the code read it before it became a key, where it was read (2.6, the Jev column).
const TODAY = {
  minQuestionConfidence: 0.6, // adapter.js MIN_QUESTION_CONFIDENCE
  alsoWork: 0.7, // adapter.js ALSO_WORK
  supportingSkill: 0.15, // jev.js profileFromAnswers
  verificationChecks: 0.5, // jev.js profileFromAnswers
  continueHandoff: 0.5, // router.js, the handoff note
  tool: 0.5, // thresholds.tool
  toolArgConfidence: 0.5, // router.js, the weakest tool argument
  needsTests: 0.5, // thresholds.needsTests
  humanRequired: 0.6, // router.js, thresholds.humanRequired ?? 0.6
  judgmentYes: 0.5, // decision.js, the second-opinion label
  riskForReview: 0.6, // routing-policy.js minimumReview
  riskForFrontierReview: 0.8, // routing-policy.js minimumReview
  easyComplexity: 0.5, // decision.js conservation
  requirementWanted: 0.5, // decision.js, broker.js
  needsPerson: 0.6, // jev-review NEEDS_PERSON
  reject: 0.3, // jev-review REJECT
  accept: { low: 0.55, medium: 0.7, high: 0.85 }, // thresholds.accept
  riskBands: { low: 0.25, medium: 0.6 }, // jev-review's accept bands
  humanReview: 0.7, // thresholds.humanReview
  secondOpinion: 0.6, // thresholds.secondOpinion
  effortBands: { medium: 0.25, high: 0.6 }, // effort.js autoLevel
}

test('the Jev record from a legacy config carries today\'s values, key by key', () => {
  const { jev } = resolve(LEGACY)
  assert.deepEqual(Object.keys(jev.thresholds).sort(), Object.keys(TODAY).sort())
  for (const [k, v] of Object.entries(TODAY)) assert.deepEqual(jev.thresholds[k], v, k)
  assert.equal(jev.id, 'jev')
  assert.equal(jev.name, 'Jev')
  assert.equal(jev.teacher, true)
  assert.equal(jev.local, false)
  assert.equal(jev.model, 'jev-1.13.0')
  assert.deepEqual(jev.timeoutMs, { intent: 20_000, route: 20_000, review: 20_000 })
  assert.equal(jev.maxRetries, 2, 'the SDK default, unchanged')
  assert.equal(jev.usdPerInputToken, 0.042 / 1e6)
  // The keys it has always had keep their configured values, and a config with none at all is
  // the same record: every key falls back to today's constant.
  const tuned = resolve({ ...LEGACY, jevModel: 'jev-1.14.0', jevTimeoutMs: 9000, thresholds: { ...LEGACY.thresholds, accept: { low: 0.5, medium: 0.6, high: 0.9 }, tool: 0.7 } }).jev
  assert.deepEqual(tuned.thresholds.accept, { low: 0.5, medium: 0.6, high: 0.9 })
  assert.equal(tuned.thresholds.tool, 0.7)
  assert.equal(tuned.model, 'jev-1.14.0')
  assert.deepEqual(tuned.timeoutMs, { intent: 9000, route: 9000, review: 9000 })
  assert.deepEqual(resolve({}).jev, jev)
  assert.deepEqual(DEFAULT_JEV, jev, 'the record old callers get is the same')
  assert.deepEqual(JEV_THRESHOLDS, TODAY)
})

test('riskForReview and riskForFrontierReview keep their one source, routing.minimumReview', () => {
  const { jev } = resolve({ ...LEGACY, routing: { minimumReview: { riskForReview: 0.5, riskForFrontierReview: 0.7 } } })
  assert.equal(jev.thresholds.riskForReview, 0.5)
  assert.equal(jev.thresholds.riskForFrontierReview, 0.7)
  // Jev's thresholds schema does not declare them, so they have no second home in the config.
  const own = thresholdsSchema(JEV_THRESHOLDS, { omit: MINIMUM_REVIEW_KEYS })({})
  assert.ok(!('riskForReview' in own) && !('riskForFrontierReview' in own))
  assert.equal(own.accept.medium, 0.7)
})

test('thresholds.humanRequired, read by the router but never declared, reaches the Jev record', () => {
  const { jev } = resolve({ ...LEGACY, thresholds: { ...LEGACY.thresholds, humanRequired: 0.75 } })
  assert.equal(jev.thresholds.humanRequired, 0.75)
  const own = thresholdsSchema(JEV_THRESHOLDS, { omit: MINIMUM_REVIEW_KEYS })({})
  assert.equal(own.humanRequired, 0.6, 'declared, with today\'s value as its default')
})

test('an override changes Laya and never Jev', () => {
  const plain = resolve(LEGACY)
  const over = resolve({ ...LEGACY, laya: { thresholds: { humanRequired: 0.9, accept: { high: 0.95 }, needsTests: 0.4 } } })
  assert.equal(over.layaError, null)
  assert.equal(over.laya.thresholds.humanRequired, 0.9)
  assert.deepEqual(over.laya.thresholds.accept, { low: 0.65, medium: 0.8, high: 0.95 }, 'the other bands keep Laya\'s defaults')
  assert.equal(over.laya.thresholds.needsTests, 0.4)
  assert.deepEqual(over.jev, plain.jev)
  // And the other way: a Jev threshold is never read as Laya's.
  const jevTuned = resolve({ ...LEGACY, thresholds: { ...LEGACY.thresholds, tool: 0.65, humanRequired: 0.7 } })
  assert.deepEqual(jevTuned.laya, plain.laya)
  assert.equal(plain.laya.thresholds.tool, 0.8)
})

test('the Laya record is local, free, unretried and on the English checkpoint', () => {
  const { laya, layaError, layaSettings } = resolve(LEGACY)
  assert.equal(layaError, null)
  assert.equal(laya.id, 'laya')
  assert.equal(laya.name, 'Laya')
  assert.equal(laya.teacher, false)
  assert.equal(laya.local, true)
  assert.equal(laya.model, 'english')
  assert.equal(laya.timeoutMs, null, 'the Laya client computes its own deadlines')
  assert.equal(laya.maxRetries, 0)
  assert.equal(laya.usdPerInputToken, 0)
  assert.deepEqual(laya.thresholds, LAYA_THRESHOLDS)
  // 2.6, the Laya column.
  assert.deepEqual(LAYA_THRESHOLDS, {
    minQuestionConfidence: 0.8, alsoWork: 0.8, supportingSkill: 0.2, verificationChecks: 'always',
    continueHandoff: 0.6, tool: 0.8, toolArgConfidence: 0.7, needsTests: 'always', humanRequired: 0.8,
    judgmentYes: 0.5, riskForReview: 0.45, riskForFrontierReview: 0.7, easyComplexity: 0.4, requirementWanted: 0.6,
    needsPerson: 0.6, reject: 0.3, accept: { low: 0.65, medium: 0.8, high: 0.9 }, riskBands: { low: 0.25, medium: 0.6 },
    humanReview: 0.6, secondOpinion: 0.6, effortBands: { medium: 0.25, high: 0.6 },
  })
  // The rest of the block, every default filled, for the sidecar and the Laya client.
  assert.equal(layaSettings.enabled, true)
  assert.equal(layaSettings.port, 8091)
  assert.equal(layaSettings.connectivityUrl, 'http://www.msftconnecttest.com/connecttest.txt')
  assert.deepEqual(layaSettings.deadlines, { floorMs: 8000, ceilingMs: 120000, hardMs: 270000, startWaitMs: 300000 })
  assert.deepEqual(layaSettings.shadow, { maxQueue: 8, maxAgeMs: 600000, chunkRows: 4 })
  assert.deepEqual(layaSettings.temperatureCorrections, { 'choice:11+': 3.27 })
  assert.equal(layaSettings.minTopMargin, 0.1)
  assert.equal(layaSettings.thresholds, laya.thresholds)
  // Switched off is still a record: whether Laya may be asked is decided where it is asked.
  const off = resolve({ ...LEGACY, laya: { enabled: false } })
  assert.equal(off.layaSettings.enabled, false)
  assert.ok(off.laya)
})

test('records are frozen, all the way down', () => {
  const { jev, laya, layaSettings } = resolve(LEGACY)
  for (const [name, v] of Object.entries({ jev, laya, layaSettings, DEFAULT_JEV, JEV_THRESHOLDS, LAYA_THRESHOLDS })) {
    assert.ok(Object.isFrozen(v), name)
    assert.ok(Object.isFrozen(v.thresholds ?? v), `${name} thresholds`)
    assert.ok(Object.isFrozen((v.thresholds ?? v).accept), `${name} accept`)
  }
  assert.ok(Object.isFrozen(jev.timeoutMs))
  assert.ok(Object.isFrozen(layaSettings.deadlines))
  assert.throws(() => { jev.thresholds.tool = 0 }, TypeError)
  assert.equal(jev.thresholds.tool, 0.5)
  // Building a record never freezes what it was built from.
  const laya2 = { thresholds: { accept: { low: 0.7 } } }
  resolve({ ...LEGACY, laya: laya2 })
  assert.ok(!Object.isFrozen(laya2.thresholds.accept))
})

test('every threshold key is present after resolveProviders, filled from the defaults', () => {
  // A raw block that sets one key, and a Jev config that sets none: no reader may ever see
  // undefined for a threshold.
  const { jev, laya } = resolveProviders({ thresholds: { tool: 0.6 }, laya: { thresholds: { reject: 0.2 } } }, {})
  for (const [record, defaults] of [[jev, JEV_THRESHOLDS], [laya, LAYA_THRESHOLDS]]) {
    assert.deepEqual(Object.keys(record.thresholds).sort(), Object.keys(defaults).sort())
    for (const [k, v] of Object.entries(record.thresholds)) {
      assert.notEqual(v, undefined, `${record.id}.${k}`)
      if (v && typeof v === 'object') for (const [b, x] of Object.entries(defaults[k])) assert.equal(typeof v[b], typeof x, `${record.id}.${k}.${b}`)
    }
  }
  assert.equal(jev.thresholds.tool, 0.6)
  assert.equal(jev.thresholds.riskForReview, 0.6, 'no policy handed in: today\'s default')
  assert.equal(laya.thresholds.reject, 0.2)
  // jevRecord, for callers that pass only part of a set, fills the rest the same way.
  assert.deepEqual(jevRecord({ thresholds: { accept: { low: 0.5 } } }).thresholds.accept, { low: 0.5, medium: 0.7, high: 0.85 })
})

test("'always' is accepted for verificationChecks and needsTests, and nowhere else", () => {
  const { jev, laya, layaError } = resolve({ ...LEGACY, thresholds: { ...LEGACY.thresholds, needsTests: 'always', verificationChecks: 'always' } })
  assert.equal(layaError, null)
  assert.equal(jev.thresholds.needsTests, 'always')
  assert.equal(jev.thresholds.verificationChecks, 'always')
  assert.equal(laya.thresholds.needsTests, 'always', 'Laya\'s default')
  assert.equal(laya.thresholds.verificationChecks, 'always')
  assert.equal(resolve({ ...LEGACY, laya: { thresholds: { needsTests: 0.3 } } }).laya.thresholds.needsTests, 0.3)
  assert.throws(() => resolve({ ...LEGACY, thresholds: { ...LEGACY.thresholds, tool: 'always' } }), { message: /^providers: thresholds\.tool / })
  assert.match(resolve({ ...LEGACY, laya: { thresholds: { humanRequired: 'always' } } }).layaError, /laya\.thresholds\.humanRequired/)
  assert.match(resolve({ ...LEGACY, laya: { thresholds: { needsTests: 'never' } } }).layaError, /laya\.thresholds\.needsTests/)
})

test('each ordering check throws naming the key', () => {
  const t = (over) => ({ ...JEV_THRESHOLDS, ...over })
  const cases = [
    [{ accept: { low: 0.9, medium: 0.8, high: 0.95 } }, /^providers: laya\.thresholds\.accept: low 0\.9 is above medium 0\.8$/],
    [{ accept: { low: 0.5, medium: 0.9, high: 0.85 } }, /^providers: laya\.thresholds\.accept: medium 0\.9 is above high 0\.85$/],
    [{ reject: 0.55 }, /^providers: laya\.thresholds\.reject: 0\.55 is not below accept\.low 0\.55$/],
    [{ riskBands: { low: 0.6, medium: 0.6 } }, /^providers: laya\.thresholds\.riskBands: low 0\.6 is not below medium 0\.6$/],
    [{ riskForReview: 0.9, riskForFrontierReview: 0.8 }, /^providers: laya\.thresholds\.riskForReview: 0\.9 is above riskForFrontierReview 0\.8$/],
    [{ effortBands: { medium: 0.6, high: 0.6 } }, /^providers: laya\.thresholds\.effortBands: medium 0\.6 is not below high 0\.6$/],
  ]
  for (const [over, message] of cases) assert.throws(() => validateThresholds(t(over), 'laya'), { message })
  assert.doesNotThrow(() => validateThresholds(JEV_THRESHOLDS, 'jev'))
  assert.doesNotThrow(() => validateThresholds(LAYA_THRESHOLDS, 'laya'))
  // For Jev, each message names where the value is configured.
  assert.throws(() => validateThresholds(t({ accept: { low: 0.9, medium: 0.8, high: 0.95 } }), 'jev'), { message: /^providers: thresholds\.accept: / })
  assert.throws(() => resolve({ ...LEGACY, routing: { minimumReview: { riskForReview: 0.9, riskForFrontierReview: 0.8 } } }), { message: /^providers: routing\.minimumReview\.riskForReview: 0\.9 is above riskForFrontierReview 0\.8$/ })
  // And every temperature correction names one of Laya's buckets.
  assert.match(resolve({ ...LEGACY, laya: { temperatureCorrections: { 'choice:12': 2 } } }).layaError, /^providers: laya\.temperatureCorrections: 'choice:12' is not one of Laya's buckets/)
  for (const key of ['choice:2', 'score:3-5', 'noul:6-10', 'choice:11+']) assert.equal(resolve({ ...LEGACY, laya: { temperatureCorrections: { [key]: 1.5 } } }).layaError, null, key)
})

test('a bad Laya block yields layaError and leaves Jev intact: a type, a range or an ordering', () => {
  const good = resolve(LEGACY)
  const bad = {
    'accept.low 1.5': [{ thresholds: { accept: { low: 1.5 } } }, 'providers: laya.thresholds.accept.low expected number <= 1 but got 1.5'],
    'a correction of 10': [{ temperatureCorrections: { 'choice:11+': 10 } }, /^providers: laya\.temperatureCorrections\.choice:11\+ expected number <= 5 but got 10$/],
    'hardMs over 290 s': [{ deadlines: { hardMs: 300000 } }, /^providers: laya\.deadlines\.hardMs /],
    'a string for a number': [{ port: 'eighty' }, /^providers: laya\.port /],
    'not an object at all': [5, /^providers: laya: /],
    'an ordering': [{ thresholds: { accept: { low: 0.85 } } }, 'providers: laya.thresholds.accept: low 0.85 is above medium 0.8'],
  }
  for (const [what, [laya, message]] of Object.entries(bad)) {
    const r = resolve({ ...LEGACY, laya })
    assert.equal(r.laya, null, what)
    assert.equal(r.layaSettings, null, what)
    if (typeof message === 'string') assert.equal(r.layaError, message, what)
    else assert.match(r.layaError, message, what)
    assert.deepEqual(r.jev, good.jev, `${what}: Jev is untouched`)
  }
  // A bad Jev value throws, as a bad Jev threshold always has: Jev's keys stay typed in Config.
  assert.throws(() => resolve({ ...LEGACY, thresholds: { ...LEGACY.thresholds, accept: { low: 1.5, medium: 0.7, high: 0.85 } } }), { message: /^providers: thresholds\.accept\.low expected number <= 1/ })
})

test('laya.connectivityUrl is an http or https address on no TypeSafe host, or Laya is off with an error that names the key', () => {
  const good = resolve(LEGACY)
  const at = (connectivityUrl, env = {}) => resolveProviders({ ...LEGACY, laya: { connectivityUrl } }, { policy: policyOf(LEGACY), env })
  const typesafe = (host) => `providers: laya.connectivityUrl: ${host} is a TypeSafe address, and a Laya Auto session never contacts TypeSafe; name another, such as the default http://www.msftconnecttest.com/connecttest.txt`
  const refused = {
    // Probed before every Laya Auto route, chat-model pick and title: each probe would reach TypeSafe.
    'Jev\'s own host': ['https://api.typesafe.ai', {}, typesafe('api.typesafe.ai')],
    'the bare domain': ['http://typesafe.ai/', {}, typesafe('typesafe.ai')],
    'any name under it': ['https://Console.TypeSafe.ai./keys', {}, typesafe('console.typesafe.ai.')],
    'where TYPESAFE_BASE_URL sends Jev': ['http://10.0.0.7:8443/health', { TYPESAFE_BASE_URL: 'http://10.0.0.7:8443/v1' }, typesafe('10.0.0.7:8443')],
    // Every probe would fail, and every Laya Auto run would be narrowed to the local agents.
    'not a URL': ['foo', {}, "providers: laya.connectivityUrl: 'foo' is not an http or https address"],
    'another scheme': ['ftp://example.com/', {}, "providers: laya.connectivityUrl: 'ftp://example.com/' is not an http or https address"],
    'empty': ['', {}, "providers: laya.connectivityUrl: '' is not an http or https address"],
  }
  for (const [what, [url, env, message]] of Object.entries(refused)) {
    const r = at(url, env)
    assert.equal(r.layaError, message, what)
    assert.deepEqual([r.laya, r.layaSettings], [null, null], what)
    assert.deepEqual(r.jev, good.jev, `${what}: Jev is untouched`)
  }
  // Any other address is Laya's to probe: a name that only ends like TypeSafe's, and Jev's host on
  // another port, included.
  for (const [url, env] of [['https://example.com/generate_204', {}], ['http://nottypesafe.ai/', {}], ['http://10.0.0.7:9000/', { TYPESAFE_BASE_URL: 'http://10.0.0.7:8443' }], ['https://api.typesafe.ai.example.com/', {}]]) {
    const r = at(url, env)
    assert.equal(r.layaError, null, url)
    assert.equal(r.layaSettings.connectivityUrl, url)
  }
  assert.equal(good.layaSettings.connectivityUrl, 'http://www.msftconnecttest.com/connecttest.txt', 'the default is probed as it stands')
})

test('LAYA_SCHEMA and thresholdsSchema fill every default from an empty block', () => {
  const block = LAYA_SCHEMA({})
  assert.deepEqual(block.thresholds, { ...LAYA_THRESHOLDS })
  assert.deepEqual(LAYA_SCHEMA(undefined).deadlines, block.deadlines)
  assert.deepEqual(thresholdsSchema(LAYA_THRESHOLDS)({}), { ...LAYA_THRESHOLDS })
})

test('the teacher, the decider ids and the names every string uses', () => {
  assert.equal(TEACHER, 'jev')
  assert.deepEqual(DECIDER_IDS, ['jev', 'laya'])
  assert.ok(Object.isFrozen(DECIDER_IDS))
  assert.equal(providerName('jev'), 'Jev')
  assert.equal(providerName('laya'), 'Laya')
  assert.equal(providerName('other'), 'other')
})

test('the old form of a Jev record keeps the SDK defaults it never named', () => {
  // createJev({ apiKey }) never passed a model or a timeout: the SDK chose them, and still does.
  const bare = jevRecord({})
  assert.equal(bare.model, undefined)
  assert.equal(bare.timeoutMs, null)
  assert.deepEqual(bare.thresholds, JEV_THRESHOLDS)
  assert.deepEqual(jevRecord({ model: 'jev-1.13.0', timeoutMs: 1000 }).timeoutMs, { intent: 1000, route: 1000, review: 1000 })
})
