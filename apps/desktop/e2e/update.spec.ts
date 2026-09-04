import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

type UpdateE2EOptions = {
  workspace: unknown;
  pendingTransaction?: boolean;
  pendingPhase?: string;
  runningVersion?: string;
  updaterAvailable?: boolean;
  holdUpdateCheck?: boolean;
  holdPlanner?: boolean;
  holdSnapshot?: boolean;
  snapshotFailure?: string;
  assetVerificationValid?: boolean;
  completionFailure?: string;
  completionFailureCount?: number;
  holdCompletion?: boolean;
  persistAcrossReload?: boolean;
  holdVideoPoll?: boolean;
  completeVideoPoll?: boolean;
  updaterFailureAfterFinished?: string;
  installingPhaseFailure?: string;
  retentionCleanupFailureCount?: number;
  managedScanFailure?: string;
  managedScanOmitName?: string;
};

const CURRENT_VERSION = "0.6.7";
const UPDATE_VERSION = "0.7.0";
const TRANSACTION_ID = "phase-3-update-e2e";

const V8_WORKSPACE = JSON.parse(readFileSync(
  new URL("../fixtures/studio/phase-3/v8-director-missing-asset.json", import.meta.url),
  "utf8",
)) as unknown;

const V6_WORKSPACE = JSON.parse(readFileSync(
  new URL("../fixtures/studio/phase-3/v6-production-workspace.json", import.meta.url),
  "utf8",
)) as unknown;

function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Install a browser-side implementation of the Tauri v2 IPC boundary. The
 * production Tauri JavaScript packages still create Update, Resource and
 * Channel instances. Only their native command transport is substituted.
 */
