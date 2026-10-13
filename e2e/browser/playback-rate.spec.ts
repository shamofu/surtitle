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
async function delayPlacement(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture, original = fixture.call.bind(fixture);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.call = async (command: string, args: any) => {
      const result = original(command, args);
      if (command === 'player_control' && args.request.action === 'bounds' && args.request.bounds.occlusions?.length) await gate;
      return result;
    };
    (window as any).__releaseRatePlacement = release;
  });
}

for (const theme of ['light', 'dark'] as const) for (const locale of ['ja', 'en'] as const) {
  test(`reference speed widget keeps adjustments open and readable (${theme}, ${locale})`, async ({ page }) => {
    const trigger = await openStudy(page, locale, theme);
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(trigger).toHaveAccessibleDescription('1×');
    await expect(trigger.locator('.lucide-gauge')).toHaveCount(1);
    await expect(page.locator('.speed-select select, .speed-select .lucide-chevron-down')).toHaveCount(0);
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
    await expect(page.locator('.playback-rate-preset-row').first().locator('button')).toHaveText(['0.5', '0.75', '1.0']);
    await expect(page.locator('.playback-rate-preset-row').last().locator('button')).toHaveText(['1.25', '1.5', '2.0', '3.0']);
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
  test(`speed widget motion retains the opaque native region (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion }); const trigger = await openStudy(page);
    await page.evaluate(() => {
      const frames: any[] = []; let frame = 0;
      const sample = () => {
        const shell = document.querySelector<HTMLElement>('.playback-rate-popover'), content = shell?.querySelector<HTMLElement>('.playback-rate-content');
        if (shell && content && shell.dataset.nativeOcclusion !== 'pending') {
          const style = getComputedStyle(content), rect = shell.getBoundingClientRect();
          frames.push({ state: shell.dataset.state, opacity: Number(style.opacity), y: new DOMMatrix(style.transform).m42,
            shellOpacity: getComputedStyle(shell).opacity, x: rect.x, top: rect.top, width: rect.width, height: rect.height });
        }
        frame = requestAnimationFrame(sample);
      };
      sample(); (window as any).__rateProbe = { frames, finish: () => cancelAnimationFrame(frame) };
    });
    const before = await page.getByTestId('native-player-viewport').boundingBox(); await trigger.click();
    await expect.poll(() => page.locator('.playback-rate-content').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
    await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0);
    const frames = await page.evaluate(() => { (window as any).__rateProbe.finish(); return (window as any).__rateProbe.frames; });
    expect(frames.length).toBeGreaterThan(1); expect(frames.every((frame: any) => frame.shellOpacity === '1')).toBe(true);
    expect(new Set(frames.map((frame: any) => JSON.stringify([frame.x, frame.top, frame.width, frame.height]))).size).toBe(1);
    if (reducedMotion === 'no-preference') {
      expect(frames.some((frame: any) => frame.state === 'open' && frame.y > 8 && frame.opacity < .65)).toBe(true);
      expect(frames.some((frame: any) => frame.state === 'closing' && frame.y > 2 && frame.opacity < .9)).toBe(true);
    } else expect(frames.every((frame: any) => frame.opacity === 1 && frame.y === 0)).toBe(true);
    expect(await page.getByTestId('native-player-viewport').boundingBox()).toEqual(before);
    const placements = await page.evaluate(() => (window as any).__learningFixture.calls.filter((call: any) => call.command === 'player_control' && call.args.request.action === 'bounds'));
    expect(placements.some((call: any) => call.args.request.bounds.occlusions.length === 1 && !call.args.request.bounds.inputBlocked)).toBe(true);
  });
}

test('pending native preparation blocks body shortcuts and resumes slider after trigger or background focus', async ({ page }) => {
  const trigger = await openStudy(page); await delayPlacement(page); await trigger.click();
  await expect(popup(page)).toHaveAttribute('data-native-occlusion', 'pending'); await expect(popup(page)).toBeHidden();
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
  for (const key of ['Space', 'ArrowRight', 'ArrowLeft']) await page.keyboard.press(key);
  expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
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
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']) await page.keyboard.press(key);
  await expect(popup(page)).toHaveAttribute('data-state', 'open');
  expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
  await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }));
  await page.evaluate(() => (window as any).__releaseRatePlacement());
  await expect(popup(page)).not.toHaveAttribute('data-native-occlusion', 'pending'); await expect(trigger).toBeFocused();
  await page.evaluate(() => { Reflect.deleteProperty(document, 'hasFocus'); window.dispatchEvent(new Event('focus')); });
  await expect(slider(page)).toBeFocused(); await slider(page).press('ArrowRight'); await expect(slider(page)).toHaveValue('1.05');
  await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
});

test('the same trigger closes and reopens the widget with pointer or keyboard activation', async ({ page }) => {
  const trigger = await openStudy(page);
  await trigger.click(); await expect(slider(page)).toBeFocused();
  await trigger.click(); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  for (const key of ['Enter', 'Space']) {
    await trigger.press(key); await expect(slider(page)).toBeFocused();
    await trigger.focus(); await expect(popup(page)).toHaveAttribute('data-state', 'open');
    await trigger.press(key); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  }
  expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
});

for (const method of ['pointer', 'Enter', 'Space']) {
  test(`the trigger dismisses pending native preparation with ${method}`, async ({ page }) => {
    const trigger = await openStudy(page); await delayPlacement(page); await trigger.click();
    await expect(popup(page)).toHaveAttribute('data-native-occlusion', 'pending');
    if (method === 'pointer') await trigger.click();
    else { await trigger.focus(); await trigger.press(method); }
    await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(trigger).toBeFocused();
    await page.evaluate(() => (window as any).__releaseRatePlacement());
    await expect(popup(page)).toHaveCount(0);
    await expect(page.getByTestId('native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
    await trigger.click(); await expect(slider(page)).toBeFocused();
    expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
  });
}

test('Escape dismisses a hidden pending popup from body focus before native acknowledgement', async ({ page }) => {
  const trigger = await openStudy(page); await delayPlacement(page); await trigger.click();
  await expect(popup(page)).toHaveAttribute('data-native-occlusion', 'pending');
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
  await expect(page.locator('body')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveAttribute('data-state', 'closing'); await expect(trigger).toBeFocused();
  await expect(page.locator('.playback-rate-content')).toHaveAttribute('inert', '');
  await expect(page.locator('.playback-rate-content')).toHaveAttribute('aria-hidden', 'true');
  await page.evaluate(() => (window as any).__releaseRatePlacement());
  await expect(popup(page)).toHaveCount(0);
  await expect(page.getByTestId('native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  await expect(trigger).toBeFocused();
  expect((await actions(page)).filter((action: any) => ['rate', 'seek', 'toggle-pause', 'play'].includes(action.action))).toEqual([]);
  await trigger.press('Space'); await expect(slider(page)).toBeFocused(); await expect(slider(page)).toHaveValue('1');
});

test('interrupted widget motion reverses continuously and a new modal retains focus', async ({ page }) => {
  const trigger = await openStudy(page); await trigger.click();
  const poses = await page.evaluate(async () => {
    const read = () => Number(getComputedStyle(document.querySelector('.playback-rate-content')!).opacity);
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    while (read() < .45) await frame(); const entering = read();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frame(); const closing = read(); document.querySelector<HTMLButtonElement>('.playback-rate-trigger')!.click();
    await frame(); return { entering, closing, reopened: read() };
  });
  expect(poses.entering).toBeLessThan(.95); expect(poses.closing).toBeLessThan(poses.entering + .05);
  expect(Math.abs(poses.reopened - poses.closing)).toBeLessThan(.15);
  await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Playback settings', exact: true });
  await expect(settings).toBeVisible(); await expect(popup(page)).toHaveCount(0);
  await expect.poll(() => settings.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0);
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
    await page.screenshot({ path: `test-results/playback-rate/widget-${width}-dark-ja.png` });
    await page.getByRole('button', { name: '0.75', exact: true }).click(); await expect(slider(page)).toHaveValue('0.75');
    await expect(popup(page)).toHaveAttribute('data-state', 'open');
    await page.getByRole('button', { name: '再生速度設定を閉じる', exact: true }).click(); await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  });
}
