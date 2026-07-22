// ===== パケットユーティリティ =====
function isRecord(data) { return typeof data === 'object' && data !== null; }
function isPacket(data) {
  if (!isRecord(data)) return false;
  if (typeof data.type !== 'string') return false;
  return true;
}
function parseMessage(data) {
  if (!isPacket(data)) return null;
  return data;
}
function createJoinPacket(role, name) {
  if (role === 'player' && name) { return { type: 'join', role: 'player', name: name }; }
  return { type: 'join', role: 'viewer' };
}
function createPlayerListPacket(players) { return { type: 'playerList', players: players }; }
function createVotePacket(target) { return { type: 'vote', target: target }; }
function createVoteResultPacket(result) { return { type: 'voteResult', result: result }; }
function createDisconnectPacket() { return { type: 'disconnect' }; }

// 大会管理パケット
function createChampionshipPredictPacket(target) { return { type: 'championshipPredict', target: target }; }
function createBetPacket(matchId, target, points) { return { type: 'bet', matchId: matchId, target: target, points: points }; }
function createTournamentStatePacket(state) { return { type: 'tournamentState', state: state }; }
function createRankingPacket(rankings) { return { type: 'ranking', rankings: rankings }; }

// ===== ルームユーティリティ =====
function generateRoomCode() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var code = '';
  for (var i = 0; i < 6; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return code;
}
function buildViewerUrl(roomCode) {
  try {
    var viewerUrl = new URL('viewer.html', window.location.href);
    viewerUrl.searchParams.set('room', roomCode);
    return viewerUrl.toString();
  } catch (e) {
    return 'viewer.html?room=' + encodeURIComponent(roomCode);
  }
}
function getHostPeerId(roomCode) { return 'poker-' + roomCode; }

// ===== TournamentManager =====
// 大会の状態管理、ポイント計算、ランキング

function TournamentManager() {
  this.status = 'idle';           // idle | predicting | inProgress | finished
  this.participants = {};         // peerId → { name, points, champPredict, joinedAt }
  this.matchPlayers = [];         // [{ id, name }] ※対戦プレイヤー名簿
  this.matches = [];              // [{ id, player1Id, player2Id, votingOpen, winner }]
  this.bets = {};                 // matchId → { userId → { target, points } }
  this.currentMatchIndex = -1;    // 進行中マッチのインデックス
  this.tournamentWinnerId = null; // 大会優勝者のプレイヤーID
  this.champPredictOpen = false;  // 優勝予想受付中
}

// 参加者追加
TournamentManager.prototype.addParticipant = function (peerId, name) {
  if (this.participants[peerId]) return false;
  this.participants[peerId] = {
    name: name,
    points: 1000,
    champPredict: null,
    joinedAt: Date.now(),
    rankRelevant: true    // ランキング対象（優勝予想締切後はfalse）
  };
  return true;
};

// 優勝予想を登録（1回のみ）
TournamentManager.prototype.setChampionshipPredict = function (peerId, targetPlayerId) {
  var p = this.participants[peerId];
  if (!p) return false;
  if (p.champPredict !== null) return false; // 変更不可
  if (!this.champPredictOpen) return false;   // 受付期間外
  p.champPredict = targetPlayerId;
  return true;
};

// 優勝予想受付を開始（= 大会開始）
TournamentManager.prototype.openChampionshipPredict = function () {
  this.status = 'predicting';
  this.champPredictOpen = true;
};

// 優勝予想受付を終了
TournamentManager.prototype.closeChampionshipPredict = function () {
  this.champPredictOpen = false;
  this.status = 'inProgress';
  // この時点で未Joinのユーザーはランキング対象外
  var cutoff = Date.now();
  for (var id in this.participants) {
    if (this.participants.hasOwnProperty(id)) {
      if (this.participants[id].champPredict === null) {
        this.participants[id].rankRelevant = false;
      }
    }
  }
};

// 対戦プレイヤーを設定
TournamentManager.prototype.setMatchPlayers = function (players) {
  this.matchPlayers = players;
};

// マッチを追加
TournamentManager.prototype.addMatch = function (player1Id, player2Id) {
  var matchId = 'match-' + (this.matches.length + 1);
  this.matches.push({
    id: matchId,
    player1Id: player1Id,
    player2Id: player2Id,
    votingOpen: false,
    winner: null
  });
  return matchId;
};

