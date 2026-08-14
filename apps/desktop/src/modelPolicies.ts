import type { DraftOptions, GenerationMode, GenerationModel, ReferenceRole, VideoModel } from "./openrouter.ts";

export type InputMediaKind = "image" | "video" | "audio";
export type FacePresence = "present" | "absent" | "unknown";

export type PolicySource = {
  label: string;
  url: string;
  reviewedAt: string;
};

type MediaInputPolicy = {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  minRatio?: number;
  maxRatio?: number;
  maxBytes?: number;
  maxFps?: number;
  allowedMimeTypes?: string[];
  allowedCodecs?: string[];
};

export type VideoInputPolicy = {
  references: Partial<Record<InputMediaKind, number>>;
  combination: "exclusive" | "frame_wins" | "allow";
  totalReferenceLimit?: number;
  audioRequiresVisual?: boolean;
  audioRequiresImage?: boolean;
  referenceAudioDuration?: { min?: number; max?: number; totalMax?: number };
  referenceVideoDuration?: { min?: number; max?: number; totalMax?: number };
  referenceResolutionCap?: string;
  image?: MediaInputPolicy;
  video?: MediaInputPolicy;
  audio?: MediaInputPolicy;
  sources: PolicySource[];
};

const OPENROUTER_VIDEO_SOURCE: PolicySource = {
  label: "OpenRouter video generation",
  url: "https://openrouter.ai/docs/guides/overview/multimodal/video-generation",
  reviewedAt: "2026-08-13",
};
const OPENROUTER_CREATE_SOURCE: PolicySource = {
  label: "OpenRouter video request API",
  url: "https://openrouter.ai/docs/api/api-reference/video-generation/create-videos",
  reviewedAt: "2026-08-13",
};
const BYTEPLUS_SEEDANCE_SOURCE: PolicySource = {
  label: "BytePlus Seedance 2.0 API",
  url: "https://docs.byteplus.com/en/docs/modelark/1520757",
  reviewedAt: "2026-08-13",
};
const RUNWAY_INPUT_SOURCE: PolicySource = {
  label: "Runway input parameters",
  url: "https://docs.dev.runwayml.com/assets/inputs/",
  reviewedAt: "2026-08-13",
};
const RUNWAY_CHANGELOG_SOURCE: PolicySource = {
  label: "Runway API changelog",
  url: "https://docs.dev.runwayml.com/api-details/api_changelog/",
  reviewedAt: "2026-08-13",
};
const GOOGLE_VEO_SOURCE: PolicySource = {
  label: "Google Veo reference guide",
  url: "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/use-reference-images-to-guide-video-generation",
  reviewedAt: "2026-08-13",
};

const RUNWAY_IMAGE_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const RUNWAY_VIDEO_CODECS = ["h264", "hevc", "av1", "vp8", "vp9", "prores", "mpeg2video", "mjpeg", "theora", "flv1", "msmpeg4v3"];
const RUNWAY_AUDIO_CODECS = ["mp3", "aac", "flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le"];

const DEFAULT_POLICY: VideoInputPolicy = {
  references: {},
  combination: "frame_wins",
  sources: [OPENROUTER_VIDEO_SOURCE],
};

