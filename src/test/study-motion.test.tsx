// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudyRegion, useStudyPresence, useStudyRegionActive } from '../features/study/StudyPresence';

type PendingMotion = { duration: number; stopped: boolean; set(value: number): void; complete(): void; obsoleteComplete(): void };
const fixture = vi.hoisted(() => ({ reducedMotion: false, animations: [] as PendingMotion[] }));
vi.mock('../shared/motion', async importOriginal => ({
  ...await importOriginal<typeof import('../shared/motion')>(),
  useAppMotion: () => ({ reducedMotion: fixture.reducedMotion }),
}));
vi.mock('motion', async importOriginal => ({
  ...await importOriginal<typeof import('motion')>(),
  animate: (target: HTMLElement | { set(value: number): void }, endpoint: number | Record<string, string[]>, options: { duration: number; onComplete?: () => void }) => {
    const pending: PendingMotion = {
      duration: options.duration, stopped: false,
      set(value) { if ('set' in target) target.set(value); },
      complete() {
        if (pending.stopped) return;
        if (typeof endpoint === 'number') pending.set(endpoint);
        else if (target instanceof HTMLElement) for (const [key, values] of Object.entries(endpoint)) target.style.setProperty(key, String(values.at(-1)));
        options.onComplete?.();
      },
      obsoleteComplete() { options.onComplete?.(); },
    };
    fixture.animations.push(pending);
    return { complete: pending.complete, stop: () => { pending.stopped = true; } };
  },
}));
beforeEach(() => {
  fixture.reducedMotion = false;
  fixture.animations = [];
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const latest = () => fixture.animations.filter(animation => animation.duration > 0).at(-1)!;

function Panel({ open, children }: { open: boolean; children: ReactNode }) {
  const presence = useStudyPresence(open);
  return <div data-testid="dock" {...presence.dockProps}>
    <aside ref={presence.panelRef} hidden={!presence.visible} inert={!open}>
      <StudyRegion open={open} retain={presence.visible} animate={!presence.moving}>{children}</StudyRegion>
    </aside>
  </div>;
}

it('deactivates a closing drawer immediately but retains its draft until the slide finishes', () => {
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
  const region = document.querySelector('.study-motion-region')!;
  expect(region).toHaveAttribute('inert');
  expect(region).toHaveAttribute('aria-hidden', 'true');
  expect(region).not.toHaveAttribute('hidden');
  expect(field).toHaveValue('edited phrase');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'true');
  expect(latest().duration).toBe(.18);
  act(() => latest().complete());
  expect(region).toHaveAttribute('hidden');
  expect(field).not.toBeInTheDocument();
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
});

it('reverses from the visible position and ignores the obsolete completion', () => {
  const view = render(<Panel open><input aria-label="Draft" defaultValue="日本語" /></Panel>);
  const input = screen.getByLabelText('Draft');
  view.rerender(<Panel open={false}><input aria-label="Draft" defaultValue="日本語" /></Panel>);
  const closing = latest();
  act(() => closing.set(.4));
  const panel = document.querySelector('aside')!;
  const before = panel.style.transform;
  view.rerender(<Panel open><input aria-label="Draft" defaultValue="日本語" /></Panel>);
  expect(panel.style.transform).toBe(before);
  expect(closing.stopped).toBe(true);
  expect(latest().duration).toBeCloseTo(.24 * .4);
  act(() => closing.obsoleteComplete());
  expect(screen.getByTestId('dock')).toHaveAttribute('data-open', 'true');
  act(() => latest().complete());
  expect(panel.style.transform).toBe('translateX(0%)');
  expect(screen.getByLabelText('Draft')).toBe(input);
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
  act(() => vi.advanceTimersByTime(1000));
  expect(panel).not.toHaveAttribute('hidden');
});

it('keeps a transcription workspace mounted and deactivates it during its exit', () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  const stop = vi.fn();
  function Workspace() {
    const active = useStudyRegionActive();
    useEffect(() => { mounted(); return unmounted; }, []);
    useEffect(() => { if (active) return stop; }, [active]);
    return <p>{active ? 'Active workspace' : 'Inactive workspace'}</p>;
  }
  const view = render(<StudyRegion open keepMounted freezeOnExit={false}><Workspace /></StudyRegion>);
  view.rerender(<StudyRegion open={false} keepMounted freezeOnExit={false}><Workspace /></StudyRegion>);
  const region = screen.getByText('Inactive workspace').parentElement!;
  expect(region).toHaveAttribute('inert');
  expect(region).not.toHaveAttribute('hidden');
  expect(stop).toHaveBeenCalledTimes(1);
  act(() => latest().complete());
  expect(region).toHaveAttribute('hidden');
  view.rerender(<StudyRegion open keepMounted freezeOnExit={false}><Workspace /></StudyRegion>);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it('retains the outgoing tab inert for the overlap, then releases its content', () => {
  const view = render(<StudyRegion open><button>Old tab</button></StudyRegion>);
  view.rerender(<StudyRegion open={false}><button>Old tab</button></StudyRegion>);
  const region = document.querySelector('.study-motion-region')!;
  expect(screen.getByText('Old tab')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(region).toHaveAttribute('data-motion-state', 'exiting');
  expect(region).toHaveAttribute('inert');
  act(() => latest().complete());
  expect(screen.queryByText('Old tab')).not.toBeInTheDocument();
  expect(region).toHaveAttribute('hidden');
});

it.each(['reduce', 'hidden', 'resize', 'timeout'])('settles a closing drawer on %s', reason => {
  const view = render(<Panel open><p>Panel</p></Panel>);
  view.rerender(<Panel open={false}><p>Panel</p></Panel>);
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'true');
  if (reason === 'reduce') {
    fixture.reducedMotion = true;
    view.rerender(<Panel open={false}><p>Panel</p></Panel>);
  } else if (reason === 'hidden') {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
  } else if (reason === 'resize') fireEvent(window, new Event('resize'));
  else act(() => vi.advanceTimersByTime(320));
  expect(document.querySelector('.study-motion-region')).toHaveAttribute('hidden');
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
});
