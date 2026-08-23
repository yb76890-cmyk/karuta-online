# 日本史かるた — オンライン対戦

離れた場所にいる2〜4人で遊ぶかるたです。ひとり用と、1台を囲んで遊ぶ対戦も入っています。

```
karuta-online/
├── server/          対戦サーバー（Node + WebSocket）
│   ├── server.js    部屋の管理、読み札の配信、勝敗の判定
│   ├── cards.js     札データ
│   └── package.json
└── web/             画面（React + Vite）
    ├── src/App.jsx      入口
    ├── src/Online.jsx   オンライン対戦
    ├── src/Offline.jsx  ひとり用 / 1台で対戦
    ├── src/core.js      札データ・配色・読み辞書（共通）
    └── package.json
```

---

## 勝敗の決め方

通信の速い人が有利にならないよう、こうしています。

暗記の間は、全員が「覚えた」を押した時点で切り上がります。制限時間はその上限として残ります。

1. サーバーが読み札の文を全員に配る
2. 各端末は**受け取った瞬間から自分の時計で**経過時間を測る
3. 札を選んだら「この札を、2.41秒で取った」という記録だけを送る
4. サーバーは一番小さい値の人を勝ちにする

回線の遅い人がいても、その人の申告が届くのが遅れるだけで、勝敗は変わりません。最初の正解申告から1.2秒だけ待って締め切ります（`SETTLE_MS`）。この1.2秒が「決着までの間」です。

答えの札はサーバーだけが持っていて、結果を出すまで配りません。

---

## 手元で動かす

Node.js 18以上が必要です。ターミナルを2つ開いてください。

**1つ目 — サーバー**

```bash
cd server
npm install
npm start          # → karuta server listening on 8080
```

**2つ目 — 画面**

```bash
cd web
npm install
cp .env.example .env
npm run dev        # → http://localhost:5173
```

同じWi-Fiにいる別の端末から試すときは、表示される `Network:` の住所（例 `http://192.168.1.5:5173`）をスマホで開くだけです。`.env` に `VITE_WS_URL` を書いていなければ、開いているページと同じ相手の8080番へ自動で繋ぎます。

スマホから繋がらないときは、Windowsのファイアウォールで8080番が塞がれていないか確認してください。

---

## 公開する

### 1. サーバーを置く（Render の例）

