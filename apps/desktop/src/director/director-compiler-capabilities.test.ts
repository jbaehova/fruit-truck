import assert from "node:assert/strict";
import test from "node:test";
import type { VideoModel, VideoModelEndpoint } from "../openrouter.ts";
import {
  resolveDirectorCapability,
  resolveRunnableDirectorCapability,
  unsupportedDirectorCapability,
  type DirectorCapabilityFixture,
} from "./capabilities.ts";

test("capability resolution never infers support from a model id or name", () => {
  const model: VideoModel = {
    id: "runway/native-trajectory-multishot-first-last",
    name: "First Last Frames and Camera Control",
  };
  const capability = resolveDirectorCapability({ model });

  assert.equal(capability.supportsFirstFrame, false);
  assert.equal(capability.supportsLastFrame, false);
  assert.equal(capability.supportsNativeTrajectory, false);
  assert.equal(capability.supportsMultiShot, false);
  assert.deepEqual([...capability.cameraParameters], []);
});

test("explicit endpoint metadata is authoritative and produces field provenance", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Example",
    supported_frame_images: ["first_frame", "last_frame"],
    supported_parameters: { trajectory: { type: "boolean" } },
  };
  const endpoint: VideoModelEndpoint = {
    endpoint_id: "route-a",
    provider_name: "Provider",
    provider_slug: "provider",
    supported_frame_images: ["first_frame"],
    supported_parameters: {
      camera_motion: { type: "enum", values: ["dolly", "orbit"] },
      keyframes: { type: "range", min: 1, max: 4 },
      trajectory: { type: "boolean" },
    },
    allowed_passthrough_parameters: ["focal_length_mm"],
  };
  const capability = resolveDirectorCapability({ model, endpoint });

  assert.equal(capability.supportsFirstFrame, true);
  assert.equal(capability.supportsLastFrame, false);
  assert.equal(capability.supportsNativeTrajectory, true);
  assert.equal(capability.maxKeyframes, 4);
  assert.deepEqual([...capability.cameraParameters], ["camera_motion"]);
  assert.deepEqual([...capability.allowedPassthroughParameters], ["focal_length_mm"]);
  assert.deepEqual(capability.parameterDescriptors?.camera_motion, { type: "enum", values: ["dolly", "orbit"] });
  assert.equal(capability.provenance.supportsLastFrame, "live_endpoint");
});

test("multi-shot native mapping preserves an explicit provider field and shape contract", () => {
  const endpoint: VideoModelEndpoint = {
    endpoint_id: "route-shots",
    provider_name: "Provider",
    provider_slug: "provider",
    director_capabilities: {
      supports_multi_shot: true,
      multi_shot_contract: { parameter: "shot_sequence", shape: "object_with_shots" },
    },
  };
  const capability = resolveDirectorCapability({
    model: { id: "example/video", name: "Example" },
    endpoint,
  });

  assert.equal(capability.supportsMultiShot, true);
  assert.deepEqual(capability.multiShotContract, {
    parameter: "shot_sequence",
    shape: "object_with_shots",
  });
});

test("explicit false endpoint evidence overrides positive model-level metadata", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Example",
    director_capabilities: {
      supports_native_trajectory: true,
      supports_multi_shot: true,
    },
  };
  const endpoint: VideoModelEndpoint = {
    endpoint_id: "route-a",
    provider_name: "Provider",
    provider_slug: "provider",
    director_capabilities: {
      supports_native_trajectory: false,
      supports_multi_shot: false,
    },
  };
  const capability = resolveDirectorCapability({ model, endpoint });

  assert.equal(capability.supportsNativeTrajectory, false);
  assert.equal(capability.supportsMultiShot, false);
  assert.equal(capability.provenance.supportsNativeTrajectory, "live_endpoint");
});

test("explicit frame parameter descriptors resolve without using model-name heuristics", () => {
  const capability = resolveDirectorCapability({
    model: {
      id: "opaque/model",
      name: "Opaque",
      supported_parameters: {
        frame_images: { type: "enum", values: ["first_frame", "last_frame"] },
      },
    },
  });

  assert.equal(capability.supportsFirstFrame, true);
  assert.equal(capability.supportsLastFrame, true);
  assert.equal(capability.maxKeyframes, 2);
});

