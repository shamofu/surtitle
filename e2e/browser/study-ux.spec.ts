// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

type FixtureWindow = Window & {
  __learningFixture: {
    state: { positionMs: number; paused: boolean };
    calls: { command: string; args: { request?: { action: string; value?: number; startMs?: number; endMs?: number } } }[];
    requestClose: () => boolean;
    closeCount: () => number;
  };
};

async function openStudy(page: Page, locale: 'en' | 'ja' = 'en', theme: 'light' | 'dark' = 'light') {
  await installLearningFixture(page, locale, theme);
  await page.goto('/study/visual-fixture');
  await expect(page.getByRole('button', { name: locale === 'ja' ? 'この言葉を確認' : 'Inspect this phrase', exact: true })).toBeEnabled();
}

async function createDraft(page: Page, locale: 'en' | 'ja' = 'en') {
  await page.getByRole('button', { name: locale === 'ja' ? 'この言葉を確認' : 'Inspect this phrase', exact: true }).click();
  await page.getByRole('button', { name: locale === 'ja' ? 'フレーズを保存' : 'Save a phrase', exact: true }).click();
  await page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true }).fill('take a little detour');
  await page.getByLabel(locale === 'ja' ? '意味' : 'Meaning', { exact: true }).fill('少し寄り道をする');
}

test('real router keeps drafts when staying and discards only when leaving is confirmed', async ({ page }) => {
  await openStudy(page);
  await createDraft(page);
  await page.getByRole('link', { name: 'Back to library' }).click();
  await expect(page.getByRole('dialog', { name: 'You have unfinished phrases' })).toBeVisible();
  await expect(page).toHaveURL(/\/study\/visual-fixture$/);
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Word or phrase', { exact: true })).toHaveValue('take a little detour');
  await page.getByRole('button', { name: 'Continue later', exact: true }).click();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Unfinished phrases (1)', exact: true }).click();
  await page.locator('.study-phrase-draft > .button').click();
  await expect(page.getByRole('textbox', { name: 'Meaning', exact: true })).toHaveValue('少し寄り道をする');
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.requestClose())).toBe(false);
});

test('a native close request uses the same draft confirmation', async ({ page }) => {
  await openStudy(page);
  await createDraft(page);
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.requestClose())).toBe(true);
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.closeCount())).toBe(0);
  await expect(page.getByLabel('Word or phrase', { exact: true })).toHaveValue('take a little detour');
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.requestClose())).toBe(true);
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__learningFixture.closeCount())).toBe(1);
});

test('real virtualized transcript restores its search, translations and scroll after inspection', async ({ page }) => {
  await openStudy(page);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByLabel('Search transcript').fill('coast');
  await page.getByRole('button', { name: 'Toggle translations' }).click();
  const list = page.getByLabel('Subtitle list', { exact: true });
  await list.dispatchEvent('wheel', { deltaY: 1200 });
  await list.evaluate(element => { element.scrollTop = 1200; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  const index = await list.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('.transcript-row')].findIndex(row => {
      const box = row.getBoundingClientRect();
      return box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  });
  expect(index).toBeGreaterThanOrEqual(0);
  const offset = await list.evaluate(element => element.scrollTop);
  await page.locator('.transcript-row').nth(index).locator('.segment-text').click();
  await expect(page.getByRole('button', { name: 'Back to transcript', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
  await expect(page.getByRole('button', { name: 'Toggle translations' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Follow playback', exact: true })).toBeVisible();
  await expect.poll(async () => Math.abs(await list.evaluate(element => element.scrollTop) - offset)).toBeLessThan(2);
  await page.getByRole('button', { name: 'Follow playback', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('');
  await expect(page.locator('.transcript-row.playing')).toBeInViewport();
});

test('caption navigation preserves playback state and inspector input without AI calls', async ({ page }) => {
  await openStudy(page);
  await page.getByRole('button', { name: 'Next subtitle', exact: true }).click();
  expect(await page.evaluate(() => ({ ...(window as FixtureWindow).__learningFixture.state }))).toMatchObject({ positionMs: 77000, paused: true });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Previous subtitle', exact: true }).click();
  expect(await page.evaluate(() => ({ ...(window as FixtureWindow).__learningFixture.state }))).toMatchObject({ positionMs: 70000, paused: false });
  await createDraft(page);
  const original = await page.locator('.context-sentence').textContent();
  await page.getByRole('button', { name: 'Next subtitle', exact: true }).click();
  await expect(page.locator('.context-sentence')).toHaveText(original!);
  await expect(page.getByLabel('Word or phrase', { exact: true })).toHaveValue('take a little detour');
  await page.locator('.caption-navigation').getByRole('button', { name: 'Listen again', exact: true }).click();
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.filter(call => call.command === 'player_control' && call.args.request?.action === 'source-seek').at(-1)?.args.request)).toEqual({ action: 'source-seek', startMs: 77000, endMs: 84000 });
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.some(call => /quote|start_ai|approve_ai/.test(call.command)))).toBe(false);
});

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`unfinished phrases layout ${locale} ${theme} 1024x700`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await openStudy(page, locale, theme);
    await createDraft(page, locale);
    await page.getByRole('button', { name: locale === 'ja' ? 'あとで続ける' : 'Continue later', exact: true }).click();
    await page.getByRole('button', { name: locale === 'ja' ? '入力途中のフレーズ (1)' : 'Unfinished phrases (1)', exact: true }).click();
    await expect(page.locator('.study-phrase-draft')).toBeInViewport();
    await expect(page.locator('.caption-navigation')).toBeInViewport();
    await expect(page.getByRole('button', { name: locale === 'ja' ? '次の字幕' : 'Next subtitle', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('unfinished-phrases.png'), animations: 'disabled', fullPage: true });
    await page.locator('.study-phrase-draft > .button').click();
    await expect(page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true })).toHaveValue('take a little detour');
    await page.locator('.save-phrase-form').getByRole('button', { name: locale === 'ja' ? '入力を破棄' : 'Discard draft', exact: true }).click();
    await expect(page.getByRole('button', { name: /入力途中のフレーズ \(1\)|Unfinished phrases \(1\)/ })).toHaveCount(0);
  });
}
