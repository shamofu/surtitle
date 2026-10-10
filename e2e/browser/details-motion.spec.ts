// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { motionDurations } from '../../src/shared/motion';

// Outlive the configured exit and its bounded completion fallback.
const obsoleteExitDeadline = motionDurations.exit * 1000 + 150;

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`validation reopens a closing disclosure before focusing its field (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/settings');
    const details = page.locator('.budget-details');
    await details.locator('summary').click();
    const daily = page.getByRole('spinbutton', { name: 'Daily limit (USD)', exact: true });
    await daily.fill('-1');
    const result = await details.evaluate(async element => {
      element.querySelector('summary')!.click();
      await new Promise(requestAnimationFrame);
      const before = (element as HTMLElement).dataset.motionState;
      const review = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Review errors')!;
      review.click();
      const input = element.querySelector('input')!;
      return { before, open: (element as HTMLDetailsElement).open, inert: !!input.closest('[inert]'), focused: document.activeElement === input };
    });
    expect(result.before).toBe(reducedMotion === 'reduce' ? 'closed' : 'exiting');
    expect(result).toMatchObject({ open: true, inert: false, focused: true });
    await expect(details).toHaveAttribute('data-motion-state', 'open');
    // Cross the obsolete exit timer's deadline: it must not close the new state.
    await page.waitForTimeout(obsoleteExitDeadline);
    await expect(details).toHaveAttribute('open', '');
    await expect(daily).toBeFocused();
  });
}

test('choosing custom model output cancels a disclosure exit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/settings');
  const purposes = page.locator('#ai-models > details');
  await purposes.locator(':scope > summary').click();
  const model = purposes.locator('.model-preference').filter({ has: page.getByRole('heading', { name: 'Transcription', exact: true }) });
  const output = model.getByRole('combobox', { name: /^Output limit/ });
  await output.selectOption('custom');
  await output.selectOption('standard');
  const details = model.locator('.model-editor-details');
  const before = await details.evaluate(async element => {
    element.querySelector('summary')!.click();
    await new Promise(requestAnimationFrame);
    const state = (element as HTMLElement).dataset.motionState;
    const select = Array.from(element.closest('.model-editor')!.querySelectorAll('select')).find(item => item.querySelector('option[value="custom"]'))!;
    select.value = 'custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return state;
  });
  expect(before).toBe('exiting');
  await expect(details).toHaveAttribute('data-motion-state', 'open');
  await page.waitForTimeout(obsoleteExitDeadline);
  await expect(model.getByRole('spinbutton', { name: /^Maximum output tokens/ })).toBeVisible();
});
