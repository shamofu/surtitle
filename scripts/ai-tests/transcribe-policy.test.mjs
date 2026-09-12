// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSCRIBE_POLICY, CHUNK_PROFILES, validatePreparation, evaluateTranscribeProduction, objectHash } from './transcribe-policy.mjs';
import { measurePcmWav, verifySourceSlices, run } from './transcribe-production.mjs';
import { timestampErrors, boundaryReport, sha256 } from './evaluation.mjs';

const hash = 'a'.repeat(64), refHash = 'b'.repeat(64), resultHash = 'c'.repeat(64), rubricHash = 'd'.repeat(64);
const cellNames = ['en:lecture', 'en:dialogue', 'ja:lecture', 'ja:dialogue'];
const execution = { model_id: 'explicit-transcribe-fixture', location: 'global', max_output_tokens: 8192,
  thinking: { kind: 'omit' }, price: { id: 'authored-price', source: 'Authored zero-price regression; never used for a live quote', observed_at_ms: 1,
    input_microusd_per_million: 0, output_microusd_per_million: 0 } };

function preparation(stage = 'pilot') {
  const sources = cellNames.map((cell, i) => ({ id: `source-${i}`, language: cell.split(':')[0], genre: cell.split(':')[1],
    sha256: String(i + 1).repeat(64), sampleRate: 16_000, samples: 960 * 16_000, naturalSpeech: true,
    sourceUrl: 'https://example.invalid/authored-regression', license: 'GPL-3.0-or-later', provenance: 'Authored metadata, no real speech or quality claim',
    recordingId: `recording-${i}`, reference: { path: 'reference.json', sha256: refHash, method: 'independent-audio-review',
      independentOfProviderOutput: true, verifiedAgainstAudio: false, reviewer: null, reviewedAt: null } }));
  const selections = sources.flatMap(source => (stage === 'pilot' ? ['current120', 'short60'] : ['current120']).map(profileId => {
    const startSample = stage === 'pilot' ? 0 : 240 * 16_000, duration = stage === 'pilot' ? 240 : 480;
    const core = CHUNK_PROFILES[profileId].targetMs * 16;
    const count = duration * 16_000 / core;
    const id = `${source.id}-${profileId}`, endSample = startSample + duration * 16_000;
    const chunks = Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, index,
      coreStartSample: startSample + index * core, coreEndSample: startSample + (index + 1) * core,
      requestStartSample: Math.max(startSample, startSample + index * core - 48_000),
      requestEndSample: Math.min(endSample, startSample + (index + 1) * core + 48_000),
      boundary: index === count - 1 ? 'end_of_selection' : 'strong_pause', audioPath: `${id}-${index}.wav`, audioSha256: hash }));
    const p = CHUNK_PROFILES[profileId];
    return { id, sourceId: source.id, profileId, purpose: 'primary', startSample, endSample, chunks,
      options: { sample_rate: 16_000, minimum_ms: p.minimumMs, target_ms: p.targetMs, search_end_ms: p.searchEndMs,
        hard_maximum_ms: p.hardMaximumMs, strong_pause_ms: 500, weak_pause_ms: 200, context_ms: 3000 } };
  }));
  return { schemaVersion: 1, policyId: TRANSCRIBE_POLICY.id, plannerCodeSha256: hash, stage,
    adapter: 'transcribe', wordTimestamp: true, mode: 'VERBATIM', candidateCount: 1, diarization: false, execution,
    sources, selections, repeatRequestIds: stage === 'pilot' ? [] : [selections[0].chunks[0].id, selections[2].chunks[0].id],
    ...(stage === 'confirmation' ? { selectedProfileId: 'current120', pilotManifestSha256: refHash,
      pilotRanges: sources.map(s => ({ recordingId: `pilot-${s.recordingId}`, sourceSha256: '9'.repeat(64), startSample: 0, endSample: 240 * 16_000 })) } : {}) };
}
function measured(plan) {
  return Object.fromEntries(plan.selections.flatMap(s => s.chunks).map(c => [c.id, { sha256: c.audioSha256, samples: c.requestEndSample - c.requestStartSample,
    channels: 1, sampleRate: 16_000, bitsPerSample: 16 }]));
}

test('preparation counts actual sample plans and overlap, not target-duration division', () => {
  const p = preparation(), result = validatePreparation(p, measured(p));
  assert.equal(result.requestCount, 24);
  assert.equal(result.totalSubmittedSamples, (240 * 8 + 6 * 16) * 16_000);
  assert.equal(result.totalSubmittedDurationMs, 2_016_000);
  assert.equal(result.distinctSourceBoundaries, 12);
  assert.equal(result.readyForQuotePreparation, false);
  assert.equal(result.missingReferences.length, 4);
  assert.equal(result.approvalGranted, false); assert.equal(result.priceEstimateUsd, null);
});
test('unmeasured audio and upstream-only references cannot produce a ready preparation', () => {
  const p = preparation();
  for (const s of p.sources) Object.assign(s.reference, { verifiedAgainstAudio: true, reviewer: 'Authored fixture reviewer', reviewedAt: '2026-09-12T00:00:00Z' });
  assert.equal(validatePreparation(p).readyForQuotePreparation, false);
  const ready = validatePreparation(p, measured(p));
  assert.equal(ready.readyForQuotePreparation, true); assert.equal(ready.modelQualified, false);
  p.sources[0].reference.independentOfProviderOutput = false;
  assert.equal(validatePreparation(p, measured(p)).readyForQuotePreparation, false);
});

