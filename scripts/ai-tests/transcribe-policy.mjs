// SPDX-License-Identifier: GPL-3.0-or-later
import { evaluate, errorRate, sha256 } from './evaluation.mjs';

export const TRANSCRIBE_POLICY = Object.freeze({
  id: 'surtitle-transcribe-review-assisted-v1',
  minimumDistinctBoundaries: 20,
  automaticJoinTarget: 0.9,
  automaticJoinIsGate: false,
  playbackRangeCount: 100,
  playbackSuccessRate: 0.95,
  boundaryErrorRateMargin: 0.05,
  lifetimeBudgetMicrousd: 10_000_000,
});
export const CHUNK_PROFILES = Object.freeze({
  current120: Object.freeze({ minimumMs: 90_000, targetMs: 120_000, searchEndMs: 150_000, hardMaximumMs: 180_000, contextMs: 3000 }),
  short60: Object.freeze({ minimumMs: 45_000, targetMs: 60_000, searchEndMs: 75_000, hardMaximumMs: 90_000, contextMs: 3000 }),
});
const hashPattern = /^[a-f0-9]{64}$/u;
const cells = ['en:lecture', 'en:dialogue', 'ja:lecture', 'ja:dialogue'];
function ensure(value, message) { if (!value) throw new Error(message); }
function array(value, name) { ensure(Array.isArray(value), `${name} must be an array`); return value; }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function unique(values, name) { ensure(new Set(values).size === values.length, `${name} contains duplicates`); }
export const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
export const objectHash = value => sha256(canonicalJson(value));

/** Upstream text provenance and a new acoustic review are different evidence claims. */
export function referenceReadiness(source) {
  const ref = source.reference;
  const attributable = !!ref && nonempty(ref.path) && hashPattern.test(ref.sha256 || '')
    && ['upstream-transcript', 'automatic-alignment', 'independent-audio-review'].includes(ref.method)
    && ref.independentOfProviderOutput === true;
  const acousticReview = attributable && ref.verifiedAgainstAudio === true
    && nonempty(ref.reviewer) && Number.isFinite(Date.parse(ref.reviewedAt));
  const provenance = ref?.provenance;
  const mechanical = attributable && ref.method === 'upstream-transcript'
    && provenance?.upstreamAnnotationKind === 'human-corpus-annotation'
    && provenance.independentOfProviderOutput === true
    && provenance.annotationConversionVerified === true && provenance.sourceSamplesVerified === true
    && hashPattern.test(provenance.sourceVerificationSha256 || '')
    && provenance.sourceSha256 === (source.sha256 ?? source.sourceSha256)
    && hashPattern.test(provenance.sourceSha256 || '')
    && Array.isArray(provenance.originalAnnotations) && provenance.originalAnnotations.length > 0
    && provenance.originalAnnotations.every(file => nonempty(file.path) && hashPattern.test(file.sha256 || ''))
    && nonempty(provenance.preparationTool) && hashPattern.test(provenance.preparationToolSha256 || '')
    && Number.isFinite(Date.parse(provenance.preparedAt));
  return { upstreamMechanicalVerificationReady: !!mechanical,
    recognitionReferenceReady: !!acousticReview || (!!mechanical && ref.recognitionReferenceComplete === true),
    upstreamTimingReferenceReady: !!mechanical && ['word', 'utterance'].includes(ref.timingLevel) && ref.hasCompleteTimingAnchors === true,
    additionalAcousticReviewVerified: !!acousticReview,
    additionalListeningPerformed: ref?.additionalListening?.performed === true && nonempty(ref.additionalListening.reviewer)
      && Number.isFinite(Date.parse(ref.additionalListening.reviewedAt)),
    note: 'Verified upstream human text can be prepared without new listening. Timestamp calibration and real-player observations still need their own evidence.' };
}
function referenceReady(source) { return referenceReadiness(source).recognitionReferenceReady; }

