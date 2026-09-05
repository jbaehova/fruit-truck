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
        body: JSON.stringify({ data: [NATIVE_DIRECTOR_MODEL, PROMPT_DIRECTOR_MODEL] }),
      });
      return;
    }
    if (path === "/api/v1/models" && url.searchParams.has("output_modalities")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [NATIVE_DIRECTOR_MODEL, PROMPT_DIRECTOR_MODEL] }),
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

async function savedAttemptDirectorPlan(page: Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    const thread = session?.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video);
    return thread?.attempts?.at(-1)?.snapshot?.directorPlan;
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

test("Director builds a local shot, discloses compilation, and survives a model change", async ({ page }) => {
  test.setTimeout(60_000);
  let paidVideoRequests = 0;
  let plannerCalls = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/videos") paidVideoRequests += 1;
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/chat/completions") plannerCalls += 1;
  });

  expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runway Director Native" })).toBeVisible();

  await importFramePair(page);
  await chooseInputRole(page, "director-first-frame.png", "First frame");
  await chooseInputRole(page, "director-last-frame.png", "Last frame");
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("A fruit truck crosses the frame while the camera follows its path.");
  await expect(page.getByRole("toolbar", { name: "Prompt enhancement" })).toBeVisible();
  await expect(page.getByRole("switch", { name: /Prompt enhancement/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Open Director", exact: true }).click();
  const director = page.getByRole("region", { name: "Direct the shot" });
  await expect(director).toBeVisible();
  await expect(director.locator(".director-source-bar small").first()).toHaveText("director-first-frame.png");

  const canvas = director.getByRole("application", { name: "Director motion canvas" });
  await expect(canvas).toBeVisible();
  await director.getByRole("button", { name: "Mark subject", exact: true }).click();
  const canvasContent = director.locator(".director-canvas-content");
  await canvasContent.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const contentBounds = await canvasContent.boundingBox();
  expect(contentBounds).not.toBeNull();
  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.18, contentBounds!.y + contentBounds!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.42, contentBounds!.y + contentBounds!.height * 0.62, { steps: 6 });
  await page.mouse.up();
  await expect(director.getByRole("button", { name: "Object path", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.3, contentBounds!.y + contentBounds!.height * 0.52);
  await page.mouse.down();
  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.76, contentBounds!.y + contentBounds!.height * 0.38, { steps: 12 });
  await page.mouse.up();
  await expect(director.getByRole("button", { name: /^Object path 1:/ })).toBeVisible();
  await director.getByRole("button", { name: "Undo Director edit" }).click();
  await expect(director.getByRole("button", { name: /^Object path 1:/ })).toHaveCount(0);
  await director.getByRole("button", { name: "Redo Director edit" }).click();
  await expect(director.getByRole("button", { name: /^Object path 1:/ })).toBeVisible();

  const objectAction = director.locator(".director-action-row").first();
  await objectAction.getByLabel("Motion meaning").selectOption("depth_in");
  await objectAction.getByRole("textbox").fill("Truck sweeps right");
  await objectAction.getByLabel("Easing").selectOption("ease_out");
  await objectAction.getByRole("spinbutton", { name: "Truck sweeps right: Start" }).fill("0.2");
  await objectAction.getByRole("spinbutton", { name: "Truck sweeps right: End" }).fill("0.85");

  await director.getByRole("button", { name: "Freeform mask", exact: true }).click();
  await canvasContent.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const polygonBounds = await canvasContent.boundingBox();
  expect(polygonBounds).not.toBeNull();
  await page.mouse.move(polygonBounds!.x + polygonBounds!.width * 0.55, polygonBounds!.y + polygonBounds!.height * 0.28);
  await page.mouse.down();
  await page.mouse.move(polygonBounds!.x + polygonBounds!.width * 0.72, polygonBounds!.y + polygonBounds!.height * 0.32, { steps: 3 });
  await page.mouse.move(polygonBounds!.x + polygonBounds!.width * 0.68, polygonBounds!.y + polygonBounds!.height * 0.56, { steps: 3 });
  await page.mouse.move(polygonBounds!.x + polygonBounds!.width * 0.5, polygonBounds!.y + polygonBounds!.height * 0.5, { steps: 3 });
  await page.mouse.move(polygonBounds!.x + polygonBounds!.width * 0.55, polygonBounds!.y + polygonBounds!.height * 0.28, { steps: 3 });
  await page.mouse.up();
  await expect(director.getByRole("button", { name: "Subject 2: Subject 2", exact: true })).toBeVisible();

  await director.getByRole("button", { name: "Camera path", exact: true }).click();
  await canvasContent.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const cameraCanvasBounds = await canvasContent.boundingBox();
  expect(cameraCanvasBounds).not.toBeNull();
  await page.mouse.move(cameraCanvasBounds!.x + cameraCanvasBounds!.width * 0.7, cameraCanvasBounds!.y + cameraCanvasBounds!.height * 0.66);
  await page.mouse.down();
  await page.mouse.move(cameraCanvasBounds!.x + cameraCanvasBounds!.width * 0.42, cameraCanvasBounds!.y + cameraCanvasBounds!.height * 0.32, { steps: 10 });
  await page.mouse.up();
  await expect(director.getByRole("button", { name: /^Camera path 1:/ })).toBeVisible();

  await director.getByRole("button", { name: "Camera rig", exact: true }).click();
  await director.getByRole("combobox", { name: /^Lens character/ }).selectOption("anamorphic");
  await director.getByRole("spinbutton", { name: /^Focal length/ }).fill("50");
  const lastKeyframe = director.locator(".director-keyframe").filter({ hasText: "Last frame" });
  await lastKeyframe.getByRole("combobox").selectOption({ label: "director-last-frame.png" });
  await expect(lastKeyframe).toContainText("Linked");
  await expect(director.getByText("2 of 4 keyframes")).toBeVisible();

  const addKeyframe = director.locator(".director-add-keyframe");
  await addKeyframe.getByRole("combobox", { name: "Role" }).selectOption("middle");
  await addKeyframe.getByRole("combobox", { name: "Source frame" }).selectOption({ label: "director-first-frame.png" });
  await addKeyframe.getByRole("spinbutton", { name: "Timestamp" }).fill("0.35");
  await addKeyframe.getByRole("button", { name: "Add keyframe" }).click();
  await addKeyframe.getByRole("combobox", { name: "Role" }).selectOption("timestamped");
  await addKeyframe.getByRole("combobox", { name: "Source frame" }).selectOption({ label: "director-last-frame.png" });
  await addKeyframe.getByRole("spinbutton", { name: "Timestamp" }).fill("0.7");
  await addKeyframe.getByRole("button", { name: "Add keyframe" }).click();
  const interiorKeyframes = director.locator(".director-keyframe-row");
  await expect(interiorKeyframes).toHaveCount(2);
  await expect(director.getByText("4 of 4 keyframes")).toBeVisible();
  const keyframeMarkers = director.locator(".director-keyframe-marker");
  await expect(keyframeMarkers).toHaveCount(4);
  await expect(keyframeMarkers.filter({ hasText: "F" })).toHaveAttribute("aria-label", "First frame: 0.0s");
  await expect(keyframeMarkers.filter({ hasText: "M" })).toHaveAttribute("aria-label", "Middle frame: 1.8s");
  await expect(keyframeMarkers.filter({ hasText: "T" })).toHaveAttribute("aria-label", "Timed frame: 3.5s");
  await expect(keyframeMarkers.filter({ hasText: "L" })).toHaveAttribute("aria-label", "Last frame: 5.0s");
  const keyframesBeforeMove = await savedDirectorPlan(page) as { shots: Array<{ keyframeIds: string[] }> };
  await interiorKeyframes.first().getByRole("button", { name: "Move keyframe later" }).click();
  await expect.poll(async () => (await savedDirectorPlan(page) as { shots: Array<{ keyframeIds: string[] }> }).shots[0]!.keyframeIds)
    .not.toEqual(keyframesBeforeMove.shots[0]!.keyframeIds);

  await director.getByRole("button", { name: "Shot settings", exact: true }).click();
  const firstShotEditor = director.locator(".director-shot-editor");
  await firstShotEditor.getByRole("spinbutton", { name: "Duration" }).fill("2");
  await firstShotEditor.getByRole("combobox", { name: "Speed" }).selectOption("slow_motion");
  await firstShotEditor.getByRole("textbox", { name: "Shot direction" }).fill("Establish the fruit truck crossing the orchard.");
  const initialShotId = (await savedDirectorPlan(page) as { shots: Array<{ id: string }> }).shots[0]!.id;

  await director.getByRole("button", { name: "Add shot" }).click();
  await expect(director.locator(".director-shot-segment")).toHaveCount(2);
  const secondShotEditor = director.locator(".director-shot-editor");
  await secondShotEditor.getByRole("spinbutton", { name: "Duration" }).fill("3");
  await secondShotEditor.getByRole("combobox", { name: "Speed" }).selectOption("speed_up");
  await secondShotEditor.getByRole("textbox", { name: "Shot direction" }).fill("Finish on the orchard reveal.");
  await secondShotEditor.getByRole("checkbox", { name: /Truck sweeps right/ }).check();
  await expect.poll(async () => (await savedDirectorPlan(page) as { shots: Array<{ promptFragment: string }> }).shots
    .some((shot) => shot.promptFragment === "Finish on the orchard reveal.")).toBe(true);
  const secondShotId = (await savedDirectorPlan(page) as { shots: Array<{ id: string; promptFragment: string }> }).shots
    .find((shot) => shot.promptFragment === "Finish on the orchard reveal.")!.id;
  await secondShotEditor.getByRole("button", { name: "Move shot earlier" }).click();
  await expect.poll(async () => (await savedDirectorPlan(page) as { shots: Array<{ id: string; order: number }> }).shots
    .toSorted((left, right) => left.order - right.order).map((shot) => shot.id)).toEqual([secondShotId, initialShotId]);

  await director.getByRole("button", { name: "Duplicate shot" }).click();
  await expect(director.locator(".director-shot-segment")).toHaveCount(3);
  await director.getByRole("button", { name: "Delete shot" }).click();
  await expect(director.locator(".director-shot-segment")).toHaveCount(2);

  const previewPosition = director.getByRole("slider", { name: "Animatic position" });
  const initialPreview = Number(await previewPosition.inputValue());
  await director.getByRole("button", { name: "Play animatic" }).click();
  await expect(director.getByRole("button", { name: "Pause animatic" })).toBeVisible();
  await expect.poll(async () => Number(await previewPosition.inputValue())).toBeGreaterThan(initialPreview);
  await director.getByRole("button", { name: "Pause animatic" }).click();
  expect(paidVideoRequests).toBe(0);

  await expect.poll(() => savedDirectorPlan(page)).toMatchObject({
    enabled: true,
    sourceAssetId: expect.any(String),
    subjects: expect.arrayContaining([
      expect.objectContaining({ label: "Subject 1", region: expect.objectContaining({ type: "box" }) }),
      expect.objectContaining({ label: "Subject 2", region: expect.objectContaining({ type: "polygon" }) }),
    ]),
    motions: [
      expect.objectContaining({ targetType: "subject", kind: "depth_in", actionLabel: "Truck sweeps right", start: 0.2, end: 0.85, easing: "ease_out" }),
      expect.objectContaining({ targetType: "camera" }),
    ],
    keyframes: expect.arrayContaining([
      expect.objectContaining({ role: "first" }),
      expect.objectContaining({ role: "middle", time: 0.7 }),
      expect.objectContaining({ role: "timestamped", time: 0.35 }),
      expect.objectContaining({ role: "last" }),
    ]),
    shots: expect.arrayContaining([
      expect.objectContaining({ id: secondShotId, order: 1, durationSeconds: 3, promptFragment: "Finish on the orchard reveal.", speed: "speed_up" }),
      expect.objectContaining({ id: initialShotId, order: 2, durationSeconds: 2, promptFragment: "Establish the fruit truck crossing the orchard.", speed: "slow_motion" }),
    ]),
  });
  const releaseTwoPlan = await savedDirectorPlan(page) as { motions: Array<{ id: string; targetType: string }>; shots: Array<{ id: string; motionIds: string[] }> };
  const objectMotionId = releaseTwoPlan.motions.find((motion) => motion.targetType === "subject")!.id;
  const cameraMotionId = releaseTwoPlan.motions.find((motion) => motion.targetType === "camera")!.id;
  expect(releaseTwoPlan.shots.find((shot) => shot.id === secondShotId)!.motionIds).toContain(objectMotionId);
  expect(releaseTwoPlan.shots.find((shot) => shot.id === initialShotId)!.motionIds).toContain(cameraMotionId);

  await director.getByRole("button", { name: "Close Director" }).click();
  await page.getByRole("button", { name: "Request", exact: true }).click();
  const requestDialog = page.getByRole("dialog", { name: "Request Preview" });
  await requestDialog.getByRole("button", { name: "Prepare final request" }).click();
  await expect(requestDialog.locator(".request-readiness")).toContainText("Final");
  const directorRequest = requestDialog.getByRole("region", { name: "Director request details" });
  await expect(directorRequest).toBeVisible();
  await expect(directorRequest.getByRole("heading", { name: "Fidelity by control" })).toBeVisible();
  await expect(directorRequest).toContainText("Native");
  await expect(directorRequest).toContainText("Keyframe");
  await expect(directorRequest).toContainText("Prompt");
  await expect(directorRequest.getByRole("heading", { name: "Provider native options" })).toBeVisible();
  const providerOptions = directorRequest.locator(".director-preview-section").filter({ hasText: "Provider native options" });
  await expect(providerOptions.locator("pre")).toContainText("focal_length_mm");
  await expect(directorRequest.getByRole("heading", { name: "Director Brief" })).toBeVisible();
  await expect(directorRequest).toContainText("anamorphic lens character");
  await page.getByRole("button", { name: "Close request preview" }).click();
  expect(paidVideoRequests).toBe(0);

  const beforeModelChange = await savedDirectorPlan(page);
  await page.locator(".model-selector-trigger").click();
  await page.locator(".model-select-main").filter({ hasText: "Director Prompt Video" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Change model" }).click();
  await expect(page.getByRole("heading", { name: "Director Prompt Video" })).toBeVisible();
  await expect.poll(() => savedDirectorPlan(page)).toEqual(beforeModelChange);

  await page.getByRole("button", { name: "Open Director", exact: true }).click();
  const reopenedDirector = page.getByRole("region", { name: "Direct the shot" });
  await expect(reopenedDirector.getByRole("button", { name: /^Object path 1:/ })).toBeVisible();
  await reopenedDirector.locator(".director-shot-segment").nth(1).click();
  await expect(reopenedDirector.getByRole("button", { name: /^Camera path 1:/ })).toBeVisible();
  await expect(reopenedDirector.locator('.director-fidelity[data-fidelity="prompt"]')).not.toHaveCount(0);

  await page.setViewportSize({ width: 980, height: 680 });
  const compactLayout = await director.evaluate((element) => ({
    viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelWidth: element.getBoundingClientRect().width,
    position: getComputedStyle(element).position,
  }));
  expect(compactLayout).toMatchObject({ viewportWidth: 980, documentWidth: 980, position: "static" });
  expect(compactLayout.panelWidth).toBeLessThanOrEqual(980);
  const prompt = page.getByRole("combobox", { name: /^Prompt/ });
  await prompt.scrollIntoViewIfNeeded();
  await expect(prompt).toBeVisible();
  await expect(page.locator(".model-selector-trigger")).toBeVisible();
  expect(paidVideoRequests).toBe(0);

  await director.getByRole("button", { name: "Close Director" }).click();
  await page.getByRole("button", { name: "Prepare final request" }).click();
  await expect(page.getByRole("button", { name: "Generate Video" })).toBeEnabled();
  expect(plannerCalls).toBe(0);
  await page.getByRole("button", { name: "Request", exact: true }).click();
  const finalDialog = page.getByRole("dialog", { name: "Request Preview" });
  await expect(finalDialog.locator(".request-readiness")).toContainText("Final");
  const reviewedPayload = JSON.parse(await finalDialog.locator(".request-payload").textContent() ?? "{}");
  expect(reviewedPayload.prompt).toContain("[Director Brief]");
  await finalDialog.getByRole("button", { name: "Close request preview" }).click();

  const paidRequest = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/videos",
    { timeout: 5_000 },
  );
  await page.getByRole("button", { name: "Generate Video" }).click();
  const submittedPayload = (await paidRequest.catch(async (error) => {
    const persistedAttempt = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
      const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
      const thread = session?.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video);
      return thread?.attempts?.at(-1);
    });
    const renderedError = await page.locator(".generation-failure-guidance code").textContent({ timeout: 1_000 }).catch(() => null);
    throw new Error(`${String(error)}; persisted attempt: ${JSON.stringify(persistedAttempt)}; rendered error: ${String(renderedError)}`);
  })).postDataJSON();
  expect(normalizeMediaPayloads(submittedPayload)).toEqual(normalizeMediaPayloads(reviewedPayload));
  expect(submittedPayload.frame_images).toEqual(expect.arrayContaining([
    expect.objectContaining({ frame_type: "first_frame" }),
    expect.objectContaining({ frame_type: "last_frame" }),
  ]));
  expect(paidVideoRequests).toBe(1);
  expect(plannerCalls).toBe(0);

  const attemptedDirectorPlan = await savedAttemptDirectorPlan(page);
  expect(attemptedDirectorPlan).toEqual(beforeModelChange);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: "Open Director", exact: true }).click();
  const postAttemptDirector = page.getByRole("region", { name: "Direct the shot" });
  await postAttemptDirector.getByRole("button", { name: "Camera rig", exact: true }).click();
  await postAttemptDirector.getByRole("combobox", { name: /^Lens character/ }).selectOption("vintage");
  await expect.poll(() => savedDirectorPlan(page)).not.toEqual(attemptedDirectorPlan);
  await postAttemptDirector.getByRole("button", { name: "Close Director" }).click();

  await page.locator(".attempt-history-trigger").click();
  const attemptHistory = page.locator(".attempt-history-popover");
  await expect(attemptHistory).toBeVisible();
  await attemptHistory.getByRole("button", { name: "Restore settings", exact: true }).click();
  await expect.poll(() => savedDirectorPlan(page)).toEqual(attemptedDirectorPlan);
  expect(paidVideoRequests).toBe(1);
});

