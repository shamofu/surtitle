// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function toggles(page: Page) {
  return page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) =>
    call.command === 'player_control' && call.args.request.action === 'toggle-pause').length);
}

for (const kind of ['video', 'audio']) {
  test(`clicking the ${kind} surface toggles playback without involving the controls`, async ({ page }) => {
    await installLearningFixture(page, 'en', 'light');
    if (kind === 'audio') await page.addInitScript(() => {
      const fixture = (window as any).__learningFixture;
      const call = fixture.call.bind(fixture);
      fixture.call = async (command: string, args: any) => {
        const result = await call(command, args);
        if (command === 'get_app_snapshot') result.media[0].kind = 'audio';
        return result;
      };
    });
    await page.goto('/study/visual-fixture');
    const surface = page.getByTestId('native-player-viewport');
    await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeEnabled();
    await surface.click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(() => toggles(page)).toBe(1);
    await surface.click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect.poll(() => toggles(page)).toBe(2);
    await page.getByRole('slider', { name: 'Volume', exact: true }).click();
    await page.getByRole('slider', { name: 'Playback position', exact: true }).click();
    expect(await toggles(page)).toBe(2);
    await surface.click({ button: 'right' });
    expect(await toggles(page)).toBe(2);
  });
}

test('the focused playback surface handles Space and Enter once per activation', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  const button = page.locator('.player-surface-toggle');
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(await toggles(page)).toBe(1);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await toggles(page)).toBe(2);
});
