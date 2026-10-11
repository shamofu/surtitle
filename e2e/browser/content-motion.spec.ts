// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`playback numbers update immediately without snapshots and retain the latest state (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    const slider = page.getByRole('slider', { name: 'Playback position' });
    await expect(slider).toBeEnabled();
    const observations = await page.evaluate(async () => {
      const fixture = (window as any).__learningFixture;
      const time = document.querySelector('.player-time')!;
      const tick = async (value: number) => {
        fixture.state.positionMs = value;
        await fixture.call('player_control', { request: { action: 'pause' } });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return {
          text: time.textContent,
          snapshots: time.querySelectorAll('[data-motion-snapshot]').length,
          inert: [...time.querySelectorAll('[data-motion-snapshot]')].every(node => node.hasAttribute('inert') && node.getAttribute('aria-hidden') === 'true'),
          value: (document.querySelector('.seek-control input') as HTMLInputElement).value,
          duration: time.getAnimations({ subtree: true })
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
    expect(observations.nextSecond.text).toContain('1:17');
    expect(observations.nextSecond.value).toBe('77000');
    expect(observations.nextSecond.snapshots).toBe(0);
    expect(observations.nextSecond.duration).toEqual([]);
    expect(observations.rapid.every(item => item.snapshots === 0 && item.inert)).toBe(true);
    expect(observations.rapid.at(-1)?.text).toContain('1:20');
    await expect(slider).toHaveValue('80000');
    await expect(page.locator('.player-time [data-motion-snapshot]')).toHaveCount(0);
  });
}

test('rapid subtitle and search changes keep current text opaque without stale rows or replacing the input', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light', { segmentOverrides: {
    11: { text: 'First rapid caption' }, 12: { text: 'Second rapid caption' }, 13: { text: 'Latest rapid caption' },
  } });
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  const observations = await page.evaluate(async () => {
    const fixture = (window as any).__learningFixture;
    const changes = [];
    for (const [index, expected] of [[11, 'First rapid caption'], [12, 'Second rapid caption'], [13, 'Latest rapid caption']] as const) {
      changes.push(await new Promise<{ text: string | null; opacity: string; snapshots: number; animations: number }>((resolve, reject) => {
        const caption = document.querySelector('.current-caption')!;
        const cleanup = () => { observer.disconnect(); clearTimeout(timeout); };
        // React may commit after the next animation frame on a busy runner.
        // Sample in the commit's microtask, before any paint or fade can elapse.
        const observer = new MutationObserver(() => {
          const source = caption.querySelector('.current-caption-text')!;
          if (source.textContent !== expected) return;
          cleanup();
          resolve({ text: source.textContent, opacity: getComputedStyle(source).opacity,
            snapshots: caption.querySelectorAll('[data-motion-snapshot]').length,
            animations: source.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect
              && animation.effect.getKeyframes().some(frame => frame.opacity !== undefined || frame.transform !== undefined)).length });
        });
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`Caption did not commit: ${expected}`)); }, 5000);
        observer.observe(caption, { childList: true, characterData: true, subtree: true });
        void fixture.call('player_control', { request: { action: 'seek', value: index * 7000 + 10 } })
          .catch((error: unknown) => { cleanup(); reject(error); });
      }));
    }
    return changes;
  });
  expect(observations.map(item => item.text)).toEqual(['First rapid caption', 'Second rapid caption', 'Latest rapid caption']);
  expect(observations.every(item => item.opacity === '1' && item.snapshots === 0 && item.animations === 0)).toBe(true);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  const input = page.getByLabel('Search transcript');
  const original = await input.elementHandle();
  const searches = await input.evaluate(async input => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const observations = [];
    for (const query of ['coast', 'sea', 'detour', 'hurry']) {
      observations.push(await new Promise<{ query: string; texts: string[]; opacity: string[]; snapshots: number }>((resolve, reject) => {
        const transcript = input.closest('.study-transcript')!;
        const cleanup = () => { observer.disconnect(); clearTimeout(timeout); };
        const observer = new MutationObserver(() => {
          const rows = [...transcript.querySelectorAll('.transcript-row .segment-text')];
          const texts = rows.map(row => row.textContent!.toLowerCase());
          if (!texts.length || !texts.every(text => text.includes(query))) return;
          cleanup();
          resolve({ query, texts, opacity: rows.map(row => getComputedStyle(row).opacity),
            snapshots: transcript.querySelectorAll('[data-motion-snapshot]').length });
        });
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`Search results did not commit: ${query}`)); }, 5000);
        observer.observe(transcript, { childList: true, characterData: true, subtree: true });
        setValue.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }));
    }
    return observations;
  });
  for (const item of searches) {
    expect(item.texts.length).toBeGreaterThan(0);
    expect(item.texts.every(text => text.includes(item.query))).toBe(true);
    expect(item.opacity.every(opacity => opacity === '1')).toBe(true);
    expect(item.snapshots).toBe(0);
  }
  await expect(input).toHaveValue('hurry');
  expect(await original!.evaluate(element => element === document.querySelector('input[aria-label="Search transcript"]'))).toBe(true);
});

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
