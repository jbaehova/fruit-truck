import type { PromptProfile, PromptWorkflow } from "./types.ts";

const reviewedAt = "2026-08-18";

const OPENAI_IMAGE_SOURCE = {
  label: "OpenAI GPT Image prompting guide",
  url: "https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide",
  reviewedAt,
};
const OPENAI_IMAGE_API_SOURCE = {
  label: "OpenAI image generation guide",
  url: "https://developers.openai.com/api/docs/guides/image-generation",
  reviewedAt,
};
const SORA_SOURCE = {
  label: "OpenAI Sora 2 prompting guide (historical)",
  url: "https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide",
  reviewedAt,
};
const SORA_API_SOURCE = {
  label: "OpenAI video generation deprecation notice",
  url: "https://developers.openai.com/api/docs/guides/video-generation",
  reviewedAt,
};
const OPENROUTER_IMAGE_SOURCE = {
  label: "OpenRouter image generation",
  url: "https://openrouter.ai/docs/guides/overview/multimodal/image-generation",
  reviewedAt,
};
const OPENROUTER_VIDEO_SOURCE = {
  label: "OpenRouter video generation",
  url: "https://openrouter.ai/docs/guides/overview/multimodal/video-generation",
  reviewedAt,
};

const IMAGE_FALLBACK: PromptProfile = {
  id: "image-generic-v1",
  version: "1.0.0",
  mode: "image",
  structure: "labeled",
  negativePolicy: "inline_constraints",
  referenceSyntax: "image_number",
  motionFocusedImageToVideo: false,
  maxRecommendedBeats: 1,
  guidance: [
    "Describe the visible final result, not a sequence of tool operations.",
    "Bind every reference to a specific subject, style, composition, pose, or context purpose.",
    "For edits, separate requested changes from protected invariants.",
  ],
  sources: [OPENROUTER_IMAGE_SOURCE],
};

const VIDEO_FALLBACK: PromptProfile = {
  id: "video-generic-v1",
  version: "1.0.0",
  mode: "video",
  structure: "labeled",
  negativePolicy: "inline_constraints",
  referenceSyntax: "image_number",
  motionFocusedImageToVideo: true,
  maxRecommendedBeats: 3,
  guidance: [
    "Keep short clips focused on a small number of plausible actions.",
    "For image-to-video, prioritize subject motion, camera motion, and temporal change over restating the input frame.",
    "Bind every reference to the exact property it should influence.",
  ],
  sources: [OPENROUTER_VIDEO_SOURCE],
};

type ProfileEntry = {
  test: (modelId: string) => boolean;
  profile: PromptProfile;
};

