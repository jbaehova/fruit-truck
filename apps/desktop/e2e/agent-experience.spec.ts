import { expect, test, type Page } from "@playwright/test";
import type { StudioState } from "../src/studio";

const STORAGE_KEY = "fruit-truck.studio.v1";

async function mockImageGeneration(page: Page, imageGate?: Promise<void>, resultCount = 1) {
  await page.route("https://openrouter.ai/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/images/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [{ id: "test/image", name: "Test image model", supported_parameters: { n: { type: "range", min: 1, max: 2 } } }] }),
      });
      return;
    }
    if (path === "/api/v1/images/models/test/image/endpoints") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ endpoints: [] }) });
      return;
    }
    if (path === "/api/v1/videos/models" || path === "/api/v1/models") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) });
      return;
    }
    if (path === "/api/v1/images" && request.method() === "POST") {
      await imageGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: Array.from({ length: resultCount }, () => ({ url: "http://127.0.0.1:4179/fruit-truck-icon.png" })),
          usage: { cost: 0.04 * resultCount },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "Not mocked" });
  });
}

function studioFixture() {
  const createdAt = new Date().toISOString();
  const emptyDraft = {
    prompt: "Create a restrained launch visual.",
    references: [],
    options: {},
    providerJson: "",
    enhancePrompt: true,
    enhancedPrompt: "",
    enhancedPromptDirty: false,
    imageEditMode: false,
    imageEditTarget: "",
    maskInstructions: "",
    maskStrokes: [],
  };
  const state = {
    schemaVersion: 1,
    activeSessionId: "e2e-session",
    promptModel: "openai/gpt-5.6-luna",
    sessions: [{
      id: "e2e-session",
      name: "Chat-owned decisions",
      createdAt,
      updatedAt: createdAt,
      mode: "image",
      videoWorkflow: "generate",
      selectedModelIds: { image: "", video: "" },
      drafts: { image: emptyDraft, videoGenerate: emptyDraft, videoEdit: emptyDraft },
      assets: [{
        id: "asset-final",
        name: "fruit-truck-icon.png",
        kind: "image",
        mimeType: "image/png",
        origin: "generated",
        createdAt,
        externalUrl: "http://127.0.0.1:4179/fruit-truck-icon.png",
      }, {
        id: "asset-video",
        name: "approved-shot.mp4",
        kind: "video",
        mimeType: "video/mp4",
        origin: "generated",
        createdAt,
        externalUrl: "http://127.0.0.1:4179/missing-video.mp4",
        duration: 3,
      }],
      activeVideoJobs: [{
        kind: "video",
        jobId: "job-e2e",
        status: "in_progress",
        progress: 42,
        workflow: "generate",
        model: "test/video",
        submittedAt: createdAt,
        request: {},
      }],
      lastResultAssetIds: { image: ["asset-final"], video: [] },
      agentBridge: true,
      agent: {
        schemaVersion: 1,
        connection: { status: "claimed", claimedAt: createdAt, claimedBy: "e2e-agent" },
        controlMode: "agent",
        runStatus: "waiting",
        brief: {
          originalIntent: "Create a launch visual.",
          goal: "Create a launch visual.",
          deliverable: "Image",
          usage: "Launch",
          visualApproach: "",
          outputSpec: "1:1",
          message: "",
          mustInclude: [],
          mustAvoid: [],
        },
        requirements: [],
        plan: [
          { id: "generate", title: "Generate candidate", description: "Generate.", status: "completed", dependsOn: [] },
          { id: "complete", title: "Approve final", description: "Chat approval.", status: "pending", dependsOn: ["generate"] },
        ],
        decisions: [{
          id: "decision-model",
          semanticKey: "model_selection_image",
          title: "Choose image model",
          prompt: "Choose the image model in agent chat.",
          kind: "choice",
          channel: "fruit_truck_ui",
          presentation: "model_picker",
          selectionMode: "single",
          minSelections: 1,
          maxSelections: 1,
          status: "pending",
          blocking: true,
          relatedAssetIds: [],
          options: [
            { id: "test/image", label: "Test image model", recommended: true, description: "Best fit.", price: "$0.04 / image" },
            { id: "test/other", label: "Other model", price: "$0.08 / image" },
          ],
          createdAt,
        }, {
          id: "decision-upload",
          semanticKey: "identity_refs",
          title: "Attach identity reference",
          prompt: "Choose a reference file.",
          kind: "upload",
          channel: "fruit_truck_ui",
          presentation: "upload",
          selectionMode: "multiple",
          minSelections: 1,
          status: "pending",
          blocking: true,
          relatedAssetIds: [],
          options: [],
          createdAt,
        }, {
          id: "decision-final",
          semanticKey: "final_approval",
          title: "Final result approval",
          prompt: "Review the final result.",
          kind: "approval",
          channel: "fruit_truck_ui",
          presentation: "media_grid",
          selectionMode: "single",
          minSelections: 1,
          maxSelections: 1,
          allowNote: true,
          status: "pending",
          blocking: true,
          relatedStepId: "complete",
          relatedAssetIds: ["asset-final"],
          options: [
            { id: "approve", label: "Approve final", recommended: true },
            { id: "revise", label: "Request revision" },
          ],
          createdAt,
        }],
        activity: [],
        artifacts: [{
          assetId: "asset-final",
          role: "final_image",
          parentAssetIds: [],
          planStepId: "generate",
          modelId: "test/image",
          approval: "unreviewed",
          evaluation: {
            technical: "Format is valid.",
            aesthetic: "Direction is consistent.",
            recommendation: "Approve.",
          },
        }, {
          assetId: "asset-video",
          role: "video_candidate",
          parentAssetIds: [],
          approval: "approved",
        }],
        appliedSkills: [
          { name: "fruit-truck-agent", version: "2.0.0", source: "core" },
          { name: "Installed Skill", version: "2", source: "custom" },
        ],
        imageGeneration: { status: "selected", backend: "openrouter", selectedBy: "policy", selectedAt: createdAt },
        modelSelections: {
          image: { status: "pending_user" },
          video: { status: "unselected" },
        },
        currentStepId: "complete",
        assembly: { clips: [], status: "draft" },
        customSkill: {
          name: "E2E production workflow",
          version: 1,
          markdown: "---\nname: E2E production workflow\nversion: 1\n---\n\n# Workflow",
          status: "proposed",
        },
        execution: {
          currentJobIds: ["job-e2e"],
          generationCount: 1,
          spentUsd: 0,
          retryCount: 0,
        },
        revision: 4,
        updatedAt: createdAt,
      },
    }],
  } as unknown as StudioState;
  const waitingSession = structuredClone(state.sessions[0]);
  waitingSession.id = "waiting-session";
  waitingSession.name = "Waiting connection";
  waitingSession.assets = [];
  waitingSession.agent.connection = { status: "waiting" };
  waitingSession.agent.controlMode = "agent";
  waitingSession.agent.runStatus = "idle";
  waitingSession.agent.plan = [];
  waitingSession.agent.decisions = [];
  waitingSession.agent.artifacts = [];
  waitingSession.agent.currentStepId = undefined;
  waitingSession.agent.execution.currentJobIds = [];
  state.sessions.push(waitingSession);
  return state;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    localStorage.setItem("fruit-truck.language", "en");
    localStorage.setItem("fruit-truck.dev-key", "test-key-for-e2e");
  }, [STORAGE_KEY, studioFixture()] as const);
  await page.goto("/");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").schemaVersion, STORAGE_KEY)).toBe(3);
});

