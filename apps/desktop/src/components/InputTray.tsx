import { Field } from "@base-ui/react/field";
import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AssetPreview } from "@/components/AssetPreview";
import { clearAssetDragData, hasAssetDragData, readActiveAssetDragId, readAssetDragId, subscribeToAssetPointerDrop } from "@/assetDrag";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n, type MessageKey } from "@/i18n";
import { availableInputRoles, type InputCapabilities } from "@/inputCapabilities";
import { toast } from "@/components/ui/toast-manager";
import type { ReferenceRole } from "@/openrouter";
import {
  defaultReferencePurpose,
  referencePurposesForKind,
  type ReferencePurpose,
} from "@/prompting";
import type { DraftReference, SessionAsset } from "@/studio";
import { nextReferenceSlot } from "@/studio";

const ROLE_LABEL_KEYS: Record<ReferenceRole, MessageKey> = {
  reference: "referenceImage",
  first_frame: "firstFrame",
  last_frame: "lastFrame",
};

const PURPOSE_LABEL_KEYS: Record<ReferencePurpose, MessageKey> = {
  subject_identity: "purposeSubjectIdentity",
  product_identity: "purposeProductIdentity",
  character: "purposeCharacter",
  wardrobe: "purposeWardrobe",
  style: "purposeStyle",
  composition: "purposeComposition",
  pose: "purposePose",
  first_frame: "purposeFirstFrame",
  last_frame: "purposeLastFrame",
  motion: "purposeMotion",
  audio: "purposeAudio",
  edit_target: "purposeEditTarget",
  context: "purposeContext",
};

