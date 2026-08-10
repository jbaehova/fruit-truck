---
name: fruit-truck-agent
description: Orchestrate resumable image and video production from the current agent chat through Fruit Truck, using Fruit Truck for rich media review while keeping textual creative clarification in chat.
---

# Fruit Truck Agent

Turn rough intent into a durable production session. The agent structures the brief, finds or requests references, plans, generates, evaluates, revises, and hands a prepared assembly to Fruit Truck. Fruit Truck stores state and media and provides the rich visual checkpoints that agent chat cannot represent well.

## Start from the agent

For new work:

1. Call `session_open` with a stable `requestKey` and the user's original intent. Keep the returned session ID; the new session is durable and waiting.
2. Call `ensure_desktop`. Fruit Truck may start in the background, but must never steal foreground focus or switch the user's active session.
3. If the result is `user_action_required`, ask the user to open Fruit Truck and end the turn. Reuse the same session after they reply.
4. If OpenRouter will be needed and `credentialConfigured` is false, ask the user to add the API key in Fruit Truck Settings before paid generation.
5. Call `session_open` again with the same session ID/request key and `agentName` to claim it. Commit the brief, requirements, plan, and initial threads together with one `session_commit` when their inputs are known.

For existing work, call `session_open` with its session ID and then use `session_read` with the `resume` view. Inspect pending decisions and active/latest attempts before creating anything. Use entity-specific `decisions`, `threads`, or `artifacts` reads only when their full current fields are required; reserve `recovery` for repair.

Starting an Agent run authorizes paid generation while Agent control remains active. Do not request a budget, generation limit, batch approval, or per-call cost approval. Show available price information during model selection and keep actual provider cost as transparent session metadata.

## Split decisions by medium

Ask in the current agent chat only when prose discussion is materially better:

- ambiguous goal, deliverable, or usage;
- essential story event or character relationship;
- identity facts, prohibited content, or hard distribution constraints.

For a chat decision, add a `queue_decision` op with `channel: agent_chat` to `session_commit`, present concise options here, and end the turn. In the fast profile, the explicit reply is applied through the corresponding typed commit/resolution path; never infer it.

Use Fruit Truck UI for:

- Codex image backend and OpenRouter model selection;
- uploaded or web reference selection;
- character/product/environment sheets;
- keyframes, image batches, video shots, and final approvals;
- grouped single-choice or multi-select media review;
- final-video assembly review.

For a UI decision other than assembly review, add a `queue_decision` op with `channel: fruit_truck_ui` and an accurate `presentation`/`selectionMode`. Tell the user that a review is waiting in Fruit Truck, but do not foreground the app. Call `task_wait` with the decision ID and last event cursor; on timeout, reuse both. Never resolve a UI checkpoint from chat. The `propose_assembly` commit op creates its own assembly review; never queue an `assembly_review` decision separately.

The default fast profile does not create, save, or activate Custom Skills. Do not queue a Custom Skill checkpoint from this workflow; those maintenance actions require an explicitly configured legacy profile.

Use a stable, session-unique `requestKey` for every checkpoint. Blocking decisions stop execution and survive app closure, agent interruption, and restart.

## Build the production graph

Derive the smallest useful graph from the requested output:

- single image → references if needed, candidate generation, review, final;
- single short video → compatible frame/reference preparation, motion generation, review, final;
- multi-shot ad, story, animal film, documentary, or 3D piece → continuity assets, storyboard/keyframes, short shots, assembly, final.

Detect prerequisites:

- recurring people, characters, or animals → identity sheet;
- products, packaging, logos, or props → product/detail sheet;
- recurring location → environment reference;
- multi-shot video → storyboard and approved keyframes;
- model-specific inputs → compatible start/end/reference frames.

Use `replace_plan`, `mark_step`, and `bind_step` operations inside `session_commit`. Plan IDs, names, grouping, and stage semantics belong to the active Workflow Skill, not Fruit Truck. Bind a decision or thread to a step only when that relationship is explicit. The server records activity and advances bound steps for generation/checkpoint outcomes in the same transaction; do not send duplicate bookkeeping calls. Dependencies becoming ready never authorize automatic generation.

## References

Prefer user-supplied assets when identity or product fidelity matters. Queue an `upload` Fruit Truck decision and wait for the user to import/select them.

When web search is available, find suitable reference candidates and preserve the source page and license status in chat. The default fast profile has no remote-import tool, so ask the user to download or add the chosen reference through an `upload` Fruit Truck decision. Treat unknown licensing as reference-only and never choose an important identity reference silently.

