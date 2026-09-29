// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
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
  const [busy, setBusy] = useState(false);
  const [externalPath, setExternalPath] = useState(
    tool.provider === 'external' ? tool.path || '' : '',
  );
  const [chooseExternal, setChooseExternal] = useState(false);
  const available = candidates.filter(
    (candidate) => candidate.toolId === tool.id,
  );
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    await report(action);
    setBusy(false);
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
              {ready
                ? t('利用可能', 'Ready')
                : tool.status === 'installing'
                  ? t('準備中', 'Installing')
                  : t('要セットアップ', 'Setup needed')}
            </Badge>
          </h3>
          <p>
            {tool.version || t('未インストール', 'Not installed')}
            <span>·</span>
            {tool.provider === 'managed'
              ? t('Surtitle が管理', 'Managed by Surtitle')
              : t('外部ツール', 'External tool')}
          </p>
        </div>
      </div>
      {tool.updateAvailable && (
        <p className="notice">
          <Download size={15} />
          {t(
            `新しい版 ${tool.latestVersion || ''} を利用できます。`,
            `Update available: ${tool.latestVersion || ''}`,
          )}
        </p>
      )}
      {tool.path && (
        <code className="tool-path" title={tool.path}>
          {tool.path}
        </code>
      )}
      {tool.error && <p className="field-error">{tool.error}</p>}
      <div className="tool-actions">
        <div className="segmented-control compact">
          <button
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
        <div className="inline-actions">
          {tool.provider === 'managed' && (
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
                  )
                }
              >
                {ready ? <RefreshCw size={14} /> : <Download size={14} />}
                {ready
                  ? t('更新する', 'Update tool')
                  : t('ダウンロード', 'Download')}
              </Button>
              {tool.canRollback && (
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
              )}
            </>
          )}
        </div>
      </div>
      {chooseExternal && (
        <div className="external-picker">
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
              onChange={(event) => setExternalPath(event.target.value)}
              placeholder={
                tool.id === 'ffmpeg'
                  ? 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe'
                  : `C:\\Tools\\${tool.id}.exe`
              }
            />
          </Field>
          {available.length > 0 && (
            <div className="candidate-list">
              {available.map((candidate) => (
                <button
                  key={candidate.path}
                  disabled={!candidate.selectable}
                  onClick={() => setExternalPath(candidate.path)}
                  className={externalPath === candidate.path ? 'selected' : ''}
                >
                  <span>
                    <code>{candidate.path}</code>
                    <small>
                      {t(
                        '未検証・選択後に機能互換性を確認します。',
                        'Unverified; capabilities are checked when selected.',
                      )}
                      {candidate.reason ? ` ${candidate.reason}` : ''}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
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
        </div>
      )}
    </article>
  );
}
