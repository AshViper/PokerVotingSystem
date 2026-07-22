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
    points: 50,
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
        p.points += 30; // ボーナス
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
  this.participantListEl = document.getElementById('participant-list');
  this.participantCountEl = document.getElementById('participant-count');
  this.rankingEl = document.getElementById('host-ranking');
  this.matchAreaEl = document.getElementById('match-area');
  this.statusEl = document.getElementById('host-status');
}
HostUI.prototype.render = function () {
  this.container.innerHTML = [
    '<div class="host-view">',
    '  <div class="header-row">',
    '    <div class="room-block">',
    '      <div class="room-label">Room Code</div>',
    '      <div id="host-room-code" class="room-code">---</div>',
    '    </div>',
    '    <div id="host-qr-code" class="qr-code"></div>',
    '  </div>',
    '  <div class="section">',
    '    <div class="section-title">Participants (<span id="participant-count">0</span>)</div>',
    '    <div id="participant-list" class="participant-grid"></div>',
    '  </div>',
    '  <div class="section">',
    '    <div class="section-title">Match Control</div>',
    '    <div id="match-area" class="match-card">',
    '      <div class="empty-state">No match. Add players and create matches below.</div>',
    '    </div>',
    '  </div>',
    '  <div class="section">',
    '    <div class="section-title">Setup</div>',
    '    <div class="setup-row">',
    '      <input type="text" id="new-player-name" placeholder="Player name (ex: Alice)" />',
    '      <button id="add-player-btn">Add Player</button>',
    '    </div>',
    '    <select id="match-player1"></select>',
    '    <span style="color:#888;margin:0 4px">vs</span>',
    '    <select id="match-player2"></select>',
    '    <button id="add-match-btn">Create Match</button>',
    '  </div>',
    '  <div class="section">',
    '    <div class="section-title">Rankings</div>',
    '    <table id="host-ranking" class="rank-table">',
    '      <tr><th>#</th><th>Name</th><th>Points</th><th>Prediction</th></tr>',
    '    </table>',
    '  </div>',
    '  <div id="host-status" class="status"></div>',
    '</div>'
  ].join('');
};
HostUI.prototype.displayRoomCode = function (code) {
  this.roomCodeElement.textContent = code;
  var viewerUrl = buildViewerUrl(code);
  if (typeof QRCode !== 'undefined') {
    this.qrContainer.innerHTML = '';
    new QRCode(this.qrContainer, { text: viewerUrl, width: 180, height: 180 });
  } else { this.qrContainer.innerHTML = '<p>QR not available</p>'; }
};
HostUI.prototype.showError = function (message) {
  if (this.statusEl) { this.statusEl.textContent = message; this.statusEl.className = 'status error'; }
};
HostUI.escapeHtml = function (text) { var div = document.createElement('div'); div.textContent = text; return div.innerHTML; };

// 参加者一覧
HostUI.prototype.updateParticipantList = function (tournament) {
  var list = tournament.getAllParticipants();
  this.participantCountEl.textContent = list.length;
  this.participantListEl.innerHTML = list.map(function (p) {
    return '<div class="participant-chip' + (p.rankRelevant ? '' : ' spectator') + '">' +
      HostUI.escapeHtml(p.name) +
      ' <span class="pts">' + p.points + 'pts</span>' +
      '</div>';
  }).join('');
};

