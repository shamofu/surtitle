// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { motionDurations } from '../../src/shared/motion';

async function pose(element: Locator) {
  return element.evaluate(element => {
    const style = getComputedStyle(element);
    const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
    return { x: matrix.m41, y: matrix.m42, opacity: Number(style.opacity) };
  });
}

/** Hold the real browser's rendered transition, without replacing its update or snapshots. */
async function installPageTransitionProbe(page: Page, hold = false, missing?: 'api' | 'types' | 'active', holdFirstUpdate = false) {
  await page.addInitScript(({ hold, missing, holdFirstUpdate }) => {
    const probe = { hold, records: [] as any[], updatePending: false, releaseUpdate: undefined as (() => void) | undefined };
    (window as any).__pageTransitionProbe = probe;
    if (missing === 'api') {
      Object.defineProperty(document, 'startViewTransition', { value: undefined, configurable: true });
      return;
    }
    if (missing === 'types') {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = ((...args: string[]) => args[0].includes('active-view-transition-type')
        ? false : args.length === 1 ? supports(args[0]) : supports(args[0], args[1])) as typeof CSS.supports;
    }
    if (missing === 'active') {
      for (let owner: object | null = document; owner; owner = Object.getPrototypeOf(owner)) {
        if (Object.hasOwn(owner, 'activeViewTransition')) Reflect.deleteProperty(owner, 'activeViewTransition');
      }
    }
    if (typeof document.startViewTransition !== 'function') return;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((options: any) => {
      let actualOptions = options;
      if (holdFirstUpdate && probe.records.length === 0) {
        const gate = new Promise<void>(resolve => { probe.releaseUpdate = resolve; });
        const update = typeof options === 'function' ? options : options.update;
        const delayedUpdate = async () => {
          probe.updatePending = true;
          await gate;
          return update?.();
        };
        actualOptions = typeof options === 'function' ? delayedUpdate : { ...options, update: delayedUpdate };
      }
      const transition = start(actualOptions);
      const record = { transition, ready: false, finished: false, animations: [] as Animation[] };
      probe.records.push(record);
      void transition.ready.then(() => {
        record.animations = document.getAnimations().filter(animation =>
          (animation.effect as KeyframeEffect | null)?.pseudoElement?.includes('main-page'));
        if (probe.hold) for (const animation of record.animations) animation.pause();
        record.ready = true;
      }, () => {});
      void transition.finished.then(() => { record.finished = true; }, () => { record.finished = true; });
      return transition;
    }) as typeof document.startViewTransition;
  }, { hold, missing, holdFirstUpdate });
}

async function transitionCount(page: Page) {
  return page.evaluate(() => (window as any).__pageTransitionProbe.records.length as number);
}

async function waitForTransition(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => (window as any).__pageTransitionProbe.records
    .filter((record: any) => record.ready).length)).toBe(count);
}

async function transitionPose(page: Page, progress: number) {
  return page.evaluate(progress => {
    const record = (window as any).__pageTransitionProbe.records.at(-1);
    for (const animation of record.animations as Animation[]) {
      animation.currentTime = Number(animation.effect!.getTiming().duration) * progress;
    }
    const read = (kind: 'old' | 'new') => {
      const style = getComputedStyle(document.documentElement, `::view-transition-${kind}(main-page)`);
      const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
      return { x: matrix.m41, y: matrix.m42, opacity: Number(style.opacity) };
    };
    return { old: read('old'), next: read('new'), width: document.querySelector('.page-content')!.getBoundingClientRect().width };
  }, progress);
}

async function finishPageTransition(page: Page) {
  await page.evaluate(async () => {
    const record = (window as any).__pageTransitionProbe.records.at(-1);
    for (const animation of record.animations as Animation[]) animation.finish();
    await record.transition.finished;
  });
}

async function expectMainPageSettled(page: Page, selector: string) {
  await expect.poll(() => page.evaluate(() => (window as any).__pageTransitionProbe.records
    .every((record: any) => record.finished))).toBe(true);
  await expect(page.locator('.page-content > .library-page, .page-content > .phrases-page, .page-content > .review-page, .page-content > .settings-page')).toHaveCount(1);
  expect(await pose(page.locator(selector))).toEqual({ x: 0, y: 0, opacity: 1 });
  await expect(page.locator('.page-content')).toHaveCSS('transform', 'none');
}

