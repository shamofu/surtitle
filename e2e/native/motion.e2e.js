// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { nativeArtifact } from '../support/native-artifacts.mjs';
import { invokeNative as invoke, clickNative } from '../support/native-app.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, inspectNativeWindow, resizeNativeWindow, saveNativeScreenshot } from '../support/native-window.mjs';
import { setWebViewReducedMotion } from '../support/webview-media.mjs';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const navigate = path => browser.execute(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);
const nativeVideo = windows => windows.find(window => window.visible && window.parent === windows[0].handle && window.className.toLowerCase() === 'static');

async function holdNativePlacementAcknowledgements() {
  const installed = await browser.execute(() => {
    const callbacks = window.__TAURI_INTERNALS__.callbacks;
    if (!(callbacks instanceof Map)) return false;
    const originalFetch = window.fetch;
    const restorations = [];
    const waiting = [];
    const requests = [];
    let holding = true;
    // Tauri's invoke is immutable. Intercept its actual completion callback after
    // the real Rust/libmpv placement has run, without replacing IPC or its result.
    const observedFetch = function (input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.hostname === 'ipc.localhost' && decodeURIComponent(url.pathname) === '/player_control') {
        let payload;
        try { payload = JSON.parse(typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body)); } catch { /* unrelated transport */ }
        if (payload?.request?.action === 'bounds') {
          const observation = { requestedAt: performance.now(), bounds: payload.request.bounds };
          requests.push(observation);
          const headers = new Headers(init.headers);
          for (const [header, rejected] of [['Tauri-Callback', false], ['Tauri-Error', true]]) {
            const id = Number(headers.get(header));
            const original = callbacks.get(id);
            if (typeof original !== 'function') { observation.problem = 'Native callback unavailable'; continue; }
            const wrapped = data => {
              observation.receivedAt = performance.now();
              if (rejected) observation.problem = String(data);
              const deliver = () => { observation.deliveredAt = performance.now(); original(data); };
              if (holding && !rejected) waiting.push(deliver);
              else deliver();
            };
            callbacks.set(id, wrapped);
            restorations.push({ id, original, wrapped });
          }
        }
      }
      return originalFetch.call(this, input, init);
    };
    window.fetch = observedFetch;
    window.__motionAckGate = {
      requests,
      restore() {
        holding = false;
        if (window.fetch === observedFetch) window.fetch = originalFetch;
        for (const { id, original, wrapped } of restorations) if (callbacks.get(id) === wrapped) callbacks.set(id, original);
        waiting.splice(0).forEach(deliver => deliver());
      },
    };
    return window.fetch === observedFetch;
  });
  assert(installed, 'The real native completion boundary must be available');
}

