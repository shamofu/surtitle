// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function expectPrimaryControlsInside(page: Page) {
  const controls = await page.locator('.player-controls button, .player-controls select, .player-controls input, .caption-controls button').evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect();
    return { name: element.getAttribute('aria-label') || element.textContent, top: bounds.top, bottom: bounds.bottom,
      left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }));
  expect(controls.length).toBeGreaterThan(10);
  for (const control of controls) {
    expect(control.top, `${control.name} top`).toBeGreaterThanOrEqual(0);
    expect(control.bottom, `${control.name} bottom`).toBeLessThanOrEqual(control.viewportHeight);
    expect(control.left, `${control.name} left`).toBeGreaterThanOrEqual(0);
    expect(control.right, `${control.name} right`).toBeLessThanOrEqual(control.viewportWidth);
    expect(control.width).toBeGreaterThan(0);
  }
}

for (const locale of ['ja', 'en'] as const) {
  test(`short workarea retains review ratings and scrolling settings/editor access ${locale}`, async ({ page }) => {
    const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
    await page.setViewportSize({ width: 1024, height: 600 });
    await installLearningFixture(page, locale, 'light');
    await page.goto('/review');
    const reveal = page.getByRole('button', { name: text('意味を確認する', 'Reveal meaning'), exact: false });
    await expect(reveal).toBeInViewport({ ratio: 1 });
    await reveal.click();
    const ratings = page.locator('.rating-buttons button');
    await expect(ratings).toHaveCount(4);
    for (const rating of await ratings.all()) {
      await expect(rating).toBeEnabled();
      await expect(rating).toBeInViewport({ ratio: 1 });
    }
    await expect(page.locator('.review-prompt h2')).toBeInViewport({ ratio: 1 });
    await page.getByRole('link', { name: text('設定', 'Settings'), exact: true }).click();
    await expect(page.locator('.settings-nav a')).toHaveCount(6);
    const monthly = page.getByRole('textbox', { name: text('1か月のAI予算（USD）', 'Monthly AI budget (USD)'), exact: true });
    await monthly.fill('4');
    await page.locator('.settings-nav a').last().click();
    await page.locator('.settings-layout').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const lastSettingControl = page.locator('.settings-sections button, .settings-sections input, .settings-sections select').last();
    await lastSettingControl.scrollIntoViewIfNeeded();
    await expect(lastSettingControl).toBeInViewport({ ratio: 1 });
    await page.getByRole('link', { name: text('フレーズ帳', 'Phrases'), exact: true }).click();
    await page.getByRole('button', { name: text('フレーズを編集', 'Edit phrase'), exact: true }).click();
    const editor = page.getByRole('dialog');
    const meaning = editor.getByLabel(text('意味', 'Meaning'), { exact: true });
    await meaning.fill('日本語の途中入力\nSecond readable line');
    await expect(meaning).toBeInViewport({ ratio: 1 });
    const textarea = await meaning.evaluate(element => ({ height: element.clientHeight, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
    expect(textarea.height).toBeGreaterThanOrEqual(textarea.lineHeight * 2);
    const close = editor.getByRole('button', { name: text('閉じる', 'Close'), exact: true }).last();
    await close.scrollIntoViewIfNeeded();
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(editor).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const locale of ['ja', 'en'] as const) for (const height of [600, 636]) {
  test(`short workarea retains the learning controls and video ${locale} ${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height });
    await installLearningFixture(page, locale, 'dark', { segmentOverrides: { 10: {
      text: 'A longer sentence remains readable while the video keeps its own space. '.repeat(20),
      translation: '映像と操作を保ちながら、長い字幕と訳を別々に読めます。'.repeat(25),
    } } });
    await page.goto('/study/visual-fixture');
    await expect(page.locator('.current-caption-text')).toContainText('longer sentence');
    await expectPrimaryControlsInside(page);
    const video = page.getByTestId('native-player-viewport');
    const bounds = (await video.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(240);
    await page.locator('.caption-actions button[aria-pressed]').click();
    await expect(page.locator('.caption-translation-scroll')).toBeVisible();
    await expectPrimaryControlsInside(page);
    expect((await video.boundingBox())!.height).toBe(bounds.height);
    for (const area of ['.caption-source-scroll', '.caption-translation-scroll']) {
      const metrics = await page.locator(area).evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
      expect(metrics.height).toBeGreaterThanOrEqual(36);
      expect(metrics.content).toBeGreaterThan(metrics.height);
      expect(metrics.overflow).toBe('auto');
    }
    await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
    await expect(page.locator('.transcript-scroll')).toBeVisible();
    await expectPrimaryControlsInside(page);
    await page.getByRole('button', { name: locale === 'ja' ? '意味を調べる' : 'Explore meaning', exact: true }).click();
    await expect(page.locator('.phrase-panel')).toBeVisible();
    await expectPrimaryControlsInside(page);
    for (const area of ['.caption-source-scroll', '.caption-translation-scroll']) {
      const visibleLine = await page.locator(area).evaluate(element => ({ height: element.clientHeight,
        lineHeight: parseFloat(getComputedStyle(element.firstElementChild!).lineHeight) }));
      expect(visibleLine.height).toBeGreaterThanOrEqual(visibleLine.lineHeight);
    }
    await page.getByRole('button', { name: locale === 'ja' ? '再生設定' : 'Playback settings', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectPrimaryControlsInside(page);
    await page.screenshot({ path: info.outputPath('compact-study.png') });
  });
}
