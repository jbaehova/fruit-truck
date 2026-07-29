# State invariants and recovery

## Invariants

- A new published session is connection-waiting; only `claim_session` begins work.
- The claimed host is `codex`, `claude`, `hermes`, or `unknown`; cross-host mutation is rejected.
- Codex chooses one image backend per session before its first image task. Other hosts use OpenRouter by policy.
- A resolved user decision contains a timestamp, `agent_chat` channel, and the explicit user reply.
- Decision request keys are unique within a session; retrying a request reuses its original key and decision.
- Blocking pending decisions stop execution.
- Model selections and approvals are never inferred from an agent recommendation.
- Major artifacts remain unapproved until the user's chat reply is resolved.
- A result approval updates the decision, artifact, related plan step, and revision together.
- Every derivative records parents, role, prompt, model/backend, and plan step when available.
- Managed media paths stay inside approved generated or asset roots; session JSON contains no Base64.
- Generation counters, retries, jobs, cost, and limits remain non-negative and durable.

## Resume audit

1. Read the session and claim it if waiting.
2. Confirm the current MCP host matches the claimed host.
3. Validate the graph and current step.
4. If a blocking decision is pending, use the current user message only when it clearly answers it; otherwise ask the question again.
5. Check the stored image backend, model compatibility, referenced parents, and durable jobs.
6. Continue from the exact next action.

## Failure recovery

- CAS conflict: reread, merge, and retry without overwriting newer state.
- Provider error: record it and retry only with changed conditions or explicit rationale.
- Codex imagegen failure: ask whether to reselect OpenRouter; never switch silently.
- Missing asset: ask the user in chat to import it through OpenGen UI.
- Incompatible model: queue a new model choice and ask in chat.
- Rejected candidate: preserve it, apply feedback, and create a derivative.
- Agent interrupted: re-present the durable pending decision on resume.
