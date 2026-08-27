import { expect, test, type Page } from "@playwright/test";

// A real, decodable 16×16 H.264 MP4 keeps browser/native media paths honest.
const TINY_MP4_BASE64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANdbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAod0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAABAAAAAAH/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABqm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAL7iAAAAAAAAABhzdHRzAAAAAAAAAAEAAAADAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAKGN0dHMAAAAAAAAAAwAAAAEAAAQAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAAsUAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAONAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDAAAAAIZnJlZQAAAuVtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXN0PTHh0zoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAAz//727L4FNhTIwQAAAAhBmiJsQr/+wAAAAAgBnkF5Cv/EgQ==";

function plannerPlan(mode: "image" | "video", workflow: string, hasReference = false) {
  return {
    version: 1,
    mode,
    workflow,
    language: "en",
    deliverable: mode === "image" ? "a polished image" : "a polished short video",
    intent: "preserve the user's request",
    scene: ["a fruit truck"],
    subjects: ["the fruit truck"],
    action: mode === "video" ? ["moves through the scene"] : [],
    composition: ["clear composition"],
    camera: [],
    lighting: ["restrained lighting"],
    color: [],
    style: ["polished"],
    materials: [],
    exactText: [],
    temporalBeats: mode === "video" ? ["the truck moves steadily"] : [],
    subjectMotion: mode === "video" ? ["steady forward movement"] : [],
    cameraMotion: mode === "video" ? ["a tracking shot"] : [],
    audio: [],
    editChanges: [],
    preserve: [],
    ambiguities: [],
    constraints: mode === "image"
      ? [{ requirement: "avoid watermark", desiredState: "the image has a clean unmarked finish" }]
      : [],
    references: hasReference ? [{
      slot: 1,
      target: "the final visual finish",
      purpose: "style",
      priority: "optional",
      evidence: "user",
      copy: ["surface treatment"],
      preserve: [],
      ignore: ["unrelated source content"],
    }] : [],
  };
}

async function mockWorkspaceApi(page: Page) {
  await page.route("https://openrouter.ai/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/key") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: { label: "Fruit Truck E2E", limit: 5, limit_remaining: 5 } }),
      });
      return;
    }
    if (path === "/api/v1/images/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [
          {
            id: "google/gemini-2.5-flash-image",
            name: "Test image model",
            supported_parameters: {
              input_references: { type: "range", min: 0, max: 4 },
              negative_prompt: { type: "boolean" },
            },
          },
          {
            id: "openai/gpt-image-1",
            name: "OpenAI: Comparison image model",
            supported_sizes: ["1024x1024"],
            pricing: { image: "0.08" },
            supported_parameters: {},
          },
        ] }),
      });
      return;
    }
    if (path === "/api/v1/images/models/google/gemini-2.5-flash-image/endpoints") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ endpoints: [{ endpoint_id: "google-route", provider_name: "Google", provider_slug: "google", supported_parameters: { input_references: { type: "range", min: 0, max: 4 }, negative_prompt: { type: "boolean" } }, supports_streaming: true, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }], privacy: { zdr: true, data_collection: "deny" } }] }) });
      return;
    }
    if (path === "/api/v1/images/models/openai/gpt-image-1/endpoints") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ endpoints: [{ endpoint_id: "openai-route", provider_name: "OpenAI", provider_slug: "openai", supported_parameters: {}, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.08 }] }] }) });
      return;
    }
    if (path === "/api/v1/videos/models" || path === "/api/v1/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [{
          id: "test/video",
          name: "Test video model",
          supported_durations: [5],
          supported_resolutions: ["720p"],
          supported_aspect_ratios: ["16:9"],
          endpoints: [{ endpoint_id: "video-route", provider_name: "Test Video Provider", provider_slug: "test-video", supported_parameters: { duration: { type: "enum", values: [5] }, resolution: { type: "enum", values: ["720p"] }, aspect_ratio: { type: "enum", values: ["16:9"] } }, pricing_skus: { generation: "$0.20" }, privacy: { zdr: false, data_collection: "allow" } }],
        }] }),
      });
      return;
    }
    if (path === "/api/v1/chat/completions") {
      const body = request.postDataJSON() as { messages?: Array<{ content?: unknown }> };
      const system = body.messages?.map((message) => typeof message.content === "string" ? message.content : "").join(" ") ?? "";
      const serializedMessages = JSON.stringify(body.messages ?? []);
      const mode = system.includes("video generation") ? "video" : "image";
      const workflow = system.match(/Resolved workflow: ([a-z_]+)\./)?.[1] ?? (mode === "video" ? "text_to_video" : "text_to_image");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(plannerPlan(mode, workflow, serializedMessages.includes("@1:"))) } }], usage: { cost: 0.01 } }),
      });
      return;
    }
    if (path === "/api/v1/images" && request.method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [{ url: "http://127.0.0.1:4179/fruit-truck-icon.png" }], usage: { cost: 0.04 } }),
      });
      return;
    }
    if (path === "/api/v1/videos" && request.method() === "POST") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "video-e2e", status: "pending", usage: { cost: 0.2 } }) });
      return;
    }
    if (path === "/api/v1/videos/video-e2e" && request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "video-e2e", status: "completed", progress: 100, usage: { cost: 0.27 } }) });
      return;
    }
    if (path === "/api/v1/videos/video-e2e/content") {
      await route.fulfill({ contentType: "video/mp4", body: Buffer.from(TINY_MP4_BASE64, "base64") });
      return;
    }
    await route.fulfill({ status: 404, body: "Not mocked" });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("fruit-truck.dev-key", "sk-or-v1-workspace-e2e-key-1234567890");
    localStorage.setItem("fruit-truck.onboarding.complete.v1", "true");
    localStorage.setItem("fruit-truck.language", "en");
    localStorage.removeItem("fruit-truck.studio.v1");
  });
  await mockWorkspaceApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Test image model" })).toBeVisible();
});