test("Director supports keyboard path editing and relinks a missing source without losing the plan", async ({ page }) => {
  test.setTimeout(45_000);

  expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runway Director Native" })).toBeVisible();
  await importFramePair(page);
  await chooseInputRole(page, "director-first-frame.png", "First frame");
  await chooseInputRole(page, "director-last-frame.png", "Last frame");

  await page.getByRole("button", { name: "Open Director", exact: true }).click();
  const director = page.getByRole("region", { name: "Direct the shot" });
  const canvas = director.getByRole("application", { name: "Director motion canvas" });

  await director.getByRole("button", { name: "Mark subject", exact: true }).click();
  await canvas.focus();
  await canvas.press(" ");
  await canvas.press("Shift+ArrowRight");
  await canvas.press("Shift+ArrowRight");
  await canvas.press("Shift+ArrowDown");
  await canvas.press("Enter");
  await expect(director.getByRole("button", { name: "Subject 1: Subject 1", exact: true })).toBeVisible();
  await expect(director.getByRole("button", { name: "Object path", exact: true })).toHaveAttribute("aria-pressed", "true");

  await canvas.focus();
  await canvas.press(" ");
  await canvas.press("Shift+ArrowRight");
  await canvas.press("Shift+ArrowRight");
  await canvas.press("Shift+ArrowUp");
  await canvas.press("Enter");
  const objectPath = director.getByRole("button", { name: /^Object path 1:/ });
  await expect(objectPath).toBeVisible();
  await expect.poll(async () => (await savedDirectorPlan(page) as { motions?: unknown[] })?.motions?.length).toBe(1);

  const beforeNudge = await savedDirectorPlan(page) as {
    motions: Array<{ path: Array<{ x: number; y: number }> }>;
  };
  const pathStartBeforeNudge = beforeNudge.motions[0]!.path[0]!;
  await objectPath.focus();
  await objectPath.press("Shift+ArrowRight");
  await expect.poll(async () => {
    const plan = await savedDirectorPlan(page) as { motions: Array<{ path: Array<{ x: number; y: number }> }> };
    return plan.motions[0]!.path[0]!.x;
  }).toBeCloseTo(pathStartBeforeNudge.x + 0.05, 5);

  const nudgedPlan = await savedDirectorPlan(page) as {
    sourceAssetId: string;
    subjects: Array<{ sourceAssetId: string }>;
    motions: unknown[];
    keyframes: Array<{ role: string; assetId: string }>;
    shots: unknown[];
  };
  await objectPath.press("Delete");
  await expect(objectPath).toHaveCount(0);
  await director.getByRole("button", { name: "Undo Director edit" }).click();
  await expect(director.getByRole("button", { name: /^Object path 1:/ })).toBeVisible();
  await expect.poll(async () => (await savedDirectorPlan(page) as { motions: unknown[] }).motions).toEqual(nudgedPlan.motions);

  const originalSourceAssetId = nudgedPlan.sourceAssetId;
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    const thread = session?.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video);
    const plan = thread?.draft.directorPlan;
    if (!plan?.sourceAssetId) throw new Error("The keyboard Director plan has no source to mark missing.");
    const priorSourceAssetId = plan.sourceAssetId;
    const missingSourceAssetId = "missing-director-source-e2e";
    plan.sourceAssetId = missingSourceAssetId;
    plan.subjects = plan.subjects.map((subject: { sourceAssetId: string }) => subject.sourceAssetId === priorSourceAssetId
      ? { ...subject, sourceAssetId: missingSourceAssetId }
      : subject);
    plan.keyframes = plan.keyframes.map((keyframe: { role: string; assetId: string }) => keyframe.role === "first"
      ? { ...keyframe, assetId: missingSourceAssetId }
      : keyframe);
    localStorage.setItem("fruit-truck.studio.v1", JSON.stringify(state));
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Runway Director Native" })).toBeVisible();
  await page.getByRole("button", { name: "Open Director", exact: true }).click();

  const missingDirector = page.getByRole("region", { name: "Direct the shot" });
  const missingAssetAlert = missingDirector.getByRole("alert").filter({
    hasText: "A Director asset is missing. Relink it to continue without losing the plan.",
  });
  await expect(missingAssetAlert).toContainText(
    "A Director asset is missing. Relink it to continue without losing the plan.",
  );
  await expect.poll(async () => (await savedDirectorPlan(page) as { motions: unknown[] }).motions).toEqual(nudgedPlan.motions);
  await missingDirector.getByRole("combobox", { name: "Relink asset" }).selectOption(originalSourceAssetId);
  await expect(missingAssetAlert).toHaveCount(0);
  await expect.poll(async () => (await savedDirectorPlan(page) as { sourceAssetId?: string }).sourceAssetId).toBe(originalSourceAssetId);

  const relinkedPlan = await savedDirectorPlan(page) as typeof nudgedPlan;
  expect(relinkedPlan.sourceAssetId).toBe(originalSourceAssetId);
  expect(relinkedPlan.subjects).toEqual(nudgedPlan.subjects);
  expect(relinkedPlan.motions).toEqual(nudgedPlan.motions);
  expect(relinkedPlan.keyframes).toHaveLength(nudgedPlan.keyframes.length);
  expect(relinkedPlan.keyframes).toEqual(expect.arrayContaining(nudgedPlan.keyframes));
  expect(relinkedPlan.shots).toEqual(nudgedPlan.shots);
});

