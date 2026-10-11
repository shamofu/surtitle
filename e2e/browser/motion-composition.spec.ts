// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

test('rapid keyboard tab changes and drawer reversal retain the search and focus owner', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByLabel('Search transcript').fill('coast');

  const result = await page.evaluate(async () => {
    const committed = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
      if (predicate()) { resolve(); return; }
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Study state did not commit')); }, 5000);
      const observer = new MutationObserver(() => {
        if (predicate()) { observer.disconnect(); clearTimeout(timeout); resolve(); }
      });
      observer.observe(document.body, { childList: true, attributes: true, subtree: true });
    });
    const originalAnimate = Element.prototype.animate;
    let indicatorStarts = 0;
    Element.prototype.animate = function (...args) {
      const animation = originalAnimate.apply(this, args);
      if (this.matches('.transcript-tabs > .selection-indicator')) {
        indicatorStarts++;
        animation.pause();
        animation.currentTime = 80;
      }
      return animation;
    };
    try {
      const transcript = document.querySelector<HTMLButtonElement>('.transcript-tabs [role="tab"]')!;
      const suggestions = [...document.querySelectorAll<HTMLButtonElement>('.transcript-tabs [role="tab"]')].at(-1)!;
      transcript.focus();
      transcript.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      await committed(() => suggestions.getAttribute('aria-selected') === 'true');
      const selectedFocus = document.activeElement === suggestions;
      suggestions.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await committed(() => transcript.getAttribute('aria-selected') === 'true' && !!document.querySelector('input[aria-label="Search transcript"]'));
      const search = document.querySelector<HTMLInputElement>('input[aria-label="Search transcript"]')!;
      const tabFocus = document.activeElement === transcript;
      const panel = document.querySelector<HTMLElement>('.study-companion')!;
      const toggle = document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!;
      const close = panel.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')!;
      close.focus();
      close.click();
      await committed(() => panel.hidden);
      const closeFocus = document.activeElement === toggle;
      toggle.click();
      await committed(() => !panel.hidden);
      const retained = search === document.querySelector('input[aria-label="Search transcript"]');
      let safeVideo = true;
      for (let element: Element | null = document.querySelector('.native-player-viewport'); element; element = element.parentElement) {
        const style = getComputedStyle(element);
        safeVideo &&= style.opacity === '1' && style.transform === 'none' && style.translate === 'none';
      }
      return { indicatorStarts, selectedFocus, tabFocus, closeFocus, retained, value: search.value, safeVideo };
    } finally {
      Element.prototype.animate = originalAnimate;
      document.querySelectorAll('.selection-indicator').forEach(element => element.getAnimations().forEach(animation => animation.finish()));
    }
  });
  expect(result).toMatchObject({ selectedFocus: true, tabFocus: true, closeFocus: true, retained: true, value: 'coast', safeVideo: true });
  expect(result.indicatorStarts).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('tab', { name: 'Transcript', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('a disclosure inside the subtitle modal settles its geometry without moving the native shell', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      export const nativeAvailable = () => true;
      export const call = (command, args) => {
        if (command === 'list_media_streams') return Promise.resolve([{ index: 2, kind: 'subtitle', codec: 'subrip', language: 'eng', title: 'English captions', supportedText: true, isDefault: true }]);
        if (command === 'list_subtitle_versions') return Promise.resolve([]);
        return window.__learningFixture.call(command, args);
      };`,
  }));
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const opener = page.getByRole('button', { name: 'Add or switch subtitles', exact: true });
  await opener.click();
  const modal = page.getByRole('dialog', { name: 'Add or switch subtitles', exact: true });
  const details = modal.locator('details').filter({ has: page.getByText('Subtitle details', { exact: true }) });
  await expect(details).toBeVisible();
  const result = await details.evaluate(async element => {
    const modal = element.closest('[data-app-modal]')!;
    const summary = element.querySelector('summary')!;
    const read = () => ({ height: element.getBoundingClientRect().height, modalHeight: modal.getBoundingClientRect().height,
      transform: getComputedStyle(modal).transform, opacity: getComputedStyle(modal).opacity,
      animatedHeight: element.getAnimations().some(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.height !== undefined)) });
    const toggle = (open: boolean) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Modal disclosure did not commit')); }, 5000);
      const observer = new MutationObserver(() => {
        if ((element as HTMLDetailsElement).open === open) { observer.disconnect(); clearTimeout(timeout); resolve(); }
      });
      observer.observe(element, { attributes: true });
      summary.click();
    });
    const closed = read();
    await toggle(true);
    const opened = read();
    await new Promise(requestAnimationFrame);
    const nextFrame = read();
    await toggle(false);
    const closedAgain = read();
    return { closed, opened, nextFrame, closedAgain };
  });
  expect(result.opened.height).toBeGreaterThan(result.closed.height + 10);
  expect(result.opened).toEqual(result.nextFrame);
  expect(result.closedAgain.height).toBeCloseTo(result.closed.height, 1);
  for (const frame of Object.values(result)) expect(frame).toMatchObject({ transform: 'none', opacity: '1', animatedHeight: false });
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('a page entrance owns its subtree when an answer is revealed before that entrance ends', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/');
  await expect(page.locator('.media-card').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^Review/ })).toBeVisible();
  const result = await page.evaluate(async () => {
    const originalAnimate = Element.prototype.animate;
    let entrance: Animation | undefined;
    let entranceStarted!: () => void;
    const entering = new Promise<void>(resolve => { entranceStarted = resolve; });
    Element.prototype.animate = function (...args) {
      const animation = originalAnimate.apply(this, args);
      if (this.matches('.review-page')) { entrance = animation; animation.pause(); animation.currentTime = 60; entranceStarted(); }
      return animation;
    };
    const committed = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
      if (predicate()) { resolve(); return; }
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Review state did not commit')); }, 5000);
      const observer = new MutationObserver(() => {
        if (predicate()) { observer.disconnect(); clearTimeout(timeout); resolve(); }
      });
      observer.observe(document.body, { childList: true, attributes: true, subtree: true });
    });
    try {
      document.querySelector<HTMLAnchorElement>('.main-nav a[href="/review"]')!.click();
      await Promise.all([committed(() => !!document.querySelector('.review-answer.concealed button')), entering]);
      document.querySelector<HTMLButtonElement>('.review-answer.concealed button')!.click();
      await committed(() => !!document.querySelector('.review-card.revealed'));
      const page = document.querySelector('.review-page')!;
      // Enabled-button color/opacity transitions are separate feedback, not an entrance.
      const fades = page.getAnimations({ subtree: true }).filter(animation => !(animation instanceof CSSTransition)
        && !(animation instanceof CSSAnimation) && animation.effect instanceof KeyframeEffect
        && animation.effect.getKeyframes().some(frame => frame.opacity !== undefined));
      return { paused: entrance?.playState === 'paused', duration: entrance?.effect?.getTiming().duration,
        targets: fades.map(animation => (animation.effect as KeyframeEffect).target === page ? 'page' : 'child'),
        answer: document.querySelector('.review-answer')?.textContent,
        enabled: [...document.querySelectorAll<HTMLButtonElement>('.rating-button')].every(button => !button.disabled) };
    } finally {
      Element.prototype.animate = originalAnimate;
      entrance?.finish();
    }
  });
  expect(result).toMatchObject({ paused: true, duration: 160, targets: ['page'], enabled: true });
  expect(result.answer).toContain('少し寄り道をする');
});

test('live reduced motion cancels a paused tab indicator and leaves only the latest panel interactive', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>('.transcript-tabs > .selection-indicator')!;
    const originalAnimate = marker.animate;
    marker.animate = function (...args) {
      const animation = originalAnimate.apply(this, args);
      animation.pause();
      animation.currentTime = 60;
      return animation;
    };
  });
  await page.getByRole('tab', { name: 'Suggestions', exact: true }).click();
  const marker = page.locator('.transcript-tabs > .selection-indicator');
  await expect.poll(() => marker.evaluate(element => element.getAnimations().map(animation => animation.playState))).toEqual(['paused']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => marker.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Suggestions', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await marker.evaluate(element => {
    const selected = element.parentElement!.querySelector('[aria-selected="true"]')!;
    return Math.abs(element.getBoundingClientRect().left - selected.getBoundingClientRect().left);
  })).toBeLessThan(.5);
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  expect(await marker.evaluate(element => element.getAnimations().length)).toBe(0);
});
