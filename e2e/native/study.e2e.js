// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const mediaId = fixture.mediaId || 'fixture-media';
const cardId = fixture.cardId || 'fixture-card';
async function invoke(command, args = {}) {
  return browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
}
async function snapshot() { return invoke('get_app_snapshot'); }
async function navigate(path) {
  await browser.execute(nextPath => { window.history.pushState({}, '', nextPath); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
}
describe('real native learning workflow (no cloud requests)', () => {
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__), { timeoutMsg: 'Native IPC was not available' });
    const initial = await snapshot();
    await invoke('update_settings', { settings: { ...initial.settings, locale: 'en', dailyBudgetUsd: 0 } });
    await browser.refresh();
    await $('h1').waitForDisplayed();
  });
  it('imports an actual local video with a Japanese filename and shell punctuation', async () => {
    const before = await snapshot();
    await invoke('import_media', { request: { kind: 'local', pathOrUrl: fixture.mediaPath, learningLanguage: 'en', explanationLanguage: 'ja' } });
    const after = await snapshot();
    assert.equal(after.media.length, before.media.length + 1);
    const imported = after.media.find(media => !before.media.some(previous => previous.id === media.id));
    assert(imported.title.includes('日本語 & sample'));
    assert.equal(imported.status, 'ready');
    assert.equal(after.budget.spentUsd, 0);
    await browser.refresh();
    assert((await snapshot()).media.some(media => media.id === imported.id));
  });
  it('loads persisted content, handles 20000 subtitles, and suspends auto-follow on manual scroll', async () => {
    const initial = await snapshot();
    assert(initial.media.some(media => media.id === mediaId));
    assert.equal((await invoke('list_segments', { mediaId })).length, 20000);
    await navigate(`/study/${mediaId}`);
    await $('[aria-label="Subtitle list"]').waitForDisplayed();
    const rows = await $$('.transcript-row');
    assert(rows.length > 0 && rows.length < 80, `Expected virtualized DOM, got ${rows.length} rows`);
    await browser.execute(() => document.querySelector('.transcript-scroll').dispatchEvent(new WheelEvent('wheel', { deltaY: 650, bubbles: true })));
    await expect($('button=Follow playback')).toBeDisplayed();
    await $('[aria-label="Search transcript"]').setValue('19999');
    await browser.waitUntil(async () => (await $$('.transcript-row')).length <= 2);
    await $('button=Follow playback').click();
    await expect($('[aria-label="Search transcript"]')).toHaveValue('');
    await expect($('button=Following playback')).toBeDisplayed();
    await browser.saveScreenshot(resolve('test-results/native/study.png'));
  });
  it('checks tool update information without installing tools or changing AI usage', async () => {
    const before = await snapshot();
    assert.equal(before.settings.credentialConfigured, false, 'Expected the disposable profile without credentials');
    assert.equal(before.budget.spentUsd, 0);
    assert.equal(before.budget.reservedUsd, 0);
    assert.equal(before.budget.limitUsd, 0);
    assert(before.media.some(media => media.id === mediaId && media.path === fixture.mediaPath), 'Expected the exact disposable media fixture');
    const assertNoManagedCli = tools => {
      const cli = tools.filter(tool => ['ffmpeg', 'yt-dlp', 'deno'].includes(tool.id));
      assert.deepEqual(cli.map(tool => tool.id).sort(), ['deno', 'ffmpeg', 'yt-dlp']);
      for (const tool of cli) {
        // Installed managed tools would perform a real upstream metadata request.
        assert(tool.provider === 'external' || (tool.provider === 'managed' && tool.status === 'missing'), `Refusing a network-capable update check for ${tool.id}`);
      }
    };
    assertNoManagedCli(before.tools);
    try {
      await navigate('/settings');
      await $('button=Check updates').waitForEnabled();
      await $('button=Check updates').click();
      const success = $('button.toast.success');
      await expect(success).toBeDisplayed();
      await expect(success).toHaveText('Update information checked.');
      const after = await snapshot();
      assertNoManagedCli(after.tools);
      assert.deepEqual(after.tools, before.tools, 'Checking metadata must not install tools or change their provider, path, or version');
      assert.deepEqual(after.settings, before.settings, 'Checking metadata must not change saved settings');
      assert.deepEqual(after.budget, before.budget, 'Checking metadata must leave AI usage and reservations unchanged');
      assert.deepEqual(after.jobs, before.jobs, 'Checking metadata must not create, send, or change AI jobs');
    } finally {
      await navigate(`/study/${mediaId}`);
      await $('[aria-label="Subtitle list"]').waitForDisplayed();
    }
  });
  it('plays one selected interval, pauses at its end, changes speed, and hides the surface for a modal', async function () {
    // Linux CI validates the application flow; libmpv native HWND playback is Windows-only.
    if (process.platform !== 'win32') { this.skip(); return; }
    await navigate(`/study/${mediaId}`);
    await invoke('load_media', { mediaId });
    await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.surfaceVisible && state.videoWidth === 640 && state.videoHeight === 360; }, { timeoutMsg: 'Native surface was not shown or video was not decoded at its fixture dimensions' });
    await invoke('player_control', { request: { action: 'seek', startMs: 500, endMs: 1600 } });
    await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.paused && state.positionMs >= 1400; }, { timeout: 12000, timeoutMsg: 'Selected interval did not stop at its end' });
    await invoke('player_control', { request: { action: 'rate', value: 1.25 } });
    assert.equal((await invoke('get_player_state')).rate, 1.25);
    await $('button=Learn with AI').click();
    await expect($('dialog')).toBeDisplayed();
    await browser.waitUntil(async () => !(await invoke('get_player_state')).surfaceVisible, { timeoutMsg: 'Native child window remained visible over the modal' });
    await browser.saveScreenshot(resolve('test-results/native/ai-modal.png'));
    await $('button[aria-label="Close"]').click();
    await expect($('dialog')).not.toExist();
    await browser.waitUntil(async () => (await invoke('get_player_state')).surfaceVisible, { timeoutMsg: 'Native surface did not return after closing the modal' });
  });
  it('preserves milliseconds in the subtitle editor and replaces the generated subtitle track after repeated edits', async () => {
    await navigate(`/study/${mediaId}`);
    await invoke('player_control', { request: { action: 'seek', value: 0 } });
    const original = (await invoke('list_segments', { mediaId })).find(segment => segment.id === 'fixture-0');
    assert(original);
    const timed = { ...original, startMs: 125, endMs: 875, text: 'Milliseconds matter.' };
    await invoke('edit_segment', { segment: timed });
    // Reload reads actual persisted data and remounts the native player, with no test-only IPC.
    await browser.refresh();
    await $('[aria-label="Subtitle list"]').waitForDisplayed();
    await $('.transcript-row').moveTo();
    await $('[aria-label="Edit subtitle"]').click();
    await $('dialog').waitForDisplayed();
    const times = await $$('dialog .field-row input');
    await expect(times[0]).toHaveValue('0:00.125');
    await expect(times[1]).toHaveValue('0:00.875');
    await $('dialog textarea').setValue('Milliseconds survive a text-only edit.');
    await $('button=Confirm and save').click();
    await expect($('dialog')).not.toExist();
    const saved = (await invoke('list_segments', { mediaId })).find(segment => segment.id === original.id);
    assert.equal(saved.startMs, 125);
    assert.equal(saved.endMs, 875);
    assert.equal(saved.text, 'Milliseconds survive a text-only edit.');
    if (process.platform === 'win32') {
      const generated = async () => (await invoke('get_player_state')).tracks.filter(track => track.kind === 'sub' && track.title === 'Surtitle');
      await browser.waitUntil(async () => (await generated()).length === 1, { timeoutMsg: 'Expected one generated Surtitle subtitle track after editing' });
      const previousId = (await generated())[0].id;
      for (let iteration = 0; iteration < 3; iteration++) {
        await invoke('edit_segment', { segment: { ...saved, text: `Repeated subtitle refresh ${iteration}.` } });
        await browser.waitUntil(async () => (await generated()).length === 1, { timeoutMsg: 'Generated subtitle tracks accumulated during repeated edits' });
      }
      assert.notEqual((await generated())[0].id, previousId, 'Editing did not replace the generated subtitle track');
    }
  });
  it('keeps zero-budget quotes blocked without calling an AI endpoint', async () => {
    // WebKit's WebDriver cannot serialize a rejected IPC promise reliably.
    const result = JSON.parse(await browser.execute(async (id) => {
      try {
        const quote = await window.__TAURI_INTERNALS__.invoke('create_quote', { request: { mediaId: id, kind: 'translate', startMs: 0, endMs: 2000 } });
        return JSON.stringify({ canApprove: quote.canApprove, rejectionMessage: null });
      } catch (error) {
        return JSON.stringify({ canApprove: null, rejectionMessage: String(error) });
      }
    }, mediaId));
    if (result.rejectionMessage) assert.match(result.rejectionMessage, /budget|credential|service.account|price|pricing|auth|model|予算|認証|料金/i);
    else assert.equal(result.canApprove, false);
    const state = await snapshot();
    assert.equal(state.budget.spentUsd, 0);
    assert.equal(state.budget.reservedUsd, 0);
  });
  it('opens a real six-hour audio file and seeks past five hours without installing FFmpeg', async function () {
    const path = resolve(dirname(fixture.mediaPath), 'six-hour-silence.flac');
    assert(existsSync(path), 'Generate the real six-hour FLAC before native E2E');
    const before = await snapshot();
    const beforeTool = before.tools.find(tool => tool.id === 'ffmpeg');
    await invoke('import_media', { request: { kind: 'local', pathOrUrl: path, learningLanguage: 'en', explanationLanguage: 'ja' } });
    const after = await snapshot();
    const imported = after.media.find(media => !before.media.some(previous => previous.id === media.id));
    assert(imported, 'Six-hour media was not imported');
    if (process.platform === 'win32') {
      await navigate(`/study/${imported.id}`);
      // Direct IPC import bypasses React Query's UI mutation invalidation.
      await browser.refresh();
      await $('[data-testid="native-player-viewport"]').waitForDisplayed();
      await invoke('load_media', { mediaId: imported.id });
      await browser.waitUntil(async () => Math.abs((await invoke('get_player_state')).durationMs - 21600000) < 1000, { timeoutMsg: 'libmpv did not read the real six-hour duration' });
      const startMs = 18000500, endMs = 18001600;
      await invoke('player_control', { request: { action: 'seek', startMs, endMs } });
      await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.paused && state.positionMs >= endMs - 250 && state.positionMs <= endMs + 1000; }, { timeout: 12000, timeoutMsg: 'Interval playback did not stop correctly beyond five hours' });
      await invoke('player_control', { request: { action: 'rate', value: 1.5 } });
      assert.equal((await invoke('get_player_state')).rate, 1.5);
      await browser.waitUntil(async () => { const text = await $('.player-time').getText(); return text.includes('5:00') && text.includes('6:00:00'); }, { timeoutMsg: 'The player UI did not show the six-hour timeline and far seek' });
      await browser.saveScreenshot(resolve('test-results/native/six-hour-playback.png'));
    }
    const afterTool = (await snapshot()).tools.find(tool => tool.id === 'ffmpeg');
    const identity = tool => ({ provider: tool?.provider, status: tool?.status, path: tool?.path, version: tool?.version });
    assert.deepEqual(identity(afterTool), identity(beforeTool), 'First playback unexpectedly installed or changed FFmpeg');
  });
  it('requires revealing the meaning before rating and persists the new schedule across reload', async () => {
    const before = (await snapshot()).cards.find(card => card.id === cardId);
    assert(before, 'Seeded review card missing');
    await navigate('/review');
    await $('.review-card').waitForDisplayed();
    await expect($('.rating-button.good')).toBeDisabled();
    await $('button*=Reveal meaning').click();
    await $('.rating-button.good').click();
    await browser.waitUntil(async () => (await snapshot()).cards.find(card => card.id === cardId).reviewCount === before.reviewCount + 1);
    await browser.refresh();
    const after = (await snapshot()).cards.find(card => card.id === cardId);
    assert.equal(after.reviewCount, before.reviewCount + 1);
    assert(Date.parse(after.dueAt) > Date.parse(before.dueAt));
    await browser.saveScreenshot(resolve('test-results/native/review-complete.png'));
  });
  it('uses an explicitly selected PATH FFmpeg to preserve real card audio and explanation independently of subtitle edits', async () => {
    const candidates = await invoke('scan_external_tools');
    const ffmpeg = candidates.find(candidate => candidate.toolId === 'ffmpeg' && candidate.selectable);
    assert(ffmpeg, 'A compatible FFmpeg/ffprobe pair must be available on PATH for native E2E');
    await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: ffmpeg.path } });
    const before = await snapshot();
    const segment = (await invoke('list_segments', { mediaId })).find(item => item.id === 'fixture-0');
    assert(segment);
    const request = { mediaId, segmentId: segment.id, term: 'subtitle', meaning: 'a written caption', example: segment.text, explanation: 'A test explanation retained with the original context.', translation: '元の文脈と音声を保存します。' };
    await invoke('save_card', { request });
    const after = await snapshot();
    const saved = after.cards.find(card => !before.cards.some(previous => previous.id === card.id));
    assert(saved, 'Saving did not persist a new card');
    assert.equal(saved.explanation, request.explanation);
    assert.equal(saved.translation, request.translation);
    assert(saved.audioPath, 'The card did not preserve an audio path');
    assert(existsSync(saved.audioPath), 'The extracted review audio does not exist');
    const originalAudio = readFileSync(saved.audioPath);
    assert(statSync(saved.audioPath).size > 44, 'The review clip is empty');
    await invoke('edit_segment', { segment: { ...segment, text: 'This is a later transcript edit.', translation: '後から字幕だけを編集しました。' } });
    await browser.refresh();
    const persisted = (await snapshot()).cards.find(card => card.id === saved.id);
    assert.equal(persisted.example, request.example);
    assert.equal(persisted.explanation, request.explanation);
    assert.equal(persisted.translation, request.translation);
    assert.equal(persisted.audioPath, saved.audioPath);
    assert.deepEqual(readFileSync(persisted.audioPath), originalAudio, 'Editing the transcript changed the preserved card audio');
  });
});
