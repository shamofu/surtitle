// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { secondsToSample, parseAmiNxt, verifyAmiExtraction, inspectKoniwa, prepareChunkReference, suggestSelectionEdges } from './transcribe-references.mjs';
import { referenceReadiness } from './transcribe-policy.mjs';
import { sha256 } from './evaluation.mjs';

const namespace = '{http://nite.sourceforge.net/}';
const hash = 'a'.repeat(64);
function nxt(speaker, children) {
  return Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>\n<nite:root nite:id="ES2002a.${speaker}.words" xmlns:nite="http://nite.sourceforge.net/">${children}</nite:root>`, 'latin1');
}
function fixture() {
  const files = ['A', 'B', 'C', 'D'].map(speakerId => ({ speakerId, basename: `ami-ES2002a.${speakerId}.words.xml`,
    bytes: nxt(speakerId, `<w nite:id="ES2002a.${speakerId}.words0" starttime="10.01" endtime="10.20">I'm</w>
<w nite:id="ES2002a.${speakerId}.words1" starttime="10.20" endtime="10.20" punc="true">.</w>
<vocalsound nite:id="ES2002a.${speakerId}.words2" starttime="10.21" endtime="10.30" type="laugh"/>`) }));
  const words = ['A', 'B', 'C', 'D'].map(speakerId => ({ id: `ES2002a.${speakerId}.words0`, speakerId,
    startMs: 10010, endMs: 10200, text: "I'm", attributes: { [`${namespace}id`]: `ES2002a.${speakerId}.words0`, starttime: '10.01', endtime: '10.20' } }))
    .concat(['A', 'B', 'C', 'D'].map(speakerId => ({ id: `ES2002a.${speakerId}.words1`, speakerId,
      startMs: 10200, endMs: 10200, text: '.', attributes: { [`${namespace}id`]: `ES2002a.${speakerId}.words1`, starttime: '10.20', endtime: '10.20', punc: 'true' } })));
  return { files, upstream: { kind: 'upstream-manual-word-transcription', generatedByAsr: false, recordingId: 'AMI/ES2002a',
    originalFiles: files.map(file => ({ path: file.basename, sha256: sha256(file.bytes) })), words } };
}
const source = { id: 'source', recordingId: 'AMI/ES2002a', language: 'en', sampleRate: 16_000, samples: 20 * 16_000, sha256: hash };
const selection = { id: 'selection', profileId: 'current120' };
const chunk = { id: 'request', coreStartSample: 9 * 16_000, coreEndSample: 11 * 16_000,
  requestStartSample: 9 * 16_000, requestEndSample: 11 * 16_000, audioSha256: hash };

test('decimal coordinates are exact and sub-sample or malformed timestamps are rejected', () => {
  assert.equal(secondsToSample('60.35'), 965600);
  assert.equal(secondsToSample('0.0000625'), 1);
  assert.equal(secondsToSample('21600'), 345600000);
  for (const value of ['0.00001', '-1', '1e3', 'NaN', '21600.1', ' 10']) assert.throws(() => secondsToSample(value));
});

test('NXT preserves point punctuation, non-lexical events, Latin-1 and escaped words', () => {
  const bytes = nxt('A', '<w nite:id="ES2002a.A.words0" starttime="0.01" endtime="0.20">caf\xe9&#39;s &amp; tea</w>'
    + '<w nite:id="ES2002a.A.words1" starttime="0.20" endtime="0.20" punc="true">.</w>'
    + '<disfmarker nite:id="ES2002a.A.words2" starttime="0.21" endtime="0.30"/>');
  const records = parseAmiNxt(bytes, 'AMI/ES2002a', 'A');
  assert.equal(records[0].text, "café's & tea"); assert.equal(records[0].startSample, 160);
  assert.equal(records[1].kind, 'punctuation'); assert.equal(records[1].startSample, records[1].endSample);
  assert.equal(records[2].kind, 'disfmarker');
});

test('NXT never resolves external entities and rejects malformed, foreign or incomplete records', () => {
  const valid = '<w nite:id="ES2002a.A.words0" starttime="1" endtime="2">hello</w>';
  for (const children of [valid + valid,
    valid.replace('starttime="1"', 'starttime="1" starttime="2"'), valid.replace('hello', '&external;'),
    valid.replace('hello', '<inner>hello</inner>'), valid.replace('endtime="2"', ''), valid.replace('ES2002a.A.words0', 'ES2004a.A.words0')]) {
    assert.throws(() => parseAmiNxt(nxt('A', children), 'AMI/ES2002a', 'A'));
  }
  const dtd = nxt('A', valid).toString('latin1').replace('<nite:root', '<!DOCTYPE x SYSTEM "file:///private">\n<nite:root');
  assert.throws(() => parseAmiNxt(Buffer.from(dtd, 'latin1'), 'AMI/ES2002a', 'A'), /DTD/);
  assert.throws(() => parseAmiNxt(nxt('B', valid), 'AMI/ES2002a', 'A'), /another recording/);
  const reversed = parseAmiNxt(nxt('A', valid.replace('endtime="2"', 'endtime="0"')), 'AMI/ES2002a', 'A');
  assert.equal(reversed[0].rangeIssue, 'reversed_upstream_annotation');
  assert.equal(reversed[0].startSample, 16000); assert.equal(reversed[0].endSample, 0);
});

test('AMI conversion audit checks original hashes, every word, speaker and attribute', () => {
  const { upstream, files } = fixture();
  const audit = verifyAmiExtraction(upstream, files);
  assert.equal(audit.records.length, 12); assert.equal(audit.records.filter(record => record.kind === 'word').length, 4);
  assert.equal(audit.records.filter(record => record.kind === 'vocalsound').length, 4);
  for (const mutate of [value => value.words.pop(), value => value.words[0].text = 'changed',
    value => value.words[0].attributes.starttime = '10.02', value => value.words[0].startMs = 10011,
    value => value.originalFiles[0].sha256 = hash, value => value.generatedByAsr = true]) {
    const altered = structuredClone(upstream); mutate(altered); assert.throws(() => verifyAmiExtraction(altered, files));
  }
});

test('full word references keep speaker overlap and repeated text; punctuation is not a word-time anchor', () => {
  const { upstream, files } = fixture(), annotation = verifyAmiExtraction(upstream, files);
  const draft = prepareChunkReference(annotation, source, selection, chunk);
  assert.equal(draft.candidateText, "I'm I'm I'm I'm"); assert.equal(draft.overlaps.length, 6);
  assert.ok(draft.overlaps.every(overlap => overlap.speakersKnownDifferent));
  assert.equal(draft.records.filter(record => record.kind === 'punctuation').length, 4);
  assert.equal(draft.wordTimestampReference.length, 4); assert.equal(draft.wordTimestampReference[0].startMs, 1010);
  assert.equal(draft.utteranceTimestampReference.length, 0);
  assert.equal(draft.recognitionReferenceComplete, true); assert.equal(draft.acousticQualificationReady, false);
  assert.equal(draft.additionalListening.performed, false);
});

test('partial words retain source bounds and full text without becoming a complete scored reference', () => {
  const { upstream, files } = fixture(), annotation = verifyAmiExtraction(upstream, files);
  const draft = prepareChunkReference(annotation, source, selection, { ...chunk, requestStartSample: 160500, coreStartSample: 160500 });
  assert.equal(draft.partialRecordIds.length, 4); assert.equal(draft.records[0].relativeStartSample, -340);
  assert.equal(draft.records[0].text, "I'm"); assert.equal(draft.records[0].startSample, 160160);
  assert.equal(draft.recognitionReferenceComplete, false);
  assert.ok(draft.blockers.includes('partial_annotation_at_request_boundary'));
  assert.equal(draft.wordTimestampReference.length, 0);
});

test('point lexical words and missing annotation cannot silently count as silence', () => {
  const { upstream, files } = fixture(), annotation = verifyAmiExtraction(upstream, files);
  annotation.records[0].endSample = annotation.records[0].startSample;
  const draft = prepareChunkReference(annotation, source, selection, chunk);
  assert.ok(draft.blockers.includes('point_lexical_annotation'));
  const empty = prepareChunkReference({ ...annotation, records: [] }, source, selection, chunk);
  assert.ok(empty.blockers.includes('no_lexical_reference_not_verified_silence'));
  const outOfRange = structuredClone(annotation); outOfRange.records[0].endSample = source.samples + 1;
  assert.throws(() => prepareChunkReference(outOfRange, source, selection, chunk), /escapes/);
});

test('Koniwa retains competing levels, memo and overlapping utterances without inventing words', () => {
  const raw = { meta: { status_annotation: 'done' }, annotation: [
    { start: 9, end: 10.5, data: { text_level0: '市民の皆様', text_level2: 'あの、市民の皆様', memo: 'Original note' } },
    { start: 10, end: 10.8, data: { text_level0: 'はい', text_level2: '', memo: '' } }] };
  const before = JSON.stringify(raw), annotation = inspectKoniwa(raw);
  const draft = prepareChunkReference(annotation, { ...source, language: 'ja' }, selection, chunk);
  assert.equal(JSON.stringify(raw), before); assert.equal(draft.timingLevel, 'utterance');
  assert.equal(draft.records[0].alternativeText, 'あの、市民の皆様'); assert.equal(draft.records[0].attributes.memo, 'Original note');
  assert.equal(draft.overlaps.length, 1); assert.ok(draft.records.every(record => record.kind === 'utterance'));
  assert.ok(draft.blockers.includes('upstream_verbatim_text_policy_unresolved'));
});

test('mechanically verified human references do not claim new listening or pass acoustic qualification', () => {
  const reference = { path: 'new-reference.json', sha256: hash, method: 'upstream-transcript', independentOfProviderOutput: true,
    verifiedAgainstAudio: false, recognitionReferenceComplete: true, provenance: { upstreamAnnotationKind: 'human-corpus-annotation',
      independentOfProviderOutput: true, annotationConversionVerified: true, sourceSamplesVerified: true,
      sourceVerificationSha256: hash, sourceSha256: hash, originalAnnotations: [{ path: 'original.xml', sha256: hash }],
      preparationTool: 'authored-fixture', preparationToolSha256: hash, preparedAt: '2026-09-12T00:00:00Z' } };
  assert.deepEqual(referenceReadiness({ sha256: hash, reference }), {
    upstreamMechanicalVerificationReady: true, recognitionReferenceReady: true, upstreamTimingReferenceReady: false, additionalAcousticReviewVerified: false,
    additionalListeningPerformed: false,
    note: 'Verified upstream human text can be prepared without new listening. Timestamp calibration and real-player observations still need their own evidence.' });
  for (const mutate of [value => value.provenance.sourceSha256 = 'b'.repeat(64), value => value.provenance.originalAnnotations = [],
    value => value.provenance.preparationToolSha256 = '', value => value.independentOfProviderOutput = false,
    value => value.recognitionReferenceComplete = false]) {
    const altered = structuredClone(reference); mutate(altered);
    assert.equal(referenceReadiness({ sha256: hash, reference: altered }).recognitionReferenceReady, false);
  }
  const reviewed = { ...reference, verifiedAgainstAudio: true, reviewer: 'Separate actual review record', reviewedAt: '2026-09-12T00:00:00Z' };
  assert.equal(referenceReadiness({ sha256: hash, reference: reviewed }).additionalAcousticReviewVerified, true);
  const timed = { ...reference, timingLevel: 'word', hasCompleteTimingAnchors: true };
  assert.equal(referenceReadiness({ sha256: hash, reference: timed }).upstreamTimingReferenceReady, true);
});

test('outer-edge suggestion is unapplied, keeps duration and checks all overlapping speakers', () => {
  const { upstream, files } = fixture(), annotation = verifyAmiExtraction(upstream, files);
  const selected = { ...selection, startSample: 10.1 * 16_000, endSample: 15.1 * 16_000 };
  const proposal = suggestSelectionEdges(annotation, source, selected);
  assert.equal(proposal.proposedStartSample, 10.01 * 16_000);
  assert.equal(proposal.proposedEndSample - proposal.proposedStartSample, 5 * 16_000);
  assert.equal(selected.startSample, 10.1 * 16_000); assert.equal(proposal.applied, false);
  assert.equal(suggestSelectionEdges({ ...annotation, timingLevel: 'utterance' }, source, selected), null);
});
