// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { units, errorRate, timestampErrors, semanticReport, boundaryReport, evaluate, sha256 } from './evaluation.mjs';

const corpus = JSON.parse(readFileSync(new URL('../../crates/ai/tests/fixtures/evaluation/text-corpus.json', import.meta.url)));
const boundaryOracle = JSON.parse(readFileSync(new URL('../../crates/ai/tests/fixtures/evaluation/boundary-oracle.json', import.meta.url)));
const reference = corpus.cases[0];
const resultHash = 'a'.repeat(64);
const referenceHash = 'b'.repeat(64);
function aiReviews(items) {
  return { ...reviews(structuredClone(items)), reviewMethod: 'ai-review', reviewer: 'Fixture AI reviewer', reviewerModel: 'fixture-review-model', referenceReview: { method: 'ai-review', reviewer: 'Fixture reference AI reviewer', model: 'fixture-reference-model', reviewedAt: '2026-09-09T00:00:00Z', referencesSha256: referenceHash, independentOfModelOutput: true } };
}
function reviews(items) { items = items.map(item => ({ ...item, evidence: Object.fromEntries(Object.keys(item.scores).map(dimension => [dimension, `Authored regression fixture evidence for ${dimension}; not a real quality review.`])) })); return { schemaVersion: 1, reviewer: 'Fixture reviewer (not a human quality judgment)', reviewedAt: '2026-09-08T00:00:00Z', resultsSha256: resultHash, items, timestampMatches: [], boundaries: [] }; }
function translationFixture() {
  const results = { schemaVersion: 1, evidenceKind: 'authored-oracle', requests: [{ id: 'request-1', caseId: reference.id, state: 'completed', taskKind: 'translation', sourceCues: reference.cues, output: { kind: 'translation', translations: reference.cues.map(cue => ({ id: cue.id, translation: cue.referenceTranslation })) } }] };
  const rubric = reviews(reference.cues.map(cue => ({ requestId: 'request-1', itemId: cue.id, scores: { meaning: 2, naturalness: 2 }, criticalErrors: [] })));
  return { results, rubric };
}

test('authored corpus has T01/T02/T03, twenty cues and ten terms in each language', () => {
  assert.equal(corpus.license, 'GPL-3.0-or-later');
  assert.deepEqual(corpus.cases.map(item => item.id), ['T01-en', 'T01-ja', 'T02-en', 'T02-ja', 'T03-en', 'T03-ja']);
  for (const item of corpus.cases) {
    assert.equal(item.cues.length, 20); assert.ok(item.vocabulary.length >= 10);
    assert.equal(new Set(item.cues.map(cue => cue.id)).size, 20);
    assert.equal(item.evidenceKind, 'authored-oracle');
    assert.ok(item.cues.every(cue => cue.referenceTranslation && cue.startMs < cue.endMs));
    assert.ok(item.vocabulary.every(term => term.sourceCueIds.every(id => item.cues.some(cue => cue.id === id))));
  }
  assert.ok(corpus.cases.find(item => item.id === 'T02-en').vocabulary.some(term => term.sourceCueIds.length === 2));
  assert.ok(corpus.cases.find(item => item.id === 'T03-ja').cues.some(cue => cue.text.includes('<script>')));
});

test('WER normalization keeps contractions, negation, numbers, fillers and repetitions', () => {
  assert.deepEqual(units('ＣＡＮ’T stop; um, um! 13.5 + 2.', 'en'), ["can't", 'stop', 'um', 'um', '13.5', '+', '2']);
  assert.equal(errorRate('The cat sat.', 'THE dog sat!', 'en').substitutions, 1);
  assert.equal(errorRate('No, no, no.', 'No, no.', 'en').deletions, 1);
  assert.equal(errorRate('I do not agree.', 'I do agree.', 'en').deletions, 1);
  assert.equal(errorRate('13.5 liters', '135 liters', 'en').substitutions, 1);
  assert.equal(errorRate('Go.', 'Go now.', 'en').insertions, 1);
});

