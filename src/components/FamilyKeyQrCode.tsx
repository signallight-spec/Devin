import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

export function FamilyKeyQrCode({ familyKey }: { familyKey: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const url = new URL(window.location.href);
    url.hash = `family-key=${encodeURIComponent(familyKey)}`;
    setFailed(false);
    void QRCode.toCanvas(canvas, url.href, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240
    }).catch(() => setFailed(true));
  }, [familyKey]);

  if (failed) {
    return <p className="status-message error">QRコードを作成できませんでした。</p>;
  }

  return (
    <div className="family-key-qr">
      <canvas
        aria-label="娘端末で読み取る家族キーQRコード"
        ref={canvasRef}
        role="img"
      />
      <p>娘端末のカメラで読み取り、表示された画面で確認してください。</p>
    </div>
  );
}
