// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function installTranscriptionFixture(page: Page, locale: 'ja' | 'en', existingSubtitles = false) {
    await installLearningFixture(page, locale, 'light');
    await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
      contentType: 'application/javascript', body: `
        let approved = false;
        const sourceBlock = { id: 'block', mediaId: 'visual-fixture', startMs: 0, endMs: 186000,
          text: 'We took the path that follows the coast.', status: 'generated_review', timingPrecision: 'source_block' };
        export const nativeAvailable = () => true;
        export const call = async (command, args = {}) => {
          const fixture = window.__learningFixture;
          if (command === 'get_app_snapshot') {
            const value = await fixture.call(command, args);
            Object.assign(value.settings, { credentialConfigured: true, vertexProject: 'project',
              aiModels: { transcription: { modelId: 'gemini-transcribe', transcriptionMode: 'transcribe', maxOutputTokens: 12288 } } });
            value.media[0].segmentCount = approved ? 1 : ${existingSubtitles ? 120 : 0};
            value.jobs = approved ? [{ id: 'quote', mediaId: 'visual-fixture', kind: 'transcribe', status: 'running', createdAt: '', progress: .25,
              message: 'Subtitles are arriving', automaticTranscript: true,
              transcriptionRanges: [{ startMs: 0, endMs: 186000, state: 'source_block' }, { startMs: 186000, endMs: 840000, state: 'pending' }] }] : [];
            return value;
          }
          if (command === 'list_segments') return approved ? [sourceBlock] : ${existingSubtitles ? 'fixture.call(command, args)' : '[]'};
          if (command === 'prepare_transcription') {
            fixture.calls.push({ command, args });
            return { id: 'preparation', mediaId: 'visual-fixture', startMs: 0, endMs: 840000, wholeMedia: true,
              coreDurationMs: 840000, sendDurationMs: 846000, chunkCount: 5 };
          }
          if (command === 'create_transcription_quote') {
            fixture.calls.push({ command, args });
            return { id: 'quote', mediaId: 'visual-fixture', kind: 'transcribe', startMs: 0, endMs: 840000,
              model: 'gemini-transcribe', estimatedUsd: .1, maximumUsd: .2, inputTokens: 100, maxOutputTokens: 12288,
              expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: true, applyPolicy: 'auto' };
          }
          if (command === 'approve_quote') { fixture.calls.push({ command, args }); approved = true; window.__transcriptionChanged?.({ payload: null }); return; }
          return fixture.call(command, args);
        }`,
    }));
    await page.route(/\/src\/shared\/native\/events\.ts(?:\?|$)/, route => route.fulfill({
      contentType: 'application/javascript', body: `export const subscribeNative = (event, callback) => {
        if (event === 'app-changed') window.__transcriptionChanged = callback;
        return window.__learningFixture.subscribe(event, callback);
      };`,
    }));
}

for (const locale of ['ja', 'en'] as const) {
  test(`transcription has its own tab and returns to received subtitles ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installTranscriptionFixture(page, locale);
    await page.goto('/study/visual-fixture');
    await page.getByRole('button', { name: locale === 'ja' ? '字幕を用意する' : 'Prepare subtitles', exact: true }).click();
    const start = page.getByRole('button', { name: locale === 'ja' ? 'この内容で文字起こしを開始' : 'Start transcription', exact: true });
    await expect(start).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const commands = () => page.evaluate(() => (window as unknown as { __learningFixture: { calls: { command: string }[] } }).__learningFixture.calls.map(item => item.command));
    expect(await commands()).toContain('prepare_transcription');
    expect(await commands()).not.toContain('approve_quote');
    await expect(page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(start).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('transcription-estimate.png'), fullPage: true, animations: 'disabled' });
    await start.click();
    await expect(page.getByRole('tab', { name: locale === 'ja' ? '字幕' : 'Transcript', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(page.getByText(locale === 'ja' ? '本文は取得済み・字幕の時刻は未確定' : 'Text received · subtitle timing unavailable', { exact: false })).toBeVisible();
    await expect(page.locator('.transcript-row')).toHaveCount(1);
    await expect(page.locator('.current-caption-text')).toHaveCount(0);
    await expect(page.getByRole('button', { name: locale === 'ja' ? '下書きから学ぶ' : 'Study a draft', exact: true })).toHaveCount(0);
    await expect(page.locator('.transcript-footer')).toBeInViewport();
    expect(await page.locator('.transcript-scroll').evaluate(element => element.clientHeight)).toBeGreaterThan(120);
    expect(await page.locator('.transcript-footer').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const panel = element.closest('.study-companion')!.getBoundingClientRect();
      return bounds.bottom <= panel.bottom && bounds.top >= panel.top;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('transcription-progress.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.transcription-status').click();
    await expect(page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect this phrase', exact: true }).click();
  await page.getByRole('button', { name: 'Back to transcript', exact: true }).click();
  await page.getByRole('tab', { name: 'Transcription', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'From', exact: true })).toHaveValue('0:12');
  await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue('0:42');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'From', exact: true })).toHaveValue('0:12');
  await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue('0:42');
  expect((await calls()).filter(command => command === 'prepare_transcription')).toHaveLength(1);
  expect((await calls()).filter(command => command === 'create_transcription_quote')).toHaveLength(1);
  expect(await calls()).not.toContain('approve_quote');
});
