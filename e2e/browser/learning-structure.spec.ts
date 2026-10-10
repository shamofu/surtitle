// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installLearningFixture } from './learning-fixture';
import { drop, importFixture, importPaths } from './import-fixture';

const sentence = 'Sometimes the best way to find your way is to take a little detour.';
const translation = '少し寄り道をすることが、自分の道を見つける一番の方法になることもある。';

// These replace the ten former image baselines. Assert user-facing structure and
// relative geometry, without depending on font rasterization or exact pixels.
test.use({ viewport: { width: 1024, height: 700 }, reducedMotion: 'reduce' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
});

async function expectNoOverflow(page: Page, ...containers: Locator[]) {
  await expect(page.getByText('Unimplemented visual-test command:', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const container of containers) {
    expect(await container.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
}

async function expectSeparate(first: Locator, second: Locator) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.x + a!.width <= b!.x + 1 || b!.x + b!.width <= a!.x + 1
    || a!.y + a!.height <= b!.y + 1 || b!.y + b!.height <= a!.y + 1).toBe(true);
}

async function expectReachable(control: Locator) {
  await expect(control).toBeEnabled();
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}

async function expectFooterActions(footer: Locator, count: number) {
  const buttons = footer.getByRole('button');
  await expect(buttons).toHaveCount(count);
  for (let index = 0; index < count; index += 1) {
    await expectReachable(buttons.nth(index));
    for (let previous = 0; previous < index; previous += 1) {
      await expectSeparate(buttons.nth(previous), buttons.nth(index));
    }
  }
}

for (const [locale, theme] of [['ja', 'light'], ['en', 'dark']] as const) {
  const t = (ja: string, en: string) => locale === 'ja' ? ja : en;
  const inspect = t('この言葉を確認', 'Inspect this phrase');
  const captionName = t('いまの字幕', 'Current subtitle');
  const label = `${locale} ${theme} 1024x700`;

  async function openStudy(page: Page) {
    await installLearningFixture(page, locale, theme);
    await page.goto('/study/visual-fixture');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: 'A walk along the coast', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: inspect, exact: true })).toBeEnabled();
  }

  test(`study structure ${label}`, async ({ page }) => {
    await openStudy(page);
    const caption = page.getByRole('region', { name: captionName, exact: true });
    await expect(caption).toMatchAriaSnapshot(`
      - region "${captionName}":
        - paragraph: ${sentence}
        - button "${t('訳を表示', 'Show translation')}"
        - button "${inspect}"
        - group "${t('字幕の再生操作', 'Subtitle playback')}":
          - button "${t('前の字幕', 'Previous subtitle')}"
          - button "${t('もう一度聴く', 'Listen again')}"
          - button "${t('次の字幕', 'Next subtitle')}"
    `);
    await expect(caption.locator('.current-caption-text')).toHaveAttribute('lang', 'en');
    await expect(caption.getByRole('button', { name: t('訳を表示', 'Show translation'), exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: t('字幕一覧', 'Transcript'), exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByLabel(t('字幕を検索', 'Search transcript'))).toBeHidden();
    await expectReachable(caption.getByRole('button', { name: inspect, exact: true }));
    await expectReachable(page.getByRole('button', { name: t('再生', 'Play'), exact: true }));
    const video = page.getByTestId('native-player-viewport');
    const controls = page.locator('.player-control-row');
    await expect(video).toBeInViewport({ ratio: 1 });
    await expectSeparate(video, controls);
    await expectSeparate(controls, caption);
    await expectNoOverflow(page, page.locator('.study-left'), caption);
  });

  test(`phrase save structure ${label}`, async ({ page }) => {
    await openStudy(page);
    await page.getByRole('button', { name: inspect, exact: true }).click();
    const panel = page.locator('.phrase-panel');
    await expect(panel.getByRole('heading', { name: t('言葉を確認', 'Inspect phrase'), exact: true })).toBeVisible();
    await expect(panel.locator('.context-sentence')).toHaveText(sentence);
    await panel.getByRole('button', { name: t('意味を見る', 'Show meaning'), exact: true }).click();
    await expect(panel.getByRole('button', { name: t('意味を閉じる', 'Hide meaning'), exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('.context-translation')).toHaveText(translation);
    await panel.getByRole('button', { name: t('フレーズを保存', 'Save a phrase'), exact: true }).click();
    const form = panel.locator('.save-phrase-form');
    const term = form.getByRole('textbox', { name: t('語彙・フレーズ', 'Word or phrase'), exact: true });
    const meaning = form.getByRole('textbox', { name: t('意味', 'Meaning'), exact: true });
    await term.fill('take a little detour');
    await meaning.fill('少し寄り道をする');
    await expect(term).toHaveValue('take a little detour');
    await expect(meaning).toHaveValue('少し寄り道をする');
    await expect(form.getByRole('textbox', { name: t('元の文脈', 'Original context'), exact: true })).toHaveValue(sentence);
    await expect(form.getByRole('textbox', { name: t('解説・メモ（任意）', 'Explanation or notes (optional)'), exact: true })).toBeEditable();
    await expect(form.getByRole('status')).toHaveText(t('入力は自動保存されます。', 'Your input is saved automatically.'));
    const footer = form.locator('footer');
    await expect(footer).toMatchAriaSnapshot(`
      - button "${t('入力を破棄', 'Discard draft')}"
      - button "${t('あとで続ける', 'Continue later')}"
      - button "${t('フレーズを保存', 'Save phrase')}"
    `);
    await footer.scrollIntoViewIfNeeded();
    await expectFooterActions(footer, 3);
    await expectSeparate(page.getByTestId('native-player-viewport'), panel);
    await expectSeparate(panel.locator('.context-meaning'), form);
    await expectNoOverflow(page, panel, form);
  });

  test(`partial import failure structure ${label}`, async ({ page }) => {
    await importFixture(page, locale, theme);
    await drop(page, [...importPaths, importPaths[0]]);
    const dialog = page.getByRole('dialog', { name: t('作品を追加', 'Add a video or audio file'), exact: true });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const selection = dialog.getByRole('region', { name: t('選択したファイル', 'Selected files'), exact: true });
    await expect(selection.getByRole('list').getByRole('listitem')).toHaveCount(3);
    await dialog.getByRole('button', { name: t('2 件をライブラリに追加', 'Add 2 files to library'), exact: true }).click();
    const imported = selection.locator('.import-file-row.imported');
    const failed = selection.locator('.import-file-row.failed');
    const invalid = selection.locator('.import-file-row.invalid');
    await expect(imported).toHaveCount(1);
    await expect(failed).toHaveCount(1);
    await expect(invalid).toHaveCount(1);
    await expect(selection.getByRole('listitem')).toHaveCount(3);
    await expect(imported.locator('strong')).toHaveText('字幕付きの会話練習ファイル.mp4');
    await expect(imported.getByRole('link', { name: t('字幕付きの会話練習ファイル.mp4 を開く', 'Open 字幕付きの会話練習ファイル.mp4'), exact: true })).toHaveAttribute('href', '/study/imported-1');
    await expect(failed).toContainText(/Could not read lesson-2\.mp4\. Try again\./);
    await expect(invalid).toContainText(t('対応していない形式です。動画・音声ファイルを選んでください。', 'Unsupported format. Choose a supported video or audio file.'));
    await expect(dialog.locator('.import-results')).toHaveRole('status');
    await expect(dialog.locator('.import-results')).toHaveText(t('追加 1 件・追加済み 0 件・失敗 1 件・対象外 1 件', '1 added · 0 already in library · 1 failed · 1 unsupported or unavailable'));
    const footer = dialog.locator('.import-footer');
    await expect(footer).toMatchAriaSnapshot(`
      - button "${t('ライブラリに戻る', 'Return to library')}"
      - button "${t('失敗したファイルだけ再試行', 'Retry failed files')}"
    `);
    await expectFooterActions(footer, 2);
    await expectSeparate(dialog.locator('.import-body'), footer);
    const rows = selection.getByRole('listitem');
    for (let index = 0; index < await rows.count(); index += 1) {
      await expectSeparate(rows.nth(index).locator('.import-file-copy'), rows.nth(index).locator('.import-file-actions'));
    }
    await expectNoOverflow(page, dialog, selection);
  });

  test(`transcription tab structure ${label}`, async ({ page }) => {
    await openStudy(page);
    await page.getByRole('button', { name: t('字幕一覧', 'Transcript'), exact: true }).click();
    const tabs = page.getByRole('tablist', { name: t('字幕の表示内容', 'Transcript content'), exact: true });
    const tab = tabs.getByRole('tab', { name: t('文字起こし', 'Transcription'), exact: true });
    await tab.click();
    await expect(tabs).toMatchAriaSnapshot(`
      - tablist "${t('字幕の表示内容', 'Transcript content')}":
        - tab "${t('字幕', 'Transcript')}"
        - tab "${t('文字起こし', 'Transcription')}" [selected]
        - tab "${t('AI の提案', 'Suggestions')}"
    `);
    await expect(tabs.getByRole('tab', { selected: false })).toHaveCount(2);
    const content = page.getByRole('tabpanel', { name: t('文字起こし', 'Transcription'), exact: true });
    await expect(content).toHaveAttribute('id', (await tab.getAttribute('aria-controls'))!);
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    const workspace = content.getByRole('region', { name: t('文字起こし', 'Transcription'), exact: true });
    await expect(workspace.getByRole('heading', { name: t('文字起こし', 'Transcription'), level: 3 })).toBeVisible();
    await expect(workspace).toContainText(t('音声から字幕を作成できます。範囲と見積もりを確認してから開始します。', 'Create subtitles from the audio. Review the range and estimate before starting.'));
    await expectReachable(workspace.getByRole('button', { name: t('文字起こしを作り直す', 'Transcribe again'), exact: true }));
    const history = workspace.locator('details').filter({ has: page.locator('summary', { hasText: t('文字起こしの履歴', 'Transcription history') }) });
    await expect(history).not.toHaveAttribute('open');
    await expect(history.locator('summary')).toBeInViewport({ ratio: 1 });
    await expect(history.getByRole('button', { name: t('以前の下書きを開く', 'Open earlier drafts'), exact: true })).toBeHidden();
    await expectSeparate(tabs, content);
    await expectSeparate(page.getByTestId('native-player-viewport'), page.locator('.study-companion'));
    await expectNoOverflow(page, page.locator('.study-companion'), workspace);
  });

  test(`phrase edit confirmation structure ${label}`, async ({ page }) => {
    await installLearningFixture(page, locale, theme);
    await page.goto('/cards');
    await page.getByLabel(t('take a little detourの操作', 'Actions for take a little detour'), { exact: true }).click();
    await page.getByRole('button', { name: t('編集', 'Edit'), exact: true }).click();
    const editor = page.getByRole('dialog', { name: t('フレーズを編集', 'Edit phrase'), exact: true });
    const editedMeaning = '少し寄り道をする — take a short detour';
    await editor.getByRole('textbox', { name: t('意味', 'Meaning'), exact: true }).fill(editedMeaning);
    await page.keyboard.press('Escape');
    const title = t('変更を保存しますか？', 'Save your changes?');
    const confirmation = page.getByRole('dialog', { name: title, exact: true });
    await expect(page.locator('dialog[open]')).toHaveCount(2);
    await expect(confirmation).toMatchAriaSnapshot(`
      - dialog "${title}":
        - banner:
          - heading "${title}" [level=2]
          - button "${t('閉じる', 'Close')}"
        - paragraph: ${t('このフレーズには未保存の変更があります。', 'This phrase has unsaved changes.')}
        - contentinfo:
          - button "${t('編集を続ける', 'Keep editing')}"
          - button "${t('保存せずに閉じる', 'Discard changes')}"
          - button "${t('保存して閉じる', 'Save and close')}"
    `);
    expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await expectFooterActions(confirmation.locator('footer'), 3);
    await expectSeparate(confirmation.locator('.modal-header'), confirmation.locator('.modal-body'));
    await expectNoOverflow(page, confirmation);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // The top confirmation must own dismissal and preserve the editor beneath it.
    await confirmation.getByRole('button', { name: t('編集を続ける', 'Keep editing'), exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(editor.getByRole('textbox', { name: t('意味', 'Meaning'), exact: true })).toHaveValue(editedMeaning);
  });
}
