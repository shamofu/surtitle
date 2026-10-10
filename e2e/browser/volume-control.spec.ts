// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function setNativeVolume(page: Page, value: number) {
  await page.evaluate(value => (window as any).__learningFixture.call('player_control', {
    request: { action: 'volume', value },
  }), value);
}

test('volume wheel uses five-percent boundaries, clamps, and only consumes enabled scrolling', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light');
  await page.addInitScript(() => { (window as any).__learningFixture.state.volume = 83; });
  await page.goto('/study/visual-fixture');
  const slider = page.getByRole('slider', { name: 'Volume', exact: true });
  const value = page.locator('.volume-value');
  await expect(slider).toBeEnabled();
  await expect(value).toHaveText('83%');
  await expect(slider).toHaveAttribute('min', '0');
  await expect(slider).toHaveAttribute('max', '100');
  await expect(slider).toHaveAttribute('step', '1');
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '1000px';
    spacer.setAttribute('aria-hidden', 'true');
    document.querySelector('.page-content')!.append(spacer);
    (window as any).__volumeWheels = [];
    document.querySelector('.volume-control')!.addEventListener('wheel', event => {
      (window as any).__volumeWheels.push(event.defaultPrevented);
    });
  });
  const scroll = page.locator('.page-content');
  await slider.hover();
  const beforeScroll = await scroll.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, -120);
  await expect(value).toHaveText('85%');
  await setNativeVolume(page, 83);
  await expect(value).toHaveText('83%');
  await page.mouse.wheel(0, 120);
  await expect(value).toHaveText('80%');
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(beforeScroll);
  expect(await page.evaluate(() => (window as any).__volumeWheels)).toEqual([true, true]);

  await setNativeVolume(page, 99);
  await expect(value).toHaveText('99%');
  await page.mouse.wheel(0, -120);
  await expect(value).toHaveText('100%');
  await page.mouse.wheel(0, -120);
  await expect(value).toHaveText('100%');
  await setNativeVolume(page, 1);
  await expect(value).toHaveText('1%');
  await page.mouse.wheel(0, 120);
  await expect(value).toHaveText('0%');
  await page.mouse.wheel(0, 120);
  await expect(value).toHaveText('0%');

  await page.evaluate(async () => {
    const fixture = (window as any).__learningFixture;
    fixture.state.ready = false;
    await fixture.call('player_control', { request: { action: 'pause' } });
    fixture.calls.length = 0;
  });
  await expect(slider).toBeDisabled();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeScroll);
  expect(await page.evaluate(() => (window as any).__volumeWheels.at(-1))).toBe(false);
  expect(await page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) =>
    call.command === 'player_control' && call.args.request.action === 'volume'))).toHaveLength(0);
});

test('dragging volume keeps its latest value while native requests coalesce and stale states arrive', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light');
  await page.addInitScript(() => {
    const fixture = (window as any).__learningFixture;
    const call = fixture.call.bind(fixture);
    const subscribe = fixture.subscribe.bind(fixture);
    const listeners = new Set<(event: { payload: any }) => void>();
    const pending: { args: any; resolve: () => void }[] = [];
    const issued: number[] = [];
    fixture.state.revision = 10;
    fixture.subscribe = (event: string, callback: (event: { payload: any }) => void) => {
      if (event === 'player-state') listeners.add(callback);
      const stop = subscribe(event, callback);
      return () => { listeners.delete(callback); stop(); };
    };
    fixture.call = async (command: string, args: any) => {
      if (command === 'player_control' && args.request.action === 'volume') {
        issued.push(args.request.value);
        return new Promise<void>(resolve => pending.push({ args, resolve }));
      }
      if (command === 'get_player_state') fixture.state.revision += 1;
      return call(command, args);
    };
    Object.assign(window, { __volumeTest: {
      pending, issued,
      async tick(volume: number) {
        fixture.state.volume = volume;
        fixture.state.revision += 1;
        await call('player_control', { request: { action: 'play' } });
      },
      stale() {
        listeners.forEach(listener => listener({ payload: { ...fixture.state, volume: 8, revision: 1 } }));
      },
      async complete() {
        const request = pending.shift()!;
        fixture.state.revision += 1;
        await call('player_control', request.args);
        request.resolve();
      },
    } });
  });
  await page.goto('/study/visual-fixture');
  const slider = page.getByRole('slider', { name: 'Volume', exact: true });
  const value = page.locator('.volume-value');
  await expect(slider).toBeEnabled();
  await expect(value).toHaveText('80%');
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2, { steps: 8 });
  const intermediate = await slider.inputValue();
  expect(Number(intermediate)).toBeLessThan(50);
  await expect(value).toHaveText(`${intermediate}%`);
  await page.evaluate(() => (window as any).__volumeTest.tick(79));
  await expect(slider).toHaveValue(intermediate);
  await page.mouse.move(box.x + box.width * .65, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const target = await slider.inputValue();
  expect(Number(target)).toBeGreaterThan(50);
  await expect(value).toHaveText(`${target}%`);
  expect(await page.evaluate(() => (window as any).__volumeTest.issued.length)).toBe(1);
  await page.evaluate(() => (window as any).__volumeTest.complete());
  await expect.poll(() => page.evaluate(() => (window as any).__volumeTest.issued)).toEqual([
    await page.evaluate(() => (window as any).__volumeTest.issued[0]), Number(target),
  ]);
  await expect(value).toHaveText(`${target}%`);
  await page.evaluate(() => (window as any).__volumeTest.complete());
  await expect.poll(() => page.evaluate(() => (window as any).__volumeTest.pending.length)).toBe(0);
  await page.evaluate(() => (window as any).__volumeTest.stale());
  await expect(slider).toHaveValue(target);
  await expect(value).toHaveText(`${target}%`);
});

for (const width of [1024, 800]) {
  test(`volume percentage fits the player controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    const slider = page.getByRole('slider', { name: 'Volume', exact: true });
    const value = page.locator('.volume-value');
    await expect(slider).toBeEnabled();
    await expect(value).toHaveText('80%');
    await setNativeVolume(page, 100);
    await expect(value).toHaveText('100%');
    const labelBox = (await value.boundingBox())!;
    const rowBox = (await page.locator('.player-control-row').boundingBox())!;
    expect(labelBox.x).toBeGreaterThanOrEqual(rowBox.x);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    expect(labelBox.y).toBeGreaterThanOrEqual(rowBox.y);
    expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
    expect(await value.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
