// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit network acceptance test; excluded from the normal native spec glob.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const enabled = process.platform === 'win32' && process.env.SURTITLE_PUBLIC_DOWNLOAD_MANIFEST;
let manifest, root, fixture, initialSnapshot, jobId, ownedMediaId, receipt, report, verified = false;
const title = `Public download verification ${randomUUID()}`;
function assertZeroAi(snapshot) {
  assert.equal(snapshot.settings.credentialConfigured, false);
  assert.equal(snapshot.settings.dailyBudgetUsd, 0);
  assert.equal(snapshot.jobs.length, 0);
  assert.equal(snapshot.budget.limitUsd, 0);
  assert.equal(snapshot.budget.spentUsd, 0);
  assert.equal(snapshot.budget.reservedUsd, 0);
  assert.equal(snapshot.budget.unpricedAttempts, 0);
  assert.equal(snapshot.budget.unknownAttempts.length, 0);
}
function assertEmptyLedger() {
  const db = new DatabaseSync(resolve(root, 'charges.sqlite'), { readOnly: true });
  try {
    for (const table of ['ai_jobs', 'ai_requests', 'ai_attempts']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  } finally { db.close(); }
}
function assertToolsUnchanged() {
  for (const tool of manifest.tools) {
    assert.equal(realpathSync.native(tool.executable), tool.executable);
    assert.equal(hash(tool.executable), tool.sha256);
    if (tool.companion) assert.equal(hash(tool.companion.path), tool.companion.sha256);
  }
}
async function job() { return (await invoke('list_download_jobs')).find(item => item.id === jobId); }

(enabled ? describe : describe.skip)('explicit public YouTube import with selected PATH tools', () => {
  before(async () => {
    manifest = JSON.parse(readFileSync(resolve(process.env.SURTITLE_PUBLIC_DOWNLOAD_MANIFEST), 'utf8'));
    root = realpathSync.native(process.env.SURTITLE_E2E_DATA_DIR);
    fixture = JSON.parse(readFileSync(resolve(root, 'fixture.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.networkApproved, true);
    assert.equal(manifest.verifiedPublic, true);
    assert(manifest.attribution && manifest.licenseUrl && manifest.sourceEvidenceUrl);
    const url = new URL(manifest.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'www.youtube.com');
    assert.equal(url.pathname, '/watch');
    assert.equal(url.searchParams.get('v'), manifest.videoId);
    assert.equal(url.searchParams.size, 1);
    assert(!url.username && !url.password && !url.hash);
    assert(manifest.expectedDurationMs > 0 && manifest.expectedDurationMs <= 600_000);
    assert(manifest.maxStoredBytes > 0 && manifest.maxStoredBytes <= 256 * 1024 * 1024);
    assert.deepEqual(manifest.tools.map(tool => tool.id).sort(), ['deno', 'ffmpeg', 'yt-dlp']);
    assertToolsUnchanged();
    await browser.waitUntil(() => browser.execute(() => !!window.__TAURI_INTERNALS__));
    initialSnapshot = await invoke('get_app_snapshot');
    assertZeroAi(initialSnapshot); assertEmptyLedger();
    assert.equal(initialSnapshot.media.length, 1);
    assert.equal(initialSnapshot.media[0].id, fixture.mediaId);
    assert.equal(initialSnapshot.media[0].path, fixture.mediaPath);
    assert.equal(initialSnapshot.cards.length, 1);
    assert.equal(initialSnapshot.cards[0].id, fixture.cardId);
    assert.equal((await invoke('list_download_jobs')).length, 0);
    verified = true;
    await invoke('update_settings', { settings: { ...initialSnapshot.settings, locale: 'en' } });
    const candidates = await invoke('scan_external_tools');
    for (const tool of manifest.tools) {
      const selected = candidates.find(candidate => candidate.toolId === tool.id && candidate.path.toLowerCase() === tool.selectedPath.toLowerCase());
      assert(selected?.selectable, `Expected explicitly selected PATH candidate for ${tool.id}`);
      assert.equal(selected.verification, 'unverified');
      await invoke('set_tool_provider', { request: { toolId: tool.id, provider: 'external', path: tool.selectedPath } });
    }
  });
  after(async () => {
    if (!verified) return;
    if (jobId && (await job())?.status === 'running') {
      await invoke('cancel_download', { jobId });
      await browser.waitUntil(async () => (await job())?.status !== 'running', { timeout: 30000 });
    }
    const current = await invoke('get_app_snapshot');
    const owned = current.media.filter(media => media.title === title && media.sourceUrl === manifest.url);
    assert(owned.length <= 1, 'Ambiguous test-media ownership');
    ownedMediaId ??= owned[0]?.id;
    if (ownedMediaId) await invoke('remove_media', { mediaId: ownedMediaId });
    await invoke('update_settings', { settings: initialSnapshot.settings });
    assertToolsUnchanged();
    const final = await invoke('get_app_snapshot');
    assertZeroAi(final); assertEmptyLedger();
    assert.deepEqual(final.media.map(media => media.id), [fixture.mediaId]);
    assert.deepEqual(final.cards, initialSnapshot.cards);
    if (report) {
      report.fixtureRegistrationRemoved = true;
      report.externalExecutablesUnchanged = true;
      report.paidRequests = 0;
      writeFileSync(resolve(root, 'public-download-result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
  });
  it('downloads once, records exact tool versions, imports locally and plays the saved file', async () => {
    jobId = await invoke('start_url_import', { request: { kind: 'url', pathOrUrl: manifest.url, title, learningLanguage: 'en', explanationLanguage: 'ja' } });
    await browser.waitUntil(async () => {
      const current = await job(); assert(current);
      if (current.storedBytes > manifest.maxStoredBytes) {
        await invoke('cancel_download', { jobId });
        assert.fail('Public test exceeded its explicit stored-byte limit');
      }
      assert(!['failed', 'cancelled', 'interrupted'].includes(current.status), current.error || current.status);
      return current.status === 'completed';
    }, { timeout: 180000, interval: 500, timeoutMsg: 'The single public import did not finish; no retry is permitted by this test' });
    const completed = await job();
    assert.match(completed.toolReceiptId, /^[0-9a-f-]{36}$/);
    receipt = JSON.parse(readFileSync(resolve(root, 'prepared', `tools-${completed.toolReceiptId}.json`), 'utf8'));
    assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.id, completed.toolReceiptId);
    assert.equal(receipt.tools.length, 3);
    for (const expected of manifest.tools) {
      const recorded = receipt.tools.find(tool => tool.tool.selected_path.toLowerCase() === expected.selectedPath.toLowerCase());
      assert(recorded); assert.equal(recorded.tool.source, 'external');
      assert.equal(realpathSync.native(recorded.tool.executable), expected.executable);
      assert.equal(recorded.executable_sha256, expected.sha256);
      assert(recorded.probe?.version?.length && recorded.probe.capabilities?.length);
      if (expected.companion) {
        assert.equal(recorded.ffprobe_sha256, expected.companion.sha256);
        assert(recorded.probe.companion_version?.length);
      }
    }
    const snapshot = await invoke('get_app_snapshot'); assertZeroAi(snapshot);
    const media = snapshot.media.find(item => item.id === completed.mediaId);
    assert(media && media.title === title && media.sourceUrl === manifest.url);
    ownedMediaId = media.id;
    assert(existsSync(media.path));
    await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${media.id}`);
    await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.ready && state.surfaceVisible && state.videoWidth > 0; });
    await invoke('player_control', { request: { action: 'volume', value: 0 } });
    const metadata = await invoke('get_player_state');
    assert(Math.abs(metadata.durationMs - manifest.expectedDurationMs) <= 3000);
    const start = 10000, end = 11500;
    await invoke('player_control', { request: { action: 'seek', startMs: start, endMs: end } });
    await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return !state.paused && state.positionMs > start && state.positionMs < end; });
    await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.paused && state.positionMs >= end && state.positionMs <= end + 500; });
    await invoke('player_control', { request: { action: 'seek', startMs: 300000 } });
    await browser.waitUntil(async () => Math.abs((await invoke('get_player_state')).positionMs - 300000) <= 500);
    report = { passed: true, url: manifest.url, attribution: manifest.attribution, licenseUrl: manifest.licenseUrl, sourceEvidenceUrl: manifest.sourceEvidenceUrl, download: completed, toolReceipt: receipt, mediaSha256: hash(media.path), metadata, limits: { maxStoredBytes: manifest.maxStoredBytes, timeoutMs: 180000 }, retries: 0, installerLifecycleExercised: false };
  });
});