test('verified upstream human references can be prepared without new listening; partial coverage cannot', () => {
  const p = preparation();
  for (const source of p.sources) source.reference = { ...source.reference, method: 'upstream-transcript',
    recognitionReferenceComplete: true, timingLevel: 'word', hasCompleteTimingAnchors: true,
    provenance: { upstreamAnnotationKind: 'human-corpus-annotation', independentOfProviderOutput: true,
      annotationConversionVerified: true, sourceSamplesVerified: true, sourceVerificationSha256: refHash,
      sourceSha256: source.sha256, originalAnnotations: [{ path: 'authored-original.xml', sha256: refHash }],
      preparationTool: 'authored-fixture-verifier', preparationToolSha256: hash, preparedAt: '2026-09-12T00:00:00Z' } };
  const complete = validatePreparation(p, measured(p));
  assert.equal(complete.readyForQuotePreparation, true);
  assert.ok(Object.values(complete.referenceReadinessBySource).every(value => value.upstreamTimingReferenceReady
    && !value.additionalAcousticReviewVerified && !value.additionalListeningPerformed));
  p.sources[0].reference.recognitionReferenceComplete = false;
  assert.equal(validatePreparation(p, measured(p)).readyForQuotePreparation, false);
});
test('gaps, hidden context, changed hashes and mismatched paired pilot sources fail', () => {
  for (const change of [
    p => p.selections[0].chunks[1].coreStartSample++,
    p => p.selections[0].chunks[0].requestEndSample--,
    p => p.selections[0].chunks[0].audioSha256 = refHash,
    p => p.selections[0].chunks[0].coreEndSample = 181 * 16_000,
    p => p.selections[1].sourceId = p.sources[1].id,
  ]) {
    const p = preparation(), measurements = measured(p); change(p);
    assert.throws(() => validatePreparation(p, measurements));
  }
});
test('confirmation keeps fixed repeats separate and rejects same-recording temporal holdout', () => {
  const p = preparation('confirmation'), result = validatePreparation(p, measured(p));
  assert.equal(result.originalRequestCount, 16); assert.equal(result.repeatCount, 2);
  assert.equal(result.requestCount, 18); assert.equal(result.distinctSourceBoundaries, 12);
  assert.ok(result.holdoutKinds.every(r => r.kind === 'recording-holdout'));
  assert.equal(result.repeatRequests[0].repeatOf, p.repeatRequestIds[0]);
  const repeat = structuredClone(p); repeat.repeatRequestIds[1] = repeat.selections[1].chunks[0].id;
  assert.throws(() => validatePreparation(repeat), /one chunk per language/);
  p.pilotRanges[0].recordingId = p.sources[0].recordingId;
  assert.throws(() => validatePreparation(p), /independent of the pilot/);
});
test('same-profile corpus deficits and changed Transcribe settings are rejected', () => {
  const p = preparation(); p.selections.pop(); assert.throws(() => validatePreparation(p), /matrix/);
  const changed = preparation(); changed.wordTimestamp = false; assert.throws(() => validatePreparation(changed), /contract/);
  const modelSwitch = preparation(); modelSwitch.adapter = 'audio'; assert.throws(() => validatePreparation(modelSwitch), /contract/);
  const thought = preparation(); thought.execution = { ...execution, thinking: { kind: 'level', level: 'LOW' } };
  assert.throws(() => validatePreparation(thought), /omitted thinking/);
});
test('predeclared short supplemental pairs fill only real confirmation locations', () => {
  const p = preparation('confirmation');
  const source = p.sources[0];
  for (let i = 0; i < 8; i++) {
    const startSample = (730 + i * 20) * 16_000, cut = startSample + 5 * 16_000, endSample = startSample + 10 * 16_000;
    const id = `stress-${i}`;
    p.selections.push({ id, sourceId: source.id, profileId: 'current120', purpose: 'supplemental-boundary',
      stressReason: 'Authored fixed regression: split a bounded ongoing-speech interval.',
      options: p.selections[0].options, startSample, endSample, chunks: [
        { id: `${id}-0`, index: 0, coreStartSample: startSample, coreEndSample: cut, requestStartSample: startSample,
          requestEndSample: cut + 48_000, boundary: 'forced', audioPath: `${id}-0.wav`, audioSha256: hash },
        { id: `${id}-1`, index: 1, coreStartSample: cut, coreEndSample: endSample, requestStartSample: cut - 48_000,
          requestEndSample: endSample, boundary: 'end_of_selection', audioPath: `${id}-1.wav`, audioSha256: hash },
      ] });
  }
  const result = validatePreparation(p, measured(p));
  assert.equal(result.supplementalBoundaries, 8); assert.equal(result.distinctSourceBoundaries, 20);
  assert.equal(result.confirmationBoundaryDeficit, 0); assert.equal(result.requestCount, 34);
  delete p.selections.at(-1).stressReason;
  assert.throws(() => validatePreparation(p), /predeclared/);
});

