import { expect, test } from "@playwright/test";
import type { StudioState } from "../src/studio";

const STORAGE_KEY = "oppa-gen.studio.v1";

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
  const state: StudioState = {
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
        name: "oppa-gen-icon.png",
        kind: "image",
        mimeType: "image/png",
        origin: "generated",
        createdAt,
        externalUrl: "http://127.0.0.1:4179/oppa-gen-icon.png",
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
          status: "pending",
          blocking: true,
          relatedAssetIds: [],
          options: [
            { id: "test/image", label: "Test image model", recommended: true, description: "Best fit." },
            { id: "test/other", label: "Other model" },
          ],
          createdAt,
        }, {
          id: "decision-upload",
          semanticKey: "identity_refs",
          title: "Attach identity reference",
          prompt: "Choose a reference file.",
          kind: "upload",
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
          { name: "oppa-gen-agent", version: "1.0.0", source: "core" },
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
  };
  const waitingSession = structuredClone(state.sessions[0]);
  waitingSession.id = "waiting-session";
  waitingSession.name = "Waiting connection";
  waitingSession.assets = [];
  waitingSession.activeVideoJobs = [];
  waitingSession.lastResultAssetIds = { image: [], video: [] };
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
    localStorage.setItem("oppa-gen.language", "en");
    localStorage.setItem("oppa-gen.dev-key", "test-key-for-e2e");
  }, [STORAGE_KEY, studioFixture()] as const);
  await page.goto("/");
});

test("full-window experience uses Agent/Assets without the removed dashboard", async ({ page }) => {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveJSProperty("clientWidth", 1920);
  await expect(page.locator(".app-shell")).toHaveJSProperty("clientHeight", 1080);
  await expect(page.locator(".agent-workspace")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Plan" })).toHaveCount(0);
  await expect(page.getByText("Requirement Map")).toHaveCount(0);
  await expect(page.getByText("Activity", { exact: true })).toHaveCount(0);

  const widthBefore = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().width);
  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Agent" }).click();
  await expect(page.getByText("Waiting for your choice")).toBeVisible();
  await expect(page.getByText("Reply in your agent chat to continue.")).toBeVisible();
  await expect(page.getByText("Image backend")).toBeVisible();
  await expect(page.getByText("OpenRouter", { exact: true })).toBeVisible();
  await expect(page.getByText("Generating video")).toBeVisible();
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

test("blocking decisions stay read-only and never steal focus from the active workspace", async ({ page }) => {
  await expect(page.locator(".decision-dialog")).toHaveCount(0);
  await page.getByLabel("Agent and assets panel").getByRole("button", { name: "Agent" }).click();
  await expect(page.getByText("Choose image model")).toBeVisible();
  await expect(page.getByText("Reply in your agent chat to continue.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Open choice/ })).toHaveCount(0);
  await expect(page.locator(".decision-dialog")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".decision-dialog")).toHaveCount(0);
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
    decisions: ["pending", "pending", "pending"],
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
  await expect(page.getByRole("alert")).toContainText("Tauri desktop runtime");
  await page.getByRole("button", { name: "Close final video editor" }).click();

  await page.getByRole("button", { name: "oppa-gen-icon.png" }).click();
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
            path: "/tmp/oppa-gen-e2e/installed-skill/SKILL.md",
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
