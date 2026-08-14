import { expect, test, type Page } from "@playwright/test";

async function mockWorkspaceApi(page: Page) {
  await page.route("https://openrouter.ai/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/images/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [{ id: "test/image", name: "Test image model", supported_parameters: {} }] }),
      });
      return;
    }
    if (path === "/api/v1/images/models/test/image/endpoints") {
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
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { content: "A polished studio prompt with restrained lighting." } }], usage: { cost: 0.01 } }),
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
