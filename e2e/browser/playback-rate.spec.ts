// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

async function openStudy(page: Page, locale: 'ja' | 'en' = 'en', theme: 'light' | 'dark' = 'light') {
  await installLearningFixture(page, locale, theme);
  await page.goto('/study/visual-fixture');
  const trigger = page.getByRole('button', { name: locale === 'ja' ? '再生速度' : 'Playback speed', exact: true });
  await expect(trigger).toBeEnabled();
  return trigger;
}
const popup = (page: Page) => page.locator('.playback-rate-popover');
const slider = (page: Page) => page.locator('.playback-rate-slider');
const actions = (page: Page) => page.evaluate(() => (window as any).__learningFixture.calls
  .filter((call: any) => call.command === 'player_control' && !['bounds', 'hide'].includes(call.args.request.action))
  .map((call: any) => call.args.request));
async function contrast(control: Locator) {
  return control.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
        const value = channel / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    };
    const text = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
  });
}
for (const theme of ['light', 'dark'] as const) for (const locale of ['ja', 'en'] as const) {
  test(`reference speed widget keeps adjustments open and readable (${theme}, ${locale})`, async ({ page }) => {
    const trigger = await openStudy(page, locale, theme);
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(trigger).toHaveAccessibleDescription('1×');
    const readingOrigin = await page.locator('.current-caption-text').boundingBox();
    await trigger.click();
    await expect(page.getByRole('heading', { name: locale === 'ja' ? '再生速度' : 'Playback speed', exact: true })).toBeVisible();
    await expect(slider(page)).toBeFocused();
    await expect(slider(page)).toHaveValue('1');
    await expect(slider(page)).toHaveAttribute('min', '0.25');
    await expect(slider(page)).toHaveAttribute('max', '3');
    await expect(slider(page)).toHaveAttribute('step', '0.05');
    await expect(page.locator('.playback-rate-value')).toHaveText('1.00×');
    await expect(page.locator('.playback-rate-preset')).toHaveText(['0.5', '0.75', '1.0', '1.25', '1.5', '2.0', '3.0']);
    await expect(page.getByRole('button', { name: '1.0', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const preset of await page.locator('.playback-rate-preset').all()) expect(await contrast(preset)).toBeGreaterThanOrEqual(4.5);
    const slow = page.getByRole('button', { name: '0.75', exact: true });
    await slow.hover(); expect(await contrast(slow)).toBeGreaterThanOrEqual(4.5);
    const minus = page.getByRole('button', { name: locale === 'ja' ? '再生速度を下げる' : 'Decrease playback speed', exact: true });
    const plus = page.getByRole('button', { name: locale === 'ja' ? '再生速度を上げる' : 'Increase playback speed', exact: true });
    await minus.click(); await expect(slider(page)).toHaveValue('0.95'); await expect(minus).toBeFocused();
    await plus.click(); await expect(slider(page)).toHaveValue('1'); await expect(plus).toBeFocused();
    for (const [preset, value] of [['0.5', '0.5'], ['0.75', '0.75'], ['1.25', '1.25'], ['3.0', '3']]) {
      const button = page.getByRole('button', { name: preset, exact: true });
      await button.click(); await expect(button).toHaveAttribute('aria-pressed', 'true'); await expect(button).toBeFocused();
      await expect(slider(page)).toHaveValue(value); await expect(popup(page)).toHaveAttribute('data-state', 'open');
      expect(await contrast(button)).toBeGreaterThanOrEqual(4.5);
      expect(await page.locator('.current-caption-text').boundingBox()).toEqual(readingOrigin);
    }
    expect((await actions(page)).filter((action: any) => ['seek', 'toggle-pause', 'play', 'source-seek'].includes(action.action))).toEqual([]);
    await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(await page.locator('.current-caption-text').boundingBox()).toEqual(readingOrigin);
  });
}

test('slider keys and boundary steps preserve playback position and focused buttons', async ({ page }) => {
  const trigger = await openStudy(page); await trigger.click();
  await slider(page).press('Home'); await expect(slider(page)).toHaveValue('0.25');
  const plus = page.getByRole('button', { name: 'Increase playback speed', exact: true });
  const minus = page.getByRole('button', { name: 'Decrease playback speed', exact: true });
  await plus.click(); await expect(slider(page)).toHaveValue('0.3');
  await minus.click(); await expect(slider(page)).toHaveValue('0.25');
  await expect(minus).toHaveAttribute('aria-disabled', 'true'); await expect(minus).toBeFocused();
  const minimumRequests = (await actions(page)).filter((action: any) => action.action === 'rate').length;
  await minus.press('Space'); await expect(slider(page)).toHaveValue('0.25'); await expect(minus).toBeFocused();
  expect((await actions(page)).filter((action: any) => action.action === 'rate')).toHaveLength(minimumRequests);
  await slider(page).press('End'); await expect(slider(page)).toHaveValue('3');
  await slider(page).press('ArrowLeft'); await expect(slider(page)).toHaveValue('2.95');
  await plus.click(); await expect(slider(page)).toHaveValue('3');
  await expect(plus).toHaveAttribute('aria-disabled', 'true'); await expect(plus).toBeFocused();
  const maximumRequests = (await actions(page)).filter((action: any) => action.action === 'rate').length;
  await plus.press('Space'); await expect(slider(page)).toHaveValue('3'); await expect(plus).toBeFocused();
  expect((await actions(page)).filter((action: any) => action.action === 'rate')).toHaveLength(maximumRequests);
  expect((await actions(page)).filter((action: any) => ['seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
  await page.getByRole('button', { name: 'Close playback speed settings', exact: true }).click();
  await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
});

test('rapid pointer drag coalesces ordered rates, masks stale events and completes after closing', async ({ page }) => {
  const trigger = await openStudy(page);
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture, original = fixture.call.bind(fixture);
    let release!: () => void, active = 0, first = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const probe = { requests: [] as number[], maximum: 0, release };
    fixture.call = async (command: string, args: any) => {
      if (command !== 'player_control' || args.request.action !== 'rate') return original(command, args);
      active += 1; probe.maximum = Math.max(probe.maximum, active); probe.requests.push(args.request.value);
      try { if (first) { first = false; await gate; } return await original(command, args); }
      finally { active -= 1; }
    };
    (window as any).__rateQueue = probe;
  });
  await trigger.click(); await page.getByRole('button', { name: '0.5', exact: true }).click();
  const rect = (await slider(page).boundingBox())!;
  await page.mouse.move(rect.x + 7.5 + (rect.width - 15) * (.5 - .25) / 2.75, rect.y + rect.height / 2);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width - 7.5, rect.y + rect.height / 2, { steps: 14 }); await page.mouse.up();
  await expect(slider(page)).toHaveValue('3');
  await page.getByRole('button', { name: '0.75', exact: true }).click();
  await page.evaluate(() => { const fixture = (window as any).__learningFixture; fixture.publish('player-state', { ...fixture.state, rate: 1 }); });
  await expect(slider(page)).toHaveValue('0.75'); await expect(page.locator('.playback-rate-value')).toHaveText('0.75×');
  expect(await page.evaluate(() => (window as any).__rateQueue.requests)).toEqual([.5]);
  await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0); await expect(trigger).toHaveText('0.75×');
  await page.evaluate(() => (window as any).__rateQueue.release());
  await expect.poll(() => page.evaluate(() => (window as any).__learningFixture.state.rate)).toBe(.75);
  expect(await page.evaluate(() => (window as any).__rateQueue.requests)).toEqual([.5, .75]);
  expect(await page.evaluate(() => (window as any).__rateQueue.maximum)).toBe(1);
  await trigger.click(); await expect(slider(page)).toHaveValue('0.75'); await expect(slider(page)).toBeFocused();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`speed widget preserves native placement and restores focus (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    const trigger = await openStudy(page);
    const before = await page.getByTestId('native-player-viewport').boundingBox();
    await trigger.click();
    await expect(slider(page)).toBeFocused();
    await expect(popup(page)).toHaveCSS('opacity', '1');
    await expect(popup(page)).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: '1.25', exact: true }).click();
    await expect(slider(page)).toHaveValue('1.25');
    expect(await page.getByTestId('native-player-viewport').boundingBox()).toEqual(before);
    const placements = await page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => call.command === 'player_control' && call.args.request.action === 'bounds'));
    expect(placements.length).toBeGreaterThan(0);
    expect(placements.every((call: any) => !call.args.request.bounds.occlusions?.length && !call.args.request.bounds.inputBlocked)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popup(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.getByTestId('native-player-viewport').boundingBox()).toEqual(before);
  });
}

test('the open widget leaves modified keys and IME composition untouched', async ({ page }) => {
  const trigger = await openStudy(page); await trigger.click();
  await trigger.focus();
  const modifiedKeys = await trigger.evaluate(element => {
    const prevented: boolean[] = [];
    const record = (event: KeyboardEvent) => prevented.push(event.defaultPrevented);
    document.addEventListener('keydown', record, true);
    for (const options of [{ key: 'ArrowRight', ctrlKey: true }, { key: 'Enter', isComposing: true }, { key: 'Escape', keyCode: 229 }]) {
      element.dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }));
    }
    document.removeEventListener('keydown', record, true);
    return prevented;
  });
  expect(modifiedKeys).toEqual([false, false, false]);
  await expect(popup(page)).toHaveAttribute('data-state', 'open');
  expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
  await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
});

test('the speed trigger toggles with a pointer and keyboard users can leave the widget', async ({ page }) => {
  const trigger = await openStudy(page);
  await trigger.click(); await expect(slider(page)).toBeFocused();
  await trigger.click(); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  for (const key of ['Enter', 'Space']) {
    await trigger.press(key); await expect(slider(page)).toBeFocused();
    const dialog = page.getByRole('dialog', { name: 'Playback speed', exact: true });
    const dialogId = await dialog.getAttribute('id');
    expect(dialogId).toBeTruthy();
    await expect(trigger).toHaveAttribute('aria-controls', dialogId!);
    const tabStops = await popup(page).locator('button, input, [tabindex="0"]').count();
    for (let step = 0; step <= tabStops; step++) {
      if (!await popup(page).evaluateAll(elements => elements.some(element => element.getAttribute('data-state') === 'open'))) break;
      await page.keyboard.press('Shift+Tab');
    }
    await expect(popup(page)).toHaveCount(0);
    const focusedControl = page.locator('button:focus, input:focus, select:focus, textarea:focus, a[href]:focus');
    await expect(focusedControl).toHaveCount(1);
    await expect(focusedControl).toBeVisible();
    await expect(focusedControl).toBeEnabled();
  }
  expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
});

test('reopening a closing speed widget keeps its value and a new modal retains focus', async ({ page }) => {
  await page.clock.install();
  const trigger = await openStudy(page);
  await trigger.click();
  await page.getByRole('button', { name: '0.75', exact: true }).click();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveAttribute('data-state', 'closing');
  await trigger.evaluate(element => element.click());
  await expect(popup(page)).toHaveAttribute('data-state', 'open');
  await page.clock.resume();
  await expect(slider(page)).toHaveValue('0.75');
  await expect(slider(page)).toBeFocused();
  await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Playback settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(popup(page)).toHaveCount(0);
  await expect.poll(() => settings.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
});

test('outside content and native or DOM video clicks dismiss once without toggling playback', async ({ page }) => {
  const trigger = await openStudy(page); await trigger.click(); await page.locator('.current-caption-text').click(); await expect(popup(page)).toHaveCount(0);
  await trigger.click(); await page.locator('.player-surface-toggle').click(); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await page.evaluate(() => (window as any).__learningFixture.publish('player-surface-click', undefined));
  await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
  await page.locator('.player-surface-toggle').click(); await expect.poll(async () => (await actions(page)).filter((action: any) => action.action === 'toggle-pause').length).toBe(1);
});

for (const [width, height] of [[800, 700], [640, 360]]) {
  test(`reference widget controls stay reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const trigger = await openStudy(page, 'ja', 'dark'); await trigger.click(); await expect(slider(page)).toBeFocused();
    const rect = (await popup(page).boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width); expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    expect(rect.y + rect.height).toBeLessThanOrEqual((await trigger.boundingBox())!.y + 1);
    await expect(page.locator('.playback-rate-heading')).toBeInViewport({ ratio: 1 });
    const controls = page.locator('.playback-rate-dialog').locator('button, input');
    await expect(controls).toHaveCount(11);
    for (const control of await controls.all()) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await slider(page).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '0.75', exact: true }).click(); await expect(slider(page)).toHaveValue('0.75');
    await expect(popup(page)).toHaveAttribute('data-state', 'open');
    await page.getByRole('button', { name: '再生速度設定を閉じる', exact: true }).click(); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  });
}
