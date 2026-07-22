import Peer from 'peerjs';

export interface PeerBaseCallbacks {
  onError: (message: string) => void;
}

export abstract class PeerBase {
  protected peerInstance: Peer | null = null;
  protected callbacks: PeerBaseCallbacks;

  constructor(callbacks: PeerBaseCallbacks) {
    this.callbacks = callbacks;
  }

  protected async createPeer(id?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      try {
        const p = id !== undefined ? new Peer(id) : new Peer();

        p.on('open', (assignedId: string) => {
          this.peerInstance = p;
          resolve(assignedId);
        });

        p.on('error', (err: Error) => {
          if (this.peerInstance !== null) {
            this.callbacks.onError(err.message);
          }
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  destroy(): void {
    if (this.peerInstance !== null) {
      this.peerInstance.destroy();
      this.peerInstance = null;
    }
  }

  get peerId(): string | null {
    return this.peerInstance?.id ?? null;
  }

  abstract start(): Promise<void>;
}
