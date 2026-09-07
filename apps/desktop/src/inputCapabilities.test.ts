import assert from "node:assert/strict";
import test from "node:test";
import { availableInputRoles, modelForInputControls, optionsForInputReferences, resolveInputCapabilities, videoImageReferences } from "./inputCapabilities.ts";
import { prepareRequest, referenceCoverageReport, type ImageModel, type VideoModel, type VideoModelEndpoint } from "./openrouter.ts";
import { assessInputConstraints, assessVideoReferenceTransport } from "./modelPolicies.ts";
import type { DraftReference } from "./studio.ts";

const image = { id: "image", kind: "image" as const };
const second = { id: "second", kind: "image" as const };
function endpoint(patch: Partial<VideoModelEndpoint> = {}): VideoModelEndpoint {
  return {
    endpoint_id: "route", provider_name: "Provider", provider_slug: "provider",
    input_reference_types: ["image"], max_input_references: 3,
    supported_frame_images: ["first_frame", "last_frame"],
    reference_transports: { image: ["data_url"] },
    supported_parameters: { duration: { type: "enum", values: [5] } },
    ...patch,
  };
}
function video(routes = [endpoint()]): VideoModel {
  return {
    id: "test/video", name: "Video",
    input_reference_types: ["image", "video", "audio"], max_input_references: 9,
    supported_frame_images: ["first_frame", "last_frame"], supported_durations: [5, 10],
    endpoints: routes,
  };
}
const binding = (assetId: string, slot: number, role: DraftReference["role"]): DraftReference => ({ assetId, slot, role, purpose: role === "reference" ? "composition" : role });

test("image input minimum and maximum come from the selected endpoint", () => {
  const model: ImageModel = {
    id: "test/image", name: "Image", supported_parameters: { input_references: { type: "range", max: 8 } },
    endpoint_details: [{ endpoint_id: "image-route", provider_name: "Image Provider", provider_slug: "image-provider", supported_parameters: { input_references: { type: "range", min: 1, max: 2 } } }],
  };
  const support = resolveInputCapabilities("image", model);
  assert.equal(support.limit, 2);
  assert.equal(support.minimum, 1);
  assert.deepEqual(availableInputRoles(support, [], [], image), ["reference"]);
  assert.deepEqual(availableInputRoles(support, [], [], { id: "video", kind: "video" }), []);
  assert.deepEqual(availableInputRoles(support, [binding("image", 1, "reference"), binding("second", 2, "reference")], [image, second], image), []);
});

test("first-frame-only models accept one frame even with zero general references", () => {
  const model = video([endpoint({ input_reference_types: [], max_input_references: 0, supported_frame_images: ["first_frame"] })]);
  const support = resolveInputCapabilities("video", model);
  assert.equal(support.limit, 1);
  assert.equal(support.referenceLimit, 0);
  assert.deepEqual(availableInputRoles(support, [], [], image), ["first_frame"]);
  assert.deepEqual(availableInputRoles(support, [binding("image", 1, "first_frame")], [image], second), []);
  const draft = {
    mode: "video" as const, model: model.id, prompt: "Animate the opening image.", options: { duration: 5 }, providerJson: "",
    assets: [{ id: "image", name: "frame.png", slot: 1, role: "first_frame" as const, purpose: "first_frame" as const, mediaType: "image/png", dataUrl: "data:image/png;base64,AA==" }],
  };
  const request = prepareRequest(draft, model, { final: true, route: support.route });
  assert.equal(request.status, "ready", JSON.stringify(request.issues));
  assert.equal(referenceCoverageReport(draft, model, request.sanitizedPayload, undefined, support.route)[0].severity, "ok");
});

test("frame pairs choose the unoccupied boundary and never duplicate first frames", () => {
  const support = resolveInputCapabilities("video", video([endpoint({ input_reference_types: [], max_input_references: 0 })]));
  const first = binding("image", 1, "first_frame");
  assert.deepEqual(availableInputRoles(support, [], [], image), ["first_frame", "last_frame"]);
  assert.deepEqual(availableInputRoles(support, [first], [image], second), ["last_frame"]);
  const last = binding("second", 2, "last_frame");
  assert.deepEqual(availableInputRoles(support, [first, last], [image, second], second, 2), ["last_frame"]);
});