const VIDEO_POLICIES: Array<{ test: (modelId: string) => boolean; policy: VideoInputPolicy }> = [
  {
    test: (id) => /^bytedance\/seedance-2\.0(?:$|-)/.test(id),
    policy: {
      references: { image: 9, video: 3, audio: 3 },
      combination: "exclusive",
      totalReferenceLimit: 15,
      audioRequiresVisual: true,
      referenceVideoDuration: { min: 2, max: 15, totalMax: 15 },
      image: { minWidth: 300, minHeight: 300, maxWidth: 6000, maxHeight: 6000, minRatio: .4, maxRatio: 2.5, maxBytes: 30 * 1024 * 1024, allowedMimeTypes: RUNWAY_IMAGE_MIME },
      video: { minWidth: 300, minHeight: 300, maxWidth: 6000, maxHeight: 6000, minRatio: .4, maxRatio: 2.5, maxBytes: 200 * 1024 * 1024 },
      sources: [BYTEPLUS_SEEDANCE_SOURCE, OPENROUTER_CREATE_SOURCE],
    },
  },
  {
    test: (id) => id === "bytedance/seedance-2.5",
    policy: {
      references: { image: 30, video: 10, audio: 10 },
      combination: "exclusive",
      totalReferenceLimit: 50,
      audioRequiresVisual: true,
      referenceVideoDuration: { totalMax: 30 },
      referenceAudioDuration: { totalMax: 30 },
      image: { minRatio: .4, maxRatio: 4, allowedMimeTypes: RUNWAY_IMAGE_MIME },
      video: { minHeight: 480, allowedCodecs: RUNWAY_VIDEO_CODECS },
      audio: { allowedCodecs: RUNWAY_AUDIO_CODECS },
      sources: [RUNWAY_CHANGELOG_SOURCE, RUNWAY_INPUT_SOURCE, OPENROUTER_CREATE_SOURCE],
    },
  },
  {
    test: (id) => id === "minimax/hailuo-3",
    policy: {
      references: { image: 9, video: 1, audio: 1 },
      combination: "exclusive",
      audioRequiresImage: true,
      image: { minRatio: .2, maxRatio: 4, allowedMimeTypes: RUNWAY_IMAGE_MIME },
      video: { allowedCodecs: RUNWAY_VIDEO_CODECS },
      audio: { allowedCodecs: RUNWAY_AUDIO_CODECS },
      sources: [RUNWAY_INPUT_SOURCE, RUNWAY_CHANGELOG_SOURCE],
    },
  },
  {
    test: (id) => id === "x-ai/grok-imagine-video-1.5",
    policy: {
      references: { image: 7, audio: 3 },
      combination: "exclusive",
      audioRequiresImage: true,
      referenceAudioDuration: { min: 3, max: 15 },
      referenceResolutionCap: "720p",
      image: { allowedMimeTypes: RUNWAY_IMAGE_MIME },
      audio: { allowedCodecs: RUNWAY_AUDIO_CODECS },
      sources: [RUNWAY_INPUT_SOURCE, RUNWAY_CHANGELOG_SOURCE],
    },
  },
  {
    test: (id) => id === "runway/aleph-2",
    policy: {
      references: { image: 5, video: 1 },
      combination: "allow",
      referenceVideoDuration: { min: 2, max: 30 },
      video: { maxHeight: 1080, maxFps: 30, allowedCodecs: RUNWAY_VIDEO_CODECS },
      sources: [RUNWAY_INPUT_SOURCE, RUNWAY_CHANGELOG_SOURCE],
    },
  },
  {
    test: (id) => id === "black-forest-labs/flux-3-video",
    policy: { references: { video: 1 }, combination: "exclusive", sources: [OPENROUTER_VIDEO_SOURCE] },
  },
  {
    test: (id) => id === "runway/gen-4.5",
    policy: { references: {}, combination: "frame_wins", image: { minRatio: .5, maxRatio: 2, allowedMimeTypes: RUNWAY_IMAGE_MIME }, sources: [RUNWAY_INPUT_SOURCE] },
  },
  {
    test: (id) => id === "alibaba/wan-2.7",
    policy: { references: { image: 3 }, combination: "frame_wins", sources: [OPENROUTER_VIDEO_SOURCE] },
  },
  {
    test: (id) => id === "alibaba/wan-2.6",
    policy: { references: { video: 1, audio: 1 }, combination: "allow", audioRequiresVisual: true, sources: [OPENROUTER_VIDEO_SOURCE] },
  },
  {
    test: (id) => /^alibaba\/happyhorse-1\./.test(id),
    policy: { references: { image: 4 }, combination: "exclusive", image: { minWidth: 300, minHeight: 300, minRatio: .55, maxRatio: 1.8, allowedMimeTypes: RUNWAY_IMAGE_MIME }, sources: [RUNWAY_INPUT_SOURCE, OPENROUTER_VIDEO_SOURCE] },
  },
  {
    test: (id) => id === "x-ai/grok-imagine-video",
    policy: { references: { image: 1 }, combination: "exclusive", sources: [OPENROUTER_VIDEO_SOURCE] },
  },
  {
    test: (id) => id === "minimax/hailuo-2.3",
    policy: { references: { image: 1 }, combination: "exclusive", sources: [OPENROUTER_VIDEO_SOURCE] },
  },
  {
    test: (id) => /^google\/veo-3\.1/.test(id),
    policy: { references: { image: 3 }, combination: "frame_wins", image: { minRatio: .5, maxRatio: 2, allowedMimeTypes: ["image/jpeg", "image/png"] }, sources: [OPENROUTER_VIDEO_SOURCE, GOOGLE_VEO_SOURCE] },
  },
  {
    test: (id) => id === "openai/sora-2-pro",
    policy: { references: { image: 1 }, combination: "frame_wins", sources: [OPENROUTER_VIDEO_SOURCE] },
  },
];

