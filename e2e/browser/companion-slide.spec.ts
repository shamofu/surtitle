// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

test('transcript and activity move their heading and live body together without resizing video', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByLabel('Search transcript').fill('coast');
  const scrollBefore = await page.locator('.transcript-scroll').evaluate(node => { node.scrollTop = 450; return node.scrollTop; });
  expect(scrollBefore).toBeGreaterThan(100);
  const frames = await page.evaluate(async () => {
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search transcript"]')!;
    const video = document.querySelector('.native-player-viewport')!;
    const panel = document.querySelector('.study-companion')!;
    const oldHeading = panel.querySelector('h2')!;
    const before = { video: video.getBoundingClientRect().toJSON(), panel: panel.getBoundingClientRect().toJSON() };
    (document.querySelector('[aria-controls="study-management"]') as HTMLButtonElement).click();
    const frames = [];
    for (let index = 0; index < 25; index += 1) {
      await new Promise(requestAnimationFrame);
      const heading = [...panel.querySelectorAll('h2')].find(node => node.textContent === 'Activity & tools');
      frames.push({
        oldX: oldHeading.getBoundingClientRect().x,
        bodyX: search.getBoundingClientRect().x,
        newX: heading?.getBoundingClientRect().x,
        inert: !!search.closest('[inert][aria-hidden="true"]'),
        video: video.getBoundingClientRect().toJSON(), panel: panel.getBoundingClientRect().toJSON(),
      });
    }
    return { before, frames, value: search.value };
  });
  const moving = frames.frames.filter(frame => frame.newX !== undefined && frame.oldX < frames.frames[0].oldX - 2 && frame.oldX > frames.before.panel.x - frames.before.panel.width);
  expect(moving.length).toBeGreaterThan(2);
  expect(moving.every(frame => Math.abs(frame.newX! - frame.oldX - (frames.before.panel.width - 2)) < 1)).toBe(true);
  expect(moving.every(frame => frame.inert)).toBe(true);
  expect(moving.every(frame => Math.abs((frame.oldX - frames.frames[0].oldX) - (frame.bodyX - frames.frames[0].bodyX)) < 1)).toBe(true);
  expect(frames.frames.every(frame => JSON.stringify(frame.video) === JSON.stringify(frames.before.video) && JSON.stringify(frame.panel) === JSON.stringify(frames.before.panel))).toBe(true);
  expect(frames.value).toBe('coast');
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
  await expect.poll(() => page.locator('.transcript-scroll').evaluate(node => node.scrollTop)).toBeCloseTo(scrollBefore, 0);
});

test('rapid reversals continue from the visible position and keep only the latest destination interactive', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByLabel('Search transcript').fill('coast');
  const observations = await page.evaluate(async () => {
    const transcript = document.querySelector<HTMLElement>('[data-companion-view="transcript"]')!;
    const activity = document.querySelector<HTMLElement>('[data-companion-view="activity"]')!;
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search transcript"]')!;
    const button = document.querySelector<HTMLButtonElement>('[aria-controls="study-management"]')!;
    const toggle = document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!;
    const frame = () => new Promise(requestAnimationFrame);
    button.click();
    for (let i = 0; i < 5; i++) await frame();
    const before = transcript.getBoundingClientRect().x;
    await new Promise<void>(resolve => {
      const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(transcript, { attributes: true, attributeFilter: ['inert'] });
      toggle.click();
    });
    const after = transcript.getBoundingClientRect().x;
    const interactive = !transcript.inert && activity.inert && activity.getAttribute('aria-hidden') === 'true';
    for (let i = 0; i < 3; i++) await frame();
    const reversedX = transcript.getBoundingClientRect().x;
    button.click();
    for (let i = 0; i < 3; i++) await frame();
    toggle.click();
    for (let i = 0; i < 30; i++) await frame();
    return { before, after, reversedX, interactive, latestActive: !transcript.inert && activity.hidden,
      sameInput: input === document.querySelector('[aria-label="Search transcript"]'), value: input.value,
      transform: getComputedStyle(transcript).transform };
  });
  expect(observations.before).toBeGreaterThan(0);
  expect(Math.abs(observations.after - observations.before)).toBeLessThan(1);
  expect(observations.reversedX).toBeGreaterThan(observations.after);
  expect(observations.interactive).toBe(true);
  expect(observations.latestActive).toBe(true);
  expect(observations.sameInput).toBe(true);
  expect(observations.value).toBe('coast');
  expect(observations.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
});

test('enabling reduced motion during the slide immediately settles the latest page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByLabel('Search transcript').fill('coast');
  await page.evaluate(async () => {
    (document.querySelector('[aria-controls="study-management"]') as HTMLButtonElement).click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const settled = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const activity = document.querySelector('[data-companion-view="activity"]')!;
    const transcript = document.querySelector<HTMLElement>('[data-companion-view="transcript"]')!;
    return { transform: getComputedStyle(activity).transform, oldHidden: transcript.hidden };
  });
  expect(settled).toEqual({ transform: 'matrix(1, 0, 0, 1, 0, 0)', oldHidden: true });
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
  await expect(page.locator('[data-companion-view="activity"]')).toBeHidden();
  await expect(page.locator('[data-companion-view="transcript"]')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
});

test('closing the dock during a page slide settles the latest choice before reopening', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await page.getByLabel('Search transcript').fill('coast');
  await page.evaluate(async () => {
    const toggle = document.querySelector<HTMLButtonElement>('[aria-controls="study-management"]')!;
    toggle.click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    toggle.click();
  });
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'true');
  await expect(page.locator('[data-companion-view="transcript"]')).toBeHidden();
  await expect(page.locator('[data-companion-view="activity"]')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(page.locator('.study-companion')).toBeHidden();
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
  await expect(page.locator('[data-companion-view="activity"]')).toBeHidden();
});

test('activity history expansion and scroll survive transcript round trips', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installLearningFixture(page, 'en', 'light');
  await page.addInitScript(() => {
    (window as any).__learningFixture.snapshot.jobs = Array.from({ length: 20 }, (_, index) => ({
      id: `history-${index}`, mediaId: 'visual-fixture', kind: 'translate', status: 'completed', progress: 1,
      createdAt: '', message: `Completed translation ${index}`,
    }));
  });
  await page.goto('/study/visual-fixture');
  await page.getByLabel('Search transcript').fill('coast');
  await page.getByRole('button', { name: 'Activity & tools', exact: true }).click();
  await page.locator('.study-jobs > summary').click();
  const history = page.locator('.study-jobs');
  await expect(history).toHaveAttribute('open', '');
  await expect.poll(() => history.evaluate(node => node.style.height)).toBe('');
  const scroll = await page.locator('.study-auxiliary').evaluate(node => {
    node.scrollTop = 300;
    return node.scrollTop;
  });
  expect(scroll).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('coast');
  await expect(page.locator('[data-companion-view="activity"]')).toBeHidden();
  await page.getByRole('tab', { name: 'Suggestions', exact: true }).click();
  await page.getByRole('button', { name: 'Activity & tools', exact: true }).click();
  await expect(history).toHaveAttribute('open', '');
  await expect.poll(() => page.locator('.study-auxiliary').evaluate(node => node.scrollTop)).toBe(scroll);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Suggestions', exact: true })).toHaveAttribute('aria-selected', 'true');
});
