// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { invokeNative as invoke, expectNativeRejection, restartNativeSession, prepareNativeSession, clickNative } from '../support/native-app.mjs';
import { resolve } from 'node:path';
import { withReadOnlyDatabase } from '../support/native-e2e-database.mjs';

const mediaId = 'e2e-ai-recovery';
const snapshot = () => invoke('get_app_snapshot');
const segments = () => invoke('list_segments', { mediaId });
const dialog = () => $('[role="dialog"].modal');
let jobId;
let ledgerBefore;

function attempts() {
  return withReadOnlyDatabase(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'charges.sqlite'),
    db => db.prepare('SELECT id,job_id,state,reserve_microusd,charged_microusd,usage_json FROM ai_attempts ORDER BY id').all());
}
const ready = prepareNativeSession;
async function settings() {
  await browser.execute(() => { window.history.pushState({}, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await clickNative($('#settings-nav-ai'));
  await expect($('#settings-nav-ai')).toHaveAttribute('aria-pressed', 'true');
  const review = $('button=Review saved translations');
  await review.waitForDisplayed();
  // Settings scrolls inside a smooth-scrolling panel. Native click auto-scroll
  // can stop at the footer before the animation finishes, especially in WebKit.
  // Position the real control first; the tests still click through WebDriver.
  await browser.execute(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), await review);
  await review.waitForDisplayed({ withinViewport: true });
  await review.waitForStable();
  await review.waitForClickable();
}

describe('saved AI translation recovery in the actual desktop', () => {
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
    await clickNative($('button=Review saved translations'));
    await dialog().waitForDisplayed();
    assert.equal(await dialog().$('h2').getText(), 'Review saved translations');
    assert((await dialog().getText()).includes('こんにちは。'));
    await clickNative(dialog().$('button[aria-label="Close"]'));
    await invoke('edit_segment', { segment: { ...source, text: 'An edited source.' } });
    try {
      const stale = await invoke('list_saved_ai_results', { jobId });
      assert.equal(stale[0].canApply, false);
      assert.deepEqual(stale[0].translations, pending[0].translations, 'Source changes must retain the saved output');
      await expectNativeRejection(invoke('apply_saved_ai_result', { jobId, ordinal: 0 }),
        'Prepared input changed; prepare and approve a new job');
      assert.equal((await segments())[0].translation, null);
    } finally {
      await invoke('edit_segment', { segment: source });
    }
    assert.equal((await invoke('list_saved_ai_results', { jobId }))[0].canApply, true);
    assert.deepEqual(attempts(), ledgerBefore);
  });

  it('applies locally without credentials or budget and persists through a process restart', async () => {
    const state = await snapshot();
    assert.equal(state.settings.credentialConfigured, false);
    assert.equal(state.budget.limitUsd, 0);
    await settings();
    await clickNative($('button=Review saved translations'));
    await $('button=Apply this translation').waitForEnabled();
    await clickNative($('button=Apply this translation'));
    await browser.waitUntil(async () => (await segments())[0].translation === 'こんにちは。');
    assert.deepEqual((await segments()).map(cue => cue.translation), ['こんにちは。', 'また明日。']);
    // With no pending results, the settings row and its modal unmount together.
    await expect(dialog()).not.toExist();
    // A new WebDriver session terminates and relaunches Tauri, unlike webview refresh.
    await restartNativeSession();
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
