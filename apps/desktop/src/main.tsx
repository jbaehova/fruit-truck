import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BaseToaster } from "@/components/ui/toast";
import { I18nProvider } from "@/i18n";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <BaseToaster />
      <App />
    </I18nProvider>
  </StrictMode>,
);
