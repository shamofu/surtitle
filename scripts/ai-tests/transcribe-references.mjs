// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, statSync, mkdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './evaluation.mjs';
import { objectHash, validatePreparation } from './transcribe-policy.mjs';
import { measurePcmWav, verifySourceSlices } from './transcribe-production.mjs';

const NITE = '{http://nite.sourceforge.net/}';
const ensure = (value, message) => { if (!value) throw new Error(message); };
const named = value => typeof value === 'string' && value.trim().length > 0;
const safe = value => Number.isSafeInteger(value) && value >= 0;
const hashPattern = /^[a-f0-9]{64}$/u;
const MAX_JSON = 16 * 1024 * 1024;
const jsonBytes = value => `${JSON.stringify(value, null, 2)}\n`;
function readBounded(path, limit = MAX_JSON) {
  ensure(statSync(path).size <= limit, 'Reference input exceeds its size bound');
  const bytes = readFileSync(path);
  ensure(bytes.length <= limit, 'Reference input grew beyond its size bound');
  return bytes;
}
function readJson(path) { const bytes = readBounded(path); return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) }; }

/** Exact decimal annotation coordinates; never silently round an upstream timestamp. */
export function secondsToSample(value) {
  const text = String(value), match = /^(\d{1,6})(?:\.(\d{1,9}))?$/u.exec(text);
  ensure(match, 'Annotation time must be a nonnegative bounded decimal');
  const denominator = 10n ** BigInt(match[2]?.length ?? 0);
  const numerator = (BigInt(match[1]) * denominator + BigInt(match[2] || '0')) * 16_000n;
  ensure(numerator % denominator === 0n, 'Annotation time does not fall on the 16 kHz sample clock');
  const sample = Number(numerator / denominator);
  ensure(safe(sample) && sample <= 6 * 3600 * 16_000, 'Annotation exceeds the six-hour sample bound');
  return sample;
}

function xmlText(value) {
  ensure(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/u.test(value), 'Unsupported XML entity');
  return value.replace(/&([^;]+);/gu, (_, entity) => {
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    ensure(Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), 'Invalid XML code point');
    return String.fromCodePoint(code);
  });
}
function attributes(value) {
  const result = {}, pattern = /\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
  let offset = 0;
  while (value.slice(offset).trim()) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    ensure(match, 'Malformed NXT attributes');
    const key = match[1].startsWith('nite:') ? `${NITE}${match[1].slice(5)}` : match[1];
    ensure(!Object.hasOwn(result, key), 'Duplicate NXT attribute');
    result[key] = xmlText(match[2] ?? match[3]); offset = pattern.lastIndex;
  }
  return result;
}

/** A deliberately narrow NXT reader: no DTD, entities, external resources or nested markup. */
export function parseAmiNxt(bytes, recordingId, speakerId) {
  ensure(Buffer.isBuffer(bytes) && bytes.length <= 2 * 1024 * 1024, 'NXT input exceeds the 2 MiB bound');
  ensure(/^AMI\/[A-Z]{2}\d{4}[a-z]$/u.test(recordingId) && /^[A-D]$/u.test(speakerId), 'Unexpected AMI identity');
  const declaration = bytes.subarray(0, 160).toString('ascii').match(/^<\?xml[^?]*encoding=["']([^"']+)["'][^?]*\?>/u);
  ensure(declaration && ['ISO-8859-1', 'UTF-8'].includes(declaration[1].toUpperCase()), 'Explicit supported NXT encoding is required');
  const text = bytes.toString(declaration[1].toUpperCase() === 'ISO-8859-1' ? 'latin1' : 'utf8');
  ensure(!/<!|\u0000/u.test(text), 'DTD, comments, CDATA and NUL are unsupported in NXT');
  const root = /^<\?xml[^?]*\?>\s*<nite:root([^>]*)>([\s\S]*)<\/nite:root>\s*$/u.exec(text);
  ensure(root, 'Expected one complete NXT root');
  const rootAttributes = attributes(root[1]), recording = recordingId.slice(4);
  ensure(rootAttributes['xmlns:nite'] === 'http://nite.sourceforge.net/'
    && rootAttributes[`${NITE}id`] === `${recording}.${speakerId}.words`, 'NXT root belongs to another recording or speaker');
  const records = [], ids = new Set(), element = /<([\w:-]+)([^<>]*?)(?:\/>|>([^<>]*)<\/\1>)/uy;
  let offset = 0;
  while (root[2].slice(offset).trim()) {
    offset += /^\s*/u.exec(root[2].slice(offset))[0].length;
    element.lastIndex = offset;
    const match = element.exec(root[2]);
    ensure(match && ['w', 'vocalsound', 'gap', 'disfmarker'].includes(match[1]), 'Unsupported or malformed NXT child');
    const attrs = attributes(match[2]), id = attrs[`${NITE}id`];
    ensure(named(id) && id.startsWith(`${recording}.${speakerId}.words`) && !ids.has(id), 'Missing, duplicate or foreign NXT record ID');
    ids.add(id);
    ensure(named(attrs.starttime) && named(attrs.endtime), 'Untimed NXT records require an explicit parser extension');
    const startSample = secondsToSample(attrs.starttime), endSample = secondsToSample(attrs.endtime);
    records.push({ id, speakerId, kind: match[1] === 'w' ? attrs.punc === 'true' ? 'punctuation' : 'word' : match[1],
      text: xmlText(match[3] ?? ''), startSample, endSample, attributes: attrs,
      rangeIssue: endSample < startSample ? 'reversed_upstream_annotation' : null });
    offset = element.lastIndex;
  }
  return records;
}

