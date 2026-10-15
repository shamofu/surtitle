// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const seconds = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export async function readJUnit(source, name) {
  const { XMLParser, XMLValidator } = await import('fast-xml-parser');
  if (/<!DOCTYPE/i.test(source) || XMLValidator.validate(source) !== true) throw new Error('Invalid JUnit XML');
  const xml = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(source);
  const result = { name, passed: 0, failed: 0, skipped: 0, retried: 0, seconds: 0, failures: [] };
  function suite(node) {
    const failuresBefore = result.failed;
    result.seconds += seconds(node['@_time']);
    for (const item of array(node.testcase)) {
      const title = [item['@_classname'], item['@_name']].filter(Boolean).join(' › ');
      const failures = [...array(item.failure), ...array(item.error)];
      if (failures.length) {
        result.failed++;
        const first = failures[0];
        result.failures.push({ title, message: typeof first === 'string' ? first : first['@_message'] || first['#text'] || 'Test failed' });
      } else if (Object.hasOwn(item, 'skipped')) result.skipped++;
      else result.passed++;
      result.retried += array(item.rerunFailure).length + array(item.rerunError).length;
    }
    for (const child of array(node.testsuite)) {
      // Parent suites already include the duration of their children.
      const before = result.seconds;
      suite(child);
      if (node['@_time'] != null) result.seconds = before;
    }
    // Some reporters expose startup/hook failures only on the suite. Retain
    // them without counting a parent suite's child failures a second time.
    const unlisted = Math.max(0, seconds(node['@_failures']) + seconds(node['@_errors']) - (result.failed - failuresBefore));
    if (unlisted) {
      result.failed += unlisted;
      result.failures.push({ title: node['@_name'] || 'Runner / setup', message: `${unlisted} failure(s) reported without testcase details` });
    }
  }
  if (xml.testsuites) suite(xml.testsuites);
  else if (xml.testsuite) for (const node of array(xml.testsuite)) suite(node);
  else throw new Error('JUnit has no test suites');
  return result;
}

export function readPlaywright(report, name) {
  if (!report || !Array.isArray(report.suites)) throw new Error('Invalid Playwright report: missing suites');
  const result = { name, passed: 0, failed: 0, skipped: 0, retried: 0, seconds: seconds(report.stats?.duration) / 1000, failures: [] };
  function suite(node) {
    for (const spec of node.specs ?? []) for (const test of spec.tests ?? []) {
      if (test.status === 'skipped') result.skipped++;
      else if (test.status === 'unexpected') {
        result.failed++;
        const failed = (test.results ?? []).find(item => item.status === 'failed' || item.status === 'timedOut' || item.status === 'interrupted');
        result.failures.push({ title: `${spec.file ?? node.file ?? ''} › ${spec.title}`, message: failed?.error?.message || failed?.errors?.[0]?.message || 'Test failed' });
      } else if (test.status === 'expected' || test.status === 'flaky') result.passed++;
      else throw new Error(`Invalid Playwright test status: ${test.status}`);
      result.retried += Math.max(0, (test.results?.length ?? 0) - 1);
    }
    for (const child of node.suites ?? []) suite(child);
  }
  suite(report);
  for (const error of report.errors ?? []) {
    result.failed++;
    result.failures.push({ title: 'Runner / setup', message: error.message || String(error) });
  }
  if (result.passed + result.failed + result.skipped === 0) throw new Error('Playwright report contains no test outcomes or runner errors');
  return result;
}