test("keyboard shortcuts cover workspace navigation and keep modal close scoped", async ({ page }) => {
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  const threadRail = page.getByLabel("Generation threads");
  const initialThreads = await threadRail.locator(".thread-tab").count();

  await page.keyboard.press("Meta+/");
  await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
  await expect(page.getByText("New Session")).toBeVisible();
  await page.keyboard.press("Meta+W");
  await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toHaveCount(0);
  await expect(threadRail.locator(".thread-tab")).toHaveCount(initialThreads);

  await page.keyboard.press("Meta+T");
  await expect(threadRail.locator(".thread-tab")).toHaveCount(initialThreads + 1);
  await page.keyboard.press("Meta+D");
  await expect(threadRail.locator(".thread-tab")).toHaveCount(initialThreads + 2);
  await page.keyboard.press("Meta+W");
  await expect(threadRail.locator(".thread-tab")).toHaveCount(initialThreads + 1);
  await page.keyboard.press("Meta+Shift+T");
  await expect(threadRail.locator(".thread-tab")).toHaveCount(initialThreads + 2);
  const activeThreadBeforeCycle = await threadRail.locator(".thread-tab.active").evaluate((element) =>
    Array.from(element.parentElement?.children ?? []).indexOf(element),
  );
  await page.keyboard.press("Control+Tab");
  await expect.poll(() => threadRail.locator(".thread-tab.active").evaluate((element) =>
    Array.from(element.parentElement?.children ?? []).indexOf(element),
  )).not.toBe(activeThreadBeforeCycle);

  await page.keyboard.press("Meta+2");
  await expect(page.getByRole("button", { name: "Video", exact: true })).toHaveAttribute("data-pressed", "");
  await page.keyboard.press("Meta+1");
  await expect(page.getByRole("button", { name: "Image", exact: true })).toHaveAttribute("data-pressed", "");

  await page.keyboard.press("Meta+F");
  await expect(page.getByLabel("Search sessions…")).toBeFocused();
  await page.keyboard.press("Shift+Escape");
  await expect(page.locator(".prompt-field textarea")).toBeFocused();

  await page.keyboard.press("Meta+Alt+I");
  await expect(page.getByLabel("Agent and assets panel")).toHaveCount(0);
  await expect(page.locator(".workspace")).toHaveClass(/right-panel-closed/);
  await page.keyboard.press("Meta+Alt+2");
  await expect(page.getByLabel("Agent and assets panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Assets", exact: true })).toHaveAttribute("data-pressed", "");

  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const threadCountBeforeClosingSettings = await threadRail.locator(".thread-tab").count();
  await page.keyboard.press("Meta+W");
  await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
  await expect(threadRail.locator(".thread-tab")).toHaveCount(threadCountBeforeClosingSettings);
});