test('CER uses normalized Unicode code points and preserves meaningful repetitions and symbols', () => {
  assert.deepEqual(units('カ\u3099、Ａ １２！🙂', 'ja'), ['ガ', 'a', '1', '2', '🙂']);
  assert.equal(errorRate('いや、いや。', 'いや。', 'ja').deletions, 2);
  assert.equal(errorRate('時々', '時', 'ja').deletions, 1);
  assert.equal(errorRate('合計は５＋２', '合計は５２', 'ja').deletions, 1);
  assert.equal(errorRate('13.5リットル', '135リットル', 'ja').deletions, 1);
  assert.throws(() => units('bonjour', 'fr'), /Only explicitly/);
});

test('empty oracle with hallucinated text fails and oversize comparisons are bounded', () => {
  assert.deepEqual(errorRate('', 'hello', 'en'), { metric: 'WER', referenceUnits: 0, hypothesisUnits: 1, errors: 1, substitutions: 0, deletions: 0, insertions: 1, rate: null, passed: false });
  assert.equal(errorRate('', '', 'en').rate, 0);
  assert.throws(() => errorRate('a '.repeat(4000), 'a '.repeat(4000), 'en'), /too large/);
});

test('timestamps pool start/end errors with explicit IDs and documented quantiles', () => {
  const original = Array.from({ length: 5 }, (_, index) => ({ id: `word-${index}`, text: `word${index}`, startMs: index * 1000, endMs: index * 1000 + 500 }));
  const actual = original.map((cue, index) => ({ ...cue, startMs: cue.startMs + index * 20 + 10, endMs: cue.endMs + index * 20 + 20 }));
  const report = timestampErrors(original, actual, 'en', 5000);
  assert.equal(report.medianMs, 55); assert.equal(report.p95Ms, 100); assert.equal(report.passed, true);
});

test('quantized point word anchors contribute timing errors without invented durations', () => {
  const reference = [{ id: 'word', text: 'the', startMs: 100, endMs: 250 }];
  const actual = [{ id: 'word', text: 'the', startMs: 200, endMs: 200 }];
  assert.throws(() => timestampErrors(reference, actual, 'en', 1000), /invalid interval/);
  const report = timestampErrors(reference, actual, 'en', 1000, { allowPointHypothesis: true });
  assert.equal(report.pointHypothesisCount, 1);
  assert.deepEqual(report.absoluteErrorsMs, [50, 100]);
  assert.equal(report.matchedIds.length, 1);
  assert.throws(() => timestampErrors(reference, [{ ...actual[0], endMs: 199 }], 'en', 1000, { allowPointHypothesis: true }), /invalid interval/);
});

test('missing, unmatched and wrong-text IDs cannot hide behind passing timestamp subset', () => {
  const original = [{ id: 'a', text: 'yes', startMs: 0, endMs: 200 }, { id: 'b', text: 'no', startMs: 300, endMs: 500 }, { id: 'c', text: 'go', startMs: 600, endMs: 800 }];
  const actual = [original[0], { ...original[1], text: 'yes' }, { ...original[2], id: 'unmatched' }];
  const report = timestampErrors(original, actual, 'en', 1000);
  assert.equal(report.numericPassed, true); assert.equal(report.passed, false);
  assert.deepEqual(report.missingIds, ['c']); assert.deepEqual(report.unmatchedIds, ['unmatched']); assert.deepEqual(report.changedTextIds, ['b']);
  assert.equal(report.excludedReferenceCount, 2);
  assert.throws(() => timestampErrors(original, [original[0], original[0]], 'en', 1000), /duplicate/);
  assert.throws(() => timestampErrors(original, [{ ...original[0], startMs: -.5 }], 'en', 1000), /invalid interval/);
  assert.throws(() => timestampErrors(original, [original[2], original[0]], 'en', 1000), /not monotonic/);
});

