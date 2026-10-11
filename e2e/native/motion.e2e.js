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
const assertContinuousNativeResize = trace => {
  const widths = trace.samples.map(sample => {
    const root = sample.windows[0];
    const video = sample.windows.find(window => window.visible && window.parent === root.handle && window.className.toLowerCase() === 'static');
    assert(video, 'The decoded native video disappeared during the drawer movement');
    return video.screen.Right - video.screen.Left;
  });
  const minimum = Math.min(...widths);
  const maximum = Math.max(...widths);
  assert(new Set(widths.filter(width => width > minimum + 2 && width < maximum - 2)).size > 2,
    'The actual native video HWND did not resize through intermediate drawer positions');
};

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

      it('resizes the video continuously with the subtitle drawer and keeps player ancestors unanimated', async () => {
        const openingTrace = await sampleNativeVideoBounds(async () => {
          await $('button=Transcript').click();
          await $('[aria-label="Subtitle list"]').waitForDisplayed();
          await browser.waitUntil(async () => (await player()).surfaceVisible);
        }, `motion-${preference}-native-drawer-open.json`);
        if (!reduced) assertContinuousNativeResize(openingTrace);
        const initialState = await player();
        await assertNativeVideoBounds();
        await saveNativeScreenshot(resolve(`test-results/native/motion-${preference}-panel.png`));
        const nativeTrace = await sampleNativeVideoBounds(async () => {
          // Keep the WebDriver command short: waiting inside execute for the
          // animation can delay WebView IPC delivery on Windows.
          await browser.execute(() => {
          const panel = document.querySelector('.study-companion');
          const dock = document.querySelector('.study-companion-dock');
          const rail = document.querySelector('.study-transcript-rail');
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
          const dockRight = dock.getBoundingClientRect().right;
          const paneWidth = panel.getBoundingClientRect().width;
          const started = performance.now();
          const frameState = () => ({ rect: rectangle(), ancestors: ancestors(), dockRight: dock.getBoundingClientRect().right,
            at: performance.now() - started, railLeft: rail.getBoundingClientRect().left, paneWidth: panel.getBoundingClientRect().width });
          const frames = [];
          window.__surtitleNativeDrawerObservation = undefined;
          {
            let frame = 0;
            const cleanup = () => { clearTimeout(timeout); cancelAnimationFrame(frame); observer.disconnect(); };
            const sample = () => {
              if (panel.inert && !panel.hidden) frames.push(frameState());
              if (!panel.hidden) frame = requestAnimationFrame(sample);
            };
            const observer = new MutationObserver(() => {
              if (panel.inert && !panel.hidden) frames.push(frameState());
              if (panel.hidden) {
                cleanup();
                window.__surtitleNativeDrawerObservation = { before, after: rectangle(), dockRight, paneWidth, frames, finalAncestors: ancestors(), inert: panel.inert };
              }
            });
            const timeout = setTimeout(() => { cleanup(); window.__surtitleNativeDrawerObservation = { error: 'Study panel did not finish exiting within five seconds' }; }, 5000);
            observer.observe(panel, { attributes: true });
            frame = requestAnimationFrame(sample);
          }
          });
          await $('.study-transcript-toggle').click();
          await browser.waitUntil(() => browser.execute(() => !!window.__surtitleNativeDrawerObservation));
          const observation = await browser.execute(() => {
            const value = window.__surtitleNativeDrawerObservation;
            delete window.__surtitleNativeDrawerObservation;
            return value;
          });
          assert(!observation.error, observation.error);
          return observation;
        }, `motion-${preference}-native-drawer.json`);
        const observed = nativeTrace.result;
        assert.equal(observed.inert, true);
        if (!reduced) {
          const intermediate = observed.frames.filter(frame => frame.rect.width > observed.before.width + 2 && frame.rect.width < observed.after.width - 2);
          assert(new Set(intermediate.map(frame => Math.round(frame.rect.width))).size > 2, 'Native video must resize through intermediate drawer positions');
          assertContinuousNativeResize(nativeTrace);
        }
        for (const frame of observed.frames) {
          assert(frame.rect.x + frame.rect.width <= frame.railLeft + 1, 'The subtitle rail overlapped the native video during resize');
          assert(Math.abs(frame.dockRight - observed.dockRight) < 1, 'The drawer right edge moved');
          assert(Math.abs(frame.paneWidth - observed.paneWidth) < 1, 'The subtitle text pane changed width during the animation');
        }
        for (const ancestor of [...observed.frames.flatMap(frame => frame.ancestors), ...observed.finalAncestors]) {
          assert.equal(ancestor.transform, 'none', `${ancestor.name} transformed the native video ancestor`);
          assert.equal(ancestor.opacity, '1', `${ancestor.name} faded the native video ancestor`);
        }
        assert(observed.after.width > observed.before.width, 'The video column must finish expanded when the drawer closes');
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
        const opener = $('button=Playback settings');
        await opener.waitForDisplayed();
        await opener.click();
        await $('dialog').waitForDisplayed();
        await browser.waitUntil(async () => !(await player()).surfaceVisible);
        const hiddenTrace = await sampleNativeVideoBounds(async () => {
          await browser.execute(() => document.querySelector('dialog').focus());
          await browser.keys(Key.Space);
          assert.equal((await player()).paused, true, 'A modal keyboard event started background playback');
        }, `motion-${preference}-native-modal.json`);
        for (const sample of hiddenTrace.samples) {
          const root = sample.windows[0];
          assert(!sample.windows.some(window => window.visible && window.parent === root.handle && window.className.toLowerCase() === 'static'),
            'A stale bounds update made the native video reappear above the modal');
        }
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
