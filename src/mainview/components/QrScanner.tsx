import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { CameraOff } from "lucide-react";
import { Button, Modal } from "./ui";

/** Camera QR scanner. Permission is requested only when the scanner opens. */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
	const video = useRef<HTMLVideoElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stream: MediaStream | null = null;
		let frame = 0;
		let stopped = false;
		(async () => {
			try {
				if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is not available in this environment.");
				stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
				if (stopped) return;
				const v = video.current!;
				v.srcObject = stream;
				await v.play();
				const tick = () => {
					if (stopped) return;
					const c = canvas.current!;
					if (v.readyState === v.HAVE_ENOUGH_DATA) {
						c.width = v.videoWidth;
						c.height = v.videoHeight;
						const ctx = c.getContext("2d", { willReadFrequently: true })!;
						ctx.drawImage(v, 0, 0);
						const image = ctx.getImageData(0, 0, c.width, c.height);
						const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
						if (code?.data) {
							onResult(code.data);
							return;
						}
					}
					frame = requestAnimationFrame(tick);
				};
				frame = requestAnimationFrame(tick);
			} catch (e) {
				const name = (e as { name?: string }).name;
				setError(
					name === "NotAllowedError"
						? "Camera permission was denied. Allow camera access to scan, or paste the address instead."
						: name === "NotFoundError"
							? "No camera was found."
							: e instanceof Error ? e.message : "The camera could not be started.",
				);
			}
		})();
		return () => {
			stopped = true;
			cancelAnimationFrame(frame);
			stream?.getTracks().forEach((t) => t.stop());
		};
	}, [onResult]);

	return (
		<Modal open onClose={onClose} title="Scan a QR code" subtitle="Hold the code steady in front of the camera." width={480}
			footer={<Button onClick={onClose}>Cancel</Button>}>
			{error ? (
				<div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-text-2">
					<CameraOff className="size-6 text-muted" />
					{error}
				</div>
			) : (
				<div className="relative overflow-hidden rounded-xl bg-black">
					<video ref={video} className="aspect-[4/3] w-full object-cover" muted playsInline />
					<div className="pointer-events-none absolute inset-[18%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
				</div>
			)}
			<canvas ref={canvas} className="hidden" />
		</Modal>
	);
}
