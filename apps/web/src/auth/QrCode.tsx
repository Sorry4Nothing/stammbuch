import { useEffect, useState } from "react";

/** Ruhezone um den Code in Modulen (Vorgabe der Norm: 4). */
const QUIET = 4;

/**
 * QR-Code als SVG, lokal im Browser erzeugt: der Inhalt (das 2FA-Geheimnis) verlässt das Gerät nie.
 * Immer schwarz auf weiss, auch im dunklen Theme, sonst lesen ihn Kameras schlecht. Die Bibliothek
 * lädt erst bei Bedarf; scheitert das, bleibt die Schlüsselanzeige der Seite als Alternative.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [matrix, setMatrix] = useState<{ size: number; path: string } | null>(null);

  useEffect(() => {
    let active = true;
    import("qrcode").then(
      ({ create }) => {
        const { size, data } = create(value, { errorCorrectionLevel: "M" }).modules;
        let path = "";
        for (let i = 0; i < data.length; i++) {
          if (data[i]) path += `M${(i % size) + QUIET} ${Math.floor(i / size) + QUIET}h1v1h-1z`;
        }
        if (active) setMatrix({ size, path });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [value]);

  if (!matrix) return null;
  const side = matrix.size + QUIET * 2;
  return (
    <svg
      className="auth__qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} fill="#fff" />
      <path d={matrix.path} fill="#000" />
    </svg>
  );
}
