// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { assertNativeInputDesktop } from './prepare-native-input.mjs';

const available = () => ({
  integrity: '8192', stationName: 'WinSta0', stationFlags: { flags: 1 },
  threadDesktopName: 'Default', threadDesktopIsInput: true,
  inputDesktopName: 'Default', inputDesktopError: 0,
  stationHandleAccess: { ntStatus: '0x00000000', returnedSize: 56, grantedAccess: 0xf037f, grantedAccessHex: '0x000F037F' },
  writeAttributesAccess: true, writeAttributesError: 0, writeAttributesMessage: null,
});

test('accepts a medium process with an interactive current input desktop and writable station', () => {
  assertNativeInputDesktop(available());
});
test('reports the exact rejected station permission before native tests start', () => {
  assert.throws(() => assertNativeInputDesktop({ ...available(), writeAttributesAccess: false,
    writeAttributesError: 5, writeAttributesMessage: 'Access is denied.' }), /WINSTA_WRITEATTRIBUTES.*Win32Error=5.*Access is denied/);
});

test('requires WRITEATTRIBUTES on the existing station handle even when a fresh open succeeds', () => {
  assert.throws(() => assertNativeInputDesktop({ ...available(), stationHandleAccess: {
    ntStatus: '0x00000000', returnedSize: 56, grantedAccess: 0xf036f, grantedAccessHex: '0x000F036F',
  } }), /existing window station handle lacks WINSTA_WRITEATTRIBUTES.*0x000F036F/);
});

test('never assumes existing station rights after a missing, failed or malformed native query', () => {
  for (const stationHandleAccess of [undefined, null,
    { ntStatus: '0xC0000008', returnedSize: 56, grantedAccess: null },
    { ntStatus: '0x00000000', returnedSize: 4, grantedAccess: 0x10 },
    { ntStatus: '0x00000000', returnedSize: 56, grantedAccess: null },
    { ntStatus: '0x00000000', returnedSize: 56, grantedAccess: '0x10' },
    { ntStatus: '0x00000000', returnedSize: 56, grantedAccess: -1 },
    { ntStatus: '0x00000000', returnedSize: 56, grantedAccess: 0x100000010 },
  ]) assert.throws(() => assertNativeInputDesktop({ ...available(), stationHandleAccess }), /could not query its existing window station handle access/);
});

test.runIf(process.platform === 'win32')('reads actual borrowed and freshly opened native handle rights without input or desktop changes', () => {
  const snapshot = JSON.parse(execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./native-video-click.ps1', import.meta.url)), '-InspectInputDesktop'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  }));
  for (const query of [snapshot.stationHandleAccess, snapshot.desktopHandleAccess, snapshot.freshWriteAttributesHandleAccess]) {
    assert.equal(query.ntStatus, '0x00000000');
    assert.equal(query.returnedSize, 56);
    assert(Number.isInteger(query.grantedAccess));
  }
  assert.notEqual(snapshot.stationHandleAccess.grantedAccess & 0x10, 0);
  assert.equal(snapshot.freshWriteAttributesHandleAccess.grantedAccess, 0x10);
}, 30000);

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
