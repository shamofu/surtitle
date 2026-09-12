// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationCoverage } from './coverage.mjs';
import { semanticReport, evaluate } from './evaluation.mjs';

const execution = { model_id: 'fixture-model', location: 'global', max_output_tokens: 1024, thinking: { kind: 'omit' }, price: { id: 'fixture-price', source: 'offline', observed_at_ms: 1000, input_microusd_per_million: 1, output_microusd_per_million: 1 } };
function fixture() {
  const plan = { candidates: [{ id: 'flash-candidate', execution }], cases: [{ caseId: 'text-en', taskKind: 'explanation', terms: ['take off', 'break down'], proficiencies: ['A2', 'B1', 'C1'], candidateIds: ['flash-candidate'] }] };
  const requests = plan.cases[0].terms.flatMap(term => ['A2', 'B1', 'C1'].map(proficiency => ({ id: `${term}-${proficiency}`, caseId: 'text-en', taskKind: 'explanation', term, proficiency, execution: structuredClone(execution), requestBodySha256: 'a'.repeat(64), digest: 'b'.repeat(64) })));
  return { plan, requests, cases: [{ id: 'text-en' }], selected: ['text-en'] };
}
function check(fixture) { return evaluationCoverage(fixture.plan, fixture.requests, fixture.cases, fixture.selected); }

test('independent matrix expands case × term × level × candidate; one response cannot cover omitted rows', () => {
  const data = fixture();
  assert.equal(check(data).expectedRequests, 6);
  assert.equal(check(data).passed, true);
  data.requests = data.requests.slice(0, 1);
  assert.equal(check(data).missing.length, 5);
  assert.equal(check(data).passed, false);
});
test('duplicate attempts, unexpected terms, changed model settings and absent hashes fail coverage', () => {
  const duplicate = fixture(); duplicate.requests.push({ ...duplicate.requests[0], id: 'duplicate' });
  assert.equal(check(duplicate).duplicate.length, 1);
  for (const field of ['term', 'proficiency', 'requestBodySha256', 'digest', 'execution']) {
    const data = fixture(); data.requests[0][field] = field === 'execution' ? { ...execution, max_output_tokens: 1025 } : 'wrong';
    const report = check(data);
    assert.equal(report.passed, false); assert.equal(report.invalid.length, 1); assert.equal(report.missing.length, 1);
  }
});
test('matrices cannot silently omit selected cases or repeat execution identities', () => {
  const data = fixture(); data.selected.push('missing');
  assert.throws(() => check(data), /explicit matrix/);
  const repeated = fixture(); repeated.plan.candidates.push({ id: 'second-name', execution });
  assert.throws(() => check(repeated), /Duplicate candidate execution/);
});
test('semantic scores require concrete evidence for every dimension and proficiency review', () => {
  const dimensions = ['meaning', 'exampleContext', 'translation', 'explanation'];
  const expected = Array.from({ length: 30 }, (_, i) => ({ requestId: `request-${i}`, itemId: 'item:0', language: 'ja', taskKind: 'explanation', candidateId: 'candidate', proficiency: ['A2', 'B1', 'C1'][i % 3] }));
  const reviews = expected.map(item => ({ ...item, scores: Object.fromEntries(dimensions.map(d => [d, 2])), evidence: Object.fromEntries(dimensions.map(d => [d, `Authored fixture: the ${d} retains source roles and selected expression.`])), criticalErrors: [], understandableAtProficiency: true, proficiencyEvidence: 'Authored fixture uses the declared level of detail.' }));
  assert.equal(semanticReport(expected, reviews).passed, true);
  delete reviews[0].evidence.meaning;
  assert.equal(semanticReport(expected, reviews).invalid.length, 1);
  reviews[0].evidence.meaning = 'The source subject and object remain unchanged.';
  reviews[0].understandableAtProficiency = false;
  assert.equal(semanticReport(expected, reviews).passed, true);
  reviews[3].understandableAtProficiency = false;
  const failed = semanticReport(expected, reviews);
  assert.equal(failed.passed, false); assert.equal(failed.groups[0].proficiency.A2.rate, .8);
});
test('a good candidate cannot hide another candidate that fails semantic review', () => {
  const expected = ['good', 'bad'].flatMap(candidateId => Array.from({ length: 20 }, (_, i) => ({ requestId: `${candidateId}-${i}`, itemId: 'item:0', language: 'en', taskKind: 'translation', candidateId })));
  const reviews = expected.map(item => ({ ...item, scores: { meaning: item.candidateId === 'bad' ? 1 : 2, naturalness: 2 }, evidence: { meaning: 'The authored bad candidate loses a source constraint.', naturalness: 'Both authored candidates are grammatical.' }, criticalErrors: [] }));
  const result = semanticReport(expected, reviews);
  assert.equal(result.groups.length, 2); assert.equal(result.groups[0].passed, true); assert.equal(result.groups[1].passed, false); assert.equal(result.passed, false);
});

test('untimed diagnostics never count as subtitle quality even with perfect recognition', () => {
  const sha = 'c'.repeat(64);
  const manifest = { schemaVersion: 1, cases: [{ id: 'audio-en', language: 'en', audio: { sha256: sha }, cues: [{ id: 'cue', startMs: 0, endMs: 500, text: 'Hello.' }] }] };
  const results = { schemaVersion: 1, requests: [{ id: 'request', caseId: 'audio-en', taskKind: 'transcribe_diagnostic', sourceAudioSha256: sha, state: 'completed', output: { kind: 'untimed_transcript', text: 'Hello.' } }] };
  const report = evaluate(manifest, results);
  assert.equal(report.requests[0].recognition.rate, 0);
  assert.equal(report.requests[0].status, 'diagnostic_only');
  assert.equal(report.requests[0].subtitleQualityAssessed, false);
  assert.equal(report.gatesPassed, false);
});

test('explicit non-speech controls reject invented cues without pretending tones are silence', () => {
  const sha = 'd'.repeat(64);
  const manifest = { schemaVersion: 1, cases: [{ id: 'tones', language: 'en', audio: { sha256: sha, durationMs: 1000, classification: 'non-speech' }, cues: [] }] };
  const request = { id: 'request', caseId: 'tones', taskKind: 'audio_transcription', sourceAudioSha256: sha, state: 'completed', output: { kind: 'transcript', cues: [] } };
  const results = { schemaVersion: 1, requests: [request] };
  const empty = evaluate(manifest, results);
  assert.equal(empty.requests[0].timestamps.status, 'not_applicable_to_non_speech');
  assert.equal(empty.requests[0].timestamps.passed, true);
  request.output.cues.push({ id: 'invented', startMs: 100, endMs: 500, text: 'Hello.' });
  const invented = evaluate(manifest, results);
  assert.equal(invented.requests[0].recognition.passed, false);
  assert.equal(invented.requests[0].timestamps.passed, false);
});
