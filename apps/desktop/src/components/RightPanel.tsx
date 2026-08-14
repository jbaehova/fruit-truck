import type { ReactNode } from "react";

export function RightPanel({
  assets,
}: {
  assets: ReactNode;
}) {
  return (
    <aside className="right-panel">
      <div className="right-panel-content">{assets}</div>
    </aside>
  );
}