function evaluationFixture() {
  const cases = cellNames.flatMap((cell, i) => [0, 1].map(part => {
    const language = cell.split(':')[0], text = language === 'ja' ? 'はい' : 'yes';
    return { id: `case-${i}-${part}`, language, evidenceKind: 'authored-oracle',
      audio: { sha256: hash, durationMs: 2000, classification: 'speech', evaluationUsePermitted: true,
        source: 'Authored fixture; no recorded speech', license: 'GPL-3.0-or-later' },
      cues: [{ id: 'cue', text, startMs: 0, endMs: 1000 }], words: [{ id: 'word', text, startMs: 0, endMs: 1000 }] };
  }));
  const results = { schemaVersion: 1, evidenceKind: 'authored-oracle', requests: cases.map(c => ({ id: `request-${c.id}`, caseId: c.id,
    state: 'completed', taskKind: 'transcribe_preview', sourceAudioSha256: hash, execution, requestBodySha256: hash, digest: hash,
    output: { kind: 'transcript', cues: c.cues.map(({ id, ...cue }) => cue) },
    attempts: [{ id: `attempt-${c.id}`, state: 'settled', evidence: { evidenceTruncated: false, audioTranscriptions: [{ finished: true,
      words: [{ word: c.words[0].text, startOffset: '0s', endOffset: '1s' }] }] } }] })) };
  const boundaries = Array.from({ length: 20 }, (_, i) => ({ id: `boundary-${i}`, sourceSha256: String(i % 4 + 1).repeat(64),
    profileId: 'current120', cutSample: 1000 + i * 1000, leftCaseId: `case-${i % 4}-0`, rightCaseId: `case-${i % 4}-1` }));
  const playbackRanges = Array.from({ length: 100 }, (_, i) => ({ id: `playback-${i}`, sourceSha256: String(i % 4 + 1).repeat(64),
    startSample: i * 1000, endSample: i * 1000 + 500, language: cellNames[i % 4].split(':')[0], genre: cellNames[i % 4].split(':')[1],
    intendedText: cellNames[i % 4].startsWith('ja') ? 'はい' : 'yes', stratum: i < 50 ? 'boundary' : 'interior' }));
  const boundaryComparisons = cellNames.map((cell, i) => ({ id: cell, language: cell.split(':')[0], genre: cell.split(':')[1], profileId: 'current120',
    boundaryCaseIds: [`case-${i}-0`], interiorCaseIds: [`case-${i}-1`],
    boundaryReference: cell.startsWith('ja') ? 'はい' : 'yes', interiorReference: cell.startsWith('ja') ? 'はい' : 'yes' }));
  const manifest = { schemaVersion: 2, cases, evaluationPlan: { candidates: [{ id: 'transcribe', execution }],
    cases: cases.map(c => ({ caseId: c.id, taskKind: 'transcribe_preview', candidateIds: ['transcribe'] })) },
    transcribeProduction: { policyId: TRANSCRIBE_POLICY.id, stage: 'confirmation', boundaries, playbackRanges, boundaryComparisons,
      caseBindings: cases.map((c, i) => ({ caseId: c.id, sourceId: `source-${Math.floor(i / 2)}`, sourceSha256: String(Math.floor(i / 2) + 1).repeat(64),
        language: c.language, genre: cellNames[Math.floor(i / 2)].split(':')[1], condition: 'clear', profileId: 'current120',
        reference: { path: 'authored-reference.json', sha256: refHash, method: 'independent-audio-review', independentOfProviderOutput: true,
          verifiedAgainstAudio: true, reviewer: 'Authored fixture reviewer', reviewedAt: '2026-09-12T00:00:00Z' },
        sourceRange: { sampleRate: 16_000, coreStartSample: i % 2 * 16_000, coreEndSample: (i % 2 + 1) * 16_000,
          requestStartSample: 0, requestEndSample: 32_000, verifiedAgainstSource: true, verificationSha256: refHash } })) } };
  const rubric = { schemaVersion: 1, reviewMethod: 'ai-review', reviewer: 'Authored fixture reviewer', reviewerModel: 'fixture-only',
    reviewedAt: '2026-09-12T00:00:00Z', resultsSha256: resultHash,
    referenceReview: { method: 'ai-review', reviewer: 'Authored reference fixture', model: 'fixture-only', reviewedAt: '2026-09-12T00:00:00Z',
      referencesSha256: refHash, independentOfModelOutput: true }, items: [], boundaries: [],
    timestampMatches: results.requests.flatMap(r => [{ requestId: r.id, referenceId: 'cue', outputIndex: 0, level: 'cue' },
      { requestId: r.id, referenceId: 'word', outputIndex: 0, level: 'word', attemptId: r.attempts[0].id }]) };
  const review = { policyId: TRANSCRIBE_POLICY.id, reviewMethod: 'ai-review', reviewer: 'Authored workflow fixture', reviewerModel: 'fixture-only',
    reviewedAt: '2026-09-12T00:00:00Z', referencesSha256: refHash, resultsSha256: resultHash, rubricSha256: rubricHash,
    requestHandling: results.requests.map(r => ({ id: r.id, disposition: 'available', evidence: 'Authored fixture preserves its supplied output.', originalEvidenceRetained: true, automaticRetry: false })),
    rangeCorrections: manifest.transcribeProduction.caseBindings.map(b => ({ id: b.caseId, requestId: `request-${b.caseId}`, sourceSha256: b.sourceSha256,
      requestStartSample: 0, requestEndSample: 32_000, assessedEntireRequest: true, reviewedLocally: true, requiredRanges: [],
      evidence: 'Authored complete local-review observation; no real audio quality assertion.' })),
    boundaries: boundaries.map((b, i) => ({ id: b.id, originalLeft: results.requests.find(r => r.caseId === b.leftCaseId).output,
      originalRight: results.requests.find(r => r.caseId === b.rightCaseId).output, originalsRetained: true,
      disposition: i < 10 ? 'automatic' : 'review-required', stitchingIntroducedLexicalChange: false,
      evidence: 'Authored fixture checks review-required output without claiming a real join or quality result.' })),
    boundaryComparisons: boundaryComparisons.map(c => ({ id: c.id,
      boundaryParts: [{ requestId: `request-${c.boundaryCaseIds[0]}`, startCue: 0, endCue: 1 }],
      interiorParts: [{ requestId: `request-${c.interiorCaseIds[0]}`, startCue: 0, endCue: 1 }],
      evidence: 'Authored fixture has identical bounded reference units.' })),
    playback: playbackRanges.map(r => ({ ...r, playedInRealPlayer: true, player: 'fixture-only', assessmentMethod: 'ai-review',
      containsIntendedSpeech: true, clippedStart: false, clippedEnd: false, evidence: 'Authored flags test the schema; no real player or human listening occurred.' })) };
  const fixture = { manifest, results, rubric, review, hashes: { referencesSha256: refHash, resultsSha256: resultHash, rubricSha256: rubricHash } };
  addControl(fixture);
  return fixture;
}
const score = f => evaluateTranscribeProduction(f.manifest, f.results, f.rubric, f.review, f.hashes);