/** Validate measured Rust plans; this deliberately does not recreate VAD or plan_chunks. */
export function validatePreparation(manifest, measurements = {}) {
  ensure(manifest.schemaVersion === 1 && manifest.policyId === TRANSCRIBE_POLICY.id, 'Unknown preparation schema or policy');
  ensure(['pilot', 'confirmation'].includes(manifest.stage), 'Unknown campaign stage');
  ensure(hashPattern.test(manifest.plannerCodeSha256 || ''), 'The Rust planner code hash is required');
  const execution = manifest.execution;
  ensure(execution && nonempty(execution.model_id) && execution.location === 'global'
    && Number.isSafeInteger(execution.max_output_tokens) && execution.max_output_tokens > 0
    && execution.thinking?.kind === 'omit', 'Freeze the exact Transcribe model, global endpoint, output limit and omitted thinking');
  ensure(manifest.adapter === 'transcribe' && manifest.wordTimestamp === true && manifest.mode === 'VERBATIM'
    && manifest.candidateCount === 1 && manifest.diarization === false, 'Only the frozen verbatim timed Transcribe contract is supported');
  const price = execution.price;
  ensure(price && nonempty(price.id) && nonempty(price.source) && integer(price.observed_at_ms)
    && integer(price.input_microusd_per_million) && integer(price.output_microusd_per_million), 'A reviewed exact price snapshot is required; this script does not look up prices');
  const sources = array(manifest.sources, 'sources');
  unique(sources.map(s => s.id), 'Source IDs');
  for (const source of sources) {
    ensure(nonempty(source.id) && hashPattern.test(source.sha256 || '') && source.sampleRate === 16_000
      && integer(source.samples) && source.samples > 0 && cells.includes(`${source.language}:${source.genre}`)
      && source.naturalSpeech === true && nonempty(source.sourceUrl) && nonempty(source.license)
      && nonempty(source.provenance) && nonempty(source.recordingId), 'Each source needs rights/provenance and a natural-speech 16 kHz sample clock');
  }
  const selections = array(manifest.selections, 'selections');
  ensure(selections.length > 0 && selections.length <= 16, 'A stage needs at most sixteen bounded selections');
  unique(selections.map(s => s.id), 'Selection IDs');
  const requests = [], locations = new Set(), primaryCells = [], sourceUses = new Set();
  let supplementalBoundaries = 0;
  for (const selection of selections) {
    const source = sources.find(s => s.id === selection.sourceId), profile = CHUNK_PROFILES[selection.profileId];
    ensure(source && profile && nonempty(selection.id), 'Selection source/profile is unknown');
    const expectedOptions = { sample_rate: 16_000, minimum_ms: profile.minimumMs, target_ms: profile.targetMs,
      search_end_ms: profile.searchEndMs, hard_maximum_ms: profile.hardMaximumMs,
      strong_pause_ms: 500, weak_pause_ms: 200, context_ms: 3000 };
    ensure(selection.options && canonicalJson(selection.options) === canonicalJson(expectedOptions), 'Selection options differ from the frozen Rust profile');
    ensure(integer(selection.startSample) && integer(selection.endSample) && selection.startSample < selection.endSample
      && selection.endSample <= source.samples, 'Selection escapes the source sample clock');
    const supplemental = selection.purpose === 'supplemental-boundary';
    ensure(supplemental || selection.purpose === 'primary', 'Selection purpose must be explicit');
    const durationSamples = selection.endSample - selection.startSample;
    if (!supplemental) {
      ensure(durationSamples === (manifest.stage === 'pilot' ? 240 : 480) * 16_000, 'Primary selections must be continuous four/eight-minute ranges');
      primaryCells.push(`${source.language}:${source.genre}:${selection.profileId}`);
    }
    sourceUses.add(source.id);
    const chunks = array(selection.chunks, 'selection.chunks');
    ensure(chunks.length > 0 && chunks.length <= 16, 'A selection needs bounded chunk metadata');
    if (supplemental) {
      ensure(manifest.stage === 'confirmation' && chunks.length === 2 && nonempty(selection.stressReason), 'Supplemental stress uses exactly one predeclared adjacent pair with a reason in confirmation');
      supplementalBoundaries++;
    }
    let cursor = selection.startSample;
    for (const [index, chunk] of chunks.entries()) {
      ensure(nonempty(chunk.id) && chunk.index === index && chunk.coreStartSample === cursor
        && integer(chunk.coreEndSample) && chunk.coreEndSample > cursor
        && chunk.coreEndSample <= selection.endSample, 'Core samples must be contiguous and covered exactly once');
      const coreSamples = chunk.coreEndSample - cursor;
      ensure(coreSamples <= profile.hardMaximumMs * 16, 'Core exceeds its profile hard maximum');
      if (!supplemental) {
        if (index < chunks.length - 1) ensure(coreSamples >= profile.minimumMs * 16, 'Nonfinal core is shorter than the profile minimum');
        ensure(selection.endSample - cursor > profile.hardMaximumMs * 16 || index === chunks.length - 1, 'A remainder within the hard maximum must be one final core');
      }
      const context = profile.contextMs * 16;
      ensure(chunk.requestStartSample === Math.max(selection.startSample, cursor - context)
        && chunk.requestEndSample === Math.min(selection.endSample, chunk.coreEndSample + context), 'Request samples must include exact bounded context');
      ensure(['strong_pause', 'weak_pause', 'forced', 'end_of_selection'].includes(chunk.boundary), 'Unknown boundary type');
      ensure((index === chunks.length - 1) === (chunk.boundary === 'end_of_selection'), 'Only the final chunk ends the selection');
      ensure(nonempty(chunk.audioPath) && hashPattern.test(chunk.audioSha256 || ''), 'Every immutable request needs an audio path and hash');
      const samples = chunk.requestEndSample - chunk.requestStartSample;
      const measured = measurements[chunk.id];
      const bytesVerified = !!measured && measured.sha256 === chunk.audioSha256 && measured.samples === samples
        && measured.sampleRate === 16_000 && measured.channels === 1 && measured.bitsPerSample === 16;
      if (measured) ensure(bytesVerified, 'Measured request bytes differ from the frozen sample plan');
      requests.push({ id: chunk.id, selectionId: selection.id, sourceId: source.id, sourceSha256: source.sha256,
        language: source.language, genre: source.genre, profileId: selection.profileId, audioPath: chunk.audioPath,
        audioSha256: chunk.audioSha256, samples, durationMs: Math.ceil(samples / 16), maxAudioSeconds: Math.ceil(samples / 16_000),
        coreStartSample: cursor, coreEndSample: chunk.coreEndSample, requestStartSample: chunk.requestStartSample,
        requestEndSample: chunk.requestEndSample, bytesVerified, referenceReady: referenceReady(source) });
      if (index < chunks.length - 1) locations.add(`${source.sha256}:${chunk.coreEndSample}`);
      cursor = chunk.coreEndSample;
    }
    ensure(cursor === selection.endSample, 'The final core must reach the selection end');
  }
  ensure(supplementalBoundaries <= 12, 'At most twelve predeclared supplemental boundaries are allowed');
  unique(requests.map(r => r.id), 'Request IDs');
  unique(primaryCells, 'Primary cell/profile pairs');
  const profiles = manifest.stage === 'pilot' ? ['current120', 'short60'] : [manifest.selectedProfileId];
  ensure(profiles.every(p => CHUNK_PROFILES[p]), 'Confirmation requires one preselected chunk profile');
  const required = cells.flatMap(cell => profiles.map(profile => `${cell}:${profile}`));
  ensure(required.length === primaryCells.length && required.every(cell => primaryCells.includes(cell)), 'Stage needs the complete EN/JA lecture/dialogue profile matrix');
  if (manifest.stage === 'pilot') {
    for (const cell of cells) {
      const pair = selections.filter(s => s.purpose === 'primary' && sources.some(source => source.id === s.sourceId && `${source.language}:${source.genre}` === cell));
      ensure(pair.length === 2 && pair[0].sourceId === pair[1].sourceId && pair[0].startSample === pair[1].startSample
        && pair[0].endSample === pair[1].endSample, 'Both pilot profiles must use identical source ranges');
    }
  }
  const repeatIds = array(manifest.repeatRequestIds || [], 'repeatRequestIds');
  unique(repeatIds, 'Repeat request IDs');
  ensure(manifest.stage === 'confirmation' ? repeatIds.length === 2 : repeatIds.length === 0, 'Confirmation needs exactly two frozen chunk repeats; pilot has none');
  const repeats = repeatIds.map(id => { const found = requests.find(r => r.id === id); ensure(found, 'Repeat references an unknown request'); return found; });
  if (repeats.length) ensure(new Set(repeats.map(r => r.language)).size === 2, 'Repeat exactly one chunk per language');
  const heldOut = manifest.stage === 'confirmation' ? array(manifest.pilotRanges, 'pilotRanges') : [];
  const holdoutKinds = [];
  if (manifest.stage === 'confirmation') {
    ensure(heldOut.length >= 4 && hashPattern.test(manifest.pilotManifestSha256 || ''), 'Confirmation must bind the prior pilot manifest and source ranges');
    for (const selection of selections) {
      const source = sources.find(s => s.id === selection.sourceId);
      ensure(heldOut.every(p => nonempty(p.recordingId) && hashPattern.test(p.sourceSha256 || '') && integer(p.startSample)
        && integer(p.endSample) && p.startSample < p.endSample), 'Pilot range identities must preserve recording IDs and source hashes');
      const same = heldOut.filter(p => p.recordingId === source.recordingId || p.sourceSha256 === source.sha256);
      ensure(same.length === 0, 'Confirmation requires recordings independent of the pilot, not temporal holdout');
      holdoutKinds.push({ selectionId: selection.id, kind: 'recording-holdout' });
    }
  }
  const referenceReadinessBySource = Object.fromEntries([...sourceUses].map(id => [id, referenceReadiness(sources.find(s => s.id === id))]));
  const missingReferences = [...sourceUses].filter(id => !referenceReady(sources.find(s => s.id === id)));
  const unverifiedAudioIds = requests.filter(r => !r.bytesVerified).map(r => r.id);
  const all = [...requests, ...repeats];
  ensure(all.length <= 64, 'Stage exceeds the bounded 64-request preparation ceiling');
  return { schemaVersion: 1, policy: TRANSCRIBE_POLICY, manifestSha256: objectHash(manifest), stage: manifest.stage,
    profiles: Object.fromEntries(profiles.map(id => [id, CHUNK_PROFILES[id]])), execution,
    requestCount: all.length, originalRequestCount: requests.length, repeatCount: repeats.length,
    totalSubmittedSamples: all.reduce((sum, r) => sum + r.samples, 0),
    totalSubmittedDurationMs: all.reduce((sum, r) => sum + r.durationMs, 0),
    distinctSourceBoundaries: locations.size, boundaryLocationIds: [...locations].sort(), supplementalBoundaries,
    missingReferences, referenceReadinessBySource, unverifiedAudioIds, holdoutKinds, requests,
    repeatRequests: repeats.map(r => ({ ...r, id: `${r.id}:fixed-repeat`, repeatOf: r.id })),
    confirmationBoundaryDeficit: manifest.stage === 'confirmation' ? Math.max(0, 20 - locations.size) : null,
    readyForQuotePreparation: missingReferences.length === 0 && unverifiedAudioIds.length === 0
      && (manifest.stage !== 'confirmation' || locations.size >= 20),
    networkRequests: 0, approvalGranted: false, priceEstimateUsd: null, modelQualified: false,
    note: 'Request/file verification is not a Rust planner execution proof or reference-quality certification. Exact native quotes supersede planning estimates; all historical charges and holds remain in the same lifetime ledger.' };
}