test('main pages push together in tab order for direct and history navigation', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installPageTransitionProbe(page, true);
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/');
  await expect(page.locator('.media-card').first()).toBeVisible();
  expect(await transitionCount(page), 'Initial display has no previous page to push').toBe(0);
  const header = await page.locator('.topbar').boundingBox();
  const capturedDirections = new Set<number>();
  const steps = [
    { path: '/cards', selector: '.phrases-page', direction: 1, action: 'link' },
    { path: '/settings', selector: '.settings-page', direction: 1, action: 'link' },
    { path: '/cards', selector: '.phrases-page', direction: -1, action: 'back' },
    { path: '/settings', selector: '.settings-page', direction: 1, action: 'forward' },
    { path: '/review', selector: '.review-page', direction: -1, action: 'link' },
    { path: '/', selector: '.library-page', direction: -1, action: 'link' },
  ];
  for (const [index, step] of steps.entries()) {
    if (step.action === 'back') await page.goBack();
    else if (step.action === 'forward') await page.goForward();
    else {
      const link = page.locator(`.main-nav a[href="${step.path}"]`);
      await link.click();
    }
    await waitForTransition(page, index + 1);
    await expect(page.locator(step.selector)).toHaveCount(1);
    await expect(page.locator(`.main-nav a[href="${step.path}"]`)).toHaveAttribute('aria-current', 'page');
    if (index === 0 || step.path === '/review') await expect(page.locator(`.main-nav a[href="${step.path}"]`)).toBeFocused();
    const early = await transitionPose(page, .25);
    const late = await transitionPose(page, .75);
    for (const sample of [early, late]) {
      expect(sample.old.x * step.direction).toBeLessThan(0);
      expect(sample.next.x * step.direction).toBeGreaterThan(0);
      expect(Math.abs(sample.next.x - sample.old.x)).toBeCloseTo(sample.width, 0);
      expect([sample.old.y, sample.next.y, sample.old.opacity, sample.next.opacity]).toEqual([0, 0, 1, 1]);
    }
    expect((late.old.x - early.old.x) * step.direction).toBeLessThan(0);
    expect((late.next.x - early.next.x) * step.direction).toBeLessThan(0);
    expect(await page.locator('.topbar').boundingBox()).toEqual(header);
    if (!capturedDirections.has(step.direction)) {
      await transitionPose(page, .5);
      await page.screenshot({ path: testInfo.outputPath(`main-page-${step.direction === 1 ? 'forward' : 'backward'}-midpoint.png`) });
      capturedDirections.add(step.direction);
    }
    // Pixels may overlap during the push; there is still only one live route.
    await expect(page.locator('.library-page, .phrases-page, .review-page, .settings-page')).toHaveCount(1);
    await finishPageTransition(page);
    await expectMainPageSettled(page, step.selector);
  }
});

test('same-page and settings-category changes do not push a main page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installPageTransitionProbe(page);
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/settings');
  await expect(page.locator('#settings-nav-learning')).toBeVisible();
  await page.locator('.main-nav a[href="/settings"]').click();
  await page.locator('#settings-nav-appearance').click();
  await expect(page.locator('#settings-nav-appearance')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#appearance')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#settings-nav-learning')).toHaveAttribute('aria-pressed', 'true');
  expect(await transitionCount(page)).toBe(0);
});

