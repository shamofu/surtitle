// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useState } from 'react';
import { useAppMotion } from '../shared/motion';

const mainPages = ['/', '/cards', '/review', '/settings'];
type Direction = 'none' | 'forward' | 'backward';

function pageDirection(from: string | undefined, to: string): Direction {
  const previous = mainPages.indexOf(from ?? '');
  const next = mainPages.indexOf(to);
  return previous < 0 || next < 0 || previous === next ? 'none' : next > previous ? 'forward' : 'backward';
}

export function supportsPageTransitions() {
  // The router's types callback is ignored without typed transitions. The
  // active handle is also needed to skip a capture before its animation exists.
  return typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function'
    && 'activeViewTransition' in document
    && window.CSS?.supports?.('selector(:active-view-transition-type(a))') === true;
}

export function pageTransitionTypes(from: string | undefined, to: string): string[] | false {
  const direction = pageDirection(from, to);
  if (direction === 'none' || document.documentElement.dataset.motion !== 'full' || document.hidden) return false;
  return [`main-${direction}`];
}

export function finishPageTransition() {
  const transition = document.activeViewTransition;
  if (transition?.types.has('main-forward') || transition?.types.has('main-backward')) {
    void transition.ready.catch(() => {});
    transition.skipTransition();
  }
}

export function usePageMotion(pathname: string) {
  const { reducedMotion } = useAppMotion();
  const [navigation, setNavigation] = useState({ pathname, direction: 'none' as Direction });
  let direction = navigation.direction;
  if (navigation.pathname !== pathname) {
    direction = pageDirection(navigation.pathname, pathname);
    setNavigation({ pathname, direction });
  }
  useLayoutEffect(() => {
    if (reducedMotion) finishPageTransition();
  }, [reducedMotion]);
  useLayoutEffect(() => {
    window.addEventListener('resize', finishPageTransition);
    document.addEventListener('visibilitychange', finishPageTransition);
    return () => {
      window.removeEventListener('resize', finishPageTransition);
      document.removeEventListener('visibilitychange', finishPageTransition);
      finishPageTransition();
    };
  }, []);
  const transition = direction === 'none' || reducedMotion ? 'none' : supportsPageTransitions() ? 'view' : 'fallback';
  return { direction, transition };
}
