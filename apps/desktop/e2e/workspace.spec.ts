import { expect, test, type Page } from "@playwright/test";

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
    if (path === "/api/v1/images/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [{
          id: "google/gemini-2.5-flash-image",
          name: "Test image model",
          supported_parameters: {
            input_references: { type: "range", min: 0, max: 4 },
            negative_prompt: { type: "boolean" },
          },
        }] }),
      });
      return;
    }
    if (path === "/api/v1/images/models/google/gemini-2.5-flash-image/endpoints") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ endpoints: [] }) });
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
      await route.fulfill({ contentType: "video/mp4", body: Buffer.from("e2e-video") });
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

  await page.getByRole("textbox", { name: /^Prompt/ }).fill("A quiet fruit truck at dawn.");
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(page.getByText("Generation complete")).toBeVisible();
  await expect(page.getByText("Saved to Asset library")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("status", { name: /Session spend: \$0\.04/ })).toBeVisible();
});

test("video generation completes in the same workspace and records session cost", async ({ page }) => {
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Test video model" })).toBeVisible();
  await page.getByRole("textbox", { name: /^Prompt/ }).fill("A five second tracking shot of a fruit truck.");
  await page.getByRole("button", { name: "Generate Video" }).click();
  await expect(page.getByText("Generation complete")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("Saved to Asset library")).toBeVisible();
  await expect(page.getByRole("status", { name: /Session spend: \$0\.28/ })).toBeVisible();
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
  await page.getByRole("textbox", { name: /^Prompt/ }).fill("Optionally use @1 for a restrained editorial finish.");
  await page.locator(".enhance-row").getByRole("button", { name: "Preview", exact: true }).click();

  await page.getByText("Enhanced prompt · inspect or edit").click();
  const exclusions = page.getByRole("textbox", { name: "Exclusions sent separately" });
  await expect(exclusions).toHaveValue("avoid watermark");
  await exclusions.fill("watermark; extra logo");

  await page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const mapping = page.locator(".request-mapping");
  await expect(mapping).toContainText("Style");
  await expect(mapping).toContainText("mapped");
  await expect(page.locator(".request-dialog-body pre")).toContainText('"negative_prompt": "watermark; extra logo"');
  await expect(page.locator(".request-dialog-body pre")).toContainText("Image 1");
});

test("invalid provider passthrough is blocked and explained before submission", async ({ page }) => {
  await page.getByRole("textbox", { name: /^Prompt/ }).fill("A clean studio product image.");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("textbox", { name: "Provider routing & options" }).fill(JSON.stringify({
    options: { google: { parameters: { undocumented: true } } },
  }));

  await expect(page.locator(".provider-options-field .field-error")).toContainText("not declared by the selected endpoint");
  await expect(page.getByRole("button", { name: "Generate Image" })).toBeDisabled();
  await page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Request cannot be sent");
  await expect(page.getByRole("alert")).toContainText("not declared by the selected endpoint");
});
