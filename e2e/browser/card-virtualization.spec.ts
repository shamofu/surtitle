// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

test('large phrase lists retain distant rows, keyboard access, and editor return focus', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1024, height: 700 });
  await installLearningFixture(page, 'en', 'light', { cardCount: 1000 });
  await page.goto('/cards');
  await expect(page.locator('.phrase-card').first()).toBeVisible();
  expect(await page.locator('.phrase-card').count()).toBeLessThan(30);
  await page.locator('.page-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const last = page.locator('.phrase-card').filter({ has: page.getByRole('heading', { name: 'phrase 00999 take a little detour', exact: true }) });
  await expect(last).toBeInViewport();
  const edit = last.getByRole('button', { name: 'Edit phrase', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit phrase', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  const search = page.getByRole('textbox', { name: 'Search your phrases' });
  await search.fill('phrase 00555');
  await expect(page.locator('.phrase-card')).toHaveCount(1);
  await expect(page.locator('.phrase-card')).toContainText('phrase 00555 take a little detour');
  await search.fill('');
  await expect(page.locator('.phrase-card').first()).toContainText('phrase 00000');
  expect(await page.locator('.phrase-card').count()).toBeLessThan(30);
  expect(errors).toEqual([]);
});

test('expanded phrase details remeasure virtual rows and retain keyboard focus during scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, 'en', 'light', { cardCount: 1000 });
  await page.goto('/cards');
  const row = (index: number) => page.locator('.phrase-card').filter({ has: page.getByRole('heading', {
    name: `phrase ${String(index).padStart(5, '0')} take a little detour`, exact: true,
  }) });
  const first = row(0), second = row(1), third = row(2);
  const details = first.getByRole('button', { name: 'Translation and notes for phrase 00000 take a little detour' });
  await expect(first).toBeVisible();
  const collapsedHeight = (await first.boundingBox())!.height;
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(first.getByRole('heading', { name: 'Explanation or notes' })).toBeVisible();
  expect((await first.boundingBox())!.height).toBeGreaterThan(collapsedHeight);
  await expect.poll(async () => {
    const bounds = await first.boundingBox(), next = await second.boundingBox();
    return bounds && next ? next.y - bounds.y - bounds.height : -1;
  }).toBeGreaterThanOrEqual(0);
  await expect(details).toBeFocused();
  await page.locator('.page-content').evaluate(element => { element.scrollTop = 12_000; });
  await expect(first).not.toBeInViewport();
  await expect(details).toBeFocused();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  expect(await page.locator('.phrase-card').count()).toBeLessThan(30);
  await page.locator('.page-content').evaluate(element => { element.scrollTop = 0; });
  const secondDetails = second.getByRole('button', { name: 'Translation and notes for phrase 00001 take a little detour' });
  await secondDetails.click();
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(secondDetails).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => {
    const bounds = await second.boundingBox(), next = await third.boundingBox();
    return bounds && next ? next.y - bounds.y - bounds.height : -1;
  }).toBeGreaterThanOrEqual(0);
  await expect(secondDetails).toBeFocused();
});
