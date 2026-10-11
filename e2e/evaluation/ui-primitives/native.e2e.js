// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, resizeNativeWindow, saveNativeScreenshot } from '../../support/native-window.mjs';

const output = resolve('work/ui-evaluation/native/results');
mkdirSync(output, { recursive: true });
const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const invoke = (command, args = {}) => browser.execute((name, value) => window.__TAURI_INTERNALS__.invoke(name, value), command, args);
const state = () => invoke('get_player_state');
const control = request => invoke('player_control', { request });
const results = [];
let browserEnvironment;
const dialog = () => $('.modal');
const settled = () => browser.waitUntil(() => browser.execute(() => !!document.querySelector('.modal') && !document.querySelector('[data-native-occlusion="pending"]')));
const focus = () => browser.execute(() => ({ tag:document.activeElement?.tagName, label:document.activeElement?.getAttribute('aria-label'), dialog:!!document.querySelector('.modal')?.contains(document.activeElement), hasFocus:document.hasFocus() }));

describe('isolated UI candidates on real WebView2 and the HWND mpv host', () => {
  before(async () => {
    await browser.waitUntil(() => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const snapshot = await invoke('get_app_snapshot');
    assert.equal(snapshot.settings.credentialConfigured, false);
    assert(snapshot.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    const tools = await invoke('scan_external_tools', {rescan:true});
    const ffmpeg = tools.find(tool => tool.toolId === 'ffmpeg' && tool.selectable);
    assert(ffmpeg?.path, 'Verified external FFmpeg is required for real phrase audio');
    await invoke('set_tool_provider',{request:{toolId:'ffmpeg',provider:'external',path:ffmpeg.path}});
    await invoke('update_settings', { settings:{...snapshot.settings, locale:'en', sentencePause:false, motionPreference:'reduce'} });
    await browser.refresh();
    await $('.eval-play').waitForEnabled();
    await resizeNativeWindow(1440, 900);
    await control({action:'volume', value:0});
    browserEnvironment = await browser.execute(() => ({userAgent:navigator.userAgent, devicePixelRatio, innerWidth, innerHeight, location:location.href}));
  });
  after(async () => {
    await control({action:'pause'});
    writeFileSync(resolve(output, 'results.json'), JSON.stringify({ capturedAt:new Date().toISOString(), environment:{ nativeHost:'Tauri/WebView2 + child HWND mpv', binarySha256:createHash('sha256').update(readFileSync(process.env.SURTITLE_E2E_BINARY)).digest('hex'), browser:browserEnvironment, hardwareRequested:process.env.SURTITLE_E2E_HARDWARE_RENDERING === '1', sharedAdapter:'production SurfaceProvider and NativePlayer with equal opaque rectangles and focus restoration after native ACK', syntheticImeOnly:true, limits:['Evaluation frontend uses actual native playback and save_card IPC; it is not a complete production route migration.', 'Synthetic composition/Unicode input is not actual Windows IME evidence.', 'Four candidates share one bundle; reuse the separate browser bundle measurements, not this combined size.'] }, results }, null, 2));
  });
  for (const candidate of ['current','base','aria','radix']) it(`${candidate}: playback, native overlap, focus, meaning/save/resume`, async () => {
    const result = {candidate}; results.push(result);
    try {
      await $(`[data-candidate="${candidate}"]`).click();
      await control({action:'seek',value:100});
      await $('.eval-play').click();
      await browser.waitUntil(async () => (await state()).positionMs > 500);
      result.playbackAdvances = true;
      const before = await assertNativeVideoBounds();
      result.viewport = before.dom.viewport;
      await $('.native-candidate-trigger').click();
      await dialog().waitForDisplayed();
      await settled();
      result.focusAfterOpen = await focus();
      await browser.keys(Key.Escape);
      await dialog().waitForExist({reverse:true});
      result.immediateEscapeCloses = true;
      await browser.waitUntil(() => browser.execute(() => document.activeElement?.classList.contains('native-candidate-trigger')));
      result.immediateEscapeRestoresTrigger = true;

      await $('.native-candidate-trigger').click();
      await dialog().waitForDisplayed(); await settled();
      const during = await assertNativeVideoBounds();
      assert.deepEqual(during.dom.viewport, before.dom.viewport);
      assert.equal((await state()).surfaceVisible, true);
      const host = during.native.find(row => row.parent === during.native[0].handle && row.className.toLowerCase() === 'static');
      assert(host?.regionRectangles.length > 1, 'Expected partial native exclusion, not a fully hidden video');
      result.regionRectangles = host.regionRectangles;
      result.pausedOnSelection = (await state()).paused;
      assert.equal(result.pausedOnSelection, true);
      await control({action:'play'});
      await browser.waitUntil(async () => (await state()).positionMs > 400);
      assert.equal((await state()).surfaceVisible, true);
      result.playbackBehindDialog = true;
      await control({action:'pause'});
      const meaning = await $('input[aria-label="Meaning"]');
      await meaning.click(); await browser.keys([Key.Ctrl,'a']); await browser.keys(Key.Backspace); await meaning.addValue(`くつろいで学ぶ ${candidate}`);
      result.unicodeInputRetained = (await meaning.getValue()) === `くつろいで学ぶ ${candidate}`;
      await $('[role="tab"]=Source').click();
      await browser.keys(Key.ArrowRight);
      await browser.waitUntil(async () => await $('[role="tab"]=Notes').getAttribute('aria-selected') === 'true');
      result.arrowTabsSelect = true;
      const focusTargets = [];
      for (let i=0;i<10;i++) { await browser.keys(Key.Tab); focusTargets.push(await focus()); }
      result.tabFocusContained = focusTargets.every(item => item.dialog);
      result.focusTargets = focusTargets;
      await meaning.click();
      await browser.execute(() => {
        const input = document.querySelector('input[aria-label="Meaning"]');
        input.dispatchEvent(new CompositionEvent('compositionstart',{data:'よ',bubbles:true}));
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',isComposing:true,keyCode:229,bubbles:true}));
      });
      result.syntheticImeEscapeRetainsDialog = await dialog().isExisting();
      if (!result.syntheticImeEscapeRetainsDialog) {
        await $('.native-candidate-trigger').click(); await dialog().waitForDisplayed(); await settled();
      } else await browser.execute(() => document.querySelector('input[aria-label="Meaning"]').dispatchEvent(new CompositionEvent('compositionend',{data:'よ',bubbles:true})));
      await $('.eval-save').click();
      await browser.waitUntil(async () => {
        const error=await $('[role="alert"]').getText(); if(error) throw new Error(error);
        return !!(await $('[data-saved-card]').getAttribute('data-saved-card'));
      }, {timeout:120000});
      const id = await $('[data-saved-card]').getAttribute('data-saved-card');
      const snapshot = await invoke('get_app_snapshot');
      const card = snapshot.cards.find(row => row.id === id);
      assert(card); assert.equal(card.meaning, `くつろいで学ぶ ${candidate}`);
      assert(card.audioPath);
      result.savedCard = { id, meaning:card.meaning, audioPath:card.audioPath, audioSha256:createHash('sha256').update(readFileSync(card.audioPath)).digest('hex') };
      await saveNativeScreenshot(resolve(`test-results/native/ui-candidate-${candidate}.png`));
      const paused = (await state()).positionMs;
      await $('.eval-resume').click();
      await dialog().waitForExist({reverse:true});
      await browser.waitUntil(async () => { const current=await state(); return !current.paused && current.positionMs>paused+150; });
      result.resumeAdvances = true;
      assert(result.tabFocusContained, 'A Tab focus sample was outside the dialog; inspect focusTargets before inferring background access');
      assert(result.syntheticImeEscapeRetainsDialog, 'Synthetic composing Escape closed modal');
    } catch (error) {
      result.failure = String(error); result.focusOnFailure = await focus();
      throw error;
    } finally {
      if (await $('.eval-resume').isExisting()) await $('.eval-resume').click();
      await control({action:'pause'});
      writeFileSync(resolve(output, 'results.json'), JSON.stringify({results},null,2));
    }
  });
});
