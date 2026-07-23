// =====================================================================
// リアルタイム対戦・投票システム - フロントエンドロジック
// PeerJS (WebRTC) を使い、サーバーレスで「ホスト」端末と
// 「プレイヤー」「観戦者(投票者)」端末をP2P接続する。
// 状態(room)はホスト側だけが保持し、変更のたびに全クライアントへ
// SYNC_STATE として配信（ブロードキャスト）する「ホスト権威モデル」。
// =====================================================================

// 観戦者の初期所持ポイント
const INITIAL_POINTS = 50;

// --- PeerJS関連のグローバル状態 ---
let peer = null; // 自分のPeerJSインスタンス（ホスト or クライアント共通で使う）
let hostConnections = new Map(); // [ホスト用] 接続してきた各クライアントとのDataConnectionを保持 (peerId -> conn)
let hostConn = null; // [クライアント用] ホストとの単一のDataConnection

// --- 観戦者(投票者)のローカル状態。localStorageで再読込後も維持する ---
let voterName = ""; // 観戦者の表示名
let viewerPoints = INITIAL_POINTS; // 自分の所持ポイント（ホストからの同期で更新される）
let viewerId = ""; // 自分を識別するID（ランダム生成しlocalStorageに保存）

// マッチ投票のラウンドを識別するID。変わったら新しい投票が始まったと判断する
let currentRoundId = null;

// --- ゲーム全体の状態（ホストが管理する「正」のデータ）。---
// クライアント側ではSYNC_STATEを受信するたびにこのオブジェクト全体を置き換える。
let room = {
  roomCode: "", // 部屋の参加コード（例: A1B2C3）
  players: [], // 対戦プレイヤー一覧 [{ id, name }]
  voters: [], // 観戦者(投票者)一覧 [{ id, name, points, tournamentPredId }]
  voteState: "WAITING", // 進行状態: WAITING | PREDICTION(優勝予想) | VOTING(投票中) | CLOSED(締切) | ENDED(結果発表) | TOURNAMENT_ENDED(大会終了)
  votes: [], // 今ラウンドの投票一覧 [{ viewerId, playerId, betPoint }]
  selectedWinnerId: null, // ホストが選択した勝者プレイヤーID
  roundId: null, // 現在のマッチ投票ラウンドID（startVotingのたびに再生成）
};

// --- 観戦者画面のUI選択状態（ローカルのみ、サーバーには送らない） ---
let selectedVotePlayerId = null; // マッチ投票で選択中のプレイヤーID
let selectedPredPlayerId = null; // 優勝予想で選択中のプレイヤーID
let voteSubmittedLocally = false; // 今ラウンドで既に投票を送信済みかどうか（連投防止用）

// 部屋コードからPeerJSのPeerID（一意な接続先ID）を作る
// 例: コード "A1B2C3" -> "rtgame-a1b2c3"
function makePeerId(code) {
  return "rtgame-" + code.toLowerCase();
}

// 現在のPeer接続をすべて破棄する（別の部屋に接続し直す前などに呼ぶ）
function destroyPeer() {
  if (peer) {
    try {
      peer.destroy();
    } catch (e) {}
  }
  peer = null;
  hostConn = null;
  hostConnections.clear();
}

// 指定したIDの画面(screen)だけを表示し、他は非表示にする（SPA的な画面切り替え）
function showScreen(screenId) {
  document
    .querySelectorAll(".screen")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
}

// ----- 各画面への遷移関数（HTML側のonclickから呼ばれる） -----
function goToTitle() {
  showScreen("screen-title");
}
function goToHost() {
  initHost(); // ホストとしてPeerJSを起動し、部屋を作成する
  showScreen("screen-host");
}
function goToPlayer() {
  showScreen("screen-player");
}
function goToVoteLogin() {
  showScreen("screen-vote-login");
}

// ================= 観戦者(投票者)の接続処理 =================

