import QRCode from 'qrcode';
import { PlayerInfo, VoteEntry } from '../network/packet';
import { buildViewerUrl } from '../room/room';

export class HostUI {
  private container: HTMLElement;
  private roomCodeElement: HTMLElement;
  private qrContainer: HTMLElement;
  private playersListElement: HTMLElement;
  private playersCountElement: HTMLElement;
  private viewersCountElement: HTMLElement;
  private resultsElement: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.innerHTML = this.buildHTML();

    this.roomCodeElement = document.getElementById('host-room-code')!;
    this.qrContainer = document.getElementById('host-qr-code')!;
    this.playersListElement = document.getElementById('host-players')!;
    this.playersCountElement = document.getElementById('host-players-count')!;
    this.viewersCountElement = document.getElementById('host-viewers')!;
    this.resultsElement = document.getElementById('host-results')!;
  }

  private buildHTML(): string {
    return `
      <div class="host-view">
        <h1>Host Room</h1>
        <div class="room-code-section">
          <h2>Room Code</h2>
          <div id="host-room-code" class="room-code">---</div>
        </div>
        <div id="host-qr-code" class="qr-code"></div>
        <div class="players-section">
          <h2>Players (<span id="host-players-count">0</span>)</h2>
          <ul id="host-players"></ul>
        </div>
        <div class="viewers-section">
          <h2>Viewers: <span id="host-viewers">0</span></h2>
        </div>
        <div class="results-section">
          <h2>Vote Results</h2>
          <ul id="host-results"></ul>
        </div>
        <div id="host-status" class="status"></div>
      </div>
    `;
  }

  displayRoomCode(code: string, baseUrl: string): void {
    this.roomCodeElement.textContent = code;
    const viewerUrl = buildViewerUrl(baseUrl, code);
    QRCode.toCanvas(viewerUrl, { width: 200 })
      .then((canvas: HTMLCanvasElement) => {
        this.qrContainer.innerHTML = '';
        this.qrContainer.appendChild(canvas);
      })
      .catch(() => {
        this.qrContainer.innerHTML = '<p>QR generation failed</p>';
      });
  }

  updatePlayers(players: PlayerInfo[]): void {
    this.playersCountElement.textContent = String(players.length);
    this.playersListElement.innerHTML = players
      .map(p => `<li>${this.escapeHtml(p.name)}</li>`)
      .join('');
  }

  updateViewers(count: number): void {
    this.viewersCountElement.textContent = String(count);
  }

  updateResults(results: VoteEntry[]): void {
    this.resultsElement.innerHTML = results
      .map(
        r =>
          `<li class="result-item">${this.escapeHtml(r.name)}: ${r.voteCount} votes</li>`
      )
      .join('');
  }

  showError(message: string): void {
    const status = document.getElementById('host-status');
    if (status !== null) {
      status.textContent = message;
      status.className = 'status error';
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
