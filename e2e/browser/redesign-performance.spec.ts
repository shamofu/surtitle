// SPDX-License-Identifier: GPL-3.0-or-later
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { installLearningFixture } from './learning-fixture';

// Opt-in diagnostics, not a timing threshold in CI. Values include Playwright's
// input delivery and two browser frames, and are not equivalent to field INP.
test.skip(!process.env.SURTITLE_PERFORMANCE, 'Run explicitly for comparative browser measurements');
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const phase = process.env.SURTITLE_PERFORMANCE || 'current';
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = []; browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
});
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]); });
function save(name: string, result: unknown) {
  mkdirSync('work/ui-evaluation/performance', { recursive: true });
  writeFileSync(`work/ui-evaluation/performance/${phase}-${name}.json`, JSON.stringify(result, null, 2));
}
const painted = (page: Page) => page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
const summary = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { samples: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }; };

for (const count of [100, 1000]) test(`phrase search ${count}`, async ({ page }) => {
  test.setTimeout(120_000);
  await installLearningFixture(page, 'en', 'light', { cardCount: count });
  await page.goto('/cards');
  const search = page.getByRole('textbox', { name: 'Search your phrases' });
  await expect(search).toBeVisible();
  await expect(page.locator('.phrase-card').first()).toBeVisible();
  const renderedCards = await page.locator('.phrase-card').count();
  const domNodes = await page.locator('*').count();
  const elapsed: number[] = [];
  for (let round = 0; round < 10; round++) for (const value of ['phrase 00099', '']) {
    const start = await page.evaluate(() => performance.now());
    await search.fill(value);
    await expect(page.locator('.phrase-card').first()).toContainText(value || 'phrase 00000');
    elapsed.push(await painted(page) - start);
  }
  save(`cards-${count}`, { phase, count, renderedCards, domNodes, search: summary(elapsed) });
});

for (const count of [120, 10000]) test(`transcript search ${count}`, async ({ page }) => {
  await installLearningFixture(page, 'en', 'light', { segmentCount: count });
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.current-caption-text')).toBeVisible();
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search transcript' });
  await expect(search).toBeVisible();
  const elapsed: number[] = [];
  for (let round = 0; round < 10; round++) for (const value of ['little detour', '']) {
    const start = await page.evaluate(() => performance.now());
    await search.fill(value);
    await expect(search).toHaveValue(value);
    elapsed.push(await painted(page) - start);
  }
  save(`transcript-${count}`, { phase, count, renderedRows: await page.locator('.virtual-transcript > *').count(), search: summary(elapsed) });
});

test('idle and event IPC counts', async ({ page }) => {
  await page.clock.install();
  await installLearningFixture(page, 'en', 'light');
  await page.goto('/study/visual-fixture');
  await expect(page.locator('.current-caption-text')).toBeVisible();
  await painted(page);
  const calls = () => page.evaluate(() => {
    const result: Record<string, number> = {};
    for (const { command } of (window as any).__learningFixture.calls.splice(0)) result[command] = (result[command] ?? 0) + 1;
    return result;
  });
  await calls();
  await page.clock.runFor(65_000);
  const idle = await calls();
  await page.evaluate(() => { const fixture = (window as any).__learningFixture; for (let i = 0; i < 100; i++) fixture.publish('player-state', { ...fixture.state, positionMs: 76000 + i }); });
  await page.clock.runFor(200);
  const playback = await calls();
  await page.evaluate(() => { const fixture = (window as any).__learningFixture; for (let revision = 1; revision <= 50; revision++) fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision, domain: 'operations' }); });
  await page.clock.runFor(200);
  const operations = await calls();
  await page.evaluate(() => { const fixture = (window as any).__learningFixture; for (let revision = 51; revision <= 70; revision++) fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision, domain: 'jobs' }); });
  await page.clock.runFor(200);
  const jobs = await calls();
  expect(idle.get_app_snapshot ?? 0).toBe(0);
  expect(idle.get_change_checkpoint).toBe(1);
  expect(playback.get_app_snapshot ?? 0).toBe(0);
  expect(operations.get_app_snapshot ?? 0).toBe(0);
  expect(operations.list_operation_progress).toBe(1);
  expect(jobs.get_snapshot_patch).toBe(1);
  save('ipc', { phase, idle65Seconds: idle, playback100Events: playback, operation50Events: operations, jobs20Events: jobs });
});
