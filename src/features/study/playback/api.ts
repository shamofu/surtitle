// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../../shared/native/transport';
import type { PlayerControlRequest } from '../../../shared/contracts/player';

export const playerApi = {
  loadMedia: (mediaId: string) => call('load_media', { mediaId }),
  playerState: () => call('get_player_state'),
  player: (request: PlayerControlRequest) =>
    call('player_control', { request }),
  playSourceRange: (mediaId: string, sourceCueIds: string[]) =>
    call('play_source_range', { mediaId, sourceCueIds }),
  playCardAudio: (cardId: string) => call('play_card_audio', { cardId }),
};