async function installTauriMock(page: Page, options: UpdateE2EOptions) {
  await page.addInitScript((config) => {
    const CURRENT_VERSION = "0.6.7";
    const UPDATE_VERSION = "0.7.0";
    const TRANSACTION_ID = "phase-3-update-e2e";
    const UPDATE_BODY = "Lossless workspace migration and update recovery checks.";
    type MockCall = { cmd: string; args: Record<string, unknown> };
    type Callback = (payload: unknown) => void;
    type MockControl = {
      calls: MockCall[];
      assetVerificationValid: boolean;
      releaseSnapshot: () => void;
      releaseUpdateCheck: () => void;
      releaseVideoPoll: () => void;
      releaseCompletion: () => void;
      workspacePayload: () => unknown;
    };
    type MockTransaction = {
      schemaVersion: number;
      id: string;
      fromAppVersion: string;
      toAppVersion: string;
      fromStudioSchema: number;
      targetStudioSchema: number;
      phase: string;
      createdAt: string;
      updatedAt: string;
      snapshotPath: string;
      snapshotChecksum: string;
      assetManifestPath: string;
      assetManifestChecksum: string;
      failure?: { code: string; message: string };
    };
    type TauriInternals = {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      transformCallback: (callback?: Callback, once?: boolean) => number;
      unregisterCallback: (id: number) => void;
      runCallback: (id: number, payload: unknown) => void;
      callbacks: Map<number, Callback>;
      convertFileSrc: (path: string, protocol?: string) => string;
      metadata: {
        currentWindow: { label: string };
        currentWebview: { windowLabel: string; label: string };
      };
    };
    type MockWindow = Window & typeof globalThis & {
      __TAURI_INTERNALS__: TauriInternals;
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => void };
      __FRUIT_TRUCK_UPDATE_E2E__: MockControl;
    };

    const mockWindow = window as MockWindow;
    localStorage.setItem("fruit-truck.onboarding.complete.v1", "true");
    localStorage.setItem("fruit-truck.language", "en");
    localStorage.setItem("fruit-truck.session-sidebar.open", "true");
    localStorage.removeItem("fruit-truck.update.last-state");

    const calls: MockCall[] = [];
    const callbacks = new Map<number, Callback>();
    let nextCallbackId = 1;
    let nextResourceId = 100;
    const snapshotPayload = structuredClone(config.workspace);
    const persistedMock = config.persistAcrossReload
      ? sessionStorage.getItem("fruit-truck.update-e2e.persisted")
      : null;
    const restoredMock = persistedMock ? JSON.parse(persistedMock) as {
      workspacePayload: unknown;
      workspaceChecksum: string;
      pendingTransaction: MockTransaction | null;
      completionFailuresRemaining: number;
    } : null;
    let workspacePayload = structuredClone(restoredMock?.workspacePayload ?? config.workspace);
    let workspaceChecksum = restoredMock?.workspaceChecksum ?? "shared-workspace-checksum";
    let pendingTransaction = restoredMock?.pendingTransaction
      ?? (config.pendingPhase ? transaction(config.pendingPhase) : config.pendingTransaction ? transaction("awaiting_restart") : null);
    let completionFailuresRemaining = restoredMock?.completionFailuresRemaining
      ?? Math.max(0, config.completionFailureCount ?? 0);
    let retentionCleanupFailuresRemaining = Math.max(0, config.retentionCleanupFailureCount ?? 0);
    let releaseHeldSnapshot: () => void = () => undefined;
    const heldSnapshot = new Promise<void>((resolve) => { releaseHeldSnapshot = resolve; });
    let releaseHeldUpdateCheck: () => void = () => undefined;
    const heldUpdateCheck = new Promise<void>((resolve) => { releaseHeldUpdateCheck = resolve; });
    let releaseHeldVideoPoll: () => void = () => undefined;
    const heldVideoPoll = new Promise<void>((resolve) => { releaseHeldVideoPoll = resolve; });
    let releaseHeldCompletion: () => void = () => undefined;
    const heldCompletion = new Promise<void>((resolve) => { releaseHeldCompletion = resolve; });

    function persistMock() {
      if (!config.persistAcrossReload) return;
      sessionStorage.setItem("fruit-truck.update-e2e.persisted", JSON.stringify({
        workspacePayload,
        workspaceChecksum,
        pendingTransaction,
        completionFailuresRemaining,
      }));
    }

    function transaction(phase: string): MockTransaction {
      return {
        schemaVersion: 1,
        id: TRANSACTION_ID,
        fromAppVersion: CURRENT_VERSION,
        toAppVersion: UPDATE_VERSION,
        fromStudioSchema: (snapshotPayload as { schemaVersion?: number }).schemaVersion ?? 8,
        targetStudioSchema: 8,
        phase,
        createdAt: "2026-09-04T03:00:00.000Z",
        updatedAt: "2026-09-04T03:00:00.000Z",
        snapshotPath: `update-snapshots/${TRANSACTION_ID}/workspace-envelope.json`,
        snapshotChecksum: "a".repeat(64),
        assetManifestPath: `update-snapshots/${TRANSACTION_ID}/asset-manifest.json`,
        assetManifestChecksum: "b".repeat(64),
      };
    }

    function loaded(payload: unknown, checksum = "shared-workspace-checksum") {
      return {
        payload: structuredClone(payload),
        source: "/mock/.fruit-truck/workspace/current.json",
        checksum,
        recovered: false,
      };
    }

    function openRouterResponse(path: string) {
      if (path === "/key") {
        return { data: { label: "Fruit Truck Update E2E", limit: 10, limit_remaining: 10 } };
      }
      if (path === "/images/models") {
        return {
          data: [{
            id: "google/gemini-2.5-flash-image",
            name: "Update E2E image model",
            supported_parameters: {},
          }],
        };
      }
      if (path === "/images/models/google/gemini-2.5-flash-image/endpoints") {
        return { endpoints: [] };
      }
      if (path === "/videos/models") {
        return {
          data: [{
            id: "google/veo-3.1",
            name: "Update E2E video model",
            supported_durations: [8],
            supported_resolutions: ["1080p"],
            supported_aspect_ratios: ["16:9"],
            endpoints: [],
          }],
        };
      }
      if (path === "/models?output_modalities=video") {
        return { data: [{ id: "google/veo-3.1", architecture: { input_modalities: ["text"], output_modalities: ["video"] } }] };
      }
      if (path === "/models") {
        return {
          data: [
            { id: "openai/gpt-5.6-sol", supported_parameters: ["reasoning", "structured_outputs"] },
            { id: "anthropic/claude-opus-5", supported_parameters: ["reasoning", "structured_outputs"] },
            { id: "google/gemini-3.8-flash", supported_parameters: ["reasoning", "structured_outputs"] },
          ],
        };
      }
      if (path === "/chat/completions") {
        return { choices: [{ message: { content: "{}" } }] };
      }
      if (path.startsWith("/videos/")) {
        return config.completeVideoPoll
          ? { id: path.slice("/videos/".length), status: "completed", progress: 100 }
          : { id: path.slice("/videos/".length), status: "in_progress", progress: 40 };
      }
      throw new Error(`Unexpected OpenRouter path in update E2E: ${path}`);
    }

    const control: MockControl = {
      calls,
      assetVerificationValid: config.assetVerificationValid ?? true,
      releaseSnapshot: () => releaseHeldSnapshot(),
      releaseUpdateCheck: () => releaseHeldUpdateCheck(),
      releaseVideoPoll: () => releaseHeldVideoPoll(),
      releaseCompletion: () => releaseHeldCompletion(),
      workspacePayload: () => structuredClone(workspacePayload),
    };
    mockWindow.__FRUIT_TRUCK_UPDATE_E2E__ = control;

    const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const summarizedArgs: Record<string, unknown> = {};
      for (const key of ["fromVersion", "toVersion", "transactionId", "phase", "path"]) {
        if (key in args) summarizedArgs[key] = args[key];
      }
      if (cmd === "complete_update_transaction") {
        const shell = document.querySelector<HTMLElement>(".app-shell");
        summarizedArgs.workspaceBootState = shell?.dataset.workspaceBootState;
        summarizedArgs.updateLocked = shell?.dataset.updateLocked;
        summarizedArgs.shellInert = shell?.hasAttribute("inert") ?? false;
      }
      calls.push({ cmd, args: summarizedArgs });

      if (cmd === "credential_status") {
        return { configured: true, maskedKey: "sk-or-v1…e2e", path: "/mock/credentials.json" };
      }
      if (cmd === "openrouter_request") {
        const path = String(args.path ?? "");
        if (path === "/chat/completions" && config.holdPlanner) {
          await new Promise<void>(() => undefined);
        }
        if (path.startsWith("/videos/") && config.holdVideoPoll) await heldVideoPoll;
        return openRouterResponse(path);
      }
      if (cmd === "load_pending_update_transaction") return pendingTransaction;
      if (cmd === "load_workspace_state") return loaded(workspacePayload, workspaceChecksum);
      if (cmd === "save_workspace_state") {
        workspacePayload = structuredClone(args.payload);
        workspaceChecksum = "saved-workspace-checksum";
        persistMock();
        return { saved: true };
      }
      if (cmd === "save_verified_update_workspace") {
        workspacePayload = structuredClone(args.payload);
        workspaceChecksum = "verified-workspace-checksum";
        persistMock();
        return { saved: true };
      }
      if (cmd === "scan_managed_assets") {
        if (config.managedScanFailure) throw new Error(config.managedScanFailure);
        if (pendingTransaction?.phase === "verifying") {
          const sessions = (workspacePayload as {
            sessions?: Array<{
              assets?: Array<{
                name?: string;
                kind?: string;
                mimeType?: string;
                localPath?: string;
                byteSize?: number;
              }>;
            }>;
          }).sessions ?? [];
          return sessions.flatMap((session) => (session.assets ?? []).flatMap((asset) =>
            typeof asset.localPath === "string" ? [{
              name: asset.name ?? "managed-asset",
              kind: asset.kind ?? "image",
              mimeType: asset.mimeType ?? "application/octet-stream",
              localPath: asset.localPath,
              byteSize: asset.byteSize ?? 0,
            }] : [])).filter((asset) => asset.name !== config.managedScanOmitName);
        }
        return [];
      }
      if (cmd === "create_pre_update_snapshot") {
        if (config.holdSnapshot) await heldSnapshot;
        if (config.snapshotFailure) throw new Error(config.snapshotFailure);
        pendingTransaction = transaction("snapshot_ready");
        return pendingTransaction;
      }
      if (cmd === "abort_update_transaction") {
        pendingTransaction = null;
        persistMock();
        return transaction("recovery_required");
      }
      if (cmd === "abandon_update_transaction_after_source_relaunch") {
        const abandoned = { ...(pendingTransaction ?? transaction("recovery_required")), phase: "recovery_required" };
        pendingTransaction = null;
        persistMock();
        return abandoned;
      }
      if (cmd === "cancel_update_snapshot_preparation") return true;
      if (cmd === "set_update_transaction_phase") {
        if (args.phase === "installing" && config.installingPhaseFailure) {
          throw new Error(config.installingPhaseFailure);
        }
        pendingTransaction = { ...(pendingTransaction ?? transaction("snapshot_ready")), phase: String(args.phase) };
        persistMock();
        return pendingTransaction;
      }
      if (cmd === "load_pre_update_snapshot") return loaded(snapshotPayload);
      if (cmd === "verify_update_assets") {
        pendingTransaction = { ...(pendingTransaction ?? transaction("awaiting_restart")), phase: "verifying", failure: undefined };
        persistMock();
        return control.assetVerificationValid
          ? {
              schemaVersion: 1,
              transactionId: TRANSACTION_ID,
              valid: true,
              totalEntries: 2,
              verifiedEntries: 2,
              missingEntries: 0,
              changedEntries: 0,
              issues: [],
            }
          : {
              schemaVersion: 1,
              transactionId: TRANSACTION_ID,
              valid: false,
              totalEntries: 2,
              verifiedEntries: 1,
              missingEntries: 1,
              changedEntries: 0,
              issues: [{
                assetId: "phase3-generated-video",
                relativePath: "generated/active-video.mp4",
                code: "missing",
                message: "Managed update asset is missing after restart.",
              }],
            };
      }
      if (cmd === "fail_update_transaction") {
        pendingTransaction = {
          ...(pendingTransaction ?? transaction("awaiting_restart")),
          phase: "recovery_required",
          failure: { code: String(args.code), message: String(args.message) },
        };
        persistMock();
        return pendingTransaction;
      }
      if (cmd === "complete_update_transaction") {
        if (config.holdCompletion) await heldCompletion;
        const shouldFail = Boolean(config.completionFailure)
          && (config.completionFailureCount == null || completionFailuresRemaining > 0);
        if (shouldFail) {
          completionFailuresRemaining = Math.max(0, completionFailuresRemaining - 1);
          persistMock();
          throw new Error(config.completionFailure);
        }
        pendingTransaction = null;
        persistMock();
        return null;
      }
      if (cmd === "cleanup_completed_update_snapshots") {
        if (retentionCleanupFailuresRemaining > 0) {
          retentionCleanupFailuresRemaining -= 1;
          throw new Error("Completed update retention cleanup is temporarily unavailable.");
        }
        return 0;
      }
      if (cmd === "restore_pre_update_snapshot") {
        workspacePayload = structuredClone(snapshotPayload);
        return { restored: true };
      }
      if (cmd === "export_pre_update_snapshot") return "/mock/exports/pre-update-workspace.json";
      if (cmd === "update_asset_folder") return "/mock/.fruit-truck/assets";
      if (cmd === "quit_app") return null;
      if (cmd === "plugin:app|version") return config.runningVersion ?? CURRENT_VERSION;
      if (cmd === "plugin:updater|check") {
        if (config.holdUpdateCheck) await heldUpdateCheck;
        if (config.updaterAvailable === false) return null;
        return {
          rid: 900,
          currentVersion: CURRENT_VERSION,
          version: UPDATE_VERSION,
          body: UPDATE_BODY,
          date: "2026-09-04T03:00:00.000Z",
          rawJson: {},
        };
      }
      if (cmd === "plugin:updater|download_and_install") {
        const channel = args.onEvent as { onmessage?: (event: unknown) => void } | undefined;
        channel?.onmessage?.({ event: "Started", data: { contentLength: 10 } });
        channel?.onmessage?.({ event: "Progress", data: { chunkLength: 10 } });
        channel?.onmessage?.({ event: "Finished" });
        if (config.updaterFailureAfterFinished) throw new Error(config.updaterFailureAfterFinished);
        return null;
      }
      if (cmd === "plugin:menu|new") {
        const rid = nextResourceId++;
        const menuOptions = args.options as { id?: string } | undefined;
        return [rid, menuOptions?.id ?? `update-e2e-menu-${rid}`];
      }
      if (cmd === "plugin:event|listen") return nextResourceId++;
      if (cmd === "plugin:menu|set_as_app_menu") return null;
      if (cmd.startsWith("plugin:")) return null;
      throw new Error(`Unexpected Tauri command in update E2E: ${cmd}`);
    };

    mockWindow.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback(callback, once = false) {
        const id = nextCallbackId++;
        if (callback) {
          callbacks.set(id, once
            ? (payload) => {
                callbacks.delete(id);
                callback(payload);
              }
            : callback);
        }
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      runCallback(id, payload) { callbacks.get(id)?.(payload); },
      callbacks,
      convertFileSrc: () => "http://127.0.0.1:4179/fruit-truck-icon.png",
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
    };
    mockWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => { callbacks.delete(id); },
    };
  }, options);
}

