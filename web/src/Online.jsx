import React, { useState, useEffect, useRef, useCallback } from "react";
import { C, MINCHO, GOTHIC, MONO, TICK, toSpoken, voiceScore, speakClue, useLayout, BOARD_CHOICES, BOARD_DEFAULT, memoSeconds, FEEDBACK_URL, openFeedback } from "./core.js";

/* ============================================================
   オンライン対戦
   速さは各端末が自分の時計で測り、経過ミリ秒をサーバーへ送る。
   通信の速い遅いが勝敗に影響しない仕組み。
   ============================================================ */

/* サーバーの住所
   .env に VITE_WS_URL があればそれを使う（公開したときはこちら）。
   無ければ、いま開いているページと同じ相手の8080番に繋ぐ。
   これでパソコンからでもスマホからでも、書き換えなしで繋がる。 */
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  (typeof window !== "undefined"
    ? (window.location.protocol === "https:" ? "wss://" : "ws://") +
      window.location.hostname +
      ":8080"
    : "ws://localhost:8080");

export default function Online({ onExit }) {
  const [ws, setWs] = useState(null);
  const [status, setStatus] = useState("入室前"); // 入室前 | 接続中 | 待合 | 暗記 | 対戦 | 結果 | 終了
  const [err, setErr] = useState("");

  const [room, setRoom] = useState("");
  const [name, setName] = useState("");
  const [meId, setMeId] = useState(null);
  const [hostId, setHostId] = useState(null);
  const [players, setPlayers] = useState([]);
  const [lock, setLock] = useState(false);
  const [size, setSize] = useState(BOARD_DEFAULT);

  const [board, setBoard] = useState([]);
  const [memo, setMemo] = useState(0);
  const [memoReady, setMemoReady] = useState([]);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [iReady, setIReady] = useState(false);
  const [round, setRound] = useState(null); // {roundId, clue, lockFrac}
  const [tick, setTick] = useState(0);
  const [sent, setSent] = useState(false);
  const [settling, setSettling] = useState(false);
  const [result, setResult] = useState(null);
  const [fouls, setFouls] = useState([]);
  const [over, setOver] = useState(null);

  const [voiceOn, setVoiceOn] = useState(true);
  const [voiceList, setVoiceList] = useState([]);
  const [voiceIdx, setVoiceIdx] = useState(0);
  const [rate, setRate] = useState(1.0);
  const [pitch, setPitch] = useState(1.06);
  const voices = useRef([]);
  const t0 = useRef(0);
  const sock = useRef(null);
  const L = useLayout();
  const wide = L.wide;

  const me = players.find((p) => p.id === meId);
  const isHost = meId && meId === hostId;

  /* ---------- 読み上げ ---------- */

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => {
      voices.current = window.speechSynthesis
        .getVoices()
        .filter((v) => /^ja/i.test(v.lang || ""))
        .sort((a, b) => voiceScore(a) - voiceScore(b));
      setVoiceList(voices.current);
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }, []);

  const utter = useCallback(
    (text, idx) => {
      if (!window.speechSynthesis) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(toSpoken(text));
        u.lang = "ja-JP";
        u.rate = rate;
        u.pitch = pitch;
        const v = voices.current[idx != null ? idx : voiceIdx];
        if (v) u.voice = v;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    },
    [rate, pitch, voiceIdx]
  );

  const stopper = useRef(null);

  const speak = useCallback(
    (text) => {
      if (stopper.current) stopper.current();
      if (!voiceOn) return;
      stopper.current = speakClue(text, { rate, pitch, voice: voices.current[voiceIdx] });
    },
    [voiceOn, rate, pitch, voiceIdx]
  );

  /* ---------- 接続 ---------- */

  const connect = () => {
    if (!room.trim()) return setErr("部屋番号を入れてください");
    if (room.trim().length < 3) return setErr("部屋番号は3桁以上で入れてください");
    setErr("");
    setStatus("接続中");

    const s = new WebSocket(WS_URL);
    sock.current = s;

    s.onopen = () => s.send(JSON.stringify({ t: "join", room: room.trim(), name: name.trim() }));

    s.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }

      if (m.t === "error") {
        setErr(m.msg);
        if (status === "接続中") setStatus("入室前");
        return;
      }
      if (m.t === "joined") {
        setMeId(m.you);
        setHostId(m.host);
        setStatus("待合");
        return;
      }
      if (m.t === "players") {
        setPlayers(m.players);
        setHostId(m.host);
        if (m.phase === "lobby") setStatus("待合");
        return;
      }
      if (m.t === "memorize") {
        setBoard(m.board);
        setPlayers(m.players);
        setMemo(m.seconds);
        setMemoReady([]);
        setIReady(false);
        setResult(null);
        setOver(null);
        setStatus("暗記");
        return;
      }
      if (m.t === "aborted") {
        setRound(null);
        setResult(null);
        setBoard([]);
        setFouls([]);
        setSettling(false);
        setConfirmQuit(false);
        setStatus("待合");
        try {
          window.speechSynthesis && window.speechSynthesis.cancel();
        } catch (e) {}
        return;
      }
      if (m.t === "memoReady") {
        setMemoReady(m.ready || []);
        return;
      }
      if (m.t === "round") {
        setRound({ roundId: m.roundId, clue: m.clue, lockFrac: m.lockFrac || 0 });
        setPlayers(m.players);
        setTick(0);
        setSent(false);
        setSettling(false);
        setResult(null);
        setFouls([]);
        setStatus("対戦");
        t0.current = performance.now();
        speak(m.clue);
        return;
      }
      if (m.t === "settling") {
        setSettling(true);
        return;
      }
      if (m.t === "foul") {
        setFouls((f) => [...f, { playerId: m.playerId, cardId: m.cardId }]);
        setPlayers(m.players);
        return;
      }
      if (m.t === "result") {
        setResult(m);
        setPlayers(m.players);
        setSettling(false);
        setBoard((b) => b.filter((c) => c.id !== m.card.id));
        setStatus("結果");
        try {
          window.speechSynthesis && window.speechSynthesis.cancel();
        } catch (e) {}
        return;
      }
      if (m.t === "over") {
        setOver(m);
        setPlayers(m.players);
        setStatus("終了");
        return;
      }
    };

    s.onclose = () => {
      setWs(null);
      sock.current = null;
      if (status !== "入室前") setErr("接続が切れました");
      setStatus("入室前");
    };
    s.onerror = () => setErr("接続できませんでした（" + WS_URL + "）。サーバーが動いているか確認してください。");

    setWs(s);
  };

  useEffect(() => () => sock.current && sock.current.close(), []);

  /* ---------- 各種の時計 ---------- */

  useEffect(() => {
    if (status !== "暗記" || memo <= 0) return;
    const t = setTimeout(() => setMemo((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [status, memo]);

  useEffect(() => {
    if (status !== "対戦" || !round) return;
    const iv = setInterval(() => setTick((t) => t + 1), TICK);
    return () => clearInterval(iv);
  }, [status, round]);

  /* ---------- 操作 ---------- */

  const startGame = () => sock.current && sock.current.send(JSON.stringify({ t: "start", lock, size }));
  const abort = () => {
    if (!confirmQuit) {
      setConfirmQuit(true);
      setTimeout(() => setConfirmQuit(false), 4000);
      return;
    }
    setConfirmQuit(false);
    if (isHost) {
      sock.current && sock.current.send(JSON.stringify({ t: "abort" }));
    } else {
      if (sock.current) sock.current.close();
      onExit();
    }
  };

  const sayReady = () => {
    if (iReady) return;
    setIReady(true);
    sock.current && sock.current.send(JSON.stringify({ t: "ready" }));
  };
  const again = () => sock.current && sock.current.send(JSON.stringify({ t: "again" }));

  const grab = (card) => {
    if (status !== "対戦" || sent || !round) return;
    const lockTicks = Math.ceil(round.clue.length * round.lockFrac);
    if (tick < lockTicks) return;
    const elapsed = performance.now() - t0.current;
    setSent(true);
    sock.current.send(JSON.stringify({ t: "grab", roundId: round.roundId, cardId: card.id, elapsed }));
  };

  /* ---------- 画面 ---------- */

  if (status === "入室前" || status === "接続中") {
    return (
      <Shell L={L} narrow>
        <div style={{ paddingTop: 44 }}>
          <div style={eyebrow}>オンライン対戦</div>
          <h1 style={{ fontFamily: MINCHO, color: C.text, fontSize: 34, letterSpacing: "0.2em", margin: "16px 0 6px" }}>
            部屋に入る
          </h1>
          <div style={{ height: 1, background: C.shu, width: 56, marginBottom: 28 }} />

          <Label>部屋番号</Label>
          <div className="flex" style={{ gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <Input value={room} onChange={setRoom} placeholder="1234" mono max={6} numeric />
            </div>
            <button
              onClick={() => setRoom(String(Math.floor(1000 + Math.random() * 9000)))}
              style={{
                padding: "13px 14px",
                background: C.card,
                color: C.mute,
                border: "1px solid " + C.rule,
                borderRadius: 2,
                fontFamily: GOTHIC,
                fontSize: 12.5,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              番号を作る
            </button>
          </div>
          <div style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute, lineHeight: 1.7, marginTop: -8, marginBottom: 16 }}>
            数字4桁が目安。同じ番号を入れた人どうしで対戦します。
          </div>
          <Label>名前</Label>
          <Input value={name} onChange={setName} placeholder="ゲスト" max={8} />

          <Label>読み上げ</Label>
          <div className="grid grid-cols-2 gap-2" style={{ marginBottom: 16 }}>
            <button onClick={() => setVoiceOn(true)} style={choice(voiceOn)}>
              音声あり
            </button>
            <button onClick={() => setVoiceOn(false)} style={choice(!voiceOn)}>
              文字だけ
            </button>
          </div>

          {voiceOn && voiceList.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute, marginBottom: 8 }}>
                読み手（触れると試し読み）
              </div>
              <div className="flex" style={{ gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                {voiceList.slice(0, 6).map((v, i) => (
                  <button
                    key={v.name + i}
                    onClick={() => {
                      setVoiceIdx(i);
                      utter("桶狭間で今川義元を討った武将", i);
                    }}
                    style={{ ...choice(voiceIdx === i), padding: "9px 11px", fontSize: 11.5 }}
                  >
                    {(v.name || "読み手").replace(/^Microsoft\s+/, "").replace(/\s*-\s*Japanese.*$/, "").slice(0, 18)}
                  </button>
                ))}
              </div>

              <Slider label="速さ" value={rate} min={0.7} max={1.4} onChange={setRate} />
              <Slider label="高さ" value={pitch} min={0.8} max={1.4} onChange={setPitch} />

              <button
                onClick={() => utter("関ヶ原に勝ち、江戸に幕府を開いた人物")}
                style={{ ...choice(false), width: "100%", marginTop: 4, fontSize: 12 }}
              >
                今の設定で試し読み
              </button>
            </div>
          )}

          {err && <Warn>{err}</Warn>}

          <button onClick={connect} disabled={status === "接続中"} style={{ ...big(), marginTop: 20 }}>
            {status === "接続中" ? "接続中…" : "入室"}
          </button>
          <button onClick={onExit} style={ghost()}>
            戻る
          </button>

          <p style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute, lineHeight: 1.8, marginTop: 24, opacity: 0.8 }}>
            2〜4人で遊べます。速さは各端末で測るので、回線の速い遅いは勝敗に影響しません。
          </p>
        </div>
      </Shell>
    );
  }

  if (status === "待合") {
    return (
      <Shell L={L} narrow>
        <div style={{ paddingTop: L.tier === "lg" ? 26 : 40, paddingBottom: 30 }}>
          <div style={eyebrow}>待合 · {room}</div>
          <h2 style={{ fontFamily: MINCHO, color: C.text, fontSize: 28, margin: "14px 0 20px", letterSpacing: "0.12em" }}>
            {players.length}人
          </h2>

          {players.map((p) => (
            <div
              key={p.id}
              className="flex"
              style={{ justifyContent: "space-between", padding: "13px 0", borderBottom: "1px solid " + C.panelEdge }}
            >
              <span style={{ fontFamily: MINCHO, fontSize: 17, color: p.id === meId ? C.kin : C.text }}>
                {p.name}
                {p.id === hostId && <span style={{ fontFamily: MONO, fontSize: 10, color: C.mute }}> 主</span>}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.mute }}>{p.id === meId ? "あなた" : ""}</span>
            </div>
          ))}

          {isHost ? (
            <>
              <div style={{ marginTop: 24 }}>
                <Label>札の枚数</Label>
                <div className="grid grid-cols-4 gap-2" style={{ marginBottom: 8 }}>
                  {BOARD_CHOICES.map((n) => (
                    <button key={n} onClick={() => setSize(n)} style={choice(size === n)}>
                      {n}枚
                    </button>
                  ))}
                </div>
                <div style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute, lineHeight: 1.7, marginBottom: 18 }}>
                  暗記は{memoSeconds(size)}秒。スマホで遊ぶ人がいる場合は18枚までが目安です。
                </div>

                <Label>取りはじめ</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setLock(true)} style={choice(lock)}>
                    半分まで待つ
                  </button>
                  <button onClick={() => setLock(false)} style={choice(!lock)}>
                    いつでも
                  </button>
                </div>
              </div>
              <button onClick={startGame} style={{ ...big(), marginTop: 20 }}>
                はじめる
              </button>
            </>
          ) : (
            <p style={{ fontFamily: GOTHIC, fontSize: 13, color: C.mute, marginTop: 24 }}>
              部屋主が始めるのを待っています。
            </p>
          )}
          {err && <Warn>{err}</Warn>}

          <button
            onClick={() => {
              if (sock.current) sock.current.close();
              onExit();
            }}
            style={ghost()}
          >
            部屋を出る
          </button>
        </div>
      </Shell>
    );
  }

  if (status === "暗記") {
    return (
      <Shell L={L}>
        <div style={{ paddingTop: 30 }}>
          <div className="flex" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <span style={eyebrow}>暗記</span>
            <div className="flex" style={{ gap: 14, alignItems: "baseline" }}>
              <QuitButton onClick={abort} confirm={confirmQuit} host={isHost} />
              <span style={{ fontFamily: MONO, fontSize: 26, color: memo <= 5 ? C.shu : C.kin }}>{memo}</span>
            </div>
          </div>
          <p style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.mute, lineHeight: 1.8, margin: "0 0 14px" }}>
            札の位置を覚えてください。全員に同じ並びが配られています。全員が「覚えた」を押せば、時間を待たずに始まります。
          </p>

          <div className="flex" style={{ gap: 6, marginBottom: 14 }}>
            {players.map((p) => {
              const done = memoReady.includes(p.id);
              return (
                <div
                  key={p.id}
                  style={{
                    flex: 1,
                    textAlign: "center",
                    padding: "8px 2px",
                    border: "1px solid " + (done ? C.kin : C.panelEdge),
                    opacity: done ? 1 : 0.55,
                  }}
                >
                  <div style={{ fontFamily: MINCHO, fontSize: L.name, color: p.id === meId ? C.kin : C.text }}>{p.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: done ? C.kin : C.mute, marginTop: 3 }}>
                    {done ? "覚えた" : "暗記中"}
                  </div>
                </div>
              );
            })}
          </div>

          <Grid board={board} L={L} />

          <div style={{ paddingTop: 16, paddingBottom: 28 }}>
            <button
              onClick={sayReady}
              disabled={iReady}
              style={{
                ...big(),
                background: iReady ? "transparent" : C.shu,
                border: iReady ? "1px solid " + C.panelEdge : "none",
                color: iReady ? C.mute : C.onDark,
                cursor: iReady ? "default" : "pointer",
              }}
            >
              {iReady ? "他の人を待っています　" + memoReady.length + "/" + players.length : "覚えた"}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  /* 対戦・結果 */

  const shown = round ? round.clue.slice(0, tick) : "";
  const lockTicks = round ? Math.ceil(round.clue.length * round.lockFrac) : 0;
  const held = status === "対戦" && tick < lockTicks;
  const myFoul = fouls.some((f) => f.playerId === meId);

  if (status === "終了" && over) {
    const rows = [...over.players].sort((a, b) => b.score - a.score || a.foul - b.foul);
    return (
      <Shell L={L} narrow>
        <div style={{ paddingTop: 36, paddingBottom: 44 }}>
          <div className="flex" style={{ gap: 14, alignItems: "center", marginBottom: 4 }}>
            <div
              style={{
                width: 46,
                height: 46,
                background: C.shu,
                color: C.onDark,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: MINCHO,
                fontSize: 21,
                fontWeight: 700,
                borderRadius: 2,
                boxShadow: C.shadow,
                flexShrink: 0,
              }}
            >
              札
            </div>
            <div>
              <div style={eyebrow}>結果 · {room}</div>
              <h2
                style={{
                  fontFamily: MINCHO,
                  color: C.text,
                  fontSize: L.wide ? 30 : 26,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  margin: "6px 0 0",
                }}
              >
                {rows[0].name} の勝ち
              </h2>
            </div>
          </div>
          <div style={{ height: 2, background: C.shu, width: 78, margin: "18px 0 4px" }} />
          <div style={{ height: 1, background: C.rule, marginBottom: 18 }} />

          <div
            style={{
              background: C.panel,
              border: "1px solid " + C.rule,
              borderRadius: 2,
              boxShadow: C.shadow,
              overflow: "hidden",
            }}
          >
            {rows.map((p, i) => (
              <div
                key={p.id}
                className="flex"
                style={{
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "15px 16px",
                  borderBottom: i === rows.length - 1 ? "none" : "1px solid " + C.rule,
                  borderLeft: "4px solid " + (i === 0 ? C.shu : "transparent"),
                  background: p.id === meId ? "rgba(178,58,46,0.05)" : "transparent",
                }}
              >
                <div className="flex" style={{ gap: 14, alignItems: "baseline" }}>
                  <span
                    style={{ fontFamily: MINCHO, fontSize: 15, fontWeight: 700, color: i === 0 ? C.shu : C.mute, width: 20 }}
                  >
                    {["一", "二", "三", "四"][i]}
                  </span>
                  <span
                    style={{
                      fontFamily: MINCHO,
                      fontSize: L.wide ? 20 : 18,
                      fontWeight: 700,
                      color: C.text,
                      letterSpacing: "0.1em",
                    }}
                  >
                    {p.name}
                    {p.id === meId && (
                      <span style={{ fontFamily: GOTHIC, fontSize: 11, color: C.shu, marginLeft: 8 }}>あなた</span>
                    )}
                  </span>
                </div>
                <div className="flex" style={{ gap: 10, alignItems: "baseline" }}>
                  <span style={{ fontFamily: MONO, fontSize: L.wide ? 22 : 19, color: C.text }}>{p.score}</span>
                  <span style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute }}>枚</span>
                  {p.foul > 0 && <span style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.shu }}>お手つき{p.foul}</span>}
                </div>
              </div>
            ))}
          </div>

          {over.log && over.log.length > 0 && (
            <>
              <div className="flex" style={{ alignItems: "center", gap: 12, margin: "30px 0 12px" }}>
                <span style={{ fontFamily: MINCHO, fontSize: 16, fontWeight: 700, color: C.text, letterSpacing: "0.14em" }}>
                  今回の札
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: C.mute }}>{over.log.length}</span>
                <div style={{ flex: 1, height: 1, background: C.rule }} />
              </div>
              {over.log
                .filter((e) => e.winner !== meId)
                .map((e, i) => (
                  <div
                    key={i}
                    style={{
                      background: C.card,
                      border: "1px solid " + C.cardEdge,
                      borderLeft: "3px solid " + C.rule,
                      borderRadius: 2,
                      boxShadow: C.shadow,
                      padding: "13px 15px",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontFamily: MINCHO, color: C.ink, fontSize: 17, fontWeight: 700, letterSpacing: "0.08em" }}>
                      {e.a}
                    </div>
                    <div style={{ fontFamily: GOTHIC, color: C.mute, fontSize: 12.5, marginTop: 6, lineHeight: 1.75 }}>
                      {e.c}
                    </div>
                    <div style={{ fontFamily: GOTHIC, color: C.kin, fontSize: 12, marginTop: 5 }}>{e.n}</div>
                  </div>
                ))}
            </>
          )}

          {isHost && (
            <button
              onClick={again}
              style={{
                width: "100%",
                marginTop: 26,
                padding: L.wide ? "20px 0" : "18px 0",
                background: C.shu,
                color: C.onDark,
                border: "none",
                borderRadius: 2,
                boxShadow: C.shadowUp,
                fontFamily: MINCHO,
                fontSize: L.wide ? 21 : 19,
                fontWeight: 700,
                letterSpacing: "0.34em",
                textIndent: "0.34em",
                cursor: "pointer",
              }}
            >
              待合に戻る
            </button>
          )}
          <button
            onClick={onExit}
            style={{
              width: "100%",
              marginTop: 10,
              padding: "13px 0",
              background: "transparent",
              color: C.mute,
              border: "1px solid " + C.rule,
              borderRadius: 2,
              fontFamily: GOTHIC,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            やめる
          </button>
          {FEEDBACK_URL && (
            <button onClick={openFeedback} style={{ ...ghost(), marginTop: 6, textDecoration: "underline" }}>
              感想を送る
            </button>
          )}
        </div>
      </Shell>
    );
  }

  return (
    <Shell L={L}>
      <div className="flex" style={{ justifyContent: "space-between", alignItems: "center", padding: "14px 0 10px" }}>
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.mute, letterSpacing: "0.14em" }}>残り {board.length}</span>
        <div className="flex" style={{ gap: 14, alignItems: "center" }}>
          <QuitButton onClick={abort} confirm={confirmQuit} host={isHost} />
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.mute }}>{room}</span>
        </div>
      </div>

      {/* 読み札 */}
      <div
        style={{
          background: C.panel,
          borderRadius: 2,
          boxShadow: C.shadow,
          border: "1px solid " + (result ? C.kin : C.panelEdge),
          borderLeft: "3px solid " + C.shu,
          height: L.clueH,
          padding: "14px 12px",
          display: "flex",
          justifyContent: "flex-end",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            writingMode: "vertical-rl",
            fontFamily: MINCHO,
            fontSize: L.clue,
            fontWeight: 600,
            lineHeight: 1.8,
            color: C.text,
            letterSpacing: "0.1em",
            height: "100%",
          }}
        >
          {result ? result.card.c : shown}
        </div>
      </div>

      {/* 場の様子 */}
      <div style={{ minHeight: 56, display: "flex", flexDirection: "column", justifyContent: "center", padding: "7px 0" }}>
        {result ? (
          <>
            <span style={{ fontFamily: MINCHO, fontSize: 15.5, color: result.winner ? C.kin : C.mute, letterSpacing: "0.12em" }}>
              {result.winner
                ? nameOf(players, result.winner.playerId) +
                  " が取った — " +
                  result.card.a +
                  "（" +
                  (result.winner.elapsed / 1000).toFixed(2) +
                  "秒）"
                : "だれも取れず — " + result.card.a}
            </span>
            <span style={{ fontFamily: GOTHIC, fontSize: 12, color: C.mute, marginTop: 5 }}>{result.card.n}</span>
          </>
        ) : settling ? (
          <span style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.kin }}>だれかが取りました — 判定中</span>
        ) : myFoul ? (
          <span style={{ fontFamily: GOTHIC, fontSize: 13, color: C.shu }}>お手つき — この札は取れません</span>
        ) : sent ? (
          <span style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.mute }}>申告しました — 他の人を待っています</span>
        ) : held ? (
          <span style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.kin }}>半分まで聞いてから — あと{lockTicks - tick}字</span>
        ) : (
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.mute, letterSpacing: "0.2em", opacity: 0.55 }}>READING</span>
        )}
      </div>

      {/* 点数 */}
      <div className="flex" style={{ gap: 6, marginBottom: 12 }}>
        {players.map((p) => {
          const dead = fouls.some((f) => f.playerId === p.id);
          const won = result && result.winner && result.winner.playerId === p.id;
          return (
            <div
              key={p.id}
              style={{
                flex: 1,
                textAlign: "center",
                padding: "9px 2px",
                background: won ? C.shu : "transparent",
                border: "1px solid " + (dead ? "transparent" : C.panelEdge),
                opacity: dead ? 0.32 : 1,
              }}
            >
              <div style={{ fontFamily: MINCHO, fontSize: L.name, color: p.id === meId ? C.kin : C.text }}>{p.name}</div>
              <div style={{ fontFamily: MONO, fontSize: L.score, color: C.text, marginTop: 3 }}>{p.score}</div>
            </div>
          );
        })}
      </div>

      <Grid
        board={board}
        L={L}
        onPick={grab}
        disabled={status !== "対戦" || sent || held || myFoul}
        hit={result && result.winner ? result.card.id : null}
      />
      <div style={{ height: 28 }} />
    </Shell>
  );
}

