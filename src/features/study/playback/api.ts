// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../../shared/native/transport';
import type {
  PlayerState,
  PlayerControlRequest,
} from '../../../shared/contracts/player';

export const playerApi = {
  loadMedia: (mediaId: string) => call<void>('load_media', { mediaId }),
  playerState: () => call<PlayerState>('get_player_state'),
  player: (request: PlayerControlRequest) =>
    call<void>('player_control', { request }),
  playSourceRange: (mediaId: string, sourceCueIds: string[]) =>
    call<void>('play_source_range', { mediaId, sourceCueIds }),
  playCardAudio: (cardId: string) => call<void>('play_card_audio', { cardId }),
};
