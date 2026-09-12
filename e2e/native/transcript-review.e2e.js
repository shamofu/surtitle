// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const mediaId = 'e2e-transcript-review';
const pendingMediaId = 'e2e-transcript-pending';
const invoke = async (command, args = {}) => {
  const response = await browser.execute(async (name, parameters) => {
    try {
      return { succeeded: true, payload: await window.__TAURI_INTERNALS__.invoke(name, parameters) };
    } catch (error) {
      return { succeeded: false, reason: String(error?.message ?? error).slice(0, 2000) };
    }
  }, command, args);
  if (!response.succeeded) throw new Error(`IPC ${command}: ${response.reason}`);
  return response.payload;
};
const snapshot = () => invoke('get_app_snapshot');
const segments = id => invoke('list_segments', { mediaId: id });
const review = jobId => invoke('get_transcript_review', { jobId });
const preparations = id => invoke('list_transcription_preparations', { mediaId: id });
const dialog = () => $('dialog.modal.wide');
let jobId, pendingJobId, originalDigest, originalConflict, adoptedDigest;
let ledgerBefore;

function withLedger(read) {
  const database = new DatabaseSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'charges.sqlite'), { readOnly: true });
  try { return read(database); } finally { database.close(); }
}
function ledger() {
  return withLedger(database => ({
    attempts: database.prepare('SELECT id,job_id,ordinal,state,reserve_microusd,charged_microusd,usage_json FROM ai_attempts ORDER BY id').all(),
    approvals: database.prepare('SELECT id,approved_at_ms FROM ai_jobs WHERE approved_at_ms IS NOT NULL ORDER BY id').all(),
    limits: database.prepare('SELECT limits_json FROM ai_settings WHERE id=1').get().limits_json,
  }));
}
function storedJob(id) {
  return withLedger(database => {
    const row = database.prepare('SELECT state,approved_at_ms,plan_json FROM ai_jobs WHERE id=?').get(id);
    assert(row, 'Prepared job was not persisted in the real SQLite ledger');
    return { ...row, plan: JSON.parse(row.plan_json) };
  });
}
async function ready() {
  // Reloading the native session resets its script timeout to the driver default.
  await browser.setTimeout({ script: 180000 });
  await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__), { timeoutMsg: 'Native transcript review IPC was not ready' });
  await $('h1').waitForDisplayed();
}
async function openReview(id, targetMediaId = mediaId) {
  await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${targetMediaId}`);
  const button = $(`[data-testid="transcript-review-open"][data-job-id="${id}"]`);
  await button.waitForDisplayed();
  await button.click();
  await dialog().waitForDisplayed();
  await dialog().$('button=Refresh saved results').waitForDisplayed();
  assert.equal(await dialog().$('h2').getText(), 'Review transcription');
}
async function closeReview() {
  await dialog().$('button[aria-label="Close"]').click();
  await expect(dialog()).not.toExist();
}

(process.env.SURTITLE_E2E_TRANSCRIPT_REVIEW === 'boundary' ? describe : describe.skip)('local transcript review and adoption in the real desktop', () => {
  before(async () => {
    await ready();
    const before = await snapshot();
    await invoke('update_settings', { settings: { ...before.settings, locale: 'en', dailyBudgetUsd: 0 } });
    await browser.refresh();
    await ready();
    jobId = (await preparations(mediaId)).find(item => !item.repairParentJobId)?.jobId;
    pendingJobId = (await preparations(pendingMediaId)).find(item => !item.repairParentJobId)?.jobId;
    assert(jobId && pendingJobId && jobId !== pendingJobId, 'Fixed complete and incomplete offline review presets were not seeded');
    const initial = await review(jobId);
    assert.equal(initial.applied, false, 'Use a fresh disposable E2E data directory');
    assert.equal(initial.draft.conflicts.length, 1);
    assert.equal(initial.draft.pendingRanges.length, 0);
    originalDigest = initial.draft.digest;
    originalConflict = initial.draft.conflicts[0];
    ledgerBefore = ledger();
    const fixtureAttempts = ledgerBefore.attempts.filter(attempt => [jobId, pendingJobId].includes(attempt.job_id));
    assert.equal(fixtureAttempts.length, 3);
    assert(fixtureAttempts.every(attempt => attempt.charged_microusd === 0 && JSON.parse(attempt.usage_json).paidRequests === 0));
    assert.equal(ledgerBefore.approvals.length, 0);
    assert.equal((await snapshot()).settings.credentialConfigured, false);
  });

  it('shows missing ranges and rejects adoption before every chunk is received', async () => {
    const initial = await review(pendingJobId);
    const unchanged = await segments(pendingMediaId);
    assert.equal(initial.draft.pendingRanges.length, 1);
    assert.deepEqual(initial.draft.chunks.map(chunk => chunk.status), ['received', 'pending']);
    assert.equal(initial.draft.canAdopt, false);
    assert.equal(initial.canApply, false);
    await assert.rejects(invoke('apply_transcript_review', { jobId: pendingJobId, draftDigest: initial.draft.digest }));
    await openReview(pendingJobId, pendingMediaId);
    assert((await dialog().getText()).includes('Unresolved ranges prevent adoption.'));
    await expect(dialog().$('button=Adopt these subtitles')).toBeDisabled();
    await expect(dialog().$('input[type="checkbox"]')).toBeDisabled();
    await browser.saveScreenshot(resolve('test-results/native/transcript-pending.png'));
    await closeReview();
    assert.deepEqual(await segments(pendingMediaId), unchanged);
    assert.deepEqual(ledger(), ledgerBefore);
  });

  it('displays both original alternatives and blocks an unresolved boundary', async () => {
    const initial = await review(jobId);
    assert.equal(initial.canApply, false);
    assert.equal(initial.draft.canAdopt, false);
    assert.equal(originalConflict.resolution, null);
    assert.deepEqual(originalConflict.leftAlternative.map(cue => cue.text), ['No, no.']);
    assert.deepEqual(originalConflict.rightAlternative.map(cue => cue.text), ['No.']);
    await assert.rejects(invoke('apply_transcript_review', { jobId, draftDigest: originalDigest }));
    await openReview(jobId);
    const alternatives = await dialog().$$('.boundary-alternatives .boundary-alternative');
    assert.equal(alternatives.length, 2);
    assert((await alternatives[0].getText()).includes('Earlier chunk result'));
    assert((await alternatives[0].getText()).includes('No, no.'));
    assert((await alternatives[1].getText()).includes('Later chunk result'));
    assert((await alternatives[1].getText()).includes('No.'));
    await dialog().$('summary=Original audio ranges and preview status').click();
    const originals = await dialog().$$('summary=Show subtitles for this range');
    assert.equal(originals.length, 2);
    for (const original of originals) await original.click();
    const originalTexts = [];
    for (const original of originals) {
      originalTexts.push(await (await original.parentElement()).getText());
    }
    assert(originalTexts[0].includes('Hello.'));
    assert(originalTexts[1].includes('Goodbye.'));
    await expect(dialog().$('button=Adopt these subtitles')).toBeDisabled();
    await browser.saveScreenshot(resolve('test-results/native/transcript-raw-alternatives.png'));
    await closeReview();
    assert.deepEqual(ledger(), ledgerBefore);
  });

  it('prepares a separate repair estimate of at most thirty seconds without approval or sending', async () => {
    const initial = await review(jobId);
    await openReview(jobId);
    await dialog().$('button=Estimate repair, up to 30 seconds').click();
    const estimate = $('dialog.modal:not(.wide)');
    await estimate.waitForDisplayed();
    assert.equal(await estimate.$('h2').getText(), 'Boundary repair estimate');
    await expect(estimate.$('button=Approve this job')).toBeDisabled();
    const quote = await invoke('prepare_boundary_repair', { jobId, draftDigest: initial.draft.digest, boundaryId: originalConflict.id });
    assert(quote.id && quote.id !== jobId, 'Repair must have its own job and approval');
    assert.equal(quote.canApprove, false);
    assert(quote.endMs > quote.startMs && quote.endMs - quote.startMs <= 30000);
    const saved = storedJob(quote.id);
    assert.equal(saved.state, 'prepared');
    assert.equal(saved.approved_at_ms, null);
    assert.equal(saved.plan.requests.length, 1);
    assert.equal(saved.plan.requests[0].kind, 'transcribe_preview');
    assert(saved.plan.requests[0].audio.duration_ms > 0 && saved.plan.requests[0].audio.duration_ms <= 30000);
    const linked = (await preparations(mediaId)).find(item => item.jobId === quote.id);
    assert.equal(linked.repairParentJobId, jobId);
    assert.equal(linked.repairBoundaryId, originalConflict.id);
    assert.equal((await review(jobId)).draft.digest, initial.draft.digest);
    assert.deepEqual(ledger(), ledgerBefore);
    await browser.saveScreenshot(resolve('test-results/native/transcript-repair-estimate.png'));
    await estimate.$('button[aria-label="Close"]').click();
    await expect(estimate).not.toExist();
    await closeReview();
  });

  it('requires an explicit boundary decision and rejects the previous draft digest', async () => {
    await openReview(jobId);
    await dialog().$('button=Use earlier result').click();
    await browser.waitUntil(async () => (await review(jobId)).draft.digest !== originalDigest);
    const resolved = await review(jobId);
    assert.equal(resolved.draft.conflicts[0].resolution.kind, 'left');
    assert.equal(resolved.draft.canAdopt, true);
    assert.equal(resolved.canApply, true);
    assert.deepEqual(resolved.draft.conflicts[0].leftAlternative, originalConflict.leftAlternative);
    assert.deepEqual(resolved.draft.conflicts[0].rightAlternative, originalConflict.rightAlternative);
    assert.deepEqual(resolved.draft.segments.map(cue => cue.text), ['Hello.', 'No, no.', 'Goodbye.']);
    adoptedDigest = resolved.draft.digest;
    await assert.rejects(invoke('apply_transcript_review', { jobId, draftDigest: originalDigest }));
    await assert.rejects(invoke('resolve_transcript_boundary', { jobId, draftDigest: originalDigest, boundaryId: originalConflict.id, choice: { kind: 'right' } }));
    await assert.rejects(invoke('prepare_boundary_repair', { jobId, draftDigest: originalDigest, boundaryId: originalConflict.id }));
    assert.equal((await review(jobId)).draft.digest, adoptedDigest);
    await expect(dialog().$('input[type="checkbox"]')).toBeEnabled();
    await expect(dialog().$('button=Adopt these subtitles')).toBeDisabled();
    await closeReview();
    assert.deepEqual(ledger(), ledgerBefore);
  });

  it('adopts reviewed subtitles only after confirmation and preserves raw results across restart', async () => {
    const before = await segments(mediaId);
    await openReview(jobId);
    await dialog().$('input[type="checkbox"]').click();
    await dialog().$('button=Adopt these subtitles').waitForEnabled();
    await dialog().$('button=Adopt these subtitles').click();
    await dialog().$('button=Adopted').waitForDisplayed();
    await expect(dialog().$('button=Adopted')).toBeDisabled();
    const adopted = await segments(mediaId);
    const inside = adopted.filter(cue => cue.startMs >= 0 && cue.endMs <= 8000);
    assert.deepEqual(inside.map(cue => cue.text), ['Hello.', 'No, no.', 'Goodbye.']);
    assert(inside.every(cue => cue.status === 'confirmed'));
    assert.deepEqual(adopted.filter(cue => cue.startMs >= 8000), before.filter(cue => cue.startMs >= 8000));
    await closeReview();
    await browser.reloadSession();
    await ready();
    const after = await review(jobId);
    assert.equal(after.applied, true); assert.equal(after.canApply, false);
    assert.equal(after.draft.digest, adoptedDigest);
    assert.deepEqual(after.draft.conflicts[0].leftAlternative, originalConflict.leftAlternative);
    assert.deepEqual(after.draft.conflicts[0].rightAlternative, originalConflict.rightAlternative);
    assert.deepEqual(await segments(mediaId), adopted);
    assert.deepEqual(ledger(), ledgerBefore);
  });

  it('keeps subsequent manual edits and the zero-charge ledger when adoption is repeated', async () => {
    const source = (await segments(mediaId)).find(cue => cue.text === 'No, no.');
    assert(source, 'Natural repetition disappeared during adoption');
    const edited = { ...source, text: 'No, no. Reviewed manually.', translation: '手動で確認した訳。' };
    await invoke('edit_segment', { segment: edited });
    await browser.reloadSession();
    await ready();
    const alreadyApplied = await invoke('apply_transcript_review', { jobId, draftDigest: adoptedDigest });
    assert.equal(alreadyApplied.applied, true);
    assert.deepEqual((await segments(mediaId)).find(cue => cue.id === source.id), edited);
    await assert.rejects(invoke('resolve_transcript_boundary', { jobId, draftDigest: adoptedDigest, boundaryId: originalConflict.id, choice: { kind: 'right' } }));
    await assert.rejects(invoke('prepare_boundary_repair', { jobId, draftDigest: adoptedDigest, boundaryId: originalConflict.id }));
    assert.deepEqual(ledger(), ledgerBefore);
    const after = await snapshot();
    assert.equal(after.budget.spentUsd, 0); assert.equal(after.budget.reservedUsd, 0); assert.equal(after.budget.limitUsd, 0);
    assert.equal(after.settings.credentialConfigured, false);
  });

  it('recovers a missing range locally, preserves the selection across restart, and adopts without sending', async () => {
    const before = await review(pendingJobId);
    const original = before.draft.chunks[0].segments;
    await openReview(pendingJobId, pendingMediaId);
    await dialog().$('select').selectByAttribute('value', '1');
    const editor = () => dialog().$('[aria-label="Correct range 2"]');
    await editor().waitForDisplayed();
    await expect(editor().$('button=Save correction and select for preview')).toBeDisabled();
    const rows = [
      { startMs: 3500, endMs: 4500, text: 'No, no.' },
      // Keep context inside the real eight-second WAV on both native and mock players.
      { startMs: 7200, endMs: 7600, text: 'Recovered locally.' },
    ];
    for (const [index, row] of rows.entries()) {
      await editor().$('button=Add row').click();
      const element = (await editor().$$('.boundary-edit-row'))[index];
      const times = await element.$$('input');
      await times[0].setValue((row.startMs / 1000).toFixed(3));
      await times[1].setValue((row.endMs / 1000).toFixed(3));
      await element.$('textarea').setValue(row.text);
    }
    await editor().$('button=Save correction and select for preview').click();
    await browser.waitUntil(async () => (await review(pendingJobId)).draft.chunks[1].source === 'manual');
    const saved = await review(pendingJobId);
    assert.deepEqual(saved.draft.chunks[0].segments, original);
    assert.equal(saved.results[1].state, 'pending');
    assert.equal(saved.draft.pendingRanges.length, 0);
    assert.deepEqual(saved.draft.chunks[1].segments, rows);
    await assert.rejects(invoke('save_manual_transcript_range', { jobId: pendingJobId, draftDigest: before.draft.digest, ordinal: 1, expectedRangeVersion: 0, content: { kind: 'confirmed_no_speech' } }));
    assert.deepEqual(ledger(), ledgerBefore);
    await closeReview();
    await browser.reloadSession();
    await ready();
    assert.deepEqual((await review(pendingJobId)).rangeEdits, saved.rangeEdits);
    await openReview(pendingJobId, pendingMediaId);
    // The identical overlap should join without requiring any paid repair.
    assert.equal((await review(pendingJobId)).draft.conflicts.length, 0);
    await dialog().$('input[type="checkbox"]').click();
    await dialog().$('button=Adopt these subtitles').click();
    await dialog().$('button=Adopted').waitForDisplayed();
    assert((await segments(pendingMediaId)).some(cue => cue.text === 'Recovered locally.'));
    assert.deepEqual(ledger(), ledgerBefore);
    await browser.saveScreenshot(resolve('test-results/native/transcript-manual-recovery.png'));
    await closeReview();
  });

  it('learns and reviews an adopted manual recovery with a retained PATH-FFmpeg audio clip and no AI usage', async () => {
    const initial = await snapshot();
    assert.equal(initial.settings.credentialConfigured, false);
    assert.equal(initial.budget.spentUsd, 0); assert.equal(initial.budget.reservedUsd, 0);
    assert.equal(initial.budget.limitUsd, 0);
    const repaired = (await segments(pendingMediaId)).find(cue => cue.text === 'Recovered locally.');
    assert(repaired && repaired.status === 'confirmed', 'The previous manual recovery must be adopted first');
    const adopted = await review(pendingJobId);
    assert.equal(adopted.applied, true);
    assert.equal(adopted.draft.chunks[1].source, 'manual');
    assert.equal(adopted.results[1].state, 'pending', 'Manual recovery must not become a provider response');

    const candidate = (await invoke('scan_external_tools')).find(tool => tool.toolId === 'ffmpeg' && tool.selectable);
    assert(candidate, 'A compatible existing FFmpeg/ffprobe pair must be available on PATH');
    await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: candidate.path } });
    await invoke('update_settings', { settings: { ...initial.settings, locale: 'en', dailyBudgetUsd: 0, replayContextMs: 150, sentencePause: false } });
    const beforeCard = await snapshot();
    await invoke('save_card', { request: { mediaId: pendingMediaId, segmentId: repaired.id, sourceCueIds: [repaired.id],
      term: 'Recovered locally', meaning: 'A phrase saved after a local subtitle correction.', example: repaired.text,
      translation: 'ローカルで復元した字幕です。' } });
    const card = (await snapshot()).cards.find(item => !beforeCard.cards.some(previous => previous.id === item.id));
    assert(card, 'The adopted manual subtitle did not produce a learning card');
    assert.deepEqual(card.sourceCues, [repaired]);
    assert.equal(card.example, repaired.text); assert(!card.explanation, 'This path must not request an AI explanation');
    assert.equal(card.startMs, repaired.startMs); assert.equal(card.endMs, repaired.endMs);
    const sourceDuration = initial.media.find(item => item.id === pendingMediaId)?.durationMs;
    assert(sourceDuration > repaired.endMs, 'The adopted fixture must retain its source duration');
    const expectedRange = { startMs: Math.max(0, repaired.startMs - 150), endMs: Math.min(sourceDuration, repaired.endMs + 150) };
    assert.deepEqual(card.audioClipRange, expectedRange);
    assert(card.audioPath && isAbsolute(card.audioPath));
    const owned = relative(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'card-audio'), resolve(card.audioPath));
    assert(owned && !owned.startsWith('..') && !isAbsolute(owned), 'Saved audio must belong to this disposable profile');
    const bytes = readFileSync(card.audioPath), audioHash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    let format, pcmBytes;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      assert(start + size <= bytes.length, 'Saved card WAV was truncated');
      if (id === 'fmt ') format = bytes.subarray(start, start + size);
      if (id === 'data') pcmBytes = size;
      offset = start + size + size % 2;
    }
    assert(format && pcmBytes > 0); assert.equal(format.readUInt16LE(0), 1);
    assert.equal(format.readUInt16LE(2), 1); assert.equal(format.readUInt32LE(4), 16000); assert.equal(format.readUInt16LE(14), 16);
    assert.equal(pcmBytes / 2, (expectedRange.endMs - expectedRange.startMs) * 16);
    await invoke('rate_card', { cardId: card.id, rating: 'good' });
    const rated = (await snapshot()).cards.find(item => item.id === card.id);
    assert.equal(rated.reviewCount, card.reviewCount + 1);
    assert(Date.parse(rated.dueAt) > Date.parse(card.dueAt), 'FSRS did not schedule another review');
    await browser.reloadSession(); await ready();
    assert.deepEqual((await snapshot()).cards.find(item => item.id === card.id), rated);
    assert.equal(createHash('sha256').update(readFileSync(card.audioPath)).digest('hex'), audioHash);
    assert.deepEqual((await segments(pendingMediaId)).find(cue => cue.id === repaired.id), repaired);

    if (process.platform === 'win32') {
      await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${pendingMediaId}`);
      await $('[data-testid="native-player-viewport"]').waitForDisplayed();
      await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.ready && !state.error && Math.abs(state.durationMs - sourceDuration) <= 20 && state.tracks.some(track => track.kind === 'audio'); }, { timeoutMsg: 'The repaired audio source did not open in real libmpv' });
      await invoke('player_control', { request: { action: 'pause' } });
      await invoke('player_control', { request: { action: 'loop' } });
      await invoke('player_control', { request: { action: 'rate', value: .5 } });
      await invoke('play_source_range', { mediaId: pendingMediaId, sourceCueIds: [repaired.id] });
      await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return !state.paused && state.positionMs >= expectedRange.startMs - 45 && state.positionMs < expectedRange.startMs + 300; },
        { timeout: 5000, interval: 30, timeoutMsg: 'Recovered source playback did not begin within the saved context interval' });
      await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.paused && state.positionMs >= expectedRange.endMs - 45 && state.positionMs <= expectedRange.endMs + 150; },
        { timeout: 5000, interval: 30, timeoutMsg: 'Recovered source playback did not stop at the contextual interval end' });
      await invoke('player_control', { request: { action: 'rate', value: 1 } });
    } else {
      console.info('Real libmpv interval playback is Windows-only; Linux verified IPC, SQLite, FFmpeg PCM and card persistence.');
    }
    assert.deepEqual(ledger(), ledgerBefore);
    const after = await snapshot();
    assert.equal(after.budget.spentUsd, 0); assert.equal(after.budget.reservedUsd, 0); assert.equal(after.budget.limitUsd, 0);
    assert.equal(after.settings.credentialConfigured, false);
    assert.equal(after.tools.find(tool => tool.id === 'ffmpeg').provider, 'external');
    await browser.saveScreenshot(resolve('test-results/native/transcript-manual-learning-chain.png'));
  });

  it('exports the repaired audio card and restores its reviewed snapshot through confirmed native IPC', async () => {
    const dataRoot = resolve(process.env.SURTITLE_E2E_DATA_DIR);
    const transferRoot = resolve(dataRoot, 'e2e-transfer'), zipPath = resolve(transferRoot, 'learning.zip');
    assert(!existsSync(transferRoot), 'Use a fresh disposable transfer fixture');
    const before = await snapshot();
    assert.equal(before.settings.credentialConfigured, false); assert.equal(before.budget.limitUsd, 0);
    const card = before.cards.find(item => item.mediaId === pendingMediaId && item.term === 'Recovered locally');
    assert(card?.audioPath && card.reviewCount === 1, 'The preceding manual learning chain must pass first');
    const originalCue = (await segments(pendingMediaId)).find(cue => cue.id === card.segmentId);
    const audioHash = createHash('sha256').update(readFileSync(card.audioPath)).digest('hex');
    const readReviews = path => {
      const db = new DatabaseSync(path, { readOnly: true });
      try { return db.prepare('SELECT data FROM reviews WHERE card_id=? ORDER BY id').all(card.id).map(row => JSON.parse(row.data)); }
      finally { db.close(); }
    };
    const originalReviews = readReviews(resolve(dataRoot, 'learning.sqlite'));
    assert.equal(originalReviews.length, 1);
    // The fixture overrides only native file selection. Export, preview, confirmation,
    // hashing, ZIP extraction, database replacement and playback use the real application.
    mkdirSync(transferRoot);
    writeFileSync(resolve(transferRoot, 'enabled.fixture'), 'surtitle.e2e.transfer.v1\r\n', { flag: 'wx' });
    const keyMarker = resolve(dataRoot, 'credentials', 'transfer-retained.fixture');
    writeFileSync(keyMarker, 'Synthetic preservation marker; not a service-account credential.', { flag: 'wx' });
    const openTransfer = async () => {
      await browser.execute(() => { window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); });
      await $('button=Your data').waitForDisplayed(); await $('button=Your data').click();
      await $('dialog').$('h2=Take your learning with you').waitForDisplayed();
    };
    await openTransfer();
    assert((await $('dialog .format-option[aria-pressed="true"]').getText()).includes('Portable backup'));
    await $('dialog').$('button=Choose destination').click();
    await $('dialog').waitForExist({ reverse: true, timeout: 60000 });
    const zip = readFileSync(zipPath), zipHash = createHash('sha256').update(zip).digest('hex');
    assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
    await assert.rejects(invoke('export_learning', { format: 'zip' }), /destination already exists/);
    const previewFiles = () => readdirSync(resolve(dataRoot, 'restore-previews'));
    const superseded = await invoke('preview_restore');
    const cancelled = await invoke('preview_restore');
    assert.equal(previewFiles().length, 1);
    await assert.rejects(invoke('restore_learning', { token: superseded.token }), /expired/);
    await invoke('discard_restore_preview', { token: 'unknown-token-does-not-delete-any-file' });
    assert.equal(previewFiles().length, 1);
    await invoke('discard_restore_preview', { token: cancelled.token });
    assert.deepEqual(previewFiles(), []);
    await assert.rejects(invoke('restore_learning', { token: cancelled.token }), /expired/);
    const stale = await invoke('preview_restore');
    assert(stale && stale.audioCount >= 1 && stale.reviewCount >= 1);
    assert.equal(stale.cardCount, before.cards.length);
    assert.equal(stale.mediaCount, before.media.length);
    const backupsBefore = readdirSync(resolve(dataRoot, 'backups'));
    appendFileSync(zipPath, Buffer.from([0]));
    await assert.rejects(invoke('restore_learning', { token: stale.token }), /changed after preview/);
    writeFileSync(zipPath, zip);
    await assert.rejects(invoke('restore_learning', { token: stale.token }), /expired/);
    assert.deepEqual(previewFiles(), []);
    assert.deepEqual(readdirSync(resolve(dataRoot, 'backups')), backupsBefore);
    assert.equal(createHash('sha256').update(readFileSync(card.audioPath)).digest('hex'), audioHash);
    assert.deepEqual(ledger(), ledgerBefore);

    await invoke('edit_segment', { segment: { ...originalCue, text: 'Changed after the portable backup.' } });
    await invoke('edit_card', { request: { id: card.id, term: card.term, meaning: 'Changed after export.', example: card.example, translation: card.translation, explanation: null } });
    await invoke('rate_card', { cardId: card.id, rating: 'hard' });
    await invoke('update_settings', { settings: { ...before.settings, locale: 'en', dailyBudgetUsd: 0, replayContextMs: 1000 } });
    const changedCard = (await snapshot()).cards.find(item => item.id === card.id);
    assert.equal(changedCard.reviewCount, 2);
    const preferences = JSON.parse(readFileSync(resolve(dataRoot, 'preferences.json'), 'utf8'));
    const jobs = [storedJob(jobId), storedJob(pendingJobId)];
    await openTransfer();
    await $('dialog').$('button=Restore').click();
    await $('dialog').$('button=Choose backup').click();
    await $('dialog .restore-summary').waitForDisplayed();
    const counts = [];
    for (const element of await $('dialog .restore-summary').$$('strong')) counts.push(await element.getText());
    assert.deepEqual(counts, [stale.mediaCount, stale.cardCount, stale.reviewCount, stale.audioCount].map(String));
    await expect($('dialog').$('button=Restore backup')).toBeDisabled();
    assert((await $('dialog').getText()).includes('This device keeps its credentials, usage ledger, and tool settings.'));
    await $('dialog input[type="checkbox"]').click();
    await expect($('dialog').$('button=Restore backup')).toBeEnabled();
    await $('dialog').$('button=Restore backup').click();
    await $('dialog').waitForExist({ reverse: true, timeout: 60000 });

    const restored = (await snapshot()).cards.find(item => item.id === card.id);
    assert(restored?.audioPath && restored.audioPath !== card.audioPath);
    const restoredRelative = relative(resolve(dataRoot, 'card-audio'), resolve(restored.audioPath));
    assert(restoredRelative && !restoredRelative.startsWith('..') && !isAbsolute(restoredRelative));
    assert.deepEqual({ ...restored, audioPath: card.audioPath }, card);
    assert.deepEqual((await segments(pendingMediaId)).find(cue => cue.id === originalCue.id), originalCue);
    assert.deepEqual(readReviews(resolve(dataRoot, 'learning.sqlite')), originalReviews);
    for (const path of [card.audioPath, restored.audioPath]) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), audioHash);
    const addedBackups = readdirSync(resolve(dataRoot, 'backups')).filter(name => !backupsBefore.includes(name));
    assert.equal(addedBackups.length, 1, 'Exactly one pre-restore learning backup must be created');
    const backup = new DatabaseSync(resolve(dataRoot, 'backups', addedBackups[0]), { readOnly: true });
    try {
      assert.equal(JSON.parse(backup.prepare('SELECT data FROM segments WHERE id=?').get(originalCue.id).data).text, 'Changed after the portable backup.');
      assert.deepEqual(JSON.parse(backup.prepare('SELECT data FROM cards WHERE id=?').get(card.id).data), changedCard);
    } finally { backup.close(); }
    assert.equal(createHash('sha256').update(readFileSync(zipPath)).digest('hex'), zipHash);
    assert.deepEqual(previewFiles(), []);
    assert.deepEqual(JSON.parse(readFileSync(resolve(dataRoot, 'preferences.json'), 'utf8')), preferences);
    assert.equal(readFileSync(keyMarker, 'utf8'), 'Synthetic preservation marker; not a service-account credential.');
    assert.deepEqual([storedJob(jobId), storedJob(pendingJobId)], jobs);
    assert.deepEqual(ledger(), ledgerBefore);
    const learning = new DatabaseSync(resolve(dataRoot, 'learning.sqlite'), { readOnly: true });
    try { assert.equal(learning.prepare('SELECT count(*) AS count FROM transcript_range_revisions').get().count, 0); }
    finally { learning.close(); }
    await browser.reloadSession(); await ready();
    assert.deepEqual((await snapshot()).cards.find(item => item.id === card.id), restored);
    assert.deepEqual((await segments(pendingMediaId)).find(cue => cue.id === originalCue.id), originalCue);
    assert.deepEqual(ledger(), ledgerBefore);
    assert.deepEqual(JSON.parse(readFileSync(resolve(dataRoot, 'preferences.json'), 'utf8')), preferences);
    if (process.platform === 'win32') {
      await invoke('play_card_audio', { cardId: card.id });
      await browser.waitUntil(async () => { const state = await invoke('get_player_state'); return state.ready && !state.paused && !state.error && Math.abs(state.durationMs - 700) <= 5 && state.positionMs >= 20; }, { timeout: 5000, interval: 30, timeoutMsg: 'The independently restored card WAV did not play in real libmpv' });
      await invoke('player_control', { request: { action: 'pause' } });
    }
    const after = await snapshot();
    assert.equal(after.settings.replayContextMs, 1000); assert.equal(after.settings.credentialConfigured, false);
    assert.equal(after.tools.find(tool => tool.id === 'ffmpeg').provider, 'external');
    assert.equal(after.budget.spentUsd, 0); assert.equal(after.budget.reservedUsd, 0); assert.equal(after.budget.limitUsd, 0);
    await browser.saveScreenshot(resolve('test-results/native/transcript-portable-learning-restore.png'));
    console.info('Portable ZIP export/preview/confirmed restore uses a guarded test file-selection boundary; OS file-dialog UI is not covered.');
  });
});
