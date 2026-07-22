// ===== パケットユーティリティ =====
function isRecord(data) { return typeof data === 'object' && data !== null; }
function isPacket(data) {
  if (!isRecord(data)) return false;
  if (typeof data.type !== 'string') return false;
  return true;
}
function parseMessage(data) { if (!isPacket(data)) return null; return data; }
function createJoinPacket(role, name) {
  if (role === 'player' && name) { return { type: 'join', role: 'player', name: name }; }
  return { type: 'join', role: 'viewer' };
}
function createVotePacket(target) { return { type: 'vote', target: target }; }

// ===== ルームユーティリティ =====
function getHostPeerId(roomCode) { return 'poker-' + roomCode; }

// ===== PeerBase =====
function PeerBase(callbacks) { this.peerInstance = null; this.callbacks = callbacks; }
PeerBase.prototype.createPeer = function (id) {
  var self = this;
  return new Promise(function (resolve, reject) {
    try {
      var p = id !== undefined ? new Peer(id) : new Peer();
      p.on('open', function (assignedId) { self.peerInstance = p; resolve(assignedId); });
      p.on('error', function (err) {
        if (self.peerInstance !== null) self.callbacks.onError(err.message);
        reject(err);
      });
    } catch (err) { reject(err); }
  });
};
PeerBase.prototype.destroy = function () {
  if (this.peerInstance !== null) { this.peerInstance.destroy(); this.peerInstance = null; }
};
Object.defineProperty(PeerBase.prototype, 'peerId', {
  get: function () { return this.peerInstance ? this.peerInstance.id : null; }
});

// ===== ViewerPeer =====
function ViewerPeer(roomCode, callbacks) {
  PeerBase.call(this, callbacks);
  this.viewerCallbacks = callbacks;
  this.roomCode = roomCode;
  this.hostConnection = null;
  this.connectedFlag = false;
  this.tournamentState = null;
  this.rankings = [];
}
ViewerPeer.prototype = Object.create(PeerBase.prototype);
ViewerPeer.prototype.constructor = ViewerPeer;

ViewerPeer.prototype.start = function () {
  var self = this;
  return this.createPeer().then(function () { return self.connectToHost(); });
};
ViewerPeer.prototype.connectToHost = function () {
  var self = this;
  if (this.peerInstance === null) { return Promise.reject(new Error('Peer not initialized')); }
  var hostId = getHostPeerId(this.roomCode);
  return new Promise(function (resolve, reject) {
    var conn = self.peerInstance.connect(hostId);
    conn.on('open', function () {
      self.hostConnection = conn; self.connectedFlag = true;
      conn.send(createJoinPacket('viewer'));
      conn.on('data', function (data) { self.handleData(data); });
      conn.on('close', function () {
        self.connectedFlag = false; self.hostConnection = null;
        self.viewerCallbacks.onHostDisconnected();
      });
      self.viewerCallbacks.onConnected();
      resolve();
    });
    conn.on('error', function (err) { self.viewerCallbacks.onError(err.message); reject(err); });
  });
};
ViewerPeer.prototype.handleData = function (data) {
  var packet = parseMessage(data);
  if (packet === null) return;
  switch (packet.type) {
    case 'playerList': this.viewerCallbacks.onPlayerListUpdate(packet.players); break;
    case 'voteResult': this.viewerCallbacks.onVoteResultUpdate(packet.result); break;
    case 'disconnect': this.handleHostDisconnect(); break;
    case 'tournamentState':
      this.tournamentState = packet.state;
      this.viewerCallbacks.onTournamentState(this.tournamentState);
      break;
    case 'ranking':
      this.rankings = packet.rankings;
      this.viewerCallbacks.onRankingUpdate(this.rankings);
      break;
  }
};
ViewerPeer.prototype.vote = function (targetPeerId) {
  if (this.hostConnection !== null && this.hostConnection.open) {
    this.hostConnection.send(createVotePacket(targetPeerId));
  }
};
ViewerPeer.prototype.handleHostDisconnect = function () {
  this.connectedFlag = false;
  if (this.hostConnection !== null) { this.hostConnection.close(); this.hostConnection = null; }
  this.viewerCallbacks.onHostDisconnected();
};
Object.defineProperty(ViewerPeer.prototype, 'connected', { get: function () { return this.connectedFlag; } });
ViewerPeer.prototype.destroy = function () {
  if (this.hostConnection !== null && this.hostConnection.open) {
    this.hostConnection.send({ type: 'disconnect' }); this.hostConnection.close();
  }
  this.hostConnection = null; this.connectedFlag = false;
  PeerBase.prototype.destroy.call(this);
};

