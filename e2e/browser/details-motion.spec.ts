// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { motionDurations } from '../../src/shared/motion';

// Outlive the disclosure's bounded completion fallback, including a stale one.
const obsoleteExitDeadline = motionDurations.revealClose * 1000 + 150;

test('disclosure animates actual height and following content, then reverses with the same draft', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/settings');
  await page.waitForLoadState('networkidle');
  const details = page.locator('.budget-details');
  await details.scrollIntoViewIfNeeded();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const read = (at: number) => details.evaluate((element, at) => {
    const summary = element.querySelector('summary')!, text = element.querySelector('.helper-text')!;
    const following = element.nextElementSibling!;
    return { at, height: element.getBoundingClientRect().height,
      following: following.getBoundingClientRect().y, summary: summary.textContent, text: text.textContent,
      font: getComputedStyle(text).fontSize, transform: getComputedStyle(text).transform,
      opacity: getComputedStyle(text).opacity, inert: !!text.closest('[inert]'),
      open: (element as HTMLDetailsElement).open };
  }, at);
  const observe = async (reverse = false) => {
    const startedOpen = await details.evaluate(element => (element as HTMLDetailsElement).open);
    const duration = (startedOpen ? motionDurations.revealClose : motionDurations.reveal) * 1000;
    const frames = [await read(0)];
    await details.locator('summary').evaluate(summary => summary.click());
    frames.push(await read(0));
    let elapsed = 0;
    for (const fraction of reverse ? [.2, .4] : [.2, .5, .8, 1]) {
      await page.clock.runFor(duration * fraction - elapsed);
      elapsed = duration * fraction;
      frames.push(await read(elapsed));
    }
    let reversalJump = 0;
    if (reverse) {
      const before = await read(elapsed);
      await details.locator('summary').evaluate(summary => summary.click());
      const after = await read(elapsed);
      reversalJump = Math.abs(after.height - before.height);
      frames.push(after);
      const reversalDuration = (startedOpen ? motionDurations.reveal : motionDurations.revealClose) * 1000;
      let reversalElapsed = 0;
      for (const fraction of [.2, .5, .8, 1]) {
        await page.clock.runFor(reversalDuration * fraction - reversalElapsed);
        reversalElapsed = reversalDuration * fraction;
        frames.push(await read(elapsed + reversalElapsed));
      }
      elapsed += reversalElapsed;
    }
    // Flush the completion frame, without relying on a particular browser driver.
    await page.clock.runFor(32);
    frames.push(await read(elapsed + 32));
    return { frames, reversalJump };
  };
  const { frames: opening } = await observe();
  const daily = page.getByRole('textbox', { name: 'Daily limit (USD)', exact: true });
  await daily.fill('12.5');
  await expect(page.locator('.budget-custom-summary')).toContainText('$12.50');
  const original = await daily.elementHandle();
  const { frames: closing } = await observe();
  expect(closing.some(frame => frame.inert)).toBe(true);
  for (const [name, frames, increasing] of [['open', opening, true], ['close', closing, false]] as const) {
    await info.attach(`disclosure-${name}-geometry.json`, { body: JSON.stringify(frames), contentType: 'application/json' });
    const first = frames[0], last = frames.at(-1)!;
    const low = Math.min(first.height, last.height), high = Math.max(first.height, last.height);
    expect(high - low).toBeGreaterThan(100);
    // A controlled RAF clock samples the actual layout at known animation times.
    expect(frames.slice(2, 5).every(frame => frame.height > low + 2 && frame.height < high - 2)).toBe(true);
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      expect(frame.font).toBe(first.font);
      expect(frame.text).toBe(first.text);
      expect(frame.summary).toBe(first.summary);
      expect(frame.transform).toBe('none');
      expect(frame.opacity).toBe('1');
      expect(Math.abs((frame.following - first.following) - (frame.height - first.height))).toBeLessThan(1);
      if (index > 0) expect((frame.height - frames[index - 1].height) * (increasing ? 1 : -1)).toBeGreaterThanOrEqual(-1);
    }
  }
  await expect(details).not.toHaveAttribute('open');
  await observe();
  const { frames: reversing, reversalJump } = await observe(true);
  expect(reversalJump).toBeLessThan(1);
  const heights = reversing.map(frame => frame.height);
  expect(Math.min(...heights)).toBeGreaterThan(closing.at(-1)!.height + 2);
  expect(Math.min(...heights)).toBeLessThan(heights[0] - 10);
  expect(Math.abs(heights.at(-1)! - heights[0])).toBeLessThan(1);
  await expect(details).toHaveAttribute('open', '');
  await expect(daily).toHaveValue('12.5');
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await info.attach('disclosure-reversal-geometry.json', { body: JSON.stringify(reversing), contentType: 'application/json' });
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
