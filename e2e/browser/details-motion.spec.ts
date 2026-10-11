// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { motionDurations } from '../../src/shared/motion';

// Outlive the disclosure's bounded completion fallback, including a stale one.
const obsoleteExitDeadline = motionDurations.reveal * 1000 + 150;

test('disclosure animates actual height and following content, then reverses with the same draft', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/settings');
  await page.waitForLoadState('networkidle');
  const details = page.locator('.budget-details');
  await details.scrollIntoViewIfNeeded();
  const observe = (reverse = false) => details.evaluate(async (element, { reverse, duration }) => {
    const summary = element.querySelector('summary')!;
    const text = element.querySelector('.helper-text')!;
    const following = element.nextElementSibling!;
    const read = (at: number) => ({ at, height: element.getBoundingClientRect().height,
      following: following.getBoundingClientRect().y, summary: summary.textContent, text: text.textContent,
      font: getComputedStyle(text).fontSize, transform: getComputedStyle(text).transform,
      opacity: getComputedStyle(text).opacity, inert: !!text.closest('[inert]'),
      open: (element as HTMLDetailsElement).open });
    const frames = [read(0)];
    const originalAnimate = element.animate;
    let started: (animation: Animation) => void;
    // Pause synchronously at creation so CI frame cadence cannot skip a short transition.
    element.animate = function (...args) {
      const animation = originalAnimate.apply(this, args);
      animation.pause();
      started(animation);
      return animation;
    };
    const toggle = async () => {
      const pending = new Promise<Animation>(resolve => { started = resolve; });
      summary.click();
      const animation = await pending;
      if (animation.effect!.getTiming().duration !== duration) throw new Error('Unexpected disclosure duration');
      return animation;
    };
    try {
      let animation = await toggle();
      for (const fraction of (reverse ? [0, .2, .4] : [0, .2, .5, .8, 1])) {
        animation.currentTime = duration * fraction;
        frames.push(read(duration * fraction));
      }
      let reversalJump = 0;
      if (reverse) {
        const before = element.getBoundingClientRect().height;
        animation = await toggle();
        animation.currentTime = 0;
        reversalJump = Math.abs(element.getBoundingClientRect().height - before);
        for (const fraction of [0, .2, .5, .8, 1]) {
          animation.currentTime = duration * fraction;
          frames.push(read(duration * (.4 + fraction)));
        }
      }
      animation.finish();
      await animation.finished;
      frames.push(read(duration * (reverse ? 1.4 : 1)));
      return { frames, reversalJump };
    } finally {
      element.animate = originalAnimate;
    }
  }, { reverse, duration: motionDurations.reveal * 1000 });
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
    // These samples are at known animation times, rather than accidental painted frames.
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
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/settings');
    const details = page.locator('.budget-details');
    await details.locator('summary').click();
    const daily = page.getByRole('textbox', { name: 'Daily limit (USD)', exact: true });
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
  await expect(model.getByRole('textbox', { name: /^Maximum output tokens/ })).toBeVisible();
});