test("asset and text contexts preserve their expected keyboard behavior", async ({ page }) => {
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  const prompt = page.locator(".prompt-field textarea");
  await prompt.fill("Select only this prompt text");
  await prompt.press("Meta+A");
  await expect.poll(() => prompt.evaluate((element) => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
    length: (element as HTMLTextAreaElement).value.length,
  }))).toEqual({ start: 0, end: 28, length: 28 });

  const assetVisuals = page.locator(".asset-visual");
  await assetVisuals.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(assetVisuals.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".asset-preview-dialog")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".asset-preview-dialog")).toBeVisible();
  const previewDownload = page.waitForEvent("download");
  await page.keyboard.press("Meta+Shift+E");
  expect((await previewDownload).suggestedFilename()).toMatch(/\.(png|mp4)$/);
  await expect(page.locator(".asset-preview-dialog")).toBeVisible();
  await page.keyboard.press("Meta+W");
  await expect(page.locator(".asset-preview-dialog")).toHaveCount(0);

  await assetVisuals.first().focus();
  await page.keyboard.press("Meta+Backspace");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("full-window experience uses Agent/Assets without the removed dashboard", async ({ page }) => {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveJSProperty("clientWidth", 1920);
  await expect(page.locator(".app-shell")).toHaveJSProperty("clientHeight", 1080);
  await expect(page.getByRole("button", { name: /Run parallel/ })).toHaveCount(0);
  const topbarCenters = await page.locator(".topbar-actions").evaluate((element) => {
    const status = element.querySelector(".connection-pill")?.getBoundingClientRect();
    const settings = element.querySelector("button")?.getBoundingClientRect();
    return status && settings
      ? { status: status.y + status.height / 2, settings: settings.y + settings.height / 2 }
      : null;
  });
  expect(topbarCenters).not.toBeNull();
  expect(Math.abs(topbarCenters!.status - topbarCenters!.settings)).toBeLessThan(1);
  await expect(page.locator(".agent-workspace")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Plan" })).toHaveCount(0);
  await expect(page.getByText("Requirement Map")).toHaveCount(0);
  await expect(page.getByText("Activity", { exact: true })).toHaveCount(0);

  const widthBefore = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().width);
  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Agent" }).click();
  await expect(page.getByText("Waiting for your choice")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open review" })).toBeVisible();
  await expect(page.getByText("Image backend")).toBeVisible();
  await expect(page.getByText("OpenRouter", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Video 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Assets" }).click();
  const widthAfter = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().width);
  expect(widthAfter).toBe(widthBefore);
});

test("a published session stays connection-waiting without an app-authored plan", async ({ page }) => {
  await page.getByRole("button", { name: /^Waiting connection \d/ }).click();
  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Agent" }).click();
  await expect(page.getByText("Connection waiting")).toBeVisible();
  await expect(page.getByText("Waiting for an agent to connect")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => {
    const session = JSON.parse(localStorage.getItem(key) ?? "{}").sessions
      ?.find((item: { id: string }) => item.id === "waiting-session");
    return { plan: session?.agent?.plan?.length, decisions: session?.agent?.decisions?.length };
  }, STORAGE_KEY)).toEqual({ plan: 0, decisions: 0 });
});

test("blocking UI decisions stay passive until the user opens the review", async ({ page }) => {
  await expect(page.locator(".decision-dialog")).toHaveCount(0);
  await expect(page.locator(".decision-workspace")).toHaveCount(0);
  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Agent" }).click();
  await expect(page.getByText("Choose image model")).toBeVisible();
  await page.getByRole("button", { name: "Open review" }).click();
  await expect(page.getByRole("heading", { name: "Choose image model" })).toBeVisible();
  await expect(page.getByText("$0.04 / image")).toBeVisible();
  await page.getByRole("button", { name: /Test image model/ }).click();
  await page.getByRole("button", { name: "Confirm choice" }).click();
  await expect(page.locator(".decision-workspace")).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").sessions?.[0]?.agent?.decisions?.[0]?.status
  , STORAGE_KEY)).toBe("resolved");

  await page.reload();
  await expect(page.locator(".decision-workspace")).toHaveCount(0);
  await expect(page.locator(".composer")).toBeVisible();

  await expect.poll(() => page.evaluate((key) => {
    const session = JSON.parse(localStorage.getItem(key) ?? "{}").sessions?.[0];
    return {
      decisions: session?.agent?.decisions?.map((item: { status: string }) => item.status),
      runStatus: session?.agent?.runStatus,
      approval: session?.agent?.artifacts?.find((item: { assetId: string }) => item.assetId === "asset-final")?.approval,
      finalStep: session?.agent?.plan?.find((item: { id: string }) => item.id === "complete")?.status,
    };
  }, STORAGE_KEY)).toMatchObject({
    decisions: ["resolved", "pending", "pending"],
    runStatus: "waiting",
    approval: "unreviewed",
    finalStep: "pending",
  });
});

