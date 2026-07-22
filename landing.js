// ===== ランディングページ =====
// ホスト起動またはプレイヤー参加のエントリポイント

var app = document.getElementById('app');

// ランディング画面のHTMLを生成
app.innerHTML = [
  '<div class="landing">',
  '  <h1>P2P Voting System</h1>',
  '  <button id="btn-create-room">Create Room</button>',
  '  <hr />',
  '  <h2>Join as Player</h2>',
  '  <input type="text" id="landing-room-code" placeholder="Room Code" maxlength="6" autocomplete="off" />',
  '  <input type="text" id="landing-player-name" placeholder="Your Name" autocomplete="off" />',
  '  <button id="btn-join-player">Join</button>',
  '</div>'
].join('');

// 「Create Room」ボタン → host.html へ遷移
document.getElementById('btn-create-room').addEventListener('click', function () {
  window.location.href = 'host.html';
});

// 「Join」ボタン → ルームコードと名前をURLパラメータとしてplayer.htmlへ遷移
document.getElementById('btn-join-player').addEventListener('click', function () {
  var roomInput = document.getElementById('landing-room-code');
  var nameInput = document.getElementById('landing-player-name');
  var roomCode = roomInput.value.trim().toUpperCase();
  var name = nameInput.value.trim();
  if (roomCode.length > 0 && name.length > 0) {
    window.location.href = 'player.html?room=' + encodeURIComponent(roomCode) + '&name=' + encodeURIComponent(name);
  }
});
