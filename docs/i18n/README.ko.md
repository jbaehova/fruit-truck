# Fruit Truck

https://github.com/user-attachments/assets/e1cce464-0311-46fa-ae96-fe360019dee2

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
| 영상 첫/마지막 프레임 이미지 | `/api/v1/videos` | 선택한 모델이 해당 프레임 역할을 선언할 때 지원하며, 관리 중인 로컬 이미지는 OpenRouter의 media URL 요청 규격을 사용 |
| 영상의 일반 이미지/영상/오디오 레퍼런스 | `/api/v1/videos` | 선택한 엔드포인트 또는 정확한 모델 규칙이 허용하는 종류, 개수, 전송 방식에 한해 지원 |
| 일반 채팅, Responses, tool/function calling, TTS, STT, audio output, embeddings | 여러 엔드포인트 | 이 스튜디오에서 제공하지 않음 |

카탈로그에 모델이 표시된다고 해서 모든 OpenRouter 엔드포인트가 지원되는
것은 아닙니다. 실시간 카탈로그와 엔드포인트 규칙을 우선 적용합니다. 공개
영상 카탈로그가 모델별 일반 레퍼런스 종류와 개수를 모두 제공하지 않으므로,
비어 있는 항목만 문서로 확인된 정확한 모델 규칙으로 보완합니다. 확인되지
않은 조합은 활성화하지 않습니다.

프레임 이미지와 일반 레퍼런스는 함께 보낼 수 없습니다. OpenRouter가 둘 다
받으면 `frame_images`를 우선하므로 혼합 요청은 제출 전에 차단합니다. Veo 3.1
Standard와 Fast의 일반 레퍼런스는 최대 3개이며 모두 고정된 네이티브 `asset`
타입입니다. Lite는 일반 레퍼런스를 받지 않습니다. 스타일이나 캐릭터 같은
용도 지정은 프롬프트에만 반영되며 네이티브 `reference_type`이 되지 않습니다.
자세한 내용은 [지원 매트릭스](../SUPPORT.md)를 참조하세요.

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