// 観戦者としてホストに接続し、投票画面を初期化する
// code: ホストが発行した部屋の参加コード
function initVoteClient(code) {
  const roomCode = code.toUpperCase();
  room.roomCode = roomCode;
  document.getElementById("vote-room-code-display").innerText = roomCode;
  showScreen("screen-vote");

  // 既に名前登録済みなら投票メイン画面、未登録なら名前入力フォームを表示
  if (voterName) {
    document.getElementById("vote-name-form").style.display = "none";
    document.getElementById("vote-main-section").style.display = "block";
    document.getElementById("display-voter-name").innerText = voterName;
  } else {
    document.getElementById("vote-name-form").style.display = "block";
    document.getElementById("vote-main-section").style.display = "none";
  }

  setVoteConnectStatus("Hostに接続中...");

  const btn = document.getElementById("btn-register-voter");
  if (btn) {
    btn.disabled = true;
    btn.innerText = "ホストに接続中...";
  }

  // ホストへPeerJSで接続。接続成功/失敗でそれぞれコールバックを実行
  connectToHost(roomCode, {
    onOpen: () => {
      setVoteConnectStatus("");
      if (btn) {
        btn.disabled = false;
        btn.innerText = "投票に参加する";
      }
      // 名前登録済みなら再登録（再接続時の同期のため）、未登録なら最新状態を要求
      if (voterName) sendVoterRegister();
      else hostConn.send({ type: "REQUEST_SYNC" });
    },
    onFail: () => {
      setVoteConnectStatus("⚠ 接続失敗。参加コードを確認してください。");
      if (btn) btn.innerText = "接続エラー";
    },
  });
}

// 「観戦者参加」画面で参加コードを入力し接続ボタンを押したときの処理
function joinAsVote() {
  const code = document.getElementById("input-vote-room-code").value.trim();
  if (!code) return alert("参加コードを入力してください。");
  initVoteClient(code);
}

// 起動時: QRコード経由のアクセス（URLに role=vote&room=コード が付いている）の場合、
// 前回セッションのキャッシュ（名前・ポイント等）をクリアして新規観戦者として扱う。
// 通常アクセス（URLパラメータなし）の場合はlocalStorageから前回の状態を復元する。
window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const role = params.get("role");
  const code = params.get("room");

  if (role === "vote" && code) {
    // QRコード経由: 新しい観戦者としてリセットする
    localStorage.removeItem("voter_name");
    localStorage.removeItem("viewer_points");
    localStorage.removeItem("viewer_id");

    voterName = "";
    viewerPoints = INITIAL_POINTS;
    viewerId = "viewer_" + Math.random().toString(36).substring(2, 9);
    localStorage.setItem("viewer_id", viewerId);
    localStorage.setItem("viewer_points", viewerPoints);

    initVoteClient(code);
  } else {
    // 通常アクセス: localStorageに保存済みの状態を復元してタイトル画面へ
    viewerId =
      localStorage.getItem("viewer_id") ||
      "viewer_" + Math.random().toString(36).substring(2, 9);
    voterName = localStorage.getItem("voter_name") || "";
    viewerPoints =
      parseInt(localStorage.getItem("viewer_points")) || INITIAL_POINTS;
    localStorage.setItem("viewer_id", viewerId);

    showScreen("screen-title");
  }
});

// ================= Host（ホスト）ロジック =================
// ホストは部屋の状態(room)を一元管理し、全クライアントへ配信する「サーバー役」になる。

// ホストとしてPeerJSを起動し、部屋コードを発行してQRコードを表示する
function initHost() {
  if (peer) return; // 既に起動済みなら何もしない（二重初期化防止）

  // ランダムな6文字の部屋コードを生成（例: "A1B2C3"）
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  room.roomCode = code;
  document.getElementById("host-room-code").innerText = code;
  setHostPeerStatus("Peerサーバーに接続中...");

  // 部屋コードから決まるPeerIDでPeerJSを初期化（クライアントはこのIDに接続してくる）
  peer = new Peer(makePeerId(code));

  peer.on("open", () => {
    setHostPeerStatus("準備完了 ✅ プレイヤー・観戦者を招待できます");
    generateQRCode(code);
  });

  // クライアントから接続要求があったときの処理
  peer.on("connection", (conn) => {
    conn.on("open", () => {
      hostConnections.set(conn.peer, conn);
      // 接続直後に現在の部屋状態を送って同期させる
      conn.send({ type: "SYNC_STATE", payload: room });
    });
    conn.on("data", (data) => handleHostData(conn, data));
    conn.on("close", () => hostConnections.delete(conn.peer));
  });

  // PeerJSサーバーとの接続が切れた場合は自動再接続を試みる
  peer.on("disconnected", () => peer.reconnect());
  updateHostUI();
}

