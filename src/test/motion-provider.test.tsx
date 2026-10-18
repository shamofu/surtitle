// SPDX-License-Identifier: GPL-3.0-or-later
import { useContext } from 'react';
import { MotionConfigContext } from 'motion/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotionProvider, motionDurations, useAppMotion } from '../shared/motion';

function systemMotion(initial: boolean) {
  let reduced = initial;
  const listeners = new Set<() => void>();
  const query = {
    get matches() { return reduced; },
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_event: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback),
    addListener: (callback: () => void) => listeners.add(callback),
    removeListener: (callback: () => void) => listeners.delete(callback),
  };
  vi.stubGlobal('matchMedia', () => query);
  return (next: boolean) => act(() => { reduced = next; listeners.forEach(listener => listener()); });
}

function Probe() {
  const { reducedMotion } = useAppMotion();
  const config = useContext(MotionConfigContext);
  return <output data-testid="motion" data-reduced={String(reducedMotion)} data-duration={config.transition?.duration} data-config={config.reducedMotion} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.motion;
});

describe('application motion preferences', () => {
  it('follows operating-system changes live and disables opacity transitions as well as movement', () => {
    const changeSystem = systemMotion(false);
    render(<MotionProvider><Probe /></MotionProvider>);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-reduced', 'false');
    expect(screen.getByTestId('motion')).toHaveAttribute('data-duration', String(motionDurations.enter));
    expect(document.documentElement).toHaveAttribute('data-motion', 'full');
    changeSystem(true);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-reduced', 'true');
    expect(screen.getByTestId('motion')).toHaveAttribute('data-duration', '0');
    expect(screen.getByTestId('motion')).toHaveAttribute('data-config', 'always');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce');
    changeSystem(false);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-reduced', 'false');
    expect(document.documentElement).toHaveAttribute('data-motion', 'full');
  });

  it('keeps explicit reduction enabled until the saved preference returns to system', () => {
    const changeSystem = systemMotion(false);
    const view = render(<MotionProvider preference="reduce"><Probe /></MotionProvider>);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-duration', '0');
    changeSystem(true);
    changeSystem(false);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-reduced', 'true');
    view.rerender(<MotionProvider preference="system"><Probe /></MotionProvider>);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-reduced', 'false');
  });

  it('keeps isolated components usable without an animation provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-reduced', 'true');
  });

  it('defaults to immediate transitions when media queries are unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<MotionProvider><Probe /></MotionProvider>);
    expect(screen.getByTestId('motion')).toHaveAttribute('data-reduced', 'true');
    expect(screen.getByTestId('motion')).toHaveAttribute('data-duration', '0');
  });
});
