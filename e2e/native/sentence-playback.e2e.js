// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { nativeArtifact } from '../support/native-artifacts.mjs';
import { invokeNative as invoke, expectNativeRejection, restartNativeSession, clickNative } from '../support/native-app.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertOfflineFixtureLedger, readFeeLedger } from '../support/native-e2e-ledger.mjs';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const mediaId = fixture.mediaId || 'fixture-media';
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
  await clickNative($('button=Playback settings'));
  await toggle().waitForEnabled();
}
async function pausedNear(expected) {
  await browser.waitUntil(async () => { const state = await player(); return state.paused && state.positionMs >= expected; }, { timeout: 12000, timeoutMsg: `Native player did not pause at ${expected}` });
  const state = await player();
  assert(state.positionMs <= expected + 350, `Expected ${expected}, got ${state.positionMs}`);
}

describe('sentence pauses in the real native study page', () => {
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
    await clickNative(toggle());
    await browser.waitUntil(async () => (await invoke('get_app_snapshot')).settings.sentencePause === true);
    await clickNative($('button[aria-label="Close"]'));
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
    await expectNativeRejection(invoke('play_source_range', { mediaId, sourceCueIds: ['fixture-0', 'fixture-2'] }), /adjacent/);

    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'loop', startMs: 0, endMs: 2400 });
    await control({ action: 'play' });
    const observed = await browser.execute(async () => {
      let crossedSentenceEnd = false, looped = false, previous = 0;
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline && !(crossedSentenceEnd && looped)) {
        const state = await window.__TAURI_INTERNALS__.invoke('get_player_state');
        if (state.paused || state.error) return { problem: 'Sentence mode interrupted the explicit repeat', state };
        crossedSentenceEnd ||= state.positionMs > 1950;
        looped ||= previous - state.positionMs > 1200;
        previous = state.positionMs;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { crossedSentenceEnd, looped, previous };
    });
    assert(!observed.problem && observed.crossedSentenceEnd && observed.looped,
      `The native decoder did not complete the selected repeat: ${JSON.stringify(observed)}`);
    await control({ action: 'pause' });
    await control({ action: 'loop' });
    await invoke('edit_segment', { segment: { ...originals[0], startMs: 0, endMs: 900, text: 'I changed my mind.', status: 'confirmed' } });
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(900);

    await restartNativeSession();
    await openStudy();
    await expect(toggle()).toBeSelected();
    assert.equal((await player()).sentencePause, true);
    await clickNative($('button[aria-label="Close"]'));
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(900);
    await browser.saveScreenshot(nativeArtifact('sentence-playback.png'));
  });
});