Preserve source media and lineage. Session metadata stores managed local paths, never Base64 or data URLs. Bridge persistence uses a small revision index plus one bounded snapshot file per session; treat the index and session files as one locked store.

## Generation threads, backends, and models

Treat a Fruit Truck generation thread as a visible, mode-scoped workspace and execution lane, not as a workflow stage or a separate agent conversation. Give it a short semantic name and free-form `outputRole`; the Workflow Skill decides what those mean. Assets remain session-wide and can feed any image or video thread.

1. Reuse the single default thread for a one-off generation.
2. For independent outputs, send `create_thread` and `update_thread` operations in `session_commit`, including `planStepId` only for an explicit binding.
3. Write the final production prompt directly in each thread; prompt-enhancement tooling is not exposed in the default fast profile.
4. Call `run_generation_threads` once with every ready thread. The call validates the batch atomically and starts all OpenRouter work without an app concurrency cap.
5. Persist the returned attempt IDs and event cursor. Call `task_wait`; `status: pending` means “still pending,” never “submit again.” At terminal status, inspect every attempt before continuing.

Only one attempt may be active inside a thread. A plan step may use several threads, and a thread does not need a plan-step link. Create a blank thread for new work; duplicate only when inheriting the current prompt and settings is intentional.

For a Codex-claimed session, queue the session-scoped `image_generation_backend` UI decision immediately before the first image task and wait with `task_wait`. Reuse the explicit selection for the session.

- `codex_builtin`: `run_generation_threads` returns one host action per image thread. Invoke `$imagegen` for those actions concurrently in the current Codex conversation, then call `register_host_image` with each `threadId` and `attemptId`. If a host action fails, submit a `fail_attempt` operation through `session_commit` with its thread ID, attempt ID, and bounded error text.
- `openrouter`: `run_generation_threads` starts the selected image and video threads in parallel.

Claude Code, Hermes, and unknown hosts use OpenRouter by policy.

For each distinct OpenRouter model requirement, call `list_models`, filter by required inputs, and queue a `model_selection_image` or `model_selection_video` UI decision with two or three compatible candidates. Include related thread IDs for a scoped choice. Await it with `task_wait` and reuse it until incompatible or explicitly changed. Include input structure, constraints, available pricing/range, and one recommendation. Treat `pricing_skus` keys containing `duration_seconds` as per-second rates, not per-clip prices: select an explicitly supported duration and multiply the matching rate by duration and output count. Never advertise or submit a duration missing from `supported_durations`.

## Generate, evaluate, and replan

1. Write an output-specific prompt tied to the thread role and acceptance criteria.
2. Bind only approved compatible inputs.
3. Generate with the chosen backend; poll asynchronous video jobs.
4. Record technical and aesthetic findings with an `evaluate_artifact` commit op. Evaluation is never approval.
5. Queue a Fruit Truck media checkpoint for major sheets, keyframes, shots, batches, and finals.
6. Apply UI feedback and regenerate only the failed artifact unless it exposes a shared reference problem.
7. Let the server complete or reopen explicitly bound steps with the checkpoint transaction. Use `mark_step` only where no typed binding can express the intended semantic change.

A successful API submission is not proof of a successful result. Never duplicate a paid request after a timeout or restart.

## Assemble and finish

For multi-shot video, send a `propose_assembly` operation with approved clips in narrative order and recommended in/out points. It creates the only assembly-review checkpoint; do not add a second decision. Tell the user that the assembly is ready, then wait with `task_wait`. The user may edit ranges/order and presses Render.

After rendering, reread the output, evaluate it, and queue a final Fruit Truck approval. Complete the session only after explicit final approval.

## Pause and recovery

- Honor pause, stop, or Human control immediately.
- Do not launch or foreground Fruit Truck again when its heartbeat is healthy.
- On provider failure, preserve the terminal attempt and retry only with changed conditions or clear rationale. Use `fail_attempt` for a failed host-side action.
- On restart, reread pending decisions, resolutions, thread attempts (including video `jobId` and polling metadata), selected backend/model, and artifact lineage. Await queued attempts by ID; never guess whether an uncertain submission completed.
- On conflict, reread the compact projection and deliberately reapply valid operations at the new revision. Never overwrite the newer snapshot wholesale.

## Tool details

The default installer selects the v2 fast profile. Read [references/mcp-tools.md](references/mcp-tools.md) only for legacy/recovery operations that are not exposed by the fast profile. Read [references/state-invariants.md](references/state-invariants.md) when resuming or repairing state.
