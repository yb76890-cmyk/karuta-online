/* ============================================================
   日本史かるた — 対戦サーバー

   考え方
   - 速さは各端末が自分の時計で測り、経過ミリ秒だけを送ってくる。
     サーバーは一番小さい値の人を勝ちにする。
     こうすると通信の速い遅いが勝敗に影響しない。
   - 正解者が出ても即座には確定させず、少し待って全員の申告を集める。
     この待ち時間が「決着までの間」になる。
   - 答えの札は結果を出すまでクライアントに送らない。
   ============================================================ */

const http = require("http");
const { WebSocketServer } = require("ws");
const { drawBoard, NIHONSHI, memoSeconds, BOARD_DEFAULT } = require("./cards");

const PORT = process.env.PORT || 8080;

const SETTLE_MS = 1200; // 最初の正解申告から締め切るまで
const ROUND_GAP_MS = 3000; // 結果を見せている間
const MAX_PLAYERS = 4;
const ROOM_TTL_MS = 1000 * 60 * 60; // 空き部屋を片付けるまで

const rooms = new Map();

/* ---------------- 小道具 ---------------- */

const rid = (n = 6) =>
  Math.random()
    .toString(36)
    .slice(2, 2 + n);

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
  }
}

function broadcast(room, obj) {
  for (const p of room.players) send(p.ws, obj);
}

function roster(room) {
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    foul: p.foul,
    connected: p.ws && p.ws.readyState === 1,
  }));
}

function pushPlayers(room) {
  broadcast(room, { t: "players", players: roster(room), host: room.hostId, phase: room.phase });
}

/* ---------------- 部屋 ---------------- */

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      players: [],
      hostId: null,
      phase: "lobby", // lobby | memorize | round | result | over
      board: [],
      target: null,
      roundId: 0,
      grabs: [],
      fouled: new Set(),
      ready: new Set(),
      settleTimer: null,
      gapTimer: null,
      memoTimer: null,
      lockFrac: 0,
      touched: Date.now(),
      log: [],
    };
    rooms.set(code, room);
  }
  room.touched = Date.now();
  return room;
}

function clearTimers(room) {
  for (const k of ["settleTimer", "gapTimer", "memoTimer"]) {
    if (room[k]) clearTimeout(room[k]);
    room[k] = null;
  }
}

/* ---------------- 進行 ---------------- */

function startGame(room, opts) {
  clearTimers(room);
  const size = Number(opts && opts.size) || BOARD_DEFAULT;
  room.size = Math.max(6, Math.min(40, size));
  room.memo = memoSeconds(room.size);
  room.board = drawBoard(NIHONSHI, room.size);
  room.roundId = 0;
  room.log = [];
  room.lockFrac = opts && opts.lock ? 0.5 : 0;
  room.players.forEach((p) => {
    p.score = 0;
    p.foul = 0;
  });
  room.phase = "memorize";
  room.ready = new Set();

  broadcast(room, {
    t: "memorize",
    seconds: room.memo,
    board: room.board.map((c) => ({ id: c.id, a: c.a })),
    players: roster(room),
  });

  room.memoTimer = setTimeout(() => openRound(room), room.memo * 1000);
}

// 全員が「覚えた」を押していれば、制限時間を待たずに始める
function checkMemoReady(room) {
  if (room.phase !== "memorize") return;
  const live = room.players.filter((p) => p.ws && p.ws.readyState === 1);
  if (live.length === 0) return;
  if (live.every((p) => room.ready.has(p.id))) {
    clearTimers(room);
    openRound(room);
  }
}

function openRound(room) {
  clearTimers(room);
  if (room.board.length === 0) return finish(room);

  room.phase = "round";
  room.roundId += 1;
  room.target = room.board[Math.floor(Math.random() * room.board.length)];
  room.grabs = [];
  room.fouled = new Set();

  // 読み札の文だけを配る。答えの札はまだ送らない。
  broadcast(room, {
    t: "round",
    roundId: room.roundId,
    clue: room.target.c,
    remaining: room.board.length,
    lockFrac: room.lockFrac,
    players: roster(room),
  });
}

function settleRound(room) {
  if (room.phase !== "round") return;
  clearTimers(room);
  room.phase = "result";

  const correct = room.grabs
    .filter((g) => g.ok)
    .sort((a, b) => a.elapsed - b.elapsed);

  let winner = null;
  if (correct.length > 0) {
    winner = correct[0];
    const p = room.players.find((x) => x.id === winner.playerId);
    if (p) p.score += 1;
  }

  room.log.push({ card: room.target, winner: winner ? winner.playerId : null });
  room.board = room.board.filter((c) => c.id !== room.target.id);

  broadcast(room, {
    t: "result",
    roundId: room.roundId,
    winner: winner ? { playerId: winner.playerId, elapsed: Math.round(winner.elapsed) } : null,
    card: { id: room.target.id, a: room.target.a, n: room.target.n, c: room.target.c },
    order: correct.map((g) => ({ playerId: g.playerId, elapsed: Math.round(g.elapsed) })),
    fouls: room.grabs.filter((g) => !g.ok).map((g) => ({ playerId: g.playerId, cardId: g.cardId })),
    players: roster(room),
    remaining: room.board.length,
  });

  room.gapTimer = setTimeout(() => openRound(room), ROUND_GAP_MS);
}

