// The feature builders against each other: what a message's intent is read from (the intent domain
// and the reply predictor) is the text part of what its task is classified from, and nothing of the
// workspace, since a message is sorted before any workspace is read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_SCHEMA_VERSION, intentFeatures, taskTextFeatures } from '../features.js'

const WORKSPACE = ['file_count_log', 'dependency_count_log', 'has_tests_script', 'changed_files_log']
const CONTEXT = { fileCount: 240, dependencies: ['react', 'vite'], scripts: ['test', 'build'], changedFiles: ['src/a.js', 'src/b.js'] }

test('intentFeatures has no workspace fields and matches taskTextFeatures\' text part', () => {
  for (const [text, modalities] of [
    ['Why does src/parser.js throw a TypeError when the input is empty?', ['text']],
    ['fix the failing test in the parser\n```\nError: expected 2, got 3\n```', ['text']],
    ['what is in this screenshot', ['text', 'image']],
    ['', ['text']],
  ]) {
    const task = taskTextFeatures(text, { context: CONTEXT, modalities })
    const intent = intentFeatures(text, { modalities })
    for (const f of WORKSPACE) {
      assert.ok(task.numeric[f] > 0, `the setting: the task reads ${f} off this workspace`)
      assert.equal(f in intent.numeric, false, `${f} is a fact of the workspace, not of the message`)
    }
    const { file_count_log, dependency_count_log, has_tests_script, changed_files_log, ...textPart } = task.numeric
    assert.deepEqual(intent.numeric, textPart, 'every other column is the task\'s, value for value')
    assert.deepEqual(intent.categorical, task.categorical)
  }
  const words = intentFeatures('Explain what the router does with a forced agent')
  assert.ok(Object.keys(words.numeric).filter((k) => /^h\d+$/.test(k)).length >= 6, 'its hashed unigrams and bigrams')
  assert.deepEqual(words.categorical, { modality: 'text' }, 'text by default')
  assert.equal(intentFeatures('see this', { modalities: ['text', 'image'] }).numeric.has_image, 1)
  // A new domain reads it, not a new schema: no artifact trained before it is refused.
  assert.equal(FEATURE_SCHEMA_VERSION, 1)
})
