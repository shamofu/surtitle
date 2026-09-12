// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { evaluationCoverage } from './coverage.mjs';

export const NORMALIZATION = Object.freeze({
  version: 'surtitle-en-wer-ja-cer-v1',
  unicode: 'NFKC; Unicode code points, not UTF-16 code units',
  case: 'Lowercase Latin letters in both languages',
  en: 'Whitespace-separated words; punctuation separates words, except apostrophes within words and decimal separators between digits. Curly apostrophes become ASCII. Symbols, fillers, repetitions, negation and numbers are retained.',
  ja: 'Remove Unicode punctuation and whitespace except decimal separators between digits; retain symbols, fillers, repetitions, numbers and iteration marks. Count Unicode code points without word segmentation.',
  distance: 'Levenshtein; deterministic ties prefer diagonal, deletion, insertion. Empty reference with insertions has null error rate and fails.',
  timestamps: 'Explicit ID match only; changed text, missing IDs and unmatched IDs are reported separately. Start and end absolute errors are pooled. Median is midpoint; p95 is nearest rank.',
});
export const RUBRIC = Object.freeze({
  scores: { 0: 'Wrong or misleading', 1: 'Requires correction', 2: 'Usable without correction' },
  vocabulary: ['meaning', 'exampleContext', 'translation', 'explanation'],
  explanation: ['meaning', 'exampleContext', 'translation', 'explanation'],
  translation: ['meaning', 'naturalness'],
  minimumItemsPerLanguageAndTask: 20,
  minimumMean: 1.8,
});

function ensure(condition, message) { if (!condition) throw new Error(message); }
function array(value, name) { ensure(Array.isArray(value), `${name} must be an array`); return value; }
function unique(values, name) { ensure(new Set(values).size === values.length, `${name} contains duplicate IDs`); }
function text(value, name) { ensure(typeof value === 'string', `${name} must be a string`); return value; }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function units(input, language) {
  let value = text(input, 'text').normalize('NFKC').toLowerCase().replace(/[\u2018\u2019]/gu, "'");
  if (language === 'ja') {
    const characters = Array.from(value);
    return characters.filter((character, index) => !/\s/u.test(character) && (!/\p{P}/u.test(character) || /[.,]/u.test(character) && /\p{N}/u.test(characters[index - 1] || '') && /\p{N}/u.test(characters[index + 1] || '')));
  }
  ensure(language === 'en', 'Only explicitly defined en WER and ja CER are supported');
  const chars = Array.from(value);
  value = chars.map((character, index) => {
    if (!/\p{P}/u.test(character)) return character;
    const before = chars[index - 1] || '', after = chars[index + 1] || '';
    if (character === "'" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return character;
    if (/[.,]/u.test(character) && /\p{N}/u.test(before) && /\p{N}/u.test(after)) return character;
    return ' ';
  }).join('');
  return value.trim() ? value.trim().split(/\s+/u) : [];
}

export function errorRate(reference, hypothesis, language) {
  const expected = units(reference, language), actual = units(hypothesis, language);
  ensure((expected.length + 1) * (actual.length + 1) <= 10_000_000, 'Comparison is too large; evaluate bounded annotated cases instead');
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => ({ errors: index, substitutions: 0, deletions: 0, insertions: index }));
  for (let i = 1; i <= expected.length; i++) {
    const current = [{ errors: i, substitutions: 0, deletions: i, insertions: 0 }];
    for (let j = 1; j <= actual.length; j++) {
      const different = Number(expected[i - 1] !== actual[j - 1]);
      const choices = [
        { ...previous[j - 1], errors: previous[j - 1].errors + different, substitutions: previous[j - 1].substitutions + different },
        { ...previous[j], errors: previous[j].errors + 1, deletions: previous[j].deletions + 1 },
        { ...current[j - 1], errors: current[j - 1].errors + 1, insertions: current[j - 1].insertions + 1 },
      ];
      current.push(choices.reduce((best, choice) => choice.errors < best.errors ? choice : best));
    }
    previous = current;
  }
  const counts = previous.at(-1);
  const rate = expected.length ? counts.errors / expected.length : actual.length ? null : 0;
  return { metric: language === 'en' ? 'WER' : 'CER', referenceUnits: expected.length, hypothesisUnits: actual.length, ...counts, rate, passed: rate !== null && rate <= .1 };
}

