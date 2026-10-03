# AWS BuilderCards (2nd Edition) Webアプリ 設計ドラフト v2

## スコープ

- ルール: 日本語版第2版 (Ja_rules_2026.pdf 準拠)
- 対戦形式: **1人プレイ vs CPU (2人対戦)**
- ネット接続: **利用OK前提**。両プレイヤーのデプロイ解説をLLM (Google Gemini) で生成。ただしゲームエンジン自体はブラウザ内で完結させ、オフライン時はテンプレ解説にフォールバックして対戦自体は継続可能にする
- 置き場所: 既存リポジトリ `signallight-spec/Devin` 内 (例: `buildercards/` ディレクトリに独立したViteアプリとして追加)
- 対象外: ミッションカード (日本語版に未同梱)、コレクション用カード、3〜4人プレイ、上級ルール (builderリタイア/長期戦モード — v1では実装しないが後付け用の拡張ポイントを残す)
- 権利面: 個人・学習用途前提。公式のカード画像・テキストは転用せず、カード名と効果のみデータ化し独自UIで描画

## ゲームモデル

### カード構成

| 種別 | 内訳 |
|---|---|
| スターター (オンプレミス) カード | 各色10枚×4色: Bare Metal Host×3, Document Store, Networking, Data Warehouse, SAN, Corporate Identity Provider, Virtual Machine, Database Server |
| ビルダーカード | 91枚・36種。**日本語版と英語版で枚数配分が異なる** (日本語版ルールブックの内訳を採用)。コストあり/なしの分割は英語版準拠の推定 (6種15枚)。内訳は付録の全カード一覧参照 |
| Well-Architectedカード | 1pt×7 + 3pt×5 = 12枚 (山は1ptが上、上からしか取れない) |

### 状態

```
GameState {
  players: [{ resourcePile, hand, discardPile, waPile, retired }],
  console: { freeSlots[4], costSlot[1] },   // 同名カードはスタック
  decks: { freeBuilderDeck, costBuilderDeck, waDeck },
  turn: { player, phase, credits, adoptionsLeft, architectures[], usedCardSides },
}
```

### コンビネーションモデル (Builder's Guideline 準拠)

- カードは左右2辺を持ち、組み合わせは辺どうしの連結 (A↔B↔C のチェーン可)
- 「when combined with X」は1:1限定 — その接点は両カードで使用済みになる
- 「for every/each combination with…」と明記された効果のみ多対1で発動
- 「stacked with」はカードを重ねる特別な組み合わせ
- エンジンはデプロイを「カードの辺の接続グラフ」として扱い、各辺の使用状態を管理する

### ターン構造

1. **ビルドフェーズ**
   - ターン開始時・手札5枚のとき限り: builder > on-premises ならオンプレ1枚リタイア可 → そのターン最低1枚のcloud adoption必須
   - デプロイ: 手札から1枚以上を場に出す (単独デプロイ可、ただし「アーキテクチャ」は2枚以上)。コンボ効果はデプロイ済み構成内でのみ発動。デプロイ済みは分割不可・ターン中いつでも拡張可
   - 効果種別: `+nクレジット` / `+1ドロー(リソース山)` / `+1adoption` / `捨て札→山札トップ` / `効果使用後リタイア(夕日アイコン)`
2. **導入フェーズ** (cloud adoption)
   - 基本1ターン1枚 (+adoption効果で増)。コストなしbuilderは無料、コストあり/WAはクレジット消費
   - コストなしbuilderが不要なら山札から盲引き可 (拒否不可・捨て札へ)
   - 各取得の直後にコンソールを即リフィル (次のadoptionの選択肢が変わる)
   - WAは山の上からのみ。builder→捨て札、WA→専用場
3. **終了フェーズ**: 全カードを捨て札へ → 5枚ドロー。山札切れは捨て札シャッフルで再構成
4. **終了条件**: WA山が尽きる。同点ならbuilder枚数で決着

### オプションルール (v1対象外、拡張ポイントのみ確保)

- builderカードのリタイア (builder購入歴あり・そのターン使用済み不可・手札のみ)
- 全員同意のコンソールシャッフル (CPU対戦では常時許可)
- WAを捨て札に入れる長期戦モード
- **拡張ポイント**: エンジン初期化時に `GameConfig { rules: { builderRetire?: boolean, waIntoDiscard?: boolean, consoleShuffle?: boolean } }` を受ける形にし、リタイア処理・adoption後のWA移動先・山札再構成をフック可能に設計。v1は全フラグoffで出荷

## CPU設計

### 思考 (ヒューリスティック)

