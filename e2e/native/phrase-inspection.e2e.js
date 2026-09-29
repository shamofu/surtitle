// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const mediaId = fixture.mediaId;
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const navigate = path => browser.execute(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);

(process.platform === 'win32' ? describe : describe.skip)('watch, inspect, and return with the Windows native surface', () => {
  let originalSettings;
  const savedCardIds = [];
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
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
    await browser.refresh();
    await $('.play-button').waitForEnabled();
    await control({ action: 'pause' });
  });
  it('keeps the full native surface visible when opening panels and resizing at the minimum window size', async () => {
    for (const [width, height] of [[1440, 900], [1024, 700]]) {
      await browser.setWindowSize(width, height);
      await browser.waitUntil(async () => (await player()).surfaceVisible, { timeoutMsg: 'Native video is clipped at this window size' });
      await $('button=Transcript').click();
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
      await browser.saveScreenshot(resolve(`test-results/native/learning-${width}x${height}.png`));
      await $('button=Transcript').click();
    }
  });
  it('pauses to inspect, keeps the selected context during replay, and returns to its starting position', async () => {
    await control({ action: 'pause' });
    await control({ action: 'seek', value: 200 });
    await browser.waitUntil(async () => (await player()).positionMs < 500);
    await $('button=Inspect this phrase').waitForEnabled();
    await $('button=Inspect this phrase').click();
    await $('button=Return to watching').waitForDisplayed();
    assert.equal((await player()).paused, true);
    const returnPosition = (await player()).positionMs;
    const originalContext = await $('.phrase-panel .context-sentence').getText();
    await $('.phrase-panel').$('button=Listen again').click();
    await browser.waitUntil(async () => !(await player()).paused);
    await browser.waitUntil(async () => (await player()).paused, { timeout: 12000 });
    assert.equal(await $('.phrase-panel .context-sentence').getText(), originalContext);
    await $('[aria-label="Repeat selected segment"]').click();
    await $('[aria-label="Repeat selected segment"]').waitForDisplayed();
    await $('button=Return to watching').click();
    await browser.waitUntil(async () => { const state = await player(); return !state.paused && state.positionMs >= returnPosition; });
    await browser.waitUntil(async () => (await player()).positionMs > 1600, { timeout: 6000, timeoutMsg: 'Returning retained the old range stop or repeat' });
    await control({ action: 'pause' });
    assert.equal((await invoke('get_app_snapshot')).budget.spentUsd, 0);
  });
  it('keeps video and controls inside a compact window with long subtitles and More expanded', async () => {
    const original = (await invoke('list_segments', { mediaId }))[0];
    try {
      await invoke('edit_segment', { segment: { ...original, text: 'Sometimes a longer sentence needs more space to stay readable. We can take a little detour, listen again, and discover how the same words fit into the world around us without losing the picture or the playback controls.' } });
      await browser.refresh();
      await browser.setWindowSize(1024, 700);
      await browser.waitUntil(async () => (await player()).ready);
      await control({ action: 'pause' });
      await control({ action: 'seek', value: original.startMs });
      await browser.waitUntil(async () => (await $('.current-caption-text').getText()).startsWith('Sometimes a longer sentence'));
      await $('button=More').click();
      await browser.waitUntil(async () => (await player()).surfaceVisible);
      const inside = await browser.execute(() => {
        const page = document.querySelector('.page-content').getBoundingClientRect();
        const video = document.querySelector('[data-testid="native-player-viewport"]').getBoundingClientRect();
        const controls = document.querySelector('.player-controls').getBoundingClientRect();
        return video.top >= page.top && video.bottom <= page.bottom && controls.bottom <= Math.min(page.bottom, innerHeight);
      });
      assert(inside, 'A long current subtitle or expanded More toolbar clipped the native video or controls');
      await browser.saveScreenshot(resolve('test-results/native/learning-long-caption-more.png'));
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
    await $('button=Inspect this phrase').waitForEnabled();
    await $('button=Inspect this phrase').click();
    await $('button=Save a phrase').waitForEnabled();
    await $('button=Save a phrase').click();
    await expect($('dialog')).not.toExist();
    await $('.save-phrase-form input').setValue('native inline phrase');
    await $('.save-phrase-form textarea').setValue('Saved through the phrase panel');
    const save = $('.save-phrase-form').$('button=Save phrase');
    await browser.execute(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }), await save);
    await save.click();
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
    await $('button=Return to watching').click();
    await browser.waitUntil(async () => !(await player()).paused);
    await control({ action: 'pause' });
  });
  it('hides native video for playback settings and restores it after closing the modal', async () => {
    await $('button=More').click();
    await $('button=Playback settings').click();
    await $('dialog').waitForDisplayed();
    await browser.waitUntil(async () => !(await player()).surfaceVisible);
    await $('button[aria-label="Close"]').click();
    await browser.waitUntil(async () => (await player()).surfaceVisible);
    await expect($('button=Playback settings')).toBeFocused();
  });
  it('restores video bounds after fullscreen and page scrolling', async () => {
    const fullscreen = $('[aria-label="Toggle fullscreen"]');
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await browser.waitUntil(async () => (await player()).surfaceVisible);
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    await browser.execute(() => {
      const content = document.querySelector('.page-content');
      content.scrollTop = content.scrollHeight;
      content.dispatchEvent(new Event('scroll'));
      content.scrollTop = 0;
      content.dispatchEvent(new Event('scroll'));
    });
    await browser.waitUntil(async () => (await player()).surfaceVisible);
  });
  it('opens job details with Space without starting playback', async function () {
    const snapshot = await invoke('get_app_snapshot');
    const job = snapshot.jobs.find(item =>
      (item.status !== 'completed' || item.pendingResults > 0 || item.transcriptReview) &&
      snapshot.media.some(media => media.id === item.mediaId));
    if (!job) { this.skip(); return; }
    try {
      await navigate(`/study/${job.mediaId}`);
      await $('.play-button').waitForEnabled();
      await control({ action: 'pause' });
      const summary = $('.study-jobs summary');
      await summary.waitForDisplayed();
      const wasOpen = await $('.study-jobs').getAttribute('open');
      await browser.execute(node => node.focus(), await summary);
      await browser.keys(Key.Space);
      await browser.waitUntil(async () => (await $('.study-jobs').getAttribute('open')) !== wasOpen);
      assert.equal((await player()).paused, true, 'Opening the job summary started playback');
    } finally {
      await navigate(`/study/${mediaId}`);
      await $('.play-button').waitForEnabled();
    }
  });
});
