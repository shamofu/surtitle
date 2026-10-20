// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 2560, height: 1440 }, { width: 1920, height: 1080 },
    { width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 800, height: 900 }]) {
    test(`learning layout ${locale} ${theme} ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await installLearningFixture(page, locale, theme);
      const assertLayout = async () => {
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByText('Unimplemented visual-test command:', { exact: false })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const bounds = await page.locator('main.page-content').evaluate(main => {
          const outer = main.getBoundingClientRect();
          const content = main.firstElementChild!.getBoundingClientRect();
          return { left: content.left - outer.left, right: outer.left + main.clientWidth - content.right };
        });
        const gutter = size.width < 1000 ? 16 : 24;
        expect(bounds.left, 'The page should use the available width instead of a centered narrow column').toBeCloseTo(gutter, 0);
        expect(bounds.right, 'The page should leave only the outer gutter, excluding its scrollbar').toBeCloseTo(gutter, 0);
      };
      await page.goto('/');
      await expect(page.getByRole('heading', { name: locale === 'ja' ? 'ライブラリ' : 'Library', exact: true })).toBeVisible();
      await assertLayout();
      await page.goto('/study/visual-fixture');
      await expect(page.getByRole('heading', { name: 'A walk along the coast' })).toBeVisible();
      await expect(page.locator('.current-caption-text')).toHaveText('Sometimes the best way to find your way is to take a little detour.');
      const transcript = page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true });
      const initiallyOpen = size.width >= 1000 && size.height >= 681;
      await expect(transcript).toHaveAttribute('aria-expanded', String(initiallyOpen));
      if (initiallyOpen) await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toBeVisible();
      else await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toBeHidden();
      await expect(transcript).toBeInViewport({ ratio: 1 });
      const expectToggleAboveVideo = async () => {
        // The player and dock resize together, so compare geometry from one frame.
        const [video, tab] = await page.evaluate(elements => elements.map(element => {
          if (!element || ['hidden', 'collapse'].includes(getComputedStyle(element).visibility)) return null;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 ? rect.toJSON() : null;
        }), [await page.getByTestId('native-player-viewport').elementHandle(), await transcript.elementHandle()]);
        expect(video).not.toBeNull(); expect(tab).not.toBeNull();
        expect(tab!.y + tab!.height).toBeLessThanOrEqual(video!.y + 1);
        expect(await transcript.evaluate(element => !!element.closest('.study-top'))).toBe(true);
        expect(await transcript.evaluate(element => !element.closest('[inert], [hidden], [aria-hidden="true"]'))).toBe(true);
      };
      await expectToggleAboveVideo();
      const viewport = await page.getByTestId('native-player-viewport').boundingBox();
      expect(viewport).not.toBeNull();
      expect(viewport!.y + viewport!.height).toBeLessThan(size.height);
      await assertLayout();
      const settingsTrigger = page.getByRole('button', { name: locale === 'ja' ? '再生設定' : 'Playback settings', exact: true });
      await settingsTrigger.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: locale === 'ja' ? '閉じる' : 'Close', exact: true }).click();
      await expect(settingsTrigger).toBeFocused();
      if (!initiallyOpen) await transcript.click();
      await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toBeVisible();
      await expect(transcript).toHaveAttribute('aria-expanded', 'true');
      await expectToggleAboveVideo();
      if (size.width < 1000) {
        await page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript').scrollIntoViewIfNeeded();
        await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toBeInViewport();
      }
      const rows = page.locator('.transcript-row');
      expect(await rows.count()).toBeGreaterThan(0);
      expect(await rows.count()).toBeLessThan(50);
      await assertLayout();
      await page.getByRole('button', { name: locale === 'ja' ? '意味を調べる' : 'Explore meaning', exact: true }).click();
      await expect(page.getByRole('button', { name: locale === 'ja' ? '元の位置から再生を再開' : 'Resume from original position', exact: true })).toBeVisible();
      if (size.width < 1000) {
        await page.getByRole('button', { name: locale === 'ja' ? '元の位置から再生を再開' : 'Resume from original position', exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByRole('button', { name: locale === 'ja' ? '元の位置から再生を再開' : 'Resume from original position', exact: true })).toBeInViewport();
      }
      await assertLayout();
      await expect(page.locator('.context-meaning')).toBeVisible();
      await page.locator('.phrase-save-toggle').click();
      await expect(page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true })).toBeVisible();
      await page.locator('.save-phrase-form').scrollIntoViewIfNeeded();
      await assertLayout();
      await page.locator('.save-phrase-form').getByRole('button', { name: locale === 'ja' ? 'あとで続ける' : 'Continue later', exact: true }).click();
      await page.getByRole('button', { name: locale === 'ja' ? '元の位置から再生を再開' : 'Resume from original position', exact: true }).click();
      await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toBeVisible();
      await expect(page.getByRole('heading', { name: locale === 'ja' ? '字幕' : 'Transcript', exact: true })).toBeFocused();
      await transcript.click();
      await expect(page.locator('.study-companion')).toBeHidden();
      await expect(transcript).toHaveAttribute('aria-expanded', 'false');
      await expect(transcript).toBeFocused();
      await expectToggleAboveVideo();
      for (const [path, heading] of [
        ['/cards', locale === 'ja' ? 'フレーズ帳' : 'Phrases'],
        ['/review', locale === 'ja' ? '復習' : 'Review'],
        ['/settings', locale === 'ja' ? '設定' : 'Settings'],
      ]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await assertLayout();
      }
    });
  }
}
