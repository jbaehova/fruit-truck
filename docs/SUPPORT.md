# Support matrix

Fruit Truck is an OpenRouter image/video studio. The matrix below describes
what the desktop app actually sends today; an OpenRouter model appearing in a
catalog does not, by itself, make every OpenRouter endpoint available here.

| Capability | OpenRouter endpoint | Status | Notes |
| --- | --- | --- | --- |
| Text-to-image and image editing | `/api/v1/images` | Supported | Controls and reference slots are limited to the selected model's verified endpoint capabilities. |
| Image partial progress (SSE) | `/api/v1/images` | Endpoint- and combination-gated | Fruit Truck includes `stream: true` only for a definitive streaming endpoint with one text-only output. Multi-output and reference requests stay buffered until OpenRouter exposes or passes a definitive combination contract. |
| Text-to-video | `/api/v1/videos` | Supported | The OpenRouter video-catalog record is authoritative for text-only controls and pricing. Jobs are polled and kept with the session; provider/privacy metadata remains unverified when the catalog supplies no endpoint record. |
| Prompt enhancement | `/api/v1/chat/completions` | Optional, supported | This is a separate planner request, not a general-purpose chat mode. It can send the prompt and supported visual context to the selected planner model. |
| First/last frame images for video | `/api/v1/videos` | Model specific | A declared frame role accepts a managed local image through OpenRouter's normalized media URL contract. This verifies the request protocol, not a paid production result for every model. |
| General image/video/audio references for video | `/api/v1/videos` | Model and transport specific | The selected endpoint or documented rule for the exact model controls media kinds and counts. Unsupported and unknown combinations stay disabled. |
| General chat, Responses, tools/function calling, TTS, STT, audio output, embeddings | Various OpenRouter endpoints | Not exposed | These endpoints are outside the current image/video studio scope. |

Image, video, and audio files can be imported into the local Asset Library for
inspection and reuse where the selected route accepts that kind of input. The
route's live catalog and endpoint declarations take precedence. The public
video catalog does not provide every model's general-reference kinds, counts,
semantic types, or file requirements. Fruit Truck uses dated, documented
rules for the exact model only to fill those missing fields and does not turn unknown
support into an available control.

First and last frames use `frame_images`. General references use
`input_references`, and the two input styles cannot be combined because
OpenRouter gives `frame_images` precedence. Fruit Truck rejects the mixed
request instead of silently dropping the general-reference intent. Managed
local image references can use inline media URLs where the active contract
supports that transport. A managed local video is not treated as a valid
reference unless the selected route explicitly supports its transport.

Current Veo 3.1 Standard and Fast rules accept up to three image references,
all with the fixed native `asset` semantic type. Veo 3.1 Lite accepts no
general references. A user-facing purpose such as style, character, or product
identity is compiled into the prompt only; OpenRouter's video request does not
expose it as a native `reference_type`. These are contract checks, not a claim
that every catalog model has passed a paid production generation test.

Stopping an image response or video polling stops Fruit Truck's local network
work/tracking; it is not presented as provider cancellation. A paid request may
still complete and bill after the local response is stopped. Fruit Truck keeps
that image attempt as uncertain and prevents an automatic duplicate retry;
video status can be checked later with its durable job ID.

## Data-transfer boundary

Credentials, imported media, generated files, and session metadata are kept on
the Mac by default. A generation sends the prompt and the selected reference
files to OpenRouter; OpenRouter may route the request to a downstream provider
whose retention and training policy applies. Prompt enhancement, when enabled,
sends a separate planner request before generation. Review the Request preview
and the provider policies before sending sensitive material.

Zero Data Retention (ZDR) is not a universal guarantee. Video routes may
require temporary retention, and a route that cannot satisfy an enforced ZDR
constraint is blocked. The app reports the selected route's known privacy
constraints; users should not treat local credential storage as local prompt
or media processing.

See the [README](../README.md#supported-capabilities) for the quick-start
summary and [RELEASING.md](./RELEASING.md) for the release gates.