/** Compare every retained word and attribute, while separately preserving non-word records. */
export function verifyAmiExtraction(upstream, files) {
  ensure(upstream.kind === 'upstream-manual-word-transcription' && upstream.generatedByAsr === false
    && Array.isArray(upstream.words) && upstream.words.length > 0 && files.length === 4, 'Expected original manual AMI extraction');
  ensure(new Set(files.map(file => file.speakerId)).size === 4 && upstream.originalFiles?.length === 4, 'All four original speaker files are required');
  const records = files.flatMap(file => {
    const original = upstream.originalFiles.find(item => basename(item.path.replaceAll('\\', '/')) === file.basename);
    ensure(original && sha256(file.bytes) === original.sha256, 'Original NXT hash does not match the retained extraction');
    return parseAmiNxt(file.bytes, upstream.recordingId, file.speakerId);
  }).sort((a, b) => a.startSample - b.startSample || a.speakerId.localeCompare(b.speakerId) || a.endSample - b.endSample);
  const words = records.filter(item => ['word', 'punctuation'].includes(item.kind));
  ensure(words.length === upstream.words.length, 'Retained AMI extraction omits or adds words');
  for (let i = 0; i < words.length; i++) {
    const raw = words[i], stored = upstream.words[i];
    ensure(raw.id === stored.id && raw.speakerId === stored.speakerId && raw.text === stored.text
      && Math.abs(raw.startSample / 16 - stored.startMs) < 1e-7 && Math.abs(raw.endSample / 16 - stored.endMs) < 1e-7
      && objectHash(raw.attributes) === objectHash(stored.attributes), 'Retained AMI extraction differs from original NXT');
  }
  return { timingLevel: 'word', records, extractionVerified: true,
    textPolicy: 'Original w text, including fillers and repeated words; punctuation remains a separate annotation.',
    unresolvedTextPolicy: false, upstreamAttribution: 'AMI Consortium, manual annotation v1.6.2; individual annotation authors are not invented.' };
}

/** Preserve all original Koniwa levels; a corpus field is not automatically a verbatim oracle. */
export function inspectKoniwa(upstream) {
  ensure(Array.isArray(upstream.annotation), 'Expected Koniwa annotation array');
  const records = upstream.annotation.map((item, index) => {
    ensure(item.data && typeof item.data.text_level0 === 'string' && typeof item.data.text_level2 === 'string', 'Koniwa text levels are missing');
    const startSample = secondsToSample(item.start), endSample = secondsToSample(item.end);
    ensure(startSample < endSample, 'Koniwa utterance has a nonpositive range');
    return { id: `utterance-${index}`, kind: 'utterance', speakerId: null, text: item.data.text_level0,
      startSample, endSample, attributes: structuredClone(item.data),
      alternativeText: item.data.text_level2 || null, annotationLevelNeedsReview: !!item.data.text_level2 };
  });
  ensure(records.every((record, index) => index === 0 || record.startSample >= records[index - 1].startSample), 'Koniwa source order is not monotonic');
  return { timingLevel: 'utterance', records, extractionVerified: true,
    upstreamCompleted: upstream.meta?.status_annotation === 'done',
    textPolicy: 'Original text_level0 retained with text_level2, kana levels and memo; verbatim-level selection is unresolved.',
    unresolvedTextPolicy: true, upstreamAttribution: 'Koniwa upstream annotation contributors; original Amagasaki City text CC BY 4.0, derivative annotation contributions CC0.' };
}

