// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function installTranscriptionFixture(page: Page, locale: 'ja' | 'en', existingSubtitles = false, automaticRetry = false, unpriced = false) {
    await installLearningFixture(page, locale, 'light');
    await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
      contentType: 'application/javascript', body: `
        let approved = false;
        let revision = 0;
        const preparations = new Map();
        const fixture = window.__learningFixture;
        Object.assign(fixture.snapshot.settings, { credentialConfigured: true, vertexProject: 'project',
          aiModels: { transcription: { modelId: 'gemini-transcribe', transcriptionMode: 'transcribe', maxOutputTokens: 12288 } } });
        fixture.snapshot.media[0].segmentCount = ${existingSubtitles ? 120 : 0};
        fixture.snapshot.jobs = [];
        const changed = (domain, entityId) => fixture.publish('data-changed', {
          version: 1, epoch: 'fixture', revision: ++revision, domain, entityId,
        });
        window.__updateTranscriptionJob = patch => {
          Object.assign(fixture.snapshot.jobs[0], patch);
          changed('jobs', 'quote');
        };
        const sourceBlock = { id: 'block', mediaId: 'visual-fixture', startMs: 0, endMs: 186000,
          text: 'We took the path that follows the coast.', status: 'generated_review', timingPrecision: 'source_block' };
        export const nativeAvailable = () => true;
        export const call = async (command, args = {}) => {
          if (command === 'list_segments') {
            if (!approved && ${existingSubtitles}) return fixture.call(command, args);
            fixture.calls.push({ command, args });
            return approved ? [sourceBlock] : [];
          }
          if (command === 'prepare_transcription') {
            fixture.calls.push({ command, args });
            const prepared = { id: 'preparation-' + preparations.size, mediaId: args.mediaId,
              startMs: args.startMs, endMs: args.endMs, wholeMedia: args.wholeMedia,
              coreDurationMs: args.endMs - args.startMs, sendDurationMs: args.endMs - args.startMs + 6000, chunkCount: 5 };
            preparations.set(prepared.id, prepared);
            return prepared;
          }
          if (command === 'create_transcription_quote') {
            fixture.calls.push({ command, args });
            const prepared = preparations.get(args.preparationId);
            return { id: 'quote', mediaId: 'visual-fixture', kind: 'transcribe', startMs: prepared.startMs, endMs: prepared.endMs,
              model: 'gemini-transcribe', unpriced: ${unpriced}, estimatedUsd: ${unpriced ? 'null' : '.1'}, maximumUsd: ${unpriced ? 'null' : automaticRetry ? '.6' : '.2'}, inputTokens: 100, maxOutputTokens: 12288,
              ${automaticRetry ? 'retryPolicy: { version: 1, maxRetries: 2 }, requestCount: 5, sendDurationMs: 846000, totalOutputTokens: 61440, maximumRequestCount: 15, maximumSendDurationMs: 2538000, maximumTotalOutputTokens: 184320,' : ''}
              expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: true, applyPolicy: 'auto' };
          }
          if (command === 'approve_quote') {
            fixture.calls.push({ command, args }); approved = true;
            fixture.snapshot.media[0].segmentCount = 1;
            fixture.snapshot.jobs = [{ id: 'quote', mediaId: 'visual-fixture', kind: 'transcribe', status: 'running', createdAt: '', progress: .25,
              message: 'Subtitles are arriving', automaticTranscript: true,
              transcriptionRanges: [{ startMs: 0, endMs: 186000, state: 'source_block' }, { startMs: 186000, endMs: 840000, state: 'pending' }] }];
            changed('jobs', 'quote'); changed('media', 'visual-fixture'); changed('subtitles', 'visual-fixture');
            return;
          }
          return fixture.call(command, args);
        }`,
    }));
}

