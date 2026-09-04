import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n, type MessageKey } from "@/i18n";
import type {
  DirectorDirection,
  DirectorEasing,
  DirectorFidelity,
  DirectorMotion,
  DirectorMotionKind,
} from "@/director/types";
import { DIRECTOR_LIMITS } from "@/director/types";

const CAMERA_KINDS: DirectorMotionKind[] = [
  "static",
  "pan",
  "tilt",
  "truck",
  "dolly",
  "zoom",
  "orbit",
  "crane",
  "roll",
  "handheld",
  "translate",
];
const EASINGS: DirectorEasing[] = ["linear", "ease_in", "ease_out", "ease_in_out"];
const DIRECTIONS: DirectorDirection[] = ["left", "right", "up", "down", "in", "out"];

function directionsForKind(kind: DirectorMotionKind): DirectorDirection[] {
  if (kind === "pan" || kind === "truck" || kind === "orbit" || kind === "roll") return ["left", "right"];
  if (kind === "tilt" || kind === "crane") return ["up", "down"];
  if (kind === "dolly" || kind === "zoom" || kind === "depth_in" || kind === "depth_out") return ["in", "out"];
  if (kind === "static" || kind === "handheld") return [];
  return DIRECTIONS;
}

export type CameraMoveControlsProps = {
  motions: DirectorMotion[];
  selectedMotionId?: string;
  fidelityByControlId?: Record<string, DirectorFidelity>;
  disabled?: boolean;
  onAdd: (kind: DirectorMotionKind, direction?: DirectorDirection) => void;
  onChange: (motionId: string, patch: Partial<DirectorMotion>) => void;
  onDelete: (motionId: string) => void;
  onSelect: (motionId: string) => void;
};

const KIND_KEYS: Record<DirectorMotionKind, MessageKey> = {
  static: "directorStatic", pan: "directorPan", tilt: "directorTilt", truck: "directorTruck", dolly: "directorDolly",
  zoom: "directorZoom", orbit: "directorOrbit", crane: "directorCrane", roll: "directorRoll", handheld: "directorHandheld",
  translate: "directorTranslate", depth_in: "directorDepthIn", depth_out: "directorDepthOut",
};
const DIRECTION_KEYS: Record<DirectorDirection, MessageKey> = {
  left: "directorLeft", right: "directorRight", up: "directorUp", down: "directorDown", in: "directorIn", out: "directorOut",
};
const EASING_KEYS: Record<DirectorEasing, MessageKey> = {
  linear: "directorLinear", ease_in: "directorEaseIn", ease_out: "directorEaseOut", ease_in_out: "directorEaseInOut",
};
const FIDELITY_KEYS: Record<DirectorFidelity, MessageKey> = {
  native: "directorFidelityNative", keyframe: "directorFidelityKeyframe", visual: "directorFidelityVisual",
  prompt: "directorFidelityPrompt", unsupported: "directorFidelityUnsupported",
};

function DirectionIcon({ direction }: { direction?: DirectorDirection }) {
  if (direction === "left") return <ArrowLeft aria-hidden="true" />;
  if (direction === "right") return <ArrowRight aria-hidden="true" />;
  if (direction === "up" || direction === "in") return <ArrowUp aria-hidden="true" />;
  if (direction === "down" || direction === "out") return <ArrowDown aria-hidden="true" />;
  return null;
}

