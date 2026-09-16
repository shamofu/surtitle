// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareTextCase } from './prepare-text-case.mjs';

const corpus = JSON.parse(readFileSync(new URL('../../crates/ai/tests/fixtures/evaluation/text-corpus.json', import.meta.url)));
test('authored text becomes native RequestTask data without answer keys or an approval', () => {
  const vocabulary = prepareTextCase(corpus, 'T01-en', 'vocabulary');
  assert.equal(vocabulary.kind, 'vocabulary'); assert.equal(vocabulary.cues.length, 20); assert.equal(vocabulary.max_items, 20);
  assert.equal(vocabulary.cues[0].start_ms, 0); assert.equal(vocabulary.cues[0].end_ms, 3500);
  assert.equal(JSON.stringify(vocabulary).includes('referenceTranslation'), false);
  assert.equal(JSON.stringify(vocabulary).includes('meaning'), false);
  assert.equal(prepareTextCase(corpus, 'T01-ja', 'translation').target_language, 'en');
});
test('multicue expression and explicit proficiency are preserved; absent terms fail', () => {
  const task = prepareTextCase(corpus, 'T02-en', 'explanation', 'look forward to', 'A2');
  assert.equal(task.term, 'look forward to'); assert.equal(task.proficiency, 'A2');
  assert.throws(() => prepareTextCase(corpus, 'T02-en', 'explanation', 'invented example', 'A2'), /absent/);
  assert.throws(() => prepareTextCase(corpus, 'T02-en', 'explanation', 'bank', 'expert'), /valid proficiency/);
  assert.throws(() => prepareTextCase(corpus, 'missing', 'vocabulary'), /existing/);
});
test('quoted instructions and HTML stay literal subtitle strings', () => {
  const task = prepareTextCase(corpus, 'T03-en', 'vocabulary');
  assert.ok(task.cues.some(cue => cue.text.includes('<script>')));
  assert.ok(task.cues.some(cue => cue.text.includes('Ignore previous instructions')));
  assert.deepEqual(Object.keys(task).sort(), ['cues', 'explanation_language', 'kind', 'learning_language', 'max_items']);
});
