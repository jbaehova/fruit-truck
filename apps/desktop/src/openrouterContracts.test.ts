import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateReferenceRequestSize,
  generateImage,
  getCurrentKey,
  classifyCredentialError,
  normalizeCatalogItems,
  prepareRequest,
  preparedRequestPayload,
  resolveEligibleRoute,
  validateApiKeyCandidate,
  validateCredential,
  type ImageModel,
  type VideoModel,
} from "./openrouter.ts";
import {
  assessVideoReferenceTransport,
  buildVideoSupportMatrix,
  videoReferenceTransportForUrl,
} from "./modelPolicies.ts";
import {
  modelSearchMatches,
  normalizeModelSearchText,
  validateCapabilityOptions,
} from "./optionValues.ts";

test("catalog normalization isolates malformed items and preserves supported sizes/boolean descriptors", () => {
  const result = normalizeCatalogItems("image", {
    data: [
      {
        id: "valid/image",
        name: "Valid",
        supported_parameters: {
          size: { type: "enum", values: ["1024x1024"] },
          seed: { type: "boolean", min: 1 },
          broken: { type: "range", min: 4, max: 2 },
        },
        supported_sizes: ["1024x1024", 3],
      },
      { id: "missing-name" },
      { id: "valid/second", name: "Second", supported_parameters: {} },
    ],
  });
  assert.equal(result.models.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.models[0]?.supported_sizes, ["1024x1024"]);
  assert.deepEqual(result.models[0]?.supported_parameters.seed, { type: "boolean" });
  assert.equal(result.models[0]?.supported_parameters.broken, undefined);
});

test("route resolution uses the selected endpoint's capability and price", () => {
  const model: ImageModel = {
    id: "example/image",
    name: "Image",
    supported_parameters: { size: { type: "enum", values: ["1024x1024", "512x512"] } },
    endpoint_details: [
      {
        endpoint_id: "a-endpoint",
        provider_name: "Provider A",
        provider_slug: "a",
        supported_parameters: { size: { type: "enum", values: ["1024x1024"] } },
        pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.1 }],
      },
      {
        endpoint_id: "b-endpoint",
        provider_name: "Provider B",
        provider_slug: "b",
        supported_parameters: { size: { type: "enum", values: ["512x512"] } },
        pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.2 }],
      },
    ],
  };
  const resolution = resolveEligibleRoute({
    mode: "image",
    model,
    options: { size: "512x512" },
    providerJson: JSON.stringify({ only: ["b"] }),
  });
  assert.equal(resolution.selected?.providerSlug, "b");
  assert.equal(resolution.selected?.pricing?.[0]?.cost_usd, 0.2);
  assert.equal(resolution.definitive, true);
  assert.equal(resolution.errors.length, 0);
});

test("strict preparation blocks unproven video data/local references and freezes the exact payload", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Video",
    input_reference_types: ["image", "video", "audio"],
    max_input_references: 2,
  };
  const draft = {
    mode: "video" as const,
    model: model.id,
    prompt: "animate @1",
    assets: [{
      id: "one",
      name: "one.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      role: "reference" as const,
      purpose: "subject_identity" as const,
      slot: 1,
    }],
    options: {},
    providerJson: "",
  };
  const prepared = prepareRequest(draft, model);
  assert.equal(prepared.status, "blocked");
  assert.match(prepared.issues.map((issue) => issue.message).join(" "), /unverified/i);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.payload), true);
  assert.deepEqual(prepared.payload, prepared.sanitizedPayload);
});

test("final image preparation disables SSE for unproven reference and multi-output combinations", () => {
  const model: ImageModel = {
    id: "example/image",
    name: "Image",
    supported_parameters: { input_references: { type: "range", min: 1, max: 2 }, n: { type: "range", min: 1, max: 4 } },
    endpoint_details: [{
      endpoint_id: "image-route",
      provider_name: "Example Provider",
      provider_slug: "example",
      supported_parameters: { input_references: { type: "range", min: 1, max: 2 }, n: { type: "range", min: 1, max: 4 } },
      supports_streaming: true,
      pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.08 }],
      privacy: { zdr: true, data_collection: "deny" },
    }],
  };
  const draft = {
    mode: "image" as const,
    model: model.id,
    prompt: "새벽의 과일 트럭 @1",
    assets: [{ id: "one", name: "one.png", mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA", byteSize: 3, role: "reference" as const, purpose: "style" as const, slot: 1 }],
    options: { n: 2 },
    providerJson: JSON.stringify({ only: ["example"], zdr: true }),
  };
  const prepared = prepareRequest(draft, model, { final: true, catalogFingerprint: "catalog-1", sourceSignature: "review-1" });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.phase, "final");
  assert.equal(prepared.route?.providerSlug, "example");
  assert.equal(prepared.cost.totalMaxUsd, 0.16);
  assert.equal(prepared.privacy.zdr, "supported");
  assert.deepEqual((prepared.payload.provider as Record<string, unknown>).only, ["example"]);
  assert.equal(prepared.payload.stream, undefined);
  assert.equal(preparedRequestPayload(prepared), prepared.payload);
  assert.equal(Object.isFrozen(prepared.payload), true);
});

