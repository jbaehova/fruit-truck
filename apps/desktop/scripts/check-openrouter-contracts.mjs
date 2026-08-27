#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyImageModelEndpoints,
  buildRequest,
  catalogFingerprint,
  loadImageModelEndpoints,
  normalizeImageCatalog,
  normalizeVideoCatalog,
  prepareRequest,
  resolveEligibleRoute,
} from "../src/openrouter.ts";
import { buildVideoSupportMatrix } from "../src/modelPolicies.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const defaultFixtureDirectory = resolve(desktopDirectory, "fixtures/openrouter");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertAnonymized(value, label, seen = new WeakSet()) {
  if (typeof value === "string") {
    assert.equal(/sk-or-[A-Za-z0-9_-]+/i.test(value), false, `${label} contains an API key-like value.`);
    assert.equal(/(?:authorization|bearer)\s*[:=]/i.test(value), false, `${label} contains an authorization value.`);
    assert.equal(/https?:\/\/(?!assets\.example\.invalid)/i.test(value), false, `${label} contains a non-fixture URL.`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAnonymized(item, `${label}[${index}]`, seen));
    return;
  }
  Object.entries(value).forEach(([key, nested]) => assertAnonymized(nested, `${label}.${key}`, seen));
}

function assertFixtureEnvelope(fixture, expectedFixture, path) {
  assert.equal(fixture.fixture, expectedFixture, `${path} has an unexpected fixture name.`);
  assert.equal(fixture.anonymized, true, `${path} must declare anonymized=true.`);
  assert.match(fixture.contract, /^(?:catalog|image-endpoints|video-endpoints)-v\d+$/u, `${path} has no versioned contract marker.`);
  assertAnonymized(fixture, path);
}

function fixtureModels(catalog, endpointFixture, mode) {
  assert.ok(Array.isArray(catalog.data), `${mode} catalog fixture data must be an array.`);
  assert.ok(endpointFixture.models && typeof endpointFixture.models === "object", `${mode} endpoint fixture models must be an object.`);
  return catalog.data.map((model) => {
    const endpointData = endpointFixture.models[model.id];
    assert.ok(endpointData && Array.isArray(endpointData.endpoints), `${mode} endpoint fixture is missing ${model.id}.`);
    assert.ok(endpointData.endpoints.length > 0, `${mode} endpoint fixture has no endpoints for ${model.id}.`);
    return mode === "image"
      ? { ...model, endpoint_details: endpointData.endpoints }
      : { ...model, endpoints: endpointData.endpoints };
  });
}

function referenceAsset(kind, url, purpose = "context") {
  return {
    id: `fixture-${kind}-reference`,
    name: `fixture-${kind}.png`,
    mediaType: "image/png",
    dataUrl: url,
    role: "reference",
    purpose,
    slot: 1,
    byteSize: 32,
  };
}

function smokeDraft(mode, model, smoke) {
  const assets = smoke.referenceCount > 0
    ? [referenceAsset(mode, mode === "video" ? "https://assets.example.invalid/fixture/reference.png" : "data:image/png;base64,iVBORw0KGgo=")]
    : [];
  return {
    mode,
    model: model.id,
    prompt: assets.length ? "A calm subject based on @1" : "A calm abstract subject",
    assets,
    options: smoke.options,
    providerJson: JSON.stringify({ only: [smoke.provider] }),
  };
}

