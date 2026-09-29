# まいにち学習スタンプ

家庭の2台だけで使う、React + Cloudflare Pages Functions + D1 の学習習慣アプリです。
毎日の達成で絵本風の仲間が卵から成獣へ育ち、娘のAndroid端末へ未達通知を送れます。

タイマー作動中は対応端末で画面の自動ロックを抑止し、完了時に音で知らせます。
省電力設定、手動ロック、アプリのバックグラウンド移動、非対応ブラウザでは保証されませんが、
タイマー自体は終了予定時刻から復帰できます。

## ローカル起動

```bash
cp .dev.vars.example .dev.vars
npm install
npm run generate:vapid
npm run db:migrate
npm run pages:dev
```

`generate:vapid` はVAPID鍵を`.dev.vars`へ直接保存し、秘密鍵を画面へ表示しません。
既存の秘密鍵がある場合は端末登録を守るため再生成せず終了します。
初回だけ `POST /api/setup` に `.dev.vars` の `BOOTSTRAP_TOKEN` を
`X-Bootstrap-Token` ヘッダーとして付け、4桁PINを設定します。
画面の「初めての1台を設定する」からも実行できます。完了時に1回だけ表示される
家族キーを保存してください。親ページの「娘端末用QRコードを表示」を娘端末で読むと、
URL fragmentから家族キーが自動入力されます。fragmentは読取直後にURLから削除され、
サーバーへは送信されません。

## 検証

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Cloudflare Pages

1. D1データベース `study-habit` を作成する。
2. `wrangler.toml` のD1 IDを、作成したデータベースのIDへ置き換える。
3. `npx wrangler d1 migrations apply study-habit --remote` で初期マイグレーションを適用する。
4. PagesのD1 bindingを `DB` として追加する。
5. `BOOTSTRAP_TOKEN`、`PARENT_SESSION_SECRET`、`VAPID_PUBLIC_KEY` を
   Pagesの環境変数として設定する。
6. ビルドコマンドを `npm run build`、出力先を `dist` にする。

## Android未達通知

1. `npm run generate:vapid` でVAPID鍵を最初に1組だけ`.dev.vars`へ生成する。
2. `wrangler.notifications.toml` のD1 IDを `wrangler.toml` と同じ値へ置き換える。
3. 通知Workerへ3つのSecretを登録する。

```bash
sed -n 's/^VAPID_PUBLIC_KEY=//p' .dev.vars | npx wrangler secret put VAPID_PUBLIC_KEY --config wrangler.notifications.toml
sed -n 's/^VAPID_PRIVATE_KEY=//p' .dev.vars | npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.notifications.toml
sed -n 's/^VAPID_SUBJECT=//p' .dev.vars | npx wrangler secret put VAPID_SUBJECT --config wrangler.notifications.toml
npm run notifications:deploy
```

4. Pagesにも同じ `VAPID_PUBLIC_KEY` を設定して再デプロイする。
5. 娘のAndroid ChromeでPWAをホーム画面へ追加し、設定画面から通知を許可する。

VAPID鍵を変更すると既存の端末登録をやり直す必要があるため、通常は再生成しません。
通知Workerは5分ごとに起動し、日本時間の設定時刻を過ぎても当日の達成がない場合だけ、
登録端末へ1日1回送信します。親ページで通知のON/OFFと時刻を変更できます。
送信直前にも達成と最新の通知設定を再確認しますが、外部Pushサービスへの送信開始後に
達成した場合は通知を取り消せません。送信結果を確認できない通信障害では重複通知を避ける
ため再送しません。

ローカルでCronを起動する場合は、別ターミナルで次を実行します。

```bash
npm run notifications:dev
```