export function videoInputPolicy(modelId: string): VideoInputPolicy {
  return VIDEO_POLICIES.find((entry) => entry.test(modelId))?.policy ?? DEFAULT_POLICY;
}

export function isSeedance20Model(modelId: string): boolean {
  return /^bytedance\/seedance-2\.0(?:$|-)/.test(modelId);
}

export function applyKnownVideoCapabilities(model: VideoModel): VideoModel {
  const policy = videoInputPolicy(model.id);
  const declared = new Set(model.input_reference_types ?? []);
  for (const [kind, limit] of Object.entries(policy.references)) {
    if ((limit ?? 0) > 0) declared.add(kind as InputMediaKind);
  }
  return {
    ...model,
    input_reference_types: declared.size ? [...declared] : model.input_reference_types,
    max_input_references: model.max_input_references ?? policy.references.image ?? null,
  };
}

export type PolicyNotice = {
  code: "seedance_real_person" | "veo_person_generation" | "sora_person_policy" | "sora_deprecation" | "runway_moderation" | "video_retention";
  severity: "warning" | "info";
  sources: PolicySource[];
};

const OPENAI_SORA_SOURCE: PolicySource = {
  label: "OpenAI Sora video guide",
  url: "https://developers.openai.com/api/docs/guides/video-generation",
  reviewedAt: "2026-08-13",
};
const RUNWAY_MODERATION_SOURCE: PolicySource = {
  label: "Runway moderation system",
  url: "https://docs.dev.runwayml.com/api-details/moderation/",
  reviewedAt: "2026-08-13",
};

export function modelPolicyNotices(mode: GenerationMode, model: GenerationModel | null): PolicyNotice[] {
  if (mode !== "video" || !model) return [];
  const notices: PolicyNotice[] = [];
  if (isSeedance20Model(model.id)) notices.push({ code: "seedance_real_person", severity: "warning", sources: [BYTEPLUS_SEEDANCE_SOURCE] });
  if (model.id.startsWith("google/veo-")) notices.push({ code: "veo_person_generation", severity: "warning", sources: [GOOGLE_VEO_SOURCE] });
  if (model.id === "openai/sora-2-pro") {
    notices.push({ code: "sora_person_policy", severity: "warning", sources: [OPENAI_SORA_SOURCE] });
    notices.push({ code: "sora_deprecation", severity: "warning", sources: [OPENAI_SORA_SOURCE] });
  }
  if (model.id.startsWith("runway/")) notices.push({ code: "runway_moderation", severity: "warning", sources: [RUNWAY_MODERATION_SOURCE] });
  notices.push({ code: "video_retention", severity: "info", sources: [OPENROUTER_VIDEO_SOURCE] });
  return notices;
}

export type InputAssetFacts = {
  role: ReferenceRole;
  slot: number;
  kind: InputMediaKind;
  byteSize?: number;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  mimeType?: string;
  codec?: string;
  facePresence?: FacePresence;
};

