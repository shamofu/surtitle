// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useMemo, useRef, useState } from 'react';
import type { SubtitleSegment } from '../../../shared/contracts/media';

export function captionInterval(boundaries: number[], positionMs: number) {
  let lo = 0, hi = boundaries.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (boundaries[mid] <= positionMs) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Playback clocks update the player; study UI only updates at a subtitle boundary. */
export function useCaptionPosition(segments: SubtitleSegment[], initialPositionMs: number) {
  const boundaries = useMemo(() => [...new Set(segments.flatMap(segment => [segment.startMs, segment.endMs]))].sort((a, b) => a - b), [segments]);
  const position = useRef(initialPositionMs);
  const observed = useRef({ boundaries, interval: captionInterval(boundaries, initialPositionMs) });
  const [, render] = useState(0);
  const update = useCallback((value: number) => {
    position.current = value;
    const interval = captionInterval(boundaries, value);
    if (observed.current.boundaries !== boundaries || observed.current.interval !== interval) {
      observed.current = { boundaries, interval };
      render(revision => revision + 1);
    }
  }, [boundaries]);
  return [position.current, update] as const;
}