test('manual rubric imports 0/1/2 scores with twenty item and dimension-specific gates', () => {
  const expected = Array.from({ length: 20 }, (_, index) => ({ requestId: 'request', itemId: `item:${index}`, language: 'en', taskKind: 'translation' }));
  const scores = expected.map((item, index) => ({ ...item, scores: { meaning: index < 4 ? 1 : 2, naturalness: 2 }, evidence: { meaning: 'Authored fixture explicitly preserves the same negation and actors.', naturalness: 'Authored fixture uses its expected grammatical sentence.' }, criticalErrors: [] }));
  assert.equal(semanticReport(expected, scores).passed, true);
  assert.equal(semanticReport(expected, scores).groups[0].dimensions.meaning.mean, 1.8);
  assert.equal(semanticReport(expected, scores.slice(1)).passed, false);
  assert.equal(semanticReport(expected.slice(0, 19), scores.slice(0, 19)).passed, false);
  const wrong = structuredClone(scores); wrong[0].scores.meaning = 0;
  assert.equal(semanticReport(expected, wrong).passed, false);
  wrong[0].scores.meaning = .5;
  assert.equal(semanticReport(expected, wrong).invalid.length, 1);
  wrong[0].scores.meaning = 2; wrong[0].criticalErrors = ['negation reversed'];
  assert.equal(semanticReport(expected, wrong).critical.length, 1);
});

test('twenty boundary oracle checks retain real repeats; marked mismatch remains failed', () => {
  const boundaries = boundaryOracle.boundaries;
  const observations = boundaries.map(item => ({ id: item.id, joinedText: item.text, originalLeft: item.text.slice(0, 4), originalRight: item.text.slice(4), needsReview: false, manuallyAccepted: true }));
  assert.equal(boundaryReport(boundaries, observations).passed, true);
  assert.equal(boundaryReport(boundaries, observations.slice(1)).passed, false);
  observations[0].joinedText = 'I said no, no, and then I left.';
  let result = boundaryReport(boundaries, observations);
  assert.equal(result.mismatches, 1); assert.equal(result.unflaggedMismatches, 1); assert.equal(result.passed, false);
  observations[0].needsReview = true;
  result = boundaryReport(boundaries, observations);
  assert.equal(result.unflaggedMismatches, 0); assert.equal(result.passed, false);
  observations[0].originalLeft = '';
  assert.equal(boundaryReport(boundaries, observations).unflaggedMismatches, 1);
});

test('repeating one boundary twenty times does not satisfy twenty distinct locations', () => {
  const boundaries = Array.from({ length: 20 }, (_, index) => ({ id: `repeat-${index}`, locationId: 'same-source:same-boundary', language: 'en', text: 'No, no.' }));
  const observations = boundaries.map(item => ({ id: item.id, joinedText: item.text, originalLeft: 'No,', originalRight: 'no.', needsReview: false, manuallyAccepted: true }));
  const report = boundaryReport(boundaries, observations);
  assert.equal(report.checked, 20); assert.equal(report.uniqueLocations, 1); assert.equal(report.passed, false);
});

test('native validation report accepts fixed text output without claiming live quality', () => {
  const { results, rubric } = translationFixture();
  const report = evaluate(corpus, results, rubric, { caseIds: [reference.id], resultsSha256: resultHash });
  assert.equal(report.gatesPassed, true); assert.equal(report.status, 'oracle_or_unverified_evidence');
  assert.equal(report.evidence.realModelQualityAssessed, false); assert.equal(report.evidence.modelQualified, false);
  assert.equal(evaluate(corpus, results, null, { caseIds: [reference.id] }).gatesPassed, false);
  assert.throws(() => evaluate(corpus, results, rubric, { resultsSha256: 'b'.repeat(64) }), /different results/);
});

test('changed source, missing cases and repeated translation IDs block evaluation', () => {
  const { results, rubric } = translationFixture();
  assert.equal(evaluate(corpus, results, rubric, { resultsSha256: resultHash }).missingCaseIds.length, 5);
  results.requests[0].sourceCues = structuredClone(reference.cues); results.requests[0].sourceCues[0].text = 'Changed subtitle';
  assert.equal(evaluate(corpus, results, rubric, { caseIds: [reference.id], resultsSha256: resultHash }).requests[0].reason, 'source_cues_do_not_match_reference');
  results.requests[0].sourceCues = reference.cues;
  results.requests[0].output.translations[1].id = results.requests[0].output.translations[0].id;
  assert.equal(evaluate(corpus, results, rubric, { caseIds: [reference.id], resultsSha256: resultHash }).gatesPassed, false);
});

