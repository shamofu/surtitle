// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, resizeNativeWindow, sampleNativeVideoBounds, saveNativeScreenshot } from '../support/native-window.mjs';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const navigate = path => browser.execute(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);
const nativeVideo = windows => windows.find(window => window.visible && window.parent === windows[0].handle && window.className.toLowerCase() === 'static');

(process.platform === 'win32' ? describe : describe.skip)('stable layout with the real Windows video surface', () => {
  let originalSettings;
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    if (process.env.SURTITLE_E2E_FRONTEND_SCRIPT) {
      const scripts = await browser.execute(() => Array.from(document.querySelectorAll('script[src]'), script => new URL(script.src).pathname));
      assert(scripts.includes(process.env.SURTITLE_E2E_FRONTEND_SCRIPT), 'The native executable must embed the current frontend');
    }
    const snapshot = await invoke('get_app_snapshot');
    assert.equal(snapshot.settings.credentialConfigured, false);
    assert.equal(snapshot.budget.spentUsd, 0);
    assert(snapshot.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    originalSettings = snapshot.settings;
  });
  after(async () => {
    try { await control({ action: 'pause' }); }
    finally { if (originalSettings) await invoke('update_settings', { settings: originalSettings }); }
  });

  for (const preference of ['system', 'reduce']) {
    describe(preference, () => {
      beforeEach(async () => {
        await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false, motionPreference: preference } });
        await browser.refresh();
        await resizeNativeWindow(1440, 900);
        await navigate(`/study/${fixture.mediaId}`);
        await $('.play-button').waitForEnabled();
        await browser.waitUntil(async () => {
          const state = await player();
          return state.ready && state.surfaceVisible && state.videoWidth > 0 && state.videoHeight > 0;
        });
        await control({ action: 'pause' });
        await assertNativeVideoBounds();
      });

      it('changes panel layout once without animating video geometry or hiding the native surface', async () => {
        const before = await assertNativeVideoBounds();
        const trace = await sampleNativeVideoBounds(async () => {
          await $('button=Transcript').click();
          await $('[aria-label="Subtitle list"]').waitForDisplayed();
          return assertNativeVideoBounds();
        }, `motion-${preference}-native-panel-open.json`);
        const during = trace.result;
        for (const sample of trace.samples) assert(nativeVideo(sample.windows), 'Panel layout hid the native video');
        assert.equal(during.dom.viewport.height, before.dom.viewport.height, 'Panel opening reduced video height');
        const layout = await browser.execute(() => {
          const viewport = document.querySelector('[data-testid="native-player-viewport"]');
          const ancestors = [];
          for (let node = viewport; node; node = node.parentElement) {
            const css = getComputedStyle(node);
            ancestors.push({ name: node.className || node.tagName, transform: css.transform, opacity: css.opacity });
          }
          const video = viewport.getBoundingClientRect(), panel = document.querySelector('.study-companion').getBoundingClientRect();
          return { ancestors, adjacent: video.right <= panel.left + 1 || video.bottom <= panel.top + 1 };
        });
        assert(layout.adjacent, 'Study content overlaps the video without an exclusion');
        for (const ancestor of layout.ancestors) {
          assert.equal(ancestor.transform, 'none', `${ancestor.name} transformed the native video`);
          assert.equal(ancestor.opacity, '1', `${ancestor.name} faded the native video`);
        }
        await saveNativeScreenshot(resolve(`test-results/native/motion-${preference}-panel.png`));
        await $('.study-companion [aria-label="Close panel"]').click();
        await expect($('.study-companion')).not.toBeDisplayed();
        const after = await assertNativeVideoBounds();
        assert.deepEqual(after.dom.viewport, before.dom.viewport, 'Closing did not restore the original viewport');
        await expect($('button=Transcript')).toBeFocused();
      });

      it('blocks modal keyboard commands while uncovered video stays visible and restores focus on Escape', async () => {
        await $('button=Transcript').click();
        await $('[aria-label="Subtitle list"]').waitForDisplayed();
        const before = await assertNativeVideoBounds();
        const opener = $('button=Playback settings');
        await opener.click();
        await $('[role="dialog"]').waitForDisplayed();
        await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-native-occlusion="pending"]')));
        const modal = await assertNativeVideoBounds();
        assert.deepEqual(modal.dom.viewport, before.dom.viewport);
        assert(nativeVideo(modal.native)?.regionRectangles?.length, 'Native modal exclusion was not applied');
        await browser.execute(() => document.querySelector('[role="dialog"]').focus());
        await browser.keys(Key.Space);
        assert.equal((await player()).paused, true, 'Modal Space started background playback');
        assert.equal((await player()).surfaceVisible, true, 'Modal hid all native video');
        await saveNativeScreenshot(resolve(`test-results/native/motion-${preference}-modal.png`));
        await browser.keys(Key.Escape);
        await expect($('[role="dialog"]')).not.toExist();
        await expect($('.study-companion')).toBeDisplayed();
        await expect(opener).toBeFocused();
        assert.equal((await player()).paused, true);
        await assertNativeVideoBounds();
      });
    });
  }
});
