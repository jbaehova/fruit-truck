import test from "node:test";
import assert from "node:assert/strict";
import {
  applyVideoCapabilityProvenance,
  assessInputConstraints,
  assessResolvedVideoInputRules,
  assessVideoReferenceTransport,
  explainGenerationError,
  modelPolicyNotices,
  resolveVideoInputRules,
  validateInputConstraints,
  videoReferenceCapability,
} from "./modelPolicies.ts";
import type { VideoModel } from "./openrouter.ts";

test("direct-provider research never invents OpenRouter reference capability", () => {
  const model = applyVideoCapabilityProvenance({
    id: "bytedance/seedance-2.0-fast",
    name: "Seedance 2.0 Fast",
    description: "Supports first frame control and multimodal reference-to-video.",
    supported_frame_images: ["first_frame", "last_frame"],
  });

  assert.equal(model.input_reference_types, undefined);
  assert.equal(model.max_input_references, undefined);

  const frameOnly = applyVideoCapabilityProvenance({
    id: "runway/gen-4.5",
    name: "Gen-4.5",
    description: "Text-to-video and image-to-video generation.",
    supported_frame_images: ["first_frame"],
  });
  assert.equal(frameOnly.input_reference_types, undefined);
});

test("declared frame roles use the OpenRouter frame contract instead of reference metadata", () => {
  const model: VideoModel = {
    id: "example/frame-model",
    name: "Frame model",
    supported_frame_images: ["first_frame", "last_frame"],
  };
  const inlineFirst = videoReferenceCapability(model, "image", "data_url", undefined, "first_frame");
  assert.equal(inlineFirst.supported, true);
  assert.equal(inlineFirst.verified, false);
  assert.equal(inlineFirst.evidence, "openrouter_contract");
  assert.equal(videoReferenceCapability(model, "image", "https_url", undefined, "last_frame").supported, true);
  assert.equal(videoReferenceCapability(model, "image", "http_url", undefined, "first_frame").supported, false);
  assert.equal(videoReferenceCapability(model, "image", "data_url").supported, false);
  assert.deepEqual(assessVideoReferenceTransport(model, [
    { slot: 1, kind: "image", transport: "data_url", role: "first_frame" },
    { slot: 2, kind: "image", transport: "data_url", role: "last_frame" },
  ]), []);
});

test("resolved video input rules make endpoint limits authoritative and OpenRouter input styles exclusive", () => {
  const model: VideoModel = {
    id: "bytedance/seedance-2.5",
    name: "Seedance 2.5",
    supported_frame_images: ["first_frame", "last_frame"],
  };
  const curated = resolveVideoInputRules(model);
  assert.deepEqual(curated.referenceLimits, { image: 30, video: 10, audio: 10 });
  assert.equal(curated.totalReferenceLimit, 50);
  assert.equal(curated.referenceSource, "curated_contract");
  assert.equal(curated.frameSource, "video_catalog");
  assert.equal(curated.combination, "exclusive");

  const endpoint = resolveVideoInputRules(model, {
    endpoint_id: "text-only",
    provider_name: "Text Only",
    provider_slug: "text-only",
    input_reference_types: [],
    max_input_references: 0,
    supported_frame_images: ["first_frame"],
  });
  assert.deepEqual(endpoint.referenceKinds, []);
  assert.deepEqual(endpoint.referenceLimits, { image: 0, video: 0, audio: 0 });
  assert.equal(endpoint.totalReferenceLimit, 0);
  assert.deepEqual(endpoint.frameImages, ["first_frame"]);
  assert.equal(endpoint.referenceSource, "endpoint_metadata");

  const modelLevelZero = resolveVideoInputRules({
    id: model.id,
    name: model.name,
    max_input_references: 0,
    supported_frame_images: ["first_frame"],
  });
  assert.deepEqual(modelLevelZero.referenceKinds, []);
  assert.equal(modelLevelZero.totalReferenceLimit, 0);

  const inherited = resolveVideoInputRules(model, {
    endpoint_id: "missing-reference-fields",
    provider_name: "Provider",
    provider_slug: "provider",
  });
  assert.deepEqual(inherited.referenceLimits, { image: 30, video: 10, audio: 10 });
  assert.equal(inherited.totalReferenceLimit, 50);
  assert.deepEqual(inherited.frameImages, ["first_frame", "last_frame"]);
  assert.equal(inherited.referenceSource, "curated_contract");
  assert.equal(inherited.frameSource, "video_catalog");

  const aggregateDoesNotWidenKinds = resolveVideoInputRules(model, {
    endpoint_id: "aggregate-only",
    provider_name: "Provider",
    provider_slug: "provider",
    input_reference_types: ["image", "video", "audio"],
    max_input_references: 50,
  });
  assert.deepEqual(aggregateDoesNotWidenKinds.referenceLimits, { image: 30, video: 10, audio: 10 });
  assert.equal(aggregateDoesNotWidenKinds.totalReferenceLimit, 50);
  assert.equal(aggregateDoesNotWidenKinds.referenceSource, "endpoint_metadata");

  const endpointOverridesModelDenial = resolveVideoInputRules({
    id: model.id,
    name: model.name,
    input_reference_types: [],
    max_input_references: 0,
  }, {
    endpoint_id: "positive-route",
    provider_name: "Provider",
    provider_slug: "provider",
    input_reference_types: ["image"],
    max_input_references: 1,
  });
  assert.deepEqual(endpointOverridesModelDenial.referenceKinds, ["image"]);
  assert.equal(endpointOverridesModelDenial.referenceLimits.image, 1);

  const endpointDenialOverridesModel = resolveVideoInputRules(model, {
    endpoint_id: "denied-route",
    provider_name: "Provider",
    provider_slug: "provider",
    input_reference_types: [],
    max_input_references: 50,
  });
  assert.deepEqual(endpointDenialOverridesModel.referenceKinds, []);
  assert.equal(endpointDenialOverridesModel.totalReferenceLimit, 0);
});

