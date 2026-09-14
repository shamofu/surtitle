// SPDX-License-Identifier: GPL-3.0-or-later
// Production-only WebDriver probe. The installer caller owns disposable-profile seeding.
import { execFileSync } from 'node:child_process';
import { spawnWebDriver } from './webdriver-process.mjs';
import { createConnection, createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appId = 'app.surtitle.desktop';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const requireCheck = (value, message) => { if (!value) throw Object.assign(new Error(message), { code: 'ERR_PRODUCTION_CHECK' }); };
const wait = ms => new Promise(done => setTimeout(done, ms));

const diagnosticStages = new Set(['arguments', 'profile', 'fixture', 'application', 'native-files', 'driver-files',
  'driver-start', 'driver-ready', 'session', 'app-ready', 'initial-snapshot', 'settings', 'media-load', 'metadata',
  'playback-start', 'playback-advancing', 'interval-stop', 'seek', 'final-snapshot', 'payload-recheck', 'session-close', 'success-write', 'complete']);
const diagnosticCodes = new Set(['ERR_PRODUCTION_CHECK', 'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EADDRINUSE',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_ASSERTION']);
function classifiedFailure(error) {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'WebDriverError', 'TimeoutError', 'WaitUntilTimeoutError']);
  return { category: names.has(error?.name) ? error.name : 'UnknownError', code: diagnosticCodes.has(error?.code) ? error.code : null };
}
export function playerDiagnostics(state) {
  const result = { errorPresent: state?.error != null };
  for (const key of ['positionMs', 'durationMs', 'videoWidth', 'videoHeight', 'rate', 'volume']) {
    if (typeof state?.[key] === 'number' && Number.isFinite(state[key])) result[key] = state[key];
  }
  for (const key of ['ready', 'paused', 'surfaceVisible', 'sentencePause']) {
    if (typeof state?.[key] === 'boolean') result[key] = state[key];
  }
  if (Array.isArray(state?.tracks)) result.tracks = state.tracks.slice(0, 64).map(track => ({
    kind: ['video', 'audio', 'sub'].includes(track?.kind) ? track.kind : 'unknown',
    id: Number.isSafeInteger(track?.id) ? track.id : null,
    ffIndex: Number.isSafeInteger(track?.ffIndex) ? track.ffIndex : null,
    selected: track?.selected === true, external: track?.external === true,
  }));
  return result;
}
export function createProductionDiagnostics(directory = join(workspace, 'artifacts')) {
  const started = performance.now();
  let stage = 'arguments', stageStarted = started, lastPlayerState = null, driver = null, failure = null;
  const completedStages = [];
  function captureFailure(error) {
    if (failure) return;
    const now = performance.now();
    failure = { schemaVersion: 1, kind: 'production-smoke-failure', passed: false,
      sha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
      stage, elapsedMs: Math.round(now - started), stageElapsedMs: Math.round(now - stageStarted), completedStages: [...completedStages],
      error: classifiedFailure(error), lastPlayerState, driver };
  }
  return {
    stage(next) {
      requireCheck(diagnosticStages.has(next), 'Unknown production diagnostic stage');
      const now = performance.now();
      if (next !== stage) completedStages.push({ stage, elapsedMs: Math.round(now - stageStarted) });
      stage = next; stageStarted = now;
      console.log(`[production-smoke] stage=${stage} elapsedMs=${Math.round(now - started)}`);
    },
    player(state) { lastPlayerState = playerDiagnostics(state); },
    driver(process, error) {
      driver = { pid: Number.isSafeInteger(process?.pid) ? process.pid : null,
        exitCode: Number.isSafeInteger(process?.exitCode) ? process.exitCode : null,
        signal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT'].includes(process?.signalCode) ? process.signalCode : null,
        launchError: error ? classifiedFailure(error) : null };
    },
    captureFailure,
    async writeFailure(error) {
      captureFailure(error);
      await mkdir(directory, { recursive: true });
      plainPath(resolve(directory), false);
      await writeFile(join(directory, 'production-smoke-failure.json'), JSON.stringify(failure, null, 2) + '\n', { flag: 'wx' });
      return failure;
    },
  };
}

export function parseOptions(argv) {
  const options = {};
  const names = new Set(['application', 'data-root', 'fixture', 'driver', 'native-driver', 'output', 'expected-application-sha256']);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index].replace(/^--/, '');
    requireCheck(argv[index].startsWith('--') && (names.has(key) || key === 'disposable-profile') && !(key in options), 'Unknown or duplicate production probe argument');
    options[key] = key === 'disposable-profile' ? true : argv[++index];
  }
  for (const name of names) requireCheck(typeof options[name] === 'string' && options[name].length > 0, `Missing --${name}`);
  requireCheck(/^[a-f0-9]{64}$/.test(options['expected-application-sha256']), 'Expected production executable SHA-256 is required');
  return options;
}

