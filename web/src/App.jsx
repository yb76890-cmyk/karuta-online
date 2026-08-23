import React, { useState } from "react";
import Offline from "./Offline.jsx";
import Online from "./Online.jsx";
import { C, MINCHO, GOTHIC, MONO, useLayout, FEEDBACK_URL, openFeedback } from "./core.js";

export default function App() {
  const [mode, setMode] = useState(null);
  const L = useLayout();

  if (mode === "offline") return <Offline onExit={() => setMode(null)} />;
  if (mode === "online") return <Online onExit={() => setMode(null)} />;

  return (
    <div style={{ minHeight: "100vh" }}>
      <div style={{ maxWidth: L.narrow, margin: "0 auto", padding: "0 18px" }}>
        <div style={{ paddingTop: L.tier === "lg" ? 56 : L.wide ? 70 : 62, paddingBottom: 40 }}>
          <div className="flex" style={{ gap: 16, alignItems: "center", marginBottom: 22 }}>
            <div
              style={{
                width: L.wide ? 62 : 52,
                height: L.wide ? 62 : 52,
                background: C.shu,
                color: C.onDark,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: MINCHO,
                fontSize: L.wide ? 30 : 25,
                fontWeight: 700,
                borderRadius: 2,
                boxShadow: C.shadow,
              }}
            >
              札
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.3em", color: C.mute }}>
              とりふだ・よみふだ
            </div>
          </div>

          <h1
            style={{
              fontFamily: MINCHO,
              color: C.text,
              fontSize: L.title,
              letterSpacing: "0.2em",
              fontWeight: 700,
              margin: "0 0 14px",
              lineHeight: 1.15,
            }}
          >
            日本史かるた
          </h1>
          <p style={{ fontFamily: GOTHIC, fontSize: 13.5, color: C.mute, lineHeight: 1.9, margin: "0 0 8px" }}>
            読み札を聞いて、当てはまる人物や合戦の札を取り合います。札は223枚。
          </p>
          <div style={{ height: 2, background: C.shu, width: 78, margin: "20px 0 4px" }} />
          <div style={{ height: 1, background: C.rule, marginBottom: 30 }} />

          <Card onClick={() => setMode("online")} L={L} main title="オンライン対戦" sub="離れた場所から2〜4人で" />
          <Card onClick={() => setMode("offline")} L={L} title="ひとりで / 1台で対戦" sub="相手はコンピュータ、または端末を囲んで" />

          {FEEDBACK_URL && (
            <button
              onClick={openFeedback}
              style={{
                width: "100%",
                marginTop: 26,
                padding: "14px 0",
                background: "transparent",
                color: C.mute,
                border: "1px solid " + C.rule,
                borderRadius: 2,
                fontFamily: GOTHIC,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              ご意見・不具合の報告
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ onClick, L, main, title, sub }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        display: "block",
        textAlign: "left",
        padding: L.wide ? "26px 22px" : "22px 18px",
        marginBottom: 12,
        background: main ? C.sumi : C.card,
        color: main ? C.onDark : C.text,
        border: "1px solid " + (main ? C.sumi : C.rule),
        borderRadius: 2,
        boxShadow: main ? C.shadowUp : C.shadow,
        cursor: "pointer",
      }}
    >
      <span
        style={{
          fontFamily: MINCHO,
          fontSize: L.wide ? 22 : 19,
          fontWeight: 700,
          letterSpacing: "0.16em",
          display: "block",
        }}
      >
        {title}
      </span>
      <span
        style={{
          display: "block",
          fontFamily: GOTHIC,
          fontSize: 11.5,
          letterSpacing: "0.04em",
          color: main ? "rgba(253,251,245,0.7)" : C.mute,
          marginTop: 8,
        }}
      >
        {sub}
      </span>
    </button>
  );
}
