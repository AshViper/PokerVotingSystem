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
  this.peer = null;
  // 各種UI要素
  this.joinScreen = null;
  this.mainScreen = null;
  this.champScreen = null;
  this.betScreen = null;
  this.rankingScreen = null;
  this.currentView = null;
  this.renderLayout();
}
PlayerUI.prototype.renderLayout = function () {
  this.container.innerHTML = [
    '<div class="player-view">',
    '  <!-- Join Screen -->',
    '  <div id="join-screen">',
    '    <h1>Join Tournament</h1>',
    '    <div class="join-form">',
    '      <input type="text" id="player-room-code" placeholder="Room Code" maxlength="6" autocomplete="off" />',
    '      <input type="text" id="player-name" placeholder="Your Nickname" autocomplete="off" />',
    '      <button id="player-join-btn">Join</button>',
    '    </div>',
    '    <div id="player-status" class="status"></div>',
    '  </div>',
    '  <!-- Main Screen (after join) -->',
    '  <div id="main-screen" style="display:none">',
    '    <h1>P2P Tournament</h1>',
    '    <div id="nav-tabs" style="display:flex;gap:4px;margin-bottom:8px">',
    '      <button class="nav-tab" data-view="champ" style="flex:1">Prediction</button>',
    '      <button class="nav-tab" data-view="bet" style="flex:1">Bet</button>',
    '      <button class="nav-tab" data-view="ranking" style="flex:1">Ranking</button>',
    '    </div>',
    '    <div id="view-champ" class="tab-content"></div>',
    '    <div id="view-bet" class="tab-content" style="display:none"></div>',
    '    <div id="view-ranking" class="tab-content" style="display:none"></div>',
    '    <div id="tournament-status-bar" class="status"></div>',
    '  </div>',
    '</div>'
  ].join('');

  this.joinScreen = document.getElementById('join-screen');
  this.mainScreen = document.getElementById('main-screen');

  var self = this;
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

  // タブ切り替え
  var tabs = this.container.querySelectorAll('.nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    (function (tab) {
      tab.addEventListener('click', function () {
        self.switchTab(tab.getAttribute('data-view'));
      });
    })(tabs[i]);
  }

  // URLにroomとnameがある場合
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
PlayerUI.prototype.switchTab = function (view) {
  var views = ['champ', 'bet', 'ranking'];
  for (var i = 0; i < views.length; i++) {
    var el = document.getElementById('view-' + views[i]);
    if (el) el.style.display = views[i] === view ? '' : 'none';
  }
  var tabs = this.container.querySelectorAll('.nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].style.opacity = tabs[i].getAttribute('data-view') === view ? '1' : '0.5';
  }
  this.currentView = view;
};

// 接続成功 → メイン画面へ
PlayerUI.prototype.showConnected = function () {
  this.joinScreen.style.display = 'none';
  this.mainScreen.style.display = '';
};

