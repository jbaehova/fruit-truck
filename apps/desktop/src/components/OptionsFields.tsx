import { Collapsible } from "@base-ui/react/collapsible";
import { Field } from "@base-ui/react/field";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useI18n, type MessageKey } from "@/i18n";
import type { DraftOptions, GenerationMode, GenerationModel, ImageModel, VideoModel } from "@/openrouter";
import { normalizeRangeValue } from "@/optionValues";

type Props = {
  mode: GenerationMode;
  model: GenerationModel | null;
  options: DraftOptions;
  providerJson: string;
  providerError: string | null;
  onOptionsChange: (options: DraftOptions) => void;
  onProviderJsonChange: (value: string) => void;
};

const LABEL_KEYS: Record<string, MessageKey> = {
  resolution: "resolution",
  aspect_ratio: "aspectRatio",
  size: "size",
  quality: "quality",
  output_format: "format",
  background: "background",
  n: "outputs",
  duration: "duration",
  generate_audio: "generateAudio",
  output_compression: "compression",
};

function EnumField({ name, values, value, onChange }: { name: string; values: Array<string | number>; value: unknown; onChange: (value: string | number) => void }) {
  const { t } = useI18n();
  const stringValue = value == null ? "" : String(value);
  return (
    <Field.Root className="option-field">
      <Field.Label className="option-field-label" nativeLabel={false} render={<div />}>{LABEL_KEYS[name] ? t(LABEL_KEYS[name]) : name.replaceAll("_", " ")}</Field.Label>
      <Select value={stringValue} onValueChange={(next) => {
        if (next == null) return;
        const original = values.find((item) => String(item) === next);
        onChange(original ?? next);
      }}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{values.map((item) => <SelectItem value={String(item)} key={String(item)}>{name === "duration" ? t("seconds", { value: item }) : String(item)}</SelectItem>)}</SelectContent>
      </Select>
    </Field.Root>
  );
}