// ホスト画面の接続ステータス文言を更新する
function setHostPeerStatus(text) {
  const el = document.getElementById("host-peer-status");
  if (el) el.innerText = text;
}

// クライアントから届いたメッセージをtype別に処理する（ホスト側の中心的なロジック）
function handleHostData(conn, data) {
  const { type, payload } = data;
  switch (type) {
    // プレイヤーが対戦参加してきたとき
    case "JOIN_PLAYER":
      if (!room.players.find((p) => p.id === payload.id)) {
        room.players.push(payload);
      }
      broadcastState();
      break;

    // 観戦者が名前登録（または再登録）してきたとき
    case "REGISTER_VOTER":
      let v = room.voters.find((x) => x.id === payload.id);
      if (!v) {
        // 新規登録: 初期ポイントを付与
        room.voters.push({
          id: payload.id,
          name: payload.name,
          points: INITIAL_POINTS,
          tournamentPredId: null,
        });
      } else {
        // 既存観戦者の名前だけ更新（再接続時など）
        v.name = payload.name;
      }
      broadcastState();
      break;

    // 大会優勝予想を送信してきたとき
    case "SUBMIT_PREDICTION":
      let voterP = room.voters.find((x) => x.id === payload.viewerId);
      if (voterP) voterP.tournamentPredId = payload.predPlayerId;
      broadcastState();
      break;

    // マッチ投票を送信してきたとき
    case "SUBMIT_VOTE":
      // 投票受付中(VOTING)のときだけ受け付ける
      if (room.voteState === "VOTING") {
        // 同一viewerIdからの二重投票を防ぐ
        if (!room.votes.find((v) => v.viewerId === payload.viewerId)) {
          room.votes.push(payload);
          // 賭けポイント分を所持ポイントから即時減算（結果発表時に的中していれば倍額を加算）
          let voter = room.voters.find((x) => x.id === payload.viewerId);
          if (voter) voter.points -= payload.betPoint;
          broadcastState();
        }
      }
      break;

    // クライアントが最新状態を要求してきたとき（再接続時など）
    case "REQUEST_SYNC":
      conn.send({ type: "SYNC_STATE", payload: room });
      break;
  }
}

// room状態が変化するたびに呼ぶ: ホスト自身の画面更新 + 全クライアントへ状態を配信
function broadcastState() {
  updateHostUI();
  hostConnections.forEach((conn) => {
    if (conn.open) conn.send({ type: "SYNC_STATE", payload: room });
  });
}

// 観戦者用の参加URL（?role=vote&room=コード）を埋め込んだQRコードを生成して表示する
function generateQRCode(code) {
  const qrContainer = document.getElementById("qrcode");
  qrContainer.innerHTML = "";
  const voteUrl = `${window.location.origin}${window.location.pathname}?role=vote&room=${code}`;
  new QRCode(qrContainer, { text: voteUrl, width: 140, height: 140 });
}

// 「大会優勝予想開始」ボタン: 優勝予想の受付フェーズに移行する
function startPrediction() {
  if (room.voteState === "TOURNAMENT_ENDED") return; // 大会終了後は操作不可
  room.voteState = "PREDICTION";
  broadcastState();
}

// 「マッチ投票開始」ボタン: 新しいマッチの投票を開始する（前回の投票結果はリセット）
function startVoting() {
  if (room.voteState === "TOURNAMENT_ENDED") return;
  room.votes = []; // 新ラウンドなので投票をクリア
  room.selectedWinnerId = null; // 勝者選択もリセット
  room.voteState = "VOTING";
  room.roundId = "round_" + Date.now(); // 新ラウンドIDを発行（クライアント側の状態リセットの目印になる）
  broadcastState();
}

// 「投票締切」ボタン: これ以降の投票を受け付けなくする
function endVoting() {
  if (room.voteState !== "VOTING") return; // 投票中でなければ何もしない
  room.voteState = "CLOSED";
  broadcastState();
}

// ホスト画面でプレイヤーをタップして勝者候補として選択したときの処理
// （まだ確定ではなく、後述のannounceWinnerで確定・ポイント計算する）
function selectWinner(playerId) {
  if (room.voteState === "TOURNAMENT_ENDED") return;
  room.selectedWinnerId = playerId;
  broadcastState();
}

