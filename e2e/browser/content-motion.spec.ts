// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`playback numbers crossfade only formatted changes and always retain the latest state (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    const slider = page.getByRole('slider', { name: 'Playback position' });
    await expect(slider).toBeEnabled();
    const observations = await page.evaluate(async () => {
      const fixture = (window as any).__learningFixture;
      const time = document.querySelector('.player-time > .animated-value')!;
      const tick = async (value: number) => {
        fixture.state.positionMs = value;
        await fixture.call('player_control', { request: { action: 'pause' } });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return {
          text: time.querySelector(':scope > .motion-swap-live')!.textContent,
          snapshots: time.querySelectorAll('[data-motion-snapshot]').length,
          inert: [...time.querySelectorAll('[data-motion-snapshot]')].every(node => node.hasAttribute('inert') && node.getAttribute('aria-hidden') === 'true'),
          value: (document.querySelector('.seek-control input') as HTMLInputElement).value,
          duration: time.querySelector(':scope > .motion-swap-live')!.getAnimations()
            .filter(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.opacity !== undefined))
            .map(animation => animation.effect?.getTiming().duration),
        };
      };
      const sameSecond = await tick(76100);
      const nextSecond = await tick(77000);
      const rapid = [];
      for (const value of [78000, 79000, 80000]) rapid.push(await tick(value));
      return { sameSecond, nextSecond, rapid };
    });
    expect(observations.sameSecond.snapshots).toBe(0);
    expect(observations.nextSecond.text).toBe('1:17');
    expect(observations.nextSecond.value).toBe('77000');
    if (reducedMotion === 'no-preference') {
      expect(observations.nextSecond.snapshots).toBe(1);
      expect(observations.nextSecond.duration).toEqual([140]);
    } else expect(observations.nextSecond.snapshots).toBe(0);
    expect(observations.rapid.every(item => item.snapshots <= 1 && item.inert)).toBe(true);
    expect(observations.rapid.at(-1)?.text).toBe('1:20');
    await expect(slider).toHaveValue('80000');
    await expect(page.locator('.player-time [data-motion-snapshot]')).toHaveCount(0);
  });
}

test('language and theme changes preserve the transcript input and leave native video ancestors opaque', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const search = page.getByLabel('Search transcript');
  await search.fill('coast');
  const original = await search.elementHandle();
  await page.getByRole('button', { name: '日本語に切り替える', exact: true }).click();
  await expect(page.getByLabel('字幕を検索')).toHaveValue('coast');
  expect(await original!.evaluate(element => element === document.querySelector('input[aria-label="字幕を検索"]'))).toBe(true);
  await page.getByRole('button', { name: 'テーマを切り替える', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('.native-player-viewport').evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.opacity !== '1' || style.transform !== 'none' || style.translate !== 'none') return false;
    }
    return true;
  })).toBe(true);
});
