// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
  test(`settings retain valid and incomplete input through navigation ${locale} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 700 }); await installLearningFixture(page, locale, theme); await page.goto('/settings');
    const monthly = page.getByRole('textbox', { name: text('1か月のAI予算（USD）', 'Monthly AI budget (USD)'), exact: true });
    const daily = page.getByLabel(text('1日の上限（USD）', 'Daily limit (USD)'), { exact: true });
    const advanced = page.getByText(text('1日・1処理の上限を調整', 'Adjust daily and per-job limits'), { exact: true });
    await advanced.click(); await daily.fill('-1'); await advanced.click(); await expect(daily).toBeHidden();
    await page.getByRole('button', { name: text('入力エラーを確認', 'Review errors'), exact: true }).click();
    await expect(daily).toBeFocused(); await expect(daily).toBeInViewport(); await expect(daily).toHaveAttribute('aria-invalid', 'true');
    await page.screenshot({ path: info.outputPath('settings-validation.png') });
    await monthly.fill('4');
    await page.getByRole('link', { name: text('フレーズ帳', 'Phrases'), exact: true }).click();
    await expect(page).toHaveURL(/\/cards$/); await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('link', { name: text('設定', 'Settings'), exact: true }).click();
    await expect(monthly).toHaveValue('4'); await expect(daily).toHaveValue('-1');
    await page.reload(); await expect(monthly).toHaveValue('4');
    await advanced.click(); await expect(daily).toHaveValue('-1');
    await daily.fill('1'); await monthly.focus();
    await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.snapshot.settings.dailyBudgetUsd)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`phrase edit saves on Escape without a second dialog ${locale} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 700 }); await installLearningFixture(page, locale, theme); await page.goto('/cards');
    const edit = page.getByRole('button', { name: text('フレーズを編集', 'Edit phrase'), exact: true });
    await edit.click();
    const editor = page.getByRole('dialog', { name: text('フレーズを編集', 'Edit phrase'), exact: true });
    const meaning = editor.getByLabel(text('意味', 'Meaning'), { exact: true });
    await meaning.fill('A small detour'); await page.screenshot({ path: info.outputPath('phrase-editor.png') });
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.phrase-meaning')).toHaveText('A small detour'); await expect(edit).toBeFocused();
    await edit.click(); await expect(meaning).toHaveValue('A small detour');
    await editor.getByRole('button', { name: text('閉じる', 'Close'), exact: true }).last().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`review keeps all four ratings visible at minimum size ${locale} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 700 }); await installLearningFixture(page, locale, theme); await page.goto('/review');
    await page.getByRole('button', { name: text('意味を確認する', 'Reveal meaning'), exact: false }).click();
    const ratings = page.locator('.rating-buttons button'); await expect(ratings).toHaveCount(4);
    for (const button of await ratings.all()) { await expect(button).toBeEnabled(); await expect(button).toBeInViewport({ ratio: 1 }); }
    await expect(page.locator('.review-prompt h2')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.review-answer-label')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('review.png') });
  });
}