// 投票開始
TournamentManager.prototype.openVoting = function (matchId) {
  var match = this.getMatch(matchId);
  if (!match) return false;
  match.votingOpen = true;
  this.currentMatchIndex = this.matches.indexOf(match);
  return true;
};

// 投票締切
TournamentManager.prototype.closeVoting = function (matchId) {
  var match = this.getMatch(matchId);
  if (!match) return false;
  match.votingOpen = false;
  return true;
};

// ベットを記録
TournamentManager.prototype.placeBet = function (userId, matchId, targetId, points) {
  var p = this.participants[userId];
  if (!p) return { ok: false, reason: 'notParticipant' };
  if (!p.rankRelevant) return { ok: false, reason: 'notRanked' };
  if (p.champPredict === null) return { ok: false, reason: 'noChampPredict' };

  var match = this.getMatch(matchId);
  if (!match) return { ok: false, reason: 'noMatch' };
  if (!match.votingOpen) return { ok: false, reason: 'votingClosed' };
  if (targetId !== match.player1Id && targetId !== match.player2Id) return { ok: false, reason: 'invalidTarget' };
  if (points < 0) return { ok: false, reason: 'invalidPoints' };
  if (points > p.points) return { ok: false, reason: 'insufficientPoints' };

  if (!this.bets[matchId]) this.bets[matchId] = {};
  this.bets[matchId][userId] = { target: targetId, points: points };
  return { ok: true };
};

// マッチの勝者を登録（ポイント自動計算）
TournamentManager.prototype.setMatchWinner = function (matchId, winnerId) {
  var match = this.getMatch(matchId);
  if (!match) return false;
  match.winner = winnerId;

  var matchBets = this.bets[matchId];
  if (matchBets) {
    for (var userId in matchBets) {
      if (matchBets.hasOwnProperty(userId)) {
        var bet = matchBets[userId];
        var p = this.participants[userId];
        if (p && p.rankRelevant) {
          if (bet.target === winnerId) {
            // 的中：ベット額の2倍を獲得（賭けた分は戻ってこないため純増はbet分）
            p.points += bet.points;
          } else {
            // はずれ：ベット額を失う
            p.points -= bet.points;
          }
        }
      }
    }
  }
  return true;
};

// 大会優勝者を登録
TournamentManager.prototype.setTournamentWinner = function (playerId) {
  this.tournamentWinnerId = playerId;
  this.status = 'finished';

  // 優勝予想が的中した参加者にボーナス
  for (var id in this.participants) {
    if (this.participants.hasOwnProperty(id)) {
      var p = this.participants[id];
      if (p.champPredict === playerId) {
        p.points += 500; // ボーナス
      }
    }
  }
};

// マッチを取得
TournamentManager.prototype.getMatch = function (matchId) {
  for (var i = 0; i < this.matches.length; i++) {
    if (this.matches[i].id === matchId) return this.matches[i];
  }
  return null;
};

// ランキングを取得（ランキング対象のみ）
TournamentManager.prototype.getRankings = function () {
  var list = [];
  for (var id in this.participants) {
    if (this.participants.hasOwnProperty(id) && this.participants[id].rankRelevant) {
      list.push({
        userId: id,
        name: this.participants[id].name,
        points: this.participants[id].points,
        champPredictName: this.getPlayerName(this.participants[id].champPredict)
      });
    }
  }
  list.sort(function (a, b) { return b.points - a.points; });
  return list;
};

// 全参加者リスト（ランキング対象外も含む）
TournamentManager.prototype.getAllParticipants = function () {
  var list = [];
  for (var id in this.participants) {
    if (this.participants.hasOwnProperty(id)) {
      list.push({
        userId: id,
        name: this.participants[id].name,
        points: this.participants[id].points,
        champPredict: this.participants[id].champPredict,
        rankRelevant: this.participants[id].rankRelevant
      });
    }
  }
  return list;
};

// プレイヤー名を取得
TournamentManager.prototype.getPlayerName = function (playerId) {
  if (!playerId) return '-';
  for (var i = 0; i < this.matchPlayers.length; i++) {
    if (this.matchPlayers[i].id === playerId) return this.matchPlayers[i].name;
  }
  return playerId;
};

