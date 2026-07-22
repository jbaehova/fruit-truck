import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { DraftOptions, GenerationMode, GenerationModel, ImageModel, VideoModel } from "@/openrouter";

type Props = {
  mode: GenerationMode;
  model: GenerationModel | null;
  options: DraftOptions;
  providerJson: string;
  providerError: string | null;
  onOptionsChange: (options: DraftOptions) => void;
  onProviderJsonChange: (value: string) => void;
};

const LABELS: Record<string, string> = {
  resolution: "Resolution",
  aspect_ratio: "Aspect ratio",
  size: "Size",
  quality: "Quality",
  output_format: "Format",
  background: "Background",
  n: "Outputs",
  duration: "Duration",
  generate_audio: "Generate audio",
  output_compression: "Compression",
};

function EnumField({ name, values, value, onChange }: { name: string; values: Array<string | number>; value: unknown; onChange: (value: string | number) => void }) {
  const stringValue = value == null ? "" : String(value);
  return (
    <label className="option-field">
      <span>{LABELS[name] ?? name.replaceAll("_", " ")}</span>
      <Select value={stringValue} onValueChange={(next) => {
        if (next == null) return;
        const original = values.find((item) => String(item) === next);
        onChange(original ?? next);
      }}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{values.map((item) => <SelectItem value={String(item)} key={String(item)}>{name === "duration" ? `${item} sec` : String(item)}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
}

export function OptionsFields({ mode, model, options, providerJson, providerError, onOptionsChange, onProviderJsonChange }: Props) {
  const [advanced, setAdvanced] = useState(false);
  if (!model) return null;
  const patch = (name: string, value: string | number | boolean) => onOptionsChange({ ...options, [name]: value });
  const basic: React.ReactNode[] = [];
  const advancedFields: React.ReactNode[] = [];

  if (mode === "image") {
    const image = model as ImageModel;
    for (const [name, descriptor] of Object.entries(image.supported_parameters)) {
      if (["input_references", "stream"].includes(name)) continue;
      if (descriptor.type === "enum" && descriptor.values?.length) {
        const field = <EnumField key={name} name={name} values={descriptor.values} value={options[name]} onChange={(value) => patch(name, value)} />;
        (name === "output_format" || name === "background" ? advancedFields : basic).push(field);
      } else if (descriptor.type === "range") {
        const field = (
          <label className="option-field" key={name}>
            <span>{LABELS[name] ?? name.replaceAll("_", " ")}</span>
            <Input type="number" min={descriptor.min} max={descriptor.max} value={Number(options[name] ?? descriptor.min ?? 0)} onChange={(event) => patch(name, Number(event.target.value))} />
          </label>
        );
        (name === "n" ? basic : advancedFields).push(field);
      } else if (descriptor.type === "boolean" && name === "seed") {
        advancedFields.push(
          <label className="option-field" key={name}>
            <span>Seed</span>
            <Input type="number" placeholder="Random" value={options.seed == null ? "" : Number(options.seed)} onChange={(event) => onOptionsChange({ ...options, seed: event.target.value ? Number(event.target.value) : undefined })} />
          </label>,
        );
      }
    }
  } else {
    const video = model as VideoModel;
    if (video.supported_durations?.length) basic.push(<EnumField key="duration" name="duration" values={video.supported_durations} value={options.duration} onChange={(value) => patch("duration", value)} />);
    if (video.supported_resolutions?.length) basic.push(<EnumField key="resolution" name="resolution" values={video.supported_resolutions} value={options.resolution} onChange={(value) => patch("resolution", value)} />);
    if (video.supported_aspect_ratios?.length) basic.push(<EnumField key="aspect_ratio" name="aspect_ratio" values={video.supported_aspect_ratios} value={options.aspect_ratio} onChange={(value) => patch("aspect_ratio", value)} />);
    if (video.supported_sizes?.length) advancedFields.push(<EnumField key="size" name="size" values={video.supported_sizes} value={options.size} onChange={(value) => patch("size", value)} />);
    if (video.generate_audio) basic.push(
      <label className="option-toggle" key="audio"><span><strong>Generate audio</strong><small>Include model-generated sound</small></span><Switch checked={Boolean(options.generate_audio)} onCheckedChange={(value) => patch("generate_audio", value)} /></label>,
    );
    if (video.seed) advancedFields.push(
      <label className="option-field" key="seed"><span>Seed</span><Input type="number" placeholder="Random" value={options.seed == null ? "" : Number(options.seed)} onChange={(event) => onOptionsChange({ ...options, seed: event.target.value ? Number(event.target.value) : undefined })} /></label>,
    );
  }

  return (
    <div className="options-section">
      <div className="section-label-row"><span className="section-label">Output options</span><small>Only supported fields</small></div>
      {basic.length ? <div className="options-grid">{basic}</div> : <p className="empty-options">This model exposes no standard output controls.</p>}
      <button type="button" className={`advanced-toggle ${advanced ? "open" : ""}`} onClick={() => setAdvanced((value) => !value)}>
        <span><SlidersHorizontal /> Advanced</span><ChevronDown />
      </button>
      {advanced ? (
        <div className="advanced-content">
          {advancedFields.length ? <div className="options-grid">{advancedFields}</div> : null}
          <label className="provider-json">
            <span>Provider routing &amp; options</span>
            <Textarea
              rows={5}
              spellCheck={false}
              value={providerJson}
              placeholder={'{\n  "order": ["provider-slug"],\n  "options": {}\n}'}
              onChange={(event) => onProviderJsonChange(event.target.value)}
              aria-invalid={Boolean(providerError)}
            />
            <small className={providerError ? "field-error" : ""}>{providerError ?? "Passed through as the provider object."}</small>
          </label>
        </div>
      ) : null}
    </div>
  );
}
