// SPDX-License-Identifier: GPL-3.0-or-later
import type { MediaFileValidation } from '../../shared/contracts/media';

export interface ImportQueueItem {
  id: number;
  inputPath: string;
  canonicalPath?: string;
  status: 'ready' | 'invalid' | 'existing' | 'importing' | 'imported' | 'failed';
  reason?: Extract<MediaFileValidation, { status: 'invalid' }>['reason'];
  error?: string;
  mediaId?: string;
  languagePair: string;
}

export function languagePair(learning: string, explanation: string) {
  const normalize = (value: string) => value.trim().replace(/[A-Z]/g, letter => letter.toLowerCase());
  return JSON.stringify([normalize(learning), normalize(explanation)]);
}

export function queueStatus(item: ImportQueueItem, pair: string) {
  // An existing item can be imported with a different language pair. The
  // backend checks it again before any write; an old media link is not reused.
  return item.status === 'existing' && item.languagePair !== pair ? 'ready' : item.status;
}

export function pathKey(path: string) {
  return path.replace(/\\/g, '/').toLowerCase();
}

export function validatedItem(id: number, result: MediaFileValidation, pair: string): ImportQueueItem {
  return { id, ...result, languagePair: pair };
}

export function mergeQueue(current: ImportQueueItem[], incoming: ImportQueueItem[]) {
  const keys = new Set(current.map(item => pathKey(item.canonicalPath || item.inputPath)));
  return [...current, ...incoming.filter(item => {
    const key = pathKey(item.canonicalPath || item.inputPath);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  })];
}
