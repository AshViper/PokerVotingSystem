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
  return { type: 'join', role: 'viewer' }; }
function getHostPeerId(roomCode) { return 'poker-' + roomCode; }

// ===== PeerBase =====
function PeerBase(callbacks) { this.peerInstance = null; this.callbacks = callbacks; }
PeerBase.prototype.createPeer = function (id) {
  var self = this;
  return new Promise(function (resolve, reject) {
    try {
      var p = id !== undefined ? new Peer(id) : new Peer();
      p.on('open', function (aid) { self.peerInstance = p; resolve(aid); });
      p.on('error', function (err) { if (self.peerInstance !== null) self.callbacks.onError(err.message); reject(err); });
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
  this.roomCode = roomCode; this.playerName = name;
  this.hostConnection = null; this.connectedFlag = false;
}
PlayerPeer.prototype = Object.create(PeerBase.prototype);
PlayerPeer.prototype.constructor = PlayerPeer;
PlayerPeer.prototype.start = function () {
  var self = this;
  return this.createPeer().then(function () { return self.connectToHost(); });
};
PlayerPeer.prototype.connectToHost = function () {
  var self = this;
  if (this.peerInstance === null) return Promise.reject(new Error('Peer not initialized'));
  var hostId = getHostPeerId(this.roomCode);
  return new Promise(function (resolve, reject) {
    var conn = self.peerInstance.connect(hostId);
    conn.on('open', function () {
      self.hostConnection = conn; self.connectedFlag = true;
      conn.send(createJoinPacket('player', self.playerName));
      conn.on('data', function (data) {
        var pkt = parseMessage(data);
        if (pkt && pkt.type === 'playerList') self.playerCallbacks.onPlayerListUpdate(pkt.players);
        if (pkt && pkt.type === 'disconnect') self.handleHostDisconnect();
      });
      conn.on('close', function () { self.handleHostDisconnect(); });
      self.playerCallbacks.onConnected(); resolve();
    });
    conn.on('error', function (err) { self.playerCallbacks.onError(err.message); reject(err); });
  });
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

// ===== PlayerUI (Join Screen Only) =====
function PlayerUI(container, onJoin) {
  this.container = container;
  this.onJoin = onJoin;
  this.renderJoin();
}
PlayerUI.prototype.renderJoin = function () {
  var self = this;
  this.container.innerHTML = [
    '<div class="join-page">',
    '  <div class="brand-icon">🎮</div>',
    '  <h1>ゲーム参加</h1>',
    '  <p class="subtitle">参加コードと名前を入力して、ゲームに参加しましょう！</p>',
    '  <div class="join-card">',
    '    <div class="field">',
    '      <label>📋 参加コード</label>',
    '      <input type="text" id="join-code" placeholder="例: ABCDEF" maxlength="6" autocomplete="off" style="text-transform:uppercase;letter-spacing:0.3rem;text-align:center;font-weight:700" />',
    '    </div>',
    '    <div class="field">',
    '      <label>👤 あなたの名前</label>',
    '      <input type="text" id="join-name" placeholder="例: たろう" autocomplete="off" />',
    '    </div>',
    '    <button id="join-btn" class="btn btn-primary btn-block btn-lg">参加する</button>',
    '    <div id="join-status" class="status" style="margin-top:0.75rem"></div>',
    '  </div>',
    '</div>'
  ].join('');

  document.getElementById('join-btn').addEventListener('click', function () {
    var code = document.getElementById('join-code').value.trim().toUpperCase();
    var name = document.getElementById('join-name').value.trim();
    if (code && name) self.onJoin(code, name);
    else self.showError('すべての項目を入力してください');
  });

  // URL auto-fill
  var p = new URLSearchParams(window.location.search);
  var rc = p.get('room') || '', rn = p.get('name') || '';
  if (rc) { document.getElementById('join-code').value = rc; }
  if (rn) { document.getElementById('join-name').value = rn; }
  if (rc && rn) self.onJoin(rc, rn);
};
PlayerUI.prototype.showConnected = function () {
  this.container.innerHTML = [
    '<div class="connected-panel">',
    '  <div class="check">✅</div>',
    '  <h2>参加完了！</h2>',
    '  <p>ゲームへの参加が完了しました。<br/>QRコードからアクセスした「勝者予想画面」で投票やベットを行ってください。</p>',
    '</div>'
  ].join('');
};
PlayerUI.prototype.showError = function (msg) {
  var el = document.getElementById('join-status');
  if (el) { el.textContent = msg; el.className = 'status status-error'; }
};
PlayerUI.prototype.showDisconnected = function () {
  this.container.innerHTML = [
    '<div class="connected-panel">',
    '  <div class="check" style="color:var(--accent-red)">⚠️</div>',
    '  <h2>接続が切断されました</h2>',
    '  <p>ホストサーバーとの接続が失われました。</p>',
    '  <button class="btn btn-primary" onclick="location.reload()">再接続する</button>',
    '</div>'
  ].join('');
};

// ===== Main =====
var container = document.getElementById('app');
var ui = new PlayerUI(container, function (code, name) {
  var callbacks = {
    onError: function (msg) { ui.showError(msg); },
    onConnected: function () { ui.showConnected(); },
    onPlayerListUpdate: function (_p) {},
    onHostDisconnected: function () { ui.showDisconnected(); }
  };
  var player = new PlayerPeer(code, name, callbacks);
  player.start().catch(function (err) { ui.showError('Connection failed: ' + err.message); });
});
