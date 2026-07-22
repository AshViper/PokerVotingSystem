export class PlayerUI {
  private container: HTMLElement;
  private onJoin: (roomCode: string, name: string) => void;

  constructor(container: HTMLElement, onJoin: (roomCode: string, name: string) => void) {
    this.container = container;
    this.onJoin = onJoin;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="player-view">
        <h1>Join as Player</h1>
        <div class="join-form">
          <input type="text" id="player-room-code" placeholder="Room Code" maxlength="6" autocomplete="off" />
          <input type="text" id="player-name" placeholder="Your Name" autocomplete="off" />
          <button id="player-join-btn">Join</button>
        </div>
        <div id="player-status" class="status"></div>
      </div>
    `;

    document.getElementById('player-join-btn')!.addEventListener('click', () => {
      const roomInput = document.getElementById('player-room-code') as HTMLInputElement;
      const nameInput = document.getElementById('player-name') as HTMLInputElement;
      const roomCode = roomInput.value.trim().toUpperCase();
      const name = nameInput.value.trim();
      if (roomCode.length > 0 && name.length > 0) {
        this.onJoin(roomCode, name);
      }
    });
  }

  showConnected(): void {
    const status = document.getElementById('player-status');
    if (status !== null) {
      status.textContent = 'Connected! Waiting for game...';
      status.className = 'status connected';
    }
  }

  showError(message: string): void {
    const status = document.getElementById('player-status');
    if (status !== null) {
      status.textContent = message;
      status.className = 'status error';
    }
  }

  showDisconnected(): void {
    const status = document.getElementById('player-status');
    if (status !== null) {
      status.textContent = 'Disconnected from host';
      status.className = 'status error';
    }
  }
}