function pairedRows(expected, actual, name) {
  array(expected, `expected ${name}`); array(actual, name);
  unique(expected.map(r => r.id), `Expected ${name} IDs`); unique(actual.map(r => r.id), `${name} IDs`);
  ensure(actual.every(r => expected.some(e => e.id === r.id)), `${name} contains an unfrozen ID`);
  return expected.map(reference => ({ reference, observation: actual.find(row => row.id === reference.id) }));
}

function sourceUnion(ranges) {
  const merged = [];
  for (const range of ranges.map(r => ({ ...r })).sort((a, b) => a.sourceSha256.localeCompare(b.sourceSha256) || a.startSample - b.startSample || a.endSample - b.endSample)) {
    const previous = merged.at(-1);
    if (previous?.sourceSha256 === range.sourceSha256 && range.startSample <= previous.endSample) previous.endSample = Math.max(previous.endSample, range.endSample);
    else merged.push(range);
  }
  return merged;
}
const sourceSamples = ranges => ranges.reduce((sum, r) => sum + r.endSample - r.startSample, 0);

function correctionAudio(manifest, results, review, bindings, profileIds) {
  const clear = bindings.filter(b => b.condition === 'clear');
  const observations = array(review.rangeCorrections ?? [], 'rangeCorrections');
  unique(observations.map(o => o.id), 'Range correction IDs');
  ensure(observations.every(o => clear.some(b => b.caseId === o.id)), 'Range correction references an unfrozen clear-speech case');
  const rows = clear.map(b => {
    const source = b.sourceRange;
    if (source) {
      ensure(source.sampleRate === 16_000 && [source.coreStartSample, source.coreEndSample, source.requestStartSample, source.requestEndSample].every(integer)
        && source.requestStartSample <= source.coreStartSample && source.coreStartSample < source.coreEndSample
        && source.coreEndSample <= source.requestEndSample
        && Math.ceil((source.requestEndSample - source.requestStartSample) / 16) === manifest.cases.find(c => c.id === b.caseId).audio.durationMs,
      'Correction source ranges must match the frozen source clock and request duration');
    }
    const bindingComplete = !!source && source.verifiedAgainstSource === true && hashPattern.test(source.verificationSha256 || '');
    const requests = results.requests.filter(r => r.caseId === b.caseId), o = observations.find(r => r.id === b.caseId);
    const observed = bindingComplete && requests.length === 1 && !!o && o.requestId === requests[0].id
      && o.sourceSha256 === b.sourceSha256 && o.requestStartSample === source.requestStartSample && o.requestEndSample === source.requestEndSample
      && o.assessedEntireRequest === true && o.reviewedLocally === true && nonempty(o.evidence) && Array.isArray(o.requiredRanges);
    const ranges = observed ? o.requiredRanges.map(r => {
      ensure(integer(r.startSample) && integer(r.endSample) && r.startSample < r.endSample
        && r.startSample >= source.requestStartSample && r.endSample <= source.requestEndSample && nonempty(r.evidence),
      'Correction interval escapes the independently bound source request or lacks review evidence');
      return { sourceSha256: b.sourceSha256, startSample: r.startSample, endSample: r.endSample };
    }) : [];
    return { caseId: b.caseId, requestId: observed ? o.requestId : null, sourceSha256: b.sourceSha256, profileId: b.profileId,
      cell: `${b.language}:${b.genre}`, bindingComplete, observed, sourceRange: source ?? null,
      requiredRanges: ranges, evidence: observed ? o.evidence : null };
  });
  const summarize = selected => {
    const coverage = sourceUnion(selected.filter(r => r.bindingComplete).map(r => ({ sourceSha256: r.sourceSha256,
      startSample: r.sourceRange.coreStartSample, endSample: r.sourceRange.coreEndSample })));
    const corrections = sourceUnion(selected.flatMap(r => r.requiredRanges));
    const bound = selected.length > 0 && selected.every(r => r.bindingComplete);
    if (bound) ensure(corrections.every(r => coverage.some(c => c.sourceSha256 === r.sourceSha256 && c.startSample <= r.startSample && c.endSample >= r.endSample)),
      'Correction interval escapes the frozen evaluated source coverage');
    const complete = bound && selected.every(r => r.observed);
    const observedSamples = sourceSamples(corrections);
    return { expectedRequests: selected.length, observedRequests: selected.filter(r => r.observed).length,
      missingBindingCaseIds: selected.filter(r => !r.bindingComplete).map(r => r.caseId), missingObservationCaseIds: selected.filter(r => !r.observed).map(r => r.caseId),
      complete, sourceCoverage: coverage, sourceSamples: bound ? sourceSamples(coverage) : null,
      correctionRanges: corrections, observedCorrectionSamples: observedSamples,
      correctionRequiredSamples: complete ? observedSamples : null, correctionRequiredDurationMs: complete ? observedSamples / 16 : null };
  };
  return { sampleRate: 16_000, method: 'source_interval_union', reviewMethod: review.reviewMethod, reviewer: review.reviewer,
    byCell: profileIds.flatMap(profileId => cells.map(cell => ({ profileId, cell, ...summarize(rows.filter(r => r.profileId === profileId && r.cell === cell)) }))),
    byProfile: profileIds.map(profileId => ({ profileId, ...summarize(rows.filter(r => r.profileId === profileId)) })), rows,
    note: 'Measured source-audio duration requiring local correction, including already resolved corrections. Overlap/repeated source ranges count once per profile. Missing full-range observations are incomplete, never zero correction.' };
}