test("curated general transports fall back only when endpoint transport metadata is absent", () => {
  const model: VideoModel = { id: "bytedance/seedance-2.5", name: "Seedance 2.5" };
  const baseEndpoint = {
    endpoint_id: "route",
    provider_name: "Provider",
    provider_slug: "provider",
  };
  const inherited = videoReferenceCapability(model, "image", "data_url", baseEndpoint);
  assert.equal(inherited.supported, true);
  assert.equal(inherited.evidence, "openrouter_contract");
  assert.equal(inherited.verified, false);

  const missingPerKind = videoReferenceCapability(model, "image", "data_url", {
    ...baseEndpoint,
    reference_transports: { video: ["https_url"] },
  });
  assert.equal(missingPerKind.supported, true);
  assert.equal(missingPerKind.evidence, "openrouter_contract");

  assert.equal(videoReferenceCapability(model, "image", "data_url", {
    ...baseEndpoint,
    reference_transports: { image: [] },
  }).supported, false);
  assert.equal(videoReferenceCapability(model, "image", "data_url", {
    ...baseEndpoint,
    reference_transports: [],
  }).supported, false);

  const modelDeniesInline: VideoModel = {
    ...model,
    reference_transport_source: "openrouter_endpoint",
    reference_transports: { image: [] },
  };
  assert.equal(videoReferenceCapability(modelDeniesInline, "image", "data_url", baseEndpoint).supported, false);
});

