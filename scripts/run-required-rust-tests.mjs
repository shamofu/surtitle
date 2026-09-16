// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit integration suites. A Cargo exit code alone does not prove a test ran.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minutes = value => value * 60_000;
const test = (packageName, name, requirements, timeoutMs = minutes(3)) => Object.freeze({
  packageName, name, requirements, timeoutMs,
  target: ['--lib'],
  features: packageName === 'surtitle' ? ['--features', 'e2e-test'] : packageName === 'surtitle-ai' ? ['--no-default-features'] : [],
});
const ffmpegTests = [
  test('surtitle', 'tool_commands::card_audio::tests::installed_ffmpeg_preserves_native_rate_wav_tail_without_padding', ['ffmpeg'], minutes(5)),
  test('surtitle', 'tool_commands::card_audio::tests::installed_ffmpeg_preserves_source_clock_and_cleans_failed_outputs', ['ffmpeg'], minutes(10)),
  test('surtitle-tools', 'command::tests::multitrack_extraction_preserves_selected_stream', ['ffmpeg']),
];
export const requiredSuites = Object.freeze({
  'linux-ffmpeg': { platform: 'linux', tests: ffmpegTests },
  'windows-ffmpeg': { platform: 'win32', tests: ffmpegTests },
  'windows-native': { platform: 'win32', tests: [...ffmpegTests,
    test('surtitle', 'player::subtitle_tests::real_mpv_load_restores_position_and_maps_audio_stream', ['ffmpeg', 'native']),
    test('surtitle', 'commands::restore_tests::real_mpv_restore_reconciles_resume_audio_subtitles_and_stale_ticks', ['ffmpeg', 'native']),
    test('surtitle-ai', 'prepare::tests::real_silero_and_ffmpeg_preserve_selection_time', ['ffmpeg', 'silero']),
  ] },
  'windows-spoken': { platform: 'win32', tests: [
    test('surtitle-ai', 'prepare::spoken_pause_test::real_spoken_audio_and_interior_pause_require_only_local_warning_review', ['ffmpeg', 'silero', 'spoken'], minutes(5)),
  ] },
  'windows-six-hour': { platform: 'win32', cargoConfig: [
    '--config', 'profile.test.package.sha2.opt-level=3',
    '--config', 'profile.test.package.surtitle-tools.opt-level=3',
    '--config', 'profile.test.package.surtitle-ai.opt-level=1',
  ], tests: [
    test('surtitle-ai', 'prepare::tests::six_hour_streaming_acceptance', ['ffmpeg', 'silero', 'long'], minutes(10)),
  ] },
});

function requireCondition(value, message) { if (!value) throw new Error(message); }
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export function selectSuite(name, platform = process.platform, architecture = process.arch) {
  const suite = requiredSuites[name];
  requireCondition(suite, `Unknown required Rust suite: ${name}`);
  requireCondition(platform === suite.platform, `${name} requires ${suite.platform}, got ${platform}`);
  if (platform === 'win32') requireCondition(architecture === 'x64', `${name} requires Windows x64`);
  return suite;
}

export function assertListedTest(output, name) {
  const names = output.split(/\r?\n/).filter(line => /: (test|benchmark)$/.test(line));
  requireCondition(names.length === 1 && names[0] === `${name}: test`, `Required test listing must contain exactly ${name}; observed ${JSON.stringify(names)}`);
}
export function assertPassedTest(output, name) {
  const lines = output.split(/\r?\n/);
  requireCondition(lines.filter(line => line === `test ${name} ... ok`).length === 1, `Required test did not report success: ${name}`);
  const summaries = lines.filter(line => line.startsWith('test result:'));
  requireCondition(summaries.length === 1 && /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out; finished in /.test(summaries[0]),
    `Required test must report exactly one pass and no skips: ${name}`);
}

export function compiledTestExecutable(output, specification) {
  const targetName = specification.packageName === 'surtitle' ? 'surtitle_app' : specification.packageName.replaceAll('-', '_');
  const executables = output.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(value => value?.reason === 'compiler-artifact' && value.profile?.test === true
    && value.target?.name === targetName && value.executable).map(value => value.executable);
  requireCondition(executables.length === 1 && isAbsolute(executables[0]), `Cargo must identify exactly one test executable for ${targetName}`);
  return executables[0];
}

export async function fileIdentity(path, expected) {
  requireCondition(typeof path === 'string' && isAbsolute(path), `An absolute file path is required: ${path}`);
  const actual = realpathSync(path), stat = lstatSync(actual);
  requireCondition(stat.isFile() && stat.size > 0, `A nonempty regular file is required: ${path}`);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(actual)) hash.update(bytes);
  const sha256 = hash.digest('hex');
  if (expected !== undefined) requireCondition(/^[a-f0-9]{64}$/.test(expected) && sha256 === expected, `SHA-256 mismatch: ${path}`);
  return { path: actual, bytes: stat.size, sha256 };
}

