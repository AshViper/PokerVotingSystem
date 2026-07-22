import {
  Packet,
  JoinPacket,
  PlayerListPacket,
  VotePacket,
  VoteResultPacket,
  DisconnectPacket,
  PlayerInfo,
  VoteEntry,
  isPacket,
} from './packet';

export function parseMessage(data: unknown): Packet | null {
  if (!isPacket(data)) return null;
  return data;
}

export function createJoinPacket(role: 'player' | 'viewer', name?: string): JoinPacket {
  if (role === 'player' && name) {
    return { type: 'join', role: 'player', name };
  }
  return { type: 'join', role: 'viewer' };
}

export function createPlayerListPacket(players: PlayerInfo[]): PlayerListPacket {
  return { type: 'playerList', players };
}

export function createVotePacket(target: string): VotePacket {
  return { type: 'vote', target };
}

export function createVoteResultPacket(result: VoteEntry[]): VoteResultPacket {
  return { type: 'voteResult', result };
}

export function createDisconnectPacket(): DisconnectPacket {
  return { type: 'disconnect' };
}
