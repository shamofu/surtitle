// SPDX-License-Identifier: GPL-3.0-or-later
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnWebDriver } from './webdriver-process.mjs';

// SQLite readers may create WAL sidecars. Keep the runner and its workers at
// the same restricted integrity as the application, including their DB reads.
const worker = fileURLToPath(new URL('./native-e2e-worker.mjs', import.meta.url));
const child = spawnWebDriver(process.execPath, [worker, 'run', './wdio.conf.js', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env });
let launchFailed = false;
let requestedSignal;
const running = () => child.pid && child.exitCode === null && child.signalCode === null;
const stop = () => { if (running()) child.kill(); };
const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
  requestedSignal = signal;
  // Windows terminates the PowerShell job owner; POSIX forwards the signal.
  if (running()) child.kill(process.platform === 'win32' ? 'SIGTERM' : signal);
}]));
for (const [signal, handler] of signalHandlers) process.once(signal, handler);
process.once('exit', stop);
child.once('error', error => {
  launchFailed = true;
  console.error(`Native E2E runner could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  process.removeListener('exit', stop);
  for (const [name, handler] of signalHandlers) process.removeListener(name, handler);
  const termination = requestedSignal || signal;
  if (termination) {
    process.exitCode = 128 + (constants.signals[termination] || 1);
    if (process.platform !== 'win32') process.kill(process.pid, termination);
  } else {
    process.exitCode = launchFailed ? 1 : (code ?? 1);
  }
});