test("approved video opens dedicated Assembly and provenance stays folded in Assets", async ({ page }) => {
  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Assets" }).click();
  await page.getByRole("button", { name: /Make final video/ }).click();
  await expect(page.getByRole("heading", { name: "Make final video" })).toBeVisible();
  await expect(page.getByLabel("Clip preview").getByText("approved-shot.mp4")).toBeVisible();
  await expect(page.getByLabel("Clip preview").locator("video")).toBeVisible();
  await page.getByRole("button", { name: /Render final/ }).click();
  await expect(page.getByRole("heading", { name: "Make final video" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Tauri desktop");
  await page.getByRole("button", { name: "Close final video editor" }).click();

  await page.getByRole("button", { name: "fruit-truck-icon.png" }).click();
  const provenance = page.locator("details.asset-provenance");
  await expect(provenance).not.toHaveAttribute("open", "");
  await provenance.locator("summary").click();
  await expect(provenance).toHaveAttribute("open", "");
  await expect(provenance).toContainText("test/image");
  await expect(provenance).toContainText("Format is valid.");
});

test("Settings keeps Agent Skill import and history read-only for session activation", async ({ page }) => {
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}");
    for (const session of state.sessions ?? []) session.activeVideoJobs = [];
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __TAURI_INTERNALS__?: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "list_custom_skills") {
          return [{
            name: "Installed Skill",
            version: 2,
            path: "/tmp/fruit-truck-e2e/installed-skill/SKILL.md",
            versions: [2, 1],
          }];
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  });
  await page.getByRole("button", { name: "Settings" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "App settings" })).toBeVisible();
  await expect(page.getByText("Agent Skills", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import" })).toBeVisible();
  await expect(page.getByText("Installed Skill")).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View Skill" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore previous version" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deactivate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve & save" })).toHaveCount(0);
});

test("Human mode exposes independently runnable generation threads without batch controls", async ({ page }) => {
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    if (!session) throw new Error("Missing E2E session");
    session.agent.controlMode = "human";
    session.agent.runStatus = "paused";
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  await expect(page.getByLabel("Generation threads").locator(".thread-tab")).toHaveCount(1);
  await page.getByRole("button", { name: "New thread" }).click();
  await expect(page.getByLabel("Generation threads").locator(".thread-tab")).toHaveCount(2);
  await expect(page.getByText("Image 2", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    const active = session.threads.image.find((item) => item.id === session.activeThreadIds.image);
    return { name: active?.name, prompt: active?.draft.prompt };
  }, STORAGE_KEY)).toEqual({ name: "Image 2", prompt: "" });

  const second = page.locator(".thread-tab").filter({ hasText: "Image 2" });
  await second.hover();
  page.once("dialog", (dialog) => dialog.accept("Keyframe wide"));
  await page.getByRole("button", { name: "Rename Image 2" }).click();
  await expect(page.getByText("Keyframe wide", { exact: true })).toBeVisible();

  const threadRail = page.getByLabel("Generation threads");
  await expect(threadRail.locator(".thread-check")).toHaveCount(0);
  await expect(threadRail.getByRole("button", { name: /Run parallel/ })).toHaveCount(0);
  await threadRail.locator(".thread-tab").filter({ hasText: "Image 1" }).locator(".thread-tab-main").click();
  await expect(threadRail.locator(".thread-tab.active")).toContainText("Image 1");
});

