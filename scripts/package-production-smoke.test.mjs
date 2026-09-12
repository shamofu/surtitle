import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseOptions, sanitizedEnvironment, validateSnapshot, validateMetadata, validateSeededProfile } from './package-production-smoke.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = { mediaId: 'fixture-media', cardId: 'fixture-card', mediaPath: 'C:\\fixture\\日本語 & sample.mp4', segmentCount: 20000 };
function snapshot() {
  return {
    settings: { credentialConfigured: false, dailyBudgetUsd: 0, aiModels: {} },
    budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0, unpricedAttempts: 0, monetaryTotalsComplete: true, unknownAttempts: [] },
    jobs: [], media: [{ id: fixture.mediaId, path: fixture.mediaPath, segmentCount: 20000 }], cards: [{ id: fixture.cardId }],
    tools: ['ffmpeg', 'yt-dlp', 'deno', 'vad'].map(id => ({ id, status: 'missing', provider: 'managed', path: null, version: id === 'vad' ? '6.2' : null })),
  };
}
test('requires explicit application identity and refuses duplicate/unknown probe switches', () => {
  const args = ['--application', 'app.exe', '--data-root', 'data', '--fixture', 'sample.mp4', '--driver', 'driver.exe',
    '--native-driver', 'edge.exe', '--output', 'report.json', '--expected-application-sha256', 'a'.repeat(64)];
  assert.equal(parseOptions(args)['expected-application-sha256'], 'a'.repeat(64));
  assert.throws(() => parseOptions(args.slice(0, -2)), /expected-application-sha256/);
  assert.throws(() => parseOptions([...args, '--application', 'other.exe']), /duplicate/);
  assert.throws(() => parseOptions([...args, '--skip-playback']), /Unknown/);
});
test('refuses inherited credentials, approved budgets and every nonzero/unknown accounting condition', () => {
  assert.equal(validateSnapshot(snapshot(), fixture).savedModelPreferenceCount, 0);
  for (const change of [
    value => { value.settings.credentialConfigured = true; },
    value => { value.settings.dailyBudgetUsd = 1; },
    value => { value.settings.aiModels.translation = { modelId: 'a-user-model' }; },
    value => { value.jobs.push({ status: 'completed' }); },
    value => { value.budget.spentUsd = 0.000001; },
    value => { value.budget.reservedUsd = 0.1; },
    value => { value.budget.limitUsd = 1; },
    value => { value.budget.unknownAttempts.push({ id: 'unknown' }); },
    value => { value.budget.unpricedAttempts = 1; },
    value => { value.budget.monetaryTotalsComplete = false; },
  ]) {
    const value = snapshot(); change(value);
    assert.throws(() => validateSnapshot(value, fixture), /credentials|budget|model preferences|AI job/);
  }
});
test('requires exact disposable media/card identity and no adopted or installed tools', () => {
  for (const change of [
    value => { value.media[0].path = 'C:\\users\\private.mp4'; },
    value => { value.cards[0].id = 'existing-card'; },
    value => { value.media[0].segmentCount = 0; },
    value => { value.tools[0].status = 'ready'; },
    value => { value.tools[0].provider = 'external'; },
    value => { value.tools[0].path = 'C:\\ffmpeg.exe'; },
  ]) {
    const value = snapshot(); change(value);
    assert.throws(() => validateSnapshot(value, fixture), /disposable database|external tool/);
  }
});
test('process liveness or synthetic six-hour metadata cannot satisfy production readiness', () => {
  const state = { ready: true, error: null, surfaceVisible: true, videoWidth: 640, videoHeight: 360,
    durationMs: 12000, tracks: [{ kind: 'video' }, { kind: 'audio' }] };
  assert.equal(validateMetadata(state).durationMs, 12000);
  for (const change of [{ ready: false }, { error: 'load failed' }, { surfaceVisible: false }, { videoWidth: 0 },
    { videoHeight: 0 }, { durationMs: 21600000 }, { tracks: [{ kind: 'video' }] }]) {
    assert.throws(() => validateMetadata({ ...state, ...change }), /did not decode/);
  }
});
test('production driver removes fixture overrides, inherited browser options and credential hints without changing parent environment', () => {
  const environment = { PATH: 'normal', LOCALAPPDATA: 'C:\\disposable', SURTITLE_E2E_DATA_DIR: 'C:\\private',
    SURTITLE_E2E_AI_RECOVERY: 'translation', GOOGLE_APPLICATION_CREDENTIALS: 'key.json', WEBVIEW2_USER_DATA_FOLDER: 'old-browser',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--disable-web-security' };
  assert.deepEqual(sanitizedEnvironment(environment), { PATH: 'normal', LOCALAPPDATA: 'C:\\disposable' });
  assert.equal(environment.GOOGLE_APPLICATION_CREDENTIALS, 'key.json');
});
test('fresh profile guard rejects prior app/credential state before any application is launched', t => {
  const parent = mkdtempSync(join(tmpdir(), 'surtitle production guard 日本語 & ')), root = join(parent, 'local'), roaming = join(parent, 'roaming');
  t.onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(root); writeFileSync(join(root, 'learning.sqlite'), 'stand-in: no SQLite is opened by the guard');
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(fixture));
  assert.deepEqual(validateSeededProfile(root, roaming), fixture);
  assert.deepEqual(validateSeededProfile(toNamespacedPath(root), roaming), fixture);
  for (const name of ['preferences.json', 'charges.sqlite', 'credentials', 'instance.lock']) {
    writeFileSync(join(root, name), 'existing state');
    assert.throws(() => validateSeededProfile(root, roaming), /newly seeded profile/);
    rmSync(join(root, name));
  }
  mkdirSync(roaming);
  assert.throws(() => validateSeededProfile(root, roaming), /roaming application profile/);
});
