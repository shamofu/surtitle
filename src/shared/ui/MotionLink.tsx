// SPDX-License-Identifier: GPL-3.0-or-later
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { createLink } from '@tanstack/react-router';
import { m, type HTMLMotionProps } from 'motion/react';
import { motionDurations, motionEase, motionScales, useMotionActive } from '../motion';

const PressAnchor = forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<'a'>>(function PressAnchor(props, ref) {
  const active = useMotionActive();
  const enabled = active && props['aria-disabled'] !== true && props['aria-disabled'] !== 'true';
  return <m.a {...props as HTMLMotionProps<'a'>} ref={ref} initial={false} animate={{ scale: 1 }}
    whileTap={enabled ? { scale: motionScales.press, transition: { duration: motionDurations.press, ease: motionEase } } : undefined}
    transition={{ duration: active ? motionDurations.release : 0, ease: motionEase }} />;
});

/** Router links styled as actions retain link semantics and the shared press response. */
export const MotionLink = createLink(PressAnchor);