export type InputConstraintCode =
  | "unsupported_reference" | "too_many_inputs" | "mixed_input_styles" | "frame_inputs_ignored"
  | "duplicate_first_frame" | "duplicate_last_frame" | "frame_requires_image" | "audio_requires_visual" | "audio_requires_image"
  | "media_too_large" | "unsupported_media_format" | "unsupported_media_codec" | "dimensions_too_small" | "dimensions_too_large" | "aspect_ratio_unsupported"
  | "duration_too_short" | "duration_too_long" | "combined_duration_too_long" | "fps_too_high"
  | "resolution_with_references" | "frames_will_crop" | "real_person_blocked" | "face_check_unavailable";

export type InputConstraint = {
  code: InputConstraintCode;
  severity: "error" | "warning";
  slot?: number;
  limit?: number;
  value?: number | string;
  source?: PolicySource;
};

function sizePolicy(policy: VideoInputPolicy, kind: InputMediaKind) {
  return kind === "image" ? policy.image : kind === "video" ? policy.video : policy.audio;
}

export function assessInputConstraints({
  references,
  allowedRoles,
  limit,
  referenceLimit,
  mode,
  modelId = "",
  options = {},
}: {
  references: InputAssetFacts[];
  allowedRoles: ReferenceRole[];
  limit: number;
  referenceLimit?: number;
  mode: GenerationMode;
  modelId?: string;
  options?: DraftOptions;
}): InputConstraint[] {
  const issues: InputConstraint[] = [];
  const unsupported = references.find((reference) => !allowedRoles.includes(reference.role));
  if (unsupported) issues.push({ code: "unsupported_reference", severity: "error", slot: unsupported.slot });
  if (references.length > limit) issues.push({ code: "too_many_inputs", severity: "error", limit });
  if (mode !== "video") return issues;

  const policy = videoInputPolicy(modelId);
  const general = references.filter((reference) => reference.role === "reference");
  for (const kind of ["image", "video", "audio"] as const) {
    const count = general.filter((reference) => reference.kind === kind).length;
    const kindLimit = policy.references[kind];
    if (kindLimit != null && count > kindLimit) issues.push({ code: "too_many_inputs", severity: "error", limit: kindLimit, value: kind });
  }
  if (referenceLimit != null && general.filter((reference) => reference.kind === "image").length > referenceLimit) {
    issues.push({ code: "too_many_inputs", severity: "error", limit: referenceLimit, value: "image" });
  }
  if (policy.totalReferenceLimit != null && general.length > policy.totalReferenceLimit) {
    issues.push({ code: "too_many_inputs", severity: "error", limit: policy.totalReferenceLimit });
  }

  const frames = references.filter((reference) => reference.role === "first_frame" || reference.role === "last_frame");
  const nonImageFrame = frames.find((reference) => reference.kind !== "image");
  if (nonImageFrame) issues.push({ code: "frame_requires_image", severity: "error", slot: nonImageFrame.slot });
  if (general.length && frames.length) {
    if (policy.combination === "exclusive") issues.push({ code: "mixed_input_styles", severity: "error" });
    if (policy.combination === "frame_wins") issues.push({ code: "mixed_input_styles", severity: "error" });
  }
  if (frames.filter((reference) => reference.role === "first_frame").length > 1) issues.push({ code: "duplicate_first_frame", severity: "error" });
  if (frames.filter((reference) => reference.role === "last_frame").length > 1) issues.push({ code: "duplicate_last_frame", severity: "error" });

  if (policy.audioRequiresVisual && general.some((reference) => reference.kind === "audio") && !general.some((reference) => reference.kind !== "audio")) {
    issues.push({ code: "audio_requires_visual", severity: "error" });
  }
  if (policy.audioRequiresImage && general.some((reference) => reference.kind === "audio") && !general.some((reference) => reference.kind === "image")) {
    issues.push({ code: "audio_requires_image", severity: "error" });
  }
  for (const reference of references) {
    const spec = sizePolicy(policy, reference.kind);
    const bridgeLimit = 30 * 1024 * 1024;
    const effectiveByteLimit = Math.min(bridgeLimit, spec?.maxBytes ?? bridgeLimit);
    if (reference.byteSize && reference.byteSize > effectiveByteLimit) issues.push({ code: "media_too_large", severity: "error", slot: reference.slot, limit: effectiveByteLimit });
    if (reference.mimeType && spec?.allowedMimeTypes && !spec.allowedMimeTypes.includes(reference.mimeType.toLowerCase())) {
      issues.push({ code: "unsupported_media_format", severity: "error", slot: reference.slot, value: reference.mimeType });
    }
    if (reference.codec && spec?.allowedCodecs && !spec.allowedCodecs.includes(reference.codec.toLowerCase())) {
      issues.push({ code: "unsupported_media_codec", severity: "error", slot: reference.slot, value: reference.codec });
    }
    if (reference.width && reference.height && spec) {
      if ((spec.minWidth && reference.width < spec.minWidth) || (spec.minHeight && reference.height < spec.minHeight)) issues.push({ code: "dimensions_too_small", severity: "error", slot: reference.slot });
      if ((spec.maxWidth && reference.width > spec.maxWidth) || (spec.maxHeight && reference.height > spec.maxHeight)) issues.push({ code: "dimensions_too_large", severity: "error", slot: reference.slot });
      const ratio = reference.width / reference.height;
      if ((spec.minRatio && ratio < spec.minRatio) || (spec.maxRatio && ratio > spec.maxRatio)) issues.push({ code: "aspect_ratio_unsupported", severity: "error", slot: reference.slot, value: ratio.toFixed(2) });
    }
    if (reference.role !== "reference") continue;
    const durationSpec = reference.kind === "video" ? policy.referenceVideoDuration : reference.kind === "audio" ? policy.referenceAudioDuration : undefined;
    if (reference.duration != null && durationSpec?.min != null && reference.duration < durationSpec.min) issues.push({ code: "duration_too_short", severity: "error", slot: reference.slot, limit: durationSpec.min });
    if (reference.duration != null && durationSpec?.max != null && reference.duration > durationSpec.max) issues.push({ code: "duration_too_long", severity: "error", slot: reference.slot, limit: durationSpec.max });
    const videoSpec = reference.kind === "video" ? policy.video : undefined;
    if (reference.fps != null && videoSpec?.maxFps != null && reference.fps > videoSpec.maxFps) issues.push({ code: "fps_too_high", severity: "error", slot: reference.slot, limit: videoSpec.maxFps });
  }
  for (const [kind, spec] of [["video", policy.referenceVideoDuration], ["audio", policy.referenceAudioDuration]] as const) {
    const total = general.filter((reference) => reference.kind === kind).reduce((sum, reference) => sum + (reference.duration ?? 0), 0);
    if (spec?.totalMax != null && total > spec.totalMax) issues.push({ code: "combined_duration_too_long", severity: "error", limit: spec.totalMax, value: kind });
  }
  const resolutionHeight = (value: unknown) => {
    const normalized = String(value ?? "").toLowerCase();
    if (normalized === "4k") return 2160;
    if (normalized === "2k") return 1440;
    if (normalized === "1k") return 1080;
    return Number(normalized.match(/(\d+)p/)?.[1] ?? 0);
  };
  if (general.length && policy.referenceResolutionCap && resolutionHeight(options.resolution) > resolutionHeight(policy.referenceResolutionCap)) {
    issues.push({ code: "resolution_with_references", severity: "error", value: policy.referenceResolutionCap });
  }
  const first = frames.find((reference) => reference.role === "first_frame" && reference.width && reference.height);
  const last = frames.find((reference) => reference.role === "last_frame" && reference.width && reference.height);
  if (first?.width && first.height && last?.width && last.height && Math.abs(first.width / first.height - last.width / last.height) > .02) {
    issues.push({ code: "frames_will_crop", severity: "warning", slot: last.slot });
  }

  const blocksFaces = isSeedance20Model(modelId) || modelId === "openai/sora-2-pro";
  if (blocksFaces) {
    const face = references.find((reference) => reference.kind === "image" && reference.facePresence === "present");
    if (face) issues.push({ code: "real_person_blocked", severity: "error", slot: face.slot });
    else if (references.some((reference) => reference.kind === "image" && reference.facePresence === "unknown")) issues.push({ code: "face_check_unavailable", severity: "warning" });
  }
  return issues.filter((issue, index, values) => values.findIndex((candidate) => candidate.code === issue.code && candidate.slot === issue.slot && candidate.value === issue.value) === index);
}

