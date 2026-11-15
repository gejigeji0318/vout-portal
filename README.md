# 大会ポータルサイト

要件定義書・画面設計書・DB設計書・実装計画書にもとづく実装です。
現在の内容：**段階 1〜5 ＋段階 6-1・6-2**
- サーバー：DB、Discord ログイン、セッション、権限判定、管理 API、Discord 通知（Bot）、画像のアップロード、テスト
- 段階 2-1：はじめに・大会概要・ルールブック（版の履歴）・プライバシーポリシー、お知らせ（カテゴリー・対象者・下書き・予約公開・重要なお知らせの既読確認と再通知）
- 段階 2-2：TOP、問い合わせ（管理者の対応を含む）、適性レーン（既存の championLane を取り込み、/tools/lanes/ に同じデザインで表示）
- 段階 3：募集の設定、応募フォーム（宣材写真の位置調整つき）・応募状況、審査（A〜E、もう 1 人の審査は送信まで非表示）、仮決定表、最終決定と発表、採用の取り消し
- 段階 4：ドラフト（既存システムの進行ルールと画面を移植）、Durable Objects によるリアルタイム同期、配信用画面（鍵つき URL）、結果の確定
- 段階 5-1：予定表（○△×、標準の時間帯、まとめて入力、同時にそろう人数の色分け、締切後の変更の印）、スクリム（申請、候補の自動提示、別案、確定、参加メンバー、実施済み・中止）
- 段階 5-2：人員補充（募集、応募、声かけ、承認でスクリムの参加メンバーに追加、OB への自動募集と「今すぐ OB に募集」、OB の確認）
- 段階 5-3：チームページ（ページの追加・削除と 30 日以内の復元、投稿と画像、絵文字のリアクション、コーチによるチーム名の決定）、TOP の「次の予定」「やること」の追加
- 段階 6-1：大会参加者一覧、チーム紹介（本人の公開設定つき）、毎日の削除処理（削除した投稿 10 日・ページ 30 日・操作ログ 1 年）
- 段階 6-2：二人承認（管理者の追加・解除、大会終了）、大会の復元（10 日以内）と物理削除、2 年ログインなしの削除、見るだけのプレビュー、OB への自動募集の時刻の設定
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
| `e2e/fill.spec.ts` | 確定したスクリムから補充を募集 → 運営スタッフが応募 → コーチが決定、参加していない人に OB の確認の案内が出る |
| `e2e/team.spec.ts` | 選手が投稿 → コーチがリアクション → 他のチームの選手には見えない |
| `e2e/scrim.spec.ts` | 予定表の確認 → 候補から申請 → 相手のコーチが確定 → 選手は確定してから見える |

## 立場を切り替えて確かめる（開発・テスト環境だけ）

`npm run dev` で動かしているとき、画面の一番下に「開発用：立場を切り替える」が出ます。「ドラフト用の見本データを作る」を押すと、テスト用のコーチ 2 人と選手 10 人が用意され、ドラフトを試せます。「スクリム用の見本データを作る」を押すと、今日から 2 週間をスクリム期間にして、2 チームの選手と 1 週間分の予定が用意されます。押すと、その立場のテスト用アカウント（名前に「（テスト）」が付く）でログインし直します。Discord のアカウントが 1 つでも、選手・コーチ・補助スタッフなどの画面を確かめられます。

- 開発（`ENVIRONMENT=development`）：PC の中（localhost）からの接続だけで使える
- テスト環境（`ENVIRONMENT=test`）：管理者だけが使える。管理者権限を持つ立場は選べない
- 本番：常に「存在しない」応答になり、欄も表示されない（自動テストで確認）

## OB の確認

OB は、Discord でもう一度認証し（権限 `identify guilds`）、`DISCORD_GUILD_ID` のサーバーに参加していることを確かめます。Discord の開発者ページの OAuth2 の Redirects に、ログイン用に加えて `…/auth/ob-callback` も登録してください（PC では `http://localhost:8787/auth/ob-callback`）。

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
