// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProviders } from '../../src/app/providers';
import { PlaybackRateControl } from '../../src/features/study/playback/PlaybackRateControl';
import { Modal, useModalExit } from '../../src/shared/ui';
import '../../src/styles.css';

function DialogSlides() {
  const [shown, setShown] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [topTrigger, setTopTrigger] = useState(false);
  const [revision, setRevision] = useState(0);
  const [commits, setCommits] = useState(0);
  const exit = useModalExit(shown);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    Object.assign(window, { dialogSlides: {
      open: () => { exit.reopen(); setShown(true); },
      close: () => void exit.close(() => { setCommits(value => value + 1); setShown(false); }),
      reopen: exit.reopen,
      rerender: () => setRevision(value => value + 1),
      rate: (open: boolean) => setRateOpen(open),
      topTrigger: () => setTopTrigger(true),
    } });
  });
  return <main>
    <output data-testid="commits">{commits}</output>
    <output>{revision}</output>
    {shown && <Modal {...exit.modalProps} onExited={() => exit.modalProps.onExited()} title="Sliding editor" onClose={() => void exit.close(() => { setCommits(value => value + 1); setShown(false); })}>
      <input aria-label="Draft" defaultValue="日本語の下書き" />
    </Modal>}
    <div style={{ position: 'fixed', right: 24, top: topTrigger ? 24 : undefined, bottom: topTrigger ? undefined : 24 }}>
      <PlaybackRateControl label="Playback speed" decreaseLabel="Decrease speed" increaseLabel="Increase speed" closeLabel="Close speed"
        value={1} disabled={false} isOpen={rateOpen} onOpenChange={setRateOpen} onChange={async () => { setRevision(value => value + 1); }} triggerRef={trigger} />
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><AppProviders><DialogSlides /></AppProviders></QueryClientProvider>);
