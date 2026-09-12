// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const mediaId = fixture.mediaId || 'fixture-media';
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const toggle = () => $('//label[contains(., "Pause at the end of a caption group")]/input[@type="checkbox"]');
let originals = [], originalSettings, isolationVerified = false, ledgerBefore;

function ledger() {
  // The path comes only from the explicitly seeded test directory, never from
  // the application profile. Matching its job IDs also proves IPC isolation.
  const database = new DatabaseSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'charges.sqlite'), { readOnly: true });
  try {
    return {
      jobs: database.prepare('SELECT id,plan_json,state,approved_at_ms,approval_json FROM ai_jobs ORDER BY id').all(),
      attempts: database.prepare('SELECT id,job_id,ordinal,state,reserve_microusd,charged_microusd,dispatched_at_ms,usage_json FROM ai_attempts ORDER BY id').all(),
      requests: database.prepare('SELECT job_id,ordinal,state,response_json,error_code FROM ai_requests ORDER BY job_id,ordinal').all(),
      limits: database.prepare('SELECT limits_json FROM ai_settings WHERE id=1').get().limits_json,
    };
  } finally { database.close(); }
}
function assertOfflineFixtures(snapshot, stored) {
  const expected = new Map();
  if (process.env.SURTITLE_E2E_AI_RECOVERY === 'translation') expected.set('E2E saved translation recovery', { media: 'e2e-ai-recovery', kind: 'translation', requests: 1, received: 1 });
  if (process.env.SURTITLE_E2E_TRANSCRIPT_REVIEW === 'boundary') {
    expected.set('E2E / e2e-transcript-review', { media: 'e2e-transcript-review', kind: 'transcribe_preview', requests: 2, received: 2 });
    expected.set('E2E / e2e-transcript-pending', { media: 'e2e-transcript-pending', kind: 'transcribe_preview', requests: 2, received: 1 });
    expected.set('E2E transcript repair', { media: 'e2e-transcript-review', kind: 'transcribe_preview', requests: 1, received: 0 });
  }
  assert.equal(stored.jobs.length, expected.size, 'Only the explicitly enabled offline fixture jobs are allowed');
  assert.deepEqual(snapshot.jobs.map(job => job.id).sort(), stored.jobs.map(job => job.id).sort(), 'IPC must use the exact disposable ledger');
  const seen = new Set();
  for (const job of stored.jobs) {
    const plan = JSON.parse(job.plan_json), allowed = expected.get(plan.title);
    assert(allowed && !seen.has(plan.title), 'Unexpected or duplicate fixture plan');
    seen.add(plan.title);
    assert.equal(plan.project_id, 'e2e-project');
    assert.equal(plan.credential_id, 'unused-e2e-fixture');
    assert.equal(plan.binding.media_id, allowed.media);
    assert.equal(plan.requests.length, allowed.requests);
    assert(plan.requests.every(request => request.kind === allowed.kind));
    assert.equal(job.approved_at_ms, null, 'No test job may have a paid approval');
    assert.equal(job.approval_json, null, 'No test job may have an approval payload');
    const attempts = stored.attempts.filter(attempt => attempt.job_id === job.id);
    assert.equal(attempts.length, allowed.received, 'Unexpected fixture execution history');
    assert.deepEqual(attempts.map(attempt => attempt.ordinal).sort(), Array.from({ length: allowed.received }, (_, index) => index));
    const requests = stored.requests.filter(request => request.job_id === job.id);
    assert.equal(requests.length, allowed.requests);
    for (const request of requests) {
      assert.equal(request.state, request.ordinal < allowed.received ? 'completed' : 'pending');
      assert.equal(request.error_code, null);
      assert.equal(request.response_json !== null, request.ordinal < allowed.received);
    }
  }
  assert.equal(stored.attempts.length, [...expected.values()].reduce((sum, value) => sum + value.received, 0));
  for (const attempt of stored.attempts) {
    assert.equal(attempt.state, 'settled');
    assert.equal(attempt.reserve_microusd, 0);
    assert.equal(attempt.charged_microusd, 0);
    assert.equal(attempt.dispatched_at_ms, null, 'Offline fixtures must never reach the provider');
    const usage = JSON.parse(attempt.usage_json);
    assert.equal(usage.offlineFixture, true);
    assert.equal(usage.paidRequests, 0);
  }
  assert.deepEqual(JSON.parse(stored.limits), { per_job_microusd: 0, daily_microusd: 0, monthly_microusd: 0 });
}

