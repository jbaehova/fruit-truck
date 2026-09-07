import test from "node:test";
import assert from "node:assert/strict";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  allowedAssetRoles,
  buildRequest,
  cancelOpenRouterRequest,
  defaultOptions,
  enhancePrompt,
  estimateGenerationCost,
  formatUsd,
  generateImage,
  generationActualCost,
  generationCostMetadata,
  generationRecoveryPath,
  loadPromptModelAvailability,
  modelPriceLabel,
  normalizePromptModelAvailability,
  prepareRequest,
  productSystemInstruction,
  promptEnhancementUserContent,
  promptEnhancerInstruction,
  validateEnhancedPrompt,
  validateProviderConfiguration,
  modelInputSignature,
  normalizeVideoStatus,
  prettyRequest,
  referenceCoverageReport,
  retryDelayMs,
  submitVideo,
  validateReferenceCoverage,
  type ImageModel,
  type PrepareRequestContext,
  type PromptEnhancementInput,
  type ReferenceAsset,
  type VideoModel,
} from "./openrouter.ts";
import { PROMPT_MODELS } from "./promptModels.ts";
import { PROMPT_PLAN_RESPONSE_FORMAT } from "./prompting/index.ts";

const asset = (
  role: ReferenceAsset["role"],
  name: string = role,
  mediaType = "image/png",
  slot = 1,
  purpose: ReferenceAsset["purpose"] = role === "first_frame"
    ? "first_frame"
    : role === "last_frame"
      ? "last_frame"
      : mediaType.startsWith("video/")
        ? "motion"
        : mediaType.startsWith("audio/")
          ? "audio"
          : "subject_identity",
): ReferenceAsset => ({
  id: name,
  name: `${name}.${mediaType.startsWith("video/") ? "mp4" : "png"}`,
  mediaType,
  dataUrl: `data:${mediaType};base64,${name}`,
  role,
  purpose,
  slot,
});

const promptTarget = (overrides: Partial<PromptEnhancementInput["target"]> = {}): PromptEnhancementInput["target"] => ({
  id: "example/image",
  name: "Example Image",
  options: {},
  providerJson: "",
  ...overrides,
});

const enhancementInput = (overrides: Partial<PromptEnhancementInput> = {}): PromptEnhancementInput => ({
  promptModel: "openai/gpt-5.6-sol",
  mode: "image",
  target: promptTarget(),
  workflow: "text_to_image",
  signature: "test-signature",
  prompt: "Create a polished image.",
  references: [],
  visuals: [],
  ...overrides,
});

test("native IPC receives the exact reviewed payload for image and video POSTs", async (t) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { crypto: globalThis.crypto },
  });
  t.after(() => {
    clearMocks();
    if (previousWindowDescriptor) Object.defineProperty(globalThis, "window", previousWindowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
  mockIPC((command, args) => {
    invocations.push({ command, args: args as Record<string, unknown> });
    if (command === "cancel_openrouter_request") return true;
    const path = (args as { path?: unknown }).path;
    if (path === "/images") return { data: [{ local_path: "/managed/result.png", media_type: "image/png" }], usage: { cost: 0.04 } };
    if (path === "/videos") return { id: "job-exact-payload", status: "pending", usage: { cost: 0.2 } };
    throw new Error(`Unexpected IPC path ${String(path)}`);
  });
  const imagePayload = Object.freeze({
    model: "example/image",
    prompt: "Reviewed image prompt",
    provider: Object.freeze({ only: Object.freeze(["example-provider"]), require_parameters: true }),
    input_references: Object.freeze([Object.freeze({ image_url: "fruit-truck-local:/managed/input.png" })]),
  });
  const videoPayload = Object.freeze({
    model: "example/video",
    prompt: "Reviewed video prompt",
    duration: 5,
    provider: Object.freeze({ only: Object.freeze(["example-video-provider"]), require_parameters: true }),
  });

  await generateImage(imagePayload, undefined, { requestId: "attempt-image" });
  await submitVideo(videoPayload);
  await cancelOpenRouterRequest("attempt-image");

  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations[0], {
    command: "openrouter_request",
    args: { method: "POST", path: "/images", body: imagePayload, requestId: "attempt-image" },
  });
  assert.deepEqual(invocations[1], {
    command: "openrouter_request",
    args: { method: "POST", path: "/videos", body: videoPayload },
  });
  assert.deepEqual(invocations[2], {
    command: "cancel_openrouter_request",
    args: { requestId: "attempt-image" },
  });
});

