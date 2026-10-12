// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

type FixtureWindow = Window & {
  __learningFixture: {
    state: { positionMs: number; paused: boolean };
    calls: { command: string; args: { request?: { action?: string; value?: number; startMs?: number; endMs?: number; fields?: Record<string, string> } } }[];
    call: (command: string, args?: Record<string, any>) => Promise<unknown>;
    requestClose: () => boolean;
    closeCount: () => number;
  };
};

type DraftSaveGateWindow = FixtureWindow & {
  __draftSaveGate: { pending: boolean; release: () => void };
};

async function openStudy(page: Page, locale: 'en' | 'ja' = 'en', theme: 'light' | 'dark' = 'light') {
  await installLearningFixture(page, locale, theme);
  await page.goto('/study/visual-fixture');
  await expect(page.getByRole('button', { name: locale === 'ja' ? '意味を調べる' : 'Explore meaning', exact: true })).toBeEnabled();
}

async function createDraft(page: Page, locale: 'en' | 'ja' = 'en') {
  await page.getByRole('button', { name: locale === 'ja' ? '意味を調べる' : 'Explore meaning', exact: true }).click();
  await page.locator('.phrase-save-toggle').click();
  await page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true }).fill('take a little detour');
  await page.getByLabel(locale === 'ja' ? '意味' : 'Meaning', { exact: true }).fill('少し寄り道をする');
}

