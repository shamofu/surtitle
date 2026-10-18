// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const [locale, theme] of [['ja', 'light'], ['en', 'dark']] as const) {
  test(`activity stays visible across navigation with truthful progress ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installLearningFixture(page, locale, theme);
    await page.goto('/');
    const text = (ja: string, en: string) => locale === 'ja' ? ja : en;
    const trigger = page.getByRole('button', { name: text('処理状況を開く', 'Open activity') });
    await expect(trigger).toBeVisible();
    await page.evaluate(() => {
      const fixture = (window as any).__learningFixture;
      const original = fixture.call.bind(fixture);
      const operations = [
        { id: 'ffmpeg', kind: 'tool', toolId: 'ffmpeg', label: 'FFmpeg package', status: 'running', phase: 'downloading', completed: 1048576, total: 4194304, unit: 'bytes', updatedAt: new Date().toISOString() },
        { id: 'vad', kind: 'tool', toolId: 'vad', label: 'Speech detection model', status: 'running', phase: 'verifying', updatedAt: new Date().toISOString() },
      ];
      let revision = 0;
      const changed = () => { for (const domain of ['operations']) fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: ++revision, domain }); };
      fixture.finishProgress = () => {
        operations[0].status = 'completed'; operations[0].phase = 'completed'; operations[0].completed = 4194304; operations[0].updatedAt = new Date().toISOString();
        operations[1].status = 'failed'; operations[1].updatedAt = new Date().toISOString();
        changed();
      };
      changed();
      fixture.call = async (command: string, args?: Record<string, unknown>) => {
        if (command === 'list_operation_progress') return structuredClone(operations);
        return original(command, args);
      };
    });
    await expect(trigger).toContainText('2');
    await page.getByRole('navigation', { name: text('メインナビゲーション', 'Main navigation') }).getByRole('link', { name: text('フレーズ帳', 'Phrases'), exact: true }).click();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: text('処理状況', 'Activity'), exact: true });
    const exact = dialog.getByRole('progressbar', { name: 'FFmpeg package', exact: true });
    await expect(exact).toHaveAttribute('value', '1048576');
    await expect(exact).toHaveAttribute('max', '4194304');
    await expect(dialog.getByRole('progressbar', { name: 'Speech detection model', exact: true })).not.toHaveAttribute('value');
    await expect(dialog.locator('.activity-item')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.evaluate(() => (window as any).__learningFixture.finishProgress());
    await expect(trigger.locator('.nav-count')).toHaveAttribute('data-empty', 'true');
    await expect(trigger.locator('.nav-count')).toBeHidden();
    await trigger.click();
    await expect(dialog.locator('[data-activity-id="ffmpeg"]')).toContainText(text('完了', 'Completed'));
    await expect(dialog.locator('[data-activity-id="vad"]')).toContainText(text('失敗', 'Failed'));
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('activity on Study subtracts its opaque card while preserving video bounds through the mocked transport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  const inspect = page.getByRole('button', { name: 'Explore meaning', exact: true });
  await expect(inspect).toBeEnabled();
  // This verifies the browser-to-native contract using fixture calls, not native video rendering.
  const lastSurfaceAction = () => page.evaluate(() => (window as any).__learningFixture.calls
    .filter((call: any) => call.command === 'player_control' && ['hide', 'bounds'].includes(call.args.request?.action))
    .at(-1)?.args.request);
  await expect.poll(async () => (await lastSurfaceAction())?.action).toBe('bounds');
  const before = (await lastSurfaceAction()).bounds;
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture;
    const original = fixture.call.bind(fixture);
    fixture.call = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_operation_progress') return [{
        id: 'study-tool', kind: 'tool', toolId: 'vad', label: 'Speech detection model',
        status: 'running', phase: 'downloading', completed: 1048576, unit: 'bytes', updatedAt: new Date().toISOString(),
      }];
      return original(command, args);
    };
    fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'operations' });
  });
  const trigger = page.getByRole('button', { name: 'Open activity', exact: true });
  await expect(trigger.locator('.nav-count')).toHaveText('1');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await lastSurfaceAction())?.bounds?.inputBlocked).toBe(true);
  const opened = await lastSurfaceAction();
  expect(opened.action).toBe('bounds');
  expect(opened.bounds.width).toBe(before.width);
  expect(opened.bounds.height).toBe(before.height);
  expect(opened.bounds.occlusions.length).toBeGreaterThan(0);
  expect(opened.bounds.occlusions[0].width).toBeGreaterThan(0);
  expect(opened.bounds.occlusions[0].height).toBeGreaterThan(0);
  const progress = dialog.getByRole('progressbar', { name: 'Speech detection model', exact: true });
  await expect(progress).not.toHaveAttribute('value');
  await expect(progress).toHaveCSS('animation-name', 'none');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await lastSurfaceAction())?.bounds?.inputBlocked).toBe(false);
  expect((await lastSurfaceAction()).bounds.occlusions).toHaveLength(0);
  await expect(trigger).toBeFocused();
  await expect(inspect).toBeEnabled();
});

for (const locale of ['ja', 'en'] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 920, height: 620 }]) {
    test(`shell counts keep learning and navigation stationary ${locale} ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installLearningFixture(page, locale, 'light');
      await page.goto('/study/visual-fixture');
      const trigger = page.getByRole('button', { name: locale === 'ja' ? '処理状況を開く' : 'Open activity', exact: true });
      await expect(page.getByRole('button', { name: locale === 'ja' ? '意味を調べる' : 'Explore meaning', exact: true })).toBeEnabled();
      await page.evaluate(() => {
        const fixture = (window as any).__learningFixture;
        const original = fixture.call.bind(fixture);
        const template = structuredClone(fixture.snapshot.cards[0]);
        let operations: any[] = [];
        let revision = 0;
        let sequence = 0;
        fixture.call = async (command: string, args?: Record<string, unknown>) => command === 'list_operation_progress' ? structuredClone(operations) : original(command, args);
        fixture.setShellCounts = (count: number) => {
          sequence += 1;
          const updatedAt = new Date(Date.now() + sequence * 1000).toISOString();
          operations = operations.map(operation => ({ ...operation, status: 'completed', updatedAt }));
          operations.push(...Array.from({ length: count }, (_, index) => ({ id: `shell-${sequence}-${index}`, kind: 'tool', label: 'Tool', status: 'running', phase: 'downloading', updatedAt })));
          fixture.snapshot.cards = Array.from({ length: count }, (_, index) => ({ ...template, id: `shell-card-${index}` }));
          for (const domain of ['cards', 'operations']) fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: ++revision, domain });
        };
        const selectors = ['.page-content', '.main-nav a[href="/review"]', '.main-nav a[href="/settings"]', '.activity-trigger', '.locale-button'];
        fixture.shellFrames = [];
        let frame = 0;
        const record = () => {
          fixture.shellFrames.push(selectors.map(selector => {
            const bounds = document.querySelector(selector)!.getBoundingClientRect();
            return [bounds.x, bounds.y, bounds.width, bounds.height];
          }));
          frame = requestAnimationFrame(record);
        };
        record();
        fixture.stopShellFrames = () => { cancelAnimationFrame(frame); return fixture.shellFrames; };
      });
      for (const count of [0, 1, 9, 10, 105, 0]) {
        await page.evaluate(count => (window as any).__learningFixture.setShellCounts(count), count);
        await expect(trigger.locator('.nav-count')).toHaveText(count > 99 ? '99+' : String(count));
        await expect(trigger.locator('.nav-count')).toHaveAttribute('data-empty', String(count === 0));
        const review = page.locator('.main-nav a[href="/review"]');
        await expect(review.locator('.nav-count')).toHaveText(count > 99 ? '99+' : String(count));
        if (count) {
          await expect(trigger).toHaveAccessibleDescription(locale === 'ja' ? `${count} 件の処理を実行中。` : `${count} operations running.`);
          await expect(review).toHaveAccessibleName(locale === 'ja' ? `復習 ${count} 件` : `Review ${count} due`);
        }
      }
      const frames: number[][][] = await page.evaluate(() => (window as any).__learningFixture.stopShellFrames());
      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) for (let element = 0; element < frame.length; element++) {
        for (let coordinate = 0; coordinate < 4; coordinate++) expect(Math.abs(frame[element][coordinate] - frames[0][element][coordinate])).toBeLessThan(1);
      }
    });
  }
}