function pilotComparison(stage, recognition, corrections, bindings) {
  const byLanguage = ['current120', 'short60'].flatMap(profileId => ['en', 'ja'].map(language => {
    const rows = recognition.filter(r => r.profileId === profileId && r.cell.startsWith(`${language}:`));
    const units = rows.reduce((sum, r) => sum + r.referenceUnits, 0), errors = rows.reduce((sum, r) => sum + r.errors, 0);
    return { profileId, language, complete: rows.length === 2 && rows.every(r => r.complete) && units > 0,
      referenceUnits: units, errors, rate: units ? errors / units : null };
  }));
  const referenceReviewsComplete = bindings.filter(b => b.condition === 'clear').every(referenceReady);
  const identicalSources = cells.every(cell => {
    const current = corrections.byCell.find(r => r.profileId === 'current120' && r.cell === cell);
    const short = corrections.byCell.find(r => r.profileId === 'short60' && r.cell === cell);
    return current?.complete && short?.complete && canonicalJson(current.sourceCoverage) === canonicalJson(short.sourceCoverage);
  });
  const complete = stage === 'pilot' && referenceReviewsComplete && byLanguage.every(r => r.complete) && identicalSources;
  const current = corrections.byProfile.find(r => r.profileId === 'current120'), short = corrections.byProfile.find(r => r.profileId === 'short60');
  const noWorse = complete ? ['en', 'ja'].every(language => byLanguage.find(r => r.profileId === 'short60' && r.language === language).rate
    <= byLanguage.find(r => r.profileId === 'current120' && r.language === language).rate) : null;
  const lessCorrection = complete ? short.correctionRequiredSamples < current.correctionRequiredSamples : null;
  return { applicable: stage === 'pilot', comparisonComplete: complete, referenceReviewsComplete, identicalSources: !!identicalSources,
    recognitionByLanguage: byLanguage, recognitionNoWorseInBothLanguages: noWorse, lessCorrectionRequiredAudio: lessCorrection,
    recommendation: stage !== 'pilot' ? 'not_applicable' : !complete ? 'undecided' : noWorse && lessCorrection ? 'recommend_short60' : 'keep_current120',
    selectedProfileId: !complete ? null : noWorse && lessCorrection ? 'short60' : 'current120',
    reason: stage !== 'pilot' ? 'confirmation_uses_preselected_profile' : !complete ? 'incomplete_or_unmatched_comparison_evidence'
      : !noWorse ? 'short_profile_recognition_is_worse' : !lessCorrection ? 'short_profile_has_no_strict_correction_duration_reduction' : 'no_worse_recognition_and_less_correction_audio',
    automaticProductChange: false,
    recognitionDenominator: 'All frozen request reference units, including repeated overlap; not a unique-source word/character count.' };
}