test("full-window workspace has one flow and applies enhancement defaults everywhere", async ({ page }) => {
  expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  await expect(page.locator(".asset-library")).toBeVisible();
  await expect(page.locator(".asset-library-header")).toContainText("Asset library");
  await expect(page.getByText("Agent", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/assembly/i)).toHaveCount(0);
  await expect(page.getByText(/review queue/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Settings" }).click();
  const defaultSwitch = page.locator(".settings-switch-field [role=switch]");
  await expect(defaultSwitch).toHaveAttribute("aria-checked", "true");
  await defaultSwitch.click();
  await expect(defaultSwitch).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "New thread" }).click();
  await expect(page.locator(".thread-tab")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    return state.sessions?.flatMap((session: { threads: { image: Array<{ draft: { enhancePrompt: boolean } }>; video: Array<{ draft: { enhancePrompt: boolean } }> } }) =>
      [...session.threads.image, ...session.threads.video].map((thread) => thread.draft.enhancePrompt)
    );
  })).toEqual([false, false, false]);

  await page.getByRole("button", { name: "Duplicate Image 2" }).click();
  await expect(page.locator(".thread-tab")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    return session?.threads.image.at(-1)?.draft.enhancePrompt;
  })).toBe(false);

  await page.locator(".thread-tab").filter({ hasText: "Image 2 copy" }).hover();
  await page.getByRole("button", { name: "Rename Image 2 copy" }).click();
  await page.getByRole("textbox", { name: "Rename thread" }).fill("Reference draft");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator(".thread-tab").filter({ hasText: "Reference draft" })).toBeVisible();
  await page.locator(".thread-tab").filter({ hasText: "Reference draft" }).hover();
  await page.getByRole("button", { name: "Archive Reference draft" }).click();
  await expect(page.locator(".thread-tab")).toHaveCount(2);
  await page.getByText("Archived (1)").click();
  await page.getByRole("button", { name: "Restore Reference draft" }).click();
  await expect(page.locator(".thread-tab")).toHaveCount(3);

  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByText("2 total")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    const session = state.sessions?.find((item: { id: string }) => item.id === state.activeSessionId);
    return [session?.threads.image[0]?.draft.enhancePrompt, session?.threads.video[0]?.draft.enhancePrompt];
  })).toEqual([false, false]);

  await page.getByRole("combobox", { name: /^Prompt/ }).fill("A quiet fruit truck at dawn.");
  await page.getByRole("button", { name: "Prepare final request" }).click();
  await expect(page.getByRole("button", { name: "Generate Image" })).toBeEnabled();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(page.getByText("Generation complete")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Saved to Asset library")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("status", { name: /Session spend: \$0\.04/ })).toBeVisible();
});

