// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installLearningFixture } from '../browser/learning-fixture';
import { drop, importFixture, importPaths } from '../browser/import-fixture';

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('Unimplemented visual-test command:', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });
}

test.beforeEach(async ({ page }) => {
  // Date labels remain fixed while browser timers and interactions still run.
  await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
});

for (const [locale, theme] of [['ja', 'light'], ['en', 'dark']] as const) {
  const label = `${locale}-${theme}-1024x700`;
  const inspect = locale === 'ja' ? 'この言葉を確認' : 'Inspect this phrase';

  test(`study ${label}`, async ({ page }) => {
    await installLearningFixture(page, locale, theme);
    await page.goto('/study/visual-fixture');
    await expect(page.getByRole('button', { name: inspect, exact: true })).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.current-caption-text')).toHaveText('Sometimes the best way to find your way is to take a little detour.');
    await capture(page, `study-${label}`);
  });

  test(`phrase save ${label}`, async ({ page }) => {
    await installLearningFixture(page, locale, theme);
    await page.goto('/study/visual-fixture');
    await page.getByRole('button', { name: inspect, exact: true }).click();
    await page.getByRole('button', { name: locale === 'ja' ? '意味を見る' : 'Show meaning', exact: true }).click();
    await page.getByRole('button', { name: locale === 'ja' ? 'フレーズを保存' : 'Save a phrase', exact: true }).click();
    await page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true }).fill('take a little detour');
    await page.getByLabel(locale === 'ja' ? '意味' : 'Meaning', { exact: true }).fill('少し寄り道をする');
    await expect(page.locator('.save-phrase-form').getByRole('status')).toHaveText(
      locale === 'ja' ? '入力は自動保存されます。' : 'Your input is saved automatically.',
    );
    await page.locator('.save-phrase-form').scrollIntoViewIfNeeded();
    await capture(page, `phrase-save-${label}`);
  });

  test(`partial import failure ${label}`, async ({ page }) => {
    await importFixture(page, locale, theme);
    await drop(page, [...importPaths, importPaths[0]]);
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.import-file-row')).toHaveCount(3);
    await dialog.getByRole('button', { name: locale === 'ja' ? '2 件をライブラリに追加' : 'Add 2 files to library', exact: true }).click();
    await expect(dialog.locator('.import-file-row.imported')).toHaveCount(1);
    await expect(dialog.locator('.import-file-row.failed')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: locale === 'ja' ? '失敗したファイルだけ再試行' : 'Retry failed files', exact: true })).toBeInViewport();
    await capture(page, `import-results-${label}`);
  });

  test(`transcription tab ${label}`, async ({ page }) => {
    await installLearningFixture(page, locale, theme);
    await page.goto('/study/visual-fixture');
    await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
    const tab = page.getByRole('tab', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(locale === 'ja' ? '文字起こしの履歴' : 'Transcription history', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: locale === 'ja' ? '文字起こしを作り直す' : 'Transcribe again', exact: true })).toBeInViewport();
    await capture(page, `transcription-tab-${label}`);
  });

  test(`phrase edit confirmation ${label}`, async ({ page }) => {
    await installLearningFixture(page, locale, theme);
    await page.goto('/cards');
    await page.getByLabel(locale === 'ja' ? 'take a little detourの操作' : 'Actions for take a little detour', { exact: true }).click();
    await page.getByRole('button', { name: locale === 'ja' ? '編集' : 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: locale === 'ja' ? 'フレーズを編集' : 'Edit phrase', exact: true });
    await editor.getByLabel(locale === 'ja' ? '意味' : 'Meaning', { exact: true }).fill('少し寄り道をする — take a short detour');
    await page.keyboard.press('Escape');
    const confirmation = page.getByRole('dialog', { name: locale === 'ja' ? '変更を保存しますか？' : 'Save your changes?', exact: true });
    await expect(page.locator('dialog[open]')).toHaveCount(2);
    await expect(confirmation.getByRole('button', { name: locale === 'ja' ? '保存して閉じる' : 'Save and close', exact: true })).toBeInViewport({ ratio: 1 });
    await capture(page, `phrase-edit-confirmation-${label}`);
  });
}
