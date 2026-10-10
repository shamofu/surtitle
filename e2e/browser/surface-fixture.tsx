// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-only harness for native dialog/top-layer interactions. Not imported by the app.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProviders } from '../../src/app/providers';
import { useNotifications, useSurface } from '../../src/app/runtime';
import { Button, Field, Modal } from '../../src/shared/ui';
import '../../src/styles.css';

function Surfaces() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const [locked, setLocked] = useState(false);
  const [long, setLong] = useState(false);
  const { report } = useNotifications();
  const { surfaceHidden } = useSurface();
  return <main>
    <output data-testid="surface-state">{surfaceHidden ? 'hidden' : 'visible'}</output>
    <button onClick={() => { setLong(false); setOuter(true); }}>Open editor</button>
    <button onClick={() => { setLong(true); setOuter(true); }}>Open long editor</button>
    {outer && <Modal title="Editor" closeDisabled={locked} onClose={() => setOuter(false)}>
      <button onClick={() => setInner(true)}>Open confirmation</button>
      <button onClick={() => void report(async () => { throw new Error('Could not save'); })}>Fail save</button>
      <label><input type="checkbox" checked={locked} onChange={event => setLocked(event.target.checked)} />Saving</label>
      {long && <>
        {Array.from({ length: 20 }, (_, index) => <Field key={index} label={`Phrase ${index + 1}`}><input defaultValue="An editable phrase" /></Field>)}
        <footer className="modal-footer"><Button onClick={() => void report(async () => { throw new Error('Could not save changes'); })}>Save changes</Button></footer>
      </>}
      {inner && <Modal title="Confirmation" onClose={() => setInner(false)}><input aria-label="Confirmation input" /></Modal>}
    </Modal>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><AppProviders><Surfaces /></AppProviders></QueryClientProvider>);
