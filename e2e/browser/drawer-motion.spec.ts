// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { observeDrawer, expectSafeFrames } from './drawer-motion-fixture';

for (const locale of ['ja','en'] as const) for(const theme of ['light','dark'] as const) {
  for(const size of [{width:1440,height:900},{width:1024,height:700},{width:800,height:900}]) {
    test(`panel reserves stable geometry and preserves input ${locale} ${theme} ${size.width}`, async ({page})=>{
      await page.setViewportSize(size); await page.emulateMedia({reducedMotion:'no-preference'});
      await installLearningFixture(page,locale,theme); await page.goto('/study/visual-fixture');
      await expect(page.locator('.current-caption-text')).not.toBeEmpty();
      const observed=await observeDrawer(page); expectSafeFrames(observed.frames,size.width>=1000);
      const dock=page.locator('.study-companion-dock');
      await expect(dock).toHaveAttribute('data-moving','false');
      expect(await dock.evaluate(element=>element.getAnimations().filter(animation=>animation instanceof CSSTransition && ['width','height','transform','opacity'].includes(animation.transitionProperty)).length)).toBe(0);
      const toggle=page.getByRole('button',{name:locale==='ja'?'字幕一覧':'Transcript',exact:true});
      const search=page.getByLabel(locale==='ja'?'字幕を検索':'Search transcript');
      await search.fill('coast');const original=await search.elementHandle();
      await page.keyboard.press('Escape');
      await expect(page.locator('.study-companion')).toBeVisible();
      await expect(search).toHaveValue('coast');
      await page.getByRole('button', { name: locale === 'ja' ? 'パネルを閉じる' : 'Close panel', exact: true }).focus();
      await page.keyboard.press('Escape');await expect(page.locator('.study-companion')).toBeHidden();
      await expect(toggle).toBeFocused();await toggle.press('Enter');
      await expect(search).toHaveValue('coast');expect(await original!.evaluate(element=>element.isConnected)).toBe(true);
      await page.getByRole('tab',{name:locale==='ja'?'AI の提案':'Suggestions',exact:true}).click();
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
      await page.getByRole('tab',{name:locale==='ja'?'字幕':'Transcript',exact:true}).click();
      await expect(search).toHaveValue('coast');
    });
  }
}