function intersects(record, start, end) {
  // Use an invalid record's outer extent only to route it for review; retain both original times.
  if (record.rangeIssue) return Math.min(record.startSample, record.endSample) < end && Math.max(record.startSample, record.endSample) > start;
  return record.startSample === record.endSample ? record.startSample >= start && record.startSample < end
    : record.startSample < end && record.endSample > start;
}
export function prepareChunkReference(annotation, source, selection, chunk) {
  ensure(source.sampleRate === 16_000 && safe(source.samples) && chunk.requestStartSample >= 0
    && chunk.requestEndSample <= source.samples && chunk.requestStartSample < chunk.requestEndSample, 'Invalid source-clock chunk');
  ensure(annotation.records.every(record => record.startSample >= 0 && record.endSample >= 0
    && Math.max(record.startSample, record.endSample) <= source.samples), 'Upstream annotation escapes its exact recording');
  const records = annotation.records.filter(record => intersects(record, chunk.requestStartSample, chunk.requestEndSample)).map(record => ({ ...record,
    relativeStartSample: record.startSample - chunk.requestStartSample, relativeEndSample: record.endSample - chunk.requestStartSample,
    partialAtRequestStart: record.startSample < chunk.requestStartSample, partialAtRequestEnd: record.endSample > chunk.requestEndSample,
    crossesCoreStart: record.startSample < chunk.coreStartSample && record.endSample > chunk.coreStartSample,
    crossesCoreEnd: record.startSample < chunk.coreEndSample && record.endSample > chunk.coreEndSample }));
  const lexical = records.filter(record => ['word', 'utterance'].includes(record.kind));
  const complete = lexical.filter(record => !record.rangeIssue && record.startSample < record.endSample
    && !record.partialAtRequestStart && !record.partialAtRequestEnd);
  const exactMsAnchors = complete.filter(record => record.relativeStartSample % 16 === 0 && record.relativeEndSample % 16 === 0)
    .map(record => ({ id: record.id, text: record.text, startMs: record.relativeStartSample / 16,
      endMs: record.relativeEndSample / 16, speakerId: record.speakerId }));
  const partial = lexical.filter(record => record.partialAtRequestStart || record.partialAtRequestEnd);
  const pointWords = lexical.filter(record => record.startSample === record.endSample);
  const overlapping = [];
  for (let i = 0; i < lexical.length; i++) {
    for (let j = i + 1; j < lexical.length && lexical[j].startSample < lexical[i].endSample; j++) {
      overlapping.push({ leftId: lexical[i].id, rightId: lexical[j].id, startSample: lexical[j].startSample,
        endSample: Math.min(lexical[i].endSample, lexical[j].endSample), speakersKnownDifferent: lexical[i].speakerId !== null
          && lexical[j].speakerId !== null && lexical[i].speakerId !== lexical[j].speakerId });
    }
  }
  const blockers = [];
  if (!lexical.length) blockers.push('no_lexical_reference_not_verified_silence');
  if (partial.length) blockers.push('partial_annotation_at_request_boundary');
  if (pointWords.length) blockers.push('point_lexical_annotation');
  if (lexical.some(record => record.rangeIssue)) blockers.push('invalid_upstream_lexical_range');
  if (annotation.unresolvedTextPolicy) blockers.push('upstream_verbatim_text_policy_unresolved');
  if (annotation.timingLevel === 'utterance' && !annotation.upstreamCompleted) blockers.push('upstream_annotation_incomplete');
  return { schemaVersion: 1, kind: 'source-bound-upstream-reference-draft', caseId: chunk.id, sourceId: source.id,
    recordingId: source.recordingId, sourceSha256: source.sha256, audioSha256: chunk.audioSha256, selectionId: selection.id,
    profileId: selection.profileId, language: source.language, timingLevel: annotation.timingLevel,
    sampleRate: 16_000, coreStartSample: chunk.coreStartSample, coreEndSample: chunk.coreEndSample,
    requestStartSample: chunk.requestStartSample, requestEndSample: chunk.requestEndSample,
    records, overlaps: overlapping, partialRecordIds: partial.map(record => record.id), pointWordIds: pointWords.map(record => record.id),
    completeLexicalRecordIds: complete.map(record => record.id),
    wordTimestampReference: annotation.timingLevel === 'word' ? exactMsAnchors : [],
    utteranceTimestampReference: annotation.timingLevel === 'utterance' ? exactMsAnchors : [],
    completeReferenceSegments: complete.map(record => ({ id: record.id, text: record.text,
      startSample: record.relativeStartSample, endSample: record.relativeEndSample, speakerId: record.speakerId })),
    timingProjectionExcludedIds: complete.filter(record => record.relativeStartSample % 16 || record.relativeEndSample % 16).map(record => record.id),
    hasCompleteTimingAnchors: exactMsAnchors.length > 0,
    candidateText: lexical.map(record => record.text).join(source.language === 'ja' ? '' : ' '),
    textPolicy: annotation.textPolicy, recognitionReferenceComplete: blockers.length === 0, blockers,
    timestampGroundTruth: 'Upstream annotation coordinates; no new acoustic calibration or word boundaries inferred from utterances.',
    additionalListening: { performed: false, reviewer: null, reviewedAt: null }, acousticQualificationReady: false,
    warning: 'Candidate text contains complete original annotations even when only part intersects the request. Partial text is not guessed or silently included in a scored reference.' };
}

