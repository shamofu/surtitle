// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { nativeArtifact } from '../support/native-artifacts.mjs';
import { invokeNative as invoke, expectNativeRejection, restartNativeSession, prepareNativeSession, replaceNativeValue, clickNative } from '../support/native-app.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { inspectNativeMonitor, inspectNativeWindow, moveNativeWindowToMonitor, requestNativeWindowCommand, requestNativeWindowSize, resizeNativeWindow, resizeThenMaximizeNativeWindow, saveNativeScreenshot, snapNativeWindow } from '../support/native-window.mjs';

const profile = process.env.SURTITLE_E2E_DATA_DIR;
const fixture = JSON.parse(readFileSync(resolve(profile, 'fixture.json'), 'utf8'));
const snapshot = () => invoke('get_app_snapshot');
const placement = () => JSON.parse(readFileSync(resolve(profile, 'window-state.json'), 'utf8'));
const ready = prepareNativeSession;
function running() {
  const command = '$expected=(Resolve-Path -LiteralPath $env:SURTITLE_E2E_BINARY).ProviderPath; ConvertTo-Json -Compress -InputObject @(Get-Process -Name surtitle -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected } | Select-Object -ExpandProperty Id)';
  return JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }));
}
async function openFixtureCard() {
  await browser.execute(() => { history.pushState({}, '', '/cards'); dispatchEvent(new PopStateEvent('popstate')); });
  const search = $('[aria-label="Search your phrases"]');
  await search.waitForEnabled(); await replaceNativeValue(search, 'at home');
  await $('[aria-label="Edit phrase"]').waitForClickable();
  await clickNative($('[aria-label="Edit phrase"]'));
  await $('[role="dialog"] input').waitForEnabled();
}

