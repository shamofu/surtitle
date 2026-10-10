// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

test.use({ video: { mode: 'on', size: { width: 1440, height: 1000 } } });

async function openSurfaces(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'import "/e2e/browser/surface-fixture.tsx";',
  }));
  await page.goto('/');
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`dialog exit keeps the native surface hidden and preserves toast identity (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await openSurfaces(page);
    const opener = page.getByRole('button', { name: 'Open editor', exact: true });
    await opener.click();
    await page.getByRole('button', { name: 'Fail save', exact: true }).click();
    const toast = page.getByRole('button', { name: 'Could not save', exact: true });
    await expect(toast).toBeVisible();
    const originalToast = await toast.elementHandle();
    const innerOpener = page.getByRole('button', { name: 'Open confirmation', exact: true });
    await innerOpener.click();
    const inner = page.getByRole('dialog', { name: 'Confirmation', exact: true });
    await expect(inner.getByRole('button', { name: 'Could not save', exact: true })).toBeVisible();
    expect(await originalToast!.evaluate(element => element === document.querySelector('dialog:last-of-type .toast'))).toBe(true);
    const closing = await inner.evaluate(async element => {
      element.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
      await new Promise(requestAnimationFrame);
      return { attached: element.isConnected, state: element.getAttribute('data-state'), inert: element.querySelector('.modal-body')?.hasAttribute('inert'), surface: document.querySelector('[data-testid="surface-state"]')?.textContent };
    });
    if (reducedMotion === 'no-preference') expect(closing).toEqual({ attached: true, state: 'closing', inert: true, surface: 'hidden' });
    else expect(closing.attached).toBe(false);
    await expect(inner).toHaveCount(0);
    await expect(innerOpener).toBeFocused();
    await expect(page.getByTestId('surface-state')).toHaveText('hidden');
    expect(await originalToast!.evaluate(element => element === document.querySelector('dialog .toast'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.getByTestId('surface-state')).toHaveText('visible');
    expect(await originalToast!.evaluate(element => element.isConnected && !element.closest('dialog'))).toBe(true);
    await toast.click();
    await expect(toast).toHaveCount(0);
  });

  test(`study panel closes without moving the video during exit and reopens safely (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    const transcript = page.getByRole('button', { name: 'Transcript', exact: true });
    await transcript.click();
    const search = page.getByLabel('Search transcript');
    await search.fill('coast');
    const originalSearch = await search.elementHandle();
    await expect(page.getByTestId('native-player-viewport')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close panel', exact: true })).toBeEnabled();
    const during = await page.getByRole('button', { name: 'Close panel', exact: true }).evaluate(async element => {
      const viewport = document.querySelector('.native-player-viewport')!;
      const panel = document.querySelector('.study-companion') as HTMLElement;
      const before = viewport.getBoundingClientRect().toJSON();
      // Observe the committed close, which can follow asynchronous draft synchronization.
      await new Promise<void>(resolve => {
        const observer = new MutationObserver(() => {
          if (panel.inert) { observer.disconnect(); resolve(); }
        });
        observer.observe(panel, { attributes: true });
        (element as HTMLButtonElement).click();
      });
      const after = viewport.getBoundingClientRect().toJSON();
      const transforms: string[] = [];
      for (let ancestor: Element | null = viewport; ancestor; ancestor = ancestor.parentElement) transforms.push(getComputedStyle(ancestor).transform);
      return { before, after, hidden: panel.hidden, inert: panel.inert, transforms };
    });
    expect(during.inert).toBe(true);
    expect(during.transforms.every(value => value === 'none')).toBe(true);
    if (reducedMotion === 'no-preference') {
      expect(during.hidden).toBe(false);
      expect(during.after).toEqual(during.before);
    } else expect(during.hidden).toBe(true);
    await transcript.click();
    await expect(search).toHaveValue('coast');
    expect(await originalSearch!.evaluate(element => element === document.querySelector('input[aria-label="Search transcript"]'))).toBe(true);
    await expect(page.getByRole('button', { name: 'Close panel', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(page.locator('.study-companion')).toBeHidden();
    await transcript.click();
    await expect(search).toHaveValue('coast');
  });
}

test('animation preference applies only after saving, survives reload, and follows live OS changes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/settings');
  const preference = page.getByRole('combobox', { name: 'Animations', exact: true });
  await expect(preference).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await preference.selectOption('reduce');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.reload();
  await expect(preference).toHaveValue('reduce');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await preference.selectOption('system');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
});

