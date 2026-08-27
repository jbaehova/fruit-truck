#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://openrouter.ai/api/v1";
const ACKNOWLEDGEMENT = "RUN_PAID_OPENROUTER_SMOKE";
const MAX_TOTAL_BUDGET_USD = 5;
const MAX_CASES = 20;
const MAX_MATRIX_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_ARTIFACT_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_ARTIFACT_BYTES = 128 * 1024 * 1024;
const VIDEO_POLL_TIMEOUT_MS = 20 * 60 * 1000;
const UNBILLED_CONTRACT_REJECTION_STATUSES = new Set([400, 404, 405, 415, 422]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finitePositive(value, label) {
  assert.equal(typeof value, "number", `${label} must be a number.`);
  assert.ok(Number.isFinite(value) && value > 0, `${label} must be finite and greater than zero.`);
  return value;
}

function safeCaseId(value, index) {
  assert.equal(typeof value, "string", `case ${index} id must be a string.`);
  assert.match(value, /^[a-z0-9][a-z0-9._-]{0,79}$/u, `case ${index} id is invalid.`);
  return value;
}

function assertNoCredentialFields(value, label = "request") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${label}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!/^(?:authorization|api[_-]?key|access[_-]?token|bearer[_-]?token)$/iu.test(key), `${label}.${key} may not contain credentials.`);
    assertNoCredentialFields(item, `${label}.${key}`);
  }
}

export function parsePaidSmokeConfiguration({ acknowledgement, budget, matrix }) {
  assert.equal(acknowledgement, ACKNOWLEDGEMENT, `Set OPENROUTER_PAID_SMOKE_ACK=${ACKNOWLEDGEMENT} to authorize paid requests.`);
  const totalBudgetUsd = finitePositive(Number(budget), "OPENROUTER_PAID_SMOKE_BUDGET_USD");
  assert.ok(totalBudgetUsd <= MAX_TOTAL_BUDGET_USD, `Paid smoke budget may not exceed $${MAX_TOTAL_BUDGET_USD}.`);
  assert.equal(typeof matrix, "string", "OPENROUTER_PAID_SMOKE_CASES must be JSON.");
  assert.ok(Buffer.byteLength(matrix, "utf8") <= MAX_MATRIX_BYTES, "Paid smoke matrix is too large.");
  const parsed = JSON.parse(matrix);
  assert.ok(Array.isArray(parsed) && parsed.length > 0, "Paid smoke matrix must contain at least one case.");
  assert.ok(parsed.length <= MAX_CASES, `Paid smoke matrix may contain at most ${MAX_CASES} cases.`);
  const ids = new Set();
  const cases = parsed.map((raw, index) => {
    assert.ok(isRecord(raw), `case ${index} must be an object.`);
    const id = safeCaseId(raw.id, index);
    assert.equal(ids.has(id), false, `Paid smoke case id is duplicated: ${id}.`);
    ids.add(id);
    assert.ok(raw.mode === "image" || raw.mode === "video", `${id} mode must be image or video.`);
    assert.ok(raw.expect === "supported" || raw.expect === "rejected", `${id} expect must be supported or rejected.`);
    assert.ok(isRecord(raw.request), `${id} request must be an object.`);
    assert.equal(typeof raw.request.model, "string", `${id} request.model is required.`);
    assertNoCredentialFields(raw.request, `${id}.request`);
    const maxCostUsd = finitePositive(raw.maxCostUsd, `${id}.maxCostUsd`);
    const referenceKind = raw.referenceKind ?? "none";
    const transport = raw.transport ?? "none";
    assert.ok(["none", "image", "video", "audio"].includes(referenceKind), `${id} referenceKind is invalid.`);
    assert.ok(["none", "https_url", "signed_url", "data_url"].includes(transport), `${id} transport is invalid.`);
    return { id, mode: raw.mode, expect: raw.expect, request: structuredClone(raw.request), maxCostUsd, referenceKind, transport };
  });
  const authorizedMaximum = cases.reduce((sum, item) => sum + item.maxCostUsd, 0);
  assert.ok(authorizedMaximum <= totalBudgetUsd, `Case maximums total $${authorizedMaximum.toFixed(4)}, above the authorized $${totalBudgetUsd.toFixed(4)} budget.`);
  return { totalBudgetUsd, cases };
}

