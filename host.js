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
    var viewerUrl = new URL('voter.html', window.location.href);
    viewerUrl.searchParams.set('room', roomCode);
    return viewerUrl.toString();
  } catch (e) {
    return 'voter.html?room=' + encodeURIComponent(roomCode);
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
    var viewerName = (packet.name && packet.name.trim()) ? packet.name.trim() : 'Viewer';
    this.tournament.addParticipant(remoteId, viewerName);
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
  this.qrContainer = document.getElementById('host-qr');
  this.participantListEl = document.getElementById('participant-list');
  this.participantCountEl = document.getElementById('participant-count');
  this.rankingEl = document.getElementById('rank-list');
  this.matchAreaEl = document.getElementById('match-area');
  this.setupNameInput = document.getElementById('setup-name');
  this.setupP1 = document.getElementById('setup-p1');
  this.setupP2 = document.getElementById('setup-p2');
}
HostUI.prototype.render = function () {
  this.container.innerHTML = [
    '<div class="host-page">',
    '  <div class="host-header">',
    '    <div class="host-title">',
    '      <h1>🎮 Host</h1>',
    '      <div class="subtitle">Tournament Controller</div>',
    '    </div>',
    '    <div class="room-code-box">',
    '      <div class="label">Room Code</div>',
    '      <div id="host-room-code" class="code">---</div>',
    '    </div>',
    '  </div>',
    '  <div class="card" style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: 1.25rem;">',
    '    <div style="flex: 1; min-width: 200px;">',
    '      <h2 style="font-size: 1.1rem; margin-bottom: 0.25rem;">📱 Scan to Vote</h2>',
    '      <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4; margin-bottom: 0;">Scan this QR code to join the voting booth and place predictions.</p>',
    '    </div>',
    '    <div class="qr-area" id="host-qr" style="margin: 0; padding: 0.4rem; background: #fff; border-radius: var(--radius-md);"></div>',
    '  </div>',
    '  <div class="card">',
    '    <div class="card-header">',
    '      <div class="section-label">👥 Participants (<span id="participant-count">0</span>)</div>',
    '    </div>',
    '    <div id="participant-list" class="player-chips"></div>',
    '  </div>',
    '  <div class="section-label">🎯 Match Control</div>',
    '  <div id="match-area" class="match-card">',
    '    <div class="empty-state"><div class="icon">📋</div><p>Add players and create a match to begin</p></div>',
    '  </div>',
    '  <div class="section-label">⚙️ Setup</div>',
    '  <div class="card">',
    '    <div class="setup-group">',
    '      <input type="text" id="setup-name" placeholder="Player name (e.g. Alice)" />',
    '      <button id="btn-add-player" class="btn btn-primary">Add</button>',
    '    </div>',
    '    <div class="setup-group">',
    '      <select id="setup-p1"><option value="">Select player 1</option></select>',
    '      <span style="color:var(--text-muted);display:flex;align-items:center">vs</span>',
    '      <select id="setup-p2"><option value="">Select player 2</option></select>',
    '      <button id="btn-add-match" class="btn btn-green">Create Match</button>',
    '    </div>',
    '  </div>',
    '  <div class="section-label">🏆 Rankings</div>',
    '  <div class="card">',
    '    <ul id="rank-list" class="rank-list"></ul>',
    '  </div>',
    '  <div id="host-status" class="status" style="margin-top:0.5rem"></div>',
    '</div>'
  ].join('');
};
HostUI.prototype.displayRoomCode = function (code) {
  this.roomCodeElement.textContent = code;
  var url = buildViewerUrl(code);
  if (typeof QRCode !== 'undefined') {
    this.qrContainer.innerHTML = '';
    new QRCode(this.qrContainer, { text: url, width: 160, height: 160 });
  } else { this.qrContainer.innerHTML = '<p style="color:var(--text-muted)">QR not available</p>'; }
};
HostUI.prototype.showError = function (msg) {
  var e = document.getElementById('host-status');
  if (e) { e.textContent = msg; e.className = 'status status-error'; }
};
HostUI.escapeHtml = function (t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

// 参加者一覧
HostUI.prototype.updateParticipants = function (tournament) {
  var list = tournament.getAllParticipants();
  this.participantCountEl.textContent = list.length;
  this.participantListEl.innerHTML = list.map(function (p) {
    return '<span class="chip' + (p.rankRelevant ? '' : ' eliminated') + '">' +
      HostUI.escapeHtml(p.name) + ' <span class="pts">' + p.points + 'P</span></span>';
  }).join('');
};

// マッチエリア
HostUI.prototype.updateMatchArea = function (tournament, host) {
  var self = this;
  var st = tournament.getState();
  var el = this.matchAreaEl;
  if (st.status === 'idle') {
    el.innerHTML = '<div class="empty-state"><div class="icon">🚀</div><p>Ready! Start the tournament when players are ready.</p></div>' +
      '<button id="btn-start" class="btn btn-primary btn-block btn-lg" style="margin-top:0.5rem">🎮 大会開始 (Start Tournament)</button>';
    var b = document.getElementById('btn-start');
    if (b) b.addEventListener('click', function () { host.tournament.openChampionshipPredict(); host.broadcastTournamentState(); self.updateMatchArea(tournament, host); });
    return;
  }
  if (st.champPredictOpen) {
    el.innerHTML = '<div class="status status-info">📢 Championship predictions are open</div>' +
      '<button id="btn-close" class="btn btn-primary btn-block" style="margin-top:0.5rem">🔒 予想締切 (Close Predictions)</button>';
    var b = document.getElementById('btn-close');
    if (b) b.addEventListener('click', function () { host.tournament.closeChampionshipPredict(); host.broadcastTournamentState(); host.broadcastRanking(); self.updateMatchArea(tournament, host); self.updateRanking(tournament); });
    return;
  }
  if (st.status === 'finished') {
    var wn = tournament.getPlayerName(st.tournamentWinnerId);
    el.innerHTML = '<div class="status status-success">🏆 Tournament Finished! Winner: <strong>' + HostUI.escapeHtml(wn) + '</strong></div>';
    return;
  }
  // inProgress
  var am = null, ai = -1;
  for (var i = 0; i < st.matches.length; i++) { if (st.matches[i].winner === null) { am = st.matches[i]; ai = i; break; } }
  if (!am) {
    el.innerHTML = '<div class="status status-info">All matches complete.</div>' +
      '<button id="btn-finish" class="btn btn-primary btn-block" style="margin-top:0.5rem">🏁 大会終了 (Finish Tournament)</button>';
    var b = document.getElementById('btn-finish');
    if (b) b.addEventListener('click', function () {
      var id = prompt('大会の優勝者ID（Player ID）を入力してください:');
      if (id) { host.tournament.setTournamentWinner(id); host.broadcastTournamentState(); host.broadcastRanking(); self.updateMatchArea(tournament, host); self.updateRanking(tournament); }
    });
    return;
  }
  var p1 = tournament.getPlayerName(am.player1Id);
  var p2 = tournament.getPlayerName(am.player2Id);
  var html = '<div class="matchup"><span class="name">' + HostUI.escapeHtml(p1) + '</span><span class="vs">VS</span><span class="name">' + HostUI.escapeHtml(p2) + '</span></div>';
  html += '<div class="control-group">';
  html += '<button id="btn-vote-toggle" class="btn ' + (am.votingOpen ? 'btn-red' : 'btn-green') + '">' + (am.votingOpen ? '🔴 投票終了 (Close Voting)' : '🟢 投票開始 (Open Voting)') + '</button>';
  html += '</div>';
  html += '<div class="winner-group">';
  html += '<select id="sel-winner">';
  html += '<option value="">— 勝者を選択 —</option>';
  html += '<option value="' + am.player1Id + '">' + HostUI.escapeHtml(p1) + '</option>';
  html += '<option value="' + am.player2Id + '">' + HostUI.escapeHtml(p2) + '</option>';
  html += '</select>';
  html += '<button id="btn-winner" class="btn btn-primary">🏆 勝者を発表 (Register Winner)</button>';
  html += '</div>';
  var sum = tournament.getMatchBetSummary(am.id);
  html += '<div class="bet-stats"><span>' + HostUI.escapeHtml(p1) + ': <strong>' + sum.player1.count + '</strong>票 (' + sum.player1.totalPoints + 'P)</span><span>' + HostUI.escapeHtml(p2) + ': <strong>' + sum.player2.count + '</strong>票 (' + sum.player2.totalPoints + 'P)</span></div>';
  html += '<div class="match-progress">Match ' + (ai + 1) + ' / ' + st.matches.length + '</div>';
  el.innerHTML = html;

  var vb = document.getElementById('btn-vote-toggle');
  if (vb) vb.addEventListener('click', function () {
    if (am.votingOpen) host.tournament.closeVoting(am.id); else host.tournament.openVoting(am.id);
    host.broadcastTournamentState(); self.updateMatchArea(tournament, host);
  });
  var wb = document.getElementById('btn-winner');
  if (wb) wb.addEventListener('click', function () {
    var s = document.getElementById('sel-winner');
    if (s && s.value) { host.tournament.setMatchWinner(am.id, s.value); host.broadcastTournamentState(); host.broadcastRanking(); self.updateMatchArea(tournament, host); self.updateRanking(tournament); }
  });
};

// ランキング
HostUI.prototype.updateRanking = function (tournament) {
  var r = tournament.getRankings();
  this.rankingEl.innerHTML = r.length === 0
    ? '<li style="color:var(--text-muted);text-align:center;padding:0.5rem">No rankings yet</li>'
    : r.map(function (p, i) {
        var cls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : 'normal';
        return '<li class="rank-item"><span class="rank-num ' + cls + '">' + (i + 1) + '</span><span class="rank-name">' + HostUI.escapeHtml(p.name) + '</span><span class="rank-pts">' + p.points + 'P</span><span class="rank-pred">🎯 ' + HostUI.escapeHtml(p.champPredictName) + '</span></li>';
      }).join('');
};

// Setupセレクトボックス更新
HostUI.prototype.updateSetupSelects = function (tournament) {
  var ps = tournament.matchPlayers;
  var opts = '<option value="">Select...</option>';
  for (var i = 0; i < ps.length; i++) opts += '<option value="' + ps[i].id + '">' + HostUI.escapeHtml(ps[i].name) + '</option>';
  if (this.setupP1) this.setupP1.innerHTML = opts;
  if (this.setupP2) this.setupP2.innerHTML = opts;
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
        ui.updateParticipants(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onPlayerJoined: function (player) {
        var exists = false;
        for (var i = 0; i < host.tournament.matchPlayers.length; i++) {
          if (host.tournament.matchPlayers[i].id === player.peerId) { exists = true; break; }
        }
        if (!exists) {
          host.tournament.matchPlayers.push({ id: player.peerId, name: player.name });
          ui.updateSetupSelects(host.tournament);
        }
        ui.updateParticipants(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onPlayerLeft: function (_peerId) {
        ui.updateParticipants(host.tournament);
        ui.updateRanking(host.tournament);
      },
      onViewerJoined: function (_peerId) {
        ui.updateParticipants(host.tournament);
      },
      onViewerLeft: function (_peerId) {
        ui.updateParticipants(host.tournament);
      },
      onVoteResultUpdated: function (_results) {},
      onTournamentUpdate: function () {
        ui.updateParticipants(host.tournament);
        ui.updateRanking(host.tournament);
        ui.updateMatchArea(host.tournament, host);
      }
    };

    var host = new HostPeer(roomCode, callbacks);
    host.start().then(function () {
      document.getElementById('btn-add-player').addEventListener('click', function () {
        var input = document.getElementById('setup-name');
        var name = input.value.trim();
        if (name) {
          host.tournament.matchPlayers.push({ id: 'mp-' + Date.now(), name: name });
          ui.updateSetupSelects(host.tournament);
          input.value = '';
        }
      });
      document.getElementById('btn-add-match').addEventListener('click', function () {
        var p1 = document.getElementById('setup-p1');
        var p2 = document.getElementById('setup-p2');
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
