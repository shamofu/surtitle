// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudyRegion, useStudyPresence, useStudyRegionActive } from '../features/study/StudyPresence';
import { motionDurations } from '../shared/motion';

type PendingMotion = { duration: number; frames?: Record<string, string[]>; stopped: boolean; set(value: number): void; complete(): void; obsoleteComplete(): void };
const fixture = vi.hoisted(() => ({ reducedMotion: false, animations: [] as PendingMotion[] }));
vi.mock('../shared/motion', async importOriginal => ({
  ...await importOriginal<typeof import('../shared/motion')>(),
  useAppMotion: () => ({ reducedMotion: fixture.reducedMotion }),
}));
vi.mock('motion', async importOriginal => ({
  ...await importOriginal<typeof import('motion')>(),
  animate: (target: HTMLElement | { set(value: number): void }, endpoint: number | Record<string, string[]>, options: { duration: number; onComplete?: () => void }) => {
    const pending: PendingMotion = {
      duration: options.duration, frames: typeof endpoint === 'number' ? undefined : endpoint, stopped: false,
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
  vi.stubGlobal('innerWidth', 1200);
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const latest = () => fixture.animations.filter(animation => animation.duration > 0).at(-1)!;

function Panel({ open, children }: { open: boolean; children: ReactNode }) {
  const presence = useStudyPresence(open);
  return <div data-testid="dock" className="study-companion-dock" data-ready={presence.ready} {...presence.dockProps}>
    <div className="study-transcript-rail"><button>Transcript toggle</button></div>
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
  expect(latest().duration).toBe(.24);
  act(() => latest().complete());
  expect(screen.getByTestId('dock')).toHaveStyle({ width: '364px' });
  expect(latest().duration).toBe(.24);
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

it('keeps the closing endpoint invisible before React commits its hidden state', () => {
  const view = render(<Panel open><p>Panel</p></Panel>);
  view.rerender(<Panel open={false}><p>Panel</p></Panel>);
  act(() => latest().complete());
  const panel = document.querySelector('aside')!;
  act(() => {
    latest().complete();
    expect(panel.style.visibility).toBe('hidden');
    expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'true');
  });
  expect(panel).toHaveAttribute('hidden');
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
});

it('resizes the desktop dock with the rail anchored before revealing the panel', () => {
  const view = render(<Panel open={false}><input aria-label="Draft" /></Panel>);
  const dock = screen.getByTestId('dock');
  const panel = document.querySelector('aside')!;
  const rail = document.querySelector<HTMLElement>('.study-transcript-rail')!;
  view.rerender(<Panel open><input aria-label="Draft" /></Panel>);
  expect(dock).toHaveStyle({ width: '44px' });
  expect(panel).toHaveStyle({ visibility: 'hidden' });
  expect(latest().duration).toBe(.30);
  act(() => latest().set(.5));
  expect(dock).toHaveStyle({ width: '204px' });
  expect(rail).toHaveStyle({ transform: 'translateX(160px)' });
  expect(panel).toHaveStyle({ visibility: 'hidden', transform: 'translateX(100%)' });
  act(() => latest().complete());
  expect(dock).toHaveStyle({ width: '364px' });
  expect(panel).toHaveStyle({ visibility: 'visible' });
  expect(latest().duration).toBe(.24);
  act(() => latest().set(.5));
  expect(dock).toHaveStyle({ width: '364px' });
  expect(rail).toHaveStyle({ transform: 'translateX(160px)' });
  act(() => latest().complete());
  expect(rail).toHaveStyle({ transform: 'translateX(0px)' });
  expect(dock).toHaveAttribute('data-moving', 'false');
});

it('reverses a partially resized dock without exposing its hidden panel', () => {
  const view = render(<Panel open={false}><input aria-label="Draft" /></Panel>);
  view.rerender(<Panel open><input aria-label="Draft" /></Panel>);
  const opening = latest();
  act(() => opening.set(.4));
  view.rerender(<Panel open={false}><input aria-label="Draft" /></Panel>);
  expect(opening.stopped).toBe(true);
  expect(screen.getByTestId('dock')).toHaveStyle({ width: '172px' });
  expect(latest().duration).toBeCloseTo(.24 * .4);
  expect(document.querySelector('aside')).toHaveStyle({ visibility: 'hidden' });
  act(() => opening.obsoleteComplete());
  act(() => latest().complete());
  expect(screen.getByTestId('dock')).toHaveStyle({ width: '44px' });
  expect(document.querySelector('aside')).toHaveAttribute('hidden');
});

it.each(['resize', 'reduce'])('preserves the native endpoint gate through %s', async reason => {
  const content = (open: boolean) => <div className="study-grid">
    <div className="native-player-viewport" data-native-placement="ready" />
    <Panel open={open}><input aria-label="Draft" /></Panel>
  </div>;
  const view = render(content(false));
  const viewport = document.querySelector<HTMLElement>('.native-player-viewport')!;
  const pending = (event: Event) => {
    if (event instanceof CustomEvent && event.detail?.immediate) viewport.dataset.nativePlacement = 'pending';
  };
  window.addEventListener('surtitle-player-layout', pending);
  try {
    view.rerender(content(true));
    act(() => latest().complete());
    expect(screen.getByTestId('dock')).toHaveAttribute('data-ready', 'false');
    expect(document.querySelector('aside')).toHaveStyle({ visibility: 'hidden' });
    act(() => vi.advanceTimersByTime(1000));
    expect(document.querySelector('aside')).toHaveStyle({ visibility: 'hidden' });
    if (reason === 'resize') fireEvent.resize(window);
    else { fixture.reducedMotion = true; view.rerender(content(true)); }
    expect(document.querySelector('aside')).toHaveStyle({ visibility: 'hidden' });
    expect(screen.getByTestId('dock')).toHaveAttribute('data-ready', 'false');
    await act(async () => { viewport.dataset.nativePlacement = 'ready'; });
    expect(document.querySelector('aside')).toHaveStyle({ visibility: 'visible' });
    expect(screen.getByTestId('dock')).toHaveAttribute('data-ready', 'true');
    expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
  } finally { window.removeEventListener('surtitle-player-layout', pending); }
});

it('reopens during the closing resize from the current width before revealing', () => {
  const view = render(<Panel open><input aria-label="Draft" /></Panel>);
  view.rerender(<Panel open={false}><input aria-label="Draft" /></Panel>);
  act(() => latest().complete());
  const shrinking = latest();
  act(() => shrinking.set(.6));
  view.rerender(<Panel open><input aria-label="Draft" /></Panel>);
  expect(shrinking.stopped).toBe(true);
  expect(screen.getByTestId('dock')).toHaveStyle({ width: '236px' });
  expect(latest().duration).toBeCloseTo(.30 * .4);
  expect(document.querySelector('aside')).toHaveStyle({ visibility: 'hidden' });
  act(() => shrinking.obsoleteComplete());
  act(() => latest().complete());
  expect(latest().duration).toBe(.24);
  act(() => latest().complete());
  expect(screen.getByTestId('dock')).toHaveStyle({ width: '364px' });
  expect(document.querySelector('aside')).not.toHaveAttribute('hidden');
});

it('preserves the stacked slide without changing player layout width', () => {
  vi.stubGlobal('innerWidth', 920);
  const view = render(<Panel open={false}><input aria-label="Draft" /></Panel>);
  screen.getByTestId('dock').scrollIntoView = vi.fn();
  view.rerender(<Panel open><input aria-label="Draft" /></Panel>);
  expect(screen.getByTestId('dock').style.width).toBe('');
  expect(latest().duration).toBe(.40);
  act(() => latest().set(.5));
  expect(document.querySelector('aside')).toHaveStyle({ transform: 'translateY(50%)' });
  act(() => latest().complete());
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
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
  expect(latest().duration).toBe(.36);
  expect(latest().frames?.opacity).toEqual([1, 1]);
  expect(latest().frames?.transform.at(-1)).toBe('translateX(-32px)');
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
  else act(() => vi.advanceTimersByTime((motionDurations.studySlideOut + motionDurations.studyCollapse) * 1000 + 201));
  expect(document.querySelector('.study-motion-region')).toHaveAttribute('hidden');
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
});