test("model comparison stays local and exposes contract differences before request preparation", async ({ page }) => {
  let paidImageRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/images") paidImageRequests += 1;
  });
  await page.getByRole("button", { name: "Choose a model" }).click();
  await page.getByRole("button", { name: "Compare Test image model" }).click();
  await page.getByRole("button", { name: "Compare OpenAI: Comparison image model" }).click();
  const comparison = page.getByRole("region", { name: "Current-draft model comparison" });
  await expect(comparison).toContainText("Test image model");
  await expect(comparison).toContainText("Comparison image model");
  await expect(comparison).toContainText("endpoint verified");
  await page.locator(".model-select-main").filter({ hasText: "Comparison image model" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Change generation model?");
  await expect(confirmation).toContainText("Test image model → OpenAI: Comparison image model");
  await expect(confirmation).toContainText("$0.08/image");
  await confirmation.getByRole("button", { name: "Change model" }).click();
  await expect(page.getByRole("heading", { name: "OpenAI: Comparison image model" })).toBeVisible();
  expect(paidImageRequests).toBe(0);
});

test("attempt history preserves exact replay settings and duplicates without submitting", async ({ page }) => {
  let paidImageRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/images") paidImageRequests += 1;
  });
  const prompt = "A replayable fruit truck portrait.";
  await page.getByRole("combobox", { name: /^Prompt/ }).fill(prompt);
  await page.getByRole("button", { name: "Prepare final request" }).click();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(page.getByText("Generation complete")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  expect(paidImageRequests).toBe(1);

  await page.locator(".attempt-history-trigger").click();
  const history = page.locator(".attempt-history-popover");
  await expect(history).toContainText("Generation · actual");
  await expect(history).toContainText("Prompt planner · actual");
  await expect(history.getByText("Exact request snapshot")).toBeVisible();
  await history.getByRole("button", { name: "Duplicate to new thread" }).click();
  await expect(page.getByText("Attempt settings copied to a new thread. Review the final request before generating.")).toBeVisible();
  await expect(page.locator(".thread-tab")).toHaveCount(2);
  await expect(page.getByRole("combobox", { name: /^Prompt/ })).toHaveValue(prompt);
  expect(paidImageRequests).toBe(1);
});

test("paid image materialization failures retain cost and a visible recovery payload", async ({ page }) => {
  await page.route("https://openrouter.ai/api/v1/images", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        usage: { cost: 0.037 },
        _fruit_truck_recovery_path: "/managed/recovery/image-e2e-response.json",
        _fruit_truck_materialization_errors: ["result 1 could not be materialized"],
      }),
    });
  });

  await page.getByRole("combobox", { name: /^Prompt/ }).fill("A recoverable fruit truck image.");
  await page.getByRole("button", { name: "Prepare final request" }).click();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(page.getByRole("status", { name: /Session spend: \$0\.04/ })).toBeVisible();
  await page.locator(".attempt-history-trigger").click();
  const history = page.locator(".attempt-history-popover");
  await expect(history).toContainText("Retained recovery payload");
  await expect(history).toContainText("/managed/recovery/image-e2e-response.json");
  await expect(history).toContainText("Generation · actual");
  await expect(history).toContainText("$0.037");
});

test("stopping an image response is honest about possible remote billing", async ({ page }) => {
  let paidImageRequests = 0;
  await page.route("https://openrouter.ai/api/v1/images", async (route) => {
    paidImageRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ url: "http://127.0.0.1:4179/fruit-truck-icon.png" }], usage: { cost: 0.04 } }),
    }).catch(() => undefined);
  });

  await page.getByRole("combobox", { name: /^Prompt/ }).fill("A deliberately interrupted image response.");
  await page.getByRole("button", { name: "Prepare final request" }).click();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await page.locator(".attempt-history-trigger").click();
  const history = page.locator(".attempt-history-popover");
  await history.getByRole("button", { name: "Stop local response" }).click();
  await expect(history).toContainText("The provider may still finish and bill this request");
  await expect(history).toContainText("Wait for billing or provider evidence before retrying");
  expect(paidImageRequests).toBe(1);
});

