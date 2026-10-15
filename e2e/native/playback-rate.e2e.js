// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { nativeArtifact } from '../support/native-artifacts.mjs';
import { invokeNative as invoke, clickNative } from '../support/native-app.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, resizeNativeWindow, saveNativeScreenshot } from '../support/native-window.mjs';
import { activateNativeApplication, clickNativeVideo } from '../support/native-video-click.mjs';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const control = request => invoke('player_control', { request });
const state = () => invoke('get_player_state');
const triggerSelector = 'button[aria-label="Playback speed"]';
const popupSelector = '.playback-rate-popover';
const sliderSelector = '.playback-rate-slider';
const presets = [[.5, '0.5'], [.75, '0.75'], [1, '1.0'], [1.25, '1.25'], [1.5, '1.5'], [2, '2.0'], [3, '3.0']];
const contains = (rect, x, y) => x >= rect.Left && y >= rect.Top && x < rect.Right && y < rect.Bottom;
async function openSpeed() {
  await clickNative($(triggerSelector));
  await $(popupSelector).waitForDisplayed();
  await browser.waitUntil(async () => browser.execute(() => {
    const popup = document.querySelector('.playback-rate-popover');
    return popup && !popup.hasAttribute('data-native-occlusion')
      && Number(getComputedStyle(popup.querySelector('.playback-rate-content')).opacity) === 1
      && popup.querySelector('.playback-rate-slider') === document.activeElement;
  }), { timeoutMsg: 'The native speed widget did not recover slider focus after exclusion acknowledgement' });
}
async function expectRate(rate) {
  await browser.waitUntil(async () => (await state()).rate === rate,
    { timeoutMsg: `The real player did not apply ${rate}×` });
  await browser.waitUntil(async () => Number(await $(sliderSelector).getValue()) === rate,
    { timeoutMsg: `The visible speed slider did not settle at ${rate}×` });
  assert.equal(await $('.playback-rate-value').getText(), `${rate.toFixed(2)}×`);
}
async function expectClosed() {
  await $(popupSelector).waitForExist({ reverse: true });
  assert(await browser.execute(selector => document.querySelector(selector) === document.activeElement, triggerSelector),
    'Closing the speed popup did not restore trigger focus');
}

