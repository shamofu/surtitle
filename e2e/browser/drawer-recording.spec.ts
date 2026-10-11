// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { observeDrawer, expectSafeFrames, recordFrames } from './drawer-motion-fixture';
test.use({ video: { mode: 'on', size: { width: 1440, height: 900 } } });
for (const width of [1440, 800]) {
  test(`captures real intermediate drawer frames at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installLearningFixture(page, 'ja', 'light');
    await page.goto('/study/visual-fixture');
    await page.waitForLoadState('networkidle');
    const observed = await recordFrames(page, info, () => observeDrawer(page));
    expectSafeFrames(observed.frames, width >= 1000);
    await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
    await page.getByLabel('字幕を検索').fill('coast');
    await page.getByRole('button', { name: '字幕一覧', exact: true }).click();
    await expect(page.locator('.study-companion')).toBeHidden();
  });
}
