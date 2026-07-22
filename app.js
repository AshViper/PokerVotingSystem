// ==========================================
// PeerJS を使った P2P リアルタイム通信
// ==========================================
// Host が Peer サーバー役（PeerID = 参加コード）となり、
// Player / Vote の各クライアントは Host に直接 connect する
// 「スター型」構成にする（Host を中心にした P2P）。
// Room の状態は Host が唯一の正（Single Source of Truth）として保持し、
// 変化があるたびに接続中の全クライアントへ SYNC_STATE を配信する。
// ※ Host のタブ/ブラウザが閉じるとセッションは終了する（Hostが常時オンラインである前提）。

let peer = null;                    // 自分自身の Peer インスタンス
let hostConnections = new Map();    // [Hostのみ] peerId -> DataConnection
let hostConn = null;                // [Player/Voteのみ] Hostへの接続

let viewerPoints = parseInt(localStorage.getItem('viewer_points')) || 50;
let viewerId = localStorage.getItem('viewer_id') || 'viewer_' + Math.random().toString(36).substring(2, 9);
localStorage.setItem('viewer_id', viewerId);

let room = {
    roomCode: '',
    players: [],
    voteState: 'WAITING', // WAITING | VOTING | ENDED
    votes: [],
    selectedWinnerId: null
};

let selectedVotePlayerId = null;
let voteSubmittedLocally = false; // 送信直後～SYNC_STATE反映までの二重送信ロック
let lastShownWinnerId = null;     // 同じ結果を二重表示しないためのガード

// PeerJSのPeerIDは記号制限があるため、参加コードから安全なIDを作る
function makePeerId(code) {
    return 'rtgame-' + code.toLowerCase();
}

function destroyPeer() {
    if (peer) {
        try { peer.destroy(); } catch (e) { /* noop */ }
    }
    peer = null;
    hostConn = null;
    hostConnections.clear();
}

// ==========================================
// 画面遷移 & 初期化
// ==========================================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function goToTitle() {
    showScreen('screen-title');
}

function goToHost() {
    initHost();
    showScreen('screen-host');
}

function goToPlayer() {
    showScreen('screen-player');
}

// 起動時のURLクエリパラメータ判定（QRコードアクセス）
window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const role = params.get('role');
    const code = params.get('room');

    if (role === 'vote' && code) {
        const roomCode = code.toUpperCase();
        room.roomCode = roomCode;
        document.getElementById('vote-room-code-display').innerText = roomCode;
        showScreen('screen-vote');
        updateViewerPoints(0);
        setVoteConnectStatus('Hostに接続中...');

        connectToHost(roomCode, {
            onOpen: () => {
                setVoteConnectStatus('');
                hostConn.send({ type: 'REQUEST_SYNC' });
            },
            onFail: () => {
                setVoteConnectStatus('⚠ 接続に失敗しました。参加コードを確認し、再読み込みしてください。');
            }
        });
    } else {
        showScreen('screen-title');
    }
});

// ==========================================
// 【Host】PeerJS セットアップ
// ==========================================
function initHost() {
    if (peer) return; // 既に初期化済み

    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    room.roomCode = code;
    document.getElementById('host-room-code').innerText = code;
    setHostPeerStatus('Peerサーバーに接続中...');

    peer = new Peer(makePeerId(code));

    peer.on('open', () => {
        setHostPeerStatus('準備完了 ✅ プレイヤー・観戦者を招待できます');
        generateQRCode(code);
    });

    peer.on('connection', (conn) => {
        conn.on('open', () => {
            hostConnections.set(conn.peer, conn);
            // 接続直後に最新状態を送っておく
            conn.send({ type: 'SYNC_STATE', payload: room });
        });
        conn.on('data', (data) => handleHostData(conn, data));
        conn.on('close', () => {
            hostConnections.delete(conn.peer);
        });
    });

    peer.on('disconnected', () => {
        setHostPeerStatus('再接続中...');
        peer.reconnect();
    });

    peer.on('error', (err) => {
        console.error('[Host Peer Error]', err);
        if (err.type === 'unavailable-id') {
            // 稀にIDが衝突した場合は作り直す
            destroyPeer();
            initHost();
        } else {
            setHostPeerStatus('⚠ 接続エラーが発生しました (' + err.type + ')');
        }
    });

    updateHostUI();
}

function setHostPeerStatus(text) {
    const el = document.getElementById('host-peer-status');
    if (el) el.innerText = text;
}

function handleHostData(conn, data) {
    const { type, payload } = data;
    switch (type) {
        case 'JOIN_PLAYER':
            if (!room.players.find(p => p.id === payload.id)) {
                room.players.push(payload);
            }
            broadcastState();
            break;

        case 'REQUEST_SYNC':
            conn.send({ type: 'SYNC_STATE', payload: room });
            break;

        case 'SUBMIT_VOTE':
            if (room.voteState === 'VOTING' && !room.votes.find(v => v.viewerId === payload.viewerId)) {
                room.votes.push(payload);
                broadcastState();
            }
            break;
    }
}

