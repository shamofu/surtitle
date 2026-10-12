// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('permits the native close retry after autosave and the saved theme without broader window access', () => {
  const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  expect(capability.windows).toEqual(['main']);
  expect(capability.permissions).toEqual(expect.arrayContaining([
    'core:event:allow-listen', 'core:event:allow-unlisten',
    'core:window:allow-close', 'core:window:allow-destroy', 'core:window:allow-set-theme',
  ]));
  expect(capability.permissions).not.toContain('core:default');
  expect(capability.permissions).not.toContain('core:window:default');
});
