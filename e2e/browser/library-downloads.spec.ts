// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function installDownloads(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture;
    const original = fixture.call.bind(fixture);
    const request = { kind: 'url', pathOrUrl: 'https://example.com/lesson.mp4', learningLanguage: 'en', explanationLanguage: 'ja' };
    let downloads: any[] = [];
    let revision = 0;
    const changed = () => fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: ++revision, domain: 'downloads' });
    fixture.setDownloads = (status: 'running' | 'completed' | 'failed' | 'empty') => {
      downloads = status === 'empty' ? [] : [
        { id: 'lesson', request: { ...request, title: 'Downloaded lesson' }, status, phase: status === 'completed' ? 'completed' : 'downloading', storedBytes: status === 'running' ? 1024 : 4096, totalBytes: 4096, totalBytesExact: true,
          mediaId: status === 'completed' ? 'visual-fixture' : undefined, error: status === 'failed' ? 'Connection interrupted' : undefined, updatedAt: new Date().toISOString() },
      ];
      changed();
    };
    fixture.call = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_download_jobs') return structuredClone(downloads);
      if (command === 'cancel_download') { fixture.downloadCancelled = args?.jobId; fixture.setDownloads('failed'); return; }
      if (command === 'start_url_import') {
        fixture.downloadRetried = args?.request;
        if (fixture.keepFailedDownload) {
          downloads.unshift({ id: 'retried-lesson', request: args?.request, status: 'running', phase: 'downloading', storedBytes: 0, updatedAt: new Date().toISOString() });
          changed();
          await new Promise<void>(resolve => {
            fixture.finishDownloadRetry = () => {
              Object.assign(downloads[0], { status: 'completed', phase: 'completed', mediaId: 'visual-fixture' });
              changed();
              resolve();
            };
          });
          return 'retried-lesson';
        }
        fixture.setDownloads('running'); return 'lesson';
      }
      return original(command, args);
    };
  });
}

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 920, height: 620 }]) {
    test(`downloads preserve learning entry points ${viewport.width} ${reducedMotion}`, async ({ page }) => {
      const locale = viewport.width === 1024 ? 'ja' : 'en';
      const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion });
      await installLearningFixture(page, locale, 'light');
      await page.goto('/');
      const entrance = page.getByRole('button', { name: text('ダウンロード', 'Downloads'), exact: true });
      await expect(entrance).toBeVisible();
      await expect(page.locator('.continue-row').first()).toBeVisible();
      await expect(page.locator('.media-row').first()).toBeVisible();
      await installDownloads(page);
      // Wait for the initial page entrance before measuring asynchronous job changes.
      await page.locator('.library-page').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
      for (const status of ['running', 'completed', 'failed', 'empty'] as const) {
        const displacement = await page.evaluate(async status => {
          const selectors = ['.continue-row', '.library-toolbar', '.media-row', '.page-title .page-actions'];
          const rectangles = () => selectors.map(selector => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          });
          const initial = rectangles();
          let maximum = 0;
          (window as any).__learningFixture.setDownloads(status);
          const start = performance.now();
          while (performance.now() - start < 400) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            rectangles().forEach((rect, index) => rect.forEach((value, axis) => {
              maximum = Math.max(maximum, Math.abs(value - initial[index][axis]));
            }));
          }
          return maximum;
        }, status);
        expect(displacement).toBeLessThan(1);
        await expect(page.locator('.library-page .download-jobs')).toHaveCount(0);
        await expect(entrance).toBeVisible();
      }
      await entrance.click();
      const dialog = page.getByRole('dialog', { name: text('ダウンロード', 'Downloads'), exact: true });
      await expect(dialog).toContainText(text('ダウンロードはありません。', 'No downloads yet.'));
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(entrance).toBeFocused();
    });
  }
}

test('download details retain cancel, retry, completed material links, and keyboard return focus', async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 620 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/');
  await expect(page.locator('.continue-row').first()).toBeVisible();
  await installDownloads(page);
  await page.evaluate(() => (window as any).__learningFixture.setDownloads('running'));
  const entrance = page.getByRole('button', { name: 'Downloads', exact: true });
  await entrance.click();
  const dialog = page.getByRole('dialog', { name: 'Downloads', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel download', exact: true });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await cancel.click();
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.downloadCancelled)).toBe('lesson');
  const retry = dialog.getByRole('button', { name: 'Retry from start', exact: true });
  await expect(retry).toBeInViewport({ ratio: 1 });
  await dialog.locator('summary').click();
  await expect(dialog.getByText('Connection interrupted', { exact: true })).toBeVisible();
  await retry.click();
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.downloadRetried?.pathOrUrl)).toBe('https://example.com/lesson.mp4');
  await expect(cancel).toBeVisible();
  await page.evaluate(() => (window as any).__learningFixture.setDownloads('completed'));
  const open = dialog.getByRole('link', { name: 'Open media', exact: true });
  await expect(open).toHaveAttribute('href', '/study/visual-fixture');
  await expect(open).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(entrance).toBeFocused();
  await entrance.press('Enter');
  await expect(open).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(/\/study\/visual-fixture$/);
  await expect(dialog).toHaveCount(0);
});

for (const duringPending of [false, true]) test(`retrying as a new download retains Escape ${duringPending ? 'while the action is pending' : 'after the action completes'}`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/');
  await expect(page.locator('.continue-row').first()).toBeVisible();
  await installDownloads(page);
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture;
    fixture.keepFailedDownload = true;
    fixture.setDownloads('failed');
  });
  const entrance = page.getByRole('button', { name: 'Downloads', exact: true });
  await entrance.click();
  const dialog = page.getByRole('dialog', { name: 'Downloads', exact: true });
  const row = dialog.locator('[data-download-id="lesson"]');
  const retry = row.getByRole('button', { name: 'Retry from start', exact: true });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(row).toBeFocused();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__learningFixture.finishDownloadRetry)).toBe('function');
  if (!duringPending) {
    await page.evaluate(() => (window as any).__learningFixture.finishDownloadRetry());
    await expect(dialog.locator('[data-download-id="retried-lesson"]').getByRole('link', { name: 'Open media', exact: true })).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(row).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(entrance).toBeFocused();
  if (duringPending) await page.evaluate(() => (window as any).__learningFixture.finishDownloadRetry());
});