test('audio timestamps require explicit sidecar alignment, never guessed positional IDs', () => {
  const cue = { id: 'spoken-1', text: 'No, no.', startMs: 0, endMs: 500 };
  const manifest = { schemaVersion: 1, cases: [{ id: 'A02-en', language: 'en', evidenceKind: 'human-reviewed-reference', cues: [cue], audio: { sha256: 'c'.repeat(64), durationMs: 1000 } }] };
  const results = { schemaVersion: 1, evidenceKind: 'provider-validation', requests: [{ id: 'audio-1', caseId: 'A02-en', taskKind: 'transcribe_preview', state: 'completed', sourceAudioSha256: 'c'.repeat(64), output: { kind: 'transcript', cues: [{ text: 'No, no.', startMs: 50, endMs: 600 }] } }] };
  const rubric = reviews([]);
  let report = evaluate(manifest, results, rubric, { resultsSha256: resultHash });
  assert.equal(report.gatesPassed, false); assert.deepEqual(report.requests[0].timestamps.missingIds, ['spoken-1']);
  rubric.timestampMatches = [{ requestId: 'audio-1', referenceId: cue.id, outputIndex: 0 }];
  report = evaluate(manifest, results, rubric, { resultsSha256: resultHash });
  assert.equal(report.gatesPassed, true); assert.equal(report.requests[0].timestamps.medianMs, 75);
  results.requests[0].sourceAudioSha256 = 'd'.repeat(64);
  assert.equal(evaluate(manifest, results, rubric, { resultsSha256: resultHash }).gatesPassed, false);
});

test('Transcribe word evidence is separately aligned; missing or truncated evidence never uses cue scores', () => {
  const cue = { id: 'cue-1', text: 'Yes, no.', startMs: 0, endMs: 1000 };
  const words = [{ id: 'word-1', text: 'Yes', startMs: 0, endMs: 300 }, { id: 'word-2', text: 'no', startMs: 600, endMs: 900 }];
  const manifest = { schemaVersion: 1, cases: [{ id: 'audio-case', language: 'en', evidenceKind: 'authored-oracle', cues: [cue], words, audio: { sha256: 'c'.repeat(64), durationMs: 1500 } }] };
  const results = { schemaVersion: 1, evidenceKind: 'authored-oracle', requests: [{ id: 'request', caseId: 'audio-case', taskKind: 'transcribe_preview', state: 'completed', sourceAudioSha256: 'c'.repeat(64), output: { kind: 'transcript', cues: [{ text: cue.text, startMs: 0, endMs: 1000 }] }, attempts: [{ id: 'attempt', state: 'settled', evidence: { evidenceTruncated: false, audioTranscriptions: [{ text: cue.text, finished: true, words: [{ word: 'Yes', startOffset: '0.100s', endOffset: '0.400s' }, { word: 'no', startOffset: '0.600s', endOffset: '0.900s' }] }] } }] }] };
  const rubric = reviews([]);
  rubric.timestampMatches = [{ requestId: 'request', referenceId: cue.id, outputIndex: 0 }];
  let report = evaluate(manifest, results, rubric, { resultsSha256: resultHash });
  assert.equal(report.requests[0].timestamps.passed, true); assert.equal(report.gatesPassed, false);
  assert.equal(report.requests[0].wordTimestamps.status, 'missing_explicit_word_alignment');
  rubric.timestampMatches.push(...words.map((word, outputIndex) => ({ requestId: 'request', referenceId: word.id, outputIndex, level: 'word', attemptId: 'attempt' })));
  report = evaluate(manifest, results, rubric, { resultsSha256: resultHash });
  assert.equal(report.requests[0].wordTimestamps.medianMs, 50); assert.equal(report.requests[0].wordTimestamps.p95Ms, 100); assert.equal(report.gatesPassed, true);
  results.requests[0].attempts[0].evidence.evidenceTruncated = true;
  report = evaluate(manifest, results, rubric, { resultsSha256: resultHash });
  assert.equal(report.gatesPassed, false); assert.match(report.requests[0].reason, /truncated/);
  results.requests[0].attempts[0].evidence.evidenceTruncated = false;
  results.requests[0].attempts[0].evidence.audioTranscriptions[0].words[0].startOffset = '-0.100s';
  assert.match(evaluate(manifest, results, rubric, { resultsSha256: resultHash }).requests[0].reason, /invalid_word_duration/);
});