/* ---------------- 部品 ---------------- */

function QuitButton({ onClick, confirm, host }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "none",
        border: confirm ? "1px solid " + C.shu : "none",
        padding: confirm ? "5px 9px" : "5px 0",
        color: confirm ? C.shu : C.mute,
        fontFamily: GOTHIC,
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {confirm ? (host ? "もう一度押すと中断" : "もう一度押すと退出") : host ? "中断" : "退出"}
    </button>
  );
}

function nameOf(players, id) {
  const p = players.find((x) => x.id === id);
  return p ? p.name : "だれか";
}

function Grid({ board, onPick, disabled, hit, L }) {
  const size = L || { cols: 3, card: 14, cardH: 62 };
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(" + size.cols + ", minmax(0, 1fr))" }}>
      {board.map((c) => {
        const isHit = hit && c.id === hit;
        return (
          <button
            key={c.id}
            onClick={() => onPick && onPick(c)}
            disabled={disabled || !onPick}
            style={{
              background: isHit ? C.shu : C.card,
              color: isHit ? C.onDark : C.ink,
              border: "1px solid " + (isHit ? "#8C2C22" : C.cardEdge),
              borderRadius: 2,
              boxShadow: isHit ? C.shadowUp : C.shadow,
              padding: "16px 4px",
              fontFamily: MINCHO,
              fontSize: size.card,
              fontWeight: 700,
              lineHeight: 1.35,
              minHeight: size.cardH,
              opacity: disabled && !isHit ? 0.45 : 1,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            {c.a}
          </button>
        );
      })}
    </div>
  );
}

/* 全角の数字を半角に直し、数字以外は捨てる */
function toHankakuDigits(v) {
  return v
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, "");
}