function finish(room) {
  clearTimers(room);
  room.phase = "over";
  broadcast(room, {
    t: "over",
    players: roster(room),
    log: room.log.map((e) => ({ a: e.card.a, c: e.card.c, n: e.card.n, winner: e.winner })),
  });
}

/* ---------------- 申告の受け取り ---------------- */

function handleGrab(room, player, msg) {
  if (room.phase !== "round" || msg.roundId !== room.roundId) return;
  if (room.fouled.has(player.id)) return;
  if (room.grabs.some((g) => g.playerId === player.id)) return; // 一人一回

  const elapsed = Number(msg.elapsed);
  if (!isFinite(elapsed) || elapsed < 0) return;

  const ok = msg.cardId === room.target.id;
  room.grabs.push({ playerId: player.id, cardId: msg.cardId, elapsed, ok });

  if (!ok) {
    room.fouled.add(player.id);
    player.foul += 1;
    broadcast(room, {
      t: "foul",
      roundId: room.roundId,
      playerId: player.id,
      cardId: msg.cardId,
      players: roster(room),
    });
  } else {
    // 最初の正解が出たら締め切りまで少し待ち、他の人の申告も拾う
    if (!room.settleTimer) {
      broadcast(room, { t: "settling", roundId: room.roundId, ms: SETTLE_MS });
      room.settleTimer = setTimeout(() => settleRound(room), SETTLE_MS);
    }
  }

  const live = room.players.filter((p) => p.ws && p.ws.readyState === 1);
  const done = live.every((p) => room.fouled.has(p.id) || room.grabs.some((g) => g.playerId === p.id));

  // 全員が手を出し終えていれば待たずに締める
  if (done) {
    if (room.grabs.some((g) => g.ok)) settleRound(room);
    else settleRound(room); // 全員お手つき → 取られずに次へ
  }
}

/* ---------------- 接続 ---------------- */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("karuta server");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let room = null;
  let player = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.t === "join") {
      // 全角で来ても半角に直し、数字だけを部屋番号とする
      const code = String(msg.room || "")
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/[^0-9]/g, "")
        .slice(0, 6);
      if (!code) return send(ws, { t: "error", msg: "部屋番号を入れてください" });

      room = getRoom(code);
      if (room.players.length >= MAX_PLAYERS)
        return send(ws, { t: "error", msg: "この部屋は満員です" });
      if (room.phase !== "lobby" && room.phase !== "over")
        return send(ws, { t: "error", msg: "対戦中の部屋には入れません" });

      player = {
        id: rid(),
        name: String(msg.name || "").slice(0, 8) || "名無し",
        ws,
        score: 0,
        foul: 0,
      };
      room.players.push(player);
      if (!room.hostId) room.hostId = player.id;

      send(ws, { t: "joined", you: player.id, room: code, host: room.hostId });
      pushPlayers(room);
      return;
    }

    if (!room || !player) return;

    if (msg.t === "start") {
      if (player.id !== room.hostId) return;
      if (room.players.length < 2)
        return send(ws, { t: "error", msg: "二人以上そろってから始めてください" });
      startGame(room, { lock: !!msg.lock, size: msg.size });
      return;
    }

    if (msg.t === "ready") {
      if (room.phase !== "memorize") return;
      room.ready.add(player.id);
      broadcast(room, {
        t: "memoReady",
        ready: [...room.ready],
        total: room.players.filter((p) => p.ws && p.ws.readyState === 1).length,
      });
      checkMemoReady(room);
      return;
    }

    if (msg.t === "grab") return handleGrab(room, player, msg);

    // 部屋主が対戦を打ち切る
    if (msg.t === "abort") {
      if (player.id !== room.hostId) return;
      if (room.phase === "lobby") return;
      clearTimers(room);
      room.phase = "lobby";
      room.target = null;
      room.grabs = [];
      room.fouled = new Set();
      room.ready = new Set();
      broadcast(room, { t: "aborted", by: player.name });
      pushPlayers(room);
      return;
    }

    if (msg.t === "again") {
      if (player.id !== room.hostId) return;
      room.phase = "lobby";
      clearTimers(room);
      pushPlayers(room);
      return;
    }
  });

  ws.on("close", () => {
    if (!room || !player) return;
    room.players = room.players.filter((p) => p.id !== player.id);
    if (room.hostId === player.id) room.hostId = room.players.length ? room.players[0].id : null;

    if (room.players.length === 0) {
      clearTimers(room);
      rooms.delete(room.code);
      return;
    }
    pushPlayers(room);

    if (room.phase === "memorize") {
      room.ready.delete(player.id);
      broadcast(room, {
        t: "memoReady",
        ready: [...room.ready],
        total: room.players.filter((p) => p.ws && p.ws.readyState === 1).length,
      });
      checkMemoReady(room);
    }

    // 抜けた人を待たずに済むよう、進行中なら判定をやり直す
    if (room.phase === "round") {
      const live = room.players;
      const done = live.every((p) => room.fouled.has(p.id) || room.grabs.some((g) => g.playerId === p.id));
      if (done) settleRound(room);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.length === 0 && now - room.touched > ROOM_TTL_MS) {
      clearTimers(room);
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log("karuta server listening on " + PORT);
});