test("asset-library image drags set the edit target through the pointer drop path", async ({ page }) => {
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    if (!session) throw new Error("Missing E2E session");
    const thread = session.threads.image.find((item) => item.id === session.activeThreadIds.image);
    if (!thread) throw new Error("Missing active image thread");
    thread.draft = {
      ...thread.draft,
      imageEditMode: true,
      imageEditTarget: "",
      references: [],
    };
    thread.attempts = [];
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  const assetTile = page.locator(".asset-tile").filter({ hasText: "fruit-truck-icon.png" });
  const editPanel = page.locator(".edit-media-panel");
  await editPanel.scrollIntoViewIfNeeded();
  const sourceBox = await assetTile.locator(".asset-visual img").boundingBox();
  const targetBox = await editPanel.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Missing asset drag coordinates");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(".edit-media-panel").getByText("fruit-truck-icon.png")).toBeVisible();
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    const draft = session?.threads.image.find((item) => item.id === session.activeThreadIds.image)?.draft;
    return {
      target: draft?.imageEditTarget,
      assetId: draft?.references[0]?.assetId,
    };
  }, STORAGE_KEY)).toEqual({ target: "#1", assetId: "asset-final" });
});

test("asset export downloads without navigating the workspace into the image", async ({ page }) => {
  const assetTile = page.locator(".asset-tile").filter({ hasText: "fruit-truck-icon.png" });
  const downloadStarted = page.waitForEvent("download");
  await assetTile.getByRole("button", { name: "Export" }).click();
  await expect(page.locator(".base-toast")).toContainText("fruit-truck-icon.png downloaded");
  const download = await downloadStarted;

  expect(download.suggestedFilename()).toBe("fruit-truck-icon.png");
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("project overview routes failures and archived threads can be restored with history intact", async ({ page }) => {
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    const thread = session.threads.image[0];
    const now = new Date().toISOString();
    const failedAttempt = {
      id: "attempt-e2e-failed",
      requestKey: "batch-e2e-overview",
      status: "failed" as const,
      backend: "openrouter" as const,
      draftRevision: thread.revision,
      requestedBy: "human" as const,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      modelId: "test/image",
      estimatedCostUsd: 0.04,
      actualCostUsd: 0.02,
      inputAssetIds: [],
      assetIds: [],
      error: "KF-02 failed independently",
    };
    session.threads.image.push({
      ...structuredClone(thread),
      id: "failed-e2e-thread",
      name: "KF-02",
      attempts: [failedAttempt],
      enhancementAttempts: [],
    });
    session.threads.image.push({
      ...structuredClone(thread),
      id: "running-e2e-thread",
      name: "KF-03",
      attempts: [{ ...failedAttempt, id: "attempt-e2e-running", status: "in_progress" as const, error: undefined, completedAt: undefined, actualCostUsd: undefined }],
      enhancementAttempts: [],
    });
    session.threads.image.push({
      ...structuredClone(thread),
      id: "completed-e2e-thread",
      name: "KF-04",
      attempts: [{ ...failedAttempt, id: "attempt-e2e-completed", status: "completed" as const, error: undefined, actualCostUsd: 0.05 }],
      enhancementAttempts: [],
    });
    session.threads.image.push({
      ...structuredClone(thread),
      id: "archived-e2e-thread",
      name: "Archived alternate",
      attempts: [],
      enhancementAttempts: [],
      archivedAt: now,
    });
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Agent" }).click();
  await expect(page.getByText("Project overview")).toBeVisible();
  await expect(page.locator(".project-overview dl")).toContainText("Running2");
  await expect(page.locator(".project-overview dl")).toContainText("Failed1");
  await expect(page.locator(".project-overview dl")).toContainText("Uncertain0");
  await expect(page.locator(".project-overview dl")).toContainText("Completed2");
  await expect(page.locator(".batch-summary")).toContainText("1/3 completed · 1 active · 1 need attention");
  await expect(page.locator(".batch-summary")).toContainText("$0.07 actual · $0.12 estimated");
  await expect(page.locator(".generation-error")).toHaveCount(0);
  await expect(page.getByText("Archived (1)")).toBeVisible();
  const failedLink = page.locator(".project-overview").getByRole("button", { name: "KF-02" });
  await expect(failedLink).toBeVisible();
  await failedLink.click();
  await page.getByRole("button", { name: /Attempt history/ }).click();
  const attemptHistory = page.locator(".attempt-history-popover");
  await expect(attemptHistory.getByText("KF-02 failed independently")).toBeVisible();
  await expect(attemptHistory.getByText("failed", { exact: true })).toBeVisible();

  await page.getByText("Archived (1)").click();
  await page.getByRole("button", { name: "Restore Archived alternate" }).click();
  await expect(page.getByText("Archived alternate", { exact: true })).toBeVisible();
});

test("mask-only enhancement analyzes the original image and a semantic mask guide", async ({ page }) => {
  const captured: { body?: Record<string, unknown> } = {};
  await page.route("https://openrouter.ai/api/v1/chat/completions", async (route) => {
    captured.body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content: "Recolor the existing semantically selected part of #1 black while preserving its natural structure, texture, lighting, and surrounding scene." } }],
      }),
    });
  });
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    session.mode = "image";
    const thread = session.threads.image.find((item) => item.id === session.activeThreadIds.image)!;
    thread.draft = {
      ...thread.draft,
      prompt: "",
      references: [{ assetId: "asset-final", slot: 1, role: "reference" }],
      enhancePrompt: true,
      enhancedPrompt: "",
      enhancedPromptDirty: false,
      imageEditMode: true,
      imageEditTarget: "#1",
      maskInstructions: "Turn the selected part black.",
      maskStrokes: [{
        operation: "paint",
        size: 0.09,
        points: [{ x: 0.35, y: 0.35 }, { x: 0.55, y: 0.55 }],
      }],
    };
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  await expect(page.locator(".app-shell")).toHaveJSProperty("clientWidth", 1920);
  await expect(page.locator(".app-shell")).toHaveJSProperty("clientHeight", 1080);
  await expect(page.locator(".enhance-row")).not.toContainText("images / video frames analyzed");
  await page.locator(".enhance-row").getByRole("button", { name: "Preview" }).click();
  await expect.poll(() => captured.body).toBeDefined();

  const messages = captured.body!.messages as Array<{ role: string; content: unknown }>;
  const user = messages.find((message) => message.role === "user");
  const parts = user?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  expect(parts[0]?.type).toBe("text");
  expect(parts[0]?.text).toContain("Mask instructions:\nTurn the selected part black.");
  expect(parts.filter((part) => part.type === "image_url")).toHaveLength(2);
  expect(parts[1]?.image_url?.url).toContain("fruit-truck-icon.png");
  expect(parts[2]?.image_url?.url).toMatch(/^data:image\/(?:webp|png);base64,/);
  await expect(page.getByText("Enhanced prompt · inspect or edit")).toBeVisible();
  await expect(page.locator(".enhance-row")).toContainText("images / video frames analyzed");
});