// プレイヤー一覧の「除外」ボタン: 負けた（脱落した）プレイヤーを参加者一覧から取り除く。
// 除外後は以降の優勝予想・マッチ投票の選手リストに表示されなくなる。
// 過去の投票・優勝予想（votes / voters の tournamentPredId）は履歴として残す（削除しない）。
function excludePlayer(playerId) {
  if (room.voteState === "TOURNAMENT_ENDED") return;

  const target = room.players.find((p) => p.id === playerId);
  if (!target) return;
  if (!confirm(`「${target.name}」をプレイヤー一覧から除外しますか？`)) return;

  room.players = room.players.filter((p) => p.id !== playerId);

  // 除外したプレイヤーが勝者候補として選択中だった場合は選択を解除する
  if (room.selectedWinnerId === playerId) {
    room.selectedWinnerId = null;
  }

  broadcastState();
}

// 「勝者決定・ポイント計算」ボタン: 勝者を確定し、的中した観戦者にポイントを付与する
function announceWinner() {
  if (room.voteState === "TOURNAMENT_ENDED") return;
  if (room.voteState !== "CLOSED") {
    return alert("まず「投票締切」を押して投票を締め切ってください。");
  }
  if (!room.selectedWinnerId) {
    return alert("左側のプレイヤー一覧から勝者を選択してください。");
  }

  // 的中した投票者に、賭けポイントの2倍を払い戻す（ハズレは投票時に減算済みで戻らない）
  room.votes.forEach((v) => {
    if (v.playerId === room.selectedWinnerId) {
      let voter = room.voters.find((x) => x.id === v.viewerId);
      if (voter) {
        voter.points += v.betPoint * 2;
      }
    }
  });

  room.voteState = "ENDED";
  broadcastState();
}

// 「ゲーム終了」ボタン: 大会全体を終了し、最終ランキングを表示する
function endTournament() {
  room.voteState = "TOURNAMENT_ENDED";
  broadcastState();
  showRankingModal();
}

// ホスト画面に最終ランキング（上位10名）をモーダルで表示する
function showRankingModal() {
  // ポイント順に並び替え（同ポイントの場合は配列の順序＝先着順を保持）
  const sorted = [...room.voters]
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
  const listEl = document.getElementById("ranking-list");

  if (listEl) {
    listEl.innerHTML =
      sorted.length > 0
        ? sorted
            .map(
              (v, i) => `
                <li style="padding: 0.6rem 0; border-bottom: 1px solid var(--card-border); font-size: 1.1rem; display: flex; justify-content: space-between;">
                    <span><strong>${i + 1}位 ${escapeHtml(v.name)}</strong></span>
                    <strong style="color: #fbbf24;">${v.points}pt</strong>
                </li>`,
            )
            .join("")
        : '<li style="text-align:center; padding:1rem;">参加者がいません</li>';
  }

  const modal = document.getElementById("ranking-modal");
  if (modal) modal.style.display = "block";
}

// ランキングモーダルを閉じる
function closeRanking() {
  const modal = document.getElementById("ranking-modal");
  if (modal) modal.style.display = "none";
}

