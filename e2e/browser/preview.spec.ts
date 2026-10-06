// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AppSettings, ToolStatus } from '../../src/shared/contracts/settings';
import type { AppSnapshot } from '../../src/shared/contracts/snapshot';
import { installLearningFixture } from './learning-fixture';

const candidatePath = 'C:/学習環境/動画処理ツールを置いている長いフォルダー名/ffmpeg-stable/bin/ffmpeg.exe';

async function settingsFixture(page: Page, locale: 'ja' | 'en', theme: 'light' | 'dark') {
  await installLearningFixture(page, locale, theme);
  // Reuse the test-only transport. This exercises the settings UI without
  // introducing native state or provider requests in the ordinary preview.
  const install = ({ candidatePath }: { candidatePath: string }) => {
    const fixture = (window as typeof window & {
      __learningFixture: {
        calls: { command: string; args: Record<string, any> }[];
        call: (command: string, args?: Record<string, any>) => Promise<unknown>;
      };
    }).__learningFixture;
    const original = fixture.call.bind(fixture);
    let saved: Partial<AppSettings> = {
      vertexProject: 'json-imported-project', credentialConfigured: true,
      monthlyBudgetUsd: 10, dailyBudgetUsd: 10, perJobBudgetUsd: 10,
      ytDlpChannel: 'stable',
    };
    let tool: ToolStatus = {
      id: 'ffmpeg', name: 'FFmpeg', provider: 'managed', status: 'missing', canRollback: false,
    };
    fixture.call = async (command, args = {}) => {
      if (command === 'get_app_snapshot') {
        const snapshot = await original(command, args) as AppSnapshot;
        return { ...snapshot, settings: { ...snapshot.settings, ...saved }, tools: [tool],
          budget: { spentUsd: 1, reservedUsd: 0.5, limitUsd: saved.monthlyBudgetUsd ?? 10 } };
      }
      if (['scan_external_tools', 'list_vertex_models', 'update_settings', 'set_tool_provider'].includes(command)) {
        fixture.calls.push({ command, args });
        if (command === 'scan_external_tools') return [{
          toolId: 'ffmpeg', path: candidatePath, selectable: true, verification: 'unverified', reason: null,
        }];
        if (command === 'list_vertex_models') return [{
          id: 'gemini-shared-fixture', displayName: 'Shared fixture model', launchStage: 'GA',
        }];
        if (command === 'update_settings') { saved = structuredClone(args.settings); return; }
        tool = { ...tool, provider: args.request.provider, path: args.request.path, status: 'ready', version: '8.0' };
        return;
      }
      return original(command, args);
    };
  };
  // Configure before the first native call so the query cache starts with the
  // settings fixture, independently of the order of browser init scripts.
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript',
    body: `let configured = false; const install = ${install.toString()};
      export const nativeAvailable = () => true;
      export const call = (command, args) => {
        if (!configured) { install(${JSON.stringify({ candidatePath })}); configured = true; }
        return window.__learningFixture.call(command, args);
      };`,
  }));
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: locale === 'ja' ? '設定' : 'Settings', exact: true })).toBeVisible();
}