async function gotoUpdateReady(page: Page, options: UpdateE2EOptions) {
  await installTauriMock(page, options);
  await page.goto("/");
  expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  const updateDialog = page.getByRole("dialog", { name: "A sharper build is ready." });
  await expect(updateDialog).toBeVisible({ timeout: 15_000 });
  await expect(updateDialog).toContainText(`v${CURRENT_VERSION}`);
  await expect(updateDialog).toContainText(`v${UPDATE_VERSION}`);
  return updateDialog;
}

async function invokedCommands(page: Page): Promise<string[]> {
  return page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { calls: Array<{ cmd: string }> };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.calls.map((call) => call.cmd));
}

async function invokedCallArgs(page: Page, command: string): Promise<Record<string, unknown> | undefined> {
  return page.evaluate((expectedCommand) => {
    const calls = (
      window as Window & typeof globalThis & {
        __FRUIT_TRUCK_UPDATE_E2E__: { calls: Array<{ cmd: string; args: Record<string, unknown> }> };
      }
    ).__FRUIT_TRUCK_UPDATE_E2E__.calls;
    return structuredClone([...calls].reverse().find((call) => call.cmd === expectedCommand)?.args);
  }, command);
}

async function invokedPathCount(page: Page, path: string): Promise<number> {
  return page.evaluate((expectedPath) => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { calls: Array<{ cmd: string; args: { path?: unknown } }> };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.calls.filter((call) => (
    call.cmd === "openrouter_request" && call.args.path === expectedPath
  )).length, path);
}

