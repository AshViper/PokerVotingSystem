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
function createChampionshipPredictPacket(target) { return { type: 'championshipPredict', target: target }; }
function createBetPacket(matchId, target, points) { return { type: 'bet', matchId: matchId, target: target, points: points }; }

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

// ===== PlayerPeer =====
function PlayerPeer(roomCode, name, callbacks) {
  PeerBase.call(this, callbacks);
  this.playerCallbacks = callbacks;
  this.roomCode = roomCode;
  this.playerName = name;
  this.hostConnection = null;
  this.connectedFlag = false;
  // 大会状態
  this.tournamentState = null;
  this.rankings = [];
  this.myInfo = null;       // 自分の参加者情報
  this.champPredicted = false;
  this.hasBetForMatch = {}; // matchId → true/false
}
PlayerPeer.prototype = Object.create(PeerBase.prototype);
PlayerPeer.prototype.constructor = PlayerPeer;

PlayerPeer.prototype.start = function () {
  var self = this;
  return this.createPeer().then(function () { return self.connectToHost(); });
};
PlayerPeer.prototype.connectToHost = function () {
  var self = this;
  if (this.peerInstance === null) { return Promise.reject(new Error('Peer not initialized')); }
  var hostId = getHostPeerId(this.roomCode);
  return new Promise(function (resolve, reject) {
    var conn = self.peerInstance.connect(hostId);
    conn.on('open', function () {
      self.hostConnection = conn;
      self.connectedFlag = true;
      conn.send(createJoinPacket('player', self.playerName));
      conn.on('data', function (data) { self.handleData(data); });
      conn.on('close', function () {
        self.connectedFlag = false; self.hostConnection = null;
        self.playerCallbacks.onHostDisconnected();
      });
      self.playerCallbacks.onConnected();
      resolve();
    });
    conn.on('error', function (err) { self.playerCallbacks.onError(err.message); reject(err); });
  });
};
PlayerPeer.prototype.handleData = function (data) {
  var packet = parseMessage(data);
  if (packet === null) return;
  switch (packet.type) {
    case 'playerList': this.playerCallbacks.onPlayerListUpdate(packet.players); break;
    case 'disconnect': this.handleHostDisconnect(); break;
    case 'tournamentState':
      this.tournamentState = packet.state;
      this.playerCallbacks.onTournamentState(this.tournamentState);
      break;
    case 'ranking':
      this.rankings = packet.rankings;
      this.playerCallbacks.onRankingUpdate(this.rankings);
      break;
    case 'champPredictAck':
      this.champPredicted = packet.ok;
      if (packet.ok) { this.playerCallbacks.onChampPredictAck(true); }
      else { this.playerCallbacks.onError('Championship prediction failed'); }
      break;
    case 'betAck':
      if (packet.ok) { this.playerCallbacks.onBetAck(true); }
      else { this.playerCallbacks.onError('Bet failed: ' + packet.reason); }
      break;
  }
};
// 優勝予想を送信
PlayerPeer.prototype.sendChampPredict = function (targetPlayerId) {
  if (this.hostConnection !== null && this.hostConnection.open) {
    this.hostConnection.send(createChampionshipPredictPacket(targetPlayerId));
  }
};
// ベットを送信
PlayerPeer.prototype.sendBet = function (matchId, targetPlayerId, points) {
  if (this.hostConnection !== null && this.hostConnection.open) {
    this.hostConnection.send(createBetPacket(matchId, targetPlayerId, points));
  }
};
PlayerPeer.prototype.handleHostDisconnect = function () {
  this.connectedFlag = false;
  if (this.hostConnection !== null) { this.hostConnection.close(); this.hostConnection = null; }
  this.playerCallbacks.onHostDisconnected();
};
Object.defineProperty(PlayerPeer.prototype, 'connected', { get: function () { return this.connectedFlag; } });
PlayerPeer.prototype.destroy = function () {
  if (this.hostConnection !== null && this.hostConnection.open) {
    this.hostConnection.send({ type: 'disconnect' }); this.hostConnection.close();
  }
  this.hostConnection = null; this.connectedFlag = false;
  PeerBase.prototype.destroy.call(this);
};

