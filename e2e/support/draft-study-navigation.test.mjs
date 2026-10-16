// SPDX-License-Identifier: GPL-3.0-or-later
import { JSDOM } from 'jsdom';
import { expect, test, vi } from 'vitest';
import { nativeSurfaceSettled as draftSurfaceSettled } from './native-app.mjs';

vi.mock('webdriverio', () => ({ Key: {} }));

function fixture() {
  const dom = new JSDOM(`<div class="study-companion-dock" data-moving="false"><aside class="study-companion">
    <div class="study-motion-region" data-motion-state="open"><details open data-motion-state="open">
      <summary>History</summary><button>Open earlier drafts</button>
    </details></div></aside></div>`);
  const document = dom.window.document;
  const region = document.querySelector('.study-companion');
  region.getAnimations = () => [];
  return { dom, region, target: document.querySelector('button'), dock: document.querySelector('.study-companion-dock'),
    tab: document.querySelector('.study-motion-region'), details: document.querySelector('details') };
}

test('waits for moving native layout and Motion disclosures even when no Web Animations are reported', () => {
  const view = fixture();
  try {
    view.dock.dataset.moving = 'true';
    expect(draftSurfaceSettled(view.target)).toBe(false);
    view.dock.dataset.moving = 'false';
    view.details.style.height = '81px';
    view.details.style.overflow = 'hidden';
    expect(draftSurfaceSettled(view.target)).toBe(false);
    view.details.style.height = '';
    expect(draftSurfaceSettled(view.target)).toBe(false);
    view.details.style.overflow = '';
    view.tab.style.transform = 'translateX(12px)';
    expect(draftSurfaceSettled(view.target)).toBe(false);
    view.tab.style.transform = 'translateX(0px)';
    expect(draftSurfaceSettled(view.target)).toBe(true);
    view.tab.style.transform = 'none';
    expect(draftSurfaceSettled(view.target)).toBe(true);
    view.tab.style.transform = '';
    expect(draftSurfaceSettled(view.target)).toBe(true);
  } finally { view.dom.window.close(); }
});

test('unrelated hover and loader animations do not block a stable input surface', () => {
  const view = fixture();
  try {
    const loader = { pending: false, playState: 'running', effect: { getTiming: () => ({ iterations: Infinity }) } };
    const hover = { pending: false, playState: 'running', effect: { getTiming: () => ({ iterations: 1 }) } };
    view.region.getAnimations = () => [loader, hover];
    expect(draftSurfaceSettled(view.target)).toBe(true);
    hover.pending = true;
    expect(draftSurfaceSettled(view.target)).toBe(true);
  } finally { view.dom.window.close(); }
});