for (const locale of ['ja', 'en'] as const) {
  test(`unpriced transcription has one explicit start action ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installTranscriptionFixture(page, locale, false, true, true);
    await page.goto('/study/visual-fixture');
    const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
    await page.getByRole('button', { name: text('音声から字幕を作成', 'Create subtitles from audio'), exact: true }).click();
    const start = page.getByRole('button', { name: text('文字起こしを開始', 'Start transcription'), exact: true });
    await expect(start).toBeEnabled();
    await expect(start).toBeInViewport();
    await expect(page.getByText(text('料金不明', 'Price unknown'), { exact: true })).toHaveCount(1);
    await expect(page.locator('.quote-review').getByText('gemini-transcribe', { exact: false })).toBeVisible();
    await expect(page.getByText(text('金額上限は保証できません', 'A dollar limit cannot be guaranteed'), { exact: true })).toBeVisible();
    await expect(page.locator('.quote-review input[type="checkbox"]')).toHaveCount(0);
    await expect(page.getByTestId('automatic-retry-policy')).not.toBeVisible();
    await expect(page.getByTestId('transcription-pacing-policy')).not.toBeVisible();
    const sends = () => page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => ['approve_quote', 'reapprove_quote'].includes(call.command)));
    expect(await sends()).toHaveLength(0);
    await start.click();
    expect(await sends()).toHaveLength(1);
    expect((await sends())[0].args.acknowledgeUnpriced).toBe(true);
  });
  test(`transcription has its own tab and returns to received subtitles ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installTranscriptionFixture(page, locale);
    await page.goto('/study/visual-fixture');
    await page.getByRole('button', { name: locale === 'ja' ? '音声から字幕を作成' : 'Create subtitles from audio', exact: true }).click();
    const start = page.getByRole('button', { name: locale === 'ja' ? '文字起こしを開始' : 'Start transcription', exact: true });
    await expect(start).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const commands = () => page.evaluate(() => (window as unknown as { __learningFixture: { calls: { command: string }[] } }).__learningFixture.calls.map(item => item.command));
    expect(await commands()).toContain('prepare_transcription');
    expect(await commands()).not.toContain('approve_quote');
    await expect(page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(start).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await start.click();
    await expect(page.getByRole('tab', { name: locale === 'ja' ? '字幕' : 'Transcript', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.transcription-status')).toHaveCount(0);
    await expect(page.locator('.study-transcript .ai-runtime:visible')).toHaveCount(0);
    await expect(page.getByText(locale === 'ja' ? '本文は取得済み・字幕の時刻は未確定' : 'Text received · subtitle timing unavailable', { exact: false })).toBeVisible();
    await expect(page.locator('.transcript-row')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => call.command === 'get_snapshot_patch' && call.args.domains.includes('jobs')).length)).toBeGreaterThan(0);
    await expect(page.locator('.current-caption-text')).toHaveCount(0);
    await expect(page.getByRole('button', { name: locale === 'ja' ? '下書きから学ぶ' : 'Study a draft', exact: true })).toHaveCount(0);
    await expect(page.locator('.transcript-footer')).toBeInViewport();
    expect(await page.locator('.transcript-scroll').evaluate(element => element.clientHeight)).toBeGreaterThan(120);
    expect(await page.locator('.transcript-footer').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const panel = element.closest('.study-companion')!.getBoundingClientRect();
      return bounds.bottom <= panel.bottom && bounds.top >= panel.top;
    })).toBe(true);
    await page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true }).click();
    await expect(page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.transcription-job[data-job-id="quote"]').getByRole('progressbar')).toBeVisible();
    expect((await commands()).filter(command => command === 'prepare_transcription')).toHaveLength(1);
  });
}

