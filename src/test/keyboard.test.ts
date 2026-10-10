// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { shouldIgnoreShortcut } from '../shared/keyboard';

afterEach(() => { document.body.replaceChildren(); });
it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }])('leaves modified or composing keys alone: %j', options => {
  expect(shouldIgnoreShortcut(new KeyboardEvent('keydown', { code: 'Space', ...options }))).toBe(true);
});
it('ignores already handled events and accepts ordinary keys', () => {
  const event = new KeyboardEvent('keydown', { code: 'Space', cancelable: true });
  expect(shouldIgnoreShortcut(event)).toBe(false);
  event.preventDefault();
  expect(shouldIgnoreShortcut(event)).toBe(true);
});
it.each(['button', 'a href="#"', 'summary', 'div contenteditable="true"', 'div role="tab"', 'div role="combobox"'])('keeps events from control descendants local: %s', tag => {
  document.body.innerHTML = `<${tag}><span>Control</span></${tag.split(' ')[0]}>`;
  const child = document.querySelector('span')!;
  let ignored = false;
  child.addEventListener('keydown', event => { ignored = shouldIgnoreShortcut(event as KeyboardEvent); });
  child.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  expect(ignored).toBe(true);
});