function plainPath(path, file) {
  requireCheck(isAbsolute(path), 'Probe paths must be absolute');
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = relative(current, absolute).split(/[\\/]/).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = lstatSync(current);
    requireCheck(!stat.isSymbolicLink() && (index === parts.length - 1 && file ? stat.isFile() : stat.isDirectory()), 'Probe paths must not traverse symlinks or non-regular files');
  }
  return realpathSync.native(absolute);
}

export function validateSeededProfile(rootPath, roaming) {
  const root = plainPath(rootPath, false);
  requireCheck(!roaming || resolve(roaming).toLowerCase() === root.toLowerCase() || !existsSync(roaming), 'An existing roaming application profile is protected');
  const allowed = new Set(['learning.sqlite', 'learning.sqlite-wal', 'learning.sqlite-shm', 'fixture.json']);
  requireCheck(readdirSync(root).every(name => allowed.has(name)), 'Production probe requires a newly seeded profile with no credentials, preferences or previous execution state');
  plainPath(join(root, 'learning.sqlite'), true);
  return readJson(plainPath(join(root, 'fixture.json'), true));
}

export function validateSnapshot(snapshot, fixture) {
  requireCheck(snapshot?.settings?.credentialConfigured === false && snapshot.settings.dailyBudgetUsd === 0,
    'Disposable application unexpectedly contains credentials or an enabled budget');
  const models = snapshot.settings.aiModels;
  requireCheck(models && typeof models === 'object' && !Array.isArray(models) && Object.keys(models).length === 0, 'Fresh production model preferences must all be unset');
  const budget = snapshot.budget;
  requireCheck(Array.isArray(snapshot.jobs) && snapshot.jobs.length === 0 && budget?.spentUsd === 0 && budget.reservedUsd === 0 && budget.limitUsd === 0
    && budget.unpricedAttempts === 0 && budget.monetaryTotalsComplete === true && Array.isArray(budget.unknownAttempts) && budget.unknownAttempts.length === 0,
  'Production probe must not create or inherit any AI job, cost, hold or unpriced attempt');
  requireCheck(Array.isArray(snapshot.media) && snapshot.media.length === 1 && snapshot.media[0].id === fixture.mediaId
    && snapshot.media[0].path === fixture.mediaPath && snapshot.media[0].segmentCount === fixture.segmentCount
    && Array.isArray(snapshot.cards) && snapshot.cards.length === 1 && snapshot.cards[0].id === fixture.cardId,
  'The production application did not open the explicitly seeded disposable database');
  requireCheck(Array.isArray(snapshot.tools) && snapshot.tools.length === 4
    && snapshot.tools.every(tool => tool.status === 'missing' && tool.provider === 'managed' && tool.path == null), 'Production playback unexpectedly acquired an external tool');
  return { mediaCount: snapshot.media.length, cardCount: snapshot.cards.length, subtitleCount: snapshot.media[0].segmentCount,
    credentialConfigured: false, savedModelPreferenceCount: 0, budget };
}

export function validateMetadata(state) {
  requireCheck(state?.ready === true && state.error == null && state.surfaceVisible === true && state.videoWidth === 640 && state.videoHeight === 360
    && state.durationMs >= 11500 && state.durationMs <= 12500 && state.tracks?.some(track => track.kind === 'audio'),
  'Installed production libmpv did not decode the 12-second 640x360 fixture with a visible surface and audio metadata');
  return state;
}

export function sanitizedEnvironment(environment) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.startsWith('SURTITLE_E2E_') || key.startsWith('WEBVIEW2_') || key === 'GOOGLE_APPLICATION_CREDENTIALS') delete result[key];
  }
  return result;
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function ready(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    const finish = value => { socket.destroy(); done(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}

function knownProfilePaths() {
  // Tauri uses Windows known folders. Environment-only paths cannot authorize a
  // substitute directory while the production app opens the real user profile.
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @{local=[Environment]::GetFolderPath('LocalApplicationData'); roaming=[Environment]::GetFolderPath('ApplicationData')} | ConvertTo-Json -Compress";
  const result = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 }));
  requireCheck(typeof result.local === 'string' && isAbsolute(result.local) && typeof result.roaming === 'string' && isAbsolute(result.roaming), 'Cannot identify the real Windows application profile');
  return result;
}

