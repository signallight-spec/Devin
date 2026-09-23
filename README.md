# まいにち学習スタンプ

家庭の2台だけで使う、React + Cloudflare Pages Functions + D1 の学習習慣アプリです。

## ローカル起動

```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate
npm run pages:dev
```

初回だけ `POST /api/setup` に `.dev.vars` の `BOOTSTRAP_TOKEN` を
`X-Bootstrap-Token` ヘッダーとして付け、4桁PINを設定します。
画面の「初めての1台を設定する」からも実行できます。完了時に1回だけ表示される
家族キーを保存し、もう1台の初期画面へ入力してください。

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
5. `BOOTSTRAP_TOKEN` と `PARENT_SESSION_SECRET` をSecretとして設定する。
6. ビルドコマンドを `npm run build`、出力先を `dist` にする。
