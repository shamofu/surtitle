// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, writePcm } from './generate-surrogate.mjs';
import { sha256 } from './evaluation.mjs';

test('PCM fixtures have exact sample counts, deterministic hashes and explicit non-speech provenance', t => {
  const temp = mkdtempSync(join(tmpdir(), 'surtitle-pcm-'));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const first = generate(join(temp, 'one'), 7), second = generate(join(temp, 'two'), 7);
  assert.deepEqual(first.files.map(file => file.sha256), second.files.map(file => file.sha256));
  assert.equal(first.files[1].samples, 16007);
  for (const file of first.files) {
    const bytes = readFileSync(file.path);
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
    assert.equal(bytes.readUInt32LE(24), 16000); assert.equal(bytes.readUInt16LE(22), 1); assert.equal(bytes.readUInt16LE(34), 16);
    assert.equal(bytes.readUInt32LE(40), file.samples * 2); assert.equal(bytes.length, file.byteLength); assert.equal(sha256(bytes), file.sha256);
    if (file.classification === 'silence') assert.ok(bytes.subarray(44).every(byte => byte === 0));
  }
  const surrogate = readFileSync(first.files[2].path);
  assert.ok(surrogate.subarray(44, 44 + 16000 * 2).some(byte => byte !== 0));
  assert.ok(surrogate.subarray(44 + 4 * 16000 * 2, 44 + 6 * 16000 * 2).every(byte => byte === 0));
  assert.equal(first.evidenceKind, 'deterministic-non-speech-surrogate');
  const template = JSON.parse(readFileSync(join(temp, 'one', 'user-speech-manifest.template.json')));
  assert.equal(template.cases[0].audio.evaluationUsePermitted, false); assert.equal(template.cases[0].evidenceKind, 'unreviewed-user-template');
  assert.throws(() => generate(join(temp, 'one'), 7), /EEXIST/);
});

test('invalid generation limits fail before files are created', t => {
  const temp = mkdtempSync(join(tmpdir(), 'surtitle-pcm-limits-'));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const path = join(temp, 'invalid.wav');
  for (const samples of [0, -1, .5, NaN, 21600 * 16000 + 1]) assert.throws(() => writePcm(path, samples), /Invalid bounded/);
  assert.equal(existsSync(path), false);
  assert.throws(() => generate(join(temp, 'unused'), 21601), /Duration/);
  assert.equal(existsSync(join(temp, 'unused')), false);
});