async function persistedAttemptStatus(page: Page, attemptId: string): Promise<string | undefined> {
  return page.evaluate((id) => {
    const payload = (
      window as Window & typeof globalThis & {
        __FRUIT_TRUCK_UPDATE_E2E__: { workspacePayload: () => unknown };
      }
    ).__FRUIT_TRUCK_UPDATE_E2E__.workspacePayload() as {
      sessions?: Array<{ threads?: { video?: Array<{ attempts?: Array<{ id?: string; status?: string }> }> } }>;
    };
    return payload.sessions
      ?.flatMap((session) => session.threads?.video ?? [])
      .flatMap((thread) => thread.attempts ?? [])
      .find((attempt) => attempt.id === id)?.status;
  }, attemptId);
}

async function persistedAttemptNextPollAt(page: Page, attemptId: string): Promise<string | undefined> {
  return page.evaluate((id) => {
    const payload = (
      window as Window & typeof globalThis & {
        __FRUIT_TRUCK_UPDATE_E2E__: { workspacePayload: () => unknown };
      }
    ).__FRUIT_TRUCK_UPDATE_E2E__.workspacePayload() as {
      sessions?: Array<{ threads?: { video?: Array<{ attempts?: Array<{ id?: string; nextPollAt?: string }> }> } }>;
    };
    return payload.sessions
      ?.flatMap((session) => session.threads?.video ?? [])
      .flatMap((thread) => thread.attempts ?? [])
      .find((attempt) => attempt.id === id)?.nextPollAt;
  }, attemptId);
}

async function persistedSessionAssets(page: Page, sessionId: string): Promise<unknown[]> {
  return page.evaluate((id) => {
    const payload = (
      window as Window & typeof globalThis & {
        __FRUIT_TRUCK_UPDATE_E2E__: { workspacePayload: () => unknown };
      }
    ).__FRUIT_TRUCK_UPDATE_E2E__.workspacePayload() as {
      sessions?: Array<{ id?: string; assets?: unknown[] }>;
    };
    return structuredClone(payload.sessions?.find((session) => session.id === id)?.assets ?? []);
  }, sessionId);
}

