// 初期ポイント定数
const INITIAL_POINTS = 50;

let peer = null;
let hostConnections = new Map();
let hostConn = null;

let voterName = '';
let viewerPoints = INITIAL_POINTS;
let viewerId = '';

let currentRoundId = null;

let room = {
    roomCode: '',
    players: [],
    voters: [], // { id, name, points, tournamentPredId }
    voteState: 'WAITING', // WAITING | PREDICTION | VOTING | CLOSED | ENDED | TOURNAMENT_ENDED
    votes: [], // { viewerId, playerId, betPoint }
    selectedWinnerId: null,
    roundId: null
};

let selectedVotePlayerId = null;
let selectedPredPlayerId = null;
let voteSubmittedLocally = false;

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
function goToVoteLogin() { showScreen('screen-vote-login'); }

// ================= Vote 接続処理 =================
function initVoteClient(code) {
    const roomCode = code.toUpperCase();
    room.roomCode = roomCode;
    document.getElementById('vote-room-code-display').innerText = roomCode;
    showScreen('screen-vote');

    if (voterName) {
        document.getElementById('vote-name-form').style.display = 'none';
        document.getElementById('vote-main-section').style.display = 'block';
        document.getElementById('display-voter-name').innerText = voterName;
    } else {
        document.getElementById('vote-name-form').style.display = 'block';
        document.getElementById('vote-main-section').style.display = 'none';
    }

    setVoteConnectStatus('Hostに接続中...');

    const btn = document.getElementById('btn-register-voter');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'ホストに接続中...';
    }

    connectToHost(roomCode, {
        onOpen: () => {
            setVoteConnectStatus('');
            if (btn) {
                btn.disabled = false;
                btn.innerText = '投票に参加する';
            }
            if (voterName) sendVoterRegister();
            else hostConn.send({ type: 'REQUEST_SYNC' });
        },
        onFail: () => {
            setVoteConnectStatus('⚠ 接続失敗。参加コードを確認してください。');
            if (btn) btn.innerText = '接続エラー';
        }
    });
}

function joinAsVote() {
    const code = document.getElementById('input-vote-room-code').value.trim();
    if (!code) return alert('参加コードを入力してください。');
    initVoteClient(code);
}

