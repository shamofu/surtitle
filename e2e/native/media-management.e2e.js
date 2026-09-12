// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const source = resolve(dirname(fixture.mediaPath), '多言語 & tracks.mkv');
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const snapshot = () => invoke('get_app_snapshot');
const navigate = path => browser.execute(next => { window.history.pushState({}, '', next); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let mediaId, cardId, savedAudioHash, savedAudioPath, server, serverUrl;
async function ready() { await browser.setTimeout({ script: 180000 }); await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__)); await $('h1').waitForDisplayed(); }
async function playerReady() {
  await browser.waitUntil(async () => {
    const state = await invoke('get_player_state');
    return state.ready === true && state.surfaceVisible && state.videoWidth > 0 && state.videoHeight > 0;
  }, { timeout: 15000, timeoutMsg: 'Player did not decode video into its visible native surface' });
}
async function openSubtitles() { await $('[aria-label="Extract embedded subtitles"]').click(); await $('dialog').waitForDisplayed(); }
async function dialogClosed() { await $('dialog').waitForExist({ reverse: true, timeout: 60000 }); }
async function chooseSubtitle(value) {
  await $(`dialog option[value="${value}"]`).waitForExist({ timeout: 60000 });
  await $('dialog select').waitForEnabled({ timeout: 60000 });
  await $('dialog select').selectByAttribute('value', String(value));
}
async function cardArticle() { await navigate('/cards'); await $('[aria-label="Search your phrases"]').setValue('managed phrase'); await browser.waitUntil(async () => (await $$('.phrase-card')).length === 1); return $('.phrase-card'); }