describe('real native playback speed popup', () => {
  let originalSettings;
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const initial = await invoke('get_app_snapshot');
    originalSettings = initial.settings;
    assert.equal(initial.settings.credentialConfigured, false);
    assert(initial.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    await invoke('update_settings', { settings: { ...initial.settings, locale: 'en', theme: 'light', sentencePause: false } });
    await browser.refresh();
    if (process.platform === 'win32') await resizeNativeWindow(1440, 900);
    await browser.execute(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/study/${fixture.mediaId}`);
    await $(triggerSelector).waitForEnabled();
    await browser.waitUntil(async () => (await state()).ready);
    await control({ action: 'pause' });
    await control({ action: 'rate', value: 1 });
    await control({ action: 'seek', value: 200 });
    await browser.waitUntil(async () => (await $(triggerSelector).getText()).includes('1×'));
    if (process.platform === 'win32') await activateNativeApplication();
    await browser.waitUntil(async () => browser.execute(() => document.hasFocus()),
      { timeoutMsg: 'The test application must be foreground before opening speed choices' });
  });
  after(async () => {
    await browser.keys(Key.Escape);
    await control({ action: 'pause' });
    await control({ action: 'rate', value: 1 });
    if (originalSettings) await invoke('update_settings', { settings: originalSettings });
  });

  it('closes from the same trigger and reopens without changing playback', async () => {
    const before = await state();
    await openSpeed();
    await clickNative($(triggerSelector));
    await expectClosed();
    await openSpeed();
    await browser.keys(Key.Escape);
    await expectClosed();
    const after = await state();
    assert.equal(after.rate, before.rate);
    assert.equal(after.paused, before.paused);
  });

  it('adjusts the real player through the slider, fine steps and slow-first presets without seeking or toggling playback', async () => {
    const before = await state();
    assert.equal(await $(triggerSelector).getAttribute('aria-haspopup'), 'dialog');
    assert.equal((await $$('.speed-select select, .speed-select .lucide-chevron-down')).length, 0);
    await openSpeed();
    assert.equal(await $('.playback-rate-heading').getText(), 'Playback speed');
    assert.equal((await $$('.playback-rate-preset')).length, 7);
    assert.equal(await $(sliderSelector).getAttribute('min'), '0.25');
    assert.equal(await $(sliderSelector).getAttribute('max'), '3');
    assert.equal(await $(sliderSelector).getAttribute('step'), '0.05');
    for (const [key, rate] of [[Key.Home, .25], [Key.ArrowRight, .3], [Key.ArrowRight, .35], [Key.ArrowLeft, .3], [Key.End, 3]]) {
      await browser.keys(key);
      await expectRate(rate);
      assert(await browser.execute(() => document.querySelector('.playback-rate-slider') === document.activeElement));
    }
    assert.equal(await $('button[aria-label="Increase playback speed"]').getAttribute('aria-disabled'), 'true');
    await clickNative($('button[aria-label="Decrease playback speed"]'));
    await expectRate(2.95);
    await clickNative($('button[aria-label="Increase playback speed"]'));
    await expectRate(3);
    assert(await browser.execute(() => document.activeElement?.getAttribute('aria-label') === 'Increase playback speed'),
      'Reaching the speed boundary lost keyboard focus');
    for (const [rate, text] of presets) {
      const preset = await $(`//*[@data-native-popup="playback-rate"]//button[contains(@class,"playback-rate-preset") and normalize-space(.)="${text}"]`);
      await clickNative(preset);
      await expectRate(rate);
      assert.equal(await preset.getAttribute('aria-pressed'), 'true');
      assert(await $(popupSelector).isDisplayed(), 'Selecting a preset closed the adjustment widget');
    }
    const adjusted = await state();
    assert.equal(adjusted.paused, before.paused, 'Speed adjustment started or paused playback');
    assert(Math.abs(adjusted.positionMs - before.positionMs) < 100, 'Speed adjustment moved the lesson position');
    await browser.keys(Key.Escape);
    await expectClosed();
    assert.equal((await state()).rate, 3, 'Escape changed the selected speed');
  });

  it('retains readable normal, selected and focused choices in both native themes', async () => {
    for (const theme of ['light', 'dark']) {
      const settings = (await invoke('get_app_snapshot')).settings;
      await invoke('update_settings', { settings: { ...settings, theme } });
      await browser.waitUntil(async () => browser.execute(expected => document.documentElement.dataset.theme === expected, theme));
      await openSpeed();
      const ratios = await browser.execute(() => [...document.querySelectorAll('.playback-rate-preset, .playback-rate-value')].map(element => {
        const style = getComputedStyle(element);
        let background = style.backgroundColor;
        for (let parent = element.parentElement; /rgba\([^)]*,\s*0\s*\)/.test(background) && parent; parent = parent.parentElement) background = getComputedStyle(parent).backgroundColor;
        const luminance = color => {
          const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
            const value = channel / 255;
            return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
          });
          return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
        };
        const text = luminance(style.color), fill = luminance(background);
        return (Math.max(text, fill) + .05) / (Math.min(text, fill) + .05);
      }));
      assert.equal(ratios.length, 8);
      assert(ratios.every(ratio => ratio >= 4.5), `${theme} speed choice contrast: ${ratios}`);
      if (process.platform === 'win32') await saveNativeScreenshot(nativeArtifact(`playback-speed-${theme}.png`));
      await browser.keys(Key.Escape);
      await expectClosed();
    }
  });

  (process.platform === 'win32' ? it : it.skip)('excludes actual HWND pixels behind the popup and restores them after Escape', async () => {
    await control({ action: 'pause' });
    const before = await assertNativeVideoBounds();
    await openSpeed();
    const during = await assertNativeVideoBounds();
    assert.equal((await state()).surfaceVisible, true, 'Speed popup hid the uncovered video');
    assert.deepEqual(during.dom.viewport, before.dom.viewport, 'Speed popup changed video geometry');
    const card = await browser.execute(() => {
      const { x, y, width, height } = document.querySelector('.playback-rate-popover').getBoundingClientRect();
      return { x, y, width, height };
    });
    const viewport = during.dom.viewport, scale = during.dom.devicePixelRatio;
    const overlap = { left: Math.max(viewport.x, card.x), top: Math.max(viewport.y, card.y),
      right: Math.min(viewport.x + viewport.width, card.x + card.width), bottom: Math.min(viewport.y + viewport.height, card.y + card.height) };
    assert(overlap.right > overlap.left && overlap.bottom > overlap.top, 'Speed popup does not overlap the test video');
    const x = ((overlap.left + overlap.right) / 2 - viewport.x) * scale;
    const y = ((overlap.top + overlap.bottom) / 2 - viewport.y) * scale;
    const native = during.native.find(row => row.parent === during.native[0].handle && row.className.toLowerCase() === 'static');
    assert(native?.regionRectangles?.length, 'Native video has no explicit retained region');
    assert(!native.regionRectangles.some(rect => contains(rect, x, y)), 'Native video pixels cover speed choices');
    assert(native.regionRectangles.some(rect => rect.Right > rect.Left && rect.Bottom > rect.Top), 'The speed popup removed all video pixels');
    const corners = [[card.x + 1, card.y + 1], [card.x + card.width - 2, card.y + 1],
      [card.x + 1, card.y + card.height - 2], [card.x + card.width - 2, card.y + card.height - 2]]
      .filter(([x, y]) => x >= viewport.x && y >= viewport.y && x < viewport.x + viewport.width && y < viewport.y + viewport.height);
    assert(corners.length, 'Speed popup has no transparent corner inside the test video');
    for (const [cornerX, cornerY] of corners) {
      const physicalX = Math.floor(cornerX * scale) - Math.round(viewport.x * scale);
      const physicalY = Math.floor(cornerY * scale) - Math.round(viewport.y * scale);
      assert(native.regionRectangles.some(rect => contains(rect, physicalX, physicalY)),
        `Rounded corner (${cornerX}, ${cornerY}) removed the video and exposed a black square`);
    }
    await browser.keys(Key.Escape);
    await expectClosed();
    const after = await assertNativeVideoBounds();
    const restored = after.native.find(row => row.parent === after.native[0].handle && row.className.toLowerCase() === 'static');
    assert(restored.regionRectangles.some(rect => contains(rect, x, y)), 'Closing the speed popup left a stale native exclusion');
    await openSpeed();
    const beforeDismiss = await state();
    await clickNativeVideo();
    await expectClosed();
    assert.equal((await state()).paused, beforeDismiss.paused, 'Clicking video to dismiss speed choices also toggled playback');
    await openSpeed();
    await clickNative($('button=Playback settings'));
    await $('.modal[role="dialog"]').waitForDisplayed();
    await $(popupSelector).waitForExist({ reverse: true });
    await browser.keys(Key.Escape);
    await $('.modal[role="dialog"]').waitForExist({ reverse: true });
    const paused = (await state()).paused;
    await clickNativeVideo();
    await browser.waitUntil(async () => (await state()).paused !== paused, { timeoutMsg: 'Video input did not resume after the popup and modal closed' });
    await control({ action: 'pause' });
  });
});