function addControl(f, condition = 'silence') {
  const id = `control-${condition}`, audioSha = 'e'.repeat(64);
  const reference = { id, language: 'en', evidenceKind: 'authored-oracle', cues: [], words: [],
    audio: { sha256: audioSha, durationMs: 2000, classification: condition, evaluationUsePermitted: true,
      source: 'Authored regression control', license: 'GPL-3.0-or-later' } };
  f.manifest.cases.push(reference);
  f.manifest.evaluationPlan.cases.push({ caseId: id, taskKind: 'transcribe_preview', candidateIds: ['transcribe'] });
  f.manifest.transcribeProduction.caseBindings.push({ caseId: id, sourceId: id, sourceSha256: audioSha,
    language: 'en', genre: 'control', condition, profileId: 'current120' });
  const request = { id: `request-${id}`, caseId: id, state: 'completed', taskKind: 'transcribe_preview', sourceAudioSha256: audioSha,
    execution, requestBodySha256: hash, digest: hash, output: { kind: 'transcript', cues: [] },
    attempts: [{ id: `attempt-${id}`, state: 'settled', evidence: { evidenceTruncated: false,
      audioTranscriptions: [{ text: '', words: [], finished: true }], candidateDiagnostics: [{ finishReason: 'STOP', textParts: [], textTruncated: false }] } }] };
  f.results.requests.push(request);
  f.review.requestHandling.push({ id: request.id, disposition: 'available', evidence: 'Authored empty control output retained.', originalEvidenceRetained: true, automaticRetry: false });
  if (condition === 'silence') f.manifest.transcribeProduction.digitalSilenceControls = [{ caseId: id, audioSha256: audioSha, sampleRate: 16_000, samples: 32_000,
    verification: { method: 'all-pcm-samples-zero', verifiedBeforeOutputs: true, sha256: refHash } }];
  return request;
}

