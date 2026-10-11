// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const snapshot = () => invoke('get_app_snapshot');
const player = () => invoke('get_player_state');
const control = request => invoke('player_control', { request });
const navigate = path => browser.execute(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function processId() {
  // Inspect only the explicitly selected executable. A different PID proves that
  // reloadSession restarted the native application, not merely its web document.
  const script = '$expected=$env:SURTITLE_E2E_BINARY; ConvertTo-Json -Compress -InputObject @(Get-Process -Name surtitle -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -ExpandProperty Id)';
  const ids = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }));
  assert.equal(ids.length, 1, 'Expected exactly one owned application process');
  return ids[0];
}
async function ready() {
  await browser.setTimeout({ script: 180000 });
  await browser.waitUntil(() => browser.execute(() => !!window.__TAURI_INTERNALS__));
  await $('h1').waitForDisplayed();
}
async function replaceValue(element, value) {
  // EdgeDriver clear() bypasses React's input event and can append to stale state.
  await element.click(); await browser.keys([Key.Control, 'a']); await browser.keys(Key.Backspace);
  if (value) await element.addValue(value);
  await expect(element).toHaveValue(value);
}
async function openCard(term) {
  await navigate('/cards');
  const search = $('[aria-label="Search your phrases"]');
  await search.waitForEnabled(); await replaceValue(search, term);
  const edit = $('[aria-label="Edit phrase"]');
  await edit.waitForClickable(); await edit.click();
  await $('[role="dialog"] input').waitForEnabled();
}
const immutable = card => Object.fromEntries(['id', 'mediaId', 'segmentId', 'language', 'dueAt', 'createdAt', 'reviewCount', 'audioPath', 'audioClipRange', 'audioStreamIndex', 'suspended'].map(key => [key, card[key]]));

