---
name: open-gen-ui-agent
description: Orchestrate resumable image and video production through OpenGen UI, collecting every session decision in the current agent chat. Use when a local Codex, Claude Code, or Hermes agent must plan, generate, evaluate, revise, or continue media work through the OpenGen UI MCP server.
---

# OpenGen UI Agent

Turn intent into a durable production session. The agent plans, asks, evaluates, and executes. OpenGen UI stores state and media, while the user answers creative choices, model selections, feedback, approvals, and Custom Skill changes in this chat.

## Connect or resume

1. Call `list_sessions` and `get_session` when the user refers to existing work.
2. For new work, call `create_session`, then `claim_session` before planning or execution.
3. Keep facts, user decisions, agent assumptions, and Skill defaults distinct.
4. Treat desktop and MCP as concurrent writers. On a revision conflict, reread and merge before retrying.
5. Before other work, inspect pending blocking decisions. If the current user message answers one, resolve it; otherwise present the pending question again.

## Ask every session decision in chat

For every user-owned choice:

1. Choose a stable, session-unique `requestKey` for the checkpoint, then call `queue_decision`, `request_model_selection`, or `request_custom_skill_activation`; reuse the same key when retrying. For the session-scoped backend choice, call `request_image_backend_selection`, which is idempotent without a key.
2. Present two or three concise numbered options in this chat, including one recommendation when useful.
3. End the turn and wait for the user's reply. Do not poll `await_decision`.
4. On the next turn, call `resolve_decision` with the exact user reply in `userResponse`, the matching `optionId`, and any useful note or newly imported asset IDs.
5. Continue automatically after the resolution is stored.

Never resolve a choice from your own recommendation or an ambiguous reply. A pending decision survives app closure, agent interruption, and restart.

Use blocking chat decisions for material ambiguity, uploads only the user can provide, model selection, major image/keyframe/video/final approval, expensive batches, abnormal retries, and Custom Skill changes.

For an upload, ask the user to add files through OpenGen UI Assets/InputTray. After the user confirms in chat, reread the session and attach the new asset IDs when resolving the upload decision.

## Build the production graph

Use `replace_plan` for a content-dependent dependency graph and `set_step_status` for meaningful transitions. Only one step may be active, and a blocking pending decision stops execution.

Detect prerequisite assets:

- recurring people or characters → identity/character sheet;
- products, logos, packaging, or props → product/detail sheet;
- recurring locations → environment reference;
- multi-shot video → storyboard and approved keyframes;
- model-specific frame inputs → compatible start/end/reference frames.

## Choose the image backend

This choice applies only when the claimed session reports `connection.agentHost: codex`.

Immediately before the session's first image generation or edit:

1. Call `request_image_backend_selection`.
2. Present its `Codex built-in image generation` and `OpenRouter image generation` options in chat.
3. Resolve the explicit reply with `resolve_decision`.
4. Reuse the stored backend for the rest of the session. Call with `reselect: true` only when the user explicitly asks to switch.

Claude Code, Hermes, and unknown hosts use OpenRouter by policy and never ask this question. Human-driven desktop generation also uses OpenRouter.

When `codex_builtin` is selected:

1. Use `$imagegen` for every image generation or edit.
2. For a local edit target, inspect its managed `localPath` with `view_image` before invoking imagegen.
3. Preserve source images and include every input asset in `parentAssetIds`.
4. Pass the generated output path to `register_host_image`; do not leave session media only under the Codex generated-images directory.
5. Evaluate and request approval in chat like any other artifact.

If Codex image generation fails or is unavailable, record the error and ask whether to reselect OpenRouter. Never switch silently.

When `openrouter` is selected, follow the model-selection and `submit_generation` flow below.

## Select OpenRouter models

For image and video stages independently:

1. Call `list_models` immediately before first use.
2. Filter by current inputs and capabilities.
3. Compare compatible candidates by input structure, result character, constraints, price when available, and likely latency.
4. Call `request_model_selection`, present the candidates in chat, and resolve the user's reply.
5. Reuse the recorded model until it becomes incompatible or the user asks to change it.

## Generate, evaluate, and replan

1. Write a stage-specific prompt tied to the agreed role and acceptance criteria.
2. Map approved inputs to the selected route.
3. For OpenRouter, call `submit_generation`; use `poll_video` for asynchronous video jobs.
4. Use `register_asset` for uploaded or external derivatives and `register_host_image` only for Codex built-in output.
5. Use `evaluate_asset` for technical defects, aesthetic finish, identity/continuity, and a recommendation.
6. Queue approval, show the relevant asset in OpenGen UI when useful, and resolve the user's chat reply.
7. Replan from evidence. Successful submission is not proof of a successful result.

Preserve source assets. Session JSON stores managed `localPath` metadata, never Base64 or data URLs.

## Produce multi-shot video

Plan short shots and continuity constraints unless one continuous generation is explicitly required. Generate and approve keyframes before motion, then evaluate shots independently.

The user still configures and renders final clips in OpenGen UI's `Make final video` window. Ask them in chat to complete that direct manipulation, reread the resulting artifact, then request final approval in chat.

## Pause, recover, and hand over

- Honor pause, stop, or Human control immediately.
- On failure, record the error and a concrete recovery option.
- On restart, reread pending decisions, completed resolutions, jobs, and the selected image backend before acting.
- Never duplicate work because a request, poll, or chat turn ended.

## Custom Skills

`propose_custom_skill` creates a text-only proposal and a blocking chat approval. Give it a stable `requestKey`, present a concise summary plus save/reject options, and reuse that key after interruption. `resolve_decision` saves, versions, and activates an approved proposal for the current session.

Use `request_custom_skill_activation` to activate or deactivate an existing Skill only after explicit chat confirmation. Settings remains available for manual import, inspection, and rollback.

Custom Skills must not contain binary media, asset/session IDs, local paths, secrets, inferred sensitive data, or unjustified one-off generalizations.

Precedence:

1. current explicit user instruction;
2. user Custom Skill;
3. activated Workflow/Domain Skill;
4. Core defaults.

## Tool details

Read [references/mcp-tools.md](references/mcp-tools.md) before the first execution call. Read [references/state-invariants.md](references/state-invariants.md) when resuming or repairing state.
