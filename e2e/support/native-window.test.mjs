// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { validateNativeSize } from './native-window.mjs';

test('rejects malformed native resize requests before window operations', () => {
  validateNativeSize(1024, 700);
  validateNativeSize(8192, 8192);
  for (const size of [[1023,700],[1024,699],[Infinity,900],[1440.5,900],[8193,900]]) {
    assert.throws(() => validateNativeSize(...size), /Invalid native client/);
  }
});
