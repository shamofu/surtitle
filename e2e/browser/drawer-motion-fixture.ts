// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type Page, type TestInfo } from '@playwright/test';
type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type Frame = { at: number; video: Box; dock: Box; rail: Box; panel: Box; scrollTop: number; hidden: boolean; inert: boolean; expanded: boolean; opaque: boolean; overflow: boolean };

/** Observe immediate layout and subsequent frames; native surfaces must not animate. */
export async function observeDrawer(page: Page) {
  return page.evaluate(async () => {
    const toggle = document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!;
    const panel = document.querySelector<HTMLElement>('.study-companion')!;
    const dock = document.querySelector<HTMLElement>('.study-companion-dock')!;
    const rail = document.querySelector<HTMLElement>('.study-transcript-rail')!;
    const video = document.querySelector<HTMLElement>('.native-player-viewport')!;
    const start = performance.now();
    const rect = (element: Element) => { const {x,y,width,height,right,bottom}=element.getBoundingClientRect(); return {x,y,width,height,right,bottom}; };
    const read = () => {
      let opaque = true;
      for (let node: Element | null = video; node; node = node.parentElement) {
        const style = getComputedStyle(node); opaque &&= style.opacity === '1' && style.transform === 'none' && style.translate === 'none';
      }
      return {at:performance.now()-start,video:rect(video),dock:rect(dock),rail:rect(rail),panel:rect(panel),scrollTop:video.closest('.page-content')?.scrollTop ?? 0,hidden:panel.hidden,inert:panel.inert,expanded:toggle.getAttribute('aria-expanded')==='true',opaque,overflow:document.documentElement.scrollWidth>innerWidth+1};
    };
    const frames=[read()]; toggle.click();
    for(let i=0;i<16;i++){await new Promise(requestAnimationFrame);frames.push(read());}
    return {frames,reversed:false};
  });
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
      // Narrow layouts intentionally scroll the opened panel into view. Compare
      // document positions so that scrolling cannot mask an actual layout shift.
      expect(Math.abs(frame.video.y + frame.scrollTop - frames[0].video.y - frames[0].scrollTop)).toBeLessThan(1);
      expect(Math.abs(frame.rail.y + frame.scrollTop - frames[0].rail.y - frames[0].scrollTop)).toBeLessThan(1);
      expect(Math.abs(frame.video.width - frames[0].video.width)).toBeLessThan(1);
      expect(Math.abs(frame.video.height - frames[0].video.height)).toBeLessThan(1);
    }
  }
}

export async function recordScreencast<T>(page: Page, action: () => Promise<T>, quality = 80) {
  const session = await page.context().newCDPSession(page);
  const images: { data: string; time: number }[] = [];
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const onFrame = (event: { data: string; metadata: { timestamp?: number }; sessionId: number }) => {
    images.push({ data: event.data, time: event.metadata.timestamp ?? 0 });
    const acknowledgement = session.send('Page.screencastFrameAck', { sessionId: event.sessionId })
      .then(() => {}, error => { failures.push(error); })
      .finally(() => { pending.delete(acknowledgement); });
    pending.add(acknowledgement);
  };
  session.on('Page.screencastFrame', onFrame);
  let started = false;
  let observed!: T;
  try {
    await session.send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: 1 });
    started = true;
    observed = await action();
  } catch (error) {
    failures.push(error);
  } finally {
    try { if (started) await session.send('Page.stopScreencast'); }
    catch (error) { failures.push(error); }
    // Stop accepting frames before draining acknowledgements and detaching.
    // Keep rejected recording commands local to this test, never unhandled.
    session.off('Page.screencastFrame', onFrame);
    await Promise.all(pending);
    try { await session.detach(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Browser screencast failed');
  return { observed, images };
}

export async function recordFrames(page: Page, info: TestInfo, action: () => Promise<{ frames: Frame[]; reversed: boolean }>) {
  const { observed, images } = await recordScreencast(page, action);
  await info.attach('drawer-geometry-frames.json', { body: JSON.stringify(observed.frames), contentType: 'application/json' });
  expect(images.length, 'record actual rendered frames as visual evidence').toBeGreaterThan(1);
  // Preserve actual opening frames without inventing intermediate geometry.
  for (let index = 0; index < Math.min(images.length, 8); index++) {
    await info.attach(`drawer-frame-${index + 1}.jpg`, { body: Buffer.from(images[index].data, 'base64'), contentType: 'image/jpeg' });
  }
  return observed;
}