// マッチエリア更新（投票開始/終了、勝者登録）
HostUI.prototype.updateMatchArea = function (tournament, host) {
  var self = this;
  var state = tournament.getState();
  var el = this.matchAreaEl;

  if (state.status === 'idle') {
    el.innerHTML = '<div class="empty-state">Start tournament to begin.</div>' +
      '<button id="btn-start-tournament" class="btn-primary">Start Tournament</button>';
    var btn = document.getElementById('btn-start-tournament');
    if (btn) {
      btn.addEventListener('click', function () {
        host.tournament.openChampionshipPredict();
        host.broadcastTournamentState();
        self.updateMatchArea(tournament, host);
      });
    }
    return;
  }

  if (state.champPredictOpen) {
    el.innerHTML = '<div class="match-status">Championship predictions open — waiting for participants...</div>' +
      '<button id="btn-close-predict" class="btn-primary">Close Predictions</button>';
    var btn = document.getElementById('btn-close-predict');
    if (btn) {
      btn.addEventListener('click', function () {
        host.tournament.closeChampionshipPredict();
        host.broadcastTournamentState();
        host.broadcastRanking();
        self.updateMatchArea(tournament, host);
        self.updateRanking(tournament);
      });
    }
    return;
  }

  if (state.status === 'finished') {
    var winnerName = tournament.getPlayerName(state.tournamentWinnerId);
    el.innerHTML = '<div class="match-status">Tournament Finished! Winner: <strong>' +
      HostUI.escapeHtml(winnerName) + '</strong></div>';
    return;
  }

  // inProgress: show match controls
  var activeMatch = null;
  var activeIdx = -1;
  for (var i = 0; i < state.matches.length; i++) {
    if (state.matches[i].winner === null) { activeMatch = state.matches[i]; activeIdx = i; break; }
  }

  if (!activeMatch) {
    el.innerHTML = '<div class="match-status">All matches completed. ' +
      '<button id="btn-finish-tournament" class="btn-primary">Finish Tournament</button></div>';
    var btn = document.getElementById('btn-finish-tournament');
    if (btn) {
      btn.addEventListener('click', function () {
        var id = prompt('Tournament winner Player ID:');
        if (id) { host.tournament.setTournamentWinner(id); host.broadcastTournamentState(); host.broadcastRanking(); self.updateMatchArea(tournament, host); self.updateRanking(tournament); }
      });
    }
    return;
  }

  var p1Name = tournament.getPlayerName(activeMatch.player1Id);
  var p2Name = tournament.getPlayerName(activeMatch.player2Id);

  var html = '<div class="match-vs"><span class="player-name">' + HostUI.escapeHtml(p1Name) + '</span>' +
    '<span class="vs-text">VS</span>' +
    '<span class="player-name">' + HostUI.escapeHtml(p2Name) + '</span></div>';

  html += '<div class="match-actions">';
  html += '<button id="btn-toggle-vote" class="btn-vote-' + (activeMatch.votingOpen ? 'close' : 'open') + '">' +
    (activeMatch.votingOpen ? 'Close Voting' : 'Open Voting') + '</button>';
  html += '</div>';

  html += '<div class="winner-row">';
  html += '<select id="sel-winner" class="winner-select">';
  html += '<option value="">— Select winner —</option>';
  html += '<option value="' + activeMatch.player1Id + '">' + HostUI.escapeHtml(p1Name) + '</option>';
  html += '<option value="' + activeMatch.player2Id + '">' + HostUI.escapeHtml(p2Name) + '</option>';
  html += '</select>';
  html += '<button id="btn-register-winner" class="btn-primary">Register Winner</button>';
  html += '</div>';

  // bet summary
  var summary = tournament.getMatchBetSummary(activeMatch.id);
  html += '<div class="bet-summary">';
  html += '<div>' + HostUI.escapeHtml(p1Name) + ': <strong>' + summary.player1.count + ' bets</strong> (' + summary.player1.totalPoints + ' pts)</div>';
  html += '<div>' + HostUI.escapeHtml(p2Name) + ': <strong>' + summary.player2.count + ' bets</strong> (' + summary.player2.totalPoints + ' pts)</div>';
  html += '</div>';

  // all matches indicator
  html += '<div class="match-progress">Match ' + (activeIdx + 1) + ' / ' + state.matches.length + '</div>';

  el.innerHTML = html;

  // events
  var voteBtn = document.getElementById('btn-toggle-vote');
  if (voteBtn) {
    voteBtn.addEventListener('click', function () {
      if (activeMatch.votingOpen) { host.tournament.closeVoting(activeMatch.id); }
      else { host.tournament.openVoting(activeMatch.id); }
      host.broadcastTournamentState();
      self.updateMatchArea(tournament, host);
    });
  }

  var winnerBtn = document.getElementById('btn-register-winner');
  if (winnerBtn) {
    winnerBtn.addEventListener('click', function () {
      var sel = document.getElementById('sel-winner');
      if (sel && sel.value) {
        host.tournament.setMatchWinner(activeMatch.id, sel.value);
        host.broadcastTournamentState();
        host.broadcastRanking();
        self.updateMatchArea(tournament, host);
        self.updateRanking(tournament);
      }
    });
  }
};

