// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';

for (const [locale, theme] of [['ja', 'light'], ['en', 'dark']] as const) {
  const text = (ja: string, en: string) => locale === 'ja' ? ja : en;

  test(`settings edits survive navigation and validation stays reachable ${locale} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installLearningFixture(page, locale, theme);
    await page.goto('/settings');
    const monthly = page.getByRole('spinbutton', { name: text('1か月のAI予算（USD）', 'Monthly AI budget (USD)'), exact: true });
    const daily = page.getByLabel(text('1日の上限（USD）', 'Daily limit (USD)'), { exact: true });
    const advanced = page.getByText(text('1日・1処理の上限を調整', 'Adjust daily and per-job limits'), { exact: true });
    await advanced.click();
    await daily.fill('-1');
    await advanced.click();
    await expect(daily).toBeHidden();
    const save = page.getByRole('button', { name: text('変更を保存', 'Save changes'), exact: true });
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: text('入力エラーを確認', 'Review errors'), exact: true }).click();
    await expect(daily).toBeFocused();
    await expect(daily).toBeInViewport();
    await expect(daily).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(text('0〜1000 USD の金額を入力してください。', 'Enter an amount between 0 and 1,000 USD.'), { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(save).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('settings-validation.png'), animations: 'disabled' });
    await daily.fill('0');
    await monthly.fill('4');

    // Section anchors move within settings without asking to discard the draft.
    await page.getByRole('navigation', { name: text('設定セクション', 'Settings sections') }).getByRole('link', { name: text('学習', 'Learning'), exact: true }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    const phrasesLink = page.getByRole('link', { name: text('フレーズ帳', 'Phrases'), exact: true });
    await phrasesLink.click();
    const confirmation = page.getByRole('dialog', { name: text('変更を保存しますか？', 'Save your changes?') });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: text('編集を続ける', 'Keep editing'), exact: true }).click();
    await expect(monthly).toHaveValue('4');
    await phrasesLink.click();
    await confirmation.getByRole('button', { name: text('保存して移動', 'Save and leave'), exact: true }).click();
    await expect(page).toHaveURL(/\/cards$/);
    await page.getByRole('link', { name: text('設定', 'Settings'), exact: true }).click();
    await expect(monthly).toHaveValue('4');
    await monthly.fill('9');
    await phrasesLink.click();
    await confirmation.getByRole('button', { name: text('破棄して移動', 'Discard and leave'), exact: true }).click();
    await expect(page).toHaveURL(/\/cards$/);
    await page.getByRole('link', { name: text('設定', 'Settings'), exact: true }).click();
    await expect(monthly).toHaveValue('4');
    await expect(page.getByText('Unimplemented visual-test command:', { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`phrase actions dismiss and nested confirmation protects edits ${locale} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await installLearningFixture(page, locale, theme);
    await page.goto('/cards');
    const actions = page.getByLabel(text('take a little detourの操作', 'Actions for take a little detour'), { exact: true });
    const edit = page.getByRole('button', { name: text('編集', 'Edit'), exact: true });
    await actions.click();
    await expect(edit).toBeVisible();
    await page.getByLabel(text('フレーズを検索', 'Search your phrases'), { exact: true }).click();
    await expect(edit).toBeHidden();
    await actions.click();
    await page.keyboard.press('Escape');
    await expect(edit).toBeHidden();
    await expect(actions).toBeFocused();

    await actions.click();
    await edit.click();
    const editor = page.getByRole('dialog', { name: text('フレーズを編集', 'Edit phrase'), exact: true });
    const meaning = editor.getByLabel(text('意味', 'Meaning'), { exact: true });
    await meaning.fill('Edited meaning that must survive closing the confirmation');
    await page.keyboard.press('Escape');
    const confirmation = page.getByRole('dialog', { name: text('変更を保存しますか？', 'Save your changes?'), exact: true });
    await expect(page.locator('dialog[open]')).toHaveCount(2);
    const keep = confirmation.getByRole('button', { name: text('編集を続ける', 'Keep editing'), exact: true });
    await expect(keep).toBeInViewport();
    await expect(confirmation.getByRole('button', { name: text('保存して閉じる', 'Save and close'), exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('phrase-nested-confirmation.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(meaning).toHaveValue('Edited meaning that must survive closing the confirmation');
    await expect(meaning).toBeFocused();
    await editor.getByRole('button', { name: text('キャンセル', 'Cancel'), exact: true }).click();
    await confirmation.getByRole('button', { name: text('保存せずに閉じる', 'Discard changes'), exact: true }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('.phrase-meaning')).toHaveText('少し寄り道をする');
    await expect(actions).toBeFocused();

    await actions.click();
    await edit.click();
    await meaning.fill('A small detour');
    await editor.getByRole('button', { name: text('キャンセル', 'Cancel'), exact: true }).click();
    await confirmation.getByRole('button', { name: text('保存して閉じる', 'Save and close'), exact: true }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('.phrase-meaning')).toHaveText('A small detour');
    const notification = page.getByRole('button', { name: text('フレーズを更新しました。', 'Phrase updated.'), exact: true });
    await expect(page.locator('.app-notifications')).toContainText(text('フレーズを更新しました。', 'Phrase updated.'));
    expect(await page.locator('.app-notifications').evaluate(element => {
      const host = element.getBoundingClientRect();
      const content = document.querySelector('.page-content')!.getBoundingClientRect();
      return host.bottom <= content.top && host.height <= 132;
    })).toBe(true);
    await actions.click();
    await edit.click();
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('button', { name: text('フレーズを更新しました。', 'Phrase updated.'), exact: true })).toBeVisible();
    await editor.getByRole('button', { name: text('キャンセル', 'Cancel'), exact: true }).click();
    await expect(page.locator('.app-notifications')).toContainText(text('フレーズを更新しました。', 'Phrase updated.'));
    await page.screenshot({ path: testInfo.outputPath('phrase-saved-notification.png'), animations: 'disabled' });
    await notification.click();
    await expect(page.getByText('Unimplemented visual-test command:', { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
