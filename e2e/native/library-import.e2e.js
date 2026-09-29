// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDirectory = resolve(process.env.SURTITLE_E2E_DATA_DIR);
const fixture = JSON.parse(readFileSync(join(dataDirectory, 'fixture.json'), 'utf8'));
const invoke = (command, args = {}) => browser.execute(
  async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args,
);
const snapshot = () => invoke('get_app_snapshot');
const player = () => invoke('get_player_state');
const control = request => invoke('player_control', { request });
const navigate = path => browser.execute(next => {
  history.pushState({}, '', next);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);
const localRequest = path => ({
  kind: 'local', pathOrUrl: path, learningLanguage: 'en', explanationLanguage: 'ja',
});

// This drives the installed Tauri JS event bridge with synthetic payloads. It
// exercises the real listener registration and Rust validation/import commands,
// but intentionally does not claim coverage of Explorer's Windows OLE drag.
async function syntheticTauriDrag(event, payload) {
  return browser.execute((name, body) => {
    const listeners = window.__internal_unstable_listeners_object_id__?.[name];
    const dispatch = window.__internal_unstable_listeners_function_id__;
    const ids = listeners ? Object.getOwnPropertyNames(listeners)
      .filter(id => /^\d+$/.test(id)).map(Number) : [];
    if (!ids.length || typeof dispatch !== 'function') {
      throw new Error(`No registered Tauri listener for ${name}`);
    }
    dispatch({ event: name, payload: body }, ids);
    return ids.length;
  }, event, payload);
}

(process.platform === 'win32' ? describe : describe.skip)('native library import and synthetic Tauri drag delivery', () => {
  let originalSettings, temporaryDirectory, apiFile, droppedFile, invalidFile, apiCanonical;
  const createdMediaIds = new Set();

  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    originalSettings = (await snapshot()).settings;
    await invoke('update_settings', {
      settings: { ...originalSettings, locale: 'en', sentencePause: false, replayContextMs: 0 },
    });
    // The runner and native app share the restricted-medium account. Keep these
    // generated, disposable files inside that runner's owned data directory.
    temporaryDirectory = mkdtempSync(join(dataDirectory, 'library-import-'));
    apiFile = join(temporaryDirectory, 'API 日本語 & video.MP4');
    droppedFile = join(temporaryDirectory, 'Drop 日本語 & video.mp4');
    invalidFile = join(temporaryDirectory, 'not-media.txt');
    copyFileSync(fixture.mediaPath, apiFile);
    copyFileSync(fixture.mediaPath, droppedFile);
    writeFileSync(invalidFile, 'This is not a media file.');
    await browser.refresh();
    await navigate('/');
    await $('.library-page').waitForDisplayed();
  });

  after(async () => {
    await control({ action: 'pause' });
    await control({ action: 'rate', value: 1 });
    // Include an item added through the UI even if an assertion failed before
    // its ID could be recorded. Match only this run's two owned source paths.
    const current = await snapshot();
    for (const media of current.media) {
      if (media.path.includes(temporaryDirectory) || createdMediaIds.has(media.id)) {
        await invoke('remove_media', { mediaId: media.id });
      }
    }
    if (originalSettings) await invoke('update_settings', { settings: originalSettings });
  });

  it('validates each real file and returns one stable media ID for equivalent local imports', async () => {
    const folder = join(temporaryDirectory, 'folder.mp4');
    const empty = join(temporaryDirectory, 'empty.wav');
    const missing = join(temporaryDirectory, 'missing.mp4');
    mkdirSync(folder);
    writeFileSync(empty, '');
    const paths = [apiFile, invalidFile, folder, empty, missing, 'relative.mp4'];
    const before = (await snapshot()).media.length;
    const validated = await invoke('validate_media_files', {
      paths, learningLanguage: 'en', explanationLanguage: 'ja',
    });
    assert.deepEqual(validated.map(item => item.inputPath), paths);
    assert.deepEqual(validated.map(item => item.status), ['ready', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    assert.deepEqual(validated.slice(1).map(item => item.reason), ['unsupported', 'directory', 'empty', 'missing', 'invalidPath']);
    apiCanonical = validated[0].canonicalPath;
    assert(apiCanonical && apiCanonical !== 'relative.mp4');
    assert.equal((await snapshot()).media.length, before, 'Validation wrote library data');

    const imported = await invoke('import_local_media', { request: localRequest(apiFile) });
    createdMediaIds.add(imported.mediaId);
    assert.equal(imported.created, true);
    assert(imported.mediaId);
    const duplicate = await invoke('import_local_media', {
      request: { ...localRequest(apiCanonical), learningLanguage: ' EN ', explanationLanguage: ' JA ' },
    });
    assert.deepEqual(duplicate, { mediaId: imported.mediaId, created: false });
    const existing = await invoke('validate_media_files', {
      paths: [apiFile], learningLanguage: 'en', explanationLanguage: 'ja',
    });
    assert.equal(existing[0].status, 'existing');
    assert.equal(existing[0].mediaId, imported.mediaId);
    await invoke('import_media', { request: localRequest(apiFile) });
    assert.equal((await snapshot()).media.length, before + 1, 'Legacy import duplicated existing media');

    const differentLanguage = await invoke('import_local_media', {
      request: { ...localRequest(apiFile), learningLanguage: 'fr' },
    });
    createdMediaIds.add(differentLanguage.mediaId);
    assert.equal(differentLanguage.created, true);
    assert.notEqual(differentLanguage.mediaId, imported.mediaId);
  });

  it('reviews synthetic Tauri drops, deduplicates the queue, and imports only after explicit confirmation', async () => {
    await browser.waitUntil(async () => browser.execute(() =>
      !!window.__internal_unstable_listeners_object_id__?.['tauri://drag-drop']));
    const before = (await snapshot()).media.length;
    const payload = { paths: [droppedFile, invalidFile], position: { x: 400, y: 300 } };
    await syntheticTauriDrag('tauri://drag-enter', payload);
    await $('.library-drop-overlay').waitForDisplayed();
    await syntheticTauriDrag('tauri://drag-leave', null);
    await $('.library-drop-overlay').waitForExist({ reverse: true });
    await syntheticTauriDrag('tauri://drag-drop', payload);
    await $('dialog').waitForDisplayed();
    await browser.waitUntil(async () => (await $$('dialog .import-file-row')).length === 2);
    const add = $('dialog').$('button=Add 1 file to library');
    await add.waitForEnabled();
    assert.equal((await snapshot()).media.length, before, 'Dropping files imported them before confirmation');
    assert.match(await $('dialog .import-file-list').getText(), /Ready to add/);

    await syntheticTauriDrag('tauri://drag-enter', { paths: [droppedFile], position: payload.position });
    await $('dialog .import-drop.is-dragging').waitForDisplayed();
    await syntheticTauriDrag('tauri://drag-drop', { paths: [droppedFile], position: payload.position });
    await browser.waitUntil(async () => (await $('dialog').getText()).includes('1 repeated file skipped.'));
    await add.waitForEnabled();
    assert.equal((await $$('dialog .import-file-row')).length, 2, 'Repeated drop added duplicate queue entries');

    await add.click();
    const open = $('dialog a[aria-label="Open Drop 日本語 & video.mp4"]');
    await open.waitForDisplayed();
    const current = await snapshot();
    const imported = current.media.find(media => media.title === 'Drop 日本語 & video');
    assert(imported, 'Confirmed import is missing from the real native snapshot');
    createdMediaIds.add(imported.id);
    assert.equal(current.media.length, before + 1);
    assert((await open.getAttribute('href')).endsWith(`/study/${imported.id}`));
    assert.equal(await browser.execute(() => location.pathname), '/', 'Import completion unexpectedly navigated to playback');
    await browser.saveScreenshot(resolve('test-results/native/library-import-review.png'));
    await $('dialog').$('button=Return to library').click();
    await $('dialog').waitForExist({ reverse: true });

    await syntheticTauriDrag('tauri://drag-drop', { paths: [droppedFile], position: payload.position });
    await $('dialog').waitForDisplayed();
    await browser.waitUntil(async () => (await $('dialog .import-file-list').getText()).includes('Already in your library with these languages'));
    assert.equal((await snapshot()).media.length, before + 1);
    await $('dialog [aria-label="Close"]').click();
    await $('dialog').waitForExist({ reverse: true });
  });

  it('preserves paused and playing state when the real native player moves between captions', async () => {
    await navigate(`/study/${fixture.mediaId}`);
    await $('.play-button').waitForEnabled();
    await browser.waitUntil(async () => {
      const state = await player();
      return state.ready && state.surfaceVisible && state.videoWidth > 0;
    });
    await control({ action: 'pause' });
    await control({ action: 'sentence-pause', value: 0 });
    await control({ action: 'seek', value: 2200 });
    await browser.waitUntil(async () => (await $('.current-caption-text').getText()).includes('Practice sentence 2.'));
    await $('.current-caption').$('button=Previous subtitle').click();
    await browser.waitUntil(async () => {
      const state = await player();
      return state.paused && state.positionMs >= 990 && state.positionMs < 1150;
    }, { timeoutMsg: 'Previous caption did not seek to 1 second while preserving pause' });
    await $('.current-caption').$('button=Next subtitle').waitForEnabled();
    await $('.current-caption').$('button=Next subtitle').click();
    await browser.waitUntil(async () => {
      const state = await player();
      return state.paused && state.positionMs >= 1990 && state.positionMs < 2150;
    });

    // Slow playback keeps the same active cue during WebDriver round trips.
    await control({ action: 'rate', value: 0.25 });
    await control({ action: 'seek', value: 200 });
    await browser.waitUntil(async () => (await $('.current-caption-text').getText()).includes('Make yourself at home.'));
    await control({ action: 'play' });
    await $('.current-caption').$('button=Next subtitle').click();
    await browser.waitUntil(async () => {
      const state = await player();
      return !state.paused && state.positionMs >= 990 && state.positionMs < 1900;
    }, { timeoutMsg: 'Next caption did not preserve active playback' });
    await control({ action: 'pause' });
    await control({ action: 'rate', value: 1 });
  });
});
