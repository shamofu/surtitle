// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Explicitly selected local experiment, excluded from the ordinary native glob.
// Real response text does not make an automated playback test human listening.
const root = process.env.SURTITLE_E2E_DATA_DIR;
assert(root && basename(root).startsWith('surtitle-e2e-saved-study-'));
const metadata = JSON.parse(readFileSync(resolve(root, 'fixture.json'), 'utf8'));
assert.equal(metadata.format, 'surtitle.offline-saved-study.v1');
const taskPath = resolve('docs/draft-study-task-set.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const taskBytes = readFileSync(taskPath);
const manifest = JSON.parse(taskBytes);
const observations = [];
let originalLedger, originalDrafts, mapped;

async function invoke(command, args = {}) {
  const result = await browser.execute(async (name, parameters) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(name, parameters) }; }
    catch (error) { return { error: String(error) }; }
  }, command, args);
  if (result.error) throw Error(`${command}: ${result.error}`);
  return result.value;
}
function ledger() {
  const db = new DatabaseSync(resolve(root, 'charges.sqlite'), { readOnly: true });
  try {
    return ['ai_jobs', 'ai_requests', 'ai_attempts', 'ai_transcript_evidence'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  } finally { db.close(); }
}
async function ready() {
  await browser.setTimeout({ script: 180000 });
  await browser.waitUntil(() => browser.execute(() => !!window.__TAURI_INTERNALS__));
  await $('h1').waitForDisplayed();
}
async function open(profile) {
  await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${profile.mediaId}`);
  const tab = $('button=Study a draft');
  await tab.waitForClickable(); await tab.click();
  const select = $('[aria-label="Study from drafts"] select');
  await select.waitForDisplayed(); await select.selectByAttribute('value', profile.jobId);
  await $('.draft-study-cue').waitForDisplayed();
  await browser.waitUntil(async () => (await invoke('get_player_state')).ready);
}

describe('saved real Transcribe responses in a local native profile', () => {
  before(async () => {
    await ready();
    assert.equal(metadata.profiles.length, 2);
    const app = await invoke('get_app_snapshot');
    assert.equal(app.settings.credentialConfigured, false);
    assert.equal(app.budget.spentUsd, 0); assert.equal(app.budget.reservedUsd, 0);
    assert.equal(app.budget.limitUsd, 0);
    originalLedger = ledger();
    originalDrafts = {};
    mapped = {};
    for (const profile of metadata.profiles) {
      const review = await invoke('get_transcript_review', { jobId: profile.jobId });
      assert.equal(review.applied, false); assert.equal(review.draft.canAdopt, false);
      originalDrafts[profile.profileId] = review.draft;
      mapped[profile.profileId] = profile;
    }
  });
  for (const task of manifest.tasks) {
    it(`bookmarks and transports ${task.id} without claiming human confirmation`, async () => {
      const profile = mapped[task.profile]; assert(profile);
      const draft = originalDrafts[task.profile];
      const ids = task.anchors.map(anchor => {
        const matches = draft.segments.filter(cue => cue.text === anchor.text && cue.startMs === anchor.startMs && cue.endMs === anchor.endMs);
        assert.equal(matches.length, 1, 'Frozen task must rebind uniquely by exact text/time');
        return matches[0].id;
      });
      await open(profile);
      const selection = await invoke('prepare_draft_selection', { request: { jobId: profile.jobId, cueIds: ids } });
      assert.equal(selection.confirmed, false); assert.equal(selection.stale, false);
      const before = await invoke('get_player_state');
      await invoke('player_control', { request: { action: 'source-seek', startMs: selection.startMs, endMs: selection.endMs } });
      await browser.waitUntil(async () => {
        const state = await invoke('get_player_state');
        return state.positionMs >= selection.startMs - 1000 && state.positionMs <= selection.endMs + 1000;
      });
      const during = await invoke('get_player_state');
      await invoke('player_control', { request: { action: 'pause' } });
      observations.push({ taskId: task.id, profile: task.profile, selectionId: selection.id, runtimeCueIds: ids,
        sourceRange: { startMs: selection.sourceStartMs, endMs: selection.sourceEndMs }, text: selection.text,
        playerReady: during.ready, observedPositionMs: during.positionMs, previousPositionMs: before.positionMs,
        operation: 'local_bookmark_and_native_seek', confirmed: false, humanListening: null, effort: null, acceptancePending: true });
      assert.deepEqual(ledger(), originalLedger);
      assert.deepEqual((await invoke('get_transcript_review', { jobId: profile.jobId })).draft, draft);
    });
  }
  it('retains all ten bookmarks after process restart and keeps both original drafts', async () => {
    assert.equal(observations.length, 10);
    await browser.reloadSession(); await ready();
    for (const profile of metadata.profiles) {
      const selections = await invoke('list_draft_selections', { mediaId: profile.mediaId });
      assert.equal(selections.length, 5);
      assert(selections.every(selection => !selection.confirmed && !selection.stale));
      assert.deepEqual((await invoke('get_transcript_review', { jobId: profile.jobId })).draft, originalDrafts[profile.profileId]);
    }
    assert.deepEqual(ledger(), originalLedger);
    await open(metadata.profiles[0]);
    const bookmarks = $('.draft-study-bookmark-list');
    const bookmark = bookmarks.$('button');
    // WDIO's wheel-based scroll does not reach this nested scroll container.
    // Only scrolling uses the DOM; the following click remains a real WebDriver action.
    await browser.execute(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), await bookmark);
    await bookmark.waitForClickable(); await bookmark.click();
    const editor = $('[aria-label="Check selected phrase"]');
    await editor.waitForDisplayed();
    await browser.execute(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), await editor);
    await browser.saveScreenshot(resolve(root, 'saved-draft-study.png'));
  });
  after(() => {
    writeFileSync(resolve(root, 'study-observations.json'), JSON.stringify({ schemaVersion: 1,
      taskManifestSha256: hash(taskBytes), sourceReportSha256: metadata.originalReportSha256,
      sourceSha256: metadata.sourceSha256, observations, completedTasks: observations.length,
      paidRequests: 0, ledgerUnchanged: originalLedger ? JSON.stringify(ledger()) === JSON.stringify(originalLedger) : null,
      humanListening: null, humanEditingEffort: null, qualityAccepted: false }, null, 2));
  });
});
