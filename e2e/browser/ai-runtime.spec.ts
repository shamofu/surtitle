// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture, setTranscriptOpen } from './learning-fixture';

async function installRuntimeFixture(page: Page, locale: 'ja' | 'en', kind: 'transcribe' | 'vocabulary' | 'translate', completed = false) {
  await installLearningFixture(page, locale, locale === 'ja' ? 'light' : 'dark');
  const sentence = 'The sound of the sea follows us along the coast. ';
  const preview = kind === 'vocabulary' ? JSON.stringify({ items: [{ term: 'along the coast', meaning: '海岸沿いに', explanation: sentence.repeat(90), example: 'We walked along the coast.' }] })
    : kind === 'translate' ? JSON.stringify({ translations: [{ id: 'visual-cue-0', translation: '海岸に沿った小道を歩きました。'.repeat(100) }] })
      : JSON.stringify({ transcript: sentence.repeat(100), words: [{ text: 'Must not duplicate word text' }] });
  const runtime = { jobId: 'live-job', approvalId: 'scope-one', revision: 20,
    events: Array.from({ length: 16 }, (_, index) => ({ id: `event-${index}`, timestamp: `2026-10-11T01:00:${String(index).padStart(2, '0')}Z`, phase: ['sending', 'receiving', 'validating', 'settled'][index % 4], ordinal: Math.floor(index / 4) })),
    preview: { attemptId: 'attempt-four', ordinal: 3, text: preview, state: completed ? 'validated' : 'streaming' } };
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({ contentType: 'application/javascript', body: `
    const ready = ${JSON.stringify(runtime)};
    const runtime = { ...ready, revision: 0, events: [], preview: undefined };
    window.__runtimeFixture = { runtime, begin() { this.update(ready); }, update(next) { Object.assign(runtime, next); window.__runtimeReceive?.({ payload: structuredClone(runtime) }); } };
    export const nativeAvailable = () => true;
    export const call = async (command, args = {}) => {
      const fixture = window.__learningFixture;
      if (command === 'get_ai_runtime') return args.jobId === runtime.jobId ? structuredClone(runtime) : null;
      if (command === 'get_app_snapshot') {
        const snapshot = await fixture.call(command, args);
        snapshot.jobs = [{ id: 'live-job', mediaId: 'visual-fixture', kind: ${JSON.stringify(kind)}, status: ${JSON.stringify(completed ? 'completed' : 'running')},
          createdAt: new Date().toISOString(), progress: ${completed ? 1 : .75}, executionOutcome: ${JSON.stringify(completed ? 'complete' : 'running')},
          requestCounts: { total: 4, succeeded: ${completed ? 4 : 3}, rejected: 0, pending: 0, inFlight: ${completed ? 0 : 1} },
          automaticTranscript: ${kind === 'transcribe'}, transcriptReview: false }];
        return snapshot;
      }
      return fixture.call(command, args);
    };` }));
  await page.route(/\/src\/shared\/native\/events\.ts(?:\?|$)/, route => route.fulfill({ contentType: 'application/javascript', body: `
    export const subscribeNative = (event, callback) => {
      if (event === 'ai-runtime') { window.__runtimeReceive = callback; return () => { if (window.__runtimeReceive === callback) window.__runtimeReceive = undefined; }; }
      return window.__learningFixture.subscribe(event, callback);
    };` }));
}

