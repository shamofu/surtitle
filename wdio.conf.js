// SPDX-License-Identifier: GPL-3.0-or-later
import { basename, resolve } from 'node:path';
import { NativeWorker, initializeNativeRun } from './e2e/support/native-session.mjs';
import { nativePlatformName, nativeSpecsForPlatform } from './e2e/support/native-suite.mjs';
import { artifactIdentity } from './e2e/support/native-artifacts.mjs';
import { captureNativeFailure } from './e2e/support/native-diagnostics.mjs';
import { prepareNativeSession } from './e2e/support/native-app.mjs';
import { assertNativeRunSucceeded, recordNativeRunFailure } from './e2e/support/native-run-status.mjs';
import NativeProgressReporter from './e2e/support/native-progress-reporter.mjs';

let worker;
let startupFailure;
let testSequence = 0;
let hookSequence = 0;
const port = Number(process.env.SURTITLE_WEBDRIVER_PORT || 4444);
const fullTitle = item => typeof item.fullTitle === 'function' ? item.fullTitle() : [item.parent, item.title].filter(Boolean).join(' / ');
async function failure(kind, item, result) {
  if (!result.error) return;
  const previous = process.env.SURTITLE_E2E_TEST_ID;
  if (kind !== 'test') process.env.SURTITLE_E2E_TEST_ID = `${kind}-${++hookSequence}-${artifactIdentity(fullTitle(item))}`;
  try {
    await captureNativeFailure({ kind, title: fullTitle(item), error: result.error, sessionId: globalThis.browser?.sessionId, port });
  } catch (error) { console.error(`[native] Could not preserve ${kind} diagnostics: ${error.message}`); }
  finally {
    if (previous === undefined) delete process.env.SURTITLE_E2E_TEST_ID;
    else process.env.SURTITLE_E2E_TEST_ID = previous;
  }
}

export const config = {
  hostname: '127.0.0.1', port, specs: nativeSpecsForPlatform(), maxInstances: 1,
  capabilities: [{ maxInstances: 1, platformName: nativePlatformName(process.platform),
    'tauri:options': { application: process.env.SURTITLE_E2E_BINARY || '' } }],
  logLevel: 'warn', reporters: [NativeProgressReporter, ['junit', {
    outputDir: resolve('work/test-results/native'),
    outputFileFormat: ({ cid }) => `${process.env.SURTITLE_E2E_RUN_ID || 'run'}/${artifactIdentity(cid)}/junit.xml`,
  }]], framework: 'mocha',
  waitforTimeout: 15000, connectionRetryTimeout: 180000, connectionRetryCount: 0,
  mochaOpts: { ui: 'bdd', timeout: 300000, failZero: true, forbidOnly: true,
    rootHooks: { async beforeAll() {
      if (startupFailure) throw startupFailure;
      try { await prepareNativeSession(); }
      catch (error) {
        recordNativeRunFailure('readiness', error, { directory: worker?.directory });
        await failure('startup', { title: 'native application readiness' }, { error });
        throw error;
      }
    } },
  },
  onPrepare() { initializeNativeRun(); },
  async beforeSession(_config, _capabilities, specs, cid) {
    const reporter = _config.reporters.find(item => Array.isArray(item) && item[0] === 'junit');
    // Configure the reporter before seeding can fail. The reporter creates its
    // outputDir, but does not create parent directories in outputFileFormat.
    reporter[1].outputDir = resolve(process.env.SURTITLE_E2E_RUN_ARTIFACT_DIR, artifactIdentity(`${cid}-${basename(specs[0], '.e2e.js')}`));
    reporter[1].outputFileFormat = () => 'junit.xml';
    worker = new NativeWorker();
    try { await worker.start(specs, cid); }
    catch (error) {
      startupFailure = error;
      recordNativeRunFailure('startup', error, { cid, specs, directory: worker.directory });
      throw error;
    }
    reporter[1].outputDir = worker.directory;
  },
  beforeTest(test) {
    process.env.SURTITLE_E2E_TEST_ID = `${++testSequence}-${artifactIdentity(fullTitle(test))}`;
  },
  async afterTest(test, _context, result) { await failure('test', test, result); },
  async afterHook(test, _context, result) { await failure('hook', test, result); },
  async afterSession() {
    try { await worker?.stop(); }
    catch (error) { recordNativeRunFailure('cleanup', error, { directory: worker?.directory }); throw error; }
  },
  onComplete() { assertNativeRunSucceeded(); },
};
