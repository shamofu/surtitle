// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Button, DialogTrigger, Popover } from 'react-aria-components';
import { Gauge, Minus, Plus, X } from 'lucide-react';
import { useSurface } from '../../../app/runtime';
import { motionDistances, motionDurations } from '../../../shared/motion';
import { useShellPresence } from '../../../shared/motion/useShellPresence';
import { MotionButton } from '../../../shared/ui';

const presets = [{ value: .5, text: '0.5' }, { value: .75, text: '0.75' }, { value: 1, text: '1.0' }, { value: 1.25, text: '1.25' }, { value: 1.5, text: '1.5' }, { value: 2, text: '2.0' }, { value: 3, text: '3.0' }];
const ticks = (value: number) => Math.max(5, Math.min(60, Math.round(value * 20)));

function RatePopupContent({ open, triggerRef, onExited, children }: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onExited: () => void;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const { activeModal } = useSurface();
  useLayoutEffect(() => {
    const node = content.current;
    if (!open || activeModal || !node) return;
    const recoverFocus = () => {
      if (!document.hasFocus()) return;
      // A retained popup does not remount its autoFocus input when reopened.
      // Return to adjustment only while focus still belongs to this trigger.
      if (document.activeElement !== document.body && document.activeElement !== triggerRef.current
        && document.activeElement !== node.querySelector('[role="dialog"]')) return;
      node.querySelector<HTMLInputElement>('.playback-rate-slider')?.focus({ preventScroll: true });
    };
    recoverFocus();
    window.addEventListener('focus', recoverFocus);
    return () => { window.removeEventListener('focus', recoverFocus); };
  }, [open, activeModal, triggerRef]);
  useLayoutEffect(() => {
    if (!open && content.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
  }, [open, triggerRef]);
  useShellPresence(content, { open, distance: motionDistances.menu, enterDuration: motionDurations.menuOpen, exitDuration: motionDurations.menuClose, onExited });
  return <div ref={content} className="playback-rate-content" inert={!open} aria-hidden={!open || undefined}>{children}</div>;
}

export function PlaybackRateControl({ label, decreaseLabel, increaseLabel, closeLabel, value, disabled, isOpen, onOpenChange, onChange, triggerRef }: {
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
  closeLabel: string;
  value: number;
  disabled: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (rate: number) => Promise<void>;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [retained, setRetained] = useState(isOpen);
  const rateValueId = useId();
  const dialogId = useId();
  const videoPointer = useRef(false);
  const [preview, setPreview] = useState<number | null>(null);
  const current = useRef(ticks(value));
  const pending = useRef<number | null>(null);
  const sending = useRef(false);
  const mounted = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  if (preview === null) current.current = ticks(value);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  useEffect(() => { if (disabled) { pending.current = null; setPreview(null); } }, [disabled]);
  async function drain() {
    if (sending.current) return;
    sending.current = true;
    try {
      // Keep one native rate command in flight and retain only the latest drag
      // or repeated-step target. The owner reads fresh native state before ack.
      while (mounted.current && pending.current !== null) {
        const next = pending.current;
        pending.current = null;
        await change.current(next / 20);
      }
    } finally {
      sending.current = false;
      if (mounted.current) setPreview(null);
    }
  }
  function update(next: number) {
    if (disabled) return;
    const target = ticks(next);
    if (target === current.current) return;
    current.current = target;
    setPreview(target);
    pending.current = target;
    void drain();
  }
  const displayedTicks = preview ?? ticks(value);
  const displayed = displayedTicks / 20;
  const finishExit = useCallback(() => setRetained(false), []);
  const { activeModal } = useSurface();
  const changeOpen = useCallback((next: boolean) => {
    // The video's click handler owns dismissal. Its preceding focus transition
    // must not close first and turn that same click into a playback toggle.
    if (!next && videoPointer.current) return;
    onOpenChange(next);
  }, [onOpenChange]);
  useLayoutEffect(() => { if (isOpen) setRetained(true); }, [isOpen]);
  useLayoutEffect(() => {
    if (!isOpen || activeModal) return;
    const escape = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      triggerRef.current?.focus({ preventScroll: true });
      onOpenChange(false);
    };
    document.addEventListener('keydown', escape, true);
    const dismissOutside = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Node)) return;
      videoPointer.current = event.target instanceof Element && !!event.target.closest('.player-surface-toggle');
      if (videoPointer.current) return;
      if (triggerRef.current?.contains(event.target)
        || (event.target instanceof Element && event.target.closest('[data-native-popup="playback-rate"]'))) return;
      onOpenChange(false);
    };
    const endPointer = () => { videoPointer.current = false; };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('pointerup', endPointer, true);
    document.addEventListener('pointercancel', endPointer, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('pointerup', endPointer, true);
      document.removeEventListener('pointercancel', endPointer, true);
      videoPointer.current = false;
    };
  }, [isOpen, activeModal, onOpenChange, triggerRef]);
  function close() { triggerRef.current?.focus({ preventScroll: true }); onOpenChange(false); }
  return <div className="speed-select" title={`${label}: ${displayed}×`}><DialogTrigger isOpen={isOpen} onOpenChange={changeOpen}>
    <Button className="playback-rate-trigger" aria-label={label} aria-haspopup="dialog" aria-controls={isOpen ? dialogId : undefined} aria-describedby={rateValueId} isDisabled={disabled} ref={triggerRef}>
      <Gauge size={18} aria-hidden="true" /><span id={rateValueId}>{displayed}×</span>
    </Button>
    <Popover className="playback-rate-popover" placement="top end" offset={6} isNonModal
      shouldCloseOnInteractOutside={target => !triggerRef.current?.contains(target)}
      isExiting={!isOpen && retained} data-native-popup="playback-rate" data-state={isOpen ? 'open' : 'closing'}>
      <RatePopupContent open={isOpen} triggerRef={triggerRef} onExited={finishExit}>
        {/* This nonmodal popup must let keyboard users return to its trigger.
            React Aria Dialog would enable focus containment on the outer Popover. */}
        <section className="playback-rate-dialog" id={dialogId} role="dialog" aria-label={label} tabIndex={-1}>
          <div className="playback-rate-header">
            <MotionButton className="playback-rate-close" aria-label={closeLabel} onClick={close}><X size={17} aria-hidden="true" /></MotionButton>
            <h2 className="playback-rate-heading">{label}</h2>
          </div>
          <div className="playback-rate-body">
            <output className="playback-rate-value" aria-hidden="true">{displayed.toFixed(2)}×</output>
            <div className="playback-rate-adjustment">
              <MotionButton className="playback-rate-step" aria-label={decreaseLabel} disabled={disabled} aria-disabled={displayedTicks <= 5}
                onClick={() => update((current.current - 1) / 20)}><Minus size={18} aria-hidden="true" /></MotionButton>
              <input className="playback-rate-slider" type="range" min="0.25" max="3" step="0.05" value={displayed}
                aria-label={label} aria-valuetext={`${displayed.toFixed(2)}×`} disabled={disabled} autoFocus
                style={{ '--rate-progress': `${(displayedTicks - 5) / 55 * 100}%` } as CSSProperties}
                onChange={event => update(event.currentTarget.valueAsNumber)} />
              <MotionButton className="playback-rate-step" aria-label={increaseLabel} disabled={disabled} aria-disabled={displayedTicks >= 60}
                onClick={() => update((current.current + 1) / 20)}><Plus size={18} aria-hidden="true" /></MotionButton>
            </div>
            <div className="playback-rate-presets" role="group" aria-label={label}>
              {[presets.slice(0, 3), presets.slice(3)].map((row, index) => <div className={`playback-rate-preset-row ${index ? 'fast' : ''}`} key={index}>
                {row.map(preset => <MotionButton className="playback-rate-preset" key={preset.text} aria-pressed={displayedTicks === ticks(preset.value)}
                  disabled={disabled} onClick={() => update(preset.value)}>{preset.text}</MotionButton>)}
              </div>)}
            </div>
          </div>
        </section>
      </RatePopupContent>
    </Popover>
  </DialogTrigger></div>;
}