for (const locale of ['ja', 'en'] as const) {
  for (const kind of ['transcribe', 'vocabulary', 'translate'] as const) {
    test(`completed ${kind} outcome stays in processing history ${locale}`, async ({ page }) => {
      const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
      await page.setViewportSize({ width: 1024, height: 700 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installRuntimeFixture(page, locale, kind, true);
      await page.goto('/study/visual-fixture');
      await page.waitForLoadState('networkidle');
      await setTranscriptOpen(page);
      await page.evaluate(() => (window as any).__runtimeFixture.begin());
      await expect(page.locator('.study-transcript .ai-runtime:visible')).toHaveCount(0);
      await expect(page.locator('.transcription-status')).toHaveCount(0);
      await expect(page.locator('.transcript-row').first()).toBeVisible();
      if (kind === 'transcribe') {
        await page.getByRole('tab', { name: text('文字起こし', 'Transcription'), exact: true }).click();
        await page.getByText(text('文字起こしの履歴 (1)', 'Transcription history (1)'), { exact: true }).click();
      } else {
        await page.getByRole('button', { name: text('処理・管理', 'Activity & tools'), exact: true }).click();
        await page.locator('.study-auxiliary .study-jobs > summary').click();
      }
      const runtime = page.locator(kind === 'transcribe'
        ? '.transcription-workspace .ai-runtime[data-job-id="live-job"]'
        : '.study-auxiliary .ai-runtime[data-job-id="live-job"]');
      await expect(runtime.locator('.ai-runtime-outcome')).toBeVisible();
      await expect(runtime.locator('.ai-runtime-outcome')).toHaveAttribute('data-outcome', 'complete');
      await expect(runtime).toContainText(text('成功 4件・失敗 0件', '4 succeeded · 0 failed'));
      await runtime.getByText(text('生成内容・処理履歴', 'Generated content and history'), { exact: true }).click();
      await expect(runtime.getByRole('region', { name: text('生成中のプレビュー', 'Generation preview') })).toContainText(text('受信した内容', 'Received content'));
      const sends = await page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => ['approve_quote', 'reapprove_quote'].includes(call.command)));
      expect(sends).toHaveLength(0);
    });
    for (const width of [1024, 760]) {
    test(`readable ${kind} stream in processing views, drafts, and activity ${locale} ${width}`, async ({ page }) => {
      const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
      await page.setViewportSize({ width, height: 700 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installRuntimeFixture(page, locale, kind);
      await page.goto('/study/visual-fixture');
      await page.waitForLoadState('networkidle');
      await setTranscriptOpen(page);
      const playerBounds = () => page.locator('.player-card, .native-player-viewport').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        let x = rect.x, y = rect.y;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) { x += parent.scrollLeft; y += parent.scrollTop; }
        return { x, y, width: rect.width, height: rect.height };
      }));
      const before = await playerBounds();
      await page.evaluate(() => (window as any).__runtimeFixture.begin());
      await expect(page.locator('.study-transcript .ai-runtime:visible')).toHaveCount(0);
      await expect(page.locator('.transcription-status')).toHaveCount(0);
      await expect.poll(playerBounds).toEqual(before);
      expect(await page.locator('.transcript-scroll').evaluate(element => element.clientHeight)).toBeGreaterThan(100);
      if (kind === 'transcribe') {
        await page.getByRole('tab', { name: text('文字起こし', 'Transcription'), exact: true }).click();
      } else {
        await page.getByRole('button', { name: text('処理・管理', 'Activity & tools'), exact: true }).click();
      }
      const runtime = page.locator(kind === 'transcribe'
        ? '.transcription-workspace .ai-runtime[data-job-id="live-job"]'
        : '.study-auxiliary .ai-runtime[data-job-id="live-job"]');
      await expect(runtime).toBeVisible();
      const processingBounds = await playerBounds();
      await expect(runtime.locator('.ai-runtime-recent li')).toHaveCount(3);
      await expect(runtime.locator('.ai-runtime-preview')).not.toBeVisible();
      await runtime.getByText(text('生成内容・処理履歴', 'Generated content and history'), { exact: true }).click();
      const preview = runtime.getByRole('region', { name: text('生成中のプレビュー', 'Generation preview') });
      await expect(preview).toContainText(text('生成中・未確定', 'Generating · provisional'));
      await expect(preview).not.toContainText('Must not duplicate word text');
      await expect(preview.getByRole('button')).toHaveCount(0);
      if (kind === 'vocabulary') await expect(preview).toContainText('along the coast');
      if (kind === 'translate') await expect(preview).toContainText('海岸に沿った小道');
      if (kind === 'transcribe') await expect(preview).toContainText('The sound of the sea');
      await expect.poll(playerBounds).toEqual(processingBounds);
      expect(await preview.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(140);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await runtime.getByText(text('処理の履歴', 'Progress history'), { exact: true }).click();
      await expect(runtime.locator('.ai-runtime-history li')).toHaveCount(16);
      await expect(runtime.locator('.ai-runtime-history time')).toHaveCount(16);
      await runtime.locator('.ai-runtime-history').evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => {
        const fixture = (window as any).__runtimeFixture;
        fixture.update({ revision: 21, events: [...fixture.runtime.events, { id: 'later', timestamp: '2026-10-11T01:01:00Z', phase: 'receiving', ordinal: 3 }] });
      });
      await expect(runtime.locator('.ai-runtime-history li')).toHaveCount(17);
      expect(await runtime.locator('.ai-runtime-history').evaluate(element => element.scrollTop)).toBe(0);
      await expect.poll(playerBounds).toEqual(processingBounds);
      if (kind !== 'transcribe') await setTranscriptOpen(page);
      await page.getByRole('tab', { name: text('文字起こし', 'Transcription'), exact: true }).click();
      await page.getByText(text('文字起こしの履歴', 'Transcription history'), { exact: true }).click();
      await page.getByRole('button', { name: text('以前の下書きを開く', 'Open earlier drafts'), exact: true }).click();
      const draftRuntime = page.locator('.draft-study .ai-runtime');
      const draftBounds = await playerBounds();
      await expect(draftRuntime.locator('.ai-runtime-preview')).not.toBeVisible();
      await draftRuntime.getByText(text('生成内容・処理履歴', 'Generated content and history'), { exact: true }).click();
      await expect(draftRuntime.getByRole('region', { name: text('生成中のプレビュー', 'Generation preview') })).toBeVisible();
      await page.evaluate(() => {
        const fixture = (window as any).__runtimeFixture;
        fixture.update({ revision: 22, preview: { ...fixture.runtime.preview, text: '{"text":"The next streamed sentence arrives."}' } });
      });
      await expect(draftRuntime).toContainText('The next streamed sentence arrives.');
      await expect.poll(playerBounds).toEqual(draftBounds);
      await page.getByRole('button', { name: text('処理状況を開く', 'Open activity'), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: text('処理状況', 'Activity'), exact: true });
      const activityRuntime = dialog.locator('.ai-runtime');
      await expect(activityRuntime.locator('.ai-runtime-recent li')).toHaveCount(3);
      await expect(activityRuntime.getByRole('region', { name: text('生成中のプレビュー', 'Generation preview') })).toBeVisible();
      const sends = await page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => ['approve_quote', 'reapprove_quote'].includes(call.command)));
      expect(sends).toHaveLength(0);
    });
    }
  }
}