test('a retained refresh failure keeps the page geometry and opens details with retry in Activity', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installLearningFixture(page, 'en', 'dark');
  await page.goto('/study/visual-fixture');
  const inspect = page.getByRole('button', { name: 'Explore meaning', exact: true });
  const trigger = page.getByRole('button', { name: 'Open activity', exact: true });
  await expect(inspect).toBeEnabled();
  const bounds = await page.locator('.page-content').boundingBox();
  const triggerBounds = await trigger.boundingBox();
  await page.evaluate(() => {
    const fixture = (window as any).__learningFixture;
    const original = fixture.call.bind(fixture);
    fixture.snapshotReadFails = true;
    fixture.call = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_app_snapshot' && fixture.snapshotReadFails) throw new Error('Could not refresh snapshot');
      return original(command, args);
    };
    fixture.publish('data-changed', { version: 1, epoch: 'fixture', revision: 1, domain: 'restore' });
  });
  await expect(trigger).toHaveAttribute('data-problem', 'true');
  expect(await page.locator('.page-content').boundingBox()).toEqual(bounds);
  expect(await trigger.boundingBox()).toEqual(triggerBounds);
  await expect(inspect).toBeEnabled();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Could not refresh your data' })).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('Could not refresh snapshot');
  await page.evaluate(() => { (window as any).__learningFixture.snapshotReadFails = false; });
  await dialog.getByRole('button', { name: 'Retry', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Could not refresh your data' })).toHaveCount(0);
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('data-problem', 'false');
  expect(await page.locator('.page-content').boundingBox()).toEqual(bounds);
});