async function persistedUpdatePhases(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { calls: Array<{ cmd: string; args: { phase?: unknown } }> };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.calls
    .filter((call) => call.cmd === "set_update_transaction_phase")
    .map((call) => call.args.phase));
}

async function downloadSupportBundle(page: Page): Promise<Record<string, unknown>> {
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "App settings" });
  await expect(settings).toBeVisible();
  const downloadStarted = page.waitForEvent("download");
  await settings.getByRole("button", { name: "Export redacted diagnostics" }).click();
  const download = await downloadStarted;
  const path = await download.path();
  if (!path) throw new Error("The support bundle download did not produce a local file.");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function clickHiddenNewSession(page: Page) {
  return page.locator(".session-sidebar-tools button[aria-label='New session']").evaluate((button) => new Promise<string>((resolve) => {
    let settled = false;
    const finish = (message: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("error", onError, true);
      resolve(message);
    };
    const onError = (event: ErrorEvent) => {
      const message = event.error instanceof Error ? event.error.message : event.message;
      if (message === "The workspace is locked while an update is being prepared.") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      finish(message);
    };
    window.addEventListener("error", onError, { capture: true, once: true });
    (button as HTMLButtonElement).click();
    window.setTimeout(() => finish(""), 50);
  }));
}

test("Settings exposes the localized busy state while an update check is held", async ({ page }) => {
  await installTauriMock(page, {
    workspace: cloneFixture(V8_WORKSPACE),
    updaterAvailable: false,
    holdUpdateCheck: true,
  });
  await page.goto("/");
  await expect(page.getByText("Phase 3 Director recovery workspace", { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "App settings" });
  await expect(settings).toBeVisible();
  const checkingButton = settings.getByRole("button", { name: "Checking for updates…" });
  await expect(checkingButton).toBeDisabled();
  await expect(checkingButton).toHaveAttribute("aria-busy", "true");
  await expect(settings.getByRole("status").filter({ hasText: "Checking for updates…" }))
    .toHaveText("Checking for updates…");

  await page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { releaseUpdateCheck: () => void };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.releaseUpdateCheck());
});