test('a new stream does not open a Study panel or move playback', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installRuntimeFixture(page, 'ja', 'transcribe');
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  await setTranscriptOpen(page, false);
  const player = page.locator('.player-card');
  const before = await player.boundingBox();
  await page.evaluate(() => (window as any).__runtimeFixture.begin());
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-open', 'false');
  await expect(page.locator('.ai-runtime-preview:visible')).toHaveCount(0);
  expect(await player.boundingBox()).toEqual(before);
});

test('completed AI history loads runtime details only when its history is opened', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, 'en', 'dark');
  const jobIds = Array.from({ length: 24 }, (_, index) => `archived-job-${index}`);
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({ contentType: 'application/javascript', body: `
    const fixture = window.__learningFixture;
    window.__runtimeHistoryReads = [];
    fixture.snapshot.jobs = ${JSON.stringify(jobIds)}.map((id, index) => ({
      id, mediaId: 'visual-fixture', kind: index % 2 ? 'translate' : 'vocabulary', status: 'completed',
      createdAt: '2026-10-11T01:00:00Z', progress: 1, executionOutcome: 'complete',
      requestCounts: { total: 1, succeeded: 1, rejected: 0, pending: 0, inFlight: 0 },
    }));
    export const nativeAvailable = () => true;
    export const call = async (command, args = {}) => {
      if (command === 'get_ai_runtime') {
        window.__runtimeHistoryReads.push(args.jobId);
        return { jobId: args.jobId, approvalId: args.jobId, revision: 1,
          events: [{ id: args.jobId + '-complete', timestamp: '2026-10-11T01:00:00Z', phase: 'completed', ordinal: 0 }],
          preview: { attemptId: args.jobId, ordinal: 0, state: 'validated', text: JSON.stringify({ text: 'Saved response for ' + args.jobId }) } };
      }
      return fixture.call(command, args);
    };` }));
  const reads = () => page.evaluate(() => (window as any).__runtimeHistoryReads as string[]);
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  expect(await reads()).toEqual([]);
  await setTranscriptOpen(page);
  await expect(page.locator('.transcript-row').first()).toBeVisible();
  expect(await reads()).toEqual([]);
  await page.getByRole('button', { name: 'Activity & tools', exact: true }).click();
  const history = page.locator('.study-auxiliary .study-jobs');
  await expect(history.locator(':scope > summary')).toHaveText('Job history (24)');
  await expect(history).not.toHaveAttribute('open', '');
  await expect(history.locator('.ai-runtime')).toHaveCount(0);
  expect(await reads()).toEqual([]);
  await history.locator(':scope > summary').click();
  await expect(history.locator('.ai-runtime')).toHaveCount(jobIds.length);
  await expect.poll(async () => (await reads()).sort()).toEqual([...jobIds].sort());
  await expect(history).toContainText('vocabulary');
  await expect(history).toContainText('translate');
  const runtime = history.locator('.ai-runtime[data-job-id="archived-job-0"]');
  await expect(runtime.locator('.ai-runtime-outcome')).toContainText('1 succeeded · 0 failed');
  await runtime.getByText('Generated content and history', { exact: true }).click();
  await expect(runtime.getByRole('region', { name: 'Generation preview' })).toContainText('Saved response for archived-job-0');
  await setTranscriptOpen(page);
  await expect(page.locator('.transcript-row').first()).toBeVisible();
  await expect(history.locator('.ai-runtime')).toHaveCount(0);
  expect((await reads()).sort()).toEqual([...jobIds].sort());
});

