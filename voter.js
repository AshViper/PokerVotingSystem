// ===== パケットユーティリティ =====
function isRecord(data) { return typeof data === 'object' && data !== null; }
function isPacket(data) { if (!isRecord(data)) return false; if (typeof data.type !== 'string') return false; return true; }
function parseMessage(data) { if (!isPacket(data)) return null; return data; }
function createJoinPacket(role, name) {
  if (role === 'player' && name) { return { type: 'join', role: 'player', name: name }; }
  if (role === 'viewer' && name) { return { type: 'join', role: 'viewer', name: name }; }
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
      conn.send(createJoinPacket('viewer', self.playerName));
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
    '  <h1>勝者予想投票</h1>',
    '  <p class="subtitle">ゲームを観戦しながら勝者を予想してポイントを増やそう！</p>',
    '  <div class="join-card">',
    '    <div class="field">',
    '      <label>📋 参加コード</label>',
    '      <input type="text" id="voter-code" value="' + HostUI_escapeHtml(rc) + '" placeholder="例: ABCDEF" maxlength="6" style="text-transform:uppercase;letter-spacing:0.3rem;text-align:center;font-weight:700" />',
    '    </div>',
    '    <div class="field">',
    '      <label>👤 あなたの名前（任意）</label>',
    '      <input type="text" id="voter-name" placeholder="例: 観戦者A" />',
    '    </div>',
    '    <button id="voter-join-btn" class="btn btn-primary btn-block btn-lg">投票所に入る</button>',
    '    <div id="voter-status" class="status" style="margin-top:0.75rem"></div>',
    '  </div>',
    '</div>'
  ].join('');
  document.getElementById('voter-join-btn').addEventListener('click', function () {
    var code = document.getElementById('voter-code').value.trim().toUpperCase();
    var name = document.getElementById('voter-name').value.trim();
    if (code) self.connect(code, name);
    else self.showError('参加コードを入力してください');
  });
  if (rc) setTimeout(function () { document.getElementById('voter-join-btn').click(); }, 100);
};
VoterUI.prototype.connect = function (code, name) {
  var self = this;
  this.container.innerHTML = '<div class="connected-panel"><div class="spinner"></div><h2>接続中...</h2></div>';
  var callbacks = {
    onError: function (msg) { self.showError(msg); },
    onConnected: function () { self.renderVoting(); },
    onHostDisconnected: function () { self.renderEntry(); self.showError('ホストとの接続が切断されました'); },
    onTournamentState: function (st) { self.state = st; self.renderVoting(); },
    onRankingUpdate: function (r) { self.rankings = r; self.renderVoting(); }
  };
  this.viewer = new ViewerPeer(code, name, callbacks);
  this.viewer.start().catch(function (err) { self.showError('接続に失敗しました: ' + err.message); });
};
VoterUI.prototype.showError = function (msg) {
  var el = document.getElementById('voter-status');
  if (el) { el.textContent = msg; el.className = 'status status-error'; }
};
VoterUI.prototype.renderVoting = function () {
  if (!this.state) {
    this.container.innerHTML = '<div class="connected-panel"><div class="spinner"></div><h2>データを読み込み中...</h2></div>';
    return;
  }
  var st = this.state;
  var r = this.rankings;
  
  // Find current spectator's points and name from rankings using peerId
  var myPoints = 50;
  var myName = '観戦者';
  var isRanked = false;
  if (this.viewer && this.viewer.peerInstance) {
    var myId = this.viewer.peerInstance.id;
    var myRank = this.rankings.find(function (item) { return item.userId === myId; });
    if (myRank) {
      myPoints = myRank.points;
      myName = myRank.name;
      isRanked = true;
    } else {
      myName = this.viewer.playerName || 'Viewer';
    }
  }

  var html = '<div class="voter-page">';
  var roomCode = this.viewer ? this.viewer.roomCode : '';
  html += '<div class="voter-header"><h1>勝者予想</h1><div class="room-badge">Room: ' + HostUI_escapeHtml(roomCode) + '</div></div>';
  
  // Late joiner / spectator warning banner
  if (st.status !== 'idle' && st.status !== 'predicting' && !isRanked) {
    html += '<div class="status status-warning" style="margin-bottom: 1rem; text-align: left;">⚠️ 優勝予想の受付終了後に参加したか、優勝予想を行わなかったため、投票およびランキングの対象外（オブザーバー）となっています。</div>';
  }
  
  // Prominent points display
  html += '<div class="points-display"><span class="pts-label">💰 所持ポイント</span><span class="pts-value">' + myPoints + ' P</span></div>';
  
  // Spectator info bar
  html += '<div class="voter-namebar">';
  html += '  <div class="avatar">👤</div>';
  html += '  <div class="vname">' + HostUI_escapeHtml(myName) + '</div>';
  html += '  <div class="room-tag">' + (isRanked ? '観戦者' : 'オブザーバー') + '</div>';
  html += '</div>';

  // Championship prediction
  if (st.champPredictOpen) {
    html += '<div class="card"><div class="card-header"><div class="section-label">🏆 優勝予想 (Championship Prediction)</div></div>';
    html += '<p style="color:var(--text-muted);margin-bottom:0.75rem;padding:0 0.75rem">この大会で誰が優勝するかを予想してください（1回のみ決定可能）。</p>';
    html += '<div class="player-cards" id="predict-options">';
    var matchPlayers = st.matchPlayers || [];
    if (matchPlayers.length === 0) {
      html += '<p style="color:var(--text-muted);text-align:center;padding:1rem">対戦プレイヤーが未登録です</p>';
    } else {
      for (var pi = 0; pi < matchPlayers.length; pi++) {
        html += '<div class="player-card" data-player="' + matchPlayers[pi].id + '"><div class="player-card-name">' + HostUI_escapeHtml(matchPlayers[pi].name) + '</div><div class="player-card-status">この人を予想</div></div>';
      }
    }
    html += '</div>';
    html += '<button id="btn-submit-predict" class="btn btn-primary btn-block btn-lg" disabled>予想を決定する</button>';
    html += '</div>';
  }

  // Active match voting
  if (st.status === 'inProgress' && st.matches) {
    for (var i = 0; i < st.matches.length; i++) {
      var m = st.matches[i];
      if (m.winner !== null) continue;
      var p1Name = this.getPlayerName(m.player1Id);
      var p2Name = this.getPlayerName(m.player2Id);
      html += '<div class="card"><div class="card-header"><div class="section-label">⚔️ マッチ ' + (i + 1) + '</div></div>';
      if (m.votingOpen) {
        html += '<div class="match-info"><span class="mname">' + HostUI_escapeHtml(p1Name) + '</span><span class="mvs">VS</span><span class="mname">' + HostUI_escapeHtml(p2Name) + '</span><span class="mstatus open">投票受付中</span></div>';
        
        if (!isRanked) {
          html += '<div class="status status-error" style="margin-top: 0.5rem; text-align: left;">🔴 優勝予想に参加しなかったため、投票は行えません</div>';
        } else {
          html += '<p class="subtitle" style="padding:0 0.75rem;font-size:0.85rem;margin-bottom:0.75rem;">勝つと予想する選手を選択し、賭けポイントを入力してください。</p>';
          html += '<div class="player-cards" id="match-options-' + i + '">';
          html += this.buildPlayerCard(m.player1Id, p1Name, m.id);
          html += this.buildPlayerCard(m.player2Id, p2Name, m.id);
          html += '</div>';
          
          // Bet Controls
          html += '<div class="bet-area">';
          html += '  <div class="bet-row">';
          html += '    <label>💰 賭けポイント</label>';
          html += '    <input type="number" id="bet-points-input" class="bet-input" value="50" min="1" max="' + myPoints + '" />';
          html += '  </div>';
          html += '  <div class="bet-row">';
          html += '    <label>🎚️ スライダー</label>';
          html += '    <div class="bet-slider-container">';
          html += '      <input type="range" id="bet-points-slider" class="bet-slider" value="50" min="1" max="' + myPoints + '" />';
          html += '    </div>';
          html += '  </div>';
          html += '  <div class="bet-row">';
          html += '    <label>⚡ プリセット</label>';
          html += '    <div class="bet-presets">';
          html += '      <button class="btn btn-point" data-points="10">10P</button>';
          html += '      <button class="btn btn-point" data-points="25">25P</button>';
          html += '      <button class="btn btn-point active" data-points="50">50P</button>';
          html += '      <button class="btn btn-point" data-points="100">100P</button>';
          html += '      <button class="btn btn-point" id="btn-all-in" data-points="all">全賭け</button>';
          html += '    </div>';
          html += '  </div>';
          html += '  <div id="bet-warning" class="status status-error" style="margin-bottom: 0.75rem; display: none;"></div>';
          html += '  <button id="btn-submit-bet" class="btn btn-primary btn-block btn-lg" disabled>選手を選択してください</button>';
          html += '</div>';
        }
      } else {
        html += '<div class="match-info"><span class="mname">' + HostUI_escapeHtml(p1Name) + '</span><span class="mvs">VS</span><span class="mname">' + HostUI_escapeHtml(p2Name) + '</span><span class="mstatus closed">投票締切</span></div>';
        html += '<div class="status status-info" style="margin-top: 0.5rem;">🔴 このマッチの投票は締め切られました</div>';
      }
      html += '</div>';
    }
  }

  // Rankings
  html += '<div class="card"><div class="card-header"><div class="section-label">🏆 ランキング (Rankings)</div></div>';
  if (r.length === 0) {
    html += '<p style="color:var(--text-muted);padding:0.5rem;text-align:center">ランキングはまだありません</p>';
  } else {
    html += '<ul class="rank-list">';
    for (var ri = 0; ri < r.length; ri++) {
      var cls = ri === 0 ? 'gold' : ri === 1 ? 'silver' : ri === 2 ? 'bronze' : 'normal';
      html += '<li class="rank-item"><span class="rank-num ' + cls + '">' + (ri + 1) + '</span><span class="rank-name">' + HostUI_escapeHtml(r[ri].name) + '</span><span class="rank-pts">' + r[ri].points + 'P</span><span class="rank-pred">🎯 予想: ' + HostUI_escapeHtml(r[ri].champPredictName || '-') + '</span></li>';
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

  // Fetch current spectator's points from rankings using peerId
  var myPoints = 50;
  if (this.viewer && this.viewer.peerInstance) {
    var myId = this.viewer.peerInstance.id;
    var myRank = this.rankings.find(function (item) { return item.userId === myId; });
    if (myRank) myPoints = myRank.points;
  }

  // Player cards selection
  var cards = this.container.querySelectorAll('.player-card');
  cards.forEach(function (c) {
    c.addEventListener('click', function () {
      cards.forEach(function (x) { x.classList.remove('selected'); });
      c.classList.add('selected');
      selectedPlayer = c.dataset.player;
      selectedMatch = c.dataset.match;
      validateBet();
    });
  });

  // Bet validator function
  var validateBet = function () {
    var btn = document.getElementById('btn-submit-bet');
    var warningEl = document.getElementById('bet-warning');
    
    // Championship prediction phase has no points bet validation
    var predBtn = document.getElementById('btn-submit-predict');
    if (predBtn) {
      if (selectedPlayer) predBtn.disabled = false;
      return;
    }
    
    if (!btn) return;
    
    if (!selectedPlayer) {
      btn.disabled = true;
      btn.textContent = '選手を選択してください';
      if (warningEl) warningEl.style.display = 'none';
      return;
    }
    
    if (myPoints <= 0) {
      btn.disabled = true;
      btn.textContent = 'ポイント不足';
      if (warningEl) {
        warningEl.textContent = '所持ポイントが0のため投票できません。';
        warningEl.style.display = 'flex';
      }
      return;
    }
    
    if (selectedPoints > myPoints) {
      btn.disabled = true;
      btn.textContent = 'ポイント不足';
      if (warningEl) {
        warningEl.textContent = '所持ポイント以上のポイントを賭けることはできません。';
        warningEl.style.display = 'flex';
      }
      return;
    }
    
    btn.disabled = false;
    btn.textContent = '投票する';
    if (warningEl) warningEl.style.display = 'none';
  };

  // Inputs synchronization
  var pointsInput = document.getElementById('bet-points-input');
  var pointsSlider = document.getElementById('bet-points-slider');
  var ptBtns = this.container.querySelectorAll('.btn-point');

  var updatePoints = function (val) {
    var maxVal = Math.max(1, myPoints);
    if (val === 'all') {
      val = myPoints;
    } else {
      val = parseInt(val, 10);
      if (isNaN(val)) val = 50;
      if (val < 1) val = 1;
      if (val > maxVal) val = maxVal;
    }
    
    selectedPoints = val;
    
    if (pointsInput) pointsInput.value = selectedPoints;
    if (pointsSlider) pointsSlider.value = selectedPoints;
    
    ptBtns.forEach(function (b) {
      if (b.id === 'btn-all-in') {
        if (selectedPoints === myPoints && myPoints > 0) b.classList.add('active');
        else b.classList.remove('active');
      } else {
        var pVal = parseInt(b.dataset.points, 10);
        if (pVal === selectedPoints) b.classList.add('active');
        else b.classList.remove('active');
      }
    });
    
    validateBet();
  };

  if (pointsInput) {
    pointsInput.addEventListener('input', function () {
      updatePoints(pointsInput.value);
    });
  }
  
  if (pointsSlider) {
    pointsSlider.addEventListener('input', function () {
      updatePoints(pointsSlider.value);
    });
  }
  
  ptBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var ptsVal = b.dataset.points;
      updatePoints(ptsVal);
    });
  });

  // Submit bet
  var betBtn = document.getElementById('btn-submit-bet');
  if (betBtn) {
    betBtn.addEventListener('click', function () {
      if (selectedPlayer && selectedMatch) {
        self.viewer.send(createBetPacket(selectedMatch, selectedPlayer, selectedPoints));
        betBtn.textContent = '✅ 投票しました！';
        betBtn.disabled = true;
        if (pointsInput) pointsInput.disabled = true;
        if (pointsSlider) pointsSlider.disabled = true;
        ptBtns.forEach(function (x) { x.disabled = true; });
        
        setTimeout(function () {
          if (pointsInput) pointsInput.disabled = false;
          if (pointsSlider) pointsSlider.disabled = false;
          ptBtns.forEach(function (x) { x.disabled = false; });
          updatePoints(selectedPoints);
        }, 2000);
      }
    });
  }

  // Submit prediction
  var predBtn = document.getElementById('btn-submit-predict');
  if (predBtn) {
    predBtn.addEventListener('click', function () {
      if (selectedPlayer) {
        self.viewer.send(createChampionshipPredictPacket(selectedPlayer));
        predBtn.textContent = '✅ 予想を送信しました！';
        predBtn.disabled = true;
      }
    });
  }

  // Initial synchronization
  var initialPts = myPoints >= 50 ? 50 : (myPoints > 0 ? myPoints : 1);
  updatePoints(initialPts);
};

// Escape helper (standalone)
function HostUI_escapeHtml(t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
