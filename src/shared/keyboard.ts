// SPDX-License-Identifier: GPL-3.0-or-later
/** Let focused controls, IME and browser shortcuts handle their own keys. */
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return true;
  const target = event.target instanceof Element ? event.target : null;
  return !!target?.closest('input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="tab"], [role="menuitem"], [role="slider"], [role="combobox"]');
}
