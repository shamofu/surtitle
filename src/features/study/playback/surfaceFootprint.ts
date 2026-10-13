// SPDX-License-Identifier: GPL-3.0-or-later
import type { PlayerControlRequest, PlayerSurfaceRect } from '../../../shared/contracts/player';

// Physical client pixels, not CSS pixels: a pending placement can belong to the
// previous monitor scale while the WebView has already adopted its new scale.
let footprint: readonly PlayerSurfaceRect[] = [];
const listeners = new Set<() => void>();

export function nativeSurfaceFootprint(request: PlayerControlRequest | undefined): PlayerSurfaceRect[] {
  if (request?.action !== 'bounds' || !request.bounds) return [];
  const bounds = request.bounds;
  const scale = bounds.scaleFactor;
  const round = (value: number) => value < 0 ? -Math.round(-value) : Math.round(value);
  const left = round(bounds.x * scale), top = round(bounds.y * scale);
  const right = left + Math.round(bounds.width * scale), bottom = top + Math.round(bounds.height * scale);
  const x = bounds.clip ? Math.max(left, Math.ceil(bounds.clip.x * scale)) : left;
  const y = bounds.clip ? Math.max(top, Math.ceil(bounds.clip.y * scale)) : top;
  const endX = bounds.clip ? Math.min(right, Math.floor((bounds.clip.x + bounds.clip.width) * scale)) : right;
  const endY = bounds.clip ? Math.min(bottom, Math.floor((bounds.clip.y + bounds.clip.height) * scale)) : bottom;
  return endX > x && endY > y ? [{ x, y, width: endX - x, height: endY - y }] : [];
}

export function publishSurfaceFootprint(rectangles: readonly PlayerSurfaceRect[]) {
  footprint = rectangles;
  for (const listener of listeners) listener();
}

export function subscribeSurfaceFootprint(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Protect every pixel that the shared HWND may paint before its next response. */
export function nativeDockInset(dock: PlayerSurfaceRect, scale: number) {
  let right = dock.x;
  for (const rect of footprint) {
    const x = rect.x / scale, y = rect.y / scale;
    const endX = (rect.x + rect.width) / scale, endY = (rect.y + rect.height) / scale;
    if (x < dock.x + dock.width && endX > dock.x && y < dock.y + dock.height && endY > dock.y) right = Math.max(right, endX);
  }
  return Math.min(dock.width, Math.max(0, right - dock.x));
}