function recordedControlOutput(request, parsed) {
  const attempts = Array.isArray(request.attempts) ? request.attempts : [];
  const transcriptions = attempts.flatMap(a => Array.isArray(a.evidence?.audioTranscriptions) ? a.evidence.audioTranscriptions : []);
  const diagnostics = attempts.flatMap(a => Array.isArray(a.evidence?.candidateDiagnostics) ? a.evidence.candidateDiagnostics : []);
  const evidenceComplete = attempts.length > 0 && attempts.every(a => a.state === 'settled' && a.evidence?.evidenceTruncated === false
    && Array.isArray(a.evidence.audioTranscriptions) && a.evidence.audioTranscriptions.some(t => t.finished === true)
    && a.evidence.audioTranscriptions.every(t => t && typeof t === 'object' && !Array.isArray(t)
      && (t.text === undefined || typeof t.text === 'string') && (t.finished === undefined || typeof t.finished === 'boolean')
      && (t.words === undefined || Array.isArray(t.words)))
    && Array.isArray(a.evidence.candidateDiagnostics) && a.evidence.candidateDiagnostics.length === 1
    && a.evidence.candidateDiagnostics.every(c => c.finishReason === 'STOP' && c.textTruncated === false && Array.isArray(c.textParts) && c.textParts.every(t => typeof t === 'string')));
  const words = transcriptions.flatMap(t => Array.isArray(t?.words) ? t.words : []);
  const text = [...transcriptions.map(t => t?.text), ...words.map(w => w?.word), ...diagnostics.flatMap(c => Array.isArray(c?.textParts) ? c.textParts : [])].filter(nonempty);
  const empty = request.state === 'completed' && request.output?.kind === 'transcript' && request.output.cues.length === 0
    && parsed?.recognition?.passed === true && parsed.timestamps?.spuriousCueCount === 0;
  return { requestId: request.id, recordedAttempts: attempts.length, evidenceComplete, nonemptyRecordedTextCount: text.length, recordedWordCount: words.length,
    completedEmptyOutput: !!empty, passed: evidenceComplete && !!empty && text.length === 0 && words.length === 0 };
}

function conditionReports(plan, manifest, results, legacy, bindings) {
  const frozen = array(plan.digitalSilenceControls ?? [], 'digitalSilenceControls');
  unique(frozen.map(c => c.caseId), 'Digital silence control IDs');
  for (const control of frozen) {
    const b = bindings.find(b => b.caseId === control.caseId), reference = manifest.cases.find(c => c.id === control.caseId);
    ensure(b?.condition === 'silence' && reference?.audio?.classification === 'silence' && reference.cues.length === 0,
      'Digital silence must be an explicitly frozen empty-reference silence case');
    ensure(control.sampleRate === 16_000 && integer(control.samples) && control.samples > 0 && Math.ceil(control.samples / 16) === reference.audio.durationMs
      && control.audioSha256 === reference.audio.sha256 && control.verification?.method === 'all-pcm-samples-zero'
      && control.verification.verifiedBeforeOutputs === true && hashPattern.test(control.verification.sha256 || ''),
    'Digital silence needs a frozen, pre-output all-sample PCM verification bound to its exact audio hash');
  }
  const reports = ['silence', 'non-speech', 'bgm', 'overlapping-speech'].map(condition => {
    const ids = bindings.filter(b => b.condition === condition).map(b => b.caseId);
    const requests = results.requests.filter(r => ids.includes(r.caseId));
    const scoredOutputs = requests.filter(r => legacy.requests.some(p => p.requestId === r.id && p.recognition)).length;
    const complete = ids.length > 0 && ids.every(id => requests.filter(r => r.caseId === id).length === 1);
    const controls = ['silence', 'non-speech'].includes(condition) ? requests.map(r => recordedControlOutput(r, legacy.requests.find(p => p.requestId === r.id))) : [];
    const conditionComplete = complete && (controls.length ? controls.every(r => r.evidenceComplete) : requests.every(r => legacy.requests.some(p => p.requestId === r.id && p.recognition)));
    return { condition, expectedCases: ids.length, observedRequests: requests.length, scoredOutputs, tested: scoredOutputs > 0,
      complete: conditionComplete, controlPassed: controls.length && conditionComplete ? controls.every(r => r.passed) : null,
      status: ids.length === 0 ? 'not_planned_not_tested' : requests.length === 0 ? 'planned_not_observed' : scoredOutputs === 0 ? 'requests_recorded_no_scored_output' : 'observed',
      controls, requests: legacy.requests.filter(r => ids.includes(r.caseId)) };
  });
  const digital = frozen.flatMap(c => results.requests.filter(r => r.caseId === c.caseId).map(r => recordedControlOutput(r, legacy.requests.find(p => p.requestId === r.id))));
  const digitalComplete = frozen.length > 0 && frozen.every(c => results.requests.filter(r => r.caseId === c.caseId).length === 1) && digital.every(r => r.evidenceComplete);
  return { digitalSilence: { required: true, frozenCases: frozen.length, observedRequests: digital.length, complete: digitalComplete,
    passed: digitalComplete && digital.every(r => r.passed), rows: digital }, conditions: reports,
    passed: digitalComplete && digital.every(r => r.passed) };
}

