import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  DECKS, RANKS, PACE, C, MINCHO, GOTHIC, MONO,
  TICK, voiceScore, toSpoken, drawBoard, speakClue, useLayout, BOARD_CHOICES, BOARD_DEFAULT, memoSeconds,
  FEEDBACK_URL, openFeedback,
} from "./core.js";

/* ============================================================
   1台で複数人 — 各自が自分の側の帯を叩いてから札を選ぶ
   ============================================================ */

const SEATS = [
  { id: "p1", name: "甲", color: "#C8352A", side: "bottom" },
  { id: "p2", name: "乙", color: "#C9A227", side: "bottom" },
  { id: "p3", name: "丙", color: "#4A7FB5", side: "top" },
  { id: "p4", name: "丁", color: "#4E9E7E", side: "top" },
];

const PICK_MS = 3000;

export default function Offline({ onExit }) {
  const [screen, setScreen] = useState("setup");
  const [mode, setMode] = useState("solo"); // solo | local
  const [heads, setHeads] = useState(4);
  const [size, setSize] = useState(BOARD_DEFAULT);
  const [pace, setPace] = useState("futsuu");
  const [voiceOn, setVoiceOn] = useState(true);
  const [voices, setVoices] = useState([]);
  const [voiceIdx, setVoiceIdx] = useState(0);

  const [board, setBoard] = useState([]);
  const [target, setTarget] = useState(null);
  const [tick, setTick] = useState(0);
  const [phase, setPhase] = useState("reading"); // reading | picking | resolved
  const [taker, setTaker] = useState(null);
  const [wrongPick, setWrongPick] = useState(null);
  const [out, setOut] = useState([]);
  const [score, setScore] = useState({});
  const [foul, setFoul] = useState({});
  const [log, setLog] = useState([]);
  const [memo, setMemo] = useState(0);
  const [picker, setPicker] = useState(null);
  const [pickLeft, setPickLeft] = useState(0);

  const plans = useRef([]);
  const resolved = useRef(false);
  const reduce = useRef(false);
  const L = useLayout();
  const wide = L.wide;

  const rivals = useMemo(
    () => PACE[pace].ranks.map((n, i) => ({ id: "r" + (i + 1), ...RANKS[n] })),
    [pace]
  );

  const players = useMemo(() => {
    if (mode === "local") return SEATS.slice(0, heads);
    return [
      { id: "you", name: "あなた", color: C.kin, human: true },
      ...rivals.map((r) => ({ id: r.id, name: r.name, color: C.mute })),
    ];
  }, [mode, heads, rivals]);

  const blank = useCallback(() => {
    const o = {};
    players.forEach((p) => (o[p.id] = 0));
    return o;
  }, [players]);

  useEffect(() => {
    try {
      reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      reduce.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => {
      try {
        const ja = window.speechSynthesis
          .getVoices()
          .filter((v) => /^ja/i.test(v.lang || ""))
          .sort((a, b) => voiceScore(a) - voiceScore(b));
        setVoices(ja);
      } catch (e) {
        setVoices([]);
      }
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const utter = useCallback(
    (text, idx) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(toSpoken(text));
        u.lang = "ja-JP";
        u.rate = 1.0;
        u.pitch = 1.06;
        u.volume = 1;
        const v = voices[idx != null ? idx : voiceIdx];
        if (v) u.voice = v;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    },
    [voices, voiceIdx]
  );

  const stopper = useRef(null);

  const speak = useCallback(
    (text) => {
      if (stopper.current) stopper.current();
      if (!voiceOn) return;
      stopper.current = speakClue(text, { voice: voices[voiceIdx] });
    },
    [voiceOn, voices, voiceIdx]
  );

  const hush = () => {
    if (stopper.current) stopper.current();
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {}
  };

  const openRound = useCallback(
    (cards) => {
      if (cards.length === 0) {
        setTarget(null);
        setTaker(null);
        setPicker(null);
        setPhase("reading");
        setScreen("result");
        return;
      }
      const t = cards[Math.floor(Math.random() * cards.length)];
      const len = t.c.length;
      const floor = PACE[pace].floor || 0;

      plans.current =
        mode === "solo"
          ? rivals.map((r, idx) => {
              const knows = Math.random() < r.know[t.l - 1];
              const [lo, hi] = r.span;
              const frac = Math.max(lo + Math.random() * (hi - lo), floor);
              const decoy = cards.filter((c) => c.id !== t.id);
              if (knows || decoy.length === 0) {
                return { id: r.id, name: r.name, at: Math.max(3, Math.round(frac * len)), hit: true };
              }
              return {
                id: r.id,
                name: r.name,
                at: len + 8 + idx * 7 + Math.round(Math.random() * 22),
                hit: false,
                card: decoy[Math.floor(Math.random() * decoy.length)],
              };
            })
          : [];

      resolved.current = false;
      setTarget(t);
      setTick(0);
      setPhase("reading");
      setTaker(null);
      setWrongPick(null);
      setOut([]);
      setPicker(null);
      speak(t.c);
    },
    [rivals, speak, pace, mode]
  );

  const closeRound = useCallback(
    (who, ok) => {
      resolved.current = true;
      hush();
      setPhase("resolved");
      setPicker(null);
      setTaker({ who, ok });
      if (target) setTick(target.c.length);
      setLog((L) => [...L, { card: target, who: ok ? who : null }]);
    },
    [target]
  );

  // 読み上げの進行（札を選んでいる間は止まる）
  useEffect(() => {
    if (screen !== "play" || phase !== "reading" || !target) return;
    const iv = setInterval(() => setTick((t) => t + 1), TICK);
    return () => clearInterval(iv);
  }, [screen, phase, target]);

  // 相手の判断（ひとり用のみ）
  useEffect(() => {
    if (mode !== "solo" || screen !== "play" || phase !== "reading" || !target || resolved.current) return;

    for (const p of plans.current) {
      if (out.includes(p.id) || tick < p.at) continue;
      if (p.hit) {
        setScore((s) => ({ ...s, [p.id]: s[p.id] + 1 }));
        closeRound(p.name, true);
        return;
      }
      const next = [...out, p.id];
      setFoul((f) => ({ ...f, [p.id]: f[p.id] + 1 }));
      setOut(next);
      setWrongPick({ who: p.name, card: p.card.a });
      if (next.length >= players.length) closeRound(null, false);
      return;
    }
  }, [tick, screen, phase, target, out, closeRound, mode, players.length]);

  // 札を選ぶ持ち時間
  useEffect(() => {
    if (phase !== "picking") return;
    if (pickLeft <= 0) {
      if (picker) commitFoul(picker, "時間切れ");
      return;
    }
    const t = setTimeout(() => setPickLeft((v) => v - 100), 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [phase, pickLeft, picker]);

  // 決着後の間（対戦中のみ。終局後に動き続けないようにする）
  useEffect(() => {
    if (screen !== "play" || phase !== "resolved" || !target) return;
    const t = setTimeout(() => {
      const rest = board.filter((c) => c.id !== target.id);
      setBoard(rest);
      openRound(rest);
    }, 3000);
    return () => clearTimeout(t);
  }, [screen, phase, target, board, openRound]);

  const beginPlay = useCallback(() => {
    setScreen("play");
    setTimeout(() => openRound(board), 350);
  }, [board, openRound]);

  useEffect(() => {
    if (screen !== "memorize") return;
    if (memo <= 0) {
      beginPlay();
      return;
    }
    const t = setTimeout(() => setMemo((m) => m - 1), 1000);
    return () => clearTimeout(t);
  }, [screen, memo, beginPlay]);

  const start = () => {
    const b = drawBoard(DECKS.nihonshi.cards, size);
    setBoard(b);
    setScore(blank());
    setFoul(blank());
    setLog([]);
    setTarget(null);
    setTaker(null);
    setWrongPick(null);
    setOut([]);
    setPicker(null);
    setMemo(memoSeconds(size));
    setScreen("memorize");
  };

  const lockTicks = target ? Math.ceil(target.c.length * (PACE[pace].lock || 0)) : 0;
  const held = phase === "reading" && tick < lockTicks;

  function commitFoul(p, cardName) {
    const next = out.includes(p.id) ? out : [...out, p.id];
    setFoul((f) => ({ ...f, [p.id]: (f[p.id] || 0) + 1 }));
    setOut(next);
    setWrongPick({ who: p.name, card: cardName });
    setPicker(null);
    if (next.length >= players.length) {
      closeRound(null, false);
    } else {
      setPhase("reading");
    }
  }

  // 帯を叩く（1台対戦）
  const buzz = (p) => {
    if (mode !== "local" || phase !== "reading" || out.includes(p.id) || held) return;
    setPicker(p);
    setPickLeft(PICK_MS);
    setPhase("picking");
  };

  const grab = (card) => {
    if (!target) return;

    if (mode === "local") {
      if (phase !== "picking" || !picker) return;
      if (card.id === target.id) {
        setScore((s) => ({ ...s, [picker.id]: s[picker.id] + 1 }));
        closeRound(picker.name, true);
      } else {
        commitFoul(picker, card.a);
      }
      return;
    }

    if (phase !== "reading" || out.includes("you") || held) return;
    if (card.id === target.id) {
      setScore((s) => ({ ...s, you: s.you + 1 }));
      closeRound("あなた", true);
    } else {
      commitFoul({ id: "you", name: "あなた" }, card.a);
    }
  };

  const quit = () => {
    hush();
    setTarget(null);
    setPhase("reading");
    setScreen("result");
  };

  /* ---------------- 支度 ---------------- */

  if (screen === "setup") {
    const two = L.tier === "lg"; // パソコン幅のときだけ二段組にする
    return (
      <Shell L={L} narrow cap={two ? 920 : undefined}>
        <div style={{ paddingTop: two ? 22 : 36, paddingBottom: two ? 24 : 44 }}>
          {/* 表題 */}
          <div className="flex" style={{ gap: 14, alignItems: "center", marginBottom: 6 }}>
            <Seal size={L.wide ? 54 : 46} />
            <div>
              <h1
                style={{
                  fontFamily: MINCHO,
                  color: C.text,
                  fontSize: L.title * 0.7,
                  letterSpacing: "0.16em",
                  fontWeight: 700,
                  margin: 0,
                  lineHeight: 1.2,
                }}
              >
                日本史かるた
              </h1>
              <div style={{ ...eyebrow, marginTop: 6 }}>
                {mode === "solo" ? "ひとり用 · 相手は三人" : "1台で" + heads + "人"}
              </div>
            </div>
          </div>
          <div style={{ height: 2, background: C.shu, width: 78, margin: (two ? 12 : 18) + "px 0 4px" }} />
          <div style={{ height: 1, background: C.rule, marginBottom: 6 }} />

          {/* 設定 */}
          <div
            style={{
              background: C.panel,
              border: "1px solid " + C.rule,
              borderRadius: 2,
              boxShadow: C.shadow,
              padding: two ? "2px 22px" : "4px 18px",
              marginTop: two ? 12 : 16,
              display: two ? "grid" : "block",
              gridTemplateColumns: two ? "1fr 1fr" : undefined,
              columnGap: two ? 30 : undefined,
            }}
          >
            <Field
              tight={two}
              label="遊び方"
              hint={
                mode === "local"
                  ? "端末を囲んで座り、自分の側の帯を叩いてから3秒以内に札を選びます。上側の二人には、叩いた瞬間に札の向きが反転します。"
                  : "読み札が読み終わる前に、当てはまる人物か合戦の札を取ります。誤って取ればお手つきで、その札は取れません。"
              }
            >
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setMode("solo")} style={choice(mode === "solo")}>
                  ひとりで
                </button>
                <button onClick={() => setMode("local")} style={choice(mode === "local")}>
                  1台で対戦
                </button>
              </div>
              {mode === "local" && (
                <div className="grid grid-cols-3 gap-2" style={{ marginTop: 8 }}>
                  {[2, 3, 4].map((n) => (
                    <button key={n} onClick={() => setHeads(n)} style={choice(heads === n)}>
                      {n}人
                    </button>
                  ))}
                </div>
              )}
            </Field>

            {mode === "solo" ? (
              <Field
                tight={two}
                label="卓に着く顔ぶれ"
                hint={
                  PACE[pace].lock > 0
                    ? "読み札が半分まで進むまで札に触れません。相手も同じくらいまで待ちます。"
                    : "読み始めた瞬間から取れます。"
                }
              >
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(PACE).map(([k, v]) => (
                    <button key={k} onClick={() => setPace(k)} style={choice(pace === k)}>
                      {v.label}
                    </button>
                  ))}
                </div>
                <div
                  style={{
                    fontFamily: MINCHO,
                    fontSize: 14,
                    color: C.shu,
                    letterSpacing: "0.14em",
                    marginTop: 10,
                  }}
                >
                  {PACE[pace].ranks.map((n) => RANKS[n].name).join("　")}
                </div>
              </Field>
            ) : (
              <Field tight={two} label="取りはじめ">
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setPace("yasashii")} style={choice(pace === "yasashii")}>
                    半分まで待つ
                  </button>
                  <button onClick={() => setPace("futsuu")} style={choice(pace !== "yasashii")}>
                    いつでも
                  </button>
                </div>
              </Field>
            )}

            <Field
              tight={two}
              label="札の枚数"
              hint={
                "暗記は" +
                memoSeconds(size) +
                "秒。枚数に応じて長くなります。" +
                (size >= 24 && !L.wide ? "　この枚数はスマホだと画面をなぞる必要があります。" : "")
              }
            >
              <div className="grid grid-cols-4 gap-2">
                {BOARD_CHOICES.map((n) => (
                  <button key={n} onClick={() => setSize(n)} style={choice(size === n)}>
                    {n}枚
                  </button>
                ))}
              </div>
            </Field>

            <Field
              tight={two}
              label="読み上げ"
              hint={
                voiceOn && voices.length > 0
                  ? "声は端末に入っているものを使います。iPhoneなら 設定 → アクセシビリティ → 読み上げコンテンツ → 声 から「拡張」版を入れると自然になります。"
                  : null
              }
            >
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setVoiceOn(true)} style={choice(voiceOn)}>
                  音声あり
                </button>
                <button
                  onClick={() => {
                    setVoiceOn(false);
                    hush();
                  }}
                  style={choice(!voiceOn)}
                >
                  文字だけ
                </button>
              </div>

              {voiceOn && voices.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute, marginBottom: 8 }}>
                    読み手（触れると試し読み）
                  </div>
                  <div className="flex" style={{ gap: 6, flexWrap: "wrap" }}>
                    {voices.slice(0, two ? 4 : 6).map((v, i) => (
                      <button
                        key={v.name + i}
                        onClick={() => {
                          setVoiceIdx(i);
                          utter("桶狭間で今川義元を討った武将", i);
                        }}
                        style={{ ...choice(voiceIdx === i), padding: "9px 12px", fontSize: 12 }}
                      >
                        {(v.name || "読み手").replace(/^Microsoft\s+/, "").replace(/\s*\(.*\)/, "").slice(0, 14)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Field>

            <Field tight={two} label="札の種類" last={!two}>
              <div className="grid grid-cols-2 gap-2">
                <button style={choice(true)}>日本史</button>
                <button disabled style={{ ...choice(false), opacity: 0.45 }}>
                  世界史 · 準備中
                </button>
              </div>
            </Field>
          </div>

          {/* 開始 */}
          <button
            onClick={start}
            style={{
              width: "100%",
              marginTop: two ? 16 : 22,
              padding: two ? "18px 0" : L.wide ? "22px 0" : "19px 0",
              background: C.shu,
              color: C.onDark,
              border: "none",
              borderRadius: 2,
              boxShadow: C.shadowUp,
              fontFamily: MINCHO,
              fontSize: L.wide ? 23 : 20,
              fontWeight: 700,
              letterSpacing: "0.34em",
              textIndent: "0.34em",
              cursor: "pointer",
            }}
          >
            はじめる
          </button>
          {onExit && (
            <button
              onClick={onExit}
              style={{
                width: "100%",
                marginTop: two ? 8 : 12,
                padding: "12px 0",
                background: "transparent",
                color: C.mute,
                border: "none",
                fontFamily: GOTHIC,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              最初の画面へ戻る
            </button>
          )}
        </div>
      </Shell>
    );
  }

  /* ---------------- 暗記 ---------------- */

  if (screen === "memorize") {
    return (
      <Shell L={L}>
        <div style={{ paddingTop: 30, paddingBottom: 36 }}>
          <div className="flex" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <span style={eyebrow}>暗記</span>
            <span style={{ fontFamily: MONO, fontSize: 26, color: memo <= 5 ? C.shu : C.kin }}>{memo}</span>
          </div>
          <div style={{ height: 1, background: C.panelEdge, marginBottom: 8 }}>
            <div
              style={{
                height: 1,
                width: (memo / memoSeconds(size)) * 100 + "%",
                background: C.shu,
                transition: reduce.current ? "none" : "width 1s linear",
              }}
            />
          </div>
          <p style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.mute, lineHeight: 1.8, margin: "0 0 18px" }}>
            札の位置を覚えてください。並びはこのまま変わりません。
            {mode === "local" && "　全員で覗き込んで構いません。"}
          </p>

          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: "repeat(" + L.cols + ", minmax(0, 1fr))", marginBottom: 24 }}
          >
            {board.map((c) => (
              <div
                key={c.id}
                style={{
                  background: C.card,
                  color: C.ink,
                  border: "1px solid " + C.cardEdge,
                  borderRadius: 2,
                  boxShadow: C.shadow,
                  padding: "16px 4px",
                  fontFamily: MINCHO,
                  fontSize: L.card,
                  fontWeight: 700,
                  lineHeight: 1.35,
                  minHeight: L.cardH,
                  textAlign: "center",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {c.a}
              </div>
            ))}
          </div>

          <button
            onClick={beginPlay}
            style={{
              width: "100%",
              padding: "17px 0",
              background: C.shu,
              color: C.onDark,
              border: "none",
              fontFamily: MINCHO,
              fontSize: 18,
              letterSpacing: "0.3em",
              cursor: "pointer",
            }}
          >
            覚えた
          </button>
        </div>
      </Shell>
    );
  }

  /* ---------------- 結果 ---------------- */

  if (screen === "result") {
    const rows = players
      .map((p) => ({
        name: p.name,
        key: p.id,
        color: p.color,
        me: mode === "solo" && p.id === "you",
        take: score[p.id] || 0,
        f: foul[p.id] || 0,
        pt: (score[p.id] || 0) - (foul[p.id] || 0),
      }))
      .sort((a, b) => b.pt - a.pt || b.take - a.take);

    const mine = rows.findIndex((r) => r.me) + 1;
    const missed = log.filter((e) => (mode === "solo" ? e.who !== "あなた" : e.who === null));

    return (
      <Shell L={L} narrow>
        <div style={{ paddingTop: 36, paddingBottom: 44 }}>
          {/* 見出し */}
          <div className="flex" style={{ gap: 14, alignItems: "center", marginBottom: 4 }}>
            <Seal size={L.wide ? 54 : 46} />
            <div>
              <div style={eyebrow}>結果</div>
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
                {mode === "solo" ? mine + "位　" + (score.you || 0) + "枚" : rows[0].name + " の勝ち"}
              </h2>
            </div>
          </div>
          <div style={{ height: 2, background: C.shu, width: 78, margin: "18px 0 4px" }} />
          <div style={{ height: 1, background: C.rule, marginBottom: 18 }} />

          {/* 順位 */}
          <div
            style={{
              background: C.panel,
              border: "1px solid " + C.rule,
              borderRadius: 2,
              boxShadow: C.shadow,
              overflow: "hidden",
            }}
          >
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="flex"
                style={{
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "15px 16px",
                  borderBottom: i === rows.length - 1 ? "none" : "1px solid " + C.rule,
                  borderLeft: "4px solid " + (i === 0 ? C.shu : "transparent"),
                  background: r.me ? "rgba(178,58,46,0.05)" : "transparent",
                }}
              >
                <div className="flex" style={{ gap: 14, alignItems: "baseline" }}>
                  <span
                    style={{
                      fontFamily: MINCHO,
                      fontSize: 15,
                      fontWeight: 700,
                      color: i === 0 ? C.shu : C.mute,
                      width: 20,
                    }}
                  >
                    {["一", "二", "三", "四"][i]}
                  </span>
                  <span
                    style={{
                      fontFamily: MINCHO,
                      fontSize: L.wide ? 20 : 18,
                      fontWeight: 700,
                      color: mode === "local" ? r.color : C.text,
                      letterSpacing: "0.1em",
                    }}
                  >
                    {r.name}
                  </span>
                </div>
                <div className="flex" style={{ gap: 10, alignItems: "baseline" }}>
                  <span style={{ fontFamily: MONO, fontSize: L.wide ? 22 : 19, color: C.text }}>{r.take}</span>
                  <span style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute }}>枚</span>
                  {r.f > 0 && (
                    <span style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.shu }}>お手つき{r.f}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 取れなかった札 */}
          {missed.length > 0 && (
            <>
              <div className="flex" style={{ alignItems: "center", gap: 12, margin: "30px 0 12px" }}>
                <span style={{ fontFamily: MINCHO, fontSize: 16, fontWeight: 700, color: C.text, letterSpacing: "0.14em" }}>
                  取れなかった札
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: C.mute }}>{missed.length}</span>
                <div style={{ flex: 1, height: 1, background: C.rule }} />
              </div>

              {missed.map((e, i) => (
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
                  <div
                    style={{
                      fontFamily: MINCHO,
                      color: C.ink,
                      fontSize: 17,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                    }}
                  >
                    {e.card.a}
                  </div>
                  <div style={{ fontFamily: GOTHIC, color: C.mute, fontSize: 12.5, marginTop: 6, lineHeight: 1.75 }}>
                    {e.card.c}
                  </div>
                  <div style={{ fontFamily: GOTHIC, color: C.kin, fontSize: 12, marginTop: 5 }}>{e.card.n}</div>
                </div>
              ))}
            </>
          )}

          <button
            onClick={start}
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
            もう一度
          </button>
          <div className="grid grid-cols-2 gap-2" style={{ marginTop: 10 }}>
            <button
              onClick={() => setScreen("setup")}
              style={{
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
              設定を変える
            </button>
            <button
              onClick={onExit}
              style={{
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
              最初の画面へ
            </button>
          </div>
          {FEEDBACK_URL && (
            <button
              onClick={openFeedback}
              style={{
                width: "100%",
                marginTop: 12,
                padding: "12px 0",
                background: "transparent",
                color: C.mute,
                border: "none",
                fontFamily: GOTHIC,
                fontSize: 12.5,
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              感想を送る
            </button>
          )}
        </div>
      </Shell>
    );
  }

  /* ---------------- 対戦 ---------------- */

  const shown = target ? target.c.slice(0, tick) : "";
  const youOut = out.includes("you");
  const flip = mode === "local" && picker && picker.side === "top";
  const canTap = mode === "local" ? phase === "picking" : phase === "reading" && !youOut && !held;

  const strip = (side) => {
    const list = players.filter((p) => p.side === side);
    if (list.length === 0) return null;
    return (
      <div className="flex" style={{ gap: 6, transform: side === "top" ? "rotate(180deg)" : "none" }}>
        {list.map((p) => {
          const dead = out.includes(p.id);
          const active = picker && picker.id === p.id;
          return (
            <button
              key={p.id}
              onClick={() => buzz(p)}
              disabled={dead || phase !== "reading" || held}
              style={{
                flex: 1,
                padding: "16px 4px",
                background: active ? p.color : "transparent",
                border: "2px solid " + (dead ? C.panelEdge : p.color),
                opacity: dead ? 0.28 : phase !== "reading" && !active ? 0.5 : 1,
                cursor: "pointer",
                transition: reduce.current ? "none" : "background .15s, opacity .2s",
              }}
            >
              <div style={{ fontFamily: MINCHO, fontSize: 20, color: active ? C.onDark : p.color, letterSpacing: "0.1em" }}>
                {p.name}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 13, color: active ? C.onDark : C.mute, marginTop: 2 }}>
                {score[p.id] || 0}
                {foul[p.id] > 0 && <span style={{ color: active ? C.onDark : C.shu }}> −{foul[p.id]}</span>}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <Shell L={L} cap={mode === "local" ? Math.min(L.max, 640) : L.max}>
      <div className="flex" style={{ justifyContent: "space-between", alignItems: "center", padding: "12px 0 10px" }}>
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.mute, letterSpacing: "0.14em" }}>残り {board.length}</span>
        <button
          onClick={quit}
          style={{ background: "none", border: "none", color: C.mute, fontFamily: GOTHIC, fontSize: 12, cursor: "pointer" }}
        >
          やめる
        </button>
      </div>

      {mode === "local" && <div style={{ marginBottom: 10 }}>{strip("top")}</div>}

      {/* 読み札 */}
      <div
        style={{
          background: C.panel,
          borderRadius: 2,
          boxShadow: C.shadow,
          border: "1px solid " + (taker && taker.ok ? C.kin : picker ? picker.color : C.panelEdge),
          borderLeft: "3px solid " + (picker ? picker.color : C.shu),
          height: L.clueH,
          padding: "14px 12px",
          display: "flex",
          justifyContent: "flex-end",
          overflow: "hidden",
          transition: reduce.current ? "none" : "border-color .2s",
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
          {shown}
          {phase === "reading" && target && tick < target.c.length && (
            <span style={{ color: C.shu, opacity: 0.85 }}>｜</span>
          )}
        </div>
      </div>

      {/* 場の様子 */}
      <div style={{ minHeight: 56, display: "flex", flexDirection: "column", justifyContent: "center", padding: "7px 0" }}>
        {taker ? (
          <>
            <span style={{ fontFamily: MINCHO, fontSize: L.status + 3, letterSpacing: "0.14em", color: taker.ok ? C.kin : C.mute }}>
              {taker.ok ? taker.who + " が取った — " + target.a : "だれも取れず — " + target.a}
            </span>
            <span style={{ fontFamily: GOTHIC, fontSize: L.status, color: C.mute, marginTop: 5, lineHeight: 1.6 }}>{target.n}</span>
          </>
        ) : phase === "picking" && picker ? (
          <span style={{ fontFamily: MINCHO, fontSize: 16, color: picker.color, letterSpacing: "0.1em" }}>
            {picker.name} — 札を選ぶ　
            <span style={{ fontFamily: MONO, fontSize: 15 }}>{(pickLeft / 1000).toFixed(1)}</span>
          </span>
        ) : wrongPick ? (
          <span style={{ fontFamily: GOTHIC, fontSize: 13, color: C.shu }}>
            {wrongPick.who} お手つき（{wrongPick.card}）
          </span>
        ) : held ? (
          <span style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.kin, letterSpacing: "0.06em" }}>
            半分まで聞いてから — あと{lockTicks - tick}字
          </span>
        ) : mode === "solo" && out.length >= players.length - 1 && !out.includes("you") ? (
          <span style={{ fontFamily: GOTHIC, fontSize: 12.5, color: C.kin }}>
            相手は全員お手つき — あなたが取るまで次へ進みません
          </span>
        ) : (
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.mute, letterSpacing: "0.2em", opacity: 0.55 }}>READING</span>
        )}
      </div>

      {/* ひとり用の点数 */}
      {mode === "solo" && (
        <div className="flex" style={{ gap: 6, marginBottom: 12 }}>
          {players.map((p) => {
            const dead = out.includes(p.id);
            const won = taker && taker.ok && taker.who === p.name;
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
                <div style={{ fontFamily: MINCHO, fontSize: L.name, color: p.id === "you" ? C.kin : C.text }}>{p.name}</div>
                <div style={{ fontFamily: MONO, fontSize: L.score, color: C.text, marginTop: 3 }}>{score[p.id] || 0}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* 取り札 */}
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: "repeat(" + (mode === "local" ? 3 : L.cols) + ", minmax(0, 1fr))",
          transform: flip ? "rotate(180deg)" : "none",
          transition: reduce.current ? "none" : "transform .18s",
          marginBottom: mode === "local" ? 12 : 28,
        }}
      >
        {board.map((c) => {
          const isTarget = taker && taker.ok && c.id === target.id;
          const dim = phase === "resolved" && !isTarget;
          return (
            <button
              key={c.id}
              onClick={() => grab(c)}
              disabled={!canTap}
              style={{
                background: isTarget ? C.shu : C.card,
                color: isTarget ? C.onDark : C.ink,
                border: "1px solid " + (isTarget ? "#8C2C22" : C.cardEdge),
                borderRadius: 2,
                boxShadow: dim ? "none" : isTarget ? C.shadowUp : C.shadow,
                padding: "16px 4px",
                fontFamily: MINCHO,
                fontSize: 14,
                letterSpacing: "0.04em",
                lineHeight: 1.35,
                cursor: canTap ? "pointer" : "default",
                opacity: dim ? 0.22 : canTap ? 1 : 0.45,
                transition: reduce.current ? "none" : "opacity .25s, background .2s",
                minHeight: L.cardH,
              }}
            >
              {c.a}
            </button>
          );
        })}
      </div>

      {mode === "local" && <div style={{ paddingBottom: 24 }}>{strip("bottom")}</div>}
    </Shell>
  );
}

/* ---------------- 部品 ---------------- */

const eyebrow = {
  fontFamily: MONO,
  fontSize: 10.5,
  letterSpacing: "0.28em",
  color: C.mute,
};

function Label({ children }) {
  return (
    <div
      style={{
        fontFamily: GOTHIC,
        fontSize: 12,
        fontWeight: 700,
        color: C.text,
        letterSpacing: "0.18em",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function choice(on) {
  return {
    padding: "14px 4px",
    background: on ? C.sumi : C.card,
    color: on ? C.onDark : C.mute,
    border: "1px solid " + (on ? C.sumi : C.rule),
    borderRadius: 2,
    fontFamily: GOTHIC,
    fontSize: 13.5,
    fontWeight: on ? 700 : 500,
    letterSpacing: "0.04em",
    boxShadow: on ? "none" : C.shadow,
    cursor: "pointer",
  };
}

/* 設定のひとかたまり。罫で区切ると、箱の羅列に見えなくなる */
function Field({ label, hint, children, last, tight }) {
  return (
    <div style={{ padding: tight ? "13px 0" : "18px 0", borderBottom: last ? "none" : "1px solid " + C.rule }}>
      <div
        style={{
          fontFamily: GOTHIC,
          fontSize: 12,
          fontWeight: 700,
          color: C.text,
          letterSpacing: "0.18em",
          marginBottom: 11,
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div style={{ fontFamily: GOTHIC, fontSize: 11.5, color: C.mute, lineHeight: 1.8, marginTop: 9 }}>{hint}</div>
      )}
    </div>
  );
}

/* 落款。これ一つで「かるた」の顔になる */
function Seal({ size = 46 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        background: C.shu,
        color: C.onDark,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: MINCHO,
        fontSize: size * 0.46,
        fontWeight: 700,
        letterSpacing: "0.04em",
        borderRadius: 2,
        boxShadow: C.shadow,
        flexShrink: 0,
      }}
    >
      札
    </div>
  );
}

function Shell({ children, L, narrow, cap }) {
  const w = cap || (L ? (narrow ? L.narrow : L.max) : narrow ? 520 : 460);
  return (
    <div style={{ background: C.ground, minHeight: "100vh", width: "100%" }}>
      <div style={{ maxWidth: w, margin: "0 auto", padding: "0 18px" }}>{children}</div>
    </div>
  );
}