function validateCatalogFixture(mode, catalog, endpointFixture) {
  const normalize = mode === "image" ? normalizeImageCatalog : normalizeVideoCatalog;
  const expected = catalog.expected;
  assert.ok(expected && Array.isArray(expected.modelIds), `${mode} catalog has no expected model IDs.`);
  assert.ok(expected.modelIds.length >= expected.minimumModels, `${mode} catalog expected model count is too small.`);
  assert.deepEqual(
    Object.keys(endpointFixture.models ?? {}).sort(),
    catalog.data.map((model) => model.id).sort(),
    `${mode} catalog and endpoint fixture model sets drifted.`,
  );

  const bare = normalize(catalog);
  assert.equal(bare.rejected.length, 0, `${mode} catalog fixture rejected ${bare.rejected.length} item(s).`);
  assert.deepEqual(bare.models.map((model) => model.id), expected.modelIds, `${mode} catalog model IDs drifted.`);

  const hydratedRawModels = fixtureModels(catalog, endpointFixture, mode);
  const hydrated = normalize({ ...catalog, data: hydratedRawModels });
  assert.equal(hydrated.rejected.length, 0, `${mode} endpoint fixture rejected ${hydrated.rejected.length} item(s).`);
  assert.equal(hydrated.models.length, expected.modelIds.length, `${mode} hydrated model count drifted.`);
  assert.ok(expected.smoke && typeof expected.smoke === "object", `${mode} catalog has no smoke cases.`);

  const providers = new Set();
  hydrated.models.forEach((model) => {
    const endpointList = mode === "image" ? model.endpoint_details : model.endpoints;
    assert.ok(endpointList?.length, `${mode} model ${model.id} has no normalized endpoint metadata.`);
    endpointList.forEach((endpoint) => providers.add(endpoint.provider_slug));
    const smoke = expected.smoke[model.id];
    assert.ok(smoke, `${mode} catalog has no smoke case for ${model.id}.`);
    assert.equal(smoke.referenceCount, smoke.referenceCount > 0 ? 1 : 0, `${mode} smoke reference count must be 0 or 1.`);

    const hydratedModel = mode === "image"
      ? applyImageModelEndpoints(model, endpointList)
      : model;
    const routeResolution = resolveEligibleRoute({
      mode,
      model: hydratedModel,
      options: smoke.options,
      providerJson: JSON.stringify({ only: [smoke.provider] }),
    });
    assert.equal(routeResolution.errors.length, 0, `${mode} route contract rejected ${model.id}: ${routeResolution.errors.map((issue) => issue.message).join("; ")}`);
    assert.equal(routeResolution.selected?.providerSlug, smoke.provider, `${mode} provider route drifted for ${model.id}.`);
    assert.equal(routeResolution.selected?.endpointVerified, true, `${mode} route must be endpoint verified for ${model.id}.`);
    assert.equal(routeResolution.definitive, true, `${mode} smoke route must be definitive for ${model.id}.`);

    const prepared = prepareRequest(smokeDraft(mode, hydratedModel, smoke), hydratedModel, {
      route: routeResolution.selected,
      catalogFingerprint: catalogFingerprint([hydratedModel]),
      final: false,
    });
    assert.equal(prepared.status, "ready", `${mode} prepared request was blocked for ${model.id}: ${prepared.issues.map((issue) => issue.message).join("; ")}`);
    assert.equal(prepared.route?.providerSlug, smoke.provider, `${mode} prepared route drifted for ${model.id}.`);
    assert.equal(prepared.cost.known, true, `${mode} smoke cost is not known for ${model.id}.`);
    assert.equal(prepared.privacy.endpointVerified, true, `${mode} smoke privacy route is not verified for ${model.id}.`);

    if (mode === "video") {
      const matrix = buildVideoSupportMatrix(hydratedModel, routeResolution.selected.endpoint);
      if (smoke.referenceTransport) {
        const supported = matrix.entries.find((entry) => entry.kind === "image" && entry.transport === smoke.referenceTransport);
        assert.equal(supported?.supported, true, `video ${model.id} no longer advertises ${smoke.referenceTransport}.`);
        const unverified = matrix.entries.find((entry) => entry.kind === "image" && entry.transport === "data_url");
        assert.equal(unverified?.supported, false, `video ${model.id} unexpectedly permits data_url references.`);
      }
    } else {
      const request = buildRequest(smokeDraft(mode, hydratedModel, smoke), hydratedModel);
      assert.equal(request.model, model.id, `image request model drifted for ${model.id}.`);
    }
  });

  const expectedProviders = endpointFixture.expected?.providerFamilies ?? [];
  expectedProviders.forEach((provider) => assert.equal(providers.has(provider), true, `${mode} endpoint family ${provider} is missing.`));
  assert.ok(providers.size >= 2, `${mode} fixture must cover multiple provider families.`);
  return { models: hydrated.models.length, providers: providers.size };
}

export function validateFixtureContracts(fixtureDirectory = defaultFixtureDirectory) {
  const imageCatalog = readJson(resolve(fixtureDirectory, "image-catalog.json"));
  const imageEndpoints = readJson(resolve(fixtureDirectory, "image-endpoints.json"));
  const videoCatalog = readJson(resolve(fixtureDirectory, "video-catalog.json"));
  const videoEndpoints = readJson(resolve(fixtureDirectory, "video-endpoints.json"));
  assertFixtureEnvelope(imageCatalog, "openrouter-image-catalog", "image-catalog.json");
  assertFixtureEnvelope(imageEndpoints, "openrouter-image-endpoints", "image-endpoints.json");
  assertFixtureEnvelope(videoCatalog, "openrouter-video-catalog", "video-catalog.json");
  assertFixtureEnvelope(videoEndpoints, "openrouter-video-endpoints", "video-endpoints.json");
  assert.equal(imageEndpoints.expected.minimumModels, imageCatalog.expected.minimumModels, "image fixture expectations disagree on model count.");
  assert.equal(videoEndpoints.expected.minimumModels, videoCatalog.expected.minimumModels, "video fixture expectations disagree on model count.");
  return {
    image: validateCatalogFixture("image", imageCatalog, imageEndpoints),
    video: validateCatalogFixture("video", videoCatalog, videoEndpoints),
  };
}

