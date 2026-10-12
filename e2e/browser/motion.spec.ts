// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

test.use({ video: { mode: 'on', size: { width: 1440, height: 1000 } } });

async function openSurfaces(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'import "/e2e/browser/surface-fixture.tsx";',
  }));
  await page.goto('/');
}

async function recordControlFrames(control: Locator) {
  await control.evaluate(element => {
    const frames: { scale: number; y: number; opacity: number }[] = [];
    const read = () => {
      const style = getComputedStyle(element);
      const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
      const individualScale = style.scale === 'none' ? 1 : Number.parseFloat(style.scale);
      const individualY = style.translate === 'none' ? 0 : Number.parseFloat(style.translate.split(/\s+/)[1] || '0');
      return { scale: Math.hypot(matrix.m11, matrix.m12) * individualScale, y: matrix.m42 + individualY, opacity: Number(style.opacity) };
    };
    let frame = 0;
    const sample = () => { frames.push(read()); frame = requestAnimationFrame(sample); };
    sample();
    (window as any).__motionControlProbe = { read, finish: () => { cancelAnimationFrame(frame); return frames; } };
    // Observe press/release on the same live control; navigation/action behavior
    // is exercised separately, and must not unmount the release endpoint here.
    element.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); }, { once: true, capture: true });
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`compact controls show hover, press and release frames while reduction stays immediate (${reducedMotion})`, async ({ page }) => {
    await page.setViewportSize({ width: 440, height: 820 });
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('html')).toHaveAttribute('data-motion', reducedMotion === 'reduce' ? 'reduce' : 'full');
    await page.evaluate(() => {
      const fixture = (window as any).__learningFixture;
      const original = fixture.call.bind(fixture);
      fixture.call = (command: string, args?: Record<string, unknown>) => command === 'list_operation_progress'
        ? Promise.resolve([{ id: 'motion-lesson', kind: 'export', label: 'Saved lesson', mediaId: 'visual-fixture', status: 'completed', phase: 'completed', updatedAt: new Date().toISOString() }])
        : original(command, args);
      fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'operations' });
    });
    const observe = async (control: Locator) => {
      await page.mouse.move(0, 0);
      await recordControlFrames(control);
      const pose = () => page.evaluate(() => (window as any).__motionControlProbe.read() as { scale: number; y: number; opacity: number });
      const stable = () => expect.poll(async () => {
        const current = await pose();
        return Math.abs(current.scale - 1) < .001 && Math.abs(current.y) < .1;
      }).toBe(true);
      await stable();
      await control.hover();
      if (reducedMotion === 'no-preference') await expect.poll(async () => {
        const current = await pose();
        return current.scale > 1.015 && current.y < -1;
      }).toBe(true);
      else await stable();
      await page.mouse.down();
      if (reducedMotion === 'no-preference') await expect.poll(async () => (await pose()).scale).toBeLessThan(.955);
      else await stable();
      await page.mouse.up();
      if (reducedMotion === 'no-preference') await expect.poll(async () => {
        const current = await pose();
        return current.scale > 1.015 && current.y < -1;
      }).toBe(true);
      else await stable();
      await page.mouse.move(0, 0);
      await stable();
      const frames = await page.evaluate(() => (window as any).__motionControlProbe.finish() as { scale: number; y: number; opacity: number }[]);
      expect(frames.every(frame => frame.opacity === 1)).toBe(true);
      if (reducedMotion === 'no-preference') {
        expect(frames.some(frame => frame.scale > 1.015 && frame.y < -1), 'visible hover lift').toBe(true);
        expect(frames.some(frame => frame.scale < .955), 'visible press compression').toBe(true);
        expect(frames.filter(frame => frame.scale > .96 && frame.scale < 1.01).length, 'intermediate press/release poses').toBeGreaterThan(1);
      } else expect(frames.every(frame => Math.abs(frame.scale - 1) < .001 && Math.abs(frame.y) < .1), 'reduced motion stays at the base pose in every frame').toBe(true);
    };
    await observe(page.locator('.locale-button'));
    await observe(page.locator('.activity-trigger'));
    await observe(page.locator('.main-nav a[href="/cards"]'));
    await page.getByRole('button', { name: 'Open activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    const actionLink = dialog.getByRole('link', { name: 'Open media', exact: true });
    await expect(actionLink).toBeVisible();
    await observe(actionLink);
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open activity', exact: true })).toBeFocused();
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
    await expect(page.getByTestId('occlusion-count')).toHaveText('2');
    await page.keyboard.press('Escape');
    await expect(inner).toHaveCount(0);
    await expect(innerOpener).toBeFocused();
    await expect(page.getByTestId('surface-state')).toHaveText('blocked');
    await expect(page.getByTestId('occlusion-count')).toHaveText('1');
    expect(await originalToast!.evaluate(element => element === document.querySelector('[data-app-modal] .toast'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.getByTestId('surface-state')).toHaveText('available');
    await expect(page.getByTestId('occlusion-count')).toHaveText('0');
    expect(await originalToast!.evaluate(element => element.isConnected && !element.closest('[data-app-modal]'))).toBe(true);
    await toast.click();
    await expect(toast).toHaveCount(0);
  });


}

test('animation preference autosaves, survives reload, and follows live OS changes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/settings');
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
  await transcript.click();
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

test.describe('recorded motion walkthrough', () => {
  test('normal motion across learning, dialogs, notifications and settings', async ({ page }, testInfo) => {
    // These pauses make the delivered recording readable; assertions do not depend on them.
    const scenePause = () => page.waitForTimeout(650);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await scenePause();
    await page.locator('.media-card').filter({ hasText: 'A walk along the coast' }).click();
    await expect(page.getByRole('slider', { name: 'Playback position' })).toBeEnabled();
    for (const positionMs of [77000, 78000, 79000]) {
      await page.evaluate(async value => {
        const fixture = (window as any).__learningFixture;
        fixture.state.positionMs = value;
        await fixture.call('player_control', { request: { action: 'pause' } });
      }, positionMs);
      await scenePause();
    }
    await page.getByRole('button', { name: 'Transcript', exact: true }).click();
    await expect(page.getByLabel('Search transcript')).toBeVisible();
    await scenePause();
    await page.getByRole('button', { name: 'Transcript', exact: true }).click();
    await expect(page.locator('.study-companion')).toBeHidden();
    await page.getByRole('button', { name: 'Explore meaning', exact: true }).click();
    await page.locator('.phrase-panel').getByRole('button', { name: 'Save phrase', exact: true }).click();
    await page.getByLabel('Word or phrase', { exact: true }).fill('A phrase to revisit');
    await scenePause();
    await page.getByRole('button', { name: 'Continue later', exact: true }).click();
    await page.getByRole('link', { name: 'Phrases', exact: true }).click();
    await page.getByRole('button', { name: 'Edit phrase', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit phrase', exact: true });
    await editor.getByLabel('Meaning', { exact: true }).fill('A short diversion');
    await scenePause();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.phrase-card')).toContainText('A short diversion');
    await expect(page.getByRole('dialog')).toHaveCount(0);
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
