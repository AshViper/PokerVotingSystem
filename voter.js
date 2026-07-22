// ===== パケットユーティリティ =====
function isRecord(data) { return typeof data === 'object' && data !== null; }
function isPacket(data) { if (!isRecord(data)) return false; if (typeof data.type !== 'string') return false; return true; }
function parseMessage(data) { if (!isPacket(data)) return null; return data; }
function createJoinPacket(role, name) {
  if (role === 'player' && name) { return { type: 'join', role: 'player', name: name }; }
  return { type: 'join', role: 'viewer' }; }
function createVotePacket(target) { return { type: 'vote', target: target }; }
function createChampionshipPredictPacket(target) { return { type: 'championshipPredict', target: target }; }
function createBetPacket(matchId, target, points) { return { type: 'bet', matchId: matchId, target: target, points: points }; }
function getHostPeerId(roomCode) { return 'poker-' + roomCode; }

// ===== ViewerPeer =====
function ViewerPeer(roomCode, name, callbacks) {
  this.peerInstance = null;
  this.callbacks = callbacks;
  this.roomCode = roomCode;
  this.playerName = name;
  this.hostConnection = null;
  this.connectedFlag = false;
}
ViewerPeer.prototype.createPeer = function (id) {
  var self = this;
  return new Promise(function (resolve, reject) {
    try {
      var p = id !== undefined ? new Peer(id) : new Peer();
      p.on('open', function (aid) { self.peerInstance = p; resolve(aid); });
      p.on('error', function (err) { self.callbacks.onError(err.message); reject(err); });
    } catch (err) { reject(err); }
  });
};
ViewerPeer.prototype.start = function () {
  var self = this;
  return this.createPeer().then(function () { return self.connectToHost(); });
};
ViewerPeer.prototype.connectToHost = function () {
  var self = this;
  if (this.peerInstance === null) return Promise.reject(new Error('Peer not initialized'));
  var hostId = getHostPeerId(this.roomCode);
  return new Promise(function (resolve, reject) {
    var conn = self.peerInstance.connect(hostId);
    conn.on('open', function () {
      self.hostConnection = conn;
      self.connectedFlag = true;
      conn.send(createJoinPacket('viewer'));
      conn.on('data', function (data) {
        var pkt = parseMessage(data);
        if (!pkt) return;
        if (pkt.type === 'tournamentState') self.callbacks.onTournamentState(pkt.state);
        if (pkt.type === 'ranking') self.callbacks.onRankingUpdate(pkt.rankings);
        if (pkt.type === 'disconnect') self.handleDisconnect();
      });
      conn.on('close', function () { self.handleDisconnect(); });
      self.callbacks.onConnected();
      resolve();
    });
    conn.on('error', function (err) { self.callbacks.onError(err.message); reject(err); });
  });
};
ViewerPeer.prototype.handleDisconnect = function () {
  this.connectedFlag = false;
  if (this.hostConnection !== null) { this.hostConnection.close(); this.hostConnection = null; }
  this.callbacks.onHostDisconnected();
};
ViewerPeer.prototype.send = function (data) {
  if (this.hostConnection && this.hostConnection.open) { this.hostConnection.send(data); return true; }
  return false;
};
ViewerPeer.prototype.destroy = function () {
  if (this.hostConnection !== null && this.hostConnection.open) { this.hostConnection.close(); }
  this.hostConnection = null; this.connectedFlag = false;
  if (this.peerInstance !== null) { this.peerInstance.destroy(); this.peerInstance = null; }
};
Object.defineProperty(ViewerPeer.prototype, 'connected', { get: function () { return this.connectedFlag; } });

