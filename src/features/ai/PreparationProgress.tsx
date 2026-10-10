// SPDX-License-Identifier: GPL-3.0-or-later
import { useActivities } from '../../app/providers/Activities';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { MotionRegion, MotionSwap } from '../../shared/motion';

/** Correlate progress with this request; old global preparation events are ambiguous. */
export function PreparationProgress({ operationId, label }: { operationId?: string; label: string }) {
  const { activities } = useActivities();
  const operation = operationId ? activities.find(item => item.source === 'native' && item.id === operationId) : undefined;
  const dependency = operationId ? activities.find(item => item.source === 'native' && item.parentId === operationId && item.status === 'running') : undefined;
  return <>
    <ProgressStatus label={label} phase={operation?.phase ?? 'setup'} completed={operation?.completed} total={operation?.total} unit={operation?.unit} status={operation?.status ?? 'running'} error={operation?.error} />
    <MotionRegion open={!!dependency}><MotionSwap stateKey={dependency?.id ?? 'none'}>{dependency && <ProgressStatus label={dependency.label} phase={dependency.phase} completed={dependency.completed} total={dependency.total} unit={dependency.unit} status={dependency.status} compact />}</MotionSwap></MotionRegion>
  </>;
}
