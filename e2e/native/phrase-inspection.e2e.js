// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { nativeArtifact } from '../support/native-artifacts.mjs';
import { invokeNative as invoke, waitForNativeInput, clickNative, replaceNativeValue } from '../support/native-app.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { assertNativeVideoBounds, resizeNativeWindow, saveNativeScreenshot } from '../support/native-window.mjs';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const mediaId = fixture.mediaId;
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const navigate = path => browser.execute(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);
const replaceValue = replaceNativeValue;

describe('watch, inspect, and return with the Windows native surface', () => {
  let originalSettings;
  const savedCardIds = [];
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    if (process.env.SURTITLE_E2E_FRONTEND_SCRIPT) {
      const loadedScripts = await browser.execute(() => Array.from(document.querySelectorAll('script[src]'), script => new URL(script.src).pathname));
      assert(loadedScripts.includes(process.env.SURTITLE_E2E_FRONTEND_SCRIPT), 'The native executable does not embed the expected current frontend');
    }
    const snapshot = await invoke('get_app_snapshot');
    assert.equal(snapshot.settings.credentialConfigured, false);
    assert.equal(snapshot.budget.spentUsd, 0);
    assert.equal(snapshot.budget.reservedUsd, 0);
    assert(snapshot.media.some(media => media.id === mediaId && media.path === fixture.mediaPath));
    originalSettings = snapshot.settings;
    await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false } });
    await browser.refresh();
    await navigate(`/study/${mediaId}`);
    await $('.play-button').waitForEnabled();
    await browser.waitUntil(async () => (await player()).ready);
  });
  after(async () => {
    await control({ action: 'pause' });
    await control({ action: 'loop' });
    for (const cardId of savedCardIds) await invoke('delete_card', { cardId });
    if (originalSettings) await invoke('update_settings', { settings: originalSettings });
  });
  afterEach(async function () {
    if (this.currentTest.state !== 'failed') return;
    await navigate(`/study/${mediaId}`);
    await browser.refresh();
    await $('.play-button').waitForEnabled();
    await control({ action: 'pause' });
  });
  it('keeps the full native surface visible when opening panels and resizing at the minimum window size', async () => {
    for (const [width, height] of [[1440, 900], [1280, 720]]) {
      await resizeNativeWindow(width, height);
      await browser.waitUntil(async () => {
        const state = await player();
        return state.surfaceVisible && state.videoWidth === 640 && state.videoHeight === 360;
      }, { timeoutMsg: 'Native video is clipped or has not decoded the fixture dimensions' });
      // Wide layouts now show the transcript initially; exercise the same
      // opened layout after either initial entry or the preceding close.
      if ((await $('.study-transcript-toggle').getAttribute('aria-expanded')) !== 'true') {
        await clickNative($('.study-transcript-toggle'));
      }
      await $('[aria-label="Subtitle list"]').waitForDisplayed();
      await browser.waitUntil(async () => (await player()).surfaceVisible);
      const geometry = await browser.execute(() => {
        const video = document.querySelector('[data-testid="native-player-viewport"]').getBoundingClientRect();
        const transcript = document.querySelector('.transcript-panel').getBoundingClientRect();
        const controls = document.querySelector('.player-controls').getBoundingClientRect();
        return { video: { left: video.left, right: video.right, bottom: video.bottom }, panel: { left: transcript.left, top: transcript.top }, controlsBottom: controls.bottom, height: innerHeight };
      });
      assert(geometry.video.right <= geometry.panel.left + 1 || geometry.video.bottom <= geometry.panel.top + 1, 'The HTML transcript overlaps the native video');
      assert(geometry.controlsBottom <= geometry.height, 'Basic playback controls are below the window edge');
      await assertNativeVideoBounds();
      await saveNativeScreenshot(nativeArtifact(`learning-${width}x${height}.png`));
      await clickNative($('button=Transcript'));
    }
  });
  it('pauses to inspect, keeps the selected context during replay, and returns to its starting position', async () => {
    await control({ action: 'pause' });
    await control({ action: 'seek', value: 200 });
    await browser.waitUntil(async () => (await player()).positionMs < 500);
    await $('button[aria-label="Explore meaning"]').waitForEnabled();
    await clickNative($('button[aria-label="Explore meaning"]'));
    await $('button=Resume from original position').waitForDisplayed();
    assert.equal((await player()).paused, true);
    const returnPosition = (await player()).positionMs;
    const originalContext = await $('.phrase-panel .context-sentence').getText();
    const passage = $('.phrase-panel').$('button=Play this passage');
    await waitForNativeInput(passage);
    await clickNative(passage);
    await browser.waitUntil(async () => !(await player()).paused);
    await browser.waitUntil(async () => (await player()).paused, { timeout: 12000 });
    assert.equal(await $('.phrase-panel .context-sentence').getText(), originalContext);
    await clickNative($('[aria-label="Repeat selected segment"]'));
    await $('[aria-label="Repeat selected segment"]').waitForDisplayed();
    await clickNative($('button=Resume from original position'));
    await browser.waitUntil(async () => { const state = await player(); return !state.paused && state.positionMs >= returnPosition; });
    await browser.waitUntil(async () => (await player()).positionMs > 1600, { timeout: 6000, timeoutMsg: 'Returning retained the old range stop or repeat' });
    await control({ action: 'pause' });
    assert.equal((await invoke('get_app_snapshot')).budget.spentUsd, 0);
  });
  it('keeps video and controls inside a compact window with long subtitles and export management expanded', async () => {
    const original = (await invoke('list_segments', { mediaId }))[0];
    try {
      await invoke('edit_segment', { segment: { ...original, text: 'Sometimes a longer sentence needs more space to stay readable. We can take a little detour, listen again, and discover how the same words fit into the world around us without losing the picture or the playback controls.' } });
      await browser.refresh();
      await resizeNativeWindow(1280, 720);
      await browser.waitUntil(async () => (await player()).ready);
      await control({ action: 'pause' });
      await control({ action: 'seek', value: original.startMs });
      await browser.waitUntil(async () => (await $('.current-caption-text').getText()).startsWith('Sometimes a longer sentence'));
      await clickNative($('button=Activity & tools'));
      await browser.waitUntil(async () => (await player()).surfaceVisible);
      const inside = await browser.execute(() => {
        const page = document.querySelector('.page-content').getBoundingClientRect();
        const video = document.querySelector('[data-testid="native-player-viewport"]').getBoundingClientRect();
        const controls = document.querySelector('.player-controls').getBoundingClientRect();
        return video.top >= page.top && video.bottom <= page.bottom && controls.bottom <= Math.min(page.bottom, innerHeight);
      });
      assert(inside, 'A long current subtitle or expanded export management toolbar clipped the native video or controls');
      await assertNativeVideoBounds();
      await saveNativeScreenshot(nativeArtifact('learning-long-caption-more.png'));
    } finally {
      await invoke('edit_segment', { segment: original });
      await browser.refresh();
      await browser.waitUntil(async () => (await player()).ready);
    }
  });
  it('saves an inline phrase with its real source audio and keeps watching available', async () => {
    const candidate = (await invoke('scan_external_tools')).find(tool => tool.toolId === 'ffmpeg' && tool.selectable);
    assert(candidate, 'The native fixture requires an explicitly available FFmpeg pair');
    await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: candidate.path } });
    await control({ action: 'pause' });
    await control({ action: 'seek', value: 200 });
    const firstCue = (await invoke('list_segments', { mediaId }))[0];
    await browser.waitUntil(async () => (await $('.current-caption-text').getText()) === firstCue.text);
    await $('button[aria-label="Explore meaning"]').waitForEnabled();
    await clickNative($('button[aria-label="Explore meaning"]'));
    await waitForNativeInput($('.phrase-save-toggle'));
    await clickNative($('.phrase-save-toggle'));
    await expect($('[role="dialog"]')).not.toExist();
    await replaceValue($('.save-phrase-form input'), 'native inline phrase');
    await replaceValue($('.save-phrase-form textarea'), 'Saved through the phrase panel');
    const save = $('.save-phrase-form').$('button=Save phrase');
    await browser.execute(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }), await save);
    await clickNative(save);
    // Debug builds verify large external tool hashes before each real FFmpeg operation.
    await browser.waitUntil(async () => (await invoke('get_app_snapshot')).cards.some(card => card.term === 'native inline phrase'), { timeout: 180000 });
    const saved = (await invoke('get_app_snapshot')).cards.find(card => card.term === 'native inline phrase');
    savedCardIds.push(saved.id);
    assert.equal(saved.meaning, 'Saved through the phrase panel');
    assert.equal(saved.segmentId, 'fixture-0');
    assert(saved.audioPath && existsSync(saved.audioPath));
    assert(statSync(saved.audioPath).size > 44);
    await expect($('.save-phrase-form')).not.toExist();
    await expect($('.phrase-saved')).toBeDisplayed();
    await clickNative($('button=Resume from original position'));
    await browser.waitUntil(async () => !(await player()).paused);
    await control({ action: 'pause' });
  });
  it('retains uncovered native video for playback settings and restores focus without closing the background panel on Escape', async () => {
    await control({ action: 'pause' });
    const transcript = $('.study-transcript-toggle');
    if ((await transcript.getAttribute('aria-expanded')) !== 'true') await clickNative(transcript);
    await $('.transcript-panel').waitForDisplayed();
    await clickNative($('button=Playback settings'));
    await $('[role="dialog"]').waitForDisplayed();
    await browser.waitUntil(async () => (await player()).surfaceVisible);
    await browser.execute(() => document.querySelector('[role="dialog"]').focus());
    await browser.keys(Key.Space);
    assert.equal((await player()).paused, true, 'The background player responded to Space inside a modal');
    await browser.keys(Key.Escape);
    await expect($('[role="dialog"]')).not.toExist();
    await expect($('.transcript-panel')).toBeDisplayed();
    await browser.waitUntil(async () => (await player()).surfaceVisible);
    await expect($('button=Playback settings')).toBeFocused();
    await assertNativeVideoBounds();
    await saveNativeScreenshot(nativeArtifact('surface-modal-escape.png'));
    await clickNative(transcript);
    await expect($('.transcript-panel')).not.toBeDisplayed();
  });
  it('autosaves edits directly and restores the visible edit action without a confirmation', async () => {
    const original = (await invoke('get_app_snapshot')).cards.find(card => card.id === fixture.cardId);
    assert(original);
    try {
      await navigate('/cards');
      const row = () => $(`summary[aria-label="Actions for ${original.term}"]`).$('..').$('..').$('..');
      const edit = () => row().$('[aria-label="Edit phrase"]');
      await clickNative(edit());
      const editor = $('[role="dialog"]');
      const meaning = editor.$('textarea');
      await meaning.waitForEnabled();
      await replaceValue(meaning, 'Native automatic edit');
      await clickNative(editor.$('input'));
      await browser.waitUntil(async () => (await invoke('get_app_snapshot')).cards.find(card => card.id === original.id)?.meaning === 'Native automatic edit');
      await expect(meaning).toBeEnabled();
      assert.equal((await $$('[role="dialog"]')).length, 1);
      await clickNative(editor.$('[aria-label="Close"]'));
      await expect($('[role="dialog"]')).not.toExist();
      await expect(edit()).toBeFocused();
      await saveNativeScreenshot(nativeArtifact('card-autosave-return.png'));
    } finally {
      await invoke('edit_card', { request: { id: original.id, term: original.term, meaning: original.meaning,
        example: original.example, translation: original.translation, explanation: original.explanation } });
      await navigate(`/study/${mediaId}`);
      await browser.refresh();
      await $('.play-button').waitForEnabled();
    }
  });
  it('retains unfinished phrase input across Escape and reopening without nested confirmation', async () => {
    const original = (await invoke('get_app_snapshot')).cards.find(card => card.id === fixture.cardId);
    assert(original);
    try {
      await navigate('/cards');
      const edit = () => $(`summary[aria-label="Actions for ${original.term}"]`).$('..').$('..').$('..').$('[aria-label="Edit phrase"]');
      await clickNative(edit());
      const editor = $('[role="dialog"]');
      const term = editor.$('input'), meaning = editor.$('textarea');
      await term.waitForEnabled();
      await replaceValue(term, '');
      await replaceValue(meaning, 'Native unfinished phrase edit');
      await browser.keys(Key.Escape);
      await expect($('[role="dialog"]')).not.toExist();
      assert.equal((await invoke('get_app_snapshot')).cards.find(card => card.id === original.id).term, original.term);
      await clickNative(edit());
      // Closing unmounts the dialog. Resolve the newly mounted inputs instead
      // of asking WebDriver to recover references to the previous DOM nodes.
      const reopenedEditor = $('[role="dialog"]');
      const reopenedTerm = reopenedEditor.$('input');
      await reopenedTerm.waitForEnabled();
      await expect(reopenedTerm).toHaveValue('');
      await expect(reopenedEditor.$('textarea')).toHaveValue('Native unfinished phrase edit');
      assert.equal((await $$('[role="dialog"]')).length, 1);
      await replaceValue(reopenedTerm, original.term);
      await clickNative(reopenedEditor.$('[aria-label="Close"]'));
      await expect($('[role="dialog"]')).not.toExist();
      await browser.waitUntil(async () => (await invoke('get_app_snapshot')).cards.find(card => card.id === original.id)?.meaning === 'Native unfinished phrase edit');
    } finally {
      await invoke('edit_card', { request: { id: original.id, term: original.term, meaning: original.meaning,
        example: original.example, translation: original.translation, explanation: original.explanation } });
      await navigate(`/study/${mediaId}`);
      await $('.play-button').waitForEnabled();
      await browser.waitUntil(async () => (await player()).surfaceVisible);
      await assertNativeVideoBounds();
    }
  });
  it('restores video bounds after fullscreen and page scrolling', async () => {
    const fullscreen = $('[aria-label="Toggle fullscreen"]');
    await clickNative(fullscreen);
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await browser.waitUntil(async () => (await player()).surfaceVisible);
    await assertNativeVideoBounds();
    await clickNative(fullscreen);
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    await browser.execute(() => {
      const content = document.querySelector('.page-content');
      content.scrollTop = content.scrollHeight;
      content.dispatchEvent(new Event('scroll'));
      content.scrollTop = 0;
      content.dispatchEvent(new Event('scroll'));
    });
    await browser.waitUntil(async () => (await player()).surfaceVisible);
    await assertNativeVideoBounds();
  });
  for (const [kind, fixtureMediaId] of [['translation', 'e2e-ai-recovery'], ['transcription', 'e2e-transcript-review']]) {
  it(`opens ${kind} job details with Space without starting playback`, async () => {
    const snapshot = await invoke('get_app_snapshot');
    const job = snapshot.jobs.find(item =>
      item.mediaId === fixtureMediaId && (item.status !== 'completed' || item.pendingResults > 0 || item.transcriptReview) &&
      snapshot.media.some(media => media.id === item.mediaId));
    assert(job, `The isolated ${kind} job fixture must exist; this case cannot skip`);
    try {
      await navigate(`/study/${job.mediaId}`);
      await $('.play-button').waitForEnabled();
      await control({ action: 'pause' });
      const transcription = job.kind === 'transcribe' || job.automaticTranscript;
      if (transcription) {
        const transcript = $('.study-transcript-toggle');
        if ((await transcript.getAttribute('aria-expanded')) !== 'true') await clickNative(transcript);
        const tab = $('.transcript-tabs').$('button=Transcription');
        await waitForNativeInput(tab);
        await clickNative(tab);
        await $('.transcription-workspace').waitForDisplayed();
      } else {
        await clickNative($('button=Activity & tools'));
      }
      const details = transcription ? $('.transcription-workspace > details') : $('.study-jobs');
      const summary = details.$('summary');
      await waitForNativeInput(summary);
      const wasOpen = await details.getAttribute('open');
      await browser.execute(node => node.focus(), await summary);
      await browser.keys(Key.Space);
      await browser.waitUntil(async () => (await details.getAttribute('open')) !== wasOpen);
      assert.equal((await player()).paused, true, 'Opening the job summary started playback');
    } finally {
      await navigate(`/study/${mediaId}`);
      await $('.play-button').waitForEnabled();
    }
  });
  }
});
