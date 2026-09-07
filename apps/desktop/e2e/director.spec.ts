import { expect, test, type Page } from "@playwright/test";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const NATIVE_DIRECTOR_MODEL = {
  id: "runway/aleph-2",
  name: "Runway Director Native",
  input_reference_types: ["image"],
  max_input_references: 6,
  supported_frame_images: ["first_frame", "last_frame"],
  supported_durations: [5],
  supported_resolutions: ["720p"],
  supported_aspect_ratios: ["16:9"],
  reference_transports: { image: ["data_url"] },
  reference_transport_source: "openrouter_endpoint",
  supported_parameters: {
    duration: { type: "enum", values: [5] },
    resolution: { type: "enum", values: ["720p"] },
    aspect_ratio: { type: "enum", values: ["16:9"] },
    trajectory: { type: "boolean" },
    focal_length_mm: { type: "range", min: 12, max: 300 },
  },
  director_capabilities: {
    camera_parameters: ["focal_length_mm"],
    supports_first_frame: true,
    supports_last_frame: true,
    max_keyframes: 4,
    supports_timestamped_keyframes: true,
    supports_multi_shot: true,
    multi_shot_contract: { parameter: "shots", shape: "array" },
    supports_visual_instruction: true,
    supports_native_trajectory: true,
  },
  endpoints: [{
    endpoint_id: "director-native-route",
    provider_name: "Director Test Provider",
    provider_slug: "director-test",
    input_reference_types: ["image"],
    max_input_references: 6,
    supported_frame_images: ["first_frame", "last_frame"],
    supported_durations: [5],
    supported_resolutions: ["720p"],
    supported_aspect_ratios: ["16:9"],
    reference_transports: { image: ["data_url"] },
    supported_parameters: {
      duration: { type: "enum", values: [5] },
      resolution: { type: "enum", values: ["720p"] },
      aspect_ratio: { type: "enum", values: ["16:9"] },
      trajectory: { type: "boolean" },
      focal_length_mm: { type: "range", min: 12, max: 300 },
    },
    allowed_passthrough_parameters: ["trajectory", "focal_length_mm"],
    director_capabilities: {
      camera_parameters: ["focal_length_mm"],
      supports_first_frame: true,
      supports_last_frame: true,
      max_keyframes: 4,
      supports_timestamped_keyframes: true,
      supports_multi_shot: true,
      multi_shot_contract: { parameter: "shots", shape: "array" },
      supports_visual_instruction: true,
      supports_native_trajectory: true,
    },
    pricing_skus: { generation: "$0.10" },
    privacy: { zdr: true, data_collection: "deny" },
  }],
};

const PROMPT_DIRECTOR_MODEL = {
  ...NATIVE_DIRECTOR_MODEL,
  id: "test/director-prompt",
  name: "Director Prompt Video",
  supported_parameters: {
    duration: { type: "enum", values: [5] },
    resolution: { type: "enum", values: ["720p"] },
    aspect_ratio: { type: "enum", values: ["16:9"] },
  },
  director_capabilities: {
    camera_parameters: [],
    supports_first_frame: true,
    supports_last_frame: true,
    max_keyframes: 4,
    supports_timestamped_keyframes: false,
    supports_multi_shot: false,
    supports_visual_instruction: false,
    supports_native_trajectory: false,
  },
  endpoints: [{
    endpoint_id: "director-prompt-route",
    provider_name: "Director Prompt Provider",
    provider_slug: "director-prompt",
    input_reference_types: ["image"],
    max_input_references: 6,
    supported_frame_images: ["first_frame", "last_frame"],
    supported_durations: [5],
    supported_resolutions: ["720p"],
    supported_aspect_ratios: ["16:9"],
    reference_transports: { image: ["local_file", "data_url"] },
    supported_parameters: {
      duration: { type: "enum", values: [5] },
      resolution: { type: "enum", values: ["720p"] },
      aspect_ratio: { type: "enum", values: ["16:9"] },
    },
    director_capabilities: {
      camera_parameters: [],
      supports_first_frame: true,
      supports_last_frame: true,
      max_keyframes: 4,
      supports_timestamped_keyframes: false,
      supports_multi_shot: false,
      supports_visual_instruction: false,
      supports_native_trajectory: false,
    },
    pricing_skus: { generation: "$0.12" },
    privacy: { zdr: true, data_collection: "deny" },
  }],
};