/** Opt-in policy wrapper. The legacy report and its original gates remain intact. */
export function evaluateTranscribeProduction(manifest, results, rubric, assistedReview, hashes) {
  const plan = manifest.transcribeProduction;
  ensure(plan?.policyId === TRANSCRIBE_POLICY.id && ['pilot', 'confirmation'].includes(plan.stage), 'A separately frozen Transcribe production plan is required');
  ensure(manifest.schemaVersion === 2 && manifest.evaluationPlan, 'The new policy requires the existing schema-v2 request denominator');
  ensure(manifest.evaluationPlan.candidates?.length === 1, 'Freeze one Transcribe execution configuration per stage');
  ensure(manifest.evaluationPlan.cases.every(c => c.taskKind === 'transcribe_preview'), 'This policy evaluates timed Transcribe only');
  ensure(assistedReview?.policyId === plan.policyId && assistedReview.referencesSha256 === hashes.referencesSha256
    && assistedReview.resultsSha256 === hashes.resultsSha256 && assistedReview.rubricSha256 === hashes.rubricSha256,
  'The assisted review must bind the exact reference, provider result and rubric bytes');
  ensure(['ai-review', 'human-review'].includes(assistedReview.reviewMethod) && nonempty(assistedReview.reviewer)
    && Number.isFinite(Date.parse(assistedReview.reviewedAt))
    && (assistedReview.reviewMethod !== 'ai-review' || nonempty(assistedReview.reviewerModel)), 'An explicit, attributable review method is required');
  const legacy = evaluate(manifest, results, rubric, hashes);
  const bindings = array(plan.caseBindings, 'caseBindings');
  unique(bindings.map(b => b.caseId), 'Case binding IDs');
  ensure(manifest.cases.every(c => bindings.some(b => b.caseId === c.id)) && bindings.every(b => manifest.cases.some(c => c.id === b.caseId)), 'Every reference case needs an explicit source/condition binding');
  for (const b of bindings) ensure(nonempty(b.sourceId) && hashPattern.test(b.sourceSha256 || '') && CHUNK_PROFILES[b.profileId]
    && (cells.includes(`${b.language}:${b.genre}`) || ['en', 'ja'].includes(b.language) && b.genre === 'control' && ['silence', 'non-speech'].includes(b.condition))
    && ['clear', 'bgm', 'overlapping-speech', 'silence', 'non-speech'].includes(b.condition), 'Source conditions and chunk profiles must be explicit');
  const profileIds = [...new Set(bindings.filter(b => b.condition === 'clear').map(b => b.profileId))];
  ensure(profileIds.length > 0 && (plan.stage === 'pilot' ? profileIds.length === 2 : profileIds.length === 1), 'Pilot compares both profiles; confirmation evaluates exactly one');
  const recognition = profileIds.flatMap(profileId => cells.map(cell => {
    const ids = bindings.filter(b => b.profileId === profileId && `${b.language}:${b.genre}` === cell && b.condition === 'clear').map(b => b.caseId);
    const rows = legacy.requests.filter(r => ids.includes(r.caseId));
    const complete = ids.length > 0 && rows.length === ids.length && ids.every(id => rows.filter(r => r.caseId === id).length === 1)
      && rows.every(r => r.recognition && r.status !== 'invalid');
    const units = rows.reduce((sum, r) => sum + (r.recognition?.referenceUnits || 0), 0);
    const errors = rows.reduce((sum, r) => sum + (r.recognition?.errors || 0), 0);
    return { cell, profileId, complete, expectedCases: ids.length, scoredCases: rows.filter(r => r.recognition).length,
      referenceUnits: units, errors, rate: units ? errors / units : null,
      passed: complete && units > 0 && errors / units <= .1 };
  }));
  const safety = pairedRows(results.requests.map(r => ({ id: r.id })), assistedReview.requestHandling, 'requestHandling').map(({ reference, observation: o }) => {
    const request = results.requests.find(r => r.id === reference.id);
    const parsed = legacy.requests.find(r => r.requestId === request.id);
    const valid = request.state === 'completed' && request.output?.kind === 'transcript' && parsed && parsed.status !== 'invalid';
    const validDisposition = o && nonempty(o.evidence) && (valid ? ['available', 'review-required'].includes(o.disposition) : o.disposition === 'blocked-preserved')
      && o.originalEvidenceRetained === true && o.automaticRetry === false;
    return { requestId: request.id, validParsedOutput: !!valid, disposition: o?.disposition || 'missing', passed: !!validDisposition };
  });
  const boundaryRows = pairedRows(plan.boundaries, assistedReview.boundaries, 'boundaries').map(({ reference, observation: o }) => {
    ensure(hashPattern.test(reference.sourceSha256 || '') && integer(reference.cutSample) && nonempty(reference.id)
      && CHUNK_PROFILES[reference.profileId], 'Boundary needs its exact source sample identity and profile');
    const left = results.requests.find(r => r.caseId === reference.leftCaseId), right = results.requests.find(r => r.caseId === reference.rightCaseId);
    ensure([reference.leftCaseId, reference.rightCaseId].every(caseId => bindings.some(b => b.caseId === caseId
      && b.sourceSha256 === reference.sourceSha256 && b.profileId === reference.profileId)), 'Boundary source/profile differs from its frozen case bindings');
    const originalsBound = !!o && !!left?.output && !!right?.output && canonicalJson(o.originalLeft) === canonicalJson(left.output) && canonicalJson(o.originalRight) === canonicalJson(right.output);
    const reviewed = !!o && nonempty(o.evidence) && ['automatic', 'review-required', 'locally-resolved'].includes(o.disposition);
    const safe = reviewed && originalsBound && o.originalsRetained === true && o.stitchingIntroducedLexicalChange === false;
    return { id: reference.id, locationId: `${reference.sourceSha256}:${reference.cutSample}`, profileId: reference.profileId, originalsBound,
      disposition: o?.disposition || 'missing', automatic: safe && o.disposition === 'automatic',
      correctionRequired: o?.disposition === 'review-required', passed: safe };
  });
  const locations = new Set(boundaryRows.map(b => b.locationId));
  const automatic = boundaryRows.filter(b => b.automatic).length;
  const boundaries = { distinctLocations: locations.size, checked: boundaryRows.filter(b => b.originalsBound).length,
    automatic, automaticRate: boundaryRows.length ? automatic / boundaryRows.length : null,
    automaticTarget: .9, automaticTargetIsGate: false,
    correctionRequiredBoundaryCount: boundaryRows.filter(b => b.correctionRequired).length,
    byProfile: profileIds.map(profileId => { const rows = boundaryRows.filter(b => b.profileId === profileId); return { profileId,
      checked: rows.length, automaticRate: rows.length ? rows.filter(r => r.automatic).length / rows.length : null }; }),
    requiredDistinctLocations: plan.stage === 'confirmation' ? 20 : null,
    observationsComplete: boundaryRows.length > 0 && boundaryRows.every(b => b.originalsBound),
    preservationPassed: boundaryRows.length > 0 && boundaryRows.every(b => b.passed),
    passed: (plan.stage !== 'confirmation' || locations.size >= 20) && boundaryRows.length > 0 && boundaryRows.every(b => b.passed), rows: boundaryRows };
  const comparisons = pairedRows(plan.boundaryComparisons, assistedReview.boundaryComparisons, 'boundaryComparisons').map(({ reference, observation: o }) => {
    ensure(cells.includes(`${reference.language}:${reference.genre}`) && CHUNK_PROFILES[reference.profileId]
      && nonempty(reference.boundaryReference) && nonempty(reference.interiorReference), 'Comparison needs an explicit cell/profile and independent boundary/interior references');
    if (!o || !nonempty(o.evidence) || !Array.isArray(o.boundaryParts) || !Array.isArray(o.interiorParts)) return { id: reference.id, passed: false, status: 'missing' };
    const extract = (parts, caseIds) => {
      ensure(Array.isArray(caseIds) && caseIds.length > 0 && parts.length > 0 && parts.length <= 8, 'Comparison must bind bounded raw cue groups to frozen cases');
      unique(parts.map(p => `${p.requestId}:${p.startCue}:${p.endCue}`), 'Comparison raw cue groups');
      const selected = parts.map(part => {
        const request = results.requests.find(r => r.id === part.requestId);
        ensure(request && caseIds.includes(request.caseId), 'Comparison references an unfrozen provider case');
        if (!request.output) return null;
        ensure(request.output.kind === 'transcript' && integer(part.startCue) && integer(part.endCue) && part.startCue < part.endCue
          && part.endCue <= request.output.cues.length, 'Comparison references invalid raw provider cues');
        return request.output.cues.slice(part.startCue, part.endCue).map(c => c.text).join(' ');
      });
      return selected.some(text => text === null) ? null : selected.join(' ');
    };
    const boundaryText = extract(o.boundaryParts, reference.boundaryCaseIds), interiorText = extract(o.interiorParts, reference.interiorCaseIds);
    if (boundaryText === null || interiorText === null) return { id: reference.id, passed: false, status: 'unavailable_provider_output' };
    const boundary = errorRate(reference.boundaryReference, boundaryText, reference.language), interior = errorRate(reference.interiorReference, interiorText, reference.language);
    return { id: reference.id, cell: `${reference.language}:${reference.genre}`, profileId: reference.profileId,
      boundary, interior, boundaryText, interiorText, status: 'measured', passed: boundary.rate !== null && interior.rate !== null && boundary.rate <= interior.rate + .05 };
  });
  const playbackRows = pairedRows(plan.playbackRanges, assistedReview.playback, 'playback').map(({ reference, observation: o }) => {
    ensure(hashPattern.test(reference.sourceSha256 || '') && integer(reference.startSample) && integer(reference.endSample)
      && reference.startSample < reference.endSample && cells.includes(`${reference.language}:${reference.genre}`)
      && ['boundary', 'interior'].includes(reference.stratum) && nonempty(reference.intendedText)
      && bindings.some(b => b.sourceSha256 === reference.sourceSha256 && b.language === reference.language && b.genre === reference.genre),
    'Playback reference needs known source samples, intended speech and an explicit stratum');
    const observed = !!o && o.sourceSha256 === reference.sourceSha256 && o.startSample === reference.startSample && o.endSample === reference.endSample
      && o.playedInRealPlayer === true && nonempty(o.player) && nonempty(o.evidence)
      && ['ai-review', 'human-review'].includes(o.assessmentMethod);
    return { id: reference.id, cell: `${reference.language}:${reference.genre}`, stratum: reference.stratum, observed,
      assessmentMethod: o?.assessmentMethod ?? null, player: o?.player ?? null, evidence: o?.evidence ?? null,
      passed: observed && o.containsIntendedSpeech === true && o.clippedStart === false && o.clippedEnd === false };
  });
  const playbackSuccess = playbackRows.filter(r => r.passed).length;
  const playbackLocations = new Set(plan.playbackRanges.map(r => `${r.sourceSha256}:${r.startSample}:${r.endSample}`));
  const playback = { required: plan.stage === 'confirmation' ? 100 : null, expected: playbackRows.length, observed: playbackRows.filter(r => r.observed).length,
    successful: playbackSuccess, successRate: playbackRows.length ? playbackSuccess / playbackRows.length : null,
    passed: playbackRows.length === 100 && playbackLocations.size === 100 && playbackRows.every(r => r.observed) && playbackSuccess >= 95
      && cells.every(cell => playbackRows.filter(r => r.cell === cell).length === 25)
      && ['boundary', 'interior'].every(stratum => playbackRows.filter(r => r.stratum === stratum).length === 50),
    rows: playbackRows };
  const speechIds = bindings.filter(b => b.condition === 'clear').map(b => b.caseId);
  const timingRows = legacy.requests.filter(r => speechIds.includes(r.caseId));
  const timing = { rows: timingRows.map(r => ({ requestId: r.requestId, caseId: r.caseId, cue: r.timestamps ?? null, word: r.wordTimestamps ?? null })),
    passed: timingRows.length > 0 && speechIds.every(id => timingRows.some(r => r.caseId === id))
      && timingRows.every(r => r.timestamps?.passed === true && r.wordTimestamps?.passed === true),
    note: 'Missing independent references or incomplete mappings remain incomplete; accurate subsets and utterance endpoints do not establish word timing.' };
  const missingSourceReferenceReviews = bindings.filter(b => !referenceReady(b)).map(b => b.caseId);
  const evidenceReady = legacy.evidence.realModelQualityAssessed && missingSourceReferenceReviews.length === 0;
  const corrections = correctionAudio(manifest, results, assistedReview, bindings, profileIds);
  const comparison = pilotComparison(plan.stage, recognition, corrections, bindings);
  const controls = conditionReports(plan, manifest, results, legacy, bindings);
  const comparisonComplete = profileIds.every(profileId => cells.every(cell => comparisons.some(c => c.profileId === profileId && c.cell === cell)))
    && comparisons.length > 0 && comparisons.every(c => c.status === 'measured');
  const boundaryErrorDiagnostic = { margin: .05, isGate: false, complete: comparisonComplete,
    passed: comparisonComplete && comparisons.every(c => c.passed) };
  const gates = { frozenCoverage: legacy.coverage?.passed === true && !legacy.missingCaseIds.length && !legacy.invalidRequests.length,
    requestSafety: safety.length > 0 && safety.every(r => r.passed), clearSpeechRecognition: recognition.every(g => g.passed),
    timing: timing.passed, stitchingSafety: boundaries.passed,
    digitalSilence: controls.passed,
    correctionMeasurementComplete: corrections.byCell.every(r => r.complete),
    ...(plan.stage === 'pilot' ? { pilotComparisonComplete: comparison.comparisonComplete } : {}),
    ...(plan.stage === 'confirmation' ? { playback: playback.passed } : {}), referenceAndReviewEvidence: evidenceReady };
  const gatesPassed = Object.values(gates).every(Boolean);
  return { schemaVersion: 1, reportKind: 'surtitle-transcribe-production-evaluation', policy: TRANSCRIBE_POLICY,
    stage: plan.stage, inputs: hashes, legacyEvaluation: legacy, missingSourceReferenceReviews, recognition, requestSafety: safety, boundaries,
    boundaryComparisons: comparisons, boundaryErrorDiagnostic, playback, timing, correctionRequiredAudio: corrections, pilotComparison: comparison,
    confirmationCoverage: { applicable: plan.stage === 'confirmation', minimumDistinctBoundaries: 20, requiredPlaybackRanges: 100,
      boundariesPassed: plan.stage === 'confirmation' ? locations.size >= 20 : null, playbackPassed: plan.stage === 'confirmation' ? playback.passed : null },
    controls,
    separateConditions: bindings.filter(b => b.condition !== 'clear').map(b => ({ ...b, requests: legacy.requests.filter(r => r.caseId === b.caseId) })),
    gates, gatesPassed, status: !evidenceReady ? 'incomplete_reference_or_review_evidence' : gatesPassed ? 'evaluation_gates_passed' : 'incomplete_or_failed',
    modelQualified: false, productionAutomaticallyUnlocked: false,
    note: 'Review-assisted safety and automatic-join performance are distinct. No historical report is rewritten. These measurements do not constitute a model catalog or an unconditional quality guarantee.' };
}