// ランキング
HostUI.prototype.updateRanking = function (tournament) {
  var rankings = tournament.getRankings();
  this.rankingEl.innerHTML = '<tr><th>#</th><th>Name</th><th>Points</th><th>Prediction</th></tr>' +
    rankings.map(function (r, i) {
      return '<tr class="rank-row' + (i < 3 ? ' top-' + (i + 1) : '') + '">' +
        '<td class="rank-num">' + (i + 1) + '</td>' +
        '<td>' + HostUI.escapeHtml(r.name) + '</td>' +
        '<td class="pts">' + r.points + '</td>' +
        '<td>' + HostUI.escapeHtml(r.champPredictName) + '</td>' +
        '</tr>';
    }).join('');
};

// ===== メイン処理 =====
function startHost() {
  var container = document.getElementById('app');
  var ui = new HostUI(container);

  function attempt(retriesLeft) {
    if (retriesLeft <= 0) { ui.showError('Failed to create room after multiple attempts'); return; }
    var roomCode = generateRoomCode();
    ui.displayRoomCode(roomCode);

    var callbacks = {
      onError: function (msg) { console.error('Host error:', msg); },
      onReady: function (_peerId) {
        console.log('Host ready');
        ui.updateMatchArea(host.tournament, host);
        ui.updateParticipantList(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onPlayerJoined: function (_player) {
        ui.updateParticipantList(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onPlayerLeft: function (_peerId) {
        ui.updateParticipantList(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onViewerJoined: function (_peerId) {
        ui.updateParticipantList(host.tournament);
      },
      onViewerLeft: function (_peerId) {
        ui.updateParticipantList(host.tournament);
      },
      onVoteResultUpdated: function (_results) {},
      onTournamentUpdate: function () {
        ui.updateParticipantList(host.tournament);
        ui.updateRanking(host.tournament);
        ui.updateMatchArea(host.tournament, host);
      }
    };

    var host = new HostPeer(roomCode, callbacks);
    host.start().then(function () {
      document.getElementById('add-player-btn').addEventListener('click', function () {
        var input = document.getElementById('new-player-name');
        var name = input.value.trim();
        if (name) {
          host.tournament.matchPlayers.push({ id: 'mp-' + Date.now(), name: name });
          ui.updateMatchListSelects(host.tournament);
          input.value = '';
        }
      });
      document.getElementById('add-match-btn').addEventListener('click', function () {
        var p1 = document.getElementById('match-player1');
        var p2 = document.getElementById('match-player2');
        if (p1.value && p2.value && p1.value !== p2.value) {
          host.tournament.addMatch(p1.value, p2.value);
          ui.updateMatchArea(host.tournament, host);
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

// マッチ作成用セレクトボックス更新
HostUI.prototype.updateMatchListSelects = function (tournament) {
  var players = tournament.matchPlayers;
  var p1 = document.getElementById('match-player1');
  var p2 = document.getElementById('match-player2');
  if (!p1 || !p2) return;
  var opts = '<option value="">Select player...</option>';
  for (var i = 0; i < players.length; i++) {
    opts += '<option value="' + players[i].id + '">' + HostUI.escapeHtml(players[i].name) + '</option>';
  }
  p1.innerHTML = opts;
  p2.innerHTML = opts;
};

startHost();