test("reference quotas and exclusive input styles apply before attachment", () => {
  const support = resolveInputCapabilities("video", video([endpoint({ max_input_references: 2 })]));
  assert.equal(support.limit, 2);
  const refs = [binding("image", 1, "reference")];
  assert.deepEqual(availableInputRoles(support, refs, [image], second), ["reference"]);
  assert.deepEqual(availableInputRoles(support, [binding("image", 1, "first_frame")], [image], second), ["last_frame"]);
  assert.deepEqual(availableInputRoles(support, refs, [image], image, 1), ["reference", "first_frame", "last_frame"]);
});

test("provider changes narrow both input roles and output controls", () => {
  const model = video([endpoint(), endpoint({
    endpoint_id: "limited", provider_slug: "limited", max_input_references: 1, supported_frame_images: ["first_frame"],
    supported_parameters: { duration: { type: "enum", values: [8] }, resolution: { type: "enum", values: ["720p"] } },
  })]);
  const support = resolveInputCapabilities("video", model, { duration: 8 }, '{"only":["limited"]}');
  assert.equal(support.limit, 1);
  assert.deepEqual(support.roles.image, ["reference", "first_frame"]);
  assert.deepEqual(support.roles.video, []);
  const controls = modelForInputControls(support) as VideoModel;
  assert.deepEqual(controls.supported_durations, [8]);
  assert.deepEqual(controls.supported_resolutions, ["720p"]);
  assert.equal(controls.generate_audio, false);
  // Old incompatible values do not hide the controls needed to repair them.
  assert.equal(resolveInputCapabilities("video", model, { duration: 99 }, '{"only":["limited"]}').limit, 1);
  assert.equal(resolveInputCapabilities("video", model, {}, '{"only":["missing"]}').limit, 0);
});

test("reference transport limits do not incorrectly disable declared frame uploads", () => {
  const support = resolveInputCapabilities("video", video([endpoint({ reference_transports: { image: ["https_url"] } })]));
  assert.deepEqual(availableInputRoles(support, [], [], image), ["first_frame", "last_frame"]);
  assert.ok(availableInputRoles(support, [], [], { ...image, externalUrl: "https://example.com/frame.png" }).length > 0);
  assert.deepEqual(availableInputRoles(support, [], [], { ...image, storageAvailability: "missing" }), []);
});

test("mixed media share the endpoint's aggregate reference quota", () => {
  const support = resolveInputCapabilities("video", video([endpoint({ input_reference_types: ["image", "audio"], max_input_references: 2, supported_frame_images: [], reference_transports: { image: ["data_url"], audio: ["data_url"] } })]));
  const audio = { id: "audio", kind: "audio" as const };
  const refs = [binding("image", 1, "reference"), binding("audio", 2, "reference")];
  assert.equal(support.limit, 2);
  assert.deepEqual(availableInputRoles(support, refs, [image, audio], second), []);
});

test("frames have independent quotas while general reference transport caps still apply", () => {
  const route = endpoint({ max_input_references: 1 });
  const model = video([route]);
  assert.deepEqual(assessVideoReferenceTransport(model, [
    { slot: 1, kind: "image", transport: "data_url", role: "first_frame" },
    { slot: 2, kind: "image", transport: "data_url", role: "last_frame" },
  ], route), []);
  assert.ok(assessVideoReferenceTransport(model, [
    { slot: 1, kind: "image", transport: "data_url", role: "reference" },
    { slot: 2, kind: "image", transport: "data_url", role: "reference" },
  ], route).some((issue) => issue.code === "too_many_references"));
});

test("endpoint aggregate limits do not widen documented per-kind limits", () => {
  const route = endpoint({ max_input_references: 12 });
  const model = { ...video([route]), id: "bytedance/seedance-2.0" };
  const support = resolveInputCapabilities("video", model);
  assert.equal(support.referenceLimits.image, 9);
  assert.ok(assessInputConstraints({
    mode: "video", modelId: model.id, endpoint: route, limit: 12,
    allowedRoles: ["reference"], references: Array.from({ length: 10 }, (_, slot) => ({ slot, kind: "image", role: "reference" })),
  }).some((issue) => issue.code === "too_many_inputs" && issue.limit === 9));
});

