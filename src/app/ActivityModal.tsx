// SPDX-License-Identifier: GPL-3.0-or-later
import { Children, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react';
import { useActivities } from './providers/Activities';
import { useAppearance, useNotifications, useDataActions } from './runtime';
import { Button, Modal, useModalExit } from '../shared/ui';
import { ProgressStatus } from '../shared/ui/ProgressStatus';
import { rootActivities, type Activity } from '../shared/contracts/activity';
import { libraryApi } from '../features/library/api';
import { aiApi } from '../features/ai/api';

export function ActivityButton() {
  const { runningCount, open, isOpen, close } = useActivities();
  const { t } = useAppearance();
  return <>
    <button className="activity-trigger" onClick={open} aria-label={t('処理状況を開く', 'Open activity')} aria-haspopup="dialog">
      {runningCount ? <RefreshCw size={15} className="spin" aria-hidden="true" /> : <ActivityIcon size={17} aria-hidden="true" />}
      <span className="activity-trigger-label">{t('処理状況', 'Activity')}</span>
      {runningCount > 0 && <span className="nav-count">{runningCount}</span>}
    </button>
    {isOpen && <ActivityModal onClose={close} />}
  </>;
}

export function ActivityModal({ onClose }: { onClose: () => void }) {
  const { activities, error } = useActivities();
  const { t } = useAppearance();
  const exit = useModalExit();
  return <Modal {...exit.modalProps} title={t('処理状況', 'Activity')} onClose={() => void exit.close(onClose)}>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {activities.length ? <div className="activity-list">{rootActivities(activities).map(activity => <ActivityRow key={activity.id} activity={activity} exiting={exit.exiting} onNavigate={action => exit.close(async () => { onClose(); await action(); })}>
      {activities.filter(child => child.parentId === activity.id).map(child => <ProgressStatus key={child.id} {...child} compact />)}
    </ActivityRow>)}</div> : <p className="activity-empty">{t('現在処理中の操作はありません。', 'No operations are running.')}</p>}
    <p className="activity-note">{t('この起動中の完了・失敗・中止は、直近20件まで表示します。', 'The latest 20 completed, failed, or cancelled operations from this session are shown.')}</p>
  </Modal>;
}

function ActivityRow({ activity, children, onNavigate, exiting }: { activity: Activity; children: ReactNode; onNavigate: (action: () => Promise<void>) => Promise<boolean>; exiting: boolean }) {
  const { t } = useAppearance();
  const { report } = useNotifications();
  const { mutate } = useDataActions();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  function follow(event: MouseEvent<HTMLAnchorElement>, action: () => Promise<void>) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void report(() => onNavigate(action));
  }
  const cancellable = activity.status === 'running' && (activity.source === 'download' || activity.source === 'ai' || (activity.source === 'native' && activity.kind === 'preparation'));
  async function cancel() {
    if (busy || exiting) return;
    setBusy(true);
    try {
      await report(() => activity.source === 'download' ? mutate(() => libraryApi.cancelDownload(activity.sourceId!), { kind: 'downloads' })
        : activity.source === 'ai' ? mutate(() => aiApi.cancelAiJob(activity.sourceId!), { kind: 'snapshot' })
          : aiApi.cancelPreparation(activity.id));
    } finally { setBusy(false); }
  }
  return <article className="activity-item" data-activity-id={activity.id}>
    <ProgressStatus {...activity} />
    {Children.count(children) > 0 && <div className="activity-children">{children}</div>}
    <div className="inline-actions">
      {cancellable && <Button busy={busy} onClick={() => void cancel()}>{t('中止', 'Cancel')}</Button>}
      {activity.mediaId ? <Link to="/study/$mediaId" params={{ mediaId: activity.mediaId }} className="button" onClick={event => follow(event, () => navigate({ to: '/study/$mediaId', params: { mediaId: activity.mediaId! } }))}>{t('教材を開く', 'Open media')}</Link>
        : ['tool', 'tool_check', 'models', 'tool_scan', 'tool_updates'].includes(activity.kind) ? <Link to="/settings" className="button" onClick={event => follow(event, () => navigate({ to: '/settings' }))}>{t('設定を開く', 'Open settings')}</Link>
          : activity.source === 'download' || ['import_check', 'import', 'restore', 'restore_preview', 'export'].includes(activity.kind) ? <Link to="/" className="button" onClick={event => follow(event, () => navigate({ to: '/' }))}>{t('ライブラリを開く', 'Open library')}</Link> : null}
    </div>
  </article>;
}
