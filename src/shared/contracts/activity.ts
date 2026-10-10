// SPDX-License-Identifier: GPL-3.0-or-later
export type ProgressUnit = 'bytes' | 'milliseconds' | 'items';
export type ActivityStatus = 'running' | 'waiting' | 'paused' | 'unknown' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface OperationProgress {
  id: string;
  kind: 'tool' | 'preparation';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase: string;
  label: string;
  mediaId?: string;
  toolId?: string;
  parentId?: string;
  completed?: number;
  total?: number;
  unit?: ProgressUnit;
  error?: string;
  updatedAt: string;
  resultId?: string;
}

export interface ActivityDescriptor {
  id?: string;
  kind: string;
  label: string;
  phase?: string;
  mediaId?: string;
  parentId?: string;
  completed?: number;
  total?: number;
  unit?: ProgressUnit;
}

export interface Activity extends Omit<ActivityDescriptor, 'id'> {
  id: string;
  source: 'local' | 'native' | 'download' | 'ai';
  sourceId?: string;
  status: ActivityStatus;
  error?: string;
  updatedAt: string;
  toolId?: string;
  resultId?: string;
}

export type ActivityUpdate = Partial<Pick<Activity, 'phase' | 'completed' | 'total' | 'unit' | 'error'>> & {
  status?: 'running' | 'failed' | 'cancelled';
};
export interface TrackedOptions<T> {
  classifyResult?: (result: T) => { status: 'completed' | 'failed' | 'cancelled'; error?: string; phase?: string };
}

export function activityFinished(activity: Pick<Activity, 'status'>) {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(activity.status);
}

/** Parents own their child operations in the activity count and list. */
export function rootActivities(activities: Activity[]) {
  const ids = new Set(activities.map(activity => activity.id));
  return activities.filter(activity => !activity.parentId || !ids.has(activity.parentId));
}

export function recentActivities(activities: Activity[]) {
  const sorted = [...activities].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return [
    ...sorted.filter(activity => activity.status === 'running'),
    ...sorted.filter(activity => activity.status !== 'running' && !activityFinished(activity)),
    ...sorted.filter(activityFinished).slice(0, 20),
  ];
}
