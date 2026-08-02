# State invariants and recovery

## Invariants

- A session begins in connection-waiting state and is claimed by one agent host.
- `ensure_desktop` may background-launch Fruit Truck but never requests foreground focus.
- Chat decisions are resolved only from explicit chat replies.
- Fruit Truck UI decisions are resolved only by the desktop and observed through `await_decision`.
- Request keys are session-unique and retries reuse the original decision.
- A thread-scoped blocking decision stops only overlapping threads; an unscoped blocking decision stops session execution.
- Model selections and artifact approvals are never inferred from recommendations.
- Workflow Skills own plan and stage semantics. Fruit Truck stores generic plan text and generic image/video generation threads.
- Several plan steps may be active. Plan activity and generation-thread activity are independent.
- A session starts with one image and one video thread. Each thread has at most one active attempt; a batch may run any number of distinct threads.
- Mode defaults flow into non-overridden threads. A thread override remains stable until explicitly reset.
- Every batch is preflighted before any attempt is created. Reusing a generation request key returns the original attempts.
- Every derivative records parents, role, prompt, backend/model, and plan step when available.
- Managed paths stay within approved roots; metadata contains no Base64.
- Paid submissions are exactly-once across waits, restarts, and conflicts.

## Resume audit

1. Read the session and claim it only if it is still waiting.
2. Verify host ownership and Agent control.
3. Inspect pending decisions before creating new ones.
4. Await Fruit Truck UI checkpoints or re-present chat checkpoints through their original channel.
5. Check durable thread attempts and jobs, selected backend/model, parents, and every active plan step.
6. Continue from the exact next action.

## Failure recovery

- Persistence: `agent-sessions.json` is the revision index and each session snapshot lives under `agent-sessions/`. Never edit only one side outside the bridge lock.

- App unavailable: ask the user to open it, then call `ensure_desktop` again.
- Conflict: reread, merge, and retry.
- Missing asset: queue Fruit Truck upload/selection.
- Incompatible model: request a new Fruit Truck model choice.
- Rejected candidate: preserve it and create a derivative.
- Agent interruption: reuse pending decisions, generation request keys, and attempts (whose video attempts own their job IDs). Await queued work; review `uncertain` submissions before any retry.