// ===== VoterUI (Bettin Screen) =====
function VoterUI(container) {
  this.container = container;
  this.viewer = null;
  this.state = null;
  this.rankings = [];
  this.renderEntry();
}
VoterUI.prototype.renderEntry = function () {
  var self = this;
  var p = new URLSearchParams(window.location.search);
  var rc = p.get('room') || '';
  this.container.innerHTML = [
    '<div class="join-page">',
    '  <div class="brand-icon">🎲</div>',
    '  <h1>Voting Booth</h1>',
    '  <p class="subtitle">Bet points on your favorite players</p>',
    '  <div class="join-card">',
    '    <div class="field">',
    '      <label>📋 Room Code</label>',
    '      <input type="text" id="voter-code" value="' + HostUI_escapeHtml(rc) + '" placeholder="e.g. ABC123" maxlength="6" style="text-transform:uppercase;letter-spacing:0.3rem;text-align:center;font-weight:700" />',
    '    </div>',
    '    <div class="field">',
    '      <label>👤 Your Name (optional)</label>',
    '      <input type="text" id="voter-name" placeholder="Enter nickname" />',
    '    </div>',
    '    <button id="voter-join-btn" class="btn btn-primary btn-block btn-lg">Enter Booth</button>',
    '    <div id="voter-status" class="status" style="margin-top:0.75rem"></div>',
    '  </div>',
    '</div>'
  ].join('');
  document.getElementById('voter-join-btn').addEventListener('click', function () {
    var code = document.getElementById('voter-code').value.trim().toUpperCase();
    var name = document.getElementById('voter-name').value.trim();
    if (code) self.connect(code, name);
    else self.showError('Please enter a room code');
  });
  if (rc) setTimeout(function () { document.getElementById('voter-join-btn').click(); }, 100);
};
VoterUI.prototype.connect = function (code, name) {
  var self = this;
  this.container.innerHTML = '<div class="connected-panel"><h2>Connecting...</h2></div>';
  var callbacks = {
    onError: function (msg) { self.showError(msg); },
    onConnected: function () { self.renderVoting(); },
    onHostDisconnected: function () { self.renderEntry(); self.showError('Disconnected from host'); },
    onTournamentState: function (st) { self.state = st; self.renderVoting(); },
    onRankingUpdate: function (r) { self.rankings = r; self.renderVoting(); }
  };
  this.viewer = new ViewerPeer(code, name, callbacks);
  this.viewer.start().catch(function (err) { self.showError('Connection failed: ' + err.message); });
};
VoterUI.prototype.showError = function (msg) {
  var el = document.getElementById('voter-status');
  if (el) { el.textContent = msg; el.className = 'status status-error'; }
};
VoterUI.prototype.renderVoting = function () {
  if (!this.state) {
    this.container.innerHTML = '<div class="connected-panel"><div class="spinner"></div><h2>Waiting for game data...</h2></div>';
    return;
  }
  var st = this.state;
  var r = this.rankings;
  var html = '<div class="voter-page">';
  html += '<div class="voter-header"><h1>🎲 Voting Booth</h1><div class="room-badge">' + HostUI_escapeHtml(this.viewer.roomCode) + '</div></div>';

  // Championship prediction
  if (st.champPredictOpen) {
    html += '<div class="card"><div class="card-header"><div class="section-label">🏆 Championship Prediction</div></div>';
    html += '<p style="color:var(--text-muted);margin-bottom:0.75rem;padding:0 0.75rem">Who will be the champion? Select below.</p>';
    html += '<div class="player-cards" id="predict-options">';
    var participants = st.participants || {};
    var keys = Object.keys(participants);
    if (keys.length === 0) {
      html += '<p style="color:var(--text-muted);text-align:center">No participants yet</p>';
    } else {
      for (var pi = 0; pi < keys.length; pi++) {
        html += '<div class="player-card" data-player="' + keys[pi] + '"><div class="player-card-name">' + HostUI_escapeHtml(participants[keys[pi]].name) + '</div><div class="player-card-status">Select</div></div>';
      }
    }
    html += '</div>';
    html += '<button id="btn-submit-predict" class="btn btn-primary btn-block btn-lg" disabled>Submit Prediction</button>';
    html += '</div>';
  }

  // Active match voting
  if (st.status === 'inProgress' && st.matches) {
    for (var i = 0; i < st.matches.length; i++) {
      var m = st.matches[i];
      if (m.winner !== null) continue;
      var p1Name = this.getPlayerName(m.player1Id);
      var p2Name = this.getPlayerName(m.player2Id);
      html += '<div class="card"><div class="card-header"><div class="section-label">⚔️ Match ' + (i + 1) + '</div></div>';
      if (m.votingOpen) {
        html += '<p class="subtitle" style="padding:0 0.75rem;font-size:0.85rem">Select your winner and bet points</p>';
        html += '<div class="player-cards" id="match-options-' + i + '">';
        html += this.buildPlayerCard(m.player1Id, p1Name, m.id);
        html += this.buildPlayerCard(m.player2Id, p2Name, m.id);
        html += '</div>';
        html += '<div class="field" style="padding:0.75rem"><label>💰 Bet Points</label>';
        html += '<div class="point-buttons">';
        var pts = [10, 25, 50, 100];
        for (var pi = 0; pi < pts.length; pi++) {
          html += '<button class="btn btn-point' + (pts[pi] === 50 ? ' active' : '') + '" data-points="' + pts[pi] + '">' + pts[pi] + 'P</button>';
        }
        html += '</div></div>';
        html += '<button id="btn-submit-bet" class="btn btn-primary btn-block btn-lg" disabled>Select a player</button>';
      } else {
        html += '<div class="status status-info">🔴 Voting is closed for this match</div>';
      }
      html += '</div>';
    }
  }

  // Rankings
  html += '<div class="card"><div class="card-header"><div class="section-label">🏆 Rankings</div></div>';
  if (r.length === 0) {
    html += '<p style="color:var(--text-muted);padding:0.5rem;text-align:center">No rankings yet</p>';
  } else {
    html += '<ul class="rank-list">';
    for (var ri = 0; ri < r.length; ri++) {
      var cls = ri === 0 ? 'gold' : ri === 1 ? 'silver' : ri === 2 ? 'bronze' : 'normal';
      html += '<li class="rank-item"><span class="rank-num ' + cls + '">' + (ri + 1) + '</span><span class="rank-name">' + HostUI_escapeHtml(r[ri].name) + '</span><span class="rank-pts">' + r[ri].points + 'P</span><span class="rank-pred">🎯 ' + HostUI_escapeHtml(r[ri].champPredictName || '-') + '</span></li>';
    }
    html += '</ul>';
  }
  html += '</div>';

  html += '</div>';
  this.container.innerHTML = html;
  this.attachVotingEvents(st);
};
VoterUI.prototype.getPlayerName = function (id) {
  if (this.state && this.state.participants && this.state.participants[id]) return this.state.participants[id].name;
  return id;
};
VoterUI.prototype.buildPlayerCard = function (playerId, playerName, matchId) {
  return '<div class="player-card" data-player="' + playerId + '" data-match="' + matchId + '">' +
    '<div class="player-card-name">' + HostUI_escapeHtml(playerName) + '</div>' +
    '<div class="player-card-status">Select</div>' +
    '</div>';
};
VoterUI.prototype.attachVotingEvents = function (st) {
  var self = this;
  var selectedPlayer = null;
  var selectedMatch = null;
  var selectedPoints = 50;

  // Player cards
  var cards = this.container.querySelectorAll('.player-card');
  cards.forEach(function (c) {
    c.addEventListener('click', function () {
      cards.forEach(function (x) { x.classList.remove('selected'); });
      c.classList.add('selected');
      selectedPlayer = c.dataset.player;
      selectedMatch = c.dataset.match;
      var btn = document.getElementById('btn-submit-bet') ||
        document.getElementById('btn-submit-predict');
      if (btn) btn.disabled = false;
    });
  });

  // Point buttons
  var ptBtns = this.container.querySelectorAll('.btn-point');
  ptBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      ptBtns.forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      selectedPoints = parseInt(b.dataset.points, 10);
    });
  });

  // Submit bet
  var betBtn = document.getElementById('btn-submit-bet');
  if (betBtn) {
    betBtn.addEventListener('click', function () {
      if (selectedPlayer && selectedMatch) {
        self.viewer.send(createBetPacket(selectedMatch, selectedPlayer, selectedPoints));
        betBtn.textContent = '✅ Bet Placed!';
        betBtn.disabled = true;
        setTimeout(function () { betBtn.textContent = 'Select a player'; betBtn.disabled = true; }, 2000);
      }
    });
  }

  // Submit prediction
  var predBtn = document.getElementById('btn-submit-predict');
  if (predBtn) {
    predBtn.addEventListener('click', function () {
      if (selectedPlayer) {
        self.viewer.send(createChampionshipPredictPacket(selectedPlayer));
        predBtn.textContent = '✅ Prediction Sent!';
        predBtn.disabled = true;
      }
    });
  }
};

// Escape helper (standalone)
function HostUI_escapeHtml(t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
