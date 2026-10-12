// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function reachable(control: Locator) {
  await expect(control).toBeEnabled();
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect.poll(() => control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('.page-content').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(page.getByText('Unimplemented visual-test command:', { exact: false })).toHaveCount(0);
}
async function speedAdjustmentKeepsReadingVisible(page: Page, label: string, caption: Locator) {
  const trigger = page.getByRole('button', { name: label, exact: true });
  await reachable(trigger);
  const layout = () => page.evaluate(() => {
    const rect = (selector: string) => {
      const bounds = document.querySelector(selector)!.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const rate = document.querySelector<HTMLButtonElement>('.playback-rate-trigger')!;
    return { row: rect('.player-control-row'), caption: rect('.current-caption'), text: rect('.current-caption-text'),
      rateWidth: rate.offsetWidth, rateHeight: rate.offsetHeight };
  });
  const before = await layout();
  expect(before.row.height).toBe(40);
  expect(before.rateHeight).toBe(40);
  await trigger.click();
  const slider = page.getByRole('slider', { name: label, exact: true });
  await expect(slider).toBeFocused();
  await slider.press('Home');
  await expect(slider).toHaveValue('0.25');
  await expect.poll(layout).toEqual(before);
  await expect(caption).toBeInViewport({ ratio: 1 });
  for (const [name, value] of [['0.75', '0.75'], ['1.25', '1.25'], ['3.0', '3']]) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(slider).toHaveValue(value);
    await expect.poll(layout).toEqual(before);
    await expect(caption).toBeInViewport({ ratio: 1 });
  }
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue('2.95');
  await expect.poll(layout).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('.playback-rate-popover')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText('2.95×');
  await expect.poll(layout).toEqual(before);
  await expect(caption).toBeInViewport({ ratio: 1 });
}

for (const size of [{ width: 640, height: 360 }, { width: 800, height: 600 }, { width: 1024, height: 700 }]) {
  for (const locale of ['ja', 'en'] as const) {
    const t = (ja: string, en: string) => locale === 'ja' ? ja : en;
    test(`library and complete settings fields remain reachable at ${size.width}x${size.height} ${locale}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installLearningFixture(page, locale, locale === 'ja' ? 'light' : 'dark');
      await page.goto('/');
      await reachable(page.getByRole('button', { name: t('動画・音声を追加する', 'Add video or audio'), exact: true }));
      await noOverflow(page);
      const search = page.getByRole('textbox', { name: t('ライブラリを検索', 'Search your library') });
      await search.scrollIntoViewIfNeeded();
      await reachable(search);
      await page.goto('/settings');
      const language = page.getByRole('combobox', { name: t('学習する言語', 'Learning language'), exact: true });
      await expect(language).toBeEnabled();
      await language.focus();
      const field = page.locator('label.field').filter({ has: language });
      await expect(field).toBeInViewport({ ratio: 1 });
      await expect(field.locator('small')).toBeInViewport({ ratio: 1 });
      await reachable(language);
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath('settings-language.png'), animations: 'disabled' });
      const footer = page.locator('.settings-save');
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toBeInViewport({ ratio: 1 });
      await expect(footer).toContainText(t('変更は自動保存されます', 'Changes save automatically'));
      await noOverflow(page);
    });

    test(`study controls and the opened transcript remain reachable at ${size.width}x${size.height} ${locale}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await installLearningFixture(page, locale, locale === 'ja' ? 'light' : 'dark');
      await page.goto('/study/visual-fixture');
      const play = page.getByRole('button', { name: t('再生', 'Play'), exact: true });
      await reachable(play);
      const caption = page.getByRole('region', { name: t('いまの字幕', 'Current subtitle'), exact: true });
      await expect(caption).toBeInViewport({ ratio: 1 });
      await reachable(page.getByRole('button', { name: t('意味を調べる', 'Explore meaning'), exact: true }));
      if (size.width === 640) await speedAdjustmentKeepsReadingVisible(page, t('再生速度', 'Playback speed'), caption);
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath('study.png'), animations: 'disabled' });
      const toggle = page.getByRole('button', { name: t('字幕一覧', 'Transcript'), exact: true });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const search = page.getByRole('textbox', { name: t('字幕を検索', 'Search transcript') });
      await reachable(search);
      await expect(page.locator('.companion-heading')).toBeInViewport({ ratio: 1 });
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath('transcript.png'), animations: 'disabled' });
      const follow = page.locator('.transcript-footer button');
      await follow.scrollIntoViewIfNeeded();
      await reachable(follow);
      const close = page.getByRole('button', { name: t('パネルを閉じる', 'Close panel'), exact: true });
      await close.click();
      await expect(page.locator('.study-companion')).toBeHidden();
      await expect(toggle).toBeFocused();
      await reachable(toggle);
      await noOverflow(page);
    });
  }
}