export async function preflight(requirements, { root = workspace, env = process.env, platform = process.platform } = {}) {
  const files = [];
  const add = async (path, expected) => { const identity = await fileIdentity(path, expected); files.push(identity); return identity; };
  if (requirements.includes('ffmpeg')) {
    const ffmpeg = await add(env.SURTITLE_TEST_FFMPEG);
    // Rust resolves selected executable shims and enforces the same-package pair.
    const probe = join(dirname(env.SURTITLE_TEST_FFMPEG), platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    await add(probe);
    requireCondition(ffmpeg.path !== files.at(-1).path, 'FFmpeg and ffprobe must be different executables');
  }
  if (requirements.some(item => ['native', 'silero'].includes(item))) {
    requireCondition(platform === 'win32', 'Native DLL integration requires Windows');
    const manifest = readJson(join(root, 'native/runtime-windows-x64.json'));
    requireCondition(manifest.platform === 'windows-x64', 'Native manifest must select Windows x64');
    const runtimeFiles = manifest.components.flatMap(component => component.runtimeFiles);
    requireCondition(JSON.stringify(runtimeFiles.map(file => file.target).sort()) === JSON.stringify(['mpv-2.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll']), 'Native manifest must contain the three expected DLLs');
    for (const file of runtimeFiles) {
      requireCondition(typeof file.target === 'string' && /^[a-z0-9_.-]+\.dll$/i.test(file.target), 'Invalid native DLL target');
      await add(join(root, 'src-tauri/resources/native', file.target), file.sha256);
    }
    if (requirements.includes('silero')) {
      const model = manifest.models.find(item => item.id === 'silero-vad');
      requireCondition(model?.bundled === false, 'Silero must remain an external development fixture');
      const path = resolve(root, model.developmentPath);
      const rel = relative(resolve(root), path);
      requireCondition(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Model development path must stay inside the workspace');
      await add(path, model.sha256);
    }
  }
  if (requirements.includes('spoken')) {
    requireCondition(typeof env.SURTITLE_SPOKEN_FIXTURES === 'string' && isAbsolute(env.SURTITLE_SPOKEN_FIXTURES), 'SURTITLE_SPOKEN_FIXTURES must select an absolute fixture directory');
    requireCondition(lstatSync(env.SURTITLE_SPOKEN_FIXTURES).isDirectory(), 'Spoken fixture directory is missing');
    // Record the same six inputs; Rust checks their independently pinned hashes.
    for (const stem of ['1089-134686-0001', '1089-134686-0003']) {
      for (const suffix of ['-pcm16.wav', '.TextGrid', '.txt']) {
        const identity = await add(join(env.SURTITLE_SPOKEN_FIXTURES, stem + suffix));
        requireCondition(identity.bytes <= 1024 * 1024, `Spoken fixture exceeds 1 MiB: ${identity.path}`);
      }
    }
  }
  if (requirements.includes('long')) {
    await add(env.SURTITLE_LONG_AUDIO_FILE);
    requireCondition(!existsSync(join(root, 'work/ai-six-hour-acceptance/report.json')), 'Six-hour evidence must be fresh');
  }
  return files;
}

export function assertSixHourReport(report) {
  requireCondition(report.source_duration_ms === 21_600_000 && report.core_samples === 345_600_000,
    'Six-hour acceptance must cover exactly 345600000 samples');
  requireCondition(report.cloud_calls === 0 && report.temporary_pcm_removed === true, 'Six-hour acceptance must remain local and remove temporary PCM');
  requireCondition(Number.isFinite(report.wall_seconds) && report.wall_seconds > 0 && report.wall_seconds <= 360,
    'Six-hour acceptance exceeded its 360 second preparation budget');
  requireCondition(Number.isSafeInteger(report.chunk_count) && report.chunk_count > 0
    && Number.isSafeInteger(report.sent_samples_including_context) && report.sent_samples_including_context >= report.core_samples
    && Number.isSafeInteger(report.retained_bytes) && report.retained_bytes > 0
    && Number.isSafeInteger(report.peak_working_set_bytes) && report.peak_working_set_bytes > 0,
  'Six-hour acceptance is missing measured chunk, storage or Windows memory evidence');
  requireCondition(report.memory_scope === 'Rust acceptance process only; external FFmpeg excluded', 'Six-hour memory evidence must retain its limited measurement scope');
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
  run = execute, check = preflight, signal,
} = {}) {
  const suite = selectSuite(name, platform, architecture);
  const evidence = resolve(evidenceDirectory ?? join(root, 'artifacts/required-rust-tests', name));
  requireCondition(!existsSync(evidence), `Required Rust evidence directory must be fresh: ${evidence}`);
  mkdirSync(evidence, { recursive: true });
  const report = { schemaVersion: 1, suite: name, runId: randomUUID(), sha: env.GITHUB_SHA ?? null, platform, architecture,
    startedAt: new Date().toISOString(), passed: false, tests: [], commands: [] };
  const save = () => writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const localEnv = { ...env }, compiled = new Map();
  const command = async (program, args, timeoutMs, label, showStdout = true) => {
    const logPrefix = join(evidence, `${String(report.commands.length + 1).padStart(2, '0')}-${label}`);
    const entry = { program, args, timeoutMs, stdout: `${logPrefix}.stdout.log`, stderr: `${logPrefix}.stderr.log` };
    report.commands.push(entry); save();
    try {
      const result = await run(program, args, { cwd: root, env: localEnv, timeoutMs, logPrefix, showStdout, signal });
      Object.assign(entry, { code: result.code, signal: result.signal, durationMs: result.durationMs }); save();
      requireCondition(result.code === 0, `${label} exited ${result.code}: ${result.stderr?.slice(-2000) ?? ''}`);
      return result.stdout;
    } catch (error) { entry.error = error.message; if (error.result) Object.assign(entry, { code: error.result.code, durationMs: error.result.durationMs }); save(); throw error; }
  };
  try {
    for (const specification of suite.tests) {
      const entry = { name: specification.name, package: specification.packageName, passed: false };
      report.tests.push(entry); save();
      entry.inputs = await check(specification.requirements, { root, env: localEnv, platform });
      const packageName = specification.packageName;
      const cargoConfig = suite.cargoConfig ?? [];
      const key = JSON.stringify([packageName, specification.target, specification.features, cargoConfig]);
      if (!compiled.has(key)) {
        const args = ['test', '-p', packageName, ...specification.target, ...specification.features, ...cargoConfig, '--locked', '--no-run', '--message-format=json'];
        const output = await command('cargo', args, minutes(20), `compile-${specification.packageName}`, false);
        compiled.set(key, compiledTestExecutable(output, specification));
      }
      const executable = compiled.get(key);
      const listed = await command(executable, [specification.name, '--ignored', '--exact', '--list', '--color=never'], minutes(2), `list-${report.tests.length}`);
      assertListedTest(listed, specification.name);
      entry.listed = true;
      for (const file of entry.inputs) await fileIdentity(file.path, file.sha256);
      const output = await command(executable, [specification.name, '--ignored', '--exact', '--test-threads=1', '--show-output', '--color=never'], specification.timeoutMs, `run-${report.tests.length}`);
      assertPassedTest(output, specification.name);
      for (const file of entry.inputs) await fileIdentity(file.path, file.sha256);
      if (specification.requirements.includes('long')) {
        const resultPath = join(root, 'work/ai-six-hour-acceptance/report.json');
        entry.acceptance = readJson(resultPath);
        assertSixHourReport(entry.acceptance);
        const receiptPath = entry.acceptance.receipt_path;
        requireCondition(typeof receiptPath === 'string' && isAbsolute(receiptPath), 'Six-hour receipt must have an absolute path');
        const location = relative(join(root, 'work/ai-six-hour-acceptance'), realpathSync(receiptPath));
        requireCondition(location && !location.startsWith('..') && !isAbsolute(location), 'Six-hour receipt escapes its acceptance directory');
        requireCondition(!existsSync(join(dirname(receiptPath), 'decoded-selection.pcm')), 'Six-hour temporary PCM remains on disk');
        await fileIdentity(receiptPath);
        writeFileSync(join(evidence, 'six-hour-report.json'), readFileSync(resultPath));
        writeFileSync(join(evidence, 'six-hour-receipt.json'), readFileSync(receiptPath));
      }
      entry.passed = true; save();
    }
    report.passed = report.tests.length === suite.tests.length && report.tests.every(item => item.passed);
    console.log(`Required Rust suite ${name}: ${report.tests.length} exact tests passed.`);
    return report;
  } catch (error) { report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); save(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [name, option, directory, ...extra] = process.argv.slice(2);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  try {
    requireCondition(!extra.length && ((!option && !directory) || (option === '--evidence-dir' && directory)),
      'Usage: node scripts/run-required-rust-tests.mjs SUITE [--evidence-dir DIRECTORY]');
    await runRequiredSuite(name, { evidenceDirectory: directory, signal: controller.signal });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
