# Fruit Truck

https://github.com/user-attachments/assets/e1cce464-0311-46fa-ae96-fe360019dee2

Fruit Truck 是一款通过 OpenRouter 生成图像和视频的 macOS 工作区。

- 根据模型能力显示请求字段并支持图像编辑
- 提示词增强默认值会立即应用到所有现有和新建线程
- 并行生成线程、视频状态跟踪和会话成本账本
- 使用单一素材库管理上传文件和生成结果

## 支持范围

| 能力 | 端点 | 状态 |
| --- | --- | --- |
| 文生图和图像编辑 | `/api/v1/images` | 仅支持所选端点声明的能力 |
| 文生视频 | `/api/v1/videos` | 支持，并将任务状态保存在会话中 |
| 提示词增强 | `/api/v1/chat/completions` | 可选的规划请求，不是通用聊天 |
| 视频首帧和尾帧图像 | `/api/v1/videos` | 所选模型声明相应帧角色时支持；托管的本地图像使用 OpenRouter 的 media URL 请求协议 |
| 视频的通用图像/视频/音频参考 | `/api/v1/videos` | 仅支持所选端点或精确模型规则允许的类型、数量和传输方式 |
| 通用聊天、Responses、tool/function calling、TTS、STT、audio output、embeddings | 各类端点 | 本工作室未提供 |

模型出现在目录中并不代表所有 OpenRouter 端点都受支持。实时目录和端点规则
优先。公共视频目录并未提供每个模型的全部通用参考类型和数量，因此 Fruit
Truck 只用有文档依据的精确模型规则补充缺失字段，未知组合不会启用。

帧图像和通用参考不能混用，因为 OpenRouter 会优先处理 `frame_images`。
Veo 3.1 Standard 和 Fast 最多接受三张通用参考图像，且原生语义类型固定为
`asset`；Lite 不接受通用参考。样式或角色等用途仅写入提示词，不会成为
原生 `reference_type`。详见[支持矩阵](../SUPPORT.md)。

在 `apps/desktop` 中运行 `npm ci`、`npm run check`、`npm run test:unit` 和 `npm run test:e2e`。Playwright 以 1920×1080 无头模式运行。

macOS 发行包仅包含从 FFmpeg 项目源码构建的 `ffprobe`，不包含 `ffmpeg` 可执行文件。由于 FFprobe 属于 FFmpeg 项目，发行包仍保留 LGPL 声明。

API 密钥保存在本机，但生成时提示词和所选媒体会发送到 OpenRouter，并可能
转发给所选 downstream provider。启用提示词增强时，会先发送一次单独的规划
请求，可能产生费用。provider 的保留、训练和视频 ZDR 政策均适用；本地保存密钥不等于
在本地完成生成。
