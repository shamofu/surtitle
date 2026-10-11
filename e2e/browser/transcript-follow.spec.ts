// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

type FixtureWindow = Window & {
  __learningFixture: {
    call: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __heldPlayerEvents: { hold: () => void; release: () => void; pending: Map<unknown, unknown> };
  __jumpScroll: { start: number; positions: number[]; stop: () => void };
};

async function openTranscript(page: Page, reducedMotion: 'no-preference' | 'reduce' = 'no-preference', delayPlayerEvents = false) {
  await page.emulateMedia({ reducedMotion });
  await installLearningFixture(page, 'en', 'light');
  if (delayPlayerEvents) {
    // Native commands can acknowledge before the next periodic position event.
    // Keep command success real while controlling event delivery independently.
    await page.route(/\/src\/shared\/native\/events\.ts(?:\?|$)/, route => route.fulfill({
      contentType: 'application/javascript',
      body: `const gate = window.__heldPlayerEvents = {
        held: false, pending: new Map(),
        hold() { this.held = true; },
        release() {
          this.held = false;
          const pending = [...this.pending];
          this.pending.clear();
          for (const [callback, event] of pending) callback(event);
        }
      };
      export const subscribeNative = (name, callback) => {
        const stop = window.__learningFixture.subscribe(name, event => {
          if (name === 'player-state' && gate.held) gate.pending.set(callback, event);
          else callback(event);
        });
        return () => { gate.pending.delete(callback); stop(); };
      };`,
    }));
  }
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Explore meaning', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Following playback', exact: true })).toBeVisible();
  await expectCentered(page, 10);
}

async function expectCentered(page: Page, index: number) {
  await expect.poll(() => page.getByLabel('Subtitle list', { exact: true }).evaluate((element, index) => {
    const row = element.querySelector(`.transcript-row.playing[data-index="${index}"]`);
    if (!row) return Number.POSITIVE_INFINITY;
    const viewport = element.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2);
  }, index)).toBeLessThan(2);
}

async function observePlaybackScroll(page: Page, index: number, frames = 36) {
  return page.evaluate(async ({ index, frames }) => {
    const fixture = (window as FixtureWindow).__learningFixture;
    const list = document.querySelector('.transcript-scroll') as HTMLElement;
    const start = list.scrollTop;
    const samples: { top: number; active: boolean; centerDistance: number | null }[] = [];
    await fixture.call('player_control', { request: { action: 'seek', value: index * 7000 + 100 } });
    await fixture.call('player_control', { request: { action: 'play' } });
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise(requestAnimationFrame);
      const row = list.querySelector(`.transcript-row.playing[data-index="${index}"]`);
      const viewport = list.getBoundingClientRect();
      const bounds = row?.getBoundingClientRect();
      samples.push({
        top: list.scrollTop,
        active: !!row,
        centerDistance: bounds ? Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2) : null,
      });
    }
    return { start, samples };
  }, { index, frames });
}

async function startScrollAndWaitForMovement(page: Page, index: number) {
  return page.evaluate(async index => {
    const fixture = (window as FixtureWindow).__learningFixture;
    const list = document.querySelector('.transcript-scroll') as HTMLElement;
    const start = list.scrollTop;
    await fixture.call('player_control', { request: { action: 'seek', value: index * 7000 + 100 } });
    await fixture.call('player_control', { request: { action: 'play' } });
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise(requestAnimationFrame);
      const row = list.querySelector(`.transcript-row.playing[data-index="${index}"]`);
      if (!row) continue;
      const viewport = list.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      const remaining = Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2);
      if (list.scrollTop > start + 8 && remaining > 30) return true;
    }
    return false;
  }, index);
}

test('playback smoothly centers measured subtitle rows, including translations', async ({ page }) => {
  await openTranscript(page);
  await page.getByRole('button', { name: 'Show translations' }).click();
  await expectCentered(page, 10);

  for (const index of [11, 12]) {
    const observed = await observePlaybackScroll(page, index);
    await expectCentered(page, index);
    const end = observed.samples.at(-1)!.top;
    expect(end - observed.start).toBeGreaterThan(30);
    const intermediate = observed.samples.filter(sample => sample.top > observed.start + 2 && sample.top < end - 2);
    expect(new Set(intermediate.map(sample => sample.top)).size).toBeGreaterThan(1);
  }
});