for (const interruption of ['resize', 'reduce'] as const) {
  test(`an interrupted push settles the latest page after rapid navigation (${interruption})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installPageTransitionProbe(page, true);
    await installLearningFixture(page, 'en', 'dark');
    await page.goto('/');
    await expect(page.locator('.media-card').first()).toBeVisible();
    for (const [index, path] of ['/review', '/settings', '/cards'].entries()) {
      // Keep each actual transition paused so the next navigation interrupts it.
      await page.locator(`.main-nav a[href="${path}"]`).click();
      await waitForTransition(page, index + 1);
      await transitionPose(page, .25);
    }
    if (interruption === 'resize') await page.setViewportSize({ width: 1024, height: 700 });
    else await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectMainPageSettled(page, '.phrases-page');
    await page.getByRole('textbox', { name: 'Search your phrases' }).fill('detour');
    await expect(page.locator('.phrase-card')).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Search your phrases' })).toHaveValue('detour');
  });
}

test('navigation to Study during pending capture discards the superseded main page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installPageTransitionProbe(page, false, undefined, true);
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/');
  await expect(page.locator('.media-card').first()).toBeVisible();
  await page.evaluate(() => {
    let staleCardsMounted = false;
    const observer = new MutationObserver(records => {
      staleCardsMounted ||= records.some(record => [...record.addedNodes].some(node => node instanceof Element
        && (node.matches('.phrases-page') || !!node.querySelector('.phrases-page'))));
    });
    observer.observe(document.querySelector('.page-content')!, { childList: true, subtree: true });
    (window as any).__pendingPageObservation = () => { observer.disconnect(); return staleCardsMounted; };
  });
  await page.locator('.main-nav a[href="/cards"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__pageTransitionProbe.updatePending)).toBe(true);
  expect(await page.evaluate(() => (window as any).__pageTransitionProbe.records[0].ready)).toBe(false);
  // Capture suppresses rendering until this update resolves. Dispatch through the
  // live link to exercise competing navigation without relying on pointer hit testing.
  await page.locator('a.media-card[href="/study/visual-fixture"]').evaluate((link: HTMLElement) => link.click());
  await page.evaluate(() => (window as any).__pageTransitionProbe.releaseUpdate());
  await expect(page).toHaveURL(/\/study\/visual-fixture$/);
  await expect(page.getByRole('button', { name: 'Explore meaning', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__pageTransitionProbe.records[0].finished)).toBe(true);
  await expect(page.locator('.library-page, .phrases-page')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pendingPageObservation())).toBe(false);
  expect(await transitionCount(page), 'Study must not start another capture').toBe(1);
  expect(errors).toEqual([]);
});

test('reduced motion switches main pages immediately without a push', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installPageTransitionProbe(page);
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/');
  await expect(page.locator('.media-card').first()).toBeVisible();
  for (const [path, selector] of [['/cards', '.phrases-page'], ['/review', '.review-page'], ['/settings', '.settings-page'], ['/', '.library-page']]) {
    await page.locator(`.main-nav a[href="${path}"]`).click();
    await expectMainPageSettled(page, selector);
  }
  expect(await transitionCount(page)).toBe(0);
});

for (const missingCapability of ['api', 'types', 'active'] as const) {
  test(`missing View Transition ${missingCapability} retains directional entrance and usable pages`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.install();
    await installPageTransitionProbe(page, false, missingCapability);
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await expect(page.locator('.media-card').first()).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    for (const [path, selector, direction] of [['/cards', '.phrases-page', 1], ['/', '.library-page', -1]] as const) {
      await page.locator(`.main-nav a[href="${path}"]`).evaluate((link: HTMLElement) => link.click());
      const current = page.locator(selector);
      await expect(current).toBeAttached();
      expect((await pose(current)).x * direction).toBeGreaterThan(0);
      await page.clock.runFor(motionDurations.content * 1000 + 150);
      expect(await pose(current)).toEqual({ x: 0, y: 0, opacity: 1 });
      await expect(current.locator('h1')).toBeInViewport({ ratio: 1 });
    }
    expect(await transitionCount(page)).toBe(0);
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`main page navigation keeps controls reachable and resets page scroll (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.clock.install();
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/');
    await expect(page.locator('.media-card').first()).toBeVisible();
    await page.evaluate(() => {
      const fixture = (window as any).__learningFixture;
      const original = fixture.snapshot.media[1];
      fixture.snapshot.media.push(...Array.from({ length: 20 }, (_, index) => ({ ...original, id: `navigation-${index}`, title: `Navigation material ${index}` })));
      fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'media' });
    });
    await expect(page.locator('.media-row')).toHaveCount(22);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 200; });
    expect(await page.locator('.page-content').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    for (const [path, selector, direction] of [
      ['/cards', '.phrases-page', 'forward'],
      ['/review', '.review-page', 'forward'],
      ['/settings', '.settings-page', 'forward'],
      ['/review', '.review-page', 'backward'],
      ['/', '.library-page', 'backward'],
    ]) {
      await page.locator(`.main-nav a[href="${path}"]`).evaluate((element: HTMLElement) => element.click());
      const current = page.locator(selector);
      await expect(current).toBeAttached();
      await expect(page.locator('.page-content')).toHaveAttribute('data-page-direction', direction);
      await expect(page.locator(`.main-nav a[href="${path}"]`)).toHaveAttribute('aria-current', 'page');
      const stage = page.locator('.page-content');
      await expect(stage).toHaveCSS('overflow-x', 'hidden');
      await stage.evaluate(element => {
        const samples: number[] = [];
        let frame = 0;
        const sample = () => { samples.push(element.scrollLeft); };
        const tick = () => { sample(); frame = requestAnimationFrame(tick); };
        element.addEventListener('scroll', sample);
        tick();
        (window as any).__routeScrollProbe = { stop: () => {
          cancelAnimationFrame(frame); element.removeEventListener('scroll', sample); return samples;
        } };
      });
      await stage.hover();
      await page.mouse.wheel(240, 0);
      await page.clock.runFor(16);
      await page.mouse.wheel(-240, 0);
      await page.clock.runFor(16);
      await page.clock.runFor(motionDurations.content * 1000 + 150);
      const horizontalFrames = await page.evaluate(() => (window as any).__routeScrollProbe.stop() as number[]);
      expect(horizontalFrames.length).toBeGreaterThan(2);
      expect(horizontalFrames.every(left => left === 0), 'horizontal wheel input cannot pan the animated route stage').toBe(true);
      expect(await pose(current)).toEqual({ x: 0, y: 0, opacity: 1 });
      expect(await page.locator('.page-content').evaluate(element => element.scrollTop)).toBe(0);
      await expect(page.locator('.page-content')).toHaveCSS('transform', 'none');
      await expect(current.locator('h1')).toBeInViewport({ ratio: 1 });
      if (path === '/') {
        const lastMaterial = current.locator('.media-row').last();
        await lastMaterial.scrollIntoViewIfNeeded();
        await expect(lastMaterial).toBeInViewport({ ratio: 1 });
        expect(await stage.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        expect(await stage.evaluate(element => element.scrollLeft)).toBe(0);
      }
    }
  });
}