test('browser preview clearly separates UI from the native service', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('ブラウザーで UI をプレビュー中です。', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ライブラリ', exact: true })).toBeVisible();
  await expect(page.locator('.media-card')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('library-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  const prevented = await page.locator('.library-page').evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['preview'], 'movie.mp4', { type: 'video/mp4' }));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.getByText('Open Surtitle desktop to use this feature.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('library-light.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Add video or audio', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to library', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Choose a video or audio file', exact: false }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Open Surtitle desktop to use this feature.');
  await page.screenshot({ path: testInfo.outputPath('import-dialog.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.media-card')).toHaveCount(0);
});

test('settings stay readable at compact width and cannot save fabricated state', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '変更を保存' }).first()).toBeDisabled();
  await page.getByLabel('1か月のAI予算（USD）', { exact: false }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('1か月のAI予算（USD）', { exact: false })).toHaveValue('0');
  await expect(page.getByRole('button', { name: '変更を保存' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-compact.png'), fullPage: true, animations: 'disabled' });
});

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1440, height: 900 }, { width: 800, height: 700 }]) {
    test(`settings controls and persistent save ${locale} ${theme} ${size.width}x${size.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await settingsFixture(page, locale, theme);
      const save = page.getByRole('button', { name: locale === 'ja' ? '変更を保存' : 'Save changes', exact: true });
      const scroll = page.locator('.settings-layout');
      const capture = async (name: string) => {
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(save).toBeInViewport();
        expect(await save.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' });
      };
      await expect(save).toBeDisabled();
      await capture('learning');
      const project = page.getByRole('textbox', { name: locale === 'ja' ? /^プロジェクト ID/ : /^Project ID/ });
      await project.scrollIntoViewIfNeeded();
      await expect(project).toHaveValue('json-imported-project');
      await expect(project).toHaveAttribute('readonly', '');
      await capture('credentials');
      const fetch = page.getByRole('button', { name: locale === 'ja' ? 'Vertexからモデル候補を取得' : 'Fetch Vertex model candidates', exact: true });
      await expect(fetch).toHaveCount(1);
      await fetch.click();
      await expect(page.locator('.model-editor datalist option[value="gemini-shared-fixture"]')).toHaveCount(4);
      expect(await page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => call.command === 'list_vertex_models').length)).toBe(1);
      await capture('models');
      const detailedModels = page.locator('#ai-models > details');
      await detailedModels.locator('summary').filter({ hasText: locale === 'ja' ? '用途ごとの詳細設定' : 'Detailed settings by purpose' }).click();
      await expect(detailedModels).toHaveAttribute('open', '');
      const transcription = detailedModels.locator('.model-preference').filter({
        has: page.getByRole('heading', { name: locale === 'ja' ? '文字起こし' : 'Transcription', exact: true }),
      });
      await transcription.scrollIntoViewIfNeeded();
      await capture('transcription');
      const outputLimit = transcription.getByRole('combobox', { name: locale === 'ja' ? /^回答の長さの上限/ : /^Output limit/ });
      await outputLimit.selectOption('custom');
      const tokens = transcription.getByRole('spinbutton', { name: locale === 'ja' ? /^1要求の出力トークン上限/ : /^Maximum output tokens/ });
      await tokens.fill('131072');
      await tokens.scrollIntoViewIfNeeded();
      await capture('custom-output');
      await outputLimit.selectOption('standard');
      const vocabulary = detailedModels.locator('.model-preference').filter({
        has: page.getByRole('heading', { name: locale === 'ja' ? '語彙・イディオム' : 'Vocabulary & idioms', exact: true }),
      });
      await vocabulary.getByRole('combobox', { name: /^GeminiモデルID|^Gemini model ID/ }).fill('gemini-shared-fixture');
      await expect(save).toBeEnabled();
      const monthly = page.getByRole('spinbutton', { name: locale === 'ja' ? /^1か月のAI予算/ : /^Monthly AI budget/ });
      await monthly.fill('20');
      await capture('budget-unsaved');
      await save.press('Enter');
      await expect(save).toBeDisabled();
      await expect(page.locator('.settings-save [role="status"]')).toHaveText(locale === 'ja' ? '設定は保存済みです' : 'Settings are saved');
      const ffmpeg = page.locator('.tool-row').filter({ has: page.getByRole('heading', { name: /FFmpeg/ }) });
      await ffmpeg.getByRole('button', { name: locale === 'ja' ? '外部を使う' : 'External', exact: true }).click();
      const select = ffmpeg.getByRole('button', { name: `${locale === 'ja' ? '候補を選択' : 'Select candidate'} ${candidatePath}`, exact: true });
      await select.press('Space');
      await expect(select).toHaveAttribute('aria-pressed', 'true');
      const path = ffmpeg.getByRole('textbox', { name: locale === 'ja' ? /^使用する実行ファイルの絶対パス/ : /^Absolute executable path/ });
      await expect(path).toHaveValue(candidatePath);
      await path.scrollIntoViewIfNeeded();
      await capture('external-tool-selected');
      const candidate = ffmpeg.locator('.tool-candidate');
      const selectRect = await select.boundingBox();
      const candidateRect = await candidate.boundingBox();
      expect(selectRect!.x + selectRect!.width).toBeLessThanOrEqual(candidateRect!.x + candidateRect!.width);
      await ffmpeg.getByRole('button', { name: locale === 'ja' ? '検証してこのパスを使用' : 'Verify and use this path', exact: true }).click();
      await expect(ffmpeg.locator('.external-picker')).toHaveCount(0);
      await expect(ffmpeg.locator('.tool-current-path code')).toHaveText(candidatePath);
      await expect(save).toBeDisabled();
      await capture('external-tool-applied');
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await capture('bottom');
      const saved = await page.evaluate(() => (window as any).__learningFixture.calls.find((call: any) => call.command === 'update_settings').args.settings);
      expect(saved).toMatchObject({ monthlyBudgetUsd: 20, dailyBudgetUsd: 20, perJobBudgetUsd: 20,
        vertexProject: 'json-imported-project', aiModels: { vocabulary: { modelId: 'gemini-shared-fixture' } } });
    });
  }
}
