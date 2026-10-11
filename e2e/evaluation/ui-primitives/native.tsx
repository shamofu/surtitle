// SPDX-License-Identifier: GPL-3.0-or-later
// Evaluation-only entry: real Tauri IPC, HWND player and four UI primitives.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixTabs from '@radix-ui/react-tabs';
import { Button as AriaButton, Dialog as AriaDialog, DialogTrigger, Heading, Modal as AriaModal, ModalOverlay, Tabs as AriaTabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { AppProviders } from '../../../src/app/providers';
import { useSurface } from '../../../src/app/runtime';
import { useMedia } from '../../../src/shared/query/snapshot';
import { call } from '../../../src/shared/native/transport';
import { NativePlayer } from '../../../src/features/study/playback/NativePlayer';
import { playerApi } from '../../../src/features/study/playback/api';
import { cardsApi } from '../../../src/features/cards/api';
import type { SubtitleSegment } from '../../../src/shared/contracts/media';
import { Modal as BaselineModal } from './baseline-ui';
import '../../../src/styles.css';
import './native.css';

const candidates = ['current', 'base', 'aria', 'radix'] as const;
type Candidate = typeof candidates[number];

// The same HWND exclusion/input gate/acknowledgement bridge applies to every
// library. The original baseline already registers itself with this provider.
function RegisterSurface() {
  const { registerModal } = useSurface();
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // A child layout effect precedes attachment of a parent's forwarded ref.
    // The committed host node already has its real parent in the portal DOM.
    const notificationHost = host.current;
    const element = notificationHost?.closest<HTMLElement>('.modal');
    if (!element || !notificationHost) return;
    const release = registerModal(element, notificationHost);
    if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
    return release;
  }, [registerModal]);
  return <div ref={host} />;
}

function CandidateTabs({ candidate }: { candidate: Candidate }) {
  const [current, setCurrent] = useState('source');
  const first = useRef<HTMLButtonElement>(null), second = useRef<HTMLButtonElement>(null);
  if (candidate === 'base') return <BaseTabs.Root defaultValue="source"><BaseTabs.List aria-label="Details" activateOnFocus><BaseTabs.Tab value="source">Source</BaseTabs.Tab><BaseTabs.Tab value="notes">Notes</BaseTabs.Tab></BaseTabs.List><BaseTabs.Panel value="source" keepMounted>Original source</BaseTabs.Panel><BaseTabs.Panel value="notes" keepMounted>Learning notes</BaseTabs.Panel></BaseTabs.Root>;
  if (candidate === 'radix') return <RadixTabs.Root defaultValue="source"><RadixTabs.List aria-label="Details"><RadixTabs.Trigger value="source">Source</RadixTabs.Trigger><RadixTabs.Trigger value="notes">Notes</RadixTabs.Trigger></RadixTabs.List><RadixTabs.Content value="source">Original source</RadixTabs.Content><RadixTabs.Content value="notes">Learning notes</RadixTabs.Content></RadixTabs.Root>;
  if (candidate === 'aria') return <AriaTabs defaultSelectedKey="source"><TabList aria-label="Details"><Tab id="source">Source</Tab><Tab id="notes">Notes</Tab></TabList><TabPanel id="source" shouldForceMount>Original source</TabPanel><TabPanel id="notes" shouldForceMount>Learning notes</TabPanel></AriaTabs>;
  return <div><div role="tablist" aria-label="Details">{(['source', 'notes'] as const).map((name, index) => <button key={name} ref={index ? second : first} role="tab" aria-selected={current === name} tabIndex={current === name ? 0 : -1} onClick={() => setCurrent(name)} onKeyDown={event => {
    if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); setCurrent(name === 'source' ? 'notes' : 'source'); (name === 'source' ? second : first).current?.focus();
  }}>{index ? 'Notes' : 'Source'}</button>)}</div><div role="tabpanel">{current === 'source' ? 'Original source' : 'Learning notes'}</div></div>;
}