test("update preparation locks workspace mutations until a cancelled snapshot releases the lock", async ({ page }) => {
  const updateDialog = await gotoUpdateReady(page, {
    workspace: cloneFixture(V8_WORKSPACE),
    holdSnapshot: true,
  });
  await expect(page.getByText("1 total", { exact: true })).toBeVisible();

  await updateDialog.getByRole("button", { name: "Update and restart" }).click();
  await expect(updateDialog.getByRole("progressbar", { name: "Verifying assets…" })).toBeVisible();
  await expect.poll(async () => (await invokedCommands(page)).filter((cmd) => cmd === "create_pre_update_snapshot").length).toBe(1);

  expect(await clickHiddenNewSession(page)).toBe("The workspace is locked while an update is being prepared.");
  await expect(page.getByText("1 total", { exact: true })).toBeVisible();
  await expect(page.getByText("2 total", { exact: true })).toHaveCount(0);

  await updateDialog.getByRole("button", { name: "Cancel" }).click();
  await page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { releaseSnapshot: () => void };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.releaseSnapshot());
  await expect(updateDialog.getByRole("button", { name: "Update and restart" })).toBeEnabled();
  await expect.poll(async () => (await invokedCommands(page)).filter((cmd) => cmd === "abort_update_transaction").length).toBe(1);

  await updateDialog.getByRole("button", { name: "Later" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
  expect(await invokedCommands(page)).not.toContain("plugin:updater|download_and_install");
});

test("an active operation blocks install before snapshot or updater IPC", async ({ page }) => {
  await installTauriMock(page, {
    workspace: cloneFixture(V8_WORKSPACE),
    holdUpdateCheck: true,
    holdPlanner: true,
  });
  await page.goto("/");
  const prompt = page.getByRole("combobox", { name: /^Prompt/ });
  await expect(prompt).toHaveValue("Track the fruit truck through the market.", { timeout: 15_000 });

  const toolbar = page.getByRole("toolbar", { name: "Prompt enhancement actions" });
  await toolbar.getByRole("button", { name: "Enhance Prompt" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("separate paid planner request");
  await confirmation.getByRole("button", { name: "Enhance Prompt", exact: true }).click();
  await expect.poll(() => invokedPathCount(page, "/chat/completions")).toBe(1);

  await page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { releaseUpdateCheck: () => void };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.releaseUpdateCheck());
  const updateDialog = page.getByRole("dialog", { name: "A sharper build is ready." });
  await expect(updateDialog).toBeVisible();

  await updateDialog.getByRole("button", { name: "Update and restart" }).click();
  await expect(updateDialog.getByRole("alert")).toContainText(/Finish or recover \d+ active operation\(s\)/);
  await expect(updateDialog.getByRole("button", { name: "Try again" })).toBeEnabled();

  const commands = await invokedCommands(page);
  expect(commands).not.toContain("create_pre_update_snapshot");
  expect(commands).not.toContain("plugin:updater|download_and_install");
});

test("snapshot failure stays in the update dialog, skips install, and unlocks the workspace", async ({ page }) => {
  const updateDialog = await gotoUpdateReady(page, {
    workspace: cloneFixture(V8_WORKSPACE),
    snapshotFailure: "Snapshot checksum verification failed.",
  });

  await updateDialog.getByRole("button", { name: "Update and restart" }).click();
  await expect(updateDialog.getByRole("alert")).toContainText("Snapshot checksum verification failed.");
  await expect(updateDialog.getByRole("button", { name: "Try again" })).toBeEnabled();
  expect(await invokedCommands(page)).not.toContain("plugin:updater|download_and_install");

  await updateDialog.getByRole("button", { name: "Later" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
});

test("a successful updater run persists download, install, and restart phases in order", async ({ page }) => {
  const updateDialog = await gotoUpdateReady(page, { workspace: cloneFixture(V8_WORKSPACE) });
  await updateDialog.getByRole("button", { name: "Update and restart" }).click();

  await expect(updateDialog.getByRole("progressbar", { name: "Restarting…" })).toBeVisible();
  await expect.poll(() => persistedUpdatePhases(page)).toEqual([
    "downloading",
    "installing",
    "awaiting_restart",
  ]);
  const commands = await invokedCommands(page);
  expect(commands).toContain("create_pre_update_snapshot");
  expect(commands).toContain("plugin:updater|download_and_install");
});

test("an updater failure after the installing phase keeps the workspace locked for recovery", async ({ page }) => {
  const updateDialog = await gotoUpdateReady(page, {
    workspace: cloneFixture(V8_WORKSPACE),
    updaterFailureAfterFinished: "The installer stopped after replacing the app bundle.",
    installingPhaseFailure: "The installing phase marker could not be persisted.",
  });
  await updateDialog.getByRole("button", { name: "Update and restart" }).click();

  const recovery = page.getByRole("alertdialog", { name: "Your workspace needs verification." });
  await expect(recovery).toBeVisible({ timeout: 15_000 });
  await expect(recovery).toContainText("update_relaunch_required");
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  const commands = await invokedCommands(page);
  expect(commands).toContain("fail_update_transaction");
  expect(commands).not.toContain("abort_update_transaction");
});

test("post-update verification failure exposes recovery actions and retry restores the migrated workspace", async ({ page }) => {
  await installTauriMock(page, {
    workspace: cloneFixture(V6_WORKSPACE),
    pendingTransaction: true,
    runningVersion: UPDATE_VERSION,
    updaterAvailable: false,
    assetVerificationValid: false,
    holdCompletion: true,
    holdVideoPoll: true,
  });
  await page.goto("/");
  expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);

  const recovery = page.getByRole("alertdialog", { name: "Your workspace needs verification." });
  await expect(recovery).toBeVisible({ timeout: 15_000 });
  await expect(recovery).toContainText("v0.6.7 → v0.7.0");
  await expect(recovery).toContainText(TRANSACTION_ID);
  await expect(recovery).toContainText("asset_verification_failed");
  await expect(recovery.getByRole("alert")).toContainText("Managed update asset is missing after restart.");
  await expect(recovery.getByRole("button")).toHaveText([
    "Retry verification",
    "Restore pre-update workspace",
    "Export pre-update snapshot",
    "Open asset folder",
    "Exit without changes",
  ]);

  await recovery.getByRole("button", { name: "Export pre-update snapshot" }).click();
  await expect(page.getByText("Pre-update workspace exported to /mock/exports/pre-update-workspace.json.")).toBeVisible();
  await recovery.getByRole("button", { name: "Open asset folder" }).click();
  await recovery.getByRole("button", { name: "Exit without changes" }).click();
  await recovery.getByRole("button", { name: "Restore pre-update workspace" }).click();
  await expect.poll(async () => (await invokedCommands(page)).filter((cmd) => cmd === "verify_update_assets").length).toBe(2);
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Retry verification" })).toBeEnabled();

  let commands = await invokedCommands(page);
  expect(commands).toContain("export_pre_update_snapshot");
  expect(commands).toContain("update_asset_folder");
  expect(commands).toContain("plugin:opener|open_path");
  expect(commands).toContain("quit_app");
  expect(commands).toContain("restore_pre_update_snapshot");
  expect(commands).not.toContain("cleanup_completed_update_snapshots");

  await page.evaluate(() => {
    const control = (
      window as Window & typeof globalThis & {
        __FRUIT_TRUCK_UPDATE_E2E__: { assetVerificationValid: boolean };
      }
    ).__FRUIT_TRUCK_UPDATE_E2E__;
    control.assetVerificationValid = true;
  });
  await recovery.getByRole("button", { name: "Retry verification" }).click();

  await expect.poll(async () => (await invokedCommands(page))
    .filter((command) => command === "complete_update_transaction").length).toBe(1);
  await expect(recovery).toHaveCount(0);
  await expect(page.getByText("Phase 3 production workspace", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Prompt/, includeHidden: true })).toHaveValue(
    "Track alongside @1 while the fruit truck rolls through the market.",
  );
  const shell = page.locator(".app-shell");
  await expect(shell).toHaveAttribute("data-workspace-boot-state", "ready");
  await expect(shell).toHaveAttribute("data-update-locked", "true");
  await expect(shell).toHaveAttribute("inert", "");
  expect(await invokedCallArgs(page, "complete_update_transaction")).toMatchObject({
    workspaceBootState: "ready",
    updateLocked: "true",
    shellInert: true,
  });
  commands = await invokedCommands(page);
  expect(commands).toContain("complete_update_transaction");
  expect(commands.filter((command) => command === "save_verified_update_workspace")).toHaveLength(1);
  expect(commands.filter((command) => command === "scan_managed_assets")).toHaveLength(1);
  expect(commands).not.toContain("delete_managed_asset");
  expect(commands).not.toContain("cleanup_completed_update_snapshots");
  expect(commands).not.toContain("save_workspace_state");
  expect(await invokedPathCount(page, "/videos/provider-video-job-phase3")).toBe(0);
  const orderedCommands = [
    "load_pre_update_snapshot",
    "verify_update_assets",
    "save_verified_update_workspace",
    "scan_managed_assets",
    "complete_update_transaction",
  ].map((command) => commands.lastIndexOf(command));
  expect(orderedCommands.every((index) => index >= 0)).toBe(true);
  expect(orderedCommands).toEqual([...orderedCommands].sort((left, right) => left - right));

  await page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { releaseCompletion: () => void };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.releaseCompletion());
  await expect(shell).toHaveAttribute("data-update-locked", "false");
  await expect(shell).not.toHaveAttribute("inert", "");
  await expect.poll(() => invokedPathCount(page, "/videos/provider-video-job-phase3")).toBe(1);
  await expect.poll(() => persistedAttemptNextPollAt(page, "phase3-video-attempt-active"))
    .toBe("2026-09-04T03:00:00.000Z");
  await expect.poll(async () => (await invokedCommands(page))
    .filter((command) => command === "cleanup_completed_update_snapshots").length).toBe(1);
  const sourceAssets = (V6_WORKSPACE as { sessions: Array<{ id: string; assets: unknown[] }> })
    .sessions.find((session) => session.id === "phase3-session-v6")?.assets ?? [];
  expect(await persistedSessionAssets(page, "phase3-session-v6")).toEqual(sourceAssets);
  await page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { releaseVideoPoll: () => void };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.releaseVideoPoll());

  const supportBundle = await downloadSupportBundle(page);
  const completionEntry = (supportBundle.logs as Array<{ event?: string; details?: Record<string, unknown> }>)
    .find((entry) => entry.event === "update.verification_complete");
  expect(completionEntry?.details).toMatchObject({
    fromAppVersion: CURRENT_VERSION,
    toAppVersion: UPDATE_VERSION,
    fromStudioSchema: 6,
    targetStudioSchema: 8,
    finalPhase: "complete",
    snapshotChecksum: "a".repeat(64),
    assetManifestChecksum: "b".repeat(64),
    assetVerification: { verifiedEntries: 2, errorCount: 0 },
    migrationSteps: ["v6→v7", "v7→v8"],
  });
  const serializedSupport = JSON.stringify(supportBundle);
  expect(serializedSupport).not.toContain("Track alongside @1 while the fruit truck rolls through the market.");
  expect(serializedSupport).not.toContain("data:image");
});

