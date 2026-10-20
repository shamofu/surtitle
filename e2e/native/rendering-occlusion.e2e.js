// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { nativeArtifact } from '../support/native-artifacts.mjs';
import { invokeNative as invoke, clickNative } from '../support/native-app.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, captureNativeScreenshotSequence, resizeNativeWindow, saveNativeScreenshot } from '../support/native-window.mjs';
import { setWebViewReducedMotion } from '../support/webview-media.mjs';
import { startNativePlaybackObservation, summarizeNativePlayback } from '../support/native-playback-observation.mjs';

const control = request => invoke('player_control', { request });
const state = () => invoke('get_player_state');
const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const contains = (rect, x, y) => x >= rect.Left && y >= rect.Top && x < rect.Right && y < rect.Bottom;
const nativeVideo = observation => observation.native.find(row => row.parent === observation.native[0].handle && row.className.toLowerCase() === 'static');

async function recordSurfaceTransition(name, selectors, opening) {
  let frames, interaction;
  const sequence = await captureNativeScreenshotSequence(nativeArtifact(`${name}.png`), async () => {
    await browser.execute((surface, enter) => {
      const observations = [], startedAt = performance.now();
      const action = document.querySelector(enter ? surface.trigger : surface.close);
      let frame, clicked;
      const observeClick = event => { clicked = { at: Date.now(), trusted: event.isTrusted }; };
      action.addEventListener('click', observeClick, { once: true, capture: true });
      const sample = () => {
        const shell = document.querySelector(surface.shell);
        const viewport = document.querySelector('[data-testid="native-player-viewport"]').getBoundingClientRect();
        const row = { at: Date.now(), elapsedMs: performance.now() - startedAt, exists: !!shell,
          viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height } };
        if (shell) {
          const style = getComputedStyle(shell), rect = shell.getBoundingClientRect();
          const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
          const heading = shell.querySelector(surface.heading).getBoundingClientRect();
          const body = shell.querySelector(surface.body).getBoundingClientRect();
          Object.assign(row, { y: matrix.m42, opacity: Number(style.opacity), scaleX: matrix.m11, scaleY: matrix.m22,
            headingOffset: heading.y - rect.y, bodyOffset: body.y - rect.y,
            painted: style.backgroundColor !== 'rgba(0, 0, 0, 0)' && Number.parseFloat(style.borderTopLeftRadius) > 0 });
        }
        observations.push(row);
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      window.__nativeSurfaceCapture = { stop() {
        cancelAnimationFrame(frame);
        action.removeEventListener('click', observeClick, { capture: true });
        return { frames: observations, interaction: clicked };
      } };
    }, selectors, opening);
    try {
      // Use the same trusted WebDriver pointer interaction as the input tests.
      // A synchronous DOM focus()+click() can race React Aria's return-focus scope.
      await clickNative($(opening ? selectors.trigger : selectors.close));
      await browser.executeAsync(done => {
        const startedAt = performance.now();
        const sample = () => {
          if (performance.now() - startedAt >= 650) done();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
    } finally {
      const observation = await browser.execute(() => {
        const result = window.__nativeSurfaceCapture.stop();
        delete window.__nativeSurfaceCapture;
        return result;
      });
      frames = observation.frames;
      interaction = observation.interaction;
    }
  });
  writeFileSync(nativeArtifact(`${name}-motion.json`), JSON.stringify({ frames, interaction, capture: sequence }, null, 2));
  assert.equal(interaction?.trusted, true, `${name}: the transition was not triggered by trusted WebDriver input`);
  const moving = frames.filter(frame => frame.exists && Math.abs(frame.y) > .1 && Math.abs(frame.y) < selectors.distance - .1);
  assert(moving.length >= 2, `${name}: the whole painted shell did not slide through intermediate positions`);
  for (let index = 1; index < moving.length; index++) {
    const advance = Math.abs(moving[index].y) - Math.abs(moving[index - 1].y);
    assert(opening ? advance <= .1 : advance >= -.1, `${name}: the shell bounced during its slide`);
  }
  for (const frame of frames.filter(frame => frame.exists)) {
    assert(Math.abs(frame.y) <= selectors.distance + .1, `${name}: the shell overshot its slide distance`);
    assert.equal(frame.painted, true, `${name}: the moving shell does not own its background and rounded corners`);
    assert.equal(frame.scaleX, 1, `${name}: the shell scaled horizontally`);
    assert.equal(frame.scaleY, 1, `${name}: the shell scaled vertically`);
    assert(Math.abs(frame.headingOffset - moving[0].headingOffset) <= 1, `${name}: the heading moved separately from its shell`);
    assert(Math.abs(frame.bodyOffset - moving[0].bodyOffset) <= 1, `${name}: the body moved separately from its shell`);
    assert.deepEqual(frame.viewport, frames[0].viewport, `${name}: dialog motion moved or resized the video`);
  }
  assert(moving.some(frame => frame.opacity > 0 && frame.opacity < 1), `${name}: the shell did not fade with its slide`);
  if (opening) {
    assert.equal(frames.at(-1).exists, true, `${name}: entrance removed the popup`);
    assert.equal(frames.at(-1).y, 0, `${name}: entrance did not settle at its placement`);
    assert.equal(frames.at(-1).opacity, 1, `${name}: entrance did not settle fully opaque`);
  } else assert.equal(frames.at(-1).exists, false, `${name}: exit did not remove the popup`);
  const first = moving[0].at, last = moving.at(-1).at;
  assert(sequence.frames.filter(frame => frame.startedAt <= last && frame.capturedAt >= first).length >= 2,
    `${name}: native screenshots missed the intermediate animation frames`);
}

describe('WebView surfaces above the real native video', () => {
  let originalSettings;
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const initial = await invoke('get_app_snapshot');
    assert.equal(initial.settings.credentialConfigured, false);
    assert(initial.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    originalSettings = initial.settings;
    await setWebViewReducedMotion(browser, 'no-preference');
    await invoke('update_settings', { settings: { ...initial.settings, locale: 'en', sentencePause: false, motionPreference: 'system' } });
    await browser.refresh();
    await browser.execute(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/study/${fixture.mediaId}`);
    await $('.play-button').waitForEnabled();
    await browser.waitUntil(async () => (await state()).ready);
    // Keep the popup-over-video geometry intentional despite the new wide
    // layout's initially open transcript.
    if ((await $('.study-transcript-toggle').getAttribute('aria-expanded')) === 'true') {
      await clickNative($('.study-transcript-toggle'));
      await expect($('.study-companion')).not.toBeDisplayed();
    }
  });
  after(async () => {
    try { await control({ action: 'pause' }); await control({ action: 'loop' }); }
    finally {
      try { if (originalSettings) await invoke('update_settings', { settings: originalSettings }); }
      finally { await setWebViewReducedMotion(browser, null); }
    }
  });

  it('records whole-shell activity and speed entrance and exit over continuously playing native video', async () => {
    await resizeNativeWindow(1280, 720);
    const repeat = { startMs: 200, endMs: 3200 };
    const surfaces = [
      { name: 'activity', shell: '.modal', heading: '.modal-header', body: '.modal-body', trigger: '.activity-trigger', close: '.modal-header .icon-button', distance: 48 },
      { name: 'speed', shell: '.playback-rate-content', heading: '.playback-rate-header', body: '.playback-rate-body', trigger: '.playback-rate-trigger', close: '.playback-rate-close', distance: 24 },
    ];
    try {
      for (const surface of surfaces) {
        await control({ action: 'seek', value: 200 });
        // Native captures can outlast the 12-second fixture. A seek clears the
        // repeat, so select its explicit bounds after each seek.
        await control({ action: 'loop', ...repeat });
        await control({ action: 'play' });
        const observation = { repeat };
        await browser.execute(startNativePlaybackObservation);
        try {
          observation.started = await state();
          const before = observation.before = await assertNativeVideoBounds();
          await recordSurfaceTransition(`live-${surface.name}-enter`, surface, true);
          const opened = observation.opened = await assertNativeVideoBounds();
          assert.deepEqual(nativeVideo(opened).regionRectangles, nativeVideo(before).regionRectangles,
            'The animated WebView surface cut a hole in the underlying video');
          assert.deepEqual(opened.dom.viewport, before.dom.viewport);
          await recordSurfaceTransition(`live-${surface.name}-exit`, surface, false);
          observation.ended = await state();
          const closed = observation.closed = await assertNativeVideoBounds();
          assert.deepEqual(nativeVideo(closed).regionRectangles, nativeVideo(before).regionRectangles,
            'Popup exit left a native clipping change');
          await expect($(surface.trigger)).toBeFocused();
          // Fast HWND captures can finish before the repeat's first wrap.
          // Observe completion explicitly rather than relying on capture cost.
          await browser.waitUntil(async () => {
            const samples = await browser.execute(() => window.__nativePlaybackObservation.read());
            return summarizeNativePlayback(samples, repeat).wraps > 0;
          }, { timeout: 15000, interval: 100, timeoutMsg: 'Native playback never completed the explicit repeat' });
        } catch (error) {
          observation.failure = String(error?.message ?? error);
          throw error;
        } finally {
          try {
            observation.playback = await browser.execute(async () => {
              try { return await window.__nativePlaybackObservation.stop(); }
              finally { delete window.__nativePlaybackObservation; }
            });
            observation.progress = summarizeNativePlayback(observation.playback.samples, repeat);
          } catch (error) {
            observation.samplingFailure = String(error?.message ?? error);
            throw error;
          } finally {
            writeFileSync(nativeArtifact(`live-${surface.name}-playback.json`), JSON.stringify(observation, null, 2));
          }
        }
        assert.deepEqual(observation.playback.errors, [], 'Native playback sampling failed during popup motion');
        assert(observation.playback.samples.length >= 2, 'Popup motion had no continuous native playback observations');
        for (const sample of [observation.started, ...observation.playback.samples, observation.ended]) {
          assert.equal(sample.paused, false, 'Popup motion paused native playback');
          assert.equal(sample.surfaceVisible, true, 'Popup motion hid native video');
          assert.equal(sample.error, null, 'Popup motion caused a native playback error');
        }
        assert(observation.progress.wraps > 0, 'Native playback never completed the explicit repeat');
        assert(observation.progress.advancedMs > 500, 'Playback stopped while the popup entered and exited');
      }
    } finally {
      try { await control({ action: 'pause' }); }
      finally { await control({ action: 'loop' }); }
    }
  });

  it('keeps video through rounded speed-popup corners and closes with its trigger in both themes', async () => {
    await resizeNativeWindow(1440, 900);
    await control({ action: 'pause' });
    await control({ action: 'seek', value: 200 });
    for (const theme of ['light', 'dark']) {
      await invoke('update_appearance', { theme });
      await browser.waitUntil(() => browser.execute(expected => document.documentElement.dataset.theme === expected, theme));
      const before = await assertNativeVideoBounds();
      const trigger = $('button[aria-label="Playback speed"]');
      await clickNative(trigger);
      await $('.playback-rate-popover').waitForDisplayed();
      await $('.playback-rate-content').waitForStable();
      const during = await assertNativeVideoBounds();
      const card = await browser.execute(() => {
        const rect = document.querySelector('.playback-rate-content').getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const viewport = during.dom.viewport, scale = during.dom.devicePixelRatio;
      const native = during.native.find(row => row.parent === during.native[0].handle && row.className.toLowerCase() === 'static');
      assert.deepEqual(native.regionRectangles, nativeVideo(before).regionRectangles, 'Speed popup changed the native video region');
      const corners = [[card.x + 1, card.y + 1], [card.x + card.width - 2, card.y + 1]]
        .filter(([x, y]) => x >= viewport.x && y >= viewport.y && x < viewport.x + viewport.width && y < viewport.y + viewport.height);
      assert(corners.length > 0, 'At least one rounded popup corner must overlap the actual video');
      for (const [x, y] of corners) assert(native.regionRectangles.some(rect => contains(rect,
        Math.floor(x * scale) - Math.round(viewport.x * scale), Math.floor(y * scale) - Math.round(viewport.y * scale))),
      'A transparent popup corner removed native video');
      assert.equal((await state()).surfaceVisible, true);
      await saveNativeScreenshot(nativeArtifact(`rounded-speed-${theme}.png`));
      await clickNative(trigger);
      await $('.playback-rate-popover').waitForExist({ reverse: true });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      await assertNativeVideoBounds();
    }
  });

  it('preserves video size, actual HWND pixels and input while an opaque dialog is open', async () => {
    const observations = [];
    for (const [width, height] of [[1280, 720], [1280, 800], [1440, 900], [1440, 940], [1920, 1080]]) {
      await resizeNativeWindow(width, height);
      await control({ action: 'seek', value: 200 });
      await control({ action: 'pause' });
      const before = await assertNativeVideoBounds();
      await saveNativeScreenshot(nativeArtifact(`redesign-video-${width}x${height}-before.png`));
      await clickNative($('button=Playback settings'));
      await $('[role="dialog"]').waitForDisplayed();
      await $('[role="dialog"]').waitForStable();
      assert(await browser.execute(() => document.querySelector('[role="dialog"]').contains(document.activeElement)),
        'Dialog entrance lost the initial focus');
      // Escape must work before a checkbox click or Tab supplies the missing focus.
      await browser.keys(Key.Escape);
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await browser.waitUntil(async () => browser.execute(() => document.activeElement?.textContent?.includes('Playback settings')));
      await clickNative($('button=Playback settings'));
      await $('[role="dialog"]').waitForDisplayed();
      await $('[role="dialog"]').waitForStable();
      const during = await assertNativeVideoBounds();
      assert.equal((await state()).surfaceVisible, true, 'Dialog hid the entire native video');
      assert.deepEqual(during.dom.viewport, before.dom.viewport, 'Dialog changed video size');
      const card = await browser.execute(() => {
        const { x, y, width, height } = document.querySelector('[role="dialog"]').getBoundingClientRect();
        return { x, y, width, height };
      });
      const native = during.native.find(row => row.parent === during.native[0].handle && row.className.toLowerCase() === 'static');
      assert(native?.regionRectangles?.length, 'Native video has no explicit retained region');
      const viewport = during.dom.viewport, scale = during.dom.devicePixelRatio;
      const overlap = { left: Math.max(viewport.x, card.x), top: Math.max(viewport.y, card.y),
        right: Math.min(viewport.x + viewport.width, card.x + card.width), bottom: Math.min(viewport.y + viewport.height, card.y + card.height) };
      assert(overlap.right > overlap.left && overlap.bottom > overlap.top, 'Test dialog does not overlap actual video');
      const x = ((overlap.left + overlap.right) / 2 - viewport.x) * scale;
      const y = ((overlap.top + overlap.bottom) / 2 - viewport.y) * scale;
      assert(native.regionRectangles.some(rect => contains(rect, x, y)), 'A dialog-shaped hole removed native video behind the WebView');
      assert.deepEqual(native.regionRectangles, nativeVideo(before).regionRectangles, 'The dialog changed native clipping');
      assert(native.regionRectangles.some(rect => rect.Right > rect.Left && rect.Bottom > rect.Top), 'All video pixels were removed');
      await control({ action: 'play' });
      await browser.waitUntil(async () => (await state()).positionMs > 500);
      assert.equal((await state()).surfaceVisible, true, 'Playback disappeared behind an open dialog');
      await control({ action: 'pause' });
      const checkbox = await $('[role="dialog"] input[type="checkbox"]');
      const selected = await checkbox.isSelected();
      await clickNative(checkbox);
      await browser.waitUntil(async () => await checkbox.isSelected() !== selected);
      await clickNative(checkbox);
      await browser.keys(Key.Tab);
      assert(await browser.execute(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), 'Tab escaped the active modal');
      await saveNativeScreenshot(nativeArtifact(`redesign-video-${width}x${height}-dialog.png`));
      await browser.keys(Key.Escape);
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await browser.waitUntil(async () => browser.execute(() => document.activeElement?.textContent?.includes('Playback settings')));
      const after = await assertNativeVideoBounds();
      const restored = after.native.find(row => row.parent === after.native[0].handle && row.className.toLowerCase() === 'static');
      assert(restored.regionRectangles.some(rect => contains(rect, x, y)), 'Closing left a stale hole in the video');
      observations.push({ width, height, devicePixelRatio: scale, viewport, card, regionRectangles: native.regionRectangles,
        immediateEscapeBeforeInteraction: true });
    }
    writeFileSync(nativeArtifact('redesign-rendering.json'), JSON.stringify({ observations,
      limits: ['Native input and clipping verified; Japanese IME and other monitor DPI values require separate execution.'] }, null, 2));
  });

  it('preserves Japanese dialog focus and captures both study layouts', async () => {
    const original = (await invoke('get_app_snapshot')).settings;
    try {
      await invoke('update_settings', { settings: { ...original, locale: 'ja', sentencePause: false } });
      await browser.refresh();
      await browser.execute(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/study/${fixture.mediaId}`);
      await $('.play-button').waitForEnabled();
      await browser.waitUntil(async () => (await state()).ready);
      for (const [width, height] of [[1440, 900], [1280, 720]]) {
        await resizeNativeWindow(width, height);
        await control({ action: 'seek', value: 200 });
        await control({ action: 'pause' });
        await assertNativeVideoBounds();
        await saveNativeScreenshot(nativeArtifact(`final-native-study-ja-${width}x${height}.png`));
        await clickNative($('button=再生設定'));
        await $('[role="dialog"]').waitForDisplayed();
        await $('[role="dialog"]').waitForStable();
        await assertNativeVideoBounds();
        assert(await browser.execute(() => document.querySelector('[role="dialog"]').contains(document.activeElement)),
          'Dialog entrance lost the Japanese focus');
        await saveNativeScreenshot(nativeArtifact(`final-native-dialog-ja-${width}x${height}.png`));
        await browser.keys(Key.Escape);
        await $('[role="dialog"]').waitForExist({ reverse: true });
        await browser.waitUntil(async () => browser.execute(() => document.activeElement?.textContent?.includes('再生設定')));
      }
    } finally { await invoke('update_settings', { settings: original }); }
  });
});
