// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const [locale, theme] of [['ja', 'light'], ['en', 'dark']] as const) {
  test(`activity stays visible across navigation with truthful progress ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installLearningFixture(page, locale, theme);
    await page.goto('/');
    const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
    const trigger = page.getByRole('button', { name: text('処理状況を開く', 'Open activity') });
    await expect(trigger).toBeVisible();
    await page.evaluate(() => {
      const fixture = (window as any).__learningFixture;
      const original = fixture.call.bind(fixture);
      const request = { kind: 'url', pathOrUrl: 'https://example.com/lesson.mp4', learningLanguage: 'en', explanationLanguage: 'ja' };
      const downloads = [
        { id: 'direct', request: { ...request, title: 'Direct lesson' }, status: 'running', phase: 'downloading', storedBytes: 1048576, totalBytes: 4194304, totalBytesExact: true, updatedAt: new Date().toISOString() },
        { id: 'youtube', request: { ...request, title: 'YouTube lesson', pathOrUrl: 'https://youtube.com/watch?v=fixture' }, status: 'running', phase: 'downloading', storedBytes: 2097152, totalBytes: 1048576, totalBytesExact: false, updatedAt: new Date().toISOString() },
      ];
      const operations = [{ id: 'tool-fixture', kind: 'tool', toolId: 'ffmpeg', label: 'FFmpeg', parentId: 'download:youtube', status: 'running', phase: 'verifying', updatedAt: new Date().toISOString() }];
      fixture.finishProgress = () => {
        downloads[0].status = 'completed'; downloads[0].phase = 'completed'; downloads[0].storedBytes = 4194304; downloads[0].updatedAt = new Date().toISOString();
        downloads[1].status = 'failed'; downloads[1].updatedAt = new Date().toISOString();
        operations[0].status = 'failed'; operations[0].updatedAt = new Date().toISOString();
      };
      fixture.call = async (command: string, args?: Record<string, unknown>) => {
        if (command === 'list_download_jobs') return structuredClone(downloads);
        if (command === 'list_operation_progress') return structuredClone(operations);
        return original(command, args);
      };
    });
    await expect(trigger).toContainText('2');
    await page.getByRole('navigation', { name: text('メインナビゲーション', 'Main navigation') }).getByRole('link', { name: text('フレーズ帳', 'Phrases'), exact: true }).click();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: text('処理状況', 'Activity'), exact: true });
    const exact = dialog.getByRole('progressbar', { name: 'Direct lesson', exact: true });
    await expect(exact).toHaveAttribute('value', '1048576');
    await expect(exact).toHaveAttribute('max', '4194304');
    await expect(dialog.getByRole('progressbar', { name: 'YouTube lesson', exact: true })).not.toHaveAttribute('value');
    await expect(dialog.getByText('FFmpeg', { exact: true })).toBeVisible();
    await expect(dialog.locator('.activity-item')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath(`activity-${locale}-${theme}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.evaluate(() => (window as any).__learningFixture.finishProgress());
    await expect(trigger.locator('.nav-count')).toHaveCount(0);
    await trigger.click();
    await expect(dialog.locator('[data-activity-id="download:direct"]')).toContainText(text('完了', 'Completed'));
    await expect(dialog.locator('[data-activity-id="download:youtube"]')).toContainText(text('失敗', 'Failed'));
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('activity on Study requests native surface hiding and restores bounds through the mocked transport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  const inspect = page.getByRole('button', { name: 'Inspect this phrase', exact: true });
  await expect(inspect).toBeEnabled();
  // This verifies the browser-to-native contract using fixture calls, not native video rendering.
  const lastSurfaceAction = () => page.evaluate(() => (window as any).__learningFixture.calls
    .filter((call: any) => call.command === 'player_control' && ['hide', 'bounds'].includes(call.args.request?.action))
    .at(-1)?.args.request.action);
  await expect.poll(lastSurfaceAction).toBe('bounds');
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture;
    const original = fixture.call.bind(fixture);
    fixture.call = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_download_jobs') return [{
        id: 'study-download', request: { kind: 'url', pathOrUrl: 'https://example.com/audio.wav', title: 'Audio download', learningLanguage: 'en', explanationLanguage: 'ja' },
        status: 'running', phase: 'downloading', storedBytes: 1048576, totalBytesExact: false, updatedAt: new Date().toISOString(),
      }];
      return original(command, args);
    };
  });
  const trigger = page.getByRole('button', { name: 'Open activity', exact: true });
  await expect(trigger.locator('.nav-count')).toHaveText('1');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(lastSurfaceAction).toBe('hide');
  const progress = dialog.getByRole('progressbar', { name: 'Audio download', exact: true });
  await expect(progress).not.toHaveAttribute('value');
  await expect(progress).toHaveCSS('animation-name', 'none');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(lastSurfaceAction).toBe('bounds');
  await expect(trigger).toBeFocused();
  await expect(inspect).toBeEnabled();
});