export function validateInputConstraints(input: Parameters<typeof assessInputConstraints>[0]): InputConstraint | null {
  return assessInputConstraints(input).find((issue) => issue.severity === "error") ?? null;
}

export type ExplainedGenerationError = {
  code: "seedance_real_person" | "person_policy" | "copyright_policy" | "content_policy" | "input_combination"
    | "invalid_parameter" | "unsupported_parameter" | "model_unavailable" | "image_too_large" | "image_too_small"
    | "invalid_image" | "invalid_media" | "image_download" | "authentication" | "account_restricted" | "payment"
    | "quota" | "rate_limit" | "zdr_routing" | "provider_capacity" | "server" | "timeout" | "unknown";
  message: string;
  action: string;
  technical: string;
};

function compactTechnicalError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutPrefix = raw.replace(/^Error:\s*/, "").trim();
  const jsonStart = withoutPrefix.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(withoutPrefix.slice(jsonStart)) as { error?: { message?: string; code?: string | number; metadata?: { error_type?: string; provider_code?: string; reasons?: unknown } }; message?: string };
      const provider = parsed.error;
      return [provider?.message ?? parsed.message, provider?.metadata?.error_type, provider?.metadata?.provider_code, provider?.code, provider?.metadata?.reasons ? JSON.stringify(provider.metadata.reasons) : undefined]
        .filter((value) => value != null && String(value).trim()).map(String)
        .filter((value, index, values) => values.indexOf(value) === index).join(" · ").slice(0, 1200) || withoutPrefix.slice(0, 1200);
    } catch { /* Preserve non-JSON provider responses. */ }
  }
  return withoutPrefix.slice(0, 1200);
}