// マッチのベット集計を取得
TournamentManager.prototype.getMatchBetSummary = function (matchId) {
  var summary = { player1: { count: 0, totalPoints: 0 }, player2: { count: 0, totalPoints: 0 } };
  var match = this.getMatch(matchId);
  if (!match) return summary;

  var matchBets = this.bets[matchId];
  if (matchBets) {
    for (var userId in matchBets) {
      if (matchBets.hasOwnProperty(userId)) {
        var bet = matchBets[userId];
        if (bet.target === match.player1Id) {
          summary.player1.count++;
          summary.player1.totalPoints += bet.points;
        } else {
          summary.player2.count++;
          summary.player2.totalPoints += bet.points;
        }
      }
    }
  }
  return summary;
};

// 状態をシリアライズ（ブロードキャスト用）
TournamentManager.prototype.getState = function () {
  return {
    status: this.status,
    matches: this.matches,
    matchPlayers: this.matchPlayers,
    currentMatchIndex: this.currentMatchIndex,
    champPredictOpen: this.champPredictOpen,
    tournamentWinnerId: this.tournamentWinnerId
  };
};

// ===== VoteManager（既存） =====
function VoteManager() { this.votes = {}; this.players = {}; }
VoteManager.prototype.setPlayers = function (players) {
  this.players = {};
  for (var i = 0; i < players.length; i++) { this.players[players[i].peerId] = players[i].name; }
};
VoteManager.prototype.processVote = function (viewerPeerId, targetPeerId) {
  if (this.votes[viewerPeerId] === targetPeerId) return this.getResults();
  this.votes[viewerPeerId] = targetPeerId;
  return this.getResults();
};
VoteManager.prototype.removeViewer = function (viewerPeerId) {
  delete this.votes[viewerPeerId];
  return this.getResults();
};
VoteManager.prototype.getResults = function () {
  var voteCounts = {};
  for (var peerId in this.players) { if (this.players.hasOwnProperty(peerId)) voteCounts[peerId] = 0; }
  for (var viewer in this.votes) {
    if (this.votes.hasOwnProperty(viewer)) {
      var target = this.votes[viewer];
      if (voteCounts[target] === undefined) voteCounts[target] = 0;
      voteCounts[target]++;
    }
  }
  var results = [];
  for (var pid in voteCounts) {
    if (voteCounts.hasOwnProperty(pid)) {
      results.push({ peerId: pid, name: this.players[pid] || 'Unknown', voteCount: voteCounts[pid] });
    }
  }
  results.sort(function (a, b) { return b.voteCount - a.voteCount; });
  return results;
};
VoteManager.prototype.clear = function () { this.votes = {}; };

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

// ===== HostPeer（大会管理機能追加） =====
function HostPeer(roomCode, callbacks) {
  PeerBase.call(this, callbacks);
  this.hostCallbacks = callbacks;
  this.connections = {};
  this.players = {};
  this.viewers = {};
  this.voteManager = new VoteManager();
  this.tournament = new TournamentManager();
  this.roomCode = roomCode;
  this.isMasterMode = false;
}
HostPeer.prototype = Object.create(PeerBase.prototype);
HostPeer.prototype.constructor = HostPeer;

