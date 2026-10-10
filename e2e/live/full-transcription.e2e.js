// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit live opt-in; excluded from the ordinary e2e/native glob.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const manifestPath = process.env.SURTITLE_LIVE_MANIFEST;
const enabled = !!manifestPath;
const execute = process.env.SURTITLE_LIVE_EXECUTE === '1';
const config = enabled ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const root = enabled ? resolve(config.dataDir) : '';
const artifact = name => resolve(root, name);
const save = (name, value) => writeFileSync(artifact(name), `${JSON.stringify(value, null, 2)}\n`);
const record = value => appendFileSync(artifact('live-evidence.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
const manifestDigest = enabled ? createHash('sha256').update(readFileSync(manifestPath)).digest('hex') : '';
const invoke = async (command, args = {}) => {
  const result = await browser.execute(async (name, parameters) => {
    try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(name, parameters) }; }
    catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 1500) }; }
  }, command, args);
  if (!result.ok) throw new Error(`IPC ${command}: ${result.error}`);
  return result.value;
};
const snapshot = () => invoke('get_app_snapshot');

function ledger() {
  const db = new DatabaseSync(artifact('charges.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return {
      limits: JSON.parse(db.prepare('SELECT limits_json FROM ai_settings WHERE id=1').get().limits_json),
      attempts: db.prepare('SELECT id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,dispatched_at_ms FROM ai_attempts ORDER BY created_at_ms,id').all(),
      jobs: db.prepare('SELECT id,state,approval_json FROM ai_jobs ORDER BY created_at_ms').all(),
    };
  } finally { db.close(); }
}

async function ready() {
  await browser.setTimeout({ script: 180000 });
  await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__), { timeout: 30000 });
  await $('h1').waitForDisplayed();
}

async function clickVisible(element) {
  await element.waitForExist();
  await browser.execute(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }), await element);
  await element.waitForClickable();
  await element.click();
}

