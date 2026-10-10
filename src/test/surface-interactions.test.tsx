// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { SurfaceProvider, useSurface } from '../app/providers/Surface';
import { NotificationRegion, NotificationsProvider, useNotifications } from '../app/providers/Notifications';
import { Field, Modal } from '../shared/ui';
import { LanguageInput } from '../shared/ui/LanguageInput';
import { CircleDollarSign } from 'lucide-react';

vi.mock('../app/runtime', async () => ({
  useSurface: (await import('../app/providers/Surface')).useSurface,
  useAppearance: () => ({ t: (_ja: string, en: string) => en, locale: 'en' }),
}));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(cleanup);

function Harness() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const [locked, setLocked] = useState(false);
  const { surfaceHidden } = useSurface();
  const { report } = useNotifications();
  return <>
    <NotificationRegion />
    <output>{surfaceHidden ? 'Video hidden' : 'Video visible'}</output>
    <button onClick={() => setOuter(true)}>Open editor</button>
    {outer && <Modal title="Editor" onClose={() => setOuter(false)} closeDisabled={locked}>
      <button onClick={() => setInner(true)}>Open confirmation</button>
      <button onClick={() => void report(async () => { throw new Error('Save failed'); })}>Fail save</button>
      <label><input type="checkbox" checked={locked} onChange={event => setLocked(event.target.checked)} />Lock editor</label>
      {inner && <Modal title="Confirmation" onClose={() => setInner(false)}><p>Confirm the changes</p></Modal>}
    </Modal>}
  </>;
}
function app() {
  return render(<SurfaceProvider><NotificationsProvider><Harness /></NotificationsProvider></SurfaceProvider>);
}

it('cancels only the nested modal and keeps the native surface hidden until the last closes', () => {
  app();
  fireEvent.click(screen.getByText('Open editor'));
  fireEvent.click(screen.getByText('Open confirmation'));
  const inner = screen.getByRole('dialog', { name: 'Confirmation' });
  fireEvent(inner, new Event('cancel', { bubbles: false, cancelable: true }));
  expect(screen.queryByRole('dialog', { name: 'Confirmation' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Editor' })).toBeVisible();
  expect(screen.getByText('Video hidden')).toBeVisible();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(screen.getByText('Video visible')).toBeVisible();
});

it('routes one notification to the frontmost dialog and back across modal transitions', async () => {
  app();
  fireEvent.click(screen.getByText('Open editor'));
  await act(async () => { fireEvent.click(screen.getByText('Fail save')); });
  expect(within(screen.getByRole('dialog', { name: 'Editor' })).getByText('Save failed')).toBeVisible();
  fireEvent.click(screen.getByText('Open confirmation'));
  const inner = screen.getByRole('dialog', { name: 'Confirmation' });
  expect(within(inner).getByText('Save failed')).toBeVisible();
  expect(screen.getAllByText('Save failed')).toHaveLength(1);
  fireEvent.click(within(inner).getByRole('button', { name: 'Close' }));
  expect(within(screen.getByRole('dialog', { name: 'Editor' })).getByText('Save failed')).toBeVisible();
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Editor' })).getByRole('button', { name: 'Close' }));
  expect(document.querySelector('.app-notifications')).toContainElement(screen.getByText('Save failed'));
  expect(screen.getAllByText('Save failed')).toHaveLength(1);
  fireEvent.click(screen.getByText('Save failed'));
  expect(screen.queryByText('Save failed')).not.toBeInTheDocument();
});

it('locks all modal dismissal routes while busy', () => {
  app();
  fireEvent.click(screen.getByText('Open editor'));
  fireEvent.click(screen.getByLabelText('Lock editor'));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  fireEvent.click(dialog);
  expect(dialog).toBeVisible();
  fireEvent.click(screen.getByLabelText('Lock editor'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('associates hints and errors with wrapped and custom inputs without polluting their names', () => {
  const view = render(<><Field label="Budget" hint="Per month" error="Enter a valid budget"><div><CircleDollarSign /><input /></div></Field>
    <Field label="Language" error="Choose a language"><LanguageInput value="" onChange={() => {}} /></Field></>);
  const input = screen.getByRole('textbox', { name: 'Budget' });
  expect(screen.getByLabelText('Budget')).toBe(input);
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription('Per month Enter a valid budget');
  expect(screen.getByRole('combobox', { name: 'Language' })).toHaveAccessibleDescription('Choose a language');
  view.rerender(<Field label="Budget" hint="Per month"><div><input /></div></Field>);
  expect(screen.getByRole('textbox', { name: 'Budget' })).not.toHaveAttribute('aria-invalid');
});
