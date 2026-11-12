# 大会ポータルサイト

要件定義書・画面設計書・DB設計書・実装計画書にもとづく実装です。
現在の内容：**段階 1〜4（土台、公開まわり、応募・選考、ドラフト）**
- サーバー：DB、Discord ログイン、セッション、権限判定、管理 API、Discord 通知（Bot）、画像のアップロード、テスト
- 段階 2-1：はじめに・大会概要・ルールブック（版の履歴）・プライバシーポリシー、お知らせ（カテゴリー・対象者・下書き・予約公開・重要なお知らせの既読確認と再通知）
- 段階 2-2：TOP、問い合わせ（管理者の対応を含む）、適性レーン（既存の championLane を取り込み、/tools/lanes/ に同じデザインで表示）
- 段階 3：募集の設定、応募フォーム（宣材写真の位置調整つき）・応募状況、審査（A〜E、もう 1 人の審査は送信まで非表示）、仮決定表、最終決定と発表、採用の取り消し
- 段階 4：ドラフト（既存システムの進行ルールと画面を移植）、Durable Objects によるリアルタイム同期、配信用画面（鍵つき URL）、結果の確定
- 画面：マイページ（運営メンバーのアイコンを含む）、管理者画面（大会設定・チーム・ユーザー）、システム設定（Discord 通知・操作ログ）

## 必要なもの

- Node.js 22 以上
- Cloudflare アカウント（Workers・D1・R2・Zero Trust）
- Discord の開発者アカウント（アプリケーションを 2 つ：開発・テスト用と本番用）

## はじめに（自分の PC）

```bash
npm install          # 依存関係を入れる（バージョンは固定済み。組み合わせが合わないとエラーで止まる）
npm test             # 単体テスト・権限のテストをすべて実行
npm run typecheck    # 型チェック（サーバーと画面の両方）
npm run build        # 画面をビルド（dist/client に出力）
```

テストは Cloudflare の実行環境（workerd）と D1 をローカルで再現して動きます。本物の Discord や本番のデータには接続しません。

## ローカルで動かす

1. `.dev.vars.example` を `.dev.vars` にコピーして、値を入れる
2. `wrangler.toml` の `DISCORD_CLIENT_ID` に開発用 Discord アプリの ID を入れる
3. Discord アプリの Redirects に `http://localhost:8787/auth/callback` を登録する
4. 通知用の Bot を用意する（下の「Discord 通知用の Bot」）
5. `npm run db:migrate:local` → `npm run dev`（画面をビルドしてから http://localhost:8787 で起動）

## 画面の通しテスト（e2e）

ブラウザを自動で操作して、画面の流れを最初から最後まで確かめます。専用のサーバーとデータベース（ポート 8788、毎回まっさら）で動くので、`npm run dev` のデータには触れません。

```bash
npx playwright install chromium   # 最初の 1 回だけ（テスト用のブラウザを入れる）
npm run e2e                       # 画面をビルドして、通しテストを実行
```

| ファイル | 確かめること |
| --- | --- |
| `e2e/draft.spec.ts` | ドラフト 1 回分（コーチ 2 人と運営が同時に操作、被り・ルーレット・自由選択、配信用画面、結果の確定）と、選手が見られないこと |

## 立場を切り替えて確かめる（開発・テスト環境だけ）

`npm run dev` で動かしているとき、画面の一番下に「開発用：立場を切り替える」が出ます。「ドラフト用の見本データを作る」を押すと、テスト用のコーチ 2 人と選手 10 人が用意され、ドラフトを試せます。押すと、その立場のテスト用アカウント（名前に「（テスト）」が付く）でログインし直します。Discord のアカウントが 1 つでも、選手・コーチ・補助スタッフなどの画面を確かめられます。

