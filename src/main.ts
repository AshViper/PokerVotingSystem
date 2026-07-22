import { HostPeer, HostCallbacks } from './peer/host';
import { PlayerPeer, PlayerCallbacks } from './peer/player';
import { ViewerPeer, ViewerCallbacks } from './peer/viewer';
import { HostUI } from './ui/hostUI';
import { PlayerUI } from './ui/playerUI';
import { ViewerUI } from './ui/viewerUI';
import { generateRoomCode } from './room/room';
import { PlayerInfo, VoteEntry } from './network/packet';

const BASE_URL = window.location.origin + window.location.pathname;

type AppMode = 'host' | 'player' | 'viewer' | 'landing';

function getMode(): AppMode {
  const params = new URLSearchParams(window.location.search);
  if (params.has('host')) return 'host';
  const room = params.get('room');
  const type = params.get('type');
  if (room !== null && type === 'voter') return 'viewer';
  if (room !== null) return 'player';
  return 'landing';
}

async function startHost(): Promise<void> {
  const container = document.getElementById('app')!;
  const ui = new HostUI(container);

  for (let attempt = 0; attempt < 10; attempt++) {
    const roomCode = generateRoomCode();
    ui.displayRoomCode(roomCode, BASE_URL);

    const callbacks: HostCallbacks = {
      onError: (msg: string) => {
        console.error('Host error:', msg);
      },
      onReady: (_peerId: string) => {
        console.log('Host ready');
      },
      onPlayerJoined: (_player: PlayerInfo) => {
        ui.updatePlayers(host.getPlayers());
        ui.updateViewers(host.getViewerCount());
      },
      onPlayerLeft: (_peerId: string) => {
        ui.updatePlayers(host.getPlayers());
      },
      onViewerJoined: (_peerId: string) => {
        ui.updateViewers(host.getViewerCount());
      },
      onViewerLeft: (_peerId: string) => {
        ui.updateViewers(host.getViewerCount());
      },
      onVoteResultUpdated: (results: VoteEntry[]) => {
        ui.updateResults(results);
      },
    };

    const host = new HostPeer(roomCode, callbacks);
    try {
      await host.start();
      return;
    } catch {
      ui.showError(`Room code conflict, retrying... (${attempt + 1}/10)`);
    }
  }

  ui.showError('Failed to create room after multiple attempts');
}

function startPlayer(roomCode: string): void {
  const container = document.getElementById('app')!;
  const ui = new PlayerUI(container, (code: string, name: string) => {
    initializePlayerPeer(code, name, ui);
  });

  const roomInput = document.getElementById('player-room-code') as HTMLInputElement | null;
  if (roomInput !== null) {
    roomInput.value = roomCode;
  }
}

function initializePlayerPeer(
  roomCode: string,
  name: string,
  ui: PlayerUI
): void {
  const callbacks: PlayerCallbacks = {
    onError: (msg: string) => ui.showError(msg),
    onConnected: () => ui.showConnected(),
    onPlayerListUpdate: (_players: PlayerInfo[]) => {
      // Future game state can use this
    },
    onHostDisconnected: () => ui.showDisconnected(),
  };

  const player = new PlayerPeer(roomCode, name, callbacks);
  player.start().catch((err: Error) => {
    ui.showError('Connection failed: ' + err.message);
  });
}

function startViewer(roomCode: string): void {
  const container = document.getElementById('app')!;
  const ui = new ViewerUI(container, (targetPeerId: string) => {
    viewer.vote(targetPeerId);
  });

  const callbacks: ViewerCallbacks = {
    onError: (msg: string) => ui.showError(msg),
    onConnected: () => ui.showConnected(),
    onPlayerListUpdate: (players: PlayerInfo[]) => ui.updatePlayers(players),
    onVoteResultUpdate: (results: VoteEntry[]) => ui.updateResults(results),
    onHostDisconnected: () => ui.showDisconnected(),
  };

  const viewer = new ViewerPeer(roomCode, callbacks);
  viewer.start().catch((err: Error) => {
    ui.showError('Connection failed: ' + err.message);
  });
}

function startLanding(): void {
  const container = document.getElementById('app')!;
  container.innerHTML = `
    <div class="landing">
      <h1>P2P Voting System</h1>
      <button id="btn-create-room">Create Room</button>
      <hr />
      <h2>Join as Player</h2>
      <input type="text" id="landing-room-code" placeholder="Room Code" maxlength="6" autocomplete="off" />
      <input type="text" id="landing-player-name" placeholder="Your Name" autocomplete="off" />
      <button id="btn-join-player">Join</button>
    </div>
  `;

  document.getElementById('btn-create-room')!.addEventListener('click', () => {
    window.location.search = '?host=1';
  });

  document.getElementById('btn-join-player')!.addEventListener('click', () => {
    const roomInput = document.getElementById('landing-room-code') as HTMLInputElement;
    const nameInput = document.getElementById('landing-player-name') as HTMLInputElement;
    const roomCode = roomInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    if (roomCode.length > 0 && name.length > 0) {
      window.location.search = `?room=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(name)}`;
    }
  });
}

function main(): void {
  const mode = getMode();
  switch (mode) {
    case 'host':
      startHost();
      break;
    case 'player': {
      const params = new URLSearchParams(window.location.search);
      const roomCode = params.get('room') ?? '';
      startPlayer(roomCode);
      break;
    }
    case 'viewer': {
      const params = new URLSearchParams(window.location.search);
      const roomCode = params.get('room') ?? '';
      startViewer(roomCode);
      break;
    }
    case 'landing':
      startLanding();
      break;
  }
}

main();