test('a reference ID that resembles an unmatched label cannot bypass explicit timestamp mapping', () => {
  const cue = { id: 'unmatched-output:0', text: 'Hello', startMs: 0, endMs: 500 };
  const manifest = { schemaVersion: 1, cases: [{ id: 'audio', language: 'en', evidenceKind: 'authored-oracle', cues: [cue], audio: { sha256: 'c'.repeat(64), durationMs: 1000 } }] };
  const results = { schemaVersion: 1, requests: [{ id: 'request', caseId: 'audio', taskKind: 'audio_transcription', state: 'completed', sourceAudioSha256: 'c'.repeat(64), output: { kind: 'transcript', cues: [{ text: cue.text, startMs: 0, endMs: 500 }] } }] };
  const report = evaluate(manifest, results);
  assert.equal(report.gatesPassed, false); assert.deepEqual(report.requests[0].timestamps.missingIds, [cue.id]);
});

test('silence must be explicitly annotated and fails on invented speech', () => {
  const manifest = { schemaVersion: 1, cases: [{ id: 'silence', language: 'ja', evidenceKind: 'authored-oracle', cues: [], audio: { sha256: 'c'.repeat(64), durationMs: 1000, classification: 'silence' } }] };
  const results = { schemaVersion: 1, requests: [{ id: 'request', caseId: 'silence', taskKind: 'audio_transcription', state: 'completed', sourceAudioSha256: 'c'.repeat(64), output: { kind: 'transcript', cues: [] } }] };
  assert.equal(evaluate(manifest, results).gatesPassed, true);
  results.requests[0].output.cues = [{ text: 'こんにちは', startMs: 0, endMs: 500 }];
  assert.equal(evaluate(manifest, results).gatesPassed, false);
  results.requests[0].output.cues = []; manifest.cases[0].audio.classification = 'speech';
  assert.equal(evaluate(manifest, results).requests[0].reason, 'empty_reference_needs_explicit_silence_annotation');
});

test('provider label alone cannot qualify unreviewed references or unlock a model', () => {
  const { results, rubric } = translationFixture();
  results.evidenceKind = 'provider-validation';
  const manifest = structuredClone(corpus); manifest.cases[0].evidenceKind = 'human-reviewed-reference';
  let report = evaluate(manifest, results, rubric, { caseIds: [reference.id], resultsSha256: resultHash });
  assert.equal(report.evidence.referenceReviewComplete, false); assert.equal(report.evidence.realModelQualityAssessed, false);
  manifest.cases[0].review = { annotator: 'Fixture annotator', independentReviewer: 'Fixture independent reviewer', reviewedAt: '2026-09-08T00:00:00Z' };
  report = evaluate(manifest, results, rubric, { caseIds: [reference.id], resultsSha256: resultHash });
  assert.equal(report.status, 'evaluation_gates_passed'); assert.equal(report.evidence.modelQualified, false);
  manifest.cases[0].review.independentReviewer = manifest.cases[0].review.annotator;
  assert.equal(evaluate(manifest, results, rubric, { caseIds: [reference.id], resultsSha256: resultHash }).evidence.referenceReviewComplete, false);
});

test('CLI writes hash-bound incomplete report and review template without overwriting', t => {
  const temp = mkdtempSync(join(tmpdir(), 'surtitle 評価 & '));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const { results } = translationFixture(), input = join(temp, 'results.json'), output = join(temp, 'report.json'), template = join(temp, 'review.json');
  writeFileSync(input, JSON.stringify(results));
  const args = [fileURLToPath(new URL('./evaluate.mjs', import.meta.url)), '--manifest', fileURLToPath(new URL('../../crates/ai/tests/fixtures/evaluation/text-corpus.json', import.meta.url)), '--results', input, '--case-id', reference.id, '--output', output, '--rubric-template', template];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 2, child.stderr);
  assert.equal(JSON.parse(readFileSync(template)).resultsSha256, sha256(readFileSync(input)));
  assert.equal(JSON.parse(readFileSync(template)).reviewMethod, 'ai-review');
  assert.equal(JSON.parse(readFileSync(template)).referenceReview.independentOfModelOutput, false);
  assert.equal(JSON.parse(readFileSync(template)).referenceReview.referencesSha256, sha256(readFileSync(new URL('../../crates/ai/tests/fixtures/evaluation/text-corpus.json', import.meta.url))));
  assert.equal(JSON.parse(readFileSync(output)).evidence.modelQualified, false);
  const rerun = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(rerun.status, 1); assert.match(rerun.stderr, /EEXIST/);
});

