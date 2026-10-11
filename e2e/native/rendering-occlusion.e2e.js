// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, resizeNativeWindow, saveNativeScreenshot } from '../support/native-window.mjs';

const invoke = (command, args = {}) => browser.execute(async (name, value) => window.__TAURI_INTERNALS__.invoke(name, value), command, args);
const control = request => invoke('player_control', { request });
const state = () => invoke('get_player_state');
const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const contains = (rect, x, y) => x >= rect.Left && y >= rect.Top && x < rect.Right && y < rect.Bottom;

(process.platform === 'win32' ? describe : describe.skip)('opaque UI above the real native video', () => {
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const initial = await invoke('get_app_snapshot');
    assert.equal(initial.settings.credentialConfigured, false);
    assert(initial.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    await invoke('update_settings', { settings: { ...initial.settings, locale: 'en', sentencePause: false } });
    await browser.refresh();
    await browser.execute(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/study/${fixture.mediaId}`);
    await $('.play-button').waitForEnabled();
    await browser.waitUntil(async () => (await state()).ready);
  });
  after(async () => { await control({ action: 'pause' }); await control({ action: 'loop' }); });

  it('preserves video size, actual HWND pixels and input while an opaque dialog is open', async () => {
    const observations = [];
    for (const [width, height] of [[1024, 700], [1280, 800], [1440, 900], [1440, 940]]) {
      await resizeNativeWindow(width, height);
      await control({ action: 'seek', value: 200 });
      await control({ action: 'pause' });
      const before = await assertNativeVideoBounds();
      await saveNativeScreenshot(resolve(`test-results/native/redesign-video-${width}x${height}-before.png`));
      await $('button=Playback settings').click();
      await $('[role="dialog"]').waitForDisplayed();
      await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-native-occlusion="pending"]')));
      assert(await browser.execute(() => document.querySelector('[role="dialog"]').contains(document.activeElement)),
        'Native occlusion acknowledgement lost the initial dialog focus');
      // Escape must work before a checkbox click or Tab supplies the missing focus.
      await browser.keys(Key.Escape);
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await browser.waitUntil(async () => browser.execute(() => document.activeElement?.textContent?.includes('Playback settings')));
      await $('button=Playback settings').click();
      await $('[role="dialog"]').waitForDisplayed();
      await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-native-occlusion="pending"]')));
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
      assert(!native.regionRectangles.some(rect => contains(rect, x, y)), 'Native pixels still cover the opaque dialog');
      assert(native.regionRectangles.some(rect => rect.Right > rect.Left && rect.Bottom > rect.Top), 'All video pixels were removed');
      await control({ action: 'play' });
      await browser.waitUntil(async () => (await state()).positionMs > 500);
      assert.equal((await state()).surfaceVisible, true, 'Playback disappeared behind an open dialog');
      await control({ action: 'pause' });
      const checkbox = await $('[role="dialog"] input[type="checkbox"]');
      const selected = await checkbox.isSelected();
      await checkbox.click();
      await browser.waitUntil(async () => await checkbox.isSelected() !== selected);
      await checkbox.click();
      await browser.keys(Key.Tab);
      assert(await browser.execute(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), 'Tab escaped the active modal');
      await saveNativeScreenshot(resolve(`test-results/native/redesign-video-${width}x${height}-dialog.png`));
      await browser.keys(Key.Escape);
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await browser.waitUntil(async () => browser.execute(() => document.activeElement?.textContent?.includes('Playback settings')));
      const after = await assertNativeVideoBounds();
      const restored = after.native.find(row => row.parent === after.native[0].handle && row.className.toLowerCase() === 'static');
      assert(restored.regionRectangles.some(rect => contains(rect, x, y)), 'Closing left a stale hole in the video');
      observations.push({ width, height, devicePixelRatio: scale, viewport, card, regionRectangles: native.regionRectangles,
        immediateEscapeBeforeInteraction: true,
        hardwareRequested: process.env.SURTITLE_E2E_HARDWARE_RENDERING === '1' });
    }
    writeFileSync(resolve('test-results/native/redesign-rendering.json'), JSON.stringify({ observations,
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
      for (const [width, height] of [[1440, 900], [1024, 700]]) {
        await resizeNativeWindow(width, height);
        await control({ action: 'seek', value: 200 });
        await control({ action: 'pause' });
        await assertNativeVideoBounds();
        await saveNativeScreenshot(resolve(`test-results/native/final-native-study-ja-${width}x${height}.png`));
        await $('button=再生設定').click();
        await $('[role="dialog"]').waitForDisplayed();
        await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-native-occlusion="pending"]')));
        await assertNativeVideoBounds();
        assert(await browser.execute(() => document.querySelector('[role="dialog"]').contains(document.activeElement)),
          'Native occlusion acknowledgement lost the Japanese dialog focus');
        await saveNativeScreenshot(resolve(`test-results/native/final-native-dialog-ja-${width}x${height}.png`));
        await browser.keys(Key.Escape);
        await $('[role="dialog"]').waitForExist({ reverse: true });
        await browser.waitUntil(async () => browser.execute(() => document.activeElement?.textContent?.includes('再生設定')));
      }
    } finally { await invoke('update_settings', { settings: original }); }
  });
});
