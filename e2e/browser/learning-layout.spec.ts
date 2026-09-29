// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 800, height: 900 }]) {
    test(`learning layout ${locale} ${theme} ${size.width}x${size.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await installLearningFixture(page, locale, theme);
      const capture = async (name: string) => {
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByText('Unimplemented visual-test command:', { exact: false })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled', fullPage: true });
      };
      await page.goto('/');
      await expect(page.getByRole('heading', { name: locale === 'ja' ? 'ライブラリ' : 'Library', exact: true })).toBeVisible();
      await capture('library');
      await page.goto('/study/visual-fixture');
      await expect(page.getByRole('heading', { name: 'A walk along the coast' })).toBeVisible();
      await expect(page.locator('.current-caption-text')).toHaveText('Sometimes the best way to find your way is to take a little detour.');
      await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toHaveCount(0);
      const viewport = await page.getByTestId('native-player-viewport').boundingBox();
      expect(viewport).not.toBeNull();
      expect(viewport!.y + viewport!.height).toBeLessThan(size.height);
      await capture('study');
      await page.getByRole('button', { name: locale === 'ja' ? 'その他' : 'More', exact: true }).click();
      const settingsTrigger = page.getByRole('button', { name: locale === 'ja' ? '再生設定' : 'Playback settings', exact: true });
      await settingsTrigger.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: locale === 'ja' ? '閉じる' : 'Close', exact: true }).click();
      await expect(settingsTrigger).toBeFocused();
      await page.getByRole('button', { name: locale === 'ja' ? 'その他' : 'More', exact: true }).click();
      await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
      await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toBeVisible();
      if (size.width < 1000) {
        await expect(page.locator('.study-companion h2')).toBeInViewport();
        await expect(page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript')).toBeInViewport();
      }
      const rows = page.locator('.transcript-row');
      expect(await rows.count()).toBeGreaterThan(0);
      expect(await rows.count()).toBeLessThan(50);
      await capture('transcript');
      await page.getByRole('button', { name: locale === 'ja' ? 'この言葉を確認' : 'Inspect this phrase', exact: true }).click();
      await expect(page.getByRole('button', { name: locale === 'ja' ? '視聴に戻る' : 'Return to watching', exact: true })).toBeVisible();
      if (size.width < 1000) {
        await expect(page.locator('.study-companion h2')).toBeInViewport();
        await expect(page.getByRole('button', { name: locale === 'ja' ? '視聴に戻る' : 'Return to watching', exact: true })).toBeInViewport();
      }
      await capture('phrase');
      await page.getByRole('button', { name: locale === 'ja' ? '意味を見る' : 'Show meaning', exact: true }).click();
      await page.getByRole('button', { name: locale === 'ja' ? 'フレーズを保存' : 'Save a phrase', exact: true }).click();
      await expect(page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true })).toBeVisible();
      await page.locator('.save-phrase-form').scrollIntoViewIfNeeded();
      await capture('phrase-save');
      await page.locator('.save-phrase-form').getByRole('button', { name: locale === 'ja' ? 'あとで続ける' : 'Continue later', exact: true }).click();
      await page.getByRole('button', { name: locale === 'ja' ? '視聴に戻る' : 'Return to watching', exact: true }).click();
      await expect(page.locator('.study-companion')).toHaveCount(0);
      if (size.width < 1000) {
        await expect(page.getByTestId('native-player-viewport')).toBeInViewport();
        await expect.poll(() => page.locator('.page-content').evaluate(element => element.scrollTop)).toBe(0);
      }
      for (const [path, heading, name] of [
        ['/cards', locale === 'ja' ? 'フレーズ帳' : 'Phrases', 'phrases'],
        ['/review', locale === 'ja' ? '復習' : 'Review', 'review'],
        ['/settings', locale === 'ja' ? '設定' : 'Settings', 'settings'],
      ]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await capture(name);
      }
    });
  }
}