test("remote video references fall back to text enhancement when local frames are unavailable", async ({ page }) => {
  const captured: { body?: Record<string, unknown> } = {};
  await page.route("https://openrouter.ai/api/v1/chat/completions", async (route) => {
    captured.body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { content: "Preserve the timing and identity of #1 while applying a restrained monochrome grade." } }] }),
    });
  });
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    session.mode = "video";
    const thread = session.threads.video.find((item) => item.id === session.activeThreadIds.video)!;
    thread.videoWorkflow = "edit";
    thread.draft = {
      ...thread.draft,
      prompt: "Preserve #1 and apply a restrained monochrome grade.",
      references: [{ assetId: "asset-video", slot: 1, role: "video_reference" }],
      enhancePrompt: true,
      enhancedPrompt: "",
      enhancedPromptDirty: false,
      enhancedVisualCount: 0,
    };
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  await page.locator(".enhance-row").getByRole("button", { name: "Preview" }).click();
  await expect.poll(() => captured.body).toBeDefined();
  const messages = captured.body!.messages as Array<{ role: string; content: unknown }>;
  const user = messages.find((message) => message.role === "user");
  const parts = user?.content as Array<{ type: string; text?: string }>;
  expect(parts).toHaveLength(1);
  expect(parts[0]?.text).toContain("#1: approved-shot.mp4");
  await expect(page.getByText("Enhanced prompt · inspect or edit")).toBeVisible();
  await expect(page.locator(".enhance-row")).not.toContainText("images / video frames analyzed");
});

