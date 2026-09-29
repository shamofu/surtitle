// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'react';

import './draft-study.css';

export type Range = { startMs: number; endMs: number };

export type PlayRange = (range: Range) => Promise<void> | void;

export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