test('transcription inputs and quote survive tab switches, inspection, and closing the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await installTranscriptionFixture(page, 'en', true);
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByRole('tab', { name: 'Transcription', exact: true }).click();
  const calls = () => page.evaluate(() => (window as unknown as { __learningFixture: { calls: { command: string }[] } }).__learningFixture.calls.map(item => item.command));
  expect(await calls()).not.toContain('prepare_transcription');
  await page.getByRole('button', { name: 'Transcribe again', exact: true }).click();
  const start = page.getByRole('button', { name: 'Start transcription', exact: true });
  await expect(start).toBeEnabled();
  await page.getByRole('tab', { name: 'Suggestions', exact: true }).click();
  await page.getByRole('tab', { name: 'Transcription', exact: true }).click();
  await expect(start).toBeEnabled();
  expect((await calls()).filter(command => command === 'prepare_transcription')).toHaveLength(1);
  expect((await calls()).filter(command => command === 'create_transcription_quote')).toHaveLength(1);
  await page.getByText('Change range or model', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Transcribe the whole media' }).uncheck();
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('0:12');
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('0:42');
  await expect(start).toBeEnabled();
  await expect(page.locator('.quote-review')).toContainText('0:12 — 0:42');
  const prepared = await page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => call.command === 'prepare_transcription').at(-1));
  expect(prepared.args).toMatchObject({ startMs: 12000, endMs: 42000, wholeMedia: false });
  const preparationCount = (await calls()).filter(command => command === 'prepare_transcription').length;
  const estimateCount = (await calls()).filter(command => command === 'create_transcription_quote').length;
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Explore meaning', exact: true }).click();
  await page.getByRole('button', { name: 'Back to transcript', exact: true }).click();
  await page.getByRole('tab', { name: 'Transcription', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'From', exact: true })).toHaveValue('0:12');
  await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue('0:42');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'From', exact: true })).toHaveValue('0:12');
  await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue('0:42');
  await expect(start).toBeEnabled();
  await expect(page.locator('.quote-review')).toContainText('0:12 — 0:42');
  expect((await calls()).filter(command => command === 'prepare_transcription')).toHaveLength(preparationCount);
  expect((await calls()).filter(command => command === 'create_transcription_quote')).toHaveLength(estimateCount);
  expect(await calls()).not.toContain('approve_quote');
});

