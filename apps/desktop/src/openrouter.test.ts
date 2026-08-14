import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedAssetRoles,
  buildRequest,
  defaultOptions,
  estimateGenerationCost,
  formatUsd,
  modelPriceLabel,
  productSystemInstruction,
  promptEnhancementUserContent,
  promptEnhancerInstruction,
  validateEnhancedPrompt,
  modelInputSignature,
  normalizeVideoStatus,
  prettyRequest,
  retryDelayMs,
  type ImageModel,
  type ReferenceAsset,
  type VideoModel,
} from "./openrouter.ts";

const asset = (role: ReferenceAsset["role"], name: string = role, mediaType = "image/png", slot = 1): ReferenceAsset => ({
  id: name,
  name: `${name}.${mediaType.startsWith("video/") ? "mp4" : "png"}`,
  mediaType,
  dataUrl: `data:${mediaType};base64,${name}`,
  role,
  slot,
});

test("image request includes only discovered capabilities", () => {
  const model: ImageModel = {
    id: "example/image",
    name: "Example Image",
    supported_parameters: {
      resolution: { type: "enum", values: ["1K", "2K"] },
      n: { type: "range", min: 1, max: 2 },
      input_references: { type: "range", min: 0, max: 1 },
    },
  };
  const request = buildRequest({
    mode: "image",
    model: model.id,
    prompt: "  hello  ",
    assets: [asset("reference", "one"), asset("reference", "two", "image/png", 2)],
    options: { resolution: "2K", n: 1, quality: "high" },
    providerJson: "",
  }, model);

  assert.deepEqual(request, {
    model: model.id,
    prompt: "Attached input mapping: @1 = one.png (reference). Preserve these identities exactly.\n\nhello",
    resolution: "2K",
    n: 1,
    input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,one" } }],
  });
});

test("video request separates references from first and last frames", () => {
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
  const request = buildRequest({
    mode: "video",
    model: model.id,
    prompt: "move forward",
    assets: [asset("reference"), asset("first_frame"), asset("last_frame")],
    options: { duration: 8, resolution: "720p", aspect_ratio: "16:9", size: "854x480", generate_audio: false, seed: 42, quality: "high" },
    providerJson: "{\"order\":[\"Alibaba\"]}",
  }, model);

  assert.equal((request.input_references as unknown[]).length, 1);
  assert.match(String(request.prompt), /@1 = reference.png/);
  assert.deepEqual((request.frame_images as Array<{ frame_type: string }>).map((item) => item.frame_type), ["first_frame", "last_frame"]);
  assert.equal(request.quality, undefined);
  assert.equal(request.size, undefined);
  assert.equal(request.seed, 42);
  assert.deepEqual(request.provider, { order: ["Alibaba"] });
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
  const instruction = productSystemInstruction({
    mode: "image",
    editMode: true,
    editTarget: "@2",
    hasMask: false,
    references: [],
    visuals: [],
  });
  assert.match(instruction, /explicit edit target is "@2"/);
  assert.match(instruction, /other numbered images are context only/);
  assert.doesNotMatch(instruction, /Rewrite the user's request/);
  assert.match(promptEnhancerInstruction(), /instead of forcing a fixed schema/);
  assert.equal(validateEnhancedPrompt("Keep @1, copy @2", "Keep @1 and copy @2"), null);
  assert.match(validateEnhancedPrompt("Keep @1", "Keep @1 and use @3") ?? "", /invented @3/);
  assert.equal(validateEnhancedPrompt("Keep @1; @4 is plain text", "Keep @1", undefined, [1]), null);
});

test("prompt enhancement sends text first and labels image visual inputs", () => {
  const content = promptEnhancementUserContent({
    promptModel: "openai/gpt-5.6-luna",
    mode: "video",
    prompt: "Use @1 to generate a rainy night.",
    maskInstructions: "",
    hasMask: false,
    references: [{ slot: 1, name: "source.png", mediaType: "image/png", role: "reference" }],
    visuals: [{
      id: "source",
      kind: "reference" as const,
      source: "data:image/png;base64,source",
      slot: 1,
      name: "source.png",
      role: "reference" as const,
    }],
  });

  assert.equal(content[0]?.type, "text");
  assert.match(content[0]?.type === "text" ? content[0].text : "", /Visual 1: @1 source\.png \(reference, reference\)/);
  assert.deepEqual(content.slice(1).map((part) => part.type), ["image_url"]);
  assert.doesNotMatch(JSON.stringify(content), /video_url/);
});

test("masked enhancement does not claim a visual guide when only the target image is available", () => {
  const instruction = productSystemInstruction({
    mode: "image",
    editMode: true,
    editTarget: "@1",
    hasMask: true,
    maskInstructions: "Turn the selected feathers black.",
    references: [],
    visuals: [{
      id: "target",
      kind: "edit_target",
      source: "data:image/png;base64,target",
      slot: 1,
      name: "target.png",
      role: "reference",
    }],
  });

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
    input: `data:image/png;base64,${"A".repeat(500)}`,
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