test("final image preparation enables SSE for the proven single text-to-image combination", () => {
  const model: ImageModel = {
    id: "example/image",
    name: "Image",
    supported_parameters: { n: { type: "range", min: 1, max: 4 } },
    endpoint_details: [{
      endpoint_id: "image-route",
      provider_name: "Example Provider",
      provider_slug: "example",
      supported_parameters: { n: { type: "range", min: 1, max: 4 } },
      supports_streaming: true,
      pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.08 }],
    }],
  };
  const prepared = prepareRequest({
    mode: "image",
    model: model.id,
    prompt: "a fruit truck",
    assets: [],
    options: { n: 1 },
    providerJson: "",
  }, model, { final: true });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.payload.stream, true);
});

test("live-shaped video catalog records are definitive for text-only paid requests", () => {
  const model: VideoModel = {
    id: "x-ai/grok-imagine-video",
    name: "Grok Imagine Video",
    supported_resolutions: ["480p", "720p"],
    supported_aspect_ratios: ["1:1", "16:9"],
    supported_durations: [1, 2],
    pricing_skus: { cents_per_video_output_second_480p: "5" },
  };
  const prepared = prepareRequest({
    mode: "video",
    model: model.id,
    prompt: "a fruit truck rolls forward",
    assets: [],
    options: { duration: 1, resolution: "480p", aspect_ratio: "1:1" },
    providerJson: "",
  }, model, { final: true });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.routeResolution.definitive, true);
  assert.equal(prepared.route?.contractSource, "video_catalog");
  assert.deepEqual(prepared.payload.provider, { require_parameters: true });
  assert.equal(prepared.cost.generationMaxUsd, 0.05);
});

test("verified endpoint permits HTTPS video references but never HTTP/data/local by default", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Video",
    endpoints: [{
      endpoint_id: "ep",
      provider_name: "Provider",
      provider_slug: "provider",
      input_reference_types: ["image"],
      max_input_references: 2,
      reference_transports: { image: ["https_url"] },
    }],
  };
  const matrix = buildVideoSupportMatrix(model);
  assert.equal(matrix.entries.find((entry) => entry.kind === "image" && entry.transport === "https_url")?.supported, true);
  assert.equal(matrix.entries.find((entry) => entry.kind === "image" && entry.transport === "data_url")?.supported, false);
  assert.equal(videoReferenceTransportForUrl("http://example.com/a.png"), "http_url");
  assert.equal(videoReferenceTransportForUrl("fruit-truck-local:/tmp/a.png"), "local_file");
  assert.equal(videoReferenceTransportForUrl("https://example.com/a.png"), "https_url");
});

test("options enforce boolean/enum/range semantics and size conflicts", () => {
  const issues = validateCapabilityOptions({
    seed: "false",
    size: "1024x1024",
    resolution: "1080p",
    unknown: true,
  }, {
    seed: { type: "boolean" },
    size: { type: "enum", values: ["1024x1024"] },
    resolution: { type: "enum", values: ["1080p"] },
  });
  assert.equal(issues.some((issue) => issue.code === "invalid_type" && issue.field === "seed"), true);
  assert.equal(issues.some((issue) => issue.code === "conflicting_options"), true);
  assert.equal(issues.some((issue) => issue.code === "unsupported_option" && issue.field === "unknown"), true);
  assert.equal(validateCapabilityOptions({ seed: 42 }, { seed: { type: "boolean" } }).length, 0);
  assert.equal(validateCapabilityOptions({ negative_prompt: false }, { negative_prompt: { type: "boolean" } })[0]?.code, "invalid_type");
});

test("aggregate video max_input_references is not duplicated across kinds", () => {
  const model: VideoModel = {
    id: "example/video",
    name: "Video",
    input_reference_types: ["image", "video", "audio"],
    max_input_references: 2,
  };
  const matrix = buildVideoSupportMatrix(model);
  assert.equal(matrix.entries.find((entry) => entry.kind === "image")?.aggregateLimit, 2);
  const issues = assessVideoReferenceTransport(model, ["image", "video", "audio"].map((kind, index) => ({
    slot: index + 1,
    kind: kind as "image" | "video" | "audio",
    transport: "data_url" as const,
  })));
  assert.equal(issues.some((issue) => issue.code === "too_many_references" && issue.limit === 2), true);
});