function percentile(values, p) { return values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : null; }
function median(values) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}
function checkTimed(values, name, durationMs, allowPoints = false) {
  unique(values.map(item => item.id), name);
  let previous = -1;
  for (const item of values) {
    ensure(typeof item.id === 'string' && item.id.length > 0, `${name} needs nonempty IDs`);
    ensure(Number.isSafeInteger(item.startMs) && Number.isSafeInteger(item.endMs) && item.startMs >= 0 && (allowPoints ? item.startMs <= item.endMs : item.startMs < item.endMs) && item.endMs <= durationMs, `${name} has an invalid interval`);
    ensure(item.startMs >= previous, `${name} is not monotonic`);
    previous = item.startMs;
    text(item.text, `${name}.text`);
  }
}
export function timestampErrors(reference, hypothesis, language, durationMs, options = {}) {
  checkTimed(reference, 'reference timestamps', durationMs);
  checkTimed(hypothesis, 'hypothesis timestamps', durationMs, options.allowPointHypothesis === true);
  const expected = new Map(reference.map(item => [item.id, item])), actual = new Map(hypothesis.map(item => [item.id, item]));
  const missingIds = reference.filter(item => !actual.has(item.id)).map(item => item.id);
  const unmatchedIds = hypothesis.filter(item => !expected.has(item.id)).map(item => item.id);
  const changedTextIds = [], matchedIds = [], errors = [];
  for (const item of reference) {
    const other = actual.get(item.id);
    if (!other) continue;
    if (units(item.text, language).join('\0') !== units(other.text, language).join('\0')) { changedTextIds.push(item.id); continue; }
    matchedIds.push(item.id);
    errors.push(Math.abs(item.startMs - other.startMs), Math.abs(item.endMs - other.endMs));
  }
  errors.sort((a, b) => a - b);
  const medianMs = median(errors), p95Ms = percentile(errors, .95);
  const numericPassed = errors.length > 0 && medianMs <= 150 && p95Ms <= 400;
  return { matchedIds, missingIds, unmatchedIds, changedTextIds, pointHypothesisCount: hypothesis.filter(item => item.startMs === item.endMs).length, excludedReferenceCount: missingIds.length + changedTextIds.length, absoluteErrorsMs: errors, medianMs, p95Ms, numericPassed, coverageComplete: !missingIds.length && !unmatchedIds.length && !changedTextIds.length, passed: numericPassed && !missingIds.length && !unmatchedIds.length && !changedTextIds.length };
}

export function boundaryReport(reference, observations, reviewMethod = 'human-review') {
  unique(reference.map(item => item.id), 'reference boundaries');
  unique(observations.map(item => item.id), 'observed boundaries');
  const actual = new Map(observations.map(item => [item.id, item]));
  const unknownIds = observations.filter(item => !reference.some(expected => expected.id === item.id)).map(item => item.id);
  const cases = reference.map(expected => {
    const observed = actual.get(expected.id);
    if (!observed) return { id: expected.id, status: 'missing', passed: false };
    const comparison = errorRate(expected.text, observed.joinedText, expected.language);
    const unchanged = comparison.errors === 0;
    const originalsRetained = typeof observed.originalLeft === 'string' && typeof observed.originalRight === 'string' && observed.originalLeft.length > 0 && observed.originalRight.length > 0;
    const mismatchFlagged = unchanged || (observed.needsReview === true && originalsRetained);
    const accepted = reviewMethod === 'ai-review' ? observed.reviewAccepted === true : observed.manuallyAccepted === true;
    const acceptedWithoutCorrection = unchanged && accepted && observed.needsReview === false;
    return { id: expected.id, status: unchanged ? 'preserved' : 'mismatch', comparison, originalsRetained, mismatchFlagged, acceptedWithoutCorrection, passed: unchanged && originalsRetained };
  });
  const preserved = cases.filter(item => item.status === 'preserved').length;
  const mismatches = cases.filter(item => item.status === 'mismatch').length;
  const missing = cases.filter(item => item.status === 'missing').length;
  const unflaggedMismatches = cases.filter(item => item.status === 'mismatch' && !item.mismatchFlagged).length;
  const acceptedWithoutCorrection = cases.filter(item => item.acceptedWithoutCorrection).length;
  const uniqueLocations = new Set(reference.map(item => item.locationId || item.id)).size;
  return { reviewMethod, requiredMinimum: 20, uniqueLocations, checked: cases.length - missing, preserved, mismatches, missing, unknownIds, unflaggedMismatches, acceptedWithoutCorrection, acceptedWithoutCorrectionRate: reference.length ? acceptedWithoutCorrection / reference.length : null, cases, passed: uniqueLocations >= 20 && !missing && !mismatches && !unknownIds.length && cases.every(item => item.passed) && acceptedWithoutCorrection / reference.length >= .9 };
}

