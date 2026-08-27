import { Component, type ErrorInfo, type ReactNode } from "react";
import { localDiagnosticLog } from "@/diagnostics";

type Props = { children: ReactNode };
type State = { error: Error | null; diagnosticId: string };

function diagnosticId() {
  return `FT-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, diagnosticId: "" };

  static getDerivedStateFromError(error: Error): State {
    return { error, diagnosticId: diagnosticId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    localDiagnosticLog().append({
      level: "error",
      event: "renderer.fatal_error",
      details: {
        diagnosticId: this.state.diagnosticId,
        name: error.name,
        componentStack: info.componentStack,
      },
    });
    console.error("Fruit Truck renderer failure", {
      diagnosticId: this.state.diagnosticId,
      name: error.name,
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const korean = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ko");
    return (
      <main className="fatal-recovery" role="alert">
        <img src="/fruit-truck-icon.png" alt="" />
        <p>{korean ? "안전 모드" : "SAFE MODE"}</p>
        <h1>{korean ? "작업 공간을 표시할 수 없습니다." : "The workspace could not be displayed."}</h1>
        <span>
          {korean
            ? "저장된 작업은 삭제하지 않았습니다. 앱을 다시 불러오거나 진단 ID와 함께 오류를 신고하세요."
            : "Fruit Truck did not delete your saved work. Reload the app or report the error with the diagnostic ID."}
        </span>
        <code>{this.state.diagnosticId}</code>
        <details>
          <summary>{korean ? "기술 세부 정보" : "Technical details"}</summary>
          <pre>{this.state.error.message}</pre>
        </details>
        <button type="button" onClick={() => window.location.reload()}>
          {korean ? "작업 공간 다시 불러오기" : "Reload workspace"}
        </button>
      </main>
    );
  }
}
