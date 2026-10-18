// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'vitest';
import { readFrontendScript } from './frontend-bundle.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(basename(directory).startsWith('surtitle-frontend-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
function buildFixture(html, asset = true) {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-frontend-'));
  directories.push(directory);
  mkdirSync(join(directory, 'assets'));
  if (asset) writeFileSync(join(directory, 'assets', 'index-current.js'), 'export {};');
  const index = join(directory, 'index.html');
  writeFileSync(index, html);
  return index;
}

test('extracts the emitted module independently of attribute ordering', () => {
  for (const html of [
    '<script type="module" crossorigin src="/assets/index-current.js"></script>',
    "<script src='/assets/index-current.js' crossorigin type='module'></script>",
  ]) assert.equal(readFrontendScript(buildFixture(html)), '/assets/index-current.js');
});

test('rejects missing, ambiguous and absent-on-disk entry points', () => {
  const module = '<script type="module" src="/assets/index-current.js"></script>';
  assert.throws(() => readFrontendScript(buildFixture('<script src="/legacy.js"></script>')), /exactly one/);
  assert.throws(() => readFrontendScript(buildFixture(module + module)), /exactly one/);
  assert.throws(() => readFrontendScript(buildFixture(module, false)), /entry is missing/);
  assert.throws(() => readFrontendScript(buildFixture('<script type="module" src="https://example.com/app.js"></script>')), /local JavaScript/);
});