export function semanticReport(expected, reviews) {
  const key = item => `${item.requestId}\0${item.itemId}`;
  unique(expected.map(key), 'expected semantic items');
  unique(reviews.map(key), 'semantic reviews');
  const scores = new Map(reviews.map(item => [key(item), item]));
  const missing = [], invalid = [], critical = [], groups = new Map();
  const extra = reviews.filter(item => !expected.some(target => key(target) === key(item))).map(key);
  for (const item of expected) {
    const dimensions = RUBRIC[item.taskKind];
    ensure(Array.isArray(dimensions), 'Unsupported semantic task');
    const groupKey = `${item.language}:${item.taskKind}:${item.candidateId || 'legacy'}`;
    const group = groups.get(groupKey) || { language: item.language, taskKind: item.taskKind, candidateId: item.candidateId || null, expectedItems: 0, reviewedItems: 0, criticalItems: 0, proficiency: {}, dimensions: Object.fromEntries(dimensions.map(d => [d, []])) };
    group.expectedItems++;
    groups.set(groupKey, group);
    const review = scores.get(key(item));
    if (!review) { missing.push({ requestId: item.requestId, itemId: item.itemId }); continue; }
    if (!review.scores || !dimensions.every(d => [0, 1, 2].includes(review.scores[d])) || !Array.isArray(review.criticalErrors) || review.criticalErrors.some(value => typeof value !== 'string') || Object.keys(review.scores).some(d => !dimensions.includes(d))
      || !review.evidence || !dimensions.every(d => typeof review.evidence[d] === 'string' && review.evidence[d].trim().length > 0 && review.evidence[d].length <= 4000)
      || item.proficiency && (typeof review.understandableAtProficiency !== 'boolean' || typeof review.proficiencyEvidence !== 'string' || !review.proficiencyEvidence.trim())) {
      invalid.push({ requestId: item.requestId, itemId: item.itemId }); continue;
    }
    group.reviewedItems++;
    if (item.proficiency) {
      const level = group.proficiency[item.proficiency] || { reviewed: 0, understandable: 0 };
      level.reviewed++; level.understandable += Number(review.understandableAtProficiency);
      group.proficiency[item.proficiency] = level;
    }
    for (const dimension of dimensions) group.dimensions[dimension].push(review.scores[dimension]);
    if (review.criticalErrors.length) { group.criticalItems++; critical.push({ requestId: item.requestId, itemId: item.itemId, errors: review.criticalErrors }); }
  }
  const summaries = [...groups.values()].map(group => {
    const dimensions = Object.fromEntries(Object.entries(group.dimensions).map(([name, values]) => [name, { count: values.length, mean: values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null, minimum: values.length ? Math.min(...values) : null }]));
    const proficiency = Object.fromEntries(Object.entries(group.proficiency).map(([name, value]) => [name, { ...value, rate: value.understandable / value.reviewed, passed: value.understandable / value.reviewed >= .9 }]));
    return { ...group, dimensions, proficiency, passed: !group.criticalItems && group.reviewedItems >= RUBRIC.minimumItemsPerLanguageAndTask && group.reviewedItems === group.expectedItems && Object.values(dimensions).every(value => value.mean >= RUBRIC.minimumMean && value.minimum >= 1) && Object.values(proficiency).every(value => value.passed) };
  });
  return { rubric: RUBRIC, groups: summaries, missing, invalid, extra, critical, passed: summaries.length > 0 && !missing.length && !invalid.length && !extra.length && !critical.length && summaries.every(group => group.passed) };
}