export function CameraMoveControls({
  motions,
  selectedMotionId,
  fidelityByControlId,
  disabled = false,
  onAdd,
  onChange,
  onDelete,
  onSelect,
}: CameraMoveControlsProps) {
  const { t } = useI18n();
  const maxMoves = DIRECTOR_LIMITS.maxCameraMovesPerShot;
  const [newKind, setNewKind] = useState<DirectorMotionKind>("dolly");
  const [newDirection, setNewDirection] = useState<DirectorDirection>("in");
  const atLimit = motions.length >= maxMoves;
  const availableDirections = directionsForKind(newKind);

  return (
    <section className="director-control-section director-camera-moves" aria-labelledby="director-camera-moves-title">
      <div className="director-section-heading">
        <div>
          <h3 id="director-camera-moves-title">{t("directorCameraMove")}</h3>
          <p>{t("directorMoveCount", { count: motions.length, max: maxMoves })}</p>
        </div>
      </div>

      <div className="director-add-move">
        <label>
          <span className="sr-only">{t("directorMoveKind")}</span>
          <select disabled={disabled || atLimit} value={newKind} onChange={(event) => {
            const kind = event.target.value as DirectorMotionKind;
            setNewKind(kind);
            const directions = directionsForKind(kind);
            if (directions.length && !directions.includes(newDirection)) setNewDirection(directions[0]);
          }}>
            {CAMERA_KINDS.map((kind) => <option key={kind} value={kind}>{t(KIND_KEYS[kind])}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">{t("directorDirection")}</span>
          <select
            disabled={disabled || atLimit || availableDirections.length === 0}
            value={newDirection}
            onChange={(event) => setNewDirection(event.target.value as DirectorDirection)}
          >
            {availableDirections.map((direction) => <option key={direction} value={direction}>{t(DIRECTION_KEYS[direction])}</option>)}
          </select>
        </label>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={disabled || atLimit}
          aria-label={t("directorAddMotion")}
          onClick={() => onAdd(newKind, availableDirections.length ? newDirection : undefined)}
        >
          <Plus />
        </Button>
      </div>
      {atLimit ? <p className="director-limit-note" role="status">{t("directorMoveLimit", { max: maxMoves })}</p> : null}

      <div className="director-motion-list">
        {motions.length === 0 ? <p className="director-empty-note">{t("directorNoCameraMove")}</p> : null}
        {motions.map((motion, index) => {
          const fidelity = fidelityByControlId?.[motion.id];
          return (
            <article
              key={motion.id}
              className="director-motion-card"
              data-selected={motion.id === selectedMotionId || undefined}
            >
              <button type="button" className="director-motion-card-heading" onClick={() => onSelect(motion.id)}>
                <span className="director-order-number">{index + 1}</span>
                <DirectionIcon direction={motion.direction} />
                <strong>{t(KIND_KEYS[motion.kind])}{motion.direction ? ` ${t(DIRECTION_KEYS[motion.direction])}` : ""}</strong>
                {fidelity ? <span className="director-fidelity" data-fidelity={fidelity}>{t(FIDELITY_KEYS[fidelity])}</span> : null}
              </button>
              <div className="director-motion-fields">
                <label className="director-field">
                  <span>{t("directorMoveKind")}</span>
                  <select
                    value={motion.kind}
                    disabled={disabled || Boolean(motion.path)}
                    onChange={(event) => {
                      const kind = event.target.value as DirectorMotionKind;
                      const directions = directionsForKind(kind);
                      onChange(motion.id, { kind, direction: directions[0] });
                    }}
                  >
                    {CAMERA_KINDS.map((kind) => <option key={kind} value={kind}>{t(KIND_KEYS[kind])}</option>)}
                  </select>
                </label>
                <label className="director-field">
                  <span>{t("directorDirection")}</span>
                  <select
                    value={motion.direction ?? ""}
                    disabled={disabled || Boolean(motion.path) || directionsForKind(motion.kind).length === 0}
                    onChange={(event) => onChange(motion.id, { direction: event.target.value as DirectorDirection })}
                  >
                    {!motion.direction ? <option value="">{t("none")}</option> : null}
                    {directionsForKind(motion.kind).map((direction) => <option key={direction} value={direction}>{t(DIRECTION_KEYS[direction])}</option>)}
                  </select>
                </label>
                <label className="director-field director-field-wide">
                  <span>{t("directorActionLabel")}</span>
                  <input
                    value={motion.actionLabel ?? ""}
                    placeholder={`${t(KIND_KEYS[motion.kind])} ${motion.direction ? t(DIRECTION_KEYS[motion.direction]) : ""}`.trim()}
                    disabled={disabled}
                    onChange={(event) => onChange(motion.id, { actionLabel: event.target.value })}
                  />
                </label>
                <label className="director-field">
                  <span>{t("directorIntensity")} <output>{Math.round(motion.intensity * 100)}%</output></span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={motion.intensity}
                    disabled={disabled}
                    onChange={(event) => onChange(motion.id, { intensity: Number(event.target.value) })}
                  />
                </label>
                <label className="director-field">
                  <span>{t("directorEasing")}</span>
                  <select
                    value={motion.easing}
                    disabled={disabled}
                    onChange={(event) => onChange(motion.id, { easing: event.target.value as DirectorEasing })}
                  >
                    {EASINGS.map((easing) => <option key={easing} value={easing}>{t(EASING_KEYS[easing])}</option>)}
                  </select>
                </label>
                <label className="director-field">
                  <span>{t("directorStartTime")} <output>{Math.round(motion.start * 100)}%</output></span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, motion.end - 0.05)}
                    step={0.05}
                    value={motion.start}
                    disabled={disabled}
                    onChange={(event) => onChange(motion.id, { start: Number(event.target.value) })}
                  />
                </label>
                <label className="director-field">
                  <span>{t("directorEndTime")} <output>{Math.round(motion.end * 100)}%</output></span>
                  <input
                    type="range"
                    min={Math.min(1, motion.start + 0.05)}
                    max={1}
                    step={0.05}
                    value={motion.end}
                    disabled={disabled}
                    onChange={(event) => onChange(motion.id, { end: Number(event.target.value) })}
                  />
                </label>
              </div>
              <Button
                type="button"
                className="director-motion-delete"
                size="icon-xs"
                variant="ghost"
                disabled={disabled}
                aria-label={`${t("directorDeleteMotion")}: ${motion.actionLabel || t(KIND_KEYS[motion.kind])}`}
                onClick={() => onDelete(motion.id)}
              >
                <Trash2 />
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
