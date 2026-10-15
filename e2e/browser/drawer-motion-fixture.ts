// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type Page } from '@playwright/test';
type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type Frame = { at: number; video: Box; dock: Box; rail: Box; panel: Box; scrollTop: number; hidden: boolean; inert: boolean; expanded: boolean; opaque: boolean; overflow: boolean };

/** Observe shared drawer/player layout progress without transforming native ancestors. */
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
    do {
      await new Promise(requestAnimationFrame); frames.push(read());
      if (performance.now() - start > 5000) throw new Error('The transcript panel did not finish opening');
    } while (dock.dataset.moving === 'true' || panel.inert || panel.hidden);
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