test("browser image SSE reports partial progress and returns the completed image", async (t) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage: { getItem: () => "sk-test-browser-stream" } },
  });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  globalThis.fetch = async () => new Response([
    `data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"${png}"}`,
    `data: {"type":"image_generation.completed","b64_json":"${png}","usage":{"cost":0.019}}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindowDescriptor) Object.defineProperty(globalThis, "window", previousWindowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const progress: string[] = [];
  const result = await generateImage(
    Object.freeze({ model: "example/stream", prompt: "stream", stream: true }),
    undefined,
    { requestId: "browser-stream", onProgress: (event) => progress.push(`${event.stage}:${event.partialImageIndex ?? ""}`) },
  );
  assert.deepEqual(progress, ["partial_image:0", "completed:"]);
  assert.equal(result.actualCostUsd, 0.019);
  assert.equal(result.urls[0], `data:image/png;base64,${png}`);
});

test("image request includes only discovered capabilities", () => {
  const model: ImageModel = {
    id: "example/image",
    name: "Example Image",
    supported_parameters: {
      resolution: { type: "enum", values: ["1K", "2K"] },
      n: { type: "range", min: 1, max: 2 },
      input_references: { type: "range", min: 0, max: 2 },
    },
  };
  const request = buildRequest({
    mode: "image",
    model: model.id,
    prompt: "  hello  ",
    assets: [
      asset("reference", "one", "image/png", 1, "product_identity"),
      asset("reference", "two", "image/png", 2, "style"),
    ],
    options: { resolution: "2K", n: 1, quality: "high" },
    providerJson: "",
  }, model);

  assert.deepEqual(request, {
    model: model.id,
    prompt: "Use Image 1 for the product's shape, materials, colors, hardware, and logo placement; the requested prompt controls the surrounding scene.\nUse Image 2 only for visual style, palette, lighting, texture, and finish; follow the requested prompt for subjects and layout.\n\nhello",
    resolution: "2K",
    n: 1,
    input_references: [
      { type: "image_url", image_url: { url: "data:image/png;base64,one" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,two" } },
    ],
    provider: { require_parameters: true },
  });
});

test("image request rejects references over the discovered limit", () => {
  const model: ImageModel = {
    id: "example/limited-image",
    name: "Limited image",
    supported_parameters: {
      input_references: { type: "range", min: 0, max: 1 },
    },
  };

  assert.throws(() => buildRequest({
    mode: "image",
    model: model.id,
    prompt: "hello",
    assets: [
      asset("reference", "one", "image/png", 1, "product_identity"),
      asset("reference", "two", "image/png", 2, "style"),
    ],
    options: {},
    providerJson: "",
  }, model), /at most 1 reference inputs; received 2/);
});

test("video requests keep general references and exact frames in exclusive OpenRouter workflows", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Wan",
    architecture: { input_modalities: ["text", "image"] },
    input_reference_types: ["image"],
    max_input_references: 2,
    supported_durations: [4, 8],
    supported_resolutions: ["720p"],
    supported_aspect_ratios: ["16:9"],
    supported_frame_images: ["first_frame", "last_frame"],
    generate_audio: true,
    seed: true,
  };
  const referenceRequest = buildRequest({
    mode: "video",
    model: model.id,
    prompt: "move forward",
    assets: [asset("reference", "reference", "image/png", 1)],
    options: {},
    providerJson: "{\"order\":[\"Alibaba\"]}",
  }, model);
  assert.equal((referenceRequest.input_references as unknown[]).length, 1);
  assert.match(String(referenceRequest.prompt), /Use Image 1 for the subject's defining identity and proportions/);

  const frameRequest = buildRequest({
    mode: "video",
    model: model.id,
    prompt: "move forward",
    assets: [asset("first_frame", "first", "image/png", 2), asset("last_frame", "last", "image/png", 3)],
    options: { duration: 8, resolution: "720p", aspect_ratio: "16:9", size: "854x480", generate_audio: false, seed: 42, quality: "high" },
    providerJson: "{\"order\":[\"Alibaba\"]}",
  }, model);
  assert.deepEqual((frameRequest.frame_images as Array<{ frame_type: string }>).map((item) => item.frame_type), ["first_frame", "last_frame"]);
  assert.equal(frameRequest.quality, undefined);
  assert.equal(frameRequest.size, undefined);
  assert.equal(frameRequest.seed, 42);
  assert.deepEqual(frameRequest.provider, { order: ["Alibaba"], require_parameters: true });

  assert.throws(() => buildRequest({
    mode: "video",
    model: model.id,
    prompt: "move forward",
    assets: [asset("reference", "reference", "image/png", 1), asset("first_frame", "first", "image/png", 2)],
    options: {},
    providerJson: "",
  }, model), /does not jointly apply input_references and frame_images/);
});

test("Veo request building enforces reference options and last-frame dependency without inventing reference_type", () => {
  const model: VideoModel = {
    id: "google/veo-3.1",
    name: "Veo 3.1",
    supported_durations: [4, 6, 8],
    supported_resolutions: ["720p", "1080p", "4K"],
    supported_aspect_ratios: ["16:9", "9:16", "1:1"],
    supported_sizes: ["1280x720", "720x1280", "1920x1080", "1080x1920", "3840x2160"],
    supported_frame_images: ["first_frame", "last_frame"],
  };
  const draft = {
    mode: "video" as const,
    model: model.id,
    prompt: "Keep the product consistent.",
    assets: [asset("reference", "product", "image/png", 1, "product_identity")],
    providerJson: "",
  };

  assert.throws(() => buildRequest({ ...draft, options: { duration: 4, resolution: "720p", aspect_ratio: "16:9" } }, model), /duration 4/);
  assert.throws(() => buildRequest({ ...draft, options: { duration: 8, resolution: "720p", aspect_ratio: "1:1" } }, model), /aspect ratio 1:1/);
  assert.throws(() => buildRequest({ ...draft, options: { duration: 8, resolution: "4K", aspect_ratio: "16:9" } }, model), /resolution 4K/);
  assert.throws(() => buildRequest({ ...draft, options: { duration: 8, size: "3840x2160" } }, model), /resolution 3840x2160/);
  assert.throws(() => buildRequest({
    ...draft,
    assets: [asset("last_frame", "end", "image/png", 1, "last_frame")],
    options: { duration: 8, resolution: "720p", aspect_ratio: "16:9" },
  }, model), /requires a first frame/);

  const valid = buildRequest({
    ...draft,
    options: { duration: 8, resolution: "1080p", aspect_ratio: "9:16" },
  }, model);
  assert.deepEqual(valid.input_references, [{
    type: "image_url",
    image_url: { url: "data:image/png;base64,product" },
  }]);
  assert.equal("reference_type" in ((valid.input_references as Record<string, unknown>[])[0] ?? {}), false);

  const missingDuration = prepareRequest({ ...draft, options: { resolution: "720p", aspect_ratio: "16:9" } }, model, { final: true });
  assert.equal(missingDuration.status, "ready", JSON.stringify(missingDuration.issues));
  assert.equal(missingDuration.payload.duration, 8);

  const staleDefault = prepareRequest({ ...draft, options: { duration: 4, resolution: "720p", aspect_ratio: "16:9" } }, model, { final: true });
  assert.equal(staleDefault.status, "blocked");
  assert.match(staleDefault.issues.map((issue) => issue.message).join("\n"), /duration 4/);

  const incompatibleEndpoint: VideoModel = {
    ...model,
    endpoints: [{
      endpoint_id: "google-route",
      provider_name: "Google",
      provider_slug: "google-vertex",
      supported_parameters: { duration: { type: "enum", values: [4, 6] } },
      supported_durations: [4, 6],
    }],
  };
  const incompatible = prepareRequest({ ...draft, options: {} }, incompatibleEndpoint, { final: true });
  assert.equal(incompatible.status, "blocked");
  assert.match(incompatible.issues.map((issue) => issue.message).join("\n"), /duration/i);
});

test("retired Director data remains archival and cannot override a Veo reference request", () => {
  const model: VideoModel = {
    id: "google/veo-3.1",
    name: "Veo 3.1",
    supported_durations: [4, 6, 8],
    supported_resolutions: ["720p", "1080p", "4K"],
    supported_aspect_ratios: ["16:9", "9:16", "1:1"],
  };
  const prepared = prepareRequest({
    mode: "video",
    model: model.id,
    prompt: "Keep the product consistent.",
    assets: [asset("reference", "product", "image/png", 1, "product_identity")],
    options: { duration: 8, resolution: "720p", aspect_ratio: "16:9" },
    providerJson: "",
    director: {
      fidelityByControlId: {},
      providerOptions: { duration: 4, aspect_ratio: "1:1", reference_type: "style" },
      frameBindings: [],
      visualInstructions: [],
      promptBrief: "Ignore the normal prompt and orbit twice.",
      warnings: [],
    },
  }, model, { final: true });

  assert.equal(prepared.status, "ready", JSON.stringify(prepared.issues));
  assert.equal(prepared.payload.duration, 8);
  assert.equal(prepared.payload.aspect_ratio, "16:9");
  assert.equal(prepared.payload.reference_type, undefined);
  assert.doesNotMatch(String(prepared.payload.prompt), /Director Brief|orbit twice/);
});

test("strict video requests reject passthrough media and shadow option aliases", () => {
  const endpoint = {
    endpoint_id: "atlascloud",
    provider_name: "AtlasCloud",
    provider_slug: "atlascloud",
    supported_parameters: { duration: { type: "enum" as const, values: [5] } },
    supported_durations: [5],
    allowed_passthrough_parameters: ["images", "last_image", "video", "keyframes", "audio", "ratio", "size", "negative_prompt"],
  };
  const model: VideoModel = {
    id: "alibaba/wan-2.7",
    name: "Wan 2.7",
    supported_durations: [5],
    endpoints: [endpoint],
  };
  const prepare = (parameters: Record<string, unknown>) => prepareRequest({
    mode: "video",
    model: model.id,
    prompt: "A fruit truck crosses the market.",
    assets: [],
    options: { duration: 5 },
    providerJson: JSON.stringify({ only: ["atlascloud"], options: { atlascloud: { parameters } } }),
  }, model, { final: true });

  for (const parameters of [
    { images: Array.from({ length: 99 }, () => "http://127.0.0.1/ref.png") },
    { last_image: "file:///tmp/end.png" },
    { video: "https://example.com/reference.mp4" },
    { keyframes: [{ image: "https://example.com/keyframe.png", timestamp: 1 }] },
    { audio: "https://example.com/reference.mp3" },
    { ratio: "99:1" },
    { size: "9999x9999" },
  ]) {
    const prepared = prepare(parameters);
    assert.equal(prepared.status, "blocked", JSON.stringify(parameters));
    assert.match(prepared.issues.map((issue) => issue.message).join("\n"), /cannot (?:carry media|override a validated video option)/);
  }

  const safe = prepare({ audio: true, negative_prompt: "flicker" });
  assert.equal(safe.status, "ready", JSON.stringify(safe.issues));

  const veo: VideoModel = {
    id: "google/veo-3.1",
    name: "Veo 3.1",
    supported_durations: [4, 6, 8],
    supported_resolutions: ["720p", "1080p"],
    supported_aspect_ratios: ["16:9", "9:16"],
    allowed_passthrough_parameters: ["aspectRatio", "personGeneration"],
    endpoints: [{
      endpoint_id: "google-vertex",
      provider_name: "Google Vertex",
      provider_slug: "google-vertex",
      supported_parameters: {
        duration: { type: "enum", values: [4, 6, 8] },
        resolution: { type: "enum", values: ["720p", "1080p"] },
        aspect_ratio: { type: "enum", values: ["16:9", "9:16"] },
      },
      supported_durations: [4, 6, 8],
      supported_resolutions: ["720p", "1080p"],
      supported_aspect_ratios: ["16:9", "9:16"],
      input_reference_types: ["image"],
      max_input_references: 3,
      reference_transports: { image: ["data_url"] },
      allowed_passthrough_parameters: ["aspectRatio", "personGeneration"],
    }],
  };
  const veoAlias = prepareRequest({
    mode: "video",
    model: veo.id,
    prompt: "Keep the product consistent.",
    assets: [asset("reference", "product", "image/png", 1, "product_identity")],
    options: { duration: 8, resolution: "720p", aspect_ratio: "16:9" },
    providerJson: JSON.stringify({ only: ["google-vertex"], options: { "google-vertex": { parameters: { aspectRatio: "1:1" } } } }),
  }, veo, { final: true });
  assert.equal(veoAlias.status, "blocked");
  assert.match(veoAlias.issues.map((issue) => issue.message).join("\n"), /aspectRatio cannot override/);
});

test("video generation serializes declared image and video reference inputs", () => {
  const proseOnly: VideoModel = {
    id: "example/prose",
    name: "Prose",
    description: "Excellent video generation with reference images",
  };
  const declared: VideoModel = {
    id: "example/declared",
    name: "Declared",
    architecture: { input_modalities: ["text", "video", "image"] },
    input_reference_types: ["image", "video"],
    max_input_references: 2,
  };

  assert.deepEqual(allowedAssetRoles("video", proseOnly), []);
  assert.deepEqual(allowedAssetRoles("video", declared), ["reference"]);
  assert.equal(modelInputSignature("video", declared), "Text + image ref + video ref");

  const request = buildRequest({
    mode: "video",
    model: declared.id,
    prompt: "generate a rainy night",
    assets: [asset("reference", "source", "video/mp4")],
    options: {},
    providerJson: "",
  }, declared);
  assert.deepEqual(request.input_references, [{ type: "video_url", video_url: { url: "data:video/mp4;base64,source" } }]);

  const videoOnly = { ...declared, id: "example/video-only", input_reference_types: ["video" as const] };
  assert.deepEqual(allowedAssetRoles("video", videoOnly), ["reference"]);
});

test("video frame inputs must be images", () => {
  const model: VideoModel = {
    id: "example/frames",
    name: "Frames",
    supported_frame_images: ["first_frame"],
  };
  assert.throws(() => buildRequest({
    mode: "video",
    model: model.id,
    prompt: "animate",
    assets: [asset("first_frame", "clip", "video/mp4", 1, "first_frame")],
    options: {},
    providerJson: "",
  }, model), /does not accept first frame inputs/);
});

test("request prompt translates @slots to the selected provider's reference labels", () => {
  const model: VideoModel = {
    id: "runway/gen-4.5",
    name: "Runway Gen-4.5",
    input_reference_types: ["image"],
    max_input_references: 2,
  };
  const request = buildRequest({
    mode: "video",
    model: model.id,
    prompt: "Animate @1 while preserving the palette from @2.",
    assets: [
      asset("reference", "hero", "image/png", 1, "character"),
      asset("reference", "palette", "image/png", 2, "style"),
    ],
    options: {},
    providerJson: "",
  }, model);

  assert.match(String(request.prompt), /Animate @\[Image 1\] while preserving the palette from @\[Image 2\]\./);
  assert.doesNotMatch(String(request.prompt), /@1|@2/);
});

test("OpenAI image edit requests put the explicit target first and preserve slot labels", () => {
  const model: ImageModel = {
    id: "openai/gpt-image-1",
    name: "GPT Image 1",
    supported_parameters: {
      input_references: { type: "range", min: 0, max: 2 },
    },
  };
  const request = buildRequest({
    mode: "image",
    model: model.id,
    prompt: "Edit @2 using @1 as context.",
    assets: [
      asset("reference", "context", "image/png", 1, "composition"),
      asset("reference", "target", "image/png", 2, "edit_target"),
    ],
    editTargetSlot: 2,
    options: {},
    providerJson: "",
  }, model);

  assert.deepEqual(request.input_references, [
    { type: "image_url", image_url: { url: "data:image/png;base64,target" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,context" } },
  ]);
  assert.equal(request.prompt, "Edit Image 1 using Image 2 as context.");

  const coverage = referenceCoverageReport({
    mode: "image",
    model: model.id,
    prompt: "Edit @2 using @1 as context.",
    assets: [
      asset("reference", "context", "image/png", 1, "composition"),
      asset("reference", "target", "image/png", 2, "edit_target"),
    ],
    editTargetSlot: 2,
    options: {},
    providerJson: "",
  }, model, request);
  assert.deepEqual(coverage.map((entry) => [entry.slot, entry.providerLabel, entry.severity]), [
    [1, "Image 2", "ok"],
    [2, "Image 1", "ok"],
  ]);
  assert.equal(validateReferenceCoverage(coverage), null);
});

test("GPT Image 2 omits the immutable input_fidelity parameter", () => {
  const model: ImageModel = {
    id: "openai/gpt-image-2",
    name: "GPT Image 2",
    supported_parameters: {
      input_fidelity: { type: "enum", values: ["low", "high"] },
    },
  };
  assert.equal(defaultOptions("image", model).input_fidelity, undefined);
  const request = buildRequest({
    mode: "image",
    model: model.id,
    prompt: "a product photo",
    assets: [],
    options: { input_fidelity: "high" },
    providerJson: "",
  }, model);
  assert.equal(request.input_fidelity, undefined);
});

test("negative prompts use a native image field when supported and inline constraints otherwise", () => {
  const nativeModel: ImageModel = {
    id: "openai/gpt-image-1",
    name: "GPT Image 1",
    supported_parameters: {
      negative_prompt: { type: "boolean" },
    },
  };
  const native = buildRequest({
    mode: "image",
    model: nativeModel.id,
    prompt: "a red apple",
    negativePrompt: "extra logos",
    assets: [],
    options: {},
    providerJson: "",
  }, nativeModel);
  assert.equal(native.prompt, "a red apple");
  assert.equal(native.negative_prompt, "extra logos");

  const inlineModel: ImageModel = {
    id: "example/inline-negative",
    name: "Inline negative image",
    supported_parameters: {},
  };
  const inline = buildRequest({
    mode: "image",
    model: inlineModel.id,
    prompt: "a red apple",
    negativePrompt: "extra logos",
    assets: [],
    options: {},
    providerJson: "",
  }, inlineModel);
  assert.equal(inline.prompt, "a red apple\nConstraints: extra logos");
  assert.equal(inline.negative_prompt, undefined);

  const videoModel: VideoModel = {
    id: "google/veo-example",
    name: "Veo",
    allowed_passthrough_parameters: ["negative_prompt"],
  };
  const video = buildRequest({
    mode: "video",
    model: videoModel.id,
    prompt: "a calm tracking shot",
    negativePrompt: "flicker",
    assets: [],
    options: {},
    providerJson: "",
  }, videoModel);
  assert.equal(video.prompt, "a calm tracking shot");
  assert.equal(video.negative_prompt, "flicker");
});

test("provider passthrough parameters require an endpoint allowlist", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Video",
    allowed_passthrough_parameters: ["personGeneration"],
  };
  assert.throws(() => buildRequest({
    mode: "video",
    model: model.id,
    prompt: "a portrait",
    assets: [],
    options: {},
    providerJson: JSON.stringify({ options: { provider: { parameters: { undocumented: true } } } }),
  }, model), /not declared by the selected endpoint/);
  assert.throws(() => validateProviderConfiguration(
    JSON.stringify({ options: { provider: { parameters: { undocumented: true } } } }),
    model,
  ), /not declared by the selected endpoint/);
});

test("optional reference coverage warns without blocking required inputs", () => {
  const model: ImageModel = {
    id: "example/image",
    name: "Example Image",
    supported_parameters: { input_references: { type: "range", min: 0, max: 2 } },
  };
  const draft = {
    mode: "image" as const,
    model: model.id,
    prompt: "Use @1 and optionally @2.",
    assets: [
      asset("reference", "required", "image/png", 1, "product_identity"),
      asset("reference", "optional", "image/png", 2, "style"),
    ],
    options: {},
    providerJson: "",
  };
  const coverage = referenceCoverageReport(draft, model, { prompt: "Image 1" }, {
    1: "required",
    2: "optional",
  });
  assert.deepEqual(coverage.map((entry) => [entry.slot, entry.priority, entry.severity]), [
    [1, "required", "ok"],
    [2, "optional", "warning"],
  ]);
  assert.equal(validateReferenceCoverage(coverage), null);
});

test("video statuses preserve every OpenRouter terminal state and fail safely", () => {
  assert.equal(normalizeVideoStatus("completed"), "completed");
  assert.equal(normalizeVideoStatus("cancelled"), "cancelled");
  assert.equal(normalizeVideoStatus("canceled"), "cancelled");
  assert.equal(normalizeVideoStatus("expired"), "expired");
  assert.equal(normalizeVideoStatus("future-provider-state"), "in_progress");
  assert.equal(normalizeVideoStatus(undefined, "pending"), "pending");
});

test("image edit enhancement distinguishes the target from context references", () => {
  const instruction = productSystemInstruction(enhancementInput({
    mode: "image",
    editMode: true,
    editTarget: "@2",
    hasMask: false,
    target: promptTarget({ id: "openai/gpt-image-1", name: "GPT Image 1" }),
    workflow: "image_edit",
    references: [],
    visuals: [],
    directorContext: "Shot 2 keeps the camera locked on the fruit display.",
  }));
  assert.match(instruction, /explicit edit target is "@2"/);
  assert.match(instruction, /other numbered images are context only/);
  assert.doesNotMatch(instruction, /Rewrite the user's request/);
  assert.match(instruction, /Read-only Director context: Shot 2 keeps the camera locked/);
  assert.match(instruction, /do not rewrite or mutate the Director plan/);
  assert.match(promptEnhancerInstruction(), /Return only the requested JSON object/);
  assert.equal(validateEnhancedPrompt("Keep @1, copy @2", "Keep @1 and copy @2"), null);
  assert.match(validateEnhancedPrompt("Keep @1", "Keep @1 and use @3") ?? "", /invented @3/);
  assert.match(validateEnhancedPrompt("Keep @1; @4 is plain text", "Keep @1", undefined, [1]) ?? "", /removed @4/);
});

test("prompt enhancement sends text first and labels image visual inputs", () => {
  const content = promptEnhancementUserContent(enhancementInput({
    promptModel: "openai/gpt-5.6-sol",
    mode: "video",
    target: promptTarget({ id: "runway/gen-4.5", name: "Runway Gen-4.5" }),
    workflow: "image_to_video",
    signature: "video-signature",
    prompt: "Use @1 to generate a rainy night.",
    maskInstructions: "",
    hasMask: false,
    references: [{ slot: 1, name: "source.png", mediaType: "image/png", role: "reference", purpose: "subject_identity" }],
    visuals: [{
      id: "source",
      kind: "reference" as const,
      source: "data:image/png;base64,source",
      slot: 1,
      name: "source.png",
      role: "reference" as const,
    }],
  }));

  assert.equal(content[0]?.type, "text");
  assert.match(content[0]?.type === "text" ? content[0].text : "", /Visual 1: @1 source\.png \(reference, reference\)/);
  assert.match(content[0]?.type === "text" ? content[0].text : "", /semantic purpose=subject_identity/);
  assert.deepEqual(content.slice(1).map((part) => part.type), ["image_url"]);
  assert.doesNotMatch(JSON.stringify(content), /video_url/);
});

test("planner catalog availability requires exact IDs and both required capabilities", () => {
  const availability = normalizePromptModelAvailability({
    data: [
      {
        id: "openai/gpt-5.6-sol",
        supported_parameters: ["temperature", "reasoning", "structured_outputs"],
      },
      {
        id: "anthropic/claude-opus-5",
        supported_parameters: ["reasoning"],
      },
      {
        id: "google/gemini-3.8-flash",
        supported_parameters: ["structured_outputs"],
      },
      {
        id: "google/gemini-3.8-flash:free",
        supported_parameters: ["reasoning", "structured_outputs"],
      },
    ],
  });

  assert.deepEqual(availability, {
    "openai/gpt-5.6-sol": true,
    "anthropic/claude-opus-5": false,
    "google/gemini-3.8-flash": false,
  });
  assert.deepEqual(normalizePromptModelAvailability({ data: "missing" }), {
    "openai/gpt-5.6-sol": false,
    "anthropic/claude-opus-5": false,
    "google/gemini-3.8-flash": false,
  });
});

test("planner availability loads the queryless general catalog without fallback", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedMethod = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedMethod = String(init?.method);
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        data: PROMPT_MODELS.map((model) => ({
          id: model.id,
          supported_parameters: ["reasoning", "structured_outputs"],
        })),
      }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    assert.deepEqual(await loadPromptModelAvailability(), {
      "openai/gpt-5.6-sol": true,
      "anthropic/claude-opus-5": true,
      "google/gemini-3.8-flash": true,
    });
    assert.equal(requestedUrl, "https://openrouter.ai/api/v1/models");
    assert.equal(requestedMethod, "GET");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("every configured planner request uses its registry ID with high reasoning effort", async () => {
  const previousFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ choices: [{ message: { content: "{}" } }] }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    for (const model of PROMPT_MODELS) {
      await assert.rejects(enhancePrompt(enhancementInput({ promptModel: model.id })));
    }
    assert.equal(requestBodies.length, PROMPT_MODELS.length * 2);
    for (const [index, body] of requestBodies.entries()) {
      assert.equal(body.model, PROMPT_MODELS[Math.floor(index / 2)]?.id);
      assert.deepEqual(body.reasoning, { effort: "high" });
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("enhancePrompt sends the structured planner schema with target workflow and signature", async () => {
  const plannerPlan = {
    version: 1,
    mode: "image",
    workflow: "text_to_image",
    language: "en",
    deliverable: "a polished product image",
    intent: "show the product clearly",
    scene: ["a quiet studio"],
    subjects: ["a red apple"],
    action: ["rests on a table"],
    composition: ["centered medium shot"],
    camera: ["eye level"],
    lighting: ["softbox lighting"],
    color: ["warm red"],
    style: ["clean commercial"],
    materials: ["smooth skin"],
    exactText: [],
    temporalBeats: [],
    subjectMotion: [],
    cameraMotion: [],
    audio: [],
    editChanges: [],
    preserve: ["the product identity"],
    ambiguities: [],
    constraints: [{ requirement: "no extra logos", desiredState: "only the requested logo is visible" }],
    references: [{
      slot: 1,
      target: "the product",
      purpose: "product_identity",
      priority: "required",
      evidence: "user",
      copy: ["shape and label geometry"],
      preserve: ["silhouette"],
      ignore: ["unrelated background details"],
    }],
  };
  const input = enhancementInput({
    promptModel: "openai/gpt-5.6-sol",
    target: promptTarget({ id: "openai/gpt-image-1", name: "GPT Image 1" }),
    workflow: "text_to_image",
    signature: "planner-signature",
    prompt: "Create a product image using @1.",
    references: [{
      slot: 1,
      name: "product.png",
      mediaType: "image/png",
      role: "reference",
      purpose: "product_identity",
    }],
  });
  const runtime = globalThis as unknown as {
    window?: { localStorage: { getItem: (key: string) => string | null } };
  };
  const previousWindow = runtime.window;
  const previousFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  runtime.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const repairing = requestBodies.length === 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: repairing ? "{}" : JSON.stringify(plannerPlan) } }],
        usage: { cost: repairing ? 0.001 : 0.0123 },
      }),
    } as Response;
  }) as typeof fetch;

  try {
    let actualCost: number | undefined;
    const artifact = await enhancePrompt(input, (cost) => { actualCost = cost; });
    const body = requestBodies[0];
    assert.deepEqual(body?.response_format, PROMPT_PLAN_RESPONSE_FORMAT);
    assert.deepEqual(body?.provider, { require_parameters: true });
    assert.equal(body?.model, input.promptModel);
    assert.equal(actualCost, 0.0133);
    assert.equal(requestBodies.length, 2);
    assert.equal(artifact.repairAttempts, 1);
    assert.equal(artifact.target.id, input.target.id);
    assert.ok(artifact.profileSources.length > 0);
    assert.equal(artifact.signature, input.signature);
    assert.equal(artifact.workflow, input.workflow);
    assert.match(artifact.prompt, /@1/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  }
});

test("enhancePrompt reports accumulated planner cost when the repair request fails", async () => {
  const runtime = globalThis as unknown as {
    window?: { localStorage: { getItem: (key: string) => string | null } };
  };
  const previousWindow = runtime.window;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  runtime.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "{}" } }], usage: { cost: 0.0042 } }),
      } as Response;
    }
    throw new Error("repair transport failed");
  }) as typeof fetch;

  try {
    let actualCost: number | undefined;
    await assert.rejects(
      enhancePrompt(enhancementInput(), (cost) => { actualCost = cost; }),
      /repair transport failed/,
    );
    assert.equal(calls, 2);
    assert.equal(actualCost, 0.0042);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  }
});

test("generateImage preserves a paid response recovery path when no result can be materialized", async () => {
  const runtime = globalThis as unknown as {
    window?: { localStorage: { getItem: (key: string) => string | null } };
  };
  const previousWindow = runtime.window;
  const previousFetch = globalThis.fetch;
  runtime.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      data: [],
      usage: { cost: 0.027 },
      _fruit_truck_recovery_path: "/managed/recovery/paid-image-response.json",
      _fruit_truck_materialization_errors: ["result 1 exceeded the decoded image limit"],
    }),
  }) as Response) as typeof fetch;

  try {
    let actualCost: number | undefined;
    let caught: unknown;
    try {
      await generateImage({ model: "example/image", prompt: "test" }, (cost) => { actualCost = cost; });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.equal(actualCost, 0.027);
    assert.equal(generationActualCost(caught), 0.027);
    assert.equal(generationRecoveryPath(caught), "/managed/recovery/paid-image-response.json");
    assert.deepEqual((caught as { materializationErrors?: unknown }).materializationErrors, ["result 1 exceeded the decoded image limit"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  }
});

test("generationRecoveryPath only parses native retained-response markers", () => {
  assert.equal(
    generationRecoveryPath("OpenRouter response exceeded its limit (partial response retained at /managed/recovery/response.part)."),
    "/managed/recovery/response.part",
  );
  assert.equal(
    generationRecoveryPath(new Error("Could not parse response (recovery response retained at /managed/recovery/response.json).")),
    "/managed/recovery/response.json",
  );
  assert.equal(generationRecoveryPath("Recovery payload might be /tmp/untrusted"), undefined);
  assert.equal(generationActualCost(Object.assign(new Error("failed"), { actualCostUsd: -1 })), undefined);
});

test("masked enhancement does not claim a visual guide when only the target image is available", () => {
  const instruction = productSystemInstruction(enhancementInput({
    mode: "image",
    editMode: true,
    editTarget: "@1",
    hasMask: true,
    maskInstructions: "Turn the selected feathers black.",
    target: promptTarget({ id: "openai/gpt-image-1", name: "GPT Image 1" }),
    workflow: "inpaint",
    references: [],
    visuals: [{
      id: "target",
      kind: "edit_target",
      source: "data:image/png;base64,target",
      slot: 1,
      name: "target.png",
      role: "reference",
    }],
  }));

  assert.match(instruction, /No visual mask-guide image is supplied/);
  assert.doesNotMatch(instruction, /magenta mask-guide view are supplied/);
});

test("masked prompt enhancement preserves contact anatomy and keeps attribute edits narrow", () => {
  const instruction = promptEnhancerInstruction(["edit_target", "mask_guide"]);
  assert.match(instruction, /Keep simple color, material, or attribute changes attribute-only/);
  assert.match(instruction, /do not add pose changes, gestures, finger placement, grasp angles, contact geometry, or limb restyling/);
  assert.match(instruction, /Preserve exact overlaps and occlusions/);
  assert.match(instruction, /limit any boundary blending to that subject's own edge/);
});

test("default options come directly from capability values", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Example Video",
    supported_durations: [5, 8],
    supported_resolutions: ["1080p"],
    supported_aspect_ratios: ["9:16"],
    generate_audio: false,
  };
  assert.deepEqual(defaultOptions("video", model), {
    duration: 5,
    resolution: "1080p",
    aspect_ratio: "9:16",
    generate_audio: undefined,
  });
});

test("request previews never expose Base64 media", () => {
  const preview = prettyRequest({
    input: `data:image/png;base64,${"A".repeat(8)}`,
    managed: "fruit-truck-local:/Users/test/.fruit-truck/assets/reference.png",
  });
  assert.doesNotMatch(preview, /;base64,/i);
  assert.doesNotMatch(preview, /A{20}/);
  assert.match(preview, /media payload omitted/);
});

test("retry delays honor Retry-After and bound exponential fallback", () => {
  assert.equal(retryDelayMs("2", 0, 0, 0), 2_000);
  assert.equal(retryDelayMs("Thu, 01 Jan 1970 00:00:03 GMT", 0, 1_000, 0), 2_000);
  assert.equal(retryDelayMs(null, 2, 0, 0), 2_000);
  assert.equal(retryDelayMs("999", 0, 0, 0), 30_000);
});

test("request preparation always uses the visible draft prompt", () => {
  const model: ImageModel = {
    id: "example/visible-prompt",
    name: "Visible prompt model",
    supported_parameters: {},
  };
  const draft = {
    mode: "image" as const,
    model: model.id,
    prompt: "Visible draft prompt",
    assets: [],
    options: {},
    providerJson: "",
  };
  const hiddenEnhancementContext = {
    enhancement: {
      prompt: "Hidden replacement prompt",
      negativePrompt: "Hidden negative prompt",
      signature: "hidden-signature",
    },
  } as unknown as PrepareRequestContext;

  const prepared = prepareRequest(draft, model, hiddenEnhancementContext);
  const baseline = prepareRequest(draft, model);
  assert.equal(prepared.payload.prompt, draft.prompt);
  assert.equal(prepared.fingerprint, baseline.fingerprint);
});

test("planner cost remains separate from later generation totals", () => {
  const image: ImageModel = {
    id: "priced/separate-planner",
    name: "Separate planner cost",
    supported_parameters: {},
    pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
  };
  const cost = generationCostMetadata("image", image, { n: 1 }, { plannerCostUsd: 0.25 });

  assert.equal(cost.generationMinUsd, 0.04);
  assert.equal(cost.generationMaxUsd, 0.04);
  assert.equal(cost.plannerUsd, 0.25);
  assert.equal(cost.totalMinUsd, 0.04);
  assert.equal(cost.totalMaxUsd, 0.04);
  assert.equal(cost.label, "$0.04 total");

  const unknown = generationCostMetadata("video", { id: "unknown", name: "Unknown" }, {}, { plannerCostUsd: 0.25 });
  assert.equal(unknown.plannerUsd, 0.25);
  assert.equal(unknown.totalMinUsd, undefined);
  assert.equal(unknown.totalMaxUsd, undefined);
  assert.equal(unknown.label, "Price unavailable");
});

test("generation cost estimates use structured catalog pricing", () => {
  const image: ImageModel = {
    id: "priced/image",
    name: "Priced image",
    supported_parameters: {},
    pricing: [{ billable: "image", unit: "image", cost_usd: 0.04 }],
  };
  const video: VideoModel = {
    id: "priced/video",
    name: "Priced video",
    pricing_skus: { standard: "$0.25" },
  };
  assert.equal(estimateGenerationCost("image", image, { n: 3 }), 0.12);
  assert.equal(estimateGenerationCost("video", video, {}), 0.25);
  assert.equal(estimateGenerationCost("video", { id: "unknown", name: "Unknown" }, {}), undefined);
});

test("image pricing prefers output rates and preserves small token prices", () => {
  const perImage: ImageModel = {
    id: "priced/ranged-image",
    name: "Ranged image",
    supported_parameters: {},
    pricing: [
      { billable: "input_image", unit: "image", cost_usd: 0.003 },
      { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "1k" },
      { billable: "output_image", unit: "image", cost_usd: 0.075, variant: "2k" },
    ],
  };
  const perToken: ImageModel = {
    id: "priced/token-image",
    name: "Token image",
    supported_parameters: {},
    pricing: [{ billable: "output_image", unit: "token", cost_usd: 0.00006 }],
  };

  assert.equal(modelPriceLabel("image", perImage), "$0.04–$0.075/image");
  assert.equal(modelPriceLabel("image", perToken), "$60/M output tokens");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.1), "$0.10");
  assert.equal(formatUsd(0.000000004), "$0.000000004");
  assert.equal(estimateGenerationCost("image", perImage, { n: 2 }), 0.08);
  assert.equal(estimateGenerationCost("image", perToken, { n: 2 }), undefined);
});

test("video pricing converts cent-denominated SKUs to dollars", () => {
  const video: VideoModel = {
    id: "priced/cents-video",
    name: "Cents video",
    pricing_skus: {
      cents_per_second_output: "17",
      minimum_cents_per_generation: "53",
    },
  };

  assert.equal(modelPriceLabel("video", video), "$0.17/second · $0.53 minimum");
  assert.equal(estimateGenerationCost("video", video, {}), 0.53);
  assert.equal(estimateGenerationCost("video", video, { duration: 5 }), 0.85);
});

test("video estimates select generation, resolution, audio, and input-image SKUs", () => {
  const flux: VideoModel = {
    id: "black-forest-labs/flux-3-video",
    name: "FLUX.3 Video",
    pricing_skus: {
      cents_per_second_output: "17",
      cents_per_second_output_720p: "17",
      cents_per_second_output_1080p: "29",
      cents_per_second_video_continuation_720p: "41",
      cents_per_second_video_continuation_1080p: "53",
    },
  };
  const hailuo: VideoModel = {
    id: "minimax/hailuo-3",
    name: "Hailuo 3",
    pricing_skus: { duration_seconds: "0.13", reference_images: "0.04" },
  };
  const veo: VideoModel = {
    id: "google/veo-3.1-fast",
    name: "Veo 3.1 Fast",
    pricing_skus: {
      duration_seconds_with_audio: "0.12",
      duration_seconds_without_audio: "0.10",
      duration_seconds_with_audio_720p: "0.10",
      duration_seconds_without_audio_720p: "0.08",
    },
  };

  assert.equal(estimateGenerationCost("video", flux, { duration: 5, resolution: "720p" }), 0.85);
  assert.equal(estimateGenerationCost("video", hailuo, { duration: 5 }, { imageInputCount: 2 }), 0.73);
  assert.equal(estimateGenerationCost("video", veo, { duration: 4, resolution: "720p", generate_audio: true }), 0.4);
  assert.equal(estimateGenerationCost("video", veo, { duration: 4, resolution: "720p", generate_audio: false }), 0.32);
});

test("video pricing supports documented hyphenated SKUs and converts Seedance video tokens", () => {
  const documented: VideoModel = {
    id: "example/documented",
    name: "Documented video",
    pricing_skus: { "per-video-second": "0.50", "per-video-second-1080p": "0.75" },
  };
  const tokenBilled: VideoModel = {
    id: "bytedance/seedance-2.0",
    name: "Seedance 2.0",
    pricing_skus: { video_tokens: "0.000007", video_tokens_without_audio: "0.000007" },
    supported_sizes: ["480x480", "854x480", "1280x720"],
  };

  assert.equal(estimateGenerationCost("video", documented, { duration: 4, resolution: "1080p" }), 3);
  assert.equal(modelPriceLabel("video", tokenBilled), "from $0.06725/second");
  assert.equal(estimateGenerationCost("video", tokenBilled, { duration: 5 }), 0.3362625);
  assert.equal(estimateGenerationCost("video", tokenBilled, { duration: 5, resolution: "720p", aspect_ratio: "16:9" }), 0.756);
});

test("token-priced image models show OpenRouter-style per-million input and output rates", () => {
  const image: ImageModel = {
    id: "openai/gpt-image-2",
    name: "OpenAI: GPT Image 2",
    supported_parameters: {},
    pricing: [
      { billable: "input_image", unit: "token", cost_usd: 0.000008 },
      { billable: "input_text", unit: "token", cost_usd: 0.000005 },
      { billable: "output_image", unit: "token", cost_usd: 0.00003 },
    ],
  };
  const megapixel: ImageModel = {
    id: "black-forest-labs/flux.2-pro",
    name: "Black Forest Labs: FLUX.2 Pro",
    supported_parameters: {},
    pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.014 }],
  };

  assert.equal(modelPriceLabel("image", image), "$5–$8/M input · $30/M output");
  assert.equal(modelPriceLabel("image", megapixel), "$0.014/MP");
});

test("image estimates select resolution variants and include reference input billing", () => {
  const image: ImageModel = {
    id: "priced/variant-image",
    name: "Variant image",
    supported_parameters: {},
    pricing: [
      { billable: "input_reference", unit: "image", cost_usd: 0.003 },
      { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "1k" },
      { billable: "output_image", unit: "image", cost_usd: 0.075, variant: "2k" },
    ],
  };

  assert.equal(estimateGenerationCost("image", image, { resolution: "2K", n: 2 }, { imageInputCount: 3 }), 0.159);
});

test("image estimates keep output and input pricing within one endpoint", () => {
  const image: ImageModel = {
    id: "priced/routed-image",
    name: "Routed image",
    supported_parameters: {},
    endpoint_details: [{
      provider_name: "Output cheap",
      provider_slug: "output-cheap",
      supported_parameters: {},
      pricing: [
        { billable: "output_image", unit: "image", cost_usd: 0.04 },
        { billable: "input_reference", unit: "image", cost_usd: 0.1 },
      ],
    }, {
      provider_name: "Input cheap",
      provider_slug: "input-cheap",
      supported_parameters: {},
      pricing: [
        { billable: "output_image", unit: "image", cost_usd: 0.05 },
        { billable: "input_reference", unit: "image", cost_usd: 0.01 },
      ],
    }],
    pricing: [
      { billable: "output_image", unit: "image", cost_usd: 0.04 },
      { billable: "input_reference", unit: "image", cost_usd: 0.01 },
    ],
  };

  assert.equal(estimateGenerationCost("image", image, { n: 1 }, { imageInputCount: 1 }), 0.06);
  assert.equal(estimateGenerationCost("image", {
    id: "priced/input-only",
    name: "Input only",
    supported_parameters: {},
    pricing: [{ billable: "input_reference", unit: "image", cost_usd: 0.01 }],
  }, {}, { imageInputCount: 1 }), undefined);
});