async function observeHeldAcknowledgement(kind) {
  await browser.waitUntil(async () => browser.execute(() => window.__motionAckGate.requests.some(request => request.receivedAt !== undefined)),
    { timeoutMsg: 'No real native placement response reached the test gate' });
  return browser.executeAsync((surface, done) => {
    const frames = [];
    const startedAt = performance.now();
    const sample = () => {
      const element = document.querySelector(surface === 'panel' ? '.study-companion' : '[role="dialog"]');
      const style = getComputedStyle(element);
      const dock = document.querySelector('.study-companion-dock');
      frames.push({ at: performance.now(), visibility: style.visibility, opacity: style.opacity,
        placement: document.querySelector('.native-player-viewport').dataset.nativePlacement,
        occlusion: element.dataset.nativeOcclusion ?? null,
        nativeSafeLeft: (dock.getBoundingClientRect().left + Number(dock.dataset.nativeClipLeft || 0)) * devicePixelRatio,
        inert: element.inert });
      // Hold beyond the entrance duration: a timer must not expose unacknowledged UI.
      if (performance.now() - startedAt >= 450) done(frames);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, kind);
}

async function releaseNativeAcknowledgements() {
  return browser.execute(() => {
    window.__motionAckGate?.restore();
    return window.__motionAckGate?.requests ?? [];
  });
}

async function observeNativeNavigation(selector, path, expectedMode) {
  await browser.execute(() => {
    let frame, frames = 0;
    const names = new Set(), unsafe = [];
    const sample = () => {
      const stage = document.querySelector('.page-content');
      if (!stage) return;
      frames++;
      const name = getComputedStyle(stage).viewTransitionName;
      if (name && name !== 'none') names.add(name);
      for (let node = document.querySelector('.native-player-viewport') ?? stage; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.transform !== 'none' || style.translate !== 'none' || style.opacity !== '1') {
          if (unsafe.length < 20) unsafe.push({ path: location.pathname, node: node.className || node.tagName,
            transform: style.transform, translate: style.translate, opacity: style.opacity });
        }
      }
    };
    const tick = () => { sample(); frame = requestAnimationFrame(tick); };
    tick();
    window.__nativeRouteMotion = { stop() {
      cancelAnimationFrame(frame); sample();
      return { frames, names: [...names], unsafe, mode: document.querySelector('.page-content')?.dataset.pageTransition };
    } };
  });
  try {
    await clickNative($(selector));
    await browser.waitUntil(() => browser.execute((target, mode) => {
      const stage = document.querySelector('.page-content');
      return location.pathname === target && stage?.dataset.pageTransition === mode
        && !document.activeViewTransition
        && !stage.getAnimations({ subtree: true }).some(animation =>
          (animation.pending || animation.playState === 'running') && animation.effect?.getTiming().iterations !== Infinity);
    }, path, expectedMode), { timeoutMsg: `Navigation to ${path} did not settle using ${expectedMode}` });
    const observation = await browser.execute(() => window.__nativeRouteMotion.stop());
    assert(observation.frames > 0, 'Native navigation was not observed');
    assert.deepEqual(observation.unsafe, [], 'Navigation transformed or faded the native player or route stage ancestors');
    assert.equal(observation.mode, expectedMode);
    if (expectedMode === 'view') assert(observation.names.includes('main-page'), 'The native WebView did not capture the named main page transition');
    else assert.deepEqual(observation.names, [], 'Study or reduced-motion navigation entered a view transition');
    return { path, ...observation };
  } finally {
    await browser.execute(() => { window.__nativeRouteMotion?.stop(); delete window.__nativeRouteMotion; });
  }
}

describe('stable layout with the real Windows video surface', () => {
  let originalSettings;
  let mediaEmulated = false;
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const expectedFrontend = process.env.SURTITLE_E2E_FRONTEND_SCRIPT;
    if (process.env.CI) assert(expectedFrontend, 'CI must identify the frontend built before the native executable');
    if (expectedFrontend) {
      const scripts = await browser.execute(() => Array.from(document.querySelectorAll('script[src]'), script => new URL(script.src).pathname));
      assert(scripts.includes(expectedFrontend), `The native executable must embed the current frontend ${expectedFrontend}; loaded ${scripts.join(', ')}`);
    }
    const snapshot = await invoke('get_app_snapshot');
    assert.equal(snapshot.settings.credentialConfigured, false);
    assert.equal(snapshot.budget.spentUsd, 0);
    assert(snapshot.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    originalSettings = snapshot.settings;
    // "system" follows the OS. Hosted Windows can disable animation effects,
    // so choose the tested WebView's media input without changing the host OS.
    await setWebViewReducedMotion(browser, 'no-preference');
    mediaEmulated = true;
  });
  after(async () => {
    try { await control({ action: 'pause' }); }
    finally {
      try { if (originalSettings) await invoke('update_settings', { settings: originalSettings }); }
      finally { if (mediaEmulated) await setWebViewReducedMotion(browser, null); }
    }
  });
  afterEach(async () => { await releaseNativeAcknowledgements(); });

  it('keeps native video safe through main-tab push transitions and study round trips', async () => {
    const observations = [];
    try {
      for (const preference of ['system', 'reduce']) {
        await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', theme: 'light', sentencePause: false, motionPreference: preference } });
        await browser.refresh();
        await browser.waitUntil(() => browser.execute(expected => document.documentElement.dataset.motion === expected,
          preference === 'reduce' ? 'reduce' : 'full'));
        await resizeNativeWindow(1440, 900);
        await navigate('/');
        await $('.library-page').waitForDisplayed();
        const supported = await browser.execute(() => typeof document.startViewTransition === 'function'
          && 'activeViewTransition' in document && CSS.supports('selector(:active-view-transition-type(main-page))'));
        const mainMode = preference === 'reduce' ? 'none' : supported ? 'view' : 'fallback';
        for (const path of ['/cards', '/review', '/settings', '/']) {
          observations.push({ preference, ...await observeNativeNavigation(`.main-nav a[href="${path}"]`, path, mainMode) });
          await expect($(`.main-nav a[href="${path}"]`)).toHaveAttribute('aria-current', 'page');
          if (path === '/review') await saveNativeScreenshot(nativeArtifact(`motion-main-review-${preference}.png`));
          if (path === '/settings') await saveNativeScreenshot(nativeArtifact(`motion-main-tabs-${preference}.png`));
        }
        for (let visit = 1; visit <= 2; visit++) {
          const path = `/study/${fixture.mediaId}`;
          observations.push({ preference, ...await observeNativeNavigation(`a.media-card[href="${path}"]`, path, 'none') });
          await $('.play-button').waitForEnabled();
          await browser.waitUntil(async () => {
            const state = await player();
            return state.ready && state.surfaceVisible && state.videoWidth > 0 && state.videoHeight > 0;
          });
          await control({ action: 'pause' });
          await control({ action: 'seek', value: 200 });
          await assertNativeVideoBounds();
          await saveNativeScreenshot(nativeArtifact(`motion-study-return-${preference}-${visit}.png`));
          observations.push({ preference, ...await observeNativeNavigation('.main-nav a[href="/review"]', '/review', 'none') });
          await browser.waitUntil(async () => !(await player()).surfaceVisible,
            { timeoutMsg: 'Leaving study retained the native video over the main page' });
          if (visit === 1) observations.push({ preference, ...await observeNativeNavigation('.main-nav a[href="/"]', '/', mainMode) });
        }
      }
    } finally {
      writeFileSync(nativeArtifact('motion-main-study-navigation.json'), JSON.stringify(observations, null, 2));
    }
  });

  for (const preference of ['system', 'reduce']) for (const locale of ['ja', 'en']) for (const theme of ['light', 'dark']) {
    const scenario = `${preference}-${locale}-${theme}`;
    const labels = locale === 'ja'
      ? { transcript: '字幕一覧', list: '字幕一覧', close: 'パネルを閉じる', settings: '再生設定' }
      : { transcript: 'Transcript', list: 'Subtitle list', close: 'Close panel', settings: 'Playback settings' };
    describe(scenario, () => {
      beforeEach(async () => {
        await invoke('update_settings', { settings: { ...originalSettings, locale, theme, sentencePause: false, motionPreference: preference } });
        await browser.refresh();
        assert.equal(await browser.execute(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches), false,
          'The tested WebView must retain no-preference media emulation after reload');
        await browser.waitUntil(async () => browser.execute((language, appearance, motion) => document.documentElement.lang === language
          && document.documentElement.dataset.theme === appearance && document.documentElement.dataset.motion === motion,
        locale, theme, preference === 'reduce' ? 'reduce' : 'full'));
        await resizeNativeWindow(1440, 900);
        await navigate(`/study/${fixture.mediaId}`);
        await $('.play-button').waitForEnabled();
        await browser.waitUntil(async () => {
          const state = await player();
          return state.ready && state.surfaceVisible && state.videoWidth > 0 && state.videoHeight > 0;
        });
        await control({ action: 'pause' });
        // Opening-motion cases require a closed baseline. Wide layouts now
        // start open, so close through the actual control before measuring.
        if ((await $('.study-transcript-toggle').getAttribute('aria-expanded')) === 'true') {
          await $('.study-transcript-toggle').click();
          await expect($('.study-companion')).not.toBeDisplayed();
        }
        await assertNativeVideoBounds();
      });

      it('resizes the real video beside the panel without hiding it or changing its height', async () => {
        const before = await assertNativeVideoBounds();
        await $(`button=${labels.transcript}`).click();
        await $(`[aria-label="${labels.list}"]`).waitForDisplayed();
        const during = await assertNativeVideoBounds();
        assert.equal((await player()).surfaceVisible, true, 'Panel layout hid the native video');
        assert(during.dom.viewport.width < before.dom.viewport.width, 'Opening the panel did not make room beside the video');
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
        await saveNativeScreenshot(nativeArtifact(`motion-${scenario}-panel.png`));
        await $(`.study-companion [aria-label="${labels.close}"]`).click();
        await expect($('.study-companion')).not.toBeDisplayed();
        const after = await assertNativeVideoBounds();
        assert.deepEqual(after.dom.viewport, before.dom.viewport, 'Closing did not restore the original viewport');
        await expect($(`button=${labels.transcript}`)).toBeFocused();
      });

      it('blocks modal keyboard commands while uncovered video stays visible and restores focus on Escape', async () => {
        await $(`button=${labels.transcript}`).click();
        await $(`[aria-label="${labels.list}"]`).waitForDisplayed();
        const before = await assertNativeVideoBounds();
        const opener = $(`button=${labels.settings}`);
        await opener.click();
        await $('[role="dialog"]').waitForDisplayed();
        await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-native-occlusion="pending"]')));
        const modal = await assertNativeVideoBounds();
        assert.equal((await player()).surfaceVisible, true, 'Modal entry hid the whole native video');
        assert.deepEqual(modal.dom.viewport, before.dom.viewport);
        assert(nativeVideo(modal.native)?.regionRectangles?.length, 'Native modal exclusion was not applied');
        const ancestors = await browser.execute(() => {
          const result = [];
          for (let node = document.querySelector('[role="dialog"]'); node; node = node.parentElement) {
            const css = getComputedStyle(node);
            result.push({ name: node.className || node.tagName, transform: css.transform, opacity: css.opacity });
          }
          return result;
        });
        for (const ancestor of ancestors) {
          assert.equal(ancestor.transform, 'none', `${ancestor.name} transformed the native modal exclusion`);
          assert.equal(ancestor.opacity, '1', `${ancestor.name} faded the native modal exclusion`);
        }
        await browser.execute(() => document.querySelector('[role="dialog"]').focus());
        await browser.keys(Key.Space);
        assert.equal((await player()).paused, true, 'Modal Space started background playback');
        assert.equal((await player()).surfaceVisible, true, 'Modal hid all native video');
        await saveNativeScreenshot(nativeArtifact(`motion-${scenario}-modal.png`));
        await browser.keys(Key.Escape);
        await expect($('[role="dialog"]')).not.toExist();
        await expect($('.study-companion')).toBeDisplayed();
        await expect(opener).toBeFocused();
        assert.equal((await player()).paused, true);
        await assertNativeVideoBounds();
      });

      it('protects drawer pixels and withholds modals until real native placement responses are delivered', async () => {
        const before = await assertNativeVideoBounds();
        const observations = [];
        for (const kind of ['panel', 'modal']) {
          await holdNativePlacementAcknowledgements();
          try {
            await $(`button=${kind === 'panel' ? labels.transcript : labels.settings}`).click();
            const frames = await observeHeldAcknowledgement(kind);
            assert(frames.length > 0, 'The held response must be observed before release');
            for (const frame of frames) {
              assert.equal(frame.placement, 'pending', 'Native placement was acknowledged before response delivery');
              if (kind === 'modal') {
                assert.equal(frame.visibility, 'hidden', 'Modal became visible before native acknowledgement');
                assert.equal(frame.occlusion, 'pending');
              } else assert.equal(frame.inert, true, 'An unacknowledged drawer became interactive');
            }
            const native = await inspectNativeWindow();
            const video = nativeVideo(native);
            assert(video, 'A delayed response must not hide the native video');
            if (kind === 'modal') assert(video.regionRectangles?.length, 'The real native exclusion must precede its delayed acknowledgement');
            else for (const frame of frames) assert(frame.nativeSafeLeft >= video.screen.Right - native[0].origin.X - 1,
              'Visible drawer pixels overlapped possible native video bounds');
            if (locale === 'ja' && theme === 'light') await saveNativeScreenshot(nativeArtifact(`motion-${scenario}-${kind}-pending.png`));
            const requests = await releaseNativeAcknowledgements();
            assert(requests.some(request => request.deliveredAt - request.receivedAt >= 450), 'A real native response was not delayed');
            assert(!requests.some(request => request.problem), 'A native placement request failed');
            observations.push({ kind, frames, requests, native });
            await browser.waitUntil(async () => browser.execute(() => document.querySelector('.native-player-viewport').dataset.nativePlacement === 'ready'));
            if (kind === 'panel') await $(`[aria-label="${labels.list}"]`).waitForDisplayed();
            else await $('[role="dialog"]').waitForDisplayed();
            const settled = await assertNativeVideoBounds();
            assert.equal(settled.dom.viewport.height, before.dom.viewport.height);
          } finally { await releaseNativeAcknowledgements(); }
        }
        writeFileSync(nativeArtifact(`motion-${scenario}-delayed-ack.json`), JSON.stringify(observations, null, 2));
        await browser.keys(Key.Escape);
        await expect($('[role="dialog"]')).not.toExist();
        await expect($(`button=${labels.settings}`)).toBeFocused();
        await assertNativeVideoBounds();
      });
    });
  }
});
