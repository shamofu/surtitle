// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Key } from 'webdriverio';

const dataDirectory = resolve(process.env.SURTITLE_E2E_DATA_DIR);
const fixture = JSON.parse(readFileSync(resolve(dataDirectory, 'fixture.json'), 'utf8'));
const mediaId = fixture.mediaId || 'fixture-media';
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const snapshot = () => invoke('get_app_snapshot');
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const navigate = path => browser.execute(next => { window.history.pushState({}, '', next); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contextInput = () => $('//label[contains(., "Playback context on each side (ms)")]/input');
let originalSettings, originalTool, originalCues = [], nominalCues = [], ledgerBefore, budgetBefore, verified = false;
const savedCards = [];

function ledger() {
  const database = new DatabaseSync(resolve(dataDirectory, 'charges.sqlite'), { readOnly: true });
  try {
    return Object.fromEntries(['ai_settings', 'ai_jobs', 'ai_requests', 'ai_attempts'].map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { database.close(); }
}
function readClip(card) {
  assert(card.audioPath && isAbsolute(card.audioPath), 'Expected an absolute saved clip path');
  const inside = relative(resolve(dataDirectory, 'card-audio'), resolve(card.audioPath));
  assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Refusing to read audio outside the exact disposable profile');
  const bytes = readFileSync(card.audioPath);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    assert(start + length <= bytes.length, 'Truncated WAV chunk');
    if (id === 'fmt ') format = bytes.subarray(start, start + length);
    if (id === 'data') data = bytes.subarray(start, start + length);
    offset = start + length + length % 2;
  }
  assert(format?.length >= 16 && data?.length > 0, 'Saved WAV has no format or audio data');
  assert.equal(format.readUInt16LE(0), 1);
  assert.equal(format.readUInt16LE(2), 1);
  assert.equal(format.readUInt32LE(4), 16000);
  assert.equal(format.readUInt16LE(14), 16);
  return { sha256: hash(bytes), sampleCount: data.length / 2, durationMs: data.length / 32 };
}
async function openStudy() {
  await navigate(`/study/${mediaId}`);
  await $('[data-testid="native-player-viewport"]').waitForDisplayed();
  await browser.waitUntil(async () => { const state = await player(); return state.ready && state.surfaceVisible && state.videoWidth === 640 && state.durationMs >= 11990 && state.durationMs <= 12010; }, { timeoutMsg: 'The real twelve-second disposable media was not loaded' });
}
async function saveContextInUi(value) {
  await navigate('/settings');
  await contextInput().waitForEnabled();
  // Use real editing keys so React observes clearing the controlled numeric input.
  await contextInput().click();
  await browser.keys([Key.Ctrl, 'a']);
  await browser.keys(Key.Backspace);
  await expect(contextInput()).toHaveValue('');
  await contextInput().addValue(String(value));
  await expect(contextInput()).toHaveValue(String(value));
  await $('button=Save changes').waitForEnabled();
  await $('button=Save changes').click();
  await browser.waitUntil(async () => (await snapshot()).settings.replayContextMs === value, { timeoutMsg: `Playback context ${value} was not saved` });
  await browser.refresh();
  await expect(contextInput()).toHaveValue(String(value));
  await openStudy();
}
async function replay(request, expectedStart, expectedEnd) {
  await control({ action: 'pause' });
  await control({ action: 'loop' });
  await control({ action: 'seek', startMs: 6000 });
  await control({ action: 'rate', value: .5 });
  await control(request);
  let first;
  await browser.waitUntil(async () => {
    const state = await player();
    if (!state.paused && state.positionMs >= Math.max(0, expectedStart - 45) && state.positionMs < expectedStart + 140) { first = state.positionMs; return true; }
    return false;
  }, { timeout: 4000, interval: 30, timeoutMsg: `Playback did not begin at contextual source start ${expectedStart}` });
  assert.notEqual(first, undefined);
  await browser.waitUntil(async () => { const state = await player(); return state.paused && state.positionMs >= expectedEnd - 45; }, { timeout: 14000, interval: 30, timeoutMsg: `Source replay did not pause at contextual end ${expectedEnd}` });
  const stopped = await player();
  assert(stopped.positionMs <= expectedEnd + 120, `Expected source stop near ${expectedEnd}, got ${stopped.positionMs}`);
}
async function assertNominalUnchanged() {
  const current = await invoke('list_segments', { mediaId });
  assert.deepEqual(nominalCues.map(cue => current.find(item => item.id === cue.id)), nominalCues, 'Playback context changed nominal subtitle times or text');
}

(process.platform === 'win32' ? describe : describe.skip)('source replay context and retained native card clips', () => {
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const initial = await snapshot();
    assert.equal(initial.settings.credentialConfigured, false, 'Refusing a profile with credentials');
    assert.equal(initial.settings.dailyBudgetUsd, 0);
    assert.equal(initial.budget.spentUsd, 0);
    assert.equal(initial.budget.reservedUsd, 0);
    assert.equal(initial.budget.limitUsd, 0);
    assert.equal(initial.budget.unknownAttempts?.length ?? 0, 0);
    assert.equal(initial.budget.unpricedAttempts ?? 0, 0);
    assert(initial.media.some(item => item.id === mediaId && item.path === fixture.mediaPath), 'Expected the exact disposable media fixture');
    ledgerBefore = ledger();
    assert.deepEqual(initial.jobs.map(job => job.id).sort(), ledgerBefore.ai_jobs.map(job => job.id).sort(), 'IPC must use the explicitly seeded fee database');
    assert(ledgerBefore.ai_jobs.every(job => job.approved_at_ms === null && job.approval_json === null), 'No test job may have a paid approval');
    assert(ledgerBefore.ai_attempts.every(attempt => attempt.dispatched_at_ms === null && attempt.reserve_microusd === 0 && attempt.charged_microusd === 0), 'Only zero-cost offline fixture attempts are allowed');
    budgetBefore = initial.budget;
    originalSettings = initial.settings;
    originalTool = initial.tools.find(tool => tool.id === 'ffmpeg');
    verified = true;
    const settings = { ...originalSettings, locale: 'en', sentencePause: false };
    delete settings.replayContextMs;
    await invoke('update_settings', { settings });
    assert.equal((await snapshot()).settings.replayContextMs, 150, 'The backend must supply the default when the optional input field is absent');
    const cues = await invoke('list_segments', { mediaId });
    originalCues = ['fixture-0', 'fixture-3', 'fixture-11'].map(id => cues.find(cue => cue.id === id));
    assert(originalCues.every(Boolean));
    const times = [[250, 750], [3000, 3750], [11250, 11750]];
    for (const [index, cue] of originalCues.entries()) {
      const segment = { ...cue, startMs: times[index][0], endMs: times[index][1], text: `Replay context fixture ${index}.`, status: 'confirmed' };
      await invoke('edit_segment', { segment });
    }
    const current = await invoke('list_segments', { mediaId });
    nominalCues = originalCues.map(cue => current.find(item => item.id === cue.id));
    await browser.refresh();
    await openStudy();
  });
  after(async () => {
    if (!verified) return;
    await control({ action: 'pause' });
    await control({ action: 'loop' });
    for (const card of savedCards) await invoke('delete_card', { cardId: card.id });
    for (const segment of originalCues.filter(Boolean)) await invoke('edit_segment', { segment });
    if (originalTool) await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: originalTool.provider, ...(originalTool.provider === 'external' ? { path: originalTool.path } : {}) } });
    await invoke('update_settings', { settings: originalSettings });
    assert.deepEqual(ledger(), ledgerBefore, 'Replay and card extraction changed the fee or approval ledger');
    assert.deepEqual((await snapshot()).budget, budgetBefore, 'Replay and card extraction changed AI usage');
  });

  it('persists the default, zero and maximum context and applies it without retiming subtitles', async () => {
    await navigate('/settings');
    await expect(contextInput()).toHaveValue('150');
    for (const value of [0, 150, 1000]) {
      await saveContextInUi(value);
      await replay({ action: 'source-seek', startMs: 3000, endMs: 3750 }, 3000 - value, 3750 + value);
      await assertNominalUnchanged();
    }
    // Ordinary timeline seeks retain their explicitly supplied range.
    await replay({ action: 'seek', startMs: 3000, endMs: 3750 }, 3000, 3750);
    await assertNominalUnchanged();
  });

  it('clamps added context at media edges and repeats the expanded source interval', async () => {
    await saveContextInUi(1000);
    await replay({ action: 'source-seek', startMs: 250, endMs: 750 }, 0, 1750);
    await replay({ action: 'source-seek', startMs: 11250, endMs: 11750 }, 10250, 12000);
    await control({ action: 'pause' });
    await control({ action: 'rate', value: 1 });
    await control({ action: 'seek', startMs: 2000 });
    await control({ action: 'source-loop', startMs: 3000, endMs: 3750 });
    await control({ action: 'play' });
    let precedingContext = false, followingContext = false, wrapped = false, previous = 2000;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && !wrapped) {
      const state = await player();
      assert.equal(state.paused, false, 'Source repeat unexpectedly paused');
      assert(state.positionMs >= 1950 && state.positionMs <= 4830, `Repeat escaped its expanded bounds: ${state.positionMs}`);
      precedingContext ||= state.positionMs < 2850;
      followingContext ||= state.positionMs > 4050;
      wrapped ||= previous > 4300 && state.positionMs < 2350;
      previous = state.positionMs;
      await browser.pause(40);
    }
    assert(precedingContext && followingContext && wrapped, 'Native repeat did not include both margins and return to the expanded start');
    await control({ action: 'pause' });
    await control({ action: 'source-loop' });
    await control({ action: 'rate', value: .5 });
    await invoke('play_source_range', { mediaId, sourceCueIds: [nominalCues[1].id] });
    await browser.waitUntil(async () => { const state = await player(); return state.paused && state.positionMs >= 4705 && state.positionMs <= 4870; }, { timeout: 14000, interval: 40, timeoutMsg: 'Saved-source replay did not use the configured context' });
    await assertNominalUnchanged();
  });

  it('records actual PCM extraction ranges and preserves existing clips after setting and source edits', async () => {
    await control({ action: 'pause' });
    const candidate = (await invoke('scan_external_tools')).find(item => item.toolId === 'ffmpeg' && item.selectable);
    assert(candidate, 'Select a compatible existing FFmpeg/ffprobe pair on PATH for this native test');
    await invoke('set_tool_provider', { request: { toolId: 'ffmpeg', provider: 'external', path: candidate.path } });
    for (const context of [0, 150, 1000]) {
      const before = await snapshot();
      await invoke('update_settings', { settings: { ...before.settings, replayContextMs: context } });
      const cue = nominalCues[1];
      await invoke('save_card', { request: { mediaId, segmentId: cue.id, term: `replay context ${context}`, meaning: 'A context regression fixture', example: cue.text, explanation: 'Saved explanation from the original subtitle.' } });
      const card = (await snapshot()).cards.find(item => !before.cards.some(previous => previous.id === item.id));
      assert(card, 'Saving the source did not produce a card');
      savedCards.push(card);
      assert.equal(card.startMs, 3000);
      assert.equal(card.endMs, 3750);
      assert.deepEqual(card.sourceCues, [cue]);
      assert.deepEqual(card.audioClipRange, { startMs: 3000 - context, endMs: 3750 + context });
      const clip = readClip(card);
      assert.equal(clip.sampleCount, (750 + context * 2) * 16, 'Extracted PCM duration does not match its stored actual source range');
      card.testClip = clip;
    }
    const beforeChange = await snapshot();
    await invoke('update_settings', { settings: { ...beforeChange.settings, replayContextMs: 0 } });
    await invoke('edit_segment', { segment: { ...nominalCues[1], startMs: 3100, endMs: 3800, text: 'Edited source after the audio was saved.' } });
    await browser.reloadSession();
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const persisted = await snapshot();
    assert.equal(persisted.settings.replayContextMs, 0);
    for (const saved of savedCards) {
      const card = persisted.cards.find(item => item.id === saved.id);
      const { testClip, ...original } = saved;
      assert.deepEqual(card, original, 'A settings/source edit changed the frozen learning card');
      assert.deepEqual(readClip(card), testClip, 'A settings/source edit changed an existing audio clip');
    }
    assert.deepEqual(ledger(), ledgerBefore);
  });
});
