# Fruit Truck

Fruit Truck は、OpenRouter を通じて画像と動画を生成する macOS ワークスペースです。

- モデル機能に対応したリクエスト項目と画像編集
- 既存・新規の全スレッドへ即時適用されるプロンプト強化の既定値
- 並列生成スレッド、動画の状態追跡、セッション別コスト台帳
- アップロードと生成結果を管理する単一の Asset Library

## 対応範囲

| 機能 | エンドポイント | 状態 |
| --- | --- | --- |
| テキストから画像、画像編集 | `/api/v1/images` | 選択したエンドポイントが宣言する機能のみ対応 |
| テキストから動画 | `/api/v1/videos` | セッションに保存されるジョブ追跡に対応 |
| プロンプト強化 | `/api/v1/chat/completions` | 任意のプランナー要求。一般的なチャットではありません |
| 動画の画像/動画/音声リファレンスと編集 | `/api/v1/videos` | 検証済みの公開 HTTPS または signed-upload 転送が構成されるまで利用不可 |
| 一般チャット、Responses、tool/function calling、TTS、STT、audio output、embeddings | 各種 | このスタジオでは未提供 |

カタログにモデルが表示されても、すべての OpenRouter エンドポイントが
利用できるとは限りません。実際の対応ルートはライブのエンドポイント
メタデータと Fruit Truck のリクエスト検証で決まります。詳しくは
[対応マトリクス](../SUPPORT.md)を参照してください。

`apps/desktop` で `npm ci`、`npm run check`、`npm run test:unit`、`npm run test:e2e` を実行して検証します。Playwright は 1920×1080 の headless モードで動作します。

macOS 配布物には FFmpeg プロジェクトからビルドした `ffprobe` のみを同梱します。`ffmpeg` 実行ファイルは同梱しません。FFprobe が FFmpeg の成果物であるため LGPL 表示は保持します。

API キーはこの Mac に保存されますが、生成時にはプロンプトと選択した
メディアが OpenRouter および選択された downstream provider に送信される
場合があります。プロンプト強化を有効にすると、別のプランナー要求が
先に送信され、料金が発生する場合があります。provider の保持、学習、動画 ZDR ポリシーが適用される
ため、ローカルでのキー保存はローカル生成を意味しません。
