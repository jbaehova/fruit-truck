import { ChevronDown, ChevronUp, Copy, Pause, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DIRECTOR_LIMITS, type DirectorCapability, type DirectorFidelity, type DirectorMotion, type DirectorShot, type DirectorShotSpeed } from "@/director/types";
import { useI18n, type MessageKey } from "@/i18n";

const SPEED_KEYS: Record<DirectorShotSpeed, MessageKey> = {
  slow_motion: "directorSlowMotion",
  linear: "directorLinear",
  speed_up: "directorSpeedUp",
};

const FIDELITY_KEYS: Record<DirectorFidelity, MessageKey> = {
  native: "directorFidelityNative",
  keyframe: "directorFidelityKeyframe",
  visual: "directorFidelityVisual",
  prompt: "directorFidelityPrompt",
  unsupported: "directorFidelityUnsupported",
};

export type DirectorShotTimelineProps = {
  shots: DirectorShot[];
  motions: DirectorMotion[];
  activeShotId?: string;
  totalDurationSeconds: number;
  previewProgress: number;
  playing: boolean;
  capability?: DirectorCapability;
  fidelityByControlId?: Record<string, DirectorFidelity>;
  disabled?: boolean;
  onPreviewToggle: () => void;
  onPreviewProgressChange: (progress: number) => void;
  onSelectShot: (shotId: string) => void;
  onAddShot: () => void;
  onDuplicateShot: (shotId: string) => void;
  onDeleteShot: (shotId: string) => void;
  onMoveShot: (shotId: string, direction: -1 | 1) => void;
  onShotChange: (shotId: string, patch: Partial<DirectorShot>) => void;
  onToggleMotion: (shotId: string, motionId: string, assigned: boolean) => void;
};

