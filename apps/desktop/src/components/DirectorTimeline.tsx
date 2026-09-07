import { FIDELITY_KEYS } from "@/director/labels";
import { ArrowLeftRight, ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DIRECTOR_LIMITS, type DirectorActionOrder, type DirectorCapability, type DirectorEasing, type DirectorFidelity, type DirectorKeyframe, type DirectorKeyframeRole, type DirectorMotion } from "@/director/types";
import { useI18n, type MessageKey } from "@/i18n";

export type DirectorAssetOption = { id: string; name: string };

const EASINGS: DirectorEasing[] = ["linear", "ease_in", "ease_out", "ease_in_out"];
const EASING_KEYS: Record<DirectorEasing, MessageKey> = {
  linear: "directorLinear", ease_in: "directorEaseIn", ease_out: "directorEaseOut", ease_in_out: "directorEaseInOut",
};

const ROLE_KEYS: Record<DirectorKeyframeRole, MessageKey> = {
  first: "directorKeyframeFirst", middle: "directorKeyframeMiddle", last: "directorKeyframeLast", timestamped: "directorKeyframeTimestamped",
};

export type DirectorTimelineProps = {
  section?: "frames" | "motions";
  motions: DirectorMotion[];
  keyframes: DirectorKeyframe[];
  totalKeyframeCount?: number;
  showFirstAnchor?: boolean;
  showLastAnchor?: boolean;
  assets: DirectorAssetOption[];
  selectedMotionId?: string;
  capability?: DirectorCapability;
  fidelityByControlId?: Record<string, DirectorFidelity>;
  disabled?: boolean;
  onSelectMotion: (motionId: string) => void;
  onMotionChange: (motionId: string, patch: Partial<DirectorMotion>) => void;
  onReverseMotion: (motionId: string) => void;
  onDeleteMotion: (motionId: string) => void;
  onAddKeyframe: (role: DirectorKeyframeRole, assetId: string, time: number) => void;
  onKeyframeChange: (keyframeId: string, patch: Partial<DirectorKeyframe>) => void;
  onMoveKeyframe: (keyframeId: string, direction: -1 | 1) => void;
  onDeleteKeyframe: (keyframeId: string) => void;
};

