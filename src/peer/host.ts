import { DataConnection } from 'peerjs';
import { PeerBase, PeerBaseCallbacks } from './peer';
import { PlayerInfo, VoteEntry, Packet } from '../network/packet';
import { parseMessage, createPlayerListPacket, createVoteResultPacket } from '../network/message';
import { VoteManager } from '../vote/voteManager';
import { getHostPeerId } from '../room/room';

export interface HostCallbacks extends PeerBaseCallbacks {
  onReady: (peerId: string) => void;
  onPlayerJoined: (player: PlayerInfo) => void;
  onPlayerLeft: (peerId: string) => void;
  onViewerJoined: (peerId: string) => void;
  onViewerLeft: (peerId: string) => void;
  onVoteResultUpdated: (results: VoteEntry[]) => void;
}

export class HostPeer extends PeerBase {
  private hostCallbacks: HostCallbacks;
  private connections: Map<string, DataConnection> = new Map();
  private players: Map<string, PlayerInfo> = new Map();
  private viewers: Set<string> = new Set();
  private voteManager: VoteManager = new VoteManager();
  private roomCode: string;

  constructor(roomCode: string, callbacks: HostCallbacks) {
    super(callbacks);
    this.roomCode = roomCode;
    this.hostCallbacks = callbacks;
  }

  async start(): Promise<void> {
    const peerId = getHostPeerId(this.roomCode);
    await this.createPeer(peerId);
    this.setupConnectionHandler();
    this.hostCallbacks.onReady(peerId);
  }

  private setupConnectionHandler(): void {
    if (this.peerInstance === null) return;

    this.peerInstance.on('connection', (conn: DataConnection) => {
      this.handleNewConnection(conn);
    });
  }

  private handleNewConnection(conn: DataConnection): void {
    const remoteId = conn.peer;

    if (conn.open) {
      this.registerConnection(conn, remoteId);
    } else {
      conn.on('open', () => {
        this.registerConnection(conn, remoteId);
      });
    }

    conn.on('error', () => {
      this.handleDisconnect(remoteId);
    });
  }

  private registerConnection(conn: DataConnection, remoteId: string): void {
    this.connections.set(remoteId, conn);

    conn.on('data', (data: unknown) => {
      this.handleData(remoteId, data);
    });

    conn.on('close', () => {
      this.handleDisconnect(remoteId);
    });
  }

  private handleData(remoteId: string, data: unknown): void {
    const packet = parseMessage(data);
    if (packet === null) return;

    switch (packet.type) {
      case 'join':
        this.handleJoin(remoteId, packet);
        break;
      case 'vote':
        this.handleVote(remoteId, packet);
        break;
      case 'disconnect':
        this.handleDisconnect(remoteId);
        break;
      default:
        break;
    }
  }

  private handleJoin(remoteId: string, packet: Packet & { type: 'join' }): void {
    if (packet.role === 'player' && packet.name !== undefined) {
      const player: PlayerInfo = { peerId: remoteId, name: packet.name };
      this.players.set(remoteId, player);
      this.hostCallbacks.onPlayerJoined(player);
      this.synchronizePlayerList();
    } else if (packet.role === 'viewer') {
      this.viewers.add(remoteId);
      this.hostCallbacks.onViewerJoined(remoteId);
      this.sendPlayerList(remoteId);
    }
  }

  private handleVote(remoteId: string, packet: Packet & { type: 'vote' }): void {
    if (!this.viewers.has(remoteId)) return;

    const results = this.voteManager.processVote(remoteId, packet.target);
    this.hostCallbacks.onVoteResultUpdated(results);
    this.broadcastToViewers(createVoteResultPacket(results));
  }

  private handleDisconnect(remoteId: string): void {
    const connection = this.connections.get(remoteId);
    if (connection !== undefined) {
      connection.close();
      this.connections.delete(remoteId);
    }

    if (this.players.has(remoteId)) {
      this.players.delete(remoteId);
      this.hostCallbacks.onPlayerLeft(remoteId);
      this.synchronizePlayerList();
    }

    if (this.viewers.has(remoteId)) {
      this.viewers.delete(remoteId);
      this.hostCallbacks.onViewerLeft(remoteId);
      const results = this.voteManager.removeViewer(remoteId);
      this.hostCallbacks.onVoteResultUpdated(results);
      this.broadcastToViewers(createVoteResultPacket(results));
    }
  }

  private synchronizePlayerList(): void {
    const playerList = Array.from(this.players.values());
    this.voteManager.setPlayers(playerList);
    const packet = createPlayerListPacket(playerList);
    this.broadcastToViewers(packet);
  }

  private sendPlayerList(targetId: string): void {
    const playerList = Array.from(this.players.values());
    const packet = createPlayerListPacket(playerList);
    this.sendTo(targetId, packet);
  }

  private broadcastToViewers(packet: Packet): void {
    for (const viewerId of this.viewers) {
      this.sendTo(viewerId, packet);
    }
  }

  private sendTo(targetId: string, data: unknown): void {
    const conn = this.connections.get(targetId);
    if (conn !== undefined && conn.open) {
      conn.send(data);
    }
  }

  getPlayers(): PlayerInfo[] {
    return Array.from(this.players.values());
  }

  getViewerCount(): number {
    return this.viewers.size;
  }

  getVoteResults(): VoteEntry[] {
    return this.voteManager.getResults();
  }

  destroy(): void {
    for (const [, conn] of this.connections) {
      if (conn.open) {
        conn.send({ type: 'disconnect' });
      }
    }
    this.connections.clear();
    this.players.clear();
    this.viewers.clear();
    this.voteManager.clear();
    super.destroy();
  }
}
