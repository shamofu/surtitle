// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableWebDriverPorts, spawnWebDriver, waitForWebDriver } from './webdriver-process.mjs';
import { invokeNative, nativeScriptTimeout, prepareNativeSession, restartNativeSession, setNativeProfileVerifier } from './native-app.mjs';
import { assertLiveApproval, readCampaignTotals } from './live-api-budget.mjs';
import { withReadOnlyDatabase } from './native-e2e-database.mjs';
import { assertProfileJobIdentity } from './native-e2e-ledger.mjs';
import { plainPath, knownProfilePaths, sanitizedEnvironment } from '../../native/windows/package-production-smoke.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evaluationId = 'app.surtitle.evaluation.openai20261029';
export function requireLiveOptIn(options) { assert.equal(options?.optIn, true, 'Live session requires optIn: true'); }
export function assertLiveCommand(command) {
  assert(typeof command === 'string' && /^[a-z_]+$/.test(command), 'Invalid native command');
  assert(!['approve_quote', 'reapprove_quote', 'resolve_unknown_attempt'].includes(command), 'Use guarded approval; unknown holds cannot be cleared by the runner');
  assert(!/credential|api_key/.test(command), 'Credentials require manual UI entry');
}
export function assertLiveProfileIdentity(snapshot, dbPath) {
  // Match Ledger::list_jobs before the activity snapshot omits prepared quotes.
  const jobs = withReadOnlyDatabase(dbPath, database => database.prepare('SELECT id,state FROM ai_jobs ORDER BY created_at_ms DESC LIMIT 500').all(), { timeoutMs: 1000 });
  assert(jobs.some(job => job.state !== 'prepared'), 'An empty campaign cannot establish application identity; independently verify its profile before live use');
  assertProfileJobIdentity(snapshot, { ai_jobs: jobs });
}
export async function persistCampaignIdentity(directory, identity) {
  assert.equal(identity.appId, evaluationId, 'Only the dedicated evaluation identity is allowed');
  assert.equal(identity.capMicrousd, 60000000, 'Campaign identity cap must remain USD 60');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'campaign-identity.json');
  const encoded = JSON.stringify({ appId: identity.appId, dataRoot: identity.dataRoot, capMicrousd: identity.capMicrousd });
  try { await writeFile(file, encoded + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(JSON.stringify(JSON.parse(await readFile(file, 'utf8'))), encoded, 'Campaign identity mismatch; resume only the original profile and cap');
  }
}
function insideWorkspace(path) {
  const suffix = relative(workspace, path);
  assert(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Path must remain inside the workspace');
}
/** Opt-in normal native app. Never seed fixtures or inject credentials. The caller owns manual UI key entry. */
export async function createLiveSession(options = {}) {
  requireLiveOptIn(options);
  assert.equal(process.platform, 'win32', 'Live native session requires Windows');
  assert.equal(options.appId, evaluationId, 'Only the dedicated evaluation application is allowed');
  assert.equal(options.capMicrousd, 60000000, 'Campaign identity cap must remain USD 60');
  const capMicrousd = options.capMicrousd;
  const profile = knownProfilePaths();
  assert(isAbsolute(options.dataRoot), 'Absolute evaluation dataRoot required');
  const expected = resolve(profile.local, evaluationId);
  assert.equal(resolve(options.dataRoot).toLowerCase(), expected.toLowerCase(), 'Evaluation profile must use the real Windows LocalAppData');
  const dataRoot = plainPath(options.dataRoot, false);
  const application = plainPath(options.application, true);
  insideWorkspace(application);
  assert.equal(resolve(options.campaignDir), join(workspace, 'work/live-openai'), 'Use the persistent live campaign directory');
  await mkdir(options.campaignDir, { recursive: true });
  plainPath(options.campaignDir, false);
  await persistCampaignIdentity(options.campaignDir, { appId: options.appId, dataRoot, capMicrousd });
  const driverPath = plainPath(options.driver, true), nativeDriver = plainPath(options.nativeDriver, true);
  const dbPath = join(dataRoot, 'charges.sqlite');
  const { port, nativePort } = await availableWebDriverPorts();
  const driver = spawnWebDriver(driverPath, ['--port', String(port), '--native-port', String(nativePort), '--native-driver', nativeDriver], {
    windowsHide: true, env: sanitizedEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  driver.stdout.resume(); driver.stderr.resume();
  let session, closed = false, approving = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { if (session) await session.deleteSession(); } finally { driver.kill(); }
  };
  try {
    await waitForWebDriver(driver, { port });
    const { remote } = await import('webdriverio');
    session = await remote({ hostname: '127.0.0.1', port, logLevel: 'silent', connectionRetryCount: 0, connectionRetryTimeout: nativeScriptTimeout + 10000,
      capabilities: { 'tauri:options': { application } } });
    setNativeProfileVerifier(session, async () => {
      assertLiveProfileIdentity(await invokeNative('get_app_snapshot', {}, session), dbPath);
    });
    await prepareNativeSession(session);
    const available = () => assert(!closed, 'Live session is closed');
    return {
      session,
      invoke(command, args = {}) { available(); assertLiveCommand(command); return invokeNative(command, args, session); },
      totals() { available(); return readCampaignTotals(dbPath); },
      async approve(quote) {
        available();
        assert(!approving, 'Another approval is in progress');
        assert(Object.isFrozen(quote), 'Freeze the reviewed quote before approval');
        assert(Number.isSafeInteger(quote.aiConfigurationGeneration) && quote.aiConfigurationGeneration >= 0, 'Invalid configuration generation');
        assert(typeof quote.digest === 'string' && quote.digest.length > 0, 'Missing quote digest');
        approving = true;
        try {
          assertLiveApproval({ dbPath, quote, capMicrousd });
          return await invokeNative(quote.isRetry === true ? 'reapprove_quote' : 'approve_quote', {
            quoteId: quote.id, aiConfigurationGeneration: quote.aiConfigurationGeneration, digest: quote.digest,
            acknowledgeUnpriced: false, acknowledgeUnqualified: true, retryPolicyVersion: quote.retryPolicy?.version,
          }, session);
        } finally { approving = false; }
      },
      async restart() { available(); assert(!approving, 'Cannot restart during approval'); await restartNativeSession(session); },
      close,
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}
