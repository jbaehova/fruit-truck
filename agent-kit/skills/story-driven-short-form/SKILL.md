---
name: story-driven-short-form
description: Add story-driven short-form video expertise to a Fruit Truck Agent production, including beats, continuity sheets, keyframes, short shot generation, and final crop/merge. Use with fruit-truck-agent for reels, shorts, social films, micro-narratives, or any multi-shot video whose story must land in a brief total duration.
---

# Story-driven Short-form

Compose this Workflow Skill with `fruit-truck-agent`; follow the Core Skill for state, model choice, approvals, safety, lineage, and execution.

## Plan the story

Derive a compact beat sequence from the user's message rather than defaulting to a fixed scene count:

1. orient the viewer;
2. introduce desire, tension, or change;
3. reveal the key action or subject;
4. land the emotional, product, or narrative payoff.

Merge beats when duration is short. Add a beat only when it changes information or emotion.

Propose shot count, shot duration, composition, camera movement, lighting, and color autonomously. When one changes a user-owned identity, required story event, or hard distribution constraint, queue a chat decision and resolve only from the user's reply.

Choose generation durations only from the selected video model's live `supported_durations`. When the desired editorial beat is shorter than the minimum generation duration, generate the nearest supported duration and set shorter in/out points during final assembly.

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

1. Queue any needed story/relationship choice and ask in chat.
2. Represent the story procedure in the generic plan using names appropriate to this production; do not expect Fruit Truck to provide built-in story stages.
3. Create one image thread per independent consistency sheet, prepare them, and run the ready threads together. Request their approval in Fruit Truck.
4. Create one image thread per meaningful storyboard/keyframe candidate and run independent candidates in parallel.
5. Queue and await Fruit Truck approval of major keyframes.
6. Request and await the Fruit Truck video-model choice immediately before first motion generation.
7. Create one video thread per approved shot, bind the approved frame/reference assets, and run ready shots in parallel. Prefer one clear movement or camera idea per shot.
8. Evaluate technical quality, aesthetic finish, story readability, and continuity separately.
9. Revise only the failed thread unless the failure exposes a shared reference or direction problem.

## Assemble

Recommend usable in/out points that remove generation warm-up, terminal drift, frozen tails, or unstable frames. The desktop user configures clips in narrative order and renders them from `최종 영상 만들기`.

Queue the merged video as a Fruit Truck media checkpoint and await approval before calling it final.
