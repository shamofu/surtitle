// SPDX-License-Identifier: GPL-3.0-or-later
import { JSDOM } from 'jsdom';
import { beforeAll, expect, test, vi } from 'vitest';

vi.mock('webdriverio', () => ({ Key: {} }));

let draftSurfaceSettled;
beforeAll(async () => {
  // Import the real native navigation predicate without registering the native
  // scenarios or starting a WebDriver session in the scripts test project.
  vi.stubGlobal('describe', Object.assign(() => {}, { skip: () => {} }));
  try { ({ draftSurfaceSettled } = await import('../native/draft-study.e2e.js')); }
  finally { vi.unstubAllGlobals(); }
});

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

test('waits for finite animations while leaving perpetual loaders alone', () => {
  const view = fixture();
  try {
    const loader = { pending: false, playState: 'running', effect: { getTiming: () => ({ iterations: Infinity }) } };
    const reveal = { pending: false, playState: 'running', effect: { getTiming: () => ({ iterations: 1 }) } };
    view.region.getAnimations = () => [loader, reveal];
    expect(draftSurfaceSettled(view.target)).toBe(false);
    reveal.playState = 'finished';
    expect(draftSurfaceSettled(view.target)).toBe(true);
    reveal.pending = true;
    expect(draftSurfaceSettled(view.target)).toBe(false);
  } finally { view.dom.window.close(); }
});
