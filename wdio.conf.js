// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnWebDriver } from './scripts/webdriver-process.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { createConnection } from 'node:net';

let driver;
const binary = process.env.SURTITLE_E2E_BINARY;
const dataDir = process.env.SURTITLE_E2E_DATA_DIR;
const port = Number(process.env.SURTITLE_WEBDRIVER_PORT || 4444);
function stopDriver() { if (driver && !driver.killed) driver.kill(); }
async function waitForDriver() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (driver?.exitCode !== null) throw new Error('tauri-driver exited before opening its port');
    const ready = await new Promise(resolveReady => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolveReady(true); });
      socket.once('error', () => { socket.destroy(); resolveReady(false); });
    });
    if (ready) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('tauri-driver did not become ready within 15 seconds');
}
export const config = {
  hostname: '127.0.0.1', port, specs: ['./e2e/native/**/*.e2e.js'], maxInstances: 1,
  capabilities: [{ maxInstances: 1, 'tauri:options': { application: binary || '' } }],
  logLevel: 'warn', reporters: ['spec'], framework: 'mocha',
  waitforTimeout: 15000, connectionRetryTimeout: 180000, connectionRetryCount: 0,
  // Debug Rust verifies large external executable hashes before every process.
  // A subtitle switch sequence performs several real probes and extractions.
  mochaOpts: { ui: 'bdd', timeout: 300000 },
  onPrepare() {
    if (!binary || !isAbsolute(binary) || !existsSync(binary)) throw new Error('Set SURTITLE_E2E_BINARY to an existing absolute native binary path');
    if (!dataDir || !isAbsolute(dataDir) || !existsSync(resolve(dataDir, 'fixture.json'))) throw new Error('Set SURTITLE_E2E_DATA_DIR to a disposable directory populated by seed_fixture');
    mkdirSync('test-results/native', { recursive: true });
  },
  async before() {
    // Native IPC can hash/probe large local tools. A timed-out WebDriver request
    // must never silently replay a non-idempotent mutation such as save_card.
    await browser.setTimeout({ script: 180000 });
  },
  async beforeSession() {
    const args = ['--port', String(port)];
    if (process.env.SURTITLE_NATIVE_DRIVER) args.push('--native-driver', process.env.SURTITLE_NATIVE_DRIVER);
    driver = spawnWebDriver(process.env.SURTITLE_TAURI_DRIVER || 'tauri-driver', args, { stdio: 'inherit', windowsHide: true, env: process.env });
    let launchError;
    driver.once('error', error => { launchError = error; });
    process.once('exit', stopDriver);
    await waitForDriver();
    if (launchError) throw launchError;
  },
  afterSession: stopDriver,
  onComplete: stopDriver,
  async afterTest(test, _context, result) {
    if (result.passed) return;
    const artifact = resolve('test-results/native', test.title.replace(/[^a-z0-9]+/gi, '-'));
    const diagnostics = { capturedAt: new Date().toISOString() };
    const reportError = (stage, error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[native failure diagnostics] ${stage}: ${message}`);
      return message;
    };
    try { await browser.saveScreenshot(`${artifact}.png`); }
    catch (error) { diagnostics.screenshotError = reportError('screenshot capture failed', error); }
    try {
      diagnostics.page = await browser.execute(() => {
        const rectangle = element => {
          if (!element) return null;
          const { x, y, top, right, bottom, left, width, height } = element.getBoundingClientRect();
          return { x, y, top, right, bottom, left, width, height };
        };
        const content = document.querySelector('.page-content');
        return {
          pathname: location.pathname,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          hidden: document.hidden,
          pageContent: content ? { scrollTop: content.scrollTop, rect: rectangle(content) } : null,
          nativePlayerViewport: rectangle(document.querySelector('[data-testid="native-player-viewport"]')),
          dialogPresent: !!document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"]'),
        };
      });
    } catch (error) { diagnostics.pageError = reportError('page capture failed', error); }
    try {
      diagnostics.playerState = await browser.execute(async () => {
        let timer;
        try {
          const state = await Promise.race([
            window.__TAURI_INTERNALS__.invoke('get_player_state'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('get_player_state exceeded the 5-second diagnostic limit')), 5000); }),
          ]);
          return { state };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        } finally { clearTimeout(timer); }
      });
      if (diagnostics.playerState.error) reportError('player state capture failed', diagnostics.playerState.error);
    } catch (error) { diagnostics.playerState = { error: reportError('player state capture failed', error) }; }
    try { writeFileSync(`${artifact}.json`, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8'); }
    catch (error) { reportError('JSON evidence write failed', error); }
  },
};
