// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

test('browser preview clearly separates UI from the native service', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('ブラウザーで UI をプレビュー中です。', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: '好きな世界から、学ぼう。' })).toBeVisible();
  await expect(page.locator('.media-card')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('library-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.getByRole('heading', { name: 'Learn from what moves you.' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('library-light.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Add content', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to library', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Choose a video or audio file', exact: false }).click();
  await expect(page.getByText('Open Surtitle desktop to use this feature.', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('import-dialog.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.media-card')).toHaveCount(0);
});

test('settings stay readable at compact width and cannot save fabricated state', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'あなたに合った学び方を。' })).toBeVisible();
  await expect(page.getByRole('button', { name: '変更を保存' }).first()).toBeDisabled();
  await expect(page.getByLabel('AI 予算（1 回・1 日・1 か月それぞれの上限 / USD）')).toHaveValue('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-compact.png'), fullPage: true, animations: 'disabled' });
});