const IMAGE_PROFILES: ProfileEntry[] = [
  {
    test: (id) => /^openai\/(?:gpt-image|chatgpt-image)/.test(id),
    profile: {
      ...IMAGE_FALLBACK,
      id: "openai-gpt-image-v1",
      version: "1.0.0",
      structure: "labeled",
      negativePolicy: "inline_constraints",
      guidance: [
        "Use a consistent order: background or scene, subject, important details, then constraints.",
        "For edits, state what changes and repeat every invariant that must remain unchanged.",
        "For multiple references, state exactly what comes from each image and how lighting, perspective, scale, and shadows should integrate.",
        "Keep exact rendered text verbatim and quoted once.",
      ],
      sources: [OPENAI_IMAGE_SOURCE, OPENAI_IMAGE_API_SOURCE],
    },
  },
  {
    test: (id) => /^(?:google|google-ai-studio)\/(?:gemini|imagen|nano-banana)/.test(id),
    profile: {
      ...IMAGE_FALLBACK,
      id: "google-image-v1",
      version: "1.0.0",
      structure: "prose",
      negativePolicy: "separate_field",
      guidance: [
        "Describe the scene in natural language rather than listing disconnected keywords.",
        "For semantic edits, make the requested change narrow and keep the rest exactly unchanged.",
        "Name what each reference contributes, especially identity, logo, style, composition, or pose.",
      ],
      sources: [{
        label: "Google Gemini image generation",
        url: "https://ai.google.dev/gemini-api/docs/image-generation",
        reviewedAt,
      }],
    },
  },
  {
    test: (id) => /^black-forest-labs\/(?:flux|kontext)/.test(id),
    profile: {
      ...IMAGE_FALLBACK,
      id: "bfl-flux-image-v1",
      version: "1.0.0",
      structure: "compact",
      negativePolicy: "positive_rewrite",
      guidance: [
        "Use Subject, Action, Style, and Context with concrete visible outcomes.",
        "Rewrite exclusions as the desired positive final state.",
        "For multiple references, describe the distinct role of every input.",
      ],
      sources: [{
        label: "Black Forest Labs FLUX.2 prompting guide",
        url: "https://docs.bfl.ai/guides/prompting_guide_flux2",
        reviewedAt,
      }],
    },
  },
  {
    test: (id) => /^(?:bytedance|byteplus)\/seedream/.test(id),
    profile: {
      ...IMAGE_FALLBACK,
      id: "bytedance-seedream-image-v1",
      version: "1.0.0",
      structure: "labeled",
      negativePolicy: "inline_constraints",
      guidance: [
        "Separate the core subject, requested edit, layout, and exact text.",
        "In multi-image work, identify the subject and contribution from each numbered image.",
        "Use visible identity invariants instead of absolute fidelity claims.",
      ],
      sources: [{
        label: "BytePlus Seedream 4.0-4.5 prompt guide",
        url: "https://docs.byteplus.com/en/docs/modelark/1829186",
        reviewedAt,
      }],
    },
  },
];

