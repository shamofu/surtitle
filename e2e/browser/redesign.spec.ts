// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1024, height: 700, minimum: 300 }, { width: 1440, height: 900, minimum: 450 }]) {
    test(`video remains central ${locale} ${theme} ${size.width}`, async ({ page }, info) => {
      await page.setViewportSize(size); await installLearningFixture(page, locale, theme);
      await page.goto('/study/visual-fixture');
      const video = page.getByTestId('native-player-viewport');
      await expect(page.locator('.current-caption-text')).toContainText('little detour');
      const box = (await video.boundingBox())!;
      expect(Math.min(box.height, box.width * 9 / 16)).toBeGreaterThanOrEqual(size.minimum);
      await expect(page.locator('.study-auxiliary')).toBeHidden();
      await page.evaluate(() => {
        const fixture = (window as any).__learningFixture;
        fixture.snapshot.jobs = Array.from({ length: 20 }, (_, index) => ({ id: `progress-${index}`, kind: 'vocabulary', mediaId: 'visual-fixture', status: 'running', progress: .5, message: 'running', createdAt: new Date().toISOString() }));
        fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'jobs' });
      });
      await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => call.command === 'get_snapshot_patch' && call.args.domains.includes('jobs')).length)).toBeGreaterThan(0);
      await expect.poll(async () => (await video.boundingBox())?.height).toBe(box.height);
      await expect(page.locator('.study-auxiliary')).toBeHidden();
      await page.screenshot({ path: info.outputPath('study.png') });
      await page.getByRole('button', { name: locale === 'ja' ? '処理・管理' : 'Activity & tools', exact: true }).click();
      await expect(page.locator('.study-auxiliary')).toBeVisible();
      await expect(page.locator('.study-jobs .job-status')).toHaveCount(20);
      await expect(page.getByRole('button', { name: locale === 'ja' ? 'この字幕をもう一度' : 'Replay this subtitle', exact: true })).toBeInViewport();
      await page.screenshot({ path: info.outputPath('activity.png') });
    });
  }
}
test('valid settings autosave while incomplete input survives a restart', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light'); await page.goto('/settings');
  const context = page.getByRole('textbox', { name: 'Playback context on each side (ms)' });
  await expect(context).toHaveValue('150'); await context.fill('');
  await page.getByLabel('Learning level').selectOption('B2');
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.snapshot.settings.proficiency)).toBe('B2');
  await page.reload(); await expect(context).toHaveValue('');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Learning level')).toHaveValue('B2');
});
test('phrase edits autosave without changing review history or asking on close', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light'); await page.goto('/cards');
  await page.getByRole('button', { name: 'Edit phrase', exact: true }).first().click();
  await page.getByLabel('Meaning', { exact: true }).fill('a small deviation from your route');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.snapshot.cards[0].meaning)).toBe('a small deviation from your route');
  expect(await page.evaluate(() => (window as any).__learningFixture.snapshot.cards[0].reviewCount)).toBe(2);
});