async function boundedBytes(response, label, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  assert.ok(!Number.isFinite(declared) || declared <= limit, `${label} response exceeds the smoke safety limit.`);
  const reader = response.body?.getReader();
  assert.ok(reader, `${label} response has no readable body.`);
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    assert.ok(received <= limit, `${label} response exceeds the smoke safety limit.`);
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function parseImageSse(body, label) {
  const data = [];
  let usage;
  let created;
  let partialEventCount = 0;
  for (const line of body.split(/\r?\n/u)) {
    const payload = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : "";
    if (!payload || payload === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      assert.fail(`${label} returned invalid SSE JSON.`);
    }
    if (event?.error) assert.fail(`${label} stream failed: ${JSON.stringify(event.error)}`);
    if (event?.type === "image_generation.partial_image") {
      partialEventCount += 1;
      continue;
    }
    if (event?.type === "image_generation.completed") {
      const { type: _type, partial_image_index: _partialImageIndex, usage: eventUsage, created: eventCreated, ...image } = event;
      void _type;
      void _partialImageIndex;
      if (eventUsage !== undefined) usage = eventUsage;
      if (eventCreated !== undefined) created = eventCreated;
      data.push(image);
      continue;
    }
    if (event?.type === "image_generation.failed" || event?.type === "error") {
      assert.fail(`${label} stream failed: ${JSON.stringify(event)}`);
    }
  }
  assert.ok(data.length > 0, `${label} stream ended without a completed image.`);
  return { json: { data, ...(usage !== undefined ? { usage } : {}), ...(created !== undefined ? { created } : {}) }, partialEventCount };
}

async function boundedJson(response, label) {
  const bytes = await boundedBytes(response, label);
  const body = bytes.toString("utf8");
  if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return { body, ...parseImageSse(body, label) };
  }
  try {
    return { body, json: JSON.parse(body), partialEventCount: 0 };
  } catch {
    return { body, json: null, partialEventCount: 0 };
  }
}

function responseCost(payload) {
  const candidates = [payload?.usage?.cost, payload?.usage?.total_cost, payload?.cost];
  return candidates.find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function videoStatus(payload) {
  return String(payload?.status ?? payload?.data?.status ?? "").toLowerCase();
}

function videoJobId(payload) {
  const value = payload?.id ?? payload?.job_id ?? payload?.data?.id ?? payload?.data?.job_id;
  return typeof value === "string" && value ? value : null;
}

function usableImageCount(payload) {
  if (!Array.isArray(payload?.data)) return 0;
  return payload.data.filter((item) => isRecord(item) && [item.url, item.b64_json, item.local_path]
    .some((value) => typeof value === "string" && value.length > 0)).length;
}

function normalizeMime(value) {
  const mime = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  const prefix = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8").replace(/^\uFEFF?\s*/u, "");
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(prefix)) return "image/svg+xml";
  return null;
}

function detectVideoMime(bytes) {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  return null;
}

function extensionForMime(mimeType) {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
  }[mimeType];
}

function decodeStrictBase64(value, label) {
  assert.equal(typeof value, "string", `${label} must be base64 text.`);
  const normalized = value.replace(/\s+/gu, "");
  assert.match(normalized, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u, `${label} is invalid base64.`);
  const bytes = Buffer.from(normalized, "base64");
  assert.ok(bytes.length > 0, `${label} decoded to an empty artifact.`);
  assert.equal(bytes.toString("base64").replace(/=+$/u, ""), normalized.replace(/=+$/u, ""), `${label} is not canonical base64.`);
  return bytes;
}