test('rapid main navigation and live motion reduction settle only the latest page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/');
  await expect(page.locator('.media-card').first()).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  for (const path of ['/review', '/settings', '/cards']) {
    await page.locator(`.main-nav a[href="${path}"]`).evaluate((element: HTMLElement) => element.click());
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.clock.runFor(40);
  }
  const current = page.locator('.phrases-page');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  expect(await pose(current)).toEqual({ x: 0, y: 0, opacity: 1 });
  await expect(page.locator('.review-page, .settings-page')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search your phrases' })).toBeEnabled();
  await page.clock.runFor(1000);
  expect(await pose(current)).toEqual({ x: 0, y: 0, opacity: 1 });
});

test('main navigation never animates a native player ancestor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installPageTransitionProbe(page);
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/cards');
  await page.locator('.main-nav a[href="/"]').click();
  await expectMainPageSettled(page, '.library-page');
  const mainTransitions = await transitionCount(page);
  await page.locator('a.media-card[href="/study/visual-fixture"]').click();
  await expect(page.getByRole('button', { name: 'Explore meaning', exact: true })).toBeEnabled();
  await expect(page.locator('.page-content')).toHaveAttribute('data-page-direction', 'none');
  expect(await page.getByTestId('native-player-viewport').evaluate(async element => {
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise(requestAnimationFrame);
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.transform !== 'none' || style.translate !== 'none' || style.opacity !== '1') return false;
      }
    }
    return true;
  })).toBe(true);
  expect(await transitionCount(page), 'Entering Study must not snapshot a native player').toBe(mainTransitions);
  await page.locator('.main-nav a[href="/review"]').click();
  await expect(page.locator('.review-page')).toBeVisible();
  await expect(page.locator('.page-content')).toHaveCSS('transform', 'none');
  expect(await transitionCount(page), 'Leaving Study must not retain a native player snapshot').toBe(mainTransitions);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 920, height: 620 }]) {
  test(`review title, card and rating controls remain reachable (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLearningFixture(page, viewport.width === 1024 ? 'ja' : 'en', 'light');
    await page.goto('/review');
    const review = page.locator('.review-page');
    await expect(review.locator('.review-card')).toBeVisible();
    await expect(review.locator('.review-title')).toBeInViewport();
    await expect(review.locator('.review-card')).toBeInViewport();
    const [title, card] = await Promise.all([review.locator('.review-title').boundingBox(), review.locator('.review-card').boundingBox()]);
    expect(title!.y + title!.height).toBeLessThanOrEqual(card!.y + 1);
    await review.getByRole('button', { name: /Reveal meaning|意味を確認する/ }).click();
    for (const rating of await review.locator('.rating-buttons button').all()) await expect(rating).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
