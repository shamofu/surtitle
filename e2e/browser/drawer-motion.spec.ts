// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { sampleDrawer, expectSafeFrames, expectContinuous } from './drawer-motion-fixture';
import { installLearningFixture } from './learning-fixture';

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 800, height: 900 }]) {
    test(`drawer moves continuously without overlap ${locale} ${theme} ${size.width}x${size.height}`, async ({ page }, info) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await installLearningFixture(page, locale, theme);
      await page.goto('/study/visual-fixture');
      await page.waitForLoadState('networkidle');
      const toggle = page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true });
      await expect(page.getByRole('slider', { name: locale === 'ja' ? '再生位置' : 'Playback position' })).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const desktop = size.width >= 1000;
      const initialVideo = await page.getByTestId('native-player-viewport').boundingBox();
      const opening = await sampleDrawer(page);
      expect(opening.transitions).toEqual([{ property: desktop ? 'width' : 'height', duration: 220, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' }]);
      await info.attach('drawer-open-geometry.json', { body: JSON.stringify(opening.frames), contentType: 'application/json' });
      expectSafeFrames(opening.frames, desktop);
      expectContinuous(opening.frames, desktop, true);
      const last = opening.frames.at(-1)!;
      expect(last.hidden).toBe(false);
      expect(last.inert).toBe(false);
      expect(Math.abs(last.panel.right - last.dock.right)).toBeLessThan(1);
      if (desktop) expect(last.video.width).toBeLessThan(initialVideo!.width - 200);
      else {
        const tab = await toggle.boundingBox();
        expect(tab!.width).toBeGreaterThan(tab!.height);
        await expect(toggle.locator('span')).toHaveCSS('writing-mode', 'horizontal-tb');
      }
      await page.screenshot({ path: info.outputPath('drawer-open.png'), fullPage: true });
      const search = page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript');
      await search.fill('coast');
      const original = await search.elementHandle();
      if (!desktop) {
        // Return to the original viewport before measuring the pure toggle operation.
        await page.locator('.page-content').evaluate(element => { element.scrollTop = 0; });
      }
      const closing = await sampleDrawer(page);
      expect(closing.transitions).toEqual(opening.transitions);
      await info.attach('drawer-close-geometry.json', { body: JSON.stringify(closing.frames), contentType: 'application/json' });
      expectSafeFrames(closing.frames, desktop);
      expectContinuous(closing.frames, desktop, false);
      expect(closing.frames.filter(frame => !frame.expanded).every(frame => frame.inert)).toBe(true);
      expect(closing.frames.at(-1)?.hidden).toBe(true);
      await expect(toggle).toBeFocused();
      await expect(toggle).toBeVisible();
      await page.screenshot({ path: info.outputPath('drawer-closed.png'), fullPage: true });
      await toggle.click();
      await expect(search).toHaveValue('coast');
      expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    });
  }
}

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 800, height: 900 }]) {
    test(`reduced drawer settles immediately ${locale} ${theme} ${size.width}x${size.height}`, async ({ page }, info) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installLearningFixture(page, locale, theme);
      await page.goto('/study/visual-fixture');
      await page.waitForLoadState('networkidle');
      const toggle = page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true });
      await expect(toggle).toBeInViewport({ ratio: 1 });
      const readAfterToggle = () => toggle.evaluate(async button => {
        (button as HTMLButtonElement).click();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const dock = document.querySelector<HTMLElement>('.study-companion-dock')!;
        const panel = document.querySelector<HTMLElement>('.study-companion')!;
        const video = document.querySelector('.native-player-viewport')!.getBoundingClientRect();
        const rail = button.getBoundingClientRect();
        return { moving: dock.dataset.moving, hidden: panel.hidden, inert: panel.inert,
          expanded: button.getAttribute('aria-expanded'), animations: dock.getAnimations().length,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          clearOfVideo: video.right <= rail.x + 1 || video.bottom <= rail.y + 1 };
      });
      expect(await readAfterToggle()).toEqual({ moving: 'false', hidden: false, inert: false, expanded: 'true', animations: 0, horizontalOverflow: false, clearOfVideo: true });
      const search = page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript');
      await search.fill('coast');
      const original = await search.elementHandle();
      await page.screenshot({ path: info.outputPath('drawer-reduced-open.png'), fullPage: true });
      expect(await readAfterToggle()).toEqual({ moving: 'false', hidden: true, inert: true, expanded: 'false', animations: 0, horizontalOverflow: false, clearOfVideo: true });
      await expect(toggle).toBeFocused();
      await toggle.press('Enter');
      await expect(search).toHaveValue('coast');
      expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    });
  }
}

