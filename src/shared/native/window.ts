// SPDX-License-Identifier: GPL-3.0-or-later
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Return true to keep the window open. Late registrations are also disposed. */
export function subscribeWindowClose(
  shouldPrevent: () => boolean,
  onError: (error: unknown) => void,
): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  try {
    void getCurrentWindow().onCloseRequested(event => {
      // Tauri destroys the window independently after each listener returns.
      // An old registration must not override a newer listener's prevention.
      if (disposed || shouldPrevent()) event.preventDefault();
    }).then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(error => { if (!disposed) onError(error); });
  } catch (error) {
    onError(error);
  }
  return () => { disposed = true; stop?.(); };
}

export const closeWindow = () => getCurrentWindow().destroy();
