// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from 'react';
import { useAppearance, useNotifications } from '../../app/runtime';
import { nativeAvailable } from '../../shared/native/transport';
import { Button } from '../../shared/ui';
import { settingsApi } from './api';

export function WindowSizeSettings() {
  const { t } = useAppearance();
  const { notify } = useNotifications();
  const [pending, setPending] = useState(false);
  const applying = useRef(false);
  const available = nativeAvailable();
  async function apply(preset: Parameters<typeof settingsApi.setWindowSizePreset>[0]) {
    if (!available || applying.current) return;
    applying.current = true;
    setPending(true);
    try { await settingsApi.setWindowSizePreset(preset); }
    catch (error) { notify(String(error), 'error'); }
    finally { applying.current = false; setPending(false); }
  }
  return <fieldset className="window-size-presets" disabled={!available || pending} aria-busy={pending}>
    <legend>{t('ウィンドウサイズ', 'Window size')}</legend>
    <p className="field-hint">{available
      ? t('最小サイズは1280×720です。画面に収まらない場合は、作業領域に合わせて縮小します。', 'The minimum size is 1280×720. Sizes are reduced to fit the display when needed.')
      : t('デスクトップアプリで変更できます。', 'Available in the desktop app.')}</p>
    <div className="window-size-actions">
      <Button onClick={() => void apply('hd')}>1280 × 720 (HD)</Button>
      <Button onClick={() => void apply('standard')}>1600 × 900 ({t('標準', 'Default')})</Button>
      <Button onClick={() => void apply('full-hd')}>1920 × 1080 (Full HD)</Button>
    </div>
  </fieldset>;
}
