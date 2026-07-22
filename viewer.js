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
    '  <h1>🏆 Tournament Spectator</h1>',
    '  <div id="tournament-status-bar" class="status"></div>',
    '  <div id="tournament-info" class="card"></div>',
    '  <div class="card">',
    '    <div class="card-header"><div class="section-label">🏆 Rankings</div></div>',
    '    <table id="viewer-ranking" style="width:100%">',
    '      <tr><th>#</th><th>Name</th><th>Points</th><th>Prediction</th></tr>',
    '    </table>',
    '  </div>',
    '  <div class="card">',
    '    <div class="card-header"><div class="section-label">⚔️ Live Match</div></div>',
    '    <div id="live-match-info" class="subtitle" style="margin-bottom:0">Waiting for match...</div>',
    '  </div>',
    '  <div class="card">',
    '    <div class="card-header"><div class="section-label">📊 Bet Summary</div></div>',
    '    <div id="viewer-bet-summary"></div>',
    '  </div>',
    '  <div class="card">',
    '    <div class="card-header"><div class="section-label">🗳️ Vote on Players</div></div>',
    '    <div class="player-list" id="viewer-players"></div>',
    '    <button id="viewer-vote-btn" class="btn btn-primary btn-block" style="margin-top:0.75rem" disabled>Vote</button>',
    '    <div id="viewer-results"></div>',
    '  </div>',
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
    var statusText = state.status === 'idle' ? '待機中' : state.status === 'predicting' ? '優勝予想受付中' : state.status === 'inProgress' ? '大会進行中' : state.status === 'finished' ? '大会終了' : state.status;
    infoEl.innerHTML = '<p style="color:var(--text-secondary);margin-bottom:0">ステータス: <strong style="color:var(--text-primary)">' + statusText + '</strong></p>';
  }
  var statusBar = document.getElementById('tournament-status-bar');
  if (statusBar) {
    statusBar.textContent = '🏆 Tournament: ' + statusText;
    statusBar.className = 'status status-info';
  }
  if (rankings) this.updateRanking(rankings);
  this.updateLiveMatch(state);
};
ViewerUI.prototype.updateRanking = function (rankings) {
  var table = document.getElementById('viewer-ranking');
  if (!table) return;
  table.innerHTML = '<tr><th>#</th><th>Name</th><th>Points</th><th>Prediction</th></tr>' +
    rankings.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + ViewerUI.escapeHtml(r.name) + '</td><td style="font-weight:700;color:var(--accent-gold)">' + r.points + 'P</td><td style="color:var(--text-secondary);font-size:0.85rem">' + ViewerUI.escapeHtml(r.champPredictName || '-') + '</td></tr>';
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
    el.innerHTML = state.status === 'finished' ? '<span style="color:var(--accent-green)">🏆 Tournament finished!</span>' : '<span style="color:var(--text-muted)">No active match.</span>';
    return;
  }
  var p1Name = ViewerUI.getPlayerName(state.matchPlayers, activeMatch.player1Id);
  var p2Name = ViewerUI.getPlayerName(state.matchPlayers, activeMatch.player2Id);
  var html = '<div class="matchup" style="margin:0 0 0.5rem;padding:0.75rem">';
  html += '<span class="name">' + ViewerUI.escapeHtml(p1Name) + '</span><span class="vs">VS</span><span class="name">' + ViewerUI.escapeHtml(p2Name) + '</span>';
  html += '</div>';
  html += '<div class="status ' + (activeMatch.votingOpen ? 'status-success' : 'status-error') + '" style="margin-bottom:0">';
  html += activeMatch.votingOpen ? '🟢 投票受付中' : '🔴 投票終了';
  html += '</div>';
  if (activeMatch.winner) {
    html += '<div class="status status-success" style="margin-top:0.5rem;margin-bottom:0">🏆 Winner: <strong>' + ViewerUI.escapeHtml(ViewerUI.getPlayerName(state.matchPlayers, activeMatch.winner)) + '</strong></div>';
  }
  el.innerHTML = html;

  // ベット集計（簡易）
  var betEl = document.getElementById('viewer-bet-summary');
  if (betEl) {
    betEl.innerHTML = '<p style="color:var(--text-muted);margin-bottom:0">ベット詳細はホスト画面をご確認ください。</p>';
  }
};
ViewerUI.prototype.updatePlayers = function (players) {
  var list = document.getElementById('viewer-players');
  if (list === null) return;
  if (players.length === 0) { list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:0.5rem;margin-bottom:0">No players yet</p>'; return; }
  var self = this;
  list.innerHTML = players.map(function (p) {
    return '<div class="player-card" data-player="' + p.peerId + '" style="cursor:pointer;margin-bottom:0.5rem">' +
      '<div class="player-card-name" style="margin-bottom:0">' + ViewerUI.escapeHtml(p.name) + '</div>' +
      '<div class="player-card-status">Select</div></div>';
  }).join('');
  list.querySelectorAll('.player-card').forEach(function (card) {
    card.addEventListener('click', function () {
      list.querySelectorAll('.player-card').forEach(function (x) { x.classList.remove('selected'); });
      card.classList.add('selected');
      self.selectedPlayer = card.dataset.player;
      document.getElementById('viewer-vote-btn').disabled = false;
    });
  });
};
ViewerUI.prototype.updateResults = function (results) {
  var resultsDiv = document.getElementById('viewer-results');
  if (resultsDiv === null) return;
  resultsDiv.innerHTML = '<div class="section-label" style="margin-top:0.75rem">📊 投票結果</div>' + results.map(function (r) {
    return '<div class="status status-info" style="margin-bottom:0.35rem;justify-content:space-between">' +
      '<span>' + ViewerUI.escapeHtml(r.name) + '</span>' +
      '<span style="font-weight:800;color:var(--accent-blue)">' + r.voteCount + ' 票</span></div>';
  }).join('');
};
ViewerUI.prototype.showConnected = function () {
  var status = document.getElementById('viewer-status');
  if (status !== null) { status.textContent = '✅ 接続完了'; status.className = 'status status-success'; }
};
ViewerUI.prototype.showError = function (message) {
  var status = document.getElementById('viewer-status');
  if (status !== null) { status.textContent = message; status.className = 'status status-error'; }
};
ViewerUI.prototype.showDisconnected = function () {
  var status = document.getElementById('viewer-status');
  if (status !== null) { status.textContent = '⚠️ ホストとの接続が切断されました'; status.className = 'status status-error'; }
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
  document.getElementById('app').innerHTML = '<div style="text-align:center;padding:3rem 1rem"><h1 style="margin-bottom:1rem">⚠️ Error</h1><p style="color:var(--text-secondary)">No room code specified. Open from the QR code or add <code style="color:var(--accent-cyan)">?room=CODE</code> to the URL.</p></div>';
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
