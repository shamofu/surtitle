// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { motionDurations } from '../../src/shared/motion';

async function pose(element: Locator) {
  return element.evaluate(element => {
    const style = getComputedStyle(element);
    const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
    return { x: matrix.m41, y: matrix.m42, opacity: Number(style.opacity) };
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`main page navigation keeps controls reachable and resets page scroll (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.clock.install();
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await expect(page.locator('.media-card').first()).toBeVisible();
    await page.evaluate(() => {
      const fixture = (window as any).__learningFixture;
      const original = fixture.snapshot.media[1];
      fixture.snapshot.media.push(...Array.from({ length: 20 }, (_, index) => ({ ...original, id: `navigation-${index}`, title: `Navigation material ${index}` })));
      fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'media' });
    });
    await expect(page.locator('.media-row')).toHaveCount(22);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 200; });
    expect(await page.locator('.page-content').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    for (const [path, selector, direction] of [
      ['/cards', '.phrases-page', 'forward'],
      ['/review', '.review-page', 'forward'],
      ['/settings', '.settings-page', 'forward'],
      ['/review', '.review-page', 'backward'],
      ['/', '.library-page', 'backward'],
    ]) {
      await page.locator(`.main-nav a[href="${path}"]`).evaluate((element: HTMLElement) => element.click());
      const current = page.locator(selector);
      await expect(current).toBeAttached();
      await expect(page.locator('.page-content')).toHaveAttribute('data-page-direction', direction);
      await expect(page.locator(`.main-nav a[href="${path}"]`)).toHaveAttribute('aria-current', 'page');
      const stage = page.locator('.page-content');
      await expect(stage).toHaveCSS('overflow-x', 'hidden');
      await stage.evaluate(element => {
        const samples: number[] = [];
        let frame = 0;
        const sample = () => { samples.push(element.scrollLeft); };
        const tick = () => { sample(); frame = requestAnimationFrame(tick); };
        element.addEventListener('scroll', sample);
        tick();
        (window as any).__routeScrollProbe = { stop: () => {
          cancelAnimationFrame(frame); element.removeEventListener('scroll', sample); return samples;
        } };
      });
      await stage.hover();
      await page.mouse.wheel(240, 0);
      await page.clock.runFor(16);
      await page.mouse.wheel(-240, 0);
      await page.clock.runFor(16);
      await page.clock.runFor(motionDurations.content * 1000 + 150);
      const horizontalFrames = await page.evaluate(() => (window as any).__routeScrollProbe.stop() as number[]);
      expect(horizontalFrames.length).toBeGreaterThan(2);
      expect(horizontalFrames.every(left => left === 0), 'horizontal wheel input cannot pan the animated route stage').toBe(true);
      expect(await pose(current)).toEqual({ x: 0, y: 0, opacity: 1 });
      expect(await page.locator('.page-content').evaluate(element => element.scrollTop)).toBe(0);
      await expect(page.locator('.page-content')).toHaveCSS('transform', 'none');
      await expect(current.locator('h1')).toBeInViewport({ ratio: 1 });
      if (path === '/') {
        const lastMaterial = current.locator('.media-row').last();
        await lastMaterial.scrollIntoViewIfNeeded();
        await expect(lastMaterial).toBeInViewport({ ratio: 1 });
        expect(await stage.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        expect(await stage.evaluate(element => element.scrollLeft)).toBe(0);
      }
    }
  });
}

test('rapid main navigation and live motion reduction settle only the latest page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/');
  await expect(page.locator('.media-card').first()).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  for (const path of ['/review', '/settings', '/cards']) {
    await page.locator(`.main-nav a[href="${path}"]`).evaluate((element: HTMLElement) => element.click());
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.clock.runFor(40);
  }
  const current = page.locator('.phrases-page');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  expect(await pose(current)).toEqual({ x: 0, y: 0, opacity: 1 });
  await expect(page.locator('.review-page, .settings-page')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search your phrases' })).toBeEnabled();
  await page.clock.runFor(1000);
  expect(await pose(current)).toEqual({ x: 0, y: 0, opacity: 1 });
});

test('main navigation never animates a native player ancestor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/cards');
  await page.locator('.main-nav a[href="/"]').click();
  await page.locator('a.media-card[href="/study/visual-fixture"]').click();
  await expect(page.getByRole('button', { name: 'Explore meaning', exact: true })).toBeEnabled();
  await expect(page.locator('.page-content')).toHaveAttribute('data-page-direction', 'none');
  expect(await page.getByTestId('native-player-viewport').evaluate(async element => {
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise(requestAnimationFrame);
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.transform !== 'none' || style.translate !== 'none' || style.opacity !== '1') return false;
      }
    }
    return true;
  })).toBe(true);
  await page.locator('.main-nav a[href="/review"]').click();
  await expect(page.locator('.review-page')).toBeVisible();
  await expect(page.locator('.page-content')).toHaveCSS('transform', 'none');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 920, height: 620 }]) {
  test(`review title, card and rating controls remain reachable (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLearningFixture(page, viewport.width === 1024 ? 'ja' : 'en', 'light');
    await page.goto('/review');
    const review = page.locator('.review-page');
    await expect(review.locator('.review-card')).toBeVisible();
    await expect(review.locator('.review-title')).toBeInViewport();
    await expect(review.locator('.review-card')).toBeInViewport();
    const [title, card] = await Promise.all([review.locator('.review-title').boundingBox(), review.locator('.review-card').boundingBox()]);
    expect(title!.y + title!.height).toBeLessThanOrEqual(card!.y + 1);
    await review.getByRole('button', { name: /Reveal meaning|意味を確認する/ }).click();
    for (const rating of await review.locator('.rating-buttons button').all()) await expect(rating).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