// ホスト画面全体（プレイヤー一覧・状態バッジ・各操作ボタンの有効/無効）を最新のroomに合わせて再描画する
function updateHostUI() {
  const listContainer = document.getElementById("host-player-list");
  const countSpan = document.getElementById("player-count");
  if (countSpan) countSpan.innerText = room.players.length;

  // 参加プレイヤー一覧を描画（タップで勝者候補として選択、除外ボタンでリストから除外できる）
  if (listContainer) {
    if (room.players.length === 0) {
      listContainer.innerHTML =
        '<p class="subtitle">プレイヤーの参加を待っています...</p>';
    } else {
      listContainer.innerHTML = room.players
        .map((p) => {
          const isSelected = room.selectedWinnerId === p.id;
          const excludeBtnHtml =
            room.voteState === "TOURNAMENT_ENDED"
              ? ""
              : `<button
                        type="button"
                        class="btn btn-danger"
                        style="width:auto; padding:0.3rem 0.6rem; font-size:0.75rem;"
                        onclick="event.stopPropagation(); excludePlayer('${p.id}')"
                      >除外</button>`;
          return `
                  <div class="list-item selectable-item ${isSelected ? "active" : ""}" onclick="selectWinner('${p.id}')">
                    <span><strong>${escapeHtml(p.name)}</strong></span>
                    <span style="display:flex; align-items:center; gap:0.5rem;">
                      ${isSelected ? '<span class="badge badge-success">勝者選択中</span>' : ""}
                      ${excludeBtnHtml}
                    </span>
                  </div>`;
        })
        .join("");
    }
  }

  const badge = document.getElementById("host-state-badge");
  if (badge) {
    badge.innerText = "状態: " + room.voteState;
  }

  // 各操作ボタンの有効/無効を、現在の進行状態(voteState)に応じて切り替える
  const startPredBtn = document.getElementById("btn-start-pred");
  const startVoteBtn = document.getElementById("btn-start-vote");
  const endVoteBtn = document.getElementById("btn-end-vote");
  const calcBtn = document.getElementById("btn-calc-result");
  const endTournamentBtn = document.getElementById("btn-end-tournament");

  if (room.voteState === "TOURNAMENT_ENDED") {
    // 大会終了後は全操作ボタンを無効化
    if (startPredBtn) startPredBtn.disabled = true;
    if (startVoteBtn) startVoteBtn.disabled = true;
    if (endVoteBtn) endVoteBtn.disabled = true;
    if (calcBtn) calcBtn.disabled = true;
    if (endTournamentBtn) endTournamentBtn.disabled = true;
  } else {
    // 投票中(VOTING)や締切後(CLOSED)は優勝予想を開始できない
    if (startPredBtn)
      startPredBtn.disabled =
        room.voteState === "VOTING" || room.voteState === "CLOSED";
    // 投票中は「マッチ投票開始」を無効化（連打で投票がリセットされるのを防止）
    if (startVoteBtn) startVoteBtn.disabled = room.voteState === "VOTING";
    // 投票中以外は「投票締切」を無効化
    if (endVoteBtn) endVoteBtn.disabled = room.voteState !== "VOTING";
    // 締切済みかつ勝者未選択の間は「勝者決定・ポイント計算」を無効化
    if (calcBtn)
      calcBtn.disabled = room.voteState !== "CLOSED" || !room.selectedWinnerId;
    if (endTournamentBtn) endTournamentBtn.disabled = false;
  }
}

// ================= クライアント共通処理 / Player / 観戦者(投票者) =================

// 指定した部屋コードのホストへPeerJSで接続する（プレイヤー・観戦者どちらも共通で使う）
// onOpen: 接続成功時、onFail: 接続失敗時のコールバック
function connectToHost(code, { onOpen, onFail } = {}) {
  destroyPeer(); // 念のため既存の接続を破棄してから新規接続する
  peer = new Peer();

  peer.on("open", () => {
    hostConn = peer.connect(makePeerId(code), { reliable: true });
    hostConn.on("open", () => {
      if (onOpen) onOpen();
    });
    hostConn.on("data", (data) => handleClientData(data));
  });

  peer.on("error", (err) => {
    if (onFail) onFail();
  });
}

// ホストから届いたデータを処理する（プレイヤー・観戦者共通のクライアント側受信処理）
function handleClientData(data) {
  if (data.type === "SYNC_STATE") {
    // ホストから送られてきた最新の部屋状態で、自分のroomを丸ごと置き換える
    room = data.payload;

    // Player（対戦プレイヤー）画面への状態反映
    const playerStatusMsg = document.getElementById("player-status-message");
    if (playerStatusMsg) {
      if (room.voteState === "TOURNAMENT_ENDED") {
        playerStatusMsg.className = "badge badge-ended";
        playerStatusMsg.innerText = "🏆 大会が終了しました";
      } else {
        playerStatusMsg.className = "badge badge-waiting";
        playerStatusMsg.innerText = "対戦準備中";
      }
    }

    // 自分（観戦者）の最新ポイントを同期し、localStorageにも保存しておく
    let myVoter = room.voters.find((x) => x.id === viewerId);
    if (myVoter) {
      viewerPoints = myVoter.points;
      localStorage.setItem("viewer_points", viewerPoints);
      const ptElem = document.getElementById("viewer-points");
      if (ptElem) ptElem.innerText = viewerPoints;
    }

    // roundIdが変わっていたら新しいマッチ投票が始まったということなので、
    // ローカルの投票済みフラグ・選択状態をリセットする
    if (room.roundId && room.roundId !== currentRoundId) {
      currentRoundId = room.roundId;
      voteSubmittedLocally = false;
      selectedVotePlayerId = null;
    }

    updateVoteUI();
  }
}

