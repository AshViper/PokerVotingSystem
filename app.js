let peer = null;
let hostConnections = new Map();
let hostConn = null;

let voterName = localStorage.getItem('voter_name') || '';
let viewerPoints = parseInt(localStorage.getItem('viewer_points')) || 100;
let viewerId = localStorage.getItem('viewer_id') || 'viewer_' + Math.random().toString(36).substring(2, 9);
localStorage.setItem('viewer_id', viewerId);

let room = {
    roomCode: '',
    players: [],
    voters: [], // { id, name, points, tournamentPredId }
    voteState: 'WAITING', // WAITING | PREDICTION | VOTING | ENDED
    votes: [],
    selectedWinnerId: null
};

let selectedVotePlayerId = null;
let selectedPredPlayerId = null;
let voteSubmittedLocally = false;
let lastShownWinnerId = null;

function makePeerId(code) {
    return 'rtgame-' + code.toLowerCase();
}

function destroyPeer() {
    if (peer) {
        try { peer.destroy(); } catch (e) { }
    }
    peer = null;
    hostConn = null;
    hostConnections.clear();
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function goToTitle() { showScreen('screen-title'); }
function goToHost() { initHost(); showScreen('screen-host'); }
function goToPlayer() { showScreen('screen-player'); }

// QRコードでのアクセス判定
window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const role = params.get('role');
    const code = params.get('room');

    if (role === 'vote' && code) {
        const roomCode = code.toUpperCase();
        room.roomCode = roomCode;
        document.getElementById('vote-room-code-display').innerText = roomCode;
        showScreen('screen-vote');

        if (voterName) {
            document.getElementById('vote-name-form').style.display = 'none';
            document.getElementById('vote-main-section').style.display = 'block';
            document.getElementById('display-voter-name').innerText = voterName;
        }

        setVoteConnectStatus('Hostに接続中...');
        connectToHost(roomCode, {
            onOpen: () => {
                setVoteConnectStatus('');
                if (voterName) sendVoterRegister();
                else hostConn.send({ type: 'REQUEST_SYNC' });
            },
            onFail: () => {
                setVoteConnectStatus('⚠ 接続失敗。再読み込みしてください。');
            }
        });
    } else {
        showScreen('screen-title');
    }
});

// ================= Host ロジック =================
function initHost() {
    if (peer) return;

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
            conn.send({ type: 'SYNC_STATE', payload: room });
        });
        conn.on('data', (data) => handleHostData(conn, data));
        conn.on('close', () => hostConnections.delete(conn.peer));
    });

    peer.on('disconnected', () => peer.reconnect());
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

        case 'REGISTER_VOTER':
            let v = room.voters.find(x => x.id === payload.id);
            if (!v) {
                room.voters.push({ id: payload.id, name: payload.name, points: 100, tournamentPredId: null });
            } else {
                v.name = payload.name;
            }
            broadcastState();
            break;

        case 'SUBMIT_PREDICTION':
            let voterP = room.voters.find(x => x.id === payload.viewerId);
            if (voterP) voterP.tournamentPredId = payload.predPlayerId;
            broadcastState();
            break;

        case 'SUBMIT_VOTE':
            if (room.voteState === 'VOTING' && !room.votes.find(v => v.viewerId === payload.viewerId)) {
                room.votes.push(payload);
                // ポイント一時控除
                let voter = room.voters.find(x => x.id === payload.viewerId);
                if (voter) voter.points -= payload.betPoint;
                broadcastState();
            }
            break;

        case 'REQUEST_SYNC':
            conn.send({ type: 'SYNC_STATE', payload: room });
            break;
    }
}

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
    new QRCode(qrContainer, { text: voteUrl, width: 140, height: 140 });
}

function startPrediction() {
    room.voteState = 'PREDICTION';
    broadcastState();
}