export function explainGenerationError(error: unknown, { modelId = "", language = "en" }: { modelId?: string; language?: "en" | "ko" } = {}): ExplainedGenerationError {
  const technical = compactTechnicalError(error);
  const value = technical.toLowerCase();
  const ko = language === "ko";
  const result = (code: ExplainedGenerationError["code"], en: string, actionEn: string, kr: string, actionKo: string) => ({ code, message: ko ? kr : en, action: ko ? actionKo : actionEn, technical });
  const policy = /content.?policy|content.?filter|moderation|moderated|safety|unsafe|flagged|violat|sensitive|risk.?control|responsible.?ai|refusal|policy_violation/.test(value);
  const face = /public.?figure|celebrity|identity|likeness|real.?person|real.?human|human.?face|face.?contain|person.?generation|portrait|child|minor/.test(value);

  if (isSeedance20Model(modelId) && policy && face) return result("seedance_real_person", "Seedance 2.0 rejected a real-person or portrait input.", "Remove human faces, or use an authorized trusted portrait asset or another compatible model.", "Seedance 2.0이 실제 인물 또는 얼굴 입력을 거절했습니다.", "사람 얼굴을 제거하거나 인증된 신뢰 인물 자산 또는 다른 호환 모델을 사용하세요.");
  if (face) return result("person_policy", "The provider rejected a real-person, likeness, or age-related request.", "Remove the likeness, use an adult or authorized asset where permitted, or choose a compatible model.", "실제 인물, 인물 유사성 또는 연령 정책에 따라 요청이 거절되었습니다.", "인물 유사성을 제거하거나 허용되는 성인·인증 자산 또는 호환 모델을 사용하세요.");
  if (/copyright|copyrighted|trademark|music rights|character rights/.test(value)) return result("copyright_policy", "The provider rejected copyrighted or trademarked material.", "Remove or replace protected characters, music, logos, or other material you do not have permission to use.", "저작권 또는 상표권 관련 소재가 거절되었습니다.", "사용 권한이 없는 캐릭터·음악·로고 등의 보호 소재를 제거하거나 교체하세요.");
  if (policy) return result("content_policy", "The provider's content policy blocked this request or output.", "Review the prompt and media for restricted content, then revise them.", "공급자의 콘텐츠 정책이 요청 또는 결과를 차단했습니다.", "프롬프트와 첨부 미디어의 제한 콘텐츠를 확인한 뒤 수정하세요.");
  if (/frame_images|input_references|first.?frame|last.?frame|mutually exclusive|cannot.*(?:combine|together)|invalid.*combination/.test(value)) return result("input_combination", "This model does not support the selected input combination.", "Use only a supported combination shown beside the inputs.", "이 모델은 선택한 입력 조합을 지원하지 않습니다.", "입력란에 표시된 지원 조합만 사용하세요.");
  if (/unsupported.*(?:parameter|field|option)|unknown (?:parameter|field)|not supported.*(?:parameter|option)/.test(value)) return result("unsupported_parameter", "A selected option is not supported by this route.", "Remove the unsupported provider option or choose another model.", "선택한 옵션을 현재 라우트가 지원하지 않습니다.", "지원하지 않는 공급자 옵션을 제거하거나 다른 모델을 선택하세요.");
  if (/\b404\b|model not found|unknown model|no eligible model|model.*unavailable/.test(value)) return result("model_unavailable", "The selected model or route is unavailable.", "Refresh the model catalog and choose an available model.", "선택한 모델 또는 라우트를 사용할 수 없습니다.", "모델 목록을 새로고침하고 사용 가능한 모델을 선택하세요.");
  if (/image_too_large|image too large|payload too large|exceeds.*(?:size|pixel|mb)/.test(value)) return result("image_too_large", "An attached image is too large.", "Reduce its file size or dimensions.", "첨부 이미지가 크기 제한을 초과했습니다.", "파일 용량이나 가로·세로 크기를 줄이세요.");
  if (/image_too_small|image too small|below.*minimum|dimensions.*small/.test(value)) return result("image_too_small", "An attached image is too small.", "Use a higher-resolution image.", "첨부 이미지가 최소 크기보다 작습니다.", "더 높은 해상도의 이미지를 사용하세요.");
  if (/unsupported_image_format|invalid_image|corrupt|unreadable.*image/.test(value)) return result("invalid_image", "An attached image could not be read.", "Convert it to PNG, JPEG, or WebP and attach it again.", "첨부 이미지를 읽지 못했습니다.", "PNG, JPEG 또는 WebP로 변환한 뒤 다시 첨부하세요.");
  if (/unsupported.*(?:media|video|audio|format|codec)|invalid.*(?:media|video|audio)|codec/.test(value)) return result("invalid_media", "An attached media file has an unsupported format or codec.", "Convert it to a format supported by the selected model.", "첨부 미디어의 형식 또는 코덱을 지원하지 않습니다.", "선택한 모델이 지원하는 형식으로 변환하세요.");
  if (/image_download_failed|image_not_found|could not download|failed to fetch|url.*(?:expired|inaccessible)/.test(value)) return result("image_download", "The provider could not access an attached asset.", "Attach the local file again or use a stable direct URL.", "공급자가 첨부 자산에 접근하지 못했습니다.", "로컬 파일을 다시 첨부하거나 안정적인 직접 URL을 사용하세요.");
  if (/\b401\b|unauthori[sz]ed|invalid.*(?:api.?key|credential)|authentication/.test(value)) return result("authentication", "OpenRouter authentication failed.", "Check or replace the API key in Settings.", "OpenRouter 인증에 실패했습니다.", "설정에서 API 키를 확인하거나 교체하세요.");
  if (/account.*(?:suspend|disabled|restricted)|project.*(?:approval|required|allowlist)|permission denied|forbidden|\b403\b/.test(value)) return result("account_restricted", "The provider account or project is not permitted to run this request.", "Check project approval, allowlists, account status, and provider access.", "공급자 계정 또는 프로젝트에 이 요청 권한이 없습니다.", "프로젝트 승인, 허용 목록, 계정 상태와 공급자 접근 권한을 확인하세요.");
  if (/zero data retention|\bzdr\b|retention.*(?:route|routing)|no.*zdr.*endpoint/.test(value)) return result("zdr_routing", "Video generation cannot be routed while Zero Data Retention is enforced.", "Disable ZDR enforcement for this request or account if your policy permits it.", "Zero Data Retention 강제 설정 때문에 영상 요청을 라우팅할 수 없습니다.", "조직 정책이 허용한다면 이 요청 또는 계정의 ZDR 강제 설정을 해제하세요.");
  if (/\b402\b|payment required|insufficient.*(?:credit|balance)|(?:credit|balance)s?.*(?:insufficient|low|exhausted)/.test(value)) return result("payment", "The account does not have enough credit.", "Add OpenRouter credit or choose a cheaper setting.", "계정 크레딧이 부족합니다.", "OpenRouter 크레딧을 충전하거나 더 저렴한 설정을 선택하세요.");
  if (/quota.*(?:exceed|exhaust|limit)|daily limit|monthly limit/.test(value)) return result("quota", "A provider or account quota was reached.", "Wait for the quota window to reset or request a higher quota.", "공급자 또는 계정 할당량을 초과했습니다.", "할당량이 초기화될 때까지 기다리거나 한도 상향을 요청하세요.");
  if (/\b429\b|rate.?limit|too many requests|requestbursttoofast/.test(value)) return result("rate_limit", "The provider is receiving too many requests.", "Wait briefly and retry; reduce simultaneous generations if this repeats.", "현재 공급자 요청 한도를 초과했습니다.", "잠시 후 재시도하고 반복되면 동시 생성 수를 줄이세요.");
  if (/\b503\b|serveroverloaded|overload|capacity|temporarily unavailable/.test(value)) return result("provider_capacity", "The provider is temporarily at capacity.", "Retry later or choose another model.", "공급자의 처리 용량이 일시적으로 가득 찼습니다.", "나중에 재시도하거나 다른 모델을 선택하세요.");
  if (/\b504\b|timeout|timed out|expired|maximum time to live/.test(value)) return result("timeout", "The provider did not finish in time.", "Retry once, then reduce duration or resolution if it repeats.", "공급자가 제한 시간 안에 생성을 완료하지 못했습니다.", "한 번 재시도하고 반복되면 길이 또는 해상도를 낮추세요.");
  if (/\b500\b|internal server|error_type.?server|\bunmapped\b/.test(value)) return result("server", "The provider encountered an internal error.", "Retry once; if it repeats, choose another route or model.", "공급자 내부 오류가 발생했습니다.", "한 번 재시도하고 반복되면 다른 라우트 또는 모델을 선택하세요.");
  if (/\b400\b|\b422\b|bad request|validation|invalid.*(?:parameter|field|request)|(?:parameter|field|prompt).*required/.test(value)) return result("invalid_parameter", "The request contains a missing or invalid value.", "Review the highlighted inputs and provider options.", "요청에 누락되었거나 잘못된 값이 있습니다.", "표시된 입력과 공급자 옵션을 확인하세요.");
  return result("unknown", "The provider could not complete this generation.", "Review the technical detail, then retry or choose another model.", "공급자가 이 생성을 완료하지 못했습니다.", "기술 세부 정보를 확인한 뒤 재시도하거나 다른 모델을 선택하세요.");
}