// ===== PlayerUI =====
function PlayerUI(container, onJoin) {
  this.container = container;
  this.onJoin = onJoin;
  this.roomCode = '';
  this.playerName = '';
  this.renderLayout();
}
PlayerUI.prototype.renderLayout = function () {
  var self = this;
  this.container.innerHTML = [
    '<div class="player-view">',
    '  <div id="join-screen">',
    '    <h1>Join Tournament</h1>',
    '    <div class="join-form">',
    '      <input type="text" id="player-room-code" placeholder="Room Code" maxlength="6" autocomplete="off" />',
    '      <input type="text" id="player-name" placeholder="Your Nickname" autocomplete="off" />',
    '      <button id="player-join-btn" class="btn-primary">Join</button>',
    '    </div>',
    '    <div id="player-status" class="status"></div>',
    '  </div>',
    '  <div id="main-screen" style="display:none">',
    '    <div class="player-header">',
    '      <div class="header-left">',
    '        <div class="room-badge" id="player-room-badge">Room: ---</div>',
    '        <div class="player-greeting" id="player-greeting">Welcome!</div>',
    '      </div>',
    '      <div class="points-badge" id="points-badge">50 pts</div>',
    '    </div>',
    '    <div id="champ-section" class="section"></div>',
    '    <div id="bet-section" class="section"></div>',
    '    <div id="ranking-section" class="section"></div>',
    '    <div id="player-status-main" class="status"></div>',
    '  </div>',
    '</div>'
  ].join('');

  document.getElementById('player-join-btn').addEventListener('click', function () {
    var roomInput = document.getElementById('player-room-code');
    var nameInput = document.getElementById('player-name');
    var code = roomInput.value.trim().toUpperCase();
    var name = nameInput.value.trim();
    if (code.length > 0 && name.length > 0) {
      self.roomCode = code;
      self.playerName = name;
      self.onJoin(code, name);
    }
  });

  // URL params
  var params = new URLSearchParams(window.location.search);
  var roomFromUrl = params.get('room') || '';
  var nameFromUrl = params.get('name') || '';
  if (roomFromUrl.length > 0 && nameFromUrl.length > 0) {
    document.getElementById('player-room-code').value = roomFromUrl;
    document.getElementById('player-name').value = nameFromUrl;
    self.roomCode = roomFromUrl;
    self.playerName = nameFromUrl;
    self.onJoin(roomFromUrl, nameFromUrl);
  }
};