function normalizeCue(cue) { return { id: cue.id, startMs: cue.startMs ?? cue.start_ms, endMs: cue.endMs ?? cue.end_ms, text: cue.text }; }
function sameCues(a, b) { return JSON.stringify(a.map(normalizeCue)) === JSON.stringify(b.map(normalizeCue)); }
function unmatchedId(prefix, index, references) {
  let id = `${prefix}:${index}`;
  while (references.some(item => item.id === id)) id = `_${id}`;
  return id;
}
function offsetMs(value, ceil) {
  ensure(typeof value === 'string' && /^\d+(?:\.\d{1,9})?s$/u.test(value), 'invalid_word_duration');
  const [seconds, fraction = ''] = value.slice(0, -1).split('.');
  const nanoseconds = BigInt(fraction.padEnd(9, '0'));
  const milliseconds = BigInt(seconds) * 1000n + (nanoseconds + (ceil ? 999_999n : 0n)) / 1_000_000n;
  ensure(milliseconds <= BigInt(Number.MAX_SAFE_INTEGER), 'word_duration_overflow');
  return Number(milliseconds);
}
function wordTimestampReport(request, reference, rubric) {
  if (!Array.isArray(reference.words) || !reference.words.length) return { status: 'not_assessed_no_word_reference', passed: null };
  const matches = (rubric?.timestampMatches || []).filter(item => item.requestId === request.id && item.level === 'word');
  if (!matches.length) return { status: 'missing_explicit_word_alignment', passed: false };
  unique(matches.map(item => item.referenceId), 'word reference mapping');
  unique(matches.map(item => item.outputIndex), 'word output mapping');
  const attemptIds = [...new Set(matches.map(item => item.attemptId))];
  ensure(attemptIds.length === 1 && typeof attemptIds[0] === 'string', 'word_alignment_needs_one_attempt_id');
  const attempts = (request.attempts || []).filter(item => item.id === attemptIds[0]);
  ensure(attempts.length === 1 && attempts[0].state === 'settled', 'word_alignment_needs_settled_attempt');
  const evidence = attempts[0].evidence;
  ensure(evidence && evidence.evidenceTruncated === false, 'word_evidence_missing_or_truncated');
  const parts = array(evidence.audioTranscriptions, 'word evidence parts');
  ensure(parts.length > 0 && parts.every(item => item.finished !== false), 'word_evidence_incomplete');
  const words = parts.flatMap(part => array(part.words, 'word evidence words')).map(word => ({ text: text(word.word, 'word'), startMs: offsetMs(word.startOffset, false), endMs: offsetMs(word.endOffset, true) }));
  ensure(matches.every(item => Number.isInteger(item.outputIndex) && item.outputIndex >= 0 && item.outputIndex < words.length && reference.words.some(word => word.id === item.referenceId)), 'invalid_word_timestamp_mapping');
  const aligned = words.map((word, index) => ({ ...word, id: matches.find(item => item.outputIndex === index)?.referenceId || unmatchedId('unmatched-word', index, reference.words) }));
  return { level: 'word', attemptId: attemptIds[0], ...timestampErrors(reference.words.map(normalizeCue), aligned, reference.language, reference.audio.durationMs, { allowPointHypothesis: true }) };
}