test('AI review binds both evidence files and never claims human confirmation', () => {
  const { results, rubric: legacy } = translationFixture();
  results.evidenceKind = 'provider-validation';
  const rubric = aiReviews(legacy.items);
  const options = { caseIds: [reference.id], resultsSha256: resultHash, referencesSha256: referenceHash };
  const report = evaluate(corpus, results, rubric, options);
  assert.equal(report.status, 'evaluation_gates_passed');
  assert.equal(report.requests[0].status, 'ai_review_pass');
  assert.equal(report.reviewProvenance.method, 'ai-review');
  assert.equal(report.reviewProvenance.model, 'fixture-review-model');
  assert.equal(report.evidence.humanReviewDeclared, false);
  assert.equal(report.evidence.manualRubricBoundToResults, false);
  assert.equal(report.evidence.aiReferenceReviewBoundToReferences, true);
  assert.equal(report.evidence.modelQualified, false);
  assert.throws(() => evaluate(corpus, results, rubric, { ...options, referencesSha256: 'c'.repeat(64) }), /different reference file/);
  for (const change of [r => { r.reviewerModel = ''; }, r => { r.referenceReview.independentOfModelOutput = false; }, r => { r.referenceReview.model = ''; }]) {
    const invalid = structuredClone(rubric); change(invalid);
    assert.throws(() => evaluate(corpus, results, invalid, options));
  }
  results.evidenceKind = 'authored-oracle';
  assert.equal(evaluate(corpus, results, rubric, options).status, 'oracle_or_unverified_evidence');
});

test('AI scores cannot bypass sample size, critical meaning errors, or source matching', () => {
  const { results, rubric: legacy } = translationFixture();
  results.evidenceKind = 'provider-validation';
  const rubric = aiReviews(legacy.items);
  const options = { caseIds: [reference.id], resultsSha256: resultHash, referencesSha256: referenceHash };
  rubric.items.pop();
  assert.equal(evaluate(corpus, results, rubric, options).gatesPassed, false);
  rubric.items = legacy.items;
  rubric.items[0].criticalErrors = ['The requested disclosure became an unlocking action.'];
  assert.equal(evaluate(corpus, results, rubric, options).gatesPassed, false);
  rubric.items[0].criticalErrors = [];
  results.requests[0].sourceCues = structuredClone(reference.cues);
  results.requests[0].sourceCues[0].text = 'An unrelated source';
  assert.equal(evaluate(corpus, results, rubric, options).gatesPassed, false);
});

test('semantic request status follows its language/task group without hiding other group failures', () => {
  const { results, rubric: legacy } = translationFixture();
  const japanese = corpus.cases.find(item => item.id === 'T01-ja');
  results.requests.push({ id: 'request-ja', caseId: japanese.id, state: 'completed', taskKind: 'translation', sourceCues: japanese.cues, output: { kind: 'translation', translations: japanese.cues.map(cue => ({ id: cue.id, translation: cue.referenceTranslation })) } });
  const rubric = aiReviews([...legacy.items, ...japanese.cues.map((cue, index) => ({ requestId: 'request-ja', itemId: cue.id, scores: { meaning: index < 5 ? 1 : 2, naturalness: 2 }, criticalErrors: [] }))]);
  const options = { caseIds: [reference.id, japanese.id], resultsSha256: resultHash, referencesSha256: referenceHash };
  let report = evaluate(corpus, results, rubric, options);
  assert.equal(report.gatesPassed, false);
  assert.equal(report.requests[0].status, 'ai_review_pass');
  assert.equal(report.requests[1].status, 'incomplete_or_failed_ai_review');
  rubric.items.slice(20).forEach(item => { item.scores.meaning = 2; });
  rubric.items[20].criticalErrors = ['A critical error cannot pass its group.'];
  report = evaluate(corpus, results, rubric, options);
  assert.equal(report.semantic.groups.find(item => item.language === 'ja').passed, false);
  assert.equal(report.requests[0].status, 'ai_review_pass');
  assert.equal(report.requests[1].status, 'incomplete_or_failed_ai_review');
});