| 判断 | 方式 |
|---|---|
| デプロイ | 手札の部分集合+接続グラフを列挙 (5〜7枚なら実用的) → クレジット+効果価値で採点し最大を選択 |
| 導入 | 残りWA枚数とターン経過から動的にWA優先度を計算。3ptが買えれば優先。それ以外は「デッキへの期待効用」でbuilderを採点 |
| リタイア | 0クレジットのオンプレを削るデッキ圧縮として評価 |
| 難易度 | 採点ノイズ・WA優先度閾値で弱〜中を調整 |
| 将来の強化 | エンジンを純粋関数+シード付きRNGにしておけば、MCTS (ランダムプレイアウト) を後付け可能 |

### 解説 (AWS知識の披露) ★ユーザー要件

**両プレイヤー**のデプロイについてアーキテクチャを自然言語で説明する:

- **LLM生成 (メイン)**: Google Gemini (軽量モデル、Flash系想定)。デプロイ構成 (カード名+接続関係+発動効果) をプロンプトに入れ、「このアーキテクチャは何をするものか」「なぜこの組み合わせか」を生成。Cloudflare Pages Functions経由でAPIを呼ぶ (`GEMINI_API_KEY` はPagesの環境変数に設定しサーバー側に隠蔽)
- **テンプレ生成 (フォールバック)**: カードに `category` (スキーマの `Category` 値 = AWS公式カテゴリ名 + `other`) と `role` (短文) を持たせ、既知パターン辞書 (静的サイト配信=S3+CloudFront、サーバーレスAPI=API Gateway+Lambda+DynamoDB、3層=ELB+EC2+RDS、イベント駆動=SNS/SQS+Lambda 等) でマッチングして説明文を組み立てる。オフライン/LLM障害時はこちら
- プレイヤー側のデプロイにも同じ仕組みで「このアーキテクチャは…」と解説を付けられると学習効果が高い (要検討)

## カードデータ

