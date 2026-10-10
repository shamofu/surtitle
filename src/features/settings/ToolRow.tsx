// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { Check, Download, RefreshCw, RotateCcw, Terminal } from 'lucide-react';

import { settingsApi } from './api';

import type { ExternalToolCandidate } from '../../shared/contracts/settings';
import type { ToolStatus } from '../../shared/contracts/settings';
import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../app/runtime';

import { Badge, Button, Field } from '../../shared/ui/index';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { useActivities } from '../../app/providers/Activities';
import { AnimatedValue, MotionRegion, MotionSwap } from '../../shared/motion';

export function ToolRow({
  tool,
  candidates,
}: {
  tool: ToolStatus;
  candidates: ExternalToolCandidate[];
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const { activities, runTracked } = useActivities();
  const [pending, setBusy] = useState(false);
  const operation = activities.find(item => item.source === 'native' && item.toolId === tool.id && item.status === 'running');
  const busy = pending || !!operation;
  const [externalPath, setExternalPath] = useState(
    tool.provider === 'external' ? tool.path || '' : '',
  );
  const [chooseExternal, setChooseExternal] = useState(false);
  useEffect(() => {
    // Committed tool changes should not replace an in-progress path edit.
    if (!chooseExternal) setExternalPath(tool.provider === 'external' ? tool.path || '' : '');
  }, [tool.provider, tool.path, chooseExternal]);
  const available = candidates.filter(
    (candidate) => candidate.toolId === tool.id,
  );
  async function perform(action: () => Promise<void>, nativeProgress = false) {
    setBusy(true);
    try {
      await report(() => nativeProgress ? action() : runTracked({ kind: 'tool_check', label: tool.name, phase: 'verifying' }, action));
    } finally {
      setBusy(false);
    }
  }
  const ready = tool.status === 'ready';
  return (
    <article className="tool-row">
      <div className="tool-heading">
        <div className="tool-icon">
          <Terminal size={21} />
        </div>
        <div>
          <h3>
            {tool.name}
            <Badge
              tone={
                ready
                  ? 'accent'
                  : tool.status === 'error'
                    ? 'danger'
                    : 'neutral'
              }
            >
              <MotionSwap as="span" stateKey={tool.status}>{ready
                ? t('利用可能', 'Ready')
                : tool.status === 'installing'
                  ? t('準備中', 'Installing')
                  : t('要セットアップ', 'Setup needed')}</MotionSwap>
            </Badge>
          </h3>
          <p>
            <AnimatedValue value={tool.version || t('未インストール', 'Not installed')} />
            <span>·</span>
            <MotionSwap as="span" stateKey={tool.provider}>{tool.provider === 'managed'
              ? t('Surtitle が管理', 'Managed by Surtitle')
              : t('外部ツール', 'External tool')}</MotionSwap>
          </p>
        </div>
      </div>
      <MotionRegion open={!!tool.updateAvailable}>
        <p className="notice">
          <Download size={15} />
          <AnimatedValue value={t(
            `新しい版 ${tool.latestVersion || ''} を利用できます。`,
            `Update available: ${tool.latestVersion || ''}`,
          )} />
        </p>
      </MotionRegion>
      <MotionRegion open={!!tool.path}>
        <div className="tool-current-path">
          <span>{t('現在使用中のパス', 'Currently used path')}</span>
          <code className="tool-path" title={tool.path}><MotionSwap as="span" stateKey={tool.path || ''}>{tool.path}</MotionSwap></code>
        </div>
      </MotionRegion>
      <MotionRegion open={!!tool.error}><p className="field-error"><MotionSwap as="span" stateKey={tool.error || ''}>{tool.error}</MotionSwap></p></MotionRegion>
      <MotionRegion open={busy}><ProgressStatus label={tool.name} phase={operation?.phase || 'preparing'} completed={operation?.completed} total={operation?.total} unit={operation?.unit} /></MotionRegion>
      <div className="tool-actions">
        <div className="segmented-control compact" role="group" aria-label={t(`${tool.name}の取得方法`, `${tool.name} source`)}>
          <button
            type="button"
            aria-pressed={tool.provider === 'managed' && !chooseExternal}
            className={
              tool.provider === 'managed' && !chooseExternal ? 'selected' : ''
            }
            disabled={busy}
            onClick={() => {
              setChooseExternal(false);
              if (tool.provider !== 'managed')
                void perform(() =>
                  mutate(
                    () =>
                      settingsApi.setToolProvider({
                        toolId: tool.id,
                        provider: 'managed',
                      }),
                    { kind: 'snapshot' },
                  ),
                );
            }}
          >
            {t('アプリ管理', 'Managed')}
          </button>
          {tool.id !== 'vad' && (
            <button
              type="button"
              aria-pressed={tool.provider === 'external' || chooseExternal}
              className={
                tool.provider === 'external' || chooseExternal ? 'selected' : ''
              }
              disabled={busy}
              onClick={() => setChooseExternal(true)}
            >
              {t('外部を使う', 'External')}
            </button>
          )}
        </div>
        <MotionRegion className="inline-actions" open={tool.provider === 'managed'}>
            <>
              <Button
                busy={busy}
                disabled={tool.status === 'installing'}
                onClick={() =>
                  void perform(() =>
                    ready
                      ? mutate(() => settingsApi.updateTool(tool.id), {
                          kind: 'snapshot',
                        })
                      : mutate(() => settingsApi.installTool(tool.id), {
                          kind: 'snapshot',
                        }),
                    true,
                  )
                }
              >
                <MotionSwap as="span" stateKey={ready ? 'update' : 'download'}>{ready ? <RefreshCw size={14} /> : <Download size={14} />}</MotionSwap>
                <MotionSwap as="span" stateKey={ready ? 'update' : 'download'}>{ready
                  ? t('更新する', 'Update tool')
                  : t('ダウンロード', 'Download')}</MotionSwap>
              </Button>
              <MotionRegion as="span" open={!!tool.canRollback}>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      mutate(() => settingsApi.rollbackTool(tool.id), {
                        kind: 'snapshot',
                      }),
                    )
                  }
                >
                  <RotateCcw size={14} />
                  {t('前の版へ', 'Roll back')}
                </Button>
              </MotionRegion>
            </>
        </MotionRegion>
      </div>
      <MotionRegion open={chooseExternal}>
        <div className="external-picker">
          <h4>{t('PATHで見つかった候補', 'Candidates found on PATH')}</h4>
          <p className="helper-text">{t('候補を選ぶと下の入力欄にパスが入ります。「検証してこのパスを使用」で確認・適用します。', 'Select a candidate to fill the path below, then verify and use it.')}</p>
          <MotionSwap stateKey={available.map(candidate => candidate.path).join('|')}>
          {available.length > 0 ? (
            <div className="candidate-list">
              {available.map((candidate) => (
                <div key={candidate.path} className={`tool-candidate ${externalPath === candidate.path ? 'selected' : ''}`}>
                  <div>
                    <code>{candidate.path}</code>
                    <small>{t('未検証・選択後に機能互換性を確認します。', 'Unverified; capabilities are checked when selected.')}{candidate.reason ? ` ${candidate.reason}` : ''}</small>
                  </div>
                  <Button disabled={busy || !candidate.selectable} aria-label={t(`候補を選択 ${candidate.path}`, `Select candidate ${candidate.path}`)} aria-pressed={externalPath === candidate.path} onClick={() => setExternalPath(candidate.path)}>
                    <MotionRegion as="span" open={externalPath === candidate.path}><Check size={14} /></MotionRegion>
                    <MotionSwap as="span" stateKey={externalPath === candidate.path ? 'selected' : 'select'}>{externalPath === candidate.path ? t('選択中', 'Selected') : t('選択', 'Select')}</MotionSwap>
                  </Button>
                </div>
              ))}
            </div>
          ) : <p className="helper-text">{t('候補がありません。PATHを再検索するか、実行ファイルのパスを入力してください。', 'No candidates found. Rescan PATH or enter an executable path.')}</p>}
          </MotionSwap>
          <Field
            label={t(
              '使用する実行ファイルの絶対パス',
              'Absolute executable path',
            )}
            hint={t(
              '選んだパスだけを使用します。外部ツールをアプリが更新・削除することはありません。',
              'Only this selected path is used. Surtitle never updates or deletes an external tool.',
            )}
          >
            <input
              value={externalPath}
              disabled={busy}
              onChange={(event) => setExternalPath(event.target.value)}
              placeholder={
                tool.id === 'ffmpeg'
                  ? 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe'
                  : `C:\\Tools\\${tool.id}.exe`
              }
            />
          </Field>
          <Button
            busy={busy}
            disabled={!externalPath.trim()}
            onClick={() =>
              void perform(async () => {
                await mutate(
                  () =>
                    settingsApi.setToolProvider({
                      toolId: tool.id,
                      provider: 'external',
                      path: externalPath.trim(),
                    }),
                  { kind: 'snapshot' },
                );
                setChooseExternal(false);
              })
            }
          >
            <Check size={15} />
            {t('検証してこのパスを使用', 'Verify and use this path')}
          </Button>
          <p className="helper-text">{t('検証に成功するとすぐに反映します。設定画面の「変更を保存」は不要です。', 'A successful verification takes effect immediately. You do not need to save settings separately.')}</p>
        </div>
      </MotionRegion>
    </article>
  );
}
