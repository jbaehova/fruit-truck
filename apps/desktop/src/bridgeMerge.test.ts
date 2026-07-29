import assert from "node:assert/strict";
import test from "node:test";
import { mergeBridgeSession } from "./bridgeMerge.ts";

test("bridge conflict merge preserves a local decision and a concurrent remote plan", () => {
  const base = {
    id: "session-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: "Shared session",
    agent: {
      revision: 4,
      updatedAt: "2026-01-01T00:00:00.000Z",
      plan: [{ id: "step-1", title: "Original" }],
      decisions: [{ id: "decision-1", status: "pending" }],
      activity: [],
    },
  };
  const local = {
    ...base,
    agent: {
      ...base.agent,
      revision: 5,
      decisions: [{ id: "decision-1", status: "resolved" }],
      activity: [{ id: "activity-local", title: "Resolved decision" }],
    },
  };
  const remote = {
    ...base,
    agent: {
      ...base.agent,
      revision: 5,
      plan: [{ id: "step-1", title: "Revised remotely" }],
      activity: [{ id: "activity-remote", title: "Revised plan" }],
    },
  };
  const merged = mergeBridgeSession(base, local, remote);
  assert.equal(merged.agent.revision, 6);
  assert.equal(merged.agent.plan[0].title, "Revised remotely");
  assert.equal(merged.agent.decisions[0].status, "resolved");
  assert.deepEqual(merged.agent.activity.map((item) => item.id), ["activity-remote", "activity-local"]);
});

test("bridge merge preserves primitive-array additions and one-sided deletions", () => {
  const base = {
    id: "session-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agent: {
      revision: 4,
      updatedAt: "2026-01-01T00:00:00.000Z",
      dependsOn: ["brief", "references"],
      mustInclude: ["logo"],
    },
  };
  const local = {
    ...base,
    agent: {
      ...base.agent,
      revision: 5,
      dependsOn: ["brief", "local-step"],
      mustInclude: ["logo", "product"],
    },
  };
  const remote = {
    ...base,
    agent: {
      ...base.agent,
      revision: 5,
      dependsOn: ["brief", "references", "remote-step"],
      mustInclude: ["logo", "location"],
    },
  };
  const merged = mergeBridgeSession(base, local, remote);
  assert.deepEqual(merged.agent.dependsOn, ["brief", "remote-step", "local-step"]);
  assert.deepEqual(merged.agent.mustInclude, ["logo", "location", "product"]);
});

test("bridge merge does not resurrect keyed items deleted on either side", () => {
  const base = {
    id: "session-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agent: {
      revision: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
      decisions: [
        { id: "remove-local", status: "pending" },
        { id: "remove-remote", status: "pending" },
        { id: "keep", status: "pending" },
      ],
    },
  };
  const local = {
    ...base,
    agent: {
      ...base.agent,
      revision: 3,
      decisions: base.agent.decisions.filter((item) => item.id !== "remove-local"),
    },
  };
  const remote = {
    ...base,
    agent: {
      ...base.agent,
      revision: 3,
      decisions: base.agent.decisions
        .filter((item) => item.id !== "remove-remote")
        .map((item) => item.id === "remove-local" ? { ...item, status: "resolved" } : item),
    },
  };
  const merged = mergeBridgeSession(base, local, remote);
  assert.deepEqual(merged.agent.decisions.map((item) => item.id), ["keep"]);
});

test("bridge equality ignores object key insertion order", () => {
  const base = {
    id: "session-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agent: {
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      options: { width: 1024, height: 768 },
    },
  };
  const local = {
    ...base,
    agent: {
      ...base.agent,
      revision: 2,
      options: { height: 768, width: 1024 },
    },
  };
  const remote = {
    ...base,
    agent: {
      ...base.agent,
      revision: 2,
      options: { width: 1280, height: 720 },
    },
  };
  const merged = mergeBridgeSession(base, local, remote);
  assert.deepEqual(merged.agent.options, remote.agent.options);
});
