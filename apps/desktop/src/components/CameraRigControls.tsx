import { FIDELITY_KEYS } from "@/director/labels";
import type { CameraRig, DirectorFidelity, DirectorSubject } from "@/director/types";
import { useI18n, type MessageKey } from "@/i18n";

const SENSOR_PRESETS: CameraRig["sensorPreset"][] = ["neutral", "cinema", "film", "digital_crisp"];
const LENS_PRESETS: CameraRig["lensPreset"][] = ["neutral", "spherical", "anamorphic", "vintage", "macro"];
const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "21:9"];

export type CameraRigControlsProps = {
  rig: CameraRig;
  subjects: DirectorSubject[];
  fidelityByControlId?: Record<string, DirectorFidelity>;
  disabled?: boolean;
  onChange: (next: CameraRig) => void;
};

const SENSOR_KEYS: Record<CameraRig["sensorPreset"], MessageKey> = {
  neutral: "directorNeutral", cinema: "directorCinema", film: "directorFilm", digital_crisp: "directorDigitalCrisp",
};
const LENS_KEYS: Record<CameraRig["lensPreset"], MessageKey> = {
  neutral: "directorNeutral", spherical: "directorSpherical", anamorphic: "directorAnamorphic", vintage: "directorVintage", macro: "directorMacro",
};


function fidelityFor(
  fidelityByControlId: Record<string, DirectorFidelity> | undefined,
  rig: CameraRig,
  field: keyof CameraRig,
) {
  return fidelityByControlId?.[`${rig.id}.${field}`]
    ?? fidelityByControlId?.[`cameraRig.${field}`]
    ?? fidelityByControlId?.[rig.id];
}

function FidelityLabel({ value }: { value?: DirectorFidelity }) {
  const { t } = useI18n();
  if (!value) return null;
  return <span className="director-fidelity" data-fidelity={value}>{t(FIDELITY_KEYS[value])}</span>;
}

export function CameraRigControls({
  rig,
  subjects,
  fidelityByControlId,
  disabled = false,
  onChange,
}: CameraRigControlsProps) {
  const { t } = useI18n();
  const update = <Key extends keyof CameraRig>(key: Key, value: CameraRig[Key]) => {
    onChange({ ...rig, [key]: value });
  };

  return (
    <fieldset className="director-control-section director-camera-rig" disabled={disabled}>
      <legend>{t("directorCameraRig")}</legend>
      <p className="director-control-note">{t("directorOpticsDisclaimer")}</p>

      <label className="director-field">
        <span>{t("directorSensorLook")} <FidelityLabel value={fidelityFor(fidelityByControlId, rig, "sensorPreset")} /></span>
        <select value={rig.sensorPreset} onChange={(event) => update("sensorPreset", event.target.value as CameraRig["sensorPreset"])}>
          {SENSOR_PRESETS.map((preset) => <option key={preset} value={preset}>{t(SENSOR_KEYS[preset])}</option>)}
        </select>
      </label>

      <label className="director-field">
        <span>{t("directorLensCharacter")} <FidelityLabel value={fidelityFor(fidelityByControlId, rig, "lensPreset")} /></span>
        <select value={rig.lensPreset} onChange={(event) => update("lensPreset", event.target.value as CameraRig["lensPreset"])}>
          {LENS_PRESETS.map((preset) => <option key={preset} value={preset}>{t(LENS_KEYS[preset])}</option>)}
        </select>
      </label>

      <div className="director-field-pair">
        <label className="director-field">
          <span>{t("directorFocalLength")} <FidelityLabel value={fidelityFor(fidelityByControlId, rig, "focalLengthMm")} /></span>
          <span className="director-input-unit">
            <input
              type="number"
              min={12}
              max={300}
              step={1}
              value={rig.focalLengthMm ?? ""}
              placeholder="50"
              onChange={(event) => update("focalLengthMm", event.target.value ? Number(event.target.value) : undefined)}
            />
            <span aria-hidden="true">mm</span>
          </span>
        </label>
        <label className="director-field">
          <span>{t("directorAperture")} <FidelityLabel value={fidelityFor(fidelityByControlId, rig, "aperture")} /></span>
          <span className="director-input-unit">
            <span aria-hidden="true">f/</span>
            <input
              type="number"
              min={0.7}
              max={32}
              step={0.1}
              value={rig.aperture ?? ""}
              placeholder="2.8"
              onChange={(event) => update("aperture", event.target.value ? Number(event.target.value) : undefined)}
            />
          </span>
        </label>
      </div>

      <label className="director-field">
        <span>{t("directorFocusTarget")} <FidelityLabel value={fidelityFor(fidelityByControlId, rig, "focusSubjectId")} /></span>
        <select value={rig.focusSubjectId ?? ""} onChange={(event) => update("focusSubjectId", event.target.value || undefined)}>
          <option value="">{t("directorAutoFocus")}</option>
          {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.label}</option>)}
        </select>
      </label>

      <label className="director-field">
        <span>{t("directorAspectRatio")} <FidelityLabel value={fidelityFor(fidelityByControlId, rig, "aspectRatio")} /></span>
        <select value={rig.aspectRatio ?? ""} onChange={(event) => update("aspectRatio", event.target.value || undefined)}>
          <option value="">{t("directorModelDefault")}</option>
          {ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
      </label>
    </fieldset>
  );
}
