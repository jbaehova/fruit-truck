# MCP tool guide

## Session and state

- `create_session(intent, name?, workflowSkills?)`: publish a durable connection-waiting session.
- `list_sessions()` / `get_session(sessionId)`: orient and read authoritative state.
- `claim_session(sessionId, agentName)`: claim before planning or execution and record the configured agent host.
- `update_brief`, `upsert_requirements`, `replace_plan`, `set_step_status`: maintain agent-owned production state.
- `queue_decision(..., requestKey)`: persist a chat question before presenting it to the user. The key is session-unique and must be reused for retries.
- `resolve_decision(sessionId, decisionId, userResponse, optionId?, note?, relatedAssetIds?)`: store the explicit chat reply and apply decision effects atomically.
- `record_activity(...)`: append durable execution provenance.

There is no `await_decision`. Ask in the current chat, end the turn, and resolve on the user's next message. Control mode, session limits, and assembly rendering remain desktop-owned.

## Image backend

- `request_image_backend_selection(sessionId, reselect?)`: Codex-only, session-scoped choice between `codex_builtin` and `openrouter`.
- `register_host_image(...)`: Codex-only import for a built-in imagegen result. The session must have selected `codex_builtin`; the source must be in Codex generated-images or OpenGen UI managed storage.
- Non-Codex hosts are fixed to OpenRouter and do not receive these tools.

## Models and generation

- `list_models(mode)`: retrieve current OpenRouter capability metadata.
- `request_model_selection(..., requestKey)`: persist a compatible-model chat choice idempotently.
- `submit_generation(...)`: use a chat-confirmed OpenRouter model. Image submission also requires the session image backend to be `openrouter`.
- `poll_video(sessionId, jobId)`: poll and materialize a completed OpenRouter video.
- `register_asset(...)`: register a managed upload or external derivative.
- `evaluate_asset(...)`: store technical and aesthetic analysis; approval is a separate chat decision.

## Assembly and Skills

- The desktop `Make final video` window owns clip order, ranges, and rendering. Final approval happens in chat.
- `propose_custom_skill(sessionId, requestKey, name)`: create a text-only proposal and queue chat approval.
- `request_custom_skill_activation(..., requestKey)`: queue activation or deactivation for chat confirmation.
- `list_custom_skills()` / `get_custom_skill(...)`: read stored Skills. Settings owns manual import, inspection, and rollback.

## Recovery

Pending decisions and video jobs are durable. On restart, reread the session, re-present any unanswered chat question, poll known jobs, and never duplicate work because a process or turn ended.
