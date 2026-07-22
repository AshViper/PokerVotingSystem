import { PlayerInfo, VoteEntry } from '../network/packet';

export class VoteManager {
  private votes: Map<string, string> = new Map();
  private players: Map<string, string> = new Map();

  setPlayers(players: PlayerInfo[]): void {
    this.players.clear();
    for (const p of players) {
      this.players.set(p.peerId, p.name);
    }
  }

  processVote(viewerPeerId: string, targetPeerId: string): VoteEntry[] {
    const previousTarget = this.votes.get(viewerPeerId);
    if (previousTarget === targetPeerId) {
      return this.getResults();
    }
    this.votes.set(viewerPeerId, targetPeerId);
    return this.getResults();
  }

  removeViewer(viewerPeerId: string): VoteEntry[] {
    this.votes.delete(viewerPeerId);
    return this.getResults();
  }

  getResults(): VoteEntry[] {
    const voteCounts = new Map<string, number>();
    for (const [peerId] of this.players) {
      voteCounts.set(peerId, 0);
    }
    for (const target of this.votes.values()) {
      voteCounts.set(target, (voteCounts.get(target) ?? 0) + 1);
    }
    const results: VoteEntry[] = [];
    for (const [peerId, count] of voteCounts) {
      const name = this.players.get(peerId) ?? 'Unknown';
      results.push({ peerId, name, voteCount: count });
    }
    results.sort((a, b) => b.voteCount - a.voteCount);
    return results;
  }

  clear(): void {
    this.votes.clear();
  }
}