- **データ源**: 枚数は日本語版ルールブック (Ja_rules_2026.pdf) の内訳を正とする — Zennの解析記事 (https://zenn.dev/issy/articles/zenn-aws-buildercards) の表は英語版の配分で、日本語版と7種で枚数が異なる (付録)。サービス名・AWS公式カテゴリ・基本クレジット・コスト種別は同記事から取得可能
- **残りの未確定要素**: 各カードに印刷された効果条件文 (+1ドロー/+1adoption/リタイア後効果がどのカードに付いているか、コンボの厳密な条件)。構成例から一部コンボ値は推定可能 (付録)
- **方針: 判明分は正確にデータ化、効果条件のみ暫定値で開発 → 実物到着後に確定版へ差し替え**
- スキーマ案:

```ts
type CardDef = {
  id: string;                    // "aws-lambda"
  name: string;                  // "AWS Lambda"
  kind: 'builder' | 'starter' | 'wa';
  cost: number | null;           // null = コストなし
  credits: number;               // デプロイ時の基本クレジット
  category: Category;            // compute | storage | ...
  effects: Effect[];             // 下記DSL
  // { type:'credits'|'draw'|'adoption'|'discardToTop'|'retireSelf',
  //   value?, condition?: { combinable: Category|cardId|'any', scope:'one'|'each', mode:'link'|'stack' } }
  role: string;                  // テンプレ解説用の短文 (例: 'サーバーレス関数実行')
  descriptionJa: string;         // 独自の解説文
};
```

- `category` はAWS公式のサービスカテゴリをそのまま採用 (compute / containers / storage / application integration / networking & content delivery / database / analytics / management & governance / security, identity & compliance / developer tools / cloud financial management / on-premises)。公式カテゴリを持たない AWS Marketplace 専用に `other` を1つ追加し、カテゴリを条件にするコンボ/テンプレ効果の対象外とする
- 効果の暫定データは、構成例から判明したコンボ値 (付録) と判明済みの例 (RDS↔computeで+2、IAM Identity Center↔Corporate Identity Providerで+adoption、Virtual Machine↔Bare Metal Hostで+1ドロー) を反映して作る

## 技術構成

- **フロント**: React + TypeScript + Vite (`buildercards/`)
- **ゲームエンジン**: 純粋TS (`buildercards/src/engine/`)。`reduce(state, action) → state`、シード付きRNG。UI非依存 → 単体テスト・CPU思考・将来のMCTSで再利用
- **バックエンド**: Cloudflare Pages Functions (`buildercards/functions/`) — LLMプロキシのみ。ゲーム進行に必須ではない
- **UI**: 中央=コンソール (5スロット+WA山)、手前=自分エリア、奥=CPUエリア (手札は裏)。デプロイはドラッグ/クリックでカードを並べて接続を宣言、右パネルに解説テキストと行動ログ
- **LLMプロバイダ**: Google Gemini (Flash系想定)。`GEMINI_API_KEY` をPagesの環境変数に設定 (キーはユーザーが用意)

## 作業分解案 (Issue単位)

1. カードデータスキーマ + カテゴリ体系定義 + 暫定データ (91枚+スターター)
2. ゲームエンジン (セットアップ/フェーズ遷移/効果解決/コンボ判定/終了判定) + 単体テスト
3. CPU思考 (ヒューリスティック) + 対局シミュレーション基盤
4. CPU解説 (LLMプロキシ + テンプレフォールバック)
5. UI (盤面・デプロイ操作・コンソール・解説パネル・ログ)
6. 統合 + 対局フロー完成

## 付録: 全カード一覧 (Zenn記事から収集)

枚数は**日本語版ルールブックの内訳** (英語版との差分: API Gateway 3←2, CloudWatch 3←2, EC2 Auto Scaling 3←2, CDK 4←3, DynamoDB 2←3, IAM Identity Center 2←4, Systems Manager 2←3)。コストあり/なしの分割とカテゴリ・基本クレジットはZenn記事 (英語版準拠) より。

コストなし (76枚 / 30種):

| サービス | 枚数 | カテゴリ | 基本クレジット |
|---|---|---|---|
| Amazon EC2 | 8 | compute | 2 |
| AWS Lambda | 6 | compute | 1 |
| AWS Fargate | 2 | containers | 3 |
| Amazon ECS | 2 | containers | 2 |
| Amazon EKS | 2 | containers | 2 |
| Amazon S3 | 4 | storage | 2 |
| Amazon EFS | 2 | storage | 2 |
| Amazon SNS | 3 | application integration | 2 |
| Amazon SQS | 3 | application integration | 2 |
| Amazon EventBridge | 2 | application integration | 2 |
| AWS Step Functions | 2 | application integration | 1 |
| Amazon API Gateway | 3 | application integration | 1 |
| Amazon Route 53 | 2 | networking & content delivery | 2 |
| Amazon VPC | 2 | networking & content delivery | 2 |
| Elastic Load Balancing | 2 | networking & content delivery | 2 |
| Amazon CloudFront | 2 | networking & content delivery | 2 |
| Amazon RDS | 2 | database | 2 |
| Amazon Aurora | 2 | database | 2 |
| Amazon DynamoDB | 2 | database | 2 |
| Amazon ElastiCache | 2 | database | 2 |
| Amazon Kinesis Data Streams | 2 | analytics | 2 |
| Amazon Data Firehose | 2 | analytics | 2 |
| Amazon Redshift | 2 | analytics | 2 |
| Amazon Athena | 2 | analytics | 2 |
| Amazon OpenSearch Service | 2 | analytics | 2 |
| AWS CloudTrail | 2 | management & governance | 2 |
| Amazon CloudWatch | 3 | management & governance | 2 |
| AWS IAM Identity Center | 2 | security, identity & compliance | 2 |
| Amazon CodeCatalyst | 2 | developer tools | 2 |
| AWS Marketplace | 2 | other | 1 |

コストあり (15枚 / 6種):

| サービス | 枚数 | カテゴリ | 基本クレジット |
|---|---|---|---|
| Amazon EC2 Auto Scaling | 3 | compute | 2 |
| AWS CDK | 4 | developer tools | 1 |
| AWS CloudFormation | 2 | management & governance | 2 |
| AWS Systems Manager | 2 | management & governance | 2 |
| AWS Well-Architected Tool | 2 | management & governance | 1 |
| Cloud Financial Management | 2 | cloud financial management | 2 |

構成例から推定されるコンボ値 (暫定): API Gateway 1+1, DynamoDB 2+2, EventBridge 2+2, SQS 2+2, SNS 2+2, ELB 2+2, RDS 2+2, EC2 Auto Scaling 2+4, Aurora 2+1, ElastiCache 2+2, Step Functions 1+2, CloudWatch 2+4, Redshift 2+2。スターターのコンボ: VM+Bare Metal Host→+1ドロー、Corporate IdP+IAM Identity Center→+1adoption

## 決定事項

1. LLMプロバイダ: **Google Gemini** (APIキーはユーザーが用意 → `GEMINI_API_KEY`)
2. 上級ルール (builderリタイア/長期戦モード): **v1対象外**。拡張ポイントのみ残す (オプションルール節参照)
3. 解説生成: **両プレイヤーのデプロイに付ける**
