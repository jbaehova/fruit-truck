import { totalActualCostUsd, type ActualCostEntry } from "./agent.ts";

type RevisionedBridgeSession = {
  id: string;
  updatedAt: string;
  agent: {
    revision: number;
    updatedAt: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableString(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function equal(left: unknown, right: unknown) {
  return stableString(left) === stableString(right);
}

function recordKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `value:${stableString(value)}`;
  }
  const item = value as Record<string, unknown>;
  for (const key of ["id", "assetId", "name"]) {
    if (typeof item[key] === "string") return `${key}:${item[key]}`;
  }
  return undefined;
}

function mergeArray(base: unknown[], local: unknown[], remote: unknown[]): unknown[] {
  const values = [...base, ...local, ...remote];
  if (!values.length) return [];
  const keys = values.map(recordKey);
  if (keys.some((key) => !key)) {
    return equal(local, base) ? remote : equal(remote, base) ? local : remote;
  }
  const baseMap = new Map(base.map((value) => [recordKey(value)!, value]));
  const localMap = new Map(local.map((value) => [recordKey(value)!, value]));
  const remoteMap = new Map(remote.map((value) => [recordKey(value)!, value]));
  const order = [...remoteMap.keys(), ...[...localMap.keys()].filter((key) => !remoteMap.has(key))];
  return order.flatMap((key) => {
    const baseValue = baseMap.get(key);
    const localValue = localMap.get(key);
    const remoteValue = remoteMap.get(key);
    if (baseMap.has(key) && (!localMap.has(key) || !remoteMap.has(key))) return [];
    if (!localMap.has(key)) return remoteMap.has(key) ? [remoteValue] : [];
    if (!remoteMap.has(key)) return [localValue];
    return [mergeValue(baseValue, localValue, remoteValue)];
  });
}

function mergeValue(base: unknown, local: unknown, remote: unknown): unknown {
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;
  if (equal(local, remote)) return local;
  if (Array.isArray(local) && Array.isArray(remote)) {
    return mergeArray(Array.isArray(base) ? base : [], local, remote);
  }
  if (local && remote && typeof local === "object" && typeof remote === "object") {
    const baseRecord = base && typeof base === "object" && !Array.isArray(base)
      ? base as Record<string, unknown>
      : {};
    const localRecord = local as Record<string, unknown>;
    const remoteRecord = remote as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(localRecord), ...Object.keys(remoteRecord)])) {
      merged[key] = mergeValue(baseRecord[key], localRecord[key], remoteRecord[key]);
    }
    return merged;
  }
  return remote;
}

function recordId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function recordedAtMillis(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const recordedAt = (value as Record<string, unknown>).recordedAt;
  if (typeof recordedAt !== "string") return undefined;
  const millis = Date.parse(recordedAt);
  return Number.isFinite(millis) ? millis : undefined;
}

function resolveCostLedgerConflicts(merged: unknown[], local: unknown[], remote: unknown[]) {
  const localById = new Map(local.flatMap((entry) => {
    const id = recordId(entry);
    return id ? [[id, entry] as const] : [];
  }));
  const remoteById = new Map(remote.flatMap((entry) => {
    const id = recordId(entry);
    return id ? [[id, entry] as const] : [];
  }));
  return merged.map((entry) => {
    const id = recordId(entry);
    const localEntry = id ? localById.get(id) : undefined;
    const remoteEntry = id ? remoteById.get(id) : undefined;
    if (!localEntry || !remoteEntry || equal(localEntry, remoteEntry)) return entry;
    const localMillis = recordedAtMillis(localEntry);
    const remoteMillis = recordedAtMillis(remoteEntry);
    if (localMillis == null || remoteMillis == null || localMillis === remoteMillis) return entry;
    return localMillis > remoteMillis ? localEntry : remoteEntry;
  });
}

function executionCostLedger(session: RevisionedBridgeSession): unknown[] | undefined {
  const execution = session.agent.execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return undefined;
  const ledger = (execution as Record<string, unknown>).costLedger;
  return Array.isArray(ledger) ? ledger : undefined;
}

export function mergeBridgeSession<T extends RevisionedBridgeSession>(
  base: T,
  local: T,
  remote: T,
): T {
  const merged = mergeValue(base, local, remote) as T;
  const updatedAt = new Date().toISOString();
  const execution = merged.agent.execution;
  const costLedger = execution && typeof execution === "object" && !Array.isArray(execution)
    ? (execution as Record<string, unknown>).costLedger
    : undefined;
  const resolvedCostLedger = Array.isArray(costLedger)
    ? resolveCostLedgerConflicts(costLedger, executionCostLedger(local) ?? [], executionCostLedger(remote) ?? [])
    : undefined;
  const normalizedExecution = resolvedCostLedger ? {
    ...(execution as Record<string, unknown>),
    costLedger: resolvedCostLedger,
    spentUsd: totalActualCostUsd(resolvedCostLedger.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const cost = (entry as Record<string, unknown>).actualCostUsd;
      return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? [entry as ActualCostEntry] : [];
    })),
  } : execution;
  return {
    ...merged,
    updatedAt,
    agent: {
      ...merged.agent,
      ...(normalizedExecution ? { execution: normalizedExecution } : {}),
      revision: remote.agent.revision + 1,
      updatedAt,
    },
  };
}
