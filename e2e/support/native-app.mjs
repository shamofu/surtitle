// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { Key } from 'webdriverio';

export const nativeScriptTimeout = 180000;

export class NativeIpcError extends Error {
  constructor(command, reason) {
    super(`IPC ${command}: ${reason}`);
    this.name = 'NativeIpcError';
    this.command = command;
    this.reason = reason;
  }
}

// An application rejection is data, not a rejected WebDriver script. Transport
// and serialization errors deliberately escape unchanged and cannot satisfy a
// negative application assertion. Never return a top-level WebDriver `error`.
export async function invokeNative(command, args = {}, session = globalThis.browser) {
  const response = await session.execute(async (name, parameters) => {
    try {
      return { nativeIpc: 1, succeeded: true, payload: await window.__TAURI_INTERNALS__.invoke(name, parameters) };
    } catch (error) {
      return { nativeIpc: 1, succeeded: false, reason: String(error?.message ?? error) };
    }
  }, command, args);
  assert(response?.nativeIpc === 1 && typeof response.succeeded === 'boolean', `Malformed native IPC response for ${command}`);
  if (!response.succeeded) {
    assert.equal(typeof response.reason, 'string', `Malformed native rejection for ${command}`);
    throw new NativeIpcError(command, response.reason);
  }
  return response.payload;
}

export async function expectNativeRejection(operation, expected) {
  await assert.rejects(operation, error => {
    if (!(error instanceof NativeIpcError)) return false;
    if (expected instanceof RegExp) assert.match(error.reason, expected);
    else if (expected !== undefined) assert.equal(error.reason, expected);
    return true;
  });
}

export async function prepareNativeSession(session = globalThis.browser) {
  await session.setTimeout({ script: nativeScriptTimeout });
  await session.waitUntil(() => session.execute(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function'),
    { timeout: 15000, timeoutMsg: 'Native IPC did not become ready' });
  await session.$('h1').waitForDisplayed();
}

export async function restartNativeSession(session = globalThis.browser) {
  // reloadSession terminates the native application and creates a new session
  // with the same profile; its script timeout must be set again.
  await session.reloadSession();
  await prepareNativeSession(session);
}

// Shared by value replacement and navigation. Finite Motion transitions must
// finish before native clear/click; perpetual spinners do not block input.
export function nativeSurfaceSettled(node) {
  const region = node.closest('[role="dialog"], .study-companion') ?? node;
  if (region.closest('.study-companion-dock')?.dataset.moving === 'true') return false;
  for (const surface of region.querySelectorAll('details[data-motion-state], .motion-region, .study-motion-region')) {
    const transform = surface.style.transform;
    if (surface.style.height || surface.style.overflow === 'hidden' ||
      (surface.classList.contains('study-motion-region') && transform && !['none', 'translateX(0px)'].includes(transform))) return false;
  }
  return region.getAnimations({ subtree: true }).every(animation =>
    (!animation.pending && animation.playState !== 'running') || animation.effect?.getTiming().iterations === Infinity);
}

export async function waitForNativeInput(element, session = globalThis.browser) {
  await element.waitForExist();
  const target = await element;
  await session.waitUntil(() => session.execute(nativeSurfaceSettled, target),
    { timeoutMsg: 'The input surface did not finish moving' });
  await session.execute(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), target);
  await element.waitForDisplayed({ withinViewport: true });
  await element.waitForStable();
  await element.waitForClickable();
}

export async function clickNative(element, session = globalThis.browser) {
  await waitForNativeInput(element, session);
  await element.click();
}

export async function replaceNativeValue(element, value, session = globalThis.browser) {
  await clickNative(element, session);
  // Send deletion to the selected element. WebDriver clear() can miss React's
  // controlled input event, and a global Backspace can target a native HWND.
  await session.keys([Key.Control, 'a']);
  await element.addValue(Key.Backspace);
  await session.waitUntil(async () => await element.getValue() === '',
    { timeoutMsg: 'The native input did not clear through keyboard input' });
  if (value !== '') await element.addValue(String(value));
  await session.waitUntil(async () => await element.getValue() === String(value),
    { timeoutMsg: 'The native input did not retain the requested value' });
}
