// SPDX-License-Identifier: GPL-3.0-or-later
// One application-wide recovery clock. It reads small revision checkpoints, not data snapshots.
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
export function subscribeRecovery(listener: () => void) {
  listeners.add(listener);
  if (!stop) {
    const recover = () => { if (document.visibilityState !== 'hidden') listeners.forEach(callback => callback()); };
    window.addEventListener('focus', recover);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    const timer = window.setInterval(recover, 60_000);
    stop = () => {
      window.removeEventListener('focus', recover);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
      window.clearInterval(timer);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = undefined; }
  };
}