function pilotFixture() {
  const f = evaluationFixture(), plan = f.manifest.transcribeProduction;
  plan.stage = 'pilot';
  for (const b of [...plan.caseBindings].filter(b => b.condition === 'clear')) {
    const copy = structuredClone(f.manifest.cases.find(c => c.id === b.caseId)); copy.id += '-short'; f.manifest.cases.push(copy);
    f.manifest.evaluationPlan.cases.push({ caseId: copy.id, taskKind: 'transcribe_preview', candidateIds: ['transcribe'] });
    plan.caseBindings.push({ ...structuredClone(b), caseId: copy.id, profileId: 'short60' });
    const request = structuredClone(f.results.requests.find(r => r.caseId === b.caseId)), oldRequestId = request.id;
    request.caseId = copy.id; request.id += '-short'; request.attempts.forEach(a => a.id += '-short'); f.results.requests.push(request);
    f.rubric.timestampMatches.push(...f.rubric.timestampMatches.filter(m => m.requestId === oldRequestId).map(m => ({ ...m, requestId: request.id, ...(m.attemptId ? { attemptId: `${m.attemptId}-short` } : {}) })));
    f.review.requestHandling.push({ ...f.review.requestHandling.find(r => r.id === oldRequestId), id: request.id });
    f.review.rangeCorrections.push({ ...structuredClone(f.review.rangeCorrections.find(r => r.id === b.caseId)), id: copy.id, requestId: request.id });
  }
  plan.boundaries = plan.boundaries.slice(0, 2);
  f.review.boundaries = f.review.boundaries.slice(0, 2);
  plan.playbackRanges = []; f.review.playback = [];
  return f;
}

