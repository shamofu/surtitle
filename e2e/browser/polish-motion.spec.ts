// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function expectNativeSafe(page: Page) {
  expect(await page.getByTestId('native-player-viewport').evaluate(video => {
    for (let node: Element | null = video; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.opacity !== '1' || style.transform !== 'none' || style.translate !== 'none') return false;
    }
    return document.documentElement.scrollWidth <= innerWidth + 1;
  })).toBe(true);
}

async function installReviewFixture(page: Page) {
  await installLearningFixture(page, 'en', 'light', { cardCount: 2 });
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      const rated = new Set();
      export const nativeAvailable = () => true;
      export const call = async (command, args = {}) => {
        if (command === 'rate_card') { rated.add(args.cardId); return; }
        const result = await window.__learningFixture.call(command, args);
        if (command === 'get_app_snapshot') result.cards = result.cards.filter(card => !rated.has(card.id));
        return result;
      };`,
  }));
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 920, height: 900 }]) {
  test(`drawer reversal retains the latest state and draft without covering native video (${viewport.width}px)`, async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    const toggle = page.getByRole('button', { name: 'Transcript', exact: true });
    const panel = page.locator('.study-companion');
    await toggle.click();
    const search = page.getByLabel('Search transcript');
    await search.fill('coast');
    const original = await search.elementHandle();
    await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await toggle.evaluate(button => button.click());
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveAttribute('inert');
    await toggle.evaluate(button => button.click());
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.clock.resume();
    await expect(search).toBeEditable();
    await expect(panel).not.toHaveAttribute('inert');
    await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
    await expect(search).toHaveValue('coast');
    expect(await original!.evaluate(input => input === document.querySelector('input[aria-label="Search transcript"]'))).toBe(true);
    await expectNativeSafe(page);
    expect(await page.evaluate(() => {
      const video = document.querySelector('.native-player-viewport')!.getBoundingClientRect();
      const panel = document.querySelector('.study-companion')!.getBoundingClientRect();
      return video.right <= panel.left + 1 || video.bottom <= panel.top + 1;
    })).toBe(true);
    await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
    await expectNativeSafe(page);
  });
}

test('closing an opening drawer leaves no interactive panel or stale native placement', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const toggle = page.getByRole('button', { name: 'Transcript', exact: true });
  await toggle.evaluate(button => button.click());
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.evaluate(button => button.click());
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.clock.resume();
  await expect(page.locator('.study-companion')).toBeHidden();
  await expect(page.locator('.study-companion')).toHaveAttribute('inert');
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  await expectNativeSafe(page);
});

test('tab reversal keeps outgoing controls inert and retains composing input', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const search = page.getByLabel('Search transcript');
  await search.fill('unfinished 日本語');
  const original = await search.elementHandle();
  await search.evaluate(input => {
    input.setSelectionRange(11, 14);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '日本語' }));
  });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.getByRole('tab', { name: 'Suggestions', exact: true }).evaluate(button => button.click());
  await expect(page.getByRole('tab', { name: 'Suggestions', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await original!.evaluate(input => !!input.closest('[inert]'))).toBe(true);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Transcript', exact: true }).evaluate(button => button.click());
  await page.clock.resume();
  await expect(search).toBeEditable();
  await expect(search).toHaveValue('unfinished 日本語');
  expect(await original!.evaluate(input => input === document.querySelector('input[aria-label="Search transcript"]'))).toBe(true);
  expect(await search.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([11, 14]);
  await search.dispatchEvent('compositionend', { data: '日本語' });
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
});

test('review reveal transfers focus and rating exposes only the next active card', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installReviewFixture(page);
  await page.goto('/review');
  await page.getByRole('button', { name: /Reveal meaning/ }).click();
  await expect(page.getByRole('heading', { name: 'Meaning', exact: true })).toBeFocused();
  await page.locator('.rating-button.good').click();
  const next = page.getByRole('heading', { name: 'phrase 00001 take a little detour', exact: true });
  await expect(next).toBeFocused();
  await expect(page.locator('.review-outgoing')).toHaveCount(0);
  await expect(page.locator('.review-card')).toHaveCount(1);
  for (const button of await page.locator('.rating-button').all()) await expect(button).toBeDisabled();
  await page.getByRole('button', { name: /Reveal meaning/ }).click();
  for (const button of await page.locator('.rating-button').all()) await expect(button).toBeEnabled();
});

test('live reduced motion reveals the next review card and preserves prompt focus', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installReviewFixture(page);
  await page.goto('/review');
  await page.getByRole('button', { name: /Reveal meaning/ }).click();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('.rating-button.good').evaluate(button => button.click());
  const next = page.getByRole('heading', { name: 'phrase 00001 take a little detour', exact: true });
  await expect(next).toBeAttached();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.resume();
  await expect(next).toBeVisible();
  await expect(next).toBeFocused();
  await expect(page.locator('.review-outgoing')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(next).toBeFocused();
  await expect(page.locator('.review-card')).toHaveCount(1);
});

test('live reduced motion settles an opening drawer at its latest endpoint', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const toggle = page.getByRole('button', { name: 'Transcript', exact: true });
  await toggle.evaluate(button => button.click());
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.resume();
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  const search = page.getByLabel('Search transcript');
  await search.fill('coast');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('coast');
  await expectNativeSafe(page);
});

test('resize clips a drawer against unacknowledged native bounds and delays its focus', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light');
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      window.__holdPlacement = false;
      window.__releasePlacement = () => {};
      export const nativeAvailable = () => true;
      export const call = async (command, args = {}) => {
        if (command === 'player_control' && args.request?.action === 'bounds' && window.__holdPlacement) {
          await new Promise(resolve => { window.__releasePlacement = resolve; });
        }
        return window.__learningFixture.call(command, args);
      };`,
  }));
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  const nativeRight = await page.locator('.native-player-viewport').evaluate(element => element.getBoundingClientRect().right);
  await page.evaluate(() => { (window as any).__holdPlacement = true; document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!.click(); });
  const panel = page.locator('.study-companion');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'pending');
  const protectedPixels = () => page.locator('.study-companion-dock').evaluate((element, right) => {
    const rect = element.getBoundingClientRect();
    const inset = Number((element as HTMLElement).dataset.nativeClipLeft || 0);
    return inset >= rect.width - 1 || rect.left + inset >= right - 1;
  }, nativeRight);
  await expect(panel).toHaveAttribute('inert', '');
  await expect.poll(protectedPixels).toBe(true);
  await page.setViewportSize({ width: 1300, height: 960 });
  await expect(panel).toHaveAttribute('inert', '');
  await expect.poll(protectedPixels).toBe(true);
  expect(await panel.evaluate(element => element.contains(document.activeElement))).toBe(false);
  await page.evaluate(() => { (window as any).__holdPlacement = false; (window as any).__releasePlacement(); });
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  await expect(panel).toHaveCSS('visibility', 'visible');
  await expect(panel).not.toHaveAttribute('inert');
  await expect(page.getByLabel('Search transcript')).toBeVisible();
});

test('notification reflow and live reduced motion retain actionable notifications', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route(/\/src\/main\.tsx(?:\?|$)/, route => route.fulfill({ contentType: 'application/javascript', body: 'import "/e2e/browser/surface-fixture.tsx";' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  const fail = page.getByRole('button', { name: 'Fail save', exact: true });
  await fail.click();
  const original = await page.locator('.toast').elementHandle();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await fail.evaluate(button => button.click());
  await expect(page.locator('.toast')).toHaveCount(2);
  await fail.evaluate(button => button.click());
  await expect(page.locator('.toast')).toHaveCount(3);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.resume();
  expect(await original!.evaluate(toast => toast.isConnected)).toBe(true);
  for (const toast of await page.locator('.toast').all()) {
    await expect(toast).toBeVisible();
    await expect(toast).toBeEnabled();
  }
  await page.locator('.toast').last().click();
  await expect(page.locator('.toast')).toHaveCount(2);
  expect(await original!.evaluate(toast => toast.isConnected)).toBe(true);
});
