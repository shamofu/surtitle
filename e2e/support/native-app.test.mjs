// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { invokeNative, NativeIpcError, expectNativeRejection, restartNativeSession, nativeScriptTimeout, clickNative, replaceNativeValue } from './native-app.mjs';
import { Key } from 'webdriverio';

afterEach(() => vi.unstubAllGlobals());
const localSession = () => ({ execute: (fn, ...args) => fn(...args) });

test('IPC preserves successful payloads, including application data named error', async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async () => ({ error: 'domain field', value: 42 }) } });
  assert.deepEqual(await invokeNative('snapshot', {}, localSession()), { error: 'domain field', value: 42 });
});

test('IPC serializes native rejections and identifies their command independently of transport errors', async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async () => { throw 'Confirm replacement'; } } });
  await expectNativeRejection(invokeNative('replace', {}, localSession()), 'Confirm replacement');
  await assert.rejects(invokeNative('replace', {}, localSession()), error => error instanceof NativeIpcError && error.command === 'replace');
  const transport = new Error('WebDriver disconnected');
  const session = { execute: async () => { throw transport; } };
  await assert.rejects(invokeNative('replace', {}, session), error => error === transport);
  await assert.rejects(expectNativeRejection(invokeNative('replace', {}, session), /replacement/));
});

test('a negative assertion fails on success, malformed protocol data, or the wrong application reason', async () => {
  await assert.rejects(expectNativeRejection(Promise.resolve(), /replacement/));
  await assert.rejects(invokeNative('replace', {}, { execute: async () => ({ succeeded: false }) }), /Malformed native IPC/);
  await assert.rejects(expectNativeRejection(Promise.reject(new NativeIpcError('replace', 'Wrong input')), /replacement/));
});

test('a native restart restores the long IPC timeout before waiting on the new application', async () => {
  const events = [];
  const session = {
    reloadSession: async () => events.push('restart'),
    setTimeout: async value => events.push(value),
    waitUntil: async predicate => { events.push('wait-ipc'); assert.equal(await predicate(), true); },
    execute: async () => true,
    $: selector => ({ waitForDisplayed: async () => events.push(selector) }),
  };
  await restartNativeSession(session);
  assert.deepEqual(events, ['restart', { script: nativeScriptTimeout }, 'wait-ipc', 'h1']);
});

test('native input waits for stable geometry and replaces controlled text using element key events', async () => {
  let stable = false, clicked = false, selected = false, value = 'old controlled text';
  const element = {
    waitForExist: async () => {}, waitForDisplayed: async () => {},
    waitForStable: async () => { stable = true; }, waitForClickable: async () => {},
    click: async () => { assert(stable); clicked = true; },
    addValue: async key => {
      assert(clicked);
      if (key === Key.Backspace) { assert(selected); value = ''; }
      else value += key;
    },
    getValue: async () => value,
  };
  const session = { execute: async () => true,
    waitUntil: async predicate => assert(await predicate()),
    keys: async keys => { assert.deepEqual(keys, [Key.Control, 'a']); selected = true; },
  };
  await replaceNativeValue(element, '日本語 replacement', session);
  assert.equal(value, '日本語 replacement');
});

test('native click does not act when its surface never becomes ready', async () => {
  const blocked = new Error('surface still moving');
  let clicked = false;
  const element = { waitForExist: async () => {}, click: async () => { clicked = true; } };
  await assert.rejects(clickNative(element, { waitUntil: async () => { throw blocked; } }), error => error === blocked);
  assert.equal(clicked, false);
});