test("current OpenRouter video catalog models resolve curated, unsupported, and unknown reference contracts without guessing", () => {
  const records: Array<{
    id: string;
    frames: Array<"first_frame" | "last_frame">;
    source: "curated_contract" | "curated_none" | "none";
    limits?: Partial<Record<"image" | "video" | "audio", number>>;
  }> = [
    { id: "minimax/hailuo-3-max", frames: ["first_frame", "last_frame"], source: "none" },
    { id: "alibaba/wan-3.0-prime", frames: ["first_frame"], source: "curated_contract", limits: { image: 10 } },
    { id: "alibaba/wan-3.0", frames: ["first_frame"], source: "curated_contract", limits: { image: 10 } },
    { id: "heygen/avatar-iv", frames: [], source: "none" },
    { id: "black-forest-labs/flux-video-upscale", frames: [], source: "none" },
    { id: "bytedance/seedance-2.0-mini", frames: ["first_frame", "last_frame"], source: "curated_contract", limits: { image: 9, video: 3, audio: 3 } },
    { id: "bytedance/seedance-2.5", frames: ["first_frame", "last_frame"], source: "curated_contract", limits: { image: 30, video: 10, audio: 10 } },
    { id: "black-forest-labs/flux-3-video", frames: ["first_frame", "last_frame"], source: "none" },
    { id: "minimax/hailuo-3", frames: ["first_frame", "last_frame"], source: "curated_contract", limits: { image: 9 } },
    { id: "runway/aleph-2", frames: [], source: "none" },
    { id: "runway/gen-4.5", frames: ["first_frame"], source: "none" },
    { id: "x-ai/grok-imagine-video-1.5", frames: ["first_frame"], source: "none" },
    { id: "alibaba/happyhorse-1.1", frames: ["first_frame"], source: "none" },
    { id: "alibaba/happyhorse-1.0", frames: ["first_frame"], source: "none" },
    { id: "x-ai/grok-imagine-video", frames: ["first_frame"], source: "none" },
    { id: "kwaivgi/kling-v3.0-pro", frames: ["first_frame", "last_frame"], source: "none" },
    { id: "kwaivgi/kling-v3.0-std", frames: ["first_frame", "last_frame"], source: "none" },
    { id: "google/veo-3.1-fast", frames: ["first_frame", "last_frame"], source: "curated_contract", limits: { image: 3 } },
    { id: "google/veo-3.1-lite", frames: ["first_frame", "last_frame"], source: "curated_none" },
    { id: "kwaivgi/kling-video-o1", frames: ["first_frame", "last_frame"], source: "none" },
    { id: "minimax/hailuo-2.3", frames: ["first_frame"], source: "none" },
    { id: "bytedance/seedance-2.0-fast", frames: ["first_frame", "last_frame"], source: "curated_contract", limits: { image: 9, video: 3, audio: 3 } },
    { id: "bytedance/seedance-2.0", frames: ["first_frame", "last_frame"], source: "curated_contract", limits: { image: 9, video: 3, audio: 3 } },
    { id: "alibaba/wan-2.7", frames: ["first_frame", "last_frame"], source: "none" },
    { id: "alibaba/wan-2.6", frames: ["first_frame"], source: "none" },
    { id: "bytedance/seedance-1-5-pro", frames: ["first_frame", "last_frame"], source: "none" },
    { id: "openai/sora-2-pro", frames: [], source: "curated_contract", limits: { image: 1 } },
    { id: "google/veo-3.1", frames: ["first_frame", "last_frame"], source: "curated_contract", limits: { image: 3 } },
  ];
  const lastFrameRequiresFirst = new Set([
    "bytedance/seedance-2.0-mini",
    "bytedance/seedance-2.5",
    "kwaivgi/kling-v3.0-pro",
    "kwaivgi/kling-v3.0-std",
    "google/veo-3.1-fast",
    "google/veo-3.1-lite",
    "kwaivgi/kling-video-o1",
    "bytedance/seedance-2.0-fast",
    "bytedance/seedance-2.0",
    "alibaba/wan-2.7",
    "bytedance/seedance-1-5-pro",
    "google/veo-3.1",
  ]);

  assert.equal(records.length, 28);
  for (const record of records) {
    const rules = resolveVideoInputRules({ id: record.id, name: record.id, supported_frame_images: record.frames });
    assert.equal(rules.referenceSource, record.source, record.id);
    assert.deepEqual(rules.frameImages, record.frames, record.id);
    assert.equal(rules.combination, "exclusive", record.id);
    assert.equal(rules.lastFrameRequiresFirstFrame, lastFrameRequiresFirst.has(record.id), record.id);
    for (const kind of ["image", "video", "audio"] as const) {
      assert.equal(rules.referenceLimits[kind], record.limits?.[kind] ?? 0, `${record.id}:${kind}`);
    }
    if (record.source === "none" || record.source === "curated_none") {
      assert.equal(rules.totalReferenceLimit, 0, record.id);
      assert.deepEqual(rules.referenceKinds, [], record.id);
    }
  }
});

