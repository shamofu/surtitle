// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertNativeInputDesktop } from './prepare-native-input.mjs';

const available = () => ({
  integrity: '8192', stationName: 'WinSta0', stationFlags: { flags: 1 },
  threadDesktopName: 'Default', threadDesktopIsInput: true,
  inputDesktopName: 'Default', inputDesktopError: 0,
  writeAttributesAccess: true, writeAttributesError: 0, writeAttributesMessage: null,
});

test('accepts a medium process with an interactive current input desktop and writable station', () => {
  assertNativeInputDesktop(available());
});
test('reports the exact rejected station permission before native tests start', () => {
  assert.throws(() => assertNativeInputDesktop({ ...available(), writeAttributesAccess: false,
    writeAttributesError: 5, writeAttributesMessage: 'Access is denied.' }), /WINSTA_WRITEATTRIBUTES.*Win32Error=5.*Access is denied/);
});
test('rejects noninteractive and mismatched desktops without attempting to switch them', () => {
  assert.throws(() => assertNativeInputDesktop({ ...available(), stationFlags: { flags: 0 } }), /not interactive/);
  assert.throws(() => assertNativeInputDesktop({ ...available(), threadDesktopIsInput: false }), /not receiving input/);
  assert.throws(() => assertNativeInputDesktop({ ...available(), inputDesktopName: 'Other' }), /different desktop/);
});
test('keeps unavailable diagnostic fields as failures, never assumed access', () => {
  assert.throws(() => assertNativeInputDesktop({ ...available(), stationName: { error: 5 } }), /window station/);
  assert.throws(() => assertNativeInputDesktop({ ...available(), threadDesktopIsInput: { error: 5 } }), /not receiving input/);
  assert.throws(() => assertNativeInputDesktop({ ...available(), inputDesktopError: 5, inputDesktopName: { error: 5, message: 'Access is denied.' } }), /cannot open the input desktop/);
  assert.throws(() => assertNativeInputDesktop({ ...available(), threadDesktopName: { error: 5 } }), /thread desktop/);
});
test('rejects low and elevated processes even if their desktop access probe succeeds', () => {
  for (const integrity of ['4096', '12288', 'unavailable'])
    assert.throws(() => assertNativeInputDesktop({ ...available(), integrity }), /same medium integrity/);
});