function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export async function collectReports(root = process.cwd(), { playwrightOnly = false } = {}) {
  const paths = (playwrightOnly ? ['test-results/browser'] : ['test-results', 'artifacts/required-rust-tests']).flatMap(directory => files(join(root, directory)));
  const results = [], problems = [], executions = [], nativeFailures = [];
  const browserJSON = join(root, 'test-results/browser/results.json');
  let browserRead = false;
  if (paths.includes(browserJSON)) {
    try { results.push(readPlaywright(JSON.parse(readFileSync(browserJSON, 'utf8')), 'Playwright')); browserRead = true; }
    catch (error) { problems.push(`Playwright report: ${error.message}`); }
  }
  // The browser job runs tests in Docker and has no host node_modules. Its JSON
  // report carries retries and runner failures without an XML-parser dependency.
  if (playwrightOnly) {
    if (!paths.includes(browserJSON)) problems.push('Playwright JSON report was not produced');
    return { results, problems, executions, nativeFailures };
  }
  for (const path of paths.filter(path => path.endsWith('.xml'))) {
    if (browserRead && path === join(root, 'test-results/browser/results.xml')) continue;
    if (path === join(root, 'test-results/nextest/required/junit.xml')) continue;
    const name = relative(root, path).replaceAll('\\', '/');
    try { results.push(await readJUnit(readFileSync(path, 'utf8'), name)); }
    catch (error) { problems.push(`${name}: ${error.message}`); }
  }
  for (const path of paths.filter(path => path.endsWith('summary.json') && path.includes(`${join('artifacts', 'required-rust-tests')}`))) {
    try {
      const report = JSON.parse(readFileSync(path, 'utf8'));
      for (const group of report.groups) executions.push({ name: `${report.suite} / ${group.packageName}`, status: group.status, phase: group.failurePhase, error: group.error });
    } catch (error) { problems.push(`${relative(root, path)}: ${error.message}`); }
  }
  for (const path of paths.filter(path => /^test-results\/native\/[^/]+\/failures\/[^/]+\.json$/.test(relative(root, path).replaceAll('\\', '/')))) {
    try {
      const report = JSON.parse(readFileSync(path, 'utf8'));
      if (report.schemaVersion !== 1 || !['startup', 'readiness', 'cleanup'].includes(report.stage) || typeof report.failure?.message !== 'string') {
        throw new Error('Invalid native runner failure report');
      }
      nativeFailures.push({ stage: report.stage, message: report.failure.message, artifact: relative(root, path).replaceAll('\\', '/') });
    } catch (error) { problems.push(`${relative(root, path)}: ${error.message}`); }
  }
  // Package probes already emit intentionally redacted JSON. Never read raw
  // production-driver logs or serialize the snapshots contained in these files.
  for (const [file, flags] of [
    ['production-smoke.json', ['passed']],
    ['installer-smoke.json', ['freshInstallPassed', 'startupPassed', 'overwriteInstallPassed', 'uninstallPassed', 'defaultDataRetentionPassed']],
  ]) {
    const path = join(root, 'artifacts', file);
    if (!existsSync(path)) continue;
    try {
      const report = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
      const passed = flags.every(flag => report[flag] === true);
      results.push({ name: file, passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0, retried: 0, seconds: 0,
        failures: passed ? [] : [{ title: file, message: 'Required package checks did not all pass' }] });
    } catch (error) { problems.push(`${file}: ${error.message}`); }
  }
  return { results, problems, executions, nativeFailures };
}

export function renderSummary({ results, problems, executions = [], nativeFailures = [] }, { label = 'Tests', steps = {}, evidenceURL } = {}) {
  const lines = [`## ${escape(label)}`, '', '| Suite | Passed | Failed | Skipped | Retries | Time (s) |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const result of results) lines.push(`| ${escape(result.name)} | ${result.passed} | ${result.failed} | ${result.skipped} | ${result.retried} | ${result.seconds.toFixed(1)} |`);
  if (!results.length) lines.push('', 'No test report was produced; this does not indicate a successful run.');
  const incomplete = Object.entries(steps).filter(([, step]) => ['failure', 'cancelled', 'skipped'].includes(step.outcome));
  if (incomplete.length) {
    lines.push('', '### Failed or unexecuted steps', '');
    for (const [name, step] of incomplete) lines.push(`- ${escape(name)}: **${escape(step.outcome)}**`);
  }
  const unfinished = executions.filter(group => group.status !== 'passed');
  if (unfinished.length) lines.push('', '### Native Rust groups', '', ...unfinished.map(group => `- ${escape(group.name)}: **${escape(group.status)}**${group.phase ? ` (${escape(group.phase)})` : ''}${group.error ? ` — ${escape(group.error)}` : ''}`));
  if (nativeFailures.length) lines.push('', '### Native runner failures', '', ...nativeFailures.map(failure =>
    `- **${escape(failure.stage)}**: ${escape(failure.message).slice(0, 600)} (${escape(failure.artifact)})`));
  const failures = results.flatMap(result => result.failures.map(failure => ({ ...failure, suite: result.name })));
  if (failures.length) {
    lines.push('', '### First reported failures', '');
    for (const failure of failures.slice(0, 10)) lines.push(`- **${escape(failure.title)}** (${escape(failure.suite)}): ${escape(failure.message).slice(0, 600)}`);
  }
  if (problems.length) lines.push('', '### Report errors', '', ...problems.map(problem => `- ${escape(problem)}`));
  lines.push('', 'Skipped tests are reported separately from steps that never ran. Test durations may overlap when tests run in parallel.');
  if (evidenceURL) lines.push('', `[Job logs and evidence artifacts](${evidenceURL})`);
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reports = await collectReports(process.cwd(), { playwrightOnly: process.argv.includes('--playwright-only') });
  let steps = {};
  try { steps = JSON.parse(process.env.SURTITLE_CI_STEPS || '{}'); }
  catch { reports.problems.push('Cannot parse CI step outcomes'); }
  const evidenceURL = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const summary = renderSummary(reports, { label: process.argv[2], steps, evidenceURL });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (reports.problems.length || reports.nativeFailures.length || reports.results.some(result => result.failed > 0) ||
      reports.executions.some(group => group.status !== 'passed')) process.exitCode = 1;
}
