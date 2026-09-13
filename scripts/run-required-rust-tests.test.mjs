// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertListedTest, assertPassedTest, assertSixHourReport, compiledTestExecutable, execute, fileIdentity,
  preflight, requiredSuites, runRequiredSuite, selectSuite,
} from './run-required-rust-tests.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-required-rust 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, bytes) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); return file; };
  return { root, write };
}
const pass = name => `\nrunning 1 test\ntest ${name} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.01s\n`;
function fakeCargo(root, calls, mutate = () => {}) {
  return async (command, args, options) => {
    calls.push({ command, args, env: { ...options.env } });
    let stdout;
    if (command === 'cargo') {
      const pkg = args[args.indexOf('-p') + 1];
      const name = pkg === 'surtitle' ? 'surtitle_app' : pkg.replaceAll('-', '_');
      stdout = JSON.stringify({ reason: 'compiler-artifact', target: { name }, profile: { test: true }, executable: join(root, `${name}.exe`) }) + '\n';
    } else stdout = args.includes('--list') ? `${args[0]}: test\n\n1 test, 0 benchmarks\n` : pass(args[0]);
    const result = { code: 0, signal: null, durationMs: 1, stdout, stderr: '' };
    mutate(result, command, args);
    return result;
  };
}

test('suites select 3 portable and 6 native tests without removed upstream coverage or child-process helpers', () => {
  assert.equal(selectSuite('linux-ffmpeg', 'linux').tests.length, 3);
  assert.equal(selectSuite('windows-native', 'win32', 'x64').tests.length, 6);
  assert.equal(selectSuite('windows-ffmpeg', 'win32', 'x64').tests.length, 3);
  assert.throws(() => selectSuite('upstream-tools', 'win32', 'x64'), /Unknown/);
  for (const suite of Object.values(requiredSuites)) {
    assert.equal(new Set(suite.tests.map(item => item.name)).size, suite.tests.length);
    assert(!suite.tests.some(item => /process_checkpoint_child|crash_child_after_paid_dispatch/.test(item.name)));
    assert(suite.tests.every(item => item.packageName !== 'live' && !item.requirements.some(requirement => requirement.startsWith('upstream'))));
    assert(!suite.tests.some(item => /current_cli_releases_install_probe_and_reuse|installed_tools_probe_and_extract/.test(item.name)));
  }
  assert.equal(selectSuite('windows-spoken', 'win32', 'x64').tests.length, 1);
  assert.equal(selectSuite('windows-six-hour', 'win32', 'x64').tests.length, 1);
  assert.throws(() => selectSuite('windows-native', 'linux'), /requires win32/);
  assert.throws(() => selectSuite('windows-native', 'win32', 'arm64'), /x64/);
  assert.throws(() => selectSuite('everything', 'win32'), /Unknown/);
});

test('listing rejects zero, partial-name, multiple and benchmark-only matches', () => {
  const name = 'module::required';
  assertListedTest(`${name}: test\n1 test, 0 benchmarks`, name);
  for (const output of ['', '0 tests, 0 benchmarks', 'required: test', `${name}: test\n${name}: test`, `${name}: benchmark`]) {
    assert.throws(() => assertListedTest(output, name), /exactly/);
  }
});

