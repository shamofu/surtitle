// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const mediaId = 'e2e-ai-recovery';
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const snapshot = () => invoke('get_app_snapshot');
const segments = () => invoke('list_segments', { mediaId });
let jobId;
let ledgerBefore;

function attempts() {
  const db = new DatabaseSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'charges.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT id,job_id,state,reserve_microusd,charged_microusd,usage_json FROM ai_attempts ORDER BY id').all();
  } finally { db.close(); }
}
async function ready() {
  await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__), { timeoutMsg: 'Native IPC not ready' });
  await $('h1').waitForDisplayed();
}
async function settings() {
  await browser.execute(() => { window.history.pushState({}, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await $('button=Review saved translations').waitForDisplayed();
}

(process.env.SURTITLE_E2E_AI_RECOVERY === 'translation' ? describe : describe.skip)('saved AI translation recovery in the actual desktop', () => {
  before(async () => {
    await ready();
    const state = await snapshot();
    jobId = state.jobs.find(job => job.mediaId === mediaId)?.id;
    assert(jobId, 'Fixed offline recovery fixture was not seeded');
    await invoke('update_settings', { settings: { ...state.settings, locale: 'en', dailyBudgetUsd: 0 } });
    await browser.refresh();
    await ready();
    ledgerBefore = attempts();
    const recoveryAttempts = ledgerBefore.filter(attempt => attempt.job_id === jobId);
    assert.equal(recoveryAttempts.length, 1);
    assert.equal(JSON.parse(recoveryAttempts[0].usage_json).paidRequests, 0);
  });

  it('previews persisted output and rejects application to edited subtitles', async () => {
    const source = (await segments())[0];
    assert.equal(source.translation, null);
    const pending = await invoke('list_saved_ai_results', { jobId });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].canApply, true);
    await settings();
    await $('button=Review saved translations').click();
    await $('dialog').waitForDisplayed();
    assert((await $('dialog').getText()).includes('こんにちは。'));
    await $('button[aria-label="Close"]').click();
    await invoke('edit_segment', { segment: { ...source, text: 'An edited source.' } });
    const stale = await invoke('list_saved_ai_results', { jobId });
    assert.equal(stale[0].canApply, false);
    // Serialize the application's rejection inside the webview: a WebDriver
    // transport/serialization failure must fail this test, not satisfy it.
    const application = JSON.parse(await browser.execute(async id => {
      try {
        await window.__TAURI_INTERNALS__.invoke('apply_saved_ai_result', { jobId: id, ordinal: 0 });
        return JSON.stringify({ succeeded: true });
      } catch (error) {
        return JSON.stringify({ succeeded: false, reason: String(error?.message ?? error) });
      }
    }, jobId));
    assert.deepEqual(application, {
      succeeded: false,
      reason: 'approved source subtitles changed; output was retained for review and further sending stopped',
    });
    assert.equal((await segments())[0].translation, null);
    await invoke('edit_segment', { segment: source });
    assert.equal((await invoke('list_saved_ai_results', { jobId }))[0].canApply, true);
    assert.deepEqual(attempts(), ledgerBefore);
  });

  it('applies locally without credentials or budget and persists through a process restart', async () => {
    const state = await snapshot();
    assert.equal(state.settings.credentialConfigured, false);
    assert.equal(state.budget.limitUsd, 0);
    await settings();
    await $('button=Review saved translations').click();
    await $('button=Apply this translation').waitForEnabled();
    await $('button=Apply this translation').click();
    await browser.waitUntil(async () => (await segments())[0].translation === 'こんにちは。');
    assert.deepEqual((await segments()).map(cue => cue.translation), ['こんにちは。', 'また明日。']);
    // With no pending results, the settings row and its modal unmount together.
    await expect($('dialog')).not.toExist();
    // A new WebDriver session terminates and relaunches Tauri, unlike webview refresh.
    await browser.reloadSession();
    await ready();
    const saved = await invoke('list_saved_ai_results', { jobId });
    assert.equal(saved[0].applied, true);
    assert.equal(saved[0].canApply, false);
    const after = await snapshot();
    assert.equal(after.jobs.find(job => job.id === jobId).pendingResults, 0);
    assert.equal(after.budget.spentUsd, 0);
    assert.equal(after.budget.reservedUsd, 0);
    assert.deepEqual(attempts(), ledgerBefore);
  });

  it('does not overwrite subsequent manual edits or create another paid attempt', async () => {
    const source = (await segments())[0];
    await invoke('edit_segment', { segment: { ...source, text: 'Manually revised source.', translation: '手動で直した訳。' } });
    await invoke('apply_saved_ai_result', { jobId, ordinal: 0 });
    const revised = (await segments())[0];
    assert.equal(revised.text, 'Manually revised source.');
    assert.equal(revised.translation, '手動で直した訳。');
    assert.deepEqual(attempts(), ledgerBefore);
  });
});
