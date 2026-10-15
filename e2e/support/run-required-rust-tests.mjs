// SPDX-License-Identifier: GPL-3.0-or-later
// The registry selects native cases; nextest owns execution and timeouts.
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const test = (packageName, name) => Object.freeze({ packageName, name });
const ffmpegTests = [
  test('surtitle', 'application::media_tools::card_audio::tests::installed_ffmpeg_preserves_native_rate_wav_tail_without_padding'),
  test('surtitle', 'application::media_tools::card_audio::tests::installed_ffmpeg_preserves_source_clock_and_cleans_failed_outputs'),
  test('surtitle-tools', 'command::tests::multitrack_extraction_preserves_selected_stream'),
];
export const requiredSuites = Object.freeze({
  'linux-ffmpeg': { platform: 'linux', tests: ffmpegTests },
  'windows-native': { platform: 'win32', tests: [...ffmpegTests,
    test('surtitle', 'player::subtitle_tests::real_mpv_load_restores_position_and_maps_audio_stream'),
    test('surtitle', 'application::transfer::restore_tests::real_mpv_restore_reconciles_resume_audio_subtitles_and_stale_ticks'),
    test('surtitle-ai', 'prepare::tests::real_silero_and_ffmpeg_preserve_selection_time'),
    test('surtitle-ai', 'prepare::tests::real_preparation_failures_remove_receipts_and_temporary_files'),
    test('surtitle-ai', 'prepare::spoken_pause_test::real_spoken_audio_and_interior_pause_require_only_local_warning_review'),
  ] },
});

function requireCondition(value, message) { if (!value) throw new Error(message); }
export function selectSuite(name, platform = process.platform, architecture = process.arch) {
  const suite = requiredSuites[name];
  requireCondition(suite, `Unknown required Rust suite: ${name}`);
  requireCondition(platform === suite.platform, `${name} requires ${suite.platform}, got ${platform}`);
  if (platform === 'win32') requireCondition(architecture === 'x64', `${name} requires Windows x64`);
  return suite;
}

export function suiteGroups(suite) {
  const groups = new Map();
  for (const specification of suite.tests) {
    if (!groups.has(specification.packageName)) groups.set(specification.packageName, []);
    groups.get(specification.packageName).push(specification);
  }
  return [...groups].map(([packageName, tests]) => ({ packageName, tests,
    args: ['-p', packageName, '--lib',
      ...(packageName === 'surtitle' ? ['--features', 'e2e-test'] : packageName === 'surtitle-ai' ? ['--no-default-features'] : []),
      '--locked', '--profile', 'required', '--run-ignored', 'only', '--ignore-default-filter',
      '-E', tests.map(item => `test(=${item.name})`).join(' | ')],
  }));
}

// One matching test is insufficient: a renamed mandatory case must fail discovery.
export function assertInventory(list, expected) {
  requireCondition(list && typeof list['rust-suites'] === 'object' && list['rust-suites'] !== null,
    'Invalid nextest test inventory');
  const actual = [];
  for (const suite of Object.values(list['rust-suites'])) {
    for (const [name, testcase] of Object.entries(suite.testcases ?? {})) {
      if (testcase['filter-match']?.status !== 'matches') continue;
      requireCondition(suite.kind === 'lib' && testcase.ignored === true,
        `Required native case must be an ignored library test: ${suite['package-name']}::${name}`);
      actual.push(`${suite['package-name']}::${name}`);
    }
  }
  const wanted = expected.map(item => `${item.packageName}::${item.name}`).sort();
  actual.sort();
  requireCondition(JSON.stringify(actual) === JSON.stringify(wanted),
    `Required Rust inventory differs. Expected ${JSON.stringify(wanted)}; discovered ${JSON.stringify(actual)}`);
}

