// SPDX-License-Identifier: GPL-3.0-or-later
export const changeDomains = ['media', 'cards', 'settings', 'tools', 'jobs', 'budget', 'subtitles', 'drafts', 'review', 'downloads', 'operations', 'restore'] as const;
export type ChangeDomain = typeof changeDomains[number];
export type SnapshotDomain = Extract<ChangeDomain, 'media' | 'cards' | 'settings' | 'tools' | 'jobs' | 'budget'>;
export interface DataChangeEvent { version: 1; epoch: string; revision: number; domain: ChangeDomain; entityId?: string }
export interface ChangeCheckpoint { version: 1; epoch: string; revision: number; domains: { domain: ChangeDomain; revision: number }[] }
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const isChangeDomain = (value: unknown): value is ChangeDomain => typeof value === 'string' && changeDomains.some(domain => domain === value);
function isVersioned(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.version === 1 && typeof value.epoch === 'string' && value.epoch.length > 0 && isRevision(value.revision);
}
export function isDataChange(value: unknown): value is DataChangeEvent {
  return isVersioned(value) && isChangeDomain(value.domain) && (value.entityId === undefined || typeof value.entityId === 'string') &&
    Object.keys(value).every(key => ['version', 'epoch', 'revision', 'domain', 'entityId'].includes(key));
}
export function isChangeCheckpoint(value: unknown): value is ChangeCheckpoint {
  return isVersioned(value) && Array.isArray(value.domains) && value.domains.every(entry => isRecord(entry) && isChangeDomain(entry.domain) && isRevision(entry.revision) && entry.revision <= Number(value.revision)) &&
    new Set(value.domains.map(entry => entry.domain)).size === value.domains.length;
}
