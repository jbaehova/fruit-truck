# Fruit Truck

Fruit Truck은 OpenRouter를 통해 이미지와 영상을 생성하는 macOS 작업 공간입니다.

- 모델 기능에 맞춘 요청 필드와 이미지 편집
- 모든 기존·신규 스레드에 즉시 적용되는 프롬프트 향상 기본값
- 병렬 생성 스레드, 영상 상태 추적, 세션별 비용 원장
- 업로드와 생성 결과를 한곳에서 관리하는 에셋 라이브러리

## 지원 범위

| 기능 | 엔드포인트 | 상태 |
| --- | --- | --- |
| 텍스트-이미지와 이미지 편집 | `/api/v1/images` | 선택한 엔드포인트가 선언한 기능에 한해 지원 |
| 텍스트-비디오 | `/api/v1/videos` | 세션에 저장되는 작업 추적과 함께 지원 |
| 프롬프트 향상 | `/api/v1/chat/completions` | 선택적 플래너 요청이며 일반 채팅은 아님 |
| 영상 이미지/영상/오디오 참고 및 편집 | `/api/v1/videos` | 검증된 공개 HTTPS 또는 signed-upload 전송 경로가 생길 때까지 사용 불가 |
| 일반 채팅, Responses, tool/function calling, TTS, STT, audio output, embeddings | 여러 엔드포인트 | 이 스튜디오에서 제공하지 않음 |

카탈로그에 모델이 표시된다고 해서 모든 OpenRouter 엔드포인트가 지원되는
것은 아닙니다. 실시간 엔드포인트 메타데이터와 Fruit Truck 요청 검증기가
실제 경로를 결정합니다. 자세한 내용은 [지원 매트릭스](../SUPPORT.md)를
참조하세요.

개발 검증은 `apps/desktop`에서 다음 명령으로 실행합니다.

```sh
npm ci
npm run check
npm run test:unit
npm run test:e2e
```

Playwright는 기본 최대화 창과 같은 1920×1080 크기로 headless 실행됩니다.

macOS 배포판은 FFmpeg 프로젝트 소스에서 빌드한 `ffprobe`만 포함합니다. 일반 영상 입력의 메타데이터 확인에 사용하며, `ffmpeg` 실행 파일은 번들하지 않습니다. FFprobe가 FFmpeg 프로젝트 산출물이므로 LGPL 고지는 유지합니다.

API 키는 이 기기에 보관되지만 생성 시 프롬프트와 선택한 미디어는
OpenRouter 및 선택된 downstream provider로 전송될 수 있습니다. 프롬프트
향상을 켜면 별도의 플래너 요청이 먼저 전송되며 비용이 발생할 수 있습니다. provider의 보존,
학습, 영상 ZDR 정책이 적용되며 로컬 키 보관이 로컬 생성을 뜻하지는
않습니다.
