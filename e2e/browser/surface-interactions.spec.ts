// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
test.describe(`dialog motion: ${reducedMotion}`, () => {
test.use({ reducedMotion });

test.beforeEach(async ({ page }) => {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'import "/e2e/browser/surface-fixture.tsx";',
  }));
  await page.goto('/');
});

test('nested dialogs own Escape and restore focus in order', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'Open editor' });
  await opener.click();
  const innerOpener = page.getByRole('button', { name: 'Open confirmation' });
  await innerOpener.click();
  await expect(page.getByRole('dialog', { name: 'Confirmation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Confirmation' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Editor' })).toBeVisible();
  await expect(innerOpener).toBeFocused();
  await expect(page.getByTestId('surface-state')).toHaveText('hidden');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByTestId('surface-state')).toHaveText('visible');
});

test('notifications stay visible and clickable on the native top layer', async ({ page }) => {
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Fail save' }).click();
  const notification = page.getByRole('button', { name: 'Could not save' });
  await expect(notification).toBeVisible();
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  const inner = page.getByRole('dialog', { name: 'Confirmation' });
  await expect(inner.getByRole('button', { name: 'Could not save' })).toBeVisible();
  await expect(notification).toHaveCount(1);
  const hit = await notification.evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  });
  expect(hit).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Editor' }).getByRole('button', { name: 'Could not save' })).toBeVisible();
  await notification.click();
  await expect(notification).toHaveCount(0);
});

test('saving blocks close, backdrop and Escape until unlocked', async ({ page }) => {
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('checkbox', { name: 'Saving' }).check();
  const dialog = page.getByRole('dialog', { name: 'Editor' });
  await expect(dialog.getByRole('button', { name: /Close|閉じる/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
  await page.getByRole('checkbox', { name: 'Saving' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

for (const viewport of [{ width: 1024, height: 700 }, { width: 1440, height: 900 }, { width: 800, height: 900 }]) {
  test(`notifications remain reachable after scrolling a long dialog at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Open long editor' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editor' });
    const save = dialog.getByRole('button', { name: 'Save changes', exact: true });
    await save.click();
    const notification = dialog.getByRole('button', { name: 'Could not save changes' });
    await expect(notification).toBeInViewport();
    await save.scrollIntoViewIfNeeded();
    await expect(notification).toBeInViewport();
    const geometry = await dialog.evaluate(node => {
      const host = node.querySelector('.modal-notifications')!.getBoundingClientRect();
      const body = node.querySelector('.modal-body')!.getBoundingClientRect();
      const buttons = Array.from(node.querySelectorAll('button')).filter(button => ['Save changes', 'Could not save changes'].includes(button.textContent ?? ''));
      return {
        separated: host.bottom <= body.top + 4,
        contained: node.scrollWidth <= node.clientWidth,
        reachable: buttons.every(button => {
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }),
      };
    });
    expect(geometry).toEqual({ separated: true, contained: true, reachable: true });
    await page.screenshot({ path: testInfo.outputPath('long-dialog-notification.png') });
    await notification.click();
    await expect(notification).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Phrase 20', exact: true })).toHaveValue('An editable phrase');
  });
}

});
}
