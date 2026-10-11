// SPDX-License-Identifier: GPL-3.0-or-later
import type { AiRuntimeSnapshot } from '../contracts/ai';
import type { PlayerState } from '../contracts/player';
import { isDataChange, isRecord, isRevision, type DataChangeEvent } from '../contracts/synchronization';
export interface NativeEventMap {
  'data-changed': DataChangeEvent;
  'player-state': PlayerState;
  'player-surface-click': void;
  'ai-runtime': AiRuntimeSnapshot;
  'tauri://drag-enter': { paths: string[]; position?: { x: number; y: number } };
  'tauri://drag-over': { position?: { x: number; y: number } };
  'tauri://drag-leave': void;
  'tauri://drag-drop': { paths: string[]; position?: { x: number; y: number } };
}
export type NativeEventName = keyof NativeEventMap;
export function validNativeEvent<K extends NativeEventName>(name: K, payload: unknown): payload is NativeEventMap[K] {
  if (name === 'data-changed') return isDataChange(payload);
  if (name === 'player-surface-click' || name === 'tauri://drag-leave') return payload == null;
  if (!isRecord(payload)) return false;
  if (name === 'player-state') return ['positionMs', 'durationMs', 'rate', 'volume'].every(key => typeof payload[key] === 'number' && Number.isFinite(payload[key])) && typeof payload.paused === 'boolean' && Array.isArray(payload.tracks);
  if (name === 'ai-runtime') return typeof payload.jobId === 'string' && typeof payload.approvalId === 'string' && isRevision(payload.revision) && Array.isArray(payload.events);
  if (name === 'tauri://drag-over') return true;
  return Array.isArray(payload.paths) && payload.paths.every(path => typeof path === 'string');
}
