// SPDX-License-Identifier: GPL-3.0-or-later
// Isolated comparison. This entry is never imported by the production app.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixPopover from '@radix-ui/react-popover';
import * as RadixTabs from '@radix-ui/react-tabs';
import { Button as AriaButton, Dialog as AriaDialog, DialogTrigger, Heading, Modal as AriaModal, Popover as AriaPopover, Tabs as AriaTabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { AppProviders } from '../../../src/app/providers';
import { Modal } from './baseline-ui';
import { AnimatedDetails } from '../../../src/shared/ui/AnimatedDetails';
import '../../../src/styles.css';
import './style.css';

const names = ['current', 'base', 'aria', 'radix'] as const;
type Candidate = typeof names[number];
const requested = new URLSearchParams(location.search).get('candidate');
const candidate: Candidate = names.find(name => name === requested) ?? 'current';

function Fields() {
  return <><label className="eval-field">Phrase<input autoFocus aria-label="Phrase" defaultValue="Take a little detour" /></label><label className="eval-field">Meaning<input aria-label="Meaning" defaultValue="少し寄り道をする" /></label></>;
}
function Tabs({ name }: { name: Candidate }) {
  const [tab, setTab] = useState('one');
  const first = useRef<HTMLButtonElement>(null), second = useRef<HTMLButtonElement>(null);
  if (name === 'base') return <BaseTabs.Root defaultValue="one"><BaseTabs.List aria-label="Details" activateOnFocus><BaseTabs.Tab value="one">Source</BaseTabs.Tab><BaseTabs.Tab value="two">Notes</BaseTabs.Tab></BaseTabs.List><BaseTabs.Panel value="one">Original source</BaseTabs.Panel><BaseTabs.Panel value="two">Learning notes</BaseTabs.Panel></BaseTabs.Root>;
  if (name === 'radix') return <RadixTabs.Root defaultValue="one"><RadixTabs.List aria-label="Details"><RadixTabs.Trigger value="one">Source</RadixTabs.Trigger><RadixTabs.Trigger value="two">Notes</RadixTabs.Trigger></RadixTabs.List><RadixTabs.Content value="one">Original source</RadixTabs.Content><RadixTabs.Content value="two">Learning notes</RadixTabs.Content></RadixTabs.Root>;
  if (name === 'aria') return <AriaTabs defaultSelectedKey="one"><TabList aria-label="Details"><Tab id="one">Source</Tab><Tab id="two">Notes</Tab></TabList><TabPanel id="one">Original source</TabPanel><TabPanel id="two">Learning notes</TabPanel></AriaTabs>;
  return <div><div role="tablist" aria-label="Details">{(['one', 'two'] as const).map((value, index) => <button key={value} ref={index ? second : first} id={'tab-' + value} role="tab" aria-selected={tab === value} aria-controls={'panel-' + value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
    if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'one' : event.key === 'End' ? 'two' : value === 'one' ? 'two' : 'one'; setTab(next); (next === 'one' ? first : second).current?.focus();
  }}>{index ? 'Notes' : 'Source'}</button>)}</div><div role="tabpanel" id={'panel-' + tab} aria-labelledby={'tab-' + tab}>{tab === 'one' ? 'Original source' : 'Learning notes'}</div></div>;
}
function Current() {
  const [open, setOpen] = useState(false), [popover, setPopover] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  return <><button onClick={() => setOpen(true)}>Open dialog</button><AnimatedDetails open={popover} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPopover(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setPopover(false); trigger.current?.focus(); } }}><summary onClick={event => { event.preventDefault(); trigger.current = event.currentTarget; setPopover(value => !value); }}>Open popover</summary><div className="eval-popover" role="dialog" aria-label="Quick settings"><label>Filter<input aria-label="Filter" /></label><button onClick={() => { setPopover(false); trigger.current?.focus(); }}>Close popover</button></div></AnimatedDetails>{open && <Modal title="Phrase editor" onClose={() => setOpen(false)}><Fields/><Tabs name="current"/><button onClick={() => setOpen(false)}>Close editor</button></Modal>}</>;
}
function Base() {
  return <><BaseDialog.Root><BaseDialog.Trigger>Open dialog</BaseDialog.Trigger><BaseDialog.Portal><BaseDialog.Backdrop className="eval-backdrop"/><BaseDialog.Popup className="eval-dialog"><BaseDialog.Title>Phrase editor</BaseDialog.Title><BaseDialog.Description>Review the original phrase.</BaseDialog.Description><Fields/><Tabs name="base"/><BaseDialog.Close>Close editor</BaseDialog.Close></BaseDialog.Popup></BaseDialog.Portal></BaseDialog.Root><BasePopover.Root><BasePopover.Trigger>Open popover</BasePopover.Trigger><BasePopover.Portal><BasePopover.Positioner><BasePopover.Popup className="eval-popover" aria-label="Quick settings"><BasePopover.Title>Quick settings</BasePopover.Title><label>Filter<input aria-label="Filter" /></label><BasePopover.Close>Close popover</BasePopover.Close></BasePopover.Popup></BasePopover.Positioner></BasePopover.Portal></BasePopover.Root></>;
}
function Aria() {
  return <><DialogTrigger><AriaButton>Open dialog</AriaButton><AriaModal isDismissable className="eval-dialog"><AriaDialog><Heading slot="title">Phrase editor</Heading><Fields/><Tabs name="aria"/><AriaButton slot="close">Close editor</AriaButton></AriaDialog></AriaModal></DialogTrigger><DialogTrigger><AriaButton>Open popover</AriaButton><AriaPopover className="eval-popover"><AriaDialog aria-label="Quick settings"><label>Filter<input aria-label="Filter" /></label><AriaButton slot="close">Close popover</AriaButton></AriaDialog></AriaPopover></DialogTrigger></>;
}
function Radix() {
  return <><RadixDialog.Root><RadixDialog.Trigger>Open dialog</RadixDialog.Trigger><RadixDialog.Portal><RadixDialog.Overlay className="eval-backdrop"/><RadixDialog.Content className="eval-dialog"><RadixDialog.Title>Phrase editor</RadixDialog.Title><RadixDialog.Description>Review the original phrase.</RadixDialog.Description><Fields/><Tabs name="radix"/><RadixDialog.Close>Close editor</RadixDialog.Close></RadixDialog.Content></RadixDialog.Portal></RadixDialog.Root><RadixPopover.Root><RadixPopover.Trigger>Open popover</RadixPopover.Trigger><RadixPopover.Portal><RadixPopover.Content className="eval-popover" aria-label="Quick settings"><label>Filter<input aria-label="Filter" /></label><RadixPopover.Close>Close popover</RadixPopover.Close></RadixPopover.Content></RadixPopover.Portal></RadixPopover.Root></>;
}
function Evaluation() {
  return <main className="evaluation"><h1>UI primitive comparison: {candidate}</h1><p>Same dialog, popover, fields and two tabs. No production route uses this entry.</p><nav>{names.map(name => <a key={name} href={'?candidate=' + name}>{name}</a>)}</nav><section className="eval-controls">{candidate === 'current' ? <Current/> : candidate === 'base' ? <Base/> : candidate === 'aria' ? <Aria/> : <Radix/>}</section><button id="outside">Outside action</button></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={new QueryClient()}><AppProviders><Evaluation/></AppProviders></QueryClientProvider></React.StrictMode>);
