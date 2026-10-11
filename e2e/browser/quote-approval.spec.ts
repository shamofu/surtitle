// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function installExpiredQuoteFixture(page: Page, locale: 'ja' | 'en', entry: 'new' | 'retry') {
  await installLearningFixture(page, locale, locale === 'ja' ? 'light' : 'dark');
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      let estimates = 0;
      export const nativeAvailable = () => true;
      export const call = async (command, args = {}) => {
        const fixture = window.__learningFixture;
        if (command === 'get_app_snapshot') {
          const snapshot = await fixture.call(command, args);
          Object.assign(snapshot.settings, { credentialConfigured: true, vertexProject: 'project',
            aiModels: { vocabulary: { modelId: 'fixture-model', maxOutputTokens: 4096 } } });
          snapshot.jobs = ${JSON.stringify(entry)} === 'retry' ? [{ id: 'retry-job', mediaId: 'visual-fixture',
            kind: 'vocabulary', status: 'failed', progress: .5, createdAt: '2026-10-11T00:00:00Z' }] : [];
          return snapshot;
        }
        if (['create_quote', 'create_retry_quote', 'review_ai_job'].includes(command)) {
          fixture.calls.push({ command, args });
          ++estimates;
          return { id: 'quote-' + estimates, mediaId: 'visual-fixture', kind: 'vocabulary', model: 'fixture-model',
            digest: 'scope-' + estimates, startMs: 0, endMs: 840000, unpriced: true, estimatedUsd: null,
            maximumUsd: null, inputTokens: 100, maxOutputTokens: 4096, requestCount: 1, totalOutputTokens: 4096,
            expiresAt: estimates === 1 ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
            warnings: [], canApprove: true, isRetry: ${JSON.stringify(entry)} === 'retry' };
        }
        if (['approve_quote', 'reapprove_quote'].includes(command)) {
          fixture.calls.push({ command, args });
          return;
        }
        return fixture.call(command, args);
      };`,
  }));
}

for (const locale of ['ja', 'en'] as const) {
  for (const entry of ['new', 'retry'] as const) {
    test(`expired unpriced ${entry} quote requires refresh and a fresh explicit approval ${locale}`, async ({ page }, testInfo) => {
      const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
      await page.setViewportSize({ width: 1024, height: 700 });
      await installExpiredQuoteFixture(page, locale, entry);
      await page.goto('/study/visual-fixture');
      if (entry === 'new') {
        await page.getByRole('button', { name: text('字幕一覧', 'Transcript'), exact: true }).click();
        await page.getByRole('tab', { name: text('AI の提案', 'Suggestions'), exact: true }).click();
        await page.getByRole('button', { name: text('AIで語彙・表現を調べる', 'Explore words with AI'), exact: true }).click();
        await page.getByRole('button', { name: text('見積もりを確認', 'Review estimate'), exact: true }).click();
      } else {
        await page.getByRole('button', { name: text('残りを再見積もり', 'Estimate remaining work'), exact: true }).click();
      }
      const dialog = page.getByRole('dialog');
      const checkbox = dialog.getByRole('checkbox', { name: text(
        '料金と品質が未確認であることを理解し、この範囲・要求数・音声時間・出力設定で今回の実行を承認します。',
        'I understand that pricing and quality are unverified and approve this job for the displayed scope, request count, audio duration, and output settings.',
      ), exact: true });
      const approve = dialog.getByRole('button', { name: text('この実行を承認する', 'Approve this job'), exact: true });
      const warning = text('見積もりの有効期限が切れたため、承認できません。見積もりを更新してください。', 'This quote has expired, so approval is disabled. Refresh the estimate to continue.');
      await expect(checkbox).toBeDisabled();
      await expect(checkbox).not.toBeChecked();
      await expect(approve).toBeDisabled();
      await expect(dialog.getByText(warning, { exact: true })).toBeVisible();
      const refresh = dialog.getByRole('button', { name: text('見積もりを更新', 'Refresh estimate'), exact: true });
      await expect(refresh).toHaveCount(1);
      await expect(refresh).toBeEnabled();
      await expect(checkbox).toHaveAccessibleDescription(warning);
      await expect(checkbox.locator('..')).toHaveAttribute('data-disabled', 'true');
      const disabledAppearance = await checkbox.locator('..').evaluate(element => {
        const style = getComputedStyle(element);
        return { color: style.color, opacity: style.opacity };
      });
      const sends = () => page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => ['approve_quote', 'reapprove_quote'].includes(call.command)));
      expect(await sends()).toHaveLength(0);
      await checkbox.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`expired-${entry}-${locale}.png`), animations: 'disabled' });

      await refresh.click();
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox.locator('..')).not.toHaveAttribute('data-disabled', 'true');
      await expect(approve).toBeDisabled();
      await expect(dialog.getByText(warning, { exact: true })).toHaveCount(0);
      const enabledAppearance = await checkbox.locator('..').evaluate(element => {
        const style = getComputedStyle(element);
        return { color: style.color, opacity: style.opacity };
      });
      expect(disabledAppearance).not.toEqual(enabledAppearance);
      expect(await sends()).toHaveLength(0);
      await checkbox.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`refreshed-${entry}-${locale}.png`), animations: 'disabled' });

      await checkbox.click();
      await expect(checkbox).toBeChecked();
      await expect(approve).toBeEnabled();
      await checkbox.locator('..').locator('span').click();
      await expect(checkbox).not.toBeChecked();
      await expect(approve).toBeDisabled();
      await checkbox.focus();
      await page.keyboard.press('Space');
      await expect(checkbox).toBeChecked();
      await expect(approve).toBeEnabled();
      expect(await sends()).toHaveLength(0);
      await approve.click();
      await expect(dialog).toHaveCount(0);
      expect(await sends()).toHaveLength(1);
      expect((await sends())[0]).toMatchObject({ command: entry === 'retry' ? 'reapprove_quote' : 'approve_quote', args: {
        quoteId: 'quote-2', digest: 'scope-2', acknowledgeUnpriced: true,
      } });
    });
  }
}
