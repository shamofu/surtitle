// SPDX-License-Identifier: GPL-3.0-or-later
// Run app integration tests explicitly; Cargo succeeds even when a filter matches nothing.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minutes = value => value * 60_000;
const test = (packageName, name, timeoutMs = minutes(3)) => Object.freeze({
  packageName, name, timeoutMs,
  target: ['--lib'],
  features: packageName === 'surtitle' ? ['--features', 'e2e-test'] : packageName === 'surtitle-ai' ? ['--no-default-features'] : [],
});
const ffmpegTests = [
  test('surtitle', 'tool_commands::card_audio::tests::installed_ffmpeg_preserves_native_rate_wav_tail_without_padding', minutes(5)),
  test('surtitle', 'tool_commands::card_audio::tests::installed_ffmpeg_preserves_source_clock_and_cleans_failed_outputs', minutes(10)),
  test('surtitle-tools', 'command::tests::multitrack_extraction_preserves_selected_stream'),
];
export const requiredSuites = Object.freeze({
  'linux-ffmpeg': { platform: 'linux', tests: ffmpegTests },
  'windows-ffmpeg': { platform: 'win32', tests: ffmpegTests },
  'windows-native': { platform: 'win32', tests: [...ffmpegTests,
    test('surtitle', 'player::subtitle_tests::real_mpv_load_restores_position_and_maps_audio_stream'),
    test('surtitle', 'commands::restore_tests::real_mpv_restore_reconciles_resume_audio_subtitles_and_stale_ticks'),
    test('surtitle-ai', 'prepare::tests::real_silero_and_ffmpeg_preserve_selection_time'),
  ] },
  'windows-spoken': { platform: 'win32', tests: [
    test('surtitle-ai', 'prepare::spoken_pause_test::real_spoken_audio_and_interior_pause_require_only_local_warning_review', minutes(5)),
  ] },
  'windows-six-hour': { platform: 'win32', cargoConfig: [
    '--config', 'profile.test.package.sha2.opt-level=3',
    '--config', 'profile.test.package.surtitle-tools.opt-level=3',
    '--config', 'profile.test.package.surtitle-ai.opt-level=1',
  ], tests: [
    test('surtitle-ai', 'prepare::tests::six_hour_streaming_acceptance', minutes(10)),
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

export function assertPassedTest(output, name) {
  const summaries = output.split(/\r?\n/).filter(line => line.startsWith('test result:'));
  requireCondition(summaries.length === 1 && /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out; finished in /.test(summaries[0]),
    `Required test must report exactly one pass and no skips: ${name}`);
}

// Only processes started by this invocation are candidates for termination.
export async function terminateOwnedTree(child, platform = process.platform) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe');
    const result = spawnSync(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      throw new Error(`Cannot terminate the owned process tree ${child.pid}: ${result.error?.message ?? result.stderr}`);
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function execute(command, args, { cwd, env, timeoutMs, logPrefix, showStdout = true, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, timer, settled = false;
    if (logPrefix) for (const stream of ['stdout', 'stderr']) writeFileSync(`${logPrefix}.${stream}.log`, '');
    const output = (kind, bytes) => {
      if (logPrefix) appendFileSync(`${logPrefix}.${kind}.log`, bytes);
      if (kind === 'stderr' || showStdout) process[kind].write(bytes);
      // Keep bounded parser input; full logs remain on disk.
      if (kind === 'stdout') stdout += bytes.toString(); else stderr += bytes.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 32 * 1024 * 1024) stop('Process output exceeded the 32 MiB parser limit');
    };
    const finish = (code, processSignal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const result = { command, args, code, signal: processSignal, durationMs: Date.now() - started, stdout, stderr };
      if (failure) reject(Object.assign(failure, { result })); else resolveResult(result);
    };
    const stop = reason => {
      if (failure || settled) return;
      failure = new Error(reason);
      terminateOwnedTree(child).catch(error => { failure = new Error(`${reason}; ${error.message}`); }).finally(() => {
        // Also bound a closed parent whose abandoned descendants hold pipe handles.
        child.stdout.destroy(); child.stderr.destroy(); finish(child.exitCode, child.signalCode);
      });
    };
    const abort = () => stop('Required Rust process interrupted');
    child.stdout.on('data', bytes => output('stdout', bytes));
    child.stderr.on('data', bytes => output('stderr', bytes));
    child.on('error', error => { failure = error; finish(null, null); });
    child.on('close', finish);
    timer = setTimeout(() => stop(`Required Rust process timed out after ${timeoutMs} ms`), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function runRequiredSuite(name, {
  root = workspace, evidenceDirectory, env = process.env, platform = process.platform, architecture = process.arch,
  run = execute, signal,
} = {}) {
  const suite = selectSuite(name, platform, architecture);
  const directory = resolve(evidenceDirectory ?? join(root, 'artifacts/required-rust-tests', name));
  mkdirSync(directory, { recursive: true });
  for (const [index, specification] of suite.tests.entries()) {
    const args = ['test', '-p', specification.packageName, ...specification.target, ...specification.features,
      ...(suite.cargoConfig ?? []), '--locked', specification.name, '--', '--ignored', '--exact',
      '--test-threads=1', '--nocapture', '--color=never'];
    console.log(`Running ${specification.name}`);
    const result = await run('cargo', args, { cwd: root, env, signal,
      timeoutMs: minutes(20) + specification.timeoutMs,
      logPrefix: join(directory, `${index + 1}-${specification.packageName}`) });
    requireCondition(result.code === 0, `${specification.name} exited ${result.code}`);
    assertPassedTest(result.stdout, specification.name);
  }
  console.log(`Required Rust suite ${name}: ${suite.tests.length} tests passed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [name, option, directory, ...extra] = process.argv.slice(2);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  try {
    requireCondition(!extra.length && ((!option && !directory) || (option === '--evidence-dir' && directory)),
      'Usage: node scripts/run-required-rust-tests.mjs SUITE [--evidence-dir LOG_DIRECTORY]');
    await runRequiredSuite(name, { evidenceDirectory: directory, signal: controller.signal });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
