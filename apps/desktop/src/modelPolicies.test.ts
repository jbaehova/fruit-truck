import test from "node:test";
import assert from "node:assert/strict";
import {
  applyVideoCapabilityProvenance,
  explainGenerationError,
  modelPolicyNotices,
  validateInputConstraints,
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
    modelId: "minimax/hailuo-2.3",
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

test("provider input formats, codecs, and audio dependencies fail before submission", () => {
  const gif = validateInputConstraints({
    mode: "video",
    modelId: "minimax/hailuo-3",
    allowedRoles: ["reference", "first_frame", "last_frame"],
    limit: 11,
    references: [{ slot: 1, role: "reference", kind: "image", mimeType: "image/gif" }],
  });
  assert.equal(gif?.code, "unsupported_media_format");

  const audioWithoutImage = validateInputConstraints({
    mode: "video",
    modelId: "minimax/hailuo-3",
    allowedRoles: ["reference", "first_frame", "last_frame"],
    limit: 11,
    references: [
      { slot: 1, role: "reference", kind: "video", codec: "h264" },
      { slot: 2, role: "reference", kind: "audio", codec: "aac" },
    ],
  });
  assert.equal(audioWithoutImage?.code, "audio_requires_image");

  const badCodec = validateInputConstraints({
    mode: "video",
    modelId: "runway/aleph-2",
    allowedRoles: ["reference"],
    limit: 6,
    references: [{ slot: 1, role: "reference", kind: "video", codec: "wmv3" }],
  });
  assert.equal(badCodec?.code, "unsupported_media_codec");
});
