// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { installLearningFixture } from './learning-fixture';
import { recordScreencast } from './drawer-motion-fixture';

test.use({ video: { mode: 'on', size: { width: 1440, height: 1000 } } });

declare global { interface Window { __drawerFrameRequested?: boolean } }

/** Advance Motion's RAF clock only when the observation requests another frame.
 * Async React/IPC commits run at a fixed pose, even on a saturated CI worker. */
async function runDrawerFrames<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  let settled = false;
  const result = action().finally(() => { settled = true; });
  // Attach a rejection handler while driving frames; the original promise below
  // still reports the action's error without an unhandled rejection race.
  void result.catch(() => {});
  while (!settled) {
    const requested = await page.evaluate(() => {
      const requested = window.__drawerFrameRequested;
      window.__drawerFrameRequested = false;
      return requested;
    });
    if (requested) await page.clock.runFor(16);
  }
  return result;
}

async function installReviewFixture(page: Page) {
  await installLearningFixture(page, 'en', 'light', { cardCount: 2 });
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      const rated = new Set();
      export const nativeAvailable = () => true;
      export const call = async (command, args = {}) => {
        if (command === 'rate_card') { rated.add(args.cardId); return; }
        const result = await window.__learningFixture.call(command, args);
        if (command === 'get_app_snapshot') result.cards = result.cards.filter(card => !rated.has(card.id));
        return result;
      };`,
  }));
}

/** Keep real compositor frames alongside numeric observations, not simulated screenshots. */
async function record<T>(page: Page, info: TestInfo, name: string, action: () => Promise<T>): Promise<T> {
  const { observed: result, images } = await recordScreencast(page, action, 85);
  const observations = info.outputPath(`${name}-frames.json`);
  await writeFile(observations, JSON.stringify(result, null, 2));
  await info.attach(`${name}-frames.json`, { path: observations, contentType: 'application/json' });
  expect(images.length, 'actual browser frames were recorded').toBeGreaterThan(1);
  for (let index = 0; index < Math.min(images.length, 8); index++) {
    const path = info.outputPath(`${name}-${index + 1}.jpg`);
    await writeFile(path, Buffer.from(images[index].data, 'base64'));
    await info.attach(`${name}-${index + 1}.jpg`, { path, contentType: 'image/jpeg' });
  }
  return result;
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 920, height: 900 }]) {
  test(`opaque drawer reverses safely through simultaneous player and panel motion (${viewport.width}px)`, async ({ page }, info) => {
    await page.clock.install();
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
    const observed = await runDrawerFrames(page, () => record(page, info, 'drawer', () => page.evaluate(async () => {
      const toggle = document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!;
      const panel = document.querySelector<HTMLElement>('.study-companion')!;
      const dock = document.querySelector<HTMLElement>('.study-companion-dock')!;
      const video = document.querySelector<HTMLElement>('.native-player-viewport')!;
      const rail = document.querySelector<HTMLElement>('.study-transcript-rail')!;
      const frame = () => { window.__drawerFrameRequested = true; return new Promise(requestAnimationFrame); };
      const committed = async (open: boolean) => {
        const matches = () => toggle.getAttribute('aria-expanded') === String(open) && (open || panel.inert);
        if (matches()) return;
        await new Promise<void>(resolve => {
          const observer = new MutationObserver(() => { if (matches()) { observer.disconnect(); resolve(); } });
          observer.observe(dock, { subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'inert'] });
        });
      };
      const read = () => {
        const style = getComputedStyle(panel);
        const matrix = new DOMMatrix(style.transform);
        const box = video.getBoundingClientRect();
        const railBox = rail.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        const remaining = innerWidth < 1000 ? Math.abs(matrix.m42)
          : Math.max(0, parseFloat(getComputedStyle(dock).getPropertyValue('--study-panel-width')) - dock.getBoundingClientRect().width + 44);
        let nativeSafe = true;
        for (let node: Element | null = video; node; node = node.parentElement) {
          const ancestor = getComputedStyle(node);
          nativeSafe &&= ancestor.opacity === '1' && ancestor.transform === 'none' && ancestor.translate === 'none';
        }
        return { at: performance.now(), x: matrix.m41, y: matrix.m42, remaining, opacity: style.opacity, visibility: style.visibility,
          moving: dock.dataset.moving === 'true', hidden: panel.hidden, inert: panel.inert, nativeSafe,
          panelExtent: innerWidth < 1000 ? panelBox.height : panelBox.width,
          placement: video.dataset.nativePlacement, railX: railBox.x,
          video: { x: box.x, y: box.y, width: box.width, height: box.height }, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      };
      const settle = async () => {
        const samples = [];
        for (let index = 0; index < 120; index++) {
          await frame(); const sample = read(); samples.push(sample);
          if (index > 1 && !sample.moving) return samples;
        }
        throw new Error('Drawer did not settle at its requested endpoint');
      };
      const initial = read();
      toggle.click();
      await committed(true);
      const opening = await settle();
      toggle.click();
      await committed(false);
      const reversal = [];
      for (let index = 0; index < 120; index++) {
        await frame(); const current = read(); reversal.push(current);
        if (current.remaining > 8) break;
      }
      const before = read();
      toggle.click();
      // React may commit this asynchronous action after another compositor frame.
      // Measure the reversal from its committed state, not the click timestamp.
      await committed(true);
      const after = read();
      const reopening = await settle();
      reversal.push(...reopening);
      toggle.click();
      await committed(false);
      const closing = await settle();
      return { initial, opening, reversal, reopening, before, after, closing };
    })));
    const distance = (frame: typeof observed.before) => frame.remaining;
    const moving = observed.opening.filter(frame => frame.moving && frame.visibility === 'visible');
    expect(moving.filter(frame => distance(frame) > 1).length, 'visible intermediate slide frames').toBeGreaterThan(2);
    expect(new Set(moving.map(distance)).size).toBeGreaterThan(2);
    for (const frame of [...observed.opening, ...observed.reversal, ...observed.closing]) {
      expect(frame).toMatchObject({ opacity: '1', nativeSafe: true, overflow: false });
    }
    const finalWidth = observed.opening.at(-1)!.video.width;
    if (viewport.width >= 1000) {
      const resizing = observed.opening.filter(frame => frame.video.width > finalWidth + 1 && frame.video.width < observed.initial.video.width - 1);
      expect(new Set(resizing.map(frame => frame.video.width)).size, 'desktop player has intermediate resize widths').toBeGreaterThan(1);
      expect(resizing.every(frame => frame.visibility === 'visible')).toBe(true);
      for (const frame of [...observed.opening, ...observed.reversal, ...observed.closing]) {
        expect(frame.video.height).toBeCloseTo(observed.initial.video.height, 1);
        expect(frame.video.y).toBeCloseTo(observed.initial.video.y, 1);
        expect(frame.railX, 'rail never crosses the native video viewport').toBeGreaterThanOrEqual(frame.video.x + frame.video.width - 1);
      }
      for (const frame of moving) {
        expect(frame.video.width - finalWidth, 'drawer reveal and player resize share one progress').toBeCloseTo(frame.remaining, 1);
      }
      expect(observed.closing.some(frame => frame.video.width > finalWidth + 1 && frame.video.width < observed.initial.video.width - 1)).toBe(true);
      expect(observed.closing.at(-1)!.video.width).toBeCloseTo(observed.initial.video.width, 1);
    } else {
      for (const frame of moving) expect(frame.video).toEqual(moving[0].video);
      expect(finalWidth).toBe(observed.initial.video.width);
    }
    expect(observed.opening.at(-1)).toMatchObject({ hidden: false, moving: false, inert: false, x: 0, y: 0 });
    // A reversal continues from the current position, never teleports to the outer edge.
    expect(distance(observed.before)).toBeGreaterThan(8);
    expect(distance(observed.after), 'reversal retains an intermediate position').toBeLessThan(observed.after.panelExtent - 1);
    let previousDistance = distance(observed.after);
    for (const frame of observed.reopening) {
      expect(distance(frame), 'committed reversal moves toward the open endpoint').toBeLessThanOrEqual(previousDistance + 1);
      previousDistance = distance(frame);
    }
    expect(observed.after.visibility).toBe('visible');
    expect(observed.reversal.at(-1)).toMatchObject({ hidden: false, moving: false, inert: false, x: 0, y: 0 });
    expect(observed.closing.filter(frame => frame.moving).every(frame => frame.inert && !frame.hidden)).toBe(true);
    expect(observed.closing.at(-1)).toMatchObject({ hidden: true, moving: false, inert: true });
  });
}

test('closing during desktop reveal reverses both the panel and player from the current width', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  const observed = await runDrawerFrames(page, () => page.evaluate(async () => {
    const toggle = document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!;
    const panel = document.querySelector<HTMLElement>('.study-companion')!;
    const dock = document.querySelector<HTMLElement>('.study-companion-dock')!;
    const video = document.querySelector<HTMLElement>('.native-player-viewport')!;
    const frame = () => { window.__drawerFrameRequested = true; return new Promise(requestAnimationFrame); };
    const committed = async (open: boolean) => {
      const matches = () => toggle.getAttribute('aria-expanded') === String(open) && (open || panel.inert);
      if (matches()) return;
      await new Promise<void>(resolve => {
        const observer = new MutationObserver(() => { if (matches()) { observer.disconnect(); resolve(); } });
        observer.observe(dock, { subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'inert'] });
      });
    };
    const read = () => ({ width: video.getBoundingClientRect().width, moving: dock.dataset.moving === 'true',
      visibility: getComputedStyle(panel).visibility, hidden: panel.hidden, inert: panel.inert });
    const initial = read();
    toggle.click();
    await committed(true);
    for (let index = 0; index < 120; index++) {
      await frame();
      const before = read();
      if (initial.width - before.width <= 8 || before.visibility !== 'visible') continue;
      toggle.click();
      await committed(false);
      const after = read();
      const closing = [after];
      for (let closingFrame = 0; closingFrame < 120; closingFrame++) {
        await frame(); closing.push(read());
        if (!closing.at(-1)!.moving) return { initial, before, after, closing };
      }
      throw new Error('Interrupted resize did not finish closing');
    }
    throw new Error('Desktop resize did not produce an intermediate width');
  }));
  expect(observed.before.width).toBeLessThan(observed.initial.width - 8);
  expect(observed.after.width).toBeLessThanOrEqual(observed.initial.width + 1);
  let previousWidth = observed.after.width;
  for (const frame of observed.closing) {
    expect(frame.width, 'committed reversal expands from its visible width').toBeGreaterThanOrEqual(previousWidth - 1);
    previousWidth = frame.width;
  }
  expect(observed.closing.filter(frame => frame.moving).every(frame => frame.inert
    && (frame.visibility === 'visible' || Math.abs(frame.width - observed.initial.width) <= 1))).toBe(true);
  expect(observed.closing.at(-1)).toMatchObject({ hidden: true, moving: false, inert: true });
  expect(observed.closing.at(-1)!.width).toBeCloseTo(observed.initial.width, 1);
});

test('tab overlap keeps outgoing controls inert and preserves a composing input on reversal', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  const observed = await record(page, info, 'tabs', () => page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search transcript"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'unfinished 日本語'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus(); input.setSelectionRange(11, 14);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '日本語' }));
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.transcript-tabs [role="tab"]')];
    const transcript = tabs.find(tab => tab.textContent === 'Transcript')!;
    const suggestions = tabs.find(tab => tab.textContent === 'Suggestions')!;
    suggestions.click();
    const samples = [];
    for (let index = 0; index < 3; index++) {
      await new Promise(requestAnimationFrame);
      samples.push([...document.querySelectorAll<HTMLElement>('.transcript-tab-content > .study-motion-region:not([hidden])')].map(region => ({
        state: region.dataset.motionState, inert: region.inert, hiddenFromAT: region.getAttribute('aria-hidden'),
        opacity: Number(getComputedStyle(region).opacity), transform: getComputedStyle(region).transform,
        background: getComputedStyle(region).backgroundColor,
      })));
    }
    transcript.click();
    await new Promise(requestAnimationFrame);
    const retained = input === document.querySelector('input[aria-label="Search transcript"]');
    const value = input.value;
    const selection = [input.selectionStart, input.selectionEnd];
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));
    for (let index = 0; index < 16; index++) await new Promise(requestAnimationFrame);
    return { samples, retained, value, selection, connected: input.isConnected, finalOpacity: getComputedStyle(input.closest('.study-motion-region')!).opacity };
  }));
  expect(observed).toMatchObject({ retained: true, connected: true, value: 'unfinished 日本語', selection: [11, 14], finalOpacity: '1' });
  expect(observed.samples.some(sample => sample.length === 2)).toBe(true);
  for (const sample of observed.samples) {
    expect(sample.filter(region => !region.inert)).toHaveLength(1);
    expect(sample.filter(region => region.state === 'exiting').every(region => region.inert && region.hiddenFromAT === 'true')).toBe(true);
    expect(sample.every(region => region.opacity === 1), 'retained tab faces stay opaque through reversal').toBe(true);
    expect(sample.every(region => region.background !== 'rgba(0, 0, 0, 0)' && region.background !== 'transparent')).toBe(true);
  }
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
});

test('review reveal transfers focus and the next card wipes content over a stable face', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installReviewFixture(page);
  await page.goto('/review');
  await page.getByRole('button', { name: /Reveal meaning/ }).click();
  await expect(page.getByRole('heading', { name: 'Meaning', exact: true })).toBeFocused();
  await page.locator('.rating-button.good').focus();
  const observed = await record(page, info, 'review', () => page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('.rating-button.good')!.click();
    const frames = [];
    const visibleRange = (node: Element) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const parts = style.clipPath.match(/^inset\((.*)\)$/)?.[1].split(/\s+/) ?? ['0'];
      const right = parts[1] ?? parts[0];
      const left = parts[3] ?? right;
      const toPixels = (value: string) => parseFloat(value) * (value.endsWith('%') ? box.width / 100 : 1);
      const leftPixels = toPixels(left), rightPixels = toPixels(right);
      return { left: box.left + leftPixels, right: box.right - rightPixels,
        leftPercent: leftPixels / box.width * 100, rightPercent: rightPixels / box.width * 100, opacity: style.opacity, clip: style.clipPath };
    };
    for (let index = 0; index < 25; index++) {
      await new Promise(requestAnimationFrame);
      const card = document.querySelector<HTMLElement>('.motion-swap-live > .review-card')!;
      const outgoing = document.querySelector<HTMLElement>('.review-outgoing');
      const prompt = card.querySelector<HTMLElement>('.review-prompt')!;
      const rect = card.getBoundingClientRect();
      frames.push({ text: prompt.querySelector('h2')?.textContent, x: rect.x, width: rect.width,
        faceOpacity: getComputedStyle(card).opacity, faceTransform: getComputedStyle(card).transform,
        contentOpacity: Number(getComputedStyle(prompt).opacity), contentOffset: new DOMMatrix(getComputedStyle(prompt).transform).m41,
        outgoing: !!outgoing, inert: outgoing?.inert, hiddenFromAT: outgoing?.getAttribute('aria-hidden'),
        oldControls: outgoing?.querySelectorAll('button, input, select, textarea, a, [tabindex], [id]').length ?? 0,
        masks: outgoing ? [...card.children].map((node, childIndex) => ({
          incoming: visibleRange(node), outgoing: visibleRange(outgoing.querySelector('.review-card')!.children[childIndex]),
        })) : [],
      });
    }
    return { frames, focused: document.activeElement === document.querySelector('[data-review-focus]'),
      disabledRatings: [...document.querySelectorAll<HTMLButtonElement>('.rating-button')].every(button => button.disabled) };
  }));
  const next = observed.frames.filter(frame => frame.text?.startsWith('phrase 00001'));
  expect(next.length).toBeGreaterThan(2);
  expect(next.some(frame => frame.masks.some(pair => pair.incoming.leftPercent > 1 && pair.incoming.leftPercent < 99))).toBe(true);
  for (const frame of next) {
    expect(frame).toMatchObject({ faceOpacity: '1', faceTransform: 'none', contentOpacity: 1, contentOffset: 0, oldControls: 0, x: next[0].x, width: next[0].width });
    if (frame.outgoing) expect(frame).toMatchObject({ inert: true, hiddenFromAT: 'true' });
    for (const pair of frame.masks) {
      expect(pair.incoming.opacity).toBe('1');
      expect(pair.outgoing.opacity).toBe('1');
      expect(pair.incoming.leftPercent + pair.outgoing.rightPercent, 'complementary masks keep one readable content layer').toBeCloseTo(100, 1);
      expect(pair.outgoing.right, 'incoming and outgoing text never expose the same horizontal pixels').toBeLessThanOrEqual(pair.incoming.left + .5);
      expect(Math.abs(pair.outgoing.right - pair.incoming.left), 'the wipe has no empty vertical seam').toBeLessThan(.5);
    }
  }
  expect(observed).toMatchObject({ focused: true, disabledRatings: true });
  await expect(page.locator('.review-outgoing')).toHaveCount(0);
});

test('live reduced motion fully reveals a partially clipped review and preserves next prompt focus', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installReviewFixture(page);
  await page.goto('/review');
  await page.getByRole('button', { name: /Reveal meaning/ }).click();
  await page.locator('.rating-button.good').focus();
  const intermediate = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('.rating-button.good')!.click();
    for (let index = 0; index < 20; index++) {
      await new Promise(requestAnimationFrame);
      const prompt = document.querySelector<HTMLElement>('.motion-swap-live > .review-card > .review-prompt')!;
      const clip = getComputedStyle(prompt).clipPath;
      const leftPercent = Number(clip.match(/([\d.]+)%\)$/)?.[1] ?? 0);
      if (document.querySelector('.review-outgoing') && leftPercent > 1 && leftPercent < 99) return { clip, leftPercent };
    }
    throw new Error('Review transition did not produce a partially clipped frame');
  });
  await info.attach('review-reduction-intermediate.json', { body: JSON.stringify(intermediate), contentType: 'application/json' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.review-outgoing')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'phrase 00001 take a little detour', exact: true })).toBeFocused();
  const endpoint = await page.locator('.motion-swap-live > .review-card').evaluate(card => [...card.children].map(node => ({
    opacity: getComputedStyle(node).opacity, clip: getComputedStyle(node).clipPath,
    offset: new DOMMatrix(getComputedStyle(node).transform).m41,
  })));
  for (const child of endpoint) {
    expect(child.opacity).toBe('1');
    expect(child.offset).toBe(0);
    expect(child.clip).toMatch(/^(none|inset\(0(?:px|%)(?: 0(?:px|%)){0,3}\))$/);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.review-outgoing')).toHaveCount(0);
});

test('live reduced motion settles a genuinely moving drawer at its latest endpoint', async ({ page }, info) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  const before = await runDrawerFrames(page, () => page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!.click();
    const panel = document.querySelector<HTMLElement>('.study-companion')!;
    const dock = document.querySelector<HTMLElement>('.study-companion-dock')!;
    for (let index = 0; index < 120; index++) {
      window.__drawerFrameRequested = true;
      await new Promise(requestAnimationFrame);
      const x = parseFloat(getComputedStyle(dock).getPropertyValue('--study-panel-width')) - dock.getBoundingClientRect().width + 44;
      if (getComputedStyle(panel).visibility === 'visible' && x > 8 && x < panel.getBoundingClientRect().width - 8) return x;
    }
    throw new Error('The drawer did not produce an intermediate frame');
  }));
  await info.attach('reduction-intermediate.json', { body: JSON.stringify({ before }), contentType: 'application/json' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
  await expect.poll(() => page.locator('.study-companion-dock').evaluate(element => Math.abs(
    parseFloat(getComputedStyle(element).getPropertyValue('--study-panel-width')) - element.getBoundingClientRect().width + 44))).toBeLessThan(1);
  await expect(page.getByLabel('Search transcript')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
});

test('resize clips a drawer against unacknowledged native bounds and delays its focus', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light');
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: `
      window.__holdPlacement = false;
      window.__releasePlacement = () => {};
      export const nativeAvailable = () => true;
      export const call = async (command, args = {}) => {
        if (command === 'player_control' && args.request?.action === 'bounds' && window.__holdPlacement) {
          await new Promise(resolve => { window.__releasePlacement = resolve; });
        }
        return window.__learningFixture.call(command, args);
      };`,
  }));
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  const nativeRight = await page.locator('.native-player-viewport').evaluate(element => element.getBoundingClientRect().right);
  await page.evaluate(() => { (window as any).__holdPlacement = true; document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!.click(); });
  const panel = page.locator('.study-companion');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'pending');
  const protectedPixels = () => page.locator('.study-companion-dock').evaluate((element, right) => {
    const rect = element.getBoundingClientRect();
    const inset = Number((element as HTMLElement).dataset.nativeClipLeft || 0);
    return inset >= rect.width - 1 || rect.left + inset >= right - 1;
  }, nativeRight);
  await expect(panel).toHaveAttribute('inert', '');
  await expect.poll(protectedPixels).toBe(true);
  await page.setViewportSize({ width: 1300, height: 960 });
  await expect(panel).toHaveAttribute('inert', '');
  await expect.poll(protectedPixels).toBe(true);
  expect(await panel.evaluate(element => element.contains(document.activeElement))).toBe(false);
  await page.evaluate(() => { (window as any).__holdPlacement = false; (window as any).__releasePlacement(); });
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  await expect(panel).toHaveCSS('visibility', 'visible');
  await expect(panel).not.toHaveAttribute('inert');
  await expect(page.getByLabel('Search transcript')).toBeVisible();
});

test('notification reflow moves retained slots and reduced motion cancels the current stack movement', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route(/\/src\/main\.tsx(?:\?|$)/, route => route.fulfill({ contentType: 'application/javascript', body: 'import "/e2e/browser/surface-fixture.tsx";' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.getByRole('button', { name: 'Fail save', exact: true }).click();
  await expect(page.locator('.toast')).toHaveCount(1);
  const observed = await record(page, info, 'notifications', () => page.evaluate(async () => {
    const original = document.querySelector('.toast')!;
    const fail = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Fail save')!;
    fail.click();
    const frames = [];
    for (let index = 0; index < 18; index++) {
      await new Promise(requestAnimationFrame);
      const slot = original.closest('.toast-slot')!;
      frames.push({ y: slot.getBoundingClientRect().y, offset: new DOMMatrix(getComputedStyle(slot).transform).m42,
        connected: original.isConnected, count: document.querySelectorAll('.toast').length });
    }
    fail.click();
    for (let index = 0; index < 60; index++) {
      await new Promise(requestAnimationFrame);
      const offset = new DOMMatrix(getComputedStyle(original.closest('.toast-slot')!).transform).m42;
      if (Math.abs(offset) > .5) return { frames, reductionStart: offset };
    }
    throw new Error('The next notification did not produce an intermediate reflow frame');
  }));
  expect(observed.frames.every(frame => frame.connected)).toBe(true);
  expect(observed.frames.some(frame => Math.abs(frame.offset) > .5)).toBe(true);
  expect(new Set(observed.frames.map(frame => frame.y)).size).toBeGreaterThan(2);
  expect(Math.abs(observed.reductionStart)).toBeGreaterThan(.5);
  await expect(page.locator('.toast')).toHaveCount(3);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.locator('.toast-slot').evaluateAll(elements => elements.every(element => getComputedStyle(element).transform === 'none'))).toBe(true);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  expect(await page.locator('.toast').evaluateAll(elements => elements.every(element => getComputedStyle(element).transform === 'none' && getComputedStyle(element).opacity === '1'))).toBe(true);
  await page.locator('.toast').last().click();
  await expect(page.locator('.toast')).toHaveCount(2);
});
