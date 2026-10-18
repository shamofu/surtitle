// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { afterEach, test, vi } from 'vitest';
import NativeProgressReporter from './native-progress-reporter.mjs';

afterEach(() => vi.restoreAllMocks());

function capture() {
  const output = vi.spyOn(console, 'info').mockImplementation(() => {});
  const reporter = new NativeProgressReporter({ color: false,
    writeStream: new Writable({ write(_chunk, _encoding, done) { done(); } }),
  });
  reporter.emit('runner:start', { cid: '0-0', specs: ['native.e2e.js'], capabilities: {} });
  return { reporter, text: () => output.mock.calls.flat().join('\n') };
}

test('a session error is retained even when no test or suite started', () => {
  const { reporter, text } = capture();
  reporter.emit('runner:end', { failures: 1, error: 'session not created\n    at driver (native.js:12:3)' });
  assert.match(text(), /ENV\s+native runtime \(not reported\)/);
  assert.match(text(), /SUMMARY\s+0 passed, 0 failed, 0 skipped/);
  assert.match(text(), /ERROR\s+session not created\n    at driver \(native\.js:12:3\)/);
  assert.doesNotMatch(text(), /RUN TEST|PASS TEST/);
});

test('pending events retain their full name without claiming execution', () => {
  const { reporter, text } = capture();
  reporter.emit('suite:start', { uid: 'suite', title: 'native setup', fullTitle: 'native setup' });
  reporter.emit('test:pending', { uid: 'pending', title: 'requires a provisioned device',
    fullTitle: 'native setup.requires a provisioned device', state: 'pending' });
  reporter.emit('suite:end', { uid: 'suite' });
  reporter.emit('runner:end', { failures: 0 });
  assert.match(text(), /PENDING TEST native setup\.requires a provisioned device \([\d.]+s\)/);
  assert.match(text(), /SUMMARY\s+0 passed, 0 failed, 0 skipped, 1 pending/);
  assert.doesNotMatch(text(), /RUN TEST|PASS TEST|"spec" Reporter/);
});
