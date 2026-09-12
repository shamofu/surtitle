// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, statSync, mkdirSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './evaluation.mjs';
import { validatePreparation, evaluateTranscribeProduction } from './transcribe-policy.mjs';

function readJson(path) {
  if (statSync(path).size > 16 * 1024 * 1024) throw new Error('JSON input exceeds the 16 MiB evaluation bound');
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}
export function measurePcmWav(path) {
  if (statSync(path).size > 12 * 1024 * 1024) throw new Error('Prepared audio exceeds the 12 MiB request bound');
  const bytes = readFileSync(path);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Expected a complete bounded RIFF WAV');
  let format = null, samples = null, dataOffset = null, offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (end > bytes.length) throw new Error('Truncated WAV chunk');
    if (kind === 'fmt ') {
      if (format || size < 16 || bytes.readUInt16LE(start) !== 1) throw new Error('Expected one PCM format chunk');
      format = { channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bitsPerSample: bytes.readUInt16LE(start + 14) };
      if (format.channels !== 1 || format.sampleRate !== 16_000 || format.bitsPerSample !== 16
        || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt32LE(start + 8) !== 32_000) throw new Error('Expected mono 16 kHz PCM16');
    }
    if (kind === 'data') {
      if (samples !== null || size === 0 || size % 2) throw new Error('Expected one complete PCM16 data chunk');
      samples = size / 2;
      dataOffset = start;
    }
    offset = end + (size % 2);
  }
  if (!format || samples === null || offset !== bytes.length || samples > 240 * 16_000) throw new Error('Incomplete or oversized PCM WAV');
  return { ...format, samples, dataOffset, sha256: sha256(bytes) };
}

/** Read large source WAVs in bounded buffers; verify every requested PCM sample. */
export function verifySourceSlices(sourcePath, source, chunks, requestMeasurements) {
  const fd = openSync(sourcePath, 'r');
  try {
    const identity = fstatSync(fd), length = identity.size;
    if (length > 21600 * 32_000 + 1024 * 1024) throw new Error('Decoded source exceeds the six-hour preparation bound');
    const readAt = (length, offset) => { const buffer = Buffer.alloc(length); if (readSync(fd, buffer, 0, length, offset) !== length) throw new Error('Source WAV ended early'); return buffer; };
    const header = readAt(12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE'
      || header.readUInt32LE(4) + 8 !== length) throw new Error('Source must be a complete RIFF WAV');
    let offset = 12, format = false, dataOffset = null, samples = null;
    while (offset + 8 <= length) {
      const chunk = readAt(8, offset), kind = chunk.toString('ascii', 0, 4), size = chunk.readUInt32LE(4);
      const start = offset + 8, end = start + size;
      if (end > length) throw new Error('Truncated source WAV');
      if (kind === 'fmt ') {
        if (format || size < 16) throw new Error('Expected one source PCM format');
        const fmt = readAt(16, start);
        if (!fmt.equals(Buffer.from([1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0]))) throw new Error('Source must be mono 16 kHz PCM16');
        format = true;
      }
      if (kind === 'data') {
        if (dataOffset !== null || !size || size % 2) throw new Error('Expected one complete source PCM data chunk');
        dataOffset = start; samples = size / 2;
      }
      offset = end + size % 2;
    }
    if (!format || dataOffset === null || offset !== length || samples !== source.samples) throw new Error('Source sample metadata differs from actual WAV');
    const fullHash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < length;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - position), position);
      if (!count) throw new Error('Source changed while hashing');
      fullHash.update(buffer.subarray(0, count)); position += count;
    }
    if (fullHash.digest('hex') !== source.sha256) throw new Error('Decoded source hash differs from the frozen manifest');
    for (const chunk of chunks) {
      const measurement = requestMeasurements[chunk.id], request = readFileSync(chunk.resolvedAudioPath);
      if (sha256(request) !== chunk.audioSha256) throw new Error('Request changed during source verification');
      const expected = request.subarray(measurement.dataOffset, measurement.dataOffset + measurement.samples * 2);
      for (let position = 0; position < expected.length; position += buffer.length) {
        const count = Math.min(buffer.length, expected.length - position);
        if (readSync(fd, buffer, 0, count, dataOffset + chunk.requestStartSample * 2 + position) !== count
          || !buffer.subarray(0, count).equals(expected.subarray(position, position + count))) throw new Error('Request PCM does not match its declared source-clock slice');
      }
    }
    // A final streamed hash detects a source replacement during slice comparisons.
    const finalHash = createHash('sha256');
    for (let position = 0; position < length;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - position), position);
      if (!count) throw new Error('Source changed during slice verification');
      finalHash.update(buffer.subarray(0, count)); position += count;
    }
    const current = statSync(sourcePath);
    if (finalHash.digest('hex') !== source.sha256 || fstatSync(fd).size !== length
      || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== length) throw new Error('Source changed during slice verification');
    return { sourceSha256: source.sha256, samples, verifiedRequestIds: chunks.map(c => c.id) };
  } finally { closeSync(fd); }
}

