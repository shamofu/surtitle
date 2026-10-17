// SPDX-License-Identifier: GPL-3.0-or-later
import SpecReporter from '@wdio/spec-reporter';

function duration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'duration unavailable';
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${((milliseconds % 60_000) / 1000).toFixed(1)}s`;
}

export default class NativeProgressReporter extends SpecReporter {
  retriedTests = 0;

  constructor(options) {
    super({ ...options, realtimeReporting: false, addConsoleLogs: false, showPreface: false });
  }

  progress(label, item, completed = true) {
    const title = item.fullTitle || item.title;
    const elapsed = completed ? ` (${duration(item.duration)})` : '';
    const reason = item.pendingReason ? ` — ${item.pendingReason}` : '';
    this.log(label, `${title}${elapsed}${reason}`);
  }

  log(label, message) {
    // Reporter.write is buffered until the CLI's final report. Worker stdout
    // delivers progress immediately and WDIO supplies the worker-ID prefix.
    console.info(`${label.padEnd(9)} ${message}`);
  }

  onRunnerStart(runner) {
    super.onRunnerStart(runner);
    const capabilities = runner.capabilities?.alwaysMatch ?? runner.capabilities ?? {};
    const runtime = [capabilities.browserName, capabilities.browserVersion].filter(Boolean).join(' ');
    this.log('ENV', runtime || 'native runtime (not reported)');
  }

  onTestStart(test) {
    super.onTestStart(test);
    this.progress('RUN TEST', test, false);
  }

  onTestPass(test) {
    super.onTestPass(test);
    this.progress('PASS TEST', test);
  }

  onTestFail(test) {
    super.onTestFail(test);
    this.progress('FAIL TEST', test);
  }

  onTestSkip(test) {
    super.onTestSkip(test);
    this.progress('SKIP TEST', test);
  }

  onTestPending(test) {
    super.onTestPending(test);
    this.progress('PENDING TEST', test);
  }

  onTestRetry(test) {
    super.onTestRetry(test);
    this.retriedTests++;
    this.progress('RETRY TEST', test);
  }

  onHookEnd(hook) {
    super.onHookEnd(hook);
    if (hook.state === 'failed') this.progress('FAIL HOOK', hook);
  }

  onRunnerEnd(runner) {
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
    let failedHooks = 0;
    // Use the standard reporter's final events, including its retry handling,
    // rather than counting every intermediate result as a separate test.
    for (const suite of this.getOrderedSuites()) {
      for (const event of this.getEventsToReport(suite)) {
        if (event.type === 'test' && Object.hasOwn(counts, event.state)) counts[event.state]++;
        else if (event.type === 'hook' && event.state === 'failed') failedHooks++;
      }
    }
    const summary = [`${counts.passed} passed`, `${counts.failed} failed`, `${counts.skipped} skipped`];
    if (counts.pending) summary.push(`${counts.pending} pending`);
    if (this.retriedTests) summary.push(`${this.retriedTests} retried`);
    if (failedHooks) summary.push(`${failedHooks} hook failure${failedHooks === 1 ? '' : 's'}`);
    this.log('SUMMARY', `${summary.join(', ')} (${duration(runner.duration)})`);

    // Keep the standard assertion diffs and stacks without replaying successful
    // test names. A session error can occur before any suite/test exists.
    if (runner.error) this.log('ERROR', runner.error.stack || runner.error.message || String(runner.error));
    const failures = this.getFailureDisplay();
    if (failures.length) console.info(failures.join('\n'));
  }
}