export function OptionsFields({ mode, model, options, providerJson, providerError, onOptionsChange, onProviderJsonChange }: Props) {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useState(false);
  if (!model) return null;
  const patch = (name: string, value: string | number | boolean) => onOptionsChange({ ...options, [name]: value });
  const basic: React.ReactNode[] = [];
  const advancedFields: React.ReactNode[] = [];
  const providerParameter = (providerSlug: string, name: string) => {
    try {
      const root = JSON.parse(providerJson || "{}") as { options?: Record<string, { parameters?: Record<string, unknown> }> };
      return root.options?.[providerSlug]?.parameters?.[name];
    } catch { return undefined; }
  };
  const patchProviderParameter = (providerSlug: string, name: string, value: unknown) => {
    let root: { options?: Record<string, { parameters?: Record<string, unknown> }>; [key: string]: unknown } = {};
    try { root = JSON.parse(providerJson || "{}") as typeof root; } catch { /* Replace invalid JSON through the validated control. */ }
    root.options = { ...(root.options ?? {}) };
    const current = root.options[providerSlug] ?? {};
    root.options[providerSlug] = { ...current, parameters: { ...(current.parameters ?? {}), [name]: value } };
    onProviderJsonChange(JSON.stringify(root, null, 2));
  };

  if (mode === "image") {
    const image = model as ImageModel;
    for (const [name, descriptor] of Object.entries(image.supported_parameters)) {
      if (["input_references", "stream"].includes(name)) continue;
      if (descriptor.type === "enum" && descriptor.values?.length) {
        const field = <EnumField key={name} name={name} values={descriptor.values} value={options[name]} onChange={(value) => patch(name, value)} />;
        (name === "output_format" || name === "background" ? advancedFields : basic).push(field);
      } else if (descriptor.type === "range") {
        const field = (
          <Field.Root className="option-field" key={name}>
            <Field.Label>{LABEL_KEYS[name] ? t(LABEL_KEYS[name]) : name.replaceAll("_", " ")}</Field.Label>
            <Input
              type="number"
              min={descriptor.min}
              max={descriptor.max}
              value={options[name] == null ? "" : Number(options[name])}
              onChange={(event) => onOptionsChange({
                ...options,
                [name]: normalizeRangeValue(event.target.value, descriptor.min, descriptor.max),
              })}
            />
          </Field.Root>
        );
        (name === "n" ? basic : advancedFields).push(field);
      } else if (descriptor.type === "boolean" && name === "seed") {
        advancedFields.push(
          <Field.Root className="option-field" key={name}>
            <Field.Label>{t("seed")} ({t("optional")})</Field.Label>
            <Input type="number" placeholder={t("random")} value={options.seed == null ? "" : Number(options.seed)} onChange={(event) => onOptionsChange({ ...options, seed: event.target.value ? Number(event.target.value) : undefined })} />
            <Field.Description>{t("seedHint")}</Field.Description>
          </Field.Root>,
        );
      }
    }
  } else {
    const video = model as VideoModel;
    if (video.supported_durations?.length) basic.push(<EnumField key="duration" name="duration" values={video.supported_durations} value={options.duration} onChange={(value) => patch("duration", value)} />);
    if (video.supported_resolutions?.length) basic.push(<EnumField key="resolution" name="resolution" values={video.supported_resolutions} value={options.resolution} onChange={(value) => patch("resolution", value)} />);
    if (video.supported_aspect_ratios?.length) basic.push(<EnumField key="aspect_ratio" name="aspect_ratio" values={video.supported_aspect_ratios} value={options.aspect_ratio} onChange={(value) => patch("aspect_ratio", value)} />);
    if (video.generate_audio) basic.push(
      <Field.Root className="option-toggle" key="audio"><span><Field.Label nativeLabel={false} render={<div />}><strong>{t("generateAudio")}</strong></Field.Label><Field.Description>{t("includeSound")}</Field.Description></span><Switch checked={Boolean(options.generate_audio)} onCheckedChange={(value) => patch("generate_audio", value)} /></Field.Root>,
    );
    if (video.seed) advancedFields.push(
      <Field.Root className="option-field" key="seed"><Field.Label>{t("seed")} ({t("optional")})</Field.Label><Input type="number" placeholder={t("random")} value={options.seed == null ? "" : Number(options.seed)} onChange={(event) => onOptionsChange({ ...options, seed: event.target.value ? Number(event.target.value) : undefined })} /><Field.Description>{t("seedHint")}</Field.Description></Field.Root>,
    );
    if (video.allowed_passthrough_parameters?.includes("personGeneration")) advancedFields.push(
      <Field.Root className="option-field" key="personGeneration">
        <Field.Label>{t("personGeneration")}</Field.Label>
        <Select value={String(providerParameter("google-vertex", "personGeneration") ?? "allow_adult")} onValueChange={(value) => value && patchProviderParameter("google-vertex", "personGeneration", value)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="allow_adult">{t("allowAdults")}</SelectItem><SelectItem value="disallow">{t("disallowPeople")}</SelectItem></SelectContent>
        </Select>
        <Field.Description>{t("personGenerationHint")}</Field.Description>
      </Field.Root>,
    );
    if (video.allowed_passthrough_parameters?.includes("contentModeration")) advancedFields.push(
      <Field.Root className="option-field" key="publicFigureThreshold">
        <Field.Label>{t("publicFigureModeration")}</Field.Label>
        <Select value={String((providerParameter("runway", "contentModeration") as { publicFigureThreshold?: string } | undefined)?.publicFigureThreshold ?? "auto")} onValueChange={(value) => value && patchProviderParameter("runway", "contentModeration", { publicFigureThreshold: value })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="auto">{t("automatic")}</SelectItem><SelectItem value="low">{t("lessStrict")}</SelectItem></SelectContent>
        </Select>
        <Field.Description>{t("publicFigureModerationHint")}</Field.Description>
      </Field.Root>,
    );
  }

  return (
    <div className="options-section">
      <div className="section-label-row"><span className="section-label">{t("outputOptions")}</span><small>{t("supportedFieldsOnly")}</small></div>
      {basic.length ? <div className="options-grid">{basic}</div> : <p className="empty-options">{t("noOutputControls")}</p>}
      <Collapsible.Root open={advanced} onOpenChange={setAdvanced}>
          <Collapsible.Trigger className={`advanced-toggle ${advanced ? "open" : ""}`}>
            <span><SlidersHorizontal /> {t("advanced")}</span><ChevronDown />
          </Collapsible.Trigger>
          <Collapsible.Panel className="advanced-panel">
            <div className="advanced-content">
              {advancedFields.length ? <div className="options-grid">{advancedFields}</div> : null}
              <Field.Root className="provider-options-field" invalid={Boolean(providerError)}>
                <Field.Label>{t("providerOptions")}</Field.Label>
                <Textarea
                  aria-label={t("providerOptions")}
                  spellCheck={false}
                  value={providerJson}
                  placeholder='{"order":["provider-slug"]}'
                  onChange={(event) => onProviderJsonChange(event.target.value)}
                />
                <Field.Description>{t("providerOptionsHint")}</Field.Description>
                {providerError ? <Field.Error className="field-error" match>{providerError}</Field.Error> : null}
              </Field.Root>
            </div>
          </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}
