# Fruit Truck

Fruit Truck 是一款通过 OpenRouter 生成图像和视频的 macOS 工作区。

- 根据模型能力显示请求字段并支持图像编辑
- 提示词增强默认值会立即应用到所有现有和新建线程
- 并行生成线程、视频状态跟踪和会话成本账本
- 使用单一素材库管理上传文件和生成结果

在 `apps/desktop` 中运行 `npm ci`、`npm run check`、`npm run test:unit` 和 `npm run test:e2e`。Playwright 以 1920×1080 无头模式运行。

macOS 发行包仅包含从 FFmpeg 项目源码构建的 `ffprobe`，不包含 `ffmpeg` 可执行文件。由于 FFprobe 属于 FFmpeg 项目，发行包仍保留 LGPL 声明。
