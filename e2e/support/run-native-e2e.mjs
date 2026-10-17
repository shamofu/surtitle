// SPDX-License-Identifier: GPL-3.0-or-later
import { constants } from 'node:os';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createNativeCliOutput } from './native-cli-output.mjs';
import { spawnWebDriver } from './webdriver-process.mjs';

// SQLite readers may create WAL sidecars. Keep the runner and its workers at
// the same restricted integrity as the application, including their DB reads.
const workerFlag = '--surtitle-native-e2e-worker';
if (process.argv[2] === workerFlag) {
  process.argv.splice(2, 1);
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
  const { run } = await import('@wdio/cli');
  await run();
} else {
  const worker = fileURLToPath(import.meta.url);
  // DOM/IPC specs do not need OS foreground ownership. Opt in only for an
  // explicit native-pointer run; Windows may legitimately deny activation.
  const foregroundApplication = process.env.SURTITLE_E2E_NATIVE_INPUT === '1'
    ? process.env.SURTITLE_E2E_BINARY : undefined;
  const child = spawnWebDriver(process.execPath, [worker, workerFlag, 'run', './wdio.conf.js', ...process.argv.slice(2)],
    { stdio: ['inherit', 'pipe', 'inherit'], env: process.env, foregroundApplication });
  let launchFailed = false;
  let requestedSignal;
  const output = createNativeCliOutput();
  const outputDone = finished(output, { cleanup: true }).then(() => new Promise(resolve => {
    // A signal must not terminate the wrapper before the final output drains.
    process.stdout.write('', resolve);
  })).catch(error => {
    launchFailed = true;
    console.error(`Native E2E runner output failed: ${error.message}`);
  });
  child.stdout.once('error', error => output.destroy(error));
  child.stdout.pipe(output).pipe(process.stdout, { end: false });
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
  child.once('close', async (code, signal) => {
    await outputDone;
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
}
