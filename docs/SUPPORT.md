# Support matrix

Fruit Truck is an OpenRouter image/video studio. The matrix below describes
what the desktop app actually sends today; an OpenRouter model appearing in a
catalog does not, by itself, make every OpenRouter endpoint available here.

| Capability | OpenRouter endpoint | Status | Notes |
| --- | --- | --- | --- |
| Text-to-image and image editing | `/api/v1/images` | Supported | Controls and reference slots are limited to the selected model's verified endpoint capabilities. |
| Image partial progress (SSE) | `/api/v1/images` | Endpoint-gated | Fruit Truck includes `stream: true` in the reviewed request only when the selected definitive endpoint declares streaming, consumes bounded SSE, and records partial progress. |
| Text-to-video | `/api/v1/videos` | Supported | The request must satisfy the selected model and endpoint contract. Jobs are polled and kept with the session. |
| Prompt enhancement | `/api/v1/chat/completions` | Optional, supported | This is a separate planner request, not a general-purpose chat mode. It can send the prompt and supported visual context to the selected planner model. |
| Image/video/audio references for video | `/api/v1/videos` | Unavailable unless transport is verified | Local files cannot be assumed to work as provider references. Fruit Truck keeps these controls closed until a verified public HTTPS or signed-upload transport and endpoint capability are available. |
| General chat, Responses, tools/function calling, TTS, STT, audio output, embeddings | Various OpenRouter endpoints | Not exposed | These endpoints are outside the current image/video studio scope. |

Image, video, and audio files can be imported into the local Asset Library for
inspection and reuse where the selected route accepts that kind of input. The
route's live metadata and Fruit Truck's request validator are authoritative;
direct-provider documentation is not enough to mark an OpenRouter route as
supported.

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
