// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, resizeNativeWindow, saveNativeScreenshot } from '../support/native-window.mjs';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const navigate = path => browser.execute(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);

(process.platform === 'win32' ? describe : describe.skip)('motion with the real Windows video surface', () => {
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
      let reduced;
      beforeEach(async () => {
        await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false, motionPreference: preference } });
        await browser.refresh();
        await resizeNativeWindow(1440, 900);
        await navigate(`/study/${fixture.mediaId}`);
        await $('.play-button').waitForEnabled();
        await browser.waitUntil(async () => {
          const state = await player();
          return state.ready && state.surfaceVisible && state.videoWidth > 0 && state.videoHeight > 0;
        }, { timeoutMsg: 'The fixture must decode and display on the actual native surface' });
        await control({ action: 'pause' });
        await assertNativeVideoBounds();
        await browser.waitUntil(async () => browser.execute(expected => document.documentElement.dataset.motion === (expected === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'full'), preference));
        reduced = await browser.execute(() => document.documentElement.dataset.motion === 'reduce');
      });

      it('retains video geometry through panel exit and keeps player ancestors unanimated', async () => {
        await $('button=Transcript').click();
        await $('[aria-label="Subtitle list"]').waitForDisplayed();
        await browser.waitUntil(async () => (await player()).surfaceVisible);
        const initialState = await player();
        await assertNativeVideoBounds();
        await saveNativeScreenshot(resolve(`test-results/native/motion-${preference}-panel.png`));
        const observed = await browser.execute(async () => {
          const panel = document.querySelector('.study-companion');
          const viewport = document.querySelector('[data-testid="native-player-viewport"]');
          const rectangle = () => {
            const { x, y, width, height } = viewport.getBoundingClientRect();
            return { x, y, width, height };
          };
          const ancestors = () => {
            const values = [];
            for (let node = viewport; node; node = node.parentElement) {
              const css = getComputedStyle(node);
              values.push({ name: node.className || node.tagName, transform: css.transform, opacity: css.opacity });
            }
            return values;
          };
          const before = rectangle();
          const frames = [];
          return new Promise((resolveObservation, reject) => {
            let frame = 0;
            const cleanup = () => { clearTimeout(timeout); cancelAnimationFrame(frame); observer.disconnect(); };
            const sample = () => {
              if (panel.inert && !panel.hidden) frames.push({ rect: rectangle(), ancestors: ancestors() });
              if (!panel.hidden) frame = requestAnimationFrame(sample);
            };
            const observer = new MutationObserver(() => {
              if (panel.inert && !panel.hidden) frames.push({ rect: rectangle(), ancestors: ancestors() });
              if (panel.hidden) {
                cleanup();
                resolveObservation({ before, after: rectangle(), frames, finalAncestors: ancestors(), inert: panel.inert });
              }
            });
            const timeout = setTimeout(() => { cleanup(); reject(new Error('Study panel did not finish exiting within five seconds')); }, 5000);
            observer.observe(panel, { attributes: true });
            frame = requestAnimationFrame(sample);
            panel.querySelector('[aria-label="Close panel"]').click();
          });
        });
        assert.equal(observed.inert, true);
        if (!reduced) assert(observed.frames.length > 0, 'Expected to observe the animated exit before the panel disappeared');
        for (const frame of observed.frames) assert.deepEqual(frame.rect, observed.before, 'Video bounds moved while the outgoing panel was still displayed');
        for (const ancestor of [...observed.frames.flatMap(frame => frame.ancestors), ...observed.finalAncestors]) {
          assert.equal(ancestor.transform, 'none', `${ancestor.name} transformed the native video ancestor`);
          assert.equal(ancestor.opacity, '1', `${ancestor.name} faded the native video ancestor`);
        }
        assert(observed.after.width > observed.before.width, 'The video column must expand after the panel is removed');
        await browser.waitUntil(async () => (await player()).surfaceVisible);
        const finalState = await player();
        assert.equal(finalState.ready, true);
        assert.equal(finalState.videoWidth, initialState.videoWidth);
        assert.equal(finalState.videoHeight, initialState.videoHeight);
        await assertNativeVideoBounds();
        await saveNativeScreenshot(resolve(`test-results/native/motion-${preference}-panel-closed.png`));
      });

      it('retains the native modal top layer through exit and restores video visibility and focus', async () => {
        await $('button=Transcript').click();
        await $('[aria-label="Subtitle list"]').waitForDisplayed();
        await $('button=More').click();
        const opener = $('button=Playback settings');
        await opener.waitForDisplayed();
        await opener.click();
        await $('dialog').waitForDisplayed();
        await browser.waitUntil(async () => !(await player()).surfaceVisible);
        await browser.execute(() => document.querySelector('dialog').focus());
        await browser.keys(Key.Space);
        assert.equal((await player()).paused, true, 'A modal keyboard event started background playback');
        await assertNativeVideoBounds(false);
        await saveNativeScreenshot(resolve(`test-results/native/motion-${preference}-modal.png`));
        const closing = await browser.execute(async () => {
          const dialog = document.querySelector('dialog');
          return new Promise((resolveObservation, reject) => {
            let during;
            let nativeDuring;
            const cleanup = () => { clearTimeout(timeout); observer.disconnect(); };
            const observer = new MutationObserver(() => {
              if (!during && dialog.isConnected && dialog.open && dialog.dataset.state === 'closing') {
                during = {
                  topLayer: dialog.matches(':modal'),
                  inert: dialog.querySelector('.modal-body').inert,
                  closeDisabled: dialog.querySelector('.modal-header button').disabled,
                  backgroundPanelVisible: !document.querySelector('.study-companion').hidden,
                };
                nativeDuring = window.__TAURI_INTERNALS__.invoke('get_player_state').then(state => ({ surfaceVisible: state.surfaceVisible, stillInTopLayer: dialog.isConnected && dialog.matches(':modal') }));
                // Closing again must neither remove the top layer early nor reach the player.
                dialog.dispatchEvent(new Event('cancel', { cancelable: true, bubbles: true }));
                during.topLayerAfterRepeatedClose = dialog.matches(':modal');
              }
              if (!dialog.isConnected) {
                cleanup();
                Promise.resolve(nativeDuring).then(native => resolveObservation({ during, native }), reject);
              }
            });
            const timeout = setTimeout(() => { cleanup(); reject(new Error('Playback settings did not finish exiting within five seconds')); }, 5000);
            observer.observe(document.body, { attributes: true, childList: true, subtree: true });
            dialog.querySelector('.modal-header button').click();
          });
        });
        if (!reduced) {
          assert.deepEqual(closing.during, { topLayer: true, inert: true, closeDisabled: true, backgroundPanelVisible: true, topLayerAfterRepeatedClose: true });
          if (closing.native.stillInTopLayer) assert.equal(closing.native.surfaceVisible, false, 'Video became visible before the native modal left the top layer');
        }
        await expect($('dialog')).not.toExist();
        await expect($('.study-companion')).toBeDisplayed();
        await browser.waitUntil(async () => (await player()).surfaceVisible);
        await expect(opener).toBeFocused();
        assert.equal((await player()).paused, true);
        await assertNativeVideoBounds();
        await saveNativeScreenshot(resolve(`test-results/native/motion-${preference}-modal-closed.png`));
      });
    });
  }
});
