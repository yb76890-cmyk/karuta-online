#!/usr/bin/env node
/* ============================================================
   読み札の音声を作る

   使い方（server/cards.js の札を全部読み上げて mp3 にする）

     Google の場合
       set GOOGLE_TTS_KEY=あなたの鍵
       node tools/gen-voice.mjs --provider=google

     OpenAI の場合
       set OPENAI_API_KEY=あなたの鍵
       node tools/gen-voice.mjs --provider=openai

     Python の edge-tts を入れている場合（鍵も費用も不要）
       pip install edge-tts
       node tools/gen-voice.mjs --provider=edge

   できたファイルは web/public/voice/ に入る。
   ファイル名は読み札の文から機械的に決まるので、
   ファイル一覧を見ても答えの札は分からない。

   既にあるファイルは飛ばすので、札を足したときは
   そのまま実行すれば足りない分だけ作られる。
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "web", "public", "voice");

const { NIHONSHI, toSpoken } = require(path.join(root, "server", "cards.js"));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);

const provider = args.provider || "google";
const force = !!args.force;

// core.js の clueKey と同じ計算にすること
function clueKey(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ---------------- 各サービスへの依頼 ---------------- */

async function viaGoogle(text) {
  const key = process.env.GOOGLE_TTS_KEY;
  if (!key) throw new Error("GOOGLE_TTS_KEY が設定されていません");
  const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize?key=" + key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "ja-JP", name: args.voice || "ja-JP-Neural2-B" },
      audioConfig: { audioEncoding: "MP3", speakingRate: Number(args.rate || 1.0), pitch: 0 },
    }),
  });
  if (!res.ok) throw new Error("Google: " + res.status + " " + (await res.text()).slice(0, 200));
  const data = await res.json();
  return Buffer.from(data.audioContent, "base64");
}

async function viaOpenAI(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY が設定されていません");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: args.model || "gpt-4o-mini-tts",
      voice: args.voice || "shimmer",
      input: text,
      response_format: "mp3",
      speed: Number(args.rate || 1.0),
    }),
  });
  if (!res.ok) throw new Error("OpenAI: " + res.status + " " + (await res.text()).slice(0, 200));
  return Buffer.from(await res.arrayBuffer());
}

function viaEdge(text, file) {
  const voice = args.voice || "ja-JP-NanamiNeural";
  return new Promise((resolve, reject) => {
    execFile(
      "edge-tts",
      ["--voice", voice, "--text", text, "--write-media", file],
      { windowsHide: true },
      (err) => (err ? reject(new Error("edge-tts: " + err.message)) : resolve(null))
    );
  });
}

/* ---------------- 本体 ---------------- */

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const jobs = NIHONSHI.map((c) => ({
    key: clueKey(c.c),
    text: toSpoken(c.c), // 読み辞書を通してから渡す
    label: c.a,
  }));

  const seen = new Set();
  const dup = jobs.filter((j) => (seen.has(j.key) ? true : (seen.add(j.key), false)));
  if (dup.length) {
    console.error("同じ名前になる札があります。読み札の文を少し変えてください:");
    dup.forEach((d) => console.error("  " + d.label));
    process.exit(1);
  }

  let made = 0;
  let skipped = 0;

  for (const j of jobs) {
    const file = path.join(outDir, j.key + ".mp3");
    if (!force && fs.existsSync(file)) {
      skipped++;
      continue;
    }
    try {
      if (provider === "edge") {
        await viaEdge(j.text, file);
      } else {
        const buf = provider === "openai" ? await viaOpenAI(j.text) : await viaGoogle(j.text);
        fs.writeFileSync(file, buf);
      }
      made++;
      console.log("○ " + j.label + "  (" + j.key + ".mp3)");
      await new Promise((r) => setTimeout(r, 120)); // 立て続けに叩かない
    } catch (e) {
      console.error("× " + j.label + " — " + e.message);
      process.exit(1);
    }
  }

  const manifest = jobs.map((j) => ({ key: j.key, label: j.label }));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log("");
  console.log("作成 " + made + " 件 / 既存 " + skipped + " 件");
  console.log("保存先: " + outDir);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