test("a missing verified presence record keeps update boot read-only without cleanup", async ({ page }) => {
  await installTauriMock(page, {
    workspace: cloneFixture(V6_WORKSPACE),
    pendingTransaction: true,
    runningVersion: UPDATE_VERSION,
    updaterAvailable: false,
    managedScanOmitName: "active-video.mp4",
  });
  await page.goto("/");

  const recovery = page.getByRole("alertdialog", { name: "Your workspace needs verification." });
  await expect(recovery).toBeVisible({ timeout: 15_000 });
  await expect(recovery).toContainText("post_update_verification_failed");
  await expect(recovery.getByRole("alert")).toContainText("Managed asset presence scan is missing 1 verified file(s).");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-boot-state", "recovery_required");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-update-locked", "true");
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");

  const commands = await invokedCommands(page);
  expect(commands).toContain("save_verified_update_workspace");
  expect(commands).toContain("scan_managed_assets");
  expect(commands).toContain("fail_update_transaction");
  expect(commands).not.toContain("complete_update_transaction");
  expect(commands).not.toContain("save_workspace_state");
  expect(commands).not.toContain("delete_managed_asset");
  expect(commands).not.toContain("cleanup_completed_update_snapshots");
  expect(await invokedPathCount(page, "/videos/provider-video-job-phase3")).toBe(0);
});

