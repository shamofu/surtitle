// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { motionDurations } from '../../src/shared/motion';

test('rapid keyboard tab changes and drawer reversal retain the search and focus owner', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByLabel('Search transcript').fill('coast');
  const search = await page.getByLabel('Search transcript').elementHandle();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const transcript = page.getByRole('tab', { name: 'Transcript', exact: true });
  const suggestions = page.getByRole('tab', { name: 'Suggestions', exact: true });
  await transcript.focus();
  await transcript.dispatchEvent('keydown', { key: 'End' });
  await expect(suggestions).toHaveAttribute('aria-selected', 'true');
  await expect(suggestions).toBeFocused();
  await suggestions.dispatchEvent('keydown', { key: 'Home' });
  await expect(transcript).toHaveAttribute('aria-selected', 'true');
  await expect(transcript).toBeFocused();
  const close = page.getByRole('button', { name: 'Close panel', exact: true });
  await close.focus();
  await close.evaluate(button => button.click());
  const toggle = page.locator('.study-transcript-toggle');
  await expect(toggle).toBeFocused();
  await page.clock.runFor(40);
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'true');
  await toggle.evaluate(button => button.click());
  await page.clock.runFor(500);
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
  expect(await search!.evaluate(input => input === document.querySelector('input[aria-label="Search transcript"]'))).toBe(true);
  expect(await page.evaluate(() => {
    for (let element: Element | null = document.querySelector('.native-player-viewport'); element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.opacity !== '1' || style.transform !== 'none' || style.translate !== 'none') return false;
    }
    return true;
  })).toBe(true);
  await expect(page.getByRole('tab', { name: 'Transcript', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('subtitle details remain readable and return focus without moving the native shell', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      export const nativeAvailable = () => true;
      export const call = (command, args) => {
        if (command === 'list_media_streams') return Promise.resolve([{ index: 2, kind: 'subtitle', codec: 'subrip', language: 'eng', title: 'English captions', supportedText: true, isDefault: true }]);
        if (command === 'list_subtitle_versions') return Promise.resolve([]);
        return window.__learningFixture.call(command, args);
      };`,
  }));
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const opener = page.getByRole('button', { name: 'Add or switch subtitles', exact: true });
  await opener.click();
  const modal = page.getByRole('dialog', { name: 'Add or switch subtitles', exact: true });
  const details = modal.locator('details').filter({ has: page.getByText('Subtitle details', { exact: true }) });
  await expect(details).toBeVisible();
  const nativeBefore = await page.getByTestId('native-player-viewport').boundingBox();
  const summary = details.locator('summary');
  await summary.click();
  await expect(details).toHaveAttribute('open', '');
  const stream = details.getByRole('listitem').filter({ hasText: 'English captions' });
  await expect(stream).toBeVisible();
  await stream.scrollIntoViewIfNeeded();
  await expect(stream).toBeInViewport({ ratio: 1 });
  await expect(modal).toHaveCSS('transform', 'none');
  await expect(modal).toHaveCSS('opacity', '1');
  await summary.click();
  await expect(details).not.toHaveAttribute('open');
  await expect(stream).toBeHidden();
  expect(await page.getByTestId('native-player-viewport').boundingBox()).toEqual(nativeBefore);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('revealing an answer during navigation retains its content and enables ratings', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/');
  await expect(page.locator('.media-card').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^Review/ })).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('.main-nav a[href="/review"]').evaluate(link => link.click());
  const review = page.locator('.review-page');
  await expect(review.locator('.review-answer.concealed button')).toHaveCount(1);
  // Freeze the entrance so the reveal is delivered before navigation settles.
  await review.locator('.review-answer.concealed button').evaluate(button => button.click());
  await expect(review.locator('.review-card')).toHaveClass(/revealed/);
  await expect(review.locator('.review-answer')).toContainText('少し寄り道をする');
  const answer = await review.locator('.review-answer').elementHandle();
  expect(await review.locator('.rating-button').evaluateAll(buttons => buttons.every(button => !(button as HTMLButtonElement).disabled))).toBe(true);
  await page.clock.runFor(motionDurations.content * 1000 + 120);
  await expect(review.locator('.review-answer')).toBeVisible();
  await expect(review.getByRole('heading', { name: 'Meaning', exact: true })).toBeFocused();
  expect(await answer!.evaluate(element => element === document.querySelector('.review-answer'))).toBe(true);
});

test('live reduced motion leaves only the latest tab panel interactive', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const suggestions = page.getByRole('tab', { name: 'Suggestions', exact: true });
  await suggestions.evaluate(button => button.click());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Suggestions', exact: true })).toHaveAttribute('aria-selected', 'true');
  // Advancing beyond the superseded transition must not bring its frame back.
  await page.clock.runFor(400);
  await expect(suggestions).toBeVisible();
  await page.getByRole('tab', { name: 'Transcript', exact: true }).evaluate(button => button.click());
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
});
