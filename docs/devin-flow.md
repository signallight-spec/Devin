# Devinのエージェント連鎖

Devinセッションで実際に動くエージェント/実行体と、その連鎖の流れ。
2026-09-24時点の調査メモ。

## 登場するエージェント

| 名前 | 役割 |
|---|---|
| メインエージェント | チャットを受けるセッション本体。VM上でコード編集・shell・PR作成まで行う |
| サブエージェント | メインが同一VM内にspawnする下請け（フォアグラウンド/バックグラウンド）。完了時に報告だけ返る |
| テストエージェント | サブエージェントの常設版。UI駆動テストと画面録画専門。ユーザー対話・git書き込み権限なし |
| 子セッション | 独立した完全なDevin（別VM）。並列タスクやワークフロー向け |
| Devin Review | セッション外の独立パイプライン。PRイベントで起動し、指摘をPRコメントとして投稿 |

※ 自動でPRをマージする「受理エージェント」は存在しない。マージは人間（またはGitHubのauto-merge設定）が行う。

## シーケンス図

```mermaid
sequenceDiagram
    autonumber
    actor U as ユーザー
    participant M as メインエージェント<br/>(チャット)
    participant SA as サブ/テスト<br/>エージェント(同一VM)
    participant C as 子セッション<br/>(別VM)
    participant GH as GitHub PR
    participant R as Devin Review<br/>(独立パイプライン)
    participant CI as CI

    U->>M: メッセージ
    par 並列委譲
        M->>SA: 調査・UIテスト依頼
        SA-->>M: 結果レポート
        M->>C: 大きな並列タスク
        C-->>M: 完了通知+成果物
    end
    M->>GH: push & PR作成
    GH->>R: PRイベントで自動起動
    R->>GH: 指摘コメント投稿
    R-->>M: 指摘がセッションに通知
    GH->>CI: CI実行
    CI-->>M: 失敗通知
    M->>GH: 修正push(指摘対応・CI修正ループ)
    Note over U,GH: 全チェック通過後、人間がマージ
```

## 注釈

- **このリポジトリはCI(GitHub Actions)をまだ導入していない。** 図の `GH->>CI` → `CI-->>M` の部分は、`.github/workflows/ci.yml` を置いた場合の一般的な流れ。現状はDevinセッション内で `typecheck`/`lint`/`test`/`build` を手動実行している（AGENTS.mdの「コミット前に必須」参照）
- **Devin Reviewが組織設定で有効な場合のみ**、図の `GH->>R` 以降が動く。無効ならレビュー指摘のループも存在しない
- サブ/テストエージェントはメインエージェントが必要に応じて呼ぶ使い捨て/常駐の手足。セッション内に常時存在するわけではない
