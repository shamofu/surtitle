// SPDX-License-Identifier: GPL-3.0-or-later
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertInventory, execute, runRequiredSuite, selectSuite, suiteGroups } from './run-required-rust-tests.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-required-rust 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, 'work/test-results/nextest/required/junit.xml');
  mkdirSync(dirname(report), { recursive: true });
  return { root, report };
}
function inventory(tests) {
  const suites = {};
  for (const { packageName, name } of tests) {
    const suite = suites[packageName] ??= { 'package-name': packageName, kind: 'lib', testcases: {} };
    suite.testcases[name] = { ignored: true, 'filter-match': { status: 'matches' } };
  }
  return { 'rust-suites': suites };
}
function fakeNextest(f, suite, intercept = () => undefined) {
  const groups = suiteGroups(suite);
  return async (command, args, options) => {
    assert.equal(command, 'cargo');
    assert.equal(args[0], 'nextest');
    const group = groups.find(item => item.packageName === args[args.indexOf('-p') + 1]);
    const result = intercept(args[1], group, args, options);
    if (result) return result;
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(inventory(group.tests)), durationMs: 10 };
    writeFileSync(f.report, `<testsuites name="${group.packageName}" tests="${group.tests.length}"/>`);
    return { code: 0, durationMs: 20 };
  };
}

test('rejects unavailable platforms and incomplete, duplicate or non-ignored inventories', () => {
  assert.throws(() => selectSuite('unknown', 'linux'), /Unknown/);
  assert.throws(() => selectSuite('windows-native', 'linux'), /requires win32/);
  assert.throws(() => selectSuite('windows-native', 'win32', 'arm64'), /x64/);
  const expected = selectSuite('linux-ffmpeg', 'linux').tests;
  assertInventory(inventory(expected), expected);
  assert.throws(() => assertInventory(inventory(expected.slice(1)), expected), /inventory differs/);
  const duplicate = inventory(expected);
  duplicate['rust-suites'].extra = duplicate['rust-suites'].surtitle;
  assert.throws(() => assertInventory(duplicate, expected), /inventory differs/);
  for (const change of [suite => { suite.kind = 'test'; }, suite => { Object.values(suite.testcases)[0].ignored = false; }]) {
    const changed = inventory(expected);
    change(changed['rust-suites'].surtitle);
    assert.throws(() => assertInventory(changed, expected), /ignored library test/);
  }
});

test('keeps package feature modes separate and archives fresh reports in unique run directories', async t => {
  const f = fixture(t), suite = selectSuite('windows-native', 'win32', 'x64'), calls = [];
  const run = fakeNextest(f, suite, (phase, group, args) => { calls.push({ phase, group, args }); });
  const first = await runRequiredSuite('windows-native', { root: f.root, platform: 'win32', architecture: 'x64', run });
  const second = await runRequiredSuite('windows-native', { root: f.root, platform: 'win32', architecture: 'x64', run });
  assert.notEqual(first.directory, second.directory);
  assert.equal(first.summary.expectedTests, 8);
  assert.equal(first.summary.groups.length, 3);
  for (const record of first.summary.groups) {
    assert.equal(record.status, 'passed');
    assert.match(readFileSync(join(first.directory, record.junit), 'utf8'), new RegExp(record.packageName));
  }
  const executions = calls.filter(call => call.phase === 'run');
  assert.equal(executions.length, 6);
  const ai = executions.find(call => call.group.packageName === 'surtitle-ai');
  assert(ai.args.includes('--no-default-features'));
  assert(!ai.args.includes('--all-features'));
  const app = executions.find(call => call.group.packageName === 'surtitle');
  assert.equal(app.args[app.args.indexOf('--features') + 1], 'e2e-test');
  assert.equal(app.args[app.args.indexOf('--run-ignored') + 1], 'only');
  assert.equal(app.args[app.args.indexOf('--no-tests') + 1], 'fail');
});

test('records discovery failures without executing the incomplete group', async t => {
  const f = fixture(t), suite = selectSuite('linux-ffmpeg', 'linux'), phases = [];
  const run = fakeNextest(f, suite, (phase, group) => {
    phases.push(`${group.packageName}:${phase}`);
    if (group.packageName === 'surtitle' && phase === 'list') return { code: 0, stdout: JSON.stringify(inventory(group.tests.slice(1))) };
  });
  await assert.rejects(runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', run }), /inventory differs/);
  assert(!phases.includes('surtitle:run'));
  assert(phases.includes('surtitle-tools:run'));
  const base = join(f.root, 'work/artifacts/required-rust-tests/linux-ffmpeg');
  const summary = JSON.parse(readFileSync(join(base, readdirSync(base)[0], 'summary.json'), 'utf8'));
  assert.equal(summary.groups[0].failurePhase, 'discovery');
  assert.equal(summary.groups[1].status, 'passed');
});

test('never reports stale JUnit as a successful run and preserves nonzero exits', async t => {
  const f = fixture(t), suite = selectSuite('linux-ffmpeg', 'linux');
  for (const code of [0, 7]) {
    writeFileSync(f.report, '<testsuites name="stale"/>');
    const run = fakeNextest(f, suite, phase => phase === 'run' ? { code } : undefined);
    await assert.rejects(runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', run }),
      code === 0 ? /no JUnit report/ : /exited 7/);
  }
});

test('an interrupted nextest run leaves later groups explicitly not run', async t => {
  const f = fixture(t), suite = selectSuite('linux-ffmpeg', 'linux');
  let calls = 0;
  const run = fakeNextest(f, suite, phase => {
    calls++;
    if (phase === 'run') return { code: 130, interrupted: true };
  });
  await assert.rejects(runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', run }), /exited 130/);
  assert.equal(calls, 2);
  const base = join(f.root, 'work/artifacts/required-rust-tests/linux-ffmpeg');
  const summary = JSON.parse(readFileSync(join(base, readdirSync(base)[0], 'summary.json'), 'utf8'));
  assert.equal(summary.groups[0].interrupted, true);
  assert.equal(summary.groups[1].status, 'not_run');
});

test('real process evidence retains both streams and the actual exit status', async t => {
  const f = fixture(t), logPrefix = join(f.root, 'child');
  const forwarded = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(bytes => { forwarded.push(String(bytes)); return true; });
  t.onTestFinished(() => stderr.mockRestore());
  const result = await execute(process.execPath, ['-e', 'console.log("child stdout"); console.error("child stderr"); process.exitCode=7'],
    { cwd: f.root, env: process.env, logPrefix, captureStdout: true });
  assert.equal(result.code, 7);
  assert.match(result.stdout, /child stdout/);
  assert.match(readFileSync(`${logPrefix}.stdout.log`, 'utf8'), /child stdout/);
  assert.match(readFileSync(`${logPrefix}.stderr.log`, 'utf8'), /child stderr/);
  assert.match(forwarded.join(''), /child stderr/);
});