(process.platform === 'win32' ? describe : describe.skip)('installed learning data continuity', () => {
  it('keeps real source audio, autosaved edits and unfinished input across an application process restart', async () => {
    await ready();
    const initial = await snapshot();
    assert.equal(initial.settings.credentialConfigured, false);
    assert.equal(initial.budget.spentUsd, 0); assert.equal(initial.budget.reservedUsd, 0);
    assert(initial.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    const originalSettings = initial.settings;
    let saved;
    try {
      await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false } });
      await browser.refresh(); await ready();
      const ffmpeg = (await invoke('scan_external_tools')).find(tool => tool.toolId === 'ffmpeg' && tool.selectable);
      assert(ffmpeg, 'A real available FFmpeg pair is required for source-audio continuity');
      await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: ffmpeg.path } });
      await navigate(`/study/${fixture.mediaId}`);
      await $('.play-button').waitForEnabled(); await browser.waitUntil(async () => (await player()).ready);
      await control({ action: 'pause' }); await control({ action: 'seek', value: 200 });
      await $('button[aria-label="Explore meaning"]').waitForEnabled(); await $('button[aria-label="Explore meaning"]').click();
      await $('.phrase-save-toggle').click();
      const term = `Continuity ${Date.now()}`;
      await replaceValue($('.save-phrase-form input'), term);
      await replaceValue($('.save-phrase-form textarea'), 'Original meaning');
      await $('.save-phrase-form').$('button=Save phrase').click();
      await browser.waitUntil(async () => (await snapshot()).cards.some(card => card.term === term), { timeout: 180000 });
      saved = (await snapshot()).cards.find(card => card.term === term);
      assert(saved.audioPath && existsSync(saved.audioPath));
      const audioHash = hash(saved.audioPath);
      const originalImmutable = immutable(saved);
      // Two real native writers with the same revision must not silently lose data.
      const editState = await invoke('get_card_edit_state', { cardId: saved.id });
      const request = Object.fromEntries(['id', 'term', 'meaning', 'example', 'translation', 'explanation'].map(key => [key, editState.card[key]]));
      const committed = await invoke('save_card_edit', { request: { ...request, meaning: 'Committed by first writer' }, expectedRevision: editState.revision });
      assert.notEqual(committed.revision, editState.revision);
      const staleResult = await browser.execute(async (request, expectedRevision) => {
        try { await window.__TAURI_INTERNALS__.invoke('save_card_edit', { request, expectedRevision }); return { rejected: false }; }
        // A top-level `error` property is treated as a WebDriver error envelope.
        catch (error) { return { rejected: true, reason: String(error) }; }
      }, { ...request, meaning: 'Stale writer must not win' }, editState.revision);
      assert(staleResult.rejected, 'A stale native writer unexpectedly overwrote the card');
      assert.match(staleResult.reason, /Card changed; reload before saving/);
      assert.equal((await snapshot()).cards.find(card => card.id === saved.id).meaning, 'Committed by first writer');
      await openCard(term);
      await replaceValue($('[role="dialog"] textarea'), '自動保存された意味');
      // Close immediately, before waiting for debounce/autosave completion.
      await browser.keys(Key.Escape);
      await expect($('[role="dialog"]')).not.toExist();
      await browser.waitUntil(async () => (await snapshot()).cards.find(card => card.id === saved.id)?.meaning === '自動保存された意味');
      await openCard(term);
      await replaceValue($('[role="dialog"] input'), '');
      await replaceValue($('[role="dialog"] textarea'), '再起動後に続ける入力');
      await browser.keys(Key.Escape);
      await expect($('[role="dialog"]')).not.toExist();
      // Closing explicitly checkpoints invalid input; it does not overwrite the saved card.
      await browser.waitUntil(async () => (await invoke('list_ui_drafts')).some(draft => draft.entityId === saved.id && draft.fields.term === '' && draft.fields.meaning === '再起動後に続ける入力'));
      const beforePid = processId();
      await browser.reloadSession(); await ready();
      const afterPid = processId();
      assert.notEqual(afterPid, beforePid, 'The native application process did not restart');
      const persisted = (await snapshot()).cards.find(card => card.id === saved.id);
      assert.equal(persisted.meaning, '自動保存された意味');
      assert.deepEqual(immutable(persisted), originalImmutable);
      assert.equal(hash(persisted.audioPath), audioHash);
      await openCard(term);
      await expect($('[role="dialog"] input')).toHaveValue('');
      await expect($('[role="dialog"] textarea')).toHaveValue('再起動後に続ける入力');
      assert.equal((await $$('[role="dialog"]')).length, 1);
      await replaceValue($('[role="dialog"] input'), term);
      await browser.keys(Key.Escape);
      await browser.waitUntil(async () => (await snapshot()).cards.find(card => card.id === saved.id)?.meaning === '再起動後に続ける入力');
      await navigate(`/study/${fixture.mediaId}`);
      await $('.play-button').waitForEnabled(); await browser.waitUntil(async () => (await player()).ready);
      await control({ action: 'seek', value: 200 }); await control({ action: 'play' });
      await browser.waitUntil(async () => { const state = await player(); return state.surfaceVisible && !state.paused && state.positionMs > 800; });
      await control({ action: 'pause' });
      const final = await snapshot();
      assert.equal(final.budget.spentUsd, 0); assert.equal(final.budget.reservedUsd, 0);
      assert.deepEqual(final.jobs, initial.jobs);
      writeFileSync(resolve('test-results/native/learning-continuity.json'), JSON.stringify({
        passed: true, testedAt: new Date().toISOString(), beforePid, afterPid,
        sourceAudioHash: audioHash, savedCardId: saved.id, unicodeTextPreserved: true,
        closedImmediatelyAfterEditing: true, staleNativeWriterRejected: true,
        realOsImeCompositionTested: false, paidRequests: 0,
      }, null, 2) + '\n');
    } finally {
      if (saved) await invoke('delete_card', { cardId: saved.id });
      await invoke('update_settings', { settings: originalSettings });
    }
  });
});