// 起動時: QRコードアクセス（role=vote）なら前回のキャッシュを初期化
window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const role = params.get('role');
    const code = params.get('room');

    if (role === 'vote' && code) {
        localStorage.removeItem('voter_name');
        localStorage.removeItem('viewer_points');
        localStorage.removeItem('viewer_id');

        voterName = '';
        viewerPoints = INITIAL_POINTS;
        viewerId = 'viewer_' + Math.random().toString(36).substring(2, 9);
        localStorage.setItem('viewer_id', viewerId);
        localStorage.setItem('viewer_points', viewerPoints);

        initVoteClient(code);
    } else {
        viewerId = localStorage.getItem('viewer_id') || 'viewer_' + Math.random().toString(36).substring(2, 9);
        voterName = localStorage.getItem('voter_name') || '';
        viewerPoints = parseInt(localStorage.getItem('viewer_points')) || INITIAL_POINTS;
        localStorage.setItem('viewer_id', viewerId);

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
                room.voters.push({ id: payload.id, name: payload.name, points: INITIAL_POINTS, tournamentPredId: null });
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
            if (room.voteState === 'VOTING') {
                if (!room.votes.find(v => v.viewerId === payload.viewerId)) {
                    room.votes.push(payload);
                    let voter = room.voters.find(x => x.id === payload.viewerId);
                    if (voter) voter.points -= payload.betPoint;
                    broadcastState();
                }
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
    if (room.voteState === 'TOURNAMENT_ENDED') return;
    room.voteState = 'PREDICTION';
    broadcastState();
}

function startVoting() {
    if (room.voteState === 'TOURNAMENT_ENDED') return;
    room.votes = [];
    room.selectedWinnerId = null;
    room.voteState = 'VOTING';
    room.roundId = 'round_' + Date.now();
    broadcastState();
}

function endVoting() {
    if (room.voteState !== 'VOTING') return;
    room.voteState = 'CLOSED';
    broadcastState();
}

function selectWinner(playerId) {
    if (room.voteState === 'TOURNAMENT_ENDED') return;
    room.selectedWinnerId = playerId;
    broadcastState();
}

function announceWinner() {
    if (room.voteState === 'TOURNAMENT_ENDED') return;
    if (room.voteState !== 'CLOSED') {
        return alert('まず「投票締切」を押して投票を締め切ってください。');
    }
    if (!room.selectedWinnerId) {
        return alert('左側のプレイヤー一覧から勝者を選択してください。');
    }

    room.votes.forEach(v => {
        if (v.playerId === room.selectedWinnerId) {
            let voter = room.voters.find(x => x.id === v.viewerId);
            if (voter) {
                voter.points += v.betPoint * 2;
            }
        }
    });

    room.voteState = 'ENDED';
    broadcastState();
}

// ゲーム終了処理
function endTournament() {
    room.voteState = 'TOURNAMENT_ENDED';
    broadcastState();
    showRankingModal();
}

function showRankingModal() {
    // ポイント順に並び替え（同ポイントの場合は配列の順序＝先着順を保持）
    const sorted = [...room.voters].sort((a, b) => b.points - a.points).slice(0, 10);
    const listEl = document.getElementById('ranking-list');

    if (listEl) {
        listEl.innerHTML = sorted.length > 0
            ? sorted.map((v, i) => `
                <li style="padding: 0.6rem 0; border-bottom: 1px solid var(--card-border); font-size: 1.1rem; display: flex; justify-content: space-between;">
                    <span><strong>${i + 1}位 ${escapeHtml(v.name)}</strong></span>
                    <strong style="color: #fbbf24;">${v.points}pt</strong>
                </li>`).join('')
            : '<li style="text-align:center; padding:1rem;">参加者がいません</li>';
    }

    const modal = document.getElementById('ranking-modal');
    if (modal) modal.style.display = 'block';
}

function closeRanking() {
    const modal = document.getElementById('ranking-modal');
    if (modal) modal.style.display = 'none';
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
                    ${isSelected ? '<span class="badge badge-success">勝者選択中</span>' : ''}
                  </div>`;
            }).join('');
        }
    }

    const badge = document.getElementById('host-state-badge');
    if (badge) {
        badge.innerText = '状態: ' + room.voteState;
    }

    const startPredBtn = document.getElementById('btn-start-pred');
    const startVoteBtn = document.getElementById('btn-start-vote');
    const endVoteBtn = document.getElementById('btn-end-vote');
    const calcBtn = document.getElementById('btn-calc-result');
    const endTournamentBtn = document.getElementById('btn-end-tournament');

    if (room.voteState === 'TOURNAMENT_ENDED') {
        if (startPredBtn) startPredBtn.disabled = true;
        if (startVoteBtn) startVoteBtn.disabled = true;
        if (endVoteBtn) endVoteBtn.disabled = true;
        if (calcBtn) calcBtn.disabled = true;
        if (endTournamentBtn) endTournamentBtn.disabled = true;
    } else {
        if (startPredBtn) startPredBtn.disabled = (room.voteState === 'VOTING' || room.voteState === 'CLOSED');
        if (startVoteBtn) startVoteBtn.disabled = (room.voteState === 'VOTING');
        if (endVoteBtn) endVoteBtn.disabled = (room.voteState !== 'VOTING');
        if (calcBtn) calcBtn.disabled = (room.voteState !== 'CLOSED' || !room.selectedWinnerId);
        if (endTournamentBtn) endTournamentBtn.disabled = false;
    }
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
        room = data.payload;

        // Player 画面への状態反映
        const playerStatusMsg = document.getElementById('player-status-message');
        if (playerStatusMsg) {
            if (room.voteState === 'TOURNAMENT_ENDED') {
                playerStatusMsg.className = 'badge badge-ended';
                playerStatusMsg.innerText = '🏆 大会が終了しました';
            } else {
                playerStatusMsg.className = 'badge badge-waiting';
                playerStatusMsg.innerText = '対戦準備中';
            }
        }

        // 自分の最新ポイントを更新・同期
        let myVoter = room.voters.find(x => x.id === viewerId);
        if (myVoter) {
            viewerPoints = myVoter.points;
            localStorage.setItem('viewer_points', viewerPoints);
            const ptElem = document.getElementById('viewer-points');
            if (ptElem) ptElem.innerText = viewerPoints;
        }

        // 新しいマッチ投票開始の検知
        if (room.roundId && room.roundId !== currentRoundId) {
            currentRoundId = room.roundId;
            voteSubmittedLocally = false;
            selectedVotePlayerId = null;
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

function registerVoter() {
    const nameInput = document.getElementById('input-voter-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) return alert('名前を入力してください。');

    const btn = document.getElementById('btn-register-voter');
    if (btn) btn.disabled = true;

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

function setVoteConnectStatus(text) {
    const el = document.getElementById('vote-connect-status');
    if (el) el.innerText = text;
}

function submitPrediction() {
    if (room.voteState === 'TOURNAMENT_ENDED') return;
    if (!selectedPredPlayerId) return alert('選手を選択してください。');

    const btn = document.getElementById('btn-submit-pred');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;

    hostConn.send({
        type: 'SUBMIT_PREDICTION',
        payload: { viewerId, predPlayerId: selectedPredPlayerId }
    });
    alert('大会優勝予想を送信しました！');
    document.getElementById('prediction-section').style.display = 'none';
}

function selectVotePlayer(id) {
    if (voteSubmittedLocally || room.voteState === 'TOURNAMENT_ENDED') return;
    selectedVotePlayerId = id;
    updateVoteUI();
}

function selectPredPlayer(id) {
    if (room.voteState === 'TOURNAMENT_ENDED') return;
    selectedPredPlayerId = id;
    updateVoteUI();
}

function submitVote() {
    if (voteSubmittedLocally || room.voteState !== 'VOTING') {
        return alert('現在は投票できないか、すでに送信済みです。');
    }

    const betInput = parseInt(document.getElementById('input-bet-point').value);
    if (!selectedVotePlayerId || isNaN(betInput) || betInput <= 0 || betInput > viewerPoints) {
        return alert('正しい選手を選択し、所持ポイント以下の賭けポイントを入力してください。');
    }

    voteSubmittedLocally = true;

    hostConn.send({
        type: 'SUBMIT_VOTE',
        payload: { viewerId, playerId: selectedVotePlayerId, betPoint: betInput }
    });

    updateVoteUI();
}

function renderVoteSummary() {
    if (!room.players || room.players.length === 0) return '';

    const counts = {};
    room.players.forEach(p => counts[p.id] = 0);
    room.votes.forEach(v => {
        if (counts[v.playerId] !== undefined) {
            counts[v.playerId]++;
        }
    });

    let html = '<div style="margin-top:1.2rem; text-align:left; background:rgba(15, 23, 42, 0.6); padding:1rem; border-radius:8px; border:1px solid var(--card-border);">';
    html += '<h4 style="margin-bottom:0.5rem; text-align:center;">📊 投票結果集計</h4>';
    room.players.forEach(p => {
        html += `<div style="display:flex; justify-content:space-between; margin-bottom:0.3rem;">
                    <span>${escapeHtml(p.name)}</span>
                    <strong>${counts[p.id] || 0}票</strong>
                 </div>`;
    });
    html += '</div>';
    return html;
}

function renderTournamentEndedUI() {
    // ポイント降順（同ポイントなら登録順維持）
    const sortedVoters = [...room.voters].sort((a, b) => b.points - a.points);
    const myRankIndex = sortedVoters.findIndex(v => v.id === viewerId);
    const myRankText = myRankIndex !== -1 ? `${myRankIndex + 1}位` : '圏外';
    const championText = sortedVoters.length > 0 ? escapeHtml(sortedVoters[0].name) : 'なし';

    const top10 = sortedVoters.slice(0, 10);
    const rankingItemsHtml = top10.length > 0
        ? top10.map((v, i) => `
            <li style="padding: 0.5rem 0; border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between;">
                <span><strong>${i + 1}位 ${escapeHtml(v.name)}</strong></span>
                <strong style="color: #fbbf24;">${v.points}pt</strong>
            </li>`).join('')
        : '<li style="text-align:center; padding:0.5rem;">参加者がいません</li>';

    return `
        <div style="text-align: center; padding: 0.5rem 0;">
            <h2 style="color: #fbbf24; margin-bottom: 1rem;">🏆 大会終了</h2>
            
            <div style="background: rgba(15, 23, 42, 0.6); padding: 1.2rem; border-radius: 12px; border: 1px solid var(--card-border); margin-bottom: 1.5rem;">
                <div style="font-size: 0.85rem; color: var(--text-sub);">あなたの順位</div>
                <div style="font-size: 2.2rem; font-weight: 800; color: var(--success); margin: 0.2rem 0;">${myRankText}</div>
                
                <div style="font-size: 0.85rem; color: var(--text-sub); margin-top: 0.8rem;">ポイント</div>
                <div class="point-display" style="font-size: 1.8rem; margin: 0.2rem 0;">${viewerPoints} pt</div>
                
                <div style="font-size: 0.85rem; color: var(--text-sub); margin-top: 0.8rem;">優勝</div>
                <div style="font-size: 1.4rem; font-weight: bold; color: #fbbf24;">${championText}</div>
            </div>

            <h3 style="margin-bottom: 0.8rem;">🏆 TOP10 ランキング</h3>
            <ol style="text-align: left; list-style: none; padding: 0.5rem 1rem; background: rgba(15, 23, 42, 0.4); border-radius: 8px; border: 1px solid var(--card-border);">
                ${rankingItemsHtml}
            </ol>
        </div>
    `;
}

function updateVoteUI() {
    const badge = document.getElementById('vote-state-badge');
    if (badge) badge.innerText = room.voteState;

    const pointsHeader = document.getElementById('vote-points-header');
    const voteFormArea = document.getElementById('vote-form-area');
    const resultSec = document.getElementById('vote-result-section');
    const predSec = document.getElementById('prediction-section');

    // 大会終了状態 (TOURNAMENT_ENDED)
    if (room.voteState === 'TOURNAMENT_ENDED') {
        if (pointsHeader) pointsHeader.style.display = 'none';
        if (voteFormArea) voteFormArea.style.display = 'none';
        if (predSec) predSec.style.display = 'none';
        if (resultSec) {
            resultSec.style.display = 'block';
            resultSec.innerHTML = renderTournamentEndedUI();
        }
        return;
    }

    if (pointsHeader) pointsHeader.style.display = 'block';

    if (predSec) {
        predSec.style.display = room.voteState === 'PREDICTION' ? 'block' : 'none';
        if (room.voteState === 'PREDICTION') {
            const predList = document.getElementById('pred-player-list');
            if (predList && room.players.length > 0) {
                predList.innerHTML = room.players.map(p => `
                    <div class="list-item selectable-item ${selectedPredPlayerId === p.id ? 'active' : ''}" onclick="selectPredPlayer('${p.id}')">
                        <span>${escapeHtml(p.name)}</span>
                    </div>
                `).join('');
            }
        }
    }

    if (room.voteState === 'VOTING') {
        if (voteFormArea) voteFormArea.style.display = 'block';
        if (resultSec) resultSec.style.display = 'none';

        const voteList = document.getElementById('vote-player-list');
        if (voteList && room.players.length > 0) {
            voteList.innerHTML = room.players.map(p => `
                <div class="list-item selectable-item ${selectedVotePlayerId === p.id ? 'active' : ''}" onclick="${voteSubmittedLocally ? '' : `selectVotePlayer('${p.id}')`}">
                    <span>${escapeHtml(p.name)}</span>
                </div>
            `).join('');
        }

        const submitBtn = document.getElementById('btn-submit-vote');
        if (submitBtn) {
            submitBtn.disabled = voteSubmittedLocally;
            submitBtn.innerText = voteSubmittedLocally ? '投票済み' : '投票する';
        }
    }
    else if (room.voteState === 'CLOSED') {
        if (voteFormArea) voteFormArea.style.display = 'none';
        if (resultSec) {
            resultSec.style.display = 'block';
            resultSec.innerHTML = `
                <div style="text-align: center; padding: 1rem 0;">
                    <h3 style="color: var(--warning);">🔒 投票締め切り</h3>
                    <p class="subtitle">試合結果と勝者決定を待っています...</p>
                    ${renderVoteSummary()}
                </div>
            `;
        }
    }
    else if (room.voteState === 'ENDED') {
        if (voteFormArea) voteFormArea.style.display = 'none';
        if (resultSec) {
            resultSec.style.display = 'block';

            const winner = room.players.find(p => p.id === room.selectedWinnerId);
            const winnerName = winner ? escapeHtml(winner.name) : '未設定';

            const myVote = room.votes.find(v => v.viewerId === viewerId);
            const myVotedPlayer = myVote ? room.players.find(p => p.id === myVote.playerId) : null;
            const myVotedName = myVotedPlayer ? escapeHtml(myVotedPlayer.name) : (myVote ? '不明' : '未投票');

            let isWin = false;
            let pointDiffText = '0pt';
            let statusBadge = '';

            if (myVote) {
                if (myVote.playerId === room.selectedWinnerId) {
                    isWin = true;
                    pointDiffText = `+${myVote.betPoint * 2}pt`;
                    statusBadge = '<div style="font-size: 1.5rem; color: var(--success); font-weight: bold; margin: 0.5rem 0;">✅ 的中</div>';
                } else {
                    pointDiffText = `-${myVote.betPoint}pt`;
                    statusBadge = '<div style="font-size: 1.5rem; color: var(--danger); font-weight: bold; margin: 0.5rem 0;">❌ 外れ</div>';
                }
            } else {
                statusBadge = '<div style="font-size: 1.2rem; color: var(--text-sub); margin: 0.5rem 0;">未投票</div>';
            }

            resultSec.innerHTML = `
                <div style="text-align: center; padding: 0.5rem 0;">
                    <div style="font-size: 0.9rem; color: var(--text-sub);">🏆 勝者</div>
                    <div style="font-size: 1.5rem; font-weight: bold; color: var(--primary); margin-bottom: 1rem;">${winnerName}</div>

                    <div style="font-size: 0.85rem; color: var(--text-sub);">あなたの投票</div>
                    <div style="font-size: 1.1rem; font-weight: bold; margin-bottom: 0.5rem;">${myVotedName}</div>

                    ${statusBadge}

                    <div style="font-size: 1.4rem; font-weight: bold; margin-bottom: 1rem; color: ${isWin ? 'var(--success)' : 'var(--danger)'};">
                        ${pointDiffText}
                    </div>

                    <div style="border-top: 1px solid var(--card-border); padding-top: 0.8rem;">
                        <div style="font-size: 0.85rem; color: var(--text-sub);">所持ポイント</div>
                        <div class="point-display" style="font-size: 1.8rem;">${viewerPoints} pt</div>
                    </div>

                    ${renderVoteSummary()}
                </div>
            `;
        }
    }
    else {
        if (voteFormArea) voteFormArea.style.display = 'none';
        if (resultSec) resultSec.style.display = 'none';
    }
}

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}