export function execute(command, args, { cwd, env, logPrefix, captureStdout = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    // Stay in the console/process group so nextest receives cancellation itself.
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '', interrupted = false;
    for (const stream of ['stdout', 'stderr']) {
      if (logPrefix) writeFileSync(`${logPrefix}.${stream}.log`, '');
      child[stream].setEncoding('utf8');
      child[stream].on('data', bytes => {
        if (logPrefix) appendFileSync(`${logPrefix}.${stream}.log`, bytes);
        if (stream === 'stdout' && captureStdout) stdout += bytes.toString();
        else process[stream].write(bytes);
      });
    }
    // Windows console events reach nextest; child.kill there would bypass its
    // graceful cancellation. POSIX CI may signal only this wrapper.
    const handlers = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM'].map(signal => {
      const handler = () => { interrupted = true; child.kill(signal); };
      process.once(signal, handler);
      return [signal, handler];
    });
    const cleanup = () => handlers.forEach(([signal, handler]) => process.removeListener(signal, handler));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      resolveResult({ code, signal, interrupted, durationMs: Date.now() - started, stdout });
    });
  });
}

export async function runRequiredSuite(name, {
  root = workspace, evidenceDirectory, env = process.env, platform = process.platform, architecture = process.arch,
  run = execute,
} = {}) {
  const suite = selectSuite(name, platform, architecture);
  const base = resolve(evidenceDirectory ?? join(root, 'artifacts/required-rust-tests', name));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'run-'));
  const groups = suiteGroups(suite);
  const summary = { schemaVersion: 1, suite: name, expectedTests: suite.tests.length,
    groups: groups.map(group => ({ packageName: group.packageName, tests: group.tests.map(item => item.name), status: 'not_run' })) };
  const save = () => writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  save();
  const failures = [];
  for (const [index, group] of groups.entries()) {
    const record = summary.groups[index];
    const prefix = join(directory, group.packageName);
    record.status = 'listing'; save();
    try {
      const listed = await run('cargo', ['nextest', 'list', ...group.args, '--message-format', 'json'],
        { cwd: root, env, logPrefix: `${prefix}.list`, captureStdout: true });
      record.listDurationMs = listed.durationMs;
      record.listExitCode = listed.code;
      record.signal = listed.signal ?? null;
      record.interrupted = listed.interrupted ?? false;
      requireCondition(listed.code === 0, `${group.packageName} discovery exited ${listed.code ?? listed.signal}`);
      assertInventory(JSON.parse(listed.stdout), group.tests);
      record.status = 'running'; save();
      // The repository config fixes this staging path. Never copy a stale report.
      const report = join(root, 'test-results/nextest/required/junit.xml');
      rmSync(report, { force: true });
      const result = await run('cargo', ['nextest', 'run', ...group.args, '--no-tests', 'fail', '--retries', '0'],
        { cwd: root, env, logPrefix: `${prefix}.run` });
      record.durationMs = result.durationMs;
      record.exitCode = result.code;
      record.signal = result.signal ?? null;
      record.interrupted = result.interrupted ?? false;
      if (existsSync(report)) {
        record.junit = `${group.packageName}.junit.xml`;
        copyFileSync(report, join(directory, record.junit));
      }
      requireCondition(result.code === 0, `${group.packageName} tests exited ${result.code ?? result.signal}`);
      requireCondition(record.junit, `${group.packageName} produced no JUnit report`);
      record.status = 'passed';
    } catch (error) {
      record.failurePhase = record.status === 'listing' ? 'discovery' : 'execution';
      record.status = 'failed';
      record.error = error.message;
      failures.push(error);
    }
    save();
    if (record.signal || record.interrupted) break;
  }
  console.log(`Required Rust suite ${name}: evidence ${directory}`);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
  return { directory, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [name, option, directory, ...extra] = process.argv.slice(2);
  try {
    requireCondition(!extra.length && ((!option && !directory) || (option === '--evidence-dir' && directory)),
      'Usage: node e2e/support/run-required-rust-tests.mjs SUITE [--evidence-dir LOG_DIRECTORY]');
    await runRequiredSuite(name, { evidenceDirectory: directory });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