test("Veo rules expose fixed asset references and reject provider-specific invalid combinations", () => {
  const standard: VideoModel = {
    id: "google/veo-3.1",
    name: "Veo 3.1",
    supported_frame_images: ["first_frame", "last_frame"],
  };
  const rules = resolveVideoInputRules(standard);
  assert.deepEqual(rules.referenceLimits, { image: 3, video: 0, audio: 0 });
  assert.equal(rules.referenceImageType, "asset");
  assert.equal(rules.homogeneousReferenceImages, true);
  assert.equal(rules.referencePurposeTransport, "prompt_only");
  assert.equal(rules.referenceTypeTransport, "implicit_provider_adapter");
  assert.equal(rules.lastFrameRequiresFirstFrame, true);
  assert.deepEqual(rules.referenceOptions, {
    durations: [8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    sizes: ["1280x720", "720x1280", "1920x1080", "1080x1920"],
  });

  const fast = resolveVideoInputRules({ id: "google/veo-3.1-fast", name: "Veo 3.1 Fast" });
  assert.deepEqual(fast.referenceOptions?.durations, [4, 6, 8]);
  const lite = resolveVideoInputRules({ id: "google/veo-3.1-lite", name: "Veo 3.1 Lite" });
  assert.equal(lite.referenceSource, "curated_none");
  assert.equal(lite.totalReferenceLimit, 0);
  assert.equal(lite.lastFrameRequiresFirstFrame, true);

  assert.deepEqual(assessResolvedVideoInputRules({
    model: standard,
    references: [{ slot: 1, role: "last_frame" }],
  }).map((issue) => issue.code), ["last_frame_requires_first_frame"]);
  assert.deepEqual(assessResolvedVideoInputRules({
    model: standard,
    references: [{ slot: 1, role: "reference" }],
    options: { duration: 4, aspect_ratio: "1:1", resolution: "4K" },
  }).map((issue) => issue.code), [
    "reference_duration_unsupported",
    "reference_aspect_ratio_unsupported",
    "reference_resolution_unsupported",
  ]);
  assert.deepEqual(assessResolvedVideoInputRules({
    model: standard,
    references: [{ slot: 1, role: "reference" }],
    options: { duration: 8, size: "3840x2160" },
  }).map((issue) => issue.code), ["reference_resolution_unsupported"]);
});

test("input constraints reject lossy or ambiguous video input combinations", () => {
  const mixed = validateInputConstraints({
    mode: "video",
    references: [{ slot: 1, role: "first_frame", kind: "image" }, { slot: 2, role: "reference", kind: "image" }],
    allowedRoles: ["reference", "first_frame", "last_frame"],
    limit: 11,
    referenceLimit: 9,
    modelId: "bytedance/seedance-2.0",
  });
  assert.equal(mixed?.code, "mixed_input_styles");

  const openRouterAlwaysTreatsFramesAsExclusive = validateInputConstraints({
    mode: "video",
    references: [{ slot: 1, role: "first_frame", kind: "image" }, { slot: 2, role: "reference", kind: "video" }],
    allowedRoles: ["reference", "first_frame"],
    limit: 2,
    referenceLimit: 1,
    modelId: "bytedance/seedance-2.0",
  });
  assert.equal(openRouterAlwaysTreatsFramesAsExclusive?.code, "mixed_input_styles");

  const duplicate = validateInputConstraints({
    mode: "video",
    references: [{ slot: 1, role: "first_frame", kind: "image" }, { slot: 2, role: "first_frame", kind: "image" }],
    allowedRoles: ["first_frame"],
    limit: 2,
    referenceLimit: 0,
  });
  assert.equal(duplicate?.code, "duplicate_first_frame");

  const tooManyReferences = validateInputConstraints({
    mode: "video",
    references: [{ slot: 1, role: "reference", kind: "image" }, { slot: 2, role: "reference", kind: "image" }],
    allowedRoles: ["reference", "first_frame", "last_frame"],
    limit: 3,
    referenceLimit: 1,
    modelId: "bytedance/seedance-2.0",
  });
  assert.deepEqual(tooManyReferences, { code: "too_many_inputs", severity: "error", limit: 1, value: "image" });
});

test("Seedance and Veo expose researched person-policy notices", () => {
  const seedance: VideoModel = { id: "bytedance/seedance-2.0", name: "Seedance 2.0" };
  const veo: VideoModel = { id: "google/veo-3.1", name: "Veo 3.1" };
  assert.deepEqual(modelPolicyNotices("video", seedance).map((notice) => notice.code), ["seedance_real_person", "video_retention"]);
  assert.deepEqual(modelPolicyNotices("video", veo).map((notice) => notice.code), ["veo_person_generation", "video_retention"]);
  assert.deepEqual(modelPolicyNotices("image", seedance), []);
});

test("provider errors become actionable Korean explanations without losing diagnostics", () => {
  const seedance = explainGenerationError(
    new Error('OpenRouter 400: {"error":{"message":"Input image blocked by content moderation: human face detected","metadata":{"error_type":"content_policy_violation"}}}'),
    { modelId: "bytedance/seedance-2.0-fast", language: "ko" },
  );
  assert.equal(seedance.code, "seedance_real_person");
  assert.match(seedance.message, /Seedance 2\.0/);
  assert.match(seedance.action, /사람 얼굴/);
  assert.match(seedance.technical, /content_policy_violation/);

  const image = explainGenerationError("image_too_large", { language: "ko" });
  assert.equal(image.code, "image_too_large");
  assert.match(image.action, /크기/);

  assert.equal(explainGenerationError("prompt is required", { language: "ko" }).code, "invalid_parameter");
  assert.equal(explainGenerationError("content policy violation", { modelId: "bytedance/seedance-2.0" }).code, "content_policy");
});

test("multimodal policies enforce media-specific limits and face preflight", () => {
  const issues = validateInputConstraints({
    mode: "video",
    modelId: "bytedance/seedance-2.0",
    allowedRoles: ["reference", "first_frame", "last_frame"],
    limit: 15,
    referenceLimit: 9,
    references: [{ slot: 1, role: "reference", kind: "image", facePresence: "present", width: 1024, height: 1024 }],
  });
  assert.equal(issues?.code, "real_person_blocked");
});

test("provider input formats, codecs, and documented modality rules fail before submission", () => {
  const gif = validateInputConstraints({
    mode: "video",
    modelId: "minimax/hailuo-3",
    allowedRoles: ["reference", "first_frame", "last_frame"],
    limit: 11,
    references: [{ slot: 1, role: "reference", kind: "image", mimeType: "image/gif" }],
  });
  assert.equal(gif?.code, "unsupported_media_format");

  const hailuoUnverifiedMediaReference = validateInputConstraints({
    mode: "video",
    modelId: "minimax/hailuo-3",
    allowedRoles: ["reference", "first_frame", "last_frame"],
    limit: 11,
    references: [
      { slot: 1, role: "reference", kind: "video", codec: "h264" },
      { slot: 2, role: "reference", kind: "audio", codec: "aac" },
    ],
  });
  assert.deepEqual(hailuoUnverifiedMediaReference, {
    code: "too_many_inputs",
    severity: "error",
    limit: 0,
    value: "video",
  });

  const hailuoHeic = validateInputConstraints({
    mode: "video",
    modelId: "minimax/hailuo-3",
    allowedRoles: ["reference"],
    limit: 9,
    references: [{ slot: 1, role: "reference", kind: "image", mimeType: "image/heic", width: 256, height: 256 }],
  });
  assert.equal(hailuoHeic, null);

  const seedanceAudioTooLong = validateInputConstraints({
    mode: "video",
    modelId: "bytedance/seedance-2.0-fast",
    allowedRoles: ["reference"],
    limit: 15,
    references: [
      { slot: 1, role: "reference", kind: "image", mimeType: "image/heic", width: 512, height: 512 },
      { slot: 2, role: "reference", kind: "audio", mimeType: "audio/wav", duration: 16 },
    ],
  });
  assert.equal(seedanceAudioTooLong?.code, "duration_too_long");

  const badCodecIssues = assessInputConstraints({
    mode: "video",
    modelId: "minimax/hailuo-3",
    allowedRoles: ["reference"],
    limit: 6,
    references: [{ slot: 1, role: "reference", kind: "video", codec: "wmv3" }],
  });
  assert.equal(badCodecIssues.some((issue) => issue.code === "too_many_inputs" && issue.value === "video" && issue.limit === 0), true);
  assert.equal(badCodecIssues.some((issue) => issue.code === "unsupported_media_codec"), true);
});