(process.platform === 'win32' ? describe : describe.skip)('native media management and background downloads', () => {
  before(async () => {
    assert(existsSync(source), 'Generate the multitrack fixture before native E2E');
    await ready(); const initial = await snapshot();
    await invoke('update_settings', { settings: { ...initial.settings, locale: 'en', dailyBudgetUsd: 0, replayContextMs: 0 } });
    const ffmpeg = (await invoke('scan_external_tools')).find(item => item.toolId === 'ffmpeg' && item.selectable);
    assert(ffmpeg); await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: ffmpeg.path } });
    await invoke('import_media', { request: { kind: 'local', pathOrUrl: source, title: 'Multitrack regression', learningLanguage: 'en', explanationLanguage: 'ja' } });
    mediaId = (await snapshot()).media.find(item => item.title === 'Multitrack regression').id;
    await browser.refresh(); await ready();
  });
  after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });

  it('persists the selected FFmpeg audio index and resumes through a complete process restart', async () => {
    await navigate(`/study/${mediaId}`); await playerReady();
    const tracks = (await invoke('get_player_state')).tracks;
    const english = tracks.find(track => track.kind === 'audio' && track.ffIndex === 2);
    assert(english && english.id !== english.ffIndex, 'Fixture must distinguish mpv ID from FFmpeg index');
    await $('[aria-label="Audio track"]').selectByAttribute('value', String(english.id));
    await browser.waitUntil(async () => (await snapshot()).media.find(item => item.id === mediaId).audioStreamIndex === 2);
    await invoke('player_control', { request: { action: 'seek', startMs: 5000 } });
    await browser.waitUntil(async () => (await snapshot()).media.find(item => item.id === mediaId).lastPositionMs >= 4900);
    await browser.reloadSession(); await ready(); await navigate(`/study/${mediaId}`); await playerReady();
    const state = await invoke('get_player_state');
    assert(state.paused && state.positionMs >= 4900 && state.positionMs <= 5300, `Wrong resume position: ${state.positionMs}`);
    assert.equal(state.tracks.find(track => track.kind === 'audio' && track.selected).ffIndex, 2);
    await browser.saveScreenshot(resolve('test-results/native/media-resume-tracks.png'));
  });
  it('chooses embedded subtitles explicitly and restores an edited previous version', async function () {
    this.timeout(300000);
    await openSubtitles();
    await chooseSubtitle('3');
    await $('button=Use these subtitles').click();
    await browser.waitUntil(async () => (await invoke('list_segments', { mediaId })).some(cue => cue.text.includes('日本語')), { timeout: 60000 });
    await dialogClosed();
    const original = (await invoke('list_segments', { mediaId }))[0];
    await invoke('edit_segment', { segment: { ...original, text: '日本語の字幕を編集しました。' } });
    await assert.rejects(invoke('extract_embedded_subtitles', { mediaId, streamIndex: 1, replaceExisting: false }), /Confirm replacement/);
    await browser.refresh(); await ready(); await openSubtitles();
    await chooseSubtitle('1');
    await expect($('button=Use these subtitles')).toBeDisabled();
    await $('dialog input[type="checkbox"]').click(); await $('button=Use these subtitles').click();
    await browser.waitUntil(async () => (await invoke('list_segments', { mediaId }))[0]?.text === 'English track one.', { timeout: 60000 });
    await dialogClosed();
    const versions = await invoke('list_subtitle_versions', { mediaId }); assert.equal(versions.length, 1);
    assert.equal(versions[0].streamIndex, 3); assert.equal(versions[0].segments[0].text, '日本語の字幕を編集しました。');
    await $('button=Versions').click(); await chooseSubtitle(versions[0].id);
    await $('dialog input[type="checkbox"]').click(); await $('button=Use these subtitles').click();
    await browser.waitUntil(async () => (await invoke('list_segments', { mediaId }))[0]?.text === '日本語の字幕を編集しました。', { timeout: 60000 });
    await dialogClosed();
    assert.equal((await snapshot()).media.find(item => item.id === mediaId).subtitleStreamIndex, 3);
  });
  it('edits and suspends a real saved card without changing its audio or review schedule', async () => {
    const sourceCues = await invoke('list_segments', { mediaId });
    const segment = sourceCues[0];
    const before = await snapshot();
    await invoke('save_card', { request: { mediaId, segmentId: segment.id, sourceCueIds: sourceCues.map(cue => cue.id), term: 'managed phrase', meaning: 'Original meaning', example: sourceCues.map(cue => cue.text).join('\n') } });
    const saved = (await snapshot()).cards.find(item => !before.cards.some(old => old.id === item.id)); assert(saved); cardId = saved.id;
    assert.equal(saved.audioStreamIndex, 2); savedAudioPath = saved.audioPath; savedAudioHash = hash(savedAudioPath);
    assert.equal(saved.sourceCues.length, 2); assert.equal(saved.startMs, 500); assert.equal(saved.endMs, 4500);
    const bytes = readFileSync(savedAudioPath), offset = bytes.indexOf(Buffer.from('data')) + 8;
    let crossings = 0; for (let i = offset + 2; i + 1 < bytes.length; i += 2) if (bytes.readInt16LE(i - 2) < 0 && bytes.readInt16LE(i) >= 0) crossings++;
    assert(crossings >= 1745 && crossings <= 1770, `Wrong audio track or incomplete source range in saved clip: ${crossings} crossings`);
    await invoke('rate_card', { cardId, rating: 'good' }); const rated = (await snapshot()).cards.find(item => item.id === cardId);
    await browser.refresh(); await ready(); const article = await cardArticle();
    await article.$('[aria-label="Listen to source audio"]').click();
    await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.ready && !state.paused && state.positionMs > 100; });
    await article.$('button=Edit').click();
    await $('dialog textarea').setValue('Corrected meaning'); await $('dialog').$('button=Save').click();
    await dialogClosed();
    await browser.waitUntil(async () => (await snapshot()).cards.find(item => item.id === cardId).meaning === 'Corrected meaning');
    await (await cardArticle()).$('button=Suspend reviews').click();
    await browser.waitUntil(async () => (await snapshot()).cards.find(item => item.id === cardId).suspended === true);
    const changed = (await snapshot()).cards.find(item => item.id === cardId);
    assert.equal(changed.dueAt, rated.dueAt); assert.equal(changed.reviewCount, rated.reviewCount); assert.equal(hash(savedAudioPath), savedAudioHash);
  });
  it('removes the library item while retaining originals and saved cards, then deletes only the chosen card', async () => {
    await navigate(`/study/${mediaId}`); await $('button=Remove from library').click();
    await $('dialog').$('button=Remove from library').click();
    await dialogClosed();
    await browser.waitUntil(async () => !(await snapshot()).media.some(item => item.id === mediaId));
    assert(existsSync(source)); assert.equal(hash(savedAudioPath), savedAudioHash); assert((await snapshot()).cards.some(item => item.id === cardId));
    await (await cardArticle()).$('button=Delete').click(); await $('dialog').$('button=Delete phrase').click();
    await dialogClosed();
    await browser.waitUntil(async () => !(await snapshot()).cards.some(item => item.id === cardId));
    assert(existsSync(source));
  });
  it('imports a local HTTP fixture through the UI, cancels a slow download and explicitly retries a failed one', async () => {
    const body = readFileSync(savedAudioPath); let retries = 0;
    server = createServer((request, response) => {
      if (request.url === '/slow.wav') {
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': 128 * 1024 * 1024 });
        const interval = setInterval(() => response.write(Buffer.alloc(64 * 1024)), 50); response.on('close', () => clearInterval(interval));
      } else if (request.url === '/retry.wav' && retries++ === 0) {
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length + 1000 }); response.end(body);
      } else { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length }); response.end(body); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); serverUrl = `http://127.0.0.1:${server.address().port}`;
    await navigate('/'); await $('button=Add content').click(); await $('dialog').$('button=URL').click(); await $('dialog input[type="url"]').setValue(`${serverUrl}/success.wav`); await $('dialog').$('button=Add to library').click();
    await browser.waitUntil(async () => (await invoke('list_download_jobs')).some(job => job.request.pathOrUrl.endsWith('/success.wav') && job.status === 'completed'));
    await dialogClosed();
    const completed = (await invoke('list_download_jobs')).find(job => job.request.pathOrUrl.endsWith('/success.wav'));
    await $(`a.media-card[href="/study/${completed.mediaId}"]`).waitForDisplayed();
    const request = { kind: 'url', learningLanguage: 'en', explanationLanguage: 'ja', pathOrUrl: `${serverUrl}/slow.wav` };
    const slow = await invoke('start_url_import', { request }); await browser.waitUntil(async () => (await invoke('list_download_jobs')).find(job => job.id === slow).storedBytes > 0);
    await $(`[data-download-id="${slow}"]`).$('button=Cancel download').click(); await browser.waitUntil(async () => (await invoke('list_download_jobs')).find(job => job.id === slow).status === 'cancelled');
    const failed = await invoke('start_url_import', { request: { ...request, pathOrUrl: `${serverUrl}/retry.wav` } });
    await browser.waitUntil(async () => (await invoke('list_download_jobs')).find(job => job.id === failed).status === 'failed');
    const article = await $(`[data-download-id="${failed}"]`); await article.$('button=Retry from start').click();
    await browser.waitUntil(async () => (await invoke('list_download_jobs')).some(job => job.id !== failed && job.request.pathOrUrl.endsWith('/retry.wav') && job.status === 'completed'));
    const final = await snapshot(); assert.equal(final.budget.spentUsd, 0); assert.equal(final.budget.reservedUsd, 0); assert.equal(final.settings.credentialConfigured, false);
    assert(!readdirSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'media')).some(name => name.startsWith('.download-')), 'Cancelled or failed downloads retained partial files');
    await browser.saveScreenshot(resolve('test-results/native/background-downloads.png'));
  });
  (process.env.SURTITLE_E2E_AV1_FIXTURE ? it : it.skip)('decodes, plays and seeks the optional CPU AV1 candidate fixture', async () => {
    const path = process.env.SURTITLE_E2E_AV1_FIXTURE;
    assert(existsSync(path), 'The selected AV1 fixture must exist');
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
    await browser.saveScreenshot(resolve('test-results/native/candidate-av1.png'));
  });
});