/** Consume the native validation CLI's redacted report. No model API is used here. */
export function evaluate(manifest, results, rubric = null, options = {}) {
  ensure([1, 2].includes(manifest.schemaVersion) && results.schemaVersion === 1, 'Unsupported manifest or results schema');
  const references = array(manifest.cases, 'manifest.cases');
  unique(references.map(item => item.id), 'manifest cases');
  const requests = array(results.requests, 'results.requests');
  unique(requests.map(item => item.id), 'request IDs');
  const selected = options.caseIds || references.map(item => item.id);
  ensure(selected.length > 0, 'Select at least one reference case');
  unique(selected, 'selected cases');
  ensure(selected.every(id => references.some(item => item.id === id)), 'Unknown selected reference case');
  const coverage = manifest.schemaVersion === 2 ? evaluationCoverage(manifest.evaluationPlan, requests, references, selected) : null;
  const invalid = [], caseReports = [], expectedSemantic = [], allBoundaries = [], boundaryObservations = [];
  let reviewBound = false, aiReferenceBound = false;
  const reviewMethod = rubric?.reviewMethod || 'human-review';
  if (rubric !== null) {
    ensure(rubric.schemaVersion === 1, 'Unsupported review rubric schema');
    ensure(['ai-review', 'human-review'].includes(reviewMethod), 'Unsupported review method');
    ensure(typeof rubric.reviewer === 'string' && rubric.reviewer.trim().length > 0 && Number.isFinite(Date.parse(rubric.reviewedAt)), 'Review rubric needs reviewer and reviewedAt');
    ensure(typeof options.resultsSha256 === 'string' && /^[a-f0-9]{64}$/u.test(options.resultsSha256) && rubric.resultsSha256 === options.resultsSha256, 'Review rubric belongs to a different results file');
    if (reviewMethod === 'ai-review') {
      ensure(typeof rubric.reviewerModel === 'string' && rubric.reviewerModel.trim(), 'AI review needs reviewerModel');
      const review = rubric.referenceReview;
      ensure(review && review.method === 'ai-review' && typeof review.reviewer === 'string' && review.reviewer.trim() && typeof review.model === 'string' && review.model.trim() && Number.isFinite(Date.parse(review.reviewedAt)), 'AI review needs separate reference-review provenance');
      ensure(typeof options.referencesSha256 === 'string' && /^[a-f0-9]{64}$/u.test(options.referencesSha256) && review.referencesSha256 === options.referencesSha256, 'AI reference review belongs to a different reference file');
      ensure(review.independentOfModelOutput === true, 'Reference review must be independent of the tested model output');
      aiReferenceBound = true;
    }
    for (const field of ['items', 'timestampMatches', 'boundaries']) array(rubric[field], `rubric.${field}`);
    ensure([...rubric.items, ...rubric.timestampMatches, ...rubric.boundaries].every(item => requests.some(request => request.id === item.requestId)), 'Manual rubric contains an unknown request ID');
    unique(rubric.boundaries.map(item => `${item.requestId}\0${item.id}`), 'reviewed boundaries');
    ensure(rubric.boundaries.every(item => references.find(reference => reference.id === requests.find(request => request.id === item.requestId)?.caseId)?.boundaries?.some(boundary => boundary.id === item.id)), 'Manual rubric contains an unknown boundary ID');
    ensure(rubric.timestampMatches.every(item => item.level === undefined || ['cue', 'word'].includes(item.level)), 'Unknown timestamp annotation level');
    reviewBound = true;
  }
  for (const request of requests) {
    const reference = references.find(item => item.id === request.caseId);
    if (!reference) { invalid.push({ requestId: request.id, reason: 'unknown_case' }); continue; }
    if (!selected.includes(reference.id)) continue;
    const candidateId = coverage?.requests.find(item => item.requestId === request.id)?.candidateId;
    const report = { requestId: request.id, caseId: reference.id, taskKind: request.taskKind, language: reference.language, candidateId: candidateId || null, term: request.term ?? null, proficiency: request.proficiency ?? null, requestBodySha256: request.requestBodySha256 ?? null, status: 'incomplete' };
    caseReports.push(report);
    if (!request.output || !['completed', 'needs_review'].includes(request.state)) { report.reason = 'no_settled_output'; continue; }
    const output = request.output;
    try {
      if (['vocabulary', 'explanation', 'translation'].includes(request.taskKind)) {
        ensure(Array.isArray(request.sourceCues) && sameCues(reference.cues, request.sourceCues), 'source_cues_do_not_match_reference');
        const knownIds = new Set(reference.cues.map(cue => cue.id));
        if (request.taskKind === 'translation') {
          ensure(output.kind === 'translation', 'wrong_output_kind');
          const translations = array(output.translations, 'translations');
          unique(translations.map(item => item.id), 'translation IDs');
          ensure(translations.length === knownIds.size && translations.every(item => knownIds.has(item.id) && typeof item.translation === 'string' && item.translation.trim()), 'invalid_translation_coverage');
          for (const item of translations) expectedSemantic.push({ requestId: request.id, itemId: item.id, taskKind: request.taskKind, language: reference.language, candidateId });
        } else {
          ensure(output.kind === 'vocabulary', 'wrong_output_kind');
          const items = array(output.items, 'vocabulary items');
          ensure(items.length > 0, 'no_items_for_quality_evaluation');
          if (request.taskKind === 'explanation' && request.term !== undefined) {
            const normalized = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ') : null;
            ensure(items.length === 1 && normalized(items[0].term) === normalized(request.term), 'explanation_selected_term_mismatch');
          }
          for (const [index, item] of items.entries()) {
            const ids = item.sourceCueIds ?? item.source_cue_ids;
            ensure(Array.isArray(ids) && ids.length > 0 && ids.every(id => knownIds.has(id)), 'invalid_vocabulary_source');
            unique(ids, 'vocabulary source IDs');
            ensure(['term', 'meaning', 'example', 'explanation'].every(field => typeof item[field] === 'string' && item[field].trim()), 'invalid_vocabulary_fields');
            expectedSemantic.push({ requestId: request.id, itemId: `item:${index}`, taskKind: request.taskKind, language: reference.language, candidateId, proficiency: request.proficiency });
          }
        }
        report.status = reviewMethod === 'ai-review' ? 'awaiting_ai_review_scores' : 'awaiting_manual_scores';
      } else if (request.taskKind === 'transcribe_diagnostic') {
        ensure(output.kind === 'untimed_transcript' && typeof output.text === 'string', 'wrong_untimed_diagnostic_output');
        ensure(reference.audio && /^[a-f0-9]{64}$/u.test(reference.audio.sha256) && request.sourceAudioSha256 === reference.audio.sha256, 'source_audio_hash_does_not_match_reference');
        report.recognition = errorRate(reference.cues.map(cue => cue.text).join(' '), output.text, reference.language);
        report.subtitleQualityAssessed = false;
        report.status = 'diagnostic_only';
      } else if (['audio_transcription', 'transcribe_preview'].includes(request.taskKind)) {
        ensure(output.kind === 'transcript', 'wrong_output_kind');
        ensure(reference.audio && /^[a-f0-9]{64}$/u.test(reference.audio.sha256) && request.sourceAudioSha256 === reference.audio.sha256, 'source_audio_hash_does_not_match_reference');
        const cues = array(output.cues, 'transcription cues').map(normalizeCue);
        const language = reference.language;
        report.recognition = errorRate(reference.cues.map(cue => cue.text).join(' '), cues.map(cue => cue.text).join(' '), language);
        const matches = (rubric?.timestampMatches || []).filter(item => item.requestId === request.id && item.level !== 'word');
        unique(matches.map(item => item.referenceId), 'timestamp reference mapping');
        unique(matches.map(item => item.outputIndex), 'timestamp output mapping');
        ensure(matches.every(item => Number.isInteger(item.outputIndex) && item.outputIndex >= 0 && item.outputIndex < cues.length && reference.cues.some(cue => cue.id === item.referenceId)), 'invalid_timestamp_mapping');
        const aligned = cues.map((cue, index) => ({ ...cue, id: matches.find(item => item.outputIndex === index)?.referenceId || unmatchedId('unmatched-output', index, reference.cues) }));
        if (reference.cues.length === 0) {
          ensure(['silence', 'non-speech'].includes(reference.audio.classification), 'empty_reference_needs_explicit_silence_annotation');
          checkTimed(aligned, 'hypothesis timestamps', reference.audio.durationMs);
          report.timestamps = { status: reference.audio.classification === 'silence' ? 'not_applicable_to_silence' : 'not_applicable_to_non_speech', spuriousCueCount: cues.length, passed: cues.length === 0 };
        } else report.timestamps = timestampErrors(reference.cues.map(normalizeCue), aligned, language, reference.audio.durationMs);
        report.wordTimestamps = wordTimestampReport(request, reference, rubric);
        report.status = report.recognition.passed && report.timestamps.passed && report.wordTimestamps.passed !== false ? 'numeric_pass' : 'failed';
        for (const boundary of reference.boundaries || []) {
          allBoundaries.push({ ...boundary, id: `${request.id}:${boundary.id}`, locationId: `${reference.id}:${boundary.id}`, language });
          const observed = (rubric?.boundaries || []).find(item => item.requestId === request.id && item.id === boundary.id);
          if (observed) boundaryObservations.push({ ...observed, id: `${request.id}:${boundary.id}` });
        }
      } else throw new Error('unsupported_task_kind');
    } catch (error) { report.status = 'invalid'; report.reason = error.message; }
  }
  const missingCaseIds = selected.filter(id => !caseReports.some(item => item.caseId === id));
  const semantic = expectedSemantic.length ? semanticReport(expectedSemantic, rubric?.items || []) : null;
  const boundaries = allBoundaries.length ? boundaryReport(allBoundaries, boundaryObservations, reviewMethod) : null;
  for (const report of caseReports) {
    const group = semantic?.groups.find(item => item.language === report.language && item.taskKind === report.taskKind && item.candidateId === report.candidateId);
    const groupPassed = group?.passed && !semantic.extra.some(key => key.startsWith(`${report.requestId}\0`));
    if (report.status === 'awaiting_manual_scores') report.status = groupPassed ? 'manual_pass' : 'incomplete_or_failed_manual';
    if (report.status === 'awaiting_ai_review_scores') report.status = groupPassed ? 'ai_review_pass' : 'incomplete_or_failed_ai_review';
  }
  const selectedReferences = references.filter(item => selected.includes(item.id));
  const authoredOnly = selectedReferences.some(item => item.evidenceKind !== 'human-reviewed-reference');
  const referenceReviewComplete = selectedReferences.every(item => {
    const licensedAudio = !item.audio || item.audio.evaluationUsePermitted === true && typeof item.audio.source === 'string' && item.audio.source.trim() && typeof item.audio.license === 'string' && item.audio.license.trim();
    if (reviewMethod === 'ai-review') {
      // Authored text is a valid reference after separate AI review. Synthetic
      // audio oracle metadata does not become evidence of recorded speech.
      return aiReferenceBound && licensedAudio && (!item.audio || ['ai-reviewed-reference', 'human-reviewed-reference'].includes(item.evidenceKind));
    }
    const review = item.review || item.audio;
    return item.evidenceKind === 'human-reviewed-reference' && review && typeof review.annotator === 'string' && review.annotator.trim() && typeof review.independentReviewer === 'string' && review.independentReviewer.trim() && review.annotator !== review.independentReviewer && Number.isFinite(Date.parse(review.reviewedAt)) && licensedAudio;
  });
  const recordedProviderEvidence = typeof results.evidenceKind === 'string' && results.evidenceKind === 'provider-validation';
  const gatesPassed = caseReports.length > 0 && (!coverage || coverage.passed) && !missingCaseIds.length && !invalid.length && caseReports.every(item => ['numeric_pass', 'manual_pass', 'ai_review_pass'].includes(item.status)) && (!boundaries || boundaries.passed);
  return {
    schemaVersion: 1, reportKind: 'surtitle-ai-quality-evaluation', normalization: NORMALIZATION,
    reviewProvenance: rubric ? { method: reviewMethod, reviewer: rubric.reviewer, model: reviewMethod === 'ai-review' ? rubric.reviewerModel : null, reviewedAt: rubric.reviewedAt, referenceReview: reviewMethod === 'ai-review' ? rubric.referenceReview : null } : null,
    evidence: { authoredReferenceIncluded: authoredOnly, referenceReviewComplete, providerValidationDeclared: recordedProviderEvidence, reviewRubricBoundToResults: reviewBound, manualRubricBoundToResults: reviewBound && reviewMethod === 'human-review', aiReferenceReviewBoundToReferences: aiReferenceBound, humanReviewDeclared: reviewBound && reviewMethod === 'human-review', realModelQualityAssessed: recordedProviderEvidence && referenceReviewComplete && reviewBound, modelQualified: false, note: 'This report assesses the supplied evidence and never qualifies or unlocks a model. AI review is not human confirmation. Authored response or surrogate PCM results do not establish live model or real speech quality.' },
    expectedCaseIds: selected, missingCaseIds, invalidRequests: invalid, requests: caseReports, semantic, boundaries, coverage,
    gatesPassed, status: !recordedProviderEvidence || !referenceReviewComplete || !reviewBound ? 'oracle_or_unverified_evidence' : gatesPassed ? 'evaluation_gates_passed' : 'incomplete_or_failed',
  };
}
