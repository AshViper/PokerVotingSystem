export interface PlayerInfo {
  peerId: string;
  name: string;
}

export interface VoteEntry {
  peerId: string;
  name: string;
  voteCount: number;
}

export interface JoinPacket {
  type: 'join';
  role: 'player' | 'viewer';
  name?: string;
}

export interface PlayerListPacket {
  type: 'playerList';
  players: PlayerInfo[];
}

export interface VotePacket {
  type: 'vote';
  target: string;
}

export interface VoteResultPacket {
  type: 'voteResult';
  result: VoteEntry[];
}

export interface DisconnectPacket {
  type: 'disconnect';
}

export type Packet = JoinPacket | PlayerListPacket | VotePacket | VoteResultPacket | DisconnectPacket;

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null;
}

export function isPacket(data: unknown): data is Packet {
  if (!isRecord(data)) return false;
  if (typeof data.type !== 'string') return false;
  return true;
}
