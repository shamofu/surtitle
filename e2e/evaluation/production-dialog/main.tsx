// SPDX-License-Identifier: GPL-3.0-or-later
// Test route: imports the actual production components, with no duplicate modal implementation.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProviders } from '../../../src/app/providers';
import { NotificationRegion, useNotifications } from '../../../src/app/providers/Notifications';
import { useSurface } from '../../../src/app/providers/Surface';
import { Modal, Button, Field } from '../../../src/shared/ui';
import '../../../src/styles.css';

function Validation() {
  const [open, setOpen] = useState(false), [nested, setNested] = useState(false), [locked, setLocked] = useState(false);
  const { notify } = useNotifications();
  const { surfaceHidden, occludingElements } = useSurface();
  return <main style={{ padding: 32 }}>
    <h1>Production dialog validation</h1>
    <NotificationRegion />
    <output data-testid="surfaces">{occludingElements.length}</output>
    <output data-testid="blocked">{String(surfaceHidden)}</output>
    <Button onClick={() => setOpen(true)}>Open editor</Button>
    <Button id="outside">Outside action</Button>
    {open && <Modal title="Phrase editor" closeDisabled={locked} onClose={() => setOpen(false)}>
      <Field label="Phrase"><input autoFocus defaultValue="Take a little detour" /></Field>
      <Field label="Meaning"><textarea defaultValue="少し寄り道をする" /></Field>
      <label><input type="checkbox" checked={locked} onChange={event => setLocked(event.target.checked)} />Lock dismissal</label>
      <div className="modal-footer">
        <Button onClick={() => notify('Draft retained')}>Notify</Button>
        <Button onClick={() => setNested(true)}>Open nested dialog</Button>
      </div>
      {nested && <Modal title="Nested operation" onClose={() => setNested(false)}>
        <Field label="Nested note"><input defaultValue="Keep this note" /></Field>
        <p>Nested modal behavior is validated even though routine flows use one screen.</p>
      </Modal>}
    </Modal>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={new QueryClient()}><AppProviders><Validation /></AppProviders></QueryClientProvider></React.StrictMode>);
