---
name: story-driven-short-form
description: Add story-driven short-form video expertise to an Oppa Gen Agent production, including beats, continuity sheets, keyframes, short shot generation, and final crop/merge. Use with oppa-gen-agent for reels, shorts, social films, micro-narratives, or any multi-shot video whose story must land in a brief total duration.
---

# Story-driven Short-form

Compose this Workflow Skill with `oppa-gen-agent`; follow the Core Skill for state, model choice, approvals, safety, lineage, and execution.

## Plan the story

Derive a compact beat sequence from the user's message rather than defaulting to a fixed scene count:

1. orient the viewer;
2. introduce desire, tension, or change;
3. reveal the key action or subject;
4. land the emotional, product, or narrative payoff.

Merge beats when duration is short. Add a beat only when it changes information or emotion.

Propose shot count, shot duration, composition, camera movement, lighting, and color as autonomous plan decisions. When one changes a user-owned identity, required story event, or hard distribution constraint, queue a structured decision, ask in agent chat, and resolve only from the user's reply.

## Preserve continuity

Detect recurring people, characters, products, outfits, props, logos, and locations. Plan the smallest useful character, product, or environment sheets before keyframes.

For each shot record:

- narrative function;
- subjects and required identity features;
- opening composition and intended motion;
- continuity from the previous shot;
- target duration;
- keyframe inputs required by compatible models;
- acceptance criteria.

Do not hide continuity problems behind rapid cuts. Reject a shot when identity, screen direction, product form, or essential lighting logic breaks.

## Generate in stages

1. Queue any needed overall beat/visual-direction choice and ask in chat.
2. Create consistency sheets and request their approval in chat.
3. Create storyboard/keyframe candidates for every meaningful beat.
4. Queue and resolve chat approval of major keyframes.
5. Request and resolve the chat video-model choice immediately before first motion generation.
6. Generate short shots; prefer one clear movement or camera idea per shot.
7. Evaluate technical quality, aesthetic finish, story readability, and continuity separately.
8. Revise only the failed shot unless the failure exposes a shared reference or direction problem.

## Assemble

Recommend usable in/out points that remove generation warm-up, terminal drift, frozen tails, or unstable frames. The desktop user configures clips in narrative order and renders them from `최종 영상 만들기`.

Queue the merged video as a final checkpoint, ask in chat, and resolve the user's approval before calling it final.