function inputModel(id: string, name: string, max: number, frames: string[]) {
  return {
    ...NATIVE_DIRECTOR_MODEL,
    id, name,
    // Deliberately broad model metadata: the selected endpoint must win.
    max_input_references: 9,
    endpoints: [{
      ...NATIVE_DIRECTOR_MODEL.endpoints[0],
      endpoint_id: id, provider_slug: id.replace("/", "-"),
      input_reference_types: max > 0 ? ["image"] : [],
      max_input_references: max,
      supported_frame_images: frames,
    }],
  };
}
const INPUT_MODELS = [
  inputModel("test/first-only", "First frame only video", 0, ["first_frame"]),
  inputModel("test/frame-pair", "Frame pair video", 0, ["first_frame", "last_frame"]),
  inputModel("test/references", "Three reference images video", 3, []),
  inputModel("test/text-only", "Text only video", 0, []),
];

async function mockDirectorApi(page: Page) {
  await page.route("https://openrouter.ai/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v1/key") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: { label: "Fruit Truck Director E2E", limit: 5, limit_remaining: 5 } }),
      });
      return;
    }
    if (path === "/api/v1/images/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [{
          id: "google/gemini-2.5-flash-image",
          name: "Director setup image model",
          supported_parameters: {},
        }] }),
      });
      return;
    }
    if (path === "/api/v1/images/models/google/gemini-2.5-flash-image/endpoints") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ endpoints: [{
          endpoint_id: "image-route",
          provider_name: "Image Test Provider",
          provider_slug: "image-test",
          supported_parameters: {},
          pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
        }] }),
      });
      return;
    }
    if (path === "/api/v1/videos/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [NATIVE_DIRECTOR_MODEL, PROMPT_DIRECTOR_MODEL, ...INPUT_MODELS] }),
      });
      return;
    }
    if (path === "/api/v1/models" && url.searchParams.has("output_modalities")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [NATIVE_DIRECTOR_MODEL, PROMPT_DIRECTOR_MODEL, ...INPUT_MODELS] }),
      });
      return;
    }
    if (path === "/api/v1/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [
          { id: "openai/gpt-5.6-sol", supported_parameters: ["reasoning", "structured_outputs"] },
          { id: "anthropic/claude-opus-5", supported_parameters: ["reasoning", "structured_outputs"] },
          { id: "google/gemini-3.8-flash", supported_parameters: ["reasoning", "structured_outputs"] },
        ] }),
      });
      return;
    }
    if (path === "/api/v1/videos" && request.method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: "director-video-e2e", status: "pending", usage: { cost: 0.12 } }),
      });
      return;
    }
    if (path === "/api/v1/videos/director-video-e2e" && request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: "director-video-e2e", status: "pending", progress: 10 }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: `Unmocked Director E2E route: ${path}` });
  });
}

async function importFramePair(page: Page) {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Drop assets here or choose files/ }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles([
    {
      name: "director-first-frame.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    },
    {
      name: "director-last-frame.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    },
  ]);
  await expect(page.locator(".reference-row strong", { hasText: "director-first-frame.png" })).toBeVisible();
  await expect(page.locator(".reference-row strong", { hasText: "director-last-frame.png" })).toBeVisible();
}

async function chooseInputRole(page: Page, assetName: string, role: "Reference" | "First frame" | "Last frame") {
  const combobox = page.getByRole("combobox", { name: `Role for ${assetName}` });
  await combobox.focus();
  await combobox.press("Enter");
  await expect(combobox).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.type(role, { delay: 25 });
  await page.keyboard.press("Enter");
  const expectedRole = role === "First frame" ? "first_frame" : role === "Last frame" ? "last_frame" : "reference";
  await expect.poll(() => page.evaluate(({ name, expected }) => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    const asset = session?.assets.find((item: { name: string }) => item.name === name);
    const thread = session?.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video);
    return thread?.draft.references.find((reference: { assetId: string }) => reference.assetId === asset?.id)?.role === expected;
  }, { name: assetName, expected: expectedRole })).toBe(true);
}

async function savedDirectorPlan(page: Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    const thread = session?.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video);
    return thread?.draft.directorPlan;
  });
}

