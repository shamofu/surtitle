// SPDX-License-Identifier: GPL-3.0-or-later
// Real local WebView2 DOM / native command smoke, not the production app's IPC.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const output = resolve(process.argv[2]);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9444', { timeout: 15000 });
try {
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = pages.find(asyncPage => asyncPage.url() === 'about:blank') ?? pages[0];
  assert(page, 'The isolated WebView2 did not expose a page');
  assert.equal(await page.title(), 'GPU composition fixture');
  const check = async (id, paused) => {
    await page.locator(`#${id}`).click({ timeout: 5000 });
    await page.waitForFunction(({id, paused}) => window.receipts?.some(receipt => receipt.action === id && receipt.paused === paused), {id, paused}, { timeout: 5000 });
  };
  await check('play', 'no');
  await check('select', 'yes');
  await check('meaning', 'yes');
  await page.getByLabel('Japanese input').fill('繰り返して学ぶ');
  await check('save', 'yes');
  assert.equal(JSON.parse(await readFile(resolve(output, 'saved-phrase.json'), 'utf8')).meaning, '繰り返して学ぶ');
  await check('resume', 'no');
  assert.equal(await page.locator('#meaning-panel').isVisible(), false);
  const state = () => page.evaluate(() => new Promise(resolve => {
    const handler = event => { if (event.data.action === 'state') { chrome.webview.removeEventListener('message', handler); resolve(event.data); } };
    chrome.webview.addEventListener('message', handler); chrome.webview.postMessage({action:'state'});
  }));
  const first = await state(); await new Promise(resolve => setTimeout(resolve, 1200)); const later = await state();
  assert(later.position > first.position + 0.8, 'Native playback did not advance after resuming');
  const hostPath = resolve('work/rendering-evaluation/composition-host/target/debug/surtitle-composition-evaluation.exe');
  const resizeScript = "Add-Type -Path e2e/support/native-window.cs; $owned=@(Get-Process -Name surtitle-composition-evaluation | Where-Object {$_.Path -eq $env:SURTITLE_COMPOSITION_HOST}); if($owned.Count -ne 1){throw 'Expected exactly one owned host'}; [SurtitleNativeWindow]::ResizeClient($owned[0].MainWindowHandle,1024,700)";
  execFileSync('pwsh.exe', ['-NoProfile','-NonInteractive','-Command',resizeScript], {timeout:10000,windowsHide:true,env:{...process.env,SURTITLE_COMPOSITION_HOST:hostPath}});
  await page.waitForFunction(() => innerWidth === 1024 && innerHeight === 700, undefined, { timeout: 5000 });
  await page.screenshot({ path: resolve(output, 'webview-ui-only.png'), omitBackground: true });
  const receipts = await page.evaluate(() => window.receipts);
  await writeFile(resolve(output, 'workflow.json'), JSON.stringify({passed:true, receipts, resumedPositions:[first.position,later.position], resizedClient:[1024,700], unicodeInput:true, realOsIme:false, transport:'CDP input into real WebView2; native WebMessage/mpv/file roundtrip', screenshotScope:'WebView visual only; excludes native video visual', productionApp:false}, null, 2)+'\n');
  console.log(JSON.stringify({passed:true, receipts}));
} finally { await browser.close(); }