async function blockDraftSaves(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as FixtureWindow).__learningFixture;
    const original = fixture.call.bind(fixture);
    let release!: () => void;
    const saved = new Promise<void>(resolve => { release = resolve; });
    const gate = { pending: false, release: () => release() };
    Object.assign(window, { __draftSaveGate: gate });
    fixture.call = async (command, args = {}) => {
      if (command === 'save_editor_draft') { gate.pending = true; await saved; }
      return original(command, args);
    };
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`subtitle side tab supports keyboard opening and focus return (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await openStudy(page);
    const toggle = page.getByRole('button', { name: 'Transcript', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', 'study-companion');
    expect(await toggle.evaluate(element => !element.closest('.study-companion, [inert], [hidden]'))).toBe(true);
    await toggle.focus();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.study-companion h2')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Close panel', exact: true })).toBeVisible();
    await page.getByLabel('Search transcript').fill('coast');
    await page.getByRole('button', { name: 'Show translations', exact: true }).click();
    await page.getByRole('tab', { name: 'Suggestions', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await toggle.press('Space');
    await expect(page.getByRole('tab', { name: 'Suggestions', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
    await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
    await expect(page.getByRole('button', { name: 'Hide translations', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toBeFocused();
    await expect(toggle).toBeVisible();
  });
}

test('opening the panel keeps search focus and input through subsequent frames', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await openStudy(page);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const search = page.getByLabel('Search transcript');
  await search.fill('c');
  await page.evaluate(async()=>{for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);});
  await expect(search).toHaveValue('c');await expect(search).toBeFocused();
  await page.keyboard.type('oast');await expect(search).toHaveValue('coast');
  await expect(page.locator('.transcript-row').first()).toContainText('coast');
});

test('real router saves unfinished phrases before leaving and restores them on return', async ({ page }) => {
  await openStudy(page);
  await createDraft(page);
  await page.getByRole('button', { name: 'Continue later', exact: true }).click();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Activity & tools', exact: true }).click();
  await page.locator('.study-phrase-draft > .button').click();
  await expect(page.getByRole('textbox', { name: 'Meaning', exact: true })).toHaveValue('少し寄り道をする');
  await blockDraftSaves(page);
  await page.getByRole('textbox', { name: 'Meaning', exact: true }).fill('少し寄り道をする（あとで追記）');
  await page.getByRole('link', { name: 'Back to library' }).click();
  await expect.poll(() => page.evaluate(() => (window as DraftSaveGateWindow).__draftSaveGate.pending)).toBe(true);
  await expect(page).toHaveURL(/\/study\/visual-fixture$/);
  await expect(page.getByRole('dialog', { name: 'You have unfinished phrases' })).toHaveCount(0);
  await page.evaluate(() => (window as DraftSaveGateWindow).__draftSaveGate.release());
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('dialog', { name: 'You have unfinished phrases' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.filter(call => call.command === 'save_editor_draft').at(-1)?.args.request?.fields)).toMatchObject({
    term: 'take a little detour', meaning: '少し寄り道をする（あとで追記）',
  });
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.some(call => call.command === 'delete_editor_draft'))).toBe(false);
  await page.locator('.media-card').filter({ hasText: 'A walk along the coast' }).click();
  await expect(page).toHaveURL(/\/study\/visual-fixture$/);
  await page.getByRole('button', { name: 'Activity & tools', exact: true }).click();
  await page.locator('.study-phrase-draft > .button').click();
  await expect(page.getByLabel('Word or phrase', { exact: true })).toHaveValue('take a little detour');
  await expect(page.getByRole('textbox', { name: 'Meaning', exact: true })).toHaveValue('少し寄り道をする（あとで追記）');
});

test('a native close request waits for the latest draft save to finish', async ({ page }) => {
  await openStudy(page);
  await blockDraftSaves(page);
  await createDraft(page);
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.requestClose())).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as DraftSaveGateWindow).__draftSaveGate.pending)).toBe(true);
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.closeCount())).toBe(0);
  await expect(page.getByLabel('Word or phrase', { exact: true })).toHaveValue('take a little detour');
  await expect(page.getByRole('dialog', { name: 'You have unfinished phrases' })).toHaveCount(0);
  await page.evaluate(() => (window as DraftSaveGateWindow).__draftSaveGate.release());
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__learningFixture.closeCount())).toBe(1);
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.filter(call => call.command === 'save_editor_draft').at(-1)?.args.request?.fields)).toMatchObject({
    term: 'take a little detour', meaning: '少し寄り道をする',
  });
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.some(call => call.command === 'delete_editor_draft'))).toBe(false);
});

test('real virtualized transcript restores its search, translations and scroll after inspection', async ({ page }) => {
  await openStudy(page);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByLabel('Search transcript').fill('coast');
  await page.getByRole('button', { name: 'Show translations' }).click();
  const list = page.getByLabel('Subtitle list', { exact: true });
  await list.dispatchEvent('wheel', { deltaY: 1200 });
  await list.evaluate(element => { element.scrollTop = 1200; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  const index = await list.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('.transcript-row')].findIndex(row => {
      const box = row.getBoundingClientRect();
      return box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  });
  expect(index).toBeGreaterThanOrEqual(0);
  const offset = await list.evaluate(element => element.scrollTop);
  await page.locator('.transcript-row').nth(index).locator('.segment-text').click();
  await expect(page.getByRole('button', { name: 'Back to transcript', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
  await expect(page.getByRole('button', { name: 'Hide translations' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Show current subtitle', exact: true })).toBeVisible();
  await expect.poll(async () => Math.abs(await list.evaluate(element => element.scrollTop) - offset)).toBeLessThan(2);
  await page.getByRole('button', { name: 'Show current subtitle', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('');
  await expect(page.locator('.transcript-row.playing')).toBeInViewport();
});

for (const locale of ['en', 'ja'] as const) {
  test(`transcript play resumes from the cue while detail playback stays bounded ${locale}`, async ({ page }) => {
    await openStudy(page, locale);
    await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
    const search = page.getByLabel(locale === 'ja' ? '字幕を検索' : 'Search transcript');
    const translations = page.locator('.study-transcript').getByRole('button', { name: locale === 'ja' ? /訳を表示|訳を隠す/ : /Show translations|Hide translations/ });
    const list = page.getByLabel(locale === 'ja' ? '字幕一覧' : 'Subtitle list', { exact: true });
    const back = page.getByRole('button', { name: locale === 'ja' ? '字幕一覧へ戻る' : 'Back to transcript', exact: true });
    await search.fill('coast');
    await translations.click();
    await list.dispatchEvent('wheel', { deltaY: 1200 });
    await list.evaluate(element => { element.scrollTop = 1200; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
    const index = await list.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('.transcript-row')].findIndex(row => {
        const box = row.getBoundingClientRect();
        return box.top >= bounds.top && box.bottom <= bounds.bottom;
      });
    });
    expect(index).toBeGreaterThanOrEqual(0);
    const initialPlay = list.locator('.transcript-row').nth(index).locator('.segment-time');
    const time = (await initialPlay.textContent())!.trim();
    const playName = (await initialPlay.getAttribute('aria-label'))!;
    // Search is cleared after playback starts, so identify the cue independently
    // of its old position within the filtered virtualized rows.
    const play = list.getByRole('button', { name: playName, exact: true });
    const row = list.locator('.transcript-row').filter({ has: page.getByRole('button', { name: playName, exact: true }) });
    const [minutes, seconds] = time.split(':').map(Number);
    const startMs = (minutes * 60 + seconds) * 1000;
    const filteredOffset = await list.evaluate(element => element.scrollTop);
    const playbackRequestsSince = (from: number) => page.evaluate(start => (window as FixtureWindow).__learningFixture.calls
      .slice(start)
      .filter(call => call.command === 'player_control' && ['seek', 'play', 'pause', 'source-seek'].includes(call.args.request?.action ?? ''))
      .map(call => call.args.request), from);
    const callsBeforePlay = await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.length);
    await expect(play).toHaveAccessibleName(locale === 'ja' ? new RegExp(`再生.*${time}$`) : `Play from subtitle ${time}`);
    const playingCueElement = await play.elementHandle();
    await play.click();
    await expect.poll(() => playbackRequestsSince(callsBeforePlay)).toEqual([
      { action: 'seek', value: startMs },
      { action: 'play' },
    ]);
    await expect.poll(() => page.evaluate(() => ({ ...(window as FixtureWindow).__learningFixture.state }))).toMatchObject({ positionMs: startMs, paused: false });
    await expect(back).toHaveCount(0);
    await expect(search).toHaveValue('');
    await expect(translations).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: locale === 'ja' ? '自動追従中' : 'Following playback', exact: true })).toBeVisible();
    await expect(row).toHaveClass(/playing/);
    expect(await playingCueElement!.evaluate(element => element.isConnected &&
      element === document.querySelector('.transcript-row.playing .segment-time'))).toBe(true);
    await expect.poll(() => row.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const viewport = element.closest('.transcript-scroll')!.getBoundingClientRect();
      return Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2);
    })).toBeLessThan(2);

    // Range playback in the inspector keeps a manually browsed view intact.
    await search.fill('coast');
    await list.dispatchEvent('wheel', { deltaY: 0 });
    await list.evaluate((element, offset) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, filteredOffset);
    await row.locator('.segment-text').scrollIntoViewIfNeeded();
    // Search can still be measuring newly visible rows. Capture the position
    // at the actual user action, after Playwright's visibility/scroll checks.
    await row.locator('.segment-text').evaluate(button => button.addEventListener('click', () => {
      const list = button.closest('.transcript-scroll')!;
      list.setAttribute('data-inspection-offset', String(list.scrollTop));
    }, { once: true }));
    await row.locator('.segment-text').click();
    const offset = Number(await list.getAttribute('data-inspection-offset'));
    await expect(back).toBeVisible();
    const callsBeforeReplay = await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.length);
    await page.locator('.context-actions').getByRole('button', { name: locale === 'ja' ? 'この区間を再生' : 'Play this passage', exact: true }).click();
    await expect.poll(() => playbackRequestsSince(callsBeforeReplay)).toEqual([
      { action: 'source-seek', startMs, endMs: startMs + 7000 },
    ]);
    await back.click();
    await expect(search).toHaveValue('coast');
    await expect(translations).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: locale === 'ja' ? '再生中の字幕へ' : 'Show current subtitle', exact: true })).toBeVisible();
    await expect.poll(async () => Math.abs(await list.evaluate(element => element.scrollTop) - offset)).toBeLessThan(2);
    const callsAfterReplay = await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.length);
    await play.click();
    await expect.poll(() => playbackRequestsSince(callsAfterReplay)).toEqual([
      { action: 'seek', value: startMs },
      { action: 'play' },
    ]);
    await expect(back).toHaveCount(0);
    await expect(search).toHaveValue('');
    await expect(page.getByRole('button', { name: locale === 'ja' ? '自動追従中' : 'Following playback', exact: true })).toBeVisible();
  });
}

test('caption navigation preserves playback state and inspector input without AI calls', async ({ page }) => {
  await openStudy(page);
  await page.getByRole('button', { name: 'Next subtitle', exact: true }).click();
  await expect.poll(() => page.evaluate(() => ({ ...(window as FixtureWindow).__learningFixture.state }))).toMatchObject({ positionMs: 77000, paused: true });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Previous subtitle', exact: true }).click();
  await expect.poll(() => page.evaluate(() => ({ ...(window as FixtureWindow).__learningFixture.state }))).toMatchObject({ positionMs: 70000, paused: false });
  await createDraft(page);
  const original = await page.locator('.context-sentence').textContent();
  await page.getByRole('button', { name: 'Next subtitle', exact: true }).click();
  await expect(page.locator('.context-sentence')).toHaveText(original!);
  await expect(page.getByLabel('Word or phrase', { exact: true })).toHaveValue('take a little detour');
  await page.locator('.caption-navigation').getByRole('button', { name: 'Replay this subtitle', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.filter(call => call.command === 'player_control' && call.args.request?.action === 'source-seek').at(-1)?.args.request)).toEqual({ action: 'source-seek', startMs: 77000, endMs: 84000 });
  expect(await page.evaluate(() => (window as FixtureWindow).__learningFixture.calls.some(call => /quote|start_ai|approve_ai/.test(call.command)))).toBe(false);
});

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`unfinished phrases layout ${locale} ${theme} 1024x700`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await openStudy(page, locale, theme);
    await createDraft(page, locale);
    await page.getByRole('button', { name: locale === 'ja' ? 'あとで続ける' : 'Continue later', exact: true }).click();
    await page.getByRole('button', { name: locale === 'ja' ? '処理・管理' : 'Activity & tools', exact: true }).click();
    await expect(page.locator('.study-phrase-draft')).toBeInViewport();
    await expect(page.locator('.caption-navigation')).toBeInViewport();
    await expect(page.getByRole('button', { name: locale === 'ja' ? '次の字幕' : 'Next subtitle', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('unfinished-phrases.png'), animations: 'disabled', fullPage: true });
    await page.locator('.study-phrase-draft > .button').click();
    await expect(page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true })).toHaveValue('take a little detour');
    await page.locator('.save-phrase-form').getByRole('button', { name: locale === 'ja' ? '入力を破棄' : 'Discard draft', exact: true }).click();
    await expect(page.getByRole('button', { name: /入力途中のフレーズ \(1\)|Unfinished phrases \(1\)/ })).toHaveCount(0);
  });
}

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1024, height: 700 }, { width: 1440, height: 900 }, { width: 800, height: 900 }]) {
  test(`study keeps controls reachable with drafts, notices, tools and expanded history ${locale} ${theme} ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await installLearningFixture(page, locale, theme);
    await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
      contentType: 'application/javascript', body: `
        export const nativeAvailable = () => true;
        export const call = async (command, args = {}) => {
          const value = await window.__learningFixture.call(command, args);
          if (command === 'get_app_snapshot') value.jobs = [
            { id: 'active', mediaId: 'visual-fixture', kind: 'translate', status: 'running', progress: .5, createdAt: '', message: 'Translation in progress' },
            ...Array.from({ length: 12 }, (_, index) => ({ id: 'history-' + index, mediaId: 'visual-fixture', kind: 'translate', status: 'completed', progress: 1, createdAt: '', message: 'Completed translation ' + index }))
          ];
          if (command === 'list_ai_continuations') return Array.from({ length: 3 }, (_, index) => ({
            id: 'pending-' + index, mediaId: 'visual-fixture', kind: 'vocabulary', start: '0:00', end: '0:07', wholeMedia: false, focusTerm: 'phrase', models: {}
          }));
          return value;
        }`,
    }));
    await page.goto('/study/visual-fixture');
    await createDraft(page, locale);
    const longTerm = 'LongUnbrokenPhrase'.repeat(20);
    await page.getByLabel(locale === 'ja' ? '語彙・フレーズ' : 'Word or phrase', { exact: true }).fill(longTerm);
    await page.getByRole('button', { name: locale === 'ja' ? 'あとで続ける' : 'Continue later', exact: true }).click();
    await page.getByRole('button', { name: locale === 'ja' ? 'パネルを閉じる' : 'Close panel', exact: true }).click();
    await page.getByRole('button', { name: locale === 'ja' ? '処理・管理' : 'Activity & tools', exact: true }).click();
    await expect(page.locator('.study-auxiliary')).toBeVisible();
    const videoBeforeHistory = await page.getByTestId('native-player-viewport').boundingBox();
    const draft = page.locator('.study-phrase-draft');
    await draft.scrollIntoViewIfNeeded();
    expect(await draft.evaluate(element => {
      const label = element.querySelector('.study-draft-label')!.getBoundingClientRect();
      const time = element.querySelector('.study-draft-time')!.getBoundingClientRect();
      const remove = element.querySelector('.icon-button')!.getBoundingClientRect();
      return label.right <= time.left && time.right <= remove.left && element.scrollWidth <= element.clientWidth;
    })).toBe(true);
    await page.locator('.study-jobs > summary').filter({ hasText: locale === 'ja' ? '処理履歴' : 'Job history' }).click();
    const history = page.locator('.study-jobs').last();
    await expect(history).toHaveAttribute('open', '');
    await expect.poll(() => history.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
    const activity = page.locator('.study-auxiliary');
    // Activity owns its scroll, so growing history cannot take height from the video.
    expect(await activity.evaluate(element => {
      const panel = element.closest('.study-companion')!.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return element.clientHeight > 200 && element.scrollHeight > element.clientHeight
        && bounds.top >= panel.top && bounds.bottom <= panel.bottom + 1;
    })).toBe(true);
    const lastJob = history.getByText('Completed translation 11', { exact: true });
    await lastJob.scrollIntoViewIfNeeded();
    await expect(lastJob).toBeInViewport();
    const videoAfterHistory = await page.getByTestId('native-player-viewport').boundingBox();
    expect(videoAfterHistory!.width).toBeCloseTo(videoBeforeHistory!.width, 0);
    expect(videoAfterHistory!.height).toBeCloseTo(videoBeforeHistory!.height, 0);
    await page.screenshot({ path: testInfo.outputPath('study-expanded-history.png'), animations: 'disabled' });
    await page.getByRole('button', { name: locale === 'ja' ? '字幕一覧' : 'Transcript', exact: true }).click();
    await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
    for (const control of [
      page.getByRole('button', { name: locale === 'ja' ? '次の字幕' : 'Next subtitle', exact: true }),
      page.getByRole('button', { name: locale === 'ja' ? '自動追従中' : 'Following playback', exact: true }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      expect(await control.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      })).toBe(true);
    }
    expect(await page.locator('.page-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('study-controls-and-transcript.png'), animations: 'disabled' });
  });
  }
}
