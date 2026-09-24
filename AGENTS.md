# AGENTS.md — まいにち学習スタンプ

家庭内の2台だけで使う学習習慣アプリ。娘が毎日の学習を記録し、達成で絵本風キャラクターが育つ。親は別ページで記録確認・小遣い目安・通知設定を管理する。

## 技術構成

- フロント: React 19 + Vite + TypeScript + vite-plugin-pwa（PWA）
- バックエンド: Cloudflare Pages Functions（`functions/`）+ D1(SQLite)
- 通知: 別Worker（`notifications/`、5分Cron + Web Push/VAPID）
- ドメイン計算は `shared/domain.ts` の純粋関数に集約し、フロント・Functions両方から使う

## コマンド

```bash
npm run dev          # Vite開発サーバ（UIのみ）
npm run pages:dev    # Functions + D1 込みの完全ローカル環境（推奨）
npm run db:migrate   # ローカルD1へマイグレーション適用
npm run typecheck    # tsc -b（app/worker/nodeの3プロジェクト参照）
npm run lint         # eslint .
npm test             # vitest run
npm run build        # tsc -b && vite build
npm run notifications:dev    # 通知WorkerのローカルCron起動（別ターミナル）
```

初回セットアップは README.md 参照（`.dev.vars` 作成、`generate:vapid`、`POST /api/setup` でPIN設定、家族キー発行）。

## コミット前に必須

`typecheck` → `lint` → `test` → `build` をすべて通すこと。

## プログラミング規約

- TypeScript strict。`any`・`as`キャストの多用は避け、`shared/domain.ts` の型を使う
- 日付・時刻はすべて `shared/domain.ts` のヘルパー（`localDateInTokyo` 等）で **Asia/Tokyo** 基準。`Date` を直接いじって日付境界を計算しない
- 達成判定・小遣い計算・連続日数など**ドメインルールは `shared/domain.ts` へ**。画面やハンドラ個別に再実装しない
- APIの追加・変更は `functions/lib/handlers.ts` と `functions/lib/types.ts` に揃える。型の二重定義を避け `shared/` へ置く
- React: 画面は `src/screens/`、再利用部品は `src/components/`、状態フックは `src/hooks/`。関数コンポーネント + hooks のみ
- UI文言・コメントは日本語で統一（利用者が子ども）
- テストは `tests/` に `<領域>.test.ts` で追加。ドメイン変更時は `domain.test.ts`、API変更時は `handlers.test.ts`/`api.test.ts` を必ず更新

## ドメイン不変ルール（変更にはユーザー確認が必要）

- **1日1回記録**: タイマー完走 or ワンタップ自己申告、同日重複は防止
- **小遣い**: 達成1日 = 単価 + 7日ごとボーナス。金額は履歴として確定し、単価変更で過去分を再計算しない
- **1日の境界**: Asia/Tokyo の 0:00–23:59。連続日数は途切れてよい（後日修正機能なし）
- **安全性は信頼ベース**: 娘側にロック等を追加しない。親ページのみ4桁PIN
- **個人情報最小限**: 名前・メール等を要求する設計にしない
- 通知は未達のみ1日1回。到達保証は求めない設計に留める

## DB・マイグレーション

- D1のスキーマ変更は `migrations/NNNN_name.sql` の**新規ファイル追加のみ**。既存マイグレーションを書き換えない・削除しない
- 達成記録・ルール変更履歴・支払い台帳は別テーブルのまま監査可能に保つ

## セキュリティ・秘密値

- 秘密値は `.dev.vars`（gitignore済み）と `wrangler secret` で管理。**リポジトリへコミット禁止**
- `BOOTSTRAP_TOKEN`・`PARENT_SESSION_SECRET`・VAPID鍵をログ出力・画面表示しない
- VAPID鍵は再生成しない（端末登録が無効化される）