test("Director sends the source and rasterized Visual guide as separate reviewed references", async ({ page }) => {
  test.setTimeout(45_000);
  let paidVideoRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/videos") paidVideoRequests += 1;
  });

  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runway Director Native" })).toBeVisible();
  await importFramePair(page);
  await chooseInputRole(page, "director-first-frame.png", "First frame");
  await chooseInputRole(page, "director-last-frame.png", "Last frame");
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("The truck follows the drawn curve.");
  await expect(page.getByRole("toolbar", { name: "Prompt enhancement" })).toBeVisible();

  await page.getByRole("button", { name: "Open Director", exact: true }).click();
  const director = page.getByRole("region", { name: "Direct the shot" });
  const canvasContent = director.locator(".director-canvas-content");
  await director.getByRole("button", { name: "Mark subject", exact: true }).click();
  await canvasContent.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const contentBounds = await canvasContent.boundingBox();
  expect(contentBounds).not.toBeNull();
  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.2, contentBounds!.y + contentBounds!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.45, contentBounds!.y + contentBounds!.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.3, contentBounds!.y + contentBounds!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(contentBounds!.x + contentBounds!.width * 0.75, contentBounds!.y + contentBounds!.height * 0.35, { steps: 10 });
  await page.mouse.up();
  await expect(director.getByRole("button", { name: /^Object path 1:/ })).toBeVisible();
  await director.getByRole("button", { name: "Close Director" }).click();

  // Keeping the drawn subject's source as an ordinary reference leaves capacity
  // for the source bitmap and its rasterized motion guide alongside a last frame.
  await chooseInputRole(page, "director-first-frame.png", "Reference");
  await expect.poll(() => savedDirectorPlan(page)).toMatchObject({
    keyframes: [expect.objectContaining({ role: "last" })],
    motions: [expect.objectContaining({ targetType: "subject" })],
  });
  expect((await savedDirectorPlan(page) as { sourceAssetId?: string }).sourceAssetId).toBeUndefined();
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    const thread = session?.threads.video.find((item: { id: string }) => item.id === session.activeThreadIds.video);
    const sourceAssetId = thread?.draft.directorPlan?.subjects?.[0]?.sourceAssetId;
    if (!sourceAssetId) throw new Error("The Visual E2E plan has no subject source to preserve.");
    thread.draft.directorPlan.sourceAssetId = sourceAssetId;
    localStorage.setItem("fruit-truck.studio.v1", JSON.stringify(state));
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Runway Director Native" })).toBeVisible();
  await expect.poll(async () => (await savedDirectorPlan(page) as { sourceAssetId?: string }).sourceAssetId).toEqual(expect.any(String));

  await page.getByRole("button", { name: "Request", exact: true }).click();
  const requestDialog = page.getByRole("dialog", { name: "Request Preview" });
  await requestDialog.getByRole("button", { name: "Prepare final request" }).click();
  await expect(requestDialog.locator(".request-readiness")).toContainText("Final");
  const directorRequest = requestDialog.getByRole("region", { name: "Director request details" });
  await expect(directorRequest.getByText("Visual", { exact: true })).not.toHaveCount(0);
  const reviewedPayload = JSON.parse(await requestDialog.locator(".request-payload").textContent() ?? "{}");
  expect(reviewedPayload.input_references).toHaveLength(2);
  expect(reviewedPayload.input_references).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "image_url", image_url: { url: expect.stringContaining("<media payload omitted") } }),
  ]));
  expect(reviewedPayload.frame_images).toEqual([
    expect.objectContaining({ frame_type: "last_frame" }),
  ]);
  await requestDialog.getByRole("button", { name: "Close request preview" }).click();
  expect(paidVideoRequests).toBe(0);

  const paidRequest = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/videos",
    { timeout: 5_000 },
  );
  await page.getByRole("button", { name: "Generate Video" }).click();
  const submittedPayload = (await paidRequest).postDataJSON();
  expect(normalizeMediaPayloads(submittedPayload)).toEqual(normalizeMediaPayloads(reviewedPayload));
  const submittedReferenceUrls = submittedPayload.input_references.map((reference: { image_url: { url: string } }) => reference.image_url.url);
  expect(submittedReferenceUrls.filter((url: string) => url.startsWith("data:image/png"))).toHaveLength(2);
  expect(new Set(submittedReferenceUrls).size).toBe(2);
  expect(submittedPayload.frame_images.map((frame: { frame_type: string }) => frame.frame_type)).toEqual(["last_frame"]);
  expect(paidVideoRequests).toBe(1);
});
