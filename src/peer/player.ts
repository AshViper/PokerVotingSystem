import { DataConnection } from 'peerjs';
import { PeerBase, PeerBaseCallbacks } from './peer';
import { PlayerInfo } from '../network/packet';
import { parseMessage, createJoinPacket } from '../network/message';
import { getHostPeerId } from '../room/room';

export interface PlayerCallbacks extends PeerBaseCallbacks {
  onConnected: () => void;
  onPlayerListUpdate: (players: PlayerInfo[]) => void;
  onHostDisconnected: () => void;
}

export class PlayerPeer extends PeerBase {
  private playerCallbacks: PlayerCallbacks;
  private roomCode: string;
  private playerName: string;
  private hostConnection: DataConnection | null = null;
  private connectedFlag: boolean = false;

  constructor(roomCode: string, name: string, callbacks: PlayerCallbacks) {
    super(callbacks);
    this.roomCode = roomCode;
    this.playerName = name;
    this.playerCallbacks = callbacks;
  }

  async start(): Promise<void> {
    await this.createPeer();
    await this.connectToHost();
  }

  private connectToHost(): Promise<void> {
    if (this.peerInstance === null) {
      return Promise.reject(new Error('Peer not initialized'));
    }

    const hostId = getHostPeerId(this.roomCode);

    return new Promise<void>((resolve, reject) => {
      const conn = this.peerInstance!.connect(hostId);

      conn.on('open', () => {
        this.hostConnection = conn;
        this.connectedFlag = true;

        conn.send(createJoinPacket('player', this.playerName));

        conn.on('data', (data: unknown) => {
          this.handleData(data);
        });

        conn.on('close', () => {
          this.connectedFlag = false;
          this.hostConnection = null;
          this.playerCallbacks.onHostDisconnected();
        });

        this.playerCallbacks.onConnected();
        resolve();
      });

      conn.on('error', (err: Error) => {
        this.playerCallbacks.onError(err.message);
        reject(err);
      });
    });
  }

  private handleData(data: unknown): void {
    const packet = parseMessage(data);
    if (packet === null) return;

    switch (packet.type) {
      case 'playerList':
        this.playerCallbacks.onPlayerListUpdate(packet.players);
        break;
      case 'disconnect':
        this.handleHostDisconnect();
        break;
      default:
        break;
    }
  }

  private handleHostDisconnect(): void {
    this.connectedFlag = false;
    if (this.hostConnection !== null) {
      this.hostConnection.close();
      this.hostConnection = null;
    }
    this.playerCallbacks.onHostDisconnected();
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  destroy(): void {
    if (this.hostConnection !== null && this.hostConnection.open) {
      this.hostConnection.send({ type: 'disconnect' });
      this.hostConnection.close();
    }
    this.hostConnection = null;
    this.connectedFlag = false;
    super.destroy();
  }
}