async function openWorkspace(mediaId) {
  await browser.execute(path => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/study/${mediaId}`);
  const panel = $('.study-top-actions button');
  await panel.waitForClickable();
  if ((await panel.getAttribute('aria-expanded')) !== 'true') await panel.click();
  await clickVisible($('.transcript-tabs').$('button=Transcription'));
  await $('.transcription-workspace').waitForDisplayed();
}

async function prepareWholeMedia(media) {
  // Launch once, then observe. A long FFmpeg/VAD run never causes a timed-out
  // WebDriver command to replay the non-idempotent preparation IPC.
  await browser.execute(parameters => {
    window.__surtitleLivePreparation = { status: 'running' };
    void window.__TAURI_INTERNALS__.invoke('prepare_transcription', parameters)
      .then(value => { window.__surtitleLivePreparation = { status: 'complete', value }; })
      .catch(error => { window.__surtitleLivePreparation = { status: 'failed', error: String(error?.message ?? error).slice(0, 1500) }; });
  }, { mediaId: media.id, startMs: 0, endMs: media.durationMs, wholeMedia: true });
  let outcome;
  await browser.waitUntil(async () => {
    outcome = await browser.execute(() => window.__surtitleLivePreparation);
    return outcome?.status !== 'running';
  }, { timeout: config.localPreparationTimeoutMs ?? 900000, interval: 1000, timeoutMsg: 'Whole-video local preparation did not complete' });
  assert.equal(outcome.status, 'complete', outcome.error);
  save('live-preparation.json', { manifestDigest, mediaId: media.id, preparation: outcome.value });
  assert.equal(outcome.value.wholeMedia, true);
  assert.equal(outcome.value.startMs, 0);
  assert(Math.abs(outcome.value.endMs - media.durationMs) <= 2, 'Whole-video prepared audio differs beyond sample rounding');
  return outcome.value;
}

function assertQuote(quote, media) {
  assert.equal(quote.mediaId, media.id);
  assert.equal(quote.startMs, 0);
  assert(Math.abs(quote.endMs - media.durationMs) <= 2, 'Quote must cover the complete prepared audio, allowing only sample rounding');
  assert.equal(quote.model, config.modelId);
  assert.equal(quote.location, config.location);
  assert.equal(quote.applyPolicy, 'auto');
  assert.equal(quote.isRetry, false, 'This is a fresh whole-video approval, not a resume');
  assert.equal(quote.unpriced, false, 'Never start a live run without verified pricing');
  assert(Number.isFinite(quote.maximumUsd) && quote.maximumUsd > 0);
  assert(Math.round(quote.maximumUsd * 1e6) <= config.maxCostMicrousd, 'Worst-case quote exceeds the remaining total validation budget');
  assert.equal(quote.requestCount, config.expectedChunks, 'Chunk count differs: review the staged quote before execution');
  assert.deepEqual(quote.retryPolicy, { version: 1, maxRetries: 2 });
  assert.equal(quote.maximumRequestCount, quote.requestCount * 3);
  assert(quote.maximumRequestCount <= config.maxRequests);
  assert.equal(quote.maximumSendDurationMs, quote.sendDurationMs * 3);
  assert.equal(quote.maximumTotalOutputTokens, quote.totalOutputTokens * 3);
  assert.equal(quote.canApprove, true, quote.blockedReason);
}

(enabled ? describe : describe.skip)('opt-in full original video through the real native transcription worker', function () {
  this.timeout((config.timeoutMs ?? 5400000) + (config.localPreparationTimeoutMs ?? 900000) + 180000);

  it('reviews the whole-video quote and optionally approves it through the rendered UI', async () => {
    assert.equal(config.format, 'surtitle.live-transcription.v1');
    assert(isAbsolute(manifestPath) && isAbsolute(config.dataDir) && isAbsolute(config.sourcePath));
    assert.equal(realpathSync(root), realpathSync(process.env.SURTITLE_E2E_DATA_DIR));
    assert.equal(process.env.SURTITLE_E2E_AI_RECOVERY, undefined);
    assert.equal(process.env.SURTITLE_E2E_TRANSCRIPT_REVIEW, undefined);
    assert(Number.isSafeInteger(config.maxCostMicrousd) && config.maxCostMicrousd > 0 && config.maxCostMicrousd <= 9_998_834);
    assert(Number.isSafeInteger(config.expectedChunks) && config.expectedChunks > 1);
    assert(Number.isSafeInteger(config.maxRequests) && config.maxRequests >= config.expectedChunks * 3);
    assert(!existsSync(artifact('live-execution-started.json')), 'This profile was already submitted; inspect it instead of repeating a paid run');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(config.sourcePath)) hash.update(bytes);
    assert.equal(hash.digest('hex'), config.sourceSha256);
    await ready();
    assert.equal(ledger().attempts.length, 0, 'The isolated profile must contain no previous requests');
    let state = await snapshot();
    const model = state.settings.aiModels?.transcription;
    assert.equal(model?.modelId, config.modelId);
    assert.equal(model?.transcriptionMode, 'transcribe');
    assert(model?.price && model.price.inputMicrousdPerMillion > 0 && model.price.outputMicrousdPerMillion > 0);
    assert.equal(model.price.inputMicrousdPerMillion, config.inputMicrousdPerMillion);
    assert.equal(model.price.outputMicrousdPerMillion, config.outputMicrousdPerMillion);
    assert.equal(state.settings.credentialConfigured, true);
    const cap = config.maxCostMicrousd / 1e6;
    await invoke('update_settings', { settings: { ...state.settings, locale: 'en',
      perJobBudgetUsd: cap, dailyBudgetUsd: cap, monthlyBudgetUsd: cap } });
    assert.deepEqual(ledger().limits, { per_job_microusd: config.maxCostMicrousd,
      daily_microusd: config.maxCostMicrousd, monthly_microusd: config.maxCostMicrousd });
    record({ event: 'source_verified', sourceSha256: config.sourceSha256, durationMs: config.durationMs, maxCostMicrousd: config.maxCostMicrousd, execute });
    let mediaId, preparation, quote;
    if (existsSync(artifact('live-quote.json'))) {
      const staged = JSON.parse(readFileSync(artifact('live-quote.json'), 'utf8'));
      assert.equal(staged.manifestDigest, manifestDigest, 'Manifest changed since the quote was reviewed');
      mediaId = staged.mediaId;
      preparation = staged.preparation;
      quote = await invoke('review_ai_job', { jobId: staged.quote.id });
      assert.equal(quote.digest, staged.quote.digest);
    } else {
      assert.equal((await snapshot()).jobs.length, 0, 'Use a fresh profile with no seeded AI jobs');
      const imported = await invoke('import_local_media', { request: { kind: 'local', pathOrUrl: config.sourcePath,
        learningLanguage: config.learningLanguage, explanationLanguage: config.explanationLanguage } });
      mediaId = imported.mediaId;
      await invoke('load_media', { mediaId });
      let media;
      await browser.waitUntil(async () => {
        state = await snapshot();
        media = state.media.find(item => item.id === mediaId);
        return media?.durationMs > 0;
      }, { timeout: 120000, interval: 500, timeoutMsg: 'Native player did not publish the original video duration' });
      assert(media && Math.abs(media.durationMs - config.durationMs) <= 2, 'Original full-video duration differs');
      const prepared = await invoke('list_transcription_preparations', { mediaId });
      const reusable = prepared.filter(item => item.wholeMedia && item.startMs === 0
        && Math.abs(item.endMs - media.durationMs) <= 2 && !item.jobId && !item.repairParentJobId);
      assert(reusable.length <= 1, 'More than one whole-video preparation exists; review which one to use');
      preparation = reusable[0] ?? await prepareWholeMedia(media);
      save('live-preparation.json', { manifestDigest, mediaId, preparation });
      record({ event: reusable.length ? 'preparation_reused' : 'preparation_created', preparationId: preparation.id,
        startMs: preparation.startMs, endMs: preparation.endMs, wholeMedia: preparation.wholeMedia, chunkCount: preparation.chunkCount });
      quote = await invoke('create_transcription_quote', { preparationId: preparation.id });
    }
    state = await snapshot();
    const media = state.media.find(item => item.id === mediaId);
    assert(media && Math.abs(media.durationMs - config.durationMs) <= 2);
    assert.equal(realpathSync(media.path), realpathSync(config.sourcePath), 'Quoted media must be the exact original video');
    assert.equal(media.learningLanguage, config.learningLanguage);
    assert.equal(media.explanationLanguage, config.explanationLanguage);
    save('live-quote.json', { manifestDigest, mediaId, preparation, quote });
    assert.equal(quote.endMs, preparation.endMs, 'Quote must use the original native audio boundary unchanged');
    assertQuote(quote, media);
    await browser.refresh();
    await ready();
    await openWorkspace(mediaId);
    await clickVisible($(`[data-job-id="${quote.id}"]`).$('button=Open estimate'));
    await $('.quote-review').waitForDisplayed();
    await $('[data-testid="automatic-retry-policy"]').waitForDisplayed();
    await clickVisible($('.quote-review').$('summary=Cost and request details'));
    assert((await $('.quote-review').getText()).includes(config.modelId));
    const displayedQuote = await invoke('review_ai_job', { jobId: quote.id });
    assertQuote(displayedQuote, media);
    for (const field of ['id', 'digest', 'maximumUsd', 'maximumRequestCount', 'maximumSendDurationMs', 'maximumTotalOutputTokens']) {
      assert.equal(displayedQuote[field], quote[field], `Reviewed quote changed: ${field}`);
    }
    assert.deepEqual(displayedQuote.retryPolicy, quote.retryPolicy);
    await browser.saveScreenshot(artifact('live-quote.png'));
    assert.equal(ledger().attempts.length, 0, 'Quote review must not send a provider request');
    assert.deepEqual(ledger().limits, { per_job_microusd: config.maxCostMicrousd,
      daily_microusd: config.maxCostMicrousd, monthly_microusd: config.maxCostMicrousd });
    record({ event: 'quote_reviewed', jobId: quote.id, requestCount: quote.requestCount,
      maximumRequestCount: quote.maximumRequestCount, maximumUsd: quote.maximumUsd });
    if (!execute) {
      save('live-result.json', { status: 'quote-only', paidRequests: 0, jobId: quote.id, quote });
      return;
    }
    // The marker is exclusive and written before the only UI approval click.
    writeFileSync(artifact('live-execution-started.json'), JSON.stringify({ manifestDigest,
      jobId: quote.id, digest: quote.digest, maximumUsd: quote.maximumUsd, at: new Date().toISOString() }), { flag: 'wx' });
    let terminal, observedPartial = false, lastEvidence = '';
    try {
      await clickVisible($('.quote-review').$('button=Start transcription'));
      const deadline = Date.now() + (config.timeoutMs ?? 5400000);
      while (Date.now() < deadline) {
        state = await snapshot();
        const job = state.jobs.find(item => item.id === quote.id);
        assert(job, 'Approved job disappeared');
        const rows = await invoke('list_segments', { mediaId });
        const audit = ledger();
        const attempts = audit.attempts.filter(attempt => attempt.job_id === quote.id);
        const costMicrousd = attempts.reduce((sum, attempt) => sum + (attempt.charged_microusd ?? attempt.reserve_microusd ?? 0), 0);
        assert(costMicrousd <= config.maxCostMicrousd, 'Accounting exceeded the total remaining validation budget');
        assert(attempts.length <= quote.maximumRequestCount);
        const evidence = { status: job.status, progress: job.progress, retry: job.retry,
          attempts: attempts.length, settled: attempts.filter(attempt => attempt.state === 'settled').length,
          subtitles: rows.length, costMicrousd };
        const encoded = JSON.stringify(evidence);
        if (encoded !== lastEvidence) { record({ event: 'progress', ...evidence }); lastEvidence = encoded; }
        if (!observedPartial && job.progress > 0 && job.progress < 1 && rows.some(row => row.text.trim())) {
          observedPartial = true;
          await clickVisible($('.transcript-tabs').$('button[id$="-transcript-tab"]'));
          await $('.transcript-row').waitForDisplayed({ timeout: 15000 });
          await browser.saveScreenshot(artifact('live-partial.png'));
          await clickVisible($('.transcript-tabs').$('button=Transcription'));
          record({ event: 'partial_subtitles_published', progress: job.progress, subtitleCount: rows.length });
        }
        if (job.status === 'completed' && ['applied', 'applied_with_warnings'].includes(job.resultState)) {
          terminal = { job, rows, attempts, costMicrousd, approval: audit.jobs.find(item => item.id === quote.id) }; break;
        }
        assert(['queued', 'running', 'completed'].includes(job.status) && !job.issue, `Whole-video job stopped: ${job.status}: ${job.message}`);
        await browser.pause(1500);
      }
      assert(terminal, 'Whole-video transcription exceeded the bounded observation window');
      assert(observedPartial, 'No partial subtitles were observed before completion');
      assert.equal(terminal.job.progress, 1);
      assert(terminal.rows.length > 0 && terminal.rows.every(row => row.startMs >= 0 && row.endMs <= media.durationMs && row.text.trim()));
      assert.equal(terminal.attempts.filter(attempt => attempt.state === 'settled').length, quote.requestCount);
      assert.equal(new Set(terminal.attempts.filter(attempt => attempt.state === 'settled').map(attempt => attempt.ordinal)).size, quote.requestCount);
      assert(terminal.attempts.every(attempt => ['settled', 'rejected_429'].includes(attempt.state)));
      const approval = JSON.parse(terminal.approval.approval_json);
      assert.equal(approval.retry_policy_version, 1);
      assert.equal(approval.digest, quote.digest);
      await browser.saveScreenshot(artifact('live-completed.png'));
      save('live-result.json', { status: 'completed', jobId: quote.id, sourceSha256: config.sourceSha256,
        durationMs: media.durationMs, chunkCount: quote.requestCount, paidRequests: terminal.attempts.length,
        chargedMicrousd: terminal.attempts.reduce((sum, attempt) => sum + (attempt.charged_microusd ?? 0), 0),
        heldOrChargedMicrousd: terminal.costMicrousd, partialSubtitlesObserved: observedPartial,
        subtitleCount: terminal.rows.length, job: terminal.job, attempts: terminal.attempts });
    } catch (error) {
      // Pause prevents another send if verification fails; never reapprove or
      // replay automatically. An in-flight request remains conservatively held.
      const current = await snapshot().catch(() => null);
      const job = current?.jobs.find(item => item.id === quote.id);
      if (job?.status === 'running') await invoke('pause_ai_job', { jobId: quote.id }).catch(() => {});
      await browser.saveScreenshot(artifact('live-failed.png')).catch(() => {});
      save('live-result.json', { status: 'failed', jobId: quote.id, message: String(error.message),
        partialSubtitlesObserved: observedPartial, job, ledger: ledger() });
      throw error;
    }
  });
});