test('idle recovery and event bursts avoid redundant native snapshot reads', async ({ page }) => {
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.current-caption-text')).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const calls = () => page.evaluate(() => {
    const result: Record<string, number> = {};
    for (const { command } of (window as any).__learningFixture.calls.splice(0)) result[command] = (result[command] ?? 0) + 1;
    return result;
  });
  await calls();
  await page.clock.runFor(65_000);
  const idle = await calls();
  await page.evaluate(() => { const fixture = (window as any).__learningFixture; for (let i = 0; i < 100; i++) fixture.publish('player-state', { ...fixture.state, positionMs: 76000 + i }); });
  await page.clock.runFor(200);
  const playback = await calls();
  await page.evaluate(() => { const fixture = (window as any).__learningFixture; for (let revision = 1; revision <= 50; revision++) fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision, domain: 'operations' }); });
  await page.clock.runFor(200);
  const operations = await calls();
  await page.evaluate(() => { const fixture = (window as any).__learningFixture; for (let revision = 51; revision <= 70; revision++) fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision, domain: 'jobs' }); });
  await page.clock.runFor(200);
  const jobs = await calls();
  expect(idle.get_app_snapshot ?? 0).toBe(0);
  expect(idle.get_change_checkpoint).toBe(1);
  expect(playback.get_app_snapshot ?? 0).toBe(0);
  expect(operations.get_app_snapshot ?? 0).toBe(0);
  expect(operations.list_operation_progress).toBe(1);
  expect(jobs.get_snapshot_patch).toBe(1);
});