export function DirectorTimeline({
  section = "frames", motions, keyframes, totalKeyframeCount = keyframes.length, showFirstAnchor = true, showLastAnchor = true, assets, selectedMotionId, capability, fidelityByControlId,
  disabled = false, onSelectMotion, onMotionChange, onReverseMotion, onDeleteMotion,
  onAddKeyframe, onKeyframeChange, onMoveKeyframe, onDeleteKeyframe,
}: DirectorTimelineProps) {
  const { t } = useI18n();
  const [newRole, setNewRole] = useState<"middle" | "timestamped">("middle");
  const [newAssetId, setNewAssetId] = useState("");
  const [newTime, setNewTime] = useState(0.5);
  const maximum = Math.min(DIRECTOR_LIMITS.maxKeyframes, Math.max(0, capability?.maxKeyframes ?? DIRECTOR_LIMITS.maxKeyframes));
  const atLimit = totalKeyframeCount >= maximum;
  const first = keyframes.find((keyframe) => keyframe.role === "first");
  const last = keyframes.find((keyframe) => keyframe.role === "last");
  const interior = keyframes.filter((keyframe) => keyframe.role === "middle" || keyframe.role === "timestamped");
  const objectMotions = motions.filter((motion) => motion.targetType === "subject");

  if (section === "motions") return (
    <section className="director-timeline director-object-timeline" aria-label={t("directorObjectActions")}>
      <h3>{t("directorObjectActions")}</h3>
      {objectMotions.length ? <div className="director-action-list">
        {objectMotions.map((motion) => <MotionRow key={motion.id} motion={motion} selected={motion.id === selectedMotionId} fidelity={fidelityByControlId?.[motion.id]} disabled={disabled} onSelect={onSelectMotion} onChange={onMotionChange} onReverse={onReverseMotion} onDelete={onDeleteMotion} />)}
      </div> : <p className="director-empty-note">{t("directorDrawPathForSubject")}</p>}
    </section>
  );

  return (
    <section className="director-timeline" aria-labelledby="director-keyframes-title">
      <header className="director-keyframe-header">
        <div><h2 id="director-keyframes-title">{t("directorKeyframes")}</h2></div>
        <span>{t("directorKeyframeCount", { count: totalKeyframeCount, max: maximum })}</span>
      </header>

      {showFirstAnchor || showLastAnchor ? <div className="director-keyframe-strip" data-single={showFirstAnchor !== showLastAnchor || undefined}>
        {showFirstAnchor ? <KeyframeAnchor role="first" keyframe={first} assets={assets} supported={capability?.supportsFirstFrame} fidelity={first ? fidelityByControlId?.[first.id] : undefined} disabled={disabled || (!first && atLimit)} onAdd={(assetId) => onAddKeyframe("first", assetId, 0)} onChange={onKeyframeChange} onDelete={onDeleteKeyframe} /> : null}
        {showFirstAnchor && showLastAnchor ? <span className="director-keyframe-connector" aria-hidden="true" /> : null}
        {showLastAnchor ? <KeyframeAnchor role="last" keyframe={last} assets={assets} supported={capability?.supportsLastFrame} fidelity={last ? fidelityByControlId?.[last.id] : undefined} disabled={disabled || (!last && atLimit)} onAdd={(assetId) => onAddKeyframe("last", assetId, 1)} onChange={onKeyframeChange} onDelete={onDeleteKeyframe} /> : null}
      </div> : null}

      <div className="director-keyframe-list" aria-label={t("directorInteriorKeyframes")}>
        {interior.map((keyframe, index) => (
          <article key={keyframe.id} className="director-keyframe-row">
            <span className="director-order-number">{index + 1}</span>
            <label className="director-field">
              <span>{t("role")}</span>
              <select value={keyframe.role} disabled={disabled} onChange={(event) => onKeyframeChange(keyframe.id, { role: event.target.value as "middle" | "timestamped" })}>
                <option value="middle">{t("directorKeyframeMiddle")}</option>
                <option value="timestamped">{t("directorKeyframeTimestamped")}</option>
              </select>
            </label>
            <label className="director-field">
              <span>{t("directorSourceFrame")}</span>
              <select value={keyframe.assetId} disabled={disabled} onChange={(event) => onKeyframeChange(keyframe.id, { assetId: event.target.value })}>
                {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
            </label>
            <label className="director-field director-keyframe-time">
              <span>{t("directorTimestamp")} <output>{Math.round(keyframe.time * 100)}%</output></span>
              <input type="range" min={0.01} max={0.99} step={0.01} value={keyframe.time} disabled={disabled} onChange={(event) => onKeyframeChange(keyframe.id, { time: Number(event.target.value) })} />
            </label>
            {fidelityByControlId?.[keyframe.id] ? <span className="director-fidelity" data-fidelity={fidelityByControlId[keyframe.id]}>{t(FIDELITY_KEYS[fidelityByControlId[keyframe.id]!])}</span> : null}
            <div className="director-keyframe-actions">
              <Button type="button" size="icon-xs" variant="ghost" disabled={disabled || index === 0} aria-label={t("directorMoveKeyframeEarlier")} onClick={() => onMoveKeyframe(keyframe.id, -1)}><ChevronUp /></Button>
              <Button type="button" size="icon-xs" variant="ghost" disabled={disabled || index === interior.length - 1} aria-label={t("directorMoveKeyframeLater")} onClick={() => onMoveKeyframe(keyframe.id, 1)}><ChevronDown /></Button>
              <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={t("directorRemoveKeyframe")} onClick={() => onDeleteKeyframe(keyframe.id)}><Trash2 /></Button>
            </div>
          </article>
        ))}
        {!interior.length ? <p className="director-empty-note">{t("directorNoInteriorKeyframes")}</p> : null}
      </div>

      <div className="director-add-keyframe">
        <label><span className="sr-only">{t("role")}</span><select value={newRole} disabled={disabled || atLimit} onChange={(event) => setNewRole(event.target.value as "middle" | "timestamped")}><option value="middle">{t("directorKeyframeMiddle")}</option><option value="timestamped">{t("directorKeyframeTimestamped")}</option></select></label>
        <label><span className="sr-only">{t("directorSourceFrame")}</span><select value={newAssetId} disabled={disabled || atLimit} onChange={(event) => setNewAssetId(event.target.value)}><option value="">{t("directorChooseKeyframeAsset")}</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
        <label className="director-add-keyframe-time"><span>{t("directorTimestamp")} <span aria-hidden="true">(%)</span></span><input type="number" min={1} max={99} step={1} value={Math.round(newTime * 100)} disabled={disabled || atLimit} onChange={(event) => setNewTime(Math.min(99, Math.max(1, Number(event.target.value) || 1)) / 100)} /></label>
        <Button type="button" size="sm" variant="outline" disabled={disabled || atLimit || !newAssetId} onClick={() => { onAddKeyframe(newRole, newAssetId, newTime); setNewAssetId(""); }}><Plus /> {t("directorAddKeyframe")}</Button>
      </div>
      {atLimit ? <p className="director-limit-note" role="status">{t("directorKeyframeLimit", { max: maximum })}</p> : null}
      {newRole === "timestamped" && capability?.supportsTimestampedKeyframes === false ? <p className="director-limit-note" role="status">{t("directorTimestampedUnsupported")}</p> : null}

    </section>
  );
}

function KeyframeAnchor({ role, keyframe, assets, supported, fidelity, disabled, onAdd, onChange, onDelete }: {
  role: "first" | "last"; keyframe?: DirectorKeyframe; assets: DirectorAssetOption[]; supported?: boolean; fidelity?: DirectorFidelity; disabled: boolean;
  onAdd: (assetId: string) => void; onChange: (keyframeId: string, patch: Partial<DirectorKeyframe>) => void; onDelete: (keyframeId: string) => void;
}) {
  const { t } = useI18n();
  const status = keyframe ? supported === false ? t("directorFidelityUnsupported") : t("directorLinked") : t("directorNotLinked");
  return <article className="director-keyframe" data-status={keyframe ? supported === false ? "unsupported" : "linked" : "not-linked"}>
    <span className="director-keyframe-copy"><strong>{t(ROLE_KEYS[role])}</strong><small>{status}</small></span>
    {fidelity ? <span className="director-fidelity" data-fidelity={fidelity}>{t(FIDELITY_KEYS[fidelity])}</span> : null}
    <label><span className="sr-only">{keyframe ? t("directorReplaceKeyframe") : t("directorAddKeyframe")}</span><select value={keyframe?.assetId ?? ""} disabled={disabled} onChange={(event) => { const assetId = event.target.value; if (!assetId && keyframe) onDelete(keyframe.id); else if (assetId && keyframe) onChange(keyframe.id, { assetId }); else if (assetId) onAdd(assetId); }}><option value="">{t("none")}</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
    {keyframe ? <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={t("directorRemoveKeyframe")} onClick={() => onDelete(keyframe.id)}><Trash2 /></Button> : null}
  </article>;
}

function MotionRow({ motion, selected, fidelity, disabled, onSelect, onChange, onReverse, onDelete }: {
  motion: DirectorMotion; selected: boolean; fidelity?: DirectorFidelity; disabled: boolean;
  onSelect: (id: string) => void; onChange: (id: string, patch: Partial<DirectorMotion>) => void; onReverse: (id: string) => void; onDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  const label = motion.actionLabel || motion.kind.replaceAll("_", " ");
  return <article className="director-action-row" data-selected={selected || undefined}>
    <button type="button" className="director-action-select" onClick={() => onSelect(motion.id)}><span className="director-order-number">{motion.order}</span><span><strong>{label}</strong><small>{t("directorObjectPath")}</small></span>{fidelity ? <span className="director-fidelity" data-fidelity={fidelity}>{t(FIDELITY_KEYS[fidelity])}</span> : null}</button>
    <label className="director-field director-action-label"><span>{t("directorLabel")}</span><input value={motion.actionLabel ?? ""} disabled={disabled} placeholder={t("directorActionLabelPlaceholder")} onChange={(event) => onChange(motion.id, { actionLabel: event.target.value })} /></label>
    <label className="director-field director-action-kind"><span>{t("directorMotionMeaning")}</span><select value={motion.kind} disabled={disabled} onChange={(event) => onChange(motion.id, { kind: event.target.value as DirectorMotion["kind"] })}><option value="translate">{t("directorTranslate")}</option><option value="depth_in">{t("directorDepthIn")}</option><option value="depth_out">{t("directorDepthOut")}</option></select></label>
    <label className="director-field director-action-order"><span>{t("directorOrder")}</span><select value={motion.order} disabled={disabled} onChange={(event) => onChange(motion.id, { order: Number(event.target.value) as DirectorActionOrder })}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
    <label className="director-field director-action-easing"><span>{t("directorEasing")}</span><select value={motion.easing} disabled={disabled} onChange={(event) => onChange(motion.id, { easing: event.target.value as DirectorEasing })}>{EASINGS.map((easing) => <option key={easing} value={easing}>{t(EASING_KEYS[easing])}</option>)}</select></label>
    <div className="director-action-time"><label><span>{t("directorStartTime")} (%)</span><input aria-label={`${label}: ${t("directorStartTime")}`} type="number" min={0} max={Math.max(0, Math.round(motion.end * 100) - 1)} step={1} value={Math.round(motion.start * 100)} disabled={disabled} onChange={(event) => onChange(motion.id, { start: Number(event.target.value) / 100 })} /></label><label><span>{t("directorEndTime")} (%)</span><input aria-label={`${label}: ${t("directorEndTime")}`} type="number" min={Math.min(100, Math.round(motion.start * 100) + 1)} max={100} step={1} value={Math.round(motion.end * 100)} disabled={disabled} onChange={(event) => onChange(motion.id, { end: Number(event.target.value) / 100 })} /></label></div>
    <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={`${t("directorReversePath")}: ${label}`} onClick={() => onReverse(motion.id)}><ArrowLeftRight /></Button><Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={`${t("directorDeleteMotion")}: ${label}`} onClick={() => onDelete(motion.id)}><Trash2 /></Button>
  </article>;
}
