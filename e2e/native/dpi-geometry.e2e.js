// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, inspectNativeMonitor, moveNativeWindowToMonitor, requestNativeWindowSize, saveNativeScreenshot } from '../support/native-window.mjs';

const expectedDpi = Number(process.env.SURTITLE_E2E_EXPECTED_DPI);
const mixed = process.env.SURTITLE_E2E_MIXED_MONITOR === '1';
const liveTarget = Number(process.env.SURTITLE_E2E_LIVE_CHANGE_TO);
const invoke = (command, args = {}) => browser.execute(async (name, value) => window.__TAURI_INTERNALS__.invoke(name, value), command, args);
const control = request => invoke('player_control', { request });
const contains = (rect, x, y) => x >= rect.Left && y >= rect.Top && x < rect.Right && y < rect.Bottom;
const fits = (inner, outer) => inner.Left >= outer.Left && inner.Top >= outer.Top && inner.Right <= outer.Right && inner.Bottom <= outer.Bottom;
async function fittedGeometry() {
  let result;
  await browser.waitUntil(async () => {
    const geometry = await assertNativeVideoBounds();
    const display = await inspectNativeMonitor();
    const monitor = display.monitors.find(item => item.handle === display.current);
    result = { geometry, monitor };
    return fits(geometry.native[0].visibleFrame, monitor.workArea);
  }, { timeout: 15000, timeoutMsg: 'The normal application window exceeds its current physical monitor workarea' });
  return result;
}
async function assertPrimaryControlsInside() {
  const outside = await browser.execute(() => [...document.querySelectorAll('.player-controls button, .player-controls select, .player-controls input, .caption-controls button')].filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight);
  }).map(element => element.getAttribute('aria-label') || element.textContent));
  assert.deepEqual(outside, [], 'Primary learning controls extend outside the fitted viewport');
}

