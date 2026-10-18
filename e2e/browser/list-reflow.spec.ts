// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

test('phrase filtering and virtualization retain the focused action', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1024, height: 700 });
  await installLearningFixture(page, 'en', 'light', { cardCount: 41 });
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      export const nativeAvailable = () => true;
      export const call = (command, args) => {
        const fixture = window.__learningFixture;
        fixture.snapshot.cards[0].language = 'ja';
        return fixture.call(command, args);
      };`,
  }));
  await page.goto('/cards');
  const search = page.getByRole('textbox', { name: 'Search your phrases' });
  const language = page.getByRole('combobox', { name: 'Filter by learning language' });
  await expect(page.locator('.phrase-card').first()).toBeVisible();
  expect(await page.locator('.phrase-card').count()).toBeLessThan(30);
  await language.selectOption('en');
  await expect(page.locator('.phrase-card')).toHaveCount(40);
  const input = await search.elementHandle();
  const observation = await search.evaluate(async input => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, '0001');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const row = [...document.querySelectorAll<HTMLElement>('.phrase-card')]
      .find(row => row.querySelector('h3')?.textContent?.includes('phrase 00010'))!;
    const action = row.querySelector<HTMLButtonElement>('button[aria-label="Edit phrase"]')!;
    action.focus();
    await new Promise(requestAnimationFrame);
    // Cross back while the small-list spring is running. This retained focus also
    // asks the virtualizer to keep an otherwise distant row mounted.
    setValue.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const filter = document.querySelector<HTMLSelectElement>('select[aria-label="Filter by learning language"]')!;
    filter.value = 'all';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return { sameAction: action.isConnected && action === row.querySelector('button[aria-label="Edit phrase"]'),
      focused: document.activeElement === action, count: document.querySelectorAll('.phrase-card').length };
  });
  expect(observation.sameAction).toBe(true);
  expect(observation.focused).toBe(true);
  expect(observation.count).toBeLessThan(30);
  expect(await input!.evaluate(input => input === document.querySelector('input[aria-label="Search your phrases"]'))).toBe(true);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit phrase', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const row = page.locator('.phrase-card').filter({ has: page.getByRole('heading', { name: 'phrase 00010 take a little detour', exact: true }) });
  await expect(row.getByRole('button', { name: 'Edit phrase', exact: true })).toBeFocused();
  await language.selectOption('en');
  await expect(page.locator('.phrase-card')).toHaveCount(40);
  await expect(page.locator('.phrase-card').first()).toHaveCSS('transform', 'none');
});

test('material filters reflow existing links while live progress updates and resize settle immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      let configured = false;
      export const nativeAvailable = () => true;
      export const call = (command, args) => {
        const fixture = window.__learningFixture;
        if (!configured) {
          configured = true;
          fixture.snapshot.media.push({ ...fixture.snapshot.media[0], id: 'second-video', title: 'A second video', lastPositionMs: 0 },
            { ...fixture.snapshot.media[1], id: 'second-audio', title: 'A second conversation' });
        }
        return fixture.call(command, args);
      };`,
  }));
  await page.goto('/');
  const audio = page.locator('.media-row').filter({ hasText: 'Coffee and a conversation' });
  await expect(page.locator('.media-row')).toHaveCount(4);
  const original = await audio.elementHandle();
  const input = await page.getByRole('textbox', { name: 'Search your library' }).elementHandle();
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await expect(page.locator('.media-row')).toHaveCount(2);
  await page.setViewportSize({ width: 1300, height: 900 });
  await expect(page.locator('.media-row').first()).toHaveCSS('transform', 'none');
  expect(await original!.evaluate(element => element.isConnected && element === document.querySelector('.media-row'))).toBe(true);
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture;
    fixture.snapshot.media[1].lastPositionMs = 76000;
    fixture.snapshot.media[1].cardCount = 3;
    fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'media' });
  });
  await expect(audio).toContainText('3 saved');
  await expect(page.locator('.media-row').first()).toHaveCSS('transform', 'none');
  await expect(page.locator('.media-row').last()).toHaveCSS('transform', 'none');
  expect(await input!.evaluate(element => element === document.querySelector('input[aria-label="Search your library"]'))).toBe(true);
  await audio.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/study\/audio-fixture$/);
});

for (const cardCount of [100, 1000]) {
  test(`phrase search finds and edits a distant card among ${cardCount} entries`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLearningFixture(page, 'en', 'light', { cardCount });
    await page.goto('/cards');
    const search = page.getByRole('textbox', { name: 'Search your phrases' });
    const cards = page.locator('.phrase-card');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeLessThan(100);
    const query = `phrase ${String(cardCount - 1).padStart(5, '0')}`;
    await search.fill(query);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(query);
    await cards.getByRole('button', { name: 'Edit phrase', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit phrase', exact: true });
    await dialog.getByRole('textbox', { name: 'Meaning', exact: true }).fill('Saved from a filtered collection');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(cards.first()).toContainText('Saved from a filtered collection');
    await search.fill('no-match-fixture-query');
    await expect(cards).toHaveCount(0);
    await search.clear();
    await expect(cards.first()).toContainText('phrase 00000');
    expect(await cards.count()).toBeLessThan(100);
    await search.fill(query);
    await expect(cards.first()).toContainText('Saved from a filtered collection');
  });
}