HostPeer.prototype.start = function () {
  var self = this;
  var peerId = getHostPeerId(this.roomCode);
  return this.createPeer(peerId).then(function () {
    self.setupConnectionHandler();
    self.hostCallbacks.onReady(peerId);
  });
};
HostPeer.prototype.setupConnectionHandler = function () {
  var self = this;
  if (this.peerInstance === null) return;
  this.peerInstance.on('connection', function (conn) { self.handleNewConnection(conn); });
};
HostPeer.prototype.handleNewConnection = function (conn) {
  var self = this;
  var remoteId = conn.peer;
  if (conn.open) { self.registerConnection(conn, remoteId); }
  else { conn.on('open', function () { self.registerConnection(conn, remoteId); }); }
  conn.on('error', function () { self.handleDisconnect(remoteId); });
};
HostPeer.prototype.registerConnection = function (conn, remoteId) {
  var self = this;
  this.connections[remoteId] = conn;
  conn.on('data', function (data) { self.handleData(remoteId, data); });
  conn.on('close', function () { self.handleDisconnect(remoteId); });
};
HostPeer.prototype.handleData = function (remoteId, data) {
  var packet = parseMessage(data);
  if (packet === null) return;
  switch (packet.type) {
    case 'join': this.handleJoin(remoteId, packet); break;
    case 'vote': this.handleVote(remoteId, packet); break;
    case 'disconnect': this.handleDisconnect(remoteId); break;
    // 大会関連パケット
    case 'championshipPredict': this.handleChampPredict(remoteId, packet); break;
    case 'bet': this.handleBet(remoteId, packet); break;
  }
};
HostPeer.prototype.handleJoin = function (remoteId, packet) {
  if (packet.role === 'player' && packet.name !== undefined) {
    var player = { peerId: remoteId, name: packet.name };
    this.players[remoteId] = player;
    // トーナメント参加者としても登録
    this.tournament.addParticipant(remoteId, packet.name);
    this.hostCallbacks.onPlayerJoined(player);
    this.synchronizePlayerList();
    this.broadcastTournamentState();
    this.broadcastRanking();
  } else if (packet.role === 'viewer') {
    this.viewers[remoteId] = true;
    this.tournament.addParticipant(remoteId, '(viewer)');
    this.hostCallbacks.onViewerJoined(remoteId);
    this.sendPlayerList(remoteId);
    this.sendTo(remoteId, createTournamentStatePacket(this.tournament.getState()));
    this.sendTo(remoteId, createRankingPacket(this.tournament.getRankings()));
  }
};
HostPeer.prototype.handleVote = function (remoteId, packet) {
  if (!this.viewers[remoteId]) return;
  var results = this.voteManager.processVote(remoteId, packet.target);
  this.hostCallbacks.onVoteResultUpdated(results);
  this.broadcastToViewers(createVoteResultPacket(results));
};
// 優勝予想の処理
HostPeer.prototype.handleChampPredict = function (remoteId, packet) {
  var ok = this.tournament.setChampionshipPredict(remoteId, packet.target);
  if (ok) {
    this.sendTo(remoteId, { type: 'champPredictAck', ok: true });
    this.broadcastTournamentState();
    this.hostCallbacks.onTournamentUpdate();
  } else {
    this.sendTo(remoteId, { type: 'champPredictAck', ok: false });
  }
};
// ベットの処理
HostPeer.prototype.handleBet = function (remoteId, packet) {
  var result = this.tournament.placeBet(remoteId, packet.matchId, packet.target, packet.points);
  this.sendTo(remoteId, { type: 'betAck', ok: result.ok, reason: result.reason || '' });
  if (result.ok) {
    this.hostCallbacks.onTournamentUpdate();
    this.broadcastRanking();
  }
};

HostPeer.prototype.handleDisconnect = function (remoteId) {
  var connection = this.connections[remoteId];
  if (connection !== undefined) { connection.close(); delete this.connections[remoteId]; }
  if (this.players[remoteId]) {
    delete this.players[remoteId];
    this.hostCallbacks.onPlayerLeft(remoteId);
    this.synchronizePlayerList();
  }
  if (this.viewers[remoteId]) {
    delete this.viewers[remoteId];
    this.hostCallbacks.onViewerLeft(remoteId);
    var results = this.voteManager.removeViewer(remoteId);
    this.hostCallbacks.onVoteResultUpdated(results);
    this.broadcastToViewers(createVoteResultPacket(results));
  }
  this.broadcastTournamentState();
  this.broadcastRanking();
};
HostPeer.prototype.synchronizePlayerList = function () {
  var playerList = [];
  for (var key in this.players) { if (this.players.hasOwnProperty(key)) playerList.push(this.players[key]); }
  this.voteManager.setPlayers(playerList);
  var packet = createPlayerListPacket(playerList);
  this.broadcastToAll(packet);
};
HostPeer.prototype.sendPlayerList = function (targetId) {
  var playerList = [];
  for (var key in this.players) { if (this.players.hasOwnProperty(key)) playerList.push(this.players[key]); }
  var packet = createPlayerListPacket(playerList);
  this.sendTo(targetId, packet);
};
HostPeer.prototype.broadcastToViewers = function (packet) {
  for (var viewerId in this.viewers) { if (this.viewers.hasOwnProperty(viewerId)) this.sendTo(viewerId, packet); }
};
HostPeer.prototype.broadcastToAll = function (packet) {
  for (var connId in this.connections) { if (this.connections.hasOwnProperty(connId)) this.sendTo(connId, packet); }
};
HostPeer.prototype.broadcastTournamentState = function () {
  var packet = createTournamentStatePacket(this.tournament.getState());
  this.broadcastToAll(packet);
};
HostPeer.prototype.broadcastRanking = function () {
  var packet = createRankingPacket(this.tournament.getRankings());
  this.broadcastToAll(packet);
};
HostPeer.prototype.sendTo = function (targetId, data) {
  var conn = this.connections[targetId];
  if (conn !== undefined && conn.open) conn.send(data);
};
HostPeer.prototype.getPlayers = function () {
  var list = [];
  for (var key in this.players) { if (this.players.hasOwnProperty(key)) list.push(this.players[key]); }
  return list;
};
HostPeer.prototype.getViewerCount = function () {
  var count = 0;
  for (var key in this.viewers) { if (this.viewers.hasOwnProperty(key)) count++; }
  return count;
};
HostPeer.prototype.getVoteResults = function () { return this.voteManager.getResults(); };
HostPeer.prototype.destroy = function () {
  for (var key in this.connections) {
    if (this.connections.hasOwnProperty(key)) {
      var conn = this.connections[key];
      if (conn.open) conn.send({ type: 'disconnect' });
    }
  }
  this.connections = {}; this.players = {}; this.viewers = {};
  this.voteManager.clear();
  PeerBase.prototype.destroy.call(this);
};