function normalizeMediaPayloads(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("data:") || value.startsWith("<media payload omitted") ? "<media>" : value;
  }
  if (Array.isArray(value)) return value.map(normalizeMediaPayloads);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeMediaPayloads(entry)]));
  }
  return value;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("fruit-truck.dev-key", "sk-or-v1-director-e2e-key-1234567890");
    localStorage.setItem("fruit-truck.onboarding.complete.v1", "true");
    localStorage.setItem("fruit-truck.language", "en");
    localStorage.setItem("fruit-truck.prompt-enhancement-notice.v1", "true");
    if (!sessionStorage.getItem("fruit-truck.director-e2e.initialized")) {
      localStorage.removeItem("fruit-truck.studio.v1");
      localStorage.removeItem("fruit-truck.studio.v1.last-known-good");
      sessionStorage.setItem("fruit-truck.director-e2e.initialized", "true");
    }
  });
  await mockDirectorApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Director setup image model" })).toBeVisible();
});

test("video frames stay in the standard composer and are submitted exactly as reviewed", async ({ page }) => {
  expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Director", exact: true })).toHaveCount(0);
  await expect(page.locator(".director-panel")).toHaveCount(0);
  await importFramePair(page);
  await chooseInputRole(page, "director-first-frame.png", "First frame");
  await chooseInputRole(page, "director-last-frame.png", "Last frame");
  const prompt = "A fruit truck drives from the orchard to the market.";
  await page.getByRole("combobox", { name: /^Prompt/ }).fill(prompt);
  expect(await savedDirectorPlan(page)).toBeUndefined();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    return session?.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video)?.draft.prompt;
  })).toBe(prompt);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Role for director-first-frame.png" })).toContainText("First frame");
  await expect(page.getByRole("combobox", { name: "Role for director-last-frame.png" })).toContainText("Last frame");
  await page.screenshot({ path: test.info().outputPath("video-composer.png") });
  await page.getByRole("button", { name: "Request", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Request Preview" });
  await dialog.getByRole("button", { name: "Prepare final request" }).click();
  await expect(dialog.locator(".request-readiness")).toContainText("Final");
  await expect(dialog.locator(".director-request-preview")).toHaveCount(0);
  const reviewed = JSON.parse(await dialog.locator(".request-payload").textContent() ?? "{}");
  expect(reviewed.prompt).toContain(prompt);
  expect(reviewed.prompt).not.toContain("[Director Brief]");
  expect(reviewed.frame_images.map((frame: { frame_type: string }) => frame.frame_type)).toEqual(["first_frame", "last_frame"]);
  await dialog.getByRole("button", { name: "Close request preview" }).click();
  const submitted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/videos");
  await page.getByRole("button", { name: "Generate Video", exact: true }).click();
  expect(normalizeMediaPayloads((await submitted).postDataJSON())).toEqual(normalizeMediaPayloads(reviewed));
});

test("legacy Director settings cannot block ordinary generation or restore removed frames", async ({ page }) => {
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await importFramePair(page);
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("Move from the opening frame to the final frame.");
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    return state.sessions?.[0]?.assets?.length;
  })).toBe(2);
  await page.evaluate(async () => {
    // Seed a real legacy plan, including a duration that used to block generation.
    const defaultsModulePath = "/src/director/defaults.ts";
    const { createDefaultDirectorPlan, createDefaultDirectorShot } = await import(/* @vite-ignore */ defaultsModulePath);
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1")!);
    const session = state.sessions.find((item: { id: string }) => item.id === state.activeSessionId);
    const thread = session.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video);
    const first = session.assets.find((asset: { name: string }) => asset.name === "director-first-frame.png");
    const last = session.assets.find((asset: { name: string }) => asset.name === "director-last-frame.png");
    const plan = createDefaultDirectorPlan({ sourceAssetId: first.id });
    plan.keyframes = [
      { id: "legacy-first", assetId: first.id, role: "first", time: 0 },
      { id: "legacy-last", assetId: last.id, role: "last", time: 1 },
    ];
    plan.shots = [{ ...createDefaultDirectorShot(), durationSeconds: 120, promptFragment: "Hidden legacy shot instructions", keyframeIds: ["legacy-first", "legacy-last"] }];
    plan.cameraRig.focalLengthMm = 85;
    thread.draft.directorPlan = plan;
    thread.draft.references = [];
    localStorage.setItem("fruit-truck.studio.v1", JSON.stringify(state));
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Role for director-first-frame.png" })).toContainText("First frame");
  await expect(page.getByRole("combobox", { name: "Role for director-last-frame.png" })).toContainText("Last frame");
  await expect(page.getByRole("button", { name: "Open Director", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Request", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Request Preview" });
  await dialog.getByRole("button", { name: "Prepare final request" }).click();
  await expect(dialog.locator(".request-readiness")).toContainText("Final");
  const payload = JSON.parse(await dialog.locator(".request-payload").textContent() ?? "{}");
  expect(payload.prompt).toContain("Move from the opening frame to the final frame.");
  expect(payload.prompt).not.toContain("Hidden legacy shot instructions");
  expect(payload.prompt).not.toContain("[Director Brief]");
  expect(payload.frame_images).toHaveLength(2);
  expect(payload.duration).toBe(5);
  expect(payload.focal_length_mm).toBeUndefined();
  expect(payload.shots).toBeUndefined();
  await dialog.getByRole("button", { name: "Close request preview" }).click();
  await page.locator(".reference-section").getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".reference-row")).toHaveCount(0);
  await expect.poll(async () => (await savedDirectorPlan(page))?.enabled).toBe(false);
  await page.reload();
  await expect(page.locator(".reference-row")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /^Prompt/ })).toHaveValue("Move from the opening frame to the final frame.");
});