// 「プレイヤー（対戦参加）」画面の「参加する」ボタン処理
// 入力された部屋コード・プレイヤー名をもとにホストへ接続し、参加を申請する
function joinGame() {
  const codeInput = document
    .getElementById("input-room-code")
    .value.trim()
    .toUpperCase();
  const nameInput = document.getElementById("input-player-name").value.trim();

  if (!codeInput || !nameInput) return alert("入力してください。");

  const player = {
    id: "player_" + Math.random().toString(36).substring(2, 9),
    name: nameInput,
  };

  connectToHost(codeInput, {
    onOpen: () => {
      hostConn.send({ type: "JOIN_PLAYER", payload: player });
      document.getElementById("player-join-form").style.display = "none";
      document.getElementById("player-joined-info").style.display = "block";
      document.getElementById("player-display-name").innerText = nameInput;
    },
  });
}

// 観戦者が名前を入力して「投票に参加する」ボタンを押したときの処理
function registerVoter() {
  const nameInput = document.getElementById("input-voter-name");
  const name = nameInput ? nameInput.value.trim() : "";
  if (!name) return alert("名前を入力してください。");

  const btn = document.getElementById("btn-register-voter");
  if (btn) btn.disabled = true;

  voterName = name;
  localStorage.setItem("voter_name", voterName); // 再読込しても名前を保持できるように保存

  document.getElementById("vote-name-form").style.display = "none";
  document.getElementById("vote-main-section").style.display = "block";
  document.getElementById("display-voter-name").innerText = voterName;

  sendVoterRegister();
}

// 観戦者の登録情報（ID・名前）をホストへ送信する
function sendVoterRegister() {
  if (hostConn && hostConn.open) {
    hostConn.send({
      type: "REGISTER_VOTER",
      payload: { id: viewerId, name: voterName },
    });
  }
}

// 観戦者画面の接続ステータス文言を更新する
function setVoteConnectStatus(text) {
  const el = document.getElementById("vote-connect-status");
  if (el) el.innerText = text;
}

// 「優勝予想を送信」ボタン: 選択中の選手をホストへ優勝予想として送信する
function submitPrediction() {
  if (room.voteState === "TOURNAMENT_ENDED") return;
  if (!selectedPredPlayerId) return alert("選手を選択してください。");

  const btn = document.getElementById("btn-submit-pred");
  if (btn && btn.disabled) return; // 二重送信防止
  if (btn) btn.disabled = true;

  hostConn.send({
    type: "SUBMIT_PREDICTION",
    payload: { viewerId, predPlayerId: selectedPredPlayerId },
  });
  alert("大会優勝予想を送信しました！");
  document.getElementById("prediction-section").style.display = "none";
}

// マッチ投票で選手をタップして選択したときの処理（送信済み・大会終了後は選択不可）
function selectVotePlayer(id) {
  if (voteSubmittedLocally || room.voteState === "TOURNAMENT_ENDED") return;
  selectedVotePlayerId = id;
  updateVoteUI();
}

// 優勝予想で選手をタップして選択したときの処理
function selectPredPlayer(id) {
  if (room.voteState === "TOURNAMENT_ENDED") return;
  selectedPredPlayerId = id;
  updateVoteUI();
}

// 「投票する」ボタン: 選択中の選手・賭けポイントをホストへマッチ投票として送信する
function submitVote() {
  if (voteSubmittedLocally || room.voteState !== "VOTING") {
    return alert("現在は投票できないか、すでに送信済みです。");
  }

  const betInput = parseInt(document.getElementById("input-bet-point").value);
  // 入力チェック: 選手未選択・数値異常・所持ポイント超過をまとめて弾く
  if (
    !selectedVotePlayerId ||
    isNaN(betInput) ||
    betInput <= 0 ||
    betInput > viewerPoints
  ) {
    return alert(
      "正しい選手を選択し、所持ポイント以下のポイントを入力してください。",
    );
  }

  voteSubmittedLocally = true; // 連打・二重送信を防ぐためローカルで即座にフラグを立てる

  hostConn.send({
    type: "SUBMIT_VOTE",
    payload: { viewerId, playerId: selectedVotePlayerId, betPoint: betInput },
  });

  updateVoteUI();
}

