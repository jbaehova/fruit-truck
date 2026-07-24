import { useEffect, useState } from "react";
import type { SessionAsset } from "@/studio";
import { resolveAssetSource } from "@/studio";

export function AssetPreview({
  asset,
  className,
  controls = false,
}: {
  asset: SessionAsset;
  className?: string;
  controls?: boolean;
}) {
  const [source, setSource] = useState(asset.externalUrl ?? "");

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void resolveAssetSource(asset).then((value) => {
      if (!active) {
        if (value.startsWith("blob:")) URL.revokeObjectURL(value);
        return;
      }
      objectUrl = value;
      setSource(value);
    });
    return () => {
      active = false;
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [asset]);

  if (!source) return <span className={`asset-missing ${className ?? ""}`} />;
  return asset.kind === "image"
    ? <img className={className} src={source} alt={asset.name} />
    : <video className={className} src={source} controls={controls} muted={!controls} playsInline preload="metadata" />;
}
