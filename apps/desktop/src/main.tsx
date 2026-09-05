import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BaseToaster } from "@/components/ui/toast";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { I18nProvider } from "@/i18n";
import "./index.css";
import App from "./App";
import { isTauriRuntime } from "./openrouter";
import { restoreWorkspacePreferences } from "./workspacePreferences";

async function start() {
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const loaded = await invoke<{ payload: unknown } | null>("load_workspace_state");
      if (loaded) restoreWorkspacePreferences(localStorage, loaded.payload);
    } catch {
      // App owns recovery presentation and blocks writes if native loading fails.
    }
  }
  createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <BaseToaster />
      <AppErrorBoundary><App /></AppErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);
}

void start();
