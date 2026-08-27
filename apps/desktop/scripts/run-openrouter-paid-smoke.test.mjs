import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactWriter, parsePaidSmokeConfiguration, runPaidSmoke } from "./run-openrouter-paid-smoke.mjs";

const ACK = "RUN_PAID_OPENROUTER_SMOKE";
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(8)]);

function response(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function artifactWriter(saved = []) {
  return {
    saved,
    writeArtifact: async ({ fileName, mimeType, bytes }) => {
      saved.push({ fileName, mimeType, bytes: Buffer.from(bytes) });
      return `memory://${fileName}`;
    },
  };
}

test("paid smoke requires explicit acknowledgement and a bounded declared budget", () => {
  const matrix = JSON.stringify([{ id: "image-text", mode: "image", expect: "supported", maxCostUsd: 0.1, request: { model: "fixture/image", prompt: "fixture" } }]);
  assert.throws(() => parsePaidSmokeConfiguration({ acknowledgement: "yes", budget: 1, matrix }), /authorize paid requests/);
  assert.throws(() => parsePaidSmokeConfiguration({ acknowledgement: ACK, budget: 6, matrix }), /may not exceed/);
  assert.throws(() => parsePaidSmokeConfiguration({ acknowledgement: ACK, budget: 0.05, matrix }), /above the authorized/);
  assert.throws(() => parsePaidSmokeConfiguration({
    acknowledgement: ACK,
    budget: 1,
    matrix: JSON.stringify([{ id: "secret", mode: "image", expect: "supported", maxCostUsd: 0.1, request: { model: "fixture/image", metadata: { api_key: "must-not-be-here" } } }]),
  }), /may not contain credentials/);
});

test("paid image smoke submits once and records reported cost", async () => {
  const configuration = parsePaidSmokeConfiguration({
    acknowledgement: ACK,
    budget: 0.2,
    matrix: JSON.stringify([{ id: "image-text", mode: "image", expect: "supported", maxCostUsd: 0.1, request: { model: "fixture/image", prompt: "fixture" } }]),
  });
  let calls = 0;
  const artifacts = artifactWriter();
  const report = await runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.method, "POST");
      return response(200, { data: [{ b64_json: TINY_PNG_BASE64, media_type: "image/png" }], usage: { cost: 0.04 } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.observedCostUsd, 0.04);
  assert.equal(report.ledgerTotalUsd, 0.04);
  assert.equal(report.results[0].resultCount, 1);
  assert.equal(report.results[0].artifacts[0].mimeType, "image/png");
  assert.equal(artifacts.saved[0].fileName, "image-text-image-1.png");
});

test("paid video smoke preserves the job id and polls only with GET", async () => {
  const configuration = parsePaidSmokeConfiguration({
    acknowledgement: ACK,
    budget: 0.5,
    matrix: JSON.stringify([{ id: "video-text", mode: "video", expect: "supported", maxCostUsd: 0.4, request: { model: "fixture/video", prompt: "fixture" } }]),
  });
  const methods = [];
  const artifacts = artifactWriter();
  const report = await runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    sleep: async () => undefined,
    fetchImpl: async (url, options) => {
      methods.push(options.method);
      if (options.method === "POST") return response(200, { id: "job-fixture", status: "pending", usage: { cost: 0.2 } });
      if (url.endsWith("/content?index=0")) return new Response(TINY_MP4, { status: 200, headers: { "content-type": "video/mp4" } });
      return response(200, { id: "job-fixture", status: "completed", usage: { cost: 0.27 } });
    },
  });
  assert.deepEqual(methods, ["POST", "GET", "GET"]);
  assert.equal(report.results[0].jobId, "job-fixture");
  assert.equal(report.observedCostUsd, 0.27);
  assert.equal(report.results[0].artifacts[0].mimeType, "video/mp4");
  assert.equal(artifacts.saved[0].fileName, "video-text-video.mp4");
});