// Hostの状態を全クライアントへ配信 + 自画面も更新
function broadcastState() {
    updateHostUI();
    hostConnections.forEach(conn => {
        if (conn.open) conn.send({ type: 'SYNC_STATE', payload: room });
    });
}

function generateQRCode(code) {
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = '';

    const voteUrl = `${window.location.origin}${window.location.pathname}?role=vote&room=${code}`;
    new QRCode(qrContainer, {
        text: voteUrl,
        width: 140,
        height: 140
    });
}

// ==========================================
// 【Host】投票コントロール
// ==========================================
function startVoting() {
    if (room.voteState === 'ENDED') {
        // 新ラウンド：投票データのみリセット（観戦者ポイントは各自のLocalStorageのまま維持）
        room.votes = [];
        room.selectedWinnerId = null;
    }
    room.voteState = 'VOTING';
    broadcastState();
}

function endVoting() {
    room.voteState = 'ENDED';
    broadcastState();
}

function selectWinner(playerId) {
    room.selectedWinnerId = playerId;
    updateHostUI();
}

function announceWinner() {
    if (!room.selectedWinnerId) return;
    room.voteState = 'ENDED';
    broadcastState();
}

function updateHostUI() {
    const listContainer = document.getElementById('host-player-list');
    const countSpan = document.getElementById('player-count');
    if (countSpan) countSpan.innerText = room.players.length;

    if (listContainer) {
        if (room.players.length === 0) {
            listContainer.innerHTML = '<p class="subtitle">プレイヤーの参加を待っています...</p>';
        } else {
            listContainer.innerHTML = room.players.map(p => {
                const isSelected = room.selectedWinnerId === p.id;
                return `
          <div class="list-item selectable-item ${isSelected ? 'active' : ''}" onclick="selectWinner('${p.id}')">
            <span><strong>${escapeHtml(p.name)}</strong></span>
            ${isSelected ? '<span class="badge badge-voting">勝者選択中</span>' : ''}
          </div>
        `;
            }).join('');
        }
    }

    const badge = document.getElementById('host-state-badge');
    if (badge) {
        if (room.voteState === 'WAITING') {
            badge.className = 'badge badge-waiting';
            badge.innerText = '状態: 待機中';
        } else if (room.voteState === 'VOTING') {
            badge.className = 'badge badge-voting';
            badge.innerText = '状態: 投票中';
        } else {
            badge.className = 'badge badge-ended';
            badge.innerText = '状態: 投票終了';
        }
    }

    // ボタンの活性状態は room.voteState から一元的に導出する
    const startBtn = document.getElementById('btn-start-vote');
    const endBtn = document.getElementById('btn-end-vote');
    if (startBtn) startBtn.disabled = room.voteState === 'VOTING';
    if (endBtn) endBtn.disabled = room.voteState !== 'VOTING';

    const winnerSec = document.getElementById('winner-select-section');
    if (winnerSec) winnerSec.style.display = room.players.length > 0 ? 'block' : 'none';
    const calcBtn = document.getElementById('btn-calc-result');
    if (calcBtn) calcBtn.disabled = !room.selectedWinnerId || room.voteState !== 'ENDED';
}

// ==========================================
// 【クライアント共通】Hostへの接続
// ==========================================
function connectToHost(code, { onOpen, onFail } = {}) {
    destroyPeer();
    peer = new Peer();

    peer.on('open', () => {
        hostConn = peer.connect(makePeerId(code), { reliable: true });

        hostConn.on('open', () => {
            if (onOpen) onOpen();
        });

        hostConn.on('data', (data) => {
            handleClientData(data);
        });

        hostConn.on('close', () => {
            alert('Hostとの接続が切れました。ページを再読み込みしてください。');
        });
    });

    peer.on('error', (err) => {
        console.error('[Client Peer Error]', err);
        if (err.type === 'peer-unavailable') {
            if (onFail) onFail();
            else alert('参加コードが見つかりません。');
        } else if (onFail) {
            onFail();
        }
    });
}

function handleClientData(data) {
    const { type, payload } = data;
    if (type === 'SYNC_STATE') {
        room = payload;
        updateVoteUI();
    }
}

// ==========================================
// 【Player画面】処理ロジック
// ==========================================
function joinGame() {
    const codeInput = document.getElementById('input-room-code').value.trim().toUpperCase();
    const nameInput = document.getElementById('input-player-name').value.trim();

    if (!codeInput || !nameInput) {
        alert('参加コードとプレイヤー名を入力してください。');
        return;
    }

    const joinBtn = document.querySelector('#player-join-form .btn-primary');
    if (joinBtn) { joinBtn.disabled = true; joinBtn.innerText = '接続中...'; }

    const player = {
        id: 'player_' + Math.random().toString(36).substring(2, 9),
        name: nameInput
    };

    connectToHost(codeInput, {
        onOpen: () => {
            room.roomCode = codeInput;
            hostConn.send({ type: 'JOIN_PLAYER', payload: player });

            document.getElementById('player-join-form').style.display = 'none';
            document.getElementById('player-joined-info').style.display = 'block';
            document.getElementById('player-display-name').innerText = nameInput;
        },
        onFail: () => {
            alert('参加コードが見つかりません。コードを確認してください。');
            if (joinBtn) { joinBtn.disabled = false; joinBtn.innerText = 'ゲームに参加する'; }
        }
    });
}

