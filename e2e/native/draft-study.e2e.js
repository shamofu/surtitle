// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// These authored subtitles accompany digital silence. This suite verifies local
// transport and persistence, not audible speech, transcript quality or listening.
// It never adopts/resolves the shared source jobs or opens an OS file dialog.
const mediaId = 'e2e-transcript-review';
const pendingMediaId = 'e2e-transcript-pending';
const term = 'Draft study transport fixture';
const invoke = async (command, args = {}) => {
  const result = await browser.execute(async (name, parameters) => {
    try { return { succeeded: true, payload: await window.__TAURI_INTERNALS__.invoke(name, parameters) }; }
    catch (error) { return { succeeded: false, reason: String(error?.message ?? error).slice(0, 2000) }; }
  }, command, args);
  if (!result.succeeded) throw new Error(`IPC ${command}: ${result.reason}`);
  return result.payload;
};
const snapshot = () => invoke('get_app_snapshot');
const review = jobId => invoke('get_transcript_review', { jobId });
const list = (id = mediaId) => invoke('list_draft_selections', { mediaId: id });
const segments = id => invoke('list_segments', { mediaId: id });
const panel = () => $('[aria-label="Study from drafts"]');
const editor = () => $('[aria-label="Check selected phrase"]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let jobId, pendingJobId, selected, pendingSelection, card, ratedCard, audioHash;
let originalSettings, originalFfmpeg, originalLedger, originalResponses, originalViews, originalSegments;
let originalBinding, confirmedVersion;
const ownedSelections = new Map();
const ownedCards = new Set();

function readDatabase(file, action) {
  const db = new DatabaseSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, file), { readOnly: true });
  try { return action(db); } finally { db.close(); }
}
function accounting() {
  return readDatabase('charges.sqlite', db => ({
    attempts: db.prepare('SELECT * FROM ai_attempts ORDER BY id').all(),
    jobs: db.prepare('SELECT id,digest,state,approved_at_ms,approval_json FROM ai_jobs ORDER BY id').all(),
    limits: db.prepare('SELECT limits_json FROM ai_settings WHERE id=1').get().limits_json,
  }));
}
function responseHashes() {
  return readDatabase('charges.sqlite', db => ({
    responses: db.prepare('SELECT job_id,ordinal,state,response_json,error_code FROM ai_requests ORDER BY job_id,ordinal').all()
      .map(row => ({ jobId: row.job_id, ordinal: row.ordinal, hash: hash(JSON.stringify(row)) })),
    evidence: db.prepare('SELECT attempt_id,evidence_json,evidence_sha256 FROM ai_transcript_evidence ORDER BY attempt_id').all()
      .map(row => ({ attemptId: row.attempt_id, hash: hash(JSON.stringify(row)) })),
  }));
}
function storedSelection(id) {
  return readDatabase('learning.sqlite', db => JSON.parse(db.prepare('SELECT data FROM draft_study_selections WHERE id=?').get(id).data));
}
function remember(selection) { ownedSelections.set(selection.id, selection.mediaId); return selection; }
function update(selection, changes) {
  return invoke('update_draft_selection', { request: { id: selection.id, version: selection.version,
    text: selection.text, startMs: selection.startMs, endMs: selection.endMs, confirm: false, ...changes } });
}
async function ready() {
  await browser.setTimeout({ script: 180000 });
  await browser.waitUntil(() => browser.execute(() => !!window.__TAURI_INTERNALS__));
  await $('h1').waitForDisplayed();
}
async function dismissSuccessToasts() {
  // Success messages are dismissible UI buttons. Leave error messages visible
  // so a failed operation cannot be hidden by the navigation helper.
  for (let remaining = 10; remaining > 0; remaining--) {
    const toast = $('button.toast.success');
    if (!(await toast.isExisting())) return;
    await toast.waitForClickable();
    await toast.click();
    await toast.waitForExist({ reverse: true });
  }
  assert.fail('Unexpected continuous success notifications');
}
async function scrollVisible(element) {
  await element.waitForExist();
  // WDIO 9 uses a wheel event at viewport (0,0), which cannot scroll this nested
  // panel in WebKit. Use the DOM scroll API; clicks still go through WebDriver.
  await browser.execute(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), await element);
}
async function clickVisible(element) {
  await dismissSuccessToasts();
  await scrollVisible(element);
  await element.waitForClickable();
  await element.click();
}
async function openDraft(id = mediaId) {
  await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${id}`);
  await $('button=Study a draft').waitForDisplayed();
  await clickVisible($('button=Study a draft'));
  await panel().waitForDisplayed();
  await panel().$('select').waitForDisplayed();
  await scrollVisible(panel().$('select'));
  await panel().$('select').selectByAttribute('value', id === pendingMediaId ? pendingJobId : jobId);
}
async function openBookmark(selection) {
  await openDraft(selection.mediaId);
  const bookmarks = panel().$('.draft-study-bookmark-list');
  await bookmarks.waitForExist();
  await scrollVisible(bookmarks);
  let bookmark;
  await browser.waitUntil(async () => {
    for (const button of await bookmarks.$$('button')) {
      // Match source text without WebKit's clipped/-webkit-line-clamp rendering
      // rules; the editor's displayed textarea is checked after a normal click.
      if ((await button.$('span').getProperty('textContent')) === selection.text) { bookmark = button; return true; }
    }
    return false;
  }, { timeoutMsg: 'The persisted draft bookmark was not shown' });
  await clickVisible(bookmark);
  await editor().waitForDisplayed();
}
async function assertOriginals() {
  assert.deepEqual(accounting(), originalLedger, 'Local study changed the approval or charge ledger');
  assert.deepEqual(responseHashes(), originalResponses, 'Local study changed saved provider results');
  for (const [id, original] of originalViews) {
    const current = await review(id);
    assert.equal(current.applied, original.applied);
    assert.deepEqual(current.draft, original.draft);
  }
  for (const [id, original] of originalSegments) assert.deepEqual(await segments(id), original);
  const state = await snapshot();
  assert.equal(state.settings.credentialConfigured, false);
  assert.equal(state.budget.spentUsd, 0); assert.equal(state.budget.reservedUsd, 0); assert.equal(state.budget.limitUsd, 0);
}
function assertPcm(path, expectedMilliseconds) {
  const root = resolve(process.env.SURTITLE_E2E_DATA_DIR, 'card-audio');
  const owned = relative(root, resolve(path));
  assert(isAbsolute(path) && owned && !owned.startsWith('..') && !isAbsolute(owned));
  const bytes = readFileSync(path);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let format, pcmBytes;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    assert(start + size <= bytes.length, 'Card WAV is truncated');
    if (id === 'fmt ') format = bytes.subarray(start, start + size);
    if (id === 'data') pcmBytes = size;
    offset = start + size + size % 2;
  }
  assert(format && pcmBytes > 0);
  assert.equal(format.readUInt16LE(0), 1); assert.equal(format.readUInt16LE(2), 1);
  assert.equal(format.readUInt32LE(4), 16000); assert.equal(format.readUInt16LE(14), 16);
  assert.equal(pcmBytes / 2, expectedMilliseconds * 16);
  return hash(bytes);
}

(process.env.SURTITLE_E2E_TRANSCRIPT_REVIEW === 'boundary' ? describe : describe.skip)('study a useful draft without adopting its full transcript', () => {
  before(async () => {
    await ready();
    const state = await snapshot();
    originalSettings = state.settings; originalFfmpeg = state.tools.find(tool => tool.id === 'ffmpeg');
    assert(!state.cards.some(item => item.term === term), 'Use a fresh disposable draft-study profile');
    await invoke('update_settings', { settings: { ...state.settings, locale: 'en', dailyBudgetUsd: 0, replayContextMs: 150, sentencePause: false } });
    await browser.refresh(); await ready();
    const preparation = id => invoke('list_transcription_preparations', { mediaId: id });
    jobId = (await preparation(mediaId)).find(item => !item.repairParentJobId)?.jobId;
    pendingJobId = (await preparation(pendingMediaId)).find(item => !item.repairParentJobId)?.jobId;
    assert(jobId && pendingJobId && jobId !== pendingJobId);
    originalViews = [[jobId, await review(jobId)], [pendingJobId, await review(pendingJobId)]];
    originalSegments = [[mediaId, await segments(mediaId)], [pendingMediaId, await segments(pendingMediaId)]];
    originalLedger = accounting(); originalResponses = responseHashes();
    assert(originalResponses.responses.filter(row => row.jobId === jobId).length === 2);
    assert.equal(originalViews[0][1].applied, false, 'Run this suite before whole-track adoption');
    assert.equal(originalViews[0][1].draft.conflicts.length, 1);
    assert.equal(originalViews[1][1].draft.pendingRanges.length, 1);
  });

  it('01 shows available draft text while the full result cannot be adopted', async () => {
    assert.equal((await review(jobId)).draft.canAdopt, false);
    assert.equal((await review(pendingJobId)).draft.canAdopt, false);
    await openDraft();
    await panel().$('input[aria-label="Select subtitle: Hello."]').waitForDisplayed();
    assert((await panel().getText()).includes('Some ranges are pending or need review.'));
    await expect(panel().$('button=Keep selected subtitles for later')).toBeDisabled();
    await assertOriginals();
  });

  it('02 keeps an existing cue through the study pane without confirming it', async () => {
    const before = await list();
    await clickVisible(panel().$('input[aria-label="Select subtitle: Hello."]'));
    await clickVisible(panel().$('button=Keep selected subtitles for later'));
    await editor().waitForDisplayed();
    const created = (await list()).filter(item => !before.some(previous => previous.id === item.id));
    assert.equal(created.length, 1); selected = remember(created[0]);
    assert.equal(selected.text, 'Hello.'); assert.equal(selected.confirmed, false);
    assert.equal(selected.version, 1); assert.equal(selected.origin, 'ai'); assert.equal(selected.timing, 'cue');
    assert.equal(selected.stale, false); assert.equal(selected.canConfirm, true);
    assert.equal(selected.sourceStartMs, 500); assert.equal(selected.sourceEndMs, 1000);
    assert(!Object.hasOwn(selected, 'sourceSnapshot'), 'Opaque source binding must stay native');
    originalBinding = storedSelection(selected.id).sourceSnapshot;
    assert(originalBinding && typeof originalBinding === 'object');
    await expect(editor().$('button=Confirm this text and audio')).toBeDisabled();
    await expect(editor().$('button=Create an audio card')).toBeDisabled();
  });

  it('03 rejects unconfirmed cards and edits outside the original source interval', async () => {
    const before = storedSelection(selected.id);
    await assert.rejects(invoke('save_draft_selection_card', { request: { selectionId: selected.id, version: selected.version, term, meaning: 'Must not be saved.' } }), /confirmed|Confirm/i);
    await assert.rejects(update(selected, { startMs: selected.sourceStartMs - 1 }));
    await assert.rejects(update(selected, { endMs: selected.sourceEndMs + 1 }));
    await assert.rejects(update(selected, { text: '', confirm: true }));
    assert.deepEqual(storedSelection(selected.id), before);
    assert(!(await snapshot()).cards.some(item => item.term === term));
    await assertOriginals();
  });

  it('04 persists an unchecked local edit and rejects its superseded version after restart', async () => {
    const old = selected;
    selected = await update(selected, { text: 'Hello, local learner.' });
    assert.equal(selected.version, old.version + 1);
    assert.equal(selected.confirmed, false); assert.equal(selected.origin, 'manual'); assert.equal(selected.timing, 'manual');
    await assert.rejects(update(old, { text: 'Stale overwrite.' }), /changed|version|reopen/i);
    assert.deepEqual(storedSelection(selected.id).sourceSnapshot, originalBinding);
    await browser.reloadSession(); await ready();
    assert.deepEqual((await list()).find(item => item.id === selected.id), selected);
    await openBookmark(selected);
    assert.equal(await editor().$('textarea').getValue(), selected.text);
    await expect(editor().$('button=Create an audio card')).toBeDisabled();
  });

  it('05 explicitly confirms only the authored excerpt and leaves original warnings unresolved', async () => {
    // Fixed-fixture IPC confirmation is an automated state transition. It is not
    // evidence that a person listened to or verified these synthetic words.
    selected = await update(selected, { confirm: true }); confirmedVersion = selected.version;
    assert.equal(selected.confirmed, true); assert.equal(selected.canConfirm, true);
    assert.deepEqual(storedSelection(selected.id).sourceSnapshot, originalBinding);
    assert.deepEqual(await invoke('list_draft_selection_candidates', { request: { id: selected.id, version: selected.version } }), []);
    await browser.reloadSession(); await ready(); await openBookmark(selected);
    await expect(editor().$('button=Create an audio card')).toBeEnabled();
    assert((await editor().getText()).includes('This check covers only your excerpt.'));
    await assertOriginals();
  });

  it('06 saves a manual card through the UI with exact audio from selected PATH FFmpeg', async () => {
    const external = (await invoke('scan_external_tools')).find(tool => tool.toolId === 'ffmpeg' && tool.selectable);
    assert(external, 'The native fixture requires an existing FFmpeg/ffprobe pair on PATH');
    await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: external.path } });
    const before = await snapshot();
    await clickVisible(editor().$('button=Create an audio card'));
    const dialog = () => $('dialog');
    await dialog().$('h2=Keep this phrase').waitForDisplayed();
    await scrollVisible(dialog().$('input'));
    await dialog().$('input').setValue(term);
    const textareas = await dialog().$$('textarea');
    await scrollVisible(textareas[0]);
    await textareas[0].setValue('An authored local transport example; no AI explanation.');
    await clickVisible(dialog().$('button=Save card and audio'));
    await dialog().waitForExist({ reverse: true, timeout: 180000 });
    const added = (await snapshot()).cards.filter(item => !before.cards.some(previous => previous.id === item.id));
    for (const item of added) ownedCards.add(item.id);
    assert.equal(added.length, 1); card = added[0];
    assert.equal(card.term, term); assert.equal(card.example, selected.text);
    assert.equal(card.segmentId, `draft:${selected.id}:${confirmedVersion}`);
    assert.equal(card.sourceCues.length, 1); assert.equal(card.sourceCues[0].text, selected.text);
    assert.equal(card.sourceCues[0].status, 'confirmed'); assert.equal(card.audioStreamIndex, 0);
    assert.equal(card.startMs, selected.startMs); assert.equal(card.endMs, selected.endMs);
    assert.deepEqual(card.audioClipRange, { startMs: 350, endMs: 1150 });
    assert(!card.explanation); assert(card.audioPath);
    audioHash = assertPcm(card.audioPath, 800);
    assert.equal((await snapshot()).tools.find(tool => tool.id === 'ffmpeg').provider, 'external');
    await assertOriginals();
  });

  it('07 keeps the saved card immutable when its bookmark changes and refuses stale card requests', async () => {
    selected = await update(selected, { text: 'A later local edit.', startMs: 600, endMs: 900 });
    assert.equal(selected.confirmed, false);
    await assert.rejects(invoke('save_draft_selection_card', { request: { selectionId: selected.id, version: confirmedVersion, term: `${term} stale`, meaning: 'Must not be saved.' } }), /changed|version|reopen/i);
    assert.deepEqual((await snapshot()).cards.find(item => item.id === card.id), card);
    assert.equal(hash(readFileSync(card.audioPath)), audioHash);
    assert.deepEqual(storedSelection(selected.id).sourceSnapshot, originalBinding);
    await assertOriginals();
  });

  it('08 schedules and retains a local review without creating any paid request', async () => {
    await invoke('rate_card', { cardId: card.id, rating: 'good' });
    ratedCard = (await snapshot()).cards.find(item => item.id === card.id);
    assert.equal(ratedCard.reviewCount, card.reviewCount + 1);
    assert(Date.parse(ratedCard.dueAt) > Date.parse(card.dueAt));
    const reviews = readDatabase('learning.sqlite', db => db.prepare('SELECT data FROM reviews WHERE card_id=? ORDER BY id').all(card.id));
    assert.equal(reviews.length, 1);
    await browser.reloadSession(); await ready();
    assert.deepEqual((await snapshot()).cards.find(item => item.id === card.id), ratedCard);
    assert.deepEqual((await list()).find(item => item.id === selected.id), selected);
    assert.deepEqual(readDatabase('learning.sqlite', db => db.prepare('SELECT data FROM reviews WHERE card_id=? ORDER BY id').all(card.id)), reviews);
    assert.equal(hash(readFileSync(card.audioPath)), audioHash);
    await assertOriginals();
  });

  it('09 retains a pending source block as an unchecked bookmark without inventing timed text', async () => {
    pendingSelection = remember(await invoke('prepare_draft_selection', { request: { jobId: pendingJobId, ordinal: 1 } }));
    assert.equal(pendingSelection.timing, 'source_block'); assert.equal(pendingSelection.confirmed, false);
    assert.equal(pendingSelection.text, ''); assert.deepEqual(pendingSelection.cueIds, []);
    const chunk = (await review(pendingJobId)).draft.chunks.find(item => item.ordinal === 1);
    assert.equal(pendingSelection.sourceStartMs, chunk.requestStartMs);
    assert.equal(pendingSelection.sourceEndMs, chunk.requestEndMs);
    assert.equal(chunk.status, 'pending');
    pendingSelection = await update(pendingSelection, { text: 'An unchecked source-block note.', startMs: 7200, endMs: 7600 });
    assert.equal(pendingSelection.confirmed, false); assert.equal(pendingSelection.timing, 'manual');
    await browser.reloadSession(); await ready();
    assert.deepEqual((await list(pendingMediaId)).find(item => item.id === pendingSelection.id), pendingSelection);
    await assertOriginals();
  });

  it('10 keeps card audio usable after removing its source bookmark and preserves the original responses', async () => {
    await assert.rejects(invoke('remove_draft_selection', { request: { id: selected.id, version: confirmedVersion } }), /changed|version|reopen/i);
    await invoke('remove_draft_selection', { request: { id: selected.id, version: selected.version } });
    ownedSelections.delete(selected.id);
    assert(!(await list()).some(item => item.id === selected.id));
    assert.deepEqual((await snapshot()).cards.find(item => item.id === card.id), ratedCard);
    assert.equal(hash(readFileSync(card.audioPath)), audioHash);
    if (process.platform === 'win32') {
      // Real libmpv/null-audio transport on Windows; no claim about audible speech.
      await invoke('play_card_audio', { cardId: card.id });
      await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.ready && !state.error && !state.paused && Math.abs(state.durationMs - 800) <= 5 && state.positionMs >= 20; }, { timeout: 5000, interval: 30 });
      await invoke('player_control', { request: { action: 'pause' } });
    }
    await assertOriginals();
    await openDraft();
    await browser.saveScreenshot(resolve('test-results/native/draft-study-local-chain.png'));
    console.info('Draft study: 10 fixed transport tasks; no human listening or cloud quality assessment. Portable bookmark detachment is covered by core archive tests; native ZIP/restore remains in the separate transcript suite.');
  });

  after(async () => {
    // Only remove rows this suite created. Original media, provider responses,
    // fixture ZIPs, tool installations and source audio remain untouched.
    await ready();
    for (const [id, owner] of ownedSelections) {
      const current = (await list(owner)).find(item => item.id === id);
      if (current) await invoke('remove_draft_selection', { request: { id, version: current.version } });
    }
    for (const id of ownedCards) await invoke('delete_card', { cardId: id });
    if (originalFfmpeg) await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: originalFfmpeg.provider, ...(originalFfmpeg.provider === 'external' ? { path: originalFfmpeg.path } : {}) } });
    if (originalSettings) await invoke('update_settings', { settings: originalSettings });
    if (originalLedger) await assertOriginals();
  });
});
