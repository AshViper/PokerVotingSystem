// ==========================================
// データ構造 & 状態管理 (State)
// ==========================================
// ルームごとにChannelを動的生成できるようにlet化
let broadcast = null;

let viewerPoints = parseInt(localStorage.getItem('viewer_points')) || 50;
let viewerId = localStorage.getItem('viewer_id') || 'viewer_' + Math.random().toString(36).substring(2, 9);
localStorage.setItem('viewer_id', viewerId);

let room = {
    roomCode: '',
    players: [],
    voteState: 'WAITING',
    votes: [],
    selectedWinnerId: null
};

let selectedVotePlayerId = null;
let hasVotedThisRound = false;

// BroadcastChannel の初期化・接続関数
function initBroadcastChannel(roomCode) {
    if (broadcast) {
        broadcast.close();
    }

    // ルームコードごとの独立したチャンネル名を作成
    const channelName = `realtime_game_${roomCode}`;
    broadcast = new BroadcastChannel(channelName);

    broadcast.onmessage = (event) => {
        const { type, payload } = event.data;

        switch (type) {
            case 'SYNC_STATE':
                room = payload;
                updateHostUI();
                updateVoteUI();
                break;

            case 'REQUEST_SYNC':
                // 新規参加者(Vote等)が接続してきた際にHostが現在の状態を再送信
                if (room.roomCode) {
                    syncState();
                }
                break;

            case 'PLAYER_JOINED':
                if (!room.players.find(p => p.id === payload.id)) {
                    room.players.push(payload);
                    syncState();
                }
                break;

            case 'SUBMIT_VOTE':
                if (!room.votes.find(v => v.viewerId === payload.viewerId)) {
                    room.votes.push(payload);
                    syncState();
                }
                break;

            case 'CALCULATE_RESULTS':
                room.selectedWinnerId = payload.winnerId;
                room.voteState = 'ENDED';
                processVoteResult(payload.winnerId);
                syncState();
                break;

            case 'RESET_ROUND':
                room.votes = [];
                room.voteState = 'WAITING';
                room.selectedWinnerId = null;
                hasVotedThisRound = false;
                syncState();
                break;
        }
    };
}

function syncState() {
    updateHostUI();
    updateVoteUI();
    if (broadcast) {
        broadcast.postMessage({ type: 'SYNC_STATE', payload: room });
    }
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

// 起動時のURLクエリパラメータ判定
window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const role = params.get('role');
    const code = params.get('room');

    // QRコードアクセス (role=vote & roomが存在) の場合
    if (role === 'vote' && code) {
        room.roomCode = code.toUpperCase();
        initBroadcastChannel(room.roomCode);

        document.getElementById('vote-room-code-display').innerText = room.roomCode;
        showScreen('screen-vote');
        updateViewerPoints(0);

        // Hostに最新のRoom状態を要求
        setTimeout(() => {
            if (broadcast) broadcast.postMessage({ type: 'REQUEST_SYNC' });
        }, 300);
    } else {
        showScreen('screen-title');
    }
});

// ==========================================
// 【Host画面】処理ロジック
// ==========================================
function initHost() {
    if (!room.roomCode) {
        room.roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        document.getElementById('host-room-code').innerText = room.roomCode;
        initBroadcastChannel(room.roomCode);
        generateQRCode(room.roomCode);
    }
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

function startVoting() {
    if (room.voteState === 'ENDED') {
        broadcast.postMessage({ type: 'RESET_ROUND' });
        room.votes = [];
        hasVotedThisRound = false;
    }

    room.voteState = 'VOTING';
    document.getElementById('host-state-badge').className = 'badge badge-voting';
    document.getElementById('host-state-badge').innerText = '状態: 投票中';
    document.getElementById('btn-start-vote').disabled = true;
    document.getElementById('btn-end-vote').disabled = false;

    syncState();
}

function endVoting() {
    room.voteState = 'ENDED';
    document.getElementById('host-state-badge').className = 'badge badge-ended';
    document.getElementById('host-state-badge').innerText = '状態: 投票終了';
    document.getElementById('btn-start-vote').disabled = false;
    document.getElementById('btn-end-vote').disabled = true;

    syncState();
}

function selectWinner(playerId) {
    room.selectedWinnerId = playerId;
    updateHostUI();
}

function announceWinner() {
    if (!room.selectedWinnerId) return;
    broadcast.postMessage({
        type: 'CALCULATE_RESULTS',
        payload: { winnerId: room.selectedWinnerId }
    });
    processVoteResult(room.selectedWinnerId);
    endVoting();
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

    const winnerSec = document.getElementById('winner-select-section');
    if (winnerSec) winnerSec.style.display = room.players.length > 0 ? 'block' : 'none';
    const calcBtn = document.getElementById('btn-calc-result');
    if (calcBtn) calcBtn.disabled = !room.selectedWinnerId;
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

    room.roomCode = codeInput;
    initBroadcastChannel(room.roomCode);

    const player = {
        id: 'player_' + Math.random().toString(36).substring(2, 9),
        name: nameInput
    };

    document.getElementById('player-join-form').style.display = 'none';
    document.getElementById('player-joined-info').style.display = 'block';
    document.getElementById('player-display-name').innerText = nameInput;

    broadcast.postMessage({ type: 'PLAYER_JOINED', payload: player });
    broadcast.postMessage({ type: 'REQUEST_SYNC' });
}

// ==========================================
// 【Vote画面】処理ロジック
// ==========================================
function updateViewerPoints(delta) {
    viewerPoints += delta;
    localStorage.setItem('viewer_points', viewerPoints);
    const ptElem = document.getElementById('viewer-points');
    if (ptElem) ptElem.innerText = viewerPoints;
}

function selectVotePlayer(playerId) {
    if (room.voteState !== 'VOTING' || hasVotedThisRound) return;
    selectedVotePlayerId = playerId;
    updateVoteUI();
}

function submitVote() {
    const betInput = parseInt(document.getElementById('input-bet-point').value);

    if (room.voteState !== 'VOTING') {
        alert('投票できません（受付時間外）');
        return;
    }

    if (hasVotedThisRound) {
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

    updateViewerPoints(-betInput);
    hasVotedThisRound = true;

    const voteData = {
        viewerId: viewerId,
        playerId: selectedVotePlayerId,
        betPoint: betInput
    };

    broadcast.postMessage({ type: 'SUBMIT_VOTE', payload: voteData });
    updateVoteUI();
}

function processVoteResult(winnerId) {
    const myVote = room.votes.find(v => v.viewerId === viewerId);
    const banner = document.getElementById('vote-result-banner');
    if (!banner) return;

    if (!myVote) {
        banner.innerHTML = '';
        return;
    }

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

    if (badge) {
        if (room.voteState === 'WAITING') {
            badge.className = 'badge badge-waiting';
            badge.innerText = '待機中';
            if (submitBtn) submitBtn.disabled = true;
        } else if (room.voteState === 'VOTING') {
            badge.className = 'badge badge-voting';
            badge.innerText = '投票受付中';
            if (submitBtn) submitBtn.disabled = hasVotedThisRound || !selectedVotePlayerId;
        } else {
            badge.className = 'badge badge-ended';
            badge.innerText = '投票受付終了';
            if (submitBtn) submitBtn.disabled = true;
        }
    }

    if (submitBtn) {
        submitBtn.innerText = hasVotedThisRound ? '投票済み' : '投票する';
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
}

// XSS防止
function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[m]);
}