test('new policy retains a 50% automatic-join metric without relaxing the legacy boundary rule', () => {
  const f = evaluationFixture(), before = objectHash(f), r = score(f);
  assert.equal(r.boundaries.automaticRate, .5); assert.equal(r.boundaries.passed, true);
  assert.equal(r.boundaries.automaticTargetIsGate, false);
  assert.equal(r.playback.expected, 100); assert.equal(r.playback.passed, true);
  assert.equal(r.timing.passed, true); assert.equal(r.modelQualified, false);
  assert.equal(r.gatesPassed, false); assert.equal(r.status, 'incomplete_reference_or_review_evidence');
  assert.equal(objectHash(f), before);
  const old = Array.from({ length: 20 }, (_, i) => ({ id: String(i), language: 'en', text: 'yes' }));
  const observations = old.map((r, i) => ({ id: r.id, joinedText: 'yes', originalLeft: 'yes', originalRight: 'yes',
    needsReview: i >= 10, reviewAccepted: true }));
  assert.equal(boundaryReport(old, observations, 'ai-review').passed, false);
});
test('95/100 real-player observations pass; missing, duplicate, clipped or 94/100 fail', () => {
  const f = evaluationFixture();
  for (const row of f.review.playback.slice(0, 5)) row.clippedEnd = true;
  assert.equal(score(f).playback.passed, true);
  f.review.playback[5].clippedStart = true;
  assert.equal(score(f).playback.passed, false);
  f.review.playback.pop(); assert.equal(score(f).playback.observed, 99);
  const duplicate = evaluationFixture(); duplicate.manifest.transcribeProduction.playbackRanges[1] = { ...duplicate.manifest.transcribeProduction.playbackRanges[0], id: 'playback-1' };
  assert.equal(score(duplicate).playback.passed, false);
  const fake = evaluationFixture(); fake.review.playback[0].playedInRealPlayer = false;
  assert.equal(score(fake).playback.passed, false);
});
test('reused boundaries, changed originals and unreviewed lexical damage cannot pass', () => {
  const f = evaluationFixture();
  f.manifest.transcribeProduction.boundaries.forEach(b => { b.sourceSha256 = '1'.repeat(64); b.cutSample = 1000; b.leftCaseId = 'case-0-0'; b.rightCaseId = 'case-0-1'; });
  assert.equal(score(f).boundaries.distinctLocations, 1); assert.equal(score(f).boundaries.passed, false);
  const damage = evaluationFixture(); damage.review.boundaries[0].stitchingIntroducedLexicalChange = true;
  assert.equal(score(damage).boundaries.passed, false);
  const altered = evaluationFixture(); altered.review.boundaries[0].originalLeft = { kind: 'transcript', cues: [] };
  assert.equal(score(altered).boundaries.rows[0].originalsBound, false);
});
test('missing Japanese word references remain incomplete despite exact cue timing', () => {
  const f = evaluationFixture(); delete f.manifest.cases[4].words;
  const r = score(f);
  assert.equal(r.timing.rows[4].cue.passed, true);
  assert.equal(r.timing.rows[4].word.status, 'not_assessed_no_word_reference');
  assert.equal(r.timing.passed, false);
});
test('unreceived output is blocked and retained, never marked available or inferred silence', () => {
  const f = evaluationFixture(); f.results.requests[0].state = 'needs_review'; f.results.requests[0].output = null;
  assert.equal(score(f).requestSafety[0].passed, false);
  f.review.requestHandling[0].disposition = 'blocked-preserved';
  const r = score(f); assert.equal(r.requestSafety[0].passed, true); assert.equal(r.recognition[0].passed, false);
  f.review.requestHandling[0].automaticRetry = true; assert.equal(score(f).requestSafety[0].passed, false);
});
test('review bindings and boundary/interior degradation fail closed', () => {
  const f = evaluationFixture(); f.review.resultsSha256 = hash;
  assert.throws(() => score(f), /bind the exact/);
  const wrong = evaluationFixture(); wrong.results.requests[0].output.cues[0].text = 'no';
  assert.equal(score(wrong).boundaryErrorDiagnostic.passed, false);
  assert.equal(Object.hasOwn(score(wrong).gates, 'boundaryErrorComparison'), false);
  const missing = evaluationFixture(); missing.review.boundaryComparisons.pop();
  assert.equal(score(missing).boundaryErrorDiagnostic.complete, false);
});
test('correction duration unions overlapping source intervals and counts resolved work', () => {
  const f = pilotFixture();
  for (const [id, startSample, endSample] of [
    ['case-0-0', 0, 16_000], ['case-0-1', 8_000, 24_000],
    ['case-0-0-short', 0, 4_000], ['case-0-1-short', 2_000, 6_000],
  ]) f.review.rangeCorrections.find(r => r.id === id).requiredRanges = [{ startSample, endSample, evidence: 'Authored correction interval measured on the source clock.' }];
  f.review.boundaries.forEach(b => b.disposition = 'locally-resolved');
  const before = objectHash(f), r = score(f);
  assert.equal(r.boundaries.correctionRequiredBoundaryCount, 0);
  const current = r.correctionRequiredAudio.byCell.find(c => c.profileId === 'current120' && c.cell === 'en:lecture');
  assert.equal(current.correctionRequiredSamples, 24_000); assert.equal(current.correctionRequiredDurationMs, 1500);
  assert.deepEqual(current.correctionRanges, [{ sourceSha256: '1'.repeat(64), startSample: 0, endSample: 24_000 }]);
  assert.equal(r.correctionRequiredAudio.byProfile.find(c => c.profileId === 'short60').correctionRequiredSamples, 6000);
  assert.equal(r.pilotComparison.comparisonComplete, true);
  assert.equal(r.pilotComparison.recommendation, 'recommend_short60');
  assert.equal(r.pilotComparison.automaticProductChange, false); assert.equal(objectHash(f), before);
});
test('pilot comparison keeps current for equal correction audio or worse recognition in either language', () => {
  const equal = score(pilotFixture());
  assert.equal(equal.pilotComparison.comparisonComplete, true);
  assert.equal(equal.pilotComparison.recommendation, 'keep_current120');
  assert.equal(equal.confirmationCoverage.applicable, false);
  assert.equal(equal.confirmationCoverage.boundariesPassed, null);
  assert.equal(equal.boundaries.distinctLocations, 2); assert.equal(equal.boundaries.passed, true);
  assert.equal(Object.hasOwn(equal.gates, 'playback'), false);
  assert.equal(equal.boundaryErrorDiagnostic.isGate, false);
  for (const language of ['en', 'ja']) {
    const f = pilotFixture(), index = language === 'en' ? 0 : 2;
    f.review.rangeCorrections.find(r => r.id === `case-${index}-0`).requiredRanges = [{ startSample: 0, endSample: 1000, evidence: 'Correction needed before local resolution.' }];
    f.results.requests.find(r => r.caseId === `case-${index}-0-short`).output.cues[0].text = language === 'en' ? 'no' : '違う';
    const r = score(f);
    assert.equal(r.pilotComparison.comparisonComplete, true);
    assert.equal(r.pilotComparison.recognitionNoWorseInBothLanguages, false);
    assert.equal(r.pilotComparison.lessCorrectionRequiredAudio, true);
    assert.equal(r.pilotComparison.recommendation, 'keep_current120');
  }
});
test('missing correction observations, unverified clocks and incomplete recognition stay undecided', () => {
  for (const mutate of [
    f => f.review.rangeCorrections.pop(),
    f => f.review.rangeCorrections.at(-1).assessedEntireRequest = false,
    f => delete f.manifest.transcribeProduction.caseBindings.find(b => b.caseId === 'case-0-0').sourceRange,
    f => f.manifest.transcribeProduction.caseBindings.find(b => b.caseId === 'case-0-0').sourceRange.verifiedAgainstSource = false,
    f => f.manifest.transcribeProduction.caseBindings.find(b => b.caseId === 'case-0-0').reference.verifiedAgainstAudio = false,
    f => { f.results.requests[0].state = 'needs_review'; f.results.requests[0].output = null; },
  ]) {
    const f = pilotFixture(); mutate(f); const r = score(f);
    assert.equal(r.pilotComparison.comparisonComplete, false);
    assert.equal(r.gates.pilotComparisonComplete, false); assert.equal(r.gatesPassed, false);
    assert.equal(r.pilotComparison.recommendation, 'undecided'); assert.equal(r.pilotComparison.selectedProfileId, null);
  }
  const missing = pilotFixture(); missing.review.rangeCorrections.pop();
  assert.equal(score(missing).correctionRequiredAudio.byProfile.find(r => r.profileId === 'short60').correctionRequiredSamples, null);
  assert.equal(score(missing).gates.correctionMeasurementComplete, false);
  const confirmation = evaluationFixture(); confirmation.review.rangeCorrections.pop();
  assert.equal(score(confirmation).gates.correctionMeasurementComplete, false); assert.equal(score(confirmation).gatesPassed, false);
});
test('correction samples must remain in the frozen source coverage and profile pairs must match', () => {
  const escaped = pilotFixture();
  escaped.review.rangeCorrections[0].requiredRanges = [{ startSample: 0, endSample: 32_001, evidence: 'Out-of-range authored regression.' }];
  assert.throws(() => score(escaped), /escapes.*source request/);
  const mismatched = pilotFixture();
  for (const b of mismatched.manifest.transcribeProduction.caseBindings.filter(b => b.profileId === 'short60')) {
    for (const key of ['coreStartSample', 'coreEndSample', 'requestStartSample', 'requestEndSample']) b.sourceRange[key] += 32_000;
    const o = mismatched.review.rangeCorrections.find(r => r.id === b.caseId); o.requestStartSample += 32_000; o.requestEndSample += 32_000;
  }
  const r = score(mismatched);
  assert.ok(r.correctionRequiredAudio.byProfile.every(p => p.complete));
  assert.equal(r.pilotComparison.identicalSources, false); assert.equal(r.pilotComparison.recommendation, 'undecided');
});
test('digital silence is required and optional condition absence is never reported as tested', () => {
  const f = evaluationFixture(), valid = score(f);
  assert.equal(valid.controls.digitalSilence.passed, true);
  assert.equal(valid.gates.digitalSilence, true);
  for (const condition of ['non-speech', 'bgm', 'overlapping-speech']) {
    const row = valid.controls.conditions.find(r => r.condition === condition);
    assert.equal(row.tested, false); assert.equal(row.complete, false); assert.equal(row.status, 'not_planned_not_tested');
  }
  const id = 'control-silence';
  f.manifest.cases = f.manifest.cases.filter(c => c.id !== id);
  f.manifest.evaluationPlan.cases = f.manifest.evaluationPlan.cases.filter(c => c.caseId !== id);
  f.manifest.transcribeProduction.caseBindings = f.manifest.transcribeProduction.caseBindings.filter(c => c.caseId !== id);
  f.manifest.transcribeProduction.digitalSilenceControls = [];
  f.results.requests = f.results.requests.filter(r => r.caseId !== id);
  f.review.requestHandling = f.review.requestHandling.filter(r => r.id !== `request-${id}`);
  assert.equal(score(f).gates.digitalSilence, false);
  assert.equal(score(f).controls.digitalSilence.complete, false);
  const unfrozen = evaluationFixture(); delete unfrozen.manifest.transcribeProduction.digitalSilenceControls;
  assert.equal(score(unfrozen).controls.digitalSilence.passed, false);
});
test('all recorded control output is checked even when the final parsed cues are empty', () => {
  for (const mutate of [
    r => r.attempts[0].evidence.audioTranscriptions[0].text = 'Invented speech',
    r => r.attempts[0].evidence.audioTranscriptions[0].words = [{ word: 'invented', startOffset: '0s', endOffset: '1s' }],
    r => r.attempts[0].evidence.audioTranscriptions[0].words = [{ word: '', startOffset: '0s', endOffset: '1s' }],
    r => r.attempts[0].evidence.audioTranscriptions[0].text = null,
    r => r.attempts[0].evidence.candidateDiagnostics[0].textParts.push('Hidden candidate speech'),
    r => { const earlier = structuredClone(r.attempts[0]); earlier.id += '-earlier'; earlier.evidence.audioTranscriptions[0].text = 'Earlier unwanted speech'; r.attempts.unshift(earlier); },
    r => r.attempts[0].evidence.evidenceTruncated = true,
    r => r.attempts[0].state = 'unknown',
    r => { r.state = 'needs_review'; r.output = null; },
  ]) {
    const f = evaluationFixture(); mutate(f.results.requests.at(-1));
    assert.equal(score(f).gates.digitalSilence, false);
  }
  const audit = evaluationFixture(); audit.manifest.transcribeProduction.digitalSilenceControls[0].verification.verifiedBeforeOutputs = false;
  assert.throws(() => score(audit), /pre-output all-sample/);
  const nonSpeech = evaluationFixture(); addControl(nonSpeech, 'non-speech');
  const r = score(nonSpeech); assert.equal(r.controls.conditions.find(c => c.condition === 'non-speech').tested, true);
  assert.equal(r.controls.digitalSilence.frozenCases, 1);
  nonSpeech.results.requests.at(-1).attempts[0].evidence.audioTranscriptions[0].text = 'Spurious tone interpretation';
  const hallucination = score(nonSpeech);
  assert.equal(hallucination.controls.conditions.find(c => c.condition === 'non-speech').controlPassed, false);
  assert.equal(hallucination.gates.digitalSilence, true);
  assert.equal(hallucination.controls.passed, true, 'Other non-speech limitations do not replace the digital-silence gate');
  nonSpeech.results.requests.at(-1).state = 'needs_review'; nonSpeech.results.requests.at(-1).output = null;
  const missing = score(nonSpeech).controls.conditions.find(c => c.condition === 'non-speech');
  assert.equal(missing.tested, false); assert.equal(missing.status, 'requests_recorded_no_scored_output');
});
test('strict historical timing shapes retain raw bounds and point anchors', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../crates/ai/tests/fixtures/evaluation/transcribe-timestamp-contract-v1.json', import.meta.url)));
  assert.equal(fixture.evidenceKind, 'authored-oracle');
  for (const c of fixture.cases) {
    const original = objectHash(c);
    if (c.expected === 'reject') assert.throws(() => timestampErrors(c.reference, c.hypothesis, c.language, c.durationMs, { allowPointHypothesis: true }), /invalid interval/);
    else { const report = timestampErrors(c.reference, c.hypothesis, c.language, c.durationMs, { allowPointHypothesis: true }); assert.equal(report.pointHypothesisCount, 1); assert.deepEqual(report.absoluteErrorsMs, [100, 100]); }
    assert.equal(objectHash(c), original);
  }
});