/** Suggest an unfrozen alternative, never alter the selected audio or infer actual silence. */
export function suggestSelectionEdges(annotation, source, selection) {
  if (annotation.timingLevel !== 'word' || annotation.unresolvedTextPolicy) return null;
  const words = annotation.records.filter(record => record.kind === 'word' && !record.rangeIssue && record.startSample < record.endSample);
  const duration = selection.endSample - selection.startSample, original = selection.startSample;
  const inside = sample => words.some(word => word.startSample < sample && word.endSample > sample);
  const candidates = [...new Set([original, ...words.flatMap(word => [word.startSample, word.endSample,
    word.startSample - duration, word.endSample - duration])])].filter(start => start >= 0 && start + duration <= source.samples
      && Math.abs(start - original) <= 5 * 16_000 && !inside(start) && !inside(start + duration))
    .sort((a, b) => Math.abs(a - original) - Math.abs(b - original) || a - b);
  return { sourceId: source.id, selectionId: selection.id, originalStartSample: original, originalEndSample: selection.endSample,
    proposedStartSample: candidates[0] ?? null, proposedEndSample: candidates.length ? candidates[0] + duration : null,
    maximumShiftSamples: 5 * 16_000, applied: false,
    note: 'Original annotation coverage only: not acoustic silence verification. Any selected change requires new Rust chunk planning and immutable inputs; internal request edges may still cut words.' };
}

