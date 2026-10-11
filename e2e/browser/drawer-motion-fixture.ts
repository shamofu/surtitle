// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type Page, type TestInfo } from '@playwright/test';
type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type Frame = { at: number; video: Box; dock: Box; rail: Box; panel: Box; hidden: boolean; inert: boolean; expanded: boolean; opaque: boolean; overflow: boolean };

export async function observeDrawer(page: Page, reverse = false) {
  return page.evaluate(async reverse => {
    const toggle = document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!;
    const panel = document.querySelector<HTMLElement>('.study-companion')!;
    const dock = document.querySelector<HTMLElement>('.study-companion-dock')!;
    const rail = document.querySelector<HTMLElement>('.study-transcript-rail')!;
    const video = document.querySelector<HTMLElement>('.native-player-viewport')!;
    const start = performance.now();
    const rect = (element: Element) => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const read = () => {
      let opaque = true;
      for (let node: Element | null = video; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        opaque &&= style.opacity === '1' && style.transform === 'none' && style.translate === 'none';
      }
      return { at: performance.now() - start, video: rect(video), dock: rect(dock), rail: rect(rail), panel: rect(panel),
        hidden: panel.hidden, inert: panel.inert, expanded: toggle.getAttribute('aria-expanded') === 'true', opaque,
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    };
    const frames = [read()];
    let reversed = false;
    toggle.click();
    while (performance.now() - start < 650) {
      await new Promise(requestAnimationFrame);
      frames.push(read());
      if (reverse && !reversed && performance.now() - start >= 70 && !toggle.disabled) {
        toggle.click();
        reversed = true;
      }
    }
    return { frames, reversed };
  }, reverse);
}

export function expectSafeFrames(frames: Frame[], desktop: boolean) {
  for (const frame of frames) {
    expect(frame.opaque, `native ancestor transform or opacity at ${frame.at}ms`).toBe(true);
    expect(frame.overflow, `horizontal overflow at ${frame.at}ms`).toBe(false);
    if (desktop) {
      expect(frame.video.right).toBeLessThanOrEqual(frame.rail.x + 1);
      expect(Math.abs(frame.dock.right - frames[0].dock.right)).toBeLessThan(1);
    } else {
      expect(frame.video.bottom).toBeLessThanOrEqual(frame.rail.y + 1);
      expect(Math.abs(frame.video.y - frames[0].video.y)).toBeLessThan(1);
      expect(Math.abs(frame.rail.y - frames[0].rail.y)).toBeLessThan(1);
      expect(Math.abs(frame.video.width - frames[0].video.width)).toBeLessThan(1);
      expect(Math.abs(frame.video.height - frames[0].video.height)).toBeLessThan(1);
    }
  }
}

export function expectContinuous(frames: Frame[], desktop: boolean, opening: boolean) {
  const values = frames.map(frame => desktop ? frame.dock.width : frame.dock.height);
  const first = values[0];
  const last = values.at(-1)!;
  expect(opening ? last - first : first - last).toBeGreaterThan(200);
  const low = Math.min(first, last), high = Math.max(first, last);
  const intermediate = values.filter(value => value > low + 2 && value < high - 2);
  // Two distinct in-between sizes establish real geometry movement even on busy CI hosts.
  expect(new Set(intermediate.map(Math.round)).size, 'drawer must occupy intermediate sizes').toBeGreaterThan(1);
  const paneWidths = frames.filter(frame => !frame.hidden).map(frame => frame.panel.width);
  expect(Math.max(...paneWidths) - Math.min(...paneWidths), 'text pane must retain its final width').toBeLessThan(1);
  for (let index = 1; index < values.length; index++) {
    expect(opening ? values[index] - values[index - 1] : values[index - 1] - values[index]).toBeGreaterThanOrEqual(-1);
  }
}

export async function recordFrames(page: Page, info: TestInfo, action: () => Promise<{ frames: Frame[]; reversed: boolean }>) {
  const session = await page.context().newCDPSession(page);
  const images: { data: string; time: number }[] = [];
  session.on('Page.screencastFrame', event => {
    images.push({ data: event.data, time: event.metadata.timestamp ?? 0 });
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId });
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
  try {
    const observed = await action();
    await session.send('Page.stopScreencast');
    await info.attach('drawer-geometry-frames.json', { body: JSON.stringify(observed.frames), contentType: 'application/json' });
    expect(images.length, 'record actual rendered frames as visual evidence').toBeGreaterThan(1);
    // Preserve actual intermediate rendered frames, without freezing or stretching the animation.
    for (let index = 0; index < Math.min(images.length, 8); index++) {
      await info.attach(`drawer-frame-${index + 1}.jpg`, { body: Buffer.from(images[index].data, 'base64'), contentType: 'image/jpeg' });
    }
    return observed;
  } finally {
    await session.detach();
  }
}