function pcm(samples = 16_007) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}
test('WAV verifier measures fractional-ms tails and rejects truncation or unsupported format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surtitle-policy-'));
  try {
    const path = join(dir, '日本語 & sample.wav'), bytes = pcm(); writeFileSync(path, bytes);
    assert.equal(measurePcmWav(path).samples, 16_007); assert.equal(measurePcmWav(path).sha256, sha256(bytes));
    writeFileSync(path, bytes.subarray(0, -1)); assert.throws(() => measurePcmWav(path), /complete/);
    bytes.writeUInt16LE(2, 22); writeFileSync(path, bytes); assert.throws(() => measurePcmWav(path), /mono/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('source slice verification rejects a one-sample offset despite correct WAV length and hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surtitle-source-slice-'));
  try {
    const sourcePath = join(dir, 'source.wav'), requestPath = join(dir, 'slice.wav'), bytes = pcm();
    for (let i = 0; i < 16_007; i++) bytes.writeInt16LE(i, 44 + i * 2);
    const slice = pcm(8000); bytes.copy(slice, 44, 44 + 7 * 2, 44 + 8007 * 2);
    writeFileSync(sourcePath, bytes); writeFileSync(requestPath, slice);
    const source = { sha256: sha256(bytes), samples: 16_007 }, measuredSlice = measurePcmWav(requestPath);
    const chunk = { id: 'slice', audioSha256: measuredSlice.sha256, resolvedAudioPath: requestPath, requestStartSample: 7 };
    assert.deepEqual(verifySourceSlices(sourcePath, source, [chunk], { slice: measuredSlice }).verifiedRequestIds, ['slice']);
    chunk.requestStartSample = 8;
    assert.throws(() => verifySourceSlices(sourcePath, source, [chunk], { slice: measuredSlice }), /source-clock slice/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('offline evaluator does not overwrite previous evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surtitle-policy-cli-'));
  try {
    const f = evaluationFixture();
    const referenceBytes = JSON.stringify(f.manifest), resultBytes = JSON.stringify(f.results);
    f.rubric.resultsSha256 = sha256(resultBytes); f.rubric.referenceReview.referencesSha256 = sha256(referenceBytes);
    const rubricBytes = JSON.stringify(f.rubric);
    Object.assign(f.review, { resultsSha256: sha256(resultBytes), referencesSha256: sha256(referenceBytes), rubricSha256: sha256(rubricBytes) });
    const files = { manifest: referenceBytes, results: resultBytes, rubric: rubricBytes, review: JSON.stringify(f.review) };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, `${name}.json`), bytes);
    const args = ['evaluate', ...Object.keys(files).flatMap(key => [`--${key}`, join(dir, `${key}.json`)]), '--output', join(dir, 'report.json')];
    assert.equal(run(args), 2);
    const original = readFileSync(join(dir, 'report.json'));
    assert.throws(() => run(args), /EEXIST/); assert.deepEqual(readFileSync(join(dir, 'report.json')), original);
  } finally { rmSync(dir, { recursive: true }); }
});