const VIDEO_PROFILES: ProfileEntry[] = [
  {
    test: (id) => /^bytedance\/seedance-/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "bytedance-seedance-video-v1",
      version: "1.0.0",
      structure: "shot_blocks",
      negativePolicy: "inline_constraints",
      maxRecommendedBeats: 5,
      guidance: [
        "Assign every image, video, and audio reference a concrete role such as character, scene, prop, composition, motion rhythm, or sound.",
        "Separate appearance borrowed from a reference video from motion-only guidance.",
        "Use ordered shot blocks only when the request genuinely needs multiple shots.",
      ],
      sources: [{
        label: "ByteDance Seedance 2.0 launch",
        url: "https://seed.bytedance.com/blog/seedance-2-0-official-launch",
        reviewedAt,
      }, OPENROUTER_VIDEO_SOURCE],
    },
  },
  {
    test: (id) => /^google\/veo-/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "google-veo-video-v1",
      version: "1.0.0",
      structure: "labeled",
      negativePolicy: "separate_field",
      maxRecommendedBeats: 4,
      guidance: [
        "Include subject, action, style, camera, composition, ambience, and audio only when relevant.",
        "Keep asset references distinct from exact first or last frame anchors.",
        "For first-and-last-frame generation, focus on a plausible transition and continuity.",
      ],
      sources: [{
        label: "Google Veo video generation",
        url: "https://ai.google.dev/gemini-api/docs/video",
        reviewedAt,
      }],
    },
  },
  {
    test: (id) => /^runway\/(?:gen-|aleph)/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "runway-video-v1",
      version: "1.0.0",
      structure: "compact",
      negativePolicy: "positive_rewrite",
      referenceSyntax: "runway_image_number",
      maxRecommendedBeats: 3,
      guidance: [
        "Use full sentences and positive descriptions of visible motion.",
        "For image-to-video, let the input image define appearance, composition, lighting, and style; focus the prompt on motion and camera behavior.",
        "Avoid motion that conflicts with motion already implied by the source image.",
      ],
      sources: [{
        label: "Runway image-to-video prompting guide",
        url: "https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide",
        reviewedAt,
      }, {
        label: "Runway Gen-4 video prompting guide",
        url: "https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide",
        reviewedAt,
      }],
    },
  },
  {
    test: (id) => /^alibaba\/wan-/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "alibaba-wan-video-v1",
      version: "1.0.0",
      structure: "shot_blocks",
      negativePolicy: "inline_constraints",
      maxRecommendedBeats: 5,
      guidance: [
        "Use media-kind-specific numbered references and directly connect each identifier to a subject or role.",
        "Organize the result around action, scene, dialogue, sound effects, and background music as supported.",
        "Do not rely on provider prompt extension on top of Fruit Truck enhancement without an explicit experiment.",
      ],
      sources: [{
        label: "Alibaba Wan text-to-video prompt guide",
        url: "https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt",
        reviewedAt,
      }],
    },
  },
  {
    test: (id) => /^minimax\/hailuo-/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "minimax-hailuo-video-v1",
      version: "1.0.0",
      structure: "compact",
      negativePolicy: "inline_constraints",
      maxRecommendedBeats: 3,
      guidance: [
        "For text-to-video, combine subject, scene, and motion or change.",
        "For image-to-video, prioritize the referenced subject and motion, adding camera or aesthetic detail only when needed.",
        "Use a dedicated subject reference path for character fidelity when the endpoint exposes it.",
      ],
      sources: [{
        label: "MiniMax video prompt guide",
        url: "https://platform.minimaxi.com/docs/guides/video-prompt",
        reviewedAt,
      }],
    },
  },
  {
    test: (id) => /^x-ai\/grok-imagine-video/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "xai-grok-video-v1",
      version: "1.0.0",
      structure: "labeled",
      negativePolicy: "inline_constraints",
      maxRecommendedBeats: 4,
      guidance: [
        "For image-to-video, keep the result source-faithful while specifying motion, camera, atmosphere, and physics.",
        "For reference-to-video, assign subject, object, clothing, or style roles without treating references as fixed first frames.",
      ],
      sources: [{
        label: "xAI video generation",
        url: "https://docs.x.ai/developers/model-capabilities/video/generation",
        reviewedAt,
      }],
    },
  },
  {
    test: (id) => /^openai\/sora-/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "openai-sora-video-v1",
      version: "1.0.0",
      structure: "shot_blocks",
      negativePolicy: "inline_constraints",
      maxRecommendedBeats: 4,
      guidance: [
        "This compatibility profile is deprecated and scheduled for shutdown on 2026-09-24; never select it as an automatic default.",
        "Use camera framing, depth of field, action beats, lighting and palette, and distinctive subject anchors.",
        "Prefer one plausible action in a short clip and separate genuinely different shots into blocks.",
        "Keep duration, resolution, and other container parameters out of prompt prose.",
      ],
      sources: [SORA_API_SOURCE, SORA_SOURCE],
    },
  },
  {
    test: (id) => /^black-forest-labs\/flux-.*video/.test(id),
    profile: {
      ...VIDEO_FALLBACK,
      id: "bfl-flux-video-v1",
      version: "1.0.0",
      structure: "compact",
      negativePolicy: "positive_rewrite",
      maxRecommendedBeats: 3,
      guidance: [
        "Describe the desired end state and visible temporal change rather than a tool process.",
        "Use positive final-state language and keep motion instructions concise.",
      ],
      sources: [OPENROUTER_VIDEO_SOURCE],
    },
  },
];

export function promptProfileForModel(mode: "image" | "video", modelId: string): PromptProfile {
  const entries = mode === "image" ? IMAGE_PROFILES : VIDEO_PROFILES;
  return entries.find((entry) => entry.test(modelId))?.profile ?? (mode === "image" ? IMAGE_FALLBACK : VIDEO_FALLBACK);
}

export function profileInstruction(profile: PromptProfile, workflow: PromptWorkflow): string {
  return [
    `Target prompt profile: ${profile.id}@${profile.version}.`,
    `Resolved workflow: ${workflow}.`,
    ...profile.guidance,
    profile.motionFocusedImageToVideo && workflow === "image_to_video"
      ? "Do not spend the prompt budget re-describing static details already supplied by the first-frame image unless the user explicitly changes them."
      : "",
  ].filter(Boolean).join(" ");
}