// ===== HostUI =====
function HostUI(container) {
  this.container = container;
  this.render();
  this.roomCodeElement = document.getElementById('host-room-code');
  this.qrContainer = document.getElementById('host-qr-code');
  this.playersListElement = document.getElementById('host-players');
  this.playersCountElement = document.getElementById('host-players-count');
  this.viewersCountElement = document.getElementById('host-viewers');
  this.resultsElement = document.getElementById('host-results');
  // Tournament UI elements
  this.tournamentStatusEl = document.getElementById('tournament-status');
  this.tournamentControls = document.getElementById('tournament-controls');
  this.participantListEl = document.getElementById('participant-list');
  this.matchListEl = document.getElementById('match-list');
  this.rankingEl = document.getElementById('host-ranking');
  this.currentMatchInfo = document.getElementById('current-match-info');
  this.betSummaryEl = document.getElementById('bet-summary');
  this.p1Select = document.getElementById('match-player1');
  this.p2Select = document.getElementById('match-player2');
}
HostUI.prototype.render = function () {
  this.container.innerHTML = [
    '<div class="host-view">',
    '  <h1>P2P Tournament</h1>',
    '  <div>',
    '    <div class="room-code-section">',
    '      <h2>Room Code</h2>',
    '      <div id="host-room-code" class="room-code">---</div>',
    '    </div>',
    '    <div id="host-qr-code" class="qr-code"></div>',
    '  </div>',
    '  <hr/>',
    '  <h2>Tournament Control</h2>',
    '  <div id="tournament-controls">',
    '    <p>Loading...</p>',
    '  </div>',
    '  <hr/>',
    '  <h2>Participants</h2>',
    '  <ul id="participant-list"></ul>',
    '  <hr/>',
    '  <h2>Match Players</h2>',
    '  <div>',
    '    <input type="text" id="new-player-name" placeholder="Player name" style="display:inline;width:auto;flex:1" />',
    '    <button id="add-player-btn" style="display:inline;width:auto">Add</button>',
    '  </div>',
    '  <ul id="match-player-list"></ul>',
    '  <hr/>',
    '  <h2>Matches</h2>',
    '  <div>',
    '    <select id="match-player1"><option value="">Select...</option></select>',
    '    <span> vs </span>',
    '    <select id="match-player2"><option value="">Select...</option></select>',
    '    <button id="add-match-btn">Add Match</button>',
    '  </div>',
    '  <div id="match-list"></div>',
    '  <hr/>',
    '  <h2>Current Match</h2>',
    '  <div id="current-match-info">No active match</div>',
    '  <div id="bet-summary"></div>',
    '  <hr/>',
    '  <h2>Rankings</h2>',
    '  <table id="host-ranking" style="width:100%">',
    '    <tr><th>#</th><th>Name</th><th>Points</th></tr>',
    '  </table>',
    '  <hr/>',
    '  <div class="players-section">',
    '    <h2>Players (<span id="host-players-count">0</span>)</h2>',
    '    <ul id="host-players"></ul>',
    '  </div>',
    '  <div class="viewers-section">',
    '    <h2>Viewers: <span id="host-viewers">0</span></h2>',
    '  </div>',
    '  <div class="results-section">',
    '    <h2>Vote Results</h2>',
    '    <ul id="host-results"></ul>',
    '  </div>',
    '  <div id="host-status" class="status"></div>',
    '</div>'
  ].join('');
};
HostUI.prototype.displayRoomCode = function (code) {
  var self = this;
  this.roomCodeElement.textContent = code;
  var viewerUrl = buildViewerUrl(code);
  if (typeof QRCode !== 'undefined') {
    QRCode.toCanvas(viewerUrl, { width: 200 }).then(function (canvas) {
      self.qrContainer.innerHTML = '';
      self.qrContainer.appendChild(canvas);
    }).catch(function () { self.qrContainer.innerHTML = '<p>QR generation failed</p>'; });
  } else { this.qrContainer.innerHTML = '<p>QR not available</p>'; }
};
HostUI.prototype.updatePlayers = function (players) {
  this.playersCountElement.textContent = String(players.length);
  this.playersListElement.innerHTML = players.map(function (p) { return '<li>' + HostUI.escapeHtml(p.name) + '</li>'; }).join('');
};
HostUI.prototype.updateViewers = function (count) { this.viewersCountElement.textContent = String(count); };
HostUI.prototype.updateResults = function (results) {
  this.resultsElement.innerHTML = results.map(function (r) {
    return '<li class="result-item">' + HostUI.escapeHtml(r.name) + ': ' + r.voteCount + ' votes</li>';
  }).join('');
};
HostUI.prototype.showError = function (message) {
  var status = document.getElementById('host-status');
  if (status !== null) { status.textContent = message; status.className = 'status error'; }
};
HostUI.escapeHtml = function (text) { var div = document.createElement('div'); div.textContent = text; return div.innerHTML; };