test("reference size accounting exposes raw/base64/JSON budgets", () => {
  const assets = [{ id: "a", name: "a", mediaType: "image/png", dataUrl: `data:image/png;base64,${"A".repeat(16)}`, role: "reference" as const, purpose: "context" as const, slot: 1, byteSize: 20 }];
  const budget = estimateReferenceRequestSize(assets, undefined, { perAssetBytes: 10, rawBytes: 10, base64Bytes: 10, jsonBytes: 10 });
  assert.equal(budget.rawBytes, 20);
  assert.equal(budget.base64Bytes, 16);
  assert.equal(budget.withinLimit, false);
  assert.ok(budget.issues.length >= 3);
});

test("local reference markers project native Base64 expansion before hydration", () => {
  const rawBytes = 24 * 1024 * 1024;
  const assets = [{ id: "local", name: "local", mediaType: "image/png", dataUrl: "local-asset://#1/local.png", role: "reference" as const, purpose: "context" as const, slot: 1, byteSize: rawBytes }];
  const budget = estimateReferenceRequestSize(assets);
  assert.equal(budget.rawBytes, rawBytes);
  assert.equal(budget.base64Bytes, Math.ceil(rawBytes / 3) * 4);
  assert.ok(budget.jsonBytes > budget.base64Bytes);
});

test("model search normalizes FLUX punctuation and provider aliases", () => {
  assert.equal(normalizeModelSearchText("Black Forest Labs: FLUX.2"), "black forest labs flux 2");
  assert.equal(modelSearchMatches({ id: "black-forest-labs/flux.2-pro", name: "FLUX.2 Pro" }, "flux 2"), true);
  assert.equal(modelSearchMatches({ id: "black-forest-labs/flux.2-pro", name: "FLUX.2 Pro" }, "bfl"), true);
});

test("GET key metadata remains typed while paid POST transport retries are disabled", async () => {
  const runtime = globalThis as unknown as { window?: { localStorage: { getItem: () => string | null } } };
  const previousWindow = runtime.window;
  const previousFetch = globalThis.fetch;
  runtime.window = { localStorage: { getItem: () => "sk-or-test" } };
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: false, status: 503, headers: new Headers(), text: async () => "busy" } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(getCurrentKey(), /OpenRouter 503/);
    assert.equal(calls, 4); // GET is safe to retry.
    calls = 0;
    await assert.rejects(generateImage({ model: "example/image", prompt: "test" }), /OpenRouter 503/);
    assert.equal(calls, 1); // Paid POST is never transport-retried.
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  }
});

test("credential validation unwraps key metadata and classifies transport/auth failures", async () => {
  const runtime = globalThis as unknown as { window?: { localStorage: { getItem: () => string | null } } };
  const previousWindow = runtime.window;
  const previousFetch = globalThis.fetch;
  runtime.window = { localStorage: { getItem: () => "sk-or-test" } };
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { label: "Test key", limit_remaining: 1.25 } }),
  }) as Response) as typeof fetch;
  try {
    const key = await getCurrentKey();
    assert.deepEqual(key, { label: "Test key", limit_remaining: 1.25 });
    assert.deepEqual(await validateCredential(), { status: "connected", key: { label: "Test key", limit_remaining: 1.25 } });
    assert.equal(classifyCredentialError(Object.assign(new Error("bad key"), { status: 401 })), "unauthorized");
    assert.equal(classifyCredentialError(Object.assign(new Error("busy"), { status: 429 })), "rate_limited");
    assert.equal(classifyCredentialError(new TypeError("fetch failed")), "offline");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  }
});

test("candidate credential validation restores the existing browser credential", async () => {
  const values = new Map([["fruit-truck.dev-key", "existing-key"]]);
  const runtime = globalThis as unknown as { window?: { localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void } } };
  const previousWindow = runtime.window;
  const previousFetch = globalThis.fetch;
  runtime.window = { localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  } };
  globalThis.fetch = (async (_url, init) => ({
    ok: init?.headers instanceof Headers
      ? init.headers.get("Authorization") === "Bearer candidate-key"
      : (init?.headers as Record<string, string> | undefined)?.Authorization === "Bearer candidate-key",
    status: 200,
    json: async () => ({ data: { label: "candidate" } }),
    text: async () => "",
    headers: new Headers(),
  }) as Response) as typeof fetch;
  try {
    assert.equal((await validateApiKeyCandidate("candidate-key")).valid, true);
    assert.equal(values.get("fruit-truck.dev-key"), "existing-key");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  }
});
