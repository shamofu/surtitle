// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLearningFixture, setTranscriptOpen } from './learning-fixture';

async function openSurfaces(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'import "/e2e/browser/surface-fixture.tsx";',
  }));
  await page.goto('/');
}

async function expectStationaryEdgeHover(page: Page, control: Locator, label: string) {
  await page.mouse.move(0, 0);
  // Wait for page/dialog placement, then observe the real hover transition.
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const point = await control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = Math.round(box.x + box.width / 2);
    // A native summary's padding/marker bounds need not all be hit-testable.
    // Start at its actual bottom hit edge, then keep that pointer fixed.
    for (let y = Math.min(Math.ceil(box.bottom) - 1, innerHeight - 1); y >= Math.max(0, Math.ceil(box.top)); y--) {
      const hit = document.elementFromPoint(x, y);
      if (hit && element.contains(hit)) return { x, y };
    }
    throw new Error('Control has no visible hit target on its vertical centerline');
  });
  await control.evaluate((element, pointer) => {
    (window as any).__edgeHoverObservation = new Promise(resolve => {
      let start = 0, entered = 0, left = 0, samples = 0, frame = 0, timer = 0, finished = false;
      const missed: { ms: number; bottom: number; hit: string | null }[] = [];
      const enter = () => {
        entered++;
        if (entered !== 1) return;
        start = performance.now();
        window.clearTimeout(timer);
        timer = window.setTimeout(finish, 1500);
        frame = requestAnimationFrame(sample);
      };
      const leave = () => { left++; };
      element.addEventListener('pointerenter', enter);
      element.addEventListener('pointerleave', leave);
      const finish = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        cancelAnimationFrame(frame);
        element.removeEventListener('pointerenter', enter);
        element.removeEventListener('pointerleave', leave);
        resolve({ entered, left, samples, missed, elapsedMs: start ? performance.now() - start : 0 });
      };
      const sample = () => {
        samples++;
        const hit = document.elementFromPoint(pointer.x, pointer.y);
        if ((!hit || !element.contains(hit)) && missed.length < 5) missed.push({
          ms: Math.round(performance.now() - start), bottom: element.getBoundingClientRect().bottom,
          hit: hit?.getAttribute('class') ?? null,
        });
        if (performance.now() - start >= 600) finish();
        else frame = requestAnimationFrame(sample);
      };
      // Driver delivery time is separate from the actual hover observation.
      timer = window.setTimeout(finish, 5000);
    });
  }, point);
  await page.mouse.move(point.x, point.y);
  const observation = await page.evaluate(async () => {
    const result = await (window as any).__edgeHoverObservation;
    delete (window as any).__edgeHoverObservation;
    return result as { entered: number; left: number; samples: number; missed: unknown[]; elapsedMs: number };
  });
  expect(observation.entered, `${label}: the real pointer entered`).toBeGreaterThan(0);
  expect(observation.samples, `${label}: hover frames were observed`).toBeGreaterThan(0);
  expect(observation.elapsedMs, `${label}: the hover observation completed`).toBeGreaterThanOrEqual(600);
  expect(observation.missed, `${label}: the stationary edge pointer retained its hit target`).toEqual([]);
  expect(observation.left, `${label}: hover did not eject the pointer`).toBe(0);
  return point;
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`stationary bottom-edge pointers retain hover targets (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', reducedMotion === 'reduce' ? 'reduce' : 'full');
    const locale = page.locator('.locale-button');
    const localePoint = await expectStationaryEdgeHover(page, locale, 'Motion button');
    await page.mouse.click(localePoint.x, localePoint.y);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await locale.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expectStationaryEdgeHover(page, page.getByRole('link', { name: 'Phrases', exact: true }), 'Navigation link');
    await page.evaluate(() => {
      const fixture = (window as any).__learningFixture;
      const original = fixture.call.bind(fixture);
      fixture.call = (command: string, args?: Record<string, unknown>) => command === 'list_operation_progress'
        ? Promise.resolve([{ id: 'hover-lesson', kind: 'export', label: 'Saved lesson', mediaId: 'visual-fixture', status: 'completed', phase: 'completed', updatedAt: new Date().toISOString() }])
        : original(command, args);
      fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'operations' });
    });
    const activity = page.getByRole('button', { name: 'Open activity', exact: true });
    const activityPoint = await expectStationaryEdgeHover(page, activity, 'Native button');
    await page.mouse.click(activityPoint.x, activityPoint.y);
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    const closePoint = await expectStationaryEdgeHover(page, dialog.getByRole('button', { name: 'Close', exact: true }), 'Aria dialog button');
    await page.mouse.click(closePoint.x, closePoint.y);
    await expect(dialog).toHaveCount(0);
    await activity.click();
    const mediaPoint = await expectStationaryEdgeHover(page, dialog.getByRole('link', { name: 'Open media', exact: true }), 'Motion link');
    await page.mouse.click(mediaPoint.x, mediaPoint.y);
    await expect(page).toHaveURL(/\/study\/visual-fixture$/);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const summary = page.locator('summary').filter({ hasText: 'Advanced review settings' });
    const summaryPoint = await expectStationaryEdgeHover(page, summary, 'Disclosure summary');
    await page.mouse.click(summaryPoint.x, summaryPoint.y);
    await expect(summary.locator('..')).toHaveAttribute('open', '');
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`compact controls retain pointer and keyboard actions with motion ${reducedMotion}`, async ({ page }) => {
    await page.setViewportSize({ width: 440, height: 820 });
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', reducedMotion === 'reduce' ? 'reduce' : 'full');
    const locale = page.locator('.locale-button');
    await locale.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await locale.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const phrases = page.getByRole('link', { name: 'Phrases', exact: true });
    await phrases.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Phrases', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Library', exact: true }).click();
    await page.evaluate(() => {
      const fixture = (window as any).__learningFixture;
      const original = fixture.call.bind(fixture);
      fixture.call = (command: string, args?: Record<string, unknown>) => command === 'list_operation_progress'
        ? Promise.resolve([{ id: 'motion-lesson', kind: 'export', label: 'Saved lesson', mediaId: 'visual-fixture', status: 'completed', phase: 'completed', updatedAt: new Date().toISOString() }])
        : original(command, args);
      fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'operations' });
    });
    const activity = page.getByRole('button', { name: 'Open activity', exact: true });
    await activity.click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog.getByRole('link', { name: 'Open media', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(activity).toBeFocused();
    await activity.press('Enter');
    await dialog.getByRole('link', { name: 'Open media', exact: true }).click();
    await expect(page).toHaveURL(/\/study\/visual-fixture$/);
    await expect(page.getByRole('button', { name: 'Explore meaning', exact: true })).toBeEnabled();
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`nested dialog dismissal releases only its own input block and preserves toast identity (${reducedMotion})`, async ({ page }) => {
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
    expect(await originalToast!.evaluate(element => element === [...document.querySelectorAll('[data-app-modal]')].at(-1)?.querySelector('.toast'))).toBe(true);
    await expect(toast).toHaveCSS('opacity', '1');
    await expect(toast).toHaveCSS('transform', 'none');
    expect(await toast.evaluate(element => element.closest('.toast-stack')?.getAttribute('aria-live'))).toBe('polite');
    await expect(page.locator('[data-app-modal]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(inner).toHaveCount(0);
    await expect(innerOpener).toBeFocused();
    await expect(page.getByTestId('surface-state')).toHaveText('blocked');
    await expect(page.locator('[data-app-modal]')).toHaveCount(1);
    expect(await originalToast!.evaluate(element => element === document.querySelector('[data-app-modal] .toast'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.getByTestId('surface-state')).toHaveText('available');
    await expect(page.locator('[data-app-modal]')).toHaveCount(0);
    expect(await originalToast!.evaluate(element => element.isConnected && !element.closest('[data-app-modal]'))).toBe(true);
    await toast.click();
    await expect(toast).toHaveCount(0);
  });


}

test('animation preference autosaves, survives reload, and follows live OS changes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/settings#appearance');
  const preference = page.getByRole('combobox', { name: 'Animations', exact: true });
  await expect(preference).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await preference.selectOption('reduce');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.reload();
  await expect(preference).toHaveValue('reduce');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await preference.selectOption('system');
  await expect.poll(() => page.evaluate(async () => (await (window as any).__learningFixture.call('get_app_snapshot')).settings.motionPreference)).toBe('system');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
});

test('live OS reduction keeps the shown study region opaque and layout changes immediate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  const transcript = page.getByRole('button', { name: 'Transcript', exact: true });
  const panel = page.locator('.study-companion');
  const region = page.locator('.study-transcript');
  await setTranscriptOpen(page);
  await expect(region).toBeVisible();
  await expect(region).toHaveCSS('opacity', '1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(panel).toHaveCSS('opacity', '1');
  await expect(region).toHaveCSS('opacity', '1');
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await transcript.click();
  await expect(panel).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(panel).toBeHidden();
  await expect(region).toBeHidden();
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
  await page.evaluate(() => {
    (window as any).__finishMotionRating();
    for (let index = 0; index < 3; index++) window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', code: 'Digit3', bubbles: true }));
  });
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