export function DirectorShotTimeline({
  shots,
  motions,
  activeShotId,
  totalDurationSeconds,
  previewProgress,
  playing,
  capability,
  fidelityByControlId,
  disabled = false,
  onPreviewToggle,
  onPreviewProgressChange,
  onSelectShot,
  onAddShot,
  onDuplicateShot,
  onDeleteShot,
  onMoveShot,
  onShotChange,
  onToggleMotion,
}: DirectorShotTimelineProps) {
  const { t } = useI18n();
  const maxShots = DIRECTOR_LIMITS.maxShots;
  const orderedShots = [...shots].sort((left, right) => left.order - right.order);
  const activeShot = orderedShots.find((shot) => shot.id === activeShotId) ?? orderedShots[0];
  const activeIndex = activeShot ? orderedShots.findIndex((shot) => shot.id === activeShot.id) : -1;
  const assignedIds = new Set(activeShot?.motionIds ?? []);
  const assignedCameraCount = motions.filter((motion) => assignedIds.has(motion.id) && motion.targetType === "camera").length;
  const fidelity = activeShot ? fidelityByControlId?.[activeShot.id] : undefined;

  return (
    <section className="director-shot-timeline" aria-labelledby="director-shots-title">
      <header className="director-shot-timeline-header">
        <div>
          <p className="director-eyebrow">{t("directorLocalPreview")}</p>
          <h2 id="director-shots-title">{t("directorShots")}</h2>
        </div>
        <div className="director-preview-controls">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            disabled={disabled || !shots.length}
            aria-label={playing ? t("directorPausePreview") : t("directorPlayPreview")}
            onClick={onPreviewToggle}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <label>
            <span className="sr-only">{t("directorAnimaticPosition")}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={previewProgress}
              disabled={disabled || !shots.length}
              onChange={(event) => onPreviewProgressChange(Number(event.target.value))}
            />
          </label>
          <output aria-live="off">
            {(previewProgress * totalDurationSeconds).toFixed(1)}s / {totalDurationSeconds.toFixed(1)}s
          </output>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || shots.length >= maxShots}
          onClick={onAddShot}
        >
          <Plus /> {t("directorAddShot")}
        </Button>
      </header>

      <div className="director-global-timeline" role="group" aria-label={t("directorShotTimelineAria")}>
        <span className="director-global-playhead" style={{ left: `${previewProgress * 100}%` }} aria-hidden="true" />
        {orderedShots.map((shot, index) => {
          const width = totalDurationSeconds > 0 ? shot.durationSeconds / totalDurationSeconds * 100 : 100 / orderedShots.length;
          return (
            <button
              key={shot.id}
              type="button"
              className="director-shot-segment"
              data-active={shot.id === activeShot?.id || undefined}
              style={{ width: `${width}%` }}
              aria-pressed={shot.id === activeShot?.id}
              onClick={() => onSelectShot(shot.id)}
            >
              <strong>{t("directorShot", { index: index + 1 })}</strong>
              <small>{shot.durationSeconds.toFixed(1)}s</small>
            </button>
          );
        })}
      </div>

      {orderedShots.length >= maxShots ? (
        <p className="director-limit-note" role="status">{t("directorShotLimit", { max: maxShots })}</p>
      ) : null}
      {orderedShots.length > 1 && capability?.supportsMultiShot === false ? (
        <p className="director-limit-note" role="status">{t("directorMultiShotFallback")}</p>
      ) : null}

      {activeShot ? (
        <div className="director-shot-editor">
          <div className="director-shot-editor-heading">
            <span>
              <strong>{t("directorShot", { index: activeIndex + 1 })}</strong>
              {fidelity ? <span className="director-fidelity" data-fidelity={fidelity}>{t(FIDELITY_KEYS[fidelity])}</span> : null}
            </span>
            <div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={disabled || activeIndex <= 0}
                aria-label={t("directorMoveShotEarlier")}
                onClick={() => onMoveShot(activeShot.id, -1)}
              ><ChevronUp /></Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={disabled || activeIndex >= orderedShots.length - 1}
                aria-label={t("directorMoveShotLater")}
                onClick={() => onMoveShot(activeShot.id, 1)}
              ><ChevronDown /></Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={disabled || orderedShots.length >= maxShots}
                aria-label={t("directorDuplicateShot")}
                onClick={() => onDuplicateShot(activeShot.id)}
              ><Copy /></Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={disabled || orderedShots.length <= 1}
                aria-label={t("directorDeleteShot")}
                onClick={() => onDeleteShot(activeShot.id)}
              ><Trash2 /></Button>
            </div>
          </div>

          <label className="director-field director-shot-duration">
            <span>{t("directorShotDuration")}</span>
            <span className="director-input-unit">
              <input
                type="number"
                min={0.1}
                max={60}
                step={0.1}
                value={activeShot.durationSeconds}
                disabled={disabled}
                onChange={(event) => onShotChange(activeShot.id, { durationSeconds: Math.max(0.1, Number(event.target.value) || 0.1) })}
              />
              <span aria-hidden="true">s</span>
            </span>
          </label>
          <label className="director-field director-shot-speed">
            <span>{t("directorSpeed")}</span>
            <select
              value={activeShot.speed}
              disabled={disabled}
              onChange={(event) => onShotChange(activeShot.id, { speed: event.target.value as DirectorShotSpeed })}
            >
              {(Object.keys(SPEED_KEYS) as DirectorShotSpeed[]).map((speed) => (
                <option key={speed} value={speed}>{t(SPEED_KEYS[speed])}</option>
              ))}
            </select>
          </label>
          <label className="director-field director-shot-prompt">
            <span>{t("directorShotPrompt")}</span>
            <textarea
              value={activeShot.promptFragment}
              disabled={disabled}
              placeholder={t("directorShotPromptPlaceholder")}
              onChange={(event) => onShotChange(activeShot.id, { promptFragment: event.target.value })}
            />
          </label>

          <fieldset className="director-motion-stack">
            <legend>{t("directorMotionStack")}</legend>
            <p>{t("directorMotionStackHint")}</p>
            {motions.length ? (
              <div className="director-motion-stack-list">
                {motions.map((motion) => {
                  const assigned = assignedIds.has(motion.id);
                  const atCameraLimit = !assigned && motion.targetType === "camera" && assignedCameraCount >= 2;
                  return (
                    <label key={motion.id} data-target={motion.targetType}>
                      <input
                        type="checkbox"
                        checked={assigned}
                        disabled={disabled || atCameraLimit}
                        onChange={(event) => onToggleMotion(activeShot.id, motion.id, event.target.checked)}
                      />
                      <span>
                        <strong>{motion.actionLabel || (motion.targetType === "camera" ? t("directorCameraMove") : t("directorMotionPath"))}</strong>
                        <small>{motion.targetType === "camera" ? t("directorCamera") : t("directorObject")} {motion.order}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : <p className="director-empty-note">{t("directorNoMotionsForStack")}</p>}
          </fieldset>
        </div>
      ) : null}
    </section>
  );
}
