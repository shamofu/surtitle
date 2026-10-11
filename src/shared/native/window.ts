// SPDX-License-Identifier: GPL-3.0-or-later
import { getCurrentWindow } from '@tauri-apps/api/window';

type CloseGuard = { prevent: () => boolean; error: (error: unknown) => void };
const guards = new Set<CloseGuard>();
let connection: { active: boolean; stop?: () => void } | undefined;

/** One physical Tauri listener aggregates every guard before allowing destruction. */
export function subscribeWindowClose(shouldPrevent: () => boolean, onError: (error: unknown) => void): () => void {
  const guard = { prevent: shouldPrevent, error: onError }; guards.add(guard);
  if (!connection) {
    const own = { active: true, stop: undefined as (() => void) | undefined }; connection = own;
    const fail = (error: unknown) => {
      if (!own.active) return;
      own.active = false; if (connection === own) connection = undefined;
      guards.forEach(item => item.error(error));
    };
    try {
      void getCurrentWindow().onCloseRequested(event => {
        // A late callback from a disposed subscription must never override a
        // newer guard. Tauri otherwise destroys after EACH listener returns.
        if (!own.active || !guards.size) { event.preventDefault(); return; }
        let blocked = false;
        for (const item of [...guards]) {
          if (!guards.has(item)) continue;
          try { blocked = item.prevent() || blocked; }
          catch (error) { blocked = true; item.error(error); }
        }
        if (blocked) event.preventDefault();
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
export async function flushCloseTasks() { await flushUntilStable(); }
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