test("completed generation opens a queued result modal without moving the editor and hands assets to the library", async ({ page }) => {
  await page.route("https://openrouter.ai/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/images/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [{ id: "test/image", name: "Test image model", supported_parameters: { n: { type: "range", min: 1, max: 2 } } }] }),
      });
      return;
    }
    if (path === "/api/v1/images/models/test/image/endpoints") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ endpoints: [] }) });
      return;
    }
    if (path === "/api/v1/videos/models" || path === "/api/v1/models") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) });
      return;
    }
    if (path === "/api/v1/images" && request.method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            { url: "http://127.0.0.1:4179/fruit-truck-icon.png" },
            { url: "http://127.0.0.1:4179/fruit-truck-icon.png" },
          ],
          usage: { cost: 0.08 },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "Not mocked" });
  });

  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    session.mode = "image";
    session.generationDefaults.modelIds.image = "test/image";
    const thread = session.threads.image.find((item) => item.id === session.activeThreadIds.image)!;
    thread.modelOverrideId = "test/image";
    thread.draft = { ...thread.draft, prompt: "Create two restrained fruit truck keyframes.", enhancePrompt: false };
    thread.optionOverrides = { n: 2 };
    thread.attempts = [];
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  await expect(page.getByRole("heading", { name: "Test image model" })).toBeVisible();
  await expect(page.locator(".generation-result-dialog")).toHaveCount(0);
  await expect(page.locator(".result-canvas")).toHaveCount(0);
  await page.locator(".composer-form").evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const formBefore = await page.locator(".composer-form").boundingBox();
  if (!formBefore) throw new Error("Missing composer form before generation");

  await page.locator(".prompt-field textarea").focus();
  await page.keyboard.press("Meta+Enter");
  const resultDialog = page.locator(".generation-result-dialog");
  await expect(resultDialog).toBeVisible();
  await expect(resultDialog).toContainText("Generation complete");
  await expect(resultDialog.getByLabel("Generation candidates").getByRole("button")).toHaveCount(2);
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    const attempt = session.threads.image.find((item) => item.id === session.activeThreadIds.image)!.attempts.at(-1);
    return { status: attempt?.status, resultCount: attempt?.assetIds.length, assetCount: session.assets.length };
  }, STORAGE_KEY)).toEqual({ status: "completed", resultCount: 2, assetCount: 4 });

  await expect(resultDialog.getByRole("button", { name: /Done/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(resultDialog).toHaveCount(0);
  await expect(page.getByLabel("Agent and assets panel").getByRole("button", { name: "Assets" })).toHaveAttribute("data-pressed", "");
  await expect(page.locator(".asset-tile.just-added")).toHaveCount(2);
  const formAfter = await page.locator(".composer-form").boundingBox();
  expect(formAfter?.y).toBe(formBefore.y);

  await page.reload();
  await expect(page.locator(".generation-result-dialog")).toHaveCount(0);
});

test("result actions return to the originating thread and pause the remaining completion queue", async ({ page }) => {
  let releaseImages!: () => void;
  const imageGate = new Promise<void>((resolve) => { releaseImages = resolve; });
  await mockImageGeneration(page, imageGate);
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    session.mode = "image";
    session.generationDefaults.modelIds.image = "test/image";
    const source = session.threads.image[0];
    source.name = "Origin one";
    source.modelOverrideId = "test/image";
    source.draft = { ...source.draft, prompt: "Create origin one.", enhancePrompt: false };
    source.optionOverrides = {};
    source.attempts = [];
    const second = structuredClone(source);
    second.id = "e2e-origin-two";
    second.name = "Origin two";
    second.draft.prompt = "Create origin two.";
    second.attempts = [];
    session.threads.image = [source, second];
    session.activeThreadIds.image = source.id;
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  await page.getByRole("button", { name: "Generate Image" }).click();
  await page.getByRole("button", { name: "Origin two Ready" }).click();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    return session.threads.image.flatMap((thread) => thread.attempts).filter((attempt) =>
      ["enhancing", "submitting", "in_progress"].includes(attempt.status)
    ).length;
  }, STORAGE_KEY)).toBe(2);
  releaseImages();

  const resultDialog = page.locator(".generation-result-dialog");
  await expect(resultDialog).toBeVisible();
  const firstThreadName = (await resultDialog.getByRole("heading").textContent())?.trim();
  expect(firstThreadName).toMatch(/^Origin (one|two)$/);
  await resultDialog.getByRole("button", { name: "Edit this image" }).click();
  await expect(resultDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review 1 pending result(s)" })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    const active = session.threads.image.find((item) => item.id === session.activeThreadIds.image)!;
    return { name: active.name, editMode: active.draft.imageEditMode, references: active.draft.references.length };
  }, STORAGE_KEY)).toEqual({ name: firstThreadName, editMode: true, references: 1 });

  await page.getByRole("button", { name: "Review 1 pending result(s)" }).click();
  await expect(resultDialog).toBeVisible();
  await expect(resultDialog.getByRole("heading")).not.toHaveText(firstThreadName!);
  await page.keyboard.press("Escape");
});

