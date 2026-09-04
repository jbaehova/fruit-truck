import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRequest,
  isPreparedRequestCurrent,
  normalizeVideoModel,
  prepareRequest,
  type GenerationDraft,
  type VideoModel,
} from "../openrouter.ts";
import type { CompiledDirector } from "./types.ts";

const model: VideoModel = {
  id: "test/director-video",
  name: "Director test video",
  supported_parameters: {
    camera_motion: { type: "enum", values: ["dolly_in"] },
  },
  supported_durations: [5],
};

function compiled(promptBrief: string): CompiledDirector {
  return {
    fidelityByControlId: { "motion-1": "native" },
    providerOptions: {
      camera_motion: "dolly_in",
      model: "must-not-override",
      prompt: "must-not-override",
      frame_images: [{ frame_type: "must-not-override" }],
    },
    frameBindings: [],
    visualInstructions: [],
    promptBrief,
    warnings: [],
  };
}

function draft(director: CompiledDirector): GenerationDraft {
  return {
    mode: "video",
    model: model.id,
    prompt: "A fruit truck crosses the market.",
    assets: [],
    options: { duration: 5 },
    providerJson: "",
    director,
  };
}

test("Director compilation merges native controls and a labeled brief without overriding protected request fields", () => {
  const payload = buildRequest(draft(compiled("Dolly in from 0% to 70%.")), model);

  assert.equal(payload.model, model.id);
  assert.equal(payload.camera_motion, "dolly_in");
  assert.equal(payload.frame_images, undefined);
  assert.match(String(payload.prompt), /A fruit truck crosses the market\./);
  assert.match(String(payload.prompt), /\[Director Brief\]/);
  assert.match(String(payload.prompt), /Dolly in from 0% to 70%\./);
  assert.doesNotMatch(String(payload.prompt), /must-not-override/);
});

test("prepared request freshness includes the complete compiled Director output", () => {
  const originalDraft = draft(compiled("Dolly in."));
  const prepared = prepareRequest(originalDraft, model);

  assert.equal(isPreparedRequestCurrent(prepared, originalDraft, model), true);
  assert.equal(
    isPreparedRequestCurrent(prepared, draft(compiled("Orbit left.")), model),
    false,
  );
});

test("video catalog normalization preserves only explicit Director capability metadata", () => {
  const normalized = normalizeVideoModel({
    id: "test/explicit-director",
    name: "Explicit Director model",
    director_capabilities: {
      supports_native_trajectory: true,
      max_keyframes: 3,
    },
    endpoints: [{
      endpoint_id: "route-1",
      provider_name: "Provider",
      provider_slug: "provider",
      supported_parameters: {},
      director_capabilities: { supports_visual_instruction: true },
    }],
  });

  assert.deepEqual(normalized?.director_capabilities, {
    supports_native_trajectory: true,
    max_keyframes: 3,
  });
  assert.deepEqual(normalized?.endpoints?.[0].director_capabilities, {
    supports_visual_instruction: true,
  });
});

test("timestamped Director frame anchors keep their timestamp in the provider reference", () => {
  const timestampModel: VideoModel = {
    id: "test/timestamped-director-video",
    name: "Timestamped Director video",
    input_reference_types: ["image"],
    max_input_references: 1,
  };
  const payload = buildRequest({
    mode: "video",
    model: timestampModel.id,
    prompt: "Bridge the keyed moment.",
    assets: [{
      id: "middle-frame",
      name: "middle.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,AA==",
      role: "reference",
      purpose: "composition",
      slot: 1,
      timestampSeconds: 2.5,
    }],
    options: {},
    providerJson: "",
  }, timestampModel);

  assert.deepEqual(payload.input_references, [{
    type: "image_url",
    image_url: { url: "data:image/png;base64,AA==" },
    timestamp_seconds: 2.5,
  }]);
});

test("visual instructions keep the source image and SVG guide as separate references", () => {
  const visualModel: VideoModel = {
    id: "test/visual-director-video",
    name: "Visual Director video",
    input_reference_types: ["image"],
    max_input_references: 2,
  };
  const payload = buildRequest({
    mode: "video",
    model: visualModel.id,
    prompt: "Follow the visual motion guide.",
    assets: [
      {
        id: "source-frame",
        name: "source.png",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,AA==",
        role: "reference",
        purpose: "composition",
        slot: 1,
      },
      {
        id: "director-guide",
        name: "Director motion guide.png",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,BB==",
        role: "reference",
        purpose: "motion",
        slot: 2,
      },
    ],
    options: {},
    providerJson: "",
  }, visualModel);

  assert.deepEqual(payload.input_references, [
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,BB==" } },
  ]);
});
