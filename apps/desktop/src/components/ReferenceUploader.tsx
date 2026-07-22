import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ReferenceAsset, ReferenceRole } from "@/openrouter";

const ROLE_LABELS: Record<ReferenceRole, string> = {
  reference: "Reference",
  first_frame: "First frame",
  last_frame: "Last frame",
};

type Props = {
  assets: ReferenceAsset[];
  roles: ReferenceRole[];
  limit?: number;
  onChange: (assets: ReferenceAsset[]) => void;
};

async function fileToAsset(file: File, role: ReferenceRole): Promise<ReferenceAsset> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: file.type,
    dataUrl,
    previewUrl: URL.createObjectURL(file),
    role,
  };
}

export function ReferenceUploader({ assets, roles, limit = 16, onChange }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const enabled = roles.length > 0;

  const addFiles = async (files: FileList | File[]) => {
    if (!enabled) return;
    const remaining = Math.max(0, limit - assets.length);
    const images = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, remaining);
    const next = await Promise.all(images.map((file) => fileToAsset(file, roles[0])));
    onChange([...assets, ...next]);
  };

  const remove = (id: string) => {
    const asset = assets.find((item) => item.id === id);
    if (asset?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(asset.previewUrl);
    onChange(assets.filter((item) => item.id !== id));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= assets.length) return;
    const next = [...assets];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="reference-section">
      <div className="section-label-row">
        <div>
          <span className="section-label">Reference images</span>
          <small>{enabled ? `${assets.length} / ${limit}` : "Not supported by this model"}</small>
        </div>
        {assets.length && enabled ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => assets.forEach((asset) => remove(asset.id))}>
            Clear
          </Button>
        ) : null}
      </div>
      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onChange={(event) => event.target.files && void addFiles(event.target.files)}
      />
      {!assets.length ? (
        <button
          type="button"
          disabled={!enabled}
          className={`dropzone ${dragging ? "dragging" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(event) => { event.preventDefault(); if (enabled) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void addFiles(event.dataTransfer.files);
          }}
        >
          {enabled ? <Upload /> : <ImagePlus />}
          <span>{enabled ? "Drop images here or choose files" : "Choose a model with image input"}</span>
          {enabled ? <small>PNG, JPEG, WebP or GIF · encoded locally</small> : null}
        </button>
      ) : (
        <div className="reference-list">
          {assets.map((asset, index) => (
            <div className="reference-row" key={asset.id}>
              <img src={asset.previewUrl} alt="" />
              <span className="reference-order">{String(index + 1).padStart(2, "0")}</span>
              <span className="reference-name"><strong>{asset.name}</strong><small>{asset.mediaType.replace("image/", "").toUpperCase()}</small></span>
              {roles.length > 1 ? (
                <Select value={asset.role} onValueChange={(role) => {
                  if (!role) return;
                  onChange(assets.map((item) => item.id === asset.id ? { ...item, role: role as ReferenceRole } : item));
                }}>
                  <SelectTrigger size="sm" className="role-select"><SelectValue /></SelectTrigger>
                  <SelectContent>{roles.map((role) => <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>)}</SelectContent>
                </Select>
              ) : <span className="role-static">Reference</span>}
              <div className="reference-actions">
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Move down" disabled={index === assets.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove" onClick={() => remove(asset.id)}><Trash2 /></Button>
              </div>
            </div>
          ))}
          {assets.length < limit ? (
            <Button type="button" variant="outline" size="sm" className="add-reference" onClick={() => input.current?.click()}>
              <ImagePlus /> Add image
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
