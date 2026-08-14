# Fruit Truck

Fruit Truck は、OpenRouter を通じて画像と動画を生成する macOS ワークスペースです。

- モデル機能に対応したリクエスト項目と画像編集
- 既存・新規の全スレッドへ即時適用されるプロンプト強化の既定値
- 並列生成スレッド、動画の状態追跡、セッション別コスト台帳
- アップロードと生成結果を管理する単一の Asset Library

`apps/desktop` で `npm ci`、`npm run check`、`npm run test:unit`、`npm run test:e2e` を実行して検証します。Playwright は 1920×1080 の headless モードで動作します。

macOS 配布物には FFmpeg プロジェクトからビルドした `ffprobe` のみを同梱します。`ffmpeg` 実行ファイルは同梱しません。FFprobe が FFmpeg の成果物であるため LGPL 表示は保持します。
