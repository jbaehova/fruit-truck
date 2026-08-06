import type { MaskStroke } from "@/studio";

function drawStroke(
  context: CanvasRenderingContext2D,
  stroke: MaskStroke,
  width: number,
  height: number,
) {
  if (!stroke.points.length) return;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.size * Math.min(width, height);
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x * width, first.y * height, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(first.x * width, first.y * height);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x * width, point.y * height);
  }
  context.stroke();
}

export function renderSelectionMask(
  context: CanvasRenderingContext2D,
  strokes: MaskStroke[],
  width: number,
  height: number,
) {
  context.clearRect(0, 0, width, height);
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.operation === "erase" ? "destination-out" : "source-over";
    context.fillStyle = "#fff";
    context.strokeStyle = "#fff";
    drawStroke(context, stroke, width, height);
  }
  context.globalCompositeOperation = "source-over";
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    if (/^https?:/i.test(source)) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The edit image could not be loaded for masking."));
    image.src = source;
  });
}

export async function applyAlphaMaskBlob(source: string, strokes: MaskStroke[]): Promise<Blob> {
  if (!strokes.some((stroke) => stroke.operation !== "erase")) {
    const response = await fetch(source);
    if (!response.ok) throw new Error("The edit image could not be loaded for masking.");
    return response.blob();
  }
  const image = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The edit mask canvas is unavailable.");
  context.drawImage(image, 0, 0);
  const mask = document.createElement("canvas");
  mask.width = canvas.width;
  mask.height = canvas.height;
  const maskContext = mask.getContext("2d");
  if (!maskContext) throw new Error("The edit mask could not be prepared.");
  renderSelectionMask(maskContext, strokes, mask.width, mask.height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(mask, 0, 0);
  context.globalCompositeOperation = "source-over";
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The edit image could not be converted into a mask-ready PNG."));
      }, "image/png");
    } catch {
      reject(new Error("The edit image could not be converted into a mask-ready PNG."));
    }
  });
}

export function promptGuideDimensions(width: number, height: number, maxEdge = 1536) {
  if (width <= 0 || height <= 0 || maxEdge <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function renderMaskGuide(source: string, strokes: MaskStroke[]): Promise<string> {
  const image = await loadImage(source);
  const dimensions = promptGuideDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The edit mask guide canvas is unavailable.");
  context.drawImage(image, 0, 0);

  const overlay = document.createElement("canvas");
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  const overlayContext = overlay.getContext("2d");
  if (!overlayContext) throw new Error("The edit mask guide could not be prepared.");
  renderSelectionMask(overlayContext, strokes, overlay.width, overlay.height);
  overlayContext.globalCompositeOperation = "source-in";
  overlayContext.fillStyle = "#ff2851";
  overlayContext.fillRect(0, 0, overlay.width, overlay.height);
  overlayContext.globalCompositeOperation = "source-over";

  context.globalAlpha = 0.58;
  context.drawImage(overlay, 0, 0);
  context.globalAlpha = 1;
  try {
    return canvas.toDataURL("image/webp", 0.88);
  } catch {
    throw new Error("The edit mask guide could not be encoded.");
  }
}

export function hasGenerationInstructions({
  prompt,
  hasMask,
  maskInstructions,
}: {
  prompt: string;
  hasMask: boolean;
  maskInstructions: string;
}) {
  return Boolean(prompt.trim() || (hasMask && maskInstructions.trim()));
}

export function composeEditPrompt({
  prompt,
  target,
  hasMask,
  maskInstructions,
}: {
  prompt: string;
  target: string;
  hasMask: boolean;
  maskInstructions: string;
}) {
  const sections = [
    "[EDIT TASK]",
    `Target image: ${target}`,
    "Use every other numbered input only as a reference.",
  ];
  if (hasMask) {
    sections.push(
      "",
      "[MASK SEMANTICS]",
      `Transparent pixels in ${target} are a coarse semantic selection cue, not a shape to reproduce. Infer the intended existing subject or part, preserve its anatomy, geometry, texture, lighting, and depth, and change only the requested attribute. Expand, contract, or softly blend the selection to nearby natural subject boundaries when needed. Never create a new object that follows the brush-stroke silhouette. Preserve unrelated content outside the selected subject as closely as possible.`,
      "",
      "[MASK INSTRUCTIONS]",
      maskInstructions.trim() || "Apply the user prompt inside the selected region.",
    );
  }
  if (prompt.trim()) sections.push("", "[USER PROMPT]", prompt.trim());
  return sections.join("\n");
}
