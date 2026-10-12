// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

type FixtureWindow = Window & {
  __learningFixture: {
    call: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    publish: (event: string, payload: unknown) => void;
  };
  __transcriptRefresh: { marked: boolean; fail: boolean; refresh: () => void };
  __heldPlayerEvents: { hold: () => void; release: () => void; pending: Map<unknown, unknown> };
  __jumpScroll: { start: number; positions: number[]; stop: () => void };
};

async function installTranscriptRefresh(page: Page) {
  await page.evaluate(() => {
    const fixtureWindow = window as FixtureWindow;
    const fixture = fixtureWindow.__learningFixture;
    const original = fixture.call.bind(fixture);
    let revision = 0;
    const control = fixtureWindow.__transcriptRefresh = {
      marked: false, fail: false,
      refresh: () => fixture.publish('data-changed', {
        version: 1, epoch: 'fixture', revision: ++revision, domain: 'subtitles', entityId: 'visual-fixture',
      }),
    };
    fixture.call = async (command, args) => {
      if (command === 'list_segments' && control.fail) throw new Error('Offline while refreshing subtitles');
      const result = await original(command, args);
      if (command !== 'list_segments') return result;
      return (result as { id: string; status: string }[]).map(cue => cue.id === 'visual-cue-10'
        ? { ...cue, status: control.marked ? 'generated_review' : 'confirmed' } : cue);
    };
  });
}

async function observeTranscriptRefresh(page: Page, patch: { marked?: boolean; fail?: boolean }) {
  return page.evaluate(async patch => {
    const list = document.querySelector<HTMLElement>('.transcript-scroll')!;
    const text = list.querySelector<HTMLElement>('.transcript-row[data-index="10"] .segment-text')!;
    const sample = () => {
      const bounds = list.getBoundingClientRect(), content = text.getBoundingClientRect();
      return { top: bounds.top, height: bounds.height, textX: content.x, textY: content.y, textHeight: content.height, scroll: list.scrollTop };
    };
    const start = sample(), samples = [];
    const control = (window as FixtureWindow).__transcriptRefresh;
    Object.assign(control, patch); control.refresh();
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise(requestAnimationFrame);
      samples.push(sample());
    }
    return { start, samples };
  }, patch);
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`transcript warnings and refresh errors preserve the reading viewport (${reducedMotion})`, async ({ page }) => {
    await openTranscript(page, reducedMotion);
    await installTranscriptRefresh(page);
    const text = page.locator('.transcript-row[data-index="10"] .segment-text');
    await text.focus();
    await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();
    const filter = page.getByRole('checkbox', { name: 'Show marked passages only' });
    await expect(filter).toBeDisabled();
    for (const patch of [{ marked: true }, { marked: false }, { fail: true }]) {
      const observed = await observeTranscriptRefresh(page, patch);
      for (const sample of observed.samples) {
        for (const key of Object.keys(observed.start) as (keyof typeof sample)[]) {
          expect(Math.abs(sample[key] - observed.start[key]), key).toBeLessThan(1);
        }
      }
      await expect(text).toBeFocused();
      if ('marked' in patch) await expect(filter)[patch.marked ? 'toBeEnabled' : 'toBeDisabled']();
    }
    const disclosure = page.locator('.transcript-filter-bar .transcript-status');
    const status = disclosure.getByLabel('Subtitles could not be updated', { exact: true });
    await expect(status).toBeVisible();
    const before = await page.locator('.transcript-scroll').boundingBox();
    await status.focus();
    await status.press('Enter');
    await expect(disclosure.locator('.transcript-status-panel p')).toHaveText('Offline while refreshing subtitles');
    await expect(disclosure.locator('.transcript-status-panel p')).toBeVisible();
    expect(await status.evaluate(element => getComputedStyle(element.closest('details')!).overflow)).toBe('visible');
    const after = await page.locator('.transcript-scroll').boundingBox();
    expect(after).toEqual(before);
    await page.evaluate(() => { (window as FixtureWindow).__transcriptRefresh.fail = false; });
    await page.keyboard.press('Tab');
    await expect(disclosure.getByRole('button', { name: 'Retry loading subtitles' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Search transcript' })).toBeFocused();
    await expect(filter).toBeDisabled();
    expect(await page.locator('.transcript-scroll').boundingBox()).toEqual(before);
  });
}

test('secondary subtitle actions overlay rows without moving content and return keyboard focus', async ({ page }) => {
  await openTranscript(page);
  const visibleIndexes = await page.locator('.transcript-scroll').evaluate(element => {
    const viewport = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('.transcript-row')].filter(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }).map(row => Number(row.dataset.index));
  });
  expect(visibleIndexes.length).toBeGreaterThan(0);
  for (const index of [...new Set([visibleIndexes[0], 10, visibleIndexes.at(-1)!])]) {
    const row = page.locator(`.transcript-row[data-index="${index}"]`);
    const before = await row.boundingBox();
    const actions = row.locator('.segment-options summary');
    await actions.click();
    expect(await actions.evaluate(element => getComputedStyle(element.closest('details')!).overflow)).toBe('visible');
    const edit = page.getByRole('button', { name: 'Edit subtitle', exact: true });
    await expect(edit).toBeVisible();
    await expect(edit).toBeInViewport();
    await expect.poll(() => edit.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element;
    })).toBe(true);
    expect(await row.boundingBox()).toEqual(before);
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(actions).toBeFocused();
    await expect(edit).toBeHidden();
    expect(await row.boundingBox()).toEqual(before);
  }
});

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
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
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