// ==========================================
// 【Vote画面】処理ロジック
// ==========================================
function setVoteConnectStatus(text) {
    const el = document.getElementById('vote-connect-status');
    if (el) el.innerText = text;
}

function updateViewerPoints(delta) {
    viewerPoints += delta;
    localStorage.setItem('viewer_points', viewerPoints);
    const ptElem = document.getElementById('viewer-points');
    if (ptElem) ptElem.innerText = viewerPoints;
}

function hasVotedThisRound() {
    return room.votes.some(v => v.viewerId === viewerId) || voteSubmittedLocally;
}

function selectVotePlayer(playerId) {
    if (room.voteState !== 'VOTING' || hasVotedThisRound()) return;
    selectedVotePlayerId = playerId;
    updateVoteUI();
}

function submitVote() {
    const betInput = parseInt(document.getElementById('input-bet-point').value);

    if (room.voteState !== 'VOTING') {
        alert('投票できません（受付時間外）');
        return;
    }

    if (hasVotedThisRound()) {
        alert('同ラウンドでは再投票できません。');
        return;
    }

    if (isNaN(betInput) || betInput <= 0) {
        alert('正しいポイントを入力してください。');
        return;
    }

    if (betInput > viewerPoints) {
        alert('ポイント不足です。');
        return;
    }

    if (!selectedVotePlayerId) {
        alert('投票先プレイヤーを選択してください。');
        return;
    }

    if (!hostConn || !hostConn.open) {
        alert('Hostとの接続がありません。ページを再読み込みしてください。');
        return;
    }

    updateViewerPoints(-betInput);
    voteSubmittedLocally = true;

    const voteData = {
        viewerId: viewerId,
        playerId: selectedVotePlayerId,
        betPoint: betInput
    };

    hostConn.send({ type: 'SUBMIT_VOTE', payload: voteData });
    updateVoteUI();
}

function processVoteResult(winnerId) {
    const myVote = room.votes.find(v => v.viewerId === viewerId);
    const banner = document.getElementById('vote-result-banner');
    if (!banner || !myVote) return;

    if (myVote.playerId === winnerId) {
        const reward = myVote.betPoint * 2;
        updateViewerPoints(reward);
        banner.innerHTML = `<div class="result-banner result-win">🎉 的中！ +${reward}pt 獲得！</div>`;
    } else {
        banner.innerHTML = `<div class="result-banner result-lose">💀 ハズレ (${myVote.betPoint}pt 没収)</div>`;
    }
}

function updateVoteUI() {
    const badge = document.getElementById('vote-state-badge');
    const submitBtn = document.getElementById('btn-submit-vote');
    const banner = document.getElementById('vote-result-banner');

    // 新ラウンド判定：Hostが投票データをリセットしたらローカルの送信フラグ・結果表示もクリア
    if (room.votes.length === 0 && room.voteState !== 'ENDED') {
        voteSubmittedLocally = false;
        lastShownWinnerId = null;
        selectedVotePlayerId = null;
        if (banner) banner.innerHTML = '';
    }

    const voted = hasVotedThisRound();

    if (badge) {
        if (room.voteState === 'WAITING') {
            badge.className = 'badge badge-waiting';
            badge.innerText = '待機中';
            if (submitBtn) submitBtn.disabled = true;
        } else if (room.voteState === 'VOTING') {
            badge.className = 'badge badge-voting';
            badge.innerText = '投票受付中';
            if (submitBtn) submitBtn.disabled = voted || !selectedVotePlayerId;
        } else {
            badge.className = 'badge badge-ended';
            badge.innerText = '投票受付終了';
            if (submitBtn) submitBtn.disabled = true;
        }
    }

    if (submitBtn) {
        submitBtn.innerText = voted ? '投票済み' : '投票する';
    }

    const voteList = document.getElementById('vote-player-list');
    if (voteList) {
        if (room.players.length === 0) {
            voteList.innerHTML = '<p class="subtitle">プレイヤーがまだいません</p>';
        } else {
            voteList.innerHTML = room.players.map(p => {
                const isSelected = selectedVotePlayerId === p.id;
                return `
          <div class="list-item selectable-item ${isSelected ? 'active' : ''}" onclick="selectVotePlayer('${p.id}')">
            <span><strong>${escapeHtml(p.name)}</strong></span>
            ${isSelected ? '<span class="badge badge-voting">選択中</span>' : ''}
          </div>
        `;
            }).join('');
        }
    }

    // 勝者発表の結果表示（同じ結果を二重表示しない）
    if (room.voteState === 'ENDED' && room.selectedWinnerId && lastShownWinnerId !== room.selectedWinnerId) {
        lastShownWinnerId = room.selectedWinnerId;
        processVoteResult(room.selectedWinnerId);
    }
}

// XSS防止
function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[m]);
}