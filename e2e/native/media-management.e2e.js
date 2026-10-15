// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { nativeArtifact } from '../support/native-artifacts.mjs';
import { invokeNative as invoke, expectNativeRejection, restartNativeSession, prepareNativeSession, waitForNativeInput, clickNative, replaceNativeValue } from '../support/native-app.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Key } from 'webdriverio';
const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const source = resolve(dirname(fixture.mediaPath), '多言語 & tracks.mkv');
const snapshot = () => invoke('get_app_snapshot');
const navigate = path => browser.execute(next => { window.history.pushState({}, '', next); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let server, serverUrl, originalSettings, originalFfmpeg, managedMediaId;
let retainManagedMedia = false;
const mediaToolTimeout = 180000;
const ready = prepareNativeSession;
async function playerReady() {
  await browser.waitUntil(async () => {
    const state = await invoke('get_player_state');
    return state.ready === true && state.surfaceVisible && state.videoWidth > 0 && state.videoHeight > 0;
  }, { timeout: 15000, timeoutMsg: 'Player did not decode video into its visible native surface' });
}
async function openManagement() {
  if (!(await $('.study-secondary-tools').isDisplayed())) await clickNative($('button=Activity & tools'));
  await $('.study-secondary-tools').waitForDisplayed();
}
async function openSubtitles() {
  const toggle = $('.study-transcript-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await clickNative(toggle);
  const sourcePicker = $('button=Add or switch subtitles');
  await waitForNativeInput(sourcePicker);
  await clickNative(sourcePicker);
  await $('[role="dialog"]').waitForDisplayed();
  const embedded = $('[role="dialog"]').$('button=Embedded');
  await waitForNativeInput(embedded);
  await clickNative(embedded);
  await $('[role="dialog"] select').waitForDisplayed();
}
async function dialogClosed() { await $('[role="dialog"]').waitForExist({ reverse: true, timeout: 60000 }); }
async function openDownloads() {
  const opener = $('button=Downloads');
  await opener.waitForClickable();
  await clickNative(opener);
  const dialog = $('[role="dialog"]');
  await dialog.waitForDisplayed();
  await expect(dialog.$('h2')).toHaveText('Downloads');
  return dialog;
}
async function chooseSubtitle(value) {
  // A cold inspection hashes/probes the real FFmpeg pair before ffprobe runs.
  // Match the native IPC budget while loading, then assert the requested option.
  const started = Date.now();
  await $('[role="dialog"] select').waitForEnabled({ timeout: mediaToolTimeout });
  console.info(`[media-management] subtitle choices ready in ${Date.now() - started} ms`);
  await expect($(`[role="dialog"] option[value="${value}"]`)).toExist();
  await $('[role="dialog"] select').selectByAttribute('value', String(value));
}
const replaceValue = replaceNativeValue;
async function cardArticle() { await navigate('/cards'); const search = $('[aria-label="Search your phrases"]'); await search.waitForEnabled(); await replaceValue(search, 'managed phrase'); await browser.waitUntil(async () => (await $$('.phrase-card')).length === 1); return $('.phrase-card'); }
async function importMultitrack(title) {
  assert(existsSync(source), 'Generate the multitrack fixture before native E2E');
  const imported = await invoke('import_local_media', { request: { kind: 'local', pathOrUrl: source, title, learningLanguage: 'en', explanationLanguage: 'ja' } });
  assert(imported.created, 'Each media-management case must start with a fresh imported media record');
  managedMediaId = imported.mediaId;
  await navigate(`/study/${managedMediaId}`); await playerReady();
  return managedMediaId;
}
async function removeManagedMedia() {
  if (!managedMediaId) return;
  const current = await snapshot();
  for (const card of current.cards.filter(item => item.mediaId === managedMediaId)) await invoke('delete_card', { cardId: card.id });
  if (current.media.some(item => item.id === managedMediaId)) await invoke('remove_media', { mediaId: managedMediaId });
  managedMediaId = undefined;
}

describe('native media management and background downloads', () => {
  before(async () => {
    await ready(); const initial = await snapshot();
    originalSettings = initial.settings;
    originalFfmpeg = initial.tools.find(item => item.id === 'ffmpeg');
    await invoke('update_settings', { settings: { ...initial.settings, locale: 'en', dailyBudgetUsd: 0, replayContextMs: 0 } });
    const ffmpeg = (await invoke('scan_external_tools')).find(item => item.toolId === 'ffmpeg' && item.selectable);
    assert(ffmpeg); await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: ffmpeg.path } });
    await browser.refresh(); await ready();
  });
  beforeEach(async () => {
    if (retainManagedMedia) return;
    await navigate('/'); await browser.refresh(); await ready();
  });
  afterEach(async () => {
    if (!retainManagedMedia) await removeManagedMedia();
  });
  after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (originalFfmpeg) await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: originalFfmpeg.provider, ...(originalFfmpeg.provider === 'external' ? { path: originalFfmpeg.path } : {}) } });
    if (originalSettings) await invoke('update_settings', { settings: originalSettings });
  });

  // WDIO captures the timeout before entering the callback; this.timeout() inside
  // a long test cannot extend its wrapper. Keep real tool operations in separate
  // cases with fresh records so a slow subtitle run cannot consume the card budget.
  it('retains the selected audio track and resume position through restart', async () => {
    const mediaId = await importMultitrack('Multitrack resume regression');
    const tracks = (await invoke('get_player_state')).tracks;
    const english = tracks.find(track => track.kind === 'audio' && track.ffIndex === 2);
    assert(english && english.id !== english.ffIndex, 'Fixture must distinguish mpv ID from FFmpeg index');
    await clickNative($('button=Playback settings'));
    await $('[aria-label="Audio track"]').selectByAttribute('value', String(english.id));
    await browser.waitUntil(async () => (await snapshot()).media.find(item => item.id === mediaId).audioStreamIndex === 2);
    await clickNative($('[role="dialog"] [aria-label="Close"]'));
    await invoke('player_control', { request: { action: 'seek', startMs: 5000 } });
    await browser.waitUntil(async () => (await snapshot()).media.find(item => item.id === mediaId).lastPositionMs >= 4900);
    await restartNativeSession(); await navigate(`/study/${mediaId}`); await playerReady();
    const state = await invoke('get_player_state');
    assert(state.paused && state.positionMs >= 4900 && state.positionMs <= 5300, `Wrong resume position: ${state.positionMs}`);
    assert.equal(state.tracks.find(track => track.kind === 'audio' && track.selected).ffIndex, 2);
    await browser.saveScreenshot(nativeArtifact('media-resume-tracks.png'));
  });

  describe('edited subtitle versions across source replacement', () => {
    let mediaId, savedVersion;
    // Keep one owned record across the workflow's phases. Each cold inspection
    // and extraction retains the normal test budget instead of sharing one timer.
    before(async () => {
      retainManagedMedia = true;
      await navigate('/'); await browser.refresh(); await ready();
      mediaId = await importMultitrack('Multitrack subtitle regression');
      await invoke('select_audio_stream', { mediaId, streamIndex: 2 });
    });
    after(async () => {
      try { await removeManagedMedia(); }
      finally { retainManagedMedia = false; }
    });
    const assertAudioSelection = async () => {
      assert.equal((await snapshot()).media.find(item => item.id === mediaId).audioStreamIndex, 2, 'Subtitle changes must preserve the saved audio selection');
      assert.equal((await invoke('get_player_state')).tracks.find(track => track.kind === 'audio' && track.selected)?.ffIndex, 2, 'Subtitle changes must preserve the playing audio track');
    };
    it('imports Japanese embedded subtitles without changing the selected audio track', async () => {
      await openSubtitles();
      await chooseSubtitle('3');
      await clickNative($('button=Use these subtitles'));
      await browser.waitUntil(async () => (await invoke('list_segments', { mediaId })).some(cue => cue.text.includes('日本語')), { timeout: mediaToolTimeout });
      await dialogClosed();
      await assertAudioSelection();
    });
    it('preserves edited Japanese subtitles when switching to English after reload', async () => {
      const original = (await invoke('list_segments', { mediaId }))[0];
      assert(original?.text.includes('日本語'), 'The Japanese extraction must finish before testing replacement');
      await invoke('edit_segment', { segment: { ...original, text: '日本語の字幕を編集しました。' } });
      await expectNativeRejection(invoke('extract_embedded_subtitles', { mediaId, streamIndex: 1, replaceExisting: false }), /Confirm replacement/);
      await browser.refresh(); await ready(); await openSubtitles();
      await chooseSubtitle('1');
      await $('button=Use these subtitles').waitForEnabled();
      assert.match(await $('[role="dialog"]').getText(), /Keep the current subtitles as a saved version/);
      assert.equal((await $$('[role="dialog"] input[type="checkbox"]')).length, 0, 'Selecting the replacement source should not need a second confirmation');
      await clickNative($('button=Use these subtitles'));
      await browser.waitUntil(async () => (await invoke('list_segments', { mediaId }))[0]?.text === 'English track one.', { timeout: mediaToolTimeout });
      await dialogClosed();
      await assertAudioSelection();
      const versions = await invoke('list_subtitle_versions', { mediaId }); assert.equal(versions.length, 1);
      assert.equal(versions[0].streamIndex, 3); assert.equal(versions[0].segments[0].text, '日本語の字幕を編集しました。');
      savedVersion = versions[0];
    });
    it('restores the edited saved subtitle version without changing audio selection', async () => {
      assert(savedVersion, 'Source replacement must preserve a validated subtitle version before restoring it');
      await clickNative($('button=Add or switch subtitles'));
      await clickNative($('[role="dialog"]').$('button=Saved subtitles'));
      await chooseSubtitle(savedVersion.id);
      await $('button=Use these subtitles').waitForEnabled();
      await clickNative($('button=Use these subtitles'));
      await browser.waitUntil(async () => (await invoke('list_segments', { mediaId }))[0]?.text === '日本語の字幕を編集しました。', { timeout: 60000 });
      await dialogClosed();
      await assertAudioSelection();
      assert.equal((await snapshot()).media.find(item => item.id === mediaId).subtitleStreamIndex, 3);
    });
  });

  it('retains saved source audio and card edits through media removal', async () => {
    const mediaId = await importMultitrack('Multitrack card regression');
    await invoke('select_audio_stream', { mediaId, streamIndex: 2 });
    await invoke('extract_embedded_subtitles', { mediaId, streamIndex: 3, replaceExisting: false });
    const sourceCues = await invoke('list_segments', { mediaId });
    const segment = sourceCues[0];
    const before = await snapshot();
    await invoke('save_card', { request: { mediaId, segmentId: segment.id, sourceCueIds: sourceCues.map(cue => cue.id), term: 'managed phrase', meaning: 'Original meaning', example: sourceCues.map(cue => cue.text).join('\n') } });
    const saved = (await snapshot()).cards.find(item => !before.cards.some(old => old.id === item.id)); assert(saved); const cardId = saved.id;
    assert.equal(saved.audioStreamIndex, 2); const savedAudioPath = saved.audioPath, savedAudioHash = hash(savedAudioPath);
    assert.equal(saved.sourceCues.length, 2); assert.equal(saved.startMs, 500); assert.equal(saved.endMs, 4500);
    const bytes = readFileSync(savedAudioPath), offset = bytes.indexOf(Buffer.from('data')) + 8;
    let crossings = 0; for (let i = offset + 2; i + 1 < bytes.length; i += 2) if (bytes.readInt16LE(i - 2) < 0 && bytes.readInt16LE(i) >= 0) crossings++;
    assert(crossings >= 1745 && crossings <= 1770, `Wrong audio track or incomplete source range in saved clip: ${crossings} crossings`);
    await invoke('rate_card', { cardId, rating: 'good' }); const rated = (await snapshot()).cards.find(item => item.id === cardId);
    await browser.refresh(); await ready(); const article = await cardArticle();
    await clickNative(article.$('[aria-label="Listen to managed phrase"]'));
    await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.ready && !state.paused && state.positionMs > 100; });
    await clickNative(article.$('[aria-label="Edit phrase"]'));
    const meaning = $('[role="dialog"] textarea');
    await meaning.waitForEnabled();
    await expect(meaning).toHaveValue('Original meaning');
    await replaceValue(meaning, 'Corrected meaning');
    await browser.keys(Key.Tab);
    await browser.waitUntil(async () => (await snapshot()).cards.find(item => item.id === cardId).meaning === 'Corrected meaning');
    await expect($('[role="dialog"] .autosave-footer [role="status"]')).toHaveText('Saved automatically');
    await clickNative($('[role="dialog"] .modal-footer').$('button=Close'));
    await dialogClosed();
    await browser.waitUntil(async () => (await snapshot()).cards.find(item => item.id === cardId).meaning === 'Corrected meaning');
    const suspendArticle = await cardArticle();
    await clickNative(suspendArticle.$('.phrase-options summary'));
    await clickNative(suspendArticle.$('button=Suspend reviews'));
    await browser.waitUntil(async () => (await snapshot()).cards.find(item => item.id === cardId).suspended === true);
    const changed = (await snapshot()).cards.find(item => item.id === cardId);
    assert.equal(changed.dueAt, rated.dueAt); assert.equal(changed.reviewCount, rated.reviewCount); assert.equal(hash(savedAudioPath), savedAudioHash);

    await navigate(`/study/${mediaId}`); await openManagement();
    await waitForNativeInput($('button=Remove from library'));
    await clickNative($('button=Remove from library'));
    await clickNative($('[role="dialog"]').$('button=Remove from library'));
    await dialogClosed();
    await browser.waitUntil(async () => !(await snapshot()).media.some(item => item.id === mediaId));
    assert(existsSync(source)); assert.equal(hash(savedAudioPath), savedAudioHash); assert((await snapshot()).cards.some(item => item.id === cardId));
    const deleteArticle = await cardArticle();
    await clickNative(deleteArticle.$('.phrase-options summary'));
    await clickNative(deleteArticle.$('button=Delete')); await clickNative($('[role="dialog"]').$('button=Delete phrase'));
    await dialogClosed();
    await browser.waitUntil(async () => !(await snapshot()).cards.some(item => item.id === cardId));
    assert(existsSync(source));
  });
  it('imports a local HTTP fixture through the UI, cancels a slow download and explicitly retries a failed one', async () => {
    const body = readFileSync(fixture.mediaPath); let retries = 0;
    server = createServer((request, response) => {
      if (request.url === '/slow.mp4') {
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 128 * 1024 * 1024 });
        const interval = setInterval(() => response.write(Buffer.alloc(64 * 1024)), 50); response.on('close', () => clearInterval(interval));
      } else if (request.url === '/retry.mp4' && retries++ === 0) {
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length + 1000 }); response.end(body);
      } else { response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length }); response.end(body); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); serverUrl = `http://127.0.0.1:${server.address().port}`;
    await navigate('/'); await clickNative($('button=Add video or audio')); await clickNative($('[role="dialog"]').$('button=URL')); await replaceNativeValue($('[role="dialog"] input[type="url"]'), `${serverUrl}/success.mp4`); await clickNative($('[role="dialog"]').$('button=Start download'));
    await browser.waitUntil(async () => (await invoke('list_download_jobs')).some(job => job.request.pathOrUrl === `${serverUrl}/success.mp4` && job.status === 'completed'));
    await dialogClosed();
    const completed = (await invoke('list_download_jobs')).find(job => job.request.pathOrUrl === `${serverUrl}/success.mp4`);
    await $(`a.media-card[href="/study/${completed.mediaId}"]`).waitForDisplayed();
    const request = { kind: 'url', learningLanguage: 'en', explanationLanguage: 'ja', pathOrUrl: `${serverUrl}/slow.mp4` };
    const slow = await invoke('start_url_import', { request }); await browser.waitUntil(async () => (await invoke('list_download_jobs')).find(job => job.id === slow).storedBytes > 0);
    const downloads = await openDownloads();
    const slowArticle = downloads.$(`[data-download-id="${slow}"]`);
    await slowArticle.waitForDisplayed();
    const cancel = slowArticle.$('button=Cancel download');
    await cancel.waitForClickable();
    await clickNative(cancel); await browser.waitUntil(async () => (await invoke('list_download_jobs')).find(job => job.id === slow).status === 'cancelled');
    const failed = await invoke('start_url_import', { request: { ...request, pathOrUrl: `${serverUrl}/retry.mp4` } });
    await browser.waitUntil(async () => (await invoke('list_download_jobs')).find(job => job.id === failed).status === 'failed');
    const article = downloads.$(`[data-download-id="${failed}"]`);
    await article.waitForDisplayed();
    const retry = article.$('button=Retry from start');
    await retry.waitForClickable();
    await clickNative(retry);
    await browser.waitUntil(async () => (await invoke('list_download_jobs')).some(job => job.id !== failed && job.request.pathOrUrl === `${serverUrl}/retry.mp4` && job.status === 'completed'));
    const final = await snapshot(); assert.equal(final.budget.spentUsd, 0); assert.equal(final.budget.reservedUsd, 0); assert.equal(final.settings.credentialConfigured, false);
    assert(!readdirSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'media')).some(name => name.startsWith('.download-')), 'Cancelled or failed downloads retained partial files');
    await browser.saveScreenshot(nativeArtifact('background-downloads.png'));
    assert(await browser.execute(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)),
      'Download actions must retain keyboard focus in the dialog after pending buttons are disabled');
    await browser.keys(Key.Escape);
    await dialogClosed();
    await expect($('button=Downloads')).toBeFocused();
  });
  it('decodes, plays and seeks the generated CPU AV1 fixture', async () => {
    const path = process.env.SURTITLE_E2E_AV1_FIXTURE;
    assert(path && existsSync(path), 'Set SURTITLE_E2E_AV1_FIXTURE to the generated CI AV1 fixture');
    await invoke('import_media', { request: { kind: 'local', pathOrUrl: path, title: 'CPU AV1 candidate regression', learningLanguage: 'en', explanationLanguage: 'ja' } });
    const media = (await snapshot()).media.find(item => item.title === 'CPU AV1 candidate regression');
    assert(media); await navigate(`/study/${media.id}`); await playerReady();
    await invoke('player_control', { request: { action: 'seek', startMs: 0, endMs: 2000 } });
    await browser.waitUntil(async () => {
      const state = await invoke('get_player_state');
      return !state.error && state.videoWidth > 0 && state.videoHeight > 0 && !state.paused && state.positionMs >= 500;
    }, { timeout: 15000, timeoutMsg: 'CPU AV1 playback did not advance' });
    await invoke('player_control', { request: { action: 'pause' } });
    await invoke('player_control', { request: { action: 'seek', startMs: 2400 } });
    await browser.waitUntil(async () => {
      const state = await invoke('get_player_state');
      return !state.error && state.ready && state.paused && state.positionMs >= 2300 && state.positionMs <= 2500;
    }, { timeout: 15000, timeoutMsg: 'CPU AV1 seek did not settle' });
    await browser.saveScreenshot(nativeArtifact('candidate-av1.png'));
  });
});