// 大会状態の更新
PlayerUI.prototype.updateTournamentState = function (state, peer, rankings) {
  this.updateChampView(state, peer);
  this.updateBetView(state, peer);
  this.updateRankingView(rankings || []);
  this.updateStatusBar(state);
};
PlayerUI.prototype.updateChampView = function (state, peer) {
  var el = document.getElementById('view-champ');
  if (!el) return;
  if (state.status === 'idle') {
    el.innerHTML = '<p>Waiting for tournament to start...</p>';
    return;
  }
  // 対戦プレイヤー一覧を表示
  var players = state.matchPlayers || [];
  // 自分の予想状態を確認
  var myChamp = null;
  if (peer && peer.peerId && peer.tournamentState) {
    // 仮: peerIdがuserIDとして使われている
  }

  if (state.champPredictOpen) {
    if (peer && peer.champPredicted) {
      el.innerHTML = '<p>Championship prediction submitted! Waiting for predictions to close.</p>';
    } else {
      var html = '<h2>Championship Prediction</h2>';
      html += '<p>Who will win the tournament? (One-time, cannot change)</p>';
      html += '<div class="player-list" id="champ-player-list">';
      if (players.length === 0) {
        html += '<p>No players registered yet. Wait for the master to add players.</p>';
      } else {
        for (var i = 0; i < players.length; i++) {
          html += '<label class="player-option">';
          html += '  <input type="radio" name="champ-predict" value="' + players[i].id + '" />';
          html += '  ' + PlayerUI.escapeHtml(players[i].name);
          html += '</label>';
        }
        html += '</div>';
        html += '<button id="btn-submit-champ-predict" disabled>Submit Prediction</button>';
      }
      el.innerHTML = html;

      // ラジオボタンイベント
      var radios = el.querySelectorAll('input[name="champ-predict"]');
      for (var i2 = 0; i2 < radios.length; i2++) {
        (function (radio) {
          radio.addEventListener('change', function () {
            var btn = document.getElementById('btn-submit-champ-predict');
            if (btn) btn.disabled = false;
          });
        })(radios[i2]);
      }
      var submitBtn = document.getElementById('btn-submit-champ-predict');
      if (submitBtn) {
        submitBtn.addEventListener('click', function () {
          var selected = el.querySelector('input[name="champ-predict"]:checked');
          if (selected && peer) {
            peer.sendChampPredict(selected.value);
          }
        });
      }
    }
  } else if (state.status === 'predicting') {
    el.innerHTML = '<p>Championship predictions are closed. Awaiting tournament start...</p>';
  } else if (state.status === 'inProgress' || state.status === 'finished') {
    el.innerHTML = '<p>Championship prediction phase completed.</p>';
    if (state.tournamentWinnerId) {
      var winnerName = '';
      for (var j = 0; j < players.length; j++) {
        if (players[j].id === state.tournamentWinnerId) { winnerName = players[j].name; break; }
      }
      el.innerHTML += '<p>Tournament Winner: <strong>' + PlayerUI.escapeHtml(winnerName) + '</strong></p>';
    }
  }
};
PlayerUI.prototype.updateBetView = function (state, peer) {
  var el = document.getElementById('view-bet');
  if (!el) return;

  if (state.status !== 'inProgress') {
    el.innerHTML = state.status === 'finished' ? '<p>Tournament finished!</p>' : '<p>Waiting for tournament to be in progress...</p>';
    return;
  }

  var matches = state.matches || [];
  var activeMatch = null;
  for (var i = 0; i < matches.length; i++) {
    if (matches[i].votingOpen || matches[i].winner === null) {
      activeMatch = matches[i];
      break;
    }
  }

  if (!activeMatch) {
    el.innerHTML = '<p>No active match. Waiting for match to start...</p>';
    return;
  }

  var p1Name = PlayerUI.getPlayerName(state.matchPlayers, activeMatch.player1Id);
  var p2Name = PlayerUI.getPlayerName(state.matchPlayers, activeMatch.player2Id);

  if (activeMatch.votingOpen) {
    if (peer && peer.hasBetForMatch && peer.hasBetForMatch[activeMatch.id]) {
      el.innerHTML = '<p>Bet submitted for this match. Waiting for result...</p>';
      el.innerHTML += '<p>' + PlayerUI.escapeHtml(p1Name) + ' vs ' + PlayerUI.escapeHtml(p2Name) + '</p>';
    } else {
      var html = '<h2>Match: ' + PlayerUI.escapeHtml(p1Name) + ' vs ' + PlayerUI.escapeHtml(p2Name) + '</h2>';
      html += '<p>Voting is OPEN! Place your bet.</p>';
      html += '<div><label>Win prediction:</label>';
      html += '<select id="bet-target">';
      html += '  <option value="' + activeMatch.player1Id + '">' + PlayerUI.escapeHtml(p1Name) + '</option>';
      html += '  <option value="' + activeMatch.player2Id + '">' + PlayerUI.escapeHtml(p2Name) + '</option>';
      html += '</select></div>';
      html += '<div><label>Bet points:</label>';
      html += '<input type="number" id="bet-points" value="100" min="1" /></div>';
      html += '<button id="btn-place-bet">Place Bet</button>';
      el.innerHTML = html;

      document.getElementById('btn-place-bet').addEventListener('click', function () {
        var target = document.getElementById('bet-target').value;
        var points = parseInt(document.getElementById('bet-points').value, 10);
        if (points > 0 && peer) {
          peer.sendBet(activeMatch.id, target, points);
        }
      });
    }
  } else {
    el.innerHTML = '<p>Match: ' + PlayerUI.escapeHtml(p1Name) + ' vs ' + PlayerUI.escapeHtml(p2Name) + '</p>';
    el.innerHTML += '<p>Voting is CLOSED. Waiting for result...</p>';
    if (activeMatch.winner) {
      el.innerHTML += '<p>Winner: <strong>' + PlayerUI.escapeHtml(PlayerUI.getPlayerName(state.matchPlayers, activeMatch.winner)) + '</strong></p>';
    }
  }
};
PlayerUI.prototype.updateRankingView = function (rankings) {
  var el = document.getElementById('view-ranking');
  if (!el) return;
  if (!rankings || rankings.length === 0) {
    el.innerHTML = '<p>No rankings yet.</p>';
    return;
  }
  var html = '<h2>Rankings</h2><table style="width:100%"><tr><th>#</th><th>Name</th><th>Points</th><th>Prediction</th></tr>';
  for (var i = 0; i < rankings.length; i++) {
    html += '<tr><td>' + (i + 1) + '</td><td>' + PlayerUI.escapeHtml(rankings[i].name) + '</td><td>' + rankings[i].points + '</td><td>' + PlayerUI.escapeHtml(rankings[i].champPredictName) + '</td></tr>';
  }
  html += '</table>';
  el.innerHTML = html;
};
PlayerUI.prototype.updateStatusBar = function (state) {
  var el = document.getElementById('tournament-status-bar');
  if (!el) return;
  el.textContent = 'Status: ' + state.status;
  el.className = 'status';
  if (state.status === 'predicting') el.className += ' connected';
  else if (state.status === 'inProgress') el.className += ' connected';
  else if (state.status === 'finished') el.className += ' connected';
};
PlayerUI.prototype.showError = function (message) {
  var status = document.getElementById('player-status');
  if (status !== null) { status.textContent = message; status.className = 'status error'; }
};
PlayerUI.prototype.showDisconnected = function () {
  var status = document.getElementById('player-status');
  if (status !== null) { status.textContent = 'Disconnected from host'; status.className = 'status error'; }
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
