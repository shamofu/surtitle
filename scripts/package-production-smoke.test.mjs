import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseOptions, sanitizedEnvironment, validateSnapshot, validateMetadata, validateSeededProfile, playerDiagnostics, createProductionDiagnostics } from './package-production-smoke.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'node:fs';
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

test('production player diagnostics retain timing and native flags without page, track or error text', () => {
  const secret = 'PRIVATE KEY or user subtitle';
  const state = { positionMs: 1800, durationMs: 12000, paused: true, ready: true, surfaceVisible: false,
    videoWidth: 640, videoHeight: 360, rate: 1, volume: 0, sentencePause: false, error: secret,
    path: secret, pageText: secret, settings: { credentials: secret },
    tracks: [{ id: 1, kind: 'audio', ffIndex: 2, selected: true, external: false, title: secret, language: secret }] };
  assert.deepEqual(playerDiagnostics(state), {
    errorPresent: true, positionMs: 1800, durationMs: 12000, videoWidth: 640, videoHeight: 360, rate: 1, volume: 0,
    ready: true, paused: true, surfaceVisible: false, sentencePause: false,
    tracks: [{ kind: 'audio', id: 1, ffIndex: 2, selected: true, external: false }],
  });
  const invalid = playerDiagnostics({ positionMs: secret, durationMs: Infinity, ready: secret,
    tracks: [{ kind: secret, id: secret, ffIndex: secret, selected: secret }] });
  assert.ok(!JSON.stringify(invalid).includes(secret));
  assert.equal(invalid.tracks[0].kind, 'unknown');
  assert.equal(playerDiagnostics({ tracks: Array.from({ length: 100 }, () => ({})) }).tracks.length, 64);
});

test('production failure evidence is fresh, redacted and cannot replace success evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-production-diagnostics-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const success = join(directory, 'production-smoke.json');
  writeFileSync(success, 'existing success evidence must not be touched');
  const diagnostic = createProductionDiagnostics(directory);
  diagnostic.stage('driver-ready');
  const secret = 'PRIVATE KEY in page, process or exception';
  diagnostic.driver({ pid: 321, exitCode: 23, signalCode: secret, stderr: secret }, Object.assign(new Error(secret), { code: 'ENOENT' }));
  diagnostic.player({ positionMs: 1800, paused: true, error: secret });
  diagnostic.stage('interval-stop');
  diagnostic.captureFailure(Object.assign(new Error(secret), { code: 'ETIMEDOUT' }));
  // Cleanup and later exceptions must not erase the original failure or driver exit.
  diagnostic.driver({ pid: 321, exitCode: null, signalCode: 'SIGTERM' });
  const report = await diagnostic.writeFailure(new Error('cleanup ' + secret));
  const failurePath = join(directory, 'production-smoke-failure.json');
  const written = readFileSync(failurePath, 'utf8');
  assert.deepEqual(JSON.parse(written), report);
  assert.equal(report.kind, 'production-smoke-failure');
  assert.equal(report.passed, false);
  assert.equal(report.stage, 'interval-stop');
  assert.deepEqual(report.error, { category: 'Error', code: 'ETIMEDOUT' });
  assert.equal(report.driver.exitCode, 23);
  assert.equal(report.driver.signal, null);
  assert.deepEqual(report.driver.launchError, { category: 'Error', code: 'ENOENT' });
  assert.deepEqual(report.completedStages.map(value => value.stage), ['arguments', 'driver-ready']);
  assert.ok(Number.isInteger(report.elapsedMs) && report.elapsedMs >= report.stageElapsedMs);
  assert.ok(report.completedStages.every(value => Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0));
  assert.ok(!written.includes(secret));
  assert.equal(Object.hasOwn(report, 'normalBuild'), false);
  assert.equal(readFileSync(success, 'utf8'), 'existing success evidence must not be touched');
  await assert.rejects(diagnostic.writeFailure(new Error('replacement')), { code: 'EEXIST' });
  assert.equal(readFileSync(failurePath, 'utf8'), written);
  assert.throws(() => diagnostic.stage(secret), /Unknown production diagnostic stage/);
});

test('unknown production exception names and codes never enter failure evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-production-unknown-error-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const report = await createProductionDiagnostics(directory).writeFailure({
    name: 'credential text', code: 'private endpoint', message: 'page body', stack: 'private stack', cause: 'nested credential',
  });
  assert.deepEqual(report.error, { category: 'UnknownError', code: null });
  assert.equal(report.lastPlayerState, null);
  assert.equal(report.driver, null);
  assert.equal(report.passed, false);
});

test('production CLI records a failed argument stage and exits nonzero without launching an app', { timeout: 10_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-production-cli-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['package-production-smoke.mjs', 'webdriver-process.mjs']) {
    cpSync(new URL(name, import.meta.url), join(root, 'scripts', name));
  }
  const secret = 'private-page-content';
  const result = spawnSync(process.execPath, [join(root, 'scripts/package-production-smoke.mjs'), '--' + secret],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const report = readFileSync(join(root, 'artifacts/production-smoke-failure.json'), 'utf8');
  assert.equal(JSON.parse(report).stage, 'arguments');
  assert.equal(JSON.parse(report).passed, false);
  assert.equal(JSON.parse(report).error.code, 'ERR_PRODUCTION_CHECK');
  assert.ok(![report, result.stdout, result.stderr].some(text => text.includes(secret)));
  assert.equal(existsSync(join(root, 'artifacts/production-smoke.json')), false);
});
