import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest, defaultOptions, type ImageModel, type ReferenceAsset, type VideoModel } from "./openrouter.ts";

const asset = (role: ReferenceAsset["role"], name = role): ReferenceAsset => ({
  id: name,
  name: `${name}.png`,
  mediaType: "image/png",
  dataUrl: `data:image/png;base64,${name}`,
  previewUrl: "blob:preview",
  role,
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
    assets: [asset("reference", "one"), asset("reference", "two")],
    options: { resolution: "2K", n: 1, quality: "high" },
    providerJson: "",
  }, model);

  assert.deepEqual(request, {
    model: model.id,
    prompt: "hello",
    resolution: "2K",
    n: 1,
    input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,one" } }],
  });
});

test("video request separates references from first and last frames", () => {
  const model: VideoModel = {
    id: "alibaba/wan-2.7",
    name: "Wan",
    description: "Reference-to-video model",
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
  assert.deepEqual((request.frame_images as Array<{ frame_type: string }>).map((item) => item.frame_type), ["first_frame", "last_frame"]);
  assert.equal(request.quality, undefined);
  assert.deepEqual(request.provider, { order: ["Alibaba"] });
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
