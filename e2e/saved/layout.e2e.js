// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';

// Read-only layout investigation in an explicitly selected saved-response profile.
// Navigation and scrolling never create, confirm, edit, or remove learning data.
const root = process.env.SURTITLE_E2E_DATA_DIR;
assert(root && basename(root).startsWith('surtitle-e2e-saved-study-'));
assert.equal(realpathSync(root).toLowerCase(), resolve(root).toLowerCase());
const fixture = JSON.parse(readFileSync(resolve(root, 'fixture.json'), 'utf8'));
assert.equal(fixture.format, 'surtitle.offline-saved-study.v1');
const profile = fixture.profiles.find(item => item.profileId === 'current120');
assert(profile);
const prefix = `layout-diagnostic-${Date.now()}`;
const observations = [];
let originalSelections;

async function invoke(command, args = {}) {
  const result = await browser.execute(async (name, parameters) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(name, parameters) }; }
    catch (error) { return { failure: String(error) }; }
  }, command, args);
  if (result.failure) throw Error(`${command}: ${result.failure}`);
  return result.value;
}

async function capture(label) {
  const layout = await browser.execute(() => {
    const round = value => Math.round(value * 1000) / 1000;
    function metrics(element) {
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return {
        tag: element.tagName, id: element.id, className: element.className,
        rect: Object.fromEntries(['x', 'y', 'left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, round(rect[key])])),
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, offsetWidth: element.offsetWidth,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, offsetHeight: element.offsetHeight,
        scrollLeft: round(element.scrollLeft), scrollTop: round(element.scrollTop),
        css: Object.fromEntries(['display', 'position', 'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'overflow', 'overflowX', 'overflowY', 'scrollBehavior', 'scrollbarGutter', 'gridTemplateColumns', 'flexShrink', 'boxSizing', 'transform'].map(key => [key, css[key]])),
      };
    }
    const selectors = ['html', 'body', '#root', '.app-shell', '.sidebar', '.app-main', '.page-content', '.study-page', '.study-top', '.study-grid', '.study-left', '.player-card', '.native-player-viewport', '.transcript-panel', '.transcript-header', '.transcript-tabs', '.draft-study', '.draft-study-heading', '.draft-study-cues', '.draft-study-bookmark-list', '.draft-study-bookmark-list > button', '.draft-study-editor', '.draft-study-editor .field-row', '.draft-study-editor textarea', '.draft-study-editor .inline-actions'];
    const elements = Object.fromEntries(selectors.map(selector => [selector, Array.from(document.querySelectorAll(selector)).slice(0, 8).map(metrics)]));
    const ancestors = [];
    let element = document.querySelector('.draft-study-editor');
    while (element) { ancestors.push(metrics(element)); element = element.parentElement; }
    const overflows = Array.from(document.querySelectorAll('.app-shell *'))
      .filter(item => item.clientWidth > 0 && item.scrollWidth > item.clientWidth + 1)
      .map(metrics).sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth)).slice(0, 40);
    return {
      viewport: { innerWidth, innerHeight, devicePixelRatio, windowScrollX: scrollX, windowScrollY: scrollY, visualViewport: window.visualViewport ? { width: visualViewport.width, height: visualViewport.height, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale } : null },
      elements, editorAncestors: ancestors, horizontalOverflowCandidates: overflows,
    };
  });
  const screenshot = `${prefix}-${label}.png`;
  await browser.saveScreenshot(resolve(root, screenshot));
  observations.push({ label, screenshot, ...layout });
}

describe('saved draft layout geometry without learning mutations', () => {
  it('measures every scroll ancestor around a real bookmark click and editor scroll', async () => {
    await browser.setTimeout({ script: 180000 });
    await browser.waitUntil(() => browser.execute(() => !!window.__TAURI_INTERNALS__));
    await $('h1').waitForDisplayed();
    const snapshot = await invoke('get_app_snapshot');
    assert.equal(snapshot.settings.credentialConfigured, false);
    assert.equal(snapshot.budget.spentUsd, 0);
    assert.equal(snapshot.budget.reservedUsd, 0);
    assert.equal(snapshot.budget.limitUsd, 0);
    originalSelections = await invoke('list_draft_selections', { mediaId: profile.mediaId });
    assert.equal(originalSelections.length, 5, 'Use the existing completed v2 saved-study profile');
    await capture('initial');
    await browser.execute(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/study/${profile.mediaId}`);
    const tab = $('button=Study a draft');
    await tab.waitForClickable(); await tab.click();
    const select = $('[aria-label="Study from drafts"] select');
    await select.waitForDisplayed(); await select.selectByAttribute('value', profile.jobId);
    await $('.draft-study-cue').waitForDisplayed();
    await $('.draft-study-bookmark-list > button').waitForExist();
    await capture('draft-loaded');
    const bookmarks = $('.draft-study-bookmark-list');
    await bookmarks.scrollIntoView({ block: 'center' });
    await capture('bookmark-scroll-immediate');
    await browser.pause(1000);
    await capture('bookmark-scroll-settled');
    const bookmark = bookmarks.$('button');
    await bookmark.waitForClickable(); await bookmark.click();
    const editor = $('[aria-label="Check selected phrase"]');
    await editor.waitForExist();
    await capture('after-real-bookmark-click');
    await editor.scrollIntoView({ block: 'center' });
    await capture('editor-center-immediate');
    await browser.pause(1000);
    await capture('editor-center-settled');
    await editor.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
    await capture('editor-start-nearest-instant');
    // Retain the ineffective WDIO stages above as a comparison. The DOM API
    // scrolls the actual nested ancestor without synthesizing any UI clicks.
    await browser.execute(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), await editor);
    await capture('editor-dom-center');
    const visibility = await browser.execute(() => {
      const pane = document.querySelector('.draft-study').getBoundingClientRect();
      const text = document.querySelector('.draft-study-editor textarea').getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      return {
        textInsidePane: text.top >= Math.max(0, pane.top) && text.bottom <= Math.min(innerHeight, pane.bottom),
        sidebarInsideViewport: sidebar.left >= 0 && sidebar.right <= innerWidth,
      };
    });
    assert.equal(visibility.textInsidePane, true, 'The real editor text field must be visible inside its scrolling pane');
    assert.equal(visibility.sidebarInsideViewport, true, 'Scrolling the editor must not displace the sidebar');
    assert.deepEqual(await invoke('list_draft_selections', { mediaId: profile.mediaId }), originalSelections);
  });

  after(() => {
    writeFileSync(resolve(root, `${prefix}.json`), JSON.stringify({ schemaVersion: 1, kind: 'read-only-draft-layout-diagnostic', profileId: profile.profileId, mediaId: profile.mediaId, binary: process.env.SURTITLE_E2E_BINARY, learningMutationsRequested: 0, providerRequests: 0, observations }, null, 2) + '\n', { flag: 'wx' });
  });
});