function artifactEvidence(savedFile, mimeType, bytes) {
  return {
    savedFile,
    mimeType,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function verifyImageArtifacts(payload, caseId, writeArtifact) {
  assert.ok(Array.isArray(payload?.data) && payload.data.length > 0, `${caseId} image response contained no result records.`);
  const artifacts = [];
  for (const [index, item] of payload.data.entries()) {
    assert.ok(isRecord(item), `${caseId} image result ${index + 1} is invalid.`);
    let bytes;
    let declaredMime = normalizeMime(item.media_type);
    if (typeof item.b64_json === "string") {
      bytes = decodeStrictBase64(item.b64_json, `${caseId} image result ${index + 1}`);
    } else if (typeof item.url === "string" && item.url.startsWith("data:")) {
      const match = item.url.match(/^data:([^;,]+);base64,(.+)$/su);
      assert.ok(match, `${caseId} image data URL is invalid.`);
      declaredMime ||= normalizeMime(match[1]);
      bytes = decodeStrictBase64(match[2], `${caseId} image result ${index + 1}`);
    } else {
      assert.fail(`${caseId} image result ${index + 1} is URL-only; the paid integrity gate requires directly retained bytes.`);
    }
    assert.ok(bytes.length <= MAX_IMAGE_ARTIFACT_BYTES, `${caseId} image result ${index + 1} exceeds the local artifact limit.`);
    const detectedMime = detectImageMime(bytes);
    assert.ok(detectedMime, `${caseId} image result ${index + 1} has unknown media bytes.`);
    if (declaredMime) assert.equal(declaredMime, detectedMime, `${caseId} image result ${index + 1} MIME does not match its bytes.`);
    const extension = extensionForMime(detectedMime);
    const fileName = `${caseId}-image-${index + 1}.${extension}`;
    const savedFile = await writeArtifact({ caseId, fileName, mimeType: detectedMime, bytes });
    assert.equal(typeof savedFile, "string", `${caseId} artifact writer did not return a saved path.`);
    assert.ok(savedFile.length > 0, `${caseId} artifact writer returned an empty saved path.`);
    artifacts.push(artifactEvidence(savedFile, detectedMime, bytes));
  }
  return artifacts;
}

async function verifyVideoArtifact(fetchImpl, apiKey, caseId, jobId, writeArtifact) {
  const response = await fetchImpl(`${API_BASE}/videos/${encodeURIComponent(jobId)}/content?index=0`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "follow",
    signal: AbortSignal.timeout(180_000),
  });
  assert.ok(response.ok, `${caseId} video content returned HTTP ${response.status}.`);
  const bytes = await boundedBytes(response, `${caseId} video content`, MAX_VIDEO_ARTIFACT_BYTES);
  assert.ok(bytes.length > 0, `${caseId} video content is empty.`);
  const detectedMime = detectVideoMime(bytes);
  assert.ok(detectedMime, `${caseId} video content has unknown media bytes.`);
  const declaredMime = normalizeMime(response.headers.get("content-type"));
  if (declaredMime) assert.equal(declaredMime, detectedMime, `${caseId} video MIME does not match its bytes.`);
  const fileName = `${caseId}-video.${extensionForMime(detectedMime)}`;
  const savedFile = await writeArtifact({ caseId, fileName, mimeType: detectedMime, bytes });
  assert.equal(typeof savedFile, "string", `${caseId} artifact writer did not return a saved path.`);
  assert.ok(savedFile.length > 0, `${caseId} artifact writer returned an empty saved path.`);
  return artifactEvidence(savedFile, detectedMime, bytes);
}

export async function createArtifactWriter(outputDirectory) {
  const outputRoot = resolve(outputDirectory);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await chmod(outputRoot, 0o700);
  return async ({ fileName, bytes }) => {
    assert.equal(extname(fileName).length > 1, true, "Paid smoke artifact must have an extension.");
    assert.match(fileName, /^[a-z0-9][a-z0-9._-]{0,159}$/u, "Paid smoke artifact name is invalid.");
    const destination = join(outputRoot, fileName);
    const temporary = join(outputRoot, `.${fileName}.${randomUUID()}.part`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    return relative(outputRoot, destination);
  };
}

async function apiRequest(fetchImpl, apiKey, method, path, body) {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(method === "POST" ? 180_000 : 60_000),
  });
  const parsed = await boundedJson(response, `${method} ${path}`);
  return { response, ...parsed };
}

async function pollVideo(fetchImpl, apiKey, jobId, sleep) {
  const started = Date.now();
  for (let poll = 0; Date.now() - started < VIDEO_POLL_TIMEOUT_MS; poll += 1) {
    await sleep(Math.min(15_000, 2_000 + poll * 1_000));
    const result = await apiRequest(fetchImpl, apiKey, "GET", `/videos/${encodeURIComponent(jobId)}`);
    assert.ok(result.response.ok, `Video status ${jobId} returned HTTP ${result.response.status}.`);
    const status = videoStatus(result.json);
    if (["completed", "failed", "cancelled", "canceled", "expired"].includes(status)) return { ...result, status };
  }
  throw new Error(`Video job ${jobId} remains recoverable after the bounded smoke polling window.`);
}

