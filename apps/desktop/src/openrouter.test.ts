import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedAssetRoles,
  buildRequest,
  defaultOptions,
  estimateGenerationCost,
  productSystemInstruction,
  promptEnhancerInstruction,
  validateEnhancedPrompt,
  modelInputSignature,
  prettyRequest,
  retryDelayMs,
  supportsVideoInput,
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
    prompt: "Attached input mapping: #1 = one.png (reference). Preserve these identities exactly.\n\nhello",
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
    options: { duration: 8, resolution: "720p", aspect_ratio: "16:9", generate_audio: false, quality: "high" },
    providerJson: "{\"order\":[\"Alibaba\"]}",
  }, model);

  assert.equal((request.input_references as unknown[]).length, 1);
  assert.match(String(request.prompt), /#1 = reference.png/);
  assert.deepEqual((request.frame_images as Array<{ frame_type: string }>).map((item) => item.frame_type), ["first_frame", "last_frame"]);
  assert.equal(request.quality, undefined);
  assert.deepEqual(request.provider, { order: ["Alibaba"] });
});

test("video edit support is fail-closed and comes only from structured metadata", () => {
  const proseOnly: VideoModel = {
    id: "example/prose",
    name: "Prose",
    description: "Excellent video-to-video editing and reference images",
  };
  const declared: VideoModel = {
    id: "example/declared",
    name: "Declared",
    architecture: { input_modalities: ["text", "video", "image"] },
    max_input_references: 2,
  };

  assert.equal(supportsVideoInput(proseOnly), false);
  assert.deepEqual(allowedAssetRoles("video", proseOnly, "edit"), []);
  assert.equal(supportsVideoInput(declared), true);
  assert.deepEqual(allowedAssetRoles("video", declared, "edit"), ["reference", "video_reference"]);
  assert.equal(modelInputSignature("video", declared), "Text + image + video");

  const request = buildRequest({
    mode: "video",
    videoWorkflow: "edit",
    model: declared.id,
    prompt: "turn it into dusk",
    assets: [asset("video_reference", "source", "video/mp4")],
    options: {},
    providerJson: "",
  }, declared);
  assert.deepEqual(request.input_references, [{
    type: "video_url",
    video_url: { url: "data:video/mp4;base64,source" },
  }]);
});

test("image edit enhancement distinguishes the target from context references", () => {
  const instruction = productSystemInstruction({
    mode: "image",
    editMode: true,
    editTarget: "#2",
    references: [],
  });
  assert.match(instruction, /explicit edit target is "#2"/);
  assert.match(instruction, /other numbered images are context only/);
  assert.doesNotMatch(instruction, /Rewrite the user's request/);
  assert.match(promptEnhancerInstruction(), /instead of forcing a fixed schema/);
  assert.equal(validateEnhancedPrompt("Keep #1, copy #2", "Keep #1 and copy #2"), null);
  assert.match(validateEnhancedPrompt("Keep #1", "Keep #1 and use #3") ?? "", /invented #3/);
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
