// SPDX-License-Identifier: GPL-3.0-or-later
import { listen, type Event } from '@tauri-apps/api/event';
import { validNativeEvent, type NativeEventMap, type NativeEventName } from './event-contracts';

interface Subscriber { receive: (event: Event<unknown>) => void; error: (error: unknown) => void; ready?: () => void }
interface Registration { subscribers: Set<Subscriber>; stop?: () => void; registered: boolean; retry?: ReturnType<typeof setTimeout> }
const registrations = new Map<NativeEventName, Registration>();

/** One native listener per event, including late-registration disposal and typed validation. */
export function subscribeNative<K extends NativeEventName>(
  event: K,
  callback: (event: Event<NativeEventMap[K]>) => void,
  onError: (error: unknown) => void = () => {},
  onReady?: () => void,
): () => void {
  let registration = registrations.get(event);
  const subscriber: Subscriber = { receive: payload => callback(payload as Event<NativeEventMap[K]>), error: onError, ready: onReady };
  if (!registration) {
    registration = { subscribers: new Set(), registered: false };
    registrations.set(event, registration);
    const current = registration;
    let attempts = 0;
    const register = () => { void listen<unknown>(event, payload => {
      if (!current.subscribers.size) return;
      if (!validNativeEvent(event, payload.payload)) {
        current.subscribers.forEach(item => item.error(new Error(`Invalid native event: ${event}`)));
        return;
      }
      current.subscribers.forEach(item => item.receive(payload));
    }).then(stop => {
      if (!current.subscribers.size) { stop(); return; }
      current.stop = stop;
      current.registered = true;
      attempts = 0;
      current.subscribers.forEach(item => item.ready?.());
    }).catch(error => {
      current.subscribers.forEach(item => item.error(error));
      if (current.subscribers.size) current.retry = setTimeout(register, Math.min(30_000, 1000 * 2 ** attempts++));
    }); };
    register();
  }
  registration.subscribers.add(subscriber);
  if (registration.registered) queueMicrotask(() => { if (registration.subscribers.has(subscriber)) onReady?.(); });
  return () => {
    registration.subscribers.delete(subscriber);
    if (!registration.subscribers.size) {
      registration.stop?.();
      if (registration.retry) clearTimeout(registration.retry);
      if (registrations.get(event) === registration) registrations.delete(event);
    }
  };
}
