// SPDX-License-Identifier: GPL-3.0-or-later
import { listen } from '@tauri-apps/api/event';
import type { EventCallback } from '@tauri-apps/api/event';

/** Also disposes a listener whose asynchronous registration finishes after unmount. */
export function subscribeNative<T>(
  event: string,
  callback: EventCallback<T>,
  onError: (error: unknown) => void = () => {},
): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  void listen<T>(event, (payload) => {
    if (!disposed) callback(payload);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch((error) => {
      if (!disposed) onError(error);
    });
  return () => {
    disposed = true;
    stop?.();
  };
}