test('live OS reduction keeps the shown study region opaque and finishes an active exit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  const transcript = page.getByRole('button', { name: 'Transcript', exact: true });
  const panel = page.locator('.study-companion');
  const region = page.locator('.study-transcript');
  await transcript.click();
  await expect(region).toBeVisible();
  await expect(region).toHaveCSS('opacity', '1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(panel).toHaveCSS('opacity', '1');
  await expect(region).toHaveCSS('opacity', '1');
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  const closing = await page.getByRole('button', { name: 'Close panel', exact: true }).evaluate(async button => {
    const panel = document.querySelector('.study-companion') as HTMLElement;
    await new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (panel.inert) { observer.disconnect(); resolve(); }
      });
      observer.observe(panel, { attributes: true });
      (button as HTMLButtonElement).click();
    });
    return { hidden: panel.hidden, inert: panel.inert };
  });
  expect(closing).toEqual({ hidden: false, inert: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(panel).toBeHidden();
  await expect(panel).toHaveCSS('opacity', '0');
  await expect(region).toBeHidden();
  await expect(region).toHaveCSS('opacity', '0');
  await transcript.click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('opacity', '1');
  await expect(region).toHaveCSS('opacity', '1');
  await expect(page.getByLabel('Search transcript')).toBeVisible();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
test(`review transitions rate only the active card once during rapid keyboard input (${reducedMotion})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  await installLearningFixture(page, 'en', 'light');
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      const rated = new Set();
      window.__motionRatings = [];
      export const nativeAvailable = () => true;
      export const call = async (command, args = {}) => {
        if (command === 'rate_card') {
          window.__motionRatings.push(args);
          await new Promise(resolve => { window.__finishMotionRating = resolve; });
          rated.add(args.cardId);
          return;
        }
        const value = await window.__learningFixture.call(command, args);
        if (command === 'get_app_snapshot') {
          value.cards.push({ ...value.cards[0], id: 'motion-next', term: 'Another phrase' });
          value.cards = value.cards.filter(card => !rated.has(card.id));
        }
        return value;
      }`,
  }));
  await page.goto('/review');
  await page.getByRole('button', { name: /Reveal meaning/ }).click();
  // Use the real keyboard listener, dispatching before React has committed a busy render.
  await page.evaluate(() => {
    for (const repeat of [false, false, true]) window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', code: 'Digit3', repeat, bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__motionRatings.length)).toBe(1);
  if (reducedMotion === 'no-preference') {
    const exitState = await page.evaluate(() => new Promise<{ inert: boolean; hidden: boolean; ratings: number; nextPresent: boolean }>((resolve) => {
      const observer = new MutationObserver(() => {
        const outgoing = document.querySelector<HTMLElement>('.review-transition[data-state="closing"]');
        if (!outgoing) return;
        observer.disconnect();
        for (let index = 0; index < 3; index++) window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', code: 'Digit3', bubbles: true }));
        resolve({
          inert: outgoing.inert,
          hidden: outgoing.getAttribute('aria-hidden') === 'true',
          ratings: (window as any).__motionRatings.length,
          nextPresent: [...document.querySelectorAll('h2')].some(node => node.textContent === 'Another phrase'),
        });
      });
      observer.observe(document.querySelector('.review-page')!, { attributes: true, childList: true, subtree: true });
      (window as any).__finishMotionRating();
    }));
    expect(exitState).toEqual({ inert: true, hidden: true, ratings: 1, nextPresent: false });
  } else {
    await page.evaluate(() => (window as any).__finishMotionRating());
  }
  await expect(page.getByRole('heading', { name: 'Another phrase', exact: true })).toBeVisible();
  await page.keyboard.press('3');
  expect(await page.evaluate(() => (window as any).__motionRatings.length)).toBe(1);
  await page.getByRole('button', { name: /Reveal meaning/ }).click();
  await page.keyboard.press('3');
  await expect.poll(() => page.evaluate(() => (window as any).__motionRatings.length)).toBe(2);
  await page.evaluate(() => (window as any).__finishMotionRating());
  await expect(page.getByRole('heading', { name: 'Review complete', exact: true })).toBeVisible();
  await expect(page.locator('.review-card')).toHaveCount(0);
});
}

test.describe('recorded motion walkthrough', () => {
  test('normal motion across learning, dialogs, notifications and settings', async ({ page }, testInfo) => {
    // These pauses make the delivered recording readable; assertions do not depend on them.
    const scenePause = () => page.waitForTimeout(650);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await scenePause();
    await page.locator('.media-card').filter({ hasText: 'A walk along the coast' }).click();
    await page.getByRole('button', { name: 'Transcript', exact: true }).click();
    await expect(page.getByLabel('Search transcript')).toBeVisible();
    await scenePause();
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(page.locator('.study-companion')).toBeHidden();
    await page.getByRole('button', { name: 'Inspect this phrase', exact: true }).click();
    await page.getByRole('button', { name: 'Save a phrase', exact: true }).click();
    await page.getByLabel('Word or phrase', { exact: true }).fill('A phrase to revisit');
    await scenePause();
    await page.getByRole('button', { name: 'Continue later', exact: true }).click();
    await page.getByRole('link', { name: 'Phrases', exact: true }).click();
    await page.getByLabel('Actions for take a little detour', { exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit phrase', exact: true });
    await editor.getByLabel('Meaning', { exact: true }).fill('A short diversion');
    await scenePause();
    await page.keyboard.press('Escape');
    const confirmation = page.getByRole('dialog', { name: 'Save your changes?', exact: true });
    await expect(confirmation).toBeVisible();
    await scenePause();
    await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Phrase updated.', exact: true })).toBeVisible();
    await scenePause();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const preference = page.getByRole('combobox', { name: 'Animations', exact: true });
    await preference.locator('..').scrollIntoViewIfNeeded();
    await expect(preference).toHaveValue('system');
    await scenePause();
    await page.screenshot({ path: testInfo.outputPath('motion-settings.png') });
    // Playwright keeps this successful test's WebM alongside the screenshot.
  });
});