describe('native window continuity', () => {
  it('applies presets, enforces the HD minimum and preserves visible edge alignment after restart', async () => {
    await ready();
    if ((await inspectNativeWindow())[0].maximized) {
      await requestNativeWindowCommand('restore');
      await browser.waitUntil(async () => !(await inspectNativeWindow())[0].maximized);
    }
    await moveNativeWindowToMonitor((await inspectNativeMonitor()).current);
    await browser.execute(() => { history.pushState({}, '', '/settings'); dispatchEvent(new PopStateEvent('popstate')); });
    await clickNative($('#settings-nav-appearance'));
    await expect($('#settings-nav-appearance')).toHaveAttribute('aria-pressed', 'true');
    const standard = $('button*=1600 × 900');
    await standard.waitForExist();
    await browser.execute(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }), await standard);
    await standard.waitForClickable();
    for (const [label, width, height] of [['1280 × 720', 1280, 720], ['1600 × 900', 1600, 900], ['1920 × 1080', 1920, 1080]]) {
      await clickNative($(`button*=${label}`));
      await browser.waitUntil(async () => {
        const root = (await inspectNativeWindow())[0];
        const display = await inspectNativeMonitor(), work = display.monitors.find(item => item.handle === display.current).workArea;
        const innerWidth = root.client.Right - root.client.Left, innerHeight = root.client.Bottom - root.client.Top;
        const frameWidth = root.visibleFrame.Right - root.visibleFrame.Left - innerWidth;
        const frameHeight = root.visibleFrame.Bottom - root.visibleFrame.Top - innerHeight;
        return innerWidth === Math.min(Math.round(width * root.dpi / 96), work.Right - work.Left - frameWidth)
          && innerHeight === Math.min(Math.round(height * root.dpi / 96), work.Bottom - work.Top - frameHeight);
      }, { timeoutMsg: `Window preset ${label} did not fit the actual work area` });
    }
    await requestNativeWindowCommand('maximize');
    await browser.waitUntil(async () => (await inspectNativeWindow())[0].maximized);
    await clickNative(standard);
    await browser.waitUntil(async () => !(await inspectNativeWindow())[0].maximized);
    await requestNativeWindowSize(1024, 700);
    await browser.waitUntil(async () => browser.execute(() => innerWidth === 1280 && innerHeight === 720));
    await expectNativeRejection(invoke('set_window_size_preset', { preset: 'invalid' }), 'Unknown window size preset: invalid');
    const initial = (await inspectNativeWindow())[0].client;
    for (const edge of ['left', 'right', 'top', 'bottom', 'bottom-right', 'top-left']) {
      await snapNativeWindow(edge);
      await browser.waitUntil(async () => {
        const root = (await inspectNativeWindow())[0];
        assert.deepEqual(root.client, initial, 'Magnetic snapping resized the client');
        const display = await inspectNativeMonitor(), area = display.monitors.find(item => item.handle === display.current).workArea;
        return (!edge.includes('left') || root.visibleFrame.Left === area.Left)
          && (!edge.includes('right') || root.visibleFrame.Right === area.Right)
          && (!edge.includes('top') || root.visibleFrame.Top === area.Top)
          && (!edge.includes('bottom') || root.visibleFrame.Bottom === area.Bottom);
      }, { timeoutMsg: `Visible frame did not snap to ${edge}` });
    }
    const snapped = (await inspectNativeWindow())[0];
    await browser.waitUntil(() => placement().x === snapped.screen.Left && placement().y === snapped.screen.Top);
    await restartNativeSession();
    assert.deepEqual((await inspectNativeWindow())[0].visibleFrame, snapped.visibleFrame, 'Restart lost the visible snapped alignment');
  });

  it('restores normal bounds and maximization, follows saved appearance, and closes after checkpointing pending input', async () => {
    await ready();
    const original = (await snapshot()).settings;
    try {
      await invoke('update_settings', { settings: { ...original, locale: 'en', theme: 'light' } });
      await browser.refresh(); await ready();
      await browser.waitUntil(() => browser.execute(() => document.documentElement.dataset.theme === 'light'));
      if ((await inspectNativeWindow())[0].maximized) {
        await requestNativeWindowCommand('restore');
        await browser.waitUntil(async () => !(await inspectNativeWindow())[0].maximized);
      }
      await moveNativeWindowToMonitor((await inspectNativeMonitor()).current);
      await resizeNativeWindow(1280, 760);
      await browser.waitUntil(() => { const state = placement(); return state.width === 1280 && state.height === 760 && !state.maximized; });
      const normal = placement();
      await saveNativeScreenshot(nativeArtifact('window-light-1280x760.png'));
      await clickNative($('[aria-label="Toggle theme"]'));
      await browser.waitUntil(async () => (await snapshot()).settings.theme === 'dark'
        && await browser.execute(() => document.documentElement.dataset.theme === 'dark'));
      await saveNativeScreenshot(nativeArtifact('window-dark-1280x760.png'));
      await clickNative($('[aria-label="Toggle theme"]'));
      await browser.waitUntil(async () => (await snapshot()).settings.theme === 'light'
        && await browser.execute(() => document.documentElement.dataset.theme === 'light'));
      // A single native helper maximizes before the 100 ms persistence coalescer.
      await resizeThenMaximizeNativeWindow(1280, 800);
      await browser.waitUntil(async () => (await inspectNativeWindow())[0].maximized && placement().maximized);
      const maximized = placement();
      assert.equal(maximized.width, 1280); assert.equal(maximized.height, 800);
      await restartNativeSession();
      assert((await inspectNativeWindow())[0].maximized, 'Maximized state did not survive native process restart');
      assert.equal(await browser.execute(() => document.documentElement.dataset.theme), 'light');
      await requestNativeWindowCommand('restore');
      await browser.waitUntil(async () => browser.execute(() => innerWidth === 1280 && innerHeight === 800));
      const restored = (await inspectNativeWindow())[0];
      assert.equal(restored.screen.Left, normal.x); assert.equal(restored.screen.Top, normal.y);
      await openFixtureCard();
      const term = $('[role="dialog"] input');
      await clickNative(term); await browser.keys([Key.Control, 'a']); await browser.keys(Key.Backspace);
      // Close through the OS while invalid input is still open; the application
      // must checkpoint the draft, then re-request close using its capability.
      await requestNativeWindowCommand('close');
      await browser.waitUntil(() => running().length === 0, { timeoutMsg: 'Native close did not finish after saving pending input' });
      await restartNativeSession();
      assert.equal(await browser.execute(() => innerWidth), 1280);
      assert.equal(await browser.execute(() => innerHeight), 800);
      const drafts = await invoke('list_ui_drafts');
      assert(drafts.some(draft => draft.entityId === fixture.cardId && draft.fields.term === ''), 'Pending invalid input was not checkpointed before close');
      await openFixtureCard();
      await expect($('[role="dialog"] input')).toHaveValue('');
      await saveNativeScreenshot(nativeArtifact('window-restored-draft.png'));
      await $('[role="dialog"] input').addValue('at home');
      await browser.keys(Key.Escape);
    } finally {
      await invoke('update_settings', { settings: original });
    }
  });
});