// ===== ViewerUI =====
function ViewerUI(container, onVote) {
  this.container = container;
  this.onVote = onVote;
  this.selectedPlayer = null;
  this.render();
}
ViewerUI.prototype.render = function () {
  var self = this;
  this.container.innerHTML = [
    '<div class="viewer-view">',
    '  <h1>Tournament Spectator</h1>',
    '  <div id="tournament-status-bar" class="status"></div>',
    '  <div id="tournament-info"></div>',
    '  <h2>Rankings</h2>',
    '  <table id="viewer-ranking" style="width:100%;margin-bottom:16px">',
    '    <tr><th>#</th><th>Name</th><th>Points</th></tr>',
    '  </table>',
    '  <h2>Live Match</h2>',
    '  <div id="live-match-info">Waiting for match...</div>',
    '  <h2>Bet Summary</h2>',
    '  <div id="viewer-bet-summary"></div>',
    '  <hr/>',
    '  <h2>Vote on Players</h2>',
    '  <div class="player-list" id="viewer-players"></div>',
    '  <button id="viewer-vote-btn" disabled>Vote</button>',
    '  <div id="viewer-results"></div>',
    '  <div id="viewer-status" class="status"></div>',
    '</div>'
  ].join('');

  document.getElementById('viewer-vote-btn').addEventListener('click', function () {
    if (self.selectedPlayer !== null) { self.onVote(self.selectedPlayer); }
  });
};
ViewerUI.prototype.updateTournamentState = function (state, rankings) {
  var infoEl = document.getElementById('tournament-info');
  if (infoEl) {
    infoEl.innerHTML = '<p>Status: <strong>' + state.status + '</strong></p>';
  }
  var statusBar = document.getElementById('tournament-status-bar');
  if (statusBar) {
    statusBar.textContent = 'Tournament: ' + state.status;
    statusBar.className = 'status connected';
  }
  if (rankings) this.updateRanking(rankings);
  this.updateLiveMatch(state);
};
ViewerUI.prototype.updateRanking = function (rankings) {
  var table = document.getElementById('viewer-ranking');
  if (!table) return;
  table.innerHTML = '<tr><th>#</th><th>Name</th><th>Points</th></tr>' +
    rankings.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + ViewerUI.escapeHtml(r.name) + '</td><td>' + r.points + '</td></tr>';
    }).join('');
};
ViewerUI.prototype.updateLiveMatch = function (state) {
  var el = document.getElementById('live-match-info');
  if (!el) return;
  var matches = state.matches || [];
  var activeMatch = null;
  for (var i = 0; i < matches.length; i++) {
    if (matches[i].votingOpen || (!matches[i].winner && matches[i].votingOpen === false)) {
      activeMatch = matches[i];
      break;
    }
  }
  if (!activeMatch) {
    el.innerHTML = state.status === 'finished' ? '<p>Tournament finished!</p>' : '<p>No active match.</p>';
    return;
  }
  var p1Name = ViewerUI.getPlayerName(state.matchPlayers, activeMatch.player1Id);
  var p2Name = ViewerUI.getPlayerName(state.matchPlayers, activeMatch.player2Id);
  var html = '<p><strong>' + ViewerUI.escapeHtml(p1Name) + ' vs ' + ViewerUI.escapeHtml(p2Name) + '</strong></p>';
  html += '<p>Voting: ' + (activeMatch.votingOpen ? '<span style="color:#2ecc71">OPEN</span>' : '<span style="color:#e74c3c">CLOSED</span>') + '</p>';
  if (activeMatch.winner) {
    html += '<p>Winner: <strong>' + ViewerUI.escapeHtml(ViewerUI.getPlayerName(state.matchPlayers, activeMatch.winner)) + '</strong></p>';
  }
  el.innerHTML = html;

  // ベット集計（簡易）
  var betEl = document.getElementById('viewer-bet-summary');
  if (betEl && state.bets) {
    // Note: bet summary is not in state broadcast; master has it
    betEl.innerHTML = '<p>Check master screen for bet details.</p>';
  }
};
ViewerUI.prototype.updatePlayers = function (players) {
  var list = document.getElementById('viewer-players');
  if (list === null) return;
  if (players.length === 0) { list.innerHTML = '<p>No players yet</p>'; return; }
  var self = this;
  list.innerHTML = players.map(function (p) {
    return '<label class="player-option"><input type="radio" name="vote-target" value="' + p.peerId + '" /> ' + ViewerUI.escapeHtml(p.name) + '</label>';
  }).join('');
  list.querySelectorAll('input[name="vote-target"]').forEach(function (input) {
    input.addEventListener('change', function (e) {
      self.selectedPlayer = e.target.value;
      document.getElementById('viewer-vote-btn').disabled = false;
    });
  });
};
ViewerUI.prototype.updateResults = function (results) {
  var resultsDiv = document.getElementById('viewer-results');
  if (resultsDiv === null) return;
  resultsDiv.innerHTML = '<h2>Vote Results</h2>' + results.map(function (r) {
    return '<div class="result-item">' + ViewerUI.escapeHtml(r.name) + ': ' + r.voteCount + '</div>';
  }).join('');
};
ViewerUI.prototype.showConnected = function () {
  var status = document.getElementById('viewer-status');
  if (status !== null) { status.textContent = 'Connected!'; status.className = 'status connected'; }
};
ViewerUI.prototype.showError = function (message) {
  var status = document.getElementById('viewer-status');
  if (status !== null) { status.textContent = message; status.className = 'status error'; }
};
ViewerUI.prototype.showDisconnected = function () {
  var status = document.getElementById('viewer-status');
  if (status !== null) { status.textContent = 'Disconnected from host'; status.className = 'status error'; }
  var btn = document.getElementById('viewer-vote-btn');
  if (btn !== null) btn.disabled = true;
};
ViewerUI.escapeHtml = function (text) { var div = document.createElement('div'); div.textContent = text; return div.innerHTML; };
ViewerUI.getPlayerName = function (players, id) {
  if (!id) return '-';
  for (var i = 0; i < players.length; i++) { if (players[i].id === id) return players[i].name; }
  return id;
};