function startVoting() {
    if (room.voteState === 'ENDED') {
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

    // マッチ的中者に配当を計算 (2倍計算の例)
    room.votes.forEach(v => {
        if (v.playerId === room.selectedWinnerId) {
            let voter = room.voters.find(x => x.id === v.viewerId);
            if (voter) voter.points += v.betPoint * 2;
        }
    });

    room.voteState = 'ENDED';
    broadcastState();
}

// 大会終了（上位10名計算）
function endTournament() {
    const sorted = [...room.voters].sort((a, b) => b.points - a.points).slice(0, 10);
    const listEl = document.getElementById('ranking-list');

    listEl.innerHTML = sorted.length > 0
        ? sorted.map(v => `<li><strong>${escapeHtml(v.name)}</strong>: ${v.points} pt</li>`).join('')
        : '<li>参加者がいません</li>';

    document.getElementById('ranking-modal').style.display = 'block';
}

function closeRanking() {
    document.getElementById('ranking-modal').style.display = 'none';
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
                  </div>`;
            }).join('');
        }
    }

    const badge = document.getElementById('host-state-badge');
    if (badge) {
        badge.innerText = '状態: ' + room.voteState;
    }

    const startBtn = document.getElementById('btn-start-vote');
    const endBtn = document.getElementById('btn-end-vote');
    if (startBtn) startBtn.disabled = room.voteState === 'VOTING';
    if (endBtn) endBtn.disabled = room.voteState !== 'VOTING';

    const winnerSec = document.getElementById('winner-select-section');
    if (winnerSec) winnerSec.style.display = room.players.length > 0 ? 'block' : 'none';
    const calcBtn = document.getElementById('btn-calc-result');
    if (calcBtn) calcBtn.disabled = !room.selectedWinnerId || room.voteState !== 'ENDED';
}

// ================= クライアント共通 / Player / Vote =================
function connectToHost(code, { onOpen, onFail } = {}) {
    destroyPeer();
    peer = new Peer();

    peer.on('open', () => {
        hostConn = peer.connect(makePeerId(code), { reliable: true });
        hostConn.on('open', () => { if (onOpen) onOpen(); });
        hostConn.on('data', (data) => handleClientData(data));
    });

    peer.on('error', (err) => {
        if (onFail) onFail();
    });
}

function handleClientData(data) {
    if (data.type === 'SYNC_STATE') {
        const prevState = room.voteState;
        room = data.payload;

        // 自分のポイント更新
        let myVoter = room.voters.find(x => x.id === viewerId);
        if (myVoter) {
            viewerPoints = myVoter.points;
            updateViewerPoints(0);
        }

        if (room.voteState === 'VOTING' && room.votes.length === 0 && (prevState === 'ENDED' || prevState === 'WAITING')) {
            voteSubmittedLocally = false;
            selectedVotePlayerId = null;
            const banner = document.getElementById('vote-result-banner');
            if (banner) banner.innerHTML = '';
        }

        updateVoteUI();
    }
}

function joinGame() {
    const codeInput = document.getElementById('input-room-code').value.trim().toUpperCase();
    const nameInput = document.getElementById('input-player-name').value.trim();

    if (!codeInput || !nameInput) return alert('入力してください。');

    const player = { id: 'player_' + Math.random().toString(36).substring(2, 9), name: nameInput };

    connectToHost(codeInput, {
        onOpen: () => {
            hostConn.send({ type: 'JOIN_PLAYER', payload: player });
            document.getElementById('player-join-form').style.display = 'none';
            document.getElementById('player-joined-info').style.display = 'block';
            document.getElementById('player-display-name').innerText = nameInput;
        }
    });
}

// Vote 名前登録
function registerVoter() {
    const name = document.getElementById('input-voter-name').value.trim();
    if (!name) return alert('名前を入力してください。');

    voterName = name;
    localStorage.setItem('voter_name', voterName);

    document.getElementById('vote-name-form').style.display = 'none';
    document.getElementById('vote-main-section').style.display = 'block';
    document.getElementById('display-voter-name').innerText = voterName;

    sendVoterRegister();
}

function sendVoterRegister() {
    if (hostConn && hostConn.open) {
        hostConn.send({
            type: 'REGISTER_VOTER',
            payload: { id: viewerId, name: voterName }
        });
    }
}

function updateViewerPoints(delta) {
    viewerPoints += delta;
    const ptElem = document.getElementById('viewer-points');
    if (ptElem) ptElem.innerText = viewerPoints;
}

function submitPrediction() {
    if (!selectedPredPlayerId) return alert('選手を選択してください。');
    hostConn.send({
        type: 'SUBMIT_PREDICTION',
        payload: { viewerId, predPlayerId: selectedPredPlayerId }
    });
    alert('大会優勝予想を送信しました！');
    document.getElementById('prediction-section').style.display = 'none';
}

function selectVotePlayer(id) {
    selectedVotePlayerId = id;
    updateVoteUI();
}

function selectPredPlayer(id) {
    selectedPredPlayerId = id;
    updateVoteUI();
}

function submitVote() {
    const betInput = parseInt(document.getElementById('input-bet-point').value);
    if (!selectedVotePlayerId || isNaN(betInput) || betInput > viewerPoints) return alert('正しい内容を選択・入力してください。');

    voteSubmittedLocally = true;
    hostConn.send({
        type: 'SUBMIT_VOTE',
        payload: { viewerId, playerId: selectedVotePlayerId, betPoint: betInput }
    });
    updateVoteUI();
}

function updateVoteUI() {
    const badge = document.getElementById('vote-state-badge');
    const submitBtn = document.getElementById('btn-submit-vote');
    const predSec = document.getElementById('prediction-section');

    if (badge) badge.innerText = room.voteState;

    if (predSec) {
        predSec.style.display = room.voteState === 'PREDICTION' ? 'block' : 'none';
        const predList = document.getElementById('pred-player-list');
        if (predList && room.players.length > 0) {
            predList.innerHTML = room.players.map(p => `
                <div class="list-item selectable-item ${selectedPredPlayerId === p.id ? 'active' : ''}" onclick="selectPredPlayer('${p.id}')">
                    <span>${escapeHtml(p.name)}</span>
                </div>
            `).join('');
        }
    }

    const voteList = document.getElementById('vote-player-list');
    if (voteList && room.players.length > 0) {
        voteList.innerHTML = room.players.map(p => `
            <div class="list-item selectable-item ${selectedVotePlayerId === p.id ? 'active' : ''}" onclick="selectVotePlayer('${p.id}')">
                <span>${escapeHtml(p.name)}</span>
            </div>
        `).join('');
    }

    if (submitBtn) {
        submitBtn.disabled = room.voteState !== 'VOTING' || voteSubmittedLocally;
        submitBtn.innerText = voteSubmittedLocally ? '投票済み' : '投票する';
    }
}

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}