for (const locale of ['ja', 'en'] as const) {
  test(`normal and slowed pacing preserve received subtitles ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installTranscriptionFixture(page, locale, false, true);
    await page.goto('/study/visual-fixture');
    await page.getByRole('button', { name: locale === 'ja' ? '音声から字幕を作成' : 'Create subtitles from audio', exact: true }).click();
    await expect(page.getByTestId('transcription-pacing-policy')).not.toBeVisible();
    await page.getByText(locale === 'ja' ? '料金・送信の詳細' : 'Cost and request details', { exact: true }).click();
    await expect(page.getByTestId('transcription-pacing-policy')).toBeVisible();
    await page.getByRole('button', { name: locale === 'ja' ? '文字起こしを開始' : 'Start transcription', exact: true }).click();
    await page.evaluate(() => {
      const context = window as unknown as { __updateTranscriptionJob: (patch: object) => void };
      context.__updateTranscriptionJob({
        pacing: { ordinal: 1, nextSendAt: new Date(Date.now() + 10000).toISOString(), intervalMs: 10000, slowed: false },
      });
    });
    await expect(page.locator('.transcription-status')).toHaveCount(0);
    await expect(page.locator('.transcript-row')).toHaveCount(1);
    await expect(page.locator('.transcript-row')).toContainText('We took the path that follows the coast.');
    await page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true }).click();
    const job = page.locator('.transcription-job[data-job-id="quote"]');
    await expect(job).toContainText(locale === 'ja' ? '送信間隔を調整中です。' : 'Spacing out requests.');
    await expect(job).toContainText(locale === 'ja' ? '秒後に次の区間を送信' : 'Next request in');
    await expect(job).not.toContainText('HTTP 429');
    await job.getByText(locale === 'ja' ? '処理の詳細' : 'Processing details', { exact: true }).click();
    await expect(job).toContainText(locale === 'ja' ? '区間 2 · 3:06–14:00' : 'Range 2 · 3:06–14:00');
    await expect(job).toContainText(locale === 'ja' ? '10秒以上' : 'At least 10s');
    await expect(job.getByRole('button', { name: locale === 'ja' ? '次の送信前に一時停止' : 'Pause before next request', exact: true })).toBeEnabled();
    await expect(job.getByRole('button', { name: locale === 'ja' ? '中止' : 'Cancel', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const context = window as unknown as { __updateTranscriptionJob: (patch: object) => void };
      context.__updateTranscriptionJob({
        pacing: { ordinal: 1, nextSendAt: new Date(Date.now() + 40000).toISOString(), intervalMs: 40000, slowed: true },
      });
    });
    await expect(job).toContainText(locale === 'ja' ? '混雑を避けるため送信間隔を調整中' : 'Spacing out requests to reduce congestion');
    await expect(job).toContainText(locale === 'ja' ? '40秒以上' : 'At least 40s');
    await expect(job).not.toContainText('HTTP 429');
    await page.getByRole('tab', { name: locale === 'ja' ? '字幕' : 'Transcript', exact: true }).click();
    await expect(page.locator('.transcription-status')).toHaveCount(0);
    await expect(job).not.toBeVisible();
    await expect(page.locator('.transcript-row')).toHaveCount(1);
    await expect(page.locator('.transcript-row')).toContainText('We took the path that follows the coast.');
    const approvals = await page.evaluate(() => (window as unknown as { __learningFixture: { calls: { command: string }[] } }).__learningFixture.calls.filter(call => ['approve_quote', 'reapprove_quote'].includes(call.command)));
    expect(approvals).toHaveLength(1);
  });

  test(`retry wait and stopped details preserve received subtitles ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installTranscriptionFixture(page, locale, false, true);
    await page.goto('/study/visual-fixture');
    await page.getByRole('button', { name: locale === 'ja' ? '音声から字幕を作成' : 'Create subtitles from audio', exact: true }).click();
    await expect(page.getByTestId('automatic-retry-policy')).not.toBeVisible();
    await page.getByText(locale === 'ja' ? '料金・送信の詳細' : 'Cost and request details', { exact: true }).click();
    await expect(page.getByTestId('automatic-retry-policy')).toBeVisible();
    await expect(page.getByTestId('automatic-retry-policy')).toContainText(locale === 'ja' ? '最大15回送信' : '15 requests maximum');
    await page.getByRole('button', { name: locale === 'ja' ? '文字起こしを開始' : 'Start transcription', exact: true }).click();
    await page.evaluate(() => {
      const context = window as unknown as { __updateTranscriptionJob: (patch: object) => void };
      context.__updateTranscriptionJob({
        retry: { state: 'waiting', ordinal: 1, retryNumber: 1, maxRetries: 2, nextRetryAt: new Date(Date.now() + 60000).toISOString() },
        issue: { code: 'provider', phase: 'execute', httpStatus: 429, ordinal: 1, occurredAt: '2026-10-10T00:00:00Z', nextAction: 'resume' },
      });
    });
    await expect(page.locator('.transcription-status')).toHaveCount(0);
    await expect(page.locator('.transcript-row')).toHaveCount(1);
    await page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true }).click();
    const job = page.locator('.transcription-job[data-job-id="quote"]');
    await expect(job).toContainText(locale === 'ja' ? '秒後に再試行' : 'Retrying in');
    await job.getByText(locale === 'ja' ? '処理の詳細' : 'Processing details', { exact: true }).click();
    await expect(job.getByText('HTTP 429', { exact: true })).toBeVisible();
    await expect(job).toContainText(locale === 'ja' ? '区間 2 · 3:06–14:00' : 'Range 2 · 3:06–14:00');
    await expect(job.getByRole('button', { name: locale === 'ja' ? '自動再試行を一時停止' : 'Pause automatic retry', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const context = window as unknown as { __updateTranscriptionJob: (patch: object) => void };
      context.__updateTranscriptionJob({ status: 'failed', retry: { state: 'exhausted', ordinal: 1, retryNumber: 2, maxRetries: 2 } });
    });
    await expect(job).toContainText(locale === 'ja' ? '自動再試行の上限（2回）' : 'Stopped after 2 automatic retries');
    await expect(job.getByRole('button', { name: locale === 'ja' ? '残りを再開' : 'Resume remaining work', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: locale === 'ja' ? '字幕' : 'Transcript', exact: true }).click();
    await expect(page.locator('.transcript-row')).toHaveCount(1);
    const approvals = await page.evaluate(() => (window as unknown as { __learningFixture: { calls: { command: string; args: { retryPolicyVersion?: number } }[] } }).__learningFixture.calls.filter(call => call.command === 'approve_quote'));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].args.retryPolicyVersion).toBe(1);
  });
}