test('AI boundary acceptance is explicit and cannot count a human-acceptance field', () => {
  const observations = boundaryOracle.boundaries.map(item => ({ id: item.id, joinedText: item.text, originalLeft: item.text.slice(0, 4), originalRight: item.text.slice(4), needsReview: false, manuallyAccepted: true }));
  assert.equal(boundaryReport(boundaryOracle.boundaries, observations, 'ai-review').passed, false);
  observations.forEach(item => { item.reviewAccepted = true; });
  assert.equal(boundaryReport(boundaryOracle.boundaries, observations, 'ai-review').passed, true);
  observations[0].joinedText = 'Deleted a repeated word';
  observations[0].needsReview = true;
  assert.equal(boundaryReport(boundaryOracle.boundaries, observations, 'ai-review').passed, false);
});

test('AI reference review does not bypass real audio provenance or numeric timing', () => {
  const cue = { id: 'cue', text: 'Hello.', startMs: 0, endMs: 1000 };
  const manifest = { schemaVersion: 1, cases: [{ id: 'audio', evidenceKind: 'ai-reviewed-reference', language: 'en', cues: [cue], audio: { sha256: 'c'.repeat(64), durationMs: 2000, source: 'Owned recording fixture', license: 'CC0-1.0', evaluationUsePermitted: true } }] };
  const results = { schemaVersion: 1, evidenceKind: 'provider-validation', requests: [{ id: 'request', caseId: 'audio', state: 'completed', taskKind: 'audio_transcription', sourceAudioSha256: 'c'.repeat(64), output: { kind: 'transcript', cues: [{ text: cue.text, startMs: 0, endMs: 1000 }] } }] };
  const rubric = aiReviews([]), options = { resultsSha256: resultHash, referencesSha256: referenceHash };
  assert.equal(evaluate(manifest, results, rubric, options).gatesPassed, false);
  rubric.timestampMatches = [{ requestId: 'request', referenceId: 'cue', outputIndex: 0 }];
  assert.equal(evaluate(manifest, results, rubric, options).status, 'evaluation_gates_passed');
  manifest.cases[0].audio.evaluationUsePermitted = false;
  assert.equal(evaluate(manifest, results, rubric, options).status, 'oracle_or_unverified_evidence');
  manifest.cases[0].audio.evaluationUsePermitted = true;
  manifest.cases[0].evidenceKind = 'authored-oracle';
  assert.equal(evaluate(manifest, results, rubric, options).status, 'oracle_or_unverified_evidence');
});

test('semantic regression references preserve lexemes, level differences, commands and literal source fragments', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../crates/ai/tests/fixtures/evaluation/semantic-regressions.json', import.meta.url)));
  assert.equal(fixtures.evidenceKind, 'authored-oracle');
  for (const item of fixtures.vocabularyCases) {
    const source = corpus.cases.find(c => c.id === item.sourceCaseId);
    assert.equal(source.cues.filter(cue => item.sourceCueIds.includes(cue.id)).map(cue => cue.text).join(' '), item.sourceText);
    assert.equal(item.referenceOutput.items[0].term, item.expectedTerm);
    assert.ok(!item.criticalConfusions.includes(item.expectedTerm));
  }
  assert.deepEqual(fixtures.explanationCases.map(item => item.proficiency), ['A2', 'B1', 'C1']);
  assert.equal(new Set(fixtures.explanationCases.map(item => JSON.stringify(item.requiredSemanticFeatures))).size, 3);
  for (const item of [...fixtures.translationCases, ...fixtures.literalCases]) {
    const cue = corpus.cases.find(c => c.id === item.sourceCaseId).cues.find(c => c.id === item.sourceCueId);
    if (item.literal) assert.ok(cue.text.includes(item.literal));
    else assert.equal(cue.text, item.sourceText);
  }
});