test("generation results wait until an existing dialog closes", async ({ page }) => {
  let releaseImage!: () => void;
  const imageGate = new Promise<void>((resolve) => { releaseImage = resolve; });
  await mockImageGeneration(page, imageGate);
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    session.agent.controlMode = "human";
    session.mode = "image";
    session.generationDefaults.modelIds.image = "test/image";
    const thread = session.threads.image.find((item) => item.id === session.activeThreadIds.image)!;
    thread.modelOverrideId = "test/image";
    thread.draft = { ...thread.draft, prompt: "Create a deferred result.", enhancePrompt: false };
    thread.attempts = [];
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();

  await page.getByRole("button", { name: "Generate Image" }).click();
  await page.getByRole("button", { name: "Request" }).click();
  await expect(page.getByRole("heading", { name: "Request preview" })).toBeVisible();
  releaseImage();
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "{}") as StudioState;
    const session = state.sessions.find((item) => item.id === state.activeSessionId)!;
    return session.threads.image.find((item) => item.id === session.activeThreadIds.image)?.attempts.at(-1)?.status;
  }, STORAGE_KEY)).toBe("completed");
  await expect(page.locator(".generation-result-dialog")).toHaveCount(0);

  await page.getByLabel("Close request preview").click();
  await expect(page.locator(".generation-result-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});
