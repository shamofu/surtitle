// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSubtitles } from './export-subtitles.mjs';
const report = { schemaVersion: 1, requests: [{ id: 'audio', output: { kind: 'transcript', cues: [
  { startMs: 125, endMs: 950, text: 'No, no.' }, { startMs: 1250, endMs: 1950, text: 'No, no.' },
] } }] };

test('exports every repeated cue and shifts exact millisecond timestamps', () => {
  const srt = exportSubtitles(report, 'audio', 'srt', 18_000_000);
  assert(srt.includes('05:00:00,125 --> 05:00:00,950'));
  assert(srt.includes('05:00:01,250 --> 05:00:01,950'));
  assert.equal(srt.match(/No, no\./g).length, 2);
});
test('exports VTT and valid empty silence without invented speech', () => {
  assert(exportSubtitles(report, 'audio', 'vtt').startsWith('WEBVTT\n\n1\n00:00:00.125'));
  const silence = { schemaVersion: 1, requests: [{ id: 'silence', output: { kind: 'transcript', cues: [] } }] };
  assert.equal(exportSubtitles(silence, 'silence', 'vtt'), 'WEBVTT\n\n');
});
test('maps reordered translations onto source times and rejects fabricated IDs', () => {
  const value = { schemaVersion: 1, requests: [{ id: 'text', sourceCues: [{ id: 'a', start_ms: 0, end_ms: 500 }, { id: 'b', start_ms: 500, end_ms: 1000 }], output: { kind: 'translation', translations: [{ id: 'b', translation: '明日。' }, { id: 'a', translation: 'こんにちは。' }] } }] };
  assert(exportSubtitles(value, 'text').indexOf('こんにちは。') < exportSubtitles(value, 'text').indexOf('明日。'));
  value.requests[0].output.translations[0].id = 'invented';
  assert.throws(() => exportSubtitles(value, 'text'), /invalid/);
});
test('refuses invalid or ambiguous saved output instead of repairing silently', () => {
  for (const change of [cue => cue.endMs = cue.startMs, cue => cue.startMs = -1, cue => cue.text = 'a\n\nb']) {
    const value = structuredClone(report); change(value.requests[0].output.cues[0]);
    assert.throws(() => exportSubtitles(value, 'audio'), /invalid|separator/);
  }
  assert.throws(() => exportSubtitles(report, 'missing'), /exactly one/);
  assert.throws(() => exportSubtitles(report, 'audio', 'srt', Number.MAX_SAFE_INTEGER), /invalid/);
});