// ===== メイン処理 =====
var params = new URLSearchParams(window.location.search);
var roomCode = params.get('room') || '';

if (roomCode.length === 0) {
  document.getElementById('app').innerHTML = '<h1>Error</h1><p>No room code specified. Open from the QR code or add <code>?room=CODE</code> to the URL.</p>';
} else {
  var container = document.getElementById('app');
  var viewerPeer = null;
  var ui = new ViewerUI(container, function (targetPeerId) {
    if (viewerPeer !== null) { viewerPeer.vote(targetPeerId); }
  });

  var callbacks = {
    onError: function (msg) { ui.showError(msg); },
    onConnected: function () { ui.showConnected(); },
    onPlayerListUpdate: function (players) { ui.updatePlayers(players); },
    onVoteResultUpdate: function (results) { ui.updateResults(results); },
    onHostDisconnected: function () { ui.showDisconnected(); },
    onTournamentState: function (state) {
      ui.updateTournamentState(state, viewerPeer.rankings);
    },
    onRankingUpdate: function (rankings) {
      ui.updateTournamentState(viewerPeer.tournamentState, rankings);
    }
  };

  viewerPeer = new ViewerPeer(roomCode, callbacks);
  viewerPeer.start().catch(function (err) { ui.showError('Connection failed: ' + err.message); });
}