// 大会管理UIの更新
HostUI.prototype.updateTournamentControls = function (tournament, host) {
  var self = this;
  var state = tournament.getState();
  var controls = this.tournamentControls;

  var html = '<p>Status: <strong>' + state.status + '</strong></p>';
  html += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin:8px 0">';

  if (state.status === 'idle') {
    html += '<button id="btn-open-champ-predict">Start Tournament (Open Predictions)</button>';
  }
  if (state.champPredictOpen) {
    html += '<button id="btn-close-champ-predict">Close Championship Predictions</button>';
  }
  if (state.status === 'inProgress') {
    html += '<button id="btn-finish-tournament">Finish Tournament</button>';
  }
  if (state.status === 'finished') {
    html += '<p>Tournament finished!</p>';
  }
  html += '</div>';

  // マッチ操作ボタン
  if (state.status === 'inProgress' && state.matches.length > 0) {
    html += '<h3>Match Control</h3>';
    html += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin:8px 0">';
    for (var i = 0; i < state.matches.length; i++) {
      var m = state.matches[i];
      html += '<div style="border:1px solid #444;padding:8px;margin:4px;border-radius:4px;min-width:200px">';
      html += '<strong>' + tournament.getPlayerName(m.player1Id) + ' vs ' + tournament.getPlayerName(m.player2Id) + '</strong><br/>';
      html += '<small>Match: ' + m.id + '</small><br/>';
      html += '<small>Voting: ' + (m.votingOpen ? 'OPEN' : 'CLOSED') + '</small><br/>';
      if (m.winner) {
        html += '<small>Winner: ' + tournament.getPlayerName(m.winner) + '</small><br/>';
      }
      if (!m.winner) {
        html += '<button class="btn-open-vote" data-match="' + m.id + '">' + (m.votingOpen ? 'Close Voting' : 'Open Voting') + '</button>';
        html += '<br/><select class="sel-winner" data-match="' + m.id + '">';
        html += '<option value="">Select winner...</option>';
        html += '<option value="' + m.player1Id + '">' + tournament.getPlayerName(m.player1Id) + '</option>';
        html += '<option value="' + m.player2Id + '">' + tournament.getPlayerName(m.player2Id) + '</option>';
        html += '</select>';
        html += '<button class="btn-set-winner" data-match="' + m.id + '">Register Winner</button>';
      }
      html += '</div>';
    }
    html += '</div>';
  }

  controls.innerHTML = html;

  // イベントバインド
  if (document.getElementById('btn-open-champ-predict')) {
    document.getElementById('btn-open-champ-predict').addEventListener('click', function () {
      host.tournament.openChampionshipPredict();
      host.broadcastTournamentState();
      host.broadcastRanking();
      self.updateTournamentControls(host.tournament, host);
    });
  }
  if (document.getElementById('btn-close-champ-predict')) {
    document.getElementById('btn-close-champ-predict').addEventListener('click', function () {
      host.tournament.closeChampionshipPredict();
      host.broadcastTournamentState();
      host.broadcastRanking();
      self.updateTournamentControls(host.tournament, host);
    });
  }
  if (document.getElementById('btn-finish-tournament')) {
    document.getElementById('btn-finish-tournament').addEventListener('click', function () {
      var winnerId = prompt('Enter the tournament winner Player ID:');
      if (winnerId) {
        host.tournament.setTournamentWinner(winnerId);
        host.broadcastTournamentState();
        host.broadcastRanking();
        self.updateTournamentControls(host.tournament, host);
      }
    });
  }

  // マッチ操作イベント
  var openVoteBtns = controls.querySelectorAll('.btn-open-vote');
  for (var i1 = 0; i1 < openVoteBtns.length; i1++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var matchId = btn.getAttribute('data-match');
        var match = host.tournament.getMatch(matchId);
        if (match) {
          if (match.votingOpen) { host.tournament.closeVoting(matchId); }
          else { host.tournament.openVoting(matchId); }
          host.broadcastTournamentState();
          self.updateTournamentControls(host.tournament, host);
          self.updateCurrentMatchInfo(host.tournament, matchId);
        }
      });
    })(openVoteBtns[i1]);
  }

  var setWinnerBtns = controls.querySelectorAll('.btn-set-winner');
  for (var i2 = 0; i2 < setWinnerBtns.length; i2++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var matchId = btn.getAttribute('data-match');
        var sel = controls.querySelector('.sel-winner[data-match="' + matchId + '"]');
        if (sel && sel.value) {
          host.tournament.setMatchWinner(matchId, sel.value);
          host.broadcastTournamentState();
          host.broadcastRanking();
          self.updateTournamentControls(host.tournament, host);
          self.updateCurrentMatchInfo(host.tournament, matchId);
          self.updateRanking(host.tournament);
        }
      });
    })(setWinnerBtns[i2]);
  }
};

