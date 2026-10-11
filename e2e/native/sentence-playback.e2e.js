// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertOfflineFixtureLedger, readFeeLedger } from '../support/native-e2e-ledger.mjs';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const mediaId = fixture.mediaId || 'fixture-media';
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const toggle = () => $('//label[contains(., "Pause at the end of a caption group")]/input[@type="checkbox"]');
let originals = [], originalSettings, isolationVerified = false, ledgerBefore;

// Only inspect the explicitly seeded directory, including hidden prepared jobs.
const ledger = () => readFeeLedger(process.env.SURTITLE_E2E_DATA_DIR);

async function openStudy() {
  await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
  await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${mediaId}`);
  await browser.waitUntil(async () => { const state = await player(); return state.ready && state.surfaceVisible && state.videoWidth > 0; });
  await $('button=Playback settings').click();
  await toggle().waitForEnabled();
}
async function pausedNear(expected) {
  await browser.waitUntil(async () => { const state = await player(); return state.paused && state.positionMs >= expected; }, { timeout: 12000, timeoutMsg: `Native player did not pause at ${expected}` });
  const state = await player();
  assert(state.positionMs <= expected + 350, `Expected ${expected}, got ${state.positionMs}`);
}

(process.platform === 'win32' ? describe : describe.skip)('sentence pauses in the real native study page', () => {
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const initial = await invoke('get_app_snapshot');
    assert.equal(initial.settings.credentialConfigured, false, 'Refusing to mutate a profile with credentials');
    assert.equal(initial.budget.spentUsd, 0, 'Expected a fresh disposable ledger');
    assert.equal(initial.budget.reservedUsd, 0, 'Expected no pending reservations');
    assert.equal(initial.budget.limitUsd, 0, 'Expected the disposable zero budget');
    assert.equal(initial.settings.dailyBudgetUsd, 0, 'Expected the disposable zero budget setting');
    assert.equal(initial.budget.unknownAttempts?.length ?? 0, 0, 'Expected no unknown attempts');
    assert.equal(initial.budget.unpricedAttempts ?? 0, 0, 'Expected no unpriced attempts');
    assert(initial.media.some(media => media.id === mediaId && media.path === fixture.mediaPath), 'Refusing to mutate a profile without the exact disposable fixture');
    ledgerBefore = ledger();
    assertOfflineFixtureLedger(initial, ledgerBefore);
    isolationVerified = true;
    originalSettings = initial.settings;
    await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false } });
    const all = await invoke('list_segments', { mediaId });
    originals = ['fixture-0', 'fixture-1', 'fixture-2'].map(id => all.find(cue => cue.id === id));
    assert(originals.every(Boolean));
    const text = ['I would like', 'to go home.', 'We can leave now.'];
    for (let i = 0; i < originals.length; i++) await invoke('edit_segment', { segment: { ...originals[i], startMs: i * 1000, endMs: i * 1000 + 900, text: text[i], status: 'confirmed' } });
    await browser.refresh();
    await openStudy();
    await control({ action: 'rate', value: 1 });
  });
  after(async () => {
    if (!isolationVerified) return;
    await control({ action: 'pause' });
    await control({ action: 'loop' });
    for (const segment of originals.filter(Boolean)) await invoke('edit_segment', { segment });
    if (originalSettings) await invoke('update_settings', { settings: originalSettings });
    assert.deepEqual(ledger(), ledgerBefore, 'Playback must leave every fixture job, request, attempt, approval and budget unchanged');
  });
  it('persists the toggle, stops at joined cue ends, prioritizes source ranges and repeat, and refreshes edited boundaries', async () => {
    await expect(toggle()).not.toBeSelected();
    await toggle().click();
    await browser.waitUntil(async () => (await invoke('get_app_snapshot')).settings.sentencePause === true);
    await $('button[aria-label="Close"]').click();
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(1900);
    await control({ action: 'play' });
    await pausedNear(2900);

    await invoke('play_source_range', { mediaId, sourceCueIds: originals.map(cue => cue.id) });
    await browser.waitUntil(async () => {
      const state = await player();
      return !state.paused && state.positionMs > 0 && state.positionMs < 1200;
    }, { timeout: 8000, interval: 50, timeoutMsg: 'Source replay never advanced near the start of its new range' });
    await pausedNear(2900);
    const rejected = await browser.execute(async id => {
      try { await window.__TAURI_INTERNALS__.invoke('play_source_range', { mediaId: id, sourceCueIds: ['fixture-0', 'fixture-2'] }); return ''; }
      catch (error) { return String(error); }
    }, mediaId);
    assert.match(rejected, /adjacent/);

    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'loop', startMs: 0, endMs: 2400 });
    await control({ action: 'play' });
    let crossedSentenceEnd = false, looped = false, previous = 0;
    const deadline = Date.now() + 3400;
    while (Date.now() < deadline) {
      const state = await player();
      assert(!state.paused, 'Sentence mode interrupted the explicit repeat');
      crossedSentenceEnd ||= state.positionMs > 1950;
      looped ||= previous > 1900 && state.positionMs < 500;
      previous = state.positionMs;
      await browser.pause(75);
    }
    assert(crossedSentenceEnd && looped, 'The native decoder did not complete the selected repeat');
    await control({ action: 'pause' });
    await control({ action: 'loop' });
    await invoke('edit_segment', { segment: { ...originals[0], startMs: 0, endMs: 900, text: 'I changed my mind.', status: 'confirmed' } });
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(900);

    await browser.reloadSession();
    await openStudy();
    await expect(toggle()).toBeSelected();
    assert.equal((await player()).sentencePause, true);
    await $('button[aria-label="Close"]').click();
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(900);
    await browser.saveScreenshot(resolve('test-results/native/sentence-playback.png'));
  });
});
