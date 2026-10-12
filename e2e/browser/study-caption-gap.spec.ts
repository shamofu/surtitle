// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

const reviewText = 'Review this passage while the audio continues.';
const previewText = 'The next passage is ready to preview.';

async function installGaps(page: Page, locale: 'ja' | 'en' = 'en', longText = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, locale, 'light', { segmentCount: 12, segmentOverrides: {
    0: { startMs: 1000, endMs: 2000, text: 'The first timed passage.' },
    10: { endMs: 71000, text: longText ? reviewText.repeat(35) : reviewText, translation: '前の字幕の訳' },
    11: { startMs: 80000, endMs: 81000, text: longText ? previewText.repeat(35) : previewText, translation: '次の字幕の訳' },
  } });
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('slider', { name: locale === 'ja' ? '再生位置' : 'Playback position' })).toBeEnabled();
}

async function seek(page: Page, position: number) {
  await page.evaluate(value => (window as any).__learningFixture.call('player_control', { request: { action: 'seek', value } }), position);
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue(String(position));
}

async function setGapMode(page: Page, mode: 'review' | 'preview', locale: 'ja' | 'en' = 'en') {
  const label = locale === 'ja' ? '再生設定' : 'Playback settings';
  await page.getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label, exact: true });
  await dialog.getByLabel(locale === 'ja' ? '字幕のない間' : 'Between captions').selectOption(mode);
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.snapshot.settings.captionGapMode)).toBe(mode);
  await dialog.getByRole('button', { name: locale === 'ja' ? '閉じる' : 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('gap mode persists and meaning, translation and replay use the displayed passage', async ({ page }) => {
  await installGaps(page);
  const caption = page.locator('.current-caption');
  await expect(caption.locator('.current-caption-text')).toHaveText(reviewText);
  await expect(caption).toContainText('Review the previous subtitle');
  await expect(caption).toContainText('Next subtitle 1:20');
  await caption.getByRole('button', { name: 'Show translation', exact: true }).click();
  await expect(caption.locator('.caption-translation')).toHaveText('前の字幕の訳');
  await caption.getByRole('button', { name: 'Replay this subtitle', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.calls
    .filter((call: any) => call.command === 'player_control' && call.args.request.action === 'source-seek').at(-1)?.args.request))
    .toEqual({ action: 'source-seek', startMs: 70000, endMs: 71000 });
  await seek(page, 76000);
  await setGapMode(page, 'preview');
  await expect(caption.locator('.current-caption-text')).toHaveText(previewText);
  await expect(caption.locator('.caption-translation')).toHaveText('次の字幕の訳');
  await caption.getByRole('button', { name: 'Explore meaning', exact: true }).click();
  await expect(page.locator('.phrase-inspector .context-sentence')).toHaveText(previewText);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await seek(page, 76000);
  await caption.getByRole('button', { name: 'Play this subtitle', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.calls
    .filter((call: any) => call.command === 'player_control' && call.args.request.action === 'source-seek').at(-1)?.args.request))
    .toEqual({ action: 'source-seek', startMs: 80000, endMs: 81000 });
  await page.reload();
  await expect(caption.locator('.current-caption-text')).toHaveText(previewText);
  await expect(caption).toContainText('Preview the next subtitle');
  await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Playback settings', exact: true }).getByLabel('Between captions')).toHaveValue('preview');
});

for (const locale of ['en', 'ja'] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 920, height: 620 }]) {
    test(`caption controls keep their bounds across preview, active and review with long text ${locale} ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installGaps(page, locale, true);
      await setGapMode(page, 'preview', locale);
      const caption = page.locator('.current-caption');
      const play = locale === 'ja' ? 'この字幕を再生' : 'Play this subtitle';
      const replay = locale === 'ja' ? 'この字幕をもう一度' : 'Replay this subtitle';
      await expect(caption.getByRole('button', { name: play, exact: true })).toBeEnabled();
      const selectors = '.caption-controls, .caption-actions, .caption-navigation, .caption-controls button';
      const before = await page.locator(selectors).evaluateAll(elements => elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height];
      }));
      const assertBounds = async (position: number) => {
        const deltas = await page.evaluate(async ({ position, selectors, before }) => {
          await (window as any).__learningFixture.call('player_control', { request: { action: 'seek', value: position } });
          const deltas: number[] = [];
          for (let frame = 0; frame < 18; frame++) {
            await new Promise(requestAnimationFrame);
            const elements = [...document.querySelectorAll(selectors)];
            if (elements.length !== before.length) throw new Error('Caption controls were replaced');
            elements.forEach((element, index) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              deltas.push(...[x, y, width, height].map((value, axis) => Math.abs(value - before[index][axis])));
            });
          }
          return deltas;
        }, { position, selectors, before });
        expect(Math.max(...deltas), 'caption actions and navigation retain their exact bounds').toBeLessThan(1);
      };
      await assertBounds(80000);
      await expect(caption.getByRole('button', { name: replay, exact: true })).toBeEnabled();
      await setGapMode(page, 'review', locale);
      await assertBounds(82000);
      await expect(caption).toContainText(locale === 'ja' ? '前の字幕を復習' : 'Review the previous subtitle');
      await expect(caption.getByRole('button', { name: replay, exact: true })).toBeEnabled();
    });
  }
}

test('first and last gaps retain their chosen mode and navigation follows the playback position', async ({ page }) => {
  await installGaps(page);
  const caption = page.locator('.current-caption');
  await seek(page, 0);
  await expect(caption).toContainText('The first subtitle starts at 0:01');
  await expect(caption.locator('.current-caption-text')).toHaveCount(0);
  await expect(caption.getByRole('button', { name: 'Previous subtitle', exact: true })).toBeDisabled();
  await caption.getByRole('button', { name: 'Go to first subtitle', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('1000');
  await expect(caption.locator('.current-caption-text')).toHaveText('The first timed passage.');
  await seek(page, 76000);
  await setGapMode(page, 'preview');
  await caption.getByRole('button', { name: 'Previous subtitle', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('70000');
  await expect(caption.locator('.current-caption-text')).toHaveText(reviewText);
  await seek(page, 76000);
  await caption.getByRole('button', { name: 'Next subtitle', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('80000');
  await seek(page, 82000);
  await expect(caption).toContainText('No further subtitles yet');
  await expect(caption.locator('.current-caption-text')).toHaveCount(0);
  await expect(caption.getByRole('button', { name: 'Next subtitle', exact: true })).toBeDisabled();
  await caption.getByRole('button', { name: 'Go to previous subtitle', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('80000');
});