// 参加者一覧表示
HostUI.prototype.updateParticipantList = function (tournament) {
  var list = tournament.getAllParticipants();
  this.participantListEl.innerHTML = list.map(function (p) {
    var predName = tournament.getPlayerName(p.champPredict);
    return '<li>' + HostUI.escapeHtml(p.name) + ' - ' + p.points + ' pts' +
      (p.champPredict ? ' ★' + HostUI.escapeHtml(predName) : '') +
      (p.rankRelevant ? '' : ' [観戦]') +
      '</li>';
  }).join('');
};

// マッチプレイヤー一覧表示
HostUI.prototype.updateMatchPlayerList = function (tournament) {
  var list = tournament.matchPlayers;
  var ul = document.getElementById('match-player-list');
  if (!ul) return;
  ul.innerHTML = list.map(function (p) {
    return '<li>' + HostUI.escapeHtml(p.name) + ' (ID: ' + p.id + ')</li>';
  }).join('');
};

// マッチ一覧表示
HostUI.prototype.updateMatchList = function (tournament) {
  // update select options
  var players = tournament.matchPlayers;
  var p1 = document.getElementById('match-player1');
  var p2 = document.getElementById('match-player2');
  if (p1 && p2) {
    var opts = '<option value="">Select...</option>';
    for (var i = 0; i < players.length; i++) {
      opts += '<option value="' + players[i].id + '">' + HostUI.escapeHtml(players[i].name) + '</option>';
    }
    p1.innerHTML = opts;
    p2.innerHTML = opts;
  }
};