1. GitHubにこのフォルダを置く
2. [render.com](https://render.com) で New → Web Service
3. リポジトリを選び、次のように設定
   - Root Directory: `server`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
4. できあがった住所を控える（例 `https://karuta-server.onrender.com`）

**注意**

- 無料枠は15分ほど誰も来ないと停止します。次に誰かが繋ぐと起き上がるまで30秒ほどかかります。最初の入室が遅いのはこれが原因です
- 常時起きていてほしい場合は有料プラン（月7ドル程度）に変えます

### 2. 画面を置く（Netlify の例）

1. [netlify.com](https://netlify.com) で Add new site → Import from Git
2. 設定
   - Base directory: `web`
   - Build command: `npm run build`
   - Publish directory: `web/dist`
3. Environment variables に追加

```
VITE_WS_URL = wss://karuta-server.onrender.com
```

`https` のサーバーには `wss`（末尾がs）で繋ぎます。ここを `ws` にすると繋がりません。**一番多いつまずきです。**

4. デプロイ完了後に出るURLを、遊ぶ人に渡します

### 3. 動作確認

1. 2台の端末で同じURLを開く
2. どちらも「オンライン対戦」→ 同じ部屋コード（例 `test1`）を入れる
3. 待合に二人並んだら、部屋主が「はじめる」

---

## 読み札の音声を用意する

端末の合成音声は質が端末まかせで、歴史語の読みも外しがちです。**音声を先に作ってファイルとして置いておけば**、全員が同じ声・同じ長さを聞くことになり、読み間違いも起きません。

置かなくてもゲームは動きます。ファイルが無ければ自動で端末の合成音声に切り替わります。

### 作り方

札は223枚、合計およそ5000文字です。どのサービスでも無料枠に収まる量です。

**Python の edge-tts を使う（鍵も費用も不要）**

```bash
pip install edge-tts
node tools/gen-voice.mjs --provider=edge
```

**Google Cloud Text-to-Speech を使う**

Google Cloud で Text-to-Speech を有効にし、APIキーを発行します。

```bash
set GOOGLE_TTS_KEY=あなたの鍵
node tools/gen-voice.mjs --provider=google
```

**OpenAI を使う**

```bash
set OPENAI_API_KEY=あなたの鍵
node tools/gen-voice.mjs --provider=openai
```

声を変えたいときは `--voice=ja-JP-Neural2-C` のように足します。速さは `--rate=0.95`。作り直したいときは `--force`。

### できあがるもの

`web/public/voice/` に mp3 が並びます。ファイル名は読み札の文から機械的に決めた記号なので、**一覧を見ても答えの札は分かりません**。

札を足したあとにもう一度実行すると、足りない分だけ作られます。

### 注意

読み札の文を1文字でも変えるとファイル名も変わるので、その札の音声を作り直す必要があります。実行し直せば自動で追加されます。

---

## ご意見フォームをつなぐ

遊んだ人の声を集める入口です。つながなければボタンは出ません。

### 1. Googleフォームを作る

[forms.google.com](https://forms.google.com) で新規作成し、質問を並べます。おすすめの構成は次のとおりです。

| 質問 | 形式 | ねらい |
|---|---|---|
| どの端末で遊びましたか | 選択（スマホ / パソコン / タブレット） | 表示の崩れを切り分ける |
| どの遊び方でしたか | 選択（ひとり / 1台で対戦 / オンライン） | どこが使われているか |
| 面白かったですか | 5段階 | 全体の手応え |
| 難しさはどうでしたか | 選択（易しい / ちょうどよい / 難しい） | 札の難度の調整に使う |
| 読み上げは聞き取れましたか | 選択 | 音声を作るか判断する材料 |
| 困ったこと・直してほしいこと | 記述 | 不具合の発見 |
| あったらいいと思う機能 | 記述 | 次に作るものの判断 |
| 環境 | 記述（省略可） | 自動で埋める用。下記参照 |

回答は「回答」タブから表計算に出せます。

### 2. URLをコードに貼る

フォーム右上の「送信」→ リンクのアイコン → URLをコピー。`web/src/core.js` の次の行に貼ります。

```js
export const FEEDBACK_URL = "https://forms.gle/あなたのフォーム";
```

これだけで、最初の画面と結果画面にボタンが出ます。

### 3. 環境を自動で埋める（任意）

「環境」の記述欄を作った場合、その欄に画面の大きさやブラウザの情報を自動で入れられます。

1. フォームの右上「⋮」→「事前入力したURLを取得」
2. 環境の欄に適当な文字を入れて「リンクを取得」
3. 出てきたURLの中の `entry.1234567890` という部分を控える
4. `core.js` の `ENTRY_ID` にそれを入れる

```js
const ENTRY_ID = "entry.1234567890";
```

不具合の報告で「どの端末か分からない」という事態を防げます。

---

## 手を入れるところ

| したいこと | 触る場所 |
|---|---|
| 札を足す・直す | `web/src/core.js` の `NIHONSHI` と `server/cards.js`（**両方**） |
| 世界史版を足す | 同じ形式で配列を作り、`DECKS` に追加 |
| 札の枚数の選択肢 | `BOARD_CHOICES`（両方のファイル） |
| 暗記の秒数 | `memoSeconds`（枚数から自動計算） |
| 判定を待つ時間 | `server/server.js` の `SETTLE_MS` |
| 読み間違いを直す | `core.js` と `server/cards.js` の `YOMI` に語と読みを足す |
| 読み札の音声 | `node tools/gen-voice.mjs`（上の節を参照） |
| ご意見フォーム | `core.js` の `FEEDBACK_URL` |

札データが2箇所にあるのは、サーバーが答えを持ち、画面が表示を担うためです。将来ひとつにまとめるなら、共有パッケージに切り出します。

---

## まだ入っていないもの

- 途中で切れた人の復帰（今は抜けた扱いになります）
- 対戦中の部屋への途中参加
- 部屋の一覧や自動マッチング（部屋コードを口頭で伝える前提）
- 不正対策（画面側の時計を書き換えれば速く申告できてしまいます。身内で遊ぶ分には問題になりません）

---

## スマホアプリにするとき

サーバーはそのまま使えます。`web` を Capacitor で包めば、同じコードがiOS/Androidアプリになります。

```bash
cd web
npm install @capacitor/core @capacitor/cli
npx cap init
npm run build && npx cap add ios
```

公開にはApple Developer Program（年99ドル）とGoogle Play（初回25ドル）の登録が必要です。