test('drawer reverses an unfinished close from its current size and preserves the same input', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  const toggle = page.getByRole('button', { name: 'Transcript', exact: true });
  await toggle.click();
  const search = page.getByLabel('Search transcript');
  await search.fill('coast');
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  const original = await search.elementHandle();
  const observed = await sampleDrawer(page, true);
  await info.attach('drawer-reversal-geometry.json', { body: JSON.stringify(observed.frames), contentType: 'application/json' });
  expect(observed.reversed).toBe(true);
  expectSafeFrames(observed.frames, true);
  const widths = observed.frames.map(frame => frame.dock.width);
  expect(Math.min(...widths)).toBeLessThan(widths[0] - 10);
  expect(Math.min(...widths)).toBeGreaterThan(44 + 2);
  expect(Math.abs(widths.at(-1)! - widths[0])).toBeLessThan(1);
  expect(Math.abs(widths[5] - widths[4]), 'reversal starts at the current interpolated width').toBeLessThan(1);
  expect(observed.transitions[0].duration).toBe(220);
  expect(observed.transitions[1].duration).toBeGreaterThan(0);
  expect(observed.transitions[1].duration).toBeLessThanOrEqual(220);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(search).toHaveValue('coast');
  expect(await original!.evaluate(element => element === document.querySelector('input[aria-label="Search transcript"]'))).toBe(true);
  await expect(page.locator('.study-companion')).not.toHaveAttribute('inert');
});

test('inner study tabs replace outgoing content immediately and animate only the incoming content', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByLabel('Search transcript').fill('coast');
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  const changes = await page.getByRole('tab', { name: 'Suggestions', exact: true }).evaluate(async button => {
    const dock = document.querySelector('.study-companion-dock')!;
    const width = dock.getBoundingClientRect().width;
    const { incoming, animation } = await new Promise<{ incoming: HTMLElement; animation: Animation }>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const incoming = document.querySelector('.suggestions-panel')?.closest<HTMLElement>('.study-motion-region');
        if (!incoming || incoming.hidden) return;
        observer.disconnect();
        const animations = incoming.getAnimations();
        if (animations.length !== 1) { reject(new Error(`Expected one incoming content animation, found ${animations.length}`)); return; }
        const animation = animations[0];
        animation.pause();
        animation.currentTime = 0;
        resolve({ incoming, animation });
      });
      observer.observe(dock, { subtree: true, attributes: true, childList: true });
      (button as HTMLButtonElement).click();
    });
    const outgoing = document.querySelector('.transcript-view')?.closest<HTMLElement>('.study-motion-region');
    const first = { outgoingHidden: !outgoing || outgoing.hidden, outgoingInert: !outgoing || outgoing.inert,
      incomingInert: incoming.inert, snapshots: dock.querySelectorAll('[data-motion-snapshot]').length,
      width: dock.getBoundingClientRect().width };
    const samples = [0, 25, 50, 75, 99].map(at => {
      animation.currentTime = at;
      return { opacity: Number(getComputedStyle(incoming).opacity), width: dock.getBoundingClientRect().width,
        // Global state-color transitions are intentional. A tab change must not
        // animate the outer drawer's geometry, transform, or opacity again.
        outerAnimations: dock.getAnimations().filter(item => !(item instanceof CSSTransition) ||
          !/^(color|background-color|border-(top|right|bottom|left)-color)$/.test(item.transitionProperty)).length };
    });
    const duration = animation.effect!.getTiming().duration;
    animation.finish();
    return { first, samples, width, duration, finalOpacity: Number(getComputedStyle(incoming).opacity) };
  });
  expect(changes.first).toEqual({ outgoingHidden: true, outgoingInert: true, incomingInert: false, snapshots: 0, width: changes.width });
  expect(changes.duration).toBe(100);
  expect(changes.finalOpacity).toBe(1);
  expect(changes.samples[0].opacity).toBe(0);
  expect(changes.samples[2].opacity).toBeGreaterThan(0);
  expect(changes.samples[2].opacity).toBeLessThan(1);
  expect(changes.samples.every(sample => sample.width === changes.width && sample.outerAnimations === 0), JSON.stringify(changes)).toBe(true);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
});

for (const settle of ['reduce', 'hidden', 'resize'] as const) {
  test(`drawer settles a pending close when ${settle} changes`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    const toggle = page.getByRole('button', { name: 'Transcript', exact: true });
    await toggle.click();
    await page.getByLabel('Search transcript').fill('coast');
    await page.waitForTimeout(260);
    await toggle.evaluate(button => (button as HTMLButtonElement).click());
    await expect(page.locator('.study-companion')).toHaveAttribute('inert');
    if (settle === 'reduce') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (settle === 'hidden') await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (settle === 'resize') await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.locator('.study-companion')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    if (settle === 'hidden') await page.evaluate(() => {
      delete (document as unknown as { hidden?: boolean }).hidden;
      delete (document as unknown as { visibilityState?: string }).visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await toggle.click();
    await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
    await expect(page.locator('.study-companion')).not.toHaveAttribute('inert');
    if (settle === 'resize') {
      await expect(toggle.locator('span')).toHaveCSS('writing-mode', 'horizontal-tb');
      const video = await page.getByTestId('native-player-viewport').boundingBox();
      const tab = await toggle.boundingBox();
      expect(video!.y + video!.height).toBeLessThanOrEqual(tab!.y + 1);
    }
  });
}
