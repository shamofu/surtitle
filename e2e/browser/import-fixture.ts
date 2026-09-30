// SPDX-License-Identifier: GPL-3.0-or-later
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

export type ImportFixtureWindow = typeof window & {
  __importDrop: (event: string, paths?: string[]) => void;
  __learningFixture: {
    calls: { command: string; args: Record<string, any> }[];
    call: (command: string, args?: Record<string, any>) => Promise<unknown>;
  };
};

export const importPaths = [
  'C:/学習用の動画/海岸沿いの散歩と長いタイトルの日本語レッスン/字幕付きの会話練習ファイル.mp4',
  'C:/lesson-2.mp4',
  'C:/notes.txt',
];

export async function importFixture(page: Page, locale: 'ja' | 'en', theme: 'light' | 'dark') {
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

export async function drop(page: Page, paths: string[]) {
  await page.evaluate(paths => (window as ImportFixtureWindow).__importDrop('tauri://drag-drop', paths), paths);
}