function CandidateDialog({ candidate, open, requestOpen, children }: { candidate: Candidate; open: boolean; requestOpen: (value: boolean) => void; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  const trigger = <button className="native-candidate-trigger">Select phrase</button>;
  if (candidate === 'current') return <><button className="native-candidate-trigger" onClick={() => requestOpen(true)}>Select phrase</button>{open && <BaselineModal title="Phrase editor" onClose={() => requestOpen(false)}>{children}</BaselineModal>}</>;
  if (candidate === 'base') return <BaseDialog.Root open={open} onOpenChange={requestOpen}><BaseDialog.Trigger render={trigger}/><BaseDialog.Portal><BaseDialog.Backdrop className="native-eval-backdrop"/><BaseDialog.Popup ref={card} className="modal native-eval-card"><RegisterSurface/><BaseDialog.Title>Phrase editor</BaseDialog.Title><BaseDialog.Description>Inspect the same source cue.</BaseDialog.Description>{children}</BaseDialog.Popup></BaseDialog.Portal></BaseDialog.Root>;
  if (candidate === 'radix') return <RadixDialog.Root open={open} onOpenChange={requestOpen}><RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger><RadixDialog.Portal><RadixDialog.Overlay className="native-eval-backdrop"/><RadixDialog.Content ref={card as RefObject<HTMLDivElement | null>} className="modal native-eval-card"><RegisterSurface/><RadixDialog.Title>Phrase editor</RadixDialog.Title><RadixDialog.Description>Inspect the same source cue.</RadixDialog.Description>{children}</RadixDialog.Content></RadixDialog.Portal></RadixDialog.Root>;
  return <DialogTrigger isOpen={open} onOpenChange={requestOpen}><AriaButton className="native-candidate-trigger">Select phrase</AriaButton><ModalOverlay className="native-eval-backdrop" isDismissable><AriaModal className="native-eval-container"><AriaDialog ref={card} className="modal native-eval-card"><RegisterSurface/><Heading slot="title">Phrase editor</Heading><p>Inspect the same source cue.</p>{children}</AriaDialog></AriaModal></ModalOverlay></DialogTrigger>;
}

function Evaluation() {
  const { data: media } = useMedia();
  const selectedMedia = media?.find(item => item.id === 'fixture-media');
  const [candidate, setCandidate] = useState<Candidate>('current');
  const [segment, setSegment] = useState<SubtitleSegment>();
  const [ready, setReady] = useState(false), [open, setOpen] = useState(false);
  const [meaning, setMeaning] = useState('くつろいでください。'), [saved, setSaved] = useState(''), [error, setError] = useState('');
  useEffect(() => { if (selectedMedia) void call('list_segments', { mediaId: selectedMedia.id }).then(rows => setSegment(rows[0])); }, [selectedMedia?.id]);
  const requestOpen = (value: boolean) => {
    if (!value) { setOpen(false); return; }
    void (async () => {
      await playerApi.player({ action: 'pause' });
      await playerApi.player({ action: 'seek', value: segment?.startMs ?? 0 });
      setSaved(''); setOpen(true);
    })().catch(error => setError(String(error)));
  };
  async function save() {
    if (!selectedMedia || !segment) return;
    try {
      await cardsApi.saveCard({ mediaId: selectedMedia.id, segmentId: segment.id, sourceCueIds: [segment.id], term: `${candidate} native phrase`, meaning, example: segment.text }, crypto.randomUUID());
      const snapshot = await call('get_app_snapshot');
      const card = snapshot.cards.find(item => item.term === `${candidate} native phrase` && item.meaning === meaning);
      if (!card) throw new Error('Saved card missing from native snapshot');
      setSaved(card.id);
    } catch (error) { setError(String(error)); }
  }
  return <main className="page-content native-evaluation"><h1>Actual HWND UI comparison</h1><nav>{candidates.map(name => <button key={name} data-candidate={name} aria-pressed={candidate === name} disabled={open} onClick={() => { setCandidate(name); setSaved(''); }}>{name}</button>)}</nav><div className="native-evaluation-layout"><section>{selectedMedia && <NativePlayer media={selectedMedia} selectionRevision={0} onPosition={() => {}} onReady={setReady}/>}</section><aside><h2 data-current-candidate>{candidate}</h2><p>{segment?.text}</p><button disabled={!ready} className="eval-play" onClick={() => void playerApi.player({ action: 'play' })}>Start playback</button>{ready && segment && <CandidateDialog key={candidate} candidate={candidate} open={open} requestOpen={requestOpen}><label>Phrase<input aria-label="Phrase" defaultValue={`${candidate} native phrase`}/></label><label>Meaning<input aria-label="Meaning" value={meaning} onChange={event => setMeaning(event.target.value)}/></label><CandidateTabs candidate={candidate}/><button className="eval-save" onClick={() => void save()}>Save phrase</button><output data-saved-card={saved}>{saved ? 'Saved in native SQLite' : ''}</output><button className="eval-resume" onClick={() => { setOpen(false); void playerApi.player({ action: 'play' }); }}>Resume playback</button></CandidateDialog>}</aside></div><p role="alert">{error}</p><button id="outside">Outside action</button></main>;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><AppProviders><Evaluation/></AppProviders></QueryClientProvider>);