(process.platform === 'win32' && [96, 120, 144, 192].includes(expectedDpi) ? describe : describe.skip)('physical DPI native geometry', () => {
  it('matches the real HWND scale and preserves modal focus, clipping and mixed-monitor input', async () => {
    const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const original = (await invoke('get_app_snapshot')).settings;
    const observations = [];
    let originalMonitor;
    try {
      await invoke('update_settings', { settings: { ...original, locale: 'en', sentencePause: false } });
      await browser.refresh();
      await browser.execute(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/study/${fixture.mediaId}`);
      await $('.play-button').waitForEnabled();
      await browser.waitUntil(async () => (await invoke('get_player_state')).ready);
      // Observe the app's own startup sizing before the test moves or resizes it.
      const startup = await fittedGeometry();
      observations.push({ phase: 'startup', ...startup, outerFitsWorkArea: true });
      const display = await inspectNativeMonitor();
      originalMonitor = display.monitors.find(monitor => monitor.primary).handle;
      if (display.current !== originalMonitor) await moveNativeWindowToMonitor(originalMonitor);
      await requestNativeWindowSize(1024, 700);
      await control({ action: 'seek', value: 200 });
      await control({ action: 'pause' });
      const { geometry: before } = await fittedGeometry();
      assert.equal(before.native[0].dpi, expectedDpi, 'Actual HWND DPI differs from requested physical test scale');
      assert.equal(before.dom.devicePixelRatio, expectedDpi / 96);
      const native = before.native[0], area = (await inspectNativeMonitor()).monitors.find(item => item.handle === originalMonitor).workArea;
      const frameWidth = native.visibleFrame.Right - native.visibleFrame.Left - (native.client.Right - native.client.Left);
      const frameHeight = native.visibleFrame.Bottom - native.visibleFrame.Top - (native.client.Bottom - native.client.Top);
      assert.equal(native.client.Right - native.client.Left, Math.min(Math.floor(1280 * before.dom.devicePixelRatio), area.Right - area.Left - frameWidth));
      assert.equal(native.client.Bottom - native.client.Top, Math.min(Math.floor(720 * before.dom.devicePixelRatio), area.Bottom - area.Top - frameHeight));
      observations.push({ phase: 'below-minimum-request', requestedLogicalClient: { width: 1024, height: 700 }, geometry: before, outerFitsWorkArea: true });
      const monitor = (await inspectNativeMonitor()).monitors.find(item => item.handle === originalMonitor);
      await assertPrimaryControlsInside();
      await saveNativeScreenshot(resolve(`test-results/native/dpi-${expectedDpi}-study.png`));
      await $('button=Playback settings').click();
      await $('[role="dialog"]').waitForDisplayed();
      await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-native-occlusion="pending"]')));
      const during = await assertNativeVideoBounds();
      assert.deepEqual(during.dom.viewport, before.dom.viewport);
      assert.equal((await invoke('get_player_state')).surfaceVisible, true);
      assert(await browser.execute(() => document.querySelector('[role="dialog"]').contains(document.activeElement)));
      const card = await browser.execute(() => { const { x, y, width, height } = document.querySelector('[role="dialog"]').getBoundingClientRect(); return { x, y, width, height }; });
      const viewport = during.dom.viewport, ratio = during.dom.devicePixelRatio;
      const x = (Math.max(viewport.x, card.x) + Math.min(viewport.x + viewport.width, card.x + card.width)) / 2 - viewport.x;
      const y = (Math.max(viewport.y, card.y) + Math.min(viewport.y + viewport.height, card.y + card.height)) / 2 - viewport.y;
      const surface = during.native.find(row => row.parent === during.native[0].handle && row.className.toLowerCase() === 'static');
      assert(!surface.regionRectangles.some(rect => contains(rect, x * ratio, y * ratio)), 'Video covers the opaque popup at the actual DPI');
      await saveNativeScreenshot(resolve(`test-results/native/dpi-${expectedDpi}-dialog.png`));
      await browser.keys(Key.Escape);
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await browser.waitUntil(async () => browser.execute(() => document.activeElement?.textContent?.includes('Playback settings')));
      observations.push({ phase: 'primary', before, during, monitor, outerFitsWorkArea: fits(before.native[0].visibleFrame, monitor.workArea) });

      if (mixed) {
        const secondary = display.monitors.find(item => item.handle !== originalMonitor);
        assert(secondary, 'Mixed-monitor test requires a second attached monitor');
        await $('button[aria-label="Explore meaning"]').click();
        await $('.phrase-save-toggle').waitForEnabled();
        await $('.phrase-save-toggle').click();
        const input = $('.save-phrase-form input');
        await input.setValue('日本語 mixed monitor phrase');
        await browser.execute(() => { const field = document.querySelector('.save-phrase-form input'); field.focus(); field.setSelectionRange(4, 9); });
        for (const [phase, destination, dpi] of [['secondary', secondary, 96], ['primary-return', monitor, expectedDpi]]) {
          await moveNativeWindowToMonitor(destination.handle);
          await browser.waitUntil(async () => browser.execute(expected => devicePixelRatio === expected, dpi / 96));
          const { geometry } = await fittedGeometry();
          assert.equal(geometry.native[0].dpi, dpi);
          await assertPrimaryControlsInside();
          const state = await browser.execute(() => { const field = document.querySelector('.save-phrase-form input'); return { value: field.value, start: field.selectionStart, end: field.selectionEnd, focused: document.activeElement === field }; });
          assert.deepEqual(state, { value: '日本語 mixed monitor phrase', start: 4, end: 9, focused: true });
          observations.push({ phase, geometry, monitor: destination, input: state, outerFitsWorkArea: fits(geometry.native[0].visibleFrame, destination.workArea) });
          await saveNativeScreenshot(resolve(`test-results/native/dpi-${expectedDpi}-${phase}.png`));
        }
      }
      if ([120, 144, 192].includes(liveTarget) && liveTarget !== expectedDpi) {
        await $('button[aria-label="Explore meaning"]').click();
        await $('.phrase-save-toggle').waitForEnabled();
        await $('.phrase-save-toggle').click();
        await $('.save-phrase-form input').setValue('日本語 live DPI change');
        await browser.execute(() => { const field = document.querySelector('.save-phrase-form input'); field.focus(); field.setSelectionRange(4, 8); });
        writeFileSync(resolve('test-results/native/dpi-scale-ready.json'), JSON.stringify({ fromDpi: expectedDpi, toDpi: liveTarget, readyAt: new Date().toISOString() }));
        console.log(`SURTITLE_DPI_READY_FOR_SETTINGS_CHANGE ${expectedDpi} -> ${liveTarget}`);
        // Only the coordinated Windows Settings UI changes scale. The helper
        // observes the real transition and never changes system preferences.
        await browser.waitUntil(async () => browser.execute(target => devicePixelRatio === target, liveTarget / 96), { timeout: 300000 });
        const changed = await fittedGeometry();
        assert.equal(changed.geometry.native[0].dpi, liveTarget);
        await assertPrimaryControlsInside();
        const input = await browser.execute(() => { const field = document.querySelector('.save-phrase-form input'); return { value: field.value, start: field.selectionStart, end: field.selectionEnd }; });
        assert.deepEqual(input, { value: '日本語 live DPI change', start: 4, end: 8 });
        observations.push({ phase: 'live-settings-scale-change', fromDpi: expectedDpi, toDpi: liveTarget, ...changed, input, outerFitsWorkArea: true });
        await saveNativeScreenshot(resolve(`test-results/native/dpi-live-${expectedDpi}-to-${liveTarget}.png`));
      }
      writeFileSync(resolve(`test-results/native/dpi-${expectedDpi}.json`), JSON.stringify({ expectedDpi, mixed, passed: true, paidRequests: 0, observations }, null, 2));
    } finally {
      if (originalMonitor) await moveNativeWindowToMonitor(originalMonitor);
      await control({ action: 'pause' });
      await invoke('update_settings', { settings: original });
    }
  });
});
