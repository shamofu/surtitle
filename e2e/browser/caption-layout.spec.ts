// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

const shortSource = 'A short subtitle.';
const longSource = 'Follow the winding path along the coast and listen to the waves. '.repeat(40);
const longTranslation = '海岸に沿った曲がりくねった小道を進み、波の音に耳を澄ませます。'.repeat(60);
const controls = ['.current-caption', '.caption-actions', '.caption-navigation', '.caption-navigation button', '.player-controls'];

// Capture every frame, including the translation's entry/exit animation, rather than only its final layout.
async function expectStableControls(page: Page, action: { click: string } | { cue: number }, selectors = controls) {
  const movement = await page.evaluate(async ({ action, selectors }) => {
    const read = () => selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { selector, bounds: [x, y, width, height] };
    }));
    const before = read();
    if ('click' in action) (document.querySelector(action.click) as HTMLButtonElement).click();
    else await (window as any).__learningFixture.call('player_control', {
      request: { action: 'seek', value: action.cue * 7000 + 100 },
    });
    const maximum = before.map(item => ({ selector: item.selector, delta: 0 }));
    for (let frame = 0; frame < 36; frame += 1) {
      await new Promise(requestAnimationFrame);
      const current = read();
      if (current.length !== before.length) throw new Error('Fixed controls were added or removed');
      current.forEach((item, index) => {
        maximum[index].delta = Math.max(maximum[index].delta,
          ...item.bounds.map((value, axis) => Math.abs(value - before[index].bounds[axis])));
      });
    }
    return maximum;
  }, { action, selectors });
  expect(movement.length).toBeGreaterThan(0);
  for (const item of movement) expect(item.delta, `${item.selector} moved during content change`).toBeLessThan(1);
}

for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 800, height: 900 }]) {
  test(`caption controls stay fixed with independently scrolling source and translation at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installLearningFixture(page, 'en', 'light', { segmentOverrides: {
      10: { text: shortSource }, 11: { text: longSource, translation: longTranslation },
    } });
    await page.goto('/study/visual-fixture');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.current-caption-text')).toHaveText(shortSource);
    if (size.width >= 1000) {
      await page.getByRole('button', { name: 'Transcript', exact: true }).click();
      await expect(page.locator('.transcript-scroll')).toBeVisible();
    }
    const source = page.locator('.caption-source-scroll');
    const translation = page.locator('.caption-translation-scroll');
    const toggle = '.caption-actions button[aria-pressed]';
    const closedHeight = await source.evaluate(element => element.clientHeight);

    await expectStableControls(page, { click: toggle });
    await expect(page.locator(toggle)).toHaveAttribute('aria-pressed', 'true');
    await expect(translation).toBeVisible();
    const [sourceBounds, translationBounds] = await Promise.all([source.boundingBox(), translation.boundingBox()]);
    expect(Math.abs(sourceBounds!.height - translationBounds!.height)).toBeLessThan(2);
    expect(sourceBounds!.y + sourceBounds!.height).toBeLessThanOrEqual(translationBounds!.y + 1);
    expect(sourceBounds!.height).toBeLessThan(closedHeight);
    if (size.width === 1024) await page.screenshot({ path: testInfo.outputPath('caption-short.png'), animations: 'disabled' });

    await expectStableControls(page, { cue: 11 });
    await expect(page.locator('.current-caption-text')).toHaveText(longSource.trim());
    if (size.width === 1024) await page.screenshot({ path: testInfo.outputPath('caption-long.png'), animations: 'disabled' });
    for (const region of [source, translation]) {
      expect(await region.evaluate(element => ({
        overflow: getComputedStyle(element).overflowY, scrollable: element.scrollHeight > element.clientHeight,
      }))).toEqual({ overflow: 'auto', scrollable: true });
    }
    await source.evaluate(element => { element.scrollTop = 80; });
    expect(await source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await translation.evaluate(element => element.scrollTop)).toBe(0);
    await translation.evaluate(element => { element.scrollTop = 60; });
    expect(await translation.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await source.evaluate(element => element.scrollTop)).toBe(80);
    for (const selector of controls.slice(1)) await expect(page.locator(selector).first()).toBeInViewport();

    await expectStableControls(page, { cue: 10 });
    expect(await source.evaluate(element => element.scrollTop)).toBe(0);
    expect(await translation.evaluate(element => element.scrollTop)).toBe(0);
    await expectStableControls(page, { cue: 11 });

    await expectStableControls(page, { click: toggle });
    await expect(page.locator(toggle)).toHaveAttribute('aria-pressed', 'false');
    await expect(translation).toBeHidden();
    expect(await source.evaluate(element => element.clientHeight)).toBe(closedHeight);
    await expectStableControls(page, { cue: 10 });
    await expect(page.locator('.current-caption-text')).toHaveText(shortSource);
    await expectStableControls(page, { click: toggle });
    await expect(page.locator(toggle)).toHaveAttribute('aria-pressed', 'true');
  });
}

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }]) {
    test(`marked filter stays contained and transcript chrome stays fixed ${locale} ${theme} ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await installLearningFixture(page, locale, theme, { segmentOverrides: {
        10: { status: 'generated_review' }, 11: { text: longSource, translation: longTranslation },
      } });
      await page.goto('/study/visual-fixture');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
      const filter = page.getByRole('checkbox', { name: locale === 'ja' ? '注意のある箇所だけ表示' : 'Show marked passages only' });
      await expect(filter).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.locator('.transcript-marked-filter').click();
      await expect(filter).toBeChecked();
      await expect(page.locator('.transcript-row')).toHaveCount(1);
      await filter.focus();
      await filter.press('Space');
      await expect(filter).not.toBeChecked();
      await expect(filter).toBeFocused();
      await expect.poll(() => page.locator('.transcript-row').count()).toBeGreaterThan(1);
      expect(await page.locator('.transcript-row').count()).toBeLessThan(50);

      const containment = await filter.evaluate(element => {
        const label = element.closest('label')!;
        const panel = element.closest('.study-companion')!.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const outline = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
        const range = document.createRange();
        range.selectNodeContents(label);
        return {
          checkbox: bounds.width >= 14 && bounds.height >= 14,
          focus: bounds.left - outline >= panel.left && bounds.right + outline <= panel.right
            && bounds.top - outline >= panel.top && bounds.bottom + outline <= panel.bottom,
          label: [...range.getClientRects()].every(rect => rect.left >= panel.left && rect.right <= panel.right),
          noHorizontalScroll: label.scrollWidth <= label.clientWidth,
        };
      });
      expect(containment).toEqual({ checkbox: true, focus: true, label: true, noHorizontalScroll: true });
      const chrome = ['.transcript-tools', '.transcript-marked-filter', '.transcript-footer', ...controls];
      const transcriptToggle = '.transcript-tools button[aria-pressed]';
      const wasShowing = await page.locator(transcriptToggle).getAttribute('aria-pressed');
      await expectStableControls(page, { click: transcriptToggle }, chrome);
      await expect(page.locator(transcriptToggle)).toHaveAttribute('aria-pressed', wasShowing === 'true' ? 'false' : 'true');
      await expectStableControls(page, { click: transcriptToggle }, chrome);
      await expect(page.locator(transcriptToggle)).toHaveAttribute('aria-pressed', wasShowing!);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