// Browser DPR emulation verifies CSS geometry and rendered pixels; it does not
// verify physical Windows monitor scaling or native HWND placement.
for (const deviceScaleFactor of [1, 1.5, 2]) {
  for (const viewport of [{ width: 640, height: 360 }, { width: 1024, height: 700 }]) {
    test(`browser DPR ${deviceScaleFactor} preserves compact geometry at ${viewport.width}x${viewport.height}`, async ({ browser, baseURL }, testInfo) => {
      const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await installLearningFixture(page, 'en', 'dark');
        await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
          contentType: 'application/javascript', body: `
            export const nativeAvailable = () => true;
            export const call = (command, args) => {
              if (command === 'player_control' && args.request?.action === 'bounds') window.__lastNativeBounds = args.request.bounds;
              return window.__learningFixture.call(command, args);
            };`,
        }));
        await page.goto('/');
        await reachable(page.getByRole('button', { name: 'Add video or audio', exact: true }));
        await noOverflow(page);
        await page.goto('/settings');
        const language = page.getByRole('combobox', { name: 'Learning language', exact: true });
        await language.focus();
        await reachable(language);
        await expect(page.locator('label.field').filter({ has: language })).toBeInViewport({ ratio: 1 });
        await page.locator('.settings-save').scrollIntoViewIfNeeded();
        await expect(page.locator('.settings-save')).toBeInViewport({ ratio: 1 });
        await noOverflow(page);
        await page.goto('/study/visual-fixture');
        await reachable(page.getByRole('button', { name: 'Play', exact: true }));
        await expect(page.getByRole('region', { name: 'Current subtitle', exact: true })).toBeInViewport({ ratio: 1 });
        await reachable(page.getByRole('button', { name: 'Explore meaning', exact: true }));
        if (viewport.width === 640) await speedAdjustmentKeepsReadingVisible(page, 'Playback speed', page.getByRole('region', { name: 'Current subtitle', exact: true }));
        await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
        const geometry = await page.evaluate(() => {
          const rect = document.querySelector('.native-player-viewport')!.getBoundingClientRect();
          return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
            cssWidth: rect.width, cssHeight: rect.height, native: (window as any).__lastNativeBounds };
        });
        expect(geometry).toMatchObject({ width: viewport.width, height: viewport.height, dpr: deviceScaleFactor,
          native: { scaleFactor: deviceScaleFactor } });
        expect(geometry.native.width).toBeCloseTo(geometry.cssWidth, 1);
        expect(geometry.native.height).toBeCloseTo(geometry.cssHeight, 1);
        const pixels = await page.screenshot({ path: testInfo.outputPath('study-dpr.png'), animations: 'disabled', scale: 'device' });
        expect(pixels.readUInt32BE(16)).toBe(Math.round(viewport.width * deviceScaleFactor));
        expect(pixels.readUInt32BE(20)).toBe(Math.round(viewport.height * deviceScaleFactor));
        await page.getByRole('button', { name: 'Transcript', exact: true }).click();
        await reachable(page.getByRole('textbox', { name: 'Search transcript', exact: true }));
        await expect(page.locator('.companion-heading')).toBeInViewport({ ratio: 1 });
        await noOverflow(page);
      } finally {
        await context.close();
      }
    });
  }
}