test("a failed completion marker returns the verified workspace to read-only recovery", async ({ page }) => {
  await installTauriMock(page, {
    workspace: cloneFixture(V6_WORKSPACE),
    pendingTransaction: true,
    runningVersion: UPDATE_VERSION,
    updaterAvailable: false,
    completionFailure: "Completion marker could not be written.",
  });
  await page.goto("/");

  const recovery = page.getByRole("alertdialog", { name: "Your workspace needs verification." });
  await expect(recovery).toBeVisible({ timeout: 15_000 });
  await expect(recovery).toContainText("completion_marker_failed");
  await expect(recovery.getByRole("alert")).toContainText("Completion marker could not be written.");
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-boot-state", "recovery_required");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-update-locked", "true");
  expect(await invokedCallArgs(page, "complete_update_transaction")).toMatchObject({
    workspaceBootState: "ready",
    updateLocked: "true",
    shellInert: true,
  });
  const commands = await invokedCommands(page);
  expect(commands).toContain("complete_update_transaction");
  expect(commands).toContain("fail_update_transaction");
  expect(commands).toContain("scan_managed_assets");
  expect(commands).not.toContain("save_workspace_state");
  expect(commands).not.toContain("delete_managed_asset");
  expect(commands).not.toContain("cleanup_completed_update_snapshots");
  expect(await invokedPathCount(page, "/videos/provider-video-job-phase3")).toBe(0);
  const orderedCommands = [
    "save_verified_update_workspace",
    "scan_managed_assets",
    "complete_update_transaction",
    "fail_update_transaction",
  ].map((command) => commands.indexOf(command));
  expect(orderedCommands.every((index) => index >= 0)).toBe(true);
  expect(orderedCommands).toEqual([...orderedCommands].sort((left, right) => left - right));
});

test("restart retries the same verified payload after a completion marker interruption", async ({ page }) => {
  await installTauriMock(page, {
    workspace: cloneFixture(V6_WORKSPACE),
    pendingTransaction: true,
    runningVersion: UPDATE_VERSION,
    updaterAvailable: false,
    completionFailure: "Completion marker was interrupted once.",
    completionFailureCount: 1,
    persistAcrossReload: true,
  });
  await page.goto("/");

  const recovery = page.getByRole("alertdialog", { name: "Your workspace needs verification." });
  await expect(recovery).toBeVisible({ timeout: 15_000 });
  await expect(recovery).toContainText("completion_marker_failed");

  await page.reload();

  await expect(recovery).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Phase 3 production workspace", { exact: true })).toBeVisible();
  const commands = await invokedCommands(page);
  expect(commands).toContain("save_verified_update_workspace");
  expect(commands).toContain("complete_update_transaction");
  await expect.poll(() => invokedPathCount(page, "/videos/provider-video-job-phase3")).toBe(1);
});

test("retention cleanup retries after ready without reopening update recovery", async ({ page }) => {
  await installTauriMock(page, {
    workspace: cloneFixture(V8_WORKSPACE),
    pendingTransaction: true,
    runningVersion: UPDATE_VERSION,
    updaterAvailable: false,
    retentionCleanupFailureCount: 1,
  });
  await page.goto("/");

  await expect(page.getByText("Phase 3 Director recovery workspace", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("alertdialog", { name: "Your workspace needs verification." })).toHaveCount(0);
  await expect.poll(async () => (await invokedCommands(page))
    .filter((command) => command === "cleanup_completed_update_snapshots").length, { timeout: 8_000 }).toBe(2);
  const retentionFailure = await page.evaluate(() => {
    const entries = JSON.parse(localStorage.getItem("fruit-truck.diagnostics.v1") ?? "[]") as Array<{ event?: string }>;
    return entries.some((entry) => entry.event === "update.retention_cleanup_failed");
  });
  expect(retentionFailure).toBe(true);
});

test("an in-flight video poll blocks snapshotting and applies its result only after unlock", async ({ page }) => {
  const updateDialog = await gotoUpdateReady(page, {
    workspace: cloneFixture(V6_WORKSPACE),
    holdVideoPoll: true,
    completeVideoPoll: true,
  });
  await expect.poll(() => invokedPathCount(page, "/videos/provider-video-job-phase3")).toBe(1);
  await expect.poll(async () => (await invokedCommands(page)).filter((command) => command === "save_workspace_state").length).toBeGreaterThan(0);
  await page.waitForTimeout(50);

  await updateDialog.getByRole("button", { name: "Update and restart" }).click();
  await expect(updateDialog.getByRole("alert")).toContainText(/Finish or recover \d+ active operation\(s\)/);
  const activeOperationMessage = await updateDialog.getByRole("alert").textContent();
  const activeOperationCount = Number(activeOperationMessage?.match(/recover (\d+) active/)?.[1]);
  expect(activeOperationCount).toBeGreaterThanOrEqual(2);
  expect(await invokedCommands(page)).not.toContain("create_pre_update_snapshot");

  await page.evaluate(() => (
    window as Window & typeof globalThis & {
      __FRUIT_TRUCK_UPDATE_E2E__: { releaseVideoPoll: () => void };
    }
  ).__FRUIT_TRUCK_UPDATE_E2E__.releaseVideoPoll());
  await expect.poll(() => persistedAttemptStatus(page, "phase3-video-attempt-active")).toBe("completed");
});

for (const phase of ["installing", "awaiting_restart", "recovery_required"]) {
  test(`a source-version restart safely abandons a ${phase} update transaction`, async ({ page }) => {
    await installTauriMock(page, {
      workspace: cloneFixture(V8_WORKSPACE),
      pendingPhase: phase,
      runningVersion: CURRENT_VERSION,
      updaterAvailable: false,
    });
    await page.goto("/");

    await expect(page.getByText("Phase 3 Director recovery workspace", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("alertdialog", { name: "Your workspace needs verification." })).toHaveCount(0);
    const commands = await invokedCommands(page);
    expect(commands).toContain("abandon_update_transaction_after_source_relaunch");
    expect(commands).not.toContain("verify_update_assets");
  });
}
