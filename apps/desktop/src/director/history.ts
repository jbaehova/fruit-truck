import { cloneDirectorPlan } from "./defaults.ts";
import type { DirectorPlan } from "./types.ts";

export type DirectorHistory = {
  past: DirectorPlan[];
  present: DirectorPlan;
  future: DirectorPlan[];
};

export function createDirectorHistory(plan: DirectorPlan): DirectorHistory {
  return { past: [], present: plan, future: [] };
}

export function pushDirectorHistory(
  history: DirectorHistory,
  plan: DirectorPlan,
  limit = 50,
): DirectorHistory {
  const boundedLimit = Math.max(1, Math.floor(limit));
  return {
    past: [...history.past, cloneDirectorPlan(history.present)].slice(-boundedLimit),
    present: plan,
    future: [],
  };
}

export function undoDirectorHistory(history: DirectorHistory): DirectorHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: cloneDirectorPlan(previous),
    future: [cloneDirectorPlan(history.present), ...history.future],
  };
}

export function redoDirectorHistory(history: DirectorHistory): DirectorHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, cloneDirectorPlan(history.present)],
    present: cloneDirectorPlan(next),
    future: history.future.slice(1),
  };
}