// 現在の各プレイヤーへの投票数を集計し、観戦者画面向けの集計HTMLを生成する
function renderVoteSummary() {
  if (!room.players || room.players.length === 0) return "";

  const counts = {};
  room.players.forEach((p) => (counts[p.id] = 0));
  room.votes.forEach((v) => {
    if (counts[v.playerId] !== undefined) {
      counts[v.playerId]++;
    }
  });

  let html =
    '<div style="margin-top:1.2rem; text-align:left; background:rgba(15, 23, 42, 0.6); padding:1rem; border-radius:8px; border:1px solid var(--card-border);">';
  html +=
    '<h4 style="margin-bottom:0.5rem; text-align:center;">📊 投票結果集計</h4>';
  room.players.forEach((p) => {
    html += `<div style="display:flex; justify-content:space-between; margin-bottom:0.3rem;">
                    <span>${escapeHtml(p.name)}</span>
                    <strong>${counts[p.id] || 0}票</strong>
                 </div>`;
  });
  html += "</div>";
  return html;
}

// 大会終了(TOURNAMENT_ENDED)時に、観戦者画面へ表示する
// 自分の最終順位・所持ポイント・優勝者・TOP10ランキングのHTMLを生成する
function renderTournamentEndedUI() {
  // ポイント降順（同ポイントなら登録順維持）でランキングを作成
  const sortedVoters = [...room.voters].sort((a, b) => b.points - a.points);
  const myRankIndex = sortedVoters.findIndex((v) => v.id === viewerId);
  const myRankText = myRankIndex !== -1 ? `${myRankIndex + 1}位` : "圏外";
  const championText =
    sortedVoters.length > 0 ? escapeHtml(sortedVoters[0].name) : "なし";

  const top10 = sortedVoters.slice(0, 10);
  const rankingItemsHtml =
    top10.length > 0
      ? top10
          .map(
            (v, i) => `
            <li style="padding: 0.5rem 0; border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between;">
                <span><strong>${i + 1}位 ${escapeHtml(v.name)}</strong></span>
                <strong style="color: #fbbf24;">${v.points}pt</strong>
            </li>`,
          )
          .join("")
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

// 観戦者画面全体を、現在のroom.voteStateに応じて出し分けながら再描画する
// （優勝予想フォーム / 投票フォーム / 締切表示 / 結果表示 / 大会終了画面 を切り替える中心的な関数）
function updateVoteUI() {
  const badge = document.getElementById("vote-state-badge");
  if (badge) badge.innerText = room.voteState;

  const pointsHeader = document.getElementById("vote-points-header");
  const voteFormArea = document.getElementById("vote-form-area");
  const resultSec = document.getElementById("vote-result-section");
  const predSec = document.getElementById("prediction-section");

  // 大会終了状態 (TOURNAMENT_ENDED): 他の要素をすべて隠し、最終結果だけを表示
  if (room.voteState === "TOURNAMENT_ENDED") {
    if (pointsHeader) pointsHeader.style.display = "none";
    if (voteFormArea) voteFormArea.style.display = "none";
    if (predSec) predSec.style.display = "none";
    if (resultSec) {
      resultSec.style.display = "block";
      resultSec.innerHTML = renderTournamentEndedUI();
    }
    return;
  }

  // 所持ポイント表示: 優勝予想中(PREDICTION)は投票前の先入観を避けるため非表示にする
  if (pointsHeader) {
    pointsHeader.style.display =
      room.voteState === "PREDICTION" ? "none" : "block";
  }

  // 優勝予想セクション: PREDICTION状態のときだけ表示し、選手一覧を描画する
  if (predSec) {
    predSec.style.display = room.voteState === "PREDICTION" ? "block" : "none";
    if (room.voteState === "PREDICTION") {
      const predList = document.getElementById("pred-player-list");
      if (predList && room.players.length > 0) {
        predList.innerHTML = room.players
          .map(
            (p) => `
                    <div class="list-item selectable-item ${selectedPredPlayerId === p.id ? "active" : ""}" onclick="selectPredPlayer('${p.id}')">
                        <span>${escapeHtml(p.name)}</span>
                    </div>
                `,
          )
          .join("");
      }
    }
  }

  if (room.voteState === "VOTING") {
    // 投票受付中: 投票フォームを表示し、選手一覧を描画する
    if (voteFormArea) voteFormArea.style.display = "block";
    if (resultSec) resultSec.style.display = "none";

    const voteList = document.getElementById("vote-player-list");
    if (voteList && room.players.length > 0) {
      voteList.innerHTML = room.players
        .map(
          (p) => `
                <div class="list-item selectable-item ${selectedVotePlayerId === p.id ? "active" : ""}" onclick="${voteSubmittedLocally ? "" : `selectVotePlayer('${p.id}')`}">
                    <span>${escapeHtml(p.name)}</span>
                </div>
            `,
        )
        .join("");
    }

    // 投票済みなら送信ボタンを無効化し、文言も変更する
    const submitBtn = document.getElementById("btn-submit-vote");
    if (submitBtn) {
      submitBtn.disabled = voteSubmittedLocally;
      submitBtn.innerText = voteSubmittedLocally ? "投票済み" : "投票する";
    }
  } else if (room.voteState === "CLOSED") {
    // 投票締切後・勝者未発表: 締切メッセージと現在の投票集計を表示
    if (voteFormArea) voteFormArea.style.display = "none";
    if (resultSec) {
      resultSec.style.display = "block";
      resultSec.innerHTML = `
                <div style="text-align: center; padding: 1rem 0;">
                    <h3 style="color: var(--warning);">🔒 投票締め切り</h3>
                    <p class="subtitle">試合結果と勝者決定を待っています...</p>
                    ${renderVoteSummary()}
                </div>
            `;
    }
  } else if (room.voteState === "ENDED") {
    // 勝者発表後: 勝者・自分の投票内容・的中/外れ・増減ポイント・所持ポイントを表示
    if (voteFormArea) voteFormArea.style.display = "none";
    if (resultSec) {
      resultSec.style.display = "block";

      const winner = room.players.find((p) => p.id === room.selectedWinnerId);
      const winnerName = winner ? escapeHtml(winner.name) : "未設定";

      const myVote = room.votes.find((v) => v.viewerId === viewerId);
      const myVotedPlayer = myVote
        ? room.players.find((p) => p.id === myVote.playerId)
        : null;
      const myVotedName = myVotedPlayer
        ? escapeHtml(myVotedPlayer.name)
        : myVote
          ? "不明"
          : "未投票";

      let isWin = false;
      let pointDiffText = "0pt";
      let statusBadge = "";

      if (myVote) {
        if (myVote.playerId === room.selectedWinnerId) {
          // 的中: 賭けポイントの2倍を獲得（投票時に引かれた分を含め、実質+betPoint分の純増）
          isWin = true;
          pointDiffText = `+${myVote.betPoint * 2}pt`;
          statusBadge =
            '<div style="font-size: 1.5rem; color: var(--success); font-weight: bold; margin: 0.5rem 0;">✅ 的中</div>';
        } else {
          // 外れ: 投票時に引かれた賭けポイントはそのまま戻らない
          pointDiffText = `-${myVote.betPoint}pt`;
          statusBadge =
            '<div style="font-size: 1.5rem; color: var(--danger); font-weight: bold; margin: 0.5rem 0;">❌ 外れ</div>';
        }
      } else {
        statusBadge =
          '<div style="font-size: 1.2rem; color: var(--text-sub); margin: 0.5rem 0;">未投票</div>';
      }

      resultSec.innerHTML = `
                <div style="text-align: center; padding: 0.5rem 0;">
                    <div style="font-size: 0.9rem; color: var(--text-sub);">🏆 勝者</div>
                    <div style="font-size: 1.5rem; font-weight: bold; color: var(--primary); margin-bottom: 1rem;">${winnerName}</div>

                    <div style="font-size: 0.85rem; color: var(--text-sub);">あなたの投票</div>
                    <div style="font-size: 1.1rem; font-weight: bold; margin-bottom: 0.5rem;">${myVotedName}</div>

                    ${statusBadge}

                    <div style="font-size: 1.4rem; font-weight: bold; margin-bottom: 1rem; color: ${isWin ? "var(--success)" : "var(--danger)"};">
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
  } else {
    // WAITINGなど上記以外の状態: フォーム・結果ともに非表示
    if (voteFormArea) voteFormArea.style.display = "none";
    if (resultSec) resultSec.style.display = "none";
  }
}

// XSS対策: ユーザー入力（プレイヤー名・観戦者名など）をHTMLに埋め込む前に
// 特殊文字をエスケープする（innerHTMLへの直接挿入に対する基本的な防御）
function escapeHtml(str) {
  return str.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[m],
  );
}