function hashFile(path) {
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    ensure(before.size <= 1024 * 1024 * 1024, 'Source provenance input exceeds the 1 GiB bound');
    for (let offset = 0; offset < before.size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      ensure(count > 0, 'Source provenance input ended early'); hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = statSync(path);
    ensure(after.size === before.size && after.ino === before.ino && after.mtimeMs === before.mtimeMs, 'Source provenance input changed');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

export function run(args) {
  if (args.includes('--help')) {
    process.stdout.write('Offline upstream reference verification; no network, model, credential or ledger access.\n--plan FROZEN_PILOT.json --sources FROZEN_SOURCES.json --output NEW_DIRECTORY\nCreates source audits and chunk reference drafts exclusively; never modifies inputs or claims listening.\n'); return 0;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(['--plan', '--sources', '--output'].includes(args[i]) && named(args[i + 1]) && !options[args[i]], 'Invalid reference preparation argument');
    options[args[i]] = resolve(args[i + 1]);
  }
  ensure(Object.keys(options).length === 3, 'Plan, sources and new output directory are required');
  const plan = readJson(options['--plan']), materials = readJson(options['--sources']);
  const preparedAt = new Date().toISOString(), preparationToolSha256 = sha256(readBounded(new URL(import.meta.url)));
  validatePreparation(plan.value);
  ensure(Array.isArray(materials.value.sources), 'Source manifest has no sources');
  ensure(new Set(materials.value.sources.map(source => source.id)).size === materials.value.sources.length
    && materials.value.sources.every(source => /^[a-z0-9][a-z0-9._-]{0,100}$/u.test(source.id)), 'Source IDs must be unique safe artifact names');
  ensure(plan.value.sources.every(source => materials.value.sources.some(item => item.id === source.id)), 'Source manifest omits a frozen pilot source');
  const audits = [], drafts = [], missing = [], selectionEdgeCandidates = [];
  for (const source of materials.value.sources) {
    const pilotSource = plan.value.sources.find(item => item.id === source.id);
    if (pilotSource) ensure(source.sha256 === pilotSource.sha256 && source.recordingId === pilotSource.recordingId
      && source.samples === pilotSource.samples && source.original?.sha256 === pilotSource.original?.sha256
      && source.reference?.sha256 === pilotSource.reference?.sha256, 'Pilot source and retained source manifest differ');
    if (!source.reference?.path) { missing.push({ sourceId: source.id, reason: source.referenceMissingReason ?? 'No upstream reference', pilot: !!pilotSource }); continue; }
    const sourcePath = resolve(dirname(options['--sources']), source.path), referencePath = resolve(dirname(options['--sources']), source.reference.path);
    const upstream = readJson(referencePath);
    ensure(upstream.sha256 === source.reference.sha256, 'Upstream reference hash changed');
    ensure(hashPattern.test(source.original?.sha256 ?? '') && hashFile(resolve(dirname(options['--sources']), source.original.path)) === source.original.sha256, 'Original recording bytes differ from retained provenance');
    let annotation, originalAnnotations;
    if (upstream.value.kind === 'upstream-manual-word-transcription') {
      ensure(upstream.value.recordingId === source.recordingId, 'Upstream annotation belongs to another recording');
      const files = upstream.value.originalFiles.map(item => {
        const filename = basename(item.path.replaceAll('\\', '/')), match = /^ami-([A-Z]{2}\d{4}[a-z])\.([A-D])\.words\.xml$/u.exec(filename);
        ensure(match, 'Unexpected original AMI filename');
        return { basename: filename, speakerId: match[2], bytes: readBounded(resolve(dirname(referencePath), item.path), 2 * 1024 * 1024) };
      });
      annotation = verifyAmiExtraction(upstream.value, files);
      originalAnnotations = files.map(file => ({ path: file.basename, sha256: sha256(file.bytes) }));
      ensure(source.original.sha256 === source.sha256, 'AMI recording must be byte-identical to its retained 16 kHz source');
    } else if (source.recordingId.startsWith('Koniwa/') && Array.isArray(upstream.value.annotation)) {
      annotation = inspectKoniwa(upstream.value); originalAnnotations = [{ path: basename(referencePath), sha256: upstream.sha256 }];
    } else { missing.push({ sourceId: source.id, reason: 'Unsupported upstream annotation schema', pilot: !!pilotSource }); continue; }
    const selections = plan.value.selections.filter(selection => selection.sourceId === source.id);
    const chunks = selections.flatMap(selection => selection.chunks.map(chunk => ({ ...chunk,
      resolvedAudioPath: resolve(dirname(options['--plan']), chunk.audioPath) })));
    const measurements = Object.fromEntries(chunks.map(chunk => [chunk.id, measurePcmWav(chunk.resolvedAudioPath)]));
    for (const chunk of chunks) ensure(measurements[chunk.id].sha256 === chunk.audioSha256
      && measurements[chunk.id].samples === chunk.requestEndSample - chunk.requestStartSample, 'Prepared request bytes differ from the frozen plan');
    const sliceVerification = verifySourceSlices(sourcePath, source, chunks, measurements);
    ensure(annotation.records.every(record => Math.max(record.startSample, record.endSample) <= source.samples), 'Annotation exceeds the exact recording length');
    const sourceAudit = { schemaVersion: 1, kind: 'upstream-reference-mechanical-verification', sourceId: source.id,
      recordingId: source.recordingId, sourceSha256: source.sha256, sourceSamples: source.samples, sampleRate: 16_000,
      upstreamReferenceSha256: upstream.sha256, originalAnnotations, originalAudioSha256: source.original.sha256,
      originalAudioByteIdenticalToDecoded: source.original.sha256 === source.sha256,
      decodedClockNote: source.original.sha256 === source.sha256 ? 'Original corpus WAV and decoded source are byte-identical.'
        : 'Decoded source and every request sample are verified. Original compressed-to-PCM conversion is retained provenance, not newly acoustically calibrated.',
      conversionProvenance: source.conversion, attribution: source.attribution, license: source.license,
      upstreamAttribution: annotation.upstreamAttribution, extractionVerified: annotation.extractionVerified,
      upstreamTimingLevel: annotation.timingLevel, records: annotation.records, recordCount: annotation.records.length,
      wordCount: annotation.records.filter(item => item.kind === 'word').length,
      punctuationCount: annotation.records.filter(item => item.kind === 'punctuation').length,
      nonLexicalCount: annotation.records.filter(item => !['word', 'utterance', 'punctuation'].includes(item.kind)).length,
      annotationIssues: annotation.records.filter(item => item.rangeIssue).map(item => ({ id: item.id, kind: item.kind,
        startSample: item.startSample, endSample: item.endSample, reason: item.rangeIssue })),
      sourceSliceVerification: sliceVerification, additionalListening: { performed: false, reviewer: null, reviewedAt: null },
      verifiedAgainstAudio: false, acousticQualificationReady: false, independentOfProviderOutput: true };
    audits.push(sourceAudit);
    for (const selection of selections) {
      const candidate = suggestSelectionEdges(annotation, source, selection);
      if (candidate) selectionEdgeCandidates.push(candidate);
    }
    for (const selection of selections) for (const chunk of selection.chunks) {
      const draft = prepareChunkReference(annotation, source, selection, chunk);
      drafts.push({ ...draft, provenance: { upstreamAnnotationKind: 'human-corpus-annotation', originalAnnotations,
        upstreamReferenceSha256: upstream.sha256, sourceSha256: source.sha256, annotationConversionVerified: true, sourceSamplesVerified: true,
        sourceVerificationSha256: sha256(jsonBytes(sourceAudit)), referenceTextPolicy: annotation.textPolicy,
        independentOfProviderOutput: true, preparationTool: 'surtitle-offline-reference-preparation-v1',
        preparationToolSha256, preparedAt,
        additionalListening: { performed: false, reviewer: null, reviewedAt: null } } });
    }
  }
  const summary = { schemaVersion: 1, kind: 'upstream-reference-preparation-report', generatedAt: preparedAt,
    planFileSha256: plan.sha256, materialManifestSha256: materials.sha256,
    preparationToolSha256, sourceAudits: audits.map(audit => ({ sourceId: audit.sourceId,
      file: `${audit.sourceId}.audit.json`, recordCount: audit.recordCount, wordCount: audit.wordCount, punctuationCount: audit.punctuationCount,
      nonLexicalCount: audit.nonLexicalCount, timingLevel: audit.upstreamTimingLevel, sha256: sha256(jsonBytes(audit)) })),
    chunkReferences: drafts.map((draft, index) => ({ caseId: draft.caseId, file: `chunk-${String(index + 1).padStart(2, '0')}.json`,
      sourceId: draft.sourceId, profileId: draft.profileId, recordCount: draft.records.length, partialRecordIds: draft.partialRecordIds,
      completeLexicalRecordCount: draft.completeLexicalRecordIds.length,
      overlapCount: draft.overlaps.length, recognitionReferenceComplete: draft.recognitionReferenceComplete, blockers: draft.blockers, sha256: sha256(jsonBytes(draft)) })),
    missing, selectionEdgeCandidates, readyRecognitionChunkCount: drafts.filter(draft => draft.recognitionReferenceComplete).length,
    usableWordTimingChunkCount: drafts.filter(draft => draft.wordTimestampReference.length > 0).length,
    usableUtteranceTimingChunkCount: drafts.filter(draft => draft.utteranceTimestampReference.length > 0).length,
    additionalListeningPerformed: false, acousticQualificationReady: false, modelQualified: false, paidRequests: 0, networkRequests: 0,
    frozenInputsUnchanged: true, note: 'Mechanical source and annotation verification is distinct from acoustic listening. Drafts are not automatically inserted into an evaluation or a paid job.' };
  // All input checks finish before exclusively creating any new artifact directory.
  mkdirSync(options['--output']);
  const save = (name, value) => writeFileSync(resolve(options['--output'], name), jsonBytes(value), { flag: 'wx' });
  audits.forEach(audit => save(`${audit.sourceId}.audit.json`, audit));
  drafts.forEach((draft, index) => save(summary.chunkReferences[index].file, draft));
  save('report.json', summary);
  process.stdout.write(`${JSON.stringify({ output: options['--output'], sources: audits.length, chunks: drafts.length,
    readyRecognitionChunks: summary.readyRecognitionChunkCount, acousticQualificationReady: false, paidRequests: 0 })}\n`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Reference preparation failed: ${error.message}\n`); process.exitCode = 1; }
}
