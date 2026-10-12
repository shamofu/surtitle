// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

const reviewText = 'Review this passage while the audio continues.';
const previewText = 'The next passage is ready to preview.';

async function installGaps(page: Page, locale: 'ja' | 'en' = 'en', longText = false, reducedMotion: 'reduce' | 'no-preference' = 'reduce') {
  await page.emulateMedia({ reducedMotion });
  await installLearningFixture(page, locale, 'light', { segmentCount: 12, segmentOverrides: {
    0: { startMs: 1000, endMs: 2000, text: 'The first timed passage.' },
    10: { endMs: 71000, text: longText ? reviewText.repeat(35) : reviewText, translation: '前の字幕の訳'.repeat(longText ? 80 : 1) },
    11: { startMs: 80000, endMs: 81000, text: longText ? previewText.repeat(35) : previewText, translation: '次の字幕の訳'.repeat(longText ? 80 : 1) },
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
  await expect(caption).toContainText('Reviewing');
  await expect(caption.locator('.caption-next-action')).toContainText('1:20');
  await expect(caption.getByRole('button', { name: 'Next subtitle', exact: true })).toHaveAccessibleDescription('Next subtitle 1:20');
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
  await expect(caption).toContainText('Previewing');
  await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Playback settings', exact: true }).getByLabel('Between captions')).toHaveValue('preview');
});

for (const locale of ['en', 'ja'] as const) {
  test(`hour-long skip timestamps never resize navigation buttons ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLearningFixture(page, locale, 'light', { segmentCount: 12, segmentOverrides: {
      10: { endMs: 71000 }, 11: { startMs: 68461000, endMs: 68462000 },
    } });
    await page.addInitScript(() => {
      const fixture = (window as any).__learningFixture;
      fixture.state.durationMs = 68463000;
      fixture.snapshot.media[0].durationMs = 68463000;
    });
    await page.goto('/study/visual-fixture');
    await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
    await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
    await setGapMode(page, 'preview', locale);
    const next = page.getByRole('button', { name: locale === 'ja' ? '次の字幕' : 'Next subtitle', exact: true });
    await expect(next).toHaveAccessibleDescription(locale === 'ja' ? '次の字幕 19:01:01' : 'Next subtitle 19:01:01');
    const note = page.locator('.caption-context-time');
    expect(await note.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const read = () => page.locator('.caption-navigation button').evaluateAll(elements => elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height];
    }));
    const before = await read();
    await next.click();
    await expect(next).toBeDisabled();
    await expect(next).toHaveAccessibleDescription(locale === 'ja' ? 'この先の字幕はまだありません' : 'No further subtitles yet');
    const after = await read();
    after.forEach((bounds, index) => bounds.forEach((value, axis) => expect(Math.abs(value - before[index][axis])).toBeLessThan(1)));
    expect(await page.evaluate(() => (window as any).__learningFixture.calls
      .filter((call: any) => call.command === 'player_control' && call.args.request.action === 'seek').at(-1).args.request.value)).toBe(68461000);
  });
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
      await expect(caption).toContainText(locale === 'ja' ? '復習中' : 'Reviewing');
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

for (const locale of ['en', 'ja'] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 920, height: 620 }, { width: 440, height: 620 }]) {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      test(`caption reading position survives gap metadata changes ${locale} ${viewport.width}x${viewport.height} ${reducedMotion}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await installGaps(page, locale, true, reducedMotion);
        if (viewport.width >= 1000) {
          await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
          await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
        }
        const caption = page.locator('.current-caption');
        await caption.getByRole('button', { name: locale === 'ja' ? '訳を表示' : 'Show translation', exact: true }).click();
        await expect(caption.locator('.caption-translation-region')).toHaveAttribute('data-open', 'true');
        const source = caption.locator('.caption-source-scroll');
        const translation = caption.locator('.caption-translation-scroll');
        await expect.poll(async () => Math.abs(await source.evaluate(element => element.clientHeight)
          - await translation.evaluate(element => element.clientHeight))).toBeLessThan(2);
        // Both language panes must contain a complete line, even beside the transcript.
        for (const [region, textSelector] of [[source, '.current-caption-text'], [translation, '.caption-translation']] as const) {
          const line = await region.evaluate((element, selector) => {
            const style = getComputedStyle(element);
            return { height: element.clientHeight, required: parseFloat(getComputedStyle(element.querySelector(selector)!).lineHeight)
              + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) };
          }, textSelector);
          expect(line.height + 1).toBeGreaterThanOrEqual(line.required);
        }
        const nextButton = caption.getByRole('button', { name: locale === 'ja' ? '次の字幕' : 'Next subtitle', exact: true });
        const note = await caption.locator('.caption-context-time').boundingBox();
        const button = await nextButton.boundingBox();
        expect(note!.y + note!.height).toBeLessThanOrEqual(button!.y + 1);
        expect(Math.abs(note!.x + note!.width / 2 - button!.x - button!.width / 2)).toBeLessThan(1);
        const panes = await Promise.all([source.boundingBox(), translation.boundingBox()]);
        const navigation = await caption.locator('.caption-navigation').boundingBox();
        expect(Math.max(...panes.map(bounds => bounds!.y + bounds!.height))).toBeLessThanOrEqual(navigation!.y + 1);

        const scrollPassage = async () => {
          await source.evaluate(element => { element.scrollTop = 80; });
          await translation.evaluate(element => { element.scrollTop = 60; });
        };
        const assertStable = async (position: number) => {
          const observed = await page.evaluate(async position => {
            const selectors = ['.caption-source-scroll', '.caption-translation-scroll', '.caption-controls', '.caption-controls button', '.caption-navigation-note'];
            const read = () => {
              const bounds = selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return [x, y, width, height];
              }));
              const paragraph = document.querySelector('.current-caption-text')!;
              const range = document.createRange();
              range.setStart(paragraph.firstChild!, 0);
              range.setEnd(paragraph.firstChild!, 1);
              const glyph = range.getBoundingClientRect();
              bounds.push([glyph.x, glyph.y, glyph.width, glyph.height]);
              return { bounds, scroll: selectors.slice(0, 2).map(selector => document.querySelector(selector)!.scrollTop) };
            };
            const before = read();
            await (window as any).__learningFixture.call('player_control', { request: { action: 'seek', value: position } });
            const frames = [];
            for (let frame = 0; frame < 24; frame++) {
              await new Promise(requestAnimationFrame);
              frames.push(read());
            }
            return { before, frames };
          }, position);
          expect(observed.before.scroll).toEqual([80, 60]);
          for (const frame of observed.frames) {
            expect(frame.scroll).toEqual(observed.before.scroll);
            expect(frame.bounds).toHaveLength(observed.before.bounds.length);
            frame.bounds.forEach((bounds, index) => bounds.forEach((value, axis) => {
              expect(Math.abs(value - observed.before.bounds[index][axis]), 'reading origin and controls stay fixed').toBeLessThan(1);
            }));
          }
        };
        await scrollPassage();
        await assertStable(70010);
        await assertStable(76000);
        await setGapMode(page, 'preview', locale);
        await expect(source).toHaveText(previewText.repeat(35));
        expect(await source.evaluate(element => element.scrollTop)).toBe(0);
        expect(await translation.evaluate(element => element.scrollTop)).toBe(0);
        await scrollPassage();
        await assertStable(80000);
        await setGapMode(page, 'review', locale);
        await assertStable(82000);
        await page.evaluate(() => (window as any).__learningFixture.call('player_control', { request: { action: 'seek', value: 70010 } }));
        await expect(source).toHaveText(reviewText.repeat(35));
        expect(await source.evaluate(element => element.scrollTop)).toBe(0);
        expect(await translation.evaluate(element => element.scrollTop)).toBe(0);
      });
    }
  }
}