test('manual scrolling interrupts smooth follow and later playback cannot pull the transcript back', async ({ page }) => {
  await openTranscript(page);
  const list = page.getByLabel('Subtitle list', { exact: true });
  await list.hover();
  expect(await startScrollAndWaitForMovement(page, 15)).toBe(true);
  await page.mouse.wheel(0, -180);
  await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();

  // Observe actual browser frames after the user's wheel movement settles.
  const stopped = await list.evaluate(async element => {
    const positions: number[] = [];
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise(requestAnimationFrame);
      positions.push(element.scrollTop);
    }
    return positions.slice(-6);
  });
  expect(Math.max(...stopped) - Math.min(...stopped)).toBeLessThan(2);
  for (const index of [16, 17]) {
    const observed = await observePlaybackScroll(page, index, 12);
    expect(observed.samples.every(sample => Math.abs(sample.top - stopped.at(-1)!) < 2)).toBe(true);
  }
  await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`far transcript jumps never scroll back to the old playback position (${reducedMotion})`, async ({ page }) => {
    await openTranscript(page, reducedMotion, true);
    const list = page.getByLabel('Subtitle list', { exact: true });
    let playingIndex = 10;

    for (const direction of [1, -1]) {
      await list.hover();
      await page.mouse.wheel(0, direction * 4500);
      await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();
      const findDistantRow = () => list.evaluate((element, { playingIndex, direction }) => {
        const viewport = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('.transcript-row')]
          .filter(row => {
            const bounds = row.getBoundingClientRect();
            return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom &&
              (Number(row.dataset.index) - playingIndex) * direction >= 20;
          })
          .sort((left, right) => {
            const distance = (row: HTMLElement) => Math.abs(row.getBoundingClientRect().top +
              row.getBoundingClientRect().bottom - viewport.top - viewport.bottom);
            return distance(left) - distance(right);
          }).map(row => Number(row.dataset.index))[0] ?? -1;
      }, { playingIndex, direction });
      await expect.poll(findDistantRow).toBeGreaterThanOrEqual(0);
      const targetIndex = await findDistantRow();

      await list.evaluate(element => {
        const fixtureWindow = window as FixtureWindow;
        fixtureWindow.__heldPlayerEvents.hold();
        const positions = [element.scrollTop];
        let frame = 0;
        const sample = () => positions.push(element.scrollTop);
        const tick = () => { sample(); frame = requestAnimationFrame(tick); };
        element.addEventListener('scroll', sample);
        frame = requestAnimationFrame(tick);
        fixtureWindow.__jumpScroll = {
          start: element.scrollTop, positions,
          stop: () => { cancelAnimationFrame(frame); element.removeEventListener('scroll', sample); },
        };
      });
      await list.locator(`.transcript-row[data-index="${targetIndex}"] .segment-time`).click();
      await expect(page.getByRole('button', { name: 'Following playback', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__heldPlayerEvents.pending.size)).toBeGreaterThan(0);
      // Observe complete rendered frames while the player still reports the old
      // position; a successful jump must already follow the clicked subtitle.
      const observed = await list.evaluate(async element => {
        for (let frame = 0; frame < 24; frame += 1) await new Promise(requestAnimationFrame);
        const observation = (window as FixtureWindow).__jumpScroll;
        observation.stop();
        return { start: observation.start, positions: observation.positions, height: element.clientHeight };
      });
      expect(Math.max(...observed.positions.map(top => Math.abs(top - observed.start)))).toBeLessThan(observed.height);
      await expectCentered(page, targetIndex);

      await page.evaluate(() => (window as FixtureWindow).__heldPlayerEvents.release());
      await expectCentered(page, targetIndex);
      await observePlaybackScroll(page, targetIndex + 1);
      await expectCentered(page, targetIndex + 1);
      playingIndex = targetIndex + 1;
    }
  });

  test(`jumping from a transcript timestamp resumes follow until another manual scroll (${reducedMotion})`, async ({ page }) => {
    await openTranscript(page, reducedMotion);
    const list = page.getByLabel('Subtitle list', { exact: true });
    await list.hover();
    await page.mouse.wheel(0, -180);
    await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();

    await list.locator('.transcript-row[data-index="9"] .segment-time').click();
    await expect(page.getByRole('button', { name: 'Following playback', exact: true })).toBeVisible();
    await expectCentered(page, 9);
    await observePlaybackScroll(page, 10);
    await expectCentered(page, 10);

    await list.hover();
    await page.mouse.wheel(0, -180);
    await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();
    const stopped = await list.evaluate(async element => {
      const positions: number[] = [];
      for (let frame = 0; frame < 24; frame += 1) {
        await new Promise(requestAnimationFrame);
        positions.push(element.scrollTop);
      }
      return positions.slice(-6);
    });
    expect(Math.max(...stopped) - Math.min(...stopped)).toBeLessThan(2);
    const observed = await observePlaybackScroll(page, 11, 12);
    expect(observed.samples.every(sample => Math.abs(sample.top - stopped.at(-1)!) < 2)).toBe(true);
    await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();
  });
}

test('reduced motion immediately follows the active subtitle without intermediate movement', async ({ page }) => {
  await openTranscript(page, 'reduce');
  const observed = await observePlaybackScroll(page, 12, 12);
  await expectCentered(page, 12);
  const active = observed.samples.filter(sample => sample.active);
  expect(active.length).toBeGreaterThan(0);
  expect(active.every(sample => sample.centerDistance! < 2)).toBe(true);
  expect(active.at(-1)!.top - observed.start).toBeGreaterThan(30);
});

test('enabling reduced motion finishes an in-flight follow at the active subtitle', async ({ page }) => {
  await openTranscript(page);
  expect(await startScrollAndWaitForMovement(page, 15)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expectCentered(page, 15);
  const observed = await observePlaybackScroll(page, 16, 12);
  const active = observed.samples.filter(sample => sample.active);
  expect(active.length).toBeGreaterThan(0);
  expect(active.every(sample => sample.centerDistance! < 2)).toBe(true);
});