async function selectInputModel(page: Page, name: string) {
  await page.locator(".model-selector-trigger").click();
  await page.locator(".model-select-main").filter({ hasText: name }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Change model", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

test("model selection updates frame slots, input limits, and library attachment controls", async ({ page }) => {
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await selectInputModel(page, "Frame pair video");
  await expect(page.locator(".input-support-summary")).toContainText("Reference images: up to 0");
  await importFramePair(page);
  await expect(page.getByRole("combobox", { name: "Role for director-first-frame.png" })).toContainText("First frame");
  await expect(page.getByRole("combobox", { name: "Role for director-last-frame.png" })).toContainText("Last frame");
  await expect(page.locator(".reference-section .add-reference")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Role for director-last-frame.png" }).click();
  await expect(page.getByRole("option", { name: "First frame", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");

  await selectInputModel(page, "First frame only video");
  await expect(page.locator(".input-support-summary")).toContainText("Last frame: 0 image(s)");
  await expect(page.getByRole("combobox", { name: "Role for director-last-frame.png" })).toContainText("Unsupported");
  await expect(page.locator(".reference-row")).toHaveCount(2);
  await page.locator(".reference-row").filter({ hasText: "director-last-frame.png" }).getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("Animate the opening image.");
  await page.getByRole("button", { name: "Prepare final request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate Video", exact: true })).toBeEnabled();

  await selectInputModel(page, "Three reference images video");
  await expect(page.locator(".input-support-summary")).toContainText("Reference images: up to 3");
  await expect(page.getByRole("combobox", { name: "Role for director-first-frame.png" })).toContainText("Unsupported");
  await page.locator(".reference-section").getByRole("button", { name: "Clear", exact: true }).click();
  await page.locator(".asset-tile").filter({ hasText: "director-first-frame.png" }).getByRole("button", { name: "Use as input", exact: true }).click();
  await expect(page.locator(".reference-row")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Role for director-first-frame.png" })).toContainText("Reference asset");
  await page.locator(".asset-tile").filter({ hasText: "director-last-frame.png" }).getByRole("button", { name: "Use as input", exact: true }).click();
  await expect(page.locator(".reference-row")).toHaveCount(2);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add input", exact: true }).click();
  await (await chooser).setFiles(["third", "fourth"].map((name) => ({ name: `${name}.png`, mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64") })));
  await expect(page.locator(".reference-row")).toHaveCount(3);
  await expect(page.locator(".asset-tile").filter({ hasText: "fourth.png" }).getByRole("button", { name: "Use as input", exact: true })).toBeDisabled();
  await expect(page.locator(".reference-section .add-reference")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("model-input-limits.png") });

  await selectInputModel(page, "Text only video");
  await expect(page.locator(".input-support-summary")).toContainText("Reference images: up to 0");
  await expect(page.locator(".reference-row")).toHaveCount(3);
  await page.locator(".reference-section").getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".reference-section .dropzone")).toBeDisabled();
  await expect(page.locator(".asset-tile").first().getByRole("button", { name: "Use as input", exact: true })).toBeDisabled();
});
