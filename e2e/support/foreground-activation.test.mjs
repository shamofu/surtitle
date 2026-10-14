// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { spawnWebDriver } from './webdriver-process.mjs';

test.runIf(process.platform === 'win32' && process.env.SURTITLE_E2E_NATIVE_INPUT === '1')('activates only the owned target through the production caption fallback after a real foreground-policy denial', async () => {
  const evidence = mkdtempSync(join(tmpdir(), 'surtitle-foreground-activation-'));
  try {
    const child = spawnWebDriver('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./foreground-activation-fixture.ps1', import.meta.url)), '-EvidenceDirectory', evidence],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', launchError, timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 40000);
    const result = await new Promise(resolve => {
      child.once('error', error => { launchError = error; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    assert.equal(timedOut, false, stderr);
    assert.equal(launchError, undefined, stderr);
    assert.equal(result.code, 0, stderr || stdout);
    assert.equal(result.signal, null, stderr);
    const marker = 'SURTITLE_FOREGROUND_ACTIVATION:';
    const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
    assert.equal(lines.length, 1, stdout);
    const receipt = JSON.parse(lines[0].slice(marker.length));
    const { setup, handoff, click } = receipt;
    console.info(JSON.stringify(receipt));
    assert.equal(setup.acknowledged, true);
    assert.equal(handoff.accepted, false, 'Windows must actually reject SetForegroundWindow');
    assert.equal(handoff.attempts, 1);
    assert.equal(handoff.captionClicked, true);
    assert.equal(handoff.acknowledged, true);
    assert.equal(handoff.before.window, setup.expected.window);
    assert.equal(handoff.after.window, handoff.expected.window);
    assert.notEqual(handoff.expected.processId, setup.expected.processId);
    assert.equal(handoff.expected.integrity, 8192);
    assert.equal(handoff.expected.inJob, true);
    assert.equal(click.window, handoff.expected.window);
    assert.equal(click.processId, handoff.expected.processId);
    assert.equal(click.foregroundConfirmed, true);
    assert.equal(click.cursorConfirmed, true);
    assert.equal(click.inserted, 2);
    assert.equal(click.buttonUps, 1);
  } finally { rmSync(evidence, { recursive: true, force: true }); }
}, 45000);
