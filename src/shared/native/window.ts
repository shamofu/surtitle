// SPDX-License-Identifier: GPL-3.0-or-later
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AppSettings } from '../contracts/settings';

/** Keep system mode native, so Windows can continue following its own theme. */
export const setWindowTheme = (theme: AppSettings['theme']) =>
  getCurrentWindow().setTheme(theme === 'system' ? null : theme);

type NativeCloseObserver = {
  onStart?: () => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
};
type CloseGuard = { shouldWait: () => boolean; observer: NativeCloseObserver };
const guards = new Set<CloseGuard>();
let connection: { active: boolean; stop?: () => void } | undefined;
let nativeClosing: Promise<void> | undefined;

function reportCloseError(guard: CloseGuard, error: unknown) {
  if (!guards.has(guard)) return;
  try { guard.observer.onError(error); } catch { /* Reporting must not resume or interrupt a close attempt. */ }
}

function observeClose(guard: CloseGuard, event: 'onStart' | 'onSettled') {
  if (!guards.has(guard)) return;
  try { guard.observer[event]?.(); } catch (error) { reportCloseError(guard, error); }
}

/** One physical Tauri listener aggregates every guard before allowing destruction. */
export function subscribeWindowClose(shouldWait: () => boolean, observer: NativeCloseObserver): () => void {
  const guard = { shouldWait, observer }; guards.add(guard);
  if (!connection) {
    const own = { active: true, stop: undefined as (() => void) | undefined }; connection = own;
    const fail = (error: unknown) => {
      if (!own.active) return;
      own.active = false; if (connection === own) connection = undefined;
      guards.forEach(item => reportCloseError(item, error));
    };
    try {
      void getCurrentWindow().onCloseRequested(event => {
        // A late callback from a disposed subscription must never override a
        // newer guard. Tauri otherwise destroys after EACH listener returns.
        if (!own.active || !guards.size) { event.preventDefault(); return; }
        if (nativeClosing) { event.preventDefault(); return; }
        let blocked = !!closing;
        let failed = false;
        for (const item of [...guards]) {
          if (!guards.has(item)) continue;
          try { blocked = item.shouldWait() || blocked; }
          catch (error) { blocked = true; failed = true; reportCloseError(item, error); }
        }
        if (!blocked) return;
        event.preventDefault();
        if (failed) return;
        const observers = [...guards];
        observers.forEach(item => observeClose(item, 'onStart'));
        // Native requests and direct closes share the same task drain and destroy.
        // Participants only observe the attempt; none starts another close loop.
        const attempt = closeWindow();
        nativeClosing = attempt;
        void attempt.catch(error => observers.forEach(item => reportCloseError(item, error))).finally(() => {
          if (nativeClosing === attempt) nativeClosing = undefined;
          observers.forEach(item => observeClose(item, 'onSettled'));
        });
      }).then(stop => { if (!own.active) stop(); else own.stop = stop; }).catch(fail);
    } catch (error) { fail(error); }
  }
  return () => {
    guards.delete(guard);
    if (!guards.size && connection) {
      connection.active = false; connection.stop?.(); connection = undefined;
    }
  };
}

const closeTasks = new Set<{ run: () => Promise<void>; pending: () => boolean }>();
let closeTaskRevision = 0;
export function registerCloseTask(task: () => Promise<void>, pending: () => boolean = () => false) {
  const entry = { run: task, pending }; closeTasks.add(entry); closeTaskRevision++;
  return () => { if (closeTasks.delete(entry)) closeTaskRevision++; };
}
export const hasPendingCloseTasks = () => [...closeTasks].some(task => task.pending());
async function flushUntilStable() {
  for (;;) {
    const revision = closeTaskRevision;
    await Promise.all([...closeTasks].map(task => task.run()));
    // A faster editor can receive more input while a slower save is pending.
    // New registrations must also finish before this close attempt can proceed.
    if (revision === closeTaskRevision && !hasPendingCloseTasks()) return revision;
  }
}
export const requestWindowClose = () => getCurrentWindow().close();
let closing: Promise<void> | undefined;
export function closeWindow() {
  return closing ??= (async () => {
    for (;;) {
      const revision = await flushUntilStable();
      if (revision !== closeTaskRevision || hasPendingCloseTasks()) continue;
      await getCurrentWindow().destroy();
      return;
    }
  })().finally(() => { closing = undefined; });
}