- 開発（`ENVIRONMENT=development`）：PC の中（localhost）からの接続だけで使える
- テスト環境（`ENVIRONMENT=test`）：管理者だけが使える。管理者権限を持つ立場は選べない
- 本番：常に「存在しない」応答になり、欄も表示されない（自動テストで確認）

## Discord 通知用の Bot

通知は、ログインに使う Discord アプリの Bot が、固定の 1 サーバーに投稿します。送り先は管理者画面（システム設定 → Discord 通知）で、カテゴリー → チャンネルの順に選びます。

1. Discord の開発者ページで、ログイン用と同じアプリを開き、**Bot** の画面で **Reset Token** を押してトークンを控える（他人に見せない・GitHub に上げない）
2. 特権インテント（Privileged Gateway Intents）はすべてオフのままでよい
3. **OAuth2 → URL Generator** で、スコープに `bot`、権限に `View Channels` と `Send Messages` だけを選び、表示された URL を開いてサーバーに Bot を追加する（管理者権限は付けない）
4. Discord の設定で「開発者モード」をオンにし、サーバー名を右クリック →「サーバー ID をコピー」
5. `.dev.vars` に `DISCORD_BOT_TOKEN`（手順 1）と `DISCORD_GUILD_ID`（手順 4）を書く
6. 送り先にしたいチャンネルが非公開の場合は、そのチャンネルの権限で Bot に「チャンネルを見る」「メッセージを送信」を許可する

## 適性レーン

既存の championLane（GitHub Pages の `data.json`）を、毎日 7:00 にサーバーが取り込みます（`wrangler.toml` の `LANES_DATA_URL`）。
日本語名は Riot 公式の Data Dragon から取り込みます。データの形を検査し、100 体未満や不正な値のときは上書きせず、前日のデータを表示したまま Discord で知らせます。
PC では、管理者画面の「お知らせ・ページ・ツール → 適性レーン → 今すぐ更新」で取り込めます。

## Cloudflare への準備（テスト環境・本番それぞれ）

```bash
npx wrangler d1 create portal-db          # 表示された database_id を wrangler.toml に書く
npx wrangler r2 bucket create portal-images
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put SIGNING_KEY
npm run db:migrate:remote
```

- `wrangler.toml` の `ENVIRONMENT` を `production`、`APP_ORIGIN` を本番の URL、`DISCORD_CLIENT_ID` と `DISCORD_GUILD_ID` を本番の値にする
- **Cloudflare Access**：Zero Trust で、`/admin*` と `/api/admin*` を対象にしたアプリケーションを作り、許可するメールを管理者 5 名に限る。Application Audience (AUD) を `ACCESS_AUD`、チームのドメインを `ACCESS_TEAM_DOMAIN` に設定する。本番でこの 2 つが空だと、管理者 API はすべて拒否されます（設定漏れで素通りにしない作り）
- **レート制限**（S-1-4）：Cloudflare の WAF で `/auth/*` に IP ごとのレート制限ルールを作る
- Cloudflare アカウントは二段階認証を必須にし、アクセスできるのは全体管理者 2 名のみ

## 構成

```
migrations/      DB の変更（段階ごとに追加）
src/
  index.ts       入口（共通の中間処理とルーティング）
  auth/          セッション・CSRF トークン
  middleware/    セキュリティヘッダー、ログイン・権限、Cloudflare Access
  routes/        API（/auth、/api/me、/api/admin）
  services/      操作ログ、Discord 通知、大会の共通処理
  lib/           ID、暗号、入力チェック、時刻
web/             画面（React ＋ Mantine）
  public/_headers  画面にもセキュリティヘッダーを付ける設定
  src/pages/     各画面（admin/ は管理者画面。参加者には読み込まれない）
test/            テスト（権限表は permissions.test.ts）
```

## 依存関係について

公開から 2 週間以上たったバージョンを、`package.json` で固定しています。新しく出たばかりの版に悪意あるコードが入る事故を避けるためです。更新するときも同じ考え方で行ってください。
