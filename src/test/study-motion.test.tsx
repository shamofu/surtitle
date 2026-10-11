// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudyRegion, useStudyPresence, useStudyRegionActive } from '../features/study/StudyPresence';

const fixture = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('../shared/motion', async importOriginal => ({
  ...await importOriginal<typeof import('../shared/motion')>(),
  useAppMotion: () => ({ reducedMotion: fixture.reducedMotion }),
}));
beforeEach(() => { fixture.reducedMotion = false; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function Panel({ open, children }: { open: boolean; children: ReactNode }) {
  const presence = useStudyPresence(open);
  return <div data-testid="dock" {...presence.dockProps}>
    <StudyRegion open={open} retain={presence.visible} animate={!presence.moving}>{children}</StudyRegion>
  </div>;
}

it('deactivates a closing drawer while retaining its last form until geometry finishes', () => {
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
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'true');
  const transition = new Event('transitionend', { bubbles: true });
  Object.defineProperty(transition, 'propertyName', { value: 'width' });
  fireEvent(screen.getByTestId('dock'), transition);
  expect(region).toHaveAttribute('hidden');
});

it('reverses toward the latest target without an obsolete timeout closing it', () => {
  vi.useFakeTimers();
  const view = render(<Panel open><p>Panel</p></Panel>);
  view.rerender(<Panel open={false}><p>Panel</p></Panel>);
  act(() => vi.advanceTimersByTime(150));
  view.rerender(<Panel open><p>Panel</p></Panel>);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByTestId('dock')).toHaveAttribute('data-open', 'true');
  expect(screen.getByText('Panel').parentElement).not.toHaveAttribute('hidden');
  act(() => vi.advanceTimersByTime(120));
  expect(screen.getByTestId('dock')).toHaveAttribute('data-moving', 'false');
});

it('keeps a hidden transcription workspace mounted and logically inactive', () => {
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
  expect(screen.getByText('Inactive workspace').parentElement).toHaveAttribute('hidden');
  expect(stop).toHaveBeenCalledTimes(1);
  view.rerender(<StudyRegion open keepMounted freezeOnExit={false}><Workspace /></StudyRegion>);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it('switches tab content without retaining an outgoing view', () => {
  const view = render(<StudyRegion open><p>Old tab</p></StudyRegion>);
  view.rerender(<StudyRegion open={false}><p>Old tab</p></StudyRegion>);
  expect(screen.queryByText('Old tab')).not.toBeInTheDocument();
  expect(document.querySelector('.study-motion-region')).toHaveAttribute('hidden');
});

it.each(['reduce', 'hidden', 'resize', 'timeout'])('settles a closing drawer on %s', reason => {
  vi.useFakeTimers();
  const view = render(<Panel open><p>Panel</p></Panel>);
  view.rerender(<Panel open={false}><p>Panel</p></Panel>);
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
