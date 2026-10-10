// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudyRegion, useStudyPresence, useStudyRegionActive } from '../features/study/StudyPresence';

const fixture = vi.hoisted(() => ({ reducedMotion: false, completions: [] as ((definition: unknown) => void)[] }));
vi.mock('../shared/motion', () => ({
  useAppMotion: () => ({ reducedMotion: fixture.reducedMotion }),
  motionDurations: { fast: .12, enter: .18, exit: .12 }, motionEase: [.2, 0, 0, 1],
}));
vi.mock('motion/react-m', () => ({
  div: ({ animate, initial: _initial, variants: _variants, transition: _transition, onAnimationComplete, ...props }: HTMLAttributes<HTMLDivElement> & {
    animate: string; initial: unknown; variants: unknown; transition: unknown; onAnimationComplete: (definition: unknown) => void;
  }) => {
    fixture.completions.push(onAnimationComplete);
    return <div {...props} data-animation={animate} />;
  },
}));

beforeEach(() => { fixture.reducedMotion = false; fixture.completions = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Panel({ open, children }: { open: boolean; children: ReactNode }) {
  const presence = useStudyPresence(open);
  return <div data-testid="grid" className={presence.visible ? 'has-companion' : ''}>
    <button>Outside</button>
    <StudyRegion open={open}>{children}</StudyRegion>
    <button onClick={() => presence.motionProps.onAnimationComplete('hidden')}>Finish geometry exit</button>
  </div>;
}

it('deactivates an exiting panel immediately while keeping its last form and geometry until completion', () => {
  function Session() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>Close</button><Panel open={open}>
      {open && <label>Draft<input defaultValue="unfinished phrase" /></label>}
    </Panel></>;
  }
  render(<Session />);
  const field = screen.getByLabelText('Draft');
  fireEvent.change(field, { target: { value: 'edited phrase' } });
  fireEvent.click(screen.getByText('Close'));
  const region = field.closest('.study-motion-region')!;
  expect(region).toHaveAttribute('inert');
  expect(region).toHaveAttribute('aria-hidden', 'true');
  expect(region).not.toHaveAttribute('hidden');
  expect(field).toHaveValue('edited phrase');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByTestId('grid')).toHaveClass('has-companion');
  act(() => fixture.completions.at(-1)!('hidden'));
  expect(region).toHaveAttribute('hidden');
  fireEvent.click(screen.getByText('Finish geometry exit'));
  expect(screen.getByTestId('grid')).not.toHaveClass('has-companion');
});

it('ignores an obsolete exit after reopening and closing again', () => {
  const view = render(<StudyRegion open><p>Panel</p></StudyRegion>);
  view.rerender(<StudyRegion open={false}><p>Panel</p></StudyRegion>);
  const oldCompletion = fixture.completions.at(-1)!;
  view.rerender(<StudyRegion open><p>Reopened panel</p></StudyRegion>);
  view.rerender(<StudyRegion open={false}><p>Reopened panel</p></StudyRegion>);
  const region = screen.getByText('Reopened panel').parentElement!;
  act(() => oldCompletion('hidden'));
  expect(region).not.toHaveAttribute('hidden');
  act(() => fixture.completions.at(-1)!('hidden'));
  expect(region).toHaveAttribute('hidden');
});

it('keeps a hidden transcription workspace mounted and gives it current logical activity', () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Workspace({ active }: { active: boolean }) {
    useEffect(() => { mounted(); return unmounted; }, []);
    return <p>{active ? 'Active workspace' : 'Inactive workspace'}</p>;
  }
  const view = render(<StudyRegion open keepMounted freezeOnExit={false}><Workspace active /></StudyRegion>);
  view.rerender(<StudyRegion open={false} keepMounted freezeOnExit={false}><Workspace active={false} /></StudyRegion>);
  expect(screen.getByText('Inactive workspace')).toBeInTheDocument();
  act(() => fixture.completions.at(-1)!('hidden'));
  view.rerender(<StudyRegion open keepMounted freezeOnExit={false}><Workspace active /></StudyRegion>);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it('deactivates background work even when the outgoing child props are retained', () => {
  const stop = vi.fn();
  const start = vi.fn(() => stop);
  function Work() {
    const active = useStudyRegionActive();
    useEffect(() => { if (active) return start(); }, [active]);
    return <p>Retained work</p>;
  }
  const view = render(<StudyRegion open><Work /></StudyRegion>);
  view.rerender(<StudyRegion open={false}>{null}</StudyRegion>);
  expect(screen.getByText('Retained work')).toBeInTheDocument();
  expect(start).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
});

it('finishes reduced-motion exits immediately without waiting for animation callbacks', () => {
  const view = render(<StudyRegion open><p>Panel</p></StudyRegion>);
  fixture.reducedMotion = true;
  view.rerender(<StudyRegion open={false}><p>Panel</p></StudyRegion>);
  expect(screen.queryByText('Panel')).not.toBeInTheDocument();
  expect(document.querySelector('.study-motion-region')).toHaveAttribute('hidden');
});

it('releases retained geometry when a WebView never delivers animation completion', () => {
  vi.useFakeTimers();
  const view = render(<StudyRegion open><p>Panel</p></StudyRegion>);
  view.rerender(<StudyRegion open={false}><p>Panel</p></StudyRegion>);
  expect(screen.getByText('Panel')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(250));
  expect(screen.queryByText('Panel')).not.toBeInTheDocument();
  expect(document.querySelector('.study-motion-region')).toHaveAttribute('hidden');
});
