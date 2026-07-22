import { DataConnection } from 'peerjs';
import { PeerBase, PeerBaseCallbacks } from './peer';
import { PlayerInfo, VoteEntry } from '../network/packet';
import { parseMessage, createJoinPacket, createVotePacket } from '../network/message';
import { getHostPeerId } from '../room/room';

export interface ViewerCallbacks extends PeerBaseCallbacks {
  onConnected: () => void;
  onPlayerListUpdate: (players: PlayerInfo[]) => void;
  onVoteResultUpdate: (results: VoteEntry[]) => void;
  onHostDisconnected: () => void;
}

export class ViewerPeer extends PeerBase {
  private viewerCallbacks: ViewerCallbacks;
  private roomCode: string;
  private hostConnection: DataConnection | null = null;
  private connectedFlag: boolean = false;

  constructor(roomCode: string, callbacks: ViewerCallbacks) {
    super(callbacks);
    this.roomCode = roomCode;
    this.viewerCallbacks = callbacks;
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

        conn.send(createJoinPacket('viewer'));

        conn.on('data', (data: unknown) => {
          this.handleData(data);
        });

        conn.on('close', () => {
          this.connectedFlag = false;
          this.hostConnection = null;
          this.viewerCallbacks.onHostDisconnected();
        });

        this.viewerCallbacks.onConnected();
        resolve();
      });

      conn.on('error', (err: Error) => {
        this.viewerCallbacks.onError(err.message);
        reject(err);
      });
    });
  }

  private handleData(data: unknown): void {
    const packet = parseMessage(data);
    if (packet === null) return;

    switch (packet.type) {
      case 'playerList':
        this.viewerCallbacks.onPlayerListUpdate(packet.players);
        break;
      case 'voteResult':
        this.viewerCallbacks.onVoteResultUpdate(packet.result);
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
    this.viewerCallbacks.onHostDisconnected();
  }

  vote(targetPeerId: string): void {
    if (this.hostConnection !== null && this.hostConnection.open) {
      this.hostConnection.send(createVotePacket(targetPeerId));
    }
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