export async function runPaidSmoke(configuration, {
  apiKey,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  writeArtifact,
}) {
  assert.ok(apiKey?.trim(), "OPENROUTER_API_KEY is required.");
  assert.equal(typeof writeArtifact, "function", "A durable paid-smoke artifact writer is required.");
  const results = [];
  let observedCostUsd = 0;
  for (const item of configuration.cases) {
    assert.ok(observedCostUsd < configuration.totalBudgetUsd, "Observed spend reached the authorized budget; remaining cases were not submitted.");
    // Deliberately issue each paid POST exactly once. A transport failure is
    // uncertain and must be reconciled in OpenRouter account activity.
    const submitted = await apiRequest(fetchImpl, apiKey.trim(), "POST", item.mode === "image" ? "/images" : "/videos", item.request);
    let actualCostUsd = responseCost(submitted.json);
    let status = submitted.response.ok ? "completed" : "rejected";
    let jobId = null;
    let artifacts = [];
    if (submitted.response.ok && item.mode === "video") {
      jobId = videoJobId(submitted.json);
      assert.ok(jobId, `${item.id} video response has no durable job ID.`);
      console.log(`${item.id}: durable video job ${jobId} accepted; polling with safe GET requests.`);
      const terminal = await pollVideo(fetchImpl, apiKey.trim(), jobId, sleep);
      status = terminal.status;
      actualCostUsd = responseCost(terminal.json) ?? actualCostUsd;
      if (status === "completed") {
        artifacts = [await verifyVideoArtifact(fetchImpl, apiKey.trim(), item.id, jobId, writeArtifact)];
      }
    }
    const providerCostReported = actualCostUsd !== undefined;
    if (!providerCostReported) {
      assert.ok(
        item.expect === "rejected" && UNBILLED_CONTRACT_REJECTION_STATUSES.has(submitted.response.status),
        `${item.id} response omitted actual cost; stop and reconcile OpenRouter account activity before continuing.`,
      );
      actualCostUsd = 0;
    }
    if (submitted.response.ok && item.mode === "image") {
      assert.ok(usableImageCount(submitted.json) > 0, `${item.id} image response contained no usable result payload.`);
      artifacts = await verifyImageArtifacts(submitted.json, item.id, writeArtifact);
    }
    observedCostUsd += actualCostUsd;
    assert.ok(actualCostUsd <= item.maxCostUsd, `${item.id} reported $${actualCostUsd.toFixed(4)}, above its $${item.maxCostUsd.toFixed(4)} authorization.`);
    assert.ok(observedCostUsd <= configuration.totalBudgetUsd, `Observed smoke cost $${observedCostUsd.toFixed(4)} exceeded the authorized budget.`);
    const supported = submitted.response.ok && (item.mode === "image" || status === "completed");
    assert.equal(supported, item.expect === "supported", `${item.id} expected ${item.expect} but finished as ${status} (HTTP ${submitted.response.status}).`);
    results.push({
      id: item.id,
      mode: item.mode,
      referenceKind: item.referenceKind,
      transport: item.transport,
      status,
      httpStatus: submitted.response.status,
      actualCostUsd,
      providerCostReported,
      jobId,
      resultCount: artifacts.length,
      partialEventCount: submitted.partialEventCount,
      artifacts,
    });
    const costLabel = providerCostReported ? "provider-reported" : "unbilled contract rejection; account reconciliation required";
    console.log(`${item.id}: ${status}; ledger cost $${actualCostUsd.toFixed(4)} (${costLabel}); ${artifacts.length} saved artifact(s); ${item.referenceKind}/${item.transport}.`);
  }
  const ledger = results.map((result) => ({
    caseId: result.id,
    actualCostUsd: result.actualCostUsd,
    providerCostReported: result.providerCostReported,
  }));
  const ledgerTotalUsd = ledger.reduce((sum, entry) => sum + entry.actualCostUsd, 0);
  assert.ok(Math.abs(ledgerTotalUsd - observedCostUsd) < 1e-9, "Paid smoke cost ledger does not match observed provider cost.");
  return { observedCostUsd, ledgerTotalUsd, ledger, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configuration = parsePaidSmokeConfiguration({
    acknowledgement: process.env.OPENROUTER_PAID_SMOKE_ACK,
    budget: process.env.OPENROUTER_PAID_SMOKE_BUDGET_USD,
    matrix: process.env.OPENROUTER_PAID_SMOKE_CASES,
  });
  assert.ok(process.env.OPENROUTER_PAID_SMOKE_OUTPUT_DIR?.trim(), "OPENROUTER_PAID_SMOKE_OUTPUT_DIR is required.");
  const writeArtifact = await createArtifactWriter(process.env.OPENROUTER_PAID_SMOKE_OUTPUT_DIR.trim());
  const report = await runPaidSmoke(configuration, { apiKey: process.env.OPENROUTER_API_KEY, writeArtifact });
  const reportFile = await writeArtifact({
    caseId: "report",
    fileName: "paid-smoke-report.json",
    mimeType: "application/json",
    bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"),
  });
  console.log(`Paid OpenRouter smoke passed ${report.results.length} case(s); observed cost $${report.observedCostUsd.toFixed(4)}; evidence ${reportFile}.`);
}