export function InputTray({
  references,
  assets,
  support,
  lockedPurposes,
  error,
  onChange,
  onImport,
  onPick,
}: {
  references: DraftReference[];
  assets: SessionAsset[];
  support: InputCapabilities;
  lockedPurposes?: Readonly<Record<number, ReferencePurpose>>;
  error?: string | null;
  onChange: (references: DraftReference[]) => void;
  onImport: (files: FileList | File[]) => Promise<SessionAsset[]>;
  onPick: () => Promise<SessionAsset[]>;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const options = support.roles;
  const limit = support.limit;
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const enabled = (["image", "video", "audio"] as const).some((kind) =>
    availableInputRoles(support, [], [], { id: "incoming", kind }).length > 0);
  const canAdd = (["image", "video", "audio"] as const).some((kind) =>
    availableInputRoles(support, references, assets, { id: "incoming", kind }).length > 0);

  const addAssets = useCallback((incoming: SessionAsset[]) => {
    const next = [...references];
    let rejected = 0;
    for (const asset of incoming) {
      if (next.some((reference) => reference.assetId === asset.id)) { rejected += 1; continue; }
      const role = availableInputRoles(support, next, [...assets, ...incoming], asset)[0];
      if (!role) { rejected += 1; continue; }
      next.push({
        assetId: asset.id,
        role,
        purpose: defaultReferencePurpose(asset.kind, role),
        slot: nextReferenceSlot(next),
      });
    }
    if (next.length !== references.length) onChange(next);
    if (rejected) toast.info(t("inputsNotAttached", { count: rejected }));
  }, [assets, onChange, references, support, t]);

  const addFiles = async (files: FileList | File[]) => addAssets(await onImport(files));
  const pickFiles = async () => addAssets(await onPick());

  useEffect(() => subscribeToAssetPointerDrop("inputs", (assetId) => {
    if (!canAdd) return;
    setDragging(false);
    const asset = assetMap.get(assetId);
    if (asset) addAssets([asset]);
  }), [addAssets, assetMap, canAdd]);

  return (
    <Field.Root
      className={`reference-section ${dragging ? "dragging" : ""}`}
      data-asset-drop-target="inputs"
      invalid={Boolean(error)}
      onDragEnter={(event) => {
        if (!canAdd) return;
        if (hasAssetDragData(event.dataTransfer) || Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (!canAdd) return;
        if (hasAssetDragData(event.dataTransfer) || Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onPointerEnter={(event) => {
        if (canAdd && (event.buttons & 1) && readActiveAssetDragId()) setDragging(true);
      }}
      onPointerMove={(event) => {
        if (canAdd && (event.buttons & 1) && readActiveAssetDragId()) setDragging(true);
      }}
      onPointerLeave={() => {
        if (readActiveAssetDragId()) setDragging(false);
      }}
      onPointerUp={(event) => {
        if (!canAdd) return;
        const assetId = readActiveAssetDragId();
        if (!assetId) return;
        event.preventDefault();
        setDragging(false);
        const asset = assetMap.get(assetId);
        if (asset) addAssets([asset]);
        clearAssetDragData();
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const assetId = readAssetDragId(event.dataTransfer);
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
      <div className="input-support-summary" aria-label={t("modelInputSupport")}>
        <span>{t("inputImageLimit", { count: support.referenceLimits.image })}</span>
        {support.referenceLimits.video > 0 ? <span>{t("inputVideoLimit", { count: support.referenceLimits.video })}</span> : null}
        {support.referenceLimits.audio > 0 ? <span>{t("inputAudioLimit", { count: support.referenceLimits.audio })}</span> : null}
        {support.mode === "video" ? <>
          <span>{t("inputFrameLimit", { frame: t("firstFrame"), count: options.image.includes("first_frame") ? 1 : 0 })}</span>
          <span>{t("inputFrameLimit", { frame: t("lastFrame"), count: options.image.includes("last_frame") ? 1 : 0 })}</span>
          {support.referenceLimit > 0 && options.image.some((role) => role !== "reference") && !support.mixFramesAndReferences
            ? <small>{t("inputStylesExclusive")}</small> : null}
          {!enabled && limit > 0 ? <small>{t("inputUploadUnverified")}</small> : null}
        </> : null}
        {support.minimum > 0 ? <small>{t("inputMinimum", { count: support.minimum })}</small> : null}
      </div>
      {dragging ? <div className="reference-drop-indicator"><Upload /> {t("releaseToAttach")}</div> : null}
      {!references.length ? (
        <Button type="button" variant="ghost" disabled={!canAdd} className={`dropzone ${dragging ? "dragging" : ""}`} onClick={() => void pickFiles()}>
          {enabled ? <Upload /> : <ImagePlus />}
          <span>{enabled ? t("dropAssets") : t("textOnlyInput")}</span>
          {enabled ? <small>{t("stableNumbersHint")}</small> : null}
        </Button>
      ) : (
        <div className="reference-list">
          {references.map((reference) => {
            const asset = assetMap.get(reference.assetId);
            if (!asset) return null;
            const validRoles = options[asset.kind] ?? [];
            const availableRoles = availableInputRoles(support, references, assets, asset, reference.slot);
            const roleItems = Object.fromEntries([...new Set([...validRoles, reference.role])].map((role) => [role,
              `${t(ROLE_LABEL_KEYS[role])}${validRoles.includes(role) ? "" : ` (${t("unsupported")})`}`,
            ]));
            const lockedPurpose = lockedPurposes?.[reference.slot];
            const validPurposes = lockedPurpose
              ? [lockedPurpose]
              : reference.role === "first_frame"
                ? ["first_frame" as const]
                : reference.role === "last_frame"
                  ? ["last_frame" as const]
                  : referencePurposesForKind(asset.kind);
            return (
              <div className="reference-row" key={reference.slot}>
                <AssetPreview asset={asset} />
                <span className="reference-order">@{reference.slot}</span>
                <span className="reference-name"><strong>{asset.name}</strong><small>{asset.mimeType}</small></span>
                <div className="reference-controls">
                  <Field.Root>
                      <Field.Label className="sr-only" nativeLabel={false} render={<div />}>{t("roleFor", { name: asset.name })}</Field.Label>
                      <Select items={roleItems} value={reference.role} onValueChange={(role) => {
                        if (!role) return;
                        const nextRole = role as ReferenceRole;
                        if (!availableRoles.includes(nextRole)) return;
                        onChange(references.map((item) => item.slot === reference.slot ? {
                          ...item,
                          role: nextRole,
                          purpose: nextRole === "reference" && !["first_frame", "last_frame"].includes(item.purpose)
                            ? item.purpose
                            : defaultReferencePurpose(asset.kind, nextRole),
                        } : item));
                      }}>
                        <SelectTrigger size="sm" className="role-select"><SelectValue /></SelectTrigger>
                        <SelectContent>{Object.entries(roleItems).map(([role, label]) => <SelectItem key={role} value={role} disabled={!availableRoles.includes(role as ReferenceRole)}>{label}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field.Root>
                  <Field.Root>
                    <Field.Label className="sr-only" nativeLabel={false} render={<div />}>{t("purposeFor", { name: asset.name })}</Field.Label>
                    <Select items={Object.fromEntries(validPurposes.map((purpose) => [purpose, t(PURPOSE_LABEL_KEYS[purpose])]))} value={reference.purpose} disabled={validPurposes.length === 1} onValueChange={(purpose) => {
                      if (!purpose) return;
                      onChange(references.map((item) => item.slot === reference.slot
                        ? { ...item, purpose: purpose as ReferencePurpose }
                        : item));
                    }}>
                      <SelectTrigger size="sm" className="role-select"><SelectValue /></SelectTrigger>
                      <SelectContent>{validPurposes.map((purpose) => <SelectItem key={purpose} value={purpose}>{t(PURPOSE_LABEL_KEYS[purpose])}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field.Root>
                </div>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={t("remove")} onClick={() => onChange(references.filter((item) => item.slot !== reference.slot))}><Trash2 /></Button>
              </div>
            );
          })}
          {references.length < limit ? <Button type="button" disabled={!canAdd} variant="outline" size="sm" className="add-reference" onClick={() => void pickFiles()}><ImagePlus /> {t("addInput")}</Button> : null}
        </div>
      )}
      {error ? <Field.Error className="field-error reference-error" role="alert" match>{error}</Field.Error> : null}
    </Field.Root>
  );
}
