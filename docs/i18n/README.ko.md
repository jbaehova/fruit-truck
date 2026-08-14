# Fruit Truck

Fruit Truck은 OpenRouter를 통해 이미지와 영상을 생성하는 macOS 작업 공간입니다.

- 모델 기능에 맞춘 요청 필드와 이미지 편집
- 모든 기존·신규 스레드에 즉시 적용되는 프롬프트 향상 기본값
- 병렬 생성 스레드, 영상 상태 추적, 세션별 비용 원장
- 업로드와 생성 결과를 한곳에서 관리하는 에셋 라이브러리

개발 검증은 `apps/desktop`에서 다음 명령으로 실행합니다.

```sh
npm ci
npm run check
npm run test:unit
npm run test:e2e
```

Playwright는 기본 최대화 창과 같은 1920×1080 크기로 headless 실행됩니다.

macOS 배포판은 FFmpeg 프로젝트 소스에서 빌드한 `ffprobe`만 포함합니다. 일반 영상 입력의 메타데이터 확인에 사용하며, `ffmpeg` 실행 파일은 번들하지 않습니다. FFprobe가 FFmpeg 프로젝트 산출물이므로 LGPL 고지는 유지합니다.
