// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type Page, type TestInfo } from '@playwright/test';
type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type Frame = { at: number; video: Box; dock: Box; rail: Box; panel: Box; hidden: boolean; inert: boolean; expanded: boolean; opaque: boolean; overflow: boolean };

/** Inspect the browser's actual CSS transition at fixed timeline positions. */
export function sampleDrawer(page: Page, reverse = false) {
  return observeDrawer(page, reverse, true);
}

/** Real-time observation remains available for the independent recording smoke tests. */
export async function observeDrawer(page: Page, reverse = false, controlled = false) {
  return page.evaluate(async ({ reverse, controlled }) => {
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
    const read = (at = performance.now() - start) => {
      let opaque = true;
      for (let node: Element | null = video; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        opaque &&= style.opacity === '1' && style.transform === 'none' && style.translate === 'none';
      }
      return { at, video: rect(video), dock: rect(dock), rail: rect(rail), panel: rect(panel),
        hidden: panel.hidden, inert: panel.inert, expanded: toggle.getAttribute('aria-expanded') === 'true', opaque,
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    };
    const frames = [read()];
    let reversed = false;
    if (controlled) {
      // Stay in this task (and its microtasks) until sampling is complete: a busy
      // runner may miss every RAF in a 220 ms animation. Seeking the real CSS
      // transition still exercises browser layout, interpolation, and reversal,
      // without stretching product timings or racing the 320 ms safety timer.
      const transitions: { property: string; duration: number; easing: string }[] = [];
      const pauseTransition = () => {
        const property = innerWidth >= 1000 ? 'width' : 'height';
        const transition = dock.getAnimations().find(animation =>
          animation instanceof CSSTransition && animation.transitionProperty === property);
        if (!transition) {
          throw new Error(`Expected a CSS ${property} transition on the drawer: ${JSON.stringify({
            open: dock.dataset.open, moving: dock.dataset.moving, size: getComputedStyle(dock)[property],
            animations: dock.getAnimations().map(animation => ({ type: animation.constructor.name, state: animation.playState })),
          })}`);
        }
        const timing = transition.effect!.getTiming();
        transitions.push({ property, duration: Number(timing.duration), easing: timing.easing });
        transition.pause();
        transition.currentTime = 0;
        return transition;
      };
      const transitionFromClick = () => new Promise<Animation>((resolve, reject) => {
        const wasOpen = dock.dataset.open;
        const observer = new MutationObserver(() => {
          if (dock.dataset.open === wasOpen) return;
          observer.disconnect();
          try { resolve(pauseTransition()); } catch (error) { reject(error); }
        });
        observer.observe(dock, { attributes: true, attributeFilter: ['data-open'] });
        toggle.click();
      });
      let transition = await transitionFromClick();
      const duration = Number(transition.effect!.getTiming().duration);
      const positions = reverse ? [0, 20, 40, 70] : [0, 22, 55, 110, 165, 198, 219];
      for (const at of positions) {
        transition.currentTime = at;
        frames.push(read(at));
      }
      if (reverse) {
        transition = await transitionFromClick();
        reversed = true;
        const reverseDuration = Number(transition.effect!.getTiming().duration);
        for (const fraction of [0, .1, .25, .5, .75, .9, .99]) {
          transition.currentTime = reverseDuration * fraction;
          frames.push(read(70 + reverseDuration * fraction));
        }
      }
      // Sample the final state only after React has committed the real
      // transitionend handler's content disposal and focus restoration.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { observer.disconnect(); clearTimeout(timeout); };
        const observer = new MutationObserver(() => {
          if (dock.dataset.moving !== 'false') return;
          cleanup();
          resolve();
        });
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Drawer did not settle after transition completion')); }, 5000);
        observer.observe(dock, { attributes: true, attributeFilter: ['data-moving'] });
        transition.finish();
      });
      frames.push(read(reverse ? 70 + transitions[1].duration : duration));
      return { frames, reversed, transitions };
    }
    toggle.click();
    while (performance.now() - start < 650) {
      await new Promise(requestAnimationFrame);
      frames.push(read());
      if (reverse && !reversed && performance.now() - start >= 70 && !toggle.disabled) {
        toggle.click();
        reversed = true;
      }
    }
    return { frames, reversed, transitions: [] };
  }, { reverse, controlled });
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
  expect(new Set(intermediate.map(Math.round)).size, 'drawer must occupy intermediate sizes').toBeGreaterThan(3);
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
