// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { drop, importFixture, importPaths } from './import-fixture';
import type { ImportFixtureWindow } from './import-fixture';

for (const [locale, theme] of [['en', 'dark'], ['ja', 'light']] as const) {
  test(`import queue stays readable and recovers partial failures in ${locale} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await importFixture(page, locale, theme);
    const paths = importPaths;
    await page.evaluate(paths => (window as ImportFixtureWindow).__importDrop('tauri://drag-enter', paths), paths);
    await expect(page.locator('.library-drop-overlay')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`library-drop-${locale}-${theme}.png`), animations: 'disabled' });
    await drop(page, [...paths, paths[0]]);
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.import-file-row')).toHaveCount(3);
    await expect(dialog.locator('.import-file-row.invalid')).toHaveCount(1);
    expect(await page.evaluate(() => (window as ImportFixtureWindow).__learningFixture.calls.filter(call => call.command === 'import_local_media').length)).toBe(0);
    await expect(dialog.getByRole('button', { name: locale === 'ja' ? '2 件をライブラリに追加' : 'Add 2 files to library', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: locale === 'ja' ? '2 件をライブラリに追加' : 'Add 2 files to library', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`import-review-${locale}-${theme}.png`), animations: 'disabled' });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: locale === 'ja' ? '2 件をライブラリに追加' : 'Add 2 files to library', exact: true }).click();
    await expect(dialog.locator('.import-file-row.imported')).toHaveCount(1);
    await expect(dialog.locator('.import-file-row.failed')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: locale === 'ja' ? '失敗したファイルだけ再試行' : 'Retry failed files', exact: true })).toBeInViewport();
    await expect(dialog.locator('.import-file-row.imported a')).toHaveAttribute('href', '/study/imported-1');
    await page.screenshot({ path: testInfo.outputPath(`import-results-${locale}-${theme}.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: locale === 'ja' ? '失敗したファイルだけ再試行' : 'Retry failed files', exact: true }).click();
    await expect(dialog.locator('.import-file-row.imported')).toHaveCount(2);
    expect(await page.evaluate(() => (window as ImportFixtureWindow).__learningFixture.calls.filter(call => call.command === 'import_local_media').length)).toBe(3);
    await dialog.getByRole('button', { name: locale === 'ja' ? 'ライブラリに戻る' : 'Return to library', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await drop(page, [paths[0]]);
    await expect(dialog.locator('.import-file-row.existing')).toHaveCount(1);
    await expect(dialog.locator('.import-file-row.existing a')).toHaveAttribute('href', '/study/imported-1');
  });
}
