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

export function mergeBridgeSession<T extends RevisionedBridgeSession>(
  base: T,
  local: T,
  remote: T,
): T {
  const merged = mergeValue(base, local, remote) as T;
  const updatedAt = new Date().toISOString();
  return {
    ...merged,
    updatedAt,
    agent: {
      ...merged.agent,
      revision: remote.agent.revision + 1,
      updatedAt,
    },
  };
}
