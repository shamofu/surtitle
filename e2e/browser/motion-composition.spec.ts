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
  const marker = page.locator('.transcript-tabs > .selection-indicator');
  const read = () => marker.evaluate(element => ({ left: element.getBoundingClientRect().left, width: element.getBoundingClientRect().width }));
  const initial = await read();
  const destination = (await suggestions.boundingBox())!.x;
  await transcript.focus();
  await transcript.dispatchEvent('keydown', { key: 'End' });
  await expect(suggestions).toHaveAttribute('aria-selected', 'true');
  await expect(suggestions).toBeFocused();
  // The trailing edge starts at 25% of the selection duration, after Motion's
  // first RAF establishes its clock. Sample inside the stretch, not its onset.
  await page.clock.runFor(Math.round(motionDurations.selection * 1000 * .4));
  const outward = await read();
  expect(outward.left).toBeGreaterThan(initial.left);
  expect(outward.left).toBeLessThan(destination);
  expect(outward.width).toBeGreaterThan(initial.width);
  await suggestions.dispatchEvent('keydown', { key: 'Home' });
  await expect(transcript).toHaveAttribute('aria-selected', 'true');
  await expect(transcript).toBeFocused();
  const reversed = await read();
  expect(Math.abs(reversed.left - outward.left)).toBeLessThan(1);
  await page.clock.runFor(80);
  expect((await read()).left).toBeLessThan(reversed.left);
  await page.clock.runFor(300);
  expect(Math.abs((await read()).left - initial.left)).toBeLessThan(.5);
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

test('a disclosure inside the subtitle modal settles its geometry without moving the native shell', async ({ page }) => {
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
  const result = await details.evaluate(async element => {
    const modal = element.closest('[data-app-modal]')!;
    const summary = element.querySelector('summary')!;
    const read = () => ({ height: element.getBoundingClientRect().height, modalHeight: modal.getBoundingClientRect().height,
      transform: getComputedStyle(modal).transform, opacity: getComputedStyle(modal).opacity,
      animatedHeight: element.getAnimations().some(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.height !== undefined)) });
    const toggle = (open: boolean) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Modal disclosure did not commit')); }, 5000);
      const observer = new MutationObserver(() => {
        if ((element as HTMLDetailsElement).open === open) { observer.disconnect(); clearTimeout(timeout); resolve(); }
      });
      observer.observe(element, { attributes: true });
      summary.click();
    });
    const closed = read();
    await toggle(true);
    const opened = read();
    await new Promise(requestAnimationFrame);
    const nextFrame = read();
    await toggle(false);
    const closedAgain = read();
    return { closed, opened, nextFrame, closedAgain };
  });
  expect(result.opened.height).toBeGreaterThan(result.closed.height + 10);
  expect(result.opened).toEqual(result.nextFrame);
  expect(result.closedAgain.height).toBeCloseTo(result.closed.height, 1);
  for (const frame of Object.values(result)) expect(frame).toMatchObject({ transform: 'none', opacity: '1', animatedHeight: false });
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('a page entrance owns its subtree when an answer is revealed before that entrance ends', async ({ page }) => {
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
  // The controlled RAF clock keeps the page's initial entrance frame pending.
  // Revealing here must not install a competing fade on the live answer subtree.
  await expect(review).toHaveCSS('opacity', '0');
  await review.locator('.review-answer.concealed button').evaluate(button => button.click());
  await expect(review.locator('.review-card')).toHaveClass(/revealed/);
  await expect(review.locator('.review-answer')).toContainText('少し寄り道をする');
  await expect(review.locator('.review-answer')).toHaveCSS('opacity', '1');
  await expect(review.locator('.review-answer')).toHaveCSS('transform', 'none');
  await expect(review.locator('[data-motion-snapshot]')).toHaveCount(0);
  const answer = await review.locator('.review-answer').elementHandle();
  expect(await review.locator('.rating-button').evaluateAll(buttons => buttons.every(button => !(button as HTMLButtonElement).disabled))).toBe(true);
  await page.clock.runFor(motionDurations.content * 1000 + 120);
  await expect(review).toHaveCSS('opacity', '1');
  await expect(review).toHaveCSS('transform', 'none');
  expect(await answer!.evaluate(element => element === document.querySelector('.review-answer'))).toBe(true);
});

test('live reduced motion settles an in-flight tab indicator and leaves only the latest panel interactive', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const suggestions = page.getByRole('tab', { name: 'Suggestions', exact: true });
  await suggestions.evaluate(button => button.click());
  const marker = page.locator('.transcript-tabs > .selection-indicator');
  await page.clock.runFor(80);
  const before = await marker.evaluate(element => {
    const selected = element.parentElement!.querySelector('[aria-selected="true"]')!;
    return Math.abs(element.getBoundingClientRect().left - selected.getBoundingClientRect().left);
  });
  expect(before).toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Suggestions', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await marker.evaluate(element => {
    const selected = element.parentElement!.querySelector('[aria-selected="true"]')!;
    return Math.abs(element.getBoundingClientRect().left - selected.getBoundingClientRect().left);
  })).toBeLessThan(.5);
  // Advancing beyond the superseded transition must not bring its frame back.
  await page.clock.runFor(400);
  const selectedLeft = (await suggestions.boundingBox())!.x;
  expect((await marker.boundingBox())!.x).toBeCloseTo(selectedLeft, 1);
  await page.getByRole('tab', { name: 'Transcript', exact: true }).evaluate(button => button.click());
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  const transcriptLeft = (await page.getByRole('tab', { name: 'Transcript', exact: true }).boundingBox())!.x;
  expect((await marker.boundingBox())!.x).toBeCloseTo(transcriptLeft, 1);
});