async function openStudy() {
  await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
  await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${mediaId}`);
  await toggle().waitForEnabled();
  await browser.waitUntil(async () => { const state = await player(); return state.ready && state.surfaceVisible && state.videoWidth > 0; });
}
async function pausedNear(expected) {
  await browser.waitUntil(async () => { const state = await player(); return state.paused && state.positionMs >= expected; }, { timeout: 12000, timeoutMsg: `Native player did not pause at ${expected}` });
  const state = await player();
  assert(state.positionMs <= expected + 350, `Expected ${expected}, got ${state.positionMs}`);
}

(process.platform === 'win32' ? describe : describe.skip)('sentence pauses in the real native study page', () => {
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const initial = await invoke('get_app_snapshot');
    assert.equal(initial.settings.credentialConfigured, false, 'Refusing to mutate a profile with credentials');
    assert.equal(initial.budget.spentUsd, 0, 'Expected a fresh disposable ledger');
    assert.equal(initial.budget.reservedUsd, 0, 'Expected no pending reservations');
    assert.equal(initial.budget.limitUsd, 0, 'Expected the disposable zero budget');
    assert.equal(initial.settings.dailyBudgetUsd, 0, 'Expected the disposable zero budget setting');
    assert.equal(initial.budget.unknownAttempts?.length ?? 0, 0, 'Expected no unknown attempts');
    assert.equal(initial.budget.unpricedAttempts ?? 0, 0, 'Expected no unpriced attempts');
    assert(initial.media.some(media => media.id === mediaId && media.path === fixture.mediaPath), 'Refusing to mutate a profile without the exact disposable fixture');
    ledgerBefore = ledger();
    assertOfflineFixtures(initial, ledgerBefore);
    isolationVerified = true;
    originalSettings = initial.settings;
    await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false } });
    const all = await invoke('list_segments', { mediaId });
    originals = ['fixture-0', 'fixture-1', 'fixture-2'].map(id => all.find(cue => cue.id === id));
    assert(originals.every(Boolean));
    const text = ['I would like', 'to go home.', 'We can leave now.'];
    for (let i = 0; i < originals.length; i++) await invoke('edit_segment', { segment: { ...originals[i], startMs: i * 1000, endMs: i * 1000 + 900, text: text[i], status: 'confirmed' } });
    await browser.refresh();
    await openStudy();
    await control({ action: 'rate', value: 1 });
  });
  after(async () => {
    if (!isolationVerified) return;
    await control({ action: 'pause' });
    await control({ action: 'loop' });
    for (const segment of originals.filter(Boolean)) await invoke('edit_segment', { segment });
    if (originalSettings) await invoke('update_settings', { settings: originalSettings });
    assert.deepEqual(ledger(), ledgerBefore, 'Playback must leave every fixture job, request, attempt, approval and budget unchanged');
  });
  it('persists the toggle, stops at joined cue ends, prioritizes source ranges and repeat, and refreshes edited boundaries', async () => {
    await expect(toggle()).not.toBeSelected();
    await toggle().click();
    await browser.waitUntil(async () => (await invoke('get_app_snapshot')).settings.sentencePause === true);
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(1900);
    await control({ action: 'play' });
    await pausedNear(2900);

    await invoke('play_source_range', { mediaId, sourceCueIds: originals.map(cue => cue.id) });
    await browser.waitUntil(async () => {
      const state = await player();
      return !state.paused && state.positionMs > 0 && state.positionMs < 1200;
    }, { timeout: 8000, interval: 50, timeoutMsg: 'Source replay never advanced near the start of its new range' });
    await pausedNear(2900);
    const rejected = await browser.execute(async id => {
      try { await window.__TAURI_INTERNALS__.invoke('play_source_range', { mediaId: id, sourceCueIds: ['fixture-0', 'fixture-2'] }); return ''; }
      catch (error) { return String(error); }
    }, mediaId);
    assert.match(rejected, /adjacent/);

    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'loop', startMs: 0, endMs: 2400 });
    await control({ action: 'play' });
    let crossedSentenceEnd = false, looped = false, previous = 0;
    const deadline = Date.now() + 3400;
    while (Date.now() < deadline) {
      const state = await player();
      assert(!state.paused, 'Sentence mode interrupted the explicit repeat');
      crossedSentenceEnd ||= state.positionMs > 1950;
      looped ||= previous > 1900 && state.positionMs < 500;
      previous = state.positionMs;
      await browser.pause(75);
    }
    assert(crossedSentenceEnd && looped, 'The native decoder did not complete the selected repeat');
    await control({ action: 'pause' });
    await control({ action: 'loop' });
    await invoke('edit_segment', { segment: { ...originals[0], startMs: 0, endMs: 900, text: 'I changed my mind.', status: 'confirmed' } });
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(900);

    await browser.reloadSession();
    await openStudy();
    await expect(toggle()).toBeSelected();
    assert.equal((await player()).sentencePause, true);
    await control({ action: 'seek', startMs: 0 });
    await control({ action: 'play' });
    await pausedNear(900);
    await browser.saveScreenshot(resolve('test-results/native/sentence-playback.png'));
  });
});