export function run(args) {
  if (args.includes('--help')) {
    process.stdout.write('Offline Transcribe production evaluation; no network, credentials or ledger writes.\nprepare --manifest PLAN.json --output VERIFIED.json\nevaluate --manifest REFERENCES.json --results PROVIDER.json --rubric RUBRIC.json --review ASSISTED_REVIEW.json --output REPORT.json\nPaths in preparation manifests resolve relative to that manifest. Existing outputs are never overwritten. Exit 2 preserves incomplete/failed evidence; a successful preparation is not authorization.\n');
    return 0;
  }
  const [command, ...rest] = args, options = {};
  if (!['prepare', 'evaluate'].includes(command)) throw new Error('Choose prepare or evaluate');
  const allowed = command === 'prepare' ? ['--manifest', '--output'] : ['--manifest', '--results', '--rubric', '--review', '--output'];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || options[rest[i]]) throw new Error(`Invalid argument: ${rest[i]}`);
    options[rest[i]] = resolve(rest[i + 1]);
  }
  if (!allowed.every(key => options[key]) || new Set(Object.values(options)).size !== allowed.length) throw new Error('All required input/output paths must be present and distinct');
  const manifest = readJson(options['--manifest']);
  let report;
  if (command === 'prepare') {
    // Structural validation precedes file access and never dispatches a process.
    validatePreparation(manifest.value);
    const selections = manifest.value.selections;
    const resolvedChunks = selections.flatMap(s => s.chunks.map(c => ({ ...c, sourceId: s.sourceId, resolvedAudioPath: resolve(dirname(options['--manifest']), c.audioPath) })));
    const measurements = Object.fromEntries(resolvedChunks.map(c => [c.id, measurePcmWav(c.resolvedAudioPath)]));
    const sourceVerification = manifest.value.sources.filter(s => resolvedChunks.some(c => c.sourceId === s.id)).map(source => {
      if (typeof source.path !== 'string' || !source.path.trim()) throw new Error('Actual decoded source path is required for slice verification');
      return { sourceId: source.id, ...verifySourceSlices(resolve(dirname(options['--manifest']), source.path), source,
        resolvedChunks.filter(c => c.sourceId === source.id), measurements) };
    });
    const referenceFiles = [];
    for (const source of manifest.value.sources) {
      if (!source.reference?.path) continue;
      const path = resolve(dirname(options['--manifest']), source.reference.path);
      if (statSync(path).size > 16 * 1024 * 1024 || sha256(readFileSync(path)) !== source.reference.sha256) throw new Error('Reference file bytes differ from the frozen hash');
      referenceFiles.push({ sourceId: source.id, sha256: source.reference.sha256 });
    }
    report = { ...validatePreparation(manifest.value, measurements), manifestFileSha256: manifest.sha256, referenceFiles, sourceVerification };
  } else {
    const results = readJson(options['--results']), rubric = readJson(options['--rubric']), review = readJson(options['--review']);
    report = evaluateTranscribeProduction(manifest.value, results.value, rubric.value, review.value,
      { referencesSha256: manifest.sha256, resultsSha256: results.sha256, rubricSha256: rubric.sha256, assistedReviewSha256: review.sha256 });
  }
  mkdirSync(dirname(options['--output']), { recursive: true });
  writeFileSync(options['--output'], `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ command, output: options['--output'], readyForQuotePreparation: report.readyForQuotePreparation ?? false, gatesPassed: report.gatesPassed ?? false, modelQualified: false })}\n`);
  return command === 'prepare' ? report.readyForQuotePreparation ? 0 : 2 : report.gatesPassed ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Transcribe evaluation failed: ${error.message}\n`); process.exitCode = 1; }
}
