// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { subscribeNative } from '../../shared/native/events';
import { nativeAvailable } from '../../shared/native/transport';

/** A single native listener group, scoped to the mounted library page. */
export function useLibraryDrop({
  blocked,
  canDrop,
  onDrop,
  onError,
}: {
  blocked: boolean;
  canDrop: () => boolean;
  onDrop: (paths: string[]) => void;
  onError: (error: unknown) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const current = useRef({ blocked, canDrop, onDrop, onError });
  current.current = { blocked, canDrop, onDrop, onError };
  useEffect(() => {
    if (!nativeAvailable()) return;
    const allowed = () => !current.current.blocked && current.current.canDrop();
    const enter = () => setDragging(allowed());
    const leave = () => setDragging(false);
    const fail = (error: unknown) => current.current.onError(error);
    const stops = [
      subscribeNative('tauri://drag-enter', enter, fail),
      subscribeNative('tauri://drag-over', enter, fail),
      subscribeNative('tauri://drag-leave', leave, fail),
      subscribeNative<{ paths: string[] }>('tauri://drag-drop', ({ payload }) => {
        leave();
        if (allowed() && payload.paths?.length) current.current.onDrop(payload.paths);
      }, fail),
    ];
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', leave);
    return () => {
      stops.forEach(stop => stop());
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', leave);
    };
  }, []);
  useEffect(() => {
    if (blocked) setDragging(false);
  }, [blocked]);
  return dragging && !blocked;
}
