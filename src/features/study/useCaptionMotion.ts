// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useAppMotion } from '../../shared/motion';
import { animateEntrance } from '../../shared/motion/surfaces';

/** Fade only a new displayed cue; retain the live text nodes for selection. */
export function useCaptionMotion({ source, translation, cueKey, contentKey, selecting, translationOpen, enabled }: {
  source: RefObject<HTMLParagraphElement | null>;
  translation: RefObject<HTMLParagraphElement | null>;
  cueKey: string | undefined;
  contentKey: string;
  selecting: boolean;
  translationOpen: boolean;
  enabled: boolean;
}) {
  const { reducedMotion } = useAppMotion();
  const previous = useRef({ cueKey, selecting });
  const hasReadyCue = useRef(enabled && !!cueKey);
  const cleanups = useRef<(() => void)[]>([]);
  const stop = () => {
    cleanups.current.forEach(cancel => cancel());
    cleanups.current = [];
  };

  useLayoutEffect(() => {
    const changed = previous.current.cueKey !== cueKey;
    const selectionEnded = previous.current.selecting && !selecting;
    const firstReadyCue = !hasReadyCue.current;
    if (!enabled) hasReadyCue.current = false;
    else if (cueKey) hasReadyCue.current = true;
    previous.current = { cueKey, selecting };
    stop();
    if (!changed || !cueKey || !enabled || firstReadyCue || selecting || selectionEnded || reducedMotion || document.hidden) return;
    const nodes = [source.current, translationOpen ? translation.current : null]
      .filter((node): node is HTMLParagraphElement => !!node && typeof node.animate === 'function');
    const incoming = nodes.map(node => animateEntrance(node, 'caption'))
      .filter((cancel): cancel is () => void => !!cancel);
    cleanups.current = incoming;
    return () => {
      incoming.forEach(cancel => cancel());
      if (cleanups.current === incoming) cleanups.current = [];
    };
  }, [cueKey, contentKey, selecting, reducedMotion, source, translation, translationOpen, enabled]);

  return stop;
}
