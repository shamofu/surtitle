// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotificationRegion, NotificationsProvider, useNotifications } from '../app/providers/Notifications';

type Pending = { stopped: boolean; set(value: number): void; finish(): void; obsoleteFinish(): void };
const fixture = vi.hoisted(() => ({ reduced: false, host: null as HTMLElement | null, animations: [] as Pending[] }));
vi.mock('../app/providers/Surface', () => ({ useSurface: () => ({ notificationHost: fixture.host }) }));
vi.mock('../shared/motion', async original => ({
  ...await original<typeof import('../shared/motion')>(),
  useAppMotion: () => ({ reducedMotion: fixture.reduced }),
}));
vi.mock('motion', async original => ({
  ...await original<typeof import('motion')>(),
  animate: (value: { set(next: number): void }, endpoint: number, options: { onComplete?: () => void }) => {
    const pending: Pending = {
      stopped: false, set: next => value.set(next),
      finish() {
        if (pending.stopped) return;
        value.set(endpoint);
        options.onComplete?.();
      },
      obsoleteFinish: () => options.onComplete?.(),
    };
    fixture.animations.push(pending);
    return { stop: () => { pending.stopped = true; } };
  },
}));

beforeEach(() => {
  fixture.reduced = false; fixture.host = null; fixture.animations = [];
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const slots = [...document.querySelectorAll('.toast-slot')];
    const top = this.matches('.toast-slot') ? (slots.indexOf(this) - slots.length) * 48 : 0;
    return { top, y: top, x: 0, left: 0, right: 300, bottom: top + 40, width: 300, height: 40, toJSON() {} };
  });
});
afterEach(() => { cleanup(); fixture.host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

function Harness() {
  const { notify, report } = useNotifications();
  return <><NotificationRegion />
    <button onClick={() => notify('Saved first')}>Notify first</button>
    <button onClick={() => notify('Saved second')}>Notify second</button>
    <button onClick={() => void report(async () => { throw new Error('Could not close'); })}>Fail close</button>
  </>;
}
const app = () => <NotificationsProvider><Harness /></NotificationsProvider>;
const latest = () => fixture.animations.filter(animation => !animation.stopped).at(-1)!;

it('keeps the 6500 ms lifetime, disables a closing toast and ignores its obsolete entrance completion', () => {
  render(app());
  fireEvent.click(screen.getByText('Notify first'));
  const toast = screen.getByRole('button', { name: 'Saved first' });
  const entrance = latest();
  expect(toast.style.transform).toBe('translateY(12px)');
  act(() => entrance.set(.5));
  expect(toast.style.transform).toBe('translateY(6px)');
  act(() => { vi.advanceTimersByTime(6499); });
  expect(toast).toBeEnabled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(toast).toBeDisabled();
  act(() => entrance.obsoleteFinish());
  expect(toast).toBeInTheDocument();
  act(() => latest().finish());
  expect(toast).not.toBeInTheDocument();
});

it('settles entrance and reflow when the portal moves without replacing notifications or their live region', async () => {
  const view = render(app());
  await act(async () => { fireEvent.click(screen.getByText('Fail close')); });
  const toast = screen.getByRole('button', { name: 'Could not close' });
  const stack = toast.closest('.toast-stack');
  fireEvent.click(screen.getByText('Notify second'));
  const slot = toast.closest<HTMLElement>('.toast-slot')!;
  const reflow = latest();
  expect(reflow).toBeDefined();
  act(() => reflow.set(20));
  expect(slot.style.transform).toBe('translateY(20px)');
  fixture.host = document.createElement('div');
  document.body.appendChild(fixture.host);
  view.rerender(app());
  expect(fixture.host).toContainElement(toast);
  expect(toast.closest('.toast-stack')).toBe(stack);
  expect(stack).toHaveAttribute('aria-live', 'polite');
  expect(toast.style.transform).toBe('');
  expect(toast.style.opacity).toBe('');
  expect(slot.style.transform).toBe('');
  expect(fixture.animations.every(animation => animation.stopped)).toBe(true);
  act(() => { reflow.set(10); reflow.obsoleteFinish(); });
  expect(slot.style.transform).toBe('');
  const count = fixture.animations.length;
  const oldHost = fixture.host;
  fixture.host = null;
  view.rerender(app()); oldHost.remove();
  expect(screen.getByRole('button', { name: 'Could not close' })).toBe(toast);
  expect(fixture.animations).toHaveLength(count);
  fireEvent.click(toast);
  act(() => latest().finish());
  expect(toast).not.toBeInTheDocument();
});

it('settles to the latest toast state when reduction changes during an exit and never replays an entrance', () => {
  const view = render(app());
  fireEvent.click(screen.getByText('Notify first'));
  fireEvent.click(screen.getByText('Notify second'));
  const first = screen.getByRole('button', { name: 'Saved first' });
  const second = screen.getByRole('button', { name: 'Saved second' });
  fireEvent.click(first);
  const exit = latest();
  fixture.reduced = true; view.rerender(app());
  expect(first).not.toBeInTheDocument();
  expect(second).toBeEnabled();
  expect(second.style.opacity).toBe('');
  expect(second.style.transform).toBe('');
  expect(fixture.animations.every(animation => animation.stopped)).toBe(true);
  const count = fixture.animations.length;
  fixture.reduced = false; view.rerender(app());
  act(() => exit.obsoleteFinish());
  expect(screen.getByRole('button', { name: 'Saved second' })).toBe(second);
  expect(fixture.animations).toHaveLength(count);
});

for (const boundary of ['resize', 'hidden', 'host'] as const) {
  it(`settles a closing toast immediately at the ${boundary} boundary`, () => {
    const view = render(app());
    fireEvent.click(screen.getByText('Notify first'));
    const toast = screen.getByRole('button', { name: 'Saved first' });
    fireEvent.click(toast);
    const exit = latest();
    act(() => {
      if (boundary === 'resize') window.dispatchEvent(new Event('resize'));
      else if (boundary === 'hidden') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        fixture.host = document.createElement('div'); document.body.appendChild(fixture.host);
        view.rerender(app());
      }
    });
    expect(toast).not.toBeInTheDocument();
    expect(exit.stopped).toBe(true);
  });
}