test("dated contract fixtures fill only fields missing from live evidence", () => {
  const fixture: DirectorCapabilityFixture = {
    modelId: "example/video",
    reviewedAt: "2026-08-13",
    source: "https://provider.example/video-contract",
    supportsFirstFrame: true,
    supportsLastFrame: true,
    maxKeyframes: 8,
    supportsMultiShot: true,
    supportsNativeTrajectory: true,
  };
  const capability = resolveDirectorCapability({
    model: { id: "example/video", name: "Example", supported_frame_images: ["first_frame"] },
    fixture,
  });

  assert.equal(capability.supportsFirstFrame, true);
  assert.equal(capability.supportsLastFrame, false);
  assert.equal(capability.maxKeyframes, 8);
  assert.equal(capability.supportsMultiShot, true);
  assert.equal(capability.supportsNativeTrajectory, true);
  assert.equal(capability.provenance.supportsLastFrame, "live_catalog");
  assert.equal(capability.provenance.maxKeyframes, "contract_fixture");
  assert.equal(capability.provenance.supportsMultiShot, "contract_fixture");
});

test("undated or unsourced fixtures fail closed", () => {
  const capability = resolveDirectorCapability({
    model: { id: "example/video", name: "Example" },
    fixtures: [{
      modelId: "example/video",
      reviewedAt: "",
      source: "",
      supportsNativeTrajectory: true,
    }],
  });

  assert.equal(capability.supportsNativeTrajectory, false);
  assert.equal(capability.provenance.supportsNativeTrajectory, "unsupported");
  assert.match(capability.warnings.join(" "), /ignored/i);
});

test("impossible calendar dates do not qualify a fixture as checked evidence", () => {
  const capability = resolveDirectorCapability({
    model: { id: "example/video", name: "Example" },
    fixture: {
      modelId: "example/video",
      reviewedAt: "2026-02-31",
      source: "provider contract archive",
      supportsMultiShot: true,
    },
  });

  assert.equal(capability.supportsMultiShot, false);
  assert.equal(capability.provenance.supportsMultiShot, "unsupported");
});

test("unsupported capability returns fresh fail-closed sets", () => {
  const first = unsupportedDirectorCapability();
  const second = unsupportedDirectorCapability();
  assert.notEqual(first.cameraParameters, second.cameraParameters);
  assert.equal(first.maxKeyframes, 0);
  assert.equal(first.supportsVisualInstruction, false);
});

test("visual overlays require a verified image data URL transport", () => {
  const endpoint: VideoModelEndpoint = {
    endpoint_id: "route-a",
    provider_name: "Provider",
    provider_slug: "provider",
    input_reference_types: ["image"],
    reference_transports: { image: ["https_url"] },
    director_capabilities: { supports_visual_instruction: true },
  };
  const model: VideoModel = {
    id: "example/video",
    name: "Example",
    endpoints: [endpoint],
  };
  const route = {
    mode: "video" as const,
    modelId: model.id,
    routeId: "route-a",
    providerName: endpoint.provider_name,
    providerSlug: endpoint.provider_slug,
    endpoint,
    capabilities: {},
    allowedPassthroughParameters: [],
    pricingSkus: {},
    endpointVerified: true,
    privacy: {},
  };

  const withoutData = resolveRunnableDirectorCapability(model, route);
  assert.equal(withoutData.supportsVisualInstruction, false);
  assert.equal(withoutData.provenance.supportsVisualInstruction, "unsupported");
  assert.match(withoutData.warnings.join(" "), /verified image data URL transport/i);

  const dataEndpoint = {
    ...endpoint,
    reference_transports: { image: ["data_url" as const] },
  };
  const withData = resolveRunnableDirectorCapability(
    { ...model, endpoints: [dataEndpoint] },
    { ...route, endpoint: dataEndpoint },
  );
  assert.equal(withData.supportsVisualInstruction, true);
});
