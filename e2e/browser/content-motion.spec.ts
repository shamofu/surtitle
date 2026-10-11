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

test('rapid cues fade only the incoming live text for 90ms while search rows stay immediate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light', { segmentOverrides: {
    11: { text: 'First rapid caption' }, 12: { text: 'Second rapid caption' }, 13: { text: 'Latest rapid caption' },
  } });
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Show translation', exact: true }).click();
  const observations = await page.evaluate(async () => {
    const fixture = (window as any).__learningFixture;
    const changes = [];
    const original = document.querySelector('.current-caption-text')!;
    const originalTranslation = document.querySelector('.caption-translation')!;
    for (const [index, expected] of [[11, 'First rapid caption'], [12, 'Second rapid caption'], [13, 'Latest rapid caption']] as const) {
      changes.push(await new Promise<{
        text: string | null; opacity: number[]; snapshots: number; durations: (number | string | undefined)[];
        stable: boolean; opacityOnly: boolean;
      }>((resolve, reject) => {
        const caption = document.querySelector('.current-caption')!;
        const cleanup = () => { observer.disconnect(); clearTimeout(timeout); };
        // React may commit after the next animation frame on a busy runner.
        // Detect the committed cue and hold its timeline; do not race a 90ms fade.
        const observer = new MutationObserver(() => {
          const source = caption.querySelector('.current-caption-text')!;
          if (source.textContent !== expected) return;
          cleanup();
          const translation = caption.querySelector('.caption-translation')!;
          const animations = [source, translation].flatMap(node => node.getAnimations());
          animations.forEach(animation => { animation.pause(); animation.currentTime = 45; });
          resolve({ text: source.textContent,
            opacity: [source, translation].map(node => Number(getComputedStyle(node).opacity)),
            snapshots: caption.querySelectorAll('[data-motion-snapshot]').length,
            durations: animations.map(animation => animation.effect?.getTiming().duration),
            stable: source === original && translation === originalTranslation,
            opacityOnly: animations.every(animation => animation.effect instanceof KeyframeEffect
              && animation.effect.getKeyframes().every(frame => frame.opacity !== undefined && frame.transform === undefined)) });
        });
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`Caption did not commit: ${expected}`)); }, 5000);
        observer.observe(caption, { childList: true, characterData: true, subtree: true });
        void fixture.call('player_control', { request: { action: 'seek', value: index * 7000 + 10 } })
          .catch((error: unknown) => { cleanup(); reject(error); });
      }));
    }
    [original, originalTranslation].forEach(node => node.getAnimations().forEach(animation => animation.finish()));
    return changes;
  });
  expect(observations.map(item => item.text)).toEqual(['First rapid caption', 'Second rapid caption', 'Latest rapid caption']);
  for (const item of observations) {
    expect(item.durations).toEqual([90, 90]);
    expect(item.opacity.every(opacity => opacity > 0 && opacity < 1)).toBe(true);
    expect(item.snapshots).toBe(0);
    expect(item.stable && item.opacityOnly).toBe(true);
  }
  await expect(page.locator('.current-caption-text')).toHaveCSS('opacity', '1');
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

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`cue ticks, translation toggles and a cancelled selection do not start caption fades (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await installLearningFixture(page, 'en', 'light', { segmentOverrides: {
      11: { text: 'Second cue for selection' }, 12: { text: 'Latest cue after selection' },
    } });
    await page.addInitScript(() => {
      const animate = HTMLElement.prototype.animate;
      const starts: { className: string; duration: number | string | undefined }[] = [];
      Object.assign(window, { __captionMotionStarts: starts });
      HTMLElement.prototype.animate = function (frames, options) {
        if (this.matches('.current-caption-text, .caption-translation')) {
          starts.push({ className: this.className, duration: typeof options === 'number' ? options : options?.duration });
        }
        return animate.call(this, frames, options);
      };
    });
    await page.goto('/study/visual-fixture');
    const source = page.locator('.current-caption-text');
    await expect(source).toContainText('Sometimes the best way');
    const original = await source.elementHandle();
    const starts = () => page.evaluate(() => (window as any).__captionMotionStarts.length as number);
    expect(await starts()).toBe(0);
    await page.getByRole('button', { name: 'Show translation', exact: true }).click();
    await page.getByRole('button', { name: 'Hide translation', exact: true }).click();
    await page.evaluate(() => (window as any).__learningFixture.call('player_control', { request: { action: 'seek', value: 76100 } }));
    await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('76100');
    expect(await starts()).toBe(0);
    await source.dispatchEvent('pointerdown');
    await page.evaluate(() => (window as any).__learningFixture.call('player_control', { request: { action: 'seek', value: 77100 } }));
    await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('77100');
    await expect(source).toContainText('Sometimes the best way');
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
    await expect(source).toHaveText('Second cue for selection');
    expect(await starts()).toBe(0);
    await expect(source).toHaveCSS('opacity', '1');
    expect(await original!.evaluate(node => node === document.querySelector('.current-caption-text'))).toBe(true);
    await page.evaluate(() => (window as any).__learningFixture.call('player_control', { request: { action: 'seek', value: 84010 } }));
    await expect(source).toHaveText('Latest cue after selection');
    expect(await starts()).toBe(reducedMotion === 'reduce' ? 0 : 1);
    await expect(source).toHaveCSS('opacity', '1');
  });
}
