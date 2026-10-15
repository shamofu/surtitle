// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJUnit, readPlaywright, collectReports, renderSummary } from './summarize-tests.mjs';

test('JUnit counts nested cases once and distinguishes errors, skips and repeated attempts', async () => {
  const report = await readJUnit(`<testsuites time="9"><testsuite name="one" time="4"><testcase classname="IPC" name="expected rejection" time="1"/><testcase name="transport"><error message="disconnected"/></testcase></testsuite><testsuite time="5"><testcase name="unsupported"><skipped/></testcase><testcase name="late success"><rerunFailure message="first attempt"/></testcase></testsuite></testsuites>`, 'native');
  assert.deepEqual({ passed: report.passed, failed: report.failed, skipped: report.skipped, retried: report.retried, seconds: report.seconds }, { passed: 2, failed: 1, skipped: 1, retried: 1, seconds: 9 });
  assert.deepEqual(report.failures, [{ title: 'transport', message: 'disconnected' }]);
  const startup = await readJUnit('<testsuites errors="1"><testsuite name="startup" errors="1" tests="0"/></testsuites>', 'native');
  assert.equal(startup.failed, 1);
  assert.equal(startup.failures[0].title, 'startup');
});

test('Playwright retries remain visible after a pass and setup errors cannot become success', () => {
  assert.throws(() => readPlaywright({}, 'empty'), /missing suites/);
  assert.throws(() => readPlaywright({ suites: [] }, 'empty'), /no test outcomes/);
  const report = readPlaywright({ stats: { duration: 2500 }, suites: [{ specs: [
    { title: 'flaky', tests: [{ status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }] },
    { title: 'missing control', tests: [{ status: 'unexpected', results: [{ status: 'timedOut', error: { message: 'not enabled' } }] }] },
    { title: 'excluded', tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
  ] }], errors: [{ message: 'setup failed' }] }, 'browser');
  assert.deepEqual([report.passed, report.failed, report.skipped, report.retried, report.seconds], [1, 2, 1, 1, 2.5]);
  const text = renderSummary({ results: [report], problems: [] }, { steps: { native: { outcome: 'skipped' } } });
  assert.match(text, /not enabled/);
  assert.match(text, /setup failed/);
  assert.match(text, /native: \*\*skipped/);
});

test('collection avoids double-counting browser XML and reports broken or missing evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle reports '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  assert.match(renderSummary(await collectReports(root)), /does not indicate a successful run/);
  mkdirSync(join(root, 'test-results/browser'), { recursive: true });
  writeFileSync(join(root, 'test-results/browser/results.json'), JSON.stringify({ suites: [{ specs: [{ title: 'ok', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }] }] }));
  writeFileSync(join(root, 'test-results/browser/results.xml'), '<testsuite><testcase name="ok"/></testsuite>');
  writeFileSync(join(root, 'test-results/broken.xml'), '<testsuite>');
  const report = await collectReports(root);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].passed, 1);
  assert.equal(report.problems.length, 1);
  const browser = await collectReports(root, { playwrightOnly: true });
  assert.equal(browser.results[0].passed, 1);
  assert.deepEqual(browser.problems, []);
  writeFileSync(join(root, 'test-results/browser/results.json'), '{');
  const brokenBrowser = await collectReports(root, { playwrightOnly: true });
  assert.equal(brokenBrowser.results.length, 0);
  assert.match(brokenBrowser.problems[0], /Playwright report/);
  rmSync(join(root, 'test-results/browser/results.json'));
  assert.match((await collectReports(root, { playwrightOnly: true })).problems[0], /not produced/);
  await assert.rejects(readJUnit('<!DOCTYPE x><testsuite/>', 'unsafe'), /Invalid/);
});

test('required groups retain discovery failures and unexecuted state without exposing package snapshots', async t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle report privacy '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'artifacts/required-rust-tests/windows-native/run-example');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ suite: 'windows-native', groups: [
    { packageName: 'surtitle', status: 'failed', failurePhase: 'discovery', error: 'Missing required test' },
    { packageName: 'surtitle-ai', status: 'not_run' },
  ] }));
  writeFileSync(join(root, 'artifacts/production-smoke.json'), JSON.stringify({ passed: true, initial: { secret: 'private-snapshot-token' } }));
  const nativeFailures = join(root, 'test-results/native/run-example/failures');
  mkdirSync(nativeFailures, { recursive: true });
  writeFileSync(join(nativeFailures, 'cleanup.json'), JSON.stringify({ schemaVersion: 1, stage: 'cleanup', failure: { message: 'Owned process did not terminate' }, details: { privateSnapshot: 'private-native-token' } }));
  const summary = renderSummary(await collectReports(root));
  assert.match(summary, /Missing required test/);
  assert.match(summary, /not_run/);
  assert.match(summary, /production-smoke.json/);
  assert.doesNotMatch(summary, /private-snapshot-token/);
  assert.match(summary, /\*\*cleanup\*\*: Owned process did not terminate/);
  assert.doesNotMatch(summary, /private-native-token/);
});

test.each([
  { label: 'passing reports', exitCode: 0, message: /\| test-results\/vitest\/cli.xml \| 1 \| 0 \|/ },
  { label: 'failed JUnit', exitCode: 1, message: /CLI assertion failed/,
    file: 'test-results/vitest/cli.xml',
    content: '<testsuite name="cli" tests="1" failures="1"><testcase name="assertion"><failure message="CLI assertion failed"/></testcase></testsuite>' },
  { label: 'native runner failure', exitCode: 1, message: /Readiness hook failed/,
    file: 'test-results/native/run-cli/failures/readiness.json',
    content: JSON.stringify({ schemaVersion: 1, stage: 'readiness', failure: { message: 'Readiness hook failed' } }) },
  { label: 'unexecuted required group', exitCode: 1, message: /surtitle: \*\*not_run\*\*/,
    file: 'artifacts/required-rust-tests/windows-native/run-cli/summary.json',
    content: JSON.stringify({ schemaVersion: 1, suite: 'windows-native', expectedTests: 1,
      groups: [{ packageName: 'surtitle', tests: ['required_case'], status: 'not_run' }] }) },
])('summary CLI gates $label', scenario => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle summary CLI 日本語 & '));
  try {
    // Marker-only cases include a valid passing report, so their exit cannot
    // be explained by malformed JUnit or missing test outcomes.
    mkdirSync(join(root, 'test-results/vitest'), { recursive: true });
    writeFileSync(join(root, 'test-results/vitest/cli.xml'), '<testsuite name="cli" tests="1"><testcase name="passed"/></testsuite>');
    if (scenario.file) {
      const path = join(root, scenario.file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, scenario.content);
    }
    const environment = { ...process.env, SURTITLE_CI_STEPS: '{}' };
    delete environment.GITHUB_STEP_SUMMARY;
    delete environment.GITHUB_RUN_ID;
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./summarize-tests.mjs', import.meta.url)), 'CLI contract'],
      { cwd: root, env: environment, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, scenario.exitCode, child.stderr || child.stdout);
    assert.match(child.stdout, /## CLI contract/);
    assert.match(child.stdout, scenario.message);
    assert.doesNotMatch(child.stdout, /### Report errors/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