export async function runProductionProbe(options, diagnostics = createProductionDiagnostics()) {
  diagnostics.stage('profile');
  requireCheck(process.platform === 'win32', 'Installed production smoke requires Windows');
  requireCheck(process.env.CI === 'true' || options['disposable-profile'] === true, 'Use an isolated CI runner or explicitly disposable Windows profile');
  const profile = knownProfilePaths();
  const expectedRoot = resolve(profile.local, appId);
  requireCheck(resolve(options['data-root']).toLowerCase() === expectedRoot.toLowerCase(), 'Production probe cannot override the real local application data directory');
  const root = plainPath(options['data-root'], false);
  const roaming = resolve(profile.roaming, appId);
  const fixture = validateSeededProfile(root, roaming);
  diagnostics.stage('fixture');
  const mediaPath = plainPath(options.fixture, true);
  const fixtureSha256 = hash(mediaPath);
  requireCheck(fixture.mediaId === 'fixture-media' && fixture.cardId === 'fixture-card' && fixture.segmentCount === 20000
    && plainPath(fixture.mediaPath, true) === mediaPath, 'Fixture receipt does not identify the prepared local media and database');
  diagnostics.stage('application');
  const application = plainPath(options.application, true);
  requireCheck(hash(application) === options['expected-application-sha256'], 'Installed application differs from the production build');
  const relativeApp = relative(workspace, application);
  requireCheck(!relativeApp.startsWith('..') && !isAbsolute(relativeApp), 'Installed probe binary must remain inside the guarded workspace install directory');
  const output = resolve(options.output);
  requireCheck(!existsSync(output), 'Production evidence must be written to a fresh file');
  diagnostics.stage('native-files');
  const manifest = readJson(join(workspace, 'native/runtime-windows-x64.json'));
  const effectiveManifestSha256 = hash(join(workspace, 'native/runtime-windows-x64.json'));
  const nativeFiles = manifest.components.flatMap(component => component.runtimeFiles).map(file => {
    requireCheck(file.target && file.target === file.target.split(/[\\/]/).pop(), 'Invalid native runtime filename');
    const path = plainPath(join(dirname(application), 'native', file.target), true);
    const sha256 = hash(path);
    requireCheck(sha256 === file.sha256, `Installed native DLL differs from the effective manifest: ${file.target}`);
    return { file: file.target, sha256 };
  });
  diagnostics.stage('driver-files');
  const driverPath = plainPath(options.driver, true), nativeDriver = plainPath(options['native-driver'], true);
  const port = await freePort();
  const environment = sanitizedEnvironment(process.env);
  diagnostics.stage('driver-start');
  const driver = spawnWebDriver(driverPath, ['--port', String(port), '--native-driver', nativeDriver], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError;
  driver.once('error', error => { launchError = error; diagnostics.driver(driver, error); });
  diagnostics.driver(driver);
  // Discard transport logs: a failure report never copies arbitrary process or page text.
  driver.stdout.resume(); driver.stderr.resume();
  let session;
  try {
    diagnostics.stage('driver-ready');
    let listening = false;
    for (let tries = 0; tries < 100; tries++) {
      requireCheck(!launchError && driver.exitCode === null, 'Production WebDriver exited before startup');
      if (await ready(port)) { listening = true; break; }
      await wait(100);
    }
    requireCheck(listening, 'Production WebDriver readiness timed out');
    diagnostics.stage('session');
    const { remote } = await import('webdriverio');
    session = await remote({ hostname: '127.0.0.1', port, logLevel: 'silent', connectionRetryCount: 0, connectionRetryTimeout: 60000,
      capabilities: { 'tauri:options': { application } } });
    diagnostics.stage('app-ready');
    await session.setTimeout({ script: 60000 });
    await session.waitUntil(() => session.execute(() => Boolean(window.__TAURI_INTERNALS__)), { timeout: 20000 });
    const invoke = (name, parameters = {}) => session.execute(async (command, args) => window.__TAURI_INTERNALS__.invoke(command, args), name, parameters);
    const playerState = async () => { const state = await invoke('get_player_state'); diagnostics.player(state); return state; };
    diagnostics.stage('initial-snapshot');
    const initial = validateSnapshot(await invoke('get_app_snapshot'), fixture);
    diagnostics.stage('settings');
    await session.$('a.settings-link').click();
    await session.waitUntil(() => session.execute(() => location.pathname === '/settings'
      && document.querySelectorAll('input[placeholder="gemini-…"]:not(:disabled)').length === 4), { timeout: 15000 });
    const ui = await session.execute(() => {
      const inputs = [...document.querySelectorAll('input[placeholder="gemini-…"]:not(:disabled)')];
      return { modelInputs: inputs.length, unsetInputs: inputs.filter(input => input.value === '').length,
        credentialMaterialVisible: document.body.textContent.includes('BEGIN PRIVATE KEY') };
    });
    requireCheck(ui.modelInputs === 4 && ui.unsetInputs === 4 && ui.credentialMaterialVisible === false, 'Installed model Settings did not render safely');
    diagnostics.stage('media-load');
    await session.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${fixture.mediaId}`);
    await session.$('.transcript-scroll').waitForDisplayed({ timeout: 15000 });
    await invoke('load_media', { mediaId: fixture.mediaId });
    let metadata;
    diagnostics.stage('metadata');
    await session.waitUntil(async () => {
      const state = await playerState();
      if (!state.ready || !state.surfaceVisible || !state.videoWidth || !state.durationMs) return false;
      metadata = validateMetadata(state); return true;
    }, { timeout: 20000 });
    diagnostics.stage('playback-start');
    await invoke('player_control', { request: { action: 'volume', value: 0 } });
    await invoke('player_control', { request: { action: 'seek', startMs: 500, endMs: 1800 } });
    let advancing, stopped, sought;
    diagnostics.stage('playback-advancing');
    await session.waitUntil(async () => {
      const state = await playerState();
      if (state.error) throw new Error('Production video playback failed');
      if (!state.paused && state.positionMs >= 750 && state.positionMs < 1800) { advancing = state; return true; }
      return false;
    }, { timeout: 10000, interval: 100 });
    diagnostics.stage('interval-stop');
    await session.waitUntil(async () => {
      const state = await playerState();
      if (state.error) throw new Error('Production interval playback failed');
      if (state.paused && state.positionMs >= 1600 && state.positionMs <= 2400) { stopped = state; return true; }
      return false;
    }, { timeout: 10000, interval: 100 });
    diagnostics.stage('seek');
    await invoke('player_control', { request: { action: 'seek', startMs: 7000 } });
    await session.waitUntil(async () => {
      const state = await playerState();
      if (state.error) throw new Error('Production video seek failed');
      if (state.ready && state.paused && state.positionMs >= 6750 && state.positionMs <= 7350) { sought = state; return true; }
      return false;
    }, { timeout: 10000, interval: 100 });
    diagnostics.stage('final-snapshot');
    const final = validateSnapshot(await invoke('get_app_snapshot'), fixture);
    diagnostics.stage('payload-recheck');
    requireCheck(hash(application) === options['expected-application-sha256'], 'Installed production executable changed during testing');
    requireCheck(hash(mediaPath) === fixtureSha256 && hash(join(workspace, 'native/runtime-windows-x64.json')) === effectiveManifestSha256,
      'Fixture or effective native manifest changed during production testing');
    for (const file of nativeFiles) requireCheck(hash(join(dirname(application), 'native', file.file)) === file.sha256, 'Installed native DLL changed during testing');
    const report = { schemaVersion: 1, sha: process.env.GITHUB_SHA ?? null, passed: true, normalBuild: true,
      applicationSha256: hash(application), effectiveManifestSha256,
      nativeFiles, fixtureSha256, fixtureMediaId: fixture.mediaId,
      appReady: true, settingsReady: true, nativeMetadataPassed: true, visibleSurfacePassed: true,
      playbackAdvanced: true, intervalStopPassed: true, seekPassed: true, accountingUnchanged: true,
      paidRequests: 0, initial, final, ui, observations: { metadata, advancing, stopped, sought },
      limitations: ['Muted playback does not test audible output.', 'This production probe is separate from the fixture-enabled functional E2E suite.'] };
    diagnostics.stage('session-close');
    await session.deleteSession(); session = undefined;
    diagnostics.stage('success-write');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    diagnostics.stage('complete');
    return report;
  } catch (error) {
    diagnostics.driver(driver, launchError);
    diagnostics.captureFailure(error);
    throw error;
  } finally {
    // Record the driver's state before cleanup can replace it with our termination.
    diagnostics.driver(driver, launchError);
    if (session) await session.deleteSession().catch(() => {});
    driver.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const diagnostics = createProductionDiagnostics();
  diagnostics.stage('arguments');
  try {
    const report = await runProductionProbe(parseOptions(process.argv.slice(2)), diagnostics);
    console.log(JSON.stringify({ passed: report.passed, applicationSha256: report.applicationSha256, paidRequests: 0 }));
  } catch (error) {
    try { await diagnostics.writeFailure(error); }
    catch (failure) { console.error(`[production-smoke] failure-report-write=${classifiedFailure(failure).code ?? 'unavailable'}`); }
    console.error('Installed production readiness/playback verification failed; release must stop. No passing evidence was written.');
    process.exitCode = 1;
  }
}
