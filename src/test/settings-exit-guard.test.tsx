// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useNavigate } from '@tanstack/react-router';
import { useSettingsExitGuard } from '../features/settings/useSettingsExitGuard';

const fixture = vi.hoisted(() => ({
  save: vi.fn<() => Promise<boolean>>(),
  close: vi.fn<() => Promise<void>>(),
  onClose: undefined as undefined | (() => boolean),
  notify: vi.fn(),
  holdExit: false,
}));
vi.mock('../app/runtime', () => ({
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
  useNotifications: () => ({ notify: fixture.notify }),
}));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/window', () => ({
  subscribeWindowClose: (callback: () => boolean) => { fixture.onClose = callback; return () => { fixture.onClose = undefined; }; },
  closeWindow: () => fixture.close(),
}));

function SettingsHarness() {
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const success = await fixture.save();
      if (success) setDirty(false);
      return success;
    } finally { setSaving(false); }
  }
  const guard = useSettingsExitGuard(dirty, saving, save);
  useLayoutEffect(() => {
    if (guard.open && !guard.modalProps.open && !fixture.holdExit) guard.modalProps.onExited();
  }, [guard.open, guard.modalProps.open, guard.modalProps.onExited]);
  return <>
    <h1>Settings</h1>
    <p>{dirty ? 'Unsaved draft' : 'Saved draft'}</p>
    <button onClick={() => setDirty(true)}>Edit</button>
    <button onClick={() => void navigate({ to: '/' })}>Go to library</button>
    <button onClick={() => void navigate({ to: '/settings', hash: 'tools' })}>Tools section</button>
    <button onClick={() => void save()}>Save normally</button>
    <button onClick={async () => { if (await save()) { guard.allowSavedNavigation(); void navigate({ to: '/' }); } }}>Save and return</button>
    {guard.open && <section role="dialog" aria-label="Unsaved settings">
      {!guard.modalProps.open && <button onClick={guard.modalProps.onExited}>Finish exit animation</button>}
      {guard.error && <p role="alert">{guard.error}</p>}
      <button disabled={guard.busy} onClick={guard.keepEditing}>Keep editing</button>
      <button disabled={guard.busy} onClick={() => void guard.saveAndLeave()}>Save and leave</button>
      <button disabled={guard.busy} onClick={() => void guard.discardAndLeave()}>Discard and leave</button>
    </section>}
  </>;
}

async function mount(browserHistory = false) {
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsHarness });
  const library = createRoute({ getParentRoute: () => root, path: '/', component: () => <h1>Library</h1> });
  if (browserHistory) window.history.replaceState({}, '', '/settings');
  const history = browserHistory ? createBrowserHistory() : createMemoryHistory({ initialEntries: ['/settings'] });
  const router = createRouter({ routeTree: root.addChildren([settings, library]), history });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'Settings' });
  return router;
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  fixture.save.mockResolvedValue(true);
  fixture.close.mockResolvedValue(undefined);
  fixture.holdExit = false;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('settings exit protection', () => {
  it('waits for dialog exit before navigation and prevents repeated actions during exit', async () => {
    fixture.holdExit = true;
    const router = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(router.state.location.pathname).toBe('/settings');
    expect(screen.getByRole('button', { name: 'Discard and leave' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish exit animation' }));
    await screen.findByRole('heading', { name: 'Library' });
  });

  it('allows clean navigation and clean native closure', async () => {
    await mount();
    expect(fixture.onClose?.()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
    await screen.findByRole('heading', { name: 'Library' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps edits after cancelled navigation, ignores section anchors, and discards only on request', async () => {
    const router = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tools section' }));
    await waitFor(() => expect(router.state.location.hash).toBe('tools'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Unsaved draft')).toBeVisible();
    expect(router.state.location.pathname).toBe('/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    await screen.findByRole('heading', { name: 'Library' });
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('stays on the draft after save failure and leaves after a successful retry', async () => {
    fixture.save.mockResolvedValueOnce(false);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be saved');
    expect(screen.getByText('Unsaved draft')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save and leave' }));
    await screen.findByRole('heading', { name: 'Library' });
    expect(fixture.save).toHaveBeenCalledTimes(2);
  });

  it('does not interrupt a save or issue duplicate saves while leaving', async () => {
    let resolve!: (success: boolean) => void;
    fixture.save.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save normally' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Discard and leave' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save and leave' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDisabled();
    expect(fixture.onClose?.()).toBe(true);
    await act(async () => { resolve(true); });
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeEnabled();
    expect(fixture.save).toHaveBeenCalledOnce();
  });

  it('retains the draft if native discard fails and closes only after retry', async () => {
    fixture.close.mockRejectedValueOnce(new Error('Window could not close'));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    act(() => { expect(fixture.onClose?.()).toBe(true); });
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Window could not close');
    expect(screen.getByText('Unsaved draft')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    await waitFor(() => expect(fixture.close).toHaveBeenCalledTimes(2));
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('saves before native close and does not close after failed saving', async () => {
    fixture.save.mockResolvedValueOnce(false);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    act(() => { fixture.onClose?.(); });
    fireEvent.click(screen.getByRole('button', { name: 'Save and leave' }));
    await screen.findByRole('alert');
    expect(fixture.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  });

  it('protects browser unloading while dirty and removes protection after saving', async () => {
    const router = await mount(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save normally' }));
    await screen.findByText('Saved draft');
    await waitFor(() => {
      const cleanUnload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(cleanUnload);
      expect(cleanUnload.defaultPrevented).toBe(false);
    });
    router.history.destroy();
  });

  it('keeps the existing save-and-return flow free of a second confirmation', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and return' }));
    await screen.findByRole('heading', { name: 'Library' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fixture.save).toHaveBeenCalledOnce();
  });
});
