// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { invokeNative as invoke, prepareNativeSession, restartNativeSession, replaceNativeValue, clickNative } from '../support/native-app.mjs';
import { readFeeLedger } from '../support/native-e2e-ledger.mjs';

const directory = resolve(process.env.SURTITLE_E2E_DATA_DIR);
const fixture = JSON.parse(readFileSync(resolve(directory, 'fixture.json'), 'utf8'));
const snapshot = () => invoke('get_app_snapshot');
const provider = () => $('//label[contains(., "AI provider")]/select');
const budgetProvider = () => $('//label[contains(., "Budget provider")]/select');
const monthly = () => $('//label[contains(., "Monthly AI budget")]/div/input');
const password = () => $('input[type="password"]');
let original, ledgerBefore, verified = false;

async function openSettings() {
  await browser.execute(() => { history.pushState({}, '', '/settings'); dispatchEvent(new PopStateEvent('popstate')); });
  await clickNative($('#settings-nav-ai'));
  await provider().waitForEnabled();
}
async function chooseProvider(value) {
  await provider().selectByAttribute('value', value);
  await browser.keys(Key.Tab);
  await browser.waitUntil(async () => (await snapshot()).settings.activeProvider === value);
}
async function saveMonthly(value, selected) {
  await replaceNativeValue(monthly(), String(value));
  await browser.keys(Key.Tab);
  await browser.waitUntil(async () => {
    const settings = (await snapshot()).settings;
    return (selected === 'openai' ? settings.openai : settings).monthlyBudgetUsd === value;
  }, { timeoutMsg: `${selected} monthly budget was not saved` });
}

describe('provider settings in the actual desktop', () => {
  before(async () => {
    await prepareNativeSession();
    original = (await snapshot()).settings;
    assert.equal(original.credentialConfigured, false, 'Refusing a profile with Vertex credentials');
    assert.equal(original.openai.credentialConfigured, false, 'Refusing a profile with OpenAI credentials');
    assert((await snapshot()).media.some(media => media.path === fixture.mediaPath), 'Expected the exact disposable fixture');
    ledgerBefore = readFeeLedger(directory);
    verified = true;
    await invoke('update_settings', { settings: { ...original, locale: 'en' } });
    await browser.refresh();
    await openSettings();
  });
  after(async () => {
    if (!verified) return;
    await invoke('remove_openai_api_key');
    await invoke('update_settings', { settings: original });
    for (const selected of ['vertex', 'openai']) {
      const state = await invoke('get_settings_state');
      const profile = selected === 'openai' ? original.openai : original;
      await invoke('update_settings_patch', { expectedRevision: state.revision, patch: { budgets: {
        provider: selected, dailyBudgetUsd: profile.dailyBudgetUsd,
        monthlyBudgetUsd: profile.monthlyBudgetUsd ?? profile.dailyBudgetUsd,
        perJobBudgetUsd: profile.perJobBudgetUsd ?? profile.dailyBudgetUsd,
      } } });
    }
    const after = readFeeLedger(directory);
    for (const table of ['ai_jobs', 'ai_requests', 'ai_attempts']) assert.deepEqual(after[table], ledgerBefore[table], 'Settings actions must not approve or dispatch AI requests');
    assert.equal((await snapshot()).settings.openai.credentialConfigured, false);
  });
  it('retains both budgets and securely saves and removes only the disposable test key', async () => {
    await chooseProvider('vertex'); await saveMonthly(5, 'vertex');
    await budgetProvider().selectByAttribute('value', 'openai');
    await saveMonthly(8, 'openai');
    assert.equal((await snapshot()).settings.activeProvider, 'vertex');
    assert.deepEqual((await snapshot()).settings.aiModels, original.aiModels);
    await chooseProvider('openai');
    await replaceNativeValue(password(), 'sk-provider-switch-offline-fixture-key');
    await clickNative($('button=Save API key'));
    await expect(password()).toHaveValue('');
    await browser.waitUntil(async () => (await snapshot()).settings.openai.credentialConfigured);
    // Verify the post-key revision remains usable for further settings edits.
    await saveMonthly(9, 'openai');
    await chooseProvider('vertex'); await budgetProvider().selectByAttribute('value', 'vertex'); await expect(monthly()).toHaveValue('5');
    await chooseProvider('openai'); await budgetProvider().selectByAttribute('value', 'openai'); await expect(monthly()).toHaveValue('9');
    await restartNativeSession(); await openSettings();
    await expect(provider()).toHaveValue('openai'); await expect(monthly()).toHaveValue('9');
    await expect(password()).toHaveValue('');
    const state = await snapshot();
    assert.equal(state.settings.openai.credentialConfigured, true);
    assert.equal(state.budgets.vertex.limitUsd, 5); assert.equal(state.budgets.openai.limitUsd, 9);
    for (const budget of Object.values(state.budgets)) { assert.equal(budget.spentUsd, 0); assert.equal(budget.reservedUsd, 0); }
    await clickNative($('button=Remove API key'));
    await browser.waitUntil(async () => !(await snapshot()).settings.openai.credentialConfigured);
  });
});
