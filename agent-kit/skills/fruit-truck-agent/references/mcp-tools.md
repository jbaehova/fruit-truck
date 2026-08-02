# MCP tool guide

## Session and desktop presence

- `create_session(intent, name?, workflowSkills?)`: create a durable agent-first session.
- `ensure_desktop(sessionId)`: verify heartbeat and background-launch the installed macOS app without stealing focus.
- `list_sessions()` / `get_session(sessionId)`: orient and read authoritative state.
- `claim_session(sessionId, agentName)`: claim before planning or generation.
- `update_brief`, `upsert_requirements`, `replace_plan`, `set_step_status`: maintain production state.

## Decisions

- `queue_decision(..., requestKey, channel, presentation?, selectionMode?)`: create an idempotent chat or Fruit Truck checkpoint.
- `resolve_decision(...)`: record only an explicit agent-chat reply.
- `await_decision(sessionId, decisionId, timeoutMs?)`: wait briefly for a Fruit Truck UI result; repeat after a pending timeout.
- `request_model_selection(..., threadIds?)` and `request_image_backend_selection(...)`: always create Fruit Truck UI decisions. Scoped model choices set thread overrides; unscoped choices set the mode default.

UI decisions may use `form`, `media_grid`, `model_picker`, `upload`, or `assembly_review`, with `none`, `single`, `multiple`, or `one_per_group` selection.

## Assets, models, and generation

- `import_remote_asset(...)`: safely download a public web reference and preserve source metadata.
- `register_asset(...)`: register an existing managed upload or derivative.
- `create_generation_thread(...)`: add a visible blank image or video execution lane. Its name and output role are free-form Skill semantics.
- `update_generation_thread(...)`: write one thread with optimistic `expectedThreadRevision` protection.
- `archive_generation_thread(...)`: archive an idle thread without deleting assets or provenance.
- `restore_generation_thread(...)`: restore an archived thread and its history.
- `enhance_generation_threads(...)`: enhance several thread prompts concurrently; its request key durably reuses paid results.
- `run_generation_threads(...)`: atomically preflight and enqueue every selected thread. Reuse the same request key.
- `await_generation_threads(...)`: wait on attempt IDs; `pending` is not failure, while `terminal` must be interpreted through its batch `outcome`.
- `cancel_generation_threads(...)`: cancel attempts that have not reached provider submission; submitted jobs remain tracked.
- `register_host_image(..., threadId, attemptId)`: complete a Codex host action and register its output.
- `fail_host_generation(...)`: end a failed Codex host action safely.
- `list_models(mode)`: return live capabilities and pricing data when published.
- `submit_generation(...)` / `poll_video(...)`: legacy single-generation tools; prefer generation threads for new workflows.
- `evaluate_asset(...)`: record technical and aesthetic evaluation.

Starting Agent mode is the user's generation authorization. There is no budget or generation-limit checkpoint.

## Assembly and recovery

- `propose_assembly(...)`: populate approved clips and queue Fruit Truck assembly review.
- Fruit Truck owns the editable ranges and Render action.
- Pending UI decisions and thread attempts are durable. Video job IDs and polling state live on their attempt. Never duplicate them because a wait timed out.
