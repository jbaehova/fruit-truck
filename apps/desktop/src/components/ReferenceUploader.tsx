import { Field } from "@base-ui/react/field";
import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { AssetPreview } from "@/components/AssetPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n, type MessageKey } from "@/i18n";
import type { ReferenceRole } from "@/openrouter";
import type { DraftReference, SessionAsset } from "@/studio";
import { nextReferenceSlot } from "@/studio";

const ROLE_LABEL_KEYS: Record<ReferenceRole, MessageKey> = {
  reference: "referenceImage",
  first_frame: "firstFrame",
  last_frame: "lastFrame",
  video_reference: "sourceVideo",
};

export function ReferenceUploader({
  references,
  assets,
  roles,
  limit,
  onChange,
  onImport,
}: {
  references: DraftReference[];
  assets: SessionAsset[];
  roles: ReferenceRole[];
  limit: number;
  onChange: (references: DraftReference[]) => void;
  onImport: (files: FileList | File[]) => Promise<SessionAsset[]>;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const enabled = roles.length > 0 && limit > 0;
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));

  const roleFor = (asset: SessionAsset) =>
    asset.kind === "video"
      ? roles.includes("video_reference") ? "video_reference" : null
      : roles.includes("reference") ? "reference" : roles.find((role) => role !== "video_reference") ?? null;

  const addAssets = (incoming: SessionAsset[]) => {
    const next = [...references];
    for (const asset of incoming) {
      if (next.length >= limit || next.some((reference) => reference.assetId === asset.id)) continue;
      const role = roleFor(asset);
      if (!role) continue;
      next.push({ assetId: asset.id, role, slot: nextReferenceSlot(next) });
    }
    onChange(next);
  };

  const addFiles = async (files: FileList | File[]) => addAssets(await onImport(files));

  return (
    <div
      className="reference-section"
      onDragOver={(event) => {
        if (!enabled) return;
        if (event.dataTransfer.types.includes("application/x-open-gen-asset") || event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const assetId = event.dataTransfer.getData("application/x-open-gen-asset");
        if (assetId) {
          const asset = assetMap.get(assetId);
          if (asset) addAssets([asset]);
        } else if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
      }}
    >
      <div className="section-label-row">
        <div><span className="section-label">{t("numberedInputs")}</span><small>{enabled ? t("inputCountHint", { count: references.length, limit }) : t("inputsUnsupported")}</small></div>
        {references.length ? <Button type="button" variant="ghost" size="xs" onClick={() => onChange([])}>{t("clear")}</Button> : null}
      </div>
      <Input ref={input} className="sr-only" type="file" accept="image/*,video/*" multiple onChange={(event) => {
        if (event.target.files) void addFiles(event.target.files);
        event.target.value = "";
      }} />
      {!references.length ? (
        <Button type="button" variant="ghost" disabled={!enabled} className={`dropzone ${dragging ? "dragging" : ""}`} onClick={() => input.current?.click()}>
          {enabled ? <Upload /> : <ImagePlus />}
          <span>{enabled ? t("dropAssets") : t("textOnlyInput")}</span>
          {enabled ? <small>{t("stableNumbersHint")}</small> : null}
        </Button>
      ) : (
        <div className="reference-list">
          {references.map((reference) => {
            const asset = assetMap.get(reference.assetId);
            if (!asset) return null;
            const validRoles = roles.filter((role) => asset.kind === "video" ? role === "video_reference" : role !== "video_reference");
            return (
              <div className="reference-row" key={reference.assetId}>
                <AssetPreview asset={asset} />
                <span className="reference-order">#{reference.slot}</span>
                <span className="reference-name"><strong>{asset.name}</strong><small>{asset.mimeType}</small></span>
                {validRoles.length ? (
                  <Field.Root>
                    <Field.Label className="sr-only" nativeLabel={false} render={<div />}>{t("roleFor", { name: asset.name })}</Field.Label>
                    <Select value={reference.role} onValueChange={(role) => {
                      if (!role) return;
                      onChange(references.map((item) => item.assetId === asset.id ? { ...item, role: role as ReferenceRole } : item));
                    }}>
                      <SelectTrigger size="sm" className="role-select"><SelectValue /></SelectTrigger>
                      <SelectContent>{validRoles.map((role) => <SelectItem key={role} value={role}>{t(ROLE_LABEL_KEYS[role])}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field.Root>
                ) : <span className="reference-unsupported">{t("unsupported")}</span>}
                <Button type="button" variant="ghost" size="icon-xs" aria-label={t("remove")} onClick={() => onChange(references.filter((item) => item.assetId !== asset.id))}><Trash2 /></Button>
              </div>
            );
          })}
          {references.length < limit ? <Button type="button" variant="outline" size="sm" className="add-reference" onClick={() => input.current?.click()}><ImagePlus /> {t("addInput")}</Button> : null}
        </div>
      )}
    </div>
  );
}