test("generated images replace the opening frame or use a supported reference role", () => {
  const frameSupport = resolveInputCapabilities("video", video([endpoint({ max_input_references: 0, supported_frame_images: ["first_frame"] })]));
  assert.deepEqual(videoImageReferences(frameSupport, [binding("image", 4, "first_frame")], [image, second], second), [binding("second", 4, "first_frame")]);
  const referenceSupport = resolveInputCapabilities("video", video([endpoint({ supported_frame_images: [], max_input_references: 1 })]));
  assert.deepEqual(videoImageReferences(referenceSupport, [], [image], image), [binding("image", 1, "reference")]);
  assert.equal(videoImageReferences(referenceSupport, [binding("image", 1, "reference")], [image, second], second), null);
  const textSupport = resolveInputCapabilities("video", video([endpoint({ supported_frame_images: [], max_input_references: 0 })]));
  assert.equal(videoImageReferences(textSupport, [], [image], image), null);
});


test("live Seedance frames and documented references enable local image attachments", () => {
  const model: VideoModel = { id: "bytedance/seedance-2.5", name: "Seedance 2.5", supported_frame_images: ["first_frame", "last_frame"] };
  const support = resolveInputCapabilities("video", model);
  assert.equal(support.referenceLimit, 50);
  assert.equal(support.limit, 50);
  assert.deepEqual(availableInputRoles(support, [], [], image), ["reference", "first_frame"]);
  assert.deepEqual(availableInputRoles(support, [binding("image", 1, "first_frame")], [image], second), ["last_frame"]);
});


test("Veo references share one asset type and automatically use reference-workflow options", () => {
  const model: VideoModel = {
    id: "google/veo-3.1", name: "Veo 3.1",
    supported_frame_images: ["first_frame", "last_frame"],
    supported_durations: [4, 6, 8], supported_resolutions: ["720p", "1080p", "4k"],
    supported_aspect_ratios: ["16:9", "9:16"],
  };
  const support = resolveInputCapabilities("video", model);
  assert.equal(support.referenceLimits.image, 3);
  assert.equal(support.rules?.referenceImageType, "asset");
  assert.equal(support.rules?.homogeneousReferenceImages, true);
  assert.equal(support.rules?.referencePurposeTransport, "prompt_only");
  assert.deepEqual(availableInputRoles(support, [], [], image), ["reference", "first_frame"]);
  assert.deepEqual(availableInputRoles(support, [binding("image", 1, "first_frame")], [image], second), ["last_frame"]);
  const references = [binding("image", 1, "reference")];
  assert.deepEqual((modelForInputControls(support, references) as VideoModel).supported_durations, [8]);
  assert.deepEqual((modelForInputControls(support, references) as VideoModel).supported_resolutions, ["720p", "1080p"]);
  assert.deepEqual(optionsForInputReferences(support, references, { duration: 4, resolution: "4k", aspect_ratio: "16:9" }), { duration: 8, resolution: "720p", aspect_ratio: "16:9" });
  assert.deepEqual((modelForInputControls(support) as VideoModel).supported_durations, [4, 6, 8]);
  const fast = resolveInputCapabilities("video", { ...model, id: "google/veo-3.1-fast" });
  assert.deepEqual((modelForInputControls(fast, references) as VideoModel).supported_durations, [4, 6, 8]);
  const lite = resolveInputCapabilities("video", { ...model, id: "google/veo-3.1-lite" });
  assert.equal(lite.referenceLimits.image, 0);
  assert.deepEqual(availableInputRoles(lite, [], [], image), ["first_frame"]);
});

test("role edits cannot introduce mixtures that OpenRouter would silently discard", () => {
  const support = resolveInputCapabilities("video", video());
  const references = [binding("image", 1, "reference"), binding("second", 2, "reference")];
  assert.deepEqual(availableInputRoles(support, references, [image, second], image, 1), ["reference"]);
  const frames = [binding("image", 1, "first_frame"), binding("second", 2, "last_frame")];
  assert.deepEqual(availableInputRoles(support, frames, [image, second], image, 1), ["first_frame"]);
});
