// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { AnimatedValue } from '../../../shared/motion';

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function VolumeControl({ value, disabled, label, onChange }: {
  value: number;
  disabled: boolean;
  label: string;
  onChange: (value: number) => Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [interacting, setInteracting] = useState(false);
  const current = useRef(clamp(value));
  const pending = useRef<number | null>(null);
  const sending = useRef(false);
  const mounted = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  if (preview === null) current.current = clamp(value);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  useEffect(() => {
    if (disabled) { pending.current = null; setPreview(null); setInteracting(false); }
  }, [disabled]);

  async function drain() {
    if (sending.current) return;
    sending.current = true;
    try {
      // Keep native commands ordered, coalescing intermediate drag/wheel values.
      while (mounted.current && pending.current !== null) {
        const next = pending.current;
        pending.current = null;
        await change.current(next);
      }
    } finally {
      sending.current = false;
      if (mounted.current) setPreview(null);
    }
  }
  function update(next: number) {
    if (disabled) return;
    next = clamp(next);
    if (next === current.current) return;
    current.current = next;
    setPreview(next);
    pending.current = next;
    void drain();
  }
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(() => {
    const element = container.current;
    if (!element || disabled) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const next = event.deltaY < 0
        ? (Math.floor(current.current / 5) + 1) * 5
        : (Math.ceil(current.current / 5) - 1) * 5;
      updateRef.current(next);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [disabled]);

  const displayed = preview ?? clamp(value);
  return (
    <div className="volume-control" ref={container}>
      <Volume2 size={16} aria-hidden="true" />
      <input className="volume-slider" type="range" min="0" max="100" step="1"
        value={displayed} disabled={disabled} aria-label={label} aria-valuetext={`${displayed}%`}
        onPointerDown={() => setInteracting(true)} onPointerUp={() => setInteracting(false)}
        onPointerCancel={() => setInteracting(false)} onBlur={() => setInteracting(false)}
        onKeyDown={() => setInteracting(true)} onKeyUp={() => setInteracting(false)}
        onChange={event => update(event.currentTarget.valueAsNumber)} />
      <span className="volume-value" aria-hidden="true"><AnimatedValue value={`${displayed}%`} immediate={interacting || preview !== null} /></span>
    </div>
  );
}
