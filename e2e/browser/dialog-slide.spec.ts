// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function setup(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.route(/\/src\/main\.tsx(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'import "/e2e/browser/dialog-slide-fixture.tsx";',
  }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}
async function command(page: Page, method: string, value?: boolean) {
  await page.evaluate(({ method, value }) => (window as any).dialogSlides[method](value), { method, value });
}
async function pose(shell: Locator) {
  return shell.evaluate(element => {
    const style = getComputedStyle(element);
    const matrix = new DOMMatrixReadOnly(style.transform);
    return { y: matrix.m42, scaleX: matrix.m11, scaleY: matrix.m22, opacity: Number(style.opacity), top: element.getBoundingClientRect().top };
  });
}

test('the painted modal shell enters, reverses from its current pose, and ignores unrelated callback churn', async ({ page }) => {
  await setup(page);
  await command(page, 'open');
  const modal = page.getByRole('dialog', { name: 'Sliding editor' });
  const input = await modal.getByLabel('Draft').elementHandle();
  const first = await pose(modal);
  expect(first.y).toBeCloseTo(48, 1);
  expect(first.opacity).toBe(0);
  await page.clock.runFor(100);
  const entering = await pose(modal);
  expect(entering.y).toBeGreaterThan(0);
  expect(entering.y).toBeLessThan(48);
  expect(first.top - entering.top).toBeCloseTo(first.y - entering.y, 1);
  await expect(modal.locator('.modal-header')).toHaveCSS('transform', 'none');
  await expect(modal.locator('.modal-body')).toHaveCSS('transform', 'none');
  await command(page, 'close');
  expect((await pose(modal)).y).toBeCloseTo(entering.y, 1);
  await expect(modal.locator('.modal-body')).toHaveAttribute('inert');
  await page.clock.runFor(45);
  const closing = await pose(modal);
  expect(closing.y).toBeGreaterThan(entering.y);
  await command(page, 'reopen');
  expect((await pose(modal)).y).toBeCloseTo(closing.y, 1);
  await command(page, 'rerender');
  await page.clock.runFor(350);
  await expect(modal).toHaveCSS('transform', 'none');
  await expect(modal).toHaveCSS('opacity', '1');
  expect(await input!.evaluate(element => element === document.querySelector('input[aria-label="Draft"]'))).toBe(true);
  await expect(page.getByTestId('commits')).toHaveText('0');
  await command(page, 'close');
  await page.clock.runFor(100);
  await command(page, 'rerender');
  // Include two frame boundaries beyond the 240ms transition. The frozen clock
  // cannot finish an animation whose final scheduled frame has not run yet.
  await page.clock.runFor(220);
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('commits')).toHaveText('1');
});

for (const below of [false, true]) {
  test(`the entire rate popup slides from the trigger side (${below ? 'below' : 'above'}) without scale`, async ({ page }) => {
    await setup(page);
    if (below) await command(page, 'topTrigger');
    await command(page, 'rate', true);
    const positioner = page.locator('.playback-rate-popover');
    const shell = page.locator('.playback-rate-content');
    await expect(positioner).toHaveAttribute('data-placement', below ? 'bottom' : 'top');
    const initial = await pose(shell);
    expect(initial.y).toBeCloseTo(below ? -24 : 24, 1);
    expect(initial.scaleX).toBe(1);
    expect(initial.scaleY).toBe(1);
    // Border/background/shadow must travel with the content rather than remain on the positioner.
    await expect(positioner).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(await shell.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await page.clock.runFor(100);
    const entering = await pose(shell);
    expect(Math.abs(entering.y)).toBeLessThan(24);
    expect(Math.abs(entering.y)).toBeGreaterThan(0);
    await command(page, 'rate', false);
    expect((await pose(shell)).y).toBeCloseTo(entering.y, 1);
    await page.clock.runFor(40);
    const closing = await pose(shell);
    await command(page, 'rate', true);
    expect((await pose(shell)).y).toBeCloseTo(closing.y, 1);
    await command(page, 'rerender');
    await page.clock.runFor(400);
    await expect(shell).toHaveCSS('transform', 'none');
    await expect(shell).toHaveCSS('opacity', '1');
    await command(page, 'rate', false);
    await page.clock.runFor(40);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(positioner).toHaveCount(0);
    await page.clock.runFor(500);
    await expect(positioner).toHaveCount(0);
  });
}

test('live reduction settles a closing modal once and leaves no delayed completion', async ({ page }) => {
  await setup(page);
  await command(page, 'open');
  await page.clock.runFor(350);
  await command(page, 'close');
  await page.clock.runFor(40);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('commits')).toHaveText('1');
  await command(page, 'open');
  await page.clock.runFor(500);
  await expect(page.getByRole('dialog')).toHaveCSS('transform', 'none');
  await expect(page.getByTestId('commits')).toHaveText('1');
});