test("video generation completes in the same workspace and records session cost", async ({ page }) => {
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Test video model" })).toBeVisible();
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("A five second tracking shot of a fruit truck.");
  await page.getByRole("button", { name: "Prepare final request" }).click();
  await expect(page.getByRole("button", { name: "Generate Video" })).toBeEnabled();
  await page.getByRole("button", { name: "Generate Video" }).click();
  await expect(page.getByText("Generation complete")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("Saved to Asset library")).toBeVisible();
  await expect(page.getByRole("status", { name: /Session spend: \$0\.28/ })).toBeVisible();
});

test("the reviewed final payload is the exact payload submitted after enhancement", async ({ page }) => {
  let plannerCalls = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/chat/completions") plannerCalls += 1;
  });
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("A precise editorial fruit truck portrait.");
  await page.getByRole("button", { name: "Prepare final request" }).click();
  await expect(page.getByRole("button", { name: "Generate Image" })).toBeEnabled();

  await page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(page.locator(".request-readiness")).toContainText("Final · ready to send");
  const reviewedPayload = JSON.parse(await page.locator(".request-dialog-body pre").textContent() ?? "{}");
  expect(reviewedPayload.stream).toBe(true);
  await page.getByRole("button", { name: "Close request preview" }).click();

  const paidRequest = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/images"
  );
  await page.getByRole("button", { name: "Generate Image" }).click();
  const submittedPayload = (await paidRequest).postDataJSON();
  expect(submittedPayload).toEqual(reviewedPayload);
  expect(plannerCalls).toBe(1);
});

test("reference purpose, coverage mapping, and separate exclusions stay visible in the request", async ({ page }) => {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Drop assets here or choose files/ }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "style-reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });

  await expect(page.locator(".reference-row strong", { hasText: "style-reference.png" })).toBeVisible();
  await page.getByRole("combobox", { name: "Reference purpose for style-reference.png" }).click();
  await page.getByRole("option", { name: "Style", exact: true }).click();
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("Optionally use @1 for a restrained editorial finish.");
  await page.locator(".enhance-row").getByRole("button", { name: "Preview", exact: true }).click();

  await page.getByText("Enhanced prompt · inspect or edit").click();
  const exclusions = page.getByRole("textbox", { name: "Exclusions sent separately" });
  await expect(exclusions).toHaveValue("avoid watermark");
  await exclusions.fill("watermark; extra logo");

  await page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.locator(".request-dialog").getByRole("button", { name: "Prepare final request" }).click();
  await expect(page.locator(".request-readiness")).toContainText("Final · ready to send");
  const mapping = page.locator(".request-mapping");
  await expect(mapping).toContainText("Style");
  await expect(mapping).toContainText("mapped");
  await expect(page.locator(".request-dialog-body pre")).toContainText('"negative_prompt": "watermark; extra logo"');
  await expect(page.locator(".request-dialog-body pre")).toContainText("Image 1");
});