test('card selectors follow the actual Rust module declarations, including tool_commands', () => {
  const source = path => readFileSync(new URL('../src-tauri/src/' + path, import.meta.url), 'utf8');
  assert.match(source('lib.rs'), /^mod tool_commands;/m);
  assert.match(source('tool_commands.rs'), /#\[path = "card_audio\.rs"\]\s*mod card_audio;/);
  assert.match(source('card_audio.rs'), /#\[path = "card_audio_tests\.rs"\]\s*mod tests;/);
  const bodies = source('card_audio_tests.rs');
  for (const spec of requiredSuites['linux-ffmpeg'].tests.filter(item => item.packageName === 'surtitle')) {
    assert.match(spec.name, /^tool_commands::card_audio::tests::/);
    assert(bodies.includes(`async fn ${spec.name.split('::').at(-1)}()`));
  }
});

test('six-hour suite keeps measured acceptance separate from speech fixtures and rejects incomplete evidence', () => {
  const suite = requiredSuites['windows-six-hour'];
  assert(suite.cargoConfig.includes('profile.test.package.sha2.opt-level=3'));
  assert(suite.cargoConfig.includes('profile.test.package.surtitle-tools.opt-level=3'));
  assert(suite.cargoConfig.includes('profile.test.package.surtitle-ai.opt-level=1'));
  assert(!suite.tests[0].requirements.includes('spoken'));
  const good = { source_duration_ms: 21_600_000, core_samples: 345_600_000, cloud_calls: 0, temporary_pcm_removed: true,
    wall_seconds: 122, chunk_count: 180, sent_samples_including_context: 362_784_000, retained_bytes: 5_850_165,
    peak_working_set_bytes: 51_228_672, memory_scope: 'Rust acceptance process only; external FFmpeg excluded' };
  assertSixHourReport(good);
  for (const changed of [{ core_samples: 0 }, { cloud_calls: 1 }, { temporary_pcm_removed: false }, { wall_seconds: 361 },
    { peak_working_set_bytes: 0 }, { chunk_count: 0 }, { sent_samples_including_context: 1 }, { memory_scope: 'whole application' }]) {
    assert.throws(() => assertSixHourReport({ ...good, ...changed }));
  }
});

test('execution requires the exact test success line and exactly one pass with no skip', () => {
  const name = 'module::required';
  assertPassedTest(pass(name), name);
  for (const output of [pass('required'), pass(name).replace('1 passed', '0 passed'), pass(name).replace('0 ignored', '1 ignored'),
    pass(name).replace('... ok', '... ignored'), pass(name) + pass(name), pass(name).replace('0 measured', '1 measured')]) {
    assert.throws(() => assertPassedTest(output, name));
  }
});

test('Cargo test executable discovery rejects missing, non-test and duplicate targets', () => {
  const spec = requiredSuites['linux-ffmpeg'].tests[0];
  const valid = { reason: 'compiler-artifact', target: { name: 'surtitle_app' }, profile: { test: true }, executable: join(tmpdir(), 'test.exe') };
  assert.equal(compiledTestExecutable(JSON.stringify(valid), spec), valid.executable);
  for (const output of ['', JSON.stringify({ ...valid, profile: { test: false } }), JSON.stringify(valid) + '\n' + JSON.stringify(valid),
    JSON.stringify({ ...valid, target: { name: 'surtitle_ai' } }), JSON.stringify({ ...valid, executable: 'relative.exe' })]) {
    assert.throws(() => compiledTestExecutable(output, spec), /exactly one/);
  }
});

test('runner compiles each target once and lists then runs each required name individually', async t => {
  const f = fixture(t), calls = [];
  const report = await runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', env: {}, check: async () => [], run: fakeCargo(f.root, calls) });
  assert.equal(report.passed, true);
  assert.equal(report.tests.length, 3);
  assert.equal(calls.filter(call => call.command === 'cargo').length, 2);
  assert(calls.filter(call => call.command === 'cargo').every(call => call.args.includes('--locked') && call.args.includes('--no-run')));
  assert(calls[0].args.includes('e2e-test'));
  const invocations = calls.filter(call => call.command !== 'cargo');
  assert.equal(invocations.length, 6);
  for (let i = 0; i < 3; i++) {
    assert.equal(invocations[i * 2].args[0], requiredSuites['linux-ffmpeg'].tests[i].name);
    assert(invocations[i * 2].args.includes('--list'));
    assert(invocations[i * 2 + 1].args.includes('--test-threads=1'));
    assert(invocations[i * 2 + 1].args.includes('--show-output'));
    assert(invocations[i * 2 + 1].args.includes('--exact'));
  }
  assert.equal(JSON.parse(readFileSync(join(f.root, 'artifacts/required-rust-tests/linux-ffmpeg/report.json'))).passed, true);
  await assert.rejects(runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', env: {}, check: async () => [] }), /must be fresh/);
});

test('zero tests, silently ignored results and failed commands leave failed evidence and stop the suite', async t => {
  for (const mode of ['zero-list', 'ignored', 'exit']) {
    const f = fixture(t), calls = [];
    const run = fakeCargo(f.root, calls, (result, command, args) => {
      if (mode === 'zero-list' && args.includes('--list')) result.stdout = '0 tests, 0 benchmarks';
      if (mode === 'ignored' && command !== 'cargo' && !args.includes('--list')) result.stdout = pass(args[0]).replace('0 ignored', '1 ignored');
      if (mode === 'exit' && command === 'cargo') result.code = 1;
    });
    await assert.rejects(runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', env: {}, check: async () => [], run }));
    const report = JSON.parse(readFileSync(join(f.root, 'artifacts/required-rust-tests/linux-ffmpeg/report.json')));
    assert.equal(report.passed, false); assert.equal(report.tests[0].passed, false); assert(report.error);
    assert.equal(report.tests.length, 1);
    if (mode === 'zero-list') assert.equal(calls.filter(call => call.command !== 'cargo' && !call.args.includes('--list')).length, 0);
  }
});

test('missing explicit executables and changed files fail preflight or immutable input recheck', async t => {
  const f = fixture(t);
  await assert.rejects(preflight(['ffmpeg'], { root: f.root, env: {}, platform: 'linux' }), /absolute/);
  const executable = f.write('bin/ffmpeg', 'ffmpeg');
  await assert.rejects(preflight(['ffmpeg'], { root: f.root, env: { SURTITLE_TEST_FFMPEG: executable }, platform: 'linux' }), /ENOENT/);
  f.write('bin/ffprobe', 'ffprobe');
  const files = await preflight(['ffmpeg'], { root: f.root, env: { SURTITLE_TEST_FFMPEG: executable }, platform: 'linux' });
  assert.equal(files.length, 2); assert.equal(files[0].sha256, hash('ffmpeg'));
  f.write('bin/ffmpeg', 'substituted');
  await assert.rejects(fileIdentity(executable, files[0].sha256), /mismatch/);
});

test('a passing Rust summary cannot hide an executable replacement during the test', async t => {
  const f = fixture(t), executable = f.write('selected-tool.exe', 'original tool'), calls = [];
  const identity = await fileIdentity(executable);
  const run = fakeCargo(f.root, calls, (_result, command, args) => {
    if (command !== 'cargo' && !args.includes('--list')) writeFileSync(executable, 'replacement tool');
  });
  await assert.rejects(runRequiredSuite('windows-ffmpeg', { root: f.root, platform: 'win32', architecture: 'x64', env: {},
    check: async () => [identity], run }), /SHA-256 mismatch/);
  const report = JSON.parse(readFileSync(join(f.root, 'artifacts/required-rust-tests/windows-ffmpeg/report.json')));
  assert.equal(report.tests[0].passed, false); assert.equal(report.passed, false);
});

test('six-hour completion copies the actual report/receipt and rejects a retained PCM despite an otherwise passing test', async t => {
  for (const retainedPcm of [false, true]) {
    const f = fixture(t), calls = [], receiptPath = f.write('work/ai-six-hour-acceptance/prepared/receipt.json', '{}');
    const acceptance = { source_duration_ms: 21_600_000, core_samples: 345_600_000, cloud_calls: 0, temporary_pcm_removed: true,
      wall_seconds: 122, chunk_count: 180, sent_samples_including_context: 362_784_000, retained_bytes: 5_850_165,
      peak_working_set_bytes: 51_228_672, memory_scope: 'Rust acceptance process only; external FFmpeg excluded', receipt_path: receiptPath };
    const run = fakeCargo(f.root, calls, (_result, command, args) => {
      if (command !== 'cargo' && !args.includes('--list')) {
        f.write('work/ai-six-hour-acceptance/report.json', JSON.stringify(acceptance));
        if (retainedPcm) f.write('work/ai-six-hour-acceptance/prepared/decoded-selection.pcm', 'leftover');
      }
    });
    const promise = runRequiredSuite('windows-six-hour', { root: f.root, platform: 'win32', architecture: 'x64', env: {}, check: async () => [], run });
    if (retainedPcm) await assert.rejects(promise, /PCM remains/);
    else {
      assert.equal((await promise).passed, true);
      const saved = JSON.parse(readFileSync(join(f.root, 'artifacts/required-rust-tests/windows-six-hour/six-hour-report.json')));
      assert.deepEqual(saved, acceptance);
      assert.equal(readFileSync(join(f.root, 'artifacts/required-rust-tests/windows-six-hour/six-hour-receipt.json'), 'utf8'), '{}');
    }
    assert(calls[0].args.includes('--no-default-features'));
    assert(calls[0].args.includes('profile.test.package.surtitle-ai.opt-level=1'));
  }
});

test('native preflight verifies all three DLL hashes, same-SHA binding and unbundled model', async t => {
  const f = fixture(t), sha = 'a'.repeat(40);
  const targets = ['mpv-2.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'];
  for (const target of targets) f.write(`src-tauri/resources/native/${target}`, target);
  f.write('work/native-fixtures/silero_vad.onnx', 'model');
  const manifest = { platform: 'windows-x64', buildBinding: { sha }, components: [{ runtimeFiles: targets.map(target => ({ target, sha256: hash(target) })) }],
    models: [{ id: 'silero-vad', bundled: false, developmentPath: 'work/native-fixtures/silero_vad.onnx', sha256: hash('model') }] };
  const save = () => f.write('native/runtime-windows-x64.json', JSON.stringify(manifest)); save();
  const options = { root: f.root, env: { GITHUB_SHA: sha }, platform: 'win32' };
  assert.equal((await preflight(['silero'], options)).length, 4);
  await assert.rejects(preflight(['silero'], { ...options, env: { GITHUB_SHA: 'b'.repeat(40) } }), /this commit/);
  manifest.models[0].bundled = true; save(); await assert.rejects(preflight(['silero'], options), /external/);
  manifest.models[0].bundled = false; save(); f.write('src-tauri/resources/native/onnxruntime.dll', 'changed');
  await assert.rejects(preflight(['silero'], options), /mismatch/);
});

test('real process evidence preserves stdout, stderr and a nonzero status', async t => {
  const f = fixture(t), logPrefix = join(f.root, 'child');
  const result = await execute(process.execPath, ['-e', 'console.log("child stdout"); console.error("child stderr"); process.exitCode=7'],
    { cwd: f.root, env: process.env, timeoutMs: 5000, logPrefix, showStdout: false });
  assert.equal(result.code, 7);
  assert.match(readFileSync(logPrefix + '.stdout.log', 'utf8'), /child stdout/);
  assert.match(readFileSync(logPrefix + '.stderr.log', 'utf8'), /child stderr/);
});

test('watchdog terminates its own child tree while an unrelated process continues', async t => {
  const f = fixture(t), ownedBeat = join(f.root, 'owned-beat'), unrelatedBeat = join(f.root, 'unrelated-beat');
  const until = async (condition, message) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, message);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const running = pid => {
    try {
      process.kill(pid, 0);
      // A container's PID 1 may not reap an orphan immediately. Zombies have
      // exited and cannot write heartbeats, even though kill(pid, 0) succeeds.
      return process.platform !== 'linux' || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch (error) {
      if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
      throw error;
    }
  };
  // Overwriting briefly truncates a heartbeat to zero bytes. Append sequences
  // so a concurrent reader can only see the same length or forward progress.
  const heartbeat = path => `const fs=require('node:fs');let sequence=0;const beat=()=>fs.appendFileSync(${JSON.stringify(path)},String(sequence++)+'\\n');beat();setInterval(beat,25)`;
  const unrelated = spawn(process.execPath, ['-e', heartbeat(unrelatedBeat)], { windowsHide: true, stdio: 'ignore' });
  const unrelatedClosed = new Promise(resolve => unrelated.once('close', resolve));
  const ownedPids = [];
  t.onTestFinished(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
    for (const pid of ownedPids) if (running(pid)) process.kill(pid, 'SIGKILL');
    await unrelatedClosed;
    await until(() => ownedPids.every(pid => !running(pid)), 'Test cleanup must finish before removing heartbeat files');
  });
  const source = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(heartbeat(ownedBeat))}],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`;
  await assert.rejects(execute(process.execPath, ['-e', source], { cwd: f.root, env: process.env, timeoutMs: 1500, logPrefix: join(f.root, 'timeout'), showStdout: false }), error => {
    assert.match(error.message, /timed out/);
    const pids = JSON.parse(error.result.stdout);
    assert.equal(pids.length, 2);
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    ownedPids.push(...pids);
    return true;
  });
  assert.ok(readFileSync(ownedBeat).length > 0, 'The owned grandchild must run before the watchdog fires');
  assert.ok(readFileSync(unrelatedBeat).length > 0, 'The unrelated process must run before the watchdog fires');
  await until(() => ownedPids.every(pid => !running(pid)), 'The watchdog must terminate both its child and grandchild');
  const lastOwned = readFileSync(ownedBeat, 'utf8');
  let lastUnrelated = readFileSync(unrelatedBeat).length;
  for (let observation = 0; observation < 3; observation++) {
    await until(() => {
      assert.equal(readFileSync(ownedBeat, 'utf8'), lastOwned);
      assert.ok(running(unrelated.pid), 'The watchdog must leave the unrelated process alive');
      return readFileSync(unrelatedBeat).length > lastUnrelated;
    }, 'The unrelated process must keep appending heartbeats after the owned tree exits');
    lastUnrelated = readFileSync(unrelatedBeat).length;
  }
  assert.equal(readFileSync(ownedBeat, 'utf8'), lastOwned);
}, 20_000);