// 現在のマッチ情報表示
HostUI.prototype.updateCurrentMatchInfo = function (tournament, matchId) {
  if (!matchId) {
    this.currentMatchInfo.textContent = 'No active match';
    this.betSummaryEl.innerHTML = '';
    return;
  }
  var match = tournament.getMatch(matchId);
  if (!match) {
    this.currentMatchInfo.textContent = 'No active match';
    this.betSummaryEl.innerHTML = '';
    return;
  }
  var p1Name = tournament.getPlayerName(match.player1Id);
  var p2Name = tournament.getPlayerName(match.player2Id);
  this.currentMatchInfo.innerHTML = '<strong>' + HostUI.escapeHtml(p1Name) + ' vs ' + HostUI.escapeHtml(p2Name) + '</strong>' +
    ' - Voting: ' + (match.votingOpen ? '<span style="color:#2ecc71">OPEN</span>' : '<span style="color:#e74c3c">CLOSED</span>') +
    (match.winner ? ' - Winner: ' + HostUI.escapeHtml(tournament.getPlayerName(match.winner)) : '');

  // ベット集計
  var summary = tournament.getMatchBetSummary(matchId);
  this.betSummaryEl.innerHTML = '<h3>Bet Summary</h3>' +
    '<p>' + HostUI.escapeHtml(p1Name) + ': ' + summary.player1.count + ' bets, ' + summary.player1.totalPoints + ' pts</p>' +
    '<p>' + HostUI.escapeHtml(p2Name) + ': ' + summary.player2.count + ' bets, ' + summary.player2.totalPoints + ' pts</p>';
};

// ランキング表示
HostUI.prototype.updateRanking = function (tournament) {
  var rankings = tournament.getRankings();
  var table = this.rankingEl;
  table.innerHTML = '<tr><th>#</th><th>Name</th><th>Points</th><th>Prediction</th></tr>' +
    rankings.map(function (r, i) {
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + HostUI.escapeHtml(r.name) + '</td>' +
        '<td>' + r.points + '</td>' +
        '<td>' + HostUI.escapeHtml(r.champPredictName) + '</td>' +
        '</tr>';
    }).join('');
};

// ===== メイン処理 =====
function startHost() {
  var container = document.getElementById('app');
  var ui = new HostUI(container);
  var hostInstance = null;

  function attempt(retriesLeft) {
    if (retriesLeft <= 0) { ui.showError('Failed to create room after multiple attempts'); return; }
    var roomCode = generateRoomCode();
    ui.displayRoomCode(roomCode);

    var callbacks = {
      onError: function (msg) { console.error('Host error:', msg); },
      onReady: function (_peerId) {
        console.log('Host ready');
        ui.tournamentStatusEl = document.getElementById('tournament-controls');
        hostInstance = host;
        ui.updateTournamentControls(host.tournament, host);
      },
      onPlayerJoined: function (_player) {
        ui.updatePlayers(host.getPlayers());
        ui.updateViewers(host.getViewerCount());
        ui.updateParticipantList(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onPlayerLeft: function (_peerId) {
        ui.updatePlayers(host.getPlayers());
        ui.updateParticipantList(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onViewerJoined: function (_peerId) {
        ui.updateViewers(host.getViewerCount());
        ui.updateParticipantList(host.tournament);
      },
      onViewerLeft: function (_peerId) {
        ui.updateViewers(host.getViewerCount());
        ui.updateParticipantList(host.tournament);
      },
      onVoteResultUpdated: function (results) { ui.updateResults(results); },
      onTournamentUpdate: function () {
        ui.updateParticipantList(host.tournament);
        ui.updateRanking(host.tournament);
        ui.updateTournamentControls(host.tournament, host);
      }
    };

    var host = new HostPeer(roomCode, callbacks);
    host.start().then(function () {
      // マッチプレイヤー追加ボタン
      document.getElementById('add-player-btn').addEventListener('click', function () {
        var input = document.getElementById('new-player-name');
        var name = input.value.trim();
        if (name) {
          var id = 'mp-' + Date.now();
          host.tournament.matchPlayers.push({ id: id, name: name });
          ui.updateMatchPlayerList(host.tournament);
          ui.updateMatchList(host.tournament);
          input.value = '';
        }
      });
      // マッチ追加ボタン
      document.getElementById('add-match-btn').addEventListener('click', function () {
        var p1 = document.getElementById('match-player1');
        var p2 = document.getElementById('match-player2');
        if (p1.value && p2.value && p1.value !== p2.value) {
          host.tournament.addMatch(p1.value, p2.value);
          ui.updateMatchList(host.tournament);
          ui.updateTournamentControls(host.tournament, host);
        }
      });
    }).catch(function () {
      host.destroy();
      ui.showError('Room code conflict, retrying... (' + (10 - retriesLeft + 1) + '/10)');
      attempt(retriesLeft - 1);
    });
  }

  attempt(10);
}

startHost();