test("an imported asset can be previewed, reused, exported, edited, and explicitly deleted", async ({ page }) => {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Drop assets here or choose files/ }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "lifecycle.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });

  const tile = page.locator(".asset-tile").filter({ hasText: "lifecycle.png" });
  await expect(tile).toBeVisible();
  await tile.getByRole("button", { name: "Preview" }).click();
  const preview = page.locator(".asset-preview-dialog");
  await expect(preview).toContainText("lifecycle.png");
  await preview.getByRole("button", { name: "Close preview" }).click();

  await tile.getByRole("button", { name: "Use as input" }).click();
  await expect(page.locator(".reference-row strong", { hasText: "lifecycle.png" })).toBeVisible();
  await tile.getByRole("button", { name: "Edit on canvas" }).click();
  await expect(page.getByText("Image edit", { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await tile.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("lifecycle.png");

  await tile.getByRole("checkbox", { name: "Select lifecycle.png" }).click();
  await page.getByRole("button", { name: "Delete assets (1)" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("attached to a draft");
  await confirmation.getByRole("button", { name: "Delete assets" }).click();
  await expect(tile).toHaveCount(0);
  await expect(page.locator(".reference-row strong", { hasText: "lifecycle.png" })).toHaveCount(0);
});

test("invalid provider passthrough is blocked and explained before submission", async ({ page }) => {
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("A clean studio product image.");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("textbox", { name: "Provider routing & options" }).fill(JSON.stringify({
    options: { google: { parameters: { undocumented: true } } },
  }));

  await expect(page.locator(".provider-options-field .field-error")).toContainText("not declared by the selected endpoint");
  await expect(page.getByRole("button", { name: "Generate Image" })).toBeDisabled();
  await page.getByRole("button", { name: "Request", exact: true }).click();
  const alerts = page.locator(".request-dialog").getByRole("alert");
  await expect(page.locator(".request-readiness")).toContainText("Draft · cannot send");
  await expect(alerts.first()).toContainText("not declared by the selected endpoint");
});

test("named presets expose a settings diff and restore a reviewed model without submitting", async ({ page }) => {
  let paidImageRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/images") paidImageRequests += 1;
  });

  await page.getByRole("textbox", { name: "Preset name" }).fill("Fast editorial");
  await page.getByRole("button", { name: "Save preset" }).click();
  await expect(page.getByText("Saved preset “Fast editorial”.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fruit-truck.studio.v1") ?? "{}");
    return state.generationPresets?.[0]?.name;
  })).toBe("Fast editorial");

  await page.getByRole("button", { name: "Choose a model" }).click();
  await page.locator(".model-select-main").filter({ hasText: "Comparison image model" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Change model" }).click();
  await expect(page.getByRole("heading", { name: "OpenAI: Comparison image model" })).toBeVisible();

  await page.getByRole("combobox", { name: "Saved presets" }).selectOption({ label: "Fast editorial" });
  const presets = page.getByRole("region", { name: "Generation presets" });
  await expect(presets.getByText(/Settings diff · [1-9]/)).toBeVisible();
  await presets.getByRole("button", { name: "Apply preset" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("OpenAI: Comparison image model");
  await expect(confirmation).toContainText("Test image model");
  await confirmation.getByRole("button", { name: "Apply preset" }).click();
  await expect(page.getByRole("heading", { name: "Test image model" })).toBeVisible();
  expect(paidImageRequests).toBe(0);
});

test("workspace checklist loads a safe sample and guides keyboard focus", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Start workspace checklist" }).click();
  const guide = page.getByRole("complementary", { name: "Workspace checklist" });
  await expect(guide).toContainText("Image/video generation is cloud processing");
  await guide.getByRole("button", { name: "Load the safe sample image" }).click();
  await expect(page.locator(".reference-row strong", { hasText: "fruit-truck-workflow-sample.png" })).toBeVisible();
  await expect(guide.locator("li").first()).toHaveAttribute("data-complete", "true");

  await guide.getByRole("button", { name: /Bind it in the prompt/ }).click();
  await expect(page.getByRole("combobox", { name: /^Prompt/ })).toBeFocused();
  await page.getByRole("combobox", { name: /^Prompt/ }).fill("Use @1 as a restrained visual reference.");
  await expect(guide.locator("li").nth(1)).toHaveAttribute("data-complete", "true");
});

test("shortcut help stays contained and focus-trapped at 1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const settings = page.getByRole("button", { name: "Settings" });
  await settings.focus();
  await page.evaluate(() => {
    const mac = navigator.platform.toLowerCase().includes("mac");
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      code: "Slash",
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    }));
  });

  const dialog = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);

  const lastShortcut = dialog.getByText("Undo the last mask stroke");
  await lastShortcut.scrollIntoViewIfNeeded();
  await expect(lastShortcut).toBeVisible();
  for (let index = 0; index < 24; index += 1) await page.keyboard.press("Tab");
  expect(await page.locator(".dialog-viewport").evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
});
