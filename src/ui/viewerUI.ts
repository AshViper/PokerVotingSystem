import { PlayerInfo, VoteEntry } from '../network/packet';

export class ViewerUI {
  private container: HTMLElement;
  private onVote: (targetPeerId: string) => void;
  private selectedPlayer: string | null = null;

  constructor(container: HTMLElement, onVote: (targetPeerId: string) => void) {
    this.container = container;
    this.onVote = onVote;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="viewer-view">
        <h1>Vote</h1>
        <div class="player-list" id="viewer-players"></div>
        <button id="viewer-vote-btn" disabled>Vote</button>
        <div id="viewer-results"></div>
        <div id="viewer-status" class="status"></div>
      </div>
    `;

    document.getElementById('viewer-vote-btn')!.addEventListener('click', () => {
      if (this.selectedPlayer !== null) {
        this.onVote(this.selectedPlayer);
      }
    });
  }

  updatePlayers(players: PlayerInfo[]): void {
    const list = document.getElementById('viewer-players');
    if (list === null) return;

    if (players.length === 0) {
      list.innerHTML = '<p>No players yet</p>';
      return;
    }

    list.innerHTML = players
      .map(
        p => `
      <label class="player-option">
        <input type="radio" name="vote-target" value="${p.peerId}" />
        ${this.escapeHtml(p.name)}
      </label>`
      )
      .join('');

    list.querySelectorAll('input[name="vote-target"]').forEach(input => {
      input.addEventListener('change', (e: Event) => {
        this.selectedPlayer = (e.target as HTMLInputElement).value;
        const btn = document.getElementById('viewer-vote-btn') as HTMLButtonElement;
        btn.disabled = false;
      });
    });
  }

  updateResults(results: VoteEntry[]): void {
    const resultsDiv = document.getElementById('viewer-results');
    if (resultsDiv === null) return;

    resultsDiv.innerHTML =
      '<h2>Results</h2>' +
      results
        .map(
          r =>
            `<div class="result-item">${this.escapeHtml(r.name)}: ${r.voteCount}</div>`
        )
        .join('');
  }

  showConnected(): void {
    const status = document.getElementById('viewer-status');
    if (status !== null) {
      status.textContent = 'Connected!';
      status.className = 'status connected';
    }
  }

  showError(message: string): void {
    const status = document.getElementById('viewer-status');
    if (status !== null) {
      status.textContent = message;
      status.className = 'status error';
    }
  }

  showDisconnected(): void {
    const status = document.getElementById('viewer-status');
    if (status !== null) {
      status.textContent = 'Disconnected from host';
      status.className = 'status error';
    }
    const btn = document.getElementById('viewer-vote-btn') as HTMLButtonElement | null;
    if (btn !== null) {
      btn.disabled = true;
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