function liveWindow(apiKey) {
  return {
    localStorage: {
      getItem: (key) => key === "fruit-truck.dev-key" ? apiKey : null,
    },
  };
}

export async function validateLiveContracts(apiKey = process.env.OPENROUTER_API_KEY) {
  assert.ok(apiKey?.trim(), "OPENROUTER_API_KEY is required for --live schema-drift validation.");
  const previousWindow = globalThis.window;
  globalThis.window = liveWindow(apiKey.trim());
  try {
    const fetchJson = async (path) => {
      const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.text();
      assert.equal(response.ok, true, `OpenRouter ${path} returned HTTP ${response.status}: ${body.slice(0, 240)}`);
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error(`OpenRouter ${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const [imageResponse, videoResponse] = await Promise.all([
      fetchJson("/images/models"),
      fetchJson("/videos/models"),
    ]);
    const imageNormalized = normalizeImageCatalog(imageResponse);
    const videoNormalized = normalizeVideoCatalog(videoResponse);
    assert.equal(imageNormalized.rejected.length, 0, `OpenRouter image catalog rejected ${imageNormalized.rejected.length} item(s).`);
    assert.equal(videoNormalized.rejected.length, 0, `OpenRouter video catalog rejected ${videoNormalized.rejected.length} item(s).`);
    const imageModels = imageNormalized.models;
    const videoModels = videoNormalized.models;
    assert.ok(imageModels.length > 0, "OpenRouter image catalog returned no normalized models.");
    assert.ok(videoModels.length > 0, "OpenRouter video catalog returned no normalized models.");

    const endpointCandidates = imageModels
      .filter((model) => (model.endpoint_count ?? 0) > 0)
      .concat(imageModels.filter((model) => (model.endpoint_count ?? 0) === 0))
      .slice(0, 6);
    let endpointModel;
    let endpointDetails = [];
    const endpointErrors = [];
    for (const candidate of endpointCandidates) {
      try {
        const details = await loadImageModelEndpoints(candidate.id);
        if (details.length) {
          endpointModel = applyImageModelEndpoints(candidate, details);
          endpointDetails = details;
          break;
        }
      } catch (error) {
        endpointErrors.push(`${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assert.ok(endpointModel && endpointDetails.length, `OpenRouter image endpoint response contained no normalized endpoints in the sampled models.${endpointErrors.length ? ` Errors: ${endpointErrors.join(" | ")}` : ""}`);
    const providerSlugs = new Set(endpointDetails.map((endpoint) => endpoint.provider_slug));
    assert.ok(providerSlugs.size > 0, "OpenRouter image endpoint response contained no provider family.");
    assert.ok(endpointDetails.every((endpoint) => endpoint.provider_name && endpoint.provider_slug), "OpenRouter image endpoint metadata is missing provider identity.");

    const videoEndpoints = videoModels.reduce((count, model) => count + (model.endpoints?.length ?? 0), 0);
    if (!videoEndpoints) {
      console.warn("OpenRouter video catalog returned no endpoint array; preserving the known unhydrated video contract as a warning.");
    }
    return {
      imageModels: imageModels.length,
      videoModels: videoModels.length,
      imageEndpoints: endpointDetails.length,
      imageProviderFamilies: providerSlugs.size,
      videoEndpoints,
    };
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

function cliArguments(argv) {
  const live = argv.includes("--live");
  const fixtureIndex = argv.indexOf("--fixtures");
  const fixturePath = fixtureIndex === -1 ? defaultFixtureDirectory : argv[fixtureIndex + 1];
  assert.ok(fixturePath, "--fixtures requires a directory.");
  return { live, fixturePath: resolve(fixturePath) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { live, fixturePath } = cliArguments(process.argv.slice(2));
  const fixtures = validateFixtureContracts(fixturePath);
  console.log(`OpenRouter fixture contracts passed: image ${fixtures.image.models} model(s)/${fixtures.image.providers} provider families; video ${fixtures.video.models} model(s)/${fixtures.video.providers} provider families.`);
  if (live) {
    const result = await validateLiveContracts();
    console.log(`OpenRouter live schema drift passed: image ${result.imageModels} model(s), video ${result.videoModels} model(s), ${result.imageEndpoints} sampled image endpoint(s).`);
  }
}
