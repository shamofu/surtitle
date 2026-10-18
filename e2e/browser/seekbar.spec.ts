// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const playing of [false, true]) {
  test(`seekbar clicks follow the pointer across the full hit area (${playing ? 'playing' : 'paused'})`, async ({ page }) => {
    await installLearningFixture(page, 'en', 'light');
    await page.goto('/study/visual-fixture');
    const slider = page.getByRole('slider', { name: 'Playback position' });
    await expect(slider).toBeEnabled();
    if (playing) await page.getByRole('button', { name: 'Play', exact: true }).click();

    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const fraction of [0.2, 0.8, 0.4]) {
        const box = (await slider.boundingBox())!;
        // Click above the visible four-pixel track, inside its full hit area.
        const x = box.x + 6 + (box.width - 12) * fraction;
        await page.mouse.click(x, box.y + 2);
        const target = await page.evaluate(() => {
          const fixture = (window as any).__learningFixture;
          return fixture.calls.filter((call: any) => call.command === 'player_control' && call.args.request.action === 'seek').at(-1)?.args.request.value;
        });
        expect(target).toBeDefined();
        await expect(slider).toHaveValue(String(target));
        const thumbX = box.x + 6 + (box.width - 12) * target / 840000;
        expect(Math.abs(thumbX - x)).toBeLessThan(1.5);
        await expect(page.getByRole('button', { name: playing ? 'Pause' : 'Play', exact: true })).toBeVisible();
      }
    }
  });
}

test('playing seek stays at the dragged position until acknowledged, including release outside the bar', async ({ page }) => {
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(slider).toBeEnabled();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture;
    const call = fixture.call.bind(fixture);
    fixture.state.revision = 10;
    const pending: { args: any; resolve: () => void }[] = [];
    fixture.call = async (command: string, args: any) => {
      if (command === 'player_control' && args.request.action === 'seek') {
        return new Promise<void>(resolve => pending.push({ args, resolve }));
      }
      if (command === 'get_player_state') fixture.state.revision += 1;
      return call(command, args);
    };
    Object.assign(window, { __seekTest: {
      pending,
      async tick(positionMs: number) {
        fixture.state.positionMs = positionMs;
        fixture.state.revision += 1;
        await call('player_control', { request: { action: 'play' } });
      },
      async complete() {
        const request = pending.shift()!;
        fixture.state.revision += 1;
        await call('player_control', request.args);
        request.resolve();
      },
    } });
  });

  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + 6 + (box.width - 12) * 76000 / 840000, box.y + box.height / 2);
  await page.mouse.down();
  const grabbed = await slider.inputValue();
  await page.evaluate(() => (window as any).__seekTest.tick(77000));
  await expect(slider).toHaveValue(grabbed);
  await page.mouse.move(box.x + 6 + (box.width - 12) * 0.65, box.y - 30, { steps: 5 });
  const target = await slider.inputValue();
  expect(Number(target)).toBeGreaterThan(500000);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__seekTest.pending.length)).toBe(1);
  await page.evaluate(() => (window as any).__seekTest.tick(78000));
  await expect(slider).toHaveValue(target);
  await page.evaluate(() => (window as any).__seekTest.complete());
  await expect(slider).toHaveValue(target);
  await page.evaluate(value => (window as any).__seekTest.tick(Number(value) + 200), target);
  await expect(slider).toHaveValue(String(Number(target) + 200));
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});
