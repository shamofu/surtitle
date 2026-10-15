// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { motionDurations } from '../../src/shared/motion';

// Outlive the disclosure's bounded completion fallback, including a stale one.
const obsoleteExitDeadline = motionDurations.revealClose * 1000 + 150;

test('disclosure reversal retains its draft and ignores an obsolete close completion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/settings');
  const details = page.locator('.budget-details');
  await details.locator('summary').click();
  const daily = page.getByRole('textbox', { name: 'Daily limit (USD)', exact: true });
  await daily.fill('12.5');
  await expect(page.locator('.budget-custom-summary')).toContainText('$12.50');
  const original = await daily.elementHandle();
  await details.locator('summary').click();
  await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();
  await expect(daily).toHaveValue('12.5');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await details.locator('summary').evaluate(summary => summary.click());
  await expect(details).toHaveAttribute('data-motion-state', 'exiting');
  expect(await original!.evaluate(input => !!input.closest('[inert]'))).toBe(true);
  await details.locator('summary').evaluate(summary => summary.click());
  await page.clock.runFor(obsoleteExitDeadline + motionDurations.reveal * 1000);
  await expect(details).toHaveAttribute('open', '');
  await expect(daily).toBeEditable();
  await expect(daily).toHaveValue('12.5');
  expect(await original!.evaluate(element => element === document.querySelector('.budget-details input'))).toBe(true);
  expect(await daily.evaluate(input => !!input.closest('[inert]'))).toBe(false);
  await daily.focus();
  await expect(daily).toBeFocused();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`validation reopens a closing disclosure before focusing its field (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.clock.install();
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/settings');
    const details = page.locator('.budget-details');
    await details.locator('summary').click();
    const daily = page.getByRole('textbox', { name: 'Daily limit (USD)', exact: true });
    await daily.fill('-1');
    const original = await daily.elementHandle();
    await expect(page.getByRole('button', { name: 'Review errors', exact: true })).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await details.locator('summary').evaluate(summary => summary.click());
    // Commit the close while RAF time is frozen. A busy CI frame can otherwise
    // outlive the whole short exit before the reversal is delivered.
    await expect(details).toHaveAttribute('data-motion-state', reducedMotion === 'reduce' ? 'closed' : 'exiting');
    await page.getByRole('button', { name: 'Review errors', exact: true }).evaluate(button => button.click());
    const result = await details.evaluate(element => {
      const input = element.querySelector('input')!;
      return { open: (element as HTMLDetailsElement).open, inert: !!input.closest('[inert]'), focused: document.activeElement === input };
    });
    expect(result).toMatchObject({ open: true, inert: false, focused: true });
    await expect(details).toHaveAttribute('data-motion-state', 'open');
    // Cross the obsolete exit timer's deadline: it must not close the new state.
    await page.clock.runFor(obsoleteExitDeadline);
    await expect(details).toHaveAttribute('open', '');
    await expect(daily).toBeFocused();
    await expect(daily).toHaveValue('-1');
    expect(await original!.evaluate(element => element === document.querySelector('.budget-details input'))).toBe(true);
  });
}

test('choosing custom model output cancels a disclosure exit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/settings');
  const purposes = page.locator('#ai-models > details');
  await purposes.locator(':scope > summary').click();
  const model = purposes.locator('.model-preference').filter({ has: page.getByRole('heading', { name: 'Transcription', exact: true }) });
  const output = model.getByRole('combobox', { name: /^Output limit/ });
  await output.selectOption('custom');
  await output.selectOption('standard');
  const details = model.locator('.model-editor-details');
  await expect(details).toHaveAttribute('open', '');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await details.locator('summary').evaluate(summary => summary.click());
  await expect(details).toHaveAttribute('data-motion-state', 'exiting');
  await output.selectOption('custom');
  await expect(details).toHaveAttribute('data-motion-state', 'open');
  await page.clock.runFor(obsoleteExitDeadline);
  await expect(details).toHaveAttribute('open', '');
  await expect(model.getByRole('textbox', { name: /^Maximum output tokens/ })).toBeVisible();
});