function Input({ value, onChange, placeholder, mono, max, numeric }) {
  return (
    <input
      value={value}
      inputMode={numeric ? "numeric" : undefined}
      autoComplete="off"
      onChange={(e) => {
        const v = numeric ? toHankakuDigits(e.target.value) : e.target.value;
        onChange(v.slice(0, max || 12));
      }}
      placeholder={placeholder}
      style={{
        width: "100%",
        padding: "13px 12px",
        background: C.panel,
        border: "1px solid " + C.panelEdge,
        color: C.text,
        fontFamily: mono ? MONO : GOTHIC,
        fontSize: 16,
        letterSpacing: mono ? "0.14em" : "0.02em",
        marginBottom: 16,
        boxSizing: "border-box",
      }}
    />
  );
}

function Slider({ label, value, min, max, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="flex" style={{ justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute }}>{label}</span>
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.kin }}>{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.02}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: C.shu }}
      />
    </div>
  );
}

function Warn({ children }) {
  return (
    <div style={{ marginTop: 14, padding: "12px", background: C.panel, borderLeft: "3px solid " + C.shu }}>
      <span style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.text }}>{children}</span>
    </div>
  );
}

const eyebrow = { fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.26em", color: C.mute };

function Label({ children }) {
  return <div style={{ fontFamily: GOTHIC, fontSize: 12, color: C.mute, letterSpacing: "0.16em", marginBottom: 8 }}>{children}</div>;
}

function choice(on) {
  return {
    padding: "13px 4px",
    background: on ? C.panel : "transparent",
    color: on ? C.text : C.mute,
    border: "1px solid " + (on ? C.shu : C.panelEdge),
    fontFamily: GOTHIC,
    fontSize: 13,
    cursor: "pointer",
  };
}

function big() {
  return {
    width: "100%",
    padding: "17px 0",
    background: C.shu,
    color: C.onDark,
    border: "none",
    fontFamily: MINCHO,
    fontSize: 18,
    letterSpacing: "0.3em",
    cursor: "pointer",
  };
}

function ghost() {
  return {
    width: "100%",
    marginTop: 10,
    padding: "14px 0",
    background: "transparent",
    color: C.mute,
    border: "none",
    fontFamily: GOTHIC,
    fontSize: 13,
    cursor: "pointer",
  };
}

function Shell({ children, L, narrow }) {
  const w = L ? (narrow ? L.narrow : L.max) : narrow ? 520 : 460;
  return (
    <div style={{ background: C.ground, minHeight: "100vh", width: "100%" }}>
      <div style={{ maxWidth: w, margin: "0 auto", padding: "0 18px" }}>{children}</div>
    </div>
  );
}
