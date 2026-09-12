// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function timestamp(ms, separator) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

export function exportSubtitles(report, jobId, format = 'srt', offsetMs = 0) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.requests) || !['srt', 'vtt'].includes(format)
      || !Number.isSafeInteger(offsetMs) || offsetMs < 0) throw new Error('Invalid report, subtitle format, or offset');
  const matches = report.requests.filter(request => request.id === jobId);
  if (matches.length !== 1) throw new Error('Select exactly one saved job ID');
  const request = matches[0];
  let cues;
  if (request.output?.kind === 'transcript') {
    cues = request.output.cues;
  } else if (request.output?.kind === 'translation') {
    const source = request.sourceCues;
    const translations = request.output.translations;
    if (!Array.isArray(source) || !Array.isArray(translations) || source.length !== translations.length
        || new Set(source.map(cue => cue.id)).size !== source.length
        || new Set(translations.map(cue => cue.id)).size !== translations.length) throw new Error('Translation source IDs must match exactly once');
    const byId = new Map(translations.map(cue => [cue.id, cue.translation]));
    cues = source.map(cue => ({ startMs: cue.start_ms, endMs: cue.end_ms, text: byId.get(cue.id) }));
  } else throw new Error('This job has no saved transcript or translation');
  if (!Array.isArray(cues) || cues.length > 20_000) throw new Error('Invalid subtitle count');
  let previous = -1;
  const rendered = cues.map((cue, index) => {
    const start = cue.startMs + offsetMs, end = cue.endMs + offsetMs;
    if (![cue.startMs, cue.endMs, start, end].every(Number.isSafeInteger) || cue.startMs < 0
        || start < previous || end <= start || typeof cue.text !== 'string' || !cue.text.trim()
        || cue.text.includes('\0') || cue.text.length > 65_536) throw new Error('Saved subtitle text or timestamp is invalid');
    previous = start;
    const text = cue.text.replace(/\r\n?/g, '\n').trim();
    // Empty lines would prematurely terminate a subtitle cue in both formats.
    if (/\n\s*\n/.test(text)) throw new Error('Subtitle text contains an empty cue separator');
    const separator = format === 'srt' ? ',' : '.';
    return `${index + 1}\n${timestamp(start, separator)} --> ${timestamp(end, separator)}\n${text}\n`;
  });
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + rendered.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = new Map();
  if (args.length % 2) throw new Error('Use --report FILE --job-id ID --output FILE [--format srt|vtt] [--offset-ms N]');
  for (let index = 0; index < args.length; index += 2) {
    if (!['--report', '--job-id', '--output', '--format', '--offset-ms'].includes(args[index]) || options.has(args[index])) throw new Error('Unknown or duplicate option');
    options.set(args[index], args[index + 1]);
  }
  for (const required of ['--report', '--job-id', '--output']) if (!options.get(required)) throw new Error(`Missing ${required}`);
  if (statSync(options.get('--report')).size > 16 * 1024 * 1024) throw new Error('Report exceeds the 16 MiB export limit');
  const report = JSON.parse(readFileSync(options.get('--report'), 'utf8'));
  const result = exportSubtitles(report, options.get('--job-id'), options.get('--format') || 'srt', Number(options.get('--offset-ms') || '0'));
  writeFileSync(options.get('--output'), result, { encoding: 'utf8', flag: 'wx' });
  console.log('Saved subtitles locally. No API request was sent.');
}
