// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { nativeDockInset, nativeSurfaceFootprint, publishSurfaceFootprint, subscribeSurfaceFootprint } from '../features/study/playback/surfaceFootprint';

afterEach(() => publishSurfaceFootprint([]));

it('protects the HWND physical extent and page clip across a monitor scale change', () => {
  const rectangles = nativeSurfaceFootprint({ action: 'bounds', bounds: {
    x: 10.2, y: -5.1, width: 100.4, height: 80.3, scaleFactor: 1.25,
    clip: { x: 10.2, y: 0, width: 100.4, height: 75.2 },
  } });
  expect(rectangles).toEqual([{ x: 13, y: 0, width: 125, height: 94 }]);
  publishSurfaceFootprint(rectangles);
  expect(nativeDockInset({ x: 60, y: 0, width: 100, height: 100 }, 2)).toBe(9);
  expect(nativeDockInset({ x: 60, y: 50, width: 100, height: 100 }, 2)).toBe(0);
  expect(nativeSurfaceFootprint({ action: 'hide' })).toEqual([]);
});

it('clips only the part of a dock that either confirmed or in-flight video can paint', () => {
  const dock = { x: 300, y: 20, width: 180, height: 400 };
  publishSurfaceFootprint([{ x: 0, y: 20, width: 420, height: 200 }, { x: 0, y: 20, width: 320, height: 200 }]);
  expect(nativeDockInset(dock, 1)).toBe(120);
  publishSurfaceFootprint([{ x: 0, y: 20, width: 320, height: 200 }]);
  expect(nativeDockInset(dock, 1)).toBe(20);
  publishSurfaceFootprint([{ x: 0, y: 20, width: 600, height: 200 }]);
  expect(nativeDockInset(dock, 1)).toBe(180);
  publishSurfaceFootprint([{ x: 500, y: 20, width: 100, height: 200 }]);
  expect(nativeDockInset(dock, 1)).toBe(0);
});

it('notifies synchronously before native dispatch and releases subscriptions', () => {
  const listener = vi.fn();
  const stop = subscribeSurfaceFootprint(listener);
  publishSurfaceFootprint([]);
  expect(listener).toHaveBeenCalledOnce();
  stop();
  publishSurfaceFootprint([]);
  expect(listener).toHaveBeenCalledOnce();
});
