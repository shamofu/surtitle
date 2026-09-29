// SPDX-License-Identifier: GPL-3.0-or-later
export interface PlayerTrack {
  id: number;
  kind: string;
  title: string;
  language?: string;
  selected: boolean;
  ffIndex?: number | null;
  external?: boolean;
}

export interface PlayerState {
  sentencePause?: boolean;
  ready?: boolean;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  rate: number;
  volume: number;
  tracks: PlayerTrack[];
  error?: string;
  surfaceVisible?: boolean;
  videoWidth?: number;
  videoHeight?: number;
}

export interface PlayerControlRequest {
  action:
    | 'source-seek'
    | 'source-loop'
    | 'play'
    | 'pause'
    | 'seek'
    | 'rate'
    | 'volume'
    | 'loop'
    | 'bounds'
    | 'hide'
    | 'track'
    | 'fullscreen'
    | 'sentence-pause'
    | 'draft-mode';
  trackKind?: 'audio' | 'sub';
  value?: number;
  startMs?: number;
  endMs?: number;
  /** CSS-pixel coordinates; native backend converts using scaleFactor. */
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
  };
}