PlayerUI.prototype.showConnected = function () {
  document.getElementById('join-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = '';
  document.getElementById('player-room-badge').textContent = 'Room: ' + this.roomCode;
  document.getElementById('player-greeting').textContent = 'Welcome, ' + PlayerUI.escapeHtml(this.playerName) + '!';
};

PlayerUI.prototype.updateTournamentState = function (state, peer, rankings) {
  this.updateChampSection(state, peer);
  this.updateBetSection(state, peer);
  this.updateRankingSection(rankings || []);
};

PlayerUI.prototype.updateChampSection = function (state, peer) {
  var el = document.getElementById('champ-section');
  if (!el) return;
  if (state.champPredictOpen) {
    if (peer && peer.champPredicted) {
      el.innerHTML = '<div class="info-msg">Championship prediction submitted ✓</div>';
    } else {
      var players = state.matchPlayers || [];
      var html = '<div class="section-title">Championship Prediction</div>';
      html += '<p class="hint">Who will win the tournament? (one-time only)</p>';
      html += '<div class="player-select-grid">';
      for (var i = 0; i < players.length; i++) {
        html += '<label class="player-card" id="champ-card-' + i + '">';
        html += '  <input type="radio" name="champ-pick" value="' + players[i].id + '" />';
        html += '  <span class="card-name">' + PlayerUI.escapeHtml(players[i].name) + '</span>';
        html += '</label>';
      }
      html += '</div>';
      html += '<button id="btn-champ-submit" class="btn-primary" disabled>Submit Prediction</button>';
      el.innerHTML = html;
      var radios = el.querySelectorAll('input[name="champ-pick"]');
      for (var j = 0; j < radios.length; j++) {
        (function (r) {
          r.addEventListener('change', function () { document.getElementById('btn-champ-submit').disabled = false; });
        })(radios[j]);
      }
      var btn = document.getElementById('btn-champ-submit');
      if (btn) {
        btn.addEventListener('click', function () {
          var sel = el.querySelector('input[name="champ-pick"]:checked');
          if (sel && peer) peer.sendChampPredict(sel.value);
        });
      }
    }
  } else if (state.status === 'idle') {
    el.innerHTML = '<div class="info-msg">Waiting for tournament to start...</div>';
  } else {
    el.innerHTML = '';
  }
};

PlayerUI.prototype.updateBetSection = function (state, peer) {
  var el = document.getElementById('bet-section');
  if (!el) return;
  if (state.status !== 'inProgress') {
    el.innerHTML = state.status === 'finished'
      ? '<div class="info-msg">Tournament finished! Check rankings.</div>'
      : '';
    return;
  }
  var matches = state.matches || [];
  var activeMatch = null;
  for (var i = 0; i < matches.length; i++) {
    if (matches[i].winner === null) { activeMatch = matches[i]; break; }
  }
  if (!activeMatch) {
    el.innerHTML = '<div class="info-msg">All matches completed. Waiting for final results...</div>';
    return;
  }
  var p1Name = PlayerUI.getPlayerName(state.matchPlayers, activeMatch.player1Id);
  var p2Name = PlayerUI.getPlayerName(state.matchPlayers, activeMatch.player2Id);
  if (!activeMatch.votingOpen) {
    el.innerHTML = '<div class="section-title">Current Match</div>' +
      '<div class="match-vs"><span class="player-name">' + PlayerUI.escapeHtml(p1Name) + '</span>' +
      '<span class="vs-text">VS</span>' +
      '<span class="player-name">' + PlayerUI.escapeHtml(p2Name) + '</span></div>' +
      (activeMatch.winner
        ? '<div class="result-box">Winner: <strong>' + PlayerUI.escapeHtml(PlayerUI.getPlayerName(state.matchPlayers, activeMatch.winner)) + '</strong></div>'
        : '<div class="info-msg">Voting closed — waiting for result...</div>');
    return;
  }
  el.innerHTML = [
    '<div class="section-title">Place Your Bet</div>',
    '<div class="match-vs"><span class="player-name">' + PlayerUI.escapeHtml(p1Name) + '</span>',
    '<span class="vs-text">VS</span>',
    '<span class="player-name">' + PlayerUI.escapeHtml(p2Name) + '</span></div>',
    '<div class="bet-row">',
    '  <label>Win prediction:</label>',
    '  <select id="bet-target" class="bet-select">',
    '    <option value="' + activeMatch.player1Id + '">' + PlayerUI.escapeHtml(p1Name) + '</option>',
    '    <option value="' + activeMatch.player2Id + '">' + PlayerUI.escapeHtml(p2Name) + '</option>',
    '  </select>',
    '</div>',
    '<div class="bet-row">',
    '  <label>Bet points:</label>',
    '  <input type="number" id="bet-points" class="bet-input" value="5" min="1" />',
    '</div>',
    '<button id="btn-place-bet" class="btn-primary">Place Bet</button>'
  ].join('');
  document.getElementById('btn-place-bet').addEventListener('click', function () {
    var target = document.getElementById('bet-target').value;
    var pts = parseInt(document.getElementById('bet-points').value, 10);
    if (pts > 0 && peer) peer.sendBet(activeMatch.id, target, pts);
  });
};

PlayerUI.prototype.updateRankingSection = function (rankings) {
  var el = document.getElementById('ranking-section');
  if (!el) return;
  if (!rankings || rankings.length === 0) { el.innerHTML = ''; return; }
  var html = '<div class="section-title">Rankings</div>';
  html += '<table class="rank-table">';
  html += '<tr><th>#</th><th>Name</th><th>Points</th></tr>';
  for (var i = 0; i < rankings.length; i++) {
    html += '<tr class="rank-row' + (i < 3 ? ' top-' + (i + 1) : '') + '">' +
      '<td class="rank-num">' + (i + 1) + '</td>' +
      '<td>' + PlayerUI.escapeHtml(rankings[i].name) + '</td>' +
      '<td class="pts">' + rankings[i].points + '</td></tr>';
  }
  html += '</table>';
  el.innerHTML = html;
};

PlayerUI.prototype.showError = function (message) {
  var el = document.getElementById('player-status');
  if (el) { el.textContent = message; el.className = 'status error'; }
  var el2 = document.getElementById('player-status-main');
  if (el2) { el2.textContent = message; el2.className = 'status error'; }
};
PlayerUI.prototype.showDisconnected = function () {
  var msg = 'Disconnected from host';
  var el = document.getElementById('player-status');
  if (el) { el.textContent = msg; el.className = 'status error'; }
  var el2 = document.getElementById('player-status-main');
  if (el2) { el2.textContent = msg; el2.className = 'status error'; }
};
PlayerUI.escapeHtml = function (text) { var div = document.createElement('div'); div.textContent = text; return div.innerHTML; };
PlayerUI.getPlayerName = function (players, id) {
  if (!id) return '-';
  for (var i = 0; i < players.length; i++) { if (players[i].id === id) return players[i].name; }
  return id;
};

// ===== メイン処理 =====
var container = document.getElementById('app');
var ui = new PlayerUI(container, function (code, name) {
  var callbacks = {
    onError: function (msg) { ui.showError(msg); },
    onConnected: function () { ui.showConnected(); },
    onPlayerListUpdate: function (_players) { },
    onHostDisconnected: function () { ui.showDisconnected(); },
    onTournamentState: function (state) {
      ui.updateTournamentState(state, player, player.rankings);
    },
    onRankingUpdate: function (rankings) {
      ui.updateTournamentState(player.tournamentState, player, rankings);
    },
    onChampPredictAck: function (ok) {
      if (ok) {
        ui.updateTournamentState(player.tournamentState, player, player.rankings);
      }
    },
    onBetAck: function (ok) {
      if (ok) {
        ui.updateTournamentState(player.tournamentState, player, player.rankings);
      }
    }
  };
  var player = new PlayerPeer(code, name, callbacks);
  player.start().catch(function (err) { ui.showError('Connection failed: ' + err.message); });
});
