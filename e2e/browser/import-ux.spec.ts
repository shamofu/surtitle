// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { drop, importFixture, importPaths } from './import-fixture';
import type { ImportFixtureWindow } from './import-fixture';

for (const [locale, theme] of [['en', 'dark'], ['ja', 'light']] as const) {
  test(`import queue stays readable and recovers partial failures in ${locale} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await importFixture(page, locale, theme);
    const paths = importPaths;
    await page.evaluate(paths => (window as ImportFixtureWindow).__importDrop('tauri://drag-enter', paths), paths);
    await expect(page.locator('.library-drop-overlay')).toBeVisible();
    await drop(page, [...paths, paths[0]]);
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.import-file-row')).toHaveCount(3);
    await expect(dialog.locator('.import-file-row.invalid')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as ImportFixtureWindow).__learningFixture.calls.filter(call => call.command === 'import_local_media').length)).toBe(2);
    await expect(dialog.getByRole('button', { name: /Add .* files to library|件をライブラリに追加/ })).toHaveCount(0);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(dialog.locator('.import-file-row.imported')).toHaveCount(1);
    await expect(dialog.locator('.import-file-row.failed')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: locale === 'ja' ? '失敗したファイルだけ再試行' : 'Retry failed files', exact: true })).toBeInViewport();
    await expect(dialog.locator('.import-file-row.imported a')).toHaveAttribute('href', '/study/imported-1');
    await dialog.getByRole('button', { name: locale === 'ja' ? '失敗したファイルだけ再試行' : 'Retry failed files', exact: true }).click();
    await expect(dialog.locator('.import-file-row.imported')).toHaveCount(2);
    expect(await page.evaluate(() => (window as ImportFixtureWindow).__learningFixture.calls.filter(call => call.command === 'import_local_media').length)).toBe(3);
    await dialog.getByRole('button', { name: locale === 'ja' ? '閉じる' : 'Close', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);
    await drop(page, [paths[0]]);
    await expect(dialog.locator('.import-file-row.imported')).toHaveCount(2);
    await expect(dialog.locator('.import-file-row.imported a').first()).toHaveAttribute('href', '/study/imported-1');
    expect(await page.evaluate(() => (window as ImportFixtureWindow).__learningFixture.calls.filter(call => call.command === 'import_local_media').length)).toBe(3);
  });
}
