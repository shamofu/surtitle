// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

type ImportFixtureWindow = Window & {
  __importDrop: (event: string, paths?: string[]) => void;
  __learningFixture: {
    calls: { command: string; args: Record<string, any> }[];
    call: (command: string, args?: Record<string, any>) => Promise<unknown>;
  };
};

async function importFixture(page: Page, locale: 'ja' | 'en', theme: 'light' | 'dark') {
  await installLearningFixture(page, locale, theme);
  // Explicit test-only native event injection. It does not claim to exercise
  // Explorer drag delivery, nor does it enable importing in browser preview.
  await page.route(/\/src\/shared\/native\/events\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript',
    body: `const listeners = new Map();
      window.__importDrop = (event, paths = []) => listeners.get(event)?.forEach(callback => callback({payload: {paths}}));
      export const subscribeNative = (event, callback) => {
        const entries = listeners.get(event) || new Set(); listeners.set(event, entries); entries.add(callback);
        return () => entries.delete(callback);
      };`,
  }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: locale === 'ja' ? 'ライブラリ' : 'Library', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as ImportFixtureWindow).__learningFixture;
    const original = fixture.call.bind(fixture);
    let firstFailure = true;
    const imported = new Map<string, string>();
    fixture.call = async (command, args = {}) => {
      if (!['validate_media_files', 'import_local_media', 'select_media_files'].includes(command)) return original(command, args);
      fixture.calls.push({ command, args });
      if (command === 'select_media_files') return [];
      if (command === 'validate_media_files') return args.paths.map((inputPath: string) => {
        if (inputPath.endsWith('.txt')) return { inputPath, status: 'invalid', reason: 'unsupported' };
        const canonicalPath = inputPath.toLowerCase();
        const mediaId = imported.get(canonicalPath);
        return mediaId ? { inputPath, canonicalPath, status: 'existing', mediaId } : { inputPath, canonicalPath, status: 'ready' };
      });
      if (args.request.pathOrUrl.endsWith('lesson-2.mp4') && firstFailure) {
        firstFailure = false;
        throw new Error('Could not read lesson-2.mp4. Try again.');
      }
      const mediaId = `imported-${imported.size + 1}`;
      imported.set(args.request.pathOrUrl.toLowerCase(), mediaId);
      return { mediaId, created: true };
    };
  });
}

async function drop(page: Page, paths: string[]) {
  await page.evaluate(paths => (window as ImportFixtureWindow).__importDrop('tauri://drag-drop', paths), paths);
}

for (const [locale, theme] of [['en', 'dark'], ['ja', 'light']] as const) {
  test(`import queue stays readable and recovers partial failures in ${locale} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await importFixture(page, locale, theme);
    const paths = ['C:/学習用の動画/海岸沿いの散歩と長いタイトルの日本語レッスン/字幕付きの会話練習ファイル.mp4', 'C:/lesson-2.mp4', 'C:/notes.txt'];
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
