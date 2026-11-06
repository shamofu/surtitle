// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./run-windows-standard-user.ps1', import.meta.url));

export async function availableWebDriverPorts(port, nativePort = port === undefined ? undefined : port + 1) {
  if (port !== undefined || nativePort !== undefined) {
    assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'Invalid WebDriver port');
    assert(Number.isSafeInteger(nativePort) && nativePort > 0 && nativePort <= 65535 && nativePort !== port, 'Invalid native WebDriver port');
  }
  const listeners = [];
  try {
    for (const candidate of [nativePort ?? 0, port ?? 0]) {
      const listener = createServer();
      await new Promise((resolve, reject) => {
        listener.once('error', cause => reject(new Error(`Native driver port ${candidate} unavailable; choose an unused port pair`, { cause })));
        listener.listen({ host: '127.0.0.1', port: candidate, exclusive: true }, resolve);
      });
      listeners.push(listener);
    }
    // Keep both reservations until allocation completes so ephemeral ports
    // cannot select the same address. The driver binds them after return.
    return { port: listeners[1].address().port, nativePort: listeners[0].address().port };
  } finally {
    await Promise.all(listeners.map(listener => new Promise((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
    })));
  }
}

// WebView2 150+ ignores WebDriver's environment overrides in elevated hosts.
// Keep the tested application intact and lower the entire driver process tree
// to restricted medium integrity, including for installed production binaries.
// The Windows launcher checks groups and privileges, independently of UAC mode.
export function spawnWebDriver(application, args, options = {}) {
  const { foregroundApplication, ...spawnOptions } = options;
  if (process.platform !== 'win32') return spawn(application, args, spawnOptions);
  return spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher,
    '-Application', application, '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64'),
    ...(foregroundApplication ? ['-ForegroundApplication', foregroundApplication] : [])],
  { ...spawnOptions, windowsHide: true });
}

// The intermediary can accept TCP connections before its native driver starts.
// Probe only the read-only status endpoint, including the complete response body.
function driverReady(port, timeoutMs, signal) {
  return new Promise(resolve => {
    let response, timer, finished = false;
    const finish = ready => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      response?.destroy();
      request.destroy();
      resolve(ready);
    };
    const aborted = () => finish(false);
    const request = get({ hostname: '127.0.0.1', port, path: '/status', agent: false }, incoming => {
      response = incoming;
      incoming.on('error', () => finish(false));
      incoming.once('aborted', () => finish(false));
      if (incoming.statusCode !== 200) { finish(false); return; }
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.once('end', () => {
        try { finish(JSON.parse(body)?.value?.ready === true); }
        catch { finish(false); }
      });
    });
    request.on('error', () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function waitForWebDriver(driver, {
  port, timeoutMs = 15000, pollIntervalMs = 100, requestTimeoutMs = 1000,
}) {
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = performance.now() + timeoutMs;
  const launchFailed = error => controller.abort(error);
  const exited = () => controller.abort(new Error('WebDriver exited before becoming ready'));
  const timedOut = () => controller.abort(Object.assign(
    new Error(`WebDriver did not become ready within ${timeoutMs} milliseconds`), { code: 'ETIMEDOUT' }));
  const timer = setTimeout(timedOut, timeoutMs);
  driver.once('error', launchFailed);
  driver.once('exit', exited);
  try {
    while (true) {
      if (driver.exitCode != null || driver.signalCode != null) exited();
      const remaining = deadline - performance.now();
      if (remaining <= 0) timedOut();
      signal.throwIfAborted();
      const ready = await driverReady(port, Math.min(requestTimeoutMs, remaining), signal);
      if (performance.now() >= deadline) timedOut();
      signal.throwIfAborted();
      if (ready) return;
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())), undefined, { signal });
    }
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(timer);
    driver.removeListener('error', launchFailed);
    driver.removeListener('exit', exited);
  }
}