test("paid smoke rejects successful responses without result integrity or reported cost", async () => {
  const configuration = parsePaidSmokeConfiguration({
    acknowledgement: ACK,
    budget: 0.2,
    matrix: JSON.stringify([{ id: "image-empty", mode: "image", expect: "supported", maxCostUsd: 0.1, request: { model: "fixture/image", prompt: "fixture" } }]),
  });
  const artifacts = artifactWriter();
  await assert.rejects(runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async () => response(200, { data: [] }),
  }), /omitted actual cost/);
  await assert.rejects(runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async () => response(200, { data: [], usage: { cost: 0.04 } }),
  }), /no usable result payload/);
});

test("paid smoke records an explicit zero ledger only for expected contract rejections", async () => {
  const configuration = parsePaidSmokeConfiguration({
    acknowledgement: ACK,
    budget: 0.2,
    matrix: JSON.stringify([{ id: "image-rejected", mode: "image", expect: "rejected", maxCostUsd: 0.1, request: { model: "fixture/image", prompt: "fixture" } }]),
  });
  const artifacts = artifactWriter();
  const report = await runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async () => response(422, { error: { message: "unsupported fixture" } }),
  });

  assert.equal(report.observedCostUsd, 0);
  assert.equal(report.ledger[0].providerCostReported, false);
  assert.equal(report.results[0].httpStatus, 422);
  assert.equal(report.results[0].resultCount, 0);

  await assert.rejects(runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async () => response(429, { error: { message: "rate limited" } }),
  }), /omitted actual cost/);
});

test("paid image SSE records partial events and saves only completed bytes", async () => {
  const configuration = parsePaidSmokeConfiguration({
    acknowledgement: ACK,
    budget: 0.2,
    matrix: JSON.stringify([{ id: "image-stream", mode: "image", expect: "supported", maxCostUsd: 0.1, request: { model: "fixture/image", prompt: "fixture", stream: true } }]),
  });
  const artifacts = artifactWriter();
  const body = [
    `data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"${TINY_PNG_BASE64}"}`,
    `data: {"type":"image_generation.completed","b64_json":"${TINY_PNG_BASE64}","media_type":"image/png","usage":{"cost":0.03}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const report = await runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(report.results[0].partialEventCount, 1);
  assert.equal(report.results[0].resultCount, 1);
  assert.equal(artifacts.saved.length, 1);
});

test("paid artifact integrity rejects MIME mismatches and URL-only results", async () => {
  const configuration = parsePaidSmokeConfiguration({
    acknowledgement: ACK,
    budget: 0.2,
    matrix: JSON.stringify([{ id: "image-integrity", mode: "image", expect: "supported", maxCostUsd: 0.1, request: { model: "fixture/image", prompt: "fixture" } }]),
  });
  const artifacts = artifactWriter();
  await assert.rejects(runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async () => response(200, { data: [{ b64_json: TINY_PNG_BASE64, media_type: "image/jpeg" }], usage: { cost: 0.04 } }),
  }), /MIME does not match/);
  await assert.rejects(runPaidSmoke(configuration, {
    apiKey: "fixture-key",
    writeArtifact: artifacts.writeArtifact,
    fetchImpl: async () => response(200, { data: [{ url: "https://example.invalid/result.png" }], usage: { cost: 0.04 } }),
  }), /URL-only/);
});

test("paid artifact writer atomically retains private evidence files", async (context) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "fruit-truck-paid-smoke-test-"));
  context.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const writeArtifact = await createArtifactWriter(outputDirectory);
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const savedFile = await writeArtifact({
    caseId: "filesystem",
    fileName: "filesystem-image.png",
    mimeType: "image/png",
    bytes,
  });

  assert.equal(savedFile, "filesystem-image.png");
  assert.deepEqual(await readFile(join(outputDirectory, savedFile)), bytes);
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(outputDirectory, savedFile))).mode & 0o777, 0o600);
});
