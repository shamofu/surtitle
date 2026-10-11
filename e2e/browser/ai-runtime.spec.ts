// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function installRuntimeFixture(page: Page, locale: 'ja' | 'en', kind: 'transcribe' | 'vocabulary' | 'translate') {
  await installLearningFixture(page, locale, locale === 'ja' ? 'light' : 'dark');
  const sentence = 'The sound of the sea follows us along the coast. ';
  const preview = kind === 'vocabulary' ? JSON.stringify({ items: [{ term: 'along the coast', meaning: '海岸沿いに', explanation: sentence.repeat(90), example: 'We walked along the coast.' }] })
    : kind === 'translate' ? JSON.stringify({ translations: [{ id: 'visual-cue-0', translation: '海岸に沿った小道を歩きました。'.repeat(100) }] })
      : JSON.stringify({ transcript: sentence.repeat(100), words: [{ text: 'Must not duplicate word text' }] });
  const runtime = { jobId: 'live-job', approvalId: 'scope-one', revision: 20,
    events: Array.from({ length: 16 }, (_, index) => ({ id: `event-${index}`, timestamp: `2026-10-11T01:00:${String(index).padStart(2, '0')}Z`, phase: ['sending', 'receiving', 'validating', 'settled'][index % 4], ordinal: Math.floor(index / 4) })),
    preview: { attemptId: 'attempt-four', ordinal: 3, text: preview, state: 'streaming' } };
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
        snapshot.jobs = [{ id: 'live-job', mediaId: 'visual-fixture', kind: ${JSON.stringify(kind)}, status: 'running',
          createdAt: new Date().toISOString(), progress: .75, executionOutcome: 'running',
          requestCounts: { total: 4, succeeded: 3, rejected: 0, pending: 0, inFlight: 1 },
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
    for (const width of [1024, 760]) {
    test(`readable ${kind} stream across Study, drafts, and activity ${locale} ${width}`, async ({ page }, testInfo) => {
      const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
      await page.setViewportSize({ width, height: 700 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installRuntimeFixture(page, locale, kind);
      await page.goto('/study/visual-fixture');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: text('字幕一覧', 'Transcript'), exact: true }).click();
      const playerBounds = () => page.locator('.player-card, .native-player-viewport').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        let x = rect.x, y = rect.y;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) { x += parent.scrollLeft; y += parent.scrollTop; }
        return { x, y, width: rect.width, height: rect.height };
      }));
      const before = await playerBounds();
      await page.evaluate(() => (window as any).__runtimeFixture.begin());
      const runtime = page.locator('.study-runtime-dock .ai-runtime').first();
      await expect(runtime).toBeVisible();
      await expect(runtime.locator('.ai-runtime-recent li')).toHaveCount(3);
      await expect.poll(playerBounds).toEqual(before);
      await expect(runtime.locator('.ai-runtime-preview')).not.toBeVisible();
      expect(await page.locator('.transcript-scroll').evaluate(element => element.clientHeight)).toBeGreaterThan(100);
      await page.screenshot({ path: testInfo.outputPath(`runtime-${kind}-${locale}.png`), fullPage: true, animations: 'disabled' });
      await runtime.getByText(text('生成内容・処理履歴', 'Generated content and history'), { exact: true }).click();
      const preview = runtime.getByRole('region', { name: text('生成中のプレビュー', 'Generation preview') });
      await expect(preview).toContainText(text('生成中・未確定', 'Generating · provisional'));
      await expect(preview).not.toContainText('Must not duplicate word text');
      await expect(preview.getByRole('button')).toHaveCount(0);
      if (kind === 'vocabulary') await expect(preview).toContainText('along the coast');
      if (kind === 'translate') await expect(preview).toContainText('海岸に沿った小道');
      if (kind === 'transcribe') await expect(preview).toContainText('The sound of the sea');
      await expect.poll(playerBounds).toEqual(before);
      expect(await preview.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(140);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`runtime-expanded-${kind}-${locale}.png`), fullPage: true, animations: 'disabled' });
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
      await expect.poll(playerBounds).toEqual(before);
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
      await page.screenshot({ path: testInfo.outputPath(`runtime-activity-${kind}-${locale}.png`), animations: 'disabled' });
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
  const player = page.locator('.player-card');
  const before = await player.boundingBox();
  await page.evaluate(() => (window as any).__runtimeFixture.begin());
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-open', 'false');
  await expect(page.locator('.ai-runtime-preview:visible')).toHaveCount(0);
  expect(await player.boundingBox()).toEqual(before);
});
